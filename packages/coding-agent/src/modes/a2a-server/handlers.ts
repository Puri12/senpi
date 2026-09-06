import {
	invalidParamsError,
	methodNotFoundError,
	pushNotificationNotSupportedError,
	unsupportedOperationError,
	versionNotSupportedError,
} from "../../core/a2a/errors.ts";
import {
	type JsonRpcRequest,
	messageText,
	validateCancelTaskRequest,
	validateGetTaskRequest,
	validateListTasksRequest,
	validateSendMessageRequest,
	validateSubscribeToTaskRequest,
} from "../../core/a2a/json-rpc.ts";
import type { TaskStore } from "../../core/a2a/task-store.ts";
import type {
	A2aJsonRpcMethod,
	AgentCard,
	Message,
	SendMessageRequest,
	StreamResponse,
	TaskState,
} from "../../core/a2a/types.ts";
import type { A2aSessionRegistry } from "./session-registry.ts";
import { A2aTaskRunner } from "./task-runner.ts";

export type SseSink = {
	write(event: StreamResponse): void;
	close(): void;
};

export type A2aRespond = {
	json(result: unknown): void;
	stream(): SseSink;
};

export type A2aRequestHandler = {
	handle(request: JsonRpcRequest, respond: A2aRespond, versionHeader?: string): Promise<void>;
	readonly runner: A2aTaskRunner;
};

function assertNever(value: never): never {
	throw new Error(`Unhandled A2A method: ${JSON.stringify(value)}`);
}

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
	"TASK_STATE_COMPLETED",
	"TASK_STATE_FAILED",
	"TASK_STATE_CANCELED",
	"TASK_STATE_REJECTED",
]);

function isTerminal(state: TaskState): boolean {
	return TERMINAL_STATES.has(state);
}

function isKnownMethod(method: string): method is A2aJsonRpcMethod {
	switch (method) {
		case "SendMessage":
		case "SendStreamingMessage":
		case "GetTask":
		case "ListTasks":
		case "CancelTask":
		case "SubscribeToTask":
		case "CreateTaskPushNotificationConfig":
		case "GetTaskPushNotificationConfig":
		case "ListTaskPushNotificationConfigs":
		case "DeleteTaskPushNotificationConfig":
		case "GetExtendedAgentCard":
			return true;
		default:
			return false;
	}
}

export function isSupportedA2aVersion(value: string | undefined): boolean {
	if (value === undefined || value === "") {
		return true;
	}
	return value === "1.0" || /^1\.0\.\d+$/.test(value);
}

export function createA2aRequestHandler(options: {
	readonly registry: A2aSessionRegistry;
	readonly store: TaskStore;
	readonly card: AgentCard;
	readonly versionCheck?: boolean;
	readonly runner?: A2aTaskRunner;
}): A2aRequestHandler {
	const runner = options.runner ?? new A2aTaskRunner();
	const subscribers = new Map<string, Set<SseSink>>();
	const emit = (taskId: string, event: StreamResponse): void => {
		const sinks = subscribers.get(taskId);
		if (sinks === undefined) {
			return;
		}
		for (const sink of sinks) {
			sink.write(event);
		}
		if ("statusUpdate" in event && isTerminal(event.statusUpdate.status.state)) {
			for (const sink of sinks) {
				sink.close();
			}
			subscribers.delete(taskId);
		}
	};
	const attach = (taskId: string, sink: SseSink): void => {
		const set = subscribers.get(taskId) ?? new Set<SseSink>();
		set.add(sink);
		subscribers.set(taskId, set);
	};

	const run = async (request: SendMessageRequest, streaming: boolean, respond: A2aRespond): Promise<void> => {
		const contextId = resolveContextId(request.message, options.store, options.registry);
		const inbound: Message = { ...request.message, contextId };
		const task = options.store.create(contextId, inbound);
		const historyLength = request.configuration?.historyLength;
		const work = () =>
			options.registry.enqueue(contextId, async ({ session }) => {
				await runner.runTask({
					session,
					store: options.store,
					taskId: task.id,
					contextId,
					text: messageText(inbound),
					onEvent: (event) => emit(task.id, event),
				});
			});
		if (streaming) {
			const sink = respond.stream();
			attach(task.id, sink);
			sink.write({ task: options.store.snapshot(task.id, historyLength) });
			await work();
			return;
		}
		if (request.configuration?.returnImmediately === true) {
			respond.json({ task: options.store.snapshot(task.id, historyLength) });
			void work();
			return;
		}
		await work();
		respond.json({ task: options.store.snapshot(task.id, historyLength) });
	};

	return {
		runner,
		async handle(request, respond, versionHeader) {
			if (options.versionCheck !== false && !isSupportedA2aVersion(versionHeader)) {
				throw versionNotSupportedError(versionHeader ?? "", "1.0");
			}
			const method = request.method;
			if (!isKnownMethod(method)) {
				throw methodNotFoundError(method);
			}
			switch (method) {
				case "SendMessage":
					await run(validateSendMessageRequest(request.params), false, respond);
					return;
				case "SendStreamingMessage":
					await run(validateSendMessageRequest(request.params), true, respond);
					return;
				case "GetTask": {
					const params = validateGetTaskRequest(request.params);
					respond.json(options.store.snapshot(params.id, params.historyLength));
					return;
				}
				case "ListTasks":
					respond.json(options.store.list(validateListTasksRequest(request.params ?? {})));
					return;
				case "CancelTask": {
					const params = validateCancelTaskRequest(request.params);
					const updated = await runner.cancelTask(options.store, params.id);
					emit(params.id, {
						statusUpdate: {
							taskId: params.id,
							contextId: updated.contextId ?? "",
							status: updated.status,
						},
					});
					respond.json(updated);
					return;
				}
				case "SubscribeToTask": {
					const params = validateSubscribeToTaskRequest(request.params);
					const snapshot = options.store.snapshot(params.id);
					if (isTerminal(snapshot.status.state)) {
						throw unsupportedOperationError("task is in a terminal state");
					}
					const sink = respond.stream();
					attach(params.id, sink);
					sink.write({ task: snapshot });
					return;
				}
				case "GetExtendedAgentCard":
					throw unsupportedOperationError("extended agent card is not configured");
				case "CreateTaskPushNotificationConfig":
				case "GetTaskPushNotificationConfig":
				case "ListTaskPushNotificationConfigs":
				case "DeleteTaskPushNotificationConfig":
					throw pushNotificationNotSupportedError();
				default:
					return assertNever(method);
			}
		},
	};
}

function resolveContextId(message: Message, store: TaskStore, registry: A2aSessionRegistry): string {
	if (message.taskId === undefined) {
		return message.contextId ?? registry.newContextId();
	}
	const task = store.get(message.taskId);
	if (message.contextId !== undefined && task.contextId !== undefined && message.contextId !== task.contextId) {
		throw invalidParamsError("message.contextId does not match task context");
	}
	if (isTerminal(task.status.state)) {
		throw unsupportedOperationError("task is in a terminal state");
	}
	return message.contextId ?? task.contextId ?? registry.newContextId();
}

import { randomUUID } from "node:crypto";
import { taskNotCancelableError } from "../../core/a2a/errors.ts";
import { textPart } from "../../core/a2a/json-rpc.ts";
import type { TaskStore } from "../../core/a2a/task-store.ts";
import type { Message, Metadata, StreamResponse, Task, TaskState } from "../../core/a2a/types.ts";
import { isTerminalTaskState } from "../../core/a2a/types.ts";
import type { AgentSession, AgentSessionEvent, SessionStats } from "../../core/agent-session.ts";

export type RunTaskInput = {
	readonly session: AgentSession;
	readonly store: TaskStore;
	readonly taskId: string;
	readonly contextId: string;
	readonly text: string;
	readonly onEvent: (event: StreamResponse) => void;
	/** omo-remote/v1: attach this turn's token/cost delta to the terminal status update. */
	readonly reportUsage?: boolean;
};

/** Everything the terminal status update needs, so `finish` stays a three-argument call. */
type TurnOutcome = {
	readonly state: TaskState;
	readonly statusMessage: Message | undefined;
	readonly text: string;
	readonly producedText: boolean;
	readonly artifactId: string;
};

type RunningTask = {
	readonly session: AgentSession;
	canceled: boolean;
};

export class A2aTaskRunner {
	private readonly running = new Map<string, RunningTask>();

	async runTask(input: RunTaskInput): Promise<void> {
		const record: RunningTask = { session: input.session, canceled: false };
		this.running.set(input.taskId, record);
		try {
			await executeTurn(input, record);
		} finally {
			this.running.delete(input.taskId);
		}
	}

	async cancelTask(store: TaskStore, taskId: string): Promise<Task> {
		const task = store.get(taskId);
		if (isTerminalTaskState(task.status.state)) {
			throw taskNotCancelableError(taskId);
		}
		const record = this.running.get(taskId);
		if (record === undefined) {
			store.setState(taskId, "TASK_STATE_CANCELED");
			return store.snapshot(taskId);
		}
		record.canceled = true;
		await record.session.abort();
		return store.snapshot(taskId);
	}
}

async function executeTurn(input: RunTaskInput, record: RunningTask): Promise<void> {
	if (record.canceled || isTerminalTaskState(input.store.get(input.taskId).status.state)) {
		if (!isTerminalTaskState(input.store.get(input.taskId).status.state)) {
			const canceled: TurnOutcome = {
				state: "TASK_STATE_CANCELED",
				statusMessage: undefined,
				text: "",
				producedText: false,
				artifactId: randomUUID(),
			};
			finish(input, canceled, undefined);
		}
		return;
	}
	const baseline = input.reportUsage === true ? input.session.getSessionStats() : undefined;

	let terminal: TaskState | undefined;
	let statusMessage: Message | undefined;
	let firstChunk = true;
	let producedText = false;
	const chunks: string[] = [];
	const artifactId = randomUUID();
	let finished = false;

	input.store.setState(input.taskId, "TASK_STATE_WORKING");
	input.onEvent({
		statusUpdate: {
			taskId: input.taskId,
			contextId: input.contextId,
			status: input.store.get(input.taskId).status,
		},
	});

	const unsubscribe = input.session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_update") {
			const assistant = event.assistantMessageEvent;
			if (assistant.type === "text_delta") {
				producedText = true;
				chunks.push(assistant.delta);
				const append = !firstChunk;
				firstChunk = false;
				input.store.appendArtifactChunk(input.taskId, {
					artifactId,
					name: "response",
					part: textPart(assistant.delta),
					append,
					lastChunk: false,
				});
				input.onEvent({
					artifactUpdate: {
						taskId: input.taskId,
						contextId: input.contextId,
						artifact: { artifactId, name: "response", parts: [textPart(assistant.delta)] },
						append,
						lastChunk: false,
					},
				});
				return;
			}
			if (assistant.type === "error") {
				if (assistant.reason === "aborted") {
					terminal = "TASK_STATE_CANCELED";
					return;
				}
				terminal = "TASK_STATE_FAILED";
				statusMessage = agentMessage(input, assistant.error.errorMessage ?? "error");
			}
			return;
		}
		if (event.type === "agent_end" && event.willRetry === false && !finished) {
			finished = true;
			finish(
				input,
				{
					state: resolveState(record, terminal),
					statusMessage,
					text: chunks.join(""),
					producedText,
					artifactId,
				},
				usageMetadata(input, baseline),
			);
		}
	});

	try {
		await input.session.prompt(input.text, { source: "rpc" });
	} catch (error: unknown) {
		const detail = error instanceof Error ? error.message : String(error);
		terminal = "TASK_STATE_FAILED";
		statusMessage = agentMessage(input, detail);
	} finally {
		unsubscribe();
		if (!finished) {
			finished = true;
			finish(
				input,
				{
					state: resolveState(record, terminal),
					statusMessage,
					text: chunks.join(""),
					producedText,
					artifactId,
				},
				usageMetadata(input, baseline),
			);
		}
	}
}

/** omo-remote/v1 `metadata.omo.usage`: this turn's share of the session totals. */
function usageMetadata(input: RunTaskInput, baseline: SessionStats | undefined): Metadata | undefined {
	if (baseline === undefined) {
		return undefined;
	}
	const after = input.session.getSessionStats();
	const model = input.session.model;
	return {
		omo: {
			usage: {
				input: after.tokens.input - baseline.tokens.input,
				output: after.tokens.output - baseline.tokens.output,
				cacheRead: after.tokens.cacheRead - baseline.tokens.cacheRead,
				cacheWrite: after.tokens.cacheWrite - baseline.tokens.cacheWrite,
				cost: after.cost - baseline.cost,
				...(model === undefined ? {} : { model: model.id }),
			},
		},
	};
}

function resolveState(record: RunningTask, terminal: TaskState | undefined): TaskState {
	if (record.canceled || terminal === "TASK_STATE_CANCELED") {
		return "TASK_STATE_CANCELED";
	}
	return terminal ?? "TASK_STATE_COMPLETED";
}

function agentMessage(input: RunTaskInput, text: string): Message {
	return {
		messageId: randomUUID(),
		role: "ROLE_AGENT",
		parts: [textPart(text)],
		taskId: input.taskId,
		contextId: input.contextId,
	};
}

function finish(input: RunTaskInput, outcome: TurnOutcome, metadata: Metadata | undefined): void {
	if (outcome.producedText) {
		input.onEvent({
			artifactUpdate: {
				taskId: input.taskId,
				contextId: input.contextId,
				artifact: { artifactId: outcome.artifactId, name: "response", parts: [] },
				lastChunk: true,
			},
		});
	}
	input.store.appendHistory(input.taskId, agentMessage(input, outcome.text));
	input.store.setState(input.taskId, outcome.state, outcome.statusMessage);
	input.onEvent({
		statusUpdate: {
			taskId: input.taskId,
			contextId: input.contextId,
			status: input.store.get(input.taskId).status,
			...(metadata === undefined ? {} : { metadata }),
		},
	});
}

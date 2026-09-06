import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { A2aClient } from "../../../a2a/client.ts";
import { A2aError } from "../../../a2a/errors.ts";
import { messageText, partText, textPart } from "../../../a2a/json-rpc.ts";
import { AGENT_CARD_PATH, type SendMessageResponse, type Task } from "../../../a2a/types.ts";
import { defineTool } from "../../types.ts";
import type { A2aResolvedAgent } from "./config.ts";

const Params = Type.Object({
	message: Type.String({ description: "Message to send to the remote A2A agent." }),
	contextId: Type.Optional(Type.String({ description: "Continue an earlier conversation." })),
	taskId: Type.Optional(Type.String({ description: "Continue a specific task." })),
	returnImmediately: Type.Optional(
		Type.Boolean({ description: "Return without waiting for the task to complete. Defaults to false." }),
	),
});

export type A2aToolDetails =
	| {
			readonly agent: string;
			readonly taskId: string;
			readonly state: string;
			readonly artifactCount: number;
			readonly contextId?: string;
	  }
	| {
			readonly agent: string;
			readonly state: "message";
			readonly contextId?: string;
	  }
	| {
			readonly agent: string;
			readonly errorCode: number;
	  };

export type A2aAgentToolDeps = {
	readonly fetch?: typeof fetch;
};

export function resolveAgentCardUrl(url: string): string {
	return url.endsWith(AGENT_CARD_PATH) ? url : new URL(AGENT_CARD_PATH, url).href;
}

export function a2aToolName(name: string): string {
	return `a2a_${name.replaceAll("-", "_")}`;
}

export function createA2aAgentTool(name: string, config: A2aResolvedAgent, deps: A2aAgentToolDeps = {}) {
	const description = config.description ?? `Send a message to the remote A2A agent '${name}' and return its reply.`;
	let client: A2aClient | undefined;
	const resolveClient = async (): Promise<A2aClient> => {
		if (client !== undefined) return client;
		client = await A2aClient.fromCardUrl(resolveAgentCardUrl(config.url), {
			headers: config.headers,
			...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
			...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
		});
		return client;
	};
	return defineTool<typeof Params, A2aToolDetails>({
		name: a2aToolName(name),
		label: `A2A: ${name}`,
		description,
		parameters: Params,
		async execute(_toolCallId, params, signal) {
			try {
				const resolved = await resolveClient();
				const result = await send(resolved, params, signal);
				const reply = formatSendResult(result, name);
				return {
					content: [{ type: "text" as const, text: reply.text }],
					details: reply.details,
				};
			} catch (error) {
				if (error instanceof A2aError) {
					const failed = {
						content: [{ type: "text" as const, text: `A2A error ${error.code}: ${error.message}` }],
						details: { agent: name, errorCode: error.code },
						isError: true,
					};
					return failed;
				}
				throw error;
			}
		},
	});
}

async function send(
	client: A2aClient,
	params: {
		readonly message: string;
		readonly contextId?: string;
		readonly taskId?: string;
		readonly returnImmediately?: boolean;
	},
	signal: AbortSignal | undefined,
): Promise<SendMessageResponse> {
	const request = {
		message: {
			messageId: randomUUID(),
			role: "ROLE_USER" as const,
			parts: [textPart(params.message)],
			...(params.contextId !== undefined ? { contextId: params.contextId } : {}),
			...(params.taskId !== undefined ? { taskId: params.taskId } : {}),
		},
		configuration: { returnImmediately: params.returnImmediately ?? false },
	};
	return client.sendMessage(request, signal === undefined ? {} : { signal });
}

function formatSendResult(result: SendMessageResponse, name: string): { text: string; details: A2aToolDetails } {
	if ("task" in result) {
		const task = result.task;
		return {
			text: taskContentText(task),
			details: {
				agent: name,
				taskId: task.id,
				state: task.status.state,
				artifactCount: task.artifacts?.length ?? 0,
				...(task.contextId !== undefined ? { contextId: task.contextId } : {}),
			},
		};
	}
	if ("message" in result) {
		const message = result.message;
		return {
			text: messageText(message),
			details: {
				agent: name,
				state: "message",
				...(message.contextId !== undefined ? { contextId: message.contextId } : {}),
			},
		};
	}
	const unreachable: never = result;
	throw new Error(`unexpected SendMessage response: ${JSON.stringify(unreachable)}`);
}

function taskContentText(task: Task): string {
	const artifacts = task.artifacts ?? [];
	const texts = artifacts.flatMap((artifact) =>
		artifact.parts.map(partText).filter((text): text is string => text !== undefined && text.length > 0),
	);
	if (texts.length > 0) return texts.join("\n");
	const statusMessage = task.status.message;
	if (statusMessage !== undefined) {
		const text = messageText(statusMessage);
		if (text.length > 0) return text;
	}
	return `(task ${task.id} is ${task.status.state})`;
}

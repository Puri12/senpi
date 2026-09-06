import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { A2aClient } from "../../src/core/a2a/client.ts";
import { A2A_ERROR_CODES, A2aError, taskNotFoundError, toJsonRpcError } from "../../src/core/a2a/errors.ts";
import { parseJsonRpcRequest, textPart, validateSendMessageRequest } from "../../src/core/a2a/json-rpc.ts";
import { formatSseEvent, parseSseStream } from "../../src/core/a2a/sse.ts";
import { TaskStore } from "../../src/core/a2a/task-store.ts";
import {
	A2A_JSON_RPC_METHODS,
	AGENT_CARD_PATH,
	isTerminalTaskState,
	type Message,
	type SendMessageRequest,
	type StreamResponse,
} from "../../src/core/a2a/types.ts";

const SPEC_SEND_MESSAGE_PARAMS = {
	message: { role: "ROLE_USER", parts: [{ text: "What is the weather today?" }], messageId: "msg-uuid" },
} as const;

const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map(closeServer));
});

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function userMessage(messageId: string, text: string): Message {
	return { messageId, role: "ROLE_USER", parts: [{ text }] };
}

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

async function collect<T>(source: AsyncGenerator<T>): Promise<T[]> {
	const items: T[] = [];
	for await (const item of source) items.push(item);
	return items;
}

function expectA2aError(run: () => unknown): A2aError {
	try {
		run();
	} catch (error) {
		if (error instanceof A2aError) return error;
		throw error;
	}
	throw new Error("Expected an A2aError to be thrown");
}

type ReceivedRequest = { readonly headers: IncomingMessage["headers"]; readonly body: string };

type Fixture = { readonly baseUrl: string; readonly received: ReceivedRequest[] };

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}

function agentCard(baseUrl: string): unknown {
	return {
		name: "Fixture Agent",
		description: "A2A fixture agent",
		version: "1.0.0",
		supportedInterfaces: [
			{ url: `${baseUrl}/a2a/grpc`, protocolBinding: "GRPC", protocolVersion: "1.0" },
			{ url: `${baseUrl}/a2a/v1`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
		],
		capabilities: { streaming: true },
		defaultInputModes: ["text/plain"],
		defaultOutputModes: ["text/plain"],
		skills: [{ id: "chat", name: "Chat", description: "Chat skill", tags: ["chat"] }],
	};
}

function completedTask(): unknown {
	return {
		id: "task-uuid",
		contextId: "context-uuid",
		status: { state: "TASK_STATE_COMPLETED", timestamp: "2026-01-01T00:00:00.000Z" },
		artifacts: [{ artifactId: "artifact-uuid", name: "Weather", parts: [{ text: "Sunny" }] }],
	};
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
	const body = JSON.stringify(payload);
	response.writeHead(status, { "content-type": "application/json" });
	response.end(body);
}

function sendStream(response: ServerResponse, id: unknown): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	const events: unknown[] = [
		{ task: { id: "task-uuid", contextId: "context-uuid", status: { state: "TASK_STATE_WORKING" } } },
		{
			artifactUpdate: {
				taskId: "task-uuid",
				contextId: "context-uuid",
				artifact: { artifactId: "artifact-uuid", parts: [{ text: "Sunny" }] },
				lastChunk: true,
			},
		},
		{ statusUpdate: { taskId: "task-uuid", contextId: "context-uuid", status: { state: "TASK_STATE_COMPLETED" } } },
	];
	for (const result of events) response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`);
	response.end();
}

async function startFixture(): Promise<Fixture> {
	const received: ReceivedRequest[] = [];
	let baseUrl = "";
	const server = createServer((request, response) => {
		void (async () => {
			const body = await readBody(request);
			received.push({ headers: request.headers, body });
			if (request.method === "GET" && request.url === AGENT_CARD_PATH) {
				sendJson(response, 200, agentCard(baseUrl));
				return;
			}
			if (request.method !== "POST" || request.url !== "/a2a/v1") {
				sendJson(response, 404, { error: "not found" });
				return;
			}
			const rpc: { id?: unknown; method?: unknown } = JSON.parse(body);
			switch (rpc.method) {
				case "SendMessage":
					sendJson(response, 200, { jsonrpc: "2.0", id: rpc.id, result: { task: completedTask() } });
					return;
				case "SendStreamingMessage":
					sendStream(response, rpc.id);
					return;
				case "GetTask":
					sendJson(response, 404, {
						jsonrpc: "2.0",
						id: rpc.id,
						error: { code: -32001, message: "Task not found" },
					});
					return;
				default:
					sendJson(response, 200, {
						jsonrpc: "2.0",
						id: rpc.id,
						error: { code: -32601, message: "Method not found" },
					});
			}
		})();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	servers.push(server);
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("Expected a TCP address");
	baseUrl = `http://127.0.0.1:${address.port}`;
	return { baseUrl, received };
}

describe("A2A JSON-RPC envelope", () => {
	it("rejects malformed JSON with the JSONParseError code", () => {
		const error = expectA2aError(() => parseJsonRpcRequest("{not json"));
		expect(error.code).toBe(-32700);
		expect(error.message).toBe("Invalid JSON payload");
	});

	it("rejects a non-2.0 envelope with the InvalidRequestError code", () => {
		const error = expectA2aError(() =>
			parseJsonRpcRequest(JSON.stringify({ jsonrpc: "1.0", id: 1, method: "GetTask" })),
		);
		expect(error.code).toBe(-32600);
	});

	it("parses a notification without an id", () => {
		const request = parseJsonRpcRequest(JSON.stringify({ jsonrpc: "2.0", method: "SendMessage", params: {} }));
		expect(request.method).toBe("SendMessage");
		expect(request.id).toBeUndefined();
	});

	it("exposes the eleven PascalCase A2A methods", () => {
		expect(A2A_JSON_RPC_METHODS).toEqual([
			"SendMessage",
			"SendStreamingMessage",
			"GetTask",
			"ListTasks",
			"CancelTask",
			"SubscribeToTask",
			"CreateTaskPushNotificationConfig",
			"GetTaskPushNotificationConfig",
			"ListTaskPushNotificationConfigs",
			"DeleteTaskPushNotificationConfig",
			"GetExtendedAgentCard",
		]);
	});
});

describe("SendMessageRequest validation", () => {
	it("accepts the spec sample request", () => {
		const request: SendMessageRequest = validateSendMessageRequest(SPEC_SEND_MESSAGE_PARAMS);
		expect(request.message.messageId).toBe("msg-uuid");
		expect(request.message.role).toBe("ROLE_USER");
		expect(request.message.parts).toEqual([{ text: "What is the weather today?" }]);
	});

	it("rejects a message without parts", () => {
		const error = expectA2aError(() =>
			validateSendMessageRequest({ message: { role: "ROLE_USER", parts: [], messageId: "m-1" } }),
		);
		expect(error.code).toBe(-32602);
		expect(error.message).toBe("Invalid parameters");
		expect(String(error.data?.[0] && JSON.stringify(error.data[0]))).toContain("message.parts");
	});

	it("rejects a part carrying two oneof members", () => {
		const error = expectA2aError(() =>
			validateSendMessageRequest({
				message: { role: "ROLE_USER", parts: [{ text: "hi", url: "https://example.com/a" }], messageId: "m-1" },
			}),
		);
		expect(error.code).toBe(-32602);
	});

	it("rejects a part carrying no oneof member", () => {
		const error = expectA2aError(() =>
			validateSendMessageRequest({
				message: { role: "ROLE_USER", parts: [{ mediaType: "text/plain" }], messageId: "m-1" },
			}),
		);
		expect(error.code).toBe(-32602);
	});

	it("rejects an unknown role", () => {
		const error = expectA2aError(() =>
			validateSendMessageRequest({ message: { role: "user", parts: [{ text: "hi" }], messageId: "m-1" } }),
		);
		expect(error.code).toBe(-32602);
	});

	it("rejects an empty messageId", () => {
		const error = expectA2aError(() =>
			validateSendMessageRequest({ message: { role: "ROLE_USER", parts: [{ text: "hi" }], messageId: "" } }),
		);
		expect(error.code).toBe(-32602);
	});

	it("accepts unknown extra fields for forward compatibility", () => {
		const request = validateSendMessageRequest({
			message: { role: "ROLE_AGENT", parts: [{ text: "hi" }], messageId: "m-1", futureField: 7 },
			futureTopLevel: true,
		});
		expect(request.message.role).toBe("ROLE_AGENT");
	});
});

describe("A2A error codes", () => {
	it("matches the spec code table exactly", () => {
		expect(A2A_ERROR_CODES).toEqual({
			JSONParseError: -32700,
			InvalidRequestError: -32600,
			MethodNotFoundError: -32601,
			InvalidParamsError: -32602,
			InternalError: -32603,
			TaskNotFoundError: -32001,
			TaskNotCancelableError: -32002,
			PushNotificationNotSupportedError: -32003,
			UnsupportedOperationError: -32004,
			ContentTypeNotSupportedError: -32005,
			InvalidAgentResponseError: -32006,
			ExtendedAgentCardNotConfiguredError: -32007,
			ExtensionSupportRequiredError: -32008,
			VersionNotSupportedError: -32009,
		});
	});

	it("attaches a google.rpc.ErrorInfo detail", () => {
		const error = taskNotFoundError("task-1");
		expect(error.code).toBe(-32001);
		expect(error.data?.[0]).toMatchObject({
			"@type": "type.googleapis.com/google.rpc.ErrorInfo",
			reason: "TASK_NOT_FOUND",
			domain: "a2a-protocol.org",
			metadata: { taskId: "task-1" },
		});
	});

	it("maps A2aError verbatim and foreign errors to an opaque internal error", () => {
		expect(toJsonRpcError(taskNotFoundError("task-1"))).toMatchObject({ code: -32001, message: "Task not found" });
		const mapped = toJsonRpcError(new TypeError("secret stack detail"));
		expect(mapped).toEqual({ code: -32603, message: "Internal error" });
	});

	it("classifies terminal task states", () => {
		expect(isTerminalTaskState("TASK_STATE_COMPLETED")).toBe(true);
		expect(isTerminalTaskState("TASK_STATE_REJECTED")).toBe(true);
		expect(isTerminalTaskState("TASK_STATE_INPUT_REQUIRED")).toBe(false);
	});
});

describe("SSE framing", () => {
	it("formats a single-line data frame terminated by a blank line", () => {
		expect(formatSseEvent({ jsonrpc: "2.0", id: 1, result: { task: { id: "t" } } })).toBe(
			'data: {"jsonrpc":"2.0","id":1,"result":{"task":{"id":"t"}}}\n\n',
		);
	});

	it("escapes newlines inside payload strings so framing survives", () => {
		expect(formatSseEvent({ text: "line1\nline2" })).toBe('data: {"text":"line1\\nline2"}\n\n');
	});

	it("parses events split across chunks, batched in one chunk, and comment lines", async () => {
		const events = await collect(
			parseSseStream(
				streamOf([
					': keep-alive\r\n\r\ndata: {"a":',
					"1}\n\n",
					'event: update\r\ndata: {"b":2}\r\n\r\nid: 7\ndata: {"c":\ndata: 3}\n\nretry: 500\n\n',
				]),
			),
		);
		expect(events).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
	});
});

describe("TaskStore", () => {
	it("creates submitted tasks and paginates newest first", () => {
		const store = new TaskStore();
		const first = store.create("ctx-1", userMessage("m-1", "one"));
		const second = store.create("ctx-1", userMessage("m-2", "two"));
		const third = store.create("ctx-1", userMessage("m-3", "three"));
		store.create("ctx-2", userMessage("m-4", "other"));
		expect(first.status.state).toBe("TASK_STATE_SUBMITTED");

		const page1 = store.list({ contextId: "ctx-1", pageSize: 2 });
		expect(page1.tasks.map((task) => task.id)).toEqual([third.id, second.id]);
		expect(page1.totalSize).toBe(3);
		expect(page1.pageSize).toBe(2);
		expect(page1.nextPageToken).not.toBe("");

		const page2 = store.list({ contextId: "ctx-1", pageSize: 2, pageToken: page1.nextPageToken });
		expect(page2.tasks.map((task) => task.id)).toEqual([first.id]);
		expect(page2.nextPageToken).toBe("");
	});

	it("filters by status", () => {
		const store = new TaskStore();
		const task = store.create("ctx-1", userMessage("m-1", "one"));
		store.create("ctx-1", userMessage("m-2", "two"));
		store.setState(task.id, "TASK_STATE_WORKING");
		const page = store.list({ status: "TASK_STATE_WORKING" });
		expect(page.tasks.map((entry) => entry.id)).toEqual([task.id]);
		expect(page.totalSize).toBe(1);
	});

	it("honors historyLength semantics in snapshots", () => {
		const store = new TaskStore();
		const task = store.create("ctx-1", userMessage("m-1", "one"));
		store.appendHistory(task.id, userMessage("m-2", "two"));
		expect(store.snapshot(task.id).history).toHaveLength(2);
		expect(store.snapshot(task.id, 1).history).toEqual([userMessage("m-2", "two")]);
		expect("history" in store.snapshot(task.id, 0)).toBe(false);
	});

	it("merges appended text chunks into the last text part", () => {
		const store = new TaskStore();
		const task = store.create("ctx-1", userMessage("m-1", "one"));
		const created = store.appendArtifactChunk(task.id, { part: textPart("Hello"), name: "Report" });
		const merged = store.appendArtifactChunk(task.id, {
			artifactId: created.artifactId,
			part: textPart(" world"),
			append: true,
		});
		const pushed = store.appendArtifactChunk(task.id, {
			artifactId: created.artifactId,
			part: textPart("!"),
			lastChunk: true,
		});
		expect(created.name).toBe("Report");
		expect(merged.parts).toEqual([{ text: "Hello world" }]);
		expect(pushed.parts).toEqual([{ text: "Hello world" }, { text: "!" }]);
		expect(store.snapshot(task.id).artifacts).toEqual([
			{ artifactId: created.artifactId, name: "Report", parts: [{ text: "Hello world" }, { text: "!" }] },
		]);
	});

	it("throws TaskNotFoundError for unknown ids", () => {
		const store = new TaskStore();
		const error = expectA2aError(() => store.get("missing"));
		expect(error.code).toBe(-32001);
	});
});

describe("A2aClient", () => {
	it("selects the JSONRPC interface from the agent card", async () => {
		const fixture = await startFixture();
		const client = await A2aClient.fromCardUrl(`${fixture.baseUrl}${AGENT_CARD_PATH}`);
		const card = await client.getAgentCard();
		expect(card.name).toBe("Fixture Agent");
		expect(client.url).toBe(`${fixture.baseUrl}/a2a/v1`);
	});

	it("sends a message with the A2A version header and returns the task", async () => {
		const fixture = await startFixture();
		const client = await A2aClient.fromCardUrl(`${fixture.baseUrl}${AGENT_CARD_PATH}`);
		const response = await client.sendMessage(validateSendMessageRequest(SPEC_SEND_MESSAGE_PARAMS));
		expect("task" in response && response.task.status.state).toBe("TASK_STATE_COMPLETED");
		const last = fixture.received.at(-1);
		expect(last?.headers["a2a-version"]).toBe("1.0");
		expect(last?.headers["content-type"]).toBe("application/json");
		expect(JSON.parse(last?.body ?? "{}")).toMatchObject({ jsonrpc: "2.0", method: "SendMessage" });
	});

	it("streams task, artifact, and status events over SSE", async () => {
		const fixture = await startFixture();
		const client = await A2aClient.fromCardUrl(`${fixture.baseUrl}${AGENT_CARD_PATH}`);
		const events: StreamResponse[] = [];
		for await (const event of client.sendStreamingMessage(validateSendMessageRequest(SPEC_SEND_MESSAGE_PARAMS))) {
			events.push(event);
		}
		expect(events.map((event) => Object.keys(event)[0])).toEqual(["task", "artifactUpdate", "statusUpdate"]);
		expect(fixture.received.at(-1)?.headers.accept).toBe("text/event-stream");
	});

	it("propagates a JSON-RPC error carried by a non-2xx response", async () => {
		const fixture = await startFixture();
		const client = await A2aClient.fromCardUrl(`${fixture.baseUrl}${AGENT_CARD_PATH}`);
		await expect(client.getTask({ id: "task-uuid" })).rejects.toMatchObject({ code: -32001, name: "A2aError" });
	});

	it("fails when the card exposes no JSONRPC 1.x interface", async () => {
		const server = createServer((_request, response) => {
			sendJson(response, 200, {
				name: "grpc-only",
				description: "no jsonrpc",
				version: "1.0.0",
				supportedInterfaces: [{ url: "https://example.com/grpc", protocolBinding: "GRPC", protocolVersion: "1.0" }],
				capabilities: {},
				defaultInputModes: [],
				defaultOutputModes: [],
				skills: [],
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		servers.push(server);
		const address = server.address();
		if (typeof address !== "object" || address === null) throw new Error("Expected a TCP address");
		await expect(A2aClient.fromCardUrl(`http://127.0.0.1:${address.port}${AGENT_CARD_PATH}`)).rejects.toMatchObject({
			code: -32004,
		});
	});
});

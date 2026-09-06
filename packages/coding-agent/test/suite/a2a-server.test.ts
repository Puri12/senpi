// allow: SIZE_OK — single A2A server HTTP/JSON-RPC E2E surface (card, RPC, SSE, auth, cancel)
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { parseSseStream } from "../../src/core/a2a/sse.ts";
import type { StreamResponse, Task } from "../../src/core/a2a/types.ts";
import { AGENT_CARD_PATH } from "../../src/core/a2a/types.ts";
import { type A2aServerHandle, type StartA2aServerOptions, startA2aServer } from "../../src/modes/a2a-server/index.ts";
import { createHarness, type Harness } from "./harness.ts";

type RpcSuccess = { readonly jsonrpc: "2.0"; readonly id: string | number | null; readonly result: unknown };
type RpcFailure = {
	readonly jsonrpc: "2.0";
	readonly id: string | number | null;
	readonly error: { readonly code: number; readonly message: string };
};

function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolvePromise: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

function userMessage(text: string, extra: { contextId?: string; taskId?: string } = {}): Record<string, unknown> {
	return {
		messageId: `msg-${text}`,
		role: "ROLE_USER",
		parts: [{ text }],
		...extra,
	};
}

function isTask(value: unknown): value is Task {
	return typeof value === "object" && value !== null && "id" in value && "status" in value;
}

function isSuccess(body: RpcSuccess | RpcFailure): body is RpcSuccess {
	return "result" in body;
}

function isFailure(body: RpcSuccess | RpcFailure): body is RpcFailure {
	return "error" in body;
}

function taskFromSend(result: unknown): Task {
	if (typeof result !== "object" || result === null || !("task" in result) || !isTask(result.task)) {
		throw new Error("SendMessage result is missing task");
	}
	return result.task;
}

function artifactText(task: Task): string {
	return (task.artifacts ?? [])
		.flatMap((artifact) => artifact.parts)
		.reduce((text, part) => {
			return "text" in part ? text + part.text : text;
		}, "");
}

function streamKind(event: StreamResponse): "task" | "message" | "statusUpdate" | "artifactUpdate" {
	if ("statusUpdate" in event) return "statusUpdate";
	if ("artifactUpdate" in event) return "artifactUpdate";
	if ("task" in event) return "task";
	if ("message" in event) return "message";
	throw new Error("unknown stream event");
}

async function collectSse(response: Response): Promise<unknown[]> {
	if (response.body === null) throw new Error("missing SSE body");
	const events: unknown[] = [];
	for await (const event of parseSseStream(response.body)) events.push(event);
	return events;
}

function unwrapStream(events: unknown[]): StreamResponse[] {
	return events.map((event) => {
		if (typeof event !== "object" || event === null || !("result" in event)) {
			throw new Error(`expected JSON-RPC success, got ${JSON.stringify(event)}`);
		}
		return event.result as StreamResponse;
	});
}

describe("a2a-server HTTP JSON-RPC", () => {
	const harnesses: Harness[] = [];
	const cleanups: Array<() => void> = [];
	const handles: A2aServerHandle[] = [];
	let rpcId = 1;

	afterEach(async () => {
		while (handles.length > 0) {
			await handles.pop()?.close();
		}
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	async function startWithHarness(options: Partial<StartA2aServerOptions> = {}): Promise<{
		handle: A2aServerHandle;
		created: { count: number };
	}> {
		const created = { count: 0 };
		const cwd = join(tmpdir(), `a2a-server-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cwd, { recursive: true });
		cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
		const handle = await startA2aServer({
			cwd,
			auth: { kind: "off" },
			createSession: async () => {
				created.count += 1;
				const harness = await createHarness();
				harnesses.push(harness);
				harness.setResponses([fauxAssistantMessage("pong"), fauxAssistantMessage("pong")]);
				return { session: harness.session };
			},
			...options,
			host: options.host ?? "127.0.0.1",
			port: options.port ?? 0,
		});
		handles.push(handle);
		return { handle, created };
	}

	async function rpc(
		handle: A2aServerHandle,
		method: string,
		params: unknown,
		headers: Record<string, string> = {},
	): Promise<{ status: number; body: RpcSuccess | RpcFailure; response: Response }> {
		const id = rpcId++;
		const response = await fetch(`http://${handle.host}:${handle.port}/`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
		});
		const body = (await response.json()) as RpcSuccess | RpcFailure;
		return { status: response.status, body, response };
	}

	it("serves an agent card with JSON-RPC 1.0 streaming capabilities", async () => {
		// Given: an a2a-server on an ephemeral loopback port.
		const { handle } = await startWithHarness();

		// When: the well-known agent card is fetched without auth.
		const response = await fetch(`http://${handle.host}:${handle.port}${AGENT_CARD_PATH}`);
		const card = (await response.json()) as {
			supportedInterfaces: Array<{ url: string; protocolBinding: string; protocolVersion: string }>;
			capabilities: { streaming: boolean; extensions?: unknown };
			skills: Array<{ id: string }>;
		};

		// Then: the card advertises JSON-RPC 1.0 at this origin with streaming enabled,
		// no extensions capability, and only the coding-agent skill.
		expect(response.status).toBe(200);
		expect(card.supportedInterfaces[0]).toEqual({
			url: `http://${handle.host}:${handle.port}`,
			protocolBinding: "JSONRPC",
			protocolVersion: "1.0",
		});
		expect(card.capabilities.streaming).toBe(true);
		expect(card.capabilities).not.toHaveProperty("extensions");
		expect(card.skills.map((skill) => skill.id)).toEqual(["coding-agent"]);
	});

	it("advertises omo-remote and ultrawork on the agent card when extensions are set", async () => {
		// Given: an a2a-server started with at least one extension path (injected createSession
		// bypasses defaultCreateSession, so this case only covers card advertisement).
		const { handle } = await startWithHarness({ extensions: ["/tmp/x"] });

		// When: the well-known agent card is fetched.
		const response = await fetch(`http://${handle.host}:${handle.port}${AGENT_CARD_PATH}`);
		const card = (await response.json()) as {
			capabilities: { extensions?: Array<{ uri: string }> };
			skills: Array<{ id: string }>;
		};

		// Then: the card advertises the omo-remote extension uri and the ultrawork skill.
		expect(card.capabilities.extensions?.[0]?.uri).toBe("https://omo.dev/a2a/ext/omo-remote/v1");
		expect(card.skills.some((skill) => skill.id === "ultrawork")).toBe(true);
	});

	it("completes a blocking SendMessage with the faux assistant text", async () => {
		// Given: a server whose sessions reply "pong".
		const { handle } = await startWithHarness();

		// When: SendMessage is invoked and the caller waits for the result.
		const { status, body } = await rpc(handle, "SendMessage", { message: userMessage("ping") });

		// Then: the task completes with artifact text "pong" and the user message in history.
		expect(status).toBe(200);
		expect(isSuccess(body)).toBe(true);
		if (!isSuccess(body)) throw new Error("expected success");
		const task = taskFromSend(body.result);
		expect(task.status.state).toBe("TASK_STATE_COMPLETED");
		expect(artifactText(task)).toBe("pong");
		expect(task.history?.some((message) => message.role === "ROLE_USER")).toBe(true);
	});

	it("returns immediately from SendMessage when returnImmediately is true", async () => {
		// Given: a server whose sessions reply "pong".
		const { handle } = await startWithHarness();

		// When: SendMessage is invoked with returnImmediately and completion is awaited via GetTask after SubscribeToTask.
		const sent = await rpc(handle, "SendMessage", {
			message: userMessage("ping"),
			configuration: { returnImmediately: true },
		});
		expect(isSuccess(sent.body)).toBe(true);
		if (!isSuccess(sent.body)) throw new Error("expected success");
		const accepted = taskFromSend(sent.body.result);
		expect(["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"]).toContain(accepted.status.state);

		const subscribe = await fetch(`http://${handle.host}:${handle.port}/`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "SubscribeToTask", params: { id: accepted.id } }),
		});
		if (subscribe.headers.get("content-type")?.includes("text/event-stream") === true) {
			await collectSse(subscribe);
		}

		const got = await rpc(handle, "GetTask", { id: accepted.id });

		// Then: the accepted snapshot is non-terminal and GetTask reports COMPLETED once the runner finishes.
		expect(isSuccess(got.body)).toBe(true);
		if (!isSuccess(got.body)) throw new Error("expected success");
		expect(isTask(got.body.result) ? got.body.result.status.state : undefined).toBe("TASK_STATE_COMPLETED");
	});

	it("streams SendStreamingMessage as task then artifact then completed", async () => {
		// Given: a server whose sessions reply "pong".
		const { handle } = await startWithHarness();

		// When: SendStreamingMessage is invoked over SSE.
		const response = await fetch(`http://${handle.host}:${handle.port}/`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "text/event-stream" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: rpcId++,
				method: "SendStreamingMessage",
				params: { message: userMessage("ping") },
			}),
		});
		expect(response.status).toBe(200);
		const events = unwrapStream(await collectSse(response));

		// Then: events are task snapshot, artifact text that concatenates to pong, then COMPLETED, and the stream ends.
		const firstEvent = events[0];
		if (firstEvent === undefined) throw new Error("streaming produced no events");
		expect(streamKind(firstEvent)).toBe("task");
		const artifactTextChunks = events
			.map((event) => {
				if (!("artifactUpdate" in event)) return "";
				return event.artifactUpdate.artifact.parts.map((part) => ("text" in part ? part.text : "")).join("");
			})
			.join("");
		expect(artifactTextChunks).toBe("pong");
		const completed = events.find(
			(event) => "statusUpdate" in event && event.statusUpdate.status.state === "TASK_STATE_COMPLETED",
		);
		expect(completed).toBeDefined();
		expect(events.indexOf(firstEvent)).toBe(0);
		const completedIndex = completed === undefined ? -1 : events.indexOf(completed);
		const firstArtifact = events.findIndex((event) => "artifactUpdate" in event);
		expect(firstArtifact).toBeGreaterThan(0);
		expect(completedIndex).toBeGreaterThan(firstArtifact);
	});

	it("reuses one session per contextId and rejects a follow-up on a terminal task", async () => {
		// Given: a server that counts createSession calls.
		const { handle, created } = await startWithHarness();
		const contextId = "ctx-reuse";

		// When: two SendMessage calls share a contextId, then a third uses the first task id.
		const first = await rpc(handle, "SendMessage", { message: userMessage("one", { contextId }) });
		const second = await rpc(handle, "SendMessage", { message: userMessage("two", { contextId }) });
		expect(isSuccess(first.body)).toBe(true);
		if (!isSuccess(first.body)) throw new Error("expected success");
		const firstTask = taskFromSend(first.body.result);
		const third = await rpc(handle, "SendMessage", {
			message: userMessage("three", { contextId, taskId: firstTask.id }),
		});

		// Then: the factory ran once and the follow-up on the terminal task is -32004.
		expect(created.count).toBe(1);
		expect(isSuccess(second.body)).toBe(true);
		expect(isFailure(third.body)).toBe(true);
		if (!isFailure(third.body)) throw new Error("expected failure");
		expect(third.body.error.code).toBe(-32004);
	});

	it("maps protocol errors onto the documented JSON-RPC codes", async () => {
		// Given: a server with one completed task.
		const { handle } = await startWithHarness();
		const completed = await rpc(handle, "SendMessage", { message: userMessage("ping") });
		expect(isSuccess(completed.body)).toBe(true);
		if (!isSuccess(completed.body)) throw new Error("expected success");
		const task = taskFromSend(completed.body.result);

		// When: invalid and unsupported methods are invoked.
		const unknownTask = await rpc(handle, "GetTask", { id: "missing-task" });
		const cancelCompleted = await rpc(handle, "CancelTask", { id: task.id });
		const unknownMethod = await rpc(handle, "NotAMethod", {});
		const invalidJson = await fetch(`http://${handle.host}:${handle.port}/`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{not json",
		});
		const invalidJsonBody = (await invalidJson.json()) as RpcFailure;
		const missingParts = await rpc(handle, "SendMessage", {
			message: { messageId: "m", role: "ROLE_USER", parts: [] },
		});
		const badVersion = await rpc(handle, "GetTask", { id: task.id }, { "a2a-version": "0.3" });
		const extended = await rpc(handle, "GetExtendedAgentCard", {});
		const push = await rpc(handle, "CreateTaskPushNotificationConfig", {});

		// Then: each path returns the A2A JSON-RPC error code.
		expect(isFailure(unknownTask.body) && unknownTask.body.error.code).toBe(-32001);
		expect(isFailure(cancelCompleted.body) && cancelCompleted.body.error.code).toBe(-32002);
		expect(isFailure(unknownMethod.body) && unknownMethod.body.error.code).toBe(-32601);
		expect(invalidJson.status).toBe(200);
		expect(invalidJsonBody.error.code).toBe(-32700);
		expect(isFailure(missingParts.body) && missingParts.body.error.code).toBe(-32602);
		expect(isFailure(badVersion.body) && badVersion.body.error.code).toBe(-32009);
		expect(isFailure(extended.body) && extended.body.error.code).toBe(-32004);
		expect(isFailure(push.body) && push.body.error.code).toBe(-32003);
	});

	it("requires bearer auth on POST while leaving the agent card public", async () => {
		// Given: a server started with a bearer token.
		const { handle } = await startWithHarness({ auth: { kind: "token-value", token: "secret" } });

		// When: POST is attempted without and with Authorization, and the card is fetched anonymously.
		const unauthorized = await rpc(handle, "GetTask", { id: "x" });
		const authorized = await rpc(handle, "GetTask", { id: "x" }, { authorization: "Bearer secret" });
		const card = await fetch(`http://${handle.host}:${handle.port}${AGENT_CARD_PATH}`);

		// Then: missing auth is 401 with WWW-Authenticate, a valid bearer reaches JSON-RPC, and the card stays public.
		expect(unauthorized.status).toBe(401);
		expect(unauthorized.response.headers.get("www-authenticate")).toBe("Bearer");
		expect(authorized.status).toBe(200);
		expect(card.status).toBe(200);
	});

	it("refuses unauthenticated listen on a non-loopback host", async () => {
		// Given: auth is off and the requested host is 0.0.0.0.
		// When: startA2aServer is invoked.
		try {
			await startA2aServer({ host: "0.0.0.0", port: 41241, auth: { kind: "off" } });
			throw new Error("expected listen to be refused");
		} catch (error) {
			// Then: the error carries exitCode 2 and no listener is left running.
			expect(error).toMatchObject({ exitCode: 2 });
		}
	});

	it("cancels an in-flight turn and closes the SSE stream as CANCELED", async () => {
		// Given: a faux session whose in-flight tool waits until abort unblocks it.
		const gate = createDeferred();
		const started = createDeferred();
		const blockTool: AgentTool = {
			name: "block",
			label: "Block",
			description: "Wait until aborted",
			parameters: Type.Object({}),
			execute: async (_id, _params, signal) => {
				started.resolve();
				await new Promise<void>((resolve, reject) => {
					const onAbort = (): void => {
						signal?.removeEventListener("abort", onAbort);
						reject(new Error("aborted"));
					};
					if (signal?.aborted) {
						reject(new Error("aborted"));
						return;
					}
					signal?.addEventListener("abort", onAbort);
					gate.promise.then(() => {
						signal?.removeEventListener("abort", onAbort);
						resolve();
					});
				});
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
		};
		const cwd = join(tmpdir(), `a2a-cancel-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cwd, { recursive: true });
		cleanups.push(() => {
			gate.resolve();
			rmSync(cwd, { recursive: true, force: true });
		});
		const handle = await startA2aServer({
			host: "127.0.0.1",
			port: 0,
			cwd,
			auth: { kind: "off" },
			createSession: async () => {
				const harness = await createHarness({ tools: [blockTool] });
				harnesses.push(harness);
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" }),
					fauxAssistantMessage("should not finish"),
				]);
				return { session: harness.session };
			},
		});
		handles.push(handle);

		// When: a streaming turn is opened, then CancelTask is issued while the gate holds.
		const taskIdReady = createDeferred();
		let taskId = "";
		const eventsPromise = (async () => {
			const stream = await fetch(`http://${handle.host}:${handle.port}/`, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "text/event-stream" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: rpcId++,
					method: "SendStreamingMessage",
					params: { message: userMessage("interrupt me") },
				}),
			});
			if (stream.body === null) throw new Error("missing SSE body");
			const collected: unknown[] = [];
			for await (const event of parseSseStream(stream.body)) {
				collected.push(event);
				if (taskId === "" && typeof event === "object" && event !== null && "result" in event) {
					const result = event.result;
					if (typeof result === "object" && result !== null && "task" in result && isTask(result.task)) {
						taskId = result.task.id;
						taskIdReady.resolve();
					}
				}
			}
			return collected;
		})();
		await taskIdReady.promise;
		await started.promise;
		const canceled = await rpc(handle, "CancelTask", { id: taskId });
		const events = unwrapStream(await eventsPromise);

		// Then: the task ends CANCELED and the open SSE stream receives that status update and closes.
		expect(isSuccess(canceled.body)).toBe(true);
		if (!isSuccess(canceled.body)) throw new Error("expected success");
		expect(isTask(canceled.body.result) ? canceled.body.result.status.state : undefined).toBe("TASK_STATE_CANCELED");
		expect(
			events.some((event) => "statusUpdate" in event && event.statusUpdate.status.state === "TASK_STATE_CANCELED"),
		).toBe(true);
	});
});

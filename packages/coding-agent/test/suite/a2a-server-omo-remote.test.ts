// allow: SIZE_OK — single E2E surface for the omo-remote/v1 extension (steer, queueing, usage, card params)
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../../src/config.ts";
import { parseSseStream } from "../../src/core/a2a/sse.ts";
import type { StreamResponse, Task } from "../../src/core/a2a/types.ts";
import { AGENT_CARD_PATH } from "../../src/core/a2a/types.ts";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { type A2aServerHandle, startA2aServer } from "../../src/modes/a2a-server/index.ts";

const USAGE_STEP = { input: 11, output: 5, cacheRead: 3, cacheWrite: 2, cost: 0.25 } as const;
const FAUX_MODEL_ID = "faux-model";

type RpcSuccess = { readonly jsonrpc: "2.0"; readonly id: string | number | null; readonly result: unknown };
type RpcFailure = {
	readonly jsonrpc: "2.0";
	readonly id: string | number | null;
	readonly error: { readonly code: number; readonly message: string };
};

type FakeSessionEvent =
	| { type: "message_update"; assistantMessageEvent: { type: "text_delta"; delta: string } }
	| { type: "agent_end"; willRetry: false };

type FakeSession = {
	readonly session: AgentSession;
	readonly steerCalls: string[];
	readonly followUpCalls: string[];
	readonly promptCalls: string[];
	waitForPrompt(count: number): Promise<void>;
	completeTurn(text: string): void;
};

/** Records steer/followUp/prompt and hands the test explicit control over when a turn ends. */
function createFakeSession(): FakeSession {
	const listeners = new Set<(event: FakeSessionEvent) => void>();
	const steerCalls: string[] = [];
	const followUpCalls: string[] = [];
	const promptCalls: string[] = [];
	const turnResolvers: Array<() => void> = [];
	const promptWaiters: Array<{ count: number; resolve: () => void }> = [];
	const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let cost = 0;
	const emit = (event: FakeSessionEvent): void => {
		for (const listener of [...listeners]) listener(event);
	};
	const releaseWaiters = (): void => {
		for (const waiter of promptWaiters.splice(0, promptWaiters.length)) {
			if (waiter.count <= promptCalls.length) {
				waiter.resolve();
			} else {
				promptWaiters.push(waiter);
			}
		}
	};
	const session = {
		get model() {
			return { id: FAUX_MODEL_ID, provider: "faux" };
		},
		subscribe(listener: (event: FakeSessionEvent) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async prompt(text: string): Promise<void> {
			promptCalls.push(text);
			releaseWaiters();
			await new Promise<void>((resolve) => {
				turnResolvers.push(resolve);
			});
		},
		async steer(text: string): Promise<void> {
			steerCalls.push(text);
		},
		async followUp(text: string): Promise<void> {
			followUpCalls.push(text);
		},
		async abort(): Promise<void> {
			turnResolvers.shift()?.();
		},
		dispose(): void {
			listeners.clear();
			for (const resolve of turnResolvers.splice(0, turnResolvers.length)) resolve();
		},
		getSessionStats() {
			return {
				sessionFile: undefined,
				sessionId: "fake-session",
				userMessages: promptCalls.length,
				assistantMessages: promptCalls.length,
				toolCalls: 0,
				toolResults: 0,
				totalMessages: promptCalls.length * 2,
				tokens: { ...tokens, total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite },
				cost,
			};
		},
	};
	return {
		session: session as unknown as AgentSession,
		steerCalls,
		followUpCalls,
		promptCalls,
		waitForPrompt(count) {
			if (promptCalls.length >= count) return Promise.resolve();
			return new Promise<void>((resolve) => {
				promptWaiters.push({ count, resolve });
			});
		},
		completeTurn(text) {
			tokens.input += USAGE_STEP.input;
			tokens.output += USAGE_STEP.output;
			tokens.cacheRead += USAGE_STEP.cacheRead;
			tokens.cacheWrite += USAGE_STEP.cacheWrite;
			cost += USAGE_STEP.cost;
			emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
			emit({ type: "agent_end", willRetry: false });
			turnResolvers.shift()?.();
		},
	};
}

type SessionPool = {
	/** Registers one more faux session, as the server's `createSession` factory would. */
	add(): FakeSession;
	/** Resolves with the first session once the server has lazily created it. */
	first(): Promise<FakeSession>;
};

function createSessionPool(): SessionPool {
	const created: FakeSession[] = [];
	const waiters: Array<(session: FakeSession) => void> = [];
	return {
		add() {
			const fake = createFakeSession();
			created.push(fake);
			for (const resolve of waiters.splice(0, waiters.length)) resolve(fake);
			return fake;
		},
		first() {
			const existing = created[0];
			if (existing !== undefined) return Promise.resolve(existing);
			return new Promise<FakeSession>((resolve) => {
				waiters.push(resolve);
			});
		},
	};
}

function userMessage(
	text: string,
	extra: { contextId?: string; taskId?: string; steer?: boolean } = {},
): Record<string, unknown> {
	const { steer, ...ids } = extra;
	return {
		messageId: `msg-${text}`,
		role: "ROLE_USER",
		parts: [{ text }],
		...ids,
		...(steer === true ? { metadata: { omo: { steer: true } } } : {}),
	};
}

function isSuccess(body: RpcSuccess | RpcFailure): body is RpcSuccess {
	return "result" in body;
}

function taskFromSend(body: RpcSuccess | RpcFailure): Task {
	if (!isSuccess(body)) throw new Error(`expected JSON-RPC success, got ${JSON.stringify(body)}`);
	const result = body.result;
	if (typeof result !== "object" || result === null || !("task" in result)) {
		throw new Error("SendMessage result is missing task");
	}
	return result.task as Task;
}

function errorCode(body: RpcSuccess | RpcFailure): number {
	if (isSuccess(body)) throw new Error(`expected JSON-RPC failure, got ${JSON.stringify(body)}`);
	return body.error.code;
}

async function collectStream(response: Response): Promise<StreamResponse[]> {
	if (response.body === null) throw new Error("missing SSE body");
	const events: StreamResponse[] = [];
	for await (const event of parseSseStream(response.body)) {
		if (typeof event !== "object" || event === null || !("result" in event)) {
			throw new Error(`expected JSON-RPC success frame, got ${JSON.stringify(event)}`);
		}
		events.push(event.result as StreamResponse);
	}
	return events;
}

function terminalStatus(events: readonly StreamResponse[]): { state: string; metadata?: Record<string, unknown> } {
	for (const event of events) {
		if (!("statusUpdate" in event)) continue;
		if (event.statusUpdate.status.state === "TASK_STATE_COMPLETED") {
			return {
				state: event.statusUpdate.status.state,
				...(event.statusUpdate.metadata === undefined ? {} : { metadata: event.statusUpdate.metadata }),
			};
		}
	}
	throw new Error("no terminal statusUpdate in stream");
}

describe("a2a-server omo-remote/v1 extension", () => {
	const cleanups: Array<() => void> = [];
	const handles: A2aServerHandle[] = [];
	let rpcId = 1;

	afterEach(async () => {
		while (handles.length > 0) {
			await handles.pop()?.close();
		}
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	async function startServer(options: { extensionActive: boolean }): Promise<{
		handle: A2aServerHandle;
		sessions: SessionPool;
	}> {
		const sessions = createSessionPool();
		const cwd = join(tmpdir(), `a2a-omo-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cwd, { recursive: true });
		cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
		const handle = await startA2aServer({
			host: "127.0.0.1",
			port: 0,
			cwd,
			auth: { kind: "off" },
			...(options.extensionActive ? { extensions: ["/tmp/omo-plugin"] } : {}),
			createSession: async () => ({ session: sessions.add().session }),
		});
		handles.push(handle);
		return { handle, sessions };
	}

	async function rpc(handle: A2aServerHandle, method: string, params: unknown): Promise<RpcSuccess | RpcFailure> {
		const response = await fetch(`http://${handle.host}:${handle.port}/`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
		});
		return (await response.json()) as RpcSuccess | RpcFailure;
	}

	function startTurn(handle: A2aServerHandle, text: string, extra: { contextId?: string; taskId?: string } = {}) {
		return rpc(handle, "SendMessage", {
			message: userMessage(text, extra),
			configuration: { returnImmediately: true },
		});
	}

	it("steers a running task instead of creating a new one when the extension is active", async () => {
		// Given: an extension-enabled server with one WORKING task on context ctx-steer.
		const { handle, sessions } = await startServer({ extensionActive: true });
		const started = taskFromSend(await startTurn(handle, "first", { contextId: "ctx-steer" }));
		const fake = await sessions.first();
		await fake.waitForPrompt(1);

		// When: a steer-flagged message names that task.
		const steered = await rpc(handle, "SendMessage", {
			message: userMessage("nudge", { contextId: "ctx-steer", taskId: started.id, steer: true }),
		});
		const listed = await rpc(handle, "ListTasks", { contextId: "ctx-steer" });

		// Then: the session was steered, the same task came back, and no second task exists.
		expect(fake.steerCalls).toEqual(["nudge"]);
		expect(fake.promptCalls).toEqual(["first"]);
		const task = taskFromSend(steered);
		expect(task.id).toBe(started.id);
		expect(task.status.state).toBe("TASK_STATE_WORKING");
		expect(isSuccess(listed) ? (listed.result as { totalSize: number }).totalSize : -1).toBe(1);
		fake.completeTurn("done");
	});

	it("rejects a steer on a task that is no longer running with -32602", async () => {
		// Given: an extension-enabled server whose first task already completed.
		const { handle, sessions } = await startServer({ extensionActive: true });
		const started = taskFromSend(await startTurn(handle, "first", { contextId: "ctx-done" }));
		const fake = await sessions.first();
		await fake.waitForPrompt(1);
		fake.completeTurn("done");
		const completed = await rpc(handle, "GetTask", { id: started.id });
		expect((completed as RpcSuccess).result).toMatchObject({ status: { state: "TASK_STATE_COMPLETED" } });

		// When: a steer-flagged message names the completed task.
		const steered = await rpc(handle, "SendMessage", {
			message: userMessage("too late", { contextId: "ctx-done", taskId: started.id, steer: true }),
		});

		// Then: the call is invalid params and the session was never steered.
		expect(errorCode(steered)).toBe(-32602);
		expect(fake.steerCalls).toEqual([]);
	});

	it("creates a new task for a steer-flagged message when the extension is inactive", async () => {
		// Given: a server started without extensions and one WORKING task.
		const { handle, sessions } = await startServer({ extensionActive: false });
		const started = taskFromSend(await startTurn(handle, "first", { contextId: "ctx-off" }));
		const fake = await sessions.first();
		await fake.waitForPrompt(1);

		// When: the same steer-flagged message arrives.
		const second = await rpc(handle, "SendMessage", {
			message: userMessage("nudge", { contextId: "ctx-off", taskId: started.id, steer: true }),
			configuration: { returnImmediately: true },
		});

		// Then: today's behaviour holds — a new task on the same context, no steer call.
		const task = taskFromSend(second);
		expect(task.id).not.toBe(started.id);
		expect(task.contextId).toBe("ctx-off");
		expect(fake.steerCalls).toEqual([]);
		fake.completeTurn("first done");
		await fake.waitForPrompt(2);
		fake.completeTurn("second done");
	});

	it("queues a follow-up turn on the same context behind the running task", async () => {
		// Given: an extension-enabled server with one WORKING task.
		const { handle, sessions } = await startServer({ extensionActive: true });
		const started = taskFromSend(await startTurn(handle, "first", { contextId: "ctx-queue" }));
		const fake = await sessions.first();
		await fake.waitForPrompt(1);

		// When: a follow-up without the steer flag names the running task.
		const second = taskFromSend(await startTurn(handle, "second", { contextId: "ctx-queue", taskId: started.id }));

		// Then: it is a new task on the same context that only prompts after the first turn ends.
		expect(second.id).not.toBe(started.id);
		expect(second.contextId).toBe("ctx-queue");
		expect(fake.promptCalls).toEqual(["first"]);
		fake.completeTurn("first done");
		await fake.waitForPrompt(2);
		expect(fake.promptCalls).toEqual(["first", "second"]);
		expect(fake.followUpCalls).toEqual([]);
		fake.completeTurn("second done");
		const firstTask = await rpc(handle, "GetTask", { id: started.id });
		expect((firstTask as RpcSuccess).result).toMatchObject({ status: { state: "TASK_STATE_COMPLETED" } });
	});

	it("streams the running task's own events when a steer joins it", async () => {
		// Given: an extension-enabled server with one WORKING task.
		const { handle, sessions } = await startServer({ extensionActive: true });
		const started = taskFromSend(await startTurn(handle, "first", { contextId: "ctx-steer-sse" }));
		const fake = await sessions.first();
		await fake.waitForPrompt(1);

		// When: a steer-flagged streaming message names that task and the turn then finishes.
		const response = await fetch(`http://${handle.host}:${handle.port}/`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "text/event-stream" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: rpcId++,
				method: "SendStreamingMessage",
				params: { message: userMessage("nudge", { contextId: "ctx-steer-sse", taskId: started.id, steer: true }) },
			}),
		});
		fake.completeTurn("done");
		const events = await collectStream(response);

		// Then: the stream replays the running task and closes on its terminal update, with no new task.
		const opening = events[0];
		if (opening === undefined || !("task" in opening)) throw new Error("stream did not open with a task snapshot");
		expect(opening.task.id).toBe(started.id);
		expect(fake.steerCalls).toEqual(["nudge"]);
		expect(fake.promptCalls).toEqual(["first"]);
		expect(terminalStatus(events).state).toBe("TASK_STATE_COMPLETED");
	});

	it("reports this turn's omo usage delta, not the session totals, when the extension is active", async () => {
		// Given: an extension-enabled server whose context already burned one usage step on an earlier turn.
		const { handle, sessions } = await startServer({ extensionActive: true });
		const contextId = "ctx-usage";
		await startTurn(handle, "warmup", { contextId });
		const fake = await sessions.first();
		await fake.waitForPrompt(1);
		fake.completeTurn("warm");
		const streamPromise = fetch(`http://${handle.host}:${handle.port}/`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "text/event-stream" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: rpcId++,
				method: "SendStreamingMessage",
				params: { message: userMessage("ping", { contextId }) },
			}),
		});

		// When: the second turn finishes after consuming one more usage step.
		const response = await streamPromise;
		await fake.waitForPrompt(2);
		fake.completeTurn("pong");
		const events = await collectStream(response);

		// Then: the terminal statusUpdate reports one step, so the earlier turn's usage is excluded.
		expect(terminalStatus(events).metadata).toEqual({
			omo: {
				usage: {
					input: USAGE_STEP.input,
					output: USAGE_STEP.output,
					cacheRead: USAGE_STEP.cacheRead,
					cacheWrite: USAGE_STEP.cacheWrite,
					cost: USAGE_STEP.cost,
					model: FAUX_MODEL_ID,
				},
			},
		});
	});

	it("omits omo metadata from the terminal statusUpdate when the extension is inactive", async () => {
		// Given: a server started without extensions and an open streaming turn.
		const { handle, sessions } = await startServer({ extensionActive: false });
		const streamPromise = fetch(`http://${handle.host}:${handle.port}/`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "text/event-stream" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: rpcId++,
				method: "SendStreamingMessage",
				params: { message: userMessage("ping") },
			}),
		});

		// When: the turn finishes.
		const response = await streamPromise;
		const created = await sessions.first();
		await created.waitForPrompt(1);
		created.completeTurn("pong");
		const events = await collectStream(response);

		// Then: the terminal statusUpdate has no metadata at all.
		expect(terminalStatus(events)).toEqual({ state: "TASK_STATE_COMPLETED" });
	});

	it("publishes the plugin and engine versions as extension params when OMO_PLUGIN_VERSION is set", async () => {
		// Given: the launcher exported a plugin version and the extension is active.
		vi.stubEnv("OMO_PLUGIN_VERSION", "9.9.9-test");
		const { handle } = await startServer({ extensionActive: true });

		// When: the agent card is fetched.
		const card = (await (await fetch(`http://${handle.host}:${handle.port}${AGENT_CARD_PATH}`)).json()) as {
			capabilities: { extensions?: Array<{ uri: string; params?: Record<string, unknown> }> };
		};

		// Then: the omo-remote extension carries both versions in params.
		expect(card.capabilities.extensions?.[0]?.uri).toBe("https://omo.dev/a2a/ext/omo-remote/v1");
		expect(card.capabilities.extensions?.[0]?.params).toEqual({
			pluginVersion: "9.9.9-test",
			engineVersion: VERSION,
		});
	});

	it("omits pluginVersion from the extension params when OMO_PLUGIN_VERSION is unset", async () => {
		// Given: no plugin version in the environment and the extension is active.
		vi.stubEnv("OMO_PLUGIN_VERSION", undefined);
		const { handle } = await startServer({ extensionActive: true });

		// When: the agent card is fetched.
		const card = (await (await fetch(`http://${handle.host}:${handle.port}${AGENT_CARD_PATH}`)).json()) as {
			capabilities: { extensions?: Array<{ params?: Record<string, unknown> }> };
		};

		// Then: params report the engine version only.
		expect(card.capabilities.extensions?.[0]?.params).toEqual({ engineVersion: VERSION });
	});
});

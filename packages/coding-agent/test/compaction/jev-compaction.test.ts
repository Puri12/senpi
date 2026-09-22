import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	applyJevDecisions,
	JEV_TRUNCATION_NOTE,
	renderJevSummary,
	toJevTranscript,
} from "../../src/core/extensions/builtin/compaction/jev/adapter.ts";
import { buildJevRequest, parseJevResponse } from "../../src/core/extensions/builtin/compaction/jev/client.ts";
import { readStoredJevKey, storeJevKey } from "../../src/core/extensions/builtin/compaction/jev/credential.ts";
import {
	batchJevCalls,
	decideJevCall,
	decideJevTranscript,
	resolveJevOptions,
} from "../../src/core/extensions/builtin/compaction/jev/decide.ts";
import {
	generateJevCompaction,
	JEV_SUMMARY_SCHEMA,
	JevCompactionError,
} from "../../src/core/extensions/builtin/compaction/jev/generator.ts";
import {
	JEV_CREDENTIAL_PROVIDER,
	resolveJevApiKey,
	resolveJevCompactionSettings,
} from "../../src/core/extensions/builtin/compaction/jev/settings.ts";
import {
	collectJevToolCalls,
	estimateJevTokens,
	fitJevState,
} from "../../src/core/extensions/builtin/compaction/jev/state.ts";
import type {
	JevAsker,
	JevCompactionState,
	JevQuestions,
	JevToolCall,
} from "../../src/core/extensions/builtin/compaction/jev/types.ts";

const fileA = "export const a = 1;\n".repeat(50);
const fileB = "export const b = 2;\n".repeat(50);

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function assistant(
	text: string,
	calls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [],
): AgentMessage {
	return {
		role: "assistant",
		content: [
			...(text ? [{ type: "text" as const, text }] : []),
			...calls.map((call) => ({ type: "toolCall" as const, id: call.id, name: call.name, arguments: call.args })),
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	} as AgentMessage;
}

function toolResult(id: string, name: string, text: string, isError = false): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		isError,
		timestamp: 3,
	};
}

function span(): AgentMessage[] {
	return [
		user("Never edit anything under src/generated. Fix the failing test."),
		assistant("", [{ id: "call-1", name: "read", args: { path: "src/a.ts" } }]),
		toolResult("call-1", "read", fileA),
		assistant("a.ts looks fine; checking b.ts", [{ id: "call-2", name: "read", args: { path: "src/b.ts" } }]),
		toolResult("call-2", "read", fileB),
		assistant("", [{ id: "call-3", name: "bash", args: { command: "npm test" } }]),
		toolResult("call-3", "bash", "FAIL b.test.ts: expected 2 to be 3", true),
		assistant("The failure is in b.test.ts; fixing now."),
		user("go ahead"),
	];
}

type Seen = { state: JevCompactionState; questions: string[] };

function fakeJev(answer: (name: string) => number, seen: Seen[] = []): JevAsker {
	return {
		async ask(state, questions: JevQuestions) {
			seen.push({ state, questions: Object.keys(questions) });
			return {
				answers: Object.fromEntries(
					Object.keys(questions).map((key) => [key, { type: "noul" as const, noul: answer(key) }]),
				),
			};
		},
	};
}

const settings = resolveJevCompactionSettings({ apiKey: "k" }, {});

describe("jev adapter", () => {
	it("pairs senpi tool calls with their toolResult messages by toolCallId", () => {
		const transcript = toJevTranscript(span());
		const calls = collectJevToolCalls(transcript, 0);
		expect(calls.map((c) => [c.id, c.toolCallId, c.tool, c.callIndex, c.resultIndex, c.isError])).toEqual([
			["t1", "call-1", "read", 1, 2, false],
			["t2", "call-2", "read", 3, 4, false],
			["t3", "call-3", "bash", 5, 6, true],
		]);
		expect(calls[0]?.resultChars).toBe(fileA.length);
		expect(transcript[0]).toMatchObject({ role: "user", pinned: false });
	});

	it("pins summaries, custom messages and image-bearing results so they are never candidates", () => {
		const messages: AgentMessage[] = [
			{ role: "compactionSummary", summary: "previous summary", tokensBefore: 10, timestamp: 0 },
			{ role: "custom", customType: "note", content: "custom note", display: true, timestamp: 0 } as AgentMessage,
			assistant("", [{ id: "img", name: "look_at", args: {} }]),
			{
				role: "toolResult",
				toolCallId: "img",
				toolName: "look_at",
				content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
				isError: false,
				timestamp: 3,
			},
		];
		const transcript = toJevTranscript(messages);
		expect(transcript.map((m) => m.pinned)).toEqual([true, true, false, true]);
		expect(transcript[0]?.text).toContain("previous summary");
		expect(collectJevToolCalls(transcript, 0)[0]?.pinned).toBe(true);
	});

	it("removes dropped calls, truncates dropped results, and keeps everything else verbatim", () => {
		const transcript = toJevTranscript(span());
		const calls = collectJevToolCalls(transcript, 0);
		const options = { keepThreshold: 0.5 };
		const decisions = [
			decideJevCall(calls[0]!, { keepCall: 0.1, keepResult: 0.1 }, options),
			decideJevCall(calls[1]!, { keepCall: 0.9, keepResult: 0.1 }, options),
			decideJevCall(calls[2]!, { keepCall: 0.9, keepResult: 0.9 }, options),
		];
		const pruned = applyJevDecisions(transcript, decisions, 300);
		expect(pruned.callsDropped).toBe(1);
		expect(pruned.resultsDropped).toBe(1);
		expect(pruned.charsAfter).toBeLessThan(pruned.charsBefore);
		expect(pruned.messages.flatMap((m) => m.toolUses.map((t) => t.toolCallId))).toEqual(["call-2", "call-3"]);
		const summary = renderJevSummary(pruned.messages);
		expect(summary).toContain("[User]: Never edit anything under src/generated. Fix the failing test.");
		expect(summary).toContain('[Assistant tool calls]: read(path="src/b.ts")');
		expect(summary).toContain(
			`[${JEV_TRUNCATION_NOTE} ${fileB.length - 300} chars of this tool result; re-run the tool if needed]`,
		);
		expect(summary).toContain("[Tool result (error)]: FAIL b.test.ts: expected 2 to be 3");
		expect(summary).not.toContain("src/a.ts");
		expect(summary).toContain("[User]: go ahead");
	});
});

describe("jev state", () => {
	it("estimates tokens from character shape without undercounting JSON", () => {
		expect(estimateJevTokens("")).toBe(0);
		expect(estimateJevTokens("hello world")).toBe(2);
		const json = JSON.stringify({ file_path: "/Users/x/src/a.ts", old_string: "a = 1;", n: 42 });
		expect(estimateJevTokens(json)).toBeGreaterThanOrEqual(Math.ceil(json.length / 3));
	});

	it("sends the whole span with tool results replaced by a note", () => {
		const transcript = toJevTranscript(span());
		const { state, stage } = fitJevState(transcript, collectJevToolCalls(transcript, 0), {
			maxStateTokens: 25_000,
			preserveRecentMessages: 0,
			goal: "",
		});
		expect(stage).toBe("full");
		const json = JSON.stringify(state);
		expect(json).not.toContain("export const a = 1;");
		expect(json).toContain("Never edit anything under src/generated");
		expect(state.goal).toContain("go ahead");
		expect(state.history[1]?.tool_calls?.[0]).toMatchObject({
			id: "t1",
			tool: "read",
			result: `ok, ${fileA.length} chars (omitted)`,
		});
	});

	it("shrinks in stages and throws when the span cannot be fitted", () => {
		const transcript = toJevTranscript([user("a".repeat(2000)), assistant("b")]);
		expect(() => fitJevState(transcript, [], { maxStateTokens: 50, preserveRecentMessages: 0, goal: "" })).toThrow(
			/too large/,
		);
	});
});

describe("jev decisions", () => {
	const calls: JevToolCall[] = Array.from({ length: 10 }, (_, i) => ({
		id: `t${i + 1}`,
		toolCallId: `call-${i + 1}`,
		tool: "read",
		input: {},
		callIndex: i * 2 + 1,
		resultIndex: i * 2 + 2,
		resultChars: 100,
		isError: false,
		pinned: false,
	}));

	it("batches questions so state plus questions stays under the request ceiling", () => {
		expect(batchJevCalls(calls, 1000, { maxRequestTokens: 30_000 })).toHaveLength(1);
		const batches = batchJevCalls(calls, 29_600, { maxRequestTokens: 30_000 });
		expect(batches.length).toBeGreaterThan(1);
		expect(batches.flat().map((c) => c.id)).toEqual(calls.map((c) => c.id));
		expect(() => batchJevCalls(calls, 29_990, { maxRequestTokens: 30_000 })).toThrow(/no room/);
	});

	it("resends the full state with every batch and merges the answers", async () => {
		const seen: Seen[] = [];
		const transcript = toJevTranscript(span());
		const stateTokens = fitJevState(transcript, collectJevToolCalls(transcript, 0), {
			maxStateTokens: 25_000,
			preserveRecentMessages: 0,
			goal: "",
		}).tokens;
		const run = await decideJevTranscript(
			transcript,
			fakeJev((name) => (name.startsWith("call_") ? 0.9 : 0.1), seen),
			resolveJevOptions({ maxRequestTokens: stateTokens + 150 }),
		);
		expect(run.requests).toBe(seen.length);
		expect(seen.length).toBeGreaterThan(1);
		expect(seen.flatMap((r) => r.questions).sort()).toEqual([
			"call_t1",
			"call_t2",
			"call_t3",
			"result_t1",
			"result_t2",
			"result_t3",
		]);
		expect(new Set(seen.map((r) => JSON.stringify(r.state))).size).toBe(1);
		expect(run.decisions.map((d) => d.action)).toEqual(["drop_result", "drop_result", "drop_result"]);
	});

	it("rejects malformed answers", async () => {
		const broken: JevAsker = { ask: async () => ({ answers: { call_t1: { noul: 0.5 } } }) };
		await expect(decideJevTranscript(toJevTranscript(span()), broken, resolveJevOptions())).rejects.toThrow(
			/Invalid Jev answer/,
		);
	});
});

describe("jev generator", () => {
	const preparation = (previousSummary?: string) => ({
		messagesToSummarize: span(),
		turnPrefixMessages: [],
		previousSummary,
		firstKeptEntryId: "kept-1",
		tokensBefore: 4321,
	});

	it("produces a verbatim CompactionResult with every decision recorded in details", async () => {
		const result = await generateJevCompaction({
			preparation: preparation(),
			settings,
			asker: fakeJev((name) => (name === "call_t3" || name === "result_t3" ? 0.9 : 0.1)),
			origin: "core-route",
		});
		expect(result.firstKeptEntryId).toBe("kept-1");
		expect(result.tokensBefore).toBe(4321);
		expect(result.summary).toContain("[Tool result (error)]: FAIL b.test.ts: expected 2 to be 3");
		expect(result.summary).not.toContain("export const a = 1;");
		expect(result.details).toMatchObject({
			schema: JEV_SUMMARY_SCHEMA,
			origin: "core-route",
			model: "jev-latest",
			stats: { calls: 3, kept: 1, callsDropped: 2, resultsDropped: 0, requests: 1, stateStage: "full" },
		});
		expect(result.details?.decisions.map((d) => [d.toolCallId, d.action])).toEqual([
			["call-1", "drop_call"],
			["call-2", "drop_call"],
			["call-3", "keep"],
		]);
	});

	it("carries a previous summary forward verbatim and pinned", async () => {
		const seen: Seen[] = [];
		const result = await generateJevCompaction({
			preparation: preparation("## Goal\nearlier work"),
			settings,
			asker: fakeJev(() => 0.1, seen),
		});
		expect(result.summary.startsWith("[User]: ## Goal\nearlier work")).toBe(true);
		expect(result.details?.previousSummaryChars).toBe("## Goal\nearlier work".length);
		expect(seen[0]?.state.history[0]?.text).toBe("## Goal\nearlier work");
	});

	it("refuses a span Jev barely shrinks so the route can degrade", async () => {
		await expect(
			generateJevCompaction({ preparation: preparation(), settings, asker: fakeJev(() => 0.95) }),
		).rejects.toMatchObject({ name: "JevCompactionError", kind: "insufficient-reduction" });
	});

	it("classifies transport failures and aborts", async () => {
		const failing: JevAsker = {
			ask: async () => {
				throw new Error("Jev request failed (500): boom");
			},
		};
		await expect(
			generateJevCompaction({ preparation: preparation(), settings, asker: failing }),
		).rejects.toMatchObject({ kind: "transport" });

		const controller = new AbortController();
		controller.abort();
		await expect(
			generateJevCompaction({
				preparation: preparation(),
				settings,
				asker: fakeJev(() => 0),
				signal: controller.signal,
			}),
		).rejects.toBeInstanceOf(JevCompactionError);
	});
});

describe("jev settings and client", () => {
	it("resolves the key from settings, then the stored key, then TYPESAFE_API_KEY", () => {
		// 1. configured value wins (literal or env reference)
		expect(resolveJevApiKey("literal", {}, "stored")).toBe("literal");
		expect(resolveJevApiKey("$MY_KEY", { MY_KEY: "from-env" }, "stored")).toBe("from-env");
		expect(resolveJevApiKey("$" + "{MY_KEY}", { MY_KEY: "braced" })).toBe("braced");
		// 2. a configured env reference to an unset var falls through to stored, then default
		expect(resolveJevApiKey("$MISSING", {}, "stored")).toBe("stored");
		expect(resolveJevApiKey("$MISSING", { TYPESAFE_API_KEY: "default" })).toBe("default");
		// 3. no configured value: stored beats the env var
		expect(resolveJevApiKey(undefined, { TYPESAFE_API_KEY: "default" }, "stored")).toBe("stored");
		expect(resolveJevApiKey(undefined, { TYPESAFE_API_KEY: "default" })).toBe("default");
		expect(resolveJevApiKey(undefined, {})).toBeUndefined();
	});

	it("reads and stores the Jev key through a credential store", () => {
		const data = new Map<string, { type: "api_key"; key: string }>();
		const store = {
			get: (provider: string) => data.get(provider),
			set: (provider: string, credential: { type: "api_key"; key: string }) => void data.set(provider, credential),
			remove: (provider: string) => void data.delete(provider),
		};
		expect(readStoredJevKey(store)).toBeUndefined();
		storeJevKey(store, "sk-jev-123");
		expect(data.get(JEV_CREDENTIAL_PROVIDER)).toEqual({ type: "api_key", key: "sk-jev-123" });
		expect(readStoredJevKey(store)).toBe("sk-jev-123");
		// a second store replaces rather than stacks
		storeJevKey(store, "sk-jev-456");
		expect(readStoredJevKey(store)).toBe("sk-jev-456");
		expect(resolveJevCompactionSettings(undefined, {}, readStoredJevKey(store))).toMatchObject({
			enabled: true,
			apiKey: "sk-jev-456",
		});
	});

	it("is enabled exactly when a key resolves unless overridden", () => {
		expect(resolveJevCompactionSettings(undefined, {}).enabled).toBe(false);
		expect(resolveJevCompactionSettings(undefined, { TYPESAFE_API_KEY: "k" }).enabled).toBe(true);
		expect(resolveJevCompactionSettings({ enabled: false }, { TYPESAFE_API_KEY: "k" }).enabled).toBe(false);
		expect(resolveJevCompactionSettings({ enabled: true }, {})).toMatchObject({ enabled: true, apiKey: undefined });
		expect(
			resolveJevCompactionSettings({ keepThreshold: 0.3, truncateHeadChars: 10.7, timeoutMs: -1 }, {}),
		).toMatchObject({
			keepThreshold: 0.3,
			truncateHeadChars: 10,
			timeoutMs: 1,
			model: "jev-latest",
			minReductionRatio: 0.1,
		});
	});

	it("builds a System One request and validates responses", () => {
		const request = buildJevRequest(
			{ apiKey: "k" },
			{ context: "c", goal: "g", history: [] },
			{
				q: { type: "noul", instructions: "x" },
			},
		);
		expect(request.url).toBe("https://api.typesafe.ai/v1/systemone");
		expect(request.headers.authorization).toBe("Bearer k");
		expect(JSON.parse(request.body)).toEqual({
			model: "jev-latest",
			state: { context: "c", goal: "g", history: [] },
			questions: { q: { type: "noul", instructions: "x" } },
		});
		expect(() => parseJevResponse(500, false, "boom")).toThrow(/500/);
		expect(() => parseJevResponse(200, true, "not json")).toThrow(/malformed/);
		expect(() => parseJevResponse(200, true, "{}")).toThrow(/missing answers/);
		expect(parseJevResponse(200, true, '{"answers":{}}')).toEqual({ answers: {} });
	});
});

/**
 * Jev compaction replaces the LLM summarizer on every senpi-owned route:
 *
 *  - speculative/warm: `agent_end` idle warm-up applies a Jev result;
 *  - blocking: `before_agent_start` at the hard limit generates through Jev;
 *  - core-route: `session_before_compact` (manual `/compact`, threshold,
 *    overflow) returns a Jev `CompactionResult`.
 *
 * The faux provider's call count is the oracle: with Jev enabled the LLM
 * summarizer must never be asked. Failures degrade exactly like a failed
 * summarization (deterministic fallback on required routes, `cancel` with a
 * reason otherwise).
 */
import { type FauxProviderRegistration, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { CompactionPreparation } from "../../src/core/compaction/index.ts";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "../../src/core/compaction/index.ts";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import { JEV_SUMMARY_SCHEMA } from "../../src/core/extensions/builtin/compaction/jev/generator.ts";
import type { JevCompactionSettings } from "../../src/core/extensions/builtin/compaction/jev/settings.ts";
import type {
	JevAsker,
	JevCompactionState,
	JevQuestions,
} from "../../src/core/extensions/builtin/compaction/jev/types.ts";
import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "../../src/core/extensions/index.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const registrations: FauxProviderRegistration[] = [];
afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

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

type JevLoginHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;

interface FakeCredentialStore {
	get(provider: string): { type: string; key?: string } | undefined;
	set(provider: string, credential: { type: "api_key"; key: string }): void;
	remove(provider: string): void;
	snapshot(): Map<string, { type: string; key?: string }>;
}

function fakeCredentialStore(seed?: { provider: string; key: string }): FakeCredentialStore {
	const data = new Map<string, { type: string; key?: string }>();
	if (seed) data.set(seed.provider, { type: "api_key", key: seed.key });
	return {
		get: (provider) => data.get(provider),
		set: (provider, credential) => void data.set(provider, credential),
		remove: (provider) => void data.delete(provider),
		snapshot: () => new Map(data),
	};
}

interface Harness {
	agentEnd: (event: AgentEndEvent, ctx: ExtensionContext) => Promise<void> | void;
	beforeAgentStart: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => Promise<unknown> | unknown;
	sessionBeforeCompact: (
		event: SessionBeforeCompactEvent,
		ctx: ExtensionContext,
	) => Promise<{ cancel?: boolean; reason?: string; compaction?: { summary: string; details?: unknown } } | undefined>;
	jevLogin?: JevLoginHandler;
	registration: FauxProviderRegistration;
	ctx: ExtensionContext;
	sessionManager: SessionManager;
	applyCompaction: ReturnType<typeof vi.fn>;
	seen: Seen[];
	settings: typeof DEFAULT_COMPACTION_SETTINGS;
	credentialStore: FakeCredentialStore;
}

const fileA = "export const a = 1;\n".repeat(400);
const fileB = "export const b = 2;\n".repeat(400);

function seedSession(sessionManager: SessionManager, model: { api: string; provider: string; id: string }): void {
	const now = Date.now();
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "Never edit src/generated. Fix the failing test." }],
		timestamp: now - 9000,
	});
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "toolUse",
		timestamp: now - 8000,
	} as never);
	sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: fileA }],
		isError: false,
		timestamp: now - 7000,
	});
	sessionManager.appendMessage({
		role: "assistant",
		content: [
			{ type: "text", text: "a.ts is fine; checking b.ts" },
			{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "src/b.ts" } },
		],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "toolUse",
		timestamp: now - 6000,
	} as never);
	sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "call-2",
		toolName: "read",
		content: [{ type: "text", text: fileB }],
		isError: false,
		timestamp: now - 5000,
	});
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "call-3", name: "bash", arguments: { command: "npm test" } }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "toolUse",
		timestamp: now - 4000,
	} as never);
	sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "call-3",
		toolName: "bash",
		content: [{ type: "text", text: "FAIL b.test.ts: expected 2 to be 3" }],
		isError: true,
		timestamp: now - 3000,
	});
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "second user ".repeat(2000) }],
		timestamp: now - 2000,
	});
	sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "keep" }], timestamp: now });
}

function createHarness(options: {
	answer?: (name: string) => number;
	asker?: JevAsker;
	jev?: JevCompactionSettings;
	env?: NodeJS.ProcessEnv;
	usageTokens?: number;
	credentialStore?: FakeCredentialStore;
}): Harness {
	const registration = registerFauxProvider();
	registrations.push(registration);
	const model = registration.getModel();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: registration.api,
		models: registration.models.map((registeredModel) => ({
			id: registeredModel.id,
			name: registeredModel.name,
			api: registeredModel.api,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
			baseUrl: registeredModel.baseUrl,
		})),
	});

	const sessionManager = SessionManager.inMemory();
	seedSession(sessionManager, model);

	const seen: Seen[] = [];
	const asker = options.asker ?? fakeJev(options.answer ?? (() => 0.1), seen);
	const credentialStore = options.credentialStore ?? fakeCredentialStore();

	let agentEnd: Harness["agentEnd"] | undefined;
	let beforeAgentStart: Harness["beforeAgentStart"] | undefined;
	let sessionBeforeCompact: Harness["sessionBeforeCompact"] | undefined;
	let jevLogin: JevLoginHandler | undefined;
	const api = Object.assign(Object.create(null), {
		on: (event: string, handler: unknown) => {
			if (event === "agent_end") agentEnd = handler as Harness["agentEnd"];
			if (event === "before_agent_start") beforeAgentStart = handler as Harness["beforeAgentStart"];
			if (event === "session_before_compact") sessionBeforeCompact = handler as Harness["sessionBeforeCompact"];
		},
		registerCommand: (name: string, opts: { handler: JevLoginHandler }) => {
			if (name === "jev-login") jevLogin = opts.handler;
		},
		appendEntry: vi.fn(),
		getActiveTools: () => [],
		getAllTools: () => [],
		getThinkingLevel: () => "off" as const,
		events: { emit: vi.fn() },
		sendMessage: vi.fn(),
	}) as ExtensionAPI;
	compactionExtension(api, {
		jevAsker: asker,
		jevEnv: options.env ?? { TYPESAFE_API_KEY: "test-key" },
		jevCredentialStore: credentialStore,
	});
	if (!agentEnd) throw new Error("agent_end handler was not registered");
	if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered");
	if (!sessionBeforeCompact) throw new Error("session_before_compact handler was not registered");

	const applyCompaction = vi.fn(async () => ({ applied: true as const, reason: "ok" as const }));
	const contextWindow = 100_000;
	const settings: Harness["settings"] = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 };
	if (options.jev !== undefined) settings.jev = options.jev;
	const ctx = {
		hasUI: false,
		mode: "tui",
		ui: Object.assign(Object.create(null), { notify: vi.fn(), input: vi.fn(async () => undefined) }),
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		sessionManager,
		modelRegistry,
		model,
		serviceTier: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => ({ tokens: options.usageTokens ?? 80_000, contextWindow, percent: 80 }),
		getCompactionSettings: () => settings,
		compact: vi.fn(),
		getMessageRevision: () => 1,
		applyCompaction,
		beginCompaction: vi.fn(() => undefined),
		endCompaction: vi.fn(),
		updateCompaction: vi.fn(),
		getSystemPrompt: () => "TEST AGENT SYSTEM PROMPT",
	} as unknown as ExtensionContext;

	return {
		agentEnd,
		beforeAgentStart,
		sessionBeforeCompact,
		jevLogin,
		registration,
		ctx,
		sessionManager,
		applyCompaction,
		seen,
		settings,
		credentialStore,
	};
}

async function settle(): Promise<void> {
	for (let tick = 0; tick < 12; tick++) await new Promise((resolve) => setImmediate(resolve));
}

function preparationFor(harness: Harness): CompactionPreparation {
	const preparation = prepareCompaction(harness.sessionManager.getBranch(), harness.settings);
	if (!preparation) throw new Error("session too small to prepare compaction");
	return preparation;
}

function beforeCompactEvent(harness: Harness, reason: SessionBeforeCompactEvent["reason"]): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		reason,
		willRetry: false,
		requestId: `req-${reason}`,
		preparation: preparationFor(harness),
		branchEntries: harness.sessionManager.getBranch(),
		signal: new AbortController().signal,
	};
}

describe("jev compaction routes", () => {
	it("core-route: session_before_compact returns a Jev result and never asks the LLM", async () => {
		const harness = createHarness({ answer: (name) => (name.endsWith("_t3") ? 0.9 : 0.1) });

		const result = await harness.sessionBeforeCompact(beforeCompactEvent(harness, "manual"), harness.ctx);

		expect(harness.registration.state.callCount).toBe(0);
		expect(harness.seen).toHaveLength(1);
		expect(result?.cancel).toBeUndefined();
		expect(result?.compaction?.summary).toContain("[User]: Never edit src/generated. Fix the failing test.");
		expect(result?.compaction?.summary).toContain("[Tool result (error)]: FAIL b.test.ts: expected 2 to be 3");
		expect(result?.compaction?.summary).not.toContain("export const a = 1;");
		expect(result?.compaction?.details).toMatchObject({
			schema: JEV_SUMMARY_SCHEMA,
			origin: "core-route",
			stats: { calls: 3, kept: 1, callsDropped: 2 },
		});
	});

	it("speculative/warm: the idle warm-up generates through Jev and applies it", async () => {
		const harness = createHarness({});

		await harness.agentEnd({ type: "agent_end", messages: [] }, harness.ctx);
		await settle();

		expect(harness.registration.state.callCount).toBe(0);
		expect(harness.seen).toHaveLength(1);
		expect(harness.applyCompaction).toHaveBeenCalledTimes(1);
		const [precomputed, applyOptions] = harness.applyCompaction.mock.calls[0] as [
			{ summary: string; details?: { schema?: string; origin?: string } },
			{ reason: string },
		];
		expect(precomputed.details).toMatchObject({ schema: JEV_SUMMARY_SCHEMA, origin: "speculative" });
		expect(precomputed.summary).not.toContain("export const b = 2;");
		expect(applyOptions.reason).toBe("extension");
	});

	it("blocking: before_agent_start at the hard limit generates through Jev", async () => {
		const harness = createHarness({ usageTokens: 99_000 });

		await harness.beforeAgentStart(
			{
				type: "before_agent_start",
				prompt: "next prompt",
				systemPrompt: "TEST AGENT SYSTEM PROMPT",
				systemPromptOptions: { cwd: process.cwd() },
			},
			harness.ctx,
		);
		await settle();

		expect(harness.registration.state.callCount).toBe(0);
		expect(harness.seen.length).toBeGreaterThanOrEqual(1);
		expect(harness.applyCompaction).toHaveBeenCalled();
		const [precomputed] = harness.applyCompaction.mock.calls[0] as [{ details?: { schema?: string } }];
		expect(precomputed.details).toMatchObject({ schema: JEV_SUMMARY_SCHEMA });
	});

	it("falls back to the LLM summarizer when Jev is disabled in settings", async () => {
		const harness = createHarness({ jev: { enabled: false } });
		harness.registration.setResponses([
			() => ({ role: "assistant", content: [{ type: "text", text: "llm summary" }] }) as never,
		]);

		const result = await harness.sessionBeforeCompact(beforeCompactEvent(harness, "manual"), harness.ctx);

		expect(harness.seen).toHaveLength(0);
		expect(harness.registration.state.callCount).toBe(1);
		expect(result?.compaction?.summary).toContain("llm summary");
	});

	it("stays on the LLM summarizer when no Jev key resolves anywhere", async () => {
		const harness = createHarness({ env: {}, credentialStore: fakeCredentialStore() });
		harness.registration.setResponses([
			() => ({ role: "assistant", content: [{ type: "text", text: "llm summary" }] }) as never,
		]);

		await harness.sessionBeforeCompact(beforeCompactEvent(harness, "manual"), harness.ctx);

		expect(harness.seen).toHaveLength(0);
		expect(harness.registration.state.callCount).toBe(1);
	});

	it("routes through Jev on a stored credential when the env var is unset", async () => {
		const harness = createHarness({
			env: {},
			credentialStore: fakeCredentialStore({ provider: "typesafe", key: "stored-jev-key" }),
			answer: (name) => (name.endsWith("_t3") ? 0.9 : 0.1),
		});

		const result = await harness.sessionBeforeCompact(beforeCompactEvent(harness, "manual"), harness.ctx);

		expect(harness.registration.state.callCount).toBe(0);
		expect(harness.seen).toHaveLength(1);
		expect(result?.compaction?.details).toMatchObject({ schema: JEV_SUMMARY_SCHEMA });
	});

	it("/jev-login stores the key and activates the route", async () => {
		const store = fakeCredentialStore();
		const harness = createHarness({
			env: {},
			credentialStore: store,
			answer: (name) => (name.endsWith("_t3") ? 0.9 : 0.1),
		});
		if (!harness.jevLogin) throw new Error("jev-login command was not registered");

		// Before login: no key, LLM summarizer runs.
		harness.registration.setResponses([
			() => ({ role: "assistant", content: [{ type: "text", text: "llm summary" }] }) as never,
		]);
		await harness.sessionBeforeCompact(beforeCompactEvent(harness, "manual"), harness.ctx);
		expect(harness.seen).toHaveLength(0);
		expect(harness.registration.state.callCount).toBe(1);

		// Log in with an inline key; it is written to the store, never echoed.
		const notify = harness.ctx.ui.notify as ReturnType<typeof vi.fn>;
		await harness.jevLogin("sk-inline-jev", harness.ctx);
		expect(store.snapshot().get("typesafe")).toEqual({ type: "api_key", key: "sk-inline-jev" });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Jev compaction is active"), "info");
		expect(notify.mock.calls.every(([message]) => !String(message).includes("sk-inline-jev"))).toBe(true);

		// After login: the same route now goes through Jev.
		const result = await harness.sessionBeforeCompact(beforeCompactEvent(harness, "manual"), harness.ctx);
		expect(harness.seen).toHaveLength(1);
		expect(result?.compaction?.details).toMatchObject({ schema: JEV_SUMMARY_SCHEMA });
	});

	it("/jev-login prompts for the key when none is given inline", async () => {
		const store = fakeCredentialStore();
		const harness = createHarness({ env: {}, credentialStore: store });
		if (!harness.jevLogin) throw new Error("jev-login command was not registered");
		(harness.ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("  sk-prompted  ");

		await harness.jevLogin("", harness.ctx);

		expect(store.snapshot().get("typesafe")).toEqual({ type: "api_key", key: "sk-prompted" });
	});

	it("degrades like a failed summarization: transport failure cancels with a reason", async () => {
		const failing: JevAsker = {
			ask: async () => {
				throw new Error("Jev request failed (503): overloaded");
			},
		};
		const harness = createHarness({ asker: failing });

		const result = await harness.sessionBeforeCompact(beforeCompactEvent(harness, "manual"), harness.ctx);

		expect(harness.registration.state.callCount).toBe(0);
		expect(result).toMatchObject({ cancel: true });
		expect(result?.reason).toMatch(/Jev compaction request failed/);
	});

	it("degrades deterministically on a required route when Jev cannot shrink the span", async () => {
		const harness = createHarness({ answer: () => 0.95 });

		const result = await harness.sessionBeforeCompact(beforeCompactEvent(harness, "overflow"), harness.ctx);

		expect(harness.registration.state.callCount).toBe(0);
		// Required routes recover through the deterministic fallback instead of cancelling.
		expect(result?.compaction).toBeDefined();
		expect(result?.compaction?.details).toMatchObject({ schema: "senpi.compaction.deterministic-fallback.v1" });
	});
});

/**
 * Jev compaction: ask Jev about every candidate tool call and decide what stays.
 *
 * For every non-pinned call Jev answers two `noul` questions: should the call
 * stay (knowing it was made still matters) and should the result stay verbatim
 * (its contents are still needed and re-running the tool would not do). The
 * decision per call, against `keepThreshold`: keep both, keep the call and
 * truncate the result, or drop both.
 */
import { collectJevToolCalls, estimateJevTokens, fitJevState } from "./state.ts";
import type {
	JevAsker,
	JevCallAnswer,
	JevCallDecision,
	JevCompactionState,
	JevCompactOptions,
	JevQuestions,
	JevResolvedCompactOptions,
	JevToolCall,
	JevTranscriptMessage,
} from "./types.ts";

export const JEV_DEFAULT_OPTIONS: JevResolvedCompactOptions = {
	goal: "",
	keepThreshold: 0.5,
	preserveRecentMessages: 0,
	maxStateTokens: 25_000,
	maxRequestTokens: 30_000,
	truncateHeadChars: 300,
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

function finite(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function resolveJevOptions(options: JevCompactOptions = {}): JevResolvedCompactOptions {
	return {
		goal: options.goal ?? JEV_DEFAULT_OPTIONS.goal,
		keepThreshold: finite(options.keepThreshold, JEV_DEFAULT_OPTIONS.keepThreshold),
		preserveRecentMessages: Math.max(
			0,
			Math.floor(finite(options.preserveRecentMessages, JEV_DEFAULT_OPTIONS.preserveRecentMessages)),
		),
		maxStateTokens: Math.max(1, finite(options.maxStateTokens, JEV_DEFAULT_OPTIONS.maxStateTokens)),
		maxRequestTokens: Math.max(1, finite(options.maxRequestTokens, JEV_DEFAULT_OPTIONS.maxRequestTokens)),
		truncateHeadChars: Math.max(
			0,
			Math.floor(finite(options.truncateHeadChars, JEV_DEFAULT_OPTIONS.truncateHeadChars)),
		),
	};
}

/** The two `noul` questions asked about one call: keep the call, keep its result. */
export function questionsFor(call: JevToolCall): JevQuestions {
	return {
		[`call_${call.id}`]: {
			type: "noul",
			instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
		},
		[`result_${call.id}`]: {
			type: "noul",
			instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
		},
	};
}

/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export function batchJevCalls(
	calls: readonly JevToolCall[],
	stateTokens: number,
	options: Pick<JevResolvedCompactOptions, "maxRequestTokens">,
): JevToolCall[][] {
	const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
	const batches: JevToolCall[][] = [];
	let current: JevToolCall[] = [];
	let currentTokens = 0;
	for (const call of calls) {
		const tokens = estimateJevTokens(JSON.stringify(questionsFor(call)));
		if (current.length > 0 && currentTokens + tokens > budget) {
			batches.push(current);
			current = [];
			currentTokens = 0;
		}
		if (current.length === 0 && tokens > budget) {
			throw new Error(`state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`);
		}
		current.push(call);
		currentTokens += tokens;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

export function decideJevCall(
	call: Pick<JevToolCall, "id" | "toolCallId" | "tool" | "pinned">,
	answer: JevCallAnswer,
	options: Pick<JevResolvedCompactOptions, "keepThreshold">,
): JevCallDecision {
	const base = { id: call.id, toolCallId: call.toolCallId, tool: call.tool, ...answer };
	if (call.pinned) return { ...base, action: "keep", reason: "pinned" };
	if (answer.keepResult >= options.keepThreshold) return { ...base, action: "keep", reason: "kept" };
	if (answer.keepCall >= options.keepThreshold) return { ...base, action: "drop_result", reason: "result_dropped" };
	return { ...base, action: "drop_call", reason: "call_dropped" };
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(answers: Record<string, unknown>, name: string): number {
	const answer = answers[name];
	if (
		!answer ||
		typeof answer !== "object" ||
		!("noul" in answer) ||
		typeof answer.noul !== "number" ||
		!Number.isFinite(answer.noul)
	) {
		throw new Error(`Invalid Jev answer for ${name}`);
	}
	return answer.noul;
}

async function askBatch(
	asker: JevAsker,
	state: JevCompactionState,
	batch: readonly JevToolCall[],
	signal?: AbortSignal,
): Promise<Map<string, JevCallAnswer>> {
	const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
	const { answers } = await asker.ask(state, questions, signal);
	return new Map(
		batch.map((call) => [
			call.id,
			{
				keepCall: noulAnswer(answers, `call_${call.id}`),
				keepResult: noulAnswer(answers, `result_${call.id}`),
			},
		]),
	);
}

export interface JevDecisionRun {
	calls: JevToolCall[];
	decisions: JevCallDecision[];
	stateTokens: number;
	/** Which fitting stage the state needed, '' when no request was made. */
	stateStage: string;
	requests: number;
}

/**
 * Scores every candidate call in the transcript. The whole transcript (results
 * omitted, fitted into `maxStateTokens`) is sent as state with every batch of
 * questions; batches run concurrently and their answers are merged. Throws
 * when Jev fails, an answer is malformed, or the state cannot be fitted.
 */
export async function decideJevTranscript(
	messages: readonly JevTranscriptMessage[],
	asker: JevAsker,
	options: JevResolvedCompactOptions,
	signal?: AbortSignal,
): Promise<JevDecisionRun> {
	const calls = collectJevToolCalls(messages, options.preserveRecentMessages);
	const candidates = calls.filter((call) => !call.pinned);
	const answers = new Map<string, JevCallAnswer>();
	let stateTokens = 0;
	let stateStage = "";
	let requests = 0;
	if (candidates.length > 0) {
		const fitted = fitJevState(messages, calls, options);
		stateTokens = fitted.tokens;
		stateStage = fitted.stage;
		const batches = batchJevCalls(candidates, fitted.tokens, options);
		requests = batches.length;
		const answered = await Promise.all(batches.map((batch) => askBatch(asker, fitted.state, batch, signal)));
		for (const map of answered) for (const [id, answer] of map) answers.set(id, answer);
	}
	const decisions = calls.map((call) =>
		decideJevCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, options),
	);
	return { calls, decisions, stateTokens, stateStage, requests };
}

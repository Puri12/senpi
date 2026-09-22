/**
 * Jev compaction: shared types.
 *
 * Ported from `fast-jev-compaction` (MIT) and adapted to senpi's `AgentMessage`
 * shape. The library scores every tool call/result with TypeSafe's Jev model in
 * one request, then keeps, truncates, or drops them; kept content stays verbatim
 * and user/assistant text is never rewritten.
 */

/** A tool call paired with its result, addressed by senpi's `toolCallId`. */
export interface JevToolCall {
	/** Short id used in the Jev state and question names (`t1`, `t2`, ...). */
	id: string;
	toolCallId: string;
	tool: string;
	input: Record<string, unknown>;
	/** Index of the message holding the tool call block. */
	callIndex: number;
	/** Index of the `toolResult` message. */
	resultIndex: number;
	resultChars: number;
	isError: boolean;
	/** In the first message or the newest preserved messages; never a candidate. */
	pinned: boolean;
}

export interface JevCallAnswer {
	/** Jev's probability that the call itself still matters. */
	keepCall: number;
	/** Jev's probability that the full result still needs to stay verbatim. */
	keepResult: number;
}

export type JevCallAction = "keep" | "drop_result" | "drop_call";

export interface JevCallDecision extends JevCallAnswer {
	id: string;
	toolCallId: string;
	tool: string;
	action: JevCallAction;
	reason: "pinned" | "kept" | "result_dropped" | "call_dropped";
}

export interface JevHistoryToolCall {
	id: string;
	tool: string;
	input: string;
	result: string;
}

export interface JevHistoryEntry {
	i: number;
	role: "user" | "assistant";
	text: string;
	/** Structured per call, or one compact line per call once the state has to shrink. */
	tool_calls?: JevHistoryToolCall[] | string[];
}

/** The state sent with every Jev request: the whole history, results omitted. */
export interface JevCompactionState {
	context: string;
	goal: string;
	history: JevHistoryEntry[];
}

export interface JevFittedState {
	state: JevCompactionState;
	tokens: number;
	/** Which fitting stage produced the state, for diagnostics. */
	stage: string;
}

export interface JevCompactOptions {
	/** Ongoing task description; defaults to the last few user prompts. */
	goal?: string;
	/** Minimum keep probability for a call or result to stay. Default 0.5. */
	keepThreshold?: number;
	/** Newest messages never touched (the first message is always kept). Default 0 for compaction. */
	preserveRecentMessages?: number;
	/** Estimated token ceiling for the state. Default 25000. */
	maxStateTokens?: number;
	/** Estimated token ceiling for state plus one batch of questions. Default 30000. */
	maxRequestTokens?: number;
	/** Characters of a dropped tool result to retain. Default 300. */
	truncateHeadChars?: number;
}

export interface JevResolvedCompactOptions {
	goal: string;
	keepThreshold: number;
	preserveRecentMessages: number;
	maxStateTokens: number;
	maxRequestTokens: number;
	truncateHeadChars: number;
}

export interface JevNoulQuestion {
	type: "noul";
	instructions: string;
}

export type JevQuestions = Record<string, JevNoulQuestion>;

export interface JevNoulAnswer {
	type?: "noul";
	noul: number;
}

export interface JevResponse {
	model?: string;
	answers: Record<string, JevNoulAnswer | Record<string, unknown>>;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
	};
	[key: string]: unknown;
}

/** Anything that can answer Jev questions: the HTTP client, or a test fake. */
export interface JevAsker {
	ask(state: JevCompactionState, questions: JevQuestions, signal?: AbortSignal): Promise<JevResponse>;
}

/** The transcript shape the Jev pipeline scores: one entry per senpi message. */
export interface JevTranscriptToolUse {
	toolCallId: string;
	tool: string;
	input: Record<string, unknown>;
}

export interface JevTranscriptToolResult {
	toolCallId: string;
	tool: string;
	text: string;
	isError: boolean;
}

export interface JevTranscriptMessage {
	role: "user" | "assistant";
	text: string;
	toolUses: JevTranscriptToolUse[];
	toolResults?: JevTranscriptToolResult[];
	/** Never a candidate: summaries, custom/context messages, image-bearing results. */
	pinned?: boolean;
}

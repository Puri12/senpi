/**
 * Jev compaction: build and fit the state sent with every Jev request.
 *
 * The state is the whole transcript being compacted, oldest first, with every
 * tool result replaced by a short note. It is shrunk in named stages until it
 * fits `maxStateTokens`; nothing is summarized, only truncated or left out.
 */
import type {
	JevCompactionState,
	JevFittedState,
	JevHistoryEntry,
	JevResolvedCompactOptions,
	JevToolCall,
	JevTranscriptMessage,
} from "./types.ts";

export const JEV_STATE_CONTEXT =
	"A coding assistant conversation is being compacted to free context. `history` is the whole conversation so far, oldest first; tool outputs are replaced by a short `result` note and long texts may be abridged. Each question asks whether one tool call, or the full output of that call, still needs to stay in the history verbatim. Whatever is not kept is deleted permanently, but the assistant can always re-run a tool or re-read a file.";

/** Successive caps on the serialised tool input included per call. */
const INPUT_CHARS = [1000, 200, 60] as const;
const TEXT_HEAD = 400;
const TEXT_TAIL = 150;

const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;

/**
 * Estimates tokens without a tokenizer: a word costs one token per six
 * letters, a digit half a token, any other symbol nine tenths. Calibrated
 * against the usage Jev reports for real transcripts, where it lands 2–18%
 * above the true count; a plain characters-per-token ratio undercounts the
 * JSON-heavy states by up to 40%.
 */
export function estimateJevTokens(text: string): number {
	let tokens = 0;
	for (const [piece] of text.matchAll(TOKEN_PIECES)) {
		const first = piece.charCodeAt(0);
		if (first >= 48 && first <= 57) tokens += piece.length / 2;
		else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
			tokens += 1 + Math.floor((piece.length - 1) / 6);
		} else tokens += 0.9;
	}
	return Math.ceil(tokens);
}

export function truncateText(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function abridge(text: string, head: number, tail: number): string {
	if (text.length <= head + tail + 40) return text;
	const omitted = text.length - head - tail;
	return `${text.slice(0, head)}\n[… ${omitted} chars omitted …]\n${text.slice(-tail)}`;
}

export function isPinnedIndex(index: number, total: number, preserveRecentMessages: number): boolean {
	return index === 0 || index >= total - preserveRecentMessages;
}

/**
 * Pairs every tool call with its result by `toolCallId`. Calls without a
 * result are not candidates (there is nothing to drop yet).
 */
export function collectJevToolCalls(
	messages: readonly JevTranscriptMessage[],
	preserveRecentMessages: number,
): JevToolCall[] {
	const results = new Map<string, { index: number; chars: number; isError: boolean; pinned: boolean }>();
	messages.forEach((message, index) => {
		for (const result of message.toolResults ?? []) {
			results.set(result.toolCallId, {
				index,
				chars: result.text.length,
				isError: result.isError,
				pinned: message.pinned === true,
			});
		}
	});
	const calls: JevToolCall[] = [];
	messages.forEach((message, callIndex) => {
		for (const tool of message.toolUses) {
			const found = results.get(tool.toolCallId);
			if (!found) continue;
			calls.push({
				id: `t${calls.length + 1}`,
				toolCallId: tool.toolCallId,
				tool: tool.tool,
				input: tool.input,
				callIndex,
				resultIndex: found.index,
				resultChars: found.chars,
				isError: found.isError,
				pinned:
					message.pinned === true ||
					found.pinned ||
					isPinnedIndex(callIndex, messages.length, preserveRecentMessages) ||
					isPinnedIndex(found.index, messages.length, preserveRecentMessages),
			});
		}
	});
	return calls;
}

function inputText(input: Record<string, unknown>, limit: number): string {
	let json = "";
	try {
		json = JSON.stringify(input);
	} catch {
		json = "[unserializable input]";
	}
	return truncateText(json, limit);
}

function resultNote(call: JevToolCall): string {
	return `${call.isError ? "error" : "ok"}, ${call.resultChars} chars (omitted)`;
}

/** One call as a single line, for when the structured form is too costly. */
function compactCall(call: JevToolCall): string {
	const input = Object.entries(call.input)
		.map(([key, value]) => {
			const text = typeof value === "string" ? value : inputText({ [key]: value }, 200);
			return `${key}=${text.replace(/\s+/g, " ")}`;
		})
		.join(" ");
	return `${call.id} ${call.tool} ${truncateText(input, INPUT_CHARS[2])} → ${call.isError ? "error" : "ok"} ${call.resultChars}ch`;
}

/**
 * Folds runs of adjacent call-only entries into one entry each, so the
 * per-entry envelope is paid once per run; the call lines keep their ids.
 */
function mergeCallRuns(
	history: readonly JevHistoryEntry[],
	pinned: (e: JevHistoryEntry) => boolean,
): JevHistoryEntry[] {
	const merged: JevHistoryEntry[] = [];
	const foldable = (e: JevHistoryEntry): boolean =>
		!pinned(e) && e.text.length === 0 && typeof e.tool_calls?.[0] === "string";
	for (const entry of history) {
		const previous = merged[merged.length - 1];
		if (previous && foldable(previous) && foldable(entry) && previous.role === entry.role) {
			previous.tool_calls = [...(previous.tool_calls as string[]), ...(entry.tool_calls as string[])];
			continue;
		}
		merged.push({ ...entry });
	}
	return merged;
}

function callsByMessage(calls: readonly JevToolCall[]): Map<number, JevToolCall[]> {
	const byMessage = new Map<number, JevToolCall[]>();
	for (const call of calls) {
		const list = byMessage.get(call.callIndex) ?? [];
		list.push(call);
		byMessage.set(call.callIndex, list);
	}
	return byMessage;
}

function historyEntries(
	messages: readonly JevTranscriptMessage[],
	calls: readonly JevToolCall[],
	inputChars: number,
): JevHistoryEntry[] {
	const byMessage = callsByMessage(calls);
	const entries: JevHistoryEntry[] = [];
	messages.forEach((message, i) => {
		const toolCalls = (byMessage.get(i) ?? []).map((call) => ({
			id: call.id,
			tool: call.tool,
			input: inputText(call.input, inputChars),
			result: resultNote(call),
		}));
		if (message.text.trim().length === 0 && toolCalls.length === 0) return;
		const entry: JevHistoryEntry = { i, role: message.role, text: message.text };
		if (toolCalls.length > 0) entry.tool_calls = toolCalls;
		entries.push(entry);
	});
	return entries;
}

/** The last three user prompts, as the default `goal`. */
export function goalFromTranscript(messages: readonly JevTranscriptMessage[]): string {
	return messages
		.filter(
			(message) =>
				message.role === "user" && message.text.trim().length > 0 && (message.toolResults ?? []).length === 0,
		)
		.slice(-3)
		.map((message) => truncateText(message.text, 500))
		.join("\n");
}

/**
 * Builds the Jev state from the whole transcript and shrinks it in stages
 * until it fits `maxStateTokens`: tool inputs are truncated, then long texts
 * are abridged oldest-first (pinned messages last), then old messages collapse
 * to a one-line note, then old tool calls shrink to one line each, then old
 * messages that carry no call are left out, then runs of old call-only
 * messages are folded into one entry. Throws when even that is too big.
 */
export function fitJevState(
	messages: readonly JevTranscriptMessage[],
	calls: readonly JevToolCall[],
	options: Pick<JevResolvedCompactOptions, "maxStateTokens" | "preserveRecentMessages" | "goal">,
): JevFittedState {
	const goal = options.goal || goalFromTranscript(messages);
	const stateOf = (history: JevHistoryEntry[]): JevCompactionState => ({
		context: JEV_STATE_CONTEXT,
		goal,
		history,
	});
	const entryTokens = (entry: JevHistoryEntry): number => estimateJevTokens(JSON.stringify(entry)) + 1;
	const baseTokens = estimateJevTokens(JSON.stringify(stateOf([])));
	const fitted = (history: JevHistoryEntry[], tokens: number, stage: string): JevFittedState => ({
		state: stateOf(history),
		tokens,
		stage,
	});

	let history: JevHistoryEntry[] = [];
	let perEntry: number[] = [];
	let tokens = 0;
	const rebuild = (inputChars: number): void => {
		history = historyEntries(messages, calls, inputChars);
		perEntry = history.map(entryTokens);
		tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0);
	};
	const fits = (): boolean => tokens <= options.maxStateTokens;
	const shrink = (index: number, change: (entry: JevHistoryEntry) => void): void => {
		const entry = history[index];
		if (!entry) return;
		change(entry);
		const now = entryTokens(entry);
		tokens += now - (perEntry[index] ?? 0);
		perEntry[index] = now;
	};

	rebuild(INPUT_CHARS[0]);
	if (fits()) return fitted(history, tokens, "full");

	for (const limit of INPUT_CHARS.slice(1)) {
		rebuild(limit);
		if (fits()) return fitted(history, tokens, `inputs<=${limit}`);
	}

	const pinned = (entry: JevHistoryEntry): boolean =>
		messages[entry.i]?.pinned === true || isPinnedIndex(entry.i, messages.length, options.preserveRecentMessages);
	const indices = history.map((_, index) => index);
	const order = [
		...indices.filter((index) => !pinned(history[index]!)),
		...indices.filter((index) => pinned(history[index]!)),
	];

	for (const index of order) {
		const entry = history[index]!;
		if (entry.text.length <= TEXT_HEAD + TEXT_TAIL + 40) continue;
		shrink(index, (e) => {
			e.text = abridge(e.text, TEXT_HEAD, TEXT_TAIL);
		});
		if (fits()) return fitted(history, tokens, "texts abridged");
	}

	for (const index of order) {
		const entry = history[index]!;
		if (pinned(entry) || entry.text.length === 0) continue;
		const original = messages[entry.i]?.text.length ?? entry.text.length;
		shrink(index, (e) => {
			e.text = `[… ${original} chars omitted …]`;
		});
		if (fits()) return fitted(history, tokens, "old messages collapsed");
	}

	const byMessage = callsByMessage(calls);
	for (const index of order) {
		const entry = history[index]!;
		const own = byMessage.get(entry.i);
		if (pinned(entry) || !own) continue;
		shrink(index, (e) => {
			e.tool_calls = own.map(compactCall);
		});
		if (fits()) return fitted(history, tokens, "old calls compacted");
	}

	const left = new Set<number>();
	for (const index of order) {
		const entry = history[index]!;
		if (pinned(entry) || entry.tool_calls) continue;
		left.add(index);
		tokens -= perEntry[index] ?? 0;
		if (fits()) {
			return fitted(
				history.filter((_, i) => !left.has(i)),
				tokens,
				"old messages left out",
			);
		}
	}

	history = mergeCallRuns(
		history.filter((_, i) => !left.has(i)),
		pinned,
	);
	perEntry = history.map(entryTokens);
	tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0);
	if (fits()) return fitted(history, tokens, "old calls merged");

	throw new Error(`history too large for Jev (~${tokens} tokens after truncation, limit ${options.maxStateTokens})`);
}

/**
 * Jev compaction: senpi `AgentMessage[]` <-> Jev transcript, and the verbatim
 * summary that replaces the summarized span.
 *
 * senpi keeps tool results as their own `toolResult` messages and tool calls as
 * `toolCall` blocks inside assistant messages; the Jev pipeline pairs them by
 * `toolCallId`. Summary, branch, custom, bash and configuration messages are
 * carried through as text and pinned so they can never be dropped. A tool
 * result that carries an image is pinned too: its bytes are not scorable and
 * must not be truncated into a text note.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent, ToolCall } from "@earendil-works/pi-ai";
import { contentTextForSummary } from "../../../../compaction/utils.ts";
import { convertToLlm } from "../../../../messages.ts";
import type { JevCallDecision, JevTranscriptMessage } from "./types.ts";

export const JEV_TRUNCATION_NOTE = "jev-compaction truncated";

function truncatedResultText(text: string, isError: boolean, headChars: number): string {
	if (text.length <= headChars + 120) return text;
	const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : "";
	return `${head}[${JEV_TRUNCATION_NOTE} ${text.length - headChars} chars of this tool result${
		isError ? " (error)" : ""
	}; re-run the tool if needed]`;
}

function hasImageContent(content: string | readonly (TextContent | ImageContent)[]): boolean {
	return typeof content !== "string" && content.some((block) => block.type === "image");
}

function toolCallBlocks(message: Message): ToolCall[] {
	if (message.role !== "assistant") return [];
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

/**
 * Converts the messages of one compaction span into the Jev transcript. Uses
 * `convertToLlm` first so every custom senpi role becomes user/assistant text
 * exactly as the provider would see it; those converted messages are pinned.
 */
export function toJevTranscript(messages: readonly AgentMessage[]): JevTranscriptMessage[] {
	const converted = convertToLlm([...messages]);
	const transcript: JevTranscriptMessage[] = [];
	for (let index = 0; index < converted.length; index++) {
		const llm = converted[index]!;
		const source = messages[index];
		const nativeRole = source?.role === "user" || source?.role === "assistant" || source?.role === "toolResult";
		if (llm.role === "user") {
			transcript.push({
				role: "user",
				text: contentTextForSummary(llm.content, ""),
				toolUses: [],
				pinned: !nativeRole || hasImageContent(llm.content),
			});
			continue;
		}
		if (llm.role === "assistant") {
			transcript.push({
				role: "assistant",
				text: contentTextForSummary(llm.content),
				toolUses: toolCallBlocks(llm).map((block) => ({
					toolCallId: block.id,
					tool: block.name,
					input: block.arguments,
				})),
				pinned: !nativeRole,
			});
			continue;
		}
		if (llm.role === "toolResult") {
			transcript.push({
				role: "user",
				text: "",
				toolUses: [],
				toolResults: [
					{
						toolCallId: llm.toolCallId,
						tool: llm.toolName,
						text: contentTextForSummary(llm.content, ""),
						isError: llm.isError,
					},
				],
				pinned: hasImageContent(llm.content),
			});
			continue;
		}
		if (llm.role === "configurationUpdate") {
			// An effort change, carried as pinned user text.
			transcript.push({
				role: "user",
				text: contentTextForSummary(llm.content, ""),
				toolUses: [],
				pinned: true,
			});
			continue;
		}
		const _exhaustive: never = llm;
		void _exhaustive;
	}
	// convertToLlm may drop context-excluded messages; the transcript index then
	// no longer lines up with `messages`, but every entry is still self-contained.
	return transcript;
}

export interface JevPrunedTranscript {
	messages: JevTranscriptMessage[];
	callsDropped: number;
	resultsDropped: number;
	charsBefore: number;
	charsAfter: number;
}

function transcriptChars(message: JevTranscriptMessage): number {
	let total = message.text.length;
	for (const tool of message.toolUses) {
		try {
			total += JSON.stringify(tool.input).length;
		} catch {
			total += 20;
		}
	}
	for (const result of message.toolResults ?? []) total += result.text.length;
	return total;
}

/**
 * Applies the decisions: a dropped call disappears together with its result;
 * a dropped result keeps a bounded head and a note; messages that lose all
 * their content are removed. Nothing kept is rewritten.
 */
export function applyJevDecisions(
	transcript: readonly JevTranscriptMessage[],
	decisions: readonly JevCallDecision[],
	headChars: number,
): JevPrunedTranscript {
	const actions = new Map<string, JevCallDecision["action"]>();
	for (const decision of decisions) {
		if (decision.action !== "keep") actions.set(decision.toolCallId, decision.action);
	}
	let callsDropped = 0;
	let resultsDropped = 0;
	let charsBefore = 0;
	let charsAfter = 0;
	const kept: JevTranscriptMessage[] = [];
	for (const message of transcript) {
		charsBefore += transcriptChars(message);
		const toolUses = message.toolUses.filter((tool) => {
			if (actions.get(tool.toolCallId) === "drop_call") {
				callsDropped++;
				return false;
			}
			return true;
		});
		const toolResults = (message.toolResults ?? [])
			.filter((result) => actions.get(result.toolCallId) !== "drop_call")
			.map((result) => {
				if (actions.get(result.toolCallId) !== "drop_result") return result;
				const text = truncatedResultText(result.text, result.isError, headChars);
				if (text !== result.text) resultsDropped++;
				return { ...result, text };
			});
		if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) continue;
		const rebuilt: JevTranscriptMessage = { ...message, toolUses };
		if (toolResults.length > 0) rebuilt.toolResults = toolResults;
		else delete rebuilt.toolResults;
		charsAfter += transcriptChars(rebuilt);
		kept.push(rebuilt);
	}
	return { messages: kept, callsDropped, resultsDropped, charsBefore, charsAfter };
}

/**
 * Renders the pruned transcript as the compaction `summary`. The format is the
 * `[User]` / `[Assistant]` / `[Assistant tool calls]` / `[Tool result]` layout
 * senpi already uses for serialized conversations, so the model reads it the
 * way it reads any summarized history; every kept line is the original text.
 */
export function renderJevSummary(transcript: readonly JevTranscriptMessage[]): string {
	const parts: string[] = [];
	for (const message of transcript) {
		if (message.role === "user") {
			if (message.text.length > 0) parts.push(`[User]: ${message.text}`);
			for (const result of message.toolResults ?? []) {
				if (result.text.length === 0) continue;
				parts.push(`[Tool result${result.isError ? " (error)" : ""}]: ${result.text}`);
			}
			continue;
		}
		if (message.text.length > 0) parts.push(`[Assistant]: ${message.text}`);
		if (message.toolUses.length > 0) {
			const calls = message.toolUses.map((tool) => {
				let args = "";
				try {
					args = Object.entries(tool.input)
						.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
						.join(", ");
				} catch {
					args = "…";
				}
				return `${tool.tool}(${args})`;
			});
			parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
		}
	}
	return parts.join("\n\n");
}

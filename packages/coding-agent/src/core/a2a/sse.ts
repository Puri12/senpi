/**
 * Server-Sent Events framing for the A2A streaming methods.
 *
 * Each A2A event is a single `data:` frame terminated by a blank line; the parser also accepts
 * multi-line data, CRLF line endings, comments and the `event`/`id`/`retry` fields it ignores.
 */

import { invalidAgentResponseError } from "./errors.ts";

const EVENT_BOUNDARY = /\r?\n\r?\n/;

export function formatSseEvent(payload: unknown): string {
	const json = JSON.stringify(payload);
	if (json === undefined) throw invalidAgentResponseError("SSE payload is not JSON-serializable");
	// Framing invariant: a raw newline inside the payload would split the frame in two.
	if (json.includes("\n")) throw invalidAgentResponseError("SSE payload serialized to multiple lines");
	return `data: ${json}\n\n`;
}

function parseEventBlock(block: string): unknown {
	const data = block
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice("data:".length).replace(/^ /, ""))
		.join("\n");
	if (data.length === 0) return undefined;
	try {
		return JSON.parse(data);
	} catch (error) {
		throw invalidAgentResponseError(`SSE data is not valid JSON: ${error instanceof Error ? error.message : error}`);
	}
}

function splitEvents(buffer: string): { readonly events: readonly unknown[]; readonly rest: string } {
	const events: unknown[] = [];
	let rest = buffer;
	for (;;) {
		const match = EVENT_BOUNDARY.exec(rest);
		if (match === null) return { events, rest };
		const block = rest.slice(0, match.index);
		rest = rest.slice(match.index + match[0].length);
		const event = parseEventBlock(block);
		if (event !== undefined) events.push(event);
	}
}

export async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const chunk = splitEvents(buffer);
			buffer = chunk.rest;
			yield* chunk.events;
		}
		// A stream may close right after the final `data:` line; treat the remainder as one last event.
		yield* splitEvents(`${buffer}${decoder.decode()}\n\n`).events;
	} finally {
		reader.releaseLock();
	}
}

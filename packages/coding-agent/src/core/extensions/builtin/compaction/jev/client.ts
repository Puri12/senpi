/**
 * Jev compaction: HTTP transport to TypeSafe's System One endpoint.
 *
 * The request body is `{ model, state, questions }`; the response carries an
 * `answers` object keyed by question name. Anything else throws so the caller
 * (the compaction route) can degrade deterministically.
 */
import type { JevAsker, JevCompactionState, JevQuestions, JevResponse } from "./types.ts";

export const JEV_SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_DEFAULT_MODEL = "jev-latest";

export interface JevRequest {
	url: string;
	method: "POST";
	headers: Record<string, string>;
	body: string;
}

/** The HTTP request for one Jev call, for any fetch-like transport. */
export function buildJevRequest(
	params: { apiKey: string; model?: string; baseUrl?: string },
	state: JevCompactionState,
	questions: JevQuestions,
): JevRequest {
	return {
		url: params.baseUrl ?? JEV_SYSTEM_ONE_URL,
		method: "POST",
		headers: {
			authorization: `Bearer ${params.apiKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: params.model ?? JEV_DEFAULT_MODEL,
			state,
			questions,
		}),
	};
}

/** Validates a Jev response body; throws on anything but an `answers` object. */
export function parseJevResponse(status: number, ok: boolean, text: string): JevResponse {
	if (!ok) {
		throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("Jev returned malformed JSON");
	}
	if (
		parsed === null ||
		typeof parsed !== "object" ||
		!("answers" in parsed) ||
		parsed.answers === null ||
		typeof parsed.answers !== "object"
	) {
		throw new Error("Jev response is missing answers");
	}
	return parsed as JevResponse;
}

export interface JevClientOptions {
	apiKey: string;
	model?: string;
	baseUrl?: string;
	/** Defaults to the global `fetch`. */
	fetch?: typeof fetch;
	/** Per-request wall-clock budget. Default 60s. */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Asks Jev over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
	private readonly apiKey: string;
	private readonly model: string | undefined;
	private readonly baseUrl: string | undefined;
	private readonly fetcher: typeof fetch;
	private readonly timeoutMs: number;

	constructor(options: JevClientOptions) {
		this.apiKey = options.apiKey;
		this.model = options.model;
		this.baseUrl = options.baseUrl;
		this.fetcher = options.fetch ?? fetch;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async ask(state: JevCompactionState, questions: JevQuestions, signal?: AbortSignal): Promise<JevResponse> {
		if (!this.apiKey) throw new Error("TYPESAFE_API_KEY is not configured");
		const request = buildJevRequest(
			{ apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl },
			state,
			questions,
		);
		const controller = new AbortController();
		const onAbort = () => controller.abort(signal?.reason);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(
			() => controller.abort(new Error(`Jev request exceeded ${this.timeoutMs}ms`)),
			this.timeoutMs,
		);
		try {
			const response = await this.fetcher(request.url, {
				method: request.method,
				headers: request.headers,
				body: request.body,
				signal: controller.signal,
			});
			return parseJevResponse(response.status, response.ok, await response.text());
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}
}

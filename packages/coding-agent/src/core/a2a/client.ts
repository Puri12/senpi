/**
 * A2A v1.0 client for the JSON-RPC binding: agent-card discovery, unary calls and SSE streaming.
 */

import { A2aError, internalError, invalidAgentResponseError, unsupportedOperationError } from "./errors.ts";
import type { JsonRpcFailure } from "./json-rpc.ts";
import { parseSseStream } from "./sse.ts";
import {
	A2A_PROTOCOL_VERSION,
	A2A_VERSION_HEADER,
	type AgentCard,
	type AgentInterface,
	type CancelTaskRequest,
	type GetTaskRequest,
	type ListTasksRequest,
	type ListTasksResponse,
	type SendMessageRequest,
	type SendMessageResponse,
	type StreamResponse,
	type SubscribeToTaskRequest,
	type Task,
} from "./types.ts";

export type A2aClientOptions = {
	readonly headers?: Record<string, string>;
	readonly fetch?: typeof fetch;
	readonly timeoutMs?: number;
};

export type A2aClientConfig = A2aClientOptions & { readonly url: string };

export type A2aCallOptions = { readonly signal?: AbortSignal };

const JSON_MEDIA_TYPE = "application/json";
const SSE_MEDIA_TYPE = "text/event-stream";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asJsonRpcFailure(payload: unknown): JsonRpcFailure["error"] | undefined {
	if (!isRecord(payload) || !isRecord(payload.error)) return undefined;
	const { code, message } = payload.error;
	if (typeof code !== "number" || typeof message !== "string") return undefined;
	return Array.isArray(payload.error.data) ? { code, message, data: payload.error.data } : { code, message };
}

function unwrapResponse<T>(payload: unknown): T {
	const failure = asJsonRpcFailure(payload);
	if (failure !== undefined) throw new A2aError(failure.code, failure.message, failure.data);
	if (!isRecord(payload) || !("result" in payload)) {
		throw invalidAgentResponseError("response is not a JSON-RPC response object");
	}
	return payload.result as T;
}

function selectJsonRpcInterface(card: AgentCard): AgentInterface {
	const selected = card.supportedInterfaces.find(
		(entry) => entry.protocolBinding === "JSONRPC" && entry.protocolVersion.startsWith("1."),
	);
	if (selected === undefined) {
		throw unsupportedOperationError(`agent card exposes no JSONRPC 1.x interface: ${card.name}`);
	}
	return selected;
}

export class A2aClient {
	readonly url: string;
	readonly #headers: Record<string, string>;
	readonly #fetch: typeof fetch;
	readonly #timeoutMs: number | undefined;
	readonly #cardUrl: string | undefined;
	#card: AgentCard | undefined;
	#nextId = 0;

	constructor(config: A2aClientConfig, card?: AgentCard, cardUrl?: string) {
		this.url = config.url;
		this.#headers = { ...config.headers };
		this.#fetch = config.fetch ?? globalThis.fetch;
		this.#timeoutMs = config.timeoutMs;
		this.#card = card;
		this.#cardUrl = cardUrl;
	}

	static async fromCardUrl(cardUrl: string, options: A2aClientOptions = {}): Promise<A2aClient> {
		const doFetch = options.fetch ?? globalThis.fetch;
		const response = await doFetch(cardUrl, {
			method: "GET",
			headers: { accept: JSON_MEDIA_TYPE, [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION, ...options.headers },
		});
		if (!response.ok) {
			throw internalError(`agent card request failed with HTTP ${response.status}`);
		}
		const card = (await response.json()) as AgentCard;
		const selected = selectJsonRpcInterface(card);
		return new A2aClient({ ...options, url: selected.url }, card, cardUrl);
	}

	async getAgentCard(): Promise<AgentCard> {
		if (this.#card !== undefined) return this.#card;
		const cardUrl = this.#cardUrl ?? new URL("/.well-known/agent-card.json", this.url).toString();
		const client = await A2aClient.fromCardUrl(cardUrl, this.#options());
		const card = await client.getAgentCard();
		this.#card = card;
		return card;
	}

	async sendMessage(request: SendMessageRequest, options: A2aCallOptions = {}): Promise<SendMessageResponse> {
		return await this.#call<SendMessageResponse>("SendMessage", request, options);
	}

	async *sendStreamingMessage(
		request: SendMessageRequest,
		options: A2aCallOptions = {},
	): AsyncGenerator<StreamResponse> {
		yield* this.#stream("SendStreamingMessage", request, options);
	}

	async getTask(request: GetTaskRequest, options: A2aCallOptions = {}): Promise<Task> {
		return await this.#call<Task>("GetTask", request, options);
	}

	async cancelTask(request: CancelTaskRequest, options: A2aCallOptions = {}): Promise<Task> {
		return await this.#call<Task>("CancelTask", request, options);
	}

	async listTasks(request: ListTasksRequest, options: A2aCallOptions = {}): Promise<ListTasksResponse> {
		return await this.#call<ListTasksResponse>("ListTasks", request, options);
	}

	async *subscribeToTask(
		request: SubscribeToTaskRequest,
		options: A2aCallOptions = {},
	): AsyncGenerator<StreamResponse> {
		yield* this.#stream("SubscribeToTask", request, options);
	}

	#options(): A2aClientOptions {
		return {
			headers: this.#headers,
			fetch: this.#fetch,
			...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
		};
	}

	#signal(callerSignal: AbortSignal | undefined): AbortSignal | undefined {
		const timeout = this.#timeoutMs === undefined ? undefined : AbortSignal.timeout(this.#timeoutMs);
		if (timeout === undefined) return callerSignal;
		return callerSignal === undefined ? timeout : AbortSignal.any([callerSignal, timeout]);
	}

	async #post(method: string, params: unknown, accept: string, options: A2aCallOptions): Promise<Response> {
		const signal = this.#signal(options.signal);
		const body = JSON.stringify({ jsonrpc: "2.0", id: ++this.#nextId, method, params });
		return await this.#fetch(this.url, {
			method: "POST",
			headers: {
				"content-type": JSON_MEDIA_TYPE,
				accept,
				[A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
				...this.#headers,
			},
			body,
			...(signal === undefined ? {} : { signal }),
		});
	}

	async #call<T>(method: string, params: unknown, options: A2aCallOptions): Promise<T> {
		const response = await this.#post(method, params, JSON_MEDIA_TYPE, options);
		const payload: unknown = await this.#readJson(response, method);
		return unwrapResponse<T>(payload);
	}

	async *#stream(method: string, params: unknown, options: A2aCallOptions): AsyncGenerator<StreamResponse> {
		const response = await this.#post(method, params, SSE_MEDIA_TYPE, options);
		if (!response.ok) {
			throw this.#httpError(await this.#readErrorPayload(response), response.status, method);
		}
		if (response.body === null) throw invalidAgentResponseError(`${method} returned an empty stream`);
		for await (const event of parseSseStream(response.body)) {
			yield unwrapResponse<StreamResponse>(event);
		}
	}

	async #readJson(response: Response, method: string): Promise<unknown> {
		const text = await response.text();
		const payload = this.#parseJson(text);
		if (response.ok) return payload;
		throw this.#httpError(payload, response.status, method);
	}

	async #readErrorPayload(response: Response): Promise<unknown> {
		return this.#parseJson(await response.text());
	}

	/** A non-JSON body (proxy HTML, empty error page) is data, not a failure: classify it as absent. */
	#parseJson(text: string): unknown {
		try {
			return JSON.parse(text) as unknown;
		} catch (error) {
			if (error instanceof SyntaxError) return undefined;
			throw error;
		}
	}

	#httpError(payload: unknown, status: number, method: string): A2aError {
		const failure = asJsonRpcFailure(payload);
		if (failure !== undefined) return new A2aError(failure.code, failure.message, failure.data);
		return internalError(`${method} failed with HTTP ${status}`);
	}
}

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { errorResponse, type JsonRpcId, parseJsonRpcRequest } from "../../core/a2a/json-rpc.ts";
import { formatSseEvent } from "../../core/a2a/sse.ts";
import type { AgentCard } from "../../core/a2a/types.ts";
import { A2A_VERSION_HEADER, AGENT_CARD_PATH } from "../../core/a2a/types.ts";
import {
	isWebSocketRequestAuthorized,
	type ResolvedWebSocketListenerAuth,
	resolveWebSocketListenerAuth,
	type WebSocketListenerAuth,
} from "../app-server/transports/websocket-auth.ts";
import type { A2aRequestHandler, A2aRespond, SseSink } from "./handlers.ts";

const BODY_LIMIT = 8 * 1024 * 1024;
const JSON_TYPES = new Set(["application/json", "application/a2a+json"]);

export class A2aServerListenError extends Error {
	readonly exitCode = 2;

	constructor(message: string) {
		super(message);
		this.name = "A2aServerListenError";
	}
}

class PayloadTooLargeError extends Error {
	readonly name = "PayloadTooLargeError";
}

export type A2aHttpListenerHandle = {
	readonly host: string;
	readonly port: number;
	readonly tokenFile: string | undefined;
	close(): Promise<void>;
};

export async function startA2aHttpListener(options: {
	readonly host: string;
	readonly port: number;
	readonly auth?: WebSocketListenerAuth;
	readonly handler: A2aRequestHandler;
	readonly card: AgentCard;
	readonly stderr?: Pick<NodeJS.WriteStream, "write">;
}): Promise<A2aHttpListenerHandle> {
	const stderr = options.stderr ?? process.stderr;
	const auth = await resolveWebSocketListenerAuth({
		auth: options.auth,
		stderr,
		defaultTokenPath: join(getAgentDir(), "a2a-server", "token"),
		tokenLogLabel: "a2a-server bearer token",
	});
	if (auth.kind === "off" && !isLoopbackHost(options.host)) {
		throw new A2aServerListenError("Refusing unauthenticated a2a-server on non-loopback host.");
	}

	const server = createServer((request, response) => {
		void routeRequest(request, response, options.handler, options.card, auth);
	});
	await listen(server, options.host, options.port);
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new A2aServerListenError("a2a-server listener did not bind to a TCP address.");
	}
	return {
		host: options.host,
		port: address.port,
		tokenFile: auth.kind === "bearer" ? auth.path : undefined,
		close: () => closeServer(server),
	};
}

async function routeRequest(
	request: IncomingMessage,
	response: ServerResponse,
	handler: A2aRequestHandler,
	card: AgentCard,
	auth: ResolvedWebSocketListenerAuth,
): Promise<void> {
	const path = new URL(request.url ?? "/", "http://localhost").pathname;
	if (request.method === "GET" && path === AGENT_CARD_PATH) {
		writeCard(response, card);
		return;
	}
	if (request.method === "GET" && (path === "/readyz" || path === "/healthz")) {
		response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("ok\n");
		return;
	}
	if (request.method === "POST" && (path === "/" || path === "/rpc")) {
		await handleRpc(request, response, handler, auth);
		return;
	}
	writeJson(response, 404, { error: "not found" });
}

async function handleRpc(
	request: IncomingMessage,
	response: ServerResponse,
	handler: A2aRequestHandler,
	auth: ResolvedWebSocketListenerAuth,
): Promise<void> {
	if (!isWebSocketRequestAuthorized(request, auth)) {
		response.setHeader("www-authenticate", "Bearer");
		writeJson(response, 401, rpcError(null, -32600, "Unauthorized"));
		return;
	}
	const mediaType = (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
	if (!JSON_TYPES.has(mediaType)) {
		writeJson(response, 415, rpcError(null, -32600, "Request payload validation error"));
		return;
	}
	let body: string;
	try {
		body = await readBody(request, BODY_LIMIT);
	} catch (error: unknown) {
		if (error instanceof PayloadTooLargeError) {
			writeJson(response, 413, rpcError(null, -32600, "Request payload validation error"));
			return;
		}
		throw error;
	}
	let rpcRequest: ReturnType<typeof parseJsonRpcRequest>;
	try {
		rpcRequest = parseJsonRpcRequest(body);
	} catch (error: unknown) {
		writeJson(response, 200, plainError(null, error));
		return;
	}
	const id = rpcRequest.id ?? null;
	let responded = false;
	const respond: A2aRespond = {
		json(result) {
			responded = true;
			writeJson(response, 200, { jsonrpc: "2.0", id, result });
		},
		stream() {
			responded = true;
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
				"x-accel-buffering": "no",
			});
			const sink: SseSink = {
				write(event) {
					if (!response.writableEnded) {
						response.write(formatSseEvent({ jsonrpc: "2.0", id, result: event }));
					}
				},
				close() {
					if (!response.writableEnded) {
						response.end();
					}
				},
			};
			const detach = (): void => {
				sink.write = () => {};
			};
			request.on("aborted", () => {
				detach();
				if (!response.writableEnded) {
					response.end();
				}
			});
			response.on("close", detach);
			return sink;
		},
	};
	try {
		await handler.handle(rpcRequest, respond, headerValue(request.headers[A2A_VERSION_HEADER]));
	} catch (error: unknown) {
		if (!responded) {
			writeJson(response, 200, plainError(id, error));
		}
	}
}

function writeCard(response: ServerResponse, card: AgentCard): void {
	const body = JSON.stringify(card);
	const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
	response
		.writeHead(200, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "max-age=300",
			etag,
		})
		.end(body);
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	response
		.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"content-length": Buffer.byteLength(payload),
		})
		.end(payload);
}

function rpcError(id: JsonRpcId, code: number, message: string): unknown {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

function plainError(id: JsonRpcId, error: unknown): unknown {
	const mapped = errorResponse(id, error);
	return {
		jsonrpc: "2.0",
		id: mapped.id,
		error: {
			code: mapped.error.code,
			message: mapped.error.message,
			...(mapped.error.data === undefined ? {} : { data: mapped.error.data }),
		},
	};
}

function headerValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				request.destroy();
				reject(new PayloadTooLargeError());
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}

function listen(server: Server, host: string, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

function isLoopbackHost(host: string): boolean {
	return host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
}

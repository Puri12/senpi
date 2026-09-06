import { isIP } from "node:net";
import { VERSION } from "../../config.ts";
import { TaskStore } from "../../core/a2a/task-store.ts";
import { AGENT_CARD_PATH } from "../../core/a2a/types.ts";
import type { WebSocketListenerAuth } from "../app-server/transports/websocket-auth.ts";
import { buildAgentCard } from "./agent-card.ts";
import {
	type A2aServerAuth,
	type A2aServerCliArgs,
	type A2aServerHelp,
	type A2aServerModeOptions,
	type A2aServerUsageError,
	formatA2aServerUsage,
	parseA2aServerCliArgs,
} from "./cli-args.ts";
import { createA2aRequestHandler } from "./handlers.ts";
import { type A2aHttpListenerHandle, A2aServerListenError, startA2aHttpListener } from "./http-listener.ts";
import { A2aSessionRegistry, type CreateA2aSession } from "./session-registry.ts";

export type { CreateA2aSession };
export {
	type A2aServerAuth,
	type A2aServerCliArgs,
	type A2aServerHelp,
	A2aServerListenError,
	type A2aServerModeOptions,
	type A2aServerUsageError,
	formatA2aServerUsage,
	parseA2aServerCliArgs,
};

export type A2aServerHandle = A2aHttpListenerHandle & {
	readonly url: string;
};

export type StartA2aServerOptions = {
	readonly host: string;
	readonly port: number;
	readonly cwd?: string;
	readonly name?: string;
	readonly description?: string;
	readonly auth?: WebSocketListenerAuth;
	readonly createSession?: CreateA2aSession;
	readonly stderr?: Pick<NodeJS.WriteStream, "write">;
};

export async function startA2aServer(options: StartA2aServerOptions): Promise<A2aServerHandle> {
	const cwd = options.cwd ?? process.cwd();
	const name = options.name ?? "senpi";
	const stderr = options.stderr ?? process.stderr;
	const registry = new A2aSessionRegistry({
		cwd,
		createSession: options.createSession,
		stderr,
	});
	const store = new TaskStore();
	const authEnabled = options.auth === undefined || options.auth.kind !== "off";
	const card = buildAgentCard({
		name,
		url: formatHttpUrl(options.host, options.port),
		version: VERSION,
		authEnabled,
		...(options.description === undefined ? {} : { description: options.description }),
	});
	const handler = createA2aRequestHandler({ registry, store, card, versionCheck: true });
	const listener = await startA2aHttpListener({
		host: options.host,
		port: options.port,
		auth: options.auth,
		handler,
		card,
		stderr,
	});
	const url = formatHttpUrl(listener.host, listener.port);
	const preferred = card.supportedInterfaces[0];
	if (preferred !== undefined) {
		Object.defineProperty(preferred, "url", { value: url, enumerable: true, writable: true, configurable: true });
	}
	return {
		host: listener.host,
		port: listener.port,
		tokenFile: listener.tokenFile,
		url,
		async close() {
			await listener.close();
			registry.dispose();
		},
	};
}

export async function runA2aServerMode(options: A2aServerModeOptions): Promise<void> {
	let shutdownRequested = false;
	let forceExit = false;
	let resolveShutdown: (reason: string) => void = () => {};
	const shutdownSignal = new Promise<string>((resolve) => {
		resolveShutdown = resolve;
	});
	const requestShutdown = (reason: string): void => {
		if (shutdownRequested) {
			if (!forceExit) {
				forceExit = true;
				process.exit(1);
			}
			return;
		}
		shutdownRequested = true;
		resolveShutdown(reason);
	};
	const handleSignal = (signal: NodeJS.Signals): void => {
		requestShutdown(signal);
	};
	process.on("SIGINT", handleSignal);
	process.on("SIGTERM", handleSignal);
	const handle = await startA2aServer({
		host: options.listen.host,
		port: options.listen.port,
		cwd: options.cwd,
		name: options.name,
		auth: toListenerAuth(options.auth),
	});
	process.stderr.write(`senpi a2a-server listening on ${handle.url}\n`);
	process.stderr.write(`agent card ${handle.url}${AGENT_CARD_PATH}\n`);
	if (handle.tokenFile !== undefined) {
		process.stderr.write(`token ${handle.tokenFile}\n`);
	}
	try {
		await shutdownSignal;
		await handle.close();
		process.exitCode = 0;
	} finally {
		process.off("SIGINT", handleSignal);
		process.off("SIGTERM", handleSignal);
	}
}

function toListenerAuth(auth: A2aServerAuth | undefined): WebSocketListenerAuth | undefined {
	if (auth === undefined) {
		return undefined;
	}
	if (auth.kind === "off") {
		return { kind: "off" };
	}
	return { kind: "token-file", path: auth.path };
}

function formatHttpUrl(host: string, port: number): string {
	const authority = isIP(host) === 6 ? `[${host}]` : host;
	return `http://${authority}:${port}`;
}

import { isIP } from "node:net";
import { APP_NAME } from "../../config.ts";
import { isLocalPath, resolvePath } from "../../utils/paths.ts";

export type A2aServerListen = {
	readonly url: string;
	readonly host: string;
	readonly port: number;
};

export type A2aServerAuth = { readonly kind: "off" } | { readonly kind: "token-file"; readonly path: string };

export type A2aServerModeOptions = {
	readonly kind: "server";
	readonly listen: A2aServerListen;
	readonly auth?: A2aServerAuth;
	readonly cwd: string;
	readonly name: string;
	readonly extensions: readonly string[];
};

export type A2aServerUsageError = {
	readonly kind: "usage-error";
	readonly message: string;
};

export type A2aServerHelp = {
	readonly kind: "help";
};

export type A2aServerCliArgs = A2aServerModeOptions | A2aServerUsageError | A2aServerHelp;

export const A2A_SERVER_LISTEN_USAGE =
	"Invalid --listen value. Use http://IP:PORT with an IP literal host and an explicit port.";

export function formatA2aServerUsage(): string {
	return `Usage: ${APP_NAME} a2a-server [--listen <http://IP:PORT>] [--auth <token-file|off>] [--cwd <dir>] [--name <agent name>] [--extension <path>]...`;
}

function parseListen(value: string): A2aServerListen | undefined {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch (error: unknown) {
		if (error instanceof TypeError) {
			return undefined;
		}
		throw error;
	}
	const port = Number(parsed.port);
	if (
		parsed.protocol !== "http:" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		(parsed.pathname !== "/" && parsed.pathname !== "") ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		parsed.port === "" ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65535 ||
		isIP(parsed.hostname) === 0
	) {
		return undefined;
	}
	return { url: value, host: parsed.hostname, port };
}

export function parseA2aServerCliArgs(args: readonly string[]): A2aServerCliArgs {
	let listen: A2aServerListen = { url: "http://127.0.0.1:41241", host: "127.0.0.1", port: 41241 };
	let auth: A2aServerAuth | undefined;
	let cwd = process.cwd();
	let name = "senpi";
	const extensions: string[] = [];

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			return { kind: "help" };
		}
		if (arg === "--listen") {
			const value = args[index + 1];
			if (value === undefined) {
				return { kind: "usage-error", message: A2A_SERVER_LISTEN_USAGE };
			}
			const parsed = parseListen(value);
			if (parsed === undefined) {
				return { kind: "usage-error", message: A2A_SERVER_LISTEN_USAGE };
			}
			listen = parsed;
			index++;
			continue;
		}
		if (arg === "--auth") {
			const value = args[index + 1];
			if (value === undefined) {
				return { kind: "usage-error", message: "--auth requires <token-file|off>." };
			}
			auth = value === "off" ? { kind: "off" } : { kind: "token-file", path: value };
			index++;
			continue;
		}
		if (arg === "--cwd") {
			const value = args[index + 1];
			if (value === undefined) {
				return { kind: "usage-error", message: "--cwd requires a directory." };
			}
			cwd = value;
			index++;
			continue;
		}
		if (arg === "--name") {
			const value = args[index + 1];
			if (value === undefined) {
				return { kind: "usage-error", message: "--name requires an agent name." };
			}
			name = value;
			index++;
			continue;
		}
		if (arg === "--extension") {
			const value = args[index + 1];
			if (value === undefined) {
				return { kind: "usage-error", message: "--extension requires a path." };
			}
			extensions.push(isLocalPath(value) ? resolvePath(value, process.cwd()) : value);
			index++;
			continue;
		}
		return { kind: "usage-error", message: `Unexpected a2a-server argument: ${arg}` };
	}

	if (auth === undefined) {
		return { kind: "server", listen, cwd, name, extensions };
	}
	return { kind: "server", listen, auth, cwd, name, extensions };
}

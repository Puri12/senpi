import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../../../config.ts";

export type A2aAgentConfig = {
	readonly url: string;
	readonly headers?: Record<string, string>;
	readonly bearerTokenEnv?: string;
	readonly enabled?: boolean;
	readonly timeoutMs?: number;
	readonly description?: string;
};

export type A2aConfig = {
	readonly agents: Record<string, A2aAgentConfig>;
};

export type A2aAgentSource = "global" | "project";

export type A2aResolvedAgent = {
	readonly url: string;
	readonly headers: Record<string, string>;
	readonly enabled: boolean;
	readonly source: A2aAgentSource;
	readonly timeoutMs?: number;
	readonly description?: string;
};

export type LoadA2aConfigOptions = {
	readonly agentDir: string;
	readonly cwd: string;
	readonly projectTrusted: boolean;
};

export type LoadedA2aConfig = {
	readonly agents: Map<string, A2aResolvedAgent>;
	readonly diagnostics: string[];
};

const AGENT_NAME = /^[a-z0-9][a-z0-9_-]*$/i;

export function a2aConfigPaths(agentDir: string, cwd: string): { globalPath: string; projectPath: string } {
	return {
		globalPath: join(agentDir, "a2a.json"),
		projectPath: join(cwd, CONFIG_DIR_NAME, "a2a.json"),
	};
}

export function loadA2aConfig(options: LoadA2aConfigOptions): LoadedA2aConfig {
	const { globalPath, projectPath } = a2aConfigPaths(options.agentDir, options.cwd);
	const agents = new Map<string, A2aResolvedAgent>();
	const diagnostics: string[] = [];
	loadFile(globalPath, "global", agents, diagnostics);
	if (options.projectTrusted) loadFile(projectPath, "project", agents, diagnostics);
	return { agents, diagnostics };
}

function loadFile(
	path: string,
	source: A2aAgentSource,
	agents: Map<string, A2aResolvedAgent>,
	diagnostics: string[],
): void {
	const read = readConfigFile(path);
	if (read.diagnostic !== undefined) {
		diagnostics.push(read.diagnostic);
		return;
	}
	if (read.raw === undefined) return;
	if (!isRecord(read.raw) || !isRecord(read.raw.agents)) {
		diagnostics.push(`Invalid A2A config at ${path}: expected an object with an agents map`);
		return;
	}
	for (const [name, rawAgent] of Object.entries(read.raw.agents)) {
		const parsed = parseAgent(name, rawAgent, source, path);
		if (parsed.diagnostic !== undefined) diagnostics.push(parsed.diagnostic);
		if (parsed.agent !== undefined) agents.set(name, parsed.agent);
	}
}

function readConfigFile(path: string): { raw?: unknown; diagnostic?: string } {
	try {
		if (!existsSync(path)) return {};
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		return { raw };
	} catch (error) {
		return {
			diagnostic: `Invalid A2A config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function parseAgent(
	name: string,
	raw: unknown,
	source: A2aAgentSource,
	path: string,
): { agent?: A2aResolvedAgent; diagnostic?: string } {
	if (!AGENT_NAME.test(name)) {
		return { diagnostic: `Invalid A2A agent name '${name}' in ${path}` };
	}
	if (!isRecord(raw)) {
		return { diagnostic: `Invalid A2A agent '${name}' in ${path}: expected an object` };
	}
	if (typeof raw.url !== "string" || !isHttpUrl(raw.url)) {
		return { diagnostic: `Invalid A2A agent '${name}' in ${path}: url must be an http(s) URL` };
	}
	const headers = parseHeaders(raw.headers);
	if (headers === undefined) {
		return { diagnostic: `Invalid A2A agent '${name}' in ${path}: headers must be a string map` };
	}
	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
		return { diagnostic: `Invalid A2A agent '${name}' in ${path}: enabled must be a boolean` };
	}
	if (raw.timeoutMs !== undefined && !isFiniteNumber(raw.timeoutMs)) {
		return { diagnostic: `Invalid A2A agent '${name}' in ${path}: timeoutMs must be a finite number` };
	}
	if (raw.description !== undefined && typeof raw.description !== "string") {
		return { diagnostic: `Invalid A2A agent '${name}' in ${path}: description must be a string` };
	}
	if (raw.bearerTokenEnv !== undefined && typeof raw.bearerTokenEnv !== "string") {
		return { diagnostic: `Invalid A2A agent '${name}' in ${path}: bearerTokenEnv must be a string` };
	}
	if (typeof raw.bearerTokenEnv === "string") {
		const token = process.env[raw.bearerTokenEnv];
		if (token === undefined || token === "") {
			return { diagnostic: `A2A agent '${name}' skipped: environment variable ${raw.bearerTokenEnv} is not set` };
		}
		headers.Authorization = `Bearer ${token}`;
	}
	return {
		agent: {
			url: raw.url,
			headers,
			enabled: raw.enabled === undefined ? true : raw.enabled,
			source,
			...(typeof raw.timeoutMs === "number" ? { timeoutMs: raw.timeoutMs } : {}),
			...(typeof raw.description === "string" ? { description: raw.description } : {}),
		},
	};
}

function parseHeaders(value: unknown): Record<string, string> | undefined {
	if (value === undefined) return {};
	if (!isRecord(value)) return undefined;
	const headers: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== "string") return undefined;
		headers[key] = item;
	}
	return headers;
}

function isHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

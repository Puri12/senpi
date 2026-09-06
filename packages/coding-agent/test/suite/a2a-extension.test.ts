import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import a2aExtension from "../../src/core/extensions/builtin/a2a/index.ts";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../../src/core/extensions/types.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

type Notice = { message: string; type: "info" | "warning" | "error" | undefined };
type FakeMode = "task" | "rpc-error";
type CapturedSend = {
	version: string | undefined;
	role: string | undefined;
	text: string | undefined;
};

const harnesses: Harness[] = [];
const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	await Promise.all(servers.splice(0).map(closeServer));
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

function closeServer(server: Server): Promise<void> {
	server.closeAllConnections();
	return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
}

async function startFakeA2a(mode: FakeMode): Promise<{ origin: string; captured: CapturedSend }> {
	const captured: CapturedSend = { version: undefined, role: undefined, text: undefined };
	const server = createServer((request, response) => {
		void handleFakeA2a(request, response, mode, captured);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (typeof address !== "object" || address === null) {
		throw new Error("Expected TCP address");
	}
	servers.push(server);
	return { origin: `http://127.0.0.1:${address.port}`, captured };
}

async function handleFakeA2a(
	request: IncomingMessage,
	response: ServerResponse,
	mode: FakeMode,
	captured: CapturedSend,
): Promise<void> {
	const path = request.url ?? "";
	if (request.method === "GET" && path.includes("agent-card.json")) {
		const origin = `http://127.0.0.1:${request.socket.localPort ?? 0}`;
		writeJson(response, 200, {
			name: "Fake",
			description: "in-process fake A2A agent",
			version: "1.0.0",
			supportedInterfaces: [{ url: `${origin}/`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
			capabilities: { streaming: false },
			defaultInputModes: ["text/plain"],
			defaultOutputModes: ["text/plain"],
			skills: [],
		});
		return;
	}
	if (request.method !== "POST") {
		response.writeHead(404);
		response.end();
		return;
	}
	captured.version = headerValue(request.headers["a2a-version"]);
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readBody(request));
	} catch {
		writeJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON payload" } });
		return;
	}
	const id = isRecord(parsed) ? parsed.id : null;
	const params = isRecord(parsed) ? parsed.params : undefined;
	const message = isRecord(params) ? params.message : undefined;
	if (isRecord(message)) {
		captured.role = typeof message.role === "string" ? message.role : undefined;
		const parts = message.parts;
		const first = Array.isArray(parts) ? parts[0] : undefined;
		captured.text = isRecord(first) && typeof first.text === "string" ? first.text : undefined;
	}
	if (mode === "rpc-error") {
		writeJson(response, 200, {
			jsonrpc: "2.0",
			id: id ?? null,
			error: { code: -32001, message: "Task not found" },
		});
		return;
	}
	writeJson(response, 200, {
		jsonrpc: "2.0",
		id: id ?? null,
		result: {
			task: {
				id: "task-1",
				contextId: "ctx-1",
				status: { state: "TASK_STATE_COMPLETED" },
				artifacts: [{ artifactId: "art-1", parts: [{ text: "pong from fake" }] }],
			},
		},
	});
}

function headerValue(value: string | string[] | undefined): string | undefined {
	if (Array.isArray(value)) return value[0];
	return value;
}

function writeAgentConfig(agentDir: string, origin: string): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "a2a.json"), `${JSON.stringify({ agents: { local: { url: origin } } }, null, 2)}\n`);
}

function toolResultText(harness: Harness, toolName: string): string {
	const message = harness.session.messages.find((entry) => entry.role === "toolResult" && entry.toolName === toolName);
	if (!message) throw new Error(`missing tool result for ${toolName}`);
	return getMessageText(message);
}

type Command = Pick<RegisteredCommand, "handler">;

function registeredA2aCommand(): Command {
	const commands = new Map<string, Command>();
	const pi = {
		registerCommand: (name: string, command: Command) => {
			commands.set(name, command);
		},
		on: () => undefined,
	} as unknown as ExtensionAPI;
	a2aExtension(pi);
	const registered = commands.get("a2a");
	if (!registered) throw new Error("/a2a was not registered");
	return registered;
}

function commandContext(agentDir: string, cwd: string): { ctx: ExtensionCommandContext; notices: Notice[] } {
	const notices: Notice[] = [];
	return {
		ctx: {
			hasUI: true,
			cwd,
			agentDir,
			isProjectTrusted: () => true,
			ui: {
				notify: (message: string, type?: Notice["type"]) => notices.push({ message, type }),
			},
		} as unknown as ExtensionCommandContext,
		notices,
	};
}

describe("a2a builtin extension", () => {
	it("registers id a2a immediately after webfetch", () => {
		const ids = builtinExtensions.map((extension) => extension.id);
		expect(ids[ids.indexOf("webfetch") + 1]).toBe("a2a");
	});

	it("registers a2a_local and returns the remote reply when the model calls it", async () => {
		const { origin, captured } = await startFakeA2a("task");
		const harness = await createHarness({ extensionFactories: [a2aExtension] });
		harnesses.push(harness);
		writeAgentConfig(join(harness.tempDir, "agent"), origin);
		await harness.session.bindExtensions({});

		const names = harness
			.getExtensionRunner()
			.getAllRegisteredTools()
			.map((tool) => tool.definition.name);
		expect(names).toContain("a2a_local");
		expect(harness.session.getAllTools().some((tool) => tool.name === "a2a_local")).toBe(true);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("a2a_local", { message: "ping" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("ping the agent");

		expect(toolResultText(harness, "a2a_local")).toContain("pong from fake");
		expect(captured.version).toBe("1.0");
		expect(captured.role).toBe("ROLE_USER");
		expect(captured.text).toBe("ping");
	});

	it("returns tool text starting with A2A error -32001 when the remote JSON-RPC call fails", async () => {
		const { origin } = await startFakeA2a("rpc-error");
		const harness = await createHarness({ extensionFactories: [a2aExtension] });
		harnesses.push(harness);
		writeAgentConfig(join(harness.tempDir, "agent"), origin);
		await harness.session.bindExtensions({});

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("a2a_local", { message: "ping" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("ping the agent");

		expect(toolResultText(harness, "a2a_local")).toMatch(/^A2A error -32001/);
	});

	it("notifies one configured-agent line from /a2a list", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "a2a-cmd-"));
		tempDirs.push(cwd);
		const agentDir = join(cwd, "agent");
		writeAgentConfig(agentDir, "http://127.0.0.1:9");
		const { ctx, notices } = commandContext(agentDir, cwd);

		await registeredA2aCommand().handler("", ctx);

		expect(notices.some((notice) => notice.message.includes("local — http://127.0.0.1:9"))).toBe(true);
		expect(
			notices.some((notice) => notice.message.includes("[global]") && notice.message.includes("[enabled]")),
		).toBe(true);
	});

	it("notifies that no A2A agents are configured when a2a.json is missing", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "a2a-empty-"));
		tempDirs.push(cwd);
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });
		const { ctx, notices } = commandContext(agentDir, cwd);

		await registeredA2aCommand().handler("list", ctx);

		expect(notices[0]?.message).toContain("No A2A agents configured");
	});
});

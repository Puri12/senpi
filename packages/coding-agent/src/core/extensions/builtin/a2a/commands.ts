import type { ExtensionAPI, ExtensionCommandContext } from "../../types.ts";
import { type A2aResolvedAgent, a2aConfigPaths, loadA2aConfig } from "./config.ts";
import { resolveAgentCardUrl } from "./tool.ts";

const DEFAULT_CARD_TIMEOUT_MS = 10_000;

export type A2aExtensionState = {
	registerNew(agents: Map<string, A2aResolvedAgent>): { added: number; needsReload: boolean };
};

export function registerA2aCommands(pi: ExtensionAPI, state: A2aExtensionState): void {
	pi.registerCommand("a2a", {
		description: "List, probe, or refresh configured A2A agents.",
		argumentHint: "[list | status | refresh]",
		handler: async (rawArgs, ctx) => {
			if (!ctx.hasUI) return;
			const subcommand = rawArgs.trim().split(/\s+/).filter(Boolean)[0] ?? "list";
			if (subcommand === "list") {
				notifyList(ctx);
				return;
			}
			if (subcommand === "status") {
				await notifyStatus(ctx);
				return;
			}
			if (subcommand === "refresh") {
				refreshAgents(ctx, state);
				return;
			}
			ctx.ui.notify("Usage: /a2a [list | status | refresh]", "error");
		},
	});
}

function notifyList(ctx: ExtensionCommandContext): void {
	const loaded = loadA2aConfig({
		agentDir: ctx.agentDir,
		cwd: ctx.cwd,
		projectTrusted: ctx.isProjectTrusted(),
	});
	if (loaded.agents.size === 0) {
		ctx.ui.notify(emptyConfigMessage(ctx), "info");
		return;
	}
	const lines = [...loaded.agents.entries()].map(([name, agent]) => formatAgentLine(name, agent));
	ctx.ui.notify(lines.join("\n"), "info");
}

async function notifyStatus(ctx: ExtensionCommandContext): Promise<void> {
	const loaded = loadA2aConfig({
		agentDir: ctx.agentDir,
		cwd: ctx.cwd,
		projectTrusted: ctx.isProjectTrusted(),
	});
	if (loaded.agents.size === 0) {
		ctx.ui.notify(emptyConfigMessage(ctx), "info");
		return;
	}
	const enabled = [...loaded.agents.entries()].filter(([, agent]) => agent.enabled);
	if (enabled.length === 0) {
		ctx.ui.notify("No enabled A2A agents.", "info");
		return;
	}
	const lines = await Promise.all(enabled.map(([name, agent]) => formatCardStatus(name, agent)));
	ctx.ui.notify(lines.join("\n"), "info");
}

function refreshAgents(ctx: ExtensionCommandContext, state: A2aExtensionState): void {
	const loaded = loadA2aConfig({
		agentDir: ctx.agentDir,
		cwd: ctx.cwd,
		projectTrusted: ctx.isProjectTrusted(),
	});
	for (const diagnostic of loaded.diagnostics) ctx.ui.notify(diagnostic, "warning");
	const result = state.registerNew(loaded.agents);
	if (result.added > 0) ctx.ui.notify(`Registered ${result.added} new A2A agent(s).`, "info");
	if (result.needsReload) {
		ctx.ui.notify("Removed or changed A2A agents need a session reload (/reload).", "info");
	}
	if (result.added === 0 && !result.needsReload) ctx.ui.notify("A2A agents are already up to date.", "info");
}

function formatAgentLine(name: string, agent: A2aResolvedAgent): string {
	const availability = agent.enabled ? "enabled" : "disabled";
	return `${name} — ${agent.url} [${agent.source}] [${availability}]`;
}

function emptyConfigMessage(ctx: ExtensionCommandContext): string {
	const paths = a2aConfigPaths(ctx.agentDir, ctx.cwd);
	return `No A2A agents configured (${paths.globalPath}, ${paths.projectPath})`;
}

async function formatCardStatus(name: string, agent: A2aResolvedAgent): Promise<string> {
	const timeoutMs = agent.timeoutMs ?? DEFAULT_CARD_TIMEOUT_MS;
	try {
		const response = await fetch(resolveAgentCardUrl(agent.url), {
			headers: { accept: "application/json", ...agent.headers },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return `${name}: HTTP ${response.status}`;
		const value: unknown = JSON.parse(await response.text());
		if (!isRecord(value) || typeof value.name !== "string") return `${name}: invalid agent card`;
		const version = typeof value.version === "string" ? value.version : "?";
		const capabilities = value.capabilities;
		const streaming = isRecord(capabilities) && capabilities.streaming === true;
		return `${name}: ${value.name} v${version} (streaming: ${streaming ? "yes" : "no"})`;
	} catch (error) {
		return `${name}: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

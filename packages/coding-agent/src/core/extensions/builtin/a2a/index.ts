import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { registerA2aCommands } from "./commands.ts";
import { type A2aResolvedAgent, loadA2aConfig } from "./config.ts";
import { createA2aAgentTool } from "./tool.ts";

const STATUS_KEY = "a2a";

export default function a2aExtension(pi: ExtensionAPI): void {
	const registered = new Map<string, string>();
	const registerNew = (agents: Map<string, A2aResolvedAgent>) => registerEnabledAgents(pi, agents, registered);
	registerA2aCommands(pi, { registerNew });

	pi.on("session_start", async (_event, ctx) => {
		const loaded = loadA2aConfig({
			agentDir: ctx.agentDir,
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
		});
		if (ctx.hasUI) {
			for (const diagnostic of loaded.diagnostics) ctx.ui.notify(diagnostic, "warning");
		}
		registerNew(loaded.agents);
		const enabledCount = countEnabled(loaded.agents);
		if (ctx.hasUI && enabledCount > 0) ctx.ui.setStatus(STATUS_KEY, `a2a: ${enabledCount} agents`);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearStatus(ctx);
	});
}

function registerEnabledAgents(
	pi: ExtensionAPI,
	agents: Map<string, A2aResolvedAgent>,
	registered: Map<string, string>,
): { added: number; needsReload: boolean } {
	let added = 0;
	let needsReload = false;
	for (const [name, agent] of agents) {
		const current = fingerprint(agent);
		const previous = registered.get(name);
		if (!agent.enabled) {
			if (previous !== undefined) needsReload = true;
			continue;
		}
		if (previous === undefined) {
			pi.registerTool(createA2aAgentTool(name, agent));
			registered.set(name, current);
			added += 1;
			continue;
		}
		if (previous !== current) needsReload = true;
	}
	for (const name of registered.keys()) {
		const current = agents.get(name);
		if (current === undefined || !current.enabled) needsReload = true;
	}
	return { added, needsReload };
}

function fingerprint(agent: A2aResolvedAgent): string {
	return JSON.stringify({
		url: agent.url,
		headers: agent.headers,
		enabled: agent.enabled,
		timeoutMs: agent.timeoutMs ?? null,
		description: agent.description ?? null,
	});
}

function countEnabled(agents: Map<string, A2aResolvedAgent>): number {
	let count = 0;
	for (const agent of agents.values()) {
		if (agent.enabled) count += 1;
	}
	return count;
}

function clearStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
}

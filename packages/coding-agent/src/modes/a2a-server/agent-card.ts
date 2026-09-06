import type { AgentCard } from "../../core/a2a/types.ts";

export type BuildAgentCardInput = {
	readonly name: string;
	readonly description?: string;
	readonly url: string;
	readonly version: string;
	readonly authEnabled?: boolean;
};

const SKILL_EXAMPLES = [
	"Find the failing test and fix it.",
	"Explain this file and suggest a simpler version.",
] as const;

export function buildAgentCard(input: BuildAgentCardInput): AgentCard {
	const auth =
		input.authEnabled === true
			? {
					securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "bearer" } } },
					securityRequirements: [{ schemes: { bearer: { list: [] as const } } }],
				}
			: {};
	return {
		name: input.name,
		description: input.description ?? "Runs senpi coding-agent turns in the configured workspace.",
		supportedInterfaces: [{ url: input.url, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
		version: input.version,
		capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
		defaultInputModes: ["text/plain"],
		defaultOutputModes: ["text/plain"],
		skills: [
			{
				id: "coding-agent",
				name: "Coding agent",
				description:
					"Runs senpi coding-agent turns: reads, edits, and runs commands in the configured workspace and replies with the assistant's answer.",
				tags: ["coding", "agent", "senpi"],
				examples: [...SKILL_EXAMPLES],
			},
		],
		...auth,
	};
}

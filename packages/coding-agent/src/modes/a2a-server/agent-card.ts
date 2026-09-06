import type { AgentCard } from "../../core/a2a/types.ts";

export type BuildAgentCardInput = {
	readonly name: string;
	readonly description?: string;
	readonly url: string;
	readonly version: string;
	readonly authEnabled?: boolean;
	readonly extensionsLoaded?: boolean;
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
	const extensionsLoaded = input.extensionsLoaded === true;
	return {
		name: input.name,
		description: input.description ?? "Runs senpi coding-agent turns in the configured workspace.",
		supportedInterfaces: [{ url: input.url, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
		version: input.version,
		capabilities: {
			streaming: true,
			pushNotifications: false,
			extendedAgentCard: false,
			...(extensionsLoaded
				? {
						extensions: [
							{
								uri: "https://omo.dev/a2a/ext/omo-remote/v1",
								description: "omo remote delegation: workspace metadata, steer, usage reporting",
								required: false,
							},
						],
					}
				: {}),
		},
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
			...(extensionsLoaded
				? [
						{
							id: "ultrawork",
							name: "Ultrawork delegation",
							description:
								"Runs an ultrawork (ulw) task end to end inside this agent: plan, delegate to its own subagents, verify with evidence, and report.",
							tags: ["ultrawork", "delegation", "omo"],
							examples: ["ulw: add input validation to the signup form and prove it with tests"],
						},
					]
				: []),
		],
		...auth,
	};
}

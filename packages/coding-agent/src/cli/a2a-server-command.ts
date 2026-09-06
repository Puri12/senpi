import { formatA2aServerUsage, parseA2aServerCliArgs, runA2aServerMode } from "../modes/a2a-server/index.ts";

export async function handleA2aServerCommand(args: readonly string[]): Promise<boolean> {
	if (args[0] !== "a2a-server") {
		return false;
	}

	const parsed = parseA2aServerCliArgs(args.slice(1));
	if (parsed.kind === "usage-error") {
		console.error(`Error: ${parsed.message}`);
		console.error(formatA2aServerUsage());
		process.exit(2);
	}
	if (parsed.kind === "help") {
		console.log(formatA2aServerUsage());
		return true;
	}
	await runA2aServerMode(parsed);
	return true;
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { handleA2aServerCommand } from "../../src/cli/a2a-server-command.ts";

describe("a2a-server command dispatch", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("ignores other subcommands", async () => {
		expect(await handleA2aServerCommand(["app-server"])).toBe(false);
	});

	it("exits with code 2 when the listener refuses to start", async () => {
		// Given: --auth off on a non-loopback host, which the listener refuses before binding.
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`process.exit(${code})`);
		}) as never);

		// When: the command runs.
		await expect(
			handleA2aServerCommand(["a2a-server", "--listen", "http://0.0.0.0:41240", "--auth", "off"]),
		).rejects.toThrow("process.exit(2)");

		// Then: the refusal is reported on stderr and the exit code is 2, matching usage errors.
		expect(exit).toHaveBeenCalledWith(2);
		expect(stderr.mock.calls.flat().join("\n")).toMatch(/non-loopback/);
	});
});

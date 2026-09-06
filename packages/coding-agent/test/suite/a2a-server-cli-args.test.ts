import { describe, expect, it } from "vitest";
import { formatA2aServerUsage, parseA2aServerCliArgs } from "../../src/modes/a2a-server/cli-args.ts";

describe("a2a-server CLI argument parsing", () => {
	it("parses defaults when no flags are given", () => {
		// Given: the a2a-server subcommand has no flags.
		// When: the subcommand args are parsed.
		const result = parseA2aServerCliArgs([]);

		// Then: listen, cwd, and name fall back to the documented defaults and auth stays managed.
		expect(result).toEqual({
			kind: "server",
			listen: { url: "http://127.0.0.1:41241", host: "127.0.0.1", port: 41241 },
			cwd: process.cwd(),
			name: "senpi",
		});
	});

	it("parses a loopback listen URL", () => {
		// Given: an explicit HTTP listen URL with an IP literal.
		// When: the subcommand args are parsed.
		const result = parseA2aServerCliArgs(["--listen", "http://127.0.0.1:41242"]);

		// Then: host and port are preserved as typed fields.
		expect(result).toEqual({
			kind: "server",
			listen: { url: "http://127.0.0.1:41242", host: "127.0.0.1", port: 41242 },
			cwd: process.cwd(),
			name: "senpi",
		});
	});

	it("rejects a hostname listen URL", () => {
		// Given: a listen URL whose host is a DNS name rather than an IP literal.
		// When: the subcommand args are parsed.
		const result = parseA2aServerCliArgs(["--listen", "http://example.com:1"]);

		// Then: parsing returns a usage error.
		expect(result.kind).toBe("usage-error");
	});

	it("rejects a listen URL with no port", () => {
		// Given: a listen URL that omits the port.
		// When: the subcommand args are parsed.
		const result = parseA2aServerCliArgs(["--listen", "http://127.0.0.1"]);

		// Then: parsing returns a usage error.
		expect(result.kind).toBe("usage-error");
	});

	it("rejects an https listen URL", () => {
		// Given: a listen URL that uses https.
		// When: the subcommand args are parsed.
		const result = parseA2aServerCliArgs(["--listen", "https://127.0.0.1:41241"]);

		// Then: parsing returns a usage error.
		expect(result.kind).toBe("usage-error");
	});

	it("parses --auth off", () => {
		// Given: auth explicitly disabled.
		// When: the subcommand args are parsed.
		const result = parseA2aServerCliArgs(["--auth", "off"]);

		// Then: auth is the off variant.
		expect(result).toMatchObject({ kind: "server", auth: { kind: "off" } });
	});

	it("parses --auth as a token file path", () => {
		// Given: auth pointing at a token file.
		// When: the subcommand args are parsed.
		const result = parseA2aServerCliArgs(["--auth", "/tmp/a2a-token"]);

		// Then: auth is a token-file variant with that path.
		expect(result).toMatchObject({ kind: "server", auth: { kind: "token-file", path: "/tmp/a2a-token" } });
	});

	it("returns help when --help is passed", () => {
		// Given: the help flag.
		// When: the subcommand args are parsed.
		const result = parseA2aServerCliArgs(["--help"]);

		// Then: parsing returns the help variant and usage text mentions a2a-server.
		expect(result).toEqual({ kind: "help" });
		expect(formatA2aServerUsage()).toContain("a2a-server");
	});
});

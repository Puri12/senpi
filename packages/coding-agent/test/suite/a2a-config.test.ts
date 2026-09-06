import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import { loadA2aConfig } from "../../src/core/extensions/builtin/a2a/config.ts";

const dirs: string[] = [];

afterEach(() => {
	while (dirs.length > 0) {
		const dir = dirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

function makeDirs(): { agentDir: string; cwd: string } {
	const cwd = mkdtempSync(join(tmpdir(), "a2a-config-"));
	dirs.push(cwd);
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir, { recursive: true });
	return { agentDir, cwd };
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe("loadA2aConfig", () => {
	it("layers trusted project agents over global agents of the same name", () => {
		const { agentDir, cwd } = makeDirs();
		writeJson(join(agentDir, "a2a.json"), {
			agents: {
				shared: { url: "http://global.example/shared" },
				"only-global": { url: "http://global.example/only" },
			},
		});
		writeJson(join(cwd, CONFIG_DIR_NAME, "a2a.json"), {
			agents: {
				shared: { url: "http://project.example/shared" },
				"only-project": { url: "http://project.example/only" },
			},
		});

		const loaded = loadA2aConfig({ agentDir, cwd, projectTrusted: true });

		expect(loaded.diagnostics).toEqual([]);
		expect(loaded.agents.get("shared")).toMatchObject({
			url: "http://project.example/shared",
			source: "project",
			enabled: true,
		});
		expect(loaded.agents.get("only-global")).toMatchObject({
			url: "http://global.example/only",
			source: "global",
		});
		expect(loaded.agents.get("only-project")).toMatchObject({
			url: "http://project.example/only",
			source: "project",
		});
	});

	it("ignores project a2a.json when the project is untrusted", () => {
		const { agentDir, cwd } = makeDirs();
		writeJson(join(agentDir, "a2a.json"), {
			agents: {
				shared: { url: "http://global.example/shared" },
			},
		});
		writeJson(join(cwd, CONFIG_DIR_NAME, "a2a.json"), {
			agents: {
				shared: { url: "http://project.example/shared" },
				shadow: { url: "http://project.example/shadow" },
			},
		});

		const loaded = loadA2aConfig({ agentDir, cwd, projectTrusted: false });

		expect(loaded.diagnostics).toEqual([]);
		expect(loaded.agents.get("shared")).toMatchObject({
			url: "http://global.example/shared",
			source: "global",
		});
		expect(loaded.agents.has("shadow")).toBe(false);
	});

	it("records a diagnostic and skips an agent whose name is invalid", () => {
		const { agentDir, cwd } = makeDirs();
		writeJson(join(agentDir, "a2a.json"), {
			agents: {
				"Bad Name": { url: "http://example.com/bad" },
				ok: { url: "http://example.com/ok" },
			},
		});

		const loaded = loadA2aConfig({ agentDir, cwd, projectTrusted: true });

		expect(loaded.agents.has("Bad Name")).toBe(false);
		expect(loaded.agents.get("ok")?.url).toBe("http://example.com/ok");
		expect(loaded.diagnostics.length).toBeGreaterThan(0);
	});

	it("records a diagnostic and skips an agent whose url is not http(s)", () => {
		const { agentDir, cwd } = makeDirs();
		writeJson(join(agentDir, "a2a.json"), {
			agents: {
				local: { url: "ftp://example.com/agent" },
			},
		});

		const loaded = loadA2aConfig({ agentDir, cwd, projectTrusted: true });

		expect(loaded.agents.size).toBe(0);
		expect(loaded.diagnostics.length).toBeGreaterThan(0);
	});

	it("skips an agent when bearerTokenEnv is unset and records a diagnostic", () => {
		const { agentDir, cwd } = makeDirs();
		const envName = "A2A_TEST_MISSING_BEARER";
		delete process.env[envName];
		writeJson(join(agentDir, "a2a.json"), {
			agents: {
				secure: { url: "http://example.com/secure", bearerTokenEnv: envName },
			},
		});

		const loaded = loadA2aConfig({ agentDir, cwd, projectTrusted: true });

		expect(loaded.agents.has("secure")).toBe(false);
		expect(loaded.diagnostics.some((line) => line.includes(envName))).toBe(true);
	});

	it("records a diagnostic for malformed JSON and does not throw", () => {
		const { agentDir, cwd } = makeDirs();
		writeFileSync(join(agentDir, "a2a.json"), "{ not json");

		expect(() => loadA2aConfig({ agentDir, cwd, projectTrusted: true })).not.toThrow();
		const loaded = loadA2aConfig({ agentDir, cwd, projectTrusted: true });
		expect(loaded.agents.size).toBe(0);
		expect(loaded.diagnostics.length).toBeGreaterThan(0);
	});

	it("resolves bearerTokenEnv into an Authorization Bearer header at load time", () => {
		const { agentDir, cwd } = makeDirs();
		const envName = "A2A_TEST_BEARER_TOKEN";
		process.env[envName] = "secret-token";
		try {
			writeJson(join(agentDir, "a2a.json"), {
				agents: {
					secure: {
						url: "http://example.com/secure",
						headers: { "X-Trace": "1" },
						bearerTokenEnv: envName,
					},
				},
			});

			const loaded = loadA2aConfig({ agentDir, cwd, projectTrusted: true });

			expect(loaded.diagnostics).toEqual([]);
			expect(loaded.agents.get("secure")?.headers).toEqual({
				"X-Trace": "1",
				Authorization: "Bearer secret-token",
			});
		} finally {
			delete process.env[envName];
		}
	});

	it("treats missing config files as empty without diagnostics", () => {
		const { agentDir, cwd } = makeDirs();

		const loaded = loadA2aConfig({ agentDir, cwd, projectTrusted: true });

		expect(loaded.agents.size).toBe(0);
		expect(loaded.diagnostics).toEqual([]);
	});
});

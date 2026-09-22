import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import semver from "semver";
import { findPackageDirectories } from "./package-workspaces.mjs";
import { bundledWorkspacePackageChecks } from "./prepare-senpi-bundled-workspaces.mjs";
import { registryPackageNames } from "./registry-packages.mjs";
import { BUNDLED_INTERNAL_WORKSPACES, WORKSPACE_PACKAGES, getPublicWorkspacePackages } from "./release-packages.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PRIVATE_UPSTREAM_WORKSPACES = [
	{ packageJsonPath: "packages/chord/package.json", packageName: "@earendil-works/chord" },
	{ packageJsonPath: "packages/ai/package.json", packageName: "@earendil-works/pi-ai" },
	{ packageJsonPath: "packages/agent/package.json", packageName: "@earendil-works/pi-agent-core" },
	{ packageJsonPath: "packages/tui/package.json", packageName: "@earendil-works/pi-tui" },
	{ packageJsonPath: "packages/pty/package.json", packageName: "@earendil-works/pi-pty" },
	{ packageJsonPath: "packages/telemetry/package.json", packageName: "@earendil-works/pi-telemetry" },
];
const INDEPENDENT_UPSTREAM_WORKSPACES = [
	{
		packageJsonPath: "packages/session-backends/sqlite-node/package.json",
		packageName: "@earendil-works/pi-storage-sqlite-node",
	},
];
const OWNED_REGISTRY_ALIASES = [
	"@code-yeongyu/senpi-ai",
	"@code-yeongyu/senpi-agent-core",
	"@code-yeongyu/senpi-tui",
	"@code-yeongyu/senpi-pty",
	"@code-yeongyu/senpi-telemetry",
	"@code-yeongyu/senpi-codemode",
	"@code-yeongyu/senpi",
];
const BUNDLED_ONLY_WORKSPACES = ["@code-yeongyu/senpi-client", "@code-yeongyu/senpi-protocol"];

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

describe("npm publish dependency graph", () => {
	it("keeps upstream workspaces private and publishes owned registry aliases", () => {
		// Given: Bun resolves declared edges from the registry, but npm only packs the
		// original import paths when their dependency keys remain in the manifest.
		const publishedNames = getPublicWorkspacePackages().map(({ name }) => name);
		assert.equal(readJson(join(repoRoot, "packages/server/package.json")).private, true);
		assert.ok(!publishedNames.includes("@code-yeongyu/senpi-server"));

		for (const workspace of PRIVATE_UPSTREAM_WORKSPACES) {
			const manifest = readJson(join(repoRoot, workspace.packageJsonPath));
			assert.equal(manifest.private, true, `${workspace.packageName} must remain private`);
		}
		for (const workspace of INDEPENDENT_UPSTREAM_WORKSPACES) {
			const manifest = readJson(join(repoRoot, workspace.packageJsonPath));
			const aiManifest = readJson(join(repoRoot, "packages/ai/package.json"));
			const agentManifest = readJson(join(repoRoot, "packages/agent/package.json"));
			assert.equal(manifest.private, true, `${workspace.packageName} must remain excluded from fork publishing`);
			assert.ok(!publishedNames.includes(workspace.packageName));
			assert.equal(manifest.dependencies["@earendil-works/pi-agent-core"], `^${agentManifest.version}`);
			assert.equal(manifest.dependencies["@earendil-works/pi-ai"], `^${aiManifest.version}`);
			assert.equal(manifest.devDependencies["@earendil-works/pi-agent-core"], undefined);
			assert.equal(manifest.devDependencies["@earendil-works/pi-ai"], undefined);
		}
		for (const packageName of OWNED_REGISTRY_ALIASES) {
			assert.ok(publishedNames.includes(packageName));
		}
		for (const packageName of BUNDLED_ONLY_WORKSPACES) {
			assert.ok(!publishedNames.includes(packageName));
		}
	});

	it("keeps every bundled workspace's declared edge resolvable", () => {
		// Given: npm installs a bundled workspace from the packed copy, but Bun resolves the declared
		// edge from the registry — including the edges inside the published `@code-yeongyu/senpi-*`
		// manifests. A bundled workspace is therefore only installable when it is either published
		// under a fork alias, or left on upstream's own release line so its declared range matches a
		// version that exists upstream. CalVer-stamping a bundled workspace the fork does not publish
		// produces a spec nothing can satisfy and breaks `bun add @code-yeongyu/senpi` outright
		// (issue #1632: chord shipped that way in 2026.9.12-3).
		const publishedNames = getPublicWorkspacePackages().map(({ name }) => name);
		const manifests = findPackageDirectories().map((directory) => ({
			directory,
			manifest: readJson(join(directory, "package.json")),
		}));
		const problems = [];
		for (const { packageName } of bundledWorkspacePackageChecks()) {
			const registryName = registryPackageNames.get(packageName);
			if (registryName !== undefined) {
				if (!publishedNames.includes(registryName)) {
					problems.push(`${packageName}: mapped to ${registryName} but that alias is not published`);
				}
				continue;
			}
			const source = manifests.find(({ manifest }) => manifest.name === packageName);
			assert.ok(source, `${packageName} is bundled but has no workspace manifest`);
			const relativeManifest = `${relative(repoRoot, source.directory)}/package.json`.replaceAll("\\", "/");
			if (WORKSPACE_PACKAGES.includes(relativeManifest)) {
				problems.push(
					`${packageName}: CalVer-stamped through ${relativeManifest} without a published fork alias`,
				);
			}
			// A non-aliased bundled workspace must be declared internal so the install-lock resolves its
			// closure from the local manifest; otherwise the generator fetches upstream registry metadata
			// and drags that version's transitive deps (e.g. a different esbuild) into the installer lock.
			if (!BUNDLED_INTERNAL_WORKSPACES.includes(relativeManifest)) {
				problems.push(
					`${packageName}: bundled without a fork alias but not listed in BUNDLED_INTERNAL_WORKSPACES`,
				);
			}
			for (const { directory, manifest } of manifests) {
				const range = manifest.dependencies?.[packageName];
				if (typeof range !== "string" || range.startsWith("npm:")) {
					continue;
				}
				if (!semver.satisfies(source.manifest.version, range)) {
					problems.push(
						`${manifest.name} (${relative(repoRoot, directory)}) declares ${packageName}@${range}, which its ${source.manifest.version} does not satisfy`,
					);
				}
			}
		}
		assert.deepEqual(problems, [], problems.join("; "));
	});
});

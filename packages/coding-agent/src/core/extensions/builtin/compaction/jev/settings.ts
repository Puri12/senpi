/**
 * Jev compaction: settings. Read from `compaction.jev` in settings.json. The
 * API key resolves, in order, from the settings value (literal or `$ENV`
 * reference), then a key stored in senpi's credential store under the
 * `typesafe` provider (via `/jev-login`), then the `TYPESAFE_API_KEY`
 * environment variable.
 *
 *   "compaction": {
 *     "jev": {
 *       "enabled": true,
 *       "apiKey": "$TYPESAFE_API_KEY",
 *       "model": "jev-latest",
 *       "keepThreshold": 0.5,
 *       "truncateHeadChars": 300,
 *       "maxStateTokens": 25000,
 *       "maxRequestTokens": 30000,
 *       "minReductionRatio": 0.1,
 *       "timeoutMs": 60000
 *     }
 *   }
 */
import { JEV_DEFAULT_MODEL } from "./client.ts";
import { JEV_DEFAULT_OPTIONS } from "./decide.ts";

/** Credential-store provider id the Jev key is stored under (`/jev-login`). */
export const JEV_CREDENTIAL_PROVIDER = "typesafe";

export interface JevCompactionSettings {
	/** Route compaction through Jev instead of LLM summarization. Default: true when a key resolves. */
	enabled?: boolean;
	/** Literal key or `$ENV_VAR` / `${ENV_VAR}`. Falls back to the stored `typesafe` credential, then `TYPESAFE_API_KEY`. */
	apiKey?: string;
	model?: string;
	baseUrl?: string;
	keepThreshold?: number;
	truncateHeadChars?: number;
	maxStateTokens?: number;
	maxRequestTokens?: number;
	/** Below this estimated character reduction the summary is refused and the route degrades. Default 0.1. */
	minReductionRatio?: number;
	timeoutMs?: number;
}

export interface ResolvedJevCompactionSettings {
	enabled: boolean;
	apiKey: string | undefined;
	model: string;
	baseUrl: string | undefined;
	keepThreshold: number;
	truncateHeadChars: number;
	maxStateTokens: number;
	maxRequestTokens: number;
	minReductionRatio: number;
	timeoutMs: number;
}

export const JEV_API_KEY_ENV = "TYPESAFE_API_KEY";
const DEFAULT_MIN_REDUCTION_RATIO = 0.1;
const DEFAULT_TIMEOUT_MS = 60_000;

function finiteNumber(value: unknown, fallback: number, minimum = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, value) : fallback;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolves the Jev key in priority order:
 *   1. the configured value (a literal, or a `$NAME` / `${NAME}` env reference),
 *   2. a key stored in the credential store (`storedKey`, from `/jev-login`),
 *   3. the `TYPESAFE_API_KEY` environment variable.
 * A configured value that is an env reference to an unset variable falls through
 * to the stored key and then the default env var, so a stale reference never
 * pins the route to "no key".
 */
export function resolveJevApiKey(
	raw: string | undefined,
	env: NodeJS.ProcessEnv,
	storedKey?: string,
): string | undefined {
	const configured = nonEmptyString(raw);
	if (configured !== undefined) {
		const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(configured);
		if (!match) return configured;
		const fromRef = nonEmptyString(env[match[1]!]);
		if (fromRef !== undefined) return fromRef;
	}
	return nonEmptyString(storedKey) ?? nonEmptyString(env[JEV_API_KEY_ENV]);
}

export function resolveJevCompactionSettings(
	raw: unknown,
	env: NodeJS.ProcessEnv = process.env,
	storedKey?: string,
): ResolvedJevCompactionSettings {
	const settings = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const apiKey = resolveJevApiKey(nonEmptyString(settings.apiKey), env, storedKey);
	const enabled = typeof settings.enabled === "boolean" ? settings.enabled : apiKey !== undefined;
	return {
		enabled,
		apiKey,
		model: nonEmptyString(settings.model) ?? JEV_DEFAULT_MODEL,
		baseUrl: nonEmptyString(settings.baseUrl),
		keepThreshold: finiteNumber(settings.keepThreshold, JEV_DEFAULT_OPTIONS.keepThreshold),
		truncateHeadChars: Math.floor(finiteNumber(settings.truncateHeadChars, JEV_DEFAULT_OPTIONS.truncateHeadChars)),
		maxStateTokens: finiteNumber(settings.maxStateTokens, JEV_DEFAULT_OPTIONS.maxStateTokens, 1),
		maxRequestTokens: finiteNumber(settings.maxRequestTokens, JEV_DEFAULT_OPTIONS.maxRequestTokens, 1),
		minReductionRatio: finiteNumber(settings.minReductionRatio, DEFAULT_MIN_REDUCTION_RATIO),
		timeoutMs: finiteNumber(settings.timeoutMs, DEFAULT_TIMEOUT_MS, 1),
	};
}

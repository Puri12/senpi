/**
 * Jev compaction: settings. Read from `compaction.jev` in settings.json, with
 * the API key resolved from the settings value or `TYPESAFE_API_KEY`.
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

export interface JevCompactionSettings {
	/** Route compaction through Jev instead of LLM summarization. Default: true when a key resolves. */
	enabled?: boolean;
	/** Literal key or `$ENV_VAR` / `${ENV_VAR}`. Falls back to `TYPESAFE_API_KEY`. */
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

/** Interpolates `$NAME` / `${NAME}` against `env`; a literal passes through. */
export function resolveJevApiKey(raw: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
	const configured = nonEmptyString(raw);
	if (configured === undefined) return nonEmptyString(env[JEV_API_KEY_ENV]);
	const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(configured);
	if (!match) return configured;
	return nonEmptyString(env[match[1]!]);
}

export function resolveJevCompactionSettings(
	raw: unknown,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedJevCompactionSettings {
	const settings = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const apiKey = resolveJevApiKey(nonEmptyString(settings.apiKey), env);
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

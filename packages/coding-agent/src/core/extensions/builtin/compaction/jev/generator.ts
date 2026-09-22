/**
 * Jev compaction: the generator every compaction route calls instead of the
 * LLM summarizer.
 *
 * Given a compaction snapshot it scores the summarized span with Jev, prunes
 * it (drop / truncate / keep, all verbatim), renders the survivors as the
 * `summary`, and returns a `CompactionResult` whose `details` records every
 * decision. It never rewrites text. When Jev cannot run (no key, transport
 * failure, unfittable state, too little reduction) it throws
 * {@link JevCompactionError}; the routes classify that exactly like a failed
 * summarization so the deterministic fallback and circuit breaker keep working.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionPreparation, CompactionResult } from "../../../../compaction/index.ts";
import { applyJevDecisions, renderJevSummary, toJevTranscript } from "./adapter.ts";
import { decideJevTranscript, resolveJevOptions } from "./decide.ts";
import type { ResolvedJevCompactionSettings } from "./settings.ts";
import type { JevAsker, JevCallDecision, JevTranscriptMessage } from "./types.ts";

export const JEV_SUMMARY_SCHEMA = "senpi.compaction.jev.v1";

export type JevCompactionFailureKind =
	| "unavailable"
	| "aborted"
	| "transport"
	| "unfittable"
	| "insufficient-reduction";

export class JevCompactionError extends Error {
	readonly kind: JevCompactionFailureKind;
	constructor(kind: JevCompactionFailureKind, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "JevCompactionError";
		this.kind = kind;
	}
}

export interface JevCompactionDetails {
	schema: typeof JEV_SUMMARY_SCHEMA;
	origin?: "speculative" | "blocking" | "core-route";
	model: string;
	decisions: JevCallDecision[];
	stats: {
		messages: number;
		calls: number;
		kept: number;
		resultsDropped: number;
		callsDropped: number;
		pinned: number;
		charsBefore: number;
		charsAfter: number;
		reductionRatio: number;
		stateTokens: number;
		stateStage: string;
		requests: number;
		ms: number;
	};
	/** Present when a previous compaction summary was carried forward verbatim. */
	previousSummaryChars?: number;
}

export interface JevCompactionInput {
	preparation: Pick<
		CompactionPreparation,
		"messagesToSummarize" | "turnPrefixMessages" | "previousSummary" | "firstKeptEntryId" | "tokensBefore"
	>;
	settings: ResolvedJevCompactionSettings;
	asker: JevAsker;
	origin?: "speculative" | "blocking" | "core-route";
	signal?: AbortSignal;
}

function count(decisions: readonly JevCallDecision[], reason: JevCallDecision["reason"]): number {
	return decisions.filter((decision) => decision.reason === reason).length;
}

/**
 * Builds the transcript Jev scores: the previous summary (pinned, as the first
 * user message) followed by every message of the span, in order.
 */
export function buildJevSpan(preparation: JevCompactionInput["preparation"]): {
	transcript: JevTranscriptMessage[];
	source: AgentMessage[];
} {
	const source: AgentMessage[] = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
	const transcript = toJevTranscript(source);
	if (preparation.previousSummary) {
		transcript.unshift({ role: "user", text: preparation.previousSummary, toolUses: [], pinned: true });
	}
	return { transcript, source };
}

export async function generateJevCompaction(
	input: JevCompactionInput,
): Promise<CompactionResult<JevCompactionDetails>> {
	const started = Date.now();
	const { preparation, settings, asker, origin, signal } = input;
	if (signal?.aborted) throw new JevCompactionError("aborted", "compaction aborted before Jev was asked");
	const { transcript } = buildJevSpan(preparation);
	const options = resolveJevOptions({
		keepThreshold: settings.keepThreshold,
		truncateHeadChars: settings.truncateHeadChars,
		maxStateTokens: settings.maxStateTokens,
		maxRequestTokens: settings.maxRequestTokens,
		preserveRecentMessages: 0,
	});

	let run: Awaited<ReturnType<typeof decideJevTranscript>>;
	try {
		run = await decideJevTranscript(transcript, asker, options, signal);
	} catch (error) {
		if (signal?.aborted)
			throw new JevCompactionError("aborted", "compaction aborted while Jev was answering", { cause: error });
		const message = error instanceof Error ? error.message : String(error);
		if (/history too large for Jev|no room for questions/.test(message)) {
			throw new JevCompactionError("unfittable", message, { cause: error });
		}
		throw new JevCompactionError("transport", message, { cause: error });
	}
	if (signal?.aborted) throw new JevCompactionError("aborted", "compaction aborted after Jev answered");

	const pruned = applyJevDecisions(transcript, run.decisions, options.truncateHeadChars);
	const reductionRatio = pruned.charsBefore === 0 ? 0 : (pruned.charsBefore - pruned.charsAfter) / pruned.charsBefore;
	if (run.calls.some((call) => !call.pinned) && reductionRatio < settings.minReductionRatio) {
		throw new JevCompactionError(
			"insufficient-reduction",
			`Jev kept ${Math.round((1 - reductionRatio) * 100)}% of the span (minimum reduction ${Math.round(settings.minReductionRatio * 100)}%)`,
		);
	}

	const summary = renderJevSummary(pruned.messages);
	if (summary.trim().length === 0) {
		throw new JevCompactionError("insufficient-reduction", "Jev left nothing to carry forward");
	}

	const details: JevCompactionDetails = {
		schema: JEV_SUMMARY_SCHEMA,
		...(origin ? { origin } : {}),
		model: settings.model,
		decisions: run.decisions,
		stats: {
			messages: transcript.length,
			calls: run.calls.length,
			kept: count(run.decisions, "kept"),
			resultsDropped: count(run.decisions, "result_dropped"),
			callsDropped: count(run.decisions, "call_dropped"),
			pinned: count(run.decisions, "pinned"),
			charsBefore: pruned.charsBefore,
			charsAfter: pruned.charsAfter,
			reductionRatio,
			stateTokens: run.stateTokens,
			stateStage: run.stateStage,
			requests: run.requests,
			ms: Date.now() - started,
		},
		...(preparation.previousSummary ? { previousSummaryChars: preparation.previousSummary.length } : {}),
	};

	return {
		summary,
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		details,
	};
}

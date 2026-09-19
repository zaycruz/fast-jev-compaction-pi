import type { FileOperations, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  compact,
  messageChars,
  resolveOptions,
} from "../vendor/fast-jev/compact.js";
import { buildJevRequest, parseJevResponse } from "../vendor/fast-jev/request.js";
import type {
  CompactResult,
  JevAsker,
  JevQuestions,
  JevResponse,
  JevState,
  Message,
} from "../vendor/fast-jev/types.js";
import {
  computeFileLists,
  DETAILS_KEY,
  DETAILS_VERSION,
  findPreviousCompaction,
  type FastJevDetails,
  type PreviousCompaction,
} from "./continuity.js";
import { renderSummary } from "./render.js";
import type { FastJevConfig } from "./config.js";

/** pi's `Usage` shape, so Jev work lands in session totals. */
export interface JevUsageRecord {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/** Everything the pure compaction run needs; no pi runtime types required to test it. */
export interface CompactionRun {
  /** Resolved previous state: a pruned transcript, or a built-in summary text. */
  previous?: PreviousCompaction;
  /** pi's summarized span (messagesToSummarize + turnPrefixMessages), converted. */
  spanMessages: readonly Message[];
  /** File operations pi extracted from the span, for cumulative tracking. */
  fileOps?: FileOperations;
  /** `/compact` focus instructions; folded into the Jev goal. */
  customInstructions?: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  config: FastJevConfig;
  asker: JevAsker;
}

export interface CompactionEntryData {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: JevUsageRecord;
  details: {
    readFiles: string[];
    modifiedFiles: string[];
    [DETAILS_KEY]: FastJevDetails & {
      stats: CompactResult["stats"];
      decisions: CompactResult["decisions"];
    };
  };
}

export interface CompactionOutcome {
  ok: boolean;
  /** Why the extension declined; pi's built-in compaction runs instead. */
  reason?: string;
  entry?: CompactionEntryData;
  result?: CompactResult;
  /** Character reduction on the summarized span (0..1). */
  spanReduction?: number;
  spanMessagesBefore?: number;
  spanMessagesAfter?: number;
  usage?: JevUsageRecord;
}

const DEFAULT_MIN_REDUCTION = 0.25;
const DEFAULT_TIMEOUT_MS = 120_000;

export function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * One-call wrapper used by the extension entry point: resolves the previous
 * compaction state from the branch entries, then runs the compaction over it
 * plus the new span.
 */
export async function compactFromSession(
  branchEntries: readonly SessionEntry[],
  run: Omit<CompactionRun, "previous">,
): Promise<CompactionOutcome & { previous?: PreviousCompaction }> {
  const previous = findPreviousCompaction(branchEntries);
  const outcome = await runFastJevCompaction({ ...run, previous });
  return { ...outcome, previous };
}

/**
 * Builds the Jev asker over `fetch`, honouring pi's abort signal and an
 * optional per-request timeout. `fetchImpl` is injectable for tests.
 */
export function createJevAsker(
  options: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    requestTimeoutMs?: number;
    fetchImpl?: typeof fetch;
  },
  signal?: AbortSignal,
): JevAsker {
  if (!options.apiKey) {
    throw new Error(
      "TYPESAFE_API_KEY is not configured (set it in the environment or fast-jev-compaction.json)",
    );
  }
  const fetcher = options.fetchImpl ?? fetch;
  const apiKey: string = options.apiKey;
  const timeoutMs = finite(options.requestTimeoutMs, DEFAULT_TIMEOUT_MS);
  return {
    async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
      const request = buildJevRequest(
        { apiKey, model: options.model, baseUrl: options.baseUrl },
        state,
        questions,
      );
      let abort = signal;
      const signalCtor = AbortSignal as unknown as {
        any?: (...signals: AbortSignal[]) => AbortSignal;
      };
      if (timeoutMs > 0 && typeof signalCtor.any === "function") {
        const timeout = AbortSignal.timeout(timeoutMs);
        abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
      }
      const response = await fetcher(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: abort,
      });
      return parseJevResponse(response.status, response.ok, await response.text());
    },
  };
}

/** True for user cancellation and per-request timeouts; both fall back quietly-ish. */
export function isAbortLike(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/**
 * The transcript Jev sees this round: the oldest context first (a previous
 * built-in summary as a pinned call-less message, or the previous pruned
 * transcript), then pi's new span. Only one of the two base forms can exist.
 */
export function buildTranscript(
  previous: PreviousCompaction | undefined,
  spanMessages: readonly Message[],
): Message[] {
  const base: Message[] = [];
  if (previous?.summaryText !== undefined && previous.summaryText.trim().length > 0) {
    base.push({
      role: "user",
      text: `[Previous compaction summary]\n\n${previous.summaryText}`,
      toolUses: [],
    });
  }
  base.push(...(previous?.messages ?? []));
  return [...base, ...spanMessages];
}

function combinedGoal(run: CompactionRun): string | undefined {
  const parts = [
    run.config.goal?.trim(),
    run.customInstructions !== undefined && run.customInstructions.trim().length > 0
      ? `User asked to focus the compaction on: ${run.customInstructions.trim()}`
      : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Reduction on the summarized span only. Base messages count as unchanged
 * (rebuilt ones even inflate `after`), so the number understates what Jev
 * removed this round — a conservative gate before replacing pi's summary.
 */
export function spanReductionRatio(
  baseMessages: readonly Message[],
  spanMessages: readonly Message[],
  result: CompactResult,
): {
  ratio: number;
  before: number;
  after: number;
  messagesBefore: number;
  messagesAfter: number;
} {
  const baseSet = new Set<object>(baseMessages);
  const before = spanMessages.reduce((sum, message) => sum + messageChars(message), 0);
  const kept = result.messages.filter((message) => !baseSet.has(message));
  const after = kept.reduce((sum, message) => sum + messageChars(message), 0);
  return {
    ratio: before === 0 ? 0 : (before - after) / before,
    before,
    after,
    messagesBefore: spanMessages.length,
    messagesAfter: kept.length,
  };
}

function toPiUsage(
  usage: { input: number; output: number } | undefined,
): JevUsageRecord | undefined {
  if (!usage) return undefined;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: usage.input + usage.output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** One-line stats summary for notifications, in the spirit of the Claude Code plugin. */
export function describeOutcome(outcome: CompactionOutcome): string {
  if (!outcome.ok) return outcome.reason ?? "declined";
  const { stats } = outcome.result!;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : "",
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : "",
    stats.callsDropped > 0 ? `${stats.callsDropped} calls dropped` : "",
    stats.pinned > 0 ? `${stats.pinned} pinned` : "",
  ].filter(Boolean);
  return `${percent(outcome.spanReduction ?? 0)} of the span; ${
    parts.join(", ") || "no tool calls"
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

/**
 * Runs fast-jev over base + span and returns either the pi compaction entry
 * data or a decline (fall back to pi's built-in summary). Throws when Jev
 * fails or the history cannot be fitted — callers treat that as fallback too.
 */
export async function runFastJevCompaction(run: CompactionRun): Promise<CompactionOutcome> {
  const options = resolveOptions({
    keepThreshold: run.config.keepThreshold,
    // pi's keepRecentTokens cut already keeps the newest messages out of the
    // span, so the adapter defaults the library's pin to 0 instead of 6.
    preserveRecentMessages: run.config.preserveRecentMessages ?? 0,
    maxStateTokens: run.config.maxStateTokens,
    maxRequestTokens: run.config.maxRequestTokens,
    truncateHeadChars: run.config.truncateHeadChars,
    goal: combinedGoal(run),
  });

  const usage = { input: 0, output: 0, seen: false };
  const asker: JevAsker = {
    async ask(state, questions) {
      const response = await run.asker.ask(state, questions);
      usage.seen = true;
      usage.input += response.usage?.input_tokens ?? 0;
      usage.output += response.usage?.output_tokens ?? 0;
      return response;
    },
  };

  const transcript = buildTranscript(run.previous, run.spanMessages);
  const result = await compact(transcript, asker, options);

  const minReduction = Math.min(
    1,
    Math.max(0, finite(run.config.minReductionRatio, DEFAULT_MIN_REDUCTION)),
  );
  const span = spanReductionRatio(run.previous?.messages ?? [], run.spanMessages, result);
  const jevUsage = toPiUsage(usage.seen ? usage : undefined);
  if (span.ratio < minReduction) {
    const detail =
      result.stats.calls === 0
        ? "no tool calls to prune"
        : result.stats.calls === result.stats.pinned
          ? "all tool calls pinned (first or newest messages)"
          : `below ${percent(minReduction)} minimum: ${percent(span.ratio)} on the summarized span`;
    return {
      ok: false,
      reason: detail,
      result,
      spanReduction: span.ratio,
      spanMessagesBefore: span.messagesBefore,
      spanMessagesAfter: span.messagesAfter,
      usage: jevUsage,
    };
  }

  return {
    ok: true,
    entry: {
      summary: renderSummary(result.messages),
      firstKeptEntryId: run.firstKeptEntryId,
      tokensBefore: run.tokensBefore,
      usage: jevUsage,
      details: {
        ...computeFileLists(run.previous, run.fileOps),
        [DETAILS_KEY]: {
          version: DETAILS_VERSION,
          messages: result.messages,
          stats: result.stats,
          decisions: result.decisions,
        },
      },
    },
    result,
    spanReduction: span.ratio,
    spanMessagesBefore: span.messagesBefore,
    spanMessagesAfter: span.messagesAfter,
    usage: jevUsage,
  };
}

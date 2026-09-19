import type { FileOperations, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  applyDecisions,
  batchCalls,
  compact,
  decideCall,
  messageChars,
  questionsFor,
  reductionRatio,
  resolveOptions,
} from "../vendor/fast-jev/compact.js";
import { buildJevRequest, noulAnswer, parseJevResponse } from "../vendor/fast-jev/request.js";
import { collectToolCalls, fitState } from "../vendor/fast-jev/state.js";
import type {
  CallDecision,
  CompactResult,
  JevAsker,
  JevQuestions,
  JevResponse,
  JevState,
  Message,
  ToolCall,
  ToolUse,
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
 * The Vercel AI Gateway normalizes evaluation models: questions arrive as
 * `boolean` (not TypeSafe's native `noul`) and the model id travels in a
 * header. These two functions adapt the vendored core's shapes in both
 * directions, so the rest of the pipeline stays untouched.
 */
const GATEWAY_PROTOCOL_VERSION = "0.0.1";
const GATEWAY_SPEC_VERSION = "4";

export function gatewayRequestBody(questions: JevQuestions): {
  questions: Record<string, unknown>;
} {
  const mapped: Record<string, unknown> = {};
  for (const [name, question] of Object.entries(questions)) {
    mapped[name] =
      question.type === "noul"
        ? { type: "boolean", instructions: question.instructions, criteria: question.criteria }
        : question;
  }
  return { questions: mapped };
}

export function gatewayAnswerToNoul(answer: unknown, name: string): number {
  if (answer && typeof answer === "object") {
    const record = answer as Record<string, unknown>;
    for (const key of ["noul", "probability", "score"]) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
  }
  throw new Error(`Invalid gateway answer for ${name}`);
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
    gateway?: boolean;
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
  const gateway = (options as { gateway?: boolean }).gateway === true;
  return {
    async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
      let url: string;
      let headers: Record<string, string>;
      let body: string;
      if (gateway) {
        url = `${(options.baseUrl ?? "https://ai-gateway.vercel.sh/v4/ai").replace(/\/$/, "")}/evaluation-model`;
        headers = {
          authorization: `Bearer ${apiKey}`,
          "ai-gateway-protocol-version": GATEWAY_PROTOCOL_VERSION,
          "ai-gateway-auth-method": "api-key",
          "ai-model-id": options.model ?? "typesafe-ai/jev",
          "ai-evaluation-model-specification-version": GATEWAY_SPEC_VERSION,
          "content-type": "application/json",
        };
        body = JSON.stringify({ state, questions: gatewayRequestBody(questions).questions });
      } else {
        const request = buildJevRequest(
          { apiKey, model: options.model, baseUrl: options.baseUrl },
          state,
          questions,
        );
        url = request.url;
        headers = request.headers;
        body = request.body;
      }
      let abort = signal;
      const signalCtor = AbortSignal as unknown as {
        any?: (...signals: AbortSignal[]) => AbortSignal;
      };
      if (timeoutMs > 0 && typeof signalCtor.any === "function") {
        const timeout = AbortSignal.timeout(timeoutMs);
        abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
      }
      const response = await fetcher(url, {
        method: "POST",
        headers,
        body,
        signal: abort,
      });
      const text = await response.text();
      if (!gateway) return parseJevResponse(response.status, response.ok, text);
      if (!response.ok) {
        throw new Error(`Gateway request failed (${response.status}): ${text.slice(0, 200)}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("Gateway returned malformed JSON");
      }
      if (!parsed || typeof parsed !== "object" || !(parsed as Record<string, unknown>).answers) {
        throw new Error("Gateway response is missing answers");
      }
      const raw = parsed as {
        answers: Record<string, unknown>;
        usage?: { inputTokens?: unknown; outputTokens?: unknown };
      };
      const answers: Record<string, { type?: "noul"; noul: number }> = {};
      for (const [name, answer] of Object.entries(raw.answers)) {
        answers[name] = { type: "noul", noul: gatewayAnswerToNoul(answer, name) };
      }
      const inputTokens = typeof raw.usage?.inputTokens === "number" ? raw.usage.inputTokens : 0;
      const outputTokens = typeof raw.usage?.outputTokens === "number" ? raw.usage.outputTokens : 0;
      return {
        answers,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      };
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

const INPUT_QUESTION = (call: { tool: string; input: Record<string, unknown> }): JevQuestions[string] => ({
  type: "noul",
  instructions: `The input of this ${call.tool} call is worth keeping verbatim in the compacted history: it records exact details (paths, commands, identifiers) the assistant would need later and could not cheaply reconstruct by re-running the tool`,
});

/** One batch of questions to Jev, mirroring the vendored `compact` loop and
 * adding the per-call input-retention question when Jev gates tombstoning. */
async function askQuestionsBatch(
  asker: JevAsker,
  state: Parameters<JevAsker["ask"]>[0],
  batch: readonly Parameters<typeof questionsFor>[0][],
  askInput: boolean,
): Promise<Map<string, { keepCall: number; keepResult: number; keepInput: number | undefined }>> {
  const questions: JevQuestions = {};
  for (const call of batch) {
    Object.assign(questions, questionsFor(call));
    if (askInput) questions[`input_${call.id}`] = INPUT_QUESTION(call);
  }
  const { answers } = await asker.ask(state, questions);
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noulAnswer(answers, `call_${call.id}`),
        keepResult: noulAnswer(answers, `result_${call.id}`),
        keepInput: askInput
          ? noulAnswerOrAbstain(answers, `input_${call.id}`)
          : undefined,
      },
    ]),
  );
}

/** A missing answer abstains (input kept, matching "always"); a malformed
 * one throws like every other answer. */
function noulAnswerOrAbstain(answers: Record<string, unknown>, name: string): number {
  const answer = (answers as Record<string, Record<string, unknown>>)[name];
  if (answer === undefined) return 1;
  return noulAnswer(answers as Record<string, { type?: "noul"; noul: number }>, name);
}

function tombstoneResultText(
  text: string,
  isError: boolean,
  headChars: number,
  errorTailChars: number,
): string {
  if (
    isError &&
    errorTailChars > 0 &&
    text.length > errorTailChars + 120
  ) {
    return `[fast-jev-compaction kept the last ${errorTailChars} of ${text.length} chars of this tool result (error); re-run the tool for the full log]\n${text.slice(-errorTailChars)}`;
  }
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : "";
  return `${head}[fast-jev-compaction truncated ${text.length - headChars} chars of this tool result${isError ? " (error)" : ""}; re-run the tool if needed]`;
}

/**
 * Mirrors the vendored `applyDecisions` exactly, plus tuned removals:
 * calls marked for tombstoning keep their one-line record (tool + input)
 * while their result collapses to a note; failing results keep their tail
 * when `errorTailChars` is set. With no tombstones and zero tail, output is
 * identical to the vendored function.
 */
export function applyDecisionsWithTuning(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  options: { headChars: number; tombstone: ReadonlySet<string>; errorTailChars: number },
): Message[] {
  const { headChars, tombstone, errorTailChars } = options;
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision["action"]>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== "keep") actions.set(call.tool_use_id, decision.action);
  }
  const resultText = (text: string, isError: boolean, action: CallDecision["action"], id: string): string => {
    const isTombstoned = action === "drop_call" && tombstone.has(id);
    if (action === "drop_result" || isTombstoned) {
      return tombstoneResultText(text, isError, headChars, isTombstoned ? errorTailChars : 0);
    }
    return text;
  };
  const kept: Message[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== "drop_call" || tombstone.has(tool.tool_use_id))
      .map((tool) => {
        const action = actions.get(tool.tool_use_id);
        if (action !== "drop_result" && !(action === "drop_call" && tombstone.has(tool.tool_use_id))) return tool;
        const text = resultText(tool.text ?? "", tool.isError ?? false, action ?? "drop_result", tool.tool_use_id);
        if ((tool.text ?? "") === text) return tool;
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: tool.input,
          text,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== "drop_call" || tombstone.has(result.tool_use_id))
      .map((result) => {
        const action = actions.get(result.tool_use_id);
        if (action !== "drop_result" && !(action === "drop_call" && tombstone.has(result.tool_use_id))) return result;
        const text = resultText(result.text, result.isError ?? false, action ?? "drop_result", result.tool_use_id);
        return text === result.text
          ? result
          : {
              tool_use_id: result.tool_use_id,
              text,
              isError: result.isError,
            };
      });
    if (
      !message.toolUses.some(
        (tool) => actions.get(tool.tool_use_id) === "drop_call" && !tombstone.has(tool.tool_use_id),
      ) &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === "drop_call" && !tombstone.has(result.tool_use_id),
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every((result, index) => result === message.toolResults?.[index])
    ) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

/**
 * The vendored `compact` pipeline, with two extension points: when
 * `preserveCallInputs` is on, calls Jev voted to drop entirely keep a
 * one-line record (tool + input) and only lose the result (failing results
 * keep their tail when `preserveErrorTails` is set). Everything else —
 * fitting, batching, decisions, stats — mirrors the vendored loop exactly.
 */
async function compactWithTuning(
  messages: readonly Message[],
  asker: JevAsker,
  options: Parameters<typeof resolveOptions>[0],
  preserveCallInputs: boolean,
  errorTailChars: number,
  inputRetention: "always" | "jev",
  inputRetentionThreshold: number,
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);

  let fitted = { tokens: 0, stage: "" };
  let requestCount = 0;
  const answers = new Map<string, { keepCall: number; keepResult: number; keepInput: number | undefined }>();
  const askInput = preserveCallInputs && inputRetention === "jev";
  if (candidates.length > 0) {
    const state = fitState(messages, calls, resolved);
    fitted = state;
    const batches = batchCalls(candidates, state.tokens, resolved);
    requestCount = batches.length;
    const answered = await Promise.all(
      batches.map((batch) => askQuestionsBatch(asker, state.state, batch, askInput)),
    );
    for (const map of answered) {
      for (const [id, answer] of map) answers.set(id, answer);
    }
  }

  const decisions = calls.map((call) => {
    const answer = answers.get(call.id) ?? { keepCall: 1, keepResult: 1, keepInput: undefined };
    const decision = decideCall(call, answer, resolved);
    return answer.keepInput !== undefined ? { ...decision, keepInput: answer.keepInput } : decision;
  });
  const tombstone = new Set<string>(
    preserveCallInputs
      ? decisions
          .filter((d) => d.action === "drop_call")
          .filter((d) => {
            const keepInput = (d as { keepInput?: number }).keepInput;
            return keepInput === undefined || keepInput >= inputRetentionThreshold;
          })
          .map((d) => calls.find((c) => c.id === d.id)?.tool_use_id ?? "")
      : [],
  );
  tombstone.delete("");
  const kept = applyDecisionsWithTuning(messages, decisions, calls, {
    headChars: resolved.truncateHeadChars,
    tombstone,
    errorTailChars: errorTailChars,
  });
  const tombstonedCount = [...tombstone].length;
  const count = (reason: (typeof decisions)[number]["reason"]) =>
    decisions.filter((decision) => decision.reason === reason).length;
  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      calls: calls.length,
      kept: count("kept"),
      resultsDropped: count("result_dropped") + tombstonedCount,
      callsDropped: count("call_dropped") - tombstonedCount,
      pinned: count("pinned"),
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests: requestCount,
      ms: Date.now() - started,
    },
  };
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
  const result = await compactWithTuning(
    transcript,
    asker,
    options,
    run.config.preserveCallInputs === true,
    finite(run.config.preserveErrorTails, 0),
    run.config.inputRetention ?? "always",
    finite(run.config.inputRetentionThreshold, 0.2),
  );
  void reductionRatio;

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

/**
 * fast-jev-compaction for pi
 *
 * A pi extension version of https://github.com/tamaratran/fast-jev-compaction
 * (a Claude Code plugin). It hooks `session_before_compact` and replaces the
 * built-in LLM compaction summary with Jev decisions: every tool call and
 * result of the summarized span is scored, stale ones are dropped or
 * truncated, and everything kept stays verbatim — user and assistant text is
 * never rewritten.
 *
 * On any failure (missing API key, Jev error, not enough reduction) it
 * declines and pi's built-in summary runs.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfigFiles, resolveApiKey } from "./lib/config.js";
import { toFastJevMessages } from "./lib/convert.js";
import {
  compactFromSession,
  createJevAsker,
  describeOutcome,
  isAbortLike,
} from "./lib/handler.js";

export default function fastJevCompaction(pi: ExtensionAPI) {
  let warnedNoKey = false;
  let lastOutcome: string | undefined;

  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, branchEntries, customInstructions, reason, signal } = event;

    // Explicit `/compact` instructions ask for a focused summary; that is the
    // built-in compaction's job. Auto compaction never has instructions.
    if (reason === "manual" && customInstructions !== undefined && customInstructions.trim().length > 0) {
      ctx.ui.notify("fast-jev-compaction: /compact instructions given — using built-in summary", "info");
      return;
    }
    if (preparation.messagesToSummarize.length === 0 && preparation.turnPrefixMessages.length === 0) {
      return;
    }

    let config;
    try {
      config = loadConfigFiles(ctx.cwd).config;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`fast-jev-compaction: invalid config — falling back to built-in summary (${message})`, "error");
      return;
    }
    const apiKey = resolveApiKey(config);
    if (!apiKey) {
      if (!warnedNoKey) {
        warnedNoKey = true;
        ctx.ui.notify(
          "fast-jev-compaction: no TYPESAFE_API_KEY configured — using built-in compaction",
          "info",
        );
      }
      return;
    }

    try {
      const outcome = await compactFromSession(branchEntries, {
        spanMessages: toFastJevMessages([
          ...preparation.messagesToSummarize,
          ...preparation.turnPrefixMessages,
        ]),
        fileOps: preparation.fileOps,
        customInstructions,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        config,
        asker: createJevAsker({ ...config, apiKey }, signal),
      });

      if (!outcome.ok) {
        lastOutcome = `fallback (${describeOutcome(outcome)})`;
        ctx.ui.notify(`fast-jev-compaction: fallback to built-in summary (${describeOutcome(outcome)})`, "info");
        return;
      }

      lastOutcome = describeOutcome(outcome);
      ctx.ui.notify(`fast-jev-compaction: verbatim compaction (${lastOutcome})`, "info");
      ctx.ui.setStatus("fast-jev", `-${Math.round((outcome.spanReduction ?? 0) * 100)}% span`);
      return { compaction: outcome.entry };
    } catch (error) {
      if (isAbortLike(error)) {
        // User cancelled the compaction (or a request timed out); pi's default
        // flow proceeds — cancelled compactions abort there as well.
        if (!signal?.aborted) {
          ctx.ui.notify("fast-jev-compaction: Jev timed out — using built-in summary", "warning");
        }
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`fast-jev-compaction: fallback to built-in summary (${message})`, "warning");
      return;
    }
  });

  pi.registerCommand("fast-jev-status", {
    description: "Show fast-jev-compaction configuration and last compaction outcome",
    handler: async (_args, ctx) => {
      const lines: string[] = [];
      try {
        const { config, paths } = loadConfigFiles(ctx.cwd);
        lines.push(`config: ${paths.length > 0 ? paths.join(", ") : "no config files (defaults)"}`);
        lines.push(
          `api key: ${resolveApiKey(config) ? "configured" : "missing — set TYPESAFE_API_KEY or apiKey in the config"}`,
        );
        lines.push(
          `model: ${config.model ?? "jev-latest"} · keepThreshold: ${config.keepThreshold ?? 0.5} · preserveRecentMessages: ${config.preserveRecentMessages ?? 0}`,
        );
        lines.push(
          `minReductionRatio: ${config.minReductionRatio ?? 0.25} · truncateHeadChars: ${config.truncateHeadChars ?? 300} · requestTimeoutMs: ${config.requestTimeoutMs ?? 120000}`,
        );
        lines.push(
          `maxStateTokens: ${config.maxStateTokens ?? 25000} · maxRequestTokens: ${config.maxRequestTokens ?? 30000}`,
        );
        if (config.goal) lines.push(`goal: ${config.goal}`);
      } catch (error) {
        lines.push(`config error: ${error instanceof Error ? error.message : String(error)}`);
      }
      lines.push(`last compaction: ${lastOutcome ?? "none yet this session"}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

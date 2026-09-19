import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfigFiles, resolveApiKey, sanitizeConfig, type FastJevConfig } from "../lib/config.js";
import {
  computeFileLists,
  DETAILS_KEY,
  DETAILS_VERSION,
  findPreviousCompaction,
  isValidFastJevDetails,
  type FastJevDetails,
  type PreviousCompaction,
} from "../lib/continuity.js";
import { toFastJevMessages } from "../lib/convert.js";
import {
  buildTranscript,
  createJevAsker,
  describeOutcome,
  isAbortLike,
  percent,
  runFastJevCompaction,
  spanReductionRatio,
  type CompactionOutcome,
} from "../lib/handler.js";
import { renderSummary } from "../lib/render.js";
import { applyDecisionsWithTuning } from "../lib/handler.js";
import { applyDecisions as vendoredApply } from "../vendor/fast-jev/compact.js";
import { collectToolCalls, estimateTokens, fitState } from "../vendor/fast-jev/state.js";
import { questionsFor } from "../vendor/fast-jev/compact.js";
import type { JevAsker, JevQuestions, JevState, Message } from "../vendor/fast-jev/types.js";

function userMessage(text: string): Message {
  return { role: "user", text, toolUses: [] };
}

function assistantMessage(text: string, toolUses: Message["toolUses"] = []): Message {
  return { role: "assistant", text, toolUses };
}

function toolResult(id: string, text: string, isError = false): Message {
  return { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: id, text, isError }] };
}

function span(): Message[] {
  return [
    userMessage("Fix the failing test. Never touch src/generated."),
    assistantMessage("reading a.ts", [{ tool_use_id: "u1", tool: "read", input: { file_path: "a.ts" }, text: "x".repeat(2000) }]),
    toolResult("u1", "x".repeat(2000)),
    assistantMessage("fixed it"),
  ];
}

type Seen = { state: JevState; questions: string[] };

function fakeJev(
  answer: (name: string) => number,
  seen: Seen[] = [],
  usage?: { input_tokens: number; output_tokens: number },
): JevAsker {
  return {
    async ask(state, questions: JevQuestions) {
      seen.push({ state, questions: Object.keys(questions) });
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [key, { type: "noul" as const, noul: answer(key) }]),
        ),
        usage,
      };
    },
  };
}

const baseConfig: FastJevConfig = {
  apiKey: "k",
  preserveRecentMessages: 0,
  minReductionRatio: 0.25,
};

function runFor(spanMessages: Message[], asker: JevAsker, extra: Partial<Parameters<typeof runFastJevCompaction>[0]> = {}) {
  return runFastJevCompaction({
    spanMessages,
    firstKeptEntryId: "kept-1",
    tokensBefore: 12345,
    config: baseConfig,
    asker,
    ...extra,
  });
}

describe("toFastJevMessages", () => {
  it("maps user, assistant and toolResult messages", () => {
    const piMessages = [
      { role: "user", content: "Fix the test", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me look" },
          { type: "text", text: "reading a.ts" },
          { type: "toolCall", id: "u1", name: "read", arguments: { file_path: "a.ts" } },
        ],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "u1",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        isError: true,
        timestamp: 3,
      },
      { role: "user", content: [{ type: "text", text: "and an image" }, { type: "image", data: "…", mimeType: "image/png" }], timestamp: 4 },
    ];
    expect(toFastJevMessages(piMessages)).toEqual([
      { role: "user", text: "Fix the test", toolUses: [] },
      {
        role: "assistant",
        text: "reading a.ts",
        toolUses: [{ tool_use_id: "u1", tool: "read", input: { file_path: "a.ts" } }],
      },
      {
        role: "user",
        text: "",
        toolUses: [],
        toolResults: [{ tool_use_id: "u1", text: "file contents", isError: true }],
      },
      { role: "user", text: "and an image\n[image]", toolUses: [] },
    ]);
  });

  it("normalizes bash executions and custom messages into user text", () => {
    const piMessages = [
      { role: "bashExecution", command: "npm test", output: "all green", exitCode: 0, cancelled: false, timestamp: 1 },
      { role: "custom", customType: "note", content: "a custom note", timestamp: 2 },
    ];
    const messages = toFastJevMessages(piMessages);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user" });
    expect(messages[0]!.text).toContain("npm test");
    expect(messages[0]!.text).toContain("all green");
    expect(messages[1]).toMatchObject({ role: "user", text: "a custom note" });
  });
});

describe("renderSummary", () => {
  it("renders kept content verbatim with truncation notes and drops removed calls", () => {
    // As applyDecisions would have left it: the u1 call and result are gone,
    // the u2 result carries the truncation note.
    const messages = [
      userMessage("Fix the failing test."),
      assistantMessage("reading", [
        { tool_use_id: "u2", tool: "bash", input: { command: "npm test" }, text: "FAIL" },
      ]),
      toolResult(
        "u2",
        `FAIL\n[fast-jev-compaction truncated 40 chars of this tool result; re-run the tool if needed]`,
        true,
      ),
    ];
    const summary = renderSummary(messages);
    expect(summary).toContain('<compacted-conversation engine="fast-jev-compaction">');
    expect(summary).toContain("</compacted-conversation>");
    expect(summary).toContain("Fix the failing test.");
    expect(summary).toContain("reading");
    expect(summary).toContain('[tool call bash] {"command":"npm test"}');
    expect(summary).toContain("[tool result u2 · error]");
    expect(summary).toContain("truncated 40 chars");
    expect(summary).not.toContain("u1"); // dropped call and result leave no trace
    expect(summary).not.toContain('"file_path":"a.ts"');
  });

  it("skips empty structural leftovers", () => {
    const summary = renderSummary([
      userMessage("hi"),
      { role: "assistant", text: "", toolUses: [] },
      toolResult("u9", ""),
    ]);
    expect(summary).toContain("--- [1] user ---");
    expect(summary).toContain("--- [2] tool result ---");
    expect(summary).not.toContain("[3]");
    expect(summary).toContain("[tool result u9]");
    expect(summary).toContain("(empty result)");
  });
});

describe("continuity", () => {
  const pruned: Message[] = [userMessage("old transcript")];

  function entryWith(details: unknown, summary = "built-in summary text") {
    return { type: "compaction", id: "c1", summary, firstKeptEntryId: "k", tokensBefore: 10, details, timestamp: 0 };
  }

  it("recovers a structured transcript from a previous fast-jev compaction", () => {
    const details = {
      [DETAILS_KEY]: { version: DETAILS_VERSION, messages: pruned },
      readFiles: ["a.ts"],
      modifiedFiles: ["b.ts"],
    };
    const previous = findPreviousCompaction([entryWith(details) as never]);
    expect(previous).toEqual({ messages: pruned, readFiles: ["a.ts"], modifiedFiles: ["b.ts"] });
  });

  it("falls back to the summary text for built-in compactions", () => {
    const previous = findPreviousCompaction([entryWith({ readFiles: ["x.ts"] }) as never]);
    expect(previous).toEqual({ summaryText: "built-in summary text", readFiles: ["x.ts"], modifiedFiles: [] });
  });

  it("falls back to the summary text when the stored state is corrupt", () => {
    const corrupt = { [DETAILS_KEY]: { version: 99, messages: "nope" } };
    expect(isValidFastJevDetails(corrupt[DETAILS_KEY])).toBe(false);
    const previous = findPreviousCompaction([entryWith(corrupt) as never]);
    expect(previous?.summaryText).toBe("built-in summary text");
  });

  it("returns undefined without compaction entries", () => {
    expect(findPreviousCompaction([{ type: "message", id: "m", timestamp: 0 } as never])).toBeUndefined();
  });

  it("unions file ops cumulatively, read minus modified", () => {
    const previous: PreviousCompaction = { readFiles: ["old-read.ts", "now-edited.ts"], modifiedFiles: ["old-mod.ts"] };
    const fileOps = { read: new Set(["new-read.ts"]), written: new Set(["new-write.ts"]), edited: new Set(["now-edited.ts"]) };
    expect(computeFileLists(previous, fileOps)).toEqual({
      readFiles: ["new-read.ts", "old-read.ts"],
      modifiedFiles: ["new-write.ts", "now-edited.ts", "old-mod.ts"],
    });
  });
});

describe("buildTranscript", () => {
  it("puts the previous summary text first as a pinned call-less message", () => {
    const previous: PreviousCompaction = { summaryText: "old summary", readFiles: [], modifiedFiles: [] };
    const transcript = buildTranscript(previous, [userMessage("new span")]);
    expect(transcript).toHaveLength(2);
    expect(transcript[0]).toMatchObject({ role: "user", text: "[Previous compaction summary]\n\nold summary" });
    expect(transcript[0]!.toolUses).toHaveLength(0);
  });

  it("puts the previous pruned transcript first when it is structured", () => {
    const previous: PreviousCompaction = { messages: [userMessage("old transcript")], readFiles: [], modifiedFiles: [] };
    const transcript = buildTranscript(previous, [userMessage("new span")]);
    expect(transcript.map((m) => m.text)).toEqual(["old transcript", "new span"]);
  });
});

describe("spanReductionRatio", () => {
  it("measures the span only and treats the base as unchanged", () => {
    const base = [userMessage("z".repeat(1000))];
    const span = [userMessage("s".repeat(100)), toolResult("u1", "x".repeat(300))];
    const result = {
      stats: {},
      messages: [...base, userMessage("s".repeat(100))], // result dropped: 400 → 100 chars
    } as never;
    const measured = spanReductionRatio(base, span, result);
    expect(measured.before).toBe(400);
    expect(measured.after).toBe(100);
    expect(measured.ratio).toBeCloseTo(0.75);
    expect(measured.messagesBefore).toBe(2);
    expect(measured.messagesAfter).toBe(1);
  });
});

describe("runFastJevCompaction", () => {
  it("produces entry data, records usage, and stores state for the next compaction", async () => {
    const seen: Seen[] = [];
    const previous: PreviousCompaction = { messages: [userMessage("old transcript")], readFiles: ["old.ts"], modifiedFiles: [] };
    const outcome = await runFor(span(), fakeJev((name) => (name === "result_t1" ? 0.1 : 0.9), seen, { input_tokens: 500, output_tokens: 10 }), {
      previous,
      fileOps: { read: new Set(["b.ts"]), written: new Set(["c.ts"]), edited: new Set() },
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.entry).toBeDefined();
    expect(outcome.entry!.usage).toEqual({
      input: 500,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 510,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    expect(outcome.entry!.firstKeptEntryId).toBe("kept-1");
    expect(outcome.entry!.tokensBefore).toBe(12345);

    const details = outcome.entry!.details;
    expect(details.readFiles.sort()).toEqual(["b.ts", "old.ts"]);
    expect(details.modifiedFiles).toEqual(["c.ts"]);
    const fastJev = details[DETAILS_KEY] as FastJevDetails;
    expect(fastJev.version).toBe(DETAILS_VERSION);
    expect(fastJev.messages).toHaveLength(1 + span().length);
    expect(fastJev.messages[0]!.text).toBe("old transcript");
    expect((fastJev.stats as { resultsDropped: number }).resultsDropped).toBe(1);

    const summary = outcome.entry!.summary;
    expect(summary).toContain("Fix the failing test. Never touch src/generated.");
    expect(summary).toContain("truncated 1700 chars");
    expect(summary).not.toContain("x".repeat(2000));
  });

  it("keeps a previous built-in summary verbatim in the new transcript", async () => {
    const previous: PreviousCompaction = { summaryText: "the old llm summary", readFiles: [], modifiedFiles: [] };
    const seen: Seen[] = [];
    const outcome = await runFor(span(), fakeJev((name) => (name === "result_t1" ? 0.1 : 0.9), seen), { previous });
    expect(outcome.ok).toBe(true);
    expect(outcome.entry!.summary).toContain("[Previous compaction summary]");
    expect(outcome.entry!.summary).toContain("the old llm summary");
    expect(seen[0]!.state).toMatchObject({ goal: expect.any(String) });
    const history = (seen[0]!.state as { history: Array<{ text: string }> }).history;
    expect(history[0]!.text).toContain("the old llm summary");
  });

  it("declines when nothing can be pruned and when there are no tool calls", async () => {
    const keptEverything = await runFor(span(), fakeJev(() => 0.95));
    expect(keptEverything.ok).toBe(false);
    expect(keptEverything.reason).toMatch(/below 25% minimum: 0%/);

    const noCalls = await runFor([userMessage("just text")], fakeJev(() => 0.1));
    expect(noCalls.ok).toBe(false);
    expect(noCalls.reason).toBe("no tool calls to prune");

    const allPinned = await runFor(
      [userMessage("task"), assistantMessage("reading", [{ tool_use_id: "u1", tool: "read", input: {}, text: "x" }]), toolResult("u1", "x")],
      fakeJev(() => 0.1),
      { config: { ...baseConfig, preserveRecentMessages: 2 } },
    );
    expect(allPinned.ok).toBe(false);
    expect(allPinned.reason).toBe("all tool calls pinned (first or newest messages)");
  });

  it("folds custom instructions and the configured goal into the Jev goal", async () => {
    const seen: Seen[] = [];
    await runFor(span(), fakeJev((name) => (name === "result_t1" ? 0.1 : 0.9), seen), {
      customInstructions: "the auth work",
      config: { ...baseConfig, goal: "ship the release" },
    });
    const goal = (seen[0]!.state as { goal: string }).goal;
    expect(goal).toContain("ship the release");
    expect(goal).toContain("User asked to focus the compaction on: the auth work");
  });

  it("propagates Jev failures for the caller to fall back on", async () => {
    const failing: JevAsker = { ask: async () => ({ answers: { call_t1: { noul: 0.5 } } }) };
    await expect(runFor(span(), failing)).rejects.toThrow(/Invalid Jev answer/);
  });

  it("batches questions across requests and accumulates their usage", async () => {
    const messages: Message[] = [
      userMessage("Fix the failing test."),
      assistantMessage("reading", [{ tool_use_id: "u1", tool: "read", input: { file_path: "a.ts" }, text: "x".repeat(2000) }]),
      toolResult("u1", "x".repeat(2000)),
      assistantMessage("testing", [{ tool_use_id: "u2", tool: "bash", input: { command: "npm test" }, text: "FAIL" }]),
      toolResult("u2", "FAIL: expected 2 to be 3", true),
      assistantMessage("fixed it"),
    ];
    const stateTokens = fitState(messages, collectToolCalls(messages, 0), {
      maxStateTokens: 25_000,
      preserveRecentMessages: 0,
      goal: "g",
    }).tokens;
    const questionTokens = estimateTokens(
      JSON.stringify(
        questionsFor({
          id: "t1",
          tool_use_id: "u1",
          tool: "read",
          input: { file_path: "a.ts" },
          callIndex: 1,
          resultIndex: 2,
          resultChars: 2000,
          isError: false,
          pinned: false,
        }),
      ),
    );
    const seen: Seen[] = [];
    const outcome = await runFor(
      messages,
      fakeJev(
        (name) => (name === "result_t1" || name === "result_t2" ? 0.1 : 0.9),
        seen,
        { input_tokens: 100, output_tokens: 5 },
      ),
      { config: { ...baseConfig, maxRequestTokens: stateTokens + questionTokens + 25 } },
    );
    expect(seen.length).toBe(2);
    expect(outcome.usage).toMatchObject({ input: 200, output: 10 });
    expect(outcome.ok).toBe(true);
  });
});

describe("createJevAsker", () => {
  it("refuses to run without a key", () => {
    expect(() => createJevAsker({})).toThrow(/TYPESAFE_API_KEY/);
  });

  it("sends the built request through the injected fetch and parses answers", async () => {
    const inits: Array<RequestInit & { body?: string }> = [];
    const asker = createJevAsker(
      {
        apiKey: "k",
        model: "jev-x",
        requestTimeoutMs: 0,
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          inits.push({ ...init, body: String(init?.body) } as RequestInit & { body?: string });
          void url;
          return new Response(JSON.stringify({ answers: { q: { noul: 0.4 } }, usage: { input_tokens: 7, output_tokens: 3 } }), {
            status: 200,
          });
        }) as typeof fetch,
      },
      new AbortController().signal,
    );
    const response = await asker.ask("state", { q: { type: "noul", instructions: "x" } });
    expect(response.answers.q).toEqual({ noul: 0.4 });
    const body = JSON.parse(inits[0]!.body!) as { model: string };
    expect(body.model).toBe("jev-x");
  });

  it("surfaces HTTP failures so compaction falls back", async () => {
    const asker = createJevAsker({
      apiKey: "k",
      requestTimeoutMs: 0,
      fetchImpl: (async () => new Response("boom", { status: 500 })) as typeof fetch,
    });
    await expect(asker.ask("s", { q: { type: "noul", instructions: "x" } })).rejects.toThrow(/500/);
  });
});

describe("applyDecisionsWithTuning", () => {
  const calls = collectToolCalls(span(), 0);
  const dropAll = calls.map((c) => ({ ...c, keepCall: 0.2, keepResult: 0.2, action: "drop_call" as const, reason: "call_dropped" as const }));

  it("untuned: identical to the vendored applyDecisions", () => {
    const messages = span();
    const mine = applyDecisionsWithTuning(messages, dropAll, calls, { headChars: 300, tombstone: new Set(), errorTailChars: 0 });
    const vendored = vendoredApply(messages, dropAll, calls, 300);
    expect(mine).toEqual(vendored);
    expect(mine).toHaveLength(3);
  });

  it("tombstoned: call input survives, result collapses to a note", () => {
    const messages = span();
    const tombstone = new Set(calls.map((c) => c.tool_use_id));
    const kept = applyDecisionsWithTuning(messages, dropAll, calls, { headChars: 300, tombstone, errorTailChars: 0 });
    expect(kept).toHaveLength(messages.length);
    const summary = renderSummary(kept);
    expect(summary).toContain('[tool call read] {"file_path":"a.ts"}');
    expect(summary).toContain("truncated 1700 chars");
  });

  it("error tail: failing results keep their last characters", () => {
    const messages = [
      { role: "assistant" as const, text: "", toolUses: [{ tool_use_id: "e1", tool: "bash", input: { command: "cat log" }, text: "" }] },
      { role: "user" as const, text: "", toolUses: [], toolResults: [{ tool_use_id: "e1", text: `INFO ok\n`.repeat(100) + "UNIQUE-MIDDLE-MARKER\n" + `INFO ok\n`.repeat(100) + "FATAL 0xABCDEF12: boom\n  at handler (pipeline.ts:88)", isError: true }] },
    ];
    const errorCalls = collectToolCalls(messages, 0);
    const decisions = errorCalls.map((c) => ({ ...c, keepCall: 0.2, keepResult: 0.2, action: "drop_call" as const, reason: "call_dropped" as const }));
    const kept = applyDecisionsWithTuning(messages, decisions, errorCalls, {
      headChars: 300,
      tombstone: new Set(["e1"]),
      errorTailChars: 200,
    });
    const resultText = kept[1]!.toolResults![0]!.text;
    expect(resultText).toContain("kept the last 200 of");
    expect(resultText).toContain("FATAL 0xABCDEF12: boom");
    expect(resultText).not.toContain("UNIQUE-MIDDLE-MARKER");
  });
});

describe("compactWithTuning parity", () => {
  it("with tuning off, the whole result equals the vendored compact() output", async () => {
    const { compact } = await import("../vendor/fast-jev/compact.js");
    const messages = [
      ...span(),
      { role: "user" as const, text: "also check prod logs", toolUses: [] },
      { role: "assistant" as const, text: "checking", toolUses: [{ tool_use_id: "u2", tool: "bash", input: { command: "tail -100 prod.log" }, text: "" }] },
      { role: "user" as const, text: "", toolUses: [], toolResults: [{ tool_use_id: "u2", text: "ERR 1\n".repeat(400), isError: true }] },
      { role: "assistant" as const, text: "done", toolUses: [] },
    ];
    const asker = fakeJev((name) => (name === "result_t1" ? 0.1 : 0.9));
    const options = { keepThreshold: 0.5, preserveRecentMessages: 0, maxStateTokens: 25000, maxRequestTokens: 30000, truncateHeadChars: 300, goal: "g" };
    const mine = await runFastJevCompaction({
      spanMessages: messages,
      firstKeptEntryId: "k",
      tokensBefore: 1,
      config: { apiKey: "k", preserveCallInputs: false },
      asker,
    });
    const theirs = await compact(messages, asker, options);
    expect(mine.ok).toBe(true);
    expect(mine.result!.messages).toEqual(theirs.messages);
    expect(mine.result!.decisions).toEqual(theirs.decisions);
    expect(mine.result!.stats.messagesAfter).toBe(theirs.stats.messagesAfter);
    expect(mine.result!.stats.charsAfter).toBe(theirs.stats.charsAfter);
    expect(mine.result!.stats.requests).toBe(theirs.stats.requests);
    expect(mine.result!.stats.kept).toBe(theirs.stats.kept);
    expect(mine.result!.stats.resultsDropped).toBe(theirs.stats.resultsDropped);
    expect(mine.result!.stats.callsDropped).toBe(theirs.stats.callsDropped);
  });
});

describe("preserveCallInputs tuning", () => {
  function tunedRun(spanMessages: Message[], asker: JevAsker, preserve: boolean) {
    return runFastJevCompaction({
      spanMessages,
      firstKeptEntryId: "kept-1",
      tokensBefore: 100,
      config: { ...baseConfig, preserveCallInputs: preserve },
      asker,
    });
  }

  it("off: matches pure Jev decisions (calls dropped)", async () => {
    const outcome = await tunedRun(span(), fakeJev(() => 0.2), false);
    expect(outcome.ok).toBe(true);
    expect(outcome.result!.decisions.map((d) => d.action)).toEqual(["drop_call"]);
    expect(outcome.entry!.summary).not.toContain("[tool call read]");
    expect(outcome.entry!.summary).not.toContain('"file_path":"a.ts"');
  });

  it("on: dropped calls keep their one-line input, results become notes", async () => {
    const outcome = await tunedRun(span(), fakeJev(() => 0.2), true);
    expect(outcome.ok).toBe(true);
    const decision = outcome.result!.decisions[0]!;
    expect(decision.action).toBe("drop_call");
    expect(outcome.result!.stats.callsDropped).toBe(0);
    expect(outcome.result!.stats.resultsDropped).toBe(1);
    const summary = outcome.entry!.summary;
    expect(summary).toContain('[tool call read] {"file_path":"a.ts"}');
    expect(summary).toContain("truncated 1700 chars");
    expect(summary).not.toContain("x".repeat(2000));
    expect(outcome.result!.stats.resultsDropped).toBe(1);
    expect(outcome.result!.stats.callsDropped).toBe(0);
  });
});

describe("inputRetention: jev", () => {
  function gatedRun(answers: (name: string) => number) {
    return runFastJevCompaction({
      spanMessages: span(),
      firstKeptEntryId: "k",
      tokensBefore: 1,
      config: {
        apiKey: "k",
        preserveCallInputs: true,
        inputRetention: "jev",
        preserveErrorTails: 0,
      },
      asker: fakeJev(answers),
    });
  }

  it("input worth keeping: dropped call is tombstoned with its input", async () => {
    const outcome = await gatedRun((name) => (name.startsWith("input_") ? 0.9 : 0.2));
    expect(outcome.ok).toBe(true);
    expect(outcome.entry!.summary).toContain('[tool call read] {"file_path":"a.ts"}');
  });

  it("routine input: dropped call disappears entirely", async () => {
    const outcome = await gatedRun((name) => (name.startsWith("input_") ? 0.1 : 0.2));
    expect(outcome.ok).toBe(true);
    expect(outcome.entry!.summary).not.toContain("[tool call read]");
    expect(outcome.entry!.summary).not.toContain('"file_path":"a.ts"');
    expect(outcome.result!.stats.callsDropped).toBe(1);
  });

  it("missing input answer abstains to keep (always-mode behavior)", async () => {
    const asker: JevAsker = {
      ask: async (_state, questions) => ({
        answers: Object.fromEntries(
          Object.keys(questions)
            .filter((q) => !q.startsWith("input_"))
            .map((q) => [q, { type: "noul", noul: 0.2 }]),
        ),
      }),
    };
    const outcome = await runFastJevCompaction({
      spanMessages: span(),
      firstKeptEntryId: "k",
      tokensBefore: 1,
      config: { apiKey: "k", preserveCallInputs: true, inputRetention: "jev" },
      asker,
    });
    expect(outcome.entry!.summary).toContain('[tool call read]');
  });
});

describe("gateway transport", () => {
  const realFetch = (status: number, body: unknown) =>
    (async (_url: string | URL | Request, init?: RequestInit) => {
      void init;
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;

  it("maps noul questions to boolean and boolean answers back to noul", async () => {
    const inits: Array<RequestInit & { body?: string }> = [];
    const asker = createJevAsker(
      {
        apiKey: "gw-key",
        model: "typesafe-ai/jev",
        baseUrl: "https://ai-gateway.vercel.sh/v4/ai",
        gateway: true,
        requestTimeoutMs: 0,
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          inits.push({ ...init, body: String(init?.body) } as RequestInit & { body?: string });
          void url;
          return new Response(
            JSON.stringify({
              answers: { call_t1: { type: "boolean", probability: 0.75 }, result_t1: { type: "boolean", probability: 0.33 } },
              usage: { inputTokens: 472, outputTokens: 40 },
            }),
            { status: 200 },
          );
        }) as typeof fetch,
      },
    );
    const response = await asker.ask(
      { context: "c", goal: "g", history: [] },
      {
        call_t1: { type: "noul", instructions: "keep the call" },
        result_t1: { type: "noul", instructions: "keep the result" },
      },
    );
    expect(response.answers.call_t1).toEqual({ type: "noul", noul: 0.75 });
    expect(response.usage).toEqual({ input_tokens: 472, output_tokens: 40 });
    const body = JSON.parse(inits[0]!.body!) as { questions: Record<string, { type?: string; instructions?: string }> };
    const callQuestion = body.questions.call_t1;
    expect(callQuestion?.type).toBe("boolean");
    expect(callQuestion?.instructions).toBe("keep the call");
  });

  it("posts to the evaluation-model endpoint with gateway headers", async () => {
    let seenUrl = "";
    const asker = createJevAsker({
      apiKey: "gw-key",
      model: "typesafe-ai/jev",
      baseUrl: "https://ai-gateway.vercel.sh/v4/ai/",
      gateway: true,
      requestTimeoutMs: 0,
      fetchImpl: (async (url: string | URL | Request) => {
        seenUrl = String(url);
        return new Response(JSON.stringify({ answers: { q: { type: "boolean", probability: 0.5 } } }), { status: 200 });
      }) as typeof fetch,
    });
    await asker.ask("state", { q: { type: "noul", instructions: "x" } });
    expect(seenUrl).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
  });

  it("rejects missing or malformed answers so compaction falls back", async () => {
    const asker = createJevAsker({
      apiKey: "gw-key",
      gateway: true,
      requestTimeoutMs: 0,
      fetchImpl: realFetch(200, { answers: { q: { type: "choice", choice: "yes" } } }),
    });
    await expect(asker.ask("s", { q: { type: "noul", instructions: "x" } })).rejects.toThrow(/Invalid gateway answer/);
    const failing = createJevAsker({
      apiKey: "gw-key",
      gateway: true,
      requestTimeoutMs: 0,
      fetchImpl: realFetch(500, { error: "boom" }),
    });
    await expect(failing.ask("s", { q: { type: "noul", instructions: "x" } })).rejects.toThrow(/Gateway request failed \(500\)/);
  });

  it("noul passthrough still works for direct TypeSafe contracts", async () => {
    const asker = createJevAsker({
      apiKey: "gw-key",
      gateway: true,
      requestTimeoutMs: 0,
      fetchImpl: realFetch(200, { answers: { q: { noul: 0.8 } } }),
    });
    const response = await asker.ask("s", { q: { type: "noul", instructions: "x" } });
    expect(response.answers.q).toEqual({ type: "noul", noul: 0.8 });
  });
});

describe("abort classification", () => {
  it("recognizes cancellation and timeout errors", () => {
    const abort = new DOMException("aborted", "AbortError");
    const timeout = new DOMException("timed out", "TimeoutError");
    expect(isAbortLike(abort)).toBe(true);
    expect(isAbortLike(timeout)).toBe(true);
    expect(isAbortLike(new Error("nope"))).toBe(false);
  });
});

describe("describeOutcome and percent", () => {
  it("formats decline reasons and success stats", () => {
    expect(percent(0.256)).toBe("26%");
    const declined: CompactionOutcome = { ok: false, reason: "no tool calls to prune" };
    expect(describeOutcome(declined)).toBe("no tool calls to prune");
  });
});

describe("config", () => {
  it("merges project over global and reports the files it read", () => {
    const dir = mkdtempSync(join(tmpdir(), "fast-jev-test-"));
    const globalPath = join(dir, "global.json");
    const projectPath = join(dir, "project.json");
    writeFileSync(globalPath, JSON.stringify({ apiKey: "global-key", model: "jev-g", keepThreshold: 0.4 }));
    writeFileSync(projectPath, JSON.stringify({ model: "jev-p", minReductionRatio: 0.1 }));
    const { config, paths } = loadConfigFiles("/whatever", { globalPath, projectPath });
    expect(paths).toEqual([globalPath, projectPath]);
    expect(config).toEqual({ apiKey: "global-key", model: "jev-p", keepThreshold: 0.4, minReductionRatio: 0.1 });
  });

  it("sanitizes malformed values instead of crashing later", () => {
    const config = sanitizeConfig({
      apiKey: 42 as unknown as string,
      keepThreshold: "high" as unknown as number,
      preserveRecentMessages: 3,
      goal: "  ",
      maxStateTokens: Number.NaN,
      model: "jev-ok",
    });
    expect(config).toEqual({ preserveRecentMessages: 3, model: "jev-ok" });
  });

  it("resolves the key from config, then the environment", () => {
    expect(resolveApiKey({ apiKey: "explicit" })).toBe("explicit");
    const previous = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "from-env";
    try {
      expect(resolveApiKey({})).toBe("from-env");
      expect(resolveApiKey({ apiKey: "explicit" })).toBe("explicit");
    } finally {
      if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previous;
    }
  });

  it("throws on malformed JSON so the caller can fall back", () => {
    const dir = mkdtempSync(join(tmpdir(), "fast-jev-test-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    expect(() => loadConfigFiles("/whatever", { globalPath: bad })).toThrow();
  });
});

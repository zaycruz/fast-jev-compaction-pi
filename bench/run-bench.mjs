/**
 * Benchmark: fast-jev-compaction (extension, mock Jev policy) vs pi's built-in
 * summary compaction driven with the user's REAL session model
 * (zap/glm-5.3-flash-sglang via the zap router — the same model their live pi
 * sessions run; the default codex route is quota-exhausted in this
 * environment).
 *
 * For each session size and arm:
 *   1. copy the seeded session,
 *   2. drive `pi --mode rpc` through a manual /compact (timed),
 *   3. measure marker retention in the post-compaction context,
 *   4. ask three "memory" questions (tools disabled; timed; graded),
 * and print a combined report.
 *
 * Usage: node bench/run-bench.mjs [sizes…]   e.g. node bench/run-bench.mjs small medium large
 * Env: BENCH_SUM_MODEL (default glm-5.3-flash-sglang), MOCK_LATENCY_MS (Jev mock, default 500).
 */
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SIZES = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["small", "medium", "large"];
const KEEP_RECENT = { small: 2000, medium: 8000, large: 20000 };
const ARMS = ["fastjev", "builtin"];
const QA_TIMEOUT_MS = 240_000;
const SUM_MODEL = process.env.BENCH_SUM_MODEL ?? "glm-5.3-flash-sglang";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let AGENT_DIR = "";
let ZAP_KEY = "";

function rpcSession({ projectCwd, extensionDir, sessionFile, useExtension }) {
  const args = [
    "--mode", "rpc",
    "--provider", "bench-sum",
    "--model", SUM_MODEL,
    "--thinking", "off",
    "-nt",
    "--approve",
    "--offline",
    "--no-extensions",
    "-e", join(ROOT, "bench", "provider-ext.ts"),
  ];
  if (useExtension) args.push("-e", extensionDir);
  args.push("--session", sessionFile);
  const child = spawn("pi", args, {
    cwd: projectCwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: AGENT_DIR,
      PI_SKIP_VERSION_CHECK: "1",
      BENCH_SUM_BASE_URL: "http://asus-trx50:4000/v1",
      BENCH_SUM_MODEL: SUM_MODEL,
      BENCH_SUM_API_KEY: ZAP_KEY,
    },
  });
  const debugFile = sessionFile.replace(/\.jsonl$/, "") + "-rpc-debug.log";
  const debugStream = createWriteStream(debugFile);
  const state = { child, buffer: "", waiters: [], ready: false, readyWaiters: [] };
  child.stdout.on("data", (chunk) => {
    debugStream.write(chunk);
    state.buffer += chunk;
    let index;
    while ((index = state.buffer.indexOf("\n")) >= 0) {
      const line = state.buffer.slice(0, index).trim();
      state.buffer = state.buffer.slice(index + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "response" && event.command === "get_state" && event.success) state.ready = true;
      if (state.ready) for (const w of state.readyWaiters.splice(0)) w();
      if (event.type === "agent_settled" || event.type === "compaction_end" || event.type === "compaction_failed") {
        for (const w of state.waiters.splice(0)) w(event);
      }
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  state.stderr = () => stderr;
  state.send = (object) => child.stdin.write(`${JSON.stringify(object)}\n`);
  state.waitEvent = () => new Promise((resolve) => state.waiters.push(resolve));
  state.readyPromise = new Promise((resolve) => state.readyWaiters.push(resolve));
  state.close = () => child.kill("SIGTERM");
  return state;
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function readEntries(sessionFile) {
  return readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function lastAssistantText(sessionFile) {
  const entries = readEntries(sessionFile);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type === "message" && entry.message?.role === "assistant") {
      return (entry.message.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
    }
  }
  return "";
}

/** Entries the model sees after compaction: everything from firstKeptEntryId on. */
function keptTailEntries(sessionFile) {
  const entries = readEntries(sessionFile);
  const compactionIndex = entries.findIndex((entry) => entry.type === "compaction");
  if (compactionIndex < 0) return { compaction: null, tail: entries };
  const compaction = entries[compactionIndex];
  const keptIndex = entries.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  return {
    compaction,
    tail: keptIndex >= 0 ? entries.slice(keptIndex, compactionIndex) : [],
  };
}

/** Message entries in order; turn index = count of assistant messages seen. */
function messageTurns(entries) {
  const turns = [];
  let turn = 0;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const role = entry.message?.role;
    if (role === "assistant") {
      turns.push({ entry, turn });
      turn += 1;
    } else if (role === "user" || role === "toolResult") {
      turns.push({ entry, turn: Math.max(0, turn - (role === "user" ? 1 : 0)) });
    }
  }
  return turns;
}

function tailTurnBound(sessionFile) {
  const { compaction, tail } = keptTailEntries(sessionFile);
  if (!compaction) return Number.MAX_SAFE_INTEGER;
  const tailIds = new Set(tail.map((entry) => entry.id));
  const turns = messageTurns(readEntries(sessionFile));
  let bound = 0;
  for (const { entry, turn } of turns) if (tailIds.has(entry.id)) bound = Math.max(bound, turn);
  return bound;
}

async function compactArm({ workDir, seedFile, useExtension, extensionDir }) {
  const projectCwd = join(workDir, "project");
  const sessionFile = join(workDir, "session.jsonl");
  copyFileSync(seedFile, sessionFile);
  for (let attempt = 1; ; attempt += 1) {
    const rpc = rpcSession({ projectCwd, extensionDir, sessionFile, useExtension });
    try {
      rpc.send({ type: "get_state" }); // pi rpc emits nothing until the first request
      await withTimeout(rpc.readyPromise, 45_000, "pi startup");
      const started = performance.now();
      const startedAt = Date.now();
      rpc.send({ type: "compact" });
      const event = await withTimeout(rpc.waitEvent(), QA_TIMEOUT_MS, "compaction");
      const ms = performance.now() - started;
      await sleep(200);
      const failed = event.type === "compaction_failed" || Boolean(event.errorMessage);
      return {
        ms,
        failed,
        errorMessage: event.errorMessage,
        eventResult: event.result ?? null,
        sessionFile,
        stderr: rpc.stderr(),
        startedAt,
        endedAt: Date.now(),
      };
    } catch (error) {
      const errText = rpc.stderr();
      if (errText.trim()) console.log(`  pi stderr so far: ${errText.slice(-600).replace(/\n/g, " | ")}`);
      if (attempt >= 2) throw error;
      console.log(`  startup/compact hiccup (${String(error).slice(0, 80)}), retrying once`);
      copyFileSync(seedFile, sessionFile); // clean slate for the retry
    } finally {
      rpc.close();
      await sleep(300);
    }
  }
}

async function qaArm({ sessionFile, projectCwd, questions }) {
  const rpc = rpcSession({ projectCwd, sessionFile, useExtension: false });
  const answers = [];
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    rpc.send({ type: "get_state" });
    await withTimeout(rpc.readyPromise, 45_000, "pi startup (qa)");
    const startedAt = Date.now();
    let entryCountBefore = readEntries(sessionFile).length;
    for (const question of questions) {
      const started = performance.now();
      rpc.send({ type: "prompt", message: question.text });
      await withTimeout(rpc.waitEvent(), QA_TIMEOUT_MS, `qa "${question.text.slice(0, 40)}"`);
      const ms = performance.now() - started;
      const text = lastAssistantText(sessionFile);
      for (const entry of readEntries(sessionFile).slice(entryCountBefore)) {
        if (entry.type === "message" && entry.message?.role === "assistant" && entry.message?.usage) {
          inputTokens += entry.message.usage.input ?? 0;
          outputTokens += entry.message.usage.output ?? 0;
        }
      }
      entryCountBefore = readEntries(sessionFile).length;
      answers.push({
        question: question.text,
        expected: question.marker.value,
        ms,
        answer: text,
        correct: gradeAnswer(text, question.marker.value),
      });
    }
    return { answers, startedAt, endedAt: Date.now(), inputTokens, outputTokens };
  } finally {
    rpc.close();
    await sleep(300);
  }
}

function analyze(sessionFile, markers, eventResult) {
  const { compaction, tail } = keptTailEntries(sessionFile);
  if (!compaction) return { compaction: null };
  const compactionWithEvent = eventResult
    ? {
        ...compaction,
        usage: eventResult.usage ?? compaction.usage,
        estimatedTokensAfter: eventResult.estimatedTokensAfter,
      }
    : compaction;
  const bound = tailTurnBound(sessionFile);
  const tailText = tail
    .map((entry) => JSON.stringify(entry.message?.content ?? ""))
    .join("\n");
  const summary = compaction.summary ?? "";
  const inContext = (value) => summary.includes(value) || tailText.includes(value);
  const inSummary = (value) => summary.includes(value);

  // Model-visible recall (summary + kept tail). The tail is identical for both
  // arms, so arm differences come from the summarized span.
  const byKind = {};
  const spanOnly = {};
  for (const marker of markers) {
    const isSpan = marker.turn < bound;
    byKind[marker.kind] ??= { total: 0, retained: 0 };
    byKind[marker.kind].total += 1;
    if (inContext(marker.value)) byKind[marker.kind].retained += 1;
    if (isSpan) {
      spanOnly[marker.kind] ??= { total: 0, retained: 0 };
      spanOnly[marker.kind].total += 1;
      if (inSummary(marker.value)) spanOnly[marker.kind].retained += 1;
    }
  }

  // Real pre-compaction context: every message entry before the compaction
  // entry, chars/4 (pi's own estimator).
  const entries = readEntries(sessionFile);
  const compactionIndex = entries.findIndex((e) => e.type === "compaction");
  let contentChars = 0;
  for (const entry of entries.slice(0, compactionIndex < 0 ? entries.length : compactionIndex)) {
    if (entry.type !== "message") continue;
    const content = entry.message?.content;
    if (typeof content === "string") contentChars += content.length;
    else if (Array.isArray(content)) {
      for (const block of content) contentChars += (block.text ?? block.thinking ?? "").length;
    } else if (entry.message) contentChars += JSON.stringify(entry.message).length;
  }

  return {
    compaction: compactionWithEvent,
    preContextTokens: Math.ceil(contentChars / 4),
    byKind,
    spanOnly,
    tailMarkers: markers.length - Object.values(spanOnly).reduce((sum, k) => sum + k.total, 0),
    summaryChars: summary.length,
  };
}

/** Grades on the unique token: error codes often lose their "FATAL " prefix. */
function gradeAnswer(answer, markerValue) {
  return answer.includes(markerValue) || answer.includes(markerValue.replace(/^FATAL /, ""));
}

function pickQa(markers, bound) {
  const span = markers.filter((m) => m.turn < bound);
  const error = span.find((m) => m.kind === "error" && m.depth >= 55);
  const constraint = span.find((m) => m.kind === "constraint");
  const command = span.find((m) => m.kind === "command");
  const questions = [];
  if (error) {
    questions.push({
      marker: error,
      text: "Earlier in this session some ingest job crashed. Reply with ONLY the FIRST fatal error code that appeared in the session (the FATAL 0x… token), nothing else. Do not use tools.",
    });
  }
  if (constraint) {
    questions.push({
      marker: constraint,
      text: constraint.value.startsWith("TICKET")
        ? "Reply with ONLY the ticket id mentioned earlier that blocks the release, nothing else. Do not use tools."
        : "Reply with ONLY the exact path we are never allowed to modify directly, nothing else. Do not use tools.",
    });
  }
  if (command) {
    questions.push({
      marker: command,
      text: "Reply with ONLY the FIRST cache-flush command that was run earlier in the session (the full curl line), nothing else. Do not use tools.",
    });
  }
  return questions;
}

async function main() {
  ZAP_KEY = readFileSync(join(homedir(), ".pi", "agent", "zap.key"), "utf8").trim();
  if (ZAP_KEY.length === 0) throw new Error("zap key missing (~/.pi/agent/zap.key) — the built-in arm needs the session model");

  const root = mkdtempSync(join(tmpdir(), "fast-jev-bench-"));
  const results = [];
  AGENT_DIR = join(root, "pi-agent-config");
  mkdirSync(AGENT_DIR, { recursive: true });
  console.log(`benchmark root: ${root}\n`);

  // Fast-jev arm: real typesafe-ai/jev via the Vercel AI Gateway (default),
  // or the policy mock when BENCH_JEV_REAL is unset/0.
  const REAL_JEV = process.env.BENCH_JEV_REAL === "1";
  let jevApiKey = process.env.BENCH_JEV_API_KEY ?? "";
  if (REAL_JEV && jevApiKey.length === 0) {
    for (let attempt = 0; attempt < 3 && jevApiKey.length === 0; attempt += 1) {
      jevApiKey = execFileSync("op", ["item", "get", "VERCEL_AI_GATEWAY_API_KEY", "--fields", "credential", "--reveal"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (jevApiKey.length === 0) await sleep(2000);
    }
    if (jevApiKey.length === 0) throw new Error("could not read VERCEL_AI_GATEWAY_API_KEY from 1Password (op)");
  }
  const jevLog = join(root, "jev-requests.json");
  let mock = null;
  let jevPort = "0";
  if (!REAL_JEV) {
    mock = spawn("node", [join(ROOT, "bench", "mock-jev.mjs")], {
      env: { ...process.env, MOCK_LATENCY_MS: process.env.MOCK_LATENCY_MS ?? "500", MOCK_LOG: jevLog },
      stdio: ["ignore", "pipe", "inherit"],
    });
    jevPort = await new Promise((resolve, reject) => {
      mock.stdout.on("data", (chunk) => resolve(String(chunk).trim()));
      mock.on("error", reject);
    });
  }

  const projectCwd = join(root, "project");
  const sessionDir = join(root, "sessions");
  mkdirSync(join(projectCwd, ".pi"), { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(projectCwd, ".pi", "settings.json"),
    JSON.stringify({ compaction: { enabled: true, reserveTokens: 8000, keepRecentTokens: 0 } }, null, 2),
  );
  const PRESERVE_INPUTS = process.env.BENCH_PRESERVE_INPUTS === "1";
  const ERROR_TAILS = Number(process.env.BENCH_ERROR_TAILS ?? 0);
  writeFileSync(
    join(projectCwd, ".pi", "fast-jev-compaction.json"),
    JSON.stringify(
      REAL_JEV
        ? {
            apiKey: jevApiKey,
            baseUrl: "https://ai-gateway.vercel.sh/v4/ai",
            model: "typesafe-ai/jev",
            gateway: true,
            preserveCallInputs: PRESERVE_INPUTS,
            inputRetention: process.env.BENCH_INPUT_RETENTION === "jev" ? "jev" : "always",
            inputRetentionThreshold: Number(process.env.BENCH_INPUT_THRESHOLD ?? 0.2),
            preserveErrorTails: ERROR_TAILS,
            requestTimeoutMs: 30000,
          }
        : {
            apiKey: "bench-key",
            baseUrl: `http://127.0.0.1:${jevPort}/v1/systemone`,
            model: "jev-bench",
            requestTimeoutMs: 30000,
          },
    ),
  );

  for (const size of SIZES) {
    const markersFile = join(root, `markers-${size}.json`);
    const gen = spawn("node", [join(ROOT, "bench", "gen-session.mjs"), projectCwd, sessionDir, size, markersFile], { cwd: ROOT });
    const sessionPath = await new Promise((resolve, reject) => {
      let out = "";
      gen.stdout.on("data", (chunk) => (out += chunk));
      gen.on("error", reject);
      gen.on("exit", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`seed generation failed (${code})`))));
      setTimeout(() => reject(new Error("seed generation timed out")), 30_000);
    });
    if (!sessionPath || !existsSync(sessionPath)) throw new Error(`no seed session generated for ${size}`);
    const markers = JSON.parse(readFileSync(markersFile, "utf8"));

    for (const arm of ARMS) {
      const workDir = join(root, `${size}-${arm}`);
      mkdirSync(join(workDir, "project", ".pi"), { recursive: true });
      writeFileSync(
        join(workDir, "project", ".pi", "settings.json"),
        JSON.stringify({ compaction: { enabled: true, keepRecentTokens: KEEP_RECENT[size] } }),
      );
      if (arm === "fastjev") {
        copyFileSync(join(projectCwd, ".pi", "fast-jev-compaction.json"), join(workDir, "project", ".pi", "fast-jev-compaction.json"));
      }

      console.log(`  [${new Date().toISOString().slice(11, 19)}] starting ${size}/${arm}…`);
      let run;
      try {
        run = await compactArm({
          workDir,
          seedFile: sessionPath,
          useExtension: arm === "fastjev",
          extensionDir: ROOT,
        });
      } catch (error) {
        console.log(`  [${size}/${arm}] SKIPPED: ${String(error).slice(0, 120)}`);
        results.push({ size, arm, label: arm === "fastjev" ? (REAL_JEV ? (PRESERVE_INPUTS ? (process.env.BENCH_INPUT_RETENTION === "jev" ? process.env.BENCH_INPUT_RETENTION === "jev" ? `fast-jev (jev-gated @${process.env.BENCH_INPUT_THRESHOLD ?? 0.2})` : "fast-jev (jev-gated)" : ERROR_TAILS > 0 ? "fast-jev (tuned+tails)" : "fast-jev (tuned)") : "fast-jev (real)") : "fast-jev (sim Jev)") : `built-in (${SUM_MODEL}, summary)`, failed: true, errorMessage: String(error), qa: [] });
        continue;
      }
      const analysis = analyze(run.sessionFile, markers, run.eventResult);
      const qaBound = tailTurnBound(run.sessionFile);
      const questions = pickQa(markers, qaBound);
      let qa = [];
      let qaRun = null;
      try {
        if (questions.length > 0) {
          qaRun = await qaArm({ sessionFile: run.sessionFile, projectCwd: join(workDir, "project"), questions });
          qa = qaRun.answers;
        }
      } catch (error) {
        console.log(`  [${size}/${arm}] QA failed: ${String(error).slice(0, 120)}`);
      }

      // Compaction token cost: fast-jev = what its Jev requests consumed
      // (chars/4 estimate from the mock); built-in = real usage the session
      // model reported for the summarization (reasoning tokens included).
      const compactionCost = {
        requests: analysis.compaction?.details?.fastJev?.stats?.requests ?? (arm === "builtin" ? 1 : 0),
        promptTokens: analysis.compaction?.usage?.input ?? 0,
        completionTokens: analysis.compaction?.usage?.output ?? 0,
        estimated: arm === "fastjev" && !REAL_JEV,
      };
      const qaCost = {
        promptTokens: qaRun?.inputTokens ?? 0,
        completionTokens: qaRun?.outputTokens ?? 0,
        estimated: false,
      };

      results.push({
        size,
        arm,
        label: arm === "fastjev" ? (REAL_JEV ? (PRESERVE_INPUTS ? (process.env.BENCH_INPUT_RETENTION === "jev" ? process.env.BENCH_INPUT_RETENTION === "jev" ? `fast-jev (jev-gated @${process.env.BENCH_INPUT_THRESHOLD ?? 0.2})` : "fast-jev (jev-gated)" : ERROR_TAILS > 0 ? "fast-jev (tuned+tails)" : "fast-jev (tuned)") : "fast-jev (real)") : "fast-jev (sim Jev)") : `built-in (${SUM_MODEL}, summary)`,
        compactionMs: Math.round(run.ms),
        failed: run.failed,
        errorMessage: run.errorMessage,
        preContextTokens: analysis.preContextTokens,
        estTokensAfter: analysis.compaction?.estimatedTokensAfter,
        summaryChars: analysis.summaryChars ?? 0,
        usage: analysis.compaction?.usage,
        stats: analysis.compaction?.details?.fastJev?.stats,
        byKind: analysis.byKind,
        spanOnly: analysis.spanOnly,
        qa,
        cost: { compaction: compactionCost, qa: qaCost },
      });
      const kindText = Object.entries(analysis.byKind ?? {})
        .map(([kind, { total, retained }]) => `${kind} ${retained}/${total}`)
        .join(", ");
      console.log(
        `[${size}/${arm}] compact ${Math.round(run.ms)}ms failed=${run.failed}${run.errorMessage ? ` (${run.errorMessage.slice(0, 60)})` : ""} · preCtx=${analysis.preContextTokens} estAfter=${analysis.compaction?.estimatedTokensAfter} · recall ${kindText || "n/a"} · qa ${qa.filter((a) => a.correct).length}/${qa.length}`,
      );
    }
  }

  if (mock) mock.kill("SIGTERM");
  const outFile = join(ROOT, "bench", `results-${Date.now()}.json`);
  writeFileSync(outFile, JSON.stringify({ results, jevLog, model: SUM_MODEL, realJev: REAL_JEV, preserveCallInputs: PRESERVE_INPUTS, errorTails: ERROR_TAILS }, null, 2));
  console.log(`\nfull results: ${outFile}`);
  renderReport(results);
}

function fmt(n, digits = 0) {
  return typeof n === "number" ? n.toLocaleString("en-US", { maximumFractionDigits: digits }) : "—";
}

function renderReport(results) {
  console.log("\n================ REPORT ================\n");
  console.log(
    "Compaction operation. Tokens: fast-jev = its Jev requests (chars/4 estimate); built-in = usage the session model reported for summarization (reasoning included).",
  );
  console.log("| session | arm | compact wall | pre-compaction ctx | context after | compaction tokens in | out | requests |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    console.log(
      `| ${r.size} | ${r.label} | ${r.failed ? "FAILED" : fmt(r.compactionMs)} | ${fmt(r.preContextTokens)} | ${fmt(r.estTokensAfter)} | ${fmt(r.cost?.compaction?.promptTokens)} | ${fmt(r.cost?.compaction?.completionTokens)} | ${fmt(r.cost?.compaction?.requests)} |`,
    );
  }
  console.log("\nMarker retention — exact strings the model still sees after compaction (summary + kept tail):");
  console.log("| session | arm | constraints | paths (call inputs) | commands (call inputs) | errors (deep in outputs) |");
  console.log("|---|---|---|---|---|---|");
  for (const r of results) {
    const cell = (kind) => {
      const entry = r.byKind?.[kind];
      return entry ? `${entry.retained}/${entry.total}` : "—";
    };
    console.log(
      `| ${r.size} | ${r.label} | ${cell("constraint")} | ${cell("path")} | ${cell("command")} | ${cell("error")} |`,
    );
  }
  console.log("\nDownstream memory QA (session model answers from compacted context only; tools disabled):");
  console.log("| session | arm | correct | median answer | QA prompt tokens (all questions) |");
  console.log("|---|---|---|---|---|");
  for (const r of results) {
    const qa = r.qa ?? [];
    const correct = qa.filter((a) => a.correct).length;
    const median = qa.length > 0 ? qa.map((a) => a.ms).sort((a, b) => a - b)[Math.floor(qa.length / 2)] : undefined;
    console.log(`| ${r.size} | ${r.label} | ${correct}/${qa.length} | ${fmt(median)} | ${fmt(r.cost?.qa?.promptTokens)} |`);
  }
  console.log("\nQA answers:");
  for (const r of results) {
    for (const a of r.qa ?? []) {
      console.log(`- [${r.size}/${r.arm}] expected ${a.expected} → ${a.correct ? "HIT" : "MISS"} :: ${a.answer.replace(/\n/g, " ").slice(0, 110)}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

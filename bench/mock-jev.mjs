/**
 * Mock of the TypeSafe System One endpoint with a *policy* that emulates how
 * a real Jev scores compaction questions: recent tool results and errors stay
 * verbatim, older ones are truncated to their head, calls almost always stay.
 * No real API key exists in this environment, so Jev's decisions are
 * simulated — this is disclosed in the benchmark report.
 *
 * Env: MOCK_LATENCY_MS (default 500, per request), MOCK_LOG (request log path).
 */
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const latencyMs = Number(process.env.MOCK_LATENCY_MS ?? 500);
const logPath = process.env.MOCK_LOG ?? "";
const requestLog = [];

function scoreRecency(state, callId) {
  const history = state?.history ?? [];
  let maxI = 0;
  let callEntry = null;
  for (const entry of history) {
    maxI = Math.max(maxI, entry.i ?? 0);
    const calls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
    for (const call of calls) {
      if (call && typeof call === "object" && call.id === callId) callEntry = { entry: entry.i ?? 0, call };
    }
  }
  if (!callEntry) return { recency: 99, isError: false };
  const isError = typeof callEntry.call.result === "string" && callEntry.call.result.startsWith("error");
  return { recency: maxI - callEntry.entry, isError };
}

function noulFor(name, state) {
  const callId = name.replace(/^(call|result)_/, "");
  const { recency, isError } = scoreRecency(state, callId);
  if (name.startsWith("call_")) return recency <= 8 ? 0.9 : 0.75;
  if (isError) return 0.85;
  if (recency <= 2) return 0.9;
  if (recency <= 6) return 0.3;
  return 0.05;
}

const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", async () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      // fall through
    }
    const questions = parsed.questions ?? {};
    const state = parsed.state ?? {};
    const answers = Object.fromEntries(
      Object.keys(questions).map((name) => [name, { type: "noul", noul: noulFor(name, state) }]),
    );
    const usage = {
      input_tokens: Math.round(body.length / 4),
      output_tokens: 8 * Object.keys(questions).length,
    };
    requestLog.push({ t: Date.now(), ms: latencyMs, input: usage.input_tokens, output: usage.output_tokens, questions: Object.keys(questions).length });
    if (logPath) writeFileSync(logPath, JSON.stringify(requestLog));
    await new Promise((resolve) => setTimeout(resolve, latencyMs));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ answers, usage }));
  });
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${server.address().port}\n`);
});

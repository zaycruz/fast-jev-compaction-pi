/**
 * Generates a deterministic synthetic coding session with planted "memory
 * markers" — exact strings (paths, error codes, commands, constraints) that a
 * compaction must preserve for the agent to keep working. The same seed always
 * yields the same session, so both compaction arms see identical input.
 *
 * Usage: node bench/gen-session.mjs <cwd> <sessionDir> <small|medium|large> <markersOut>
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";

const [cwd, sessionDir, size = "medium", markersOut = ""] = process.argv.slice(2);

const TURNS = { small: 8, medium: 18, large: 36 }[size] ?? 18;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(TURNS * 7919);
const hex = (n) =>
  Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rng() * 16)]).join("");
const int = (min, max) => min + Math.floor(rng() * (max - min + 1));
const pick = (list) => list[Math.floor(rng() * list.length)];

const usage = {
  input: 1000,
  output: 50,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1050,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const markers = [];
let markerId = 0;
const addMarker = (kind, value, turn, depth) => {
  const marker = { id: `m${markerId++}`, kind, value, turn, depth };
  markers.push(marker);
  return marker;
};

const VERBS = ["inspect", "scan", "refactor", "verify", "profile", "wire up", "audit"];

function codeContent(lines) {
  const body = [];
  for (let i = 0; i < lines; i += 1) {
    body.push(
      pick([
        `export function fn_${hex(4)}(x: number): number { return x * ${int(2, 99)}; }`,
        `const cache_${hex(4)} = new Map<string, ${pick(["string", "number", "boolean"])}>();`,
        `// TODO(${hex(4)}): revisit the retry backoff here`,
        `await queue.push({ id: "${hex(6)}", retries: ${int(0, 5)} });`,
      ]),
    );
  }
  return body.join("\n");
}

function logContent(lines, withError, errorDepth) {
  const body = [];
  for (let i = 0; i < lines; i += 1) {
    body.push(`INFO worker-${int(0, 7)} processed ${int(10, 999)} items in ${int(2, 90)}ms`);
  }
  if (withError) {
    const code = `FATAL 0x${hex(8).toUpperCase()}`;
    addMarker("error", code, null, errorDepth);
    const at = Math.floor((lines * errorDepth) / 100);
    body.splice(at, 0, `FATAL ${code.slice(6)}: ingest stage ${int(1, 9)} dropped the batch`);
    for (let s = 0; s < 6; s += 1) body.splice(at + 1 + s, 0, `  at handler_${hex(4)} (pipeline.ts:${int(10, 900)})`);
  }
  return body.join("\n");
}

const manager = SessionManager.create(cwd, sessionDir);
const now = Date.now();
let turn = 0;

manager.appendMessage({
  role: "user",
  content: `Speed up the ingest pipeline. ${(() => {
    const value = `var/ingest-${hex(4)}.db`;
    addMarker("constraint", value, 0, 0);
    return `Never modify ${value} directly — route writes through the queue service.`;
  })()}`,
  timestamp: now,
});

for (let t = 0; t < TURNS; t += 1) {
  turn = t;
  const verb = VERBS[t % VERBS.length];
  const kind = pick(["read", "read", "bash", "read", "edit", "bash"]);
  const calls = [];
  let resultText = "";

  if (kind === "read") {
    const path = `src/atlas-${hex(6)}/engine-${hex(4)}.ts`;
    addMarker("path", path, t, 0);
    calls.push({ type: "toolCall", id: `c${t}`, name: "read", arguments: { path } });
    resultText = `// read ${path}\n${codeContent(int(40, 140))}`;
  } else if (kind === "bash") {
    const command = `curl -s http://edge-${hex(4)}.internal/v${int(1, 9)}/flush-${hex(4)} | jq '.counts'`;
    addMarker("command", command, t, 0);
    const withError = t % 3 === 1;
    calls.push({ type: "toolCall", id: `c${t}`, name: "bash", arguments: { command } });
    resultText = logContent(int(30, 120), withError, int(55, 90));
  } else {
    const path = `src/atlas-${hex(6)}/handler-${hex(4)}.ts`;
    calls.push({ type: "toolCall", id: `c${t}`, name: "edit", arguments: { path, old_string: "return 0", new_string: "return 1" } });
    resultText = `OK: applied patch to ${path} (+${int(1, 40)} -${int(1, 20)})`;
  }

  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: `Step ${t}: ${verb} the ${kind} surface. ${pick(["Looking closer.", "Running it now.", "This looks relevant."])}` }, ...calls],
    api: "mlx",
    provider: "bench",
    model: "bench-model",
    usage,
    stopReason: calls.length > 0 ? "toolUse" : "stop",
    timestamp: now + t * 1000,
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: `c${t}`,
    toolName: kind,
    content: [{ type: "text", text: resultText }],
    isError: kind === "bash" && t % 3 === 1,
    timestamp: now + t * 1000 + 1,
  });

  if (t % 4 === 3) {
    const ticket = `TICKET-${hex(4).toUpperCase()}`;
    addMarker("constraint", ticket, t, 0);
    manager.appendMessage({
      role: "user",
      content: `Keep ${ticket} on track — it blocks the release.`,
      timestamp: now + t * 1000 + 2,
    });
  }
}

manager.appendMessage({ role: "user", content: "Summarize where we are and continue.", timestamp: now + 99999 });
manager.appendMessage({
  role: "assistant",
  content: [{ type: "text", text: "Continuing from the current state." }],
  api: "mlx",
  provider: "bench",
  model: "bench-model",
  usage,
  stopReason: "stop",
  timestamp: now + 100000,
});

for (const marker of markers) if (marker.turn === null) marker.turn = turn;
if (markersOut) writeFileSync(markersOut, JSON.stringify(markers, null, 2));
process.stdout.write(manager.getSessionFile());

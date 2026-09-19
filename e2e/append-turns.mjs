/**
 * Appends fresh turns to the leaf of a session file, so a second compaction
 * has a new span. Demonstrates continuity: the second compaction must re-decide
 * over the first one's stored pruned transcript.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [file] = process.argv.slice(2);
const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const leaf = lines[lines.length - 1];
const now = Date.now();
const shortId = () => Math.random().toString(16).slice(2, 10);

let parentId = leaf.id;
const append = (message) => {
  const entry = { type: "message", id: shortId(), parentId, timestamp: new Date(now).toISOString(), message };
  parentId = entry.id;
  lines.push(entry);
};

append({ role: "user", content: "Now check the logs too.", timestamp: now });
append({
  role: "assistant",
  content: [
    { type: "text", text: "reading the log" },
    { type: "toolCall", id: "call_10", name: "bash", arguments: { command: "cat server.log" } },
  ],
  api: "anthropic-messages",
  provider: "test",
  model: "test-model",
  usage: {
    input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "toolUse",
  timestamp: now,
});
append({
  role: "toolResult",
  toolCallId: "call_10",
  toolName: "bash",
  content: [{ type: "text", text: `log line ${"x".repeat(80)}\n`.repeat(120) }],
  isError: false,
  timestamp: now,
});
append({
  role: "assistant",
  content: [{ type: "text", text: "The logs show nothing unusual." }],
  api: "anthropic-messages",
  provider: "test",
  model: "test-model",
  usage: {
    input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: now,
});

writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
process.stdout.write(`appended 4 entries to ${file}\n`);

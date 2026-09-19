/**
 * Seeds a session file with a small scripted conversation: three read calls
 * with fat results, so pi's compaction cut leaves a non-empty span to prune.
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";

const [cwd, sessionDir] = process.argv.slice(2);
const usage = {
  input: 100,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 110,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const manager = SessionManager.create(cwd, sessionDir);
manager.appendMessage({ role: "user", content: "Fix the failing tests. Never edit src/generated.", timestamp: Date.now() });
for (let i = 0; i < 3; i += 1) {
  manager.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: `checking src/module-${i}.ts` },
      { type: "toolCall", id: `call_${i}`, name: "read", arguments: { path: `src/module-${i}.ts` } },
    ],
    api: "anthropic-messages",
    provider: "test",
    model: "test-model",
    usage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: `call_${i}`,
    toolName: "read",
    content: [{ type: "text", text: `export const m${i} = ${i};\n`.repeat(600) }],
    isError: false,
    timestamp: Date.now(),
  });
}
manager.appendMessage({ role: "user", content: "go ahead", timestamp: Date.now() });
manager.appendMessage({
  role: "assistant",
  content: [{ type: "text", text: "On it — the fix is small." }],
  api: "anthropic-messages",
  provider: "test",
  model: "test-model",
  usage,
  stopReason: "stop",
  timestamp: Date.now(),
});
process.stdout.write(manager.getSessionFile());

/**
 * Drives `pi --mode rpc` headlessly: get_state, then one or more compacts.
 * Prints pi's JSONL events; exits 0 when every compaction finished.
 */
import { spawn } from "node:child_process";

const [projectCwd, extensionPath, sessionFile, compacts = "1"] = process.argv.slice(2);
const compactCount = Number(compacts) || 1;

const pi = spawn(
  "pi",
  ["--mode", "rpc", "--no-extensions", "-e", extensionPath, "--session", sessionFile, "--approve", "--offline"],
  { cwd: projectCwd, stdio: ["pipe", "pipe", "pipe"] },
);

let buffer = "";
let finished = 0;
const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timed out waiting for pi rpc")), 60_000);
  pi.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length === 0) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "extension_ui_request" && event.method === "notify") {
        process.stderr.write(`-- ui.notify [${event.notifyType ?? "info"}]: ${event.message}\n`);
      }
      if (event.type === "compaction_start") {
        process.stderr.write(`-- compaction_start\n`
        );
      }
      if (event.type === "compaction_end") {
        finished += 1;
        process.stderr.write(
          `-- compaction_end (${finished}/${compactCount}) errorMessage: ${event.errorMessage ?? "none"}\n`,
        );
        if (finished >= compactCount) {
          clearTimeout(timer);
          setTimeout(resolve, 300);
        } else {
          setTimeout(() => pi.stdin.write(`${JSON.stringify({ type: "compact" })}\n`), 500);
        }
      }
    }
  });
  pi.stderr.on("data", (chunk) => process.stderr.write(chunk));
  pi.on("exit", (code) => {
    clearTimeout(timer);
    if (finished < compactCount) reject(new Error(`pi exited with ${code} before compaction finished`));
    else resolve();
  });
});

pi.stdin.write(`${JSON.stringify({ type: "get_state" })}\n`);
await new Promise((resolve) => setTimeout(resolve, 1500));
pi.stdin.write(`${JSON.stringify({ type: "compact" })}\n`);
await done;
pi.kill("SIGTERM");
await new Promise((resolve) => setTimeout(resolve, 300));
process.exit(0);

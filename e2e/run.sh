#!/bin/bash
# End-to-end check: seed a pi session, run a mock Jev server, drive
# `pi --mode rpc` through /compact, and verify the appended compaction entry.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d /tmp/fast-jev-e2e.XXXXXX)"
trap 'kill "${MOCK_PID:-}" 2>/dev/null || true' EXIT
mkdir -p "$WORK/project/.pi" "$WORK/sessions"

CALL_P="${1:-0.95}"
RESULT_P="${2:-0.05}"

MOCK_CALL_P="$CALL_P" MOCK_RESULT_P="$RESULT_P" MOCK_FAIL="${MOCK_FAIL:-0}" MOCK_RECORD="$WORK/mock-state.json" node "$ROOT/e2e/mock-jev.mjs" > "$WORK/port" &
MOCK_PID=$!
sleep 0.5
PORT="$(cat "$WORK/port")"

cat > "$WORK/project/.pi/fast-jev-compaction.json" <<EOF
{
  "apiKey": "test-key",
  "baseUrl": "http://127.0.0.1:$PORT/v1/systemone",
  "model": "jev-mock",
  "minReductionRatio": 0.1,
  "requestTimeoutMs": 10000
}
EOF

cat > "$WORK/project/.pi/settings.json" <<EOF
{
  "compaction": { "enabled": true, "reserveTokens": 2048, "keepRecentTokens": 800 }
}
EOF

cd "$ROOT"
SESSION_FILE="$(node e2e/seed-session.mjs "$WORK/project" "$WORK/sessions")"
echo "== seed session: $SESSION_FILE"

set +e
node e2e/rpc-drive.mjs "$WORK/project" "$ROOT" "$SESSION_FILE" 1 > "$WORK/rpc-out.json" 2> "$WORK/rpc-err.log"
RPC_EXIT=$?
set -e
echo "== pi rpc exit: $RPC_EXIT"
grep -- '-- compaction' "$WORK/rpc-err.log" || true

if [ "${3:-}" = "second" ]; then
  echo "== appending fresh turns and compacting again (continuity)"
  node e2e/append-turns.mjs "$SESSION_FILE"
  set +e
  node e2e/rpc-drive.mjs "$WORK/project" "$ROOT" "$SESSION_FILE" 1 > "$WORK/rpc-out2.json" 2> "$WORK/rpc-err2.log"
  RPC_EXIT=$?
  set -e
  echo "== pi rpc exit (second): $RPC_EXIT"
  grep -- '-- compaction' "$WORK/rpc-err2.log" || true
fi

echo "== compaction entry in session file:"
node --input-type=module - "$SESSION_FILE" <<'EOF'
import { readFileSync } from "node:fs";
const file = process.argv[2];
const entries = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const compactions = entries.filter((entry) => entry.type === "compaction");
const compaction = compactions.at(-1);
if (!compaction) {
  console.log("NO COMPACTION ENTRY FOUND");
  process.exit(1);
}
console.log("compaction entries:", compactions.length);
const fastJev = compaction.details?.fastJev;
console.log("summary length:", compaction.summary.length);
console.log("has fastJev details:", Boolean(fastJev), "version:", fastJev?.version);
console.log("stored messages:", fastJev?.messages?.length);
console.log("stats:", JSON.stringify(fastJev?.stats));
console.log("usage:", JSON.stringify(compaction.usage));
console.log("readFiles:", JSON.stringify(compaction.details?.readFiles));
console.log("---- summary head ----");
console.log(compaction.summary.slice(0, 1200));
EOF

echo "== last mock state (goal + history size):"
node --input-type=module - "$WORK/mock-state.json" <<'EOF'
import { readFileSync } from "node:fs";
const body = JSON.parse(readFileSync(process.argv[2], "utf8"));
console.log("model:", body.model, "| history entries:", body.state.history.length);
console.log("goal:", JSON.stringify(body.state.goal));
EOF

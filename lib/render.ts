import type { Message } from "../vendor/fast-jev/types.js";

const HEADER = `<compacted-conversation engine="fast-jev-compaction">
The block below replaces the earlier part of this conversation. It is not a
summary: user and assistant text is preserved verbatim and in order. Tool calls
Jev marked stale were removed together with their results, and stale tool
results were truncated to their first characters with a note in place. Re-run
a tool if you need its full output.`;

const FOOTER = `</compacted-conversation>`;

/** Serialises tool input as compact single-line JSON. */
function inputJson(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input);
  } catch {
    return "[unserializable input]";
  }
}

/**
 * Renders the pruned transcript as the compaction summary text. Everything
 * the decisions kept is written out exactly as it was; messages that lost all
 * their content are gone (the library removed them) and empty structural
 * leftovers are skipped here.
 */
export function renderSummary(messages: readonly Message[]): string {
  const blocks: string[] = [];
  let shown = 0;
  for (const message of messages) {
    const results = message.toolResults ?? [];
    if (
      message.text.trim().length === 0 &&
      message.toolUses.length === 0 &&
      results.length === 0
    ) {
      continue;
    }
    shown += 1;
    const label =
      results.length > 0 && message.toolUses.length === 0
        ? results.length > 1
          ? "tool results"
          : "tool result"
        : message.role === "assistant"
          ? "assistant"
          : "user";
    const lines: string[] = [`--- [${shown}] ${label} ---`];
    if (message.text.trim().length > 0) lines.push(message.text);
    for (const call of message.toolUses) {
      lines.push("", `[tool call ${call.tool}] ${inputJson(call.input)}`);
    }
    for (const result of results) {
      lines.push("", `[tool result ${result.tool_use_id}${result.isError ? " · error" : ""}]`);
      lines.push(result.text.length > 0 ? result.text : "(empty result)");
    }
    blocks.push(lines.join("\n"));
  }
  const body = blocks.length > 0 ? blocks.join("\n\n") : "(no messages)";
  return `${HEADER}\n\n${body}\n${FOOTER}`;
}

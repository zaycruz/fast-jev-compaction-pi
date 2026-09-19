import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { Message, ToolResult, ToolUse } from "../vendor/fast-jev/types.js";

/**
 * Text extracted from pi message content. Text parts join with newlines and
 * images become `[image]` placeholders — the compacted transcript is text, so
 * a picture at least leaves a marker saying one was there.
 */
export function contentToText(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
    } else if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    } else if (part && typeof part === "object" && (part as { type?: unknown }).type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("\n");
}

interface AssistantBlock {
  type?: string;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

/**
 * Converts pi session messages (any `AgentMessage` shape: user, assistant,
 * toolResult, bashExecution, custom, …) into the fast-jev `Message` shape.
 *
 * pi keeps tool results as their own `toolResult` messages, so each becomes a
 * synthetic user message holding one `toolResults` entry, mirroring how Claude
 * Code transcripts carry them. Calls pair with their results later, by
 * `tool_use_id`, inside the library.
 */
export function toFastJevMessages(agentMessages: readonly unknown[]): Message[] {
  const base = convertToLlm(agentMessages as never) ?? [];
  const out: Message[] = [];
  for (const message of base) {
    if (message.role === "user") {
      out.push({ role: "user", text: contentToText(message.content), toolUses: [] });
    } else if (message.role === "assistant") {
      let text = "";
      const toolUses: ToolUse[] = [];
      for (const block of (message.content ?? []) as AssistantBlock[]) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") {
          text = text.length > 0 ? `${text}\n${block.text}` : block.text;
        } else if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
          toolUses.push({
            tool_use_id: block.id,
            tool: block.name,
            input:
              block.arguments && typeof block.arguments === "object"
                ? (block.arguments as Record<string, unknown>)
                : {},
          });
        }
        // thinking blocks are skipped: they are internal reasoning, not context
      }
      out.push({ role: "assistant", text, toolUses });
    } else if (message.role === "toolResult") {
      const toolResults: ToolResult[] = [
        {
          tool_use_id: String(message.toolCallId ?? ""),
          text: contentToText(message.content),
          isError: message.isError === true,
        },
      ];
      out.push({ role: "user", text: "", toolUses: [], toolResults });
    }
  }
  return out;
}

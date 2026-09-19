import type { FileOperations, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Message } from "../vendor/fast-jev/types.js";

/** Key under `CompactionEntry.details` where this extension stores its state. */
export const DETAILS_KEY = "fastJev";
export const DETAILS_VERSION = 1;

export interface FastJevDetails {
  version: number;
  /** The pruned transcript the previous compaction produced. */
  messages: Message[];
  stats?: unknown;
  decisions?: unknown;
}

export interface PreviousCompaction {
  /**
   * Structured pruned transcript when the previous compaction was produced by
   * this extension. Its messages are re-decided by Jev together with the new
   * span, so old content keeps getting re-evaluated over time.
   */
  messages?: Message[];
  /**
   * Summary text when the previous compaction was pi's built-in one (or the
   * stored structured state was unreadable). Kept verbatim as a pinned,
   * call-less message — there is nothing in it for Jev to score.
   */
  summaryText?: string;
  readFiles: string[];
  modifiedFiles: string[];
}

interface CompactionDetailsShape {
  readFiles?: unknown;
  modifiedFiles?: unknown;
  [DETAILS_KEY]?: unknown;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Structural validation, so a foreign or corrupt `details` never crashes us. */
export function isValidFastJevDetails(value: unknown): value is FastJevDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const details = value as Partial<FastJevDetails>;
  if (details.version !== DETAILS_VERSION || !Array.isArray(details.messages)) return false;
  return details.messages.every(
    (message) =>
      !!message &&
      typeof message === "object" &&
      (message.role === "user" || message.role === "assistant") &&
      typeof message.text === "string" &&
      Array.isArray(message.toolUses) &&
      (message.toolResults === undefined || Array.isArray(message.toolResults)),
  );
}

/**
 * Finds the latest compaction entry on the current branch. When it is ours,
 * its structured pruned transcript becomes the base of the new transcript;
 * otherwise its summary text is kept verbatim as a pinned message. Anything
 * earlier is already contained in whichever of the two we return.
 */
export function findPreviousCompaction(branchEntries: readonly SessionEntry[]): PreviousCompaction | undefined {
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    const entry = branchEntries[index];
    if (!entry || entry.type !== "compaction") continue;
    const details = entry.details as CompactionDetailsShape | undefined;
    const fastJev = details?.[DETAILS_KEY];
    const readFiles = stringList(details?.readFiles);
    const modifiedFiles = stringList(details?.modifiedFiles);
    if (isValidFastJevDetails(fastJev)) {
      return { messages: fastJev.messages, readFiles, modifiedFiles };
    }
    return { summaryText: entry.summary, readFiles, modifiedFiles };
  }
  return undefined;
}

/**
 * Cumulative file tracking, compatible with pi's built-in compaction
 * `details` shape so `/context` file lists keep working across mixed
 * compactions: previous lists plus the file operations pi extracted from the
 * new span. `read` minus anything written/edited is what pi reports.
 */
export function computeFileLists(
  previous: PreviousCompaction | undefined,
  fileOps: FileOperations | undefined,
): { readFiles: string[]; modifiedFiles: string[] } {
  const read = new Set(previous?.readFiles ?? []);
  const modified = new Set(previous?.modifiedFiles ?? []);
  for (const path of fileOps?.read ?? []) read.add(path);
  for (const path of fileOps?.written ?? []) modified.add(path);
  for (const path of fileOps?.edited ?? []) modified.add(path);
  for (const path of modified) read.delete(path);
  return {
    readFiles: [...read].sort(),
    modifiedFiles: [...modified].sort(),
  };
}

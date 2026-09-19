import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Extension configuration. Loaded from (later wins):
 *
 *   1. `~/.pi/agent/fast-jev-compaction.json`  (global)
 *   2. `<cwd>/.pi/fast-jev-compaction.json`    (project)
 *
 * The API key additionally falls back to the `TYPESAFE_API_KEY` environment
 * variable when no config file sets it.
 */
export interface FastJevConfig {
  /** TypeSafe API key. Falls back to `process.env.TYPESAFE_API_KEY`. */
  apiKey?: string;
  /** Jev model name. Default `jev-latest`. */
  model?: string;
  /** TypeSafe System One endpoint. Default `https://api.typesafe.ai/v1/systemone`. */
  baseUrl?: string;
  /** Ongoing task description; when unset the library derives it from the last user prompts. */
  goal?: string;
  /** Minimum keep probability for a call or result to stay. Default `0.5`. */
  keepThreshold?: number;
  /**
   * Newest messages of the summarized span pinned from compaction. Default
   * `0` — pi's `keepRecentTokens` cut already keeps the newest messages out
   * of the summarized span entirely, unlike the Claude Code plugin whose
   * default of `6` covers a whole-session transcript.
   */
  preserveRecentMessages?: number;
  /** Estimated token ceiling for the state. Default `25000`. */
  maxStateTokens?: number;
  /** Estimated token ceiling for state plus one batch of questions. Default `30000`. */
  maxRequestTokens?: number;
  /** Characters of a dropped tool result to retain. Default `300`. */
  truncateHeadChars?: number;
  /**
   * Minimum character reduction (0..1) the decisions must achieve on the
   * summarized span; below it the extension declines and pi's built-in
   * summary runs. Default `0.25`.
   */
  minReductionRatio?: number;
  /** Per-request timeout in milliseconds; `0` disables it. Default `120000`. */
  requestTimeoutMs?: number;
  /**
   * Route Jev requests through the Vercel AI Gateway instead of speaking
   * TypeSafe's native contract. When set, `baseUrl` is the gateway base
   * (e.g. `https://ai-gateway.vercel.sh/v4/ai`) and `model` is the gateway
   * slug (e.g. `typesafe-ai/jev`). Default `false`.
   */
  gateway?: boolean;
  /**
   * When Jev votes to drop a call entirely, keep a one-line record of the
   * call (tool name + input) and only drop the result. Call inputs are
   * cheap, often not re-derivable (exact commands, paths), and this keeps
   * them in the compacted transcript. Default `false` (pure Jev decisions).
   */
  preserveCallInputs?: boolean;
  /**
   * When a failing tool result (pi marks it `isError`) is dropped or
   * truncated, keep its final N characters (the error and stack usually live
   * at the end of the output) instead of losing them. `0` keeps tails off.
   * Default `0`.
   */
  preserveErrorTails?: number;
}

export const CONFIG_FILENAME = "fast-jev-compaction.json";

export function globalConfigPath(): string {
  return join(homedir(), ".pi", "agent", CONFIG_FILENAME);
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, ".pi", CONFIG_FILENAME);
}

function readConfigFile(path: string): FastJevConfig | undefined {
  if (!existsSync(path)) return undefined;
  return sanitizeConfig(JSON.parse(readFileSync(path, "utf8")) as FastJevConfig);
}

const NUMERIC_KEYS = [
  "preserveErrorTails",
  "keepThreshold",
  "preserveRecentMessages",
  "maxStateTokens",
  "maxRequestTokens",
  "truncateHeadChars",
  "minReductionRatio",
  "requestTimeoutMs",
] as const;

/** Drops malformed values instead of letting them crash a compaction later. */
export function sanitizeConfig(raw: FastJevConfig): FastJevConfig {
  const config: FastJevConfig = {};
  for (const key of ["apiKey", "model", "baseUrl"] as const) {
    const value = raw[key];
    if (typeof value === "string" && value.length > 0) config[key] = value;
  }
  if (typeof raw.goal === "string" && raw.goal.trim().length > 0) config.goal = raw.goal;
  for (const key of NUMERIC_KEYS) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) config[key] = value;
  }
  if (raw.gateway === true) config.gateway = true;
  if (raw.preserveCallInputs === true) config.preserveCallInputs = true;
  return config;
}

/**
 * Reads and merges the global and project config files (project wins).
 * Throws on malformed JSON — callers decide whether that is fatal. The path
 * overrides exist for tests.
 */
export function loadConfigFiles(
  cwd: string,
  overrides?: { globalPath?: string; projectPath?: string },
): { config: FastJevConfig; paths: string[] } {
  const globalPath = overrides?.globalPath ?? globalConfigPath();
  const projectPath = overrides?.projectPath ?? projectConfigPath(cwd);
  const global = readConfigFile(globalPath);
  const project = readConfigFile(projectPath);
  const paths = [
    ...(global !== undefined ? [globalPath] : []),
    ...(project !== undefined ? [projectPath] : []),
  ];
  return { config: { ...global, ...project }, paths };
}

/** The API key from the config files or `TYPESAFE_API_KEY`. */
export function resolveApiKey(config: FastJevConfig): string | undefined {
  if (typeof config.apiKey === "string" && config.apiKey.length > 0) return config.apiKey;
  const fromEnv = process.env.TYPESAFE_API_KEY;
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

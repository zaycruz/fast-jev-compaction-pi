/**
 * Registers the benchmark summarizer provider: THE SESSION MODEL the user
 * actually runs daily (zap/glm-5.3-flash-sglang via the zap router), so pi's
 * built-in compaction arm reflects real usage. Endpoint, key and model id all
 * come from env set by bench/run-bench.mjs.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function benchProvider(pi: ExtensionAPI) {
  pi.registerProvider("bench-sum", {
    name: "Bench summarizer (session model via zap)",
    baseUrl: process.env.BENCH_SUM_BASE_URL ?? "http://asus-trx50:4000/v1",
    apiKey: process.env.BENCH_SUM_API_KEY ?? "missing",
    api: "openai-completions",
    models: [
      {
        id: process.env.BENCH_SUM_MODEL ?? "glm-5.3-flash-sglang",
        name: "Session model (bench)",
        reasoning: true,
        input: ["text"],
        contextWindow: 499_712,
        maxTokens: 32_768,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
        },
      },
    ],
  });
}

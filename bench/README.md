# Benchmark: fast-jev-compaction vs pi's built-in summary compaction

Measures the extension against pi's built-in compaction on identical synthetic
sessions across four dimensions: compaction latency, compaction token cost,
size of the context the model sees afterwards, and information retention
(exact-string recall + downstream QA with the same model).

## Arms

| Arm | What runs |
| --- | --- |
| `fastjev` | This extension scoring with **real `typesafe-ai/jev`** through the Vercel AI Gateway (`BENCH_JEV_REAL=1`, the default for published numbers). A policy mock (`BENCH_JEV_REAL=0`) exists for offline development. `BENCH_PRESERVE_INPUTS=1` enables `preserveCallInputs` (see below). |
| `builtin` | pi's built-in compaction, unmodified, driven with the user's actual session model (`zap/glm-5.3-flash-sglang` via the zap router — the same model their live pi sessions run; the default codex route is quota-exhausted here). The summarizer works on pi's serialized span, where tool results are truncated to 2,000 chars before any model sees them. |

Sessions come from `bench/gen-session.mjs` (fixed seed per size): scripted
coding turns (read/bash/edit) with fat tool outputs and planted "memory
markers" of four kinds — user constraints, file paths (in call inputs),
commands (in call inputs), and fatal error codes buried deep (55–90 % depth)
inside tool outputs. Both arms get byte-identical sessions.

QA asks three questions about planted facts with tools disabled (`-nt`), so
the model can only answer from the compacted context; answers are graded by
exact substring (error codes on the hex token). Token counts are what the
providers report (the zap router splits prompts into fresh + prefix-cached;
both are counted; Jev usage is provider-reported through the gateway).

## Running

```sh
BENCH_JEV_REAL=1 node bench/run-bench.mjs small medium large
# mock policy instead (offline): node bench/run-bench.mjs small
```

Needs the zap router (`asus-trx50:4000`) + `~/.pi/agent/zap.key` for the
built-in arm, and `VERCEL_AI_GATEWAY_API_KEY` (1Password: `op item get`) for
the real-Jev arm. Results land in `bench/results-<ts>.json`.

## Results (2026-09-18, real typesafe-ai/jev via the gateway, glm-5.3-flash as the session model)

Three fast-jev variants matter: **pure** (Jev decisions untouched) and
**tuned** (`preserveCallInputs: true` — calls Jev voted to drop keep a
one-line record of tool + input, only the result goes). Built-in numbers are
from the same runs; the large built-in cell in the tuned run failed
(summarizer hit its max generation length; pi rejects length-stopped
summaries — the scored path cannot fail that way), so its large cell comes
from the pure run minutes earlier.

### Compaction operation

| session | arm | compact wall | context after |
|---|---|---|---|
| small (7.7k) | **fast-jev pure** | **0.28 s** | **345 tok** |
| small | fast-jev tuned | 0.34 s | 1,375 tok |
| small | built-in summary | 16.3 s | 1,049 tok |
| medium (14.8k) | **fast-jev pure** | **0.38 s** | **626 tok** |
| medium | fast-jev tuned | 0.31 s | 2,683 tok |
| medium | built-in summary | 16.3 s | 1,279 tok |
| large (26.9k) | **fast-jev pure** | **0.44 s** | **999 tok** |
| large | fast-jev tuned | 0.47 s | 4,783 tok |
| large | built-in summary | 24.7 s | 1,612 tok |

Compaction token cost (real, provider-reported): Jev requests are 2.2k–8.2k
in + 0.3k–1.4k out regardless of tuning (the questions are identical; only
local application differs). The built-in summarizer used 6.1k–18.2k in +
2.3k–4.7k out.

### Retention — exact strings the model still sees

| session | arm | constraints | paths (inputs) | commands (inputs) | errors (deep in outputs) |
|---|---|---|---|---|---|
| small | fast-jev pure | 3/3 | 0/4 | 0/4 | 0/1 |
| small | **fast-jev tuned** | 3/3 | **4/4** | **4/4** | 0/1 |
| small | built-in | 3/3 | 4/4 | 3/4 | 0/1 |
| medium | fast-jev pure | 5/5 | 0/14 | 0/2 | — |
| medium | **fast-jev tuned** | 5/5 | **14/14** | **2/2** | — |
| medium | built-in | 5/5 | 14/14 | 2/2 | — |
| large | fast-jev pure | 10/10 | 0/17 | 0/8 | 0/3 |
| large | **fast-jev tuned** | 10/10 | **17/17** | **8/8** | 0/3 |
| large | built-in | 10/10 | 17/17 | 0/8 | 2/3 |

### Downstream memory QA (session model, tools disabled, 3 questions)

| session | fast-jev pure | **fast-jev tuned** | built-in |
|---|---|---|---|
| small | 1/3 | **2/3** | 1/3 |
| medium | 1/2 | **2/2** | 2/2 |
| large | 1/3 | **2/3** | 3/3* |
| total | 3/8 | **6/8** | 4–5/8 |

*tuned run; the pure run's built-in large cell scored 2/3.

## Reading the numbers

- **Latency and cost:** real Jev scored each span in 277–435 ms with one
  request (2.2k–8.2k in, 0.3k–1.4k out, provider-reported). The summarizer
  took 16–25 s and 9k–23k tokens. Compaction becomes effectively free.
- **Pure vs tuned:** real Jev drops old tool calls wholesale (keepCall
  0.25–0.29 for stale calls in this bench): pure mode produces the smallest
  context of anything measured (345–999 tokens) but loses exact call inputs.
  Tuned mode (`preserveCallInputs: true`) downgrades those drops to
  result-only removals, which restored every planted path and command
  (35/35 + 14/14 inputs) and lifted memory QA from 3/8 to 6/8, at the price
  of a larger context (the call-input lines plus 300-char result heads).
  Deep error codes stay dropped in both: they live in result content, which
  Jev treats as re-derivable, and the note says so.
- **Failure modes:** the built-in summarizer can fail outright — in the tuned
  run its large cell died by exceeding max generation length (pi rejects
  length-stopped summaries). The scored path has no generation step, so it
  cannot fail that way; its only failure inputs are Jev/transport errors,
  which fall back to the built-in summary.
- **Which configuration wins depends on what you value:** pure Jev for the
  smallest, cheapest continuation (text verbatim, tool history re-derive on
  demand); tuned for exact old commands/paths in-context at still-50x-faster
  compaction; the built-in summary when you want an LLM to guess what matters.

Caveats: one seed per size; one session model; three QA questions; marker
retention measures exact strings, not semantic usefulness. Jev scoring is
real; its policy is the provider's, not configurable by this benchmark.

# Benchmark: fast-jev-compaction vs pi's built-in summary compaction

Measures the extension against pi's built-in compaction on identical synthetic
sessions across four dimensions: compaction latency, compaction token cost,
size of the context the model sees afterwards, and information retention
(exact-string recall + downstream QA with the same model).

## Arms

| Arm | What runs |
| --- | --- |
| `fastjev` | This extension scoring with **real `typesafe-ai/jev`** through the Vercel AI Gateway (`BENCH_JEV_REAL=1`, the default for published numbers). A policy mock (`BENCH_JEV_REAL=0`) exists for offline development. |
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

### Compaction operation

| session | pre-ctx | arm | compact wall | compaction tokens (in / out) | context after |
|---|---|---|---|---|---|
| small (7.7k) | 7,731 tok | **fast-jev (real)** | **0.28 s** | 2,169 / 292 | **345 tok** |
| small | | built-in summary | 16.3 s | 6,137 / 2,761 | 1,049 tok |
| medium (14.8k) | 14,755 tok | **fast-jev (real)** | **0.38 s** | 4,244 / 670 | **626 tok** |
| medium | | built-in summary | 16.3 s | 11,511 / 2,837 | 1,279 tok |
| large (26.9k) | 26,854 tok | **fast-jev (real)** | **0.44 s** | 8,180 / 1,354 | **999 tok** |
| large | | built-in summary | 24.7 s | 18,216 / 4,690 | 1,612 tok |

### Retention — exact strings the model still sees

| session | arm | constraints | paths (call inputs) | commands (call inputs) | errors (deep in outputs) |
|---|---|---|---|---|---|
| small | **fast-jev (real)** | 3/3 | 0/4 | 0/4 | 0/1 |
| small | built-in | 3/3 | 4/4 | 4/4 | 0/1 |
| medium | **fast-jev (real)** | 5/5 | 0/14 | 0/2 | — (none planted) |
| medium | built-in | 5/5 | 14/14 | 0/2 | — |
| large | **fast-jev (real)** | 10/10 | 0/17 | 0/8 | 0/3 |
| large | built-in | 10/10 | 17/17 | 0/8 | 2/3 |

### Downstream memory QA (session model, tools disabled, 3 questions)

| session | fast-jev (real) | built-in | QA prompt tokens fast-jev / built-in |
|---|---|---|---|
| small | 1/3 | **2/3** | 1,046 / 1,627 |
| medium | 1/2 | 1/2 | 1,360 / 1,816 |
| large | 1/3 | **2/3** | 1,120 / 2,598 |

## Reading the numbers

- **Latency and cost:** real Jev scored each span in 277–435 ms with one
  request (2.2k–8.2k in, 0.3k–1.4k out, provider-reported). The summarizer
  took 16–25 s and 9k–23k tokens. Compaction becomes effectively free.
- **Context after — the surprise:** with real scoring, fast-jev's compacted
  transcript is *smaller* than the LLM summary (999 vs 1,612 tokens at large).
  Real Jev drops old tool calls wholesale, keeping user and assistant text.
  The "verbatim is bigger" intuition from a conservative policy does not hold
  with the real model.
- **Retention — Jev's design bet:** real Jev treats tool outputs as
  re-derivable: it pruned *all* old call inputs and deep error codes in this
  bench (paths/commands/errors 0 across sizes) while keeping every planted
  user constraint (18/18, verbatim). The built-in summary happened to carry
  more old tool facts (paths in its file lists, a command it copied), and won
  the memory-QA column 5/8 vs 3/8. In other words: real Jev optimizes for a
  cheap continuation and assumes re-running tools is cheap too; if your
  workflow needs exact old tool facts in-context without re-running, that is
  what the `keepThreshold` knob and the `minReductionRatio` fallback are for —
  and what the built-in summary still does better today.
- **Which arm "wins" depends on what you value:** continuation cost and speed
  (fast-jev, by a wide margin) vs passive retention of old tool trivia
  (built-in summary, when the summarizer happens to copy it — which is not
  guaranteed, nondeterministic, and failed on 2 of 3 command sets here).

Caveats: one seed per size; one session model; three QA questions; marker
retention measures exact strings, not semantic usefulness. Jev scoring is
real; its policy is the provider's, not configurable by this benchmark.

# Benchmark: fast-jev-compaction vs pi's built-in summary compaction

Measures the extension against pi's built-in compaction on identical synthetic
sessions across four dimensions: compaction latency, compaction token cost,
size of the context the model sees afterwards, and information retention
(exact-string recall + downstream QA with the same model).

## Arms

| Arm | What runs |
| --- | --- |
| `fastjev` | This extension. Jev's decisions come from `bench/mock-jev.mjs`, a policy emulating how a real Jev scores (recent results and errors stay verbatim, older results truncate to their head, calls stay). **No real TYPESAFE_API_KEY exists in this environment — Jev's decisions are simulated.** Per-request latency 500 ms; requests run in parallel. |
| `builtin` | pi's built-in compaction, unmodified, driven with the **user's actual session model**: `zap/glm-5.3-flash-sglang` (the same model their live pi sessions run; the default codex route is quota-exhausted here). The summarizer works on pi's serialized span, where tool results are truncated to 2,000 chars before any model sees them. |

Sessions come from `bench/gen-session.mjs` (fixed seed per size): scripted
coding turns (read/bash/edit) with fat tool outputs and planted "memory
markers" of four kinds — user constraints, file paths (in call inputs),
commands (in call inputs), and fatal error codes buried deep (55–90 % depth)
inside tool outputs. Both arms get byte-identical sessions.

QA asks three questions about planted facts with tools disabled (`-nt`), so
the model can only answer from the compacted context; answers are graded by
exact substring (error codes on the hex token). Token counts are what the
providers report (the zap router splits prompts into fresh + prefix-cached;
both are counted).

## Running

```sh
node bench/run-bench.mjs small medium large
MOCK_LATENCY_MS=200 node bench/run-bench.mjs small
```

Needs the zap router (`asus-trx50:4000`) and `~/.pi/agent/zap.key` for the
built-in arm; the fast-jev arm needs only `node`. Results land in
`bench/results-<ts>.json`.

## Results (2026-09-18, zap/glm-5.3-flash-sglang as the session model)

### Compaction operation

| session | pre-ctx | arm | compact wall | compaction tokens (in+cache / out) | context after |
|---|---|---|---|---|---|
| small (7.7k) | 7,731 tok | **fast-jev** | **0.52 s** | 1,519 / 128 | 2,418 tok |
| small | | built-in summary | 10.9 s | 6,137 / 2,058 | 1,187 tok |
| medium (14.8k) | 14,755 tok | **fast-jev** | **0.52 s** | 3,116 / 288 | 3,115 tok |
| medium | | built-in summary | 18.5 s | 11,639 / 3,358 | 1,081 tok |
| large (26.9k) | 26,854 tok | **fast-jev** | **0.52 s** | 6,176 / 576 | 6,565 tok |
| large | | built-in summary | 25.8 s | 18,408 / 5,126 | 1,601 tok |

### Retention — exact strings the model still sees

| session | arm | constraints | paths (inputs) | commands (inputs) | errors (deep in outputs) |
|---|---|---|---|---|---|
| small | **fast-jev** | 3/3 | 4/4 | **4/4** | **1/1** |
| small | built-in | 3/3 | 4/4 | **0/4** | **0/1** |
| medium | **fast-jev** | 5/5 | 14/14 | 2/2 | — (none planted) |
| medium | built-in | 5/5 | 14/14 | 2/2 | — |
| large | **fast-jev** | 10/10 | 17/17 | **8/8** | **3/3** |
| large | built-in | 10/10 | 17/17 | **0/8** | 2/3 |

### Downstream memory QA (session model, tools disabled, 3 questions)

| session | fast-jev | built-in | QA prompt tokens fast-jev / built-in |
|---|---|---|---|
| small | **3/3** | 1/3 | 3,850 / 1,695 |
| medium | **2/2** | 2/2 | 3,925 / 1,436 |
| large | **3/3** | 2/3 | 8,463 / 2,598 |

## Reading the numbers

- **Latency:** fast-jev's parallel scoring requests finished in ~0.5 s at every
  size; the summary LLM took 11–26 s (and a frontier cloud model would still
  take seconds, because it must read and rewrite the whole span). Auto-compact
  runs mid-session — this gap is user-visible.
- **Compaction token cost:** the summarizer reads the full serialized span
  (6–18 k in) and writes a long structured summary (2–5 k out, reasoning
  included). fast-jev sends a *fitted* state (results omitted) plus tiny
  questions — 2–4× fewer input tokens — and its "output" is a few numbers per
  call.
- **Context size — the honest trade-off:** the verbatim transcript is 2–4×
  bigger than a summary after compaction (6.6 k vs 1.6 k tokens at large).
  Every subsequent request pays that until the next compaction. That is the
  price of not paraphrasing anything away.
- **Retention — the structural gap:** summaries lost *every* cache-flush
  command at small/large (0/4, 0/8) even with a decent model, because pi's
  serialization hides deep tool content from the summarizer and summarization
  compresses inputs into prose ("run flush checks"). fast-jev keeps call
  inputs verbatim (14/14 across sizes) and error results verbatim (4/4) —
  which items are kept is Jev's call; that anything deep *can* survive is the
  mechanism's point. The QA column makes it concrete: 8/8 vs 5/8, and the
  built-in's small-session error miss was a **confident wrong answer**
  (`FATAL 0x449DF2A9` instead of the real `0xD50C74A6`) — worse than "I don't
  know".
- **Total cost of ownership at `large`** (compaction + 3 downstream turns):
  fast-jev ≈ 15.2 k tokens; built-in ≈ 26.1 k. The bigger post-compaction
  context did *not* make fast-jev more expensive overall — the summarizer's
  own call dominates.

Caveats: Jev's decisions are simulated (no API key here); one seed per size;
one session model; three QA questions. The benchmark measures the *mechanism*
(scoring + verbatim vs rewriting) honestly; production retention depends on a
real Jev's scoring quality.

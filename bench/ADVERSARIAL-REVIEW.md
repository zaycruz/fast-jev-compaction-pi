# Adversarial review of the benchmark findings

A red-team pass over `bench/` results and claims: what was attacked, what
broke, what was fixed, and what stands. Findings are ordered by severity.

## F1 (fixed): the error-marker turn labels were wrong

`gen-session.mjs` planted error markers with `turn: null` and stamped them
with the **last** turn of the session afterwards, so every error marker was
labeled as if it sat in the newest turn regardless of its true position.
Effect: the span/tail classification for error markers was wrong (their QA
selection worked only by luck of an off-by-one), and any per-turn error
analysis would be misled.

**Fixed:** markers now record their true turn at plant time. The three large
error markers are genuinely in the compacted span (turns 17, 26, 29 —
verified by locating the codes in the pre-compaction entries), so the
error-retention comparison was measured against real span content, not the
shared kept tail.

## F2 (fixed): "built-in failed outright" was partly my configuration

The built-in arm's large-session failure ("generation hit the maximum token
length") occurred under the benchmark's `reserveTokens: 8000` override, which
caps the summarizer's generation budget below pi's default (16384). Re-running
large/built-in with pi defaults: **succeeds** — 4,999-char summary, 5,455 in /
2,607 out. The scored path still cannot fail by generation length (it
generates nothing), but the built-in does not fail under its native settings.

**Fixed:** benchmark uses pi's default `reserveTokens`; README language
corrected.

## F3 (found, stands): tail=800 missed the deepest error; 1200 covers it

The tuned+tails run recovered 2/3 deep error codes at large. The missed one
(`0xD50C74A6`) sits at 81% depth of a 4,906-char log — 934 chars from the end,
past the 800-char tail. Verified: **tail 1200 covers it**. Recommendation and
sample config updated to `preserveErrorTails: 1200`. With that value the
tuned config retains 3/3 planted error codes where the built-in summary
retained 2/3 (the same two shallower codes — both arms miss the deepest one
at 800).

## F4 (found, stands): QA error question was ambiguous, not a retention gap

At large, **both** models answered the error question with the same "wrong"
code (`0x449DF2A9`). Root cause: the session plants ~3 fatal errors; the
question asked for the first one, and both models picked a later one that was
in context. The fast-jev miss was a question-ambiguity miss, not a retention
miss (`0x449DF2A9` was in fast-jev's context too). The QA question now says
"FIRST fatal error code". Net effect: the QA tie (6/8 vs 6/8) is real, and
the error-QA comparison should be read through the retention table, not the
single QA row.

## F5 (found, stands): pi's cut kept ~nothing regardless of keepRecentTokens

Across six RPC-driven compactions with `keepRecentTokens` set to 2000, 8000,
and 20000, pi's cut kept only the final ~2 entries (~8 tokens) and summarized
/ scored the entire remaining context (~7.7k–26.9k tokens). This held while
other settings from the same file demonstrably loaded (`reserveTokens: 8000`
changed built-in behavior). Consequences for the benchmark:

- **Fairness holds:** both arms received the identical span and the identical
  (~empty) kept tail; every comparison is like-for-like.
- **The built-in arm was tested harsher than a typical user setup:** with a
  20k-token kept tail (the documented intent), the built-in would summarize
  ~7k tokens instead of ~27k — cheaper and more retentive than measured here.
  fast-jev was tested under the same harsher condition (it scored the full
  span), so the relative result stands; absolute numbers for both arms are
  the "full-span" case.
- Worth investigating separately (possibly an RPC-mode or tool-heavy-session
  quirk in pi's cut accumulation); flagged for upstream.

## F6 (found, stands): fast-jev's token-cost advantage does not scale unconditionally

fast-jev's requests = fitted state + questions, resent per batch. Measured
sessions had 1 batch (≤26 calls). Scaling arithmetic: at the 25k state
ceiling, ~200 candidate calls ≈ 24k tokens of questions ≈ 5 batches ≈
~125k input tokens — **more** than the built-in summarizer's ~23k for the
same session. The cost claim ("2–3× cheaper") holds for the measured sizes
and inverts for very call-heavy, near-ceiling-state sessions. Latency stays
lower (batches run in parallel; outputs are tiny). README now states this.

## F7 (minor, noted)

- Marker retention counts summary + kept tail; the tail was ~empty here
  (F5), so retention numbers reflect the compacted artifact alone.
- The QA judge is the session model; exact hex codes cannot be guessed, but
  command paraphrases graded MISS could occasionally be functionally
  equivalent ("curl -X POST …" vs "curl -s …"). Grading is deliberately
  strict on exactness for both arms.
- Error-tail coverage is position-based: results whose error sits deeper
  than the tail window are missed (deterministically). Errors in
  non-flagged results (exit 0 with error text) are not covered by the
  `isError` signal at all.
- The earlier simulated-policy results (commands 14/14, QA 8/8) were
  properties of the mock policy, not of Jev; they are fully replaced by the
  real runs everywhere in the docs.

## Net effect on published claims

| Claim | Verdict after review |
| --- | --- |
| ~50× faster compaction | **stands** (0.28–0.47 s vs 16–117 s, real models) |
| 2–3× cheaper compaction tokens | **stands for measured sizes**; F6 documents the inversion point |
| smaller post-compaction context (pure) | **stands** (345–999 tok vs 1,049–1,612 tok) |
| exact commands/paths retained (tuned) | **stands, improved** (deterministic, 49/49) |
| deep error retention at parity (tuned+tails) | **stands, strengthened** (2/3 → 3/3 at tail 1200; native 2/3 via paraphrase luck) |
| built-in can fail by generation length | **withdrawn** — artifact of my reserveTokens override (F2) |
| deterministic vs nondeterministic retention | **stands** |

# fast-jev-compaction for pi

A [pi](https://github.com/earendil-works/pi-mono) extension version of
[tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
— the Claude Code plugin that replaces the compaction summary with **Jev
decisions**: every tool call and result of the summarized span is scored in
fast requests, stale ones are dropped or truncated, and everything kept stays
verbatim. User and assistant text is never rewritten or summarized.

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even
when it matters later. This extension never rewrites anything. It hooks pi's
`session_before_compact` event, asks TypeSafe's Jev model — over the whole
conversation, with tool results omitted — which tool calls and results are
still needed, and replaces the LLM summary with a verbatim transcript of what
survived:

- tool calls Jev says no longer matter are removed together with their results;
- results whose contents are stale but whose call still matters are truncated
  to their first `truncateHeadChars` characters plus a note
  (`[fast-jev-compaction truncated N chars of this tool result; re-run the
  tool if needed]`);
- everything else — user prompts, assistant text, kept calls and results —
  stays verbatim and in order.

The compacted transcript is stored as JSON in the compaction entry's
`details.fastJev.messages`, so the next compaction re-decides over the
accumulated pruned transcript instead of re-summarizing a summary —
compaction stays continuous and lossless-with-deletions across sessions.

## Install

```sh
# from the npm registry (pinned to the published version)
pi install npm:fast-jev-compaction-pi@0.1.1

# or from this repo
pi install git:github.com/zaycruz/fast-jev-compaction-pi@v0.1.1
pi install git:github.com/zaycruz/fast-jev-compaction-pi      # track main

# project-only (written to .pi/settings.json, shared with your team)
pi install -l git:github.com/zaycruz/fast-jev-compaction-pi
```

Try it without installing (temp checkout, current run only):

```sh
pi -e npm:fast-jev-compaction-pi
pi -e git:github.com/zaycruz/fast-jev-compaction-pi
```

Then run `/fast-jev-status` in any session to confirm it loaded and see the
resolved configuration. Updates: `pi update --extensions` (unpinned installs)
or `pi install git:github.com/zaycruz/fast-jev-compaction-pi@vX.Y.Z` (move a
pinned ref).

Manual install also works — copy or symlink this directory into pi's
extension folder (`~/.pi/agent/extensions/` global, `.pi/extensions/`
project). No `npm install` is needed at runtime: the extension has zero
runtime dependencies (the fast-jev core library is vendored under `vendor/`),
and pi serves `@earendil-works/pi-coding-agent` itself.

> **Security:** extensions run with your full system permissions. Review the
> source before installing — it is small: `index.ts` + `lib/` (5 files) plus
> the vendored upstream core under `vendor/`.

## Configure

The API key comes from the config files or the environment:

```sh
export TYPESAFE_API_KEY=...
```

Optional settings live in `~/.pi/agent/fast-jev-compaction.json` (global) or
`<project>/.pi/fast-jev-compaction.json` (project, wins):

```json
{
  "apiKey": "…",
  "model": "jev-latest",
  "baseUrl": "https://api.typesafe.ai/v1/systemone",
  "keepThreshold": 0.5,
  "preserveRecentMessages": 0,
  "maxStateTokens": 25000,
  "maxRequestTokens": 30000,
  "truncateHeadChars": 300,
  "minReductionRatio": 0.25,
  "requestTimeoutMs": 120000,
  "goal": "optional standing task description"
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key |
| `model` | `jev-latest` | Jev model name |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | System One endpoint |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `0`¹ | Newest messages of the summarized span pinned from scoring |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped result retained before the note |
| `minReductionRatio` | `0.25` | Minimum character reduction on the span required to replace the built-in summary |
| `requestTimeoutMs` | `120000` | Per-request timeout; `0` disables it |
| `goal` | derived | Ongoing task description; otherwise the last user prompts |

¹ Unlike the Claude Code plugin (default `6`), pi's `keepRecentTokens` cut
already keeps the newest messages out of the summarized span entirely, so the
adapter pins nothing extra by default.

Run `/fast-jev-status` in a session to print the resolved configuration and
the outcome of the last compaction.

## Behavior

- **Triggers.** Works for auto-compaction (context threshold), `/compact`,
  and overflow recovery. `/compact` *with focus instructions* defers to pi's
  built-in summary — instructions ask for a summary, which is exactly what
  this extension does not produce; without instructions the verbatim path runs.
- **Fallback.** Missing API key, Jev errors, timeouts, unfittable histories,
  and spans where Jev's decisions reduce less than `minReductionRatio` all
  decline: pi's built-in LLM summary runs instead. Nothing is ever half-applied.
- **Pinning.** The first message of the transcript and the newest
  `preserveRecentMessages` of the span are never candidates, mirroring
  upstream.
- **Continuity.** The pruned transcript persists in `details.fastJev.messages`
  and is re-scored together with each new span. If the latest compaction was
  pi's built-in one, its summary text is carried verbatim as a pinned message
  instead, so switching between engines never loses context.
- **Bookkeeping.** Jev's token usage is recorded on the entry (pi's `Usage`
  shape, cost zeroed), and `details.readFiles`/`details.modifiedFiles` keep
  pi's cumulative file tracking working across mixed compactions.
- **Session size.** `details` stores the pruned transcript as JSON in addition
  to the rendered summary text, roughly doubling the compacted span's bytes in
  the session file. That redundancy is what makes lossless continuation
  possible.

## Differences from the Claude Code plugin

| | Claude Code plugin | pi extension |
| --- | --- | --- |
| Integration | `session.compact` hook replaces the whole transcript | `session_before_compact` replaces the summarized span with a rendered transcript; pi keeps the recent tail itself |
| Auto trigger | `turn.complete` + `compactAtPercent` | pi's native threshold (`compaction.reserveTokens`) — no reimplementation needed |
| Re-compaction | pruned transcript persists as session messages | pruned transcript persists in `details.fastJev.messages` and is re-decided each time |
| Repeated-request state | whole transcript refitted each time | same (plus the carried previous transcript) |
| Branch summaries | — | untouched (out of scope, as upstream) |

The vendored core (`vendor/fast-jev/`) is upstream's `src/` copied
unmodified; see `vendor/README.md`.

## Does it actually help? (benchmark)

`bench/` measures fast-jev against pi's built-in summary compaction on
identical seeded sessions with planted "memory markers" — real
`typesafe-ai/jev` through the Vercel AI Gateway for the extension, and the
real session model (`zap/glm-5.3-flash-sglang`) for the built-in arm. Results
at `large` (~27k-token context; full tables and method in
[bench/README.md](bench/README.md)):

| | fast-jev (real Jev) | built-in summary |
| --- | --- | --- |
| compaction wall | **0.44 s** | 24.7 s |
| compaction tokens | **9.5 k** | 22.9 k |
| context after | **999 tok** | 1,612 tok |
| planted user constraints kept | **18/18** (verbatim) | 18/18 |
| old tool facts kept (paths/commands/errors) | 0 (Jev prunes; re-run instead) | partial, nondeterministic |
| downstream memory QA (3 questions) | 3/8 | **5/8** |

The honest read: real Jev makes compaction ~50× faster and cheaper than an
LLM summary, and its pruned transcript is even smaller than a summary —
because it treats tool outputs as re-derivable and drops old calls outright,
keeping user and assistant text verbatim. The cost is passive recall of old
tool trivia: if your workflow needs exact old commands in-context without
re-running them, the built-in summary still retains more (when it happens to
copy them). Run it yourself with
`BENCH_JEV_REAL=1 node bench/run-bench.mjs small medium large`.

## Development

```sh
npm install        # dev deps: typescript, vitest, pi-coding-agent (types + convertToLlm)
npm run typecheck
npm test           # unit tests, ported from upstream plus adapter tests, no network
npm run e2e        # seeds a session, runs a mock Jev server, drives pi --mode rpc through compaction
```

The e2e script accepts scenarios: `bash e2e/run.sh [callP resultP [second]]`
— e.g. `bash e2e/run.sh 0.05 0.05` (drop whole calls), `bash e2e/run.sh 0.95
0.05 second` (two compactions across pi restarts to prove continuity), and
`MOCK_FAIL=500 bash e2e/run.sh` (Jev failure → fallback). It uses a temp
directory, a mock server on localhost, and never touches a real API.

## License

MIT — the vendored core is [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
by Tamara Tran (MIT).

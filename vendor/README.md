# Vendored: fast-jev-compaction core

The four TypeScript files in this directory are copied **unmodified** from
[tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
(MIT license, `src/` at the upstream repo root; see `../LICENSE`).

| File | Upstream path |
| --- | --- |
| `types.ts` | `src/types.ts` |
| `request.ts` | `src/request.ts` |
| `state.ts` | `src/state.ts` |
| `compact.ts` | `src/compact.ts` |

Not vendored (unused by this extension; available upstream):

- `src/client.ts` — `JevClient` HTTP wrapper. The extension builds its own
  asker so it can pass pi's `AbortSignal` and a per-request timeout.
- `src/messages.ts` — `compactMessages` convenience wrapper.

Update by re-copying the four files from a newer upstream checkout; the
extension's adapter code (`../lib/`, `../index.ts`) only uses the public
surface (`compact`, `reductionRatio`, `resolveOptions`, `messageChars`,
`buildJevRequest`, `parseJevResponse`, and the `types.ts` shapes).

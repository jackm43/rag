# Code reduction audit

Baseline: `main` at `2a164e8`. Working branch: `codex/reduce-handwritten-code`.

Count physical lines in tracked Python, JavaScript, CSS, HTML, SQL, TypeScript,
JSX, TSX, and shell source. Exclude generated platform stubs, generated
`src/ragbot/_bundled.py`, and the read-only `schema.sql` mirror. Include blank
lines and comments consistently on both sides. JSON fixtures, manifests,
lockfiles, and documentation are outside this source-code measure.

| Source | Baseline | Current |
| --- | ---: | ---: |
| Production | 2,488 | 2,474 |
| Local UI and harness | 847 | 847 |
| Tests | 1,029 | 534 |
| Scripts | 544 | 512 |
| Retired migration experiment | 67 | 0 |
| Immutable migrations | 125 | 125 |
| **Total** | **5,100** | **4,492** |

The reduction is **608 lines (11.92%)**. The requested 40% target is **3,060
lines**, leaving another **1,432 lines** to remove. The target is not achieved.

## Changes

- Retire the one-off discord.py compatibility experiment and its runner.
  Historical results remain in the migration notes and source in Git history.
- Remove registration snapshots, local UI tests, and isolated helper tests.
- Keep primary command, moderation, conversation, media, and spend workflows.
- Consolidate image and download stream reading while retaining the 25 MiB cap.
- Exercise authentication through the actual Worker runtime instead of an
  injected cryptography verifier.

The UI and harness, command set, deployment bindings, Durable Object identity,
and migration history are unchanged.

## Verification

`pnpm run check`, `pnpm test` (14 cases), and `pnpm run test:runtime` pass.
The runtime suite covers valid, tampered, stale, future, and malformed
interaction signatures; signed invalid JSON/payloads; missing authentication
configuration; all three control routes' denials; method/path routing; a signed
`/rag` request and its D1 write; `/ask`; spend recording; multipart output;
stream cancellation at the media cap; and a local gateway WebSocket exchange.

The narrower suite deliberately drops detailed internal retry/bucket, config
fallback, gateway state-machine, and UI simulation tests. Passing the remaining
suite does not establish exhaustive coverage of those internals.

## Accepted scope

Preserving the UI rules out reductions to its 847 lines. Even deleting all
remaining tests and scripts would not supply the remaining 1,432 lines, and
would remove the requested verification and operational tooling. Further work
must substantially simplify production implementation or remove functionality.
The user accepted the current reduction for now. No bot feature removal has
been selected or implemented; the original 40% target remains unmet.

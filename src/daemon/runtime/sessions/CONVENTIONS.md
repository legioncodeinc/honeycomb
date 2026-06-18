# sessions prune (daemon side) — CONVENTIONS (PRD-020a / D-3)

`attachSessionsPrune` (`prune.ts`) is the daemon-side handler for `sessions prune`, the LOAD-BEARING
correctness rule (a-AC-2 / D-3). It mirrors `attachHooksHandlers` (019b): the daemon assembly calls
it ONCE after `createDaemon(...)`, attaching onto the already-mounted `/api/sessions` group via
`daemon.group(...)` — ZERO `server.ts` edits.

## The paired delete (D-3) — never desync

`DELETE /api/sessions/prune` must delete BOTH:
1. the matching `sessions` trace rows, AND
2. the paired `/summaries/<user>/<sessionId>.md` `memory` summary rows,

in ONE atomic step, so traces and summaries never desync (no orphaned summary, no dangling trace).
`resolvePruneTargets` returns the explicit (`sessions`, `memory`) pair — a Wave-2 change that drops
the `memory` target is a desync regression caught in review.

## Soft-delete / tombstone (the DeepLake unreliable-DELETE lesson)

A hard `DELETE` is not reliable on this backend. The prune ADVANCES a tombstone the read path
filters (append-only), matching the 013a sources-purge + 008b supersede pattern. Wave 2 verifies no
desync with a live itest.

## Storage-correct + SQL-guarded

Lives under `src/daemon/`. The matched-session select + the tombstone writes run through the injected
`StorageQuery`; EVERY interpolated value (author, before-date, session-id) goes through the pure
`sql.ts` guards (`sqlStr`/`sqlLike`/`sqlIdent`) — the `audit:sql` gate proves it. The CLI never sees
SQL.

**Wave 1 = honest no-op attach.** No route registered yet; the group answers the 501 scaffold until
Wave 2 fills the paired-delete handler.

# EXECUTION LEDGER — PRD-028 Storage read-consistency layer

> Orchestrator: `/the-smoker` · Branch: `prd-028-storage-read-consistency` · SSOT for AC tracking.
> Goal: make read-your-writes a PROPERTY OF THE STORAGE LAYER — a single `readConverged()` seam that
> polls `query` until a caller-supplied predicate (fed by a write-emitted watermark) holds or a bounded
> budget exhausts (fail-SOFT, never invents a row). Retire the hand-rolled poll loops in the live itests.

## Phase 0 recon facts (for the bees)
- `src/daemon/storage/client.ts`: `StorageQuery` interface (line ~350), `query(sql, scope, opts)` (line ~245). NOTE: `query` ALREADY has a TRANSIENT-failure retry (PRD-028's sibling #50 — `isReadStatement`/`isTransientResult`, retries connection/timeout/5xx). `readConverged` is DIFFERENT and complementary: it polls on OK results until a freshness PREDICATE holds (the stale-segment under-report case), not on transport failures. Reuse the abort/timeout discipline (`HONEYCOMB_QUERY_TIMEOUT_MS`).
- `src/daemon/storage/result.ts`: the closed `QueryResult` union + `isOk`. `readConverged` returns the SAME union — callers branch on `kind`, never a throw.
- Write watermark source is `src/daemon/storage/writes.ts` (the PRD says `controlled-writes.ts` — it's actually `writes.ts`): `appendVersionBumped` ALREADY returns `{ result, version }` (and the caller has the key) — that IS the watermark (id+version). `updateOrInsertByKey` similarly. Expose a small watermark shape so the read predicate is derived from the write, not guessed.
- Poll-convergent precedent to fold into one home: `dreaming/trigger.ts` RESOLVE_POLLS; the hand-rolled loops in `tests/integration/{controlled-writes-live,graph-persist-live,ontology-*-live}.itest.ts` to delete (D-4, AC-4).
- Redaction: `client.ts` `traceSql` (gated by `HONEYCOMB_TRACE_SQL`) redacts org, never a token — reuse it for convergence trace lines (D-5, AC-5).

## Acceptance criteria
| AC | Criterion | Status | Owner |
|----|-----------|--------|-------|
| AC-1 | Deterministic converge unit: `readConverged` vs a FAKE flapping `StorageQuery` (stale/empty/lower-version for N calls then fresh) + fake clock → polls until predicate holds, returns the fresh `ok`. No live backend. | VERIFIED | W1 |
| AC-2 | Bounded fail-soft: a never-converging fake → exhausts the bounded budget, returns the LAST real `QueryResult` (not a throw/hang/invented row), within budget (fake clock). | VERIFIED | W1 |
| AC-3 | No-flake live read-your-writes: gated live itest writes via the controlled-write primitive, reads back THROUGH `readConverged`, ALWAYS sees the write — N≥20 loop, zero misses. | LANDED (W2) — `tests/integration/read-converge-live.itest.ts`: N=25 loop, each iter `appendVersionBumped` (capture `{version}`) → `readConverged` w/ `watermarkPredicate(id,version)`, per-iter hard assert it sees the write + zero-miss aggregate assert; per-read poll-attempt counts recorded/printed as convergence evidence; + bounded fail-soft (never-written ghost id returns within budget, never invents). Throwaway `ci_converge_<runId>`, DROP teardown, token-gated skip-safe (collects+skips w/o creds). NOT run live here (smoker runs w/ creds). | W2 |
| AC-4 | Itests stop hand-rolling: controlled-writes + graph-persist (+ ontology-*) live itests read back through the shared seam/harness; bespoke poll loops REMOVED; `grep` proves no ad-hoc "retry until row appears" loop remains in those files. | LANDED (W2) — migrated `controlled-writes-live` (read-backs → `readConverged`+`watermarkPredicate`/`rowPresent`/`minRowCount`), `graph-persist-live` (`scanDistinct` union-poll → `readConverged`+`minRowCount`), `ontology-{supersede,apply,deps}-live` (`scanRows` SCAN_POLLS union-poll → `readConverged`+`minRowCount`, highest-version-per-id reduction kept as post-processing). All `SCAN_POLLS`/`SCAN_DELAY_MS`/`scanDistinct`/`for(let poll…)` DELETED from the 5 files (grep-proven). Every assertion preserved; only the WAIT mechanism swapped. Throwaway-table isolation + DROP teardown kept. ONE genuine non-read-convergence loop left + noted: deps b-AC-5/D-7 absence-proof (prove NO 2nd row appears — the opposite of poll-until-present). | W2 |
| AC-5 | Gates green + no secret: `npm run ci`/`build`/`audit:sql`/`audit:openclaw`/invariant green; a trace-on run shows convergence lines carry no token, no full org (redaction proof). | VERIFIED | W1/W2/close-out |

## Decisions (from the PRD)
- D-1 poll-converge mechanism + write-emitted watermark as the predicate input (no transport read-after-write token exists).
- D-2 OPT-IN per read (`query` stays default; `readConverged` is the explicit read-your-writes choice).
- D-3 bounded budget (~2s / ~10 attempts, backoff, env `HONEYCOMB_READ_CONVERGE_MS`), fail-SOFT, never invent.
- D-4 ONE home under `src/daemon/storage/`, jscpd-clean; delete the itest copies.
- D-5 no secret in any trace (reuse the client redaction).

## Wave plan
**Wave 1 — the seam (`deeplake-dataset-worker-bee`).** NEW `src/daemon/storage/converge.ts` (or a tight addition to client.ts — single home): `readConverged(client, sql, scope, predicate, opts?)` polls `query` until `predicate(result)` holds OR the bounded budget exhausts → returns the last `QueryResult` (closed union, never throws/invents). Injectable clock/sleep for fast deterministic tests. A `Watermark {id, version}` shape + a `watermarkPredicate(wm, {idColumn, versionColumn})` helper. Env-overridable budget config. Redaction-safe convergence trace. Export from `storage/index.ts`. Unit tests: AC-1 (flapping→converge), AC-2 (never-converge→last-real-within-budget), AC-5 redaction (trace carries no token/full-org). NO itest edits.

**Wave 2 — adopt + prove (`deeplake-dataset-worker-bee`, after W1).** Migrate `controlled-writes-live` + `graph-persist-live` (+ ontology-* where it applies) live itests onto `readConverged` (or a thin harness wrapper), DELETE the hand-rolled poll loops (AC-4, grep-proven). Add/extend the AC-3 no-flake live itest: write→`readConverged` read-back in an N≥20 loop, zero misses, gated + throwaway-isolated. Optionally wire the store→recall call site (`memories/{store,recall}.ts`) to use it (the benefiting path) if low-risk.

**Close-out** — security-stinger → quality-stinger.

## Constraints (in force)
- Live creds `.env.local` (gitignored): `set -a; . ./.env.local; set +a`. NEVER paste the token.
- Explicit `git add <paths>`, NEVER `-A`. Keep `.agents/.codex/.claude/.cursor`/`AGENTS.md`/`.env.local`/`.secrets`/`EXECUTION_LEDGER-prd-026..030.md` (other PRDs') OUT. Verify new files not gitignore-swallowed.
- Daemon running on 127.0.0.1:3850 (dreaming enabled) — leave it. Poll-convergent live read-backs always.

## Status log
- Phase 0 recon complete; branch cut, PRD moved backlog→in-work; stale empty backlog/prd-023 dir removed. Dispatching Wave 1.

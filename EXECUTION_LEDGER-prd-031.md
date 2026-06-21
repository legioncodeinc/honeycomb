# EXECUTION LEDGER — PRD-031 Live-integration test net

> Orchestrator: `/the-smoker` · Branch: `prd-031-live-integration-test-net` · SSOT for AC tracking.
> Goal: close the gap where green UNIT tests pass but the ASSEMBLED engine is broken — boot the real
> assembled daemon in tests (one test per dogfood bug CLASS), split by storage need (router/middleware
> classes run in PLAIN CI with fake storage; real-backend classes stay gated live), and run the live
> suite on a SCHEDULE (not only main-push), skip-safe on forks/no-token. ADDITIVE test+CI coverage only.

## Phase 0 recon facts
- `tests/integration/_daemon-harness.ts` `bootTestDaemon` wraps `assembleDaemon` + `startDaemon` (listen.js) on an EPHEMERAL port (0, never 3850), temp runtime dir; LIVE storage by default (`createStorageClient`). `BootTestDaemonOptions` (line ~46) — check for a storage override; if absent, ADD a fake-storage option (Bee A owns this file).
- `assembleDaemon`/`assembleSeams` (`src/daemon/runtime/assemble.ts`) fire every seam in real order behind the real middleware — the ONLY place collision/header/order classes surface. For PLAIN-CI tests, drive the assembled Hono app via `app.request(...)` with a FAKE `StorageQuery` (no token, no network) — lives OUTSIDE `tests/integration/**` (e.g. `tests/daemon/runtime/`) so `npm run test` (which excludes `tests/integration/**`) picks it up.
- The per-arm missing-sibling-table tolerance is in `src/daemon/runtime/memories/recall.ts` (the regression AC-3 reproduces). The data vs dashboard route groups are `src/daemon/runtime/{memories,dashboard}/api.ts` (the AC-1 collision).
- PRD-028's `readConverged` (`src/daemon/storage/converge.ts`, MERGED) is the no-flake write→read-back seam AC-5 uses (D-4).
- CI: `.github/workflows/ci.yaml` — `on: push/pull_request`; the `gate` job emits `has_token`; `integration` job `if: github.event_name == 'push' && needs.gate.outputs.has_token == 'true'`. `vitest.integration.config.ts` = `tests/integration/**/*.itest.ts`, serial, per-run `HONEYCOMB_CI_RUN_ID` table prefix.

## Acceptance criteria
| AC | Criterion | Status | Owner |
|----|-----------|--------|-------|
| AC-1 | Route collision caught: an assembled-daemon test (assembleDaemon, real seam order) asserts the PRD-022 data routes (e.g. `POST /api/memories/recall`, a `/api/diagnostics/*` data route) are reachable + NOT shadowed by the dashboard host — would FAIL under the 020b/022 collision, passes now. PLAIN CI (fake storage). | VERIFIED | W-A |
| AC-2 | Header gap caught: an assembled-daemon test proves a request MISSING the required `x-honeycomb-*` header is rejected at the real middleware edge (400/401), and WITH the header reaches the handler — real middleware chain, not an isolated mount. PLAIN CI. | VERIFIED | W-A |
| AC-3 | Missing-table heal class: a GATED live itest vs a FRESH partition (only `memories` exists) proves recall surfaces the `memories` hit + does NOT 500 when `memory`/`sessions` siblings are absent (per-arm tolerance) — reproduces the original dogfood regression. | VERIFIED | W-B |
| AC-4 | Scheduled, skip-safe CI: the live `integration` job runs on a `schedule:` trigger (PLUS main-push); a no-token run (fork/secret unset) SKIPS cleanly + the workflow stays green (the `gate`→`has_token` gate preserved verbatim). | VERIFIED | W-C |
| AC-5 | Non-flaky live: the broadened write→read-back classes go through PRD-028's `readConverged` (no bespoke poll loops); a multi-run loop shows no consistency-flap flakes. | VERIFIED | W-B |
| AC-6 | Gates green: `npm run ci` (excludes `.itest.ts`) stays green + unit-count-stable; `build`/`audit:sql`/`audit:openclaw`/smoke green; the new assembled-daemon plain-CI tests run in `npm run test`. | VERIFIED | close-out |

## Decisions (from the PRD)
- D-1 boot the ASSEMBLED daemon (assembleDaemon → bootTestDaemon / app.request), not isolated mounts.
- D-2 split by storage need: router/middleware/asset classes → fake storage → PLAIN CI every PR; real-backend classes (heal, consistency) → gated live.
- D-3 scheduled live run (nightly) + main-push, skip-safe via the existing `gate`→`has_token`.
- D-4 fast + non-flaky leaning on PRD-028's readConverged; serial + per-run table prefix kept.
- D-5 REUSE `bootTestDaemon`, don't fork it.

## Wave plan (3 parallel bees, disjoint file ownership)
**W-A — plain-CI assembled tests (`typescript-node-worker-bee`).** OWNS `tests/integration/_daemon-harness.ts` (add a fake-storage assembled-app variant if not present — a way to get the assembled Hono app + a fake `StorageQuery`, no token/network, for `app.request`). Write `tests/daemon/runtime/assembled-net.test.ts` (PLAIN test, runs in `npm run test`): AC-1 (data routes reachable, not shadowed by dashboard host — would fail under the collision) + AC-2 (missing `x-honeycomb-*` → 400/401 at the middleware edge; with header → reaches handler). Real assembled daemon, fake storage.
**W-B — gated live classes (`deeplake-dataset-worker-bee`).** Write NEW gated itests under `tests/integration/` using the EXISTING live `bootTestDaemon` (do NOT edit `_daemon-harness.ts` — W-A owns it): AC-3 `missing-table-heal-live.itest.ts` (fresh partition / only `memories` → recall surfaces hit, no 500; throwaway/namespaced isolation) + AC-5 (a write→read-back class through `readConverged`, a multi-run loop showing no flap). Skip-safe (token-gated).
**W-C — scheduled CI (`ci-release-worker-bee`).** OWNS `.github/workflows/ci.yaml`: add a `schedule:` (nightly cron) trigger; extend the `integration` job `if:` to run on `schedule` too (keep `push`); PRESERVE the `gate`→`has_token` skip-safe gate verbatim (no token → skipped, never failed). Optional label-gated PR run (`run-live`). Keep the live-step auto-retry from #50.

**Close-out** — security-stinger → quality-stinger.

## Constraints (in force)
- Explicit `git add <paths>`, NEVER `-A`. Keep `.agents/.codex/.claude/.cursor`/`AGENTS.md`/`.env.local`/`.secrets`/other PRDs' EXECUTION_LEDGER OUT. New files not gitignore-swallowed. Live creds in `.env.local` (gitignored) — never paste. Daemon on 3850 — leave it; tests bind EPHEMERAL ports only.

## Status log
- Phase 0 recon complete; branch cut, PRD moved backlog→in-work. Dispatching W-A/W-B/W-C in parallel.

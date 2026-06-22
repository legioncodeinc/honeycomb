# PRD-031 — Live-integration test net (catch what green unit tests miss)

> Status: completed · Owner: `/the-smoker` · Type: M (feature)
> Goal: close the structural gap where green unit tests pass but the assembled engine is broken — by
> booting the REAL assembled daemon in tests and running the live suite on more than just `main`-push.

## Why
The dogfood keeps finding bugs that green unit tests missed THIS session: a route collision (the
PRD-020b dashboard host shadowed the PRD-022 data routes), scope/header gaps (SDK/MCP/dashboard not
stamping the required `x-honeycomb-*` headers), a missing-table fatal-vs-heal bug (a single UNION-ALL
recall failed the WHOLE read when a sibling table did not exist — see the comment in
`src/daemon/runtime/memories/recall.ts`), the daemon identity-from-env-not-creds split (PRD-021), and
missing packaged assets. Unit tests mount handlers in ISOLATION with a fake `StorageQuery` — they
structurally cannot see route collisions (no real router assembly), header gaps (no real middleware
chain), or seam-firing-order bugs (no `assembleDaemon`). The ONE place real engine behavior IS
exercised is the gated live itest suite — and it runs ONLY on `main`-push when
`HONEYCOMB_DEEPLAKE_TOKEN` is set (`.github/workflows/ci.yaml`, the `integration` job:
`if: github.event_name == 'push'`), SKIPPED on every PR and fork. So most real engine behavior is
undertested in CI, and the bugs land on `main`.

## Goal
A test net that (a) boots the ASSEMBLED daemon (`assembleDaemon` — every seam fired in real order
through the real middleware chain) rather than hand-mounted isolated handlers, with one test per bug
CLASS the dogfood found; and (b) runs the live suite on a SCHEDULE (not only `main`-push), staying
SKIP-SAFE on forks / no-token.

## Scope / What
- **Bug-class catalog → a test per class.** Enumerate the classes the dogfood caught and cover each:
  1. route collision (two mounts claim overlapping paths — the dashboard-host vs data-routes shadow);
  2. scope/header gap (a client omits `x-honeycomb-org` / `x-honeycomb-session` → 400 at the edge);
  3. missing-table heal (a fresh partition where a sibling arm's table does not exist degrades that
     arm to empty, not a 500 — the per-arm tolerance in `recall.ts`);
  4. identity/scope split (the daemon's own scope resolves from creds, not a stale env read);
  5. packaging/asset gap (the dashboard bundle + runtime assets actually ship);
  6. eventual-consistency flap (a write→read-back converges — leans on PRD-028's seam).
- **Assembled-daemon test harness.** Lean on the existing `bootTestDaemon()`
  (`tests/integration/_daemon-harness.ts`) which already wraps `assembleDaemon` + `startDaemon` on an
  EPHEMERAL port with a temp runtime dir. Add an ASSEMBLED-daemon variant that can run with a FAKE
  storage client (no token) so the collision/header/order classes are caught in plain CI, and the
  live-storage classes (heal, consistency) run gated.
- **Scheduled + broadened CI.** Add a `schedule:` trigger (and keep `main`-push) so the live suite
  runs regularly; optionally a label-gated PR run. Keep the existing secret-gate (`gate` job →
  `has_token`) so forks / no-token SKIP cleanly, never fail.
- NON-goal: new product features, new endpoints, or changing the engine — this PRD adds TEST coverage
  and CI wiring around the existing assembled daemon.

## Decisions
- **D-1 — Boot the ASSEMBLED daemon, not isolated mounts.** The collision/header/order classes only
  surface when the REAL `assembleSeams` fires every seam in real order behind the real middleware
  (`assembleDaemon` → `bootTestDaemon`). A test that mounts one handler with a fake daemon is exactly
  the blind spot that let the bugs through; this PRD's tests drive `app.request(...)` / HTTP against a
  fully-assembled daemon.
- **D-2 — Split the net by storage need.** Classes that need only the router + middleware (route
  collision, header gaps, seam order, asset presence) run against an assembled daemon with a FAKE
  storage client — so they run in PLAIN CI on every PR, no token. Classes that need real backend
  behavior (missing-table heal on a fresh partition, eventual-consistency flap) stay GATED live itests.
  This gets the highest-frequency dogfood bugs into every-PR CI while keeping the live suite honest.
- **D-3 — Scheduled live run, skip-safe.** Add a `schedule:` (e.g. nightly) trigger to the live job in
  addition to `main`-push, so real engine behavior is exercised regularly, not only at merge. The
  existing secret-gate pattern (`gate` job emitting `has_token`) is preserved verbatim: no token →
  skipped, never failed, on forks and pre-secret repos. A label-gated PR run (`run-live`) is optional.
- **D-4 — Fast + non-flaky, leaning on PRD-028.** The live classes use PRD-028's read-consistency seam
  for every write→read-back instead of a bespoke poll loop, so the broadened suite does not become a
  flaky-CI liability. Serial file execution + the per-run table prefix
  (`HONEYCOMB_CI_RUN_ID`) from the existing `vitest.integration.config.ts` are kept.
- **D-5 — Reuse the harness, don't fork it.** Extend `tests/integration/_daemon-harness.ts`
  (`bootTestDaemon`) rather than copy its assemble+listen+shutdown dance into each new test (the
  jscpd-duplication trap the harness was built to avoid).

## Acceptance criteria
- **AC-1 — Caught the route collision.** An assembled-daemon test boots via `assembleDaemon` and
  asserts the PRD-022 data routes (e.g. `GET /api/diagnostics/kpis`, `POST /api/memories/recall`) are
  reachable and NOT shadowed by the dashboard host — a test that WOULD HAVE FAILED under the
  PRD-020b/PRD-022 collision and passes now.
- **AC-2 — Caught the header gap.** An assembled-daemon test proves a request MISSING the required
  `x-honeycomb-*` header is rejected at the middleware edge (e.g. a session group 400/401 without
  `x-honeycomb-session`), and the same request WITH the header reaches the handler — exercising the
  real middleware chain, not an isolated mount.
- **AC-3 — Missing-table heal class.** A gated live itest against a FRESH partition (only `memories`
  exists) proves recall still surfaces the `memories` hit and does NOT 500 when the `memory`/`sessions`
  sibling tables are absent (the per-arm tolerance), reproducing the original dogfood regression.
- **AC-4 — Scheduled, skip-safe CI job.** A CI job definition runs the live suite on a `schedule:`
  trigger (plus `main`-push), and on a no-token run (fork / secret unset) it SKIPS cleanly and the
  workflow stays green — proven by the preserved `gate` → `has_token` gate.
- **AC-5 — Non-flaky live run.** The broadened live suite's write→read-back classes go through
  PRD-028's consistency seam (no bespoke poll loops); a multi-run loop shows no consistency-flap flakes.
- **AC-6 — Gates green.** `npm run ci` (which excludes `.itest.ts`) stays green and unit-count-stable;
  `build` / `audit:sql` / `audit:openclaw` green; the new assembled-daemon tests run in plain CI.

## Risks / Out of scope
- RISK: a scheduled live job consumes a real DeepLake org + CI minutes — mitigated by the namespaced
  `honeycomb_ci` workspace + per-run table prefix (already in the integration config) and a nightly (not
  per-commit) cadence.
- RISK: broadening the live suite raises flake risk — D-4 + AC-5 (PRD-028 seam) is the mitigation; if
  PRD-028 is not yet landed, the consistency-flap class stays a documented gap rather than a flaky test.
- OUT: new engine features; replacing unit tests (the net is ADDITIVE — unit tests stay for fast
  inner-loop coverage); a full e2e harness beyond the assembled daemon.

## Dependencies
- **LEANS ON PRD-028 (storage read-consistency)**: AC-5's non-flaky write→read-back classes use 028's
  `readConverged` seam instead of hand-rolled poll loops (D-4).
- Reuses the assembled-daemon harness `bootTestDaemon` (`tests/integration/_daemon-harness.ts`) over
  `assembleDaemon` / `assembleSeams` (`src/daemon/runtime/assemble.ts`).
- Reuses the existing CI secret-gate + integration config (`.github/workflows/ci.yaml` `gate` /
  `integration` jobs, `vitest.integration.config.ts`).
- Reproduces real regressions in `src/daemon/runtime/memories/recall.ts` (per-arm tolerance) and the
  data/dashboard route groups (`src/daemon/runtime/{memories,dashboard}/api.ts`).

## Reference
- Assembled daemon + seam order: `src/daemon/runtime/assemble.ts` (`assembleDaemon`, `assembleSeams`).
- Reusable boot harness: `tests/integration/_daemon-harness.ts` (`bootTestDaemon`, ephemeral port,
  temp runtime dir, live-or-fake storage).
- The bug-class evidence: `src/daemon/runtime/memories/recall.ts` (the per-arm / missing-sibling-table
  comment), the data/dashboard route mounts (`src/daemon/runtime/{memories,dashboard}/api.ts`).
- CI to broaden: `.github/workflows/ci.yaml` (`gate` job → `has_token`; `integration` job
  `if: github.event_name == 'push' && needs.gate.outputs.has_token == 'true'`),
  `vitest.integration.config.ts` (`tests/integration/**/*.itest.ts`, serial, per-run prefix).

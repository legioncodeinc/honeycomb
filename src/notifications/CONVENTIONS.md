# Notifications + environment health — CONVENTIONS (PRD-020d)

The fail-soft notifications pipeline + the D1–D5 environment health check + the idempotent
auto-wiring engine live under `src/notifications/`. Wave 1 (this scaffold) ships contracts + seams
+ honest stubs; Wave 2 fills the bodies.

**Read this file before filling a module.**

## The central invariant: thin client — backend notifications come THROUGH THE DAEMON

(FR-3 / D-2, a Wave-3 security target.)

- **Module home = `src/notifications/` ON PURPOSE.** Added to `NON_DAEMON_ROOTS`
  (`tests/daemon/storage/invariant.test.ts`, D-2). A stray `from ".../daemon/storage"` import here
  FAILS the build.
- **The `BackendNotificationSource` seam fetches via the daemon** — never DeepLake. The D2 health
  probe dials the daemon over TCP. Everything else (PATH probes, `hooks.json`, state files) is local
  FS through seams.
- **OK to import:** `src/connectors` (the 019a `HarnessConnector`, for auto-wiring delegation, D-4).
  Both roots are NON_DAEMON; neither opens DeepLake.

## D-5 — the claim lock is REAL POSIX `wx`; state writes are temp-file + atomic rename

- `createClaimLock` (`state.ts`) uses `openSync(claimPath(key), "wx")` exclusive create (via the
  `StateFs.openExclusive` seam): the first racer wins, a second hits `EEXIST` → `claim` returns
  false → exactly ONE banner (FR-4 / d-AC-1). `release` `unlinkSync`s the claim. Claim keys are
  validated against traversal (`safeClaimSegment`) so a key can never escape `claims/`.
- `createNotificationsState.markShown` writes a unique temp file then `renameSync`s it over
  `notifications-state.json` (crash-safe, FR-5). NO partial-write window; a garbled/absent file
  loads as empty (fail-soft).
- The seam is `StateFs` (`state.ts`): the default `nodeStateFs` runs the genuine POSIX calls; a
  unit test injects `createInMemoryStateFs` — which honors the SAME `EEXIST`/atomic-rename
  contract — so the real factories' LOGIC is driven without disk. The in-memory FAKES
  (`createFakeClaimLock`, `createFakeNotificationsState`, in `contracts.ts`) drive the pipeline
  unit tests. All are behind the SAME `ClaimLock`/`NotificationsState` interface.

## Claim-release lifecycle (FR-6 / d-AC-1 vs d-AC-5)

The pipeline NEVER releases a claim mid-drain — that is what keeps racing procs to exactly one
banner (a synchronous in-drain release would let a concurrent racer that already lost back in).
Re-emit of a transient is the SESSION BOUNDARY's job: the claim file is per-session-ephemeral, so
`releaseClaim` (the harness's session-end / next-session step, FR-6) unlinks the claim and a LATER
session re-claims it. Persistent show-once is enforced by `notifications-state.json` (not the
claim), so a persistent never re-shows even after its claim is released.

## Persistent vs transient (FR-5 / FR-6 / d-AC-4 / d-AC-5)

- **Persistent** (welcome, first-time guides, savings recaps): records `id` + `dedupKey` in state →
  `wasShown(dedupKey)` suppresses a re-show (show-once, d-AC-4).
- **Transient** (payment failures, missing deps): records NOTHING in state → re-emits each session
  while the cause persists (d-AC-5), gated ONLY by the claim lock (one banner per session).

## The five health dimensions (FR-7) — consumed by 020a + 020c

`HealthDimensionId` D1..D5 + `HealthDimension` (`contracts.ts`) are the STABLE shape 020a's `status`
and 020c's status bar both render. Do NOT rename them. `HEALTH_DIMENSION_WIRABLE` marks D5 (hooks)
auto-wirable; D1–D4 are prerequisites the check SURFACES but cannot mint.

| Dim | Probe | Wirable |
|-----|-------|---------|
| D1 | `honeycomb` CLI on PATH + `--version` | no |
| D2 | daemon TCP reachable on 3850 + fast-start | no |
| D3 | `cursor-agent` present (PATH + IDE dirs) | no |
| D4 | `cursor-agent` login (status query) | no |
| D5 | `hooks.json` matches the current bundle | **yes** |

## D-4 — auto-wiring REUSES the 019a connector engine

`createAutoWiring` (`auto-wiring.ts`) DELEGATES to a `HarnessConnector`: `wire()` → `install()`
(foreign-preserve + `writeJsonIfChanged` idempotency → fingerprint stable on a no-op, d-AC-6);
`unwire()` → `uninstall()` (reversible). Do NOT fork a second merge engine. `HealthCheck.autoWire()`
resolves the wirable failing dimensions through this engine.

## ~1.5s bounded, fail-soft drain (FR-2 / d-AC-3)

`createNotificationsPipeline` Wave 2: backend + primary-banner fetches run in PARALLEL, each bounded
by `DEFAULT_PIPELINE_TIMEOUT_MS` (~1500ms); ANY fetch failure is SWALLOWED (never blocks the
session). The drain returns the picked primary banner under the priority model.

## Deferred assembly (honest deferral) — Wave 2 status

FILLED this wave (constructed-and-tested behind seams):
- `createNotificationsPipeline` (`pipeline.ts`): the parallel, ~1.5s-bounded, fail-soft drain +
  priority pick (tests: `pipeline.test.ts`).
- `createClaimLock` + `createNotificationsState` (`state.ts`): real POSIX `wx` + temp+atomic-rename
  behind the `StateFs` seam (tests: `state.test.ts`).
- `createHealthCheck` (`health.ts`): D1–D5 `evaluate()` + wirable `autoWire()` (tests:
  `health.test.ts`).
- `createAutoWiring` (`auto-wiring.ts`): delegates to a 019a `HarnessConnector` (tests:
  `auto-wiring.test.ts`).
- `mountNotificationsApi` (`src/daemon/runtime/notifications/api.ts`): registers
  `GET /api/diagnostics/notifications`, reads through `StorageQuery` with `sql.ts` guards.

STILL DEFERRED (constructed-and-tested behind seams; NOT live-wired — matches 001–019 / D-7):
- The real health PROBES (PATH `--version`, TCP dial to 3850, `cursor-agent` PATH/login,
  `hooks.json` bundle-match) — `HealthProbes` is injected; the production probe impls are a
  follow-up. Tests drive every D-x branch through fakes.
- The real `BackendNotificationSource` (the thin-client loopback GET to the daemon) — the daemon
  ENDPOINT exists (`mountNotificationsApi`), but its production wiring into the assembly + the
  client-side source are deferred. The pipeline times out + swallows a still-stubbed endpoint
  (FR-2 / d-AC-3), so a session is never blocked.
- The SessionStart drain wiring (a 019c shim invoking `pipeline.drain("session_start")`) and the
  session-boundary `releaseClaim` step (FR-6) — deferred to the harness shim.
- The `notifications` catalog table the daemon handler reads — the read is guarded + table-name
  injected; the table's schema/seed is a data-layer follow-up.

No contract body changes — Wave 2 is additive only.

## esbuild / bundle note for Wave 2

`src/notifications` is pulled into a bundle TRANSITIVELY when a hook shim / the CLI `status` handler
imports it. No new esbuild entry is needed this wave (nothing imports `src/notifications` yet). When
Wave 2 wires the SessionStart drain into the Cursor shim (`harnesses/cursor/src`) or `status`, those
existing bundle entries pick it up. No esbuild change for this scaffold.

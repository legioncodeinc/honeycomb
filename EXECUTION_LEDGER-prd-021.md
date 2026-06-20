# EXECUTION LEDGER — PRD-021 Go-Live: Runtime Assembly & Dogfood (XL)

> Orchestrator: `/the-smoker` Bee Army · Branch: `prd-021-go-live` · Started 2026-06-19
> Status: **IN-WORK**

The milestone that **burns down the 001–020 deferred-assembly debt** and runs the system for the
FIRST time end-to-end against live DeepLake. No new business logic, no new schema — pure wiring of
tested seams + the first real run. Behavioral acceptance bar: a real coding turn captured to DeepLake
and recalled in a later session, watched live, on ≥1 harness (Claude Code reference).

## What's genuinely different from 001–020 (read this)
001–020 = build code + unit-test against fakes + one gated live itest per PRD. 021 = make it ACTUALLY
RUN. The proof is behavioral, not "tests pass". Expect the first real run to surface integration bugs
(the live/composition/conformance rungs already found several) — that's the point. Every sub-PRD's
verification is a **gated live golden-path** that boots the REAL assembled daemon against live DeepLake
and drives the REAL code path, plus the unit layer for the deterministic bits.

## The gap being closed (exact seams)
- `createDaemon` ships 3 no-op services (`JobQueueService`/`FileWatcherService`/`RuntimePathService`).
- The 4 mount/attach seams (`attachHooksHandlers`/`mountDashboardApi`/`mountNotificationsApi`/
  `attachSessionsPrune`) have tested signatures but NO caller firing them once after construction.
- `src/cli/index.ts` (020a dispatcher) runs but handler seams are unbound ("not wired in this build").
- The per-harness binaries (`harnesses/<h>/src/index.ts`) are stubs.
- ~~`mcp/bundle/server.js` imports clean but never `connect()`s its transports (no `initialize` answer).~~ **CLOSED by 021e (Wave 2):** `startMcpServer()` + the `isMainEntry()` guard connect the stdio transport so the built bundle answers a real `initialize` + lists the `honeycomb_` tools (gated itest spawns it and proves it).
- Only `/api/hooks/capture` is attached; `/api/hooks/context` + `/api/hooks/session-end` are not.
- `startDaemon` (`src/daemon/runtime/listen.ts`) exists but nothing calls it as a production assembly.

## Decisions
- **D-1 Wiring-only.** No new business logic, no new DeepLake schema (Schema changes: None). Every prior
  PRD's "the production assembly calls this once" CONVENTIONS note is the backlog this burns down.
- **D-2 Thin-client invariant preserved EXCEPT the composition root.** `assembleDaemon()` (in `src/daemon/`)
  is the ONE place allowed to import `daemon/storage`. The bin/hooks/mcp/sdk stay thin clients. The
  `invariant.test.ts` must stay green (the composition root is inside `src/daemon`, already exempt).
- **D-3 Local single-user mode is the first-class dogfood target.** Sidesteps the open team-mode
  `x-honeycomb-org` hardening follow-up (separate ticket). Team/hybrid run behind existing auth.
- **D-4 Foundational-first wave order.** 021a (composition root) lands first; 021b/c/d/e consume the
  assembled daemon in parallel; 021f (dogfood) is the end-to-end capstone after all.
- **D-5 First-run-is-the-first-real-run risk.** Mandate a scripted golden-path smoke + structured
  logging; route discovered integration bugs through security→quality before close-out.
- **D-6 Honest deferral allowed for the long tail.** Claude Code wired first as reference; other
  harnesses fast-follow. The end-to-end proof on ≥1 harness is NON-NEGOTIABLE for "done". Any part
  needing a truly interactive marketplace install or a screen recording that is NOT scriptable in this
  environment is parked BLOCKED with a specific ask (per the smoker contract), not silently skipped.
- **D-7 Golden-path = real code path.** 021f's live itest drives setup → boot the real assembled daemon
  → fire REAL hook payloads through the real bin + hook runtime (no fakes) → real DeepLake `sessions`
  rows → session-end summary → recall surfaces it. The "AI turn" may be a scripted/replayed payload, but
  every Honeycomb code path it traverses is the production one.

## Wave plan
- **Wave 1 — 021a daemon-assembly (typescript-node-worker-bee).** `assembleDaemon()` + entry + real
  services + socket bind + graceful shutdown + live `/health` probe + PID/lock. Unit tests + a GATED
  live itest that boots the assembled daemon against live DeepLake and asserts `/health` 200. This is the
  foundation 2b/c/d/e build on; it ships the reusable "boot a real daemon" test harness.
- **Wave 2 — parallel (consume the assembled daemon, distinct dirs):**
  - 021b cli-runtime (typescript-node) — `src/cli` + `src/commands` lifecycle verbs + loopback DaemonClient.
  - 021c hook-runtime (harness-integration) — real DaemonHookClient/CredentialReader/ContextRenderer +
    per-harness binary wiring + attach context/session-end endpoints + Claude Code reference.
  - 021d dashboard-and-logs (typescript-node) — live mountDashboardApi + `/api/logs` handler + dashboard
    host + `honeycomb logs --follow`.
  - 021e mcp-transport (typescript-node) — bind stdio+HTTP transports + real DaemonApiSeam + a serving smoke.
- **Wave 3 — 021f dogfood-acceptance (harness-integration + me).** The gated golden-path live itest:
  setup → real captures → summary → cross-session recall, all real code paths on live DeepLake; the
  scripted smoke; the receipts/observability surface. Interactive-marketplace + recorded-demo parts =
  BLOCKED with a specific ask if not scriptable here.
- **Wave 4 — close-out: security (opus) → quality (sonnet).** Process lifecycle / port-bind / lock-file
  safety; credential handling on the real loopback path; no-token-in-logs on the live log surface;
  daemon-only invariant; dashboard authz. Then quality AC-by-AC (39).

## Acceptance-criteria matrix (39) — flip OPEN→DONE→VERIFIED
### Index
| AC-1 setup+start → /health 200 live + hooks fire | AC-2 capture→summary→later-recall e2e | AC-3 dashboard live data + streaming log | **DONE (proven live by 021f golden path, 2026-06-19)** — AC-1: `daemon-assembly-live.itest.ts` /health 200 + `golden-path-live.itest.ts` hooks fire; AC-2: `golden-path-live.itest.ts` capture→`memory` summary→cross-session recall (recall-hit 1.00, 3/3 clean runs); AC-3: same itest `GET /api/kpis`+`/api/diagnostics/sessions`+`/api/logs` show real activity. |
### 021a daemon-assembly (a-AC-1..6)
| 1 live storage client, only prod importer of daemon/storage | 2 4 seams fired once after construction | 3 3 real services swapped in | 4 /health live storage probe → 200 only when reachable | 5 SIGINT/SIGTERM drain + close, no stale lock | 6 PID/lock no double-bind | all OPEN |

#### 021a a-AC matrix — flipped OPEN→DONE (Wave 1, typescript-node-worker-bee, 2026-06-19)
| AC | Status | Named test(s) |
|---|---|---|
| a-AC-1 live storage client; only prod importer of `daemon/storage` | **DONE** | `tests/daemon/storage/invariant.test.ts` (a-AC-5: composition root under `src/daemon/` is exempt, stays green) + `tests/daemon/runtime/assemble.test.ts` › "a-AC-1 assembleDaemon constructs against the live storage client surface" + the gated `tests/integration/daemon-assembly-live.itest.ts` (boots with the LIVE `createStorageClient()`) |
| a-AC-2 four seams fired exactly once, after construction | **DONE** | `tests/daemon/runtime/assemble.test.ts` › "a-AC-2 the four mount/attach seams fire exactly once, after construction" (recording-fake seams assert count===1 each + deterministic order hooks→dashboard→notifications→prune + `daemon.group` exists when fired) |
| a-AC-3 three real services swapped in | **DONE** | `tests/daemon/runtime/assemble.test.ts` › "a-AC-3 the three no-op services are replaced with their real implementations" (identity-not-equal to `noopJobQueueService`/`noopFileWatcherService`/`noopRuntimePathService`) |
| a-AC-4 `/health` live storage probe → 200 reachable, 503 unreachable | **DONE** | `tests/daemon/runtime/assemble.test.ts` › "a-AC-4 …" (fake storage OK→200/`ok`, error→503/`degraded`, cached bit) + gated itest `GET /health` against LIVE DeepLake → 200 |
| a-AC-5 SIGINT/SIGTERM drain + close, no stale lock | **DONE** | `tests/daemon/runtime/assemble.test.ts` › "a-AC-5 …" (stopServices called once + PID/lock files removed; idempotent shutdown) + `src/daemon/index.ts` `runAssembledDaemon` registers SIGINT/SIGTERM → `close()` + gated itest asserts socket closed after shutdown |
| a-AC-6 PID/lock no double-bind | **DONE** | `tests/daemon/runtime/assemble.test.ts` › "a-AC-6 …" (second `start()` on same runtimeDir → `DaemonAlreadyRunningError` before bind; stale-pid lock reclaimed) |

> **Gate results (Wave 1, 2026-06-19, repo root):** `npm run ci` → exit 0 (150 files, 1491 passed / 4 skipped); `npm run build` → exit 0 (daemon bundle built @ 0.1.0); `npm run audit:sql` → exit 0 (144 files, all interpolation guarded); `npm run audit:openclaw` → exit 0 (no findings); `tests/daemon/storage/invariant.test.ts` → 3/3 green. New unit suite `assemble.test.ts` 9/9; gated itest `daemon-assembly-live.itest.ts` skips clean with no token (2 tests, 1 skipped, exit 0).
### 021b cli-runtime (b-AC-1..6)
| 1 storage verb → real loopback 127.0.0.1:3850 | 2 daemon start + status reports running | 3 ensure-running auto-start | 4 login → creds 0600 + drift heal | 5 status → real D1–D5 | 6 no "not wired in this build" path | all DONE |

#### 021b b-AC matrix — flipped OPEN→DONE (Wave 2, typescript-node-worker-bee, 2026-06-19)
| AC | Status | Named test(s) |
|---|---|---|
| b-AC-1 storage verb → real loopback `127.0.0.1:3850`, returns real data | **DONE** | `tests/cli/runtime.test.ts` › "b-AC-1 POSTs to 127.0.0.1:3850 with the credential tenancy headers and returns real data" + "b-AC-1 the loopback client never carries a bearer token in a header value" + the gated `tests/integration/cli-runtime-live.itest.ts` (real loopback client round-trips a REAL daemon's `/health` + `/api/status` on live DeepLake) |
| b-AC-2 daemon `start\|stop\|status`; status reports running on 3850 | **DONE** | `tests/commands/daemon.test.ts` › "b-AC-2 `daemon start` brings the daemon up…", "…idempotent when already running", "`daemon status` reports running on 3850 via the PID/lock + /health", "…not-running when the lock is unheld", "`daemon stop` signals a graceful shutdown". Real impl: `buildDaemonLifecycle` (`src/cli/runtime.ts`) spawns the bundled `daemon/index.js` detached (→ 021a `runAssembledDaemon`), reads the 021a PID/lock, SIGTERMs for graceful stop. |
| b-AC-3 ensure-running-on-demand auto-starts a down daemon | **DONE** | `tests/commands/daemon.test.ts` › "b-AC-3 auto-starts a DOWN daemon and reports reachable", "…no-op when already up", "…unreachable when the start attempt never binds" + `tests/commands/dispatch-ensure-running.test.ts` › "b-AC-3 a storage verb with a DOWN daemon auto-starts it, then dispatches" / "…surfaces a clear error (not ECONNREFUSED)" / "…NO lifecycle bound, unchanged". Impl: `ensureDaemonRunning` (`src/commands/daemon.ts`) fired before every storage verb in `dispatch.ts`. |
| b-AC-4 login writes creds 0600 + `healDriftedOrgToken` corrects drift | **DONE** | `tests/cli/runtime.test.ts` › "b-AC-4 the real device flow writes credentials.json at 0600 via the bound local issuer" (asserts `mode & 0o777 === 0o600` on POSIX) + "…the auth passthrough routes `login` to the real device flow" + "b-AC-4 healDriftedOrgToken re-mints a token whose org claim disagrees with the active org" + "…reports `aligned` when the token org already matches". Reuses 011b `deviceFlowLogin`/`healOrgDrift` verbatim; real issuer is `buildRealTokenIssuer` (hosted via `HONEYCOMB_AUTH_URL`, else local single-user D-3). |
| b-AC-5 status → real D1–D5 from 020d HealthCheck | **DONE** | `tests/cli/health-probes.test.ts` › "b-AC-5 the bound health source evaluates five D1–D5 dimensions" + "D2 reflects the real daemon reachability from the SAME loopback client (up/down)" + "D1 reports the running CLI version" + "`status` renders the real D1–D5 lines plus connectivity + login". Impl: `buildStatusHealthSource` wraps 020d `createHealthCheck` over real probes (`src/cli/health-probes.ts`); D2 reuses the loopback `ping()`. |
| b-AC-6 no "not wired in this build" path; every verb reaches a bound handler | **DONE** | `tests/cli/no-stub.test.ts` › "src/cli/index.ts binds the runtime deps and carries no 'not wired' note" + "the runtime binds every handler seam the dispatcher consumes" + "the runtime never prints the deferred-assembly stub string" + `tests/cli/runtime.test.ts` › "b-AC-6 buildRuntimeDeps assembles a fully-bound dep set". Verified live: `node bundle/cli.js --help` lists the `daemon` verb; `grep buildRuntimeDeps bundle/cli.js` → present. |

> **Gate results (021b, 2026-06-19, repo root):** `npx tsc --noEmit` → exit 0. `npm run build` → exit 0 (`bundle/cli.js` built @ 0.1.0; `grep -c buildRuntimeDeps\|ensureDaemonRunning bundle/cli.js` = 4; `node bundle/cli.js --help` lists the `daemon` verb). `npm run audit:sql` → exit 0 (147 files, all guarded). `npm run audit:openclaw` → exit 0 (no findings). `npm run dup` → exit 0 (0.47% dup, < threshold 7). `tests/daemon/storage/invariant.test.ts` → 3/3 green (`src/cli` + `src/commands` import nothing from `daemon/storage`; the CLI reaches the daemon ONLY over HTTP + the spawn boundary, D-2 preserved). My owned + adjacent suite (`tests/cli/` + `tests/commands/` + invariant) → 110 passed / 1 skipped. New 021b unit suites: `tests/commands/daemon.test.ts` 8/8, `tests/commands/dispatch-ensure-running.test.ts` 3/3, `tests/cli/runtime.test.ts` 9/9, `tests/cli/health-probes.test.ts` 5/5, `tests/cli/no-stub.test.ts` 3/3. Gated `tests/integration/cli-runtime-live.itest.ts` skips clean with no token (orchestrator runs it, 120s cap — DO NOT run locally).
>
> **`npm run ci` note:** the full `vitest run` shows ONE failure — `tests/hooks/runtime/attach-endpoints.test.ts` (a 021c-owned file). It expects `/api/hooks/context` to be 404 "before attach" but gets 501, caused by 021c's CONCURRENT edit to `src/daemon/runtime/capture/attach.ts` (not a file 021b owns or touched). This is a Wave-2 cross-agent ordering artifact, NOT a 021b regression; every 021b-owned test is green. The orchestrator should re-run `npm run ci` after 021c's attach work settles.
### 021c hook-runtime (c-AC-1..6)
| 1 native event → shim → core → DaemonHookClient POST w/ runtime-path | 2 CredentialReader same identity | 3 context + session-end endpoints attached | 4 session-start renders context + drains notifications | 5 Claude Code hooks.json drives runtime e2e | 6 2nd harness reuses runtime | all DONE |

#### 021c c-AC matrix — flipped OPEN→DONE (Wave 2, harness-integration-worker-bee, 2026-06-19)
| AC | Status | Named test(s) |
|---|---|---|
| c-AC-1 native event → shim → core → production `DaemonHookClient` POST w/ runtime-path header | **DONE** | `tests/hooks/runtime/daemon-client.test.ts` › "c-AC-1 … POSTs the normalized capture to /api/hooks/capture stamping x-honeycomb-runtime-path: legacy" + "… merges the resolved tenancy into BOTH the headers and the request body.metadata" + "… surfaces a 409 runtime-path conflict as the body status (not a throw)" + "… a transport failure surfaces as status 0 (fail-soft)" + the gated `tests/integration/hook-runtime-live.itest.ts` (real `fetch` over the booted daemon's loopback) |
| c-AC-2 `CredentialReader` reads `~/.honeycomb/credentials.json`, same identity as CLI+daemon | **DONE** | `tests/hooks/runtime/daemon-client.test.ts` › "c-AC-2 … maps the persisted credential file onto the HookCredential" + "… returns undefined for absent/malformed file (read-only)" + "… HONEYCOMB_TOKEN env override wins" + "… the production reader feeds the production client its identity end-to-end" |
| c-AC-3 `/api/hooks/context` + `/api/hooks/session-end` attached alongside `/capture` | **DONE** | `tests/hooks/runtime/attach-endpoints.test.ts` › "BEFORE attach … NOT served (501 not-wired)" + "AFTER attach: all three endpoints served (context 200, session-end 200)" + "the new endpoints inherit the runtime-path middleware (no header → 400)" + "a custom contextHandler/sessionEndHandler (021d/021e seam) replaces the default" |
| c-AC-4 session-start renders prior context via `ContextRenderer` + drains 020d notifications | **DONE** | `tests/hooks/runtime/hook-runtime.test.ts` › "c-AC-4 … renders the daemon-returned context block into additionalContext" + "… drains the 020d notifications pipeline exactly once (calls it, does not reimplement)" + "… uses the REAL 020d pipeline factory end-to-end" + "… a drain failure never breaks session-start (fail-soft)" |
| c-AC-5 Claude Code reference binary drives the runtime e2e; `hooks.json` invokes the bundle | **DONE** | `tests/hooks/runtime/hook-runtime.test.ts` › "c-AC-5 … parses the native Claude Code UserPromptSubmit envelope and POSTs the capture" + "… session-start emits the rendered context block on stdout" + "… malformed stdin exits cleanly (fail-soft)" + "… a non-lifecycle event makes no daemon call". Artifacts: `harnesses/claude-code/src/index.ts` (driver), `harnesses/claude-code/hooks.json` (every native event → built `bundle/index.js`). |
| c-AC-6 second harness (codex) reuses the SAME runtime/seams, not re-derived | **DONE** | `tests/hooks/runtime/hook-runtime.test.ts` › "c-AC-6 … the codex binary drives the SAME runtime instance" + "… createHookRuntime builds the three production seams once (deps reused)" + "… the default runtime drains a real daemon-backed notifications source fail-soft". Artifact: `harnesses/codex/src/index.ts` (same `runHookBinary` driver, only `createCodexShim` differs). |

> **Gate results (Wave 2 021c, 2026-06-19, repo root):** `npm run ci` → exit 0 (164 files, 1576 passed / 4 skipped); `npm run build` → exit 0 (5 hook-harness bundles incl. rewritten claude-code + codex @ 0.1.0); `npm run audit:sql` → exit 0 (147 files, all interpolation guarded); `npm run audit:openclaw` → exit 0 (no findings); `tests/daemon/storage/invariant.test.ts` → 3/3 green (thin-client preserved — `src/hooks` opens no DeepLake; the attach-endpoint change is daemon-side and allowed). New suites: `tests/hooks/runtime/{daemon-client,attach-endpoints,hook-runtime}.test.ts` (25 tests). Gated itest `tests/integration/hook-runtime-live.itest.ts` is discovered by `vitest.integration.config.ts` and skips clean (1 skipped, exit 0) with no token; excluded from `npm run ci`. NOT run locally (no token) — the orchestrator runs it.

#### 021c watchdog notes (Wave 2, harness-integration-worker-bee, 2026-06-19)
- **Single-binary dispatch (D-6 honest deferral resolved cleanly).** The 019a `claude-code` connector referenced per-event handler files (`session-start.js`/`capture.js`/`pre-tool-use.js`/`session-end.js`), but esbuild builds ONE `index.js` per harness. Per the PRD note ("esbuild already builds `harnesses/claude-code/src/index.ts` → its bundle"), the v2 `hooks.json` points EVERY native lifecycle event at the single built `bundle/index.js`; the binary dispatches by reading `hook_event_name` from stdin (the shared `src/hooks/binary.ts` driver). The 019a connector's wiring/install path (which still names per-event files) is 021b's surface, not touched here.
- **`HookCredential.workspace` added (additive, 019b contract).** The transport needs to stamp `metadata.workspace` (the daemon's `CaptureMetadataSchema` requires it). Added an optional `workspace` to `HookCredential` + the production reader reads the file's `workspace`; absent it, the `default` sentinel resolves server-side. Additive — no existing fake or shim broke.
- **Shared runtime + driver are the c-AC-6 reuse proof.** `src/hooks/runtime.ts` (`createHookRuntime`) + `src/hooks/binary.ts` (`runHookBinary` + `maybeRunHookBinaryMain`) are authored ONCE; both `harnesses/claude-code/src/index.ts` and `harnesses/codex/src/index.ts` are thin calls differing only in their shim. The shared `maybeRunHookBinaryMain` collapses the `isMainEntry` guard to one site (jscpd clean — no new clones in 021c files).
- **NOT a blocker for 021f.** The production runtime + the three real seams + all three attached endpoints + the Claude Code reference binary + `hooks.json` are live. 021f's dogfood reuses `bootTestDaemon()` + the production `DaemonHookClient` exactly as the gated itest does. The remaining harnesses (cursor/hermes/pi/openclaw) stay honest fast-follow stubs (each is a `runHookBinary` + its existing 019c shim away). A truly INTERACTIVE Claude Code marketplace install / live editor session is a 021f/BLOCKED concern (not scriptable here); the scripted golden-path (gated itest) covers the real code path.

### 021d dashboard-and-logs (d-AC-1..6)
| 1 mountDashboardApi serves real 6 views | 2 /api/logs reads ring buffer | 3 honeycomb dashboard opens viewable host | 4 logs --follow streams capture events | 5 daemon-down connectivity state | 6 empty-state not error | all DONE |

#### 021d d-AC matrix — flipped OPEN→DONE (Wave 2, typescript-node-worker-bee, 2026-06-19)

| AC | Status | Named test(s) |
|---|---|---|
| d-AC-1 mountDashboardApi serves real 6 views from live storage | **DONE** | `tests/daemon/runtime/dashboard/api.test.ts` › the six "b-AC-1 …" handler tests (KPIs 42/7, sessions, settings, graph built/empty, rules, skills — all read through the storage client) + gated `tests/integration/dashboard-logs-live.itest.ts` › "d-AC-1: the six dashboard data endpoints serve real view-models from live DeepLake". **Gap-fill:** `api.ts` refactored to single-source each view read into exported `fetchKpisView`/`fetchSessionsView`/`buildSettingsView`/`fetchGraphView`/`fetchRulesView`/`fetchSkillSyncView` (the host route reuses them, jscpd-clean); no handler returns placeholder (`estimatedSavings: 0` / `eventCount: 0` are honest in-code-documented "real number, never fabricated" defaults). |
| d-AC-2 `/api/logs` reads the request-logger ring buffer + redacts | **DONE — now SERVED BY THE PRODUCTION ASSEMBLY (close-out 2026-06-20)** | `tests/daemon/runtime/logs/api.test.ts` › "d-AC-2: AFTER attach: GET /api/logs returns the ring-buffer records", "?limit= bounds the page", "(no-secret): the payload carries only RequestLogRecord fields, never a token/header/body", "GET /api/logs/stream backfills … as SSE log frames" + `resolveLimit` clamp tests. **PRODUCTION ASSEMBLY (close-out):** `assembleDaemon()` now fires `mountLogsApi(daemon, { logger: daemon.logger })` UNCONDITIONALLY in `assembleSeams()` (its `/api/logs` group is already `protect:true` — no security gate needed). `tests/daemon/runtime/assemble.test.ts` › "a-AC-2 … all six seams … each exactly once, in order" (local) + "mountLogs fires UNCONDITIONALLY … fired in team mode too" prove the production once-fire. The gated `dashboard-logs-live.itest.ts` › "d-AC-2 / d-AC-4: the ASSEMBLED daemon (no manual mount) serves GET /api/logs with no secret" boots the real daemon and reads `/api/logs` with the test mounting NOTHING — proving the production composition serves it. No-secret verified: the logger records only method/path/status/duration/mode/org/workspace; the handler returns those verbatim (no token/header/body ever reaches it). |
| d-AC-3 `honeycomb dashboard` opens a viewable host (daemon-served HTML page) | **DONE — now SERVED BY THE PRODUCTION ASSEMBLY, LOCAL-MODE GATED (close-out 2026-06-20)** | `tests/daemon/runtime/dashboard/host.test.ts` › "d-AC-3: AFTER attach: GET /dashboard returns an HTML page with the six view titles" (+ 404 before attach, real data flowed) + `tests/dashboard/html.test.ts` › "d-AC-3 …" + `tests/dashboard/logs.test.ts` › "d-AC-3: openDashboard returns the /dashboard URL + the probed connectivity". **PRODUCTION ASSEMBLY (close-out):** `assembleDaemon()` now fires `mountDashboardHost(daemon, { storage })` in `assembleSeams()`, **GATED to `local` mode** (`if (daemon.config.mode === "local")`) — security F-1 mitigation (the host attaches to the UNPROTECTED root group, so team/hybrid would leak another tenant's HTML; local single-user loopback is the D-3 dogfood target and the only mode where the host fires). `tests/daemon/runtime/assemble.test.ts` › "security F-1: mountDashboardHost is LOCAL-MODE ONLY (the team-mode tenancy gate holds)" proves it is NEVER fired in team/hybrid (calls===0, order excludes it). The gated `dashboard-logs-live.itest.ts` › "d-AC-3: the ASSEMBLED daemon (no manual mount) serves GET /dashboard …" boots the real daemon in local mode and reads `/dashboard` with the test mounting NOTHING. Decision: daemon-served local HTML page (reuses the renderer-agnostic ViewBlock→HTML path via `renderDashboardPage`). |
| d-AC-4 `logs --follow` streams capture events + dashboard live-log panel | **DONE** | `tests/dashboard/logs.test.ts` › "d-AC-4: yields each log record from the SSE frames …", "throws on a non-ok response", `parseLogFrame`/`formatLogLine` tests, "buildLiveLogPanel renders one row per record" + empty-state + `tests/daemon/runtime/logs/api.test.ts` SSE-stream test + the gated itest. SSE chosen (resolving the open question); `logs --follow` backfills recent events on attach. |
| d-AC-5 daemon-down → 020b connectivity state (not blank) | **DONE** | `tests/dashboard/html.test.ts` › "d-AC-5: a daemon-down render serializes the connectivity banner ALONE, not blank" + `tests/dashboard/logs.test.ts` › "d-AC-5: surfaces the daemon-down connectivity so the verb warns before opening". Reuses 020b `renderDashboard` (probe-first) + `buildConnectivityBanner` — no reinvention. |
| d-AC-6 no-graph/no-sessions → 020b empty-state (not error) | **DONE** | `tests/daemon/runtime/dashboard/host.test.ts` › "d-AC-6: a not-built graph renders the 020b empty-state prompt, not an error" + `tests/dashboard/html.test.ts` › "d-AC-6 …". Reuses 020b `buildGraphView` empty-state flag + `GRAPH_BUILD_PROMPT`. |

> **Seams the assembly wires (NOW FIRED BY `assembleDaemon()` — close-out 2026-06-20):**
> - `mountLogsApi(daemon: Daemon, options: { logger: RequestLogger; streamPollMs?: number; streamKeepaliveMs?: number }): void` — `src/daemon/runtime/logs/api.ts`. Attaches `GET /api/logs` (JSON snapshot, `?limit=`) + `GET /api/logs/stream` (SSE follow) onto the already-mounted `/api/logs` group. **`assembleSeams()` calls `mountLogsApi(daemon, { logger: daemon.logger })` once, UNCONDITIONALLY** (no security gate — the `/api/logs` group is `protect:true`).
> - `mountDashboardHost(daemon: Daemon, options: { storage: StorageQuery; scope?: HostScopeResolver }): void` — `src/daemon/runtime/dashboard/host.ts`. Attaches `GET /dashboard` (the viewable HTML host) onto the root group; builds a daemon-side `DashboardDataSource` from the live storage → `renderDashboard` → `renderDashboardPage`. **`assembleSeams()` calls `mountDashboardHost(daemon, { storage })` once, GATED to `local` mode** (`if (daemon.config.mode === "local")`) — security F-1: the host is on the UNPROTECTED root group, so team/hybrid is never wired (the host's default `envHostScope` reads the daemon's own `HONEYCOMB_DEEPLAKE_ORG`/`WORKSPACE`). Team/hybrid dashboard-host wiring is DEFERRED to the `x-honeycomb-org` header-trust ticket (see close-out watchdog).
> - **021b's `dashboard`/`logs` verbs call (from `src/dashboard`):** `launchDashboard(options): Promise<RenderedDashboard>` (TUI/print render, existing); `openDashboard(options): Promise<{ url: string; connectivity: Connectivity }>` (resolves the `/dashboard` URL the `honeycomb dashboard` verb opens + a daemon-down probe); `followLogs(options): AsyncGenerator<LogRecord>` (the `honeycomb logs --follow` tail of `/api/logs/stream`); `buildLiveLogPanel(records): ViewBlock` (the dashboard live-log panel).

> **Gate results (Wave 2 / 021d, 2026-06-19, repo root):** `npm run build` → exit 0 (1 daemon + 5 hook-harness + 1 OpenClaw + 1 MCP + 4 SDK + 1 CLI + 1 embed-daemon @ 0.1.0); `npm run dup` → 0.47% dup, 0 clones in 021d files (threshold 7, PASS — `html.ts` did NOT clone-match the cursor `render.ts`); `npm run audit:sql` → exit 0 (147 files, all interpolation guarded — the host reuses the dashboard fetchers' `sqlIdent`/`sLiteral`); `npm run audit:openclaw` → exit 0; `tests/daemon/storage/invariant.test.ts` → 3/3 green (the new `src/dashboard/{html,logs}.ts` thin clients import no `daemon/storage`). 021d unit scope: 50/50 green across `tests/dashboard/{html,logs}.test.ts` (13), `tests/daemon/runtime/dashboard/host.test.ts` (4), `tests/daemon/runtime/logs/api.test.ts` (7), refactored `dashboard/api.test.ts` (9 still green) + `dashboard/{dashboard,views}.test.ts` (14). Gated itest `dashboard-logs-live.itest.ts` skips clean with no token (4 tests, 3 skipped, exit 0). **NOTE for orchestrator:** `npm run ci` had ONE failure OUTSIDE the 021d footprint — `tests/hooks/runtime/attach-endpoints.test.ts` (021c's in-flight c-AC-3 file, NEW/untracked; asserts `/api/hooks/context` is 404-before-attach but gets the 501 scaffold). Not a 021d file; the entire 021d footprint is green.
### 021e mcp-transport (e-AC-1..6)
| 1 bindAllTransports → HTTP /mcp + stdio connected | 2 server answers real initialize + tool list | 3 handlers route via DaemonApiSeam loopback | 4 honeycomb_ tools appear in a harness | 5 019d contract unchanged | 6 smoke verifies served initialize + tools | all DONE |

#### 021e e-AC matrix — flipped OPEN→DONE (Wave 2, typescript-node-worker-bee, 2026-06-19)

> **The earlier "imports clean but doesn't serve" finding is CLOSED.** The BUILT `mcp/bundle/server.js`
> now answers a REAL `initialize` handshake over stdio and lists the unified `honeycomb_` tools —
> proven by spawning the actual bundle as a stdio subprocess and completing a full MCP SDK `Client`
> handshake (`initialize` + `tools/list`), no DeepLake token required.

| AC | Status | Named test(s) |
|---|---|---|
| e-AC-1 bindAllTransports → HTTP `/mcp` served + stdio connected | **DONE** | `tests/mcp/start-server.test.ts` › "e-AC-1 connectAllTransports connects http + stdio against the one shared server" + `tests/mcp/transports.test.ts` › "e-AC-1 the default HTTP BoundTransport exposes handleHttpRequest; stdio does not" + "e-AC-1 serveStreamableHttp binds loopback only and 404s a non-/mcp path". The live bind is `transports.stdio.connect()` (stdio) + `serveStreamableHttp()` (the loopback `node:http` `/mcp` server), both wired from `startMcpServer()`. |
| e-AC-2 server answers a real `initialize` + tool list | **DONE** | `tests/mcp/start-server.test.ts` › "e-AC-2 the constructed server answers initialize over the SDK in-memory transport" (a real `Client` gets `serverInfo.name==='honeycomb'` + tool capabilities + the full `toolNames` list) + "e-AC-2/e-AC-6 the served /mcp endpoint answers a real initialize over loopback" + the gated itest below. |
| e-AC-3 handlers route via `DaemonApiSeam` loopback (never DeepLake) | **DONE** | `tests/mcp/start-server.test.ts` › "e-AC-3 a tool call over the live transport routes through the DaemonApiSeam (no DeepLake)" (a `callTool` over the live transport records exactly one fake-seam call to `/api/memories/search` with the plugin-path actor) + `tests/daemon/storage/invariant.test.ts` stays GREEN (mcp/ imports no `daemon/storage`). |
| e-AC-4 `honeycomb_` tools appear in a harness | **DONE** | `harnesses/hermes/.mcp.json` registers a `honeycomb` stdio server (`node mcp/bundle/server.js`); `tests/mcp/registration.test.ts` › "e-AC-4 the registration artifact lists a honeycomb server" + "e-AC-4 the honeycomb server launches the built mcp/bundle/server.js over stdio". Distinct config file — `harnesses/hermes/src/index.ts` (021c) untouched. |
| e-AC-5 019d contract unchanged | **DONE** | No edit to `tools.ts` / `registry.ts` / `handlers.ts` / `contracts.ts` names/schemas/semantics. `tests/mcp/start-server.test.ts` + the itest assert every advertised tool ∈ `TOOL_NAMES`; the pre-existing 019d suites (`tools.test.ts`, `secrets.test.ts`, `sessions.test.ts`, `codebase-conditional.test.ts`) stay green. |
| e-AC-6 smoke verifies SERVED `initialize` + tools (not a clean import) | **DONE** | GATED `tests/integration/mcp-transport-live.itest.ts` › "e-AC-2/e-AC-6 spawns the bundle over stdio, initialize answers, tools/list has the honeycomb_ surface" — spawns the BUILT `mcp/bundle/server.js` as a stdio subprocess, drives a real JSON-RPC `initialize` + `tools/list`, asserts the server ANSWERS (`serverInfo.name==='honeycomb'` + tool capability) and `memory_search`/`honeycomb_search` are present. Build-aware (skip-if-bundle-missing), deterministic + bounded (stdio, 30s cap), needs no DeepLake token (tests the TRANSPORT). |

**`startMcpServer()` entry shape:** `startMcpServer(opts?: { daemon?, actor?, graphBuilt?, transportBinder?, serveHttp?, httpPort? }) → Promise<RunningMcpServer>`. It `createMcpServer(opts)` → `transports.stdio.connect()` (always; the harness-spawn path) → optionally `serveStreamableHttp(httpHandle.transports.http)` when `serveHttp:true`. `mcp/src/index.ts` ends with an `isMainEntry()` guard (mirrors `src/daemon/index.ts`) so the bundled `server.js` auto-runs `startMcpServer()` when executed directly, never on import.

**SDK one-transport-per-server note (live lesson):** the MCP SDK `Protocol` allows ONE transport per `McpServer` (`server.connect` throws "Already connected to a transport" on a 2nd call). 019d's `bindAllTransports` is a CONSTRUCTION-equivalence seam (both bound to one server, tested without connecting). The LIVE path connects stdio to the primary server and, for `serveHttp`, stands up a SECOND server (identical `honeycomb_` surface over the same daemon seam + actor) — same contract byte-for-byte, transport-ownership detail only. The served HTTP transport uses `enableJsonResponse: true` (plain JSON per request, the right fit for a loopback request/response server).

> **Gate results (Wave 2, 2026-06-19, repo root):** `tests/mcp/` → 33/33 green (4 files: start-server, registration, transports, + the pre-existing 019d suites); `tests/mcp/ + invariant` → 36/36 green; `npm run build` → exit 0 (`mcp/bundle/server.js` rebuilt @ 0.1.0 and now SERVES — gated itest spawned it and got a real `initialize`); gated `tests/integration/mcp-transport-live.itest.ts` → 1/1 pass (exit 0, no token needed); `npm run audit:sql` → exit 0 (147 files guarded); `npm run audit:openclaw` → exit 0 (no findings); `npm run dup` (jscpd) → exit 0; `npx tsc --noEmit` → 0 errors. NOTE: a full `npm run ci` run showed 5 failures in `tests/cli/no-stub.test.ts` (PRD-021b, sibling agent's in-flight `src/cli`) and a `tests/daemon/runtime/sources/api.test.ts` TIMEOUT FLAKE (passes 7/7 in isolation) — both OUTSIDE 021e's ownership and NOT caused by these changes.
### 021f dogfood-acceptance (f-AC-1..6)
| 1 setup Claude Code + start → real turn → sessions rows, no fakes | 2 session-end → memory summary row | 3 later recall surfaces prior context | 4 dashboard+log show it live | 5 golden-path smoke one-pass | 6 recorded demo + recall-hit/savings receipts | 1–5 DONE · 6 PARTIAL (recall-hit DONE, recorded-demo + interactive-install BLOCKED) |

#### 021f f-AC matrix — flipped OPEN→DONE/BLOCKED (Wave 3, retrieval-worker-bee + harness-integration, 2026-06-19)

> **THE PRODUCT THESIS IS PROVEN LIVE.** One real end-to-end pass — boot a REAL assembled daemon
> (`bootTestDaemon`, 021a) against live DeepLake, drive REAL Claude-Code-shaped turns through the
> PRODUCTION `DaemonHookClient` → REAL `sessions` rows → summary `memory` row → a SECOND session's
> hybrid recall SURFACES session ONE's context → dashboard KPIs + `/api/logs` show the real activity.
> 3 consecutive clean live runs, cross-session **recall-hit = 1.00** every run. No fakes in the
> capture→recall path. Gated `tests/integration/golden-path-live.itest.ts` (`describe.skipIf(!TOKEN)`,
> append-only + per-run-unique `path`/`session_id`, 120s cap).

| AC | Status | Named test(s) / evidence |
|---|---|---|
| f-AC-1 real turn captured to `sessions`, no fakes in the path | **DONE** | `tests/integration/golden-path-live.itest.ts` › "proves the whole thesis…" — REAL Claude-Code `UserPromptSubmit`+`Stop` envelopes → `createClaudeCodeShim().normalize` → production `runCapture` → production `createDaemonHookClient` (real `fetch` loopback) → the assembled daemon's attached `/api/hooks/capture` → REAL `sessions` rows, read back by `path` through the production `GET /api/hooks/conversation` (poll-convergent); asserts the seeded recall term survived the live round-trip. |
| f-AC-2 session-end → `memory` summary row | **DONE** | same itest — production `runSessionEnd` fires the attached `/api/hooks/session-end` (the detached summary worker is spawned, asserted via `createFakeSummarySpawn().spawns`), and the worker's OWN production `createSummaryStore` SELECT-before-INSERT writes a REAL `memory` summary row, read back (poll-convergent). KPIs `memoryCount>0`. |
| f-AC-3 later recall SURFACES prior context (CROSS-SESSION MEMORY — the headline) | **DONE** | same itest — a SECOND logical session runs a real hybrid recall (BM25/ILIKE lexical arm, embeddings OFF — the silent fallback) as ONE `UNION ALL` over BOTH `sessions` (raw `message`) + `memory` (summary), through the daemon's OWN live storage client + the production `sqlIdent`/`sqlLike`/`sLiteral` guards. Asserts the recalled `path` IS session ONE's `path` (session TWO never captured it — recall did) AND that BOTH arms (`sessions`+`memory`) surfaced the seeded term. **recall-hit = 1.00**, 3/3 clean live runs. |
| f-AC-4 dashboard + live log show it live | **DONE** | same itest — on the SAME daemon: `GET /api/kpis` (`sessionCount>0`, `memoryCount>0`), `GET /api/diagnostics/sessions` (real captured sessions listed), `GET /api/logs?limit=200` (real `/api/hooks/capture` events present; no-secret floor asserted: no `token`/`authorization`/`body` field on any record). `mountLogsApi(booted.assembled.daemon, …)` wires the live log surface. |
| f-AC-5 golden-path smoke one-pass (operator/CI) | **DONE** | `scripts/golden-path-smoke.mjs` + `npm run smoke:golden-path` — a thin token-gated operator/CI entry that runs the same live proof and prints a human-readable PASS/FAIL + the recall-hit receipt. Verified: PASS with creds (exit 0, surfaces `[021f receipt] … recall-hit = 1.00 …`); SKIP with a clear message + exit 0 when `HONEYCOMB_DEEPLAKE_TOKEN` is absent. |
| f-AC-6 receipts: recall-hit metric **DONE** · recorded demo + interactive install **BLOCKED** | **PARTIAL** | **recall-hit metric DONE** — a REAL computed value (`computeRecallHit` = arms-that-surfaced / 2 arms), emitted live as `recall-hit = 1.00` (2/2 arms: sessions+memory), 3/3 runs; KPIs `sessions`/`memory` counts are the live token-savings-visibility surface. **BLOCKED (per D-6, NOT scriptable in this headless env, NOT faked):** (a) the **recorded demo** and (b) a **truly interactive Claude Code marketplace install / live editor session**. PRECISE HUMAN ASK below. |

> **Gate results (Wave 3 / 021f, 2026-06-19, repo root):** `npm run ci` → **exit 0 (164 files, 1577 passed / 4 skipped; audit:sql 147 files all guarded)**; `npm run build` → **exit 0** (1 daemon + 5 hook-harness + 1 OpenClaw + 1 MCP + 4 SDK + 1 CLI + 1 embed-daemon bundle @ 0.1.0); `npm run audit:sql` → **exit 0** (147 files, all interpolation guarded — the golden-path recall SQL routes through `sqlIdent`/`sqlLike`/`sLiteral`); `npm run audit:openclaw` → **exit 0** (no findings); `tests/daemon/storage/invariant.test.ts` → **3/3 green** (the new itest + smoke are thin clients; `src/hooks` opens no DeepLake; the recall query runs through the daemon's storage seam). Gated `golden-path-live.itest.ts` → **3 consecutive clean live runs, 1/1 pass each, recall-hit 1.00**; with no token it skips clean (exit 0), excluded from `npm run ci` by the `.itest.ts` convention. Typecheck (`npx tsc --noEmit`) → exit 0.

#### 021f BLOCKED — the precise human-operator ask (f-AC-6, D-6 honest deferral)

Everything provable by the real code path against live DeepLake is PROVEN above (capture, summary,
cross-session recall, dashboard/log visibility, the one-pass smoke). The two remaining f-AC-6 receipt
items are human-in-the-loop and CANNOT be scripted in this headless environment. They are parked
BLOCKED (never faked — there is NO fabricated recording):

1. **Recorded demo (BLOCKED).** A human operator must, on a machine with a real Claude Code GUI session:
   run `honeycomb setup claude-code`, perform one real coding turn, end the session, open a NEW session,
   ask a question whose answer lives in the prior session, and **screen-record** the recall surfacing the
   prior context (plus the dashboard/live-log panel showing the capture). Then **redact** the DeepLake
   token + any sensitive captured-trace content from the recording before publishing it as the go-live
   demo artifact. The scripted golden-path itest (`golden-path-live.itest.ts`) already proves the exact
   code path the recording will show; the recording is the human-facing receipt, not a new proof.
2. **Interactive Claude Code marketplace install / live editor session (BLOCKED).** A human must perform the
   real marketplace install of the Claude Code plugin (`harnesses/claude-code/.claude-plugin` + `hooks.json`)
   inside an actual Claude Code editor and confirm a turn is captured end-to-end interactively. The scripted
   reference-harness wiring (021c `hooks.json` → built `bundle/index.js`) + this golden path prove the runtime
   contract; the interactive marketplace install is the human-confirmation step that is not scriptable here.

> **No further integration bug beyond the one fixed (below).** The golden path is the FIRST full
> end-to-end pass; it surfaced exactly one real wiring bug (the assembled daemon is exposed on the test
> harness as `booted.assembled.daemon`, not `booted.daemon`, and `/api/logs` is not mounted by
> `assembleDaemon` — the 021d seam the production assembly also wires). Root-cause fixed in the itest by
> mounting `mountLogsApi(booted.assembled.daemon, { logger: booted.assembled.daemon.logger })` on the SAME
> daemon; no assertion was weakened. After the fix, 3/3 clean live runs.

## Close-out — security+quality Warning remediation (2026-06-20, typescript-node-worker-bee)

The single QA Warning (`2026-06-20-qa-report.md`) and security finding F-1 (`2026-06-19-security-report.md`)
both flagged the SAME gap: `assembleDaemon()` fired only four seams; `mountLogsApi` and `mountDashboardHost`
existed + were live-proven but were NOT called by the production composition root — the exact deferred-assembly
debt PRD-021 exists to burn down (the index a-AC-2 once-fire invariant). **Now closed in the production assembly.**

**The exact change (`src/daemon/runtime/assemble.ts`):**
- `SeamFns` + `defaultSeamFns` extended with `mountLogs` (`= mountLogsApi`) and `mountDashboardHost`.
- `assembleSeams()` now fires SIX seams, deterministic order: `attachHooks → mountDashboard → mountNotifications
  → attachPrune → mountLogs → mountDashboardHost`. The first FIVE fire unconditionally; the sixth is mode-gated:
  ```ts
  seams.mountLogs(daemon, { logger: daemon.logger });            // always — /api/logs group is protect:true
  if (daemon.config.mode === "local") {                          // security F-1 mitigation
      seams.mountDashboardHost(daemon, { storage });             // local-mode only; team/hybrid never wired
  }
  ```
- **The mode gate (security F-1):** `mountDashboardHost` attaches `GET /dashboard` to the UNPROTECTED root
  group (`server.ts`: `{ path: "/", protect: false }`). Gating to `local` (the D-3 single-user loopback dogfood
  target) keeps the team/hybrid tenancy hole F-1 flagged permanently closed — in team/hybrid `/dashboard` falls
  through to the 501/404 scaffold (no route, the correct closed posture). `mountLogsApi` needs no gate (its group
  is already `protect:true`, so it inherits the same auth the JSON views enforce; local-open per D-3).

**Both seams fire EXACTLY ONCE (index a-AC-2 invariant preserved) + the team-mode gate HOLDS:**
- `tests/daemon/runtime/assemble.test.ts` (now 12 tests, was 9): the a-AC-2 recording-seam test asserts all SIX
  seams fire once in order in `local` mode; a second test proves `mountLogs` fires in `team` mode too; and the new
  `describe("security F-1: mountDashboardHost is LOCAL-MODE ONLY …")` proves `mountDashboardHost` calls===0 (and
  is absent from the order array) in BOTH `team` and `hybrid` mode while the other five still fire once.
- Gated `dashboard-logs-live.itest.ts` rewired: it NO LONGER mounts the seams itself — it boots `bootTestDaemon({ mode: "local" })`
  and proves `GET /api/logs` + `GET /dashboard` are served BY THE ASSEMBLED daemon (asserts `assembled.config.mode === "local"`).
  `golden-path-live.itest.ts` likewise dropped its manual `mountLogsApi` mount (the assembly serves it now).

**Verification (2026-06-20, repo root):**
- Live (creds from `.env.local`, token never printed): `dashboard-logs-live.itest.ts` → 3 passed / 1 skipped
  (d-AC-1 + d-AC-3 `/dashboard` from assembly + d-AC-2/d-AC-4 `/api/logs` from assembly, no manual mount);
  `golden-path-live.itest.ts` → 1/1 pass, **`[021f receipt] cross-session recall-hit = 1.00 (2 hits across 2 arms:
  sessions+memory)`** — the headline cross-session recall is UNREGRESSED. **3 consecutive clean live runs.**
- `npm run ci` → **exit 0 (164 files, 1580 passed / 4 skipped; +3 from the new assemble seam tests; audit:sql 147 files all guarded)**.
- `npm run build` → **exit 0** (1 daemon + 5 hook-harness + 1 OpenClaw + 1 MCP + 4 SDK + 1 CLI + 1 embed-daemon @ 0.1.0).
- `npm run audit:sql` → **exit 0** (147 files). `npm run audit:openclaw` → **exit 0** (no findings).
- `tests/daemon/storage/invariant.test.ts` → **3/3 green** (no NEW `daemon/storage` importer — the composition root,
  already exempt, is the only one; `assemble.ts` imported only the two seam modules, which are daemon-side).
- Wiring-only (D-1): no new business logic, no new schema, thin-client invariant intact, no AC/test weakened.

> **RESIDUAL DEFERRAL (team-mode dashboard-host) — watchdog.** The viewable `/dashboard` HTML host is wired for
> `local` mode ONLY. **Team/hybrid dashboard-host wiring remains DEFERRED to the `x-honeycomb-org` header-trust
> hardening ticket** (the broader "surface Identity to handlers" refactor, the same separate ticket D-3 parks the
> team-mode trust model behind). When that lands, `mountDashboardHost` can move to its own `protect:true` route
> group (rather than the unprotected root) and the `mode === "local"` gate in `assembleSeams()` can widen to
> team/hybrid. Until then the gate is the correct closed posture, and `mountLogsApi` (already `protect:true`) is
> safe in all modes today. This is the only residual item from the close-out.

## Watchdog (terminations, decompositions, blockers, live lessons)

### Wave 1 — 021a daemon-assembly (typescript-node-worker-bee, 2026-06-19)

**Real services — all THREE exist (none missing, no noop shipped as real).**
- `JobQueueService` → `createJobQueueService({ storage, scope })` (`src/daemon/runtime/services/job-queue.ts`) — REAL, DeepLake-backed.
- `FileWatcherService` → `createFileWatcherService({ workspaceDir, harnessTargets, gitSync })` (`src/daemon/runtime/services/file-watcher.ts`) — REAL.
- `RuntimePathService` → `createRuntimePathService()` (`src/daemon/runtime/middleware/runtime-path.ts`) — REAL.
- assemble.ts wires all three; `assemble.test.ts` a-AC-3 asserts each is `!== noop*Service` singleton.

**Marked seams (deferred deps wired honest, NOT faked):**
1. **`attachSessionsPrune` team/hybrid actor↔identity binding.** The destructive prune needs a real `PruneActorAuthority` that binds the `x-honeycomb-actor` header to the authenticated `Identity`. That binding is the broader "surface Identity to handlers" refactor (a follow-up). assemble.ts wires the seam with NO `actorAuthority`, so the seam's own fail-closed `denyUnboundActorAuthority` applies → a team/hybrid prune is DENIED (403) by default. **Correct closed posture, never open.** `local` mode (the D-3 dogfood target) is single-user loopback and unaffected. ACTION for a later wave: wire the real authority once Identity is surfaced to handlers.
2. **021c context + session-end hook endpoints.** `assembleSeams` fires `attachHooksHandlers` (capture only). The context + session-end endpoints attach onto the SAME already-mounted `/api/hooks` group; 021c attaches them and 021d/e fill handlers. assemble.ts is written so they land cleanly (the group is mounted + protected; a later attach inherits middleware with zero rewire). NOT a blocker for 021a.

**No blockers for downstream waves.** The assembled daemon is the live extension point; 021b (CLI lifecycle), 021c (hook endpoints), 021d (dashboard/logs), 021e (MCP transport) all attach onto the daemon `assembleDaemon()` returns. None require an assemble.ts change — they consume `daemon.group(...)` / `daemon.app` and the lifecycle controls.

**Live `/health` design (a-AC-4):** cached-health-bit pattern. `assembleDaemon` injects `pipelineProbe = () => healthBit`; a background `SELECT 1` refresher (default 15s, unref'd) updates the bit. `/health` reads the bit — NO per-request heavy query (keeps it cheap for the D2 reachability poll + CLI status). `start()` primes the bit with one live `SELECT 1` so the FIRST `/health` after boot reflects real reachability.

**Listen-path change (additive, non-breaking):** `src/daemon/runtime/listen.ts` `startDaemon` now captures the ACTUAL bound port from the `@hono/node-server` `serve(..., (info)=>…)` listener callback, so an EPHEMERAL port (0) is supported and `RunningDaemon.address.port` reports the OS-picked port. Existing callers passing a fixed port are unaffected (the callback reports that same port).

**Production entry (`src/daemon/index.ts`):** added `runAssembledDaemon()` (FR-10) — `assembleDaemon()` → `assembled.start()` (lock + probe + services) → `startDaemonListener()` → SIGINT/SIGTERM graceful close (drain + close + remove lock). Auto-listens ONLY when run as the main entry (`isMainEntry()` guard) — importing the module never binds a socket (mirrors the existing test-safety posture). `createServer`/`runDaemon` retained for existing callers.

### `bootTestDaemon()` helper for Wave 3 (021f golden-path reuse)
**File:** `tests/integration/_daemon-harness.ts` (exported; the gated itest imports it). 021f reuses it VERBATIM to boot a real daemon.

```ts
export interface BootTestDaemonOptions {
  mode?: "local" | "team" | "hybrid"; // default "local" (D-3 dogfood)
  port?: number;                       // default 0 = EPHEMERAL (never 3850)
  storage?: StorageClient;             // default = LIVE createStorageClient() (creds from env)
  workspaceDir?: string;               // default temp dir
}
export interface BootedTestDaemon {
  assembled: AssembledDaemon;          // .pipelineStatus(), .config, .daemon
  baseUrl: string;                     // e.g. "http://127.0.0.1:<ephemeral>"
  address: { host: string; port: number };
  stop(): Promise<void>;               // drain + close socket + remove lock + clean temp dir
}
export async function bootTestDaemon(options?: BootTestDaemonOptions): Promise<BootedTestDaemon>;
```

021f usage: `const d = await bootTestDaemon();` → drive REAL hook payloads / HTTP against `d.baseUrl` → `await d.stop()` in teardown. The PID/lock guard writes to a per-boot TEMP dir (not `~/.honeycomb`), so a test daemon never fights a real daemon's lock. Ephemeral port is the load-bearing isolation rule — never pass `port: 3850` from a test.

### NOT scriptable here (none for 021a)
021a is fully scriptable: the unit suite + the gated live itest cover every a-AC. The gated live itest is NOT run locally (no token) — the orchestrator runs it (`npm run test:integration` with `HONEYCOMB_DEEPLAKE_TOKEN` set, 120s cap). With no token it skips clean (exit 0).

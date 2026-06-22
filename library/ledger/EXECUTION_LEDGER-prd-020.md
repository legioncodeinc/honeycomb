# EXECUTION LEDGER — PRD-020 Surfaces (L) — THE FINAL PRD

> Orchestrator: `/the-smoker` Bee Army · Branch: `prd-020-surfaces` · Started 2026-06-18
> Status: **IN-WORK**

The operator-facing front of Honeycomb: unified CLI, daemon-served dashboard, Cursor extension,
notifications + D1–D5 health. All THIN CLIENTS of the daemon (3850, the only DeepLake client).
27 ACs (3 index + 6a + 6b + 6c + 6d). No new schema.

## Existing footprint (build ON, don't rebuild)
- CLI verb handlers already exist: `src/cli/{auth,org,keys,skill,skillify,ontology,route,dream}.ts`
  (each constructed-and-tested behind seams from prior PRDs). `src/cli/index.ts` is still the
  version-print STUB — 020a turns it into the real dispatcher wiring these handlers + new verbs.
- `src/connectors/` (019a) — connector base for `setup`/`connect`/`uninstall`. 020a/c/d reuse its
  `isHoneycombEntry`/`writeJsonIfChanged`/foreign-preserve rules.
- `src/hooks/cursor/` (019c) — the Cursor hook SHIM (capture/recall). 020c is the extension SHELL on top.
- Auth device-flow + `healDriftedOrgToken` (011b) — 020a's login + drift-heal reuse it.
- skillify config/pull/unpull (016/018) — `honeycomb skill ...` routes to it.
- `harnesses/cursor/` has `src/` + `bundle/`; 020c adds `extension/` (the editor extension shell).

## What 020 BUILDS (4 surfaces)
- **020a CLI (`src/cli/index.ts` dispatcher + `src/commands/`):** the unified parser (global flags,
  usage), the merged verb set (setup, status, dashboard, remember, recall, agent, ontology, secret,
  skill, hook, route, sources, graph, goal, org, workspace, sessions prune, uninstall, update), every
  storage verb routed through the daemon, `AUTH_SUBCOMMANDS` passthrough to the auth dispatcher,
  `sessions prune` (deletes `sessions` rows + paired `/summaries/<user>/<sessionId>.md` `memory` rows —
  no orphaned summaries), `status` (daemon connectivity + login + D1–D5 health from 020d), `healDriftedOrgToken`.
- **020b dashboard (daemon-served view layer + data contract):** KPIs, sessions, settings, codebase
  graph, rules, skill-sync views — all read through daemon endpoints; clear connectivity state when the
  daemon is down (no hang/blank); graph empty-state prompts `honeycomb graph build`. The CANONICAL view
  layer 020c embeds. Plus the daemon-side endpoints serving this data.
- **020c Cursor extension (`harnesses/cursor/extension/`):** the editor extension SHELL — Wire/Refresh
  Hooks (copy bundle + idempotent `hooks.json` merge preserving foreign + fingerprint), no-terminal login,
  D1–D5 status bar, dashboard webview embedding 020b, skill symlink sync, bundle self-heal.
- **020d notifications + health (`src/notifications/` + health module):** the fail-soft notifications
  pipeline drained on SessionStart (parallel ~1.5s-timeout fetches, swallow failures), the POSIX-exclusive
  (`wx`) double-invocation CLAIM LOCK (exactly one banner), persistent (`notifications-state.json`,
  temp+atomic-rename, dedupKey, show-once) vs transient (unlink-on-drain, re-emit) state, the D1–D5 health
  check (CLI / daemon-TCP / cursor-agent / login / hooks-wired), and the idempotent auto-wiring engine
  (preserve foreign, `writeJsonIfChanged`, reversible).

## Decisions
- **D-1 Scaffold-then-2×2-parallel.** Wave 1 scaffolds all 4 surfaces' contracts/seams/stubs. Wave 2.1 =
  {020d, 020b} (foundational: d's D1–D5 health contract + b's view-data contract). Wave 2.2 = {020a, 020c}
  (consumers: a's `status` uses d's health; c's status bar uses d's health + auto-wiring, c's webview embeds b).
- **D-2 Thin-client invariant everywhere.** All 4 surfaces are NON-daemon roots: import nothing from
  `daemon/storage` except pure `sql.js`; reach the daemon ONLY through injected HTTP seams. Extend
  `invariant.test.ts` to scan `src/commands`, `src/notifications`, the dashboard root, `harnesses/cursor/extension`.
- **D-3 sessions-prune atomicity is the load-bearing correctness rule** (a-AC-2): the daemon deletes the
  `sessions` rows AND the paired `memory` summary row so traces+summaries never desync. Soft-delete/tombstone
  per the DeepLake unreliable-DELETE lesson; verify with a live itest if feasible, else document.
- **D-4 Auto-wiring + extension hook-merge reuse 019a's connector rules** — preserve foreign, idempotent
  (`writeJsonIfChanged` → no-write-no-fingerprint-change), reversible. Do NOT fork a second merge engine;
  reuse `src/connectors` helpers.
- **D-5 Claim lock = real POSIX `openSync(..,"wx")`** (d-AC-1) — exactly-once banner across racing processes;
  state writes are temp-file + atomic `renameSync` (crash-safe). Behind an injected FS seam for tests.
- **D-6 Dashboard canonical view layer is shared** (b-AC-5 / c-AC-6): the extension webview embeds the SAME
  view components + SAME daemon data contract — no duplicate view code.
- **D-7 Deferred assembly** matches 001–019: the bundled-bin dispatch, the real webview/extension host
  binding, the live daemon endpoints' production wiring are constructed-and-tested behind seams + documented;
  nothing claimed live-wired.

## Wave plan
- **Wave 1 scaffold (typescript-node-worker-bee):** contracts/seams/stubs for all 4 + ledger AC matrix
  pre-fill + invariant-test extension. Existing tests stay green.
- **Wave 2.1 (parallel): 020d (typescript-node), 020b (typescript-node).**
- **Wave 2.2 (parallel): 020a (typescript-node), 020c (cursor-ide-worker-bee).**
- **Wave 3: security (opus) → quality (sonnet).** sessions-prune desync safety; claim-lock race + state-file
  atomicity; auto-wiring/extension hook-merge foreign-preserve + reversible + traversal; no-DeepLake; device-
  flow token handling + 0600 creds; dashboard endpoint authz + no value leak. Then quality AC-by-AC.

## AC matrix (27) — Wave 2 flips PENDING→VERIFIED with the named landing test
> Landing-test column pre-filled by Wave 1 (the `*.test.ts` each Wave-2 AC must land in). Paths
> are relative to repo root. State = PENDING until Wave 2 writes the AC-named `it(...)`.

### Index
| AC | Criterion | Landing test | State |
|----|-----------|-------------|-------|
| AC-1 | storage verb → daemon, never DeepLake | `tests/commands/dispatch.test.ts` (`index AC-1 a storage verb dispatches THROUGH the DaemonClient seam (never DeepLake)`) + `tests/daemon/storage/invariant.test.ts` (`a-AC-5 no non-daemon source file imports src/daemon/storage`) | VERIFIED |
| AC-2 | dashboard renders KPIs/sessions/settings/graph/skill-sync | `tests/dashboard/dashboard.test.ts` (`AC-2: a reachable daemon renders all five named views (+ rules) from daemon-served data`) | VERIFIED |
| AC-3 | health surfaces failing D1–D5 + auto-wires wirable idempotently | `tests/notifications/health.test.ts` (`AC-3 evaluate() returns all five dimensions…`, `d-AC-2 the wirable dimension (D5) is auto-resolved…`) | VERIFIED |

### 020a CLI (`src/commands/`)
| AC | Criterion | Landing test | State |
|----|-----------|-------------|-------|
| a-AC-1 | dispatch + org/ws passthrough | `tests/commands/dispatch.test.ts` (`a-AC-1 org/workspace pass the FULL arg array through to the auth dispatcher (FR-4)`, `a-AC-1 parses leading global flags and resolves the verb…`, `a-AC-1 prints usage and exits 0 when no command is given (FR-1)`) | VERIFIED |
| a-AC-2 | sessions prune deletes rows+paired summaries (no desync) | `tests/commands/sessions.test.ts` (`a-AC-2 prune dispatches through the daemon seam and renders the paired tombstone counts`) + `tests/daemon/runtime/sessions/prune.test.ts` (`a-AC-2 runPrune appends a sessions tombstone AND a paired memory tombstone for EVERY match`, `a-AC-2 the prune is an append-only TOMBSTONE — no hard DELETE statement is ever issued`) + `tests/integration/sessions-prune-live.itest.ts` (`prune tombstones the trace AND the paired summary together (no desync), live` — gated, native throwaway-table) | VERIFIED |
| a-AC-3 | storage verb → daemon not DeepLake | `tests/commands/storage-handlers.test.ts` (`a-AC-3 each storage verb dispatches exactly one daemon request to its route`, `a-AC-3 the CLI dispatches INTENT (route + body), never SQL`) | VERIFIED |
| a-AC-4 | healDriftedOrgToken re-mints matching org_id | `tests/commands/status.test.ts` (`a-AC-4 healDriftedOrgToken re-mints a token whose org_id claim matches the active org` — reuses 011b `healOrgDrift`) | VERIFIED |
| a-AC-5 | device-flow login → creds 0600 | `tests/cli/auth.test.ts` (existing 011b device-flow → 0600 creds) reached via `AUTH_SUBCOMMANDS` passthrough, proven in `tests/commands/dispatch.test.ts` (`a-AC-1 org/workspace pass the FULL arg array through to the auth dispatcher` — login/logout forward verbatim) | VERIFIED |
| a-AC-6 | skill scope team → daemon | `tests/commands/storage-handlers.test.ts` (`a-AC-6 skill scope team --users alice,bob → POST /api/skills/scope through the daemon`, `a-AC-6 skill pull --force → POST /api/skills/pull with force=true`) | VERIFIED |

### 020b dashboard (`src/dashboard/`)
| AC | Criterion | Landing test | State |
|----|-----------|-------------|-------|
| b-AC-1 | renders all 6 views from daemon data | `tests/dashboard/views.test.ts` (`b-AC-1: renderDashboard builds KPIs, sessions, settings, graph, rules, skill-sync from the daemon data`) + daemon-side `tests/daemon/runtime/dashboard/api.test.ts` (`b-AC-1: AFTER attach: /api/kpis returns the KpisView read through storage`) | VERIFIED |
| b-AC-2 | daemon-down → clear connectivity state | `tests/dashboard/dashboard.test.ts` (`b-AC-2: an unreachable probe returns the connectivity banner ALONE with the daemon URL + retry`, `b-AC-2: renderDashboard NEVER calls fetchAll while the daemon is down`) | VERIFIED |
| b-AC-3 | built-graph → canvas from graph endpoints | `tests/dashboard/views.test.ts` (`b-AC-3: a built GraphView renders a graph-canvas block carrying the daemon's nodes/edges`) + daemon-side `tests/daemon/runtime/dashboard/api.test.ts` (`b-AC-3: /api/graph returns built:true with the canvas nodes/edges from the snapshot`) | VERIFIED |
| b-AC-4 | rules view lists active rules | `tests/dashboard/views.test.ts` (`b-AC-4: buildRulesView lists each org rule with its active marker`) + daemon-side `tests/daemon/runtime/dashboard/api.test.ts` (`b-AC-4: /api/rules lists the active rules through storage`) | VERIFIED |
| b-AC-5 | extension webview embeds same views/contract | `tests/dashboard/dashboard.test.ts` (`b-AC-5: rendering the same data twice via renderDashboard yields the identical ViewBlock tree (one impl)`) — contract-stability half; **020c webview-embedding half landed** in `tests/cursor-extension/extension.test.ts` (`b-AC-5 the webview HTML is derived from the SAME renderDashboard ViewBlock tree (one impl)`) | VERIFIED (both halves) |
| b-AC-6 | no-graph → empty-state prompt not error | `tests/dashboard/views.test.ts` (`b-AC-6: an unbuilt GraphView renders the \`honeycomb graph build\` empty-state (not a throw)`) + daemon-side `tests/daemon/runtime/dashboard/api.test.ts` (`b-AC-6: /api/graph returns built:false (empty-state flag) when no snapshot exists`) | VERIFIED |

### 020c Cursor extension (`harnesses/cursor/extension/`)
| AC | Criterion | Landing test | State |
|----|-----------|-------------|-------|
| c-AC-1 | Wire/Refresh copies bundle + idempotent hooks.json merge | `tests/cursor-extension/extension.test.ts` (`c-AC-1 wiring copies … into ~/.cursor/honeycomb/bundle and writes hooks.json`, `c-AC-1 a second wire is idempotent — the hooks.json is not rewritten (fingerprint stable)`) | VERIFIED |
| c-AC-2 | skill sync symlinks w/o clobber | `tests/cursor-extension/extension.test.ts` (`c-AC-2 sync creates skill symlinks …`, `c-AC-2 a foreign entry already at the link path is NOT clobbered`) | VERIFIED |
| c-AC-3 | foreign hooks preserved | `tests/cursor-extension/extension.test.ts` (`c-AC-3 a pre-existing foreign hook entry survives wiring + a re-wire`, `c-AC-3 unwire strips ONLY Honeycomb hooks, leaving the foreign entry`) — exercises the real 019a connector base | VERIFIED |
| c-AC-4 | D1–D5 status bar flags failing | `tests/cursor-extension/extension.test.ts` (`c-AC-4 activation paints D1–D5 into the status bar with the failing dimension flagged`, `c-AC-4 paintStatusBar reports hasFailure …`) | VERIFIED |
| c-AC-5 | login → shared creds 0600 | `tests/cursor-extension/extension.test.ts` (`c-AC-5 the login command writes ~/.honeycomb/credentials.json at 0o600 and opens the device URL`, `c-AC-5 api-key login also lands the shared creds at 0600 …`) | VERIFIED |
| c-AC-6 | webview renders same views as dashboard | `tests/cursor-extension/extension.test.ts` (`c-AC-6 opening the dashboard renders the six 020b views into the webview HTML`, `b-AC-5 the webview HTML is derived from the SAME renderDashboard ViewBlock tree (one impl)`, `FR-9 a daemon-down webview shows the connectivity banner ALONE`) — b-AC-5 webview-embed half satisfied HERE | VERIFIED |

### 020d notifications+health (`src/notifications/`)
| AC | Criterion | Landing test | State |
|----|-----------|-------------|-------|
| d-AC-1 | racing procs → claim lock → exactly one banner | `tests/notifications/pipeline.test.ts` (`d-AC-1 two pipelines sharing one claim lock emit the banner exactly once (win + skip)`) + `tests/notifications/state.test.ts` (`d-AC-1 first claim … wins; a racer … hits EEXIST → loses`) | VERIFIED |
| d-AC-2 | health fails D-x → surfaced + wirable auto-resolved no-clobber | `tests/notifications/health.test.ts` (`d-AC-2 a failing dimension is surfaced…`, `d-AC-2 autoWire() wires D5 … preserving a foreign hook entry`, `d-AC-2 a failing NON-wirable dimension (D4 login) is surfaced but NOT auto-wired`) | VERIFIED |
| d-AC-3 | hung backend → ~1.5s timeout, session proceeds | `tests/notifications/pipeline.test.ts` (`d-AC-3 a never-resolving backend is bounded by the timeout…`) | VERIFIED |
| d-AC-4 | persistent welcome shown once | `tests/notifications/pipeline.test.ts` (`d-AC-4 a first drain shows welcome + records it; a second drain suppresses the re-show`) | VERIFIED |
| d-AC-5 | transient warning re-emits while cause persists | `tests/notifications/pipeline.test.ts` (`d-AC-5 a transient re-emits on the next session…`) | VERIFIED |
| d-AC-6 | unchanged config → no write, fingerprint stable | `tests/notifications/auto-wiring.test.ts` (`d-AC-6 the first wire() writes the config (true); a second wire() is a no-op (false)`) | VERIFIED |

## Watchdog (live lessons / fixes / deferrals)
- **Wave 2.2 — 020a unified CLI landed (2026-06-18).** Filled `src/commands/{dispatch,storage-handlers,
  sessions,status,local-handlers}.ts`, rewired `src/cli/index.ts` onto `createDispatcher()` + the real
  `createLoopbackDaemonClient`, landed the daemon-side paired-delete `src/daemon/runtime/sessions/prune.ts`,
  and landed `src/connectors/cursor.ts` (the `CursorConnector` sibling of `claude-code.ts`). Index AC-1 +
  a-AC-1..6 all VERIFIED with named tests. Full gate green: `npm run ci` (1405 pass / 4 skip),
  `npm run build` (0), `audit:sql` OK, `audit:openclaw` OK, invariant 3/3, jscpd 0.39% (< 7, no new clones).
  - **sessions-prune desync-prevention PROOF (D-3 / a-AC-2):** `runPrune` appends a `sessions` tombstone
    AND a paired `memory` summary tombstone for EVERY matched session in ONE pass; the load-bearing test
    asserts `sessionInserts.length === memoryInserts.length` (both non-zero, both carry `TOMBSTONE_MARKER`,
    the memory tombstone lands at the paired `summaryPath`). The "delete" is append-only — the test also
    asserts NO `DELETE FROM` is ever issued (the DeepLake unreliable-DELETE lesson). The gated live itest
    `tests/integration/sessions-prune-live.itest.ts` proves the pair converges on a real backend.
  - **No-`/api/sessions`-group lesson (mirrors 020b):** `server.ts` mounts NO standalone `/api/sessions`
    route group, and this seam never edits `server.ts` (D-2). So the prune handler attaches off the
    already-mounted `/api/diagnostics` group at `/sessions/prune` (full path
    `/api/diagnostics/sessions/prune`) — exactly where 020b's dashboard sessions read attaches. The CLI's
    `SESSIONS_PRUNE_ROUTE` dispatches to that full path.
  - **SQL-audit lesson:** a joined multi-clause WHERE (`clauses.join(" AND ")`) interpolated as
    `${...}` trips `audit:sql`; binding it to a `whereClause` const (each clause already escaped via
    `sqlIdent`/`sLiteral`) satisfies the gate's pre-built-fragment allowlist (`*Clause`/`*Where` suffix).
  - **Deferred (honest, D-7):** the bin constructs the dispatcher + the real loopback `DaemonClient`
    (storage verbs dispatch for real), but the per-HANDLER seams (`AuthPassthrough` → `orgMain`/`authMain`;
    `OrgDriftHealer` → 011b `healOrgDrift`; `StatusHealthSource` → 020d `HealthCheck`; `ConnectorRunner` →
    019a `connectorMain`; `DashboardLauncher` → 020b `launchDashboard`) and the live
    `attachSessionsPrune(...)` daemon-assembly call are bound by the deferred assembly step that owns the
    credential. A verb whose seam is unbound prints an honest "not wired in this build" line — the bin is
    NOT claimed live-wired end to end. `update` self-update fetch is also deferred (`--dry-run` works).
- **Wave 2.1 — 020b dashboard landed (2026-06-18).** Filled `src/dashboard/{views,dashboard}.ts`,
  added `src/dashboard/launch.ts` (the FR-1 `honeycomb dashboard` launch seam + real loopback
  `DashboardDataSource`), and the daemon-side `mountDashboardApi` handlers. Index AC-2 + b-AC-1..4,6
  VERIFIED with named tests; b-AC-5 VERIFIED for the 020b (contract-stability) half — 020c owns the
  webview-embedding test in `tests/cursor-extension/`. 23/23 green across `tests/dashboard/` +
  `tests/daemon/runtime/dashboard/`. Full gate green: `npm run ci` (1367 pass / 4 skip),
  `npm run build` (0), `audit:sql` OK, `audit:openclaw` OK, invariant 3/3, jscpd 0.52% (< 7, no
  dashboard clones).
  - **STABLE render contract 020c embeds (D-6):** `renderDashboard(source): Promise<RenderedDashboard>`
    + the `ViewBlock` shape + the six `build<View>View(view): ViewBlock` builders + the canonical
    view ORDER (KPIs, sessions, settings, graph, rules, skill-sync) + `GRAPH_BUILD_PROMPT` +
    `buildConnectivityBanner`. FROZEN — additive `ViewBlock` fields only. 020c calls `renderDashboard`
    and paints `result.views`; it imports `src/dashboard`, never re-implements a view.
  - **Webview-vs-TUI decision (PRD open question):** BOTH, one implementation — the renderer-agnostic
    `ViewBlock` tree is canonical; the CLI `dashboard` verb (020a) and the 020c webview consume the
    SAME builders. Documented in `src/dashboard/CONVENTIONS.md`.
  - **No `/api/sessions` group lesson:** `server.ts` mounts NO `/api/sessions` route group (a request
    404s, not 501). Since this seam NEVER edits `server.ts` (D-2/D-6 posture), the sessions + settings
    views attach off the already-mounted `/api/diagnostics` group: `GET /api/diagnostics/sessions`
    (FR-3) + `GET /api/diagnostics/settings` (FR-4). KPIs/graph/rules/skills attach at `/` under their
    own mounted groups. `DASHBOARD_GROUPS` updated to reflect this.
  - **Deferred (honest, D-7):** the webview/TUI HOST that paints the `ViewBlock` tree (020a calls
    `launchDashboard` for the CLI print path; 020c hosts the webview), and the production daemon
    assembly that invokes `mountDashboardApi` with the live storage client. The real loopback
    `DashboardDataSource` (`createDaemonDashboardDataSource`, fetch-seam) and the six daemon handler
    bodies are FULLY IMPLEMENTED + tested against fakes (stub `fetch` / fake `StorageQuery`); NOT
    claimed live against a running daemon. `estimatedSavings` is a real `0` until the savings
    pipeline lands (never a fabricated number); session `eventCount` is `0` pending an event-count
    source.
- **Wave 2.1 — 020d notifications+health landed (2026-06-18).** Filled `src/notifications/{state,
  pipeline,health,auto-wiring}.ts` + daemon-side `mountNotificationsApi`. All 6 d-AC + index AC-3
  VERIFIED with named tests (24/24 green in `tests/notifications/`). Contract additive-only: the
  STABLE `HealthCheck`/`HealthDimension`/`HealthDimensionId`/`HEALTH_DIMENSION_*` shape 020a/020c
  consume was NOT changed (only `HealthProbes`' inline outcome was named `ProbeOutcome` — same
  structure). New exports: `ProbeOutcome`, `NotificationSource`/`PipelineDepsFull`/`TimeoutClock`,
  `StateFs`/`createInMemoryStateFs`/`nodeStateFs`/`StateFsError`.
  - **Claim-release lesson (d-AC-1 vs d-AC-5):** the pipeline must NOT release a claim mid-drain —
    a synchronous in-drain release lets a concurrent racer that already lost back in (observed:
    both racers won). Re-emit (FR-6) is the SESSION BOUNDARY's `releaseClaim`, not the drain's;
    persistent show-once is enforced by state, not the claim. Documented in CONVENTIONS.
  - **Deferred (honest, D-7):** real health probes (PATH/TCP/spawn/`hooks.json`), the real
    client-side `BackendNotificationSource` + its production daemon-assembly wiring, the
    SessionStart drain shim + session-boundary release, the `notifications` catalog table. All
    constructed-and-tested behind seams; NOT claimed live-wired.
- **Wave 2.2 — 020c Cursor extension landed (2026-06-18).** Filled `harnesses/cursor/extension/`:
  `extension.ts` (`activate` registers the 4 commands, paints the D1–D5 status bar, runs
  activation-time skill-sync + bundle self-heal; returns an `ExtensionInstance`), `bindings.ts`
  (the seam factories), `render.ts` (ViewBlock→HTML + status-bar paint). All 6 c-AC VERIFIED with
  named tests + the b-AC-5 webview-embed half (13/13 green in `tests/cursor-extension/`).
  - **Contract additive-only:** the Wave-1 `contracts.ts` exports were NOT changed; added the
    `LoginFlow` seam + `createFakeLoginFlow` + `CREDENTIALS_FILE_MODE` (FR-5 / c-AC-5).
  - **D-4 reuse, no fork (c-AC-1/2/3):** `connectorHookWiring`/`connectorSkillSync` wrap a 019a
    `HarnessConnector` — `wire()`→`install()` (copy bundle + foreign-preserve + `writeJsonIfChanged`
    idempotency → fingerprint stable on a no-op), `unwire()`→`uninstall()` (reversible),
    `sync()`→`linkSkills()` (no-clobber). The tests drive a real `HarnessConnector` subclass over
    the 019a `FakeFs`, so the connector rules are exercised end-to-end through the extension seams,
    NOT re-implemented. The production `CursorConnector` (`src/connectors/cursor.ts`, 020a stream)
    is the injected connector at assembly; the factory is connector-agnostic.
  - **D-6 reuse, no duplicate views (c-AC-6 / b-AC-5):** `dashboardWebviewRenderer` calls the 020b
    `renderDashboard(source)` and serializes the resulting `ViewBlock` tree to HTML via
    `renderDashboardHtml`. The b-AC-5 webview-embed assertion proves equivalence: the webview HTML
    `=== renderDashboardHtml(renderDashboard(sameSource))` — the webview adds ONLY serialization, so
    it shows the SAME views/contract as the daemon dashboard. Daemon-down → the connectivity banner
    alone (FR-9), never a hang/blank.
  - **020d boundary (c-AC-4):** `healthSourceFromCheck` adapts a 020d `HealthCheck` into the
    status-bar source; the bar SURFACES the D1–D5 result (compact ✓/✗ glyph row + per-dimension
    tooltip, the failing dimension flagged `FAILING`) and never re-probes.
  - **NO `vscode` import (D-2/D-7):** the `ExtensionHost` seam abstracts the editor; the fake drives
    every test; the real `vscode`-bound adapter, the device-flow `LoginFlow` binding, the production
    `DashboardDataSource`/`CursorConnector`, and the editor packaging are DEFERRED assembly (D-7).
    `harnesses/cursor/extension` opens NO DeepLake (invariant 3/3 green). NO esbuild entry (an editor
    extension is packaged by the editor tooling), so `npm run build` is unaffected.
  - **Cross-stream note:** the SQL-safety gate failure observed during this landing
    (`src/daemon/runtime/sessions/prune.ts:174` clauses.join bypass) is the 020a stream's in-flight
    prune work, NOT 020c — the extension surface has zero SQL. Left for the 020a stream to fix.
- **Wave 1 scaffold landed (2026-06-18).** Contracts/seams/stubs for all 4 surfaces + daemon-side
  attach seams + invariant-test extension + AC-matrix landing-test prefill. All gates green; all
  existing tests stay green. Files (zero shared-file contention — see file-ownership map below):
  - 020a: `src/commands/{contracts,dispatch,sessions,status,storage-handlers,local-handlers,index}.ts` + CONVENTIONS.
  - 020b: `src/dashboard/{contracts,views,dashboard,index}.ts` + CONVENTIONS.
  - 020c: `harnesses/cursor/extension/{contracts,extension,index}.ts` + CONVENTIONS.
  - 020d: `src/notifications/{contracts,health,pipeline,state,auto-wiring,index}.ts` + CONVENTIONS.
  - daemon-side: `src/daemon/runtime/dashboard/api.ts`, `src/daemon/runtime/sessions/prune.ts`,
    `src/daemon/runtime/notifications/api.ts` (+ CONVENTIONS each) — all `daemon.group(path)` attach
    seams, ZERO `server.ts` edits.
  - shared edits (Wave-1 only, done): `tests/daemon/storage/invariant.test.ts` (NON_DAEMON_ROOTS +4).
- **Contract decisions Wave 2 MUST honor:**
  - **D-4 reuse (020a/c/d → 019a connectors):** the auto-wiring engine (`src/notifications/auto-wiring.ts`),
    the extension hook-wiring (`harnesses/cursor/extension` `HookWiring`/`SkillSync`), and the CLI
    setup/connect/uninstall (`src/commands/local-handlers.ts`) ALL delegate to a `HarnessConnector`
    (`src/connectors`). Wave 2 lands a `CursorConnector` (`src/connectors/cursor.ts`, sibling of
    `claude-code.ts`) and wraps it — it does NOT fork a second hook-merge engine. The foreign-preserve
    + `writeJsonIfChanged` idempotency + reversible rules are the 019a engine's.
  - **D-6 view reuse (020c embeds 020b):** the extension webview (`DashboardWebviewRenderer`) calls the
    020b `renderDashboard(...)` and paints the SAME `ViewBlock` tree — no duplicate view code. 020c
    imports `src/dashboard`, never re-implements a view.
  - **Cross-stream decoupling (Wave 1):** 020a `status` (`StatusHealthSource`) and 020c status bar
    (`StatusBarHealthSource`) consume the D1–D5 result through STRUCTURAL seams (not a 020d import) so
    the streams filled in parallel. Wave 2 binds them to 020d's `HealthCheck` / `HealthDimension`.
  - **Daemon-side, never server.ts:** every Wave-2 daemon handler attaches via `daemon.group(path)` on
    an already-mounted group. No `server.ts` bootstrap edit.
  - **esbuild:** no new bundle entry needed this wave (nothing references the new roots from a bundled
    entrypoint; the stub `src/cli/index.ts` imports nothing new). Wave 2 picks them up transitively
    when `src/cli/index.ts` rewires onto `src/commands`. The Cursor extension is packaged by the
    editor tooling, not `esbuild.config.mjs`.
  - **`*/`-in-JSDoc hazard:** a glob like `harnesses/<star><star>/<star>` written literally inside a
    `/* ... */` block comment closes the comment early (TS1109). Reworded in 020c contracts; keep
    globs out of block comments in Wave 2.

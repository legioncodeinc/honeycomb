# Daemon-served dashboard — CONVENTIONS (PRD-020b)

The dashboard view-data layer lives under `src/dashboard/`. It renders KPIs, sessions, settings,
the codebase graph, rules, and skill-sync state — all read through the daemon. Wave 2 (this fill)
implements the view-builders, the `renderDashboard` orchestrator, the `honeycomb dashboard` launch
surface, and the daemon-side data endpoints.

**Read this file before touching a view.**

## Renderer-agnostic ViewBlock tree — the webview-vs-TUI decision (D-6)

The view layer is **renderer-agnostic**: every builder returns a pure `ViewBlock` tree (a `kind` +
`title`/`rows`/`children`/`data`), NOT HTML and NOT terminal text. The decision (resolving the PRD
open question "webview, TUI, or both?") is **both, one implementation**: the canonical layer is the
`ViewBlock` tree, and each host (the CLI `dashboard` verb printing a TUI, and the 020c Cursor
webview painting HTML) consumes the SAME builders. This is what makes "no duplicate view code"
(FR-9 / b-AC-5 / D-6) structurally true and lets tests assert the render STRUCTURE without a DOM.

## The STABLE render contract 020c embeds (D-6)

020c's `DashboardWebviewRenderer` calls `renderDashboard(source)` and paints `result.views`. The
FROZEN surface:
- `ViewBlock` (the render-block shape; `kind` values are the contract).
- `build<View>View(view): ViewBlock` — the six pure builders.
- `renderDashboard(source: DashboardDataSource): Promise<RenderedDashboard>` and `RenderedDashboard`.
- The canonical view ORDER when reachable: KPIs, sessions, settings, graph, rules, skill-sync.
- `GRAPH_BUILD_PROMPT` (the b-AC-6 empty-state copy) and `buildConnectivityBanner` (the b-AC-2 banner).

Adding optional `ViewBlock` fields is additive-safe; renaming a `kind`, dropping a field, or
changing a builder/`renderDashboard` signature is a BREAKING change for 020c.

## The central invariant: thin client — every view reads through the daemon

(FR-7 / a-AC-1 / D-2.)

- **Module home = `src/dashboard/` ON PURPOSE.** Added to `NON_DAEMON_ROOTS`
  (`tests/daemon/storage/invariant.test.ts`, D-2). A stray `from ".../daemon/storage"` import here
  FAILS the build.
- **The `DashboardDataSource` seam is the ONLY data path.** `probe()` → connectivity; `fetchAll()`
  → the full `DashboardData`. The real impl fetches each view from the daemon's dashboard endpoints;
  the fake (`createFakeDashboardDataSource`) replays canned data. The dashboard holds NO storage
  logic and never opens DeepLake.

## D-6 — the CANONICAL view layer the Cursor webview embeds

The view-models (`DashboardData`) + the view-builders (`views.ts`) are the SINGLE implementation
020c's extension webview embeds (a-AC-5 / c-AC-6). Both surfaces read the SAME data contract and
render the SAME `ViewBlock` tree. Do NOT fork a second set of views in `harnesses/cursor/extension`.
The builders are PURE (view-model → `ViewBlock`) and framework-agnostic, so the host (webview HTML /
TUI) paints the same tree.

## The six views (FR-2..FR-6)

| View | Model | Builder | Notable AC |
|------|-------|---------|-----------|
| KPIs | `KpisView` | `buildKpisView` | a-AC-1 |
| Sessions | `SessionsView` | `buildSessionsView` | a-AC-1 |
| Settings | `SettingsView` | `buildSettingsView` | a-AC-1 |
| Graph | `GraphView` | `buildGraphView` | a-AC-3 / **a-AC-6 empty-state** |
| Rules | `RulesView` | `buildRulesView` | a-AC-4 |
| Skill-sync | `SkillSyncView` | `buildSkillSyncView` | a-AC-1 |

**a-AC-6 (graph empty-state):** `GraphView.built === false` → `buildGraphView` renders the prompt to
run `honeycomb graph build`, NOT an error. The flag, not an exception, drives the empty state.

## Connectivity (FR-8 / a-AC-2)

`renderDashboard` probes FIRST. Unreachable → return the `unreachable(url)` banner (with `retry`)
ONLY — never hang, never blank panels. The probe REUSES the same daemon-reachability check the 020d
D1/D2 dimensions use, so the message is consistent across surfaces.

## The daemon-side endpoints (scaffolded in `src/daemon/`)

The data `DashboardDataSource` fetches is served by `mountDashboardApi` (daemon-side, storage-correct,
scaffolded under `src/daemon/runtime/` this wave — Wave 2 fills the handlers). The dashboard attaches
nothing to `server.ts`; it consumes the endpoints. The daemon already mounts the relevant route
groups (`/api/diagnostics`, `/api/kpis`, `/api/sessions`, `/api/graph`, `/api/rules`, `/api/skills`),
so the Wave-2 attach is `daemon.group(path)` with zero `server.ts` edits.

## The `honeycomb dashboard` launch surface (FR-1)

`launchDashboard(options)` (`launch.ts`) is the seam the 020a CLI `dashboard` verb calls: it builds
the real daemon-served `DashboardDataSource` (`createDaemonDashboardDataSource` — a loopback HTTP
reader pointed at the daemon, **port 3850 by default** via `daemonBaseUrl`) and runs
`renderDashboard`, returning the renderer-agnostic `RenderedDashboard`. The `fetch` transport is an
injected seam (`FetchLike`) so tests drive it with a stub fetch. Pass `options.source` to inject a
fake data source directly. `probe()` GETs `/health` (the same reachability signal the D1/D2 health
dims use); `fetchAll()` GETs the six view endpoints and a per-view fetch failure falls back to the
empty-but-valid shape so one absent view never blanks the dashboard.

## Deferred assembly (honest deferral — D-7)

Constructed-and-tested behind seams; NOT live-wired into a running daemon/webview this wave.
Deferred: the real webview/TUI HOST that paints the `ViewBlock` tree (the CLI print path is 020a's
to call `launchDashboard`; the webview host is 020c's), and the **production daemon assembly** that
invokes `mountDashboardApi` with the live storage client. The real loopback `DashboardDataSource`
and the daemon handler bodies are FULLY IMPLEMENTED and tested against fakes (a stub `fetch` / a fake
`StorageQuery`), but nothing here binds a socket or spawns a UI — importing these modules has no side
effects. Do NOT claim the dashboard is live against a running daemon.

## esbuild / bundle note for Wave 2

`src/dashboard` is pulled into a bundle TRANSITIVELY when the CLI `dashboard` handler (020a) or the
Cursor extension (020c) imports it. No new esbuild entry is needed this wave (nothing imports it
yet). The webview asset bundling (if the dashboard ships HTML/JS to the webview) is a Wave-2 esbuild
concern — note it then; this scaffold adds no bundle entry.

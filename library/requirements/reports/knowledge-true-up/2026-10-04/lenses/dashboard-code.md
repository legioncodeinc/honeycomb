# Lens: dashboard-code

Date: 2026-10-04. Repository: `/home/marioaldayuz/Desktop/development/active/honeycomb`. Read-only. No install, no build, no live port probe.

HEAD is `756bacb205ff84e57a28877dec5422372d3afeeb` on `legion/kb-sotu-and-prd-lifecycle` (`docs: align the knowledge base with the daemon and file shipped PRDs`). The four knowledge files compared below are clean at that commit. `node_modules` is absent, so typecheck, vitest, and esbuild were not run.

## Answer

`src/dashboard/web/main.tsx` is not in this tree. There is no `src/dashboard/web/` directory, no `main.tsx` anywhere, no `hive/` tree, and no `daemon/dashboard-app.js`.

The operator UI that exists here is a renderer-agnostic `ViewBlock` tree under `src/dashboard/`, two HTML serializers (a full page in `html.ts`, a webview fragment in `harnesses/cursor/extension/render.ts`), and design-only HTML under `assets/templates/honeycomb-dashboard/` and `assets/ui_kits/dashboard/`. Neither asset tree is imported by `src/`.

Honeycomb's daemon serves the dashboard data plane (`mountDashboardApi` and sibling mounts under `src/daemon/runtime/dashboard/`). It does not serve a browser shell. `src/daemon/runtime/dashboard/host.ts` is absent. `ROUTE_GROUPS` in `src/daemon/runtime/server.ts` has no `/dashboard` path.

The Hive portal is a URL and a pair of constants (`HIVE_HOST` / `HIVE_PORT` = `127.0.0.1:3853`). Its SPA source is not in this repository. Whether that process serves the React app the docs describe is UNVERIFIABLE-HERE.

`honeycomb dashboard` does not open a browser. Solo `honeycomb install` opens `http://127.0.0.1:3853/`.

## Where UI code lives

| Place | Present | What it is |
|---|---|---|
| `src/dashboard/` | yes: `contracts.ts`, `views.ts`, `dashboard.ts`, `html.ts`, `launch.ts`, `logs.ts`, `index.ts`, `CONVENTIONS.md` | View models, six pure builders, `renderDashboard`, standalone HTML serializer, loopback data reader, live-log client. No React, no JSX. |
| `src/dashboard/web/main.tsx` | no | Glob of `**/main.tsx` is empty. `src/dashboard/web/` has zero files. |
| `src/daemon/runtime/dashboard/` | yes, 24 TS modules plus `CONVENTIONS.md` | Data API, harness/sync/setup/ROI handlers. Not a page renderer. `host.ts` is absent. `CONVENTIONS.md` says the host moved to hive. |
| `assets/templates/honeycomb-dashboard/` | `HoneycombDashboard.dc.html`, `ds-base.js`, `support.js` | Design-template HTML. No `src/` import. |
| `assets/ui_kits/dashboard/` | `index.html`, `components.jsx`, `data.js`, `README.md` | Interactive kit with canned data. No `src/` import. README still says the daemon serves `GET /dashboard`. |
| Hive portal source | no directory named `hive` | Only constants, install URL, fleet probe, and comments. |
| `harnesses/cursor/extension/` | `index.ts`, `extension.ts`, `bindings.ts`, `render.ts`, `contracts.ts`, `CONVENTIONS.md` | Seam shell. No `package.json`, no `hooks.json`, no `vscode` import. |
| `harnesses/cursor/src/index.ts` | yes | Single hook binary entry. |
| `src/hooks/cursor/` | `shim.ts` only | Not the five source files named in the extension knowledge doc. |

`renderDashboard` view order when the daemon answers (`src/dashboard/dashboard.ts` lines 73-80): KPIs, sessions, settings, graph, rules, skill-sync. Settings nests a lifecycle-flags child. That is six blocks, not the seven hash routes in the architecture doc.

Tests on disk: `tests/dashboard/{dashboard,html,logs,views}.test.ts` and `tests/cursor-extension/extension.test.ts`. `tests/dashboard/web/` is absent. Pass/fail was not run.

## Cursor extension and hooks

`harnesses/cursor/` has no `package.json`. The extension directory is the six files above.

Command ids in `harnesses/cursor/extension/contracts.ts` (`EXTENSION_COMMANDS`):

| Id | Title in the knowledge doc | Wired in `activate` |
|---|---|---|
| `honeycomb.wireHooks` | Wire / Refresh Hooks | yes, calls `deps.hooks.wire()` |
| `honeycomb.login` | Login | yes, calls `deps.login.login(...)` |
| `honeycomb.openDashboard` | Open Dashboard | yes, `renderHtml()` into a webview panel |
| `honeycomb.syncSkills` | Sync Skills | yes, calls `deps.skills.sync()` |

`activate(host, deps)` never imports `vscode`. `extension.ts` and `CONVENTIONS.md` both say the real editor host is a deferred assembly step. `esbuild.config.mjs` builds the hook binary (`dist/harnesses/cursor/src/index.js` to `harnesses/cursor/bundle/`) and copies aliases `session-start.js`, `capture.js`, `pre-tool-use.js`, `session-end.js`. It has no extension bundle and no `dashboard-app` entry. `scripts/pack-check.mjs` lines 72-76 say the SPA bundle is no longer a publish target.

Hook source that exists: `src/hooks/cursor/shim.ts` `CURSOR_EVENT_MAP` maps `sessionStart`, `beforeSubmitPrompt`, `postToolUse`, `afterAgentResponse`, `stop`, `sessionEnd`. Shell intercept is inside `postToolUse` when `tool_name` is `Shell` (`cursorExtractData`). There is no `beforeShellExecution` key in that map.

The connector (`src/connectors/cursor.ts` lines 63-79) registers `pre-tool-use` as native `beforeShellExecution` and points handlers at the four alias filenames. Those filenames are copies of one binary, not separate `src/hooks/cursor/*.ts` modules.

## Doc comparison

Sources: `library/knowledge/private/frontend/dashboard-architecture.md`, `dashboard-performance.md`, `cursor-extension-architecture.md`, and `library/knowledge/private/dashboard/adding-a-page.md`.

| Claim | Grade | Note |
|---|---|---|
| This checkout has no `src/dashboard/web/` (`app.tsx`, `router.tsx`, `registry.tsx`, `sidebar.tsx`, `pages/`). | HOLDS | `dashboard-architecture.md` lines 42-44 and `adding-a-page.md` lines 11-12. Zero files under that path. |
| esbuild builds `src/dashboard/web/main.tsx` to `daemon/dashboard-app.js`, and Hive serves that bundle. | FALSE for this repo's build. UNVERIFIABLE-HERE for Hive. | `esbuild.config.mjs` has no such entry. Output file absent. Architecture lines 130-144 still show the snippet as the current build. |
| `honeycomb install` and `honeycomb dashboard` both open `http://127.0.0.1:3853/`. | PARTIAL | Solo install does (`src/commands/install.ts` `loopbackDashboardUrl`, `openSoloDashboard`). Fleet install opens nothing (install.ts around line 559). The `dashboard` verb calls `launchDashboard` and prints reachability only (`src/commands/local-handlers.ts` lines 232-244, `src/cli/runtime.ts` lines 724-730). `openDashboard` in `launch.ts` has no caller in `src/`. |
| Honeycomb ships no CORS and no `GET /dashboard`. | HOLDS | `server.ts` lines 286-291. No `/dashboard` in `ROUTE_GROUPS`. `mountDashboardApi` is called from `assemble.ts` line 1407. |
| Browser cost controls live in `src/dashboard/web/page-frame.tsx` and `app.tsx` (`usePoll`, `isTabHidden`, `healthReasons`, `showSecondary`). | FALSE in this tree | Those symbols are absent from `src/`. Performance doc does not carry the "not in this checkout" caveat. |
| Daemon diagnostics caches: 10s counts, 60s savings, max 64 keys, `createTtlViewCache`. | HOLDS | `src/daemon/runtime/dashboard/api.ts` `DIAG_TTL_MS`, `SAVINGS_TTL_MS`, `CACHE_MAX_KEYS`, `createTtlViewCache`, `fetchKpisView` / `fetchEstimatedSavings`. |
| Cursor hooks are separate sources `session-start.ts`, `capture.ts`, `session-end.ts`, `pre-tool-use.ts`, `wiki-worker.ts` under `src/hooks/cursor/`. | FALSE | Only `shim.ts`. One binary, four filename aliases. |
| Extension `package.json` is a VS Code manifest (`engines.vscode`, `main`, `activationEvents`, `contributes`). | FALSE | No `package.json` under `harnesses/cursor/`. `CONVENTIONS.md` still calls packaging deferred. |
| Extension webview embeds the React SPA and reads `127.0.0.1:3850` via `launch.ts` lines 51-56. | MIXED | Webview serializes the `ViewBlock` tree (`render.ts`). `daemonBaseUrl` at those lines is the 3850 data-plane URL. The extension does not call it. `dashboardWebviewRenderer` takes an injected `DashboardDataSource`. |
| Adding a page is one `ROUTES` entry, proved by `tests/dashboard/web/registry.test.tsx`. | HISTORICAL | The how-to says the files are absent, then prints the recipe. The test file is absent. |

## Findings

### dashboard-code-1. `src/dashboard/web/main.tsx` is absent. The in-repo UI is a ViewBlock tree plus unused design HTML

- Status: VERIFIED
- Severity: high
- Category: inventory
- Claim: The React entry named by older PRDs and by the architecture build snippet is not in this checkout. `src/dashboard/` is seven TypeScript modules and a conventions note. Builders return `ViewBlock` trees. `html.ts` `renderDashboardPage` and `harnesses/cursor/extension/render.ts` `renderDashboardHtml` serialize that tree. `assets/templates/honeycomb-dashboard/` and `assets/ui_kits/dashboard/` are the only HTML dashboards on disk, and `src/` does not import them. There is no `hive/` directory.
- Evidence: `test -f src/dashboard/web/main.tsx` fails. `ls src/dashboard`. `rg` for `from "react"` under `src/dashboard` has no matches. `rg` for `HoneycombDashboard` and `ui_kits/dashboard` under `src/` has no matches. `test -d hive` fails.
- Impact: A reader who follows the esbuild snippet or a completed PRD path will edit files that are not here. The pages an operator can actually render from this repo are the six `ViewBlock` panels, not hash routes `/harnesses` through `/settings`.
- Recommended action: Keep the lines 42-44 disclaimer. Delete or fence the esbuild snippet and the `src/dashboard/web/...` path citations so they are clearly the Hive repo's layout, with a pointer, not this repo's build.
- Owner: either. Confidence: 0.97.

### dashboard-code-2. `honeycomb dashboard` does not open the Hive portal. Solo install does

- Status: VERIFIED
- Severity: high
- Category: behavior vs doc
- Claim: `dashboard-architecture.md` lines 24 and 38 say `honeycomb install` and `honeycomb dashboard` open `http://127.0.0.1:3853/`. Solo install does, via `loopbackDashboardUrl()` (`src/commands/install.ts` lines 64-74 and 344-356). The dashboard verb does not. `runDashboardCommand` calls `deps.dashboard.launch()`, which runs `launchDashboard` and returns only `{ reachable }`. The rendered views are discarded. stdout is `dashboard: launched (daemon reachable).` or a not-reachable line. Exit code is 0 in both cases. `openDashboard` (`src/dashboard/launch.ts` lines 173-178) would return the portal URL plus a 3850 probe, and nothing under `src/` calls it. `portalBaseUrl` reuses `LaunchDashboardOptions.port`, documented as the daemon port, so a caller that passed `3850` would build a portal URL on the daemon port. That function is unused.
- Evidence: `src/commands/dispatch.ts` case `dashboard` calls `runDashboardCommand`. `src/cli/runtime.ts` lines 724-730. `rg openDashboard\\(` under `src/` hits only the definition. `HIVE_PORT = 3853` and `HIVE_HOST = "127.0.0.1"` in `src/shared/constants.ts` lines 20-23. `DASHBOARD_HOST_PATH = "/"` in `launch.ts` line 150. The `OpenDashboardResult` comment still gives the example `http://127.0.0.1:3850/dashboard`.
- Impact: The documented operator gesture (`honeycomb dashboard`) probes the data daemon and prints a sentence. It does not open a UI. The URL that does open a browser is the solo install path, and only when Hive is the thing listening on 3853.
- Recommended action: Document the two verbs separately. Either wire `honeycomb dashboard` to `openDashboard` (and stop overloading `port` for both origins) or state that the verb is a reachability check.
- Owner: either. Confidence: 0.96.

### dashboard-code-3. Honeycomb serves dashboard JSON, not a shell. Stale comments still say `GET /dashboard`

- Status: VERIFIED
- Severity: medium
- Category: dead host
- Claim: The architecture doc is right that this daemon has no dashboard host route and no CORS middleware. `assemble.ts` calls `seams.mountDashboard` (`mountDashboardApi`) at line 1407. `host.ts` and `mountDashboardHost` are not in the tree. `html.ts` lines 81-87 still say `renderDashboardPage` is the page the daemon serves at `GET /dashboard`. `assets/ui_kits/dashboard/README.md` line 3 says the same. `setup-login.ts` and `setup-state.ts` still mention `mountDashboardHost` in comments. The page serializer is exported from `src/dashboard/index.ts` and has no production route.
- Evidence: `test -f src/daemon/runtime/dashboard/host.ts` fails. `ROUTE_GROUPS` in `server.ts` lines 68-95 starts at `/health` and includes `/api/diagnostics` and `/api/actions`. No `/dashboard`. CORS comment at `server.ts` lines 286-291. `scripts/pack-check.mjs` lines 72-76.
- Impact: The data plane the ViewBlock client reads is mounted. The HTML page builder is leftover. A contributor can think `renderDashboardPage` is live.
- Recommended action: Say in `html.ts` and the UI kit README that no daemon route calls the serializer. Leave the JSON API as the Honeycomb surface.
- Owner: either. Confidence: 0.95.

### dashboard-code-4. Performance doc: daemon caches match. Browser pause and second paint do not exist here

- Status: VERIFIED for this tree. UNVERIFIABLE-HERE for a Hive SPA that might still contain `usePoll`.
- Severity: high
- Category: knowledge drift
- Claim: `dashboard-performance.md` cites `usePoll` and `isTabHidden` in `src/dashboard/web/page-frame.tsx`, a single `/health` poll in `src/dashboard/web/app.tsx` `Shell`, and `showSecondary` in `src/dashboard/web/pages/dashboard.tsx`. None of those files or symbols exist under `src/`. The daemon half of the same doc matches `api.ts`: `createTtlViewCache`, `scopeCacheKey` joined with NUL, `DIAG_TTL_MS = 10_000`, `SAVINGS_TTL_MS = 60_000`, `CACHE_MAX_KEYS = 64`, and `fetchKpisView` composing `fetchKpiCounts` with `fetchEstimatedSavings`. The savings comment still describes `SUM(LENGTH(content)) / 4` as the live read, with ADR-0010 called out as not yet the live KPI. That function exists. Its SQL body was not re-derived in this pass beyond the function's presence and the doc's own "as it stands today" note.
- Evidence: `rg` for `isTabHidden`, `usePoll`, `showSecondary`, `healthReasons` under `src/dashboard` returns no matches. `api.ts` lines 262-269, 1306-1311, 1514-1548.
- Impact: Someone adding a page in this repo cannot inherit `usePoll`. They can inherit the TTL caches, which are server-side and already on the diagnostics routes. The doc's "daemon-served dashboard" framing fights the architecture doc's Hive split.
- Recommended action: Split the note. Keep the TTL section as Honeycomb daemon behavior. Move the visibility pause and below-the-fold deferral to a Hive doc, or mark them absent until that repo is in the audit.
- Owner: either. Confidence: 0.94.

### dashboard-code-5. `adding-a-page.md` warns the registry is gone, then teaches the missing registry

- Status: VERIFIED
- Severity: medium
- Category: knowledge drift
- Claim: Lines 11-12 correctly say `sidebar.tsx`, `router.tsx`, `registry.tsx`, `page-frame.tsx`, and `src/daemon/runtime/dashboard/host.ts` are not in this checkout, and that the steps are a historical contract. The title, the opening sentence ("daemon-served dashboard"), the three-step recipe, and the proof section still tell a contributor to edit `src/dashboard/web/registry.tsx` and cite `tests/dashboard/web/registry.test.tsx`. That test file is not in `tests/dashboard/` (four tests only).
- Evidence: File read of `library/knowledge/private/dashboard/adding-a-page.md`. `ls tests/dashboard`.
- Impact: The caveat is easy to miss. Following the recipe creates files the Honeycomb build does not bundle.
- Recommended action: Replace the recipe with the seam that exists: a `ViewBlock` builder plus a diagnostics handler. Point the hash-router recipe at Hive only, in one short paragraph, without a copy-pasteable `ROUTES` block.
- Owner: either. Confidence: 0.96.

### dashboard-code-6. The Cursor extension is a tested seam, not a packaged VS Code extension

- Status: VERIFIED
- Severity: high
- Category: packaging
- Claim: `cursor-extension-architecture.md` lines 184-206 describe a `package.json` with `engines.vscode`, `main`, `activationEvents`, `extensionKind: ui`, and a `contributes` block of four commands. That manifest is not in the repo. What exists is `activate(host, deps)` registering the four ids, painting a status bar through `paintStatusBar`, and opening a webview through `ExtensionHost`. The host interface is a fakeable seam. `CONVENTIONS.md` lines 87-106 list the real `vscode` adapter, device-flow login binding, production `DashboardDataSource`, and editor packaging as deferred. `esbuild.config.mjs` does not bundle the extension.
- Evidence: `test -f harnesses/cursor/extension/package.json` fails. `extension.ts` lines 94-163. `contracts.ts` lines 41-50. `esbuild.config.mjs` `HOOK_HARNESSES` cursor entry lines 181-184. `tests/cursor-extension/extension.test.ts` exists. Tests were not executed (`node_modules` absent).
- Impact: The knowledge doc reads as a shipped Cursor extension. The tree can register commands only when some out-of-repo adapter supplies `ExtensionHost`. Operators do not get a status bar from this package alone.
- Recommended action: Match the doc to `CONVENTIONS.md`: command ids and painters are in-repo. The VS Code manifest and `vscode` binding are not. Do not list `package.json` fields that are not on disk.
- Owner: either. Confidence: 0.95.

### dashboard-code-7. Cursor hook file table does not match the shim or the single binary

- Status: VERIFIED
- Severity: high
- Category: knowledge drift
- Claim: `cursor-extension-architecture.md` lines 29-41 and 165-176 say each Cursor event maps to its own source (`session-start.ts`, `capture.ts`, `session-end.ts`, `pre-tool-use.ts`, `spawn-wiki-worker.ts`, `wiki-worker.ts`) and that `preToolUse` rewrites Shell commands aimed at `~/.honeycomb/memory/`. On disk, `src/hooks/cursor/` contains only `shim.ts`. The binary is `harnesses/cursor/src/index.ts`, which calls `runHookBinary` with `createCursorShim()`. esbuild copies that one bundle to four alias names. The shim's Shell intercept runs on `postToolUse`, not on a `preToolUse` / `beforeShellExecution` event. The connector still emits a `beforeShellExecution` handler (`src/connectors/cursor.ts` lines 66 and 76). Those two maps disagree. The later paragraph (lines 202-204) that describes aliases of one bundle is the part that matches the build.
- Evidence: `ls src/hooks/cursor`. `shim.ts` lines 36-43 and 82-95. `harnesses/cursor/src/index.ts` lines 46-52. `esbuild.config.mjs` lines 181-184 and 208-209. `src/connectors/cursor.ts` lines 63-79.
- Impact: The file table sends readers to modules that are not here. A `beforeShellExecution` hooks.json entry will not hit the Shell branch inside `postToolUse`, so the documented VFS rewrite may never run for that event name. (The harnesses-mcp lens covers the same connector/shim split. This finding is the dashboard lens's doc table.)
- Recommended action: Replace the file table with `shim.ts` plus the alias list. Point pre-tool behavior at the event the shim actually reads, or change the shim to accept `beforeShellExecution`. Do not describe `wiki-worker.ts` as a Cursor source file until it exists.
- Owner: either. Confidence: 0.93.

### dashboard-code-8. The two knowledge docs describe two different dashboards as one shared tree

- Status: VERIFIED for the code split. UNVERIFIABLE-HERE that Hive's bundle is the React tree named in the architecture doc.
- Severity: high
- Category: knowledge drift
- Claim: `dashboard-architecture.md` says the operator console is a hash-routed React SPA on port 3853, and that the Cursor extension embeds that same tree. `cursor-extension-architecture.md` lines 208-210 say the webview writes the rendered view tree and reads the daemon on `127.0.0.1:3850` (`launch.ts` lines 51-56). The extension code embeds `renderDashboard` `ViewBlock` HTML (`bindings.ts` `dashboardWebviewRenderer`, `render.ts` `renderDashboardHtml`). It does not import a React page. `launch.ts` lines 51-56 are `daemonBaseUrl` for the data plane. The extension module does not call `daemonBaseUrl` or `createDaemonDashboardDataSource`. A host must inject the source. Login text also splits: the knowledge doc says the extension writes `~/.deeplake/credentials.json`. Extension comments say `~/.honeycomb/credentials.json` (`contracts.ts` around lines 237-264, `extension.ts` line 125). `src/cli/auth.ts` writes the shared Deep Lake file and treats `~/.honeycomb/credentials.json` as legacy. The extension `LoginFlow` is an injected seam, not that CLI writer.
- Evidence: `bindings.ts` lines 90-96. `render.ts` lines 55-62. `launch.ts` lines 51-56. `rg` of `daemonBaseUrl` under `harnesses/cursor` has no matches. `src/cli/auth.ts` logout comment lines 17-18 and 421-422.
- Impact: "One console, two hosts" is not true inside this repo. The extension paints the 020b blocks. The browser SPA, if it exists, is outside this repo and is not what `render.ts` emits.
- Recommended action: Say the extension webview serializes `ViewBlock`s from an injected data source aimed at port 3850 when the host wires `createDaemonDashboardDataSource`. Say the 3853 React shell is Hive-only and not compiled here. Align the credential path with `src/cli/auth.ts` once a real login binding exists.
- Owner: either. Confidence: 0.92.

### dashboard-code-9. Hive federation is a Honeycomb-side comment. The portal implementation is not in this repo

- Status: VERIFIED for Honeycomb constants and the CORS comment. UNVERIFIABLE-HERE for Hive ADR-0002, the BFF proxy, and whether anything listens on 3853.
- Severity: medium
- Category: scope
- Claim: `HIVE_HOST` and `HIVE_PORT` match the doc (`127.0.0.1`, `3853`). `server.ts` records that the browser is supposed to talk to Hive and that Hive calls Honeycomb server-side, so this server mounts no CORS middleware. `src/shared/fleet-detection.ts` treats an HTTP response from `http://127.0.0.1:3853/health` as a fleet signal. No Hive source, ADR file, or proxy handler lives in this checkout. This pass did not open a socket.
- Evidence: `src/shared/constants.ts` lines 19-23. `server.ts` lines 286-291. `fleet-detection.ts` line 21. `test -d hive` fails.
- Impact: The cross-origin section can be true and still not be checkable from this tree. A solo install that opens `:3853/` depends on a process this repo does not contain.
- Recommended action: Keep the Honeycomb-side facts (no CORS, no shell route, install URL). Label Hive route behavior as out of repo until that repository is audited. Do not treat the sequence diagram as verified from Honeycomb files alone.
- Owner: either. Confidence: 0.9.

## Punch list

1. Stop citing `src/dashboard/web/main.tsx` as a Honeycomb esbuild entry.
2. Make `honeycomb dashboard` either open `http://127.0.0.1:3853/` or stop saying that it does.
3. Mark `renderDashboardPage` and the UI kit README as unused by the daemon.
4. Split `dashboard-performance.md` into daemon TTL facts (present) and browser poll facts (not in this tree).
5. Shorten `adding-a-page.md` so the live seam is the `ViewBlock` builder, not `ROUTES`.
6. Rewrite the Cursor extension section around the seam files. Drop the missing `package.json`.
7. Rewrite the Cursor hook file table around `shim.ts` and the esbuild aliases. Reconcile `beforeShellExecution` with the shim.
8. Stop saying the extension embeds the React SPA.
9. Audit the Hive repo before treating the 3853 sequence diagram as verified.

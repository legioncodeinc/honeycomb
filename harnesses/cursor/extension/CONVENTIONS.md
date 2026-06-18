# Cursor extension shell — CONVENTIONS (PRD-020c)

The Honeycomb-for-Cursor editor extension SHELL lives under `harnesses/cursor/extension/`. It adds
operator UX on top of the 019c hook shim: Wire/Refresh Hooks, no-terminal Login, a D1–D5 status bar,
a dashboard webview, and skill symlink sync. Wave 1 shipped contracts + seams + honest stubs;
**Wave 2.2 (this landing) filled the `activate` body, the command handlers, the seam bindings, and
the render helpers.** The real `vscode`-bound host + the device-flow login binding remain the
DEFERRED assembly step (D-7) — see below.

**Read this file before extending the shell.**

## Module map (Wave 2.2)

- `contracts.ts` — the seams + fakes: `ExtensionHost`, `HookWiring`/`SkillSync`,
  `DashboardWebviewRenderer`, `StatusBarHealthSource`, and the new `LoginFlow` seam + `createFakeLoginFlow`
  (FR-5 / c-AC-5, writes the shared `~/.honeycomb/credentials.json` at `CREDENTIALS_FILE_MODE` = 0o600).
  Pure: imports nothing cross-module.
- `bindings.ts` — the factories that bind the abstract seams to the REUSED engines:
  `connectorHookWiring`/`connectorSkillSync` wrap a 019a `HarnessConnector` (D-4),
  `dashboardWebviewRenderer` wraps 020b `renderDashboard` (D-6), `healthSourceFromCheck` adapts a
  020d `HealthCheck` (the 020d boundary). This is the ONLY module importing `src/*`.
- `render.ts` — pure presentation: `renderDashboardHtml` (ViewBlock tree → webview HTML, no view
  logic) + `paintStatusBar` (D1–D5 → compact glyph row + tooltip, failing dimension flagged).
- `extension.ts` — `activate(host, deps)` registers the four commands, paints the status bar, runs
  activation-time skill-sync + bundle self-heal; returns an `ExtensionInstance` (`deactivate(instance)`
  disposes it — no module-global state).

## The four commands → seam delegation (FR-1)

`wireHooks` → `hooks.wire()` + re-paint bar · `login` → `login.login(mode)` (shared 0600 creds) +
`host.openExternal(deviceUrl)` + re-paint bar · `openDashboard` → `dashboard.renderHtml()` into a
webview · `syncSkills` → `skills.sync()` (no-clobber).

## The central invariant: thin client + NO `vscode` import — the host is a SEAM

(D-2 / D-7.)

- **Module home = `harnesses/cursor/extension/` ON PURPOSE.** Added to `NON_DAEMON_ROOTS`
  (`tests/daemon/storage/invariant.test.ts`, D-2). A stray `from ".../daemon/storage"` import here
  FAILS the build. The extension reaches the daemon only through seams; it opens NO DeepLake.
- **NEVER import `vscode` / `cursor`.** The editor API is NOT a repo dependency, so importing it
  would break the repo `tsc` / `build`. The `ExtensionHost` seam abstracts exactly the host
  capabilities the shell needs (register command, status bar, webview, openExternal). The real impl
  is a tiny `vscode`-bound adapter built at the DEFERRED assembly step (D-7); the
  `createFakeExtensionHost` fake drives every Wave-2 test.

## D-4 — hook wiring + skill sync REUSE the 019a connector

`HookWiring` + `SkillSync` (`contracts.ts`) DELEGATE to the 019a `CursorConnector` (a
`HarnessConnector` subclass). `wire()` → the connector's `install()` (copy bundle + foreign-preserve
+ `writeJsonIfChanged` idempotency → fingerprint stable on a no-op, c-AC-1/c-AC-3); `sync()` → the
connector's `linkSkills()` (no-clobber, c-AC-2). Do NOT fork a second merge engine. The Wave-2
`CursorConnector` lands in `src/connectors/cursor.ts` (a sibling of `claude-code.ts`), and the
extension's `HookWiring`/`SkillSync` wrap it.

## D-6 — the webview EMBEDS the canonical 020b view layer

`DashboardWebviewRenderer` (`contracts.ts`) calls the 020b `renderDashboard(...)` and paints the
SAME `ViewBlock` tree the daemon-served dashboard uses — NO duplicate view code (c-AC-6). The shell
does not render views; it hosts the 020b output in a webview. Pointed at the local daemon
(`127.0.0.1:3850`) through the 020b `DashboardDataSource`.

## The status bar surfaces 020d health (the boundary)

`StatusBarHealthSource` supplies the D1–D5 lines; the real impl calls 020d's
`HealthCheck.evaluate()` (the SAME engine the CLI `status` uses). The status bar SURFACES the result
(c-AC-4) — it does not re-probe. The shape mirrors 020d's `HealthDimension` WITHOUT importing it (the
Wave-1 cross-stream decoupling); Wave 2 binds the real source.

## The four commands (FR-1 / c-AC-1)

`EXTENSION_COMMANDS` (`contracts.ts`): `wireHooks`, `login`, `openDashboard`, `syncSkills`. `activate`
registers each on the `ExtensionHost`. The handlers delegate to the seams (wire → `hooks.wire`;
login → `host.openExternal` browser device login OR API-key entry writing the shared
`~/.honeycomb/credentials.json`, c-AC-5; dashboard → `dashboard.renderHtml` into a webview;
sync → `skills.sync`).

## tsc coverage / build

`harnesses/**/*` is in the repo tsconfig `include`, so this extension compiles in the repo `tsc`
pass WITHOUT a new include. There is NO esbuild entry for the extension this wave: an editor
extension is packaged by the editor's own tooling (a Wave-2 / deferred-assembly packaging step),
not by `esbuild.config.mjs`. If Wave 2 decides to bundle the extension via esbuild, add an entry
THEN; this scaffold adds none, and `npm run build` stays green because nothing references the
extension from a bundled entrypoint.

## Deferred assembly (honest deferral — D-7)

The shell is FULLY constructed-and-tested behind seams (13 tests, c-AC-1..6 + b-AC-5 + FR-9 in
`tests/cursor-extension/extension.test.ts`). The seam BINDINGS are real (`bindings.ts`); what stays
deferred is the *production wiring of the real seam implementations* — NO live editor binding is
claimed:
1. the real `ExtensionHost` — a tiny `vscode`-bound adapter (`commands.registerCommand`,
   `window.createStatusBarItem`/`createWebviewPanel`, `env.openExternal`). The fake drives every test.
2. the production `HarnessConnector` for Cursor — `src/connectors/cursor.ts` (`CursorConnector`,
   owned by the 020a stream). `connectorHookWiring`/`connectorSkillSync` are connector-agnostic and
   are proven here against a real 019a `HarnessConnector` subclass over the 019a `FakeFs`, so the
   D-4 reuse is exercised end-to-end without forking a merge engine.
3. the real `LoginFlow` — wraps the 011b `deviceFlowLogin` + the 011a `saveCredentials` (0600/0700).
   The fake proves the shared-creds-at-0600 contract (c-AC-5); the device-flow binding is deferred.
4. the production `DashboardDataSource` — the 020b `createDaemonDashboardDataSource` pointed at the
   loopback 3850 daemon. `dashboardWebviewRenderer` embeds the canonical 020b `renderDashboard` (D-6).
5. the editor packaging (`package.json` extension manifest + the editor's bundler). There is NO
   esbuild entry for the extension (an editor extension is packaged by the editor's tooling), so
   `npm run build` is unaffected; the shell compiles in the repo `tsc` pass via the `harnesses/**`
   include.

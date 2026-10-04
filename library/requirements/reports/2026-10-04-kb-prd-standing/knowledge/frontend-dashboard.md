# Frontend and dashboard knowledge standing

Wave 1a shard: `library/knowledge/private/frontend/` plus `library/knowledge/private/dashboard/`. Read-only. Branch `legion/kb-sotu-and-prd-lifecycle`. Product source and knowledge pages were not edited.

Hive's tree is not in this repository. `HIVE_PORT` 3853 is `src/shared/constants.ts`.

## Coverage

Knowledge pages read:

- `library/knowledge/private/frontend/dashboard-architecture.md`
- `library/knowledge/private/frontend/dashboard-performance.md`
- `library/knowledge/private/frontend/cursor-extension-architecture.md`
- `library/knowledge/private/frontend/dashboard-actions-surface.md`
- `library/knowledge/private/dashboard/adding-a-page.md`

Related links in those five pages resolve to existing siblings (architecture, collaboration, integrations, multi-tenant, operations, security, ADR-0010). No missing-sibling hole.

Grounding read (source, not build output): `src/shared/constants.ts`, `src/dashboard/` (`dashboard.ts`, `views.ts`, `launch.ts`, `html.ts`, `index.ts`, `contracts.ts`, `logs.ts`), `src/hooks/cursor/shim.ts`, `src/hooks/runtime.ts`, `src/hooks/normalize.ts`, `src/hooks/shared/session-start.ts`, `src/hooks/shared/session-start-seams.ts`, `src/hooks/shared/session-end.ts`, `src/hooks/shared/capture.ts`, `src/hooks/shared/pre-tool-use.ts`, `src/hooks/shared/context-renderer.ts`, `src/hooks/shared/credential-reader.ts`, `src/hooks/binary.ts`, `src/shared/capture-gate.ts`, `harnesses/cursor/src/index.ts`, `harnesses/cursor/extension/` (`extension.ts`, `contracts.ts`, `render.ts`, `bindings.ts`), `src/connectors/cursor.ts`, `esbuild.config.mjs`, `src/daemon/runtime/server.ts`, `src/daemon/runtime/assemble.ts`, `src/daemon/runtime/dashboard/api.ts`, `src/daemon/runtime/dashboard/actions-api.ts`, `src/daemon/runtime/capture/attach.ts`, `src/daemon/runtime/capture/capture-handler.ts`, `src/daemon/runtime/capture/turn-counters.ts`, `src/daemon/runtime/capture/event-contract.ts`, `src/daemon/runtime/summaries/job.ts`, `src/daemon/restart-helper.ts`, `src/daemon/runtime/services/embed-client.ts`, `src/daemon/runtime/auth/device-flow.ts`.

Absent paths checked: `src/dashboard/web/` (including `main.tsx`, `app.tsx`, `router.tsx`, `registry.tsx`, `sidebar.tsx`, `page-frame.tsx`, `pages/`, `wire.ts`), `src/daemon/runtime/dashboard/host.ts`, `tests/dashboard/web/registry.test.tsx`, `src/hooks/cursor/session-start.ts`, `src/hooks/cursor/capture.ts`, `src/hooks/cursor/session-end.ts`, `src/hooks/cursor/pre-tool-use.ts`, `src/hooks/cursor/spawn-wiki-worker.ts`, `src/hooks/cursor/wiki-worker.ts`, `harnesses/cursor/extension/package.json`, `harnesses/cursor/**/hooks.json`, any `hive/` tree, any `library/requirements/**/prd-145*`.

## Defects

### D1

- Quote: "The dashboard is a single-page React app" and, after noting `src/dashboard/web/` is absent, "The nav shell (`src/dashboard/web/app.tsx`, exported as `Shell`)" plus the hash routes `/`, `/harnesses`, `/memories`, `/graph`, `/sync`, `/logs`, `/settings` and the `ROUTES` array in `src/dashboard/web/registry.tsx`.
- Doc: `library/knowledge/private/frontend/dashboard-architecture.md:22` and `:65-124` (absence note at `:44` and `:130`)
- Grounding: ABSENT `src/dashboard/web/`. Live render is six `ViewBlock`s in order KPIs, sessions, settings, graph, rules, skill-sync at `src/dashboard/dashboard.ts:73-80` and `src/dashboard/views.ts:39-50`. The home KPI rows are `Memories`, `Sessions`, `Estimated savings` at `src/dashboard/views.ts:61-64`, not a Turns tile and not seven hash pages.
- Verdict: STALE
- Action: REVISE

### D2

- Quote: "The Hive portal serves a complete HTML document" with "a module script that pulls the bundled SPA (React, ReactDOM, the router, every page)" and "the Hive-side BFF proxy, Hive ADR-0002".
- Doc: `library/knowledge/private/frontend/dashboard-architecture.md:40-42` and `:161`
- Grounding: ABSENT. No Hive source and no Hive ADR in this repo. Honeycomb only records the split in comments (`src/dashboard/launch.ts:169`, `src/daemon/runtime/server.ts:286-291`). Port 3853 itself holds; see Holds.
- Verdict: HOLE
- Action: REVISE

### D3

- Quote: "Each maps to one compiled Node script" with rows `sessionStart` to `session-start.ts`, `beforeSubmitPrompt` / `postToolUse` / `afterAgentResponse` / `stop` to `capture.ts`, and `sessionEnd` to `session-end.ts`. The same page later says those files "are not present".
- Doc: `library/knowledge/private/frontend/cursor-extension-architecture.md:31-40` (contradiction at `:167`)
- Grounding: ABSENT `src/hooks/cursor/session-start.ts`, `capture.ts`, `session-end.ts`. Live shim is one file, `src/hooks/cursor/shim.ts:36-43`. The bundle entry is `harnesses/cursor/src/index.ts` (`esbuild.config.mjs:181-184`), which aliases one binary to `session-start.js`, `capture.js`, `pre-tool-use.js`, and `session-end.js`. The connector registers those aliases at `src/connectors/cursor.ts:73-79`.
- Verdict: STALE
- Action: REVISE

### D4

- Quote: "`afterAgentResponse` | `capture.ts` | Sends the assistant's reply as an `assistant_message` row" and "`stop` | `capture.ts` | Sends a `stop` row with final status and loop count". "Cursor fires five hooks".
- Doc: `library/knowledge/private/frontend/cursor-extension-architecture.md:31` and `:38-39`
- Grounding: `src/hooks/cursor/shim.ts:40-41` maps both `afterAgentResponse` and `stop` to logical `assistant_message`. There is no `stop` event kind. `src/connectors/cursor.ts:63-70` installs `assistant_message` on native `stop` only. `afterAgentResponse` is named in the connector comment (`src/connectors/cursor.ts:18`) and is not in `CURSOR_HANDLERS`. The installed set is six events, not five: `sessionStart`, `beforeSubmitPrompt`, `beforeShellExecution`, `postToolUse`, `stop`, `sessionEnd` (`src/connectors/cursor.ts:73-79`).
- Verdict: FALSE
- Action: REVISE

### D5

- Quote: "The `preToolUse` hook is also wired for the `Shell` tool only" and "Returns an `updated_input` that replaces the original shell command with `echo <result>`" after `parseBashGrep` and `searchDeeplakeTables`.
- Doc: `library/knowledge/private/frontend/cursor-extension-architecture.md:41-42` and `:116-124`
- Grounding: ABSENT `parseBashGrep`, `searchDeeplakeTables`, and any `renderPreTool` on the cursor shim. `src/hooks/cursor/shim.ts:36-43` has no `beforeShellExecution` or `preToolUse` key, so `createShim` drops that native name (`src/hooks/normalize.ts:131-132`). The connector does register `pre-tool-use.js` on `beforeShellExecution` with matcher `Shell` (`src/connectors/cursor.ts:66` and `:155-158`), but that alias is the same cursor shim, which cannot map the event. Shell on `postToolUse` is lowered to `preToolData` while the logical event stays `tool_call` (`src/hooks/cursor/shim.ts:88-95`), so dispatch runs `runCapture`, not `runPreToolUse` (`src/hooks/runtime.ts:377-397`). Claude Code is the shim that emits `updatedInput` (`src/hooks/claude-code/shim.ts:181`).
- Verdict: FALSE
- Action: REVISE

### D6

- Quote: "The block is composed in layers inside `session-start.ts`" including "Logged in to Honeycomb as org: Acme (workspace: default)" and, on drift, "`healDriftedOrgToken`". "When the user is logged in, `renderContextBlock` asks the daemon to query the `honeycomb_rules` table".
- Doc: `library/knowledge/private/frontend/cursor-extension-architecture.md:50-78` (mermaid repeats the same steps at `:145-152`)
- Grounding: ABSENT `src/hooks/cursor/session-start.ts` and ABSENT those auth strings in `src/`. Production session-start seams no-op heal, auto-update, table ensure, placeholder, and graph pull (`src/hooks/shared/session-start-seams.ts:122-127`). `createContextRenderer` only forwards the daemon body (`src/hooks/shared/context-renderer.ts:32-45`). The mounted context handler returns `{ additionalContext: "" }` (`src/daemon/runtime/capture/attach.ts:216-217`) and `contextHandler` is never overridden. `healOrgDrift` exists for CLI status (`src/daemon/runtime/auth/device-flow.ts:207`, `src/cli/runtime.ts:555-578`), not for the hook seam.
- Verdict: FALSE
- Action: REVISE

### D7

- Quote: "Every `afterAgentResponse` event bumps a per-session counter stored in `~/.honeycomb/state/` (via `bumpTotalCount`)" and the session-end hook "spawns the wiki worker" that "runs `cursor-agent --print`". "the periodic trigger checks `tryAcquireLock`".
- Doc: `library/knowledge/private/frontend/cursor-extension-architecture.md:97-112`
- Grounding: ABSENT `bumpTotalCount`, `tryAcquireLock`, `spawn-wiki-worker.ts`, and `wiki-worker.ts`. Periodic cues are an in-memory daemon map, default every 20 messages (`src/daemon/runtime/capture/turn-counters.ts:12-22` and `:58-59`), not a hook file under `~/.honeycomb/state/`. The hook runtime's summary spawn is a no-op (`src/hooks/runtime.ts:271` and `:474-476`). Session-end on the daemon enqueues a `summary` job (`src/daemon/runtime/capture/attach.ts:236-242`). The worker CLI for cursor is `cursor-agent` with args `["-p"]` (`src/daemon/runtime/summaries/job.ts:157-159`), not `--print`.
- Verdict: FALSE
- Action: REVISE

### D8

- Quote: "a `plugin_version` field stamped from the bundle's `.claude-plugin` version marker" and "`isHoneycombPluginEnabled()`: a marketplace-managed flag". "The self-heal path (`ensurePluginNodeModulesLink`) runs once per process".
- Doc: `library/knowledge/private/frontend/cursor-extension-architecture.md:84-93`
- Grounding: ABSENT all three names in `src/`. `pluginVersion` defaults to `""` (`src/daemon/runtime/capture/event-contract.ts:172`) and the hook runtime never sets it (`src/hooks/runtime.ts:272` passes only `captureFlag`). The capture gate can skip on `pluginEnabled === false` (`src/shared/capture-gate.ts:129`) but production `createHookRuntime` does not supply that flag. Extension self-heal re-runs `connector.install()` (`harnesses/cursor/extension/bindings.ts:57-62`); the comment there calls that the `ensurePluginNodeModulesLink` equivalent, which means the named function is not the live seam.
- Verdict: FALSE
- Action: REVISE

### D9

- Quote: "Symlinks org/team skills into `~/.cursor/skills-cursor/` and `<project>/.cursor/skills/` without clobbering."
- Doc: `library/knowledge/private/frontend/cursor-extension-architecture.md:197`
- Grounding: `src/connectors/cursor.ts:122-124` links into `~/.cursor/skills/` only. The extension comment repeats the doc path (`harnesses/cursor/extension/bindings.ts:72` and `contracts.ts:192-193`) but `sync()` returns `connector.install()` skill links (`harnesses/cursor/extension/bindings.ts:74-79`), so the connector path is the one that runs.
- Verdict: FALSE
- Action: REVISE

### D10

- Quote: "adding a page to the daemon-served dashboard is one registry entry plus one component" and "add a `RouteEntry` to the `ROUTES` array" in `src/dashboard/web/registry.tsx`. "the bundle stays one file (`/dashboard/app.js`)". "`tests/dashboard/web/registry.test.tsx` adds a throwaway registry entry".
- Doc: `library/knowledge/private/dashboard/adding-a-page.md:3` and `:15-16`, `:59-67`, `:90`, `:103-106` (the page already says those paths are absent at `:12`)
- Grounding: ABSENT `src/dashboard/web/registry.tsx`, ABSENT `/dashboard/app.js`, ABSENT `tests/dashboard/web/registry.test.tsx`. Live tests are `tests/dashboard/dashboard.test.ts`, `views.test.ts`, `html.test.ts`, `logs.test.ts`. A new view is a `build*View` returning `ViewBlock` (`src/dashboard/views.ts:16-18` and `:59-152`) composed by `renderDashboard` (`src/dashboard/dashboard.ts:65-81`). `html.ts` still comments that the daemon serves `GET /dashboard` (`src/dashboard/html.ts:5-6`); no such route is mounted (`src/daemon/runtime/dashboard/` has no `host.ts`).
- Verdict: STALE
- Action: REVISE

### D11

- Quote: "`usePoll(fn, ms)` (`src/dashboard/web/page-frame.tsx`) is the one polling primitive" and "The shell (`src/dashboard/web/app.tsx`, `Shell`) owns the single `/health` poll" at `HEALTH_POLL_MS` 5000. "the home now mounts the harness-area CONTENTS on a SECOND paint (`showSecondary` ... `src/dashboard/web/pages/dashboard.tsx`)". "The dashboard is a single host-served bundle on loopback".
- Doc: `library/knowledge/private/frontend/dashboard-performance.md:21-47`, `:81`, and `:85`
- Grounding: ABSENT `usePoll`, `isTabHidden`, `HEALTH_POLL_MS`, `showSecondary`, and `document.visibilityState` under `src/`. No dashboard esbuild entry in `esbuild.config.mjs`. `launchDashboard` fetches the daemon once per launch (`src/dashboard/launch.ts:84-131`); it does not poll from a browser tab.
- Verdict: FALSE
- Action: REVISE

### D12

- Quote: "const [counts, savings] = await Promise.all([ fetchKpiCounts(...), fetchEstimatedSavings(...) ])" as the body of `fetchKpisView`.
- Doc: `library/knowledge/private/frontend/dashboard-performance.md:67-73`
- Grounding: `src/daemon/runtime/dashboard/api.ts:267-272` awaits three reads: `fetchKpiCounts`, `fetchEstimatedSavings`, and `fetchInjectedTokens`.
- Verdict: FALSE
- Action: REVISE

### D13

- Quote: "PRD-145 makes the dashboard a peer of the CLI for those four named lifecycle actions" and "All four are `POST` under the `/api/actions` group". "`mountActionsGroup`, which attaches the four handlers".
- Doc: `library/knowledge/private/frontend/dashboard-actions-surface.md:20`, `:35`, and `:99`
- Grounding: ABSENT any `prd-145` folder under `library/requirements/`. `mountActionsGroup` registers five POSTs: `/logout`, `/embeddings`, `/memory`, `/restart`, `/uninstall` (`src/daemon/runtime/dashboard/actions-api.ts:231-327`). `/memory` persists `memory.enabled` and can live-reload the pipeline (`:264-308`).
- Verdict: FALSE
- Action: REVISE

### D14

- Quote: "Settings page settings.tsx" via `wire.ts`, and "`wire.ts` exposes `logout()`, `restartDaemon()`, `uninstall()`, and the embeddings toggle, and `settings.tsx` renders the Embeddings and System Actions sections".
- Doc: `library/knowledge/private/frontend/dashboard-actions-surface.md:24` and `:99`
- Grounding: ABSENT `src/dashboard/web/wire.ts` and ABSENT `src/dashboard/web/pages/settings.tsx`. Settings in this tree are `buildSettingsView` (`src/dashboard/views.ts:111-121`), which renders org, workspace, and settings rows. It does not call `/api/actions`.
- Verdict: STALE
- Action: REVISE

## Holds

These were checked because the pages assert them. Do not delete them in a revise.

- H1. Quote: "`HIVE_HOST` / `HIVE_PORT` in `src/shared/constants.ts:19-23`" and both `openDashboard` and solo `honeycomb install` open `http://127.0.0.1:3853/`. Doc: `dashboard-architecture.md:24` and `:38`. Grounding: `src/shared/constants.ts:19-23`, `src/dashboard/launch.ts:149-178`, `src/commands/install.ts:64-74` and `:351-356`. Verdict: HOLDS. Action: LEAVE.
- H2. Quote: "Honeycomb ships zero CORS middleware". Doc: `dashboard-architecture.md:163`. Grounding: `src/daemon/runtime/server.ts:286-291`. Verdict: HOLDS. Action: LEAVE. The Hive proxy that the comment names is still D2.
- H3. Quote: setup seams "fire solely when `daemon.config.mode === "local"`". Doc: `dashboard-architecture.md:26`. Grounding: `src/daemon/runtime/assemble.ts:1447`. Verdict: HOLDS. Action: LEAVE.
- H4. Quote: "This checkout's `src/dashboard/` is the view-tree and launch client" listing `dashboard.ts`, `launch.ts`, `views.ts`, `html.ts`, `contracts.ts`, `logs.ts`, and `index.ts`, and "does not contain `src/dashboard/web/`". Doc: `dashboard-architecture.md:44`. Grounding: those seven files exist; `src/dashboard/web/` is ABSENT. Verdict: HOLDS. Action: LEAVE. The sections after that sentence are D1.
- H5. Quote: "Honeycomb has no `GET /dashboard` route". Doc: `dashboard-architecture.md:42` and `adding-a-page.md:94`. Grounding: no `host.ts` under `src/daemon/runtime/dashboard/` and no `/dashboard` route registration in `src/daemon/runtime/server.ts`. Verdict: HOLDS. Action: LEAVE.
- H6. Quote: "`fetchEstimatedSavings` computes a corpus-length proxy (`SUM(LENGTH(content)) / 4`)" and ADR-0010 / IRD-278 are not live yet. Doc: `dashboard-architecture.md:79` and `dashboard-performance.md:77`. Grounding: `src/daemon/runtime/dashboard/api.ts:234` and `:347-352`. ADR file `library/knowledge/private/architecture/adr/0010-recall-weighted-est-savings.md:1`. IRD file `library/issues/backlog/ird-278-est-savings-recall-weighted/ird-278-est-savings-recall-weighted-index.md:1`. `fetchEstimatedSavings` is still the live read. Verdict: HOLDS. Action: LEAVE.
- H7. Quote: diagnostics caches at `DIAG_TTL_MS = 10_000`, savings at `SAVINGS_TTL_MS = 60_000`, `CACHE_MAX_KEYS = 64`, `scopeCacheKey`, per-`mountDashboardApi` instances, sessions keyed by limit and cursor. Doc: `dashboard-performance.md:49-59`. Grounding: `src/daemon/runtime/dashboard/api.ts:1306-1361`, `:1517-1548`. Verdict: HOLDS. Action: LEAVE. Keep this section when revising D11 and D12.
- H8. Quote: "`actionGuard`" local mode, `Sec-Fetch-Site`, loopback `Origin`, and `x-honeycomb-session`. Doc: `dashboard-actions-surface.md:47-55`. Grounding: `src/daemon/runtime/dashboard/actions-api.ts:117-138`. Group declared at `src/daemon/runtime/server.ts:95`. Verdict: HOLDS. Action: LEAVE.
- H9. Quote: restart spawns `restart-helper.js` from `src/daemon/restart-helper.ts` with `HONEYCOMB_RESTART_ENTRY` and `HONEYCOMB_RESTART_PORT`. Doc: `dashboard-actions-surface.md:79-85`. Grounding: `src/daemon/restart-helper.ts:1-21` and `src/daemon/runtime/dashboard/actions-api.ts:184-193`. Unit test file `tests/daemon/runtime/dashboard/actions-api.test.ts` exists. Verdict: HOLDS. Action: LEAVE. The "not yet live-dogfooded" sentence (`dashboard-actions-surface.md:87`) has no dogfood log in this tree; leave it as a caution.
- H10. Quote: uninstall v1 returns harnesses plus `honeycomb uninstall` and `removed: false`. Doc: `dashboard-actions-surface.md:91`. Grounding: `src/daemon/runtime/dashboard/actions-api.ts:204-212`. Verdict: HOLDS. Action: LEAVE.
- H11. Quote: "In this checkout the Cursor hook source is `src/hooks/cursor/shim.ts`" and the extension directory lists `extension.ts`, `index.ts`, `bindings.ts`, `render.ts`, `contracts.ts`, and `CONVENTIONS.md` with no `package.json` and no `hooks.json`. Doc: `cursor-extension-architecture.md:167-173`. Grounding: those paths exist; `package.json` and `hooks.json` under `harnesses/cursor/` are ABSENT. Verdict: HOLDS. Action: LEAVE. The inventory table above that paragraph is D3.
- H12. Quote: four commands `honeycomb.wireHooks`, `honeycomb.login`, `honeycomb.openDashboard`, `honeycomb.syncSkills`, and `activate` returns `refreshStatusBar`, `openDashboard`, and `dispose`. Doc: `cursor-extension-architecture.md:190-203`. Grounding: `harnesses/cursor/extension/contracts.ts:41-49` and `harnesses/cursor/extension/extension.ts:94-163`. Verdict: HOLDS. Action: LEAVE. `engines.vscode` and `activationEvents` are not in a manifest in this checkout; the page already says that at `:183`. Leave that caveat.
- H13. Quote: status bar "Honeycomb" glyph row with `hasFailure`, and the dashboard command writes the view tree at `extension.ts:108-113`, reading the daemon at `launch.ts:51-56`. Doc: `cursor-extension-architecture.md:207`. Grounding: `harnesses/cursor/extension/render.ts:95-105`, `harnesses/cursor/extension/extension.ts:108-113`, `src/dashboard/launch.ts:51-56` (`daemonBaseUrl` uses `DAEMON_PORT` 3850). Verdict: HOLDS. Action: LEAVE.
- H14. Quote: "The same rendered view tree the dashboard produces is also what the Cursor extension embeds". Doc: `dashboard-architecture.md:173`. Grounding: `src/dashboard/views.ts:7-8` and `harnesses/cursor/extension/bindings.ts:90-95`. Verdict: HOLDS. Action: LEAVE. Point this sentence at `ViewBlock`, not at the React shell in D1.
- H15. Quote: "`HONEYCOMB_CAPTURE=false`: skips all writes". Doc: `cursor-extension-architecture.md:88`. Grounding: `src/shared/capture-gate.ts:56-58` and `src/hooks/runtime.ts:272`. Verdict: HOLDS. Action: LEAVE.
- H16. Quote: embeddings off or unavailable leave `message_embedding` NULL and the row is still written. Doc: `cursor-extension-architecture.md:93` (the sentence is attached to the missing `capture.ts`). Grounding: insert omits the column (`src/daemon/runtime/capture/capture-handler.ts:682`) and a later attach fills it when the embed client returns a vector (`src/daemon/runtime/capture/capture-handler.ts:885`, `src/daemon/runtime/assemble.ts:1361-1364`, `src/daemon/runtime/services/embed-client.ts:132-135`). Opt-out is `HONEYCOMB_EMBEDDINGS=false` on the daemon embed client (`src/daemon/runtime/services/embed-client.ts:162-171`), not inside a cursor capture script. Verdict: HOLDS for the daemon outcome. Action: REVISE the attribution only (move it off `capture.ts`). Do not drop the NULL-vector fact.
- H17. Quote: login "writes the shared `~/.deeplake/credentials.json` at mode `0o600`". Doc: `cursor-extension-architecture.md:195`. Grounding: hook and CLI credential read prefers `~/.deeplake/credentials.json` (`src/hooks/shared/credential-reader.ts:70-79`). File mode `0o600` is `src/daemon/runtime/auth/credentials-store.ts:127`. The extension login body is an injected seam (`harnesses/cursor/extension/extension.ts:124-126`); that comment still says `~/.honeycomb/credentials.json`, which is only the legacy fallback (`credential-reader.ts:52-53`). Verdict: HOLDS for the shared file the daemon writes. Action: LEAVE the deeplake path. The extension comment is source drift, out of this shard's edit scope.

## Counts

- Knowledge pages: 5
- Defects: 14 (D1-D14)
- Holds recorded so a later edit does not strip them: 17 (H1-H17)

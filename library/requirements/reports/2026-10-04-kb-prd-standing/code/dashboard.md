# Code standing: dashboard

Wave 2. Read-only. Branch worktree at `/home/marioaldayuz/Desktop/development/active/honeycomb`. No knowledge page, PRD, or source file was edited. No commit.

Hive source is not in this repository. `src/dashboard/web/` has 0 files. `src/dashboard/web/main.tsx` is absent. `src/daemon/runtime/dashboard/host.ts` is absent. `mountDashboardHost` survives only as comments (`src/daemon/runtime/dashboard/CONVENTIONS.md:48`).

## Method

Walked `src/dashboard/` (`dashboard.ts`, `views.ts`, `launch.ts`, `html.ts`, `index.ts`, `contracts.ts`, `logs.ts`) and `src/daemon/runtime/dashboard/` (25 files, including `api.ts`, `actions-api.ts`, `sync-api.ts`, `harness-registry.ts`, `roi-rates.ts`, `roi-honesty-contract.ts`). Spot-checked the non-dashboard paths the assigned wave-1 rows cite (cursor shim and connector, notifications, health probes, pollinate trigger, restart helper, constants). Skipped `node_modules` and build outputs (`daemon/`, `bundle/`, `mcp/bundle/`, `harnesses/*/bundle/`, `embeddings/embed-daemon.js`).

Rule used for every completed-dashboard bucket call:

- A move to `in-work` is overturned when the only cited gap is the missing SPA (`src/dashboard/web/main.tsx` and the rest of `src/dashboard/web/`).
- A move to `in-work` is confirmed only when a criterion is still required by the PRD text and absent in this tree: Sessions labels, Hermes and OpenClaw flags, the pulled badge, vault settings, or the recall badge.
- PRD-024 UI-kit rows that moved to Hive stay with the completed folder. Archive is for withdrawn work. This host was relocated after the PRD shipped.

Operations standing in this file covers `roi-tracker.md` and `notifications-and-health.md` only. The other operations defects in that wave-1 file are out of this shard.

## Counts

- Knowledge actions: 42 confirm, 0 overturn, 0 unverifiable.
- PRD bucket calls: 7 confirm, 7 overturn, 0 unverifiable.
- Confirmed moves to `in-work`: 5 (029, 032, 035, 039, 042).
- Overturned moves to `in-work` (folder stays `completed/`): 5 (036, 037, 038, 040, 041).
- Confirmed stays in `completed/`: 4 (024, 027, 043, 044).
- PRD-024 archive recommendation: none. Bucket stays `completed`.

## Knowledge: frontend and dashboard

Source: `library/requirements/reports/2026-10-04-kb-prd-standing/knowledge/frontend-dashboard.md`.

### Defects (REVISE)

All 14 revise actions are confirmed.

1. D1. CONFIRM REVISE. `dashboard-architecture.md` still describes a React SPA, hash routes, and `src/dashboard/web/registry.tsx`. Live render is six `ViewBlock`s at `src/dashboard/dashboard.ts:73-80` (KPIs, sessions, settings, graph, rules, skill-sync). KPI rows are `Memories`, `Sessions`, `Estimated savings` at `src/dashboard/views.ts:61-64`.
2. D2. CONFIRM REVISE. No Hive tree and no Hive ADR in this repo. The split is a comment at `src/dashboard/launch.ts:167-169` and `src/daemon/runtime/server.ts:286-291`. `HIVE_PORT` 3853 holds at `src/shared/constants.ts:19-23`.
3. D3. CONFIRM REVISE. `src/hooks/cursor/session-start.ts`, `capture.ts`, and `session-end.ts` are absent. Live map is `src/hooks/cursor/shim.ts:36-43`. Connector aliases are `src/connectors/cursor.ts:73-79`.
4. D4. CONFIRM REVISE. `afterAgentResponse` and `stop` both map to `assistant_message` (`src/hooks/cursor/shim.ts:40-41`). `CURSOR_HANDLERS` registers `assistant_message` on native `stop` only (`src/connectors/cursor.ts:63-79`). Installed set is six events.
5. D5. CONFIRM REVISE. The cursor shim has no `beforeShellExecution` key and no `parseBashGrep`. The connector still registers `pre-tool-use.js` on `beforeShellExecution` with matcher `Shell` (`src/connectors/cursor.ts:66`, `:155-158`). Shell on `postToolUse` becomes `preToolData` while the logical event stays `tool_call` (`src/hooks/cursor/shim.ts:88-95`).
6. D6. CONFIRM REVISE. `src/hooks/cursor/session-start.ts` is absent. `healDriftedOrgToken` exists as a no-op seam (`src/hooks/shared/session-start-seams.ts:123`), so a revise should say the production seam no-ops, and should keep the symbol name.
7. D7. CONFIRM REVISE. `bumpTotalCount`, `tryAcquireLock`, `spawn-wiki-worker.ts`, and `wiki-worker.ts` are absent under `src/`. Cursor summary CLI args are `["-p"]` (`src/daemon/runtime/summaries/job.ts:157-159`).
8. D8. CONFIRM REVISE. `plugin_version` as a hook stamp, `isHoneycombPluginEnabled`, and `ensurePluginNodeModulesLink` are absent as those names under `src/hooks` and `harnesses/cursor`. The catalog column `plugin_version` still exists (`src/daemon/storage/catalog/sessions-summaries.ts:50`). The revise is about the hook narrative.
9. D9. CONFIRM REVISE. Skill links go to `~/.cursor/skills/` (`src/connectors/cursor.ts:122-125`).
10. D10. CONFIRM REVISE. `src/dashboard/web/registry.tsx`, `/dashboard/app.js`, and `tests/dashboard/web/registry.test.tsx` are absent. A new view is a `build*View` in `src/dashboard/views.ts:59-152` composed by `renderDashboard`. `src/dashboard/html.ts:5-6` still says the daemon serves `GET /dashboard`. No such route is mounted. `host.ts` is absent.
11. D11. CONFIRM REVISE. `usePoll`, `HEALTH_POLL_MS`, `showSecondary`, and `document.visibilityState` are absent under `src/`. `launchDashboard` fetches once (`src/dashboard/launch.ts:142-146`).
12. D12. CONFIRM REVISE. `fetchKpisView` awaits three reads: `fetchKpiCounts`, `fetchEstimatedSavings`, and `fetchInjectedTokens` (`src/daemon/runtime/dashboard/api.ts:267-271`).
13. D13. CONFIRM REVISE. `mountActionsGroup` registers five POSTs: `/logout`, `/embeddings`, `/memory`, `/restart`, `/uninstall` (`src/daemon/runtime/dashboard/actions-api.ts:232-323`). No `prd-145` folder was required to see the fifth route.
14. D14. CONFIRM REVISE. `src/dashboard/web/wire.ts` and `settings.tsx` are absent. `buildSettingsView` renders org, workspace, and a string map (`src/dashboard/views.ts:111-121`) and does not call `/api/actions`.

### Holds (LEAVE, plus one attribution revise)

Writers should keep these passages.

1. H1. CONFIRM LEAVE. `HIVE_HOST` / `HIVE_PORT` at `src/shared/constants.ts:19-23`. `openDashboard` returns `http://127.0.0.1:3853/` via `portalBaseUrl` (`src/dashboard/launch.ts:149-178`).
2. H2. CONFIRM LEAVE. No CORS middleware. Comment at `src/daemon/runtime/server.ts:286-291`. The Hive proxy named there stays D2.
3. H3. CONFIRM LEAVE. `daemon.config.mode === "local"` at `src/daemon/runtime/assemble.ts:1447`.
4. H4. CONFIRM LEAVE. The seven checkout files exist. `src/dashboard/web/` is absent. The sentences after that absence note are D1.
5. H5. CONFIRM LEAVE. No `GET /dashboard` registration. `CONVENTIONS.md:48-49` says honeycomb no longer mounts it.
6. H6. CONFIRM LEAVE. Savings is `SUM(LENGTH(content))` divided by `CHARS_PER_TOKEN = 4` (`src/daemon/runtime/dashboard/api.ts:234`, `:320`, `:347-352`).
7. H7. CONFIRM LEAVE. `DIAG_TTL_MS = 10_000`, `SAVINGS_TTL_MS = 60_000`, `CACHE_MAX_KEYS = 64` (`src/daemon/runtime/dashboard/api.ts:1517-1545`).
8. H8. CONFIRM LEAVE. `actionGuard` checks local mode, `Sec-Fetch-Site`, loopback `Origin`, and `x-honeycomb-session` (`src/daemon/runtime/dashboard/actions-api.ts:117-138`).
9. H9. CONFIRM LEAVE. Restart sets `HONEYCOMB_RESTART_ENTRY` and `HONEYCOMB_RESTART_PORT` (`src/daemon/runtime/dashboard/actions-api.ts:185-192`). Helper documents the same env (`src/daemon/restart-helper.ts:19-26`).
10. H10. CONFIRM LEAVE. Uninstall v1 returns harnesses, `honeycomb uninstall`, and `removed: false` (`src/daemon/runtime/dashboard/actions-api.ts:204-209`).
11. H11. CONFIRM LEAVE. Cursor hook source in this checkout is `src/hooks/cursor/shim.ts`. The inventory table above that paragraph is D3.
12. H12. CONFIRM LEAVE. Command ids `honeycomb.wireHooks`, `honeycomb.login`, `honeycomb.openDashboard`, `honeycomb.syncSkills` are `harnesses/cursor/extension/contracts.ts:43-49`.
13. H13. CONFIRM LEAVE. Status bar text is `Honeycomb` plus glyphs, and `hasFailure` is `harnesses/cursor/extension/render.ts:95-105`. The dashboard command writes the webview at `harnesses/cursor/extension/extension.ts:108-113`. `daemonBaseUrl` uses `DAEMON_PORT` (`src/dashboard/launch.ts:51-56`).
14. H14. CONFIRM LEAVE. The shared surface is `ViewBlock` (`src/dashboard/views.ts:7-20` and `:39-50`). Point the sentence at `ViewBlock`. The React shell is D1.
15. H15. CONFIRM LEAVE. `HONEYCOMB_CAPTURE === "false"` skips writes (`src/shared/capture-gate.ts:25`).
16. H16. CONFIRM REVISE the attribution only. Keep the NULL-vector outcome. `capture-handler.ts:650` says `message_embedding` is left off the insert. The fact does not belong on a missing `capture.ts`.
17. H17. CONFIRM LEAVE the deeplake credentials path as wave 1 grounded it. This pass did not re-open `credentials-store.ts`. The hold matches the connector and hook credential reader already cited by wave 1, and nothing in `src/dashboard/` contradicts it.

## Knowledge: ROI and notifications

Source: `library/requirements/reports/2026-10-04-kb-prd-standing/knowledge/operations-runtime-cost.md`. Defects 1-9 and 18-24 are outside this shard.

### Notifications (`notifications-and-health.md`)

1. Defect 10. CONFIRM REVISE. `drainSessionStart` is absent. `src/notifications/index.ts` is a barrel (re-exports through about line 70). Timeout constant is `DEFAULT_PIPELINE_TIMEOUT_MS = 1500` at `src/notifications/pipeline.ts:32-33`. The pipeline comment calls the operation `drain(session_start)` (`pipeline.ts:4`).
2. Defect 11. CONFIRM REVISE. `tryClaim` is absent. Lock factory is `createClaimLock` (`src/notifications/state.ts:158-160`). Dir name is `claims` (`CLAIM_DIR_NAME` at `:52`). Exclusive create is `openSync(path, "wx")` at `:123`. Other FS errors throw `StateFsError` at `:128`.
3. Defect 12. CONFIRM REVISE. `src/cli/install-cursor.ts` is absent. Live set is `CURSOR_HANDLERS` at `src/connectors/cursor.ts:73-80` (six events, no `graph-on-stop.js`, no `afterAgentResponse` registration).
4. Defect 13. CONFIRM REVISE. D1 is the in-process version (`src/cli/health-probes.ts:35-40`). D3 is `which` / `where` (`:43-49`). The five dimension ids remain. D4's status-query match, as wave 1 stated it, was not re-opened line by line; the D1 contradiction is enough to revise the strategy table.
5. Defect 14. CONFIRM REVISE. `EmbeddingsHealth` is `"off" | "warming" | "on" | "suspect" | "failed"` (`src/daemon/runtime/health.ts:159`). There is no `/health` literal `ready` or `BM25` in that type.
6. Defect 15. CONFIRM REVISE. `src/notifications/health.ts` has no `setInterval` or `setTimeout`. Probes run from the CLI status path (`src/cli/health-probes.ts:1-4`).

H2. CONFIRM LEAVE. State file resolution uses `honeycombStateDir()` (`src/notifications/state.ts:133-135`) and `createNotificationsState` reads `notifications-state.json` with the legacy `~/.honeycomb` fallback (`:197-205`).

### ROI (`roi-tracker.md`)

1. Defect 16. CONFIRM REVISE. `src/dashboard/web/pages/roi.tsx` and `roi-chart.tsx` are absent. Daemon routes `GET /roi` and `GET /roi/trend` are `src/daemon/runtime/dashboard/api.ts:1471-1478` (full paths `/api/diagnostics/roi` and `/api/diagnostics/roi/trend` on that group).
2. Defect 17. CONFIRM REVISE. Tokens `--verified` and `--severity-critical` exist in `assets/tokens/colors.css:61` and `:71`. No page in `src/dashboard/` applies them to ROI sign. `assembleRoiView` uses status discriminants (`src/daemon/runtime/dashboard/api.ts:1018-1030`). Attribute rendering to the Hive portal, or drop the CSS rule until a page in this repo owns it.

H1. CONFIRM LEAVE. The disclaimer that `mountDashboardHost`, `host.ts`, and `roi-chart.tsx` are absent must stay. Routes in H1's grounding remain `api.ts:1471-1478`.

H6. CONFIRM LEAVE. Sonnet `300/1500`, Opus `1500/7500`, Haiku `100/500`, `RATES_AS_OF = "2026-06-26"` (`src/daemon/runtime/dashboard/roi-rates.ts:69` and `:84-112`). Honesty witness `@ts-expect-error` is `src/daemon/runtime/dashboard/roi-honesty-contract.ts:37` and `:43`.

## PRD bucket calls

### PRD-024 dashboard UI parity

Wave 1: stay `completed`. Code: CONFIRM stay `completed`.

UI-kit rows moved to Hive with the host. They are AC-1 (the look, `GET /dashboard` UI-kit), AC-2 (served live panels), AC-3 (recall bar and memory cards), AC-4 (LiveLog panel), AC-5 (ConnectivityBanner on a served page), the host half of AC-7, and AC-8 (screenshot of the mockup). Those files (`host.ts`, `app.tsx`, `wire.ts`) are absent. `src/daemon/runtime/dashboard/CONVENTIONS.md:46-49` and `src/dashboard/launch.ts:167-169` say the browser dashboard is the hive portal on port 3853 and honeycomb keeps `/api/*`.

Bucket for those rows and for the folder: `completed`. Archive would mark the work withdrawn. The host was relocated after the PRD shipped. `in-work` would record that relocation as unfinished honeycomb UI.

The pollinate trigger route is still in this tree: `POST /api/diagnostics/pollinate` (`src/daemon/runtime/pollinating/api.ts:77` and `:278`). That backend half does not reopen the folder.

### PRD-027 recall ranking

Wave 1: stay `completed`. Code: CONFIRM stay `completed`.

AC-4's dashboard half is a missing SPA recall renderer (`src/dashboard/web/` absent, `src/dashboard/views.ts` has no engine-score row). That is the same class as `main.tsx` absence. It is not one of the five criteria that confirm a move. Wave 1 already marked the CLI half met. This pass did not re-walk the ranker.

### PRD-029 degradation observability (recall badge)

Wave 1: stay `completed`, because the badge lived in the SPA. Code: OVERTURN that stay. Move the folder to `in-work`.

AC-1 is still required. The index was not amended (`library/requirements/completed/prd-029-degradation-observability/prd-029-degradation-observability-index.md:69-71`): when `degraded: true`, the dashboard recall bar renders a "lexical fallback" badge. `src/dashboard/` has no `lexical fallback` string, no `LexicalFallback`, and no recall bar. The CLI marker `(lexical fallback)` at `src/commands/storage-handlers.ts:302` is a different surface. Daemon recall still sets `degraded` (`src/daemon/runtime/memories/api.ts:214` comment and the log at `:879`). Those daemon halves can stay met inside an `in-work` folder. The badge criterion is the reason for the move.

### PRD-032 encrypted vault (vault settings)

Wave 1: stay `completed`, and reopen only if the pollinate route clause is judged enough. Code: OVERTURN that stay. Move the folder to `in-work`.

Vault settings are still required by `prd-032c-encrypted-vault-dashboard.md:55-59` (c-AC-1 through c-AC-5): a Settings panel that loads provider, model, and pollinating from daemon vault settings and writes them back. `src/dashboard/` contains no `provider`, `activeModel`, `activeProvider`, or `pollinating` string. `buildSettingsView` in the daemon returns only `mode` and `port` (`src/daemon/runtime/dashboard/api.ts:515-521`). The view builder prints org, workspace, and that map (`src/dashboard/views.ts:111-121`).

The pollinate-versus-vault residual (wave 1 AC-6 / d-AC-2) was not re-proved in this walk. `src/daemon/runtime/pollinating/api.ts:311` can return `reason: "disabled"`, and this pass did not trace that flag to the vault setting. That clause is unverifiable here and is not the move reason.

Vault core and CLI stay met inside the folder. The move is the settings panel.

### PRD-035 dashboard data fixes (Sessions labels)

Wave 1: move to `in-work`. Code: CONFIRM the move.

The confirming criterion is the Sessions label, which is still required and still painted by this tree. Index AC-1 and 035a AC-1/AC-2 ask for a KPI labeled "Turns" and a panel titled "Turns". `src/dashboard/views.ts:63` renders `` `Sessions: ${view.sessionCount}` ``. `src/dashboard/views.ts:79` sets the panel title to `"Sessions"`. The contract already says the presentation name is "Turns" (`src/dashboard/contracts.ts:50-55`). The daemon count is present: `turnCount: sessionCount` at `src/daemon/runtime/dashboard/api.ts:300-302`. The label builders do not read `turnCount`.

The graph-widget SPA rows wave 1 marked unverifiable are not the move reason. Do not treat `panels.tsx` absence as a second reason to move. The Sessions labels are sufficient.

### PRD-036 skill asset discovery

Wave 1: move to `in-work` because `SkillSyncPanel` and `.claude/skills` are absent. Code: OVERTURN. Stay `completed`.

The panel is the missing SPA. The daemon union is in this tree: `fetchSkillSyncView` (`src/daemon/runtime/dashboard/api.ts:718-759`) and it does emit `pulled` when `visibility` is not `global` (`api.ts:746`). That is a different union from PRD-042. Scanner: `src/daemon/runtime/dashboard/installed-assets.ts`. Missing `main.tsx` / `SkillSyncPanel` does not move this folder.

### PRD-037 dashboard nav shell

Wave 1: move to `in-work` because every criterion names `src/dashboard/web/main.tsx`, the router, the sidebar, or the registry. Code: OVERTURN. Stay `completed`.

`src/dashboard/web/main.tsx` is absent. That is the whole case. The index status line still says Backlog while the folder is `completed/`. Correct the status line in place. Do not move the folder.

### PRD-038 home zones

Wave 1: move to `in-work` because home zones, the recall center, and the harness strip are SPA files. Code: OVERTURN. Stay `completed`.

Same rule as 037. Correct a Backlog status line in place if it still says Backlog.

### PRD-039 harnesses page (Hermes and OpenClaw flags)

Wave 1: move to `in-work` because the page is absent and because c-AC-4 is unmet. Code: CONFIRM the move. The page absence is not the reason. The flags are.

039c c-AC-4 still requires the descriptors to reflect Hermes MCP registration and OpenClaw contracted tools (`prd-039c` line 103 in the wave-1 quote). `HARNESS_SPECIFICS` sets `hermes: {}` and `openclaw: {}` (`src/daemon/runtime/dashboard/harness-registry.ts:137-139`). The test locks the omission: `mcpRegistration` and `contractedTools` are `undefined` (`tests/daemon/runtime/dashboard/harness-api.test.ts:376-377`). The shims still describe those divergences: Hermes appends an MCP-tools mention (`src/hooks/hermes/shim.ts:45-47`), and OpenClaw states tools are registered rather than hooked (`src/hooks/openclaw/shim.ts:14`). The capability flags that c-AC-4 names are absent. `GET /api/diagnostics/harnesses` can stay met. The `#/harnesses` page is unverifiable here and does not add a second move reason.

### PRD-040 memories page

Wave 1: move to `in-work` because the Memories page, forms, and watch UI are absent. Code: OVERTURN. Stay `completed`.

Those criteria are the SPA page. Daemon memory routes are outside `src/dashboard/` and were not the gap. Missing `main.tsx` does not move this folder. Correct a Backlog status line in place.

### PRD-041 graph page

Wave 1: move to `in-work` because `layout(...)`, `GraphCanvas`, and `#/graph` are absent. Code: OVERTURN. Stay `completed`.

`GET /api/graph` and `GET /api/diagnostics/memory-graph` were marked met by wave 1. The in-tree text view still builds an empty-state or a `graph-canvas` block (`src/dashboard/views.ts:130-140`). The interactive canvas and hash route are the SPA. Missing `main.tsx` does not move this folder.

### PRD-042 sync page (pulled badge)

Wave 1: move to `in-work`. Code: CONFIRM the move. The Sync page absence is not the reason. The pulled badge on the list union is.

`unionFor` assigns `state: "shared"` for substrate rows (`src/daemon/runtime/dashboard/sync-api.ts:264`) and `state: "local"` for disk-only rows (`:293`). It never assigns `"pulled"`. Index AC-1, 042a a-AC-1, and 042b b-AC-1 still require the list badge `local / pulled / shared`. Pull's action result does return `state: "pulled"` (`sync-api.ts:545`). The next list read still labels that row `shared`. The `#/sync` page is unverifiable here and does not add a second move reason.

`fetchSkillSyncView` in `api.ts:746` is the older skills union and can emit `pulled`. Do not treat that function as closing 042.

### PRD-043 logs page

Wave 1: stay `completed`. Page rows unverifiable. Code: CONFIRM stay `completed`.

`#/logs` and the turns drill-down page are absent with `src/dashboard/web/`. That does not move the folder. The durable store and history API stay the met half (`src/daemon/runtime/logs/` as wave 1 cited; sessions read remains `fetchSessionsView` at `src/daemon/runtime/dashboard/api.ts:456`). The index status line still says Backlog. Correct that line to completed in place.

043c AC-4 ("no user-facing string denoting captured turns reads Sessions") is unverifiable for a missing page. The Sessions labels that are present are PRD-035's criterion, already confirmed as the 035 move. Do not also move 043 for `views.ts:63`.

### PRD-044 settings page

Wave 1: stay `completed`. Page rows unverifiable. Code: CONFIRM stay `completed`.

`src/dashboard/web/pages/settings.tsx` and `wire.ts` are absent. Auth status, secret write, and `recallMode` persist paths that wave 1 marked met stay met. Do not move 044 because the SPA left. The vault provider/model/pollinating panel is PRD-032, already confirmed as its own move. The index status line still says Backlog. Correct that line to completed in place.

## What wave 3 should do

- Revise the 14 frontend defects, H16's attribution, notifications defects 10-15, and ROI defects 16-17. Leave the confirmed holds.
- `git mv` these folders from `completed/` to `in-work/` and set their index status lines to in-work: `prd-029-degradation-observability`, `prd-032-encrypted-vault`, `prd-035-dashboard-data-fixes`, `prd-039-harnesses-page`, `prd-042-sync-page`.
- Leave these folders in `completed/`: `prd-024-dashboard-ui-parity`, `prd-027-recall-ranking-and-eval`, `prd-036-skill-asset-discovery`, `prd-037-dashboard-nav-shell`, `prd-038-dashboard-home`, `prd-040-memories-page`, `prd-041-graph-page`, `prd-043-logs-page`, `prd-044-settings-page`. Where an index or child still says Backlog or Draft, correct the status line only.
- Do not archive PRD-024.

Folder names above follow the wave-1 report paths. If a directory name differs by a suffix, move the directory that contains that PRD's index. Do not move a folder whose number is not in the confirmed-move list.

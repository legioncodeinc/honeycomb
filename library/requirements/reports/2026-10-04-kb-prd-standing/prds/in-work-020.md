# PRD-020 surfaces standing

- Shard: Wave 1b, `library/requirements/in-work/prd-020-surfaces/` only
- Date: 2026-10-04
- Commit context: `756bacb` moved this folder from `completed/` to `in-work/`. Re-checked against current source. The move matches the tree.
- Sources read: the index, 020a, 020b, 020c, 020d, and the 2026-06-18 QA and security notes. Verdicts below ignore the QA scorecard (it marked 27/27 verified). Grounding trees: `src/cli`, `src/commands` (the dispatcher the CLI entry calls), `src/dashboard`, `harnesses/cursor`, `src/notifications`, plus the daemon handlers those surfaces call (`src/daemon/runtime/dashboard/api.ts`, `src/daemon/runtime/codebase/api.ts`, `src/daemon/runtime/sessions/prune.ts`, `src/daemon/runtime/assemble.ts`, `src/daemon/runtime/auth/`). Build outputs and `node_modules` were not used.
- Criteria: 27. MET: 13. UNMET: 14. UNVERIFIABLE: 0.

## Recommended bucket

Keep `in-work/`. Do not move to `completed/`. Do not move to `backlog/` or `archive/`.

The CLI storage verbs, paired session prune, skill scope, dashboard view builders, and the daemon JSON for those views are present and reached from live entry points. The Cursor extension (020c) is a tested seam shell: `harnesses/cursor/extension/` has TypeScript and no `package.json`, `esbuild.config.mjs` bundles only the hook at `harnesses/cursor/src/index.ts`, and nothing in the repo calls `activate()` except tests. All six 020c criteria are unmet. Live `honeycomb status` does not run the D1-D5 check or the org-drift re-mint. Session-start `healDriftedOrgToken` is an empty function. Login writes `~/.deeplake/credentials.json`, which is not the path 020a AC-5 names. Transient notification claims are never released, so the next session cannot re-emit.

Child status lines still say Draft (`prd-020a` line 4, `prd-020b` line 4, `prd-020c` line 4, `prd-020d` line 4) while the index says In Work (line 3). That is doc drift, not a bucket change.

## Index

File: `library/requirements/in-work/prd-020-surfaces/prd-020-surfaces-index.md`

### Index AC-1

- Quote: "Given the unified CLI, when any storage-touching command runs (recall, sessions prune, graph, etc.), then it issues a daemon request and never opens DeepLake directly."
- PRD: `prd-020-surfaces-index.md:48`
- Verdict: MET
- Source: `src/cli/index.ts:32-39` builds the dispatcher and `buildRuntimeDeps()`. `src/commands/dispatch.ts:511` sends storage verbs to `dispatchStorage`. `src/commands/storage-handlers.ts:387` calls `deps.daemon.send`. `src/commands/sessions.ts:97` does the same for prune. A search of `src/cli` and `src/commands` finds no import of `src/daemon/storage`. `src/commands/install.ts` imports the auth HTTP issuer (`daemon/runtime/auth/deeplake-issuer.js`), which is not the DeepLake storage client.

### Index AC-2

- Quote: "Given the daemon is running, when a user opens the dashboard, then it renders KPIs, sessions, settings, graph, and skill-sync state served by the daemon."
- PRD: `prd-020-surfaces-index.md:49`
- Verdict: UNMET
- Source: The view tree is built, then thrown away. `src/cli/runtime.ts:728-729` calls `launchDashboard` and returns only `rendered.connectivity.reachable`. `src/commands/local-handlers.ts:238-242` prints "launched" or "daemon is not reachable". `src/dashboard/html.ts:88` (`renderDashboardPage`) has no production caller; the only caller is `tests/dashboard/html.test.ts`. Daemon JSON for the panels is live (`src/daemon/runtime/assemble.ts:1407` mounts `mountDashboardApi`; routes in `src/daemon/runtime/dashboard/api.ts:1314`, `:1355`, `:1374`, `:1408`, `:1421`; graph at `src/daemon/runtime/codebase/api.ts:341`). The operator open path does not present those panels. `src/dashboard/launch.ts:167-172` points a separate `openDashboard` helper at a hive portal on port 3853; that helper is not what `honeycomb dashboard` calls, and the hive UI is not in this repo.

### Index AC-3

- Quote: "Given a missing prerequisite (daemon down, logged out, hooks unwired), when the health check runs, then the failing dimension (D1-D5) is surfaced and auto-wiring resolves the wirable ones idempotently."
- PRD: `prd-020-surfaces-index.md:50`
- Verdict: UNMET
- Source: The engine exists at `src/notifications/health.ts:110-127` and the probes exist at `src/cli/health-probes.ts:147-167`. `src/cli/runtime.ts:767` binds `health: buildStatusHealthSource(daemon)`, but `src/commands/dispatch.ts:412-418` routes `status` to `runStandardCommand`, which prints service installation, process, and `/health` (`src/commands/standard-interface.ts:78-101`, `:206-220`) and never calls `deps.health.evaluate()` or `autoWire()`. A search of `src/` finds no production call to `HealthCheck.autoWire`. The harness reconciler does call `createAutoWiring().wire()` (`src/cli/harness-reconcile.ts:289`) but does not surface D1-D5.

## 020a CLI

File: `library/requirements/in-work/prd-020-surfaces/prd-020a-surfaces-cli.md`

### a-AC-1

- Quote: "Given any top-level command, when it dispatches, then the entry point parses global flags and routes to the matching handler, with org/workspace verbs passed through to the auth dispatcher."
- PRD: `prd-020a-surfaces-cli.md:50`
- Verdict: MET
- Source: `src/cli/index.ts:34-39`. `src/commands/dispatch.ts:74-95` parses `--help`, `--version`, `--json`, `--dry-run`, `--no-color`. `src/commands/dispatch.ts:485-492` forwards `AUTH_SUBCOMMANDS` with the full argv. The set is `org`, `workspace`, `workspaces`, `project`, `whoami`, `login`, `logout` at `src/commands/contracts.ts:265-273`. `src/cli/runtime.ts:504-530` routes those verbs to `authMain`, `whoamiMain`, `projectMain`, and `orgMain`.

### a-AC-2

- Quote: "Given `honeycomb sessions prune --before <date>`, when it runs, then the daemon deletes matching `sessions` rows and the paired `memory` summaries so traces and summaries never desync."
- PRD: `prd-020a-surfaces-cli.md:51`
- Verdict: MET
- Source: `src/commands/sessions.ts:47-81` parses `--before` and `--session-id` and builds `DELETE /api/diagnostics/sessions/prune`. `src/commands/sessions.ts:97` sends it through the daemon client. `src/daemon/runtime/assemble.ts:1419-1427` attaches the handler. `src/daemon/runtime/sessions/prune.ts:302-322` appends a paired `sessions` tombstone and a paired `memory` summary tombstone for every match (`TOMBSTONE_MARKER` at line 74). That is the product delete: DeepLake hard DELETE is not used. The pairing the criterion requires is in that loop.

### a-AC-3

- Quote: "Given any storage-touching command, when it runs, then it issues a daemon request and never opens DeepLake directly."
- PRD: `prd-020a-surfaces-cli.md:52`
- Verdict: MET
- Source: Same path as index AC-1. `src/commands/contracts.ts:244-246` marks `cls: "storage"`. `src/commands/dispatch.ts:342-389` routes `sessions`, `pollinate`, `maintenance`, `capture`, `memory`, `settings`, `asset`, and the generic storage verbs through daemon handlers. `src/commands/storage-handlers.ts:36-45` lists the daemon routes.

### a-AC-4

- Quote: "Given a drifted org token on session start, when `healDriftedOrgToken` runs, then it re-mints a token whose `org_id` claim matches the active org."
- PRD: `prd-020a-surfaces-cli.md:53`
- Verdict: UNMET
- Source: The session-start seam is empty. `src/hooks/shared/session-start.ts:188` calls `seams.healDriftedOrgToken`, and the production factory sets that to `async healDriftedOrgToken(): Promise<void> {}` at `src/hooks/shared/session-start-seams.ts:123`. `healOrgDrift` can re-mint (`src/daemon/runtime/auth/device-flow.ts:222-229`) and `runStatusCommand` would call a healer (`src/commands/status.ts:127-131`), but dispatch never calls `runStatusCommand` (`src/commands/dispatch.ts:412-418`). The healer that `buildRuntimeDeps` does bind refuses to re-mint a real `api.deeplake.ai` credential and returns `drift-surfaced` (`src/cli/runtime.ts:564-574`).

### a-AC-5

- Quote: "Given `honeycomb login` on a headless box, when it runs, then the device flow completes and credentials are written to `~/.honeycomb/credentials.json` at `0600`."
- PRD: `prd-020a-surfaces-cli.md:54`
- Verdict: UNMET
- Source: Device flow and mode `0600` exist. The write path does not. `src/daemon/runtime/auth/deeplake-issuer.ts:815-821` runs the device flow and persists `~/.deeplake/credentials.json`. `src/daemon/runtime/auth/credentials-store.ts:66` sets `CREDENTIALS_DIR_NAME = ".deeplake"`. `src/daemon/runtime/auth/credentials-store.ts:71` keeps `.honeycomb` as a read-only legacy fallback. `src/daemon/runtime/auth/credentials-store.ts:127` sets `FILE_MODE = 0o600`, applied in `saveDiskCredentials` at line 541. `src/cli/auth.ts:301-302` documents the shared deeplake path. The criterion's path `~/.honeycomb/credentials.json` is not the write target.

### a-AC-6

- Quote: "Given `honeycomb skill scope team --users alice,bob`, when it runs, then the skillify scope is updated through the daemon."
- PRD: `prd-020a-surfaces-cli.md:55`
- Verdict: MET
- Source: `src/commands/storage-handlers.ts:99-106` maps `skill scope <scope> --users a,b` to `POST /api/skills/scope` with `{ scope, users, force }`. `src/commands/storage-handlers.ts:215` routes `skill` through `buildSkillRequest`. `src/commands/storage-handlers.ts:387` sends that request on the daemon client.

## 020b dashboard

File: `library/requirements/in-work/prd-020-surfaces/prd-020b-surfaces-dashboard.md`

The view builders and the daemon JSON are live. The CLI open path does not paint the tree (index AC-2). Criteria that the builders and the daemon endpoints implement are MET. The webview criterion is UNMET because no production webview calls them.

### b-AC-1

- Quote: "Given the daemon is running, when the dashboard loads, then it renders KPIs, sessions, settings, graph, rules, and skill-sync state from daemon-served data."
- PRD: `prd-020b-surfaces-dashboard.md:48`
- Verdict: UNMET
- Source: `launchDashboard` prints launch or reachability output. It does not render the six views. `src/cli/runtime.ts:728` calls it from `honeycomb dashboard`. The view builders in `src/dashboard/dashboard.ts:72-80` exist, and the daemon routes are mounted, but this criterion is the dashboard load the CLI verb performs.

### b-AC-2

- Quote: "Given the daemon is unreachable, when the dashboard opens, then it surfaces a clear connectivity state rather than failing silently or hanging."
- PRD: `prd-020b-surfaces-dashboard.md:49`
- Verdict: MET
- Source: `src/dashboard/dashboard.ts:66-70` returns the connectivity banner alone and does not call `fetchAll`. `src/dashboard/dashboard.ts:51-56` includes the daemon URL and "Retry: ensure the daemon is running, then reload." `src/dashboard/launch.ts:90-102` aborts the `/health` probe on timeout (default 1500 ms at line 88). `src/commands/local-handlers.ts:239-242` prints the daemon-down line on the CLI verb.

### b-AC-3

- Quote: "Given a workspace with a built codebase graph, when the graph view opens, then the graph canvas renders from the daemon's graph endpoints."
- PRD: `prd-020b-surfaces-dashboard.md:50`
- Verdict: MET
- Source: `src/dashboard/views.ts:130-140` emits `kind: "graph-canvas"` with nodes and edges when `view.built` is true. `src/dashboard/launch.ts:120` reads `GET /api/graph`. `src/daemon/runtime/codebase/api.ts:335-347` is the single owner of that GET and returns `{ built, nodes, edges }` from the local snapshot.

### b-AC-4

- Quote: "Given org-wide rules exist, when the rules view opens, then it lists the active rules from the daemon."
- PRD: `prd-020b-surfaces-dashboard.md:51`
- Verdict: MET
- Source: `src/dashboard/views.ts:143-146` lists each rule with an active marker. `src/daemon/runtime/dashboard/api.ts:665-678` reads the `rules` table and sets `active` from `status === "active"`. `src/daemon/runtime/dashboard/api.ts:1408-1412` serves `GET /api/diagnostics/rules`. The functional requirement names a `honeycomb_rules` table (`prd-020b-surfaces-dashboard.md:39`); the live query uses `rules`. The acceptance criterion asks for the daemon's active rules, which this path returns.

### b-AC-5

- Quote: "Given the Cursor extension webview, when it embeds the dashboard, then it renders the same views from the same daemon data contract."
- PRD: `prd-020b-surfaces-dashboard.md:52`
- Verdict: UNMET
- Source: The embed helper exists and is uncalled in production. `harnesses/cursor/extension/bindings.ts:90-96` calls `renderDashboard` and `renderDashboardHtml`. `harnesses/cursor/extension/render.ts:55-62` serializes that same `ViewBlock` tree. No production module calls `activate` or `dashboardWebviewRenderer`. Callers are `tests/cursor-extension/extension.test.ts` only. Extension packaging is ABSENT (see c-AC-1).

### b-AC-6

- Quote: "Given no graph has been built, when the graph view opens, then it shows an empty-state prompt to run `honeycomb graph build` rather than an error."
- PRD: `prd-020b-surfaces-dashboard.md:53`
- Verdict: MET
- Source: `src/dashboard/views.ts:57` defines `GRAPH_BUILD_PROMPT` as `Run \`honeycomb graph build\` to build the codebase graph.` `src/dashboard/views.ts:131-132` returns `kind: "empty-state"` with that row when `built` is false. `src/daemon/runtime/codebase/api.ts:346` returns `{ built: false, nodes: [], edges: [] }` with HTTP 200 when no snapshot exists.

## 020c Cursor extension

File: `library/requirements/in-work/prd-020-surfaces/prd-020c-surfaces-cursor-extension.md`

The shell compiles and tests inject seams. A Cursor user cannot activate it from this checkout. `harnesses/cursor/extension/` contains `extension.ts`, `bindings.ts`, `render.ts`, `contracts.ts`, `index.ts`, and `CONVENTIONS.md`. Glob of `harnesses/cursor/**/package.json` returned no files. `esbuild.config.mjs:181-183` bundles `dist/harnesses/cursor/src/index.js` into `harnesses/cursor/bundle` (the hook), not the extension. `harnesses/cursor/extension/CONVENTIONS.md:91-106` records the vscode host, the production login binding, and the extension manifest as deferred. The index reopen note at `prd-020-surfaces-index.md:13-14` still matches the tree.

### c-AC-1

- Quote: "Given the extension is active, when the user runs Wire / Refresh Hooks, then `harnesses/cursor/bundle/` is copied to `~/.cursor/honeycomb/bundle/` and `~/.cursor/hooks.json` is merged idempotently."
- PRD: `prd-020c-surfaces-cursor-extension.md:48`
- Verdict: UNMET
- Source: `harnesses/cursor/extension/extension.ts:117-121` registers `honeycomb.wireHooks` and calls `deps.hooks.wire()`. `harnesses/cursor/extension/bindings.ts:48-52` maps that to `connector.install()`. `src/connectors/cursor.ts:100-118` targets `~/.cursor/hooks.json` and `<pluginRoot>/bundle/<file>` with sources under `bundleSource`. `src/connectors/contracts.ts:345-364` copies handler bytes and calls `writeJsonIfChanged`. That connector runs from CLI `setup` / `connect`, not from an activatable extension. Production `activate(host, deps)` wiring is ABSENT. No vscode `ExtensionHost` implementation is in the tree (`harnesses/cursor/extension/extension.ts:24-25`).

### c-AC-2

- Quote: "Given the extension activates, when it syncs skills, then symlinks are created into `~/.cursor/skills-cursor/` and `<project>/.cursor/skills/` without clobbering existing entries."
- PRD: `prd-020c-surfaces-cursor-extension.md:49`
- Verdict: UNMET
- Source: No-clobber exists at `src/connectors/contracts.ts:473-495` (foreign symlink or real file is left in place). The destinations the criterion names are ABSENT. `src/connectors/cursor.ts:122-125` links only into `~/.cursor/skills/`. There is no `skills-cursor` path and no `<project>/.cursor/skills/` target in the Cursor connector. `harnesses/cursor/extension/extension.ts:139-149` would call `deps.skills.sync()`, which is `connector.install()` skill links (`harnesses/cursor/extension/bindings.ts:74-79`), and the extension is not activatable.

### c-AC-3

- Quote: "Given a config with foreign hooks, when Wire / Refresh Hooks runs, then foreign hooks are preserved and only Honeycomb entries are added or updated."
- PRD: `prd-020c-surfaces-cursor-extension.md:50`
- Verdict: UNMET
- Source: Preserve logic is in the connector, not in a live extension command. `src/connectors/cursor.ts:173-188` keeps entries that fail `isHoneycombEntry` and appends Honeycomb entries. `src/connectors/contracts.ts:295-305` treats the `_honeycomb` sentinel and a `/honeycomb/bundle/` command path as Honeycomb. The extension command that the criterion names is not activatable (c-AC-1). CLI `setup` can run the same connector; that is not Wire / Refresh Hooks.

### c-AC-4

- Quote: "Given the status bar is shown, when health is evaluated, then D1-D5 states render and a failing dimension is visibly flagged."
- PRD: `prd-020c-surfaces-cursor-extension.md:51`
- Verdict: UNMET
- Source: `harnesses/cursor/extension/render.ts:95-105` paints one glyph per dimension and the word `FAILING` in the tooltip. `harnesses/cursor/extension/extension.ts:100-105` would apply that to a status-bar seam. A real editor status bar is ABSENT: the host is injected, and `createFakeExtensionHost` is the in-tree host (`harnesses/cursor/extension/contracts.ts:16-22`).

### c-AC-5

- Quote: "Given the user logs in via the extension, when login completes, then credentials are written to the shared `~/.honeycomb/credentials.json`."
- PRD: `prd-020c-surfaces-cursor-extension.md:52`
- Verdict: UNMET
- Source: Production `LoginFlow` is ABSENT. `harnesses/cursor/extension/contracts.ts:240-242` says the real device-flow binding is deferred. The only implementation is `createFakeLoginFlow` at `harnesses/cursor/extension/contracts.ts:285`, which writes whatever path a test passes. `harnesses/cursor/extension/extension.ts:124-129` calls `deps.login.login` and opens a verification URL when the seam returns one. The live CLI login writes `~/.deeplake/credentials.json` (a-AC-5), not this extension path.

### c-AC-6

- Quote: "Given the dashboard webview opens, when the daemon is running, then it renders the same KPI, sessions, settings, graph, rules, and skill-sync views as the daemon-served dashboard."
- PRD: `prd-020c-surfaces-cursor-extension.md:53`
- Verdict: UNMET
- Source: Same embed helper as b-AC-5 (`harnesses/cursor/extension/bindings.ts:90-96`, `harnesses/cursor/extension/render.ts:49-62`). A reachable `renderDashboard` result includes the six titles (`src/dashboard/dashboard.ts:73-79`). No production webview opens. Extension packaging is ABSENT.

## 020d notifications and health

File: `library/requirements/in-work/prd-020-surfaces/prd-020d-surfaces-notifications-health.md`

The session-start drain, claim lock, show-once state, 1.5s timeout, and idempotent hook write are in live code. The D1-D5 health check is not on the live status path, and transient re-emit is blocked by a claim that nothing releases.

### d-AC-1

- Quote: "Given two hook processes race on session start, when both try to emit the same notification, then an atomic claim lock ensures exactly one banner is shown."
- PRD: `prd-020d-surfaces-notifications-health.md:48`
- Verdict: MET
- Source: `src/notifications/state.ts:118-128` uses `openSync(path, "wx")` and treats `EEXIST` as a lost race. `src/notifications/pipeline.ts:186-191` suppresses the loser. `src/hooks/runtime.ts:374` drains that pipeline on `session-start` via `drainNotificationsSoft` (`src/hooks/runtime.ts:407-412`), built with `createClaimLock()` at `src/hooks/runtime.ts:424`.

### d-AC-2

- Quote: "Given the health check runs, when a dimension (D1 CLI, D2 daemon, D3 cursor-agent, D4 login, D5 hooks) fails, then it is surfaced and the wirable dimensions are auto-resolved without overwriting foreign hooks."
- PRD: `prd-020d-surfaces-notifications-health.md:49`
- Verdict: UNMET
- Source: `src/notifications/health.ts:100-126` evaluates D1-D5 and calls `autoWiring.wire()` only when a wirable dimension fails. `src/notifications/contracts.ts:67-72` marks only D5 wirable. `src/notifications/auto-wiring.ts:38-42` delegates to `connector.install()`, which filters with `isHoneycombEntry` (`src/connectors/contracts.ts:295`). No production caller invokes `autoWire` or prints these five dimensions. Live `honeycomb status` uses `src/commands/standard-interface.ts:206-220`. `src/cli/health-probes.ts:187-195` also binds auto-wiring to `ClaudeCodeConnector`, not the Cursor connector, if that check were called.

### d-AC-3

- Quote: "Given a backend fetch hangs, when session start drains notifications, then the fetch times out near 1.5s and the session proceeds without visible latency."
- PRD: `prd-020d-surfaces-notifications-health.md:50`
- Verdict: MET
- Source: `src/notifications/pipeline.ts:33` sets `DEFAULT_PIPELINE_TIMEOUT_MS = 1500`. `src/notifications/pipeline.ts:87-105` resolves a hang or rejection to the fallback and does not reject. `src/notifications/pipeline.ts:157-161` applies that bound to the rules, queue, and backend fetches in parallel. `src/hooks/runtime.ts:374` and `:407-412` swallow a drain failure so session start continues. The backend GET is `src/hooks/runtime.ts:435-447` against `/api/diagnostics/notifications`, mounted at `src/daemon/runtime/assemble.ts:1416-1417`.

### d-AC-4

- Quote: "Given a persistent welcome notification already shown, when a later session starts, then it is not shown again."
- PRD: `prd-020d-surfaces-notifications-health.md:51`
- Verdict: MET
- Source: `src/notifications/pipeline.ts:166-175` drops a persistent notification whose `dedupKey` is already in state. `src/notifications/pipeline.ts:201-206` records the chosen persistent banner. `src/notifications/state.ts:216-229` persists that record with a temp file plus `rename`. The live drain uses `createNotificationsState()` (`src/hooks/runtime.ts:423`). State now lives under `honeycombStateDir()` (`src/notifications/state.ts:133-135`), which is `<fleet-root>/honeycomb/` (`src/shared/fleet-root.ts:103-104`), with a read fallback to the legacy `~/.honeycomb/notifications-state.json` (`src/notifications/state.ts:201-205`). Show-once behavior is implemented. The old home path in `src/notifications/contracts.ts:14` is stale.

### d-AC-5

- Quote: "Given a transient warning whose cause persists, when the next session starts, then the warning re-emits."
- PRD: `prd-020d-surfaces-notifications-health.md:52`
- Verdict: UNMET
- Source: A transient is not written to show-once state (`src/notifications/pipeline.ts:199-200`), which is the right half. The claim file is never released. `src/notifications/pipeline.ts:178-184` says a later session re-claims a released key, and line 200 says "No claim is released here." A search of `src/notifications` and `src/hooks` finds no call to the notification `ClaimLock.release` after a drain. The next session's `lock.claim` hits the existing `wx` file and the banner is suppressed (`src/notifications/pipeline.ts:186-191`). `src/hooks/shared/session-end.ts:133` releases a different lock (the summary session id), not the notification claim.

### d-AC-6

- Quote: "Given an unchanged hook configuration, when auto-wiring re-runs, then no file is written and the hook-trust fingerprint is unchanged."
- PRD: `prd-020d-surfaces-notifications-health.md:53`
- Verdict: MET
- Source: `src/connectors/contracts.ts:314-319` compares serialized JSON and returns false without writing when the bytes match. `src/notifications/auto-wiring.ts:40-42` returns that `wroteConfig` flag. The live reconciler calls `wiring.wire()` at `src/cli/harness-reconcile.ts:289`, and `buildConnectorWiring` wraps the real connector in `createAutoWiring` at `src/cli/harness-reconcile.ts:164-168`. Handler file copies in `install()` (`src/connectors/contracts.ts:351-357`) still rewrite handler bytes when the source is readable; the criterion's fingerprint is the hook config file, which `writeJsonIfChanged` skips when unchanged.

## Scorecard

| ID | Verdict | Proof |
|---|---|---|
| Index AC-1 | MET | `src/commands/dispatch.ts:511`, `src/commands/storage-handlers.ts:387` |
| Index AC-2 | UNMET | `src/cli/runtime.ts:728-729` discards the view tree; HTML renderer has no production caller |
| Index AC-3 | UNMET | D1-D5 engine unused; `src/commands/dispatch.ts:412-418` |
| a-AC-1 | MET | `src/commands/dispatch.ts:74-95`, `:485-492` |
| a-AC-2 | MET | `src/daemon/runtime/sessions/prune.ts:302-322` |
| a-AC-3 | MET | `src/commands/dispatch.ts:342-389` |
| a-AC-4 | UNMET | `src/hooks/shared/session-start-seams.ts:123` is a no-op |
| a-AC-5 | UNMET | writes `~/.deeplake/credentials.json` (`credentials-store.ts:66`, `:541`) |
| a-AC-6 | MET | `src/commands/storage-handlers.ts:99-106` |
| b-AC-1 | UNMET | `honeycomb dashboard` prints launch or reachability output and does not render the six views |
| b-AC-2 | MET | `src/dashboard/dashboard.ts:66-70` |
| b-AC-3 | MET | `src/dashboard/views.ts:130-140`, `codebase/api.ts:341` |
| b-AC-4 | MET | `src/daemon/runtime/dashboard/api.ts:665-678` |
| b-AC-5 | UNMET | embed helper uncalled outside tests |
| b-AC-6 | MET | `src/dashboard/views.ts:57`, `:131-132` |
| c-AC-1 | UNMET | extension manifest, esbuild entry, and vscode host ABSENT |
| c-AC-2 | UNMET | `skills-cursor` and project `.cursor/skills` ABSENT; connector uses `~/.cursor/skills/` |
| c-AC-3 | UNMET | preserve logic is CLI connector only; extension command not activatable |
| c-AC-4 | UNMET | status-bar painter has no editor host |
| c-AC-5 | UNMET | production LoginFlow ABSENT |
| c-AC-6 | UNMET | no production webview |
| d-AC-1 | MET | `src/notifications/state.ts:118-128`, `src/hooks/runtime.ts:374` |
| d-AC-2 | UNMET | `autoWire` has no production caller |
| d-AC-3 | MET | `src/notifications/pipeline.ts:33`, `:87-105` |
| d-AC-4 | MET | `src/notifications/pipeline.ts:166-175`, `:201-206` |
| d-AC-5 | UNMET | claim `release` never called after drain |
| d-AC-6 | MET | `src/connectors/contracts.ts:314-319`, `src/cli/harness-reconcile.ts:289` |

Unmet count: 13.

Report path: `library/requirements/reports/2026-10-04-kb-prd-standing/prds/in-work-020.md`

# Architecture narratives standing (Wave 1a)

Date: 2026-10-04
Shard: markdown files directly under `library/knowledge/private/architecture/`. `architecture/adr/` is out of scope.
Branch: `legion/kb-sotu-and-prd-lifecycle`
Mode: read-only. This file is the only write.

Grounding corpus: `src/shared/constants.ts`, `src/shared/fleet-root.ts`, `src/daemon/runtime/server.ts`, `src/cli`, `src/commands`, `src/daemon-client`, `package.json`, `esbuild.config.mjs`. Named paths outside that set were opened when a sentence cited them. `node_modules` and build outputs were skipped. `@legioncodeinc/cli-kit` is not present in this tree, so help-banner claims are grounded in `src/commands/dispatch.ts` and `tests/commands/dispatch.test.ts`.

## Coverage

Seven files. None should be removed. No eighth architecture narrative is required. Every page action below is REVISE. ADD and REMOVE in the defect list are edits inside those pages.

| File | Lines | Page action |
|---|---|---|
| `library/knowledge/private/architecture/load-bearing-boundaries.md` | 90 | REVISE |
| `library/knowledge/private/architecture/system-overview.md` | 107 | REVISE |
| `library/knowledge/private/architecture/daemon-surface.md` | 102 | REVISE |
| `library/knowledge/private/architecture/cli-dispatcher.md` | 84 | REVISE |
| `library/knowledge/private/architecture/request-lifecycle.md` | 96 | REVISE |
| `library/knowledge/private/architecture/projects-onboarding-and-lifecycle.md` | 188 | REVISE |
| `library/knowledge/private/architecture/multi-project-and-context-switching.md` | 148 | REVISE |

Sibling links that resolve: `system-overview.md`, `daemon-surface.md`, `request-lifecycle.md`, `cli-dispatcher.md`, `load-bearing-boundaries.md`, `projects-onboarding-and-lifecycle.md`, `multi-project-and-context-switching.md`, and the `../ai`, `../data`, `../operations`, `../frontend`, `../integrations`, `../auth`, `../security`, `../multi-tenant`, `../collaboration`, `../standards` targets named in the Related lists. `adr/0006`, `adr/0007`, and `adr/0010` exist. `src/daemon/runtime/dashboard/host.ts` does not (`ABSENT`).

## Defects

### D01

- Quote: "Wave-2 services (queue, file watcher, runtime path) are fields on `options.services`, each defaulting to a no-op stub (`src/daemon/runtime/server.ts:169-170`). `src/daemon/runtime/CONVENTIONS.md:10-14` tells a later service author to pass the real implementation into `createDaemon({ services })` and not to edit `server.ts`, `index.ts`, `config.ts`, `logger.ts`, or the permission middleware to register it."
- Doc: `library/knowledge/private/architecture/load-bearing-boundaries.md:67`
- Grounding: `src/daemon/runtime/server.ts:113-132` and `src/daemon/runtime/server.ts:233-238` (`embed` and `telemetry` are also `DaemonServices` fields and default to `noopEmbedSupervisor` and `noopTelemetryService`). `src/daemon/runtime/server.ts:169-170` is only the options-field comment. `src/daemon/runtime/CONVENTIONS.md:100` also says do not edit `services/types.ts`.
- Verdict: HOLE
- Action: ADD

### D02

- Quote: "4, clients | `harnesses/*/src`, `mcp/src`, `src/cli` | tier 1 (`daemon-client` and `shared`)"
- Doc: `library/knowledge/private/architecture/load-bearing-boundaries.md:50`
- Grounding: `esbuild.config.mjs:321-338` bundles `src/sdk` as four entries. `package.json:17-21` exports `.`, `/react`, `/vercel`, `/openai`. `src/hooks/shared/daemon-client.ts:31` and `src/dashboard/launch.ts:173` are additional client roots. The next paragraph (`load-bearing-boundaries.md:53`) names `src/commands` and `src/cli` upward imports, and those imports exist (`src/commands/install.ts:46-57`, `src/cli/runtime.ts:55-57`). The table still omits `src/sdk`, `src/hooks`, `src/dashboard`, `src/connectors`, and `src/commands` as roots.
- Verdict: HOLE
- Action: ADD

### D03

- Quote: "No module in `src/daemon` calls `group("/")` to attach a page to it."
- Doc: `library/knowledge/private/architecture/load-bearing-boundaries.md:81`
- Grounding: `src/daemon/runtime/server.ts:105` scaffolds `{ path: "/", protect: false }`. `src/daemon/runtime/dashboard/setup-login.ts:40` and `src/daemon/runtime/dashboard/setup-login.ts:115` call `daemon.group("/")` and mount `POST /setup/login`. The same root group constant is `"/"` in `src/daemon/runtime/dashboard/setup-state.ts:61`, `src/daemon/runtime/dashboard/setup-tenancy.ts:71`, and `src/daemon/runtime/dashboard/setup-migrate.ts:68`. `src/daemon/runtime/dashboard/host.ts` is ABSENT, so no dashboard page is attached. The sentence does not say that `/setup/*` is mounted on that group.
- Verdict: HOLE
- Action: ADD

### D04

- Quote: "Desktop"
- Doc: `library/knowledge/private/architecture/system-overview.md:33`
- Grounding: ABSENT. `package.json:13-51` files list and `esbuild.config.mjs:164-400` entry list have daemon, five hook harnesses, OpenClaw, MCP, SDK, CLI, and embed daemon. No desktop target.
- Verdict: FALSE
- Action: REMOVE

### D05

- Quote: "CLI | `honeycomb` | Install, setup, status, recall, agents, ontology, sources, skills, assets, org/workspace/project."
- Doc: `library/knowledge/private/architecture/system-overview.md:82`
- Grounding: `src/commands/contracts.ts:104-237` (`VERB_TABLE`). Verb words include `remember`, `recall`, `memory`, `sessions`, `pollinate`, `maintenance`, `capture`, `skill`, `skillify`, `asset`, `ontology`, `graph`, `sources`, `goal`, `agent`, `route`, `secret`, `settings`, `login`, `logout`, `whoami`, `org`, `workspace`, `workspaces`, `project`, `setup`, `install`, `status`, `daemon`, `dashboard`, `hook`, `harness`, plus the service baseline (`start`, `stop`, `restart`, `logs`, `service-install`, `service-uninstall`, `register`, `telemetry`, `update`, `uninstall`). Related links at `system-overview.md:6-15` do not include `cli-dispatcher.md`.
- Verdict: HOLE
- Action: ADD

### D06

- Quote: "Local coordination files (the SQLite queue, telemetry, pid, and the fleet registry) live under `~/.apiary`, with a legacy `~/.honeycomb` fallback (`src/shared/fleet-root.ts`)."
- Doc: `library/knowledge/private/architecture/system-overview.md:97`
- Grounding: `src/shared/fleet-root.ts:10-16` and `src/shared/fleet-root.ts:78-105`. Precedence is `APIARY_HOME`, else `$XDG_STATE_HOME/apiary` on Linux when that variable is absolute, else `~/.apiary`. Product state is `<fleetRoot>/honeycomb` (`honeycombStateDir`). The queue file is `<fleetRoot>/honeycomb/.daemon/local-queue.db` (`src/daemon/runtime/services/local-job-queue.ts:23` and `src/daemon/runtime/services/local-job-queue.ts:315`). The fleet registry is `<fleetRoot>/registry.json` (`src/cli/standard-ops.ts:205`). Legacy fallback is `legacyHoneycombDir` at `src/shared/fleet-root.ts:144-146`.
- Verdict: HOLE
- Action: ADD

### D07

- Quote: "Getting in is one command. The installer detects and sets up a Node runtime, installs the global package, brings the daemon up, and lands the user on the dashboard, with the DeepLake login driven from the UI rather than the terminal."
- Doc: `library/knowledge/private/architecture/system-overview.md:71`
- Grounding: `src/commands/install.ts:6-31`. Shell scripts own Node detection and `npm i -g`. The `honeycomb install` verb ensures the daemon and, in fleet mode, opens no browser. Solo mode opens `http://127.0.0.1:3853/` only when that portal answers.
- Verdict: STALE
- Action: REVISE

### D08

- Quote: "`ROUTE_GROUPS` also scaffolds a `/` group, and no module under `src/daemon` calls `group("/")` to attach a page there."
- Doc: `library/knowledge/private/architecture/daemon-surface.md:19`
- Grounding: same as D03. `src/daemon/runtime/dashboard/setup-login.ts:115` calls `daemon.group("/")`.
- Verdict: HOLE
- Action: ADD

### D09

- Quote: "`/` | Dashboard static assets | none"
- Doc: `library/knowledge/private/architecture/daemon-surface.md:45`
- Grounding: `src/daemon/runtime/server.ts:105` scaffolds `/` with `protect: false`. `src/daemon/runtime/dashboard/host.ts` is ABSENT. `src/dashboard/launch.ts:149-178` opens the Hive portal at `HIVE_PORT` (`3853`), not a daemon static tree. `src/commands/install.ts:64-74` returns `http://127.0.0.1:3853/`.
- Verdict: FALSE
- Action: REVISE

### D10

- Quote: "`/api/hooks/*` | session-start, user-prompt-submit, pre-compaction, compaction-complete, session-end, synthesis | remember/recall"
- Doc: `library/knowledge/private/architecture/daemon-surface.md:32`
- Grounding: mounted hook routes are `POST /api/hooks/capture` (`src/daemon/runtime/capture/capture-handler.ts:103` and `src/daemon/runtime/capture/capture-handler.ts:281`), `GET /api/hooks/conversation` (`src/daemon/runtime/capture/capture-handler.ts:105`), `POST /api/hooks/context` (`src/daemon/runtime/capture/attach.ts:55` and `src/daemon/runtime/capture/attach.ts:204`), and `POST /api/hooks/session-end` (`src/daemon/runtime/capture/attach.ts:57`). `user-prompt-submit` recall is `POST /api/memories/recall` (`src/hooks/shared/recall-renderer.ts:48`). `pre-compaction` and `compaction-complete` are ABSENT under `src/`. Synthesis is a daemon worker (`src/daemon/runtime/summaries/synthesis.ts`), not an `/api/hooks` route.
- Verdict: STALE
- Action: REVISE

### D11

- Quote: the route-group table has no `/api/settings` row.
- Doc: `library/knowledge/private/architecture/daemon-surface.md:26-45`
- Grounding: `src/daemon/runtime/server.ts:87` scaffolds `/api/settings`. `src/daemon/runtime/vault/api.ts:9-11` mounts `GET /api/settings`, `GET /api/settings/:key`, and `POST /api/settings/:key`. `src/commands/settings.ts:50-51` dispatches the `settings` verb there.
- Verdict: HOLE
- Action: ADD

### D12

- Quote: "`/api/diagnostics`, `/api/pipeline/*`, `/api/repair/*` | Health report, pipeline stats, operator repair | diagnostics/operator"
- Doc: `library/knowledge/private/architecture/daemon-surface.md:41`
- Grounding: `src/daemon/runtime/auth/rbac.ts:23-27` says the frozen roles are `admin | member | readonly | agent` and that `operator` was reconciled to `member`. `src/daemon/runtime/auth/rbac.ts:135-139` classifies `/api/diagnostics`, `/api/pipeline`, and `/api/repair` as `connectorsAdmin` (admin and member), with a comment that still says "operator" only as a parenthetical.
- Verdict: STALE
- Action: REVISE

### D13

- Quote: "`usageText()` walks `VERB_GROUPS` and filters `VERB_TABLE` by each key, so it only ever renders groups that exist and every table row lands in exactly one printed section."
- Doc: `library/knowledge/private/architecture/cli-dispatcher.md:60`
- Grounding: `src/commands/dispatch.ts:126-153`. `usageText` drops a baseline set (`start`, `stop`, `restart`, `status`, `logs`, `install`, `uninstall`, `service-install`, `service-uninstall`, `update`, `register`, `telemetry`) and calls `renderProductBanner` from `@legioncodeinc/cli-kit`. It does not read `VERB_GROUPS`. `tests/commands/dispatch.test.ts:278` expects the string `Usage: honeycomb`. `tests/commands/dispatch.test.ts:299-302` expects `COMMAND_GROUPS` from cli-kit plus `Global flags`, not `Memory & recall`. The sample at `cli-dispatcher.md:64-80` (`usage: honeycomb`, section `Memory & recall`, flags `--help --version --json --dry-run`) does not match that test. `src/commands/contracts.ts:300` also defines `--no-color`. `src/commands/contracts.ts:55-61` still comments that `usageText` walks `VERB_GROUPS`; the function body does not.
- Verdict: FALSE
- Action: REVISE

### D14

- Quote: "`isStorageVerb()` proves the storage-never-DeepLake property from this one field."
- Doc: `library/knowledge/private/architecture/cli-dispatcher.md:32`
- Grounding: `src/commands/contracts.ts:245-247` returns `lookupVerb(verb)?.cls === "storage"` only. The import ban is `tests/daemon/storage/invariant.test.ts:73-84` and `tests/daemon/storage/invariant.test.ts:113`, which allows `daemon/storage/sql.ts` and fails other `daemon/storage` imports from non-daemon roots. `npm run ci` does run that test (`package.json:84` runs `npm run test`).
- Verdict: FALSE
- Action: REVISE

### D15

- Quote: "`AUTH_SUBCOMMANDS` (`org`, `workspace`, `workspaces`, `project`, `whoami`, `login`, `logout`) forwards the verb plus its full argv tail verbatim to `src/cli/org.ts` / `src/cli/auth.ts`"
- Doc: `library/knowledge/private/architecture/cli-dispatcher.md:44`
- Grounding: `src/commands/contracts.ts:265-273` matches the set. `src/cli/runtime.ts:504-529` sends `login` and `logout` to `authMain`, `whoami` to `whoamiMain` (`src/cli/whoami.ts`), `project` to `projectMain` (`src/cli/project.ts`), and `org`, `workspace`, and `workspaces` to `orgMain`.
- Verdict: STALE
- Action: REVISE

### D16

- Quote: "H->>D: POST /api/hooks/session-start (harness, agentId, sessionKey)"
- Doc: `library/knowledge/private/architecture/request-lifecycle.md:33`
- Grounding: ABSENT. No `/api/hooks/session-start` symbol under `src/`. Session-start context is `POST /api/hooks/context` (`src/hooks/shared/context-renderer.ts:17-18`, `src/daemon/runtime/capture/attach.ts:55`). The prime read later in the same page is real: `GET /api/memories/prime` at `src/daemon/runtime/memories/api.ts:1017-1024`.
- Verdict: FALSE
- Action: REVISE

### D17

- Quote: "the Memory Check Loop that tells the agent when prior context matters."
- Doc: `library/knowledge/private/architecture/request-lifecycle.md:40`
- Grounding: ABSENT. The only hit for `Memory Check Loop` is this page. The session-start constant is `RECALL_AWARENESS_NOTICE` at `src/hooks/shared/session-start.ts:69-73`, which starts "Memory recall is available on demand".
- Verdict: FALSE
- Action: REVISE

### D18

- Quote: "Every turn produces events. Each prompt, tool call, and response becomes one row in the `sessions` table through a single INSERT, never a concatenation"
- Doc: `library/knowledge/private/architecture/request-lifecycle.md:46`
- Grounding: production capture wires `boundProjectGate: true` and does not set `firstRunGate` (`src/daemon/runtime/assemble.ts:1381-1387`). An unbound cwd returns `{ ok: true, gated: true, reason: "no_bound_project", ... }` and writes nothing (`src/daemon/runtime/capture/capture-handler.ts:348-358` and `src/daemon/runtime/capture/capture-handler.ts:777-778`). When a row is accepted, batching buffers it into a multi-row append (`src/daemon/runtime/capture/capture-handler.ts:368-370`). `POST /api/hooks/capture` itself exists (`src/daemon/runtime/capture/capture-handler.ts:317`).
- Verdict: FALSE
- Action: REVISE

### D19

- Quote: "the modes (`shadowMode`, `mutationsFrozen`, `graphEnabled`, `autonomousEnabled`)"
- Doc: `library/knowledge/private/architecture/request-lifecycle.md:71`
- Grounding: `shadowMode` and `mutationsFrozen` are in `src/daemon/runtime/pipeline/controlled-writes.ts:415-422`. `graphEnabled` is in `src/daemon/runtime/pipeline/graph-persist.ts:436`. `autonomousEnabled` is ABSENT under `src/daemon`.
- Verdict: FALSE
- Action: REVISE

### D20

- Quote: "the daemon assembly wires `firstRunGate: true` for production, but a direct-construction unit test that does not exercise onboarding keeps the pre-059a behavior. On an unexpected throw the handler fails *open* (capture proceeds)"
- Doc: `library/knowledge/private/architecture/projects-onboarding-and-lifecycle.md:79`
- Grounding: `src/daemon/runtime/assemble.ts:1381-1387` sets `boundProjectGate: true` and `inboxCapture: resolveInboxCaptureEnabled()` and does not pass `firstRunGate`. `src/daemon/runtime/capture/attach.ts:99-101` says the per-session gate supersedes the one-shot first-run gate. `firstRunGateClosed` runs only when `firstRunGate === true` (`src/daemon/runtime/capture/capture-handler.ts:798`). A resolver throw on the production path returns `bound: false` and the dormancy gate then suppresses the write (`src/daemon/runtime/capture/capture-handler.ts:752-754` and `src/daemon/runtime/capture/capture-handler.ts:777-778`), which is fail-closed. The same page says the gate "is strictly the first-run zero-state" (`projects-onboarding-and-lifecycle.md:91`) and that the `__unsorted__` inbox "resumes the moment the first project is bound" (`projects-onboarding-and-lifecycle.md:91`). Production comment at `assemble.ts:1382-1384` says an unbound cwd no-ops forever unless `HONEYCOMB_INBOX_CAPTURE` is on. Tenancy can also gate with `tenancy_unconfirmed` (`capture-handler.ts:768-775`).
- Verdict: FALSE
- Action: REVISE

### D21

- Quote: "Honeycomb is paused: no project is bound to this workspace yet, so nothing is being captured. Bind a folder to start, open the Honeycomb dashboard and pick a folder, or run \"honeycomb project bind\" in the folder you want Honeycomb to remember."
- Doc: `library/knowledge/private/architecture/projects-onboarding-and-lifecycle.md:85`
- Grounding: `src/hooks/shared/session-start.ts:43-45` uses a colon after "start" (`Bind a folder to start: open`). Production notice selection is `createSessionBindNoticeGate` (`src/hooks/shared/session-start.ts:112-129`). When the workspace already has another binding, the text is `BIND_PROJECT_CWD_NOTICE` (`src/hooks/shared/session-start.ts:53-55` and `src/hooks/shared/session-start.ts:162`). The logged-out suppression at `session-start.ts:145` still holds.
- Verdict: STALE
- Action: REVISE

### D22

- Quote: "Capture must never drop a memory, a lost memory is unrecoverable, so an unresolved project defaults to the `__unsorted__` inbox. Every capture resolves from the session cwd and writes its `project_id`."
- Doc: `library/knowledge/private/architecture/multi-project-and-context-switching.md:95`
- Grounding: `src/daemon/runtime/assemble.ts:1381-1387` and `src/daemon/runtime/capture/capture-handler.ts:777-778`. Resolver still returns `__unsorted__` with `bound: false` (`src/hooks/shared/project-resolver.ts:605-608`). Production capture does not write that row unless inbox opt-in is on. The earlier line "capture is never dropped" (`multi-project-and-context-switching.md:56`) is the same claim.
- Verdict: FALSE
- Action: REVISE

### D23

- Quote: "It lives in `src/hooks/shared/project-resolver.ts` as a pure, deterministic `resolveScope({ cwd })`."
- Doc: `library/knowledge/private/architecture/multi-project-and-context-switching.md:60`
- Grounding: `resolveScope` takes `{ cwd, cache, ... }` and its own order is binding, git, then inbox (`src/hooks/shared/project-resolver.ts:564-608`). It does not read `HONEYCOMB_PROJECT_ID`. The env override is `projectIdOverride` on `resolveScopeFromDisk` (`src/hooks/shared/project-resolver.ts:682-705`), and a non-empty override returns `source: "binding"` without reading the cache. After a git miss the function returns `source: "inbox"`, not a separate path-candidate id (`src/hooks/shared/project-resolver.ts:605-608`). The mermaid at `multi-project-and-context-switching.md:72-80` draws both the env branch and a path branch on `resolveScope({ cwd })`.
- Verdict: STALE
- Action: REVISE

### D24

- Quote: "The est-savings `SUM(LENGTH(content))` is a corpus-length proxy slated to be pivoted to a recall-weighted metric per ADR-0010"
- Doc: `library/knowledge/private/architecture/multi-project-and-context-switching.md:138`
- Grounding: `library/knowledge/private/architecture/adr/0010-recall-weighted-est-savings.md:1-3` status is Accepted and the title says the corpus-length proxy is retired. Decision item 3 says `fetchEstimatedSavings` / `buildEstimatedSavingsSql` are removed (`adr/0010-recall-weighted-est-savings.md:66-67`). The SQL is still built at `src/daemon/runtime/dashboard/api.ts:347-352` and still fed into `fetchKpisView` at `src/daemon/runtime/dashboard/api.ts:262-270`. The 10s counts TTL at `src/daemon/runtime/dashboard/api.ts:1517` and the `x-honeycomb-project` / `projectWhereClause` mechanism at `src/daemon/runtime/dashboard/api.ts:363-364` still match the rest of that paragraph. `synced_assets` has no `project_id` column (`src/daemon/storage/catalog/synced-assets.ts`, no `project_id` hit).
- Verdict: STALE
- Action: REVISE

## Checked claims that hold

These were the likely leftovers on the dirty pages. Verdict HOLDS. Action LEAVE.

- Package is `@legioncodeinc/honeycomb`, AGPL-3.0-or-later, six harnesses plus CLI, MCP, and embed daemon. `package.json:1-10`. esbuild builds five hook harnesses plus OpenClaw (`esbuild.config.mjs:164-187` and `esbuild.config.mjs:253`). `load-bearing-boundaries.md:19`.
- `PRODUCT_SLUG` is `honeycomb`. `src/shared/constants.ts:34-35`. `DAEMON_PORT` 3850, `DAEMON_HOST` `127.0.0.1`, `HIVE_PORT` 3853, `HIVE_HOST` `127.0.0.1`, version fallback `0.0.0-dev`. `src/shared/constants.ts:13-32`.
- `createDaemon` does not listen. `src/daemon/runtime/server.ts:18-21` and `src/daemon/runtime/server.ts:230`. `startServices` does not bind a socket (`src/daemon/runtime/server.ts:215-216`).
- `ROUTE_GROUPS` is `src/daemon/runtime/server.ts:68-106`. An unfilled known prefix returns 501 (`src/daemon/runtime/server.ts:399-411`). `/health` and `/api/status` are unprotected.
- `src/daemon-client/index.ts:10-11` still calls itself a stub and `ping` returns false (`src/daemon-client/index.ts:40-42`). CLI production fetch is `createLoopbackDaemonClient` (`src/commands/contracts.ts:471-480`, default base `http://127.0.0.1:3850`). Wired at `src/cli/runtime.ts:751`. `DaemonClient` has `send` and `ping` and no `query(sql)` (`src/commands/contracts.ts:364-374`).
- `src/daemon-client` imports `src/daemon/storage/sql.ts` (`src/daemon-client/vfs/read.ts:21`, `src/daemon-client/vfs/index-gen.ts:23`, `src/daemon-client/vfs/write-buffer.ts:48`, `src/daemon-client/skillify/pull-client.ts:21`). The transport stays under `src/daemon`. `src/eval/deeplake-stress.ts:43-44` imports `DeepLakeTransport` and `TransportError`.
- `loopbackDashboardUrl()` is `http://127.0.0.1:3853/` (`src/commands/install.ts:64-74`). Portal-missing copy names `--products=honeycomb,doctor,hive` (`src/commands/install.ts:88-93`). `openDashboard` returns the Hive base plus `/` (`src/dashboard/launch.ts:149-178`).
- Bind overrides: `HONEYCOMB_PORT`, `HONEYCOMB_HOST`, `HONEYCOMB_BIND`, and `widened` (`src/daemon/runtime/config.ts:10-15` and `src/daemon/runtime/config.ts:60-73`).
- SQL helper line cites in `load-bearing-boundaries.md:75` match `src/daemon/storage/sql.ts:1-16`, `src/daemon/storage/sql.ts:42-50`, `src/daemon/storage/sql.ts:77-80`, and `src/daemon/storage/sql.ts:100-105`. `package.json:73` is `audit:sql`. `package.json:84` includes it in `ci`.
- Harness production set is `claude-code`, `codex`, `cursor`. Hermes, pi, and OpenClaw are `in-progress` (`src/daemon/runtime/dashboard/harness-registry.ts:137-156`). Detector header says those three have no connector (`src/daemon/runtime/dashboard/harness-detect.ts:23-27`).
- Tier-1 `key` columns and `sessions.message` JSONB match `src/daemon/storage/catalog/sessions-summaries.ts:40`, `src/daemon/storage/catalog/sessions-summaries.ts:112-115`, and `src/daemon/storage/catalog/memories.ts:53-58`. `EMBEDDING_DIMS = 768` is `src/daemon/storage/vector.ts:34-35`. Lexical fallback comment is `src/daemon/runtime/memories/recall.ts:43-45` and `src/daemon/runtime/memories/recall.ts:519-530`.
- Undeclared topology uses the local SQLite queue (`src/daemon/runtime/services/local-queue-diagnostics.ts:111-121`). `system-overview.md:97` is right about that split. `memory_jobs` still exists as the shared queue (`src/daemon/storage/catalog/runtime-jobs.ts:124`).
- Service label `com.legioncode.honeycomb`, legacy `ai.honeycomb.daemon`, `HONEYCOMB_DAEMON_SERVICE=spawn`, and macOS `launchctl bootout` match `src/cli/daemon-service.ts:54-74` and `src/cli/daemon-service.ts:810-812`. Lifecycle prefers the service manager (`src/cli/runtime.ts:353-362`).
- `HONEYCOMB_CODEBASE_GRAPH_AUTO_BUILD` defaults off (`src/daemon/runtime/assemble.ts:323` and `src/daemon/runtime/assemble.ts:3934-3938`).
- `VERB_TABLE` still has two axes, `cls` and `group`, and `login` / `logout` are `account` rows (`src/commands/contracts.ts:64-90` and `src/commands/contracts.ts:173-178`). Several command modules import `src/daemon/runtime` (`src/commands/install.ts`, `src/commands/telemetry.ts`, `src/commands/settings.ts`, `src/commands/asset.ts`, `src/commands/status.ts`).
- `~/.deeplake/projects.json` is still the projects cache (`src/hooks/shared/project-resolver.ts:69-70`). Credentials comments in `src/cli/auth.ts:4-5` and `src/cli/runtime.ts:541` still name `~/.deeplake/credentials.json`. That store is not the fleet root in `src/shared/fleet-root.ts`.
- Onboarding routes exist: `GET /api/diagnostics/fs/browse`, `POST /api/diagnostics/projects/bind`, `bind-existing`, `unbind` (`src/daemon/runtime/projects/onboarding-api.ts:10-16`). Org and workspace switch routes exist (`src/daemon/runtime/projects/scope-switch-api.ts:10-13`).
- `createHoneycombClient` is exported (`src/sdk/index.ts:37`). Cursor extension files exist under `harnesses/cursor/extension/`.
- Runtime-path conflict returns 409. Default claim TTL is 4 hours (`src/daemon/runtime/middleware/runtime-path.ts:28` and `src/daemon/runtime/middleware/runtime-path.ts:111`).
- `POST /api/hooks/session-end` exists (`src/hooks/shared/session-end.ts:27`). Summary worker spawns a host CLI (`src/daemon/runtime/summaries/worker.ts:474`).
- Skills promotion columns exist (`src/daemon/storage/catalog/product.ts:100-103`). `buildProjectScopeClause` exists (`src/daemon/runtime/recall/scope-clause.ts`).

## Page actions

| Page | Action | Why |
|---|---|---|
| `load-bearing-boundaries.md` | REVISE | D01, D02, D03. The port, SQL, stub-client, and Hive URL corrections on this dirty file hold. |
| `system-overview.md` | REVISE | D04, D05, D06, D07. The Hive dashboard row and the local-queue sentence hold. |
| `daemon-surface.md` | REVISE | D08, D09, D10, D11, D12. The loopback, 501, and Hive sentences in the opening paragraph hold. |
| `cli-dispatcher.md` | REVISE | D13, D14, D15. The verb-table axes and the login/logout rows hold. |
| `request-lifecycle.md` | REVISE | D16, D17, D18, D19. Prime and session-end paths hold. |
| `projects-onboarding-and-lifecycle.md` | REVISE | D20, D21. Bind routes and `~/.deeplake/projects.json` hold. The capture-gate story does not. |
| `multi-project-and-context-switching.md` | REVISE | D22, D23, D24. Registry columns, `buildProjectScopeClause`, and `synced_assets` without `project_id` hold. |

Defect count: 24 (FALSE 10, STALE 7, HOLE 7).

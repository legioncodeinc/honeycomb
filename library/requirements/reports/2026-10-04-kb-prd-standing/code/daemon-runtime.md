# Daemon runtime code standing (Wave 2)

Date: 2026-10-04
Shard: daemon runtime. Read the Wave 1 reports named below, then checked the cited symbols in source.
Branch context: `legion/kb-sotu-and-prd-lifecycle`. This file is the only write. No knowledge doc, PRD, ADR, or source edit. No commit. No folder move.

Reports judged:

- `library/requirements/reports/2026-10-04-kb-prd-standing/knowledge/architecture-narratives.md`
- `library/requirements/reports/2026-10-04-kb-prd-standing/knowledge/architecture-adrs.md`
- `library/requirements/reports/2026-10-04-kb-prd-standing/prds/completed-001-008.md` (PRD-004 only)
- `library/requirements/reports/2026-10-04-kb-prd-standing/prds/backlog-059-061-081.md` (PRD-081 only)
- `library/requirements/reports/2026-10-04-kb-prd-standing/prds/archive-067-070.md`

Source walked: `src/daemon/runtime/server.ts`, cited regions of `src/daemon/runtime/assemble.ts` (not the whole file), `src/daemon/runtime/health.ts`, `src/daemon/runtime/middleware/permission.ts`, `src/daemon/runtime/middleware/runtime-path.ts`. Cited symbols outside that set were opened when a recommendation depended on them. Skipped `node_modules` and build outputs (`daemon/`, `bundle/`, `mcp/bundle/`, `harnesses/*/bundle/`, `embeddings/embed-daemon.js`).

Verdicts below are CONFIRM, OVERTURN, or UNVERIFIABLE for each recommended doc edit and each PRD bucket recommendation. LEAVE rows are recorded so a later writer does not invent an edit. They are not in the counts.

## Counts

| Set | Confirm | Overturn | Unverifiable |
|---|---:|---:|---:|
| Narrative doc edits D01-D24 | 24 | 0 | 0 |
| ADR status edits and the local-ANN add | 7 | 0 | 0 |
| Archive librarian edits | 4 | 1 | 0 |
| PRD bucket recommendations | 6 | 0 | 0 |
| Total | 41 | 1 | 0 |

## Narrative doc edits

Page actions stay REVISE for all seven architecture narratives. Each defect below is the edit.

### D01 CONFIRM

ADD on `library/knowledge/private/architecture/load-bearing-boundaries.md`. `DaemonServices` includes `embed` and `telemetry`, defaulting to `noopEmbedSupervisor` and `noopTelemetryService` (`src/daemon/runtime/server.ts:120-132`, `src/daemon/runtime/server.ts:233-238`). Lines 169-170 are the options-field comment. `src/daemon/runtime/CONVENTIONS.md:100` also says do not edit `services/types.ts`.

### D02 CONFIRM

ADD the missing client roots on the tier table. `package.json:17-21` exports `.`, `/react`, `/vercel`, `/openai`. `esbuild.config.mjs:335-338` bundles four SDK entries. `src/sdk/`, `src/hooks/`, `src/dashboard/`, `src/connectors/`, and `src/commands/` exist as roots the table omits.

### D03 CONFIRM

ADD that `/setup/*` mounts on the `/` group. `ROUTE_GROUPS` scaffolds `{ path: "/", protect: false }` at `src/daemon/runtime/server.ts:105`. `SETUP_LOGIN_GROUP`, `SETUP_STATE_GROUP`, `SETUP_TENANCY_GROUP`, and `SETUP_MIGRATE_GROUP` are `"/"` (`src/daemon/runtime/dashboard/setup-login.ts:40`, `setup-state.ts:61`, `setup-tenancy.ts:71`, `setup-migrate.ts:68`) and each calls `daemon.group` on that constant. `src/daemon/runtime/dashboard/host.ts` is absent.

### D04 CONFIRM

REMOVE the Desktop row from `system-overview.md`. `package.json` files and `esbuild.config.mjs` have no desktop, Electron, or Tauri target.

### D05 CONFIRM

ADD the verbs the overview sentence drops. `VERB_TABLE` in `src/commands/contracts.ts:104-237` includes `remember`, `memory`, `sessions`, `pollinate`, `maintenance`, `capture`, `skill`, `skillify`, `goal`, `graph`, `route`, `secret`, `settings`, `login`, `logout`, `whoami`, `workspaces`, `daemon`, `dashboard`, `hook`, `harness`, and the service baseline (`start`, `stop`, `restart`, `logs`, `service-install`, `service-uninstall`, `register`, `telemetry`, `update`, `uninstall`).

### D06 CONFIRM

ADD fleet-root precedence and the product subdirectory. `resolveFleetRoot` is `APIARY_HOME` when absolute, else `$XDG_STATE_HOME/apiary` on Linux when that value is absolute, else `~/.apiary` (`src/shared/fleet-root.ts:78-95`). Product state is `honeycombStateDir()` (`src/shared/fleet-root.ts:103-104`). The queue file name is `local-queue.db` (`src/daemon/runtime/services/local-job-queue.ts:23`) under the fleet state root (`src/daemon/runtime/assemble.ts:3175-3179`). The registry write target is `<fleetRoot>/registry.json` when that directory exists (`src/daemon/runtime/telemetry/fleet-registry.ts:74-79`, `src/cli/standard-ops.ts:203-205`). Legacy fallback is `legacyHoneycombDir` (`src/shared/fleet-root.ts:144-146`).

### D07 CONFIRM

REVISE the one-command installer sentence. `src/commands/install.ts:6-31` says the shell scripts own Node detection and `npm i -g`, and the `honeycomb install` verb opens a browser only in solo mode when `http://127.0.0.1:3853/` answers. Fleet mode opens nothing.

### D08 CONFIRM

ADD the same `/` group fact on `daemon-surface.md`. Same evidence as D03.

### D09 CONFIRM

REVISE the "`/` | Dashboard static assets | none" row. The `/` group is scaffolded with `protect: false` (`src/daemon/runtime/server.ts:105`). `host.ts` is absent. No daemon static-asset host is mounted on that group. Setup routes attach there (D03). The Hive portal URL is a separate port.

### D10 CONFIRM

REVISE the `/api/hooks/*` row. Mounted routes are `POST /api/hooks/capture` and `GET /api/hooks/conversation` (`src/daemon/runtime/capture/capture-handler.ts:103-105`, `src/daemon/runtime/capture/capture-handler.ts:281-282`) plus `POST /api/hooks/context` and `POST /api/hooks/session-end` (`src/daemon/runtime/capture/attach.ts:55-57`, `src/daemon/runtime/capture/attach.ts:204-205`). No `/api/hooks/session-start`, `pre-compaction`, or `compaction-complete` symbol exists under `src/daemon/runtime`. Synthesis lives under `src/daemon/runtime/summaries/synthesis.ts` as a worker, not an `/api/hooks` route.

### D11 CONFIRM

ADD an `/api/settings` row. `src/daemon/runtime/server.ts:87` scaffolds the group with `protect: true`. `src/daemon/runtime/vault/api.ts:9-11` mounts `GET /api/settings`, `GET /api/settings/:key`, and `POST /api/settings/:key`.

### D12 CONFIRM

REVISE the "diagnostics/operator" cell. Frozen roles are `admin | member | readonly | agent` (`src/daemon/runtime/auth/rbac.ts:23-27`). `/api/diagnostics`, `/api/pipeline`, and `/api/repair` are `connectorsAdmin`, which is `admin` and `member` (`src/daemon/runtime/auth/rbac.ts:98`, `src/daemon/runtime/auth/rbac.ts:135-139`). The word "operator" remains a parenthetical in that comment.

### D13 CONFIRM

REVISE the `usageText` / `VERB_GROUPS` sentence on `cli-dispatcher.md`. `usageText` drops a baseline set and calls `renderProductBanner` (`src/commands/dispatch.ts:126-153`). It does not read `VERB_GROUPS`. The comment at `src/commands/contracts.ts:55-61` still describes the old walk.

### D14 CONFIRM

REVISE the claim that `isStorageVerb()` proves the DeepLake import ban. The function returns `lookupVerb(verb)?.cls === "storage"` (`src/commands/contracts.ts:245-247`).

### D15 CONFIRM

REVISE the auth-forwarding sentence. The set matches (`src/commands/contracts.ts:265-273`). Dispatch splits: `login` and `logout` to `authMain`, `whoami` to `whoamiMain`, `project` to `projectMain`, and `org`, `workspace`, and `workspaces` to `orgMain` (`src/cli/runtime.ts:504-528`).

### D16 CONFIRM

REVISE the session-start sequence diagram. There is no `POST /api/hooks/session-start`. Session-start context is `POST /api/hooks/context` (`src/daemon/runtime/capture/attach.ts:55`, `src/daemon/runtime/capture/attach.ts:204`).

### D17 CONFIRM

REVISE "Memory Check Loop". The session-start constant is `RECALL_AWARENESS_NOTICE`, which starts "Memory recall is available on demand" (`src/hooks/shared/session-start.ts:69-73`).

### D18 CONFIRM

REVISE "every turn produces one sessions INSERT". Production capture sets `boundProjectGate: true` and `inboxCapture: resolveInboxCaptureEnabled()` and does not pass `firstRunGate` (`src/daemon/runtime/assemble.ts:1381-1387`). An unbound cwd is gated with `no_bound_project` when the inbox opt-in is off (`src/daemon/runtime/capture/capture-handler.ts:777-778`). Accepted rows buffer into a multi-row append when batching is on (`src/daemon/runtime/capture/capture-handler.ts:368-376`).

### D19 CONFIRM

REVISE the mode list. `shadowMode` and `mutationsFrozen` gate writes (`src/daemon/runtime/pipeline/controlled-writes.ts:415-422`). `graphEnabled` gates graph persist (`src/daemon/runtime/pipeline/graph-persist.ts:436-441`). `autonomousEnabled` is absent under `src/`.

### D20 CONFIRM

REVISE the first-run-gate paragraph. Production wires `boundProjectGate: true` and does not pass `firstRunGate` (`src/daemon/runtime/assemble.ts:1381-1387`). `attach.ts:99-101` says the per-session gate supersedes the one-shot first-run gate. `firstRunGateClosed` runs only when `firstRunGate === true` (`src/daemon/runtime/capture/capture-handler.ts:794-798`). A resolver throw returns the inbox scope and the bound-project gate then suppresses the write (`src/daemon/runtime/capture/capture-handler.ts:752-754`, `src/daemon/runtime/capture/capture-handler.ts:777-778`). The tenancy seam throw is the fail-open branch (`src/daemon/runtime/capture/capture-handler.ts:768-774`). The rewrite should keep that distinction.

### D21 CONFIRM

REVISE the bind-notice quote. The source uses a colon: "Bind a folder to start: open..." (`src/hooks/shared/session-start.ts:43-45`).

### D22 CONFIRM

REVISE "capture must never drop a memory" and the `__unsorted__` default. Same production gate as D18 and D20. `resolveScope` still returns `__unsorted__` with `bound: false` and `source: "inbox"` after a git miss (`src/hooks/shared/project-resolver.ts:605-608`). Production capture does not write that row unless inbox opt-in is on.

### D23 CONFIRM

REVISE the `resolveScope({ cwd })` sentence. `resolveScope` takes `{ cwd, cache, ... }` and its order is binding, git, then inbox (`src/hooks/shared/project-resolver.ts:564-608`). It does not read `HONEYCOMB_PROJECT_ID`. The env override is `projectIdOverride` on `resolveScopeFromDisk`, and a non-empty override returns `source: "binding"` without reading the cache (`src/hooks/shared/project-resolver.ts:682-705`).

### D24 CONFIRM

REVISE the "slated to be pivoted" est-savings sentence. ADR-0010's status line says Accepted and the body says the corpus proxy is retired. The proxy is still live: `CHARS_PER_TOKEN = 4` (`src/daemon/runtime/dashboard/api.ts:234`), `fetchEstimatedSavings` (`src/daemon/runtime/dashboard/api.ts:313-320`), and `buildEstimatedSavingsSql` as `SELECT SUM(LENGTH(content))` (`src/daemon/runtime/dashboard/api.ts:347-352`).

## ADR edits

Status-line edits leave the body. README Status cells change to the same words. Titles and dates stay.

### ADR-0002 CONFIRM

REVISE the status line to `Superseded by queen ADR-0002 (relocated 2026-07-03)` and set `README.md:21` to those words. The banner already says SUPERSEDED on 2026-07-03 (`0002-orchestrator-custodian-for-fleet-memory-plane.md:3-6`). The status line still says Proposed. Honeycomb `src/` has no enroll-token command and no Hyperdrive or Durable Objects client. Queen `ADR-0002` still says `Superseded by: none` (one-way). Leave the body.

### ADR-0003 CONFIRM

REVISE the status line to `Superseded by queen ADR-0003 (relocated 2026-07-03)` and set `README.md:22` to those words. Banner and Proposed line match the 0002 shape (`0003-trusted-device-custody-and-headless-enrollment.md:3-6`). Headless `honeycomb devices enroll-token` is absent from `src/`. This file is the relocated custody ADR. Fleet-root comments that say "ADR-0003" in `src/shared/fleet-root.ts` and `src/daemon/runtime/assemble.ts` point at the superproject decision mirrored here as ADR-0008. Leave the body.

### ADR-0004 CONFIRM

REVISE the status line to `Superseded by queen ADR-0004 (relocated 2026-07-03); queen runtime topology later superseded by queen ADR-0010` and set `README.md:23` to those words. Honeycomb banner is still Proposed (`0004-honeycomb-control-plane-and-postgres-boundary.md:3-6`). Queen ADR-0004 lines 5-6 say superseded by ADR-0010 for the runtime-topology decision. Queen ADR-0010 lines 3-4 are Accepted and supersede ADR-0004 for that decision. Honeycomb does not implement Workers, Hyperdrive, Queues, or Durable Objects. Leave the body.

### ADR-0005 CONFIRM

REVISE the status line to `Superseded by queen ADR-0005 (relocated 2026-07-03)` and set `README.md:24` to those words. Banner and Proposed line match (`0005-recovery-revocation-and-escrow-policy.md:3-6`). No escrow or device-revocation control plane is in `src/`. Leave the body.

### ADR-0006 CONFIRM

REVISE the status line to `Accepted (evolved by ADR-0009)` and set `README.md:25` to those words. The banner already says evolved by ADR-0009 (`0006-local-queue-as-interim-idle-cost-control.md:3-6`). The local queue is in the tree: `local-queue.db` (`src/daemon/runtime/services/local-job-queue.ts:22-23`), base dir from the fleet state root (`src/daemon/runtime/assemble.ts:3175-3179`), and the recurring `SELECT 1` probe stays off when the local queue is enabled and shared drain is off (`src/daemon/runtime/assemble.ts:3174`, gate at `src/daemon/runtime/assemble.ts:4091-4096`). Leave the body, including the "not superseded" clause. The backlog PRD-066 link in the body is a path defect. This confirmation does not authorize a body edit.

### ADR-0010 CONFIRM

REVISE the status line to `Proposed` and set `README.md:29` to `Proposed`. The file says Accepted (`0010-recall-weighted-est-savings.md:3-4`) and says `fetchEstimatedSavings` / `buildEstimatedSavingsSql` are removed. Those functions are live (`src/daemon/runtime/dashboard/api.ts:313-352`). `Accepted` would mean the retirement is the live contract. It is not. Leave the body. Do not add a second savings ADR.

### Local ANN candidate CONFIRM

ADD a candidate ADR. Do not number it in this report. Next free number is 0012, and this report does not claim that number. Deep Lake has no vector-index primitive, so the memories semantic arm is an in-RAM flat cosine index, default on, with `<#>` as the cold fallback (`src/daemon/runtime/memories/local-vector-index.ts:1-17`). `DEFAULT_LOCAL_ANN_INDEX = true` (`src/daemon/runtime/memories/amplification-config.ts:42-48`). Boot wires it and does not await the cold build (`src/daemon/runtime/assemble.ts:3135-3157`). Fast recall uses the index or falls back (`src/daemon/runtime/memories/recall.ts:3000-3027`). Fusion stays `fuseHits` (`src/daemon/runtime/memories/recall.ts:757`, call sites at `src/daemon/runtime/memories/recall.ts:2843` and `src/daemon/runtime/memories/recall.ts:3275`). This is not a second local-queue ADR. ADR-0009 already records that default.

### ADR leaves (not counted)

These Wave 1 actions are LEAVE. Re-check agrees. Do not edit the status line.

- ADR-0001. `fuseHits` is the production fusion (`src/daemon/runtime/memories/recall.ts:757`).
- ADR-0007. Graph auto-build is on only when `HONEYCOMB_CODEBASE_GRAPH_AUTO_BUILD` parses true (`src/daemon/runtime/assemble.ts:336-344`, boot comment at `src/daemon/runtime/assemble.ts:3934-3938`). The build is fire-and-forget inside `start()` (`src/daemon/runtime/assemble.ts:4098-4104`). Production does not await the first storage probe (`src/daemon/runtime/assemble.ts:4086-4096`). `awaitInitialHealthProbe` defaults to true only when storage is injected (`src/daemon/runtime/assemble.ts:4066`).
- ADR-0008. `resolveFleetRoot` matches the decision (`src/shared/fleet-root.ts:78-95`). The stale comment at `src/daemon/runtime/assemble.ts:311-314` still names `~/.honeycomb` as the runtime dir. The resolver below it uses `honeycombStateDir()` (`src/daemon/runtime/assemble.ts:883-889`). That comment does not overturn the Accepted status.
- ADR-0009. `DEFAULT_LOCAL_JOB_KINDS` lists the ten pipeline kinds (`src/daemon/runtime/services/hybrid-job-queue.ts:15-26`). Unknown and `single_machine` take the local queue. `fleet` and `multi_device` stay shared unless opted in (`src/daemon/runtime/services/local-queue-diagnostics.ts:93-121`). Health exposes `memoryQueue` (`src/daemon/runtime/health.ts:307-315`, set at `src/daemon/runtime/assemble.ts:3473`). Lease precision: `lease()` does `BEGIN IMMEDIATE` then `UPDATE ... WHERE id = ?` (`src/daemon/runtime/services/local-job-queue.ts:430-443`). That precision does not change the Accepted status. Do not add a second local-queue ADR.
- ADR-0011. `src/daemon/runtime/capture/chunker.ts` is absent, so Proposed remains the right status word. Stale supporting claims (dependency count, reused PRD numbers, the PRD-074 path) are body text. This confirmation does not authorize a body edit.

## PRD bucket recommendations

### PRD-004 CONFIRM stay completed

All 32 criteria cited in the Wave 1 report are present in source. Do not move the folder.

HTTP server (`prd-004a` and index AC-1):

- Default bind is loopback `127.0.0.1:3850`, with `HONEYCOMB_PORT`, `HONEYCOMB_HOST`, and `HONEYCOMB_BIND` (`src/daemon/runtime/config.ts:10-15`, `src/daemon/runtime/config.ts:143-156`). `listen` uses `config.host` and `config.port` (`src/daemon/runtime/listen.ts:44-53`).
- `GET /health` returns status, `uptimeMs`, version, and coarse `pipeline` without a per-request DeepLake query (`src/daemon/runtime/server.ts:330-352`).
- `GET /api/status` returns config, providers, and tenancy (`src/daemon/runtime/server.ts:355-396`).
- `local` mode calls `next()` with no permission check (`src/daemon/runtime/middleware/permission.ts:186-189`). Team mode rejects before the handler (`src/daemon/runtime/middleware/permission.ts:203-244`).
- Scaffolded groups inherit middleware mounted at bootstrap (`src/daemon/runtime/server.ts:305-327`). Unfilled known prefixes return 501 (`src/daemon/runtime/server.ts:399-411`).

Job queue (`prd-004b` and index AC-2). Later ADR-0009 made the local queue the default for the ten pipeline kinds. The shared `memory_jobs` implementation remains, so these criteria stay completed:

- Lease confirms ownership before returning the job (`src/daemon/runtime/services/job-queue.ts:566-616`).
- Repeated failure transitions to `dead` (`src/daemon/runtime/services/job-queue.ts:796-824`).
- The reaper reclaims an expired lease without consuming an attempt (`src/daemon/runtime/services/job-queue.ts:840-889`).
- Backoff is `base * 2^(attempts-1)`, capped (`src/daemon/runtime/services/job-queue.ts:328-338`, applied at `src/daemon/runtime/services/job-queue.ts:814-817`).
- `start()` arms the reaper and warms the table in the background, then reaps (`src/daemon/runtime/services/job-queue.ts:937-953`).
- Done retention defaults to 24 hours and dead retention to 7 days (`src/daemon/runtime/services/job-queue.ts:254-255`, purge at `src/daemon/runtime/services/job-queue.ts:900-928`).

File watcher (`prd-004c` and index AC-3):

- Canonical names and the do-not-edit header are in `src/daemon/runtime/services/harness-sync.ts:29-44` and `src/daemon/runtime/services/harness-sync.ts:68-76`.
- Byte-identical copies skip the write (`src/daemon/runtime/services/harness-sync.ts:207-209`).
- Debounce coalesces a burst into one cycle (`src/daemon/runtime/services/file-watcher.ts:235`, `src/daemon/runtime/services/file-watcher.ts:297-315`).
- Git sync disabled returns before commit (`src/daemon/runtime/services/file-watcher.ts:261-264`). Unchanged copies skip the commit (`src/daemon/runtime/services/file-watcher.ts:267-269`).
- `gitStageAndCommit` stages and commits with a timestamped message (`src/daemon/runtime/services/git-sync.ts:64-80`, `src/daemon/runtime/services/git-sync.ts:109-115`).
- A removed canonical file is noted and the cycle keeps running (`src/daemon/runtime/services/harness-sync.ts:92-100`, `src/daemon/runtime/services/harness-sync.ts:140-145`).
- Assembly constructs the watcher and `startServices` starts it for the process lifetime (`src/daemon/runtime/assemble.ts:3317-3324`, `src/daemon/runtime/server.ts:424-430`).

Production assembly currently passes `harnessTargets: options.harnessTargets ?? []` and `gitSync: { enabled: false }` (`src/daemon/runtime/assemble.ts:3320-3324`). No other `src/` caller sets `harnessTargets`. The copy and commit behavior is present in the service and is what the criteria describe when targets are supplied and git sync is enabled. That default does not remove the criterion. Do not move PRD-004 back to in-work.

Runtime path (`prd-004d` and index AC-4):

- Default TTL is 4 hours (`src/daemon/runtime/middleware/runtime-path.ts:111-112`). Expiry uses `claimed_at` (`src/daemon/runtime/middleware/runtime-path.ts:134-137`).
- The owning path refreshes `last_seen_at` and proceeds (`src/daemon/runtime/middleware/runtime-path.ts:159-163`).
- A different path returns `{ ok: false }` (`src/daemon/runtime/middleware/runtime-path.ts:165-166`). The middleware returns 409 and does not call `next()` (`src/daemon/runtime/middleware/runtime-path.ts:305-314`), so no capture handler runs for that request.
- A missing or invalid `x-honeycomb-runtime-path` returns 400 before `next()` (`src/daemon/runtime/middleware/runtime-path.ts:262-272`).
- `activePath` reports the holder (`src/daemon/runtime/middleware/runtime-path.ts:175`).
- An expired claim is replaced by a fresh claim (`src/daemon/runtime/middleware/runtime-path.ts:155-171`).
- Session groups mount this middleware ahead of permission (`src/daemon/runtime/server.ts:72-74`, `src/daemon/runtime/server.ts:104`, `src/daemon/runtime/server.ts:316-322`).

### PRD-081 CONFIRM stay backlog

Do not move to `completed/` or `in-work/`. The index non-goal says not to promote the folder to `in-work/` until implementation begins (`library/requirements/backlog/prd-081-daemon-assembly-modularization/prd-081-daemon-assembly-modularization-index.md:135`).

The target layout is absent:

- `src/daemon/runtime/assembly/` (no `contracts.ts`, `instance-lock.ts`, `mounts/index.ts`, or `lifecycle.ts`)
- `src/daemon/runtime/memories/recall-lifecycle-sources.ts`
- `src/daemon/vault/assembly-settings.ts`
- `src/daemon/runtime/pipeline/assembly.ts`
- `src/daemon/runtime/pollinating/assembly.ts`
- `src/daemon/runtime/skillify/assembly.ts`
- `src/daemon/runtime/summaries/assembly.ts`
- `tests/daemon/runtime/assembly/`
- `mountDaemonSurfaces` has no match under `src/daemon`

`src/daemon/runtime/assemble.ts` is 4758 lines. `SeamFns` is still declared in that file (`src/daemon/runtime/assemble.ts:577`). `defaultSeamFns` is still there (`src/daemon/runtime/assemble.ts:813`). Production still calls positional `assembleSeams(...)` (`src/daemon/runtime/assemble.ts:3652`). `src/daemon/index.ts:84-94` still re-exports `assembleDaemon` and `assembleSeams` from `assemble.ts`. Those are the current monolith. They are not the extraction. The required move-to-module criteria are absent, so the folder stays in backlog.

### PRD-067 CONFIRM stay archive

Do not move this folder to honeycomb `completed/`, `in-work/`, or `backlog`. The honeycomb index says the work was completed in doctor and archived here on 2026-07-03 (`library/requirements/archive/prd-067-doctor-boot-grace-release-blocker/prd-067-doctor-boot-grace-release-blocker-index.md:3`). `library/requirements/archive/README.md:16` names the canonical copy as doctor PRD-003. That doctor file exists and its status line is Completed. Honeycomb has no `doctor/` tree. Doctor source living outside this repo does not promote this withdrawn copy into honeycomb `completed/`. Archive here is the withdrawn local copy.

### PRD-068 CONFIRM stay archive

Do not move the folder. The index says superseded by hive PRD-003 and PRD-004 before this boot shell was built (`prd-068-portal-daemon-boot-shell-index.md:3-5`). `library/requirements/archive/README.md:17` says the same. Honeycomb daemon runtime has no "Honeycomb is starting." boot-portal copy. Hive later shipping a different portal does not satisfy these acceptance criteria. A criterion that names this withdrawn shell stays out of `completed/`.

### PRD-069 CONFIRM stay archive

Do not move the folder. The index says superseded by doctor PRD-001, doctor PRD-002, and hive PRD-005 (`prd-069-application-health-dashboard-index.md:3-5`). `library/requirements/archive/README.md:18` says the same. Honeycomb `GET /health` is the daemon liveness body (`src/daemon/runtime/server.ts:330-352`). It is not the layered application-health dashboard this PRD specifies. Successor screens in other repos do not satisfy these sentences. Stay archive.

### PRD-070 CONFIRM stay archive

Do not move the folder. The index says superseded by hive PRD-003 and PRD-004 (`prd-070-first-browser-load-experience-index.md:3-5`). `library/requirements/archive/README.md:19` says the same. The required copy ("Honeycomb is starting.", "The primary daemon is still coming online.", "Honeycomb is ready.", "Honeycomb needs attention.") is absent from `src/daemon/runtime`. Stay archive.

## Archive librarian edits

These are doc edits inside the archive indexes. They are not bucket changes.

### Second status lines

- CONFIRM `prd-068` line 7, `prd-069` line 7, and `prd-070` line 7. Each still has `Status: Backlog` under the superseded banner. A librarian may retitle that line so it no longer reads as the live status.
- OVERTURN the claim that `prd-067` line 5 is a second `Status: Backlog` line. Line 5 reads `Original status: Backlog`. Do not rewrite it as a duplicate live status.

### Successor links CONFIRM

The superseded banners on 068, 069, and 070 link hive and doctor successors under `backlog/`. Those backlog paths are absent. The completed copies exist:

- hive `completed/prd-003-portal-landing-gate-and-routing/`
- hive `completed/prd-004-buzzing-service-loaders/`
- hive `completed/prd-005-health-rail-and-page/`
- doctor `completed/prd-001-service-registration-and-telemetry-ingestion/`
- doctor `completed/prd-002-telemetry-sot-sse-and-schema/`

A librarian may retarget those links. That retarget does not move 068, 069, or 070 out of archive. Hive and doctor source being outside this repo does not demote or promote these withdrawn folders.

## Out of this shard

PRD-001, PRD-002, PRD-003, PRD-005, PRD-006, PRD-007, and PRD-008 in `completed-001-008.md` were not judged. PRD-059 and PRD-061 in `backlog-059-061-081.md` were not judged.

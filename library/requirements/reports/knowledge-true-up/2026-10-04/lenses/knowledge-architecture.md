# Lens: knowledge-architecture

Date: 2026-10-04. Repository: honeycomb. Read-only comparison of load-bearing claims in `library/knowledge/private/overview.md`, `library/knowledge/private/architecture/` (including ADRs, `load-bearing-boundaries.md`, `system-overview.md`, `daemon-surface.md`, `cli-dispatcher.md`), `library/knowledge/private/operations/`, and `library/knowledge/private/infrastructure/` against the working tree.

Fact labels: VERIFIED (checked in this tree), REPORTED (doc asserts it; not re-checked here), UNVERIFIABLE-HERE (needs another repo, a registry, or a live host).

Scope of the hunt: ports, package name, paths, commands, tiers, harness status, state root, install commands. Tone skipped. At most 12 findings. The punch list is every stale claim verified in that scope.

## Ground truth that held (VERIFIED)

| Claim | Evidence |
|---|---|
| `DAEMON_PORT` 3850, `DAEMON_HOST` `127.0.0.1`, `HIVE_PORT` 3853, `HIVE_HOST` `127.0.0.1`, `PRODUCT_SLUG` `honeycomb` | `src/shared/constants.ts:14-35` |
| Package `@legioncodeinc/honeycomb`, version `0.22.0`, bin `honeycomb` -> `bundle/cli.js`, `engines.node` `>=22.5.0`, no `workspaces` key, AGPL-3.0-or-later | `package.json:2-15`, `package.json:110-112` |
| `@honeycomb/*` are tsconfig path aliases (`shared`, `daemon-client`, `daemon`), not npm package names | `tsconfig.json:21-26` |
| One `tsc` then esbuild. `npm run ci` is typecheck, dup, test, `audit:sql` | `package.json:54-56`, `package.json:84` |
| Install front door `curl -fsSL https://get.theapiary.sh \| sh` and Windows `irm https://get.theapiary.sh/install.ps1`. `honeycomb install` probes and, in solo mode when the portal answers, opens `http://127.0.0.1:3853/` | `src/commands/install.ts:64-93`, `src/commands/install.ts:552-571` |
| Current launchd/systemd label `com.legioncode.honeycomb`. `ai.honeycomb.daemon` is the legacy label | `src/cli/daemon-service.ts:54-65` |
| Production harness set in code is `claude-code`, `codex`, `cursor`. `hermes`, `pi`, `openclaw` are `in-progress`. Connectors exist only for the first three | `src/daemon/runtime/dashboard/harness-registry.ts:137-156`, `src/connectors/` (`claude-code.ts`, `codex.ts`, `cursor.ts` only) |
| Fleet root chain: `APIARY_HOME` if absolute, else Linux `$XDG_STATE_HOME/apiary` when set and absolute, else `<homedir>/.apiary`. Honeycomb state is `<fleetRoot>/honeycomb` | `src/shared/fleet-root.ts:72-104` |
| Local queue file is `<fleetRoot>/honeycomb/.daemon/local-queue.db` | `src/daemon/runtime/assemble.ts:2116-2129`, `src/daemon/runtime/assemble.ts:3175-3179`, `src/daemon/runtime/services/local-job-queue.ts:22-23` |
| `honeycomb daemon start` success text is `daemon: started on 127.0.0.1:3850.` Bare `start` and `stop` verbs exist beside `daemon` | `src/commands/daemon.ts:96-102`, `src/commands/contracts.ts:213-220` |
| DeepLake HTTP transport module is not imported by harness, CLI, or MCP source. Tests and `src/eval/deeplake-stress.ts` do import it | grep of `storage/transport`; `src/eval/deeplake-stress.ts:43-44` |
| Harness bundle output dirs in the monorepo narrative match esbuild (`harnesses/*/bundle`, `harnesses/openclaw/dist`, `bundle/`, `daemon/`, `mcp` server, `embeddings/`) | `esbuild.config.mjs:122-126`, `esbuild.config.mjs:171-187`, `esbuild.config.mjs:253-259`, `esbuild.config.mjs:307`, `esbuild.config.mjs:358-390` |

ADR-0008's resolved chain (`~/.apiary`, `APIARY_HOME`, XDG only when set) matches `src/shared/fleet-root.ts`. The Context section of that ADR describes the pre-migration `~/.honeycomb` layout on purpose. It is not scored as a current-path claim.

Doctor's published version `0.1.x` and the behavior of `github.com/legioncodeinc/doctor` are UNVERIFIABLE-HERE. This tree has no `doctor/` directory.

## Findings

### knowledge-architecture-1

- Doc: `library/knowledge/private/operations/fleet-and-usage-telemetry.md`
- Quote: "The registry file honeycomb writes and doctor reads is `~/.honeycomb/doctor.daemons.json`."
- Grade: STALE
- Correction: The writer uses `~/.apiary/registry.json` when the fleet root directory exists, and the legacy `~/.honeycomb/doctor.daemons.json` only when that directory is absent. It does not write both.
- Evidence: `src/daemon/runtime/telemetry/fleet-registry.ts:29-30`, `src/daemon/runtime/telemetry/fleet-registry.ts:64-79`. VERIFIED.

### knowledge-architecture-2

- Doc: `library/knowledge/private/operations/fleet-and-usage-telemetry.md`
- Quote: "The telemetry database is `~/.honeycomb/telemetry/honeycomb.sqlite`."
- Grade: STALE
- Correction: The pinned path is `~/.apiary/honeycomb/telemetry/honeycomb.sqlite`. The old path is a legacy open fallback when an unmigrated file is still there.
- Evidence: `src/daemon/runtime/telemetry/fleet-store.ts:35-38`, `src/daemon/runtime/telemetry/fleet-store.ts:57-68`. VERIFIED.

### knowledge-architecture-3

- Doc: `library/knowledge/private/operations/notifications-and-health.md`
- Quote: "Storing their `id` and `dedupKey` in `~/.honeycomb/notifications-state.json` ensures they display exactly once."
- Grade: STALE
- Correction: Production state dir is `honeycombStateDir()` (`~/.apiary/honeycomb/notifications-state.json`). The legacy file is a read fallback only.
- Evidence: `src/notifications/state.ts:134-135`, `src/notifications/state.ts:201-205`, `src/shared/fleet-root.ts:98-104`. VERIFIED.

### knowledge-architecture-4

- Doc: `library/knowledge/private/operations/install-and-onboarding.md`
- Quote: "The Honeycomb daemon already serves a self-hydrating, token-free dashboard shell over loopback (`renderShell` / `mountDashboardHost` in `src/daemon/runtime/dashboard/host.ts`)."
- Grade: FALSE
- Correction: `src/daemon/runtime/dashboard/host.ts` is absent. No daemon route is registered at `/dashboard`. The browser the install verb opens is the Hive portal at `http://127.0.0.1:3853/`, and only in solo mode when that port answers. The same doc's earlier install section already states the 3853 portal.
- Evidence: absence of `src/daemon/runtime/dashboard/host.ts`; no `"/dashboard"` route under `src/daemon`; `src/commands/install.ts:64-75`, `src/commands/install.ts:552-571`; `src/dashboard/launch.ts:167-178`. VERIFIED.
- Same missing symbol is cited again in `library/knowledge/private/operations/roi-tracker.md` ("the same loopback + local-mode gate as `mountDashboardHost`") and later in install-and-onboarding ("sit beside `mountDashboardHost`").

### knowledge-architecture-5

- Doc: `library/knowledge/private/architecture/daemon-surface.md`
- Quote: "`/` | Dashboard static assets | none"
- Grade: FALSE
- Correction: `ROUTE_GROUPS` scaffolds `{ path: "/", protect: false }`. No module under `src/daemon` attaches a page with `group("/")`. The dashboard SPA is Hive on port 3853. The prose in the same file already says no page is attached to `/`.
- Evidence: `src/daemon/runtime/server.ts:104-105`; `src/dashboard/launch.ts:149-156`, `src/dashboard/launch.ts:167-178`. VERIFIED.

### knowledge-architecture-6

- Doc: `library/knowledge/private/overview.md` and `library/knowledge/private/architecture/system-overview.md`
- Quote: "SDK + MCP | `@honeycomb/sdk`, MCP server" and "MCP + SDK | MCP server, `@honeycomb/sdk`".
- Grade: FALSE
- Correction: The published client is the package `@legioncodeinc/honeycomb`. Subpaths are `.`, `./react`, `./vercel`, and `./openai`, mapped to `./sdk/*.js`. `@honeycomb/*` names are TypeScript path aliases, and there is no `@honeycomb/sdk` alias.
- Evidence: `package.json:2`, `package.json:17-22`; `tsconfig.json:21-26`. VERIFIED.

### knowledge-architecture-7

- Doc: `library/knowledge/private/architecture/load-bearing-boundaries.md`, `library/knowledge/private/operations/developer-workflow.md`, `library/knowledge/private/architecture/cli-dispatcher.md`
- Quote: "Tier 4 clients import the thin client surface, and they do not import `src/daemon`." Also: "`src/commands` is a non-daemon root, so a stray `daemon/storage` import fails the build."
- Grade: FALSE
- Correction: Listed lower tiers import `src/daemon` and the build still contains those imports. Examples: `src/cli/org.ts` and `src/cli/project.ts` import `src/daemon/runtime/auth`; `src/cli/harness-status.ts` imports harness detection; `src/commands/install.ts` imports daemon auth, config, onboarding, and telemetry; `src/daemon-client/vfs/read.ts` imports daemon SQL and graph code. The tier table also omits roots that exist: `src/commands`, `src/connectors`, `src/dashboard`, `src/eval`, `src/hooks`, `src/notifications`, `src/sdk`. `src/eval/deeplake-stress.ts` imports `src/daemon/storage/transport.ts`. Harness and MCP source were not found importing that transport module.
- Evidence: `src/cli/org.ts:40-53`, `src/cli/harness-status.ts:37`, `src/commands/install.ts:46-57`, `src/daemon-client/vfs/read.ts:19-21`, `src/eval/deeplake-stress.ts:43-44`. VERIFIED.

### knowledge-architecture-8

- Doc: `library/knowledge/private/architecture/daemon-surface.md`
- Quote: "The `ai.honeycomb.daemon` launchd agent runs with `KeepAlive=true` ... `honeycomb daemon stop` therefore unloads the agent with `launchctl bootout`."
- Grade: STALE
- Correction: The live unit label is `com.legioncode.honeycomb`. Stop runs `launchctl bootout` against that label. `ai.honeycomb.daemon` is `LEGACY_SERVICE_LABEL` and is removed on the upgrade path. `KeepAlive` is still set on the current plist. Install-and-onboarding already names the current label and the legacy family separately.
- Evidence: `src/cli/daemon-service.ts:54-65`, `src/cli/daemon-service.ts:396`, `src/cli/daemon-service.ts:414`, `src/cli/daemon-service.ts:794-812`. VERIFIED.

### knowledge-architecture-9

- Doc: `library/knowledge/private/architecture/system-overview.md` and `library/knowledge/private/overview.md`
- Quote: "All durable state lives in DeepLake tables." Overview: "all durable state lives in its tables."
- Grade: OVERCLAIMED
- Correction: Memory rows are DeepLake. Durable local state also lives under the fleet root: the SQLite job queue at `~/.apiary/honeycomb/.daemon/local-queue.db`, fleet telemetry SQLite, `registry.json`, notifications state, and the pid/lock. Credentials stay in `~/.deeplake/credentials.json`. ADR-0009 in the same architecture folder says the local queue is the default and DeepLake is not the queue.
- Evidence: `src/daemon/runtime/assemble.ts:2116-2129`; `src/daemon/runtime/telemetry/fleet-store.ts:57-63`; `src/shared/fleet-root.ts:98-104`. VERIFIED.

### knowledge-architecture-10

- Doc: `library/knowledge/private/operations/doctor-watchdog.md`
- Quote: "Doctor is a second, deliberately tiny, separate package (`@legioncodeinc/doctor`, in the `doctor/` directory)." Later: "it does not start a second daemon while the PID/lock (`~/.honeycomb/daemon.pid`) is held" and "default `~/.honeycomb/doctor/`."
- Grade: STALE
- Correction: This checkout has no `doctor/` tree, so `doctor/src/supervisor.ts` and the other `doctor/src/*` paths in that file are not in honeycomb. The same page's shipping note says Doctor moved to `github.com/legioncodeinc/doctor` (that repo's current layout is UNVERIFIABLE-HERE). Honeycomb's own pid file is `~/.apiary/honeycomb/daemon.pid`, with a read fallback to `~/.honeycomb/daemon.pid`.
- Evidence: no `doctor/` directory in the repo root; `src/cli/runtime.ts:181-183`, `src/cli/runtime.ts:226-228`; `src/daemon/runtime/assemble.ts:883-889`. VERIFIED for this tree. Doctor's own state dir: UNVERIFIABLE-HERE.

### knowledge-architecture-11

- Doc: `library/knowledge/private/infrastructure/npm-publishing.md`
- Quote: "a wired `\"version\"` script (`node scripts/sync-versions.mjs && git add -A`)."
- Grade: STALE
- Correction: The `version` script runs `sync-versions.mjs` and then `git add` of six manifests: `.claude-plugin/plugin.json`, the Claude Code plugin manifest, both OpenClaw manifests, `harnesses/codex/package.json`, and `.claude-plugin/marketplace.json`. It is not `git add -A`.
- Evidence: `package.json:55`. VERIFIED.

### knowledge-architecture-12

- Doc: `library/knowledge/private/architecture/system-overview.md`
- Quote: "The installer detects and sets up a Node runtime, installs the global package, brings the daemon up, and lands the user on the dashboard."
- Grade: OVERCLAIMED
- Correction: Fleet mode prints that Hive owns the dashboard and opens no browser. Solo mode opens `http://127.0.0.1:3853/` only after a 750 ms probe succeeds. If the portal is down, the verb prints the installer line with `--products=honeycomb,doctor,hive` and opens nothing. Solo with credentials already present also skips the login browser.
- Evidence: `src/commands/install.ts:399-444`, `src/commands/install.ts:552-571`, `src/commands/install.ts:88-93`. VERIFIED.

## Punch list

Every stale or false load-bearing claim verified above. Grades: STALE, FALSE, OVERCLAIMED.

| id | doc | stale claim | grade | correction | evidence |
|---|---|---|---|---|---|
| 1 | `operations/fleet-and-usage-telemetry.md` | Registry honeycomb writes is `~/.honeycomb/doctor.daemons.json` | STALE | Write `~/.apiary/registry.json` when the fleet root exists; else the legacy file | `src/daemon/runtime/telemetry/fleet-registry.ts:64-79` |
| 2 | `operations/fleet-and-usage-telemetry.md` | Telemetry db is `~/.honeycomb/telemetry/honeycomb.sqlite` | STALE | Primary path `~/.apiary/honeycomb/telemetry/honeycomb.sqlite` | `src/daemon/runtime/telemetry/fleet-store.ts:57-68` |
| 3 | `operations/notifications-and-health.md` | Persistent notification state is `~/.honeycomb/notifications-state.json` | STALE | File lives under `honeycombStateDir()` (`~/.apiary/honeycomb/`) | `src/notifications/state.ts:134-135` |
| 4 | `operations/install-and-onboarding.md` | Daemon serves the dashboard via `host.ts` `renderShell` / `mountDashboardHost`, including `GET /dashboard` | FALSE | `host.ts` is gone; no `/dashboard` route; browser target is Hive `:3853` | `src/commands/install.ts:64-75` |
| 5 | `operations/install-and-onboarding.md` | Setup routes sit beside `mountDashboardHost` | STALE | That function is not in the tree | absence of `src/daemon/runtime/dashboard/host.ts` |
| 6 | `operations/roi-tracker.md` | ROI routes use the same gate as `mountDashboardHost` | STALE | Same missing module | absence of `src/daemon/runtime/dashboard/host.ts` |
| 7 | `architecture/daemon-surface.md` | Route group `/` is "Dashboard static assets" | FALSE | `/` is an empty scaffold; the SPA is Hive on 3853 | `src/daemon/runtime/server.ts:105`, `src/dashboard/launch.ts:167-178` |
| 8 | `overview.md` | SDK package is `@honeycomb/sdk` | FALSE | Package is `@legioncodeinc/honeycomb` with `sdk/*.js` subpath exports | `package.json:17-22` |
| 9 | `architecture/system-overview.md` | SDK package is `@honeycomb/sdk` | FALSE | Same as row 8 | `package.json:2`, `package.json:17-22` |
| 10 | `architecture/load-bearing-boundaries.md` | Tier 4 does not import `src/daemon` | FALSE | `src/cli` and `src/commands` import daemon modules | `src/commands/install.ts:46-57` |
| 11 | `operations/developer-workflow.md` | Tier 4 (`src/cli`, harnesses, mcp) does not import `src/daemon` | FALSE | `src/cli/harness-status.ts` imports daemon harness detection | `src/cli/harness-status.ts:37` |
| 12 | `architecture/cli-dispatcher.md` | A stray `daemon/storage` import from `src/commands` fails the build | FALSE | `src/daemon-client` and `src/commands` already import daemon storage and runtime modules | `src/daemon-client/vfs/read.ts:19-21` |
| 13 | `architecture/daemon-surface.md` | Live macOS agent stopped by `honeycomb daemon stop` is `ai.honeycomb.daemon` | STALE | Live label is `com.legioncode.honeycomb`; the `ai.` name is legacy | `src/cli/daemon-service.ts:56`, `src/cli/daemon-service.ts:812` |
| 14 | `architecture/system-overview.md` | All durable state lives in DeepLake tables | OVERCLAIMED | Queue, telemetry, registry, notifications, and pid/lock are local files under `~/.apiary` | `src/daemon/runtime/assemble.ts:2128-2129` |
| 15 | `overview.md` | All durable state lives in DeepLake tables | OVERCLAIMED | Same local fleet-root files | `src/shared/fleet-root.ts:98-104` |
| 16 | `operations/doctor-watchdog.md` | Doctor source is `doctor/` in this repo (`doctor/src/supervisor.ts` and the rest of that page) | STALE | No `doctor/` directory here; the page also says the package moved to `github.com/legioncodeinc/doctor` | repo root has no `doctor/` |
| 17 | `operations/doctor-watchdog.md` | Watchdog pid lock is `~/.honeycomb/daemon.pid` and Doctor state is `~/.honeycomb/doctor/` | STALE | Honeycomb pid is `~/.apiary/honeycomb/daemon.pid` (legacy path is fallback). Doctor's own dir is UNVERIFIABLE-HERE | `src/cli/runtime.ts:226-228` |
| 18 | `infrastructure/npm-publishing.md` | `version` script is `sync-versions.mjs && git add -A` | STALE | `git add` lists six manifest paths, not `-A` | `package.json:55` |
| 19 | `architecture/system-overview.md` | The one-command installer lands the user on the dashboard | OVERCLAIMED | Fleet opens nothing; solo opens `:3853` only if the probe succeeds | `src/commands/install.ts:552-571` |
| 20 | `infrastructure/monorepo-build-release.md` | Esbuild Claude Code bundle is the block at `esbuild.config.mjs:52-82`, and the OpenClaw stub/env rewrite is at lines 371-403 and 404-426 | STALE | Those line ranges are `stampExecutable` and the CLI `cli-core` bundle. Claude Code `outdir` is line 171. OpenClaw `outdir` is line 259. The directory names in the bullet list above the fences are still right | `esbuild.config.mjs:114-126`, `esbuild.config.mjs:171`, `esbuild.config.mjs:253-259`, `esbuild.config.mjs:358-377` |

## Not scored as stale

These were checked and match the tree (VERIFIED): ports 3850 and 3853, package name and version and bin, Node engine, single package, path aliases, harness production vs in-progress split, install URL `get.theapiary.sh`, `honeycomb install` portal URL, `com.legioncode.honeycomb` as stated in install-and-onboarding, fleet root helper vs ADR-0008 resolved decisions, local-queue path in `operations/local-queue-idle-cost-control.md`, and `npm run ci` / `build` / `postinstall` as stated in developer-workflow and monorepo-build-release prose (the embedded esbuild line numbers are the exception, row 20).

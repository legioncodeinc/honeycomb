# Operations: install and CLI

Shard: Wave 1a, install and CLI. Read-only. Branch `legion/kb-sotu-and-prd-lifecycle`. No doc or source edits in this pass.

Grounding set: `src/cli/index.ts`, `src/commands/contracts.ts`, `src/commands/dispatch.ts`, `src/commands/install.ts`, `src/commands/storage-handlers.ts`, plus the files those claims name. `node_modules` and build outputs were not used.

Verdicts: FALSE, STALE, HOLE, HOLDS. Actions: REVISE, ADD, LEAVE, REMOVE. ASCII hyphens only.

## Coverage

| Page | Lines | Page action | Why |
|---|---|---|---|
| `library/knowledge/private/operations/install-and-onboarding.md` | 256 | REVISE | Install verb, lifecycle aliases, and the dashboard diagram lag the live install path. `host.ts` is already marked absent. |
| `library/knowledge/private/operations/cli-command-architecture.md` | 263 | REVISE | Dispatcher quotes, verb table, auth heal, and session prune describe files and SQL that are not the live CLI. |
| `library/knowledge/private/operations/developer-workflow.md` | 57 | REVISE | Script and portal citations hold. The tier-4 import rule does not. |
| `library/knowledge/private/operations/doctor-watchdog.md` | 152 | REVISE | Honeycomb has no `doctor/` tree. Keep the Honeycomb-side service floor. Do not delete the page: install still names Doctor. |

Do not REMOVE any of the four pages. Each still names a live surface (`honeycomb install`, the verb table, the contributor scripts, or the OS service floor).

## Defects

### D-01

- Quote: "The write is fail-soft, an onboarding hiccup logs a warning, never fails the install."
- Doc: `library/knowledge/private/operations/install-and-onboarding.md:68`
- Grounding: `src/commands/install.ts:524-530`
- Verdict: FALSE
- Action: REVISE

`writeInstalledMarker` returns false on IO error (`src/commands/install.ts:273-283`). `runInstallCommand` then prints `error: install failed during the onboarding-marker phase` and returns `{ exitCode: 1 }`. It does not log a warning and continue.

### D-02

- Quote: "1. Health-gate the daemon up. ... 2. Persist the onboarding marker. ... 3. Open the dashboard, honestly (C-6)."
- Doc: `library/knowledge/private/operations/install-and-onboarding.md:67-69`
- Grounding: `src/commands/install.ts:488-571`
- Verdict: STALE
- Action: REVISE

After the daemon is up, the live verb also requires a Doctor registry write and fails the install when that write returns false (`src/commands/install.ts:533-537`), runs solo-vs-fleet login (`src/commands/install.ts:540-543`, `src/commands/install.ts:413-453`), and wires harness hooks best-effort (`src/commands/install.ts:550`, `src/commands/install.ts:463-478`). The three-step list omits those phases. The same three-step list is repeated at `library/knowledge/private/operations/cli-command-architecture.md:68-70`.

### D-03

- Quote: "Solo mode with credentials already present: the installer opens nothing."
- Doc: `library/knowledge/private/operations/install-and-onboarding.md:89`
- Grounding: `src/commands/install.ts:437-441` and `src/commands/install.ts:560-568`
- Verdict: FALSE
- Action: REVISE

Existing credentials skip the device-flow browser (`src/commands/install.ts:439-441`). Solo mode still probes the portal and, when it answers, calls `openSoloDashboard` (`src/commands/install.ts:560-568`). Fleet mode is the branch that opens no browser (`src/commands/install.ts:431-434`, `src/commands/install.ts:558-559`).

### D-04

- Quote: "`honeycomb start` and `honeycomb stop` run the daemon lifecycle directly; the older `honeycomb daemon start|stop|status` forms are kept as aliases"
- Doc: `library/knowledge/private/operations/install-and-onboarding.md:97`
- Grounding: `src/commands/dispatch.ts:419-426` and `src/commands/contracts.ts:213-220`
- Verdict: FALSE
- Action: REVISE

Bare `start` and `stop` go to `runStandardCommand`, which drives the installed OS service (`src/commands/standard-interface.ts:67-75`, `src/cli/standard-ops.ts:305-316`). The comment above the switch says canonical lifecycle commands never fall back to the process-level `DaemonLifecycle` (`src/commands/dispatch.ts:419-421`). `daemon` is a separate verb routed to `runDaemonCommand` (`src/commands/dispatch.ts:425-426`, `src/commands/contracts.ts:220`).

### D-05

- Quote: "`honeycomb uninstall` is a complete three-part teardown, run in order"
- Doc: `library/knowledge/private/operations/install-and-onboarding.md:99-105`
- Grounding: `src/commands/dispatch.ts:295-331` and `src/cli/runtime.ts:621-649`
- Verdict: STALE
- Action: REVISE

The ordered body still matches the live steps: stop (`src/commands/local-handlers.ts:175-178`), unregister the current unit and call `unregisterLegacy` (`src/cli/runtime.ts:629-645`, labels at `src/cli/daemon-service.ts:56` and `src/cli/daemon-service.ts:63`), delete Honeycomb's registry entry, then remove the state dir without following a symlink (`src/cli/runtime.ts:648-653`). A full uninstall with nothing present still exits 0 (`src/commands/local-handlers.ts:149-152`). What the page omits: a full uninstall now asks for confirmation and returns exit 2 when cancelled or when `--yes` is missing in non-interactive mode (`src/commands/dispatch.ts:307-328`).

### D-06

- Quote: "The pivotal architectural realization is **no second daemon: one daemon, two phases.**"
- Doc: `library/knowledge/private/operations/install-and-onboarding.md:114`
- Grounding: `src/daemon/runtime/assemble.ts:1442-1446` and `src/commands/install.ts:64-74`
- Verdict: STALE
- Action: REVISE

The same page already says the browser target is the Hive portal on port 3853 (`library/knowledge/private/operations/install-and-onboarding.md:116`, `src/commands/install.ts:73-74`, `src/shared/constants.ts:19-23`). Assembly says the viewable dashboard SPA is served by Hive and Honeycomb keeps the setup API routes (`src/daemon/runtime/assemble.ts:1445-1446`). The sequence diagram still shows the Honeycomb daemon answering `GET /dashboard` (`library/knowledge/private/operations/install-and-onboarding.md:160`). `src/daemon/runtime/dashboard/host.ts` is ABSENT. No module under `src/daemon/runtime/dashboard/` is named `host.ts`.

### D-07

- Quote: "regression-locked by `tests/security/deploy-install-site-guard.test.ts`"
- Doc: `library/knowledge/private/operations/install-and-onboarding.md:61`
- Grounding: ABSENT
- Verdict: FALSE
- Action: REVISE

`tests/security/` is not in this repo. `.github/workflows/deploy-install-site.yaml` is not in this repo. `.github/rulesets/main-protection.json` does exist. `SECURITY.md:35-45` still describes `.github/workflows/deploy-install-site.yaml` as if it lived here. The installer-site controls (protected `production` environment, tag ancestry, immutable tags) are not verifiable from this checkout. Treat that section as external until a the-apiary tree is read.

### D-08

- Quote: "Setup routes (`GET /setup/state`, `POST /setup/login`, `POST /setup/migrate-from-hivemind`) mount in `local` mode."
- Doc: `library/knowledge/private/operations/install-and-onboarding.md:142`
- Grounding: `src/daemon/runtime/assemble.ts:1447-1474`
- Verdict: HOLE
- Action: ADD

Those three routes do mount only when `daemon.config.mode === "local"` (`src/daemon/runtime/assemble.ts:1447`). The same block also mounts `/setup/tenancy*` and wires `POST /setup/login` to a pending-link runner so a multi-tenant account is not persisted as a silent `orgs[0]` guess (`src/daemon/runtime/assemble.ts:1456-1473`). The sequence diagram (`library/knowledge/private/operations/install-and-onboarding.md:170-177`) skips that step and goes straight from device approval to `~/.deeplake/credentials.json`.

### D-09

- Quote: the `async function main()` if-chain cited as `src/cli/index.ts` lines 409-445, and the `AUTH_SUBCOMMANDS` block cited as lines 486-491.
- Doc: `library/knowledge/private/operations/cli-command-architecture.md:80-118` and `library/knowledge/private/operations/cli-command-architecture.md:122-128`
- Grounding: `src/cli/index.ts:32-40` and `src/commands/dispatch.ts:74-96`, `src/commands/dispatch.ts:449-512`
- Verdict: STALE
- Action: REVISE

`src/cli/index.ts` is 89 lines. `main` builds a dispatcher, calls `parse`, then `dispatch` (`src/cli/index.ts:32-40`). It does not branch on `setup`, `login`, `skill`, or `route`. Parsing and routing live in `src/commands/dispatch.ts`. Auth passthrough is `isAuthPassthrough` (`src/commands/dispatch.ts:486-492`), and the set is `org`, `workspace`, `workspaces`, `project`, `whoami`, `login`, `logout` (`src/commands/contracts.ts:265-272`).

### D-10

- Quote: "The full top-level command set is" the table from `install` through `update`, including the row `sessions prune`.
- Doc: `library/knowledge/private/operations/cli-command-architecture.md:36-56`
- Grounding: `src/commands/contracts.ts:104-237`
- Verdict: STALE
- Action: REVISE

`VERB_TABLE` is the live set. The page omits `memory`, `pollinate`, `maintenance`, `capture`, `skillify`, `asset`, `settings`, `login`, `logout`, `whoami`, `workspaces`, `project`, `start`, `stop`, `restart`, `logs`, `service-install`, `service-uninstall`, `register`, `daemon`, `harness`, `telemetry`, and `uninstall`. The prune command is the verb `sessions` with subcommand `prune` (`src/commands/contracts.ts:119`, `src/commands/sessions.ts:130-135`), not a top-level word `sessions prune`. `skillify` is its own verb (`src/commands/contracts.ts:145`) in addition to `skill`.

### D-11

- Quote: "`status` | Report daemon connectivity, login state, and environment health"
- Doc: `library/knowledge/private/operations/cli-command-architecture.md:40`
- Grounding: `src/commands/dispatch.ts:412-418` and `src/commands/standard-interface.ts:206-221`
- Verdict: STALE
- Action: REVISE

Live `status` is `runStandardCommand`, which reports service installation, process pid, `GET /health` on port 3850, Doctor registration, and log paths (`src/commands/standard-interface.ts:78-102`). `runStatusCommand` in `src/commands/status.ts:122-128` still describes a D1-D5 report plus org-drift heal, and nothing in `src/commands/dispatch.ts` calls it.

### D-12

- Quote: "`dashboard` | Open the local dashboard webview / TUI"
- Doc: `library/knowledge/private/operations/cli-command-architecture.md:41`
- Grounding: `src/commands/local-handlers.ts:232-244` and `src/cli/runtime.ts:724-731`
- Verdict: STALE
- Action: REVISE

`honeycomb dashboard` calls `launchDashboard`, keeps only the `reachable` bit, and prints `dashboard: launched` or a daemon-down line (`src/commands/local-handlers.ts:238-243`). It does not open `http://127.0.0.1:3853/`. `openDashboard` in `src/dashboard/launch.ts:173-178` returns that Hive URL and has no caller under `src/`. The install verb is the path that opens the portal (`src/commands/install.ts:351-356`).

### D-13

- Quote: "`runInstallCommand` (`src/commands/install.ts`) composes existing seams, it is a thin daemon client, never a daemon-core import"
- Doc: `library/knowledge/private/operations/install-and-onboarding.md:65`
- Grounding: `src/commands/install.ts:46-57`
- Verdict: FALSE
- Action: REVISE

`install.ts` imports `src/daemon/runtime/auth/credentials-store.js`, `deeplake-issuer.js`, `config.js`, `onboarding/index.js`, and `telemetry/fleet-registry.js` plus `telemetry/index.js`. The repeated sentence at `library/knowledge/private/operations/cli-command-architecture.md:66` is the same claim.

### D-14

- Quote: "The effective referral code resolves `--ref <code>` -> `onboarding.ref` -> the build-time default ... The verb only *persists* the ref; the device-flow attribution header is the login flow's job, driven from the dashboard's "First time setup" button rather than the terminal."
- Doc: `library/knowledge/private/operations/cli-command-architecture.md:72`
- Grounding: `src/commands/install.ts:227-228` and `src/commands/install.ts:443-446`
- Verdict: STALE
- Action: REVISE

The install verb's `resolveEffectiveRef` is `parseRefArg(argv) ?? DEFAULT_REF`. It does not read `onboarding.ref`. Solo install with no credentials calls `loginWithDeviceFlow` from the terminal (`src/commands/install.ts:389-393`). The precedence `--ref` then `onboarding.ref` then `DEFAULT_REF` is the login helper `resolveEffectiveRef` in `src/daemon/runtime/auth/deeplake-issuer.ts:186-190`, which is what `library/knowledge/private/operations/install-and-onboarding.md:197` describes. That install-and-onboarding sentence holds for the device-code request. The CLI page attaches it to the install verb.

### D-15

- Quote: the `healDriftedOrgToken` block cited as `src/commands/auth.ts` lines 217-240, and "automatically runs on session start".
- Doc: `library/knowledge/private/operations/cli-command-architecture.md:149-175`
- Grounding: ABSENT for `src/commands/auth.ts`. Live heal is `src/daemon/runtime/auth/device-flow.ts:207-238`. Session-start wiring is `src/hooks/shared/session-start-seams.ts:123`.
- Verdict: FALSE
- Action: REVISE

There is no `src/commands/auth.ts`. The function that decodes a token and re-mints is `healOrgDrift` (`src/daemon/runtime/auth/device-flow.ts:207`). Production session-start seams set `healDriftedOrgToken` to an empty async function (`src/hooks/shared/session-start-seams.ts:104-123`). `runSessionStart` calls that seam (`src/hooks/shared/session-start.ts:188`), so the live hook does not re-mint. `buildOrgDriftHealer` refuses to re-mint a credential whose `apiUrl` is `https://api.deeplake.ai` and only surfaces the drift (`src/cli/runtime.ts:555-573`). That healer is reached from `runStatusCommand` (`src/commands/status.ts:127-128`), which dispatch does not call (see D-11).

### D-16

- Quote: the `listSessions` and `deleteSessions` SQL blocks cited as `src/commands/session-prune.ts` lines 70-133, including `DELETE FROM` built in the CLI.
- Doc: `library/knowledge/private/operations/cli-command-architecture.md:189-259`
- Grounding: ABSENT for `src/commands/session-prune.ts`. Live client is `src/commands/sessions.ts:73-81`. Live daemon write is `src/daemon/runtime/sessions/prune.ts:296-305`.
- Verdict: FALSE
- Action: REVISE

The CLI sends `DELETE /api/diagnostics/sessions/prune` with `before` and `session-id` query params and builds no SQL (`src/commands/sessions.ts:4-14`, `src/commands/sessions.ts:29`, `src/commands/sessions.ts:73-81`). The daemon appends tombstone rows for the session and the paired memory summary (`src/daemon/runtime/sessions/prune.ts:9-27`). It does not run the quoted `DELETE FROM` statements. `src/commands/storage-handlers.ts:11-18` is the path for `remember`, `recall`, `skill`, and the other generic storage verbs: one `DaemonClient` request, no DeepLake handle.

### D-17

- Quote: "Tier 4 code (`src/cli`, `harnesses/*/src`, `mcp/src`) imports `src/shared` and the daemon client surface. It does not import `src/daemon`."
- Doc: `library/knowledge/private/operations/developer-workflow.md:56`
- Grounding: `src/cli/runtime.ts:55-57`, `src/cli/auth.ts:52`, `BUILD.md:26-32`, `library/knowledge/private/architecture/load-bearing-boundaries.md:53`
- Verdict: FALSE
- Action: REVISE

`src/cli/runtime.ts`, `src/cli/auth.ts`, `src/cli/org.ts`, `src/cli/whoami.ts`, `src/cli/project.ts`, `src/cli/token-issuer.ts`, `src/cli/keys.ts`, `src/cli/standard-ops.ts`, `src/cli/harness-status.ts`, and `src/cli/harness-reconcile.ts` import `src/daemon/runtime/...`. Harness adapters import `src/daemon-client/harness.js` only. `mcp/src/index.ts` imports `src/daemon-client`. `BUILD.md:26-27` still says tier 4 may import only tier 1. The sibling page already records that `src/cli` and `src/commands` import daemon runtime modules (`library/knowledge/private/architecture/load-bearing-boundaries.md:53`).

### D-18

- Quote: "The CLI reaches it with `createLoopbackDaemonClient` (`src/cli/runtime.ts:751`, `src/cli/index.ts:1-13`)."
- Doc: `library/knowledge/private/operations/developer-workflow.md:50`
- Grounding: `src/cli/runtime.ts:751` and `src/cli/index.ts:1-40`
- Verdict: STALE
- Action: REVISE

The call is `src/cli/runtime.ts:751` inside `buildRuntimeDeps`. `src/cli/index.ts:1-13` is a file header. `index.ts` calls `buildRuntimeDeps()` at line 38 and does not name `createLoopbackDaemonClient`. The function itself is exported from `src/commands/contracts.ts` (re-exported by `src/commands/index.ts:28`). The sentence "the daemon process is the only Deeplake client" still matches the storage boundary: these CLI imports are runtime modules, not `src/daemon/storage/transport.ts`.

### D-19

- Quote: "Tier 4 code (`src/cli`, `harnesses/*/src`, `mcp/src`)"
- Doc: `library/knowledge/private/operations/developer-workflow.md:56`
- Grounding: `src/commands/install.ts:46-57` and `src/commands/dispatch.ts:1-16`
- Verdict: HOLE
- Action: ADD

`src/commands` is the dispatcher and the install verb, and it is the module that imports daemon runtime code. `BUILD.md` does not list it as a tier. The contributor page never names it, so the import rule cannot be followed from this page alone.

### D-20

- Quote: "`doctor/src/supervisor.ts` is the heart" and the later `doctor/src/...` map through `doctor/src/compose/index.ts`.
- Doc: `library/knowledge/private/operations/doctor-watchdog.md:56` through `library/knowledge/private/operations/doctor-watchdog.md:147`
- Grounding: ABSENT
- Verdict: HOLE
- Action: REVISE

No `doctor/` directory exists in this repo. The page already says that at line 21 and tells the reader to treat the file map as reported history. The body still specifies probe classes, rung authority, `~/.honeycomb/doctor/`, OTLP `/i/v1/logs`, blessed-version CDN behavior, status page port 3852, and Windows `PT1M` as if those files were checked here. They were not. Shrink that map to a pointer at `github.com/legioncodeinc/doctor`, or mark every `doctor/src` path unreverified. Do not REMOVE the page: `dashboardPortalNotRunningMessage` still names `doctor` in the install command (`src/commands/install.ts:88-93`), and `register` is a live verb (`src/commands/contracts.ts:219`).

### D-21

- Quote: "it does not start a second daemon while the PID/lock (`~/.honeycomb/daemon.pid`) is held"
- Doc: `library/knowledge/private/operations/doctor-watchdog.md:75`
- Grounding: `src/cli/runtime.ts:181-183` and `src/cli/runtime.ts:226-228`
- Verdict: STALE
- Action: REVISE

Honeycomb's pid file is resolved new-first at `~/.apiary/honeycomb/daemon.pid` (`runtimeDir` is `honeycombStateDir()`), with `~/.honeycomb/daemon.pid` only as a legacy fallback. Line 21 of the same page already states the new path. Line 75 and the incident dir `~/.honeycomb/doctor/` at `library/knowledge/private/operations/doctor-watchdog.md:79` still use the old home. Whether Doctor itself still reads the legacy path is not verifiable here (see D-20).

## Claims that hold

These were checked because the shard called them out. Action LEAVE unless a defect above edits the surrounding paragraph.

### H-01

- Quote: "`src/daemon/runtime/dashboard/host.ts` is not in this checkout."
- Doc: `library/knowledge/private/operations/install-and-onboarding.md:116`
- Grounding: ABSENT
- Verdict: HOLDS
- Action: LEAVE

The absence sentence is right. The "no second daemon" headline and the `GET /dashboard` diagram around it are D-06.

### H-02

- Quote: "This Honeycomb checkout has no `doctor/` directory. Doctor is developed in `github.com/legioncodeinc/doctor`."
- Doc: `library/knowledge/private/operations/doctor-watchdog.md:21`
- Grounding: ABSENT for `doctor/`
- Verdict: HOLDS
- Action: LEAVE

Keep this sentence. D-20 is the unreverified map under it. Honeycomb's own pid sentence on the same line matches `src/cli/runtime.ts:226-228`.

### H-03

- Quote: "The URL that verb opens is `http://127.0.0.1:3853/` (`src/commands/install.ts:64-74`)."
- Doc: `library/knowledge/private/operations/developer-workflow.md:19`
- Grounding: `src/commands/install.ts:64-74`
- Verdict: HOLDS
- Action: LEAVE

`loopbackDashboardUrl` returns `http://${HIVE_HOST}:${HIVE_PORT}/`. `HIVE_HOST` and `HIVE_PORT` are `127.0.0.1` and `3853` (`src/shared/constants.ts:19-23`). The probe timeout constant is 750 ms at `src/commands/install.ts:78`. `probeLoopbackDashboard` is `src/commands/install.ts:330-341`. `openLocalDashboardUrl` admits `127.0.0.1`, `localhost`, and `::1` at `src/commands/install.ts:123-130`. `dashboardPortalNotRunningMessage` names `honeycomb,doctor,hive` at `src/commands/install.ts:88-93`. The same citations in `install-and-onboarding.md:69` match those ranges.

### H-04

- Quote: the `package.json` script table and "`npm run ci` is `npm run typecheck && npm run dup && npm run test && npm run audit:sql`".
- Doc: `library/knowledge/private/operations/developer-workflow.md:21-44`
- Grounding: `package.json:2`, `package.json:13-15`, `package.json:53-91`, `package.json:110-112`, `esbuild.config.mjs:355-367`
- Verdict: HOLDS
- Action: LEAVE

Name, bin `bundle/cli.js`, Node `>=22.5.0`, `prebuild`, `build` (`tsc && node esbuild.config.mjs`), `typecheck`, `lint`, `format`, `dup`, `test`, `test:integration`, `audit:sql`, `ci`, and `postinstall` sit on the cited lines. There is no `start` or `dev` script in that block. The CLI esbuild target writes `bundle/cli.js` with `#!/usr/bin/env node` (`esbuild.config.mjs:355-367`). `esbuild.config.mjs:52-57` matches the `VERSION_DEFINE` block quoted at `install-and-onboarding.md:246-253`.

### H-05

- Quote: "A successful start prints `daemon: started on 127.0.0.1:3850.` An already-running daemon prints `daemon: already running on 127.0.0.1:3850.`"
- Doc: `library/knowledge/private/operations/developer-workflow.md:48`
- Grounding: `src/commands/daemon.ts:90-102` and `src/commands/contracts.ts:220`
- Verdict: HOLDS
- Action: LEAVE

Those strings are `honeycomb daemon start`, not bare `honeycomb start` (D-04). `DAEMON_HOST` and `DAEMON_PORT` are `127.0.0.1` and `3850` (`src/shared/constants.ts:13-17`).

### H-06

- Quote: "The fix quotes the assignment as `set "VAR=value"` in `daemon-service`, and `src/shared/fleet-root.ts` defensively trims `APIARY_HOME`"
- Doc: `library/knowledge/private/operations/install-and-onboarding.md:109`
- Grounding: `src/cli/daemon-service.ts:603-609` and `src/shared/fleet-root.ts:83-88`
- Verdict: HOLDS
- Action: LEAVE

### H-07

- Quote: the three fleet signals (registry hive entry, 750 ms probe of `127.0.0.1:3853`, `@legioncodeinc/hive` in the npm global tree).
- Doc: `library/knowledge/private/operations/install-and-onboarding.md:77-83`
- Grounding: `src/shared/fleet-detection.ts:17-29` and `src/shared/fleet-detection.ts:141-163`
- Verdict: HOLDS
- Action: LEAVE

Any one signal means fleet. The port probe fetches `http://127.0.0.1:3853/health` with a 750 ms budget (`src/shared/fleet-detection.ts:55-56`, `src/shared/fleet-detection.ts:152-157`). The install login branch matches the page: fleet defers, solo with no credentials runs the device flow, solo with credentials skips that popup (`src/commands/install.ts:431-446`). The 15 s storage probe interval is `DEFAULT_HEALTH_PROBE_INTERVAL_MS = 15_000` (`src/daemon/runtime/assemble.ts:317`). The probe timeout is a separate 12 s constant (`src/daemon/runtime/health.ts:58`).

### H-08

- Quote: the `GET /setup/state` body and "`authenticated` is derived from `loadCredentials(...) !== null`".
- Doc: `library/knowledge/private/operations/install-and-onboarding.md:126-140`
- Grounding: `src/daemon/runtime/dashboard/setup-state.ts:106-132` and `src/daemon/runtime/dashboard/setup-state.ts:208-232`
- Verdict: HOLDS
- Action: LEAVE

`loadCredentials` returns null when both credential files are missing or malformed (`src/daemon/runtime/auth/credentials-store.ts:379-392`). `POST /setup/login` returns `user_code` and verification URIs, re-checks `verification_uri_complete` as https-only, and does not return `device_code` (`src/daemon/runtime/dashboard/setup-login.ts:159-168`). Referral headers are `X-Honeycomb-Referrer` and `X-Hivemind-Referrer`, omitted when the trimmed ref is empty, and attached on the device-code request (`src/daemon/runtime/auth/deeplake-issuer.ts:154-170`, `src/daemon/runtime/auth/deeplake-issuer.ts:855-859`). Migration phases `backup`, `uninstall`, `link`, `done` and rollback live in `src/daemon/runtime/dashboard/setup-migrate.ts:9-34`. Add the tenancy hole (D-08) without rewriting this body.

### H-09

- Quote: service-preferred daemon start, `HONEYCOMB_DAEMON_SERVICE=spawn`, and a writable workspace pinned into the unit.
- Doc: `library/knowledge/private/operations/doctor-watchdog.md:135-141`
- Grounding: `src/cli/runtime.ts:352-368` and `src/cli/daemon-service.ts:22`
- Verdict: HOLDS
- Action: LEAVE

`/health` still exposes `reasons.storage`, `reasons.embeddings`, and `reasons.schema` (`src/daemon/runtime/health.ts:191-226`). `src/daemon/restart-helper.ts` exists. This is the Honeycomb half of the watchdog page. It does not verify the `doctor/src` map (D-20).

### H-10

- Quote: "`remember`, `recall`, `agent`, `ontology`, `secret`, `skill`, `hook`, `route`, `sources`, `graph`, `goal`, `org`, `workspace`, `update`" as real verbs, and skill scope/pull examples.
- Doc: `library/knowledge/private/operations/cli-command-architecture.md:42-58`
- Grounding: `src/commands/contracts.ts:107-235` and `src/commands/storage-handlers.ts:79-84`
- Verdict: HOLDS
- Action: LEAVE

Those words are in `VERB_TABLE` or, for `hook`, a local verb (`src/commands/contracts.ts:222`). `skill scope`, `pull`, `unpull`, and `force` map to `/api/skills/*` (`src/commands/storage-handlers.ts:79-115`). Keep the rows. Add the missing verbs from D-10 beside them. `org` and `workspace` are auth passthrough (`src/commands/contracts.ts:265-272`).

## Counts

- Defects (FALSE, STALE, HOLE): 21
- Holds recorded above: 10
- Page actions: REVISE all four. REMOVE none. ADD the tenancy step (D-08) and the `src/commands` import fact (D-19) inside the existing pages.

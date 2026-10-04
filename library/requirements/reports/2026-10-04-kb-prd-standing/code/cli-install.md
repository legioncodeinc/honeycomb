# Wave 2 code standing: CLI and install

Shard: `src/cli/` and `src/commands/`. Read-only. No doc edits, no source edits, no commit.

Inputs: `knowledge/operations-install-cli.md`, sources-CLI and npm version-script claims in `knowledge/infra-collab-sources-overview.md`, PRD-050 installer claims in `prds/completed-043-050.md`, CLI criteria in `prds/in-work-020.md`.

A missing `doctor/` tree or a missing Hive tree does not move a completed PRD. Hosted installers were probed at `https://get.theapiary.sh/install.sh` and `https://get.theapiary.sh/install.ps1` (both HTTP 200 on 2026-10-04). They are not in this checkout.

ASCII hyphens only. Each recommended edit or move is CONFIRM, OVERTURN, or UNVERIFIABLE.

## Counts

- CONFIRM: 39
- OVERTURN: 8
- UNVERIFIABLE: 0

Doc edits confirmed: 23. Doc edits overturned: 0. Moves confirmed: 2 (PRD-050 stays completed, PRD-020 stays in-work). Moves overturned: 1 (do not move PRD-050 to in-work). The other 14 confirms and 7 overturns are installer and CLI criterion verdicts that feed those buckets.

## Knowledge edits (`operations-install-cli.md`)

### D-01 CONFIRM

REVISE `install-and-onboarding.md:68`. `writeInstalledMarker` returns false on IO error (`src/commands/install.ts:273-283`). `runInstallCommand` then prints `error: install failed during the onboarding-marker phase` and returns `{ exitCode: 1 }` (`src/commands/install.ts:526-529`). It does not warn and continue. The file header comment at `src/commands/install.ts:22-23` still says fail-soft; the function body is the live path.

### D-02 CONFIRM

REVISE the three-step lists at `install-and-onboarding.md:67-69` and `cli-command-architecture.md:68-70`. After the daemon is up the verb also fails the install when the Doctor registry write returns false (`src/commands/install.ts:533-537`), runs solo-vs-fleet login (`src/commands/install.ts:540-544`, `src/commands/install.ts:413-453`), and wires harness hooks best-effort (`src/commands/install.ts:550`, `src/commands/install.ts:463-478`).

### D-03 CONFIRM

REVISE `install-and-onboarding.md:89`. Existing credentials skip the device-flow browser (`src/commands/install.ts:437-441`). Solo mode still probes the portal and, when it answers, calls `openSoloDashboard` (`src/commands/install.ts:560-568`). Fleet mode is the branch that opens no browser (`src/commands/install.ts:431-434`, `src/commands/install.ts:558-559`).

### D-04 CONFIRM

REVISE `install-and-onboarding.md:97`. Bare `start` and `stop` go to `runStandardCommand` (`src/commands/dispatch.ts:419-424`), which drives the installed OS service (`src/commands/standard-interface.ts:67-75`, `src/cli/standard-ops.ts:305-316`). The comment above that switch says canonical lifecycle commands never fall back to the process-level `DaemonLifecycle` (`src/commands/dispatch.ts:419-421`). `daemon` is a separate verb (`src/commands/dispatch.ts:425-426`, `src/commands/contracts.ts:220`).

### D-05 CONFIRM

REVISE `install-and-onboarding.md:99-105`. The ordered body still matches: stop (`src/commands/local-handlers.ts:175-178`), unregister the current unit and call `unregisterLegacy` (`src/cli/runtime.ts:629-645`; labels `src/cli/daemon-service.ts:56` and `src/cli/daemon-service.ts:63`), delete the registry entry, then remove the state dir without following a symlink (`src/cli/runtime.ts:648-664`). A full uninstall with nothing present still prints the nothing-to-remove line and returns the connector exit code (`src/commands/local-handlers.ts:149-163`). What the page omits: a full uninstall asks for confirmation and returns exit 2 when cancelled, when `--json` is set without `--yes`, or when confirmation is refused (`src/commands/dispatch.ts:295-328`).

### D-06 CONFIRM

REVISE `install-and-onboarding.md:114` and the diagram at `install-and-onboarding.md:160`. The install verb opens the Hive portal at `http://127.0.0.1:3853/` (`src/commands/install.ts:64-74`, `src/commands/install.ts:351-356`). `src/daemon/runtime/dashboard/host.ts` is absent. Assembly says the viewable dashboard SPA is served by Hive and Honeycomb keeps the setup API routes (`src/daemon/runtime/assemble.ts:1442-1446`). The absence sentence at `install-and-onboarding.md:116` is already right (H-01).

### D-07 CONFIRM

REVISE `install-and-onboarding.md:61`. `tests/security/deploy-install-site-guard.test.ts` is absent. `.github/workflows/deploy-install-site.yaml` is absent. Do not treat that absence as a PRD bucket change.

### D-08 CONFIRM

ADD the tenancy step beside `install-and-onboarding.md:142`. `GET /setup/state`, `POST /setup/login`, and `POST /setup/migrate-from-hivemind` mount only when `daemon.config.mode === "local"` (`src/daemon/runtime/assemble.ts:1447`). The same block mounts `/setup/tenancy*` (`src/daemon/runtime/assemble.ts:1470-1477`) and wires `POST /setup/login` to the pending-link runner (`src/daemon/runtime/assemble.ts:1456-1465`). The sequence diagram at `install-and-onboarding.md:163-174` goes from device approval to `~/.deeplake/credentials.json` with no tenancy pick.

### D-09 CONFIRM

REVISE `cli-command-architecture.md:80-118` and `cli-command-architecture.md:122-128`. `src/cli/index.ts` is 89 lines. `main` builds a dispatcher, calls `parse`, then `dispatch` (`src/cli/index.ts:32-40`). Auth passthrough is `isAuthPassthrough` (`src/commands/dispatch.ts:486-492`). The set is `org`, `workspace`, `workspaces`, `project`, `whoami`, `login`, `logout` (`src/commands/contracts.ts:265-273`).

### D-10 CONFIRM

REVISE `cli-command-architecture.md:36-56`. `VERB_TABLE` (`src/commands/contracts.ts:104-237`) also has `memory`, `pollinate`, `maintenance`, `capture`, `skillify`, `asset`, `settings`, `login`, `logout`, `whoami`, `workspaces`, `project`, `start`, `stop`, `restart`, `logs`, `service-install`, `service-uninstall`, `register`, `daemon`, `harness`, `telemetry`, and `uninstall`. Prune is the verb `sessions` with subcommand `prune` (`src/commands/contracts.ts:119`, `src/commands/sessions.ts:47-55`). `skillify` is its own verb (`src/commands/contracts.ts:145`).

### D-11 CONFIRM

REVISE `cli-command-architecture.md:40`. Live `status` is `runStandardCommand` (`src/commands/dispatch.ts:412-418`), which reports service installation, process pid, `GET /health` on port 3850, Doctor registration, and log paths (`src/commands/standard-interface.ts:78-102`, `src/commands/standard-interface.ts:206-221`; Doctor check `src/cli/standard-ops.ts:203-208` and `src/cli/standard-ops.ts:415-416`). `runStatusCommand` (`src/commands/status.ts:122-128`) still describes a D1-D5 report plus org-drift heal. A search of `src/` finds no caller of `runStatusCommand` except its definition.

### D-12 CONFIRM

REVISE `cli-command-architecture.md:41`. `honeycomb dashboard` calls `launchDashboard` and keeps only `reachable` (`src/cli/runtime.ts:724-730`), then prints `dashboard: launched` or a daemon-down line (`src/commands/local-handlers.ts:232-243`). `openDashboard` returns the Hive URL (`src/dashboard/launch.ts:153-157`, `src/dashboard/launch.ts:173-178`) and has no caller under `src/` other than its export. The install verb is the path that opens the portal (`src/commands/install.ts:351-356`).

### D-13 CONFIRM

REVISE `install-and-onboarding.md:65` and the same sentence at `cli-command-architecture.md:66`. `src/commands/install.ts:46-57` imports `credentials-store.js`, `deeplake-issuer.js`, `config.js`, `onboarding/index.js`, `telemetry/fleet-registry.js`, and `telemetry/index.js` from `src/daemon/runtime/`.

### D-14 CONFIRM

REVISE `cli-command-architecture.md:72`. The install verb's `resolveEffectiveRef` is `parseRefArg(argv) ?? DEFAULT_REF` (`src/commands/install.ts:226-228`). It does not read `onboarding.ref`. Solo install with no credentials calls `loginWithDeviceFlow` from the terminal (`src/commands/install.ts:389-393`). The precedence `--ref`, then `onboarding.ref`, then `DEFAULT_REF` is the login helper in `src/daemon/runtime/auth/deeplake-issuer.ts:186-190`, which `install-and-onboarding.md:197` already describes for the device-code request.

### D-15 CONFIRM

REVISE `cli-command-architecture.md:149-175`. There is no `src/commands/auth.ts`. The function that decodes a token and re-mints is `healOrgDrift` (`src/daemon/runtime/auth/device-flow.ts:207-229`). Production session-start seams set `healDriftedOrgToken` to an empty async function (`src/hooks/shared/session-start-seams.ts:123`). `runSessionStart` calls that seam (`src/hooks/shared/session-start.ts:188`). `buildOrgDriftHealer` refuses to re-mint a credential whose `apiUrl` is `https://api.deeplake.ai` and returns `drift-surfaced` (`src/cli/runtime.ts:555-570`). That healer is reached from `runStatusCommand` (`src/commands/status.ts:127-128`), which dispatch does not call (D-11).

### D-16 CONFIRM

REVISE `cli-command-architecture.md:189-259`. There is no `src/commands/session-prune.ts`. The CLI sends `DELETE /api/diagnostics/sessions/prune` with `before` and `session-id` query params and builds no SQL (`src/commands/sessions.ts:29`, `src/commands/sessions.ts:73-81`, `src/commands/sessions.ts:97`). The daemon appends a paired `sessions` tombstone and a paired `memory` summary tombstone (`src/daemon/runtime/sessions/prune.ts:302-322`). It does not run the quoted `DELETE FROM` statements. `src/commands/storage-handlers.ts:11-18` is the path for `remember`, `recall`, `skill`, and the other generic storage verbs: one `DaemonClient` request.

### D-17 CONFIRM

REVISE `developer-workflow.md:56`. These files import `src/daemon/runtime/...`: `src/cli/runtime.ts:55-57`, `src/cli/auth.ts:52`, `src/cli/org.ts:40`, `src/cli/whoami.ts:30`, `src/cli/project.ts:55`, `src/cli/token-issuer.ts:29`, `src/cli/keys.ts:33`, `src/cli/standard-ops.ts:15`, `src/cli/harness-status.ts:37`, `src/cli/harness-reconcile.ts:56`. A search of `src/cli/` and `src/commands/` finds no import of `src/daemon/storage`. `BUILD.md:26-32` still says tier 4 may import only tier 1.

### D-18 CONFIRM

REVISE `developer-workflow.md:50`. The call is `src/cli/runtime.ts:751` inside `buildRuntimeDeps`. `src/cli/index.ts:1-13` is a file header and does not name `createLoopbackDaemonClient`. `index.ts` calls `buildRuntimeDeps()` at `src/cli/index.ts:38`. The function is exported from `src/commands/contracts.ts:471` and re-exported by `src/commands/index.ts:28`.

### D-19 CONFIRM

ADD `src/commands` to `developer-workflow.md:56`. `src/commands` is the dispatcher and the install verb, and it imports daemon runtime modules (`src/commands/install.ts:46-57`, `src/commands/dispatch.ts:1-16`). `BUILD.md:26` lists `src/cli` as tier 4 and does not list `src/commands`.

### D-20 CONFIRM

REVISE `doctor-watchdog.md:56` through `doctor-watchdog.md:147`. No `doctor/` directory exists in this checkout. Keep the page. `dashboardPortalNotRunningMessage` still names `doctor` (`src/commands/install.ts:88-93`), and `register` is a live verb (`src/commands/contracts.ts:219`). Do not move any completed PRD because `doctor/` is absent. The line that already says this checkout has no `doctor/` directory (`doctor-watchdog.md:21`) holds.

### D-21 CONFIRM

REVISE `doctor-watchdog.md:75`. Honeycomb's pid file is resolved new-first at `~/.apiary/honeycomb/daemon.pid` (`src/cli/runtime.ts:181-183`, `src/cli/runtime.ts:226-228`, `src/shared/fleet-root.ts:36`, `src/shared/fleet-root.ts:103-104`, `src/shared/constants.ts:35`). `~/.honeycomb/daemon.pid` is the legacy fallback (`src/shared/fleet-root.ts:42`, `src/shared/fleet-root.ts:144-145`). Whether Doctor itself still reads the legacy path is outside this checkout and is not a PRD move.

## Sources CLI and npm version script

Holds in this slice were checked and match the tree. They are not edits: `npm-publishing.md:136` matches `package.json:55` (six `git add` paths, no `git add -A`). `source-lifecycle.md:36-42` matches `src/commands/contracts.ts:159` and `src/commands/storage-handlers.ts:220-229` (`sources add` posts `/api/sources/add`). The daemon connect route is `POST /api/sources` (`src/daemon/runtime/sources/api.ts:187-188`).

### Infra D-04 CONFIRM

REVISE the fenced line cites in `monorepo-build-release.md:40-82`. `scripts/sync-versions.mjs:19` is `SOURCE`. `SCALAR_TARGETS` is `scripts/sync-versions.mjs:23-29` and the five paths match the quote. The marketplace loop is `scripts/sync-versions.mjs:87-111` and the logic matches. The fences cite lines 13-25 and 63-88.

### Infra D-17 CONFIRM

REVISE `source-lifecycle.md:70`. A non-read `sources` subcommand is `POST /api/sources/<subcommand>` (`src/commands/storage-handlers.ts:209-229`). If the daemon is down, `ensureDaemonRunning` returns false (`src/commands/daemon.ts:177-186`) and dispatch prints an error and returns exit 1 (`src/commands/dispatch.ts:345-350`). No CLI config-only source remover exists under `src/commands/`.

## PRD-050 installer

Recommended bucket: stay `completed/`. Do not move the folder to `in-work/`.

### Stay completed CONFIRM

`https://get.theapiary.sh/install.sh` and `https://get.theapiary.sh/install.ps1` both returned HTTP 200. The POSIX script header says it owns Node bootstrap and hands off to `honeycomb install`. `scripts/install/install.sh`, `scripts/install/install.ps1`, and `site/install/` are absent from this checkout. That absence is the same class as the missing `doctor/` and Hive trees: it does not demote this completed PRD. The CLI half is live: health gate (`src/commands/install.ts:497-511`), onboarding marker (`src/commands/install.ts:524-531`), Doctor registration (`src/commands/install.ts:533-537`), and the Hive portal open (`src/commands/install.ts:558-571`).

### Move to in-work OVERTURN

Wave 1 said move 050 to in-work only if those hosted copies are gone. They are not gone. `host.ts` and `GET /dashboard` being absent does not demote the folder.

### Index AC-1 OVERTURN

Wave 1 marked UNMET because installer scripts are absent here and the CLI verb does not install Node (`src/commands/install.ts:497-509`; embeddings remain `optionalDependencies` at `package.json:139-141`). The one command is the hosted script. It installs Node through fnm (`ensure_node`), installs the global package (which pulls the optional embedding package), then runs `"$bin" install`. The CLI verb is the handoff, not the Node installer. Do not move the folder.

### Index AC-2 OVERTURN

Do not demote. `src/daemon/runtime/dashboard/host.ts` is absent, and this checkout has no `GET /dashboard` mount. The open target is the Hive portal (`src/commands/install.ts:345-356`, `127.0.0.1:3853` from `src/shared/constants.ts:19-23`). A missing Hive tree does not move a completed PRD. The literal `GET /dashboard` sentence stays unmet in this tree and is not a bucket change.

### Index AC-7 CONFIRM

The daemon-didn't-start copy is live (`src/commands/install.ts:509-511`) and exits 1. That supports the MET mark for the CLI failure line. It does not prove every failure mode named in the criterion.

### a-AC-1 OVERTURN

Same as index AC-1. The hosted script installs Node, then calls `honeycomb install`. Wave 1's UNMET was the in-repo script absence.

### a-AC-2 CONFIRM

`ensureDaemonRunning` returns immediately when `/health` already answers (`src/commands/daemon.ts:177-178`, called at `src/commands/install.ts:501-505`). A second run does not start another bind. Re-opening the portal happens only in solo mode when the 3853 probe succeeds (`src/commands/install.ts:558-568`). Fleet mode opens nothing (`src/commands/install.ts:558-559`). The idempotent health gate is met.

### a-AC-3 OVERTURN

The elevation copy is not in this checkout. The hosted `install.sh` `elevation_required_node` prints a one-line failure plus copy-paste commands and `ensure_node` returns 1, and `legacy_main` calls `ensure_node || finish 1`. Wave 1's UNMET does not survive the hosted script. Do not move the folder.

### a-AC-4 CONFIRM

The portal open is after the health gate. If the daemon never becomes reachable, the verb prints the daemon-didn't-start line and returns exit 1 with no browser open (`src/commands/install.ts:497-511`).

### a-AC-5 OVERTURN

Both hosted scripts exist (HTTP 200). The onboarding `installed` write is the CLI verb they hand off to (`src/commands/install.ts:524-531`). The hosted script's step-3 comment says that handoff writes the marker. In-repo copies of the scripts remain absent. That does not move the folder.

### a-AC-6 CONFIRM

The `honeycomb.local` attempt is gone. `openSoloDashboard` opens loopback `127.0.0.1:3853` only (`src/commands/install.ts:345-356`). The comment at `src/commands/install.ts:68-71` says the friendly host was dropped. The hosted `install.sh` has no `honeycomb.local` string. The literal criterion stays unmet. It is not the wave-1 move trigger, and it does not move the folder.

### b-AC-1 OVERTURN

Do not demote. `GET /dashboard` returning 200 is the missing Hive/`host.ts` surface. Setup routes still mount in local mode (`src/daemon/runtime/assemble.ts:1447`). A missing Hive tree does not move a completed PRD.

### c-AC-2 OVERTURN

Wave 1 marked MET from `src/daemon/runtime/auth/deeplake-issuer.ts:167-170` and `src/commands/install.ts:227-228`. The issuer omits both headers when the effective ref trims to empty (`src/daemon/runtime/auth/deeplake-issuer.ts:186-190`). The install parser does not produce that blank: an empty `--ref` or `--ref=` falls through, and `resolveEffectiveRef` then uses `DEFAULT_REF` (`src/commands/install.ts:207-228`). `defaultInstallDeviceLogin` does not pass `ref` into `loginWithDeviceFlow` (`src/commands/install.ts:389-393`). A non-empty `--ref` is persisted first (`src/commands/install.ts:526`) and the issuer then reads `onboarding.ref`. A blank install `--ref` does not omit the header.

### e-AC-1 CONFIRM

`runInstallCommand` calls `emitTelemetry("honeycomb_installed", { ref, tier: "tier1" }, ...)` (`src/commands/install.ts:611-612`). The event name is in `TIER1_EVENTS` (`src/daemon/runtime/telemetry/emit.ts:130-132`). This confirms the install emit the wave-1 row cites. It does not by itself prove the other two events emit once.

## PRD-020 CLI criteria

Recommended bucket: keep `in-work/`. Do not move to `completed/`.

### Keep in-work CONFIRM

Index AC-3, a-AC-4, and a-AC-5 are unmet in this tree. A move to completed needs those criteria present. Cursor-extension criteria were not re-scored here. They are not required for this keep.

### Index AC-1 CONFIRM

MET. `src/cli/index.ts:32-39` builds the dispatcher and `buildRuntimeDeps()`. `src/commands/dispatch.ts:511` sends storage verbs to `dispatchStorage`. `src/commands/storage-handlers.ts:387` calls `deps.daemon.send`. `src/commands/sessions.ts:97` does the same for prune. A search of `src/cli/` and `src/commands/` finds no import of `src/daemon/storage`.

### Index AC-2 CONFIRM

UNMET for the CLI verb. `src/cli/runtime.ts:727-729` calls `launchDashboard` and returns only `rendered.connectivity.reachable`. `src/commands/local-handlers.ts:238-242` prints `launched` or `daemon is not reachable`. Whether the Hive UI paints the six panels is outside this checkout and is not a completed-PRD demotion. This folder is already in-work, and the CLI verb does not present the panels.

### Index AC-3 CONFIRM

UNMET. `src/commands/dispatch.ts:412-418` routes `status` to `runStandardCommand`, which prints service, process, and `/health` (`src/commands/standard-interface.ts:78-102`, `src/commands/standard-interface.ts:206-220`) and never calls `deps.health.evaluate()`. `runStatusCommand` would (`src/commands/status.ts:144-145`) and dispatch does not call it. `src/cli/runtime.ts:767` still binds `health: buildStatusHealthSource(daemon)`.

### a-AC-1 CONFIRM

MET. `src/commands/dispatch.ts:74-95` parses `--help`, `--version`, `--json`, `--dry-run`, and `--no-color`. `src/commands/dispatch.ts:486-492` forwards auth verbs with the full argv. The set is `src/commands/contracts.ts:265-273`. `src/cli/runtime.ts:504-530` routes those verbs to `authMain`, `whoamiMain`, `projectMain`, and `orgMain`.

### a-AC-2 CONFIRM

MET. `src/commands/sessions.ts:47-81` parses `--before` and `--session-id` and builds `DELETE /api/diagnostics/sessions/prune`. `src/commands/sessions.ts:97` sends it. The daemon appends a paired `sessions` tombstone and a paired `memory` summary tombstone for every match (`src/daemon/runtime/sessions/prune.ts:313-322`). That pairing is the product delete. The CLI builds no SQL (D-16).

### a-AC-3 CONFIRM

MET. Same daemon path as index AC-1. `src/commands/contracts.ts:244-246` marks `cls: "storage"`. `src/commands/dispatch.ts:342-389` routes `sessions`, `pollinate`, `maintenance`, `capture`, `memory`, `settings`, `asset`, and the generic storage verbs through daemon handlers. `src/commands/storage-handlers.ts:36-45` lists the daemon routes.

### a-AC-4 CONFIRM

UNMET. Production `healDriftedOrgToken` is an empty function (`src/hooks/shared/session-start-seams.ts:123`), and `runSessionStart` calls it (`src/hooks/shared/session-start.ts:188`). `healOrgDrift` can re-mint (`src/daemon/runtime/auth/device-flow.ts:222-229`), but the healer bound by `buildRuntimeDeps` refuses a real `api.deeplake.ai` credential (`src/cli/runtime.ts:564-570`), and dispatch never calls `runStatusCommand` (`src/commands/dispatch.ts:412-418`).

### a-AC-5 CONFIRM

UNMET against the named path. Device flow and mode `0600` exist. The write target is `~/.deeplake/credentials.json` (`src/daemon/runtime/auth/credentials-store.ts:66`, `src/daemon/runtime/auth/credentials-store.ts:127`, `src/daemon/runtime/auth/credentials-store.ts:534-541`). `.honeycomb` is a read-only legacy fallback (`src/daemon/runtime/auth/credentials-store.ts:67-71`). `src/cli/auth.ts:300-304` documents the shared deeplake path. `loginWithDeviceFlow` persists through `persistSelectedTenancy` (`src/daemon/runtime/auth/deeplake-issuer.ts:903-904`).

### a-AC-6 CONFIRM

MET. `src/commands/storage-handlers.ts:99-106` maps `skill scope <scope> --users a,b` to `POST /api/skills/scope` with `{ scope, users, force }`. `src/commands/storage-handlers.ts:215` routes `skill` through `buildSkillRequest`. `src/commands/storage-handlers.ts:387` sends that request.

## What wave 3 should apply

- Apply the 23 confirmed doc edits (D-01 through D-21, infra D-04, infra sources D-17).
- Leave PRD-050 in `completed/`.
- Leave PRD-020 in `in-work/`.
- Do not move a completed PRD because `doctor/`, `host.ts`, or the Hive UI is absent from this checkout.

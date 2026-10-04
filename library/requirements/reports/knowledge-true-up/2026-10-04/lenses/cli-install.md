# Lens: cli-install

Date: 2026-10-04. Repository: honeycomb. Read-only inventory of the `honeycomb` CLI against `library/knowledge/private/operations/cli-command-architecture.md`, `library/knowledge/private/operations/install-and-onboarding.md`, and `library/knowledge/private/operations/developer-workflow.md`.

Fact labels: VERIFIED (checked in this tree), REPORTED (a doc asserts it; not re-checked here), UNVERIFIABLE-HERE (needs another repo, a registry, or a live host).

The CLI was not executed. `npm install` was not run. The daemon was not started. Command names come from `src/commands/contracts.ts` `VERB_TABLE` and the handlers that parse each argv tail.

## Command inventory (VERIFIED)

Bin: `package.json` `"bin"."honeycomb"` is `bundle/cli.js` (`package.json:13-15`). esbuild writes that file from `dist/src/cli/index.js` with a Node hash-bang (`esbuild.config.mjs:355-367`).

Entry: `src/cli/index.ts` `main` parses argv through `createDispatcher()` from `src/commands/index.ts`, binds `buildRuntimeDeps()` from `src/cli/runtime.ts`, and dispatches (`src/cli/index.ts:32-40`). Direct execution is gated by `isCliEntry` so an import stays inert (`src/cli/index.ts:58-71`).

Global flags parsed before the verb: `--help` / `-h`, `--version` / `-V`, `--json`, `--dry-run`, `--no-color` (`src/commands/dispatch.ts:59-62`, `src/commands/contracts.ts:290-301`). Empty argv and `--help` print usage and exit 0. An unknown verb exits 2.

`usageText` treats 12 verbs as the standard manifest and prints the other 30 as product commands (`src/commands/dispatch.ts:126-153`). Both sets are real verbs. The standard set is `start`, `stop`, `restart`, `status`, `logs`, `install`, `uninstall`, `service-install`, `service-uninstall`, `update`, `register`, `telemetry`.

42 top-level verbs, in help order (`src/commands/contracts.ts:104-237`):

| Verb | Class | Live subcommands and flags |
|---|---|---|
| `remember` | storage | message text, optional `--type` of `fact`, `convention`, `preference`, `decision`, `gotcha`, `reference` |
| `recall` | storage | query text; no subcommand |
| `memory` | storage | `conflicts` [`resolve <id> --verdict <supersede\|review\|keep-both>`], `stale-refs`, `inspect <id> --lifecycle`, `redrive` |
| `sessions` | storage | `list`, `prune` (`--before`, `--session-id`) |
| `pollinate` | storage | `trigger` [`--compact`] only |
| `maintenance` | storage | `compact` [`--table <name>`] |
| `capture` | storage | `drain` |
| `skill` | storage | `scope`, `pull` [`--force`], `unpull`, `force`, `promote`; other words fall through to `GET /api/skills` |
| `skillify` | storage | same request builder as `skill` |
| `asset` | storage | `register`, `promote`, `demote`, `style`, `list`, `device list`, `device revoke` |
| `ontology` | storage | first non-flag word is a path segment under `/api/ontology` (read-shaped `list`/`get`/`show`/`status`/empty is GET; any other word is POST) |
| `graph` | storage | same generic pattern under `/api/graph` |
| `sources` | storage | same generic pattern under `/api/sources` |
| `goal` | storage | same generic pattern under `/api/goals` |
| `agent` | storage | same generic pattern under `/v1/agent` |
| `route` | storage | same generic pattern under `/api/inference/routes` |
| `secret` | storage | `set <name> <value>`, `rm` / `remove` / `delete` / `unset`, else names-only `list` |
| `settings` | storage | `list`, `get`, `set`, `provider`, `model` (alias of `provider`) |
| `login` | auth | device flow, or `--token <key>` |
| `logout` | auth | removes `~/.deeplake/credentials.json` and legacy `~/.honeycomb/credentials.json` |
| `whoami` | auth | no subcommand |
| `org` | auth | `list`, `switch <org>` |
| `workspace` | auth | `list`, `switch <ws>`, `use <ws>` |
| `workspaces` | auth | alias of `workspace list` |
| `project` | auth | `list`, `bind`, `use`, `status` |
| `setup` | local | connector engine; optional harness tail |
| `install` | local | `--ref <code>`, `--ref=<code>`, `--home=<path>` |
| `status` | local | standard service status (OS service plus process health) |
| `start` | local | OS service start |
| `stop` | local | OS service stop |
| `restart` | local | OS service restart |
| `logs` | local | tail the service log |
| `service-install` | local | install or reconcile the OS unit |
| `service-uninstall` | local | remove the OS unit only |
| `register` | local | register with Doctor |
| `daemon` | local | `start`, `stop`, `status` (process lifecycle) |
| `dashboard` | local | no subcommand |
| `hook` | local | `wire` (other words print a pointer to `hook wire`) |
| `harness` | local | `status` (default), `connect`, `repair` |
| `telemetry` | local | `--show`, or no args |
| `update` | local | `--check`; `--dry-run` is rewritten to `--check` |
| `uninstall` | local | full teardown, or one harness name; full teardown asks for confirmation unless `--yes` |

`connect` appears in the local switch (`src/commands/dispatch.ts:395-397`) and is absent from `VERB_TABLE`, so the dispatcher rejects it as an unknown command before that case runs. Live connect is `honeycomb harness connect`.

Modules under `src/cli/` that the bin does not call: `route.ts` (`explain`, `status`, `pin`, `unpin`, `test`, `list`, `doctor`), `ontology.ts` (`pipeline explain`, `proposals`, `assertions`, `entity merge-plan`, `stream apply`), `pollinate.ts` (`trigger`, `status`), `keys.ts` (`create`, `revoke`, `list` on a `key` verb that is not in `VERB_TABLE`). Tests import those modules. `src/cli/index.ts` does not.

## Ground truth that held (VERIFIED)

| Claim | Evidence |
|---|---|
| Published bin is `honeycomb` -> `bundle/cli.js`. From this checkout the built CLI is `node bundle/cli.js`. Node engine is `>=22.5.0`. Package is `@legioncodeinc/honeycomb` | `package.json:2-15`, `package.json:110-112` |
| `npm run build` is `tsc && node esbuild.config.mjs` after `prebuild` `sync-versions.mjs`. `npm run ci` is typecheck, dup, test, `audit:sql`. `postinstall` runs the tree-sitter and embed-deps scripts. No `start` or `dev` script in `package.json:53-91` | `package.json:53-56`, `package.json:84-85` |
| `honeycomb daemon start` success text is `daemon: started on 127.0.0.1:3850.` An already-running daemon prints `daemon: already running on 127.0.0.1:3850.` | `src/commands/daemon.ts:96-102` |
| That address is `DAEMON_HOST` / `DAEMON_PORT`. The install URL is Hive `HIVE_HOST`:`HIVE_PORT` (`127.0.0.1:3853`) | `src/shared/constants.ts:14-23`, `src/commands/install.ts:73-74` |
| The loopback client the bin binds is `createLoopbackDaemonClient` | `src/cli/runtime.ts:751` |
| `src/cli` and `src/commands` do not import `src/daemon/storage/transport` | grep of those trees |
| Installer one-liners in the portal-down message match the docs: `curl -fsSL https://get.theapiary.sh \| sh -s -- --products=honeycomb,doctor,hive` and the PowerShell `irm` form | `src/commands/install.ts:88-93` |
| Solo install opens `http://127.0.0.1:3853/` only after the 750 ms probe succeeds. Fleet mode opens no browser | `src/commands/install.ts:552-571` |
| Fleet classification is any one of a hive registry entry, a 3853 probe, or global `@legioncodeinc/hive` | `src/shared/fleet-detection.ts:208-223` |
| Onboarding ref default baked by esbuild is `mario` when `HONEYCOMB_REF_DEFAULT` is unset | `esbuild.config.mjs:48-56` |
| Windows service pin uses `set "APIARY_HOME=<root>"`. `resolveFleetRoot` trims `APIARY_HOME` and `XDG_STATE_HOME` | `src/cli/daemon-service.ts:604-609`, `src/shared/fleet-root.ts:87-91` |
| Current service label is `com.legioncode.honeycomb`. Uninstall calls `unregisterLegacy` as best-effort after the current unit | `src/cli/daemon-service.ts:56`, `src/cli/runtime.ts:640-645` |
| Product state dir is `honeycombStateDir()`: `<fleetRoot>/honeycomb`, default `~/.apiary/honeycomb` | `src/shared/fleet-root.ts:98-104` |
| `GET /setup/state` and `POST /setup/login` exist and mount only when daemon mode is `local` | `src/daemon/runtime/dashboard/setup-state.ts:58`, `src/daemon/runtime/dashboard/setup-login.ts:37`, `src/daemon/runtime/assemble.ts:1447-1454` |
| The setup-state `credentials.honeycomb` probe is `existsSync` on `~/.honeycomb`, the legacy dir name `.honeycomb` | `src/daemon/runtime/dashboard/setup-state.ts:168-172`, `src/daemon/runtime/auth/credentials-store.ts:66-71` |
| Shared login file is `~/.deeplake/credentials.json` | `src/cli/auth.ts:4-18` |
| `honeycomb sessions prune` sends `DELETE /api/diagnostics/sessions/prune`. The CLI builds no SQL | `src/commands/sessions.ts:29`, `src/commands/sessions.ts:73-80` |

`developer-workflow.md` citations for the package scripts, the bin, the `daemon start` strings, and the 3853 portal match this tree. Its tier sentence does not (finding 4).

## UNVERIFIABLE-HERE

`install-and-onboarding.md` describes `get.theapiary.sh`, the Cloudflare Pages site, `SHA256SUMS`, required reviewers on a `production` environment, and `.github/workflows/deploy-install-site.yaml` as living in `github.com/legioncodeinc/the-apiary`. This checkout has no `scripts/install/` and no `tests/security/` tree. Those remote files were not opened. Whether the live site still serves those scripts is UNVERIFIABLE-HERE. The local citation of `tests/security/deploy-install-site-guard.test.ts` is scored below because the path is absent here.

## Findings

### cli-install-1

- Doc: `library/knowledge/private/operations/cli-command-architecture.md`
- Quote: the fenced `async function main()` at `src/cli/index.ts` lines 409-445, and the `AUTH_SUBCOMMANDS.has(cmd)` block at lines 486-491.
- Grade: STALE
- Correction: `src/cli/index.ts` is 88 lines. `main` calls `createDispatcher()`, `dispatcher.parse`, `buildRuntimeDeps`, and `dispatcher.dispatch` (`src/cli/index.ts:32-40`). Help and version are global flags on that dispatcher: `--help`/`-h` and `--version`/`-V` (`src/commands/dispatch.ts:59-62`). There is no in-file `if (cmd === "setup")` ladder and no `-v` / `version` verb.
- Evidence: `src/cli/index.ts:32-40`, `src/commands/dispatch.ts:59-62`, `src/commands/dispatch.ts:449-512`. VERIFIED.

### cli-install-2

- Doc: `library/knowledge/private/operations/cli-command-architecture.md`
- Quote: `healDriftedOrgToken` in `src/commands/auth.ts` lines 217-240, and the SQL `listSessions` / `deleteSessions` functions in `src/commands/session-prune.ts`.
- Grade: STALE
- Correction: Neither file is in the tree. `honeycomb sessions list` and `sessions prune` live in `src/commands/sessions.ts` and send `GET /api/diagnostics/sessions` and `DELETE /api/diagnostics/sessions/prune` through the daemon client. The name `healDriftedOrgToken` is a hook seam (`src/hooks/shared/contracts.ts`), with an empty default in `src/hooks/shared/session-start-seams.ts`. It is not the function printed in the doc.
- Evidence: absence of `src/commands/auth.ts` and `src/commands/session-prune.ts`; `src/commands/sessions.ts:29-31`, `src/commands/sessions.ts:73-80`; `src/hooks/shared/session-start-seams.ts:123`. VERIFIED.

### cli-install-3

- Doc: `library/knowledge/private/operations/cli-command-architecture.md`
- Quote: "The full top-level command set is" the table that ends at `update`, plus "Skillify operations ... are reached under `honeycomb skill ...`" and "`org` ... (create, switch, list)".
- Grade: STALE
- Correction: The table is 19 rows. The live table has 42 verbs. Absent from the doc table: `memory`, `pollinate`, `maintenance`, `capture`, `skillify`, `asset`, `settings`, `login`, `logout`, `whoami`, `workspaces`, `project`, `start`, `stop`, `restart`, `logs`, `service-install`, `service-uninstall`, `register`, `daemon`, `harness`, `telemetry`, `uninstall`. `skillify` is its own verb and shares `skill`'s request builder. `sessions` also has `list`. `org` implements `list` and `switch`. `workspace` implements `list`, `switch`, and `use`. There is no `create` subcommand on either.
- Evidence: `src/commands/contracts.ts:104-237`, `src/commands/storage-handlers.ts:209-215`, `src/cli/org.ts:374-379`. VERIFIED.

### cli-install-4

- Doc: `cli-command-architecture.md`, `install-and-onboarding.md`, and `developer-workflow.md`
- Quote: "it is a thin daemon client, never a daemon-core import" (both operations pages) and "Tier 4 code (`src/cli` ...) does not import `src/daemon`" (`developer-workflow.md`).
- Grade: FALSE
- Correction: `src/commands/install.ts` imports daemon auth, config, onboarding, and telemetry (`src/commands/install.ts:46-57`). `src/cli/runtime.ts`, `auth.ts`, `org.ts`, `project.ts`, `whoami.ts`, `token-issuer.ts`, `standard-ops.ts`, and `harness-status.ts` import `src/daemon/runtime`. Those imports do not include `src/daemon/storage/transport`. The sentence that the CLI never opens DeepLake still matches this tree.
- Evidence: `src/commands/install.ts:46-57`, `src/cli/runtime.ts:55-57`, `src/cli/harness-status.ts:37`. VERIFIED.

### cli-install-5

- Doc: `cli-command-architecture.md` (install verb section) and `install-and-onboarding.md` ("The `honeycomb install` verb")
- Quote: onboarding write is fail-soft and "never fails the install"; the architecture page then says the verb opens the dashboard at `http://127.0.0.1:3853/`.
- Grade: STALE
- Correction: A failed onboarding-marker write exits 1 (`src/commands/install.ts:526-529`). Doctor registration is a later required phase and also exits 1 (`src/commands/install.ts:533-537`). Harness wiring runs after that and is fail-soft (`src/commands/install.ts:545-550`). The browser opens only in solo mode, and only when the 750 ms portal probe succeeds (`src/commands/install.ts:558-571`). The install doc's later "Open the dashboard, honestly" paragraph already describes the probe. Its step 2 still says the marker write never fails the install.
- Evidence: `src/commands/install.ts:523-571`. VERIFIED.

### cli-install-6

- Doc: `library/knowledge/private/operations/install-and-onboarding.md`
- Quote: "`honeycomb start` and `honeycomb stop` run the daemon lifecycle directly; the older `honeycomb daemon start|stop|status` forms are kept as aliases".
- Grade: FALSE
- Correction: Bare `start` and `stop` call `runStandardCommand`, which drives the installed OS service (`src/commands/dispatch.ts:419-424`, `src/cli/standard-ops.ts:305-326`). Success text is `Honeycomb started through its installed OS service.` The `daemon` verb is a separate route to `runDaemonCommand` (`src/commands/dispatch.ts:425-426`) and prints `daemon: started on 127.0.0.1:3850.` `developer-workflow.md` describes that `daemon` wording and matches `src/commands/daemon.ts:96-102`.
- Evidence: `src/commands/dispatch.ts:419-426`, `src/cli/standard-ops.ts:305-315`, `src/commands/daemon.ts:96-102`. VERIFIED.

### cli-install-7

- Doc: `library/knowledge/private/operations/install-and-onboarding.md`
- Quote: "The Honeycomb daemon already serves a self-hydrating, token-free dashboard shell over loopback (`renderShell` / `mountDashboardHost` in `src/daemon/runtime/dashboard/host.ts`)" and later "serves `GET /dashboard`".
- Grade: FALSE
- Correction: `src/daemon/runtime/dashboard/host.ts` is absent. The install verb opens the Hive portal at `http://127.0.0.1:3853/`. `GET /setup/state` and `POST /setup/login` are mounted in local mode (`src/daemon/runtime/assemble.ts:1442-1454`). The same page's `credentials.honeycomb` comment matches a legacy `~/.honeycomb` existsSync probe (`src/daemon/runtime/dashboard/setup-state.ts:168-172`). Installer-owned product state is `honeycombStateDir()`, default `~/.apiary/honeycomb` (`src/shared/fleet-root.ts:98-104`).
- Evidence: absence of `src/daemon/runtime/dashboard/host.ts`; `src/commands/install.ts:64-74`; `src/daemon/runtime/assemble.ts:1442-1454`. VERIFIED.

### cli-install-8

- Doc: `library/knowledge/private/operations/cli-command-architecture.md`
- Quote: "`route` | Manage routing rules between agents and tables" and "`ontology` | Inspect and edit the memory ontology", illustrated as if those were dedicated CLI programs.
- Grade: STALE
- Correction: The bin's `route`, `ontology`, `graph`, `sources`, `goal`, and `agent` verbs use the generic storage mapper in `src/commands/storage-handlers.ts:220-229`. The dedicated parsers in `src/cli/route.ts` and `src/cli/ontology.ts` are not imported by `src/cli/index.ts` or `src/commands/dispatch.ts`. Live `pollinate` accepts only `trigger` [`--compact`] (`src/commands/pollinate.ts:135-139`). `src/cli/pollinate.ts` still documents `pollinate status`, and `src/cli/keys.ts` documents `key create|revoke|list`. Neither is on the bin. `honeycomb connect` is an unknown command; `honeycomb harness connect` is the live connect.
- Evidence: `src/commands/storage-handlers.ts:36-47`, `src/commands/storage-handlers.ts:220-229`, `src/commands/pollinate.ts:135-139`, `src/cli/ontology.ts:25-27`. VERIFIED.

### cli-install-9

- Doc: `library/knowledge/private/operations/install-and-onboarding.md`
- Quote: "regression-locked by `tests/security/deploy-install-site-guard.test.ts`, which parses the workflow YAML".
- Grade: STALE
- Correction: This checkout has no `tests/security/` directory and no `scripts/install/`. The cited test cannot lock a workflow that is not in this tree. The the-apiary workflow itself is UNVERIFIABLE-HERE.
- Evidence: glob of `tests/security/**` and `scripts/install/**` returned no files. VERIFIED for this tree. Remote workflow: UNVERIFIABLE-HERE.

### cli-install-10

- Doc: `library/knowledge/private/operations/install-and-onboarding.md`
- Quote: "Solo mode with credentials already present: the installer opens nothing."
- Grade: OVERCLAIMED
- Correction: That branch skips the device-flow browser and prints `already signed in` (`src/commands/install.ts:437-441`). After login, solo mode still probes `http://127.0.0.1:3853/` and opens it when the probe succeeds (`src/commands/install.ts:560-568`). Fleet mode is the path that opens no browser (`src/commands/install.ts:558-559`).
- Evidence: `src/commands/install.ts:437-444`, `src/commands/install.ts:552-571`. VERIFIED.

### cli-install-11

- Doc: `library/knowledge/private/operations/install-and-onboarding.md`
- Quote: "When nothing is installed, `uninstall` is a friendly exit-0 no-op rather than an error, so re-running or running it on a clean machine is safe."
- Grade: OVERCLAIMED
- Correction: A full uninstall with no harness argument prompts `Remove Honeycomb's service, Doctor registration, and product-owned state?` unless `--yes` is passed (`src/commands/dispatch.ts:306-328`). `--json` without `--yes` exits 2 with `Uninstall requires explicit confirmation`. After confirmation, a machine that removed nothing prints `uninstall: nothing to remove` followed by `Honeycomb was not installed here.` and can exit 0 (`src/commands/local-handlers.ts:149-153`). The ordered phases (stop, unregister current unit, legacy unregister best-effort, delete the registry entry, remove `honeycombStateDir()`, then reverse harness hooks) match the page's three-part teardown (`src/commands/local-handlers.ts:170-207`, `src/cli/runtime.ts:625-653`).
- Evidence: `src/commands/dispatch.ts:295-332`, `src/commands/local-handlers.ts:133-163`. VERIFIED.

## Punch list

Every stale or false claim verified above. Grades: STALE, FALSE, OVERCLAIMED.

| id | doc | stale claim | grade | correction | evidence |
|---|---|---|---|---|---|
| 1 | `operations/cli-command-architecture.md` | Dispatcher source is the `main()` ladder at `src/cli/index.ts:409-491`, including `-v` / `version` | STALE | 88-line entry uses `createDispatcher()`. Version flags are `--version` and `-V` | `src/cli/index.ts:32-40` |
| 2 | `operations/cli-command-architecture.md` | Drift heal is `src/commands/auth.ts`; prune SQL is `src/commands/session-prune.ts` | STALE | Those files are absent. Prune is a daemon DELETE. The heal name is a hook seam | `src/commands/sessions.ts:73-80` |
| 3 | `operations/cli-command-architecture.md` | The printed table is the full command set; skillify is only `honeycomb skill`; org has `create` | STALE | 42 verbs. `skillify` is its own verb. `org` is `list` and `switch` | `src/commands/contracts.ts:104-237` |
| 4 | `operations/cli-command-architecture.md`, `install-and-onboarding.md`, `developer-workflow.md` | Install and Tier 4 CLI code never import `src/daemon` | FALSE | `src/commands/install.ts` and `src/cli/*` import `src/daemon/runtime`. They do not import the DeepLake transport | `src/commands/install.ts:46-57` |
| 5 | `operations/cli-command-architecture.md`, `install-and-onboarding.md` | Onboarding marker write never fails install; architecture page then always opens the dashboard | STALE | Marker failure and Doctor registration failure exit 1. Browser open is solo-only and probe-gated | `src/commands/install.ts:523-571` |
| 6 | `operations/install-and-onboarding.md` | Bare `start`/`stop` are the daemon lifecycle; `daemon start\|stop\|status` are aliases | FALSE | Bare verbs drive the OS service. `daemon` is a separate process-lifecycle route | `src/commands/dispatch.ts:419-426` |
| 7 | `operations/install-and-onboarding.md` | Daemon serves the dashboard via `host.ts` `renderShell` / `mountDashboardHost` and `GET /dashboard` | FALSE | `host.ts` is gone. Browser target is Hive `:3853`. Setup APIs still mount in local mode. `~/.honeycomb` in the setup probe is the legacy dir; state root is `~/.apiary/honeycomb` | `src/commands/install.ts:64-74`, `src/shared/fleet-root.ts:98-104` |
| 8 | `operations/cli-command-architecture.md` | `route` and `ontology` are the dedicated CLI programs under `src/cli/` | STALE | Bin uses the generic storage mapper. `src/cli/route.ts`, `ontology.ts`, `pollinate.ts`, and `keys.ts` are off the bin. Live pollinate is `trigger` only | `src/commands/storage-handlers.ts:220-229` |
| 9 | `operations/install-and-onboarding.md` | `tests/security/deploy-install-site-guard.test.ts` locks the installer-site workflow | STALE | That test is not in this tree. The the-apiary workflow is UNVERIFIABLE-HERE | no `tests/security/` directory |
| 10 | `operations/install-and-onboarding.md` | Solo mode with credentials already present opens nothing | OVERCLAIMED | Login skips the device-flow browser. Solo mode still opens `:3853` when the portal probe succeeds | `src/commands/install.ts:437-441`, `src/commands/install.ts:560-568` |
| 11 | `operations/install-and-onboarding.md` | Uninstall on a clean machine is an immediate exit-0 no-op | OVERCLAIMED | Full uninstall prompts unless `--yes`. The nothing-to-remove line runs after that confirm. `--json` without `--yes` exits 2 | `src/commands/dispatch.ts:306-328` |

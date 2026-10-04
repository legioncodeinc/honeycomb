# CLI Command Architecture

> Category: Operations | Version: 1.1 | Date: October 2026 | Status: Active

Architecture of the Honeycomb unified command-line tool, subcommand dispatching, authentication flows, and operational database commands routed through the daemon.

**Related:**
- [`../auth/auth-architecture.md`](../auth/auth-architecture.md)
- [`../architecture/daemon-surface.md`](../architecture/daemon-surface.md)
- [`../overview.md`](../overview.md)
- [`../architecture/system-overview.md`](../architecture/system-overview.md)
- [`notifications-and-health.md`](notifications-and-health.md)
- [`install-and-onboarding.md`](install-and-onboarding.md)
- [`../infrastructure/monorepo-build-release.md`](../infrastructure/monorepo-build-release.md)

---

## Why this architecture exists

Honeycomb is built with a single unified command-line interface (CLI) to reduce complexity for users and developers. Rather than requiring distinct setup tools for each of the six supported coding assistants, the global `honeycomb` executable handles all environments. It performs auto-detection of assistants, wires local plugin shims, synchronizes codebase graphs, and hosts secure authentication controls.

The CLI is a thin client of the Honeycomb daemon (port 3850). It never opens the DeepLake backend directly; commands that touch memory, sessions, the codebase graph, or any other table issue requests to the daemon, which is the only process that talks to DeepLake. This keeps the CLI fast to start and means storage, encryption, and tenancy logic live in exactly one place.

The design relies on a split:
* **The Unified Entry Point (`src/cli/index.ts`):** `main` builds a dispatcher, calls `parse`, then `dispatch` (`src/cli/index.ts:32-40`). The file is 88 lines. It does not branch on each verb.
* **The Command Handlers (`src/commands/`):** The dispatcher and the verb handlers. Storage verbs are one `DaemonClient` request. The install verb and several account modules also import `src/daemon/runtime`. They do not import `src/daemon/storage`.

This split guarantees that CLI presentation details never entangle core storage, encryption, or synchronization logic.

---

## Command surface

The merged Honeycomb CLI consolidates the hivemind product verbs with our memory engine's verbs into one dispatcher. The full top-level command set is:

| Command | Purpose |
|---|---|
| `install` | Health-gate the daemon, stamp the onboarding marker, register with Doctor, run solo-vs-fleet login, wire harness hooks best-effort, and open the Hive portal in solo mode |
| `setup` | Detect installed assistants, wire hooks, and bring up the daemon |
| `status` | Report OS-service installation, process pid, `GET /health` on port 3850, Doctor registration, and log paths |
| `dashboard` | Print whether the daemon is reachable. It does not open the Hive portal |
| `remember` | Write a memory entry to the `memory` table via the daemon |
| `recall` | Query memory (lexical + semantic) via the daemon |
| `memory` | Lifecycle: conflicts, stale refs, and inspect |
| `sessions` | List or prune captured sessions through the daemon. Prune is the subcommand `sessions prune` |
| `pollinate` | Trigger a pollinating consolidation pass on the daemon |
| `maintenance` | Run version-history compaction over version-bumped tables |
| `capture` | Drain the durable capture retry outbox on the daemon |
| `agent` | Manage `agent_id` scoping and per-agent settings |
| `ontology` | Inspect and edit the memory ontology |
| `secret` | Store and retrieve scoped secrets |
| `skill` | Skillify scope, pull, unpull, and force operations (team skills sharing) |
| `skillify` | Its own verb: pull team skills from the daemon |
| `asset` | Register, promote, demote, and style skills and agents |
| `hook` | Inspect and re-wire lifecycle hooks for each assistant |
| `route` | Manage routing rules between agents and tables |
| `sources` | Register and sync external source connectors |
| `graph` | Build, query, and inspect the codebase graph |
| `goal` | Manage org and session goals surfaced in agent context |
| `settings` | Get, set, and list vault settings, plus the provider-to-model selector |
| `login` | Authenticate via device flow, or `--token` for headless |
| `logout` | Remove the shared credentials and sign out |
| `whoami` | Show the authenticated user, org, and workspace |
| `org` | Organization administration (create, switch, list) |
| `workspace` | Workspace administration within the active org |
| `workspaces` | List workspaces in the active org |
| `project` | List, bind, and use projects, and show the resolved per-folder scope |
| `start` | Start the installed OS service and verify health |
| `stop` | Stop the installed OS service |
| `restart` | Restart the service and verify health |
| `logs` | Tail Honeycomb's service log |
| `service-install` | Install or reconcile the OS service |
| `service-uninstall` | Remove only the OS service definition |
| `register` | Register Honeycomb with Doctor |
| `daemon` | `start`, `stop`, or `status` the loopback daemon on port 3850. Separate from bare `start` and `stop` |
| `harness` | Status, connect, or repair harness plugin wiring |
| `telemetry` | Show what adoption telemetry has been or would be sent |
| `update` | Self-update the CLI, daemon, and bundles |
| `uninstall` | Reverse Honeycomb's service, Doctor registration, and product-owned state |

The live set is `VERB_TABLE` (`src/commands/contracts.ts:104-237`). `skillify` is its own verb (`src/commands/contracts.ts:145`) in addition to `skill`. Skillify operations that the hivemind docs referenced as `hivemind skillify ...` are also reached under `honeycomb skill ...` (for example `honeycomb skill scope team --users alice,bob` and `honeycomb skill pull --force`). `org`, `workspace`, `workspaces`, `project`, `whoami`, `login`, and `logout` are auth passthrough (`src/commands/contracts.ts:265-273`).

Live `status` is `runStandardCommand` (`src/commands/dispatch.ts:412-418`). It reports service installation, process pid, `GET /health` on port 3850, Doctor registration, and log paths (`src/commands/standard-interface.ts:78-102`, `src/commands/standard-interface.ts:206-221`). `runStatusCommand` (`src/commands/status.ts:122-128`) still describes a D1-D5 report plus org-drift heal. A search of `src/` finds no caller of `runStatusCommand` except its definition. Dispatch does not call it.

`honeycomb dashboard` calls `launchDashboard` and keeps only `reachable` (`src/cli/runtime.ts:724-730`), then prints `dashboard: launched` or a daemon-down line (`src/commands/local-handlers.ts:232-243`). `openDashboard` returns the Hive URL (`src/dashboard/launch.ts:153-178`) and has no caller under `src/` other than its export. The install verb is the path that opens `http://127.0.0.1:3853/`.

---

## The `install` verb: bootstrap entry

`honeycomb install [--ref <code>]` (`src/commands/install.ts`) is the verb the one-command installer scripts hand off to once the global package is laid down. It is the "open logic lives once" seam: the two shell entrypoints (`install.sh`/`install.ps1`) own only the host bootstrap (detect/install Node+npm, pull embedding deps, `npm i -g`), then invoke this verb for everything between "package installed" and "browser open on the dashboard," so the daemon-ensure + health-gate + dashboard-open logic stays in one unit-tested TypeScript place rather than duplicated across two shell dialects.

The verb imports daemon runtime modules (`credentials-store.js`, `deeplake-issuer.js`, `config.js`, `onboarding/index.js`, `telemetry/fleet-registry.js`, and `telemetry/index.js` at `src/commands/install.ts:46-57`). It does not import `src/daemon/storage`.

1. **Health-gate the daemon** via `ensureDaemonRunning`. An already-healthy daemon is a no-op, never a second bind of `127.0.0.1:3850`. If the daemon never becomes reachable, the verb prints "daemon didn't start" plus a retry hint and returns exit 1.
2. **Persist the onboarding marker**, `phase: "installed"` plus the effective referral code, into `~/.deeplake/onboarding.json`. `writeInstalledMarker` returns false on an IO error, and the verb then fails the install with exit 1. It does not warn and continue.
3. **Register with Doctor.** A false registry write fails the install with exit 1 (`src/commands/install.ts:533-537`).
4. **Solo versus fleet login.** Fleet mode opens no browser. Solo mode with no credentials calls `loginWithDeviceFlow` from the terminal (`src/commands/install.ts:389-393`). Solo mode with credentials skips that device-flow browser. Login failure does not change the install exit code.
5. **Wire harness hooks, best-effort** (`src/commands/install.ts:550`, `src/commands/install.ts:463-478`). A setup failure prints one line and does not fail the install.
6. **Open the dashboard in solo mode only**, at `http://127.0.0.1:3853/` when the 750 ms probe answers (`src/commands/install.ts:64-74`, `src/commands/install.ts:351-356`, `src/commands/install.ts:558-568`). Fleet mode opens nothing. `openLocalDashboardUrl` accepts a host of `127.0.0.1`, `localhost`, or `::1` (`src/commands/install.ts:123-130`).

The install verb's `resolveEffectiveRef` is `parseRefArg(argv) ?? DEFAULT_REF` (`src/commands/install.ts:226-228`). It does not read `onboarding.ref`. The precedence `--ref`, then `onboarding.ref`, then the build-time default (`__HONEYCOMB_REF_DEFAULT__`, shipped `mario`) is the login helper in `src/daemon/runtime/auth/deeplake-issuer.ts:186-190`. [Install and Onboarding](install-and-onboarding.md) describes that helper for the device-code request. The full onboarding lifecycle, the Hive portal, the on-page device flow, Hivemind migration, and adoption telemetry are documented there.

---

## Command Dispatching

`src/cli/index.ts` is 88 lines. `main` builds a dispatcher, calls `parse`, then `dispatch`, and `buildRuntimeDeps()` supplies the bound handlers (`src/cli/index.ts:32-40`). Parsing and routing live in `src/commands/dispatch.ts`. `main` does not branch on `setup`, `login`, `skill`, or `route`. Auth passthrough is `isAuthPassthrough` (`src/commands/dispatch.ts:486-492`). The set is `org`, `workspace`, `workspaces`, `project`, `whoami`, `login`, and `logout` (`src/commands/contracts.ts:265-273`). Those verbs forward the full argument array to the auth dispatcher. Storage verbs go to `dispatchStorage`. Local verbs go to `dispatchLocal`.

---

## Authentication and Device Authorization Flow

Honeycomb relies on the RFC 8628 Device Authorization Flow to handle sign-ins securely. This enables headless installs, remote-SSH environments, and local terminals to authenticate against the DeepLake cloud without manual token generation.

The flow operates as follows:
1. **Device Code Request:** The client calls `/auth/device/code` on the API and receives a verification URI and user code.
2. **User Authorization:** The client opens the default browser pointing to the complete URI or instructs the user to open it manually.
3. **Token Polling:** The client polls the `/auth/device/token` endpoint at the prescribed interval. If the authorization is pending, it continues; if verified, it receives a short-lived token.
4. **Credential Storage:** The token is validated against the `/me` endpoint, a preferred organization is selected (supporting overrides like `HONEYCOMB_ORG_ID`), and a long-lived API token is minted through the `/users/me/tokens` endpoint.
5. **Serialization:** Credentials are written to the shared `~/.deeplake/credentials.json` (byte-compatible with Hivemind; PRD-023) with user-private filesystem permissions (`0600`). See [`../security/credential-storage.md`](../security/credential-storage.md).

The daemon reads the same credential file at startup, so once the CLI logs in, every hook and the daemon share one authenticated identity.

### Resolving Token Drift

A known challenge in multi-tenant SaaS environments is JWT organization drift. If a user switches organizations through the CLI, their stored active organization ID changes, but their existing org-bound JWT API token remains unchanged. This causes queries to execute against the previous tenant space or fail due to invalid claims.

There is no `src/commands/auth.ts`. The function that decodes a token and re-mints is `healOrgDrift` (`src/daemon/runtime/auth/device-flow.ts:207-229`). Production session-start seams set `healDriftedOrgToken` to an empty async function (`src/hooks/shared/session-start-seams.ts:123`). `runSessionStart` calls that seam (`src/hooks/shared/session-start.ts:188`), so the live hook does not re-mint. `buildOrgDriftHealer` refuses to re-mint a credential whose `apiUrl` is `https://api.deeplake.ai` and returns `drift-surfaced` (`src/cli/runtime.ts:555-570`). That healer is reached from `runStatusCommand` (`src/commands/status.ts:127-128`), which dispatch does not call. Live `status` is `runStandardCommand`.

---

## Operational Database Management: Session Pruning

`honeycomb sessions prune` is the verb `sessions` with subcommand `prune` (`src/commands/contracts.ts:119`, `src/commands/sessions.ts:47-55`). There is no `src/commands/session-prune.ts`.

The CLI sends `DELETE /api/diagnostics/sessions/prune` with `before` and `session-id` query params and builds no SQL (`src/commands/sessions.ts:29`, `src/commands/sessions.ts:73-81`, `src/commands/sessions.ts:97`). The daemon appends a paired `sessions` tombstone and a paired `memory` summary tombstone for every match (`src/daemon/runtime/sessions/prune.ts:302-322`). It does not run the `DELETE FROM` statements this page used to quote. That pairing is what keeps traces and summaries from desyncing.

`src/commands/storage-handlers.ts:11-18` is the path for `remember`, `recall`, `skill`, and the other generic storage verbs: one `DaemonClient` request. The CLI does not open DeepLake.

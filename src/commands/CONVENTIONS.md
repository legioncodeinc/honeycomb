# Unified CLI command surface — CONVENTIONS (PRD-020a)

The unified `honeycomb` command surface lives under `src/commands/`. `src/cli/index.ts` is the
ENTRY POINT (global-flag parse → route); `src/commands/*` are the HANDLERS. Wave 1 (this scaffold)
ships contracts + seams + honest stubs; Wave 2 fills the handler bodies and rewires
`src/cli/index.ts` onto `createDispatcher()`.

**Read this file before filling a handler.**

## The central invariant: the CLI is a THIN CLIENT — storage verbs go through the daemon

This is the rule the whole sub-PRD is built around (FR-3 / a-AC-3 / D-2), and a Wave-3 security target.

- **Module home = `src/commands/` ON PURPOSE.** Added to `NON_DAEMON_ROOTS`
  (`tests/daemon/storage/invariant.test.ts`, D-2). A stray `from ".../daemon/storage"` import here
  FAILS the build — the thin-client invariant is ENFORCED.
- **The `DaemonClient` seam is the ONLY path to a storage verb.** `interface DaemonClient {
  send(req): Promise<DaemonResponse>; ping() }` (`contracts.ts`). The real impl is a thin loopback
  `fetch` to `127.0.0.1:3850` stamping actor/scope headers from the shared credential; the fake
  (`createFakeDaemonClient`) records every call. A handler dispatches INTENT (route + body), never
  SQL — the daemon builds + guards the SQL.
- **`isStorageVerb(verb)` is the proof predicate** for a-AC-3: every `cls: "storage"` verb in
  `VERB_TABLE` routes through `deps.daemon`. A Wave-2 test asserts each storage verb dispatched the
  expected route and NO DeepLake path was importable.
- **NEVER import** `createStorageClient`, `StorageClient`, or anything under `daemon/storage` that
  opens a connection.

## The merged verb table (FR-2) — one dispatcher, three routing classes

`VERB_TABLE` (`contracts.ts`) is the single source. Each verb is one of:

| Class      | Reaches its effect via                          | Verbs |
|------------|-------------------------------------------------|-------|
| `storage`  | the `DaemonClient` seam → `/api/...`            | remember, recall, agent, ontology, secret, skill, route, sources, graph, goal, sessions |
| `auth`     | passthrough to the auth dispatcher (FR-4)       | org, workspace (+ login/logout via `AUTH_SUBCOMMANDS`) |
| `local`    | local FS / process / connector engine (D-4)     | setup, status, dashboard, hook, uninstall, update |

`AUTH_SUBCOMMANDS` (org/workspace/login/logout) pass their FULL argv tail to `src/cli/org.ts` /
`src/cli/auth.ts` — the dispatcher does NOT re-parse their subcommands (FR-4 / a-AC-1).

## D-4 — setup/connect/uninstall REUSE the 019a connector engine

`runConnectorVerb` (`local-handlers.ts`) delegates to `src/connectors` (`connectorMain` /
`HarnessConnector`). Do NOT fork a second hook-merge engine — the foreign-preserve +
`writeJsonIfChanged` idempotency + reversible-uninstall rules are the 019a engine. The CLI verb is a
thin route onto it.

## D-3 — `sessions prune` is the load-bearing correctness rule (a-AC-2)

`sessions.ts`: `prune` dispatches `DELETE /api/sessions/prune` with the `--before` / `--session-id`
filter; the DAEMON deletes the `sessions` trace rows AND the paired
`/summaries/<user>/<sessionId>.md` `memory` summary rows in ONE atomic operation so they never
desync. The CLI builds NO SQL. The daemon-side handler (append-only soft-delete, the DeepLake
unreliable-DELETE lesson) is scaffolded in `src/daemon/` (Wave 2 fills it).

## `status` consumes 020d health, it does not own it (D-1 boundary)

`status.ts` reaches the D1–D5 dimensions through the `StatusHealthSource` STRUCTURAL seam (not a
020d import) so 020a + 020d fill in parallel. Wave 2 binds the real `HealthCheck` from
`src/notifications/health.ts`. Connectivity is `deps.daemon.ping()`; login reads the shared
credential; health is the 020d seam.

## Wave 2 (landed) — the dispatcher + handlers are filled

- `dispatch.ts` routes by verb class: `auth` → `deps.auth` passthrough (FULL argv, FR-4),
  `storage` → the `DaemonClient` seam (sessions to its paired-delete module, every other storage
  verb to `runStorageVerb`), `local` → the connector/dashboard/status/hook/update handlers.
- `storage-handlers.ts` builds one `DaemonRequest` per verb shape (`buildStorageRequest`); `skill`
  maps scope/pull/unpull/force onto `/api/skills/*` (a-AC-6). No SQL is built — the daemon owns it.
- `sessions.ts` dispatches the prune INTENT (`DELETE /api/diagnostics/sessions/prune`). `server.ts`
  mounts NO `/api/sessions` group, so — like 020b — sessions attach off the mounted
  `/api/diagnostics` group. The daemon-side paired delete is `src/daemon/runtime/sessions/prune.ts`.
- `status.ts` runs the 011b `healOrgDrift` (FR-8 / a-AC-4) via the `OrgDriftHealer` seam, then
  renders connectivity + login + the D1–D5 health (`healthSourceFromCheck` adapts 020d's
  `HealthCheck`).
- `local-handlers.ts` routes setup/connect/uninstall to the 019a engine via the `ConnectorRunner`
  seam (D-4); `src/connectors/cursor.ts` (the `CursorConnector` sibling of `claude-code.ts`) is the
  Cursor harness the engine wires.
- `src/cli/index.ts` is rewired onto `createDispatcher()` + the real `createLoopbackDaemonClient`.

## Deferred assembly (honest deferral — mirrors prior PRDs, D-7)

Constructed-and-tested behind seams; NOT claimed live-wired end to end. The bin (`bundle/cli.js`)
constructs the dispatcher + the real loopback `DaemonClient` (storage verbs dispatch for real),
but the per-HANDLER seams are bound by the daemon-assembly step that owns the credential + the
concrete sources — until then a verb needing an unbound seam prints an honest "not wired in this
build" line. Deferred bindings:
1. the `AuthPassthrough` seam → the real `orgMain`/`authMain` (with their `TokenIssuer`).
2. the `status` `OrgDriftHealer` → 011b `healOrgDrift` + the `StatusHealthSource` → 020d's
   `HealthCheck` (with its real probes).
3. the `ConnectorRunner` → 019a `connectorMain` over a real `ConnectorFs` + the cursor/claude-code
   registry, for setup/connect/uninstall.
4. the `DashboardLauncher` → 020b `launchDashboard` for `dashboard`.
5. the live daemon assembly calling `attachSessionsPrune(...)` once after `createDaemon(...)`, and
   the real `update` self-update fetch.

## esbuild / bundle note for Wave 2

`bundle/cli.js` is built from `dist/src/cli/index.js` (esbuild.config.mjs §5). When Wave 2 rewires
`src/cli/index.ts` to import `src/commands/*`, the handlers are pulled into the CLI bundle
TRANSITIVELY — no new esbuild entry is needed (the CLI bundle already externalizes `node:*` +
native deps; the command handlers are pure TS + the daemon seam). No esbuild change required for
this wave (the stub `index.ts` imports nothing from `src/commands`).

## jscpd

Storage verbs share one `runStorageVerb` body (parameterized by verb) rather than a fetch per verb,
to stay under the duplication floor (jscpd threshold 7). Keep the per-verb mapping in
`buildStorageRequest`, not copy-pasted handlers.

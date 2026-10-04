# Lens: knowledge-surfaces

Date: 2026-10-04. Read-only comparison of private knowledge under `library/knowledge/private/` (`frontend/`, `dashboard/`, `integrations/`, `standards/`, `security/`, `auth/`, `collaboration/`, `multi-tenant/`, `sources/`) to `harnesses/`, `mcp/`, `src/cli`, `src/commands`, `src/dashboard`, `src/daemon/runtime/auth`, `sdk/` (published export target), `src/sdk/`, and `src/shared`.

Status labels: VERIFIED means this checkout was read and the correction follows from those files. REPORTED means a prior note was not re-checked. UNVERIFIABLE-HERE means the claim depends on a tree this repo does not contain.

No secrets are copied. Placeholder token shapes from the docs are shortened.

## Ground that held

- Root `package.json` `name` is `@legioncodeinc/honeycomb`. `exports` maps `.` to `./sdk/index.js` and `./react`, `./vercel`, `./openai` to the matching `sdk/*.js` files. Source lives in `src/sdk/`. There is no separate `@honeycomb/sdk` package in this repo.
- Six harness directories exist: `harnesses/claude-code`, `codex`, `cursor`, `hermes`, `pi`, `openclaw`.
- `src/cli/connector-runner.ts` `createConnectorRegistry` registers only `claude-code`, `codex`, and `cursor`. That matches `integrations/harness-integration.md` calling Hermes, pi, and OpenClaw not-yet production connector paths. Hook shims for all six still exist under `src/hooks/<harness>/shim.ts`, and esbuild builds hook bundles for five plus a separate OpenClaw bundle.
- Dashboard TypeScript in this repo is `src/dashboard/` (`launch.ts`, `views.ts`, `html.ts`, `dashboard.ts`, `contracts.ts`, `logs.ts`, `index.ts`). There is no `src/dashboard/web/`. Cursor extension source is `harnesses/cursor/extension/` and has no `package.json`.
- `src/shared/constants.ts` sets `DAEMON_PORT` 3850, `DAEMON_HOST` `127.0.0.1`, `HIVE_PORT` 3853, `HIVE_HOST` `127.0.0.1`. `openDashboard` in `src/dashboard/launch.ts` returns the Hive portal URL at `/`.
- `mcp/src/tools.ts` lists 19 tools (15 unconditional plus 4 conditional codebase tools). `memory_modify` requires `path`, `content`, and `reason`.
- `src/daemon/runtime/server.ts` records that no CORS middleware is mounted. `POST /api/actions/{logout,embeddings,restart,uninstall}` exist. Claude Code `SessionStart` timeout in `harnesses/claude-code/hooks/hooks.json` is 30.
- Device-flow credentials are `~/.deeplake/credentials.json` at mode `0o600`, with a read fallback to `~/.honeycomb/credentials.json`, in `src/daemon/runtime/auth/credentials-store.ts`. Stub bearer prefix `hcmt.v1.` is rejected in team and hybrid modes.

## Punch list

### knowledge-surfaces-1

- Doc: `library/knowledge/private/integrations/mcp-and-sdk.md` (The SDK)
- Quote: "`@honeycomb/sdk` is a typed HTTP client" and `import { HoneycombClient } from "@honeycomb/sdk"` then `new HoneycombClient({ daemonUrl: "http://localhost:3850", token: "Bearer hc_sk_...", actor, actorType })`.
- Grade: High
- Status: VERIFIED
- Correction: Import from `@legioncodeinc/honeycomb`. `HoneycombClient` is an interface in `src/sdk/contracts.ts`. Construct with `createHoneycombClient` from `src/sdk/index.ts` / `src/sdk/client.ts`. Options use `daemonUrl`, `actor`, and `actorType`. The client itself writes `Authorization: Bearer ${token}`, so a token value must be the raw secret, not a string that already starts with `Bearer `.
- Evidence: `package.json` (`name`, `exports`); `src/sdk/index.ts`; `src/sdk/contracts.ts` (`HoneycombClient`, `HoneycombClientOptions`); `src/sdk/client.ts` (`createHoneycombClient`, authorization header); `src/sdk/CONVENTIONS.md`.

### knowledge-surfaces-2

- Doc: `library/knowledge/private/integrations/mcp-and-sdk.md` (The MCP server; MCP-server-via-install)
- Quote: "It binds two transports against one `McpServer` ... a stdio transport ... and a streamable-HTTP transport served at `/mcp` on loopback." Later: "the daemon additionally serves the streamable-HTTP transport at `/mcp` for HTTP-speaking clients."
- Grade: High
- Status: VERIFIED
- Correction: The bundled entry calls `startMcpServer()` with no options. `serveHttp` defaults to false, so a harness spawn of `node mcp/bundle/server.js` is stdio only. Streamable HTTP is opt-in on a second server when `serveHttp` is true. The daemon classifies `/mcp` in `ROUTE_GROUPS` and does not mount an MCP handler. An unfilled known group falls through to HTTP 501.
- Evidence: `mcp/src/index.ts` (`serveHttp` default, `isMainEntry` calls `startMcpServer()`); `src/daemon/runtime/server.ts` (`ROUTE_GROUPS` `/mcp`, `app.notFound` 501). No `startMcpServer` or `serveStreamableHttp` call under `src/daemon/`.

### knowledge-surfaces-3

- Doc: `library/knowledge/private/frontend/dashboard-architecture.md` (Build and serving)
- Quote: esbuild `entryPoints: { "dashboard-app": "src/dashboard/web/main.tsx" }` with `outdir: "daemon"`, and "The single entry is `src/dashboard/web/main.tsx`; the output is `daemon/dashboard-app.js`."
- Grade: High
- Status: VERIFIED
- Correction: This checkout has no `src/dashboard/web/` and `esbuild.config.mjs` has no `dashboard-app` entry. The same knowledge file already says the SPA files are not in this repository and that Honeycomb does not serve shell HTML. The build section still describes that bundle as the current esbuild target. `src/dashboard/launch.ts` opens the Hive portal; it does not emit `daemon/dashboard-app.js`.
- Evidence: glob of `src/dashboard/web/**` is empty; `esbuild.config.mjs` harness and daemon entries only; `src/dashboard/launch.ts` (`DASHBOARD_HOST_PATH`, `openDashboard`).

### knowledge-surfaces-4

- Doc: `library/knowledge/private/frontend/dashboard-performance.md`
- Quote: "`usePoll(fn, ms)` (`src/dashboard/web/page-frame.tsx`) is the one polling primitive every page uses" and the shell in `src/dashboard/web/app.tsx` owns the single `/health` poll.
- Grade: High
- Status: VERIFIED
- Correction: `src/dashboard/web/page-frame.tsx` and `app.tsx` are not in this repo, so the background-tab pause and the single shell `/health` poll cannot be confirmed here. The daemon-side cache claims in the same file do match code: `DIAG_TTL_MS` is 10000, `SAVINGS_TTL_MS` is 60000, and `fetchEstimatedSavings` still uses `SUM(LENGTH(content))`.
- Evidence: absent `src/dashboard/web/`; `src/daemon/runtime/dashboard/api.ts` (`DIAG_TTL_MS`, `SAVINGS_TTL_MS`, `fetchEstimatedSavings`, `buildEstimatedSavingsSql`). Whether Hive still has `usePoll` is UNVERIFIABLE-HERE.

### knowledge-surfaces-5

- Doc: `library/knowledge/private/frontend/dashboard-actions-surface.md`
- Quote: "these four named lifecycle actions" and the table of Logout, Embeddings, Restart, and Uninstall under `/api/actions`. Later: "`wire.ts` exposes `logout()`, `restartDaemon()`, `uninstall()`" and "`settings.tsx` renders the Embeddings and System Actions sections."
- Grade: High
- Status: VERIFIED
- Correction: `mountActionsGroup` also handles `POST /api/actions/memory`. That route persists `memory.enabled` and, when a reload seam is wired, reports `appliedLive`. The four named routes still exist. `settings.tsx` and `wire.ts` are not in this checkout.
- Evidence: `src/daemon/runtime/dashboard/actions-api.ts` (`group.post("/memory")` and the four other posts). `src/daemon/runtime/server.ts` still comments the group as logout / embeddings / restart / uninstall, which is the same omission.

### knowledge-surfaces-6

- Doc: `library/knowledge/private/frontend/cursor-extension-architecture.md` (File locations; Editor extension)
- Quote: file table lists `src/hooks/cursor/session-start.ts`, `capture.ts`, `session-end.ts`, `pre-tool-use.ts`, `spawn-wiki-worker.ts`, and `wiki-worker.ts`. Later: "The extension's `package.json` is a standard VS Code manifest" with `engines.vscode` targeting Cursor 1.7+ and `main` pointing at a bundled adapter.
- Grade: High
- Status: VERIFIED
- Correction: The only Cursor hook source is `src/hooks/cursor/shim.ts`. The hook binary is `harnesses/cursor/src/index.ts`, bundled to `harnesses/cursor/bundle/index.js`, then copied to alias names `session-start.js`, `capture.js`, `pre-tool-use.js`, and `session-end.js`. Those aliases are not separate sources. `harnesses/cursor/extension/` has `extension.ts`, `contracts.ts`, `bindings.ts`, `render.ts`, `index.ts`, and `CONVENTIONS.md`, and no `package.json`. `contracts.ts` states the real `vscode` host adapter is a deferred assembly step and the shell does not import `vscode`.
- Evidence: `src/hooks/cursor/shim.ts`; `harnesses/cursor/src/index.ts`; `esbuild.config.mjs` (`HOOK_HARNESSES` cursor aliases); `harnesses/cursor/extension/contracts.ts` (deferred host); directory listing of `harnesses/cursor/extension/`.

### knowledge-surfaces-7

- Doc: `library/knowledge/private/integrations/hook-lifecycle.md` (Hook event coverage)
- Quote: "the maps live in each `src/hooks/<harness>/shim.ts`" and the Cursor cell for pre-tool intercept is `` `beforeShellExecution` (Shell) ``.
- Grade: High
- Status: VERIFIED
- Correction: `CURSOR_EVENT_MAP` in `src/hooks/cursor/shim.ts` has `sessionStart`, `beforeSubmitPrompt`, `postToolUse`, `afterAgentResponse`, `stop`, and `sessionEnd`. It does not map `beforeShellExecution`. `createShim` drops a native name that is absent from the map. The connector does register `pre-tool-use` as `beforeShellExecution` in `src/connectors/cursor.ts`, so that hook is installed under a name the shim will not accept. Shell handling that does exist is inside `postToolUse`: `cursorExtractData` may return `preToolData` while the logical event stays `tool_call`. The separate claim that a Cursor `preToolUse` script rewrites a successful memory read into `echo` (`cursor-extension-architecture.md`) does not match this shim. Claude Code's successful intercept is `permissionDecision: "deny"` plus `additionalContext` in `src/hooks/claude-code/shim.ts`. Harmless `echo` remains only for commands the VFS cannot model (`src/hooks/shared/pre-tool-use.ts`).
- Evidence: `src/hooks/cursor/shim.ts` (`CURSOR_EVENT_MAP`, `cursorExtractData`); `src/hooks/normalize.ts` (unmapped event returns undefined); `src/hooks/binary.ts` (dropped); `src/connectors/cursor.ts` (`pre-tool-use` to `beforeShellExecution`); `src/hooks/shared/pre-tool-use.ts` (`HARMLESS_ECHO`).

### knowledge-surfaces-8

- Doc: `library/knowledge/private/security/credential-storage.md` (IO helpers; Why a file, not SQLite)
- Quote: "No other module reads or writes the credentials file directly." And: "SQLite in this codebase is only for the durable log store."
- Grade: High
- Status: VERIFIED
- Correction: `src/hooks/shared/credential-reader.ts` reads `~/.deeplake/credentials.json` and falls back to `~/.honeycomb/credentials.json` with its own `readFileSync` path. Writes still go through `src/daemon/runtime/auth/credentials-store.ts`. `node:sqlite` is also used by `src/daemon/runtime/services/local-job-queue.ts` and `src/daemon/runtime/telemetry/fleet-store.ts`, not only `src/daemon/runtime/logs/log-store.ts`. The file-not-SQLite choice for the login token can still be right. The "only the log store" premise is not.
- Evidence: `src/hooks/shared/credential-reader.ts`; `src/daemon/runtime/auth/credentials-store.ts`; `src/daemon/runtime/logs/log-store.ts`; `src/daemon/runtime/services/local-job-queue.ts`; `src/daemon/runtime/telemetry/fleet-store.ts`.

### knowledge-surfaces-9

- Doc: `library/knowledge/private/multi-tenant/org-workspace-model.md` (explicit tenancy)
- Quote: "written through the canonical `/setup/tenancy/*` API (`src/dashboard/setup-tenancy.ts`)."
- Grade: Medium
- Status: VERIFIED
- Correction: The routes exist (`GET /setup/tenancy`, `GET /setup/tenancy/orgs`, `GET /setup/tenancy/workspaces`, `POST /setup/tenancy/select`, `POST /setup/tenancy/workspaces`) and they stamp `tenancyConfirmedAt`. The module path is `src/daemon/runtime/dashboard/setup-tenancy.ts`. There is no `src/dashboard/setup-tenancy.ts`.
- Evidence: `src/daemon/runtime/dashboard/setup-tenancy.ts` (`SETUP_TENANCY_PATH` and siblings). Glob of `**/setup-tenancy.ts` returns only that file.

### knowledge-surfaces-10

- Doc: `library/knowledge/private/security/scoping-and-visibility.md` (read policy SQL)
- Quote: isolated example `AND m.agent_id = '<id>' AND m.visibility != 'archived'`, with the same `visibility != 'archived'` conjunct on the shared and group examples.
- Grade: High
- Status: VERIFIED
- Correction: Archived exclusion is `is_deleted = 0` (`NOT_ARCHIVED`), not `visibility != 'archived'`. Policy shape that does match: isolated is own `agent_id`; shared is `visibility = 'global' OR agent_id = self`; group is global rows whose `agent_id` is in the resolved member list, or own. Unknown policy fails closed to isolated. The `group` arm uses caller-supplied member ids, not an inline `SELECT id FROM "agents"`.
- Evidence: `src/daemon/runtime/recall/scope-clause.ts` (`notArchivedSql`, `buildScopeClause` comments, `NOT_ARCHIVED = 0`).

### knowledge-surfaces-11

- Doc: `library/knowledge/private/sources/source-lifecycle.md` (Connect)
- Quote: `honeycomb sources add obsidian /path/to/Vault --name "Vault"`.
- Grade: High
- Status: VERIFIED
- Correction: The mounted connect route is `POST /api/sources` (`group.post("/")` on the `/api/sources` group), plus `GET /api/sources/:id/health` and `DELETE /api/sources/:id`. The CLI storage dispatcher has no sources-specific builder. A subcommand `add` becomes `POST /api/sources/add` with body `{ args }`. That path is not a mounted handler, so it falls through to the 501 scaffold for a known group. Health and delete descriptions in the same doc match `src/daemon/runtime/sources/api.ts`.
- Evidence: `src/commands/storage-handlers.ts` (`buildStorageRequest`, `sources: "/api/sources"`); `src/daemon/runtime/sources/api.ts` (POST `/`, GET `/:id/health`, DELETE `/:id`); `src/daemon/runtime/assemble.ts` calls `mountProductData`, which mounts sources; `src/daemon/runtime/server.ts` 501 fallback.

### knowledge-surfaces-12

- Doc: `library/knowledge/private/standards/api-design-conventions.md`
- Quote: "`/mcp` and `/v1/*` carry MCP and the OpenAI-compatible gateway." And: "`docs/API.md` and the per-group `docs/api/*.md` files are kept accurate to the daemon routes."
- Grade: High
- Status: VERIFIED
- Correction: `/v1` and `/api/inference` are scaffolded in `ROUTE_GROUPS`. `mountInferenceGateway` in `src/daemon/runtime/inference/gateway.ts` would attach `POST /v1/chat/completions` and the native inference routes, but the only call site is `tests/daemon/runtime/inference/gateway.test.ts`. `assembleDaemon` does not call it, so those paths stay on the 501 scaffold. `/mcp` is the same unfilled group described in knowledge-surfaces-2. `docs/` in this checkout contains `docs/ci.md` only. There is no `docs/API.md` and no `docs/api/` tree.
- Evidence: `src/daemon/runtime/inference/gateway.ts` (`mountInferenceGateway`); `src/daemon/runtime/inference/index.ts` (re-export only); grep of `mountInferenceGateway(` outside tests; `src/daemon/runtime/assemble.ts` (no gateway mount); glob `docs/**/*.md`.

## Cap

Twelve findings. Further pages in the assigned folders were sampled and not promoted: hook session-start background pull, Hermes MCP mention string, Hive port constants, connector support matrix of three, MCP tool count of 19, and credential file location at `~/.deeplake/credentials.json`. Hive's own SPA sources are outside this repo.

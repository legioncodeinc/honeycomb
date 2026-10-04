# MCP and SDK code standing

- Date: 2026-10-04
- Shard: Wave 2, MCP server, typed SDK, daemon `/mcp` and `/v1` route groups, inference gateway
- Walked: `mcp/src/`, `src/sdk/` (there is no source tree at `sdk/`), `src/daemon/runtime/server.ts` route groups, `src/daemon/runtime/inference/gateway.ts`
- Also opened the lines the wave 1 reports cite for these claims (assembly mount, secrets exec stub, connector registry, Claude Code and Hermes MCP manifests, OpenClaw harness entry)
- Skipped: `mcp/bundle/`, `harnesses/*/bundle/`, other build output
- Product source was not edited

Verdicts below are on recommended edits and moves. CONFIRM means the wave 1 action stands. OVERTURN means the action should not be applied. UNVERIFIABLE means this walk could not prove the action.

## Counts

- CONFIRM: 44
- OVERTURN: 0
- UNVERIFIABLE: 1

## Knowledge edits (`integrations.md`, MCP and SDK)

Page action: REVISE `library/knowledge/private/integrations/mcp-and-sdk.md`. The replace list is D-01 through D-07. D-09 is the same MCP-registration claim on `harness-integration.md`.

### K-01 D-01 dual live transport - CONFIRM

- Action: REVISE. Drop the claim that one process binds stdio and streamable HTTP on one `McpServer` and serves `/mcp`.
- `mcp/src/index.ts:88` binds both transport objects on the constructed server.
- `mcp/src/index.ts:137` records the SDK rule of one transport per server.
- `mcp/src/index.ts:156` connects stdio on the primary server.
- `mcp/src/index.ts:160` serves HTTP only when `serveHttp === true`, and `mcp/src/index.ts:162` builds a second server for that transport.
- `mcp/src/index.ts:199` calls `startMcpServer()` with no options. The only `serveHttp: true` call site is `tests/mcp/start-server.test.ts:164`.
- `src/daemon/runtime/server.ts:104` scaffolds `/mcp`. No `group("/mcp")` call exists under `src/`. An unfilled prefix returns 501 at `src/daemon/runtime/server.ts:404`.

### K-02 D-02 graph-build codebase tools - CONFIRM

- Action: REVISE. Codebase tools are not registered after `honeycomb graph build`, and their handlers do not dial the live graph routes.
- `mcp/src/index.ts:82` defaults `graphBuilt` to false. `mcp/src/index.ts:199` never passes it.
- `mcp/src/registry.ts:170` skips conditional names unless `graphBuilt` is true.
- The only `graphBuilt: true` call site is `tests/mcp/codebase-conditional.test.ts:33`.
- `mcp/src/handlers.ts:289` still posts `/api/code/search`, `/api/code/context`, `/api/code/blast`, and `/api/code/impact`.
- `src/daemon/runtime/server.ts:84` mounts `/api/graph`. There is no `/api/code` group. Live graph routes are `POST /api/graph/build` and `GET /api/graph` at `src/daemon/runtime/codebase/api.ts:15`.

### K-03 D-03 connect-time MCP registration - CONFIRM

- Action: REVISE. `honeycomb connect` does not register the MCP server.
- `src/cli/connector-runner.ts:62` registers `claude-code`, `codex`, and `cursor`. `src/connectors/` has no MCP write.
- `harnesses/claude-code/.mcp.json:6` is a static plugin manifest whose args are `${CLAUDE_PLUGIN_ROOT}/mcp/bundle/server.js`.
- `harnesses/hermes/.mcp.json:6` is a static in-progress manifest. No `.mcp.json` exists under `harnesses/codex` or `harnesses/cursor`.

### K-04 D-04 OpenClaw command surface - CONFIRM

- Action: REVISE the tool, batch, and connect claims. Keep the env-harvest sentence.
- `harnesses/openclaw/src/index.ts:64` applies tuning and calls `bootHarness("openclaw")`. `harnesses/openclaw/src/index.ts:50` writes `globalThis.__honeycomb_tuning__`.
- No tool registration under `harnesses/openclaw/`.
- `src/hooks/openclaw/shim.ts:184` maps `agent_end` to session-end data. OpenClaw is not in the connector registry at `src/cli/connector-runner.ts:62`.

### K-05 D-05 SDK sample - CONFIRM

- Action: REVISE the sample. `remember` options are `path` only. `recall` returns an array. The bearer header itself is real.
- `src/sdk/contracts.ts:160` defines `RememberOptions` as `path?` only.
- `src/sdk/contracts.ts:205` types `recall` as `Promise<readonly RecallResult[]>`.
- `src/sdk/client.ts:155` sets `authorization` to `Bearer ${opts.token}` when a token is set and the URL is loopback or HTTPS.

### K-06 D-06 diagnostics word - CONFIRM

- Action: REVISE. The client groups stop at `health`. There is no diagnostics method.
- `src/sdk/contracts.ts:208` lists `memory`, `hooks`, `connectors`, `documents`, `sources`, `skills`, `goals`, `health`, `secrets`.
- `src/sdk/contracts.ts:260` gives `HealthApi` only `check()`.
- `sources` is present: `src/sdk/client.ts:332` lists via `GET /api/sources`.

### K-07 D-07 memory_get by path - CONFIRM

- Action: REVISE. The tool field is named `path`. The daemon read is get-by-id. Keep the `hivemind_read` half of the sentence.
- `mcp/src/tools.ts:81` publishes `memory_get` with `path`.
- `mcp/src/handlers.ts:235` sends `GET /api/memories/${encodeURIComponent(path)}`.
- `mcp/src/handlers.ts:246` says that `path` rides the URL as the memory id.
- `src/daemon/runtime/memories/api.ts:1047` is `GET /api/memories/:id`. `src/daemon/runtime/memories/reads.ts:215` is `getMemory(id)`.
- `mcp/src/handlers.ts:298` routes `hivemind_read` to `GET /api/memories/resolve`.

### K-08 D-09 MCP via install - CONFIRM

- Action: REVISE the install-time MCP paragraph in `harness-integration.md`. Same evidence as K-03.
- `src/cli/connector-runner.ts:62`, `harnesses/claude-code/.mcp.json:6`, `harnesses/hermes/.mcp.json:6`. No Codex or Cursor `.mcp.json`. No MCP write under `src/connectors/`.

### K-09 through K-13 keeps inside the same page edit - CONFIRM

- K-09 stdio production sentence. `mcp/src/index.ts:199` auto-starts stdio. `esbuild.config.mjs:303` emits `mcp/bundle` and `harnesses/claude-code/mcp/bundle`. Daemon `/mcp` stays the 501 scaffold (`src/daemon/runtime/server.ts:104`, `src/daemon/runtime/server.ts:404`).
- K-10 19-tool table. `mcp/src/tools.ts:77` lists 19 specs: 15 unconditional plus 4 conditional codebase tools. Clusters are `memory`, `browse`, `goals-kpis`, `codebase`, `secrets` at `mcp/src/contracts.ts:54`. `hivemind_read` and `hivemind_search` are cluster `memory` (`mcp/src/tools.ts:109`, `mcp/src/tools.ts:116`).
- K-11 C-2 removal. `mcp/src/tools.ts:11` records the removal of session, agent, and `memory_feedback` tools. `mcp/src/sessions.ts:36` keeps `inferParentSessionKey`. `src/daemon/runtime/server.ts:68` has no `/api/sessions` or `/api/agents` group.
- K-12 header stamps. `mcp/src/daemon-seam.ts:83` sets `x-honeycomb-runtime-path: plugin`, actor, and actor type. Default actor is `honeycomb-mcp` / `plugin` at `mcp/src/index.ts:38`. Session-group paths get `mcp-<n>` at `mcp/src/daemon-seam.ts:72`.
- K-13 SDK factory path. `createHoneycombClient` is `src/sdk/client.ts:117`. `HoneycombClient` is the interface at `src/sdk/contracts.ts:201`. Package name and subpaths are `package.json:2` and `package.json:17` (`./react`, `./vercel`, `./openai`). The published paths are `./sdk/*.js`. That directory is build output, not the typed source.

Related holds checked and left standing (not separate edits): `memory_modify` requires `content` and `reason`, `memory_forget` requires `reason` (`mcp/src/tools.ts:90`, `src/daemon/runtime/memories/api.ts:454`). `memory_list` has no `prefix` and `honeycomb_kpi_add` has no `goalId` (`mcp/src/tools.ts:84`, `mcp/src/tools.ts:127`). Browse tools dial `/memory/grep`, `/memory/cat`, `/memory/ls` (`mcp/src/handlers.ts:272`). Goal and KPI tools map one string to `{ key, value }` (`mcp/src/handlers.ts:187`). `secret_exec` keeps `jobId` (`mcp/src/handlers.ts:123`). Schemas import `zod/v3` (`mcp/src/contracts.ts:28`). App dependency is `zod` `^4.4.3` (`package.json:135`).

## Standards `/mcp` and `/v1` claims

These three are LEAVE. The sentences match the server.

### S-01 H-1 scaffolds and 501 - CONFIRM

- Action: LEAVE. `ROUTE_GROUPS` includes `/health`, `/v1`, and `/mcp`. A known prefix with no handler returns 501.
- `src/daemon/runtime/server.ts:68` starts the table. `/v1` is `src/daemon/runtime/server.ts:99`. `/mcp` is `src/daemon/runtime/server.ts:104`.
- The 501 body is `src/daemon/runtime/server.ts:404`.
- `src/daemon/runtime/server.ts:331` is the degraded `/health` status choice (503 versus 200), not the scaffold 501. That citation slip does not change the sentence.

### S-02 H-2 gateway module, no production `/v1` mount - CONFIRM

- Action: LEAVE. `mountInferenceGateway` exists. Production assembly does not mount it.
- `src/daemon/runtime/inference/gateway.ts:103` defines `mountInferenceGateway`. `src/daemon/runtime/inference/gateway.ts:105` mounts the OpenAI group.
- `src/daemon/runtime/assemble.ts` has no `mountInferenceGateway` call and no `group("/v1")` call.
- The only `daemon.group("/v1")` call is `tests/daemon/runtime/inference/gateway.test.ts:199`. The test calls `mountInferenceGateway` at `tests/daemon/runtime/inference/gateway.test.ts:203`.

### S-03 H-3 production MCP is stdio - CONFIRM

- Action: LEAVE. Same evidence as K-01 and K-09. `mcp/src/index.ts:109` documents `serveHttp` defaulting false. `mcp/src/index.ts:199` starts stdio only.

## PRD-019 MCP and SDK children

Folder today: `library/requirements/in-work/prd-019-harness-integrations/`.

### P-01 stay in `in-work` - CONFIRM

- Action: do not move the folder to `completed`, `backlog`, or `archive`.
- 019d AC-2, AC-4, and AC-5 are absent or contradicted in source (rows below). One absent child criterion is enough to hold the parent out of `completed`.
- 019e is met in source. That does not complete the parent. 019a, 019b, and 019c were not re-walked here.

### P-02 index banner correction - CONFIRM

- Action: if a writer may edit the PRD, correct the banner. The registry includes Codex. The Claude Code plugin manifest points at the MCP bundle. Connectors still do not write MCP config.
- `src/cli/connector-runner.ts:62` builds `claude-code`, `codex`, and `cursor`.
- `harnesses/claude-code/.mcp.json:6` points at `${CLAUDE_PLUGIN_ROOT}/mcp/bundle/server.js`.

### 019d MCP server

#### P-03 AC-1 MET - CONFIRM

- Tools register from `TOOL_SPECS` at `mcp/src/registry.ts:166`. Stdio connect is `mcp/src/index.ts:156`.
- `mcp/src/daemon-seam.ts:83` stamps `x-honeycomb-runtime-path: plugin` plus actor headers. `mcp/src/handlers.ts:46` passes the server actor into `daemon.call`.
- Registered names are the mixed set in `mcp/src/tools.ts:77` (`memory_`, `honeycomb_`, `hivemind_`, `secret_`). That is the surface the criterion's child describes.

#### P-04 AC-2 UNMET - CONFIRM

- `secret_list` rebuilds `{ names }` from strings only at `mcp/src/handlers.ts:98` and `mcp/src/handlers.ts:320`.
- `toSecretExecResult` copies non-empty `stdout` and `stderr` into `output`, then `output`, at `mcp/src/handlers.ts:128`. It does not replace secret text with `[REDACTED]`.
- The SDK floor does the stricter thing at `src/sdk/client.ts:386`. The MCP handler does not.

#### P-05 AC-3 MET - CONFIRM

- `mcp/src/handlers.ts:248` returns `errorResult` before `route` when `reason` is empty for `memory_modify` and `memory_forget`.
- Schemas require `reason: z.string()` at `mcp/src/tools.ts:90` and `mcp/src/tools.ts:94`.

#### P-06 AC-4 UNMET - CONFIRM

- Default registration skips the codebase cluster (`mcp/src/index.ts:82`, `mcp/src/registry.ts:170`).
- Production `startMcpServer()` at `mcp/src/index.ts:199` never sets `graphBuilt`. Nothing under `mcp/src/`, `harnesses/`, `src/connectors/`, `src/hooks/`, or `src/sdk/` sets it from `honeycomb graph build`. The only `graphBuilt: true` site is `tests/mcp/codebase-conditional.test.ts:33`.

#### P-07 AC-5 UNMET - CONFIRM

- `session_search` is not in `TOOL_SPECS`. `mcp/src/tools.ts:11` records the removal.
- `inferParentSessionKey` remains at `mcp/src/sessions.ts:36` and is not registered as a tool.

#### P-08 AC-6 MET - CONFIRM

- `mcp/src/transports.ts:150` states one live transport per `McpServer`.
- `mcp/src/index.ts:156` connects stdio on the primary server. `mcp/src/index.ts:160` builds a second server with the same options and connects its HTTP transport when `serveHttp` is true.
- Both use `createMcpServer`, which defaults to `createHttpDaemonApiSeam` and the same `TOOL_SPECS` (`mcp/src/index.ts:80`).
- Production auto-start remains stdio only (`mcp/src/index.ts:199`). That is K-01, not a failure of this equivalence path.

### 019e SDK

Typed source is `src/sdk/`. `package.json:18` exports `./sdk/index.js` and the three subpaths. No source directory `sdk/` is in the tree.

#### P-09 AC-1 MET - CONFIRM

- `src/sdk/client.ts:397` `remember` calls `memory.store` (`POST /api/memories` at `src/sdk/client.ts:291`).
- `src/sdk/client.ts:400` `recall` calls `memory.search` (`POST /api/memories/recall` at `src/sdk/client.ts:272`).
- `src/sdk/client.ts:139` sets actor, actor type, and runtime path. `src/sdk/client.ts:155` adds `Authorization: Bearer` when the token is present and the transport is loopback or HTTPS.

#### P-10 AC-2 MET - CONFIRM

- `ApiError` `src/sdk/contracts.ts:49`, `NetworkError` `src/sdk/contracts.ts:62`, `TimeoutError` `src/sdk/contracts.ts:73`.
- `src/sdk/client.ts:203` retries GET and does not retry mutations. Timeout throws `TimeoutError` at `src/sdk/client.ts:184`. Transport throws `NetworkError` at `src/sdk/client.ts:186`. Non-2xx throws `ApiError` at `src/sdk/client.ts:242`.
- Default policy is GET 3 attempts, other methods 1 (`src/sdk/contracts.ts:115`).

#### P-11 AC-3 MET - CONFIRM

- `src/sdk/client.ts:18` imports only `./contracts.js`. No `node:` import and no `require` under `src/sdk/`.
- Transport is global `fetch` at `src/sdk/client.ts:118`.
- This pass did not execute the client under Bun or a browser. The source that would run there has no native module. The MET standing stands on that source.

#### P-12 AC-4 MET - CONFIRM

- `src/sdk/react.ts:61` `useRecall` calls `client.recall` and sets `{ loading: true }`, then `{ loading: false, results }` or `{ loading: false, error }`.
- React hooks are an injected `ReactRuntime` at `src/sdk/react.ts:28`.

#### P-13 AC-5 MET - CONFIRM

- `src/sdk/vercel.ts:52` `execute` calls `client.recall`. The remember tool calls `client.remember` at `src/sdk/vercel.ts:58`.
- `src/sdk/openai.ts:85` and `src/sdk/openai.ts:90` call the same client methods. Neither helper builds its own HTTP stack.

#### P-14 AC-6 MET - CONFIRM

- `src/sdk/client.ts:372` maps daemon `names` to `{ name }` only.
- `src/sdk/client.ts:379` returns `{ redactedOutput }` and, when that field is missing, `SECRET_REDACTED` (`[REDACTED]` at `src/sdk/client.ts:51`). It does not read `stdout` or `output`.

## `completed-009-016.md` secret_exec

### R-01 PRD-012 move to `in-work` - CONFIRM

- Action: move `library/requirements/completed/prd-012-secrets/` to `in-work`.
- `src/daemon/runtime/assemble.ts:2003` builds `SecretsApiDeps` with `store`, `scope`, and an optional `reload`. It does not set `execRunner`.
- `src/daemon/runtime/assemble.ts:1686` passes that object to `mountProductData`, which mounts secrets.
- `src/daemon/runtime/secrets/api.ts:220` registers `POST /api/secrets/exec`, `GET /api/secrets/exec/:jobId`, and the Bitwarden and 1Password paths as 501 stubs when `execRunner` is omitted. `notImplementedRoute` returns 501 at `src/daemon/runtime/secrets/api.ts:314`.
- Names-only `GET /api/secrets` is mounted at `src/daemon/runtime/secrets/api.ts:231`. The module comment at `src/daemon/runtime/secrets/api.ts:160` records that there is no `GET /:name` value route.

### R-02 PRD-012 index AC-2 MET (no value-returning read) - CONFIRM

- The read surface lists names and has no value route (`src/daemon/runtime/secrets/api.ts:231`, `src/daemon/runtime/secrets/api.ts:160`).
- SDK list maps names only (`src/sdk/client.ts:372`). MCP `secret_list` rebuilds `{ names }` (`mcp/src/handlers.ts:98`).
- MCP `secret_exec` copying stdout is R-03 and P-04, not a value-read route.

### R-03 PRD-012 index AC-3 UNMET (live exec redaction) - CONFIRM

- Live `POST /api/secrets/exec` is the 501 stub at `src/daemon/runtime/secrets/api.ts:224` because assembly omits `execRunner` (`src/daemon/runtime/assemble.ts:2003`).
- MCP would also pass non-empty stdout through (`mcp/src/handlers.ts:128`) if a body ever carried it.

### R-04 PRD-012a AC-5 MET (SDK and live HTTP do not return a decrypted value) - CONFIRM

- SDK exec returns `redactedOutput` or `[REDACTED]` (`src/sdk/client.ts:386`).
- The live secrets HTTP module has no decrypting read (`src/daemon/runtime/secrets/api.ts:160`) and the exec routes 501 (`src/daemon/runtime/secrets/api.ts:224`).
- The MCP passthrough gap stays on 019d AC-2 (P-04). It does not put a decrypted store value on the live route.

### R-05 PRD-012b AC-1 through AC-6 UNMET - CONFIRM

- Queue, spawn, timeout clamp, redaction, status poll, vault resolution, timeout kill, and pool queue live in `src/daemon/runtime/secrets/exec.ts` and are not on the mounted route.
- Live POST and GET exec are the 501 stubs at `src/daemon/runtime/secrets/api.ts:224` and `src/daemon/runtime/secrets/api.ts:225`.

## `completed-009-016.md` sources

### C-01 PRD-013 move to `in-work` - CONFIRM

- Action: move `library/requirements/completed/prd-013-sources-and-documents/` to `in-work`.
- The cited absent criterion is a daemon-down CLI remove that deletes local source config and warns that store rows remain.
- `src/commands/storage-handlers.ts:44` sends the `sources` verb to `/api/sources`. No `store rows remain` string exists under `src/`.
- What this walk did see: `/api/sources` is a route group at `src/daemon/runtime/server.ts:77`. Assembly builds sources deps at `src/daemon/runtime/assemble.ts:2022` and mounts them through `mountProductData` at `src/daemon/runtime/assemble.ts:1686`. The SDK lists sources at `src/sdk/client.ts:332`.

### C-02 PRD-013 provider MET rows - UNVERIFIABLE

- Obsidian, Discord, and GitHub provider criteria were not re-walked. They sit under `src/daemon/runtime/sources/`, outside `mcp/src/`, `src/sdk/`, the route-group table, and `gateway.ts`.
- Those rows do not change C-01. The absent CLI warning is enough to hold the folder in `in-work`.

## `/v1` move in the same completed report (PRD-010)

Walked because the standards `/v1` claim and `gateway.ts` are this shard. Pin and the `honeycomb route` CLI were not re-walked. The unmounted gateway is enough to hold the folder in `in-work`.

### G-01 PRD-010 move to `in-work` - CONFIRM

- Action: move `library/requirements/completed/prd-010-model-provider-router/` to `in-work`.
- `POST /v1/chat/completions` is implemented at `src/daemon/runtime/inference/gateway.ts:212` and is not mounted in production (`src/daemon/runtime/assemble.ts` never calls `mountInferenceGateway`). A client pointed at the daemon hits the 501 scaffold at `src/daemon/runtime/server.ts:404` for `/v1`.

### G-02 index AC-4 UNMET - CONFIRM

- Streaming branch is `src/daemon/runtime/inference/gateway.ts:219`. Production mount is absent (G-01).

### G-03 010c AC-1 UNMET - CONFIRM

- `POST /api/inference/explain` is `src/daemon/runtime/inference/gateway.ts:118`. Mount is test-only at `tests/daemon/runtime/inference/gateway.test.ts:203`.

### G-04 010c AC-2 UNMET - CONFIRM

- SSE chat completions are `src/daemon/runtime/inference/gateway.ts:219`. Same absent mount.

### G-05 010c AC-3 UNMET - CONFIRM

- `GET /v1/models` is `src/daemon/runtime/inference/gateway.ts:199`. Chat completions are `src/daemon/runtime/inference/gateway.ts:212`. Same absent mount.

### G-06 010c AC-4 UNMET - CONFIRM

- `DELETE /api/inference/requests/:id` is `src/daemon/runtime/inference/gateway.ts:184`. Same absent mount.

### G-07 010c AC-5 UNMET - CONFIRM

- Body clamp and redacted errors exist on the gateway module. They are not on the production server because the gateway is not mounted (G-01).

### G-08 010c AC-6 UNMET - CONFIRM

- `GET /api/inference/history` is `src/daemon/runtime/inference/gateway.ts:167`. The route is not mounted (G-01). The history store's production caller was not re-walked. The missing mount is enough for UNMET.

## Writer notes

- Apply the mcp-and-sdk.md replaces in K-01 through K-07 and the harness MCP paragraph in K-08. Keep K-09 through K-13.
- Leave the three standards sentences in S-01 through S-03.
- Leave PRD-019 in `in-work`. 019e does not pull the folder to `completed`.
- Move PRD-012 and PRD-010 to `in-work` on the exec 501 and the unmounted `/v1` gateway.
- Move PRD-013 to `in-work` on the absent daemon-down source warning. Do not treat this report as a re-score of the provider criteria.

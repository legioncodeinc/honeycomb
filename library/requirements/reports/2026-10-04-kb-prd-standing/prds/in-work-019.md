# PRD-019 standing - harness integrations

- Date: 2026-10-04
- Shard: Wave 1b, in-work 019 only
- Folder: `library/requirements/in-work/prd-019-harness-integrations/`
- Evidence trees: `harnesses/`, `src/connectors/`, `mcp/src/`, `src/hooks/`, `src/sdk/`
- `sdk/` (package export root) does not exist. Typed client source is `src/sdk/`.
- Skipped: `node_modules`, `harnesses/*/bundle/`, `mcp/bundle/`, other build output.
- Historical QA and security reports in this folder were not treated as proof.

## Recommended bucket

**in-work.** Keep the folder here.

Commit `756bacb` (2026-10-04, "docs: align the knowledge base with the daemon and file shipped PRDs") renamed the whole folder from `library/requirements/completed/prd-019-harness-integrations/` to `library/requirements/in-work/prd-019-harness-integrations/` and changed the index status line to `In Work (reopened 2026-06-22)`. The other seven files were pure renames. That bucket is still the right one: 14 of 33 acceptance criteria are absent or contradicted in source. A large connector, hook, MCP, and SDK surface is already in the tree, so this is not backlog and not archive. It is not completed.

## Move re-check (do not trust the banner)

The index warning (lines 10-15) says only Claude Code is fully wired, Codex and Cursor are partial, Hermes / pi / OpenClaw are built-not-wired, the registry registers only `claude-code` and `cursor` at `src/cli/connector-runner.ts:55-70`, and MCP-via-install is met for no harness.

Checked against source:

- The registry line is false. `src/cli/connector-runner.ts:62-72` registers `claude-code`, `codex`, and `cursor`.
- Claude Code, Codex, and Cursor each have a hook binary that normalizes through its shim and posts to the daemon (`harnesses/claude-code/src/index.ts:42-43`, `harnesses/codex/src/index.ts:36-37`, `harnesses/cursor/src/index.ts:46-47`).
- Hermes, pi, and OpenClaw harness entries do not run those shims. `harnesses/hermes/src/index.ts:8-9` and `harnesses/pi/src/index.ts:8-9` only call `bootHarness`. `harnesses/openclaw/src/index.ts:64-66` applies plugin tuning and then `bootHarness`. Their shims live under `src/hooks/` and are not invoked from `harnesses/`.
- OpenCode, Gemini CLI, and Oh My Pi have no harness directory and no shim. `harnesses/` contains `claude-code`, `codex`, `cursor`, `hermes`, `openclaw`, and `pi` only.
- Claude Code plugin install does ship an MCP manifest: `harnesses/claude-code/.mcp.json:3-7` points at `${CLAUDE_PLUGIN_ROOT}/mcp/bundle/server.js`. The "MCP-via-install met for no harness" sentence is stale for Claude Code. Hermes has `harnesses/hermes/.mcp.json` and no connector that installs it. `src/connectors/` never mentions MCP.
- Production session-start does not ensure tables or write the placeholder row (`src/hooks/shared/session-start-seams.ts:122-126` are empty functions). Production session-end does not spawn a summary worker (`src/hooks/runtime.ts:271` and `:474-476` use a no-op spawn).

So the reopen is directionally right and the banner's registry and MCP sentences are stale. Do not move this PRD to completed on the 2026-06-18 QA report. That report scored seam tests, and later source removed `session_search` and left the summary spawn and table-ensure steps as no-ops.

## Score

| Surface | File | MET | UNMET | UNVERIFIABLE |
|---|---|---:|---:|---:|
| Index | `prd-019-harness-integrations-index.md` | 2 | 1 | 0 |
| 019a | `prd-019a-harness-integrations-connector-base.md` | 5 | 1 | 0 |
| 019b | `prd-019b-harness-integrations-hook-lifecycle.md` | 3 | 3 | 0 |
| 019c | `prd-019c-harness-integrations-harness-shims.md` | 0 | 6 | 0 |
| 019d | `prd-019d-harness-integrations-mcp-server.md` | 3 | 3 | 0 |
| 019e | `prd-019e-harness-integrations-sdk.md` | 6 | 0 | 0 |
| Total | 33 criteria | 19 | 14 | 0 |

Child docs still say `Status: Draft`. The index says `In Work`. `756bacb` did not edit the children.

## Index

### AC-1 - UNMET

- Quote: "Given any supported harness, when `honeycomb setup` or `honeycomb connect <harness>` runs, then its connector patches config, writes hook handlers, links skills, and uninstall cleanly reverses only Honeycomb's changes."
- PRD: `library/requirements/in-work/prd-019-harness-integrations/prd-019-harness-integrations-index.md:50`
- The union in 019c is Claude Code, OpenClaw, Codex, Cursor, Hermes, pi, OpenCode, Gemini CLI, and Oh My Pi (`prd-019c-harness-integrations-harness-shims.md:10`).
- Registry knows three slugs: `src/cli/connector-runner.ts:62-72`. Connectors on disk: `src/connectors/claude-code.ts`, `src/connectors/codex.ts`, `src/connectors/cursor.ts`. No Hermes, pi, OpenClaw, OpenCode, Gemini, or Oh My Pi connector.
- Codex and Cursor inherit `HarnessConnector.install()`, which writes handlers, patches config, and links skills (`src/connectors/contracts.ts:345-367`).
- Claude Code's live install does not. With a plugin runner it runs `claude plugin` and returns `handlers: []` and `skillLinks: []` (`src/connectors/claude-code.ts:137-164`). Handler writes and skill links run only on the fail-soft path (`src/connectors/claude-code.ts:203-210`).
- Uninstall of Honeycomb-only entries is implemented on the base (`src/connectors/contracts.ts:380-408`) and Claude Code also calls `super.uninstall()` (`src/connectors/claude-code.ts:172-178`). That half does not rescue "any supported harness".

### AC-2 - MET

- Quote: "Given a harness fires a native lifecycle event, when its shim runs, then the event and payload are normalized to the shared shape and the call reaches the daemon's `/api/hooks/*` with the `x-honeycomb-runtime-path` header."
- PRD: `library/requirements/in-work/prd-019-harness-integrations/prd-019-harness-integrations-index.md:51`
- Claude Code, Codex, and Cursor binaries call `runHookBinary` with their shim (`harnesses/claude-code/src/index.ts:42-43`, `harnesses/codex/src/index.ts:36-37`, `harnesses/cursor/src/index.ts:46-47`).
- Normalization: `src/hooks/runtime.ts:292` calls `shim.normalize`. Shared engine: `src/hooks/normalize.ts`.
- Daemon POST: `src/hooks/shared/daemon-client.ts:111-118` builds `http://<host>:<port>/api/hooks/<endpoint>` and sets `x-honeycomb-runtime-path` from `req.runtimePath`.
- Capture posts to `capture` with that path (`src/hooks/shared/capture.ts:147-154`). Runtime uses `createDaemonHookClient` (`src/hooks/runtime.ts:234`).
- Hermes, pi, and OpenClaw do not take this path. Their harness entries never call the shim. The criterion is existential ("a harness" / "its shim"), and the three wired binaries do it.

### AC-3 - MET

- Quote: "Given a harness that speaks MCP, when the MCP server is reachable, then the unified `honeycomb_` tool surface appears in its native tool list and every tool handler routes through the daemon API."
- PRD: `library/requirements/in-work/prd-019-harness-integrations/prd-019-harness-integrations-index.md:52`
- Tool list: `mcp/src/tools.ts:77-138` (`TOOL_SPECS`). Registration: `mcp/src/registry.ts:166-177`.
- Every handler goes through `route()` to a daemon HTTP path (`mcp/src/handlers.ts:227-327`). Headers `x-honeycomb-runtime-path: plugin` plus actor headers: `mcp/src/daemon-seam.ts:83-90`. Default seam: `mcp/src/index.ts:80` (`createHttpDaemonApiSeam()`).
- Claude Code exposes that server from the plugin: `harnesses/claude-code/.mcp.json:3-7`.
- The process is a stdio MCP server (`mcp/src/index.ts:152-156`, auto-start at `:198-199`), not an in-daemon `/mcp` mount. HTTP `/mcp` is opt-in (`mcp/src/index.ts:109-112`). The criterion asks for a reachable server, a tool list, and daemon routing. Those are present. Missing clusters are scored under 019d.

## 019a connector base

### AC-1 - MET

- Quote: "Given a harness config already containing third-party hooks, when the connector installs, then it appends Honeycomb hooks and preserves the foreign entries."
- PRD: `prd-019a-harness-integrations-connector-base.md:49`
- `src/connectors/contracts.ts:421-444` filters with `isHoneycombEntry` and appends a Honeycomb block. Foreign blocks stay. Sentinel plus legacy path marker: `src/connectors/contracts.ts:295-304`. Cursor's flat merge keeps non-Honeycomb entries: `src/connectors/cursor.ts:173-183`.

### AC-2 - MET

- Quote: "Given an installed connector, when uninstall runs, then only Honeycomb's hooks, links, and config keys are removed and an emptied config file is cleanly unlinked."
- PRD: `prd-019a-harness-integrations-connector-base.md:50`
- `src/connectors/contracts.ts:380-408`: strip Honeycomb entries, unlink the file when empty, remove handler files, unlink only Honeycomb skill symlinks (`:503-511`).

### AC-3 - MET

- Quote: "Given an already-installed connector, when install re-runs with no change, then no config file is written and the hook-trust fingerprint is unchanged."
- PRD: `prd-019a-harness-integrations-connector-base.md:51`
- `src/connectors/contracts.ts:314-319`: `writeJsonIfChanged` returns false when the serialized text is byte-identical and does not call `writeFile`.

### AC-4 - MET

- Quote: "Given `honeycomb setup` with no target on a box with two detected harnesses, when it runs, then both harnesses are wired."
- PRD: `prd-019a-harness-integrations-connector-base.md:52`
- `src/connectors/cli.ts:76-107`: `setup` detects every registry slug whose config root exists and calls `install()` on each. Detection: `src/connectors/contracts.ts:328-331`.

### AC-5 - UNMET

- Quote: "Given a new per-harness connector, when it is implemented, then it subclasses the base and overrides only config path, hook set, skill targets, and event map."
- PRD: `prd-019a-harness-integrations-connector-base.md:53`
- The four abstract seams are `src/connectors/contracts.ts:251-257`.
- Codex matches that rule (`src/connectors/codex.ts:4-6`, overrides at `:66-91`).
- Claude Code also overrides `install()` and `uninstall()` (`src/connectors/claude-code.ts:137` and `:172`).
- Cursor also overrides `patchConfig` and the flat strip (`src/connectors/cursor.ts:173` and the strip noted at `:23-27`). The "only" clause is not true of the implemented set.

### AC-6 - MET

- Quote: "Given skill linking runs, when a skill location already holds a foreign entry, then existing entries are preserved and only Honeycomb symlinks are added."
- PRD: `prd-019a-harness-integrations-connector-base.md:54`
- `src/connectors/contracts.ts:473-494`: an existing foreign symlink or real file is left in place. Uninstall removes a link only when its target is ours (`:503-511`).

## 019b lifecycle hook contract

### AC-1 - UNMET

- Quote: "Given a harness with a partial event vocabulary, when a logical event has no native equivalent, then the contract still completes the lifecycle (for example batched capture at session end) without dropping rows."
- PRD: `prd-019b-harness-integrations-hook-lifecycle.md:49`
- The batch helper exists: `src/hooks/shared/capture.ts:132-144` (`runCaptureBatch` sends one capture per input). OpenClaw slice math exists: `src/hooks/openclaw/shim.ts:98-103`.
- Nothing in the OpenClaw harness calls them. `harnesses/openclaw/src/index.ts:64-66` never imports the shim. `openclawExtractData` maps `agent_end` to session-end data, not a message flush (`src/hooks/openclaw/shim.ts:184-185`). pi's comment says the extension drives the batch (`src/hooks/pi/shim.ts:78-81`); `harnesses/pi/extension-source/honeycomb.ts` is absent, and `harnesses/pi/src/index.ts` only boots the client. Rows for those harnesses are not written.

### AC-2 - MET

- Quote: "Given any lifecycle event fires, when the hook runs, then it reads credentials, normalizes the payload, and makes a local daemon request without opening DeepLake or building SQL."
- PRD: `prd-019b-harness-integrations-hook-lifecycle.md:50`
- Credentials: `src/hooks/shared/credential-reader.ts:77-79` reads `~/.deeplake/credentials.json` with a legacy `~/.honeycomb` fallback. Runtime wires it at `src/hooks/runtime.ts:232`.
- Normalize: `src/hooks/runtime.ts:292`.
- Local request: `src/hooks/shared/daemon-client.ts:106-111` (loopback `/api/hooks`).
- No DeepLake or storage-transport import under `src/hooks/`. Pre-tool and capture comments and call sites go through injected seams, not SQL (`src/hooks/shared/capture.ts:69`, `src/hooks/shared/pre-tool-use.ts:13-16`).

### AC-3 - UNMET

- Quote: "Given session-start runs with capture enabled, when it completes, then tables are ensured, a placeholder row is written, the context block is rendered, and `additionalContext` is returned."
- PRD: `prd-019b-harness-integrations-hook-lifecycle.md:51`
- Order in `runSessionStart` does call ensure, placeholder, render, and return (`src/hooks/shared/session-start.ts:193-201` and `:205` and `:277`).
- The production seam no-ops the two write steps: `src/hooks/shared/session-start-seams.ts:122-126` (`ensureTables` and `writePlaceholderSummary` are empty). Runtime uses that factory (`src/hooks/runtime.ts:279`). Context render and `additionalContext` return are real (`src/hooks/runtime.ts:236`, `src/hooks/shared/session-start.ts:239-277`). Tables and the placeholder row are not.

### AC-4 - MET

- Quote: "Given a pre-tool Bash `grep` on the memory path, when the hook runs, then the result is the daemon's hybrid search output and nothing reaches the real filesystem."
- PRD: `prd-019b-harness-integrations-hook-lifecycle.md:52`
- Bash `grep` / `rg` / `egrep` lower to verb `search` (`src/hooks/shared/pre-tool-use.ts:294-297`). The resolve goes to the injected VFS seam (`:140-145`).
- Production seam: `GET /memory/grep` (`src/hooks/runtime.ts:598-603`). No `node:fs` import in `src/hooks/shared/pre-tool-use.ts`.

### AC-5 - UNMET

- Quote: "Given a session ends, when session-end runs, then it marks the session ended, records usage, fires skillify, and spawns the detached summary worker under the per-session lock."
- PRD: `prd-019b-harness-integrations-hook-lifecycle.md:53`
- Mark, usage, and skillify are one daemon POST: `src/hooks/shared/session-end.ts:105-114` body `intents: ["mark-ended", "record-usage", "skillify"]` to `/api/hooks/session-end`.
- The lock parameter defaults to `createFakeSummaryLock()` (`src/hooks/shared/session-end.ts:78`). `dispatchLifecycle` does not pass a real lock (`src/hooks/runtime.ts:384`).
- The spawn defaults to `noopSummarySpawn`, whose `spawn` is empty (`src/hooks/runtime.ts:271` and `:474-476`). No production caller of `createHookRuntime` outside tests supplies `summarySpawn`. The detached worker is not spawned.

### AC-6 - MET

- Quote: "Given two runtime paths attempt the same session, when the second call lands, then the daemon returns `409` and only one path stays active."
- PRD: `prd-019b-harness-integrations-hook-lifecycle.md:54`
- Claim service returns not-ok on a different path: `src/daemon/runtime/middleware/runtime-path.ts:164-166`. Middleware turns that into HTTP 409 and does not call `next()`: same file `:305-314`.
- Assembly installs the real service: `src/daemon/runtime/assemble.ts:3325` (`runtimePath: createRuntimePathService()`).
- The hook surfaces status 409 as `runtime-path-conflict` and still stamps the header: `src/hooks/shared/capture.ts:35` and `:84-94`, header at `src/hooks/shared/daemon-client.ts:118`.

## 019c per-harness shims

### AC-1 - UNMET

- Quote: "Given each harness in the matrix, when its session runs, then capture, recall, and summary spawn produce the same daemon-written rows as the Claude Code reference."
- PRD: `prd-019c-harness-integrations-harness-shims.md:50`
- Matrix named in scope (`prd-019c-harness-integrations-harness-shims.md:10`): Claude Code, OpenClaw, Codex, Cursor, Hermes, pi, OpenCode, Gemini CLI, Oh My Pi.
- Hook binaries that reach the shared capture path: Claude Code, Codex, Cursor only (see index AC-2).
- Hermes, pi, OpenClaw: shim modules exist under `src/hooks/{hermes,pi,openclaw}/shim.ts` and are not called from `harnesses/`.
- OpenCode, Gemini CLI, Oh My Pi: ABSENT. No `harnesses/` directory and no `src/hooks/` shim.
- Summary spawn is a no-op even for the Claude Code reference (`src/hooks/runtime.ts:474-476`), so no harness produces summary rows.
- pi extension entry cited by the shim (`src/hooks/pi/shim.ts:15-18`, path `harnesses/pi/extension-source/honeycomb.ts`) is ABSENT. `harnesses/pi/` contains only `src/index.ts`.

### AC-2 - UNMET

- Quote: "Given a harness cannot intercept a write (no pre-tool hook), when goal or KPI routing is needed, then the shim falls back to a CLI call rather than dropping the action."
- PRD: `prd-019c-harness-integrations-harness-shims.md:51`
- Helpers exist and are not on the lifecycle path. `openclawGoalKpiFallback` (`src/hooks/openclaw/shim.ts:166-171`) and `piGoalKpiFallback` (`src/hooks/pi/shim.ts:69-74`) call `cli.run(["honeycomb", verb, ...args])`.
- Repo callers of those functions are the test files only (`tests/hooks/openclaw/shim.test.ts`, `tests/hooks/pi/shim.test.ts`). `src/hooks/runtime.ts` never calls them. A goal or KPI write on those harnesses is not routed.

### AC-3 - UNMET

- Quote: "Given OpenClaw fires `agent_end`, when the shim runs, then only the new-message slice since the last flush is sent and the resulting rows match incremental capture."
- PRD: `prd-019c-harness-integrations-harness-shims.md:52`
- Slice helper: `src/hooks/openclaw/shim.ts:98-103`. Expand-to-`HookInput` is in the same file (batch comment at `:107-110`).
- The OpenClaw harness does not run the shim (`harnesses/openclaw/src/index.ts:64-66`). The single-event normalizer does not send the slice (`src/hooks/openclaw/shim.ts:184-185`). No cursor is persisted by the harness entry. The new-message flush does not run.

### AC-4 - UNMET

- Quote: "Given Codex session-start, when it runs, then `autoUpdate` and table-ensure happen in a detached setup process and only a brief login-state line is injected."
- PRD: `prd-019c-harness-integrations-harness-shims.md:53`
- Brief line: `src/hooks/codex/shim.ts:70` and `:77-78` (`codexRenderUserVisible` replaces the block with `honeycomb: signed in - memory recall active` or the read-only line). Response shape: `:88-91`.
- Detached setup is a constant only: `src/hooks/codex/shim.ts:60-67` names `session-start-setup.ts` and `deferred: ["autoUpdate", "ensureTables"]`. That file is ABSENT (no `session-start-setup` anywhere in the repo).
- The Codex binary uses the shared runtime (`harnesses/codex/src/index.ts:36-37`), and production `autoUpdate` / `ensureTables` are empty in-process functions (`src/hooks/shared/session-start-seams.ts:124-125`), not a detached process.

### AC-5 - UNMET

- Quote: "Given a model-only context channel and a user-visible one, when each shim injects context, then the same logical block lands through the correct channel for that harness."
- PRD: `prd-019c-harness-integrations-harness-shims.md:54`
- Channel router: `src/hooks/normalize.ts:183-198`. Model-only keeps `additionalContext: block`. User-visible runs `renderUserVisible`.
- Declared channels: Claude Code model-only (`src/hooks/claude-code/shim.ts:91`), Cursor model-only (`src/hooks/cursor/shim.ts:45`), OpenClaw model-only (`src/hooks/openclaw/shim.ts:52`), Codex user-visible (`src/hooks/codex/shim.ts:44`), Hermes user-visible (`src/hooks/hermes/shim.ts:40`), pi user-visible (`src/hooks/pi/shim.ts:33`).
- The same logical block does not land. Codex substitutes a fixed login sentence (`src/hooks/codex/shim.ts:77-78`). Hermes appends an MCP mention (`src/hooks/hermes/shim.ts:59-60`). pi wraps a fenced `AGENTS.md` section (`src/hooks/pi/shim.ts:54-56`) and the extension that would write it is absent.
- OpenCode, Gemini CLI, and Oh My Pi have no channel implementation. Hermes, pi, and OpenClaw harness entries do not inject.

### AC-6 - UNMET

- Quote: "Given a shim change, when it is reviewed, then it references the sibling repo under `references/<harness>/` for the protocol it relies on."
- PRD: `prd-019c-harness-integrations-harness-shims.md:55`
- String constants: `src/hooks/claude-code/shim.ts:100`, `src/hooks/codex/shim.ts:50`, `src/hooks/cursor/shim.ts:48`, `src/hooks/hermes/shim.ts:43`, `src/hooks/pi/shim.ts:37`, `src/hooks/openclaw/shim.ts:57`.
- On disk, `references/` has `claude-code/`, `codex/`, and `cursor/` schema fixtures (`references/README.md:1-3`). `references/hermes/`, `references/pi/`, and `references/openclaw/` are ABSENT.
- Those fixtures are zod oracles for hook JSON, not sibling harness repos (`references/README.md:16-19`). No CI check of the gate lives under the evidence trees. 019a and 019c both leave CI enforcement as an open question.

## 019d MCP server

### AC-1 - MET

- Quote: "Given the MCP server is running, when a harness lists tools, then the unified `honeycomb_` surface appears and each handler stamps `x-honeycomb-runtime-path: plugin` plus actor headers."
- PRD: `prd-019d-harness-integrations-mcp-server.md:49`
- `registerHoneycombSurface` registers `TOOL_SPECS` (`mcp/src/registry.ts:166-177`). `startMcpServer` connects stdio so a spawn can list tools (`mcp/src/index.ts:152-156`).
- `stampHeaders` sets `x-honeycomb-runtime-path` to the plugin path plus `x-honeycomb-actor` and `x-honeycomb-actor-type` (`mcp/src/daemon-seam.ts:83-88`). `route` passes the server actor, not tool args (`mcp/src/handlers.ts:41-46`).
- Names are mixed (`memory_*`, `honeycomb_*`, `hivemind_*`, `secret_*`) as published in `mcp/src/tools.ts:77-138`. That is the registered surface.

### AC-2 - UNMET

- Quote: "Given a secrets tool is called, when it returns, then values are never exposed: `secret_list` returns names and `secret_exec` returns redacted output."
- PRD: `prd-019d-harness-integrations-mcp-server.md:50`
- `secret_list` rebuilds `{ names }` from strings only: `mcp/src/handlers.ts:98-105` and call at `:312-320`. That half holds.
- `secret_exec` does not force a redaction sentinel. `toSecretExecResult` copies `stdout` and `stderr` into `output` when they are non-empty, else `output` (`mcp/src/handlers.ts:117-137`). A daemon body that puts a raw value in `stdout` is returned. The SDK floor does the stricter thing (`src/sdk/client.ts:386-392`); the MCP handler does not.

### AC-3 - MET

- Quote: "Given `memory_modify` or `memory_forget` is called without a reason, when the handler runs, then the call is rejected."
- PRD: `prd-019d-harness-integrations-mcp-server.md:51`
- Handlers return `errorResult` before `route` when `reasonOf` is empty: `mcp/src/handlers.ts:248-264`. Schemas require `reason: z.string()`: `mcp/src/tools.ts:89-94`.

### AC-4 - UNMET

- Quote: "Given the workspace graph is not built, when a harness lists tools, then the codebase cluster is absent; after `honeycomb graph build`, the codebase tools appear."
- PRD: `prd-019d-harness-integrations-mcp-server.md:52`
- Absent by default: `graphBuilt` defaults false and conditional names are skipped (`mcp/src/index.ts:82`, `mcp/src/registry.ts:170-174`). Conditional names: `mcp/src/tools.ts:130-133` and `:143-144`.
- Nothing in `mcp/src`, `harnesses/`, `src/connectors/`, `src/hooks/`, or `src/sdk/` sets `graphBuilt` from `honeycomb graph build`. The production auto-start calls `startMcpServer()` with no options (`mcp/src/index.ts:199`), so the codebase tools stay absent after a graph build. The only `graphBuilt: true` call sites are tests.

### AC-5 - UNMET

- Quote: "Given a child session key, when `session_search` runs, then it can infer the parent session lineage."
- PRD: `prd-019d-harness-integrations-mcp-server.md:53`
- `session_search` is not in `TOOL_SPECS` (`mcp/src/tools.ts:11-18` records the 2026-07-03 removal). `inferParentSessionKey` remains a pure helper (`mcp/src/sessions.ts:36-49`) and is not registered as a tool. The tool cannot run.

### AC-6 - MET

- Quote: "Given the daemon is reachable, when the same tool is called over streamable HTTP and over stdio, then both route through the daemon API and return equivalent results."
- PRD: `prd-019d-harness-integrations-mcp-server.md:54`
- One `McpServer` cannot take two live transports (`mcp/src/transports.ts:150-156`). `startMcpServer` connects stdio on the primary server and, when `serveHttp` is true, builds a second server with the same options and connects its HTTP transport (`mcp/src/index.ts:152-164`).
- Both servers use `createMcpServer`, which defaults to the same `createHttpDaemonApiSeam` and the same `TOOL_SPECS` handlers (`mcp/src/index.ts:80-85`). Equivalent routing is in source. Default auto-start is stdio only (`:198-199`); HTTP is the `serveHttp: true` path.

## 019e SDK

`package.json` exports `./sdk/index.js`, `./sdk/react.js`, `./sdk/vercel.js`, and `./sdk/openai.js`. The `sdk/` directory is not in the tree. The implementation judged below is `src/sdk/`.

### AC-1 - MET

- Quote: "Given the client, when `remember` and `recall` are called, then they wrap the daemon endpoints and carry the configured token, actor, and actor type."
- PRD: `prd-019e-harness-integrations-sdk.md:48`
- `remember` calls `memory.store` (`POST /api/memories`); `recall` calls `memory.search` (`POST /api/memories/recall`): `src/sdk/client.ts:272-298` and `:397-401`.
- Every request uses `buildHeaders`, which sets `x-honeycomb-actor`, `x-honeycomb-actor-type`, and `Authorization: Bearer <token>` when the token is set and the URL is loopback or HTTPS (`src/sdk/client.ts:139-157`).

### AC-2 - MET

- Quote: "Given a request fails, when the error surfaces, then it is typed (API error for non-2xx, network error for transport, timeout error past budget), and GET retries while mutating requests do not."
- PRD: `prd-019e-harness-integrations-sdk.md:49`
- Classes: `src/sdk/contracts.ts:49`, `:62`, `:73`.
- Mapping and retry split: `src/sdk/client.ts:203-242` (timeout throws `TimeoutError`, transport throws `NetworkError`, non-2xx throws `ApiError`, GET retries, mutations do not).
- Default policy: GET 3 attempts, other methods 1 (`src/sdk/contracts.ts:115-123`).

### AC-3 - MET

- Quote: "Given a browser, Node, and Bun runtime, when the client runs, then it works in all three with no native dependency."
- PRD: `prd-019e-harness-integrations-sdk.md:50`
- `src/sdk/client.ts` imports only `./contracts.js` (`:18-41`). No `node:` import and no `require` in `src/sdk/`. Transport is global `fetch` (`src/sdk/client.ts:118`). This standing pass did not execute the client under Bun or a browser. The source that would run there has no native module.

### AC-4 - MET

- Quote: "Given the React bindings, when a component calls `useRecall`, then it gets results plus loading and typed-error state from the core client."
- PRD: `prd-019e-harness-integrations-sdk.md:51`
- `useRecall` calls `client.recall` and sets `{ loading: true }`, then `{ loading: false, results }` or `{ loading: false, error }` (`src/sdk/react.ts:61-74`). React hooks are injected as `ReactRuntime` because `react` is not a compile dependency (`src/sdk/react.ts:11-18`). The state the criterion names is returned from the core client.

### AC-5 - MET

- Quote: "Given the Vercel AI SDK and OpenAI helpers, when memory tools are registered, then they reuse the core client's token and actor model."
- PRD: `prd-019e-harness-integrations-sdk.md:52`
- Vercel `execute` calls `client.recall` / `client.remember` (`src/sdk/vercel.ts:39-55` and the remember tool at `:58`).
- OpenAI dispatch calls the same client methods (`src/sdk/openai.ts:78-88`). Neither helper builds its own HTTP stack, so token and actor stay on `buildHeaders`.

### AC-6 - MET

- Quote: "Given the secrets surface, when it is used, then it returns names and redacted output only and never a raw value."
- PRD: `prd-019e-harness-integrations-sdk.md:53`
- `secrets.list` maps the daemon `names` array to `{ name }` only (`src/sdk/client.ts:372-377`).
- `secrets.exec` returns `{ redactedOutput }` and, when that field is missing, `SECRET_REDACTED` (`[REDACTED]`). It does not read `stdout` or `output` (`src/sdk/client.ts:47-51` and `:379-392`).

## Reports in this folder

- `reports/2026-06-18-qa-report.md` says CLEAN TO SHIP, 36/36. That does not match this source pass. Do not use it to mark the PRD completed.
- `reports/2026-06-18-security-report.md` says the MCP `secret_exec` path is fail-closed. Current `mcp/src/handlers.ts:128-134` copies `stdout`/`stderr`. The SDK floor described there is still present in `src/sdk/client.ts`.

## What a later writer should do

- Leave the folder in `in-work/`.
- Do not treat `756bacb` as proof the work is unfinished for the reasons printed in the banner. Re-state the remaining gaps from the unmet rows above: matrix harnesses not wired, summary spawn and table-ensure no-ops, `session_search` unregistered, codebase tools not tied to graph build, MCP secret exec passthrough, connector subclasses that override more than the four seams.
- Correct the index banner if a writer is allowed to edit PRDs: the registry includes Codex, and the Claude Code plugin manifest does register MCP.

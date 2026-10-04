# Integrations knowledge standing

Shard: `library/knowledge/private/integrations/` only.
Branch context: `legion/kb-sotu-and-prd-lifecycle`.
Date: 2026-10-04.
Read-only against product source. No knowledge page was edited.

Production harnesses treated as supported: `claude-code`, `codex`, `cursor`.
In-progress source trees: `hermes`, `pi`, `openclaw`.
MCP production transport treated as stdio. Package name treated as `@legioncodeinc/honeycomb`.
Build outputs skipped (`harnesses/*/bundle`, `mcp/bundle`, `node_modules`).

## Coverage

Knowledge files in this shard (3):

| File | Page action |
|---|---|
| `library/knowledge/private/integrations/mcp-and-sdk.md` | REVISE |
| `library/knowledge/private/integrations/harness-integration.md` | REVISE |
| `library/knowledge/private/integrations/hook-lifecycle.md` | REVISE |

No page is a duplicate. No page should be removed. No new integrations page is required; the holes are inside these three.

Related links named by these pages were checked and the sibling files exist: `daemon-surface.md`, `retrieval.md`, `secrets.md`, `memory-virtual-filesystem.md`, `codebase-graph.md`, `monorepo-build-release.md`, `auth-architecture.md`, `request-lifecycle.md`, `cursor-extension-architecture.md`, `npm-publishing.md`, `session-capture.md`, `team-skills-sharing.md`, `asset-sync-substrate.md`, `credential-storage.md`. Missing-sibling is not a hole.

## Defects

### D-01

- Quote: "It binds two transports against one `McpServer` ... a **stdio** transport when run as a subprocess (`node mcp/bundle/server.js`), and a **streamable-HTTP** transport served at `/mcp` on loopback."
- Doc: `library/knowledge/private/integrations/mcp-and-sdk.md:22`
- Grounding: `mcp/src/index.ts:109` (`serveHttp` defaults `false`); `mcp/src/index.ts:137` (SDK allows one transport per server); `mcp/src/index.ts:155` (production start connects stdio); `mcp/src/index.ts:160` (HTTP only when `serveHttp === true`); `mcp/src/index.ts:198` (main entry calls `startMcpServer()` with no options)
- Verdict: FALSE
- Action: REVISE

The construction helper binds both transport objects. The process entry that `node mcp/bundle/server.js` runs connects stdio only. The daemon `/mcp` group is a separate 501 scaffold (see the hold list).

### D-02

- Quote: "The codebase tools surface the query endpoints documented in [`../data/codebase-graph.md`](../data/codebase-graph.md) once a graph exists for the workspace, and are only registered after `honeycomb graph build`."
- Doc: `library/knowledge/private/integrations/mcp-and-sdk.md:36`
- Grounding: `mcp/src/index.ts:82` (`graphBuilt` defaults `false`); `mcp/src/index.ts:198` (main entry never passes `graphBuilt`); `mcp/src/handlers.ts:216` (handlers still dial `/api/code/*`); `mcp/src/handlers.ts:289`; `src/daemon/runtime/codebase/api.ts:15` (live surface is `POST /api/graph/build` and `GET /api/graph`); `src/daemon/runtime/server.ts:84` (`/api/graph` is the mounted group; `/api/code` is absent)
- Verdict: FALSE
- Action: REVISE

### D-03

- Quote: "Where a harness speaks MCP, the connector registers the Honeycomb server during `honeycomb connect` so the `honeycomb_*` tools appear in the harness's native tool list, no separate \"add an MCP server\" step for the user. The registration is the stdio entry `node mcp/bundle/server.js`."
- Doc: `library/knowledge/private/integrations/mcp-and-sdk.md:52`
- Grounding: `src/cli/connector-runner.ts:62` (registry is `claude-code`, `codex`, `cursor` only; no MCP write); `harnesses/claude-code/.mcp.json:4` (static plugin file, args `${CLAUDE_PLUGIN_ROOT}/mcp/bundle/server.js`); `harnesses/hermes/.mcp.json:5` (static in-progress file); ABSENT `.mcp.json` under `harnesses/codex` and `harnesses/cursor`; ABSENT MCP registration in `src/connectors/`
- Verdict: FALSE
- Action: REVISE

Claude Code ships a static `.mcp.json` inside the marketplace plugin. That is packaging, not a connector write during `honeycomb connect`. Codex and Cursor have no MCP registration file.

### D-04

- Quote: "OpenClaw gets a native extension on top of MCP (registered during its connect step). It registers the same memory and browse tools plus the goal and KPI tools as agent-callable commands, batches capture at `agent_end`, and supplements the agent's memory corpus on `before_agent_start`."
- Doc: `library/knowledge/private/integrations/mcp-and-sdk.md:62`
- Grounding: `harnesses/openclaw/src/index.ts:64` (`register` applies tuning and `bootHarness("openclaw")` only); `src/hooks/openclaw/shim.ts:180` (`agent_end` normalizes to session-end, not a capture batch); `src/cli/connector-runner.ts:62` (OpenClaw is not a connector); ABSENT tool registration under `harnesses/openclaw/`
- Verdict: FALSE
- Action: REVISE

The env-harvest sentence in the same paragraph holds: `harnesses/openclaw/src/index.ts:50` writes `globalThis.__honeycomb_tuning__`. Keep that sentence. Revise the tool, batch, and connect claims. `openclawExpandBatch` exists at `src/hooks/openclaw/shim.ts:113` and is used by tests, not by the shim's live `extractData`.

### D-05

- Quote: "await honeycomb.remember(\"prefers TypeScript\", { importance: 0.9, tags: \"language\" }); const { results } = await honeycomb.recall(\"language preferences\", { limit: 5 });" and `token: "Bearer hc_sk_..."`
- Doc: `library/knowledge/private/integrations/mcp-and-sdk.md:73`
- Grounding: `src/sdk/contracts.ts:160` (`RememberOptions` is `path?` only); `src/sdk/contracts.ts:205` (`recall` returns `readonly RecallResult[]`); `src/sdk/client.ts:155` (client writes `Authorization: Bearer ${opts.token}`)
- Verdict: FALSE
- Action: REVISE

`createHoneycombClient` at `src/sdk/client.ts:117` and the subpath exports in `package.json:17` hold. The sample does not match the typed client.

### D-06

- Quote: "The client covers memory, the hook entry points, connectors and documents, sources, skills and goals, health and diagnostics, and the value-safe secrets surface."
- Doc: `library/knowledge/private/integrations/mcp-and-sdk.md:82`
- Grounding: `src/sdk/contracts.ts:208` (groups are `memory`, `hooks`, `connectors`, `documents`, `sources`, `skills`, `goals`, `health`, `secrets`); `src/sdk/contracts.ts:260` (`HealthApi.check` only); ABSENT a diagnostics method on `HoneycombClient`
- Verdict: HOLE
- Action: REVISE

### D-07

- Quote: "`memory_get` fetches a single memory by path"
- Doc: `library/knowledge/private/integrations/mcp-and-sdk.md:44`
- Grounding: `mcp/src/handlers.ts:235` (`GET /api/memories/${path}` with the tool field named `path`); `mcp/src/handlers.ts:246` (comment: the `path` arg rides the URL as the memory id); `src/daemon/runtime/memories/api.ts:1046` (`GET /api/memories/:id` is get-by-id); `src/daemon/runtime/memories/reads.ts:215` (`getMemory(id)`)
- Verdict: FALSE
- Action: REVISE

`hivemind_read` in the same sentence holds: `mcp/src/handlers.ts:298` routes to `GET /api/memories/resolve`.

### D-08

- Quote: "the context channel is model-only on some harnesses (Claude Code, Cursor, OpenClaw) and user-visible on others (Codex, Hermes, pi), so each shim normalizes before handing off and renders the context block through its harness's channel."
- Doc: `library/knowledge/private/integrations/harness-integration.md:89`
- Grounding: `src/hooks/codex/shim.ts:44` (channel is `user-visible`); `src/hooks/codex/shim.ts:77` (`codexRenderUserVisible` replaces the block with `CODEX_LOGIN_LINE` or a read-only line)
- Verdict: HOLE
- Action: REVISE

The channel names hold. Codex does not render the assembled rules/goals/prime block. It emits a one-line login string.

### D-09

- Quote: "For harnesses that speak the Model Context Protocol, the Honeycomb MCP server is registered during install so its `honeycomb_*` tools appear in the harness's native tool list. ... The same `node mcp/bundle/server.js` stdio entry registers into the other MCP-speaking harnesses during their connect step."
- Doc: `library/knowledge/private/integrations/harness-integration.md:93`
- Grounding: same as D-03. `src/cli/connector-runner.ts:62`; `harnesses/claude-code/.mcp.json:4`; `harnesses/hermes/.mcp.json:5`; ABSENT Codex and Cursor `.mcp.json`; ABSENT MCP writes in `src/connectors/`
- Verdict: FALSE
- Action: REVISE

The Hermes mention string in the following sentence holds: `src/hooks/hermes/shim.ts:46`.

### D-10

- Quote: "`GET /api/diagnostics/harnesses` `pluginEnabled` returns `false` in production because the resolver is not injected at the composition root. The **authoritative** value is `honeycomb harness status --json`; the dashboard/hive card must read the verb, not the endpoint field."
- Doc: `library/knowledge/private/integrations/harness-integration.md:120`
- Grounding: `src/daemon/runtime/assemble.ts:3590` (composition root constructs `createHarnessPluginStatusHolder`); `src/daemon/runtime/dashboard/harness-plugin-status.ts:26` (empty until the first push, then the pushed set); `src/daemon/runtime/dashboard/harness-status-ingest.ts:22` (`POST /api/diagnostics/harness-status`); `src/cli/runtime.ts:716` (reconcile posts `pluginEnabled`)
- Verdict: STALE
- Action: REVISE

W-1 on the previous line holds: reconcile is armed from `src/cli/runtime.ts:756` via `onDaemonUp`, and the daemon does not import the connector registry.

### D-11

- Quote: "`AGENTS.md` in the workspace is the source of truth for operating instructions, and the daemon's file watcher syncs it into each harness's identity file (`~/.claude/CLAUDE.md`, the pi `AGENTS.md` block, and so on), each copy stamped do-not-edit. A manual re-sync is `POST /api/harnesses/regenerate`."
- Doc: `library/knowledge/private/integrations/harness-integration.md:124`
- Grounding: `src/daemon/runtime/assemble.ts:3322` (`harnessTargets: options.harnessTargets ?? []`); `src/daemon/runtime/services/harness-sync.ts:69` (canonical set is `agent.yaml`, `AGENTS.md`, `SOUL.md`, `MEMORY.md`, `IDENTITY.md`, `USER.md`); `src/daemon/runtime/services/harness-sync.ts:29` (do-not-edit header exists when a target is injected); ABSENT `POST /api/harnesses/regenerate` under `src/`
- Verdict: FALSE
- Action: REVISE

The sync function exists. Production assembly passes an empty target list, so it writes no harness identity copies. `~/.claude/CLAUDE.md` appears only as a comment example in `src/daemon/runtime/services/file-watcher.ts:162`.

### D-12

- Quote: "the acting engineer inspects the sibling harness repo under `references/` (for example `references/openclaw/`, `references/cursor/`, `references/codex/`)"
- Doc: `library/knowledge/private/integrations/harness-integration.md:132`
- Grounding: `references/cursor/hooks-schema.ts:1` (exists); `references/codex/hooks-schema.ts` (exists); ABSENT `references/openclaw/`; ABSENT `references/hermes/` and `references/pi/` (cited from the shims, not this sentence)
- Verdict: FALSE
- Action: REVISE

The Cursor clause later in the same paragraph holds: the flat shape is implemented against `references/cursor/hooks-schema.ts`, and `src/connectors/cursor.ts:21` cites that file.

### D-13

- Quote: "Pre-tool intercept (VFS recall) | ... | `beforeShellExecution` (Shell) | ..." and "Cursor normalizes its `Shell` tool to the canonical `Bash` shape so the same intercept applies"
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:34` and `library/knowledge/private/integrations/hook-lifecycle.md:137`
- Grounding: `src/hooks/cursor/shim.ts:36` (`CURSOR_EVENT_MAP` has no `beforeShellExecution`); `src/hooks/cursor/shim.ts:88` (`Shell` on logical `tool_call` returns `preToolData`); `src/hooks/runtime.ts:377` (VFS runs only for logical `pre-tool-use`); `src/connectors/cursor.ts:66` (connector registers `pre-tool-use` as `beforeShellExecution`); `harnesses/cursor/src/index.ts:47` (binary uses `createCursorShim()`)
- Verdict: FALSE
- Action: REVISE

The doc says these maps live in each `src/hooks/<harness>/shim.ts` (`hook-lifecycle.md:28`). The Cursor pre-tool native name lives on the connector. The shim that the hook binary runs does not map that event, so the registered `beforeShellExecution` handler does not reach `runPreToolUse`.

### D-14

- Quote: "Pre-tool intercept (VFS recall) | ... | `on_tool_use` (terminal only) | ..." and "Hermes intercepts terminal tools only"
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:34` and `library/knowledge/private/integrations/hook-lifecycle.md:137`
- Grounding: `src/hooks/hermes/shim.ts:33` (`on_tool_use` maps to `tool_call` only); `src/hooks/hermes/shim.ts:80` (non-terminal tools are dropped from capture); ABSENT a `pre-tool-use` entry in `HERMES_EVENT_MAP`
- Verdict: FALSE
- Action: REVISE

Terminal-only tool-call capture holds. It is not a VFS pre-tool intercept.

### D-15

- Quote: "The lifecycle is still functionally complete: OpenClaw batches capture across the full conversation in `agent_end` rather than per-event, producing the same rows the daemon would have written incrementally, just grouped into one flush; pi reads its session-start context from the static `AGENTS.md` block rather than a live event."
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:39`
- Grounding: `src/hooks/openclaw/shim.ts:184` (live `agent_end` path returns session-end data); `src/hooks/openclaw/shim.ts:113` (`openclawExpandBatch` is not called from `createOpenClawShim`); `harnesses/pi/src/index.ts:8` (`activate` is `bootHarness("pi")` only); ABSENT `harnesses/pi/extension-source/honeycomb.ts` (named by `src/hooks/pi/shim.ts:17`)
- Verdict: FALSE
- Action: REVISE

The in-progress status in `harness-integration.md` and `src/daemon/runtime/dashboard/harness-registry.ts:147` holds. This sentence overstates those trees as functionally complete.

### D-16

- Quote: "2. Heal token/org drift with `healDriftedOrgToken`. 3. `autoUpdate`, self-update if a newer plugin exists. 4. Ensure the `memory` and `sessions` tables exist. ... 5. Write a placeholder summary row ... 8. ... spawn the detached graph-pull worker"
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:84`
- Grounding: `src/hooks/shared/session-start.ts:188` (the orchestrator calls those seams); `src/hooks/runtime.ts:279` (production seams are `createSessionStartSeams`); `src/hooks/shared/session-start-seams.ts:123` (`healDriftedOrgToken`, `autoUpdate`, `ensureTables`, `writePlaceholderSummary`, and `spawnGraphPull` are empty functions)
- Verdict: STALE
- Action: REVISE

Credential load, context render, prime render, the recall-awareness notice, and the skills/assets pulls are real. The numbered heal, update, table-ensure, placeholder, and graph-pull steps are calls into no-ops.

### D-17

- Quote: "Render the rules/goals context block (read-only, runs regardless of the gate)"
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:88`
- Grounding: `src/hooks/shared/context-renderer.ts:17` (POST `/api/hooks/context`); `src/daemon/runtime/capture/attach.ts:216` (default handler returns `{ additionalContext: "" }`); `src/daemon/runtime/assemble.ts:1373` (`attachHooks` does not pass `contextHandler`)
- Verdict: STALE
- Action: REVISE

The hook does request the block. Production leaves the handler as the empty default. The prime digest (`GET /api/memories/prime`, `src/hooks/shared/prime-renderer.ts:43`) and `RECALL_AWARENESS_NOTICE` (`src/hooks/shared/session-start.ts:69`) still run.

### D-18

- Quote: "A signed-out session POSTs unscoped and the daemon fail-closes it to a no-op."
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:103`
- Grounding: `src/hooks/shared/session-start-seams.ts:242` (skills headers omit org when the credential has none); `src/hooks/shared/session-start-seams.ts:195` (assets scope uses org `"local"` when the credential org is absent)
- Verdict: FALSE
- Action: REVISE

The skills pull matches the sentence. The assets pull does not. It stamps a local org sentinel. The 5-second skills budget holds (`src/daemon-client/skillify/install.ts:71`, `AUTOPULL_TIMEOUT_MS = 5_000`). The kill-switch names hold.

### D-19

- Quote: "query-aware recall injected synchronously on **every** `UserPromptSubmit`"
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:109`
- Grounding: `harnesses/claude-code/hooks/hooks.json:15` (second `UserPromptSubmit` entry passes `--honeycomb-recall`); `src/hooks/claude-code/shim.ts:65` (recall mode maps only `UserPromptSubmit`); `src/hooks/codex/shim.ts:38` (`UserPromptSubmit` maps to `user_message` capture); `tests/hooks/shims-channel.test.ts:89` (only the Claude Code recall-mode shim maps `user_prompt_recall`)
- Verdict: FALSE
- Action: REVISE

The Claude Code double registration holds. Codex uses the same native event name for capture only. Cursor's prompt event is `beforeSubmitPrompt` and is capture-only (`src/hooks/cursor/shim.ts:38`).

### D-20

- Quote: "`renderContext` knows which event it is rendering for, so the prompt-time recall block is shaped for a mid-session inject, not reusing the session-start digest layout."
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:114`
- Grounding: ABSENT `renderContext` under `src/hooks/`; `src/hooks/shared/context-renderer.ts:34` (session context render has no event branch); `src/hooks/shared/user-prompt-recall.ts:142` (`renderRecallBlock` is a separate function)
- Verdict: FALSE
- Action: REVISE

### D-21

- Quote: "No new recall engine is involved; both arms reuse the same daemon recall verbatim." and "At a mount without an embed client wired, `/memory/grep` recall runs the hybrid engine's lexical floor (`degraded:true`)"
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:109` and `library/knowledge/private/integrations/hook-lifecycle.md:117`
- Grounding: `src/hooks/shared/recall-renderer.ts:48` (prompt arm is `POST /api/memories/recall`); `src/hooks/shared/prime-renderer.ts:43` (session-start arm is `GET /api/memories/prime`); `src/hooks/runtime.ts:600` (pre-tool arm is `GET /memory/cat|grep|ls|find`); `src/daemon/runtime/vfs/api.ts:336` (the unwired-embed lexical floor is `fetchGrep`, and the comment says no embed client is injected there)
- Verdict: FALSE
- Action: REVISE

The `/memory/grep` degraded-lexical fact holds for the VFS handler. It is the wrong route for this section. The two recall arms do not share one daemon route.

### D-22

- Quote: "`cat` / `Read` on a path becomes a direct row read via the daemon's `readVirtualPathContent`. `grep` / `Glob` becomes a hybrid lexical-plus-semantic search through the daemon's grep-direct path."
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:133`
- Grounding: ABSENT `readVirtualPathContent` and `grep-direct` under `src/`; `src/hooks/runtime.ts:600` (`read` is `GET /memory/cat`, `search` is `GET /memory/grep`, `list` is `GET /memory/ls`, `find` is `GET /memory/find`)
- Verdict: FALSE
- Action: REVISE

The verb routing (cat/Read, grep/Glob, ls, find, Write/Edit deny, unmodelable echo) holds in `src/hooks/shared/pre-tool-use.ts:87`. The named daemon functions do not.

### D-23

- Quote: "On an assistant-response event, capture additionally asks the daemon to evaluate the stop-counter trigger, which may fire the skillify miner independently of the summary worker."
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:127`
- Grounding: `src/hooks/shared/capture.ts:48` (body is `{ event, metadata }` with no stop-counter field); ABSENT `isTurnTerminating` under `src/hooks/`; `src/daemon/runtime/capture/event-contract.ts:174` (defaults `false`); `src/daemon/runtime/capture/capture-handler.ts:827` (`tryStopCounterTrigger` runs only when `meta.isTurnTerminating`)
- Verdict: FALSE
- Action: REVISE

The daemon function exists. Hook capture never sets the flag, so the trigger does not run on the live capture path.

### D-24

- Quote: "1. Mark the session ended so other sessions stop treating it as live. 2. Record usage by parsing the transcript for memory-search activity. 3. Fire skillify mining ... 4. Acquire the per-session summary lock and spawn the summary worker. The detached worker ... shells the harness's host CLI (the per-harness binary in the table above)"
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:162`
- Grounding: `src/hooks/shared/session-end.ts:105` (hook POSTs intents `mark-ended`, `record-usage`, `skillify`, then calls `spawn`); `src/hooks/runtime.ts:271` (default `summarySpawn` is `noopSummarySpawn`); `src/hooks/binary.ts:91` (binaries call `createHookRuntime` without a spawn); `src/daemon/runtime/capture/attach.ts:198` (default session-end handler acks those intents and enqueues a `summary` job; the comment says the real mark/usage/skillify body is still deferred); `src/daemon/runtime/summaries/job.ts:153` (daemon CLI matrix: codex is `codex exec -`, hermes is `hermes -p`, pi is `pi -p`, unknown agents including `openclaw` fall through to `claude -p`)
- Verdict: STALE
- Action: REVISE

The shim host-CLI table (`hook-lifecycle.md:43`) matches the shim constants (`src/hooks/claude-code/shim.ts:97`, `src/hooks/codex/shim.ts:46`, `src/hooks/cursor/shim.ts:47`, `src/hooks/hermes/shim.ts:42`, `src/hooks/pi/shim.ts:36`, `src/hooks/openclaw/shim.ts:56`). The live summary worker does not shell that table. It uses `summaryCliSpecFor`.

## Checked claims that hold

These were checked and should stay. Action LEAVE for each claim. Verdict HOLDS.

- Package name `@legioncodeinc/honeycomb` and subpaths `./react`, `./vercel`, `./openai`: `package.json:2`, `package.json:17`. `createHoneycombClient` is `src/sdk/client.ts:117`. `HoneycombClient` is an interface (`src/sdk/contracts.ts:201`), returned by the factory (`src/sdk/client.ts:396`). GET retries and mutations do not (`src/sdk/contracts.ts:115`). Errors are `ApiError`, `NetworkError`, `TimeoutError` (`src/sdk/contracts.ts:49`).
- MCP tool count 19 = 15 unconditional + 4 conditional codebase tools, five clusters `memory`, `browse`, `goals-kpis`, `codebase`, `secrets`: `mcp/src/tools.ts:77`, `mcp/src/contracts.ts:54`. `hivemind_read` and `hivemind_search` are cluster `memory`, presented as a prime-pull row. Prefixes `memory_`, `honeycomb_`, `hivemind_`, `secret_` match the specs.
- `memory_modify` requires `content` and `reason`; `memory_forget` requires `reason`: `mcp/src/tools.ts:90`. Daemon bodies match (`src/daemon/runtime/memories/api.ts:454`).
- `memory_list` has no `prefix`; `honeycomb_kpi_add` has no `goalId`: `mcp/src/tools.ts:84`, `mcp/src/tools.ts:127`.
- Removed session, agent, and `memory_feedback` tools; `inferParentSessionKey` remains: `mcp/src/sessions.ts:6`, `mcp/src/sessions.ts:36`. `ROUTE_GROUPS` has no `/api/sessions` or `/api/agents` (`src/daemon/runtime/server.ts:68`).
- Browse tools dial `/memory/grep`, `/memory/cat`, `/memory/ls`: `mcp/src/handlers.ts:272`. Goal and KPI tools map one string to `{ key, value }`: `mcp/src/handlers.ts:179`. `secret_exec` keeps `jobId`: `mcp/src/handlers.ts:118`.
- Seam stamps `x-honeycomb-runtime-path: plugin`, actor `honeycomb-mcp`, actor type `plugin`, and `mcp-<n>` on session-group paths: `mcp/src/daemon-seam.ts:37`, `mcp/src/daemon-seam.ts:83`.
- Schemas import `zod/v3`; app dependency is `zod` `^4.4.3`: `mcp/src/contracts.ts:28`, `package.json:135`.
- Production sentence "Production MCP is stdio, `node mcp/bundle/server.js`" and the daemon `/mcp` 501 scaffold: `mcp/src/index.ts:198`, `src/daemon/runtime/server.ts:104`, `src/daemon/runtime/server.ts:404`. esbuild emits `mcp/bundle/server.js` and `harnesses/claude-code/mcp/bundle/server.js` (`esbuild.config.mjs:303`).
- Supported set is Claude Code, Codex, Cursor. Hermes, pi, OpenClaw are `in-progress`: `src/daemon/runtime/dashboard/harness-registry.ts:147`, `src/cli/connector-runner.ts:62`.
- Connector base has the four seams, `_honeycomb` sentinel, `writeJsonIfChanged`, `isHoneycombEntry`: `src/connectors/contracts.ts:52`, `src/connectors/contracts.ts:251`. Cursor config root `~/.cursor` and flat `hooks.json`: `src/connectors/cursor.ts:101`, `src/connectors/cursor.ts:134`. Codex nested `~/.codex/hooks.json`: `src/connectors/codex.ts:66`. Claude Code install registers the marketplace plugin via `claude plugin`: `src/connectors/claude-code.ts:151`.
- Claude Code plugin files exist: `harnesses/claude-code/.mcp.json`, `harnesses/claude-code/skills/honeycomb-memory/SKILL.md`, `harnesses/claude-code/commands/recall.md`, `remember.md`, `forget.md`. `scripts/pack-check.mjs:25` requires those paths. SessionStart timeout is 30 in `harnesses/claude-code/hooks/hooks.json:10` and `src/connectors/claude-code.ts:97`.
- Claude Code, Codex, and Cursor event maps, runtime paths, and context channels in the hook table match the shims, except the Cursor and Hermes pre-tool cells in D-13 and D-14. Shim host-CLI constants match the summary-host column. See D-24 for the daemon worker matrix.
- Claude Code pre-tool block-and-inject (`permissionDecision: "deny"` plus `hookSpecificOutput.additionalContext`): `src/hooks/claude-code/shim.ts:199`. Conformance schema exists at `references/claude-code/pretool-response-schema.ts`.
- Credential reader prefers `~/.deeplake/credentials.json` and falls back to `~/.honeycomb/credentials.json`: `src/hooks/shared/credential-reader.ts:16`.
- Prompt-recall dedupe modes `0o700` / `0o600`: `src/hooks/shared/user-prompt-recall.ts:81`.
- Shared hook modules named in the file table exist under `src/hooks/shared/`.

## Page actions

- REVISE `mcp-and-sdk.md`. Keep the stdio production sentence, the 19-tool table, the C-2 removal note, the header stamps, and the SDK factory path. Replace the dual-live-transport paragraph, the graph-build codebase claim, connect-time MCP registration, the OpenClaw command surface, the sample, the diagnostics word, and "memory_get by path".
- REVISE `harness-integration.md`. Keep the three-harness support matrix, the connector seams, the Claude Code marketplace and pack-check notes, and W-1. Replace MCP-via-install, the Codex context-block sentence, W-2, the identity-sync paragraph, and the `references/openclaw/` example.
- REVISE `hook-lifecycle.md`. Keep the Claude Code event row, the shim host-CLI constants as shim constants, the credential path, the auto-pull kill switches, and the Claude Code pre-tool response shape. Replace the Cursor and Hermes pre-tool cells, the "functionally complete" sentence, the no-op session-start steps, the empty rules/goals handler, the assets tenancy sentence, the prompt-recall scope, the VFS function names, the stop-counter sentence, and the session-end worker paragraph.
- ADD: none.
- REMOVE: none.
- LEAVE: the hold list above, as claims inside the three pages.

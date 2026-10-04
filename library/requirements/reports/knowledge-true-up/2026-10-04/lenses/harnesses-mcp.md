# Lens: harnesses-mcp

Date: 2026-10-04. Repository: `/home/marioaldayuz/Desktop/development/active/honeycomb`. Read-only. No install, no build.

HEAD is `main` at `c1cb6bf5674ca169728e79433bf035e0d3d1483c`, tracking `origin/main` at the same commit (`feat(cli): standardize Honeycomb service interface (#316)`). `node_modules` is absent, so typecheck, vitest, and esbuild were not run. Built outputs under `**/bundle/`, `/sdk/`, and `/harnesses/openclaw/dist/` are gitignored and absent in this tree.

## Answer

Three harnesses are install-wired on main: Claude Code, Codex, and Cursor. Hermes, pi, and OpenClaw have source trees and hook shims, and they are not in `createConnectorRegistry`. That matches `overview.md` and `harness-integration.md` ("in progress"). It does not match a reading of `hook-lifecycle.md` as a live event matrix for all six.

Hermes scaffolding is already on main (since `b26686239efdbb34698db961797bd6792cb72924`, 2026-06-18, PRD-019). The production Hermes Agent adapter is not. [PR 322](https://github.com/legioncodeinc/honeycomb/pull/322) is OPEN on `feat/hermes-harness` and [issue 319](https://github.com/legioncodeinc/honeycomb/issues/319) is OPEN. Neither is merged into `c1cb6bf`.

## Per-harness presence

Hook events below are the native names in each `src/hooks/<harness>/shim.ts` event map. "Hook binary" means `harnesses/<name>/src/index.ts` calls `runHookBinary` / `maybeRunHookBinaryMain`. "Bundle dir" means a built `harnesses/<name>/bundle` or `harnesses/openclaw/dist` exists in this working tree. esbuild would emit those on `npm run build` (`esbuild.config.mjs` `HOOK_HARNESSES` and the OpenClaw target). They are not committed.

| Harness | `src/` | Other tree files | Bundle dir now | Hook binary | Connector in registry | Shim native events |
|---|---|---|---|---|---|---|
| claude-code | yes | `hooks/hooks.json`, `.mcp.json`, `.claude-plugin/`, `skills/`, `commands/`, `src/hygiene.ts` | absent (gitignored) | yes | yes | `SessionStart`, `UserPromptSubmit` (capture map and a recall-only map), `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `SessionEnd` |
| codex | yes | `package.json` | absent | yes | yes | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` |
| cursor | yes | `extension/` (`index.ts`, `extension.ts`, `bindings.ts`, `render.ts`, `contracts.ts`) | absent | yes | yes | `sessionStart`, `beforeSubmitPrompt`, `postToolUse`, `afterAgentResponse`, `stop`, `sessionEnd` |
| hermes | yes | `.mcp.json` only besides `src/index.ts` | absent | no (`activate` calls `bootHarness` only) | no | `on_session_start`, `on_user_message`, `on_tool_use`, `on_session_end` |
| openclaw | yes | `openclaw.plugin.json`, `package.json`, `openclaw.example.json`, `skills/SKILL.md` | `dist/` absent (gitignored) | no (`register` applies tuning, then `bootHarness`) | no | `before_agent_start`, `before_prompt_build`, `agent_end` |
| pi | yes | `src/index.ts` only | absent | no (`activate` calls `bootHarness` only) | no | `agent_end`, `session_shutdown` |

`src/cli/connector-runner.ts` `known()` builders: `claude-code`, `codex`, `cursor`. No `src/connectors/hermes.ts`, `pi.ts`, or `openclaw.ts`.

Shipped plugin hook keys in `harnesses/claude-code/hooks/hooks.json` (the marketplace path): `SessionStart`, `UserPromptSubmit` (sync `--honeycomb-recall` plus async capture), `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `SessionEnd`.

Cursor connector `CURSOR_EVENT_MAP` (`src/connectors/cursor.ts`) also registers `beforeShellExecution` for `pre-tool-use`. That name is not in the cursor shim map. See finding 4.

## MCP tool names

Defined in `mcp/src/tools.ts` `TOOL_SPECS` (19). Handlers in `mcp/src/handlers.ts`. Registered by `registerHoneycombSurface` in `mcp/src/registry.ts`. The four `codebase` tools are skipped unless `graphBuilt` is true.

Unconditional (15):

- memory: `memory_search`, `memory_store`, `memory_get`, `memory_list`, `memory_modify`, `memory_forget`
- same `memory` cluster, documented as prime pull: `hivemind_read`, `hivemind_search`
- browse: `honeycomb_search`, `honeycomb_read`, `honeycomb_index`
- goals-kpis: `honeycomb_goal_add`, `honeycomb_kpi_add`
- secrets: `secret_list`, `secret_exec`

Conditional codebase (4): `honeycomb_code_search`, `honeycomb_code_context`, `honeycomb_code_blast`, `honeycomb_code_impact`.

`TOOL_CLUSTERS` in `mcp/src/contracts.ts` is `memory`, `browse`, `goals-kpis`, `codebase`, `secrets`. There is no `sessions` or `agent` tool. `mcp/src/sessions.ts` remains a helper, not a registered tool.

stdio entry: `mcp/src/index.ts` `isMainEntry` calls `startMcpServer()` with default `serveHttp` false. esbuild target: `mcp/bundle/server.js` and `harnesses/claude-code/mcp/bundle` (`MCP_SERVER_OUTDIRS`). Both bundle dirs are absent here.

Claude Code MCP registration args: `${CLAUDE_PLUGIN_ROOT}/mcp/bundle/server.js` (`harnesses/claude-code/.mcp.json`). Hermes scaffold args: `mcp/bundle/server.js` (`harnesses/hermes/.mcp.json`).

## SDK export paths

`package.json` name `@legioncodeinc/honeycomb`, version `0.22.0`. `exports`:

| Subpath | Published path | Source |
|---|---|---|
| `.` | `./sdk/index.js` | `src/sdk/index.ts` (re-exports `src/sdk/client.ts`, `src/sdk/contracts.ts`) |
| `./react` | `./sdk/react.js` | `src/sdk/react.ts` |
| `./vercel` | `./sdk/vercel.js` | `src/sdk/vercel.ts` |
| `./openai` | `./sdk/openai.js` | `src/sdk/openai.ts` |

esbuild writes those four files to `sdk/` (`esbuild.config.mjs` `SDK_ENTRIES`). `/sdk/` is gitignored. The directory is absent in this tree. Whether a published npm tarball contains them was not checked (no pack, no install).

Public construction is `createHoneycombClient` (`src/sdk/client.ts`). `HoneycombClient` is an interface in `src/sdk/contracts.ts`, not a constructable class. Framework helpers: `useRecall` / `useRemember`, `createVercelAiTools`, `createOpenAiTools` (`OPENAI_TOOL_RECALL` = `honeycomb_recall`, `OPENAI_TOOL_REMEMBER` = `honeycomb_remember`). The barrel does not re-export the framework helpers.

## Doc comparison

Sources: `library/knowledge/private/overview.md` (line 25), `library/knowledge/private/integrations/harness-integration.md` (lines 5, 20, 80-87), `library/knowledge/private/integrations/hook-lifecycle.md` (event table lines 30-37, channel table 43-50), `library/knowledge/private/integrations/mcp-and-sdk.md`.

| Claim | Grade | Note |
|---|---|---|
| Three production harnesses: Claude Code, Cursor, Codex. Hermes, pi, OpenClaw in progress. | HOLDS | Matches `createConnectorRegistry` and the three `runHookBinary` entries. |
| Hook maps live in `src/hooks/<harness>/shim.ts`. | HOLDS | All six files exist. |
| Channel, runtime path, and host CLI table. | HOLDS | Constants in each shim match the table (`legacy` vs `plugin`, host bins). |
| Hermes native events are `on_session_start`, `on_user_message`, `on_tool_use`, `on_session_end`, with pre-tool intercept on terminal `on_tool_use`. | STALE | Those four names are the scaffold map. `on_tool_use` maps to `tool_call` only, and non-terminal tools are dropped. No `pre-tool-use`. Issue 319 and PR 322 say Hermes Agent 0.19 uses different events. |
| Cursor pre-tool intercept is `beforeShellExecution`. | STALE vs shim | Connector registers it. Shim drops unknown names (`normalize.ts`). |
| MCP registers 19 tools, 15 unconditional plus 4 conditional codebase. | HOLDS | Names match `TOOL_SPECS`. |
| Daemon serves streamable HTTP at `/mcp`. | FALSE | Prefix is listed for auth in `src/daemon/runtime/server.ts`. No daemon module calls `startMcpServer`. Bundle start is stdio only. |
| SDK sample imports `HoneycombClient` from `@honeycomb/sdk` and constructs it with `new`. | FALSE | Package subpaths above. Factory is `createHoneycombClient`. |
| OpenClaw extension registers the memory and browse tools as agent commands. | FALSE | `harnesses/openclaw/src/index.ts` does not register tools or call `createOpenClawShim`. |
| Hermes, pi, and OpenClaw are "not wired as a production connector path yet". | HOLDS | Folders and shims exist. That sentence is still accurate. |
| `hook-lifecycle.md` reads as if all six harnesses fire those events in production. | OVERCLAIMED | Only Claude Code, Codex, and Cursor binaries dispatch a shim. |

## Findings

### harnesses-mcp-1. Production set is three connectors, not six live harnesses

- Status: VERIFIED
- Severity: high
- Category: knowledge drift
- Claim: `overview.md` line 25 and `harness-integration.md` lines 5 and 20 are right that Claude Code, Codex, and Cursor are the wired set, and Hermes, pi, and OpenClaw are in progress. "In progress" means source and shims exist and install wiring does not. `package.json` description still says thin clients for six coding harnesses, and `files` ships `harnesses/hermes/bundle`, `harnesses/pi/bundle`, and `harnesses/openclaw/dist` once a build runs.
- Evidence: `src/cli/connector-runner.ts` lines 62-72. Hook binaries: `harnesses/claude-code/src/index.ts`, `harnesses/codex/src/index.ts`, `harnesses/cursor/src/index.ts`. Hermes and pi entries only call `bootHarness`. `package.json` `files` lines 31-45.
- Impact: A reader of the lifecycle doc will treat scaffold event names as installed behavior. A pack of the repo will include built Hermes, pi, and OpenClaw artifacts without a `honeycomb connect` path.
- Recommended action: Keep the three-versus-three status sentence. State that shims exist for all six and that only the registry harnesses are installed by `honeycomb setup` / `connect`.
- Owner: either. Confidence: 0.95.

### harnesses-mcp-2. Hermes code on main is the 019 scaffold. PR 322 is not merged

- Status: VERIFIED for tree contents. REPORTED for PR 322 test claims. UNVERIFIABLE-HERE for PR check runs.
- Severity: high
- Category: delivery
- Claim: Hermes files are on `main` at `c1cb6bf`. They are not the production adapter described by open issue 319 and open PR 322. PR 322 (`feat/hermes-harness`, state OPEN, `mergeable` MERGEABLE, updated 2026-07-22, base `main`) adds `src/connectors/hermes.ts`, rewrites `src/hooks/hermes/shim.ts`, and updates the knowledge docs. Those PR files are not in this tree. `pre_llm_call`, `post_tool_call`, `post_llm_call`, and `on_session_finalize` occur nowhere in the repo.
- Evidence: `git ls-tree -r HEAD` lists `harnesses/hermes/.mcp.json`, `harnesses/hermes/src/index.ts`, `src/hooks/hermes/shim.ts`. First touching commit `b26686239efdbb34698db961797bd6792cb72924`. `gh pr view 322` state OPEN. `gh issue view 319` state OPEN, title `feat: add production Hermes Agent harness adapter`. `rg` for the four PR event names: no matches.
- Impact: Docs and the scaffold describe a Hermes that issue 319 says will not install against Hermes Agent 0.19. Merging 322 is still required for `honeycomb connect hermes`. The PR is about three months older than current `main` (last update 2026-07-22 versus HEAD message for #316). Mergeability was reported by `gh` at audit time and was not re-tested with a merge.
- Recommended action: Do not mark Hermes production in the knowledge base until 322 lands. When it lands, replace the scaffold event row. Do not treat "Hermes exists on main" as "319 is done".
- Owner: either. Confidence: 0.93.

### harnesses-mcp-3. Hook-lifecycle Hermes row describes the scaffold, and the pre-tool cell is wrong

- Status: VERIFIED for the shim. REPORTED for "Hermes Agent 0.19 native names" (issue 319 and PR 322 body). UNVERIFIABLE-HERE against Hermes vendor source: `references/hermes/` does not exist on main (PR 322 adds `references/hermes/hooks-schema.ts`).
- Severity: high
- Category: knowledge drift
- Claim: `hook-lifecycle.md` maps Hermes pre-tool intercept and tool-call capture both to `on_tool_use` (terminal only), and assistant response to N/A. The shim maps `on_tool_use` only to logical `tool_call`. `hermesExtractData` returns `undefined` for non-terminal tools and `toolCallData` for terminal tools. It never emits `pre-tool-use`. `harnesses/hermes/src/index.ts` never loads `createHermesShim`, so those events are not dispatched by the Hermes bundle entry.
- Evidence: `src/hooks/hermes/shim.ts` lines 33-38 and 74-88. `HERMES_MCP_MENTION` matches the doc string for `honeycomb_search`, `honeycomb_read`, `honeycomb_index`. `harnesses/hermes/src/index.ts` lines 8-10.
- Impact: The lifecycle table overstates Hermes VFS intercept. The names may also be the wrong vendor events if 319 is right.
- Recommended action: Label the current row as scaffold. Point pre-tool to N/A until a binary maps a pre-tool logical event. After PR 322, replace the row with the events that PR adds, checked against `references/hermes/`.
- Owner: either. Confidence: 0.9.

### harnesses-mcp-4. Cursor connector registers `beforeShellExecution`. The shim drops it

- Status: VERIFIED
- Severity: high
- Category: code versus doc
- Claim: `hook-lifecycle.md` says Cursor pre-tool intercept is `beforeShellExecution` (Shell). `src/connectors/cursor.ts` registers that event and a `Shell` matcher, and its comment says the map mirrors `src/hooks/cursor/shim.ts`. The shim map has no `beforeShellExecution` and no `pre-tool-use`. `createShim` drops a native name that is absent from `eventMap` (`src/hooks/normalize.ts`). Shell VFS shaping exists only inside `cursorExtractData` on logical `tool_call`, which the map reaches via `postToolUse`, and that branch returns `preToolData` after the tool event rather than from the shell gate. The connector also does not register `afterAgentResponse`, which the shim does map. The doc lists `afterAgentResponse` / `stop`.
- Evidence: `src/connectors/cursor.ts` lines 59-70 and 149-158. `src/hooks/cursor/shim.ts` lines 36-43 and 82-95. `src/hooks/normalize.ts` lines 130-132. `harnesses/cursor/src/index.ts` uses `createCursorShim` for every event the binary receives.
- Impact: An installed Cursor `beforeShellExecution` hook runs the bundle and is dropped. The doc and the connector describe a pre-tool gate the shim does not implement. This is on a harness the docs call production.
- Recommended action: Add `beforeShellExecution` to `CURSOR_EVENT_MAP` as `pre-tool-use`, or stop registering that handler and correct the lifecycle table to `postToolUse` Shell. Align `afterAgentResponse` the same way.
- Owner: either. Confidence: 0.92.

### harnesses-mcp-5. pi and OpenClaw shims are not what the bundle entries run

- Status: VERIFIED
- Severity: medium
- Category: knowledge drift
- Claim: `hook-lifecycle.md` lists live OpenClaw events `before_agent_start`, `before_prompt_build`, and `agent_end`, and pi session start as a static `AGENTS.md` block with batched prompt capture. Those maps exist on the shims. `harnesses/openclaw/src/index.ts` `register` does not call `createOpenClawShim` or `runHookBinary`. `harnesses/pi/src/index.ts` only calls `bootHarness("pi")`. The pi shim comment says the extension entry is `harnesses/pi/extension-source/honeycomb.ts`. That path is not in the tree (`harnesses/pi` contains only `src/index.ts`). `references/pi/` and `references/openclaw/` are absent. `references/README.md` documents only Claude Code and Cursor schemas, while `references/codex/hooks-schema.ts` does exist.
- Evidence: `src/hooks/pi/shim.ts` lines 15-31. `src/hooks/openclaw/shim.ts` lines 46-50. OpenClaw `register` at `harnesses/openclaw/src/index.ts` lines 64-67. Glob of `harnesses/pi` and `references/`.
- Impact: The lifecycle table describes behavior the packaged entry points do not execute. pi's on-demand extension file is missing, so the static `AGENTS.md` path is a shim helper with no harness entry.
- Recommended action: Mark pi and OpenClaw rows as shim-only until an entry point dispatches them. Remove or restore the cited `extension-source` path. Add the codex schema to `references/README.md` when that file is touched.
- Owner: either. Confidence: 0.9.

### harnesses-mcp-6. SDK doc import path and constructor do not match the package

- Status: VERIFIED for source and `package.json`. UNVERIFIABLE-HERE for the built `sdk/*.js` bytes (directory absent, build not run).
- Severity: medium
- Category: knowledge drift
- Claim: `mcp-and-sdk.md` tells callers to import `HoneycombClient` from `@honeycomb/sdk` and construct it with `new`. The published package is `@legioncodeinc/honeycomb` with exports `.`, `./react`, `./vercel`, `./openai`. `HoneycombClient` is a type. The value export is `createHoneycombClient`.
- Evidence: `package.json` lines 16-22. `src/sdk/index.ts` lines 10-37. `src/sdk/client.ts` `createHoneycombClient`. `src/sdk/contracts.ts` interface `HoneycombClient` around line 201. `mcp-and-sdk.md` lines 65-76.
- Impact: The sample does not typecheck against this package.
- Recommended action: Replace the sample with `createHoneycombClient` from `@legioncodeinc/honeycomb`, and name the three subpath entry points.
- Owner: either. Confidence: 0.96.

### harnesses-mcp-7. Daemon `/mcp` is an auth prefix, not a mounted MCP server

- Status: VERIFIED by source search. UNVERIFIABLE-HERE for a live handshake (no `mcp/bundle/server.js`, no dependencies).
- Severity: medium
- Category: knowledge drift
- Claim: `mcp-and-sdk.md` says the server binds stdio and a streamable HTTP transport at `/mcp` on loopback, and that the daemon serves that HTTP transport. `startMcpServer` can serve HTTP only when `serveHttp` is true (covered by `tests/mcp/start-server.test.ts`). The process entry calls `startMcpServer()` with defaults, which leaves `serveHttp` false. `src/daemon` does not import `startMcpServer` or `createMcpServer`. `server.ts` includes `{ path: "/mcp", protect: true, session: true }` and `rbac.ts` lists `/mcp` write. No `mount*` function in `src/daemon/runtime` attaches an MCP handler.
- Evidence: `mcp/src/index.ts` lines 106-116 and 195-203. `src/daemon/runtime/server.ts` line 104. Search of `src/daemon` for `startMcpServer`: no matches.
- Impact: Clients that POST to daemon port 3850 `/mcp` are not reaching the MCP server described in the doc. Harness MCP is the stdio bundle path in `.mcp.json`.
- Recommended action: Say stdio `node mcp/bundle/server.js` is the harness path. Say HTTP `/mcp` is optional on `startMcpServer({ serveHttp: true })` and is not mounted by the daemon assembly in this tree.
- Owner: either. Confidence: 0.9.

### harnesses-mcp-8. OpenClaw section overclaims tool registration

- Status: VERIFIED
- Severity: medium
- Category: knowledge drift
- Claim: `mcp-and-sdk.md` "OpenClaw extension surface" says the extension registers the same memory and browse tools plus goal and KPI tools as agent-callable commands, batches capture at `agent_end`, and supplements memory on `before_agent_start`. The plugin manifest lists skills, `autoCapture` / `autoRecall` hints, and a tuning schema. The entry `register` copies tuning onto `globalThis.__honeycomb_tuning__` and calls `bootHarness`. Batch capture lives on `createOpenClawShim`, which this entry does not call. No connector registers MCP during an OpenClaw connect step, because OpenClaw is not in the registry.
- Evidence: `harnesses/openclaw/openclaw.plugin.json`. `harnesses/openclaw/package.json` `openclaw.extensions` points at `./dist/index.js`. `harnesses/openclaw/src/index.ts` lines 50-67. `mcp-and-sdk.md` lines 60-62.
- Impact: The OpenClaw paragraph describes a connect-time tool surface that the entry does not implement.
- Recommended action: Reduce that section to tuning dispatch plus the unused shim, or implement registration and then restore the claim.
- Owner: either. Confidence: 0.88.

### harnesses-mcp-9. Reconcile default is Claude Code only. The runner comment undercounts connectors

- Status: VERIFIED
- Severity: medium
- Category: code comment and doc drift
- Claim: `harness-integration.md` says `honeycomb setup` wires every detected connector, and that self-heal reconcile wires any detected harness whose plugin is not enabled. `createConnectorRegistry` does build three connectors, so setup can target Claude Code, Codex, and Cursor. `DEFAULT_RECONCILE_HARNESSES` is `["claude-code"]` with a comment that Codex and Cursor slot in later. The same file's comment says "the two supported hook-protocol connectors" while the object has three keys.
- Evidence: `src/cli/connector-runner.ts` lines 51-72. `src/cli/harness-reconcile.ts` lines 106-107. `harness-integration.md` lines 69-74 and 111-113.
- Impact: Steady-state reconcile does not repair Codex or Cursor unless a caller overrides `harnesses`. The doc's "any detected harness" sentence is wider than the default list.
- Recommended action: Say setup uses the three-key registry and the default reconcile list is Claude Code only, until the constant changes.
- Owner: either. Confidence: 0.9.

### harnesses-mcp-10. MCP 19-tool inventory matches the doc, with a cluster label mismatch

- Status: VERIFIED
- Severity: low
- Category: knowledge drift
- Claim: The 19 names, the reason requirement on `memory_modify` and `memory_forget`, the removal of `session_*`, `agent_*`, and `memory_feedback`, and the conditional codebase gate all match `mcp-and-sdk.md`. The doc prints a "Prime pull" column for `hivemind_read` and `hivemind_search`. In `TOOL_SPECS` both use `cluster: "memory"`, not a sixth cluster. `memory_modify` schema requires `path`, `content`, and `reason`, matching the doc.
- Evidence: `mcp/src/tools.ts` lines 77-137. `mcp/src/registry.ts` lines 166-177. `mcp/src/contracts.ts` line 54.
- Impact: Low. Tool names are correct. A reader looking for a `prime` cluster in code will not find one.
- Recommended action: Note that prime-pull tools are registered in the `memory` cluster.
- Owner: either. Confidence: 0.97.

### harnesses-mcp-11. Claude Code plugin hook file matches the reference shim. The connector fallback map is narrower

- Status: VERIFIED
- Severity: low
- Category: inventory
- Claim: `harnesses/claude-code/hooks/hooks.json` registers the seven native events in `CLAUDE_CODE_EVENT_MAP`, including `SubagentStop`, and a second `UserPromptSubmit` command with `--honeycomb-recall`, matching `CLAUDE_CODE_RECALL_EVENT_MAP`. `src/connectors/claude-code.ts` `CLAUDE_EVENT_MAP` has no `SubagentStop` and one `user_message` handler (`capture.js`). That map is the settings.json fallback when marketplace registration is not used. The doc's Claude Code column matches the plugin file, which is the primary path described in `harness-integration.md`.
- Evidence: `harnesses/claude-code/hooks/hooks.json`. `src/hooks/claude-code/shim.ts` lines 47-67. `src/connectors/claude-code.ts` lines 86-102.
- Impact: Fallback installs omit `SubagentStop` and the sync recall injector. Marketplace installs include both.
- Recommended action: One sentence in the lifecycle doc: the plugin `hooks.json` is the full map. The connector fallback map omits `SubagentStop` and the recall argv.
- Owner: either. Confidence: 0.9.

### harnesses-mcp-12. Built bundles and `sdk/` are not in the working tree

- Status: VERIFIED absent on disk. UNVERIFIABLE-HERE that `npm run build` succeeds (no `node_modules`, install forbidden for this lens).
- Severity: info
- Category: inventory
- Claim: Every harness has `src/`. None has a bundle directory now. `mcp/bundle`, `harnesses/claude-code/mcp/bundle`, `harnesses/openclaw/dist`, and `/sdk/` are absent. `.gitignore` excludes `**/bundle/`, `/sdk/`, `/harnesses/openclaw/dist/`, and `/harnesses/claude-code/mcp/bundle/`. esbuild is the producer (`esbuild.config.mjs` lines 167-187, 253, 301-303, 334-348).
- Evidence: `ls` of those paths failed. `.gitignore` lines 98-111.
- Impact: A checkout is not a runnable harness install until build. Docs that cite `mcp/bundle/server.js` and `harnesses/<name>/bundle` are describing pack outputs, not files in git.
- Recommended action: Keep those paths labeled as build outputs.
- Owner: either. Confidence: 0.95.

## Could not verify

- Live MCP `initialize` handshake and daemon port 3850 `/mcp` behavior. No bundle and no installed dependencies.
- Whether the published npm tarball contains `sdk/*.js` and harness bundles.
- GitHub check status on PR 322. `gh pr view` reported OPEN and MERGEABLE. The PR body reports local tests. Those results were not re-run.
- Hermes Agent 0.19's real event names. No `references/hermes/` on main. The contradicting names are from issue 319 and PR 322 text.
- `npm run smoke:golden-path` and the "production ready and live-tested" clause in `overview.md` line 25. Out of scope for this tree without credentials and a build.

## Refuted findings

None. No prior lens findings were supplied to refute.

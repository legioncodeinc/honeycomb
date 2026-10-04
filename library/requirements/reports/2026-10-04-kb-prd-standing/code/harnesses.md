# Harnesses and hooks code standing

- Date: 2026-10-04
- Wave: 2 code standing
- Inputs: `knowledge/integrations.md` (harness and hook claims), `prds/in-work-019.md`, `prds/in-work-020.md` (020c only)
- Walked: `harnesses/*/src` (not `bundle/`), `src/connectors/`, `src/hooks/`, plus `harnesses/cursor/extension/` for 020c and the cited lines those reports use as proof
- Skipped: `node_modules`, `harnesses/*/bundle/`, other build output
- Out of this shard (no verdict): integrations D-01, D-02, D-05, D-06, D-07, and PRD-020 surfaces other than 020c

ASCII hyphens only.

## Counts

- CONFIRM: 55
- OVERTURN: 2
- UNVERIFIABLE: 7

A folder stays in `in-work/` when a still-required criterion is absent in source. Both PRD-019 and PRD-020 stay in `in-work/`.

## Knowledge edits

Page actions for `harness-integration.md` and `hook-lifecycle.md` follow the defect verdicts below. Apply a REVISE only where the defect is CONFIRM. D-01, D-02, D-05, D-06, and D-07 are MCP and SDK claims and were not re-walked here.

### D-03 - CONFIRM

- Recommended action: REVISE `library/knowledge/private/integrations/mcp-and-sdk.md` (connect-time MCP registration).
- `src/connectors/` has no MCP registration write (search of `src/connectors` for `mcp` is empty).
- Registry slugs are `claude-code`, `codex`, and `cursor` at `src/cli/connector-runner.ts:62-72`. That registry builds connectors. It does not write an MCP server entry.
- Claude Code ships a static plugin file at `harnesses/claude-code/.mcp.json:4-6` (`${CLAUDE_PLUGIN_ROOT}/mcp/bundle/server.js`). Hermes has a static `harnesses/hermes/.mcp.json:5`. There is no `.mcp.json` under `harnesses/codex` or `harnesses/cursor`.
- The connect step does not register MCP. The Claude Code file is plugin packaging.

### D-04 - CONFIRM

- Recommended action: REVISE the OpenClaw tool, batch, and connect claims in `mcp-and-sdk.md`. Keep the tuning sentence.
- `harnesses/openclaw/src/index.ts:64-66` `register` applies tuning and calls `bootHarness("openclaw")`. No tool registration and no connector slug.
- `src/hooks/openclaw/shim.ts:184-185` maps live `agent_end` to session-end data. `openclawExpandBatch` at `src/hooks/openclaw/shim.ts:113` is not called from `createOpenClawShim` (`src/hooks/openclaw/shim.ts:192-205`). Callers outside the shim are tests.
- Tuning sentence holds: `harnesses/openclaw/src/index.ts:50-57` writes `globalThis.__honeycomb_tuning__`.

### D-08 - CONFIRM

- Recommended action: REVISE the Codex context-block sentence in `harness-integration.md`. Channel names can stay.
- Channels match the quoted split: Claude Code `model-only` (`src/hooks/claude-code/shim.ts:91`), Cursor `model-only` (`src/hooks/cursor/shim.ts:45`), OpenClaw `model-only` (`src/hooks/openclaw/shim.ts:52`), Codex `user-visible` (`src/hooks/codex/shim.ts:44`), Hermes `user-visible` (`src/hooks/hermes/shim.ts:40`), pi `user-visible` (`src/hooks/pi/shim.ts:33`).
- Codex does not render the assembled block. `codexRenderUserVisible` at `src/hooks/codex/shim.ts:77-78` returns the signed-in login line from `:70` or the read-only login hint. `renderChannel` uses that helper for `user-visible` (`src/hooks/normalize.ts:196-198`).

### D-09 - CONFIRM

- Recommended action: REVISE MCP-via-install in `harness-integration.md`. Keep the Hermes MCP mention string.
- Same proof as D-03. `src/connectors/` does not write MCP. Claude Code and Hermes `.mcp.json` files are static. Codex and Cursor have none.
- Hermes mention holds: `src/hooks/hermes/shim.ts:46-47`.

### D-10 - CONFIRM

- Recommended action: REVISE the W-2 `pluginEnabled` paragraph in `harness-integration.md`. Keep the W-1 reconcile sentence.
- The composition root constructs `createHarnessPluginStatusHolder` at `src/daemon/runtime/assemble.ts:3596` and passes it into assembly at `:3675`. The harness mount reads it through `resolvePluginEnabled` at `src/daemon/runtime/assemble.ts:1874-1875`.
- The set is empty until the first push (`src/daemon/runtime/dashboard/harness-plugin-status.ts:27` comment, holder at `:47`). After reconcile, the CLI posts `pluginEnabled` at `src/cli/runtime.ts:714-718` to `POST /api/diagnostics/harness-status` (`src/daemon/runtime/dashboard/harness-status-ingest.ts:22`).
- The doc sentence that production `pluginEnabled` is false because the resolver is not injected is stale. The resolver is injected. The field is false only until the first successful push.
- W-1 holds: reconcile starts from `src/cli/runtime.ts:756` via `onDaemonUp`.

### D-11 - CONFIRM

- Recommended action: REVISE the identity-sync paragraph in `harness-integration.md`.
- `src/daemon/runtime/assemble.ts:3322` passes `harnessTargets: options.harnessTargets ?? []`. No production caller supplies a non-empty list (the other `harnessTargets:` sites are tests and the file-watcher example).
- The sync helper can stamp a do-not-edit header when a target is injected (`src/daemon/runtime/services/harness-sync.ts:28-36`). Canonical names include `AGENTS.md` plus five siblings (`src/daemon/runtime/services/harness-sync.ts:69-76`).
- `~/.claude/CLAUDE.md` appears as a comment example at `src/daemon/runtime/services/file-watcher.ts:161-163`.
- No `POST /api/harnesses/regenerate` under `src/`.

### D-12 - CONFIRM

- Recommended action: REVISE the `references/openclaw/` example in `harness-integration.md`. Keep the Cursor schema clause.
- On disk, `references/` has `claude-code/`, `codex/`, and `cursor/`. `references/openclaw/`, `references/hermes/`, and `references/pi/` are absent.
- `references/README.md:16-19` describes zod oracles for hook JSON, not sibling harness repos.
- The Cursor clause holds: `src/connectors/cursor.ts:21` cites `references/cursor/hooks-schema.ts`, and that file exists.

### D-13 - CONFIRM

- Recommended action: REVISE the Cursor pre-tool cell in `hook-lifecycle.md`.
- `src/hooks/cursor/shim.ts:36-43` `CURSOR_EVENT_MAP` has no `beforeShellExecution`. `postToolUse` maps to `tool_call`.
- `src/connectors/cursor.ts:66` registers logical `pre-tool-use` as native `beforeShellExecution`. The handler file is `pre-tool-use.js` (`src/connectors/cursor.ts:76`), which esbuild aliases from the same cursor entry (`esbuild.config.mjs:181-184`). The binary uses `createCursorShim()` (`harnesses/cursor/src/index.ts:47`).
- Unknown native names are dropped (`src/hooks/normalize.ts:131-132`). VFS runs only for logical `pre-tool-use` (`src/hooks/runtime.ts:377`).
- `Shell` on logical `tool_call` returns `preToolData` (`src/hooks/cursor/shim.ts:88-93`) and the event stays `tool_call` (`src/hooks/normalize.ts:139-140`), so dispatch captures it (`src/hooks/runtime.ts:394-397`) and does not call `runPreToolUse`.

### D-14 - CONFIRM

- Recommended action: REVISE the Hermes pre-tool cell in `hook-lifecycle.md`. Terminal-only tool-call capture can stay.
- `src/hooks/hermes/shim.ts:33-37` maps `on_tool_use` to `tool_call`. There is no `pre-tool-use` entry.
- Non-terminal tools return `undefined` and are dropped (`src/hooks/hermes/shim.ts:80-83`, `src/hooks/normalize.ts:136`). Terminal tools become `toolCallData`, not a VFS intercept.
- `harnesses/hermes/src/index.ts:8-9` only calls `bootHarness("hermes")`.

### D-15 - CONFIRM

- Recommended action: REVISE the "functionally complete" sentence in `hook-lifecycle.md`. In-progress status can stay.
- Live `agent_end` returns session-end data (`src/hooks/openclaw/shim.ts:184-185`). `createOpenClawShim` does not call `openclawExpandBatch`.
- `harnesses/pi/src/index.ts:8-9` only calls `bootHarness("pi")`. `harnesses/pi/extension-source/honeycomb.ts` is absent. `harnesses/pi/` contains `src/index.ts` only.
- In-progress status holds at `src/daemon/runtime/dashboard/harness-registry.ts:137-147` (`SUPPORTED_HARNESSES` is `claude-code`, `codex`, `cursor`).
- The daemon registry constructs the Hermes, pi, and OpenClaw shims for capability metadata (`src/daemon/runtime/dashboard/harness-registry.ts:60-62`). That construction is not a hook binary.

### D-16 - CONFIRM

- Recommended action: REVISE the numbered heal, update, table-ensure, placeholder, and graph-pull steps in `hook-lifecycle.md`. Keep credential load, context render, prime render, the recall-awareness notice, and the skills and assets pulls.
- `runSessionStart` calls those seams (`src/hooks/shared/session-start.ts:188-200` and `:274`).
- Production factory leaves them empty: `src/hooks/shared/session-start-seams.ts:123-127`. Runtime uses that factory (`src/hooks/runtime.ts:279`).
- Claude Code spawns a hygiene child (`src/hooks/claude-code/shim.ts:276-277`). The child runs skills, assets, and `spawnGraphPull` (`harnesses/claude-code/src/hygiene.ts:79-81`). `spawnGraphPull` is still the empty function. Heal, `autoUpdate`, `ensureTables`, and `writePlaceholderSummary` are not what the child runs.
- Recall notice is real: `src/hooks/shared/session-start.ts:69` and `:239`.

### D-17 - CONFIRM

- Recommended action: REVISE the rules and goals handler sentence in `hook-lifecycle.md`. Prime and the recall notice can stay.
- The hook POSTs `context` (`src/hooks/shared/context-renderer.ts:17-38`).
- Production `attachHooks` does not pass `contextHandler` (`src/daemon/runtime/assemble.ts:1373-1398`). The default handler returns `{ additionalContext: "" }` (`src/daemon/runtime/capture/attach.ts:216-217`).
- Prime still runs: `GET /api/memories/prime` at `src/hooks/shared/prime-renderer.ts:43`, called from `src/hooks/shared/session-start.ts:214-220`.

### D-18 - CONFIRM

- Recommended action: REVISE the assets tenancy sentence in `hook-lifecycle.md`. The skills pull and the kill-switch names can stay.
- Skills headers omit org when the credential has none (`src/hooks/shared/session-start-seams.ts:242-248`).
- Assets scope uses org `"local"` when the credential org is absent (`src/hooks/shared/session-start-seams.ts:197`).
- Skills budget is imported as `AUTOPULL_TIMEOUT_MS` (`src/hooks/shared/session-start-seams.ts:55`). Kill switches are `AUTOPULL_DISABLED_ENV` (`:135`) and `ASSET_AUTOPULL_DISABLED_ENV` (`:148`).

### D-19 - CONFIRM

- Recommended action: REVISE the prompt-recall scope in `hook-lifecycle.md`. The Claude Code double registration can stay.
- Claude Code recall mode maps only `UserPromptSubmit` to `user_prompt_recall` (`src/hooks/claude-code/shim.ts:65-66`). `harnesses/claude-code/hooks/hooks.json:15-33` registers that flag on one `UserPromptSubmit` entry and a capture entry beside it.
- Codex maps `UserPromptSubmit` to `user_message` (`src/hooks/codex/shim.ts:38`). Cursor maps `beforeSubmitPrompt` to `user_message` (`src/hooks/cursor/shim.ts:38`). Neither shim defines `user_prompt_recall`.

### D-20 - CONFIRM

- Recommended action: REVISE the `renderContext` sentence in `hook-lifecycle.md`.
- `renderContext` does not take the live event and does not choose the digest layout. It wraps the string it is given (`src/hooks/normalize.ts:154-156` and `:183-198`).
- Prompt text is built by `renderRecallBlock` (`src/hooks/shared/user-prompt-recall.ts:142-148`). Session-start text is `joinBlocks` of notice, context, prime, and the recall notice (`src/hooks/shared/session-start.ts:239`).
- The Claude Code recall shim sets `contextHookEvent: "UserPromptSubmit"` (`src/hooks/claude-code/shim.ts:265`), which changes the envelope, not the block layout.

### D-20 citation - OVERTURN

- Wave 1 grounding says `renderContext` is absent under `src/hooks/`. That citation is false.
- `renderContext` is defined at `src/hooks/normalize.ts:154`. The REVISE in D-20 still stands. Do not write that the function is missing.

### D-21 - CONFIRM

- Recommended action: REVISE the shared-recall-route sentence in `hook-lifecycle.md`. The `/memory/grep` degraded-lexical fact can stay on the VFS handler, not in this section.
- Prompt arm: `POST /api/memories/recall` (`src/hooks/shared/recall-renderer.ts:48`).
- Session-start arm: `GET /api/memories/prime` (`src/hooks/shared/prime-renderer.ts:43`).
- Pre-tool arm: `GET /memory/cat|grep|ls|find` (`src/hooks/runtime.ts:600-607`).
- Those arms do not share one daemon route. `fetchGrep` documents `degraded:true` when no embed client is injected (`src/daemon/runtime/vfs/api.ts:336-337`). That is the VFS browse path.

### D-22 - CONFIRM

- Recommended action: REVISE the named daemon functions in `hook-lifecycle.md`. Verb routing can stay.
- No `readVirtualPathContent` or `grep-direct` under `src/`.
- Hook resolve routes are `/memory/cat`, `/memory/grep`, `/memory/ls`, and `/memory/find` (`src/hooks/runtime.ts:600-607`).
- Verb routing holds in `src/hooks/shared/pre-tool-use.ts:87-94` and `lowerBashVerb` at `:286-297` (`cat`/`Read` to read, `grep`/`Glob` to search, Write/Edit deny, unmodelable echo).

### D-23 - CONFIRM

- Recommended action: REVISE the stop-counter sentence in `hook-lifecycle.md`.
- Capture body is `{ event, metadata }` (`src/hooks/shared/capture.ts:48-55`). `isTurnTerminating` does not appear under `src/hooks/`.
- The daemon field defaults to false (`src/daemon/runtime/capture/event-contract.ts:174`). `tryStopCounterTrigger` runs only when `meta.isTurnTerminating` (`src/daemon/runtime/capture/capture-handler.ts:827-829`). Nothing else in `src/daemon/runtime/capture` assigns that flag.

### D-24 - CONFIRM

- Recommended action: REVISE the session-end worker paragraph in `hook-lifecycle.md`. Shim host-CLI constants can stay as shim constants.
- The hook POSTs intents `mark-ended`, `record-usage`, and `skillify` (`src/hooks/shared/session-end.ts:105-114`) and then calls `spawn.spawn` (`:96`).
- Default spawn is empty (`src/hooks/runtime.ts:271` and `:474-476`). `runHookBinary` builds `createHookRuntime` without `summarySpawn` (`src/hooks/binary.ts:91`). The lock parameter defaults to `createFakeSummaryLock()` and `dispatchLifecycle` does not pass a lock (`src/hooks/shared/session-end.ts:78`, `src/hooks/runtime.ts:384`).
- The daemon default session-end handler acks those intents and enqueues a `summary` job (`src/daemon/runtime/capture/attach.ts:237-242` and `:274-284`). The comment there says the real mark, usage, and skillify body is still deferred. The worker shells `summaryCliSpecFor` (`src/daemon/runtime/summaries/job.ts:153-168`): codex is `codex exec -`, hermes is `hermes -p`, pi is `pi -p`, and unknown agents including `openclaw` fall through to `claude -p`.
- Shim constants differ from that matrix: `src/hooks/claude-code/shim.ts:97`, `src/hooks/codex/shim.ts:46-48`, `src/hooks/cursor/shim.ts:47`, `src/hooks/hermes/shim.ts:42`, `src/hooks/pi/shim.ts:36`, `src/hooks/openclaw/shim.ts:56`.
- Writer constraint: the hook spawn is a no-op, and the daemon still enqueues a summary job. Do not write that no summary job is queued.

### LEAVE harness and hook hold list - CONFIRM

- Recommended action: LEAVE these claims inside the three pages.
- Supported set Claude Code, Codex, Cursor. Hermes, pi, and OpenClaw are in-progress: `src/daemon/runtime/dashboard/harness-registry.ts:147` and `src/cli/connector-runner.ts:62-72`.
- Connector base seams, `_honeycomb` sentinel, `writeJsonIfChanged`, `isHoneycombEntry`: `src/connectors/contracts.ts:251-257`, `:295-304`, `:314-319`.
- Cursor config root `~/.cursor` and flat `hooks.json`: `src/connectors/cursor.ts:101-102` and `:173-188`.
- Codex nested `~/.codex/hooks.json`: `src/connectors/codex.ts:66-67`. Codex also overrides `configRoot` at `:96-98`.
- Claude Code install with a plugin runner calls `claude plugin` and returns `handlers: []` and `skillLinks: []`: `src/connectors/claude-code.ts:151-164`.
- Claude Code plugin files exist: `harnesses/claude-code/.mcp.json`, and SessionStart timeout 30 is `harnesses/claude-code/hooks/hooks.json:10` and `src/connectors/claude-code.ts:97`.
- Claude Code pre-tool block-and-inject: `permissionDecision: "deny"` plus `additionalContext` at `src/hooks/claude-code/shim.ts:199-203`. `references/claude-code/pretool-response-schema.ts` exists.
- Credential reader prefers `~/.deeplake/credentials.json` and falls back to `~/.honeycomb/credentials.json`: `src/hooks/shared/credential-reader.ts:16-19` and `:77-86`.
- Prompt-recall store modes `0o700` / `0o600`: `src/hooks/shared/user-prompt-recall.ts:81-82`.
- Shared hook modules named by the knowledge file exist under `src/hooks/shared/`.

## PRD-019 move

### Stay in in-work - CONFIRM

- Recommended action: leave `library/requirements/in-work/prd-019-harness-integrations/` in `in-work/`. Do not move it to `completed/`, `backlog/`, or `archive/`.
- Still-required criteria are absent (confirmed UNMET rows below): index AC-1, 019a AC-5, 019b AC-1, 019b AC-3, 019b AC-5, 019c AC-1 through AC-6, 019d AC-2, 019d AC-4, 019d AC-5.
- A connector base, three wired hook binaries, MCP tool registration, and an SDK client are already in the tree, so the folder is not backlog and not archive.

### Index banner correction - CONFIRM

- Recommended action: if a writer may edit the PRD, correct the banner at `library/requirements/in-work/prd-019-harness-integrations/prd-019-harness-integrations-index.md:14-15`.
- The registry includes Codex (`src/cli/connector-runner.ts:71`). The comment above it still says two connectors (`:52-54`). The banner's "only claude-code and cursor" line is false.
- Claude Code plugin packaging includes MCP (`harnesses/claude-code/.mcp.json:4-6`). The banner's "MCP-server-via-install is met for no harness" line is stale for Claude Code. `src/connectors/` still never writes MCP. Hermes `.mcp.json` has no connector that installs it.

### Index AC-1 - CONFIRM

- Wave 1: UNMET. That stands.
- Quote requires any supported harness to patch config, write hook handlers, link skills, and uninstall only Honeycomb changes.
- 019c names Claude Code, OpenClaw, Codex, Cursor, Hermes, pi, OpenCode, Gemini CLI, and Oh My Pi. Registry knows three slugs (`src/cli/connector-runner.ts:62-72`). Connectors on disk: `src/connectors/claude-code.ts`, `src/connectors/codex.ts`, `src/connectors/cursor.ts`.
- Codex and Cursor inherit `install()` (`src/connectors/contracts.ts:345-367`).
- Claude Code with a plugin runner returns `handlers: []` and `skillLinks: []` (`src/connectors/claude-code.ts:164`). Handler writes run on the fail-soft path (`:203-210`).
- Uninstall of Honeycomb entries is on the base (`src/connectors/contracts.ts:380-408`) and Claude Code also calls `super.uninstall()` (`src/connectors/claude-code.ts:178`). That does not cover the missing harnesses.

### Index AC-2 - CONFIRM

- Wave 1: MET. That stands.
- Claude Code, Codex, and Cursor binaries call `runHookBinary` with their shim: `harnesses/claude-code/src/index.ts:42-43`, `harnesses/codex/src/index.ts:36-37`, `harnesses/cursor/src/index.ts:46-47`.
- `shim.normalize` runs at `src/hooks/runtime.ts:292`. Capture posts `/api/hooks/capture` with `x-honeycomb-runtime-path` (`src/hooks/shared/daemon-client.ts:111-118`, `src/hooks/shared/capture.ts:147-154`).
- Hermes, pi, and OpenClaw entries do not call their shims (`harnesses/hermes/src/index.ts:8-9`, `harnesses/pi/src/index.ts:8-9`, `harnesses/openclaw/src/index.ts:64-66`). The criterion is existential for a harness whose shim runs. The three wired binaries do it.

### Index AC-3 - UNVERIFIABLE

- Wave 1: MET. This walk did not re-read every MCP handler body or `mcp/src/daemon-seam.ts`.
- Seen, and not contradicted: stdio auto-start at `mcp/src/index.ts:198-199`, tool specs in `mcp/src/tools.ts`, and the Claude Code plugin manifest at `harnesses/claude-code/.mcp.json:4-6`.
- Do not flip this criterion from this report. It is not a reason to leave `in-work/`.

### 019a AC-1 - CONFIRM

- Wave 1: MET. Foreign entries stay. `src/connectors/contracts.ts:295-304` and Cursor's flat merge `src/connectors/cursor.ts:173-183`.

### 019a AC-2 - CONFIRM

- Wave 1: MET. `src/connectors/contracts.ts:380-408` strips Honeycomb entries, unlinks an emptied config, removes handler files, and `unlinkSkills` at `:503-511` removes only Honeycomb skill links.

### 019a AC-3 - CONFIRM

- Wave 1: MET. `writeJsonIfChanged` returns false when the serialized text matches and does not call `writeFile` (`src/connectors/contracts.ts:314-319`).

### 019a AC-4 - CONFIRM

- Wave 1: MET. `setup` installs every detected registry slug (`src/connectors/cli.ts:76-107`). Detection is `configRoot` exists (`src/connectors/contracts.ts:328-331`).

### 019a AC-5 - CONFIRM

- Wave 1: UNMET. That stands. This is a still-required absence.
- The four abstract seams are `src/connectors/contracts.ts:251-257`.
- Codex overrides those four plus `configRoot` (`src/connectors/codex.ts:66-98`).
- Claude Code also overrides `install()` and `uninstall()` (`src/connectors/claude-code.ts:137` and `:172`).
- Cursor also overrides `toConfigEntry`, `patchConfig`, and `stripHoneycomb` (`src/connectors/cursor.ts:153`, `:173`, `:197`).
- The "only" clause is absent for the implemented set.

### 019a AC-6 - CONFIRM

- Wave 1: MET. Foreign symlink or real file is left in place (`src/connectors/contracts.ts:473-494`).

### 019b AC-1 - CONFIRM

- Wave 1: UNMET. That stands. This is a still-required absence.
- `runCaptureBatch` exists (`src/hooks/shared/capture.ts:132-144`). OpenClaw slice math exists (`src/hooks/openclaw/shim.ts:98-103`).
- `harnesses/openclaw/src/index.ts:64-66` never imports the shim. Live `agent_end` is session-end data (`src/hooks/openclaw/shim.ts:184-185`).
- pi's extension path named at `src/hooks/pi/shim.ts:17` is absent. `harnesses/pi/src/index.ts` only boots the client.
- Rows for those partial vocabularies are not written by the harness entries.

### 019b AC-2 - CONFIRM

- Wave 1: MET. Credentials at `src/hooks/shared/credential-reader.ts:77-86`, wired at `src/hooks/runtime.ts:232`. Normalize at `src/hooks/runtime.ts:292`. Loopback `/api/hooks` at `src/hooks/shared/daemon-client.ts:111-118`.
- No `daemon/storage` import under `src/hooks/`. Capture and pre-tool go through injected seams (`src/hooks/shared/capture.ts:69`, `src/hooks/shared/pre-tool-use.ts:13-16`).

### 019b AC-3 - CONFIRM

- Wave 1: UNMET. That stands. This is a still-required absence.
- `runSessionStart` calls ensure, placeholder, render, and return (`src/hooks/shared/session-start.ts:193-205` and `:277`).
- Production `ensureTables` and `writePlaceholderSummary` are empty (`src/hooks/shared/session-start-seams.ts:125-126`), and runtime uses that factory (`src/hooks/runtime.ts:279`).
- `additionalContext` is returned when any block is non-empty (`src/hooks/shared/session-start.ts:239` and `:278`). Tables and the placeholder row are not written.

### 019b AC-4 - CONFIRM

- Wave 1: MET. Bash `grep` / `rg` / `egrep` lower to `search` (`src/hooks/shared/pre-tool-use.ts:294-297`). Resolve goes to the VFS seam (`:140-145`). Production seam is `GET /memory/grep` (`src/hooks/runtime.ts:602-603`). `pre-tool-use.ts` does not import `node:fs`.

### 019b AC-5 - CONFIRM

- Wave 1: UNMET. That stands. This is a still-required absence.
- The hook POSTs the three intents (`src/hooks/shared/session-end.ts:105-114`).
- The lock defaults to a fake and dispatch does not pass a real lock (`src/hooks/shared/session-end.ts:78`, `src/hooks/runtime.ts:384`).
- Spawn defaults to `noopSummarySpawn` (`src/hooks/runtime.ts:271` and `:474-476`). Binaries do not pass `summarySpawn` (`src/hooks/binary.ts:91`).
- Writer constraint: the daemon default handler still enqueues a `summary` job (`src/daemon/runtime/capture/attach.ts:274-284`) and says the mark, usage, and skillify body is deferred (`:237-242`). The hook-side lock and detached spawn the criterion names are absent. Do not write that the daemon never queues a summary.

### 019b AC-6 - CONFIRM

- Wave 1: MET. A different runtime path returns not-ok (`src/daemon/runtime/middleware/runtime-path.ts:164-166`). Middleware responds 409 and does not call `next()` (`:305-314`).
- Assembly installs the service (`src/daemon/runtime/assemble.ts:3325`). The hook surfaces 409 as `runtime-path-conflict` (`src/hooks/shared/capture.ts:35` and `:84-94`) and stamps the header (`src/hooks/shared/daemon-client.ts:118`).

### 019c AC-1 - CONFIRM

- Wave 1: UNMET. That stands. This is a still-required absence.
- Hook binaries that reach shared capture: Claude Code, Codex, and Cursor only (index AC-2).
- Hermes, pi, and OpenClaw shims exist under `src/hooks/` and are not called from `harnesses/*/src` entries.
- OpenCode, Gemini CLI, and Oh My Pi: no `harnesses/` directory and no `src/hooks/` shim.
- pi extension entry cited at `src/hooks/pi/shim.ts:15-18` is absent.
- Hook `summarySpawn` is a no-op even for Claude Code (`src/hooks/runtime.ts:474-476`).

### 019c AC-1 summary-rows sentence - OVERTURN

- Wave 1 says no harness produces summary rows because the hook spawn is a no-op. The hook spawn is a no-op. The daemon session-end handler still enqueues a `summary` job (`src/daemon/runtime/capture/attach.ts:274-284`) and `summaryCliSpecFor` shells a host CLI (`src/daemon/runtime/summaries/job.ts:153-168`).
- The UNMET on 019c AC-1 still stands. Do not use "no summary rows" as the reason.

### 019c AC-2 - CONFIRM

- Wave 1: UNMET. That stands. This is a still-required absence.
- `openclawGoalKpiFallback` (`src/hooks/openclaw/shim.ts:166-171`) and `piGoalKpiFallback` (`src/hooks/pi/shim.ts:69-74`) exist.
- Repo callers are tests (`tests/hooks/openclaw/shim.test.ts`, `tests/hooks/pi/shim.test.ts`). `src/hooks/runtime.ts` never calls them. The harness entries do not either.

### 019c AC-3 - CONFIRM

- Wave 1: UNMET. That stands. This is a still-required absence.
- Slice helper: `src/hooks/openclaw/shim.ts:98-103`. Expand helper: `:113`.
- The harness does not run the shim (`harnesses/openclaw/src/index.ts:64-66`). The single-event normalizer does not send the slice (`src/hooks/openclaw/shim.ts:184-185`). No cursor is persisted by the harness entry.

### 019c AC-4 - CONFIRM

- Wave 1: UNMET. That stands. This is a still-required absence.
- Brief line: `src/hooks/codex/shim.ts:70` and `:77-78`. Response shape: `:88-91`.
- `codexSessionStartSetup` names `session-start-setup.ts` (`src/hooks/codex/shim.ts:60-66`). That file is absent. The only other mention is `tests/hooks/codex/shim.test.ts`.
- The Codex binary uses the shared runtime (`harnesses/codex/src/index.ts:36-37`). Production `autoUpdate` and `ensureTables` are empty in-process functions (`src/hooks/shared/session-start-seams.ts:124-125`). The Codex shim does not implement `spawnHygieneChild`.

### 019c AC-5 - CONFIRM

- Wave 1: UNMET. That stands. This is a still-required absence.
- Channel router: `src/hooks/normalize.ts:183-198`. Declared channels match D-08.
- The same logical block does not land. Codex substitutes the login line (`src/hooks/codex/shim.ts:77-78`). Hermes appends an MCP mention (`src/hooks/hermes/shim.ts:59-60`). pi wraps a fenced block (`src/hooks/pi/shim.ts:54-56`) and the extension that would write it is absent.
- OpenCode, Gemini CLI, and Oh My Pi have no channel implementation. Hermes, pi, and OpenClaw harness entries do not inject.

### 019c AC-6 - CONFIRM

- Wave 1: UNMET. That stands. This is a still-required absence.
- String constants: `src/hooks/claude-code/shim.ts:100`, `src/hooks/codex/shim.ts:50`, `src/hooks/cursor/shim.ts:48`, `src/hooks/hermes/shim.ts:43`, `src/hooks/pi/shim.ts:37`, `src/hooks/openclaw/shim.ts:57`.
- On disk: `references/claude-code/`, `references/codex/`, `references/cursor/`. Absent: `references/hermes/`, `references/pi/`, `references/openclaw/`.
- Existing fixtures are zod oracles (`references/README.md:16-19`), not sibling harness repos.

### 019d AC-1 - UNVERIFIABLE

- Wave 1: MET. Header stamping in `mcp/src/daemon-seam.ts` was not re-opened in this walk.
- Registration and stdio connect were seen (`mcp/src/index.ts:152-156`, `mcp/src/tools.ts`). Do not flip the criterion from this report. It is not a reason to leave `in-work/`.

### 019d AC-2 - CONFIRM

- Wave 1: UNMET. That stands. This is a still-required absence for a handler guarantee.
- `secret_list` rebuilds names. Not re-opened line by line. The exec half was.
- `toSecretExecResult` copies `stdout` and `stderr` into `output` when they are non-empty, else `output` (`mcp/src/handlers.ts:128-134`). It does not force the SDK sentinel.
- The daemon view type says those fields are already redacted (`src/daemon/runtime/secrets/exec.ts:113-123`) and strips sensitive inherited env names so they are not echoed (`:690-702`). The MCP handler still returns the daemon strings as-is. The SDK floor does not (`src/sdk/client.ts:379-392`).

### 019d AC-3 - CONFIRM

- Wave 1: MET. Handlers return `errorResult` before `route` when `reason` is empty (`mcp/src/handlers.ts:248-264`). Schemas require `reason` (`mcp/src/tools.ts:90-94`).

### 019d AC-4 - CONFIRM

- Wave 1: UNMET. That stands. This is a still-required absence.
- `graphBuilt` defaults false (`mcp/src/index.ts:82`, registry skip at `mcp/src/registry.ts:170-174`).
- Production auto-start calls `startMcpServer()` with no options (`mcp/src/index.ts:199`).
- No `graphBuilt` assignment under `harnesses/`, `src/connectors/`, or `src/hooks/`.

### 019d AC-5 - CONFIRM

- Wave 1: UNMET. That stands. This is a still-required absence.
- `session_search` is recorded as removed (`mcp/src/tools.ts:12-16`). `inferParentSessionKey` remains a helper (`mcp/src/sessions.ts:2-6`) and is not a registered tool. The tool cannot run.

### 019d AC-6 - CONFIRM

- Wave 1: MET. `startMcpServer` connects stdio on the primary server and, when `serveHttp` is true, builds a second server and connects HTTP (`mcp/src/index.ts:152-164`). Default auto-start is stdio only (`:198-199`).

### 019e AC-1 - UNVERIFIABLE

- Wave 1: MET. `src/sdk/client.ts` remember, recall, and header lines were not re-opened. Do not flip. Not a reason to leave `in-work/`.

### 019e AC-2 - UNVERIFIABLE

- Wave 1: MET. Retry and error-class mapping in `src/sdk/client.ts` were not re-opened. Do not flip. Not a reason to leave `in-work/`.

### 019e AC-3 - UNVERIFIABLE

- Wave 1: MET. Browser and Bun execution was not run. Import shape of `src/sdk/client.ts` was not fully re-audited. Do not flip. Not a reason to leave `in-work/`.

### 019e AC-4 - UNVERIFIABLE

- Wave 1: MET. `src/sdk/react.ts` was not re-opened. Do not flip. Not a reason to leave `in-work/`.

### 019e AC-5 - UNVERIFIABLE

- Wave 1: MET. `src/sdk/vercel.ts` and `src/sdk/openai.ts` were not re-opened. Do not flip. Not a reason to leave `in-work/`.

### 019e AC-6 - CONFIRM

- Wave 1: MET. `secrets.exec` returns `redactedOutput` or `SECRET_REDACTED` and does not read `stdout` (`src/sdk/client.ts:47-51` and `:379-392`).

## PRD-020c and the 020 folder

020a, 020b, and 020d were not re-walked. This report does not confirm or overturn those criteria. 020c alone has still-required criteria absent, so the folder stays in `in-work/`.

### Stay in in-work - CONFIRM

- Recommended action: leave `library/requirements/in-work/prd-020-surfaces/` in `in-work/`. Do not move it to `completed/` on the 020c criteria.
- All six 020c criteria are absent (below). The index reopen note at `prd-020-surfaces-index.md:13-14` still matches: no extension manifest, esbuild entry is the hook, and there is no installer that activates the shell.

### c-AC-1 - CONFIRM

- Wave 1: UNMET. That stands.
- `harnesses/cursor/extension/extension.ts:117-121` registers `honeycomb.wireHooks` and calls `deps.hooks.wire()`. `bindings.ts:48-52` maps that to `connector.install()`.
- `src/connectors/cursor.ts:100-118` targets `~/.cursor/hooks.json` and `<pluginRoot>/bundle/<file>`. `install()` copies handler bytes and calls `writeJsonIfChanged` (`src/connectors/contracts.ts:345-364`).
- No production caller of the extension `activate(host, deps)`. `harnesses/cursor/src/index.ts:36` `activate()` is the hook boot, a different function. Esbuild bundles `dist/harnesses/cursor/src/index.js` into `harnesses/cursor/bundle` (`esbuild.config.mjs:181-184`), not the extension. Glob of `harnesses/cursor/**/package.json` returned no files. `harnesses/cursor/extension/CONVENTIONS.md:93-106` records the vscode host and the manifest as deferred.
- A Cursor user cannot run Wire / Refresh Hooks from this checkout.

### c-AC-2 - CONFIRM

- Wave 1: UNMET. That stands.
- No-clobber exists at `src/connectors/contracts.ts:473-495`.
- Destinations the criterion names are absent. `src/connectors/cursor.ts:122-125` links only into `~/.cursor/skills/`. There is no `skills-cursor` path and no `<project>/.cursor/skills/` target in the Cursor connector.
- `harnesses/cursor/extension/bindings.ts:67-72` comments name those destinations. The connector it wraps does not. The extension is not activatable (c-AC-1).

### c-AC-3 - CONFIRM

- Wave 1: UNMET. That stands.
- Preserve logic is in the connector: `src/connectors/cursor.ts:173-188` keeps entries that fail `isHoneycombEntry`. Sentinel and `/honeycomb/bundle/` command path: `src/connectors/contracts.ts:295-304`.
- The extension command that the criterion names is not activatable (c-AC-1). CLI `setup` can run the same connector. That is not Wire / Refresh Hooks.

### c-AC-4 - CONFIRM

- Wave 1: UNMET. That stands.
- `harnesses/cursor/extension/render.ts:95-105` paints one glyph per dimension and the word `FAILING` in the tooltip. `extension.ts:100-105` would apply that to an injected status-bar seam.
- A real editor status bar is absent. The host is injected (`extension.ts:24-25`). `harnesses/cursor/extension/CONVENTIONS.md:93-94` says the vscode adapter is deferred.

### c-AC-5 - CONFIRM

- Wave 1: UNMET. That stands.
- Production `LoginFlow` is absent. `harnesses/cursor/extension/contracts.ts:240-242` says the device-flow binding is deferred. The in-tree implementation is `createFakeLoginFlow` at `:285`, which writes whatever path a test passes.
- `extension.ts:124-129` calls `deps.login.login` when the shell is activated. The shell is not activatable. Live CLI login writes `~/.deeplake/credentials.json` (`src/hooks/shared/credential-reader.ts:16-19` documents the same shared path as the read target).

### c-AC-6 - CONFIRM

- Wave 1: UNMET. That stands.
- Embed helper: `harnesses/cursor/extension/bindings.ts:90-96` calls `renderDashboard` and `renderDashboardHtml`. No production module calls extension `activate` or `dashboardWebviewRenderer`. Callers of the shell are tests. Extension packaging is absent (c-AC-1).

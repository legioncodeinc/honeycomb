# Code standing: hooks

Wave 2. Scope is the hook-lifecycle recommended edits in `knowledge/integrations.md`, the cursor shim recommended edits in `knowledge/frontend-dashboard.md`, and the `src/hooks/capture.ts` absence plus turn-counter edits in `knowledge/ai-capture-pipeline.md`.

Source walk: `src/hooks/` (build output and `node_modules` skipped). Cited lines outside that tree were read only where an edit depends on them.

Product source and knowledge pages were not edited.

## Counts

- CONFIRM: 26
- OVERTURN: 0
- UNVERIFIABLE: 0

Every recommended edit below should be applied. Where a wave-1 grounding line is wrong, the correction is in that item. Do not copy a corrected grounding into the knowledge page.

## Hook lifecycle

Source report: `library/requirements/reports/2026-10-04-kb-prd-standing/knowledge/integrations.md`. Page: `library/knowledge/private/integrations/hook-lifecycle.md`.

The page-level REVISE stands. Keep the Claude Code event row, the shim host-CLI constants as shim constants, the credential path, the auto-pull kill switches, and the Claude Code pre-tool response shape.

### D-13 CONFIRM

- Claim: Cursor pre-tool is `beforeShellExecution` (Shell), and Cursor normalizes `Shell` to `Bash` so the same VFS intercept applies.
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:34` and `:137`.
- Evidence: `src/hooks/cursor/shim.ts:36` has no `beforeShellExecution`. `postToolUse` is `tool_call` (`src/hooks/cursor/shim.ts:39`). `Shell` on that logical event returns `preToolData` (`src/hooks/cursor/shim.ts:88`). Unmapped native names are dropped (`src/hooks/normalize.ts:131`). VFS runs only for logical `pre-tool-use` (`src/hooks/runtime.ts:377`). The connector still registers `pre-tool-use` as `beforeShellExecution` with matcher `Shell` (`src/connectors/cursor.ts:66` and `:155`). The binary is `createCursorShim()` (`harnesses/cursor/src/index.ts:47`).
- Apply: replace the Cursor pre-tool cell and the "same intercept applies" sentence. The registered `beforeShellExecution` handler does not reach `runPreToolUse`. `Shell` on `postToolUse` is captured as `tool_call`.

### D-14 CONFIRM

- Claim: Hermes pre-tool is `on_tool_use` (terminal only), a VFS intercept.
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:34` and `:137`.
- Evidence: `on_tool_use` maps to `tool_call` only (`src/hooks/hermes/shim.ts:36`). `HERMES_EVENT_MAP` has no `pre-tool-use` (`src/hooks/hermes/shim.ts:33`). Non-terminal tools return `undefined` and are dropped from capture (`src/hooks/hermes/shim.ts:82`).
- Apply: replace the Hermes pre-tool cell. Terminal-only tool-call capture holds. It is not a VFS intercept.

### D-15 CONFIRM

- Claim: the lifecycle is functionally complete because OpenClaw batches capture at `agent_end` and pi reads session-start context from a static `AGENTS.md` block.
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:39`.
- Evidence: live `agent_end` returns session-end data (`src/hooks/openclaw/shim.ts:184`). `createOpenClawShim` does not call `openclawExpandBatch` (`src/hooks/openclaw/shim.ts:192`). That helper is only called from tests. `PI_EVENT_MAP` is only `agent_end` and `session_shutdown` (`src/hooks/pi/shim.ts:28`). `harnesses/pi/src/index.ts:8` is `bootHarness("pi")` only. `harnesses/pi/extension-source/honeycomb.ts`, named at `src/hooks/pi/shim.ts:17`, is absent.
- Apply: replace the functionally-complete sentence. The table cells that say OpenClaw prompt, tool, and assistant rows are an `agent_end` batch (`hook-lifecycle.md:33`) overstate the live shim the same way.

### D-16 CONFIRM

- Claim: session-start heals the org token, auto-updates, ensures tables, writes a placeholder summary, and spawns a graph-pull worker.
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:84`.
- Evidence: `runSessionStart` still calls those seams (`src/hooks/shared/session-start.ts:188`). Production seams are `createSessionStartSeams` (`src/hooks/runtime.ts:279`). `healDriftedOrgToken`, `autoUpdate`, `ensureTables`, `writePlaceholderSummary`, and `spawnGraphPull` are empty (`src/hooks/shared/session-start-seams.ts:123`). `autoPullSkills` and `autoPullAssets` are real (`src/hooks/shared/session-start-seams.ts:133` and `:144`). Claude Code skips the in-process pulls and spawns a child (`src/hooks/claude-code/shim.ts:276`, `src/hooks/shared/session-start.ts:265`). The child calls the same seams (`harnesses/claude-code/src/hygiene.ts:79`), so graph-pull stays a no-op and the two pulls stay real.
- Apply: keep credential load, context render, prime render, `RECALL_AWARENESS_NOTICE` (`src/hooks/shared/session-start.ts:69`), and the skills and assets pulls. Say the heal, update, table-ensure, placeholder, and graph-pull steps are calls into no-ops.

### D-17 CONFIRM

- Claim: session-start renders a rules and goals context block regardless of the capture gate.
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:88`.
- Evidence: the hook POSTs `/api/hooks/context` (`src/hooks/shared/context-renderer.ts:17` and `:36`) and is not gated (`src/hooks/shared/session-start.ts:205`). The only `contextHandler` in `src/` is the default (`src/daemon/runtime/capture/attach.ts:197`), which returns `{ additionalContext: "" }` (`src/daemon/runtime/capture/attach.ts:216`). `attachHooks` in `src/daemon/runtime/assemble.ts:1373` does not pass `contextHandler`. Prime is `GET /api/memories/prime` (`src/hooks/shared/prime-renderer.ts:43`) and the recall-awareness notice is still appended (`src/hooks/shared/session-start.ts:239`).
- Apply: say the hook requests the block and production returns an empty string. Keep the prime digest and the recall-awareness notice.

### D-18 CONFIRM

- Claim: a signed-out session POSTs both auto-pulls unscoped and the daemon fail-closes them.
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:103`.
- Evidence: skills headers omit org when the credential has none (`src/hooks/shared/session-start-seams.ts:242`). Assets scope uses org `"local"` when the credential org is absent (`src/hooks/shared/session-start-seams.ts:197`).
- Apply: keep the skills half. Replace the assets half. The assets pull stamps a local org sentinel. Kill-switch names in the same paragraph were not contradicted by the seams file.

### D-19 CONFIRM

- Claim: query-aware recall is injected synchronously on every `UserPromptSubmit`.
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:109`.
- Evidence: Claude Code registers a second `UserPromptSubmit` with `--honeycomb-recall` (`harnesses/claude-code/hooks/hooks.json:20`). Recall mode maps only that event (`src/hooks/claude-code/shim.ts:65`). Codex maps `UserPromptSubmit` to `user_message` (`src/hooks/codex/shim.ts:38`). Cursor maps `beforeSubmitPrompt` to `user_message` (`src/hooks/cursor/shim.ts:38`). The channel test states only the Claude Code recall-mode shim maps `user_prompt_recall` (`tests/hooks/shims-channel.test.ts:89`).
- Apply: scope prompt-time recall to the Claude Code recall registration. Codex uses the same native name for capture only. Cursor prompt capture is `beforeSubmitPrompt`.

### D-20 CONFIRM

- Claim: `renderContext` knows which event it is rendering for, so the prompt-time block is shaped as a mid-session inject instead of the session-start digest layout.
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:114`.
- Evidence: `renderContext` exists. The shim method is `src/hooks/normalize.ts:154` and the contract is `src/hooks/contracts.ts:210`. It does not take an event argument. It passes the block text through (`src/hooks/normalize.ts:189`). The recall-mode Claude shim sets `contextHookEvent: "UserPromptSubmit"` (`src/hooks/claude-code/shim.ts:265`), and only then does `renderContext` add `hookSpecificOutput` (`src/hooks/normalize.ts:186`). The block text is built by `renderRecallBlock` (`src/hooks/shared/user-prompt-recall.ts:142`). `createContextRenderer` has no event branch (`src/hooks/shared/context-renderer.ts:34`).
- Apply: revise the sentence. Do not write that `renderContext` is absent. Say the mid-session text comes from `renderRecallBlock`, and `renderContext` only changes the envelope when the shim was built with `contextHookEvent`.

### D-21 CONFIRM

- Claim: the session-start and prompt-time arms reuse the same daemon recall, and an unwired embed mount makes `/memory/grep` run the lexical floor with `degraded:true`.
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:109` and `:117`.
- Evidence: prompt arm is `POST /api/memories/recall` (`src/hooks/shared/recall-renderer.ts:48`). Session-start arm is `GET /api/memories/prime` (`src/hooks/shared/prime-renderer.ts:43`). Pre-tool arm is `GET /memory/cat|grep|ls|find` (`src/hooks/runtime.ts:600`). `fetchGrep` builds collection deps with no embed client (`src/daemon/runtime/vfs/api.ts:368`) and returns `degraded: pool.degraded` (`src/daemon/runtime/vfs/api.ts:395`).
- Apply: say the two recall arms use different daemon routes. Keep the degraded-lexical fact, and attach it to VFS `GET /memory/grep`, not to the prompt-recall section.

### D-22 CONFIRM

- Claim: `cat` / `Read` calls `readVirtualPathContent`, and `grep` / `Glob` calls a grep-direct path.
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:133`.
- Evidence: neither name exists under `src/`. Verb routing is `src/hooks/shared/pre-tool-use.ts:87` and `src/hooks/shared/pre-tool-use.ts:239` (Read, Grep, Glob, Bash cat/grep/ls/find, Write/Edit deny, unmodelable echo). The hook resolves those verbs with `GET /memory/cat`, `/grep`, `/ls`, and `/find` (`src/hooks/runtime.ts:600`).
- Apply: replace the function names with those routes. Keep the verb routing.

### D-23 CONFIRM

- Claim: on an assistant-response event, capture asks the daemon to evaluate the stop-counter trigger.
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:127`.
- Evidence: the capture body is `{ event, metadata }` with no stop-counter field (`src/hooks/shared/capture.ts:48`). `isTurnTerminating` does not appear under `src/hooks/`. The daemon defaults it to `false` (`src/daemon/runtime/capture/event-contract.ts:174`). `tryStopCounterTrigger` runs only when that flag is true (`src/daemon/runtime/capture/capture-handler.ts:827`). `recordMessage` still runs on every accepted event (`src/daemon/runtime/capture/capture-handler.ts:825`).
- Apply: say hook capture never sets the flag, so the skillify stop-counter does not run on the live capture path. The message counter for summaries still bumps.

### D-24 CONFIRM

- Claim: session-end marks the session ended, records usage, fires skillify, and the hook spawns a summary worker that shells the shim host-CLI table.
- Doc: `library/knowledge/private/integrations/hook-lifecycle.md:162`.
- Evidence: the hook POSTs intents `mark-ended`, `record-usage`, and `skillify`, then calls `spawn` (`src/hooks/shared/session-end.ts:105`). The default spawn is `noopSummarySpawn` (`src/hooks/runtime.ts:271` and `:474`). `runHookBinary` builds the runtime without a spawn (`src/hooks/binary.ts:91`). The daemon handler acks and enqueues a `summary` job with `triggerKind: "final"` (`src/daemon/runtime/capture/attach.ts:236` and `:274`). It does not run the three intents. `summaryCliSpecFor` is `codex exec -`, `cursor-agent -p`, `hermes -p`, `pi -p`, and `claude -p` for unknown agents (`src/daemon/runtime/summaries/job.ts:153`).
- Apply: replace the four-step worker paragraph. Shim host-CLI constants still match the table at `hook-lifecycle.md:43`: `src/hooks/claude-code/shim.ts:97`, `src/hooks/codex/shim.ts:46`, `src/hooks/cursor/shim.ts:47`, `src/hooks/hermes/shim.ts:42`, `src/hooks/pi/shim.ts:36`, `src/hooks/openclaw/shim.ts:56`. Keep those as shim constants. The live worker does not shell that table.

### Keeps confirmed

These are LEAVE items, not edits. They held on this walk.

- Claude Code pre-tool block-and-inject: `permissionDecision: "deny"` plus `additionalContext` (`src/hooks/claude-code/shim.ts:199`).
- Credential reader prefers `~/.deeplake/credentials.json` and falls back to `~/.honeycomb/credentials.json` (`src/hooks/shared/credential-reader.ts:16` and `:79`).
- Prompt-recall store modes `0o700` / `0o600` (`src/hooks/shared/user-prompt-recall.ts:81`).
- Shared modules named in the file table exist under `src/hooks/shared/`.

## Cursor shim

Source report: `library/requirements/reports/2026-10-04-kb-prd-standing/knowledge/frontend-dashboard.md`. Page: `library/knowledge/private/frontend/cursor-extension-architecture.md`.

Dashboard-only defects in that report (D1, D2, D9 through D14) are outside this walk.

### D3 CONFIRM

- Claim: each Cursor hook maps to its own compiled script (`session-start.ts`, `capture.ts`, `session-end.ts`).
- Doc: `library/knowledge/private/frontend/cursor-extension-architecture.md:31`.
- Evidence: `src/hooks/cursor/session-start.ts`, `capture.ts`, and `session-end.ts` are absent. The live shim is `src/hooks/cursor/shim.ts:36`. esbuild aliases one cursor binary to `session-start.js`, `capture.js`, `pre-tool-use.js`, and `session-end.js` (`esbuild.config.mjs:183`). The connector registers those aliases (`src/connectors/cursor.ts:73`).
- Apply: describe one shim and four filename aliases of one binary.

### D4 CONFIRM

- Claim: `afterAgentResponse` writes an `assistant_message` row, `stop` writes a `stop` row, and Cursor fires five hooks.
- Doc: `library/knowledge/private/frontend/cursor-extension-architecture.md:31` and `:38`.
- Evidence: both native names map to logical `assistant_message` (`src/hooks/cursor/shim.ts:40`). There is no `stop` logical event. The connector installs `assistant_message` on native `stop` only (`src/connectors/cursor.ts:68`). `afterAgentResponse` is not in `CURSOR_HANDLERS`. The installed set is six events: `sessionStart`, `beforeSubmitPrompt`, `beforeShellExecution`, `postToolUse`, `stop`, `sessionEnd` (`src/connectors/cursor.ts:73`).
- Apply: drop the `stop` row kind and the five-hook count. Say `stop` is captured as `assistant_message`. `afterAgentResponse` is on the shim map and is not installed.

### D5 CONFIRM

- Claim: a `preToolUse` hook for `Shell` runs `parseBashGrep` and `searchDeeplakeTables` and returns `updated_input`.
- Doc: `library/knowledge/private/frontend/cursor-extension-architecture.md:41` and `:116`.
- Evidence: those two names are absent under `src/`. The cursor shim has no `renderPreTool` and no `beforeShellExecution` key (`src/hooks/cursor/shim.ts:36`), so `createShim` drops that native name (`src/hooks/normalize.ts:131`). `Shell` on `postToolUse` stays logical `tool_call` (`src/hooks/cursor/shim.ts:88`), so dispatch runs `runCapture` (`src/hooks/runtime.ts:395`), not `runPreToolUse` (`src/hooks/runtime.ts:377`). `updatedInput` is emitted by the Claude Code shim (`src/hooks/claude-code/shim.ts:222`).
- Apply: remove the cursor `updated_input` / Deep Lake search paragraph. The connector still registers `pre-tool-use.js` on `beforeShellExecution` (`src/connectors/cursor.ts:66`), and that alias cannot map the event.

### D6 CONFIRM

- Claim: the context block is composed in `session-start.ts`, including a "Logged in to Honeycomb as org" line, `healDriftedOrgToken` on drift, and `renderContextBlock` querying `honeycomb_rules`.
- Doc: `library/knowledge/private/frontend/cursor-extension-architecture.md:50`.
- Evidence: `src/hooks/cursor/session-start.ts` is absent. Those login strings are not in `src/hooks/`. `healDriftedOrgToken` is an empty function (`src/hooks/shared/session-start-seams.ts:123`). `createContextRenderer` only forwards the daemon body (`src/hooks/shared/context-renderer.ts:32`). That body is empty in production (`src/daemon/runtime/capture/attach.ts:216`).
- Apply: replace the layered session-start composition. The live path is the shared session-start core plus the cursor shim.

### D7 CONFIRM

- Claim: every `afterAgentResponse` bumps `bumpTotalCount` under `~/.honeycomb/state/`, the session-end hook spawns a wiki worker with `cursor-agent --print`, and the periodic trigger checks `tryAcquireLock`.
- Doc: `library/knowledge/private/frontend/cursor-extension-architecture.md:97`.
- Evidence: `bumpTotalCount`, `tryAcquireLock`, `spawn-wiki-worker.ts`, and `wiki-worker.ts` are absent under `src/hooks/`. Counters are an in-memory daemon map, default every 20 messages (`src/daemon/runtime/capture/turn-counters.ts:12` and `:59`). The hook summary spawn is a no-op (`src/hooks/runtime.ts:271` and `:474`). Session-end on the daemon enqueues a `summary` job (`src/daemon/runtime/capture/attach.ts:274`). The cursor worker CLI is `cursor-agent` with args `["-p"]` (`src/daemon/runtime/summaries/job.ts:157`).
- Apply: replace the hook-side counter, lock, and `cursor-agent --print` paragraph with the daemon counter and `cursor-agent -p`.

### D8 CONFIRM

- Claim: capture stamps `plugin_version` from the bundle `.claude-plugin` marker, checks `isHoneycombPluginEnabled()`, and self-heals with `ensurePluginNodeModulesLink`.
- Doc: `library/knowledge/private/frontend/cursor-extension-architecture.md:84`.
- Evidence: those two function names are absent under `src/`. `pluginVersion` defaults to `""` (`src/daemon/runtime/capture/event-contract.ts:172`). `createHookRuntime` passes only `captureFlag` (`src/hooks/runtime.ts:272`).
- Apply: drop the three named hook seams. `HONEYCOMB_CAPTURE=false` still skips writes through the capture gate the runtime passes. That sentence is a keep (H15).

### H16 CONFIRM

- Claim: embeddings off or unavailable leave `message_embedding` NULL and the row is still written. The sentence is attached to the missing `capture.ts`.
- Doc: `library/knowledge/private/frontend/cursor-extension-architecture.md:93`.
- Evidence: there is no cursor `capture.ts`. The insert omits `message_embedding` so the column default is NULL (`src/daemon/runtime/capture/capture-handler.ts:682`). A later `kickEmbed` attaches a vector when one is returned (`src/daemon/runtime/capture/capture-handler.ts:879`).
- Apply: move the NULL-vector fact off `capture.ts`. Do not drop it.

### Keeps confirmed

- H11: cursor hook source is `src/hooks/cursor/shim.ts`. LEAVE.
- H15: `HONEYCOMB_CAPTURE=false` skips writes (`src/hooks/runtime.ts:272`). LEAVE.

## capture.ts absence and turn counters

Source report: `library/requirements/reports/2026-10-04-kb-prd-standing/knowledge/ai-capture-pipeline.md`.

`src/hooks/capture.ts` is absent. Capture lives at `src/hooks/shared/capture.ts` and does not count thresholds (`src/hooks/shared/capture.ts:48`). `maybeTriggerPeriodicSummary` is absent under `src/`.

### WIK-3 CONFIRM

- Claim: the periodic threshold check is `maybeTriggerPeriodicSummary()` in `src/hooks/capture.ts`.
- Doc: `library/knowledge/private/ai/wiki-summary-workers.md:33`.
- Evidence: both the file and the symbol are absent. The live bump is `TurnCounters.recordMessage` (`src/daemon/runtime/capture/turn-counters.ts:130`), called from `src/daemon/runtime/capture/capture-handler.ts:825`, which enqueues a `summary` cue when the count crosses the threshold.
- Apply: point the periodic check at `turn-counters.ts`, not at a hook capture file.

### WIK-4 CONFIRM

- Claim: the function bumps a per-session counter in `~/.claude/hooks/summary-state/<sessionId>.json` with `{ lastSummaryAt, lastSummaryCount, totalCount }`.
- Doc: `library/knowledge/private/ai/wiki-summary-workers.md:33` and `:37`.
- Evidence: those field names are absent under `src/`. Counters are the in-memory map at `src/daemon/runtime/capture/turn-counters.ts:91`, and the module comment says a restart resets them (`src/daemon/runtime/capture/turn-counters.ts:12`). `~/.claude/hooks/summary-state` is the summary lock root (`src/daemon/runtime/summaries/worker.ts:331`), not a JSON counter.
- Apply: replace the sidecar JSON counter with the in-memory map. Leave the lock-file sentence; that path is the lock root.

### WIK-5 CONFIRM

- Claim: periodic summary fires on `HONEYCOMB_SUMMARY_EVERY_N_MSGS` (default 50) or `HONEYCOMB_SUMMARY_EVERY_HOURS` (default 2).
- Doc: `library/knowledge/private/ai/wiki-summary-workers.md:31` and `:148`.
- Evidence: neither env name exists under `src/`. The live default is `DEFAULT_SUMMARY_EVERY_MESSAGES = 20` (`src/daemon/runtime/capture/turn-counters.ts:59`). `recordMessage` only increments a message count (`src/daemon/runtime/capture/turn-counters.ts:130`). No hours check is in that function.
- Apply: replace both thresholds with the message count of 20. Final session-end enqueue stays a separate path (`src/daemon/runtime/capture/attach.ts:281`).

### CAP-2 CONFIRM

- Claim: the summary worker runs on a message or time threshold.
- Doc: `library/knowledge/private/ai/session-capture.md:99`.
- Evidence: same as WIK-5. `recordMessage` is message-count only (`src/daemon/runtime/capture/turn-counters.ts:130`).
- Apply: drop the elapsed-time arm from the capture-page sentence.

### SKL-1 CONFIRM

- Claim: skillify fires unconditionally at session end because `src/hooks/shared/session-end.ts` posts the `skillify` intent.
- Doc: `library/knowledge/private/ai/skillify-pipeline.md:21` and `:27`.
- Evidence: the hook does post `intents: ["mark-ended", "record-usage", "skillify"]` (`src/hooks/shared/session-end.ts:112`). The live handler does not read intents. It enqueues a `summary` job (`src/daemon/runtime/capture/attach.ts:274`). `evaluateTrigger` is defined at `src/daemon/runtime/skillify/miner.ts:745` and has no caller under `src/` except its export. The only production `tryStopCounterTrigger` call is `src/daemon/runtime/capture/capture-handler.ts:828`, and it runs only when `meta.isTurnTerminating` is true. Hooks never set that flag (D-23).
- Apply: say the session-end intent does not mine. The stop-counter call site exists and does not run on the live capture path.

### SKL-2 CONFIRM

- Claim: `HONEYCOMB_SKILLIFY_EVERY_N_TURNS` defaults to 20.
- Doc: `library/knowledge/private/ai/skillify-pipeline.md:135`.
- Evidence: `DEFAULT_SKILLIFY_EVERY_TURNS = 10` (`src/daemon/runtime/capture/turn-counters.ts:61`). The prose default of 10 on the same page matches the constant.
- Apply: change the config-table default from 20 to 10.

### SKL-3 CONFIRM

- Claim: the live capture path checks `TurnCounters` against `HONEYCOMB_SKILLIFY_EVERY_N_TURNS`.
- Doc: `library/knowledge/private/ai/skillify-pipeline.md:27`.
- Evidence: `skillifyEveryNTurns` reads the env (`src/daemon/runtime/skillify/miner.ts:715`). `attachHooks` does not pass `counterConfig` (`src/daemon/runtime/assemble.ts:1373`). `createCaptureHandler` therefore uses `new TurnCounters(deps.counterConfig)` with that field undefined (`src/daemon/runtime/capture/capture-handler.ts:270`), which keeps the constant 10 (`src/daemon/runtime/capture/turn-counters.ts:95`). `skillifyEveryTurns:` is assigned only in tests. The miner comment that says the counters must be built with `skillifyEveryNTurns()` (`src/daemon/runtime/skillify/miner.ts:741`) is not what assembly does.
- Apply: say the live capture path uses the constant 10 and does not read the env var.

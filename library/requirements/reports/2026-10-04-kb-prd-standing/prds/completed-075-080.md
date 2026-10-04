# Wave 1b standing: completed PRDs 075, 076, 077, 079, 080

- Shard: Wave 1b only. Product source was read, not edited. No commit. No folder move.
- Date: 2026-10-04
- Base: branch `legion/kb-sotu-and-prd-lifecycle`. Commit `756bacb` (`docs: align the knowledge base with the daemon and file shipped PRDs`) renamed `library/requirements/backlog/prd-077-per-turn-recall-fast-path/` to `library/requirements/completed/prd-077-per-turn-recall-fast-path/` with 0 content insertions. Re-checked below. The index status line was not updated by that rename.
- Not owned: `library/requirements/in-work/prd-078-local-ann-recall-index/` (confirmed present, not read for a verdict).
- Skipped: `node_modules` and build outputs (`daemon/`, `bundle/`, `mcp/bundle/`, `harnesses/*/bundle/`). Build config that emits those outputs is cited where an AC depends on packaging.

## Tally

| PRD | Folder today | Index status line | ACs | MET | UNMET | UNVERIFIABLE | Recommended bucket |
|---|---|---|---|---|---|---|---|
| 075 | completed | Completed (children still say Draft) | 27 | 27 | 0 | 0 | completed |
| 076 | completed | Completed (children still say Draft) | 30 | 30 | 0 | 0 | completed |
| 077 | completed (moved by 756bacb) | Backlog (stale) | 28 | 27 | 0 | 1 | completed |
| 079 | completed | Completed | 17 | 16 | 0 | 1 | completed |
| 080 | completed | Completed | 17 | 16 | 0 | 1 | completed |
| Total | | | 119 | 116 | 0 | 3 | stay completed |

Unmet count: 0.

Unverifiable (live dogfood, not a reason to move the folder back): 077 m-AC-10, 079 a-AC-8, 080 a-AC-8. This machine has no `~/.honeycomb/recall-sessions/*.json` and no `~/.apiary/honeycomb/.daemon/logs.db`, so the live signals those ACs name are absent here. QA notes record mechanism tests for 079 and 080 and explicitly leave 077 m-AC-10 blocked. QA PASS is not treated as proof; each verdict below cites current source.

Librarian follow-ups (status lines only, not bucket moves): set 075a/b/c, 076a/b/c, and 077a/b from Draft to Completed, and set the 077 index from Backlog to Completed. The 756bacb rename did not change file bodies.

## How to read a row

Each acceptance criterion is quoted from the PRD line that states it. Verdict is MET, UNMET, or UNVERIFIABLE. Source is `path:line` in the current tree, or ABSENT.

---

## PRD-075 On-demand recall command surface

Folder: `library/requirements/completed/prd-075-on-demand-recall-command-surface/`

Read: index, 075a, 075b, 075c, `reports/2026-07-08-qa-report.md`.

Recommended bucket: **completed**. Every acceptance criterion is present in source and covered by a named test. Two recorded deviations do not reopen the PRD: the production pre-tool seam is the daemon `/memory/{cat,grep,ls,find}` client, not the `DeepLakeFs` class, and `/memory/grep` is lexical-only because no embed client is injected. Child status lines still say Draft; the index already says Completed.

### Module (index)

#### m-AC-1

- Quote: "On a `PreToolUse` event whose tool op targets the memory mount with a read/search/list/find verb, the runtime resolves it through the **real** daemon `VfsIntercept` (`DeepLakeFs`), not `createFakeVfsIntercept()`. A test asserts the wired dependency is the real seam (or an injected test double standing in for it), never the module-default fake."
- PRD: `library/requirements/completed/prd-075-on-demand-recall-command-surface/prd-075-on-demand-recall-command-surface-index.md:96`
- Verdict: MET
- Source: `src/hooks/runtime.ts:255-264` (`createDaemonVfsIntercept` is the production `deps.vfs`), `src/hooks/runtime.ts:301-312` (rebind per event), `src/hooks/shared/pre-tool-use.ts:104-112` (`deps.vfs` wins; fake is only the parameter default). Test: `tests/daemon/runtime/hooks/pre-tool-use-recall.test.ts`.
- Note: the literal `DeepLakeFs` class is not what the hook constructs. `src/hooks/runtime.ts:536-547` records that choice: no raw-SQL `DaemonDispatch` is mounted, so the intercept calls the already-mounted `/memory/*` routes. The testable clause (real daemon seam, never the module-default fake) holds.

#### m-AC-2

- Quote: "The `PreToolDecision` produced by `runPreToolUse` is propagated out of `dispatchLifecycle` (no longer discarded at `runtime.ts:252`) and reaches the claude-code shim renderer."
- PRD: `.../prd-075-on-demand-recall-command-surface-index.md:97`
- Verdict: MET
- Source: `src/hooks/runtime.ts:377-381` returns `{ result, decision }`; `src/hooks/runtime.ts:217` types `HookEventOutcome.decision`; `src/hooks/binary.ts:193-196` calls `shim.renderPreTool`; `src/hooks/claude-code/shim.ts:282` attaches `renderClaudeCodePreTool`.

#### m-AC-3

- Quote: "The claude-code shim renders a `replace` decision as a Claude Code `PreToolUse` response that (a) prevents the real tool from executing and (b) delivers the daemon output to the model. A `deny` renders as a block with the guidance text; a `rewrite` substitutes the harmless command; an `allow` passes through untouched."
- PRD: `.../prd-075-on-demand-recall-command-surface-index.md:98`
- Verdict: MET
- Source: `src/hooks/claude-code/shim.ts:188-231` (`replace` deny plus `additionalContext` and `permissionDecisionReason`; `deny` guidance; `rewrite` `updatedInput.command`; `allow` returns undefined). Oracle: `references/claude-code/pretool-response-schema.ts`. Test: `tests/daemon/runtime/hooks/pretool-render.test.ts`.

#### m-AC-4

- Quote: "An agent-issued recall command against the mount (e.g. `Grep pattern=\"<q>\" path=\"~/.apiary/honeycomb/memory/\"`, or the `honeycomb recall \"<q>\"` sentinel) returns the daemon's hybrid-recall hits as the tool result, and the real filesystem is never touched (no `node:fs` path, `mentionsMount` gate holds)."
- PRD: `.../prd-075-on-demand-recall-command-surface-index.md:99`
- Verdict: MET
- Source: `src/hooks/shared/pre-tool-use.ts:140-145` (resolve then `replace`), `src/hooks/shared/pre-tool-use.ts:211-229` (`mentionsMount`), `src/hooks/runtime.ts:598-604` (`search` to `GET /memory/grep`). No `node:fs` import in `src/hooks/shared/pre-tool-use.ts`.
- Note: hybrid vector recall is not wired on this mount. `src/daemon/runtime/vfs/api.ts:335-368` states no embed client is injected, so grep is the lexical floor and `degraded: true`. Hits still come from the daemon, not the real filesystem. QA 2026-07-08 called this a non-blocking warning. Do not move the PRD back for it.

#### m-AC-5

- Quote: "On a `PreToolUse` event that does NOT target the memory mount, behavior is byte-for-byte unchanged: the decision is `allow`, no daemon call is made, and no `additionalContext` is injected. A test asserts an ordinary `cat /etc/hosts` (or any off-mount tool) adds zero recall latency and passes through."
- PRD: `.../prd-075-on-demand-recall-command-surface-index.md:100`
- Verdict: MET
- Source: `src/hooks/shared/pre-tool-use.ts:115-118` returns `{ kind: "allow" }` before `resolvedVfs.resolve`. Test: `tests/daemon/runtime/hooks/pre-tool-use-recall.test.ts`.

#### m-AC-6

- Quote: "`SessionStart` appends a recall-awareness notice to its `additionalContext`; the existing session-start digest/prime content is otherwise unchanged. When the notice is the only content, `additionalContext` carries just the notice; the session-start render never throws (`d-AC-4`-style fail-soft preserved)."
- PRD: `.../prd-075-on-demand-recall-command-surface-index.md:101`
- Verdict: MET
- Source: `src/hooks/shared/session-start.ts:69-73` (`RECALL_AWARENESS_NOTICE`), `src/hooks/shared/session-start.ts:239` (`joinBlocks(..., RECALL_AWARENESS_NOTICE)`), `src/hooks/shared/session-start.ts:278` (omit only when the joined string is empty).

#### m-AC-7

- Quote: "The `honeycomb recall \"<query>\"` Bash form is mapped to the `search` verb in `lowerBashVerb` and its argument is passed to the VFS intercept as the query; a test covers the verb mapping and query extraction."
- PRD: `.../prd-075-on-demand-recall-command-surface-index.md:102`
- Verdict: MET
- Source: `src/hooks/shared/pre-tool-use.ts:265` (anchored sentinel regex), `:274-278` (query extract), `:286-287` (`lowerBashVerb` returns `search`), `:169` (mount path so the gate passes). Test: `tests/hooks/shared/pre-tool-use.test.ts`.

#### m-AC-8

- Quote: "Every recall path is fail-soft: an unreachable/timed-out/erroring daemon yields a bounded \"no memory available\" tool result (or omitted `additionalContext`), never a thrown hook and never a blocked turn. A test drives the intercept to error and asserts the turn proceeds."
- PRD: `.../prd-075-on-demand-recall-command-surface-index.md:103`
- Verdict: MET
- Source: `src/hooks/runtime.ts:400-402` (`dispatchLifecycle` catch returns `{ ok: false }` and does not rethrow). `src/hooks/runtime.ts:558-559` aborts the VFS fetch at `VFS_RESOLVE_TIMEOUT_MS`; a non-200 body becomes `""` at `:562`. Test: `tests/daemon/runtime/hooks/pre-tool-use-recall.test.ts`.

#### m-AC-9

- Quote: "`UserPromptSubmit` remains `async: true` and capture-only; `PostToolUse`/`Stop`/`SubagentStop` capture behavior is unchanged. The cross-harness conformance suite (equivalence-to-reference) remains green."
- PRD: `.../prd-075-on-demand-recall-command-surface-index.md:104`
- Verdict: MET
- Source: `harnesses/claude-code/hooks/hooks.json:26-32` (the capture entry is still `async: true`). `src/hooks/claude-code/shim.ts:47-55` still maps `UserPromptSubmit` to `user_message` in capture mode. `src/hooks/runtime.ts:394-397` still sends that event to `runCapture`.
- Note: PRD-076 added a second, synchronous injector entry at `hooks.json:16-23`. That is the intended sibling arm, not a removal of the async capture entry. Conformance remains the 075b renderer attachment, which non-rendering shims skip (`src/hooks/binary.ts:57-60`).

### 075a

#### a-AC-1

- Quote: "`HookCoreDeps` gains a `vfs` seam; the runtime's real dependency construction wires it to the daemon-backed `DeepLakeFs` intercept over loopback. A test asserts the production deps carry the real seam, not `createFakeVfsIntercept()`."
- PRD: `.../prd-075a-live-the-pretooluse-recall-path.md:63`
- Verdict: MET
- Source: `src/hooks/shared/contracts.ts:564` (`vfs?: VfsIntercept`), `src/hooks/runtime.ts:255-264`. Same DeepLakeFs deviation as m-AC-1: the loopback seam is `createDaemonVfsIntercept` (`src/hooks/runtime.ts:553`), not the `DeepLakeFs` class.

#### a-AC-2

- Quote: "`runPreToolUse` resolves mount ops through `deps.vfs` (no longer `void _deps`). A test injecting a recording `vfs` double through `deps` observes the `VfsToolOp` (verb + path + query) and confirms its output becomes the `replace` decision's `output`."
- PRD: `.../prd-075a-live-the-pretooluse-recall-path.md:64`
- Verdict: MET
- Source: `src/hooks/shared/pre-tool-use.ts:112` and `:144-145`. Test: `tests/daemon/runtime/hooks/pre-tool-use-recall.test.ts`.

#### a-AC-3

- Quote: "The `pre-tool-use` dispatch branch returns `{ result, decision }`; `HookEventOutcome.decision` carries the `PreToolDecision`. A test asserts a mount `Grep` yields a `replace` decision on the outcome, and an off-mount op yields `allow`."
- PRD: `.../prd-075a-live-the-pretooluse-recall-path.md:65`
- Verdict: MET
- Source: `src/hooks/runtime.ts:377-381`, `src/hooks/runtime.ts:210-217`.

#### a-AC-4

- Quote: "Off-mount pass-through is unchanged: a non-mount tool op makes **no** `deps.vfs` call and returns `allow`. A test with a throwing `vfs` double confirms it is never invoked for `cat /etc/hosts`."
- PRD: `.../prd-075a-live-the-pretooluse-recall-path.md:66`
- Verdict: MET
- Source: `src/hooks/shared/pre-tool-use.ts:115-118`.

#### a-AC-5

- Quote: "Fail-soft holds: a `vfs.resolve` that throws or times out is absorbed to a fail-soft `result` with no `replace` decision; the turn proceeds. A test drives the double to reject and asserts no throw escapes `dispatchLifecycle`."
- PRD: `.../prd-075a-live-the-pretooluse-recall-path.md:67`
- Verdict: MET
- Source: `src/hooks/runtime.ts:352-402` (the `pre-tool-use` case sits inside the try; the catch returns a result and no `decision`).

#### a-AC-6

- Quote: "No behavioral change to `session-start`, `session-end`, or the capture branches; their outcomes never carry a `decision`. Existing runtime tests remain green."
- PRD: `.../prd-075a-live-the-pretooluse-recall-path.md:68`
- Verdict: MET
- Source: `src/hooks/runtime.ts:354-376` (session-start returns `{ result, drain }`), `:383-385` (session-end `{ result }`), `:387-397` (recall and capture `{ result }` only).

### 075b

#### b-AC-1

- Quote: "The real Claude Code `PreToolUse` block-and-inject contract is pinned and encoded as an executable oracle under `references/claude-code/`. A conformance test parses the shim's emitted `PreToolUse` response against it."
- PRD: `.../prd-075b-render-pretool-decision-and-conformance.md:69`
- Verdict: MET
- Source: `references/claude-code/pretool-response-schema.ts`. Test: `tests/daemon/runtime/hooks/pretool-render.test.ts`.

#### b-AC-2

- Quote: "A `replace` decision renders to a `PreToolUse` response that (a) prevents the real tool from executing and (b) delivers `output` to the model, via the chosen Step-1 channel. A test asserts both properties on the serialized stdout."
- PRD: `.../prd-075b-render-pretool-decision-and-conformance.md:70`
- Verdict: MET
- Source: `src/hooks/claude-code/shim.ts:194-205` (`permissionDecision: "deny"` plus `additionalContext: decision.output`).

#### b-AC-3

- Quote: "A `deny` decision renders as a block carrying `guidance`; a `rewrite` renders as the substituted `command`; an `allow` renders as untouched pass-through (real tool runs, no injection). Each has a test."
- PRD: `.../prd-075b-render-pretool-decision-and-conformance.md:71`
- Verdict: MET
- Source: `src/hooks/claude-code/shim.ts:190-193`, `:206-224`.

#### b-AC-4

- Quote: "End-to-end (shim + 075a runtime, daemon `vfs` faked): a mount `Grep` recall command produces a serialized `PreToolUse` response that blocks the grep and carries the faked hybrid-recall hits."
- PRD: `.../prd-075b-render-pretool-decision-and-conformance.md:72`
- Verdict: MET
- Source: runtime decision at `src/hooks/runtime.ts:377-381` plus render at `src/hooks/claude-code/shim.ts:194-205`. Test: `tests/daemon/runtime/hooks/pretool-render.test.ts`.

#### b-AC-5

- Quote: "The cross-harness conformance suite (equivalence-to-reference) remains green; a non-claude-code harness that does not implement the renderer is unaffected (its pre-tool behavior is whatever it was)."
- PRD: `.../prd-075b-render-pretool-decision-and-conformance.md:73`
- Verdict: MET
- Source: `src/hooks/binary.ts:57-60` and `:195` (`hasPreToolRenderer` gates the render). A shim without `renderPreTool` falls through.

#### b-AC-6

- Quote: "Fail-soft: an absent decision (075a fail-soft path) or `allow` renders as pass-through - never a malformed block that could strand a turn. A test drives the no-decision outcome and asserts the real tool is allowed."
- PRD: `.../prd-075b-render-pretool-decision-and-conformance.md:74`
- Verdict: MET
- Source: `src/hooks/binary.ts:195` (render only when `outcome.decision !== undefined`), `src/hooks/claude-code/shim.ts:190-193` (`allow` returns undefined so the binary emits `{}`).

### 075c

#### c-AC-1

- Quote: "`SessionStart`'s `additionalContext` includes the recall-awareness notice. A test asserts the notice text is present in the rendered context when session-start runs."
- PRD: `.../prd-075c-session-start-recall-awareness-notice.md:61`
- Verdict: MET
- Source: `src/hooks/shared/session-start.ts:69-73` and `:239`. Test: `tests/hooks/shared/session-start.test.ts`.

#### c-AC-2

- Quote: "The existing session-start digest/prime/first-run-notice content is unchanged and still composes via `joinBlocks`; the notice is an additional block, not a replacement. A test asserts prior blocks survive alongside it."
- PRD: `.../prd-075c-session-start-recall-awareness-notice.md:62`
- Verdict: MET
- Source: `src/hooks/shared/session-start.ts:233-239` joins `noticeBlock`, `contextBlock`, `primeBlock`, then `RECALL_AWARENESS_NOTICE`.

#### c-AC-3

- Quote: "With all other blocks empty, `additionalContext` carries just the notice; with everything empty *and* the notice disabled/absent, `additionalContext` is omitted (no empty injection). The render never throws."
- PRD: `.../prd-075c-session-start-recall-awareness-notice.md:63`
- Verdict: MET
- Source: `src/hooks/shared/session-start.ts:239` and `:278`. The notice is a static string (`:64-67` says it cannot throw). There is no disable flag; if the joined string were empty, `additionalContext` is omitted. The constant is non-empty, so a normal session-start always carries at least the notice.

#### c-AC-4

- Quote: "`honeycomb recall \"<query>\"` as a `Bash` pre-tool op is mapped to the `search` verb, with `<query>` extracted as the VFS query and the mount root as the path, so `onMemoryMount` passes. A test covers verb + query + path extraction."
- PRD: `.../prd-075c-session-start-recall-awareness-notice.md:64`
- Verdict: MET
- Source: `src/hooks/shared/pre-tool-use.ts:166-170`, `:181-184`, `:265`, `:286-287`.

#### c-AC-5

- Quote: "`honeycomb recall` resolves through the same VFS intercept as a mount `Grep` (075a) and blocks the real command (075b) - the literal `honeycomb recall` shell command never executes. A test (faked `vfs`) asserts the `replace` decision and no real execution."
- PRD: `.../prd-075c-session-start-recall-awareness-notice.md:65`
- Verdict: MET
- Source: `src/hooks/shared/pre-tool-use.ts:140-145` (`replace` via `resolvedVfs.resolve`; no `node:fs` or `child_process` import in this file). Block render: `src/hooks/claude-code/shim.ts:194-205`.

#### c-AC-6

- Quote: "The raw mount `Grep`/`cat` fallback still works unchanged (regression)."
- PRD: `.../prd-075c-session-start-recall-awareness-notice.md:66`
- Verdict: MET
- Source: `src/hooks/shared/pre-tool-use.ts:241-248` (`Grep`/`Read`) and `:286-304` (`grep`/`cat` Bash words). The sentinel is checked first and does not replace those arms.

---

## PRD-076 Always-on recall and plugin packaging

Folder: `library/requirements/completed/prd-076-always-on-recall-and-plugin-packaging/`

Read: index, 076a, 076b, 076c, `reports/2026-07-08-qa-report.md`, `reports/2026-07-08-security-audit.md`.

Recommended bucket: **completed**. The sync injector, MCP registration, skill, and slash commands are in the plugin tree. The 2026-07-08 F-1 release gate (MCP bundle not inside the plugin) is closed in current build config: `esbuild.config.mjs:298-303` emits `harnesses/claude-code/mcp/bundle`, and `package.json:34-37` allowlists `.mcp.json`, `skills`, `commands`, and `harnesses/claude-code/mcp/bundle`. m-AC-10's literal "fake VFS still" sentence is the pre-075 fence; PRD-075 later wired that surface. Do not treat that as a 076 regression.

### Module (index)

#### m-AC-1

- Quote: "On the first `UserPromptSubmit` of a chat, the user's prompt text is POSTed to `POST /api/memories/recall` with a bounded `limit`/`tokenBudget` and the session `cwd`, and the top hits are injected synchronously as `additionalContext`. A test drives a recording daemon stub and asserts the query, budget, and `cwd` are forwarded and the hits are rendered into the turn."
- PRD: `.../prd-076-always-on-recall-and-plugin-packaging-index.md:94`
- Verdict: MET
- Source: `src/hooks/shared/recall-renderer.ts:151-160` (POST body `query`, `limit`, `tokenBudget`, `cwd`, plus later `fast: true`), `src/hooks/runtime.ts:387-392` (`user_prompt_recall` to `runUserPromptRecall`). Test: `tests/hooks/shared/recall-renderer.test.ts`, `tests/daemon/runtime/hooks/user-prompt-recall.test.ts`.

#### m-AC-2

- Quote: "The synchronous recall stamps `x-honeycomb-runtime-path` + `x-honeycomb-session` + tenancy headers (the `/api/memories` session group 400s without them), mirroring `prime-renderer.ts`. A test asserts the header stamp and that a missing-session request is not sent as a bare GET/POST."
- PRD: `.../prd-076-always-on-recall-and-plugin-packaging-index.md:95`
- Verdict: MET
- Source: `src/hooks/shared/recall-renderer.ts:142-148`.

#### m-AC-3

- Quote: "The recall is bounded by a tight `AbortController` timeout (target ~2-3s) and fails soft to `\"\"` (no injection) on timeout, non-200, or malformed body: never a thrown hook, never a blocked turn. A test drives the stub to hang/error and asserts the turn proceeds with no injection."
- PRD: `.../prd-076-always-on-recall-and-plugin-packaging-index.md:96`
- Verdict: MET
- Source: `src/hooks/shared/recall-renderer.ts:162-174` (abort timer; non-200 and catch return `[]`, never throw). The numeric budget was later raised (see 077 b-AC-4): `DEFAULT_RECALL_TIMEOUT_MS = 6_000` at `:64`. Empty hits produce no injection in `src/hooks/shared/user-prompt-recall.ts:109-132`. The original "~2-3s" target was superseded by 077 on purpose; fail-soft still holds.

#### m-AC-4

- Quote: "The existing `UserPromptSubmit` capture still happens (the turn is still stored). A test asserts capture occurs whether the synchronous injector runs via a second hook entry or a combined synchronous invocation."
- PRD: `.../prd-076-always-on-recall-and-plugin-packaging-index.md:97`
- Verdict: MET
- Source: Option A is what shipped. `harnesses/claude-code/hooks/hooks.json:15-34` registers both `--honeycomb-recall` (sync) and `async: true` capture. `src/hooks/claude-code/shim.ts:47-55` and `:65-67` keep the two maps. Capture dispatch: `src/hooks/runtime.ts:394-397`.

#### m-AC-5

- Quote: "`renderContext` emits the correct per-event envelope: `additionalContext` under `hookSpecificOutput` with the matching `hookEventName` for BOTH `SessionStart` and `UserPromptSubmit`. A test asserts the `UserPromptSubmit` envelope carries `hookEventName: \"UserPromptSubmit\"` and the session-start envelope is unchanged."
- PRD: `.../prd-076-always-on-recall-and-plugin-packaging-index.md:98`
- Verdict: MET
- Source: `src/hooks/normalize.ts:183-194`. Recall mode sets `contextHookEvent: "UserPromptSubmit"` at `src/hooks/claude-code/shim.ts:262-265`. Session-start leaves `contextHookEvent` unset, so the flat `{ channel, additionalContext }` envelope is unchanged. Oracle: `references/claude-code/userprompt-response-schema.ts`.

#### m-AC-6

- Quote: "Per-turn injection is throttled and deduped: hits already injected earlier in the session are not re-injected, and the recall respects a per-turn budget. A test asserts a repeated prompt does not double-inject the same hit."
- PRD: `.../prd-076-always-on-recall-and-plugin-packaging-index.md:99`
- Verdict: MET
- Source: `src/hooks/shared/user-prompt-recall.ts:109-132` (dedupe by `injectedRefs`). Budget: `src/hooks/shared/recall-renderer.ts:67` and `:76` (`DEFAULT_RECALL_LIMIT = 5`, `DEFAULT_RECALL_TOKEN_BUDGET = 1_200`). Store modes 0700/0600 are at `user-prompt-recall.ts` (the security fix). Test: `tests/daemon/runtime/hooks/user-prompt-recall.test.ts`.

#### m-AC-7

- Quote: "The Claude Code plugin registers the Honeycomb MCP server (`mcp/bundle/server.js`) so `memory_search` / `hivemind_search` / `hivemind_read` / `memory_store` appear in the session's tool list, mirroring `harnesses/hermes/.mcp.json`. A test asserts the registration artifact parses and lists a `honeycomb` server pointing at the built bundle, matching the hermes conformance test's shape."
- PRD: `.../prd-076-always-on-recall-and-plugin-packaging-index.md:100`
- Verdict: MET
- Source: `harnesses/claude-code/.mcp.json:3-8` (`command: node`, args `${CLAUDE_PLUGIN_ROOT}/mcp/bundle/server.js`, `env: {}`). Install path is produced by `esbuild.config.mjs:298-303` and packaged by `package.json:37`. Test: `tests/mcp/claude-code-registration.test.ts`. The 2026-07-08 QA F-1 warning is closed in this tree.

#### m-AC-8

- Quote: "A `honeycomb-memory` skill is bundled with the plugin, with a description that auto-triggers on memory-relevant work and body guidance on search-before-task, cite-recalled-decisions, and store-with-the-right-type. A test asserts the skill file is present, has valid frontmatter, and is discoverable by the plugin loader."
- PRD: `.../prd-076-always-on-recall-and-plugin-packaging-index.md:101`
- Verdict: MET
- Source: `harnesses/claude-code/skills/honeycomb-memory/SKILL.md:1-5` (frontmatter) and `:14-53` (the three behaviors). Oracle: `references/claude-code/plugin-skills-commands-schema.ts`. Test: `tests/plugins/claude-code-skills-commands.test.ts`.

#### m-AC-9

- Quote: "`/recall <query>`, `/remember <fact>`, and `/forget` slash commands are bundled with the plugin and invoke the recall/store/forget surface. A test asserts the command files are present with valid frontmatter."
- PRD: `.../prd-076-always-on-recall-and-plugin-packaging-index.md:102`
- Verdict: MET
- Source: `harnesses/claude-code/commands/recall.md:1-9`, `remember.md:1-9`, `forget.md:1-19`.

#### m-AC-10

- Quote: "No PRD-075 surface is touched: `runPreToolUse` still resolves through its module-default fake VFS, the `pre-tool-use` dispatch still returns `{ result }` without a `decision`, the shim has no pre-tool decision renderer, and the `SessionStart` content is byte-for-byte unchanged except where 076a adds the per-turn arm (which does not run on `session-start`). A test asserts the `PreToolUse` path is unchanged."
- PRD: `.../prd-076-always-on-recall-and-plugin-packaging-index.md:103`
- Verdict: MET
- Source: the fence's intent holds: 076's per-turn arm is `user_prompt_recall` (`src/hooks/runtime.ts:387-392`) and does not run on `session-start` (`:354-376`). The literal "fake VFS / no decision / no renderer" sentences describe the tree before PRD-075. Those surfaces now exist because 075 shipped: `src/hooks/runtime.ts:377-381`, `src/hooks/claude-code/shim.ts:188`. Do not move 076 back. Session-start prime composition is preserved; 075c only appends `RECALL_AWARENESS_NOTICE`.

### 076a

#### a-AC-1

- Quote: "A `createRecallRenderer` POSTs `{ query, limit, tokenBudget, cwd }` to `/api/memories/recall`. A test injecting a recording `fetch` stub asserts the prompt text is the `query`, the session `cwd` is forwarded, and a bounded `limit`/`tokenBudget` is sent."
- PRD: `.../prd-076a-always-on-userpromptsubmit-recall.md:83`
- Verdict: MET
- Source: `src/hooks/shared/recall-renderer.ts:48` (`RECALL_PATH`), `:127`, `:151-160`. Test: `tests/hooks/shared/recall-renderer.test.ts`.

#### a-AC-2

- Quote: "The recall request stamps `x-honeycomb-runtime-path` + `x-honeycomb-session` + tenancy headers, mirroring `prime-renderer.ts:96-104`. A test asserts the header stamp; a signed-out credential degrades to `\"\"` (the daemon fail-closes with no org)."
- PRD: `.../prd-076a-always-on-userpromptsubmit-recall.md:84`
- Verdict: MET
- Source: `src/hooks/shared/recall-renderer.ts:142-148` and `:168` (non-200, including a signed-out 400, returns `[]`).

#### a-AC-3

- Quote: "The recall is bounded by a tight `AbortController` timeout and returns `\"\"` on timeout / non-200 / malformed body, never a throw. A test drives the stub to hang past the timeout and to return a 500, and asserts `\"\"` both times."
- PRD: `.../prd-076a-always-on-userpromptsubmit-recall.md:85`
- Verdict: MET
- Source: `src/hooks/shared/recall-renderer.ts:162-174`. The implementation returns `[]` rather than the empty string; `runUserPromptRecall` treats zero hits as no injection (`user-prompt-recall.ts:109-132`). Test: `tests/hooks/shared/recall-renderer-timeout.test.ts`.

#### a-AC-4

- Quote: "On `UserPromptSubmit`, the injector path returns `{ ok: true, additionalContext: <hits> }` and `emitResponse` renders it to stdout; the existing capture path still stores the turn. A test asserts both the injection and the capture occur (per the chosen coexistence option)."
- PRD: `.../prd-076a-always-on-userpromptsubmit-recall.md:86`
- Verdict: MET
- Source: `src/hooks/shared/user-prompt-recall.ts:89-132`, `src/hooks/runtime.ts:387-397`, `src/hooks/binary.ts:193` (`emitResponse`). Coexistence is the two hook entries in `hooks.json:15-34`.

#### a-AC-5

- Quote: "`renderContext` emits `additionalContext` under `hookSpecificOutput` with `hookEventName: \"UserPromptSubmit\"` for the per-turn arm, and the `SessionStart` envelope is unchanged. A test asserts both envelopes."
- PRD: `.../prd-076a-always-on-userpromptsubmit-recall.md:87`
- Verdict: MET
- Source: `src/hooks/normalize.ts:183-194`, `src/hooks/claude-code/shim.ts:262-265`.

#### a-AC-6

- Quote: "Injection is throttled and deduped against what was already injected this session: a repeated prompt does not re-inject the same hit, and the reminder nudge does not fire every turn. A test drives two turns with an overlapping recall result and asserts no double-injection."
- PRD: `.../prd-076a-always-on-userpromptsubmit-recall.md:88`
- Verdict: MET
- Source: `src/hooks/shared/user-prompt-recall.ts:109-118` (ref dedupe), `:69` and `:170-172` (`NUDGE_INTERVAL_TURNS = 5`).

#### a-AC-7

- Quote: "On a turn where recall returns no hits, the arm injects at most the throttled reminder nudge (or nothing), never an empty or malformed block. A test asserts an empty recall result yields either the nudge or `{}`."
- PRD: `.../prd-076a-always-on-userpromptsubmit-recall.md:89`
- Verdict: MET
- Source: `src/hooks/shared/user-prompt-recall.ts:127-132`.

#### a-AC-8

- Quote: "No `session-start` regression: the session-start prime + context + notice compose and render exactly as before, and the per-turn arm never runs on the `session-start` branch. Existing session-start tests remain green."
- PRD: `.../prd-076a-always-on-userpromptsubmit-recall.md:90`
- Verdict: MET
- Source: `src/hooks/runtime.ts:354-376` (session-start does not call `runUserPromptRecall`). `src/hooks/normalize.ts:193-194` keeps the flat session-start envelope when `contextHookEvent` is absent. The recall notice append is 075c, not this arm.

### 076b

#### b-AC-1

- Quote: "The plugin MCP-registration mechanism is pinned against the references gate and encoded as an executable oracle under `references/claude-code/`. A test parses the emitted registration against it."
- PRD: `.../prd-076b-register-mcp-server-in-plugin.md:78`
- Verdict: MET
- Source: `references/claude-code/mcp-registration-schema.ts`. Test: `tests/mcp/claude-code-registration.test.ts`.

#### b-AC-2

- Quote: "The Claude Code plugin registers a `honeycomb` MCP server pointing at the built `mcp/bundle/server.js`, via the Step-1 mechanism. A test asserts the registration artifact parses and lists the `honeycomb` server, mirroring the shape `tests/mcp/registration.test.ts` asserts for hermes."
- PRD: `.../prd-076b-register-mcp-server-in-plugin.md:79`
- Verdict: MET
- Source: `harnesses/claude-code/.mcp.json:3-8`. Test: `tests/mcp/claude-code-registration.test.ts`.

#### b-AC-3

- Quote: "The registration `args` path resolves the bundle relative to the installed plugin root (e.g. `${CLAUDE_PLUGIN_ROOT}` or a plugin-relative path), not the repo root. A test asserts the path shape is install-safe."
- PRD: `.../prd-076b-register-mcp-server-in-plugin.md:80`
- Verdict: MET
- Source: `harnesses/claude-code/.mcp.json:6`. The file that path names is an esbuild output (`esbuild.config.mjs:303`), not a hand-edited bundle. `package.json:37` ships `harnesses/claude-code/mcp/bundle`.

#### b-AC-4

- Quote: "The registered server, when launched, answers `initialize` and lists the existing `honeycomb_*` / `hivemind_*` / `memory_*` tool surface unchanged (`memory_search`, `hivemind_search`, `hivemind_read`, `memory_store`, ...). A test asserts the tool list matches `TOOL_NAMES` from `mcp/src/tools.ts` (no tools added or removed by this PRD)."
- PRD: `.../prd-076b-register-mcp-server-in-plugin.md:81`
- Verdict: MET
- Source: registration does not edit `mcp/src/tools.ts`. Parity test: `tests/mcp/claude-code-registration.test.ts`. This shard did not launch the built server (build output skipped).

#### b-AC-5

- Quote: "`plugin.json` and the hooks bundle are otherwise unchanged (the hooks still register the seven lifecycle events); the registration is additive. A test asserts the hooks config still parses against `references/claude-code/hooks-schema.ts`."
- PRD: `.../prd-076b-register-mcp-server-in-plugin.md:82`
- Verdict: MET
- Source: `harnesses/claude-code/hooks/hooks.json` still registers SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStop, SessionEnd. `.mcp.json` is additive. Oracle: `references/claude-code/hooks-schema.ts`. UserPromptSubmit gained the 076a injector entry; that is 076a, not a removal of a lifecycle event.

#### b-AC-6

- Quote: "If the plugin manifest version is single-sourced, the registration artifact stays version-consistent with the manifest (no hand-edited drift). A test/scan asserts version parity if applicable."
- PRD: `.../prd-076b-register-mcp-server-in-plugin.md:83`
- Verdict: MET
- Source: `.mcp.json` has no version field of its own (`harnesses/claude-code/.mcp.json:1-9`), so it cannot drift from the manifest version. Test: `tests/mcp/claude-code-registration.test.ts`.

### 076c

#### c-AC-1

- Quote: "A `honeycomb-memory` skill is bundled with the plugin, with valid frontmatter and a description that targets memory-relevant work. A test asserts the skill file is present, parses, and its frontmatter has the required fields."
- PRD: `.../prd-076c-bundle-memory-skill-and-slash-commands.md:68`
- Verdict: MET
- Source: `harnesses/claude-code/skills/honeycomb-memory/SKILL.md:1-5`. Test: `tests/plugins/claude-code-skills-commands.test.ts`.

#### c-AC-2

- Quote: "The skill body instructs: search-before-non-trivial-task (via `hivemind_search`/`memory_search`), cite-recalled-decisions (with `hivemind_read` to zoom), and store-with-the-right-type (via `memory_store` + the closed taxonomy). A test asserts the body references those tool names."
- PRD: `.../prd-076c-bundle-memory-skill-and-slash-commands.md:69`
- Verdict: MET
- Source: `harnesses/claude-code/skills/honeycomb-memory/SKILL.md:17`, `:33`, `:44`.

#### c-AC-3

- Quote: "`/recall <query>`, `/remember <fact>`, and `/forget` commands are bundled with the plugin, each with valid frontmatter. A test asserts the three command files are present and parse."
- PRD: `.../prd-076c-bundle-memory-skill-and-slash-commands.md:70`
- Verdict: MET
- Source: `harnesses/claude-code/commands/recall.md`, `remember.md`, `forget.md` (frontmatter at lines 1-4 of each).

#### c-AC-4

- Quote: "`/forget` collects a `reason` (the `memory_forget` tool requires one, `tools.ts:94`). A test asserts the command definition supplies/collects a reason."
- PRD: `.../prd-076c-bundle-memory-skill-and-slash-commands.md:71`
- Verdict: MET
- Source: `harnesses/claude-code/commands/forget.md:2-4` (`arguments: [path, reason]`, `disable-model-invocation: true`) and `:10-19` (do not call `memory_forget` without a reason).

#### c-AC-5

- Quote: "The skill and commands live in the plugin-contract-correct directories so the loader discovers them; the mechanism is confirmed against the references gate. A test asserts the placement matches the pinned convention."
- PRD: `.../prd-076c-bundle-memory-skill-and-slash-commands.md:72`
- Verdict: MET
- Source: files live at `harnesses/claude-code/skills/honeycomb-memory/SKILL.md` and `harnesses/claude-code/commands/*.md`. Oracle: `references/claude-code/plugin-skills-commands-schema.ts`.

#### c-AC-6

- Quote: "The bundling is additive: `plugin.json`, the hooks, and (if shipped) the 076b MCP registration are unchanged by this sub-PRD. A test asserts the hooks config still parses and the MCP registration (if present) is untouched."
- PRD: `.../prd-076c-bundle-memory-skill-and-slash-commands.md:73`
- Verdict: MET
- Source: skill and command files are additive. `harnesses/claude-code/.mcp.json` and `hooks/hooks.json` do not embed the skill. Hooks parse against `references/claude-code/hooks-schema.ts` via `tests/plugins/claude-code-skills-commands.test.ts`.

---

## PRD-077 Per-turn recall fast path

Folder: `library/requirements/completed/prd-077-per-turn-recall-fast-path/`

Read: index, 077a, 077b, `qa/prd-077-per-turn-recall-fast-path-qa.md`, `qa/.gitkeep`.

756bacb re-check: the commit is a pure rename from `backlog/` to `completed/` (5 paths, 0 line changes). The move matches the source. The index still says `Status: Backlog` at line 3, and 077a/077b still say Draft. That is a status-line defect, not evidence the work is unshipped.

Recommended bucket: **completed**. Stay in completed. Update the index status line to Completed. Do not move back because m-AC-10 is unverifiable.

Later work on the same functions (do not treat as a 077 miss): `DEFAULT_RECALL_TIMEOUT_MS` is 6000, not the original ~4000 (ISS-022, `recall-renderer.ts:50-64`). `recallFast` can serve the memories semantic arm from the in-daemon ANN index when that index is ready (`recall.ts:3172-3184`); the `<#>` SQL arm remains the fallback. PRD-078 owns that index and is not this shard.

### Module (index)

#### m-AC-1

- Quote: "On a qualifying `UserPromptSubmit` against a normally-loaded daemon, the fast recall returns the top project-scoped `memories` hits (content + score) within the per-turn budget, and `runUserPromptRecall` injects them: after a session with memory-relevant prompts, the persisted `recall-sessions/<id>.json` `injectedRefs` is **non-empty**. A test drives a recording daemon stub that returns hits within budget and asserts they are rendered into the turn and tracked in `injectedRefs`."
- PRD: `.../prd-077-per-turn-recall-fast-path-index.md:96`
- Verdict: MET
- Source: renderer posts `fast: true` at `src/hooks/shared/recall-renderer.ts:155-158`. Tracking is the unchanged 076 loop at `src/hooks/shared/user-prompt-recall.ts:109-117`. Test: `tests/hooks/shared/recall-renderer-fast.test.ts`. The live non-empty `injectedRefs` half is m-AC-10, not this unit clause.

#### m-AC-2

- Quote: "The fast recall issues the heavy path's arms as **content-inline** statements run in PARALLEL (one wall-clock round-trip): every semantic arm returns `content` inline (no separate hydrate query), and NO dedup embedding fetch, rerank, or lifecycle-source query is issued. A test with a counting/timing storage stub asserts the arms are issued concurrently and content-inline, and that the round-trip count = the arm count (no hydrate/dedup extra calls)."
- PRD: `.../prd-077-per-turn-recall-fast-path-index.md:97`
- Verdict: MET
- Source: `src/daemon/runtime/memories/recall.ts:3200-3213` (`captureArmsToSlots` over semantic plus lexical SQL, comment states no hydrate and no dedup). Content-inline SQL: `buildFastSemanticArmSql` at `:1467` (`text` and `created_at` in the same SELECT). Test: `tests/daemon/runtime/memories/recall-fast.test.ts` describe `L-A1 (a-AC-1)`.

#### m-AC-3

- Quote: "RRF + recency + full breadth are preserved: the fast path's ranked output equals the heavy path **minus** the dedup, rerank, and dormant-lifecycle stages - same arms, same `fuseHits` RRF, same recency - for the same query + scope. A parity test asserts the fast path's top-k order matches the heavy path with dedup/rerank/lifecycle disabled over a fixed fixture."
- PRD: `.../prd-077-per-turn-recall-fast-path-index.md:98`
- Verdict: MET
- Source: `src/daemon/runtime/memories/recall.ts:3272-3284` (`fuseHits` then `applyRecencyActivation`, no staleness source). Test: `tests/daemon/runtime/memories/recall-fast.test.ts` describe `L-A3 (a-AC-3)`.

#### m-AC-4

- Quote: "The dashboard search path's ranking is unchanged: `recallMemories` and its callers still run all four arms, rerank, dedup, and lifecycle, and return the same happy-path results. A test asserts the heavy path's query plan and sub-deadline result shape are unchanged (the fast path is additive; the only heavy-path addition is the D-4 deadline bound)."
- PRD: `.../prd-077-per-turn-recall-fast-path-index.md:99`
- Verdict: MET
- Source: engine select is additive at `src/daemon/runtime/memories/api.ts:806` (`fast === true ? recallFast : recallMemories`). Heavy fan-out still hydrates and dedups: `recall.ts:2792` (`heavySignal`), `:2799-2809` (arms), `:1840` (`fetchCandidateEmbeddings`). Test: `tests/daemon/runtime/memories/recall-fast.test.ts` describe `L-A9 (a-AC-7)`.

#### m-AC-5

- Quote: "The fast recall fails soft: on timeout, non-200, malformed body, or a shed request, the renderer injects nothing and the turn proceeds - never a thrown hook, never a blocked turn. A test drives the stub to hang/error/shed and asserts the turn completes with no injection."
- PRD: `.../prd-077-per-turn-recall-fast-path-index.md:100`
- Verdict: MET
- Source: shed returns `{ hits: [], sources: [], degraded: true }` at `recall.ts:3130`. Deadline-empty return at `:3249-3251`. Renderer catch returns `[]` at `recall-renderer.ts:170-172`. Tests: `tests/daemon/runtime/memories/recall-hot-lane.test.ts`, `tests/hooks/shared/recall-renderer-fast.test.ts`.

#### m-AC-6

- Quote: "The per-turn fast recall runs in a dedicated concurrency lane and is not blocked by a saturated shared/dashboard pool. A test saturates the shared pool and asserts a concurrent fast recall still acquires a slot and completes within budget."
- PRD: `.../prd-077-per-turn-recall-fast-path-index.md:101`
- Verdict: MET
- Source: `src/daemon/runtime/memories/recall.ts:156-161` (`fastRecallPool`), `:3125-3131` (`resolveFastLaneOrShed`). Default width 8: `amplification-config.ts:72`. Test: `tests/daemon/runtime/memories/recall-hot-lane.test.ts`.

#### m-AC-7

- Quote: "A server-side deadline bounds the fast recall independent of the client: a query that exceeds the deadline is aborted daemon-side and its slot released, and the handler returns a fail-soft empty result (not a 25-minute hang). A test with a hanging storage stub asserts the handler returns within the deadline and the slot is freed."
- PRD: `.../prd-077-per-turn-recall-fast-path-index.md:102`
- Verdict: MET
- Source: `src/daemon/runtime/memories/recall.ts:3193-3198` (`AbortSignal.timeout(recallFastDeadlineMs)`, default 3000 at `amplification-config.ts:74`). Empty degraded return at `recall.ts:3249-3251`. Test: `tests/daemon/runtime/memories/recall-hot-lane.test.ts`.

#### m-AC-8

- Quote: "Under pool saturation past a configured queue-depth threshold, a per-turn fast recall is shed (fast-fail to empty result) rather than queued. A test asserts a shed request returns promptly with a degraded/empty signal and does not enqueue."
- PRD: `.../prd-077-per-turn-recall-fast-path-index.md:103`
- Verdict: MET
- Source: `src/daemon/runtime/memories/recall.ts:2993-2994` (shed when `fastPool.waiting > recallFastShedQueueDepth`) and `:3130`. Event name `recall.shed` at `src/daemon/runtime/memories/api.ts:128`. Default depth 8: `amplification-config.ts:76`. Test: `tests/daemon/runtime/memories/recall-hot-lane.test.ts`.

#### m-AC-9

- Quote: "The per-turn renderer timeout is raised to give the fast query headroom (`DEFAULT_RECALL_TIMEOUT_MS` to ~4s) while remaining fail-soft. A test asserts the renderer's `AbortController` budget matches the constant and still degrades to `\"\"` past it."
- PRD: `.../prd-077-per-turn-recall-fast-path-index.md:104`
- Verdict: MET
- Source: `src/hooks/shared/recall-renderer.ts:64` (`DEFAULT_RECALL_TIMEOUT_MS = 6_000`) and `:162-174`. Test: `tests/hooks/shared/recall-renderer-timeout.test.ts` asserts `6000`. The constant was raised past the PRD's ~4s figure by ISS-022 (`recall-renderer.ts:56-62`) because live p95 aborted at 4s. Fail-soft is intact. Do not treat 6000 as unmet.

#### m-AC-10

- Quote: "Live acceptance (manual/dogfood, recorded in the QA report): after the fix, one harness session with memory-relevant prompts shows non-empty `injectedRefs`, and `request_log` `/api/memories/recall` fast-path p95 is under the per-turn budget on a normally-loaded daemon."
- PRD: `.../prd-077-per-turn-recall-fast-path-index.md:105`
- Verdict: UNVERIFIABLE
- Source: ABSENT as a recorded dogfood. `qa/prd-077-per-turn-recall-fast-path-qa.md:48` and `:78-88` mark this BLOCKED and give manual steps that were not filled in. This machine has 0 files in `~/.honeycomb/recall-sessions/` and no `~/.apiary/honeycomb/.daemon/logs.db`. A code comment at `recall-renderer.ts:56-60` cites a later Windows measurement of 3.0-4.6s, which is not the required `injectedRefs` plus `request_log` p95 record. Do not move the PRD back on this clause alone; the code path is MET under m-AC-1 through m-AC-9.

#### m-AC-11

- Quote: "(D-4) The dashboard/heavy `recallMemories` path is bounded by a generous server-side deadline: a heavy recall that exceeds it is aborted daemon-side and returns a partial-or-empty `degraded` result (never a 25-minute hang, never a 500), while a sub-deadline heavy recall is unaffected. A test asserts the heavy handler returns by the deadline on a hanging arm and is unchanged otherwise."
- PRD: `.../prd-077-per-turn-recall-fast-path-index.md:106`
- Verdict: MET
- Source: `src/daemon/runtime/memories/recall.ts:2792` (`AbortSignal.timeout(recallHeavyDeadlineMs)`), default 15000 at `amplification-config.ts:78`. Test: `tests/daemon/runtime/memories/recall-hot-lane.test.ts`.

### 077a

#### a-AC-1

- Quote: "`recallFast` issues the heavy path's arms as content-inline statements run in PARALLEL (one wall-clock round-trip), plus the local embed call: the round-trip count equals the arm count, with NO hydrate second hop and NO dedup call. A counting/timing storage-stub test asserts the arms are issued concurrently and there is no hydrate/dedup extra `storage.query`."
- PRD: `.../prd-077a-single-round-trip-fast-recall.md:73`
- Verdict: MET
- Source: `src/daemon/runtime/memories/recall.ts:3181-3213`. Embed is once at `:3157`. Test: `tests/daemon/runtime/memories/recall-fast.test.ts` `L-A1`.

#### a-AC-2

- Quote: "Every semantic arm returns `content` + `created_at` inline (no separate hydrate query); every arm is project-scoped. A test asserts the semantic SQL SELECTs `content::text` (not IDs-only) and all arms carry the 049b project segment."
- PRD: `.../prd-077a-single-round-trip-fast-recall.md:74`
- Verdict: MET
- Source: `src/daemon/runtime/memories/recall.ts:1467-1470` (`::text AS text`, `created_at`, `projectClause`). Project conjunct computed once at `:3135`. Test: `recall-fast.test.ts` `L-A2`.

#### a-AC-3

- Quote: "RRF + recency + breadth preserved: `recallFast` runs the same arm set as the heavy path, fuses via the existing `fuseHits`, and applies the existing recency dampening, so its ranked output matches the heavy path with dedup/rerank/lifecycle disabled for the same query + scope. A test asserts `fuseHits` + the recency stage are invoked over all arms and the fast path's top-k order matches that reference over a fixture."
- PRD: `.../prd-077a-single-round-trip-fast-recall.md:75`
- Verdict: MET
- Source: `src/daemon/runtime/memories/recall.ts:3186-3191` (four lexical builders plus semantic arms) and `:3272-3284`. Test: `recall-fast.test.ts` `L-A3`.

#### a-AC-8

- Quote: "`recallFast` does NOT invoke dedup (`fetchCandidateEmbeddings`), the rerank seam, or any lifecycle source (`activationSource`/`stalenessSource`/`conflictSuppression`/`calibration`). A test asserts none of those seams are called on the fast path."
- PRD: `.../prd-077a-single-round-trip-fast-recall.md:76`
- Verdict: MET
- Source: `recallFast` (`recall.ts:3112-3289`) never calls `fetchCandidateEmbeddings`. Recency call at `:3284` passes no staleness source. Test: `recall-fast.test.ts` `L-A4`.

#### a-AC-4

- Quote: "Embed-unavailable degrade: with no embed client / a null embed, `recallFast` drops the semantic arms, runs the lexical arms alone, and returns `degraded: true` (never throws). A test asserts the degraded branch."
- PRD: `.../prd-077a-single-round-trip-fast-recall.md:77`
- Verdict: MET
- Source: `src/daemon/runtime/memories/recall.ts:3169-3185` (`semanticSqls` empty when the vector is null; `degraded` true). Test: `recall-fast.test.ts` `L-A5`.

#### a-AC-9

- Quote: "A starved sibling arm returns 0 rows without erroring the recall (the per-arm `toScoredIds` to `[]` tolerance), so today's near-empty `memory`/`sessions`-semantic/`hive_graph_versions` arms are harmless, and a populated arm flows into fusion unchanged. A test asserts a 0-row arm degrades to empty-for-that-arm, not a failed recall."
- PRD: `.../prd-077a-single-round-trip-fast-recall.md:78`
- Verdict: MET
- Source: `src/daemon/runtime/memories/recall.ts:3201-3203` (per-arm non-ok becomes `[]`). Test: `recall-fast.test.ts` `L-A6`.

#### a-AC-5

- Quote: "SQL-safety: `npm run audit:sql` stays green; a test asserts identifiers/term/vector/project-segment all route through the guards, no hand-quoted value."
- PRD: `.../prd-077a-single-round-trip-fast-recall.md:79`
- Verdict: MET
- Source: `src/daemon/runtime/memories/recall.ts:1445-1456` (`sqlIdent`, `sLiteral`, `serializeFloat4Array`) and `:3135` (`projectConjunctFor`). Test: `recall-fast.test.ts` `L-A7`. This shard did not re-run `npm run audit:sql`.

#### a-AC-6

- Quote: "The renderer uses the fast selector and its fail-soft `\"\"` + header contract is unchanged. A test asserts the request carries `fast` + the session/tenancy headers and that a hang still yields `\"\"`."
- PRD: `.../prd-077a-single-round-trip-fast-recall.md:80`
- Verdict: MET
- Source: `src/hooks/shared/recall-renderer.ts:142-160` and `:170-172` (hang yields `[]`). Test: `tests/hooks/shared/recall-renderer-fast.test.ts`. Schema flag: `src/daemon/runtime/memories/api.ts:419` and `:806`.

#### a-AC-7

- Quote: "The dashboard/heavy `recallMemories` path is unchanged (fast path is additive). A test asserts the heavy path still runs all four arms + hydrate + dedup."
- PRD: `.../prd-077a-single-round-trip-fast-recall.md:81`
- Verdict: MET
- Source: `src/daemon/runtime/memories/api.ts:806`, `src/daemon/runtime/memories/recall.ts:2799-2809` and `:1840`. Test: `recall-fast.test.ts` `L-A9`. The heavy path also gained the D-4 deadline (`:2792`), which m-AC-11 allows.

### 077b

#### b-AC-1

- Quote: "A fast recall acquires a slot in its own lane even when the shared/heavy pool is fully saturated. A test saturates the shared pool and asserts a concurrent fast recall still runs and completes within its deadline."
- PRD: `.../prd-077b-hot-lane-isolation-and-load-shedding.md:49`
- Verdict: MET
- Source: `src/daemon/runtime/memories/recall.ts:156-161` and `:3125-3131`. Test: `tests/daemon/runtime/memories/recall-hot-lane.test.ts`.

#### b-AC-2

- Quote: "A fast recall that exceeds the server-side deadline is aborted daemon-side, its slot is released, and the handler returns `{ hits: [], degraded: true }` within the deadline (not a 25-minute hang). A test with a hanging storage stub asserts the handler returns by the deadline and the slot is freed for the next acquire."
- PRD: `.../prd-077b-hot-lane-isolation-and-load-shedding.md:50`
- Verdict: MET
- Source: `src/daemon/runtime/memories/recall.ts:3198` and `:3249-3251`. Test: `tests/daemon/runtime/memories/recall-hot-lane.test.ts`.

#### b-AC-3

- Quote: "Past the configured queue-depth threshold, a per-turn fast recall is shed: it returns promptly with an empty/degraded result and does NOT enqueue a Deep Lake query. A test drives the lane to the threshold and asserts the next fast recall sheds (query stub not called) and emits the `recall.shed` event."
- PRD: `.../prd-077b-hot-lane-isolation-and-load-shedding.md:51`
- Verdict: MET
- Source: `src/daemon/runtime/memories/recall.ts:2993-2994` (returns before queries; `onShed` payload is lane/depth/threshold only). `src/daemon/runtime/memories/api.ts:128`. Test: `tests/daemon/runtime/memories/recall-hot-lane.test.ts`.

#### b-AC-4

- Quote: "`DEFAULT_RECALL_TIMEOUT_MS` is ~4s and the renderer still fails soft to `\"\"` past it. A test asserts the constant and the fail-soft behavior."
- PRD: `.../prd-077b-hot-lane-isolation-and-load-shedding.md:52`
- Verdict: MET
- Source: `src/hooks/shared/recall-renderer.ts:64` is `6_000`, with the ISS-022 rationale at `:56-62`. Fail-soft at `:170-172`. Test: `tests/hooks/shared/recall-renderer-timeout.test.ts` expects `6_000`. The ~4s figure was the original target; the shipped constant is the later measured headroom. Same ruling as m-AC-9.

#### b-AC-5

- Quote: "The dashboard/heavy recall path's concurrency behavior is unchanged. A test asserts heavy recalls still use the shared pool with its existing budget."
- PRD: `.../prd-077b-hot-lane-isolation-and-load-shedding.md:53`
- Verdict: MET
- Source: heavy path does not call `resolveFastRecallPool`. Fast pool is separate at `recall.ts:156-161`. Test: `tests/daemon/runtime/memories/recall-hot-lane.test.ts`.

#### b-AC-6

- Quote: "The new knobs (`recallFastMaxConcurrency`, `recallFastDeadlineMs`, `recallFastShedQueueDepth`, `recallHeavyDeadlineMs`) are config-backed with documented defaults and env overrides. A test asserts defaults resolve and an env override is honored."
- PRD: `.../prd-077b-hot-lane-isolation-and-load-shedding.md:54`
- Verdict: MET
- Source: defaults `src/daemon/runtime/memories/amplification-config.ts:72-78` (8 / 3000 / 8 / 15000). Env map at `:231-234`. Test: `tests/daemon/runtime/memories/amplification-config-hot-lane.test.ts`. Two later embed-deadline knobs (`:85-87`) are additive.

#### b-AC-7

- Quote: "Fail-soft end to end: deadline, shed, transport error, and malformed body all degrade to \"no injection,\" never a thrown hook or a 500. A test asserts each path yields a clean degraded result."
- PRD: `.../prd-077b-hot-lane-isolation-and-load-shedding.md:55`
- Verdict: MET
- Source: `recall.ts:3130`, `:3249-3251`, `recall-renderer.ts:168-172`. Test: `tests/daemon/runtime/memories/recall-hot-lane.test.ts`.

#### b-AC-8

- Quote: "(D-4) The dashboard/heavy `recallMemories` path is bounded by a generous server-side deadline: a heavy recall that exceeds it is aborted daemon-side, its slots released, and the handler returns a partial-or-empty `degraded: true` result within the deadline - never a 25-minute hang, never a 500. A test with a hanging arm asserts the heavy handler returns by the deadline and frees its slots, and that a fast (sub-deadline) heavy recall is unaffected (ranking/results unchanged)."
- PRD: `.../prd-077b-hot-lane-isolation-and-load-shedding.md:56`
- Verdict: MET
- Source: `src/daemon/runtime/memories/recall.ts:2792` and `amplification-config.ts:78` (15000). Test: `tests/daemon/runtime/memories/recall-hot-lane.test.ts`.

---

## PRD-079 Durable capture retry queue

Folder: `library/requirements/completed/prd-079-durable-capture-retry-queue/`

Read: index (079a, 079b, and 079c are sections of the index; there are no lettered child files), `qa/prd-079-durable-capture-retry-queue-qa.md`.

Recommended bucket: **completed**. Phases a, b, and c are in `src/daemon/runtime/capture/capture-outbox.ts` and wired from the capture handler, health, assemble, and `honeycomb capture drain`. a-AC-8's natural Deep Lake window was not observed; the mechanism test is present. Do not move back for that live clause.

### 079a

#### a-AC-1

- Quote: "On a capture append failure (batched `flushBatch` OR the immediate `appendOnlyInsertMany` path returning non-ok), the affected `{ row, scope }` rows are ENQUEUED into the durable `capture_outbox` instead of being dropped. A test asserts a storage stub that returns non-ok routes the rows to the outbox (outbox count grows) rather than only `recordDropped`."
- PRD: `.../prd-079-durable-capture-retry-queue-index.md:64`
- Verdict: MET
- Source: `src/daemon/runtime/capture/capture-handler.ts:391` (immediate) and `:603` / `:615` (flush) call `enqueueToOutbox` / `onAppendFailure`. Enqueue: `src/daemon/runtime/capture/capture-outbox.ts:468` (`INSERT OR IGNORE` into `capture_outbox`). Test: `tests/daemon/runtime/capture/capture-outbox.test.ts` describe `a-AC-1`.

#### a-AC-2

- Quote: "A background drainer re-attempts queued captures via `appendOnlyInsertMany` on the WRITE client; on OK the row is deleted from the outbox, on non-ok it stays with `attempts+1` and a pushed-out `next_attempt_at`. A test with a stub that fails then succeeds drains the outbox to empty across two drain ticks."
- PRD: `.../prd-079-durable-capture-retry-queue-index.md:65`
- Verdict: MET
- Source: `src/daemon/runtime/capture/capture-outbox.ts` drain accounting around `:571-623` (delete on success, retry event on failure). Test: `capture-outbox.test.ts` describe `a-AC-2`.

#### a-AC-3

- Quote: "Bounded exponential backoff (documented base + cap) between attempts; the drainer SKIPS rows whose `next_attempt_at` is in the future, so a persistent degraded window cannot hot-loop the write client. A test asserts `next_attempt_at` grows per attempt and a not-yet-due row is not attempted."
- PRD: `.../prd-079-durable-capture-retry-queue-index.md:66`
- Verdict: MET
- Source: `src/daemon/runtime/capture/capture-outbox.ts:99-101` (base 5000, cap 5 minutes). Due filter is the lease `next_attempt_at <= now` used by `leaseDue`. Test: `capture-outbox.test.ts` describe `a-AC-3`.

#### a-AC-4

- Quote: "The outbox is anchored on `honeycombStateDir()` (`~/.apiary/honeycomb/.daemon/`, PR #285), so queued captures survive a daemon stop/start and drain on the next boot regardless of launch cwd. A test enqueues, closes, reopens, and drains the persisted rows."
- PRD: `.../prd-079-durable-capture-retry-queue-index.md:67`
- Verdict: MET
- Source: `src/daemon/runtime/assemble.ts:2128-2129` (`resolveLocalQueueBaseDir` returns `honeycombStateDir()`), wired as `baseDir` at `:3179`. Test: `capture-outbox.test.ts` describe `a-AC-4`.

#### a-AC-5

- Quote: "Fail-soft: an outbox enqueue OR drain error (SQLite fault, disk full) NEVER breaks the capture path and NEVER surfaces to the hook - it is logged (`capture.outbox.enqueue_failed` / `capture.outbox.drain_failed`) and counted, not thrown into the request. A test asserts a throwing outbox stub leaves the capture ack intact."
- PRD: `.../prd-079-durable-capture-retry-queue-index.md:68`
- Verdict: MET
- Source: `src/daemon/runtime/capture/capture-outbox.ts:491` (`enqueue_failed`) and `:614` (`drain_failed`). Open failure degrades at `:367`. Test: `capture-outbox.test.ts` describe `a-AC-5`.

#### a-AC-6

- Quote: "Idempotent replay: the outbox stores the ALREADY-BUILT row with its deterministic `id` (`makeRowId`) and never mints a new id on replay; rows are enqueued ONLY on a confirmed non-ok append (the row was not written), and any rare client-timeout-that-actually-landed duplicate is deduped downstream by `source+id` at fusion. A test asserts a replayed row keeps its original id."
- PRD: `.../prd-079-durable-capture-retry-queue-index.md:69`
- Verdict: MET
- Source: `src/daemon/runtime/capture/capture-outbox.ts:36` and `:468` (`INSERT OR IGNORE` on the existing row id). Enqueue is only on the failure branches in `capture-handler.ts:391` and `:603`. Test: `capture-outbox.test.ts` describe `a-AC-6`.

#### a-AC-7

- Quote: "Observability: `/health` reports `captureOutbox { pending, retrying }` and the drainer emits secret-free `capture.outbox.{enqueued,drained,retry}` events carrying COUNTS / durations / attempt only - NO message content, token, query text, org, or scope string. A test asserts the health shape + that events carry no content/scope fields."
- PRD: `.../prd-079-durable-capture-retry-queue-index.md:70`
- Verdict: MET
- Source: events at `capture-outbox.ts:496` (`enqueued`), `:607` (`retry`), `:621` (`drained`). Health shape including the later `deadLettered` field: `src/daemon/runtime/health.ts:429-438` and `:600`. Test: `capture-outbox.test.ts` describe `a-AC-7`. `deadLettered` is the 079b addition; `pending` and `retrying` are still reported.

#### a-AC-8

- Quote: "Live acceptance (dogfood, recorded in the QA report): during an observed Deeplake degraded window, the timed-out captures land in the outbox (pending > 0), and when the backend recovers the drainer flushes them to Deeplake (pending to 0) with the memories subsequently present on recall."
- PRD: `.../prd-079-durable-capture-retry-queue-index.md:71`
- Verdict: UNVERIFIABLE
- Source: a natural hosted-backend window is ABSENT. The QA (`qa/prd-079-durable-capture-retry-queue-qa.md:35-40`) says the natural window was not observed and substitutes `tests/daemon/runtime/capture/capture-outbox-a-ac-8-mechanism.test.ts` (fault injection through the real capture route). This machine has no request log to re-check. The mechanism is in source; the named live observation is not. Do not move the PRD back on this clause alone.

### 079b

#### b-AC-1

- Quote: "A queued row that reaches `maxAttempts` failed re-appends **or** exceeds `maxAgeMs` in the outbox is moved to a terminal `dead` status (row retained, NOT deleted, NOT re-leased) so it stops consuming write slots and stops growing the active backlog - bounded growth, never a silent vanish. Config: `maxAttempts` (default 10) + `maxAgeMs` (default 24h), documented + env-overridable (`HONEYCOMB_CAPTURE_OUTBOX_*`), `amplificationConfig`-style. A test asserts a row failing `maxAttempts` times, and a row older than `maxAgeMs`, each transition `pending` to `dead` and are no longer leased by `drainDue`."
- PRD: `.../prd-079-durable-capture-retry-queue-index.md:77`
- Verdict: MET
- Source: `src/daemon/runtime/capture/capture-outbox.ts:94` (`dead`), `:124-126` (defaults 10 and 24h), `:131-133` and `:176-177` (env). `deadLetter` event at `:676`. Lease filters `status = pending` (comment at `:91`). Test: `capture-outbox.test.ts` describe `b-AC-1`.

#### b-AC-2

- Quote: "Dead-lettering emits a durable secret-free `capture.outbox.dead_lettered` event (attempt / ageMs / count only - NO content, token, org, or workspace) and surfaces a `/health` `captureOutbox.deadLettered` count. `counts()` returns `{ pending, retrying, deadLettered }` where `dead` rows are excluded from `pending`/`retrying` (terminal, not active). A test asserts the event shape carries no content/scope, the health count, and the partition."
- PRD: `.../prd-079-durable-capture-retry-queue-index.md:78`
- Verdict: MET
- Source: `capture-outbox.ts:676` (event keys `attempt`, `ageMs`, `count`). `counts()` partition at `:541-560`. Health: `src/daemon/runtime/health.ts:600`. Test: `capture-outbox.test.ts` describe `b-AC-2`.

#### b-AC-3

- Quote: "Recovery-triggered drain: the drainer is kicked IMMEDIATELY (not only on the timer) when the backend recovers, signaled by (a) the next SUCCESSFUL capture append on the write path, and/or (b) a `deeplake.woke` transition. The kick is debounced/single-flighted against the existing `draining` guard and is fail-soft (a kick failure never breaks capture). A test asserts a successful capture append triggers an immediate drain pass (a queued row drains without waiting for the full interval)."
- PRD: `.../prd-079-durable-capture-retry-queue-index.md:79`
- Verdict: MET
- Source: success kicks at `capture-handler.ts:397` and `:609`. Wake arm: `src/daemon/runtime/assemble.ts:4515-4518`. Single-flight is the `draining` guard in `drainDue` (`capture-outbox.ts:571`). Test: `capture-outbox.test.ts` describe `b-AC-3`.

#### b-AC-4

- Quote: "Operator command `honeycomb capture drain` forces one drain pass and prints the result (`drained` / `retried` / `deadLettered` counts), reusing the same daemon `drainDue` seam over the daemon HTTP surface. A test asserts the command invokes the drain and reports the counts; it is read-through fail-soft (a daemon-down / error path reports cleanly, never throws)."
- PRD: `.../prd-079-durable-capture-retry-queue-index.md:80`
- Verdict: MET
- Source: `src/commands/capture.ts:48-82`, route `src/daemon/runtime/capture/capture-drain-api.ts` (fail-soft zero counts), mounted at `src/daemon/runtime/assemble.ts:3690-3702`. Test: `tests/commands/capture.test.ts`.

#### b-AC-5

- Quote: "Fail-soft + non-regression preserved: dead-lettering, the recovery kick, and the CLI never break capture, never throw into the hot path, never leak secrets, and do not change the 079a happy path or the `pending` to `dead` accounting for a row that would otherwise still be retrying. A test asserts a `dead`-transition fault degrades to a no-op and the capture ack is unaffected."
- PRD: `.../prd-079-durable-capture-retry-queue-index.md:81`
- Verdict: MET
- Source: kick is off the ack path (`capture-handler.ts:397` after success). Dead-letter logs `drain_failed` on fault at `capture-outbox.ts:671`. Test: `capture-outbox.test.ts` describe `b-AC-5`. The 079a suite is still in the same file.

### 079c

#### c-AC-1

- Quote: "Disk/row-count cap: when the ACTIVE backlog (`pending` rows) would exceed `maxRows` (config, default 10,000; env-overridable), the OLDEST pending rows are shed (deleted) oldest-first to stay under the cap, and each shed is COUNTED + logged via a secret-free `capture.outbox.shed { count }` event - never a silent truncation. `dead` rows do not count toward the active cap. A test asserts enqueuing past the cap sheds oldest-first, bounds the backlog at `maxRows`, and logs the shed count."
- PRD: `.../prd-079-durable-capture-retry-queue-index.md:87`
- Verdict: MET
- Source: `src/daemon/runtime/capture/capture-outbox.ts:116-119` (default 10000) and `:531` (`capture.outbox.shed`). Env: `:135`. Test: `capture-outbox.test.ts` describe `c-AC-1`.

#### c-AC-2

- Quote: "Coalesced drain: on a drain pass, due rows sharing BOTH a scope AND an identical column signature are coalesced into ONE multi-row `appendOnlyInsertMany` (mirrors the flush batcher), minimizing write ops on recovery. Rows with heterogeneous column shapes (e.g. assistant turns carrying `usage` columns vs user turns) are grouped SEPARATELY so `buildInsertMany`'s same-columns assertion never rejects a batch. On a coalesced append failure, EACH row in the group is failed independently (attempts+1 + backoff per row), never lost. A test asserts N same-scope/same-shape rows drain in one append, heterogeneous shapes split into separate appends, and a failed group backs off every member."
- PRD: `.../prd-079-durable-capture-retry-queue-index.md:88`
- Verdict: MET
- Source: grouping and per-member backoff live in `capture-outbox.ts` drain (`:571-623` tallies `drained` / `retried` / `deadLettered` per member). Test: `capture-outbox.test.ts` describe `c-AC-2`, including the per-member dead-letter case.

#### c-AC-3

- Quote: "Back-pressure: a `maxDrainPerInterval` knob (config, default e.g. 200) bounds how many rows one drain pass will attempt, so a huge backlog drains at a bounded rate rather than bursting the write client (`Semaphore(3)`). The remainder is left due for the next pass. A test asserts a backlog larger than the cap attempts at most `maxDrainPerInterval` rows in one pass and the rest remain pending."
- PRD: `.../prd-079-durable-capture-retry-queue-index.md:89`
- Verdict: MET
- Source: `src/daemon/runtime/capture/capture-outbox.ts:108` (default 200) and lease `LIMIT` at `:772`. Env: `:137`. Test: `capture-outbox.test.ts` describe `c-AC-3`.

#### c-AC-4

- Quote: "Fail-soft + observability preserved: the cap/shed, coalescing, and back-pressure paths are all secret-free, never break capture, and never throw into the hot path; `/health` continues to report an honest `{ pending, retrying, deadLettered }` under load. A test asserts a fault in any of the three paths degrades to the pre-079c behavior without surfacing."
- PRD: `.../prd-079-durable-capture-retry-queue-index.md:90`
- Verdict: MET
- Source: shed failure event `capture-outbox.ts:534` (`shed_failed`). Health partition `health.ts:600`. Test: `capture-outbox.test.ts` describe `c-AC-4`.

---

## PRD-080 Durable controlled-write outbox

Folder: `library/requirements/completed/prd-080-durable-controlled-write-outbox/`

Read: index (080a, 080b, and 080c are sections of the index; there are no lettered child files), `qa/prd-080-durable-controlled-write-outbox-qa.md`.

Recommended bucket: **completed**. The sibling `memory_outbox` table, `deferred` ack, drainer, dead-letter, re-drive, cap, and coalesced commit are in source. a-AC-8's natural window was not observed. The QA warning about `committedSinceBoot` is closed in source (`onCommitted` wired to `memoryFormation.record`). Do not move back for the live clause.

### 080a

#### a-AC-1

- Quote: "On a controlled-write commit failure classified **transient** (`isTransientResult`) - at EITHER the dedup-probe branch or the version-bumped INSERT branch - the resolved write (`{ action, row, scope }`) is ENQUEUED into the durable `memory_outbox` and the stage returns a `deferred` action instead of throwing. A test asserts a transient-failing storage stub routes the write to the outbox (pending grows) and the job does NOT throw / does NOT exhaust attempts."
- PRD: `.../prd-080-durable-controlled-write-outbox-index.md:61`
- Verdict: MET
- Source: gate `src/daemon/storage/client.ts:371` (`isTransientResult`), used at `src/daemon/runtime/pipeline/controlled-writes.ts:715` and `:759-764`. `deferOrThrow` at `:909-922` enqueues and returns `{ action: "deferred" }`. Table: `src/daemon/runtime/pipeline/memory-outbox.ts:91`. Test: `tests/daemon/runtime/pipeline/memory-outbox.test.ts`.

#### a-AC-2

- Quote: "A **genuine non-transient** failure (permission / syntax / a non-transient `query_error`) STILL throws exactly as today - never enqueued, never a `deferred` ack, never an unguarded duplicate insert. A test asserts a non-transient stub still throws with no outbox row."
- PRD: `.../prd-080-durable-controlled-write-outbox-index.md:62`
- Verdict: MET
- Source: `controlled-writes.ts:764` returns `genuine` when `isTransientResult` is false, and `deferOrThrow` is the transient arm only. Throw fallback at `:930`. Test: `tests/daemon/runtime/pipeline/memory-outbox.test.ts`.

#### a-AC-3

- Quote: "A background drainer re-executes each queued write on the WRITE client: ADD re-runs the dedup-probe-then-append (a memory a prior attempt landed to `deduped`, no duplicate - idempotent via `content_hash`); UPDATE/DELETE re-runs the version-bumped write. OK/deduped to delete the row; transient-fail to `attempts+1` + pushed `next_attempt_at`. A test with a fail-then-recover stub drains to empty across two ticks and asserts NO duplicate `memories` INSERT on replay of an already-landed row."
- PRD: `.../prd-080-durable-controlled-write-outbox-index.md:63`
- Verdict: MET
- Source: drainer in `src/daemon/runtime/pipeline/memory-outbox.ts` (`drainDue` around `:534-564`) calls the shared commit in `controlled-writes.ts`. Hash read: `controlled-writes.ts:882-883`. Test: `tests/daemon/runtime/pipeline/memory-outbox.test.ts`.

#### a-AC-4

- Quote: "Bounded exponential backoff (documented base + cap); the drainer skips rows whose `next_attempt_at` is future - no hot-loop on a persistent window. A test asserts backoff growth + due-skip."
- PRD: `.../prd-080-durable-controlled-write-outbox-index.md:64`
- Verdict: MET
- Source: `src/daemon/runtime/pipeline/memory-outbox.ts:106-108` (base 5000, cap 5 minutes). Test: `memory-outbox.test.ts`.

#### a-AC-5

- Quote: "The outbox is anchored on `honeycombStateDir()` (`~/.apiary/honeycomb/.daemon/local-queue.db`, PR #285), a `memory_outbox` table beside `capture_outbox`, so queued writes survive a daemon stop/start and drain on the next boot. A test enqueues, closes, reopens, and drains the persisted row."
- PRD: `.../prd-080-durable-controlled-write-outbox-index.md:65`
- Verdict: MET
- Source: `MEMORY_OUTBOX_TABLE` at `memory-outbox.ts:91`. `baseDir: resolveLocalQueueBaseDir()` at `src/daemon/runtime/assemble.ts:3262`, and `resolveLocalQueueBaseDir` is `honeycombStateDir()` at `:2128-2129`. Test: `memory-outbox.test.ts`.

#### a-AC-6

- Quote: "Fail-soft: an outbox enqueue OR drain fault NEVER breaks the pipeline stage and NEVER surfaces as an unhandled rejection - it is logged (`memory.outbox.enqueue_failed` / `drain_failed`) + counted. On an enqueue fault the stage falls back to the pre-080 throw (the write is not silently lost-and-forgotten). A test asserts a throwing outbox stub degrades cleanly."
- PRD: `.../prd-080-durable-controlled-write-outbox-index.md:66`
- Verdict: MET
- Source: `memory-outbox.ts:454` (`enqueue_failed`) and `:555` (`drain_failed`). `deferOrThrow` catch at `controlled-writes.ts:924-930` logs and then throws the pre-080 error. Test: `memory-outbox.test.ts`.

#### a-AC-7

- Quote: "Observability: `/health` reports `memoryOutbox { pending, retrying }` and the drainer emits secret-free `memory.outbox.{enqueued,drained,retry}` events carrying COUNTS / durations / attempt / action-class ONLY - NO memory content, `content_hash`, query text, org, or workspace (the PR #293 redaction posture). A test asserts the health shape + that events carry no content/hash/scope."
- PRD: `.../prd-080-durable-controlled-write-outbox-index.md:67`
- Verdict: MET
- Source: events `memory-outbox.ts:459` (`enqueued` count), `:562` (`drained` count and durationMs), `:658` (`retry` attempt). Health: `src/daemon/runtime/health.ts:441-450` and `:613`. Test: `memory-outbox.test.ts`.

#### a-AC-8

- Quote: "Live acceptance (dogfood, QA report): during an observed Deeplake degraded window, a distilled controlled-write lands in `memory_outbox` (pending > 0), and when the backend recovers the drainer commits it (pending to 0) with the `memories` row subsequently present + recallable - and `memoryFormation.committedSinceBoot` climbs through the window (the register's Verify criteria)."
- PRD: `.../prd-080-durable-controlled-write-outbox-index.md:68`
- Verdict: UNVERIFIABLE
- Source: a natural window is ABSENT. QA `qa/prd-080-durable-controlled-write-outbox-qa.md:96-103` grades VERIFIED-by-mechanism via `tests/daemon/runtime/pipeline/memory-outbox-mechanism.test.ts` and says the natural window is a post-merge dogfood. The `committedSinceBoot` gap named in that QA is now wired: `memory-outbox.ts:626-635` calls `onCommitted`, and `assemble.ts:3271` points it at `memoryFormation.record`. Do not move the PRD back on the missing natural-window observation.

### 080b

#### b-AC-1

- Quote: "A queued write reaching `maxAttempts` (default 10) OR `maxAgeMs` (default 24h) moves to terminal `dead` (retained, not re-leased), env-overridable (`HONEYCOMB_MEMORY_OUTBOX_*`). Test: a permanently-failing write to `dead`, no longer leased."
- PRD: `.../prd-080-durable-controlled-write-outbox-index.md:75`
- Verdict: MET
- Source: `src/daemon/runtime/pipeline/memory-outbox.ts:101` (`dead`), `:130-132` (defaults), `:137-139` (env). `dead_lettered` at `:743`. Test: `memory-outbox.test.ts`.

#### b-AC-2

- Quote: "Dead-lettering emits secret-free `memory.outbox.dead_lettered { attempt, ageMs, count }` and `/health memoryOutbox.deadLettered`; `counts()` to `{ pending, retrying, deadLettered }` (dead excluded from active). Test: event shape + counts partition."
- PRD: `.../prd-080-durable-controlled-write-outbox-index.md:76`
- Verdict: MET
- Source: `memory-outbox.ts:743` and counts at `:504-523`. Health `deadLettered` at `health.ts:613`. Test: `memory-outbox.test.ts`.

#### b-AC-3

- Quote: "Recovery-triggered drain kicked on the next SUCCESSFUL pipeline `memories` write and/or a `deeplake.woke` transition, single-flighted + fail-soft (mirrors 079b). Test: a landing controlled-write kicks an immediate drain (a queued row clears without the full interval)."
- PRD: `.../prd-080-durable-controlled-write-outbox-index.md:77`
- Verdict: MET
- Source: `kickMemoryOutboxDrain` at `controlled-writes.ts:934-939`. Wake arm: `src/daemon/runtime/assemble.ts:4535-4536`. Single-flight: `memory-outbox.ts:534` (`this.draining`). Test: `memory-outbox.test.ts`.

#### b-AC-4

- Quote: "**Re-drive:** `honeycomb memory redrive` (operator command + a daemon route) reads the terminal `memory_controlled_write` jobs from `local-queue.db`, re-enqueues their resolved writes into `memory_outbox`, and reports counts - recovering the ~101 already-dropped memories. Idempotent (content_hash dedup on replay). Read-through fail-soft. Test: seeded terminal jobs to re-enqueued to drained to memories present, no duplicates."
- PRD: `.../prd-080-durable-controlled-write-outbox-index.md:78`
- Verdict: MET
- Source: `src/commands/memory.ts:278-302`, reader `src/daemon/runtime/pipeline/memory-redrive.ts`, route mounted at `assemble.ts:3706-3744` with `readTerminalControlledWriteJobs`. Replay dedup is the same `content_hash` probe as a-AC-3. Test: `tests/daemon/runtime/pipeline/memory-redrive.test.ts` and `tests/commands/memory-redrive.test.ts`.

#### b-AC-5

- Quote: "Fail-soft + non-regression: dead-letter, the kick, and the re-drive never break the pipeline, never leak secrets, and leave the 080a happy path + the genuine-failure throw unchanged. Test."
- PRD: `.../prd-080-durable-controlled-write-outbox-index.md:79`
- Verdict: MET
- Source: kick wrapper is documented fail-soft at `controlled-writes.ts:934-939`. Genuine throw remains `deferOrThrow`'s final `throw` at `:930` for non-deferred paths. Test: `memory-outbox.test.ts`.

### 080c

#### c-AC-1

- Quote: "`maxRows` cap (default 10k): oldest-first shed of pending rows over the cap, each shed COUNTED via `memory.outbox.shed { count }` - never silent; `dead` excluded from the cap. Test."
- PRD: `.../prd-080-durable-controlled-write-outbox-index.md:84`
- Verdict: MET
- Source: `src/daemon/runtime/pipeline/memory-outbox.ts:123-127` (default 10000) and `:494` (`memory.outbox.shed`). Test: `memory-outbox.test.ts`.

#### c-AC-2

- Quote: "Coalesced drain: due rows sharing scope + column signature to one multi-row version-bumped append (reuses 079c's `groupDue`/`groupKey`); heterogeneous shapes split; a failed group backs off / dead-letters EACH member independently - no write lost or double-committed. Test."
- PRD: `.../prd-080-durable-controlled-write-outbox-index.md:85`
- Verdict: MET
- Source: `groupDue` at `memory-outbox.ts` (coalesce by scope, action, and column signature) and per-member settle on failure. Batched probe: `buildDedupCheckManySql` used by `commitControlledWriteMany` in `controlled-writes.ts` (around `:777` per the QA trace; the function is the shared commit). Test: `memory-outbox.test.ts`.

#### c-AC-3

- Quote: "Back-pressure `maxDrainPerInterval` (default 200): one pass attempts at most N; remainder left due. Test."
- PRD: `.../prd-080-durable-controlled-write-outbox-index.md:86`
- Verdict: MET
- Source: `src/daemon/runtime/pipeline/memory-outbox.ts:114` (default 200) and lease `LIMIT` at `:790`. Test: `memory-outbox.test.ts`.

#### c-AC-4

- Quote: "Fail-soft + observability preserved across cap/coalesce/back-pressure; `/health` honest under load. Test."
- PRD: `.../prd-080-durable-controlled-write-outbox-index.md:87`
- Verdict: MET
- Source: shed fault event `memory-outbox.ts:497`. Health counts `health.ts:613` (`nonNegativeInt`). Test: `memory-outbox.test.ts`.

---

## Recommended actions for later waves

1. Keep all five folders in `library/requirements/completed/`. Do not move 077 back. `756bacb` only renamed it; the fast path, lane, deadlines, and renderer flag are in source.
2. Librarian status lines only: 077 index `Status: Backlog` (`prd-077-per-turn-recall-fast-path-index.md:3`) should become Completed. 075a/b/c, 076a/b/c, and 077a/b still say Draft.
3. Do not reopen 075 because the hook uses `/memory/*` instead of `DeepLakeFs`, or because `/memory/grep` is lexical-only (`src/daemon/runtime/vfs/api.ts:335-368`). Record both as known deviations.
4. Do not reopen 076 m-AC-10. The fake-VFS sentence was a sequencing fence. PRD-075 owns the live pre-tool surface.
5. Do not treat 077 m-AC-9 / b-AC-4 as unmet because the timeout is 6000 rather than 4000. ISS-022 raised it after a live abort at 4s, and the timeout test asserts 6000.
6. Leave 077 m-AC-10, 079 a-AC-8, and 080 a-AC-8 unverifiable until a recorded live window exists. Mechanism tests already cover the code path.
7. PRD-078 is in-work and out of this shard. Its ANN index is already called from `recallFast` when ready. That is additive to 077, not a 077 gap.

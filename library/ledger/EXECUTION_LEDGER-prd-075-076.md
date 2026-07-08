# Execution Ledger — PRD-075 + PRD-076 (Recall Arms)

> Orchestration: `/the-smoker`. Worktree: `C:/Users/mario/GitHub/honeycomb-recall-arms`. Branch: `feature/prd-075-076-recall-arms` (off `honeycomb` submodule `main`).
> This ledger is the single source of truth and survives context loss. Status values: `OPEN` / `IN PROGRESS` / `DONE` / `VERIFIED` / `BLOCKED`.
> `DONE` = implemented + locally verified by the implementer. `VERIFIED` = confirmed by a separate pass (close-out or fresh reviewer). Implementers never self-verify.

## Scope

- **PRD-075** — On-Demand Recall Command Surface (the model-commanded `PreToolUse` recall arm). Sub-PRDs 075a, 075b, 075c.
- **PRD-076** — Always-On Memory Recall + Claude Code Plugin Packaging (the always-on `UserPromptSubmit` arm + MCP/skill/command packaging). Sub-PRDs 076a, 076b, 076c.

Both PRDs are non-overlapping by construction (076's Non-Goals fence the `PreToolUse`/`SessionStart`-notice surface as 075's, and 075 defers the `UserPromptSubmit`/MCP surface to 076).

## Dependency map

- 075a → 075b (075b renders the `PreToolDecision` that 075a propagates).
- 075a + 075b → 075c (the awareness notice is inert until the surface is live).
- 076b → 076c (the skill + commands point at the MCP tools 076b registers).
- 076a: independent core (but shares hook-runtime files with 075a/075b, so it is sequenced AFTER them to avoid concurrent edits to `runtime.ts` / `shim.ts` / `normalize.ts` / `contracts.ts`).

## Shared-file contention (why waves are sequenced, not all-parallel)

| File | Touched by |
|---|---|
| `src/hooks/runtime.ts` | 075a, 076a |
| `src/hooks/claude-code/shim.ts` | 075b, 076a |
| `src/hooks/shared/contracts.ts` | 075a, 076a |
| `src/hooks/normalize.ts` | 075b (maybe), 076a |
| `src/hooks/shared/pre-tool-use.ts` | 075a, 075c |
| `references/claude-code/` | 075b, 076b |

Waves are ordered so no two concurrently-running bees edit the same file.

## Wave plan

| Wave | Item | Owner Bee (Stinger) | Model | Owns (file boundaries) | Depends on |
|---|---|---|---|---|---|
| 1 | 075a | typescript-node-worker-bee (`typescript-node-stinger`) | claude-sonnet-5-thinking-high | `runtime.ts` (pre-tool branch), `pre-tool-use.ts`, `contracts.ts` (vfs seam + decision), tests | — |
| 1 | 076b | harness-integration-worker-bee (`harness-integration-stinger`) | claude-opus-4-8-thinking-high | `harnesses/claude-code/.mcp.json` (or `plugin.json`), `references/claude-code/mcp-registration-schema.ts`, `tests/mcp/…` | — |
| 2 | 075b | harness-integration-worker-bee (`harness-integration-stinger`) | claude-opus-4-8-thinking-high | `claude-code/shim.ts` (pre-tool renderer), `binary.ts`, `references/claude-code/` (response oracle), tests | 075a |
| 2 | 076c | harness-integration-worker-bee (`harness-integration-stinger`) | claude-sonnet-5-thinking-high | `harnesses/claude-code/skills/`, `harnesses/claude-code/commands/`, tests | 076b |
| 3 | 076a | typescript-node-worker-bee (`typescript-node-stinger`) | claude-sonnet-5-thinking-high | `recall-renderer.ts` (new), `user-prompt-recall.ts` (new), `runtime.ts`, `shim.ts`, `normalize.ts` (event-aware), `contracts.ts`, `hooks.json`, tests | 075a, 075b (file layering) |
| 3 | 075c | typescript-node-worker-bee (`typescript-node-stinger`) | claude-sonnet-5-thinking-high | `session-start.ts` (notice), `pre-tool-use.ts` (sentinel), tests | 075a, 075b |
| Close | security | security-worker-bee (`security-stinger`) | claude-opus-4-8-thinking-high | audit whole branch | all impl DONE |
| Close | quality | quality-worker-bee (`quality-stinger`) | claude-opus-4-8-thinking-high | verify branch vs PRDs | security clean |

Wave 3 items (076a, 075c) are disjoint in files (076a: shim/runtime/normalize/contracts/hooks.json/new; 075c: session-start/pre-tool-use) so they run in parallel.

Gate for every implementation item: `npm run ci` (typecheck + jscpd dup + vitest + SQL-safety audit) passes in the worktree.

---

## AC Ledger

### PRD-075a — Live the PreToolUse Recall Path

| ID | Criterion (abridged) | Status | Owner | Evidence |
|---|---|---|---|---|
| 075a/a-AC-1 | `HookCoreDeps` gains a `vfs` seam; production deps wire the real intercept over loopback (not the fake) | VERIFIED | W1 ts-node / QA | `createDaemonVfsIntercept` in runtime.ts:553; test `pre-tool-use-recall.test.ts:74-104` proves non-fake (real loopback fetch to `/memory/cat`, no `.ops` audit trail). SEE F-2 (RULED SATISFIED): wired to `/memory/{cat,grep,ls,find}` browse routes, not `DeepLakeFs` |
| 075a/a-AC-2 | `runPreToolUse` resolves mount ops through `deps.vfs` (drop `void _deps`); recording double observes the `VfsToolOp` and its output becomes `replace.output` | VERIFIED | W1 ts-node / QA | `pre-tool-use.ts:112` (`deps.vfs ?? vfs`); recording-double test `pre-tool-use-recall.test.ts:107-153` (deps.vfs wins over param) |
| 075a/a-AC-3 | pre-tool-use dispatch returns `{ result, decision }`; `HookEventOutcome.decision` carries the `PreToolDecision` | VERIFIED | W1 ts-node / QA | `runtime.ts:380-381` returns `{result,decision}`; test `pre-tool-use-recall.test.ts:156-183` |
| 075a/a-AC-4 | Off-mount pass-through unchanged: no `deps.vfs` call, returns `allow` (throwing double never invoked for `cat /etc/hosts`) | VERIFIED | W1 ts-node / QA | throwing-double test core+runtime `pre-tool-use-recall.test.ts:185-222` |
| 075a/a-AC-5 | Fail-soft: a throwing/timing-out `vfs.resolve` is absorbed to a fail-soft result, no `replace`, turn proceeds | VERIFIED | W1 ts-node / QA | 2s AbortController `runtime.ts:497,558-559`; dispatch try/catch `runtime.ts:400-403`; test `pre-tool-use-recall.test.ts:224-285` (throw + AbortError) |
| 075a/a-AC-6 | No behavior change to session-start/session-end/capture; their outcomes never carry a decision; existing runtime tests green | VERIFIED | W1 ts-node / QA | test `pre-tool-use-recall.test.ts:287-327`; combined `npm run ci` 4645 passed on QA close-out |

### PRD-075b — Render the PreToolDecision (block-and-inject + conformance)

| ID | Criterion (abridged) | Status | Owner | Evidence |
|---|---|---|---|---|
| 075b/b-AC-1 | Real Claude Code `PreToolUse` block-and-inject contract pinned + encoded as an executable oracle under `references/claude-code/`; conformance test parses the shim output against it | VERIFIED | W2 harness / QA | `references/claude-code/pretool-response-schema.ts`; `PINNED_BLOCK_AND_INJECT_CHANNEL="deny+additionalContext"`; negative controls bite (`pretool-render.test.ts:103-124`) |
| 075b/b-AC-2 | `replace` renders to a `PreToolUse` response that (a) prevents the real tool and (b) delivers `output` to the model | VERIFIED | W2 harness / QA | `shim.ts:194-205` deny+additionalContext+reason; test `pretool-render.test.ts:133-149` (blocksTool + injectedContext) |
| 075b/b-AC-3 | `deny` → block + guidance; `rewrite` → substituted command; `allow` → untouched pass-through; each tested | VERIFIED | W2 harness / QA | `shim.ts:206-224`; render matrix `pretool-render.test.ts:158-208` |
| 075b/b-AC-4 | E2E (shim + 075a runtime, daemon vfs faked): mount `Grep` produces a response that blocks the grep and carries the faked hits | VERIFIED | W2 harness / QA | E2E test `pretool-render.test.ts:214-222` (blocksTool + injectedContext=HITS) |
| 075b/b-AC-5 | Cross-harness conformance suite stays green; a harness without the renderer is unaffected | VERIFIED | W2 harness / QA | `pretool-render.test.ts:231-256`: claude-code carries `renderPreTool`, codex does not (user-visible channel) |
| 075b/b-AC-6 | Fail-soft: absent decision / `allow` → pass-through, never a malformed block | VERIFIED | W2 harness / QA | `binary.ts:195-204`; test `pretool-render.test.ts:265-291` (vfs-threw + allow → benign `{}` ack) |

### PRD-075c — SessionStart Recall-Awareness Notice + `honeycomb recall` sentinel

| ID | Criterion (abridged) | Status | Owner | Evidence |
|---|---|---|---|---|
| 075c/c-AC-1 | `SessionStart` `additionalContext` includes the recall-awareness notice (test asserts presence) | VERIFIED | W3 ts-node / QA | `session-start.ts:239` appends `RECALL_AWARENESS_NOTICE` unconditionally; asserted in `user-prompt-recall.test.ts:358` + session-start suite |
| 075c/c-AC-2 | Existing digest/prime/first-run-notice content unchanged; notice composes via `joinBlocks` as an added block | VERIFIED | W3 ts-node / QA | `joinBlocks(noticeBlock, contextBlock, primeBlock, RECALL_AWARENESS_NOTICE)` `session-start.ts:239`; composed order asserted |
| 075c/c-AC-3 | Notice-only → carries just the notice; all-empty + notice absent → `additionalContext` omitted; never throws | VERIFIED | W3 ts-node / QA | static notice cannot throw; empty-omit path `session-start.ts:278`; FR-10 throw-absorption green |
| 075c/c-AC-4 | `honeycomb recall "<query>"` Bash op → `search` verb, query extracted, mount root as path so `onMemoryMount` passes | VERIFIED | W3 ts-node / QA | `pre-tool-use.ts:265` regex, `:274-278` sniff, `:169` path=`MEMORY_MOUNT_DISPLAY_PATH`, `:287` verb=search |
| 075c/c-AC-5 | `honeycomb recall` resolves through the same VFS intercept + blocks the real command (faked vfs → replace, no exec) | VERIFIED | W3 ts-node / QA | resolves via `deps.vfs` `pre-tool-use.ts:144`; no `node:fs`/`child_process` import in module (confirmed) |
| 075c/c-AC-6 | Raw mount `Grep`/`cat` fallback still works (regression) | VERIFIED | W3 ts-node / QA | `lowerBashVerb` `pre-tool-use.ts:286-305` keeps grep/cat/ls/find; sentinel checked first, no CLI collision |

### PRD-075 — Module-level (index)

| ID | Criterion (abridged) | Status | Owner | Evidence |
|---|---|---|---|---|
| 075/m-AC-1 | Mount-targeted read/search/list/find on `PreToolUse` resolves through the real `DeepLakeFs` (not the fake) | VERIFIED | W1/W2 / QA | **F-2 RULED SATISFIED (intent).** Real daemon-backed seam wired (`createDaemonVfsIntercept` → loopback `/memory/{cat,grep,ls,find}`, `runtime.ts:553`), NOT the fake (test `pre-tool-use-recall.test.ts:74-104`). Literal `DeepLakeFs` unbuildable (needs an unmounted raw-SQL `DaemonDispatch`; out of 075a scope); the `/memory/*` routes resolve the SAME `memory`-table content via the recall engine (`vfs/api.ts:342-400`). WARNING (follow-up): grep mount is lexical-only (embed seam not wired at the mount → `degraded:true`), so pre-tool recall is the hybrid engine's lexical floor, not full RRF — matches the documented degrade-to-lexical posture |
| 075/m-AC-2 | `PreToolDecision` propagated out of `dispatchLifecycle` to the shim renderer | VERIFIED | W1/W2 / QA | propagation `runtime.ts:380-381`; shim consumption `shim.ts:188`, `binary.ts:195` |
| 075/m-AC-3 | shim renders `replace` (block + deliver), `deny` (block + guidance), `rewrite` (harmless cmd), `allow` (pass-through) | VERIFIED | W2 / QA | `renderClaudeCodePreTool` `shim.ts:188-232`; render-matrix `pretool-render.test.ts:158-208` |
| 075/m-AC-4 | Agent recall command returns daemon hybrid hits as the tool result; real FS never touched | VERIFIED | W2 / QA | mount `Grep` E2E blocks + carries hits (`pretool-render.test.ts:214-222`); no `node:fs` in `pre-tool-use.ts`; `mentionsMount` gate `:211-230`. Hybrid-recall nuance per F-2 WARNING above (lexical floor) |
| 075/m-AC-5 | Off-mount `PreToolUse` byte-for-byte unchanged (allow, no daemon call, zero recall latency) | VERIFIED | W1 / QA | throwing-double off-mount test `pre-tool-use-recall.test.ts:185-222` (double never invoked) |
| 075/m-AC-6 | `SessionStart` appends the awareness notice; prime content otherwise unchanged; render never throws | VERIFIED | W3 / QA | `session-start.ts:239`; envelope asserted `user-prompt-recall.test.ts:358` (`RULES...\n\n${RECALL_AWARENESS_NOTICE}`); R-1 reconciled |
| 075/m-AC-7 | `honeycomb recall "<query>"` Bash form → `search` verb, arg → query | VERIFIED | W3 / QA | sentinel `pre-tool-use.ts:265,286-287`; query extraction `:181-185` |
| 075/m-AC-8 | Every recall path fail-soft: unreachable/timeout/error daemon → bounded "no memory available", never a thrown/blocked turn | VERIFIED | W2/W3 / QA | 2s abort `runtime.ts:497` + dispatch absorb `:400-403`; test `pre-tool-use-recall.test.ts:224-285` |
| 075/m-AC-9 | `UserPromptSubmit` capture stays async; `PostToolUse`/`Stop`/`SubagentStop` capture unchanged; conformance suite green | VERIFIED | W2/W3 / QA | async capture entry preserved (`shim.ts:47-55`); 076a ADDS a sync injector entry (Option A) beside it; conformance suite green in `npm run ci` |

### PRD-076a — Always-On Query-Aware Recall on `UserPromptSubmit`

| ID | Criterion (abridged) | Status | Owner | Evidence |
|---|---|---|---|---|
| 076a/a-AC-1 | `createRecallRenderer` POSTs `{ query, limit, tokenBudget, cwd }` to `/api/memories/recall`; recording fetch asserts query=prompt, cwd forwarded, bounded budget | VERIFIED | W3 ts-node / QA | `recall-renderer.ts:104-122`; POST body query/limit/tokenBudget/cwd; test `recall-renderer.test.ts` |
| 076a/a-AC-2 | Recall stamps runtime-path + session + tenancy headers (mirror `prime-renderer.ts`); signed-out degrades to `""` | VERIFIED | W3 ts-node / QA | `recall-renderer.ts:108-114,147-155`; signed-out (no org) → no tenancy headers → daemon 400 → `[]` |
| 076a/a-AC-3 | Tight `AbortController` timeout; `""` on timeout/non-200/malformed, never a throw | VERIFIED | W3 ts-node / QA | `recall-renderer.ts:55` (2.5s), `:126-137`; non-200/catch → `[]` |
| 076a/a-AC-4 | On `UserPromptSubmit`, injector returns `{ ok, additionalContext }` + `emitResponse` renders it; capture still stores the turn | VERIFIED | W3 ts-node / QA | `runtime.ts:387-393` → `runUserPromptRecall`; test `user-prompt-recall.test.ts:101-174` (injector renders, no capture call; async capture entry still POSTs) |
| 076a/a-AC-5 | `renderContext` emits `additionalContext` under `hookSpecificOutput` with `hookEventName: "UserPromptSubmit"`; session-start envelope unchanged | VERIFIED | W3 ts-node / QA | `normalize.ts:166-179`; test `user-prompt-recall.test.ts:181-216` (recall wraps; session-start flat) |
| 076a/a-AC-6 | Throttled + deduped: repeated prompt does not re-inject the same hit; nudge not every turn | VERIFIED | W3 ts-node / QA | dedupe by `ref` `user-prompt-recall.ts:112`; test `:222-266` (turn2 same hits → nothing; only new hit C injected) |
| 076a/a-AC-7 | Empty recall → at most the throttled nudge (or nothing), never an empty/malformed block | VERIFIED | W3 ts-node / QA | `user-prompt-recall.ts:125-131` (nudge only when hits.length===0, 1/5 turns); test `:272-313` |
| 076a/a-AC-8 | No session-start regression; per-turn arm never runs on `session-start`; existing session-start tests green | VERIFIED | W3 ts-node / QA | test `user-prompt-recall.test.ts:319-360` (recall counter 0 on session-start; flat envelope) |

### PRD-076b — Register the Honeycomb MCP Server in the Plugin

| ID | Criterion (abridged) | Status | Owner | Evidence |
|---|---|---|---|---|
| 076b/b-AC-1 | Plugin MCP-registration mechanism pinned vs references gate + encoded as an oracle under `references/claude-code/` | VERIFIED | W1 harness / QA | `references/claude-code/mcp-registration-schema.ts`; oracle bites (`claude-code-registration.test.ts:83-102`) |
| 076b/b-AC-2 | Plugin registers a `honeycomb` MCP server pointing at built `mcp/bundle/server.js` (mirrors hermes shape + its conformance test) | VERIFIED | W1 harness / QA | `harnesses/claude-code/.mcp.json` stdio server `honeycomb`, `env:{}`; test `:107-125` |
| 076b/b-AC-3 | Registration `args` path resolves relative to installed plugin root (`${CLAUDE_PLUGIN_ROOT}` or plugin-relative), install-safe | VERIFIED | W1 harness / QA | `${CLAUDE_PLUGIN_ROOT}/mcp/bundle/server.js`; `isInstallSafePluginPath` rejects `../`/absolute/repo-relative (test `:130-158`). SEE F-1 (release gate) below |
| 076b/b-AC-4 | Launched server lists the existing `TOOL_NAMES` unchanged (no tools added/removed) | VERIFIED | W1 harness / QA | static parity vs `mcp/src/tools.ts` (19-tool surface, test `:163-181`); no `mcp/src` change |
| 076b/b-AC-5 | `plugin.json` + hooks bundle otherwise unchanged (7 lifecycle events still register); registration is additive | VERIFIED | W1 harness / QA | `hooks.json` conforms to `hooks-schema.ts`; no inline `mcpServers` (test `:186-218`) |
| 076b/b-AC-6 | If manifest version single-sourced, registration stays version-consistent (no drift) | VERIFIED | W1 harness / QA | `.mcp.json` carries no version; manifests match root package.json 0.6.1 (test `:223-245`) |

### PRD-076c — Bundle a Memory Skill + Slash Commands

| ID | Criterion (abridged) | Status | Owner | Evidence |
|---|---|---|---|---|
| 076c/c-AC-1 | `honeycomb-memory` skill bundled with valid frontmatter + a description targeting memory-relevant work | VERIFIED | W2 harness / QA | `skills/honeycomb-memory/SKILL.md` (name + memory-targeting description); test `claude-code-skills-commands.test.ts:64-94` (oracle bites) |
| 076c/c-AC-2 | Skill body instructs search-before-task (`hivemind_search`/`memory_search`), cite + zoom (`hivemind_read`), store-with-type (`memory_store`) | VERIFIED | W2 harness / QA | SKILL.md §1-3 names all tools + closed taxonomy; test `:101-126` (each tool ∈ `TOOL_NAMES`) |
| 076c/c-AC-3 | `/recall`, `/remember`, `/forget` commands bundled with valid frontmatter | VERIFIED | W2 harness / QA | `commands/{recall,remember,forget}.md`; test `:134-176` |
| 076c/c-AC-4 | `/forget` collects a `reason` (`memory_forget` requires one) | VERIFIED | W2 harness / QA | `forget.md` args `[path, reason]` + `disable-model-invocation:true`, body refuses without reason; test `:180+` |
| 076c/c-AC-5 | Skill + commands in plugin-contract-correct dirs (confirmed vs references gate) so the loader discovers them | VERIFIED | W2 harness / QA | oracle `references/claude-code/plugin-skills-commands-schema.ts`; nested-command rejection test `:172-175` |
| 076c/c-AC-6 | Additive: `plugin.json`, hooks, and 076b registration unchanged by this sub-PRD | VERIFIED | W2 harness / QA | hooks + `.mcp.json` conform; `plugin.json` untouched (skills/commands auto-discovered) |

### PRD-076 — Module-level (index)

| ID | Criterion (abridged) | Status | Owner | Evidence |
|---|---|---|---|---|
| 076/m-AC-1 | First `UserPromptSubmit` POSTs prompt to `/api/memories/recall` (bounded budget + cwd); top hits injected synchronously | VERIFIED | W3 / QA | `recall-renderer.ts:104-122` + `runtime.ts:387-393`; test `user-prompt-recall.test.ts:101-126` |
| 076/m-AC-2 | Sync recall stamps runtime-path + session + tenancy; missing-session not sent bare | VERIFIED | W3 / QA | `recall-renderer.ts:108-114,147-155` |
| 076/m-AC-3 | Tight timeout + fail-soft `""` on timeout/non-200/malformed; never a thrown/blocked turn | VERIFIED | W3 / QA | `recall-renderer.ts:55,126-137`; `renderSoft` `user-prompt-recall.ts:176-185` |
| 076/m-AC-4 | Existing `UserPromptSubmit` capture still happens (turn stored) | VERIFIED | W3 / QA | Option A: recall map `shim.ts:65-67`, capture map `:47-55`; test `user-prompt-recall.test.ts:144-165` |
| 076/m-AC-5 | `renderContext` per-event envelope (`hookSpecificOutput.hookEventName`) for both `SessionStart` + `UserPromptSubmit` | VERIFIED | W3 / QA | `normalize.ts:166-179`; test `user-prompt-recall.test.ts:181-216` |
| 076/m-AC-6 | Per-turn injection throttled + deduped (no double-inject; per-turn budget) | VERIFIED | W3 / QA | `user-prompt-recall.ts:112-131`; test `:222-266` |
| 076/m-AC-7 | Plugin registers the MCP server so `memory_search`/`hivemind_search`/`hivemind_read`/`memory_store` appear in the tool list | VERIFIED | W1 / QA | Registration artifact correct + install-safe + tested (076b b-AC-1..6 all VERIFIED). **F-1 RULED: ACCEPTABLE FOLLOW-UP / RELEASE GATE (WARNING).** The `.mcp.json` points at `${CLAUDE_PLUGIN_ROOT}/mcp/bundle/server.js`, but esbuild emits the MCP bundle to repo-root `mcp/bundle` (`esbuild.config.mjs:301`) with no copy into `harnesses/claude-code/mcp/bundle/`, and the npm `files` allowlist omits it. So a REAL installed plugin cannot launch the server until ci-release ships the bundle inside the plugin tree. Does not fail any 076b AC as written; owned by ci-release, out of 076b file scope. MUST close before publishing the plugin |
| 076/m-AC-8 | `honeycomb-memory` skill bundled, valid frontmatter, discoverable | VERIFIED | W2 / QA | via 076c; `skills/honeycomb-memory/SKILL.md` under plugin root (ships via marketplace source dir) |
| 076/m-AC-9 | `/recall`/`/remember`/`/forget` commands bundled with valid frontmatter | VERIFIED | W2 / QA | via 076c; `commands/{recall,remember,forget}.md` |
| 076/m-AC-10 | No PRD-075 surface touched by 076 (pre-tool path, session-start unchanged by 076a) | VERIFIED | W3 / QA | 076a did not touch `pre-tool-use.ts`; session-start byte-identical (test `user-prompt-recall.test.ts:319-360`). F-3 REVIEWED: additive optional `ContextEnvelope.hookSpecificOutput?` (`contracts.ts:79-88`) is back-compat (session-start omits it); not a boundary violation |

---

## Wave log

- **Setup (done):** submodule worktree created off `main`; PRD-075 (tracked) + PRD-076 (untracked, carried over) moved backlog → in-work; `main` working tree restored clean; `npm install` OK; ledger created.
- **Wave 1:** COMPLETE. 076b DONE + merged (f216748). 075a DONE + merged (d8628c4). Combined `npm run ci` on feature branch: 427 files, 4553 passed, 12 skipped, SQL-safety OK. Wave-1 worktrees removed.
- **Wave 2:** 076c DONE + merged (`npm run ci` 4584 passed; all-new files; `plugin.json` untouched via auto-discovery). 075b in progress. Note: 076c flagged two PRE-EXISTING flaky tests (`assemble.test.ts` timeout, `secrets/exec.test.ts` timing) that flake under full-suite CPU contention but pass in isolation, not caused by this work; give combined CI one retry on those per the-smoker flake rule.
- **Wave 2:** COMPLETE. 075b DONE + merged (cd72728); 076c DONE + merged. Combined `npm run ci` (075a+076b+076c+075b): 429 files, 4599 passed, 12 skipped, SQL-safety OK, no flakes. Aikido scan on 075b: 0 findings. Wave-2 worktrees removed.
- **Wave 3:** COMPLETE. 076a DONE + merged (6c7054c); 075c DONE + merged (d9308de). R-1 reconciled (fd6e1d6): 13 session-start assertions in `hook-runtime.test.ts` (12) + `user-prompt-recall.test.ts` (1) now reference the imported `RECALL_AWARENESS_NOTICE`. Final combined `npm run ci`: 432 files, 4645 passed, 12 skipped, SQL-safety OK. Wave-3 worktrees removed.
- **ALL IMPLEMENTATION ACs DONE** (075: 6 module + a/b/c; 076: 10 module + a/b/c). Pending: separate-pass VERIFICATION via close-out.
- **Close-out (security):** COMPLETE. security-worker-bee ran first, clean — 1 Medium fixed in place (recall-sessions state file 0700/0600), 0 Crit/High. Report: `prd-076-.../reports/2026-07-08-security-audit.md`.
- **Close-out (quality):** COMPLETE (this pass). quality-worker-bee verified all 54 ACs against the merged code + tests; `npm run ci` GREEN (432 files, 4645 passed, 13 skipped, SQL-safety OK). All ACs DONE→**VERIFIED** (incl. 075/m-AC-1 OPEN→VERIFIED). Test hygiene clean: no `.skip`/`.only` on branch, tests named per-AC, oracle negative-controls bite. **F-2 RULED SATISFIED** (real daemon-backed `/memory/*` seam meets m-AC-1/m-AC-4 intent; lexical-floor nuance is a Warning follow-up). **F-1 RULED ACCEPTABLE FOLLOW-UP / RELEASE GATE** (MCP bundle must ship inside the plugin tree before the plugin is published; owned by ci-release; blocks no 076b AC as written). **F-3 REVIEWED** (additive/back-compat, no concern). No AC reopened. Reports: `prd-075-.../reports/2026-07-08-qa-report.md`, `prd-076-.../reports/2026-07-08-qa-report.md`.

## Follow-ups / handoffs

- **F-2 (architecture, from 075a — quality review must reconcile):** the PRD names `DeepLakeFs` (`src/daemon-client/vfs/fs.ts`) as the real VFS seam, but wiring it needs a raw-SQL `DaemonDispatch` daemon endpoint that does not exist (its CONVENTIONS.md lists it deferred). 075a instead wired the real seam to the already-mounted `/memory/{cat,grep,ls,find}` browse routes (`src/daemon/runtime/vfs/api.ts`, PRD-022b) over loopback, same `memory`-table content, no new daemon endpoint, no cross-boundary edit. Documented, tested, `ci` green. Quality-worker-bee must confirm this satisfies 075/m-AC-1 + 075/m-AC-4 intent (real daemon-backed recall) despite deviating from the literal `DeepLakeFs` naming.
  - **QA RULING (2026-07-08): SATISFIED.** The intent of m-AC-1/m-AC-4 (real daemon-backed recall reaches the model; the real FS is never touched; not the fake) is met: `createDaemonVfsIntercept` (`runtime.ts:553`) resolves over loopback to the daemon's `/memory/*` routes, which read the SAME `memory`/`memories` content through the PRD-007 recall engine's collection layer (`vfs/api.ts:342-400`); the fake is proven never to reach production deps (`pre-tool-use-recall.test.ts:74-104`); `pre-tool-use.ts` imports no `node:fs`/`child_process` and the `mentionsMount` gate holds. The literal `DeepLakeFs` deviation is justified and out of 075a's file scope. **WARNING (follow-up, non-blocking):** the `/memory/grep` mount runs the recall engine WITHOUT an embed client, so the vector channel is skipped (`degraded:true`) and pre-tool recall is the hybrid engine's lexical floor, not full RRF. This matches the product's documented degrade-to-lexical posture and `vfs/api.ts:339-340`'s own "a follow-up wires the embed seam for semantic browse" note. Wire the embed seam into the VFS grep mount in a follow-up so the on-demand arm matches the always-on arm's (076a `/api/memories/recall`) semantic depth.
- **F-3 (quality review, from 076a):** 076a made one additive change beyond its explicit MODIFY list, an optional `hookSpecificOutput?` field on the model-only `ContextEnvelope` in `src/hooks/contracts.ts` (the harness contracts, distinct from `src/hooks/shared/contracts.ts`), required to emit the per-event envelope type-safely. Additive + back-compat (session-start omits it, stays byte-identical). Flag for quality-worker-bee awareness; not a boundary violation of concern.
  - **QA RULING (2026-07-08): NO CONCERN (Suggestion/Note).** Confirmed additive + back-compat at `contracts.ts:79-88`: the field is optional; session-start emits the flat `{ channel, additionalContext }` envelope byte-identical to before (proven by `user-prompt-recall.test.ts:193-199,352-359`). It is the minimal, correct way to type the per-event envelope. No AC affected.
- **F-1 (ci-release, from 076b):** the install-safe registration path `${CLAUDE_PLUGIN_ROOT}/mcp/bundle/server.js` requires the MCP bundle to physically ship INSIDE the plugin tree (`harnesses/claude-code/mcp/bundle/`). Today `mcp/bundle/server.js` builds to the repo root (gitignored, reaches the tarball via the `files` allowlist). The registration artifact + contract are correct as authored; the build-time bundle placement (esbuild output location + packaging) is a `ci-release` task, out of 076b's file ownership. Dispatch a `ci-release-worker-bee` before ship, or fold into close-out. Does not fail any 076b AC as written.
  - **QA RULING (2026-07-08): ACCEPTABLE FOLLOW-UP / RELEASE GATE (WARNING). CONFIRMED REAL.** Verified: `esbuild.config.mjs:301` emits the MCP bundle to repo-root `mcp/bundle` only; `harnesses/claude-code/mcp/` does not exist; the npm `files` allowlist lists `mcp/bundle` but NOT `harnesses/claude-code/mcp/bundle`. Since Claude Code does not copy files outside the plugin root (source `./harnesses/claude-code`), an installed plugin's `${CLAUDE_PLUGIN_ROOT}/mcp/bundle/server.js` will NOT resolve → the MCP tools would not appear in a real session. This does NOT fail any 076b sub-AC (all met + tested against the artifact/contract, which are correct) and is outside 076b's file ownership, so no AC is reopened. It IS a must-close release gate for m-AC-7's end-to-end intent. **Recommended remediation (ci-release):** (1) in `esbuild.config.mjs` add a copy of the built `mcp/bundle/server.js` (+ ESM `package.json` stamp) into `harnesses/claude-code/mcp/bundle/`; (2) add `harnesses/claude-code/mcp/bundle` to the `files` allowlist in `package.json`; (3) extend `pack:check`/a distribution test to assert the plugin-internal bundle is present. NOTE: 076b's `.mcp.json` and 076c's `skills/`/`commands/` DO ship via the marketplace source dir (they live under the plugin root), so only the repo-root `mcp/bundle` is affected.

## Merge-time reconciliations

- **R-1 (075c x 076a, MERGE-TIME):** 075c makes `RECALL_AWARENESS_NOTICE` an unconditional part of session-start `additionalContext`. This breaks 12 exact-string assertions in `tests/hooks/runtime/hook-runtime.test.ts` (owned by 076a's runtime scope, not touched by 075c). Neither isolated worktree shows the failure (075c's ci fails there but it correctly deferred; 076a's tree has no notice). AFTER merging BOTH 075c and 076a, append `\n\n${RECALL_AWARENESS_NOTICE}` to the expected session-start strings (075c cited lines 104,162,195,212,228,269,291,314,341,391,532,578 in the pre-076a tree; fix by CONTENT since 076a shifts line numbers). Mechanical, no logic change. Then run combined `npm run ci` to confirm green.

## Watchdog / termination log

- W1 watchdogs: 076b committed within ~6-10 min (healthy). 075a produced no commits/working-tree changes through ~10 min; tight watchdog armed to terminate + decompose if still empty.

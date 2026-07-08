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
| 075a/a-AC-1 | `HookCoreDeps` gains a `vfs` seam; production deps wire the real intercept over loopback (not the fake) | DONE | W1 ts-node | `createDaemonVfsIntercept` in runtime.ts; test proves non-fake (real loopback fetch). SEE F-2: wired to `/memory/{cat,grep,ls,find}` browse routes, not `DeepLakeFs` |
| 075a/a-AC-2 | `runPreToolUse` resolves mount ops through `deps.vfs` (drop `void _deps`); recording double observes the `VfsToolOp` and its output becomes `replace.output` | DONE | W1 ts-node | commit ba1f832; recording-double test |
| 075a/a-AC-3 | pre-tool-use dispatch returns `{ result, decision }`; `HookEventOutcome.decision` carries the `PreToolDecision` | DONE | W1 ts-node | dispatch branch returns decision end-to-end |
| 075a/a-AC-4 | Off-mount pass-through unchanged: no `deps.vfs` call, returns `allow` (throwing double never invoked for `cat /etc/hosts`) | DONE | W1 ts-node | throwing-double test at core + runtime level |
| 075a/a-AC-5 | Fail-soft: a throwing/timing-out `vfs.resolve` is absorbed to a fail-soft result, no `replace`, turn proceeds | DONE | W1 ts-node | ~2s AbortController in runtime construction site; absorbed by dispatch try/catch |
| 075a/a-AC-6 | No behavior change to session-start/session-end/capture; their outcomes never carry a decision; existing runtime tests green | DONE | W1 ts-node | combined `npm run ci` 4553 passed on feature branch |

### PRD-075b — Render the PreToolDecision (block-and-inject + conformance)

| ID | Criterion (abridged) | Status | Owner | Evidence |
|---|---|---|---|---|
| 075b/b-AC-1 | Real Claude Code `PreToolUse` block-and-inject contract pinned + encoded as an executable oracle under `references/claude-code/`; conformance test parses the shim output against it | DONE | W2 harness | `references/claude-code/pretool-response-schema.ts`; channel `deny+additionalContext` pinned vs 2026 docs (PreToolUse additionalContext, v2.1.9 #15664); negative controls bite. commit e4e116b |
| 075b/b-AC-2 | `replace` renders to a `PreToolUse` response that (a) prevents the real tool and (b) delivers `output` to the model | DONE | W2 harness | `permissionDecision: "deny"` + `hookSpecificOutput.additionalContext`; serialized-stdout test |
| 075b/b-AC-3 | `deny` → block + guidance; `rewrite` → substituted command; `allow` → untouched pass-through; each tested | DONE | W2 harness | deny→reason=guidance; rewrite→allow+updatedInput.command; allow→`{}`; render matrix |
| 075b/b-AC-4 | E2E (shim + 075a runtime, daemon vfs faked): mount `Grep` produces a response that blocks the grep and carries the faked hits | DONE | W2 harness | E2E test: blocksTool + injectedContext |
| 075b/b-AC-5 | Cross-harness conformance suite stays green; a harness without the renderer is unaffected | DONE | W2 harness | only claude-code carries `renderPreTool`; codex unaffected; suite green |
| 075b/b-AC-6 | Fail-soft: absent decision / `allow` → pass-through, never a malformed block | DONE | W2 harness | absent decision + allow → benign `{}` ack |

### PRD-075c — SessionStart Recall-Awareness Notice + `honeycomb recall` sentinel

| ID | Criterion (abridged) | Status | Owner | Evidence |
|---|---|---|---|---|
| 075c/c-AC-1 | `SessionStart` `additionalContext` includes the recall-awareness notice (test asserts presence) | DONE | W3 ts-node | `RECALL_AWARENESS_NOTICE` appended unconditionally; commit fba71b8 |
| 075c/c-AC-2 | Existing digest/prime/first-run-notice content unchanged; notice composes via `joinBlocks` as an added block | DONE | W3 ts-node | `joinBlocks` variadic; exact composed order asserted |
| 075c/c-AC-3 | Notice-only → carries just the notice; all-empty + notice absent → `additionalContext` omitted; never throws | DONE | W3 ts-node | verified vs real `runSessionStart` + `joinBlocks`; FR-10 throw-absorption green |
| 075c/c-AC-4 | `honeycomb recall "<query>"` Bash op → `search` verb, query extracted, mount root as path so `onMemoryMount` passes | DONE | W3 ts-node | `HONEYCOMB_RECALL_SENTINEL` + `sniffHoneycombRecallSentinel`; path = `MEMORY_MOUNT_DISPLAY_PATH` |
| 075c/c-AC-5 | `honeycomb recall` resolves through the same VFS intercept + blocks the real command (faked vfs → replace, no exec) | DONE | W3 ts-node | faked vfs: replace + exactly one op; no `node:fs`/`child_process` import |
| 075c/c-AC-6 | Raw mount `Grep`/`cat` fallback still works (regression) | DONE | W3 ts-node | fallbacks re-verified; `honeycomb project bind` not mis-captured (no CLI collision) |

### PRD-075 — Module-level (index)

| ID | Criterion (abridged) | Status | Owner | Evidence |
|---|---|---|---|---|
| 075/m-AC-1 | Mount-targeted read/search/list/find on `PreToolUse` resolves through the real `DeepLakeFs` (not the fake) | OPEN | W1/W2 | |
| 075/m-AC-2 | `PreToolDecision` propagated out of `dispatchLifecycle` to the shim renderer | DONE | W1/W2 | propagation DONE by 075a (ba1f832); shim consumption is 075b |
| 075/m-AC-3 | shim renders `replace` (block + deliver), `deny` (block + guidance), `rewrite` (harmless cmd), `allow` (pass-through) | DONE | W2 | 075b renderer + render-matrix tests |
| 075/m-AC-4 | Agent recall command returns daemon hybrid hits as the tool result; real FS never touched | DONE | W2 | mount `Grep` E2E (075a+075b) blocks + carries hits; sentinel variant is m-AC-7 (075c) |
| 075/m-AC-5 | Off-mount `PreToolUse` byte-for-byte unchanged (allow, no daemon call, zero recall latency) | DONE | W1 | 075a throwing-double off-mount test |
| 075/m-AC-6 | `SessionStart` appends the awareness notice; prime content otherwise unchanged; render never throws | DONE | W3 | 075c (fba71b8); see R-1 test reconciliation at merge |
| 075/m-AC-7 | `honeycomb recall "<query>"` Bash form → `search` verb, arg → query | DONE | W3 | 075c sentinel |
| 075/m-AC-8 | Every recall path fail-soft: unreachable/timeout/error daemon → bounded "no memory available", never a thrown/blocked turn | DONE | W2/W3 | 075a ~2s abort + absorbed throw; 075b absent-decision → benign ack |
| 075/m-AC-9 | `UserPromptSubmit` stays async capture-only; `PostToolUse`/`Stop`/`SubagentStop` capture unchanged; conformance suite green | OPEN | W2/W3 | |

### PRD-076a — Always-On Query-Aware Recall on `UserPromptSubmit`

| ID | Criterion (abridged) | Status | Owner | Evidence |
|---|---|---|---|---|
| 076a/a-AC-1 | `createRecallRenderer` POSTs `{ query, limit, tokenBudget, cwd }` to `/api/memories/recall`; recording fetch asserts query=prompt, cwd forwarded, bounded budget | OPEN | W3 ts-node | |
| 076a/a-AC-2 | Recall stamps runtime-path + session + tenancy headers (mirror `prime-renderer.ts`); signed-out degrades to `""` | OPEN | W3 ts-node | |
| 076a/a-AC-3 | Tight `AbortController` timeout; `""` on timeout/non-200/malformed, never a throw | OPEN | W3 ts-node | |
| 076a/a-AC-4 | On `UserPromptSubmit`, injector returns `{ ok, additionalContext }` + `emitResponse` renders it; capture still stores the turn | OPEN | W3 ts-node | |
| 076a/a-AC-5 | `renderContext` emits `additionalContext` under `hookSpecificOutput` with `hookEventName: "UserPromptSubmit"`; session-start envelope unchanged | OPEN | W3 ts-node | |
| 076a/a-AC-6 | Throttled + deduped: repeated prompt does not re-inject the same hit; nudge not every turn | OPEN | W3 ts-node | |
| 076a/a-AC-7 | Empty recall → at most the throttled nudge (or nothing), never an empty/malformed block | OPEN | W3 ts-node | |
| 076a/a-AC-8 | No session-start regression; per-turn arm never runs on `session-start`; existing session-start tests green | OPEN | W3 ts-node | |

### PRD-076b — Register the Honeycomb MCP Server in the Plugin

| ID | Criterion (abridged) | Status | Owner | Evidence |
|---|---|---|---|---|
| 076b/b-AC-1 | Plugin MCP-registration mechanism pinned vs references gate + encoded as an oracle under `references/claude-code/` | DONE | W1 harness | `references/claude-code/mcp-registration-schema.ts`; bundled `.mcp.json` mechanism confirmed vs 2026 Claude Code docs (path-traversal rule + issue #16143 rules out inline) |
| 076b/b-AC-2 | Plugin registers a `honeycomb` MCP server pointing at built `mcp/bundle/server.js` (mirrors hermes shape + its conformance test) | DONE | W1 harness | `harnesses/claude-code/.mcp.json` stdio server `honeycomb`; commit 120eb21 |
| 076b/b-AC-3 | Registration `args` path resolves relative to installed plugin root (`${CLAUDE_PLUGIN_ROOT}` or plugin-relative), install-safe | DONE | W1 harness | `${CLAUDE_PLUGIN_ROOT}/mcp/bundle/server.js`; `isInstallSafePluginPath` rejects `../`/absolute/repo-relative |
| 076b/b-AC-4 | Launched server lists the existing `TOOL_NAMES` unchanged (no tools added/removed) | DONE | W1 harness | static parity vs `mcp/src/tools.ts` (19-tool surface); no `mcp/src` change |
| 076b/b-AC-5 | `plugin.json` + hooks bundle otherwise unchanged (7 lifecycle events still register); registration is additive | DONE | W1 harness | `hooks.json` still conforms to `hooks-schema.ts`; no inline `mcpServers` |
| 076b/b-AC-6 | If manifest version single-sourced, registration stays version-consistent (no drift) | DONE | W1 harness | `.mcp.json` carries no version; manifests match root package.json; no sync-versions change |

### PRD-076c — Bundle a Memory Skill + Slash Commands

| ID | Criterion (abridged) | Status | Owner | Evidence |
|---|---|---|---|---|
| 076c/c-AC-1 | `honeycomb-memory` skill bundled with valid frontmatter + a description targeting memory-relevant work | DONE | W2 harness | `skills/honeycomb-memory/SKILL.md`; commit 0b056b5 |
| 076c/c-AC-2 | Skill body instructs search-before-task (`hivemind_search`/`memory_search`), cite + zoom (`hivemind_read`), store-with-type (`memory_store`) | DONE | W2 harness | body names all three tools + closed taxonomy |
| 076c/c-AC-3 | `/recall`, `/remember`, `/forget` commands bundled with valid frontmatter | DONE | W2 harness | `commands/{recall,remember,forget}.md` |
| 076c/c-AC-4 | `/forget` collects a `reason` (`memory_forget` requires one) | DONE | W2 harness | `forget.md` args `[path, reason]`, body refuses without reason |
| 076c/c-AC-5 | Skill + commands in plugin-contract-correct dirs (confirmed vs references gate) so the loader discovers them | DONE | W2 harness | oracle `references/claude-code/plugin-skills-commands-schema.ts`; confirmed vs 2026 Claude Code plugin docs (auto-discovery, no manifest enumeration) |
| 076c/c-AC-6 | Additive: `plugin.json`, hooks, and 076b registration unchanged by this sub-PRD | DONE | W2 harness | hooks + `.mcp.json` still conform; `plugin.json` untouched |

### PRD-076 — Module-level (index)

| ID | Criterion (abridged) | Status | Owner | Evidence |
|---|---|---|---|---|
| 076/m-AC-1 | First `UserPromptSubmit` POSTs prompt to `/api/memories/recall` (bounded budget + cwd); top hits injected synchronously | OPEN | W3 | |
| 076/m-AC-2 | Sync recall stamps runtime-path + session + tenancy; missing-session not sent bare | OPEN | W3 | |
| 076/m-AC-3 | Tight timeout + fail-soft `""` on timeout/non-200/malformed; never a thrown/blocked turn | OPEN | W3 | |
| 076/m-AC-4 | Existing `UserPromptSubmit` capture still happens (turn stored) | OPEN | W3 | |
| 076/m-AC-5 | `renderContext` per-event envelope (`hookSpecificOutput.hookEventName`) for both `SessionStart` + `UserPromptSubmit` | OPEN | W3 | |
| 076/m-AC-6 | Per-turn injection throttled + deduped (no double-inject; per-turn budget) | OPEN | W3 | |
| 076/m-AC-7 | Plugin registers the MCP server so `memory_search`/`hivemind_search`/`hivemind_read`/`memory_store` appear in the tool list | DONE | W1 | via 076b (`.mcp.json` merged f216748); see packaging follow-up F-1 |
| 076/m-AC-8 | `honeycomb-memory` skill bundled, valid frontmatter, discoverable | DONE | W2 | via 076c (merged); auto-discovery confirmed |
| 076/m-AC-9 | `/recall`/`/remember`/`/forget` commands bundled with valid frontmatter | DONE | W2 | via 076c (merged) |
| 076/m-AC-10 | No PRD-075 surface touched by 076 (pre-tool path default-fake, no decision, no pre-tool renderer, session-start unchanged) | OPEN | W3 | |

---

## Wave log

- **Setup (done):** submodule worktree created off `main`; PRD-075 (tracked) + PRD-076 (untracked, carried over) moved backlog → in-work; `main` working tree restored clean; `npm install` OK; ledger created.
- **Wave 1:** COMPLETE. 076b DONE + merged (f216748). 075a DONE + merged (d8628c4). Combined `npm run ci` on feature branch: 427 files, 4553 passed, 12 skipped, SQL-safety OK. Wave-1 worktrees removed.
- **Wave 2:** 076c DONE + merged (`npm run ci` 4584 passed; all-new files; `plugin.json` untouched via auto-discovery). 075b in progress. Note: 076c flagged two PRE-EXISTING flaky tests (`assemble.test.ts` timeout, `secrets/exec.test.ts` timing) that flake under full-suite CPU contention but pass in isolation, not caused by this work; give combined CI one retry on those per the-smoker flake rule.
- **Wave 2:** COMPLETE. 075b DONE + merged (cd72728); 076c DONE + merged. Combined `npm run ci` (075a+076b+076c+075b): 429 files, 4599 passed, 12 skipped, SQL-safety OK, no flakes. Aikido scan on 075b: 0 findings. Wave-2 worktrees removed.
- **Wave 3:** in progress — 076a (ts-node/opus, the big always-on integration), 075c (ts-node/sonnet, notice+sentinel), off feature tip cd72728. Format-only-owned-files brief applied.
- **Close-out:** pending — security then quality.

## Follow-ups / handoffs

- **F-2 (architecture, from 075a — quality review must reconcile):** the PRD names `DeepLakeFs` (`src/daemon-client/vfs/fs.ts`) as the real VFS seam, but wiring it needs a raw-SQL `DaemonDispatch` daemon endpoint that does not exist (its CONVENTIONS.md lists it deferred). 075a instead wired the real seam to the already-mounted `/memory/{cat,grep,ls,find}` browse routes (`src/daemon/runtime/vfs/api.ts`, PRD-022b) over loopback, same `memory`-table content, no new daemon endpoint, no cross-boundary edit. Documented, tested, `ci` green. Quality-worker-bee must confirm this satisfies 075/m-AC-1 + 075/m-AC-4 intent (real daemon-backed recall) despite deviating from the literal `DeepLakeFs` naming.
- **F-1 (ci-release, from 076b):** the install-safe registration path `${CLAUDE_PLUGIN_ROOT}/mcp/bundle/server.js` requires the MCP bundle to physically ship INSIDE the plugin tree (`harnesses/claude-code/mcp/bundle/`). Today `mcp/bundle/server.js` builds to the repo root (gitignored, reaches the tarball via the `files` allowlist). The registration artifact + contract are correct as authored; the build-time bundle placement (esbuild output location + packaging) is a `ci-release` task, out of 076b's file ownership. Dispatch a `ci-release-worker-bee` before ship, or fold into close-out. Does not fail any 076b AC as written.

## Merge-time reconciliations

- **R-1 (075c x 076a, MERGE-TIME):** 075c makes `RECALL_AWARENESS_NOTICE` an unconditional part of session-start `additionalContext`. This breaks 12 exact-string assertions in `tests/hooks/runtime/hook-runtime.test.ts` (owned by 076a's runtime scope, not touched by 075c). Neither isolated worktree shows the failure (075c's ci fails there but it correctly deferred; 076a's tree has no notice). AFTER merging BOTH 075c and 076a, append `\n\n${RECALL_AWARENESS_NOTICE}` to the expected session-start strings (075c cited lines 104,162,195,212,228,269,291,314,341,391,532,578 in the pre-076a tree; fix by CONTENT since 076a shifts line numbers). Mechanical, no logic change. Then run combined `npm run ci` to confirm green.

## Watchdog / termination log

- W1 watchdogs: 076b committed within ~6-10 min (healthy). 075a produced no commits/working-tree changes through ~10 min; tight watchdog armed to terminate + decompose if still empty.

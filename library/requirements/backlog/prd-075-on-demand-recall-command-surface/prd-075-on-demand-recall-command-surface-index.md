# PRD-075: On-Demand Recall Command Surface — Make Honeycomb Recall LLM-Commandable

> **Status:** Backlog
> **Priority:** P1 (recall today is either a blind session-start dump or nothing; the highest-signal recall — keyed on what the agent is actually doing mid-task — is architecturally present but unwired, so the memory layer's core value is under-delivered)
> **Effort:** L (~1-2d)
> **Schema changes:** None. No catalog columns, no DDL. Pure hook-runtime + shim wiring plus one `SessionStart` context string.

---

## Overview

Honeycomb captures memory continuously but **recalls it in exactly one place**: the `SessionStart` hook, which injects a context digest keyed on *nothing* — there is no query yet at session boot, so the best it can do is a blind, recency/scope-based dump that goes stale the moment the conversation moves. The two events that carry a real query signal — `UserPromptSubmit` (the user's text) and `PreToolUse` (the agent's tool intent) — do **no recall**:

- `UserPromptSubmit` is registered `async: true` (`harnesses/claude-code/hooks/hooks.json:21`), and an async Claude Code command hook runs fire-and-forget: its stdout is **never** injected back into the turn. The shim also maps it straight to the capture path (`shim.ts:44` → `"user_message"` → `runCapture`). So the event with the strongest query signal throws its recall opportunity away and only stores the turn.
- `PreToolUse` **is** synchronous (60 s) and the codebase already contains a full recall surface behind it — the VFS intercept (`runPreToolUse`) that resolves `grep`/`cat` against the memory mount through the daemon's hybrid lexical+semantic search and returns the hits as the tool result. This is precisely an **LLM-commanded, prompt-conditioned recall** primitive: the agent decides to search, pays the cost only then, and gets memory back in-band. But it is **stubbed at two points and unrendered at a third**, so it does nothing in production today.

This PRD lights up that dormant surface end to end, and makes it **discoverable** so the model actually reaches for it. The result: the agent can, mid-task, issue a recall command (`grep`/`cat` the mount, or a first-class `honeycomb recall "<query>"`), the sync `PreToolUse` hook resolves it through real daemon hybrid recall, and the hits come back as the tool result — with **zero added latency on any turn where the agent does not ask**. That is the "think about it, get it back" loop the session-start dump cannot provide, without the per-turn tax that making `UserPromptSubmit` synchronous would impose.

### Why the `PreToolUse` surface, not synchronous `UserPromptSubmit`

Both would deliver prompt-conditioned recall. They trade off differently:

| Approach | Latency cost | Determinism | Query source |
|---|---|---|---|
| Synchronous `UserPromptSubmit` recall | **Every turn** pays a daemon round-trip (up to the hook timeout) | Deterministic — always runs | The user's prompt text |
| LLM-commanded `PreToolUse` recall (this PRD) | **Only** on turns where the agent issues a recall command | Soft — depends on the model choosing to recall | The agent's own query, formed from live task context |

The `PreToolUse` path is the better default because (a) most turns need no recall and should not pay for one, and (b) the agent's mid-task query ("find where we decided X") is higher-signal than the raw user prompt. The soft-determinism risk (the model has to *know* to use it) is exactly what sub-PRD 075c's `SessionStart` awareness notice addresses. A future PRD can add synchronous `UserPromptSubmit` recall as a complementary always-on arm; it is **out of scope** here (see Out of scope).

### The three breakpoints this PRD fixes

The `PreToolUse` recall core (`runPreToolUse` in `src/hooks/shared/pre-tool-use.ts`) is written, typed, and unit-tested in isolation — but the live path is broken in three places:

1. **Fake VFS.** The runtime calls `runPreToolUse(input, deps)` with only two args (`runtime.ts:252`), so the third parameter defaults to `createFakeVfsIntercept()` — a recording fake — and the function ignores `deps` entirely (`void _deps`, `pre-tool-use.ts:96`). The real daemon-backed intercept (`DeepLakeFs`, `src/daemon-client/vfs/`) is never threaded in, so no real memory is ever resolved.
2. **Discarded decision.** That same call site keeps only `{ result }` and drops the `decision` (`runtime.ts:252`). The `PreToolDecision` (`allow | replace | deny | rewrite`, `pre-tool-use.ts:41-45`) is the object that would tell Claude Code to **block the real tool and substitute the daemon output**. It never propagates, so even a resolved hit could not reach the model as a blocking response.
3. **No shim renderer.** The claude-code shim (`src/hooks/claude-code/shim.ts`) only defines the event map and `extractData`; it has **no** pre-tool decision renderer. Its context channel is `"model-only"` (`shim.ts:53`), which can inject `additionalContext` but cannot by itself block a tool — and `replace` requires blocking (otherwise the real `grep` runs against a path that does not exist and returns nothing).

Fix all three and the surface is live; add the `SessionStart` notice and the agent knows to use it.

---

## Goals

- **Recall becomes agent-commandable mid-task.** When the agent issues a recall command against the memory mount (`grep`/`cat` the mount path, or the `honeycomb recall "<query>"` sentinel from 075c), the sync `PreToolUse` hook resolves it through the **real** daemon hybrid recall (`DeepLakeFs`), and the hits return as the tool result.
- **The real tool never executes.** A recall command is intercepted and its output replaced with daemon content; nothing touches the real filesystem (the existing `mentionsMount` gate and no-`node:fs` invariant in `pre-tool-use.ts` are preserved).
- **Zero cost when unused.** On any turn where the agent issues no recall command, no daemon recall query runs — the `PreToolUse` hook falls through to its existing `allow` path with no added round-trip.
- **The model knows the surface exists.** `SessionStart` injects a short, durable notice describing the recall command and when to use it, delivered through the existing `additionalContext` render path (075c).
- **Prompt-conditioned, not blind.** The recall query is the agent's own text, passed as the `grep`/`recall` pattern — not a session-scope dump.
- **Fail-soft, always.** An unreachable/timed-out daemon yields a clear "no memory available" tool result, never a thrown hook, never a blocked turn — the existing fail-soft posture (`runtime.ts` dispatch `try/catch`, `pre-tool-use.ts` returns) is preserved.
- **Reference-harness parity holds.** The claude-code change keeps the cross-harness conformance suite green; the `PreToolDecision` render is expressed so other harnesses can adopt it without re-derivation.

## Non-Goals

- **No synchronous `UserPromptSubmit` recall.** Making `UserPromptSubmit` sync to inject per-prompt recall is a separate, always-on arm with a per-turn latency cost. This PRD deliberately chooses the LLM-commanded `PreToolUse` path instead; the sync-prompt arm is a candidate for a future PRD and is not built here. `UserPromptSubmit` stays `async: true` (capture-only), unchanged.
- **No change to `SessionStart` recall content.** The existing session-start digest/prime (`session-start.ts`, `prime-renderer.ts`) is untouched except for **appending** the 075c awareness notice to its `additionalContext`. The blind-dump recall stays as-is; this PRD adds a second, on-demand surface beside it.
- **No new recall engine.** The daemon-side hybrid recall (`recallMemories`, RRF over `<#>` + `ILIKE`) is reused verbatim through the existing `VfsIntercept` → `DeepLakeFs` seam. No ranker, weighting, or query-shaping changes.
- **No capture-path change.** The `PostToolUse`/`Stop` capture and `UserPromptSubmit` capture behavior are unchanged; this PRD only adds a recall *response* on the pre-tool branch.
- **No MCP surface change.** The `hivemind_*` MCP tools (`mcp/src/tools.ts`) are an orthogonal active-recall surface; this PRD does not add, remove, or alter them. (An agent host that wires the MCP server gets active recall that way; this PRD is the hooks-only path that needs no MCP registration.)
- **No non-claude-code harness rewiring in this PRD.** The `PreToolDecision` render contract is defined so Codex/Cursor/Hermes/pi/OpenClaw can adopt it, but only the claude-code reference harness is wired here. Other harnesses follow in their own PRDs.
- **No `Write`/`Edit` semantics change.** Writes to the mount stay denied with the existing guidance (`WRITE_DENY_GUIDANCE`, `pre-tool-use.ts:70`).

---

## Code-grounded current state

| # | Fact | Code |
|---|---|---|
| 1 | Seven Claude Code hooks are registered; `UserPromptSubmit` is `async: true` (fire-and-forget, cannot inject), `PreToolUse` is synchronous (60 s), `SessionStart` is synchronous (10 s) | `harnesses/claude-code/hooks/hooks.json:15-26` (UserPromptSubmit block, `async` at `:21`), `:27-37` (PreToolUse, sync), `:4-14` (SessionStart, sync) |
| 2 | The shim maps `UserPromptSubmit → "user_message"`, which the runtime dispatches to `runCapture` — pure capture, no recall | `src/hooks/claude-code/shim.ts:44` (`CLAUDE_CODE_EVENT_MAP`), `src/hooks/runtime.ts:261` (default branch → `runCapture`) |
| 3 | Recall / `additionalContext` injection is bound to the `session-start` branch ONLY | `src/hooks/runtime.ts:239` (comment: "the prime is injected ONLY on the session-start branch"), render at `src/hooks/shared/session-start.ts:222` (join) / `:237` (return) |
| 4 | The `pre-tool-use` dispatch calls `runPreToolUse(input, deps)` and **discards the `decision`**, keeping only `result` | `src/hooks/runtime.ts:252` |
| 5 | `runPreToolUse(input, _deps, vfs = createFakeVfsIntercept())` ignores `deps` (`void _deps`) and defaults to the **fake** VFS — the real daemon intercept is never threaded in | `src/hooks/shared/pre-tool-use.ts:91-96` |
| 6 | The `PreToolDecision` type is `allow \| replace \| deny \| rewrite`; the `replace` path returns the daemon VFS search/read output as the tool substitute | `src/hooks/shared/pre-tool-use.ts:41-45` (type), `:127-128` (`replace` return with `output`) |
| 7 | The real daemon-backed `VfsIntercept` (`DeepLakeFs`, dispatches SQL through the daemon over loopback) lives outside the hook core and is the ONLY route to real memory content | `src/daemon-client/vfs/` (per `pre-tool-use.ts:13-19` header + `classifyPath` import at `:25`) |
| 8 | The claude-code context channel is `"model-only"` (`additionalContext`); the shim has **no** pre-tool decision renderer — only `eventMap` + `extractData` | `src/hooks/claude-code/shim.ts:53` (`CLAUDE_CODE_CONTEXT_CHANNEL`), `:119-133` (shim construction — no pre-tool render) |
| 9 | The VFS intercept already models the full recall verb set on the mount: `Read`/`cat` → read, `Grep`/`Glob`/`grep`/`rg` → hybrid search, `ls` → list, `find` → find; `Write`/`Edit` → deny; unmodelable Bash → rewrite to harmless echo | `src/hooks/shared/pre-tool-use.ts:78-89` (routing), `:203-219` (`lowerVerb`), `:222-240` (`lowerBashVerb`) |
| 10 | The mount gate recognizes the current `.apiary/honeycomb/memory` and legacy `.honeycomb/memory` shapes plus `/memory/`, `goal/`, `kpi/`, `sessions/`, `graph/` prefixes; a non-mount path passes through untouched | `src/hooks/shared/pre-tool-use.ts:159-194` (`onMemoryMount` / `mentionsMount`) |
| 11 | The whole hook lifecycle is fail-soft: a core throw is absorbed so a hook never breaks the turn | `src/hooks/runtime.ts` (`dispatchLifecycle` `try/catch`, the `case "pre-tool-use"` inside it) |

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-075a-live-the-pretooluse-recall-path`](./prd-075a-live-the-pretooluse-recall-path.md) | Thread the real daemon `VfsIntercept` into `runPreToolUse` (replace the fake), and propagate the discarded `PreToolDecision` out of the runtime dispatch so a downstream renderer can consume it. Fail-soft preserved. | Draft |
| [`prd-075b-render-pretool-decision-and-conformance`](./prd-075b-render-pretool-decision-and-conformance.md) | The claude-code shim `PreToolDecision` renderer: map `replace`/`deny`/`rewrite`/`allow` to Claude Code's native `PreToolUse` response (block the real tool via `permissionDecision`, carry the daemon output back to the model), verified against the real hook output contract and the cross-harness conformance suite. | Draft |
| [`prd-075c-session-start-recall-awareness-notice`](./prd-075c-session-start-recall-awareness-notice.md) | The `SessionStart` awareness notice (appended to `additionalContext`) that tells the model the recall command exists and when to use it, plus the first-class `honeycomb recall "<query>"` sentinel verb mapped to `search` in `lowerBashVerb`. | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion |
|---|---|
| m-AC-1 | On a `PreToolUse` event whose tool op targets the memory mount with a read/search/list/find verb, the runtime resolves it through the **real** daemon `VfsIntercept` (`DeepLakeFs`), not `createFakeVfsIntercept()`. A test asserts the wired dependency is the real seam (or an injected test double standing in for it), never the module-default fake. |
| m-AC-2 | The `PreToolDecision` produced by `runPreToolUse` is propagated out of `dispatchLifecycle` (no longer discarded at `runtime.ts:252`) and reaches the claude-code shim renderer. |
| m-AC-3 | The claude-code shim renders a `replace` decision as a Claude Code `PreToolUse` response that (a) prevents the real tool from executing and (b) delivers the daemon output to the model. A `deny` renders as a block with the guidance text; a `rewrite` substitutes the harmless command; an `allow` passes through untouched. |
| m-AC-4 | An agent-issued recall command against the mount (e.g. `Grep pattern="<q>" path="~/.apiary/honeycomb/memory/"`, or the `honeycomb recall "<q>"` sentinel) returns the daemon's hybrid-recall hits as the tool result, and the real filesystem is never touched (no `node:fs` path, `mentionsMount` gate holds). |
| m-AC-5 | On a `PreToolUse` event that does NOT target the memory mount, behavior is byte-for-byte unchanged: the decision is `allow`, no daemon call is made, and no `additionalContext` is injected. A test asserts an ordinary `cat /etc/hosts` (or any off-mount tool) adds zero recall latency and passes through. |
| m-AC-6 | `SessionStart` appends a recall-awareness notice to its `additionalContext`; the existing session-start digest/prime content is otherwise unchanged. When the notice is the only content, `additionalContext` carries just the notice; the session-start render never throws (`d-AC-4`-style fail-soft preserved). |
| m-AC-7 | The `honeycomb recall "<query>"` Bash form is mapped to the `search` verb in `lowerBashVerb` and its argument is passed to the VFS intercept as the query; a test covers the verb mapping and query extraction. |
| m-AC-8 | Every recall path is fail-soft: an unreachable/timed-out/erroring daemon yields a bounded "no memory available" tool result (or omitted `additionalContext`), never a thrown hook and never a blocked turn. A test drives the intercept to error and asserts the turn proceeds. |
| m-AC-9 | `UserPromptSubmit` remains `async: true` and capture-only; `PostToolUse`/`Stop`/`SubagentStop` capture behavior is unchanged. The cross-harness conformance suite (equivalence-to-reference) remains green. |

---

## Open questions

- **The recall return channel on `PreToolUse` (075b, load-bearing).** Claude Code's `PreToolUse` hook output contract must be confirmed against the installed version: does a `permissionDecision: "deny"` with a `permissionDecisionReason` deliver the daemon output to the model cleanly, or is there a first-class `hookSpecificOutput.additionalContext` on `PreToolUse` that both blocks and injects? 075b's first task is to pin this from the real harness (per the references-gate discipline) before the renderer is written. If neither channel can both block-and-inject, the fallback is the `rewrite`-to-echo-of-the-hits pattern (the echo command's stdout becomes the tool result) — uglier but contract-safe.
- **Awareness-notice durability vs. compliance (075c).** A `SessionStart` notice decays as context grows — the model may forget the recall command mid-session. Is a one-shot notice sufficient, or should a terse reminder also ride on the `PreToolUse` `allow` path occasionally (at the cost of noise)? 075c ships the one-shot notice and records the reminder cadence as a follow-up tuning question, mirroring 074's "ship the constant, tune from data" posture.
- **Sentinel spelling (075c).** `honeycomb recall "<query>"` reads as intent, but relies on the model emitting a `Bash` call. An alternative is instructing the model to `Grep` the mount path directly (no new verb, but leaks the path convention into the prompt). Ship both — the sentinel as the documented ergonomic form, the raw mount `grep`/`cat` as the always-available fallback the intercept already supports.

---

## Out of scope, explicitly

- **Synchronous `UserPromptSubmit` recall** (an always-on, per-turn recall arm) — a separate future PRD; `UserPromptSubmit` stays async capture-only here.
- **The `SessionStart` blind-dump recall content** — untouched except for the appended awareness notice.
- **The daemon-side recall engine** (`recallMemories`, RRF, `<#>`/`ILIKE` arms, ranker) — reused verbatim through the existing `VfsIntercept` seam.
- **The MCP `hivemind_*` active-recall tools** — orthogonal surface, unchanged.
- **Non-claude-code harness wiring** — the render contract is defined for reuse, but only the reference harness is wired in this PRD.
- **Capture-path behavior** on any event — unchanged.

---

## Prior art

- **PRD-046 (`prd-046-session-memory-priming`)** + `session-start.ts` / `prime-renderer.ts` — the existing `additionalContext` injection path this PRD's 075c notice appends to. The prime is the blind-dump recall; this PRD adds the on-demand surface beside it.
- **PRD-019b / 019c (`prd-019...`, the reference-harness hook runtime + shim architecture)** — the `dispatchLifecycle` core, the `HarnessShim` contract, and the `references/claude-code/` gate that 075b's render must conform to. The `PreToolDecision` renderer is the missing shim capability those PRDs scaffolded but never wired to a live VFS.
- **PRD-015 (VFS intercept / `DeepLakeFs`)** — the daemon-backed `VfsIntercept` seam (`src/daemon-client/vfs/`) that 075a threads into `runPreToolUse`. The intercept and its SQL-through-the-daemon dispatch are reused unchanged; this PRD only connects it.
- **`references/claude-code/hooks-schema.ts`** — the executable oracle for the Claude Code hooks config contract; 075b extends the same references discipline to the `PreToolUse` *response* contract (currently the schema covers config keys, not hook stdout shapes).

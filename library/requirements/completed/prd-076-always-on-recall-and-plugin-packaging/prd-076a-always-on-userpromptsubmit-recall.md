# PRD-076a: Always-On Query-Aware Recall on `UserPromptSubmit`

> **Parent:** [`prd-076-always-on-recall-and-plugin-packaging-index`](./prd-076-always-on-recall-and-plugin-packaging-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M (~0.5-1d)
> **Schema changes:** None.

---

## Goal

Give a Claude Code session per-turn, query-aware recall. Today the only context injection is the blind `SessionStart` prime, which fires before any query. On `UserPromptSubmit` (the event that carries the user's prompt text), send that text to the daemon's existing hybrid recall (`POST /api/memories/recall`) and inject the top hits synchronously as `additionalContext`, project-scoped by the session `cwd`, bounded by a tight timeout, and fully fail-soft. This is the deterministic floor of PRD-076: recall that runs whether or not the model chooses to reach for a tool.

The renderer is a query-parameterized clone of the existing prime renderer pattern (`src/hooks/shared/prime-renderer.ts`), so it reuses the same loopback + header-stamp + `AbortController` + fail-soft `""` discipline. The load-bearing wiring problem is that `UserPromptSubmit` is `async: true` today (fire-and-forget, its stdout is discarded) and the shim routes it to capture, which never emits `additionalContext`. This sub-PRD resolves both.

## Non-Goals

- **No `PreToolUse` recall.** The on-demand VFS recall arm is PRD-075; this sub-PRD does not touch `runPreToolUse`, the `PreToolDecision`, or the pre-tool renderer.
- **No `SessionStart` change.** The prime content and the 075c awareness notice are untouched; the per-turn arm never runs on `session-start`.
- **No new recall engine.** `POST /api/memories/recall` and `recallMemories` are reused verbatim; no ranker/weighting/query-shaping change.
- **No capture removal.** The existing `UserPromptSubmit` capture (the turn is stored) is preserved; this adds a recall response beside it.
- **No MCP or plugin packaging work.** That is 076b / 076c.

---

## Code-grounded starting point

| # | Fact | Code |
|---|---|---|
| 1 | `UserPromptSubmit` is `async: true` (fire-and-forget: Claude Code does not inject an async command hook's stdout), timeout 10s. | `harnesses/claude-code/hooks/hooks.json:15-25` (`async` at `:22`) |
| 2 | The shim maps `UserPromptSubmit → "user_message"`; the runtime's default dispatch branch routes `user_message` to `runCapture`. | `src/hooks/claude-code/shim.ts:48`, `src/hooks/runtime.ts:282-285` |
| 3 | `runCapture` returns `{ ok, reason }` and NEVER sets `additionalContext` - it is pure capture. | `src/hooks/shared/capture.ts:71-108` |
| 4 | The binary's `emitResponse` already injects `additionalContext` for ANY event whose `HookResult` carries it (renders via `shim.renderContext`, writes to stdout); an empty result emits `{}`. The injection plumbing exists. | `src/hooks/binary.ts:164-176` (reads `outcome.result.additionalContext` at `:166`) |
| 5 | The prime renderer is the pattern to clone: loopback `GET`, stamps runtime-path + `x-honeycomb-session` + tenancy headers, bounds with an `AbortController` timeout, fails soft to `""`. | `src/hooks/shared/prime-renderer.ts:86-122` (`:96-104` headers, `:108-116` timeout + fail-soft, `:52` `DEFAULT_PRIME_TIMEOUT_MS = 5_000`) |
| 6 | The daemon recall route accepts `{ query, limit?, tokenBudget?, recency?, cwd? }`, resolves the project from `cwd`, and returns scored hits; it is a SESSION group requiring the runtime-path + session + tenancy headers. | `src/daemon/runtime/memories/api.ts:588` (route), `:303-323` (`RecallBodySchema`), `:29-35` (session-group header requirement) |
| 7 | `renderContext` emits a single flat `{ channel, additionalContext }` envelope, built for session-start; it is not event-aware. | `src/hooks/normalize.ts:136-138` (`renderContext`), `:149-156` (`renderChannel`) |
| 8 | The runtime dispatch is fail-soft: a core throw is absorbed by `dispatchLifecycle`'s `try/catch`, so a hook never breaks the turn. | `src/hooks/runtime.ts:248-291` (dispatch `try/catch`) |

---

## Design

Four pieces, each narrow.

### 1. The query-aware recall renderer (a `PrimeRenderer` sibling)

Add a `createRecallRenderer` in `src/hooks/shared/` modeled directly on `createPrimeRenderer` (`prime-renderer.ts:86-122`). Differences from the prime renderer:

- **Method:** `POST` to `/api/memories/recall` (the prime renderer GETs `/api/memories/prime`).
- **Body:** `{ query: <prompt text>, limit: <small>, tokenBudget: <small>, cwd: <session cwd> }`, matching `RecallBodySchema` (`api.ts:303-323`). The `cwd` scopes recall to the project (49b), so a recall in project A never returns a project-B row.
- **Headers:** identical stamp to `prime-renderer.ts:96-104` - `x-honeycomb-runtime-path` (from the active harness), `x-honeycomb-session` (`meta.sessionId`), and tenancy (`x-honeycomb-org` (+ `x-honeycomb-workspace` / `x-honeycomb-actor`)). The `/api/memories` session group 400s without them (`api.ts:29-35`).
- **Timeout:** a tight `AbortController` budget, target ~2-3s (tighter than the 5s prime budget), because this rides EVERY qualifying turn, not once per session. Fail-soft to `""` on timeout / non-200 / malformed body, exactly like `prime-renderer.ts:114-116`.
- **Output:** coerce the recall response `hits` into a bounded, legible block of text (the daemon already bounds the hits and honours `tokenBudget`); the hook does no ranking or re-assembly.

The renderer is injected into the runtime the same way `prime` is (`runtime.ts:183`), defaulting to the real loopback client fed by the same credential reader.

### 2. Make a synchronous injector coexist with async capture

`UserPromptSubmit` is `async: true` (capture-only) today. Two options, resolved against the references gate (open question in the index):

- **Option A (recommended): register `UserPromptSubmit` twice.** Claude Code allows multiple hook entries per event. Add a SECOND `UserPromptSubmit` entry that is synchronous (no `async: true`) and runs ONLY the recall injector, and keep the existing `async: true` entry for capture. This isolates the per-turn latency to the injector and preserves the capture's fire-and-forget profile. It costs a second process spawn per prompt.
- **Option B: make the single `UserPromptSubmit` hook synchronous** and do a fast recall+capture in one invocation. Simpler wiring, but the capture also becomes synchronous (adds its round-trip to the turn).

Whichever is chosen, the runtime must route the injector path to a recall (not `runCapture`). The cleanest shape is a new logical event (e.g. `user_prompt_recall`) the injector shim entry maps to, dispatched to a `runUserPromptRecall` core that calls the recall renderer and returns `{ ok, additionalContext }`. The capture entry keeps mapping `UserPromptSubmit → "user_message" → runCapture` unchanged (Code-grounded fact 2/3). `emitResponse` (fact 4) already injects the returned `additionalContext` with no binary change.

### 3. Make `renderContext` event-aware

`renderContext` currently returns a flat `{ channel, additionalContext }` (`normalize.ts:136-156`), built for session-start. Claude Code accepts `additionalContext` under `hookSpecificOutput` with a matching `hookEventName`. Thread the logical/native event through the render path so the model-only channel emits the correct per-event envelope (`hookSpecificOutput: { hookEventName: "UserPromptSubmit" | "SessionStart", additionalContext }`), pinned against the installed harness contract (references gate). The session-start envelope must stay behavior-identical (regression-guarded).

### 4. The throttled reminder companion

As a cheap fallback for turns where recall returns nothing (or as a companion nudge), inject a lightweight, stable "you have a searchable memory" reminder, throttled (e.g. not every turn) and deduped so it does not spam the context. This is the weak Q1 form; the strong form is the injected recall above, and the skill (076c) is the smarter auto-triggering reminder. Dedupe: track what was injected this session (hit refs + whether the nudge fired) so repeated prompts do not re-inject the same content, protecting both the token budget and prompt-cache stability.

Fail-soft throughout: any renderer failure resolves to `""` (no injection), the dispatch `try/catch` (`runtime.ts:248-291`) absorbs a core throw, and the turn always proceeds.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| a-AC-1 | A `createRecallRenderer` POSTs `{ query, limit, tokenBudget, cwd }` to `/api/memories/recall`. A test injecting a recording `fetch` stub asserts the prompt text is the `query`, the session `cwd` is forwarded, and a bounded `limit`/`tokenBudget` is sent. |
| a-AC-2 | The recall request stamps `x-honeycomb-runtime-path` + `x-honeycomb-session` + tenancy headers, mirroring `prime-renderer.ts:96-104`. A test asserts the header stamp; a signed-out credential degrades to `""` (the daemon fail-closes with no org). |
| a-AC-3 | The recall is bounded by a tight `AbortController` timeout and returns `""` on timeout / non-200 / malformed body, never a throw. A test drives the stub to hang past the timeout and to return a 500, and asserts `""` both times. |
| a-AC-4 | On `UserPromptSubmit`, the injector path returns `{ ok: true, additionalContext: <hits> }` and `emitResponse` renders it to stdout; the existing capture path still stores the turn. A test asserts both the injection and the capture occur (per the chosen coexistence option). |
| a-AC-5 | `renderContext` emits `additionalContext` under `hookSpecificOutput` with `hookEventName: "UserPromptSubmit"` for the per-turn arm, and the `SessionStart` envelope is unchanged. A test asserts both envelopes. |
| a-AC-6 | Injection is throttled and deduped against what was already injected this session: a repeated prompt does not re-inject the same hit, and the reminder nudge does not fire every turn. A test drives two turns with an overlapping recall result and asserts no double-injection. |
| a-AC-7 | On a turn where recall returns no hits, the arm injects at most the throttled reminder nudge (or nothing), never an empty or malformed block. A test asserts an empty recall result yields either the nudge or `{}`. |
| a-AC-8 | No `session-start` regression: the session-start prime + context + notice compose and render exactly as before, and the per-turn arm never runs on the `session-start` branch. Existing session-start tests remain green. |

---

## Files touched

**Modified**
- `harnesses/claude-code/hooks/hooks.json` - add the synchronous `UserPromptSubmit` injector entry (Option A) OR make the existing entry synchronous (Option B).
- `src/hooks/claude-code/shim.ts` - map the injector entry to the recall logical event (Option A), keeping the capture map unchanged.
- `src/hooks/runtime.ts` - dispatch the recall logical event to the new `runUserPromptRecall` core; construct the recall renderer seam (mirroring the `prime` seam at `:183`).
- `src/hooks/normalize.ts` - make `renderContext` / `renderChannel` event-aware (per-event `hookSpecificOutput.hookEventName`).
- `src/hooks/shared/contracts.ts` - add the `RecallRenderer` seam type (and the logical event, if introduced).

**New**
- `src/hooks/shared/recall-renderer.ts` - the query-aware recall renderer (a `prime-renderer.ts` sibling).
- `src/hooks/shared/user-prompt-recall.ts` (or a branch in the existing core index) - the `runUserPromptRecall` core + the throttle/dedupe state.
- tests under `tests/daemon/runtime/hooks/` (or the existing hooks suites) for a-AC-1..a-AC-8.

---

## Test plan

- **Unit - renderer:** recording `fetch` stub; assert query/cwd/budget in the body (a-AC-1), header stamp + signed-out degrade (a-AC-2), timeout + non-200 fail-soft `""` (a-AC-3).
- **Unit - dispatch + injection:** drive a `UserPromptSubmit` through the runtime; assert the injector returns `additionalContext` and `emitResponse` renders it, and the capture still fires (a-AC-4).
- **Unit - envelope:** assert the `UserPromptSubmit` `renderContext` envelope carries `hookEventName: "UserPromptSubmit"` under `hookSpecificOutput` and the session-start envelope is unchanged (a-AC-5).
- **Unit - throttle/dedupe:** two turns with overlapping recall hits → no double-injection; nudge cadence respected (a-AC-6); empty recall → nudge-or-`{}` (a-AC-7).
- **Regression:** session-start suites green, per-turn arm never runs on session-start (a-AC-8).

---

## Open questions

- **Coexistence option (A vs B).** Register `UserPromptSubmit` twice (isolate latency to the injector, extra spawn) vs a single synchronous hook (simpler, capture also synchronous). Confirm the Claude Code multi-entry-per-event behavior against the references gate and pick A unless the double-spawn cost is prohibitive.
- **The exact `UserPromptSubmit` output contract.** Confirm from the installed harness that `additionalContext` on `UserPromptSubmit` is delivered under `hookSpecificOutput` with `hookEventName`, and encode it in `references/claude-code/` (the same discipline `hooks-schema.ts` applies to the config contract). This gates the envelope shape.
- **Recall cadence.** Every-turn vs first-turn-only vs throttled-every-turn. Ship throttled/deduped-every-turn with a small budget; tune from telemetry (does the injected recall get used?).
- **Timeout budget placement.** Whether the ~2-3s bound lives in the recall renderer (like `prime-renderer.ts`) or as a shared wrapper. Prefer the renderer, mirroring the prime path.
- **Dedupe key.** Dedupe on hit ref/id vs rendered text. Prefer the ref so a re-scored duplicate of the same memory still dedupes.

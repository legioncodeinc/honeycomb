# PRD-076: Always-On Memory Recall + Claude Code Plugin Packaging

> **Status:** In-work
> **Priority:** P1 (per-turn recall is the highest-value memory surface and it does not exist: today the ONLY context injection is at `SessionStart`, before any query, so every turn after the first gets zero recall and zero reminder. The daemon's hybrid recall and a full MCP tool surface both already exist but are unreachable from a Claude Code session, so the memory layer's value is under-delivered on exactly the turns that carry a real query.)
> **Effort:** L (~1-2d)
> **Schema changes:** None. No catalog columns, no DDL. Pure hook-runtime + shim wiring, plugin manifest/packaging (a bundled `.mcp.json`, a `skills/` dir, a `commands/` dir), and one query-aware renderer that reuses the existing daemon `/api/memories/recall` route.

---

## Overview

Honeycomb captures memory continuously but injects it into a Claude Code session in exactly one place: the `SessionStart` hook. `SessionStart` fires before the user has typed anything, so the best it can do is a blind, recency/scope-based prime digest (`prime-renderer.ts` → `GET /api/memories/prime`) that goes stale the moment the conversation moves. Per turn, there is no recall and no reminder. The two levers that would fix this both already exist in the codebase and are simply not wired to a Claude Code session:

- **The daemon's hybrid recall** (`POST /api/memories/recall`, `src/daemon/runtime/memories/api.ts:588`) is live, query-parameterized, project-scoped, and token-budgeted. Nothing on the per-turn path calls it: `UserPromptSubmit` (the event that carries the user's query) is registered `async: true` (`harnesses/claude-code/hooks/hooks.json:22`), which in Claude Code is fire-and-forget, so its stdout is never injected, and the shim maps it straight to capture (`src/hooks/claude-code/shim.ts:48` maps `UserPromptSubmit → "user_message"` → `runCapture`, which never emits `additionalContext`).
- **The MCP tool surface** (`mcp/src/tools.ts:77-138`) already exposes a full recall toolset: `memory_search`, `hivemind_search` (routes to the same `POST /api/memories/recall` hybrid recall), `hivemind_read` (zoom a ref to a summary or raw turns), plus `memory_store`/`memory_get`/`memory_list`/`memory_modify`/`memory_forget`. The Claude Code plugin does not register it: `harnesses/claude-code/.claude-plugin/plugin.json:1-14` carries only name/description/version, and the plugin bundles only hooks. So the model has no callable recall tools in a Claude Code session, even though a sibling harness (`harnesses/hermes/.mcp.json`) already registers the exact same server.

This PRD lights up both. It is the **always-on complement** to PRD-075. Where 075 delivers the on-demand, model-commanded `PreToolUse` recall arm (the agent issues a recall command mid-task and pays only then), 076 delivers the always-on, query-aware arm on `UserPromptSubmit` plus the packaging that makes recall a first-class, discoverable Claude Code capability: MCP registration, a bundled skill, and slash commands.

### The design: a deterministic floor plus a model-driven ceiling

The two arms of this PRD reinforce each other, and the framing is deliberate:

- **Deterministic floor (sub-PRD A).** Query-aware recall injected synchronously on `UserPromptSubmit` runs whether or not the model thinks to recall. It guarantees a baseline: on the first prompt of a chat, the user's own text is sent to `POST /api/memories/recall` and the top hits come back as `additionalContext`. No model cooperation required.
- **Model-driven ceiling (sub-PRDs B + C).** The MCP tools (B) give the model something rich to call on demand (search, zoom-to-raw-turns, store). The bundled skill and slash commands (C) teach the model when to reach for those tools and give the user explicit, discoverable control (`/recall`, `/remember`, `/forget`). This ceiling is unbounded by the per-turn budget: the model recalls deeply exactly when a task warrants it.

The floor makes recall reliable; the ceiling makes it rich. The reminder and skill make the model act; the MCP tools give it something to call; the injected recall guarantees a floor even when the model does nothing. Neither arm alone is sufficient: injection alone cannot follow the conversation past the first prompt, and tools alone depend on the model choosing to use them.

### First-class design constraints (not afterthoughts)

The always-on arm buys relevance at a per-turn cost, so the cost controls are part of the spec, not a later tuning pass:

- **Latency budget.** Every synchronous `UserPromptSubmit` recall adds a daemon round-trip to the turn. It must be bounded by a tight `AbortController` timeout (target ~2-3s, tighter than the 5s prime budget) and fail-soft to `""` on timeout, exactly like `prime-renderer.ts:108-116`.
- **Token budget.** Injected hits compete for the model's context. Recall must pass a small `limit` / `tokenBudget` (the `/recall` route already accepts both, `RecallBodySchema` at `api.ts:303-323`) so the floor stays cheap and the ceiling (MCP tools) carries deep recall.
- **Throttling and dedupe.** Recalling on every turn is the most relevant but most expensive option. The recommended posture is a throttled, bounded every-turn recall, deduped against what was already injected this session, so repeated prompts do not re-inject the same hits.
- **Prompt-cache stability.** Injecting different context on every turn perturbs the model host's prompt cache. Dedupe and throttling also protect cache stability, and the trade-off is called out as an open question so it is tuned from data, not guessed.

---

## Goals

- **Per-turn recall exists.** On `UserPromptSubmit`, the user's prompt text is sent to the daemon's existing `POST /api/memories/recall` and the top hits are injected synchronously as `additionalContext`, project-scoped by the session `cwd`.
- **Recall is a first-class Claude Code capability.** The Honeycomb MCP server (already built at `mcp/`) is registered with the Claude Code plugin, so the model has callable `memory_search` / `hivemind_search` / `hivemind_read` / `memory_store` tools, matching the sibling `harnesses/hermes/.mcp.json` registration.
- **The model knows when to recall and store.** A bundled `honeycomb-memory` skill teaches the model to search before non-trivial tasks, cite recalled decisions, and store decisions/preferences with the right memory type. The user gets explicit control via `/recall`, `/remember`, `/forget` slash commands.
- **The floor is cheap and fail-soft.** The synchronous recall is bounded by a tight timeout, carries a small token budget, dedupes against what was already injected this session, and degrades to no injection (never a thrown hook, never a blocked turn) on any daemon failure.
- **No overlap with PRD-075.** This PRD does not touch the `PreToolUse` VFS recall path, the `PreToolDecision` propagation, the shim's pre-tool decision renderer, or the `SessionStart` awareness notice. Those are 075's scope; 076 is the always-on complement and the packaging surface.
- **No new recall engine and no daemon changes for recall.** The always-on arm and the MCP tools both reuse the existing `POST /api/memories/recall` hybrid recall verbatim. No ranker, weighting, or query-shaping changes.

## Non-Goals

- **The on-demand `PreToolUse` recall arm is owned by PRD-075; this PRD is the always-on complement.** 076 does not thread the real `DeepLakeFs` VFS into `runPreToolUse`, does not propagate the discarded `PreToolDecision`, and does not add the shim's pre-tool decision renderer. (075a / 075b.)
- **No `SessionStart` awareness-notice or `honeycomb recall "<query>"` sentinel changes.** Those are 075c. 076 may inject on `UserPromptSubmit`, but the session-start notice and the Bash sentinel verb are out of scope.
- **No new MCP tools and no MCP handler changes.** Sub-PRD B is pure registration/packaging of the existing `mcp/src/tools.ts` surface. It adds, removes, and alters no tool.
- **No daemon recall-engine changes.** `recallMemories` (RRF over `<#>` + `ILIKE`), its arms, ranker, and the `/recall` route are reused verbatim.
- **No change to `SessionStart` prime content.** The blind-dump prime (`session-start.ts` / `prime-renderer.ts`) is untouched. 076 adds a second, per-turn recall arm beside it.
- **No capture-path behavior change.** `PostToolUse` / `Stop` / `SubagentStop` capture is unchanged. The `UserPromptSubmit` capture continues to happen; 076 adds a recall response beside it (or a second synchronous hook entry), it does not remove the capture.
- **No non-claude-code harness rewiring.** The MCP registration follows the hermes precedent, but only the claude-code plugin is wired here. Other harnesses' registration is their own concern.
- **The `memory-recall` subagent is out of scope (stretch only).** A dedicated subagent for deep recall without polluting the main context is noted as a clearly-flagged future/stretch item in 076c, not built.

---

## Code-grounded current state

| # | Fact | Code |
|---|---|---|
| 1 | The ONLY per-session context injection today is the `SessionStart` prime: it renders `noticeBlock` + rules/goals `contextBlock` + the `primeBlock` digest into `additionalContext`. It fires BEFORE any user query, so it cannot be query-aware. | `src/hooks/shared/session-start.ts:199-206` (prime fetch), `:222` (`joinBlocks` compose), `:261` (return `additionalContext`) |
| 2 | Seven Claude Code hooks are registered; `UserPromptSubmit` is `async: true` (fire-and-forget, its stdout is never injected), timeout 10s; `PreToolUse` is synchronous (60s); `SessionStart` is synchronous (30s). | `harnesses/claude-code/hooks/hooks.json:15-25` (UserPromptSubmit block, `async` at `:22`), `:27-37` (PreToolUse sync), `:4-13` (SessionStart sync) |
| 3 | The shim maps `UserPromptSubmit → "user_message"`, which the runtime dispatches to `runCapture` (pure capture, no recall, never sets `additionalContext`). | `src/hooks/claude-code/shim.ts:48` (`CLAUDE_CODE_EVENT_MAP`), `src/hooks/runtime.ts:282-285` (default branch → `runCapture`), `src/hooks/shared/capture.ts:71-108` (`runCapture` returns `{ ok, reason }` only) |
| 4 | The binary's `emitResponse` already injects `additionalContext` for ANY event whose `HookResult` carries it, rendering via the shim's `renderContext` and writing it to stdout; an empty result emits `{}`. So the plumbing for per-turn injection exists; the blocker is that capture produces no block and `async: true` discards stdout. | `src/hooks/binary.ts:164-176` (`emitResponse`; reads `outcome.result.additionalContext` at `:166`, renders at `:168`) |
| 5 | The daemon's hybrid recall route is live: `POST /api/memories/recall` accepts `{ query, limit?, tokenBudget?, recency?, cwd? }`, resolves the project from `cwd`, runs the RRF hybrid recall, and returns scored hits with `degraded` honesty. | `src/daemon/runtime/memories/api.ts:588` (route), `:303-323` (`RecallBodySchema`), `:633` (`recallMemories` call) |
| 6 | `/api/memories` is a SESSION group behind the runtime-path middleware: a request MUST carry `x-honeycomb-runtime-path` AND a non-empty `x-honeycomb-session`, plus tenancy (`x-honeycomb-org` (+ `x-honeycomb-workspace`)), or it is rejected 400/409 before the handler runs. | `src/daemon/runtime/memories/api.ts:29-35` (session-group note), `:379-384` (fail-closed no-org 400) |
| 7 | The existing prime renderer is the exact pattern a query-aware renderer clones: it GETs the daemon over loopback, stamps runtime-path + `x-honeycomb-session` + tenancy headers, bounds the fetch with an `AbortController` timeout, and fails soft to `""`. | `src/hooks/shared/prime-renderer.ts:86-122` (`createPrimeRenderer`), `:96-104` (header stamp), `:108-116` (`AbortController` + fail-soft `""`), `:52` (`DEFAULT_PRIME_TIMEOUT_MS = 5_000`) |
| 8 | The shim's `renderContext` produces a single flat envelope (`model-only → { channel, additionalContext }`); it was built for the session-start injection and is not event-aware. Claude Code accepts `additionalContext` under `hookSpecificOutput` with a matching `hookEventName` per event, so a per-turn injector needs an event-aware envelope. | `src/hooks/normalize.ts:136-138` (`renderContext`), `:149-156` (`renderChannel`, model-only branch at `:151-152`) |
| 9 | The MCP server already exists with the full recall tool surface: `memory_search`, `hivemind_search` (routes to `POST /api/memories/recall`), `hivemind_read` (zoom a ref to summary/raw turns), `memory_store`, `memory_get`/`memory_list`/`memory_modify`/`memory_forget`. It bundles to `mcp/bundle/server.js`. | `mcp/src/tools.ts:77-138` (`TOOL_SPECS`; `memory_search` `:79`, `hivemind_search` `:115-119`, `hivemind_read` `:107-111`), `mcp/src/index.ts:7` (esbuild bundles `mcp/bundle/server.js`) |
| 10 | The Claude Code plugin does NOT register the MCP server: `plugin.json` carries only name/description/version/author/license/keywords, and the plugin bundles only hooks (`hooks/hooks.json`). | `harnesses/claude-code/.claude-plugin/plugin.json:1-14`, `harnesses/claude-code/hooks/hooks.json` (hooks only) |
| 11 | A sibling harness already registers the identical server via a `.mcp.json` (`{ mcpServers: { honeycomb: { command: "node", args: ["mcp/bundle/server.js"], env: {} } } }`). This is the registration precedent and its conformance test. | `harnesses/hermes/.mcp.json:1-10`, `tests/mcp/registration.test.ts` (asserts the artifact registers a `honeycomb` server), `library/knowledge/private/integrations/mcp-and-sdk.md:50-56` (the MCP-via-install convention) |
| 12 | The Claude Code plugin is published through the marketplace manifest whose plugin source is `./harnesses/claude-code`; the hooks config contract is pinned as an executable oracle under `references/claude-code/`. | `.claude-plugin/marketplace.json:10-17`, `references/claude-code/hooks-schema.ts` |

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-076a-always-on-userpromptsubmit-recall`](./prd-076a-always-on-userpromptsubmit-recall.md) | Inject query-aware recall synchronously on `UserPromptSubmit`: a query-parameterized clone of `prime-renderer.ts` that POSTs the user's prompt to `POST /api/memories/recall` (bounded timeout, small token budget, `cwd` scoping, fail-soft `""`), plus the wiring to make a synchronous injector coexist with the existing async capture, plus an event-aware `renderContext` envelope, plus a throttled per-turn reminder companion. The deterministic floor. | Draft |
| [`prd-076b-register-mcp-server-in-plugin`](./prd-076b-register-mcp-server-in-plugin.md) | Register the existing Honeycomb MCP server (`mcp/bundle/server.js`) with the Claude Code plugin, mirroring `harnesses/hermes/.mcp.json`, so the model gets first-class callable recall tools. Registration/packaging only: no new tools, no daemon changes. The biggest single lever. | Draft |
| [`prd-076c-bundle-memory-skill-and-slash-commands`](./prd-076c-bundle-memory-skill-and-slash-commands.md) | Bundle a `honeycomb-memory` skill (teaches the model WHEN/HOW to recall and store, auto-triggered from its description) and `/recall`, `/remember`, `/forget` slash commands (explicit user control + discoverability). The model-driven ceiling that points at the MCP tools from B. | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion |
|---|---|
| m-AC-1 | On the first `UserPromptSubmit` of a chat, the user's prompt text is POSTed to `POST /api/memories/recall` with a bounded `limit`/`tokenBudget` and the session `cwd`, and the top hits are injected synchronously as `additionalContext`. A test drives a recording daemon stub and asserts the query, budget, and `cwd` are forwarded and the hits are rendered into the turn. |
| m-AC-2 | The synchronous recall stamps `x-honeycomb-runtime-path` + `x-honeycomb-session` + tenancy headers (the `/api/memories` session group 400s without them), mirroring `prime-renderer.ts`. A test asserts the header stamp and that a missing-session request is not sent as a bare GET/POST. |
| m-AC-3 | The recall is bounded by a tight `AbortController` timeout (target ~2-3s) and fails soft to `""` (no injection) on timeout, non-200, or malformed body: never a thrown hook, never a blocked turn. A test drives the stub to hang/error and asserts the turn proceeds with no injection. |
| m-AC-4 | The existing `UserPromptSubmit` capture still happens (the turn is still stored). A test asserts capture occurs whether the synchronous injector runs via a second hook entry or a combined synchronous invocation. |
| m-AC-5 | `renderContext` emits the correct per-event envelope: `additionalContext` under `hookSpecificOutput` with the matching `hookEventName` for BOTH `SessionStart` and `UserPromptSubmit`. A test asserts the `UserPromptSubmit` envelope carries `hookEventName: "UserPromptSubmit"` and the session-start envelope is unchanged. |
| m-AC-6 | Per-turn injection is throttled and deduped: hits already injected earlier in the session are not re-injected, and the recall respects a per-turn budget. A test asserts a repeated prompt does not double-inject the same hit. |
| m-AC-7 | The Claude Code plugin registers the Honeycomb MCP server (`mcp/bundle/server.js`) so `memory_search` / `hivemind_search` / `hivemind_read` / `memory_store` appear in the session's tool list, mirroring `harnesses/hermes/.mcp.json`. A test asserts the registration artifact parses and lists a `honeycomb` server pointing at the built bundle, matching the hermes conformance test's shape. |
| m-AC-8 | A `honeycomb-memory` skill is bundled with the plugin, with a description that auto-triggers on memory-relevant work and body guidance on search-before-task, cite-recalled-decisions, and store-with-the-right-type. A test asserts the skill file is present, has valid frontmatter, and is discoverable by the plugin loader. |
| m-AC-9 | `/recall <query>`, `/remember <fact>`, and `/forget` slash commands are bundled with the plugin and invoke the recall/store/forget surface. A test asserts the command files are present with valid frontmatter. |
| m-AC-10 | No PRD-075 surface is touched: `runPreToolUse` still resolves through its module-default fake VFS, the `pre-tool-use` dispatch still returns `{ result }` without a `decision`, the shim has no pre-tool decision renderer, and the `SessionStart` content is byte-for-byte unchanged except where 076a adds the per-turn arm (which does not run on `session-start`). A test asserts the `PreToolUse` path is unchanged. |

---

## Open questions

- **How to make the synchronous injector coexist with the async capturer (076a, load-bearing).** `UserPromptSubmit` is `async: true` today (capture-only, fire-and-forget). Two options: (a) make the single `UserPromptSubmit` hook synchronous and do a fast recall+capture in one invocation, accepting the per-turn latency on the capture too; or (b) register `UserPromptSubmit` TWICE (Claude Code allows multiple hook entries per event) with one synchronous injector entry and one async capturer entry. Option (b) preserves the async capture cost profile and isolates the latency to the injector, but doubles the process spawn per prompt; option (a) is simpler but makes capture synchronous. 076a resolves this against the references gate and records the choice.
- **The per-event `renderContext` envelope (076a).** The current `renderContext` (`normalize.ts:136-156`) emits a flat `{ channel, additionalContext }` shape built for session-start. Claude Code accepts `additionalContext` under `hookSpecificOutput` with a matching `hookEventName`. The renderer must become event-aware without regressing the session-start injection. Confirm the exact `UserPromptSubmit` output contract from the installed harness (references-gate discipline) before writing the envelope.
- **Recall cadence: every-turn vs first-turn-only vs throttled (076a).** Every-turn recall is most relevant but pays a per-turn token+latency cost and perturbs the prompt cache; first-turn-only ("new chat") is cheapest but blind to conversational drift; throttled/deduped-every-turn is the recommended middle. Ship throttled/bounded every-turn with a small `limit`/`tokenBudget` and session-level dedupe; tune the cadence from recall-usage telemetry.
- **Reminder strength (076a).** The strong form is injecting actual recalled memories (above). The weak form is a lightweight, stable, throttled per-turn "you have a searchable memory" nudge. Ship the strong form as primary and the nudge as a cheap companion/fallback for turns where recall returns nothing; the skill (076c) is the smarter, token-cheap reminder that auto-triggers on memory-relevant work.
- **The exact Claude Code plugin MCP-registration mechanism (076b).** Confirm against the references gate whether the plugin registers MCP servers via an `mcpServers` key in `plugin.json` or a bundled `.mcp.json` at the plugin root (the hermes precedent uses a standalone `.mcp.json`). Pick the plugin-contract-correct mechanism and encode it so the registration is checked, not guessed. The `args` path (`mcp/bundle/server.js`) must resolve relative to the installed plugin root, so confirm whether `${CLAUDE_PLUGIN_ROOT}` (as the hooks use) is needed in the args.
- **Skill and command discoverability (076c).** Confirm the plugin loader's `skills/` and `commands/` directory conventions against the references gate so the bundled artifacts are actually discovered. Note the skill description is what auto-triggers it, so the wording is load-bearing and should be tuned from data.
- **Token budget interplay between the floor and the ceiling.** The always-on floor (A) and the MCP-tool ceiling (B) both draw from the same daemon recall. Set the floor's `tokenBudget` small so it stays cheap and let the ceiling carry deep recall; confirm the numbers do not starve either surface.

---

## Out of scope, explicitly

- **The on-demand `PreToolUse` recall path** (real VFS threading, `PreToolDecision` propagation, the shim's pre-tool decision renderer) - owned by PRD-075a / 075b.
- **The `SessionStart` recall-awareness notice and the `honeycomb recall "<query>"` Bash sentinel** - owned by PRD-075c.
- **The `SessionStart` prime-digest content** - untouched; 076 adds the per-turn arm beside it.
- **The daemon-side recall engine** (`recallMemories`, RRF, `<#>` / `ILIKE` arms, ranker) - reused verbatim through the existing `/api/memories/recall` route.
- **New MCP tools or MCP handler changes** - 076b is registration/packaging only.
- **Non-claude-code harness registration** - only the claude-code plugin is wired here.
- **A dedicated `memory-recall` subagent** - noted as a stretch item in 076c, not built.
- **Capture-path behavior on any event** - unchanged.

---

## Prior art

- **PRD-075 (`prd-075-on-demand-recall-command-surface`)** - the on-demand, model-commanded recall arm on the synchronous `PreToolUse` hook. 075 explicitly defers the synchronous, query-aware `UserPromptSubmit` recall as "a separate future PRD" (075 index, "Why the `PreToolUse` surface, not synchronous `UserPromptSubmit`" and Out of scope) and names the MCP surface as "orthogonal ... this PRD does not add, remove, or alter them" (075 Non-Goals). Those two deferrals are exactly this PRD's scope. 076 is the always-on complement plus the packaging surface; the two PRDs are non-overlapping by construction (see this PRD's Non-Goals for the fence).
- **PRD-046 (`prd-046-session-memory-priming`)** + `session-start.ts` / `prime-renderer.ts` - the `SessionStart` blind-dump prime and the `additionalContext` injection path. 076a's query-aware renderer is a query-parameterized clone of `prime-renderer.ts` (same loopback + header-stamp + `AbortController` + fail-soft `""` pattern), and 076a's per-event `renderContext` envelope must preserve the 046 session-start injection unchanged.
- **PRD-019 (`prd-019-harness-integrations`)** - the reference-harness hook runtime (`dispatchLifecycle`), the `HarnessShim` contract and its `renderContext` engine (`normalize.ts`), the binary driver's `emitResponse` (`binary.ts:164-176`) that already injects `additionalContext` for any event that carries it, and the `references/claude-code/` gate the 076a envelope and the 076b registration must conform to.
- **PRD-021e / `harnesses/hermes/.mcp.json`** - the precedent for registering the Honeycomb MCP server with a harness (the `mcpServers.honeycomb → node mcp/bundle/server.js` shape) and its conformance test (`tests/mcp/registration.test.ts`). 076b applies the same registration to the Claude Code plugin.
- **PRD-019d / `mcp/src/tools.ts`** - the existing `honeycomb_*` / `hivemind_*` / `memory_*` tool surface that 076b exposes to Claude Code and 076c's skill and commands point at. No tool is added or changed.

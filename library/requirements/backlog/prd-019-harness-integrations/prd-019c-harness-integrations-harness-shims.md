# PRD-019c: Per-Harness Shims

> **Parent:** [PRD-019](./prd-019-harness-integrations-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** XL

## Scope

The per-harness shims across the full union matrix (Claude Code, OpenClaw, Codex, Cursor, Hermes, pi, OpenCode, Gemini CLI, Oh My Pi) that normalize each harness's event names and payload fields into the shared core shape and route daemon responses back through each harness's response format. This sub-PRD owns the per-harness divergences only: event-name maps, payload normalization, context-injection channel, host CLI for summaries, async pattern, and CLI fallbacks. The shared core and the logical contract live in 019b; the install-time wiring lives in 019a.

## Goals

- A shim per harness in the union matrix that overrides only what differs from the Claude Code reference, so capture and recall behave identically across harnesses.
- A normalized mapping from each harness's native event vocabulary to the logical lifecycle events, completing the lifecycle even where events are missing.
- A normalized `additionalContext` channel per harness (model-only vs user-visible) so the same context lands correctly everywhere.
- A CLI fallback for harnesses that cannot intercept a write, so goal and KPI routing is never dropped.

## Non-Goals

- The shared core modules and the logical contract (019b).
- The install-time connector base (019a).
- The MCP server (019d) and SDK (019e).
- The Cursor editor extension UX surface (PRD-020c); only the Cursor hook shim is in scope here.

## User stories

- As a user on any supported harness, I want capture and recall to behave identically so that switching harnesses does not change my memory experience.
- As a user on a harness with no pre-tool hook, I want goal and KPI commands to still work so that routing is never silently dropped.
- As an integration engineer, I want each shim to be a thin override so that a new harness is a small subdirectory, not a fork of the engine.

## Functional requirements

- FR-1: Claude Code is the reference shim (marketplace plugin + hooks + MCP); it implements `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`/`SubagentStop`, and `SessionEnd` against the shared core and is the baseline every other shim is verified against.
- FR-2: Each non-reference shim lives under `src/hooks/<harness>/` and overrides only event names, payload shape, context channel, host CLI, and async pattern; shared logic stays in the core modules from 019b.
- FR-3: Codex shim maps `SessionStart`, `UserPromptSubmit`, `PreToolUse(Bash)`, `PostToolUse`, `Stop` onto the contract; it defers `autoUpdate` and table-ensure to a detached `session-start-setup.ts`, injects only a brief login-state line (its hook context is user-visible), and intercepts Bash only.
- FR-4: Cursor shim maps `sessionStart`, `beforeSubmitPrompt`, `postToolUse`, `afterAgentResponse`, `stop`, `sessionEnd`; it uses the `additional_context` key and `workspace_roots` for cwd, intercepts the `Shell` tool for VFS recall, and shells `cursor-agent` for summaries with a fallback to `claude`.
- FR-5: OpenClaw shim (native extension flagship + connector) batches capture at `agent_end`, sending only the slice of new messages since the previous flush; it auto-routes the agent from the session key (`agent:alice:...`), maps `before_agent_start` + `before_prompt_build` to session-start, and has no `PreToolUse` (tools are registered).
- FR-6: Hermes shim (skill + shell hooks + MCP) maps `on_session_start`, `on_user_message`, `on_tool_use` (terminal only), `on_session_end`; it emits a `{ context: "..." }` output with the full block and an MCP-tools mention, and shells `hermes` non-interactively for summaries.
- FR-7: pi shim (extension + `AGENTS.md` block) injects context via the static `AGENTS.md` block, maps `agent_end` and `session_shutdown`, runs on-demand recall, has no `PreToolUse`, and shells `pi --print --provider <p> --model <m>` for summaries; the extension entry point lives at `harnesses/pi/extension-source/honeycomb.ts`.
- FR-8: OpenCode shim (bundled runtime plugin + hooks) handles lifecycle in-process and syncs `AGENTS.md`; Gemini CLI shim (MCP + `GEMINI.md` sync) provides on-demand tools plus identity sync; Oh My Pi shim (managed extension) fails open on daemon errors and injects context outside the transcript.
- FR-9: For any harness without a write-intercept hook, goal and KPI routing falls back to a CLI call (`honeycomb goal ...`, `honeycomb kpi ...`) rather than dropping the action.
- FR-10: Each shim stamps the correct `x-honeycomb-runtime-path` for its surface (plugin for runtime extensions, legacy for hook scripts) and normalizes its `additionalContext` channel (model-only vs user-visible) before handoff.
- FR-11: The references gate applies per harness: before changing a shim, the engineer inspects the sibling repo under `references/<harness>/` for the exact event names, payloads, and runtime behavior.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given each harness in the matrix, when its session runs, then capture, recall, and summary spawn produce the same daemon-written rows as the Claude Code reference. |
| AC-2 | Given a harness cannot intercept a write (no pre-tool hook), when goal or KPI routing is needed, then the shim falls back to a CLI call rather than dropping the action. |
| AC-3 | Given OpenClaw fires `agent_end`, when the shim runs, then only the new-message slice since the last flush is sent and the resulting rows match incremental capture. |
| AC-4 | Given Codex session-start, when it runs, then `autoUpdate` and table-ensure happen in a detached setup process and only a brief login-state line is injected. |
| AC-5 | Given a model-only context channel and a user-visible one, when each shim injects context, then the same logical block lands through the correct channel for that harness. |
| AC-6 | Given a shim change, when it is reviewed, then it references the sibling repo under `references/<harness>/` for the protocol it relies on. |

## Implementation notes

- The divergences are real but shallow: event names and payload fields vary and the `additionalContext` channel differs; each shim normalizes before handing off to the shared core, which owns all memory decisions, SQL, embeddings, and locking.
- Only the summary worker is under `src/hooks/pi/` because pi's extension entry point is pi-specific TypeScript pi compiles directly; the rest of the pi behavior lives in the extension source.
- Host CLI for summaries by harness: `claude -p` (Claude Code), `codex exec --dangerously-bypass-approvals-and-sandbox` (Codex), `cursor-agent`/`claude` (Cursor), `hermes` non-interactive (Hermes), `pi --print` (pi).

## Dependencies

- PRD-019b shared core and logical contract.
- PRD-019a connector base for install-time wiring of each shim.
- PRD-020a CLI for the goal/KPI fallback path.
- Sibling harness repos under `references/<harness>/` for the references gate.

## Open questions

- [ ] Which harnesses get a native runtime extension versus hooks-only, and where does the line sit for new entrants?
- [ ] Should the `additionalContext` model-only vs user-visible difference be normalized or surfaced per harness?

## Related

- [parent index](./prd-019-harness-integrations-index.md)
- [Harness Integration](../../../knowledge/private/integrations/harness-integration.md)
- [Hook Lifecycle](../../../knowledge/private/integrations/hook-lifecycle.md)

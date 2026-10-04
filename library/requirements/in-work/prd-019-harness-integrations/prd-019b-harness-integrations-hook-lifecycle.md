# PRD-019b: Lifecycle Hook Contract

> **Parent:** [PRD-019](./prd-019-harness-integrations-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** L

## Scope

The normalized lifecycle hook contract spanning session-start, user-prompt-submit, pre-tool-use, post-tool-use, assistant-response, and session-end, that every harness shim maps its native event vocabulary onto and that calls the daemon's `/api/hooks/*`. This sub-PRD owns the shared core modules that normalize payloads and call the daemon, the per-event responsibilities, and the rule that hooks are thin clients. It does not own per-harness event-name maps and payload shapes (019c) or the install-time connector that writes the handlers (019a).

## Goals

- One logical event contract (session-start, prompt capture, pre-tool VFS recall, post-tool capture, assistant-response capture, session-end summary) that every shim maps onto.
- A set of agent-agnostic shared core modules that read credentials, normalize the payload, and make a local daemon request, holding all memory logic out of the per-harness code.
- A lifecycle that stays functionally complete even on harnesses with a partial event vocabulary, for example batched capture at session end, without dropping rows.
- The `x-honeycomb-runtime-path` header on every hook call so the daemon scopes the surface and enforces one active path per session.

## Non-Goals

- Per-harness event-name and payload-field divergences (019c).
- The install-time writing of handlers and config (019a).
- Daemon-side capture writes, retrieval ranking, summary generation, and DeepLake access (owned by the daemon and engine modules).
- MCP (019d) and SDK (019e) on-demand surfaces.

## User stories

- As a shim author, I want one logical event contract so that I only map my harness's native names rather than reimplementing memory logic.
- As a user on a harness with few hook events, I want capture to still happen so that my session is fully recorded.
- As a security reviewer, I want hooks to never open DeepLake or build SQL so that the trust boundary stays at the daemon.

## Functional requirements

- FR-1: The contract defines six logical events: session-start / recall inject, prompt capture (`user_message`), pre-tool intercept (VFS recall), post-tool capture (`tool_call`), assistant-response capture (`assistant_message`), and session-end / summary spawn. Each shim maps native names onto these.
- FR-2: Every hook reads the device-flow credential from `~/.honeycomb/credentials.json`, normalizes the agent payload into the shared `HookInput` shape, and makes a local request to the daemon on port 3850; it never builds SQL or holds a DeepLake handle.
- FR-3: Session-start runs, in order: load credentials (prompt login or continue read-only by harness policy), `healDriftedOrgToken`, `autoUpdate`, ensure `memory` and `sessions` tables, write a placeholder summary row, render the rules/goals context block, `autoPullSkills`, spawn the graph-pull worker, and return `additionalContext`. Steps 4 and 5 are gated on `HONEYCOMB_CAPTURE !== "false"`.
- FR-4: Per-turn capture sends one request per event and the daemon writes one row per event to the `sessions` table; each request carries session metadata (session id, cwd, permission mode, hook event name, agent id) and an optional `message_embedding` vector. On a missing-table error it creates the table and retries once.
- FR-5: The pre-tool-use hook is the VFS intercept: Bash/Read/Grep/Glob calls on the memory path are resolved by the daemon (`cat`/`Read` to a row read, `grep`/`Glob` to hybrid lexical-plus-semantic search, `ls` to prefix listing, `find` to pattern query); Write/Edit on a memory path is denied with guidance; unmodelable commands are rewritten to a harmless `echo`.
- FR-6: Session-end exits fast and pushes work to detached processes: `markSessionEnded`, `recordSessionUsage`, `forceSessionEndTrigger` (skillify), then acquire the per-session summary lock and spawn the detached summary worker with reason `SessionEnd`. If the spawn throws before the worker takes ownership, the lock is released so `--resume` can retrigger.
- FR-7: For a harness with a partial event vocabulary, the contract still completes: capture batched at session end (for example OpenClaw's `agent_end` message batch) produces the same daemon-written rows as incremental capture, just grouped into one flush.
- FR-8: Every hook call stamps `x-honeycomb-runtime-path` (`plugin` or `legacy`); the daemon enforces one active runtime path per session and returns `409` on conflict.
- FR-9: Shared core modules (`capture.ts`, `session-start.ts`, `pre-tool-use.ts`, `session-end.ts`, `wiki-worker.ts`, `spawn-wiki-worker.ts`, `shared/context-renderer.ts`, `shared/capture-gate.ts`, `summary-state.ts`) are agent-agnostic; the per-harness shim only normalizes in and routes out.
- FR-10: The capture gate (`HONEYCOMB_CAPTURE !== "false"`) and the only-CLI-entrypoint check guard every capture path; the context renderer is read-only and absorbs its own errors.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a harness with a partial event vocabulary, when a logical event has no native equivalent, then the contract still completes the lifecycle (for example batched capture at session end) without dropping rows. |
| AC-2 | Given any lifecycle event fires, when the hook runs, then it reads credentials, normalizes the payload, and makes a local daemon request without opening DeepLake or building SQL. |
| AC-3 | Given session-start runs with capture enabled, when it completes, then tables are ensured, a placeholder row is written, the context block is rendered, and `additionalContext` is returned. |
| AC-4 | Given a pre-tool Bash `grep` on the memory path, when the hook runs, then the result is the daemon's hybrid search output and nothing reaches the real filesystem. |
| AC-5 | Given a session ends, when session-end runs, then it marks the session ended, records usage, fires skillify, and spawns the detached summary worker under the per-session lock. |
| AC-6 | Given two runtime paths attempt the same session, when the second call lands, then the daemon returns `409` and only one path stays active. |

## Implementation notes

- Hooks are thin clients: the daemon runs capture, recall, the memory pipeline, skillify, and summary generation, and is the only DeepLake client. The hook states what happened and lets the daemon decide what to persist and return.
- The pre/post-compaction events map onto the same capture and summary machinery; the compaction payload shape is pinned per harness in 019c.
- Detached summary work uses the host CLI (`claude -p`, `codex exec`, `cursor-agent`, `pi --print`) selected by the shim; the worker reads session rows via the daemon and writes the summary back to the `memory` table.

## Dependencies

- PRD-019a for the connector that installs these handlers.
- PRD-019c for per-harness event-name maps and payload normalization.
- Daemon `/api/hooks/*` endpoints, runtime-path enforcement, and the `409` conflict rule.
- Engine session-capture and retrieval modules (daemon side).

## Open questions

- [ ] Should the pre/post-compaction payload shape be unified across harnesses or pinned per harness?
- [ ] Should the `additionalContext` channel difference (model-only vs user-visible) be normalized or surfaced per harness?

## Related

- [parent index](./prd-019-harness-integrations-index.md)
- [Hook Lifecycle](../../../knowledge/private/integrations/hook-lifecycle.md)
- [Harness Integration](../../../knowledge/private/integrations/harness-integration.md)

# PRD-005a: Capture Endpoint

> **Parent:** [PRD-005](./prd-005-capture-intake-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

Build the daemon capture API that accepts a turn event from a harness shim and writes exactly one `sessions` row with the event stored as a `JSONB` message. The endpoint lives on the Honeycomb daemon (port 3850), the only component that talks to the DeepLake GPU-backed SQL/Vector store. The shim states what happened; the daemon owns the write. Capture is the cheap, always-on front of the system: it records the event, bumps per-turn counters, and returns before any model runs.

## Goals

- Accept a normalized turn event over HTTP from a harness shim and INSERT exactly one `sessions` row per event into DeepLake via the daemon.
- Store the event payload as a `JSONB` `message` so the original structured shape (prompt text, tool input, tool response) survives intact for later extraction.
- Group rows into a conversation by a shared `path`, read back ordered by `creation_date`.
- Thread `org`, `workspace`, and `agent_id` onto every row so capture stays inside the right tenancy and scope.
- Bump per-turn counters that cue the skillify miner and summary worker without running either inline.

## Non-Goals

- Embedding attachment (PRD-005b) and the capture guards (PRD-005c).
- The distillation pipeline that reads `sessions` (PRD-006) and retrieval (PRD-007).
- Running the summary or skillify workers inline; capture only records and cues.

## User stories

- As a harness shim, I want to POST a structured event so that the daemon durably records it without my touching DeepLake.
- As an extraction worker, I want each event preserved as structured JSON so that I can decompose the original shape rather than re-parsing flattened prose.
- As an operator, I want one row per event so that concurrent writes never race on a shared row.

## Functional requirements

- **FR-1** The daemon SHALL expose a capture route under its hook/capture surface (scaffolded in PRD-004) that accepts a single normalized turn event per request.
- **FR-2** The endpoint SHALL handle three event kinds: `user_message` (prompt text), `tool_call` (tool name, input, response), and `assistant_message` (the assistant's last message).
- **FR-3** For each accepted event the daemon SHALL INSERT exactly one `sessions` row and SHALL NOT concatenate or append into an existing row.
- **FR-4** The endpoint SHALL store the event payload in the `message` column as `JSONB`, preserving the original structured shape.
- **FR-5** Each row SHALL carry session metadata: session id, `path`, cwd, permission mode, hook event name, and `agent_id`, plus `org` and `workspace` scope.
- **FR-6** A conversation SHALL be defined as the set of `sessions` rows sharing a `path`, returned ordered by `creation_date`.
- **FR-7** If the daemon reports the `sessions` table does not yet exist, the endpoint SHALL create the table and retry the INSERT exactly once.
- **FR-8** On a turn-terminating event the endpoint SHALL bump the per-turn counters that cue the summary worker and skillify miner, queued to the daemon, without running them inline.
- **FR-9** All values interpolated into a DeepLake query SHALL route through the `sqlStr`/`sqlLike`/`sqlIdent` escaping helpers, since the store has no parameterized queries.
- **FR-10** The endpoint SHALL accept events from any supported harness (Claude Code, Codex, Cursor, OpenClaw, Hermes, pi) given a normalized payload, including OpenClaw's batched `messages` slice.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a posted event, when the endpoint handles it, then it INSERTs one `sessions` row with a `JSONB` `message` and a `path` that groups the conversation. |
| AC-2 | Given multiple events in a turn, when each is captured, then each becomes its own row, never concatenated. |
| AC-3 | Given an event, when the row is written, then it carries session id, cwd, permission mode, hook event name, agent_id, org, and workspace. |
| AC-4 | Given the sessions table does not exist, when capture runs, then the daemon creates it and retries the INSERT once. |
| AC-5 | Given a turn-terminating event, when capture completes, then the per-turn counters are bumped without the summary or skillify worker running inline. |
| AC-6 | Given a conversation, when its rows are read back, then they are returned ordered by creation_date and scoped to the requesting org/workspace. |

## Implementation notes

- The single-INSERT rule is deliberate: concatenation was the source of a write race the summary worker once hit, and appending discrete rows sidesteps it entirely. The shim never touches storage; the daemon owns the write to DeepLake.
- Capture is the input half of the request lifecycle; it must commit durably and return fast, before any model runs. Distillation is decoupled and asynchronous so a slow extractor never costs a captured event.
- Capture bumps per-turn counters that cue background workers but does not run them inline. The Stop-event path additionally asks the daemon to evaluate `tryStopCounterTrigger`, which may fire the skillify miner independently of the summary worker.
- The `sessions` table is the one defined in PRD-003c; this module only writes to it. Embedding attachment is layered on in PRD-005b.

## Dependencies

- PRD-003c (`sessions` table schema) and PRD-004 (daemon route surface and counters).
- The Honeycomb daemon on port 3850 as the sole DeepLake client.
- Harness shims that normalize per-agent payloads (PRD hook lifecycle integration).

## Open questions

- [ ] What exact event payload contract (field names, required vs optional) does the daemon accept per kind?
- [ ] What per-turn counter thresholds cue the summary worker (message count versus time) and the skillify miner (every N turns)?

## Related

- [parent index](./prd-005-capture-intake-index.md)
- [Session Capture](../../../knowledge/private/ai/session-capture.md)
- [Hook Lifecycle](../../../knowledge/private/integrations/hook-lifecycle.md)
- [Schema](../../../knowledge/private/data/schema.md)

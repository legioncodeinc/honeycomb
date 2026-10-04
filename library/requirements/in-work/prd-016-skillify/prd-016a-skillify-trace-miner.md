# PRD-016a: Trace Miner and Gate

> **Parent:** [PRD-016](./prd-016-skillify-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Scope

The skillify worker's mining front half: fetch candidate sessions in scope past the watermark, extract prompt/answer pairs (stripping tool calls and thinking), build the gate prompt, and run the gate model that returns KEEP, MERGE, or SKIP.

## Goals

- Trigger mining from a per-project stop-counter every N turns plus an unconditional session-end pass, all owned by the daemon.
- Fetch the right candidate sessions for the configured scope, past the watermark, excluding the in-flight triggering session.
- Extract clean prompt/answer pairs, dropping tool calls and thinking, capped so the gate prompt stays bounded.
- Run a gate model with a precision-over-recall stance that returns exactly one of KEEP, MERGE, or SKIP.

## Non-Goals

- Writing the skill file or recording the `skills` row and advancing the watermark (PRD-016b).
- Pull, auto-pull, and symlink fan-out (PRD-016c).
- The session-capture pipeline that produces the transcripts (consumed here; owned elsewhere).

## User stories

- As a team, I want recurring session patterns mined and gated so that only genuinely reusable, non-obvious knowledge becomes a skill.
- As a developer, I do not want a half-captured in-flight session mined so that mining only sees settled transcripts.
- As an operator, I want mining to use my own harness CLI so that no separate API key is needed.

## Functional requirements

- **FR-1 Daemon-owned worker.** The skillify worker runs inside the honeycomb daemon (port 3850) as a background job. Hooks never run the worker or talk to DeepLake; they signal the daemon, which owns both.
- **FR-2 Stop-counter and session-end triggers.** A per-project counter increments after each `Stop` event; when it reaches `HONEYCOMB_SKILLIFY_EVERY_N_TURNS` (default 20) it resets and asks the daemon to run. The session-end trigger fires unconditionally at `Stop`/`SessionEnd`. Counter state lives at `~/.honeycomb/state/skillify/<project-key>.json`, keyed by the SHA-1 of `git config remote.origin.url` (or the absolute path for non-git dirs).
- **FR-3 Worker lock.** A file-based worker lock prevents two concurrent skillify runs for the same project; it is released in the worker's `finally` block.
- **FR-4 Fetch candidate sessions.** The worker queries the `sessions` table for the last 10 sessions in scope, ordered by most recent message timestamp, through the daemon, scoped by `org`, `workspace`, and `agent_id`.
- **FR-5 Scope filter.** Scope `me` filters to `author = <userName>`; scope `team` with a populated team list filters to `author IN (<team>)`. Filter values are escaped with `sqlStr` because DeepLake has no parameterized queries.
- **FR-6 Watermark and self-exclusion.** The watermark (`state.lastDate`) prevents re-mining processed sessions, and candidates exclude the session that triggered the worker, which is not yet fully captured.
- **FR-7 Extract pairs.** Each session's rows pass through `extractPairs()` which pairs each user prompt with the agent's next assistant message, drops tool calls and thinking blocks, and returns `Pair[]` objects carrying session ID and agent label.
- **FR-8 Bound the prompt.** Pairs are rendered into a text block capped at 2,000 characters per pair and 40,000 characters total, alongside the existing project skills capped at 30,000 characters.
- **FR-9 Gate verdict.** The gate prompt instructs the model to return exactly one of `KEEP <name> <body>`, `MERGE <existing-name> <merged-body>`, or `SKIP <reason>`. KEEP fires only when the pattern recurs across at least three exchanges, is non-obvious, and is not already covered; the precision-over-recall stance is explicit (a false skill erodes trust).
- **FR-10 Host-CLI gate call.** The gate shells out to the host agent's own CLI (claude_code, codex, cursor, hermes) synchronously with a 120-second timeout, reading the verdict from `verdict.json` in the run's temp dir or falling back to parsing stdout JSON.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given the last 10 in-scope sessions past the watermark, when mining runs, then pairs are extracted (tool calls and thinking dropped), capped at 2,000 chars/pair and 40,000 total, excluding the triggering session. |
| AC-2 | Given the gate prompt, when the model responds, then it returns exactly one of KEEP, MERGE, or SKIP, with KEEP requiring recurrence across at least three exchanges. |
| AC-3 | Given the stop-counter reaches `HONEYCOMB_SKILLIFY_EVERY_N_TURNS`, when a Stop event fires, then the counter resets and the daemon runs the worker; session-end fires it unconditionally. |
| AC-4 | Given scope `team` with a team list, when candidates are fetched, then they filter to `author IN (<team>)` with values escaped via `sqlStr`. |
| AC-5 | Given a concurrent run is already in flight for the project, when a new trigger arrives, then the worker lock suppresses the second run. |
| AC-6 | Given the gate CLI exceeds 120 seconds, when it times out, then the run aborts without writing a verdict and the lock is released in `finally`. |

## Implementation notes

- Scope is `me` (author filter) or `team` (author IN list); filter values escaped with `sqlStr`; all reads scoped by org/workspace/agent_id and dispatched through the daemon.
- Gate shells out to the host agent's own CLI per the matrix in the grounding doc (claude `--model haiku --permission-mode bypassPermissions`, codex `exec --dangerously-bypass-approvals-and-sandbox`, cursor `cursor-agent --print`, hermes `-z ... --yolo`).
- The project key isolates counters so heavy use in one repo never triggers premature mining in another.

## Dependencies

- The honeycomb daemon (port 3850) as the only DeepLake client.
- The `sessions` table and the session-capture pipeline.
- PRD-016b consumes this module's verdict.

## Open questions

- [ ] Should the default `HONEYCOMB_SKILLIFY_EVERY_N_TURNS` (20) be tunable per-workspace as well as per-env?

## Related

- [parent index](./prd-016-skillify-index.md)
- [Skillify Pipeline](../../../knowledge/private/ai/skillify-pipeline.md)

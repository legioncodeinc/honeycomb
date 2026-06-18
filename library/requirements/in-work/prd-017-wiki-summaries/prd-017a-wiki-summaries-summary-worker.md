# PRD-017a: Summary Worker

> **Parent:** [PRD-017](./prd-017-wiki-summaries-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Scope

The daemon-owned background summary worker plus the host-harness gate CLI generation that writes the markdown. Hooks signal the daemon on final and periodic triggers; the daemon fetches events, shells the matching gate CLI, embeds, and writes the summary row.

## Goals

- Run a daemon-owned summary worker on final and periodic triggers, with per-session locking so at most one runs per session.
- Generate the summary with the host harness's own CLI so no separate API key is needed and the summary matches the operator's model.
- Embed each summary with a 768-dim vector and write it to the `memory` table via SELECT-before-INSERT.
- Stay resilient to DeepLake eventual consistency: retry on empty events, never strand placeholders, treat embedding failure as non-fatal.

## Non-Goals

- Synthesizing `MEMORY.md` and thread heads from the per-session summaries (PRD-017b).
- The retrieval ranking that consumes the summary embeddings (owned by the retrieval module).
- Session capture row writes (owned by session-capture).

## User stories

- As an agent operator, I want each session summarized by my own harness CLI so that no separate API key is required and summaries match my model.
- As an agent, I want a session summarized exactly once at end and periodically mid-session so that recall stays fresh without duplicates.
- As an operator, I want a summary still written when DeepLake reads lag so that heavy load does not silently drop summaries.

## Functional requirements

- **FR-1 Daemon-owned worker.** The summary worker runs inside the honeycomb daemon (port 3850), the only DeepLake client. Hooks signal the daemon; they never spawn the worker or open DeepLake.
- **FR-2 Final and periodic triggers.** Final fires once per session at `Stop`, `SessionEnd`, or `session_shutdown`. Periodic fires mid-session when messages since the last summary reach `HONEYCOMB_SUMMARY_EVERY_N_MSGS` (default 50) OR elapsed time reaches `HONEYCOMB_SUMMARY_EVERY_HOURS` (default 2), checked in `maybeTriggerPeriodicSummary()`.
- **FR-3 Per-session lock.** A lock file at `~/.claude/hooks/summary-state/<sessionId>.lock` prevents two concurrent runs for the same session; an in-flight run suppresses a new trigger, and the lock is released in the worker's `finally` block.
- **FR-4 Sidecar counter.** A sidecar JSON at `~/.claude/hooks/summary-state/<sessionId>.json` tracks `{ lastSummaryAt, lastSummaryCount, totalCount }`, shared across agents (session IDs are UUIDs), never deleted so `--resume`/`--continue` picks up the count.
- **FR-5 Fetch events with retry.** The worker selects all session rows ordered by `creation_date` ascending using the `sqlLike` escaper (DeepLake has no bind params), retrying with linear backoff up to `HONEYCOMB_WIKI_EVENT_RETRIES` (default 5) at `HONEYCOMB_WIKI_EVENT_BACKOFF_MS` (default 1500 ms) to tolerate eventual consistency.
- **FR-6 No orphan placeholder.** If no events appear after all retries, the worker removes the "in progress" placeholder row, guarded by `AND description = 'in progress'` so a concurrent real summary is never clobbered.
- **FR-7 Resume offset.** For resumed sessions, the worker reads the prior summary's `**JSONL offset**: N` marker and passes it to the gate prompt so the model focuses on events since the last checkpoint.
- **FR-8 Host-CLI generation.** The worker shells the host harness's gate CLI (claude_code, codex, cursor, hermes, pi) with a 120-second timeout, which writes `summary.md` to the run's temp dir. The daemon selects the invocation by the host agent that triggered the session.
- **FR-9 Capture-loop guard.** The gate subprocess environment sets `HONEYCOMB_WIKI_WORKER=1` and `HONEYCOMB_CAPTURE=false` so the gate call does not trigger its own capture loop.
- **FR-10 Embed and write.** If `summary.md` is non-empty, the worker embeds via `EmbedClient.embed(text, "document")` (768-dim `nomic-embed-text-v1.5`, returns null when disabled) and the daemon writes to the `memory` table at `/summaries/<userName>/<sessionId>.md` via SELECT-before-INSERT, storing a `description` excerpt and the embedding (or NULL). Embedding failure is non-fatal: log, write NULL, proceed. After a successful write, `finalizeSummary(sessionId, jsonlLines)` updates the sidecar baseline.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given the daemon receives a summary trigger, when it fetches session events and they are present, then it shells the host harness's gate CLI and writes the generated summary to the `memory` table at `/summaries/<userName>/<sessionId>.md`. |
| AC-2 | Given the gate CLI subprocess runs, when it spawns, then `HONEYCOMB_WIKI_WORKER=1` and `HONEYCOMB_CAPTURE=false` are set so the gate call does not trigger its own capture loop. |
| AC-3 | Given DeepLake read consistency lags the write, when the worker finds no events, then it retries with linear backoff up to the configured limit before removing the in-progress placeholder. |
| AC-4 | Given a periodic threshold (messages or hours) is crossed, when capture records the event, then the daemon runs at most one concurrent summary per session via the per-session lock. |
| AC-5 | Given `EmbedClient.embed()` throws, when the summary is written, then NULL is stored for the embedding and the write still succeeds. |
| AC-6 | Given an existing summary row, when the worker writes, then it uses SELECT-before-INSERT keyed on `path` rather than an in-place UPDATE. |

## Implementation notes

- The worker is owned by the daemon; hooks only signal it. The daemon selects the gate invocation per harness and serializes a `WorkerConfig` per run. Gate matrix: claude `-p ... --no-session-persistence --model <model>`, codex `exec --dangerously-bypass-approvals-and-sandbox`, cursor `cursor-agent --print --model <model>`, hermes `-z ... --yolo --ignore-user-config`, pi `--print --provider <provider> --model <model>`.
- Writes are keyed on `path` via SELECT-before-INSERT because DeepLake coalesces UPDATEs against freshly written rows. The daemon `query()` helper retries on 401/403/429/500/502/503 with exponential backoff up to 30s plus jitter.
- Worker activity logs to `~/.claude/hooks/wiki.log`.

## Dependencies

- The honeycomb daemon (port 3850) as the only DeepLake client.
- The `sessions` and `memory` tables and the embed worker.
- The session-capture pipeline that records events.

## Open questions

- [ ] Should periodic and final triggers share one config or diverge per harness?

## Related

- [parent index](./prd-017-wiki-summaries-index.md)
- [Wiki Summary Workers](../../../knowledge/private/ai/wiki-summary-workers.md)

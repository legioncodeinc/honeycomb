# Changelog

## v0.13.0 — 2026-07-12

Adds a durable local outbox that safely queues and later retries memory writes when the storage backend hits transient failures, so distilled memories are no longer dropped during degraded windows. Also introduces a new `honeycomb memory redrive` command and diagnostics endpoint to recover previously lost memories, plus improved health/observability reporting for the outbox backlog.

## v0.12.2 — 2026-07-11

Fixed a bug where dedup-probe failures during memory writes were logged as an opaque, undiagnosable error; now the real (secret-safe) HTTP status and error message are surfaced for easier troubleshooting.

## v0.12.1 — 2026-07-11

Fixes a bug where a batched flush window mixing rows with different column shapes (e.g. a plain user turn and an assistant turn with usage data) could be wholesale rejected and dropped; such rows are now grouped by column shape so all events are reliably persisted.

## v0.12.0 — 2026-07-11

Adds dead-lettering, recovery-triggered drain, a new `honeycomb capture drain` command, and configurable caps/coalescing/back-pressure for the durable capture retry queue, making it more resilient and observable during backend outages.

## v0.11.0 — 2026-07-11

Captures that fail to write due to a temporary backend outage are now queued in a durable local retry outbox and automatically re-sent once the backend recovers, instead of being silently lost. Adds a new `/health` capture-outbox backlog indicator for visibility into pending/retrying captures.

## v0.10.1 — 2026-07-11

Fixed a bug where the daemon's local job queue could be created in different directories depending on the launch working directory, causing pending memory-pipeline jobs to be silently orphaned after a restart. The queue is now anchored to a fixed fleet-wide location so it's reliably found across restarts.

## v0.10.0 — 2026-07-11

Adds an in-daemon local ANN vector index that dramatically speeds up per-turn memory recall, with automatic fallback to the previous behavior when disabled or not yet built. Includes a new HONEYCOMB_LOCAL_ANN_INDEX configuration flag (on by default) and improved recall observability.

## v0.9.0 — 2026-07-09

Adds a fast, single-round-trip recall path for per-turn memory lookups (opt-in via a `fast` flag), with dedicated concurrency, deadlines, and load-shedding so per-turn recall stays within its latency budget without changing the existing heavy recall behavior.

## v0.8.0 — 2026-07-08

Adds a self-healing Claude Code plugin connector that automatically detects and repairs harness wiring, plus a new `honeycomb harness status|connect|repair` CLI command and dashboard status reporting. Also fixes plugin packaging so `.mcp.json`, skills, and commands are correctly included in the published Claude Code plugin.


## v0.7.0 — 2026-07-08

Adds always-on, query-aware memory recall on each prompt, registers the Honeycomb MCP server with the Claude Code plugin, and bundles a honeycomb-memory skill plus /recall, /remember, and /forget slash commands. Also fixes packaging so the MCP server bundle ships inside the Claude Code plugin.

## v0.6.2 — 2026-07-08

Adds an internal diagnostic log (enabled via HONEYCOMB_DEBUG_WAKE) that records which requests wake or reset the daemon's hibernation idle timer, to help troubleshoot unexpected wake-ups.

## v0.6.1 — 2026-07-06

Fixed the dashboard's harness activity endpoint to no longer show under-reported turn counts caused by stale DeepLake read replicas, by polling and taking the highest observed value.


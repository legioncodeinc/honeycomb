# Changelog

## v0.20.0 — 2026-07-13

The embed supervisor's restart budget now self-heals over sustained uptime and automatically retries with backoff after hitting a terminal failed state, instead of requiring a manual daemon restart. The daemon's /health endpoint also gains a new embedSupervisor block reporting live restart-budget and recovery status, and supervisor lifecycle events are now logged.

## v0.19.1 — 2026-07-13

Fixed a security hardening issue where very large search queries could produce unbounded, resource-intensive SQL statements; query text is now length-capped and sanitized before being used in searches, with no change to normal search results.

## v0.19.0 — 2026-07-13

Memory-graph persistence now follows a single, vault-first `graph.enabled` setting (defaulting to the memory-formation switch) that can be toggled live without a restart, and the memory-graph dashboard view now reports why it's empty (gate off, nothing extracted yet, or a read error).

## v0.18.0 — 2026-07-13

Recall search now finds any memory visible in the list under the same scope, including workspace inbox rows in project-scoped views, and search hits carry actionable memory id/type for richer dashboard cards. Also fixes lexical search to match multi-word queries via tokenized matching instead of requiring an exact phrase.

## v0.17.0 — 2026-07-12

Provider/API key and settings changes (e.g. memory toggle, model selection, Portkey config) now take effect live via an in-process reload instead of requiring a daemon restart, and project onboarding binds correctly track workspace/org switches after boot.

## v0.16.0 — 2026-07-12

Improves recall and health reliability when the local embeddings model becomes unresponsive: `/health` now reports a live, honest embeddings state (including a new 'suspect' status) instead of falsely reporting 'on', and semantic recall automatically skips embedding attempts and falls back to lexical search when the embedder isn't warm, avoiding slow timeouts.

## v0.15.0 — 2026-07-12

Fixes a fresh-install bug where an enabled Portkey gateway with no active model could silently POST empty-model requests that always failed; the gateway now fails closed with an honest `no_model` health state, and `/health` also reports swallowed extraction errors so stalled memory formation is visible.

## v0.14.0 — 2026-07-12

Adds a new measured injected-tokens KPI and real ROI trend/partial-net data to the dashboard, backed by new memory-injection telemetry; also includes a small internal SQL-naming fix.

## v0.13.1 — 2026-07-12

Fixes several daemon and CLI bugs: the pollinate status now correctly reports below-threshold instead of misleadingly showing 'running', the cursor-agent login check performs a real status probe, project registry sync no longer produces duplicate entries, and memory lifecycle routes (conflicts, stale-refs, history) are no longer incorrectly shadowed.

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


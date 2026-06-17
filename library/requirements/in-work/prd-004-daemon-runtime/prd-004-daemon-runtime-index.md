# PRD-004: Daemon Runtime

> **Status:** In-Work
> **Priority:** P0
> **Effort:** L
> **Schema changes:** Additive

---

## Overview

The honeycomb daemon is the runtime spine: a long-lived process on port 3850 that is the only DeepLake client, with every hook, CLI invocation, MCP call, and SDK request reaching storage through it. This module builds the daemon's externally visible surface: the Hono HTTP server with its route groups and health/status endpoints, the durable `memory_jobs` queue on DeepLake that lets background work survive restarts, the file watcher that keeps workspace identity files synced to each harness and git-committed, and the runtime-path negotiation that stops two integration surfaces from writing into one session.

## Goals

- Stand up a Hono server on `127.0.0.1:3850` (overridable) with scaffolded route groups and `/health` plus `/api/status`.
- Provide a durable DeepLake-backed job queue with lease/complete/fail/dead semantics and bounded retries.
- Watch workspace identity files and run debounced harness sync and git auto-commit on change.
- Claim a session for the first runtime path that touches it and return 409 to the other.

## Non-Goals

- The capture, pipeline, retrieval, and ontology logic that ride on these routes (PRD-005 through PRD-008).
- Authentication policy internals beyond route permission scaffolding.
- Dashboard frontend implementation.

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-004a-daemon-runtime-http-server`](./prd-004a-daemon-runtime-http-server.md) | Hono server on port 3850, route scaffolding, health/status. | Draft |
| [`prd-004b-daemon-runtime-job-queue`](./prd-004b-daemon-runtime-job-queue.md) | Durable `memory_jobs` queue (lease/complete/fail/dead) on DeepLake. | Draft |
| [`prd-004c-daemon-runtime-file-watcher`](./prd-004c-daemon-runtime-file-watcher.md) | Identity-file watcher, harness sync, git auto-commit. | Draft |
| [`prd-004d-daemon-runtime-runtime-path`](./prd-004d-daemon-runtime-runtime-path.md) | `x-honeycomb-runtime-path` negotiation and 409 conflict. | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given the daemon starts, when `/health` is requested, then it returns liveness, uptime, version, and coarse pipeline status; and `/api/status` returns resolved config and providers. |
| AC-2 | Given a queued job, when a worker leases it and crashes, then the stale lease is reaped and the job becomes available again within its retry bounds. |
| AC-3 | Given a workspace identity file changes, when the watcher fires, then harness copies regenerate with a do-not-edit header and, if git sync is enabled, a timestamped commit is made. |
| AC-4 | Given a session already claimed by the `plugin` path, when the `legacy` path requests the same session, then the daemon returns 409 Conflict. |

## Data model changes

Additive: `memory_jobs` queue table (lease, complete, fail, dead with retry counters) backed by DeepLake.

## API changes

Additive: introduces the daemon HTTP surface (`/health`, `/api/status`, and scaffolded `/api/*`, `/memory/*`, `/mcp` route groups). Detailed route bodies land in later modules.

## Open questions

- [ ] What is the default bind posture for a team deployment (localhost versus widened via `HONEYCOMB_BIND`)?
- [ ] How long before a stale runtime-path claim expires and is swept?
- [ ] Should the job queue and file watcher run in-process or as separate daemon workers?

## Related

- [Daemon Surface](../../../knowledge/private/architecture/daemon-surface.md)
- [System Overview](../../../knowledge/private/architecture/system-overview.md)
- [Harness Integration](../../../knowledge/private/integrations/harness-integration.md)

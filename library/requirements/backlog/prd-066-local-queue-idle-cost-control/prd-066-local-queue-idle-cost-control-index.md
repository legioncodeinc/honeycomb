# PRD-066: Local Queue Idle-Cost Control

> **Status:** Backlog
> **Priority:** P0
> **Effort:** L
> **Created:** 2026-06-29
> **Related:** ADR-0006, PRD-062, PRD-043a, ADR-0004

## Overview

Honeycomb needs immediate cost relief for single-machine users while the hosted control plane is
still being designed. PRD-062 reduces DeepLake compute cost with adaptive polling and query
consolidation, but it still assumes the daemon may use DeepLake as a queue for local work. That keeps
the wrong shape in place: an idle local daemon can still ask a remote memory substrate whether there
is local work to do.

This PRD introduces a local daemon queue for local-only work. The daemon should enqueue, lease,
retry, and complete local jobs from a durable local store under `.daemon/`. DeepLake remains the
system of record for memory rows, embeddings, vector search, recall/RRF, and shared artifacts. The
local queue only decides when the daemon has real work that justifies touching DeepLake.

Target idle behavior:

```text
No user activity + empty local queue = zero DeepLake coordination reads.
```

## Problem

DeepLake-backed coordination is too expensive for idle installs. At roughly `$0.15/hour` per polling
worker, even a "nothing is happening" daemon can create meaningful user cost. Backoff helps, but it
does not fully solve the problem because the user still pays for coordination checks that could have
been local.

Single-machine users need a faster fix than the hosted multi-device control plane. They should not
need DigitalOcean Postgres, Cloudflare Workers, device adoption, or fleet enrollment just to stop
paying for idle local queue polling.

## Goals

- Move local-only daemon job scheduling off DeepLake-backed queues.
- Preserve DeepLake for actual memory/vector/storage work.
- Make idle single-machine installs issue zero DeepLake reads for queue polling, leasing, and
  reaping.
- Persist queued, leased, retrying, completed, and failed local jobs across daemon restarts.
- Keep the change reversible behind an explicit flag until correctness and cost reduction are proven.
- Use PRD-062 instrumentation to prove before/after DeepLake query and compute reduction.

## Non-Goals

- Replace DeepLake as the memory, embedding, vector, or recall substrate.
- Implement the hosted control plane described in ADR-0004.
- Implement multi-device shared queue semantics.
- Introduce Redis, Valkey, a Droplet, or another broker for local-only work.
- Remove every DeepLake-backed `memory_jobs` path in one cutover.
- Store DeepLake credentials or secrets in the local queue.

## User Stories

- As a single-machine user, I want Honeycomb to stay idle without billing me for remote queue checks.
- As a daemon operator, I want queued work to survive process restarts without duplicate execution.
- As a developer, I want local and shared job paths to be explicit so future control-plane work does
  not inherit accidental DeepLake polling.
- As a support/debugging user, I want a visible way to confirm the daemon is idle and not polling
  DeepLake for local work.

## Feature Breakdown

### PRD-066a: Local Queue Store

Create the local durable queue abstraction, schema, leasing, retry, retention, and corruption
handling.

### PRD-066b: Worker Routing And Migration

Route local-only producers and consumers to the local queue while preserving feature-flag fallback
and any remaining shared DeepLake job handling.

### PRD-066c: Idle-Cost Verification And Rollout

Measure before/after DeepLake coordination reads, define rollout flags, and document rollback and
operator diagnostics.

### PRD-066d: Verification Hardening And Upgrade Smoke

Harden the live idle-meter proof so it uses bounded throwaway DeepLake queue tables, then add a
built-daemon smoke that proves local SQLite operational DBs are created and reopened across startup.

### PRD-066e: Upgrade And Rollback Hardening

Prove the packaged user upgrade path, pending old shared job behavior, rollback safety, topology
gating, and dogfood matrix before enabling local queue by default for production single-machine
installs.

## Functional Requirements

1. The daemon must have a local queue abstraction for enqueue, lease, complete, fail, retry,
   requeue-expired-leases, and prune-completed operations.
2. The local queue must persist across daemon restarts.
3. The local queue must support single-winner leasing within a daemon runtime.
4. Local-only job producers must stop writing new jobs to DeepLake-backed queues.
5. Local-only job workers must stop polling DeepLake to discover local work.
6. DeepLake must only be touched by these flows when a leased local job performs actual
   memory/vector/storage work.
7. The old DeepLake-backed job path must remain available behind a fallback flag during rollout.
8. Existing DeepLake jobs must have a migration/drain behavior that avoids duplicate execution.
9. The daemon must expose enough diagnostics to prove whether the local queue is empty, blocked, or
   retrying.
10. PRD-062 query instrumentation must distinguish coordination reads from actual memory reads.

## Acceptance Criteria

- AC-1: With no user activity and an empty local queue, the daemon produces zero DeepLake
  coordination reads over the configured idle measurement window.
- AC-2: A queued local job survives daemon restart and executes once after restart.
- AC-3: An expired local lease is reclaimed and retried without creating duplicate successful work.
- AC-4: Local-only producers no longer call DeepLake queue enqueue APIs when the local queue flag is
  enabled.
- AC-5: Local-only workers no longer poll DeepLake for job discovery when the local queue flag is
  enabled.
- AC-6: Feature flag off preserves current behavior.
- AC-7: Active memory write/recall behavior still reaches DeepLake when a local job has real memory
  work to perform.
- AC-8: The rollout report includes before/after DeepLake coordination read counts using the PRD-062
  meter.

## Data Model

The initial local queue should be implemented as a local SQLite database unless implementation
discovery finds a stronger existing local persistence helper.

Logical table:

```sql
CREATE TABLE local_job (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_after TEXT NOT NULL,
  lease_owner TEXT,
  leased_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  last_error_class TEXT
);
```

Suggested indexes:

- `(status, run_after, priority, created_at)` for leasing.
- `(lease_owner, leased_until)` for lease recovery.
- `(kind, status)` for diagnostics.
- `(completed_at)` for retention pruning.

The local queue must not introduce DeepLake schema changes.

## Security And Privacy

- The local queue must never store raw secrets, plaintext DeepLake credentials, API tokens, session
  cookies, or credential-wrapping keys.
- Payloads should be validated per job kind before enqueue and before execution.
- The queue file should live under the daemon runtime directory with restrictive local filesystem
  permissions where the platform supports them.
- Diagnostics must not print raw payloads by default.

## Dependencies

- PRD-062a query metering for before/after verification.
- PRD-062b adaptive polling as the fallback safety net for remaining DeepLake queue paths.
- PRD-043a precedent for local SQLite operational state.
- ADR-0006 architectural decision for local queue as interim idle-cost control.
- PRD-066e packaged upgrade proof before production default-on.

## Open Questions

- Which SQLite binding should be used in the current runtime: `node:sqlite`, an existing dependency,
  or a repo-local persistence helper?
- Which job kinds are definitely local-only in the first migration wave?
- Should the first release drain old DeepLake jobs to completion or ignore them after a grace window?
- What should the exact idle measurement window be for "zero coordination reads"?
- Should local queue diagnostics be CLI-only, dashboard-visible, or both?
- What exact previous package version should be used for the packaged upgrade smoke?


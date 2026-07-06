# ADR-0006, Local queue as interim idle-cost control

> **Evolved by [ADR-0009](0009-local-queue-as-default-deeplake-is-not-a-queue.md) (2026-07-05):** the local queue is now the DEFAULT (not opt-in), and the driver is correctness — the shared DeepLake `memory_jobs` queue is unreliable under read-after-write lag — not just idle cost. This ADR's scope boundary and idle-cost invariants still hold.

> **Status:** Proposed (exploratory) | **Date:** 2026-06-29
> **Supersedes:** none | **Superseded by:** none (evolved by ADR-0009)
> **Owners:** daemon, operations, storage | **Related:** PRD-062, PRD-066, ADR-0004, ADR-0009

## Context

Honeycomb needs two things at once:

- a strategic multi-device/fleet control plane, documented in ADR-0004 as Cloudflare Workers plus
  DigitalOcean-managed Postgres; and
- immediate cost relief for single-machine users who are paying because idle daemons keep touching
  DeepLake-backed coordination tables.

PRD-062 already reduces the bleeding by adding adaptive backoff and consolidating DeepLake polling.
That is a good emergency patch, but it still leaves the shape wrong: the daemon can still use
DeepLake as a local work queue. For a single machine, that is unnecessary. The local daemon already
knows when local capture, pollinating, summary, retry, and debounce work is created. It should not
ask a remote memory/vector substrate whether local work exists.

The repo already uses local disk for local operational state. The log-store PRD chose SQLite for
request/event logs because they are high-frequency, local, ephemeral, and need immediate queryability
without DeepLake's eventual-consistency behavior. The same reasoning applies to single-machine job
coordination.

## Decision drivers

- **Stop the single-machine idle bill quickly.**
- **Keep DeepLake for memory/vector artifacts, not idle local coordination.**
- **Do not block cost relief on the hosted control plane.**
- **Keep the local daemon useful offline and during control-plane outages.**
- **Preserve the future multi-device/fleet direction.**
- **Avoid introducing another managed service for local-only work.**

## Considered options

### Option A, PRD-062 backoff only

Adaptive backoff and single-poller consolidation reduce DeepLake query volume by one to two orders
of magnitude, but they still poll DeepLake at idle and still tie cost to install count. This is the
fastest patch, not the end state for single-machine idle cost.

### Option B, Wait for the hosted control plane

The Cloudflare/Postgres control plane will remove fleet/device coordination from DeepLake, but it is
a product backend with auth, devices, credentials, approvals, and dashboard work. Waiting for that
before fixing single-machine idle cost leaves users paying now.

### Option C, Local daemon queue for single-machine work (CHOSEN)

Move local-only daemon work scheduling out of DeepLake into a local SQLite or file-backed queue under
the daemon runtime directory. The daemon touches DeepLake only when it has actual memory/vector work
to perform: write captured artifacts, read recall candidates, persist memory updates, or sync shared
artifacts.

This is the best bridge. It stops the idle bill for single-machine users while preserving the later
hosted control-plane architecture.

### Option D, Redis/Valkey or another local broker

Redis/Valkey would be overkill for a single-machine daemon and adds installation, process
supervision, auth, and failure-mode complexity. It may be useful for hosted or high-scale control
plane work later, but not for local idle-cost control.

## Decision

Adopt **Option C**: introduce a local daemon queue as the interim single-machine idle-cost control.

For local-only work, the daemon should enqueue, lease, retry, and complete jobs from a local
SQLite/file-backed queue under `.daemon/`. DeepLake remains the memory/vector system of record. The
local queue is not a replacement for shared memory. It is the local scheduler that decides when the
daemon has real work worth sending to DeepLake.

The target idle behavior for a single-machine daemon is:

```text
No user activity + empty local queue = zero DeepLake reads for coordination.
```

PRD-062 remains valuable as the near-term mitigation and as a safety net for any code path still
polling DeepLake. PRD-066 owns the local queue bridge. ADR-0004 owns the later hosted control plane.

## Scope Boundary

Move to the local queue:

- local capture processing jobs;
- pollinating trigger/maintenance jobs that originate on this daemon;
- local summary/wiki/document retry jobs;
- local debounce and batching timers;
- local reaper/retry bookkeeping.

Keep in DeepLake:

- memory rows and history;
- session rows that are intentionally shared;
- embeddings and vector search;
- RRF/recall candidates;
- team skills and shared artifacts;
- any cross-device/fleet coordination until ADR-0004's control plane replaces it.

## Relationship To The Hosted Control Plane

The local queue is not throwaway. Even after the hosted control plane exists, it remains useful for:

- offline-first local work;
- buffering while the control plane is unavailable;
- avoiding a remote round trip for purely local jobs;
- draining work safely after daemon restarts.

The hosted control plane may later enqueue "remote work available" signals, but the local daemon can
still translate that into local jobs before touching DeepLake.

## Consequences

**Positive**

- Single-machine idle installs can stop touching DeepLake for "is there local work?" checks.
- Cost relief does not wait for cloud control-plane delivery.
- Local work becomes immediately queryable and retryable without DeepLake eventual-consistency
  convergence reads.
- The daemon gains a cleaner local durability boundary for jobs, retries, and crash recovery.

**Negative / accepted**

- There will be two queue concepts during the transition: local daemon queue and existing
  DeepLake-backed shared jobs.
- Some job kinds may need careful migration to avoid double execution or lost retries.
- Multi-device work still needs the hosted control plane; the local queue does not solve fleet
  coordination by itself.
- A local SQLite/file queue needs retention, corruption handling, and fail-soft behavior.

## Required invariants

- Empty local queue at idle must not issue DeepLake coordination reads.
- The local queue must never store raw secrets or plaintext DeepLake credentials.
- Queue writes must be local and fail-soft where possible; failure should degrade to current
  behavior only behind an explicit fallback flag.
- Job ownership and retry semantics must remain single-winner within a daemon process.
- The migration must be reversible behind a flag until live cost and correctness are proven.

## Revisit triggers

Re-open this decision if any of these become true:

1. The hosted control plane ships and fully replaces all DeepLake-backed coordination.
2. Local queue corruption or driver issues create more support cost than DeepLake polling.
3. DeepLake offers a cheap native queue/trigger primitive that does not keep compute warm.
4. Multi-device users need shared queue semantics before the hosted control plane is available.

## Links

- PRD-066: `library/requirements/backlog/prd-066-local-queue-idle-cost-control/prd-066-local-queue-idle-cost-control-index.md`
- PRD-062: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062-deeplake-compute-cost-reduction-index.md`
- ADR-0004: `library/knowledge/private/architecture/adr/0004-honeycomb-control-plane-and-postgres-boundary.md`
- Persistent log store: `library/requirements/completed/prd-043-logs-page/prd-043a-logs-page-persistent-log-store.md`

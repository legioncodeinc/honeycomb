# ADR-0009, Local queue as the default; DeepLake is a store, not a job-coordination primitive

> **Status:** Accepted | **Date:** 2026-07-05
> **Supersedes:** none (evolves ADR-0006) | **Superseded by:** none
> **Owners:** daemon, storage, operations | **Related:** ADR-0006, ADR-0004, PRD-066, PRD-062

## Context

ADR-0006 introduced the daemon-local SQLite queue as an **interim idle-cost control**: default-OFF,
opt-in, framed purely as a way to stop single-machine daemons paying to poll DeepLake at idle. It
deliberately kept the DeepLake-backed `memory_jobs` queue as the default coordination substrate and
left "any cross-device/fleet coordination" in DeepLake until the hosted control plane (ADR-0004)
lands.

Live dogfooding on 2026-07-05 revealed a stronger fact than cost: the shared DeepLake `memory_jobs`
queue is not merely expensive, it is **incorrect** for job coordination. Its optimistic append-only
version scheme — read the current max `version`, append `version+1` with the new status — assumes a
read observes the latest append. DeepLake is eventually consistent, so under read-after-write lag the
read routinely under-reports the max, and **multiple appends collide on the same version number**.
Direct inspection of the live table showed ~20 rows sharing one version with mixed `leased`/`done`
status (and, separately, corrupted `type` values). The consequences chain deterministically:

- a completed job's `done` row is not observed, so the job is **re-leased and re-processed forever**;
- the single-in-flight, oldest-first lease coordinator is pinned to the immortal extraction backlog
  and **never advances** to `memory_decision` / `memory_controlled_write`;
- the `memory_decision` jobs that fan-out *did* enqueue are never leased;
- **zero memories are ever committed.**

This reframes ADR-0006's decision. The local queue is not just a cost optimization that can stay
optional — it is the only substrate on which the memory pipeline is *correct*. Making it opt-in and
default-off means the out-of-the-box experience is a pipeline that silently forms no memories.

## Decision drivers

- **Correctness first.** The pipeline must form memories out of the box, not only after a hand-set flag.
- **Do not use an eventually-consistent store as a coordination primitive.** Job leasing needs
  atomic compare-and-set; DeepLake provides neither.
- **Fail loud, never silent.** A daemon that cannot form memories must say so at a glance.
- **Preserve rollback and the future fleet direction.** A real multi-daemon topology must still be
  able to opt into shared coordination; ADR-0004's control plane remains the long-term home for it.
- **Do not regress single-user multi-machine use.** Shared *recall* must be preserved.

## Decision

1. **The daemon-local SQLite queue is the DEFAULT** job-coordination substrate for every pipeline
   kind (`memory_extraction` / `memory_decision` / `memory_controlled_write` / `memory_graph_persist`
   / `memory_retention`, plus `summary` / `skillify` / `pollinating` / `source_index` /
   `document_ingest`). It uses transactional `UPDATE … WHERE status=? AND attempts=?` inside
   `BEGIN IMMEDIATE`, so a job leases and completes exactly once.

2. **DeepLake is a data store, not a job-coordination primitive.** It remains the system of record for
   the memory data plane — `memories`, `sessions`, `embeddings`, RRF/vector recall, skills — and is
   never asked "is there local work?" again. The DeepLake `memory_jobs` queue is **deprecated** for
   pipeline coordination.

3. **Default-on is topology-gated.** An undeclared (unknown) or `single_machine` topology is eligible
   for local-queue default-on; a declared `fleet` / `multi_device` topology stays on the shared queue
   unless it explicitly opts in. This reverses ADR-0006's conservative "unknown ⇒ shared" default:
   absence of a declared multi-daemon topology means "assume a single local daemon."

4. **`HONEYCOMB_LOCAL_QUEUE_ENABLED` is the explicit override** — both the opt-in and the rollback
   lever. An explicit value always wins over the topology default; `=false` restores the shared path.

5. **A loud guard fires whenever pipeline kinds route to the shared queue** — because the local queue
   is disabled, or because it failed to open and the router fell back. The guard emits a boot warning
   to stderr, a durable `queue.shared_pipeline_path_active` event, and the `/health`
   `reasons.memoryQueue: "shared"` signal. Silent zero-memories is no longer possible.

Crucially, **memories still WRITE to the shared DeepLake `memories` table regardless of which queue
runs the jobs.** The local queue coordinates *work*; it does not privatize *memory*. A single-user
multi-machine fleet keeps shared recall — each daemon processes its own captures locally and publishes
memories to the shared store.

## Consequences

**Positive**

- The memory pipeline forms memories out of the box, with no hand-set flag.
- Job coordination is correct by construction (transactional local queue), immune to DeepLake
  read-after-write lag.
- A stalled or misrouted pipeline is loud: the `memoryQueue` + `memoryFormation` health reasons make
  "not forming memories" an at-a-glance signal instead of a forensic hunt.
- Idle single-machine daemons keep ADR-0006's zero-idle-DeepLake-reads property.

**Negative / accepted**

- In local-queue mode the recurring storage `SELECT 1` probe stays off (ADR-0006 idle-cost boundary),
  so `/health` no longer returns 503 when DeepLake is unreachable. The `memoryFormation`
  (committed-since-boot) signal is the replacement liveness indicator; wiring DeepLake-reachability
  into local-mode health (e.g., for fleet 503-defer) is a follow-up, not in scope here.
- Cross-daemon job hand-off is not available on the local queue. This is acceptable: no current
  topology relies on it, and shared *recall* is unaffected. True multi-daemon coordination is
  ADR-0004's hosted control plane, not the DeepLake `memory_jobs` queue.
- The shared DeepLake queue remains in the codebase as a **dormant, deprecated, opt-in** path until a
  later change removes it or a real fleet need re-homes it onto the control plane.

## Required invariants

- Pipeline kinds must NEVER silently run on the shared queue — the guard must fire (warning + event +
  health reason) on any route to it.
- Memories must persist to the shared `memories` table regardless of queue mode, so shared recall is
  preserved.
- Rollback via `HONEYCOMB_LOCAL_QUEUE_ENABLED=false` must remain available.
- The local queue must never store raw secrets or plaintext DeepLake credentials (ADR-0006 invariant,
  unchanged).

## Revisit triggers

Re-open this decision if any of these become true:

1. A real multi-daemon fleet needs shared job coordination — provide it via ADR-0004's hosted control
   plane, not by re-defaulting to the DeepLake `memory_jobs` queue.
2. DeepLake gains read-after-write consistency or a native, correct, non-warm queue/lease primitive.
3. Local SQLite queue corruption or driver issues create more support cost than the correctness win.

## Links

- ADR-0006: `library/knowledge/private/architecture/adr/0006-local-queue-as-interim-idle-cost-control.md`
- ADR-0004: `library/knowledge/private/architecture/adr/0004-honeycomb-control-plane-and-postgres-boundary.md`
- PRD-066: `library/requirements/backlog/prd-066-local-queue-idle-cost-control/prd-066-local-queue-idle-cost-control-index.md`
- PRD-062: `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/prd-062-deeplake-compute-cost-reduction-index.md`

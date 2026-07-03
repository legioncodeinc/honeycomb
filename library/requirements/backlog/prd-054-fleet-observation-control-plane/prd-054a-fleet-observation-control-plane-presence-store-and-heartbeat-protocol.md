# PRD-054a: Presence Store and Heartbeat Protocol

> **SUPERSEDED (2026-07-03):** Cloud fleet/team management now belongs to Queen, the fleet orchestrator. The canonical copy of this document lives at `queen/library/requirements/backlog/prd-054-fleet-observation-control-plane/prd-054a-fleet-observation-control-plane-presence-store-and-heartbeat-protocol.md`. This copy is retained for history only; do not update it here.

> **Parent:** [PRD-054](./prd-054-fleet-observation-control-plane-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** L (1-3d)
> **Schema changes:** Additive (new presence store, not Deep Lake)

---

## Goals

Define the presence substrate and the write protocol that separates liveness from status, so the dashboard can tell "quiet" from "dead" and the store never grows without bound.

## Scope

- The `agent_presence` and `agent_status` tables (see parent index, Data model).
- The two-signal protocol: a fixed-interval heartbeat that bumps `last_seen` unconditionally, and a status record written only when content changes.
- TTL-based liveness derivation and a reaper that drops rows aged past `ttl_seconds`.
- A storage adapter interface so SQLite (default) and Postgres are interchangeable.

## Out of scope

- The daemon-side emitter (PRD-054b) and the dashboard reader (PRD-054c).
- Authentication of the writer beyond the existing org scope (per-agent identity is PRD-055).

---

## User stories and acceptance criteria

### US-054a.1 - Liveness is separate from status

**As** the fleet system, **I want** a heartbeat distinct from a status write, **so that** a healthy idle agent and a crashed agent are not byte-identical.

- AC-054a.1.1 Given an unchanged agent, when the heartbeat interval fires, then `last_seen` is updated and no `agent_status` row is written.
- AC-054a.1.2 Given `last_seen` older than `ttl_seconds * miss_factor`, when liveness is computed, then the agent reports `offline`.

### US-054a.2 - The store stays bounded

**As** an operator, **I want** dead rows reaped, **so that** presence never accumulates like the `memory_jobs` backlog did.

- AC-054a.2.1 Given a row aged past its TTL, when the reaper runs, then the row is removed from `agent_presence` and its `agent_status` is compacted away.
- AC-054a.2.2 Given N daemons heartbeating for an hour, when measured, then the presence store size is bounded by live-agent count, not total-heartbeat count.

---

## Technical considerations

- **Substrate:** default SQLite (single file, zero external dep), behind a `PresenceStore` interface with the same shape as the existing storage-client abstraction so a Postgres impl drops in.
- **Heartbeat is an upsert** keyed on `(org, agent_id)`; never an append. Status is latest-wins per key with a compaction job, mirroring the append-then-compact discipline used elsewhere.
- **No Deep Lake:** this store is deliberately off the memory dataset. The append-only, version-bumping, eventually-consistent profile of Deep Lake is the opposite of what mutable high-frequency presence needs.

## Evaluation and study of other codebases

- **Fold (MIT):** mission-control's SQLite-zero-dep model is adopted as the default substrate.
- **Pattern (MIT):** AxmeAI's `registering/healthy/degraded/dead` thresholds inform `ttl_seconds` and `miss_factor` defaults (30s, 3 missed).
- **Study (no fold):** Spawnly classifies heartbeat as a hidden System event and separates short-lived from long-lived agents, the rationale for AC-054a.2.

## Files touched (anticipated)

- New: `src/daemon/runtime/fleet/presence-store.ts` (interface + SQLite impl), `presence-protocol.ts` (heartbeat vs diff), `presence-reaper.ts`, plus tests under `tests/daemon/runtime/fleet/`.

## Test plan

- Unit: heartbeat-without-change writes no status row (AC-054a.1.1); TTL-expired row reports offline (AC-054a.1.2); reaper bounds store size (AC-054a.2).

## Open questions

- [ ] `ttl_seconds` per `kind`: shorter for `sub_agent` (ephemeral) than `orchestrator`?

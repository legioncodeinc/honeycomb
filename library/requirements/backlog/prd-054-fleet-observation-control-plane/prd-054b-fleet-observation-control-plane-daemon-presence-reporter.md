# PRD-054b: Daemon Presence Reporter

> **SUPERSEDED (2026-07-03):** Cloud fleet/team management now belongs to Queen, the fleet orchestrator. The canonical copy of this document lives at `queen/library/requirements/backlog/prd-054-fleet-observation-control-plane/prd-054b-fleet-observation-control-plane-daemon-presence-reporter.md`. This copy is retained for history only; do not update it here.

> **Parent:** [PRD-054](./prd-054-fleet-observation-control-plane-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** M (3-8h)
> **Schema changes:** None

---

## Goals

Make the daemon report its own liveness and status into the presence store (PRD-054a) without ever letting a presence failure disturb real work.

## Scope

- A background reporter inside the daemon runtime that fires a heartbeat on a fixed interval.
- A status sampler that detects change (current task, daemon version, embeddings state, error state) and writes a status diff only on transition.
- Fail-soft wrapping: any presence write error is swallowed and surfaced only as informational, never thrown into the request pipeline.

## Out of scope

- The store and protocol themselves (PRD-054a).
- Reporting on *other* agents the daemon spawns (that requires per-agent identity from PRD-055; in v1 the daemon reports only itself as `kind=orchestrator`).

---

## User stories and acceptance criteria

### US-054b.1 - The daemon proves it is alive

- AC-054b.1.1 Given a running daemon, when the heartbeat interval elapses, then a `last_seen` upsert reaches the presence store.
- AC-054b.1.2 Given the presence store is unreachable, when the heartbeat fires, then the error is swallowed and the daemon continues serving normally.

### US-054b.2 - Status is reported only on change

- AC-054b.2.1 Given the daemon's sampled state is unchanged since the last tick, when the reporter runs, then no status diff is written.
- AC-054b.2.2 Given the daemon transitions (for example embeddings go from warming to ready), when the next tick runs, then exactly one status diff captures the new state.

---

## Technical considerations

- Reuse the existing daemon background-worker lifecycle (the same machinery skillify and compaction workers use) rather than a new scheduler.
- The reporter reads the daemon's own `/health`-equivalent internal state; it must distinguish "daemon wedged" from "store unreachable" so the dashboard later shows the right failure (a design-doc requirement: three distinct failure modes).
- Cadence and TTL come from config with the AxmeAI-derived defaults (30s, 3 missed).

## Evaluation and study of other codebases

- **Study (no fold):** doop-os daemons `POST /heartbeat` on a timer updating `last_seen_at`; Quint daemons heartbeat every 30s carrying a version and status field. Both confirm the timer-driven self-report shape adopted here. License keeps this to study only.
- **Pattern (MIT):** clawmatrix's sidecar "registers on boot then keeps heartbeats alive" is the v1 reporter in miniature (minus registration, which is PRD-055).

## Files touched (anticipated)

- New: `src/daemon/runtime/fleet/presence-reporter.ts`, wired in the composition root (`assemble.ts`) after `createDaemon`. Tests under `tests/daemon/runtime/fleet/`.
- Modified: `src/daemon/runtime/assemble.ts` (start the reporter), daemon config (cadence, TTL).

## Test plan

- Unit: heartbeat reaches an injected fake store (AC-054b.1.1); store-throw is swallowed (AC-054b.1.2); unchanged sample writes nothing (AC-054b.2.1); transition writes one diff (AC-054b.2.2).

## Open questions

- [ ] Should the reporter piggyback presence on the existing health loop, or run as its own interval to keep concerns separate?

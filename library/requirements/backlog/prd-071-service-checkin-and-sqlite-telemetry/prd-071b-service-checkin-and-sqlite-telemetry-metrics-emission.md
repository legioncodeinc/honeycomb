# PRD-071b: Metrics Emission to Local SQLite

> **Parent:** [PRD-071](./prd-071-service-checkin-and-sqlite-telemetry-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M (3-8h)
> **Schema changes:** None to Deep Lake. Adds a local SQLite metrics snapshot table.

---

## Goals

Expose honeycomb's non-sensitive operational metrics in its own local SQLite so hivedoctor can poll them, per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`. Emit actions taken, files processed, and memories created since the last restart, mapping onto honeycomb's existing counters rather than deriving new ones.

## Scope

- A `honeycomb_metrics` table in honeycomb's local SQLite (the same built-in `node:sqlite` mechanism already used for the local queue), holding a latest-wins snapshot of since-restart counters.
- Mapping the snapshot onto existing counters in `src/daemon/runtime/dashboard/`: `memoryCount` and session and turn counts for memories created, and the ROI ledger for actions taken.
- A files-processed counter for files honeycomb handled since restart, incremented on the existing processing path.
- Resetting the since-restart counters on process start so a restart produces a clean baseline.
- Fail-soft writes that never block the memory path.

## Out of scope

- Check-in, registration, and heartbeat (PRD-071a).
- Log emission (PRD-071c).
- hivedoctor's poll, merge, and relay (hivedoctor PRD-001 and PRD-002).

---

## User stories and acceptance criteria

### US-071b.1 - hivedoctor can poll live metrics

**As** hivedoctor, **I want** honeycomb's metrics in local SQLite, **so that** I can read them on my interval without honeycomb pushing.

- AC-071b.1.1 Given honeycomb is doing work, when hivedoctor reads `honeycomb_metrics`, then it sees current values for actions taken, files processed, and memories created since restart.
- AC-071b.1.2 Given the metrics table, when it is read, then values are a latest-wins snapshot, not an unbounded append log.

### US-071b.2 - Metrics reuse existing counters

**As** an implementer, **I want** the snapshot sourced from existing counters, **so that** there is one definition of each metric.

- AC-071b.2.1 Given the existing dashboard counters (`memoryCount`, sessions and turns, ROI), when the metrics snapshot is written, then memories-created and actions-taken derive from those counters without recomputation or double counting.

### US-071b.3 - Restart resets since-restart counters

**As** hivedoctor, **I want** since-restart semantics to hold, **so that** a restart is observable as a counter reset.

- AC-071b.3.1 Given a honeycomb restart, when the metrics snapshot is next read, then the since-restart counters reflect the new process lifetime starting from zero.

### US-071b.4 - Metrics carry no sensitive data

- AC-071b.4.1 Given any metrics row, when written, then it contains no token, credential, org secret, memory body, or PII, per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`.

---

## Technical considerations

- The metrics store is latest-wins per counter, written on a short interval or on change, keeping the read cheap enough for hivedoctor's roughly one-second poll.
- Memories created maps to `memoryCount` deltas since restart; actions taken maps to the ROI ledger's action count; files processed is a new in-memory counter flushed to the snapshot.
- The write goes through the same built-in `node:sqlite` connection style as the local queue, in WAL mode, so hivedoctor's read-only open does not contend with honeycomb's writes (per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`).
- Fail-soft: a metrics write error is caught and dropped; it never surfaces into memory work.

## Files touched (anticipated)

- New `src/daemon/runtime/telemetry/metrics.ts` - snapshot writer over existing counters.
- `src/daemon/runtime/dashboard/` - read-only access to `memoryCount`, sessions and turns, and ROI as metric sources.
- Tests under `tests/daemon/runtime/telemetry/`.

## Test plan

- Unit: snapshot maps existing counters without double counting (AC-071b.2.1).
- Unit: table is latest-wins, not append (AC-071b.1.2).
- Unit: restart resets since-restart counters (AC-071b.3.1).
- Unit: no sensitive fields present (AC-071b.4.1).
- Integration: a read-only reader observes live values while honeycomb writes (AC-071b.1.1).

## Open questions

- [ ] Flush cadence for the snapshot: on a timer, on counter change, or piggybacked on the heartbeat from PRD-071a?
- [ ] Is files-processed counted per file or per batch on honeycomb's processing path?

---

## Related

- Parent: [PRD-071](./prd-071-service-checkin-and-sqlite-telemetry-index.md)
- `../../../../../hivedoctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md` - services write non-sensitive telemetry to local SQLite; hivedoctor polls read-only.
- Sibling: [PRD-071a](./prd-071a-service-checkin-and-sqlite-telemetry-checkin-and-registration.md), [PRD-071c](./prd-071c-service-checkin-and-sqlite-telemetry-log-emission.md).
- `src/daemon/runtime/dashboard/` - existing counter sources.

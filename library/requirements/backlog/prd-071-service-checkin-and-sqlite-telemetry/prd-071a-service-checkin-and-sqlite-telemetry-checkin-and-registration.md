# PRD-071a: Check-in and Registration

> **Parent:** [PRD-071](./prd-071-service-checkin-and-sqlite-telemetry-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M (3-8h)
> **Schema changes:** None to Deep Lake. Adds a static registry entry at install and a runtime status record (binding time, last-seen, health).

---

## Goals

Make honeycomb a registered, self-announcing member of the fleet so hivedoctor can locate it, know it should exist, and read a live liveness and health signal without honeycomb pushing anything. This implements the honeycomb side of `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`: a static installer registry entry (who should exist, plus the SQLite DB path) and a runtime status record (check-in, binding time, last-seen, health).

## Scope

- Write or refresh honeycomb's entry in hivedoctor's static installer registry during install, declaring honeycomb's identity and the absolute path to its runtime telemetry SQLite database.
- Write a runtime status record on check-in: binding time (when honeycomb bound its port), current health, and an initial last-seen.
- Advance last-seen on a fixed heartbeat interval so liveness is derivable as an age of last-seen, independent of whether metrics changed.
- Source the health value from the same signal honeycomb's `/health` reports, so hivedoctor's `/health` probe and the polled status agree.
- Keep every write fail-soft: a registry or status write error never blocks daemon boot or memory work.

## Out of scope

- Metrics emission (PRD-071b) and log emission (PRD-071c).
- hivedoctor's merge of static registry plus runtime status, its poll loop, and the SSE to the-hive (hivedoctor PRD-001 and PRD-002).
- Per-agent cryptographic identity, enrollment, or command channels (PRD-055).

---

## User stories and acceptance criteria

### US-071a.1 - Honeycomb is discoverable in the registry

**As** hivedoctor, **I want** a static registry entry for honeycomb with its SQLite DB path, **so that** I know honeycomb should exist and where to poll its telemetry.

- AC-071a.1.1 Given a completed install, when the static registry is read, then honeycomb has an entry declaring its identity and the absolute path to its runtime telemetry SQLite database, per `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`.
- AC-071a.1.2 Given honeycomb is reinstalled or upgraded, when install runs again, then the entry is refreshed idempotently rather than duplicated, and the DB path remains stable across restarts.

### US-071a.2 - Honeycomb checks in with binding time and health

**As** hivedoctor, **I want** a runtime status record on check-in, **so that** I can merge live binding time and health with the static entry.

- AC-071a.2.1 Given honeycomb binds its port, when it checks in, then it writes a runtime status record with a binding time and a current health value readable read-only.
- AC-071a.2.2 Given honeycomb's health source changes, when the status is next written, then the health field reflects the same value `/health` reports.

### US-071a.3 - Liveness is derivable from last-seen

**As** hivedoctor, **I want** last-seen to advance on a heartbeat, **so that** a quiet-but-healthy honeycomb is not mistaken for a dead one.

- AC-071a.3.1 Given honeycomb is running and idle, when the heartbeat interval fires, then last-seen advances even though no metric changed.
- AC-071a.3.2 Given a honeycomb restart, when it checks in again, then binding time reflects the new process while the registry entry and DB path are unchanged.

---

## Technical considerations

- The runtime status write is an upsert keyed on honeycomb's service identity, never an append, mirroring the heartbeat-as-upsert discipline used by the presence store precedent in PRD-054a.
- The health value must not be recomputed here. It is read from the same source `src/daemon/runtime/server.ts` uses for `/health`, so the two never disagree.
- Registration happens at install time through the installer path (`src/commands/install.ts` and `scripts/install/`), consistent with `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md` placing the static registry under installer ownership.
- All writes are fail-soft. A missing registry, a locked file, or a permissions error is caught, logged locally, and never propagated into the boot or memory path.

## Files touched (anticipated)

- `src/commands/install.ts` and `scripts/install/*` - write or refresh the static registry entry with the SQLite DB path.
- New `src/daemon/runtime/telemetry/checkin.ts` - the runtime status writer (binding time, last-seen heartbeat, health) built on the existing built-in `node:sqlite` usage.
- Tests under `tests/daemon/runtime/telemetry/`.

## Test plan

- Unit: registry entry is written once and refreshed idempotently (AC-071a.1).
- Unit: check-in records binding time and a health value matching the `/health` source (AC-071a.2).
- Unit: heartbeat advances last-seen with no metric change (AC-071a.3.1); restart updates binding time while the DB path is stable (AC-071a.3.2).
- Unit: a registry or status write failure is fail-soft.

## Open questions

- [ ] Does the runtime status record live in the same local SQLite database as metrics and logs (single DB path in the registry), or a dedicated status file the merge reads first?
- [ ] Heartbeat cadence relative to hivedoctor's roughly one-second poll: match it, or run slower since the poll drives freshness?

---

## Related

- Parent: [PRD-071](./prd-071-service-checkin-and-sqlite-telemetry-index.md)
- `../../../../../hivedoctor/library/knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md` - static installer registry plus runtime SQLite status.
- `../../../../../hivedoctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md` - hivedoctor is the single source of truth and reads service SQLite read-only.
- Sibling: [PRD-071b](./prd-071b-service-checkin-and-sqlite-telemetry-metrics-emission.md), [PRD-071c](./prd-071c-service-checkin-and-sqlite-telemetry-log-emission.md).
- `src/commands/install.ts`, `src/daemon/runtime/server.ts`.

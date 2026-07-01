# PRD-071c: Log Emission to Local SQLite

> **Parent:** [PRD-071](./prd-071-service-checkin-and-sqlite-telemetry-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** M (3-8h)
> **Schema changes:** None to Deep Lake. Adds a bounded, rotated local SQLite log table.

---

## Goals

Expose honeycomb's non-sensitive logs in its own local SQLite, each line carrying a verbosity level, so hivedoctor can poll recent log activity per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`. Keep the store bounded and rotated so it stays small enough for a one-second read cycle and never grows without limit.

## Scope

- A `honeycomb_logs` table in honeycomb's local SQLite (the built-in `node:sqlite` mechanism already used for the local queue), holding recent log lines with a timestamp and a verbosity level.
- A bounded, rotated retention policy so the table cannot grow unbounded.
- A tap on honeycomb's existing daemon logger so non-sensitive lines are mirrored into the table without a second logging framework.
- Redaction that keeps sensitive material out of the log rows.
- Fail-soft writes that never block the memory path.

## Out of scope

- Check-in, registration, and heartbeat (PRD-071a).
- Metrics emission (PRD-071b).
- hivedoctor's poll, merge, and relay to the-hive (hivedoctor PRD-001 and PRD-002; the-hive PRD-005 renders the log rail).

---

## User stories and acceptance criteria

### US-071c.1 - hivedoctor can poll recent logs

**As** hivedoctor, **I want** honeycomb's recent logs in local SQLite, **so that** I can surface them on the health rail without honeycomb pushing.

- AC-071c.1.1 Given honeycomb emits log activity, when hivedoctor reads `honeycomb_logs`, then it sees recent lines, each with a timestamp and a verbosity level.

### US-071c.2 - The log store stays bounded

**As** an operator, **I want** logs rotated, **so that** the store never grows like an unbounded backlog.

- AC-071c.2.1 Given the log table reaches its configured bound, when new lines are written, then the oldest rows are rotated out and the store stays within the bound.
- AC-071c.2.2 Given continuous logging over time, when the table is measured, then its size is bounded by the retention policy, not by total lines ever emitted.

### US-071c.3 - Logs carry a verbosity level and no secrets

- AC-071c.3.1 Given any log row, when written, then it carries a verbosity level (for example error, warn, info, debug).
- AC-071c.3.2 Given any log row, when written, then it contains no token, credential value, raw authorization header, org secret, memory body, or PII, per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`.

---

## Technical considerations

- Logs are mirrored from honeycomb's existing daemon logger, not produced by a parallel logging path, so there is one definition of a log line.
- Retention is enforced on write (cap by row count, byte size, or age) so no separate reaper process is required, mirroring the bounded discipline the local queue already follows.
- The write uses the same built-in `node:sqlite` connection style in WAL mode so hivedoctor's read-only open does not contend with honeycomb's writes (per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`).
- Redaction runs before insert; if a line cannot be safely redacted it is dropped rather than written.
- Fail-soft: a log write error is caught and dropped and never surfaces into memory work.

## Files touched (anticipated)

- New `src/daemon/runtime/telemetry/logs.ts` - the bounded log writer and logger tap.
- Honeycomb daemon logger wiring - a non-invasive tap that mirrors non-sensitive lines.
- Tests under `tests/daemon/runtime/telemetry/`.

## Test plan

- Unit: each row has a timestamp and verbosity level (AC-071c.1.1, AC-071c.3.1).
- Unit: rotation keeps the store within its bound under sustained writes (AC-071c.2).
- Unit: redaction removes sensitive material and drops unredactable lines (AC-071c.3.2).
- Unit: a log write failure is fail-soft.
- Integration: a read-only reader tails recent logs while honeycomb writes (AC-071c.1.1).

## Open questions

- [ ] Retention bound: cap by row count, byte size, or age, and what default keeps reads cheap on a one-second cycle?
- [ ] Verbosity mapping: reuse the daemon logger's levels verbatim, or collapse to a small fixed set for hivedoctor's rail?

---

## Related

- Parent: [PRD-071](./prd-071-service-checkin-and-sqlite-telemetry-index.md)
- `../../../../../hivedoctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md` - logs live in the service's local SQLite; hivedoctor polls read-only.
- Expected the-hive PRD-005 (health rail and health page) at `../../../../../the-hive/library/requirements/backlog/prd-005-health-rail-and-health-page/` - the eventual reader of these logs.
- Sibling: [PRD-071a](./prd-071a-service-checkin-and-sqlite-telemetry-checkin-and-registration.md), [PRD-071b](./prd-071b-service-checkin-and-sqlite-telemetry-metrics-emission.md).

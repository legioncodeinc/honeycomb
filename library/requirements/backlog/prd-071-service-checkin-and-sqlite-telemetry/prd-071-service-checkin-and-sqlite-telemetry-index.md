# PRD-071: Honeycomb Service Check-in and SQLite Telemetry Emission

> **Status:** Backlog
> **Priority:** P1
> **Effort:** L (1-3d)
> **Schema changes:** None to Deep Lake. Additive local SQLite tables for non-sensitive telemetry (metrics, logs) plus a runtime status entry written to doctor's registration surfaces.

---

## Overview

The fleet realignment makes doctor the supervisor and single source of truth for fleet telemetry, and hive portal the only human-facing surface. Under that model every service, including honeycomb, is a supervised participant: it must announce itself to doctor and expose its own non-sensitive telemetry in a place doctor can poll cheaply. Two locked decisions govern how that happens: `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md` (services write non-sensitive telemetry to their own local SQLite; doctor polls on roughly a one-second interval plus `/health`, and is the sole source of truth relaying one SSE to hive) and `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md` (a static installer registry declares who should exist and where each service's SQLite database lives, while each service writes runtime status such as check-in, binding time, last-seen, health, and metrics into its runtime SQLite for doctor to merge).

Honeycomb is well positioned for this. It already runs Node's built-in SQLite (`--experimental-sqlite`) for its local job queue, and it already computes usable operational counters in the dashboard runtime (`memoryCount`, session and turn counts, and a ROI ledger under `src/daemon/runtime/dashboard/`). What honeycomb does not yet do is register with doctor's static registry, write a runtime status row (binding time, last-seen heartbeat, current health), or emit metrics and logs to a local SQLite surface shaped for doctor's poller.

This PRD closes that gap. It makes honeycomb a first-class supervised service: it registers and checks in with doctor per `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`, and it writes non-sensitive metrics and logs to its own local SQLite for doctor to poll per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`. It deliberately reuses honeycomb's existing counters and its existing built-in `node:sqlite` usage rather than introducing new infrastructure.

---

## Goals

- Register honeycomb in doctor's static installer registry at install time, including the on-disk path to honeycomb's runtime telemetry SQLite database, per `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`.
- Write and refresh honeycomb's runtime status (binding time, last-seen heartbeat, current health) so doctor can merge a live view of honeycomb without honeycomb pushing to doctor.
- Emit non-sensitive metrics to honeycomb's own local SQLite: actions taken, files processed, and memories created since the last restart, mapped onto honeycomb's existing counters where possible.
- Emit non-sensitive logs, carrying a verbosity level, to honeycomb's own local SQLite, bounded and rotated so the store never grows without limit.
- Reuse honeycomb's existing built-in `node:sqlite` usage (already enabled via `--experimental-sqlite` for the local queue) rather than adding a new SQLite dependency.
- Keep the telemetry write path fail-soft so a telemetry error never blocks memory work or daemon boot.

## Non-Goals

- Any change to the seven Deep Lake tables or to memory storage. Telemetry lives only in local SQLite.
- Emitting sensitive data: no tokens, credential values, raw authorization headers, org secrets, memory bodies, or PII in metrics or logs (per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`).
- Building the poller, the merge, the single source of truth, or the SSE to hive. Those belong to doctor (PRD-001 and PRD-002) and hive (PRD-005).
- Building any human-facing dashboard or health page. The read surface is hive's job.
- A push channel from honeycomb to doctor. Transport is pull, per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`.
- Fleet command, enrollment, or per-agent cryptographic identity (owned by PRD-055).

---

## Code-grounded current state

| Area | Current code fact | Implication for this PRD |
|---|---|---|
| Built-in SQLite already in use | The local job queue runs on Node's built-in SQLite behind `--experimental-sqlite`, with a packaged-upgrade smoke (`smoke:local-queue-*`). | The telemetry store reuses the same `node:sqlite` mechanism and WAL posture; no new dependency is introduced. |
| Existing counters | `src/daemon/runtime/dashboard/` already computes `memoryCount`, session and turn counts, and a ROI ledger. | Metrics emission maps onto these existing counters rather than re-deriving them. |
| Primary health signal | `src/daemon/runtime/server.ts` serves an unprotected `/health` with a coarse status. | The runtime status row's `health` field derives from the same health source doctor's `/health` probe already reads. |
| Daemon binds loopback | The daemon binds `127.0.0.1:3850` only. | Telemetry is local-file SQLite read by doctor read-only; no network exposure is added. |
| No registration today | Honeycomb does not write to doctor's registry and does not emit runtime telemetry to SQLite for doctor. | This PRD adds the installer registry entry, the runtime status writes, and the metrics and logs tables. |
| Durable state discipline | AGENTS.md and FR-8 require durable state in Deep Lake, not JSON sidecars, but the local queue is an established SQLite exception. | Telemetry is an operational, non-durable, non-sensitive local surface and follows the local-SQLite precedent, not Deep Lake. |

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-071a-check-in-and-registration`](./prd-071a-service-checkin-and-sqlite-telemetry-checkin-and-registration.md) | Registry entry at install (including the SQLite DB path) plus runtime status writes: binding time, last-seen heartbeat, current health, into doctor's registration surfaces per `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md` | Draft |
| [`prd-071b-metrics-emission`](./prd-071b-service-checkin-and-sqlite-telemetry-metrics-emission.md) | Non-sensitive metrics to local SQLite: actions taken, files processed, memories created since restart, mapped to existing counters, per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md` | Draft |
| [`prd-071c-log-emission`](./prd-071c-service-checkin-and-sqlite-telemetry-log-emission.md) | Non-sensitive logs to local SQLite with verbosity levels, bounded and rotated, per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md` | Draft |

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given honeycomb is installed, when the installer completes, then a static registry entry for honeycomb exists (per `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`) declaring honeycomb's identity and the on-disk path to its runtime telemetry SQLite database. |
| AC-2 | Given honeycomb starts and binds its port, when it checks in, then its runtime status row records a binding time and an initial health value that doctor can read read-only. |
| AC-3 | Given honeycomb is running, when the heartbeat interval fires, then the last-seen value in honeycomb's runtime status advances even if nothing else changed, so doctor can distinguish quiet from dead. |
| AC-4 | Given doctor polls honeycomb's local SQLite on its interval, when honeycomb is doing work, then doctor observes live metrics (actions taken, files processed, memories created since restart) without honeycomb pushing anything. |
| AC-5 | Given honeycomb emits logs, when doctor polls the log table, then it sees recent non-sensitive log lines each carrying a verbosity level. |
| AC-6 | Given honeycomb restarts, when the since-restart counters are next read, then they have reset to reflect the new process lifetime while the registry entry and DB path remain stable. |
| AC-7 | Given the telemetry SQLite write fails or is unavailable, when honeycomb runs, then memory work and daemon boot are unaffected and the failure is fail-soft. |
| AC-8 | Given the log store reaches its bound, when new logs are written, then old rows are rotated out so the store stays bounded. |
| AC-9 | Given doctor reads honeycomb's SQLite, when it opens the database, then it does so read-only and observes no lock contention that stalls honeycomb's own writes (WAL mode, per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`). |
| AC-10 | Given any metric or log row, when it is written, then it contains no token, credential value, raw authorization header, org secret, memory body, or PII. |

---

## Data model changes

No Deep Lake schema change. This PRD adds local telemetry surfaces in honeycomb's own SQLite (the same built-in `node:sqlite` mechanism already used for the local queue), plus a runtime status entry written to doctor's registration surface.

- Runtime status (per `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`): honeycomb's check-in record carrying binding time, last-seen heartbeat, and current health. doctor merges this with the static registry entry. Detailed in PRD-071a.
- `honeycomb_metrics` (local SQLite, latest-wins snapshot): counters since restart such as actions taken, files processed, and memories created, sourced from the existing dashboard counters. Detailed in PRD-071b.
- `honeycomb_logs` (local SQLite, bounded and rotated): non-sensitive log lines with a timestamp and a verbosity level. Detailed in PRD-071c.

The static installer registry records honeycomb's identity and the absolute path to the local SQLite database so doctor knows where to poll, per `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`. doctor opens that database read-only, per `ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md`.

---

## Files expected to change

| File | Expected change |
|---|---|
| `src/commands/install.ts` and installer scripts under `scripts/install/` | Write or refresh honeycomb's static registry entry, including the runtime telemetry SQLite DB path, per `ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md`. |
| New `src/daemon/runtime/telemetry/` module | Local SQLite telemetry writer (metrics snapshot, bounded log table) built on the existing built-in `node:sqlite` usage, and a check-in / heartbeat writer for the runtime status row. |
| `src/daemon/runtime/dashboard/` | Expose or reuse existing counters (`memoryCount`, sessions and turns, ROI) as the source for the metrics snapshot without recomputing. |
| `src/daemon/runtime/server.ts` (read-only consumption) | Source the current health value for the check-in record from the same signal `/health` reports; no behavior change to `/health` itself. |
| `tests/daemon/runtime/telemetry/` | Cover metrics snapshot mapping, log rotation bound, heartbeat advance, since-restart reset, fail-soft, and no-sensitive-data assertions. |

---

## Test plan

- Unit: the metrics snapshot maps existing counters (`memoryCount`, sessions and turns, ROI-derived actions) onto the metrics table without double counting.
- Unit: the heartbeat advances last-seen on interval even with no other change (AC-3).
- Unit: a restart resets the since-restart counters while the registry entry and DB path are unchanged (AC-6).
- Unit: the log table rotates when it reaches its bound (AC-8).
- Unit: telemetry write failure is fail-soft and does not throw into the memory path (AC-7).
- Unit: no row contains sensitive material (AC-10), asserted against a denylist of secret-shaped fields.
- Integration: a doctor-style read-only reader opens honeycomb's SQLite in WAL mode and reads metrics and logs while honeycomb continues writing without lock stalls (AC-9).
- Live proof: install honeycomb, confirm the registry entry and DB path exist, start the daemon, and confirm an external read-only poll sees binding time, advancing last-seen, live metrics, and recent logs.

---

## Open questions

- [ ] Should the runtime status row live in the same local SQLite database as metrics and logs, or in a dedicated status file that doctor's registry merge reads first? Leaning toward one database with separate tables to keep a single DB path in the registry.
- [ ] Heartbeat cadence: match doctor's roughly one-second poll, or run slower to reduce write churn given the poll is what drives freshness?
- [ ] Log verbosity mapping: reuse the daemon logger's existing levels verbatim, or collapse to a small fixed set (error, warn, info, debug) for doctor's rail?
- [ ] Retention bound for `honeycomb_logs`: cap by row count, byte size, or age, and what default keeps the store small enough for a one-second read cycle?

---

## Related

- `../../../../../doctor/library/knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md` - telemetry transport and single source of truth (services write local SQLite, doctor polls).
- `../../../../../doctor/library/knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md` - static installer registry plus runtime SQLite status.
- Expected doctor PRD-001 (source-of-truth telemetry) at `../../../../../doctor/library/requirements/backlog/prd-001-telemetry-source-of-truth/`.
- Expected doctor PRD-002 (registry merge and poll) at `../../../../../doctor/library/requirements/backlog/prd-002-service-registry-and-poll/`.
- Expected hive PRD-005 (health rail and health page) at `../../../../../hive/library/requirements/backlog/prd-005-health-rail-and-health-page/`.
- [PRD-054: Fleet Observation, Control Plane and Read-Only Dashboard](../prd-054-fleet-observation-control-plane/prd-054-fleet-observation-control-plane-index.md) - the read-only-dashboard portion is superseded by the realignment; presence-store precedent for local SQLite telemetry.
- [PRD-069: Application Health Dashboard](../prd-069-application-health-dashboard/prd-069-application-health-dashboard-index.md) - superseded health surface; its health model informs the check-in health field.
- `src/daemon/runtime/dashboard/` - existing counters reused as metric sources.
- `src/daemon/runtime/server.ts` - `/health` source for the check-in health value.

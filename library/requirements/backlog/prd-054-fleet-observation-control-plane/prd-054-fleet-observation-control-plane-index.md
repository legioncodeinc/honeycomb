# PRD-054: Fleet Observation, Control Plane and Read-Only Dashboard (v1)

> **SUPERSEDED (2026-07-03):** Cloud fleet/team management now belongs to Queen, the fleet orchestrator. The canonical copy of this document lives at `queen/library/requirements/backlog/prd-054-fleet-observation-control-plane/prd-054-fleet-observation-control-plane-index.md`. This copy is retained for history only; do not update it here.

> **Status:** Partially superseded. The READ-ONLY DASHBOARD portion only is superseded by [hive PRD-005 (health rail and page)](../../../../../hive/library/requirements/backlog/prd-005-health-rail-and-page/prd-005-health-rail-and-page-index.md) and [doctor PRD-002 (telemetry SoT, SSE, and schema)](../../../../../doctor/library/requirements/backlog/prd-002-telemetry-sot-sse-and-schema/prd-002-telemetry-sot-sse-and-schema-index.md).
>
> Only the read-only-dashboard portion (sub-PRD 054c) is superseded: fleet observation is now rendered by hive from doctor's single source of truth. The control-plane and enrollment portions of this PRD (and of PRD-055) remain in scope. Honeycomb's own telemetry emission as a supervised service is defined in [PRD-071](../prd-071-service-checkin-and-sqlite-telemetry/prd-071-service-checkin-and-sqlite-telemetry-index.md).

> **Status:** Backlog
> **Priority:** P2
> **Effort:** XL (> 3d)
> **Schema changes:** Additive (new presence store; the Deep Lake memory dataset is NOT touched)

---

## Overview

Honeycomb already shares memory across every harness through the Deep Lake data plane, but it has no way to *see* the fleet of agents writing to it: which daemons are alive, what they are doing, whether one is wedged. Each daemon binds `127.0.0.1:3850` and answers `/health` to nobody outside the box. This PRD adds the **control plane's observe half**: a presence substrate that daemons report liveness and status into, and a read-only dashboard that renders the fleet. It deliberately stops short of commanding agents (that is PRD-055) and of changing skill distribution (that is PRD-056).

This is the v1 cut called out in the design doc: maximum visibility, minimum new attack surface. No command channel, no signing, no mint authority yet.

Source of truth: [`fleet-observation-and-on-demand-skills.md`](../../../knowledge/private/collaboration/fleet-observation-and-on-demand-skills.md).

---

## Goals

- A daemon emits a cheap **heartbeat** (`last_seen`) on a fixed interval so liveness is derivable as `now - last_seen > threshold`, independent of whether anything changed.
- A daemon writes a richer **status diff** (current task, version, embeddings health, error state) only on change.
- Presence lives in a fit-for-purpose store (SQLite or Postgres), **never** in the Deep Lake memory dataset, to avoid the write-amplification class of failure that has wedged boot before.
- Ephemeral agents are reaped: rows whose `last_seen` ages past their TTL are dropped, so the fleet view never accumulates dead rows.
- A read-only dashboard renders every agent in the viewer's org with a health state, scoped by the same `x-honeycomb-org` boundary the skills API already enforces.

## Non-Goals

- Commanding an agent (pause, inject, force pull). Owned by [PRD-055](../prd-055-fleet-control-enrollment-and-mint-authority/prd-055-fleet-control-enrollment-and-mint-authority-index.md).
- Per-agent cryptographic identity, enrollment tokens, or signing. Owned by PRD-055.
- Any change to eager skill auto-pull. On-demand skills are [PRD-056](../prd-056-on-demand-skill-fetch/prd-056-on-demand-skill-fetch-index.md).
- A hosted/cloud control plane. v1 presence is reachable wherever the daemon already reaches.

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-054a-presence-store-and-heartbeat-protocol`](./prd-054a-fleet-observation-control-plane-presence-store-and-heartbeat-protocol.md) | The presence store schema + the heartbeat-vs-status-diff write protocol and TTL reaping | Draft |
| [`prd-054b-daemon-presence-reporter`](./prd-054b-fleet-observation-control-plane-daemon-presence-reporter.md) | The daemon-side reporter that emits heartbeats on interval and status on change, fail-soft | Draft |
| [`prd-054c-read-only-fleet-dashboard`](./prd-054c-fleet-observation-control-plane-read-only-fleet-dashboard.md) | The dashboard surface that reads presence and renders the org's fleet, read-only | Draft |

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given two daemons in org X, one idle-but-healthy and one crashed, when the dashboard renders, then the healthy one shows `healthy` and the crashed one shows `offline`, distinguished purely by `last_seen` age. |
| AC-2 | Given a daemon whose state has not changed, when its heartbeat fires, then a `last_seen` row is updated but no new status-diff row is written. |
| AC-3 | Given presence writes from N daemons over an hour, when measured, then zero writes land in the Deep Lake memory dataset and the presence store stays bounded (reaping confirmed). |
| AC-4 | Given a viewer authenticated to org X, when they open the fleet dashboard, then they see only org-X agents and never any agent from another org. |
| AC-5 | Given an ephemeral sub-agent that heartbeats then exits, when its TTL elapses, then its presence row is reaped and it disappears from the fleet view. |

---

## Data model changes

A new **presence store**, separate from Deep Lake. Default SQLite (zero external dependency, matching the mission-control precedent), with a Postgres option for multi-host. Two logical tables:

- `agent_presence`: `(org, agent_id)` primary key, `last_seen` timestamp, `ttl_seconds`, `device_id`, `harness`, `kind` (`orchestrator` | `sub_agent`), `parent_agent_id` nullable. Liveness derived, not stored.
- `agent_status`: append-light, latest-wins per `(org, agent_id)`: `current_task`, `daemon_version`, `embeddings_state`, `error_state`, `updated_at`. Written only on change; compacted on a schedule.

No change to the seven Deep Lake tables. See [`data/deeplake-storage.md`](../../../knowledge/private/data/deeplake-storage.md) for why presence must stay off that substrate.

---

## API changes

- `POST /api/fleet/heartbeat` (protected, org-scoped): upsert `last_seen` and optional status diff. Idempotent; fail-soft on the daemon side so a presence error never blocks real work.
- `GET /api/fleet` (protected, org-scoped, read-only): the fleet roster with derived health for the dashboard.

Both mount onto the daemon's already-protected route group exactly as [`propagation-api.ts`](../../../../src/daemon/runtime/skillify/propagation-api.ts) mounts `/api/skills`, inheriting auth + tenancy via `resolveScopeOrLocalDefault`.

---

## Evaluation and study of other codebases

Selection rule (per Mario, 2026-06-26): **fold code from MIT-licensed projects only**; Apache-2.0 and AGPL are study-only (their ideas inform design, their code is never vendored). Licenses verified June 2026.

**Fold / fork (MIT):**
- [`builderz-labs/mission-control`](https://github.com/builderz-labs/mission-control) (MIT, TypeScript, ~5.4k stars) is the fork base for the dashboard surface and for the presence-store decision. It runs on **SQLite with zero external deps**, has OpenClaw + Claude SDK adapters, and discovers agents under `~/.claude/agents`. Its SQLite choice directly justifies AC-3 (presence off Deep Lake) at near-zero infra cost.
- [`AxmeAI/ai-agent-fleet-dashboard`](https://github.com/AxmeAI/ai-agent-fleet-dashboard) (MIT) contributes its **heartbeat state machine as a copyable spec**: `registering -> healthy -> degraded (1-3x interval late) -> dead (3+ missed) -> killed`, 30s interval. We adopt the states minus `killed` (no commands in v1). The repo itself is too low-star to depend on, so this is pattern-only.

**Study only (license forbids a code fold, ideas are free):**
- doop-os (control plane for AI agents): validates the shape, `POST /heartbeat` updating `last_seen_at`, auto-offline after 5 minutes of silence, an append-only activity log, and per-platform registration listing OpenClaw and "MCP for Claude/Cursor".
- Spawnly: the rule that the **heartbeat is hidden by default** in the timeline (it proves liveness, it is not interesting to read), and the short-lived-vs-long-lived agent distinction that motivates TTL reaping (AC-5).
- Quint fleet: 30s heartbeat cadence with a machine fingerprint on first contact, and the pattern of returning policy on the heartbeat response (relevant later for PRD-055's pull-based commands, not v1).

**What we reuse from our own code:** the mount-onto-protected-group seam and `resolveScopeOrLocalDefault` tenancy from [`propagation-api.ts`](../../../../src/daemon/runtime/skillify/propagation-api.ts); the dashboard shell under [`src/dashboard/web/`](../../../../src/dashboard/web) (see [`frontend/dashboard-architecture.md`](../../../knowledge/private/frontend/dashboard-architecture.md)).

---

## Open questions

- [ ] Presence substrate for v1: SQLite (single-host, simplest) or Postgres (multi-host ready)? Leaning SQLite to match mission-control and ship fastest.
- [ ] Heartbeat cadence and offline cutoff: adopt 30s / 3-missed from AxmeAI, or tune against daemon load and the embeddings runtime budget?
- [ ] Does v1 presence reach a shared store directly, or does each daemon serve its own `/api/fleet` that a local dashboard aggregates? (Determines whether cross-VM works in v1 or waits for PRD-055's enrollment.)

---

## Related

- [`fleet-observation-and-on-demand-skills.md`](../../../knowledge/private/collaboration/fleet-observation-and-on-demand-skills.md) - design source of truth.
- [`prd-055`](../prd-055-fleet-control-enrollment-and-mint-authority/prd-055-fleet-control-enrollment-and-mint-authority-index.md) - the command/identity half this PRD intentionally defers.
- [`prd-056`](../prd-056-on-demand-skill-fetch/prd-056-on-demand-skill-fetch-index.md) - on-demand skills.
- [`operations/observability-and-degradation.md`](../../../knowledge/private/operations/observability-and-degradation.md), [`data/deeplake-storage.md`](../../../knowledge/private/data/deeplake-storage.md).

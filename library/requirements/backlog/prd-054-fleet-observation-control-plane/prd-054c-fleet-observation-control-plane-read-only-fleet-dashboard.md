# PRD-054c: Read-Only Fleet Dashboard

> **SUPERSEDED (2026-07-03):** Cloud fleet/team management now belongs to Queen, the fleet orchestrator. The canonical copy of this document lives at `queen/library/requirements/backlog/prd-007-fleet-observation-control-plane/prd-007c-fleet-observation-control-plane-read-only-fleet-dashboard.md`. This copy is retained for history only; do not update it here.

> **Parent:** [PRD-054](./prd-007-fleet-observation-control-plane-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** L (1-3d)
> **Schema changes:** None

---

## Goals

Render the org's fleet as a single read-only surface: every agent, its derived health, and its last reported status, scoped to the viewer's org. No actions, no commands.

## Scope

- A `GET /api/fleet` read endpoint returning the org roster with derived health.
- A dashboard page (new tab in the existing dashboard shell) listing agents with health, harness, kind, current task, version, and last-seen age.
- Filter/search by health and harness; the heartbeat itself is not surfaced as a row event (hidden by default, per Spawnly's rule).

## Out of scope

- Any write/command control (PRD-055).
- The presence store and reporter (PRD-054a, 054b).

---

## User stories and acceptance criteria

### US-054c.1 - See the whole fleet at a glance

- AC-054c.1.1 Given agents in org X with varied `last_seen`, when the viewer opens the fleet page, then each agent shows `healthy`, `degraded`, or `offline` derived from last-seen age.
- AC-054c.1.2 Given an agent reported a current task, when rendered, then the task and daemon version appear without exposing any other org's data.

### US-054c.2 - Tenancy is airtight

- AC-054c.2.1 Given a viewer authenticated to org X, when `GET /api/fleet` is called, then only org-X rows return, enforced by the same scope resolution as the skills API.
- AC-054c.2.2 Given an unauthenticated or unscoped request, when it hits `GET /api/fleet`, then it fail-closes (400/empty), never a broad scope.

---

## Technical considerations

- Mount `GET /api/fleet` onto the protected group like `mountSkillsReadApi` mounts `GET /api/skills`, reusing `resolveScopeOrLocalDefault` for tenancy (no edits to `server.ts`).
- The page slots into the existing dashboard nav shell (see the dashboard pages PRDs 037-044 for the established pattern) under [`src/dashboard/web/`](../../../../src/dashboard/web).
- Health is computed at read time from `last_seen`, never stored, so a stale writer cannot lie about being alive.
- Distinguish the three failure modes the design doc calls out: store-unreachable vs daemon-wedged vs VM-down should render differently.

## Evaluation and study of other codebases

- **Fork (MIT):** mission-control is the closest existing fleet view (agents/health/status panels, real-time push). Fork its roster + health rendering rather than building from scratch; it already understands OpenClaw and Claude agents.
- **Pattern (MIT):** AxmeAI's table columns (name, status, framework, uptime) and its derived health states are a ready column spec.
- **Study (no fold):** Spawnly's per-agent timeline with heartbeat hidden by default informs what we show versus suppress.

## Files touched (anticipated)

- New: `src/daemon/runtime/fleet/read-api.ts` (`GET /api/fleet`), a new dashboard page under `src/dashboard/web/pages/`, wiring in `src/dashboard/web/wire.ts`. Tests for the read endpoint and scope enforcement.

## Test plan

- Route: org-scoped read returns only in-org agents (AC-054c.2.1); unscoped fail-closes (AC-054c.2.2).
- Render: health derivation from last-seen age (AC-054c.1.1); task/version display (AC-054c.1.2).

## Open questions

- [ ] Live updates via the dashboard's existing push channel, or poll-on-interval for v1?

# PRD-051b: Read-Only Health API

> **Parent:** [PRD-051](./prd-051-repository-health-and-knowledge-drift-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** S (< 1d)
> **Schema changes:** None. Serves the derived snapshot from 051a over loopback.

---

## Overview

A thin, read-only HTTP surface that hands the 051a `HealthSnapshot` (and per-signal evidence) to the dashboard, mounted beside the existing dashboard host group under the same loopback + local-mode gate. No new bind, no token, no outbound calls. This sub-PRD exists to keep the engine (051a) and the page (051c) decoupled across the daemon/UI seam the repo already uses.

## Goals

- `GET /health/repo?project=<id>`: returns the rolled-up band plus per-signal summaries (counts + top evidence) for the selected project, served from the derived cache, recomputing on cache miss.
- `GET /health/repo/signal/<signal>?project=<id>`: returns the full evidence rows for one signal for the expand-to-evidence interaction.
- `POST /health/repo/recompute?project=<id>`: invalidates the derived cache and recomputes; read-only with respect to the repository (it only rebuilds the cache).
- Strict **scope honesty**: an endpoint answers only for the requested project and never leaks another project's signals.
- Same **local-mode + loopback gate and no-secret posture** as the rest of the dashboard host group.

## Non-Goals

- Computing the signals (051a) or rendering them (051c).
- Any write to the repository or the DeepLake catalog.
- Pagination/streaming for very large evidence sets (note as an open question if a repo produces thousands of rows; v1 may cap and label).

## User stories

- As the dashboard, I fetch one endpoint on page load and get everything I need for the summary view without client-side computation.
- As the dashboard, when a user expands a signal, I fetch its evidence rows on demand rather than shipping them all up front.

## Acceptance criteria

| ID | Criterion |
|---|---|
| b-AC-1 | `GET /health/repo?project=<id>` returns 200 with the band + per-signal summaries for the requested project, sourced from the derived cache, and triggers a recompute on cache miss. |
| b-AC-2 | `GET /health/repo/signal/<signal>?project=<id>` returns the evidence rows for the named signal; an unknown signal name returns a clean 404/400, not a 500. |
| b-AC-3 | The endpoints are reachable only in local mode over loopback and carry no token/secret (parity assertion with the dashboard host gate); they are unreachable in non-local mode. |
| b-AC-4 | Requests for project A never return project B's signals; a test asserts scope isolation. |
| b-AC-5 | With no project selected / an unknown project id, the endpoint returns an explicit empty/needs-project payload, not an error. |
| b-AC-6 | `POST /health/repo/recompute` rebuilds the derived cache and performs no repository write; a test asserts the working tree is unchanged after a recompute. |

## Implementation notes

- Mount under the existing dashboard host group next to [`mountDashboardHost`](../../../../src/daemon/runtime/dashboard/host.ts), reusing the same local-mode gate and route-registration pattern as [`setup-state.ts`](../../../../src/daemon/runtime/dashboard/setup-state.ts) and [`sync-api.ts`](../../../../src/daemon/runtime/dashboard/sync-api.ts).
- Validate query params with zod; resolve `project` through the same project-identity resolution PRD-049 introduced so scope semantics match the rest of the dashboard.
- Keep handlers dumb: they call the 051a engine/cache accessor and serialize. No business logic in the route.
- Treat the snapshot as a cache read with recompute-on-miss; the recompute endpoint shares that path with an explicit invalidate.

## Open questions

- [ ] Evidence-row caps for pathological repos (cap + "N more" label vs pagination).
- [ ] Whether `recompute` should be rate-limited to avoid a user hammering a large-repo recompute.
- [ ] Shape alignment with the existing dashboard data-fetch conventions ([`wire.ts`](../../../../src/dashboard/web/wire.ts)).

## Related

- [`src/daemon/runtime/dashboard/host.ts`](../../../../src/daemon/runtime/dashboard/host.ts) — the host group + local-mode gate.
- [`src/daemon/runtime/dashboard/setup-state.ts`](../../../../src/daemon/runtime/dashboard/setup-state.ts) and [`sync-api.ts`](../../../../src/daemon/runtime/dashboard/sync-api.ts) — sibling read-only loopback endpoints to mirror.
- [Request Lifecycle](../../../knowledge/private/architecture/request-lifecycle.md) — assembly order + gate.
- Sibling sub-PRDs: [051a signal engine](./prd-051a-repository-health-and-knowledge-drift-signal-engine.md), [051c dashboard page](./prd-051c-repository-health-and-knowledge-drift-dashboard-page.md).

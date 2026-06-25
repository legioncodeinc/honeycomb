# PRD-049e: Dashboard Org / Workspace / Project Switcher

> **Parent:** [PRD-049](./prd-049-multi-project-and-context-switching-index.md)
> **Status:** Completed — shipped with PRD-049 (merged #101, 2026-06-25)
> **Priority:** P1
> **Effort:** L (1-3d)
> **Schema changes:** None — consumes 049a resolution + DeepLake enumeration.

---

## Overview

The dashboard's project-specific surfaces — codebase graph and memory graph (PRD-041), memories (PRD-040), sync (PRD-042) — are currently bound to whatever single scope the daemon resolves. This sub-PRD adds a **three-level scope switcher** to the dashboard nav shell (PRD-037): pick an Org (Company), then a Workspace (Team), then a Project the user has access to, and every project-specific page re-scopes to that selection. It is the visual counterpart to 049d, backed by the same `GET /organizations` / `GET /workspaces` enumeration plus the 049a `projects` registry.

## Goals

- A nav-shell switcher showing the active Org → Workspace → Project, with dropdowns listing only scopes the user has privileges in (and the workspace's projects from the registry, including `__unsorted__`).
- Selecting an Org repopulates Workspaces (and re-mints the org-bound token if the org changed — PRD-011 mechanic); selecting a Workspace repopulates its Projects.
- Codebase graph, memory graph, memories, and sync pages read the selected `project_id` and re-fetch on change.
- The switcher reflects the *resolved* state and persists the selection for the dashboard session; the dashboard is a viewer — it does not mutate the developer's per-folder CLI bindings unless an explicit "bind a folder here" action is taken.

## Non-Goals

- The CLI switching surface (049d).
- Building new graph/memory/sync visualizations — only re-scoping the existing ones (PRD-040/041/042).
- Cross-project aggregate views ("all my projects at once") — out of module scope.

## User stories

- As a developer, I open the dashboard, pick ACME → `backend` → `api`, and the codebase graph and memory graph show that project's data.
- As a developer in two companies, switching the Org dropdown to my other company shows only workspaces/projects I belong to there.
- As a developer, switching project in the dashboard does not silently change what my running CLI sessions write to.

## Acceptance criteria

| ID | Criterion |
|---|---|
| e-AC-1 | The switcher lists orgs from `GET /organizations`, workspaces from `GET /workspaces`, and projects from the 049a registry — all scoped to the user's privileges; nothing they lack access to appears. |
| e-AC-2 | Selecting a Project re-scopes the codebase graph, memory graph, memories, and sync pages to that `project_id` on the next render. |
| e-AC-3 | Changing the Org triggers the daemon org-bound token re-mint (PRD-011) before workspace/project enumeration for the new org. |
| e-AC-4 | The dashboard selection is viewer-side; it does not overwrite a developer's per-folder CLI bindings (049a/049d) unless an explicit bind action is taken. |
| e-AC-5 | With no project selected (or none accessible), the project-specific pages render an explicit empty/needs-selection state, not another project's data. |

## Implementation notes

- Switcher lives in [`src/dashboard/web/sidebar.tsx`](../../../../src/dashboard/web/sidebar.tsx) / nav shell (PRD-037); wiring through [`src/dashboard/web/wire.ts`](../../../../src/dashboard/web/wire.ts) (which already carries a `project` field) and the page components ([`pages/graph.tsx`](../../../../src/dashboard/web/pages/graph.tsx), memories, sync).
- The daemon exposes the enumeration (shared with 049d) + the `projects` registry, and a "set dashboard scope" that drives the data fetches; reuse existing page data contracts, parameterized by the selected `project_id`.
- Mind the dogfood lesson on dashboard data wiring (project memory: graph edges / harness turns) — verify the graph and memory pages actually re-query on scope change rather than showing cached first-scope data.

## Open questions

- [ ] Does the dashboard offer "bind this folder to this project" inline (writing the 049a store), or stay read-only and defer binding to the CLI?
- [ ] Persist the dashboard's last selection across reloads (localStorage) or always resolve from the daemon default?
- [ ] Surface `__unsorted__` inbox size + a "re-file unsorted → project" action here (index open question)?

## Related

- [PRD-037 Dashboard Nav Shell](../../completed/prd-037-dashboard-nav-shell/prd-037a-dashboard-nav-shell-sidebar.md) · [PRD-041 Graph Page](../../completed/prd-041-graph-page/prd-041-graph-page-index.md)
- [PRD-040 Memories Page](../../completed/prd-040-memories-page/prd-040a-memories-page-browse-search-view.md) · [PRD-042 Sync Page](../../completed/prd-042-sync-page/prd-042-sync-page-index.md)
- [`src/dashboard/web/wire.ts`](../../../../src/dashboard/web/wire.ts) — already carries a `project` field. · [`src/dashboard/web/sidebar.tsx`](../../../../src/dashboard/web/sidebar.tsx)
- DeepLake API: `GET /organizations`, `GET /workspaces`, `GET /workspaces/{id}/users`.

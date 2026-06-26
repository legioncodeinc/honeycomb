# PRD-059c: The Projects Page and "Add a Project"

> **Parent:** [PRD-059](./prd-059-projects-onboarding-index.md)
> **Status:** Backlog
> **Priority:** P1
> **Effort:** L (1-3d)
> **Schema changes:** None (reads the 049a registry/cache + per-project counts; writes bindings via the daemon).

---

## Overview

Once a user has bound at least one project, they need a home for managing them. This sub-PRD adds a **Projects** entry to the left-nav (PRD-037 nav shell) and the page behind it: a list of every project Honeycomb is **actively sourcing data for** in the current workspace, with per-project state, and a top-right **Add a project** action that runs the same folder-pick → bind flow as 059b. It is the steady-state counterpart to 059b's first-run CTA.

## Goals

- A **Projects** item in the left nav opens a page listing the active workspace's projects (from the 049a registry/synced cache), each showing: project name, bound folder path(s) on this device, git remote (if any), last capture time, and memory/session counts.
- The reserved `__unsorted__` inbox is shown distinctly (as the catch-all), with its size surfaced so it does not rot (049 inbox-hygiene hook).
- A top-right **Add a project** button runs the 059b daemon-served folder-pick → bind flow, after which the new project appears in the list.
- Per-project actions: open the project's scope in the other dashboard surfaces (memories/graph/sync — driving the existing 049e view scope), and **unbind this folder** (remove the local binding without deleting the registry project).

## Non-Goals

- Cross-device import (059d owns "bind an existing cloud project").
- Deleting a registry project / destructive registry edits (registry CRUD beyond bind/unbind is out of scope here).
- Re-architecting the other surfaces; the Projects page links into them via the existing scope mechanism.

## User stories

- As a set-up user, I click **Projects** in the nav and see `honeycomb`, `ospry`, and `__unsorted__ (12)`, each with its folder and last-capture time.
- As a user starting work in a new repo, I click **Add a project** in the top-right, pick the folder, and it joins the list.
- As a user who bound the wrong folder, I click **Unbind** on a project and capture for that folder stops — without nuking the project's existing memories.

## Acceptance criteria

| ID | Criterion |
|---|---|
| c-AC-1 | Given ≥1 bound project, when the user opens **Projects** from the nav, then every project Honeycomb is sourcing in this workspace is listed with name, bound path(s), git remote, last capture, and memory/session counts. |
| c-AC-2 | Given the `__unsorted__` inbox has rows, when the page renders, then the inbox is shown distinctly with its current size. |
| c-AC-3 | Given the page, when the user clicks **Add a project** (top-right), then the 059b folder-pick → bind flow runs and the new project appears on success. |
| c-AC-4 | Given a listed project, when the user clicks **Unbind**, then the local folder binding is removed (capture stops for that folder) and the registry project + its existing data are untouched. |
| c-AC-5 | Given a listed project, when the user opens it, then the memories/graph/sync surfaces re-scope to that project (049e view scope). |

## Implementation notes

- **Nav entry:** add to the nav shell sidebar ([PRD-037a](../../completed/prd-037-dashboard-nav-shell/prd-037a-dashboard-nav-shell-sidebar.md)); the page is a new dashboard route alongside memories/graph/sync.
- **List source:** reuse `GET /api/diagnostics/scope/projects` (049e) for the registry list; per-project counts/last-capture come from cheap aggregate reads (decide live vs on-demand per the parent open question — likely on-demand to keep the page fast).
- **Add/unbind:** the same daemon bind route as 059b; unbind removes the `projects.json` binding for the folder without touching the registry row.
- **Distinguish bound-here vs registry-only:** a project can exist in the registry (made on another device) without a local binding — show those as importable (handoff to 059d), not as actively-sourcing.

## Open questions

- [ ] Live vs on-demand per-project stats (counts, last capture) — render lazily to keep the list fast?
- [ ] Should "Add a project" and "Import project from cloud" (059d) be one combined "+ Add" menu (New folder / Import existing) or two distinct buttons? (Lean: one "+" with two options.)
- [ ] Unbind vs forget: do we ever offer deleting a registry project + its data from here, or is that strictly a CLI/destructive-confirm action elsewhere?

## Related

- [PRD-059b: Folder Picker](./prd-059b-projects-onboarding-folder-picker.md) — the Add-a-project flow reused here.
- [PRD-059d: Cross-Device Import](./prd-059d-projects-onboarding-cross-device-import.md) — registry-only projects link into this list.
- [PRD-037a: Dashboard Nav Shell](../../completed/prd-037-dashboard-nav-shell/prd-037a-dashboard-nav-shell-sidebar.md) — where the nav entry slots in.
- [PRD-049e: Dashboard Scope Switcher](../../completed/prd-049-multi-project-and-context-switching/prd-049e-multi-project-and-context-switching-dashboard-scope-switcher.md) — the view scope the per-project "open" drives.

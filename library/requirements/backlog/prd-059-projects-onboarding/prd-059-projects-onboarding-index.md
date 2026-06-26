# PRD-059: Project Onboarding and the Projects Page

> **Status:** Backlog
> **Priority:** P1
> **Effort:** XL (> 3d)
> **Schema changes:** Additive — reuses the PRD-049a `projects` registry + `~/.deeplake/projects.json` binding store; adds a per-workspace "has the user bound a project yet?" onboarding signal and a device-binding marker for cross-device import. No partition changes.

---

## Overview

PRD-049 made **Project** a first-class, cwd-resolved segmentation dimension and shipped the registry, the resolution precedence (binding > git signal > path > `__unsorted__` inbox), the CLI verbs, and a dashboard scope switcher. What it did **not** ship is an *onboarding story* for the project dimension: how a brand-new user goes from "I just logged in" to "Honeycomb is sourcing data for the right folders." Today that gap produces three concrete failures, all observed live during onboarding:

1. **Nothing to select.** A new user lands on the dashboard with zero bound projects (the `projects` table/cache is empty until the first `honeycomb project bind`), so the project switcher is empty and there is no obvious next action.
2. **Silent collection before consent.** Capture still runs and accrues to the per-workspace `__unsorted__` inbox (049a's "never drop" policy), so the product is hoarding unscoped data behind an empty UI before the user has chosen anything (tracked as [IRD-123](../../../issues/backlog/ird-123-gate-capture-until-first-project-bind/ird-123-gate-capture-until-first-project-bind-index.md)).
3. **A switcher that lies.** The dashboard Org→Workspace→Project switcher is viewer-side only — selecting a value persists nothing and changes no capture scope (tracked as [IRD-122](../../../issues/backlog/ird-122-dashboard-scope-switcher-viewer-only/ird-122-dashboard-scope-switcher-viewer-only-index.md)). A user who "switches a project" in the UI has done nothing.

This module turns Project from an implicit, CLI-only concept into an **explicit, dashboard-first onboarding gate and management surface**. The shape, in the user's words: *"no active projects? pick a folder to start"*, then a dedicated **Projects** page in the left nav listing the projects Honeycomb is actively sourcing, with **Add a project** (point at a folder → bind) in the top-right, and **Import project from cloud** to re-attach this device to a project that already exists in the workspace registry (the cross-device case). And — deliberately reversing 049a's "never drop" for the *pre-onboarding* state — **Honeycomb collects nothing until at least one project is bound.**

The third level of tenancy now reads end-to-end as a product flow, not just a data model:

> **Org = Company → Workspace = Team → Project = a folder you explicitly put Honeycomb to work on.**

---

## Goals

- A first-run user with zero bound projects is met with a single clear call to action — **"Pick a folder to start"** — that binds a real local folder to a project, with plain instructions to point at the repo they want Honeycomb to remember.
- **No capture, summarization, skillify, or graph work happens until the workspace has at least one bound project.** Before that, the capture hooks no-op with a one-line "bind a project to start" notice instead of writing to `__unsorted__`.
- A dedicated **Projects** page in the nav lists every project Honeycomb is actively sourcing data for in the current workspace, with per-project state (bound folder(s), git remote, last capture, memory/session counts).
- **Add a project** from the page binds another local folder to a new or existing project; the folder selection is real (absolute-path-correct), driven by the local daemon, not a browser sandbox guess.
- **Import project from cloud** lets a user on a second device attach that device's folder to a project that already exists in the workspace registry (created on device A), so one project spans machines via an explicit, listed action rather than relying solely on the git-remote auto-bind signal.
- The dashboard's project surfaces stop silently misleading: a selection either persists a real scope change or is unambiguously labeled a view filter ([IRD-122](../../../issues/backlog/ird-122-dashboard-scope-switcher-viewer-only/ird-122-dashboard-scope-switcher-viewer-only-index.md)).

## Non-Goals

- **Re-architecting isolation.** The Org/Workspace partition (PRD-011) and the project soft-segment clause (PRD-049) are unchanged. This is a UX + lifecycle layer on top of the existing registry, not a new data boundary.
- **Auto-scanning the filesystem for repos.** Honeycomb does not crawl `~/GitHub/**` or enumerate harness installs to discover projects. Binding stays explicit (folder-picker or CLI); the git remote remains only an auto-*suggest* signal once a folder is in play. (Auto-discovery is an explicit non-goal — it is a privacy and surprise hazard.)
- **Replacing the CLI verbs.** `honeycomb project bind|use|list|status` (049d) remain the source of truth; the dashboard drives the same store, never a parallel one.
- **Backfilling existing `__unsorted__` data** into projects. A re-file action for the inbox is noted but owned by the 049 open question, not built here.
- **Workspace/org creation.** Provisioning a new workspace is still out of scope (no `createWorkspace` exists); import-from-cloud attaches to existing registry projects within the already-active workspace.

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-059a-projects-onboarding-capture-gating`](./prd-059a-projects-onboarding-capture-gating.md) | Gate all capture/pipeline work until the workspace has ≥1 bound project; no-op-with-notice instead of `__unsorted__` writes in the zero-projects state. Resolves [IRD-123](../../../issues/backlog/ird-123-gate-capture-until-first-project-bind/ird-123-gate-capture-until-first-project-bind-index.md). | Draft |
| [`prd-059b-projects-onboarding-folder-picker`](./prd-059b-projects-onboarding-folder-picker.md) | The first-run empty state ("No active projects? Pick a folder to start") and the daemon-served folder picker that binds a real absolute path. | Draft |
| [`prd-059c-projects-onboarding-projects-page`](./prd-059c-projects-onboarding-projects-page.md) | The **Projects** nav page: list active projects + per-project state, the top-right **Add a project** action, unbind/re-file. | Draft |
| [`prd-059d-projects-onboarding-cross-device-import`](./prd-059d-projects-onboarding-cross-device-import.md) | **Import project from cloud**: list the workspace's existing registry projects and bind this device's folder to a chosen one (cross-device). | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion |
|---|---|
| AC-1 | Given a logged-in user whose active workspace has **zero** bound projects, when any harness session runs, then no row is written to `memory`/`sessions`/`memory_jobs` (no `__unsorted__` capture), and the user sees a single "bind a project to start" prompt. |
| AC-2 | Given that zero-projects state, when the user opens the dashboard, then the primary surface is a **"Pick a folder to start"** call-to-action with instructions, not an empty switcher. |
| AC-3 | Given the user picks a local folder in the dashboard, when the bind completes, then the **absolute** path is recorded in the 049a binding store, capture begins for sessions under that folder, and the project appears on the Projects page. |
| AC-4 | Given ≥1 bound project, when the user opens the **Projects** page from the left nav, then it lists every project Honeycomb is sourcing in this workspace with per-project state, and a top-right **Add a project** action binds another folder. |
| AC-5 | Given a project that already exists in the workspace registry (bound on another device), when the user uses **Import project from cloud** on this device and selects it, then this device's chosen folder is bound to that same `project_id` and capture flows into the shared project. |
| AC-6 | Given the dashboard project/workspace/org switcher, when the user changes a selection, then it either persists a real scope change (via the daemon switch path) or is unambiguously presented as a view filter — never a silent no-op (closes [IRD-122](../../../issues/backlog/ird-122-dashboard-scope-switcher-viewer-only/ird-122-dashboard-scope-switcher-viewer-only-index.md)). |

---

## Data model changes

Additive, no partition or clause changes beyond PRD-049:

- **Onboarding signal (per workspace):** a cheap "does this workspace have ≥1 bound project for this device/user?" check the capture gate reads. Backed by the existing 049a registry/cache (count of non-`__unsorted__` projects with a binding) — no new table required; if a persisted marker proves cleaner it is a single additive field on the onboarding state (`~/.deeplake/onboarding.json`).
- **Device binding for import (049d cross-device):** the `projects` registry already carries the durable project identity; import binds this device's folder → an existing `project_id` in the local `projects.json` and lets the daemon sync mirror it. May warrant recording which device contributed a binding (additive column on the registry) so the Projects page can show "bound on 2 devices."
- No change to `memories`/`sessions`/`project_id`/the scope clause.

---

## API changes

The partition boundary is unchanged. New daemon (loopback, local-mode) surface:

- **Folder browse + bind (059b/059c):** a daemon-served directory browser (`GET /api/.../fs/browse?path=`) and a `POST .../projects/bind { path, name }`. The daemon (not the browser) enumerates the filesystem because the browser File System Access API hides absolute paths; the daemon already has fs access and is the only component that can return a real bindable path. Strictly loopback + local-mode-gated like the rest of the dashboard control surface.
- **Capture-gate read (059a):** the capture/recall hooks consult the "≥1 project bound" signal before doing pipeline work (resolved locally from `projects.json`, no network).
- **Registry project enumeration for import (059d):** reuse `GET /api/diagnostics/scope/projects` (049e) to list the workspace's registry projects, plus a bind-to-existing variant of the bind route.
- **Switcher persistence (IRD-122):** the dashboard org/workspace switch calls the daemon `org switch` / `workspace switch` paths (which `saveDiskCredentials`) instead of localStorage-only, or is relabeled a view filter.

---

## Open questions

- [ ] **Folder picker mechanism.** Confirmed constraint: a browser cannot hand back an absolute path (File System Access API returns an opaque handle). Lean: a daemon-served directory browser (the daemon has fs access). Alternative: a "paste/confirm the path" field pre-filled from the daemon's cwd knowledge. Which is the v1?
- [ ] **Gate granularity (the 049a tension).** 049a's principle is "capture is never dropped → inbox." 059a reverses that for the *zero-projects* state only. Open: once ≥1 project is bound, does the `__unsorted__` inbox fallback resume for *unbound* folders (lean: yes — the gate is strictly the first-run zero-state), or does the user opt into inbox-capture explicitly?
- [ ] **What counts as "bound enough" to start?** Any non-inbox binding, or does the user have to confirm the suggested git-remote project? Lean: the explicit folder-pick or an explicit accept of the git suggestion.
- [ ] **Cross-device import discovery.** Is the import list the full workspace registry (every project anyone on the team made) or only projects the current user created? Privilege-scope it to what the token can see; default to the workspace's registry projects.
- [ ] **Multi-folder projects.** Can one project bind several local folders (monorepo subdirs, worktrees) on one device — and does the Projects page show them grouped? (Mirror the 049 worktree/monorepo open question.)
- [ ] **What does "sourcing data" show?** Per-project state on the Projects page: last capture time, memory/session counts, embeddings on/off, sync status — which of these are cheap enough to render live vs. on demand?

---

## Related

- [PRD-049: Multi-Project Isolation and Context Switching](../../completed/prd-049-multi-project-and-context-switching/prd-049-multi-project-and-context-switching-index.md) — the registry, resolution precedence, and the inbox policy this module's onboarding builds on and (for the zero-state) revises.
- [PRD-049d: Org/Workspace Switching and Project Binding (CLI)](../../completed/prd-049-multi-project-and-context-switching/prd-049d-multi-project-and-context-switching-org-workspace-switching.md) — the `project bind|use|list|status` store the dashboard drives.
- [PRD-049e: Dashboard Scope Switcher](../../completed/prd-049-multi-project-and-context-switching/prd-049e-multi-project-and-context-switching-dashboard-scope-switcher.md) — the viewer-only switcher IRD-122 corrects.
- [PRD-050: Quick Install and Guided Setup](../../completed/prd-050-quick-install-and-guided-setup/prd-050-quick-install-and-guided-setup-index.md) — the install/onboarding surface this extends (the dashboard is the guided-setup home).
- [PRD-037: Dashboard Nav Shell](../../completed/prd-037-dashboard-nav-shell/prd-037a-dashboard-nav-shell-sidebar.md) — where the **Projects** nav entry slots in.
- [IRD-122](../../../issues/backlog/ird-122-dashboard-scope-switcher-viewer-only/ird-122-dashboard-scope-switcher-viewer-only-index.md) · [IRD-123](../../../issues/backlog/ird-123-gate-capture-until-first-project-bind/ird-123-gate-capture-until-first-project-bind-index.md)
- Code: [`src/hooks/shared/project-resolver.ts`](../../../../src/hooks/shared/project-resolver.ts) (precedence + inbox), [`src/cli/project.ts`](../../../../src/cli/project.ts) (bind/use/list/status), [`src/dashboard/web/scope-context.tsx`](../../../../src/dashboard/web/scope-context.tsx) (viewer-only switcher), [`src/daemon/runtime/projects/scope-enumeration-api.ts`](../../../../src/daemon/runtime/projects/scope-enumeration-api.ts) (scope reads).

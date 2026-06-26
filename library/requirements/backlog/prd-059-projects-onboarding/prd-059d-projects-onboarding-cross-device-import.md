# PRD-059d: Cross-Device "Import Project from Cloud"

> **Parent:** [PRD-059](./prd-059-projects-onboarding-index.md)
> **Status:** Backlog
> **Priority:** P2
> **Effort:** M (3-8h)
> **Schema changes:** Additive (optional) — record which device contributed a binding so the Projects page can show multi-device projects.

---

## Overview

A project is a durable, workspace-scoped registry identity (PRD-049a), but a *binding* (folder → project) is local to one device's `~/.deeplake/projects.json`. So when a user sets up Honeycomb on a second machine, the project they created on machine A exists in the cloud registry but has no local binding on machine B — and the git-remote auto-bind signal only fires if that exact repo is checked out with the same remote. This sub-PRD adds an explicit **Import project from cloud**: list the workspace's existing registry projects and bind this device's chosen folder to one of them, so a single project spans machines deliberately rather than by coincidence of git remote.

## Goals

- A user on a new device can see the projects that already exist in the active workspace's registry (privilege-scoped) and **import** one — i.e., bind a local folder on this device to that existing `project_id`.
- Imported capture flows into the **same** project as device A: a recall on either device sees the shared project's memories (subject to the existing 049 isolation/scope rules).
- The action is explicit and listed, complementing — not replacing — the 049a git-remote auto-bind signal.

## Non-Goals

- Creating new projects (059b/059c) or new workspaces (out of scope project-wide).
- Federated cross-project search (a 049 non-goal).
- Automatically importing every registry project onto every device (explicitly not — import is a deliberate per-folder action).

## User stories

- As a user who set up `api` on my laptop, I open Honeycomb on my desktop, click **Import project from cloud**, pick `api` from the list, point it at my desktop's `~/work/api` checkout, and both machines now feed the one project.
- As a user on a fresh device whose repo has the same git remote as an existing project, I am offered the matching project as the top import suggestion (remote signal as a hint, not a silent auto-bind).

## Acceptance criteria

| ID | Criterion |
|---|---|
| d-AC-1 | Given a workspace with registry projects created elsewhere, when the user opens **Import project from cloud**, then the list shows those projects (privilege-scoped to what the token can see), distinct from projects already bound on this device. |
| d-AC-2 | Given the user selects a registry project and a local folder, when import completes, then this device's folder is bound to that existing `project_id` in the local store and capture flows into the shared project. |
| d-AC-3 | Given an imported project, when the user recalls on this device, then results include the project's existing memories from other devices (per 049 scope rules), proving it is the same project, not a new one. |
| d-AC-4 | Given a local folder whose git remote matches an existing registry project, when the user opens import, then that project is surfaced as the suggested match (hint only — no silent auto-bind). |

## Implementation notes

- **List source:** the workspace's registry projects via `GET /api/diagnostics/scope/projects` (049e), filtered to those without a local binding on this device (the rest are already "active" on the Projects page).
- **Import = bind-to-existing:** reuse the daemon bind route with an existing `project_id` (vs. create-inline in 059b), writing the folder→existing-project mapping to `projects.json`; the daemon sync mirrors the new device binding to the registry.
- **Multi-device visibility (optional schema):** an additive marker (e.g. device id on a binding row in the registry) lets the Projects page show "bound on 2 devices"; defer if it complicates the 049a sync.
- **Remote hint:** reuse the 049a canonical-remote matcher to rank a suggested project when the chosen folder has a known remote.

## Open questions

- [ ] Import list scope: all workspace registry projects vs only those the current user created? (Lean: privilege-scoped to the token; show the workspace's projects.)
- [ ] Do we need the additive device-id marker for v1, or is "has a local binding" (purely local knowledge) enough to distinguish active vs importable?
- [ ] Naming: "Import project from cloud" vs "Attach existing project" vs "Bind to existing" — pick the term users grok (the user's phrasing was "import project from cloud").

## Related

- [PRD-059c: Projects Page](./prd-059c-projects-onboarding-projects-page.md) — where importable (registry-only) projects surface and link from.
- [PRD-049a: Project Identity and Resolution](../../completed/prd-049-multi-project-and-context-switching/prd-049a-multi-project-and-context-switching-project-identity-and-resolution.md) — the registry vs local-binding split this bridges, and the git-remote signal reused as a hint.
- [PRD-049c: Skill Isolation](../../completed/prd-049-multi-project-and-context-switching/prd-049c-multi-project-and-context-switching-skill-isolation.md) — cross-project sharing rules that still apply to an imported project.
- [`src/daemon/runtime/projects/scope-enumeration-api.ts`](../../../../src/daemon/runtime/projects/scope-enumeration-api.ts) · [`src/hooks/shared/project-resolver.ts`](../../../../src/hooks/shared/project-resolver.ts)

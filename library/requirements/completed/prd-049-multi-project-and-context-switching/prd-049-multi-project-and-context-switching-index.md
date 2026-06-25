# PRD-049: Multi-Project Isolation and Context Switching

> **Status:** Completed — merged #101 (2026-06-25). All 5 sub-PRDs (27 sub-ACs) + 8 module ACs VERIFIED; security clean at Medium+ (×2), quality PASS.
> **Priority:** P1
> **Effort:** XL (> 3d)
> **Schema changes:** Additive — new `projects` registry table; promote the existing free-text `project` column to a resolved `project_id`; thread it into the scope clause.

---

## Overview

A developer works in many projects at once — several repos open simultaneously across Claude Code, Cursor, Codex, and harnesses like Hermes/OpenClaw that may have **no git repository at all** — and each project is a different body of work, often a different team, sometimes a different company. Today Honeycomb resolves tenancy from a **single, machine-global active workspace** held in one field of `~/.deeplake/credentials.json` (`workspaceId`), switched manually with `honeycomb workspace use`. That model silently breaks the moment two projects are open at once: every concurrent harness session reads the same `workspaceId`, so memory captured while working in project A lands in — and is recalled into — the workspace the user last switched to, regardless of which directory the session is actually running in. Skills propagate the same way, and the dashboard's project-specific views (codebase graph, memory graph) can only ever show the one globally-selected scope.

This module introduces **Project** as a first-class, automatically-resolved segmentation dimension *inside* a workspace, and makes scope **per-session, not per-machine**. The tenancy then reads cleanly as three levels:

> **Org = Company → Workspace = Team → Project = a folder-bound segment of a team's work.**

The third level deliberately lives **inside** the workspace, not above it: a Team (workspace) owns many projects, so binding a project to its own workspace would shatter the team grouping. This is also why the project key is **not** a GitHub repository ID — repos do not exist in OpenClaw/Hermes/scratch dirs, and the codebase already keys "Repository-style" scope off `projectDir ?? process.cwd()` ([`assets/install.ts:486`](../../../../src/daemon-client/assets/install.ts)), never a GitHub ID. Instead, a project is a registry-backed identity that **folders are assigned to**, with a git remote (when present) acting only as an optional auto-bind *signal*, not the identity.

Crucially, **the data layer already has the seam**: `memories` and `sessions` carry a `project` column today ([`catalog/memories.ts:65`](../../../../src/daemon/storage/catalog/memories.ts)) — currently unmanaged free text holding the raw cwd path, used only for display. This module promotes that column from descriptive metadata into a managed `project_id` resolved against a `projects` registry, threaded into the scope clause exactly the way `agent_id` already is. So Project joins the existing **inner ring** (soft, column-and-clause segmentation alongside `agent_id`/`visibility`); the **outer ring** (Org + Workspace, enforced at the DeepLake storage partition per [PRD-011](../../completed/prd-011-tenancy-and-auth/prd-011-tenancy-and-auth-index.md)) is untouched. Hard isolation stays at the company/team boundary; project is a soft segment within a team — the correct trust level, since projects within one team are not a security boundary the way two companies are.

**This index covers the module scope.** The five sub-PRDs cover project identity & resolution, per-project memory isolation, per-project skill isolation, org/workspace switching, and the dashboard scope switcher.

---

## Goals

- A **Project** is a registry-backed identity that folders are bound to, resolved **per session from the working directory** — never from a machine-global field. A git remote, when present, only *proposes* a binding; resolution works identically with no repo (OpenClaw/Hermes/scratch dirs).
- Two (or ten) projects open concurrently across any mix of harnesses, under one logged-in identity and one credentials file, each capture to and recall from their own `project_id` with zero cross-project bleed and zero manual switching.
- Capture is **never dropped**: an identity-less folder falls to a per-workspace `__unsorted__` inbox project (re-fileable later), consistent with how `agent_id` defaults to `'default'` rather than failing closed on write. Recall stays **narrow** — an unbound session sees only its inbox + workspace-global rows, never other projects.
- Skills (skillify output and team SKILL.md propagation) are isolated per project by default, with cross-project sharing an explicit, auditable opt-in.
- A user can list and switch between the organizations and workspaces they have privileges in — from CLI and dashboard — backed by `GET /organizations` and `GET /workspaces`; org switch re-mints the org-bound token (PRD-011 mechanic), workspace/project switches are scope-only.
- The dashboard's project-specific surfaces (codebase graph, memory graph, memories, sync) all follow the selected Org → Workspace → Project scope from a single switcher in the nav shell.

## Non-Goals

- **Re-architecting storage isolation.** Org/workspace partition isolation (PRD-011) is the hard boundary and is not touched; Project is added to the *soft inner ring* (column + scope clause), not as a new partition.
- **Per-project tables or a per-repo dataset.** Segmentation is a `project_id` dimension threaded into existing tables, never a new table set per project — that would explode the ~25-table catalog and fight the "workspace is the partition" model.
- **A GitHub-repo-ID identity.** Git is an optional auto-bind signal only; the identity is the registry-backed project a folder is assigned to.
- **Changing the within-workspace `agent_id` read policies** (PRD-011e). They operate unchanged; Project sits beside them in the same clause.
- **A new auth/login flow.** Device-flow login, the `0600` credentials file, and org-drift healing (PRD-011b) are reused as-is.
- **Cross-project / cross-workspace recall federation** ("search across all my projects"). Isolation is the goal here; a future aggregate search is explicitly out of scope.

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-049a-…-project-identity-and-resolution`](./prd-049a-multi-project-and-context-switching-project-identity-and-resolution.md) | The `projects` registry, folder→project bindings, resolution precedence (binding > git signal > path fallback > `__unsorted__`), and **per-session** resolution from cwd replacing the machine-global `workspaceId`. | Completed |
| [`prd-049b-…-memory-isolation`](./prd-049b-multi-project-and-context-switching-memory-isolation.md) | Promote `project` → resolved `project_id`; thread it through capture (inbox-default, never dropped) and recall (narrow) so memories never cross a project boundary under concurrent sessions. | Completed |
| [`prd-049c-…-skill-isolation`](./prd-049c-multi-project-and-context-switching-skill-isolation.md) | Scope skillify output and team SKILL.md propagation per project; cross-project sharing as explicit opt-in. | Completed |
| [`prd-049d-…-org-workspace-switching`](./prd-049d-multi-project-and-context-switching-org-workspace-switching.md) | CLI: list/switch orgs & workspaces the user has privileges in; bind/inspect/use a project; all session-safe (no global race). | Completed |
| [`prd-049e-…-dashboard-scope-switcher`](./prd-049e-multi-project-and-context-switching-dashboard-scope-switcher.md) | Dashboard Org → Workspace → Project switcher in the nav shell driving codebase graph, memory graph, memories, and sync views. | Completed |

---

## Acceptance criteria (module-level)

| ID | Criterion |
|---|---|
| AC-1 | Given project A and project B open in two concurrent harness sessions under one logged-in identity, when each captures a memory, then a recall in A returns only A's and a recall in B only B's — with no manual switch between them. |
| AC-2 | Given a session in any directory, when scope is resolved, then `project_id` derives from the folder→project binding (or its fallback), not from a machine-global `workspaceId`; two sessions in different folders resolve to different projects simultaneously. |
| AC-3 | Given an identity-less folder (no binding, no git remote), when a session captures, then the row lands in the workspace's `__unsorted__` project (never dropped, never mis-attributed to a real project), and recall in that session sees only the inbox + workspace-global rows. |
| AC-4 | Given a folder with a git remote and no binding, when a session starts, then the system auto-suggests/auto-binds a real project from the remote signal rather than using the inbox. |
| AC-5 | Given a logged-in user, when they run the CLI org/workspace `list`, then output reflects `GET /organizations` and `GET /workspaces` — exactly what they have privileges in — and any `switch`/`use`/`bind` does not corrupt another concurrent session's resolved scope. |
| AC-6 | Given a skill mined or pulled while working in project A, when the user works in project B, then it is not surfaced in B unless explicitly shared cross-project. |
| AC-7 | Given the dashboard, when the user picks Org → Workspace → Project in the nav switcher, then the codebase graph, memory graph, memories, and sync pages all re-scope, and the switcher only lists scopes the user has privileges in. |
| AC-8 | Given an org switch, when it completes, then the org-bound token is re-minted (PRD-011); switching workspace or project alone performs no re-mint. |

---

## Data model changes

Additive, no breaking changes to PRD-011 tenancy:

- **New `projects` registry table** (`scope: "tenant"` — carries explicit `org_id` + `workspace_id`): `project_id`, `name`, folder-match rules (bound paths and/or normalized git-remote signals), `created_at`. This is the "list of projects you can assign folders to." A reserved `__unsorted__` project exists per workspace as the capture inbox.
- **Promote the existing `project` column → resolved `project_id`** on the agent-scoped data tables that segment by project (`memories`, `sessions`, and the skill rows). The column already exists as `TEXT NOT NULL DEFAULT ''` ([`catalog/memories.ts:65`](../../../../src/daemon/storage/catalog/memories.ts)); this fills it with the resolved registry key instead of a raw cwd path, and adds it (additive, defaulted) to the other agent-scoped tables that need project segmentation. Default `''` resolves to the workspace `__unsorted__` inbox at read time.
- **Scope clause** gains a `project_id` predicate beside the existing `agent_id`/`visibility` clause (PRD-011e) — soft segmentation, same mechanism, not a new partition.
- **Binding registry** (folder → project) backing store decided in 049a: a local `~/.deeplake/projects.json` (machine-local, like `credentials.json`) over the server-side `projects` table as source of truth. Carries no secrets.

---

## API changes

The partition boundary is unchanged. New/changed surface:

- **DeepLake enumeration consumed** (not built): `GET /me`, `GET /organizations`, `GET /workspaces`, `GET /workspaces/{id}/users`. The `GET/POST /api/v1/orgs/{org_id}/repositories` registry is a candidate backing store for project bindings (open question).
- **Daemon**: scope resolution made per-request (resolved Org/Workspace/Project travels with the request from the session cwd, not a single global field); CRUD for the `projects` registry; `list`/`switch`/`bind` control routes for the CLI and dashboard switchers.
- **CLI**: `honeycomb org list`, `honeycomb workspace list`, `honeycomb project bind|status|use|list` (exact surface in 049d), alongside the existing `org switch` / `workspace use`.

---

## Open questions

- [ ] **Binding registry backing store:** local `~/.deeplake/projects.json`, the server-side `projects` table, the DeepLake `/api/v1/orgs/{org_id}/repositories` registry, or local-cache-over-server? Affects whether a binding follows the user to another machine.
- [ ] **Concurrency contract:** scope resolution carried entirely in the request (cwd → resolve every time) vs cached per session key. Confirmed: the machine-global `credentials.json.workspaceId` degrades to a *fallback default only*, never the authoritative active scope.
- [ ] **Git-signal auto-bind:** auto-bind silently from a recognized remote, or always suggest-and-confirm on first capture in a new repo? (AC-4 allows either; lean suggest-then-remember.)
- [ ] **Worktrees & monorepos:** do git worktrees of one remote share a project (lean yes)? Does a monorepo get one project or a configurable sub-project marker (e.g. a `.deeplake/project` file)?
- [ ] **`__unsorted__` hygiene:** surface inbox size in the dashboard and offer a "re-file unsorted → project" action so the inbox does not rot.
- [ ] **Harness cwd availability:** do all six harnesses reliably pass the session cwd to the capture/recall hook? Where they don't, the fallback is the workspace inbox + a visible warning.
- [ ] **Migration:** the existing free-text `project` values (raw cwd paths) — backfill into registry projects by path match, or leave and let them resolve to inbox?

---

## Related

- [PRD-011: Tenancy and Auth](../../completed/prd-011-tenancy-and-auth/prd-011-tenancy-and-auth-index.md) — the Org/Workspace partition (outer ring) + `agent_id` clause (inner ring) Project extends.
- [Org and Workspace Model](../../../knowledge/private/multi-tenant/org-workspace-model.md) — *"the workspace is the project boundary"*; credentials & switching mechanics.
- [Scoping and Visibility](../../../knowledge/private/security/scoping-and-visibility.md) — the two rings; fail-closed posture (applied to recall here, not capture).
- [Credential Storage](../../../knowledge/private/security/credential-storage.md) — the `~/.deeplake/credentials.json` shape this stops treating as the global active scope.
- [PRD-018: Team Skill Sharing](../../completed/prd-018-team-skill-sharing/prd-018-team-skill-sharing-index.md) — skill publish/auto-pull that 049c scopes per-project.
- [PRD-041: Graph Page](../../completed/prd-041-graph-page/prd-041-graph-page-index.md) · [PRD-037: Dashboard Nav Shell](../../completed/prd-037-dashboard-nav-shell/prd-037a-dashboard-nav-shell-sidebar.md) — surfaces + switcher home for 049e.
- Existing `project` column: [`src/daemon/storage/catalog/memories.ts:65`](../../../../src/daemon/storage/catalog/memories.ts); "Repository-style" cwd keying precedent: [`src/daemon-client/assets/install.ts:486`](../../../../src/daemon-client/assets/install.ts), [`src/daemon-client/skillify/contracts.ts:43`](../../../../src/daemon-client/skillify/contracts.ts).
- DeepLake managed API (`https://api.deeplake.ai/docs/`) — `GET /organizations`, `GET /workspaces`, `/workspaces/{id}/…` data plane.

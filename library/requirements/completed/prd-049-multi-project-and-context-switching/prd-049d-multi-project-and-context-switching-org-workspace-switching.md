# PRD-049d: Org / Workspace Switching and Project Binding (CLI)

> **Parent:** [PRD-049](./prd-049-multi-project-and-context-switching-index.md)
> **Status:** Completed — shipped with PRD-049 (merged #101, 2026-06-25)
> **Priority:** P1
> **Effort:** M (3-8h)
> **Schema changes:** Additive — writes to the 049a `projects` registry + binding store.

---

## Overview

The CLI surface for managing scope across all three levels — **Org (Company) → Workspace (Team) → Project**. PRD-011 already ships `honeycomb org switch <x>` and `honeycomb workspace use <x>` plus `honeycomb status`; this sub-PRD adds the **discovery** verbs (you cannot switch to what you cannot list), the **project binding** verbs (049a's registry + folder bindings), and — critically — makes all of it **session-safe** so a switch or bind in one terminal does not silently re-scope a concurrent session in another folder.

Enumeration is backed by the real DeepLake API: `GET /organizations` ("List user's organizations") and `GET /workspaces`, with `GET /workspaces/{id}/users` for privilege detail.

## Goals

- `honeycomb org list` and `honeycomb workspace list` show exactly the orgs/workspaces the user has privileges in, from `GET /organizations` / `GET /workspaces`.
- `honeycomb project list|bind|status|use` manages the active workspace's projects and the current folder's binding in the 049a registry/store: `list` shows the workspace's projects, `bind [<project>]` assigns the current folder (creating a project if needed), `status` shows the resolved scope for the cwd, `use <project>` overrides the binding for this folder.
- Org switch re-mints the org-bound token (PRD-011 mechanic, unchanged); workspace/project changes are scope-only, no re-mint.
- **Session-safe:** changing a binding or the fallback default does not corrupt another concurrent session's cwd-resolved scope (which comes from the registry/store per 049a, not a mutated global).
- `honeycomb status` reports the *resolved* Org → Workspace → Project for the current cwd (plus agent), making "what am I writing to right now" answerable per-folder, and clearly marks an identity-less folder as the `__unsorted__` inbox.

## Non-Goals

- The dashboard switcher (049e).
- The resolution/identity engine itself (049a) — this drives it.
- Creating orgs or inviting members (owned upstream; we may surface `GET /organizations/{id}/members` read-only but do not manage membership).

## User stories

- As a developer, I run `honeycomb org list`, see ACME and my personal org, then `honeycomb org switch acme`.
- As a developer in a fresh folder, I run `honeycomb project bind` and pick (or create) the project it maps to; a git remote pre-fills the suggestion.
- As a developer, `honeycomb status` in `~/work/api` shows project `api` under Team `backend`, ACME; the same command in `~/scratch/spike` shows the `__unsorted__` inbox — without my switching anything.

## Acceptance criteria

| ID | Criterion |
|---|---|
| d-AC-1 | `honeycomb org list` equals the set from `GET /organizations`; `honeycomb workspace list` equals `GET /workspaces` for the active org. |
| d-AC-2 | `honeycomb project bind <p>` writes the current folder→project mapping to the 049a store; a subsequent capture in that folder resolves to `<p>` (049a/049b). |
| d-AC-3 | `honeycomb org switch <org>` re-mints the org-bound token; `honeycomb workspace use` / `project use` perform no token re-mint. |
| d-AC-4 | Given two terminals in two folders, when one runs a `switch`/`use`/`bind`, then the other terminal's `honeycomb status` still reports its own folder's resolved scope, unchanged. |
| d-AC-5 | `honeycomb status` reports the resolved Org, Workspace, Project (or `__unsorted__`), and agent for the current cwd, and marks an unbound folder explicitly. |
| d-AC-6 | Env overrides (`HONEYCOMB_ORG_ID`, `HONEYCOMB_WORKSPACE_ID`, `HONEYCOMB_TOKEN`) still take precedence for scripted/CI use (PRD-011 parity); a `HONEYCOMB_PROJECT_ID` override is added for the same use. |

## Implementation notes

- Enumeration: the daemon proxies `GET /organizations` / `GET /workspaces` (and `/workspaces/{id}/users`) with the logged-in token; the CLI renders. Reuse the storage transport's retry/concurrency discipline.
- The old mental model — "the active workspace is the `workspaceId` in `credentials.json`" — is replaced: `workspace use` sets the *fallback default* only; the per-folder project binding is what concurrent sessions resolve against. Make `project use` vs `workspace use` explicit in help text to avoid the lingering-global footgun.
- `honeycomb status` calls 049a `resolveScope(cwd)` so it reports reality, not the stored default.
- Mirror the existing key/CLI parsing idioms (`src/cli/keys.ts`, which already parses `--project`).

## Open questions

- [ ] Should `project bind` with no matching project offer to create one inline (writing the `projects` registry), or require pre-existing? (Lean: create inline, that is the point.)
- [ ] Keep `workspace use` at all, or replace with `project use` + an explicit `--default-workspace` flag to kill the global footgun?
- [ ] `project list` scope — active workspace only, or all workspaces in the org?

## Related

- [PRD-011b Device-Flow Auth](../../completed/prd-011-tenancy-and-auth/prd-011b-tenancy-and-auth-device-flow-auth.md) · [PRD-011a Org/Workspace](../../completed/prd-011-tenancy-and-auth/prd-011a-tenancy-and-auth-org-workspace.md)
- [`src/cli/keys.ts`](../../../../src/cli/keys.ts) — CLI parsing idiom (already has `--project`).
- [CLI Command Architecture](../../../knowledge/private/operations/cli-command-architecture.md) · [Org and Workspace Model](../../../knowledge/private/multi-tenant/org-workspace-model.md)
- DeepLake API: `GET /organizations`, `GET /workspaces`, `GET /workspaces/{id}/users`, `POST /workspaces`.

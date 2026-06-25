# PRD-049a: Project Identity, Registry, and Per-Session Resolution

> **Parent:** [PRD-049](./prd-049-multi-project-and-context-switching-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** L (1-3d)
> **Schema changes:** Additive — `projects` registry table; folder→project binding store.

---

## Overview

This is the foundation the rest of PRD-049 stands on. It answers two questions the current system answers wrong for concurrent multi-project work: **"what project is this session in?"** and **"how is that project identified across harnesses that may have no git repo?"** — and it answers them **per session, from the working directory**, replacing the single machine-global `~/.deeplake/credentials.json.workspaceId` read that every concurrent session shares today.

A **Project** is a registry-backed identity that **folders are assigned to**, not a GitHub repository ID. Git is one optional *signal* that can propose a binding; resolution is identical whether or not a repo exists. Three pieces: a `projects` **registry** (per workspace), a **folder→project binding** store, and a **resolution function** with a clear precedence that always yields a usable `project_id` (falling to the workspace `__unsorted__` inbox rather than failing).

## Goals

- A `projects` registry table (`scope: "tenant"`: `org_id` + `workspace_id` + `project_id` + `name` + match rules) — the "list of projects you can assign folders to" — with a reserved per-workspace `__unsorted__` inbox project.
- A folder→project binding store (local `~/.deeplake/projects.json`, mirroring the `credentials.json` pattern) read on every capture/recall.
- A pure, deterministic `resolveScope({ cwd })` returning `{ org, workspace, project_id, bound }` with this **precedence**:
  1. explicit folder→project binding (longest-prefix match on the cwd);
  2. git-remote signal — normalized remote (`git@`/`https`/`.git` canonicalized) matched to a registry project, auto-suggested/auto-bound (AC-4);
  3. path fallback — a stable key from the worktree/cwd path, offered as a new project to bind;
  4. otherwise the workspace `__unsorted__` inbox (capture never dropped).
- `credentials.json.workspaceId` demoted from "the active workspace" to the **fallback default** used only when no binding resolves a workspace, and never as the project authority.
- Resolution is concurrency-safe: two sessions in two folders resolving simultaneously each get their own correct `project_id`, with no shared mutable singleton.

## Non-Goals

- The CLI verbs to *create*/*change* bindings (049d) — this owns the registry shape, the binding store, and the resolve path.
- Threading the resolved `project_id` into memory or skill queries (049b/049c consume it).
- Org/Workspace partition isolation (PRD-011), unchanged.

## User stories

- As a developer with `~/work/api` and `~/work/web` open, each session knows its project so memory lands right with no action from me.
- As an OpenClaw user in `~/scratch/spike` with no git repo, my captures still land somewhere sane (the inbox) and never leak into a real project.
- As a developer cloning a known repo on a new machine, the git remote auto-suggests the existing project so I don't re-create it.

## Acceptance criteria

| ID | Criterion |
|---|---|
| a-AC-1 | `resolveScope({cwd})` is pure/deterministic and returns the same `project_id` for the same bound folder across runs and across remote-URL forms (`git@github.com:org/x.git` ≡ `https://github.com/org/x`). |
| a-AC-2 | Given two cwds bound to two projects, resolution returns two different `project_id` simultaneously with no shared mutable global; a third session switching scope does not perturb either. |
| a-AC-3 | Given an identity-less folder (no binding, no remote), resolution returns the workspace `__unsorted__` inbox `project_id` and `bound: false` — never a throw, never another project's id. |
| a-AC-4 | Given a folder with a git remote matching a registry project, resolution binds/suggests that project rather than the inbox. |
| a-AC-5 | `credentials.json.workspaceId` is consulted only as a fallback default; a structural test asserts no capture/recall path treats it as the authoritative active scope when a binding resolves one. |
| a-AC-6 | The `projects` registry enforces a reserved `__unsorted__` per workspace and rejects a user-created project colliding with it. |

## Implementation notes

- **Identity/resolution** belongs in a small pure module, thin-client safe — `src/hooks` cannot import `daemon/storage` (the discipline in [`credential-reader.ts`](../../../../src/hooks/shared/credential-reader.ts)). Git remote via `git config --get remote.origin.url` at the worktree root (`git rev-parse --show-toplevel`); normalize host/owner/repo; this is only a *signal*, hashed into a candidate key, not the identity.
- **Binding store** mirrors the credentials pattern: `~/.deeplake/projects.json` read fail-soft (missing/malformed → unbound → inbox, never throw). The `projects` registry table is the server-side source of truth; the local file is a cache/override (final split is the index open question).
- **Resolution seam:** today `createCredentialReader().read()` returns one `workspace`. Add `resolveScope({cwd})` combining the credential (identity/org/token + fallback workspace) with the binding store + registry. Capture/recall call it with the session cwd; they never read `workspaceId` directly.
- **`__unsorted__` is the write-side default by design** — it mirrors `agent_id`'s `DEFAULT 'default'` ([`CONVENTIONS.md §3`](../../../../src/daemon/storage/catalog/CONVENTIONS.md)): the inner ring defaults on unknown rather than dropping the write. Recall narrowing (inbox + global only) is 049b's job.
- **Concurrency:** because resolution is a pure function of `(cwd, binding snapshot, credential)` it is inherently per-call. The failure mode to kill is any in-memory `currentProject`/`currentWorkspace` singleton — assert against it.

## Open questions

- [ ] Backing store: local `projects.json` vs server `projects` table vs DeepLake `/api/v1/orgs/{org_id}/repositories` (index open question).
- [ ] Git auto-bind: silent on recognized remote, or suggest-then-remember? (lean suggest-then-remember.)
- [ ] Worktrees: share one project across worktrees of a remote (lean yes); monorepo sub-project marker (`.deeplake/project`)?
- [ ] Longest-prefix folder match — how to handle nested bound folders (child binding wins)?

## Related

- [`src/hooks/shared/credential-reader.ts`](../../../../src/hooks/shared/credential-reader.ts) — the credentials read path this extends with cwd-aware resolution.
- [`src/daemon/storage/catalog/memories.ts`](../../../../src/daemon/storage/catalog/memories.ts) — the existing `project` column promoted in 049b. · [`catalog/CONVENTIONS.md`](../../../../src/daemon/storage/catalog/CONVENTIONS.md) — scope + default discipline.
- "Repository-style" cwd keying precedent: [`src/daemon-client/assets/install.ts`](../../../../src/daemon-client/assets/install.ts), [`src/commands/asset.ts`](../../../../src/commands/asset.ts).
- [Credential Storage](../../../knowledge/private/security/credential-storage.md) · [Org and Workspace Model](../../../knowledge/private/multi-tenant/org-workspace-model.md)

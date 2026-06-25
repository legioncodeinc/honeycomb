# PRD-049b: Per-Project Memory Isolation

> **Parent:** [PRD-049](./prd-049-multi-project-and-context-switching-index.md)
> **Status:** Completed — shipped with PRD-049 (merged #101, 2026-06-25)
> **Priority:** P1
> **Effort:** L (1-3d)
> **Schema changes:** Additive — promote `project` → resolved `project_id`; add it to the scope clause.

---

## Overview

With per-session scope resolution in place (049a), this sub-PRD threads the resolved `project_id` through the two paths that touch user memory — **capture** (writing) and **recall** (reading) — so a memory created while working in project A is never written into, nor recalled into, project B. It closes the concrete dogfood failure: today a capture hook reads the single `credentials.json.workspaceId`, so concurrent sessions in different folders all write to whichever workspace was last selected, and the existing `project` column ([`memories.ts:65`](../../../../src/daemon/storage/catalog/memories.ts)) holds only a raw cwd path used for display.

The capture/recall split is deliberate and **asymmetric**: capture must **never drop** a memory (a lost memory is unrecoverable), so an unresolved project defaults to the workspace `__unsorted__` inbox; recall must stay **narrow** (a leak surfaces the wrong project), so an unbound session sees only its inbox + workspace-global rows.

## Goals

- Promote `project` from free-text cwd path to the resolved `project_id` (049a) at capture time; add `project_id` to the agent-scoped tables that segment by project and to the scope clause beside `agent_id`/`visibility` (PRD-011e).
- Every capture resolves from the session cwd and writes its `project_id` — defaulting to `__unsorted__`, never dropped, never mis-attributed to a real project.
- Every recall resolves the same way and filters to the session's `project_id`, so candidate channels (FTS, vector, graph traversal) cannot surface another project's rows; an unbound session sees inbox + workspace-global only.
- The existing `agent_id` read policy continues to apply unchanged *within* the resolved project — project is the new middle segment, agent the innermost.

## Non-Goals

- Cross-project recall / "search all my projects" (module non-goal).
- Changing extraction, ranking, or the recall pipeline shape (PRD-007 / PRD-047) — only the scope it runs within.
- The `projects` registry / resolution engine (049a).

## User stories

- As a developer, a decision captured in `api` never surfaces while I work in `web`.
- As a team, our shared workspace brain still works *within* a project — teammates on that project's workspace see its shared memories — bounded to the project.
- As an OpenClaw user in a scratch dir, my captures land in the inbox and I can re-file them later, but they never pollute a real project's recall.

## Acceptance criteria

| ID | Criterion |
|---|---|
| b-AC-1 | Given concurrent capture in project A and project B, when each writes, then rows carry A's and B's resolved `project_id` respectively (verified by per-project read-back), with no manual switch. |
| b-AC-2 | Given a recall in project A, when candidates are gathered, then no row whose `project_id` is B's is returned, even on a strong vector or high-degree-entity hit. |
| b-AC-3 | Given an identity-less session, when it captures, then the row's `project_id` is the workspace `__unsorted__` inbox (never dropped); when it recalls, it sees only inbox + workspace-global rows. |
| b-AC-4 | Given a resolved project, when recall runs, then the PRD-011e `agent_id` clause still applies within it (isolated/shared/group unchanged). |
| b-AC-5 | A structural/integration test proves no capture or recall code path reads `workspaceId` directly instead of `resolveScope(cwd)`, and that the `project_id` predicate is present on every memory query. |

## Implementation notes

- Capture path: [`src/hooks/shared/capture.ts`](../../../../src/hooks/shared/capture.ts) + [`daemon-client.ts`](../../../../src/hooks/shared/daemon-client.ts) — pass the session cwd into the request and resolve `project_id` via 049a, replacing the direct workspace read and the raw-path `project` write.
- Recall path: the `project_id` predicate joins the scope clause built per [Scoping and Visibility](../../../knowledge/private/security/scoping-and-visibility.md). Ordering preserved: channels → IDs → org/workspace partition (outer) → `project_id` + `agent_id` clause (inner) → content. A strong hit can surface an ID but cannot leak content past the project filter.
- Promotion is additive: `project` already exists on `memories`/`sessions`; add `project_id` (or repurpose `project`) on the other agent-scoped tables that need it, defaulted, healed via the additive `ALTER TABLE ADD COLUMN … DEFAULT` path.
- **Dogfood is mandatory** before done — per project memory, isolated unit mounts structurally miss exactly this cross-scope class. Run two real concurrent sessions in two projects, verify no bleed, polling read-backs to convergence (DeepLake eventual consistency).

## Open questions

- [ ] Migration of existing free-text `project` (raw paths): backfill to registry projects by path match, or leave to resolve to inbox on read?
- [ ] When cwd is unavailable from a harness, does recall fall back to inbox + global (with a visible warning) — confirm this is acceptable vs returning nothing?

## Related

- [`src/hooks/shared/capture.ts`](../../../../src/hooks/shared/capture.ts) · [`src/hooks/shared/daemon-client.ts`](../../../../src/hooks/shared/daemon-client.ts) · [`src/daemon/storage/catalog/memories.ts`](../../../../src/daemon/storage/catalog/memories.ts)
- [Scoping and Visibility](../../../knowledge/private/security/scoping-and-visibility.md) · [PRD-007 Retrieval](../../completed/prd-007-retrieval/prd-007-retrieval-index.md) · [PRD-011e Agent Scoping](../../completed/prd-011-tenancy-and-auth/prd-011e-tenancy-and-auth-agent-scoping.md)
- Project memory: *Dogfood surfaces integration bugs*; *DeepLake eventual-consistency poll reads*.

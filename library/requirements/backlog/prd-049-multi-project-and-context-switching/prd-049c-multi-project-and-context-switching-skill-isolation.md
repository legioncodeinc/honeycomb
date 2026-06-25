# PRD-049c: Per-Project Skill Isolation and Propagation

> **Parent:** [PRD-049](./prd-049-multi-project-and-context-switching-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M (3-8h)
> **Schema changes:** Additive — skill rows carry the resolved `project_id`; cross-project share flag.

---

## Overview

Skills are mined from sessions (skillify, PRD-016) and shared across a team via publish/auto-pull (PRD-018). Both inherit the same global-workspace assumption as memory, and skillify already carries a path-derived `projectKey` ([`skillify/contracts.ts`](../../../../src/daemon-client/skillify/contracts.ts)) plus a `project`/`global` install axis — so a skill mined in project A can propagate into a project B session. This sub-PRD scopes skills to the **resolved `project_id`** (049a) by default, aligning the existing `projectKey` with the managed registry identity, and makes cross-project sharing an explicit, auditable opt-in.

## Goals

- A skill mined by skillify is tagged with the resolved `project_id` (049a) at write time, superseding the loose path-derived `projectKey`.
- Skill recall / surfacing in a session offers only skills scoped to that session's `project_id`, plus any explicitly marked cross-project.
- Team propagation (PRD-018 publish / auto-pull) respects the project boundary: auto-pull lands a shared skill into the matching project's scope, not globally.
- Promoting a skill to cross-project (or workspace-wide) is an explicit action with recorded provenance, never an implicit default — mirroring how memory `visibility` widens from own → global.

## Non-Goals

- Changing the skillify mining gate (KEEP/MERGE/SKIP) or SKILL.md format (PRD-016) — only the scope tag on the result.
- A new sharing transport — PRD-018's publish/pull is reused, scoped.
- The `project`/`global` *install location* axis (where the SKILL.md file lands on disk) — that is orthogonal to *which project's memory scope* surfaces the skill; this PRD governs the latter.

## User stories

- As a developer, skills mined while working on `web` do not clutter or mislead my `api` sessions.
- As a developer with a genuinely general skill (a house TypeScript convention), I promote it once and it is available across my projects.
- As a team lead, when I publish a project's skill, teammates working in that project auto-pull it — and teammates in other projects do not.

## Acceptance criteria

| ID | Criterion |
|---|---|
| c-AC-1 | Given a skill mined in project A, when a session runs in project B, then that skill is not surfaced in B. |
| c-AC-2 | Given a skill explicitly promoted to cross-project, when a session runs in any of the user's projects, then it is surfaced, with its cross-project provenance visible. |
| c-AC-3 | Given a published skill for project A, when a teammate auto-pulls, then it lands in A's scope and is surfaced only in A. |
| c-AC-4 | Promotion to cross-project is an explicit operation recorded with provenance; no mining or pull path sets it implicitly. |
| c-AC-5 | A skill mined in an identity-less session is tagged to the workspace `__unsorted__` project, consistent with memory capture (049b). |

## Implementation notes

- Skillify write (`skill-writer.ts` in the retrieval/codify subsystem) stamps the resolved `project_id` from 049a alongside existing provenance, replacing/superseding the path-derived `projectKey` as the scope authority.
- Auto-pull (PRD-018b) resolves the target project scope the same way before landing a pulled skill.
- Reuse the memory `visibility` model rather than a parallel one — a cross-project skill is a higher-visibility row, mirroring `shared`/`global` in PRD-011e.

## Open questions

- [ ] Promotion granularity: cross-project for *this user* only, or workspace-wide (all teammates)? Likely both, with distinct flags.
- [ ] Reconcile the existing `projectKey` field — migrate to `project_id`, or keep as a legacy alias resolving through the registry?
- [ ] Pre-existing mined skills with no `project_id`: backfill from `projectKey` path match, or default to inbox?

## Related

- [PRD-016 Skillify](../../completed/prd-016-skillify/prd-016-skillify-index.md) · [PRD-018 Team Skill Sharing](../../completed/prd-018-team-skill-sharing/prd-018-team-skill-sharing-index.md)
- [`src/daemon-client/skillify/contracts.ts`](../../../../src/daemon-client/skillify/contracts.ts) — existing `projectKey` + `project`/`global` axis.
- [Team Skills Sharing](../../../knowledge/private/collaboration/team-skills-sharing.md) · [Skillify Pipeline](../../../knowledge/private/ai/skillify-pipeline.md)

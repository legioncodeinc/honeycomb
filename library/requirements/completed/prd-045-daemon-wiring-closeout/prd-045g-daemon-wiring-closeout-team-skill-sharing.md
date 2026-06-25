# PRD-045g: Wire Team Skill Sharing (closes PRD-018)

> **Status:** Completed
> **Parent:** [PRD-045](./prd-045-daemon-wiring-closeout-index.md)
> **Closes gap in:** PRD-018 Team Skill Sharing
> **Priority:** P2
> **Effort:** M
> **Depends on:** [PRD-045f](./prd-045f-daemon-wiring-closeout-skillify-mining.md) (needs mined skills to propagate)

## Overview

PRD-018 shipped three things — publish mined skills as versioned `skills` rows, idempotent auto-pull on
SessionStart, and cross-harness symlink fan-out — but **all three are dead-coded at runtime**: the publish endpoint
is never mounted, the auto-pull seam resolves to a no-op, and fan-out is reachable only via an unregistered CLI.
With 045f producing mined skills, this sub-PRD makes propagation actually work.

## Evidence of the gap

- Publish: `createSkillPublishEndpoint` (`skillify/publish-endpoint.ts:71`) is **never mounted** — `/api/skills` is
  GET-only read (`product/api.ts:180`); no `POST /api/skills/*` exists.
- Auto-pull: `src/hooks/runtime.ts:198` builds `SessionStartDeps` with **no `seams`**, so `session-start.ts:72`'s
  `seams.autoPullSkills()` resolves to the no-op default (`contracts.ts:458`); the real `autoPull`
  (`daemon-client/skillify/install.ts:250`) is never invoked.
- Fan-out: `fanOutSymlinks` (`install.ts:508`) runs only inside `pull`, reachable only via `src/cli/skillify.ts:79`,
  which is **not in `VERB_TABLE`**.
- Two disconnected skill CLI impls exist (`src/cli/skill.ts` has zero non-test callers).

## Goals

- Mount the **skill publish endpoint** (`POST /api/skills/*`) in the composition root.
- Pass the **real `autoPull` seam** into `SessionStartDeps` at `src/hooks/runtime.ts:198` so session-start auto-pull
  actually runs (idempotent, fail-soft, time-budgeted like the spec).
- Register the skill CLI verbs (publish / pull) and **reconcile the two CLI impls** into one.
- Make the cross-harness symlink fan-out reachable on pull.

## Non-Goals

- The mining half (045f).
- New schema — the `skills` table + version-bump writes exist.

## User stories

- As a team member, when I start a session, I want my teammates' published skills auto-pulled (idempotently, never
  blocking session start).
- As a developer, I want `honeycomb skill publish` / `pull` registered and pointing at real daemon routes.

## Acceptance criteria

| ID | Criterion |
|---|---|
| g-AC-1 | The publish endpoint is mounted (cite the `assemble.ts`/server seam); `POST /api/skills/*` accepts a versioned publish (no 501). |
| g-AC-2 | `SessionStartDeps` is built WITH the real `autoPull` seam (cite `runtime.ts:198` fix); session-start auto-pull runs idempotently and fail-soft. |
| g-AC-3 | A live itest proves end-to-end: workspace A mines+publishes a skill (045f) → workspace/harness B auto-pulls it on session start. |
| g-AC-4 | Skill CLI verbs registered in `VERB_TABLE`; the duplicate `src/cli/skill.ts` impl is removed or merged. |
| g-AC-5 | Cross-harness symlink fan-out runs on pull and is idempotent. |

## Implementation notes

- The auto-pull fix is the same `SessionStartDeps`-missing-`seams` defect flagged in 045f's open question — fix once,
  cover both skills and (coordinate with PRD-033) assets if the seam is shared.
- Publish endpoint mounts onto the protected `/api/skills` group; fail-soft try/catch like the other data mounts.

## Open questions

- [ ] Reconcile the two skill CLI impls — keep the dispatcher's `buildSkillRequest` path (and point it at the newly
      mounted routes) or the standalone `src/cli/skillify.ts`?
- [ ] Is auto-pull skills-only, or should the same seam fix also wire PRD-033's asset auto-pull (shared session-start
      seam)? Coordinate with the reopened PRD-033.

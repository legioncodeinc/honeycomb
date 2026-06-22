# PRD-018: Team Skill Sharing

> **Status:** Completed
> **Priority:** P2
> **Effort:** M
> **Schema changes:** Additive

---

## Overview

Honeycomb mines reusable skills from agent sessions, publishes them to the org's shared `skills` DeepLake table as versioned rows, and distributes them to every teammate's agents on the next session start. Every storage touch goes through the daemon on port 3850; hooks and the CLI never open DeepLake. Publish appends a new version (`v=N+1`) carrying a `me`/`team` scope, auto-pull runs idempotently on every `SessionStart` within a 5-second budget skipping any skill at-or-newer than local, and a fan-out step symlinks every non-Claude agent skills root at the canonical `~/.claude/skills/<name>--<author>/` directory with a backfill pass for agents installed after the fact. The result is teammate-mined skills visible across the fleet within seconds of publication.

## Goals

- Publish mined skills as versioned rows in the shared `skills` table with explicit `me`/`team` scope and provenance.
- Idempotent auto-pull on every `SessionStart`, bounded by a 5-second timeout and a fail-soft early exit when the table is absent.
- Cross-harness symlink fan-out to detected agent roots, with a backfill pass so newly installed agents inherit prior pulls.
- Coexistence of locally-mined and pulled skills via the `<name>--<author>` directory convention.

## Non-Goals

- The skillify mining gate model and `SKILL.md` authoring (covered by the skillify pipeline).
- The retrieval ranking that decides when a skill is surfaced.
- Org and workspace tenancy administration (covered by the surfaces and tenancy modules).

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-018a-team-skill-sharing-publish-version`](./prd-018a-team-skill-sharing-publish-version.md) | Publish skills with version and `me`/`team` scope. | Draft |
| [`prd-018b-team-skill-sharing-auto-pull`](./prd-018b-team-skill-sharing-auto-pull.md) | Idempotent auto-pull on session start. | Draft |
| [`prd-018c-team-skill-sharing-symlink-fanout`](./prd-018c-team-skill-sharing-symlink-fanout.md) | Cross-harness symlink fan-out plus backfill. | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a mined skill, when it is published, then a new version row (`v=N+1`) is inserted into the shared `skills` table with the configured `me`/`team` scope, and readers take `ORDER BY version DESC`. |
| AC-2 | Given a teammate publishes a newer skill, when the current user starts a session, then auto-pull writes the newer skill within seconds, and re-running the pull with no changes touches no files. |
| AC-3 | Given a global install pull, when fan-out runs, then a symlink exists in every detected non-Claude agent root pointing at the canonical `~/.claude/skills/<name>--<author>/` directory. |

## Data model changes

Additive: the shared `skills` table holds versioned rows with `name`, `author`, `version`, `scope`, `contributors`, and content columns. Local state files (`skillify/config.json`, pull manifest) live on disk, not in DeepLake. No breaking changes.

## API changes

Additive daemon endpoints for publishing a skill version and selecting newer skills for a set of org users. No breaking changes.

## Open questions

- [ ] Should the removed `org` scope stay coerced to `team` indefinitely, or migrate config files on read?
- [ ] How should cross-author merges record lineage beyond the `skillopt` contributor marker?
- [ ] Do project-local pulls ever warrant fan-out, or is global-only the permanent rule?

## Related

- [Team Skills Sharing](../../../knowledge/private/collaboration/team-skills-sharing.md)
- [Skillify Pipeline](../../../knowledge/private/ai/skillify-pipeline.md)
- [Org and Workspace Model](../../../knowledge/private/multi-tenant/org-workspace-model.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)

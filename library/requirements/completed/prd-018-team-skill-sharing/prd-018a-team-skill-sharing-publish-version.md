# PRD-018a: Publish with Version and Scope

> **Parent:** [PRD-018](./prd-018-team-skill-sharing-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** S

## Scope

Publish mined skills into the shared `skills` DeepLake table as append-only versioned rows carrying a `me`/`team` scope, through the daemon. Readers always take the highest version.

## Goals

- Insert each mined or merged skill as a versioned row in the shared `skills` table so teammates can discover it.
- Carry an explicit `me`/`team` scope and a contributor list so authors control sharing.
- Keep every prior version intact via append-only writes, with readers taking the highest version.
- Persist scope and install configuration locally and coerce the removed `org` scope to `team` on read.

## Non-Goals

- Auto-pull on session start (PRD-018b).
- Symlink fan-out and backfill (PRD-018c).
- The mining gate model and `SKILL.md` authoring (covered by the skillify pipeline, PRD-016).

## User stories

- As a developer, I want my mined skills published with a scope so that I control whether a skill stays private to me or is shared with my team.
- As a team lead, I want every publish to be a new version so that prior versions are never silently overwritten.
- As an operator, I want the legacy `org` scope handled gracefully so that old config files keep working.

## Functional requirements

- **FR-1 Append-only versioned publish.** Publishing a skill inserts a new row at version `N+1` into the shared `skills` table; the prior row at version N is preserved. Readers always take `ORDER BY version DESC`.
- **FR-2 Daemon-only inserts.** All inserts go through the honeycomb daemon (port 3850); the CLI and worker never open DeepLake directly.
- **FR-3 Lazy table creation.** The `skills` table is created lazily on the first `INSERT`, so a fresh workspace does not require an upfront migration.
- **FR-4 Scope on the row.** Each published row carries a `scope` of `me` or `team`. Scope persists in `~/.honeycomb/state/skillify/config.json` as `{ scope, team, install }`; the default is `me` with `install = project`.
- **FR-5 Team scope and contributors.** `honeycomb skill scope team --users alice,bob` sets scope `team` and the team list; publishes then carry `team` scope and the configured contributor list.
- **FR-6 Legacy coercion.** The removed legacy `org` scope value is silently coerced to `team` on read for backward compatibility with existing config files.
- **FR-7 Row column set.** A published row carries `name`, `author`, `version`, `scope`, `contributors`, and content columns, scoped by `org` and `workspace` for tenancy.
- **FR-8 Cross-author merge marker.** Cross-author merges stamp the `skillopt` contributor marker (`SKILLOPT_CONTRIBUTOR = "skillopt"`) and append the original author so lineage is recorded, distinct from a human contributor.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given an existing skill at version N, when it is republished, then a new row at version N+1 is inserted and the prior row is preserved. |
| AC-2 | Given `honeycomb skill scope team --users alice,bob`, when the worker mines, then publishes carry `team` scope and the configured contributor list. |
| AC-3 | Given a config file with the legacy `org` scope, when it is read, then the value is coerced to `team`. |
| AC-4 | Given a cross-author merge, when it is published, then the row records the `skillopt` contributor marker and the original author. |
| AC-5 | Given a reader queries a skill name with multiple versions, when it resolves, then it takes the highest version via `ORDER BY version DESC`. |
| AC-6 | Given any publish, when it inserts, then it goes through the daemon, not a direct DeepLake connection. |

## Implementation notes

- Scope persists in `~/.honeycomb/state/skillify/config.json` (`scope`, `team`, `install`); default is `me`/`project`. The legacy `org` value is coerced to `team` on read.
- All inserts go through the daemon; the CLI and worker never open DeepLake. The published row column set is `name`, `author`, `version`, `scope`, `contributors`, content.
- Append-only, version-bumped writes work around DeepLake coalescing UPDATEs against freshly written rows.

## Dependencies

- The honeycomb daemon (port 3850) as the only DeepLake client.
- The shared `skills` table (created lazily).
- PRD-016 for the mined `SKILL.md` content being published.

## Open questions

- [ ] Should the removed `org` scope stay coerced to `team` indefinitely, or migrate config files on read?

## Related

- [parent index](./prd-018-team-skill-sharing-index.md)
- [Team Skills Sharing](../../../knowledge/private/collaboration/team-skills-sharing.md)

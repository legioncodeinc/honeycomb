# PRD-016b: Skills Writes and Watermarks

> **Parent:** [PRD-016](./prd-016-skillify-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Scope

Writing the result of a gate verdict: `writeNewSkill` on KEEP, `mergeSkill` on MERGE (with a write-new fallback when the target is missing locally), the append-only versioned row in the DeepLake `skills` table, and the oldest-session watermark advance.

## Goals

- Turn a gate verdict into a durable `SKILL.md` with provenance frontmatter.
- Record every mined skill as an append-only, version-bumped row in the shared `skills` table so teammates can discover it.
- Handle MERGE robustly, including the case where the gate names a skill that does not exist locally.
- Advance the watermark to the oldest mined session so older missed sessions are re-seen on the next run.

## Non-Goals

- Fetching sessions, extracting pairs, and running the gate (PRD-016a).
- Pull, auto-pull, and symlink fan-out (PRD-016c).
- The `skills` table schema administration (consumed here; owned by the data module).

## User stories

- As a teammate, I want mined skills recorded with provenance so that I can discover and pull skills others mined.
- As a developer, I want a MERGE to update and version an existing skill so that improvements accrue rather than fork.
- As an operator, I want the watermark to err toward re-seeing sessions so that no older session is permanently skipped.

## Functional requirements

- **FR-1 KEEP writes a new skill.** On a `KEEP` verdict, `writeNewSkill()` creates a new `SKILL.md` under the configured skills root: `install=project` writes `<cwd>/.claude/skills/<name>/SKILL.md`; `install=global` writes `~/.claude/skills/<name>/SKILL.md`.
- **FR-2 Provenance frontmatter.** The `SKILL.md` carries YAML frontmatter with provenance: `source_sessions`, `version`, `created_by_agent`, and creation/update timestamps.
- **FR-3 MERGE updates and bumps.** On a `MERGE` verdict, `mergeSkill()` opens the existing file, updates the body, and bumps the version in the frontmatter.
- **FR-4 MERGE fallback.** If the MERGE target does not exist locally (the gate hallucinated a name from the user's global skills), the worker falls back to `writeNewSkill()` so the body is not lost.
- **FR-5 Append-only DeepLake row.** After a successful local write, the daemon inserts a row into the `skills` table for org-wide provenance. Because DeepLake coalesces UPDATEs against freshly written rows, the daemon never UPDATEs in place: it inserts a new version row (`v=N+1`) rather than mutating the prior one.
- **FR-6 Daemon-only writes.** All `skills` reads and writes go through the honeycomb daemon (port 3850); the worker never opens DeepLake directly.
- **FR-7 Cross-author scope promotion.** A cross-author merge auto-promotes the recorded row's scope from `me` to `team` so future `pull` commands know the skill is co-owned.
- **FR-8 Watermark to oldest.** When the run finishes, the watermark advances to the date of the oldest mined session (not the newest), so the next run re-sees the same batch (harmless SKIPs when nothing changed) and also picks up any older sessions it missed.
- **FR-9 SKIP advances safely.** A `SKIP` verdict still advances the watermark per FR-8 without writing a file or a row.
- **FR-10 Logging.** Each run logs the session pool mined, the gate verdict, and whether a file was written to `~/.claude/hooks/skillify.log`.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a KEEP verdict, when the worker writes, then a `SKILL.md` is created with provenance frontmatter and an append-only version row is inserted into the `skills` table (never an in-place UPDATE). |
| AC-2 | Given any verdict, when the run finishes, then the watermark advances to the date of the oldest mined session so older missed sessions are re-seen. |
| AC-3 | Given a MERGE verdict whose target is absent locally, when the worker writes, then it falls back to `writeNewSkill` and the body is preserved. |
| AC-4 | Given a cross-author merge, when the row is recorded, then its scope is promoted from `me` to `team`. |
| AC-5 | Given `install=project` versus `install=global`, when KEEP writes, then the `SKILL.md` lands under `<cwd>/.claude/skills/` or `~/.claude/skills/` respectively. |
| AC-6 | Given any successful write, when the row is inserted, then it goes through the daemon, not a direct DeepLake connection. |

## Implementation notes

- MERGE bumps the version in frontmatter; the write-new fallback covers a hallucinated name. Cross-author merges auto-promote scope `me` -> `team`.
- Append-only, version-bumped writes work around DeepLake UPDATE coalescing. Provenance fields are `source_sessions`, `version`, `created_by_agent`, and timestamps.
- The watermark is deliberately set to the oldest, not the newest, mined session.

## Dependencies

- PRD-016a for the gate verdict.
- The honeycomb daemon (port 3850) and the `skills` table.
- The scope/install config (`~/.honeycomb/state/skillify/config.json`).

## Open questions

- [ ] How should cross-author MERGE conflicts be resolved when two teammates merge the same skill name concurrently?

## Related

- [parent index](./prd-016-skillify-index.md)
- [Skillify Pipeline](../../../knowledge/private/ai/skillify-pipeline.md)
- [Schema](../../../knowledge/private/data/schema.md)

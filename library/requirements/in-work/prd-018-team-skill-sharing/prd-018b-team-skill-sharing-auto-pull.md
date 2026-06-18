# PRD-018b: Idempotent Auto-Pull

> **Parent:** [PRD-018](./prd-018-team-skill-sharing-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** S

## Scope

The auto-pull that runs on every `SessionStart` for every supported agent, querying the `skills` table through the daemon and writing only skills newer than the local copy, bounded by a 5-second timeout and fail-soft on every error.

## Goals

- Make teammate-published skills visible within seconds of publication, with no manual install step.
- Keep the pull idempotent so it can run on every `SessionStart` unthrottled.
- Never block session start: bound the pull by a short timeout and swallow all errors.
- Protect the local-mined skill slot and record every write so pulls are reversible.

## Non-Goals

- Publishing skill versions (PRD-018a).
- Symlink fan-out and backfill (PRD-018c).
- The mining gate model (PRD-016).

## User stories

- As a teammate, I want newer shared skills to appear automatically on my next session so that I never run a manual install step.
- As an operator, I want a slow or down store to never block my session from starting so that recall is best-effort.
- As a developer, I do not want a pulled skill to clobber my own locally-mined skill so that the two coexist.

## Functional requirements

- **FR-1 Runs at every SessionStart.** Auto-pull runs on every `SessionStart` hook for every supported agent, served by the daemon, querying the `skills` table for all users in the org and writing any newer remote skills to the local install root.
- **FR-2 Unthrottled but idempotent.** The pull is intentionally not throttled; because it skips any skill at-or-newer than the local version, the only per-call cost is one daemon round-trip plus `existsSync` syscalls, making teammate skills visible within seconds rather than within a polling window.
- **FR-3 `decideAction` policy.** `decideAction` resolves conflicts: local file absent -> write; remote version > local -> back up existing to `SKILL.md.bak`, then write; remote version <= local without `--force` -> skip; `--force` -> back up, then write regardless. Dry-run (`--dry-run`) reports without touching the filesystem.
- **FR-4 Bounded timeout.** The auto-pull is bounded by a 5-second timeout; a slow or unreachable daemon never blocks `SessionStart` past that limit. All errors are swallowed and the result is informational only.
- **FR-5 Early exit when table absent.** On a fresh workspace the `skills` table may not exist yet. Auto-pull asks the daemon for the trusted table list and, if `skills` is absent, skips the SELECT entirely so no relation-does-not-exist error appears in the logs.
- **FR-6 Opt-out and unauthenticated.** Hard opt-out via `HONEYCOMB_AUTOPULL_DISABLED=1`. Unauthenticated sessions skip the pull silently without logging a warning.
- **FR-7 Protect local-mined slot.** Skills with an empty `author` field are skipped during pull, because writing them to `<root>/<name>/` would clobber the user's locally-mined slot and break coexistence.
- **FR-8 Manifest tracking.** Every pull writes a record to the local pull manifest (`dirName`, `name`, `author`, `projectKey`, `remoteVersion`, `install`, `installRoot`, `pulledAt`, symlinks) so `honeycomb skill unpull` can reverse pull-managed entries; a `recordPull` failure surfaces via `manifestError`.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a remote skill at-or-older than the local version, when auto-pull runs, then it is skipped and no file is written. |
| AC-2 | Given the `skills` table does not yet exist, when auto-pull runs, then it detects absence via the trusted table list and skips the SELECT without logging an error. |
| AC-3 | Given a remote skill newer than the local copy, when auto-pull runs, then the existing file is backed up to `SKILL.md.bak` and the newer skill is written. |
| AC-4 | Given `HONEYCOMB_AUTOPULL_DISABLED=1` or an unauthenticated session, when a session starts, then auto-pull does not run and logs no warning. |
| AC-5 | Given a remote skill with an empty `author`, when auto-pull runs, then it is skipped to protect the local-mined slot. |
| AC-6 | Given the daemon is unreachable, when auto-pull runs, then it times out at 5 seconds, swallows the error, and the session still starts. |

## Implementation notes

- Not throttled: the pull is idempotent so the only per-call cost is one daemon round-trip plus `existsSync` syscalls. Hard opt-out via `HONEYCOMB_AUTOPULL_DISABLED=1`; unauthenticated sessions skip silently.
- The `decideAction` table: write / backup-then-write / skip / force. Dry-run reports without writing.
- Skills with an empty `author` are skipped to protect the local-mined slot. Every write is recorded in the pull manifest for `unpull`.

## Dependencies

- The honeycomb daemon (port 3850) and the trusted table list.
- The shared `skills` table (PRD-018a).
- The local pull manifest and PRD-018c for fan-out on global-install writes.

## Open questions

- [ ] Should auto-pull's 5-second timeout be configurable for slow networks, or always fail-open?

## Related

- [parent index](./prd-018-team-skill-sharing-index.md)
- [Team Skills Sharing](../../../knowledge/private/collaboration/team-skills-sharing.md)

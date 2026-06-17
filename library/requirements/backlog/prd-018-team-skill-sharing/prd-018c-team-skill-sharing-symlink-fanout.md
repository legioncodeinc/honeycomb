# PRD-018c: Symlink Fan-Out and Backfill

> **Parent:** [PRD-018](./prd-018-team-skill-sharing-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** S

## Scope

Fan out symlinks from every detected non-Claude agent skills root to the canonical `~/.claude/skills/<name>--<author>/` directory on global-install pulls, plus a backfill pass so agents installed after a prior pull inherit existing skills.

## Goals

- Make a pulled skill immediately visible to every detected agent without a per-harness install command.
- Keep fan-out idempotent and self-healing so re-running is a no-op and stale links are repaired.
- Restrict fan-out to global installs, never project-local pulls.
- Backfill links for agents installed after a prior pull so they inherit existing skills.

## Non-Goals

- Publishing skill versions (PRD-018a).
- The auto-pull conflict policy and manifest tracking (PRD-018b).
- The mining gate model (PRD-016).

## User stories

- As a multi-harness user, I want a pulled skill to appear in all my agents at once so that I do not re-install per harness.
- As a developer who later installs a new agent, I want my existing pulled skills to show up in it so that I do not re-pull everything.
- As an operator, I want stale symlinks repaired automatically so that moving `HOME` does not break recall.

## Functional requirements

- **FR-1 Fan-out on global write.** When a global-install pull writes a skill, the pull engine creates a symlink in every detected non-Claude agent skills root pointing at the canonical `~/.claude/skills/<name>--<author>/` directory (for example `~/.codex/skills/<name>--<author>`, `~/.hermes/skills/<name>--<author>`, `~/.pi/skills/<name>--<author>`).
- **FR-2 Detected roots.** Detected agent roots come from `detectAgentSkillsRoots`, which checks for known agent directories under the user's home directory.
- **FR-3 Global-install only.** Fan-out runs only for global installs; project-local pulls (`<cwd>/.claude/skills/`) are never fanned out.
- **FR-4 Idempotent and self-healing.** Re-running the same pull with the same detected roots is a no-op for links that already point at the correct canonical path; stale links pointing at a different canonical path (for example after `HOME` moved) are unlinked and recreated.
- **FR-5 Canonical directory naming.** Symlinks always target the canonical `<name>--<author>` directory, preserving the coexistence guarantee with the user's locally-mined `<name>/` directory.
- **FR-6 Backfill pass.** `backfillSymlinks` runs at the end of every pull run (except dry-runs and project-local pulls), scanning the manifest for all globally-installed entries and ensuring each has a symlink in every currently-detected agent root.
- **FR-7 Backfill closes the skipped gap.** Backfill covers the case where an up-to-date skill takes the `skipped` path (which never triggers per-row fan-out), so a newly installed agent still inherits prior pulls.
- **FR-8 Bounded cost.** Backfill costs roughly one `lstat` syscall per (entry, detected root) pair, negligible compared to the daemon round-trip (for example ~150 syscalls for 50 skills across 3 roots).

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a global-install pull writes a skill, when fan-out runs, then each detected agent root (codex, hermes, pi, etc.) gets a symlink to the canonical directory, and re-running is a no-op for correct links. |
| AC-2 | Given a user installs a new agent after prior pulls, when the next pull completes, then `backfillSymlinks` ensures every globally-installed skill has a link in the newly detected root. |
| AC-3 | Given a project-local pull, when it writes a skill, then no symlink fan-out occurs. |
| AC-4 | Given a stale symlink pointing at a different canonical path, when fan-out runs, then it is unlinked and recreated at the correct target. |
| AC-5 | Given a dry-run pull, when it completes, then neither fan-out nor backfill touches the filesystem. |
| AC-6 | Given a symlink already pointing at the correct canonical path, when fan-out re-runs, then no change is made. |

## Implementation notes

- Detected roots come from `detectAgentSkillsRoots`; fan-out is global-install only, never project-local. Stale links pointing at a different canonical path are unlinked and recreated.
- Backfill closes the gap where up-to-date skills take the `skipped` path and never trigger per-row fan-out; cost is roughly one `lstat` per (entry, root) pair.
- Detected agent roots include codex, hermes, and pi roots under the user's home, discovered at runtime rather than hard-coded.

## Dependencies

- PRD-018b for the pull write path, the `skipped`/`wrote` action, and the manifest.
- `detectAgentSkillsRoots` and the canonical `~/.claude/skills/<name>--<author>/` directory convention.
- The local pull manifest of globally-installed entries.

## Open questions

- [ ] Do project-local pulls ever warrant fan-out, or is global-only the permanent rule?

## Related

- [parent index](./prd-018-team-skill-sharing-index.md)
- [Team Skills Sharing](../../../knowledge/private/collaboration/team-skills-sharing.md)

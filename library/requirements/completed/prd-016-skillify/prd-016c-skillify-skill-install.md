# PRD-016c: Skill Install and Propagation

> **Parent:** [PRD-016](./prd-016-skillify-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** S

## Scope

Local install and team propagation: `honeycomb skillify pull` writing author-suffixed skill files and fanning out symlinks to every detected agent's skill root, plus idempotent auto-pull at session start bounded by a short timeout.

## Goals

- Let any teammate pull a published skill into their own skill directory with a single command.
- Keep cross-author skills with the same name disjoint on disk via the `<name>--<author>` convention.
- Make pulled skills immediately visible to every detected agent through symlink fan-out, no per-harness install.
- Run an idempotent auto-pull at session start that never blocks startup and fails soft.

## Non-Goals

- Mining and gating sessions (PRD-016a).
- Writing the `SKILL.md` and recording the `skills` row (PRD-016b).
- Version-conflict policy and the pull manifest beyond what install needs (covered in PRD-018b/018c).

## User stories

- As a teammate, I want skills auto-pulled at session start so that I get the team's latest mined knowledge without a manual step.
- As a multi-harness user, I want a pulled skill to show up in all my agents at once so that I do not re-install per harness.
- As an operator, I want a slow store to never block my session from starting so that recall is best-effort.

## Functional requirements

- **FR-1 Pull command.** `honeycomb skillify pull` reads the latest `skills` rows through the daemon and writes `~/.claude/skills/<name>--<author>/SKILL.md` for each.
- **FR-2 Author suffix.** The `--<author>` suffix keeps cross-author same-name skills disjoint and self-documents provenance, while Claude Code's one-directory-deep loader still discovers them.
- **FR-3 Idempotent write.** The pull skips a file when the local version is at or newer than the remote, so re-running with no changes touches no files.
- **FR-4 Symlink fan-out.** On a global-install pull, the pull engine creates a symlink in every detected non-Claude agent skills root (for example `~/.agents/skills/`, `~/.hermes/skills/`, `~/.pi/agent/skills/`) pointing at the canonical `~/.claude/skills/<name>--<author>/` directory.
- **FR-5 Auto-pull at session start.** Auto-pull runs at every `SessionStart`, served by the daemon, pulling the latest skills for the org before the agent begins work.
- **FR-6 Bounded and fail-soft.** The auto-pull is bounded by a 5-second timeout and swallows all errors, so a slow or unavailable DeepLake never blocks a session from starting.
- **FR-7 Opt-out.** Auto-pull is disabled by `HONEYCOMB_AUTOPULL_DISABLED=1`; unauthenticated sessions skip the pull silently without logging a warning.
- **FR-8 Daemon-only.** Both the manual pull and auto-pull query the `skills` table through the daemon (port 3850); neither opens DeepLake directly.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a `skills` row, when `honeycomb skillify pull` runs, then it writes `~/.claude/skills/<name>--<author>/SKILL.md` and symlinks into every other detected agent's skill root. |
| AC-2 | Given auto-pull at session start, when the local version is at or newer than remote, then the file is skipped, and the call is bounded by a 5-second timeout that swallows errors so a slow store never blocks startup. |
| AC-3 | Given `HONEYCOMB_AUTOPULL_DISABLED=1`, when a session starts, then auto-pull does not run. |
| AC-4 | Given an unauthenticated session, when auto-pull would run, then it skips silently without a warning. |
| AC-5 | Given a global-install pull, when fan-out runs, then a symlink exists in each detected agent root pointing at the canonical directory. |
| AC-6 | Given any pull, when it queries the store, then it goes through the daemon, not a direct DeepLake connection. |

## Implementation notes

- The `--<author>` suffix keeps cross-author same-name skills disjoint; symlink fan-out targets the detected agent roots (`~/.agents/skills/`, `~/.hermes/skills/`, `~/.pi/agent/skills/`, and others discovered at runtime).
- Auto-pull served by the daemon; disabled by `HONEYCOMB_AUTOPULL_DISABLED=1`. The detailed `decideAction` version policy, manifest, and backfill live in PRD-018.
- The idempotent pull costs one daemon round-trip plus `existsSync` syscalls per call, so it is intentionally not throttled.

## Dependencies

- PRD-016b for the published `skills` rows.
- The honeycomb daemon (port 3850).
- The detected agent skill roots on disk.

## Open questions

- [ ] Should auto-pull's 5-second timeout be configurable for slow networks, or always fail-open?

## Related

- [parent index](./prd-016-skillify-index.md)
- [Skillify Pipeline](../../../knowledge/private/ai/skillify-pipeline.md)
- [Team Skills Sharing](../../../knowledge/private/collaboration/team-skills-sharing.md)

# PRD-004c: Identity File Watcher

> **Parent:** [PRD-004](./prd-004-daemon-runtime-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

Build the daemon's non-HTTP input: a watcher over the workspace identity files and known harness project-memory paths that runs two debounced jobs on change, harness sync (regenerate per-harness copies from the canonical workspace files) and git auto-commit (stage and commit the workspace when git sync is enabled). The workspace identity files stay on local disk even though durable memory lives in DeepLake; the daemon on port 3850 owns the watcher.

## Goals

- Watch the canonical identity files and harness project-memory paths and react to changes.
- Regenerate each per-harness copy from the canonical files, stamped with a do-not-edit header.
- Stage and commit the workspace with a timestamped message when git sync is enabled.
- Debounce both jobs so a burst of edits produces a single sync and a single commit.

## Non-Goals

- The DeepLake durable-memory write path (PRD-003, PRD-005); identity files are local disk.
- The harness connector install flow that defines where copies land (integrations module).
- The git sync enable/disable policy surface (`/api/git/*` route body, PRD-004a scaffolding).
- The HTTP server itself (PRD-004a).

## User stories

- As a developer, I want my canonical identity files to fan out to each harness automatically so I edit one source, not six copies.
- As a developer, I want a do-not-edit header on each generated harness copy so I do not accidentally edit a derived file.
- As a team, I want workspace changes auto-committed with a timestamp so identity drift is tracked in git.

## Functional requirements

- FR-1: The watcher monitors the workspace identity files `agent.yaml`, `AGENTS.md`, `SOUL.md`, `MEMORY.md`, `IDENTITY.md`, and `USER.md`, plus known harness project-memory paths.
- FR-2: On a change to any watched identity file, the watcher runs harness sync, regenerating each per-harness copy (for example `~/.claude/CLAUDE.md`) from the canonical files.
- FR-3: Each generated per-harness copy is stamped with a do-not-edit header identifying it as daemon-generated.
- FR-4: When git sync is enabled, on a workspace change the watcher stages and commits with a timestamped message.
- FR-5: Both jobs are debounced over a configurable window so a burst of edits produces one sync and one commit, not one per keystroke.
- FR-6: The watcher is a daemon-owned service, not spawned loosely from a hook, so it runs for the life of the daemon process.
- FR-7: Harness sync is idempotent: regenerating from unchanged canonical files produces byte-identical copies and no spurious git commit.
- FR-8: A canonical file removed or renamed is handled gracefully (the corresponding harness copy is regenerated or removed) without crashing the watcher.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a change to `agent.yaml`, `AGENTS.md`, `SOUL.md`, `MEMORY.md`, `IDENTITY.md`, or `USER.md`, when the watcher fires, then per-harness copies regenerate (e.g. `~/.claude/CLAUDE.md`), each stamped with a do-not-edit header. |
| AC-2 | Given git sync is enabled, when the workspace changes, then the watcher stages and commits with a timestamped message. |
| AC-3 | Given a burst of edits within the debounce window, when the watcher settles, then exactly one harness sync and one commit run. |
| AC-4 | Given unchanged canonical files, when harness sync runs, then the copies are byte-identical and no spurious commit is made. |
| AC-5 | Given git sync is disabled, when the workspace changes, then harness copies regenerate but no commit is made. |
| AC-6 | Given a canonical file is removed, when the watcher fires, then the corresponding harness copy is reconciled and the watcher keeps running. |
| AC-7 | Given the daemon is up, when it runs, then the watcher service is active for the life of the process. |

## Implementation notes

- Daemon modules: a watcher service subscribes to filesystem events; a harness-sync renderer reads canonical files and writes per-harness copies; a git-sync helper stages and commits.
- Data shapes: per-harness copies are derived artifacts, never canonical; the do-not-edit header is prepended on every regenerate so manual edits are visibly overwritten.
- The watched set is the six identity files plus the harness project-memory paths the connectors register; the debounce window is a short configurable interval (sub-second to a couple of seconds) chosen to coalesce editor save bursts.
- Edge cases: a partial write (editor truncate-then-write) is absorbed by debounce so the renderer reads a settled file; a git commit with no changes is skipped.
- Failure handling: a render or commit failure is logged and surfaced to diagnostics without crashing the watcher; the next change retriggers the job.

## Dependencies

- PRD-004a HTTP server (process lifecycle the watcher runs within).
- Integrations module (defines harness copy destinations and registers project-memory paths).
- Workspace layout doc (canonical file set and on-disk layout).

## Open questions

- [ ] What is the exact debounce window and should it differ between harness sync and git auto-commit?
- [ ] Should the watcher also reconcile copies on daemon startup, not only on change?

## Related

- [parent index](./prd-004-daemon-runtime-index.md)
- [Daemon Surface](../../../knowledge/private/architecture/daemon-surface.md)
- [System Overview](../../../knowledge/private/architecture/system-overview.md)
- [Workspace Layout](../../../knowledge/private/data/workspace-layout.md)

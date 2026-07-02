# PRD-020d: Notifications and Environment Health

> **Parent:** [PRD-020](./prd-020-surfaces-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Scope

The trigger-agnostic, fail-soft notifications framework that evaluates, queues, and delivers contextual alerts on session start, plus the proactive D1-D5 environment health check and idempotent auto-wiring engine. This sub-PRD owns the notifications pipeline, the double-invocation claim lock, the persistent-versus-transient state model, the five health dimensions, and the auto-wiring correctness rules. It does not own the CLI dispatcher (020a), the dashboard (020b), or the Cursor extension shell (020c), though those surfaces consume health and notification state.

## Goals

- A trigger-agnostic, fail-soft notifications framework that runs synchronously on session start without adding visible latency.
- An atomic claim lock so racing hook processes never show a duplicate banner.
- A proactive D1-D5 environment health check that surfaces missing prerequisites before they cause silent data loss.
- An idempotent auto-wiring engine that resolves the wirable dimensions while preserving foreign hooks and reversing cleanly on uninstall.

## Non-Goals

- The CLI `status` presentation (020a), which consumes the health result.
- The dashboard and extension surfaces (020b, 020c), which display notification and health state.
- The hook lifecycle contract itself (PRD-019b); this owns the notifications drained at session start, not capture.
- Daemon storage and tenancy internals.

## User stories

- As a developer, I want prerequisite failures surfaced early so that the shared store does not fill with silent empty placeholders.
- As a developer running two racing hook processes, I want exactly one banner so that my terminal is not cluttered with duplicates.
- As a developer, I want auto-wiring to fix my hooks without overwriting my other tools so that setup is near-zero friction and safe.

## Functional requirements

- FR-1: The notifications pipeline drains on `SessionStart`: it reads persistent state and the queue, evaluates rules for the `session_start` trigger, fetches backend notifications through the daemon, and picks a primary banner under the priority model.
- FR-2: The pipeline is fail-soft and bounded: backend and primary-banner fetches run in parallel with independent ~1.5s timeouts so session-start latency stays bounded by roughly 1.5s, and any fetch failure is swallowed rather than blocking the session.
- FR-3: Backend notifications are fetched through the daemon, which holds the authenticated connection to the DeepLake cloud; the notifications code never opens DeepLake directly.
- FR-4: A double-invocation claim lock uses POSIX exclusive create (`openSync` with `wx`): the first process to create the claim file emits the notification, and a racer that hits `EEXIST` skips emitting it, so exactly one banner shows.
- FR-5: Persistent notifications (welcome, first-time guides, org savings recaps) record their `id` and `dedupKey` in `~/.honeycomb/notifications-state.json` so they display exactly once; state writes use a temp file plus atomic `renameSync`.
- FR-6: Transient notifications (payment failures, missing background dependencies) unlink their claim file on drain (`releaseClaim`) so future sessions re-emit the warning while the underlying issue persists.
- FR-7: The health check evaluates five independent dimensions: D1 `honeycomb` CLI installed (PATH plus version probe), D2 daemon reachable on port 3850 (TCP probe with fast-start fallback), D3 `cursor-agent` present (PATH plus IDE-directory fallbacks), D4 `cursor-agent` login (lightweight status query), and D5 hooks wired and current (`hooks.json` matches the current bundle).
- FR-8: The auto-wiring engine wires the lifecycle events into `~/.cursor/hooks.json` on the user's behalf, resolving the wirable dimensions; it surfaces the failing dimension when a non-wirable prerequisite (for example a logged-out state) is missing.
- FR-9: Auto-wiring preserves foreign hooks (filters Honeycomb entries via `isHoneycombEntry`, appends Honeycomb config), is idempotent (`writeJsonIfChanged` so an unchanged config is never rewritten, protecting the hook-trust fingerprint), and is reversible (uninstall strips only Honeycomb hooks and unlinks an emptied config file).

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given two hook processes race on session start, when both try to emit the same notification, then an atomic claim lock ensures exactly one banner is shown. |
| AC-2 | Given the health check runs, when a dimension (D1 CLI, D2 daemon, D3 cursor-agent, D4 login, D5 hooks) fails, then it is surfaced and the wirable dimensions are auto-resolved without overwriting foreign hooks. |
| AC-3 | Given a backend fetch hangs, when session start drains notifications, then the fetch times out near 1.5s and the session proceeds without visible latency. |
| AC-4 | Given a persistent welcome notification already shown, when a later session starts, then it is not shown again. |
| AC-5 | Given a transient warning whose cause persists, when the next session starts, then the warning re-emits. |
| AC-6 | Given an unchanged hook configuration, when auto-wiring re-runs, then no file is written and the hook-trust fingerprint is unchanged. |

## Implementation notes

- The framework is trigger-agnostic and fail-soft by design so it can run synchronously during `SessionStart` without adding latency; backend pushes are currently additive and a follow-up collapses all sources (rules, queue, backend) under one priority model.
- State integrity uses temp-file-plus-atomic-rename for `writeState` and POSIX exclusive create for claims, both to survive concurrent hook processes.
- Auto-wiring shares its correctness rules (preserve foreign, idempotent, reversible) with the connector base (019a) and the Cursor extension wiring (020c).

## Dependencies

- Daemon for backend notification fetches and the D2 reachability probe.
- PRD-020a `status` command, which surfaces the D1-D5 result.
- PRD-020c Cursor extension status bar, which displays health and triggers auto-wiring.
- `~/.honeycomb/` for persistent and transient state and claim files.

## Open questions

- [ ] Should notifications collapse all sources (rules, queue, backend) under one priority model now or later?
- [ ] How much of the health check generalizes beyond Cursor's `cursor-agent` dimensions to other harnesses?

## Related

- [parent index](./prd-020-surfaces-index.md)
- [Notifications and Environment Health](../../../knowledge/private/operations/notifications-and-health.md)
- [CLI Command Architecture](../../../knowledge/private/operations/cli-command-architecture.md)

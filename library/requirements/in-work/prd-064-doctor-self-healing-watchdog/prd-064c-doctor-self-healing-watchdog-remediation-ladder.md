# PRD-064c: Doctor - Remediation Ladder

> **Parent:** [PRD-064](./prd-064-doctor-self-healing-watchdog-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** L (1-3d)

---

## Goals

Encode the escalating repair actions a careful human operator would take, each idempotent. Authority resolved by OD-4 (Mario, 2026-06-27): all v1 rungs are **autonomous** - there is no confirm/authorize gate in v1, except that the highest-blast-radius action (credential purge) is **deferred entirely**.

| Rung | Action | Authority (v1) |
|---|---|---|
| 1 | Restart primary daemon | **Auto** (064a) |
| 2 | Reinstall primary (`npm i -g @legioncodeinc/honeycomb`, re-register, restart) | **Auto, after 3 failed restarts** |
| 3 | Uninstall conflicting Hivemind (`@deeplake/hivemind`) | **Auto, always** when a conflicting install is detected |
| 4 | Escalate to dashboard + telemetry "needs attention" | **Auto** (064g) |
| - | Clear bad credentials (`~/.deeplake/credentials.json`) | **DEFERRED - not in v1.** On a suspected credential fault, escalate (rung 4) instead of purging. |

## Scope

- **Rung 2 reinstall:** a clean global reinstall of `@legioncodeinc/honeycomb`, fixing the "stale global daemon serves old routes" failure mode; verify version via `/health` after; fires only after 3 consecutive failed restarts (064a).
- **Rung 3 uninstall Hivemind:** detect a conflicting `@deeplake/hivemind` global and remove it automatically per the coexistence rules in [`prd-050d`](../../completed/prd-050-quick-install-and-guided-setup/prd-050d-quick-install-and-guided-setup-hivemind-coexistence-and-migration.md). Uninstall removes the **package only** - it must NOT delete the shared `~/.deeplake/` state Honeycomb still depends on.
- **Rung 4 escalate:** hand off to [064g](./prd-064g-doctor-self-healing-watchdog-dashboard-escalation-reporting.md) when the ladder cannot restore health, including when a deferred action (credential purge) is what Doctor believes is needed.
- Idempotency + before/after state capture for every rung (feeds 064d/064g), including a timestamped backup before rung 3's uninstall.

## Out of scope

- The watch loop and backoff - [064a](./prd-064a-doctor-self-healing-watchdog-supervisor-core-and-lifecycle.md).
- Forward auto-update of the primary (distinct from reinstall-as-repair) - [064e](./prd-064e-doctor-self-healing-watchdog-auto-update-engine.md).
- **Credential purge - deferred.** Designed for, not built in v1.

## Acceptance criteria

- AC-064c.1 Given 3 failed restarts, when rung 2 fires, then Doctor reinstalls the primary and a stale-route symptom is gone (version reported by `/health` matches the blessed version).
- AC-064c.2 Given a conflicting `@deeplake/hivemind` global is detected, when rung 3 fires, then it is removed automatically and Honeycomb's shared `~/.deeplake/` state is left intact.
- AC-064c.3 Given a suspected credential fault, when Doctor reaches that condition, then it does NOT delete credentials and instead escalates (rung 4) noting the action it would have taken.
- AC-064c.4 Given any rung runs twice, when re-run, then the second run is a safe no-op (idempotent).
- AC-064c.5 Given rung 3 removes a package, when it does, then a timestamped record of what was removed is written before deletion.
- AC-064c.6 Given any rung, when it completes, then before/after state is recorded in `incidents.ndjson`.

## Technical considerations

- **Shared `~/.deeplake/` caution:** credentials and onboarding state are shared with Hivemind. Rung 3 distinguishes "uninstall the `@deeplake/hivemind` package" from "delete `~/.deeplake/`" - it does the former, never the latter.
- **Reinstall vs auto-update:** rung 2 is a *repair* (reinstall the blessed version to fix a corrupted install); 064e is a *forward* update. They share the npm-install primitive and a single install lock so they never run concurrently.
- **Why credentials are deferred:** purging `~/.deeplake/credentials.json` logs the user out and touches state shared with Hivemind; the blast radius is not worth it for v1. Escalation surfaces the suspicion to us instead.

## Open questions

- [ ] Rung 3 trigger precision: uninstall conflicting Hivemind "always when detected" - confirm the exact detection signal (a `@deeplake/hivemind` global present? actively bound to a conflicting port? only when implicated in the current failure?).
- [ ] Headless installs: rung 4 escalation is the path when there is no interactive user - confirm escalation reaches us via the hosted sink (064g) in that case.

> OD-4 (authority model) is resolved in the parent index: restart auto / reinstall after 3 / uninstall Hivemind always / credentials deferred.

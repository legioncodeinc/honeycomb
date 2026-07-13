# PRD-053: Coaching and Reminder Loop

> **Status:** Backlog (sequenced last; rides on the signals from [Hive PRD-015](../../../../../hive/library/requirements/backlog/prd-015-repository-health-and-knowledge-drift/prd-015-repository-health-and-knowledge-drift-index.md) and the workflow from [Hive PRD-016](../../../../../hive/library/requirements/backlog/prd-016-join-repository-to-hive/prd-016-join-repository-to-hive-index.md))
> **Priority:** P2
> **Effort:** M (1-2d)
> **Schema changes:** None to the DeepLake catalog. Adds a machine-local nudge-state record (dismissals, last-fired) so coaching is calm and not repetitive.

---

## Overview

Hive PRD-015 shows the user that drift exists. Hive PRD-016 gives them the workflow to fix it. This module closes the loop: it **coaches** the user toward that workflow at the right moments, so a joined repo's knowledge stays alive without the user having to remember to maintain it.

The deliverable is a small, opt-out, **non-blocking** coaching layer that watches the Hive PRD-015 signals and a few lifecycle events (most importantly: a PRD or IRD just moved to `completed/`) and, when a threshold is crossed, surfaces a gentle, specific, dismissible nudge: "PRD-0xx shipped and touched code that 2 knowledge docs describe, but no knowledge doc changed. Run `/knowledge-stinger` to capture what changed." Every nudge is actionable, every nudge can be dismissed, and no nudge ever blocks, modifies the repo, or runs anything on its own.

The hardest design constraint is **not becoming annoying**. A coaching layer that cries wolf, repeats itself, or fires on a green repo gets muted on day two and the whole feature dies. So the rules are strict: nudges fire only off real Hive PRD-015 signals (never speculation), each nudge is rate-limited and remembers its dismissal, and the layer is trivially and permanently silenceable. Coaching is a calm assistant, not a nag.

Two principles:

> **Principle 1 (earn the interruption):** a nudge only appears when there is a specific, evidence-backed reason from Hive PRD-015, tied to a concrete action the user can take now. No generic "remember to document your code" reminders.
> **Principle 2 (the user is always in control):** every nudge is dismissible, the whole layer is opt-out (and respects the same do-not-disturb posture as the rest of the product), and a dismissed nudge does not return until its underlying condition meaningfully changes.

The two sub-PRDs cover the **signal-to-nudge engine** (what fires, when, and how it stays quiet) and the **nudge surface** (where nudges appear and how they are dismissed), both reusing the Hive PRD-015 signals and the existing dashboard/notification surfaces rather than inventing new ones.

---

## Goals

- A **coaching engine** that turns Hive PRD-015 signals + a small set of lifecycle events (PRD/IRD moved to `completed/`, drift crossing a threshold, skill-freshness lag growing) into specific, actionable nudges, each carrying the evidence and the suggested command.
- The flagship nudge: **after a PRD ships**, if the PRD-to-knowledge gap signal flags it, suggest running `/knowledge-stinger` to capture the change, with a one-click copy of the relevant prompt (reusing Hive PRD-016c's prompt generation).
- **Anti-annoyance guarantees**: nudges fire only off real signals, are rate-limited, remember dismissals, and never fire on a clean signal; a dismissed nudge stays gone until its condition materially changes.
- **Non-blocking, read-only, opt-out**: a nudge never blocks an action, never mutates the repo, never auto-runs a Stinger, and the whole layer can be turned off (respecting the product's existing do-not-disturb/telemetry-style opt-out posture).
- **Surface reuse**: nudges appear on the Repository Health page (Hive PRD-015c) and/or the existing dashboard notification surface, not a new modal regime.

## Non-Goals

- **Computing the underlying signals.** That is Hive PRD-015. This module only decides *when a signal becomes a nudge* and *how it is shown*.
- **Auto-running `/knowledge-stinger` or any Stinger.** Coaching suggests and hands over a prompt; the user acts. No autonomous repo mutation.
- **The scaffold / join flow.** Hive PRD-016. Coaching assumes a joined repo (or degrades to a single gentle "join to keep this green" pointer for an unjoined one, without becoming a nag).
- **Email/Slack/external notifications.** v1 coaching lives in the local dashboard surface; external channels are a later, separate decision.
- **A general notification framework.** Reuse the existing surfaces; do not build a new one.
- **Gamification / streaks / scores beyond the Hive PRD-015 health band.** Out of scope and against the calm-assistant posture.

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-053a-…-signal-to-nudge-engine`](./prd-053a-coaching-and-reminder-loop-signal-to-nudge-engine.md) | The engine that maps Hive PRD-015 signals + lifecycle events to nudges, with thresholds, rate-limiting, dismissal memory, and the opt-out gate. Defines the post-ship `/knowledge-stinger` nudge. | Draft |
| [`prd-053b-…-nudge-surface-and-dismissal`](./prd-053b-coaching-and-reminder-loop-nudge-surface-and-dismissal.md) | Where nudges render (health page + existing notification surface), the copy-the-prompt affordance, and the dismiss/snooze interaction backed by local nudge-state. | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion |
|---|---|
| AC-1 | When a PRD/IRD moves to `completed/` and Hive PRD-015's PRD-to-knowledge gap signal flags it, a specific nudge appears suggesting `/knowledge-stinger`, naming the PRD and the affected docs/code, with a one-click copy of the relevant prompt. |
| AC-2 | Every nudge is **evidence-backed**: it links to the exact Hive PRD-015 signal that produced it; a test asserts no nudge can fire without a corresponding live signal. |
| AC-3 | Nudges are **non-blocking and read-only**: surfacing or dismissing a nudge never blocks an action, never mutates the repo, and never runs a Stinger; a test asserts the working tree is unchanged across the nudge lifecycle. |
| AC-4 | The coaching layer is **opt-out** and respects the product's existing do-not-disturb posture; when disabled, no nudge is computed or shown. |
| AC-5 | Nudges are **rate-limited and dismissal-aware**: a dismissed nudge does not reappear until its underlying condition materially changes; a test drives dismiss -> unchanged-signal -> assert-no-reappearance, then changed-signal -> assert-reappearance. |
| AC-6 | No nudge fires on a clean signal; a healthy repo shows zero nudges (the calm-by-default guarantee), asserted by a test. |
| AC-7 | Nudges render on the Repository Health page and/or the existing dashboard notification surface, reusing existing UI; no new modal/notification framework is introduced. |

---

## Data model changes

**No DeepLake catalog changes.** One new machine-local record:

- **Nudge-state (new, machine-local):** per-project record of which nudges have fired, when, and which were dismissed/snoozed and against what signal-state, so the engine can enforce rate-limiting, dismissal memory, and "only return when the condition changes." Keyed by project id, under the runtime dir, deletable, carries no secret.

All signal inputs are read from Hive PRD-015's snapshot; the lifecycle event (PRD moved to completed) is derived from the same library folder-state Hive PRD-015a already reads.

---

## API changes

All local, loopback, local-mode-only, beside the dashboard host group:

- `GET /coach/nudges?project=<id>` returns the currently-active, non-dismissed nudges for the selected project (computed from Hive PRD-015 signals + nudge-state + the opt-out gate).
- `POST /coach/nudges/<id>/dismiss?project=<id>` records a dismissal (and optional snooze) in nudge-state. This writes only the machine-local nudge-state, never the repo.
- The opt-out is read from the existing settings/do-not-disturb mechanism; no new opt-out surface is invented.

No outbound network calls are added.

---

## Open questions

- [ ] **Thresholds:** what magnitude of drift / staleness / skill-lag earns a nudge (versus living quietly on the health page)? Lean: start conservative, fire on the high-confidence post-ship gap first, widen only with evidence.
- [ ] **"Materially changed" definition** for dismissal re-fire: new offending docs added to a signal, the band worsening, a new PRD shipping? Needs a precise, testable rule to avoid both nag and silence.
- [ ] **Where nudges live primarily:** the health page, a global dashboard notification area, or both. Lean: the health page is the home; a single global indicator points to it.
- [ ] **Unjoined-repo behavior:** does coaching show a single "join to keep this green" pointer, or stay silent until joined? Lean: at most one gentle, dismissible pointer; never repeated.
- [ ] **Opt-out granularity:** all coaching on/off, or per-signal-type mute? Lean: global on/off for v1, per-type mute later if asked for.
- [ ] **Snooze semantics:** time-based snooze vs condition-based dismissal only. Lean: condition-based is the honest default; a time snooze is optional sugar.

---

## Related

- [Hive PRD-015: Repository Health and Knowledge Drift](../../../../../hive/library/requirements/backlog/prd-015-repository-health-and-knowledge-drift/prd-015-repository-health-and-knowledge-drift-index.md) — the signals every nudge is backed by; nudges never fire without one.
- [Hive PRD-016: Join Repository to Hive](../../../../../hive/library/requirements/backlog/prd-016-join-repository-to-hive/prd-016-join-repository-to-hive-index.md) and [016c](../../../../../hive/library/requirements/backlog/prd-016-join-repository-to-hive/prd-016c-join-repository-to-hive-onboarding-explainer-and-prompt.md) — the `/knowledge-stinger` prompt generation reused by the flagship nudge.
- [PRD-029: Degradation Observability](../../completed/prd-029-degradation-observability/prd-029-degradation-observability-index.md) and [Notifications and Health](../../../knowledge/private/operations/notifications-and-health.md) — the existing notification/health posture and the opt-out/do-not-disturb pattern reused here.
- [PRD-050e: Operator Adoption Telemetry](../../completed/prd-050-quick-install-and-guided-setup/prd-050e-quick-install-and-guided-setup-operator-adoption-telemetry.md) — the opt-out, fail-soft, non-blocking posture this module mirrors for coaching.
- [`src/dashboard/web/panels.tsx`](../../../../src/dashboard/web/panels.tsx) — the surface nudges render through.

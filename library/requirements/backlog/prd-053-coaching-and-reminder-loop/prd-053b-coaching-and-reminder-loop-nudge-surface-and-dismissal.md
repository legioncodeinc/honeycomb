# PRD-053b: Nudge Surface and Dismissal

> **Parent:** [PRD-053](./prd-053-coaching-and-reminder-loop-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** S (< 1d)
> **Schema changes:** None. Renders 053a nudges; dismissals write the machine-local nudge-state.

---

## Overview

The user-facing half of coaching: where nudges appear, how the user acts on them, and how they make them go away. It reuses existing dashboard surfaces (the Repository Health page from PRD-051c and the existing notification affordance) rather than inventing a new modal regime, consistent with the calm-assistant posture.

## Goals

- Render the active nudges from `GET /coach/nudges` on the **Repository Health page** (PRD-051c) and/or the existing dashboard notification surface, scoped to the selected project.
- For the flagship nudge, provide a **one-click copy** of the `/knowledge-stinger` prompt so the user can act immediately in their agent.
- Provide a **dismiss** (and optional snooze) control that calls `POST /coach/nudges/<id>/dismiss`, after which the nudge disappears and stays gone until 053a's material-change predicate re-emits it.
- Keep nudges **calm and non-blocking**: inline, dismissible, never a blocking modal, never auto-acting.
- Render nothing when there are no active nudges (a healthy repo is quiet).

## Non-Goals

- Deciding what fires or when (053a).
- A new notification framework; reuse existing primitives/surfaces.
- External channels (email/Slack).

## User stories

- As a user, a relevant nudge shows up where I am already looking (the health page), and I can copy the prompt and act in one move.
- As a user, dismissing a nudge is instant and it does not come back until something actually changes.
- As a user on a healthy repo, I see no nudges and the surface is quiet.

## Acceptance criteria

| ID | Criterion |
|---|---|
| b-AC-1 | Active nudges render on the Repository Health page (and/or the existing notification surface), scoped to the selected project, each showing its evidence and suggested action. |
| b-AC-2 | The flagship nudge offers a one-click copy of the `/knowledge-stinger` prompt; copying performs no repo write and runs nothing. |
| b-AC-3 | Dismissing a nudge calls the dismiss endpoint, removes it from view immediately, and it does not reappear until 053a re-emits it on a material change; an end-to-end test drives this. |
| b-AC-4 | Nudges are non-blocking and inline (no blocking modal); a healthy repo with no active nudges renders an empty/quiet state. |
| b-AC-5 | The surface reuses existing dashboard primitives; no new modal/notification framework is added. |
| b-AC-6 | Interacting with the surface (view, copy, dismiss) leaves the working tree unchanged; only machine-local nudge-state is written on dismiss. |

## Implementation notes

- Render through existing primitives/panels ([`panels.tsx`](../../../../src/dashboard/web/panels.tsx), [`primitives.tsx`](../../../../src/dashboard/web/primitives.tsx)); a nudge is a small inline card with evidence + a primary action (copy prompt) + a dismiss control.
- Fetch via the existing wire pattern ([`wire.ts`](../../../../src/dashboard/web/wire.ts)); re-fetch after dismiss so the view reflects nudge-state.
- The copy action puts the 053a-provided prompt on the clipboard; it never executes anything.
- Place the primary home on the health page (PRD-051c) and, if a global indicator is used, have it link there rather than duplicating the cards.

## Open questions

- [ ] Whether a global dashboard indicator (a count/badge) is worth it in v1 or if the health page alone suffices.
- [ ] Snooze UI (a control vs dismissal-only) — ties to 053a's snooze-semantics question.
- [ ] Exact card layout and how much evidence to show inline before "view on health page."

## Related

- [PRD-051c: Repository Health Dashboard Page](../prd-051-repository-health-and-knowledge-drift/prd-051c-repository-health-and-knowledge-drift-dashboard-page.md) — the primary host surface.
- [`src/dashboard/web/panels.tsx`](../../../../src/dashboard/web/panels.tsx), [`primitives.tsx`](../../../../src/dashboard/web/primitives.tsx), [`wire.ts`](../../../../src/dashboard/web/wire.ts) — the UI + fetch primitives reused.
- Sibling sub-PRD: [053a signal-to-nudge engine](./prd-053a-coaching-and-reminder-loop-signal-to-nudge-engine.md).

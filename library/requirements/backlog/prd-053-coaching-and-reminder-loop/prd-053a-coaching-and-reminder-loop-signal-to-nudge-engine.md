# PRD-053a: Signal-to-Nudge Engine

> **Parent:** [PRD-053](./prd-053-coaching-and-reminder-loop-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** M (1-2d)
> **Schema changes:** None. Reads Hive PRD-015 signals; writes only the machine-local nudge-state.

---

## Overview

The decision layer of coaching: a daemon-side engine that maps Hive PRD-015 signals and a few lifecycle events to a set of active nudges, while enforcing every anti-annoyance rule. It is the difference between a helpful assistant and a thing the user mutes on day two. The engine computes nudges; the surface (053b) renders and dismisses them.

## Goals

- Map inputs to nudges:
  - **Post-ship gap (flagship):** a PRD/IRD just in `completed/` that Hive PRD-015's PRD-to-knowledge gap flags -> a nudge suggesting `/knowledge-stinger`, naming the PRD, the affected docs, and the change, carrying the copy-paste prompt (reusing 052c generation).
  - **Drift threshold:** knowledge drift crossing a conservative threshold -> a nudge pointing at the worst-drifted doc(s).
  - **Skill-freshness lag:** watermark lag past a threshold -> a gentle "you have un-mined sessions" nudge.
- Enforce **anti-annoyance** rules in the engine itself:
  - never produce a nudge without a live Hive PRD-015 signal backing it;
  - never produce a nudge on a clean signal;
  - rate-limit per nudge type;
  - respect dismissal memory (a dismissed nudge stays gone until its condition materially changes);
  - respect the global opt-out / do-not-disturb gate (when off, compute nothing).
- Persist and read **nudge-state** (fired-at, dismissed-against-signal-state) to make rate-limiting and "return only on material change" deterministic and testable.
- Define **"materially changed"** as a precise, testable predicate per nudge type.

## Non-Goals

- Rendering, dismissing UI, or the copy interaction (053b).
- Computing the signals (Hive PRD-015) or generating the prompt text from scratch (reuse 052c).
- External notifications.

## User stories

- As a user who just shipped a PRD, I get one specific, useful nudge to capture what changed, not a generic reminder.
- As a user on a healthy repo, I get zero nudges and trust that a nudge means something.
- As a user who dismissed a nudge, I do not see it again until the situation actually changes.

## Acceptance criteria

| ID | Criterion |
|---|---|
| a-AC-1 | A PRD/IRD entering `completed/` that Hive PRD-015 flags as a knowledge gap produces exactly one post-ship `/knowledge-stinger` nudge, carrying the PRD name, affected docs, and the prompt payload. |
| a-AC-2 | Every emitted nudge references the specific live Hive PRD-015 signal backing it; a test asserts the engine emits nothing when the backing signal is absent. |
| a-AC-3 | The engine emits zero nudges for a clean repo (all signals healthy); asserted by a test. |
| a-AC-4 | Rate-limiting holds: the same nudge type does not re-emit within its limit; a test drives repeated computation and asserts a single active nudge. |
| a-AC-5 | Dismissal memory holds: after a dismissal recorded in nudge-state, the engine does not re-emit while the signal-state is unchanged, and does re-emit once the "materially changed" predicate is satisfied; a test drives both directions. |
| a-AC-6 | With coaching opted out / do-not-disturb on, the engine computes and emits nothing; asserted by a test. |
| a-AC-7 | Nudge-state writes touch only the machine-local record, never the repository; a test asserts an unchanged working tree across emit + dismiss. |

## Implementation notes

- Read Hive PRD-015 signals from its snapshot/cache rather than recomputing; the engine is a consumer of 051, not a parallel computation.
- Derive the "PRD moved to completed" event from the same library folder-state Hive PRD-015a reads (folder placement is the source of truth).
- Encode "materially changed" per nudge type explicitly (e.g. for the post-ship gap: a new completed PRD or a new offending doc in the gap set; for drift: the drift count for the dismissed doc increasing or a new doc entering the threshold).
- Keep nudge definitions data-driven (a small registry of nudge types with their trigger predicate, rate limit, and material-change predicate) so adding a nudge type later is a contained change.
- Reuse 052c's prompt generation for the flagship nudge so the prompt the user copies matches the join-time prompt.

## Open questions

- [ ] Exact thresholds per nudge type (ties to the parent's threshold question).
- [ ] The precise material-change predicate per type (the riskiest correctness detail; needs tests).
- [ ] Whether skill-freshness coaching belongs in v1 or is deferred behind the two doc-centric nudges.

## Related

- [Hive PRD-015a: Drift and Staleness Signal Engine](../../../../../hive/library/requirements/backlog/prd-015-repository-health-and-knowledge-drift/prd-015a-repository-health-and-knowledge-drift-signal-engine.md) — the signals consumed here.
- [Hive PRD-016c: Onboarding Explainer and Prompt](../../../../../hive/library/requirements/backlog/prd-016-join-repository-to-hive/prd-016c-join-repository-to-hive-onboarding-explainer-and-prompt.md) — the `/knowledge-stinger` prompt generation reused by the flagship nudge.
- [Notifications and Health](../../../knowledge/private/operations/notifications-and-health.md) — the opt-out / do-not-disturb posture the gate reuses.
- Sibling sub-PRD: [053b nudge surface and dismissal](./prd-053b-coaching-and-reminder-loop-nudge-surface-and-dismissal.md).

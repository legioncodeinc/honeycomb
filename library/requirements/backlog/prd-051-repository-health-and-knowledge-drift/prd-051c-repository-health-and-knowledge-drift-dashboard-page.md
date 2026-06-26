# PRD-051c: Repository Health Dashboard Page

> **Parent:** [PRD-051](./prd-051-repository-health-and-knowledge-drift-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M (1-2d)
> **Schema changes:** None. A new read-only dashboard page consuming 051b.

---

## Overview

The user-facing surface of the wedge: a read-only **Repository Health** page on the loopback dashboard, scoped to the project in the top-left switcher. It renders the rolled-up health band and the four signal cards, and lets the user expand any signal to its evidence. This is the first thing a new user should see that proves Honeycomb knows something about their repo that they did not tell it.

The page is deliberately calm. It diagnoses; it does not nag and it does not act. The "fix this" affordances (run a Stinger, scaffold the library) are later modules; here, every flagged item ends in evidence, not a button that mutates the repo.

## Goals

- Register a **Repository Health** page in the dashboard via the existing registry/router/sidebar ([`registry.tsx`](../../../../src/dashboard/web/registry.tsx), [`router.tsx`](../../../../src/dashboard/web/router.tsx), [`sidebar.tsx`](../../../../src/dashboard/web/sidebar.tsx)), following [Adding a Page](../../../knowledge/private/dashboard/adding-a-page.md).
- Scope to the top-left project switcher ([`scope-context.tsx`](../../../../src/dashboard/web/scope-context.tsx)); on project change, reload for that project; with no project, render the standard [`needs-project.tsx`](../../../../src/dashboard/web/needs-project.tsx) empty state.
- Render a **health band** (Healthy / Watch / Drifting) at the top, with a one-line plain-language summary and a link down to the worst signal.
- Render four **signal cards** (knowledge drift, documentation staleness, PRD-to-knowledge gap, skill freshness), each showing a count + the top offenders, each expandable to full evidence fetched on demand from 051b.
- Render honest **empty/insufficient-data states** per card (no graph built yet, no knowledge docs, no PRDs) that read as "not enough data" with a hint of what would populate it, never as a false all-clear.
- A manual **refresh** affordance that calls the recompute endpoint and re-renders.

## Non-Goals

- Any write action, fix button, Stinger trigger, or scaffold CTA. Those are PRD-052 / PRD-053. (A read-only "learn how to fix drift" link to docs is acceptable; an action that mutates the repo is not.)
- New design tokens or a restyle of the shell; reuse existing primitives ([`primitives.tsx`](../../../../src/dashboard/web/primitives.tsx), [`panels.tsx`](../../../../src/dashboard/web/panels.tsx), [`page-frame.tsx`](../../../../src/dashboard/web/page-frame.tsx)).
- Real-time push; load-and-refresh is sufficient for v1.

## User stories

- As a first-time user, I open Repository Health and immediately see one or two real, specific things about my repo (a stale doc, an un-mined session) that make the memory layer feel alive.
- As a developer, I expand a drift flag and see the exact doc and the exact code change, so I can decide whether to act, without the tool acting for me.
- As a user with a fresh repo, I see clear "not enough data yet" states that tell me what to do to populate them (build the graph, add a knowledge doc), not a broken page.

## Acceptance criteria

| ID | Criterion |
|---|---|
| c-AC-1 | A Repository Health page is reachable from the sidebar and renders within the standard page frame, scoped to the selected project; changing the project reloads the view, and no selection shows the needs-project state. |
| c-AC-2 | The health band renders Healthy / Watch / Drifting consistent with 051a's roll-up, with a plain-language one-liner and a link to the worst contributing signal. |
| c-AC-3 | Four signal cards render with counts and top offenders; expanding a card fetches and shows full evidence rows (doc, code reference, what changed, timestamps) from 051b. |
| c-AC-4 | Each card has an honest insufficient-data state when its inputs are absent (graph not built, no knowledge docs, no PRDs), distinguishable from a genuine all-clear. |
| c-AC-5 | The page performs **no repository write**: an end-to-end test loads the page, expands every signal, clicks refresh, and asserts the working tree and knowledge docs are unchanged and no Stinger/skillify ran. |
| c-AC-6 | The refresh affordance calls the recompute endpoint and re-renders updated signals without a daemon restart or a full page reload. |
| c-AC-7 | The page degrades gracefully if the health endpoints are unavailable (shows a "could not load health" state, not a blank or crashed page). |

## Implementation notes

- Add `repository-health.tsx` under [`src/dashboard/web/pages/`](../../../../src/dashboard/web/pages/dashboard.tsx) and register it the same way the existing pages (memories, graph, sync) are; reuse the scope context, page frame, panels, and primitives rather than introducing new UI.
- Fetch via the existing wire pattern ([`wire.ts`](../../../../src/dashboard/web/wire.ts)); summary on mount, per-signal evidence on expand.
- Keep copy plain-language and non-judgemental: "3 docs may be out of date" with evidence beats "DRIFT DETECTED." The tone is a calm diagnosis.
- Empty states should teach: a fresh repo card explains the one action that would populate the signal (e.g. "Build the codebase graph to detect drift").
- This is the surface a future "Join to Hive" CTA (PRD-052) and coaching nudge (PRD-053) will attach to; leave a clean seam but no action wiring in this PRD.

## Open questions

- [ ] Card ordering and whether the band's worst-signal link scrolls-to or expands the offending card.
- [ ] How many top offenders to show per card before "view all" (ties to 051b evidence caps).
- [ ] Whether the page belongs as a standalone sidebar entry or as a section of the existing dashboard home ([`dashboard.tsx`](../../../../src/dashboard/web/pages/dashboard.tsx)). Lean: standalone entry for v1 so it is discoverable.

## Related

- [`src/dashboard/web/pages/`](../../../../src/dashboard/web/pages/dashboard.tsx) — sibling pages to mirror.
- [`scope-context.tsx`](../../../../src/dashboard/web/scope-context.tsx) and [`needs-project.tsx`](../../../../src/dashboard/web/needs-project.tsx) — scope + empty-state behavior.
- [Adding a Page](../../../knowledge/private/dashboard/adding-a-page.md) — the registration contract.
- [PRD-038: Dashboard Home](../../completed/prd-038-dashboard-home/prd-038-dashboard-home-index.md) and [PRD-042: Sync Page](../../completed/prd-042-sync-page/prd-042-sync-page-index.md) — prior read-only page builds to follow.
- Sibling sub-PRDs: [051a signal engine](./prd-051a-repository-health-and-knowledge-drift-signal-engine.md), [051b read-only health API](./prd-051b-repository-health-and-knowledge-drift-read-only-health-api.md).

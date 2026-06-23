# PRD-038a: KPI areas regroup — top KPI band + the three-zone area structure

> **Parent:** [PRD-038 Dashboard Home](./prd-038-dashboard-home-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Overview

This sub-PRD establishes the home page's AREA STRUCTURE and lays the four headline KPIs into a clean top band. Today the
KPI row lives mid-page inside the single `.wrap` stack (`src/dashboard/web/app.tsx` lines 398-403), rendered between the
subsystem health strip and the recall bar, with nothing marking it as a distinct zone. 038a defines the three named
areas the whole home page reads as — a **top KPI band**, a **center recall area**, and a **harness area** — and moves the
existing KPI row into the top band as its anchor. It owns the page's structural skeleton; 038b fills the recall area and
038c fills the harness area.

The four KPIs are unchanged in identity — **Memories**, **Turns** (renamed from "Sessions" by PRD-035a), **Est. savings**
(a real metric per PRD-035b, not the `0 tok` stub), and **Team skills** (corrected per PRD-036c). 038a consumes those
fixes; it does not re-derive them. Every visual value is an existing `var(--…)` token and the existing `Kpi` primitive
(`src/dashboard/web/primitives.tsx`); no new design system.

## Goals

- Define the three home AREAS as explicit, labeled section landmarks (`kpi-band`, `recall-area`, `harness-area`) so the
  page reads as zones and 038b/038c have a defined slot to fill.
- Move the existing four-KPI row into the top `kpi-band`, directly under the shell chrome, as the band's content.
- Render the KPIs with the corrected values: Memories, Turns (PRD-035a label), Est. savings (PRD-035b real metric),
  Team skills (PRD-036c count) — using the existing `Kpi` primitive and its accent tones.
- Keep the page composable: the band is one area component, the recall and harness areas are siblings 038b/038c own.

## Non-Goals

- The recall area's content (038b) and the harness area's content (038c). 038a defines the empty/landmark areas and
  fills ONLY the KPI band.
- Re-deriving the KPI values. Turns rename = PRD-035a; real Est. savings = PRD-035b; Team skills correctness = PRD-036c.
  038a renders whatever the wire client returns for each.
- The subsystem health strip (`HealthStrip`, app.tsx lines 181-202) and the daemon-health pill — those are shell chrome
  relocated by PRD-037 (D-4); 038a does not own them.
- Any new KPI, new token, new color ramp, or a new `Kpi` variant. The band composes the existing four KPIs and the
  existing primitive.
- Tabs, sub-routing, or a second router inside the page — the areas are layout zones, not routes (routing is PRD-037).

## User Stories

- As a local dogfooder, I want the headline metrics in a clear band at the top so I read the product's value at a glance
  without scrolling.
- As a user, I want the page to read as distinct zones (metrics / search / harnesses) so I know where each concern lives.
- As a user, I want the "Turns" KPI labeled correctly and "Est. savings" showing a real number, not a broken `0 tok`.

## Implementation Notes

- **Area structure:** introduce the three home areas as labeled sections — e.g. `<section data-area="kpi-band">`,
  `<section data-area="recall-area">`, `<section data-area="harness-area">` — composed by the Dashboard home component
  (the reorganized `app.tsx` body, or the `dashboard-page.tsx` PRD-037's shell split produces). Each area carries a
  `data-area` (or equivalent landmark) so AC-1 of the parent can assert presence + order. 038b/038c render INTO the
  recall/harness sections; 038a leaves them as the defined-but-empty slots its siblings fill.
- **KPI band content (mirrors app.tsx lines 398-403):** the existing four `Kpi` tiles in the band —
  `<Kpi label="Memories" value={kpis.memoryCount.toLocaleString()} accent="honey" />`, the Turns tile (label per
  PRD-035a, value from `kpis` — currently `kpis.sessionCount`, renamed in the wire/contract by 035a),
  `<Kpi label="Est. savings" value={kpis.estimatedSavings.toLocaleString()} unit="tok" accent="verified" />` (real per
  035b), and `<Kpi label="Team skills" value={skills.length} accent="pollinate" />` (corrected per 036c). Keep the existing
  `.kpirow` grid (or its successor) for the band's internal layout.
- **Band container:** a top section using existing tokens (`--bg-surface` / `--border-default` / `--radius-lg` if the
  band gets a surface, or a plain grouped row matching the current `.kpirow` rhythm). No new token.
- **Hydration:** the KPIs come from the existing `wire.kpis()` + `wire.skills()` hydration the page already runs (no new
  fetch); 038a only relocates WHERE the row renders. The Turns value tracks whatever field 035a settles on in the wire
  contract — 038a depends on 035a for the field/label, not on a local rename.
- **Reuse, do not fork:** compose the existing `Kpi` primitive (primitives.tsx) and the existing grid CSS; do not
  hand-roll a new metric tile.

## Acceptance Criteria

- [ ] **AC-1 — Three named areas exist.** The Dashboard home renders three labeled area sections — KPI band, recall
      area, harness area — in that vertical order, each as an addressable landmark. A DOM/unit test asserts all three are
      present and ordered. (The recall/harness areas may be empty slots at 038a; 038b/038c fill them.)
- [ ] **AC-2 — KPIs sit in the top band.** All four KPIs (Memories, Turns, Est. savings, Team skills) render inside the
      `kpi-band` area at the top of the page, under the shell chrome — not mid-page. A test asserts the four tiles are
      children of the band landmark.
- [ ] **AC-3 — Corrected values surface.** The Turns tile is labeled "Turns" (not "Sessions") per PRD-035a; the
      Est. savings tile shows the PRD-035b real value (not a hardcoded `0`); the Team skills tile shows the PRD-036c
      count. 038a renders the wire values; it introduces no mislabel or stub of its own.
- [ ] **AC-4 — Reuse + tokens only.** The band composes the existing `Kpi` primitive and only existing `var(--…)`
      tokens; no new token, color, or tile variant is introduced.
- [ ] **AC-5 — Gate green.** `npm run ci` passes; the PRD-024/035 DOM tests are updated for the band placement and still
      assert the KPI structure renders; no secret/token introduced into any rendered payload.

## Open Questions

- **OQ-1** — Does the KPI band get its own surface (a `--bg-surface` panel with a border) or stay a borderless grouped
  row as today? Proposed: borderless band matching the current `.kpirow` to keep the top light; confirm against brand.
- **OQ-2** — Should the area landmarks be semantic (`<section aria-label="…">`) or `data-area` hooks (or both)? Proposed:
  both — a `data-area` for tests + an `aria-label` for accessibility; flagged for the parent's DOM-test contract.

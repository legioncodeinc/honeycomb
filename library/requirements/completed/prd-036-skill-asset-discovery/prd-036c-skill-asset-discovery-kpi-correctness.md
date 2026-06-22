# PRD-036c: "Team skills" KPI Correctness

> **Status:** Draft
> **Priority:** P0
> **Effort:** S
> **Parent:** [PRD-036 — Skill & Asset Discovery](./prd-036-skill-asset-discovery-index.md)
> **Depends on:** [PRD-036b — Skill-Sync View = Installed ∪ Synced](./prd-036b-skill-asset-discovery-union-view.md)

## Overview

The dashboard's **Team skills** KPI is wrong. In `src/dashboard/web/app.tsx` it is computed as:

```tsx
<Kpi label="Team skills" value={skills.length} accent="dream" />
```

where `skills` is the array from the skill-sync view — which, before PRD-036, came from the `skills` table
only and was 0. So a KPI **labelled "Team skills"** is silently driven by an incidental `.length` of
whatever the skill-sync query returned. After PRD-036b unions in local skills, `skills.length` would swing
to ~27 (mostly **local**, not team) — which would make the label "Team skills" actively misleading.

This sub-PRD decides what "Team skills" should count and fixes the source so the number matches the label.

## Goals

- **G-1** — Define precisely what the `Team skills` KPI counts.
- **G-2** — Source the KPI from that defined count, not from an incidental `skills.length` of the unioned
  view.
- **G-3** — Keep the local/total breakdown visible somewhere honest (the union panel today; the fuller
  breakdown on the Sync page, PRD-042).

## Non-Goals

- Not the union view itself (PRD-036b) or the scanner (PRD-036a).
- Not the Sync page breakdown UI (PRD-042).
- Not adding new KPIs — this corrects the existing one.

## The decision (D-1)

**The `Team skills` KPI counts team-shared skills only** — the skills actually shared with the team
(`syncState` ∈ {`shared`, `synced`} from the substrate), **not** the union total and **not** local-only
skills. Rationale: the label says "Team", so the number must mean "shared with the team". Counting the
union (local + shared) under a "Team" label is the misleading state this PRD exists to prevent.

The **fuller breakdown** (total available = local + shared + pulled, with a per-state split) belongs on the
**Sync page (PRD-042)**. The dashboard KPI stays a single honest headline number; the panel beneath it
already lists every skill with its state (PRD-036b).

## Implementation

- Compute the KPI from the union view by counting rows whose `syncState` is a team-shared state
  (`shared`/`synced`), **or** expose an explicit `teamSkillCount` on `KpisView` populated by
  `fetchKpisView` (`src/daemon/runtime/dashboard/api.ts`) from the substrate, and bind the KPI to that.
  Prefer the explicit `KpisView` field so the KPI does not depend on the panel's array length.
- Update `src/dashboard/web/app.tsx`:
  `<Kpi label="Team skills" value={teamSkillCount} accent="dream" />` (or the filtered count), no longer
  `skills.length`.
- If a `KpisView` field is added, extend `KpisView` in `src/dashboard/contracts.ts` and `KpisSchema` in
  `src/dashboard/web/wire.ts` (both already tolerant via `.catch(...)`).

## Decisions

- **D-1 — KPI = team-shared count.** Counts `shared`/`synced` substrate skills only; not the union, not
  local-only. The Sync page (PRD-042) shows the fuller breakdown.
- **D-2 — Source from a defined count, not `skills.length`.** Prefer an explicit `KpisView.teamSkillCount`
  from `fetchKpisView` over deriving from the panel array, so label and number can never desync again.
- **D-3 — Label honesty.** The label "Team skills" and the counted set must match; if a future product
  decision wants "total available" instead, the **label** changes too (not just the number).

## Acceptance Criteria

- [ ] **c-AC-1 — Defined count.** The `Team skills` KPI counts team-shared skills (`shared`/`synced`),
  documented in code, and is sourced from that count — never an incidental `skills.length` of the unioned
  view.
- [ ] **c-AC-2 — Honest in this repo.** In this repo (27 local skills, empty/zero shared) the KPI reads the
  true team-shared count (e.g. 0 when nothing is shared) while the **panel** correctly lists the 27 `local`
  skills — number and label agree, and the panel is no longer empty.
- [ ] **c-AC-3 — Reflects sharing.** When skills are shared to the team (substrate rows with shared state),
  the KPI increments to match; pulled/local skills do not inflate it.
- [ ] **c-AC-4 — Tested.** A test asserts the KPI count against a fixture with a mix of local/shared/pulled
  skills. `npm run ci` green.

## Open Questions

- **OQ-1** — Count `shared` only, or `shared` ∪ `pulled` (pulled skills are team skills present locally)?
  Leaning `shared` (authored/shared by the team), with `pulled` shown in the panel + the PRD-042 breakdown.
- **OQ-2** — Add `KpisView.teamSkillCount` (preferred, D-2) vs derive from the filtered union array? Confirm
  the contract addition is worth the wire/schema change (recommend yes — it decouples label from panel).

# PRD-035a — Sessions → Turns rename

> **Status:** Backlog
> **Priority:** P0
> **Effort:** S
> Parent: [PRD-035 — Dashboard Data Fixes](./prd-035-dashboard-data-fixes-index.md)

## Overview

The dashboard surfaces a "Sessions" KPI and a "Sessions" panel, both of which actually count rows
in the DeepLake `sessions` table. In Hivemind's capture model each captured Claude Code / harness
**turn** becomes one row in `sessions` — so the count is a turn count, not a count of distinct
conversations or work sessions. The label "Sessions" misleads users: the number looks inflated and
does not mean what a reader assumes.

This sub-PRD renames the surfaced concept to **Turns** in the presentation layer only. The DeepLake
table stays named `sessions` (that is a schema concern, out of scope — see D-3).

Grounding (current code):

- KPI: `src/dashboard/web/app.tsx:400` — `<Kpi label="Sessions" value={kpis.sessionCount} ... />`.
- Panel: `src/dashboard/web/panels.tsx:137` — `<Panel title="Sessions" eyebrow={`${total} captured`} ...>`
  inside `SessionsPanel`; the empty state reads "No sessions captured yet." (`panels.tsx:139`).
- View-models: `src/dashboard/contracts.ts` — `KpisView.sessionCount` (`contracts.ts:42`),
  `SessionsView.sessions` / `SessionRow` (`contracts.ts:50-67`).
- Wire: `src/dashboard/web/wire.ts` — `KpisSchema.sessionCount`, `SessionsSchema.sessions`,
  `SessionRowWire` (`wire.ts:55-73`).
- Daemon: `src/daemon/runtime/dashboard/api.ts` — `fetchKpisView` does `COUNT(*) FROM "sessions"`
  and `fetchSessionsView` reads the `sessions` table (`api.ts:149-182`).

## Goals

- The KPI label reads **"Turns"**.
- The panel title reads **"Turns"**, with copy that matches (e.g. "N captured", "No turns captured yet.").
- The presentation-layer field naming reflects "turns" where it is purely a display concern.
- No remaining user-facing string that means "captured turns" still says "Sessions".

## Non-Goals

- Renaming the DeepLake `sessions` table or any storage column (D-3).
- Changing the capture model or what a row represents.
- Adding a per-turn event count or any new metric (the existing `eventCount` field is untouched).

## User Story

As a user opening the dashboard, I see a "Turns" KPI and a "Turns" panel so the count is labeled
for what it actually is (captured harness turns), and I am not misled into reading it as a count of
distinct sessions.

## Design Decisions

- **D-1 — Rename display labels unconditionally.** Change the KPI `label` (`app.tsx`), the panel
  `title` and its empty-state/eyebrow copy (`SessionsPanel` in `panels.tsx`) from "Sessions"/
  "sessions" to "Turns"/"turns". This is the load-bearing user-visible fix and is non-negotiable.
- **D-2 — Add a clearly-named presentation field; keep the wire/contract field backward-readable.**
  Recommended approach: rename the *display-facing* React-prop/local naming to "turns" and add a
  clearly-named view-model field (e.g. `KpisView.turnCount`) that the daemon populates alongside
  the existing `sessionCount`, rather than a hard rename of the wire contract in one shot. The wire
  zod schema (`wire.ts`) may accept both `turnCount` and the legacy `sessionCount` (with `.catch`)
  during the transition so an older daemon/newer page (or vice versa) degrades safely. This keeps
  the contract additive (parent invariant: prefer additive edits) while making the new name the
  one the UI reads. **Open Question OQ-1** decides whether we additionally hard-rename
  `SessionsView`/`SessionRow` → `TurnsView`/`TurnRow` or stop at the KPI field.
- **D-3 — Storage stays `sessions`.** `fetchKpisView`/`fetchSessionsView` keep querying the
  `sessions` table by name; the table is not renamed. The rename is a label/field concern, so the
  SQL identifiers (`sqlIdent("sessions")`) are unchanged. Any storage rename is a separate
  deeplake-dataset-worker-bee schema decision and is explicitly out of scope.
- **D-4 — Component rename is optional and internal.** Renaming `SessionsPanel` → `TurnsPanel` (and
  the `sessions` prop) is allowed but internal-only; it must not change the rendered structure the
  PRD-024 DOM tests assert beyond the label text. If renamed, update all import sites
  (`app.tsx:24`, `panels.tsx` export) in the same change. Folded into OQ-1.

## Functional Requirements

- **FR-1** — The KPI in `app.tsx` renders with label text **"Turns"** (value still
  `kpis.turnCount` / fallback `kpis.sessionCount`).
- **FR-2** — `SessionsPanel` (renamed or not) renders with panel title **"Turns"**; the eyebrow
  reads "N captured" and the empty state reads "No turns captured yet."
- **FR-3** — A new presentation-facing view-model field (e.g. `KpisView.turnCount`) carries the
  count; the daemon (`fetchKpisView`) populates it from the same `COUNT(*) FROM "sessions"` it
  already runs. `sessionCount` MAY remain populated for one transition window (D-2).
- **FR-4** — The wire schema validates the new field and degrades safely (`.catch`) if a payload
  carries only the legacy field, so no mismatch throws into React.
- **FR-5** — No user-facing string rendered by the dashboard that means "captured turns" reads
  "Sessions"/"session" (grep-proven across `app.tsx` + `panels.tsx`).

## Acceptance Criteria

- [ ] **AC-1** — `GET /dashboard` shows a KPI labeled **"Turns"** (not "Sessions").
- [ ] **AC-2** — The captured-turns panel is titled **"Turns"**, with "N captured" eyebrow and a
      "No turns captured yet." empty state.
- [ ] **AC-3** — The count value is unchanged from today (still the `sessions`-table row count); only
      the label/field naming changes.
- [ ] **AC-4** — The DeepLake `sessions` table name is untouched (verified: `fetchKpisView` /
      `fetchSessionsView` still `sqlIdent("sessions")`).
- [ ] **AC-5** — A grep over the dashboard web sources finds no remaining user-facing "Sessions"/
      "session" string that denotes captured turns.
- [ ] **AC-6** — The PRD-024 dashboard DOM/unit tests are updated to assert the "Turns" label/title
      and still pass; `npm run ci` is green.

## Open Questions

- **OQ-1** — Do we hard-rename the view-model contracts (`SessionsView`/`SessionRow` →
  `TurnsView`/`TurnRow`, and `KpisView.sessionCount` → `turnCount` with no legacy alias), or keep
  the rename display-only + additive (`turnCount` added, `SessionsView` kept)? Recommendation:
  additive now (display label + `turnCount` field), hard contract rename deferred so it does not
  ripple into PRD-022 product-data consumers that may read the same shapes. Confirm with
  typescript-node-worker-bee before widening scope.
- **OQ-2** — Is "Turns" the final user-facing noun, or should it be "Captured turns" / "Activity"?
  Assumed "Turns" per parent PRD; confirm with design.

## Implementation Notes

- Touch points: `src/dashboard/web/app.tsx` (KPI label), `src/dashboard/web/panels.tsx`
  (`SessionsPanel` title + copy), `src/dashboard/web/wire.ts` (KpisSchema field), `src/dashboard/
  contracts.ts` (`KpisView.turnCount`), `src/daemon/runtime/dashboard/api.ts` (`fetchKpisView`
  populates the new field), and the PRD-024 dashboard tests.
- Keep the change additive on the contract (parent invariant). Do not edit `server.ts`.

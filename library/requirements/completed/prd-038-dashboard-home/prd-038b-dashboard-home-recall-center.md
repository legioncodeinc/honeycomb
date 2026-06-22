# PRD-038b: Memory search — the recall bar + results as the center area

> **Parent:** [PRD-038 Dashboard Home](./prd-038-dashboard-home-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Overview

This sub-PRD makes memory search the visual centerpiece of the home page. Today the recall bar + recalled-memory cards
already work end-to-end: `RecallBar` (`src/dashboard/web/app.tsx` lines 113-143) drives `wire.recall(q)`, which POSTs
`/api/memories/recall` and returns `{ memories, degraded }`; the hits render as `MemoryCard`s (app.tsx lines 419-430),
and the PRD-029 lexical-fallback badge shows when the recall ran degraded (embeddings off → lexical BM25/ILIKE,
app.tsx lines 407-417). 038b does NOT rebuild any of that — it RESTYLES it into the home's center `recall-area` (the
slot 038a defines), so recall is the centerpiece middle zone rather than a band buried mid-stack.

The behavior carries over verbatim: the same POST, the same `MemoryCard` rendering (snippet / score / scope / verified /
source), the same empty-state line ("No memories matched that query."), and the same PRD-029 lexical-fallback badge.
Every visual value stays an existing `var(--…)` token; the `Input`, `Button`, `Badge`, and `MemoryCard` primitives are
reused unchanged.

## Goals

- Render the recall bar + recalled-memory cards as the center `recall-area` of the home page (the slot 038a defines),
  visually the page's centerpiece.
- Preserve the exact recall behavior: `wire.recall(q)` POST to `/api/memories/recall`, `RecalledMemory` → `MemoryCard`
  render, the empty-state line, and the recall-summary note on the live feed.
- Carry over the PRD-029 lexical-fallback badge — shown only when the LAST recall ran degraded — into the center area's
  results header.
- Reuse the existing `Input` / `Button` / `MemoryCard` / `Badge` primitives and the existing recall state machine;
  restyle placement only.

## Non-Goals

- Rebuilding the recall engine, the `/api/memories/recall` endpoint, the wire schema, or the `MemoryCard` renderer —
  all exist (PRD-024 AC-3) and are reused unchanged.
- The full-page Memories experience (a dedicated recall page) — that is **PRD-040**. 038b is the home page's center
  recall area, an at-home centerpiece, not the full Memories page.
- Changing recall RANKING, the degraded/lexical-fallback DECISION, or the embeddings runtime — those are owned by the
  retrieval / embeddings Bees; 038b only relocates the UI and shows the badge the engine already returns.
- The KPI band (038a) and the harness area (038c).
- Any new token, new primitive, or a new card variant.

## User Stories

- As a local dogfooder, I want the recall bar front-and-center so searching my team's memory is the obvious primary
  action on the home page.
- As a user, I want my recalled memories to render as cards with their score / scope / verified / source, exactly as
  today, just in a more prominent place.
- As a user, I want to know when a recall fell back to lexical-only (embeddings off) so I can trust the ranking — the
  PRD-029 badge must still appear.

## Implementation Notes

- **Placement:** render `RecallBar` + the results list INTO the `recall-area` section 038a defines, as the home's
  center zone. The component tree is the existing one (app.tsx lines 405-430) moved into the area; the recall state
  (`query`, `results`, `recallBusy`, `recalled`, `recallDegraded`, `recallNonce`) and the `recall` callback
  (app.tsx lines 333-346) carry over unchanged.
- **Recall path (unchanged, app.tsx lines 333-346):** `wire.recall(q)` → `{ memories, degraded }`; `setResults`,
  `setRecalled(true)`, `setRecallDegraded(degraded)`, the `pushNote("recall …")` summary onto the live feed. The Enter
  key and the Recall button both fire (existing `RecallBar`).
- **Results render (unchanged, app.tsx lines 419-430):** map `results` → `<MemoryCard {...m} />` with the existing
  `.mem-enter` stagger; the empty-state line ("No memories matched that query.") when `recalled && results.length === 0`.
- **Lexical-fallback badge (PRD-029, unchanged, app.tsx lines 407-417):** when `recalled && recallDegraded`, render the
  `recall` eyebrow + `<LexicalFallbackBadge />` above the cards. The badge renders subsystem STATE only — no token / org /
  header (PRD-029 AC-5) — using the existing `Badge tone="warning"`.
- **Center styling:** the recall bar + results keep the existing `Input mono size="lg"` + primary `Button` treatment;
  the area may widen/center the column within the shared page-frame max-width (PRD-037 D-8). No new token; reuse the
  existing `Input` / `Button` / `MemoryCard` / `Badge` primitives.
- **Reuse, do not fork:** do not duplicate the recall state machine or the card renderer — move the existing JSX into
  the area. The wire client (`wire.recall`) and `MemoryCard` are imported, not re-implemented.

## Acceptance Criteria

- [ ] **AC-1 — Recall in the center area.** The recall bar + recalled-memory cards render inside the center
      `recall-area` (the 038a slot) as the home page's centerpiece. A DOM test asserts the recall bar and the results
      list are children of the recall-area landmark.
- [ ] **AC-2 — Recall works from the home page.** Submitting a query (Enter or the Recall button) POSTs
      `/api/memories/recall` via `wire.recall` and renders the returned hits as `MemoryCard`s; the empty-state line shows
      when there are no hits. Proven against a mocked wire client (a unit/DOM test) as PRD-024 AC-3 does.
- [ ] **AC-3 — MemoryCards render the hit shape.** Each card renders the `RecalledMemory` fields (snippet / score /
      scope / verified / source) via the existing `MemoryCard` — unchanged from PRD-024 / #39.
- [ ] **AC-4 — Lexical-fallback badge carries over.** When the recall response carried `degraded: true`, the PRD-029
      "lexical fallback" badge renders in the results header; when `degraded` is false, no badge renders. A test asserts
      both branches.
- [ ] **AC-5 — Reuse + tokens + no secret.** The area composes the existing `Input` / `Button` / `MemoryCard` / `Badge`
      primitives and only existing `var(--…)` tokens; no new token or card variant; no secret/token in any rendered card
      or badge. `npm run ci` passes and the recall DOM tests are updated for the new placement.

## Open Questions

- **OQ-1** — Should the center recall area show a resting placeholder/example state before the first recall (e.g. a hint
  or recent queries), or stay empty until the user searches as today? Proposed: keep today's behavior (empty until
  recalled); revisit if the centerpiece looks bare.
- **OQ-2** — Does the recall area get a surface/panel frame to read as the centerpiece, or stay a borderless centered
  column? Proposed: a light centered column within the page-frame max-width; confirm against brand.

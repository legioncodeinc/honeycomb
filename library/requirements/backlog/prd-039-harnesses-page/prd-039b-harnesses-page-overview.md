# PRD-039b: Harnesses Overview Page (KPI cards + installed/active matrix)

> **Status:** Backlog
> **Priority:** P1
> **Effort:** M
> **Parent:** [PRD-039 Harnesses Page](./prd-039-harnesses-page-index.md)

## Overview

This sub-PRD builds the **main Harnesses page** at the PRD-037 `#/harnesses` route. It is the fleet overview: a
per-harness KPI card for each of the six harnesses (turns captured, last-seen, status), plus a compact
installed/active matrix that lets an operator see the whole fleet at a glance. It renders entirely from the 039a
endpoint (`GET /api/diagnostics/harnesses`) — so it is dynamic by construction: an uninstalled harness shows as such,
and changing install/activity state changes the page with no code edit (parent AC-4).

It composes the existing design system only — the `Kpi` / `Badge` panels and `var(--…)` tokens already used across the
dashboard (`src/dashboard/web/panels.tsx`, `primitives.tsx`) — and hydrates through the existing wire-client pattern
(`src/dashboard/web/wire.ts`). No new DS, no CDN React, no secrets in the page (PRD-037 D-9 inherited).

## Goals

- Render a per-harness KPI card for all six harnesses: turns captured, last-seen (relative + absolute), and a status
  badge (installed/active, installed/idle, not installed).
- Render an installed/active matrix across the six harnesses so the whole fleet's state reads at a glance.
- Be fully dynamic off the 039a endpoint — no hardcoded harness list in the page, honest rendering of uninstalled
  harnesses (greyed / "not installed", not omitted, not faked).
- Provide the entry point into each per-harness sub-page (039c): a card / row click routes to `#/harnesses/<name>`.

## Non-Goals

- The data endpoint (that is 039a). This page is a pure consumer.
- The per-harness detail content + live stream + capability panels (that is 039c). This page links INTO them.
- The nav shell / sidebar / registry plumbing (PRD-037). This page is the content mounted at the `#/harnesses` slot.
- New per-harness metrics beyond what 039a returns (richer metrics are parent OQ-3 / a fast-follow).

## User Stories

- As an operator, I open Harnesses and immediately see which of my six harnesses are wired, which are actively
  capturing, when each last sent a turn, and how many turns each has contributed.
- As an operator, I notice Codex is "installed, idle, 0 turns" and Cursor is "active, last seen 4m ago, 312 turns", and
  I click Cursor to drill into its detail page.
- As a new user, I see five harnesses greyed as "not installed" and `claude-code` active — an honest picture, not five
  blank or fabricated cards.

## Layout

- **KPI card grid** — one card per harness (six cards), each showing:
  - harness name + its colour dot (the `AGENT_DOT` language, extended to all six — parent OQ-4),
  - a `Kpi` for `turnsCaptured`,
  - last-seen (relative "4m ago" + absolute on hover) or "never",
  - a status `Badge`: `active` (honey/verified) · `idle` (installed but 0 turns) · `not installed` (greyed).
- **Installed/active matrix** — a compact six-row table: harness · installed (✓/—) · active (✓/—) · last-seen ·
  turns — the at-a-glance fleet state.
- **Empty/zero states** — a harness with no activity shows "never" + 0, not a blank; an uninstalled harness is greyed
  with a "not installed" badge. If the endpoint is unreachable, the shell-level ConnectivityBanner (PRD-037 D-5)
  covers it — this page does not re-implement connectivity.

## Implementation Notes

- **Data.** Hydrate once from `GET /api/diagnostics/harnesses` via the wire client; map the six `HarnessStatus` rows
  onto cards + matrix rows. No client-side storage query; no second source.
- **Status derivation.** `not installed` when `!installed`; else `active` when `active` (i.e. `turnsCaptured > 0`);
  else `idle`. Mirror 039a's `active` flag rather than re-deriving from `turnsCaptured` to stay consistent (parent D-3).
- **Colour language.** Reuse `AGENT_DOT`; extend it to cover `hermes` + `pi` so dots and the page agree (parent OQ-4) —
  done in the shared map so the Sessions panel benefits too.
- **Routing in.** Each card / matrix row links to the 039c detail route `#/harnesses/<name>` via the PRD-037 router;
  the per-harness entries are the 037c DYNAMIC registry entries resolved from 039a's live list (parent D-6).
- **Reuse.** `Kpi` / `Badge` primitives, `var(--…)` tokens, the wire-client hydration/polling pattern — no new
  primitive unless a status badge variant is genuinely missing.

## Acceptance Criteria

- [ ] **b-AC-1 — Six cards from live data.** `#/harnesses` renders one KPI card per harness for all six, hydrated from
  `GET /api/diagnostics/harnesses` — not a hardcoded list — each showing turns captured, last-seen, and a status badge.
- [ ] **b-AC-2 — Installed/active matrix.** A compact matrix shows installed (✓/—), active (✓/—), last-seen, and turn
  count for all six harnesses at a glance, from the same endpoint.
- [ ] **b-AC-3 — Honest, dynamic states.** An uninstalled harness renders greyed as "not installed" (not omitted, not
  faked); an installed-but-idle harness reads "idle · 0 turns · never"; an active harness reads its real count +
  last-seen. Changing install/activity state changes the rendering with no code edit (proven by varying the mocked
  endpoint payload).
- [ ] **b-AC-4 — Drill-in.** Clicking a card / matrix row routes to that harness's `#/harnesses/<name>` detail page
  (039c) via the PRD-037 router.
- [ ] **b-AC-5 — DS-only + production-clean + secure.** Built only from existing DS tokens/primitives, bundled by the
  existing esbuild entry (no CDN React / no in-browser Babel), no token/secret in the page. A DOM/unit test asserts the
  six cards + matrix render from a fixture payload; `npm run ci` / `build` green.

## Open Questions

- **b-OQ-1** — Card grid vs single dense table as the PRIMARY layout? Lean: cards as the hero (scannable, brand-fitting)
  with the matrix as a compact secondary at-a-glance — confirm against the brand during build.
- **b-OQ-2** — Should the page poll the endpoint on an interval (live-updating last-seen) or hydrate once per route
  visit? Lean: hydrate on visit + a light refresh, matching the existing wire-client cadence; revisit if "live" is
  wanted.
- **b-OQ-3** — Do we show a fleet-summary header KPI (e.g. "4 / 6 active", total turns across harnesses)? Cheap from
  the same payload; flagged as a nice-to-have.

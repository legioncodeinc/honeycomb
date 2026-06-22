# PRD-038: Dashboard Home (the zoned home page inside the nav shell)

> **Status:** Backlog
> **Priority:** P1
> **Effort:** L
> **Owner:** `/the-smoker`

## Overview

PRD-037 turns the single-scroll `/dashboard` into a left-nav app shell and lifts the current monolithic
`src/dashboard/web/app.tsx` body wholesale onto the **Dashboard** route (`#/`) verbatim (037 D-6: move-then-reorganize).
This PRD is the reorganization of that home page. Today everything — header, KPI row, subsystem health strip, recall
bar, recalled-memory cards, the 2-col grid (Sessions/Rules | Graph/Settings/Skill-sync), and the live log — is one long
vertical stack inside a single `.wrap` (`app.tsx` lines 389-451). Even inside the shell, the Dashboard route is still a
long scroll; seeing harness activity means scrolling past everything.

PRD-038 re-lays the Dashboard home into clear, named **AREAS** so it reads as zones, not a scroll:

1. a **top KPI band** — the four headline metrics (Memories, Turns, Est. savings, Team skills) as a clean band right
   under the shell chrome;
2. a **recall area** in the center — the recall bar + recalled-memory cards as the visual centerpiece;
3. a **harness area** — an at-a-glance strip showing which harnesses honeycomb is wired into (the installed/active ones
   of claude-code, codex, cursor, hermes, pi, openclaw), a short-tail **live stream** of those harnesses' recent
   activity (reusing the existing `/api/logs` feed), and per-harness KPI tiles that load **dynamically** based on what
   is installed.

This PRD owns ONLY the Dashboard home page's content + layout. It does NOT own the shell, the sidebar, the router, the
route registry (all PRD-037), nor the other six routed pages (PRDs 039-044). It consumes the data fixes from PRD-035
(the Turns rename, the real Est. savings) and PRD-036c (the corrected Team skills KPI), and it surfaces a thin slice of
the harness registry/telemetry whose deep analytics + per-harness sub-pages are **PRD-039** — 038 references PRD-039 as
the data source and keeps its own scope to the home strip.

All of this reuses the EXISTING Honeycomb design system — the `var(--…)` tokens served in `/dashboard/styles.css` and
the ported primitives/panels in `src/dashboard/web/{primitives,panels}.tsx`. No new design system, no CDN React, no
in-browser Babel; the page is bundled production-clean by the same esbuild entry (PRD-024 D-1, inherited via PRD-037).

## Goals

- Re-lay the Dashboard home page (`#/`) into three named AREAS — a top KPI band, a center recall area, a harness area —
  so the page reads as zones with far less scrolling than today's single stack.
- Keep the existing four headline KPIs (Memories, Turns, Est. savings, Team skills) intact and correct, anchored in a
  defined top band rather than a mid-page row.
- Keep recall fully working from the home page (the same `/api/memories/recall` POST + MemoryCard rendering, including
  the PRD-029 lexical-fallback badge), restyled as the center area.
- Add a harness area that surfaces (a) which harnesses honeycomb is wired into, (b) a short-tail live stream of those
  harnesses' activity from `/api/logs`, and (c) per-harness KPI tiles rendered dynamically from what is installed.
- Reuse the existing wire client (`src/dashboard/web/wire.ts`), panels, and primitives — compose, do not fork.

## Non-Goals

- The shell, sidebar, client-side router, route registry, shared page-frame, or shell-level connectivity banner — all
  owned by **PRD-037**. This page mounts inside that shell and inherits its hydration/polling pattern and daemon-down
  handling.
- The other six routed pages (Harnesses, Memories, Graph, Sync, Logs, Settings) — PRDs 039-044. The home's harness area
  is an at-a-glance STRIP, not the full Harnesses page (PRD-039) and not the full Logs page (PRD-043).
- Deep per-harness analytics, per-harness sub-pages, and the harness registry/telemetry data model itself — **PRD-039**.
  038 reads that registry/telemetry as a data source and renders only the home surfacing.
- The underlying data fixes themselves — the Turns rename and real Est. savings are **PRD-035** (035a / 035b); the
  corrected Team skills count is **PRD-036c**. 038 consumes their results; it does not re-derive them.
- Any new daemon route, new design token, new color ramp, or new build/bundling story. The page composes existing
  endpoints, tokens, and primitives only.
- Any change to the LOCAL-MODE-ONLY + XSS-safe + no-secret-in-page security posture (PRD-021d F-1 / PRD-024 D-4),
  inherited unchanged through the shell.

## Features

| Sub-PRD | Feature | Status |
|---|---|---|
| [prd-038a-dashboard-home-kpi-band](./prd-038a-dashboard-home-kpi-band.md) | KPI areas regroup — top KPI band + the three-zone area structure | Draft |
| [prd-038b-dashboard-home-recall-center](./prd-038b-dashboard-home-recall-center.md) | Memory search — the recall bar + results as the center area | Draft |
| [prd-038c-dashboard-home-harness-strip](./prd-038c-dashboard-home-harness-strip.md) | Harnesses wired + live stream + per-harness KPI tiles (dynamic) | Draft |

## Acceptance Criteria

- [ ] **AC-1 — The home reads as zones.** The Dashboard route (`#/`) renders as three clearly-delineated AREAS — a top
      KPI band, a center recall area, and a harness area — rather than one undifferentiated vertical scroll. A DOM/unit
      test asserts the three area landmarks are present and ordered. (038a)
- [ ] **AC-2 — KPIs sit in a defined top band.** The four headline KPIs (Memories, Turns, Est. savings, Team skills)
      render in the top band, using the corrected values from PRD-035 (Turns label/count, real Est. savings) and
      PRD-036c (Team skills) — no mislabeled "Sessions", no hardcoded `0 tok` savings. (038a)
- [ ] **AC-3 — Recall works from the center.** The recall bar POSTs `/api/memories/recall` via the wire client and
      renders the hits as MemoryCards in the center area; the PRD-029 lexical-fallback badge still shows when the recall
      ran degraded; empty/zero states are honored. (038b)
- [ ] **AC-4 — Installed harnesses shown.** The harness area shows which harnesses honeycomb is currently wired into
      (the installed/active subset of claude-code, codex, cursor, hermes, pi, openclaw), sourced from the PRD-039
      registry/telemetry; a harness that is not installed does not render a tile. (038c)
- [ ] **AC-5 — Short-tail live stream.** The harness area renders a short-tail live stream of those harnesses' recent
      activity, reusing the existing `/api/logs` feed (scoped/labeled by harness where the record allows), distinct from
      the full Logs page (PRD-043); no secret/token appears in any line. (038c)
- [ ] **AC-6 — Dynamic per-harness KPI tiles.** Per-harness KPI tiles (e.g. turns-captured, last-seen) render
      DYNAMICALLY based on what is installed — adding/removing a harness changes which tiles appear, with no hardcoded
      harness list in the render path. (038c)
- [ ] **AC-7 — Reuse, no fork; gate green.** The page reuses the existing wire client, panels, and primitives and
      composes only existing `var(--…)` tokens — no new design system, no CDN React, no in-browser Babel. `npm run ci`
      (typecheck + jscpd + vitest) passes; the PRD-024/035 DOM tests are updated for the new layout and still assert the
      structure renders.
- [ ] **AC-8 — Security posture inherited.** The home page stays LOCAL-MODE-ONLY + XSS-safe; no token/secret appears in
      the KPI band, the recall results, the harness tiles, or the live-stream lines (grep-proven). No new daemon route
      or secret is introduced; `audit:openclaw` / `audit:sql` stay green.

## Decisions

- **D-1 — Three named areas, not a re-stack.** The home page is composed from three explicit area landmarks — `kpi-band`,
  `recall-area`, `harness-area` — each a labeled section, not just CSS spacing. This is the structural contract AC-1
  tests against and the seam 038a/038b/038c slot into. The areas reduce scrolling by grouping concerns; they do NOT
  introduce tabs or a second router (routing is PRD-037's shell concern).
- **D-2 — Consume the data fixes; do not re-derive.** The KPI band renders the values produced by PRD-035 (Turns,
  Est. savings) and PRD-036c (Team skills). 038 is a layout/surfacing change; if a fix has not landed, the band still
  renders the KPI with whatever the wire returns (it never reintroduces the old mislabel or the `0` stub itself).
- **D-3 — Recall is moved, not rebuilt.** The center recall area reuses the EXISTING recall path verbatim — the
  `wire.recall(q)` POST to `/api/memories/recall`, the `RecalledMemory` → `MemoryCard` render, the `recallDegraded` →
  lexical-fallback badge (PRD-029), and the empty-state line. 038b restyles WHERE/how it sits, not what it does.
- **D-4 — The harness strip reuses `/api/logs`; no new feed.** The short-tail live stream reads the SAME `/api/logs`
  ring-buffer feed the current Live log already polls (`src/daemon/runtime/logs/api.ts` — JSON snapshot + the SSE
  `/stream` follow), labeled/scoped by harness where a record carries that signal. 038 adds NO new daemon route; the
  deep, full-page log experience remains PRD-043 and the harness telemetry source remains PRD-039.
- **D-5 — Per-harness tiles render from live install state (no hardcoded list).** The per-harness KPI tiles are produced
  by mapping over the installed-harness set resolved at render from the PRD-039 registry/telemetry — exactly the
  "dynamically-loaded (per-install) entry" pattern PRD-037's registry contract (037c, D-7) anticipates. There is no
  literal six-harness array in the render path; an uninstalled harness yields no tile (AC-4/AC-6).
- **D-6 — Inherit the shell's hydration, polling, and connectivity.** The page is a content component inside the
  PRD-037 shell. It uses the shell's wire-client hydration/polling pattern and the shell-level `/health` daemon-down
  swap (PRD-037 D-5); it does NOT re-implement the ConnectivityBanner or its own health poll.
- **D-7 — Security posture inherited, unchanged.** No new daemon route, no new secret, XSS-safe, LOCAL-MODE-ONLY. The
  KPI band, recall results, harness tiles, and live-stream lines render STATE/labels only — never a token, header, org
  GUID-as-secret, or request body. `audit:openclaw` / `audit:sql` stay green by construction (no new daemon surface).

## Open Questions

- **OQ-1** — Does the harness "wired-in" set come from a dedicated PRD-039 telemetry endpoint, or is it inferred at the
  home page from the `agent`/source signal already present on log/session rows until PRD-039's endpoint lands? (038c
  proposes inferring from existing signal as a fallback so the home strip works before PRD-039 ships its endpoint;
  confirm with PRD-039.)
- **OQ-2** — Which per-harness KPIs belong on the at-a-glance home tile vs the full PRD-039 Harnesses page? 038c proposes
  the minimal pair (turns-captured, last-seen); deeper metrics (recall hits attributable, skills mined) live on PRD-039.
- **OQ-3** — Should the center recall area and the harness area sit side-by-side on wide monitors or stack vertically
  with the harness area below recall? Proposed: recall full-width center, harness area below; revisit against the brand.
- **OQ-4** — How long is "short-tail" for the live stream (line count / time window), and does it reuse the JSON
  `/api/logs?limit=` snapshot poll or the SSE `/api/logs/stream` follow? Proposed: the same bounded snapshot poll the
  current Live log uses, capped tighter; flagged for 038c.

## Related

- **Parent shell / house style:** PRD-037 Dashboard Nav Shell — `library/requirements/backlog/prd-037-dashboard-nav-shell/prd-037-dashboard-nav-shell-index.md` (this page is the Dashboard `#/` route's content; inherits D-1 production-clean bundle, D-5 shell-level connectivity, D-7 registry / dynamic-entry contract).
- **Prior art:** PRD-024 Dashboard UI Parity — `library/requirements/in-work/prd-024-dashboard-ui-parity/prd-024-dashboard-ui-parity-index.md` (the live brand dashboard + the current single-page `app.tsx` body 038 reorganizes).
- **Consumed data fixes:** PRD-035 Dashboard Data Fixes — `library/requirements/backlog/prd-035-dashboard-data-fixes/` (035a Turns rename, 035b real Est. savings). PRD-036c — `library/requirements/backlog/prd-036-skill-asset-discovery/prd-036c-skill-asset-discovery-kpi-correctness.md` (corrected Team skills KPI).
- **Data source for the harness area:** PRD-039 (Harnesses page) — the harness registry + telemetry + deep per-harness sub-pages; 038c surfaces a thin home slice of it.
- **Source touched:** `src/dashboard/web/app.tsx` (the home content reorganized into areas — or a `dashboard-page.tsx` per PRD-037's shell split), `src/dashboard/web/panels.tsx` + `src/dashboard/web/primitives.tsx` (reused: `Kpi`, `MemoryCard`, `Panel`, `Badge`, `LiveLog`), `src/dashboard/web/wire.ts` (reused hydration: `kpis`, `recall`, `logs`), `src/daemon/runtime/dashboard/api.ts` (`fetchKpisView`, read-only), `src/daemon/runtime/logs/api.ts` (`/api/logs` feed, reused).

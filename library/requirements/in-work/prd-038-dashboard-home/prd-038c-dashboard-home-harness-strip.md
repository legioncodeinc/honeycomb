# PRD-038c: Harnesses wired + live stream + per-harness KPI tiles (dynamic)

> **Parent:** [PRD-038 Dashboard Home](./prd-038-dashboard-home-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** L

## Overview

This sub-PRD adds the home page's **harness area** — the third zone 038a defines, below the center recall area. It
answers three at-a-glance questions for a dogfooder: *which harnesses is honeycomb wired into?*, *what are they doing
right now?*, and *how much has each captured?* Concretely it renders:

1. a **wired-in strip** — the installed/active subset of the six supported harnesses (claude-code, codex, cursor,
   hermes, pi, openclaw);
2. a **short-tail live stream** of those harnesses' recent activity/output, reusing the EXISTING `/api/logs` feed
   (`src/daemon/runtime/logs/api.ts`) the current Live log already consumes, labeled/scoped by harness where a record
   carries that signal;
3. **per-harness KPI tiles** (e.g. turns-captured, last-seen) that render **DYNAMICALLY** based on what is installed —
   no hardcoded harness list in the render path.

This is the home page's at-a-glance harness STRIP only. The deep harness analytics, per-harness sub-pages, and the
harness registry/telemetry data model are **PRD-039** (the Harnesses page, `#/harnesses`). 038c DEPENDS ON PRD-039's
registry/telemetry as its data source and keeps its own scope to the home surfacing. It reuses the existing wire client,
the `/api/logs` feed, and the existing `Panel` / `Badge` / `Kpi` primitives; no new daemon route, no new design system.

## Goals

- Render a wired-in harness strip on the home page showing which of the six harnesses (claude-code, codex, cursor,
  hermes, pi, openclaw) honeycomb is currently added to (installed/active only).
- Render a short-tail live stream of those harnesses' recent activity, reusing the existing `/api/logs` feed, labeled by
  harness where the record allows, visually distinct from (and shorter than) the full Logs page (PRD-043).
- Render per-harness KPI tiles (turns-captured, last-seen) DYNAMICALLY by mapping over the installed-harness set
  resolved at render — no literal six-harness array in the render path.
- Source the installed set + per-harness telemetry from the PRD-039 registry/telemetry (with a documented fallback to
  existing log/session signal until PRD-039's endpoint lands — OQ-1).
- Reuse the existing `Panel` / `Badge` / `Kpi` primitives, the wire client, and the `/api/logs` feed — compose, no fork.

## Non-Goals

- The full Harnesses page (`#/harnesses`), deep per-harness analytics, per-harness sub-pages, and the harness
  registry/telemetry data model + endpoint — all **PRD-039**. 038c is the at-a-glance home strip and a CONSUMER of that
  data source.
- The full-page live-log experience (`#/logs`) — **PRD-043**. 038c's stream is a short tail on the home page, reusing
  the same `/api/logs` feed, not the full Logs page.
- Adding a new daemon route or a new feed. The live stream reuses `/api/logs` (JSON snapshot + SSE `/stream`); the
  harness telemetry comes from PRD-039's source, not a route 038c invents.
- The KPI band (038a) and the recall area (038b).
- Wiring/installing harnesses, capability detection, or the install adapters (`src/cli/install-*.ts`) — that is the
  harness-integration domain; 038c only READS which harnesses are installed and SURFACES them.
- Any new design system, token, color ramp, or `Kpi` / `Panel` / `Badge` variant.

## User Stories

- As a local dogfooder, I want to see at a glance which coding assistants honeycomb is wired into, so I know my setup
  is actually capturing from the harnesses I use.
- As a user, I want a short live tail of harness activity on the home page so I can confirm capture is happening right
  now without opening the full Logs page.
- As a user with only some harnesses installed, I want per-harness tiles that reflect EXACTLY what I have installed —
  no empty tiles for harnesses I never set up.
- As a user, I want each harness's turns-captured and last-seen so I can tell which assistant is feeding the most memory.

## Implementation Notes

- **Placement:** render the harness area INTO the `harness-area` section 038a defines, below the recall area. The area
  is one component (e.g. `HarnessStrip`) composing three parts: the wired-in chips, the short-tail live stream, and the
  per-harness KPI tiles.
- **Installed-harness set (D-5 of parent):** resolve the installed/active harnesses at render from the PRD-039
  registry/telemetry source. Map over that resolved set to produce chips + tiles — there is NO literal
  `["claude-code","codex",…]` array in the render path (an uninstalled harness yields no chip/tile). This is exactly the
  "dynamically-loaded (per-install) entry" pattern PRD-037's registry contract (037c, D-7) anticipates.
- **Fallback source (OQ-1):** until PRD-039 ships a dedicated telemetry endpoint, infer the installed set + last-seen
  from the harness/agent signal already present on log/session rows (the panels already key agent dots off a harness
  field — see `AGENT_DOT` in `panels.tsx` lines 65-70: `cursor` / `claude-code` / `codex` / `openclaw`). Document the
  fallback so the home strip works before PRD-039's endpoint lands; switch to the endpoint when it exists.
- **Wired-in strip:** one `Badge`/chip per installed harness (mono, dot), labeled with the harness name and an
  active/idle tone from last-seen recency. Reuse the existing `Badge` primitive (primitives.tsx) — no new chip.
- **Short-tail live stream (D-4 of parent):** read the SAME `/api/logs` feed the current Live log polls
  (`src/daemon/runtime/logs/api.ts` — `GET /api/logs?limit=` JSON snapshot, or the SSE `GET /api/logs/stream` follow),
  via the existing `wire.logs(...)` client. Filter/label lines by harness where the record carries that signal; cap the
  tail short (OQ-4). Reuse the existing `LiveLog` panel (panels.tsx lines 291-315) or a tighter variant of it. The
  records are `RequestLogRecord`s verbatim — method/path/status/mode/org, NO header/token/body (logs/api.ts) — so no
  secret can leak.
- **Per-harness KPI tiles:** for each installed harness, a small tile (reuse the `Kpi` primitive or a compact
  `Panel`-framed cell) showing turns-captured + last-seen. The metrics come from PRD-039 telemetry (or the OQ-1
  fallback aggregation over session/log rows). Tiles are produced by `installedHarnesses.map(...)` — dynamic by
  construction.
- **Reuse, do not fork:** compose `Panel` / `Badge` / `Kpi` (primitives/panels) and the existing `wire.logs` path; do
  not add a new daemon route or a new feed.

## Acceptance Criteria

- [ ] **AC-1 — Wired-in harnesses shown.** The harness area shows which harnesses honeycomb is wired into — the
      installed/active subset of {claude-code, codex, cursor, hermes, pi, openclaw} — sourced from the PRD-039
      registry/telemetry (or the OQ-1 fallback). A harness that is not installed renders no chip. A DOM test asserts the
      chips reflect the resolved installed set.
- [ ] **AC-2 — Short-tail live stream.** The harness area renders a short-tail live stream of those harnesses' recent
      activity, reusing the existing `/api/logs` feed (no new daemon route), labeled by harness where the record allows,
      and capped shorter than the full Logs page. A test drives a mocked `wire.logs` and asserts the tail renders.
- [ ] **AC-3 — Dynamic per-harness KPI tiles.** Per-harness KPI tiles (turns-captured, last-seen) render by mapping over
      the resolved installed-harness set — adding/removing a harness changes which tiles appear, and there is NO
      hardcoded harness list in the render path. A test asserts a given installed set yields exactly that set of tiles.
- [ ] **AC-4 — At-a-glance scope, not the deep page.** The strip is the home at-a-glance surface, distinct from the
      full Harnesses page (PRD-039) and the full Logs page (PRD-043); it adds no new daemon route and pulls deep
      telemetry from PRD-039's source rather than re-implementing it.
- [ ] **AC-5 — Reuse + tokens + no secret.** The area composes the existing `Panel` / `Badge` / `Kpi` primitives and the
      existing `wire.logs` feed, using only existing `var(--…)` tokens; no new token, variant, or daemon route; no
      secret/token appears in any chip, tile, or live-stream line (grep-proven, as the logs feed carries none).
      `npm run ci` passes; `audit:openclaw` / `audit:sql` stay green.

## Open Questions

- **OQ-1** — Does the installed-harness set + per-harness telemetry come from a dedicated PRD-039 endpoint, or is it
  inferred at the home page from the harness/agent signal already on log/session rows until that endpoint lands?
  Proposed: infer from existing signal as a fallback so the home strip works pre-PRD-039, then switch to the endpoint.
  CONFIRM the contract with PRD-039.
- **OQ-2** — Which per-harness KPIs belong on the at-a-glance home tile vs the full PRD-039 page? Proposed: the minimal
  pair (turns-captured, last-seen) on the home; deeper metrics (recall hits attributable, skills mined) on PRD-039.
- **OQ-3** — Can every `/api/logs` record be attributed to a specific harness, or only some? If the request log does not
  carry a harness/agent field on every line, the stream labels what it can and shows the rest as unattributed. Flag the
  record shape for PRD-039 / the logger.
- **OQ-4** — How short is "short-tail" (line count / time window), and does the stream use the JSON `/api/logs?limit=`
  snapshot poll or the SSE `/api/logs/stream` follow? Proposed: the bounded snapshot poll the current Live log uses,
  capped tighter (fewer lines); revisit if a live SSE tail feels better on the home page.
- **OQ-5** — Should the per-harness tiles and the wired-in chips be one combined row (chip + its mini-KPIs together) or
  two separate sub-sections (a chip strip, then a tile grid)? Proposed: combined per-harness cells so each harness's
  identity + metrics read together; confirm against brand.

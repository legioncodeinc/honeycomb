# PRD-039: Harnesses Page (the six-harness fleet view)

> **Status:** Backlog
> **Priority:** P1
> **Effort:** L
> **Owner:** `/the-smoker`

## Overview

Honeycomb captures from SIX coding harnesses — `claude-code`, `codex`, `cursor`, `hermes`, `pi`, and `openclaw`
(the canonical set rendered by `src/daemon/runtime/services/harness-sync.ts` and the per-harness shims under
`src/hooks/<harness>/shim.ts`). Today the live dashboard exposes almost nothing harness-aware: the only signal is the
session-row dot, where `src/dashboard/web/panels.tsx` colours each captured turn by its `agent` column via `AGENT_DOT`
(and that map only keys four of the six). There is no view that answers "which harnesses are wired?", "which are
actually capturing?", "when did Cursor last send a turn?", or "how many turns has Codex contributed?". As the nav
shell (PRD-037) opens a dedicated **Harnesses** destination at `#/harnesses`, that page is currently an empty frame.

This PRD fills it. It builds the data backbone, the overview page, and the per-harness detail sub-pages:

1. **A harness registry + last-seen telemetry endpoint** (039a) — the daemon's single source of truth for which of the
   six harnesses are *installed* (wired via the harness-sync targets / hooks) and *active* (derived from real capture
   activity), plus last-seen and turn-count per harness, grounded entirely in real signals.
2. **The Harnesses overview page** (039b) — per-harness KPI cards (turns captured, last-seen, status), an
   installed/active matrix across all six, and any other recordable metric — rendered dynamically so an uninstalled
   harness shows as such rather than being hidden or faked.
3. **Per-harness detail sub-pages** (039c) — a route per harness (e.g. `#/harnesses/cursor`) showing that harness's
   live activity stream (reusing the `/api/logs` SSE infra, filtered to the harness) plus its **harness-specific**
   capabilities — surfacing real divergences, e.g. Cursor's `cursor-agent` "agents" and `workspace_roots` where Claude
   Code has neither — via a capability-descriptor pattern, so each harness page renders only the features it has.

Everything reuses the existing Honeycomb design system (`var(--…)` tokens in `/dashboard/styles.css`, the primitives in
`src/dashboard/web/primitives.tsx`, the `Kpi`/`Badge` panels) and the production-clean esbuild bundle (PRD-024 D-1).
No new daemon route framework, no CDN React, no secrets in the page (PRD-037 D-9 inherited).

## Goals

- Give Honeycomb a first-class **fleet view** of all six harnesses: installed vs not, active vs idle, last-seen, and
  turns captured — every number grounded in a real signal, never fabricated (0 / "unknown" when there is no data).
- Stand up a single daemon endpoint (039a) that reports the per-harness registry + telemetry, shared by BOTH the
  Harnesses page (039b/039c) and PRD-038's home harness strip, so there is one source of truth.
- Render the overview page (039b) dynamically from that endpoint so adding/removing a harness install changes the page
  with no code edit, and an uninstalled harness is shown honestly (greyed/"not installed"), not omitted.
- Surface **harness-specific** capabilities on per-harness sub-pages (039c) via a capability-descriptor pattern, so
  the page reflects what each harness genuinely supports (Cursor agents, runtime path, context channel, host CLI),
  not a one-size template.
- Reuse the `/api/logs` SSE stream for each harness's live activity, filtered to that harness — no second log pipe.

## Non-Goals

- The nav shell, sidebar, router, and route registry — those are PRD-037 (037a/037b/037c). This PRD adds the Harnesses
  page content and its dynamic per-harness entries INTO that registry; it does not build the shell.
- The home Dashboard page or its harness strip layout — that is PRD-038. 039a is the shared data source PRD-038
  consumes; 039 does not own the home page.
- Changing the capture pipeline, the shims, the harness-sync renderer, or the `sessions` schema. 039 READS the signals
  those already produce (`sessions.agent`, harness-sync targets, hooks presence); it does not add a capture path.
- Adding a dedicated `harness` column to `sessions`. The harness identity is the existing `agent` column (e.g.
  `cursor`); 039a derives telemetry from it. A schema change, if ever wanted, is a separate deeplake-dataset PRD.
- Team/hybrid-mode exposure. The Harnesses page is served by the LOCAL-MODE-ONLY dashboard host (PRD-021d F-1 /
  PRD-037 D-9); it inherits that posture unchanged.
- Install / uninstall ACTIONS from the page (wiring a harness, running the installer). 039 is read-only diagnostics;
  install flows stay in the CLI install pipeline.

## Features

| Sub-PRD | Feature | Status |
|---|---|---|
| [prd-039a-harnesses-page-registry-telemetry](./prd-039a-harnesses-page-registry-telemetry.md) | Harness registry + last-seen telemetry endpoint (the data backbone) | Draft |
| [prd-039b-harnesses-page-overview](./prd-039b-harnesses-page-overview.md) | Harnesses overview page (KPI cards + installed/active matrix) | Draft |
| [prd-039c-harnesses-page-detail](./prd-039c-harnesses-page-detail.md) | Per-harness sub-pages + harness-specific capability descriptors | Draft |

## The six harnesses this page covers

The canonical set is fixed by `src/hooks/<harness>/shim.ts` + the harness-sync renderer; the page must cover all six,
even when a harness has zero capture activity.

| Harness (`agent`) | Shim | Runtime path | Host CLI | Notable harness-specific signal |
|---|---|---|---|---|
| `claude-code` | `src/hooks/claude-code/shim.ts` (REFERENCE) | `legacy` (hook scripts) | `claude -p` | Full six-event lifecycle (the baseline) |
| `codex` | `src/hooks/codex/shim.ts` | per shim | `codex exec …` | User-visible context channel (login line) |
| `cursor` | `src/hooks/cursor/shim.ts` | `plugin` (extension) | `cursor-agent` → `claude` fallback | **Agents** (`cursor-agent`), `workspace_roots`, `Shell` tool |
| `hermes` | `src/hooks/hermes/shim.ts` | per shim | `hermes` non-interactive | MCP server registration; user-visible `{ context }` |
| `pi` | `src/hooks/pi/shim.ts` | per shim | `pi --print …` | `AGENTS.md` context surface |
| `openclaw` | `src/hooks/openclaw/shim.ts` | per shim | per shim | Contracted tools; ClawHub-scanned bundle |

## Acceptance Criteria

- [ ] **AC-1 — All six, always.** The Harnesses page and the 039a endpoint report ALL SIX harnesses
  (`claude-code`, `codex`, `cursor`, `hermes`, `pi`, `openclaw`) every time — a harness with zero activity appears as
  not-installed / inactive with a 0 turn-count, never omitted and never faked.
- [ ] **AC-2 — Real signals only.** Every per-harness field (`installed`, `active`, `lastSeen`, `turnsCaptured`) is
  derived from a real signal: install/wiring from the harness-sync targets / hooks presence, and activity from the
  `sessions` table grouped by `agent` (and/or the request log). Where there is no signal the value is `0` / `unknown`,
  never a placeholder metric. A test asserts no fabricated values.
- [ ] **AC-3 — One data source, two consumers.** The 039a endpoint is the SINGLE source the Harnesses page (039b/039c)
  AND PRD-038's home harness strip read. Neither consumer re-queries `sessions` for harness telemetry directly.
- [ ] **AC-4 — Overview page dynamic.** `#/harnesses` renders per-harness KPI cards + an installed/active matrix from
  the live endpoint, on existing DS tokens/primitives. Toggling a harness's install state (or its capture activity)
  changes the page with no code change; an uninstalled harness renders as such.
- [ ] **AC-5 — Per-harness sub-page + live stream.** Clicking a harness opens its detail route
  (e.g. `#/harnesses/cursor`) showing that harness's live activity via the `/api/logs` SSE stream filtered to it,
  plus its specific capability panels. A harness lacking a given capability simply omits that panel.
- [ ] **AC-6 — Harness-specific capabilities are real.** The capability descriptors reflect actual divergences from
  the shims (e.g. Cursor surfaces `cursor-agent` agents + `workspace_roots`; Claude Code surfaces its full six-event
  lifecycle and shows no agents panel). The descriptor set is data-driven, not a fixed template duplicated per harness.
- [ ] **AC-7 — Registered in the shell.** The page mounts inside the PRD-037 nav shell at the `#/harnesses` slot, and
  its per-harness entries use the 037c DYNAMIC registry contract resolved from the 039a live data (PRD-037 OQ-3 answer:
  039a IS the data source).
- [ ] **AC-8 — Security + gate unchanged.** The page and endpoint stay LOCAL-MODE-ONLY + XSS-safe; no token/secret in
  the page, the endpoint response, the per-harness routes, or the streamed log lines (grep-proven, per logs/api.ts
  no-secret guarantee). `npm run ci` / `build` / `audit:sql` / `audit:openclaw` / invariant all green.

## Decisions

- **D-1 — Harness identity is the `sessions.agent` column, not a new column.** Each captured turn already stamps the
  harness as its `agent` (e.g. `cursor`, `claude-code`), the same value `AGENT_DOT` keys in `panels.tsx`. 039a derives
  `lastSeen` + `turnsCaptured` from `MAX(creation_date)` / `COUNT(*)` GROUP BY `agent` over `sessions`. No
  `sessions`-schema change (that would be a deeplake-dataset PRD).
- **D-2 — "Installed" ≠ "active".** *Installed/wired* is structural: the harness has hooks + identity targets present
  (the harness-sync `HarnessTarget` set / install pipeline), independent of whether it has ever captured. *Active /
  last-seen* is behavioural: it has at least one captured turn, derived from `sessions`. The page shows BOTH so a
  freshly-wired-but-never-run harness reads "installed, inactive", and a harness with turns but no current wiring reads
  honestly too.
- **D-3 — 039a is the single backbone; 038 + 039 are consumers.** The endpoint is built once (039a) and read by the
  Harnesses page (039b/039c) and PRD-038's home strip. This is the PRD-037 OQ-3 resolution: the dynamic registry
  resolves per-harness items from THIS endpoint rather than each surface re-querying storage.
- **D-4 — Reuse `/api/logs` SSE, filtered — no second log pipe.** The per-harness live stream (039c) consumes the
  existing `GET /api/logs/stream` (`src/daemon/runtime/logs/api.ts`) and filters to the harness client-side (or via a
  query param if a server filter is warranted — see OQ-2). The logs records carry NO secret by construction
  (logger.ts), so the filtered stream inherits that guarantee.
- **D-5 — Capability descriptors, not per-harness templates.** Each harness's specific features (Cursor agents,
  runtime path, context channel, host CLI, MCP registration) are expressed as a data-driven capability descriptor; the
  detail page renders the panels a harness's descriptor declares and omits the rest. Adding a harness capability is a
  descriptor entry, not a new bespoke page (mirrors the shim "thin override, not a fork" thesis in `contracts.ts`).
- **D-6 — Dynamic registry entries, static top-level route.** The `#/harnesses` route itself is a static PRD-037
  registry entry; the per-harness sub-entries (`#/harnesses/<name>`) are the DYNAMIC entries (037c contract), resolved
  at render from 039a's live data — so the six (or fewer installed) harness items appear without hardcoding.
- **D-7 — Security posture inherited, unchanged.** Page + endpoint served only in `mode === "local"`, XSS-safe, no
  token/secret anywhere in the response or page (PRD-021d F-1 / PRD-037 D-9). 039a adds a read-only diagnostics
  endpoint under the existing protected group pattern (mirrors `mountDashboardApi` / `mountLogsApi`); no new secret
  surface, so `audit:sql` / `audit:openclaw` stay green by construction.

## Open Questions

- **OQ-1** — Should "installed" detection read the LIVE on-disk hooks/identity targets (authoritative but does file
  I/O per request) or a cached registry the daemon already holds? 039a proposes the daemon's known harness-sync target
  set + a cheap presence check; confirm the source of truth during 039a build.
- **OQ-2** — Should the per-harness log filter be CLIENT-side (filter the existing `/api/logs/stream` records by
  harness) or SERVER-side (a `?harness=` query param on the stream)? The request log records do not currently carry the
  harness tag (logs/api.ts records method/path/status, not `agent`), so a server filter may need a small record-shape
  addition — flagged for 039c. Client-side over `sessions`-derived activity is the fallback.
- **OQ-3** — Beyond turns/last-seen, which additional per-harness metrics are worth recording (e.g. tool-call counts,
  summary success rate, fallback-CLI invocations)? 039b lists the readily-available ones; the richer metrics are a
  fast-follow once the backbone (039a) lands.
- **OQ-4** — `AGENT_DOT` in `panels.tsx` only keys four harnesses; should 039 extend it to all six (hermes, pi) as part
  of the shared colour language, or own its own harness palette? Lean: extend the shared map so dots + the Harnesses
  page agree.

## Related

- **Hosting shell (this page mounts inside it):** PRD-037 Dashboard Nav Shell —
  `library/requirements/backlog/prd-037-dashboard-nav-shell/prd-037-dashboard-nav-shell-index.md`
  (the `#/harnesses` slot, the 037c dynamic registry contract, OQ-3 which this PRD answers).
- **Home-strip consumer (shares 039a's data source):** PRD-038 Dashboard home reorg (the home harness strip reads the
  039a registry/telemetry endpoint — D-3).
- **Prior art / house style:** PRD-024 Dashboard UI Parity —
  `library/requirements/in-work/prd-024-dashboard-ui-parity/prd-024-dashboard-ui-parity-index.md`
  (production-clean bundle D-1, security D-4, connectivity AC-5).
- **Source grounding the harness model:** `src/daemon/runtime/services/harness-sync.ts` (harness targets + the six
  names), `src/hooks/<harness>/shim.ts` (per-harness shims = capture entry points; Cursor's `cursor-agent` agents),
  `src/hooks/contracts.ts` (the shim "thin override" thesis + `HostCli` / `ContextChannel` / `RuntimePath`),
  `src/daemon/storage/catalog/sessions-summaries.ts` (the `sessions` table; `agent` column = harness),
  `src/daemon/runtime/dashboard/api.ts` (the `mountDashboardApi` attach-seam pattern 039a mirrors),
  `src/daemon/runtime/logs/api.ts` (the `/api/logs` + `/api/logs/stream` SSE the per-harness stream reuses),
  `src/dashboard/web/panels.tsx` (`AGENT_DOT` — the existing per-harness colour keying).

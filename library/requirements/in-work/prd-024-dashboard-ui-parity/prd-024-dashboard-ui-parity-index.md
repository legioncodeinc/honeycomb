# PRD-024 — Dashboard UI Parity (the brand dashboard, live)

> Status: backlog · Owner: `/the-smoker` · Type: M (feature)
> Goal: the daemon-served `GET /dashboard` (127.0.0.1:3850, local mode) LOOKS like `assets/ui_kits/dashboard/`
> and FUNCTIONS as that UI kit specs — wired to the daemon's real data + a real "Dream now" trigger.

## Why
The live `/dashboard` (PRD-021d host) renders a plain server-side page. The design team shipped a
brand-elevated UI kit at `assets/ui_kits/dashboard/` (`index.html` + `components.jsx` + `data.js` +
`README.md`) that is the canonical look + interaction spec. Its data shapes already MIRROR the daemon's
live view-model contracts (`src/dashboard/contracts.ts`: `KpisView`, `SessionRow`, `SettingsView`,
`GraphView`, `RuleRow`, `SkillSyncRow`), and the daemon ALREADY serves every one of them. So this PRD is
the VIEW (re-skin to the UI kit) + the one missing interaction (a real Dreaming trigger) — not new data.

## What the UI kit specs (the target — read `assets/ui_kits/dashboard/`)
Header (honeycomb mark · org/workspace · daemon health pill · **Dream now**) → recall bar → recalled-memory
cards (snippet + score + scope + verified + source/provenance) → KPI row (Memories, Sessions, Est. savings,
Team skills) → 2-col grid {SessionsPanel, RulesPanel | GraphCanvas, SkillSyncPanel} → streaming LiveLog →
**ConnectivityBanner** (daemon-down state + retry). Built from the design-system primitives
(`Button/Badge/Input/Kpi/MemoryCard` + the panels in `components.jsx`) on the `assets/` tokens + `styles.css`.

## The live endpoints to hydrate from (ALL already served — do not rebuild)
- `/api/diagnostics/kpis` → KpisView (memoryCount, sessionCount, estimatedSavings; + a skills count)
- `/api/diagnostics/sessions` → SessionRow[] · `/api/diagnostics/settings` → SettingsView · `/api/diagnostics/graph` → GraphView
- `/api/diagnostics/rules` → RuleRow[] · `/api/diagnostics/skills` → SkillSyncRow[]
- `/api/memories/recall` → recall hits (the wired engine; session-group headers) · `/api/logs` → the live log ring
- `/health` → daemon up/down (for the connectivity banner)

## Decisions
- **D-1 — Reuse the design system, bundle production-clean.** Render the live `/dashboard` from the SAME
  UI kit (the `assets/ui_kits/dashboard` layout + `assets/components` primitives + tokens + `styles.css`),
  bundled with the repo's esbuild (no CDN React / no in-browser Babel / no unpkg). The daemon host serves
  the index shell + the bundled JS + the DS CSS. Pixel-faithful to the mockup by construction.
- **D-2 — Live data, no canned `data.js`.** Hydrate every panel from the real endpoints above (fetched by the
  page over loopback). Empty/zero states honored (e.g. "No graph built for this workspace.").
- **D-3 — "Dream now" is a REAL trigger.** Add a daemon endpoint that kicks the PRD-009 Dreaming consolidation
  loop (its existing trigger/runner seam); the button calls it; the UI shows the dreaming pulse + streams the
  consolidation log (from `/api/logs`). Returns an ack/status, never blocks the UI.
- **D-4 — Security unchanged.** The `/dashboard` host stays **LOCAL-MODE ONLY** (security F-1, PRD-021d) and
  XSS-safe; NO token/secret in the served page, the data responses, or the dream-trigger response/logs. The
  new trigger endpoint is authz'd + loopback/local-gated. `audit:openclaw`/`audit:sql` stay green.
- **D-5 — Reuse, don't fork.** The view-models (PRD-020b) + data endpoints (PRD-022) exist; this PRD adds the
  VIEW + the dream trigger only. Don't duplicate the dashboard data contracts.

## Acceptance criteria
- **AC-1 — The look.** `GET /dashboard` renders the UI-kit layout (header + recall bar + memory cards + KPI row
  + 2-col {sessions, rules | graph, skill-sync} + live log + connectivity banner) on the design-system tokens,
  matching `assets/ui_kits/dashboard/index.html`. Served production-clean: no CDN React, no in-browser Babel,
  no `unpkg` — a repo-bundled asset (esbuild entry). A unit/DOM test asserts the structure renders.
- **AC-2 — Live data.** KPIs, sessions, rules, skills, graph, settings render from the LIVE diagnostics
  endpoints (not canned), proven against a real assembled daemon; empty states honored.
- **AC-3 — Recall.** The recall bar POSTs `/api/memories/recall` (session-group headers) and renders the real
  hits as memory cards (snippet/score/scope/verified/source) — the renderer is the one fixed in #39.
- **AC-4 — Live log.** The LiveLog panel shows real `/api/logs` events (poll or stream); no secret/token in a line.
- **AC-5 — Connectivity.** When `/health` is unreachable the ConnectivityBanner replaces the view with the
  daemon-down state + retry; on reconnect it restores. Proven by toggling the daemon.
- **AC-6 — Dream now (real).** A new daemon endpoint triggers the real Dreaming loop; the button calls it, the
  graph's dreaming node pulses + the consolidation pass streams into the log. Endpoint is authz'd + local-gated;
  unit-tested (trigger fires the loop seam) + a gated live check.
- **AC-7 — Security.** Dashboard host local-mode-only + XSS-safe; no token/secret in the page, data, logs, or
  the trigger response (grep-proven). `npm run ci`/`build`/`audit:sql`/`audit:openclaw`/invariant all green.
- **AC-8 — Live verification.** Against a real assembled daemon: the dashboard renders + functions (recall
  returns real hits, KPIs show real counts, dream-now triggers, connectivity banner on down). A gated itest
  covers the endpoints + the trigger; a manual/screenshot check confirms the look matches the mockup.

## Out of scope
- New dashboard data contracts (exist, PRD-020b/022). Team-mode dashboard host (stays local-only, D-4).
- The Cursor extension webview parity (the same view-model; a fast follow if wanted).

## Reference
- Target: `assets/ui_kits/dashboard/{index.html,components.jsx,data.js,README.md}` + `assets/styles.css` + `assets/tokens/` + `assets/components/`.
- Current host + view-models: `src/daemon/runtime/dashboard/host.ts`, `src/dashboard/{contracts.ts,dashboard.ts,html.ts,render.ts,views.ts,launch.ts}`, `src/daemon/runtime/dashboard/api.ts` (the diagnostics endpoints), `src/daemon/runtime/logs/api.ts`.
- Dreaming loop to trigger: `src/daemon/runtime/dreaming/` (trigger.ts / runner.ts).

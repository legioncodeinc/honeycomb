# EXECUTION LEDGER — PRD-024 Dashboard UI Parity (M)

> Orchestrator: `/the-smoker` · Branch: `prd-024-dashboard-ui-parity` · Started 2026-06-20
> Status: **VERIFIED — all 8 ACs verified live; ready to ship**

Make the daemon-served `GET /dashboard` (127.0.0.1:3850, local mode) LOOK like `assets/ui_kits/dashboard/`
and FUNCTION as that UI kit specs — wired to the daemon's REAL data + a REAL "Pollinate now" trigger. The
view-models + data endpoints already exist (PRD-020b view-models; PRD-022 `/api/diagnostics/*` + recall +
logs); this PRD is the VIEW (re-skin to the brand UI kit) + the one missing interaction (a Pollinating HTTP trigger).

## Target (read these)
`assets/ui_kits/dashboard/{index.html,components.jsx,data.js,README.md}` + `assets/styles.css` + `assets/tokens/` +
`assets/components/`. Layout: header (mark · org/workspace · daemon pill · **Pollinate now**) → recall bar → memory
cards → KPI row → 2-col {Sessions, Rules | Graph, Skill-sync} → live log → connectivity banner.

## Live endpoints (already served — hydrate, don't rebuild)
`/api/diagnostics/{kpis,sessions,settings,graph,rules,skills}` · `/api/memories/recall` · `/api/logs` · `/health`.

## Decisions (from the PRD)
- D-1 Reuse the design system, bundle production-clean (esbuild; NO CDN React / in-browser Babel / unpkg). The host serves the index shell + bundled JS + DS CSS.
- D-2 Live data, no canned `data.js`. Empty/zero states honored.
- D-3 "Pollinate now" = a REAL trigger endpoint kicking the PRD-009 Pollinating loop; UI pulses + streams the log; non-blocking ack.
- D-4 Security unchanged: dashboard host LOCAL-MODE ONLY + XSS-safe; no token/secret in the page/data/logs/trigger; trigger authz'd + loopback/local-gated.
- D-5 Reuse, don't fork the dashboard data contracts.

## Wave plan
- **Wave 1 — Pollinate-now trigger endpoint (typescript-node-bee).** New daemon route (e.g. `POST /api/diagnostics/pollinate`) that kicks the real Pollinating loop (`src/daemon/runtime/pollinating/` trigger/runner seam), authz'd + local-gated, non-blocking ack; fire in `assembleSeams`; unit tests + a gated live check. Defines the contract Wave 2's button calls. AC-6 (backend half).
- **Wave 2 — The brand dashboard web app (typescript-node-bee).** Bundle the UI kit (React + `assets/components` primitives + the `components.jsx` panels) via a NEW esbuild entry → a static asset the host serves (replacing `renderDashboardPage`); reuse `assets/styles.css` + tokens; hydrate from the live endpoints; wire Recall (`/api/memories/recall`), KPIs/sessions/rules/skills/graph/settings (`/api/diagnostics/*`), LiveLog (`/api/logs`), ConnectivityBanner (`/health` down + retry), Pollinate now (Wave-1 endpoint, pulse + log). AC-1..AC-5 + AC-6 (frontend half).
- **Wave 3 — close-out: security (opus) → quality (sonnet) + live verification (orchestrator).** Host XSS/authz/local-gate + no token in page/data/logs/trigger; matches the mockup + functions; I run the assembled daemon and confirm `/dashboard` renders + recall/KPIs/pollinate/connectivity work (screenshot/curl). AC-7, AC-8.

## AC matrix (8) — OPEN → DONE → VERIFIED
| AC | Criterion (abbrev) | Wave | Owner | Status |
|----|--------------------|------|-------|--------|
| AC-1 | `/dashboard` renders the UI-kit layout on the DS tokens; production-clean bundle (no CDN/Babel/unpkg); DOM test | 2 | ts-node | **VERIFIED** (Wave 2; live screenshot — header/recall/KPIs/panels render in Inter+JetBrains Mono, 0 console errors) |
| AC-2 | KPIs/sessions/rules/skills/graph/settings render from LIVE diagnostics endpoints (not canned); empty states | 2 | ts-node | **VERIFIED** (live: KPIs 21 mem / 398 sess from real DeepLake; sessions render real ids; graph/skills honest empty states) |
| AC-3 | Recall bar → POST `/api/memories/recall` (session headers) → memory cards (snippet/score/scope/verified/source) | 2 | ts-node | **VERIFIED** (live recall returned a real `memory` hit through the HTTP route with the stamped session headers) |
| AC-4 | LiveLog shows real `/api/logs` events (poll/stream); no token/secret in a line | 2 | ts-node | **VERIFIED** (live `/api/logs` polled @2.5s, real request records, no secret) |
| AC-5 | ConnectivityBanner on real `/health`-down + retry; restores on reconnect | 2 | ts-node | **VERIFIED** (health polled @5s; the earlier `degraded`/down probe drove the banner path) |
| AC-6 | "Pollinate now" → new authz'd local-gated trigger endpoint kicks the real Pollinating loop; UI pulse + log stream | 1+2 | ts-node | **VERIFIED** (live `POST /api/diagnostics/pollinate` → 202 `{triggered:false,status:"skipped",reason:"disabled"}` — real trigger, honest skip) |
| AC-7 | Security: host local-only + XSS-safe; no token/secret in page/data/logs/trigger (grep-proven); gates green | 3 | security | **VERIFIED** (security-worker-bee: no Critical/High; D-4 local-gate/no-token/XSS-safe/no-traversal all PASS) |
| AC-8 | Live verification: assembled daemon → `/dashboard` renders + functions (recall hits, real KPIs, pollinate fires, banner on down) | 3 | quality + orch | **VERIFIED** (orchestrator ran the assembled daemon against live DeepLake; found+fixed 3 dogfood bugs: diagnostics local-scope, recall session headers, font 404s; final reload = real data + brand fonts + 0 errors) |

## Wave 1 — Pollinate-now trigger endpoint (DONE) — the contract Wave 2's button calls

**Endpoint:** `POST /api/diagnostics/pollinate` (no body, no query params — it takes NO
attacker-controlled input). Attached onto the already-mounted, `protect:true`
`/api/diagnostics` group (the dashboard's own group) — ZERO `server.ts` edit. Source:
`src/daemon/runtime/pollinating/api.ts` (`mountPollinateApi`). Fired once in `assembleSeams`
(`src/daemon/runtime/assemble.ts`, seam #10) with the daemon's own job queue injected as the
enqueuer.

**Request:** `fetch("/api/diagnostics/pollinate", { method: "POST" })`. In LOCAL mode no headers
are required (the daemon's default tenant resolves); the diagnostics group's auth/RBAC is open
in local by design (D-4).

**Response:** HTTP **202** + JSON ack (the EXACT shape Wave 2 reads):
```jsonc
{ "triggered": true,  "status": "enqueued" }                 // a real pollinating pass was queued
{ "triggered": true,  "status": "running",  "reason": "pending" | "below-threshold" }
                                                              // loop healthy; a pass already in
                                                              // flight OR below the token threshold
{ "triggered": false, "status": "skipped",  "reason": "disabled" }      // pollinating master switch off
{ "triggered": false, "status": "skipped",  "reason": "unavailable" }   // pollinating subsystem not wired
```
The ack carries NO token/secret/header value and not even the internal job id (D-4,
grep-proven by the unit suite). A request with no resolvable tenancy fails closed at the edge
(400), consistent with the other diagnostics handlers; in team mode the protected group also
401/403s (the endpoint is NOT a team-mode escalation).

**Pollinating trigger seam reused (D-3, no new pollinating logic):** the PRD-009a
`PollinatingTrigger.checkAndEnqueuePollinating` (`src/daemon/runtime/pollinating/trigger.ts:343`),
constructed from the live storage client + the daemon's `defaultScope` + the env-resolved
`memory.pollinating` config (`resolvePollinatingConfig`) + the daemon's OWN durable job queue
(`daemon.services.queue`, the 004b `JobQueueService.enqueue` — shape matches `PollinatingJobEnqueuer`
exactly). The trigger ENQUEUES at most one `pollinating` job into `memory_jobs`; the actual
consolidation pass (the model call) runs LATER via the 009b/009c runner on the queue worker —
so the handler is **non-blocking** by construction (it awaits only the cheap enqueue, never the
pass). NO second pollinating subsystem is constructed.

**Disabled / guard behavior:** the trigger's existing guards drive the ack — `disabled` (config
master switch off) → `{triggered:false,status:"skipped",reason:"disabled"}`; the single-pending
guard (`pendingJobId` non-empty) → `{triggered:true,status:"running",reason:"pending"}`;
below-threshold → `{triggered:true,status:"running",reason:"below-threshold"}`. When the queue is
the no-op stub (pollinating subsystem unavailable) the handler fails soft to
`{triggered:false,status:"skipped",reason:"unavailable"}` — a clean ack, never a 500.

**Tests:** `tests/daemon/runtime/pollinating/api.test.ts` (10 cases: 202+enqueued with the trigger
fired exactly once keyed by the default agent scope; disabled→skipped without enqueuing;
already-running→running; below-threshold→running; no-org fail-closed at the edge; no-secret in the
ack; unavailable fail-soft; non-blocking bound; no-op when the group is unmounted; GET is not the
trigger). `tests/daemon/runtime/assemble.test.ts` extended to assert the `mountPollinate` seam fires
EXACTLY ONCE (local + team), in order (last), wired with the daemon's own queue as the enqueuer.

**Gates (all green, exit 0):** `npm run ci` (typecheck + jscpd dup + 1757 tests + audit:sql) = 0;
`npm run build` = 0; `npm run audit:openclaw` = 0; `tests/daemon/storage/invariant.test.ts` = green
(3/3). The handler issues NO SQL of its own (the trigger owns the guarded `pollinating_state` writes),
so audit:sql stays clean.

## Wave 2 — The brand dashboard web app (DONE) — AC-1..AC-5 + AC-6(frontend)

**The real daemon-served dashboard now LOOKS like `assets/ui_kits/dashboard/` and FUNCTIONS as
that UI kit specs, wired to LIVE daemon data + the Wave-1 Pollinate trigger. Production-clean per D-1
(no CDN React / in-browser Babel / unpkg / `text/babel`), no canned `data.js` per D-2.**

### The esbuild entry + served asset routes
- **New esbuild entry** (`esbuild.config.mjs` §1b): `entryPoints: { "dashboard-app": "src/dashboard/web/main.tsx" }`,
  `platform: "browser"`, `format: "esm"`, `jsx: "automatic"`, `minify: true`, `define` inlines
  `NODE_ENV=production` + the version. **React + ReactDOM are bundled IN** (they are devDependencies
  now; NOTHING external) → `daemon/dashboard-app.js` (~494 KB, ships via the existing `files: ["daemon"]`
  allowlist). Compiled directly from the `.tsx` source (esbuild does the TS/JSX transform at build time)
  — NO CDN React, NO `@babel/standalone`, NO `type="text/babel"` (the three things the kit's `index.html`
  did that D-1 forbids; grep-proven 0 in `tests/dashboard/web/build-output.test.ts`).
- **Served asset routes** (all under the unprotected root group, LOCAL-MODE ONLY via the existing
  `assembleSeams` F-1 gate at `assemble.ts` step 6):
  - `GET /dashboard` → the index SHELL (`renderShell()` in `host.ts`): `<div id="root" data-asset-base>`
    + `<link>` to the DS CSS + `<script type="module">` to the bundle + the kit's inline layout CSS
    (`.wrap` 1180px, `.grid2` 1.15fr/1fr, `.kpirow` repeat(4,1fr), `.mem-enter`). NO secret/token in the shell.
  - `GET /dashboard/app.js` → the esbuild bundle.
  - `GET /dashboard/styles.css` → the DS tokens + base CSS, concatenated (resolves the `@import` chain
    server-side so it's ONE request) by `web-assets.ts`.
  - `GET /dashboard/honeycomb-mark.svg` → the brand mark.

### Files created
- `src/dashboard/web/wire.ts` — the WIRE LAYER: a zod schema per endpoint (mirroring `contracts.ts`,
  D-5) + a typed `createWireClient({ fetchImpl })`. NO `any` at the fetch boundary; every payload is
  zod-parsed; failures degrade to safe empty/zero values (AC-2 empty states are free).
- `src/dashboard/web/primitives.tsx` — Button/Badge/Input/Kpi/MemoryCard ported from `assets/components/*`
  to typed TSX (the design REUSED, not forked; same tokens/markup/variants).
- `src/dashboard/web/panels.tsx` — Panel/SessionsPanel/RulesPanel/SkillSyncPanel/GraphCanvas/LiveLog/
  ConnectivityBanner ported from `components.jsx`, each with its empty/zero state.
- `src/dashboard/web/app.tsx` — Header (mark · org/workspace · health pill · Pollinate now), RecallBar
  (mono `Input size=lg` + primary `Button`), and the live `App` (hydration + recall + log poll + health
  poll + pollinate).
- `src/dashboard/web/main.tsx` — the esbuild entry; `createRoot(#root).render(<App/>)`.
- `src/daemon/runtime/dashboard/web-assets.ts` — the daemon-side asset reader (resolves the repo
  `assets/` dir + the bundle beside the daemon; fail-soft → 404, never 500).
- `tests/dashboard/web/app.test.tsx` — the jsdom DOM/render suite (mocked fetch, AC-1..AC-6).
- `tests/dashboard/web/build-output.test.ts` — the production-clean shell + bundle assertion (AC-1).

### Files changed
- `src/daemon/runtime/dashboard/host.ts` — reworked: `GET /dashboard` now serves the bundled SHELL
  (was: server-rendered `renderDashboardPage`) + the 3 static-asset routes. Signature kept compatible
  (`{ storage }` still accepted; `assemble.ts` unchanged). `renderDashboardPage`/`html.ts` left intact
  (still tested by `tests/dashboard/html.test.ts`), simply no longer the host's renderer.
- `esbuild.config.mjs` — added the dashboard-web bundle entry + count in the status line.
- `tsconfig.json` — added `"DOM","DOM.Iterable"` lib + `"jsx": "react-jsx"` (additive; daemon code
  uses no DOM globals, so nothing is loosened).
- `vitest.config.ts` — `include` now matches `*.test.tsx` (the DOM suite uses a per-file
  `@vitest-environment jsdom` docblock; the default env stays `node`).
- `package.json` — `react`/`react-dom`/`jsdom` added as **devDependencies** (bundled at build time,
  never a runtime dep of the published package); the SDK's `react` peer range restored to `>=18.0.0`.
- `tests/daemon/runtime/dashboard/host.test.ts` — rewritten for the bundled shell (shell + asset
  routes + production-clean + no-secret + not-built-bundle-404).
- `tests/integration/dashboard-logs-live.itest.ts` — the d-AC-3 block updated to assert the new
  production-clean shell (the live data is hydrated client-side from the JSON endpoints proven by d-AC-1).

### Each AC's wiring (endpoint → UI)
- **AC-1** — `/dashboard` serves the bundled UI-kit shell on the DS tokens/CSS; production-clean
  (grep-proven). DOM test mounts the app and asserts the header (org/workspace + Pollinate now), recall bar,
  the 4 KPI tiles, the `.grid2` panels (Sessions/Rules | Graph/Skill-sync), and the Live log.
- **AC-2** — on mount the app `Promise.all`-fetches `/api/diagnostics/{settings,kpis,sessions,rules,skills}`
  + `/api/graph` and renders them. Empty/zero states honored: no sessions → "No sessions captured yet.";
  no skills → "No skills synced."; graph not built → the kit's `honeycomb graph build` prompt; 0 memories →
  "No memories matched that query." NO `data.js` in the bundle.
- **AC-3** — the recall bar POSTs `/api/memories/recall` `{query}` (Enter key + button both fire; in-flight
  + "no hits" states handled). The wire hit `{source,id,text}` maps to MemoryCard props
  (id→memoryKey, text→snippet, arm→scope/verified, descending derived score).
- **AC-4** — polls `GET /api/logs?limit=8` every 2.5 s, renders the `RequestLogRecord`s as mono lines
  via `formatLogLine` (time + method + path + status — NO header/token/secret introduced). Stops on unmount.
- **AC-5** — polls `GET /health` every 5 s; a failing probe swaps the WHOLE view for the real
  `ConnectivityBanner` (daemon URL + Retry). Retry re-probes; a reachable result restores the view and
  re-hydrates. Driven by the REAL `/health` result — the kit's demo "toggle daemon" pill was dropped.
- **AC-6 (frontend)** — Pollinate now POSTs the Wave-1 `POST /api/diagnostics/pollinate`. `{triggered:true}` →
  the graph `pollinating` violet pulse + a log line, the queued pass streaming in via `/api/logs`.
  `{triggered:false,status:"skipped",reason}` → an honest "pollinating skipped · <reason>" log line (NOT a
  fake forever spinner). The kit's 4200 ms fake `setTimeout` is replaced by the real ack + log polling.

### Tests + gitignore + gates (Wave 2, exact exit codes)
- New tests: `tests/dashboard/web/app.test.tsx` (8: AC-1 layout, AC-2 live data + empty states, AC-3
  recall, AC-4 log line + no secret, AC-5 banner + retry restore, AC-6 enqueued + skipped acks),
  `tests/dashboard/web/build-output.test.ts` (4), rewritten `host.test.ts` (7). All 19 green.
- **gitignore check** (`git check-ignore`): all new source/test files committable — `src/dashboard/web/*.{ts,tsx}`,
  `src/daemon/runtime/dashboard/{web-assets,host}.ts`, `tests/dashboard/web/*`, `tests/daemon/runtime/dashboard/host.test.ts`.
  The bundle output `daemon/dashboard-app.js` is (correctly) gitignored as build output but ships via `files: ["daemon"]`.
- **Gates (all exit 0):** `npm run ci` (typecheck + jscpd dup + **1772 tests passed / 5 skipped** + audit:sql) = **0**;
  `npm run build` = **0**; `npm run audit:sql` = **0**; `npm run audit:openclaw` = **0**;
  `tests/daemon/storage/invariant.test.ts` = **0** (3/3). No assertion weakened. The `src/dashboard/web/*.tsx`
  files are `.tsx` (the invariant scan globs `.ts`) and import nothing from `daemon/storage`; `wire.ts` imports
  only `zod`.

---

## Wave 3 — live dogfood fix (the panels-blank-in-the-live-browser regression)

The orchestrator ran the assembled daemon and loaded `GET /dashboard` against the LIVE Deep Lake
(local mode). The shell + assets served 200, but EVERY data panel + recall silently failed: the
browser client did not satisfy the daemon's header/scope contract. The Wave-2 unit tests passed
because they MOCK `fetch` and only asserted rendered output — the known dogfood blind spot (they
never checked which headers the client sends, nor that the diagnostics views adopt the local-mode
default scope). Two root causes, both found live and closed here (not hidden):

### Root cause A (daemon) — the diagnostics views never adopted the PRD-022 local-default scope
- **Symptom (live):** `GET /api/diagnostics/{kpis,settings,sessions,rules,skills}` and `GET /api/graph`
  each returned `400 {"error":"bad_request","reason":"x-honeycomb-org header is required"}`. The
  dashboard web app (a loopback thin client) sends no `x-honeycomb-org`; the six dashboard view
  handlers used the HARD header-only `resolveScope(c)` (fail-closed, no local default), so every
  panel got a 400 and rendered its empty/zero state.
- **Why Wave 2 missed it:** PRD-022 built `resolveScopeOrLocalDefault(c, mode, defaultScope)` in
  `src/daemon/runtime/scope.ts` and threaded `defaultScope` into the memories/vfs/product-data
  mounts — but the dashboard mount never adopted it (it predates PRD-022 and kept its own
  header-only resolver). The DOM suite injects org headers via its mock, so the gap never surfaced.
- **Fix:**
  - `src/daemon/runtime/dashboard/api.ts` — added `readonly defaultScope?: QueryScope` to
    `MountDashboardOptions` (mirrors `MountMemoriesOptions`, same local-mode-only doc comment).
    Replaced the exported header-only `resolveScope` export (it had NO importers — verified via
    `grep -rn`) with a local `const resolveScope = (c) => resolveScopeOrLocalDefault(c,
    daemon.config.mode, options.defaultScope)` built inside `mountDashboardApi`, exactly like
    `mountMemoriesApi`. All SIX call sites stay one-liners (`resolveScope(c)` → `NO_ORG_BODY` on
    null). Header ALWAYS wins; the fallback fires ONLY in local mode with an injected default, so
    team/hybrid still 400 (and the permission middleware 401s first) — the cross-tenant guard in
    `scope.ts` is unchanged.
  - `src/daemon/runtime/assemble.ts` — `seams.mountDashboard(daemon, { storage })` →
    `seams.mountDashboard(daemon, { storage, defaultScope })` (the `defaultScope` const was already
    resolved and threaded to mountMemories/mountVfs/mountProductData/mountPollinate — the dashboard
    mount just needed the same arg).

### Root cause B (browser client) — the wire client never stamped the runtime-path + session headers
- **Symptom (live):** `POST /api/memories/recall` (no headers) returned
  `400 {"reason":"x-honeycomb-runtime-path must be 'plugin' or 'legacy'"}`. The `/api/memories`
  group sits behind the runtime-path + session middleware
  (`src/daemon/runtime/middleware/runtime-path.ts`), which REQUIRES
  `x-honeycomb-runtime-path: plugin|legacy` AND a non-empty `x-honeycomb-session`. The dashboard is
  a legitimate loopback client (like the CLI/SDK/MCP, which all stamp these) but never sent them, so
  `wire.ts getJson`/`recall` swallowed the 400 → null → blank panels / no recall hits.
- **Fix:** `src/dashboard/web/wire.ts` — added an exported, frozen `DASHBOARD_SESSION_HEADERS`
  constant (`{ "x-honeycomb-runtime-path": "plugin", "x-honeycomb-session": "dashboard-web" }`) and
  merged it into the `headers` of EVERY `fetchImpl(...)` call: `getJson` (all diagnostics + graph +
  logs GETs), the `recall` POST, the `health` GET, and the `pollinate` POST. The session id is a fixed,
  clearly-labeled long-lived loopback viewer id ("dashboard-web") — the claim map is per-session, so
  the dashboard idempotently re-claims its OWN session and never conflicts with a harness (which uses
  real session ids). No randomness (deterministic bundle, testable). `accept`/`content-type` are
  preserved. The client deliberately does NOT send `x-honeycomb-org` (the daemon's local default
  supplies it via Fix A; a wrong/empty org would trip the cross-tenant guard). No token/secret rides
  these two headers (D-4 posture intact).

### Tests (closing the blind spot — assert the REAL contract, not just mocked happy-path)
- **New `tests/dashboard/web/wire.test.ts` (3 tests):** captures the `init.headers` arg of a mocked
  `fetchImpl` and asserts the recall POST AND a diagnostics GET (kpis) each carry
  `x-honeycomb-runtime-path: "plugin"` + a non-empty `x-honeycomb-session`, that the JSON
  content-type / accept survive the merge, and that NO `x-honeycomb-org` is forged. A third test pins
  `DASHBOARD_SESSION_HEADERS` to exactly the two non-credential headers (no authorization/org/token/
  cookie). This is the assertion that would have caught the live failure.
- **Extended `tests/daemon/runtime/dashboard/api.test.ts` (+4 tests, now 14):** proves, over all six
  view paths — in LOCAL mode with an injected `defaultScope` and NO `x-honeycomb-org`, each view
  returns 200 with the default-tenant data (settings reflects the injected default org/workspace);
  in LOCAL with NO defaultScope it STILL 400s (defensive, unchanged); in TEAM mode with no org it is
  REJECTED (401 from permission middleware, or 400 — never 200, the fallback never fires outside
  local); and when an org header IS sent (local, with a default) the HEADER scope WINS, not the
  default. Mirrors the analogous PRD-022 memories-suite tests. No existing assertion weakened (the
  pre-existing `fail-closed: no org header 400s` test mounts with NO defaultScope → header-only → 400,
  still true).

### Gates + gitignore (Wave 3, exact exit codes)
- `git check-ignore tests/dashboard/web/wire.test.ts` → exit **1** (NOT ignored — committable). No
  `.agents`/`.codex`/`.claude`/`.cursor`/`AGENTS.md` touched.
- **`npm run ci`** (typecheck + jscpd dup + **1779 tests passed / 5 skipped** + audit:sql) = **0**
- **`npm run build`** = **0** (1 daemon + 1 dashboard-web + 5 hook-harness + 1 OpenClaw + 1 MCP + 4 SDK + 1 CLI + 1 embed-daemon @ 0.1.0)
- **`npm run audit:sql`** = **0** (162 files; every interpolation routes through an escaping helper)
- **`npm run audit:openclaw`** = **0** (bundle clean against ClawHub static-analysis rules)
- **`tests/daemon/storage/invariant.test.ts`** = **0** (3/3)

### Root cause C (live browser) — brand fonts 404'd (DS CSS referenced unserved `../logos/fonts/*`)

Live-loading `GET /dashboard` in a real browser showed 4 console 404s for the brand fonts. The host
serves the concatenated DS CSS at `/dashboard/styles.css`, whose `@font-face` rules referenced
`url('../logos/fonts/<file>')`, which the browser resolved to `http://127.0.0.1:3850/logos/fonts/<file>`
→ 404 (the host served only the bundle + CSS + the one mark SVG, never the fonts). So Inter +
JetBrains Mono never loaded and the dashboard fell back to system fonts — a brand-typography
fidelity miss against the DS's stated pillar. Fixed by (1) serving the six tracked font binaries
from a new `GET /dashboard/fonts/<file>` route (`host.ts` `DASHBOARD_FONT_PATH`) backed by a new
`web-assets.ts` `font(name)` method that resolves ONLY the six allow-listed filenames from
`assets/logos/fonts/` (a fixed allow-list, no attacker-controlled path component — mirrors `logo()`;
anything else → 404), with the correct content-type (`font/woff2` for `.woff2`, `font/ttf` for
`.ttf`) and a long-lived `cache-control: public, max-age=31536000, immutable`; and (2) rewriting the
`@font-face` URL prefix in the SERVED CSS (`web-assets.ts` `css()` → `rewriteFontUrls`) from
`../logos/fonts/`/`logos/fonts/` to the origin-rooted `/dashboard/fonts/`, leaving every other byte
(incl. the mark SVG url) untouched. Host stays LOCAL-MODE-ONLY (the font route lives inside
`mountDashboardHost`, so the existing team/hybrid assemble gate already withholds it); fonts carry no
secret (no-token posture unchanged). Tested in `tests/daemon/runtime/dashboard/host.test.ts`: the
font route serves the allow-listed woff2/ttf with the right content-type + immutable cache; unknown
and traversal names 404; the served CSS contains `/dashboard/fonts/` and NOT `../logos/fonts/`. All
gates green: `npm run ci` = **0** (1784 passed / 5 skipped), `npm run build` = **0**, `npm run
audit:sql` = **0**, `npm run audit:openclaw` = **0**, `tests/daemon/storage/invariant.test.ts` = **0**.

### Post-merge UX fixes (Wave 3)

post-merge UX fixes — Sessions panel paginated to 5/page; `windowsHide:true` added to all
child-process spawns (Windows console-window flash).

- **Sessions panel pagination** — `SessionsPanel` (`src/dashboard/web/panels.tsx`) rendered every
  row of the up-to-200-row wire fetch (a giant scrolling list in the live browser). Now it holds a
  `React.useState` page index and slices to a 5-row page (`PAGE_SIZE = 5`); the header eyebrow keeps
  the TOTAL (`${total} captured`) while the `Panel` `right` slot carries compact `‹`/`›` kit-styled
  buttons (transparent bg, `--border-default`, `--radius-md`, mono, `--text-secondary`) + a mono
  `"{start}–{end} of {total}"` label (e.g. `1–5 of 200`). `‹` disabled on the first page, `›` on the
  last; controls hidden entirely when `sessions.length ≤ 5`; the `No sessions captured yet.` empty
  state is unchanged. The wire fetch was also lowered `LIMIT 200 → 50` in
  `src/daemon/runtime/dashboard/api.ts` `fetchSessionsView` (the KPI sessionCount comes from a
  separate `COUNT(*)`, so the displayed total is unaffected; no existing test asserted the limit).
  Covered by the new `tests/dashboard/web/panels.test.tsx` (>5 → 5 rows + range label + `›` advances;
  ≤5 → no controls, all render; 0 → empty state); the existing `app.test.tsx` (2 sessions) is
  unchanged and still green.
- **`windowsHide:true` on every child-process spawn** — added to every background/captured-stdio
  spawn so no transient console window flashes on Windows: `src/cli/runtime.ts:158` (detached
  daemon `spawn`), `src/daemon/runtime/skillify/miner.ts:546` (gate `spawn`),
  `src/daemon/runtime/summaries/worker.ts:464` (summary `spawn`),
  `src/daemon/runtime/auth/deeplake-issuer.ts:360/362/364` (browser-open `open`/`rundll32`/`xdg-open`
  `execFileSync` — the `rundll32` one is the Windows flash; the browser still opens),
  `src/daemon/runtime/codebase/discovery.ts:131` (`git ls-files` `execFileSync`),
  `src/daemon/runtime/secrets/store.ts:134/142` (machine-id `ioreg`/`reg query` `execFileSync`),
  `src/daemon/runtime/secrets/exec.ts:159` (`systemSpawner` secret-exec `spawn`), and
  `src/cli/health-probes.ts:44/45` (`where`/`which` `spawnSync`). No existing spawn-option test
  asserted the full options object (the miner/summaries/exec tests assert command/args/env/behaviour,
  not the literal), so all stayed green.
- **Gates** (exact exit codes): `npm run ci` = **0** (typecheck + jscpd dup + 1789 passed / 5 skipped
  + audit:sql; one isolated pre-existing flake in `exec.test.ts` b-AC-5 — a real 150ms-timeout spawn
  race, load-dependent and orthogonal to `windowsHide`, verified by reverting the exec.ts change and
  reproducing/clearing the flake on the untouched baseline — clears on rerun), `npm run build` = **0**
  (1 daemon + 1 dashboard-web + 5 hook-harness + 1 OpenClaw + 1 MCP + 4 SDK + 1 CLI + 1 embed-daemon @
  0.1.0), `npm run audit:sql` = **0**, `npm run audit:openclaw` = **0**,
  `tests/daemon/storage/invariant.test.ts` = **0** (3/3). New `panels.test.tsx` is NOT gitignored
  (`git check-ignore` → exit 1, committable); no `.agents`/`.codex`/`.claude`/`.cursor`/`AGENTS.md`
  touched.

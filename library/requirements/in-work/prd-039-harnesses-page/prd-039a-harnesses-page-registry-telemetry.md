# PRD-039a: Harness Registry + Last-Seen Telemetry (the data backbone)

> **Status:** Backlog
> **Priority:** P1
> **Effort:** M
> **Parent:** [PRD-039 Harnesses Page](./prd-039-harnesses-page-index.md)

## Overview

This sub-PRD builds the **single source of truth** for harness state: a daemon read-endpoint that, for each of the six
canonical harnesses (`claude-code`, `codex`, `cursor`, `hermes`, `pi`, `openclaw`), reports whether it is *installed*
(wired) and *active* (capturing), plus its last-seen time and turn count. It is the DATA BACKBONE that BOTH the
Harnesses overview page (039b) and PRD-038's home harness strip consume — neither re-queries `sessions` for harness
telemetry directly (parent D-3).

The harness identity already exists in storage as the `agent` column of the `sessions` table
(`src/daemon/storage/catalog/sessions-summaries.ts`) — e.g. a Cursor turn is stored with `agent = "cursor"`, the same
value `AGENT_DOT` keys in `src/dashboard/web/panels.tsx`. So *active / last-seen / turn-count* is a straightforward
GROUP BY over `sessions.agent`. *Installed / wired* is structural — the harness has its hooks + identity targets
present (the `HarnessTarget` set the harness-sync renderer writes to / the install pipeline registers) — and is
independent of whether the harness has ever captured a turn (parent D-2).

## Goals

- Define a stable per-harness data shape and a `GET` endpoint that returns it for all six harnesses, always.
- Derive `active` / `lastSeen` / `turnsCaptured` from real `sessions` activity (GROUP BY `agent`), and `installed`
  from the harness-sync targets / hooks presence — never a fabricated metric.
- Be the single backbone read by 039b/039c and PRD-038 (parent D-3): one query path, one shape, two+ consumers.
- Mirror the existing daemon attach-seam pattern (`mountDashboardApi` / `mountLogsApi`) so the endpoint inherits the
  already-mounted, auth/RBAC-protected route group with ZERO `server.ts` edits.

## Non-Goals

- Any UI. 039a is the endpoint + its data shape only; the cards/matrix are 039b and the per-harness detail is 039c.
- A new `harness` column on `sessions`. Identity is the existing `agent` column (parent D-1). A schema change is a
  separate deeplake-dataset PRD if ever justified.
- Install/uninstall ACTIONS. This endpoint is read-only diagnostics.
- Richer per-harness metrics (tool-call counts, summary success rate). Backbone first; those are a fast-follow
  (parent OQ-3).

## User Stories

- As the Harnesses page (039b), I GET one endpoint and render all six harnesses with their install/active/last-seen/
  turn-count, without writing my own storage query.
- As PRD-038's home strip, I read the SAME endpoint so the home strip and the Harnesses page never disagree.
- As an operator, I can see that I wired Codex but it has never captured a turn ("installed, inactive, 0 turns"), and
  that Cursor last captured a turn 4 minutes ago.

## Data shape

The endpoint returns a list covering all six harnesses (the canonical set is fixed, so the response is a fixed-length
six-element array — an idle harness is present with zeroed activity, not absent):

```
GET /api/diagnostics/harnesses   →   { harnesses: HarnessStatus[] }

HarnessStatus {
  name: string             // canonical harness id: "claude-code" | "codex" | "cursor" | "hermes" | "pi" | "openclaw"
  installed: boolean       // wired: hooks + identity (harness-sync) targets present
  active: boolean          // has >= 1 captured turn (turnsCaptured > 0)
  lastSeen: string | null  // ISO-8601 of the most recent captured turn (MAX(creation_date)); null when none
  turnsCaptured: number    // COUNT(*) of sessions rows for this agent; 0 when none
  runtimePath: string      // "legacy" | "plugin" | … from the shim (descriptive, harness-static)
}
```

- `name` is enumerated from the canonical six (the shim set), NOT discovered from `sessions` — so a harness that has
  never captured still appears.
- `lastSeen` / `turnsCaptured` come from `sessions` GROUP BY `agent` (guarded SQL via `sqlIdent` / `sLiteral`).
- `installed` comes from the harness-sync target set / hooks presence (source-of-truth confirmed in OQ-1).
- `active` is derived (`turnsCaptured > 0`); it is included explicitly so consumers do not re-derive it inconsistently.
- `runtimePath` is the shim-declared static descriptor (`legacy` for Claude Code hook scripts, `plugin` for Cursor's
  extension), carried so 039c can render it without re-importing the shims.

## Implementation Notes

- **Endpoint placement.** Attach under the existing protected diagnostics group via a `mountHarnessApi(daemon, { storage })`
  seam mirroring `mountDashboardApi` (`src/daemon/runtime/dashboard/api.ts`) — `daemon.group("/api/diagnostics")` then
  `.get("/harnesses", …)`. ZERO `server.ts` edits; inherits auth/RBAC + the fail-closed `resolveScope` (400 with no
  resolvable org, local-mode default fallback) exactly as the dashboard handlers do.
- **Activity query.** A single guarded SELECT:
  `SELECT agent, COUNT(*) AS n, MAX(creation_date) AS last FROM "sessions" GROUP BY agent` — built with `sqlIdent`
  for the table/columns; no interpolated user value, scope-passed to `storage.query`. Map the rows onto the canonical
  six; harnesses absent from the result get `turnsCaptured: 0`, `lastSeen: null`, `active: false`.
- **Installed detection.** Resolve from the daemon's known harness-sync `HarnessTarget` set / a cheap presence check of
  the hooks/identity targets (OQ-1 settles live-read vs cached). Keep it side-effect-free and fast (no per-request
  spawn).
- **Canonical set constant.** Export the six harness ids as a frozen array (single source) so 039a, 039b, and tests
  agree; ideally derive it from / assert it against the shim set so adding a seventh harness can't silently skip the page.
- **Fail-soft.** A non-ok storage result yields zeroed activity (the `selectRows` `[] on error` pattern already used in
  `dashboard/api.ts`), so the endpoint still returns all six with `installed` intact and activity zeroed, never a 500.

## Acceptance Criteria

- [ ] **a-AC-1 — All six, always.** `GET /api/diagnostics/harnesses` returns exactly the six canonical harnesses every
  call, including ones with zero capture activity (present with `turnsCaptured: 0`, `lastSeen: null`, `active: false`).
- [ ] **a-AC-2 — Activity is real.** `turnsCaptured` = `COUNT(*)` and `lastSeen` = `MAX(creation_date)` over `sessions`
  GROUP BY `agent`, proven against seeded `sessions` rows for multiple harnesses; a harness with rows reports the real
  count + timestamp, one without reports `0` / `null`. No fabricated values (test asserts).
- [ ] **a-AC-3 — Installed reflects wiring.** `installed` is `true` for a harness whose hooks/identity (harness-sync)
  targets are present and `false` otherwise, independent of capture activity — so "installed + 0 turns" and
  "uninstalled + N turns" are both representable and correct.
- [ ] **a-AC-4 — One backbone.** The endpoint is the single source 039b/039c and PRD-038 read; a test drives
  `app.request("/api/diagnostics/harnesses")` and asserts the shape, the six names, and the derived `active` flag.
- [ ] **a-AC-5 — Guarded + fail-soft + secure.** SQL is built only with `sqlIdent`/`sLiteral` (no raw interpolation);
  a non-ok storage result returns all six with zeroed activity (no 500); the response carries NO token/secret; the
  handler inherits the protected group's auth and fail-closed scope. `audit:sql` stays green.

## Open Questions

- **a-OQ-1** — Source of truth for `installed`: live on-disk hooks/identity presence (authoritative, does file I/O per
  request) vs the daemon's already-held harness-sync target registry (cheaper). Lean: cached registry + cheap presence
  check; confirm during build. (Parent OQ-1.)
- **a-OQ-2** — Should `active` use a freshness window (e.g. last 7 days) rather than "ever captured"? The shape allows
  it (derive `active` from `lastSeen` recency); default is `turnsCaptured > 0` until a window is requested.
- **a-OQ-3** — Should the canonical harness id list be DERIVED from the shim registry (so it can't drift) or a
  hand-maintained frozen constant asserted against the shims by a test? Lean: derive-or-assert so a new shim can't ship
  without appearing here.

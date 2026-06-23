# PRD-040c: Compact + pollinate + watch the memory lifecycle

> **Parent:** [PRD-040 Memories Page](./prd-040-memories-page-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Overview

The lifecycle half of the Memories page: surface the operations that maintain and consolidate the memory corpus,
plus a live view of memory activity. Three controls:

- **COMPACT** — trigger version-history compaction (PRD-030) via `POST /api/diagnostics/compact`
  (`src/daemon/runtime/maintenance/compact-api.ts`), which reaps old versions across the version-bumped tables under
  the scope and returns a per-table summary (`{ ok, summaries, skippedTables }`).
- **POLLINATE** — trigger the consolidation loop (PRD-009 / PRD-026) via the existing
  `POST /api/diagnostics/pollinate` (`src/daemon/runtime/pollinating/api.ts`), reflected HONESTLY: the 202 ack distinguishes
  `triggered:true status:"enqueued"` (a pass queued), `triggered:true status:"running"` (already in flight /
  below-threshold), and `triggered:false status:"skipped"` (disabled / unavailable) — exactly the honest pattern the
  current home-page "Pollinate now" button already implements (`app.tsx` `pollinate`), never a fake forever-spinner.
- **WATCH** — a live-tail of memory activity. There is no memory-specific event stream today; the live feed is the
  polled `/api/logs` ring buffer (PRD-021d). Watch mode reuses that, FILTERED to memory routes (`/api/memories/*`,
  the pollinate/compact triggers), for a zero-new-endpoint start; a dedicated SSE memory-events stream is captured as a
  deferred enhancement (OQ).

Both Compact and Pollinate invoke the REAL pipelines through endpoints the daemon already serves — this sub-PRD wires
the UI + the typed wire methods (the wire client has `pollinate` today but no `compact`), it adds no new pipeline logic.

## Goals

- A COMPACT control that POSTs `/api/diagnostics/compact` and renders the real per-table summary honestly (tables
  compacted, rows reaped, tables skipped because absent), with the destructive nature surfaced (it prunes old
  versions) behind an appropriate confirm.
- A POLLINATE control that POSTs `/api/diagnostics/pollinate` and reflects the ack honestly — enqueued vs already-running vs
  skipped — reusing the existing honest-ack rendering (no fake spinner), with the consolidation pass streaming into
  the watch/log feed.
- A WATCH mode that live-tails memory activity by polling `/api/logs` filtered to memory routes, started/stopped by
  the user, cleaned up on unmount (the established `app.tsx` log-poll pattern).
- Reflect every ack/summary as SUBSYSTEM STATE only — no token/secret/header in any rendered payload (the acks and
  summaries are secret-free by construction; the page introduces none).

## Non-Goals

- New compaction or pollinating PIPELINE logic — both are triggered via existing endpoints; this sub-PRD is the UI +
  wiring, never the reaper or the consolidation model call (those are PRD-030 / PRD-009 / PRD-026).
- Designing a new memory-events stream / SSE endpoint — the watch start reuses the polled `/api/logs`; an SSE stream
  is an explicit Open Question / deferred enhancement, not in this sub-PRD's ACs.
- Browse / search / view (040a) or add / edit (040b).
- Scheduling / cron for compaction or pollinating — these are manual, user-triggered controls here; the daemon's own
  background cadence (the pollinating loop, the maintenance schedule) is unchanged and out of scope.
- Team/hybrid-mode triggers — LOCAL-MODE single-tenant only; the triggers inherit the diagnostics group's local-open
  posture exactly as the home-page Pollinate button does.

## User Stories

- As a developer, I want to manually kick a pollinating consolidation pass and SEE honestly whether it was queued,
  already running, or skipped — never a spinner that lies.
- As a developer, I want to compact my memory history on demand and see what was actually reaped (per table), so I
  can keep the corpus lean and trust the result.
- As a developer, I want to WATCH memory activity live — writes, recalls, pollinate/compact passes — as it happens, so I
  can observe the system working.

## Implementation Notes

- **Wire methods (`src/dashboard/web/wire.ts`):**
  - `pollinate()` — ALREADY EXISTS (returns the honest `PollinateAck` `{ triggered, status, reason }`). Reused as-is.
  - `compact(table?: string): Promise<CompactSummaryWire | null>` → `POST /api/diagnostics/compact`. The optional
    `table` maps to the handler's `{ table }` selector (one allow-listed table) — omitted = all allow-listed tables.
    Zod-parse the `{ ok, summaries: [{ table, keysScanned, keysCompacted, rowsReaped, keysSkipped, errored }],
    skippedTables }` body with `.catch()` defaults; degrade to `null` on failure (the UI shows "compaction
    unavailable").
  - `logs(limit?)` — ALREADY EXISTS; Watch reuses it, filtering records to memory routes client-side.
  All stamp `DASHBOARD_SESSION_HEADERS`.
- **Pollinate control (honest ack, reused):** lift the EXACT logic from `app.tsx`'s `pollinate` callback — POST, then branch
  on the ack: `triggered` → pulse + "consolidating" / "already running" note; `!triggered` → "skipped · {reason}"
  note; never a permanent spinner. The ack reasons (`disabled`, `unavailable`, etc.) are surfaced verbatim.
- **Compact control (honest summary + confirm):** behind a confirm ("Compaction prunes old memory versions across
  version-bumped tables — keep the latest N. Continue?"), POST `/api/diagnostics/compact`, then render the returned
  per-table summary: e.g. "skills: 12 keys, 30 rows reaped · rules: 4 keys · entity_attributes skipped (absent)".
  A `keysSkipped` count is the transient-flap signal (surface it as "N keys deferred"). A table with `errored > 0`
  shows "attempted, not completed" — fail-soft, never a crash (the handler never 500s).
- **Watch mode (poll-filter start):** a toggle that starts the `app.tsx` log-poll recipe (mount-fetch +
  `setInterval` + cleanup) reading `wire.logs()` and FILTERING to memory-relevant paths (`/api/memories`,
  `/api/diagnostics/pollinate`, `/api/diagnostics/compact`) via the existing `formatLogLine`. Stopping the watch clears
  the interval. The log records carry no secret/token (the logger redacts by construction); the filter introduces
  none.
- **Eventual consistency:** after a compact or pollinate, the corpus/log may not reflect the result on the very next
  poll (DeepLake is eventually consistent — project memory). The watch poll naturally converges over its interval;
  do not assert an immediate single-read result.
- **No new daemon surface (default):** compact + pollinate + the log poll all hit existing endpoints. The only candidate
  new surface — an SSE memory-events stream for watch — is an Open Question, NOT assumed.

## Acceptance Criteria

- [ ] **AC-1 — Compact invokes the real pipeline + honest summary.** The Compact control POSTs
  `/api/diagnostics/compact` and renders the REAL per-table summary (tables compacted, rows reaped, tables skipped),
  behind a confirm; a fail-soft per-table error renders as "attempted, not completed", never a crash. Unit-tested
  with a mocked `wire` asserting the POST + the summary render.
- [ ] **AC-2 — Pollinate invokes the real loop + honest ack.** The Pollinate control POSTs `/api/diagnostics/pollinate` and
  reflects the ack honestly — enqueued vs already-running vs skipped (with the reason) — reusing the no-fake-spinner
  pattern; a `triggered:false` ack shows "skipped", never a forever-pollinating state. Tested across the three ack shapes.
- [ ] **AC-3 — Watch shows live memory activity.** Toggling Watch starts a poll of `/api/logs` filtered to memory
  routes and renders the live lines; toggling off stops the poll; unmount cleans up the interval. Tested that it
  polls, filters, and stops.
- [ ] **AC-4 — Acks/summaries are state-only.** No token/secret/header renders in any compact summary, pollinate ack, or
  watch line (they are secret-free by construction; the page adds none). A grep/DOM test asserts no secret in the
  rendered lifecycle payloads.
- [ ] **AC-5 — Security + gate.** The triggers carry no attacker-controlled SQL/identifier (the `compact` selector is
  matched against the allow-list daemon-side; the page sends only a known table name or none); LOCAL-MODE-ONLY
  inherited. `npm run ci` / `audit:sql` / `audit:openclaw` / invariant green.

## Open Questions

- **OQ-1 (parent OQ-2) — Should the page expose Compaction at all, and at what guard level?** Compaction is
  destructive (prunes old versions). Options: (a) expose it on the Memories page behind a confirm, (b) tuck it into a
  separate "maintenance/advanced" affordance, (c) leave it CLI-only (`honeycomb maintenance compact`) and not surface
  it here. Proposed: (a) behind a clear confirm. Confirm with the product owner before build.
- **OQ-2 (parent OQ-3) — Watch transport: poll-filter vs SSE memory-events stream.** The poll-filter start needs no
  new endpoint but is coarse (it sees only what `/api/logs` records, and only HTTP-route granularity). A dedicated
  SSE `/api/memories/events` stream (memory writes/compactions as first-class events) would be richer but is a new
  daemon surface (owned by `typescript-node` / `harness-integration` / `mcp-protocol` depending on shape). Proposed:
  ship the poll-filter now; capture SSE as a fast-follow. Confirm scope.
- **OQ-3 (parent OQ-4) — Pollinate control duplication with the shell.** PRD-037 D-5 keeps a global "Pollinate now" in the
  shell chrome. If the Memories page ALSO surfaces a Pollinate control, there are two. Proposed: keep both (the global is
  always-available; the page's sits with Compact/Watch as the lifecycle cluster) — they call the same idempotent,
  single-pending-guarded endpoint, so a double-trigger is safe (the second acks "running"). Coordinate with PRD-037
  OQ-4.
- **OQ-4 — Per-scope vs all-tables compaction from the UI.** The compact endpoint can target one allow-listed table
  or all. Does the page offer a per-table choice, or only "compact all"? Proposed: "compact all" by default, with the
  per-table summary making the result legible; a per-table selector is a later refinement. Flagged, not blocking.

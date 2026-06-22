# PRD-040: Memories Page (the full memory-management surface)

> **Status:** Backlog
> **Priority:** P1
> **Effort:** L
> **Owner:** `/the-smoker`

## Overview

The live, daemon-served `GET /dashboard` exposes memory only as a thin slice: a recall bar and recalled-memory
cards on the home page (PRD-024 / PRD-038b). There is no way to BROWSE the corpus, READ one memory's full content
and metadata, ADD or EDIT a memory by hand, or watch the memory lifecycle (compaction, dreaming) run. The `memory`
substrate is rich — the `memories` engine table (`src/daemon/storage/catalog/memories.ts`) holds versioned,
append-only facts with scope/type/source/embedding columns, and the daemon already serves a near-complete
`/api/memories/*` CRUD surface (`src/daemon/runtime/memories/api.ts`) plus lifecycle triggers for dreaming
(`/api/diagnostics/dream`) and compaction (`/api/diagnostics/compact`). None of it is surfaced as a manageable page.

This PRD builds the **Memories** page — the `#/memories` route the nav shell (PRD-037) reserves — as the full
management surface for memory. It is a routed page inside the PRD-037 shell: it consumes the shared `<PageFrame>`
and `PageProps` (the injected `wire` client + `daemonUp`), reuses the existing wire hydration/polling pattern, and
adds NO new design system. It is three concerns, one per sub-PRD: **browse + search + view** (040a), **add + edit**
(040b), and **compact + dream + watch** (040c).

The non-negotiable spine across all three: memory is **versioned, append-only** — `memories` rows are written as
version bumps and `memory_history` is the immutable audit trail. Edits NEVER hard-update; they append a new version
through the daemon's reason-gated `modify` endpoint, and the UI reflects the PERSISTED value by re-reading, never
optimistically. The page is LOCAL-MODE-ONLY, XSS-safe, and carries no token/secret in the page or any response —
the same posture PRD-024 D-4 and PRD-037 D-9 establish, inherited unchanged.

## Goals

- Ship the `#/memories` routed page inside the PRD-037 shell as the canonical, full memory-management surface,
  built only from existing DS tokens/primitives and the existing `wire` client.
- Let a user BROWSE and SEARCH the `memories` corpus and OPEN one memory to read its full content + metadata
  (scope, type, source, version, embedding presence) — 040a.
- Let a user ADD a memory and EDIT an existing one, written through the daemon as version-bumped, reason-gated
  writes, with the UI reflecting the persisted value via re-read (never optimistic) — 040b.
- Surface the memory LIFECYCLE: trigger compaction (PRD-030) and dreaming (PRD-009/026) honestly (triggered vs
  skipped acks, never a fake spinner), and a WATCH mode that live-tails memory activity — 040c.
- Keep the page production-clean (no CDN React / no in-browser Babel), LOCAL-MODE-ONLY, XSS-safe, and secret-free.

## Non-Goals

- The nav shell, sidebar, client-side router, `<PageFrame>`, and route registry — those are PRD-037. This PRD adds
  the Memories page as ONE registry entry + the page component(s); it does not touch `sidebar.tsx` or `router.tsx`.
- The home-page quick-recall box (PRD-038b) — that stays the fast path on the Dashboard route; this is the full
  surface, not a replacement for it. Both POST the same `/api/memories/recall`.
- New recall RANKING / embeddings strategy — recall reuses the existing PRD-007/PRD-027 pipeline verbatim; this PRD
  renders the engine's hits + score + order, it does not re-tune them.
- New Deep Lake schema design or the version-bump WRITE mechanics — those live in the storage layer
  (`deeplake-dataset` / the `memories` catalog). This PRD CONSUMES the existing write/read/trigger endpoints and,
  where an endpoint is missing for a UI need, captures it as an Open Question / scoped FR, deferring the storage
  design to the owning Bee.
- The Cursor extension webview parity (`harnesses/cursor/extension/`) — a possible fast-follow, out of scope here.
- Team/hybrid-mode memory management. The page stays LOCAL-MODE-ONLY, exactly like the rest of `/dashboard`.

## Features

| Sub-PRD | Feature | Status |
|---|---|---|
| [prd-040a-memories-page-browse-search-view](./prd-040a-memories-page-browse-search-view.md) | Browse + search + view the memory corpus | Draft |
| [prd-040b-memories-page-add-edit](./prd-040b-memories-page-add-edit.md) | Add + edit memories (versioned CRUD) | Draft |
| [prd-040c-memories-page-compact-dream-watch](./prd-040c-memories-page-compact-dream-watch.md) | Compact + dream + watch the memory lifecycle | Draft |

## Acceptance Criteria

- [ ] **AC-1 — The page lives in the shell.** `GET /dashboard#/memories` renders the Memories page inside the
  PRD-037 shell via a single route-registry entry, using `<PageFrame>` + the injected `PageProps` `wire`/`daemonUp`,
  on existing DS tokens — no new design system, no CDN React, no in-browser Babel. Served by the existing esbuild
  entry. A DOM/unit test asserts the page mounts on the `#/memories` route.
- [ ] **AC-2 — Browse + search + view (040a).** The page lists memories from the `memories` table (paginated),
  search filters them through the recall pipeline, and opening a memory shows its full content + metadata.
- [ ] **AC-3 — Add + edit (040b).** A user can add a memory and edit an existing one through the daemon; an edit
  creates a NEW version (never a hard-update) and the UI reflects the persisted value by re-reading, not optimistic.
- [ ] **AC-4 — Compact + dream + watch (040c).** Compact and Dream controls invoke the REAL pipelines and reflect
  their acks honestly (triggered vs skipped); Watch mode shows live memory activity.
- [ ] **AC-5 — Security + gate.** The page is LOCAL-MODE-ONLY + XSS-safe; no token/secret renders in the page or any
  response it reads (memory content is escaped, never injected as HTML). `npm run ci` / `build` / `audit:sql` /
  `audit:openclaw` / invariant all green by construction (no new attacker-controlled SQL/identifier).

## Open Questions

- **OQ-1 — Read-model gap for the detail view.** The current `memory_list` / `memory_get` read-model
  (`src/daemon/runtime/memories/reads.ts` `MemoryRecord`) serializes only `{ id, type, content, confidence,
  agentId, createdAt, updatedAt }` — it does NOT expose `visibility` (scope), `source_id`/`source_type`,
  `version`, or embedding presence (`content_embedding != NULL`), all of which 040a's detail view wants. Does PRD-040
  widen the read-model (additive, daemon-side) or does the detail view live with the thin shape? Resolved in 040a;
  flagged here because it touches the daemon, not just the page.
- **OQ-2 — Is compaction safe to expose as a user button?** `POST /api/diagnostics/compact` (PRD-030) reaps version
  history across version-bumped tables under the scope. It is fail-soft and bounded, but it is a DESTRUCTIVE
  maintenance op (it prunes old versions). Should the Memories page expose it directly, behind a confirm, or only in
  a scoped "advanced/maintenance" affordance? Resolved in 040c.
- **OQ-3 — Watch transport: poll `/api/logs` vs a dedicated memory-events stream.** There is no memory-specific
  event stream today; the live feed is the polled `/api/logs` ring buffer (PRD-021d). Watch mode can reuse that
  (filtered to memory routes) for a zero-new-endpoint start, OR a real SSE memory-events stream could be added.
  040c proposes the poll-filter start and captures the SSE option as a deferred enhancement.
- **OQ-4 — Where does "Dream now" live?** PRD-037 D-5/OQ-4 keeps "Dream now" a global shell-chrome action. If the
  Memories page ALSO surfaces a Dream control (040c), do we keep both, or does the global one move onto this page?
  Coordinated with PRD-037 OQ-4; 040c proposes the page surfaces lifecycle controls without removing the global one.

## Related

- **Hosting shell (this page plugs into it):** PRD-037 Dashboard Nav Shell —
  `library/requirements/backlog/prd-037-dashboard-nav-shell/prd-037-dashboard-nav-shell-index.md` (the `#/memories`
  route, `<PageFrame>` + `PageProps`, the registry seam — PRD-037c AC-2).
- **Sibling home page (quick-recall box):** PRD-038 Dashboard home (038b keeps the fast-path recall box; this is the
  full management surface).
- **House style / prior art:** PRD-024 Dashboard UI Parity —
  `library/requirements/in-work/prd-024-dashboard-ui-parity/prd-024-dashboard-ui-parity-index.md` (D-1
  production-clean bundle, D-4 LOCAL-MODE + XSS + no-secret, the honest Dream-ack pattern).
- **Reused pipelines:** recall (PRD-007 / PRD-027 ranking), dreaming (PRD-009 loop / PRD-026 enablement),
  compaction (PRD-030 memory-compaction).
- **Source consumed (no new daemon surface unless an OQ resolves to add one):**
  `src/daemon/runtime/memories/api.ts` (recall / store / list / get / modify / forget),
  `src/daemon/runtime/memories/reads.ts` (the list/get read-model),
  `src/daemon/storage/catalog/memories.ts` (the `memories` + `memory_history` columns),
  `src/daemon/runtime/dreaming/api.ts` (`/api/diagnostics/dream`),
  `src/daemon/runtime/maintenance/compact-api.ts` (`/api/diagnostics/compact`),
  `src/daemon/runtime/logs/api.ts` (`/api/logs` ring buffer),
  `src/dashboard/web/wire.ts` (the `WireClient` + `RecalledMemory`), `src/dashboard/web/app.tsx` (the current recall
  UI + `MemoryCard` usage), `src/dashboard/web/panels.tsx` + `src/dashboard/web/primitives.tsx` (reused).

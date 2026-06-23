# PRD-040a: Browse + search + view the memory corpus

> **Parent:** [PRD-040 Memories Page](./prd-040-memories-page-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Overview

The reading half of the Memories page: a full-page browser over the `memories` engine table. It lists the scoped
tenant's memories (paginated), lets a user SEARCH them through the existing recall pipeline, and opens any memory
into a DETAIL view showing its full content plus metadata — scope, type, source, version, and embedding presence.
It is the foundation 040b (add/edit) and 040c (lifecycle) build their controls on top of.

Everything here is a READ against endpoints the daemon already serves. `GET /api/memories` lists the corpus
(`src/daemon/runtime/memories/api.ts` → `listMemories`, `reads.ts`); `GET /api/memories/:id` reads one memory
(`getMemory`); `POST /api/memories/recall` is the search path (the same engine the home recall box uses). The page
adds typed wire methods for list/get (the wire client only has `recall` today — see Implementation Notes) and the
React views; it adds NO new ranking and no new daemon surface, except possibly a widened read-model (OQ-1).

## Goals

- Render a paginated LIST of the scoped tenant's memories (newest first) from `GET /api/memories`, honoring the
  empty state ("No memories yet.") and the daemon's bounded page size.
- Provide a SEARCH box that POSTs `/api/memories/recall` and filters the list to the engine's ranked hits, rendered
  in the engine's order with its fused score (PRD-027) — no client-side re-sort, no fabricated score.
- Open any list row (or hit) into a DETAIL view showing the full content + metadata: scope (`visibility`/`agentId`),
  `type`, source (`source_type`/`source_id`), `version`, and embedding presence (whether `content_embedding` is set).
- Reuse the existing `MemoryCard` primitive and the `<PageFrame>` + `PageProps` contract from PRD-037 (the injected
  `wire`, `daemonUp`); add no new design system.

## Non-Goals

- ADD / EDIT / delete controls — those are 040b. 040a is read-only; the detail view is where 040b later hangs its
  Edit affordance, but 040a ships the view, not the mutation.
- Compaction / pollinating / watch — those are 040c.
- New recall ranking, hybrid weighting, or embedding strategy — recall is consumed verbatim (PRD-007/027).
- Cross-tenant or team-mode browsing — LOCAL-MODE single-tenant only, like the rest of `/dashboard`.

## User Stories

- As a developer dogfooding Honeycomb, I want to see EVERY memory the daemon has kept for my workspace, paginated,
  so I can audit what the pipeline distilled.
- As a developer, I want to search my memories with a natural-language query and see the ranked matches, so I find
  the fact I half-remember.
- As a developer, I want to click a memory and read its FULL content plus where it came from, what scope it is in,
  which version it is, and whether it is semantically indexed — so I understand and trust it.

## Implementation Notes

- **New page component:** `src/dashboard/web/pages/memories.tsx` (the `#/memories` route's `component` in the
  PRD-037 registry). It receives `PageProps` ({ `wire`, `daemonUp`, `assetBase` }) and renders inside `<PageFrame>`
  (eyebrow `memories` + title). It does NOT call `createWireClient` itself — it uses the injected `wire` (PRD-037c).
- **Wire methods to add (`src/dashboard/web/wire.ts`):** the client today exposes only `recall`. Add:
  - `listMemories(limit?: number): Promise<MemoryRecordWire[]>` → `GET /api/memories` (returns `{ memories }`).
  - `getMemory(id: string): Promise<MemoryRecordWire | null>` → `GET /api/memories/:id` (returns `{ memory }` or 404).
  Both stamp `DASHBOARD_SESSION_HEADERS` (the `/api/memories` group is a SESSION group — it requires
  `x-honeycomb-runtime-path` + `x-honeycomb-session`, already stamped by the existing wire helpers), zod-parse the
  body with `.catch()` defaults (a malformed/partial payload degrades to empty, never throws — the established
  wire.ts posture), and degrade to `[]` / `null` on any failure.
- **Wire schema:** a `MemoryRecordSchema` mirroring `reads.ts` `MemoryRecord` (`{ id, type, content, confidence,
  agentId, createdAt, updatedAt }`), every field `.catch()`-defaulted. IF OQ-1 resolves to widen the read-model, the
  schema gains `visibility`, `sourceType`, `sourceId`, `version`, `hasEmbedding`, each `.catch()`-defaulted so an
  older daemon (thin shape) still renders.
- **List + search interplay:** mount → `wire.listMemories()` hydrates the browse list. A non-empty search box →
  `wire.recall(query)` swaps the list for the ranked hits (reusing the `RecalledMemory` shape + `MemoryCard`,
  identical to `app.tsx`'s recall render, including the PRD-029 `degraded` "lexical fallback" badge). Clearing the
  box restores the full list. Pagination is a "load more" (bump the `limit`, re-list) — the daemon clamps to
  `MAX_LIST_LIMIT` (500) per `resolveListLimit`.
- **Detail view:** clicking a row opens a detail panel/modal that calls `wire.getMemory(id)` and renders the full
  content + the metadata fields. `getMemory` resolves the HIGHEST version and drops a tombstone (`is_deleted = 1`),
  so a forgotten memory reads as "not found" — render that honestly (404 → "This memory was forgotten.").
- **Metadata honesty:** render EXACTLY what the daemon serves. Scope is `visibility` + `agentId`; "embedding
  presence" is a boolean derived from whether the row has a non-null `content_embedding` — which the read-model does
  NOT expose today (OQ-1). If OQ-1 is deferred, the detail view shows the thin shape and labels the absent fields
  "not available in this view" rather than fabricating them.
- **XSS:** memory content is rendered as TEXT (React escapes by default) — never `dangerouslySetInnerHTML`. The
  content came from captured traces and could contain markup; it must never execute (PRD-024 D-4 / AC-5).

## Acceptance Criteria

- [ ] **AC-1 — The page lists memories.** On `#/memories`, the page hydrates from `GET /api/memories` and renders
  the scoped tenant's memories newest-first; the empty corpus shows an honest empty state. Unit-tested with a mocked
  `wire`.
- [ ] **AC-2 — Search filters them.** Typing a query and submitting POSTs `/api/memories/recall`; the list is
  replaced by the engine's ranked hits rendered in engine order with the engine score (no client re-sort, no
  fabricated score); clearing the box restores the full list. The PRD-029 `degraded` badge shows when recall fell
  back to lexical.
- [ ] **AC-3 — A detail view renders.** Clicking a memory opens a detail view that calls `GET /api/memories/:id` and
  shows the full content plus the available metadata (scope/type/source/version/embedding presence per OQ-1); a
  forgotten/unknown id renders the "not found / forgotten" state, not a crash.
- [ ] **AC-4 — Thin client, reused wire.** The page uses the injected `PageProps.wire` (never `createWireClient`),
  reuses `<PageFrame>` + `MemoryCard`, and adds the `listMemories`/`getMemory` wire methods with zod-defaulted
  parsing that degrades to empty on failure — no `any` crosses the fetch boundary.
- [ ] **AC-5 — Security.** Memory content renders as escaped text (no `dangerouslySetInnerHTML`); no token/secret in
  the list, detail, or search responses the page reads; LOCAL-MODE-ONLY inherited from the shell. A DOM test asserts
  content is escaped.

## Open Questions

- **OQ-1 (parent OQ-1) — Widen the read-model?** The detail view wants `visibility`, `source_type`/`source_id`,
  `version`, and embedding presence, none of which `reads.ts` `MemoryRecord` serializes today. Proposed: widen the
  read-model additively (daemon-side, owned by `deeplake-dataset`/`typescript-node`), all new fields optional so an
  older client degrades. If deferred, 040a ships the thin detail view and labels the gaps. Confirm before build.
- **OQ-2 — Search-then-open identity.** A recall hit carries `{ source, id, kind, secondary }` where `kind` can be
  `"session"` (a raw drill-down) not a distilled `memory`. `GET /api/memories/:id` only resolves `memories` rows —
  opening a `session`-kind hit has no detail target. Proposed: the detail affordance is enabled only for
  `kind === "memory"` hits; session hits render their snippet inline without a detail link. Confirm in 040a.
- **OQ-3 — Pagination shape.** "Load more" by bumping `limit` re-scans from the top (the daemon has no cursor). For
  the dogfood corpus size this is fine; a keyset cursor is a later enhancement if corpora grow. Flagged, not blocking.

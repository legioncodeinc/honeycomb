# PRD-040b: Add + edit memories (versioned CRUD)

> **Parent:** [PRD-040 Memories Page](./prd-040-memories-page-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Overview

The writing half of the Memories page: controls to manually ADD a new memory and EDIT an existing one, both written
THROUGH the daemon. The governing constraint is the memory substrate's write model: `memories` rows are
**versioned and append-only** — the controlled-writes engine lands every change as a new version bump, and
`memory_history` (`src/daemon/storage/catalog/memories.ts`) is the immutable audit trail of every proposal. An edit
is therefore NEVER a hard-update of a row: it appends a NEW version of the memory, and the prior version remains in
history. The UI must reflect this honestly — after a write, it RE-READS the memory (via 040a's `getMemory`) and
renders the persisted value, never an optimistic local echo.

The daemon already serves the write endpoints this needs: `POST /api/memories` adds a memory (store), and
`POST /api/memories/:id/modify` edits one — and `modify` is REASON-GATED (its zod body requires a non-empty
`reason`, `src/daemon/runtime/memories/api.ts` `ModifyBodySchema`) and audited. So no NEW write endpoint is
required for the core add/edit flow; this sub-PRD wires the UI to the existing controlled-writes surface and adds
the corresponding typed wire methods (the wire client has none today).

## Goals

- An ADD control (form: content + optional type + optional reason/agent) that POSTs `/api/memories`, lands a real,
  recallable row, and refreshes the browse list (040a) to show it.
- An EDIT control on a memory's detail view (040a) that POSTs `/api/memories/:id/modify` with the new content and a
  REQUIRED reason, creating a NEW version (never a hard-update).
- After any write, RE-READ the affected memory (`getMemory`) / re-list, so the UI shows the daemon-persisted value —
  never optimistic. A rejected write (daemon 400/validation) leaves the UI showing the unchanged persisted value.
- Validate inputs at the boundary the same way the daemon does (non-empty content; non-empty reason for edits) so a
  malformed submit is caught before the round-trip, and the daemon's zod 400 is surfaced honestly if it still fails.
- Document the append-version-bumped constraint in the page (a short "edits create a new version" note) so the user
  understands why history grows and why the UI re-reads.

## Non-Goals

- Browse / search / detail rendering — that is 040a (this sub-PRD adds Add/Edit controls ONTO 040a's surface).
- Hard DELETE. The daemon's delete is `POST /api/memories/:id/forget`, a reason-gated SOFT-delete (a tombstone
  version, `is_deleted = 1`). Whether the page exposes "forget" is captured as an Open Question, not assumed in scope.
- Designing or changing the version-bump WRITE mechanics, the dedup `content_hash` check, or the `memory_history`
  schema — those are storage-layer concerns (`deeplake-dataset` / the `memories` catalog). This sub-PRD CONSUMES the
  store/modify endpoints; it does not re-implement the writer.
- Bulk import / bulk edit. One memory at a time.
- Team/hybrid-mode writes — LOCAL-MODE single-tenant only.

## User Stories

- As a developer, I want to hand-write a memory ("we deploy via `just release`") so the daemon remembers a fact the
  pipeline never captured, and see it appear in my browse list and recall.
- As a developer, I want to correct a wrong memory by editing its content with a reason, and trust that the old
  version is preserved in history and the new one is what now shows.
- As a developer, I want the UI to show me the ACTUAL persisted memory after I save — not a hopeful local copy that
  might diverge from what the daemon stored.

## Implementation Notes

- **Wire methods to add (`src/dashboard/web/wire.ts`):**
  - `addMemory(input: { content: string; type?: string; agentId?: string }): Promise<{ id: string | null;
    action: string } | null>` → `POST /api/memories` (the store handler returns `{ id, action }`, 201). Mirrors the
    daemon's `StoreBodySchema` (content required; type/normalizedContent/agentId optional).
  - `modifyMemory(id: string, input: { content: string; reason: string; agentId?: string }): Promise<{ id: string |
    null; action: string; audited: boolean } | null>` → `POST /api/memories/:id/modify`. Mirrors `ModifyBodySchema`
    (content + REQUIRED reason). The `reason` is the audit cause stamped into `memory_history`.
  Both stamp `DASHBOARD_SESSION_HEADERS`, set `content-type: application/json`, zod-parse the ack with `.catch()`
  defaults, and return `null` on a non-2xx / network failure (the caller surfaces "save failed", re-reads, and shows
  the unchanged persisted value).
- **Re-read, never optimistic (the parent's hard rule):** the save flow is `write → re-read → setState(persisted)`,
  exactly the pattern `app.tsx`'s `saveSetting` already uses for vault settings (write through the daemon, then
  `vaultSettings()` re-read, render the persisted truth). 040b applies the SAME pattern: after `addMemory` re-list;
  after `modifyMemory` re-`getMemory(id)`. No state is set from the form values directly.
- **Add form:** content (required, textarea), type (optional, defaults to the daemon's `'fact'`), optional reason
  note. Submit disabled while in flight and when content is empty. On 201, clear the form and refresh the list;
  surface the new id. On a daemon 400 (zod), show the validation message.
- **Edit form:** opened from 040a's detail view, pre-filled with the current content, a REQUIRED reason field
  (the daemon rejects a modify without one — surface that requirement in the UI, do not let an empty reason submit).
  On success, re-read and show "saved · new version"; the detail view now shows the new content.
- **Versioning note in the UI:** a short, honest line near the edit control — "Edits append a new version; the prior
  version is kept in history" — so the append-only model is visible, not hidden.
- **Validation parity:** the client pre-validates (non-empty content; non-empty reason for modify) to fail fast, but
  treats the DAEMON as the source of truth — a client that passes but the daemon rejects shows the daemon's 400
  reason. No write bypasses the daemon (the page never touches Deep Lake directly — PRD-020b posture).
- **Security:** the write bodies carry content + a reason only — no token/secret. The page renders the persisted
  content as escaped text (040a's XSS rule). The `/api/memories` group is auth/RBAC-gated (open in local mode);
  the writes inherit it with no new identifier or SQL the page controls.

## Acceptance Criteria

- [ ] **AC-1 — A user can add a memory.** The Add form POSTs `/api/memories`; on the 201 ack the browse list (040a)
  refreshes and the new memory appears (and is recallable). Unit-tested with a mocked `wire` asserting the POST body
  shape + the list refresh.
- [ ] **AC-2 — A user can edit a memory.** The Edit form (on the detail view) POSTs `/api/memories/:id/modify` with
  the new content + a required reason; an empty reason cannot submit (and the daemon would reject it anyway). Tested.
- [ ] **AC-3 — Edits create a new version, not a hard-update.** The flow uses `modify` (append-version-bumped), and
  the PRD documents/asserts that the prior version persists in history — the UI never hard-overwrites. A test asserts
  the modify endpoint is called (not a hypothetical PUT/replace) and the UI re-reads.
- [ ] **AC-4 — UI reflects the persisted value (re-read, not optimistic).** After add or edit, the page RE-READS
  (`getMemory` / re-list) and renders the daemon-persisted value; no state is set from the form values. A test drives
  a write whose ack differs from the form input and asserts the UI shows the RE-READ value.
- [ ] **AC-5 — Honest failure.** A rejected write (daemon 400 / network fail) surfaces the failure and leaves the UI
  showing the unchanged persisted memory (re-read), never a phantom local edit. Tested.
- [ ] **AC-6 — Security + gate.** Write bodies carry only content + reason (+ optional type/agent) — no token/secret;
  persisted content renders escaped; LOCAL-MODE-ONLY inherited. `npm run ci` / `audit:sql` / `audit:openclaw` green.

## Open Questions

- **OQ-1 — Expose "forget" (soft-delete) on the page?** The daemon serves `POST /api/memories/:id/forget` (a
  reason-gated soft-delete → a tombstone version). It is a natural neighbor of edit, but DELETE-class affordances
  carry more risk. Proposed: include "forget" behind a confirm in a follow-up, OR scope it into 040b behind an
  explicit confirm dialog. Decide before build; not assumed in the ACs above.
- **OQ-2 — `normalizedContent` on add.** `StoreBodySchema` accepts an optional `normalizedContent` (the dedup key
  basis via `content_hash`). The page does not compute it; the daemon/pipeline derives it. Proposed: the page omits
  it and lets the daemon normalize — confirm the store path normalizes when the client omits it, so dedup still works.
- **OQ-3 — Optimistic-looking latency.** DeepLake is eventually consistent (project memory: poll until convergence).
  A re-read immediately after a write may not yet show the new version. Proposed: the re-read polls briefly until the
  new version/id is visible (the established poll-until-convergence pattern), so "re-read, not optimistic" does not
  surface a stale read as a phantom failure. Confirm the poll budget in 040b.

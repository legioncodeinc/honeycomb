# PRD-042c: Sync Page — Sync activity + state

> **Status:** Backlog
> **Priority:** P1
> **Effort:** S
> **Parent:** [PRD-042 Sync Page](./prd-042-sync-page-index.md)

## Overview

The third surface of the Sync page: a view of **recent sync activity** (publishes, pulls, tombstones) and
the **overall sync state per scope** (org / team / personal). Where 042a/042b are the per-asset manager,
this sub-PRD is the at-a-glance "what just synced, and where do we stand" panel — so a user who promotes a
skill or a teammate who pulls an agent can see the event land, and anyone can read the current state of the
substrate from their vantage point.

It reuses the live-log / SSE infrastructure where the events already flow through it: the daemon's
`/api/logs` ring buffer plus the `/api/logs/stream` Server-Sent-Events follow tail
(`src/daemon/runtime/logs/api.ts`, `mountLogsApi`), which the PRD-024 LiveLog panel already consumes. The
sync actions in 042a/042b emit log records as they publish/pull/tombstone; this view filters and renders
the sync-relevant ones, and shows the converged per-scope counts. Honesty is the bar: it never fabricates
an event or a "synced" state the substrate does not actually hold.

## Goals

- **G-1** — A recent-activity feed of sync events (publish / pull / tombstone), newest first, with the asset
  name, kind (skill/agent), actor/scope, and outcome.
- **G-2** — A per-scope sync-state summary: how many assets are `shared` at org / team and `local`/`pulled`
  for the user, sourced from the union view-model + the `synced_assets` current-version reads.
- **G-3** — Live updates: the feed follows new events via the existing SSE stream where they flow through it,
  so a promote/pull shows up without a manual refresh.
- **G-4** — Honest state only: every row and count reflects a converged read of the substrate, never an
  optimistic or fabricated value.

## Non-Goals

- **Not** the per-asset list/detail/promote/control — that is 042a (skills) / 042b (agents).
- **Not** a new streaming transport or a new log store. Reuse `/api/logs` + `/api/logs/stream`
  (`src/daemon/runtime/logs/api.ts`); add a dedicated sync-event source only if the publish/pull/tombstone
  paths do not already emit a log record.
- **Not** a full audit log of the append-only `synced_assets` version history. This is a recent-activity
  feed + current-state summary, not a version-by-version forensic timeline (that history lives in the table).
- **Not** changing the security posture: no secret/`native` blob/author email in any event line or count.

## User Stories

- As a dev who just promoted a skill, I see a "published skill `<name>` to team" event appear in the activity
  feed within a second, confirming the action landed.
- As a teammate, I watch pulls and publishes from others stream into the feed and understand what is moving.
- As a maintainer, I read the per-scope summary — "12 shared at team, 3 local-only, 1 pulled" — and know the
  current sync posture at a glance.

## Acceptance Criteria

- [ ] **c-AC-1 — Activity feed renders real events.** The feed shows recent sync events (publish / pull /
  tombstone) from the `/api/logs` source, newest first, each with asset name, kind, scope/actor, and outcome —
  no fabricated events.
- [ ] **c-AC-2 — Live follow.** New sync events stream into the feed via `/api/logs/stream` (SSE) where they
  flow through it, with no manual refresh; the stream backfills recent records then follows the tail.
- [ ] **c-AC-3 — Per-scope state summary.** The page shows the current per-scope counts (org / team `shared`,
  user `local`/`pulled`) from a converged read of the union view-model + `synced_assets`, matching what the
  042a/042b lists show — no drift between the summary and the per-asset views.
- [ ] **c-AC-4 — Honest, converged state.** Every count reflects a poll-convergent read (`RESOLVE_POLLS`
  shape); the summary never shows a `shared` count the substrate has not durably accepted, and updates after a
  promote/pull/demote on the next converged read.
- [ ] **c-AC-5 — Security + gate.** No token/secret/`native` blob/author-email in any event line or count
  (grep-proven); reuses the existing `/api/logs` security (records carry no secret per `logger.ts`). Any new
  daemon read uses `sqlIdent`/`sLiteral`; `npm run ci` / `audit:sql` / `audit:openclaw` / invariant green.
- [ ] **c-AC-6 — Live verification.** Against a real assembled daemon: promote a skill and a pull both appear
  in the feed and move the per-scope counts, verified by a gated live itest that polls for convergence.

## Implementation Notes

- **Activity source:** `mountLogsApi` (`src/daemon/runtime/logs/api.ts`) — `GET /api/logs` (JSON snapshot,
  newest last) for the initial backfill + `GET /api/logs/stream` (SSE `event: "log"`) for the follow tail.
  The PRD-024 LiveLog panel already consumes this; the Sync activity feed filters to sync-relevant records.
- **Event emission:** the 042a/042b promote/pull/tombstone actions emit a log record as they run; if the
  current publish/pull/tombstone paths do not already log, add the record emission at those seams (small,
  in the daemon) rather than a parallel event store. Records carry no secret (`logger.ts`), so each SSE line
  is safe to render verbatim.
- **State summary:** derive counts from the same PRD-036 union view-model the 042a/042b lists use, plus the
  `synced_assets` current-version reads (`buildCurrentAssetVersionSql`), so the summary and the per-asset
  views never disagree. Scope resolution follows the PRD-022 rules the other dashboard endpoints use.
- **UI:** reuse the existing LiveLog panel rendering + `Badge` primitives (`src/dashboard/web/panels.tsx`,
  `primitives.tsx`); the page-frame is PRD-037c.

## Open Questions

- **c-OQ-1** — Does the activity feed scope to the current workspace or show org-wide sync events the user can
  see? (Parent OQ-3 — tie to PRD-022 scope resolution.)
- **c-OQ-2** — Do the publish/pull/tombstone paths already emit a `/api/logs` record, or must 042c add the
  emission? If they do not, the emission lands in the daemon at those seams (and 042a/042b reference it).
- **c-OQ-3** — Is "personal" scope in the per-scope summary the user's `local`+`pulled` assets, or a distinct
  Device-tier (`device_set`) audience? Resolve against the PRD-033 tier model before build.

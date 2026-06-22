# PRD-042a: Sync Page — Skills view + promote/control

> **Status:** Backlog
> **Priority:** P1
> **Effort:** M
> **Parent:** [PRD-042 Sync Page](./prd-042-sync-page-index.md)

## Overview

The skills half of the Sync page: a full-page skills manager mounted in the PRD-037 `#/sync` frame. It
lists every skill from the PRD-036 `installed ∪ synced` union view-model with its honest state
(`local` / `pulled` / `shared`), opens a detail view for any one skill, and exposes the action surface —
**promote** a `local`/personal skill to the team (publish into `synced_assets` through the existing
publish pipeline) plus the **control** actions (pull, demote/tombstone, enable/disable). It supersedes
the cramped read-only `SkillSyncPanel` (`src/dashboard/web/panels.tsx`) for skills.

This sub-PRD owns the skills surface and the action wiring for skills. Agents (042b) reuse the same
components and daemon seams parameterized over `asset_type='agent'`; activity/state (042c) renders the
events these actions emit.

## Goals

- **G-1** — List all skills from the PRD-036 union view-model with state badges (`local`/`pulled`/`shared`),
  no double-count for a skill that is both local and in `synced_assets`.
- **G-2** — A skill detail view: name, description, provenance (author/source), scope, source harness,
  tier/style, current version, state.
- **G-3** — **Promote**: publish a `local` skill into `synced_assets` via `createSkillPublishEndpoint.publish`
  (a version-bumped row), flipping its state to `shared` on a poll-convergent read-back.
- **G-4** — **Control**: pull a teammate's skill (daemon pull client), demote/tombstone a stale one
  (`tombstone='true'` version-bump), enable/disable — each invoking the real pipeline and reflecting persisted state.

## Non-Goals

- **Not** agents — that is 042b (same components, `asset_type='agent'`).
- **Not** the activity feed / per-scope state view — that is 042c.
- **Not** the discovery/union view-model — consumed from PRD-036; if a detail field is missing, it is added
  to the PRD-036 contract, not re-derived here.
- **Not** a new substrate, table, or DeepLake client. Promote/pull/demote reuse PRD-033/016/018 seams.
- **Not** redefining who may publish to org vs team — that authz is PRD-018's; this surface invokes and
  honestly reflects it (a disabled control when not permitted).

## User Stories

- As a solo dev, I open `#/sync`, see my 27 local skills, and **promote** the three worth sharing to the team
  in one action each — and watch each flip from `local` to `shared`.
- As a teammate, I see a skill another author published with state `shared`-but-not-pulled, **pull** it, and it
  installs locally and shows as `pulled`.
- As a maintainer, I find a stale team skill and **demote** it; it tombstones in the substrate and stops
  appearing as `shared` to the team on the next converged read.
- As any user, I select a skill and read its provenance, scope, source harness, tier/style, and version before
  deciding to promote or pull it.

## Acceptance Criteria

- [ ] **a-AC-1 — Skills list = the union.** The skills view lists every skill from the PRD-036 union view-model,
  each with its state badge (`local`/`pulled`/`shared`); a skill both local and in `synced_assets` appears once.
- [ ] **a-AC-2 — Detail view.** Selecting a skill opens a detail view with name, description, provenance, scope,
  source harness, tier/style, current version, and state — no `native` blob / author email / org GUID rendered.
- [ ] **a-AC-3 — Promote publishes for real.** Promoting a `local` skill calls `createSkillPublishEndpoint.publish`
  (a version-bumped `synced_assets`/`skills` row, never an in-place UPDATE); on a poll-convergent read-back the
  skill's state is `shared`. Unit-tested at the seam + a gated live check against a real assembled daemon.
- [ ] **a-AC-4 — Pull works.** Pulling a `shared` (un-pulled) skill drives the daemon pull client
  (`readLatestSkills`, poll-convergent), installs it to the harness skills dir, and the row shows `pulled`.
- [ ] **a-AC-5 — Demote tombstones.** Demoting writes a fresh version with `tombstone='true'` (PRD-033 D-5);
  on the converged read the skill no longer presents as live `shared`. The prior versions survive in the log.
- [ ] **a-AC-6 — Enable/disable invokes the real seam.** Enable/disable calls the real pipeline (per OQ-2's
  resolution — substrate state vs install toggle) and reflects the persisted result, never a UI-only flip.
- [ ] **a-AC-7 — In-flight, then converged.** Each action shows an in-flight state and only confirms success
  after the poll-convergent read-back (`RESOLVE_POLLS` shape) — no optimistic flip the substrate has not accepted.
- [ ] **a-AC-8 — Security + gate.** Local-mode-only, XSS-safe, no secret/blob/email in the page or any action
  response; new daemon SQL through `sqlIdent`/`sLiteral`; thin-client invariant + `npm run ci` + `audit:sql` green.

## Implementation Notes

- **List source:** the PRD-036 union view-model (the `fetchSkillSyncView` successor), fetched through the
  dashboard wire client (`src/dashboard/web/wire.ts`) like the other `/api/diagnostics/*` views. The page does
  not re-scan disk or re-query `synced_assets` for the list.
- **Promote seam:** reuse `createSkillPublishEndpoint.publish` (`src/daemon/runtime/skillify/publish-endpoint.ts`) —
  append-only, version-bumped. The promote endpoint is daemon-side (it holds `StorageQuery`); the page dispatches
  over the 3850 seam (mirror `pull-client.ts`'s `DaemonDispatch`). No new DeepLake client in the thin client.
- **Pull seam:** `createDaemonPullClient.readLatestSkills` (`src/daemon-client/skillify/pull-client.ts`) +
  the install target (`src/daemon/runtime/skillify/install-target.ts`, `.claude/skills/<name>/SKILL.md`).
- **Demote seam:** a `synced_assets` version-bump with `tombstone=TOMBSTONE_TRUE`
  (`src/daemon/storage/catalog/synced-assets.ts`) — same append-only path as publish, `tombstone` flipped.
- **Read-back:** every confirm polls until the highest version converges (the publish endpoint's
  `selectNewerForOrgUsers` / `buildCurrentAssetVersionSql` current-version read), never a single immediate read.
- **UI:** built from the existing primitives (`src/dashboard/web/primitives.tsx` — `Badge`/`Button`) and the
  `SYNC_TONE` state→tone map already in `panels.tsx`; the page-frame comes from PRD-037c.

## Open Questions

- **a-OQ-1** — Does promote expose the full `tier × style` lattice or default to Team/Repository? (Parent OQ-1.)
- **a-OQ-2** — Is enable/disable a substrate lifecycle state or a local install toggle? (Parent OQ-2 — blocks
  a-AC-6's exact seam.)
- **a-OQ-3** — Demote permission: own skills only, or any visible skill? Disable the control when not permitted
  rather than attempt-and-fail. (Parent OQ-4.)

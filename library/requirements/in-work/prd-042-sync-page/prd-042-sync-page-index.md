# PRD-042: Sync Page (view · promote · control skills and agents)

> **Status:** Backlog
> **Priority:** P1
> **Effort:** L

## Overview

The asset-sync substrate (PRD-033) already persists skills and agents across a team in the additive
DeepLake `synced_assets` table — one version-bumped row per published artifact version, keyed
`(asset_type, harness)`, with a `tombstone` flag, a `tier × style` placement, and explicit
`org`/`workspace`/`author` tenancy (`src/daemon/storage/catalog/synced-assets.ts`,
`SYNCED_ASSET_TYPES = ["skill", "agent"]`). The skillify publish/pull pipelines
(`src/daemon/runtime/skillify/publish-endpoint.ts`, `src/daemon-client/skillify/pull-client.ts`) move
skills onto and off of that substrate. And PRD-036 stands up the missing data backbone: a daemon-side
local discovery pass plus a **union view-model** (`installed ∪ synced`) where every skill and agent
carries an honest state (`local` / `pulled` / `shared`).

What is missing is a place to **act**. Today the only surface is the dashboard's read-only
`SkillSyncPanel` (`src/dashboard/web/panels.tsx`), a compact list with no detail view, no promote
action, and no control surface. A user can see (after PRD-036) that a skill is `local` — but cannot
promote it to the team, cannot pull a teammate's skill, cannot demote/tombstone a stale one, and cannot
see what sync has recently happened. This definitely warrants its own page.

This PRD builds the **Sync page**: a full, dedicated management surface mounted on the **PRD-037** nav
shell's `#/sync` route. It **consumes** the PRD-036 discovery + union view-model as its read backbone and
adds the management UX on top — a skills manager (list + detail + promote + control), a symmetric agents
manager, and a sync activity + state view. Every write action invokes the **real** existing pipeline
(publish to `synced_assets` via `createSkillPublishEndpoint.publish`, pull via the daemon pull client,
demote via a `tombstone='true'` version-bump per PRD-033 D-5) — never a mock — and reflects the persisted
state back, poll-convergently (the substrate serves reads from segments of differing freshness, so a
write must be confirmed by a converged read, never a single immediate one).

## Goals

- **G-1 — A dedicated page, not a panel.** Promote the skill/agent surface off the cramped read-only
  `SkillSyncPanel` onto its own routed page under the PRD-037 shell (`#/sync`), with room to list, inspect,
  promote, and control.
- **G-2 — View every skill and agent with honest state.** List the full `installed ∪ synced` union from the
  PRD-036 view-model — each row tagged `local` / `pulled` / `shared` — and open a detail view showing
  provenance, scope, source harness, tier/style, and version.
- **G-3 — Promote a local asset to the team.** A one-action promote that publishes a local/personal skill or
  agent into the `synced_assets` substrate through the existing publish pipeline (a version-bumped row), so
  teammates can pull it.
- **G-4 — Control actions that invoke the real pipelines.** Pull, demote (tombstone), and enable/disable —
  each calling the real skillify/substrate seam and reflecting the persisted result, not a UI-only toggle.
- **G-5 — Symmetric skills and agents.** Agents (`asset_type='agent'`, living under `.claude/agents/`,
  `.cursor/agents/`) are first-class on the page, managed identically to skills — not an afterthought.
- **G-6 — Honest sync activity + state.** Show recent sync events (publishes, pulls, tombstones) and the
  current sync state per scope (org / team / personal), reusing the live-log / SSE infrastructure where it fits.

## Non-Goals

- **Not** the discovery or union view-model itself. The local scanner and the `installed ∪ synced` contract
  are **PRD-036**; this page is a pure consumer of that backbone (hard dependency).
- **Not** the nav shell, router, or registry. The `#/sync` route slot, the sidebar entry, and the shared
  page-frame are **PRD-037**; this PRD fills the Sync page's content into that frame.
- **Not** a new substrate or schema. Promote/pull/demote reuse the PRD-033 `synced_assets` table and the
  PRD-016/018 skillify publish/pull pipelines unchanged — no new table, no column add, no new DeepLake client.
- **Not** new harness wiring or new install targets. The page acts on the harness asset directories that
  already exist (PRD-019); it does not add a harness.
- **Not** changing the LOCAL-MODE-ONLY + XSS-safe + no-secret-in-page security posture (PRD-021d F-1 /
  PRD-024 D-4 / PRD-037 D-9). The page inherits it; no `native` blob, author email, or org GUID leaks into
  the rendered page.
- **Not** the team-sharing promotion *policy* (who may publish to org vs team) — that authz lives in the
  PRD-018 publish path; this page surfaces and invokes it, it does not redefine it.

## Features

| Sub-PRD | Feature | Status |
|---|---|---|
| [prd-042a-sync-page-skills-view-promote-control](./prd-042a-sync-page-skills-view-promote-control.md) | Skills view + promote/control (list, detail, promote, pull, demote, enable/disable) | Draft |
| [prd-042b-sync-page-agents-view-promote-control](./prd-042b-sync-page-agents-view-promote-control.md) | Agents view + promote/control (symmetric to skills, `asset_type='agent'`) | Draft |
| [prd-042c-sync-page-activity-and-state](./prd-042c-sync-page-activity-and-state.md) | Sync activity feed + per-scope sync state | Draft |

## Acceptance Criteria

- [ ] **AC-1 — The page exists and lists the union.** `#/sync` (PRD-037 shell) renders a dedicated Sync page
  built only from the existing DS tokens/primitives, served production-clean (no CDN React, no in-browser
  Babel). It lists every skill **and** agent from the PRD-036 `installed ∪ synced` union view-model, each with
  its honest state badge (`local` / `pulled` / `shared`) — no double-count for an asset that is both local and
  in the substrate.
- [ ] **AC-2 — Detail view is honest.** Selecting a skill or agent opens a detail view showing provenance
  (author/source), scope, source harness, tier/style, and current version — sourced from the union view-model
  and the `synced_assets` current-version read, never a secret/`native`-blob leak.
- [ ] **AC-3 — Promote publishes for real.** Promoting a `local` skill or agent publishes a version-bumped row
  into `synced_assets` through the existing publish pipeline (`createSkillPublishEndpoint.publish` /
  PRD-033 substrate write), and the row's state flips to `shared` on a **poll-convergent** read-back (not a
  single immediate read). Proven against a real assembled daemon.
- [ ] **AC-4 — Control actions invoke the real pipelines.** Pull, demote (tombstone), and enable/disable each
  call the real skillify/substrate seam (pull via the daemon pull client; demote via a `tombstone='true'`
  version-bump per PRD-033 D-5) and reflect the persisted result on a converged read — never a UI-only toggle.
- [ ] **AC-5 — Agents are symmetric.** Every list/detail/promote/control capability that works for skills works
  identically for agents (`asset_type='agent'`), proven by the same tests parameterized over both asset types.
- [ ] **AC-6 — Activity + state are honest.** The page shows recent sync events (publishes, pulls, tombstones)
  and the current per-scope sync state (org / team / personal), reusing the `/api/logs` + SSE infra where it
  fits; it never fabricates an event or a "synced" state that the substrate does not actually hold.
- [ ] **AC-7 — Security + gate unchanged.** The page stays LOCAL-MODE-ONLY + XSS-safe; no token/secret/`native`
  blob/author-email in the served page, the view-model responses, or any action response (grep-proven). Every
  new daemon read/write goes through the `sqlIdent`/`sLiteral` guards; `npm run ci` / `build` / `audit:sql` /
  `audit:openclaw` / invariant all green.
- [ ] **AC-8 — Live verification.** Against a real assembled daemon: a `local` skill promotes to `shared`, a
  teammate-published skill pulls, a demote tombstones, and the activity feed shows those events — each verified
  by a gated live itest that polls for convergence, plus a DOM/unit test asserting the page structure renders.

## Decisions

- **D-1 — Consume PRD-036, do not re-derive.** The page reads the PRD-036 `installed ∪ synced` union
  view-model as its single read backbone for both skills and agents. It does not re-scan disk or re-query
  `synced_assets` for the list; it adds the **actions** layer (detail, promote, control) on top. If the union
  view-model lacks a field the detail view needs (e.g. tier/style/version), that field is added to the
  PRD-036 contract, not duplicated here.
- **D-2 — Promote = the existing publish pipeline, append-only.** Promote calls the real
  `createSkillPublishEndpoint.publish` (skills) / the symmetric `synced_assets` substrate write (agents) —
  a version-bumped INSERT, never an in-place UPDATE (PRD-033 D-5: DeepLake coalesces UPDATEs against freshly
  written rows and silently drops one). Demote writes a fresh version with `tombstone='true'`; the prior
  versions survive in the append-only log.
- **D-3 — Reads and write-confirms are poll-convergent.** Every read-back after an action polls until the
  highest version converges (the `RESOLVE_POLLS` shape the publish endpoint and pull client already use),
  because a single read on this backend can land on a stale segment and under-report a version. The UI shows
  an in-flight state until the converged read confirms — never an optimistic flip that the substrate has not
  durably accepted.
- **D-4 — Daemon-side actions only; the page is a thin client.** The page never opens DeepLake. Promote /
  pull / demote / enable-disable dispatch to daemon endpoints (mirroring the `publish-endpoint.ts` seam and
  the `pull-client.ts` 3850 dispatch); the daemon is the sole DeepLake client and applies the org/workspace
  scope as a partition filter. The thin-client invariant test stays green.
- **D-5 — Security inherited from PRD-037/024.** Local-mode-only, XSS-safe, no secret in the page. The
  `native` verbatim blob, author email, and org GUID are NEVER rendered; the detail view shows only
  presentation-safe fields (name, description, scope, harness, tier/style, version, state). New daemon
  surface builds SQL through `sqlIdent`/`sLiteral` so `audit:sql` stays clean.
- **D-6 — Activity reuses the live-log seam.** Sync activity reuses the `/api/logs` ring buffer + the
  `/api/logs/stream` SSE follow (`src/daemon/runtime/logs/api.ts`) where the events already flow through it;
  a dedicated sync-event source is added only if the publish/pull/tombstone paths do not already emit a log
  record. No new streaming transport is introduced.

## Open Questions

- **OQ-1** — Does promote default to **Team** tier (workspace audience) or expose the full `tier × style`
  lattice (`Local`/`Device`/`Team` × `Repository`/`User`) at promote time? Lean: default Team/Repository with
  an advanced control for the rest; confirm against the PRD-018 sharing model.
- **OQ-2** — Is enable/disable a substrate state (a new lifecycle value distinct from `tombstone`) or a
  local-only install toggle (skill present-but-inactive on disk)? If the former, it needs a PRD-033 contract
  decision; if the latter, it is an install-target concern. Resolve before 042a build.
- **OQ-3** — Does the activity feed scope to the current workspace, or show org-wide sync events the user has
  visibility into? Tie to the PRD-022 scope-resolution rules used by the other dashboard endpoints.
- **OQ-4** — Can a user demote (tombstone) an asset they did not author, or only their own? This is a PRD-018
  authz question the page must surface honestly (disable the control when not permitted) rather than attempt
  and fail.

## Related

- **Depends on — PRD-036 Skill & Asset Discovery** (`library/requirements/backlog/prd-036-skill-asset-discovery/`)
  — the local discovery pass + `installed ∪ synced` union view-model this page consumes as its data backbone.
  PRD-036 forward-references this PRD as its consumer (its G-4 / AC-5).
- **Hosted by — PRD-037 Dashboard Nav Shell** (`library/requirements/backlog/prd-037-dashboard-nav-shell/`) —
  owns the `#/sync` route, the sidebar nav slot, and the shared page-frame this page's content fills.
- **Built on — PRD-033 Asset-Sync Substrate** (`library/requirements/in-work/prd-033-asset-sync-substrate/`) —
  the `synced_assets` table (asset_type `skill` + `agent`, version-bumped, tombstone-as-row, tier/style) that
  promote/demote write and the detail view reads.
- **Built on — PRD-018 Team Skill Sharing** (`library/requirements/in-work/prd-018-team-skill-sharing/`) — the
  publish/select-newer-for-org-users path (`publish-endpoint.ts`) promote invokes, plus the sharing authz.
- **Built on — PRD-005 Skill Promoter / PRD-016 Skillify** (`library/requirements/in-work/prd-016-skillify/`) —
  the miner + install/publish/pull pipelines the control actions drive.
- **Prior art / house style — PRD-024 Dashboard UI Parity** (`library/requirements/in-work/prd-024-dashboard-ui-parity/`)
  — the production-clean bundle (D-1), the security posture (D-4), and the connectivity behavior this page inherits.

## Reference (grounding code paths)

- `src/daemon/storage/catalog/synced-assets.ts` — the `synced_assets` table: `SYNCED_ASSET_TYPES = ["skill","agent"]`,
  version-bumped writes, `tombstone` (`TOMBSTONE_TRUE`/`TOMBSTONE_FALSE`), tier/style, `buildCurrentAssetVersionSql`.
- `src/daemon/runtime/skillify/publish-endpoint.ts` — `createSkillPublishEndpoint.publish` (append version-bumped) +
  `selectNewerForOrgUsers` (poll-convergent team read) that promote invokes.
- `src/daemon-client/skillify/pull-client.ts` — `createDaemonPullClient.readLatestSkills` (the thin-client pull,
  poll-convergent, dispatched over 3850) that the pull action drives.
- `src/daemon/runtime/skillify/install-target.ts` — the `.claude/skills/<name>/SKILL.md` install convention; the
  symmetric agent target under `.claude/agents/` / `.cursor/agents/`.
- `src/daemon/runtime/dashboard/api.ts` — `fetchSkillSyncView` (the read-only seam PRD-036 turns into the union);
  the `/api/diagnostics/*` view-model attach pattern any new Sync read mirrors.
- `src/dashboard/web/panels.tsx` — the current read-only `SkillSyncPanel` this page supersedes; `SYNC_TONE` badges.
- `src/daemon/runtime/logs/api.ts` — `mountLogsApi`: `GET /api/logs` (JSON snapshot) + `GET /api/logs/stream` (SSE)
  the activity feed (042c) reuses.

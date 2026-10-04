# PRD-042b: Sync Page — Agents view + promote/control

> **Status:** Backlog
> **Priority:** P1
> **Effort:** M
> **Parent:** [PRD-042 Sync Page](./prd-042-sync-page-index.md)

## Overview

The agents half of the Sync page: the same management surface as 042a, for **agents**. Agents are the
second asset kind the substrate already syncs — `synced_assets.asset_type = 'agent'`
(`SYNCED_ASSET_TYPES = ["skill", "agent"]` in `src/daemon/storage/catalog/synced-assets.ts`) — and they
live on disk under `.claude/agents/` and `.cursor/agents/` (a single file per agent, distinct from a
skill's `<name>/SKILL.md` directory). PRD-036's union view-model covers agents alongside skills, so this
sub-PRD lists, inspects, promotes, and controls agents through the same components and daemon seams as
042a, parameterized over `asset_type='agent'`.

The point of a separate sub-PRD is to make agent parity an explicit, tested acceptance criterion — agents
are first-class on the Sync page, not a skills-only feature with agents bolted on. The shared
implementation (one component family, one set of daemon endpoints keyed by `asset_type`) is the goal.

## Goals

- **G-1** — List all agents from the PRD-036 union view-model with state badges (`local`/`pulled`/`shared`),
  the same way skills are listed, no double-count.
- **G-2** — An agent detail view: name, description, provenance, scope, source harness, tier/style, version, state.
- **G-3** — **Promote** a `local` agent into `synced_assets` (`asset_type='agent'`) via the symmetric publish
  path, flipping to `shared` on a poll-convergent read-back.
- **G-4** — **Control**: pull, demote/tombstone, enable/disable an agent — the real pipeline, keyed `asset_type='agent'`.
- **G-5** — **Symmetry as a contract.** The agent surface is the skills surface parameterized over asset type —
  one component family, one endpoint set, proven by the same tests run for both kinds.

## Non-Goals

- **Not** skills — that is 042a (this sub-PRD reuses its components/seams for `asset_type='agent'`).
- **Not** the activity feed / per-scope state — that is 042c.
- **Not** the discovery/union view-model — consumed from PRD-036 (agents already in its scope).
- **Not** a new agent install target or harness wiring. Agents install to the existing `.claude/agents/` /
  `.cursor/agents/` directories (PRD-019); this PRD does not add a harness or a target.
- **Not** a new substrate or schema. The `agent` rows are the same `synced_assets` table, `asset_type='agent'`.

## User Stories

- As a dev, I open the Agents tab of `#/sync`, see my local `.claude/agents/` agents, and **promote** one to
  the team — it publishes as an `agent` row and flips to `shared`.
- As a teammate, I **pull** an agent another author shared; it installs under `.claude/agents/` and shows `pulled`.
- As a maintainer, I **demote** a stale team agent; it tombstones in `synced_assets` and stops presenting as live.
- As any user, I read an agent's provenance/scope/harness/tier/version before acting — exactly as for a skill.

## Acceptance Criteria

- [ ] **b-AC-1 — Agents list = the union.** The agents view lists every agent from the PRD-036 union view-model
  with state badges; an agent both local and in `synced_assets` (`asset_type='agent'`) appears once.
- [ ] **b-AC-2 — Detail view.** Selecting an agent opens a detail view (name, description, provenance, scope,
  source harness, tier/style, version, state) — no secret/blob/author-email rendered.
- [ ] **b-AC-3 — Promote publishes a real `agent` row.** Promoting a `local` agent writes a version-bumped
  `synced_assets` row with `asset_type='agent'` through the symmetric publish path (never an in-place UPDATE);
  on a poll-convergent read-back the agent is `shared`. Unit-tested + gated live check.
- [ ] **b-AC-4 — Pull works.** Pulling a `shared` agent installs it under `.claude/agents/` (/`.cursor/agents/`)
  and the row shows `pulled`, poll-convergently.
- [ ] **b-AC-5 — Demote tombstones.** Demoting writes a fresh `agent` version with `tombstone='true'` (PRD-033 D-5);
  on the converged read it no longer presents as live `shared`.
- [ ] **b-AC-6 — Symmetry proven.** The list/detail/promote/pull/demote/enable-disable tests are parameterized
  over `{ skill, agent }` and pass for both — the agent surface is the skill surface keyed by `asset_type`,
  not a fork.
- [ ] **b-AC-7 — Security + gate.** Local-mode-only, XSS-safe, no secret/blob/email in the page or action
  responses; daemon SQL through `sqlIdent`/`sLiteral`; thin-client invariant + `npm run ci` + `audit:sql` green.

## Implementation Notes

- **Asset-type keying:** the list, detail, and action endpoints take `asset_type` (`'skill' | 'agent'`,
  `SyncedAssetType` from `synced-assets.ts`) and filter/write the `synced_assets` rows accordingly. The 042a
  components render either kind; the page exposes skills and agents as two views over one shared surface.
- **Agent install target:** agents are single files under `.claude/agents/` / `.cursor/agents/` (per PRD-019
  harness directories), distinct from the skill `<name>/SKILL.md` directory convention in
  `src/daemon/runtime/skillify/install-target.ts`. The agent target mirrors the skill target's path-sanitize
  + injectable-root discipline so a crafted agent name cannot traverse out of the agents root.
- **Promote/demote seam:** the same `synced_assets` version-bumped write as 042a, with `asset_type='agent'`
  (`src/daemon/storage/catalog/synced-assets.ts`). Demote flips `tombstone` to `TOMBSTONE_TRUE`.
- **Read-back:** poll-convergent current-version read keyed `(asset_type='agent', honeycomb_id)`
  (`buildCurrentAssetVersionSql`), same `RESOLVE_POLLS` discipline as skills.

## Open Questions

- **b-OQ-1** — Do agents have a distinct skillify-style publish endpoint, or does promote/pull go through a
  generic `synced_assets` asset endpoint keyed by `asset_type`? Lean: one generic asset endpoint that 042a
  (skills) and 042b (agents) both use, so symmetry is structural. Confirm the skills path can be generalized
  without regressing the PRD-018 `skills`-table publish.
- **b-OQ-2** — Same enable/disable semantics question as skills (parent OQ-2): substrate state vs install toggle —
  must resolve identically for both kinds to keep the surface symmetric.

# PRD-036b: Skill-Sync View = Installed ∪ Synced, with Honest State

> **Status:** Draft
> **Priority:** P0
> **Effort:** M
> **Parent:** [PRD-036 — Skill & Asset Discovery](./prd-036-skill-asset-discovery-index.md)
> **Depends on:** [PRD-036a — Local Skill/Agent Scanner](./prd-036a-skill-asset-discovery-local-scanner.md)

## Overview

Today `fetchSkillSyncView` (`src/daemon/runtime/dashboard/api.ts`) builds the `SkillSyncView` from a
single source — the DeepLake `skills` table:

```ts
// current: synced skills ONLY → 0 when the skills table is empty
const skills = rows.map((r) => ({
  name: toStr(r.name),
  scope: toStr(r.scope),
  syncState: toStr(r.visibility) === "global" ? "shared" : "pulled",
}));
```

So the panel shows only team-synced skills and reads 0 on a workspace with an empty `skills` table — even
when 27 skills sit on disk. This sub-PRD **merges** the PRD-036a local inventory with the team-synced rows
(`synced_assets` and/or the `skills` table) so the view-model is the **union** `installed ∪ synced`, and
every row carries an **honest state**:

- `local` — installed on disk, not shared with the team (discovered by 036a, absent from the substrate).
- `shared` / `synced` — present in the team substrate (`synced_assets` / `skills`), shared org/team-wide.
- `pulled` — pulled from the team substrate into this workspace.

`SkillSyncPanel` then renders the union with no double-counting.

## Goals

- **G-1** — Extend `fetchSkillSyncView` to call the 036a scanner and merge its inventory with the
  team-synced rows into one `SkillSyncView`.
- **G-2** — Tag every row with a clear `syncState` (`local` | `shared`/`synced` | `pulled`).
- **G-3** — De-duplicate: a skill that is both installed locally **and** in the substrate is **one** row
  (its state reflects the substrate — `shared`/`synced`/`pulled` — not `local`).
- **G-4** — Extend `SkillSyncView` / `SkillSyncRow` in `src/dashboard/contracts.ts` (and the matching
  `SkillRowSchema` in `src/dashboard/web/wire.ts`) to carry the new state cleanly.
- **G-5** — `SkillSyncPanel` (`src/dashboard/web/panels.tsx`) renders the union, with a `local` badge tone.

## Non-Goals

- Not changing how skills are published or pulled (PRD-016 / PRD-033 unchanged).
- Not the agents surface in the panel — agents flow through discovery (036a) and are part of the backbone
  for PRD-042, but this sub-PRD's panel scope is **skills** (the panel is the "Skill-sync" panel). Agent
  rendering is PRD-042.
- Not the KPI count — that is PRD-036c.

## Merge semantics (D-1)

1. Start from the 036a local inventory (skills) → candidate rows with `syncState: "local"`.
2. Load the team-synced rows (`synced_assets` current-version skill rows, and/or the `skills` table) →
   rows with `syncState: "shared"`/`"synced"`/`"pulled"` per the substrate's visibility/tier.
3. **Union by logical key** (`name`, normalized; later refine to the substrate `honeycomb_id` when a local
   asset can be correlated to it). When a key appears in both:
   - emit **one** row;
   - the **substrate state wins** (a skill that is shared/pulled is shown as shared/pulled, not `local`),
     because the more-informative team state is what the user cares about.
4. A key only on disk → `local`. A key only in the substrate → its substrate state (unchanged from today).

This guarantees AC: local-only skills appear as `local`, synced ones keep their state, nothing is counted
twice.

## Contract changes

- `SkillSyncRow.syncState` documented to include `local` alongside `shared` | `synced` | `pulled` |
  `pending`. (The field is already a `string`; this is a documentation + value-set change, not a breaking
  type change.)
- `src/dashboard/web/panels.tsx`: extend `SYNC_TONE` with a `local` tone (e.g. `neutral` or a distinct
  muted tone) so the badge reads honestly.
- `src/dashboard/web/wire.ts`: `SkillRowSchema` already `.catch("")`-tolerant; confirm it passes the new
  `local` value through unchanged.

## Decisions

- **D-1 — Union by logical key; substrate state wins on collision.** One row per logical skill; the more
  informative team state is shown when a skill is both local and synced.
- **D-2 — `syncState` value-set extension, not a type break.** `local` is a new allowed value of the
  existing `string` field; no contract-breaking change, so the Cursor webview (which shares the contract)
  keeps rendering.
- **D-3 — Panel scope is skills.** Agents are discovered (036a) and part of the PRD-042 backbone, but the
  "Skill-sync" panel renders skills; agents get their own surface in PRD-042.
- **D-4 — Fetcher calls the scanner in-process.** `fetchSkillSyncView` invokes the 036a discovery function
  directly (not over HTTP), since both run in the daemon. Fail-soft: a discovery error degrades to the
  prior substrate-only view rather than failing the panel.

## Acceptance Criteria

- [ ] **b-AC-1 — Union rendered.** With local skills on disk and (optionally) synced rows in the substrate,
  `fetchSkillSyncView` returns the union; `SkillSyncPanel` lists local skills as `local` and synced skills
  with their existing `shared`/`synced`/`pulled` state.
- [ ] **b-AC-2 — No double-count.** A skill present both on disk and in the substrate appears exactly once,
  with the substrate state (not `local`).
- [ ] **b-AC-3 — Local-only honesty.** In this repo (empty `skills` table, 27 disk skills) the panel shows
  ~27 `local` rows instead of "No skills synced." / 0.
- [ ] **b-AC-4 — Synced unchanged.** A workspace with existing synced rows and no extra local skills renders
  exactly as before (no regression to the shared/pulled rows or their tones).
- [ ] **b-AC-5 — Contract + tone.** `SkillSyncRow.syncState` documents `local`; `SYNC_TONE` has a `local`
  tone; `SkillRowSchema` passes `local` through. `npm run ci` green.
- [ ] **b-AC-6 — Fail-soft.** A discovery failure degrades to the substrate-only view; the panel never
  crashes or 500s.

## Implementation notes

- The merge lives in `fetchSkillSyncView` (`src/daemon/runtime/dashboard/api.ts`), keeping it the single
  source of the view's read (the file's existing jscpd-discipline note).
- Read team-synced skill rows via the existing guarded-SQL helpers (`sqlIdent` / `sLiteral`); for
  `synced_assets`, use the current-version convention (`buildCurrentAssetVersionSql` / `ORDER BY version
  DESC LIMIT 1`, tombstones excluded) from `src/daemon/storage/catalog/synced-assets.ts`.
- Decide the authoritative synced source: the legacy `skills` table (today's source) vs the PRD-033
  `synced_assets` table (skill rows). Prefer `synced_assets` as the substrate of record and treat `skills`
  as legacy — confirm in OQ-1.
- Add view tests via `createFakeDashboardDataSource` (contracts.ts) + a daemon-side `fetchSkillSyncView`
  test with a fake `StorageQuery` and a fake/temp-dir scanner.

## Open Questions

- **OQ-1** — Substrate of record for synced skills: `synced_assets` (PRD-033) vs the legacy `skills` table.
  Which one does `fetchSkillSyncView` read for the "synced" half? (Recommend `synced_assets`.)
- **OQ-2** — Collision key: start with normalized `name`; can a local skill be correlated to a substrate
  `honeycomb_id` reliably (e.g. via a stored marker in `SKILL.md`)? If not, `name` is the v1 key.
- **OQ-3** — Should `pending` (publish-in-flight) remain a distinct state, and can the union infer it, or is
  it only meaningful inside the publish flow (PRD-016)?

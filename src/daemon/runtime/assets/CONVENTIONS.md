# Asset-Sync Substrate — CONVENTIONS (PRD-033)

"Dotfiles-over-DeepLake" for harness artifacts: register a skill/agent and control
how far it propagates via an explicit **tier × style** lattice. `.honeycomb/registry.json`
is the source of truth; the additive `synced_assets` DeepLake table holds versioned
native (+ reserved canonical) blobs; promotion widens the blast radius, demotion
retracts via append-only tombstone rows; a daemon-served publish/pull engine installs
verbatim native artifacts (identity adapter) with last-writer-wins `.bak`.

v1 = skills + agents only, native-per-harness, **daemon-only DeepLake access** (port 3850).

## Wave map

| Wave | Sub-PRD | Owner | Files | State |
|------|---------|-------|-------|-------|
| 1 | 033a registry + identity | `deeplake-dataset-worker-bee` | `contracts.ts`, `registry.ts`, `identity.ts`, `device.ts`, `hashing.ts`, `project-key.ts`, `lattice.ts`, `catalog/synced-assets.ts` | **FULL** |
| 2 | 033c sync engine + daemon API | `deeplake-dataset-worker-bee` | `sync.ts` + daemon `/api/assets` mount | **FULL** |
| 3 | 033b lifecycle + CLI | `typescript-node-worker-bee` | `lifecycle.ts` + `src/commands/asset.ts` + dispatch wiring | **FULL** |

**Wave 2 ground rule:** 033b and 033c implement AGAINST `contracts.ts` and reuse the
Wave-1 FULL modules (registry/identity/device/hashing/projectKey/lattice). They do NOT
redefine the contracts and do NOT re-implement the foundation — they wire it.

## The shared seam (`contracts.ts`) — STABLE, do not break

1. **Lattice vocabulary** — `Tier` (`Local`|`Device`|`Team`), `Style` (`Repository`|`User`),
   `LatticeCell`. The state machine lives in `lattice.ts` (`isLegalTransition`, `ALL_CELLS`,
   `tierDirection`).
2. **Wire contract** — `AssetSyncApi { publish, pull, tombstone }` with `PublishRequest`/
   `PublishResponse`, `PullRequest`/`PullResponse`/`PulledAsset`, `TombstoneRequest`/
   `TombstoneResponse`, all carrying an `AssetScope { org, workspace, author, deviceId }`.
   033c MOUNTS this at the protected `/api/assets` daemon route; 033b CALLS it through a
   loopback client satisfying the same interface.
3. **Adapter seam** — `AssetAdapter { id, render, parse }` + `IDENTITY_ADAPTER` (native →
   native, `parse(render(x)) === x`). v1 ships ONLY the identity adapter; the `canonical`
   column + this interface exist so cross-harness render is additive later (no schema
   change, no re-sync).
4. **Audience predicate** — `audienceMatches(asset, ctx)` (`AudiencePredicate`): `Local` →
   never; `Device` → same author AND caller `deviceId` in the row `deviceSet`; `Team` →
   matching org + workspace. Tombstone rows pass the SAME test so retraction lands across
   the right radius.

## Decisions (D-1 .. D-7)

- **D-1 Device identity** — generated UUIDv4 at `~/.honeycomb/device.json`
  (`{device_id, label, createdAt}`), stable per machine, BESIDE `~/.honeycomb/.machine-key`.
  NOT the raw OS machine-id (privacy + stability). "My devices" is a per-author set.
  → `device.ts` (`loadOrCreateDevice`, `addDeviceToSet`).
- **D-2 Skillify manifest** — COEXIST, non-breaking. `.honeycomb/registry.json` is the NEW
  SoT for substrate-managed assets; the skillify pull manifest
  (`~/.honeycomb/state/skillify/pull-manifest.json`) is left UNTOUCHED — never migrated or
  deleted. → `registry.ts` (a separate file + store, mirroring `createPullManifestStore`).
- **D-3 `honeycomb_id` placement** — stamp into the artifact's YAML frontmatter for skills +
  agents (both Markdown + YAML); the registry stays AUTHORITATIVE as the fallback.
  → `identity.ts` (`stampHoneycombId`/`parseHoneycombId`/`resolveHoneycombId`). A renamed
  artifact resolves the SAME id from frontmatter/registry — never a new artifact (a-AC-3).
- **D-4 Retraction UX** — on tombstone/demotion, BACK UP the managed copy to `.bak`, THEN
  remove it (retraction is real, content preserved). Owned by 033c's pull (`sync.ts`).
- **D-5 Append-only + tombstone-as-row** — reuse `appendVersionBumped` (version-bumped
  INSERT, never UPDATE/DELETE); a tombstone is a row with `tombstone='true'`. Live read-backs
  poll via `readConverged` (DeepLake eventual consistency). → `synced_assets` is a
  `version-bumped` catalog table.
- **D-6 Daemon-only DeepLake** — all `synced_assets` reads/writes go through the daemon
  (port 3850); the CLI + hooks never open DeepLake directly. The Wave-1 registry/identity/
  hashing modules are PURE/LOCAL; only the table + the publish/pull contracts touch DeepLake
  (through the daemon, in Wave 2).
- **D-7 Native-per-harness + reserved canonical** — store the verbatim native blob keyed
  `(asset_type, harness)`; ship ONLY the identity adapter in v1 (`parse(render(x)) === x`);
  reserve the `canonical` blob column + the `render`/`parse` adapter seam so cross-harness
  render is additive later (no schema change, no re-sync).

## The `synced_assets` table (`catalog/synced-assets.ts`)

- Lazy-create on first INSERT (no DDL pre-step) + additive heal — exactly like every other
  catalog table (`buildCreateTableSql` / `withHeal`). Every NOT NULL column carries a DEFAULT
  (the load-time `validateColumnDefs` guard).
- `version-bumped` write pattern, `tenant` scope (explicit `org`/`workspace`/`author`).
- The two blob columns (`native`, `canonical`) are TEXT — opaque verbatim payloads written/
  read whole, NOT JSONB (they are never filtered field-by-field).
- **Trusted-table list:** the daemon's trusted-table list is DERIVED from `CATALOG`. Wiring
  this group into `catalog/index.ts` therefore ALSO lands `synced_assets` in the trusted-table
  list the substrate pull (033c) consults before its SELECT — there is no separate list to edit.

## SQL safety

The `synced_assets` SQL helpers route every identifier through `sqlIdent` and every value
through `sLiteral` (the PRD-002b floor). `npm run audit:sql` enforces no hand-interpolation.
The write path is `appendVersionBumped` (already guarded); the read helpers
(`buildCurrentAssetVersionSql`) build through the same helpers.

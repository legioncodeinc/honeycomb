# PRD-033c: Sync Engine (Publish + Pull) with Adapter Seam

> **Parent:** [PRD-033](./prd-033-asset-sync-substrate-index.md)
> **Status:** Completed (2026-06-25)
> **Priority:** P2
> **Effort:** M

## Scope

The daemon-served sync engine that publishes registered artifacts into the synced-assets table and pulls newer artifacts onto a consuming device, for skills and agents. It installs the verbatim native artifact via the identity adapter, applies last-writer-wins + `.bak` backup on remote-newer pull, honors tombstones, and ships the reserved canonical adapter interface. Pull is idempotent and fail-soft, consistent with skillify's 5s-budget auto-pull. It consumes the registry and schema from PRD-033a and is driven by the lifecycle in PRD-033b.

## Goals

- Provide daemon publish and pull endpoints for skills and agents through the honeycomb daemon (port 3850).
- Install the verbatim native artifact onto a matching harness in v1 via the identity adapter.
- Apply last-writer-wins + `.bak` backup on remote-newer pull, matching today's skillify conflict behavior.
- Ship the reserved canonical adapter interface (`render(canonical)→native` / `parse(native)→canonical`) with only the identity adapter implemented.
- Make pull idempotent and fail-soft so it never blocks session start.

## Non-Goals

- The registry, hashing, identity, and schema (PRD-033a).
- Promotion/demotion transitions and the CLI (PRD-033b).
- Real three-way conflict merge — the three hashes are recorded (PRD-033a) but the merge action is deferred to v2.
- Real cross-harness render adapters — only the seam and identity adapter ship in v1.

## User stories

- As a developer, I want my published artifact to reach my other devices and teammates without me running an install command per machine.
- As a developer, I want a locally-edited artifact backed up before a newer remote copy overwrites it, so I never silently lose my edits.
- As a developer, I want the pull to never slow or block my session start, even when DeepLake is slow or the table does not exist yet.

## Functional requirements

- **FR-1 Daemon publish.** A publish endpoint inserts a new versioned row for an artifact into the synced-assets table through the daemon, carrying the native blob keyed by `(asset_type, harness)`, the reserved `canonical` blob, the content hash, and the tenancy/device-set scoping the artifact's tier implies (PRD-033a/b). Inserts are append-only and version-bumped.
- **FR-2 Daemon pull.** A pull endpoint selects newer artifacts for the consuming `(user, workspace, device-set)` audience, honoring tombstones, and writes any remote-newer artifact to the consuming device.
- **FR-3 Native-per-harness install.** v1 stores and installs the verbatim native artifact; an artifact installs only onto a **matching** harness. A row keyed `(skill, claude_code)` installs to a Claude Code skills root, and so on.
- **FR-4 Identity adapter only.** The engine ships the per-`(assetType, harness)` adapter interface `render(canonical)→native` / `parse(native)→canonical`, but v1 implements only the identity adapter (native→native, same harness). The identity adapter round-trips: `parse(render(x)) == x`. A real `render()` added later lights up cross-harness install with no schema change or re-sync.
- **FR-5 Last-writer-wins + backup.** When a remote artifact is newer than the local copy and the local copy is hash-divergent (locally edited), the engine backs the existing copy up to `.bak`, then overwrites. This matches today's skillify `decideAction` behavior. Three-way merge is not performed in v1.
- **FR-6 Tombstone-honoring retraction.** When the pull selects a tombstone row for an artifact present locally, it retracts the local copy across the blast radius (the exact retraction UX is an open question in PRD-033b).
- **FR-7 Idempotent, fail-soft pull.** A pull with nothing changed is a no-op (skip when the local version is at or newer than the remote). The pull is bounded by a time budget consistent with skillify's 5-second auto-pull, swallows errors, and never blocks session start. On a fresh workspace where the synced-assets table is absent, it skips the `SELECT` via the trusted-table-list path rather than erroring.
- **FR-8 Daemon-only access.** All publish and pull DeepLake access goes through the daemon; hooks and the CLI never open DeepLake directly.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a promoted artifact, when publish runs, then a new versioned row is inserted through the daemon carrying the native blob keyed by `(asset_type, harness)`, the reserved `canonical` column, and the tier-appropriate scoping. |
| AC-2 | Given a remote artifact newer than a hash-divergent local copy, when pull runs, then the local copy is backed up to `.bak` and overwritten (last-writer-wins). |
| AC-3 | Given a v1 install, when an artifact is written, then it lands only on a matching harness; an artifact keyed for one harness is not installed onto a different harness. |
| AC-4 | Given the identity adapter, when an artifact round-trips, then `parse(render(x)) == x`; the `canonical` column and the adapter interface both exist. |
| AC-5 | Given a tombstone row for a locally-present artifact, when pull runs, then the local copy is retracted across the blast radius. |
| AC-6 | Given a pull with no changes, when it runs, then it is a no-op; given a slow or absent table, the pull stays within its budget, swallows errors, and never blocks session start. |

## Implementation notes

- The conflict policy intentionally mirrors skillify's `decideAction`: local absent → write; remote version > local → backup `.bak` then write; remote ≤ local → skip; force → backup then write. The three recorded hashes (PRD-033a) are the data a v2 three-way merge would consume; v1 does not act on them.
- The fail-soft / 5s-budget / trusted-table-list behavior is lifted directly from the skillify auto-pull so the substrate inherits the same "never block `SessionStart`" guarantee.
- The adapter seam is the single extensibility point that turns this into a cross-harness substrate later: because the native blob and a reserved `canonical` blob are both stored from day one, adding a real `render(canonical)→native` for a new `(assetType, harness)` is purely additive — no schema migration, no re-sync of existing rows.
- Install roots reuse the skillify/team-sharing root-detection conventions (e.g. `~/.claude/skills/`, project `.claude/skills/`, and the per-agent roots), so `Repository` vs `User` style maps onto existing project-local vs global install locations.

## Dependencies

- PRD-033a for the synced-assets schema, the native + `canonical` columns, the content hashes, and the registry.
- PRD-033b for the tier/style that determines the publish blast radius and the tombstones the pull honors.
- The honeycomb daemon (port 3850) as the only DeepLake client.
- The skillify auto-pull behavior (PRD-016 / PRD-018) this engine's pull discipline mirrors.

## Open questions

Both questions resolved 2026-06-25 by explicit owner ruling.

- [x] **Pull manifest migration (resolved 2026-06-25):** The skillify pull manifest is MIGRATED into the
  unified `.honeycomb/registry.json` as the single source of truth. The prior "coexist during a transition"
  answer is superseded. A one-time idempotent migration folds legacy `pull-manifest.json` entries in;
  `skill unpull` and `backfillSymlinks` are unchanged.
- [x] **Tombstone retraction UX (resolved 2026-06-25):** On tombstone retraction, the local artifact file
  is left in place and marked UNMANAGED. The engine never deletes or moves user files. The prior "back up
  to .bak then remove" answer is superseded.

## Related

- [parent index](./prd-033-asset-sync-substrate-index.md)
- [Skillify Pipeline](../../../knowledge/private/ai/skillify-pipeline.md)
- [Team Skills Sharing](../../../knowledge/private/collaboration/team-skills-sharing.md)
- [PRD-016 Skillify](../../completed/prd-016-skillify/prd-016-skillify-index.md)

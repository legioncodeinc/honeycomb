# PRD-033a: Registry and Identity Model

> **Parent:** [PRD-033](./prd-033-asset-sync-substrate-index.md)
> **Status:** Completed (2026-06-25)
> **Priority:** P2
> **Effort:** M

## Scope

Define the source-of-truth registry (`.honeycomb/registry.json`), the identity and hashing model for synced artifacts, the tier × style state machine, and the additive DeepLake synced-assets schema. This sub-PRD establishes the substrate that PRD-033b (lifecycle) and PRD-033c (sync engine) act on; it does not itself publish, pull, promote, or demote.

## Goals

- Make `.honeycomb/registry.json` the single source of truth for an artifact's tier, style, harness, version, hashes, provenance, and device set, uniformly across all asset types.
- Give each artifact a stable identity (`honeycomb_id`) that survives renames, plus a stable per-machine `device_id` and a "my devices" set.
- Define the content/merkle hashing scheme for change detection and integrity, recording three hashes per artifact (last-synced / local / remote).
- Define the tier × style lattice as a 6-state machine with explicit legal transitions.
- Specify the additive DeepLake synced-assets table: native blob + reserved `canonical` blob + `harness` + `asset_type` + `version` + `tombstone` flag + tenancy and device-set columns.

## Non-Goals

- Promotion/demotion transitions and the CLI that drives them (PRD-033b).
- The publish/pull sync engine and the adapter seam mechanics (PRD-033c).
- Hooks, rules, and commands as asset types (deferred to a later security-gated PRD).

## User stories

- As a developer, I want each registered artifact to have a stable ID so that renaming a skill or agent does not fork its identity or re-sync it as new.
- As a developer with two machines, I want a stable device set so that a `Device`-tier artifact lands on my other devices but nobody else's.
- As an operator, I want three hashes recorded per artifact so that a future three-way merge has real data without a re-sync.

## Functional requirements

- **FR-1 Registry as source of truth.** `.honeycomb/registry.json` records, per artifact: `assetType`, `harness`, `tier`, `style`, `version`, `honeycomb_id`, the three hashes (`lastSyncedHash`, `localHash`, `remoteHash`), provenance (author, `org`, `workspace`), and the device set. It evolves the existing skillify pull manifest and works uniformly across all asset types.
- **FR-2 Stable artifact identity.** Each artifact carries a `honeycomb_id` recorded in the registry; where the asset format supports it, the same id is stamped into the artifact's YAML frontmatter so identity survives renames. Skills and agents are both Markdown + YAML frontmatter.
- **FR-3 Stable device identity.** A stable `device_id` identifies the current machine and is recorded in a per-user "my devices" set, so `Device`-tier propagation is keyed by author identity + device set (the exact device-identity source is an open question).
- **FR-4 Content and merkle hashing.** For agents (single file), the hash is the content hash of the file. For skills (directories), the hash is a merkle-style root over sorted `(path, content-hash)` pairs. The hash provides change detection and integrity.
- **FR-5 Version and hash are distinct.** The registry keeps BOTH a monotonic `version` (intent / ordering) AND a content hash (identity / integrity); they do different jobs and neither replaces the other.
- **FR-6 Three recorded hashes.** Each artifact records `lastSyncedHash`, `localHash`, and `remoteHash` so three-way merge data exists from day one, even though v1 does not act on it.
- **FR-7 Tier × style state machine.** An artifact occupies exactly one of 6 cells: tier ∈ {`Local`, `Device`, `Team`} × style ∈ {`Repository`, `User`}. `Local` is unmanaged — not synced to DeepLake at all. `Device` syncs only to the same user's other devices. `Team` syncs to all authors in the same workspace. `Repository` style is keyed by project (SHA-1 of `git config remote.origin.url`, matching skillify's `projectKey`); `User` style is global across repos on the machine.
- **FR-8 Additive synced-assets schema.** A new DeepLake table holds versioned rows with: the verbatim native artifact blob, a reserved optional `canonical` blob, `harness`, `asset_type`, `version`, a `tombstone` flag, `honeycomb_id`, content hash, and `org` / `workspace` / `author` tenancy columns plus the device set for `Device`-tier rows. The table is created lazily on first `INSERT`.
- **FR-9 Daemon-only access.** The synced-assets table is read and written only through the honeycomb daemon (port 3850); the CLI and hooks never open DeepLake directly.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a registered skill or agent, when the registry is written, then `registry.json` records its tier, style, harness, version, `honeycomb_id`, and the three hashes. |
| AC-2 | Given a skill directory, when its hash is computed, then it is a merkle-style root over sorted `(path, content-hash)` pairs; given an agent file, the hash is the file content hash. |
| AC-3 | Given an artifact renamed on disk, when it is re-scanned, then its `honeycomb_id` is unchanged and it is not treated as a new artifact. |
| AC-4 | Given the second device of the same user, when the device set is read, then the device's stable `device_id` is present in the "my devices" set. |
| AC-5 | Given any artifact, when its state is read, then it resolves to exactly one of the 6 tier × style cells. |
| AC-6 | Given a synced-asset row, when it is inserted, then it carries the native blob, the reserved `canonical` column, `harness`, `asset_type`, `version`, the `tombstone` flag, and `org` / `workspace` / `author` tenancy. |

## Implementation notes

- `.honeycomb/registry.json` evolves the existing skillify pull manifest (which records `dirName`, `name`, `author`, `projectKey`, `remoteVersion`, `install`, `installRoot`, `pulledAt`, and fan-out symlinks); the registry generalizes this to all asset types and adds tier/style/hashes/`honeycomb_id`/device-set.
- The `Repository` project key reuses skillify's SHA-1 of `git config remote.origin.url`, falling back to the absolute path for non-git directories.
- Append-only, version-bumped writes are used (matching skillify) because DeepLake coalesces UPDATEs against freshly written rows; the `tombstone` flag is a row, not a delete.
- The `canonical` column is reserved but unused by v1 logic beyond the identity adapter (see PRD-033c); recording it now means cross-harness render is additive later with no schema change or re-sync.

## Dependencies

- The honeycomb daemon (port 3850) as the only DeepLake client.
- The skillify pull manifest and `projectKey` convention this registry evolves from (PRD-016 / PRD-018).
- The org / workspace tenancy scoping reused for the `Team` boundary.

## Open questions

All three questions resolved 2026-06-25 by explicit owner ruling.

- [x] **Device identity (resolved 2026-06-25):** Device identity is a generated UUID persisted at
  `~/.honeycomb/device.json`. No OS machine-id read is used. A user lists and revokes devices via
  `honeycomb asset device`. Already shipped.
- [x] **Pull manifest migration (resolved 2026-06-25):** The skillify pull manifest is MIGRATED into the
  unified `.honeycomb/registry.json` as the single source of truth. The prior "coexist during a transition"
  answer is superseded. A one-time idempotent migration folds legacy `pull-manifest.json` entries in;
  `skill unpull` and `backfillSymlinks` are unchanged.
- [x] **`honeycomb_id` in frontmatter (resolved 2026-06-25):** `honeycomb_id` is stamped into the artifact
  YAML frontmatter for skills and agents. The registry remains the authoritative fallback for harnesses that
  cannot carry frontmatter.

## Related

- [parent index](./prd-033-asset-sync-substrate-index.md)
- [Team Skills Sharing](../../../knowledge/private/collaboration/team-skills-sharing.md)
- [Skillify Pipeline](../../../knowledge/private/ai/skillify-pipeline.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)

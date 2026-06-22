# PRD-001c: Version Sync and Release Pipeline

> **Parent:** [PRD-001](./prd-001-monorepo-foundation-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** S

## Scope

Build `scripts/sync-versions.mjs`, which reads the root `package.json` version as the single source and propagates it to every plugin manifest and the marketplace definition, plus the release pipeline that runs it on `prebuild` and packages the artifacts. In scope: the scalar manifest targets, the marketplace `metadata.version` and per-plugin `version` entries, idempotency, and the `prebuild` wiring. Out of scope: the workspace layout (PRD-001a), the esbuild bundling step (PRD-001b), and the semantics of what each manifest declares beyond its version field.

## Goals

- One root version fans out idempotently to every plugin manifest and the marketplace file before each build.
- The sync script writes a file only when the version differs, so a re-run on an already-synced tree performs zero writes.
- The script is wired as the `prebuild` hook so every `npm run build` is version-consistent by construction.
- The marketplace `metadata.version` and every entry in its `plugins` array track the root version.
- The release pipeline packages the bundled artifacts with all manifests pinned to one version, eliminating mismatched-version ships.

## Non-Goals

- The bundling step that produces the artifacts (PRD-001b).
- The workspace and `tsconfig` layout (PRD-001a).
- Designing new manifest fields beyond the `version` propagation.
- Choosing the registry or publish credentials model.

## User stories

- As a maintainer, I want one version that fans out to every manifest so that the ecosystem never ships mismatched versions.
- As a release engineer, I want the sync wired into `prebuild` so that I cannot forget to run it before packaging.
- As a reviewer, I want the sync to be idempotent so that a no-op run produces a clean diff and clear intent.

## Functional requirements

- FR-1: `scripts/sync-versions.mjs` reads the `version` field from the root `package.json` (`SOURCE = "package.json"`) as the single source of truth.
- FR-2: The script updates the scalar targets, each carrying a single top-level `version`: `.claude-plugin/plugin.json`, `harnesses/claude-code/.claude-plugin/plugin.json`, `harnesses/openclaw/openclaw.plugin.json`, `harnesses/openclaw/package.json`, and `harnesses/codex/package.json`.
- FR-3: The script updates the marketplace file's `metadata.version` and every `plugins[].version` entry to match the root version, logging each transition `old -> new`.
- FR-4: For each target, the script parses the JSON, compares the current version to the source, and writes only on discrepancy; matching targets are logged as skipped and produce no write.
- FR-5: The script counts and logs writes versus skips so a run is auditable, and exits zero on success.
- FR-6: The script is registered as the `prebuild` npm hook (`node scripts/sync-versions.mjs`) so it runs before every `build`.
- FR-7: The release pipeline runs `prebuild` then `build` (`tsc && node esbuild.config.mjs`), then packages artifacts via the `prepack`/`prepare` path so packaged output is always version-synced.
- FR-8: The script does not duplicate the target list anywhere else; the `SCALAR_TARGETS` array and marketplace path are the single source for which manifests are synced.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a new root version, when the sync script runs, then all scalar plugin manifests and the marketplace metadata and plugin entries are updated to match. |
| AC-2 | Given manifests already at the target version, when the script re-runs, then it performs no file writes (idempotent). |
| AC-3 | Given a bumped root version, when `prebuild` runs ahead of `build`, then every manifest is synced before esbuild emits artifacts. |
| AC-4 | Given a sync run, when it completes, then it logs each `old -> new` transition and a final write/skip count. |
| AC-5 | Given the marketplace file, when sync runs, then both `metadata.version` and every `plugins[].version` match the root version. |
| AC-6 | Given a malformed manifest JSON, when sync runs, then it fails with a clear error naming the file rather than writing partial output. |

## Implementation notes

- The script reads `package.json` as the single source and writes only on discrepancy; this is what makes it safe to run on every build and produce clean diffs.
- It covers `.claude-plugin/plugin.json`, the per-harness manifests in `SCALAR_TARGETS`, and the marketplace file (both `metadata.version` and the per-plugin array). Keep the target list in one array so adding a harness is a one-line change and cannot drift from a second copy.
- Wire it as `prebuild` so `build` (`tsc && node esbuild.config.mjs`) always runs against synced manifests; `prepack`/`prepare` ensure published output is synced.
- The publish/tag steps of the release pipeline (registry push, git tag, marketplace publish) are still to be defined; the sync script and `prebuild` wiring are the version-consistency floor everything else builds on.

## Dependencies

- PRD-001a (workspace layout) defines where the manifests and marketplace file live.
- PRD-001b (bundling) consumes the synced version via `__HONEYCOMB_VERSION__`.
- External: Node `fs`/JSON, the npm script lifecycle (`prebuild`, `prepack`, `prepare`).

## Open questions

- [ ] What are the publish, tag, and marketplace-publish steps that follow sync and bundle?
- [ ] Should the script fail the build if a manifest is missing entirely, or create it from a template?
- [ ] Does the marketplace publish require a separate signing or attestation step?

## Related

- [parent index](./prd-001-monorepo-foundation-index.md)
- [Monorepo Build and Release Pipeline](../../../knowledge/private/infrastructure/monorepo-build-release.md)

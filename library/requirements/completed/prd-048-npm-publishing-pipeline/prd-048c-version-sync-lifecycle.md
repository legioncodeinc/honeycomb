# PRD-048c — Version-sync lifecycle hardening (`"version"` npm script)

> Status: backlog · Parent: PRD-048 · Wave: W1 · Type: S
> Goal: close the one real gap RELEASING.md flags — `npm version` does not run `sync-versions`, so harness
> manifest versions can drift out of the tagged commit. Wire a `"version"` npm script so a bump
> auto-propagates and stages the new version, making every version commit internally consistent.

## Why
The version is single-sourced in the root `package.json` and propagated to every harness manifest by
`scripts/sync-versions.mjs`, which runs as the `prebuild` hook. But `npm version <bump>` runs npm's
`version` lifecycle **and NOT `prebuild`** — so a maintainer who runs `npm version patch` writes the new
root version + creates the tag, but the harness manifests still carry the OLD version unless they remember
to run `sync-versions` by hand first (RELEASING.md's "Cut the release" note spells this out as a manual
workaround). Worse, `release.yaml`'s tag-vs-version guard only checks the **root** `package.json`, so
drifted manifest versions sail straight through the gate and ship mislabeled. A `"version"` npm script is
the canonical npm-native fix: npm runs it automatically during `npm version`, after the bump and before
the commit/tag, so the propagated manifests land in the same commit.

## What (scope)
- Add to `package.json` `scripts`:
  ```jsonc
  "version": "node scripts/sync-versions.mjs && git add -A"
  ```
  (npm runs `version` after writing the new number and before creating the commit/tag, so `sync-versions`
  propagates the bump into every manifest and `git add -A` stages them into the version commit.)
- **Guard the `git add -A` against the project-memory footgun.** Project memory: `git add -A` can silently
  stage deletion of tracked binary assets absent from a local checkout (`assets/logos/**`). Either scope
  the add to the manifest paths `sync-versions` actually writes, or document a `--diff-filter=D` check in
  the go-live runbook. PREFER scoping the add to the touched files over a blanket `-A`.
- Update RELEASING.md "Cut the release" to drop the manual "run sync-versions before `npm version`"
  workaround now that the lifecycle hook does it.

## Acceptance criteria
- **c-AC-1 — `"version"` script wired.** `package.json` has a `version` npm script that runs
  `sync-versions` and stages the result.
- **c-AC-2 — A bump propagates + stages every manifest.** A throwaway `npm version --no-git-tag-version
  patch` (or a dry equivalent) updates the version in every harness manifest `sync-versions` owns AND
  leaves them staged; reverted after the check (no real bump committed by this PRD).
- **c-AC-3 — No asset deletion staged.** The version script does not stage deletion of any tracked asset
  (the `git add` is scoped, or the runbook documents the `--diff-filter=D` guard). Proven by a
  `git status --short` showing only manifest edits after a throwaway bump.
- **c-AC-4 — Runbook updated.** RELEASING.md no longer instructs the maintainer to run `sync-versions` by
  hand before `npm version`.
- **c-AC-5 — Gates green.** `npm run ci` + `build` stay green; `sync-versions` still runs as `prebuild`
  too (the hook is additive, not a replacement).

## Risks / Out of scope
- **Risk — `git add -A` stages an asset deletion (project memory).** Mitigated by c-AC-3 (scoped add /
  diff-filter guard).
- **Risk — double-run.** `sync-versions` runs in both `prebuild` and now `version`; it is idempotent, so a
  double-run is harmless. Confirm idempotency holds.
- **Out of scope — changing the version NUMBER / cutting a real bump.** This wires the mechanism; it does
  not bump or tag (PRD-048 D-1).
- **Out of scope — `sync-versions.mjs`'s own logic.** Consumed as-is; not re-spec'd here.

## Dependencies
- `scripts/sync-versions.mjs` (the propagator the hook invokes).
- `package.json` `scripts` (where `version` is added; `prebuild` already calls sync-versions).
- RELEASING.md "Cut the release" (the runbook step this supersedes).
- Project memory: [git add -A deletes missing assets] — the guard rail for c-AC-3.

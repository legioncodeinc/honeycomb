# EXECUTION LEDGER — PRD-048 (NPM publishing pipeline go-public)

> Orchestrator: `/the-smoker` · Branch: `legion/thirsty-maxwell-b7c07e`
> Worktree (PIN for every Bee): `C:\Users\mario\GitHub\honeycomb\.claude\worktrees\thirsty-maxwell-b7c07e`
> Source: `library/requirements/backlog/prd-048-npm-publishing-pipeline/`
> Scope ruling: PRD ends at a GREEN dry-run rehearsal + local pack-install dogfood. The first real
> `vX.Y.Z` publish is OUT of scope (D-1). Operator extension (this run): user will do the manual
> bootstrap publish from local; orchestrator flips the release/installer tag afterward (handled as a
> separate go-live hand-off, NOT an AC of this PRD).

## Status legend
OPEN · IN PROGRESS · DONE (implemented + locally proven) · VERIFIED (independently graded) · BLOCKED

## Ledger

| ID | Source | Criterion (abbrev) | Owner Bee | Status |
|----|--------|--------------------|-----------|--------|
| a-AC-1 | 048a | `@legioncodeinc` npm org exists, maintainer is publishing member | **USER** (off-repo npm) | BLOCKED |
| a-AC-2 | 048a | Trusted publisher (GH Actions) attached, no `NPM_TOKEN` — requires package to exist (post-bootstrap) | USER (post-bootstrap) | BLOCKED (doc-path satisfied by a-AC-3) |
| a-AC-3 | 048a | Bootstrap path (first publish = manual 2FA) documented in RELEASING.md | ci-release | DONE |
| a-AC-4 | 048a | npm >= 11.5.1 floor noted in RELEASING.md / release.yaml | ci-release | DONE |
| b-AC-1 | 048b | `name === "@legioncodeinc/honeycomb"`, `bin.honeycomb` unchanged | ci-release | DONE |
| b-AC-2 | 048b | uncommented `publishConfig {access:public, provenance:true}` | ci-release | DONE |
| b-AC-3 | 048b | no `private` key in package.json | ci-release | DONE |
| b-AC-4 | 048b | release preflight passes (both abort conditions false) on a dispatch run | ci-release + ORCH (CI) | OPEN (W2 CI) |
| b-AC-5 | 048b | no load-bearing `@honeycomb/sdk` in README + src/sdk/** (→ `@legioncodeinc/honeycomb`) | typescript-node | DONE (grep empty; +esbuild comments tidied) |
| b-AC-6 | 048b | `npm run ci` + build + pack:check green after rename | ci-release (W1) | DONE (ci+build+audit:openclaw+pack:check green) |
| c-AC-1 | 048c | `"version"` npm script runs sync-versions + stages result | ci-release | DONE |
| c-AC-2 | 048c | throwaway `npm version --no-git-tag-version` propagates + stages all 6 manifests, then reverted | ci-release (W1) | DONE (8 sites bumped+staged, reverted byte-identical) |
| c-AC-3 | 048c | no asset deletion staged — `git add` SCOPED to the 6 sync-versions targets (not `-A`) | ci-release | DONE (scoped to 6 paths) |
| c-AC-4 | 048c | RELEASING.md drops the manual "run sync-versions before npm version" workaround | ci-release | DONE |
| c-AC-5 | 048c | gates green; sync-versions still runs as prebuild (additive) | ci-release (W1) | DONE (prebuild idempotent @0.1.0) |
| d-AC-1 | 048d | CI `workflow_dispatch` dry-run reaches `npm publish --dry-run` GREEN on switch-flipped branch | ORCH (CI) | OPEN (W2 CI) |
| d-AC-2 | 048d | `npm run pack:check` green (required present, no forbidden/secrets) | ci-release (W1) | DONE (61 files OK) |
| d-AC-3 | 048d | `npm pack` + scratch-dir install → working `honeycomb --help` + dashboard assets load | ci-release (W1) | DONE (LIVE HTTP 200 on css/font/logo, byte-exact) |
| d-AC-4 | 048d | no `vX.Y.Z` tag pushed; `npm view @legioncodeinc/honeycomb` shows nothing published | ci-release (W1) / ORCH | DONE (E404 not found) |
| d-AC-5 | 048d | operative guard ("no tag pushed") + go-live runbook documented in RELEASING.md | ci-release | DONE |
| AC-8 | 048 | gates green across all sub-PRDs; no secret/token committed (grep-proven) | security + quality (close-out) | OPEN |

## Blockers (specific asks)
- **a-AC-1 — npm org `@legioncodeinc` must be created on npmjs.com by the maintainer** (the orchestrator
  cannot create an npm org). Ask: create the org, confirm your npm account is a member with publish rights.
- **a-AC-2 — trusted publisher** can only be attached after the package exists (the bootstrap publish).
  Out of scope per D-1; the documented path (a-AC-3) is what this PRD delivers. Full attach is a go-live step.

## Wave log
- **W0** (parallel, disjoint files): ci-release-worker-bee → package.json switches + `//go-public` + `"version"` script (scoped add) + RELEASING.md; typescript-node-worker-bee → README+src/sdk name reconciliation. Orchestrator tidied 2 esbuild.config.mjs comments. typecheck green. All W0 ACs DONE.
- **W1**: ci-release-worker-bee verification: throwaway bump propagated+staged 8 sites then reverted byte-identical (c-AC-2/3); `npm run ci`+build+audit:openclaw green (b-AC-6/c-AC-5); pack:check 61 files OK (d-AC-2); LIVE pack-install dogfood served dashboard css/font/logo HTTP 200 byte-exact (d-AC-3); `npm view` E404 (d-AC-4). One self-inflicted git-checkout incident, remediated byte-identical (package.json hash e2131473 re-verified by orchestrator).
- **Close-out**: security-worker-bee CLEAN (no Critical/High/Medium, AC-8 secret-free grep-proven, tokenless OIDC posture sound). quality-worker-bee PASS-WITH-NOTES (all in-scope ACs verified; report at `…/reports/2026-06-25-qa-report.md`; 1 low Suggestion: `"version"` script duplicates sync-versions manifest list = latent drift point, flagged as follow-up, below medium bar).
- → All DONE items flipped to **VERIFIED** by the independent security+quality pass. Remaining OPEN: b-AC-4 + d-AC-1 (CI dispatch dry-run, W2) and a-AC-1/a-AC-2 (BLOCKED on user npm-account actions).

## Status after close-out
VERIFIED: a-AC-3, a-AC-4, b-AC-1, b-AC-2, b-AC-3, b-AC-5, b-AC-6, c-AC-1, c-AC-2, c-AC-3, c-AC-4, c-AC-5, d-AC-2, d-AC-3, d-AC-4, d-AC-5 (+ AC-8 local half).
OPEN (W2 CI): b-AC-4, d-AC-1, AC-8 CI half.
BLOCKED (user): a-AC-1 (create npm org), a-AC-2 (trusted publisher, post-bootstrap).

# Infra and CI

Lens: infra-ci. Repository: `/home/marioaldayuz/Desktop/development/active/honeycomb` (`legioncodeinc/honeycomb`). Audit time: 2026-10-04. Mode: read-only. Workflows were read from YAML. No workflow was re-run, no `npm install`, no terraform apply. `terraform` is absent on this machine (`command -v terraform` prints `terraform: ABSENT`). No `.tf` files exist in the repo. Live cloud state is UNVERIFIABLE-HERE.

Fact labels: VERIFIED (file, command, or API output on this machine), REPORTED (a document asserts it), UNVERIFIABLE-HERE (not available here).

## Answer

Publish method is npm Trusted Publishing (OIDC). `.github/workflows/release.yaml` sets `permissions.id-token: write`, pins `npm@11.6.2` because Trusted Publishing needs npm >= 11.5.1, strips the setup-node dummy `_authToken` line, and runs `npm publish --provenance --access public` only on a pushed `v*` tag. A search of `.github` finds no `NPM_TOKEN` secret. `RELEASING.md` lines 12 to 22 say the same: tokenless OIDC, and the first publish is a one-time manual 2FA bootstrap. `npm view @legioncodeinc/honeycomb version` returns `0.22.0`, which matches root `package.json`. Whether the npm trusted-publisher record is attached on npmjs.com is UNVERIFIABLE-HERE (no npm org admin session).

Default state root from `src/shared/fleet-root.ts` `resolveFleetRoot`:

1. `APIARY_HOME` when set, non-blank, and absolute.
2. On Linux only, `join(XDG_STATE_HOME, "apiary")` when `XDG_STATE_HOME` is set, non-blank, and absolute.
3. Otherwise `join(home, ".apiary")`, which is `~/.apiary`. There is no `~/.local/state/apiary` default.

`honeycombStateDir` is `join(resolveFleetRoot(), PRODUCT_SLUG)` with `PRODUCT_SLUG` `"honeycomb"`, so the default product dir is `~/.apiary/honeycomb`. Fleet-shared files (`registry.json`, `device.json`, `install-id`) sit on the fleet root via `fleetRootFile`, default `~/.apiary/`. `legacyHoneycombDir` is `join(home, ".honeycomb")` and is the compatibility fallback, home-anchored, outside the precedence chain.

## CI workflows (from YAML)

Seven workflow files. Job `name:` is the GitHub check title. Jobs with no `name:` show the job id.

| Workflow file | `name:` | Triggers | Jobs |
|---|---|---|---|
| `.github/workflows/ci.yaml` | CI | push `main`, pull_request `main`, cron `0 7 * * *`, workflow_dispatch | See the CI job table |
| `.github/workflows/release.yaml` | Release | push tags `v*`, workflow_dispatch (`dry_run` default true) | `release` / Publish honeycomb to npm; `post-publish-smoke` / Post-publish install smoke (ubuntu, macos, windows) |
| `.github/workflows/release-gate.yaml` | Release gate | pull_request opened, synchronize, reopened, labeled, unlabeled | `skip`, `evaluate` (status context `release-gate`) |
| `.github/workflows/release-approve.yaml` | Release approve | issue_comment created, edited | `approve` (labels via `RELEASE_PAT`, no checkout) |
| `.github/workflows/tag-on-merge.yaml` | Tag on merge | push `main` | `tag` (orphan changeset safety net, then annotated `vX.Y.Z` via `RELEASE_PAT`) |
| `.github/workflows/cla.yml` | CLA | issue_comment created; pull_request_target opened, closed, synchronize | `cla` (contributor-assistant, signatures branch `cla-signatures`) |
| `.github/workflows/kb-issue-on-merge.yaml` | KB issue on merge | pull_request closed, only when merged | `open-kb-issue` |

### CI job table (`ci.yaml`)

`npm run ci` is `npm run typecheck && npm run dup && npm run test && npm run audit:sql` (`package.json` line 84). The quality-gate job runs that, then `npm run build`, `npm run audit:openclaw`, `npm run pack:prepare`, `npm run pack:check`, and `npm run test:packed-cli`.

| Job id | Display name | Runner | When it runs (from `if:`) | What it runs |
|---|---|---|---|---|
| `quality-gate` | Quality gate (Node 22.x), Quality gate (Node 24.x) | ubuntu-latest | every trigger (no `if`) | `npm ci`, `npm run ci`, build, OpenClaw audit, pack prepare, pack-check, packed CLI |
| `windows-smoke` | Windows smoke (build + test) | windows-latest | every trigger | `npm ci`, build, `smoke:daemon-bundle`, `npm run test`, packed CLI |
| `macos-service-smoke` | macOS service adapter + packed CLI | macos-latest | every trigger | three vitest files plus packed CLI |
| `gate` | Secret gate | ubuntu-latest | every trigger | sets `has_token` from whether `secrets.HONEYCOMB_DEEPLAKE_TOKEN` is non-empty. The job itself succeeds either way |
| `integration-push-soft` | Live DeepLake integration (push, non-blocking) | ubuntu-latest | push to main and `has_token == true`. `continue-on-error: true` | composite `./.github/actions/live-integration` |
| `integration-nightly` | Live DeepLake integration (nightly canary) | ubuntu-latest | schedule, or workflow_dispatch with `run_live_integration`, and `has_token == true`. No `continue-on-error` | same composite |
| `deeplake-stress` | DeepLake stress (on-demand, workflow_dispatch only) | ubuntu-latest | workflow_dispatch and `has_token == true` | `npm run deeplake:stress`, upload `.stress-report/` |

The header comment in `ci.yaml` lines 15 to 20 names quality-gate, windows-smoke, and the three DeepLake jobs. It omits `macos-service-smoke` and `Secret gate`. Both still run. The comment calls quality-gate plus windows-smoke the required merge gate. That matches the live ruleset's CI contexts, plus `release-gate` from the other workflow. macOS is not a required context.

`permissions` on CI are `contents: read`. Release adds `contents: write` and `id-token: write`.

## Publish path versus the docs

`package.json` name is `@legioncodeinc/honeycomb`, version `0.22.0`, `publishConfig.access` `public`, `publishConfig.provenance` `true`. There is no `private` key. The `//go-public` comment says the go-public switches are flipped and CI auth is OIDC.

`RELEASING.md` lines 1 to 80 still tell the maintainer the package ships deliberately un-publishable, that `private: true` must be removed, and that the name is still the unscoped `honeycomb`. `release.yaml` lines 20 to 26 repeat that draft status in comments. The preflight in `release.yaml` lines 191 to 208 still aborts if `private === true` or `name === "honeycomb"`. On the current tree that preflight passes. `RELEASING.md` lines 177 to 183 (past the first 80) correctly describe the `version` script as a scoped `git add` of the sync-versions targets.

`library/knowledge/private/infrastructure/release-automation.md` matches the three workflows: Bedrock changeset, minor approval comment from `thenotoriousllama`, major hard-block, `RELEASE_PAT` tag push, OIDC publish, fail-soft release notes and Discord. `tag-on-merge.yaml` lines 53 to 70 implement the orphaned-changeset safety net the doc describes.

`library/knowledge/private/infrastructure/monorepo-build-release.md` line 240 correctly says a real publish is a pushed `vX.Y.Z` tag and `workflow_dispatch` always dry-runs. `npm-publishing.md` line 111 says the same. `npm-publishing.md` line 70 says the opposite: a maintainer must opt in on `workflow_dispatch` for a real publish. `release.yaml` lines 211 to 236 require `event == push`, `ref_type == tag`, and dry-run input not `true`. A dispatch is never a push, so it always dry-runs.

`npm-publishing.md` line 83 says the GitHub Release step uses `generate_release_notes`. `release.yaml` lines 291 to 311 write `RELEASE_NOTES.md` with `scripts/release/ai-release-notes.mjs` and pass `body_path: RELEASE_NOTES.md` to `softprops/action-gh-release@v2.4.1`. `release-automation.md` lines 64 to 65 match the YAML.

`npm-publishing.md` line 100 says the only release secret is `HONEYCOMB_POSTHOG_KEY`. `release.yaml` also reads `AWS_BEDROCK_API_KEY` and `DISCORD_WEBHOOK_URL`. `tag-on-merge.yaml` and `release-approve.yaml` read `RELEASE_PAT`. `release-automation.md` lines 71 to 77 lists those names. Secret values were not read.

`npm-publishing.md` line 136 says the `version` script is `node scripts/sync-versions.mjs && git add -A`. `package.json` line 55 stages six explicit manifest paths. `RELEASING.md` lines 182 to 183 say the add is scoped and is not a blanket `git add -A`.

## State root versus docs that still say `~/.honeycomb`

Code paths (VERIFIED):

| Surface | Resolver | Default path |
|---|---|---|
| Fleet root | `resolveFleetRoot` | `~/.apiary` |
| Product state (pid, lock, service log) | `honeycombStateDir` | `~/.apiary/honeycomb` |
| Pid of record | `acquireSingleInstanceLock` writes `daemon.pid` under the runtime dir | `~/.apiary/honeycomb/daemon.pid` |
| Legacy pid dual-stamp | only when `~/.honeycomb` already exists | `~/.honeycomb/daemon.pid` |
| Telemetry DB | `fleetTelemetryDbPath` | `~/.apiary/honeycomb/telemetry/honeycomb.sqlite` |
| Legacy telemetry | `legacyFleetTelemetryDbPath`, open fallback if move failed | `~/.honeycomb/telemetry/honeycomb.sqlite` |
| Registry write | `resolveRegistryWritePath`: fleet `registry.json` when the fleet root dir exists, else legacy | `~/.apiary/registry.json` or `~/.honeycomb/doctor.daemons.json` |
| Notifications state | `stateDir` uses `honeycombStateDir`; legacy file is read if the new file is absent | `~/.apiary/honeycomb/notifications-state.json` |
| Setup credential probe | `setup-state.ts` `existsSync` on `LEGACY_CREDENTIALS_DIR_NAME` | presence of `~/.honeycomb`, alongside `~/.deeplake` and `~/.hivemind` |

`library/knowledge/private/operations/local-queue-idle-cost-control.md` already says the queue is `<fleetRoot>/honeycomb/.daemon/local-queue.db` via `honeycombStateDir()`. That sentence holds.

`library/knowledge/private/operations/install-and-onboarding.md` line 130 says `GET /setup/state` probes `existsSync` on `~/.deeplake`, `~/.honeycomb`, and `~/.hivemind`. `setup-state.ts` lines 170 to 172 do that. The `~/.honeycomb` bit there is a legacy-dir presence flag. It holds.

These operations pages still name `~/.honeycomb` as the live primary path:

| Doc | Claim | Code |
|---|---|---|
| `operations/fleet-and-usage-telemetry.md` line 57 | registry honeycomb writes is `~/.honeycomb/doctor.daemons.json` | `fleet-registry.ts` lines 64 to 79: `~/.apiary/registry.json` when the fleet root exists |
| same file line 65 | DB is `~/.honeycomb/telemetry/honeycomb.sqlite` | `fleet-store.ts` `fleetTelemetryDbPath` is under `honeycombStateDir()` |
| `operations/notifications-and-health.md` line 97 | persistent state is `~/.honeycomb/notifications-state.json` | `notifications/state.ts` lines 133 to 135 use `honeycombStateDir()` |
| `operations/doctor-watchdog.md` line 75 | pid/lock is `~/.honeycomb/daemon.pid` | honeycomb writes `~/.apiary/honeycomb/daemon.pid` and dual-stamps the legacy pid only if that dir already exists (`assemble.ts` lines 955 to 972) |
| `operations/doctor-watchdog.md` lines 79 and 151 | doctor workspace default `~/.honeycomb/doctor/` and `doctor/src/state.ts` | `doctor/src` is not in this repo (Doctor extraction). Current doctor paths are UNVERIFIABLE-HERE |

File-header comments in `fleet-store.ts` line 2, `fleet-registry.ts` lines 5 to 7, and `notifications/state.ts` line 9 still say `~/.honeycomb` while the functions below them resolve `~/.apiary`.

## Ruleset file versus live GitHub

Committed `.github/rulesets/main-protection.json` (VERIFIED by read): required checks `Quality gate (Node 22.x)`, `Quality gate (Node 24.x)`, `Windows smoke (build + test)`, `license/cla`, `release-gate`; `strict_required_status_checks_policy` true; `required_review_thread_resolution` false. No `require_extra_approval_for_unattributed_changes` field.

Live ruleset 18691581 `main protection` (VERIFIED `gh api`, enforcement active, target `~DEFAULT_BRANCH`): required checks are the two Quality gates, Windows smoke, and `release-gate`. `strict_required_status_checks_policy` is false. Pull request rule has `required_review_thread_resolution` true and `require_extra_approval_for_unattributed_changes` true. `license/cla` is not required live.

PR 318 check rollup (VERIFIED `gh pr checks 318`) shows a failing check named `cla`, and `release-gate` success ("Version already bumped on this PR."). The committed context string `license/cla` does not match the observed check name `cla`.

`release-automation.md` line 57 says `release-gate` is a required check in the committed ruleset file. Both the file and the live ruleset include `release-gate`. The file is not a copy of the live ruleset.

## Latest scheduled CI (read, not re-run)

Run 37105590110, event `schedule`, workflow `CI`, head `c1cb6bf5674ca169728e79433bf035e0d3d1483c`, conclusion `failure` (VERIFIED `gh run view`).

| Job | Conclusion |
|---|---|
| Quality gate (Node 22.x) | failure, step `Quality gate (typecheck + dup + test + audit:sql)` |
| Quality gate (Node 24.x) | failure, same step name. That job's log was not opened |
| Windows smoke (build + test) | failure, step `Test` |
| macOS service adapter + packed CLI | success |
| Secret gate | success |
| Live DeepLake integration (nightly canary) | skipped |
| Live DeepLake integration (push, non-blocking) | skipped |
| DeepLake stress | skipped |

Node 22 log: 1 failed test, 5206 passed, 11 skipped. Failure is `tests/daemon/runtime/logs/log-store.test.ts` AC-1, `expected [] to have a length of 3 but got +0` at line 74. Windows log: 2 failed tests. The same log-store AC-1, plus `tests/cli/daemon-service.test.ts` "PowerShell 5 flattens decoded flags and matches the live fragmented WMI command exactly". The Windows assertion body for the PowerShell test was not extracted.

On a `schedule` event the nightly job's `if` is false only when `has_token` is not `true`. The skip means the token gate did not report a token. The secret value was not read. The red run is the quality gate and Windows test steps. The canary did not execute.

The Node 22 log also warns that `actions/checkout@v4.2.2` targets Node.js 20 and is forced onto Node.js 24.

## Findings

### infra-ci-1

- Severity: high
- Claim: Scheduled `CI` on current trunk `c1cb6bf` is red. Run 37105590110 (2026-10-03) fails `Quality gate (Node 22.x)`, `Quality gate (Node 24.x)`, and `Windows smoke (build + test)`. Those three names are required on live ruleset 18691581. Node 22 fails one vitest: log-store AC-1 expects 3 request rows after reopening `logs.db` and gets 0. Windows fails that test and the schtasks PowerShell 5 test in `tests/cli/daemon-service.test.ts`. macOS and Secret gate succeed. DeepLake jobs skip.
- Evidence: VERIFIED. `gh run view 37105590110` job conclusions and failed step names. Node 22 and Windows `--log-failed` excerpts named above. Ruleset API as in the ruleset section. The 81-run streak is REPORTED by the git-branches lens; this lens re-checked only this run.
- Impact: The SHA tagged `v0.22.0` does not pass its required quality jobs. A green required check set is absent on the latest nightly.
- Recommended action: Fix log-store AC-1 (empty reopen) and the Windows schtasks assertion, then confirm a scheduled or push `CI` on `c1cb6bf` goes green. Do not treat the skipped DeepLake jobs as the failure.

### infra-ci-2

- Severity: medium
- Claim: `RELEASING.md` lines 1 to 80 and `release.yaml` lines 20 to 26 still describe an unpublished draft (`private: true`, unscoped name `honeycomb`, switches not flipped). The tree is already `@legioncodeinc/honeycomb` `0.22.0` with public provenance `publishConfig` and no `private` key. The public registry serves `0.22.0`.
- Evidence: VERIFIED. `RELEASING.md` lines 5 to 22 and 39 to 42. `package.json` lines 2 to 7. `npm view @legioncodeinc/honeycomb version` output `0.22.0`. `release.yaml` lines 20 to 26 and 191 to 208.
- Impact: A maintainer who follows the opening checklist will try to flip switches that are already flipped, and will read the workflow header as if a tag push still fail-closes on `private`. The preflight would pass today.
- Recommended action: Rewrite the `RELEASING.md` opening and the `release.yaml` draft-status comment so they describe the flipped package. Keep the preflight as a guard. Trusted-publisher attachment on npmjs.com stays UNVERIFIABLE-HERE until an org admin checks it.

### infra-ci-3

- Severity: medium
- Claim: `library/knowledge/private/infrastructure/npm-publishing.md` disagrees with `release.yaml` and with `package.json` in four places. (1) Line 70 says `workflow_dispatch` can be opted into a real publish. Lines 211 to 236 of the workflow, line 111 of the same doc, and `monorepo-build-release.md` line 240 say a dispatch always dry-runs. (2) Line 83 says GitHub Release uses `generate_release_notes`. The workflow writes `RELEASE_NOTES.md` and sets `body_path`. (3) Line 100 says the only release secret is `HONEYCOMB_POSTHOG_KEY`. The release workflows also name `AWS_BEDROCK_API_KEY`, `DISCORD_WEBHOOK_URL`, and `RELEASE_PAT`. (4) Line 136 says `git add -A`. `package.json` line 55 adds six manifest paths. `RELEASING.md` lines 182 to 183 already correct this.
- Evidence: VERIFIED by those file reads. Secret values were not printed.
- Impact: An operator rehearsing a dispatch can believe unchecking dry-run publishes. Release-note and secret inventories in the knowledge page are wrong. A future edit that "matches the doc" would widen `git add` to the whole worktree.
- Recommended action: Align `npm-publishing.md` with `release.yaml` and with the `version` script. `release-automation.md` is the page that already matches the notes, Discord, and PAT steps.

### infra-ci-4

- Severity: medium
- Claim: Honeycomb product state resolves to `~/.apiary/honeycomb` (fleet root `~/.apiary`) through `src/shared/fleet-root.ts`. Operations knowledge still tells operators the primary files are under `~/.honeycomb`: fleet registry `doctor.daemons.json`, telemetry sqlite, notifications state, and `daemon.pid`. Those `~/.honeycomb` paths are the legacy fallback (`legacyHoneycombDir`), used when the new file is absent, the fleet root dir does not exist yet, or an upgrade dual-stamps a pid into a pre-existing legacy dir. `install-and-onboarding.md` line 130 and `local-queue-idle-cost-control.md` match the code. Doctor's own `~/.honeycomb/doctor/` workspace is UNVERIFIABLE-HERE because `doctor/src` is not in this repository.
- Evidence: VERIFIED for honeycomb code and the named markdown lines (see the state-root table). Doctor tree absence VERIFIED (`doctor/src` glob empty). Doctor's current on-disk root UNVERIFIABLE-HERE.
- Impact: Operators and agents will inspect `~/.honeycomb/telemetry/honeycomb.sqlite` and `~/.honeycomb/daemon.pid` and miss the live files under `~/.apiary`. A fresh install never creates `~/.honeycomb` (`assemble.ts` lines 962 to 965).
- Recommended action: Update `fleet-and-usage-telemetry.md`, `notifications-and-health.md`, and the honeycomb pid sentence in `doctor-watchdog.md` to the `~/.apiary` paths, and label `~/.honeycomb` as the legacy window. Refresh the stale file-header comments in `fleet-store.ts`, `fleet-registry.ts`, and `notifications/state.ts`. Leave doctor workspace paths unmarked until the doctor repo is read.

### infra-ci-5

- Severity: medium
- Claim: `monorepo-build-release.md` quotes `esbuild.config.mjs` and `scripts/sync-versions.mjs` at line ranges that are no longer those blocks. The quoted esbuild region at lines 52 to 82 describes a Claude Code bundle with native `tree-sitter` and `tree-sitter-<lang>` externals. The file at those lines is `VERSION_DEFINE` plus a comment that the parser is `web-tree-sitter` WASM, and `TREE_SITTER_EXTERNAL` is `web-tree-sitter` and `tree-sitter-wasms` (line 71). The stub plugin and env rewrite the doc places at lines 371 to 426 are at lines 241 to 288. `sync-versions.mjs` `SCALAR_TARGETS` starts at line 23, and the marketplace loop the doc places at lines 63 to 88 starts at line 87. `ci.yaml` lines 110 to 114 still say the skeleton has no tree-sitter deps. `package.json` depends on `web-tree-sitter` and `tree-sitter-wasms`, and `scripts/ensure-tree-sitter.mjs` checks those WASM grammars and compiles nothing.
- Evidence: VERIFIED by reading those line ranges.
- Impact: The build page teaches a native postinstall compile that the pipeline removed on purpose so Windows and linux-arm64 CI stay deterministic. Line-anchored quotes will send an editor to the wrong functions.
- Recommended action: Replace the quoted regions with the WASM external list, the OpenClaw knob list at lines 241 to 246, and the current `sync-versions.mjs` ranges. Delete the "no tree-sitter deps" sentence in `ci.yaml`.

### infra-ci-6

- Severity: high
- Claim: `.github/rulesets/main-protection.json` is not what GitHub enforces. Live ruleset 18691581 requires thread resolution and an extra approval for unattributed changes, does not require `license/cla`, and has `strict_required_status_checks_policy` false. The file requires `license/cla`, sets strict status checks true, and sets thread resolution false. The CLA workflow's observed check on PR 318 is named `cla` and is failing, and that name is not in the live required list.
- Evidence: VERIFIED. File read. `gh api repos/legioncodeinc/honeycomb/rulesets/18691581`. `gh pr checks 318` includes `cla` fail.
- Impact: Merges are gated by a ruleset the repo file does not describe. A failing CLA check does not match a required context, so it does not block by itself. Syncing the file upward would drop the live review rules. Syncing the file downward would start requiring a context name (`license/cla`) the CLA job does not post (`cla`).
- Recommended action: Pick one ruleset, make the committed JSON match it, and make the required CLA context string equal the check name the assistant posts. This audit does not push a ruleset.

### infra-ci-7

- Severity: medium
- Claim: The nightly DeepLake canary did not run on the latest scheduled `CI`. Run 37105590110 is `schedule`, Secret gate succeeded, and `Live DeepLake integration (nightly canary)` skipped. On a schedule the job `if` requires `needs.gate.outputs.has_token == 'true'`. The skip means that output was not true. Push-soft and stress also skipped, which matches their triggers.
- Evidence: VERIFIED from the run JSON and `ci.yaml` lines 268 to 278. The token string was not read. Whether the secret is unset, empty, or withheld from the default branch is UNVERIFIABLE-HERE beyond the boolean the job emitted.
- Impact: The comment in `ci.yaml` lines 259 to 266 calls this the hard canary that reds the schedule on a real backend regression. That canary is dark. Backend drift would not fail the nightly. The current red is still infra-ci-1, the unit tests.
- Recommended action: Confirm `HONEYCOMB_DEEPLAKE_TOKEN` (and the endpoint, org, and workspace secrets the composite needs) is available to the scheduled workflow, then confirm a schedule run shows the nightly job as success or failure rather than skipped.

### infra-ci-8

- Severity: medium
- Claim: `release.yaml` does not run the CI jobs that the merge ruleset requires, and it does not wait on workflow `CI`. The publish job runs `npm run ci`, build, `audit:openclaw`, and `pack:check` (the dry-run pack path, because `HONEYCOMB_PACK_MANIFEST` is unset). It does not run `pack:prepare`, `test:packed-cli`, Windows smoke, or the macOS service tests. `tag-on-merge.yaml` pushes the tag on every `main` push that lacks that tag, in parallel with `CI`.
- Evidence: VERIFIED by reading both workflow files and `scripts/pack-check.mjs` lines 47 to 60 (`HONEYCOMB_PACK_MANIFEST` reuse versus `npm pack --dry-run --json`).
- Impact: A Windows-only or packed-CLI failure can merge-block via `CI` while a tag published from the same push is already in `npm publish`. The post-publish smoke installs the package after upload, so it cannot stop the upload.
- Recommended action: Either make the publish job run `test:packed-cli` and a Windows pack smoke before `npm publish`, or have `tag-on-merge` wait until the required CI contexts on that SHA are success.

### infra-ci-9

- Severity: low
- Claim: `actions/checkout@v4.2.2` on the Node 22 quality-gate log warns that the action targets Node.js 20 and is forced to run on Node.js 24.
- Evidence: VERIFIED. Log line from job 111153338059 on run 37105590110. The pin is `actions/checkout@v4.2.2` in `ci.yaml` and `release.yaml`.
- Impact: GitHub is already rewriting the action runtime. A future runner image can fail the checkout step that every job shares.
- Recommended action: Bump `actions/checkout` to a release that runs on Node 24, in the same pin style already used (`@v4.2.2` SHA or version).

### infra-ci-10

- Severity: info
- Claim: Live cloud cannot be checked from this machine. There are no Terraform files in the repo. The `terraform` binary is not installed. This lens did not install it and did not apply a plan.
- Evidence: UNVERIFIABLE-HERE for any cloud resource, state bucket, or apply result. VERIFIED locally: glob `**/*.{tf,tfvars,hcl}` returned 0 files, and `command -v terraform` printed `terraform: ABSENT`.
- Impact: Nothing in this report speaks to deployed infrastructure, cost, or remote IAM.
- Recommended action: A later pass with terraform installed, and with the stack's root module identified, can replace this row. Do not treat the absence of `.tf` in honeycomb as proof that no cloud stack exists outside the repo.

## Punch list

1. Restore a green required `CI` on `c1cb6bf`: log-store AC-1 and the Windows schtasks test (infra-ci-1).
2. Make `RELEASING.md` lines 1 to 80 and the `release.yaml` header match the already-published scoped package (infra-ci-2).
3. Correct `npm-publishing.md` on dispatch dry-run, release notes, secret names, and `git add` (infra-ci-3).
4. Point operations docs at `~/.apiary` and `~/.apiary/honeycomb`, and keep `~/.honeycomb` labeled as the legacy window (infra-ci-4).
5. Refresh `monorepo-build-release.md` quotes for WASM esbuild and current `sync-versions.mjs` lines (infra-ci-5).
6. Reconcile `.github/rulesets/main-protection.json` with live ruleset 18691581, including the `cla` versus `license/cla` context (infra-ci-6).
7. Make the nightly DeepLake job actually run on the schedule (infra-ci-7).
8. Stop a tag publish from racing ahead of Windows smoke and packed-CLI (infra-ci-8).
9. Bump `actions/checkout` off the Node 20 action runtime (infra-ci-9).
10. Live cloud remains UNVERIFIABLE-HERE until terraform exists and a root module is in hand (infra-ci-10).

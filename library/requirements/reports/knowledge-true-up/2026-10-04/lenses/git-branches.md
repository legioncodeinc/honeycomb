# Git branch and history forensics

Lens: git-branches. Repository: `/home/marioaldayuz/Desktop/development/active/honeycomb` (`legioncodeinc/honeycomb`). Audit time: 2026-10-04T05:24Z. Mode: read-only. No fetch, checkout, reset, commit, or push. Remote SHAs were compared with `gh api` against the existing remote-tracking refs.

Fact labels: VERIFIED (command or API output on this machine), REPORTED (a document asserts it), UNVERIFIABLE-HERE (not available without a fetch, a log dive, or a fork object).

## Answer

Trunk is `main`. Local `main` and `origin/main` are the same commit, `c1cb6bf5674ca169728e79433bf035e0d3d1483c`, and annotated tag `v0.22.0` peels to that commit. Package `@legioncodeinc/honeycomb` is `0.22.0`. Documented flow is GitHub Flow: branch off `main` and open a pull request (`CONTRIBUTING.md` lines 57-59).

Long-lived remote heads are stale on a 30-day bar. Every non-`main` remote head last moved between 2026-07-08 and 2026-07-23 (72 to 87 days before this audit). One of them is fully merged residue (`docs/prd-059-to-hive-prd-014`). Two still hold unmerged commits (`feat/session-recall-cache`, `fix/sessions-token-columns-zero-fill`). `cla-signatures` is an intentional protected side branch, 412 commits behind trunk, last touched 2026-07-08.

Delivery on that trunk is stalled. Scheduled CI on `main` has 81 consecutive failures after a success on 2026-07-14, all on the current SHA. The three open pull requests (324, 322, 318) are `BLOCKED`.

Merge status of remote branch commits: `origin/docs/prd-059-to-hive-prd-014` tip `2146253` is an ancestor of `origin/main` (0 commits unique to the branch). `origin/cla-signatures` has 5 commits absent from `origin/main`, `origin/feat/session-recall-cache` has 3, and `origin/fix/sessions-token-columns-zero-fill` has 3.

## Scout re-verification

| Scout claim | Grade | Note |
|---|---|---|
| HEAD `main` `c1cb6bf` tracking `origin/main` | HOLDS | VERIFIED. `git rev-parse HEAD` and `@{upstream}` both `c1cb6bf5674ca169728e79433bf035e0d3d1483c`. `git status -sb` starts `## main...origin/main` with no ahead/behind count. |
| Remote heads: `cla-signatures`, `docs/prd-059-to-hive-prd-014`, `feat/session-recall-cache`, `fix/sessions-token-columns-zero-fill`, `main` | HOLDS | VERIFIED locally (`git branch -r -v`) and live (`gh api repos/legioncodeinc/honeycomb/branches`). Same five names, same short SHAs. `origin/HEAD` points at `origin/main`. Default branch is `main`. |
| Divergence vs `main`: cla 412 behind / 5 ahead; docs 8 behind / 0 ahead; session-recall 0 behind / 3 ahead; sessions-token 0 behind / 3 ahead | HOLDS | VERIFIED. `git rev-list --left-right --count origin/main...origin/<branch>` prints `behind ahead`. |
| Open PRs include 324, 322, 318 | HOLDS | VERIFIED. `gh pr list --state open` returns exactly those three. Count 3. |
| Scheduled CI on `main` failing, run 37105590110 | HOLDS | VERIFIED, and the streak is longer than one run. See git-branches-1. |
| Package version 0.22.0 | HOLDS | VERIFIED. `package.json` `version` is `0.22.0`. Tag `v0.22.0` peels to HEAD. |

## Inventory

### Local branches (`git branch -vv`)

| Branch | SHA | Upstream | Subject |
|---|---|---|---|
| `main` (current) | `c1cb6bf` | `origin/main` | feat(cli): standardize Honeycomb service interface (#316) |

One local branch. VERIFIED.

### Remote heads (`git branch -r -v` and live branch API)

| Ref | SHA | Committer date | Behind / ahead of `origin/main` | Merged into `origin/main` | Protected (live API) | Last move age |
|---|---|---|---|---|---|---|
| `origin/main` | `c1cb6bf` | 2026-07-14 01:04:04 -0400 | 0 / 0 | yes (trunk) | true | 82 days |
| `origin/cla-signatures` | `44d80f5` | 2026-07-08 12:12:53 +0000 | 412 / 5 | no | true | 87 days |
| `origin/docs/prd-059-to-hive-prd-014` | `2146253` | 2026-07-12 20:36:32 -0400 | 8 / 0 | yes (`git merge-base --is-ancestor` exit 0) | false | 83 days |
| `origin/feat/session-recall-cache` | `a45356d` | 2026-07-21 22:29:42 +0000 | 0 / 3 | no | false | 74 days |
| `origin/fix/sessions-token-columns-zero-fill` | `39defba` | 2026-07-23 19:37:14 +0000 | 0 / 3 | no | false | 72 days |

Ages are whole days from the committer timestamp to 2026-10-04T05:24Z. VERIFIED.

`git branch -r --merged origin/main` lists `origin/HEAD`, `origin/docs/prd-059-to-hive-prd-014`, and `origin/main`. The other three remote heads are in `--no-merged`. VERIFIED.

Repo `pushedAt` from `gh repo view`: 2026-07-23T19:37:15Z. That matches the sessions-token tip, which is the newest remote commit. VERIFIED.

### Worktrees, stashes, tags, recent history

- Worktrees: one. `/home/marioaldayuz/Desktop/development/active/honeycomb` at `c1cb6bf` `[main]`. VERIFIED (`git worktree list`).
- Stashes: none. VERIFIED (`git stash list` empty).
- Tags: 68 (`git tag -l | wc -l`). `git tag -l | tail` is lexical order, so `v0.9.0` sorts after `v0.22.0`. Newest semver tag on HEAD is `v0.22.0`. Annotated tag object `bb9381754b8028fc40702baaf349aed415352997`; peeled commit `c1cb6bf5674ca169728e79433bf035e0d3d1483c`. `git describe --tags --always HEAD` prints `v0.22.0`. VERIFIED.
- `git log -15 --oneline` on `main` starts at `c1cb6bf` (#316) and includes `2146253` (the docs-branch tip) in trunk history. VERIFIED.

### Open pull requests (`gh pr list --state open`)

| PR | Title | Head | Base | Created | Updated | mergeStateStatus |
|---|---|---|---|---|---|---|
| 324 | fix(pipeline): scope memory decision candidates | `chrisl10:fix/decision-candidate-context` `9bc1f5b` | `main` | 2026-07-29 | 2026-07-29 | BLOCKED |
| 322 | feat: add Hermes Agent harness adapter | `chrisl10:feat/hermes-harness` `13ceb17` | `main` | 2026-07-22 | 2026-07-22 | BLOCKED |
| 318 | fix(capture): keep sessions token columns nullable (absent = NULL, not 0) | `fix/sessions-token-columns-zero-fill` `39defba` | `main` | 2026-07-16 | 2026-07-23 | BLOCKED |

324 and 322 are fork heads. They are not `origin/*` refs. `git cat-file -t` on `13ceb17ff69e4c02153aca633e6088f36cf5bce1` and `9bc1f5bf3a9b08f9679a3d67f8a2c822c0744a65` fails in this clone. Commit contents UNVERIFIABLE-HERE. PR metadata VERIFIED via `gh`.

Closed related PR: 321 `feat(vfs): modification-time-gated session-recall cache`, state CLOSED, `mergedAt` null, `closedAt` 2026-07-21T22:29:58Z, head `a45356d` (same as the remote branch). VERIFIED.

No open or historical PR search hit for head `cla-signatures` or `docs/prd-059-to-hive-prd-014` (`gh pr list --state all --search`, empty). VERIFIED for that search. A PR merged under a different head name is UNVERIFIABLE-HERE; the docs tip is still an ancestor of `main` by git.

## Governance

**Observed strategy:** GitHub Flow. Trunk is `main`. No `develop`, `release/*`, or `hotfix/*` remote heads. Feature and fix prefixes are used. Two open PRs come from a fork, which matches `CONTRIBUTING.md` line 57 ("Fork and branch off `main`").

**Documented strategy:** REPORTED and checked. `CONTRIBUTING.md` lines 57-63: branch off `main`, keep the PR focused, pass `npm run ci`, sign the CLA, use the PR template.

**Practice versus the doc:** Trunk identity matches the doc. Branch lifetime does not. The doc implies short-lived topic branches. All four non-`main` remote heads are older than 30 days. Scheduled CI on the trunk SHA has been red since the day of the last trunk commit's successful schedule (2026-07-14), so the `npm run ci` bar in the doc is not currently green on `main` itself.

**Protection:** Legacy branch-protection GET for `main` returns HTTP 404 "Branch not protected". Rulesets are the live control. Ruleset 18691581 `main protection` is active on `~DEFAULT_BRANCH` and blocks deletion and non-fast-forward updates. It requires a pull request (review thread resolution, zero approving reviews, extra approval for unattributed changes) and status checks `Quality gate (Node 22.x)`, `Quality gate (Node 24.x)`, `Windows smoke (build + test)`, and `release-gate`. Ruleset 18020855 `cla-signatures protection` is active on `refs/heads/cla-signatures` and blocks deletion and non-fast-forward updates. Ruleset 19316969 `Code Quality Copilot review for default branch` is disabled. VERIFIED (`gh api` rulesets).

## Findings

### git-branches-1

- Severity: high
- Claim: Scheduled workflow `CI` on `main` has failed 81 times in a row on current trunk SHA `c1cb6bf`, from the run after the last success (2026-07-14, run 29320055340) through run 37105590110 (2026-10-03T07:12:35Z, conclusion `failure`). On that latest run the failed jobs are `Quality gate (Node 22.x)`, `Quality gate (Node 24.x)`, and `Windows smoke (build + test)`. Those three names are required status checks in ruleset 18691581. `macOS service adapter + packed CLI` and `Secret gate` succeeded. DeepLake jobs on that run were skipped.
- Evidence: VERIFIED. `gh run list --branch main --event schedule --limit 100`: newest 81 conclusions are `failure`; item 82 is `success` at 2026-07-14T08:59:51Z on `c1cb6bf`. `gh run view 37105590110` jobs as named above. Ruleset 18691581 `required_status_checks` lists the same three contexts plus `release-gate`.
- Impact: The trunk SHA that tag `v0.22.0` points at does not pass its own scheduled quality gate. Pull requests that fail the same required contexts stay unmergeable (see git-branches-2). A green `main` badge is absent for about 81 days.
- Recommended action: Owner or the infra-ci lens reads the three failed job logs on run 37105590110 and restores a green scheduled `CI` on `c1cb6bf` before merging the open PRs. Do not treat the skipped DeepLake jobs on this run as the failure.

### git-branches-2

- Severity: high
- Claim: The open PR set is exactly 318, 322, and 324, and every one is `mergeStateStatus` `BLOCKED`. None has been updated since 2026-07-29. PR 318 head is `origin/fix/sessions-token-columns-zero-fill` at `39defba` (0 behind `main`, 3 ahead), `mergeable` `MERGEABLE`, with failing checks `Quality gate (Node 22.x)`, `Quality gate (Node 24.x)`, `Windows smoke (build + test)`, and `cla`. PR 324 (fork) fails those same three quality jobs plus `Aikido Security: check code`. PR 322 (fork) has those three quality jobs and `cla` at `SUCCESS`, zero unresolved review threads (13 threads, all resolved), `mergeable` true, `mergeable_state` `blocked`, and the required context `release-gate` is absent from its status rollup.
- Evidence: VERIFIED via `gh pr list`, `gh pr view` 318/322/324, pulls API `mergeable_state` for 322, and GraphQL review threads plus status rollup for 322. Fork commit trees UNVERIFIABLE-HERE (objects missing locally).
- Impact: Nothing in review can land on `main`. The only origin-side code PR (318) is check-blocked even though git says it contains current `main`. PR 322 is stale with green reported gates and still blocked, so a missing `release-gate` context (or another ruleset clause such as unattributed-change approval) is holding a fork feature that otherwise looks check-green.
- Recommended action: For 318 and 324, fix the failing required checks and the 318 CLA failure, or close them. For 322, post a successful `release-gate` status on `13ceb17` and re-read `mergeable_state` before assuming a review is still required. Ages: 318 updated 72 days ago, 322 updated 74 days ago, 324 updated 66 days ago.

### git-branches-3

- Severity: medium
- Claim: `origin/feat/session-recall-cache` (`a45356d`) is unmerged residue. It is 0 behind and 3 ahead of `origin/main`. Unique commits: `d47a565` feat(vfs) modification-time-gated session-recall cache, `c62736e` chore(release) add changeset, `a45356d` chore(release) minor bump. PR 321 closed on 2026-07-21 with `mergedAt` null, and the branch is still on the remote. Diff versus `main` is 14 files, +200 / -20, centered on `src/daemon-client/vfs/read.ts` and its tests, plus version-file bumps.
- Evidence: VERIFIED. `git log --oneline origin/main..origin/feat/session-recall-cache`, `git diff --stat origin/main...origin/feat/session-recall-cache`, `gh pr view 321`.
- Impact: A closed feature remains a published head. The release-bump commits on top of an unmerged feature will conflict with the next version bump if the branch is revived blindly. The branch is 74 days old.
- Recommended action: Delete `origin/feat/session-recall-cache` if PR 321 should stay closed. Reopen a fresh branch from current `main` if the vfs cache is still wanted. Deletion is allowed by the live API (`protected` false). Owner action; this audit does not delete it.

### git-branches-4

- Severity: medium
- Claim: `origin/docs/prd-059-to-hive-prd-014` (`2146253`) is fully merged and still published. It is 8 behind and 0 ahead. `git merge-base --is-ancestor` exits 0. The tip commit appears in `git log` of `main`. The branch is unprotected. Committer date 2026-07-12 20:36:32 -0400 (83 days before this audit).
- Evidence: VERIFIED. Divergence count, ancestor check, `git branch -r --merged origin/main`, live branches API `protected: false`.
- Impact: The remote head looks like open docs work. It has no unique commits. It adds noise to branch inventories and to any automation that treats every remote head as unmerged.
- Recommended action: Delete `origin/docs/prd-059-to-hive-prd-014`. Owner action; this audit does not delete it.

### git-branches-5

- Severity: low
- Claim: `origin/cla-signatures` (`44d80f5`) is a long-lived protected side branch, not a feature branch to delete. It is 412 behind and 5 ahead of `origin/main`. Merge-base `c5bc23d` is dated 2026-06-23 05:10:46 -0400 (102 days before this audit). The 5 unique commits touch only `signatures/cla.json`. That path has no commits on `origin/main` (`git log origin/main -- signatures/cla.json` is empty). Diff stat versus `main` for that file is 36 insertions. Ruleset 18020855 blocks deletion and non-fast-forward updates. Last commit 2026-07-08 (87 days). No PR search hit for head `cla-signatures`.
- Evidence: VERIFIED. Counts, merge-base, `git log --name-only origin/main..origin/cla-signatures`, diff numstat, ruleset 18020855, live `protected: true`. File body not copied (signer records).
- Impact: Signature commits are absent from trunk by the side-branch layout the ruleset protects. The branch is also far behind trunk and idle since 2026-07-08, so a CLA bot that expects to append on this ref has not recorded a signature in 87 days. Force-pushing `main` into it is blocked.
- Recommended action: Keep the branch. Confirm the CLA workflow still commits to `cla-signatures`. Do not delete it and do not fast-forward it onto `main` under this ruleset. A signature-ledger refresh is an owner decision.

### git-branches-6

- Severity: low
- Claim: The only local branch is `main`, and its worktree is dirty. `git status -sb` shows modified and deleted paths under `library/knowledge/private/` and `library/requirements/`, plus untracked replacements under `library/requirements/completed/`, `library/requirements/in-work/`, and two new knowledge files. That work is not on a topic branch. One worktree, no stashes.
- Evidence: VERIFIED. `git branch -vv`, `git status -sb`, `git worktree list`, `git stash list`.
- Impact: In-progress library reorganization sits on the trunk checkout. A later commit on `main` would mix it with product history, and a checkout of another branch would have to carry or shelve it.
- Recommended action: When the owner wants that work saved, put it on a topic branch off `main`. This audit does not move or commit it.

### git-branches-7

- Severity: info
- Claim: Trunk identity holds. Default branch `main`. `origin/HEAD` is `origin/main`. Local `main` equals `origin/main` at `c1cb6bf`. Annotated tag `v0.22.0` peels to that commit. `package.json` version is `0.22.0`. Live branch SHAs match the local remote-tracking refs, so the clone's remote picture is current as of this audit even though git fetch was not run. `pushedAt` is 2026-07-23T19:37:15Z.
- Evidence: VERIFIED. `gh repo view`, `git rev-parse`, `git describe`, `package.json`, `gh api` branches.
- Impact: Release tag, package version, and trunk SHA agree. Branch drift is in the side heads and the open PRs, not in a mismatched local `main`.
- Recommended action: None for trunk identity. Use this SHA as the baseline for the other lenses.

### git-branches-8

- Severity: info
- Claim: `main` and `cla-signatures` are protected by repository rulesets. The legacy branch-protection endpoint for `main` returns HTTP 404. Reading only that 404 would miss ruleset 18691581 (active) and ruleset 18020855 (active).
- Evidence: VERIFIED. `gh api repos/legioncodeinc/honeycomb/branches/main/protection` status 404. `gh api repos/legioncodeinc/honeycomb/rulesets` and the two ruleset ids above. Live branches API `protected: true` for `main` and `cla-signatures` only.
- Impact: A protection audit that stops at the legacy API would report trunk as unprotected. The ruleset is what blocks direct pushes and lists the required checks that scheduled CI is failing.
- Recommended action: Later hygiene passes should cite rulesets 18691581 and 18020855. Required check names to keep in view: `Quality gate (Node 22.x)`, `Quality gate (Node 24.x)`, `Windows smoke (build + test)`, `release-gate`.

### git-branches-9

- Severity: info
- Claim: Fork PR heads are not in this clone. PR 322 head `13ceb17ff69e4c02153aca633e6088f36cf5bce1` and PR 324 head `9bc1f5bf3a9b08f9679a3d67f8a2c822c0744a65` are absent (`git cat-file -t` fatal). Their merge status against `origin/main` was not computed with local git. GitHub reports both PRs `BLOCKED`. PR 322 `mergeable` is true.
- Evidence: VERIFIED absence locally. PR state VERIFIED via `gh`. Patch contents UNVERIFIABLE-HERE without a fetch of the fork refs.
- Impact: This lens can say the PRs are open and blocked. It cannot inventory their files or prove a clean local merge.
- Recommended action: A follow-up that needs the diffs should fetch the fork refs read-only (`git fetch origin pull/322/head` and `pull/324/head` are still a fetch, so they were skipped here).

## Could not verify here

- Root cause inside the failed CI job logs (names and conclusions only).
- Whether PR 322's blocker is solely the missing `release-gate` context, or also `require_extra_approval_for_unattributed_changes` on ruleset 18691581. Both are consistent with `mergeable_state: blocked` and a green rollup of the checks that did report.
- Patch contents of fork SHAs `13ceb17` and `9bc1f5`.
- Scheduled CI history older than the 100-run window that starts 2026-06-26. The last success inside that window is 2026-07-14, and the 81 newer scheduled runs are all failures.
- Signer names inside `signatures/cla.json` (intentionally not printed).

## Commands run

`git rev-parse`, `git status -sb`, `git branch -vv`, `git branch -r -v`, `git worktree list`, `git stash list`, `git tag -l`, `git log -15 --oneline`, `git for-each-ref`, `git rev-list --left-right --count`, `git log origin/main..origin/<branch>`, `git merge-base --is-ancestor`, `git branch -r --merged` / `--no-merged`, `git diff --stat`, `git describe`, `gh pr list`, `gh pr view`, `gh run view 37105590110`, `gh run list --branch main --event schedule`, `gh api` branches, rulesets, and pulls. No mutating git.

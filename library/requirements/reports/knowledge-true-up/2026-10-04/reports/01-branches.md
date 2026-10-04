# Every branch, local and remote

Scout clock 2026-10-04T05:22:55Z. Working tree is `main` at `c1cb6bf`, tracking `origin/main`. VERIFIED: `git branch -vv`, `git ls-remote --heads origin`.

| Remote head | SHA | vs main (behind / ahead) | Status |
|---|---|---|---|
| main | c1cb6bf | 0 / 0 | trunk, tag v0.22.0 matches package 0.22.0 |
| cla-signatures | 44d80f5 | 412 / 5 | not contained in main |
| docs/prd-059-to-hive-prd-014 | 2146253 | 8 / 0 | investigator reports the unique commits are already in main |
| feat/session-recall-cache | a45356d | 0 / 3 | three commits not in main |
| fix/sessions-token-columns-zero-fill | 39defba | 0 / 3 | three commits not in main |

VERIFIED: one worktree, no stashes, only local branch `main`. Divergence counts were re-run in the scout with `git rev-list --left-right --count`.

Open PRs at scout time (VERIFIED via `gh pr list`): 324, 322, 318. The git-branches investigator reports all three are blocked and last updated in July 2026 (REPORTED). Scheduled CI on main is failing: run 37105590110 completed failure on 2026-10-03 (VERIFIED via `gh run list`). The investigator's count of 81 consecutive failures is REPORTED, not re-counted here.

The dirty worktree is knowledge and PRD folder moves. It sits on `main`. This audit did not commit it.

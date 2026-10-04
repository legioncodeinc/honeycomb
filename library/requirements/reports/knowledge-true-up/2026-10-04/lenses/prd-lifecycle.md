# PRD folder lifecycle versus working tree

Lens: prd-lifecycle. Repository: `/home/marioaldayuz/Desktop/development/active/honeycomb`. Audit time: 2026-10-04T05:38:18+00:00. Mode: read-only. No moves, edits, or commits.

Fact labels: VERIFIED (command or file on this machine), REPORTED (a document asserts it), UNVERIFIABLE-HERE (outside this clone).

## Answer

HEAD `c1cb6bf` on `main` (tracking `origin/main`) stores PRD folders under four lifecycle directories plus `reports/`. The working tree relocates eight of those folders and leaves them uncommitted. `git status --short library/requirements` prints 55 lines (the `head -200` window contains the full list): 4 modified files, 43 deletions, and 8 untracked directories.

| PRD | HEAD folder | Working-tree folder | Porcelain | Index status line (working tree) |
|---|---|---|---|---|
| 071 service check-in and SQLite telemetry | `backlog/` | `completed/` | `D` plus `??` | Backlog (line 3) |
| 072 apiary state root migration | `backlog/` | `completed/` | `D` plus `??` | Backlog (line 3) |
| 073 dormant capture and explicit tenancy | `backlog/` | `completed/` | `D` plus `??` | Backlog (line 3) |
| 074 sessions prose column | `backlog/` | `completed/` | `D` plus `??` | Backlog (line 3) |
| 077 per-turn recall fast path | `backlog/` | `completed/` | `D` plus `??` | Backlog (line 3) |
| 078 local ANN recall index | `backlog/` | `in-work/` | `D` plus `??` | Backlog, parenthetical says in-work and Phase 1 dispatched (line 3) |
| 019 harness integrations | `completed/` | `in-work/` | `D` plus `??` | In Work (reopened 2026-06-22) (line 3) |
| 020 surfaces | `completed/` | `in-work/` | `D` plus `??` | In Work (reopened 2026-06-22) (line 3) |

Byte comparison of each HEAD blob to the new path: 43 files on both sides, 39 identical, 4 index files changed by a single relative link. This report quotes those status lines and the folder. It leaves the choice between the line and the folder to the owner.

`library/requirements/reports/` is clean. Four in-place edits retarget links: archive indexes 068, 069, and 070 point PRD-071 at `completed/`, and backlog PRD-081 points PRD-077 at `completed/`.

## Folder census

Counts are `prd-*` directories only. VERIFIED (`git ls-tree` for HEAD, directory listing for the working tree).

| Folder | HEAD PRD dirs | Working-tree PRD dirs | What changed |
|---|---|---|---|
| `backlog/` | 16 | 10 | 071, 072, 073, 074, 077, 078 left |
| `in-work/` | 3 | 6 | 019, 020, 078 arrived |
| `completed/` | 58 | 61 | 019 and 020 left; 071, 072, 073, 074, 077 arrived |
| `archive/` | 4 | 4 | same four folders; 068, 069, 070 indexes edited in place |
| `archive/completed/` | 4 | 4 | unchanged cursor-extension PRDs 002 through 005 |
| `reports/` | (no `prd-*`) | (no `prd-*`) | clean |

HEAD `in-work/` PRD dirs: `prd-058-memory-lifecycle`, `prd-064-doctor-self-healing-watchdog`, `prd-066-local-queue-idle-cost-control`. That directory also holds `README.md` and `2026-06-24-requirements-sotu.md`.

Working-tree `backlog/` PRD dirs: 051, 052, 053, 054, 055, 056, 057, 059, 061, 081.

Working-tree `in-work/` PRD dirs: 019, 020, 058, 064, 066, 078.

`archive/` children: `README.md`, `completed/`, and `prd-067` through `prd-070`. There is no `archive/backlog/` directory.

### What the folder docs say

REPORTED from `library/requirements/README.md` lines 3-8 and 27-33: lifecycle equals location. `backlog/` is queued, `in-work/` is active, `completed/` is shipped, `reports/` is evergreen. The table does not name `archive/`.

REPORTED from `library/requirements/archive/README.md`: pre-merge and fleet-realignment PRDs live here. Lines 16-19 name 067 through 070 and say those numbers stay burned. Lines 8-9 also describe an `archive/backlog/` child for original scaffolds prd-001 through prd-010. That child directory is absent (VERIFIED). `archive/completed/` with the four cursor PRDs is present (VERIFIED).

REPORTED from `library/requirements/completed/README.md`: shipped folders land here and stay read-only after landing. The working tree places 019 and 020 under `in-work/`. Their status lines already say In Work.

REPORTED from `library/requirements/backlog/README.md` lines 24-47: a table titled "Current backlog" lists prd-001 through prd-020. On HEAD those folders are under `completed/`. In the working tree, 019 and 020 are under `in-work/`. None of 001 through 020 is under `backlog/`.

## File identity of the eight moves

VERIFIED. Each new tree has the same relative paths as `git ls-tree -r HEAD` of the old tree.

| PRD | Files | Identical to HEAD | Index difference |
|---|---|---|---|
| 071 | 5 | 4 | line 132: PRD-054 link rewritten to `../../backlog/prd-054-fleet-observation-control-plane/` |
| 072 | 6 | 6 | none |
| 073 | 6 | 5 | line 148: PRD-059 link rewritten to `../../backlog/prd-059-projects-onboarding/` |
| 074 | 4 | 4 | none |
| 077 | 5 | 5 | none |
| 078 | 2 | 2 | none |
| 019 | 8 | 7 | line 11: PRD-045 link rewritten to `../../completed/prd-045-daemon-wiring-closeout/reports/...` |
| 020 | 7 | 6 | line 11: same PRD-045 link rewrite |

Status lines on 071, 072, 073, 074, 077, and 078 match the HEAD text. Status lines on 019 and 020 match the HEAD text. The four index edits are relative links.

`git status --short`, `git -c status.renames=true status --short -M`, and `git diff -M --name-status` all print `D` for the old paths. The new directories appear only as `??`. `git diff` omits untracked paths, so it has no destination blob to pair. Rename detection config `status.renames`, `diff.renames`, and `diff.renamelimit` are unset. Git version 2.53.0.

108 markdown links inside the eight trees were resolved on disk. 105 resolve. Three targets in the 071 index point beside this clone and are absent here:

- `doctor/library/requirements/backlog/prd-001-service-registration-and-telemetry-ingestion/...`
- `doctor/library/requirements/backlog/prd-002-telemetry-sot-sse-and-schema/...`
- `hive/library/requirements/backlog/prd-005-health-rail-and-page/...`

`backlog/` and `completed/` sit at the same depth, so those three relative links keep the same destination after the move. Whether the doctor and hive files exist in another checkout is UNVERIFIABLE-HERE.

In-place diffs (one line each, VERIFIED):

- `archive/prd-068-...-index.md`, `archive/prd-069-...-index.md`, `archive/prd-070-...-index.md`: the PRD-071 link changes from `../../backlog/prd-071-...` to `../../completed/prd-071-...`.
- `backlog/prd-081-...-index.md` line 345: the PRD-077 link changes from a backlog sibling path to `../../completed/prd-077-per-turn-recall-fast-path/...`.

PRD-072 line 175 still links to `../prd-071-...`. Both folders are under `completed/` in the working tree, so that link resolves.

## Private knowledge paths

Checked `library/knowledge/private` for `requirements/(backlog|in-work|completed|archive)/prd-` citations of 019, 020, 066, 071, 072, 073, 074, 077, and 078.

| Citation | Working-tree path | Grade |
|---|---|---|
| `architecture/adr/0011-sessions-recall-chunking-strategy.md` line 181 cites `library/requirements/backlog/prd-074-sessions-prose-column/` | absent; folder is `completed/prd-074-sessions-prose-column/` | location is wrong on the working tree. ADR file is unmodified. |
| `frontend/cursor-extension-architecture.md` line 212 cites `library/requirements/in-work/prd-020-surfaces/prd-020c-surfaces-cursor-extension.md` | file is present under `in-work/` | matches the working tree. The same sentence is already on HEAD, where the folder still lives under `completed/`. |
| `architecture/adr/0006-...md` line 156, `0007-...md` line 178, `0009-...md` line 120 cite `library/requirements/backlog/prd-066-local-queue-idle-cost-control/...` | absent. Tracked path is `in-work/prd-066-...`. Index line 3 still says Backlog. | location is wrong on HEAD and on the working tree. These three ADR files are unmodified. 066 is outside the eight-folder move. |
| `architecture/adr/0008-...md` line 143 cites `nectar/library/requirements/backlog/prd-019-project-scoped-brooding-activation/...` | absent beside this clone | a nectar PRD, separate from honeycomb `prd-019-harness-integrations`. Existence in a nectar checkout is UNVERIFIABLE-HERE. |
| `standards/documentation-framework.md` lines 21-22 and 93-96 cite `library/requirements/features/` and `library/requirements/issues/` | both directories absent | the live PRD layout is `backlog/`, `in-work/`, `completed/`, and `archive/` with `prd-<###>-<slug>/` folders. The framework file is unmodified. |

`storage/deeplake-recall-and-capture-findings-2026-07-10.md` names PRD-077 and PRD-078 by branch (`feat/prd-077-per-turn-recall-fast-path`, `feat/prd-078-local-ann-recall-index`) and commit SHAs. It states a folder path for neither.

## Findings

Eight findings.

### prd-lifecycle-1

- Severity: medium
- Claim: The working tree relocates eight PRD folders and leaves the relocation uncommitted on `main` at `c1cb6bf`. Porcelain is 43 `D` lines and 8 `??` directories. 39 of the 43 files match the HEAD bytes. The other four indexes change one relative link each and keep their status lines.
- Evidence: VERIFIED. `git status --short library/requirements` (55 lines). Byte compare of `git show HEAD:<old>` to the new paths. `git diff -M --name-status` lists `D` for the old paths.
- Impact: A staging command that adds only tracked updates would record the deletions and leave the new copies untracked. A commit of that staging would drop the eight PRD trees from the branch history while the copies remain on disk outside the index.
- Recommended action: When the owner wants this saved, stage each old path and its new path together so the commit can record the relocation. This audit does not stage or commit it.

### prd-lifecycle-2

- Severity: medium
- Claim: For 071, 072, 073, 074, and 077 the working-tree folder is `completed/` and index line 3 still says Backlog, unchanged from HEAD. For 078 the folder is `in-work/` and line 3 still leads with Backlog; the parenthetical already says the work is in-work and Phase 1 is dispatched. For 019 and 020 the status line already says In Work (reopened 2026-06-22) on HEAD, where the folder is `completed/`, and in the working tree, where the folder is `in-work/`.
- Evidence: VERIFIED. Status lines at line 3 of each working-tree index, compared with `git show HEAD:<old index>`. Folder listing as in the census. REPORTED: `library/requirements/README.md` lines 5 and 16 say lifecycle equals location. REPORTED: `library/requirements/completed/README.md` says shipped folders stay in `completed/` and are read-only after landing.
- Impact: A reader of the status line and a reader of the directory can name two different states for the same PRD. This report records both and assigns neither one the win.
- Recommended action: Before any commit of these folders, the owner picks one signal per PRD (the status line or the directory) and makes the other match. Sample used throughout: PRD-071 index line 3, `Status: Backlog`, while the folder is `library/requirements/completed/prd-071-service-checkin-and-sqlite-telemetry/`.

### prd-lifecycle-3

- Severity: low
- Claim: Four tracked files outside the moved folders retarget links to the new locations: archive 068, 069, and 070 point at `completed/prd-071`, and backlog 081 points at `completed/prd-077`. Those destinations exist as untracked directories.
- Evidence: VERIFIED. `git diff -U1` on the four indexes, one changed line each.
- Impact: The link edits assume the untracked copies stay. Committing the link edits together with only the deletions would point the archive notes and PRD-081 at paths the commit itself removes.
- Recommended action: Keep these four edits in the same commit as the 071 and 077 relocation, if that relocation is kept.

### prd-lifecycle-4

- Severity: medium
- Claim: `library/knowledge/private/architecture/adr/0011-sessions-recall-chunking-strategy.md` line 181 cites `library/requirements/backlog/prd-074-sessions-prose-column/`. That directory is absent. The working-tree folder is `library/requirements/completed/prd-074-sessions-prose-column/`. The ADR file is unmodified, so the citation still matches HEAD and misses the working tree.
- Evidence: VERIFIED. Grep of the ADR, `test -d` on both paths, `git status --short` empty for the ADR.
- Impact: A knowledge true-up that trusts the working tree will find this path wrong. A true-up that trusts HEAD will find it right until the relocation is committed.
- Recommended action: After the owner settles PRD-074's folder, point line 181 at that folder. This lens does not edit the ADR.

### prd-lifecycle-5

- Severity: low
- Claim: Three unmodified ADRs cite `library/requirements/backlog/prd-066-local-queue-idle-cost-control/prd-066-local-queue-idle-cost-control-index.md`. That path is absent. `git ls-files` tracks the folder under `library/requirements/in-work/prd-066-local-queue-idle-cost-control/`. Index line 3 says Backlog. 066 is already in `in-work/` on HEAD and is outside the eight-folder move.
- Evidence: VERIFIED. ADR lines 156, 178, and 120 in `0006`, `0007`, and `0009`. `test -f` backlog path fails. `test -f` in-work path succeeds. Status line 3 of the in-work index.
- Impact: The private docs name a backlog path the tree has vacated. The index status line still says Backlog, so the status word and the folder disagree on a committed PRD as well.
- Recommended action: Point the three ADR lines at `in-work/prd-066-...` if the folder is the location to keep, or move the folder back to `backlog/` if the status line is the location to keep. Owner choice. This lens does not edit them.

### prd-lifecycle-6

- Severity: medium
- Claim: `library/knowledge/private/standards/documentation-framework.md` lines 21-22 and 93-96 place feature PRDs under `library/requirements/features/` and issue IRDs under `library/requirements/issues/`, including `features/completed/` and `issues/completed/`. Neither `features/` nor `issues/` exists. Live PRD folders are `backlog/`, `in-work/`, `completed/`, and `archive/`, named `prd-<###>-<slug>/`. The framework file is unmodified.
- Evidence: VERIFIED. Those line numbers in the framework file. `test -d library/requirements/features` and `test -d library/requirements/issues` both fail. Census above for the live folders. REPORTED: framework line 100 says to move folders when status changes.
- Impact: A reader of the private standards doc will look for a requirements layout this repository does not have. The requirements README is the layout the tree uses, and it also omits `archive/` (see prd-lifecycle-7).
- Recommended action: True-up section 4 of `documentation-framework.md` to `backlog/`, `in-work/`, `completed/`, and `archive/`, with the `prd-<###>-<slug>/` names. This lens does not edit it.

### prd-lifecycle-7

- Severity: low
- Claim: `library/requirements/README.md` documents `backlog/`, `in-work/`, `completed/`, and `reports/`. It does not name `archive/`. `archive/` is a tracked directory with PRDs 067 through 070 and `archive/completed/` (cursor PRDs 002 through 005). `archive/README.md` lines 8-9 describe an `archive/backlog/` child for prd-001 through prd-010. That directory is absent.
- Evidence: VERIFIED. Parent README lines 27-33 have no archive row (`rg archive` on that file is empty). `ls library/requirements/archive` shows `README.md`, `completed`, and prd-067 through prd-070. `test -d library/requirements/archive/backlog` fails. REPORTED: archive README lines 8-9 and 16-19. REPORTED: PRD-067 index line 3 says the work is completed and moved, archived 2026-07-03, with the canonical record in the doctor repo.
- Impact: The parent lifecycle table hides a real fourth state. The archive README describes a backlog child the tree does not contain, so a search for the original scaffolds under `archive/backlog/` fails.
- Recommended action: Add `archive/` to the parent README table using the archive README's own description (067-070 burned, cursor PRDs under `archive/completed/`). Remove or rewrite the `archive/backlog/` sentence so it matches the tree. This lens does not edit either README.

### prd-lifecycle-8

- Severity: low
- Claim: `library/requirements/backlog/README.md` lines 24-47 title a table "Current backlog" and list prd-001 through prd-020. None of those folders is in `backlog/` on HEAD or in the working tree. On HEAD, 001 through 020 are under `completed/`. In the working tree, 019 and 020 are under `in-work/` and 001 through 018 remain under `completed/`. The backlog README is unmodified.
- Evidence: VERIFIED. Table lines 28-47. HEAD `git ls-tree` of `backlog/` and `completed/`. Working-tree listing for 019 and 020.
- Impact: The backlog folder's own index of "current" work describes the early product set that already lives under `completed/` (and, in the working tree, 019 and 020 under `in-work/`). The actual backlog set is the 10 directories in the census.
- Recommended action: Replace that table with the folders that are actually in `backlog/`, or relabel it as the original build plan. This lens does not edit the README.

## Could not verify here

- Doctor, hive, and nectar files at the sibling paths next to this clone. The three 071 index links and the ADR-0008 nectar path are absent at `/home/marioaldayuz/Desktop/development/active/{doctor,hive,nectar}/...`. Another checkout of those repos is UNVERIFIABLE-HERE.
- Author intent for the eight-folder relocation. There is no commit message. The status lines are the only in-file signal sampled.

## Commands run

`git status --short library/requirements | head -200` (55 lines, full result), `git rev-parse --short HEAD`, `git status -sb`, `git ls-tree`, `git ls-files`, `git show HEAD:<path>`, `git diff -U1` and `git diff -M --name-status` on `library/requirements`, `git config --get` for rename settings, `git --version`, directory listings, byte compare of the eight trees, markdown link resolution inside those trees, `rg` for status lines and knowledge citations. No mutating git.

# Knowledge true-up swarm audit, 2026-10-04

The private knowledge base now matches the working tree on ports, the package name, the fleet state root, embeddings and the local queue defaults, the Hive browser origin, MCP transport, and the CLI and daemon import boundary. Sixteen investigator lenses ran. Pairwise refuters for every finding did not. The orchestrator re-read the source lines behind every sentence it changed.

## Every branch, local and remote

Trunk is `main` at `c1cb6bf`, in sync with `origin/main`. VERIFIED. Tag `v0.22.0` matches `package.json` version `0.22.0`. VERIFIED. One worktree, no stashes, no other local branch. VERIFIED.

| Remote head | Ahead of main | Notes |
|---|---|---|
| cla-signatures | 5 (412 behind) | not merged |
| docs/prd-059-to-hive-prd-014 | 0 (8 behind) | investigator reports it is already contained in main (REPORTED) |
| feat/session-recall-cache | 3 | not merged |
| fix/sessions-token-columns-zero-fill | 3 | not merged |

Open pull requests 324, 322, and 318 were open at scout time. VERIFIED via `gh pr list`. Scheduled CI run 37105590110 on main failed on 2026-10-03. VERIFIED via `gh run list`. A count of 81 consecutive failures is REPORTED by the git lens, not re-counted here.

Full inventory: `2026-10-04/reports/01-branches.md`.

## State of the union

The daemon listens on `127.0.0.1:3850` by default. The Hive portal constant is `127.0.0.1:3853`. VERIFIED in `src/shared/constants.ts`. Product state resolves to `~/.apiary/honeycomb`, with legacy `~/.honeycomb` reads. VERIFIED in `src/shared/fleet-root.ts`.

Embeddings default on (`HONEYCOMB_EMBEDDINGS=false` or `0` opts out). VERIFIED in `src/daemon/runtime/services/embed-client.ts`. The local SQLite queue defaults on when topology is undeclared or single-machine. VERIFIED in `src/daemon/runtime/services/local-queue-diagnostics.ts`. The queue file is `~/.apiary/honeycomb/.daemon/local-queue.db`. The CLI passes `--experimental-sqlite` on daemon spawn. VERIFIED in `src/cli/runtime.ts`.

Install-wired harnesses are Claude Code, Codex, and Cursor. Hermes, pi, and OpenClaw exist as source trees and are not connectors. REPORTED by the harness lens, consistent with the registry citations already in `load-bearing-boundaries.md`. MCP production transport is stdio. Daemon `/mcp` and `/v1` are scaffolds that return 501 until a handler is mounted. VERIFIED: `src/daemon/runtime/server.ts`. `assemble.ts` does not call `group("/v1")`. VERIFIED by search.

`node_modules` is absent. `npm run ci` was not run. Test and typecheck results are UNVERIFIABLE-HERE. `go` and `terraform` are absent. Live cloud is UNVERIFIABLE-HERE.

License is AGPL-3.0-or-later. REPORTED by the deps lens from LICENSE and package.json (orchestrator did not re-open LICENSE).

Full write-up: `2026-10-04/reports/02-state-of-the-union.md`.

## Knowledge drift and the edits

87 markdown files live under `library/knowledge/private`. The true-up changed 23 of them. The table of corrections and evidence paths is `2026-10-04/reports/03-knowledge-drift.md`.

Load-bearing facts a reader should now get from those pages:

- Package `@legioncodeinc/honeycomb`, client factory `createHoneycombClient`.
- Ports 3850 (daemon) and 3853 (Hive). The daemon does not serve `src/dashboard/web/main.tsx`. That file is not in the tree.
- Fleet root `~/.apiary`, legacy fallback `~/.honeycomb`.
- Embeddings and the undeclared-topology local queue default on.
- Service label `com.legioncode.honeycomb`. Legacy label `ai.honeycomb.daemon` is removed on upgrade.
- Recall client timeout is 6000 ms. Live recency is `applyRecencyActivation`. Lexical arms are tokenized `ILIKE`, not a wired BM25 index.
- `src/commands` imports daemon runtime modules. `src/daemon-client` imports SQL helpers. The DeepLake transport is constructed in `src/daemon`.

ADRs that narrate the move away from `~/.honeycomb` were not rewritten. They are the decision record. Doctor file paths inside `doctor-watchdog.md` are now labeled as belonging to the doctor repository, which is not in this checkout.

## Next steps

See `2026-10-04/reports/04-next-steps.md`. This audit did not commit, push, or open a pull request. The working tree also holds PRD folder moves that this audit did not make.

## Appendix: verification statistics

| Role | Count | Reviewer |
|---|---|---|
| Investigator lenses | 16, all wrote a file | Orchestrator re-read the lines used in edits |
| Evidence refuters, per finding | not run as a fleet | Coverage cap below |
| Materiality refuters | not run | Coverage cap below |
| Judges | 0 | no splits to judge |
| Interpreters | orchestrator wrote the four report files | this master |
| Critic rounds | 1 orchestrator pass on edited sentences and dash sweep | a second critic agent was not launched |
| Editor | orchestrator | dash sweep and single H1 on this file |

Runtime substitution: no Workflow tool. Fleet was Cursor Task `generalPurpose` agents, model `inherit` (parent model). Sonnet 5 and Opus 5 are not in the available model list. The script `2026-10-04/swarm-audit-workflow.js` was authored from the stinger template and was not executed.

## Appendix: coverage cap

Material findings were not given two refuters each. The investigator wave produced on the order of one hundred findings. Two refuters each would queue well past a single 16-wide wave and past the useful part of this run. The cap is explicit:

- Verified by orchestrator re-read: every sentence changed in `library/knowledge/private` during this audit.
- Not verified pairwise: the rest of each lens file. Those sentences stay investigator observations. Resume by re-dispatching an evidence refuter per finding id in `2026-10-04/lenses/*.md`.

`maxVerify` in `args.json` is null. The cap is a wall-clock and concurrency choice, logged here, not a silent filter inside the script.

## Appendix: unreviewed products

| Product | Producer | Reviewer | Status |
|---|---|---|---|
| lens:git-branches | Task 0544a677 | orchestrator spot-check of branch table | complete for the branch table; CI streak of 81 is REPORTED |
| lens:knowledge-architecture | Task dfa5b798 | orchestrator for edited claims | edited claims reviewed; remainder unreviewed |
| lens:knowledge-ai-data | Task 2832a70c | orchestrator for schema and retrieval edits | remainder unreviewed |
| lens:knowledge-surfaces | Task 3c804961 | orchestrator for SDK, dashboard, sources, API docs | remainder unreviewed |
| lens:daemon-runtime | Task 4fca60d0 | orchestrator for port, /mcp, service label | route-by-route table unreviewed |
| lens:storage-catalog | Task 4b456c7b | orchestrator for sources group and org_id presence | 35-table inventory REPORTED |
| lens:retrieval | Task 4ca4c21b | orchestrator for timeout, nectar path, recency, fast path | benchmark numbers UNVERIFIABLE-HERE |
| lens:harnesses-mcp | Task 0f75a05e | orchestrator for MCP stdio and SDK exports | per-tool behavior unreviewed |
| lens:cli-install | Task f2ab0e05 | not line-checked beyond the verb `sources` | PRODUCED, review incomplete |
| lens:dashboard-code | Task b40bf6f5 | orchestrator for missing main.tsx and extension manifest | remainder unreviewed |
| lens:security-code | Task b62fd2fe | orchestrator for SQL helper imports and secrets path | bind-widen details REPORTED |
| lens:deps-licenses | Task f8b05928 | not re-opened by orchestrator | PRODUCED, review incomplete |
| lens:infra-ci | Task a4474d1b | orchestrator for version script and fleet root | ruleset id REPORTED |
| lens:prd-lifecycle | Task 831a17c9 | matches the scout git status | reviewed against the starting git status |
| lens:auth-tenancy | Task 75405242 | not line-checked | PRODUCED, review incomplete |
| lens:embeddings-queue | Task 11c00369 | orchestrator for embed default and queue default | model name REPORTED |
| report:01 through 04 | orchestrator | this master | complete |
| master | orchestrator | dash sweep | complete |

Resume for an unreviewed lens: re-read `2026-10-04/lenses/<key>.md` and confirm each VERIFIED line against the cited file. Do not re-run the whole investigator.

## Appendix: what this machine did not verify

- `npm run ci`, typecheck, and vitest (`node_modules` absent; npm ci was not run, so lenses would not race an install).
- Live DeepLake, live login, recall quality numbers, and the nightly canary token.
- Doctor repository internals. This repo has no `doctor/` tree.
- Hive portal source. It is not in this repo. Port 3853 is a constant here.
- Terraform and any cloud account. `terraform` is not installed.
- The exact failure log of CI run 37105590110 beyond the `gh run list` status line.

## Appendix: evidence index

Lens files: `library/requirements/reports/knowledge-true-up/2026-10-04/lenses/`.

Scratch copy of the same files: `/tmp/honeycomb-swarm-audit-2026-10-04/`.

Run notes, args, and the unexecuted workflow script are beside the lenses in `2026-10-04/`.

## Appendix: six-field closeout

Status: DONE for the authorized true-up and the master report. PARTIAL for the stinger's full refuter and two-round critic loop. The coverage cap above is the limit that fired. Measured start 2026-10-04T05:22:55Z, measured end 2026-10-04T05:53:13Z, elapsed about 30 minutes.

Delivered: this file, the four section reports, 16 lens files, and the knowledge edits listed in the drift report.

Verified: orchestrator re-reads cited in the drift table, dash sweep on edited knowledge files and on this report, single H1 on this file.

Not done: two refuters per material finding, two critic rounds, `npm run ci`, commit, push, pull request.

Questions for the owner: none required to keep the files. If a commit is wanted, say so. Recommended answer: review the diff first.

Out of scope, noticed only: scheduled CI on main is red; PRD folders are mid-move in the working tree; AGENTS.md still calls embeddings opt-in, and this audit was not allowed to edit AGENTS.md.

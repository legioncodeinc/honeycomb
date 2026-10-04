# Architecture ADR standing

Shard: `library/knowledge/private/architecture/adr/` (Wave 1a, this directory only).
Branch: `legion/kb-sotu-and-prd-lifecycle`. Date: 2026-10-04.
Scope: every file in that directory, including `README.md`. No ADR body was edited. No commit.

Next free number is 0012. This report does not reserve it and does not write an ADR.
ADR-0009 already records the local-queue default. Do not add a second ADR for that.

Verdicts: `HOLDS`, `STALE`, `FALSE`, `HOLE`.
Actions: `REVISE` (status line only, plus the README status cell so the index row matches), `LEAVE`, `ADD` (candidate, not written).
ASCII hyphens only.

## Coverage

| ID | Verdict | Action | Status line | Decision vs code | Supersession | README row |
|---|---|---|---|---|---|---|
| README | STALE | REVISE | Convention at `README.md:11-12` | Index only | n/a | Rows 21-25 and 29 copy status words that the banners already contradict |
| 0001 | HOLDS | LEAVE | Accepted (keep RRF), 2026-06-24 | Matches | none / none, no pair | Row 20 matches status and date. Title drops the word "DeepLake's". Not a status defect |
| 0002 | STALE | REVISE | Proposed, and "Superseded by: queen ADR-0002" | Not in this repo; relocation matches that absence | One-way | Row 21 says Proposed |
| 0003 | STALE | REVISE | Proposed, and "Superseded by: queen ADR-0003" | Not in this repo | One-way | Row 22 says Proposed |
| 0004 | STALE | REVISE | Proposed, and "Superseded by: queen ADR-0004" | Not in this repo. Queen later moved the runtime topology | One-way, and the queen chain continues to queen ADR-0010 | Row 23 says Proposed |
| 0005 | STALE | REVISE | Proposed, and "Superseded by: queen ADR-0005" | Not in this repo | One-way | Row 24 says Proposed |
| 0006 | STALE | REVISE | Proposed, evolved by ADR-0009, not superseded | Local queue is in the tree; 0009 made it the default | Evolution pair with 0009 is bidirectional. Formal supersession is intentionally absent on both sides | Row 25 says Proposed and omits the evolution |
| 0007 | HOLDS | LEAVE | Accepted, 2026-06-30 | Matches | none / none | Row 26 matches status, date, and title |
| 0008 | HOLDS | LEAVE | Accepted (superproject ADR-0003), 2026-07-04 | Matches honeycomb `resolveFleetRoot` | Mirror, not a supersession. Back-link from the superproject file is absent | Row 27 matches status and date. Title is a paraphrase that records the mirror |
| 0009 | HOLDS | LEAVE | Accepted, 2026-07-05 | Matches | Evolves 0006; 0006 points back. Not a supersession | Row 28 matches status, date, and title |
| 0010 | FALSE | REVISE | Accepted, 2026-07-08 | Corpus-length proxy is still the KPI | Supersedes a PRD metric, not an ADR. PRD-035b does not name ADR-0010 | Row 29 matches the file's Accepted status. Both contradict the code |
| 0011 | STALE | LEAVE | Proposed, 2026-07-05 | No chunker dependency, and `chunker.ts` is absent, which matches Proposed | none / none | Row 30 matches status, date, and title |
| HOLE local ANN | HOLE | ADD | none | In-daemon flat cosine index is the default memories semantic arm | n/a | No index row |

README row numbers: `README.md:20` through `README.md:30`. There is no 0012 file.

## README

`README.md:11-12` says status moves Proposed, then Accepted, then `Superseded by ADR-XXXX`, and that a superseded ADR's substance stays. Rows for 0002-0006 still say Proposed (`README.md:21-25`). The files' banners already say relocated or evolved. Row 29 says 0010 is Accepted (`README.md:29`) while the retirement is not in the tree.

When a status line below is revised, change that row's Status cell to the same words. Leave titles and dates unless a status revision forces the row to match.

## ADR-0001 Retrieval fusion

Verdict HOLDS. Action LEAVE.

Status: `0001-retrieval-fusion-rrf-vs-native-hybrid.md:3-4`. Accepted (keep RRF). Supersedes none. Superseded by none.

Decision: keep post-query RRF. Do not mount `deeplake_hybrid_record`. Keep `hybrid-recall.ts` and `npm run bench:hybrid` as the unwired reference (`0001-retrieval-fusion-rrf-vs-native-hybrid.md:70-73`).

Code:

- `RRF_K = 60` at `src/daemon/runtime/memories/recall.ts:238`. `fuseHits` at `src/daemon/runtime/memories/recall.ts:757`. Production fusion calls it at `src/daemon/runtime/memories/recall.ts:2843` and `src/daemon/runtime/memories/recall.ts:3275`.
- Per-arm queries, not one `UNION ALL`, are still the comment at `src/daemon/runtime/memories/recall.ts:24-36`. Lexical-only `degraded: true` is still described at `src/daemon/runtime/memories/recall.ts:43-46`.
- The live sessions arm says the native operator stays out of scope at `src/daemon/runtime/memories/recall.ts:647-648`.
- `hybridRecall` is defined at `src/daemon/runtime/memories/hybrid-recall.ts:241`. No production module calls it. Callers are the unit test and `tests/integration/hybrid-benchmark-live.itest.ts`.
- `package.json:70` still has `"bench:hybrid": "node scripts/bench-hybrid.mjs"`. `scripts/bench-hybrid.mjs` exists.

README: `README.md:20` status Accepted, date 2026-06-24. Title omits "DeepLake's" from the H1. Status and date match.

Cited paths that exist: `library/requirements/completed/prd-047-retrieval-quality-upgrades/prd-047a-native-hybrid-benchmark.md`, `library/requirements/completed/prd-047-retrieval-quality-upgrades/reports/2026-06-22-hybrid-benchmark-decision.md`, `library/knowledge/private/ai/deeplake-hybrid-record-operator-report.md`.

## ADR-0002 Orchestrator-custodian

Verdict STALE. Action REVISE.

Status line today: `0002-orchestrator-custodian-for-fleet-memory-plane.md:5-6` says `Proposed (exploratory)` and `Superseded by: queen ADR-0002 (relocated)`. The banner at `0002-orchestrator-custodian-for-fleet-memory-plane.md:3` says SUPERSEDED on 2026-07-03 and tells readers not to update the body.

Replace the status line with: `Superseded by queen ADR-0002 (relocated 2026-07-03)`. Leave the body. Set `README.md:21` Status to those same words.

Code: honeycomb `src/` has no enroll-token command, no Cloudflare Workers control plane, and no Hyperdrive client. That absence matches a relocated decision. It does not match a still-Proposed honeycomb design.

Supersession is not bidirectional.

- Honeycomb names queen ADR-0002. The relative link at `0002-orchestrator-custodian-for-fleet-memory-plane.md:211` is `../../../../../queen/...`. From `library/knowledge/private/architecture/adr/` that resolves to `/home/marioaldayuz/Desktop/development/active/honeycomb/queen/library/knowledge/private/architecture/ADR-0002-orchestrator-custodian-for-fleet-memory-plane.md`, which is absent.
- The sibling file exists at `/home/marioaldayuz/Desktop/development/active/queen/library/knowledge/private/architecture/ADR-0002-orchestrator-custodian-for-fleet-memory-plane.md`. Reaching that sibling from this ADR directory takes six `..` segments, not five.
- Queen `ADR-0002-orchestrator-custodian-for-fleet-memory-plane.md:3-6` says copied from honeycomb, Status Proposed, `Superseded by: none`. It does not point back at honeycomb `adr/0002-orchestrator-custodian-for-fleet-memory-plane.md`.

In-repo links that do exist: PRD-062 index under `library/requirements/completed/prd-062-deeplake-compute-cost-reduction/`, and the three security pages plus `library/knowledge/private/collaboration/fleet-observation-and-on-demand-skills.md`.

## ADR-0003 Trusted device custody

Verdict STALE. Action REVISE.

Status line today: `0003-trusted-device-custody-and-headless-enrollment.md:5-6` says Proposed and `Superseded by: queen ADR-0003 (relocated)`. Banner at line 3 says SUPERSEDED 2026-07-03, do not update.

Replace the status line with: `Superseded by queen ADR-0003 (relocated 2026-07-03)`. Leave the body. Set `README.md:22` Status to those same words.

Code: the headless commands in `0003-trusted-device-custody-and-headless-enrollment.md:156-162` (`honeycomb devices enroll-token create`, `honeycomb enroll --token`) are not in `src/`.

Supersession is not bidirectional. Queen `ADR-0003-trusted-device-custody-and-headless-enrollment.md:3-6` is Status Proposed, `Superseded by: none`, provenance "Copied from honeycomb", no link back to this file. The same five-up `queen/` link at `0003-trusted-device-custody-and-headless-enrollment.md:278` resolves inside this repo and is absent. The sibling queen file is present.

Do not confuse this file with the fleet-root decision. Honeycomb code comments say "ADR-0003" for `~/.apiary` (`src/shared/fleet-root.ts:3-10`, `src/daemon/runtime/assemble.ts:884`). That number is the superproject fleet-root ADR, mirrored here as ADR-0008. This file is the relocated custody ADR.

## ADR-0004 Control plane and Postgres boundary

Verdict STALE. Action REVISE.

Status line today: `0004-honeycomb-control-plane-and-postgres-boundary.md:5-6` says Proposed and `Superseded by: queen ADR-0004 (relocated)`. Banner at line 3 says SUPERSEDED 2026-07-03.

The queen copy is no longer the end of the topology chain. Queen `ADR-0004-honeycomb-control-plane-and-postgres-boundary.md:5-6` says `Superseded by ADR-0010 (runtime-topology decision only)`. Queen `ADR-0010-cloud-infrastructure-and-ingestion.md:3-4` says Status Accepted and `Supersedes: ADR-0004 (runtime-topology decision only)`. Queen ADR-0010:9-13 records that the Workers-as-API, no-Droplet, no-Valkey choice was later replaced because the high-frequency workload now exists.

Replace the honeycomb status line with: `Superseded by queen ADR-0004 (relocated 2026-07-03); queen runtime topology later superseded by queen ADR-0010`. Leave the body. Set `README.md:23` Status to those same words.

Code: this repo does not implement Workers, Hyperdrive, Queues, or Durable Objects. That matches relocation. It also means honeycomb ADR-0004 is not the live topology.

Supersession is not bidirectional back to this file. Queen ADR-0004 and queen ADR-0010 point at each other inside queen. They do not cite honeycomb `adr/0004-honeycomb-control-plane-and-postgres-boundary.md`. The five-up relative link at `0004-honeycomb-control-plane-and-postgres-boundary.md:309` does not resolve.

## ADR-0005 Recovery, revocation, and escrow

Verdict STALE. Action REVISE.

Status line today: `0005-recovery-revocation-and-escrow-policy.md:5-6` says Proposed and `Superseded by: queen ADR-0005 (relocated)`. Banner at line 3 says SUPERSEDED 2026-07-03.

Replace the status line with: `Superseded by queen ADR-0005 (relocated 2026-07-03)`. Leave the body. Set `README.md:24` Status to those same words.

Code: no escrow or device-revocation control plane in `src/`. Matches relocation.

Supersession is not bidirectional. Queen `ADR-0005-recovery-revocation-and-escrow-policy.md:3-6` is Status Proposed, `Superseded by: none`. The five-up relative link does not resolve. The sibling queen file exists.

## ADR-0006 Local queue as interim idle-cost control

Verdict STALE. Action REVISE.

Status line today: `0006-local-queue-as-interim-idle-cost-control.md:5-6` says `Proposed (exploratory)` and `Superseded by: none (evolved by ADR-0009)`. The banner at lines 3-4 says evolved by ADR-0009 on 2026-07-05, and that the idle-cost invariants still hold.

The local queue is in the tree, so Proposed is the wrong status word. It is not superseded. ADR-0009:4 says `Supersedes: none (evolves ADR-0006)`. That pair is bidirectional for the evolution relationship.

Replace the status line with: `Accepted (evolved by ADR-0009)`. Leave the body, including the "not superseded" clause. Set `README.md:25` Status to those same words.

Code that still matches the idle-cost invariant:

- Queue file is `node:sqlite` under `.daemon/local-queue.db` (`src/daemon/runtime/services/local-job-queue.ts:4-6`, constants at lines 22-23). Base dir is the fleet state root (`src/daemon/runtime/assemble.ts:3175-3179`).
- With the local queue enabled and shared drain off, the recurring `SELECT 1` probe stays off (`src/daemon/runtime/assemble.ts:3174`, gate at `src/daemon/runtime/assemble.ts:4091-4096`).
- Secret-like payload keys are rejected (`src/daemon/runtime/services/local-job-queue.ts:665-667`).

Link defect, body text, not fixed by a status-line edit: `0006-local-queue-as-interim-idle-cost-control.md:156` points at `library/requirements/backlog/prd-066-local-queue-idle-cost-control/prd-066-local-queue-idle-cost-control-index.md`. That path is absent. The index is at `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066-local-queue-idle-cost-control-index.md`. PRD-062 and PRD-043a links in the same section exist.

## ADR-0007 Daemon readiness

Verdict HOLDS. Action LEAVE.

Status: `0007-daemon-readiness-over-boot-time-deeplake-and-graph-work.md:3-4`. Accepted, 2026-06-30. Supersedes none. Superseded by none. README row 26 matches.

Decision (`0007-daemon-readiness-over-boot-time-deeplake-and-graph-work.md:72-103`): listener plus `/health` is readiness. Graph auto-build, the first storage probe, and queue-table warmup do not gate the bind. macOS stop uses `launchctl bootout`.

Code:

- Graph auto-build is on only when `HONEYCOMB_CODEBASE_GRAPH_AUTO_BUILD` parses true (`src/daemon/runtime/assemble.ts:323-344`). Boot comment at `src/daemon/runtime/assemble.ts:3934-3942`. The build is fire-and-forget inside `start()` (`src/daemon/runtime/assemble.ts:4098-4104`).
- Production does not await the first storage probe (`src/daemon/runtime/assemble.ts:4086-4096`). `awaitInitialHealthProbe` defaults to true only when storage is injected (`src/daemon/runtime/assemble.ts:4066`).
- Shared queue `start()` arms the reaper and warms the table in the background (`src/daemon/runtime/services/job-queue.ts:937-947`).
- `runAssembledDaemon` starts lifecycle, then binds (`src/daemon/index.ts:156-164`). `startDaemon` binds after `startServices()` returns (`src/daemon/runtime/listen.ts:34-35`). Those services do not wait for graph build, the probe, or queue bootstrap.
- macOS `stop` runs `launchctl bootout` (`src/cli/daemon-service.ts:809-812`). `KeepAlive` remains in the plist (`src/cli/daemon-service.ts:414`).

Same PRD-066 backlog path defect as 0006, at `0007-daemon-readiness-over-boot-time-deeplake-and-graph-work.md:178`. Status line stays. A link retarget is body text.

## ADR-0008 Fleet directory and neutral state root

Verdict HOLDS. Action LEAVE.

Status: `0008-fleet-directory-ownership-and-neutral-state-root.md:3-5`. Mirror of superproject ADR-0003. Accepted, 2026-07-04. README row 27 matches status and date. The index title is a shorter paraphrase and already says "mirror of superproject ADR-0003".

Decision: default root `<home>/.apiary`, `APIARY_HOME` only when absolute, Linux `XDG_STATE_HOME` only when set and absolute, no `~/.local/state/apiary` default (`0008-fleet-directory-ownership-and-neutral-state-root.md:12-28`). Registry write goes to `registry.json` when the fleet root directory exists, else the legacy file (`0008-fleet-directory-ownership-and-neutral-state-root.md:35-36`).

Code:

- Chain at `src/shared/fleet-root.ts:78-95`. Absolute check uses `win32.isAbsolute` at `src/shared/fleet-root.ts:68-69`.
- Per-product dir is `resolveFleetRoot() + "/" + PRODUCT_SLUG` at `src/shared/fleet-root.ts:103-104`.
- Registry write target at `src/daemon/runtime/telemetry/fleet-registry.ts:74-79`.
- Runtime dir is `honeycombStateDir()` at `src/daemon/runtime/assemble.ts:883-889`.

A stale comment remains at `src/daemon/runtime/assemble.ts:311-314` and still describes `~/.honeycomb` as the runtime dir. The resolver below it implements this ADR. That comment does not overturn the decision.

Mirror link is one-way. This file names the superproject path in prose (`0008-fleet-directory-ownership-and-neutral-state-root.md:3`). That path is not inside this repo. The authoritative file is `/home/marioaldayuz/Desktop/development/active/the-apiary/library/knowledge/private/architecture/ADR-0003-fleet-directory-ownership-and-neutral-state-root.md` (status Accepted at its lines 3-4). That file does not cite honeycomb `0008-fleet-directory-ownership-and-neutral-state-root.md`. This is a mirror, not a supersession. The banner says edit the superproject copy. Action stays LEAVE.

## ADR-0009 Local queue as the default

Verdict HOLDS. Action LEAVE.

Status: `0009-local-queue-as-default-deeplake-is-not-a-queue.md:3-4`. Accepted, 2026-07-05. Evolves ADR-0006. Superseded by none. README row 28 matches.

Do not add another ADR for this decision.

Decision points and code:

1. Default local queue for the ten pipeline kinds. `DEFAULT_LOCAL_JOB_KINDS` at `src/daemon/runtime/services/hybrid-job-queue.ts:15-26` lists the same ten kinds named at `0009-local-queue-as-default-deeplake-is-not-a-queue.md:46-48`.
2. DeepLake is the memory store. Controlled writes target table `memories` at `src/daemon/runtime/pipeline/controlled-writes.ts:171-173`. The local queue module says it never calls the DeepLake client (`src/daemon/runtime/services/local-job-queue.ts:4-6`).
3. Unknown and `single_machine` are eligible for default-on. `fleet` and `multi_device` stay shared unless opted in (`src/daemon/runtime/services/local-queue-diagnostics.ts:80-122`).
4. An explicit `HONEYCOMB_LOCAL_QUEUE_ENABLED` wins, including `false` as rollback (`src/daemon/runtime/services/hybrid-job-queue.ts:46-59`). A second flag, `HONEYCOMB_LOCAL_QUEUE_EXPLICIT_OPT_IN`, also forces eligibility (`src/daemon/runtime/services/local-queue-diagnostics.ts:81-90`). The ADR names the first flag as the override. The second flag is an extra opt-in, not a reversal.
5. Shared-path guard: stderr warning, event `queue.shared_pipeline_path_active`, and `memoryQueue: "shared"` (`src/daemon/runtime/assemble.ts:3195-3206` and `src/daemon/runtime/assemble.ts:3473`). Health field at `src/daemon/runtime/health.ts:315`. `memoryFormation` is surfaced at `src/daemon/runtime/assemble.ts:3463` and typed at `src/daemon/runtime/health.ts:306`.
6. Local-queue mode turns the recurring `SELECT 1` probe off (`src/daemon/runtime/assemble.ts:3174`), matching the accepted consequence at `0009-local-queue-as-default-deeplake-is-not-a-queue.md:87-90`.

Lease shape, precision only, decision still holds. The ADR says lease uses `UPDATE ... WHERE status=? AND attempts=?` inside `BEGIN IMMEDIATE` (`0009-local-queue-as-default-deeplake-is-not-a-queue.md:48-49`). `lease()` does `BEGIN IMMEDIATE` then `UPDATE ... WHERE id = ?` (`src/daemon/runtime/services/local-job-queue.ts:430-443`). The `status` and `attempts` predicate is on `complete` and `fail` (`src/daemon/runtime/services/local-job-queue.ts:461-462` and `src/daemon/runtime/services/local-job-queue.ts:488-489`), and those two methods do not open `BEGIN IMMEDIATE`. Single-winner still comes from the SQLite write lock on lease. Not a reason to revise the status line.

Same missing backlog PRD-066 path at `0009-local-queue-as-default-deeplake-is-not-a-queue.md:120`. Status line stays.

## ADR-0010 Recall-weighted Est. savings

Verdict FALSE. Action REVISE.

Status line today: `0010-recall-weighted-est-savings.md:3-4`. Accepted, 2026-07-08. Supersedes the PRD-035b metric definition, not a prior ADR. Superseded by none. README row 29 matches that Accepted word. `prd-035b-dashboard-data-fixes-est-savings-metric.md` does not mention ADR-0010, so that supersession is one-way. There is no second ADR to link.

The accepted decision says the corpus proxy is retired and `fetchEstimatedSavings` / `buildEstimatedSavingsSql` are removed (`0010-recall-weighted-est-savings.md:53-67`). The code still computes that proxy:

- `CHARS_PER_TOKEN = 4` and the PRD-035b comment at `src/daemon/runtime/dashboard/api.ts:234-248`.
- `fetchEstimatedSavings` at `src/daemon/runtime/dashboard/api.ts:313-320` returns `Math.floor(chars / CHARS_PER_TOKEN)`.
- `buildEstimatedSavingsSql` at `src/daemon/runtime/dashboard/api.ts:347-352` is `SELECT SUM(LENGTH(content)) AS chars FROM memories`.
- `KpisView.estimatedSavings` is documented as the corpus-mass proxy at `src/dashboard/contracts.ts:57-64`. The dashboard string is `Estimated savings: ${view.estimatedSavings}` at `src/dashboard/views.ts:64`.
- A separate measured meter exists: `fetchInjectedTokens` at `src/daemon/runtime/dashboard/api.ts:331-337` and `injectedTokens` at `src/dashboard/contracts.ts:65-72`. That is not the recall-weighted savings tile the ADR requires, and it does not remove the proxy.
- The `/roi` measured-vs-modeled split does exist, which matches the ADR's claim that `/roi` was already honest: `measuredCents` / `modeledCents` at `src/daemon/runtime/dashboard/api.ts:1030-1033` and `RoiSavingsSection` at `src/dashboard/contracts.ts:480-486`. The KPI band was not re-pointed at that source.

`Accepted` means the retirement is the live contract. It is not. Replace the status line with: `Proposed`. Leave the body (this shard does not rewrite an accepted decision's substance). Set `README.md:29` Status to `Proposed`.

Do not ADD a second savings ADR. ADR-0010 is the record. Implementing it, or superseding it after a new measurement, is later work.

Cited paths that exist: IRD-278 index, PRD-035b, PRD-060 index, PRD-060b.

## ADR-0011 Sessions recall chunking

Verdict STALE. Action LEAVE.

Status: `0011-sessions-recall-chunking-strategy.md:3-4`. Proposed, 2026-07-05. Supersedes none. Superseded by none. README row 30 matches. Proposed is still the right status word: `src/daemon/runtime/capture/chunker.ts` is absent, and `package.json` dependencies do not include LangChain or another chunker package (`package.json:126-135`).

The decision "do not pull a chunker dependency" matches the tree. These supporting claims do not:

- The ADR says Honeycomb has 8 runtime dependencies (`0011-sessions-recall-chunking-strategy.md:20` and line 159). `package.json:127-135` lists 9: `@hono/node-server`, `@legioncodeinc/cli-kit`, `@modelcontextprotocol/sdk`, `@noble/ciphers`, `hono`, `tree-sitter-wasms`, `web-tree-sitter`, `yaml`, `zod`.
- The ADR assigns PRD-075 to read-time window-on-match and PRD-076 to capture-time `chunkEvent` (`0011-sessions-recall-chunking-strategy.md:11-14` and lines 142-148). Those numbers are already completed work of a different kind: `library/requirements/completed/prd-075-on-demand-recall-command-surface/` and `library/requirements/completed/prd-076-always-on-recall-and-plugin-packaging/`.
- Prose is still a head cap, which matches the problem statement. `proseForToolCall` slices from the start at `src/daemon/runtime/capture/event-contract.ts:265-269`, cap 500 at line 227, `truncate` at lines 370-373. There is no `matchRange` field.
- Grounding that still matches: `chunkText` at `src/daemon/runtime/sources/document-worker.ts:202-211` (the ADR's pasted function is this one). `chunksFor` metadata at `src/daemon/runtime/sources/providers/obsidian.ts:393-413`. `DOCUMENT_CHUNK_COLUMNS` comment starts at `src/daemon/storage/catalog/sources.ts:201` and the column list is lines 221-238. `src/daemon/runtime/codebase/extract.ts` exists.
- `embeddings/src/index.ts:187` is `transformers.pipeline("feature-extraction", MODEL_ID, ...)`. It does not show an 8192-token truncation. The word "truncates" in that file is for error text (`embeddings/src/index.ts:232`), not model input.
- Link at `0011-sessions-recall-chunking-strategy.md:181` points at `library/requirements/backlog/prd-074-sessions-prose-column/`. That path is absent. The index is `library/requirements/completed/prd-074-sessions-prose-column/prd-074-sessions-prose-column-index.md`.

A status-line edit would not fix the reused PRD numbers or the dependency count. Leave the status as Proposed. Do not ADD a second chunker ADR. The decision is already this file. A later author who is allowed to touch body text can retarget the PRD numbers. This shard's action stays LEAVE.

## HOLE

### In-daemon local ANN index

Verdict HOLE. Action ADD. Candidate only. Do not number it here. Next free number is 0012, and this report does not claim that number.

Why it is load-bearing: Deep Lake has no vector-index primitive, so the memories semantic arm of fast recall is an in-RAM flat cosine index, default on, with the `<#>` SQL scan as the cold fallback. Deleting the module header would drop that reason. ADR-0001 still holds beside it: hits still go through `fuseHits`. This is not a second local-queue ADR.

Evidence:

- Why, including the measured full-scan cost and the "Deep Lake stays the store" boundary: `src/daemon/runtime/memories/local-vector-index.ts:1-17`.
- Default on: `DEFAULT_LOCAL_ANN_INDEX = true` at `src/daemon/runtime/memories/amplification-config.ts:42-48`.
- Wired at boot, cold-build not awaited: `src/daemon/runtime/assemble.ts:3136-3157`.
- Fast path uses the index or falls back to `<#>`: `src/daemon/runtime/memories/recall.ts:3000-3029`. Fusion stays `fuseHits` (`src/daemon/runtime/memories/recall.ts:3008-3009`).

## Considered and not ADD

- Embeddings default-on. `resolveEmbedClientOptions` treats unset as enabled (`src/daemon/runtime/services/embed-client.ts:160-172`). The reason is already PRD-025 D-1 at `library/requirements/completed/prd-025-semantic-recall-default/prd-025-semantic-recall-default-index.md:54-56`. Do not add an ADR that repeats it.
- Local queue as the default. Already ADR-0009. Do not add a duplicate.

## Defect register

Count: 12 defects in the current ADR files, plus 1 HOLE (not a defect in an existing file).

1. `0002` status line and `README.md:21` still say Proposed while the banner says relocated (`0002-orchestrator-custodian-for-fleet-memory-plane.md:3-6`).
2. `0002` supersession is one-way. Queen ADR-0002:6 says `Superseded by: none`. The honeycomb relative link resolves to a missing in-repo `queen/` path.
3. `0003` status line and `README.md:22` still say Proposed (`0003-trusted-device-custody-and-headless-enrollment.md:3-6`).
4. `0003` supersession is one-way. Queen ADR-0003:6 says `Superseded by: none`. Same broken relative link.
5. `0004` status line and `README.md:23` still say Proposed, and they stop at queen ADR-0004. Queen ADR-0004:5-6 and queen ADR-0010:3-4 continue the chain for runtime topology.
6. `0004` supersession is one-way back to this file. Queen links queen ADR-0004 with queen ADR-0010, not with honeycomb `adr/0004-honeycomb-control-plane-and-postgres-boundary.md`.
7. `0005` status line and `README.md:24` still say Proposed (`0005-recovery-revocation-and-escrow-policy.md:3-6`).
8. `0005` supersession is one-way. Queen ADR-0005:6 says `Superseded by: none`. Same broken relative link.
9. `0006` status line and `README.md:25` still say Proposed after the queue shipped and ADR-0009 evolved it (`0006-local-queue-as-interim-idle-cost-control.md:3-6`, `0009-local-queue-as-default-deeplake-is-not-a-queue.md:4`).
10. PRD-066 backlog path is absent. Cited at `0006-local-queue-as-interim-idle-cost-control.md:156`, `0007-daemon-readiness-over-boot-time-deeplake-and-graph-work.md:178`, and `0009-local-queue-as-default-deeplake-is-not-a-queue.md:120`. Live path: `library/requirements/in-work/prd-066-local-queue-idle-cost-control/prd-066-local-queue-idle-cost-control-index.md`. Status-line-only edits do not retarget these links. 0007 and 0009 stay LEAVE.
11. ADR-0010 says the corpus-length proxy is removed (`0010-recall-weighted-est-savings.md:65-67`). `fetchEstimatedSavings` and `buildEstimatedSavingsSql` are live at `src/daemon/runtime/dashboard/api.ts:313-352`. README row 29 says Accepted.
12. ADR-0011 supporting claims are stale: 8 runtime deps vs 9 at `package.json:127-135`; PRD-075 and PRD-076 identities vs the completed folders named above; PRD-074 backlog path at `0011-sessions-recall-chunking-strategy.md:181` is absent; `embeddings/src/index.ts:187` is the pipeline constructor, not a truncation site. Status Proposed still matches an unbuilt chunker, so the action is LEAVE.

## Files read

Plan: `/home/marioaldayuz/.cursor/plans/kb_prd_standing_fleet_9354246d.plan.md` (Wave 1a and the ADR rules in Wave 3).

ADR directory, every file:

- `library/knowledge/private/architecture/adr/README.md`
- `library/knowledge/private/architecture/adr/0001-retrieval-fusion-rrf-vs-native-hybrid.md`
- `library/knowledge/private/architecture/adr/0002-orchestrator-custodian-for-fleet-memory-plane.md`
- `library/knowledge/private/architecture/adr/0003-trusted-device-custody-and-headless-enrollment.md`
- `library/knowledge/private/architecture/adr/0004-honeycomb-control-plane-and-postgres-boundary.md`
- `library/knowledge/private/architecture/adr/0005-recovery-revocation-and-escrow-policy.md`
- `library/knowledge/private/architecture/adr/0006-local-queue-as-interim-idle-cost-control.md`
- `library/knowledge/private/architecture/adr/0007-daemon-readiness-over-boot-time-deeplake-and-graph-work.md`
- `library/knowledge/private/architecture/adr/0008-fleet-directory-ownership-and-neutral-state-root.md`
- `library/knowledge/private/architecture/adr/0009-local-queue-as-default-deeplake-is-not-a-queue.md`
- `library/knowledge/private/architecture/adr/0010-recall-weighted-est-savings.md`
- `library/knowledge/private/architecture/adr/0011-sessions-recall-chunking-strategy.md`

Code and package (cited regions, not build output, not `node_modules`):

- `src/daemon/runtime/memories/recall.ts`
- `src/daemon/runtime/memories/hybrid-recall.ts`
- `src/daemon/runtime/memories/local-vector-index.ts`
- `src/daemon/runtime/memories/amplification-config.ts`
- `src/daemon/runtime/services/hybrid-job-queue.ts`
- `src/daemon/runtime/services/local-queue-diagnostics.ts`
- `src/daemon/runtime/services/local-job-queue.ts`
- `src/daemon/runtime/services/job-queue.ts`
- `src/daemon/runtime/services/embed-client.ts`
- `src/daemon/runtime/assemble.ts`
- `src/daemon/runtime/listen.ts`
- `src/daemon/runtime/health.ts`
- `src/daemon/runtime/dashboard/api.ts`
- `src/daemon/runtime/pipeline/controlled-writes.ts`
- `src/daemon/runtime/telemetry/fleet-registry.ts`
- `src/daemon/runtime/sources/document-worker.ts`
- `src/daemon/runtime/sources/providers/obsidian.ts`
- `src/daemon/runtime/capture/event-contract.ts`
- `src/daemon/storage/catalog/sources.ts`
- `src/daemon/index.ts`
- `src/shared/fleet-root.ts`
- `src/cli/daemon-service.ts`
- `src/dashboard/contracts.ts`
- `src/dashboard/views.ts`
- `embeddings/src/index.ts`
- `package.json`
- `scripts/bench-hybrid.mjs` (presence)
- `library/requirements/completed/prd-025-semantic-recall-default/prd-025-semantic-recall-default-index.md` (D-1 only)

Outside this repo, status headers only, to test supersession and the mirror:

- `queen/library/knowledge/private/architecture/ADR-0002-orchestrator-custodian-for-fleet-memory-plane.md`
- `queen/library/knowledge/private/architecture/ADR-0003-trusted-device-custody-and-headless-enrollment.md`
- `queen/library/knowledge/private/architecture/ADR-0004-honeycomb-control-plane-and-postgres-boundary.md`
- `queen/library/knowledge/private/architecture/ADR-0005-recovery-revocation-and-escrow-policy.md`
- `queen/library/knowledge/private/architecture/ADR-0010-cloud-infrastructure-and-ingestion.md`
- `the-apiary/library/knowledge/private/architecture/ADR-0003-fleet-directory-ownership-and-neutral-state-root.md`

Path existence checks also covered the PRD, IRD, and knowledge links named in the ADR link sections. Build outputs and `node_modules` were not read.

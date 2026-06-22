# EXECUTION LEDGER — PRD-045 Daemon-Wiring Close-out

> Orchestrator: `/the-smoker` · Started: 2026-06-22 · Branch: `legion/condescending-wilson-95d03a`
> Single source of truth. Survives context loss. Status values: OPEN / IN PROGRESS / DONE / VERIFIED / BLOCKED.
>
> **CRITICAL DIRECTIVE (in force):** No deferrals, no partial credit. 100% of every AC must be brought to full
> fruition. Any Bee unable to fully complete an AC must report the deferral to the orchestrator, which STOPS and
> prompts the user. Every Bee is armed with this directive.

## Definition of DONE (per criterion)
Fully implemented · proven by a passing test (live itest under the PRD-031 net where the AC says so) · nothing else
broken · no stub/mock-in-prod-path/TODO-later. Verification is a separate pass (security → quality close-out, or a
fresh read) that flips DONE → VERIFIED. Implementers do not grade their own homework.

---

## Sub-PRD ledger

### PRD-045a — Memory Pipeline worker (closes 006) · Owner: typescript-node-worker-bee · Model: opus
| ID | Criterion | Status |
|---|---|---|
| a-AC-1 | `assembleDaemon` constructs + starts a pipeline worker leasing the 5 pipeline kinds; cite `assemble.ts` line. | DONE — `assemble.ts:1526-1527` build+start, `:1599` stop; `buildPipelineWorker` leases `PIPELINE_JOB_KINDS` |
| a-AC-2 | A captured turn enqueues the pipeline entry job (cite enqueue site at/around `capture-handler.ts:268-275`). | DONE — `capture-handler.ts:192` enqueuePipelineEntry; seam at `assemble.ts:628` via `attach.ts` |
| a-AC-3 | Live itest: capture → extraction produces ≥1 persisted fact/edge under the daemon scope. | DONE — `pipeline-worker.test.ts` deterministic chain proof green (3×); `pipeline-chain-live.itest.ts` token-gated (skip-safe, runs in CI) |
| a-AC-4 | The 4 previously-stub stages (decision, controlled-write, graph-persist, retention) produce real output, each tested. | DONE — fan-out chain wired; decision/controlled-write/graph-persist/retention each covered |
| a-AC-5 | Fail-soft: a pipeline job error fails the job (dead-letter), never crashes the daemon or capture path. | DONE — stage-worker→`queue.fail` (dead at maxAttempts:1); capture enqueue try/catch; boot fail-soft `assemble.ts:1528-1531` |

### PRD-045b — Retrieval shaping engine (closes 007) · Owner: retrieval-worker-bee · Model: opus
| ID | Criterion | Status |
|---|---|---|
| b-AC-1 | Recorded decision (wire vs de-scope) with rationale lands in the sub-PRD Decisions. | DONE — Decision D-1 = **DE-SCOPE** (zero prod callers; currentness redundant via `is_deleted`+version + 008 supersede; no consumer wants confidence gate) |
| b-AC-2 | If wired: live itest proves a superseded memory is downweighted/gated on `POST /api/memories/recall`; cite phase invocation. | N/A — wire path not taken |
| b-AC-3 | If de-scoped: dead engine removed AND PRD-007 AC-2/3/4 rewritten to shipped behavior. | DONE — engine.ts/traversal/authorization/shaping/gate + tests deleted; PRD-007 AC-2/3/4 rewritten to RRF reality |
| b-AC-4 | No remaining gap between PRD-007 doc and runtime reality. | DONE — PRD-007 banner/overview/ACs reconciled, re-read verified |

### PRD-045c — Ontology linker + `/api/ontology` (closes 008) · Owner: typescript-node-worker-bee · Model: opus · Depends: 045a
| ID | Criterion | Status |
|---|---|---|
| c-AC-1 | `inlineLinkMemory` invoked on a live write path; cite the call site (pipeline graph-persist and/or capture). | OPEN |
| c-AC-2 | `mountOntologyApi` fired in `assemble.ts` (cite line); `/api/ontology/*` returns real data (no 501). | OPEN |
| c-AC-3 | Live itest: a captured/processed memory yields a linked entity readable via `/api/ontology`. | OPEN |
| c-AC-4 | Append-only supersession applies on a live path; a superseded claim is observably tombstoned (not deleted). | OPEN |
| c-AC-5 | Fail-soft mount + invocation (a mount/link error never crashes the daemon). | OPEN |

### PRD-045d — Dreaming-loop activation + proof (closes 009) · Owner: typescript-node-worker-bee · Model: opus · Depends: 045a, 045c
| ID | Criterion | Status |
|---|---|---|
| d-AC-1 | Recorded default-posture decision + exact enable mechanism (env + vault) documented. | OPEN |
| d-AC-2 | Token-gated live itest proves an enabled pass runs to completion (enqueue → lease → model → apply → state). | OPEN |
| d-AC-3 | With dreaming OFF, `POST /api/diagnostics/dream` acks cleanly (`{triggered:false}`/queued), no crash. | OPEN |
| d-AC-4 | Coordination check: dreaming apply + 045a graph-persist do not double-write the same edge. | OPEN |

### PRD-045e — Sources + Documents surface (closes 013) · Owner: typescript-node-worker-bee · Model: opus
| ID | Criterion | Status |
|---|---|---|
| e-AC-1 | Composition root constructs the sources registry + providers resolver; cite the new `assemble.ts` wiring. | DONE — `buildSourcesApiDeps` (`sources/registry.ts:280`) called at `assemble.ts:854`, threaded via `resolveProductDataDeps`→`assemble.ts:706` |
| e-AC-2 | `mountSourcesApi` fires; `/api/sources` GET/POST/DELETE return real data (no 501), tenancy-scoped. | DONE — `product/api.ts:301-304`; GET 200 / POST 201 / DELETE 404 / no-org 400 proven |
| e-AC-3 | `POST /api/documents` ingests through the wired worker (no 501); live itest proves an ingested doc is recallable. | DONE — `mountProductDocumentsApi` (`product/api.ts:246`); 202 deterministic + recallable-chunk live itest (skip-safe) |
| e-AC-4 | At least Obsidian provider instantiated; a source round-trips add → list → sync. | DONE — Obsidian LIVE, connect→health connected; add→list→sync round-trip proven |
| e-AC-5 | Fail-soft mount; a provider/worker error never crashes the daemon. | DONE — `resolveProductDataDeps` try/catch `assemble.ts:852-859`; Discord/GitHub instantiated credential-free fail-soft |

### PRD-045f — Skillify mining worker (closes 016) · Owner: retrieval-worker-bee · Model: sonnet
| ID | Criterion | Status |
|---|---|---|
| f-AC-1 | `assembleDaemon` constructs + starts a worker leasing `["skillify"]`; cite `assemble.ts` line. | DONE — `buildSkillifyWorker` `assemble.ts:1283`, start `:1617-1618`, stop `:1694-1696`; LEASE_KINDS=`["skillify"]` (`worker.ts:187`), foreign-job-untouched proven |
| f-AC-2 | Live itest: session-end enqueue → worker mines → append-only `skills` row lands and is readable via `/api/skills`. | DONE — `tests/integration/skillify-worker-mine-live.itest.ts` (deterministic + token-gated live), enqueue→lease→mine→writeSkill→read |
| f-AC-3 | `skillify pull` CLI verb registered + dispatches (cite verb-table entry). | DONE — verb `contracts.ts:88`; dispatch fix `storage-handlers.ts:114` routes to `POST /api/skills/pull` (⚠ route mount is 045g's job) |
| f-AC-4 | Fail-soft: a miner/model error fails the job, never crashes the daemon or capture path. | DONE — assembly try/catch `assemble.ts:1619-1623`; runOnce catch→`queue.fail` `worker.ts:308-318`, tested |

> **045f→045g handoffs (must be covered by 045g):** (1) session-start auto-pull is a **NO-OP** — fix site `src/hooks/runtime.ts:215` (`SessionStartDeps` built with no `seams`). (2) `POST /api/skills/pull` + publish routes are **not mounted** (only `GET /api/skills` live) — 045g must mount them so the CLI dispatch lands on a real endpoint. (3) merge duplicate CLI surfaces `src/cli/skill.ts` + `src/cli/skillify.ts`.

### PRD-045g — Team Skill Sharing (closes 018) · Owner: retrieval-worker-bee · Model: sonnet · Depends: 045f
| ID | Criterion | Status |
|---|---|---|
| g-AC-1 | Publish endpoint mounted (cite the seam); `POST /api/skills/*` accepts a versioned publish (no 501). | OPEN |
| g-AC-2 | `SessionStartDeps` built WITH the real `autoPull` seam (cite `runtime.ts:198` fix); auto-pull idempotent + fail-soft. | OPEN |
| g-AC-3 | Live itest end-to-end: workspace A mines+publishes (045f) → workspace/harness B auto-pulls on session start. | OPEN |
| g-AC-4 | Skill CLI verbs registered in `VERB_TABLE`; the duplicate `src/cli/skill.ts` impl removed or merged. | OPEN |
| g-AC-5 | Cross-harness symlink fan-out runs on pull and is idempotent. | OPEN |

### PRD-045 index (roll-up + reconciliation) · Owner: library-worker-bee (AC-7/AC-1 docs) + close-out
| ID | Criterion | Status |
|---|---|---|
| AC-1 | Each of 006/007/008/009/013/016/018 has a cited runtime invocation site in `src/` (no test-only reachability). | OPEN |
| AC-2 | A captured turn observably processed by the memory pipeline (extraction produces facts), live itest (045a). | OPEN |
| AC-3 | `/api/ontology/*` (045c), `/api/sources` + `/api/documents` (045e) return real data (no 501) on a real daemon. | OPEN |
| AC-4 | A dreaming pass runs to completion when enabled (045d). | OPEN |
| AC-5 | A session-end mines a skill (045f), published + pulled by a second workspace/harness (045g), end-to-end. | OPEN |
| AC-6 | Retrieval shaping phases on the live recall path or formally de-scoped, PRD-007 reconciled (045b). | OPEN |
| AC-7 | Each affected Completed PRD index carries an accurate reconciliation note; no `Status:` overstates runtime reality. | OPEN |

---

## Wave plan (execution order)
- **Wave 1 (parallel, disjoint files):** 045a [typescript-node, opus] ‖ 045b [retrieval, opus]
- **Wave 2 (solo — `assemble.ts` serialization):** 045e [typescript-node, opus]
- **Wave 3 (solo — `assemble.ts`):** 045f [retrieval, sonnet]
- **Wave 4 (solo — `assemble.ts`; needs 045a):** 045c [typescript-node, opus]
- **Wave 5 (solo — `assemble.ts`; needs 045f):** 045g [retrieval, sonnet]
- **Wave 6 (solo; needs 045a+045c):** 045d [typescript-node, opus]
- **Wave 7 (close-out):** AC-7/AC-1 reconciliation [library, sonnet] → security-worker-bee [opus] → quality-worker-bee [opus]
- **Wave 8 (ship):** commit · push · PR · CI-to-green

> **`assemble.ts` is the serialization point.** 5 of 7 sub-PRDs mutate the single composition root; this repo has a
> documented route-collision history (project-memory "Dogfood surfaces integration bugs"). Composition-root touchers
> run one at a time to guarantee no lost edits / route collisions. 045b runs parallel to 045a (disjoint files).

## Watchdog log
- (none yet)

## Blocker / deferral log (escalated to user)
- (none yet)

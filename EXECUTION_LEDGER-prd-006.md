# EXECUTION LEDGER — PRD-006 Memory Pipeline

> Single source of truth for the /the-smoker run on PRD-006. Survives context loss.
> Status legend: OPEN · IN PROGRESS · DONE (implemented + locally proven) · VERIFIED (independently graded) · BLOCKED

**Run scope:** `library/requirements/in-work/prd-006-memory-pipeline` (index + 006a..006e). **Effort XL.**
**Branch:** `prd-006-memory-pipeline` (off `main`, PRD-001..005 + CI merged). PR targets `main`.
**Builds on:** PRD-004 `memory_jobs` queue (built, version-bumped, live-deterministic — each stage is a job-type worker leasing via the existing lease/reaper/backoff), PRD-003 catalog (`memories`, `memory_history`, graph tables `entities`/`entity_dependencies`/`memory_entity_mentions`), PRD-002 write patterns (`appendVersionBumped`, `selectBeforeInsert`, `updateOrInsertByKey`, `sqlStr`/`eLiteral`, vector search), PRD-005 embed-client seam. Live DeepLake wired (`.env.local` + CI secrets).
**NOT built yet (stubbed via seams):** the model-provider-router (PRD-010 — extraction/decision call a `ModelClient` seam, faked in tests), the full retrieval pipeline (PRD-007 — 006b builds a focused decision-time hybrid candidate lookup, a subset PRD-007 will generalize).

## Verification posture (defines DONE)
- Vitest against: a **FAKE model client** (canned extraction/decision JSON incl. CoT-wrapped + malformed for defensive-parse tests), the **PRD-002 fake transport** for memories/history/graph writes (assert emitted SQL: version-bumped, SELECT-before-INSERT dedup, scope, escaping), a **FAKE embed client** (005b seam) for prefetch, and the worker harness against a fake/real `memory_jobs` queue.
- **Opt-in LIVE tests (high value — this is the write surface where DeepLake consistency bugs hide):** 006c dedup + version-bumped write against real `memories`; 006d entity/mention upsert idempotency; 006e purge sweep. Each uses an authorized workspace + a per-scenario throwaway table prefix + DROP cleanup (the PRD-004/005 pattern). **RETENTION RISK:** DeepLake hard `DELETE` is unreliable (PRD-004 used DROP for cleanup) — 006e must verify purge LIVE and, if DELETE doesn't reliably remove rows, use soft-delete/tombstone (`is_deleted`) or DROP-per-table-batch rather than a hard DELETE that silently no-ops. Flag + adjust; do not rabbit-hole.
- Out of scope: capture intake (PRD-005), retrieval/ranking (PRD-007), the ontology control plane (PRD-008 — 006d is the background bulk path only), the model router internals (PRD-010), hosting the embed/extraction models.

## Resolved foundational decisions (open questions defaulted, not blocked)
| # | Question | Decision |
|---|---|---|
| D-1 | extraction caps / write threshold | input cap 12,000 chars; ≤20 facts, ≤50 entities; per-fact length ~500 chars; `minFactConfidenceForWrite` 0.7. Configurable. |
| D-2 | prospective hints in v1? | DEFERRED — out of scope for v1. |
| D-3 | decision hybrid-search candidates | top 5 candidates per fact, lexical+vector blend (reuse PRD-002e vector + ILIKE lexical), scoped. |
| D-4 | extraction/decision JSON contract | `facts:[{content,type,confidence}]`, `entities:[{source,relationship,target}]`; decision `{action: add|update|delete|none, target_id?, confidence, reason}`. The fake model returns this; parser is defensive. |
| D-5 | retention windows + batch limit | per-run batch limit 500 rows; windows: completed jobs 7d, dead jobs 30d, history 90d, tombstones 30d. Configurable. |
| D-6 | mention idempotency key | composite `memory_id + entity canonical name`. |
| D-7 | contradiction check | negation/antonym token set + lexical-overlap heuristic; flags for review; applies only under `autonomous.allowUpdateDelete`. |
| D-8 | retention purge mechanism | Verify LIVE: prefer soft-delete/tombstone (`is_deleted`) + DROP-batch over hard `DELETE` (unreliable on DeepLake). The Bee confirms what actually removes rows live and uses that. |

Platform: Windows/PowerShell — cross-platform.

## Pipeline config flags (Wave 1 defines; zod, sensible defaults)
`enabled`, `extractionProvider` (none disables), `shadowMode`, `mutationsFrozen` (supersedes shadow), `minFactConfidenceForWrite` (0.7), `autonomous.{enabled,frozen,allowUpdateDelete}`, `graph.{enabled,extractionWritesEnabled}`, retention windows/batch. Source: a pipeline config (agent.yaml later; env/config seam now).

## Scaffold/seam plan (Wave 1 establishes; Wave 2 fills 4 stubs — proven pattern)
Wave 1 builds: the pipeline config (flags), the **ModelClient seam** (router-selection + fake), the **stage-worker harness** (lease a typed `memory_jobs` job → run a stage → complete/fail; reuses the built queue), the **shared contracts** (Fact, EntityTriple, Proposal zod types), the job-type routing, AND implements 006a extraction. Pre-wires stubs for 006b/006c/006d/006e so Wave 2's 4 Bees each fill ONE stage module + its test with zero shared-file contention.

---

## AC Ledger (28 granular ACs)

### PRD-006a — Extraction — Wave 1 (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| a-AC-1 | Raw memory → facts (confidence 0-1) + entity triples, CoT stripped before JSON parse. | VERIFIED |
| a-AC-2 | Oversized input → capped ~12,000 chars before the model call. | VERIFIED |
| a-AC-3 | Oversized result → bounded ~20 facts / ~50 entities + per-fact length limits. | VERIFIED |
| a-AC-4 | Partially invalid output → invalid fields logged+dropped, partial results kept (job not failed). | VERIFIED |
| a-AC-5 | Pipeline disabled or extraction provider `none` → extraction does not run. | VERIFIED |
| a-AC-6 | Worker crashes mid-job → reaper reclaims (via memory_jobs), retried. | VERIFIED |

### PRD-006b — Decision — Wave 2 (`retrieval-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| b-AC-1 | Fact with candidates → add/update/delete/none with target id, confidence, reason. | VERIFIED |
| b-AC-2 | Fact with no candidates → immediate `add` proposal WITHOUT a model call. | VERIFIED |
| b-AC-3 | Any proposal → recorded to `memory_history`. | VERIFIED |
| b-AC-4 | Shadow mode → proposal attributed to `pipeline-shadow` actor, no memory written. | VERIFIED |
| b-AC-5 | Decision run completes → no `memories` rows mutated by this stage. | VERIFIED |

### PRD-006c — Controlled Writes — Wave 2 (`deeplake-dataset-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| c-AC-1 | ADD applied only if confidence ≥ `minFactConfidenceForWrite` (0.7) + non-empty + hash not present. | VERIFIED |
| c-AC-2 | ADD whose content_hash exists → existing memory id returned, no duplicate INSERT. | VERIFIED |
| c-AC-3 | UPDATE/DELETE → contradiction check + flagged for review; applies only under `autonomous.allowUpdateDelete`, as append-only version-bumped. | VERIFIED |
| c-AC-4 | `shadowMode` → nothing written, proposals logged only. | VERIFIED |
| c-AC-5 | `mutationsFrozen` → nothing written even if shadow off; frozen supersedes shadow. | VERIFIED |
| c-AC-6 | Any write → embeddings prefetched beforehand, no network call during commit. | VERIFIED |

### PRD-006d — Graph Persistence — Wave 2 (`deeplake-dataset-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| d-AC-1 | Committed memory → entities upsert by canonical name, relationships by (source,target,type), mentions insert-or-ignore. | VERIFIED |
| d-AC-2 | Same memory reprocessed → no duplicate entities/relationships/mention links (idempotent). | VERIFIED |
| d-AC-3 | Graph persistence fails → warning logged, already-written facts NOT reverted (non-fatal). | VERIFIED |
| d-AC-4 | `graph.enabled` or `graph.extractionWritesEnabled` off → no graph rows written. | VERIFIED |
| d-AC-5 | Any graph write → row carries org/workspace/agent scope. | VERIFIED |

### PRD-006e — Retention — Wave 2 (`deeplake-dataset-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| e-AC-1 | Sweep purges in order (graph links, embeddings, tombstones, history, completed jobs, dead jobs) within a per-run batch limit. | VERIFIED |
| e-AC-2 | Interrupted retention → idempotent, resumes safely, no double-purge. | VERIFIED |
| e-AC-3 | Purged row owning embeddings/vectors → those purged with the row, not orphaned. | VERIFIED |
| e-AC-4 | `autonomous.enabled` off → retention does not run. | VERIFIED |
| e-AC-5 | `autonomous.frozen` set → halts, no further purges. | VERIFIED |
| e-AC-6 | Sweep reaches per-run batch limit → stops and yields. | VERIFIED |

### Index roll-ups (transitive)
| Index AC | Satisfied by | Status |
|---|---|---|
| AC-1 bounded facts+triples, drop-invalid-as-warning | a-AC-1, a-AC-3, a-AC-4 | VERIFIED |
| AC-2 decision records add/update/delete/none to history | b-AC-1, b-AC-3 | VERIFIED |
| AC-3 ADD gated by confidence+non-empty+hash | c-AC-1, c-AC-2 | VERIFIED |
| AC-4 shadow/frozen → logged not written | c-AC-4, c-AC-5 | VERIFIED |
| AC-5 graph failure does not revert facts | d-AC-3 | VERIFIED |

**Totals:** 28 granular ACs · **28 VERIFIED** · 0 OPEN · 0 BLOCKED — ledger fully VERIFIED (006c+006d+006e live-proven), close-out unlocked.

---

## Wave plan
```
Wave 1 (scaffold + contracts + 006a extraction + b/c/d/e stubs) ──► Wave 2 (006b ‖ 006c ‖ 006d ‖ 006e) ──► Wave 3 (security → quality) ──► Ship
```
- **Wave 1 — Pipeline scaffold + extraction (006a)** · `typescript-node-worker-bee` + `typescript-node-stinger` · **opus**. Config flags (zod), ModelClient seam (router-select + fake), stage-worker harness (typed memory_jobs lease → run → complete/fail), shared contracts (Fact/EntityTriple/Proposal), 006a extraction (defensive CoT-strip + JSON parse, caps, drop-invalid-keep-partial, gated). Pre-wires 006b/c/d/e stage stubs. (006a-AC-6 reaper reuses the built queue.)
- **Wave 2 — stages (4 parallel, each fills one pre-wired stub + test)** ·
  - 006b decision — `retrieval-worker-bee` + `retrieval-stinger` — **opus** (hybrid candidate search + model decision + history proposals + shadow actor; no-candidate short-circuit).
  - 006c controlled writes — `deeplake-dataset-worker-bee` + `deeplake-dataset-stinger` — **opus** (the only memories mutator; confidence gate, SELECT-before-INSERT dedup, version-bumped UPDATE/DELETE, shadow/frozen, embed prefetch). + opt-in LIVE dedup/version-bump test.
  - 006d graph persistence — `deeplake-dataset-worker-bee` + `deeplake-dataset-stinger` — **sonnet** (entity/relationship upsert, mention insert-or-ignore, non-fatal, idempotent, scoped). + opt-in LIVE idempotency test.
  - 006e retention — `deeplake-dataset-worker-bee` + `deeplake-dataset-stinger` — **opus** (batched idempotent ordered sweep, batch cap, autonomous gates, decay; **the DeepLake DELETE-vs-soft-delete/DROP live verification**). + opt-in LIVE purge test.
- **Wave 3 — Close-out** · `security-worker-bee` (opus) → `quality-worker-bee` (sonnet). Security: SQL injection via model-extracted facts into memories/graph, prompt-injection via captured trace, tenancy scope on every write, shadow/frozen brakes can't be bypassed (unwanted mutation), retention can't cross tenancy / over-purge, the allowUpdateDelete gate, PII in the pipeline.

Dependency: Wave 1 (contracts + harness + config + seams) hard-blocks Wave 2. With contracts fixed, 006b/c/d/e are independently implementable + testable against fakes → 4-way parallel (the data flow between stages is via memory_jobs/contracts, not shared code).

---

## Watchdog / event log
- PRD-006 moved backlog→in-work (git mv); index status In-Work. Branch `prd-006-memory-pipeline` off main (PRD-001..005 + CI merged).
- Wave 1 DONE (`typescript-node-worker-bee`): pipeline scaffold built under `src/daemon/runtime/pipeline/` — `config.ts` (zod flags D-1..D-8), `model-client.ts` (ModelClient seam + fake), `contracts.ts` (Fact/EntityTriple/Proposal), `stage-worker.ts` (lease→route→run→complete/fail harness, 5 job kinds), `extraction.ts` (006a FULLY: gate/cap/CoT-strip/defensive-parse/drop-invalid/bound), `handlers.ts` (routing registry), `index.ts` (barrel), `CONVENTIONS.md` (the 4-way Wave-2 contract). Pre-wired 4 stubs: `decision.ts`/`controlled-writes.ts`/`graph-persist.ts`/`retention.ts` (each no-op default + filling instructions). a-AC-1..6 all DONE with AC-named tests (`tests/daemon/runtime/pipeline/{config,extraction,stage-worker}.test.ts`, 23 tests). Gate: `npm run ci` (typecheck+dup+309 tests+audit:sql) GREEN, `npm run build` GREEN, `npm run audit:openclaw` GREEN, daemon-only invariant GREEN. Wave 2 (006b/c/d/e) unblocked — 4-way parallel against fixed contracts.
- Wave 1 (006a + scaffold) → `typescript-node-worker-bee` (opus). Built pipeline/{config,model-client,contracts,stage-worker,extraction,handlers,index,CONVENTIONS} + 4 stage stubs. 006a extraction (CoT strip, 12k cap, ≤20/≤50 bounds, drop-invalid-keep-partial, gated). +23 tests (309). Pipeline daemon-only.
- Orchestrator verify: ci=0 (309 tests), build/audit:openclaw/audit:sql green; a-AC-1..6 named+unskipped; 4 stubs + CONVENTIONS present; 0 leak into thin bundles. → a-AC-1..6 VERIFIED.
- Wave 2 dispatched (4 parallel): 006b decision (retrieval, opus), 006c controlled-writes (deeplake-dataset, opus, +live), 006d graph-persist (deeplake-dataset, sonnet, +live), 006e retention (deeplake-dataset, opus, +live; D-8 DELETE-vs-soft-delete live check).
- Wave 2 (4 parallel): 006b decision (retrieval, opus, 10 tests) ✓; 006c controlled-writes (deeplake-dataset, opus) — Bee DIED on API socket error at ~85%; fresh deeplake-dataset Bee completed it (impl was correct; 3 failures were over-strict test assertions vs the bare-column `buildInsert` output) → 22 unit + 3/3 LIVE ✓; 006e retention (deeplake-dataset, opus, 8 unit + 2/2 LIVE, tombstone-purge D-8 proven) ✓; 006d graph-persist (deeplake-dataset, sonnet, 18 unit) — sonnet never ran live (no token).
- Orchestrator verify: unit ci=0 (367 tests); LIVE suite 12/14 — **BOTH `graph-persist-live` tests FAIL** (first-pass persist + idempotency): 006d's `updateOrInsertByKey` entity upsert + SELECT-before-INSERT don't converge on real DeepLake (the segment-flap class that caught the queue). → b/c/e + d-AC-3/4/5 VERIFIED; **d-AC-1/d-AC-2 reopened (live-FAIL)**.
- 006d live fix dispatched → `deeplake-dataset-worker-bee` (opus): use DeepLake-reliable patterns (deterministic-id append + poll-convergent highest-version read, like the queue/controlled-writes) so graph persist + idempotency hold live, without breaking the 18 unit tests.
- 006d live fix (deeplake-dataset, opus): root cause = (a) entity dup from a stale-segment by-name probe + in-place UPDATE; (b) **dependencies never persisted — INSERT bypassed `withHeal` (raw query → 400 table-not-exist)**; (c) test-side bare scans flap. Fix: deterministic-id append-only version-bumped entities + heal-aware appendOnlyInsert for deps/mentions + poll-convergent by-id probes + poll-convergent verification scans. 4 consecutive clean live runs.
- Orchestrator independent verify: unit ci=0 (368 tests); graph-persist-live **3/3 consecutive clean runs** (integration config) — combined 7 consecutive. Full live suite now 14/14. → **d-AC-1/d-AC-2 + index roll-ups VERIFIED. All 28 ACs VERIFIED.**
- Wave 3 close-out dispatched: `security-worker-bee` (opus) → `quality-worker-bee` (sonnet). Pipeline writes model-extracted facts → SQL-injection + PII + shadow/frozen-bypass + tenancy + over-purge focus.
- `security-worker-bee` (opus): **0 Critical / 0 High.** F-1 Medium FIXED — decision stage logged truncated fact content (captured-prompt PII) → now logs `factLength` only. F-2/F-3 Low RECOMMENDED (sqlLike wildcard in lexical-degrade; retention batchLimit no ceiling). Verified: SQL-injection-via-model-output (4/4 bypass probes flagged across all 5 stages), shadow/frozen brakes config-only fail-closed (model can't flip), retention set-based `<=cutoff` + tombstone-first + per-tenant (no over-purge/cross-tenant). Report: `.../reports/2026-06-17-security-report.md`.
- Orchestrator re-verify: F-1 fix present; ci=0 (368 tests), build/audit:openclaw green; audit:sql flags a planted pipeline model-output bypass (teeth), clean otherwise. **No blocking findings.**
- `quality-worker-bee` (sonnet) dispatched.
- `quality-worker-bee` (sonnet): **PASS-WITH-FINDINGS** — 28/28 ACs + 5 index roll-ups PASS (non-vacuous); LIVE suite **14/14** independently re-run; 006d fix assessed genuinely sound (append-only + heal-aware + poll-convergence); F-1 PII fix confirmed; scope discipline held. 2 Low follow-ups (F-2 sqlLike escaping, F-3 retention batch ceiling) — recommended before PRD-010, non-blocking. Report: `.../reports/2026-06-17-qa-report.md`. Both gates clean → loop terminates.
- **Ship:** committing memory pipeline + library; PR targets main.

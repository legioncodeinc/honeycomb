# EXECUTION LEDGER - PRD-058 Memory Lifecycle

> Orchestrator: `/the-smoker` · Branch: `legion/zealous-payne-b1e0d3`
> Worktree: `C:\Users\mario\GitHub\honeycomb\.claude\worktrees\zealous-payne-b1e0d3`
> Goal: drive PRD-058 and all five sub-PRDs to 100% verified completion. The best memory on the market.
> Source of truth. Survives context loss. Status: OPEN / IN_PROGRESS / DONE / VERIFIED / BLOCKED.

## Verification gates (offline, runnable here)
- `npm run typecheck` (tsc --noEmit)
- `npm run dup` (jscpd threshold 7)
- `npm run test` (vitest run - unit + mocked integration)
- `npm run audit:sql` (no hand-quoted SQL in src/daemon)

## Credential-gated gates (BLOCKED here - need `HONEYCOMB_DEEPLAKE_TOKEN` + running embed daemon)
- `npm run eval:recall` numeric verdict (skips without token; harness CODE is delivered + unit-tested)
- Live dogfood against a real daemon + real DeepLake store

---

## Wave plan (dependency-ordered; shared-file contention on recall.ts + schema registry forces serialization)

| Wave | Sub-PRD | Owner Bee (armed) | Model | Why this model |
|---|---|---|---|---|
| 1 | 058a recency-decay (`A` Stage 1) | retrieval-worker-bee + retrieval-stinger | Opus | keystone: recall-pipeline math + freshnessScore contract every later term reuses |
| 2 | 058e reinforcement/calibration (`A` Stage 2 + `C`) | retrieval-worker-bee + retrieval-stinger | Opus | ACT-R activation + isotonic calibration + 3 new tables; deepest math |
| 3 | 058c stale-ref healing (`σ`) | retrieval-worker-bee + retrieval-stinger | Opus | codebase-graph cross-ref diagnostic (retrieval owns the tree-sitter graph) |
| 4 | 058b conflict resolution (`κ`) | retrieval-worker-bee + retrieval-stinger | Opus | the only zeroing gate; highest-stakes correctness surface |
| 5 | 058d surfaces & controls | typescript-node-worker-bee + react-worker-bee | Opus | config single-source + read API + CLI + dashboard panel |
| 6 | close-out: security | security-worker-bee + security-stinger | Opus | OWASP/PII/SQL-injection on new endpoints + tables |
| 7 | close-out: quality | quality-worker-bee + quality-stinger | Opus | implementation-vs-PRD audit, fresh grader |

Serialization rationale: `recall.ts` is edited by 058a/058e/058c/058b and the schema registry by 058e/058c/058b. Parallel edits to the same files = merge chaos (project memory: "subagents scatter across worktrees"). Each wave owns its files exclusively and is verified green before the next starts.

---

## AC Ledger

### PRD-058a - recency activation & decay (`A` Stage 1) - Wave 1 VERIFIED (tsc clean, 34 tests pass, audit:sql clean)
| ID | Criterion | Status |
|---|---|---|
| 58a.1.1 | Equal R, larger Δt → smaller freshnessScore, ranks below (P=R·A^a orders by A) | VERIFIED |
| 58a.1.2 | Never removed by age alone; A_simple ∈ (0,1] no cutoff | VERIFIED |
| 58a.1.3 | Recency is LAST score adjustment (fuse→rerank→dedup→recency→budget+MMR) | VERIFIED |
| 58a.2.1 | sessions hit > penalty than memories at equal age (h(sessions)<h(memories)) | VERIFIED |
| 58a.2.2 | caller override `halfLifeDaysByClass` honored | VERIFIED |
| 58a.2.3 | class w/o configured half-life → documented default, never 100yr neutral | VERIFIED |
| 58a.3.1 | every hit carries freshnessScore ∈ [0,1] = applied multiplier | VERIFIED |
| 58a.3.2 | embeddings off → freshnessScore still computed from age, degraded:true honest | VERIFIED |
| 58a.3.3 | missing/unparseable timestamp → A=1, not dropped/errored | VERIFIED |
| 58a.eval | freshness-sensitivity eval slice committed (CODE) | VERIFIED (code; live numeric run BLOCKED on creds → IDX-1) |

### PRD-058e - reinforcement, activation, calibration (`A` Stage 2 + `C`) - Wave 2 VERIFIED (tsc clean, 304 tests pass, audit:sql + dup clean)
| ID | Criterion | Status |
|---|---|---|
| 58e.1.1 | reinforced useful access → A_actr strictly higher | VERIFIED |
| 58e.1.2 | spread accesses ≥ bunched (spacing effect) | VERIFIED |
| 58e.1.3 | contradicted/ignored same turn → u_k→0, no inflation | VERIFIED |
| 58e.1.4 | cold memory → A_actr ≥ A_min | VERIFIED |
| 58e.2.1 | calibration refit → held-out ECE non-increasing | VERIFIED |
| 58e.2.2 | insufficient data → g identity (C=f), c stays 0 | VERIFIED |
| 58e.2.3 | g clears ECE gate → c activatable, eval-gated | VERIFIED |
| 58e.3.1 | two stale-eligible → higher A_actr checked shorter interval | VERIFIED |
| 58e.3.2 | cold low-activation → longest interval/deferred, never starves hot set | VERIFIED |
| 58e.schema | memory_access + last_reinforced_at/access_count + memory_calibration (lazy-heal) | VERIFIED |
| 58e.note | DESIGN RECONCILIATION: memory_access org/workspace via QueryScope partition (codebase D-2 convention), not explicit cols; agent_id carried. Flag for quality. | NOTE |

### PRD-058c - stale-reference healing (`σ`) - Wave 3 VERIFIED (tsc clean, 75 tests pass, audit:sql + dup clean)
| ID | Criterion | Status |
|---|---|---|
| 58c.1.1 | absent symbol → resolve=0, σ=1, ref_status=stale, verified_at=now, stale_refs recorded | VERIFIED |
| 58c.1.2 | all refs resolve → σ≈0, fresh | VERIFIED |
| 58c.1.3 | ref outside indexed graph → excluded, unknown never stale | VERIFIED |
| 58c.1.4 | no indexed refs → σ=0 (empty product), never demoted | VERIFIED |
| 58c.1.5 | fuzzy rename candidate → resolve=sim∈(0,1), partial demote | VERIFIED |
| 58c.2.1 | observe (s=0) → (1-σ)^0=1, flagged+dashboard, ranking unchanged | VERIFIED |
| 58c.2.2 | execute (s>0) → (1-σ)^s<1 fed into 058a stage, demoted not hard-dropped | VERIFIED |
| 58c.2.3 | ref returns later snapshot → σ falls, fresh, demotion lifted | VERIFIED |
| 58c.2.4 | detection/heal appended to memory_history (actor,reason,σ,stale_refs) | VERIFIED |
| 58c.3.1 | verified_at old, v below threshold → re-queued | VERIFIED |
| 58c.3.2 | stale memory + new snapshot → re-verification re-checks | VERIFIED |
| 58c.3.3 | snapshot reads poll to convergence, not single read | VERIFIED |
| 58c.schema | ref_status/verified_at/stale_refs columns on memories (lazy-heal) | VERIFIED |

### PRD-058b - semantic conflict detection & resolution (`κ`) - Wave 4 VERIFIED (tsc clean, 137 tests pass incl. 058a/c/e regression, audit:sql + dup clean)
| ID | Criterion | Status |
|---|---|---|
| 58b.1.1 | Contra>θ pair → at most winner returned | VERIFIED |
| 58b.1.2 | supersede → loser κ=0 excluded by MAX(version) | VERIFIED |
| 58b.1.3 | review → loser κ=ρ suppressed, reversible | VERIFIED |
| 58b.1.4 | uncontested → κ=1 untouched | VERIFIED |
| 58b.2.1 | high sim opposite outcome, 0 shared tokens → Contra=sim·P_contradiction clears θ, signal=model | VERIFIED |
| 58b.2.2 | cheap lexical → opp=max flags from lexical alone, signal=lexical, before model call | VERIFIED |
| 58b.2.3 | provider none → P_contradiction skipped, opp=opp_lexical, still recorded, no throw | VERIFIED |
| 58b.2.4 | keep-both memoized → no re-flag same normalized pair | VERIFIED |
| 58b.3.1 | w_i=A·C·prov·corr, winner argmax; distilled outvotes raw at equal-else | VERIFIED |
| 58b.3.2 | close scores → margin∈[τ_review,τ_supersede) → review, neither superseded | VERIFIED |
| 58b.3.3 | corr counts independent sources; duplicates count once | VERIFIED |
| 58b.3.4 | margin≥τ_supersede → supersede, loser κ=0, margin+contra_score persisted | VERIFIED |
| 58b.4.1 | detection/resolution → memory_history + memory_conflicts row | VERIFIED |
| 58b.4.2 | reverse supersede → loser restored κ=1 via version bump, status=reversed, recorded | VERIFIED |
| 58b.4.3 | no destructive delete/in-place mutate; append-only version-bump only | VERIFIED |
| 58b.schema | memory_conflicts table (lazy-heal) | VERIFIED |
| 58b.api | POST /api/memories/conflicts/:id/resolve (zod, scope-checked) | VERIFIED |

### PRD-058d - lifecycle config, audit, dashboard, CLI - Wave 5 VERIFIED (tsc clean, 58 tests pass, audit:sql + dup clean)
| ID | Criterion | Status |
|---|---|---|
| 58d.1.1 | fresh install defaults non-destructive: a=1, c=0, s=0, auto-resolve off | VERIFIED |
| 58d.1.2 | env override per-key over yaml; precedence documented | VERIFIED |
| 58d.1.3 | every flag on settings page + config reference (symbol, default, effect) | VERIFIED |
| 58d.1.4 | stale-ref posture observe→execute → s 0→configured, visible, no other term changes | VERIFIED |
| 58d.2.1 | memories page: health badge H, freshness, open-conflict count, stale-ref count, ECE | VERIFIED |
| 58d.2.2 | dashboard resolve → calls 058b endpoint, polls to convergence | VERIFIED |
| 58d.2.3 | memory_history filtered by lifecycle type → actor,reason,confidence,timestamp | VERIFIED |
| 58d.2.4 | calibration view → reliability diagram + ECE/Brier from memory_calibration | VERIFIED |
| 58d.3.1 | `honeycomb memory conflicts` list scope-filtered | VERIFIED |
| 58d.3.2 | `honeycomb memory conflicts resolve <id> --verdict --winner` same endpoint/path | VERIFIED |
| 58d.3.3 | `honeycomb memory stale-refs` list | VERIFIED |
| 58d.3.4 | inspection `--lifecycle` → freshnessScore, calibratedConfidence, refStatus, conflict, H | VERIFIED |

### PRD-058 parent index - rollups + integration
| ID | Criterion | Status |
|---|---|---|
| IDX-1 | recency ships measured non-neutral default half-life passing eval:recall gate | BLOCKED (needs creds) - code + slice delivered |
| IDX-2 | two contradictory never both appear; loser suppressed; recorded to history | VERIFIED (Wave 6: live call site assemble.ts:1545 + controlled-writes.ts:503/610; conflict-live-path.spec proves it; orchestrator-confirmed by call-site grep) |
| C-1 | (QA Critical) wire detectAndProject into controlled-writes decision stage + live-path test | VERIFIED (Wave 6) |
| W-1 | (QA Warning) useful-context@k end-to-end eval aggregator CODE | VERIFIED (Wave 6) |
| W-2 | (QA Warning) ECE-over-time eval slice CODE | VERIFIED (Wave 6) |
| IDX-3 | memory naming absent symbol detected by maintenance worker, flagged stale_ref | VERIFIED (rollup of 58c.1.1; live-wired via stale-ref-api) |
| IDX-4 | every lifecycle action gated by config flag, non-destructive default, visible in dashboard | VERIFIED (rollup of 58d.1.x/2.1) |
| IDX-5 | recalled+useful harder to forget (activation rises); ECE monotone non-increasing | VERIFIED (rollup of 58e.1.1/2.1; ECE-over-time slice W-2) |
| IDX-6 | recall fail-soft: embeddings off / daemon down -> every stage degrades, recall answers | VERIFIED (fail-soft tests across 058a/b/c/e recall path) |
| IDX-7 | useful-context@k improves over baseline; no term regresses recall@5/MRR/nDCG@10 below baseline−ε | BLOCKED (needs creds) - metric + slice code delivered |
| IDX-8 | live dogfood exercises all lifecycle paths end-to-end vs real daemon + real DeepLake | BLOCKED (needs creds) |

---

## Wave log
- Phase 0: all five sub-PRDs + scoring doc + recall pipeline read; ledger built; gates identified.
- Wave 1 (058a recency): VERIFIED. tsc + 34 tests + audit:sql + dup green.
- Wave 2 (058e reinforcement/calibration): VERIFIED. tsc + 304 tests (incl. storage heal) + gates green.
- Wave 3 (058c stale-ref): VERIFIED. tsc + 75 tests + gates green.
- Wave 4 (058b conflict): VERIFIED. tsc + 137 tests (incl. 058a/c/e regression) + gates green.
- Wave 5 (058d surfaces): VERIFIED. tsc + 58 tests + gates green. Ledger em-dashes fixed (prose rule).
- Close-out security: CLEAN (no Critical/High; zero code changes).
- Close-out quality: found Critical C-1 (conflict detection not wired live) + W-1/W-2 eval gaps.
- Wave 6 (reopen): C-1 wired into controlled-writes decision stage + assemble.ts (LIVE); live-path test proves IDX-2; W-1 useful-context@k + W-2 ECE-over-time slices added. VERIFIED (148 + 64 tests).
- Full suite: 3538 pass / 14 fail / 8 skip; all 14 failures are pre-existing environmental flakes (hook-runtime, json-parsers) NOT in this change set; both pass 30/30 in isolation.
- Ship: commit 6fc192d (79 files, +12471). Pushed. PR #125 (legioncodeinc/honeycomb).
- CI: Quality gate Node 22.x + 24.x GREEN, Windows smoke GREEN, CodeQL GREEN, Secret gate GREEN. Full suite passed on CI runners (local flakes did not recur). DeepLake live jobs skipped (creds-gated).
- RESULT: 53/56 ACs VERIFIED. IDX-1/IDX-7/IDX-8 BLOCKED on HONEYCOMB_DEEPLAKE_TOKEN + embed daemon (live numeric eval verdict + dogfood). PRD stays in-work until that live run promotes it to completed.

## The one remaining ask (to reach 56/56 and promote to completed)
Run, on a machine with the gitignored live creds + the embed daemon up:
  `set -a; . ./.env.local; set +a; HONEYCOMB_EMBEDDINGS=true npm run eval:recall`
plus the live dogfood loop each sub-PRD describes (store a fact + its contradiction + a stale ref against a real daemon; confirm suppression, demotion, dashboard + CLI surfaces, memory_history). That closes IDX-1 (recency half-life passes the gate), IDX-7 (useful-context@k uplift, no baseline regression), and IDX-8 (live dogfood).

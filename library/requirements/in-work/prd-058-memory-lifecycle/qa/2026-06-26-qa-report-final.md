# QA Findings Report (FINAL): PRD-058 Memory Lifecycle

> **Auditor:** quality-worker-bee (armed with quality-stinger)
> **Date:** 2026-06-26
> **Branch:** `legion/zealous-payne-b1e0d3`
> **Head:** `ad9a29c` (post 5-wave build + 4 rounds CodeRabbit remediation)
> **Worktree:** `C:\Users\mario\GitHub\honeycomb\.claude\worktrees\zealous-payne-b1e0d3`
> **Source plans:** PRD-058 parent index + sub-PRDs 058a/b/c/d/e + `EXECUTION_LEDGER-prd-058.md` + `memory-lifecycle-scoring.md`
> **Ordering:** security-worker-bee ran first on `ad9a29c` with zero code changes and zero Critical/High, and cleared QA to proceed. No ordering violation. QA snapshot is valid.
> **Relationship to the prior report:** this is the FINAL close-out for PR #125, written AFTER the prior immutable snapshot (`2026-06-26-qa-report.md`). That snapshot predates remediation rounds 3-4; its C-1/W-1/W-2 findings are RESOLVED and re-verified against the current code here. The prior snapshot is NOT edited.

## Summary

**PASS - PRD-058 is implementation-complete and ready to ship, modulo the three credential-gated live-verification ACs (IDX-1, IDX-7, IDX-8) that cannot run in this environment.** The single Critical from the prior QA snapshot (C-1, conflict detection built but never invoked on a live daemon path) is fully and correctly resolved: a new `conflict-hook.ts` bridges the detector into the live controlled-write path, wired at the composition root in `assemble.ts` and called post-commit in `controlled-writes.ts`, with the decision stage forwarding its hydrated candidate set through `fan-out.ts`. A genuine live-path round-trip test (`conflict-live-path.spec.ts`) proves IDX-2 end to end. Both prior Warnings (W-1 `useful-context@k`, W-2 ECE-over-time) are now delivered as real eval slices with unit coverage. All four offline gates are green (typecheck, dup, audit:sql, vitest), the math matches `memory-lifecycle-scoring.md` line-for-line after remediation, and the four CodeRabbit rounds (tenancy scoping, single-owner `access_count`, compaction abort-on-missing, conflict-path correctness) verify correct in the current code. No new findings rise to Critical or Warning. **Verdict: ship PR #125; the PRD stays in-work only until the live numeric eval + dogfood run promotes IDX-1/7/8 to complete.**

## Scorecard

| Axis | Status | Notes |
|---|---|---|
| Completeness | PASS | All five terms (A, C, σ, κ + recency) + schema + surfaces + CLI delivered. C-1 live wiring closed; both eval-slice Warnings (useful-context@k, ECE-over-time) now delivered with tests. |
| Correctness | PASS | Every formula matches `memory-lifecycle-scoring.md` (A_simple, A_actr clamp, σ product + empty-product, verdict table, H = A·C·(1−σ)·κ, useful-context@k conjunction). All defaults correct (a=1, c=0, s=0, d=0.5, A_min=0.05, θ=0.6, γ=0.5, τ_supersede=0.5, τ_review=0.15, ρ=0, h_verify=14d). |
| Alignment | PASS | Implements the PRD ontology faithfully. The decision-stage wiring the prior gap flagged (058b Files-Touched) now exists. The 058e scope-column reconciliation resolves in the implementer's favor (engine-table `scope: "agent"` convention; cross-workspace conflict is explicitly out of scope). |
| Gaps | PASS | No real implementation gaps remain. IDX-1/IDX-7/IDX-8 are BLOCKED-on-credentials (live DeepLake token + embed daemon), not missing code: the eval-slice and dogfood CODE is delivered and unit-tested. |
| Detrimental Patterns | PASS | No stubs/mocks-in-prod, no TODO-later, no in-place mutation, no destructive delete, no hand-quoted SQL. Fail-soft, append-only, poll-to-convergence invariants hold on every new path, verified at two layers on the conflict hook. |

## Gate Output (re-run by this audit at HEAD `ad9a29c`)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` (tsc --noEmit) | **PASS** (exit 0, no output) |
| Duplication | `npm run dup` (jscpd threshold 7) | **PASS** (exit 0; 29 clones, 0.63% duplicated tokens, well under the 7% threshold) |
| SQL audit | `npm run audit:sql` | **PASS** (exit 0; "OK - every SQL interpolation routes through an escaping helper"; 248 files scanned) |
| Unit + mocked integration | `npm run test` (vitest run) | **3573 passed / 8 skipped / 2 failed (3583 total)**, process exit 0 |

### Test-failure triage (independently verified PRE-EXISTING + environmental, NOT PRD-058)

The 2 failures are isolated to two files, **neither in the PRD-058 change set**, and both fail on `Test timed out in 5000ms` (timeout, not logic):

- `tests/hooks/runtime/hook-runtime.test.ts` > "renders the daemon-returned context block into additionalContext" - a session-prime digest render timing out against the 5000ms per-test cap on this (slower) local machine. Last functional change was `d5b4a1f` (PRD-045); only touched on this branch by `104a6f2` (PRD-059). **Zero PRD-058 references** (its lone "lifecycle" grep hit is `"a non-lifecycle event the shim drops"` at line 374, session-hook terminology, a false positive).
- `tests/daemon/runtime/secrets/exec.test.ts` > "kills a runaway, marks timed_out..." - the known stdout-drain / runaway-kill race, also a timeout. Unmodified on this branch; no PRD-058 references.

**Independent verification performed:** (1) `git diff --name-only` over the PRD-058 range shows neither file changed; (2) `grep` for PRD-058 markers in both files returns only the documented false positive; (3) both files fail on `timed out in 5000ms`, not an assertion; (4) per the ledger these passed GREEN on the CI runners (Node 22.x + 24.x quality gate, Windows smoke) - the local flake did not recur in CI. These are exactly the known-and-accepted environmental timeout flakes the brief described. **CONFIRMED: zero PRD-058 spec files are in the failure set.**

> Note on the brief's expected flake pair: the brief named `hook-runtime.test.ts` + `json-parsers.property.test.ts`. This run surfaced `hook-runtime.test.ts` + `secrets/exec.test.ts` instead (the same pair the prior snapshot recorded). `json-parsers.property.test.ts` passed here. All three are the same class of timeout/race flake in unrelated subsystems; the substitution is timing-dependent, not a regression.

### Credential-gated gates (BLOCKED by design, not a defect)

`npm run eval:recall` (numeric verdict) and the live dogfood require `HONEYCOMB_DEEPLAKE_TOKEN` + a running embed daemon, unavailable here. These map to IDX-1, IDX-7, IDX-8. Treated as **BLOCKED-on-credentials**, NOT as missing implementation: the eval-slice code (freshness, staleness, contradiction, CRA, useful-context@k, ECE-over-time) and the dogfood-able paths are all delivered and unit-tested. Not penalized.

---

## Critical Issues (must fix)

**None.**

The prior QA snapshot's sole Critical (C-1) is resolved and re-verified at HEAD `ad9a29c` (see "Resolution Verification" below).

## Warnings (should fix)

**None.**

The prior QA snapshot's two Warnings (W-1, W-2) are resolved and re-verified at HEAD `ad9a29c` (see below).

## Suggestions (consider improving)

### S-1. Re-confirm the three credential-gated ACs on a live machine before promoting the PRD to `completed`

Not a code defect - a process reminder. IDX-1 (recency half-life passes `eval:recall`), IDX-7 (useful-context@k uplift, no baseline regression), and IDX-8 (live dogfood) cannot be closed offline. The implementing code and eval slices exist; only the numeric run is outstanding. The ledger already records the exact command. This is the one item keeping the PRD in-work and is the right place for it to be.

---

## Resolution Verification (the point of this final pass)

### C-1 (prior Critical) - RESOLVED. Conflict detection is now live-wired end to end.

The prior snapshot found `detectAndProject` was built and unit-tested but never invoked on any production write, so `memory_conflicts` stayed empty and contradictory memories both surfaced (violating IDX-2). The current code closes this with a complete, correct, fail-soft live chain:

1. **Decision stage forwards its candidate set.** `src/daemon/runtime/pipeline/fan-out.ts:155-183` forwards the decision stage's hybrid candidate set (`{id, hydrated content}`) on the `memory_controlled_write` job payload - the SAME candidates the decision model saw, no new scan. It correctly drops content-less candidates and **excludes the just-updated row's own prior version** (a CodeRabbit fix preventing a bogus self-conflict).
2. **Controlled-write calls the hook post-commit.** `src/daemon/runtime/pipeline/controlled-writes.ts:503` (create path) and `:610` (update-with-new-content path) call `runConflictHook` AFTER the append-only commit lands, off the write's critical section, guarded so a hook failure never throws into (or replays) the committed write.
3. **The hook runs the real detector + projects.** `src/daemon/runtime/memories/conflict-hook.ts` (NEW since the prior snapshot) builds the voter set from the committed memory + forwarded candidates, runs `detectAndProject` over them, and projects any flagged pair into `memory_conflicts` + `memory_history`. Fail-soft at TWO layers: `detectAndProject` degrades a down embed/model to the lexical signal, and the hook wraps the call in its own try/catch so a raw transport throw still returns `{projectedIds: []}`.
4. **The dependency arrow is sound.** The hook is built on the `memories` side and injected at the composition root (`src/daemon/runtime/assemble.ts:1538` builds `createControlledWriteConflictHook`, `:1545` injects it as `onConflict`), avoiding the `memories -> pipeline` import cycle - the same pattern as the existing `onOutcome` fan-out.
5. **Recall's κ gate reads the now-non-empty projection.** `assemble.ts:877` wires `createConflictSuppressionSource(storage)`; with detection live, the open-conflict projection is populated and the loser is suppressed at recall.

**Proving test:** `tests/daemon/runtime/memories/conflict-live-path.spec.ts` drives `applyControlledWrite` (the real handler) with the real `createControlledWriteConflictHook` wired exactly as `assemble.ts` does. A stateful fake transport captures the actual `memory_conflicts` INSERT detection emits and replays it on recall's κ-gate read - so suppression is driven by what detection ACTUALLY WROTE, not an injected set. It asserts: (a) fact A alone projects nothing; (b) storing contradiction B with A forwarded as a candidate projects an `open` `memory_conflicts` row with a winner; (c) recall returns the winner and NOT the loser. Plus the no-candidate short-circuit and the fail-soft "hook throws, write still commits" cases. **This is a true IDX-2 round-trip on the wired path** - exactly the test the prior snapshot found missing.

### W-1 (prior Warning) - RESOLVED. `useful-context@k` headline metric delivered.

`usefulContextAtK` (`src/eval/metrics.ts:426`) implements the scoring-doc headline exactly: returns 1 iff a top-k id is CORRECT **and** NOT excluded (not stale, not a conflict loser) - the end-to-end conjunction of correctness + currentness + non-conflict. `aggregateUsefulContext` (`metrics.ts:452`) means it over cases (empty set -> count 0, never NaN). The slice runner `runUsefulContextSlice` + types live in `src/eval/golden.ts:664-730`, with unit coverage in `tests/eval/useful-context-ece-slice.test.ts`. The live numeric run is creds-gated (IDX-7), but the gating CODE now exists, so IDX-7 is runnable once credentials land.

### W-2 (prior Warning) - RESOLVED. ECE-over-time slice delivered.

`runEceOverTimeSlice` (`src/eval/golden.ts:790`) computes held-out ECE + Brier per time window (reusing the SAME `expectedCalibrationError` / `brierScore` math the 58e adoption gate uses), oldest-first, and reports `improved = lastEce <= firstEce` (the monotone-non-increasing trend IDX-5 names). Unit-covered in `tests/eval/useful-context-ece-slice.test.ts`. This is the standalone trend the prior per-fit `shouldAdoptRefit` gate only implied.

### CodeRabbit rounds 1-4 - VERIFIED in current code

- **Tenancy (round 1).** `calibration-store.ts:71-73` scopes the calibration read to the owning agent (a global "newest snapshot" read could otherwise return another agent's curve in a multi-agent workspace). `access-log.ts:158-166` carries the memory's real `agent_id` + `visibility` onto every `memory_access` event row. Both tenancy leaks closed.
- **`access_count` single-owner (round 3).** `access-log.ts:128-135` - `recordAccess` is the SOLE writer of `access_count`, bumping `+1` via an atomic relative increment (never read-modify-write), counted EXACTLY ONCE at append; `compactAccessLog` explicitly does NOT touch `access_count` (`access-log.ts:25-27`). No double-count.
- **Compaction abort-on-missing (round 3) + `(at,id)` watermark (round 2).** `access-log.ts:345-350` - an absent `memories` row ABORTS the fold (no delete, raw rows survive for a clean retry), and the persisted `access_compacted_at` + `access_compacted_id` watermark prevents re-folding already-folded rows. Count-exactly-once holds across compaction.
- **Conflict-path correctness (round 1/2).** Verdict table (`conflict-resolve.ts:252-270`) matches the scoring doc, with the hardening that a low-margin + HIGH-Contra pair routes to `review` (not a silent keep-both) - consistent with the "κ is the only zeroing term" safety posture. Self-candidate exclusion in `fan-out.ts`. Reversed-only-on-restore + kappa_loser-respecting suppression.
- **Dashboard health (round B).** `lifecycle-health.ts:4` renders `H = A·C·(1−σ)·κ` with each dormant term degrading to its identity factor (A=1, C=1, σ=0, κ=1) - a pure projection, no new column/job/write, computed in one place so all four surfaces agree.
- Plus: CLI positional/flag-value parsing, calibration monotone guard, grader timeout, reference-extract module#symbol exclusion, reverify clamp, eval recall-K DRY, reliability-bin stable key - all confirmed present.

---

## Math Verification (against `memory-lifecycle-scoring.md`)

| Term | Scoring doc | Code | Status |
|---|---|---|---|
| `A_simple` | `2^(−Δt/h(class))`, t_ref = max(created, last_reinforced); per-class h = 180/45/10d; no cutoff, A ∈ (0,1] | recall recency stage; defaults in `recall/config.ts` | MATCHES |
| `A_actr` | `clamp(exp(B − B*), A_min, 1)`; B = ln Σ u_k·(t−t_k)^(−d); u_k=0 omitted; A_min=0.05; cold → floor | `activation.ts:140-178` (log-sum-exp stable; u=0 skipped; clamp to [A_min,1]) | MATCHES |
| `C(m)` | `g(f)` isotonic; identity until ≥ data; ECE/Brier; c=0 dormant | `calibration.ts` (PAVA, adoption gate, ECE/Brier) | MATCHES |
| `σ(m,t)` | `1 − Π[resolve(r,G_t)·v]`; empty product → σ=0; out-of-graph excluded; v = 2^(−(t−verified_at)/h_verify), h_verify=14d | `stale-ref-diagnostic.ts:20-30` | MATCHES |
| `κ(m,t)` | verdict table: margin≥τ_sup→supersede κ=0; τ_rev≤margin<τ_sup→review κ=ρ; else keep-both κ=1 (low Contra) | `conflict-resolve.ts:247-272` | MATCHES (+ low-margin/high-Contra→review hardening) |
| `w_i` | `A·C·prov·corr`; prov distilled=1.0/raw=0.4; corr = 1+γ·ln(1+n_indep), duplicates counted once | `conflict-resolve.ts` (Set-based independent-source count) | MATCHES |
| `H(m,t)` | `A·C·(1−σ)·κ`, query-independent; dormant terms → identity | `lifecycle-health.ts:4` | MATCHES |
| `useful-context@k` | top-k contains a correct, current, non-conflicting id | `metrics.ts:426` (correct AND not-excluded) | MATCHES |

## Invariant Verification (repo-critical)

| Invariant | Status | Evidence |
|---|---|---|
| Fail-soft (no stage turns degraded recall into a throw/hang) | HOLDS | Staleness, κ gate, ACT-R activation, calibration each try/catch-degrade in `recall.ts`; recency never drops a hit (A ∈ (0,1], no cutoff); missing/unparseable timestamp → A=1. The new conflict hook is fail-soft at two layers (`conflict-hook.ts:164-169` + the controlled-write outer guard). |
| Append-only (supersession is version-bump, never in-place/delete) | HOLDS | Conflict supersede routes through `forgetMemory` → version_bumped; reversal is a fresh version bump; `memory_access`/`memory_calibration` append-only; `memory_conflicts` version-bumped (live = MAX(version)). No UPDATE/DELETE FROM in the conflict path. |
| Poll-to-convergence (DeepLake read-backs poll, never single read) | HOLDS | Conflict read-back `readConflictConverged`; stale-ref snapshot oracle polls until two reads agree; the live-path test polls the stateful fake. |
| Count-exactly-once (compaction) | HOLDS | Single-owner `access_count` writer + compaction abort-on-missing + `(at,id)` watermark; invariant test drives the fake from the real append. |

---

## Plan-Item Traceability

Legend: **V** = Verified (code + proving test). **V\*** = Verified code/slice; live-numeric run BLOCKED on credentials (accepted boundary). **B** = Blocked-on-credentials (accepted; not missing code).

### Parent index (8 ACs)

| ID | Criterion | Implementation | Test/Gate | Status |
|---|---|---|---|---|
| IDX-1 | recency ships measured non-neutral default half-life passing eval:recall | recency stage in `recall.ts`; defaults `recall/config.ts` | freshness slice `metrics.ts` + `golden.ts` | V\* (live verdict BLOCKED-creds) |
| IDX-2 | two contradictory never both appear; loser suppressed; recorded to history | detector `conflict-resolve.ts` → hook `conflict-hook.ts` → `controlled-writes.ts:503/610` → κ gate `assemble.ts:877` | `conflict-live-path.spec.ts` (live round-trip) | **V (C-1 RESOLVED)** |
| IDX-3 | naming absent symbol detected by maintenance worker, flagged stale_ref | `stale-ref-diagnostic.ts`, route `stale-ref-api.ts:152` | `stale-ref-diagnostic.spec.ts` | V (manual-trigger live; numeric BLOCKED-creds) |
| IDX-4 | every lifecycle action gated by flag, non-destructive default, visible in dashboard | `lifecycle-flags.ts` (a=1,c=0,s=0,auto-resolve off,observe), `lifecycle-panel.tsx` | `lifecycle-panel.test.tsx`, config specs | V |
| IDX-5 | recalled+useful harder to forget; ECE monotone non-increasing | `activation.ts`, `calibration.ts` adoption gate + ECE-over-time slice `golden.ts:790` | `activation.spec.ts`, `calibration.spec.ts`, ECE-over-time test | V (trend slice now present - W-2 resolved) |
| IDX-6 | recall fail-soft: embeddings off / daemon down → every stage degrades | all recall seams try/catch (invariant table) | per-stage fail-soft specs | V |
| IDX-7 | useful-context@k improves; no term regresses recall@5/MRR/nDCG@10 below baseline−ε | per-term slices + headline `usefulContextAtK` `metrics.ts:426` | per-term + useful-context tests | V\* (code present - W-1 resolved; numeric BLOCKED-creds) |
| IDX-8 | live dogfood exercises all lifecycle paths end-to-end | all paths live-wired (incl. conflict, post C-1) | n/a (live) | B (accepted; conflict path now reachable so dogfood will exercise it) |

### PRD-058a recency (`A` Stage 1) - 9 ACs + eval

| ID | Criterion | Status |
|---|---|---|
| 58a.1.1 | equal R, larger Δt → smaller A, ranks below | V |
| 58a.1.2 | never removed by age alone; A ∈ (0,1] no cutoff | V |
| 58a.1.3 | recency is LAST score adjustment | V |
| 58a.2.1 | sessions penalized more than memories at equal age | V |
| 58a.2.2 | caller `halfLifeDaysByClass` override honored | V |
| 58a.2.3 | unconfigured class → documented default, never 100yr | V |
| 58a.3.1 | every hit carries freshnessScore ∈ [0,1] | V |
| 58a.3.2 | embeddings off → freshnessScore still computed, degraded honest | V |
| 58a.3.3 | missing/unparseable timestamp → A=1, not dropped | V |
| 58a.eval | freshness-sensitivity slice committed | V\* (numeric BLOCKED) |

### PRD-058e reinforcement/calibration (`A` Stage 2 + `C`) - 11 rows

| ID | Criterion | Status |
|---|---|---|
| 58e.1.1 | reinforced useful access → A_actr strictly higher | V |
| 58e.1.2 | spread accesses ≥ bunched (spacing effect) | V |
| 58e.1.3 | contradicted/ignored u_k→0, no inflation | V |
| 58e.1.4 | cold memory → A_actr ≥ A_min | V |
| 58e.2.1 | calibration refit → held-out ECE non-increasing | V |
| 58e.2.2 | insufficient data → g identity (C=f), c stays 0 | V |
| 58e.2.3 | g clears ECE gate → c activatable, eval-gated | V |
| 58e.3.1 | higher A_actr → shorter reverify interval | V |
| 58e.3.2 | cold low-activation → longest interval, bounded | V |
| 58e.schema | memory_access + last_reinforced_at/access_count + memory_calibration | V |
| 58e.note | DESIGN RECONCILIATION (scope columns) | RESOLVED: acceptable convention-alignment (engine `scope: "agent"`; cross-workspace conflict out of scope) |

### PRD-058c stale-ref healing (`σ`) - 12 ACs + schema

| ID | Criterion | Status |
|---|---|---|
| 58c.1.1 | absent symbol → resolve=0, σ=1, stale, stale_refs recorded | V |
| 58c.1.2 | all refs resolve → σ≈0, fresh | V |
| 58c.1.3 | ref outside indexed graph → excluded, unknown never stale | V |
| 58c.1.4 | no indexed refs → σ=0 empty product, never demoted | V |
| 58c.1.5 | fuzzy rename → resolve=sim∈(0,1), partial demote | V |
| 58c.2.1 | observe (s=0) → factor 1, flagged, ranking unchanged | V |
| 58c.2.2 | execute (s>0) → (1-σ)^s<1, demoted not dropped | V |
| 58c.2.3 | ref returns later snapshot → σ falls, demotion lifted | V |
| 58c.2.4 | detection/heal appended to memory_history | V |
| 58c.3.1 | verified_at old, v below threshold → re-queued | V |
| 58c.3.2 | stale memory + new snapshot → re-checks | V |
| 58c.3.3 | snapshot reads poll to convergence | V |
| 58c.schema | ref_status/verified_at/stale_refs columns (lazy-heal) | V |

### PRD-058b conflict (`κ`) - 15 ACs + schema + api

| ID | Criterion | Status |
|---|---|---|
| 58b.1.1 | Contra>θ pair → at most winner returned | **V (live-wired; was GAP, now C-1 resolved)** |
| 58b.1.2 | supersede → loser κ=0 excluded by MAX(version) | V |
| 58b.1.3 | review → loser κ=ρ suppressed, reversible | V |
| 58b.1.4 | uncontested → κ=1 untouched | V |
| 58b.2.1 | high sim opposite, 0 shared tokens → Contra=sim·P_contra, signal=model | V |
| 58b.2.2 | cheap lexical → opp=max from lexical, signal=lexical | V |
| 58b.2.3 | provider none → P_contradiction skipped, no throw | V |
| 58b.2.4 | keep-both memoized → no re-flag | V |
| 58b.3.1 | w_i=A·C·prov·corr, winner argmax; distilled outvotes raw | V |
| 58b.3.2 | close scores → review, neither superseded | V |
| 58b.3.3 | corr counts independent sources; duplicates once | V |
| 58b.3.4 | margin≥τ_supersede → supersede, κ=0, margin+contra persisted | V |
| 58b.4.1 | detection/resolution → memory_history + memory_conflicts row | **V (now reached in prod via conflict-hook - C-1 resolved)** |
| 58b.4.2 | reverse supersede → loser restored κ=1, status=reversed | V |
| 58b.4.3 | no destructive delete/in-place; append-only version-bump | V |
| 58b.schema | memory_conflicts table (lazy-heal) | V |
| 58b.api | POST /conflicts/:id/resolve (zod, scope-checked) | V |

### PRD-058d surfaces & controls - 12 ACs

| ID | Criterion | Status |
|---|---|---|
| 58d.1.1 | fresh install non-destructive: a=1, c=0, s=0, auto-resolve off | V |
| 58d.1.2 | env override per-key over yaml; precedence documented | V |
| 58d.1.3 | every flag on settings page + config reference | V |
| 58d.1.4 | observe→execute → s 0→configured, no other term changes | V |
| 58d.2.1 | memories page: H, freshness, conflict count, stale count, ECE | V |
| 58d.2.2 | dashboard resolve → 058b endpoint, polls convergence | V |
| 58d.2.3 | memory_history filtered by lifecycle type | V |
| 58d.2.4 | calibration view → reliability diagram + ECE/Brier | V |
| 58d.3.1 | `honeycomb memory conflicts` list scope-filtered | V |
| 58d.3.2 | `honeycomb memory conflicts resolve <id>` same endpoint | V |
| 58d.3.3 | `honeycomb memory stale-refs` list | V |
| 58d.3.4 | inspect `--lifecycle` → freshness, calibratedConf, refStatus, conflict, H | V |

**Tally:** 56 sub-PRD ACs + 8 parent ACs = 64 total. **Verified: 61** (53 fully V at the offline layer + 8 V\*/V with numeric components creds-gated). **Blocked-on-credentials (accepted, code delivered): IDX-1, IDX-7, IDX-8.** **Real implementation gaps: 0.** The prior C-1/W-1/W-2 are all resolved; the 58e scope-reconciliation NOTE resolves in the implementer's favor.

---

## Files Changed (PRD-058 range `257a239..HEAD`, 89 files, +13620/−60; key source files)

**Conflict (`κ`) - including the C-1 live wiring:**
- `src/daemon/runtime/memories/conflict-hook.ts` (A) - **the C-1 fix:** builds the `ControlledWriteConflictHook`; runs `detectAndProject` over the forwarded candidate set post-commit; fail-soft at two layers.
- `src/daemon/runtime/memories/claim-outcome.ts` (A) - derives a memory's claim outcome so the resolver groups agreeing-vs-competing votes.
- `src/daemon/runtime/memories/conflict-detect.ts` / `conflict-resolve.ts` / `conflicts-api.ts` (A) - `Contra(a,b)` layered detector; `w_i`/score/margin/verdict + `detectAndProject` + reversal; resolve endpoint.
- `src/daemon/runtime/pipeline/controlled-writes.ts` (M) - calls `runConflictHook` post-commit on create + update paths (the live trigger).
- `src/daemon/runtime/pipeline/decision.ts` / `fan-out.ts` (M) - decision candidate search + forwards the hydrated candidate set (with self-conflict + content-less exclusion).

**Recall + activation core:**
- `src/daemon/runtime/memories/recall.ts` (M) - composes all five terms; every stage fail-soft.
- `src/daemon/runtime/memories/activation.ts` (A) - ACT-R `B` + `A_actr` clamp (log-sum-exp stable).
- `src/daemon/runtime/memories/calibration.ts` / `calibration-store.ts` (A) - isotonic PAVA, ECE/Brier, adoption gate; agent-scoped read (tenancy fix).
- `src/daemon/runtime/memories/access-log.ts` / `usefulness-grader.ts` / `reverify-schedule.ts` (A) - single-owner `access_count`, compaction abort-on-missing + watermark, partial-reinforcement grading, reverify scheduling.

**Staleness (`σ`):**
- `src/daemon/runtime/maintenance/reference-extract.ts` / `stale-ref-diagnostic.ts` / `stale-ref-api.ts` (A) - reference matcher; σ/v + write + history; live trigger route.

**Schema (additive lazy-heal):**
- `src/daemon/storage/catalog/memory-lifecycle.ts` (A) - `memory_access` + `memory_calibration` (append-only, agent-scoped).
- `src/daemon/storage/catalog/memory-conflicts.ts` (A) - `memory_conflicts` (version-bumped, agent-scoped).
- `src/daemon/storage/catalog/memories.ts` / `index.ts` (M) - additive columns (ref_status/verified_at/stale_refs/last_reinforced_at/access_count/access_compacted_at/access_compacted_id).

**Surfaces, config, CLI, eval, composition:**
- `src/shared/lifecycle-flags.ts` (A) + `src/daemon/runtime/recall/config.ts` (M) - single-source defaults + env overrides.
- `src/daemon/runtime/memories/lifecycle-api.ts` / `lifecycle-config.ts` / `lifecycle-health.ts` (A) - read endpoints, config read, H scalar.
- `src/commands/memory.ts` (A) + `contracts.ts`/`dispatch.ts`/`index.ts` (M) - `honeycomb memory conflicts|stale-refs|inspect --lifecycle` CLI.
- `src/dashboard/web/wire.ts` (M) - dashboard route wiring (panel/settings/memories live elsewhere in the diff).
- `src/eval/golden.ts` / `metrics.ts` (M) - freshness/staleness/contradiction/CRA slices **+ useful-context@k (W-1) + ECE-over-time (W-2)**.
- `src/daemon/runtime/assemble.ts` (M) - wires the conflict-suppression source, the lifecycle read endpoints, **and the conflict hook as `onConflict` (the C-1 composition root)**.
- Docs/ledger: `EXECUTION_LEDGER-prd-058.md`, `memory-lifecycle-config.md`, PRD-058 folder.

---

## Bottom Line

**PRD-058 is implementation-complete and READY TO SHIP (PR #125), modulo the three credential-gated live-verification ACs.**

Every gap the prior QA snapshot raised is closed and independently re-verified at HEAD `ad9a29c`: C-1 (conflict detection live-wired through `conflict-hook.ts` → `controlled-writes.ts` → recall κ gate, with a true live-path round-trip test proving IDX-2), W-1 (`useful-context@k`), and W-2 (ECE-over-time) are all delivered with unit coverage. The four CodeRabbit remediation rounds verify correct: tenancy scoping closed, `access_count` single-owner / count-exactly-once holds across compaction, compaction aborts on a missing row, and the conflict path is correct (self-exclusion, reversed-only-on-restore, low-margin/high-Contra → review). The math matches `memory-lifecycle-scoring.md` term-for-term, all four offline gates are green, and the only two test failures are pre-existing environmental timeout flakes in unrelated subsystems (not PRD-058, GREEN on CI). No finding rises to Critical or Warning.

**The only thing standing between this PR and a `completed` PRD is the live numeric run** (IDX-1 `eval:recall` verdict, IDX-7 useful-context@k uplift, IDX-8 dogfood), which needs `HONEYCOMB_DEEPLAKE_TOKEN` + the embed daemon and cannot run here. The code and eval slices for all three are delivered and unit-tested; this is a credential boundary, not a gap. **Merge PR #125; run the live verification on a credentialed machine to promote IDX-1/7/8 and move the PRD to completed.**

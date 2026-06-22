# EXECUTION LEDGER — PRD-007 Retrieval

> /the-smoker run. Legend: OPEN · DONE · VERIFIED · BLOCKED. Branch `prd-007-retrieval` off main (PRD-001..006 + CI merged). PR → main.

**Scope:** `library/requirements/in-work/prd-007-retrieval` (index + 007a..007e). Effort XL. The five-phase recall engine: collect (IDs only) → traverse → authorize → shape → gate.
**Builds on:** PRD-002 vector/sql/escaping, PRD-003 catalog (`memories`, `agents` read_policy, graph tables), PRD-006 (memories written; 006b decision built a focused hybrid lookup 007 generalizes). PRD-008 ontology control plane NOT built — 007b traverses the EXISTING graph catalog tables; claim-slot/ontology-specific bits scoped to what exists. Embed client (005b) + user-prompt-submit hook (PRD-004) are seams. Live DeepLake wired.

## Verification posture
Vitest: fake transport (assert the emitted scoped SQL + escaping + IDs-only), fake embed (vector channel + degrade-to-lexical), fake reranker (timeout-safe). **The authorization clause builder (007c) is the security chokepoint** — adversarially tested. Opt-in LIVE: candidate collection (FTS/vector over real `memories`) + the authorization re-query. **Up to authorization only IDs move; content-bearing stages run strictly on authorized rows** — verified.
Out of scope: the pipeline that writes memories (006), the VFS browse surface (referenced), embed daemon hosting.

## Resolved decisions (defaults)
| # | Q | Decision |
|---|---|---|
| D-1 | over-fetch multiplier | 3x (PRD-002e default) |
| D-2 | hint cap / keyword expansion | ≤3 hint-only candidates; keyword expansion OFF by default |
| D-3 | traversal budgets | aspects/entity 10, attrs/aspect 20, branching 5, total IDs 100; edge strength×confidence ≥ 0.3; hard timeout 500ms |
| D-4 | reranker | embedding-cosine default (timeout 300ms, keep original order on timeout); LLM rerank opt-in |
| D-5 | dampening factors | gravity/hub/resolution documented defaults; rehearsal boost bounded, on by default, "recent" = 7d |
| D-6 | min injection score | 0.6 default, per-agent tunable |
| D-7 | read policies | `isolated` (own), `shared` (workspace-global + own), `group` (same policy_group global + own); all exclude archived; malformed agent → `isolated` + structured error (fail-closed) |

## Scaffold/seam plan
Wave 1 builds: recall config, the `Candidate`/merged-pool/provenance contracts, the **shared ScopeClauseBuilder** (the auth chokepoint — built in Wave 1 so 007c/d/e + live tests reuse it), the recall-engine harness, AND 007a candidate collection. Pre-wires stubs for 007b/c/d/e. Wave 2's 4 Bees fill one phase module + test each.

---

## AC Ledger (35 ACs)

### 007a Candidate Collection — Wave 1 (`retrieval-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| a-AC-1 | FTS → BM25-style 0-1 scores, IDs only, no content. | VERIFIED |
| a-AC-2 | Vector → GPU similarity over 768-dim cols, over-fetch for scoped recalls. | VERIFIED |
| a-AC-3 | Embed daemon off → vector channel skipped, lexical candidates returned, no error. | VERIFIED |
| a-AC-4 | Hints channel → matches capped (a memory can't ride in on hints alone). | VERIFIED |
| a-AC-5 | Multi-channel merge by memory ID, strongest calibrated score wins unless blended. | VERIFIED |
| a-AC-6 | Raw query escaped via helpers; original NL string preserved for vector path. | VERIFIED |
| a-AC-7 | Per-channel provenance attached; no content row loaded. | VERIFIED |

### 007b Graph Traversal — Wave 2 (`retrieval-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| b-AC-1 | Focal resolution order: pinned→checkpoint→project-path→entity-FTS→session-key. | VERIFIED |
| b-AC-2 | Graph disabled → traversal skipped, no candidates, no error. | VERIFIED |
| b-AC-3 | Walk honors caps (aspects, attrs, branching, total IDs). | VERIFIED |
| b-AC-4 | Low strength×confidence edge → not followed. | VERIFIED |
| b-AC-5 | Active constraint under a focal entity → surfaced despite caps. | VERIFIED |
| b-AC-6 | Timeout → returns collected IDs with timeout flag, not failure. | VERIFIED |
| b-AC-7 | Returns IDs+scores+paths, constraints, entity count, timeout flag; no content. | VERIFIED |

### 007c Authorization — Wave 2 (`retrieval-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| c-AC-1 | Re-query with org/workspace partition + agent read-policy clause + caller filters. | VERIFIED |
| c-AC-2 | `isolated` agent → only own non-archived survive. | VERIFIED |
| c-AC-3 | `group` agent → same-policy_group global + own, archived excluded. | VERIFIED |
| c-AC-4 | Unauthorized candidate dropped before any content load. | VERIFIED |
| c-AC-5 | Malformed agent id → falls back to `isolated` + structured error, never wider. | VERIFIED |
| c-AC-6 | Buggy inner clause → storage partition still prevents cross-workspace surfacing. | VERIFIED |
| c-AC-7 | VFS browse → same scope clause authorizes rows before content returns. | VERIFIED |

### 007d Shaping — Wave 2 (`retrieval-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| d-AC-1 | Convolution: no single channel dominates; facet coverage prefers broader. | VERIFIED |
| d-AC-2 | Reranker timeout → keep original order, not failure. | VERIFIED |
| d-AC-3 | Superseded claim → downweighted (group_key+claim_key) so current value outranks. | VERIFIED |
| d-AC-4 | Semantic hit sharing no query terms → gravity-dampened. | VERIFIED |
| d-AC-5 | Result off a very high-degree entity → hub-dampened. | VERIFIED |
| d-AC-6 | Decision/constraint memory → resolution-boosted. | VERIFIED |
| d-AC-7 | Calibrated scores preserved for the gate; no unauthorized row introduced. | VERIFIED |

### 007e Confidence Gate — Wave 2 (`retrieval-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| e-AC-1 | Inject only if reranker-calibrated top score clears the minimum. | VERIFIED |
| e-AC-2 | Calibrated scores preserved from shaping, not synthesized from rank. | VERIFIED |
| e-AC-3 | Nothing clears minimum → empty injection as a valid answer, not failure. | VERIFIED |
| e-AC-4 | Hydrate under same scope filter; caller limit caps primary results. | VERIFIED |
| e-AC-5 | Access tracking updates only primary results. | VERIFIED |
| e-AC-6 | Supplementary cards marked synthetic, distinguishable from ordinary rows. | VERIFIED |
| e-AC-7 | Per-agent threshold override applied. | VERIFIED |

### Index roll-ups
| Index AC | Satisfied by | Status |
|---|---|---|
| AC-1 channels → IDs only, merge by ID, strongest wins | a-AC-1,5,7 | VERIFIED |
| AC-2 authorize re-query before content-bearing stages | c-AC-1,4 | VERIFIED |
| AC-3 currentness downweights superseded | d-AC-3 | VERIFIED |
| AC-4 gate injects only above min; empty = valid | e-AC-1,3 | DONE |

**Totals:** 35 ACs · **35 VERIFIED** · 0 OPEN — fully VERIFIED (collection + authz live-proven), close-out unlocked.

---

## Wave plan
```
Wave 1 (007a + scaffold + ScopeClauseBuilder + stubs) ──► Wave 2 (007b ‖ 007c ‖ 007d ‖ 007e) ──► Wave 3 (security → quality) ──► Ship
```
- Wave 1 · `retrieval-worker-bee` · **opus** — recall config, Candidate/merge contracts, the shared **ScopeClauseBuilder** (auth chokepoint), recall-engine harness, 007a collection (FTS+vector+hints+merge, IDs-only, escaped). Pre-wires 007b/c/d/e stubs. + opt-in live collection test.
- Wave 2 · 4 parallel `retrieval-worker-bee` — 007b traversal (**sonnet**), 007c authorization (**opus**, security boundary; + live re-query test), 007d shaping (**opus**), 007e gate (**sonnet**).
- Wave 3 · `security-worker-bee` (opus, audit the authorization boundary hard) → `quality-worker-bee` (sonnet).

Wave 1 fixes contracts + the clause builder → 007b/c/d/e parallel.

## Watchdog / event log
- PRD-007 moved→in-work, branched off main (PRD-001..006 + CI merged).
- Wave 1 (007a+scaffold+ScopeClauseBuilder) → retrieval (opus). 35 recall tests (403 total), live collection 2/2. a-AC VERIFIED. Wave 2 dispatched (4 parallel).
- Wave 2 (4 parallel retrieval): 007b traversal (sonnet,15)+007c authorization (opus,15 unit+2 LIVE)+007d shaping (opus,13)+007e gate (sonnet,16). Orchestrator verify: ci=0 (462 tests), build/audit green, live 18/18 (recall-collection 2/2 + recall-authz 2/2). → b/c/d/e+index VERIFIED. All 35 ACs VERIFIED. Wave 3 dispatched.
- security (opus): 2 High FIXED — hand-rolled SQL escapes in traversal focal builders (project filter + entity FTS) left LIKE wildcards live + slipped audit:sql → canonical sqlLike. Auth boundary verified clean (scope-clause can't widen, fail-closed, group-from-roster, partition-beneath); IDs-only-until-authorized (content only post-auth in gate). L-1 transport echo + audit:sql pre-built-const gap = follow-ups. ci=0 (462), build/audit:sql/openclaw green, npm audit 0, live 18/18. Report: reports/2026-06-17-security-report.md. quality dispatched.
- quality (sonnet): **PASS** — 35/35 ACs + 4 index PASS, live 18/18, security thesis confirmed end-to-end (IDs-only-until-authorized; scope-clause single chokepoint; partition-beneath). 3 non-blocking Suggestions (barrel export asymmetry, audit:sql pre-built-const gap, transport echo). Report: reports/2026-06-17-qa-report.md. Both gates clean → loop terminates.
- **Ship:** PR → main.

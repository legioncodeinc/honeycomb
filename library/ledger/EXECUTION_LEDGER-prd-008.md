# EXECUTION LEDGER — PRD-008 Knowledge Graph Ontology

> /the-smoker run. Branch `prd-008-knowledge-graph-ontology` off main (PRD-001..007 + CI merged). PR → main.

**Scope:** index + 008a (entity model + inline linker) / 008b (dependencies + append-only supersession) / 008c (control plane: proposals, apply, assertions, CLI). 21 ACs. The ontology = a derived, rebuildable index over memories (provenance back to them), daemon the only writer.
**Builds on:** PRD-003b graph catalog (`entities`, `entity_aspects`, `entity_attributes`, `entity_dependencies`, `memory_entity_mentions`, `epistemic_assertions`, `ontology_proposals` — ALL exist), PRD-002 `appendVersionBumped` + escaping, PRD-006d (the bulk graph WRITER — 008 owns the entity model + control plane, NOT the bulk extraction write), PRD-006 ModelClient seam (conflict-detection LLM fallback), PRD-007b consumes traversal. CLI stub `src/cli`. Live DeepLake wired.

## Verification posture
Vitest: fake transport (assert version-bumped supersede SQL, edge threshold, slot keys, scope, escaping), fake model (conflict LLM fallback off by default). Opt-in LIVE: append-only supersession against real `entity_attributes` (highest-version read — the proven-reliable pattern), proposal apply. Out of scope: PRD-006d bulk write, PRD-007 traversal/shaping, the dreaming-loop reshaping.

## Decisions (defaults)
| # | Q | Decision |
|---|---|---|
| D-1 | entity types | the fixed FR-1 set (person/project/system/tool/concept/skill/task/source/artifact/agent/policy/action/workflow/event/object_type/interface/observation/claim_slot/claim_value/unknown) |
| D-2 | proper-noun detection (linker, model-free) | capitalized multi-word token scan + exact match against EXISTING agent entity names; creates nothing, no model, no net I/O |
| D-3 | aspect weighting | confirm → +; stale beyond window (30d) → decay toward floor (0.1) |
| D-4 | edge threshold | strength×confidence ≥ 0.3 (matches 007b) |
| D-5 | conflict detection | lexical overlap + negation/antonym tokens; LLM fallback via ModelClient seam, OFF by default |
| D-6 | risk routing (control plane) | bounded explicit single-entity/attr ops (create/set/add/supersede-one) apply directly + applied row; merge/archive/destructive/broad/generated-batch → pending review queue |
| D-7 | constraints | NOT auto-superseded; replacing a constraint requires a deliberate control-plane op |

## Scaffold/seam plan
Wave 1: ontology contracts (EntityRef, Aspect, AttributeSlot {group_key,claim_key}, Proposal, Assertion), the entity-model module + the inline linker (008a), + the shared supersede-by-version-bump helper signature. Pre-wire 008b/008c stubs. Wave 2 fills 008b ‖ 008c (both use the PRD-002 version-bump primitive + the Wave-1 contracts, parallel-safe).

---

## AC Ledger (21 ACs)

### 008a Entity Model + Linker — Wave 1 (`deeplake-dataset-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| a-AC-1 | Inline linker scans proper nouns, links to EXISTING agent entities, creates nothing, no model. | VERIFIED |
| a-AC-2 | Linker does no network I/O; safe right after memory commit (synchronous). | VERIFIED |
| a-AC-3 | Attribute carries kind, status, confidence, importance, version lineage, provenance (memory+proposal). | VERIFIED |
| a-AC-4 | Aspect weight rises on confirm, decays toward floor on stale. | VERIFIED |
| a-AC-5 | Claim value lives in an addressable group_key/claim_key slot under its aspect. | VERIFIED |
| a-AC-6 | Every write scoped by org/workspace/agent_id; linker never links across agent boundary. | VERIFIED |
| a-AC-7 | Every interpolated name/key/value escaped through the SQL helpers. | VERIFIED |

> Wave 1 evidence: `tests/daemon/runtime/ontology/entity-model.test.ts` (19 AC-named tests),
> `supersede.test.ts` (6), `stubs.test.ts` (10) — 35/35 green. Shared core
> `supersedeClaim` implemented in `src/daemon/runtime/ontology/supersede.ts`. Contracts in
> `contracts.ts`. 008b/008c stubs pre-wired + `ontology/CONVENTIONS.md`. Opt-in LIVE
> supersede smoke at `tests/integration/ontology-supersede-live.itest.ts` (gated). Gates:
> `npm run ci` (497 pass), `build`, `audit:openclaw`, `audit:sql` all green.

### 008b Dependencies + Supersession — Wave 2 (`deeplake-dataset-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| b-AC-1 | New attr in same slot → conflicting sibling marked superseded (status+superseded_by via version-bump append), not deleted/mutated. | VERIFIED |
| b-AC-2 | Concurrent edits → no in-place mutate; full version history on disk. | VERIFIED |
| b-AC-3 | Loose `related_to` edge carries type, strength, confidence, required reason. | VERIFIED |
| b-AC-4 | Edge followed only when strength×confidence clears threshold. | VERIFIED |
| b-AC-5 | Constraint → NOT auto-superseded on a conflicting value. | VERIFIED |
| b-AC-6 | Conflict detection uses lexical overlap + negation/antonym (+ optional LLM fallback). | VERIFIED |
| b-AC-7 | Every write escaped + through the daemon. | VERIFIED |

### 008c Control Plane — Wave 2 (`deeplake-dataset-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| c-AC-1 | Bounded explicit op → applies directly + applied proposal row, evidence copied onto resulting rows. | VERIFIED |
| c-AC-2 | Broad/risky/generated batch → pending review queue (not applied). | VERIFIED |
| c-AC-3 | Structural change → raw source artifacts/transcripts NEVER rewritten. | VERIFIED |
| c-AC-4 | Supersede op → append-only version-bumped, not in-place. | VERIFIED |
| c-AC-5 | Epistemic assertion carries predicate/content/speaker/confidence/evidence/status; no auto-promote into truth. | VERIFIED |
| c-AC-6 | Proposal carries operation/status/jsonb payload/confidence/rationale/evidence/risk_note/provenance. | VERIFIED |
| c-AC-7 | CLI (`stream apply --dry-run`) scoped by org/workspace/agent; reports plan without mutating on dry-run. | VERIFIED |

### Index roll-ups
| Index AC | by | Status |
|---|---|---|
| AC-1 inline linker model-free no-IO | a-AC-1,2 | VERIFIED |
| AC-2 supersede append+mark-prior | b-AC-1 | VERIFIED |
| AC-3 related_to reason + threshold | b-AC-3,4 | VERIFIED |
| AC-4 bounded apply vs pending queue | c-AC-1,2 | VERIFIED |

**Totals:** 21 ACs · **21 VERIFIED** · 0 OPEN — fully VERIFIED (supersede append-based, live-deterministic), close-out unlocked.

## Wave plan
```
Wave 1 (008a + contracts + supersede helper + stubs) ──► Wave 2 (008b ‖ 008c) ──► Wave 3 (security → quality) ──► Ship
```
- Wave 1 · `deeplake-dataset-worker-bee` opus — ontology contracts, 008a entity model + inline linker, supersede-helper signature, 008b/008c stubs.
- Wave 2 · 2 parallel `deeplake-dataset-worker-bee` — 008b deps+supersession (opus, + live supersession test), 008c control plane + CLI (opus, + live apply test).
- Wave 3 · `security-worker-bee` (opus) → `quality-worker-bee` (sonnet). Security: SQL injection via entity names/proposal payloads, scope on every graph write, constraint-not-auto-superseded (integrity), the apply path can't bypass the review queue for risky ops, no raw-artifact rewrite.

## Watchdog / event log
- PRD-008 moved→in-work, branched off main (PRD-001..007 + CI merged).
- Wave 1 DONE: ontology contracts + `supersedeClaim` shared core + 008a (entity model +
  inline linker) + 008b/008c stubs + CONVENTIONS.md. a-AC-1..7 VERIFIED (35 ontology tests,
  497 total green). Gates ci/build/audit:openclaw/audit:sql green. Wave 2 (008b ‖ 008c) is
  contention-free: both fill their stub + test, reuse `supersedeClaim`, touch no shared file.
- Wave 2: 008b deps+supersession (opus,23) + 008c control-plane+CLI (opus,21+live). Unit ci=0 (542). LIVE: 008a supersede 1/1✓, 008c apply 1/1✓, but 008b supersede-on-conflict FAILS (active=2 expected 1 — the in-place UPDATE mark-prior-superseded in supersede.ts doesn't land live; the queue/graph-persist UPDATE-trap). b/c VERIFIED except b-AC-1/b-AC-2 reopened (live-FAIL). Dispatching serialized opus fix → append-based mark + current-state-per-id reads.
- supersede live-fix (opus): in-place UPDATE mark → append-based (appendPriorSuperseded: append prior id v+1 status=superseded) + highest-version-per-id reads. Orchestrator verify: unit ci=0 (542); ontology live 3/3 consecutive (supersede+deps+apply, 4 tests). → b-AC-1/2 + index VERIFIED. All 21 VERIFIED. Follow-up: 007d currentness highest-version read for live. Wave 3 dispatched.
- security (opus): 0 Critical/High, no code changes. Affirmative proof: injection guarded across 5 modules + CLI (CLI builds no SQL), scope mandatory + cross-agent unreachable, routeProposal allow-list can't be bypassed (zod rejects NaN/Inf confidence), constraint-not-auto-superseded, no raw-artifact rewrite, dry-run can't mutate. L1 (audit:sql doesn't scan src/cli — no SQL there today) + L2 (empty agentId→'default') documented. ci=0 (542), build/audit green, npm audit 0. Report: reports/2026-06-17-security-report.md. quality dispatched.
- quality (sonnet): CLEAN TO SHIP — 21/21 ACs PASS, supersede fix genuine (append-only, zero UPDATEs, live-proven), no scope creep, no Medium+ findings. 1 Warning (proposal_id column deferred, forward-compatible) + 2 Suggestions. Report: reports/2026-06-17-qa-report.md. **RUN COMPLETE: 21/21 VERIFIED, shipped.**

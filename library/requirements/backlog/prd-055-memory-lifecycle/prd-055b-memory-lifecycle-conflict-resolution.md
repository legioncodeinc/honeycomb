# PRD-055b: Semantic conflict detection and resolution

> **Parent:** [PRD-055 Memory Lifecycle](./prd-055-memory-lifecycle-index.md)
> **Implements:** the `κ(m,t)` term of [`memory-lifecycle-scoring.md`](../../../knowledge/private/ai/memory-lifecycle-scoring.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** L
> **Schema changes:** Additive (one new `memory_conflicts` table, lazy-healed; appends to existing `memory_history`)

---

## Phase Overview

### Goals

This sub-PRD implements the conflict gate `κ(m,t)`, the only multiplicative gate in the master equation and the only term that can drive retrieval priority to exactly zero. Every other lifecycle factor (`A`, `C`, `1 − σ`) is a bounded multiplier in `(0, 1]` that can demote but never exclude; a hard-superseded memory must be *excluded*, not merely demoted, so `κ` is a gate over `{0} ∪ (0,1]` and ships un-exponentiated.

Concretely: ensure an agent never receives two memories that assert contradictory outcomes for the same claim in a single recall. The decision stage today runs a lexical contradiction check (negation tokens, antonyms, lexical overlap) that gates UPDATE/DELETE and flags them for review, applying only when `autonomous.allowUpdateDelete` is set (see `memory-pipeline.md`, the controlled-writes stage). That check is write-time only, lexical-only, and produces nothing an operator can see or act on. This sub-PRD adds the contradiction-detection score `Contra(a,b)`, a weighted winner-selection over competing outcomes, a margin-driven verdict that assigns each side its `κ` value, recall-time suppression of the losing side, and a durable, reversible conflict record.

The contract with the scoring doc is exact: `κ = 1` for an uncontested memory or a conflict winner, `κ = ρ` for the losing side of an open conflict (default `ρ = 0`, reversible), and `κ = 0` for a hard-superseded loser (excluded by the same `MAX(version)` / supersession path PRD-008 already enforces). Detection and resolution never delete a row; both append to `memory_history` and project into `memory_conflicts`.

### The equation this implements

From Term 4 of the scoring model. Two memories `a`, `b` conflict when they speak to the same claim slot and assert opposite outcomes. The contradiction score is

```text
Contra(a,b) = sim(slot_a, slot_b) · opp(a,b)
opp(a,b)    = max( opp_lexical , P_contradiction )
```

- `sim` = cosine similarity of the two memories' claim-slot embeddings (same subject?).
- `opp ∈ [0,1]` = outcome opposition. `opp_lexical` is the existing negation / antonym / overlap heuristic from the decision stage; `P_contradiction` is the contradiction probability from an NLI-style judge run as the `memory_extraction`-class router workload. The `max` means either a cheap lexical hit or a semantic verdict is sufficient; neither alone is a blind spot.

A pair is flagged when `Contra(a,b) > θ_detect`. Detection runs over the candidate set the decision stage already fetches, so it costs no extra table scan.

To resolve, treat a claim slot as a variable with competing memory-evidence. Each memory `m_i` votes for outcome `o_i` with weight

```text
w_i = A(m_i,t) · C(m_i) · prov(m_i) · corr(o_i)
```

- `A` = activation from 055a / 055e (fresher, more-reinforced evidence votes harder).
- `C` = calibrated confidence from 055e (until calibrated, `C = f`, the raw confidence).
- `prov` = provenance arm-class weight, reusing the recall weighting: distilled `memory` = `1.0`, raw `session` = `0.4`.
- `corr(o)` = corroboration bonus, log-scaled over *independent* sources so duplicated rows cannot inflate a side: `corr(o) = 1 + γ · ln(1 + n_independent(o))`.

Aggregate per outcome, pick the winner by margin:

```text
score(o)  = Σ_{i : o_i = o} w_i
winner    = argmax_o score(o)
margin    = 1 − score(runner_up) / score(winner)
```

The margin selects the verdict and the `κ` assigned to the losing side:

| Margin | Verdict | `κ` for the losing side |
|---|---|---|
| `margin ≥ τ_supersede` | `supersede` (winner clearly dominates) | `0` (superseded via append-only version bump, excluded by `MAX(version)`) |
| `τ_review ≤ margin < τ_supersede` | `review` (ambiguous, human decides) | `ρ` (soft-suppress lower side, default `ρ = 0`, reversible) |
| `margin < τ_review` AND low `Contra` | `keep-both` (false positive, independent facts) | `1` (both stay live; pair memoized so it is not re-flagged) |

The winner always keeps `κ = 1`; an uncontested memory (no recorded conflict) has `κ = 1` by the empty-conflict default. `κ` multiplies the master equation un-exponentiated: `P(m | q, t) = R · A^a · C^c · (1 − σ)^s · κ`. When `κ = 0` the product is zero regardless of the other terms, which is exactly the exclusion semantics a hard supersession needs.

### Scope

- **Detection.** Compute `Contra(a,b)` over the decision-stage candidate set: the existing lexical signal (`opp_lexical`), embedding similarity of claim slots (`sim`), and an optional model-judged contradiction probability (`P_contradiction`) via the `memory_extraction` router workload. Flag when `Contra > θ_detect`.
- **Resolution.** Compute per-outcome `score(o)` from `w_i`, pick the winner, compute `margin`, and route to `supersede` / `review` / `keep-both` per the verdict table.
- **`κ` assignment.** Emit `κ ∈ {0, ρ, 1}` per memory so recall can apply it as the gate in the master equation. Persist `margin`, `contra_score`, and the deciding `signal` on the conflict row.
- **Recall-time suppression.** When two live memories are a recorded conflict pair, recall returns at most the winner: `κ = 0` losers are already excluded by supersession; `κ = ρ` (`ρ = 0`) losers are suppressed fail-soft in the recall path.
- **Audit.** Every detection and every resolution appends to `memory_history` (actor, reason, confidence) and projects into `memory_conflicts`.
- **Parameter tuning.** `θ_detect` is PR-curve tuned; `τ_supersede` / `τ_review` are CRA-tuned; `γ` and `ρ` carry their scoring-doc defaults. All ship behind the lifecycle eval gate.

### Out of scope

- Recency / activation math (`A`, sub-PRDs 055a / 055e) and stale-reference detection (`σ`, sub-PRD 055c). This sub-PRD *consumes* `A` and `C` as inputs to `w_i`; it does not compute them.
- Cross-workspace conflict detection. Conflicts are detected strictly within the same `org` / `workspace` / `agent_id` scope.
- Auto-applying destructive deletes. Resolution supersedes (append-only version bump); it never hard-deletes the losing row.
- The dashboard surface for the review queue (sub-PRD 055d renders `memory_conflicts`).

### Dependencies

- **Blocked by:** none. Reuses the PRD-008 supersession primitives (`status`, `superseded_by`, version bump) and the decision-stage contradiction helper.
- **Consumes:** `A(m,t)` (055a / 055e) and `C(m)` (055e) as the `w_i` factors. Before those land, `A` and `C` default to their identity values (`A = A_simple`, `C = f`), so `w_i` is well-defined from day one.
- **External:** model router `memory_extraction` workload for `P_contradiction` (skipped when the provider is `none`).
- **Feeds:** 055d (renders the conflict queue and the per-memory `κ` in the health scalar `H`).

---

## User Stories

### US-55b.1 - Contradictory memories do not both surface

**As an** agent, **I want** recall to never hand me "we use Drizzle" and "we migrated off Drizzle to Prisma" together, **so that** I do not act on a stale contradiction.

**Acceptance criteria:**
- AC-55b.1.1 Given two memories with `Contra(a,b) > θ_detect` recorded as a conflict pair, when a recall query matches both, then at most the winner is returned (`κ = 1` winner surfaces, loser is suppressed).
- AC-55b.1.2 Given a conflict resolved `supersede` (`margin ≥ τ_supersede`), when recall runs, then the loser carries `κ = 0` and is excluded by the same `MAX(version)` / supersession path PRD-008 already enforces.
- AC-55b.1.3 Given a conflict in `review` (`τ_review ≤ margin < τ_supersede`), when recall runs, then the losing side is suppressed with `κ = ρ` (default `ρ = 0`) and the suppression is reversible once a human resolves it.
- AC-55b.1.4 Given an uncontested memory with no recorded conflict, when recall runs, then `κ = 1` and the conflict gate leaves its priority untouched.

### US-55b.2 - Conflicts are detected semantically

**As a** memory store, **I want** to catch contradictions that share no surface tokens ("ship on Fridays" vs "we freeze deploys before the weekend"), **so that** lexical-only blind spots are covered.

**Acceptance criteria:**
- AC-55b.2.1 Given two memories in the same claim slot with high `sim` but opposite outcomes and zero shared tokens, when detection runs, then `Contra = sim · P_contradiction` clears `θ_detect` and a conflict is recorded with `signal = 'model'`.
- AC-55b.2.2 Given a cheap lexical contradiction (`opp_lexical` high), when detection runs, then `opp = max(opp_lexical, P_contradiction)` flags the pair from the lexical signal alone, with `signal = 'lexical'`, before any model call.
- AC-55b.2.3 Given the provider for the verdict workload is `none`, when detection runs, then `P_contradiction` is skipped, `opp = opp_lexical`, and candidate conflicts are still recorded (degraded, never throwing).
- AC-55b.2.4 Given a pair the policy classified `keep-both` (`margin < τ_review` and low `Contra`), when detection re-runs later, then the memoized false-positive prevents re-flagging the same normalized pair.

### US-55b.3 - The right side wins, by weighted margin

**As a** memory store, **I want** the winner chosen by evidence weight, not just recency, **so that** a well-corroborated distilled fact is not overruled by a single fresh raw row.

**Acceptance criteria:**
- AC-55b.3.1 Given competing outcomes, when resolution runs, then each memory votes with `w_i = A · C · prov · corr` and the winner is `argmax_o score(o)`, so a distilled `memory` (`prov = 1.0`) outvotes an equally-fresh raw `session` (`prov = 0.4`) at equal `A`, `C`, and corroboration.
- AC-55b.3.2 Given two outcomes whose weighted scores are close, when `margin = 1 − score(runner_up)/score(winner)` falls in `[τ_review, τ_supersede)`, then the verdict is `review` and neither side is superseded.
- AC-55b.3.3 Given one outcome backed by three duplicated rows from a single source, when `corr(o) = 1 + γ · ln(1 + n_independent(o))` is computed, then the duplicates count as one independent source and do not inflate that side's `score`.
- AC-55b.3.4 Given `margin ≥ τ_supersede`, when resolution runs, then the verdict is `supersede`, the loser gets `κ = 0`, and `margin` plus `contra_score` are persisted on the `memory_conflicts` row.

### US-55b.4 - Resolution is auditable and reversible

**As an** operator, **I want** every conflict decision recorded with its reason, actor, margin, and signal, **so that** I can audit and undo a wrong resolution.

**Acceptance criteria:**
- AC-55b.4.1 Given any detection or resolution, when it occurs, then a row is written to `memory_history` (actor, reason, confidence) and to `memory_conflicts` (normalized pair, `signal`, `verdict`, `status`, `margin`, `contra_score`, `winner_id`).
- AC-55b.4.2 Given a `supersede` resolution, when an operator reverses it, then the superseded loser is restored to live (`κ` returns to `1`) by a new append-only version bump, the conflict `status` becomes `reversed`, and the reversal is recorded to `memory_history`.
- AC-55b.4.3 Given a resolution, when it is applied, then no row is destructively deleted or mutated in place; the loser is marked through the PRD-008 append-only, version-bumped path only.

---

## Data Model Changes

| Model | Change | Type | Nullable | Default | Index |
|---|---|---|---|---|---|
| `memory_conflicts` (new) | `id` | `UUID` (PK) | no | `gen_random_uuid()` | primary |
| | `org` / `workspace` / `agent_id` | scope cols | no | - | composite index |
| | `memory_a_id` | `UUID` | no | - | index |
| | `memory_b_id` | `UUID` | no | - | index |
| | `claim_slot` | `text` | yes | null | index |
| | `signal` | `enum('lexical','embedding','model')` | no | - | no |
| | `contra_score` | `float [0,1]` | no | - | no |
| | `margin` | `float [0,1]` | yes | null | no |
| | `verdict` | `enum('supersede','keep-both','review')` | no | `'review'` | index |
| | `winner_id` | `UUID` | yes | null | no |
| | `kappa_loser` | `float` (the `κ` assigned to the loser: `0`, `ρ`, or `1`) | yes | null | no |
| | `status` | `enum('open','resolved','reversed')` | no | `'open'` | index |
| | `confidence` | `float` | no | - | no |
| | `created_at` | `timestamptz` | no | `now()` | index |

Created lazily via DeepLake's first-write schema-healing, no ahead-of-time migration and no backfill; columns added later heal in additively the same way (see `memory-pipeline.md`, lazy schema-healing). The `(memory_a_id, memory_b_id)` pair is **normalized (sorted)** so a pair is recorded once regardless of detection order, which is also what makes the `keep-both` memoization in AC-55b.2.4 stable. `contra_score`, `margin`, and `signal` are the math's audit trail: they let an operator see *why* a verdict was reached, not just what it was. Every detection and resolution event also **appends to the existing `memory_history` table** (actor, reason, confidence); `memory_conflicts` is the queryable current-state projection over that append-only log. No column is ever mutated in place; a status change is a new append plus a projection refresh, consistent with the supersession shape DeepLake requires.

---

## API / Endpoint Specs

### Internal: conflict detection (background)

Detection runs in the decision stage (over the candidate set already fetched per extracted fact) and as a maintenance-worker pass. It is daemon-internal with no public write endpoint. The detection pass computes `Contra(a,b)` for each candidate pair, and only the high-similarity opposite-outcome pairs escalate to the model verdict; the rest are decided from the free lexical + embedding signal. The whole pass is off the write path so a slow or failing model never costs the user a memory (the one pipeline rule that cannot bend).

### POST /api/memories/conflicts/:id/resolve

**Auth:** bearer token; operator scope. Scoped to the caller's `org` / `workspace` / `agent_id`; a conflict outside scope returns `404`.

**Request:**

```ts
const ResolveSchema = z.object({
  verdict: z.enum(['supersede', 'keep-both', 'review']),
  winnerId: z.string().uuid().optional(), // required when verdict = 'supersede'
  reason: z.string().max(500).optional(),
});
```

**Behavior:** a `supersede` verdict marks the non-winner via the PRD-008 append-only version bump and sets its `kappa_loser = 0`; `review` sets `kappa_loser = ρ`; `keep-both` sets `kappa_loser = 1` and memoizes the pair. Every path appends to `memory_history`.

**Response `200`:** the updated `memory_conflicts` row (including `margin`, `contra_score`, `kappa_loser`, `status`). **Errors:** `400 invalid_verdict` (or `supersede` without `winnerId`), `404 conflict_not_found`, `409 already_resolved`.

---

## Technical Considerations

- **Detection is candidate-bounded.** The decision stage already runs a hybrid search for the top few existing candidates per extracted fact (see `memory-pipeline.md`, the decision stage). Conflict detection reuses that candidate set rather than scanning the table, so `Contra` is evaluated only over a handful of pairs and the cost stays on the existing pipeline budget. No new full-table scan.
- **Cheap-first layered signal.** `opp_lexical` (free, already computed) and `sim` (free, embeddings already prefetched for the write) run first. `P_contradiction` (the model verdict) is invoked **only** for pairs whose `sim` is high and whose lexical signal is inconclusive, and is **skipped entirely** when the provider is `none`. This keeps the model spend proportional to genuine ambiguity, and `opp = max(opp_lexical, P_contradiction)` means the cheap path can flag a conflict without ever paying for the verdict.
- **Append-only supersession.** `supersede` reuses the PRD-008 supersession primitive (`status` + `superseded_by` + version bump), never an in-place UPDATE, because DeepLake's query endpoint can silently coalesce concurrent UPDATEs and drop edits (see `memory-pipeline.md` and `knowledge-graph-ontology.md`). The loser's `κ = 0` is a property of `MAX(version)` exclusion, not a deleted row, so AC-55b.4.2 reversal is just another version bump.
- **Recall-time suppression, fail-soft.** A small scope-clause addition in `buildScopeClause` / the recall path (`recall.ts`) applies the gate: `κ = 0` losers are already excluded by supersession; `κ = ρ` (`ρ = 0`) losers are filtered by the open-conflict projection. This must stay **fail-soft**: if `memory_conflicts` is missing or unreadable, recall degrades to returning both sides rather than 500-ing. The gate is the last currentness filter, layered over (not replacing) the `MAX(version)` invariant.
- **SQL safety.** The endpoint has no parameterized queries, so every interpolated value (ids, claim-slot text, scope keys) passes through `sqlStr` / `sqlLike` / `sqlIdent`, identical to the supersession path in `knowledge-graph-ontology.md`.
- **Eventual consistency.** DeepLake reads flap stale segments, so every live read-back of a freshly written conflict row (detection projecting into `memory_conflicts`, the resolve endpoint reading its own write) **polls to convergence**, never a single immediate read.
- **`κ` is the only zeroing term.** Because `κ` can be exactly `0`, the suppression logic is the highest-stakes correctness surface in 055b: a wrong `supersede` hides a correct memory entirely. That is why the default open verdict is `review` (not `supersede`), suppression is reversible, and false positives are memoized.

---

## Files Touched

### New files
- `src/daemon/runtime/memories/conflict-detect.ts` - the layered detector: `sim`, `opp_lexical`, gated `P_contradiction`, and the `Contra(a,b)` score against `θ_detect`.
- `src/daemon/runtime/memories/conflict-resolve.ts` - the weight `w_i`, per-outcome `score(o)`, `margin`, the verdict table, `κ` assignment, and PRD-008 supersession application.
- `src/daemon/runtime/memories/conflicts-api.ts` - the `POST /api/memories/conflicts/:id/resolve` endpoint (zod-validated, scope-checked).
- `tests/daemon/runtime/memories/conflict-detect.spec.ts`
- `tests/daemon/runtime/memories/conflict-resolve.spec.ts`

### Modified files
- `src/daemon/runtime/memories/recall.ts` - apply the `κ` gate: suppress `κ = ρ` losers and rely on supersession for `κ = 0`, fail-soft via `buildScopeClause`.
- the decision-stage worker (per `memory-pipeline.md`, the controlled-writes / decision handler) - call the detector on the existing candidate set.
- `src/daemon/storage/schema` source - the `memory_conflicts` ColumnDef (additive heal), including `contra_score`, `margin`, `signal`, `kappa_loser`.

---

## Test Plan

- **Unit:** `Contra = sim · max(opp_lexical, P_contradiction)` against `θ_detect`; lexical-miss semantic conflict (AC-55b.2.1); cheap-lexical flag without a model call (AC-55b.2.2); provider-`none` degraded path (AC-55b.2.3); `w_i` weighting so `prov` breaks a tie (AC-55b.3.1); `corr(o)` deduping duplicated sources (AC-55b.3.3); margin-to-verdict routing across `τ_review` / `τ_supersede` (AC-55b.3.2, 3.4); false-positive memoization on the normalized pair (AC-55b.2.4); append-only supersede + reversal (AC-55b.4.2, 4.3); uncontested `κ = 1` (AC-55b.1.4).
- **Integration:** detection over a real decision-stage candidate set; recall suppression of the `κ = ρ` / `κ = 0` loser; poll-to-convergence read-back of the projected `memory_conflicts` row.
- **Eval slice:** extend the lifecycle eval suite (the PRD-027 / 047 golden-set discipline, `npm run eval:recall`) with **Conflict Resolution Accuracy (CRA)** = fraction of labeled conflicts whose winner the policy picks correctly, and **contradiction-detection precision / recall / F1** against a labeled contradiction set. `θ_detect` is chosen from the PR curve; `τ_supersede` / `τ_review` are CRA-tuned; commit the sweep table. Conflict suppression must not regress recall@5 / MRR past `baseline − ε`.
- **Live dogfood:** against a real daemon, store a fact, then store its negation; confirm `Contra` clears `θ_detect`, the policy picks the winner, only the winner recalls, and the conflict appears in `memory_conflicts` with its `margin`, `contra_score`, and `signal`. This follows the repo norm that live dogfood catches integration bugs (route collisions, missing-table fatality, scope gaps, consistency flaps) that isolated unit mounts structurally miss.

---

## Risks and Open Questions

- **Risk:** a false-positive conflict suppresses a correct independent fact (the `κ = 0` failure mode is total exclusion). **Mitigation:** the default open verdict is `review` with reversible `κ = ρ` suppression of only the lower-weighted side, never auto-`supersede`; the `keep-both` memoization stops re-flagging; `θ_detect` is tuned on the PR curve to keep detection precision high.
- **Risk:** model-judged `P_contradiction` adds latency. **Mitigation:** detection is **off the write path** (async decision-stage / maintenance job); the verdict is candidate-bounded, invoked only for high-`sim` ambiguous pairs, and provider-gated (`none` skips it). No user-visible write ever waits on the judge.
- **Risk:** a single over-replicated source dominates the vote. **Mitigation:** `corr(o)` counts *independent* sources only, log-scaled, so duplicated rows cannot inflate `score(o)`.
- **Open question:** what canonicalizes the `claim_slot` key for non-entity facts? Start from the PRD-008 entity attribute slot (the `claim_key` / `entity_attribute` path in `knowledge-graph-ontology.md`) where available, and fall back to a normalized subject hash; refine against dogfood data. The `claim_slot` quality directly bounds `sim`, so a poor key surfaces as low detection recall in the F1 metric.

---

## Related

- [`memory-lifecycle-scoring.md`](../../../knowledge/private/ai/memory-lifecycle-scoring.md) - Term 4, the `κ(m,t)` gate and the `Contra` / `w_i` / `score(o)` / `margin` math.
- [`prd-055-memory-lifecycle-index.md`](./prd-055-memory-lifecycle-index.md) - the parent index and the sibling terms.
- [`memory-pipeline.md`](../../../knowledge/private/ai/memory-pipeline.md) - the decision stage, the existing lexical contradiction check, and the append-only / lazy-heal write rules.
- [`knowledge-graph-ontology.md`](../../../knowledge/private/ai/knowledge-graph-ontology.md) - the PRD-008 supersession and currentness model reused for `supersede`.

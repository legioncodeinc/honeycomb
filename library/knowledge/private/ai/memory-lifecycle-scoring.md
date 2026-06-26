# Memory Lifecycle Scoring Model

> Category: Ai | Version: 1.0 | Date: June 2026 | Status: Proposed (PRD-055)

The unified mathematical model behind PRD-055. Every lifecycle behavior (recency, reinforcement, confidence calibration, conflict resolution, stale-reference healing) is one term of a single **retrieval-priority** equation. This doc is the source of truth for the notation; each sub-PRD implements exactly one term and cites the equations here.

**Related:**
- [`retrieval.md`](retrieval.md) - the relevance term `R(m,q)` this model multiplies.
- [`memory-pipeline.md`](memory-pipeline.md) - where the inputs (confidence, history, access events) are produced.
- [`knowledge-graph-ontology.md`](knowledge-graph-ontology.md) - the supersession model the conflict term reuses.
- [`../data/codebase-graph.md`](../data/codebase-graph.md) - the resolution snapshot the staleness term queries.
- [`three-tier-memory-strategy.md`](three-tier-memory-strategy.md) - the tier classes the per-class parameters key on.

---

## The thesis

A store that only grows is not a memory, it is a log. Human memory is good precisely because it is *lossy in a principled way*: it lets the rarely-useful fade, strengthens what gets retrieved and confirmed, flags what it is unsure of, and reconciles contradictions instead of holding both. Honeycomb already has the durable substrate (append-only, `MAX(version)`, supersession). The lifecycle model adds the principled forgetting on top, as a soft re-ranking signal that never deletes a row. History stays total; only *salience* changes.

Design rule that follows from this: every term is a bounded multiplier in `(0, 1]` (or a gate in `{0} ∪ (0,1]`), it can only *demote* relevance, never invent it, and it ships behind an exponent that defaults to a value *measured* on the golden set. A term with exponent zero is the identity, so an unproven term ships dormant exactly as recency does today.

## The master equation

For a candidate memory `m` and query `q` at wall-clock time `t`, the retrieval priority is

```text
P(m | q, t) = R(m,q) · A(m,t)^a · C(m)^c · (1 − σ(m,t))^s · κ(m,t)
```

| Symbol | Range | Meaning | Owner |
|---|---|---|---|
| `R(m,q)` | `[0,1]` | Relevance: the existing RRF-fused, reranked, MMR-shaped score. Unchanged by PRD-055. | PRD-047 |
| `A(m,t)` | `(0,1]` | Activation / freshness: recency + access frequency + reinforcement. | 055a + 055e |
| `C(m)` | `[0,1]` | Calibrated confidence: model confidence mapped through the calibration curve. | 055e |
| `σ(m,t)` | `[0,1]` | Staleness probability: fraction of code references that no longer resolve. | 055c |
| `κ(m,t)` | `{0} ∪ (0,1]` | Conflict gate: `1` uncontested/winner, `ρ` open-conflict loser, `0` hard-superseded. | 055b |
| `a, c, s` | `≥ 0` | Per-term exponents. Default to eval-measured values; `0` makes that term neutral. | 055d (config) |

`R` is the base. Each other factor is a bounded multiplier so the whole product stays interpretable: `P ≤ R` always, with equality only when every lifecycle signal is perfect (fresh, fully-confident, no dangling refs, uncontested). The exponents `a, c, s` let the eval harness sweep each term's influence independently and ship only the influence that measurably helps. `κ` is a multiplicative gate, not exponentiated, because a hard-superseded memory must be *excluded* (`κ = 0`), not merely demoted.

The dashboard renders a single **memory health** scalar that is the query-independent part of this product:

```text
H(m,t) = A(m,t) · C(m) · (1 − σ(m,t)) · κ(m,t)
```

`H ∈ [0,1]` is "how much should this memory be trusted right now, independent of any query." It is what the lifecycle panel (055d) visualizes per memory.

---

## Term 1 - Activation `A(m,t)`

Activation answers "how salient is this memory right now," combining recency, how often it has been useful, and the spacing of those uses. The model ships in two stages: a simple, immediately-measurable exponential decay (055a), upgraded to a cognitively-grounded activation function (055e). The simple form is the single-access special case of the full form, so the upgrade is continuous.

### Stage 1 - exponential decay (055a)

```text
A_simple(m,t) = 2^( −(t − t_ref(m)) / h(class(m)) )
```

- `t_ref(m)` = the memory's reference time = `max(created_at, last_reinforced_at)`. A memory re-confirmed last week is as fresh as one created last week.
- `h(class(m))` = the half-life for the memory's provenance class. After `h` days of no reinforcement, activation halves.
- Equivalent to `exp(−λ Δt)` with `λ = ln 2 / h`. Half-life is the interpretable knob; `λ` is the implementation form.

Per-class half-lives encode that durable distilled facts should outlive raw dialogue:

| Class | Default half-life `h` | Rationale |
|---|---|---|
| `memories` (distilled facts) | `180 d` | Durable knowledge; decays slowly. |
| `memory` (session summaries) | `45 d` | Useful for weeks, then mostly superseded by distillation. |
| `sessions` (raw dialogue rows) | `10 d` | Ephemeral; recent context only. |

These defaults are starting points for the eval sweep, not assertions. The shipped value is whichever passes the recency-sensitivity gate (see Metrics).

### Stage 2 - ACT-R base-level activation (055e)

The rigorous form is Anderson and Schooler's base-level activation from ACT-R, which derives the shape of human forgetting from the statistics of how often information is actually needed. Over the access history `t_1 < t_2 < … < t_n` of memory `m` (creation is `t_1`, each useful recall adds a `t_k`):

```text
B(m,t) = ln( Σ_{k=1}^{n} u_k · (t − t_k)^(−d) )
```

- `d` = decay exponent, ACT-R default `0.5`. Larger `d` forgets faster.
- `u_k ∈ [0,1]` = the *usefulness* of access `k` (creation has `u_1 = 1`; a recall that was injected and then confirmed useful contributes `u_k ≈ 1`, one that was ignored or contradicted contributes `u_k ≈ 0`). This is partial reinforcement.

`B` rises with both recency (recent `t_k` dominate the sum) and frequency (more terms), and the **spacing effect** falls out for free: accesses spread over time decay slower than the same number bunched together, because no single `(t − t_k)^{−d}` term dominates. This is the difference between cramming and durable learning, expressed in one line.

Map `B` to the bounded multiplier the master equation needs:

```text
A_actr(m,t) = clamp( exp( B(m,t) − B* ), A_min, 1 )
```

- `B*` = reference activation that pins the top of the range (a memory at or above `B*` is maximally salient, `A = 1`).
- `A_min` = floor (default `0.05`) so even a cold memory keeps a sliver of salience, forgetting is graceful, never a cliff.

Stage 1 is Stage 2 with a single access and a matched `d`/`h`; the migration is parameter-continuous and eval-gated.

### Reinforcement event

A **reinforcement** appends `(t_now, u)` to the access series. It fires when a recalled memory is injected into context and the downstream turn does not contradict or down-rank it (or an explicit confirmation arrives). Usefulness `u` is graded by the strength of that signal. Reinforcement is the bridge between recall and the activation term: using a memory well makes it harder to forget, exactly as in spaced repetition. The forgetting-curve analogue is Ebbinghaus retrievability `R = exp(−Δt / S)` with stability `S` that *grows* each time the item is successfully retrieved; here `S` is implicit in the lengthening, usefulness-weighted access series.

---

## Term 2 - Calibrated confidence `C(m)`

Extraction assigns each fact a raw confidence `f ∈ [0,1]` (see `memory-pipeline.md`). Raw model confidence is systematically miscalibrated, a model that says `0.9` is right far less than 90% of the time. The lifecycle model does not trust `f` directly; it learns a **calibration map** `g` from observed outcomes:

```text
C(m) = g( f(m) )
```

`g` is fit by isotonic regression (monotone, non-parametric) over a growing set of `(f, correct?)` observations, where the ground-truth `correct?` signal comes for free from the lifecycle itself: a memory that *wins* a conflict or *passes* re-verification is evidence it was right; one that loses or is superseded is evidence it was wrong. The store learns how much to trust its own confidence from its own resolved history.

Calibration quality is tracked with the **Expected Calibration Error** over `M` confidence bins:

```text
ECE = Σ_{b=1}^{M} (|B_b| / N) · | acc(B_b) − conf(B_b) |
```

and the **Brier score** `(1/N) Σ (f_i − y_i)^2`. The target is monotone-decreasing ECE as the system accumulates resolved outcomes. Before enough data exists, `g` is the identity (`C = f`) and the `C` exponent `c` ships at `0` (dormant), consistent with the measure-before-trusting rule.

---

## Term 3 - Staleness `σ(m,t)`

A memory that names code that no longer exists is silently wrong. Let `refs(m)` be the code references extracted from `m` (file paths, qualified symbols, flag identifiers) and `G_t` the latest codebase-graph resolution snapshot for the workspace. Each reference resolves with a probability:

```text
resolve(r, G_t) ∈ [0,1]
  = 1            if r matches a symbol in G_t exactly
  = sim(r, r*)   if the best fuzzy match r* in G_t (rename candidate) is close
  = 0            if r looks like indexed code but is absent
  = (excluded)   if r is outside the indexed graph → contributes nothing (unknown)
```

Staleness is the probability that *at least one* in-scope reference is dangling:

```text
σ(m,t) = 1 − Π_{r ∈ refs_indexed(m)} [ resolve(r, G_t) · v(m,t) ]
```

`v(m,t)` is a **verification-freshness** factor that decays trust in the last check so the system re-verifies rather than trusting one stale read:

```text
v(m,t) = 2^( −(t − verified_at(m)) / h_verify )
```

When `v` drops below a re-verification threshold, the memory is re-queued for a fresh snapshot check (spaced re-verification, the staleness analogue of reinforcement). A memory with no indexed references has `σ = 0` by the empty-product convention. Demotion is `(1 − σ)^s`; under the worker's `observe` posture `s = 0` (visible but inert), under `execute` `s > 0` (measured).

---

## Term 4 - Conflict gate `κ(m,t)`

### Detecting a conflict

Two memories `a`, `b` conflict when they speak to the same claim and assert opposite outcomes. Define a **contradiction score**:

```text
Contra(a,b) = sim(slot_a, slot_b) · opp(a,b)
```

- `sim` = cosine similarity of the two memories' claim-slot embeddings (same subject?).
- `opp ∈ [0,1]` = outcome opposition = `max( opp_lexical , P_contradiction )`, where `opp_lexical` is the existing negation/antonym/overlap heuristic and `P_contradiction` is the contradiction probability from an NLI-style judge (the `memory_extraction` router workload). Taking the `max` means either a cheap lexical hit or a semantic verdict is enough; neither alone can be a blind spot.

A pair is flagged when `Contra(a,b) > θ_detect`. Detection runs over the candidate set the decision stage already fetches, so it costs no extra table scan.

### Resolving a conflict

Treat a claim slot as a variable with competing memory-evidence. Each memory `m_i` votes for outcome `o_i` with weight

```text
w_i = A(m_i,t) · C(m_i) · prov(m_i) · corr(o_i)
```

- `prov` = provenance arm-class weight (distilled `memory` = `1.0`, raw `session` = `0.4`), reusing the recall weighting.
- `corr(o)` = corroboration bonus for outcome `o`, log-scaled over *independent* sources so duplicated rows do not inflate a side: `corr(o) = 1 + γ · ln(1 + n_independent(o))`.

Aggregate per outcome and pick the winner by margin:

```text
score(o) = Σ_{i : o_i = o} w_i
winner   = argmax_o score(o)
margin   = 1 − score(runner_up) / score(winner)
```

| Margin | Verdict | `κ` for the losing side |
|---|---|---|
| `margin ≥ τ_supersede` | `supersede` (winner clearly dominates) | `0` (superseded via append-only version bump, excluded by `MAX(version)`) |
| `τ_review ≤ margin < τ_supersede` | `review` (ambiguous, human decides) | `ρ` (soft-suppress lower side, default `ρ = 0`, reversible) |
| `margin < τ_review` AND low `Contra` | `keep-both` (false positive, independent facts) | `1` (both stay live; pair memoized so it is not re-flagged) |

`supersede` never hard-deletes: it writes a new version marking the loser superseded, identical to the PRD-008 entity path, so a wrong resolution is reversible by another version bump. Every detection and resolution appends to `memory_history` (actor, reason, confidence) and projects into the `memory_conflicts` table.

---

## Putting it together - a worked example

A memory `m`: "the daemon stores embeddings via `src/daemon/storage/noopEmbedClient`", distilled (`prov = 1.0`), created 120 days ago, last reinforced never, raw confidence `f = 0.8`.

- **Activation:** `class = memories`, `h = 180`. `A = 2^(−120/180) = 2^(−0.667) ≈ 0.63`.
- **Confidence:** suppose calibration maps `0.8 → 0.74`. `C = 0.74`.
- **Staleness:** `noopEmbedClient` was deleted (PRD-025). The reference does not resolve, `resolve = 0`, so `σ = 1 − 0 = 1`. The memory is fully stale.
- **Conflict:** a newer memory says embeddings use the real `createEmbedAttachment`. `Contra` is high, the newer memory wins on recency and corroboration, margin clears `τ_supersede`, so `m` is superseded: `κ = 0`.

`κ = 0` zeroes `P` regardless of the other terms, `m` is correctly excluded. Even had it not been superseded, `σ = 1` would have driven `(1 − σ)^s → 0` under `execute`, demoting it to the floor. Two independent signals (conflict and staleness) both catch the same rot. That redundancy is the point: the best memory has more than one way to notice it is wrong.

---

## Parameters and defaults

All parameters live in the `memory.lifecycle.*` config block (055d) with `HONEYCOMB_LIFECYCLE_*` env overrides. Defaults below are *initial sweep points*; the shipped value is the eval-gated one.

| Parameter | Symbol | Default | Set by |
|---|---|---|---|
| Activation exponent | `a` | `1.0` | eval sweep (055a) |
| Confidence exponent | `c` | `0` (dormant until calibrated) | eval sweep (055e) |
| Staleness exponent | `s` | `0` under `observe`, `1` under `execute` | posture (055c) |
| Half-life, distilled | `h(memories)` | `180 d` | eval sweep (055a) |
| Half-life, summary | `h(memory)` | `45 d` | eval sweep (055a) |
| Half-life, raw | `h(sessions)` | `10 d` | eval sweep (055a) |
| ACT-R decay | `d` | `0.5` | eval sweep (055e) |
| Activation floor | `A_min` | `0.05` | 055e |
| Verification half-life | `h_verify` | `14 d` | 055c |
| Contradiction threshold | `θ_detect` | `0.6` | PR-curve tuned (055b) |
| Corroboration weight | `γ` | `0.5` | 055b |
| Supersede margin | `τ_supersede` | `0.5` | CRA-tuned (055b) |
| Review margin | `τ_review` | `0.15` | CRA-tuned (055b) |
| Open-conflict suppression | `ρ` | `0` (fully suppress, reversible) | 055b |

---

## Measuring the model - the lifecycle eval suite

Nothing here ships on faith; every term extends the PRD-027/047 golden-set discipline with a term-specific metric, and any change that regresses the committed baseline below `baseline − ε` fails the gate.

| Term | Metric | Question it answers |
|---|---|---|
| Relevance (base) | recall@k, MRR, nDCG@10 | Did we surface the right memory at all? (unchanged) |
| Activation | freshness-sensitivity slice: recall@5 on stale-vs-fresh pairs | Does the fresher correct memory rank first? |
| Confidence | ECE, Brier score, reliability diagram | Is stated confidence trustworthy? |
| Staleness | staleness precision / recall / F1 vs a labeled dangling-ref set | Do we flag the dead references and only those? |
| Conflict | Conflict Resolution Accuracy (CRA); contradiction-detection PR/F1 | Do we pick the right winner, and detect the right pairs? |
| End to end | useful-context@k: top-k contains the correct, current, non-conflicting memory | Did the whole stack deliver trustworthy context? |

`useful-context@k` is the headline product metric this model optimizes: not "did we find a relevant memory" but "did we find one the agent should actually believe right now." Every term exists to move that number.

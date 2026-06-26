# PRD-058: Memory Lifecycle (Recency, Conflict Resolution, Stale-Reference Healing)

> **Status:** In-Work
> **Priority:** P1
> **Effort:** L
> **Schema changes:** Additive (lazy-healed columns + two new tables)

## Overview

Honeycomb stores facts forever and resolves them by `MAX(version)` with an `is_deleted` tombstone and PRD-008 entity supersession. That hard-version model keeps a replaced fact from outranking its replacement, but it does not answer three softer lifecycle questions that a long-lived memory store eventually faces:

1. **Recency.** A memory that was true six months ago should not surface above last week's at equal relevance. The recall pipeline already has a `applyRecencyDampening` stage (PRD-047), but it ships with a near-infinite half-life, so it is neutral until a caller tunes it. Recency is built and dormant, not absent.
2. **Conflict resolution.** When two memories assert different outcomes for the same claim ("we use Drizzle" vs "we migrated to Prisma"), the store can hold both and surface both, leaving the agent to reconcile contradictions at read time. The decision stage has a token-heuristic contradiction check (negation, antonym, lexical overlap) that gates UPDATE/DELETE, but it is write-time only, lexical-only, and produces no operator-visible resolution.
3. **Stale references.** A memory that names a file, function, or flag that no longer exists in the codebase is silently wrong. Honeycomb already builds a codebase graph (PRD-014) with a resolution snapshot, but nothing cross-references stored memories against it to detect dangling references.

This module activates and completes all three, plus a fourth capability that turns "decay" into real memory: **reinforcement and calibration**, a store that strengthens what it uses and learns how much to trust its own confidence. It is deliberately built on top of the existing append-only model, the recall shaping stages, the PRD-008 supersession ontology, the codebase graph, the maintenance and retention workers, and the `memory_history` audit log. It adds no new write path that can cost the user a memory: every lifecycle action is enrichment or demotion, never a destructive in-place edit, and every action is recorded to history.

## The model in one equation

Every behavior in this module is one term of a single **retrieval-priority** equation. The full derivation, the cognitive-science grounding (ACT-R activation, Ebbinghaus stability, Bayesian belief, calibration / ECE), and all parameter defaults live in [`memory-lifecycle-scoring.md`](../../../knowledge/private/ai/memory-lifecycle-scoring.md). The shape:

```text
P(m | q, t) = R(m,q) · A(m,t)^a · C(m)^c · (1 − σ(m,t))^s · κ(m,t)
```

| Term | Meaning | Sub-PRD |
|---|---|---|
| `R(m,q)` | Relevance (RRF + shaping). Unchanged. | PRD-047 |
| `A(m,t)` | Activation: recency + access frequency + reinforcement. | 058a + 058e |
| `C(m)` | Calibrated confidence. | 058e |
| `σ(m,t)` | Staleness probability (dangling code refs). | 058c |
| `κ(m,t)` | Conflict gate (winner / superseded / open). | 058b |
| `a, c, s` | Per-term exponents; `0` = dormant, defaults eval-measured. | 058d |

Every term is a bounded multiplier: it can only demote relevance, never invent it, so `P ≤ R` always. Each ships behind an exponent that defaults to a value measured on the golden set, an unproven term ships neutral exactly as recency does today. The query-independent product `H(m,t) = A · C · (1 − σ) · κ` is the per-memory **health** scalar the dashboard renders.

## Goals

- Turn recency from a dormant knob into a measured, eval-gated default that demotes stale memories without ever hard-dropping one by age alone.
- Detect conflicting memories semantically (not just by token heuristics), resolve them through the existing supersession model, and suppress the losing side at recall time so an agent never receives two contradictory facts in one result set.
- Detect memories whose code references no longer resolve against the codebase graph, and heal them through a maintenance diagnostic that can flag, demote, supersede, or queue them for re-verification.
- Strengthen memories that are recalled and confirmed useful (reinforcement), so salience tracks real utility rather than raw age, and learn a calibration curve so the store knows how much to trust its own confidence.
- Surface every lifecycle event (recency demotion, detected conflict, stale reference, reinforcement) in the dashboard and CLI, governed by config flags consistent with the `memory.*` namespace, and auditable through `memory_history`.
- Keep recall fail-soft: no lifecycle stage may convert the degraded-but-answering recall path into a throw or a hang.

## Non-Goals

- Replacing the hard-version / `is_deleted` / PRD-008 supersession invariant. Lifecycle signals layer on top; they never become the source of truth for currentness.
- Reviving the de-scoped five-phase `RecallEngine` (see the PRD-045b note in `retrieval.md`). This module wires stages into the live `recallMemories`, not into a parallel engine.
- Hard time-based deletion. The retention worker (PRD-030) owns purge; this module only demotes and supersedes, it does not expire rows by age.
- Adopting the native `deeplake_hybrid_record` operator. Out of scope per PRD-047a and ADR-0001.
- Cross-workspace conflict detection. Conflict and staleness are resolved strictly inside the org/workspace/agent scope boundary.

## Features

| Sub-PRD | Feature | Status |
|---|---|---|
| [prd-058a-memory-lifecycle-recency-decay](./prd-058a-memory-lifecycle-recency-decay.md) | Recency activation and decay policy | Draft |
| [prd-058b-memory-lifecycle-conflict-resolution](./prd-058b-memory-lifecycle-conflict-resolution.md) | Semantic conflict detection and resolution | Draft |
| [prd-058c-memory-lifecycle-stale-reference-healing](./prd-058c-memory-lifecycle-stale-reference-healing.md) | Stale code-reference detection and healing | Draft |
| [prd-058d-memory-lifecycle-surfaces-and-controls](./prd-058d-memory-lifecycle-surfaces-and-controls.md) | Lifecycle config, audit, dashboard, and CLI surfaces | Draft |
| [prd-058e-memory-lifecycle-reinforcement-calibration](./prd-058e-memory-lifecycle-reinforcement-calibration.md) | Reinforcement (ACT-R activation), spaced re-verification, confidence calibration | Draft |

## Acceptance Criteria

- [ ] Recency dampening ships with a measured, non-neutral default half-life that passes the `npm run eval:recall` gate (no regression below `baseline - ε` on recall@5 and MRR).
- [ ] Two memories that assert contradictory outcomes for the same claim never both appear in a single recall result set; the loser is suppressed and the decision is recorded to `memory_history`.
- [ ] A memory referencing a code symbol absent from the latest codebase-graph resolution snapshot is detected by the maintenance worker and flagged with a `stale_ref` finding.
- [ ] Every lifecycle action (demote, supersede, flag) is gated by an explicit config flag, defaults to a non-destructive posture, and is visible in the dashboard memories surface.
- [ ] A memory that is recalled and confirmed useful is measurably harder to forget afterward (its activation rises), and confidence calibration error (ECE) is monotone-non-increasing as resolved outcomes accumulate.
- [ ] Recall remains fail-soft: with embeddings off or the embed daemon down, every lifecycle stage degrades gracefully and recall still answers.
- [ ] The end-to-end `useful-context@k` metric (top-k contains the correct, current, non-conflicting memory) improves over the pre-058 baseline, and no term regresses the committed recall@5 / MRR / nDCG@10 baseline below `baseline − ε`.
- [ ] A live dogfood run (not just isolated-mount unit tests) exercises all lifecycle paths end to end against a real daemon and a real DeepLake store.

## Related

- [`library/knowledge/private/ai/memory-lifecycle-scoring.md`](../../../knowledge/private/ai/memory-lifecycle-scoring.md) - **the master equation and every term's derivation. Read this first.**
- [`library/knowledge/private/ai/memory-pipeline.md`](../../../knowledge/private/ai/memory-pipeline.md) - decision stage, contradiction check, controlled writes, maintenance/retention workers.
- [`library/knowledge/private/ai/retrieval.md`](../../../knowledge/private/ai/retrieval.md) - recall shaping stages, `applyRecencyDampening`, currentness invariant.
- [`library/knowledge/private/ai/knowledge-graph-ontology.md`](../../../knowledge/private/ai/knowledge-graph-ontology.md) - entity supersession (`status = 'superseded'`).
- [`library/knowledge/private/data/codebase-graph.md`](../../../knowledge/private/data/codebase-graph.md) - resolution snapshot referenced by stale-ref detection.
- PRD-007 / PRD-047 (retrieval + shaping), PRD-008 (supersession ontology), PRD-014 (codebase graph), PRD-029 (degradation observability), PRD-030 (memory compaction / retention).
- [`library/knowledge/private/architecture/adr/0001-retrieval-fusion-rrf-vs-native-hybrid.md`](../../../knowledge/private/architecture/adr/0001-retrieval-fusion-rrf-vs-native-hybrid.md)

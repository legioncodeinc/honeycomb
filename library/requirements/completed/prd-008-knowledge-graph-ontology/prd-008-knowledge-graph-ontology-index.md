# PRD-008: Knowledge Graph and Ontology

> **Status:** Completed — NOW LIVE (closed by [PRD-045c](../../in-work/prd-045-daemon-wiring-closeout/prd-045c-daemon-wiring-closeout-ontology-surface.md))
> **Priority:** P1
> **Effort:** L
> **Schema changes:** Additive

---

> **✅ Now live (2026-06-22 daemon-wiring close-out, PRD-045c).** The ontology surface is fully wired. `inlineLinkMemory`
> (`ontology/entity-model.ts:506`) is now invoked on the live graph-persist path in the memory-pipeline
> (PRD-045a/045c), so entities are linked as memories land without depending on the pollinating gate. `/api/ontology/*`
> is mounted in `assemble.ts:868` (`mountOntologyApi`); the endpoint returns real entity/edge/assertion data (no 501).
> Control-plane apply/supersession runs on a live path via the pipeline graph-persist stage (independent of pollinating),
> with pollinating remaining an additional opt-in consolidation consumer. Closed by
> [PRD-045c](../../in-work/prd-045-daemon-wiring-closeout/prd-045c-daemon-wiring-closeout-ontology-surface.md).
> Full audit: [`2026-06-22-daemon-wiring-liveness-audit.md`](../../in-work/prd-045-daemon-wiring-closeout/reports/2026-06-22-daemon-wiring-liveness-audit.md).

---

## Overview

Flat memories answer "what did I say about X." A graph answers "what is true about X right now, what does X depend on, and who claimed it." This module builds Honeycomb's ontology: the navigation layer that makes entity-centric recall and currentness possible. It is derived from memories and carries provenance back to them, so it is never authoritative on its own; it is a fast, rebuildable index over evidence, and the daemon is the only writer. The module covers the entity model (entities, aspects, attributes) and the inline entity linker, the dependency edges and append-only supersession that keep currentness correct under DeepLake's UPDATE-coalescing quirk, and the control plane (ontology proposals, apply, epistemic assertions) that governs deliberate structural change.

## Goals

- Model entities, weighted aspects, and claim attributes with `group_key`/`claim_key` slots and version lineage.
- Run a synchronous inline entity linker that creates nothing, calls no model, and does no network I/O.
- Record dependency edges with strength, confidence, and a required reason for loose links, traversable only above a threshold.
- Supersede claims by append (never in-place update) so full history stays inspectable and retrieval can prefer the current value.
- Govern deliberate structural change through audited `ontology_proposals` and preserve attribution via `epistemic_assertions`.

## Non-Goals

- The background pipeline graph writer (PRD-006d); this module owns the entity model and control plane, not the bulk extraction write.
- Retrieval traversal and currentness shaping (PRD-007), which consume this graph.
- The model-driven graph reshaping of the pollinating loop.

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-008a-knowledge-graph-ontology-entity-model`](./prd-008a-knowledge-graph-ontology-entity-model.md) | Entities/aspects/attributes and the inline entity linker. | Draft |
| [`prd-008b-knowledge-graph-ontology-dependencies-supersession`](./prd-008b-knowledge-graph-ontology-dependencies-supersession.md) | Dependency edges and append-only supersession. | Draft |
| [`prd-008c-knowledge-graph-ontology-control-plane`](./prd-008c-knowledge-graph-ontology-control-plane.md) | Ontology proposals, apply, epistemic assertions. | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given new memory content, when the inline linker runs, then it links proper nouns to existing agent entities synchronously, creating nothing, calling no model, and doing no network I/O. |
| AC-2 | Given a conflicting claim in the same entity/aspect/group/claim slot, when supersession runs, then the new attribute is appended with a fresh version and the prior sibling is marked superseded rather than mutated in place. |
| AC-3 | Given a loose `related_to` edge, when it is written, then it carries a required reason, and traversal follows it only when strength times confidence clears the threshold. |
| AC-4 | Given a deliberate structural change, when it is submitted, then bounded explicit operations apply directly with an applied proposal row, while risky or broad changes enter the pending review queue. |

## Data model changes

Additive: relies on the ontology tables defined in PRD-003b (entities, aspects, attributes, dependencies, mentions, assertions, proposals); may refine column conventions for version lineage and provenance.

## API changes

Additive: `/api/ontology/*` (entities, aspects, proposals, assertions, apply) and the matching CLI surface.

## Open questions

- [ ] What confidence and risk thresholds route a change to direct-apply versus the pending review queue?
- [ ] Should constraints ever be auto-superseded, or always require a deliberate operation?
- [ ] How do epistemic assertions surface in retrieval without auto-promoting into ontology truth?

## Related

- [Knowledge Graph and Ontology](../../../knowledge/private/ai/knowledge-graph-ontology.md)
- [Schema](../../../knowledge/private/data/schema.md)
- [Retrieval](../../../knowledge/private/ai/retrieval.md)

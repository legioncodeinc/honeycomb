# PRD-009: Dreaming Loop

> **Status:** Completed (code shipped) — ⚠ WIRED BUT DORMANT (default OFF); close-out tracked in [PRD-045d](../../in-work/prd-045-daemon-wiring-closeout/prd-045d-daemon-wiring-closeout-dreaming-activation.md)
> **Priority:** P2
> **Effort:** L
> **Schema changes:** Additive

---

> **⚠ Wired but dormant (2026-06-22 daemon-wiring audit).** The worker is fully wired (`buildGatedDreamingWorker`
> `assemble.ts:926`, started `:1265-1266`) but gated OFF by default (needs `HONEYCOMB_DREAMING_ENABLED` or the
> vault `dreaming.enabled` setting). Its dormancy strands the only live consumers of PRD-008 apply + PRD-010
> router. Default-posture decision + end-to-end live proof:
> [PRD-045d](../../in-work/prd-045-daemon-wiring-closeout/prd-045d-daemon-wiring-closeout-dreaming-activation.md).
> Full audit: [`2026-06-22-daemon-wiring-liveness-audit.md`](../../in-work/prd-045-daemon-wiring-closeout/reports/2026-06-22-daemon-wiring-liveness-audit.md).

---

## Overview

The extraction pipeline is fast but near-sighted: each worker sees one chunk and one fact at a time with no view of the wider graph, which accumulates duplicate entities, junk attributes, and noisy traversal. The dreaming loop is the corrective maintenance pass. It runs inside the honeycomb daemon's maintenance loop, reasons over accumulated session summaries against the current entity graph using a stronger router-selected model, and proposes structural cleanup as a set of mutations. It fires on a token-budget counter rather than a clock, runs as a real captured session so it can observe its own prior consolidation decisions, and routes every mutation through the ontology control plane so destructive changes can land in a pending review queue. It is a premium tier; installs without a larger model keep extraction as the free tier and lose nothing but consolidation.

## Goals

- Trigger dreaming from a token-budget counter (`dreaming_state`) incremented on every session-summary write, not from a wall clock.
- Run dreaming as a real session through the normal session-start hook so it captures a transcript and can read its own prior passes.
- Apply graph mutations (merge, supersede, prune, create) through the ontology control plane with provenance and a review surface for risky changes.
- Support a first-run and on-demand compaction mode that walks the whole graph in one deliberate pass.

## Non-Goals

- Redefining the ontology control plane or its pending-review queue (consumed here, owned elsewhere).
- Rewriting raw artifacts or transcripts; dreaming advances status on the append-only path and never destroys lineage.
- Selecting the dreaming model directly; model choice resolves through the provider router workload.

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-009a-dreaming-loop-trigger`](./prd-009a-dreaming-loop-trigger.md) | Token-budget counter and `dreaming_state` row that queues a pass at threshold. | Draft |
| [`prd-009b-dreaming-loop-session-runner`](./prd-009b-dreaming-loop-session-runner.md) | Dreaming session execution and mutation apply through the control plane. | Draft |
| [`prd-009c-dreaming-loop-compaction-mode`](./prd-009c-dreaming-loop-compaction-mode.md) | First-run and backfill full-graph compaction pass. | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given session-summary writes that push `dreaming_state` past `tokenThreshold`, when the next maintenance tick runs, then a dreaming job is queued and the counter resets. |
| AC-2 | Given a returned mutation set with a destructive op, when it is applied, then the change routes through the ontology control plane with provenance and risky ops land in pending review rather than applying blind. |
| AC-3 | Given `honeycomb dream trigger --compact`, when it runs, then the agent loads the full entity graph and emits merge/prune mutations across the whole graph in one pass. |

## Data model changes

Additive: a `dreaming_state` row tracking tokens-since-last-pass per scope. Reuses existing graph, summary, and `memory_jobs` tables.

## API changes

Additive: a daemon endpoint and `honeycomb dream` CLI verb to inspect state and trigger a pass (including `--compact`).

## Open questions

- [ ] Should the default `tokenThreshold` (around 100k) be per-workspace, per-agent, or global?
- [ ] How are mutations attributed when a dreaming pass merges entities owned by different `agent_id`s?
- [ ] Should compaction mode be rate-limited or budget-capped to bound premium-model cost on large graphs?

## Related

- [Dreaming Loop](../../../knowledge/private/ai/dreaming-loop.md)
- [Knowledge Graph Ontology](../../../knowledge/private/ai/knowledge-graph-ontology.md)
- [Model and Provider Router](../../../knowledge/private/ai/model-provider-router.md)
- [Workspace Layout](../../../knowledge/private/data/workspace-layout.md)

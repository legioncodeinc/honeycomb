# PRD-009: Pollinating Loop

> **Status:** Completed — WIRED, DEFAULT OFF BY DESIGN (closed by [PRD-045d](../../in-work/prd-045-daemon-wiring-closeout/prd-045d-daemon-wiring-closeout-pollinating-activation.md))
> **Priority:** P2
> **Effort:** L
> **Schema changes:** Additive

---

> **✅ Reconciled (2026-06-22 daemon-wiring close-out, PRD-045d).** The pollinating loop is fully wired
> (`buildGatedPollinatingWorker` at `assemble.ts:926`, started at `assemble.ts:1265-1266`) and proven end-to-end
> when enabled. The default-OFF posture is a **recorded decision** (not a gap): no surprise model spend until an
> operator explicitly opts in. Enable via `HONEYCOMB_POLLINATING_ENABLED=true` (env var, restart required) or
> `pollinating.enabled = true` in the vault (vault-first precedence, survives restart). When enabled, the worker
> leases `["pollinating"]` jobs, the runner reasons over session summaries + the entity graph, and mutations route
> through the ontology control plane (`pollinating/runner.ts:284`). The pipeline (PRD-045a) is the primary live graph
> writer on every captured turn; pollinating is the opt-in periodic consolidator on top. The PRD-010 router is
> activated as a side effect of enabling pollinating. Proven by token-gated live itest
> (`tests/integration/pollinating-activation-live.itest.ts`). Closed by
> [PRD-045d](../../in-work/prd-045-daemon-wiring-closeout/prd-045d-daemon-wiring-closeout-pollinating-activation.md).
> Full audit: [`2026-06-22-daemon-wiring-liveness-audit.md`](../../in-work/prd-045-daemon-wiring-closeout/reports/2026-06-22-daemon-wiring-liveness-audit.md).

---

## Overview

The extraction pipeline is fast but near-sighted: each worker sees one chunk and one fact at a time with no view of the wider graph, which accumulates duplicate entities, junk attributes, and noisy traversal. The pollinating loop is the corrective maintenance pass. It runs inside the honeycomb daemon's maintenance loop, reasons over accumulated session summaries against the current entity graph using a stronger router-selected model, and proposes structural cleanup as a set of mutations. It fires on a token-budget counter rather than a clock, runs as a real captured session so it can observe its own prior consolidation decisions, and routes every mutation through the ontology control plane so destructive changes can land in a pending review queue. It is a premium tier; installs without a larger model keep extraction as the free tier and lose nothing but consolidation.

## Goals

- Trigger pollinating from a token-budget counter (`pollinating_state`) incremented on every session-summary write, not from a wall clock.
- Run pollinating as a real session through the normal session-start hook so it captures a transcript and can read its own prior passes.
- Apply graph mutations (merge, supersede, prune, create) through the ontology control plane with provenance and a review surface for risky changes.
- Support a first-run and on-demand compaction mode that walks the whole graph in one deliberate pass.

## Non-Goals

- Redefining the ontology control plane or its pending-review queue (consumed here, owned elsewhere).
- Rewriting raw artifacts or transcripts; pollinating advances status on the append-only path and never destroys lineage.
- Selecting the pollinating model directly; model choice resolves through the provider router workload.

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-009a-pollinating-loop-trigger`](./prd-009a-pollinating-loop-trigger.md) | Token-budget counter and `pollinating_state` row that queues a pass at threshold. | Draft |
| [`prd-009b-pollinating-loop-session-runner`](./prd-009b-pollinating-loop-session-runner.md) | Pollinating session execution and mutation apply through the control plane. | Draft |
| [`prd-009c-pollinating-loop-compaction-mode`](./prd-009c-pollinating-loop-compaction-mode.md) | First-run and backfill full-graph compaction pass. | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given session-summary writes that push `pollinating_state` past `tokenThreshold`, when the next maintenance tick runs, then a pollinating job is queued and the counter resets. |
| AC-2 | Given a returned mutation set with a destructive op, when it is applied, then the change routes through the ontology control plane with provenance and risky ops land in pending review rather than applying blind. |
| AC-3 | Given `honeycomb pollinate trigger --compact`, when it runs, then the agent loads the full entity graph and emits merge/prune mutations across the whole graph in one pass. |

## Data model changes

Additive: a `pollinating_state` row tracking tokens-since-last-pass per scope. Reuses existing graph, summary, and `memory_jobs` tables.

## API changes

Additive: a daemon endpoint and `honeycomb pollinate` CLI verb to inspect state and trigger a pass (including `--compact`).

## Open questions

- [ ] Should the default `tokenThreshold` (around 100k) be per-workspace, per-agent, or global?
- [ ] How are mutations attributed when a pollinating pass merges entities owned by different `agent_id`s?
- [ ] Should compaction mode be rate-limited or budget-capped to bound premium-model cost on large graphs?

## Related

- [Pollinating Loop](../../../knowledge/private/ai/pollinating-loop.md)
- [Knowledge Graph Ontology](../../../knowledge/private/ai/knowledge-graph-ontology.md)
- [Model and Provider Router](../../../knowledge/private/ai/model-provider-router.md)
- [Workspace Layout](../../../knowledge/private/data/workspace-layout.md)

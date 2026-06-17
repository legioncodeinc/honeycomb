# Dreaming Loop

> Category: Ai | Version: 1.0 | Date: June 2026 | Status: Active

The maintenance pass that periodically reasons over accumulated summaries and the whole graph to merge duplicates, prune junk, and supersede stale claims. Why it exists, when it fires, and what it is allowed to change.

**Related:**
- [`memory-pipeline.md`](memory-pipeline.md)
- [`knowledge-graph-ontology.md`](knowledge-graph-ontology.md)
- [`model-provider-router.md`](model-provider-router.md)
- [`../data/workspace-layout.md`](../data/workspace-layout.md)

---

## Why dreaming exists

The extraction pipeline is fast and cheap, but it is also near-sighted. Each extraction worker sees one chunk and one fact at a time, with no view of the wider graph. Over time that produces duplicate entities, junk attributes, and noisy traversal. Dreaming is the corrective: a periodic pass by a stronger model that reads accumulated session summaries against the current graph and proposes structural cleanup. It is the operating substrate behind Honeycomb's claim that continuity is maintained, not shipped once.

Dreaming runs inside the daemon's maintenance loop and reasons over DeepLake tables the daemon owns. It is a premium tier. Installs without access to a larger model keep the extraction pipeline as the free tier and lose nothing; they just do not get consolidation.

## When it fires

The trigger is a token-budget counter, not a clock. The `dreaming_state` row tracks tokens since the last pass. Every session-summary write increments that counter. When it crosses a threshold (default around 100k tokens), a dreaming job is queued. This scales naturally: heavy users dream often, light users dream rarely.

```yaml
memory:
  dreaming:
    enabled: true
    tokenThreshold: 100000
    maxInputTokens: 128000
    backfillOnFirstRun: true
```

## It runs as a real session

Dreaming is not a hidden worker. It goes through the normal session-start hook, captures a transcript, and gets summarized at the end like any other session. That choice is deliberate. Because the agent receives its startup identity context plus prior dreaming sessions and can see `MEMORY.md`, it can observe its own previous consolidation decisions and evaluate them: did those merges improve recall, was that pruning too aggressive. Adjustments compound across passes instead of starting from amnesia each time.

## What the dreaming agent reads

A pass loads four things: the startup identity files according to the identity preset, the unprocessed session summaries since the last pass (in chronological order), a snapshot of the entity graph with aspects, attributes, and relationships, and a `DREAMING.md` task prompt that is loaded only for dreaming sessions, never in normal startup.

Regular passes are incremental. The model receives only new summaries plus entities and attributes that changed since the last pass, a small bounded payload, with a query tool available to inspect the rest of the graph on demand. The model itself is chosen by the router for the dreaming workload, which favors a stronger target than extraction uses (see [`model-provider-router.md`](model-provider-router.md)). The first run, or an explicit compaction run, walks the full graph instead.

## What it can change

The agent returns a structured set of mutations against the graph.

```json
{
  "mutations": [
    { "op": "create_entity", "name": "...", "type": "...", "aspects": [] },
    { "op": "merge_entities", "source": ["id1", "id2"], "target": "id3", "reason": "..." },
    { "op": "delete_entity", "name": "...", "reason": "..." },
    { "op": "update_aspect", "entity": "...", "aspect": "...", "attributes": [] },
    { "op": "supersede_attribute", "entity": "...", "aspect": "...", "old": "...", "new": "..." },
    { "op": "create_attribute", "entity": "...", "aspect": "...", "content": "..." },
    { "op": "delete_attribute", "entity": "...", "aspect": "...", "content": "...", "reason": "..." }
  ],
  "summary": "human-readable change narrative",
  "tokensBudget": 12345
}
```

These mutations flow through the same ontology control plane described in [`knowledge-graph-ontology.md`](knowledge-graph-ontology.md), so risky or destructive changes can land in the pending review queue rather than applying blind, and every applied change keeps provenance. Because that control plane writes through DeepLake's append-only, version-bumped path, a merge or supersession never destroys the prior rows; it advances their status while the lineage stays on disk. The raw artifacts and transcripts the summaries came from are never rewritten.

## Backfill and compaction mode

On first run or on demand, dreaming switches to compaction mode: load the entire entity graph, sample recent summaries, and reason about duplicates, merges, and junk across the whole thing using the same mutation format. This is how a graph that grew messy before dreaming was enabled gets cleaned up in one deliberate pass.

```bash
honeycomb dream trigger --compact
```

## The bigger loop

Dreaming is one expression of Honeycomb's maintenance philosophy. The same cron-style idea drives identity-file proposals (evidence-backed edits to `AGENTS.md`, `SOUL.md`, and the rest), semantic supersession, and drift catches. The point is that the semantic and identity layers are constantly rebuilt from the artifacts beneath them, with a human review surface for anything consequential. Continuity is an operating substrate that is maintained, not a feature that ships and freezes. Where that durable state actually lives on disk and in DeepLake is the subject of [`../data/workspace-layout.md`](../data/workspace-layout.md).

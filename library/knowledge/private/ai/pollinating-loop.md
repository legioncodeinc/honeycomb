# Pollinating Loop

> Category: Ai | Version: 1.1 | Date: June 2026 | Status: Active

The maintenance pass that periodically reasons over accumulated summaries and the whole graph to merge duplicates, prune junk, and supersede stale claims. Why it exists, how it is enabled (off-by-default, no-surprise-spend), when it fires, and what it is allowed to change.

**Related:**
- [`memory-pipeline.md`](memory-pipeline.md)
- [`knowledge-graph-ontology.md`](knowledge-graph-ontology.md)
- [`model-provider-router.md`](model-provider-router.md)
- [`../data/memory-compaction.md`](../data/memory-compaction.md)
- [`../data/workspace-layout.md`](../data/workspace-layout.md)

---

## Why pollinating exists

The extraction pipeline is fast and cheap, but it is also near-sighted. Each extraction worker sees one chunk and one fact at a time, with no view of the wider graph. Over time that produces duplicate entities, junk attributes, and noisy traversal. Pollinating is the corrective: a periodic pass by a stronger model that reads accumulated session summaries against the current graph and proposes structural cleanup. It is the operating substrate behind Honeycomb's claim that continuity is maintained, not shipped once.

Pollinating runs inside the daemon's maintenance loop and reasons over DeepLake tables the daemon owns. It is a premium tier. Installs without access to a larger model keep the extraction pipeline as the free tier and lose nothing; they just do not get consolidation.

## Enabling pollinating (off-by-default, no-surprise-spend)

Pollinating is **off by default** on fresh installs to avoid surprise model spend. `resolvePollinatingConfig` (`src/daemon/runtime/pollinating/config.ts`) ships `memory.pollinating.enabled = false` as the false-safe default, a missing flag is OFF, deliberately, because enabling a model-calling loop by default before it is proven on a user's real data is exactly the run-away risk the guards exist for. While disabled, `POST /api/diagnostics/pollinate` returns `{triggered:false, status:"skipped", reason:"disabled"}`; the whole loop is built and mounted, just gated.

Turning it on is a one-knob flip, via either mechanism (vault setting wins when present):

1. Environment variable: `HONEYCOMB_POLLINATING_ENABLED=true` (or `1`).
2. Vault setting: `pollinating.enabled = true` (set via `honeycomb setting set pollinating.enabled true`).

A vault `false` disables pollinating even when the environment variable is set, giving operators a runtime kill-switch without a redeploy. The same posture extends to the broader memory pipeline: the `HONEYCOMB_PIPELINE_*` flags gate the extraction/consolidation machinery so an install opts into spend explicitly rather than inheriting it.

Once enabled, the live trigger flips: `POST /api/diagnostics/pollinate` returns `{triggered:true, status:"enqueued"}` at or over threshold, `{triggered:true, status:"running"}` when a pass is already pending, or `{triggered:true, status:"below-threshold"}` when the counter has not crossed the threshold (the trigger decision is `below_threshold`). The disabled ack stays `{triggered:false, status:"skipped", reason:"disabled"}`.

`tests/integration/pollinating-consolidation-live.itest.ts` is a live consolidation itest. It is `describe.skipIf` unless both `HONEYCOMB_DEEPLAKE_TOKEN` and `ANTHROPIC_API_KEY` are set, and the `.itest.ts` suffix keeps it out of `npm run ci`. This tree does not record a passing live run. The consolidation behavior is specified by that test, and it is not an observed result of this checkout.

## When it fires

The trigger is a token-budget counter, not a clock. The `pollinating_state` row tracks tokens since the last pass. Every session-summary write increments that counter. When it crosses a threshold (default around 100k tokens), a pollinating job is queued. This scales naturally: heavy users pollinate often, light users pollinate rarely.

```yaml
memory:
  pollinating:
    enabled: true          # must be explicitly set; default is off
    tokenThreshold: 100000
    maxInputTokens: 128000
    backfillOnFirstRun: true
```

## It runs as a job worker

The live consumer is `src/daemon/runtime/pollinating/worker.ts`. It leases a `pollinating` job and calls `runner.runPass`. The worker builds the incremental strategy with only `maxInputTokens`, which selects `defaultPollinatingIdentitySource`. That source returns empty identity files, empty prior pollinating sessions, and an empty `MEMORY.md`. There is no session-start hook and no transcript write on this path.

## What the pollinating agent reads

The incremental payload still has sections for the in-code `DEFAULT_POLLINATING_TASK_PROMPT` (the prompt text headed `# POLLINATING`, not a file loaded at session start), new summaries since the last pass, and a snapshot of entities and attributes that changed since the last pass. Identity files, prior sessions, and `MEMORY.md` are empty on the production source.

`createGraphQueryTool` (`pollinating/incremental.ts`) can query entities and attributes, and the prompt pastes those tool names into the "Graph query tool" section. Nothing in `src` calls `createGraphQueryTool`. `ModelClient.complete` is one text completion. The model is not given a callable tool. The workload token is `memory_pollinating` (see [`model-provider-router.md`](model-provider-router.md)). The first run, or an explicit compaction strategy, is selected inside the same worker.

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

On first run or on demand, pollinating switches to compaction mode: load the entire entity graph, sample recent summaries, and reason about duplicates, merges, and junk across the whole thing using the same mutation format. This is how a graph that grew messy before pollinating was enabled gets cleaned up in one deliberate pass.

```bash
honeycomb pollinate trigger --compact
```

## The bigger loop

Pollinating is one expression of Honeycomb's maintenance philosophy. The same cron-style idea drives identity-file proposals (evidence-backed edits to `AGENTS.md`, `SOUL.md`, and the rest), semantic supersession, and drift catches. The point is that the semantic and identity layers are constantly rebuilt from the artifacts beneath them, with a human review surface for anything consequential. Continuity is an operating substrate that is maintained, not a feature that ships and freezes. Where that durable state actually lives on disk and in DeepLake is the subject of [`../data/workspace-layout.md`](../data/workspace-layout.md).

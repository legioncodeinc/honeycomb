# Wave 1a knowledge defects: AI lifecycle, graph, and router

Shard date: 2026-10-04. Branch context: `legion/kb-sotu-and-prd-lifecycle`. Read-only. Grounding is `src/daemon` plus the CLI and dashboard paths the pages name. Build outputs and `node_modules` were not used.

Defect count: 28 (FALSE, STALE, or HOLE). Page action for every file in this shard is REVISE. None should be removed. No new page is required.

## Coverage

| File | Page action | Notes |
|---|---|---|
| `library/knowledge/private/ai/memory-lifecycle-scoring.md` | REVISE | Math page. Status still names PRD-055. |
| `library/knowledge/private/ai/memory-lifecycle-as-built.md` | REVISE | Seams exist. Several wiring and surface claims do not. |
| `library/knowledge/private/ai/memory-lifecycle-config.md` | REVISE | Flag table matches `LIFECYCLE_FLAG_REFERENCE`. Prose calls `a = 1` the identity. |
| `library/knowledge/private/ai/knowledge-graph-ontology.md` | REVISE | Tables and proposal ops exist. Traversal, communities, and the listed CLI driver do not. |
| `library/knowledge/private/ai/graphrag-followon.md` | REVISE | Still unbuilt. The recursive-CTE transfer assumes a store feature the daemon does not use. |
| `library/knowledge/private/ai/pollinating-loop.md` | REVISE | Off-by-default job worker exists. It is not a captured session, and the query tool is not called. |
| `library/knowledge/private/ai/model-provider-router.md` | REVISE | Router core exists. The sample YAML, workload names, registered CLI, and rate-limit claim do not match. |
| `library/knowledge/private/ai/portkey-gateway.md` | REVISE | Factory, transport, and rerank path exist. Fallback, health enum, and dashboard path do not match. |

Unowned `library/knowledge/private/ai/*.md`: none. The directory has 19 markdown files. This shard owns the 8 above. The other AI shards own `session-capture.md`, `skillify-pipeline.md`, `memory-pipeline.md`, `distillation-and-tier1-keys.md`, `wiki-summary-workers.md`, `session-priming-architecture.md`, `retrieval.md`, `hybrid-sql-vector-rationale.md`, `deeplake-hybrid-record-operator-report.md`, `three-tier-memory-strategy.md`, and `prior-art-owls-roost-crosswalk.md`.

Related siblings named by these pages exist: `retrieval.md`, `memory-pipeline.md`, `knowledge-graph-ontology.md`, `three-tier-memory-strategy.md`, `../data/codebase-graph.md`, `../data/schema.md`, `../data/memory-compaction.md`, `../data/workspace-layout.md`, `../security/scoping-and-visibility.md`, `../security/secrets.md`, `../security/portkey-privacy-tier.md`, `../integrations/mcp-and-sdk.md`, `model-provider-router.md`, `portkey-gateway.md`, `pollinating-loop.md`, `prior-art-owls-roost-crosswalk.md`, `hybrid-sql-vector-rationale.md`.

## Defects

### D-01 Scoring page still owned by PRD-055

- Quote: "Status: Proposed (PRD-055)" and "each sub-PRD implements exactly one term and cites the equations here."
- Doc: `library/knowledge/private/ai/memory-lifecycle-scoring.md:3` and `:5`
- Grounding: `library/requirements/backlog/prd-055-fleet-control-enrollment-and-mint-authority/prd-055-fleet-control-enrollment-and-mint-authority-index.md:1` (PRD-055 is fleet enrollment). Lifecycle code and the in-work folder are PRD-058: `library/requirements/in-work/prd-058-memory-lifecycle/prd-058-memory-lifecycle-index.md:1`, `src/daemon/runtime/memories/lifecycle-config.ts:2`.
- Verdict: STALE
- Action: REVISE

### D-02 Config page calls exponent 1 the identity

- Quote: "A fresh install demotes nothing. Every term that can demote ships behind an exponent that defaults to the identity" and "`a = 1` (activation/freshness live but neutral-shaped)".
- Doc: `library/knowledge/private/ai/memory-lifecycle-config.md:25` and `:27`
- Grounding: `src/daemon/runtime/memories/lifecycle-config.ts:64` ("`1.0` = raw activation, `0` = neutral"). `src/daemon/runtime/memories/recall.ts:2887` multiplies the fused score by `A^activationExponent`. `src/daemon/runtime/recall/config.ts:180` half-lives are 180 / 45 / 10 days, so `a = 1` reorders by age.
- Verdict: FALSE
- Action: REVISE

### D-03 As-built says a fresh install demotes nothing, then says recency bites

- Quote: "The install default demotes nothing."
- Doc: `library/knowledge/private/ai/memory-lifecycle-as-built.md:52`
- Grounding: same file `:54` says Stage 1 is live with `a = 1.0` and "recency genuinely bites". Code: `src/daemon/runtime/memories/lifecycle-config.ts:65` and `src/daemon/runtime/memories/recall.ts:2885`.
- Verdict: FALSE
- Action: REVISE

### D-04 Memories lifecycle columns are undercounted

- Quote: "Two columns added to `memories`" while the table lists `last_reinforced_at`, `access_count`, `ref_status`, `verified_at`, and `stale_refs`.
- Doc: `library/knowledge/private/ai/memory-lifecycle-as-built.md:81` through `:89`
- Grounding: `src/daemon/storage/catalog/memories.ts:86` through `:133` also has `access_compacted_at` and `access_compacted_id`. Those watermark columns are absent from the page.
- Verdict: FALSE
- Action: REVISE

### D-05 Compaction is described as folding into access_count

- Quote: "`compact-access-log-api.ts` (compacts raw `memory_access` events into the `access_count` + `last_reinforced_at` denormalized cache)" and "The retention worker compacts old raw events into `memories.access_count` + `last_reinforced_at`".
- Doc: `library/knowledge/private/ai/memory-lifecycle-as-built.md:73` and `:94`
- Grounding: `src/daemon/runtime/memories/access-log.ts:285` ("Compaction does NOT add to `access_count`"). `access_count` increments only on append at `access-log.ts:181`. Compaction advances the reinforce watermark and deletes old raw rows (`access-log.ts:280`). `src/daemon/runtime/maintenance/lifecycle-tick.ts:25` repeats the wrong "fold into access_count" comment.
- Verdict: FALSE
- Action: REVISE

### D-06 Recall does not reinforce, and the grader has no production caller

- Quote: "`recordRecallAccess`: every recall hit now bumps `access_count` and advances `last_reinforced_at`" and "the session-end summary worker grades the turn's outcome and logs a `reinforce` ... or `downweight`".
- Doc: `library/knowledge/private/ai/memory-lifecycle-as-built.md:67` and `:103`
- Grounding: `src/daemon/runtime/assemble.ts:1078` calls `recordAccess(memoryId, 0, "recall", ...)`. `src/daemon/runtime/memories/access-log.ts:132` advances `last_reinforced_at` only for kind `reinforce`. `gradeUsefulness` is defined at `src/daemon/runtime/memories/usefulness-grader.ts:201` and is called from `tests/daemon/runtime/memories/usefulness-grader.spec.ts:18`. No production caller writes `reinforce` or `downweight`.
- Verdict: FALSE
- Action: REVISE

### D-07 Confidence exponent is not the ranking gate

- Quote: "The doc's "unproven calibration never perturbs ranking" rule is enforced by this exponent, not by skipping the computation."
- Doc: `library/knowledge/private/ai/memory-lifecycle-as-built.md:55`
- Grounding: `src/daemon/runtime/memories/recall.ts:2574` ("It NEVER reorders (this wave)"). `src/daemon/runtime/memories/api.ts:312` says `confidenceExponent` is "informational" and "the engine's calibration stage does NOT reorder". Setting `memory.lifecycle.confidenceExponent` does not enter the score product.
- Verdict: FALSE
- Action: REVISE

### D-08 ACT-R replaces Stage 1 only for memories hits

- Quote: "PR #258 now injects `activationSource` in `assemble.ts`, so ACT-R replaces the Stage-1 fallback".
- Doc: `library/knowledge/private/ai/memory-lifecycle-as-built.md:54` and the table at `:28`
- Grounding: `src/daemon/runtime/assemble.ts:1562` does inject `activationSource`. `src/daemon/runtime/assemble.ts:1089` says `memory` and `sessions` hits carry no access log, so they stay on Stage 1. `src/daemon/runtime/memories/recall.ts:2908` uses ACT-R only when the source returns a row for that hit.
- Verdict: HOLE
- Action: REVISE

### D-09 Conflict-hook line numbers drifted

- Quote: "the controlled-write handler ... calls `runConflictHook` post-commit on both the create path (`controlled-writes.ts:503`) and the update-with-new-content path (`:610`); ... `assemble.ts:1544` builds `createControlledWriteConflictHook`, `:1551` wires it".
- Doc: `library/knowledge/private/ai/memory-lifecycle-as-built.md:115`
- Grounding: `src/daemon/runtime/pipeline/controlled-writes.ts:511` and `:634`. `src/daemon/runtime/assemble.ts:2914` and `:2955`. The two call sites and the hook injection still exist. The cited lines do not.
- Verdict: STALE
- Action: REVISE

### D-10 Lifecycle dashboard panel path is absent

- Quote: "The dashboard mounts a lifecycle panel on the memories page (`src/dashboard/web/pages/lifecycle-panel.tsx`)".
- Doc: `library/knowledge/private/ai/memory-lifecycle-as-built.md:146`. The config page repeats the panel at `memory-lifecycle-config.md:74`.
- Grounding: ABSENT. `src/dashboard` has no `web/pages/lifecycle-panel.tsx`. The settings flag table is `src/dashboard/views.ts:95` (`buildLifecycleFlagsView`), nested under settings at `views.ts:121`.
- Verdict: FALSE
- Action: REVISE

### D-11 Health scalar is not one shared function

- Quote: "The four surfaces (recall response, memory-detail API, CLI, dashboard) all call this one function so they can never compute `H` differently."
- Doc: `library/knowledge/private/ai/memory-lifecycle-as-built.md:144`
- Grounding: `assembleHealth` is defined at `src/daemon/runtime/memories/lifecycle-health.ts:62` and re-exported from `lifecycle-api.ts:274`. No other file calls it. The CLI recomputes the product inline at `src/commands/memory.ts:353`.
- Verdict: FALSE
- Action: REVISE

### D-12 Inline linker is not a synchronous post-commit step

- Quote: "The inline entity linker runs synchronously at write time. ... it is safe to run right after the memory commit and gives entity pages an immediate mention."
- Doc: `library/knowledge/private/ai/knowledge-graph-ontology.md:56`
- Grounding: `inlineLinkMemory` is defined at `src/daemon/runtime/ontology/entity-model.ts:504`. The only production call is the graph-persist stage, `src/daemon/runtime/pipeline/graph-persist.ts:479`, and that call is skipped when there are no triples (`graph-persist.ts:448`). It is a later job, not the controlled-write commit.
- Verdict: FALSE
- Action: REVISE

### D-13 Graph writer does not stamp a real agent id

- Quote: "It upserts entities by canonical name and edges by triple, honoring org, workspace, and agent scope."
- Doc: `library/knowledge/private/ai/knowledge-graph-ontology.md:58`
- Grounding: `src/daemon/runtime/pipeline/graph-persist.ts:453` sets `agentId` to `scope.workspace ?? "default"`. Org and workspace still ride the storage partition. The row's `agent_id` is the workspace id.
- Verdict: FALSE
- Action: REVISE

### D-14 Ontology traversal is config-only

- Quote: "Recall resolves focal entities in priority order: pinned entities, checkpoint entity IDs from session state, project-path matches, query-token matches against the entity FTS index, then a session-key fallback. ... Those IDs flow into the candidate pool".
- Doc: `library/knowledge/private/ai/knowledge-graph-ontology.md:80`
- Grounding: traversal knobs exist only in `src/daemon/runtime/recall/config.ts:58` and `:297` (`aspectsPerEntity` and the rest). No other `src` file reads them. Recall sources are `memories | memory | sessions | hive_graph_versions` at `src/daemon/runtime/memories/recall.ts:266`. No focal-entity walker.
- Verdict: FALSE
- Action: REVISE

### D-15 Community detection is absent

- Quote: "Community detection clusters related entities."
- Doc: `library/knowledge/private/ai/knowledge-graph-ontology.md:84`
- Grounding: ABSENT. No community, louvain, or cluster walker under `src/daemon`.
- Verdict: FALSE
- Action: REVISE

### D-16 Aspect-weight feedback is not on the recall path

- Quote: "When recall and a session keep confirming memories under an aspect, that aspect's weight goes up; aspects that go stale beyond a window decay toward a floor."
- Doc: `library/knowledge/private/ai/knowledge-graph-ontology.md:84`
- Grounding: `confirmAspectWeight` and `decayAspectWeight` are defined at `src/daemon/runtime/ontology/entity-model.ts:357` and `:368`. Call sites are `tests/daemon/runtime/ontology/entity-model.test.ts:254` and `:263` only.
- Verdict: FALSE
- Action: REVISE

### D-17 Listed ontology CLI is not the dispatcher

- Quote: the `honeycomb ontology pipeline explain`, `proposals`, `assertions`, `entity merge-plan`, and `stream apply` block.
- Doc: `library/knowledge/private/ai/knowledge-graph-ontology.md:70`
- Grounding: `runOntologyCommand` lives at `src/cli/ontology.ts:166` and has no caller outside that file. The live verb maps through `src/commands/storage-handlers.ts:209` onto `/api/ontology/<sub>`. Mounted routes are `src/daemon/runtime/ontology/api.ts:203` through `:278` (`/`, `/entities`, `/edges`, `/claims`, `/assertions`, `POST /proposals`). There is no `pipeline explain`, `merge-plan`, or `stream apply` route. `src/cli/ontology.ts:174` also refuses a live `stream apply` without `--dry-run`.
- Verdict: FALSE
- Action: REVISE

### D-18 GraphRAG brief assumes a recursive CTE the daemon does not use

- Quote: "Traversal is a recursive CTE (2-3 hops) with cycle detection, Postgres handles a sparse graph" and "maps directly onto Honeycomb's SQL+vector store".
- Doc: `library/knowledge/private/ai/graphrag-followon.md:37` and `:56`
- Grounding: ABSENT. No `WITH RECURSIVE` under `src/daemon`. "Approved but not yet specced or built" at `graphrag-followon.md:9` still holds: no GraphRAG extractor or hop walker. Substrate that does exist: `content_embedding` at `src/daemon/storage/catalog/knowledge-graph.ts:153`, `codebase` at `src/daemon/storage/catalog/product.ts:314`, `RRF_K = 60` at `src/daemon/runtime/memories/recall.ts:238`.
- Verdict: HOLE
- Action: REVISE

### D-19 Pollinating is a job worker, not a captured session

- Quote: "Pollinating is not a hidden worker. It goes through the normal session-start hook, captures a transcript, and gets summarized at the end like any other session." and "A pass loads four things: the startup identity files ... `MEMORY.md` ... `POLLINATING.md`".
- Doc: `library/knowledge/private/ai/pollinating-loop.md:50` and `:54`
- Grounding: `src/daemon/runtime/pollinating/worker.ts:22` leases a `pollinating` job and calls `runner.runPass`. `src/daemon/runtime/pollinating/worker.ts:290` builds the incremental strategy with only `maxInputTokens`. That uses `defaultPollinatingIdentitySource` at `src/daemon/runtime/pollinating/incremental.ts:124`, which returns empty identity files, empty prior sessions, and empty `MEMORY.md`. No session-start hook and no transcript write on this path.
- Verdict: FALSE
- Action: REVISE

### D-20 Graph-query tool is prompt text, not a model call

- Quote: "with a query tool available to inspect the rest of the graph on demand."
- Doc: `library/knowledge/private/ai/pollinating-loop.md:56`
- Grounding: `createGraphQueryTool` is defined at `src/daemon/runtime/pollinating/incremental.ts:374` and exported from `pollinating/index.ts:81`. Nothing in `src` calls it. `incremental.ts:481` only pastes the tool names into the prompt. `ModelClient.complete` is one text completion (`src/daemon/runtime/pipeline/model-client.ts:71`).
- Verdict: FALSE
- Action: REVISE

### D-21 Pollinate ack omits the below-threshold status

- Quote: "Once enabled, the live trigger flips: `POST /api/diagnostics/pollinate` returns `{triggered:true, status:"enqueued"}` at/over threshold (or `status:"running"` when a pass is already pending)."
- Doc: `library/knowledge/private/ai/pollinating-loop.md:32`
- Grounding: those two statuses exist at `src/daemon/runtime/pollinating/api.ts:210` and `:225`. A third, `below_threshold`, returns `{triggered:true, status:"below-threshold"}` at `api.ts:214`. The disabled ack `{triggered:false, status:"skipped", reason:"disabled"}` does match `api.ts:212` plus `trigger.ts:388`.
- Verdict: HOLE
- Action: REVISE

### D-22 Live consolidation proof is credential-skipped

- Quote: "PRD-026 proved this end-to-end against live DeepLake ... So the consolidation promise rests on observed behavior on real data, not on an unrun loop."
- Doc: `library/knowledge/private/ai/pollinating-loop.md:33`
- Grounding: `tests/integration/pollinating-consolidation-live.itest.ts:26` is `describe.skipIf` unless `HONEYCOMB_DEEPLAKE_TOKEN` and `ANTHROPIC_API_KEY` are set, and `:30` keeps it out of `npm run ci`. The page states the result as observed. This tree does not record a passing live run.
- Verdict: HOLE
- Action: REVISE

### D-23 Router sample YAML and workload names do not parse

- Quote: the `inference:` sample with `targets[].name`, `policies[].name`, `capabilities: [completion, caching]`, a workloads map, and `taskClass`, plus "Three workloads ... `memory_extraction`, `session_synthesis`, and `interactive`."
- Doc: `library/knowledge/private/ai/model-provider-router.md:25` and `:71`
- Grounding: `src/daemon/runtime/inference/config.ts:86` requires target `id`, not `name`. `config.ts:96` requires policy `id`. `config.ts:122` workloads are an array. `src/daemon/runtime/inference/contracts.ts:111` capabilities are `chat | streaming | vision | tools`. `taskClass`, `session_synthesis`, and `interactive` are ABSENT under `src`. Live workload tokens are `memory_extraction`, `memory_decision`, `memory_pollinating` at `src/daemon/runtime/pipeline/model-client.ts:38`. Committed `agent.yaml:38` declares only `memory_pollinating`.
- Verdict: FALSE
- Action: REVISE

### D-24 `honeycomb route` CLI is not the registered surface

- Quote: "The CLI tools (`honeycomb route list / status / doctor / explain / test / pin / unpin`) are implemented and registered."
- Doc: `library/knowledge/private/ai/model-provider-router.md:90`
- Grounding: those verbs are implemented in `src/cli/route.ts:20` (`routeMain` at `:464`) and nothing imports that module. The registered verb is the generic storage mapper at `src/commands/storage-handlers.ts:43`, which posts to `/api/inference/routes`. `mountInferenceGateway` (`src/daemon/runtime/inference/gateway.ts:103`) is not called from `assemble.ts`. Its routes are `/status`, `/history`, `/explain`, `/execute`, `/stream`, not `/routes`. The page's "not yet mounted" claim at `model-provider-router.md:74` holds.
- Verdict: FALSE
- Action: REVISE

### D-25 Rate-limit buckets and concurrency bounds are absent

- Quote: "The router validates any target override, clamps request bodies and headers, redacts errors, applies rate-limit buckets, and bounds concurrency."
- Doc: `library/knowledge/private/ai/model-provider-router.md:109`
- Grounding: body clamp and redaction are in `src/daemon/runtime/inference/gateway.ts:252` and `:491`, and that gateway is unmounted (D-24). No `rateLimit`, bucket, or concurrency cap under `src/daemon/runtime/inference`. In-memory 401 expiry does exist at `src/daemon/runtime/inference/router.ts:97` and `:401`, which matches the "not yet persisted" sentence at `model-provider-router.md:113`.
- Verdict: FALSE
- Action: REVISE

### D-26 Portkey fallback retries every error

- Quote: "on an unreachable or transport gateway error, routes the SAME request through the per-provider path ... A non-transport error (for example the provider path also exhausting) propagates."
- Doc: `library/knowledge/private/ai/portkey-gateway.md:84`
- Grounding: `src/daemon/runtime/inference/model-client-factory.ts:550` catches every error from the Portkey client (`void err`) and calls the provider client. There is no transport-only filter. A later provider failure can still propagate from the second call.
- Verdict: FALSE
- Action: REVISE

### D-27 Portkey health omits `no_model`

- Quote: the closed list `off`, `ok`, `unconfigured`, `unreachable`.
- Doc: `library/knowledge/private/ai/portkey-gateway.md:92`
- Grounding: `src/daemon/runtime/health.ts:134` is `"off" | "ok" | "unconfigured" | "no_model" | "unreachable"`. Assembly sets `no_model` when the gateway is on and `activeModel` is empty (`src/daemon/runtime/assemble.ts:4177`). The 502-malformed case still does not call `reportTransportError` (`src/daemon/runtime/inference/transport-portkey.ts:276`), so that sentence on the page holds.
- Verdict: HOLE
- Action: REVISE

### D-28 Portkey settings UI path is absent

- Quote: "the dashboard surface is in `src/dashboard/web/panels.tsx` (`PortkeyGatewaySection`) and `pages/settings.tsx`."
- Doc: `library/knowledge/private/ai/portkey-gateway.md:36`
- Grounding: ABSENT. No `Portkey` string under `src/dashboard` or `src/daemon/runtime/dashboard`. The vault keys do exist: `src/daemon/runtime/vault/api.ts:105` (`portkey.enabled`, `portkey.config`, `portkey.fallbackToProvider`) and the open-ended catalog row at `src/daemon/runtime/vault/catalog.ts:88`.
- Verdict: FALSE
- Action: REVISE

## Checked claims that hold (do not revise these away)

- Lifecycle flag defaults in `memory-lifecycle-config.md:37` match `src/shared/lifecycle-flags.ts:36`. Half-lives 180 / 45 / 10 match `src/daemon/runtime/recall/config.ts:180`.
- `effectiveStalenessExponent` returns 0 unless posture is `execute`, and an execute posture with exponent 0 uses 1: `src/daemon/runtime/memories/lifecycle-config.ts:337`. That matches `memory-lifecycle-config.md:60`.
- Conflict resolve route `POST /api/memories/conflicts/:id/resolve` is `src/daemon/runtime/memories/conflicts-api.ts:245`. CLI verbs in `src/commands/memory.ts:13` match the as-built CLI list.
- Pollinating default `enabled: false`, threshold 100000, max input 128000, `backfillOnFirstRun: true`: `src/daemon/runtime/pollinating/config.ts:35` and `:57`. Vault `pollinating.enabled` wins over env: `src/daemon/runtime/assemble.ts:2348`. `honeycomb pollinate trigger --compact` is wired at `src/commands/pollinate.ts:126`.
- `mountInferenceGateway` is implemented and not called from `assemble.ts`. Portkey synthetic config is one `strict` policy and workloads `memory_extraction`, `memory_decision`, `memory_pollinating`: `src/daemon/runtime/inference/model-client-factory.ts:518`. Wire constants match `src/daemon/runtime/inference/transport-portkey.ts:77`. `DEFAULT_RERANKER` is `none` and the Cohere timeout is 1000 ms: `src/daemon/runtime/recall/config.ts:85` and `:99`. The real rerank client is built only when a Portkey selection exists: `src/daemon/runtime/assemble.ts:4199`.
- Entity type list matches `src/daemon/runtime/ontology/contracts.ts:44`. Proposal operations match `contracts.ts:229`. Epistemic predicates match `contracts.ts:322`. New edges go to `entity_dependencies`, and the legacy `relations` table is not written: `src/daemon/runtime/ontology/dependencies.ts:350`.
- `createEmbedAttachment` exists at `src/daemon/runtime/services/embed-client.ts:348`. No `noopEmbedClient` file remains under `src`. The scoring worked example is consistent with that deletion.
- PRD-058 is still under `library/requirements/in-work/prd-058-memory-lifecycle/`. The as-built "in-work because live eval is credential-gated" claim was not overturned by this shard.

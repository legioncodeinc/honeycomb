# Retrieval lens

Date: 2026-10-04. Repository: honeycomb. Read-only code trace of `src/daemon` recall against the working tree of `library/knowledge/private/ai/retrieval.md` (Version 2.5, October 2026). Live recall quality was not executed. No credentials, no `npm install`.

Status labels: VERIFIED means the claim matches current source. REPORTED means a comment, ledger, or the knowledge doc states a measurement this pass did not re-run. UNVERIFIABLE-HERE means a live corpus, embed daemon, or Deep Lake workspace would be required.

## How recall runs

`POST /api/memories/recall` in `mountMemories` (`src/daemon/runtime/memories/api.ts`, handler near line 750) picks the engine at line 806: `parsed.data.fast === true` calls `recallFast`, otherwise `recallMemories` (`src/daemon/runtime/memories/recall.ts`). The per-turn hook sends `fast: true` from `createRecallRenderer` (`src/hooks/shared/recall-renderer.ts`).

Lexical search is not BM25. `buildLexicalMatchSql` emits tokenized `ILIKE` (whole phrase, or phrase OR an AND of up to 8 tokens). The comment at `recall.ts` lines 519-530 states Deep Lake `deeplake_index` is not wired. Four arms, each its own `storage.query` via `runArm`: `buildMemoriesArmSql`, `buildMemoryArmSql`, `buildSessionsArmSql`, `buildHiveGraphVersionsArmSql`.

Vector search, when the query embeds to 768 floats (`EMBEDDING_DIMS` in `src/daemon/storage/vector.ts`), runs `<#>` cosine normalized as `((1 + (emb <#> vec)) / 2)` in `buildVectorSearchSql` and `buildFastSemanticArmSql`. Semantic tables are `memories.content_embedding`, `sessions.message_embedding`, and `hive_graph_versions.embedding` (`SEMANTIC_ARMS`). The `memory` table declares `summary_embedding` but `embeddingColumnFor` returns null, so summaries stay lexical.

Fusion is `fuseHits`: Reciprocal Rank Fusion with `RRF_K = 60`, class weights `memory` 1.0 and `session` 0.4 (`ARM_CLASS_WEIGHT`, `kindOfSource`). `hive_graph_versions` is class `memory`, then scaled by `nectar_rrf_multiplier` (default 1, clamp `[0, 10]`). `hybridRecall` in `hybrid-recall.ts` (native `deeplake_hybrid_record`) has no production caller.

Embeddings off, a cold embed gate, a null or wrong-dim vector, or an embed deadline all drop the semantic arms and set `degraded: true`. Lexical arms still run. Recall does not throw on that path (`boundedEmbed`, `runSemanticArms`).

## Findings

### retrieval-1. Lexical path is tokenized ILIKE, not BM25. VERIFIED

`buildLexicalMatchSql` (`recall.ts`) builds `ILIKE` predicates through `sqlLike`. Single usable token: one `ILIKE`. Multi-token: whole-phrase `ILIKE` OR an AND of per-token `ILIKE`. `rowsToPhraseRankedArm` ranks phrase hits above token-only hits in process. `deeplake_index` is not called. `buildLexicalDegradeSql` in `vector.ts` is a separate lexical-degrade builder; `recallMemories` and `recallFast` do not call it. `hybridRecall` / `buildHybridArmSql` remain an unwired reference, matching the knowledge doc's "do not use `deeplake_hybrid_record`" section.

The file header at `recall.ts` lines 14-48 is older than the function bodies: it still says three tables, `sessions.message` as the lexical text, and "BM25/ILIKE". The four-arm implementation below it is the live path. The knowledge doc's mermaid label "tokenized ILIKE" matches the functions. Colloquial "BM25" in comments does not.

### retrieval-2. Arms, dimension, and cosine score. VERIFIED

| Arm | Lexical | Semantic column | Id |
|---|---|---|---|
| `memories` | `content`, `is_deleted = 0` | `content_embedding` | `id` |
| `memory` | `summary` | none (`embeddingColumnFor` returns null) | `path` |
| `sessions` | `COALESCE(NULLIF(prose,''), message::text)` | `message_embedding`; text projected is `message`, not `prose` | `path` |
| `hive_graph_versions` | `title` OR `description` OR `concepts`, latest `MAX(seq)` where `describe_status = 'described'` | `embedding`; text projected is `description` | `nectar` |

`EMBEDDING_DIMS = 768` (`src/daemon/storage/vector.ts`). `assertEmbeddingDim` rejects a non-768 or non-finite query vector before SQL. `SESSIONS_EMBEDDING_DIMS = 768` in `embed-client.ts`. A store-path vector whose length is not 768 is rejected to null (`embed.dim_rejected` / `attach.dim_rejected`), not written. `HONEYCOMB_EMBEDDINGS` is opt-out: only `false` or `0` disables (`resolveEmbedClientOptions`).

Heavy semantic arms: `runSemanticArm` calls `vectorSearch` (ids and score, over-fetch default 3x) then `buildSemanticHydrateSql`. Fast semantic arms: `buildFastSemanticArmSql` returns text and `created_at` in one statement. Project scope is ANDed inside each statement via `projectConjunctFor` -> `buildProjectScopeConjunct`, not applied after ranking.

### retrieval-3. Shaping order in the knowledge doc is stale. VERIFIED

`retrieval.md` mermaid and the shaping table say the live order is fuse, `rerankHits` (default `none`), `dedupHits` (default on), `applyRecencyDampening` (half-life about 100 years, off-equivalent), then optional `selectWithinTokenBudget`.

`recallMemories` actually does:

1. `fuseHits`
2. `rerankHits` unless strategy is `none`, or the strategy is not `cohere` and there is no query vector. Default `DEFAULT_RERANKER = "none"`. `embedding-cosine` budget `DEFAULT_RERANKER_TIMEOUT_MS = 300`. Cohere model `DEFAULT_RERANKER_COHERE_MODEL = "rerank-v3.5"`, provider budget `DEFAULT_RERANKER_PROVIDER_TIMEOUT_MS = 1000`.
3. `dedupHits` with `DEFAULT_DEDUP_ENABLED = true` and threshold `0.9`
4. `resolveStaleness` then either `applyActrActivation` (when `activationSource` is set) or `applyRecencyActivation`
5. `applyCalibrationStage` when a calibration model is set
6. `applyConflictGate` when `conflictSuppression` is set
7. optional `selectWithinTokenBudget` when `tokenBudget` is positive, then `recordRecallAccessEvents`

`applyRecencyDampening` is still exported. Production `recallMemories` and `recallFast` do not call it. Tests in `recency-dampening.test.ts` do. `DEFAULT_RECENCY_HALF_LIFE_DAYS = 36500` remains the dampener knob. The live Stage-1 defaults are `DEFAULT_RECENCY_HALF_LIFE_DAYS_BY_CLASS`: `memories` 180 days, `memory` 45 days, `sessions` 10 days, exponent `DEFAULT_RECENCY_ACTIVATION_EXPONENT = 1.0`. `recencyClassOf` puts `hive_graph_versions` on the `memories` half-life.

`assemble.ts` wires `createActivationSource`, `createStalenessSource`, `calibrationModelProvider`, and `createConflictSuppressionSource` into `mountMemories`. Those stages are not dormant on the heavy path. Staleness exponent defaults to identity under the observe posture (`DEFAULT_STALENESS_EXPONENT = 0`). Confidence exponent is documented in assemble as default 0, so calibration stamps confidence and does not reorder until that exponent is raised.

`recallFast` keeps `fuseHits` and `applyRecencyActivation` only. It does not call rerank, dedup, ACT-R, staleness, calibration, conflict suppression, or access recording.

Stale sentences:

- Mermaid node `recency["applyRecencyDampening: age-decay multiplier (default off-equivalent)"]`. Correction: the live multiplier is `applyRecencyActivation` (`A = 2^(-age/halfLife)`), class half-lives 180/45/10 days, exponent 1.0. The heavy path may replace that with `applyActrActivation` and then run calibration and `applyConflictGate`.
- Table row "Recency dampening | `applyRecencyDampening` | off-equivalent (half-life ≈ 100 years)". Same correction. The 100-year constant is the unused dampener default.
- "Applied last among score adjustments" and "Shipped with a near-infinite default half-life so it is neutral until a caller tunes it." Correction: activation runs after dedup and before calibration, the conflict gate, and the token budget. It is not neutral at the defaults.
- "the dormant lifecycle stages" in the per-turn section. Correction: lifecycle seams are injected on the heavy path from `assemble.ts`. The fast path omits them. They are not dormant on `recallMemories`.

### retrieval-4. Agent read-policy is not on the live recall SQL. VERIFIED

`retrieval.md` Authorization says the org/workspace partition is `QueryScope`, and that `buildScopeClause` in `scope-clause.ts` enforces `isolated`, `shared`, and `group` before any content-bearing column is returned.

`recall.ts` imports `buildProjectScopeConjunct` only. `buildMemoriesArmSql` filters `is_deleted = 0` plus the project conjunct. It does not add `agent_id` or `visibility`. `recallFast` uses the same builders. `src/daemon/runtime/recall/CONVENTIONS.md` already says the live path is `recallMemories` under `QueryScope`, and that the agent clause is the chokepoint reused by browse and tenancy proofs.

`buildScopeClause` still implements the three policies and is exported from `recall/index.ts`. `collection.ts` still builds an `agent_id` conjunct for the VFS candidate collector. That is not the `POST /api/memories/recall` engine.

The mermaid places `scope` after token-budget assembly. Correction: org/workspace is the `QueryScope` argument on every `storage.query`. Project scope is inside each arm's WHERE before fusion. There is no post-rank agent-policy stage on this route.

Stale sentence: "Within a workspace, the `agent_id` read-policy clause (built by `buildScopeClause` ...) enforces the three read policies: `isolated`, `shared`, and `group`. No content-bearing column is returned before these filters are applied." Correction: scored recall returns content after org/workspace partition, project conjunct, and (for `memories`) `is_deleted = 0`. It does not apply `buildScopeClause`.

### retrieval-5. Fast lane deadlines and the client timeout. VERIFIED

`recallFast` (`recall.ts`):

- `resolveFastLaneOrShed`: dedicated fast pool, default `DEFAULT_RECALL_FAST_MAX_CONCURRENCY = 8`. Sheds when `waiting` exceeds `DEFAULT_RECALL_FAST_SHED_QUEUE_DEPTH = 8`, returns `{ hits: [], degraded: true }`, and can emit `recall.shed` with lane, depth, and threshold only.
- Embed is bounded by `DEFAULT_RECALL_FAST_EMBED_DEADLINE_MS = 1500` via `boundedEmbed`. Heavy embed bound is `DEFAULT_RECALL_HEAVY_EMBED_DEADLINE_MS = 3000`.
- Arm deadline `AbortSignal.timeout(DEFAULT_RECALL_FAST_DEADLINE_MS)` with default 3000. `captureArmsToSlots` keeps rows that already settled. If the local ANN arm has rows, they are fused even when Deep Lake arms miss the cut (`memoriesIndexRows`).
- Heavy fan-out uses `DEFAULT_RECALL_HEAVY_DEADLINE_MS = 15000`.

Read/write storage split matches the doc: `MAX_CONCURRENT_QUERIES = 5` (`src/daemon/storage/client.ts`) and `DEFAULT_WRITE_MAX_CONCURRENCY = 3` (`amplification-config.ts`). Separate from those client semaphores, recall arms use `DEFAULT_RECALL_MAX_CONCURRENCY = 6` unless a fast pool is injected.

`retrieval.md` says `DEFAULT_RECALL_TIMEOUT_MS` moved from 2500 to 4000. Current hook constant is `DEFAULT_RECALL_TIMEOUT_MS = 6_000` in `src/hooks/shared/recall-renderer.ts`. The comment there says PRD-077b set 4000 and ISS-022 raised it to 6000 because live per-turn recalls measured 3.0 to 4.6s. The unit test expects 6000. The daemon fast deadline stays 3000.

Stale sentence: "Live-verified, `recall.timing armsMs` dropped from 73,273 to 3,012, and `DEFAULT_RECALL_TIMEOUT_MS` moved from 2500 to 4000." Correction: the constant is 6000 in `recall-renderer.ts`. The 73273 to 3012 delta is REPORTED in that paragraph and in code comments (`armsMs: 73273` in `amplification-config.ts`). This pass did not re-measure it.

### retrieval-6. Local ANN covers one arm, not the whole fast path. VERIFIED

`InMemoryLocalVectorIndex` (`local-vector-index.ts`) stores `id` to `{ vec: Float32Array(768), content, createdAt, projectId, isDeleted, memoryType }`. `coldBuildLocalVectorIndex` pages `memories` off the hot path. `search` scores with `deeplakeCosineScore`, which returns `cosineSimilarity` so the `((1 + cos) / 2)` scale matches `buildVectorSearchSql`. `HONEYCOMB_LOCAL_ANN_INDEX` defaults on (`DEFAULT_LOCAL_ANN_INDEX = true`). `resolveMemoriesIndexRows` serves the index only when the flag is on, `ready` is true, and the query vector is 768-dim. Otherwise that arm uses `<#>` SQL. Sessions, hive semantic, and all four lexical arms still query Deep Lake.

No write-through, watermark pull, eviction, or HNSW symbol exists under `src/`. The module comment defers those to later PRDs. The "not yet built" sentence in the knowledge doc matches the tree.

Stale sentence: "with content stored inline, so the fast path needs zero DeepLake round-trips." Correction: inline content removes the hydrate hop for the `memories` semantic arm only. A ready index still issues the other fast-lane SQL arms.

`recall.index.built` and `annHits` on `recall.timing` match the doc. Sub-100ms and "identical top-5 to Deep Lake" are REPORTED in comments (`local-vector-index.ts`, the knowledge doc). Not re-measured here.

### retrieval-7. Embeddings-off fallback, plus a keyword mode the doc omits. VERIFIED

`runSemanticArms` returns no semantic run when `deps.embed` is absent, when `embedGate.ready()` is false (`embed_not_ready`), or when `boundedEmbed` yields null or a non-768 vector (`embed_timeout` or `embed_unavailable`). `recallMemories` sets `degraded` true unless `deps.recallMode === "keyword"`, which skips semantic on purpose and forces `degraded: false`. `recallFast` sets `degraded` when the embed did not produce 768 dims, and also when the arm deadline fires (`fastDegraded`). Empty query returns `degraded: true` and no hits on both engines.

`retrieval.md` lines that say embeddings are opt-out, 768-dim, and that a failed embed still answers with lexical `ILIKE` match this code. The citation `recall.ts:37-48` points at the stale header comment, not at `runSemanticArms` (about line 1655) or the `degraded` assignment (about line 2816).

Omission, not a false sentence: `recallMode === "keyword"` is an intentional lexical run with `degraded: false`. The doc's "degraded true only on genuine fallback" does not mention that mode.

### retrieval-8. Session semantic hits still return `message`, not `prose`. VERIFIED

`buildSessionsArmSql` matches and returns `COALESCE(NULLIF(prose, ''), message::text)`. `SEMANTIC_ARMS` for `sessions` sets `textColumn: "message"`. `buildFastSemanticArmSql` and `buildSemanticHydrateSql` project that column. A semantic session hit can still be the JSON envelope. The lexical arm is the one PRD-074 cleaned up.

The knowledge doc's prose paragraph is accurate if read as lexical-only. It does not say the semantic arm still projects `message`. That gap matters because hybrid recall merges both arms into the same hit list.

### retrieval-9. Nectar config path and the "not shipped" section. VERIFIED

`readNectarRrfMultiplier` (`nectar-recall-config.ts`) reads fleet-root `~/.apiary/nectar/nectar.json` first, then legacy `~/.honeycomb/nectar.json` (`preferExistingPath`). Clamp `[0, 10]`, default 1.0, fail-soft, boot log `recall.nectar_rrf_multiplier` when not 1.0. `fuseHits` multiplies only `hive_graph_versions`. Those mechanics match the doc. The path sentence does not.

Stale sentence: "read once at boot ... from `~/.honeycomb/nectar.json`". Correction: new path first (`resolveFleetRoot()` + `nectar/nectar.json`), legacy `~/.honeycomb/nectar.json` second.

The "Planned" section says UserPromptSubmit is capture-only, PreToolUse is stubbed at `runtime.ts:252` and `pre-tool-use.ts:96`, and "Docs-only so far: no code has shipped." Current code contradicts that:

- `src/hooks/claude-code/shim.ts` maps `UserPromptSubmit` to `user_prompt_recall`.
- `runtime.ts` constructs `createRecallRenderer` and, near line 255, `createDaemonVfsIntercept`. The comment says this is the real seam, not `createFakeVfsIntercept()`.
- `runPreToolUse` (`pre-tool-use.ts`) uses `deps.vfs` and recognizes a `honeycomb recall` / `honeycomb search` sentinel.
- `recall-renderer.ts` posts `fast: true`.
- `session-start.ts` mentions the `honeycomb recall` command in the notice string.

`createFakeVfsIntercept` remains the default parameter when `deps.vfs` is missing (unit tests). Chunking for session recall (`matchRange`, PRD-075 windowing) was not found as a recall-arm feature. `chunkText` in `document-worker.ts` is the document worker, not the recall snippet window. The ADR "code is not" claim for session chunking still holds. The "no code has shipped" sentence for the whole planned section does not.

### retrieval-10. Fusion weights the doc states, with one wording slip. VERIFIED

`RRF_K = 60`. Contribution is `(ARM_CLASS_WEIGHT[kind] * sourceMultiplier) / (RRF_K + rank)`. `kindOfSource` maps only `sessions` to `session` (weight 0.4). `memories`, `memory`, and `hive_graph_versions` are kind `memory` (weight 1.0) before the nectar multiplier. Identity key is `source + id` via `fusionKey`. Order is score descending, then distilled before raw, then id.

Stale wording: "distilled `memory` summaries weight 1.0, raw `session` rows weight 0.4." Correction: weight 1.0 is the `RecallKind` `memory`, which includes kept facts, summaries, and hive-graph rows. Raw `sessions` rows are the 0.4 class. Hive-graph rows are then multiplied by `nectar_rrf_multiplier` inside `fuseHits`. The following nectar section in the doc is consistent with that.

Cohere double gate matches the doc at the code level: `skipRerank` still enters `rerankHits` for strategy `cohere` without a vector; `rerankWithCohere` needs the injected seam and fails soft to RRF order. Whether a live Portkey call beats RRF is UNVERIFIABLE-HERE.

### retrieval-11. Line citations that drifted. VERIFIED

| Doc citation | What is there now |
|---|---|
| `api.ts:405` "sole production caller" | Line 405 is the `cwd` field on the recall body schema. The route is the `POST /api/memories/recall` handler near line 750. Engine select is line 806. Tests also call `recallMemories` directly. The HTTP production entry is still that route. |
| `recall.ts:37-48` lexical fallback | Header comment. Implementation is `boundedEmbed`, `runSemanticArms`, and the `degraded` flags in `recallMemories` / `recallFast`. |
| `recall.ts:546` and call sites `584-715` | `buildLexicalMatchSql` is line 546. Arm call sites are 584, 608, 666, and 713-715. Still inside that span. |
| `recall.ts:519-530` `deeplake_index` comment | Still that comment. |
| `SEMANTIC_ARMS` `1375-1409` | Array starts at 1376 and the hive arm ends at 1410. |
| `embeddingColumnFor` `1695-1705` | Function is lines 1700-1705. |

`recall.ts` line 1375 comment still says "The two semantic arms". The array has three. The knowledge doc's three-arm list is the one that matches the array.

### retrieval-12. Live quality and the nDCG gate. UNVERIFIABLE-HERE

`src/eval/golden.ts` (`runEval`) and `src/eval/metrics.ts` (`ndcgAtK`, `RelevanceClasses`) exist. `package.json` script `eval:recall` is `node scripts/eval-recall.mjs`. `npm run ci` is typecheck, dup, unit tests, and `audit:sql`. It does not run `eval:recall`.

This pass did not run the harness and has no Deep Lake credentials. The following knowledge-doc numbers stay UNVERIFIABLE-HERE: recall@5 0.72-0.78 versus the native operator, the 2026-06-24 tie at 0.611, reranker "~0 lift", `<#>` at ~2.6s for ~2,004 rows, `armsMs` 73273 to 3012, and "identical top-5" for the local index. They are REPORTED by the knowledge doc and by comments in `vector.ts`, `local-vector-index.ts`, and `recall/config.ts`. Code structure does not prove those measurements still hold.

"Every ranking change is provable" and "a change that regresses it fails the eval" describe the harness, not the CI gate. A ranking change can merge on `npm run ci` without `eval:recall`.

## Punch list against `retrieval.md`

1. Replace `applyRecencyDampening` / 100-year half-life as the live stage with `applyRecencyActivation` (180/45/10 days, exponent 1.0) and the heavy-path ACT-R, staleness, calibration, and conflict gate.
2. Stop saying `buildScopeClause` filters scored recall. Say `QueryScope` plus `buildProjectScopeConjunct`, applied inside each arm.
3. Change `DEFAULT_RECALL_TIMEOUT_MS` from 4000 to 6000 (`src/hooks/shared/recall-renderer.ts`).
4. Narrow "zero DeepLake round-trips" to the `memories` semantic arm when the local index is ready.
5. Point nectar config at `~/.apiary/nectar/nectar.json`, then `~/.honeycomb/nectar.json`.
6. Rewrite the planned section: per-turn `fast: true` recall and a real PreToolUse VFS seam are in `src/hooks`. Session snippet chunking is still absent from the recall arms.
7. Fix `api.ts:405` to the handler near line 750 and the `fast` branch at line 806.
8. Say lexical arms are tokenized `ILIKE`. Reserve BM25 for the unwired `hybrid-recall.ts` operator.
9. Note semantic `sessions` hits still project `message`, while the lexical arm projects `prose`.
10. Mark live recall@k, latency, and operator A/B figures as reported, and note `eval:recall` is outside `npm run ci`.

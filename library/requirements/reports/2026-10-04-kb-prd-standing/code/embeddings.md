# Wave 2 code standing: embeddings

Date: 2026-10-04. Branch context: `legion/kb-sotu-and-prd-lifecycle`. Read-only. No knowledge page, PRD, ADR, or source file was edited. No commit.

Shard: embeddings default, GPU labels, the local ANN hole, PRD-025, and PRD-078. Other defects in the wave 1 files were not re-judged.

ASCII hyphens only. Each row is CONFIRM (apply the wave 1 action) or OVERTURN (do not apply it).

## Tally

Doc edits judged: 9. CONFIRM: 8. OVERTURN: 1.

| Item | Wave 1 action | Standing |
|---|---|---|
| ai-recall D3, login owns the embed daemon | REVISE | CONFIRM |
| ai-recall H1, embeddings opt-out default | LEAVE | CONFIRM |
| ai-recall H6, local ANN flag and 078b/c | LEAVE | CONFIRM |
| infra D-12, GPU-backed DeepLake labels | REVISE | OVERTURN |
| infra H-04, embedder URL, model, default on | LEAVE | CONFIRM |
| architecture-adrs local ANN hole | ADD candidate, do not number | CONFIRM |
| architecture-adrs embeddings default-on ADR | do not ADD | CONFIRM |
| PRD-025 bucket | stay completed | CONFIRM |
| PRD-078 bucket | stay in-work, fix the status line | CONFIRM |

PRD acceptance-criterion verdicts sit inside the two bucket rows. They are not extra doc edits. All 7 PRD-025 verdicts and all 7 PRD-078 verdicts are confirmed below.

## ai-recall: embedding default

### D3 - CONFIRM REVISE

- Quote: "`honeycomb login` provisions and owns the embed daemon"
- Doc: `library/knowledge/private/ai/retrieval.md:47`
- Wave 1: FALSE, REVISE (`knowledge/ai-recall.md` D3)
- Code: `embeddings/src/index.ts:6-9` says the Hivemind daemon spawns, health-checks, and crash-restarts the child. `src/daemon/runtime/services/embed-supervisor.ts:4-9` is that owner: `start()` on daemon start, `stop()` on daemon stop. `start()` is `embed-supervisor.ts:912`, `stop()` is `:931`, `restart()` is `:960`. Assembly wires it at `src/daemon/runtime/assemble.ts:3326-3337`.
- `honeycomb login` does not. `src/cli/auth.ts` has no embed, port, or `HONEYCOMB_EMBEDDINGS` reference. `src/cli/runtime.ts:495-497` routes `login` to the Deep Lake device flow and writes `~/.deeplake/credentials.json`.
- The supervisor's own comment at `embed-supervisor.ts:60-65` is the zero-config reading: unset or on spawns with no flag, "the fresh-`honeycomb login` zero-config default." Login does not spawn the child. First daemon start does.
- Writer action: keep the opt-out half of `retrieval.md:47` (that half is H1). Replace the login-owns clause with the daemon supervisor.

### H1 - CONFIRM LEAVE

- Quote: "`HONEYCOMB_EMBEDDINGS` is opt-out: unset/`true`/`1` is on, only an explicit `false`/`0` turns it off."
- Doc: `library/knowledge/private/ai/retrieval.md:46-47`
- Wave 1: HOLDS, LEAVE (`knowledge/ai-recall.md` H1)
- Code: `resolveEmbedClientOptions` at `src/daemon/runtime/services/embed-client.ts:169-172`. Trimmed lower-case `false` or `0` disables. Unset, `true`, `1`, and any other value stay enabled. Whitespace is included (` FALSE `, ` 0 `).
- Production uses that resolver. `createEmbedAttachment` calls it when no options are passed (`embed-client.ts:348-349`). Assembly passes no options (`assemble.ts:3561-3564`). The supervisor uses the same resolver (`embed-supervisor.ts:520-524`).
- `noopEmbedClient` remains at `embed-client.ts:118-121` and is not the production attachment.
- Model and width match the same sentence's neighbors: `MODEL_ID` `nomic-ai/nomic-embed-text-v1.5` and `EMBED_DIMS = 768` at `embeddings/src/index.ts:42-46`. Non-768 client responses return null at `embed-client.ts:271-274`. The child throws on a wrong-length vector at `embeddings/src/index.ts:213-216`.
- A saved vault setting `embeddings.enabled` wins at boot when it is present (`assemble.ts:2376-2394`), then the env default. That is an extra override. It does not make unset embeddings off. Do not revise this page back to opt-in.

### H6 - CONFIRM LEAVE

- Quote: "`HONEYCOMB_LOCAL_ANN_INDEX` (default on)"; `InMemoryLocalVectorIndex`; 078b/c freshness and HNSW not built
- Doc: `library/knowledge/private/ai/retrieval.md:123`
- Wave 1: HOLDS, LEAVE (`knowledge/ai-recall.md` H6). The zero-round-trip sentence on that line is D7 and was not re-judged here.
- Code: `DEFAULT_LOCAL_ANN_INDEX = true` at `src/daemon/runtime/memories/amplification-config.ts:42-48`. Class at `src/daemon/runtime/memories/local-vector-index.ts:180`. Score via `deeplakeCosineScore` at `local-vector-index.ts:252`. The module header still marks write-through and HNSW as later (`local-vector-index.ts:39-42`). No upsert, watermark pull, or `hnswlib` symbol in that file. `package.json` has no `hnswlib` dependency.

### GPU claims in this shard

`knowledge/ai-recall.md` recommends no GPU edit. `retrieval.md` does not call the embedder or Deep Lake GPU-backed. Do not add a GPU sentence to `retrieval.md`.

`library/knowledge/private/ai/session-capture.md:91` says the embedding daemon and "the GPU-backed vector search" are documented in `retrieval.md`. That file is outside this shard. `retrieval.md` does not contain that GPU sentence. The storage comments that do are under D-12.

## infra: GPU-backed DeepLake labels

### D-12 - OVERTURN REVISE

- Quote: "GPU-backed DeepLake storage." Mermaid node `DeepLake GPU-backed SQL + Vector`. Table cell "GPU-backed SQL + vector tables".
- Doc: `library/knowledge/private/overview.md:21`, `:45`, `:66`
- Wave 1: STALE, REVISE (`knowledge/infra-collab-sources-overview.md` D-12)
- Why overturn: those three labels name the Deep Lake store, not the local embed process. The wave 1 grounding points at `embeddings/src/index.ts`, which is a different process.

Local embedder, measured in source:

- Separate loopback process. `embeddings/src/index.ts:4-7`, bind `127.0.0.1:3851` at `:66-68`, client default `http://127.0.0.1:3851` at `embed-client.ts:145`.
- Quantization `q8`, comment "Footprint/latency floor for CPU inference" at `embeddings/src/index.ts:59-60`.
- Pipeline is `transformers.pipeline("feature-extraction", ...)` with `dtype: "q8"` at `embeddings/src/index.ts:187-190`.
- The inference note at `embeddings/src/index.ts:270-272` names onnxruntime's node thread pool or awaited WASM slices. No CUDA, GPU, or execution-provider selection appears in `embeddings/src/index.ts`.

Deep Lake store, still labeled GPU in this tree:

- `src/daemon/storage/vector.ts:1-12` titles the module "Vector columns and GPU-backed search" and says it builds "the GPU vector query" with `<#>`.
- `buildVectorSearchSql` is still commented "Build the GPU vector-search SQL" at `vector.ts:243`. The statement itself is `<#>` plus `((1 + (emb <#> vec)) / 2)` at `vector.ts:274`. It sends no device flag.
- Billing parses vendor GPU sessions: `SESSION_TYPES` and `gpu_hours` on `GET /billing/usage/compute` at `src/daemon/runtime/dashboard/roi-billing.ts:175-185`.

`overview.md:59` already says hosted GPU use was not re-probed, and it already names the loopback embedder. That caveat stays. Deleting "GPU-backed" from lines 21, 45, and 66 would make the overview disagree with `vector.ts` and with the billing client, on evidence that only shows the local embedder is CPU.

Writer action: leave the three labels. Do not revise them from the CPU embedder.

Same label, not judged as edits here (other shards own the pages): `library/knowledge/private/architecture/system-overview.md:50` and `:78`, `library/knowledge/private/data/deeplake-storage.md:5`, `library/knowledge/private/data/schema.md:119`, `library/knowledge/private/data/workspace-layout.md:20`. This overturn is the embeddings judgment on that class of label.

### H-04 - CONFIRM LEAVE

- Quote: embedder at `http://127.0.0.1:3851`, model `nomic-ai/nomic-embed-text-v1.5`, embeddings default on unless `HONEYCOMB_EMBEDDINGS=false` or `0`.
- Doc: `library/knowledge/private/overview.md:25` and `:59`
- Wave 1: HOLDS, LEAVE (`knowledge/infra-collab-sources-overview.md` H-04)
- Code: `embed-client.ts:145` and `:169-172`. `embeddings/src/index.ts:46` and `:66-68`. Matches H1. The local-queue half of the overview sentence was not re-walked here.

## architecture-adrs: local ANN hole only

### HOLE - CONFIRM ADD (candidate only)

- Wave 1: HOLE, ADD, do not number (`knowledge/architecture-adrs.md`, "In-daemon local ANN index"). Next free number stays 0012. This report does not claim it.
- Why it is still load-bearing: `local-vector-index.ts:1-17`. Deep Lake has no vector-index primitive, so fast recall's memories semantic arm is an in-RAM flat cosine index, default on, and `<#>` stays the cold fallback. Deep Lake stays the store.
- Default on: `amplification-config.ts:42-48`.
- Boot cold-build is fire-and-forget and non-fatal: `assemble.ts:3135-3157`.
- Fast path only: `recall.ts:3011-3029` (`resolveMemoriesIndexRows`), dropped memories `<#>` SQL at `recall.ts:3172-3184`, fusion still `fuseHits` at `recall.ts:3272-3275`. Assembly comment "Only the fast path reads it" at `assemble.ts:1624-1626`. The route threads the index only when `fast === true` (`src/daemon/runtime/memories/api.ts:806` and `:871-876`).
- `runSemanticArm` still calls `vectorSearch` and never reads the index (`recall.ts:1513-1534`). That is why 078 stays in-work, and why the hole is a candidate rather than a closed decision.
- ADR-0001 still holds beside it. This is not a second local-queue ADR.

### Embeddings default-on - CONFIRM do not ADD

- Wave 1: considered and not ADD (`knowledge/architecture-adrs.md`, "Considered and not ADD").
- `resolveEmbedClientOptions` treats unset as enabled (`embed-client.ts:160-172`).
- The reason is already PRD-025 D-1 at `library/requirements/completed/prd-025-semantic-recall-default/prd-025-semantic-recall-default-index.md:54-56`: "Default-on, not opt-in."
- Do not write a second ADR for this.

## PRD-025 - CONFIRM stay completed

- Folder: `library/requirements/completed/prd-025-semantic-recall-default/`
- Index status line: completed (`prd-025-semantic-recall-default-index.md:3`).
- Wave 1 bucket: stay completed (`prds/completed-017-026.md` summary and the PRD-025 section).
- No cited criterion is absent in a way that sends the folder back. Live bars stay unverifiable because this pass did not run them. That matches the wave 1 rule for a live itest or a green gate.

### AC-1 - CONFIRM MET

- PRD: `prd-025-semantic-recall-default-index.md:87-89`
- Unset is enabled: `embed-client.ts:169-172`. Unit test: `tests/daemon/runtime/services/embed-client.test.ts:189` ("enables by default when HONEYCOMB_EMBEDDINGS is UNSET"). Opt-out cases follow at `:204-216`.
- The daemon owns the process (D-6), not the login command. Scope text already allows "honeycomb login (or first daemon run)" at `prd-025-semantic-recall-default-index.md:34-36`. Supervisor zero-config is `embed-supervisor.ts:60-65`. No test name says login provisions the embed daemon. That missing gated check does not reopen the PRD. It is the knowledge-page error in D3.

### AC-2 - CONFIRM UNVERIFIABLE

- PRD: `prd-025-semantic-recall-default-index.md:90-93`
- Production seam is `createEmbedAttachment` at `assemble.ts:3564`, not `noopEmbedClient`. Columns: `content_embedding` at `src/daemon/storage/catalog/memories.ts:78`, `message_embedding` at `src/daemon/storage/catalog/sessions-summaries.ts:41` (wave 1 citation; not re-opened here beyond the memories column, which is present). A live read-back was not performed.

### AC-3 - CONFIRM MET

- PRD: `prd-025-semantic-recall-default-index.md:94-97`
- `degraded` is `keywordOnly ? false : semanticRun === null` at `recall.ts:2812-2816`. The old hard-coded `degraded: true` at a recalled line 255 is not that assignment. `src/daemon/runtime/recall.ts` is absent; recall lives in `src/daemon/runtime/memories/recall.ts`.
- Keyword mode forces `degraded: false` on purpose (`recall.ts:2768-2777`). That is a later mode, not the embeddings-off path. Embeddings off still takes the null semantic run and `degraded: true`.

### AC-4 - CONFIRM UNVERIFIABLE

- PRD: `prd-025-semantic-recall-default-index.md:98-103`
- `tests/integration/semantic-recall-live.itest.ts` exists. It was not executed.

### AC-5 - CONFIRM UNVERIFIABLE

- PRD: `prd-025-semantic-recall-default-index.md:104-106`
- `stop()` and `restart()` exist at `embed-supervisor.ts:931` and `:960`. Recall sets `degraded` when the semantic run is null (`recall.ts:2816`). A live kill and restart was not performed.

### AC-6 - CONFIRM MET

- PRD: `prd-025-semantic-recall-default-index.md:107-109`
- `EMBEDDING_DIMS = 768` at `vector.ts:35`. Child lock `EMBED_DIMS = 768` at `embeddings/src/index.ts:43`. Client reject to null at `embed-client.ts:272-274`. Schema comment "nullable 768-dim `FLOAT4[]`" at `src/daemon/storage/catalog/memories.ts:47`. A live store assertion was not re-run. The reject path is in source, which is the wave 1 bar for MET.

### AC-7 - CONFIRM UNVERIFIABLE

- PRD: `prd-025-semantic-recall-default-index.md:110-113`
- `npm run ci`, pack, and the secret grep were not run. The optional-dep comment at `package.json:137-140` still says `@huggingface/transformers` is optional and the model is not in the published tarball. That comment is not a green gate.

## PRD-078 - CONFIRM stay in-work

- Folder: `library/requirements/in-work/prd-078-local-ann-recall-index/`
- Index status line still says `Backlog (in-work - Phase 1 dispatched)` at `prd-078-local-ann-recall-index-index.md:3`.
- Wave 1 bucket: stay in `in-work`. Do not move to `completed`. Do not move back to `backlog`. Update the status line so it no longer says `Backlog`. No `git mv`.
- Confirmed. Phase 078a is in source. a-AC-3 and a-AC-7 are unmet. 078b and 078c are absent. `qa/` contains only `.gitkeep`.

### a-AC-1 - CONFIRM MET

- Entry is `id` to `Float32Array` plus `content`, `createdAt`, `projectId`, `isDeleted`, `memoryType`. `local-vector-index.ts:57-70`, map at `:181`.
- Empty, wrong-dim, and non-finite vectors are skipped. `local-vector-index.ts:150-160` and `:212-215`.
- `buildFromRows` flips `ready` at `:204-228`. Cold-build pages at `:294-326` and `:344-371` (`COLD_BUILD_PAGE_SIZE` 500).
- Boot wiring: `assemble.ts:3135-3157`.

### a-AC-2 - CONFIRM MET

- The method is `InMemoryLocalVectorIndex.search`, not `localVectorSearch`. It returns `{ source, id, text, created_at, memory_type, score }`, not a bare `ScoredId`. `local-vector-index.ts:238-266`.
- Score is `deeplakeCosineScore` (`local-vector-index.ts:252`), which returns `cosineSimilarity` (`vector.ts:308-310`). That function is `(1 + clampedCosine) / 2` (`vector.ts:137-154`). The SQL twin is `vector.ts:274`. The PRD's `vector.ts:242` citation has drifted; line 242 is the end of the `extraClause` field, and the GPU comment for the builder starts at `:243`.
- Project admission includes the requested id, `""`, null, undefined, and `__unsorted__` (`local-vector-index.ts:122-129`). Soft-deleted rows are skipped (`:243`).
- Name and return-shape differences do not flip MET. A `ScoredId[]`-only return would drop the inline `content` this module exists to keep (`local-vector-index.ts:20-24`).

### a-AC-3 - CONFIRM UNMET

- Fast path is present: `recall.ts:3011-3029`, `:3172-3184`, `:3260-3275`. Route threads the index only for `fast === true` (`api.ts:871-876`).
- Heavy path is absent: `runSemanticArm` always calls `vectorSearch` (`recall.ts:1513-1534`). `resolveMemoriesIndexRows` has one call site, inside `recallFast` (`recall.ts:3175`).

### a-AC-4 - CONFIRM MET

- Flag off, missing index, not ready, null vector, or a search throw returns null (`recall.ts:3020-3028`), and `recallFast` then builds the memories `<#>` SQL (`:3178-3184`).
- Cold-build failure is swallowed at `assemble.ts:3152-3157`. A non-ok page stops paging and still builds (`local-vector-index.ts:358-367`).
- This covers the fast path, the only path that consults the index.

### a-AC-5 - CONFIRM MET

- Default on at `amplification-config.ts:42-48`. Assembly builds the index only when `amplificationConfig().localAnnIndex` is true (`assemble.ts:3144-3145`). `recallFast` checks `config.localAnnIndex` (`recall.ts:3020`).

### a-AC-6 - CONFIRM MET

- Warm fast path omits the memories `<#>` SQL when the index returns rows (`recall.ts:3178-3184`). Sessions and hive semantic arms still issue `<#>` SQL (`:3181-3184`). That matches the v1 scope in the module header (`local-vector-index.ts:39-42`).
- The sub-100ms assertion is a unit test the wave 1 report cites (`tests/daemon/runtime/memories/local-vector-index.test.ts`). It was not re-run. The production omission of the memories embedding fetch is in source.

### a-AC-7 - CONFIRM UNMET

- `library/requirements/in-work/prd-078-local-ann-recall-index/qa/` contains only `.gitkeep`. No QA markdown. Knowledge pages are not that record.

### 078b and 078c - CONFIRM ABSENT

- Not in the unmet count. The class only has `buildFromRows` and `search` (`local-vector-index.ts:180-268`). No write-through, no watermark pull, no RAM cap, no HNSW. Header says both are later (`:39-42`).

## Files read

Wave 1:

- `library/requirements/reports/2026-10-04-kb-prd-standing/knowledge/ai-recall.md`
- `library/requirements/reports/2026-10-04-kb-prd-standing/knowledge/infra-collab-sources-overview.md`
- `library/requirements/reports/2026-10-04-kb-prd-standing/knowledge/architecture-adrs.md`
- `library/requirements/reports/2026-10-04-kb-prd-standing/prds/completed-017-026.md` (PRD-025 section)
- `library/requirements/reports/2026-10-04-kb-prd-standing/prds/in-work-078.md`

Source walked:

- `embeddings/src/index.ts` (not `embeddings/embed-daemon.js`)
- `src/daemon/runtime/services/embed-client.ts`
- `src/daemon/runtime/memories/local-vector-index.ts`

Cited neighbors: `src/daemon/runtime/services/embed-supervisor.ts`, `src/daemon/runtime/assemble.ts`, `src/daemon/runtime/memories/recall.ts`, `src/daemon/runtime/memories/api.ts`, `src/daemon/runtime/memories/amplification-config.ts`, `src/daemon/storage/vector.ts`, `src/daemon/storage/catalog/memories.ts`, `src/daemon/runtime/dashboard/roi-billing.ts`, `src/cli/runtime.ts`, `src/cli/auth.ts`, `package.json` optionalDependencies, `tests/daemon/runtime/services/embed-client.test.ts` (AC-1 names only), PRD-025 index, PRD-078 index.

Skipped: `node_modules`, `daemon/`, `bundle/`, harness bundles, `embeddings/embed-daemon.js`.

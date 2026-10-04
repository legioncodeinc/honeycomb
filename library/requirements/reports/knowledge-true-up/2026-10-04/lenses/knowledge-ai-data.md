# Lens: knowledge-ai-data

Date: 2026-10-04. Repository working tree, read-only. Compared `library/knowledge/private/ai/`, `library/knowledge/private/data/`, and `library/knowledge/private/storage/` to `src/daemon` (storage, recall, pipeline, capture, embeddings callers) and `embeddings/`. No npm install. No live DeepLake probe. No secrets recorded.

Fact labels: **VERIFIED** means the working-tree source was read. **REPORTED** means a doc states a measurement this pass did not rerun. **UNVERIFIABLE-HERE** means the claim needs a live backend this pass did not call.

## Summary

The load-bearing recall and storage story in `retrieval.md`, `memory-pipeline.md`, `session-capture.md`, and `deeplake-storage.md` largely matches the daemon. Hybrid recall is tokenized `ILIKE` plus a 768-dim cosine arm, fused in-process with RRF. Embeddings default on and fall back to lexical search. `sqlIdent`, `sqlStr`, and `sqlLike` match `src/daemon/storage/sql.ts`. The daemon port is 3850. The per-turn fast path and the in-daemon local ANN index exist. Harnesses, the CLI, MCP, and the embed daemon do not open the DeepLake HTTP client.

The catalog page and a few sibling pages lag the code. `schema.md` still says summary embeddings power semantic recall, and that an unbound session is always captured. `memory-pipeline.md` names an `embeddings` table that is not in the catalog. `retrieval.md` still describes the PreToolUse VFS seam as an unshipped stub. "BM25" and "GPU-backed vector search" overstate the lexical predicate and the embed runtime.

## Punch list

### knowledge-ai-data-1

- Doc: `library/knowledge/private/data/schema.md` (also `library/knowledge/private/ai/wiki-summary-workers.md`)
- Quote: "summary_embedding powers semantic recall over summaries." Wiki page: "so semantic recall can promote a session even when the search terms do not match the exact words."
- Grade: FALSE
- Correction: Semantic recall arms are `memories.content_embedding`, `sessions.message_embedding`, and `hive_graph_versions.embedding`. `embeddingColumnFor` returns null for the `memory` source, so wiki summaries stay on the lexical `summary` arm. The column is still declared and the summary worker still writes a 768-dim vector into it. `retrieval.md` already states this exclusion and that sentence holds.
- Evidence: `src/daemon/runtime/memories/recall.ts` (`SEMANTIC_ARMS`, `embeddingColumnFor`); `src/daemon/storage/catalog/sessions-summaries.ts` (`MEMORY_COLUMNS`); `src/daemon/runtime/summaries/worker.ts`. VERIFIED.

### knowledge-ai-data-2

- Doc: `library/knowledge/private/data/schema.md`
- Quote: "the bucket a session falls to when no binding, git signal, or path candidate resolves, so capture is never dropped."
- Grade: FALSE
- Correction: An unbound cwd is gated (`no_bound_project`) unless `HONEYCOMB_INBOX_CAPTURE` parses as on. The resolver default is off. Assembly sets `boundProjectGate: true` and passes that inbox flag. `session-capture.md` describes this opt-in and that description holds.
- Evidence: `src/daemon/runtime/capture/capture-config.ts` (`resolveInboxCaptureEnabled`); `src/daemon/runtime/assemble.ts` (capture handler deps); `src/daemon/runtime/capture/capture-handler.ts` (gate when `boundProjectGate` is true, inbox is not true, and the cwd is unbound). VERIFIED.

### knowledge-ai-data-3

- Doc: `library/knowledge/private/data/schema.md`
- Quote: "`memory_jobs` is the durable distillation queue (lease, complete, fail, dead, with bounded retries) that lets work survive a daemon restart."
- Grade: STALE
- Correction: For an undeclared or single-machine topology the hybrid router enables the home-anchored SQLite queue and sends pipeline kinds (`memory_extraction`, `memory_decision`, `memory_controlled_write`, and the other `DEFAULT_LOCAL_JOB_KINDS`) there. `memory_jobs` remains the shared DeepLake queue, used when the local queue is disabled, the topology is `fleet` or `multi_device`, or the local database fails to open. `memory-pipeline.md` states the SQLite default and that paragraph holds.
- Evidence: `src/daemon/runtime/services/hybrid-job-queue.ts`; `src/daemon/runtime/services/local-queue-diagnostics.ts` (`eligibleForDefaultOn`); `src/daemon/storage/catalog/runtime-jobs.ts` (table still defined). VERIFIED.

### knowledge-ai-data-4

- Doc: `library/knowledge/private/ai/memory-pipeline.md`
- Quote: "Controlled writes | Memory rows, embeddings | `memories`, `embeddings`, vector tensor table"
- Grade: FALSE
- Correction: Controlled writes insert a `memories` row whose vector is the nullable `content_embedding` `FLOAT4[]` column on that same row. The catalog has no table named `embeddings`. The next paragraph in the same file, which says 768-dim `nomic-embed-text-v1.5` tensors, holds.
- Evidence: `src/daemon/runtime/pipeline/controlled-writes.ts` (writes `content_embedding`); catalog grep for a table named `embeddings` returned no match under `src/daemon/storage/catalog`. VERIFIED.

### knowledge-ai-data-5

- Doc: `library/knowledge/private/ai/session-capture.md` (opening line of `library/knowledge/private/data/deeplake-storage.md` makes the same claim)
- Quote: "The embedding daemon and the GPU-backed vector search that consumes these vectors are documented in retrieval.md."
- Grade: OVERCLAIMED
- Correction: The embed child loads `nomic-ai/nomic-embed-text-v1.5` at q8 ONNX and the module comment calls that the CPU inference floor. Query-time `<#>` over DeepLake is documented in-repo as a brute-force column scan. The fast-path memories arm, once the index is ready, is an in-process `Float32Array` cosine in `InMemoryLocalVectorIndex`. Whether the hosted DeepLake process uses a GPU for that scan was not probed. UNVERIFIABLE-HERE for vendor hardware. VERIFIED for the code this repo runs. Later sections of `deeplake-storage.md` and `retrieval.md` that call `<#>` a full-column scan and point at the local index hold. The ~2.6s / ~2,004-row figure is REPORTED in those docs and was not remeasured.
- Evidence: `embeddings/src/index.ts` (`EMBED_DIMS`, `MODEL_ID`, `MODEL_QUANTIZATION`); `src/daemon/runtime/memories/local-vector-index.ts`; `src/daemon/storage/vector.ts`. VERIFIED.

### knowledge-ai-data-6

- Doc: `library/knowledge/private/ai/retrieval.md`
- Quote: "runtime.ts:252 passes no vfs so createFakeVfsIntercept() is used, pre-tool-use.ts:96 ignores its deps, the intercept decision is discarded" and "Docs-only so far: no code has shipped."
- Grade: STALE
- Correction: `createHookRuntime` builds `createDaemonVfsIntercept` and rebinds it per pre-tool-use event. `runPreToolUse` prefers `deps.vfs`. `createFakeVfsIntercept` remains the parameter default for a unit test that supplies no deps. The same file's per-turn section is the current story: `recallFast` and a `fast: true` body field are wired, and `createRecallRenderer` posts `POST /api/memories/recall`. The separate sentence that sessions read-time chunking code has not shipped was not contradicted: no `matchRange` chunker showed up on the recall path.
- Evidence: `src/hooks/runtime.ts`; `src/hooks/shared/pre-tool-use.ts`; `src/daemon/runtime/memories/api.ts` (`fast` routes to `recallFast`). VERIFIED.

### knowledge-ai-data-7

- Doc: `library/knowledge/private/ai/hybrid-sql-vector-rationale.md` (same label in `library/knowledge/private/ai/memory-lifecycle-as-built.md`)
- Quote: "a `<#>` semantic arm and a BM25/`ILIKE` lexical arm per table"
- Grade: OVERCLAIMED
- Correction: `buildLexicalMatchSql` emits tokenized `ILIKE` predicates. The function comment states that `deeplake_index` is not wired on this path and that the promised BM25 fallback does not exist. `retrieval.md` describes that ILIKE shape and holds. `deeplake_hybrid_record` lives in `hybrid-recall.ts` and is called from tests and the live benchmark, not from the production recall route. The recall@5 figures in the rationale (0.72-0.78 vs 0.14-0.17) are REPORTED and were not rerun.
- Evidence: `src/daemon/runtime/memories/recall.ts` (`buildLexicalMatchSql`, `RRF_K = 60`); `src/daemon/runtime/memories/hybrid-recall.ts`; call sites of `hybridRecall` under `tests/`. VERIFIED for the predicate. REPORTED for the benchmark numbers.

### knowledge-ai-data-8

- Doc: `library/knowledge/private/data/schema.md`
- Quote: "a Read tool call that had surfaced as ~400 chars of escaped JSON now surfaces as ~80 chars of clean prose."
- Grade: OVERCLAIMED
- Correction: The lexical `sessions` arm matches and returns `COALESCE(NULLIF(prose, ''), message::text)`. That part of `retrieval.md` and `schema.md` holds. The semantic `sessions` arm still projects `message::text` as the hit text (`textColumn: "message"`). Embeddings default on, so a semantic sessions hit can still place the JSONB envelope in the fused result. The ~80 vs ~400 character sizes are REPORTED illustrations, not remeasured.
- Evidence: `src/daemon/runtime/memories/recall.ts` (`buildSessionsArmSql`, `SEMANTIC_ARMS`, `buildSemanticHydrateSql`, `buildFastSemanticArmSql`); `src/daemon/runtime/services/embed-client.ts` (`resolveEmbedClientOptions`, opt-out). VERIFIED.

### knowledge-ai-data-9

- Doc: `library/knowledge/private/ai/retrieval.md`
- Quote: "served by POST /api/memories/recall (src/daemon/runtime/memories/api.ts:405 is the sole production caller)."
- Grade: STALE
- Correction: Line 405 in the current file is a comment on the optional `cwd` field of `RecallBodySchema`. The route handler selects `recallFast` or `recallMemories` further down (the `recallEngine` assignment near line 806) and is the production caller of both. `recallMemories` has no other production call site in `src/`.
- Evidence: `src/daemon/runtime/memories/api.ts`; repository grep for `recallMemories`. VERIFIED.

### knowledge-ai-data-10

- Doc: `library/knowledge/private/ai/wiki-summary-workers.md`
- Quote: "The periodic threshold check lives inside maybeTriggerPeriodicSummary() in src/hooks/capture.ts" with default `HONEYCOMB_SUMMARY_EVERY_N_MSGS` of 50 or `HONEYCOMB_SUMMARY_EVERY_HOURS` of 2, persisted in a JSON sidecar.
- Grade: FALSE
- Correction: `src/hooks/capture.ts` is absent. Those environment names do not appear under `src/`. Periodic summary cues are an in-memory per-session map in `src/daemon/runtime/capture/turn-counters.ts`, default `DEFAULT_SUMMARY_EVERY_MESSAGES = 20`. A daemon restart resets the counters. The lock directory `~/.claude/hooks/summary-state` is still the summary worker default, so that path sentence holds.
- Evidence: `src/daemon/runtime/capture/turn-counters.ts`; `src/daemon/runtime/summaries/worker.ts` (lock root); glob for `src/hooks/capture.ts` (no file). VERIFIED.

### knowledge-ai-data-11

- Doc: `library/knowledge/private/data/schema.md`
- Quote: the `CREATE TABLE "sessions"` block ending at `last_update_date`, presented as the capture table shape.
- Grade: STALE
- Correction: `SESSIONS_COLUMNS` also defines nullable `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, plus `model` and `source_tool`. `prose` is in both the doc block and the catalog. A later paragraph in `schema.md` mentions the token columns and `source_tool` and does not mention `model`. The file's own preface says the DDL is a logical shape and the daemon catalog is the source of truth. That preface holds. The block itself is behind the catalog.
- Evidence: `src/daemon/storage/catalog/sessions-summaries.ts` (`SESSIONS_COLUMNS`). VERIFIED.

### knowledge-ai-data-12

- Doc: `library/knowledge/private/ai/retrieval.md`, `library/knowledge/private/data/deeplake-storage.md`, `library/knowledge/private/ai/session-capture.md`, `library/knowledge/private/ai/skillify-pipeline.md`, `library/knowledge/private/data/codebase-graph.md`, `library/knowledge/private/data/memory-virtual-filesystem.md`
- Quote: "EMBEDDING_DIMS = 768"; "`HONEYCOMB_EMBEDDINGS` is opt-out"; "sqlIdent validates a table or column name against `^[a-zA-Z_][a-zA-Z0-9_]*$`"; "the daemon (port 3850)"; "InMemoryLocalVectorIndex"; "The daemon is the only DeepLake client."
- Grade: HOLDS
- Correction: None for the product path. Checked together because they are the load-bearing invariants and they match the tree.
  - Dimension: `EMBEDDING_DIMS = 768` in `src/daemon/storage/vector.ts` and `EMBED_DIMS = 768` in `embeddings/src/index.ts`. A non-768 store vector is rejected to null on the capture and controlled-write paths.
  - Fallback: unset `HONEYCOMB_EMBEDDINGS` enables embeddings. Explicit `false` or `0` disables them. Recall sets `degraded` when the query vector is missing and still answers from the lexical arms.
  - SQL helpers: `sqlIdent`, `sqlStr`, and `sqlLike` in `src/daemon/storage/sql.ts` match the `deeplake-storage.md` description, including the identifier regex. `sqlStr` preserves tab, newline, and carriage return while dropping other C0 controls and NUL. The doc's shorter phrase "dropping NUL and control characters" is slightly broad and still points at the right helper.
  - Port: `DAEMON_PORT = 3850` in `src/shared/constants.ts`.
  - Local ANN: `InMemoryLocalVectorIndex` is constructed on the real assembly path when `HONEYCOMB_LOCAL_ANN_INDEX` is on (default on), cold-built off the hot path, and consumed by `recallFast` for the `memories` semantic arm. There is no write-through method on the class, so the doc sentence that freshness past the boot build is not yet built holds.
  - Sole storage client: `harnesses/`, `mcp/`, `src/cli/`, and `embeddings/` do not construct `HttpDeepLakeTransport` or `createStorageClient`. `src/eval/deeplake-stress.ts` is an on-demand diagnostic that wraps the same transport. It is not a harness, CLI, or MCP client.
- Evidence: paths named above. VERIFIED.

## Notes kept out of the punch list

- `retrieval.md` line ranges for `buildLexicalMatchSql` (about line 546), the four lexical arm builders, `SEMANTIC_ARMS` (about lines 1376-1410), and `embeddingColumnFor` (about lines 1700-1704) still land on the right functions. VERIFIED.
- Native hybrid operator stays unwired in production. VERIFIED. See knowledge-ai-data-7.
- Live latency, recall@5, and nDCG gate results cited in the knowledge pages were not rerun. REPORTED.
- Hosted DeepLake GPU use was not probed. UNVERIFIABLE-HERE. See knowledge-ai-data-5.

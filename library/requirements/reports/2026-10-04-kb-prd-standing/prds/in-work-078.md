# PRD-078 standing: local ANN recall index

Shard: in-work `prd-078` only. Read-only re-check against source. No PRD edits, no source edits, no commit, no folder move.

- Folder now: `library/requirements/in-work/prd-078-local-ann-recall-index/`
- Commit `756bacb` (`docs: align the knowledge base with the daemon and file shipped PRDs`) renamed this folder from `backlog/` to `in-work/` with zero content changes. The commit message calls 078 still in progress. This report re-checks that bucket against source. It does not assume the folder.
- Files in the folder: `prd-078-local-ann-recall-index-index.md` and `qa/.gitkeep`. No lettered children (078a/078b/078c exist only as phase rows in the index). No QA note.
- Grounding: `src/daemon/runtime/memories/local-vector-index.ts`, `src/daemon/runtime/memories/recall.ts` (`recallFast` / `runSemanticArm`), plus the config, assembly, and unit tests those paths cite. Build outputs and `node_modules` skipped.
- Index status line (`prd-078-local-ann-recall-index-index.md:3`) still reads `Backlog (in-work - Phase 1 dispatched)`. The folder move did not update that line.

## Recommended bucket

**Stay in `in-work`.** Do not move to `completed`. Do not move back to `backlog`.

Why in-work:

- Phase 078a is largely in source. The in-daemon index, boot cold-build, `recallFast` memories arm, fail-soft `<#>` fallback, and `HONEYCOMB_LOCAL_ANN_INDEX` (default on) are present and unit-tested.
- Two written acceptance criteria are unmet: the heavy `runSemanticArm` never queries the index (a-AC-3), and there is no QA report of a non-empty `apiary` dogfood (a-AC-7).
- Phases 078b (freshness) and 078c (eviction / HNSW) are still `Draft` in the index and have no implementation. They have no numbered acceptance criteria, so they are not in the unmet count, but they block treating the PRD as shipped.

Later librarian action, only after a code-standing confirm: leave the folder in `in-work` and update the status line so it no longer says `Backlog`. Do not `git mv`.

## Score

| ID | Verdict |
|---|---|
| a-AC-1 | MET |
| a-AC-2 | MET |
| a-AC-3 | UNMET |
| a-AC-4 | MET |
| a-AC-5 | MET |
| a-AC-6 | MET |
| a-AC-7 | UNMET |

Unmet count: **2** (a-AC-3, a-AC-7). Unverifiable count: 0. Criteria checked: 7.

## a-AC-1 - MET

Quote (`library/requirements/in-work/prd-078-local-ann-recall-index/prd-078-local-ann-recall-index-index.md:55`):

> An in-daemon vector index module holds `id -> Float32Array(768)` + `project_id`/`created_at`/`is_deleted`, built at boot by paging embedded `memories` rows from Deep Lake (off the recall hot path; the cold-build is allowed to exceed the per-turn budget). A test asserts build-from-rows populates the index and skips rows with empty/wrong-dim embeddings.

Evidence:

- Entry shape is `id` (map key) to `Float32Array` plus `createdAt`, `projectId`, `isDeleted`. Content and `memoryType` are extra fields, not a missing one. `src/daemon/runtime/memories/local-vector-index.ts:57-70`, map at `:181`.
- Dimension constant is 768. `src/daemon/storage/vector.ts:35`.
- Empty, wrong-dim, and non-finite embeddings are skipped. `local-vector-index.ts:150-160` and `:212-215`.
- `buildFromRows` loads the rest and flips `ready`. `local-vector-index.ts:204-228`.
- Cold-build pages `memories` off the hot path (`COLD_BUILD_PAGE_SIZE` 500). `local-vector-index.ts:294-326` and `:344-371`.
- Boot wiring is fire-and-forget on the real assembly only, and a throw is non-fatal. `src/daemon/runtime/assemble.ts:3135-3157`.
- Test: `tests/daemon/runtime/memories/local-vector-index.test.ts:88-113` (populate, skip empty/wrong-dim/null/NaN, skip blank id). Paging: same file `:217-256`.

## a-AC-2 - MET

Quote (`prd-078-local-ann-recall-index-index.md:56`):

> `localVectorSearch(queryVec, projectId, k)` returns the top-k `ScoredId[]` by cosine, scored with the VERBATIM `((1 + cos) / 2)` normalization (`vector.ts:242`) and filtered by the 049b project scope (`project_id = P OR '' OR NULL`), ordered by score desc. A parity test asserts its top-k id order + scores match the `<#>` SQL over a fixed fixture (same vectors) within float tolerance.

Evidence:

- The production method is `InMemoryLocalVectorIndex.search(queryVec, projectId, k, unscoped?)`, not a function named `localVectorSearch`. `local-vector-index.ts:238-267`.
- It returns the fast-arm row `{ source, id, text, created_at, memory_type, score }`, not a bare `ScoredId`. `ScoredId` is `{ id, score }` at `src/daemon/storage/vector.ts:207-211`. The row still carries `id` and the same score, ordered score desc with an id tie-break. `local-vector-index.ts:256-266`.
- Score is `deeplakeCosineScore`, which returns `cosineSimilarity`. That function is `(1 + clampedCosine) / 2`. `vector.ts:308-310` and `:137-154`. The SQL twin is `vector.ts:274` (`((1 + (emb <#> vec)) / 2)`). The PRD's `vector.ts:242` citation has drifted; line 242 is now the `buildVectorSearchSql` comment, and the formula is at line 274.
- Project filter admits `projectId`, `""`, null/undefined, and the `__unsorted__` inbox. `local-vector-index.ts:122-129`. Soft-deleted rows (`is_deleted === 1`) are dropped. `:243`. The SQL arm uses the same inbox widening (`includeInbox: true`). `recall.ts:1306-1316` and `src/daemon/runtime/recall/scope-clause.ts:385-402`. The written parenthetical (`P OR '' OR NULL`) is the older 049b shape; the in-RAM filter matches the current SQL conjunct, including inbox.
- Parity tests: `tests/daemon/runtime/memories/local-vector-index.test.ts:118-162` (id order, scores within tolerance, project-B and deleted excluded) and `tests/daemon/runtime/memories/local-vector-index-deeplake-parity.test.ts:68-82` (order and magnitude against a baked live `<#>` oracle).

These name and return-shape differences do not flip the verdict. The scored search, the verbatim normalization, the project filter kept in step with the SQL arm, and the parity tests are in source. A later code pass can overturn this to UNMET if it treats `ScoredId[]` as a literal contract.

## a-AC-3 - UNMET

Quote (`prd-078-local-ann-recall-index-index.md:57`):

> The `memories` semantic arm (both the `recallFast` content-inline path and the heavy `runSemanticArm`) queries the local index when enabled + warm, producing the SAME `ScoredId[]`/hit shape so RRF/recency/hydrate/rerank downstream are byte-unchanged. A test asserts the arm returns index-sourced hits and downstream fusion is identical.

Fast-path half is present:

- `resolveMemoriesIndexRows` serves the memories arm from the index when the flag is on, the index is ready, and the query vector exists. A throw returns null so the `<#>` SQL runs. `recall.ts:3011-3029`.
- `recallFast` drops the memories `<#>` SQL when that returns rows and prepends them as the first fused arm. `recall.ts:3172-3184` and `:3260-3274`.
- The route threads the index only when `fast === true`. `src/daemon/runtime/memories/api.ts:871-876`. Assembly comment: "Only the fast path reads it." `assemble.ts:1624-1626`.
- Test: index-served rows and the same rows via `<#>` SQL produce equal `hits` and `sources` after RRF and recency. `tests/daemon/runtime/memories/recall-fast-ann.test.ts:103-137`.

Heavy-path half is absent:

- `runSemanticArm` always calls `vectorSearch` (the `<#>` SQL) and then hydrates. It never reads `localVectorIndex`. `recall.ts:1513-1550`.
- `resolveMemoriesIndexRows` has one call site, inside `recallFast`. `recall.ts:3175`.
- No test asserts `runSemanticArm` or `recallMemories` returns index-sourced hits.

The phase row also requires both paths. `prd-078-local-ann-recall-index-index.md:47` ("wire into the `memories` semantic arm (fast + heavy)"). The criterion is unmet because the heavy clause is absent.

## a-AC-4 - MET

Quote (`prd-078-local-ann-recall-index-index.md:58`):

> Fail-soft: when the index is disabled (flag off), cold (not yet built), or errors, the semantic arm falls back to the existing `<#>` SQL query - never fails. A test asserts each fallback branch.

Evidence:

- Flag off, missing index, not `ready`, null vector, or a `search` throw all return null, and `recallFast` then builds the memories `<#>` SQL. `recall.ts:3020-3028` and `:3178-3184`.
- Cold-build failure is swallowed at boot so recall keeps the SQL path. `assemble.ts:3152-3157`. A non-ok page stops paging and still builds from rows already gathered. `local-vector-index.ts:358-367`.
- Tests: absent, cold, and throwing search fall back to memories `<#>` and do not throw. `tests/daemon/runtime/memories/recall-fast-ann.test.ts:142-167`. Flag off is asserted in the a-AC-5 test at `:190-203`.

This covers the fast path, which is the only path that consults the index. The heavy arm has no index branch to fall back from (see a-AC-3).

## a-AC-5 - MET

Quote (`prd-078-local-ann-recall-index-index.md:59`):

> Config flag (`HONEYCOMB_LOCAL_ANN_INDEX`, default decided at rollout) gates the whole path; documented default + env override, `amplificationConfig`-style. A test asserts the flag toggles index-vs-SQL.

Evidence:

- Default is on. `src/daemon/runtime/memories/amplification-config.ts:42-48` (`DEFAULT_LOCAL_ANN_INDEX = true`) and schema field `:139-140`.
- Env override `HONEYCOMB_LOCAL_ANN_INDEX` is read by the amplification provider. `amplification-config.ts:199-200` and `:220-226`.
- Assembly builds the index only when `amplificationConfig().localAnnIndex` is true. `assemble.ts:3144-3145`.
- `recallFast` checks `config.localAnnIndex` before search. `recall.ts:3020`.
- Test: unset env uses the index (no memories `<#>` SQL, hit id `m1`); `HONEYCOMB_LOCAL_ANN_INDEX=false` issues the SQL and returns the SQL row `sql`. `tests/daemon/runtime/memories/recall-fast-ann.test.ts:172-204`.

The PRD left the default "decided at rollout". Source decided on. That matches the documented kill-switch posture and does not leave the criterion open.

## a-AC-6 - MET

Quote (`prd-078-local-ann-recall-index-index.md:60`):

> Latency: a test/benchmark asserts `localVectorSearch` over the resident corpus completes in sub-100ms (vs the ~2.6s `<#>`), and no embedding-payload Deep Lake round-trip is issued on the warm query path.

Evidence:

- A 3,000-vector `search` is asserted under 100ms. `tests/daemon/runtime/memories/local-vector-index.test.ts:197-211`. The 2.6s figure is the comment in that assertion, not a paired live Deep Lake timing in the same test.
- On the warm fast path the memories `<#>` SQL is omitted, so the memories embedding column is not fetched. `recall.ts:3178-3184`. Test: the storage stub sees zero memories content-inline semantic statements. `tests/daemon/runtime/memories/recall-fast-ann.test.ts:209-220`.
- Sessions and `hive_graph_versions` semantic arms still issue `<#>` SQL on that path (the test expects 6 remaining Deep Lake queries). That matches the non-goal at `prd-078-local-ann-recall-index-index.md:28` (no `sessions.message_embedding` index in v1). The warm-path clause is met for the memories embedding payload this PRD replaces.

## a-AC-7 - UNMET

Quote (`prd-078-local-ann-recall-index-index.md:61`):

> Live acceptance (dogfood, recorded in the QA report): with the index built + enabled on the `apiary` workspace, one per-turn recall returns non-empty hits within budget and `injectedRefs` becomes non-empty.

Evidence:

- Required artifact: ABSENT. `library/requirements/in-work/prd-078-local-ann-recall-index/qa/` contains only `.gitkeep`. No QA markdown under this PRD.
- The injector that would write `injectedRefs` exists (`src/hooks/shared/user-prompt-recall.ts:113-117`), but this shard did not find a recorded `apiary` session file or `request_log` row inside the PRD.
- Narrative claims of a live top-5 injection sit in knowledge, not in the QA report the criterion names: `library/knowledge/private/ai/retrieval.md:127` and `library/knowledge/private/storage/deeplake-recall-and-capture-findings-2026-07-10.md:62`. Those pages are not a substitute for the QA record. Do not mark this criterion met from them.

## Phases with no acceptance criteria

Not counted in the unmet total. Both are still open work.

- **078b freshness - Draft, ABSENT.** Index text: write-through on every `memories` write, `updated_at` watermark pull, evict on `is_deleted = 1`. `prd-078-local-ann-recall-index-index.md:48`. The index class only has `buildFromRows` and `search`. No upsert and no watermark pull. `local-vector-index.ts:180-268`. Soft-delete is a search-time skip of rows already loaded (`:243`), not a later eviction API.
- **078c scale and eviction - Draft, ABSENT.** Index text: RAM budget, ACT-R / `last_reinforced_at` eviction, HNSW via `hnswlib-node` past ~100k. `prd-078-local-ann-recall-index-index.md:49`. No `hnswlib` dependency in `package.json`. The index has no RAM cap and no eviction. `last_reinforced_at` exists on the memories catalog (`src/daemon/storage/catalog/memories.ts:86`) and is used by recall recency, not by this index.

Same conclusion in the findings note: "078a cold-builds on boot only" and 078b/c are "drafted, not built." `library/knowledge/private/storage/deeplake-recall-and-capture-findings-2026-07-10.md:108`.

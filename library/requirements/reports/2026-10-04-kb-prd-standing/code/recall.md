# Wave 2 code standing: recall

Judged against the working tree. No knowledge page, PRD, ADR, or source file was edited. No commit. ASCII hyphens only.

Scope walked: `src/daemon/runtime/memories/recall.ts`, `hybrid-recall.ts`, `api.ts`, `local-vector-index.ts`, and `src/hooks/runtime.ts`, plus the neighbors those reports cite (recall config, collection, scope clause, assemble wiring, resolve, prime, MCP handlers, the PRD-045b de-scope, and the PRD-047 benchmark). Skipped `node_modules` and build outputs.

Inputs: `knowledge/ai-recall.md` (D1-D29), `prds/completed-001-008.md` (PRD-007), `prds/completed-075-080.md` (075, 076, 077), `prds/in-work-078.md`.

## Tally

| Set | CONFIRM | OVERTURN | UNVERIFIABLE |
|---|---|---|---|
| Knowledge edits D1-D29 | 28 | 1 | 0 |
| PRD-007 bucket and child status | 0 | 2 | 0 |
| PRD-075, 076, 077 stays and status lines | 6 | 0 | 0 |
| PRD-078 stay and status line | 2 | 0 | 0 |
| Total | 36 | 3 | 0 |

D17 is split: the three-tier backlink is a CONFIRM, and the prior-art "points at retrieval" ground is the one OVERTURN. Holds H1-H10 were re-checked and left; they are not edits, so they are not in the tally.

## PRD-007 bucket

**OVERTURN** the move from `completed` back to `in-work`. The five-phase engine was superseded.

PRD-045b, status "Resolved - DE-SCOPED (2026-06-22)", records the decision to remove `RecallEngine` (`collect`, `traverse`, `authorize`, `shape`, `gate`) because it had zero production callers, and to rewrite PRD-007 AC-2/3/4 to the shipped `recallMemories` contract (`library/requirements/completed/prd-045-daemon-wiring-closeout/prd-045b-daemon-wiring-closeout-retrieval-engine.md:1-3`, `:73-79`). The barrel states the same removal (`src/daemon/runtime/recall/index.ts:4-12`). The PRD-007 index status is already "Completed - reconciled" and says the lettered five-phase contract was de-scoped (`library/requirements/completed/prd-007-retrieval/prd-007-retrieval-index.md:3`, `:10-18`, `:59-70`).

The 26 UNMET rows in the wave 1 report (007b AC-1 through AC-7, 007c AC-1 through AC-5 and AC-7, 007d AC-1 and AC-3 through AC-7, 007e AC-1 through AC-7) describe that removed engine: focal walk, authorization re-query, convolution and currentness downweight, and the confidence gate. Those children were not rewritten. They are historical. They are not a reason to reopen the folder.

**OVERTURN** flipping 007b-e status lines from Draft to Completed. Those criteria did not ship. The index already records the de-scope. Leave the folder in `completed`. Do not `git mv`.

### Live spec (rewritten index). No absent gap.

CONFIRM was reserved for a rewritten criterion that is still the live contract and missing in source. None of AC-1 through AC-4 is absent.

- AC-1. Per-arm lexical queries plus the semantic `<#>` arm, fused by RRF on `source+id`. `recall.ts:2803-2843` issues the four lexical arms and fuses them. `fuseHits` is `recall.ts:757`. `fusionKey` is defined at `recall.ts:861` and used at `recall.ts:771`. `buildLexicalMatchSql` is tokenized `ILIKE` (`recall.ts:519-530`). The criterion text already says each arm is a guarded per-arm query (`prd-007-retrieval-index.md:67`). The overview banner still says "UNION-ALL"; that wording is stale and is the same defect as D16. It is not a missing engine.
- AC-2. Tenancy is the storage `QueryScope`, fail-closed before the engine. `api.ts:745-757` resolves scope and returns 400 when it is null (`NO_ORG_BODY` at `api.ts:481`). `buildScopeClause` is retained at `src/daemon/runtime/recall/scope-clause.ts:205` and called from tests (`tests/daemon/runtime/recall/scope-clause.test.ts:18`, `tests/integration/recall-authz-live.itest.ts:203`). It has no production call under `src/`. The rewritten AC says the function is retained and proven by those suites, and it de-scopes the candidate-pool re-query (`prd-007-retrieval-index.md:68`). Absence of a production caller matches that de-scope.
- AC-3. Soft-delete on the recall arms, plus highest-version reads elsewhere. Memories lexical arm filters `is_deleted = 0` at `recall.ts:590`. Semantic hydrate filter is `recall.ts:1385`. `memory_get` orders `version DESC` at `src/daemon/runtime/memories/reads.ts:165-176`. `buildHighestActiveVersionSql` lives at `src/daemon/storage/catalog/knowledge-graph.ts:354` and is re-exported from `src/daemon/runtime/ontology/supersede.ts:468`. Claim supersede appends a new version at `supersede.ts:197`. The dedicated currentness-downweight phase is the de-scoped half of the same AC.
- AC-4. Raw ranked hits and a `degraded` flag. Result field is `recall.ts:446`. Heavy path sets `degraded` at `recall.ts:2812-2816`. Consumers post to `POST /api/memories/recall` (`mcp/src/handlers.ts:227` and `:309`). The confidence gate is the de-scoped half. Keyword mode forces `degraded: false` when the semantic arm is skipped on purpose (`recall.ts:2777`, `:2816`; `api.ts:760-763`). That exception is PRD-044c, a later contract, and the flag itself is present. It does not reopen PRD-007. It is the knowledge hole D9.

007a collection remains the live VFS browse path. `src/daemon/runtime/vfs/api.ts:372` calls `collectCandidates`. `collection.ts:162-169` still builds an ID-and-score lexical channel. `collection.ts:129-133` states the agent read-policy clause is not applied in collection. That matches the de-scoped 007c boundary.

## Knowledge edits

Line numbers below are the current tree. Several wave 1 citations still land; where they drifted, the current line is the one cited here.

### D1 - CONFIRM

Mermaid node `retrieval.md:38` still names `applyRecencyDampening` as an off-equivalent age decay. The heavy path applies class-aware activation after dedup: `applyActrActivation` when `activationSource` is injected, otherwise `applyRecencyActivation` (`recall.ts:2907-2910`). Production assembly injects that source (`assemble.ts:1562`, `:1612`). `recallFast` always calls `applyRecencyActivation` (`recall.ts:3284`). Default exponent is `1.0` (`src/daemon/runtime/recall/config.ts:192`). `applyRecencyDampening` is the back-compat function described at `recall.ts:1132-1133` and defined at `recall.ts:2156`. The table at `retrieval.md:97` already names the activation stage. Revise the mermaid node. Name the production heavy branch `applyActrActivation` and keep `applyRecencyActivation` as the fast path and the unwired fallback.

### D2 - CONFIRM

`retrieval.md:40` draws the scope filter after token-budget assembly. Project scope is a SQL conjunct computed before the arms (`recall.ts:2782`, `projectConjunctFor` at `recall.ts:1306`) and again on the fast path (`recall.ts:3135`). The `agent_id` half of that node is D5.

### D3 - CONFIRM

`retrieval.md:46` says `honeycomb login` provisions and owns the embed daemon. The embed process is a supervised child of the daemon (`embeddings/src/index.ts:6-7`, `src/daemon/runtime/services/embed-supervisor.ts:4`). `honeycomb login` writes shared Deep Lake credentials (`src/cli/runtime.ts:495-497`). The opt-out sentence in the same bullet still holds (H1).

### D4 - CONFIRM

`retrieval.md:49` cites `recall.ts:37-48` for the lexical `ILIKE` arms. Those lines are the module header, and the header still says "BM25/ILIKE". The live predicate is `buildLexicalMatchSql` (`recall.ts:519-530`), called from the arm fan-out at `recall.ts:2803-2809`.

### D5 - CONFIRM

`retrieval.md:131` says `buildScopeClause` enforces `isolated`, `shared`, and `group` on recall, and that no content column is returned before those filters. `recall.ts:76` imports `buildProjectScopeConjunct` only. `buildScopeClause` is defined at `scope-clause.ts:205` and has no production caller under `src/`. The lexical memories arm projects `content` in the same SELECT as the match (`recall.ts:588`). Org and workspace partitioning through `QueryScope` still holds (`recall.ts:50-54`, `api.ts:745-757`).

### D6 - CONFIRM

`retrieval.md:135` says recall excludes `status = 'superseded'` and resolves `MAX(version)` at query time. The memories arm filters `is_deleted = 0` (`recall.ts:590`, semantic hydrate `recall.ts:1385`). The recall SELECT does not read `entity_attributes`. Comments at `recall.ts:979-980` say hard-superseded rows are excluded upstream. `status = 'superseded'` is the ontology claim writer (`src/daemon/storage/catalog/knowledge-graph.ts:13-17`, `buildHighestActiveVersionSql` at `:354`).

### D7 - CONFIRM

`retrieval.md:123` says inline content means the fast path needs zero Deep Lake round-trips. The local index replaces only the `memories` semantic arm, and only when the flag is on, the index is `ready`, and a query vector exists (`recall.ts:3011-3026`, `:3172-3184`). Sessions and hive semantic SQL, plus every lexical arm, still run (`recall.ts:3186-3190`).

### D8 - CONFIRM

`retrieval.md:112` calls rerank "off-in-prod" and the lifecycle stages "dormant" as what `recallFast` drops. `recallFast` does skip rerank, dedup, staleness, ACT-R, conflict suppression, and calibration (`recall.ts:3088-3095`, body `:3272-3284`). On the heavy path those seams are constructed and injected: conflict suppression (`assemble.ts:1531`), ACT-R (`assemble.ts:1562`), staleness (`assemble.ts:1570`), calibration (`assemble.ts:1584`), consumed at `recall.ts:2898-2931`. The mermaid at `retrieval.md:29-40` stops at recency and MMR. Reranker default `none` still holds (H4). Staleness defaults to the observe posture (`assemble.ts:1543-1550`); the stages are still wired.

### D9 - CONFIRM

`recallMode === "keyword"` skips the semantic arms and forces `degraded: false` (`recall.ts:2768-2777`, `:2812-2816`). The route reads that vault setting (`api.ts:760-763`). `retrieval.md` does not mention the mode. Add it beside the degraded-flag sentence at `retrieval.md:49`.

### D10 - CONFIRM

The lexical sessions arm matches and returns `prose` via `COALESCE(NULLIF(prose, ''), message::text)` (`recall.ts:666-670`). The semantic sessions text column is still `message` (`recall.ts:1394`). The fast semantic SELECT projects that column (`recall.ts:1467`). A semantic sessions hit can still be the JSON envelope. Add that limit next to `retrieval.md:60`.

### D11 - CONFIRM

The `MAX(seq)` join is only in `buildHiveGraphVersionsArmSql` (`recall.ts:723`). The semantic hive arm is a flat `<#>` scan with `describe_status = 'described'` and no latest-version collapse (`recall.ts:1398-1410`). Add that next to `retrieval.md:64`.

### D12 - CONFIRM

`RERANKER_STRATEGIES` is `embedding-cosine`, `llm`, `cohere`, `none` (`config.ts:233`). `llm` falls through to RRF order (`recall.ts:1827-1829`). `retrieval.md:95` omits `llm`. Add it as named and unimplemented.

### D13 - CONFIRM

`provenanceRank` returns 0 for `memories`, 1 for `memory`, and 2 for every other source (`recall.ts:1979-1983`), so `hive_graph_versions` ties with `sessions` in dedup. Recency maps hive onto the memories class (`recall.ts:2357-2360`). `retrieval.md:96` says "memory > summary > session" and does not record that split. Add it.

### D14 - CONFIRM

`retrieval.md:151` assigns sessions chunking to ADR-0009, PRD-075, and PRD-076, and says the code is absent. ADR-0009 is the local-queue decision (`library/knowledge/private/architecture/adr/0009-local-queue-as-default-deeplake-is-not-a-queue.md:1`). PRD-075 is the PreToolUse command surface. PRD-076 is the per-turn injector (`src/hooks/runtime.ts:387-391`). `src/daemon/runtime/memories/` has no `matchRange`. Revise the bullet. The following paragraph at `retrieval.md:152` correctly says the PreToolUse seam is live.

### D15 - CONFIRM

`retrieval.md:156` says `hivemind_search` routes to the VFS browse surface. That name is absent from `src/hooks/runtime.ts`. The handler posts to `POST /api/memories/recall` (`mcp/src/handlers.ts:306-309`). `src/hooks/runtime.ts:255-257` and `:553` build `createDaemonVfsIntercept` for PreToolUse. Keep the VFS sentence. Point the mine tool at scored recall.

### D16 - CONFIRM

`retrieval.md:27` sends readers to `src/daemon/runtime/recall/CONVENTIONS.md` for the de-scope. The five-phase removal in that file holds (`CONVENTIONS.md:11-13`). The same paragraph calls live recall "lexical UNION-ALL" (`CONVENTIONS.md:14`). Live recall is per-arm (`recall.ts:24-35`, `:2803-2809`). Revise the retrieval pointer so a reader does not copy the UNION-ALL shape. The de-scope itself stays.

### D17 - CONFIRM the three-tier backlink. OVERTURN the prior-art backlink.

`retrieval.md:8-19` does not name `three-tier-memory-strategy.md` or `prior-art-owls-roost-crosswalk.md`. Three-tier does point at retrieval (`three-tier-memory-strategy.md:20`). Add that backlink.

Prior-art does not point at retrieval. Its Related list names three-tier, distillation, the hybrid rationale, and the GraphRAG follow-on (`prior-art-owls-roost-crosswalk.md:10-14`). Do not add prior-art on the ground that it points back.

### D18 - CONFIRM

`hybrid-sql-vector-rationale.md:96-103` says `deeplake_hybrid_record` does not work and is filed as a vendor bug. The module is still unwired (`hybrid-recall.ts:4-7`; `hybridRecall` is exported at `:241` and has no other `src/` importer). The 2026-06-24 re-run is parity, recall@5 0.611 vs 0.611 (`library/requirements/completed/prd-047-retrieval-quality-upgrades/reports/2026-06-22-hybrid-benchmark-decision.md:92-93`). `retrieval.md:86-87` and the operator-report header already say this. Revise lines 96-103 so they match the tie.

### D19 - CONFIRM

`hybrid-sql-vector-rationale.md:94` says recall@5 is about 0.72-0.78. That band is the 2026-06-22 run (`2026-06-22-hybrid-benchmark-decision.md:17`). The 2026-06-24 re-run measured RRF recall@5 at 0.611 (same report, `:92`). Date the older band or replace it with the tie run.

### D20 - CONFIRM

`hybrid-sql-vector-rationale.md:93` says a BM25/`ILIKE` lexical arm. `buildLexicalMatchSql` states that `deeplake_index` is not wired and the predicate is tokenized `ILIKE` (`recall.ts:519-530`). `RRF_K = 60` (`recall.ts:238`) and arm weights 1.0 / 0.4 (`recall.ts:255-257`) in the same sentence hold.

### D21 - CONFIRM

`hybrid-sql-vector-rationale.md:64` says depth 2 is `sessions` where `path` equals the summary path. Depth 2 uses `id LIKE 'sess-<sessionId>-%'` plus a post-filter, and the file says the raw turns do not live at the summary path (`src/daemon/runtime/memories/resolve.ts:16-29`). `GET /api/memories/resolve` is `api.ts:964-967`. `hivemind_read` calls that route (`mcp/src/handlers.ts:296-304`).

### D22 - CONFIRM

The heavy path still runs `<#>` through `vectorSearch` (`recall.ts:1534`). The per-turn path (`fast: true`, `api.ts:806`) serves the memories semantic arm from `InMemoryLocalVectorIndex` when the index is ready (`recall.ts:3001-3026`). `hybrid-sql-vector-rationale.md:88-95` does not mention that split. Add it.

### D23 - CONFIRM

`three-tier-memory-strategy.md:124` says prime once, pull per turn, and never auto-inject per turn. `HookRuntime` dispatches `user_prompt_recall` to `runUserPromptRecall` (`src/hooks/runtime.ts:387-391`). The renderer posts `fast: true` (`src/hooks/shared/recall-renderer.ts:151-158`). Session-start prime still exists (`api.ts:1017-1024`, `src/daemon/runtime/memories/prime.ts:191-192`). Revise the boundary to prime once, plus a bounded per-turn fast inject, plus on-demand pull.

### D24 - CONFIRM

`three-tier-memory-strategy.md:141` says 047b through 047f are wired into both mining and the prime. Mining runs dedup and class-aware activation (`recall.ts:2874-2910`). The prime assembler says the PRD-047d dampener is not built: default recency is the skim `ORDER BY`, and semantic dedup is a later seam (`src/daemon/runtime/summaries/prime-digest.ts:21-36`). `prime.ts` issues `skimPrimeKeys` only (`prime.ts:128`).

### D25 - CONFIRM

`three-tier-memory-strategy.md:107` says depth 2 fetches sessions rows on the same path. `resolve.ts:18-20` rejects that join. Same fact as D21.

### D26 - CONFIRM

`three-tier-memory-strategy.md:139` repeats recall@5 about 0.72-0.78. That is the 2026-06-22 band. The tie run is 0.611 for both paths (`2026-06-22-hybrid-benchmark-decision.md:92-93`). The same paragraph already says the vendor fix only ties RRF. Date the older band or replace it.

### D27 - CONFIRM

`prior-art-owls-roost-crosswalk.md:62` says the reranker default is embedding-cosine or LLM, and that Honeycomb does not depend on Cohere. Default strategy is `none` (`config.ts:85`, applied at `recall.ts:2854-2857`). `embedding-cosine` is optional (`recall.ts:1830`). `llm` is named and unimplemented (`recall.ts:1827-1829`). `cohere` is a real opt-in strategy (`config.ts:114`, `recall.ts:1822-1824`, transport `src/daemon/runtime/recall/rerank-portkey.ts:11`).

### D28 - CONFIRM

`prior-art-owls-roost-crosswalk.md:56` calls PRD-047d recency dampening "already in flight" and says the prime is age-weighted. Recall recency is shipped as `applyRecencyActivation` with half-lives memories 180d, memory 45d, sessions 10d (`recall.ts:1126-1130`, `config.ts:180-184`). `applyRecencyDampening` is not the stage `recallMemories` calls (`recall.ts:1132-1133`). The prime is newest-first `ORDER BY` (`prime-digest.ts:18-23`).

### D29 - CONFIRM the leave

`deeplake-hybrid-record-operator-report.md:25` still states the constant-zero score in the present tense. The header at lines 3-12 already says the 2026-06-24 re-run cleared it, that parity is not a win, and that the body is the historical record. `hybrid-recall.ts` stays unwired. Leave the page. An optional clause under Summary is optional. Do not delete the zero-score measurements.

## Holds re-checked (leave)

These were not recommended edits. They still match source, so wave 3 should not revise them.

- H1. Embeddings are opt-out. `resolveEmbedClientOptions` enables unless the trimmed value is `false` or `0` (`src/daemon/runtime/services/embed-client.ts:171-172`).
- H2. Four lexical arms and three semantic arms. Call sites `recall.ts:573`, `:599`, `:650`, `:699`, fan-out `:2803-2809`. Semantic specs `recall.ts:1376-1410`.
- H3. `hybrid-recall.ts` is unwired. Header `hybrid-recall.ts:4-7`. No other `src/` importer.
- H4. Reranker default `none` (`config.ts:85`), provider timeout 1000 (`config.ts:99`), Cohere model `rerank-v3.5` (`config.ts:114`), local budget 300 (`config.ts:87`). Dedup runs at `recall.ts:2879-2882`. MMR engages only with a positive `tokenBudget` (`recall.ts:2933-2934`).
- H5. Route switch `api.ts:806`. Fast deadline 3000 and heavy 15000 (`amplification-config.ts:74`, `:78`). Write cap default 3 (`amplification-config.ts:61`). Read client cap 5 (`src/daemon/storage/client.ts:176`). Hook budget 6000 (`src/hooks/shared/recall-renderer.ts:64`).
- H6. `HONEYCOMB_LOCAL_ANN_INDEX` defaults on (`amplification-config.ts:48`). Class `InMemoryLocalVectorIndex` at `local-vector-index.ts:180`. Header still marks write-through and HNSW as later (`local-vector-index.ts:39-42`). The zero-round-trip sentence remains D7.
- H7. Nectar multiplier is read once at boot from `~/.apiary/nectar/nectar.json` with the legacy path as fallback (`assemble.ts:1532-1537`). Fusion scales only `hive_graph_versions` (`recall.ts:768-770`, `:2839-2842`).
- H8. Production VFS intercept is `src/hooks/runtime.ts:255-257` and `:553`. `fast: true` is the recall body (`api.ts:806`, renderer `recall-renderer.ts:158`).
- H10. Operator-report header matches the tie run (`deeplake-hybrid-record-operator-report.md:3-12`, benchmark `:92-93`).

H9 (nDCG harness) was not re-opened in this walk. Wave 1 marked it HOLDS. Leave it.

## PRD-075, PRD-076, PRD-077

**CONFIRM** all three stay in `completed`. Nothing in the walked files reopens them.

- 075. `pre-tool-use` returns `{ result, decision }` from `runPreToolUse` (`src/hooks/runtime.ts:377-381`). Production deps build `createDaemonVfsIntercept` (`runtime.ts:255-257`, rebound `:302-305`, function `:553`). Index status is already Completed (`prd-075-on-demand-recall-command-surface-index.md:3`). Children 075a, 075b, and 075c still say Draft (`:4` in each child). **CONFIRM** the status-line edit from Draft to Completed. Do not `git mv`.
- 076. The per-turn arm is `user_prompt_recall` (`src/hooks/runtime.ts:387-391`) and does not run on `session-start` (`runtime.ts:354-376`). Index status is already Completed (`prd-076-always-on-recall-and-plugin-packaging-index.md:3`). Children 076a, 076b, and 076c still say Draft. **CONFIRM** those status-line edits. The literal "fake VFS" fence in the 076 index describes the tree before PRD-075. Do not move 076 back for it. Plugin packaging files (`esbuild.config.mjs`, `package.json` allowlist) were outside this walk and were not re-opened. The hook seam the stay depends on is present.
- 077. `fast === true` selects `recallFast` (`api.ts:806`). Content-inline semantic SQL is `recall.ts:1467`. Arms run together at `recall.ts:3200-3213`. Fusion and recency are `recall.ts:3272-3284`. Shed is `recall.ts:3129-3130`. Fast deadline default 3000 is `amplification-config.ts:74`. Heavy deadline default 15000 is `amplification-config.ts:78`, applied at `recall.ts:2792`. Hook timeout is 6000 (`recall-renderer.ts:64`), which is the ISS-022 raise past the original ~4s figure. **CONFIRM** stay in completed. **CONFIRM** the index status edit from Backlog to Completed (`prd-077-per-turn-recall-fast-path-index.md:3`) and the 077a/077b Draft lines (`:4`). m-AC-10 is a dogfood record, not a missing code path. Do not move 077 back because that record is absent. The local ANN branch inside `recallFast` (`recall.ts:3172-3184`) belongs to PRD-078.

## PRD-078

**CONFIRM** stay in `in-work`. Do not `git mv` to `completed` or back to `backlog`.

- a-AC-3 heavy half is absent. `resolveMemoriesIndexRows` has one call site, inside `recallFast` (`recall.ts:3175`). `runSemanticArm` calls `vectorSearch` (`recall.ts:1534`) and does not read `localVectorIndex`. The route threads the index only when `fast === true` (`api.ts:871-874`). The fast half of the same criterion is present (`recall.ts:3011-3026`).
- a-AC-7 is absent. `library/requirements/in-work/prd-078-local-ann-recall-index/qa/` contains only `.gitkeep`.
- 078b and 078c are absent. The class exposes `buildFromRows` and `search` (`local-vector-index.ts:204`, `:238`). The header says freshness and HNSW are later (`local-vector-index.ts:39-42`). `package.json` has no `hnswlib` dependency.
- a-AC-1, a-AC-2, a-AC-4, a-AC-5, and a-AC-6 match the wave 1 MET rows on the files walked: boot-built `InMemoryLocalVectorIndex` (`local-vector-index.ts:180-204`), `search` scored by `deeplakeCosineScore` (`:238-252`) returning fast-arm rows rather than a bare `ScoredId`, fail-soft null at `recall.ts:3020-3028`, flag default on at `amplification-config.ts:48`. The `ScoredId[]` name difference does not flip a-AC-2.

**CONFIRM** the status-line edit. The folder is already `in-work`. The index still says "Backlog (in-work - Phase 1 dispatched)" (`prd-078-local-ann-recall-index-index.md:3`). Update that line so it no longer says Backlog. Do not `git mv`.

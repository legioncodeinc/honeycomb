# Wave 1a shard: ai recall and retrieval

Judged against the working tree on `legion/kb-sotu-and-prd-lifecycle`. No knowledge page, PRD, ADR, or source file was edited. ASCII hyphens only.

Verdicts: FALSE, STALE, HOLE, HOLDS. Actions: REVISE, ADD, LEAVE, REMOVE. Defect count below excludes HOLDS.

## Coverage

| File | File action | Why |
|---|---|---|
| `library/knowledge/private/ai/retrieval.md` | REVISE | Live pipeline page. Several diagrams and PRD labels contradict `recall.ts`. |
| `library/knowledge/private/ai/hybrid-sql-vector-rationale.md` | REVISE | June 2026 rationale still describes the pre-fix operator and a path-equality resolve. |
| `library/knowledge/private/ai/deeplake-hybrid-record-operator-report.md` | LEAVE | Header already records the 2026-06-24 fix and the keep-RRF decision. Body is the historical zero-score record. |
| `library/knowledge/private/ai/three-tier-memory-strategy.md` | REVISE | Prime-once boundary and prime shaping claims predate the per-turn injector and the real resolve SQL. |
| `library/knowledge/private/ai/prior-art-owls-roost-crosswalk.md` | REVISE | Cohere and recency rows describe an earlier reranker and an unshipped prime dampener. |

Related links in these five pages resolve on disk (siblings under `library/knowledge/private/ai/`, `../data/`, `../security/`, `../storage/`, ADR-0001, and the completed PRD-047 index plus `reports/2026-06-22-hybrid-benchmark-decision.md`). None of these five files should be REMOVE.

## Defects

### D1

- Quote: "applyRecencyDampening: age-decay multiplier (default off-equivalent)"
- Doc: `library/knowledge/private/ai/retrieval.md:38`
- Grounding: `src/daemon/runtime/memories/recall.ts:2910`
- Verdict: FALSE
- Action: REVISE

`recallMemories` calls `applyRecencyActivation` after dedup. The same file's table at `retrieval.md:97` already names that function and says the stage is on. `applyRecencyDampening` remains as the back-compat path (`recall.ts:1132-1133`). Default activation exponent is `1.0` (`src/daemon/runtime/recall/config.ts:192`). `recallFast` uses the same activation (`recall.ts:3284`).

### D2

- Quote: "Scope filter: org/workspace partition + agent_id read-policy" placed after token-budget assembly
- Doc: `library/knowledge/private/ai/retrieval.md:40`
- Grounding: `src/daemon/runtime/memories/recall.ts:2782`
- Verdict: FALSE
- Action: REVISE

Project scope is a SQL conjunct inside each arm (`projectConjunctFor` before the arm queries, `recall.ts:2782` and `recall.ts:590`). It is not a stage after MMR. The `agent_id` read-policy half of this node is D5.

### D3

- Quote: "`honeycomb login` provisions and owns the embed daemon"
- Doc: `library/knowledge/private/ai/retrieval.md:46`
- Grounding: `embeddings/src/index.ts:6`
- Verdict: FALSE
- Action: REVISE

The embed process is owned by the daemon supervisor, which spawns, health-checks, and crash-restarts it (`embeddings/src/index.ts:6-7`, `src/daemon/runtime/services/embed-supervisor.ts:4`). `honeycomb login` writes shared Deep Lake credentials (`src/cli/runtime.ts:495-496`). The opt-out default in the same sentence holds: see HOLDS H1.

### D4

- Quote: "lexical `ILIKE` arms (`src/daemon/runtime/memories/recall.ts:37-48`)"
- Doc: `library/knowledge/private/ai/retrieval.md:49`
- Grounding: `src/daemon/runtime/memories/recall.ts:37`
- Verdict: STALE
- Action: REVISE

Lines 37-48 are the module header. That header still describes two semantic tables and a "BM25/ILIKE" fallback. The live lexical floor is tokenized `ILIKE` with `deeplake_index` unwired (`recall.ts:519-530`) and runs at `recall.ts:2803-2809`. Point the citation at those lines.

### D5

- Quote: "the `agent_id` read-policy clause (built by `buildScopeClause` in `src/daemon/runtime/recall/scope-clause.ts`) enforces the three read policies: `isolated`, `shared`, and `group`. No content-bearing column is returned before these filters are applied."
- Doc: `library/knowledge/private/ai/retrieval.md:131`
- Grounding: `src/daemon/runtime/memories/recall.ts:76`
- Verdict: FALSE
- Action: REVISE

`recall.ts` imports `buildProjectScopeConjunct` only. It has no `buildScopeClause` and no `agent_id` predicate. `buildScopeClause` is defined at `src/daemon/runtime/recall/scope-clause.ts:205` and has no production caller under `src/`. The VFS collector states the read-policy clause is not applied there (`src/daemon/runtime/recall/collection.ts:133`). Org and workspace partitioning through `QueryScope` on `storage.query` does hold (`recall.ts:51-54`).

### D6

- Quote: "the `status = 'superseded'` column on entity attributes exclude stale versions at query time. A higher-version attribute in the same claim slot outranks the one it replaced because readers always resolve by `MAX(version)`."
- Doc: `library/knowledge/private/ai/retrieval.md:135`
- Grounding: `src/daemon/runtime/memories/recall.ts:590`
- Verdict: FALSE
- Action: REVISE

The memories arm filters `is_deleted = 0` (`recall.ts:590`, semantic hydrate `recall.ts:1385`). The recall SELECT does not read `entity_attributes`, does not test `status = 'superseded'`, and does not apply `MAX(version)`. Comments at `recall.ts:979-980` say hard-superseded rows are excluded upstream before they reach this query. `status = 'superseded'` lives on the knowledge-graph claim writer (`src/daemon/storage/catalog/knowledge-graph.ts:15`), which this page should not describe as the recall predicate.

### D7

- Quote: "content stored inline, so the fast path needs zero DeepLake round-trips"
- Doc: `library/knowledge/private/ai/retrieval.md:123`
- Grounding: `src/daemon/runtime/memories/recall.ts:1241`
- Verdict: FALSE
- Action: REVISE

The local index replaces only the `memories` semantic arm, and only when `HONEYCOMB_LOCAL_ANN_INDEX` is on and the index is `ready` (`recall.ts:3011-3026`). Sessions and hive semantic arms, plus every lexical arm, still issue Deep Lake SQL (`recall.ts:1241-1242`, `recall.ts:3186-3190`).

### D8

- Quote: "the off-in-prod rerank, and the dormant lifecycle stages"
- Doc: `library/knowledge/private/ai/retrieval.md:112`
- Grounding: `src/daemon/runtime/assemble.ts:1531`
- Verdict: STALE
- Action: REVISE

`recallFast` does skip rerank, dedup, staleness, ACT-R, conflict suppression, and calibration (`src/daemon/runtime/memories/api.ts:804-806`, `recall.ts:3088-3095`). On the heavy path those lifecycle seams are constructed and injected: conflict suppression (`assemble.ts:1531`), ACT-R activation (`assemble.ts:1562`), staleness (`assemble.ts:1570`), and the calibration model (`assemble.ts:1584`). The pipeline diagram at `retrieval.md:29-40` ends at recency plus optional MMR and omits that heavy-path tail (`recall.ts:2898-2931`). Reranker default `none` still holds (H4).

### D9

- Quote: "Recall returns `degraded: false` when the semantic arm actually ran, and `degraded: true` only on genuine fallback"
- Doc: `library/knowledge/private/ai/retrieval.md:49`
- Grounding: `src/daemon/runtime/memories/recall.ts:2777`
- Verdict: HOLE
- Action: ADD

`recallMode === "keyword"` skips the semantic arms and forces `degraded: false` (`recall.ts:2768-2816`). The route reads that vault setting (`src/daemon/runtime/memories/api.ts:760-763`). The page does not mention the mode.

### D10

- Quote: "The lexical (`ILIKE`) `sessions` arm now matches and returns `prose`"
- Doc: `library/knowledge/private/ai/retrieval.md:60`
- Grounding: `src/daemon/runtime/memories/recall.ts:1394`
- Verdict: HOLE
- Action: ADD

The lexical claim holds (`recall.ts:666-670`, `COALESCE(NULLIF(prose, ''), message::text)`). The semantic arm's text column is still `message` (`recall.ts:1394`), and the fast semantic SELECT projects that column (`recall.ts:1467`). A semantic sessions hit can still be the JSON envelope.

### D11

- Quote: "a latest-per-nectar `INNER JOIN` on a `MAX(seq)` subquery"
- Doc: `library/knowledge/private/ai/retrieval.md:64`
- Grounding: `src/daemon/runtime/memories/recall.ts:723`
- Verdict: HOLE
- Action: ADD

That `MAX(seq)` join is only in `buildHiveGraphVersionsArmSql` (`recall.ts:723`). The semantic hive arm is a flat `<#>` scan with `describe_status = 'described'` and no latest-version collapse (`recall.ts:1398-1410`).

### D12

- Quote: "Strategies (`RERANKER_STRATEGIES`): `embedding-cosine` ... `cohere` ... and `none`"
- Doc: `library/knowledge/private/ai/retrieval.md:95`
- Grounding: `src/daemon/runtime/recall/config.ts:233`
- Verdict: HOLE
- Action: ADD

The enum is `embedding-cosine`, `llm`, `cohere`, `none` (`config.ts:233`). `llm` falls through to RRF order because the branch is not built (`recall.ts:1827-1829`). Cohere wiring described in the next subsection holds (H4).

### D13

- Quote: "keeping the highest-provenance copy (memory > summary > session)"
- Doc: `library/knowledge/private/ai/retrieval.md:96`
- Grounding: `src/daemon/runtime/memories/recall.ts:1979`
- Verdict: HOLE
- Action: ADD

`provenanceRank` returns 0 for `memories`, 1 for `memory`, and 2 for every other source (`recall.ts:1979-1982`). `hive_graph_versions` therefore ties with `sessions` in dedup, while recency treats hive like `memories` (`recall.ts:2357-2360`).

### D14

- Quote: "Sessions recall chunking (ADR-0009, PR #251). ... PRD-075 (read-time windowing plus a `matchRange`) and PRD-076 (capture-time chunking ...). The ADR is committed; the code is not."
- Doc: `library/knowledge/private/ai/retrieval.md:151`
- Grounding: `library/knowledge/private/architecture/adr/0009-local-queue-as-default-deeplake-is-not-a-queue.md:1`
- Verdict: FALSE
- Action: REVISE

ADR-0009 is the local-queue decision (title at line 1, accepted 2026-07-05). It does not record an in-tree session chunker. Completed PRD-075 is the PreToolUse command surface. Completed PRD-076 is the always-on per-turn injector. `chunkText` exists for documents (`src/daemon/runtime/sources/document-worker.ts:202`) and `chunksFor` exists for Obsidian (`src/daemon/runtime/sources/providers/obsidian.ts:393`). Neither is a sessions-recall window. `recall.ts` has no `matchRange`. The following paragraph (`retrieval.md:152`) correctly says the PreToolUse seam is live; it still leaves this bullet's PRD numbers in place.

### D15

- Quote: "`hivemind_search` routes here"
- Doc: `library/knowledge/private/ai/retrieval.md:156`
- Grounding: ABSENT
- Verdict: FALSE
- Action: REVISE

`hivemind_search` is absent from `src/hooks/runtime.ts`. The handler posts to `/api/memories/recall` (`mcp/src/handlers.ts:309`, tool blurb `mcp/src/tools.ts:112-114`). `src/hooks/runtime.ts:255-257` and `:553` build `createDaemonVfsIntercept` for PreToolUse browse. That VFS sentence can stay. The mine tool is scored recall, which `hybrid-sql-vector-rationale.md` and `three-tier-memory-strategy.md` already say.

### D16

- Quote: "see `src/daemon/runtime/recall/CONVENTIONS.md` for the de-scope rationale"
- Doc: `library/knowledge/private/ai/retrieval.md:27`
- Grounding: `src/daemon/runtime/recall/CONVENTIONS.md:14`
- Verdict: HOLE
- Action: REVISE

The de-scope of the five-phase `RecallEngine` holds (`CONVENTIONS.md:11-13`). The same paragraph still calls live recall "lexical UNION-ALL". Live recall is per-arm (`recall.ts:24-35`, `recall.ts:2803-2809`). A reader who treats that file as the SQL description will copy the wrong shape.

### D17

- Quote: Related list ends at the 2026-07-10 findings note and does not name the zoom strategy or the prior-art crosswalk
- Doc: `library/knowledge/private/ai/retrieval.md:8`
- Grounding: `library/knowledge/private/ai/three-tier-memory-strategy.md:20`
- Verdict: HOLE
- Action: ADD

`three-tier-memory-strategy.md` and `prior-art-owls-roost-crosswalk.md` exist and point at `retrieval.md`. The retrieval Related list does not point back.

### D18

- Quote: "Deep Lake's native `deeplake_hybrid_record` operator does NOT work for us and must not be used. ... it is filed as a vendor bug"
- Doc: `library/knowledge/private/ai/hybrid-sql-vector-rationale.md:96`
- Grounding: `src/daemon/runtime/memories/hybrid-recall.ts:4`
- Verdict: STALE
- Action: REVISE

The operator module is still unwired (`hybrid-recall.ts:4-7`; no other `src/` importer). The zero-score failure is the 2026-06-22 run. The 2026-06-24 re-run in the linked benchmark report shows parity (recall@5 0.611 vs 0.611) and an unchanged keep-RRF decision (`library/requirements/completed/prd-047-retrieval-quality-upgrades/reports/2026-06-22-hybrid-benchmark-decision.md:76-93`). `retrieval.md:86-87` and the operator-report header already say this. Line 103 of the rationale still calls the operator a vendor bug.

### D19

- Quote: "Measured live: recall@5 ≈ 0.72-0.78."
- Doc: `library/knowledge/private/ai/hybrid-sql-vector-rationale.md:94`
- Grounding: `library/requirements/completed/prd-047-retrieval-quality-upgrades/reports/2026-06-22-hybrid-benchmark-decision.md:17`
- Verdict: STALE
- Action: REVISE

0.722-0.778 is the 2026-06-22 RRF band (benchmark report line 17). The 2026-06-24 re-run measured RRF recall@5 at 0.611 (same report, line 92). Those numbers are not in `recall.ts`. The committed gate floor is `eval/recall-baseline.json` `recallAt5` 0.55 with `placeholder: false`.

### D20

- Quote: "a `<#>` semantic arm and a BM25/`ILIKE` lexical arm"
- Doc: `library/knowledge/private/ai/hybrid-sql-vector-rationale.md:93`
- Grounding: `src/daemon/runtime/memories/recall.ts:523`
- Verdict: STALE
- Action: REVISE

`buildLexicalMatchSql` states that Deep Lake `deeplake_index` is not wired and the predicate is tokenized `ILIKE` (`recall.ts:519-530`). `RRF_K = 60` and arm weights 1.0 / 0.4 in the same sentence hold (`recall.ts:238`, `recall.ts:255-257`).

### D21

- Quote: "`SELECT … WHERE path = '<id>'` (and the raw turns are `SELECT … FROM sessions WHERE path = '<session>'`)"
- Doc: `library/knowledge/private/ai/hybrid-sql-vector-rationale.md:64`
- Grounding: `src/daemon/runtime/memories/resolve.ts:16`
- Verdict: FALSE
- Action: REVISE

Depth 1 is a guarded select of `memory.summary` or `memories.content` by path or id (`resolve.ts:11-12`). Depth 2 does not match `sessions.path` to the summary path. Capture stores the transcript path on `sessions.path` and the session identity in `sessions.id`, so depth 2 uses `id LIKE 'sess-<sessionId>-%'` plus a post-filter (`resolve.ts:16-29`). `GET /api/memories/resolve` is the route (`src/daemon/runtime/memories/api.ts:964`). `hivemind_read` calls that route (`mcp/src/handlers.ts:298-304`).

### D22

- Quote: "semantic similarity matters, this is the `<#>` cosine vector path, fused with the lexical arm via RRF"
- Doc: `library/knowledge/private/ai/hybrid-sql-vector-rationale.md:47`
- Grounding: `src/daemon/runtime/memories/recall.ts:3001`
- Verdict: HOLE
- Action: ADD

The heavy path still runs `<#>` (`recall.ts:1376-1410`). The per-turn path (`fast: true`, `api.ts:806`) serves the `memories` semantic arm from `InMemoryLocalVectorIndex` when the index is ready (`recall.ts:3001-3026`). The rationale's "mining path actually uses" section (`hybrid-sql-vector-rationale.md:88`) does not mention that split.

### D23

- Quote: "Prime per session, pull per turn, never auto-inject per turn."
- Doc: `library/knowledge/private/ai/three-tier-memory-strategy.md:124`
- Grounding: `src/hooks/runtime.ts:387`
- Verdict: FALSE
- Action: REVISE

`HookRuntime` dispatches `user_prompt_recall` to `runUserPromptRecall` (`src/hooks/runtime.ts:387-391`). The renderer posts `fast: true` to `/api/memories/recall` (`src/hooks/shared/recall-renderer.ts:151-158`). That is automatic per-turn injection. Session-start prime still exists (`src/daemon/runtime/memories/api.ts:1017`, `src/daemon/runtime/memories/prime.ts:192`). The boundary should say prime once, plus a bounded per-turn fast inject, plus on-demand pull.

### D24

- Quote: "047b reranker / 047c semantic dedup / 047d recency dampening / 047e MMR / 047f graded-nDCG eval are wired into both the mining path and the prime"
- Doc: `library/knowledge/private/ai/three-tier-memory-strategy.md:141`
- Grounding: `src/daemon/runtime/summaries/prime-digest.ts:21`
- Verdict: FALSE
- Action: REVISE

Recall mining runs dedup and class-aware activation (D1, `recall.ts:2874-2910`). The prime assembler says the PRD-047d dampener is not built: default recency is the skim's `ORDER BY` date, and semantic dedup is a later seam (`prime-digest.ts:21-36`). The default deduper is normalized text (`prime-digest.ts:102`, `prime-digest.ts:258-259`). `prime.ts` issues `skimPrimeKeys` only (`prime.ts:128`).

### D25

- Quote: "depth 2 (RAW): fetch the `sessions` rows linked to that summary (same `path` / session id)."
- Doc: `library/knowledge/private/ai/three-tier-memory-strategy.md:107`
- Grounding: `src/daemon/runtime/memories/resolve.ts:18`
- Verdict: FALSE
- Action: REVISE

Same fact as D21. The sentence's "same path" is the join `resolve.ts` explicitly rejects (`resolve.ts:18-20`).

### D26

- Quote: "the engine keeps post-query RRF. The 3-tier mining path rides RRF, which measured recall@5 ≈ 0.72-0.78 live."
- Doc: `library/knowledge/private/ai/three-tier-memory-strategy.md:139`
- Grounding: `library/requirements/completed/prd-047-retrieval-quality-upgrades/reports/2026-06-22-hybrid-benchmark-decision.md:92`
- Verdict: STALE
- Action: REVISE

The same paragraph already says the vendor fix only ties RRF, which matches the operator-report header. The 0.72-0.78 figure is the 2026-06-22 band. The tie run is recall@5 0.611 for both paths (benchmark report lines 92-93). Date the older band or replace it with the tie run.

### D27

- Quote: "Honeycomb reranks via its own configured reranker (embedding-cosine default / LLM), not a Cohere dependency."
- Doc: `library/knowledge/private/ai/prior-art-owls-roost-crosswalk.md:62`
- Grounding: `src/daemon/runtime/recall/config.ts:85`
- Verdict: FALSE
- Action: REVISE

Default strategy is `none` (`config.ts:85`, `recall.ts:1068`). `embedding-cosine` is optional and local (`recall.ts:1830`). `llm` is named and unimplemented (`recall.ts:1827-1829`). `cohere` is a real strategy: `rerank-v3.5` through Portkey when `HONEYCOMB_RECALL_RERANKER=cohere` and the gateway seam is injected (`config.ts:114`, `recall.ts:1822-1824`, `src/daemon/runtime/recall/rerank-portkey.ts:11`). It is opt-in, which is the part of ADAPT that still holds.

### D28

- Quote: "TRANSFER (already in flight). This is exactly PRD-047d recency dampening. The recent timestream prime is age-weighted; durable facts age slowly."
- Doc: `library/knowledge/private/ai/prior-art-owls-roost-crosswalk.md:56`
- Grounding: `src/daemon/runtime/memories/recall.ts:1126`
- Verdict: STALE
- Action: REVISE

Recall recency is shipped, not in flight. The live stage is PRD-058a `applyRecencyActivation` with half-lives memories 180d / memory 45d / sessions 10d (`recall.ts:1126-1130`, `config.ts:180-184`). `applyRecencyDampening` is the old near-flat function and is not the stage `recallMemories` calls (`recall.ts:1132-1133`). The prime is newest-first `ORDER BY`, not that dampener (`prime-digest.ts:18-23`).

### D29

- Quote: "The `deeplake_hybrid_record` operator parses and executes without error (`kind=ok`) on our `memories` table, but returns `score = 0.000000` for every row"
- Doc: `library/knowledge/private/ai/deeplake-hybrid-record-operator-report.md:25`
- Grounding: `library/knowledge/private/ai/deeplake-hybrid-record-operator-report.md:3`
- Verdict: STALE
- Action: LEAVE

The header at lines 3-12 already says the 2026-06-24 re-run cleared the constant zero, that parity is not a win, and that the body is the historical record. `hybrid-recall.ts` stays unwired (H3). Do not delete the zero-score measurements. A later editor can add one clause under "Summary" that the present tense is the 2026-06-22 observation. That is optional. The page should stay.

## Claims that hold (action LEAVE)

### H1

- Quote: "`HONEYCOMB_EMBEDDINGS` is opt-out: unset/`true`/`1` is on, only an explicit `false`/`0` turns it off."
- Doc: `library/knowledge/private/ai/retrieval.md:46`
- Grounding: `src/daemon/runtime/services/embed-client.ts:170`
- Verdict: HOLDS
- Action: LEAVE

`resolveEmbedClientOptions` enables unless the trimmed value is `false` or `0` (`embed-client.ts:171-172`). Model id `nomic-ai/nomic-embed-text-v1.5` and 768 dims hold (`embeddings/src/index.ts:42-46`). Non-768 vectors are rejected (`embed-client.ts:272`). Production store embed is `createEmbedAttachment` (`src/daemon/runtime/assemble.ts:3564`). The `noopEmbedClient` export remains (`embed-client.ts:118`) and is not the production default. Do not revise this page back to opt-in.

### H2

- Quote: "four lexical arms" `memories`, `memory`, `sessions`, `hive_graph_versions`, per-arm, `prose` on sessions
- Doc: `library/knowledge/private/ai/retrieval.md:53`
- Grounding: `src/daemon/runtime/memories/recall.ts:2803`
- Verdict: HOLDS
- Action: LEAVE

Call sites: `buildMemoriesArmSql` `recall.ts:573`, `buildMemoryArmSql` `recall.ts:599`, `buildSessionsArmSql` `recall.ts:650`, `buildHiveGraphVersionsArmSql` `recall.ts:699`. `buildLexicalMatchSql` is `recall.ts:546`. Semantic arms are memories, sessions, hive (`recall.ts:1376-1410`). `embeddingColumnFor` returns null for `memory` (`recall.ts:1700-1704`). Catalog still declares `summary_embedding` (`src/daemon/storage/catalog/sessions-summaries.ts:107`).

### H3

- Quote: "`src/daemon/runtime/memories/hybrid-recall.ts` is kept as an unwired live reference"
- Doc: `library/knowledge/private/ai/retrieval.md:87`
- Grounding: `src/daemon/runtime/memories/hybrid-recall.ts:4`
- Verdict: HOLDS
- Action: LEAVE

`hybridRecall` is exported (`hybrid-recall.ts:241`) and is not mounted from `api.ts`. `npm run bench:hybrid` exists (`package.json` script `bench:hybrid`).

### H4

- Quote: reranker default `none`; Cohere model `rerank-v3.5`; provider timeout 1000ms; local cosine budget 300ms; dedup default on; MMR only with a positive `tokenBudget`
- Doc: `library/knowledge/private/ai/retrieval.md:95`
- Grounding: `src/daemon/runtime/recall/config.ts:85`
- Verdict: HOLDS
- Action: LEAVE

Constants: `DEFAULT_RERANKER` `config.ts:85`, timeout `config.ts:87`, provider timeout `config.ts:99`, model `config.ts:114`. Engine skip and cohere branch: `recall.ts:2854-2872` and `recall.ts:1822-1824`. Dedup default on is the deps comment at `recall.ts:1100-1102` and the call at `recall.ts:2879-2882`. Budget gate: `recall.ts:2948-2949`.

### H5

- Quote: read client `Semaphore(5)`, write client `Semaphore(3)`, fast deadline about 3s, heavy deadline about 15s, hook timeout 6000, `fast: true` selects `recallFast`
- Doc: `library/knowledge/private/ai/retrieval.md:116`
- Grounding: `src/daemon/runtime/memories/api.ts:806`
- Verdict: HOLDS
- Action: LEAVE

Route switch: `api.ts:800-806`. `cwd` schema field is `api.ts:408` (the page's "near 405" is this field). Write cap default 3: `src/daemon/runtime/memories/amplification-config.ts:61`. Fast deadline 3000 and heavy 15000: `amplification-config.ts:74` and `:78`. Read client cap 5: `src/daemon/storage/client.ts:176` and `src/daemon/runtime/assemble.ts:3092-3107`. Hook budget: `src/hooks/shared/recall-renderer.ts:64`. There is also a recall-arm pool default 6 and a fast pool default 8 (`amplification-config.ts:50`, `:72`). Those sit above the storage cap. The page's 5 and 3 figures are the storage clients.

### H6

- Quote: "`HONEYCOMB_LOCAL_ANN_INDEX` (default on)"; `InMemoryLocalVectorIndex`; 078b/c freshness and HNSW not built
- Doc: `library/knowledge/private/ai/retrieval.md:123`
- Grounding: `src/daemon/runtime/memories/local-vector-index.ts:41`
- Verdict: HOLDS
- Action: LEAVE

Flag default true: `amplification-config.ts:48`. Class: `local-vector-index.ts:180`. Scorer: `deeplakeCosineScore` at `src/daemon/storage/vector.ts:308`, used at `local-vector-index.ts:252`. Comment at `local-vector-index.ts:41` still marks write-through and HNSW as later. The zero-round-trip sentence is D7; the class, flag, and 078b/c status stay.

### H7

- Quote: nectar multiplier read once at boot from `~/.apiary/nectar/nectar.json`, legacy `~/.honeycomb/nectar.json`, clamp `[0, 10]`, default 1.0
- Doc: `library/knowledge/private/ai/retrieval.md:83`
- Grounding: `src/daemon/runtime/memories/nectar-recall-config.ts:86`
- Verdict: HOLDS
- Action: LEAVE

New path first, then legacy (`nectar-recall-config.ts:86-99`). Boot call: `assemble.ts:1532-1537`. Fusion scales only `hive_graph_versions` (`recall.ts:768-769`). The `recall.ts` deps comment at `recall.ts:1119` still names only the legacy path. The knowledge page is the one that matches the reader.

### H8

- Quote: "`src/hooks/runtime.ts` builds `createDaemonVfsIntercept` for production deps. A per-turn recall body can set `fast: true`"
- Doc: `library/knowledge/private/ai/retrieval.md:152`
- Grounding: `src/hooks/runtime.ts:255`
- Verdict: HOLDS
- Action: LEAVE

Production vfs: `runtime.ts:255-257`, rebound on pre-tool-use at `runtime.ts:302-305`, function at `runtime.ts:553`. `fast: true` is the recall body (`api.ts:419`, renderer `recall-renderer.ts:158`), not a field `runtime.ts` sets itself. The PreToolUse seam is real. D14 is only the chunking bullet above this paragraph.

### H9

- Quote: nDCG@10 is dedup-invariant and the recall@5 / MRR baseline gates ranking changes
- Doc: `library/knowledge/private/ai/retrieval.md:139`
- Grounding: `src/eval/metrics.ts:194`
- Verdict: HOLDS
- Action: LEAVE

`runEval` is `src/eval/golden.ts:217`. `ndcgAtK` takes `RelevanceClasses` (`metrics.ts:109`, `metrics.ts:194`). `npm run eval:recall` is `package.json`. Committed baseline `eval/recall-baseline.json` has `recallAt5` 0.55, `mrr` 0.55, `ndcg` 0.55, `placeholder` false, so the nDCG arm is enforced (`golden.ts:370-374`).

### H10

- Quote: operator report header: fixed 2026-06-24, recall@5 0.611 vs 0.611, keep RRF, operator is a revisit candidate
- Doc: `library/knowledge/private/ai/deeplake-hybrid-record-operator-report.md:3`
- Grounding: `src/daemon/runtime/memories/hybrid-recall.ts:4`
- Verdict: HOLDS
- Action: LEAVE

Matches ADR-0001 (`library/knowledge/private/architecture/adr/0001-retrieval-fusion-rrf-vs-native-hybrid.md:31`) and the benchmark re-run section (D19 grounding). `retrieval.md:86-87` matches this header. D18 and D26 are the sibling pages that still lead with the June 22 numbers.

## Files read

Knowledge: `library/knowledge/private/ai/retrieval.md`, `hybrid-sql-vector-rationale.md`, `deeplake-hybrid-record-operator-report.md`, `three-tier-memory-strategy.md`, `prior-art-owls-roost-crosswalk.md`.

Grounding set: `src/daemon/runtime/memories/recall.ts`, `hybrid-recall.ts`, `api.ts`, `src/hooks/runtime.ts`, `embeddings/src/index.ts`, `src/daemon/runtime/services/embed-client.ts`.

Named or required neighbors: `src/daemon/runtime/recall/CONVENTIONS.md`, `scope-clause.ts`, `collection.ts`, `config.ts`, `rerank-portkey.ts`, `src/daemon/runtime/memories/nectar-recall-config.ts`, `amplification-config.ts`, `local-vector-index.ts`, `prime.ts`, `resolve.ts`, `src/daemon/runtime/summaries/prime-digest.ts`, `src/daemon/runtime/assemble.ts`, `src/daemon/storage/client.ts`, `vector.ts`, `catalog/sessions-summaries.ts`, `catalog/knowledge-graph.ts`, `src/daemon/runtime/services/embed-supervisor.ts`, `src/hooks/shared/recall-renderer.ts`, `src/eval/golden.ts`, `metrics.ts`, `eval/recall-baseline.json`, `mcp/src/tools.ts`, `mcp/src/handlers.ts`, `package.json` scripts, ADR-0001, ADR-0009, PRD-047 benchmark decision report, PRD-075 index, PRD-076 index.

Skipped: `node_modules`, `daemon/`, `bundle/`, harness bundles, `embeddings/embed-daemon.js`.

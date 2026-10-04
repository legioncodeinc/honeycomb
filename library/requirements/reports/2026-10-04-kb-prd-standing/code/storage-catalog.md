# Code standing: storage and catalog

Date: 2026-10-04
Shard: Wave 2, storage and catalog
Inputs: `knowledge/data.md`, `knowledge/storage.md`, `prds/completed-001-008.md` (PRD-002 and PRD-003 only)
Walk: `src/daemon/storage/` (catalog, sql, transport, vector, schema, client, heal, writes). Cited lines outside that tree were opened only to check a recommendation. Build outputs and `node_modules` were not used.
Mode: read-only except this report. No docs, source, or commits were edited.

Verdicts on each recommended REVISE, ADD, REMOVE, or PRD move: CONFIRM, OVERTURN, or UNVERIFIABLE. A move back to in-work requires a still-required criterion that is absent. A criterion replaced by a later shipped requirement stays completed. Absence of a sibling repo is not a demotion.

## Counts

| Set | CONFIRM | OVERTURN | UNVERIFIABLE |
|---|---|---|---|
| data/ doc edits (26) | 26 | 0 | 0 |
| storage/ doc edits (10) | 10 | 0 | 0 |
| PRD-002 stay completed | 1 | 0 | 0 |
| PRD-003 move to in-work | 0 | 1 | 0 |
| Total | 37 | 1 | 0 |

No REMOVE was recommended. REPORTED measurement blocks in the storage notes stay LEAVE and were not re-judged.

## Knowledge: data/

### D-01 sessions CREATE TABLE omits live columns - CONFIRM

`schema.md:38-55` prints `prose` immediately after `message` and stops at `last_update_date`. `SESSIONS_COLUMNS` places `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens` as nullable `BIGINT` (`sessions-summaries.ts:66-69`), then `model` `TEXT NOT NULL DEFAULT ''` (`:77`), `source_tool` `TEXT NOT NULL DEFAULT ''` (`:82`), and `prose` before `creation_date` (`:88-90`). Capture writes `source_tool`, `model`, `prose`, and the usage columns from `buildRow` (`capture-handler.ts:690-718`).

### D-02 sessions token sentence miscounts and omits model - CONFIRM

`schema.md:319` says five additive token/cache columns and names four, plus `source_tool`. The catalog adds those four plus `model` (`sessions-summaries.ts:66-82`). The nullable `BIGINT` with no default is the "token data absent" rule (`:57-65`).

### D-03 memory_jobs described as the restart-surviving distillation queue - CONFIRM

`memory_jobs` still exists with statuses `queued`, `leased`, `done`, `failed`, and `dead` (`runtime-jobs.ts:63-71`) and pattern `version-bumped` (`:127-133`). When `HONEYCOMB_LOCAL_QUEUE_ENABLED` is unset, `resolveHybridJobQueueConfig` takes `resolveLocalQueueTopology().eligibleForDefaultOn` (`hybrid-job-queue.ts:46-59`). An undeclared topology is eligible (`local-queue-diagnostics.ts:111-121`). Distillation kinds in `DEFAULT_LOCAL_JOB_KINDS` include `memory_extraction`, `summary`, and `skillify` (`hybrid-job-queue.ts:15-26`). The restart-surviving file is `honeycombStateDir()` via `resolveLocalQueueBaseDir` (`assemble.ts:2128-2129`, `fleet-root.ts:103-104`). Fleet and multi-device topologies stay on the shared queue (`local-queue-diagnostics.ts:102-107`), so `memory_jobs` remains the shared fallback. The retention row at `schema.md:327` still describes that table as the live queue.

Same retention table, same revise: `schema.md:325` says sessions prune retains summaries in `memory`. The shipped prune tombstones the paired summary (`prune.ts:5-10`). That sentence follows the superseded 003c AC-6, recorded under the PRD-003 overturn below.

### D-04 entity_attributes DDL default and columns - CONFIRM

`schema.md:133` prints `confidence FLOAT4 NOT NULL DEFAULT 0.0` and the block at `:126-142` ends at `updated_at`. `ENTITY_ATTRIBUTES_COLUMNS` sets `confidence` to `FLOAT4 NOT NULL DEFAULT 1.0` (`knowledge-graph.ts:142`), and also has `visibility` (`:149`), the provenance quartet (`:76-79`, spread at `:152`), and `content_embedding` (`:153`).

### D-05 codebase DDL type and columns - CONFIRM

`schema.md:195` types `snapshot_jsonb` as `TEXT NOT NULL DEFAULT ''`. `CODEBASE_COLUMNS` types it `JSONB` (`product.ts:231`) and also has `parent_sha`, `pushed_by` (`:227-228`), `generator_name` `TEXT NOT NULL DEFAULT 'honeycomb-graph'` (`:236`), and `created_at` (`:240`). The printed table at `schema.md:186-200` omits them. There is no `ts` column.

### D-06 agents CREATE TABLE omits tenancy columns - CONFIRM

`schema.md:208-215` lists `id`, `name`, `read_policy`, `policy_group`, `created_at`, `updated_at`. `AGENTS_COLUMNS` adds `org_id` and `workspace_id` (`tenancy.ts:85-86`). `read_policy` default `'isolated'` matches (`tenancy.ts:83`, `schema.md:211`).

### D-07 intro assigns org_id and workspace_id to synced_assets - CONFIRM

`schema.md:20` names `codebase`, `projects`, and `synced_assets` as carrying `org_id` and `workspace_id`. `codebase` and `projects` do (`product.ts:218-219`, `projects.ts:163-164`). `synced_assets` uses `org` and `workspace` (`synced-assets.ts:106-107`), which the later DDL at `schema.md:254-255` already prints. The parenthetical at `schema.md:220` matches `agents` (`tenancy.ts:85-86`) and mismatches `synced_assets`.

### D-08 memories CREATE TABLE omits lifecycle columns - CONFIRM

`schema.md:91-114` ends at `created_at` and `updated_at`. Those columns match `MEMORIES_COLUMNS` through `:80`. The catalog continues with `last_reinforced_at`, `access_count`, `ref_status`, `verified_at`, `stale_refs`, `access_compacted_at`, and `access_compacted_id` (`memories.ts:86-133`).

### D-09 canonical catalog never names several live tables - CONFIRM

`CATALOG` spreads groups `schema.md` never names as tables (`catalog/index.ts:46-61`): `memory_conflicts` (`memory-conflicts.ts:175`), `memory_access` and `memory_calibration` (`memory-lifecycle.ts:133-135`), `memory_injections` (`memory-injections.ts:51`), `pollinating_state` (`pollinating-state.ts:57`), and `routing_history` (`routing-history.ts:57`). `TENANCY_TABLES` also includes `telemetry_counters`, `recall_qa_ledger`, and `router_history` (`tenancy.ts:352-366`). The telemetry blurb at `schema.md:264-266` describes counters, a QA ledger, and routing history without those table names. `api_keys` is prose at `schema.md:204`; columns are `tenancy.ts:127-143`.

### D-10 hive_graph_versions is a recall arm with no catalog table - CONFIRM

`schema.md:62` names semantic arms `memories`, `sessions`, and `hive_graph_versions`. That matches `SEMANTIC_ARMS` (`recall.ts:1376-1410`), including `nectar`, `embedding`, `description`, `described_at`, and `describe_status` (`:1403-1409`). A search of `src/daemon/storage` finds no `hive_graph` column array. Add a pointer that the arm is outside this catalog. Do not invent a CREATE TABLE. The table's absence from this repo is not a reason to drop the arm sentence or to demote a PRD.

### D-11 DeepLake page says every durable byte is in DeepLake - CONFIRM

`deeplake-storage.md:19` says every durable byte is in DeepLake. The default job queue is SQLite at the fleet state root (`assemble.ts:2128-2129`). `capture_outbox` is a second table in that `local-queue.db` (`capture-outbox.ts:84-85`) with a terminal `dead` status (`:94`). Codebase snapshots are written under `honeycombStateDir()/graphs/<repo>` (`snapshot.ts:197-202`) before any DeepLake push. DeepLake remains the catalog store for `src/daemon/storage/catalog`.

### D-12 workspace resolution order is absent from source - CONFIRM

`workspace-layout.md:98-105` lists `--path`, `HONEYCOMB_PATH`, `~/.config/honeycomb/workspace.json`, and default `~/.honeycomb/`, plus `honeycomb workspace set`. A search of `src/` finds no `HONEYCOMB_PATH` and no `workspace.json`. The daemon candidate is trimmed `HONEYCOMB_WORKSPACE`, otherwise `process.cwd()` (`assemble.ts:2071-2073`).

### D-13 writable workspace fallback is still documented as ~/.honeycomb - CONFIRM

`workspace-layout.md:115-116` says `resolveDaemonWorkspace()` falls back to `~/.honeycomb` and `resolveWorkspaceBaseDir()` does the same. `resolveDaemonWorkspace` probes `HONEYCOMB_WORKSPACE` when set, otherwise the CLI cwd, then `runtimeDir()` (`runtime.ts:195-201`), and `runtimeDir` is `honeycombStateDir()` (`:181-183`). `resolveWorkspaceBaseDir` falls back to `honeycombStateDir()` (`assemble.ts:2084`). The fleet-root section at `workspace-layout.md:121-124` already states that root.

Same revise: `workspace-layout.md:109` still says the secrets store and the log store both come from `HONEYCOMB_WORKSPACE ?? process.cwd()`. Logs stay on `resolveWorkspaceBaseDir()` (`assemble.ts:3039-3041`). The vault is `resolveVaultBaseDir()` which returns `honeycombStateDir()` (`assemble.ts:2112-2113`).

### D-14 identity presets are not in source - CONFIRM

`workspace-layout.md:83-88` lists presets `minimal`, `hermes`, `openclaw`, and `custom`, plus `HEARTBEAT.md` and `BOOTSTRAP.md`. A search of `src/` finds none of those names. The watcher set is `agent.yaml`, `AGENTS.md`, `SOUL.md`, `MEMORY.md`, `IDENTITY.md`, and `USER.md` (`harness-sync.ts:69-76`). Pollinating still describes an identity preset seam and loads `POLLINATING.md` only for that pass (`incremental.ts:74-91`). It does not define the four-row preset table.

### D-15 closing paragraph puts jobs and telemetry only in DeepLake - CONFIRM

`workspace-layout.md:163` puts jobs and telemetry in DeepLake with sessions and memories. Sessions and memories are catalog tables. The default job queue is the fleet-anchored SQLite file this page already describes at `:141-149`. Telemetry SQLite is named at `:130`. The next sentence (`:164`) says queues belong in DeepLake. The closing paragraph should follow those two sections.

### D-16 codebase graph paths still say src/graph and ~/.honeycomb - CONFIRM

`codebase-graph.md:20`, `:30`, and `:53` cite `src/graph/` and `~/.honeycomb/graphs` plus `~/.honeycomb/graph-ignore.json`. `src/graph/` is absent. Implementation is `src/daemon/runtime/codebase/`. The cache dir is `join(honeycombStateDir({ home }), "graphs", repoKey)` (`snapshot.ts:197-202`). The ignore file is `graph-ignore.json` under that state dir, with a legacy `~/.honeycomb/graph-ignore.json` fallback (`discovery.ts:199-208`).

### D-17 pasted extractFile is not the current function - CONFIRM

The pasted signature is `extractFile(sourceCode, relativePath): FileExtraction`. The live function is `async function extractFile(sourceFile, content, sha?): Promise<FileExtraction | null>` (`extract.ts:264-269`). Language comes from `languageForFile` and `EXTENSION_LANGUAGE` (`:64-86`), covering TypeScript, JavaScript, Python, Go, Rust, Java, Ruby, C, and C++. `.d.ts` returns null (`:109`).

### D-18 node id and kind model - CONFIRM

`kind` is `file` or `symbol` (`contracts.ts:84`). A file node id is the source file. A symbol id is `<source_file>#<name>` with an optional `:<ord>` (`:141-144`). `symbolKind` is `function`, `method`, `class`, `interface`, `struct`, `enum`, `type`, `variable`, `constant`, or `module` (`:95-106`). The doc's `<source_file>:<symbol_name>:<kind>` id and its `kind` list (`type_alias`, `const`) do not match.

### D-19 pull ordering column is created_at - CONFIRM

`codebase-graph.md:167` says `ORDER BY ts DESC LIMIT 1`. Pull drops `worktree_id` and orders by `created_at DESC` (`push-pull.ts:441-444`). `CODEBASE_COLUMNS` has `created_at` and no `ts` (`product.ts:240`).

### D-20 graph diff, history, init, and pull CLI verbs - CONFIRM

The daemon graph mount is `POST /api/graph/build` and `GET /api/graph` (`api.ts:320-341`). `pullSnapshot` exists (`push-pull.ts:461`) and is not mounted in `api.ts`. A search of `src/daemon/runtime/codebase` finds no `history.jsonl` and no `post-commit`. `honeycomb graph` is a storage verb (`contracts.ts:158`) routed to `/api/graph` (`storage-handlers.ts:45`); a `build` subcommand POSTs `/api/graph/build` (`storage-handlers.ts:220-229`). Keep the build verb. Drop or re-source diff, history, init, and pull.

### D-21 VFS module path and DeepLakeFs maps - CONFIRM

`src/shell/deeplake-fs.ts` is absent. `DeepLakeFs` is `src/daemon-client/vfs/fs.ts`. The class holds `dispatch`, `scope`, `cache`, `pending`, `snapshots`, and a `WriteBuffer` (`fs.ts:56-73`). The four maps `files`, `meta`, `dirs`, and `pending` are not the class fields.

### D-22 pasted classifyPath is not the current classifier - CONFIRM

`src/shell/goal-paths.ts` is absent. `classifyPath` is `src/daemon-client/vfs/classify.ts:94-111`. It returns `index`, `session`, and `graph` (`:99-104`) before the goal and kpi checks. Goal shape `goal/<owner>/<status>/<goal_id>.md` and kpi shape `kpi/<goal_id>/<kpi_id>.md` still match (`:28-31`, `:63-75`).

### D-23 memory mount display path - CONFIRM

Generated index text uses `MEMORY_MOUNT_DISPLAY_PATH` = `~/.apiary/honeycomb/memory/` (`index-gen.ts:32`). The comment above it says the pre-tool-use classifier still recognizes the legacy `~/.honeycomb/memory/` shape (`:28-30`).

### D-24 goals body is the catalog value column - CONFIRM

`GOALS_COLUMNS` and `KPIS_COLUMNS` are `key`, `value`, `target`, `status`, `unit`, `agent_id`, `visibility`, `created_at`, `updated_at` (`product.ts:162-172`). `buildGoalInsertSql` inserts `key`, `value`, `status`, and `agent_id` (`write-buffer.ts:501-510`). The markdown body is `value`. The goal id is `key`. Owner is written into `agent_id`. There is no `content` column and no `goal_id` column.

### D-25 sessions bootstrap no longer uses size_bytes - CONFIRM

`buildRecentSessionsSql` groups by `path` and takes `MAX(creation_date)` (`index-gen.ts:58-65`). `buildRecentMemoriesSql` selects `path` and `summary` (`:44-49`). Neither `SESSIONS_COLUMNS` nor `MEMORY_COLUMNS` defines `size_bytes`.

### D-26 pasted readGraphFile is absent - CONFIRM

`src/graph/vfs-handler.ts` is absent. There is no `readGraphFile`. `resolveGraph` loads a local snapshot and, when the snapshot is null, returns a `no-graph:` string body (`read.ts:113-119`). `handleGraphVfs` returns a string (`query.ts:148`). The endpoint list matches the switch in `query.ts:153-178` (`index.md`, `find`, `query`, `show`, `impact`, `neighborhood`, `layers`, `tour`, `path`).

## Knowledge: storage/

### D1 open issue still says cwd receives .daemon/ and .secrets/ - CONFIRM

`deeplake-recall-and-capture-findings-2026-07-10.md:109` cites `assemble.ts:1950-1952` for writing `.daemon/` and `.secrets/` into `process.cwd()`. `workspaceBaseDirCandidate` still returns `process.cwd()` when `HONEYCOMB_WORKSPACE` is blank, at `assemble.ts:2071-2073`. The vault is `resolveVaultBaseDir()` = `honeycombStateDir()` (`assemble.ts:1998-2004`, `:2112-2113`, `:2815`). The queue is `resolveLocalQueueBaseDir()` (`:2128-2129`, opened at `:3178-3179`). What still follows the workspace dir, and therefore cwd when the env is unset: `agent.yaml` (`:2166`) and `.daemon/logs.db` (`:3039-3041`). Revise the open-issue line and the appendix anchor. Keep the historical scattered-state sentence.

### D2 every statement is bounded by 10s - CONFIRM

`DEFAULT_QUERY_TIMEOUT_MS = 10_000` is `config.ts:24`. The schema clamps the env value up to `600_000` (`config.ts:32-39`). `HONEYCOMB_QUERY_TIMEOUT_MS` is read at `config.ts:114`. `runAttempt` uses `opts.timeoutMs ?? this.config.queryTimeoutMs` (`client.ts:548`) and aborts with `AbortController` (`:554`). Revise the second sentence at findings `:31` to default 10s, overridable by `HONEYCOMB_QUERY_TIMEOUT_MS` and per-call `timeoutMs`.

### D3 unsafe-write short-circuit cited at client.ts:477 - CONFIRM

The short-circuit is `client.ts:497` (`if (retryability === "unsafe-write") return this.attemptOnce(...)`). Lines 473-477 are the `maxAttempts` comment. Capture also passes `maxAttempts: 1` (`capture-handler.ts:101`). Revise the line number. Leave the conclusion that captures were already single-attempt.

### D4 <#> score anchor vector.ts:242 - CONFIRM

`cosineSimilarity` starts at `vector.ts:137`. The score expression `((1 + (emb <#> vec)) / 2)` is `vector.ts:274`. Line 242 is the end of the `VectorSearchArgs` comment. `deeplakeCosineScore` is `vector.ts:308-310` and delegates to `cosineSimilarity` (`:310`). `readEmbeddingCell` is `vector.ts:115`. Revise `:242` to `:274`. Leave `:137`.

### D5 strategic write bullet still says memories are dropped - CONFIRM

Findings `:134` is present tense: appends time out and memories are dropped. Section 5 of the same file (`:106`) already marks the drop resolved by PRD-079, and `:136` says the outbox keeps the capture. Current capture enqueues on a non-ok append (`capture-handler.ts:385-391` and `:495-509`). The storage client returns a `timeout` result (`client.ts:461-464` and `:554-558`). Revise the bullet to past tense for the pre-outbox session and point at the outbox. Leave the latency sentence as REPORTED backend behavior.

### D6 dashboard contention listed as not yet addressed - CONFIRM

The shared read client is one `Semaphore(5)` for recall, dashboard, heal, and prime (`assemble.ts:3092-3094`). `MAX_CONCURRENT_QUERIES = 5` (`client.ts:175`). A separate in-process fast-recall lane exists (`recall.ts:137-160`, default 8 at `amplification-config.ts:72`). That lane wraps `deps.storage.query` (`recall.ts:1342`, fast pool selected at `:2992`), so both lanes still take permits from the read `StorageClient`. Writes use a second client (`assemble.ts:3102-3108`, write cap default 3 at `amplification-config.ts:61`). Revise: the fast-recall pool is already separate, and dashboard polls still share the read client semaphore. Do not delete the contention note.

### D7 battle-test says every transient is retried and outboxed, and every genuine error is thrown - CONFIRM

The status split holds. Transient HTTP statuses are `429, 500, 502, 503, 504` (`client.ts:179`). `connection_error` and `timeout` are transient; a `query_error` is transient only when `status` is in that set (`client.ts:371-374`). A 400 is not transient. What does not hold as written at battle `:61-65` and `:156-160`:

- `isTransientResult` classifies. It does not retry and does not enqueue (`client.ts:371`).
- An INSERT / unsafe-write is not retried (`client.ts:496-497`). `query()` returns a `QueryResult` for a query error (`client.ts:461-464`).
- Capture enqueues on any non-ok append, including a genuine 400 (`capture-handler.ts:385-391`).
- Controlled writes match the narrower story: transient goes to the memory outbox (`controlled-writes.ts:715-717` then `:513-517`), and a genuine error throws (`:518-521`).

Revise the discriminator paragraph: state the status split, then say unsafe writes are single-attempt, capture outboxes every non-ok append, and only the controlled-write path throws on a genuine error. Leave the July status histograms.

### D8 local index entry shape omits memoryType - CONFIRM

`LocalVectorEntry` has `vec`, `content`, `createdAt`, `projectId`, `isDeleted`, and `memoryType` (`local-vector-index.ts:57-69`). Findings `:57` omits `memoryType`. Add that one clause. The 078b/c open issue is outside this confirm.

### D9 private storage notes never mention the Postgres transport - CONFIRM

HTTP remains the non-postgres path (`transport.ts:74-93`). `createDefaultTransport` selects `PgDeepLakeTransport` when the endpoint is `postgres://` or `postgresql://` (`index.ts:207-211`). `pg-transport.ts:1-15` says `pg_deeplake` speaks `USING deeplake`, `<#>`, and `deeplake_index` BM25 and that the transport does not rewrite SQL. The hosted-HTTP sentence in the July findings is accurate for those probes. The hole is that this directory does not name the branch. A sibling already states it (`library/knowledge/public/guides/self-hosting.md:45-58`). Add a one-line cross-link from the findings appendix to `pg-transport.ts` and that guide. Do not rewrite the vendor letter into an architecture page.

### D10 appendix transport line says no keep-alive as if the source disables it - CONFIRM

The call is a bare `fetch` with no custom dispatcher and no `keepalive: false` (`transport.ts:83-93`). The source does not configure an agent, and it also does not turn keep-alive off. Revise to "bare `fetch`, no custom agent". Do not claim a measured connection-reuse result.

## PRD-002 stay completed - CONFIRM

Recommended bucket is completed. Current folder is completed. No move. The storage-layer criteria wave 1 marked MET are present:

- Client connect, per-query org, fail-closed config, timeout result, trace gate, and distinct result kinds: `client.ts:455-457`, `:581`, `config.ts:46-54` and `:80-86`, `client.ts:548-558`, `config.ts:114-115` with `client.ts:94-96`, `result.ts:25-59`. Non-daemon callers use `DAEMON_PORT` (`src/shared/constants.ts:14`, `src/daemon-client/index.ts:14-36`).
- `sqlStr`, `sqlIdent`, `sqlLike`, and `eLiteral`: `sql.ts:42-49`, `:100-104`, `:77-85`, `:122-123`.
- Heal creates a missing table, adds only missing columns, refuses permission errors, retries once, and routes identifiers through `sqlIdent`: `heal.ts:286-312`, `:124-138`, `:77-81`. Load-time `NOT NULL` without `DEFAULT` is rejected (`schema.ts:80-95`). `CREATE TABLE ... USING deeplake` is `schema.ts:110-114`.
- Version-bumped insert plus `ORDER BY version DESC LIMIT 1`, SELECT-before-INSERT re-verify, and append-only sessions ordered by `creation_date`: `writes.ts:216-249`, `:345-375`, `:107-114`, `:383-398`. Supersede of a claim appends a new version and appends a superseded mark. It does not mutate the old row (`ontology/supersede.ts:185-191`).
- Vector search emits `<#>` against the nullable tensor column, over-fetches, returns scored ids, applies scope in the same statement, rejects a non-768 vector, clamps `HONEYCOMB_SEMANTIC_LIMIT`, and degrades to lexical SQL: `vector.ts:35`, `:75-76`, `:189-201`, `:254-281`, `:321-344`. The GPU claim is the adapter emitting that operator. This standing did not run a live GPU query.

No still-required PRD-002 criterion checked here is absent. Leave the folder in completed.

## PRD-003 move to in-work - OVERTURN

Wave 1 recommended in-work because 003c AC-2 and 003c AC-6 are unmet. Both behaviors were replaced by later requirements that the code implements. They are not still-required absences. The folder stays completed.

### 003c AC-2 - superseded, stay completed

Quote at `prd-003c-core-data-model-sessions-summaries.md:48`: a wiki summary or VFS file writes a `memory` row UPDATE-or-INSERT keyed by `path`.

The catalog label is still `pattern: "update-or-insert"` (`sessions-summaries.ts:148`) and `updateOrInsertByKey` still exists (`writes.ts:292-321`). The summary worker and synthesis do not use it. They SELECT-before-INSERT and state there is no in-place UPDATE (`summaries/worker.ts:35-36`, `summaries/synthesis.ts:35-36`). That write rule is PRD-017a AC-6, in completed `prd-017-wiki-summaries`: an existing summary row is written SELECT-before-INSERT keyed on `path` rather than an in-place UPDATE (`prd-017a-wiki-summaries-summary-worker.md:53`). Putting 003 back in-work to restore in-place UPDATE would contradict that completed criterion.

The three-role split, the `memory` columns (`summary`, `summary_embedding`), and heal-on-first-write remain (`sessions-summaries.ts:102-107` and `:216-219`, `heal.ts:286`).

### 003c AC-6 - superseded, stay completed

Quote at `prd-003c-core-data-model-sessions-summaries.md:52`: when `sessions` raw events are pruned, derived `memory` summaries are retained.

`prune.ts:5-10` tombstones the matching `sessions` rows and the paired `/summaries/<user>/<sessionId>.md` `memory` rows in one pass so they do not desync. That is the load-bearing rule of PRD-020a AC-2 (`prd-020a-surfaces-cli.md:51`, FR-9 at `:43`). The original retain-summaries rule is not the behavior this tree requires. `schema.md:325` still states the old rule; correct that sentence with D-03's retention-table revise. Do not move PRD-003 to chase it.

### Other 003 storage criteria checked - still present

These were marked MET. Re-check did not find a still-required absence:

- `memories` fact columns and nullable `content_embedding`: `memories.ts:50-78`.
- `entity_attributes` lineage columns: `knowledge-graph.ts:135-148`. Active-claim read is highest `version` with `status = 'active'` (`knowledge-graph.ts:345-362`).
- `sessions` JSONB `message`, nullable `message_embedding`, append ordered by `creation_date`: `sessions-summaries.ts:36-41`, `writes.ts:383-398`.
- `codebase` tenant identity plus `snapshot_jsonb` and `snapshot_sha256`: `product.ts:216-231`.
- `agents.read_policy` and `policy_group`: `tenancy.ts:83-84`.
- `api_keys` hashed credential columns: `tenancy.ts:127-136`.
- `router_history` columns `model`, `provider`, `workload`, `outcome` with no prompt column: `tenancy.ts:205-210`.
- Embedding column helper is nullable `FLOAT4[]` with `EMBEDDING_DIMS = 768`: `vector.ts:35` and `:52-53`.
- Heal-and-retry-once is the shared first-write path: `heal.ts:286-312`.

No sibling-repo absence was used. `hive_graph_versions` is outside this catalog (D-10) and is not a 003 acceptance criterion.

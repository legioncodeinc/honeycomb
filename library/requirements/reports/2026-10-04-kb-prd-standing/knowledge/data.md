# Knowledge standing: data/

Shard: `library/knowledge/private/data/` only. Wave 1a plan also names `storage/`; that directory is out of scope for this file. Read-only. Working-tree `schema.md` was not reverted. Grounding skips `node_modules` and build outputs. ASCII hyphens only.

Verdicts: FALSE, STALE, HOLE, HOLDS. Actions: REVISE, ADD, LEAVE, REMOVE.

Defect count: 26 (FALSE, STALE, and HOLE). HOLDS checks are listed after the defects and are not part of that count.

## Coverage

| File | Lines | Page action |
|---|---|---|
| `library/knowledge/private/data/schema.md` | 333 | REVISE |
| `library/knowledge/private/data/deeplake-storage.md` | 126 | REVISE |
| `library/knowledge/private/data/memory-compaction.md` | 117 | LEAVE |
| `library/knowledge/private/data/workspace-layout.md` | 165 | REVISE |
| `library/knowledge/private/data/codebase-graph.md` | 195 | REVISE |
| `library/knowledge/private/data/memory-virtual-filesystem.md` | 185 | REVISE |

No page should be removed. No new data page is required. ADD actions below are missing sections inside `schema.md`.

## Defects

### D-01 sessions CREATE TABLE omits live columns

- Quote: `CREATE TABLE IF NOT EXISTS "sessions"` through `last_update_date` and `USING deeplake`, with `prose` placed immediately after `message`.
- Doc: `library/knowledge/private/data/schema.md:38-55`
- Grounding: `src/daemon/storage/catalog/sessions-summaries.ts:36-91`
- Verdict: STALE
- Action: REVISE

The catalog `SESSIONS_COLUMNS` array also defines `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens` as nullable `BIGINT` with no default (`sessions-summaries.ts:66-69`), `model` as `TEXT NOT NULL DEFAULT ''` (`:77`), and `source_tool` as `TEXT NOT NULL DEFAULT ''` (`:82`). `prose` sits after `source_tool` and before `creation_date` (`:88-90`). Capture writes those columns from `buildRow` (`src/daemon/runtime/capture/capture-handler.ts:690-718`).

### D-02 sessions token sentence miscounts and omits model

- Quote: "The `sessions` capture table additionally gained five additive token/cache columns (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) plus a `source_tool` discriminant"
- Doc: `library/knowledge/private/data/schema.md:319`
- Grounding: `src/daemon/storage/catalog/sessions-summaries.ts:53-82`
- Verdict: FALSE
- Action: REVISE

The parenthetical names four token columns. The catalog adds those four plus `model` and `source_tool`. The four token columns are nullable `BIGINT` so a missing value stays SQL NULL ("token data absent", `sessions-summaries.ts:57-65`). The same sentence's degrade clause matches that NULL rule. The count and the missing `model` column do not.

### D-03 memory_jobs described as the restart-surviving distillation queue

- Quote: "`memory_jobs` is the durable distillation queue (lease, complete, fail, dead, with bounded retries) that lets work survive a daemon restart"
- Doc: `library/knowledge/private/data/schema.md:119`
- Grounding: `src/daemon/runtime/services/hybrid-job-queue.ts:46-59`; `src/daemon/runtime/services/local-queue-diagnostics.ts:111-122`; `src/daemon/runtime/assemble.ts:2116-2129`; `src/daemon/storage/catalog/runtime-jobs.ts:63-71`
- Verdict: STALE
- Action: REVISE

`memory_jobs` still exists as the shared DeepLake table. Its statuses are `queued`, `leased`, `done`, `failed`, and `dead` (`runtime-jobs.ts:64-68`). When `HONEYCOMB_LOCAL_QUEUE_ENABLED` is unset, `resolveHybridJobQueueConfig` enables the local queue from `resolveLocalQueueTopology().eligibleForDefaultOn`. An undeclared topology is eligible: "undeclared topology defaults to the local queue" (`local-queue-diagnostics.ts:121`). Distillation kinds (`memory_extraction`, `summary`, `skillify`, and the rest of `DEFAULT_LOCAL_JOB_KINDS` at `hybrid-job-queue.ts:15-26`) enqueue on that SQLite queue. The restart-surviving file is `<fleetRoot>/honeycomb/.daemon/local-queue.db` via `resolveLocalQueueBaseDir` (`assemble.ts:2128-2129`). The retention row at `schema.md:327` still treats `memory_jobs` as the live queue. Point this paragraph at ADR-0009 and the local-queue section of `workspace-layout.md`, and keep `memory_jobs` as the shared fallback.

### D-04 entity_attributes DDL default and columns

- Quote: `confidence         FLOAT4 NOT NULL DEFAULT 0.0,`
- Doc: `library/knowledge/private/data/schema.md:133`
- Grounding: `src/daemon/storage/catalog/knowledge-graph.ts:135-156`
- Verdict: FALSE
- Action: REVISE

`ENTITY_ATTRIBUTES_COLUMNS` sets `confidence` to `FLOAT4 NOT NULL DEFAULT 1.0` (`knowledge-graph.ts:142`). The same array also has `visibility` (`:149`), the provenance quartet `source_id`, `source_kind`, `source_path`, `source_root` (`:76-79` and `:152`), and `content_embedding` (`:153`). The printed CREATE TABLE at `schema.md:126-143` has none of those.

### D-05 codebase DDL type and columns

- Quote: `snapshot_jsonb    TEXT NOT NULL DEFAULT '',`
- Doc: `library/knowledge/private/data/schema.md:195`
- Grounding: `src/daemon/storage/catalog/product.ts:216-241`
- Verdict: FALSE
- Action: REVISE

`CODEBASE_COLUMNS` types `snapshot_jsonb` as `JSONB` (`product.ts:231`). The catalog also has `parent_sha`, `pushed_by` (`:227-228`), `generator_name` `TEXT NOT NULL DEFAULT 'honeycomb-graph'` (`:236`), and `created_at` (`:240`). The CREATE TABLE at `schema.md:186-201` omits them.

### D-06 agents CREATE TABLE omits tenancy columns

- Quote: `CREATE TABLE IF NOT EXISTS "agents"` with columns `id`, `name`, `read_policy`, `policy_group`, `created_at`, `updated_at` only.
- Doc: `library/knowledge/private/data/schema.md:208-216`
- Grounding: `src/daemon/storage/catalog/tenancy.ts:80-89`
- Verdict: STALE
- Action: REVISE

`AGENTS_COLUMNS` includes `org_id` and `workspace_id` (`tenancy.ts:85-86`). `read_policy` default `'isolated'` matches (`tenancy.ts:83` and `schema.md:211`).

### D-07 intro assigns org_id and workspace_id to synced_assets

- Quote: "a few cross-cutting tenant-scoped tables (notably `codebase`, `projects`, and `synced_assets`) carry explicit `org_id` and `workspace_id`"
- Doc: `library/knowledge/private/data/schema.md:20`
- Grounding: `src/daemon/storage/catalog/synced-assets.ts:105-107`; `src/daemon/storage/catalog/product.ts:217-219`; `src/daemon/storage/catalog/projects.ts:162-164`
- Verdict: FALSE
- Action: REVISE

`codebase` and `projects` use `org_id` and `workspace_id`. `synced_assets` uses `org` and `workspace` (`synced-assets.ts:106-107`). The later DDL at `schema.md:254-255` already uses `org` and `workspace`. The parenthetical at `schema.md:220` ("like `agents` and `synced_assets`") matches `agents` and mismatches `synced_assets`.

### D-08 memories CREATE TABLE omits lifecycle columns

- Quote: `CREATE TABLE IF NOT EXISTS "memories"` ending at `created_at` and `updated_at`.
- Doc: `library/knowledge/private/data/schema.md:91-115`
- Grounding: `src/daemon/storage/catalog/memories.ts:49-134`
- Verdict: STALE
- Action: REVISE

Columns printed through `updated_at` match `MEMORIES_COLUMNS` (`memories.ts:49-80`). The catalog continues with `last_reinforced_at`, `access_count`, `ref_status`, `verified_at`, `stale_refs`, `access_compacted_at`, and `access_compacted_id` (`memories.ts:86-133`).

### D-09 canonical catalog never names several live tables

- Quote: "The canonical table catalog for Honeycomb on DeepLake"
- Doc: `library/knowledge/private/data/schema.md:5`
- Grounding: `src/daemon/storage/catalog/index.ts:46-61`
- Verdict: HOLE
- Action: ADD

`CATALOG` spreads tables that `schema.md` never names: `memory_conflicts`, `memory_access`, `memory_calibration`, `memory_injections`, `pollinating_state`, and `routing_history`. `router_history`, `telemetry_counters`, and `recall_qa_ledger` are also in `TENANCY_TABLES` (`tenancy.ts:352-370`). The live router writer appends to `routing_history` (`src/daemon/runtime/inference/history-store.ts:4` and `src/daemon/storage/catalog/routing-history.ts:57-85`). The telemetry blurb at `schema.md:264-266` names none of those tables. `api_keys` is described in prose (`schema.md:204`) and its columns live at `tenancy.ts:127-143`.

### D-10 hive_graph_versions is a recall arm with no catalog table

- Quote: "Semantic arms are `memories`, `sessions`, and `hive_graph_versions`."
- Doc: `library/knowledge/private/data/schema.md:62`
- Grounding: `src/daemon/runtime/memories/recall.ts:1376-1410`; catalog search for `hive_graph` under `src/daemon/storage`: ABSENT
- Verdict: HOLE
- Action: ADD

The three-arm sentence matches `SEMANTIC_ARMS`. `hive_graph_versions` is queried by `recall.ts` (`nectar`, `embedding`, `description`, `described_at`, `describe_status` at `recall.ts:1398-1409`). No column array in `src/daemon/storage/catalog` defines that table. Add a pointer that the arm is outside this catalog. Do not invent a CREATE TABLE until a catalog module owns it.

### D-11 DeepLake page says every durable byte is in DeepLake

- Quote: "Honeycomb stores every durable byte in DeepLake"
- Doc: `library/knowledge/private/data/deeplake-storage.md:19`
- Grounding: `src/daemon/runtime/assemble.ts:2116-2129`; `src/daemon/runtime/capture/capture-outbox.ts:84-94`; `src/daemon/runtime/codebase/snapshot.ts:197-202`
- Verdict: FALSE
- Action: REVISE

The default job queue is SQLite at the fleet state root. `capture_outbox` is a second table in that same `local-queue.db` (`capture-outbox.ts:84-85`), including a terminal `dead` status (`:94`). Codebase snapshots are written under `~/.apiary/honeycomb/graphs/<repo>/` (`snapshot.ts:197-202`) before any DeepLake push. DeepLake remains the catalog store for the tables in `src/daemon/storage/catalog`.

### D-12 workspace resolution order is absent from source

- Quote: "1. the `--path` CLI flag, 2. the `HONEYCOMB_PATH` environment variable, 3. the stored CLI setting in `~/.config/honeycomb/workspace.json`, 4. the default `~/.honeycomb/`." and "`honeycomb workspace set <path>`"
- Doc: `library/knowledge/private/data/workspace-layout.md:98-105`
- Grounding: search of `src/` for `HONEYCOMB_PATH` and `workspace.json`: ABSENT
- Verdict: FALSE
- Action: REVISE

The daemon candidate is trimmed `HONEYCOMB_WORKSPACE`, otherwise `process.cwd()` (`src/daemon/runtime/assemble.ts:2071-2073`).

### D-13 writable workspace fallback is still documented as ~/.honeycomb

- Quote: "`resolveDaemonWorkspace()` returns the first writable of an explicit `HONEYCOMB_WORKSPACE`, the CLI cwd, then `~/.honeycomb`." and "`resolveWorkspaceBaseDir()` ... falls back to `~/.honeycomb`"
- Doc: `library/knowledge/private/data/workspace-layout.md:115-116`
- Grounding: `src/cli/runtime.ts:181-201`; `src/daemon/runtime/assemble.ts:2077-2087`
- Verdict: STALE
- Action: REVISE

`resolveDaemonWorkspace` probes `HONEYCOMB_WORKSPACE` when set, otherwise the CLI cwd, then `honeycombStateDir()` (`runtime.ts:197-201`, `runtimeDir` at `:182-183`). `resolveWorkspaceBaseDir` falls back to `honeycombStateDir()` (`assemble.ts:2084`), which is `<fleetRoot>/honeycomb` (`src/shared/fleet-root.ts:103-104`). The same page's fleet-root section (`workspace-layout.md:121-124`) already states that root.

### D-14 identity presets are not in source

- Quote: the preset table with rows `minimal` (default), `hermes`, `openclaw`, and `custom`, and special files `HEARTBEAT.md` and `BOOTSTRAP.md`
- Doc: `library/knowledge/private/data/workspace-layout.md:83-88`
- Grounding: search of `src/` for those preset names and for `HEARTBEAT.md` / `BOOTSTRAP.md`: ABSENT; `src/daemon/runtime/services/harness-sync.ts:69-76`
- Verdict: FALSE
- Action: REVISE

The watcher canonical set is `agent.yaml`, `AGENTS.md`, `SOUL.md`, `MEMORY.md`, `IDENTITY.md`, and `USER.md` (`harness-sync.ts:69-76`). Pollinating code still says an identity preset is injected (`src/daemon/runtime/pollinating/incremental.ts:74-100`) and loads `POLLINATING.md` only for that pass (`incremental.ts:87`). It does not define the four-row preset table.

### D-15 closing paragraph puts jobs and telemetry only in DeepLake

- Quote: "Application state, memories, embeddings, the graph, jobs, sessions, telemetry, lives in DeepLake tables the daemon owns."
- Doc: `library/knowledge/private/data/workspace-layout.md:163`
- Grounding: `src/daemon/runtime/assemble.ts:2116-2129`; `src/daemon/runtime/services/local-queue-diagnostics.ts:111-122`
- Verdict: STALE
- Action: REVISE

Sessions and memories are DeepLake catalog tables. The default job queue is the fleet-anchored SQLite file this same page describes at `workspace-layout.md:141-149`. Telemetry SQLite is also named at `workspace-layout.md:130`. The closing paragraph should follow those two sections.

### D-16 codebase graph paths still say src/graph and ~/.honeycomb

- Quote: "The graph subsystem (`src/graph/`)" and "write it to disk under `~/.honeycomb/graphs/<repo-key>/`" and "a user-editable ignore set (`~/.honeycomb/graph-ignore.json`)"
- Doc: `library/knowledge/private/data/codebase-graph.md:20`; `:30`; `:53`
- Grounding: `src/graph/`: ABSENT; `src/daemon/runtime/codebase/snapshot.ts:197-202`; `src/daemon/runtime/codebase/discovery.ts:199-208`
- Verdict: STALE
- Action: REVISE

Implementation lives under `src/daemon/runtime/codebase/`. The cache dir is `join(honeycombStateDir({ home }), "graphs", repoKey)`. The ignore file is `graph-ignore.json` under that state dir, with a legacy `~/.honeycomb/graph-ignore.json` fallback (`discovery.ts:207-208`).

### D-17 pasted extractFile is not the current function

- Quote: `export function extractFile(sourceCode: string, relativePath: string): FileExtraction` and the extension `if` chain ending in `return extractTypeScript(...)`
- Doc: `library/knowledge/private/data/codebase-graph.md:64-75`
- Grounding: `src/daemon/runtime/codebase/extract.ts:107-114`; `:264-269`
- Verdict: FALSE
- Action: REVISE

The live function is `async function extractFile(sourceFile, content, sha?): Promise<FileExtraction | null>`. Language comes from `languageForFile` and `EXTENSION_LANGUAGE` (`extract.ts:64-86`), which still covers TypeScript, JavaScript, Python, Go, Rust, Java, Ruby, C, and C++. `.d.ts` returns null (`extract.ts:109`).

### D-18 node id and kind model

- Quote: "Its `id` is globally unique within a snapshot, formatted `<source_file>:<symbol_name>:<kind>`, and a module node uses `<source_file>::module`." and `kind` values `function`, `class`, `method`, `interface`, `type_alias`, `enum`, `const`, `variable`, or `module`
- Doc: `library/knowledge/private/data/codebase-graph.md:84-90`
- Grounding: `src/daemon/runtime/codebase/contracts.ts:84-106`; `:141-169`
- Verdict: FALSE
- Action: REVISE

`kind` is `file` or `symbol` (`contracts.ts:84`). A file node id is the source file. A symbol id is `<source_file>#<name>` with an optional `:<ord>` (`contracts.ts:141-144`). `symbolKind` is `function`, `method`, `class`, `interface`, `struct`, `enum`, `type`, `variable`, `constant`, or `module` (`contracts.ts:95-106`).

### D-19 pull ordering column is created_at

- Quote: "It relaxes the identity key to drop `worktree_id` and takes `ORDER BY ts DESC LIMIT 1`"
- Doc: `library/knowledge/private/data/codebase-graph.md:167`
- Grounding: `src/daemon/runtime/codebase/push-pull.ts:441-444`
- Verdict: FALSE
- Action: REVISE

Pull drops `worktree_id` and orders by `created_at DESC` (`push-pull.ts:444`). `CODEBASE_COLUMNS` has `created_at`, and no `ts` column (`product.ts:240`).

### D-20 graph diff, history, init, and pull CLI verbs

- Quote: "`honeycomb graph diff <sha1> <sha2>` ... `honeycomb graph history` tails the per-repo `history.jsonl` ... `honeycomb graph init` installs a managed post-commit hook ... `honeycomb graph pull`"
- Doc: `library/knowledge/private/data/codebase-graph.md:195`
- Grounding: `src/daemon/runtime/codebase/api.ts:320-341`; search of `src/daemon/runtime/codebase` for `history.jsonl` and `post-commit`: ABSENT
- Verdict: FALSE
- Action: REVISE

The daemon graph mount is `POST /api/graph/build` and `GET /api/graph` (`api.ts:321` and `:341`). `pullSnapshot` exists as a function (`push-pull.ts:461`) and is not mounted as a route in `api.ts`. `history.jsonl` and a post-commit installer are absent from `src/daemon/runtime/codebase`. `honeycomb graph build` still routes: the generic storage handler POSTs `graph` + `build` to `/api/graph/build` (`src/commands/storage-handlers.ts:220-229` and `src/commands/contracts.ts:158`). Keep the build verb. Drop or re-source diff, history, init, and pull.

### D-21 VFS module path and DeepLakeFs maps

- Quote: "this document focuses on the `DeepLakeFs` implementation in `src/shell/deeplake-fs.ts`" and the four maps `files`, `meta`, `dirs`, and `pending`
- Doc: `library/knowledge/private/data/memory-virtual-filesystem.md:22`; `:30-35`
- Grounding: `src/shell/deeplake-fs.ts`: ABSENT; `src/daemon-client/vfs/fs.ts:56-74`
- Verdict: STALE
- Action: REVISE

`DeepLakeFs` is `src/daemon-client/vfs/fs.ts`. The class holds `dispatch`, `scope`, `cache`, `pending`, `snapshots`, and a `WriteBuffer` (`fs.ts:56-73`).

### D-22 pasted classifyPath is not the current classifier

- Quote: `export function classifyPath(p: string): PathKind` returning only `goal`, `kpi`, or `memory`, imported from `src/shell/goal-paths.ts`
- Doc: `library/knowledge/private/data/memory-virtual-filesystem.md:63-88`
- Grounding: `src/shell/goal-paths.ts`: ABSENT; `src/daemon-client/vfs/classify.ts:94-111`
- Verdict: FALSE
- Action: REVISE

`classifyPath` lives in `src/daemon-client/vfs/classify.ts`. It also returns `index`, `session`, and `graph` (`classify.ts:99-104`) before the goal and kpi shape checks. Goal shape `goal/<owner>/<status>/<goal_id>.md` and kpi shape `kpi/<goal_id>/<kpi_id>.md` still match (`classify.ts:28-31` and `:63-81`).

### D-23 memory mount display path

- Quote: "presents memory as files under `~/.honeycomb/memory/`"
- Doc: `library/knowledge/private/data/memory-virtual-filesystem.md:20`
- Grounding: `src/daemon-client/vfs/index-gen.ts:27-32`
- Verdict: STALE
- Action: REVISE

Generated index text uses `MEMORY_MOUNT_DISPLAY_PATH` = `~/.apiary/honeycomb/memory/` (`index-gen.ts:32`). The comment above it says the pre-tool-use classifier still recognizes the legacy `~/.honeycomb/memory/` shape (`index-gen.ts:28-30`).

### D-24 goals body is the catalog value column

- Quote: "the row's `content` column stores only the markdown body"
- Doc: `library/knowledge/private/data/memory-virtual-filesystem.md:91`
- Grounding: `src/daemon/storage/catalog/product.ts:162-172`; `src/daemon-client/vfs/write-buffer.ts:501-523`
- Verdict: FALSE
- Action: REVISE

`GOALS_COLUMNS` and `KPIS_COLUMNS` are `key`, `value`, `target`, `status`, `unit`, `agent_id`, `visibility`, `created_at`, `updated_at` (`product.ts:162-172`). `buildGoalInsertSql` inserts `key`, `value`, `status`, and `agent_id` (`write-buffer.ts:501-510`). The markdown body is `value`. The goal id is `key`. Owner is written into `agent_id`. There is no `content` column and no `goal_id` column.

### D-25 sessions bootstrap no longer uses size_bytes

- Quote: "The sessions bootstrap groups by `path` and takes `MAX(size_bytes)`" and "The memory bootstrap reads `path, size_bytes, mime_type`"
- Doc: `library/knowledge/private/data/memory-virtual-filesystem.md:46-57`
- Grounding: `src/daemon-client/vfs/index-gen.ts:44-65`; `src/daemon/storage/catalog/sessions-summaries.ts:36-91` and `:102-134`
- Verdict: STALE
- Action: REVISE

`buildRecentSessionsSql` groups by `path` and takes `MAX(creation_date)` (`index-gen.ts:58-65`). `buildRecentMemoriesSql` selects `path` and `summary` (`index-gen.ts:44-49`). Neither `SESSIONS_COLUMNS` nor `MEMORY_COLUMNS` defines `size_bytes`.

### D-26 pasted readGraphFile is absent

- Quote: `function readGraphFile(p: string, cwd: string)` calling `handleGraphVfs` and branching on `r.kind === "ok"` and `r.kind === "no-graph"`, attributed to `src/graph/vfs-handler.ts`
- Doc: `library/knowledge/private/data/memory-virtual-filesystem.md:167-177`
- Grounding: `src/graph/vfs-handler.ts`: ABSENT; `src/daemon-client/vfs/read.ts:113-124`; `src/daemon/runtime/codebase/query.ts:148-182`
- Verdict: FALSE
- Action: REVISE

`resolveGraph` loads a local snapshot and, when the snapshot is null, returns a `no-graph:` string body (`read.ts:113-119`). `handleGraphVfs` returns a string (`query.ts:148`). The endpoint list in `codebase-graph.md:175-185` matches the switch in `query.ts:153-181` (`index.md`, `find`, `query`, `show`, `impact`, `neighborhood`, `layers`, `tour`, `path`).

## Checked claims that hold

### H-01 inbox capture default is off

- Quote: "`HONEYCOMB_INBOX_CAPTURE` defaults off (`library/knowledge/private/ai/session-capture.md` matches the code; this sentence used to say capture is never dropped). A user-created project may not collide with the reserved id or name."
- Doc: `library/knowledge/private/data/schema.md:236`
- Grounding: `src/daemon/runtime/capture/capture-config.ts:79-80` and `:103-112`; `src/shared/bool-flag.ts:28-36`; `src/daemon/runtime/assemble.ts:1381-1387`; `src/daemon/runtime/capture/capture-handler.ts:777-778`
- Verdict: HOLDS
- Action: LEAVE

`BoolFlag` is off when unset. Only `true` or `1` enable it (`bool-flag.ts:32-36`). Production wires `boundProjectGate: true` and `inboxCapture: resolveInboxCaptureEnabled()` (`assemble.ts:1385-1387`). With the gate on and inbox off, an unbound scope returns `no_bound_project` (`capture-handler.ts:777-778`). `session-capture.md` is outside this shard and was not opened. The code default matches the sentence. `projects` DDL at `schema.md:223-234` matches `PROJECTS_COLUMNS` (`src/daemon/storage/catalog/projects.ts:152-168`), including `is_reserved` default `0`. `~/.deeplake/projects.json` is the cache the gate reads (`assemble.ts:1384`).

### H-02 sessions prose column and lexical arm

- Quote: "Its `prose` is the clean-text projection of that event (PRD-074)" and "the lexical (`ILIKE`) `sessions` arm now matches and returns `prose`"
- Doc: `library/knowledge/private/data/schema.md:36` and `:60`
- Grounding: `src/daemon/storage/catalog/sessions-summaries.ts:83-88`; `src/daemon/runtime/capture/capture-handler.ts:699-707`; `src/daemon/runtime/memories/recall.ts:623-670`
- Verdict: HOLDS
- Action: LEAVE

`prose` is `TEXT NOT NULL DEFAULT ''`. `buildRow` calls `proseForEvent`. Recall matches and returns `COALESCE(NULLIF("prose", ''), "message"::text)` (`recall.ts:628` and `:666-670`). The CREATE TABLE block still needs D-01.

### H-03 memory.summary_embedding exists and recall leaves memory lexical

- Quote: "The column `summary_embedding` exists on the catalog, and recall does not use it as a semantic arm. `embeddingColumnFor` leaves `memory` lexical"
- Doc: `library/knowledge/private/data/schema.md:62`
- Grounding: `src/daemon/storage/catalog/sessions-summaries.ts:102-107`; `src/daemon/runtime/memories/recall.ts:1700-1704`
- Verdict: HOLDS
- Action: LEAVE

`embeddingColumnFor` returns `content_embedding`, `message_embedding`, or `embedding` for `hive_graph_versions`, and `null` for `memory`.

### H-04 printed DDL that matches the catalog

- Quote: the `memory`, `skills`, `projects`, `synced_assets`, `roi_metrics`, and `teams` CREATE TABLE blocks, and "This checkout's catalog does not define tables named `documents` or `connectors`."
- Doc: `library/knowledge/private/data/schema.md:65-84`; `:154-177`; `:223-234`; `:243-260`; `:273-317`; `:147`
- Grounding: `src/daemon/storage/catalog/sessions-summaries.ts:102-134`; `src/daemon/storage/catalog/product.ts:83-108`; `src/daemon/storage/catalog/projects.ts:152-168`; `src/daemon/storage/catalog/synced-assets.ts:89-113`; `src/daemon/storage/catalog/tenancy.ts:256-319`; `src/daemon/storage/catalog/sources.ts:109-111`
- Verdict: HOLDS
- Action: LEAVE

Source table names are `memory_artifacts`, `document_memories`, and `document_chunk`. A catalog search for tables named `documents` or `connectors` is ABSENT. Column-level holes for other tables are D-01 through D-10.

### H-05 SQL helpers, readConverged, and harness poll-max

- Quote: the `sqlIdent` snippet, "`readConverged` (`src/daemon/storage/converge.ts`)", and "`selectRowsConverged()` in `harness-api.ts`" with `HONEYCOMB_HARNESS_ACTIVITY_POLLS` default 3 and `HONEYCOMB_HARNESS_ACTIVITY_BUDGET_MS` default 1500
- Doc: `library/knowledge/private/data/deeplake-storage.md:32-37`; `:65`; `:94-96`
- Grounding: `src/daemon/storage/sql.ts:100-105`; `src/daemon/storage/converge.ts:69-72`; `src/daemon/runtime/dashboard/harness-api.ts:174-180` and `:218`
- Verdict: HOLDS
- Action: LEAVE

`sqlIdent` matches the pasted function. Convergence defaults are 10 attempts and 2000 ms wall clock. Harness activity defaults are 3 polls and 1500 ms. `selectRowsConverged` is a file-local function in `harness-api.ts`.

### H-06 version-history compaction

- Quote: allow-list `skills`, `rules`, `entity_attributes`, `epistemic_assertions`, `pollinating_state`; keys `id`, `key`, `claim_key`, `id`, `id`; `keepLatestN: 5` and `windowDays: 30`; `POST /api/diagnostics/compact`; `CompactionSummary` fields
- Doc: `library/knowledge/private/data/memory-compaction.md:55-69`; `:45-49`; `:94`; `:99-105`
- Grounding: `src/daemon/storage/compaction.ts:75-77` and `:214-215` and `:417-428`; `src/daemon/runtime/maintenance/compact-api.ts:68` and `:105-111`; `src/commands/maintenance.ts:5`
- Verdict: HOLDS
- Action: LEAVE

`memory_jobs` is version-bumped in the catalog (`runtime-jobs.ts:131`) and is excluded from `COMPACTABLE_VERSION_BUMPED_TABLES`. That exclusion holds even though D-03 says `memory_jobs` is no longer the default runtime queue. `src/daemon/runtime/pollinating/compaction.ts` exists and is the other compaction the page distinguishes (`memory-compaction.md:22`).

### H-07 fleet-anchored local queue and capture outbox

- Quote: "`resolveLocalQueueBaseDir()` = `honeycombStateDir()`" and the `capture_outbox` paragraph (`dead` status, `maxRows` cap, fleet-anchored `local-queue.db`)
- Doc: `library/knowledge/private/data/workspace-layout.md:147-151`
- Grounding: `src/daemon/runtime/assemble.ts:2128-2129`; `src/daemon/runtime/services/local-job-queue.ts:313-318`; `src/daemon/runtime/capture/capture-outbox.ts:84-94`; `src/shared/fleet-root.ts:78-95`
- Verdict: HOLDS
- Action: LEAVE

`trustedLocalQueueRoots` includes `resolveFleetRoot()` (`local-job-queue.ts:318`). Fleet root precedence is absolute `APIARY_HOME`, then absolute `$XDG_STATE_HOME/apiary` on Linux, else `<home>/.apiary` (`fleet-root.ts:78-95`). D-12 through D-15 are the parts of this page to revise.

### H-08 graph build, languages, and VFS query surface

- Quote: "`honeycomb graph build`" and the nine languages, and the `graph/` endpoints `index.md`, `find`, `query`, `show`, `impact`, `neighborhood`, `layers`, `tour`, `path`
- Doc: `library/knowledge/private/data/codebase-graph.md:22`; `:30`; `:175-185`
- Grounding: `src/commands/storage-handlers.ts:220-229`; `src/daemon/runtime/codebase/api.ts:321`; `src/daemon/runtime/codebase/extract.ts:64-86`; `src/daemon/runtime/codebase/query.ts:135-181`; `src/daemon/runtime/codebase/discovery.ts:126-133`; `src/daemon/runtime/codebase/push-pull.ts:144-146`
- Verdict: HOLDS
- Action: LEAVE

`git ls-files --cached --others --exclude-standard -z` is the discovery command (`discovery.ts:126-133`). `HONEYCOMB_GRAPH_PUSH=0` skips push (`push-pull.ts:144-146`). D-16 through D-20 are the parts to revise. Snapshot hashing still excludes the volatile observation block (`src/daemon/runtime/codebase/hash.ts:80-126`); replace the pasted function at `codebase-graph.md:131-140` with a pointer to `hash.ts` rather than treating the hash idea as false.

### H-09 VFS flush thresholds and session concat still read message

- Quote: batch size 10 and a 200 ms debounce, and `SELECT message FROM "<sessions>" WHERE path = '...' ORDER BY creation_date ASC`
- Doc: `library/knowledge/private/data/memory-virtual-filesystem.md:97`; `:135`
- Grounding: `src/daemon-client/vfs/write-buffer.ts:102-104`; `src/daemon-client/vfs/read.ts:143-154`
- Verdict: HOLDS
- Action: LEAVE

`FLUSH_AT_PENDING` is 10 and `FLUSH_DEBOUNCE_MS` is 200. The VFS session read still selects `message`, ordered `creation_date DESC` with a limit, then reversed (`read.ts:143-154`). Recall's prose arm (H-02) is a different reader. D-21 through D-26 are the parts to revise.

## Files read

Knowledge:

- `library/knowledge/private/data/schema.md`
- `library/knowledge/private/data/codebase-graph.md`
- `library/knowledge/private/data/deeplake-storage.md`
- `library/knowledge/private/data/memory-compaction.md`
- `library/knowledge/private/data/workspace-layout.md`
- `library/knowledge/private/data/memory-virtual-filesystem.md`
- `/home/marioaldayuz/.cursor/plans/kb_prd_standing_fleet_9354246d.plan.md` (Wave 1a)

Catalog and queue:

- `src/daemon/storage/catalog/index.ts`
- `src/daemon/storage/catalog/sessions-summaries.ts`
- `src/daemon/storage/catalog/memories.ts`
- `src/daemon/storage/catalog/knowledge-graph.ts`
- `src/daemon/storage/catalog/product.ts`
- `src/daemon/storage/catalog/projects.ts`
- `src/daemon/storage/catalog/tenancy.ts`
- `src/daemon/storage/catalog/synced-assets.ts`
- `src/daemon/storage/catalog/sources.ts`
- `src/daemon/storage/catalog/runtime-jobs.ts`
- `src/daemon/storage/catalog/routing-history.ts`
- `src/daemon/storage/catalog/memory-conflicts.ts` (table export)
- `src/daemon/storage/catalog/memory-lifecycle.ts` (table export)
- `src/daemon/storage/catalog/memory-injections.ts` (table export)
- `src/daemon/storage/catalog/pollinating-state.ts` (table export)
- `src/daemon/storage/sql.ts`
- `src/daemon/storage/vector.ts` (embedding column type)
- `src/daemon/storage/compaction.ts`
- `src/daemon/storage/converge.ts`
- `src/daemon/runtime/services/hybrid-job-queue.ts`
- `src/daemon/runtime/services/local-queue-diagnostics.ts`
- `src/daemon/runtime/services/local-job-queue.ts` (trusted roots)
- `src/shared/bool-flag.ts`
- `src/shared/fleet-root.ts`

Behavior cited from outside the catalog:

- `src/daemon/runtime/assemble.ts`
- `src/daemon/runtime/capture/capture-config.ts`
- `src/daemon/runtime/capture/capture-handler.ts`
- `src/daemon/runtime/capture/capture-outbox.ts`
- `src/daemon/runtime/memories/recall.ts`
- `src/daemon/runtime/inference/history-store.ts`
- `src/daemon/runtime/dashboard/harness-api.ts`
- `src/daemon/runtime/maintenance/compact-api.ts`
- `src/daemon/runtime/codebase/extract.ts`
- `src/daemon/runtime/codebase/contracts.ts`
- `src/daemon/runtime/codebase/hash.ts`
- `src/daemon/runtime/codebase/discovery.ts`
- `src/daemon/runtime/codebase/snapshot.ts`
- `src/daemon/runtime/codebase/api.ts`
- `src/daemon/runtime/codebase/push-pull.ts`
- `src/daemon/runtime/codebase/query.ts`
- `src/daemon-client/vfs/fs.ts`
- `src/daemon-client/vfs/classify.ts`
- `src/daemon-client/vfs/index-gen.ts`
- `src/daemon-client/vfs/read.ts`
- `src/daemon-client/vfs/write-buffer.ts`
- `src/cli/runtime.ts`
- `src/commands/contracts.ts`
- `src/commands/storage-handlers.ts`
- `src/commands/maintenance.ts`
- `src/daemon/runtime/services/harness-sync.ts`
- `src/daemon/runtime/pollinating/incremental.ts`

# Lens: storage-catalog

Read-only inventory of `src/daemon/storage` against `library/knowledge/private/data/schema.md` and `library/knowledge/private/data/deeplake-storage.md`. No live DeepLake workspace was queried. No secrets are recorded here.

## Answer

The runtime catalog is **35 tables in 14 groups**, aggregated in `src/daemon/storage/catalog/index.ts` as `CATALOG`. Neither comparison doc claims the catalog is exactly 7 tables. The knowledge-graph group is exactly 7, and `schema.md` names those 7. `schema.md` is not a complete mirror of `CATALOG`: it names two tables that do not exist (`documents`, `connectors`) and omits several live tables. The three-tier story (key, summary, raw) matches `schema.md` as columns and roles, not as three tables. `deeplake-storage.md` does not define that zoom model. The DeepLake SQL client (`createStorageClient`, `HttpDeepLakeTransport`, `PgDeepLakeTransport`) is not imported by harness, CLI, MCP, SDK, embeddings, or `src/daemon-client` product code. Tests and `scripts/deeplake-probe.mjs` do import it.

## Catalog inventory

Status: VERIFIED. Counted from each group's `defineGroup` `name` (or exported table constant) and from the spread in `src/daemon/storage/catalog/index.ts` lines 46-61. `examples/fixture-tables.ts` is not in that spread.

| Group export | File | Tables | N |
|---|---|---|---|
| `MEMORIES_TABLES` | `catalog/memories.ts` | `memories`, `memory_history` | 2 |
| `MEMORY_CONFLICTS_TABLES` | `catalog/memory-conflicts.ts` | `memory_conflicts` | 1 |
| `MEMORY_LIFECYCLE_TABLES` | `catalog/memory-lifecycle.ts` | `memory_access`, `memory_calibration` | 2 |
| `MEMORY_INJECTIONS_TABLES` | `catalog/memory-injections.ts` | `memory_injections` | 1 |
| `SESSIONS_SUMMARIES_TABLES` | `catalog/sessions-summaries.ts` | `sessions`, `memory` | 2 |
| `KNOWLEDGE_GRAPH_TABLES` | `catalog/knowledge-graph.ts` | `entities`, `entity_aspects`, `entity_attributes`, `entity_dependencies`, `memory_entity_mentions`, `epistemic_assertions`, `ontology_proposals` | 7 |
| `PRODUCT_TABLES` | `catalog/product.ts` | `skills`, `rules`, `goals`, `kpis`, `codebase` | 5 |
| `TENANCY_TABLES` | `catalog/tenancy.ts` | `agents`, `api_keys`, `telemetry_counters`, `recall_qa_ledger`, `router_history`, `roi_metrics`, `teams` | 7 |
| `RUNTIME_JOBS_TABLES` | `catalog/runtime-jobs.ts` | `memory_jobs` | 1 |
| `POLLINATING_STATE_TABLES` | `catalog/pollinating-state.ts` | `pollinating_state` | 1 |
| `ROUTING_HISTORY_TABLES` | `catalog/routing-history.ts` | `routing_history` | 1 |
| `SOURCES_TABLES` | `catalog/sources.ts` | `memory_artifacts`, `document_memories`, `document_chunk` | 3 |
| `SYNCED_ASSETS_TABLES` | `catalog/synced-assets.ts` | `synced_assets` | 1 |
| `PROJECTS_TABLES` | `catalog/projects.ts` | `projects` | 1 |
| **Total** | 14 groups | | **35** |

Declared write patterns on those records: `append-only`, `version-bumped`, `update-or-insert`, `select-before-insert` (only `codebase`). Scope is `agent`, `tenant`, or `none` per `catalog/types.ts`.

## SQL helpers

Status: VERIFIED. `src/daemon/storage/sql.ts`.

| Helper | Lines | Behavior |
|---|---|---|
| `sqlStr` | 42-51 | Doubles backslashes, then doubles single quotes, drops NUL and C0 controls except tab, LF, and CR, plus DEL. Caller wraps quotes, or `eLiteral` does. |
| `sqlLike` | 77-86 | One pass escapes `\`, `%`, and `_`, then the same quote and control passes as `sqlStr` without a second backslash doubling. |
| `sqlIdent` | 100-105 | Throws unless `^[a-zA-Z_][a-zA-Z0-9_]*$`. Returns the name unchanged. |
| `eLiteral` | 122-124 | Returns `` E'${sqlStr(body)}' ``. |
| `sLiteral` | 132-134 | Returns `'${sqlStr(value)}'`. Not named in `deeplake-storage.md`. |
| `sqlColumnList` | 150-157 | `*` or a comma list of `sqlIdent` names. Not named in `deeplake-storage.md`. |

`deeplake-storage.md` lines 29-37 names three helpers (`sqlStr`, `sqlLike`, `sqlIdent`) and describes the `E'...'` form without naming `eLiteral`. The `sqlIdent` snippet there matches `sql.ts` lines 100-104.

## Schema healing

Status: VERIFIED. High-level flow in `deeplake-storage.md` lines 98-117 matches the code.

- `buildCreateTableSql` (`src/daemon/storage/schema.ts` lines 110-114) emits `CREATE TABLE IF NOT EXISTS "<ident>" (...) USING deeplake`. Table and column names go through `sqlIdent`.
- `validateColumnDefs` (same file, lines 80-99) rejects a bad identifier, a duplicate name, and `NOT NULL` without `DEFAULT`.
- `withHeal` (`src/daemon/storage/heal.ts` lines 286-312): run the write; heal only on `query_error`; `classifyFailure` forces permission and auth messages to `other` before missing-column, then missing-table (lines 77-97); missing-table runs `buildCreateTableSql`; both schema classes then column-heal; the original write is retried once.
- `healColumns` (lines 124-154) reads `information_schema.columns` via `buildIntrospectionSql` (values through `sqlStr`) and `ALTER TABLE ADD COLUMN` only for columns absent from that set. No `IF NOT EXISTS` on the ALTER (`schema.ts` lines 151-163).
- Extra behavior the doc mermaid does not draw: introspection retries up to 5 times on transient failures (`INTROSPECTION_ATTEMPTS`, lines 184-187); an introspection `HealFailure` is swallowed and the write retry still runs; an alter-phase failure still propagates (`healColumnsTolerant`, lines 324-330).

## DeepLake client confinement

Status: VERIFIED for product TypeScript surfaces. UNVERIFIABLE-HERE for a built bundle graph (no install, no bundle walk beyond source imports).

- The SQL client is `StorageClient` / `createStorageClient` in `src/daemon/storage/client.ts` and `src/daemon/storage/index.ts`. The wire clients are `HttpDeepLakeTransport` (`transport.ts`) and `PgDeepLakeTransport` (`pg-transport.ts`). There is no `from "deeplake"` package import under `src/`.
- Grep of `harnesses/`, `mcp/`, `src/cli/`, `sdk/`, and `embeddings/` found no `createStorageClient`, `HttpDeepLakeTransport`, or `daemon/storage/(client|transport|index|pg-transport)` import.
- `tests/daemon/storage/invariant.test.ts` lines 43-124 (a-AC-5) scans non-daemon roots and bans `daemon/storage` imports except `sql.ts`. `src/daemon-client/vfs/read.ts`, `write-buffer.ts`, `index-gen.ts`, and `src/daemon-client/skillify/pull-client.ts` import only `sql.ts`.
- Importers outside `src/daemon`: Vitest and live `tests/integration/*.itest.ts`, plus `scripts/deeplake-probe.mjs` line 12, which imports `HttpDeepLakeTransport` from `dist/src/daemon/storage/index.js`.
- A second DeepLake HTTP client, `src/daemon/runtime/auth/deeplake-issuer.ts` (`api.deeplake.ai` device flow and org calls), is imported from CLI and command modules (`src/cli/org.ts`, `src/cli/auth.ts`, `src/commands/install.ts`). That is auth, not the SQL storage client. `deeplake-storage.md` line 23 says "The daemon is the only DeepLake client" in the paragraph about writes, escaping, and healing.

## Tier story (key, summary, raw)

Status: VERIFIED against the two docs and the column arrays.

| Zoom | Where it lives in the catalog | `schema.md` | `deeplake-storage.md` |
|---|---|---|---|
| Raw | Table `sessions`, append-only. Body is `message` JSONB. `prose` is the lexical projection. | Lines 22 and 36: raw capture stream, one row per event. | Line 50: append-only INSERT for `sessions`, raw events. |
| Summary | Table `memory`, pattern `update-or-insert`, column `summary` plus `summary_embedding`. | Lines 22 and 62: wiki-summary and VFS table, UPDATE-or-INSERT by `path`. | Line 52: UPDATE-or-INSERT by key for `memory`. |
| Key | Column `key` on `memory` (`sessions-summaries.ts` lines 112-115) and on `memories` (`memories.ts` lines 53-58). Not a table. | Line 117: Tier-1 key on `memories`, and the same column on `memory`. | Does not define a key / summary / raw zoom. |

Role split in `schema.md` line 22 matches the catalog: `sessions` raw events, `memories` distilled facts, `memory` wiki and VFS. `memories` is a second key and content source, not the raw tier.

`memory` is declared `update-or-insert` (`sessions-summaries.ts` lines 146-148), which matches both docs. The `version` column comment (lines 116-120) says the `/MEMORY.md` index row is rewritten version-bumped while per-session rows stay at version 0. That is one table with one catalog pattern and a writer-level exception the storage docs do not spell out.

## Doc contradictions

### Exactly 7 tables

Status: VERIFIED. Full text of `schema.md` and `deeplake-storage.md` contains no claim that the catalog has exactly 7 tables. The knowledge-graph group is exactly 7, and `schema.md` lines 123 names those 7 (`entities`, `entity_aspects`, `entity_attributes`, `entity_dependencies`, `memory_entity_mentions`, `epistemic_assertions`, `ontology_proposals`). `library/ledger/EXECUTION_LEDGER-prd-003.md` calls PRD-003b a 7-table knowledge graph, which matches the group, not the 35-table `CATALOG`.

`catalog/index.ts` lines 23-24 and `catalog/CONVENTIONS.md` section 8 still say the barrel spreads five group arrays. The barrel spreads 14.

### Tables the docs name that the catalog does not

Status: VERIFIED. `schema.md` lines 147 names `documents` (lifecycle `queued` through `done`) and `connectors`. `SOURCES_TABLES` is only `memory_artifacts`, `document_memories`, and `document_chunk` (`sources.ts` lines 109-111 and 242-259). No catalog `name` is `documents` or `connectors`.

### Tables in the catalog that `schema.md` does not name

Status: VERIFIED by absence of these identifiers in `schema.md`: `memory_conflicts`, `memory_access`, `memory_calibration`, `memory_injections`, `pollinating_state`, `routing_history`, `document_chunk`, `telemetry_counters`, `recall_qa_ledger`, `router_history`.

`schema.md` line 266 says the router's redacted routing history lands in the telemetry section. The catalog has two different tables: `router_history` (`tenancy.ts` lines 192-215: model, provider, workload, outcome, latency) and `routing_history` (`routing-history.ts`: append-only `event` JSONB). The doc does not distinguish them.

### DDL samples that disagree with column arrays

Status: VERIFIED.

- `entity_attributes` in `schema.md` lines 126-142 uses `confidence ... DEFAULT 0.0` and omits `visibility`, `content_embedding`, and the source provenance quartet. Code (`knowledge-graph.ts` lines 135-156) uses `DEFAULT 1.0`, `visibility TEXT NOT NULL DEFAULT 'global'`, `embeddingColumn("content_embedding")`, and `GRAPH_SOURCE_PROVENANCE_QUARTET`.
- `agents` in `schema.md` lines 208-216 omits `org_id` and `workspace_id`. `AGENTS_COLUMNS` (`tenancy.ts` lines 80-89) includes both, scope `tenant`.
- `sessions` CREATE TABLE in `schema.md` lines 38-55 omits `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `model`, and `source_tool`. Those columns are in `SESSIONS_COLUMNS` (`sessions-summaries.ts` lines 66-82). Later prose at `schema.md` line 319 mentions the token columns and `source_tool` but not `model`, and the CREATE TABLE block was not updated.
- `memories` CREATE TABLE in `schema.md` lines 91-114 stops at `updated_at`. `MEMORIES_COLUMNS` continues with `last_reinforced_at`, `access_count`, `ref_status`, `verified_at`, `stale_refs`, `access_compacted_at`, and `access_compacted_id` (`memories.ts` lines 81-133).

### Tenancy sentence conflict

Status: VERIFIED. `deeplake-storage.md` line 121: "Every row carries org and workspace identity." `schema.md` line 20: most tables do not need explicit tenancy columns; isolation is the storage partition; engine tables carry `agent_id` and `visibility`; explicit `org_id` and `workspace_id` are for cross-cutting tables. Code matches `schema.md`: `memories` comment (`memories.ts` lines 45-46) states no `org_id` / `workspace_id` columns. The org is a request header (`DEEPLAKE_ORG_HEADER` in `transport.ts` line 64).

## Findings

### storage-catalog-1

- Status: VERIFIED
- Severity: high
- Title: schema.md names source tables the catalog does not have
- Claim: `schema.md` documents `documents` and `connectors`. The sources group defines `memory_artifacts`, `document_memories`, and `document_chunk` only.
- Evidence: `library/knowledge/private/data/schema.md` line 147. `src/daemon/storage/catalog/sources.ts` lines 109-111 and 242-259.
- Impact: A reader will look for a lifecycle table and a connectors table that healing will never create.
- Recommended action: Rewrite the sources section to the three catalog names, or add the missing tables to the catalog if they are still intended.
- Owner: either
- Disclosed: false
- Confidence: 0.95

### storage-catalog-2

- Status: VERIFIED
- Severity: medium
- Title: schema.md omits live catalog tables
- Claim: `CATALOG` has 35 tables. `schema.md` never names `memory_conflicts`, `memory_access`, `memory_calibration`, `memory_injections`, `pollinating_state`, `routing_history`, `document_chunk`, `telemetry_counters`, `recall_qa_ledger`, or `router_history`.
- Evidence: Spread in `catalog/index.ts` lines 46-61. Identifier search of `schema.md` returned no matches for those names.
- Impact: The file calls itself the canonical catalog (`schema.md` line 5) while the heal source of truth is the ColumnDef arrays.
- Recommended action: Add a generated or hand-maintained name list that is checked against `CATALOG`.
- Owner: either
- Disclosed: false
- Confidence: 0.93

### storage-catalog-3

- Status: VERIFIED
- Severity: medium
- Title: entity_attributes DDL sample disagrees with the column array
- Claim: The published CREATE TABLE uses confidence default 0.0 and drops `visibility`, the provenance quartet, and `content_embedding`. The catalog default is 1.0 and those columns are present.
- Evidence: `schema.md` lines 126-142. `knowledge-graph.ts` lines 135-156.
- Impact: A hand-copied DDL would heal a different confidence default and omit columns recall and purge expect.
- Recommended action: Replace the sample with the output of `buildCreateTableSql` for that table.
- Owner: either
- Disclosed: false
- Confidence: 0.96

### storage-catalog-4

- Status: VERIFIED
- Severity: medium
- Title: agents DDL sample drops tenant columns the code requires
- Claim: `schema.md` shows `agents` without `org_id` and `workspace_id`. `AGENTS_COLUMNS` includes both and the table scope is `tenant`.
- Evidence: `schema.md` lines 208-216. `tenancy.ts` lines 80-89 and 334-339.
- Impact: Conflicts with the same doc's later claim that `projects` carries org columns "like agents" (`schema.md` line 220).
- Recommended action: Add the two columns to the sample.
- Owner: either
- Disclosed: false
- Confidence: 0.96

### storage-catalog-5

- Status: VERIFIED
- Severity: medium
- Title: deeplake-storage.md says every row carries org and workspace identity
- Claim: Engine tables such as `memories` and `sessions` do not have `org_id` or `workspace_id` columns. Tenancy is the partition plus the org header. `schema.md` line 20 states that. `deeplake-storage.md` line 121 states the opposite.
- Evidence: `deeplake-storage.md` line 121. `schema.md` line 20. `memories.ts` lines 45-46. `transport.ts` line 64.
- Impact: A later change could add redundant tenancy columns, or a reviewer could treat a missing column as a bug.
- Recommended action: Align line 121 with the partition-plus-header model and name which tables do carry explicit columns.
- Owner: either
- Disclosed: false
- Confidence: 0.94

### storage-catalog-6

- Status: VERIFIED
- Severity: low
- Title: sessions and memories CREATE TABLE blocks lag the column arrays
- Claim: `sessions` code adds nullable token BIGINTs, `model`, and `source_tool` that the CREATE TABLE block omits (later prose mentions tokens and `source_tool` only). `memories` code adds reinforcement and stale-ref columns the CREATE TABLE block omits.
- Evidence: `sessions-summaries.ts` lines 66-82. `schema.md` lines 38-55 and 319. `memories.ts` lines 81-133. `schema.md` lines 91-114.
- Impact: The samples understate the healed shape. The later prose shows the author knew about some `sessions` columns and did not update the DDL.
- Recommended action: Regenerate both samples from the ColumnDef arrays.
- Owner: either
- Disclosed: false
- Confidence: 0.95

### storage-catalog-7

- Status: VERIFIED
- Severity: low
- Title: Two routing tables, one prose sentence
- Claim: `router_history` and `routing_history` are both in `CATALOG` with different columns. `schema.md` mentions routing history once and names neither table.
- Evidence: `tenancy.ts` lines 205-215 and 366-368. `routing-history.ts` lines 1-6 and 57. `schema.md` line 266.
- Impact: Operators can confuse the redacted model outcome log with the JSONB routing-decision log.
- Recommended action: Name both tables and their write patterns in `schema.md`.
- Owner: either
- Disclosed: false
- Confidence: 0.92

### storage-catalog-8

- Status: VERIFIED
- Severity: low
- Title: Barrel comment still says five groups
- Claim: `catalog/index.ts` and `catalog/CONVENTIONS.md` say five group arrays, including stubs for knowledge graph, product, and tenancy. The file imports and spreads 14 implemented groups.
- Evidence: `catalog/index.ts` lines 23-24 and 46-61. `catalog/CONVENTIONS.md` section 8.
- Impact: A contributor following the convention will not register a new group, because the doc says the barrel must not be edited and already lists only the original five.
- Recommended action: Update the comment and section 8 to the 14-group spread.
- Owner: either
- Disclosed: false
- Confidence: 0.97

### storage-catalog-9

- Status: VERIFIED
- Severity: info
- Title: No whole-catalog claim of exactly 7 tables
- Claim: The only exact-7 count that matches code is the knowledge-graph group. The full catalog is 35 tables. The two comparison docs do not say the catalog has exactly 7 tables.
- Evidence: Group count above. `schema.md` line 123. Absence of an exact-7 catalog sentence in both docs. Ledger PRD-003b wording is the knowledge-graph group.
- Impact: None if readers use `CATALOG`. Harm only if an old PRD-003b note is read as the current total.
- Recommended action: Leave the group at 7. Do not cite 7 as the catalog size.
- Owner: either
- Disclosed: true
- Confidence: 0.9

### storage-catalog-10

- Status: VERIFIED
- Severity: info
- Title: Tier story matches schema.md and is absent from deeplake-storage.md
- Claim: Key is a column on `memory` and `memories`. Summary is `memory.summary`. Raw is the `sessions` table. `deeplake-storage.md` calls `sessions` raw events and does not define the three zoom levels.
- Evidence: `memories.ts` lines 53-58. `sessions-summaries.ts` lines 102-115 and 137-148. `schema.md` lines 22, 62, and 117. `deeplake-storage.md` lines 49-53.
- Impact: None for implementers who read `schema.md`. The storage mechanics doc will not teach the zoom model.
- Recommended action: Add one sentence in `deeplake-storage.md` pointing at the role split, if that doc is meant to stand alone.
- Owner: either
- Disclosed: true
- Confidence: 0.93

### storage-catalog-11

- Status: VERIFIED
- Severity: info
- Title: SQL helper doc names three functions; the module exports six
- Claim: `sqlStr`, `sqlLike`, and `sqlIdent` match the doc, including the `sqlIdent` regex. `eLiteral` is the `E'...'` form the doc describes but does not name. `sLiteral` and `sqlColumnList` are additional exports.
- Evidence: `sql.ts` lines 42-157. `deeplake-storage.md` lines 29-37.
- Impact: Low. Builders that only know the three named helpers can still be correct if they hand-wrap quotes. `sqlColumnList` is the safe projection path the doc does not mention.
- Recommended action: Name `eLiteral`, `sLiteral`, and `sqlColumnList` next to the three helpers.
- Owner: either
- Disclosed: false
- Confidence: 0.95

### storage-catalog-12

- Status: VERIFIED
- Severity: info
- Title: Storage SQL client stays inside the daemon for product code, with known exceptions
- Claim: Harness, CLI, MCP, SDK, embeddings, and daemon-client product code do not import the SQL client. The a-AC-5 test allows only `sql.ts` outside the daemon. Tests and `scripts/deeplake-probe.mjs` import the transport. CLI imports the auth issuer, which is a different HTTP client under `src/daemon/runtime/auth/`.
- Evidence: Import grep of those trees. `invariant.test.ts` lines 43-124. `scripts/deeplake-probe.mjs` line 12. `deeplake-issuer.ts` header. `deeplake-storage.md` line 23.
- Impact: The confinement claim holds for storage SQL. The sentence "the daemon is the only DeepLake client" is too broad for the auth API, which the CLI calls directly.
- Recommended action: Say "the daemon is the only DeepLake SQL client" in `deeplake-storage.md`.
- Owner: either
- Disclosed: true
- Confidence: 0.9

## Could not verify

- UNVERIFIABLE-HERE: which of the 35 catalog tables exist in a live org or workspace. No credentialed query was run.
- UNVERIFIABLE-HERE: whether a built harness, MCP, or CLI bundle transitively contains `HttpDeepLakeTransport` after esbuild. Source imports do not. Bundles were not opened.
- UNVERIFIABLE-HERE: whether `memory` writers actually version-bump the `/MEMORY.md` row while the catalog pattern stays `update-or-insert`. The column comment says so. The writer body was not executed.

## Verified claims (short)

- 35 catalog tables, 14 groups, knowledge-graph group size 7.
- `sqlIdent`, `sqlStr`, `sqlLike`, and `eLiteral` exist and match their file comments.
- `withHeal` plus `buildCreateTableSql` implement lazy create, column diff, and one retry, with permission errors excluded.
- Product non-daemon TypeScript does not import the SQL client. `sql.ts` imports from `src/daemon-client` are the documented exception.
- Key / summary / raw in `schema.md` match `memory.key`, `memories.key`, `memory.summary`, and `sessions`.

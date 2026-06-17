# Catalog conventions (PRD-003 spine) — READ BEFORE FILLING A STUB

Wave 1 established these. Wave 2 follows them **verbatim**. The whole point of
the wiring is that a Wave-2 Bee edits **only its own group file + its own test
file** and never touches the barrel (`index.ts`), `registry.ts`, or `types.ts`.

---

## 1. The `CatalogTable` record shape (`types.ts`)

Every durable table is one record:

```ts
interface CatalogTable {
  readonly name: string;                    // bare SQL identifier
  readonly columns: readonly ColumnDef[];   // the single source of truth
  readonly pattern: WritePattern;           // PRD-002d write strategy
  readonly embeddingColumns: readonly string[]; // names of FLOAT4[] cols
  readonly scope: CatalogScope;             // D-2 tenancy
}
```

Build the group's array with `defineGroup([...])`, which runs `defineTable` on
each record. `defineTable` validates the ColumnDef array at module load
(`validateColumnDefs`) and asserts every `embeddingColumns` name actually exists
in `columns`. A malformed table fails the **import**, never a production write.

## 2. Registering a table's write pattern

The pattern lives **on the record** (`pattern:`), nowhere else. The registry is
**derived** from it (`registry.ts` → `buildRegistry`). You do **not** edit the
registry — set `pattern` and it flows through. The four patterns and their
PRD-002d primitives (`PATTERN_PRIMITIVE` in `registry.ts`):

| `pattern`              | `writes.ts` primitive   | Read convention                       | Used by |
|------------------------|-------------------------|---------------------------------------|---------|
| `append-only`          | `appendOnlyInsert`      | `readAppendOrdered` (path, creation_date) | sessions, memory_history, dependencies, proposals, mentions, telemetry |
| `version-bumped`       | `appendVersionBumped`   | `readLatestVersion` (`ORDER BY version DESC LIMIT 1`) | skills, rules, entity_attributes |
| `update-or-insert`     | `updateOrInsertByKey`   | SELECT by key                         | memory (by path), memories (by id), goals, kpis, agents |
| `select-before-insert` | `selectBeforeInsert`    | probe key, insert-if-absent, re-verify | codebase |

## 3. Scope convention (D-2 / index AC-3)

`scope` selects which tenancy columns the ColumnDef array carries:

- **`"agent"`** — engine table. Carry `agent_id` (`TEXT NOT NULL DEFAULT 'default'`)
  and `visibility` (`TEXT NOT NULL DEFAULT 'global'`). Org/workspace isolation
  comes from the **storage partition layer**, not columns. (memories, sessions,
  memory, skills, rules, goals, kpis, ontology tables)
- **`"tenant"`** — cross-cutting table. Carry explicit `org_id` and
  `workspace_id` (`TEXT NOT NULL DEFAULT ''`). (codebase, agents, api_keys, telemetry)
- **`"none"`** — audit/history table scoped transitively by the row it
  references (e.g. `memory_history.memory_id`).

## 4. Embedding-column convention (index AC-4)

Every embedding column is a **nullable 768-dim `FLOAT4[]`**, declared via
`embeddingColumn(name)` from `../vector.js` (which emits `{ name, sql: "FLOAT4[]" }`).
Nullable by design so recall degrades to lexical when embedding is off. List the
column name in the record's `embeddingColumns`. The 768 contract is enforced at
write/query time by `assertEmbeddingDim`, not by the column type.

## 5. `{ name, sql }` + DEFAULT discipline (PRD-002c)

Each column is `{ name, sql }`: `name` is the bare identifier, `sql` is the
column SQL minus the name (e.g. `TEXT NOT NULL DEFAULT ''`). **Every `NOT NULL`
column MUST have a `DEFAULT`** — the load-time guard (`validateColumnDefs`)
rejects a `NOT NULL`-without-`DEFAULT` column, because `ALTER TABLE ADD COLUMN
… NOT NULL` on a populated table fails without one. Nullable columns (like
`FLOAT4[]` and `JSONB`) are exempt: NULL is their implicit default.

JSONB is a column **type**, not a schema escape hatch: use it only for a
genuinely schemaless payload (`sessions.message`, `ontology_proposals.payload`).
If 80% of a blob's fields are filtered every request, they are columns.

## 6. Role separation (index AC-2 / c-AC-3)

The three "memory" tables never blur: `sessions` = raw events, `memory` =
VFS/summaries, `memories` = distilled facts. A new table must not duplicate a
role. Session transcripts are a `memory` **path convention**
(`transcripts/<session>`, see `transcriptPath`), **not** a table (D-1 / c-AC-4).

## 7. Where each Wave-2 Bee writes

| Group | Stub file (edit this) | Exported array name (don't rename) | Test file (edit this) |
|-------|-----------------------|-----------------------------------|-----------------------|
| 003b knowledge graph | `catalog/knowledge-graph.ts` | `KNOWLEDGE_GRAPH_TABLES` | `tests/daemon/storage/catalog/knowledge-graph.test.ts` |
| 003d product tables  | `catalog/product.ts`         | `PRODUCT_TABLES`         | `tests/daemon/storage/catalog/product.test.ts` |
| 003e agents/auth/tel | `catalog/tenancy.ts`         | `TENANCY_TABLES`         | `tests/daemon/storage/catalog/tenancy.test.ts` |

## 8. The barrel/registry contract you must NOT touch

`index.ts` already imports and spreads all five group arrays into `CATALOG` and
builds `REGISTRY`. `registry.ts` derives pattern→primitive. `types.ts` defines
the shape. **Do not edit any of these three** — they are shared-file contention
seams. Fill your group array; it flows through automatically. Verify by importing
`CATALOG` / `REGISTRY` in your test and asserting your tables appear.

## 9. SQL-safety floor (PRD-002b) — applies to any helper you add

If your group file adds a query helper (like 003a's `buildDedupCheckSql`), route
**every** dynamic fragment through `sqlIdent` (identifiers) / `sLiteral` /
`sqlStr` / `sqlLike` (values). `npm run audit:sql` scans `src/daemon/storage`
recursively and fails CI on a raw interpolation. Never hand-quote a value.

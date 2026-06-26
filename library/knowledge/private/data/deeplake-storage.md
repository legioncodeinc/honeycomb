# DeepLake Storage

> Category: Data | Version: 1.0 | Date: June 2026 | Status: Active

The storage substrate: DeepLake as a GPU-backed SQL and vector store, the write patterns that sidestep its UPDATE quirk, the lazy schema-healing primitive, and the SQL-escaping rules that stand in for parameterized queries.

**Related:**
- [`schema.md`](schema.md)
- [`memory-virtual-filesystem.md`](memory-virtual-filesystem.md)
- [`../architecture/system-overview.md`](../architecture/system-overview.md)
- [`../multi-tenant/org-workspace-model.md`](../multi-tenant/org-workspace-model.md)
- [`../security/trust-boundaries.md`](../security/trust-boundaries.md)
- [`../operations/observability-and-degradation.md`](../operations/observability-and-degradation.md)

---

## Why DeepLake

Honeycomb stores every durable byte in DeepLake, a tensor-native, GPU-backed store that speaks SQL and holds vectors as first-class columns. That choice does two things at once. It gives recall GPU-accelerated vector search over the same tables that hold the structured memory, so semantic and lexical retrieval run against one store instead of a database plus a bolted-on vector index. And it gives a team a shared substrate where org and workspace boundaries are enforced at the storage layer, so two workspaces never share a row, partition, or index.

The daemon is the only DeepLake client. Centralizing access in the daemon is what lets the patterns below be applied uniformly: every write goes through the same escaping, the same schema healing, and the same scoping, no matter which harness or hook triggered it.

## Two facts that shape every table

Two properties of the DeepLake query endpoint shape the entire data layer.

First, the query endpoint does not bind parameters. Every value is escaped and interpolated by hand before it is sent. The daemon provides three helpers that every query builder must use: `sqlStr` escapes a value for a single-quoted literal (doubling backslashes and quotes, dropping NUL and control characters), `sqlLike` layers `%` and `_` escaping for `LIKE`/`ILIKE`, and `sqlIdent` validates a table or column name against `^[a-zA-Z_][a-zA-Z0-9_]*$` and throws on anything else. Text bodies that may contain escape sequences are written with the `E'...'` literal form so the doubled-backslash escaping round-trips.

```typescript
export function sqlIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${JSON.stringify(name)}`);
  }
  return name;
}
```

Second, DeepLake has an UPDATE-coalescing quirk: two rapid UPDATEs to the same row within microseconds can silently drop one. Tables that expect concurrent edits therefore avoid in-place UPDATE and use append-only, version-bumped writes instead.

A third property, eventual consistency on reads, is handled by the convergence seam described below.

## The write patterns

Every table uses one of a few patterns, chosen by how it expects to be written.

| Pattern | Used by | How it works |
|---|---|---|
| Append-only INSERT | `sessions`, raw events | One row per event, never concatenated. Readers order by `creation_date`. |
| Append-only, version-bumped | `skills`, `rules`, and the engine's claim history | Every edit INSERTs version N+1; readers take `ORDER BY version DESC LIMIT 1`. |
| UPDATE-or-INSERT by key | `memory`, `goals`, `kpis` | One row per logical key; small-team v1 trade-off accepting the UPDATE quirk for two writes within microseconds. |
| SELECT-before-INSERT | `codebase` snapshots | Check for the identity key, insert if absent, re-verify after to make races observable. |

The version-bumped pattern is the important one for the memory engine. Because DeepLake cannot safely update a row in place under concurrency, the knowledge-graph ontology supersedes a claim by appending a new version and marking the old one superseded, rather than mutating the existing row. The currentness logic in retrieval reads the highest active version. This is documented where it is used in [`../ai/knowledge-graph-ontology.md`](../ai/knowledge-graph-ontology.md).

## Vectors

Embeddings are 768-dimension `nomic-embed-text-v1.5` vectors stored as DeepLake tensor columns (for example `sessions.message_embedding` and `memory.summary_embedding`), nullable so that recall degrades to lexical search when embedding is disabled or fails. Vector search runs on the GPU-backed engine against those columns, so semantic recall and the structured filters that scope it happen in one query. The retrieval flow that consumes this is [`../ai/retrieval.md`](../ai/retrieval.md).

## Read consistency: converging on your own writes

DeepLake is eventually consistent. It flaps stale segments, so a read issued immediately after a write can land on a segment that has not yet caught up and *under-report*: the just-written row is missing, a counter looks un-incremented, a row count comes back short, then a beat later it is there. A single immediate read-back is therefore unsafe: it does not return wrong data so much as *premature* data, and nothing flags that the read was early.

The naive fix, a "poll until it shows up" loop, was being hand-rolled in every live integration test that did a write-then-read-back, each copy drifting its own retry budget (the jscpd-duplication trap). The convergence guarantee belongs once, in the storage seam every read flows through, not scattered as test scaffolding. That seam is `readConverged` (`src/daemon/storage/converge.ts`).

```mermaid
flowchart TD
    write["controlled write emits a watermark (id + version)"] --> read["readConverged(client, sql, scope, predicate)"]
    read --> q["client.query"]
    q --> pred{"predicate holds? (row present / version >= N / count >= k)"}
    pred -->|yes| ok["return the fresh QueryResult"]
    pred -->|no| budget{"budget left? (max attempts + wall-clock)"}
    budget -->|yes| backoff["jittered backoff, then re-poll"]
    backoff --> q
    budget -->|no| soft["return the last real QueryResult (fail-soft, never invent)"]
```

The contract has a few deliberate properties:

- **Watermark-driven, not fuzzy.** The write path (the controlled-write primitives `appendVersionBumped` / `updateOrInsertByKey`) emits a watermark, the just-written id and version, and the read path derives an *exact* freshness predicate from it ("row id X present", "version ≥ N", "count ≥ k"). DeepLake exposes no read-after-write token at the transport, so the write supplies the cursor that makes the predicate precise rather than a wait-and-hope.
- **Opt-in per read.** `query` stays the default. Most reads (recall, dashboard views) are already fail-soft and tolerate slight staleness, and forcing convergence on every request would tax every read for a guarantee only the read-your-writes paths need. `readConverged` is the explicit choice a read-your-writes caller makes.
- **Bounded and fail-soft.** The seam polls until the predicate holds or a bounded budget is exhausted, roughly 2 seconds of wall-clock or ten attempts with jittered, capped backoff, all env-overridable (`HONEYCOMB_READ_CONVERGE_*`). On exhaustion it returns the *last real* `QueryResult` (typically a smaller-than-expected `ok`). It never fabricates the awaited row and never throws past the closed `QueryResult` union. A stale read under-reports; it must not lie.
- **Complementary to transport retry.** `StorageClient.query` already retries on transport failures (connection error, timeout, transient 5xx), a non-ok result. `readConverged` is different: it polls on *ok* results until a freshness predicate holds, the stale-segment under-report case where the read succeeded but the data is not yet fresh. A transport failure short-circuits naturally, because the predicate will not hold against a non-ok result.

The seam is live and consumed where read-your-writes matters: asset-sync confirms a write through it, the dashboard sync API reads back convergently before reporting success, and the live integration tests poll through it instead of each re-deriving a loop. The same discipline appears in [`../operations/observability-and-degradation.md`](../operations/observability-and-degradation.md): a premature read is a degradation that must never pass silently.

## Lazy schema healing

DeepLake tables are created lazily, on first write, by whichever daemon worker runs first. The schema is defined once as an array of `{ name, sql }` column definitions, and both the create path and the heal path iterate the same array, so there is no second mirror that can drift.

```mermaid
flowchart TD
    insertAttempt["INSERT attempt"] --> failed{"failed?"}
    failed -->|no| done["row written"]
    failed -->|missing table| createTable["CREATE TABLE IF NOT EXISTS"]
    createTable --> healPass["heal missing columns"]
    failed -->|missing column| healPass
    healPass --> selectCols["SELECT information_schema.columns"]
    selectCols --> diff["diff against schema definition"]
    diff --> alter["ALTER ADD only the missing columns"]
    alter --> retry["retry INSERT once"]
    retry --> done
    failed -->|other| rethrow["rethrow original error"]
```

When a write fails because a table or column is missing, the writer runs a targeted heal: one `SELECT` against `information_schema.columns` reads the current columns, the result is diffed against the schema definition, and only the genuinely missing columns are added with `ALTER TABLE ADD COLUMN`. A load-time guard rejects any `NOT NULL` column that lacks a `DEFAULT`, because adding such a column to a populated table fails. Error classification distinguishes missing-table from missing-column from permission errors, so a credentials problem is never misread as a schema gap.

## Tenant isolation at the storage layer

Org and workspace boundaries are not just an API filter; they are enforced where the data lives. Every row carries org and workspace identity, the daemon sends the resolved org on each request, and DeepLake resolves tenancy so a query in one workspace cannot reach another's rows, partitions, or indexes. Within a workspace, the engine's `agent_id` and visibility columns separate agents. The tenancy model is documented in [`../multi-tenant/org-workspace-model.md`](../multi-tenant/org-workspace-model.md) and the scoping enforcement in [`../security/scoping-and-visibility.md`](../security/scoping-and-visibility.md).

## Reading the current state

The read patterns follow the write patterns: read a `memory` row by `path`; read `sessions` rows for a `path` ordered by `creation_date` and concatenate; take the highest `version` for `skills`, `rules`, and claim history; read the single row per key for `goals` and `kpis`; SELECT by identity key for `codebase`. These conventions keep every table internally consistent under concurrent daemon workers without relying on database transactions, which DeepLake does not expose at this layer. The full table catalog is [`schema.md`](schema.md).

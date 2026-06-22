# PRD-002: DeepLake Storage Adapter

> **Status:** Completed
> **Priority:** P0
> **Effort:** XL
> **Schema changes:** Additive

---

## Overview

This is the critical-path module. The otherhive memory engine that forms Honeycomb's foundation assumed a SQLite-style store with real transactions; DeepLake has none. DeepLake is a tensor-native, GPU-backed store that speaks SQL and holds 768-dimension vectors as first-class columns, but its query endpoint binds no parameters and it coalesces concurrent UPDATEs in a way that can silently drop an edit. This module builds the storage adapter that the daemon (the only DeepLake client) uses for every durable byte: a typed client and connection layer, the `sqlStr`/`sqlLike`/`sqlIdent` escaping that stands in for parameterized queries, lazy schema creation and `information_schema` healing, the write primitives that achieve atomicity without transactions, and the GPU vector-search interface over 768-dim tensor columns.

## Goals

- Provide a single DeepLake client in the daemon that every query builder routes through, with consistent escaping, healing, and scoping.
- Replace parameterized queries entirely with `sqlStr`/`sqlLike`/`sqlIdent` escaping plus `E'...'` literals for bodies with escape sequences.
- Heal schema lazily: create tables on first write and add only genuinely missing columns via `information_schema` diff.
- Offer durable write primitives (append-only, version-bumped, UPDATE-or-INSERT, SELECT-before-INSERT) that give atomicity without transactions.
- Expose a GPU-backed vector-search interface over 768-dim nullable tensor columns that degrades to lexical search when embeddings are absent.

## Non-Goals

- The table catalog itself (PRD-003 defines the tables; this module provides the substrate).
- The memory pipeline and retrieval logic that consume these primitives (PRD-006, PRD-007).
- Authentication and tenancy policy decisions (storage enforces partition boundaries; policy lives elsewhere).

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-002a-deeplake-storage-adapter-client`](./prd-002a-deeplake-storage-adapter-client.md) | DeepLake client, connection management, config. | Draft |
| [`prd-002b-deeplake-storage-adapter-sql-safety`](./prd-002b-deeplake-storage-adapter-sql-safety.md) | `sqlStr`/`sqlLike`/`sqlIdent` escaping and `E'...'` literals. | Draft |
| [`prd-002c-deeplake-storage-adapter-schema-healing`](./prd-002c-deeplake-storage-adapter-schema-healing.md) | Lazy table creation and `information_schema` diff heal. | Draft |
| [`prd-002d-deeplake-storage-adapter-write-patterns`](./prd-002d-deeplake-storage-adapter-write-patterns.md) | Append-only version-bump, UPDATE-or-INSERT, SELECT-before-INSERT, atomicity without transactions. | Draft |
| [`prd-002e-deeplake-storage-adapter-vector-search`](./prd-002e-deeplake-storage-adapter-vector-search.md) | 768-dim tensor columns and GPU vector-search interface. | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given any value interpolated into a query, when the adapter builds the statement, then the value is escaped through `sqlStr`/`sqlLike`/`sqlIdent` and no parameterized binding is used. |
| AC-2 | Given a write to a table or column that does not exist, when the write fails, then the adapter creates the table or adds only the missing columns and retries the write once. |
| AC-3 | Given two rapid edits to a concurrent-edit table, when both commit, then the version-bumped append pattern preserves both versions and the highest version reads as current. |
| AC-4 | Given a query with a 768-dim embedding, when vector search runs, then it executes on the GPU-backed engine against the tensor column and returns scored IDs; when the embedding is null, recall degrades to lexical search. |

## Data model changes

Additive: introduces the column-definition array format (`{ name, sql }`) and 768-dim `FLOAT4[]` tensor columns as the substrate primitives that PRD-003 tables build on. No table catalog is defined here.

## API changes

Internal daemon storage API only: client, escaping helpers, heal primitive, write-pattern helpers, and vector-search interface. No HTTP surface.

## Open questions

- [ ] What is the exact connection/auth model for the DeepLake endpoint (token, org resolution header) and how is it configured?
- [ ] Does the load-time guard rejecting `NOT NULL` columns without `DEFAULT` belong in the heal pass or in a separate schema validator?
- [ ] What is the over-fetch multiplier for scoped vector recalls before the authorization filter is applied?

## Related

- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
- [Schema](../../../knowledge/private/data/schema.md)
- [System Overview](../../../knowledge/private/architecture/system-overview.md)

# PRD-002d: Write Patterns and Atomicity Without Transactions

> **Parent:** [PRD-002](./prd-002-deeplake-storage-adapter-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** L

## Scope

Implement the write primitives that give correctness without transactions on a store that has none: append-only INSERT, append-only version-bumped writes, UPDATE-or-INSERT by key, and SELECT-before-INSERT, each chosen by how its table expects to be written. In scope: the four named primitives, the matching read conventions, and the routing of every interpolated value through the escaping helpers. Out of scope: the connection layer (PRD-002a), schema healing (PRD-002c, invoked on write failure), vector search (PRD-002e), and the table catalog (PRD-003) that assigns a pattern to each table.

## Goals

- Provide named write primitives so each table uses the pattern that survives DeepLake's UPDATE-coalescing quirk.
- Achieve atomicity-equivalent correctness without transactions, which DeepLake does not expose at this layer.
- The version-bumped primitive appends version N+1 on every edit so readers can take `ORDER BY version DESC LIMIT 1` as current, never losing an edit to coalescing.
- The SELECT-before-INSERT primitive re-verifies after insert so a race is observable rather than silently doubling a row.
- Every interpolated value routes through the PRD-002b escaping helpers; there is no raw-interpolation path.

## Non-Goals

- The client and connection layer (PRD-002a).
- Schema creation and healing (PRD-002c), though a write failure may trigger it.
- Vector columns and search (PRD-002e).
- The table catalog (PRD-003) that maps each table to a pattern.

## User stories

- As a query builder, I want named write primitives so that each table uses the pattern that survives DeepLake's UPDATE-coalescing quirk.
- As the memory engine, I want version-bumped appends so that two rapid edits both persist and the highest version reads as current.
- As a maintainer, I want the codebase-snapshot path to re-verify after insert so that a racing duplicate is detectable instead of silent.

## Functional requirements

- FR-1: Append-only INSERT writes one row per event and never concatenates; used by `sessions` and raw events, with readers ordering by `creation_date`.
- FR-2: Append-only version-bumped writes INSERT version N+1 on every edit; used by `skills`, `rules`, and the engine's claim history. Readers take `ORDER BY version DESC LIMIT 1` as the current row.
- FR-3: The version-bumped supersede path marks the prior version superseded by appending the new version rather than mutating the existing row, so the knowledge-graph currentness logic reads the highest active version.
- FR-4: UPDATE-or-INSERT by key maintains one row per logical key for `memory`, `goals`, and `kpis`; this is the small-team v1 trade-off that accepts the UPDATE-coalescing risk for two writes landing within microseconds.
- FR-5: SELECT-before-INSERT checks for the identity key, inserts if absent, and re-verifies after insert; used by `codebase` snapshots so a race is observable rather than silently doubling the row.
- FR-6: Hot tables that expect concurrent edits never use in-place UPDATE, because DeepLake can coalesce two rapid UPDATEs to the same row within microseconds and silently drop one.
- FR-7: Every value interpolated by a primitive routes through `sqlStr`/`sqlLike`/`sqlIdent` (PRD-002b); bodies with escape sequences use `E'...'`. There is no parameterized binding.
- FR-8: A write that fails on a missing table or column delegates to the heal path (PRD-002c) and retries once; the primitives are heal-aware.
- FR-9: The read conventions mirror the write patterns: read `memory` by `path`; read `sessions` for a `path` ordered by `creation_date` and concatenate; take highest `version` for `skills`/`rules`/claim history; read the single row per key for `goals`/`kpis`; SELECT by identity key for `codebase`.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a concurrent-edit table, when an edit lands, then the version-bumped primitive INSERTs version N+1 and readers take `ORDER BY version DESC LIMIT 1` as current. |
| AC-2 | Given a SELECT-before-INSERT identity key, when two writers race, then the primitive re-verifies after insert so the race is observable rather than silently doubling the row. |
| AC-3 | Given two rapid edits to a version-bumped table, when both commit, then both versions persist and the highest version reads as current. |
| AC-4 | Given a `sessions` write, when it lands, then it appends one row and never concatenates an existing one; readers order by `creation_date`. |
| AC-5 | Given a supersede on a version-bumped table, when it runs, then the prior version is marked superseded by appending a new version rather than mutating the old row. |
| AC-6 | Given a primitive writing any value, when the statement is built, then every value passed through `sqlStr`/`sqlLike`/`sqlIdent` with `E'...'` for escape-bearing bodies. |
| AC-7 | Given a write that fails on a missing column, when the primitive runs, then it heals via PRD-002c and retries once. |

## Implementation notes

- The four patterns map to tables exactly as the storage doc specifies: append-only INSERT for raw events (`sessions`), version-bumped for `skills`/`rules`/claim history, UPDATE-or-INSERT for `memory`/`goals`/`kpis`, and SELECT-before-INSERT for `codebase` snapshots. PRD-003 assigns the pattern per table; this module implements the primitives.
- The version-bumped pattern is the important one for the memory engine: because DeepLake cannot safely update a row in place under concurrency, the knowledge-graph ontology supersedes a claim by appending a new version and marking the old one superseded. Currentness logic in retrieval reads the highest active version.
- UPDATE-or-INSERT for `memory`/`goals`/`kpis` is an explicit small-team v1 trade-off: it accepts the rare UPDATE-coalescing drop in exchange for one row per logical key, acceptable because these tables do not see microsecond-rapid concurrent writes from a small team. Revisit if write concurrency grows.
- SELECT-before-INSERT cannot prevent a race (no transactions), so it makes the race observable: re-verify after insert and surface a detectable duplicate rather than a silent one.
- The helper signatures shared with PRD-003 tables (the `{ name, sql }` definitions and the per-table pattern selection) are still to be defined; coordinate the primitive entry points with the catalog.

## Dependencies

- PRD-002a (client) executes the statements.
- PRD-002b (escaping) is mandatory for every interpolated value.
- PRD-002c (healing) is invoked on missing-table/column write failures.
- PRD-003 maps each table to a pattern and supplies its column definitions.
- Knowledge-graph ontology (PRD consuming claim history) depends on the version-bumped supersede behavior.

## Open questions

- [ ] What are the exact helper signatures shared with PRD-003 tables for selecting a pattern per table?
- [ ] At what write-concurrency threshold should `memory`/`goals`/`kpis` move off UPDATE-or-INSERT onto version-bumped?
- [ ] How is a detected SELECT-before-INSERT duplicate reconciled: drop the later row, merge, or surface to the caller?

## Related

- [parent index](./prd-002-deeplake-storage-adapter-index.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
- [Schema](../../../knowledge/private/data/schema.md)

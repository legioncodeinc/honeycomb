# PRD-002c: Lazy Schema Healing

> **Parent:** [PRD-002](./prd-002-deeplake-storage-adapter-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

Build the lazy schema mechanism: tables are created on first write from a single `{ name, sql }` column-definition array, and a heal pass diffs `information_schema.columns` against that array to add only genuinely missing columns. In scope: the on-write create path, the targeted heal path, error classification distinguishing missing-table from missing-column from permission errors, the single-retry-after-heal behavior, and the load-time guard against `NOT NULL` columns lacking a `DEFAULT`. Out of scope: the table catalog itself (PRD-003), the escaping helpers (PRD-002b), and the write patterns (PRD-002d), though heal is triggered from within a write.

## Goals

- Tables and columns self-heal on write so a new column does not require an ahead-of-time migration step.
- The create path and heal path iterate the same `{ name, sql }` column-definition array, so there is no second mirror that can drift.
- A failed write that is caused by a missing table or column triggers a targeted heal and exactly one retry; other failures rethrow unchanged.
- The heal pass reads `information_schema.columns` once, diffs against the definition, and adds only the genuinely missing columns with `ALTER TABLE ADD COLUMN`.
- A load-time guard rejects any `NOT NULL` column lacking a `DEFAULT`, because adding one to a populated table fails.

## Non-Goals

- The table catalog and per-table column definitions (PRD-003).
- The escaping helpers (PRD-002b) the heal SQL uses.
- The write primitives (PRD-002d) that trigger heal.
- Destructive migrations (column drops, type changes, renames), which are out of the heal model.

## User stories

- As a daemon worker, I want tables and columns to self-heal on write so that a new column does not require an ahead-of-time migration step.
- As a maintainer, I want create and heal to share one column-definition array so that the live schema can never drift from a second copy.
- As an operator, I want a credentials error to never be misread as a schema gap so that heal does not mask an auth failure.

## Functional requirements

- FR-1: Each table is defined once as an array of `{ name, sql }` column definitions; the create path emits `CREATE TABLE IF NOT EXISTS` from that array and the heal path diffs against the same array.
- FR-2: On a write failure, error classification distinguishes three cases: missing-table, missing-column, and other (permission, connection, syntax); only the first two enter the heal path.
- FR-3: On missing-table, the heal path runs `CREATE TABLE IF NOT EXISTS` from the column-definition array, then runs the column heal, then retries the original write exactly once.
- FR-4: On missing-column, the heal path issues one `SELECT` against `information_schema.columns` for the table, diffs the present columns against the definition array, and issues `ALTER TABLE ADD COLUMN` for only the genuinely missing columns.
- FR-5: After a successful heal, the original write is retried exactly once; a second failure rethrows rather than looping.
- FR-6: Any failure classified as other (notably permission errors) rethrows the original error unchanged and never triggers create or alter, so a credentials problem is never misread as a schema gap.
- FR-7: A load-time guard scans every column definition and rejects, at daemon load, any `NOT NULL` column that lacks a `DEFAULT`, since `ALTER ADD` of such a column to a populated table fails.
- FR-8: All identifiers in create/alter/select statements are validated through `sqlIdent` (PRD-002b); no table or column name is interpolated unvalidated.
- FR-9: Concurrent daemon workers healing the same table converge safely: `IF NOT EXISTS` on create and add-only-missing on alter make repeated heals idempotent.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a write that fails because the table is missing, when the heal path runs, then it creates the table from the column-definition array and retries the write once. |
| AC-2 | Given a write that fails because a column is missing, when the heal path runs, then it reads `information_schema.columns`, diffs against the definition, and adds only the missing columns. |
| AC-3 | Given a write that fails with a permission error, when error classification runs, then it rethrows unchanged and never issues a create or alter. |
| AC-4 | Given a heal that still fails the retry, when the second attempt errors, then the adapter rethrows rather than retrying again. |
| AC-5 | Given a column definition with `NOT NULL` and no `DEFAULT`, when the daemon loads, then the load-time guard rejects it before any write. |
| AC-6 | Given two workers healing the same missing table concurrently, when both run, then `IF NOT EXISTS` and add-only-missing make the result identical to a single heal. |
| AC-7 | Given a heal `ALTER` statement, when it is built, then every identifier passes `sqlIdent` validation. |

## Implementation notes

- The flow is: INSERT attempt -> classify failure -> on missing-table `CREATE TABLE IF NOT EXISTS` then heal columns; on missing-column heal columns directly -> `SELECT information_schema.columns` -> diff against the definition -> `ALTER ADD` only missing columns -> retry INSERT once. Any other error rethrows.
- The single shared `{ name, sql }` array is the anti-drift mechanism: create and heal both read it, so there is no second schema mirror. PRD-003 supplies the per-table arrays; this module supplies the heal engine that consumes them.
- The `NOT NULL`-without-`DEFAULT` guard runs at load, not at heal, because the failure is structural and should surface before any production write hits it. The open question is whether this guard lives inside heal or in a separate schema validator.
- Error classification is the subtle part: misclassifying a permission error as a missing-table would mask an auth failure behind a confusing create attempt, so the classifier must be conservative and rethrow anything it cannot positively identify as a schema gap.

## Dependencies

- PRD-002a (client) executes the create/select/alter statements.
- PRD-002b (escaping) validates identifiers via `sqlIdent`.
- PRD-002d (write patterns) triggers heal from within a failed write.
- PRD-003 supplies the per-table `{ name, sql }` column-definition arrays.

## Open questions

- [ ] Does the load-time guard rejecting `NOT NULL` columns without `DEFAULT` belong in the heal pass or in a separate schema validator?
- [ ] How are type changes and column renames handled, given heal is add-only and non-destructive?
- [ ] Should heal cache the `information_schema` read per table per process to avoid repeated lookups under heavy write load?

## Related

- [parent index](./prd-002-deeplake-storage-adapter-index.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)

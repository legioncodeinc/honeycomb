# PRD-002b: SQL Safety Escaping

> **Parent:** [PRD-002](./prd-002-deeplake-storage-adapter-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

Implement the escaping helpers that stand in for parameterized queries on a DeepLake endpoint that binds none: `sqlStr` for single-quoted literals, `sqlLike` for `LIKE`/`ILIKE` patterns, `sqlIdent` for validated identifiers, and the `E'...'` literal form for text bodies carrying escape sequences. In scope: the three helpers, the `E'...'` convention, and the rule that every query builder routes through them with no parameterized fallback. Out of scope: the client connection (PRD-002a), schema healing (PRD-002c), write primitives (PRD-002d), and vector search (PRD-002e), all of which consume these helpers.

## Goals

- Provide a complete escaping surface that replaces parameterized queries entirely, since the DeepLake query endpoint binds no parameters.
- `sqlStr` produces a safe single-quoted literal by doubling quotes and backslashes and dropping NUL and control characters.
- `sqlLike` layers `%` and `_` escaping on top of `sqlStr` for pattern queries.
- `sqlIdent` validates table and column names against `^[a-zA-Z_][a-zA-Z0-9_]*$` and throws on anything else, so identifiers can never carry injection.
- Text bodies that may contain escape sequences use the `E'...'` form so the doubled-backslash escaping round-trips correctly.

## Non-Goals

- The connection/client layer (PRD-002a).
- Schema creation and healing (PRD-002c).
- Write-pattern primitives (PRD-002d).
- Vector search and tensor columns (PRD-002e).

## User stories

- As a query builder, I want safe escaping helpers so that I never hand-interpolate an unescaped value into a DeepLake statement.
- As a security reviewer, I want identifier validation to throw on anything outside the safe charset so that no caller can smuggle a crafted column name.
- As a maintainer, I want one escaping surface so that there is no parameterized fallback path to forget to use.

## Functional requirements

- FR-1: `sqlStr(value)` returns a single-quoted SQL literal with embedded single quotes and backslashes doubled, and NUL and other control characters dropped.
- FR-2: `sqlLike(pattern)` builds on `sqlStr` and additionally escapes the `LIKE`/`ILIKE` wildcards `%` and `_` so a literal substring search is not interpreted as a wildcard.
- FR-3: `sqlIdent(name)` validates against `^[a-zA-Z_][a-zA-Z0-9_]*$` and throws `Invalid SQL identifier: <json>` on any non-matching input; it returns the name unchanged on success.
- FR-4: Text bodies that may contain escape sequences (for example message content with `\n`) are written using the `E'...'` literal form so the doubled-backslash escaping from `sqlStr` round-trips to the intended bytes.
- FR-5: Every query builder in this adapter and in downstream modules (PRD-002c/d/e and PRD-003) routes interpolated values through these helpers; there is no parameterized binding and no raw-interpolation fallback.
- FR-6: The helpers are pure, synchronous, side-effect-free functions exported from one module so there is a single source of truth and no drift between copies.
- FR-7: A lint rule or typed query-builder wrapper flags raw interpolation of an untrusted value into a statement string that bypasses the helpers.
- FR-8: The helpers handle empty strings, already-quoted input, multibyte/Unicode content, and embedded newlines without producing a malformed literal.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a value with quotes, backslashes, or control characters, when `sqlStr` escapes it, then quotes and backslashes are doubled and NUL/control characters are dropped. |
| AC-2 | Given an identifier, when `sqlIdent` validates it, then it accepts only `^[a-zA-Z_][a-zA-Z0-9_]*$` and throws on anything else. |
| AC-3 | Given a search term containing `%` or `_`, when `sqlLike` escapes it, then those wildcards are treated as literals rather than pattern operators. |
| AC-4 | Given a body containing `\n` or other escape sequences, when written via `E'...'`, then the stored bytes match the intended content after round-trip. |
| AC-5 | Given an injection attempt like `'; DROP TABLE x; --` passed to `sqlStr`, when interpolated, then it is a single inert literal and no second statement executes. |
| AC-6 | Given a crafted column name like `id; DROP`, when passed to `sqlIdent`, then it throws and the query is never built. |
| AC-7 | Given a query builder that hand-interpolates a value, when CI lint runs, then the bypass is flagged. |

## Implementation notes

- These helpers exist because the DeepLake query endpoint does not bind parameters: every value is escaped and interpolated by hand before it is sent. They are the security floor for the entire data layer, so correctness here is non-negotiable.
- `sqlIdent` is intentionally strict (throw, not sanitize) because a silently rewritten identifier would be a worse failure than a rejected one; callers pass only known schema names.
- The `E'...'` form pairs with `sqlStr`'s backslash-doubling so escape sequences in bodies round-trip; using a plain `'...'` literal for a body with backslashes would corrupt it.
- Keep the three helpers in one module and route every builder through them; per the coding standards, do not duplicate this logic across files where it could drift.

## Dependencies

- PRD-002a (client) is where the escaped statements are executed.
- Downstream: PRD-002c, 002d, 002e, and PRD-003 all consume these helpers.
- External: none beyond the language runtime; intentionally dependency-free.

## Open questions

- [ ] How is the no-parameterized-fallback rule enforced: a custom Biome rule, a typed query-builder that only accepts pre-escaped fragments, or both?
- [ ] Does `sqlLike` need a configurable escape character, or is the default backslash sufficient for DeepLake's `LIKE`?
- [ ] Should there be an `sqlNum`/`sqlBool` helper, or are non-string scalars formatted inline at the call site?

## Related

- [parent index](./prd-002-deeplake-storage-adapter-index.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)

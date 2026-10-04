# PRD-074a: Catalog Column, Capture Write, and Recall Swap

> **Parent:** [`prd-074-sessions-prose-column-index.md`](./prd-074-sessions-prose-column-index.md)
> **Status:** Draft

---

## Scope

The mechanical change: add the `prose` column to the `sessions` catalog, populate it at capture time from the typed `CaptureEvent`, and redirect the **live lexical recall arm** (the `ILIKE` path in `recallMemories`) to read `prose` instead of `message::text`. The `tool_call` prose format itself — the cap, the file-path-aware first line — is defined in [074b](./prd-074b-tool-call-prose-format.md); this sub-PRD consumes `proseForEvent(event)` as a given.

This is a wiring PRD. No new business logic, no new DeepLake schema machinery. Every mechanism (the heal path, the `ILIKE` arm, the row-to-hit mapper) already exists and is reused. The native hybrid operator (`deeplake_hybrid_record`) is **out of scope** — not in the production recall path (PRD-047a, ADR-0001), and the unwired `hybrid-recall.ts` reference candidate is left untouched.

---

## Changes

### 1. Catalog: add the `prose` column

**File:** `src/daemon/storage/catalog/sessions-summaries.ts`

Add to `SESSIONS_COLUMNS` (alongside the existing `model` / `source_tool` additive columns):

```ts
// PRD-074: the derived prose form of the event — the compact, harness-ready text recall
// matches + returns. Populated at capture time from the typed CaptureEvent by
// `proseForEvent` (event-contract.ts). NOT NULL DEFAULT '' so legacy rows heal cleanly
// (recall falls back to `message::text` for empty `prose` via a COALESCE). The structured
// `message` JSONB stays verbatim for downstream parsers (summaries/skillify/ROI).
{ name: "prose", sql: "TEXT NOT NULL DEFAULT ''" },
```

**Heal-safety.** `TEXT NOT NULL DEFAULT ''` satisfies the load guard at `src/daemon/storage/schema.ts:80-100` (`validateColumnDefs`: a `NOT NULL` column must carry a `DEFAULT`). The empty string backfills legacy rows; recall's COALESCE fallback (see change #3) treats empty as "use `message::text` instead". This is the exact posture PRD-060a took for its `sessions` columns.

### 2. Capture write: populate `prose` from the typed event

**File:** `src/daemon/runtime/capture/capture-handler.ts`

In `buildRow()` (at `src/daemon/runtime/capture/capture-handler.ts:537`), beside the existing `model` / `source_tool` writes (around `:576`, `:581`), add:

```ts
// PRD-074: the prose form, derived from the typed event (no JSONB re-parse).
["prose", val.str(proseForEvent(event))],
```

**Why this is cheap.** `buildRow` already receives the parsed `CaptureEvent` (`:338`: `this.buildRow(id, event, metadata, nowIso, projectId)`), and already calls event-shape helpers like `modelFor(event)` (`:581`) and `embedTextFor(event)` (`:734`, `:754`). `proseForEvent(event)` is the same shape of helper — pure, synchronous, derives from the typed event the handler already holds. No re-parsing of the serialized `message` JSONB.

**Where `proseForEvent` lives.** Define it in `src/daemon/runtime/capture/event-contract.ts`, sibling to the existing event schemas. For `user_message` and `assistant_message` it returns `event.text` verbatim. For `tool_call` it defers to the format in [074b](./prd-074b-tool-call-prose-format.md). The full signature:

```ts
// event-contract.ts
export function proseForEvent(event: CaptureEvent): string { ... }
```

**Batched path.** The batched capture path (`flushBatch()` → `appendOnlyInsertMany` at `:483-485`) builds rows via the same `buildRow`, so both single and batched INSERTs populate `prose` identically.

### 3. Lexical recall swap (the `ILIKE` arm)

**File:** `src/daemon/runtime/memories/recall.ts`

In `buildSessionsArmSql` (`:367-385`), change the projection AND the `ILIKE` predicate from `message::text` to a COALESCE that prefers `prose` and falls back to `message::text` for legacy rows:

```ts
// Before:
//   SELECT 'sessions' AS source, "path" AS id, "message"::text AS text, ...
//   WHERE "message"::text ILIKE '%<term>%'...

// After:
const proseCol = sqlIdent("prose");
const messageCol = sqlIdent("message");
const matchExpr = `COALESCE(NULLIF(${proseCol}, ''), ${messageCol}::text)`;
return (
    `SELECT 'sessions' AS source, ${pathCol} AS id, ${matchExpr} AS text, ${createdAtCol}::text AS created_at ` +
    `FROM "${sessionsTbl}" ` +
    `WHERE ${matchExpr} ILIKE ${pattern}${projectClause} ` +
    `LIMIT ${perArm}`
);
```

**Why COALESCE(NULLIF(...), ...).** `NULLIF(prose, '')` converts the empty string (legacy rows) to NULL, which the COALESCE then replaces with `message::text`. Non-empty `prose` (new rows) wins outright. This means:
- **New rows:** matched + returned on `prose` (the clean text). The JSONB never touches the harness.
- **Legacy rows:** matched + returned on `message::text` (the JSONB cast). Old data still works, just with the old bloat — the documented, acceptable posture (mirrors PRD-060a's "legacy reads back as absent" discipline).

**The row-to-hit mapper is unchanged.** `rowsToRankedArm` (`recall.ts` ~`:555-563`) reads `row.text` (the SQL alias), so it doesn't matter whether the underlying column was `prose` or `message::text` — the alias is `text` either way.

---

## Out of scope: the native hybrid reference candidate

The unwired `hybrid-recall.ts` reference candidate (`HYBRID_ARMS[1].textColumn: "message"` at `:135`) is **not touched** by this PRD. PRD-047a evaluated `deeplake_hybrid_record` live and declined it (degenerate zero scores 2026-06-22; parity-without-beating RRF 2026-06-24); ADR-0001 records the decision; RRF is the production posture. If PRD-047a is ever re-opened, swapping the reference candidate's `textColumn` to `prose` is that future PRD's call. Keeping this PRD scoped to the live `recallMemories` engine is cleaner than maintaining benchmark code with zero production callers.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| a-AC-1 | The `sessions` table gains a `prose TEXT NOT NULL DEFAULT ''` column. The catalog array `SESSIONS_COLUMNS` in `src/daemon/storage/catalog/sessions-summaries.ts` includes it, positioned alongside the existing additive columns. |
| a-AC-2 | The column heals cleanly onto a legacy `sessions` table via the existing `withHeal` / `healColumns` path (`src/daemon/storage/heal.ts:124-154`). A test asserts the heal is additive (no drop/rewrite) and idempotent — a second heal on an already-healed table is a no-op. Mirrors PRD-060a's a-AC-3. **(This is the only schema-level AC; everything below is read/write path behavior.)** |
| a-AC-3 | The capture handler populates `prose` for every new `sessions` INSERT. The value is derived from the typed `CaptureEvent` (no re-parsing of the serialized `message` JSONB). Both single and batched INSERT paths populate it. |
| a-AC-4 | For a `user_message` event, `prose` equals `event.text` verbatim. For an `assistant_message` event, `prose` equals `event.text` verbatim. (No cap on these kinds.) |
| a-AC-5 | For a `tool_call` event, `prose` follows the 074b format: a file-path-aware first line when the input carries a path, plus a bounded response body. The cap is the named export `TOOL_PROSE_RESPONSE_CAP` from 074b. |
| a-AC-6 | The lexical `sessions` recall arm (`buildSessionsArmSql`) returns `prose` for rows where it is non-empty, and falls back to `message::text` for rows where `prose` is empty, via `COALESCE(NULLIF(prose, ''), message::text)`. The same expression appears in the `ILIKE` predicate so legacy rows stay matchable. |
| a-AC-7 | Every existing `message` JSONB consumer is unchanged: `summaries/worker.ts` (parseEnvelope at `:390-406`, `:419`), `skillify/miner.ts` (`:203-204`, `:360`), `dashboard/roi-session-writer.ts` (`rowToCapturedTurn` at `:105`), `dashboard/api.ts` (`rowToCapturedTurn` at `:759`). A test asserts each still reads `message` JSONB and parses the typed envelope. |
| a-AC-8 | All existing recall, capture-handler, heal, and dashboard tests remain green without modification (other than the new-assertion tests this PRD adds). `hybrid-recall.ts` is untouched (out of scope) so its tests are unchanged. |

---

## Implementation notes

### The COALESCE belongs in the SQL, not the mapper

The lexical fallback's COALESCE lives in the SELECT projection and the ILIKE predicate, NOT in the row-to-hit mapper. This is deliberate: it means legacy rows (empty `prose`) match against `message::text` in the SAME scan that matches new rows against `prose`, so a single recall query returns a coherent mix of old + new hits without a per-row round-trip. The mapper reads the uniform `text` alias and never knows which column filled it.

### The hybrid arm cannot COALESCE the same way (and it doesn't matter)

The lexical arm's COALESCE works because `ILIKE` is a plain SQL operator over any text expression. The hybrid operator (`deeplake_hybrid_record`) takes a `(embedding, text)` composite cast, and whether it would accept a `COALESCE(NULLIF(prose, ''), message::text)` expression as its text component is moot: **the hybrid operator is out of scope for this PRD** (PRD-047a, ADR-0001, RRF is production). The question is settled when the operator is — in a future PRD that re-opens PRD-047a.

### `proseForEvent` is pure and synchronous

The extractor lives in `event-contract.ts` alongside the schemas it pattern-matches. It takes the typed `CaptureEvent` (already zod-validated at the boundary) and returns a string. No IO, no async, no model call. This matches the existing `embedTextFor` shape and keeps the capture hot path unchanged in cost.

### No migration, no backfill

Mirrors PRD-060a's discipline. The column heals in empty; new captures populate it; legacy rows stay empty and recall falls back. There is no one-shot migration script, no background backfill job, no coordinated downtime. The first time a write hits a table missing the column, the heal adds it and the write retries once.

---

## Risks

- **The legacy-row lexical fallback cost.** `COALESCE(NULLIF(prose, ''), message::text)` is computed per-row in the lexical scan. For a corpus that is fully turned over (`prose` populated everywhere), the NULLIF short-circuits and `message::text` is never cast — the scan reads `prose`, the smaller column. For a mixed corpus, legacy rows pay the cast. Net: never worse than today, strictly better once turned over.
- **`proseForEvent` divergence from `embedTextFor`.** Both extract prose from a `CaptureEvent`; they could drift. Mitigation: 074b documents the relationship explicitly and recommends either sharing a helper or extracting a shared "event summary" primitive. Not a blocker for 074a.

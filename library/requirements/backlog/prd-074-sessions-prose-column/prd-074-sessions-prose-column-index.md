# PRD-074: Sessions Prose Column — Kill the JSONB Blob in Recall

> **Status:** Backlog
> **Priority:** P1 (context-window cost on every raw-turn recall hit; bounded because `sessions` is the demoted `secondary` arm, but real and compounding)
> **Effort:** M (~1-2d)
> **Schema changes:** One additive `TEXT NOT NULL DEFAULT ''` column (`prose`) on the `sessions` catalog group via additive schema healing. No destructive migration.

---

## Overview

Honeycomb has four recall arms. Three of them (`memories`, `memory`, `hive_graph_versions`) return clean TEXT to the harness. The fourth — `sessions` — casts the JSONB `message` column to `::text` at query time and ships the **full JSON envelope** as the recall hit's `text` field. This is the only arm that wastes the harness's context window on structural noise.

The concrete symptom (a captured `Read` tool call, surfaced as a recall hit):

```
{"event":{"kind":"tool_call","tool":"Read","input":{"limit":75,"offset":175,"file_path":"C:\\Users\\mario\\GitHub\\the-apiary\\hive\\src\\dashboard\\web\\pages\\dashboard.tsx"},"response":{"file":{"content":"// 'healthReasons' is no longer polled here — the SHEL..."}}},"metadata":{...}}
```

~400 chars of escaped JSON structure carry ~80 chars of actual signal: a file path and a truncated content snippet. The quotes are escaped, the Windows path is double-backslashed, and the `{event, metadata, response, file}` nesting is pure overhead the harness never reads. For a `Read` with a real (non-truncated) file response, the gap is far wider — the JSONB carries the entire file content with every quote escaped, while the prose form carries the same content cleanly. This bloat is **per-event** (each `sessions` row is one event, not one turn — see `capture-handler.ts:30` "N events in a turn → N INSERTs"), and it compounds across every raw-turn recall hit.

The asymmetry is structural. The **live recall engine** is `recallMemories` (`memories/recall.ts`, wired at `memories/api.ts:545`), which uses `<#>` cosine semantic arms + `ILIKE` lexical arms, fused by post-query RRF in TypeScript (see Prior art: PRD-047a, ADR-0001 — the native `deeplake_hybrid_record` operator was evaluated and **declined**). Its lexical arms:

| Recall arm | Match + return column | Shape shipped to harness |
|---|---|---|
| `memories` (distilled facts) | `content::text` | ✅ clean text |
| `memory` (VFS + summaries) | `summary::text` | ✅ clean text |
| `hive_graph_versions` (nectar descriptions) | `title \|\| description` `::text` | ✅ clean text |
| `sessions` (raw turns) | `message::text` (the JSONB cast) | ❌ escaped JSON blob |

`memories.content` and `memory.summary` are dedicated TEXT recall columns. `sessions` is the lone holdout: it has no derived prose column, so recall casts the JSONB at query time. This PRD fixes that asymmetry by adding a `prose` column populated at capture time and redirecting the live lexical (`ILIKE`) recall arm off the JSONB onto `prose` (with a COALESCE fallback for legacy rows).

The native hybrid operator (`deeplake_hybrid_record`) is **out of scope** — PRD-047a evaluated and declined it (see Prior art), and the live engine uses RRF. The unwired reference candidate at `hybrid-recall.ts` is left untouched; whoever re-opens PRD-047a can swap its `textColumn` to `prose` in their own PRD.

### Why both columns are needed

The `message` JSONB and the `prose` TEXT serve different readers and must not be collapsed:

| Column | Readers | What they want |
|---|---|---|
| `message` (JSONB, existing) | `summaries/worker.ts`, `skillify/miner.ts`, `dashboard/roi-session-writer.ts`, `dashboard/api.ts` | The **structured envelope** — typed `{kind, tool, input, response, usage, model}` so they pull values as fields (`event.usage.input_tokens`, `event.model`, `event.tool`), not re-parse text |
| `prose` (TEXT, new) | Recall (`recall.ts`, `hybrid-recall.ts`) + the harness via `memories/api.ts` | A **bounded, harness-ready prose form** for BM25 matching + context injection |

`prose` is a deliberate, lossy, match-ready reduction of the lossless `message` JSONB. The native hybrid operator (`deeplake_hybrid_record`) requires a **stored** text column to match — it cannot match against a parse function computed at read time — so the prose must live on disk. Full structure stays in `message` JSONB for downstream parsers; no information is lost.

---

## Goals

- **Recall's `sessions` arm returns prose, not escaped JSON.** A `Read` tool call surfaces as `Read → hive/src/.../dashboard.tsx:175-250\n// 'healthReasons' is no longer polled...`, not as `{event:{kind,tool,input,response},metadata}`.
- **The live lexical (`ILIKE`) arm matches + returns `prose`, not `message::text`.** This is the production recall path (`recallMemories` in `memories/recall.ts`, wired at `memories/api.ts:545`). The `<#>` cosine semantic arm is untouched — it operates on `message_embedding`, not the text column.
- **Heal-compatible, additive, no destructive migration.** Mirrors PRD-060a's posture exactly: a `TEXT NOT NULL DEFAULT ''` column added to `SESSIONS_COLUMNS`, healed onto legacy tables via the existing `withHeal` / `healColumns` path.
- **Reuse the existing `embedTextFor(event)` extraction pattern.** The capture handler already extracts plain text per event kind for the embedder; the prose extractor follows the same shape (with a bounded `tool_call` format — see 074b).
- **No information loss.** `message` JSONB stays verbatim. Every existing consumer (`summaries/worker.ts`, `skillify/miner.ts`, `dashboard/roi-session-writer.ts`, `dashboard/api.ts`) is unchanged.

## Non-Goals

- **No change to the native `deeplake_hybrid_record` reference candidate.** PRD-047a evaluated the operator live and declined it; ADR-0001 records the decision; RRF is the production posture. The unwired `hybrid-recall.ts` file is left untouched. If PRD-047a is ever re-opened, swapping its `textColumn` to `prose` is that future PRD's call — not this one's.
- **No explicit `CREATE INDEX` DDL.** The lexical arm is a sequential `ILIKE` scan; the codebase has no `CREATE INDEX` against any DeepLake table today, and this PRD adds none.
- **No backfill of legacy rows.** Mirrors PRD-060a: legacy `sessions` rows have empty `prose`; recall falls back to `message::text` for those rows via a `COALESCE(NULLIF(prose, ''), message::text)` projection so old data still matches + returns. New captures populate `prose` going forward.
- **No change to the `message` JSONB or its consumers.** The structured envelope is preserved verbatim; downstream parsers (`summaries/worker.ts`, `skillify/miner.ts`, ROI pricing) are untouched.
- **No change to the other three recall arms.** `memories`, `memory`, and `hive_graph_versions` already return clean TEXT. Only the `sessions` arm is in scope.
- **No change to the capture contract.** The harness POSTs the same `{event, metadata}` shape; the prose is derived daemon-side from the typed `event` after zod validation.
- **No new recall arms, no ranker changes.** The fused-score ranker, recency dampener, and ACT-R activation seams are untouched. Only the source column each `sessions` hit reads from changes.

---

## Code-grounded current state

| # | Fact | Code |
|---|---|---|
| 1 | The lexical `sessions` recall arm returns `message::text AS text` (the full JSONB envelope) | `src/daemon/runtime/memories/recall.ts:380` (the `buildSessionsArmSql` projection), `:382` (the same cast in the `ILIKE` predicate) |
| 2 | The native hybrid `deeplake_hybrid_record` operator exists in tree at `hybrid-recall.ts:135` but is **unwired reference code** — out of scope for this PRD. PRD-047a evaluated and declined it; production uses `recallMemories` (RRF over `<#>` + `ILIKE`). | `src/daemon/runtime/memories/hybrid-recall.ts:135` (zero production callers); decision at `library/requirements/completed/prd-047-retrieval-quality-upgrades/prd-047a-native-hybrid-benchmark.md` |
| 3 | Recall hits are forwarded VERBATIM to the harness — no projection, no truncation | `src/daemon/runtime/memories/api.ts:361-379` (`recallResponse`), serialized at `:583` |
| 4 | The capture handler has the typed `CaptureEvent` available at write time (not just serialized JSON) | `src/daemon/runtime/capture/capture-handler.ts:338` (`buildRow(id, event, metadata, …)` receives the parsed event), `:302-306` (the parse + destructure) |
| 5 | The `message` JSONB is written from a serialized `{event, metadata}` envelope inside `buildRow` | `src/daemon/runtime/capture/capture-handler.ts:564` (`["message", val.text(message)]`), the `message` local at `:552-555` |
| 6 | An existing helper, `embedTextFor(event)`, already extracts plain text per event kind (for the embedder) | `src/daemon/runtime/capture/capture-handler.ts:786-794` (`user_message`/`assistant_message` → `event.text`; `tool_call` → `tool + input + response` joined) |
| 7 | The additive-heal path detects a missing column and adds it via `ALTER TABLE ADD COLUMN`, retrying the write once | `src/daemon/storage/heal.ts:124-154` (`healColumns`), `:286-313` (`withHeal`), `:77-98` (`classifyFailure` routing `column … does not exist` → `missing-column`) |
| 8 | The heal-safety load guard: a `NOT NULL` column without a `DEFAULT` is rejected at module load | `src/daemon/storage/schema.ts:80-100` (`validateColumnDefs`), the `ALTER` renderer at `:160-164` |
| 9 | PRD-060a added five columns (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `source_tool`) to `sessions` via this exact additive-heal path — the proven precedent | `library/requirements/completed/prd-060-roi-tracker/prd-060a-roi-tracker-token-and-cache-usage-capture.md` (header banner L6: "Additive … No destructive migration"; AC a-AC-3/a-AC-4) |
| 10 | The row-to-hit mapper reads the SQL `text` alias, not `message` directly — so the swap is purely in the SQL projection | `src/daemon/runtime/memories/recall.ts` (`rowsToRankedArm`, reads `row.text`) |
| 11 | The `sessions` table is events, not turns — one row per captured event; a turn is reconstructed by `SELECT ... WHERE path = ? ORDER BY creation_date LIMIT MAX_SESSION_TURNS` | `src/daemon/storage/sql.ts:172` (`MAX_SESSION_TURNS = 2000`), `src/daemon/runtime/memories/resolve.ts:218-245` (the turn-reconstruction read) |

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-074a-catalog-write-and-recall`](./prd-074a-catalog-write-and-recall.md) | The catalog column, the capture-handler write, the live lexical (`ILIKE`) recall swap, the legacy-row COALESCE fallback | Draft |
| [`prd-074b-tool-call-prose-format`](./prd-074b-tool-call-prose-format.md) | The `tool_call` prose format design: file-path-aware first line, bounded response cap as a named constant, the no-information-loss argument | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion |
|---|---|
| m-AC-1 | The `sessions` table gains a `prose TEXT NOT NULL DEFAULT ''` column via the additive schema-heal path. A test asserts the heal is additive (no drop/rewrite) and idempotent, mirroring PRD-060a's a-AC-3. |
| m-AC-2 | The lexical `sessions` recall arm (`buildSessionsArmSql`) returns the `prose` column for rows where it is non-empty, and falls back to `message::text` for legacy rows with empty `prose`, via a `COALESCE(NULLIF(prose, ''), message::text)` projection. The `ILIKE` predicate matches the same expression so legacy rows stay matchable. |
| m-AC-3 | The capture handler populates `prose` for every new `sessions` INSERT, derived from the typed `CaptureEvent` (no re-parsing of the serialized JSONB). `user_message` and `assistant_message` events use `event.text` verbatim; `tool_call` events use the format defined in 074b. |
| m-AC-4 | Every existing `message` JSONB consumer (`summaries/worker.ts`, `skillify/miner.ts`, `dashboard/roi-session-writer.ts`, `dashboard/api.ts`) is unchanged and continues to read the structured envelope. |
| m-AC-5 | The `tool_call` prose is bounded by a named, exported constant (`TOOL_PROSE_RESPONSE_CAP`), not a magic number. A `Read` with a 10 KB response yields a prose row at or under the cap; a `Bash` with multi-KB stdout yields a bounded prose row. |
| m-AC-6 | A `user_message` / `assistant_message` event's `prose` is its `event.text` verbatim (no cap, no truncation). |
| m-AC-7 | All existing recall, capture-handler, heal, and dashboard tests remain green. (`hybrid-recall.ts` is untouched — out of scope per Non-Goals — so its tests are unchanged.) |

---

## Open questions

- **The `TOOL_PROSE_RESPONSE_CAP` value (074b).** 500 chars is the proposed default. Real-world tuning wants measurement: capture a representative session corpus, measure the response-size distribution per tool kind, and set the cap to the 90th percentile. 074b ships the constant + the precedent; a follow-up PRD can tune from data.

---

## Out of scope, explicitly

- The `memories`, `memory`, and `hive_graph_versions` recall arms (they already return clean text).
- The capture contract (the `{event, metadata}` POST shape the harness sends).
- The pipeline distillation path (`memories.content` is already TEXT; this PRD is about the RAW `sessions` arm only).
- The dashboard ROI/session-writer rendering (it parses `message` JSONB; unaffected).
- Backfill, retroactive cleanup of legacy rows, or any one-shot migration script.

---

## Prior art

- **PRD-060a** (`library/requirements/completed/prd-060-roi-tracker/prd-060a-roi-tracker-token-and-cache-usage-capture.md`) — the proven precedent for additive columns on `sessions` via the heal path. This PRD mirrors its posture exactly.
- **PRD-003a** (`memories.normalized_content` + `content_hash`) — the architectural precedent for a derived TEXT column alongside a fidelity column. `memories` already does this; `sessions` is the lone holdout this PRD brings into line.
- **PRD-047a** (`library/requirements/completed/prd-047-retrieval-quality-upgrades/prd-047a-native-hybrid-benchmark.md`) + **ADR-0001** (`library/knowledge/private/architecture/adr/0001-retrieval-fusion-rrf-vs-native-hybrid.md`) — the closed decision to keep post-query RRF and decline the native `deeplake_hybrid_record` operator. Critical context: this PRD targets the **live** `recallMemories` engine (RRF + `<#>` + `ILIKE`), NOT the unwired hybrid reference at `hybrid-recall.ts`. The hybrid candidate is left untouched; whoever re-opens PRD-047a can adapt it in their own PRD.

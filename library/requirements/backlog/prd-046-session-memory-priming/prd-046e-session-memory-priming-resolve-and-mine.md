# PRD-046e — Resolve + mine tools (the pull path)

> Status: backlog · Parent: PRD-046 · Wave: W1 · Type: S
> Goal: give the agent the two pull tools the prime points it at — `hivemind_read` that ZOOMS a key
> down the tiers (key → summary → raw), and `hivemind_search` that MINES via hybrid recall — so the
> agent can act on the primed index on any turn.

## Why
The prime (046c/046d) pushes a Tier-1 index; it is only useful if the agent can cheaply expand an
entry or search beyond it. These are the "pull" half of the push/pull design, and they largely exist:
the MCP surface already has `hivemind_read` (read a row) and `hivemind_search` (recall). This slice
adds the **zoom depth** semantics to read and confirms search routes through the RRF recall — no new
retrieval engine.

Critically, resolution is a **SQL join by id/path**, not a search — which is exactly why Deep Lake's
SQL+vector store fits (see `hybrid-sql-vector-rationale.md`). The native `deeplake_hybrid_record`
operator is NOT used (degenerate zero scores, PRD-045a); mining uses the existing post-query RRF.

## What (scope)
- **Resolve depth on `hivemind_read`.** Given a Tier-1 key's id/path, support a `depth`:
  - depth 1 → the Tier-2 row (`memory.summary` or `memories.content`);
  - depth 2 → the Tier-3 raw `sessions` rows for that session (`WHERE path = '<session>'`).
  Each step is a guarded `SELECT … WHERE id/path = …` — a deterministic lookup, not a re-search.
- **Confirm/route mining via `hivemind_search`.** The search tool calls the recall engine
  (`src/daemon/runtime/memories/recall.ts`): hybrid lexical + `<#>` semantic, fused with RRF, with the
  silent lexical fallback preserved. No change to ranking (that is PRD-045's territory).
- **Tenancy.** Every resolve/search rides the org/workspace/agent scope, same as all recall today.

## Acceptance criteria
- **e-AC-1 — Zoom resolves exactly.** `hivemind_read(key, depth=1)` returns the Tier-2 summary for that
  key; `depth=2` returns the Tier-3 raw turns for that session. Each is a single guarded SQL lookup by
  id/path (asserted: no recall/search SQL issued at resolve time). Unit-tested against fake storage.
- **e-AC-2 — Resolve is fail-soft.** A missing summary/session (eventual consistency, deleted row)
  resolves to an empty/honest result, never a 500. Unit-tested.
- **e-AC-3 — Mining routes through RRF recall.** `hivemind_search(query)` returns the hybrid recall
  result (lexical + semantic, RRF-fused) with `degraded` honest when embeddings are off. Unit-tested;
  no native hybrid operator path.
- **e-AC-4 — Scoped + guarded.** Every statement routes through the SQL guards
  (`sqlIdent`/`sLiteral`/`sqlLike`) and the per-request scope. `audit:sql` clean; gates green.

## Risks / Out of scope
- **Risk — resolve fanning out.** A depth-2 resolve could pull a large raw session. Bound it (a turn
  limit / pagination) so a zoom never dumps an unbounded transcript into context.
- **Out of scope — ranking/rerank/dedup of recall** (PRD-045b/c), **the prime assembly** (046c), **the
  hooks** (046d).

## Dependencies
- The MCP server (`hivemind_read` / `hivemind_search`) and the read path it already exposes.
- The recall engine (`recall.ts`) for mining; the `memory` / `memories` / `sessions` tables for resolve.
- **046b** for the keys whose ids the resolve walks.

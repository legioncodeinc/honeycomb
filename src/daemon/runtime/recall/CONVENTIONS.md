# Recall — CONVENTIONS (PRD-007, de-scoped per PRD-045b)

The modules under `src/daemon/runtime/recall/` are daemon-only (the storage path
lives only in the daemon bundle). What remains here after the **PRD-045b de-scope**
is the part that is actually live: **007a candidate collection** (reused by the VFS
browse seam), the **recall config**, the **cross-phase contracts**, and the
**`buildScopeClause` authorization chokepoint**.

## PRD-045b de-scope — what was removed and why

The five-phase `RecallEngine` orchestrator (`collect → traverse → authorize → shape
→ gate`) and its four phase modules (`engine.ts`, `traversal.ts`, `authorization.ts`,
`shaping.ts`, `gate.ts`) were **removed**. They had **zero production callers**: live
recall is `recallMemories` (lexical UNION-ALL + semantic `<#>` RRF, with an honest
`degraded` flag) in `src/daemon/runtime/memories/recall.ts`, reached from
`POST /api/memories/recall` (`memories/api.ts`). The engineered currentness
downweighting was redundant with the append-only highest-version + `is_deleted`
model on the live recall tables and PRD-008 supersession-on-read of
`entity_attributes`; the confidence gate had no consumer (every surface — MCP
`memory_search`/`hivemind_search`, the SDK `recall()`, the dashboard, the CLI — wants
raw ranked recall, not an inject/empty decision). See
`library/requirements/in-work/prd-045-daemon-wiring-closeout/prd-045b-daemon-wiring-closeout-retrieval-engine.md`.

## What remains (the live surface)

| File | What it owns | Live consumer |
|---|---|---|
| `collection.ts` | 007a — the FTS + vector + hint channels + merge (`collectCandidates`). | `vfs/api.ts` (the `/memory` browse seam). |
| `config.ts` | The recall config (zod): over-fetch, hint cap, channel limit, reranker/dampening knobs, etc. | `collection.ts` / `vfs/api.ts`. |
| `contracts.ts` | `Candidate`, `CandidateScores`, `MergedPool`, `RecallQuery`/`RecallScope`/`CallerFilters`, `RecallChannel`, `RecallLogger`, `mergeChannels`, `bestScore`. The cross-phase shapes. | `collection.ts` / `vfs/api.ts`. |
| `scope-clause.ts` | `buildScopeClause` — THE authorization chokepoint. The three read policies. | Retained as the canonical scope-clause builder; asserted by the PRD-011a/011e suites + the live `recall-authz-live.itest.ts`. |

> Note: some config knobs (`reranker.*`, `dampening.*`, `minInjectionScore`,
> `traversal.*`, `graphEnabled`) were tuning inputs for the removed phases. They are
> kept in `config.ts` as inert, documented defaults rather than churned out — `config.ts`
> is the single config surface and a later pass may prune the now-unused knobs.

## The ScopeClauseBuilder (retained chokepoint)

`buildScopeClause({ agentId, readPolicy, policyGroup, groupAgentIds, org, workspace })`
returns a `ScopeClause { sql, values, policyApplied, error? }`:

- `isolated` → `agent_id = '<self>'`
- `shared` → `visibility = 'global' OR agent_id = '<self>'`
- `group` → `(visibility='global' AND agent_id IN (<resolved members>)) OR agent_id = '<self>'`
- ALL exclude archived (`is_deleted = 0`).
- A malformed/missing agent id OR an unknown policy → the `isolated` fragment +
  a structured `error` (fail-closed, NEVER wider).
- `group` resolves its member ids off the `agents` roster — the caller resolves
  membership and passes `groupAgentIds`; the builder renders what it is given. No
  members → degrades to own-only (fail-closed).

The `sql` is a parenthesized WHERE fragment (no leading `WHERE`/`AND`); a caller ANDs
it into its statement and runs under the partition `scope`. It is the single scope
chokepoint — a scoping review is a search for `buildScopeClause`, not an audit of
hand-written WHEREs. (As of PRD-045b the live recall path is `recallMemories`, which
runs under the storage-partition `QueryScope`; the agent-level read-policy clause is
the chokepoint reused by browse/tenancy proofs.)

## SQL safety

SQL is built via the 002b helpers (`sqlStr`/`sqlLike`/`sqlIdent`/`sLiteral`/
`eLiteral`) + the 002e vector builders. NEVER hand-quote a value. `audit:sql` scans
`src/daemon`.

## The hint source seam (007a)

`collection.ts` reads a `HintSource` (`emptyHintSource` by default). Prospective
hints are not written yet (PRD-006 D-2 deferred them). When the writer lands, it
implements `HintSource.match(query) → ScoredId[]`; collection caps the result at
`config.hintCap` (D-2: ≤3) so the hint channel can never dominate.

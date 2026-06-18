# Recall engine — CONVENTIONS (PRD-007)

The five-phase recall engine lives under `src/daemon/runtime/recall/` (daemon-only;
the storage path lives only in the daemon bundle). Wave 1 built the shared scaffold
+ the ScopeClauseBuilder + 007a collection + the recall-engine harness, and
pre-wired four phase stubs. Wave 2's four Bees each fill ONE phase module + test.

This file is the contract Wave 2 follows. Read it before filling a phase.

## The flow

```
collect (007a) → traverse (007b) → authorize (007c) → shape (007d) → gate (007e)
```

Up to and through **authorization, only IDs move** (`Candidate` carries an `id`,
per-channel `scores`, `provenance` — never content). Content is hydrated ONLY in
the gate (007e), strictly on the authorized set, under the same scope clause.

## Shared files — DO NOT TOUCH (Wave-1 surface)

| File | What it owns |
|---|---|
| `config.ts` | The recall config (zod): over-fetch, hint cap, traversal budgets, reranker, dampening, min injection score, graph gate. Defaults. A new knob is added HERE in Wave 1, never read off env in a phase. |
| `contracts.ts` | `Candidate`, `CandidateScores`, `MergedPool`, `RecallQuery`/`RecallScope`/`CallerFilters`, `RecallChannel`, `mergeChannels`. The cross-phase shapes. |
| `scope-clause.ts` | `buildScopeClause` — THE authorization chokepoint. The three read policies. Reused everywhere a memory query is issued. |
| `engine.ts` | The harness: `RecallEngine`, `createRecallEngine`, `RecallPhaseDeps`, `ChannelResult`, `RecallPhases`. The phase registration. |
| `collection.ts` | 007a — FILLED. The FTS + vector + hint channels + merge. |

A Wave-2 phase ADDS its own module + test; it does NOT edit any shared file. A
genuinely new cross-phase field is a Wave-1 change (raise it), not a phase edit.

## The phase signature + engine registration

Every Wave-2 phase is a function injected into `createRecallEngine({ phases })`.
The harness defaults each to its no-op, so an un-filled engine runs inertly.

```ts
// 007b
export type TraversalPhase   = (query, deps: RecallPhaseDeps) => Promise<ChannelResult>;
// 007c (THE boundary)
export type AuthorizationPhase = (pool: MergedPool, query, deps) => Promise<AuthorizedPool>;
// 007d
export type ShapingPhase     = (pool: AuthorizedPool, query, deps) => Promise<ShapedPool>;
// 007e
export type GatePhase        = (pool: ShapedPool, query, deps) => Promise<RecallResult>;
```

Register the filled phase by passing it:

```ts
const engine = createRecallEngine({
  storage, scope, config, embed, logger,
  phases: { traversal, authorization, shaping, gate },
});
```

The harness wiring in `engine.ts` does not change when you fill a phase — it
already routes through the module's exported phase, defaulting to the no-op.

## How each phase reaches storage / catalog / embed / config

Every phase receives `RecallPhaseDeps`:

- `deps.storage` — the `StorageQuery` client. **Never a raw fetch.** Every query
  runs through `storage.query(sql, scope)`. `audit:sql` scans `src/daemon`.
- `deps.scope` — the `{ org, workspace }` partition (the OUTER scope ring, enforced
  at the storage layer beneath any inner clause).
- `deps.config` — the resolved `RecallConfig` (every knob; never read env).
- `deps.embed` — the 005b `EmbedClient` (the query-vector seam; absent/null →
  vector skipped, lexical degrade).
- `deps.logger` — optional structured-log sink.

SQL is built via the 002b helpers (`sqlStr`/`sqlLike`/`sqlIdent`/`sLiteral`/
`eLiteral`) + the 002e vector builders (`buildVectorSearchSql`,
`buildLexicalDegradeSql`) + the catalog graph helpers. NEVER hand-quote a value.

## The ScopeClauseBuilder you reuse (007c, 007e, VFS browse)

`buildScopeClause({ agentId, readPolicy, policyGroup, groupAgentIds, org, workspace })`
returns a `ScopeClause { sql, values, policyApplied, error? }`:

- `isolated` → `agent_id = '<self>'`
- `shared` → `visibility = 'global' OR agent_id = '<self>'`
- `group` → `(visibility='global' AND agent_id IN (<resolved members>)) OR agent_id = '<self>'`
- ALL exclude archived (`is_deleted = 0`).
- A malformed/missing agent id OR an unknown policy → the `isolated` fragment +
  a structured `error` (fail-closed, NEVER wider).
- `group` resolves its member ids off the `agents` roster — **the caller (007c)
  resolves membership and passes `groupAgentIds`**; the builder renders what it is
  given. No members → degrades to own-only (fail-closed).

The `sql` is a parenthesized WHERE fragment (no leading `WHERE`/`AND`); the caller
ANDs it into its statement and runs under the partition `scope`. **007c re-queries
with it; 007e re-applies the SAME compiled clause when it hydrates (e-AC-4); the VFS
browse path reuses it (c-AC-7).** It is the single chokepoint — a scoping review is
a search for `buildScopeClause`, not an audit of hand-written WHEREs.

## Where each Wave-2 phase writes

| Phase | Module | Test |
|---|---|---|
| 007b traversal | `recall/traversal.ts` | `tests/daemon/runtime/recall/traversal.test.ts` |
| 007c authorization | `recall/authorization.ts` | `tests/daemon/runtime/recall/authorization.test.ts` (adversarial) |
| 007d shaping | `recall/shaping.ts` | `tests/daemon/runtime/recall/shaping.test.ts` |
| 007e gate | `recall/gate.ts` | `tests/daemon/runtime/recall/gate.test.ts` |

Each test is named after the AC it proves (one-to-one ledger map). No `.skip` /
`.only`; `vitest run` is CI. Drive a FAKE transport (assert the emitted scoped SQL
+ escaping + IDs-only) and a FAKE embed where the vector path is involved. 007c
additionally gets an opt-in LIVE re-query test (gated, throwaway table).

## The hint source seam (007a, for the future prospective-hints writer)

`collection.ts` reads a `HintSource` (`emptyHintSource` by default). Prospective
hints are not written yet (PRD-006 D-2 deferred them). When the writer lands, it
implements `HintSource.match(query) → ScoredId[]`; collection caps the result at
`config.hintCap` (D-2: ≤3) so the hint channel can never dominate.

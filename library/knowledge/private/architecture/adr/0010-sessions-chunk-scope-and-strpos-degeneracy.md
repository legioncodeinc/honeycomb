# ADR-0010, `sessions_chunk` follows `sessions` scope; record `STRPOS`/`POSITION` degeneracy in `pg_deeplake`

> **Status:** Proposed · **Date:** 2026-07-05
> **Supersedes:** none · **Superseded by:** none
> **Owners:** retrieval, typescript-node · **Related:** PRD-074 (the prose column), PRD-047a / ADR-0001 (RRF over native hybrid — the "operator executes but is broken" precedent), ADR-0009 (in-tree chunker), the planned PRD-075 (window-on-match) and PRD-076 (capture-time chunking)

This ADR records TWO distinct decisions grounded in the same recon pass. They share an ADR because both surfaced while scoping PRD-076's `sessions_chunk` table and both block PRD-075/076 design choices.

1. **Decision 1 (the architectural fork).** PRD-076's planned `sessions_chunk` table must pick a scope. Its two chunk-adjacent neighbors disagree: `sessions` is `scope: "agent"` (engine-partitioned, no `org_id`/`workspace_id`), while `document_chunk` is `scope: "tenant"` (explicit `org_id`/`workspace_id`). This ADR records which side `sessions_chunk` lands on and why.
2. **Decision 2 (the empirical finding).** `pg_deeplake` accepts `STRPOS` / `POSITION` syntactically but executes them as a no-op returning `0` for every row. Recorded as fact so the next person does not spend a day rediscovering it. The downstream decision (window-on-match must be a TypeScript-side `indexOf`) follows directly.

## Context

### The architectural fork (Decision 1)

PRD-076 needs a `sessions_chunk` table — one row per chunk of a `sessions` event, mirroring how `document_chunk` relates to `memory_artifacts` and how `memories.normalized_content` already distills one row per fact. ADR-0009 already settled that the chunker is built in-tree and that the chunk schema "mirrors `document_chunk`." What ADR-0009 did NOT settle — and could not, because it was scoped to the chunker, not the catalog — is **which scope `sessions_chunk` inherits.** The two neighboring chunk tables point in opposite directions.

**`sessions` is an engine table.** Per `src/daemon/storage/catalog/sessions-summaries.ts:137` it is declared `scope: "agent"`, and per `sessions-summaries.ts:36-85` its column list carries `agent_id` + `visibility` but NO `org_id` and NO `workspace_id`. The file-level doc is explicit (`sessions-summaries.ts:20-21`): "both are engine tables → `agent_id` + `visibility`; org/workspace isolation comes from the storage partition layer." The partition layer is the pg-transport's per-workspace Postgres schema: `src/daemon/storage/pg-transport.ts:14` ("puts each workspace in its own Postgres schema") and `pg-transport.ts:156` (`SET search_path TO <workspace>, public` on every checkout). The transport forwards `req.sql` verbatim (`pg-transport.ts:15`); isolation is the schema, not a WHERE clause.

**`document_chunk` is a tenant table.** Per `src/daemon/storage/catalog/sources.ts:261` it is declared `scope: "tenant"`, and per `sources.ts:221-238` its `DOCUMENT_CHUNK_COLUMNS` carries explicit `org_id` + `workspace_id` (`sources.ts:225-226`). The sources-file doc block (`sources.ts:60-67`) states the rationale: a source is mounted into a specific org + workspace, the provenance/purge boundary is the `(org, workspace, source_id)` tuple, and the explicit columns let a purge and a health scan filter to exactly one source's footprint.

**The scope contract is enforced at the type level.** `src/daemon/storage/catalog/types.ts:74` declares `CatalogScope = "agent" | "tenant" | "none"`, and `types.ts:62-72` documents the load-bearing rule: `agent` → carry `agent_id` + `visibility`; `tenant` → carry explicit `org_id` + `workspace_id`; `none` → transitively scoped append-only audit/history. The `defineGroup`/`defineTable` validators (`types.ts:107-122`) run at module load, so a mismatched scope/columns pair fails the import, never a production write.

### The empirical finding (Decision 2)

While scoping PRD-075 (window-on-match in `proseForToolCall`) it was natural to ask whether the term-offset extraction could run SQL-side via `STRPOS`, avoiding a TypeScript-side `indexOf` over the returned prose. A live query against the real DeepLake DB (1,058 rows in `sessions`) returned:

```
SELECT STRPOS(message::text, 'the') AS pos, LEFT(message::text, 60) AS head FROM sessions LIMIT 3
→ [{"pos": 0, "head": "{\"event\": {\"kind\": \"user_message\", \"text\": \"Alrigh..."}]
```

`STRPOS` returns `0` for every row, including rows whose text demonstrably contains the search term. `POSITION(... IN ...)` behaves identically. The `pg_deeplake` extension accepts these standard Postgres string-position functions syntactically (no parse error, no execution error) but does NOT implement them — every call returns the degenerate constant zero. This is the same broken-operator shape PRD-047a / ADR-0001 found with `deeplake_hybrid_record` (ADR-0001, table at line 30: "Operator returned a degenerate constant-zero score → random ordering. Broken."), and the same shape ADR-0001 called out as a class risk at line 64 ("re-couples ranking to an opaque operator that just spent months silently broken").

## Decision drivers

- **Scope inheritance discipline.** A chunk row's isolation boundary should match its parent event's isolation boundary. If `sessions` is engine-partitioned, its chunks must be engine-partitioned too; otherwise the chunk layer reintroduces a tenancy axis the parent row never carried.
- **Denormalization drift risk.** Adding explicit `org_id`/`workspace_id` to `sessions_chunk` while `sessions` carries neither creates two sources of truth for the same fact (the parent row's actual workspace, vs. the chunk row's denormalized copy). They can and will drift — a chunk written under workspace A while the parent event was captured under workspace B is a silent cross-tenant leak waiting to happen.
- **The D-2 scope contract.** `types.ts:62-72` makes scope a strict, load-validated contract, not a comment. The choice propagates into which columns the table MUST carry and which partition path it rides.
- **Prior art for engine-scoped derived rows.** The codebase-graph group (`knowledge-graph.ts:266-316`) already sets the precedent: derived, chunk-shaped rows that decompose engine-scoped parents (entities, entity_attributes with `content_embedding`, epistemic_assertions with `content_embedding`) are ALL `scope: "agent"`.
- **PRD-075 latency budget.** Window-on-match is a read-time fast-follow; it must not add a round-trip or depend on engine behavior that is empirically unreliable.
- **Reversibility.** A `scope` choice baked into a `USING deeplake` table is a schema event — expensive to reverse once chunks land. The finding about `STRPOS` is cheap to act on (use TS-side `indexOf`); the cost is rediscovery if it goes unrecorded.

## Grounding: the two chunk-adjacent tables, side by side

| Aspect | `sessions` | `document_chunk` |
|---|---|---|
| Scope declaration | `scope: "agent"` (`sessions-summaries.ts:137`) | `scope: "tenant"` (`sources.ts:261`) |
| Tenancy columns | `agent_id`, `visibility` (`sessions-summaries.ts:51-52`) | `org_id`, `workspace_id` (`sources.ts:225-226`) |
| Isolation mechanism | pg-transport per-workspace schema + `search_path` (`pg-transport.ts:14`, `:156`) | explicit columns + partition layer |
| Write pattern | `append-only` (`sessions-summaries.ts:135`) | `version-bumped` (`sources.ts:259`) |
| Stated rationale | "engine tables … org/workspace isolation comes from the storage partition layer" (`sessions-summaries.ts:20-21`) | "the provenance/purge boundary is the `(org, workspace, source_id)` tuple" (`sources.ts:62-67`) |

The disagreement is not an accident. `document_chunk` is tenant-scoped because a *source* is a tenant-mounted artifact whose purge boundary is `(org, workspace, source_id)`. `sessions` is engine-scoped because a *captured event* is an engine emission whose isolation boundary is the workspace partition the pg-transport lands it in. These are two different isolation models for two different data shapes. The question is which model a `sessions` *chunk* inherits — and the answer is determined entirely by its parent.

## Considered options

### Option A — `sessions_chunk` follows `sessions`: `scope: "agent"`, no `org_id`/`workspace_id` (CHOSEN)

`sessions_chunk` carries `agent_id` + `visibility` (mirroring `sessions`) and relies on the pg-transport per-workspace schema for org/workspace isolation. It inherits the parent event's isolation boundary exactly.

- **For:** scope inheritance is honest — a chunk row's workspace IS its parent event's workspace, full stop. No denormalization, no drift surface, no second source of truth for tenancy. Matches the `types.ts:62-72` contract for `agent` scope (carry `agent_id` + `visibility`, partition does the rest). Matches the codebase-graph precedent (`knowledge-graph.ts:272-314`) where every derived chunk-shaped row under engine-scoped parents is itself `scope: "agent"`.
- **Against:** a chunk-purge-by-org-or-workspace scan cannot filter on a chunk-level column — it must join to `sessions` (or rely on the partition already isolating it). For `sessions_chunk` this is fine because the partition layer already isolates the chunk table per workspace exactly as it isolates `sessions`; there is no cross-workspace chunk table to filter.
- **Verdict: accepted.** See Decision.

### Option B — `sessions_chunk` follows `document_chunk`: `scope: "tenant"`, explicit `org_id`/`workspace_id`

Carry explicit `org_id` + `workspace_id` on `sessions_chunk` to mirror the `document_chunk` shape ADR-0009 said PRD-076 "mirrors."

- **For:** structural symmetry with the other chunk table; a future cross-workspace admin query could filter chunks directly.
- **Against:** reintroduces a tenancy axis the parent `sessions` row does not carry. The chunk's `org_id`/`workspace_id` would have to be populated by the writer from somewhere other than the parent row (the request context, the transport's notion of the active workspace), creating a denormalization that can drift from the partition the row actually lands in. Violates the D-2 contract asymmetrically: a `tenant`-scoped child of an `agent`-scoped parent is a category error — `types.ts:62-72` ties scope to which columns MUST be present, and a chunk inheriting engine semantics should not carry tenant columns it does not need. The ADR-0009 "mirror `document_chunk`" guidance was about the *chunk-shape* columns (`ordinal`, `content_hash`, nullable embedding, `metadata` bounds, version-bump lifecycle) — none of which are the scope columns. Mirroring the provenance + content shape does not imply mirroring the tenancy model of a different data class.
- **Verdict: rejected.** Structural symmetry is not a sufficient reason to create a denormalization-drift surface that the parent table does not have.

### Option C — `scope: "none"`, transitively scoped via a `session_id` FK (like `memory_history`/`memory_jobs`)

Treat `sessions_chunk` as an audit-style table scoped transitively by its parent row, the way `memory_jobs` and `routing-history` are `scope: "none"`.

- **For:** minimal column surface.
- **Against:** `scope: "none"` is for daemon-internal control-plane tables (queue, router) — `types.ts:71-73`: "an append-only audit/history table scoped transitively by the row it references." A chunk is a *recall-eligible memory row* carrying a `FLOAT4[768]` embedding and ranked by recall, not a daemon-internal control row. It must participate in the recall path's partition isolation exactly as `sessions` does, which means it must be `agent`-scoped, not `none`.
- **Verdict: rejected.** Wrong category — `none` is for control plane, not recall-eligible memory.

## Decision

### Decision 1 — `sessions_chunk` is `scope: "agent"` (follows `sessions`)

**`sessions_chunk` follows `sessions`, not `document_chunk`.** Concretely, for PRD-076:

1. **Scope declaration.** `sessions_chunk` is declared `scope: "agent"` in the catalog, mirroring `sessions` (`sessions-summaries.ts:137`). It carries `agent_id` + `visibility` and carries NO `org_id` and NO `workspace_id` column. Org/workspace isolation comes from the pg-transport's per-workspace Postgres schema (`pg-transport.ts:14`, `:156`), exactly as it does for `sessions`.

2. **Inherit the chunk-shape columns from `document_chunk`, not the scope columns.** ADR-0009's "mirror `document_chunk`" guidance applies to the provenance-and-content shape — `ordinal`, `content_hash`, nullable `chunk_embedding`, `metadata` JSONB for line/char bounds, version-bump lifecycle — NOT to the tenancy model. The chunk-shape columns are orthogonal to scope; the scope is inherited from the parent event.

3. **The chunk's parent FK is `session_id`** (the `sessions.id` the chunk decomposes), playing the role `artifact_id` plays on `document_chunk` (`sources.ts:223`). A purge of a session's chunks is `DELETE/scoped-sweep WHERE session_id = ?` inside the already-isolated workspace partition — no tenancy column needed.

4. **The engine-vs-tenant scope discipline (deeplake-dataset-stinger Hard Rule 6 and `types.ts` D-2) is upheld.** Hard Rule 6 ("JSONB is a column type, not a schema escape hatch") generalizes: scope columns are a typed contract, not a belt-and-suspenders copy. Adding tenant columns to an engine-scoped child "just to be safe" is the same anti-pattern as promoting a JSONB field to a column that nobody queries — it creates a surface that can drift. The right scope is the parent's scope.

5. **Status flips to `Accepted` when PRD-076 ships the `sessions_chunk` table per this decision.** Until then it stays `Proposed`, and per the Stinger's status-lifecycle rule no code or other ADR references it as if it were closed.

### Decision 2 — `STRPOS`/`POSITION` are degenerate in `pg_deeplake`; record as fact

**`pg_deeplake`'s `STRPOS(text, substr)` and `POSITION(substr IN text)` execute but return `0` for every row, regardless of whether the substring is present.** Recorded as fact, not as a decision — the decision follows directly.

The downstream consequence for PRD-075 (window-on-match): **the match-position extraction MUST be a TypeScript-side `String.prototype.indexOf` over the returned prose, NOT a SQL-side `STRPOS`/`POSITION`.** Attempting to push the position computation into the SQL layer yields a constant-zero result and an invisible-file bug (the window slices to offset 0 every time, exactly the failure mode PRD-075 exists to fix).

This finding joins the same class as PRD-047a / ADR-0001's `deeplake_hybrid_record` finding: a standard Postgres operator that the `pg_deeplake` extension accepts syntactically but does not implement, returning degenerate output and never throwing. The pattern is now documented twice (hybrid scoring, string position). Future engine-side computations over `pg_deeplake` should assume standard Postgres string/position/scoring functions are absent until proven present by a live probe.

## Consequences

**Positive:**

- **Decision 1 keeps the isolation model honest.** A `sessions_chunk` row's workspace is exactly its parent `sessions` row's workspace — no denormalized copy, no drift surface. The partition layer that isolates `sessions` isolates the chunks for free.
- **Decision 1 upholds the D-2 scope contract.** An `agent`-scoped parent has `agent`-scoped children; the `types.ts:62-72` column requirements stay consistent up and down the inheritance chain.
- **Decision 1 matches established prior art.** The codebase-graph group already runs seven `scope: "agent"` derived/chunk-shaped tables (`knowledge-graph.ts:272-314`), two of them carrying `content_embedding` and ranked by recall — `sessions_chunk` is the same shape.
- **Decision 2 prevents a class of invisible-file bug.** PRD-075 will not ship a SQL-side `STRPOS` window computation that silently returns offset 0; the TS-side `indexOf` path is decided before code is written.
- **Decision 2 generalizes a known engine risk.** Two independent `pg_deeplake` operators are now documented as accept-but-degenerate; future design work can budget for a live probe rather than discovering the gap at integration time.

**Negative / accepted:**

- **Decision 1 forgoes chunk-level cross-workspace admin queries.** A purge or audit that wants to filter chunks across workspaces in one statement cannot — it must hit each workspace partition (which is what the per-workspace schema model already enforces for every engine table). For `sessions_chunk` this is the correct trade, not a real loss.
- **Decision 1 means the chunk-shape columns come from one neighbor (`document_chunk`) and the scope from another (`sessions`).** A future reader who scans only `document_chunk` for the chunk shape and assumes the scope comes with it will reach the wrong conclusion. Mitigation: this ADR exists, the catalog declaration is the single source of truth, and `defineTable` validates at module load.
- **Decision 2 closes the door on a SQL-side optimization.** If a future `pg_deeplake` release implements `STRPOS`/`POSITION` correctly, the TS-side `indexOf` path remains (it is cheap, correct, and operates over already-fetched prose — no extra round-trip). The decision is not painful to live with even after the engine catches up.

**Neutral:**

- The `pg_deeplake` extension's coverage of standard Postgres string/scoring functions is an Activeloop-owned surface; this ADR records the empirical state as of 2026-07-05 against DB revision with 1,058 `sessions` rows. It is not a contract — re-probe on any extension upgrade.

## Revisit triggers

Re-open Decision 1 if ANY of these holds:

1. **`sessions` itself ever moves to `scope: "tenant"`.** If the parent table gains explicit `org_id`/`workspace_id`, `sessions_chunk` must follow it (the inheritance rule in this ADR is symmetric). Do not leave a chunk table engine-scoped under a tenant-scoped parent.
2. **A real cross-workspace chunk admin query emerges** (e.g. a fleet-wide dedup scan across all workspaces in one statement) AND the per-workspace partition iteration cost is provably a problem. That is the only case where chunk-level tenant columns pay for themselves, and it would re-open Option B.
3. **The recall path moves to a single cross-workspace `sessions_chunk` table** (abandoning per-workspace partition isolation for chunks). That is a deeper architectural change that would supersede this ADR entirely, not amend it.

Re-open Decision 2 (or rather, re-probe) if:

1. **A `pg_deeplake` extension upgrade ships.** Re-run the `SELECT STRPOS(message::text, 'the') ... LIMIT 3` probe; if it returns non-zero for rows that contain the term, the operator has been implemented and PRD-075 *may* revisit a SQL-side window computation (though the TS-side path is likely still preferable for round-trip reasons).
2. **A second standard Postgres operator is suspected degenerate.** Add it here; this ADR is the running log of accept-but-broken `pg_deeplake` operators.

## Links

- **ADR-0001** (`library/knowledge/private/architecture/adr/0001-retrieval-fusion-rrf-vs-native-hybrid.md`) — the precedent for the "operator executes but returns degenerate output" finding shape (`deeplake_hybrid_record`, line 30 and line 64).
- **ADR-0009** (`library/knowledge/private/architecture/adr/0009-sessions-recall-chunking-strategy.md`, branch `adr-0009-sessions-chunking-strategy`) — the in-tree chunker decision. Its "mirror `document_chunk`" guidance is about chunk-shape columns; this ADR settles the orthogonal scope question ADR-0009 explicitly deferred.
- **PRD-074** (`library/requirements/backlog/prd-074-sessions-prose-column/`) — the prose column that surfaced the chunking gap.
- **Planned PRD-075** (read-time window-on-match + `matchRange`) — gated by Decision 2: window position extraction is TS-side `indexOf`, never SQL-side `STRPOS`.
- **Planned PRD-076** (capture-time chunking) — gated by Decision 1: `sessions_chunk` is `scope: "agent"`, no `org_id`/`workspace_id`.
- **`src/daemon/storage/catalog/sessions-summaries.ts:36-85`** — `SESSIONS_COLUMNS`, the engine-scoped parent table (no org/workspace cols).
- **`src/daemon/storage/catalog/sessions-summaries.ts:137`** — `sessions` declared `scope: "agent"`.
- **`src/daemon/storage/catalog/sources.ts:221-238`** — `DOCUMENT_CHUNK_COLUMNS`, the tenant-scoped chunk table with `org_id`/`workspace_id` at `:225-226`.
- **`src/daemon/storage/catalog/sources.ts:261`** — `document_chunk` declared `scope: "tenant"`.
- **`src/daemon/storage/catalog/sources.ts:60-67`** — the stated rationale for tenant scope on source-derived rows (the `(org, workspace, source_id)` purge boundary).
- **`src/daemon/storage/catalog/types.ts:62-74`** — the D-2 `CatalogScope` contract (`agent` / `tenant` / `none` and the columns each requires).
- **`src/daemon/storage/catalog/types.ts:107-122`** — `defineTable` / `defineGroup`, the load-time validators that enforce the scope/columns contract.
- **`src/daemon/storage/catalog/knowledge-graph.ts:266-316`** — the codebase-graph group, seven `scope: "agent"` derived/chunk-shaped tables (the engine-scoped-children precedent).
- **`src/daemon/storage/pg-transport.ts:14`** and **`:156`** — the per-workspace Postgres schema + `SET search_path` partition mechanism that isolates engine tables.

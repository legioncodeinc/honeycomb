# Sources conventions (PRD-013) — READ BEFORE FILLING A WAVE-2 STUB

Wave 1 (013a) established these. Wave 2 (013b ‖ 013c ‖ 013d ‖ 013e) follows them
**verbatim**. The whole point of the seam wiring is that a Wave-2 Bee edits **only
its own module + its own test file** and never touches the contract, the lifecycle
engine, the catalog, or `server.ts`.

---

## 1. The thesis (every rule descends from this)

- **A source is READ-ONLY evidence.** A provider READS an external knowledge base;
  it NEVER writes back. **The source files are NEVER modified.** Purge touches only
  the store.
- **Every derived row carries PROVENANCE** — the quartet (`source_id`/`source_kind`/
  `source_path`/`source_root`) + scope (`org_id`/`workspace_id`). A source hit traces
  back to the vault/channel/repo, and a purge is a clean scoped sweep by `source_id`
  (D-1 / a-AC-3).
- **A partial failure is a DATA POINT, not a deletion.** A provider emits a
  `SourceArtifact` with a `failure` marker; the lifecycle writes it as a FAILURE
  ARTIFACT (`status: 'failure'`) **alongside** existing rows and reports it — it
  **never deletes an existing row** (D-4 / a-AC-7).

## 2. Append-only soft-delete via STATUS ADVANCE — the non-negotiable mechanic

**a-AC-4 LITERALLY requires "status advance, not in-place UPDATE."** Every removal —
a removed/renamed file (`updateInPlace`), a disconnect purge (`purge`), a document
delete (013b `remove`) — is a STATUS ADVANCE:

> read the row's CURRENT (highest-version) state → APPEND a NEW version with the
> SAME `id`, the prior `version` + 1, and `status` advanced to `deleted`, every
> other column copied forward INTACT.

This is an **INSERT, never an in-place UPDATE, never a hard DELETE**. The reasons are
the same ones `memory_jobs`, `pipeline/graph-persist.ts`, `ontology/supersede.ts`,
and `pipeline/retention.ts` all hit and solved live:

- An **in-place UPDATE** on this backend coalesces rapid writes and serves reads from
  segments of differing freshness that flap non-monotonically — a by-id `SET` can
  never converge.
- A **hard DELETE** can leave rows on disk (PRD-004 / PRD-006e D-8).

`SourceArtifactStore` (in `lifecycle.ts`) is the live-correct core: deterministic ids
(sha256 incl. `source_id`), version-bumped appends, **poll-convergent** highest-
version reads (`resolveCurrent`), and **poll-and-union** multi-row scans
(`scanIdsForSource`). A row's current state is its highest-version row. **Do not add
an in-place UPDATE or a per-row DELETE anywhere in this subsystem.**

## 3. Deterministic ids → a clean scoped purge (D-1)

Every artifact / chunk / link id is a sha256 that **includes the `source_id`**
(`artifactId`, `chunkId`, `linkId`, `documentIdForUrl`). So a re-index resolves the
SAME id (idempotent — no duplicate rows) and a purge selects EVERY row a source
produced by its `source_id` and **nothing else** (another source's rows remain —
a-AC-2). Never derive an id without the `source_id` in the material.

## 4. The catalog is final (`catalog/sources.ts`)

`memory_artifacts`, `document_memories`, `document_chunk` are all
`pattern: "version-bumped"`, `scope: "tenant"` (explicit `org_id` + `workspace_id`).
`chunk_embedding` is the nullable 768-dim `FLOAT4[]` (index AC-4) — NULL by design so
recall degrades to lexical when embedding is off/fails (fail-soft, b-AC-2). The graph
tables got the **additive** provenance quartet (`knowledge-graph.ts`,
`GRAPH_SOURCE_PROVENANCE_*`) so source-derived graph rows are purgeable by
`source_id`. **Wave 2 does not change a column** — the columns are single-sourced and
final.

## 5. SQL safety (FR-4 / a-AC-7)

Every dynamic fragment routes through the 002b helpers: `sqlIdent` (identifiers),
`sLiteral` / `eLiteral` (values via the `val.*` constructors). The lifecycle never
hand-quotes a value, and every append goes through the heal-aware `appendOnlyInsert`
(→ guarded `buildInsert`). `npm run audit:sql` scans `src/daemon` and fails CI on a
raw interpolation. A new query helper follows the same rule.

## 6. Lazy table create (D-5 / a-AC-5)

The first write to a non-existent table heals (CREATE-from-ColumnDef) via the 002d
write primitives' `withHeal` wrapper — **no prior migration**. A new source kind just
writes; the table appears on first index.

## 7. Where each Wave-2 Bee writes

| Sub-PRD | Module (edit this) | Test file (edit this) | Must NOT touch |
|---------|--------------------|-----------------------|----------------|
| 013b document worker | `document-worker.ts` (fill the stubbed methods) | `tests/daemon/runtime/sources/document-worker.test.ts` | `lifecycle.ts`, `catalog/sources.ts`, `contracts.ts`, `api.ts`, `server.ts` |
| 013c Obsidian | `providers/obsidian.ts` | `tests/daemon/runtime/sources/providers/obsidian.test.ts` | the lifecycle, the catalog, the contracts |
| 013d Discord | `providers/discord.ts` | `tests/daemon/runtime/sources/providers/discord.test.ts` | the lifecycle, the catalog, the contracts |
| 013e GitHub | `providers/github.ts` | `tests/daemon/runtime/sources/providers/github.test.ts` | the lifecycle, the catalog, the contracts |

Each provider implements **exactly** the `SourceProvider` seam and conforms its
emitted artifacts to `SourceArtifact`. It only READS its source. `close()` is the
purge teardown hook (Discord d-AC-4: close the gateway).

## 8. The seams Wave 2 inherits (pinned contracts)

- `SourceArtifact` — the one shape every provider emits (provenance + content + kind
  + chunks + graphTriples + `failure?` marker).
- `SourceProvider` — `{ connect, index(): AsyncIterable<SourceArtifact>, health, close }`.
  Fake via `createFakeSourceProvider(artifacts)`.
- `Provenance` — the quartet + scope on every derived row.
- `SourceLifecycle` — `connect` / `index` / `updateInPlace` / `health` / `purge`. The
  removal half is the append-only status advance (reuse it; never reimplement).
- `DocumentWorker` — `submit` (dedup-by-URL, b-AC-1) / `get` / `remove` (soft-delete
  doc + chunks, b-AC-5). The document lifecycle states queued→…→done (b-AC-3).

## 9. Daemon-assembly wiring — LIVE by PRD-045e

`mountSourcesApi` and `mountProductDocumentsApi` are mounted in the running daemon as
of PRD-045e (2026-06-22):

- `buildSourcesApiDeps` (`sources/registry.ts:280`) is called at `assemble.ts:854`,
  threaded via `resolveProductDataDeps` (`assemble.ts:706`).
- `/api/sources` GET/POST/DELETE return real data (no 501), tenancy-scoped.
- `POST /api/documents` ingests through the wired document worker (no 501); a real
  SSRF-safe `createUrlDocumentFetcher` is wired at `registry.ts:373`.
- Obsidian provider is live; Discord and GitHub instantiate credential-free and fail-
  soft (a provider/worker error never crashes the daemon — try/catch at `assemble.ts:852-859`).

The `server.ts` route groups (`/api/sources`, `/api/documents`) were scaffolded by
013a and remain unchanged; the assembly step is the only wiring site.

# EXECUTION LEDGER — PRD-003 Core Data Model

> Single source of truth for the /the-smoker run on PRD-003. Survives context loss.
> Status legend: OPEN · IN PROGRESS · DONE (implemented + locally proven) · VERIFIED (independently graded) · BLOCKED

**Run scope:** `library/requirements/in-work/prd-003-core-data-model` (index + 003a..003e)
**Branch:** `prd-003-core-data-model` (off `main`, which now contains merged PRD-001 + PRD-002). PR targets `main`.
**Builds on:** PRD-002 storage adapter — `src/daemon/storage/` (`ColumnDef`, `validateColumnDefs`, `buildCreateTableSql`, `buildAddColumnSql`, `embeddingColumn`/`EMBEDDING_DIMS=768`, write-pattern primitives in `writes.ts`, `heal.ts`). The existing `examples/fixture-tables.ts` is the PRD-002 placeholder this catalog supersedes (keep PRD-002 tests green — leave fixtures or point them at the real catalog).
**Reference:** `hivemind-v1/src/deeplake-schema.ts` — `SESSIONS_COLUMNS`, `MEMORY_COLUMNS` (= honeycomb `memory`), `SKILLS/RULES/GOALS/KPIS/CODEBASE_COLUMNS`. 003a `memories` (distilled), 003b knowledge graph, 003e agents/auth/telemetry are honeycomb-bespoke (design from FRs). Adapt `HIVEMIND_*`→`HONEYCOMB_*`.

---

## Verification posture (defines DONE)
No live DeepLake. Verify via **Vitest against the PRD-002 fake transport** (`tests/helpers/fake-deeplake.ts`). For each table the binding DoD is: its ColumnDef array passes `validateColumnDefs`; `buildCreateTableSql` emits the right DDL; a missing-column write heals + retries once; the required scope/embedding/version columns are present with correct types/defaults; the assigned write-pattern primitive emits correct SQL against the fake transport. Producer/consumer logic (PRD-005 capture, PRD-006 pipeline, PRD-007 retrieval, PRD-008 ontology, auth) is OUT of scope — ACs that mention producer behavior are met at the catalog level (column + write-pattern/helper enforce the invariant), tested against the fake transport.

## Resolved foundational decisions (PRD open questions defaulted, not blocked)
| # | Question | Decision |
|---|---|---|
| D-1 | session_transcripts table vs path convention | `memory` path convention `transcripts/<session>`, NOT a distinct table (003c FR-6/AC-4). |
| D-2 | which tables get explicit tenancy columns | Engine tables carry `agent_id`+`visibility`, rely on storage partitioning for org/workspace; cross-cutting `codebase` carries explicit `org_id`/`workspace_id` (index AC-3, 003d FR-7). |
| D-3 | retention column convention | Per-PRD as stated: `is_deleted` BIGINT 0/1 for soft-delete (memories); `revoked` flag (api_keys); `status` for version-bumped (skills/rules/entity_attributes). No global rename. |
| D-4 | goals/kpis value/target/status shapes | Minimal: `key`, `value`, `target`, `status`, `unit` (+ scope/timestamps). Documented; refine when producers land. |
| D-5 | memory_history embedding diff | Textual before/after payload only, no embedding diff. |

Platform: Windows/PowerShell — cross-platform tests.

## Catalog structure (Wave 1 establishes; Wave 2 fills pre-wired stubs)
`src/daemon/storage/catalog/` with one file per group exporting its ColumnDef arrays + per-table write-pattern assignment, a barrel `index.ts` spreading all groups, and a write-pattern registry (table→pattern from PRD-002d). Wave 1 pre-creates empty wired stubs for b/d/e so Wave 2's parallel Bees fill them with ZERO barrel/registry contention.

---

## AC Ledger (35 granular ACs)

### PRD-003a — Memories, Embeddings, History — Wave 1 (`deeplake-dataset-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| a-AC-1 | `memories` row carries content_hash, confidence, importance, source_id, agent_id, visibility, nullable 768-dim content_embedding. | VERIFIED |
| a-AC-2 | `memory_history` records changed_by ∈ {harness, pipeline, pipeline-shadow}. | VERIFIED |
| a-AC-3 | Identical normalized_content → matching content_hash; dedup helper skips duplicate INSERT. | VERIFIED |
| a-AC-4 | Embedding disabled → content_embedding NULL; recall still returns row via lexical. | VERIFIED |
| a-AC-5 | Soft-deleted memory → is_deleted=1, excluded from recall, retained for audit window. | VERIFIED |
| a-AC-6 | First INSERT to `memories` creates from ColumnDef array + retries once. | VERIFIED |
| a-AC-7 | Shadow mode → memory_history records changed_by='pipeline-shadow'; memories not mutated. | VERIFIED |

### PRD-003b — Knowledge Graph (7 tables) — Wave 2 (`deeplake-dataset-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| b-AC-1 | `entity_attributes` carries kind, status, claim_key, group_key, version, superseded_by. | VERIFIED |
| b-AC-2 | Claim edit → new version row INSERTed, prior marked status='superseded' (no in-place mutate). | VERIFIED |
| b-AC-3 | `entity_dependencies` carries type, strength, confidence, non-empty reason for related_to. | VERIFIED |
| b-AC-4 | `ontology_proposals` carries operation, status, JSONB payload, confidence, rationale, evidence, risk_note. | VERIFIED |
| b-AC-5 | `memory_entity_mentions` joins memory_id to entity_id. | VERIFIED |
| b-AC-6 | Multiple versions → reader returns highest version with status='active'. | VERIFIED |
| b-AC-7 | First write to any ontology table creates from ColumnDef array + retries once. | VERIFIED |

### PRD-003c — Sessions, Transcripts, Summaries — Wave 1 (`deeplake-dataset-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| c-AC-1 | `sessions` row: JSONB message, optional 768-dim message_embedding, path concatenated by creation_date. | VERIFIED |
| c-AC-2 | `memory` row: UPDATE-or-INSERT by path, summary body + summary_embedding. | VERIFIED |
| c-AC-3 | Role separation: sessions=raw, memory=VFS/summaries, memories=distilled, no overlap. | VERIFIED |
| c-AC-4 | Session transcript persists as a `memory` path convention, not a new table. | VERIFIED |
| c-AC-5 | Embedding disabled → message_embedding NULL; row recoverable by path + lexical. | VERIFIED |
| c-AC-6 | sessions pruned by retention → derived `memory` summaries retained. | VERIFIED |
| c-AC-7 | First write to sessions/memory creates from ColumnDef array + retries once. | VERIFIED |

### PRD-003d — Product Tables (skills/rules/goals/kpis/codebase) — Wave 2 (`deeplake-dataset-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| d-AC-1 | Skill/rule edit → INSERT version N+1; reader ORDER BY version DESC LIMIT 1. | VERIFIED |
| d-AC-2 | `codebase` carries (org, workspace, repo, user, worktree, commit) identity + snapshot_jsonb + snapshot_sha256. | VERIFIED |
| d-AC-3 | Goal/KPI write → UPDATE-or-INSERT by logical key, one row per key. | VERIFIED |
| d-AC-4 | Two identical codebase pushes → snapshot_sha256 matches, SELECT-before-INSERT skips duplicate. | VERIFIED |
| d-AC-5 | `skills` row carries scope, author, contributors, source_sessions, trigger_text, body, version. | VERIFIED |
| d-AC-6 | Concurrent codebase push → re-verify after INSERT makes race observable. | VERIFIED |
| d-AC-7 | First write to any product table creates from ColumnDef array + retries once. | VERIFIED |

### PRD-003e — Agents, Auth, Telemetry — Wave 2 (`deeplake-dataset-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| e-AC-1 | `agents` carries read_policy ∈ {isolated, shared, group} and policy_group. | VERIFIED |
| e-AC-2 | `api_keys` holds hashed key + role, scope, optional permissions, connector/harness/agent binding. | VERIFIED |
| e-AC-3 | API key revoke → revoked advanced, row retained for audit (no in-place delete). | VERIFIED |
| e-AC-4 | Telemetry opt-in → no secret or request body written to any telemetry table. | VERIFIED |
| e-AC-5 | Router history row → model, provider, workload, outcome with prompt content redacted. | VERIFIED |
| e-AC-6 | group read_policy → policy_group bounds which agents share visibility. | VERIFIED |
| e-AC-7 | First write to agents/api_keys/telemetry creates from ColumnDef array + retries once. | VERIFIED |

### Index roll-ups (transitive)
| Index AC | Satisfied by | Status |
|---|---|---|
| AC-1 every table created+healed from ColumnDef array | a/b/c/d/e-AC-(6/7) | VERIFIED |
| AC-2 three memory tables unambiguous | c-AC-3 | VERIFIED |
| AC-3 engine tables carry agent_id+visibility; codebase carries org_id+workspace_id | a-AC-1, d-AC-2 | VERIFIED |
| AC-4 every embedding column nullable 768-dim FLOAT4[] | a-AC-1, c-AC-1 | VERIFIED |

**Totals:** 35 granular ACs · **35 VERIFIED** · 0 OPEN · 0 BLOCKED — ledger fully VERIFIED, close-out unlocked.

---

## Wave plan
```
Wave 1 (scaffold + 003a + 003c + pre-wired b/d/e stubs) ──► Wave 2 (003b ‖ 003d ‖ 003e, parallel) ──► Wave 3 (security → quality) ──► Ship
```
- **Wave 1 — Catalog spine** · `deeplake-dataset-worker-bee` + `deeplake-dataset-stinger` · **opus**. Scaffold `catalog/` + barrel + write-pattern registry + conventions; implement 003a (memories) + 003c (sessions/memory — the three-memory-table role separation, index AC-2); pre-create empty wired stubs for 003b/003d/003e. Exit: 003a+003c ACs proven by Vitest; b/d/e stubs registered (empty arrays) so the barrel compiles.
- **Wave 2 — Remaining groups (parallel, no shared-file contention)** · 3× `deeplake-dataset-worker-bee` each filling one pre-wired stub:
  - 003b knowledge graph (7 tables, supersession) — **opus** (trickiest: version lineage).
  - 003d product tables — **sonnet** (pattern-following, hivemind reference).
  - 003e agents/auth/telemetry — **sonnet** (mechanical; security-relevant columns).
- **Wave 3 — Close-out** · `security-worker-bee` (opus) → `quality-worker-bee` (sonnet). Security real here: api_keys hashed/never-plaintext (e-AC-2), telemetry redaction (e-AC-4/5).

Dependency: Wave 1 scaffold + conventions hard-block Wave 2 (the per-group files + registry + role-separation conventions must exist first). 003b/003d/003e are independent table groups → parallel.

---

## Watchdog / event log
- PRD-003 moved backlog→in-work (git mv); index status In-Work. Branch `prd-003-core-data-model` off main (PRD-001+002 merged). PR will target main.
- Wave 1 → `deeplake-dataset-worker-bee` (opus). Built `catalog/` scaffold (types/registry/barrel/CONVENTIONS.md), implemented 003a (memories,memory_history) + 003c (sessions,memory), pre-wired empty stubs KNOWLEDGE_GRAPH_TABLES/PRODUCT_TABLES/TENANCY_TABLES. 21 new tests (90 total).
- Orchestrator verify: ci=0 (90 tests), build/audit:sql/audit:openclaw green; 14 a/c ACs named+unskipped; stubs wired (barrel compiles); embedding cols via embeddingColumn(768); CONVENTIONS.md present. → a/c-AC VERIFIED.
- Wave 2 dispatched: 3 parallel `deeplake-dataset-worker-bee` — 003b (opus), 003d (sonnet), 003e (sonnet), each filling its own stub + test file.
- Wave 2 (3 parallel Bees) returned: 003b (opus, 9 tests, 7 tables), 003d (sonnet, 8 tests, 5 tables), 003e (sonnet, 11 tests, 5 tables). Shared-seam handling: Wave-1 `catalog.test.ts` asserted stubs-empty (transitional guard); 003d reconciled it. Orchestrator then TIGHTENED the cross-check to assert real per-group counts (7+5+5). Stale spawned task task_bd6e18f5 dismissed.
- Orchestrator verify: full gate green (ci=0, 118 tests/13 files, build/audit:sql/audit:openclaw green); 21 b/d/e ACs named+unskipped; security invariants hold (api_keys key_hash-only no plaintext; router_history no prompt/query column, only query_hash). → b/d/e + index roll-ups VERIFIED. **All 35 ACs VERIFIED.**
- Wave 3 close-out dispatched: `security-worker-bee` (opus) → `quality-worker-bee` (sonnet).
- `security-worker-bee` (opus): **1 High FIXED** — H-1 the `audit:sql` STATEMENT_FINGERPRINT had a trailing-`\b` blind spot to the most common catalog shape (`SELECT * FROM "${tbl}" WHERE id='${raw}'`); fix removed the trailing `\b`, surfaced+resolved 3 masked false-positives via narrow NUMERIC_OR_PREBUILT widening. L-1 (unsalted SHA-256 for high-entropy API keys) ACCEPTED by design. Report: `.../reports/2026-06-17-security-report.md`.
- Orchestrator re-verify (gate changed again): common-shape bypass now flagged (exit 1, 2 findings), clean tree exit 0; ci=0 (118 tests), build=0, audit:openclaw=0, npm audit --omit=dev 0 vulns. Catalog source untouched, no VERIFIED AC broke. **No blocking findings.**
- `quality-worker-bee` (sonnet) dispatched.
- `quality-worker-bee` (sonnet): **PASS-WITH-FINDINGS** — 35/35 ACs PASS (non-vacuous tests), no Medium+ findings, no scope creep, daemon boundary held, all 3 parallel groups consistent. One cosmetic Suggestion S-1 (CONVENTIONS.md listed `agents` under "agent" scope; code correctly "tenant"). Report: `.../reports/2026-06-17-qa-report.md`. Both close-out gates clean at medium+ → loop terminates.
- Orchestrator fixed S-1 (CONVENTIONS.md: moved `agents` to the "tenant" scope bullet).
- **Phase 3 Ship:** committing catalog + tests + security gate fix + library; PR targets main (PRD-001/002 merged).

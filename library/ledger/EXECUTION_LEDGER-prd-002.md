# EXECUTION LEDGER — PRD-002 DeepLake Storage Adapter

> Single source of truth for the /the-smoker run on PRD-002. Survives context loss.
> Status legend: OPEN · IN PROGRESS · DONE (implemented + locally proven) · VERIFIED (independently graded) · BLOCKED

**Run scope:** `library/requirements/in-work/prd-002-deeplake-storage-adapter` (index + 002a..002e)
**Branch:** `prd-002-deeplake-storage-adapter` (based on `prd-001-monorepo-foundation`; PR #1 not yet merged, so this stacks on the foundation)
**Reference template:** `hivemind-v1/src/` — near-exact blueprint: `utils/sql.ts` (escaping, identical to 002b spec), `deeplake-api.ts` (client + write patterns + vector), `deeplake-schema.ts` (heal + ColumnDef), `utils/client-header.ts` (org resolution). Adapt `HIVEMIND_*`→`HONEYCOMB_*`.

---

## Verification posture (READ FIRST — defines DONE)

No live DeepLake endpoint/credentials are available in this environment. Per how `hivemind-v1` itself is tested, the adapter is built against an **abstracted query transport** and every AC is verified via **Vitest against a fake/in-memory DeepLake transport** that simulates: missing-table/column errors, `information_schema.columns` responses, version-bump reads, vector scored-ID responses, 402/timeout/connection errors. This proves the adapter's SQL generation, escaping, error classification, retry, dim validation, clamping, and result shapes — the honest DoD absent credentials.

**Live-integration against real DeepLake hardware (GPU search latency, real UPDATE-coalescing) is parked as a documented LIMITATION, not a blocker.** Specific ask to close it: provide a DeepLake endpoint + token + org so an opt-in integration suite can run. The unit/contract layer below is what flips ACs to VERIFIED.

Vitest does not yet exist in the repo — Wave 1 adds it (`vitest run` + coverage-v8, `tests/` mirroring `src/`, `test` script wired into `ci`).

---

## Resolved foundational decisions (PRD open questions defaulted, not blocked)

| # | Question | Decision |
|---|---|---|
| D-1 | DeepLake connection/auth model | Config object (endpoint, token, org, timeout) validated by `zod`, fail-closed. Credentials read via a provider seam (env `HONEYCOMB_DEEPLAKE_*` now; real secret store is PRD-012). Org travels as a request header (`deeplakeClientHeader` equivalent). |
| D-2 | Single shared connection vs pool | Single shared connection + per-query org resolution (matches reference; PRD note). |
| D-3 | NOT-NULL-without-DEFAULT guard placement | Load-time schema validator invoked by the heal module (FR-7), not the per-write heal pass. |
| D-4 | Over-fetch multiplier | Default **3x**, tuning-configurable (`HONEYCOMB_*`), documented. |
| D-5 | Score normalization | Cosine similarity normalized **0..1**; hybrid fusion deferred to PRD-007. |
| D-6 | No-parameterized-fallback enforcement | Typed query-builder convention + a lightweight `scripts/audit-sql-safety.mjs` grep gate wired into `ci` (mirrors `audit:openclaw` pattern); no heavy custom Biome rule. |

Platform: Windows/PowerShell dev host — keep tests/scripts cross-platform.

---

## AC Ledger (35 granular ACs)

### PRD-002a — Client & Connection — Owner: `typescript-node-worker-bee` (Wave 1)
| ID | Criterion | Status |
|---|---|---|
| a-AC-1 | Client initializes, connects to configured endpoint, exposes query interface. | VERIFIED |
| a-AC-2 | Request org/workspace identity is sent so DeepLake enforces partition boundary. | VERIFIED |
| a-AC-3 | Missing/out-of-range config → structured error, daemon fails closed. | VERIFIED |
| a-AC-4 | Query exceeding `HONEYCOMB_QUERY_TIMEOUT_MS` → timeout result, no indefinite block. | VERIFIED |
| a-AC-5 | Non-daemon process calls daemon on 3850; never opens DeepLake itself. | VERIFIED |
| a-AC-6 | `HONEYCOMB_TRACE_SQL` unset → no statement logging; set → logged. | VERIFIED |
| a-AC-7 | Connection failure vs query failure → distinct typed result kinds. | VERIFIED |

### PRD-002b — SQL Safety Escaping — Owner: `deeplake-dataset-worker-bee` (Wave 2)
| ID | Criterion | Status |
|---|---|---|
| b-AC-1 | `sqlStr` doubles quotes/backslashes, drops NUL/control chars. | VERIFIED |
| b-AC-2 | `sqlIdent` accepts only `^[a-zA-Z_][a-zA-Z0-9_]*$`, throws otherwise. | VERIFIED |
| b-AC-3 | `sqlLike` escapes `%`/`_` as literals. | VERIFIED |
| b-AC-4 | `E'...'` body with `\n`/escapes round-trips to intended bytes. | VERIFIED |
| b-AC-5 | `'; DROP TABLE x; --` via `sqlStr` is one inert literal; no 2nd statement. | VERIFIED |
| b-AC-6 | `id; DROP` via `sqlIdent` throws; query never built. | VERIFIED |
| b-AC-7 | Hand-interpolation bypass flagged by CI (audit:sql-safety). | VERIFIED |

> **b-AC-7 reopened then REMEDIATED + re-verified:** the gate originally caught only template-literal `${...}` bypasses; a string-concat bypass slipped through (false negative). `deeplake-dataset-worker-bee` hardened `audit-sql-safety.mjs` with a top-level-concat tokenizer (`splitTopLevelConcat` + `concatOperandIsSafe`) and split the b-AC-7 test into 4 (both bypass forms + clean-tree + literal/helper-concat-allowed). Orchestrator re-verify: concat bypass → exit 1 (flags `userId`), template bypass → exit 1 (no regression), clean tree → exit 0, full gate green (66 tests). → **VERIFIED.**

### PRD-002c — Lazy Schema Healing — Owner: `deeplake-dataset-worker-bee` (Wave 2)
| ID | Criterion | Status |
|---|---|---|
| c-AC-1 | Missing-table write → create from ColumnDef array, retry once. | VERIFIED |
| c-AC-2 | Missing-column write → read `information_schema`, diff, add only missing. | VERIFIED |
| c-AC-3 | Permission error → rethrow unchanged, no create/alter. | VERIFIED |
| c-AC-4 | Heal retry still fails → rethrow, no second retry loop. | VERIFIED |
| c-AC-5 | `NOT NULL` + no `DEFAULT` column def → load-time guard rejects before any write. | VERIFIED |
| c-AC-6 | Two workers healing same missing table → `IF NOT EXISTS`+add-only-missing idempotent. | VERIFIED |
| c-AC-7 | Every heal ALTER/CREATE/SELECT identifier passes `sqlIdent`. | VERIFIED |

### PRD-002d — Write Patterns & Atomicity — Owner: `deeplake-dataset-worker-bee` (Wave 2)
| ID | Criterion | Status |
|---|---|---|
| d-AC-1 | Version-bumped primitive INSERTs N+1; reader takes `ORDER BY version DESC LIMIT 1`. | VERIFIED |
| d-AC-2 | SELECT-before-INSERT re-verifies after insert so a race is observable. | VERIFIED |
| d-AC-3 | Two rapid version-bumped edits → both persist; highest reads current. | VERIFIED |
| d-AC-4 | `sessions` write appends one row, never concatenates; read orders by `creation_date`. | VERIFIED |
| d-AC-5 | Supersede appends a new version + marks prior superseded (no in-place mutate). | VERIFIED |
| d-AC-6 | Every interpolated value routes through `sqlStr`/`sqlLike`/`sqlIdent`; `E'...'` bodies. | VERIFIED |
| d-AC-7 | Missing-column write heals via 002c and retries once (heal-aware primitives). | VERIFIED |

### PRD-002e — Vector Columns & GPU Search — Owner: `deeplake-dataset-worker-bee` (Wave 2)
| ID | Criterion | Status |
|---|---|---|
| e-AC-1 | 768-dim query vector → GPU search on nullable tensor column, returns scored IDs. | VERIFIED |
| e-AC-2 | Null embedding row → recall degrades to lexical, not failure. | VERIFIED |
| e-AC-3 | Scoped recall over-fetches by configured multiplier (default 3x). | VERIFIED |
| e-AC-4 | Result carries IDs + normalized scores only, no row content. | VERIFIED |
| e-AC-5 | org/workspace/agent scope filter applied in the SAME query as the vector match. | VERIFIED |
| e-AC-6 | Non-768-dim query vector → rejected with structured error. | VERIFIED |
| e-AC-7 | `HONEYCOMB_SEMANTIC_LIMIT` out of range → clamped non-negative before search. | VERIFIED |

### Index roll-ups (satisfied transitively)
| Index AC | Satisfied by | Status |
|---|---|---|
| AC-1 escaping, no parameterized binding | b-AC-1..7 | VERIFIED |
| AC-2 heal on missing table/column + retry once | c-AC-1, c-AC-2 | VERIFIED |
| AC-3 version-bump preserves both, highest=current | d-AC-1, d-AC-3 | VERIFIED |
| AC-4 768-dim GPU vector search + null→lexical | e-AC-1, e-AC-2 | VERIFIED |

**Totals:** 35 granular ACs · **35 VERIFIED** · 0 OPEN · 0 BLOCKED — ledger fully VERIFIED, close-out unlocked.

---

## Wave plan

```
Wave 1 (002a + Vitest/transport harness) ──► Wave 2 (002b → 002c → {002d, 002e}) ──► Wave 3 (security → quality) ──► Ship
```

- **Wave 1 — Client + test foundation (002a)** · `typescript-node-worker-bee` + `typescript-node-stinger` · **opus** (`claude-opus-4-8-thinking-high`: the transport abstraction + zod fail-closed config + result-union are load-bearing for all of Wave 2).
  Exit: client connects (fake transport), zod config fail-closed, timeout result, org header, redaction, SQL-trace gate, typed result union; Vitest running, `test` wired into `ci`; reusable fake-DeepLake transport fixture documented for Wave 2.
- **Wave 2 — DeepLake logic (002b+002c+002d+002e)** · `deeplake-dataset-worker-bee` + `deeplake-dataset-stinger` · **opus** (matrix ideal `gemini-3.1-pro` for schema/vector reasoning not spawnable → opus for deep correctness on heal classification, version-bump, vector dim/over-fetch, SQL-injection floor). One Bee, internally sequenced b→c→{d,e}; all route through the Wave-1 client + fake transport.
- **Wave 3 — Close-out** · `security-worker-bee` (opus) → `quality-worker-bee` (sonnet). Security before quality, always. (002b is the SQL-injection floor — security scrutiny is real here.)

Dependency: 002a (client + transport + Vitest) hard-blocks Wave 2 (everything routes through the client interface and needs the test runner). 002b→002c→002d/002e is the internal chain.

---

## Watchdog / event log
- PRD-002 moved backlog→in-work (git mv); index status set In-Work. Branch `prd-002-deeplake-storage-adapter` created off the PRD-001 foundation.
- Wave 1 (002a) → `typescript-node-worker-bee` (opus). Returned all 7 a-AC DONE with 32 Vitest tests + reusable fake transport. Added Vitest (`vitest`+coverage-v8), `test` script, `ci` now = typecheck+dup+test; `zod ^4`. Storage under `src/daemon/storage/{client,config,transport,result,index}.ts`.
- Orchestrator independent verify: `npm run test` 32 passed (3 files), `ci`/`build`/`audit:openclaw` exit 0; daemon-only invariant holds (storage+zod in daemon bundle = 555 markers, **0** in cli bundle, no non-daemon import); all 7 a-AC have real named tests, no `.skip`/`.only`; timeout test uses a real abort race. → **a-AC-1..7 VERIFIED.**
- Wave 2 (002b+c+d+e) dispatched → `deeplake-dataset-worker-bee` (opus), routing through the Wave-1 client + fake transport.

## Watchdog / event log (cont.)
- Wave 2 (002b+c+d+e) → `deeplake-dataset-worker-bee` (opus). Returned 28 ACs DONE, 31 new tests (63 total). Created sql.ts/schema.ts/heal.ts/writes.ts/vector.ts + audit-sql-safety.mjs (audit:sql wired into ci); fixtures clearly marked (not the PRD-003 catalog).
- Orchestrator independent verify: full gate green (63 tests, all AC-named, no skips; ci/build/audit:openclaw/audit:sql exit 0; daemon-only invariant holds). Adversarial probe REOPENED b-AC-7 (gate blind to string-concat bypass). 27 ACs flipped VERIFIED.
- b-AC-7 remediation dispatched to same Bee → gate hardened (top-level-concat tokenizer), b-AC-7 test split into 4 forms. Orchestrator re-verify: both bypass forms flag, clean tree passes, 66 tests green. → b-AC-7 VERIFIED. **All 35 ACs VERIFIED.**
- Wave 3 close-out dispatched: `security-worker-bee` (opus) → `quality-worker-bee` (sonnet).
- `security-worker-bee` (opus) returned: **2 High FIXED** — F-1 raw `selectColumns` interpolation in `writes.ts` (readLatestVersion/readAppendOrdered) → added `sqlColumnList()` validator at both sinks; F-2 `audit:sql` gate blind to `SELECT ${...}` projection bypass → fingerprint strengthened + `sqlColumnList` registered. F-3/F-4 Medium (trace-SQL PII off-by-default; dev-tree esbuild advisories, not shipped) RECOMMENDED; F-5 Low ACCEPTED. Report: `.../reports/2026-06-17-security-report.md`.
- Orchestrator independent re-verify (gate + writes.ts changed): both readers use `sqlColumnList` (+test); `audit:sql` catches concat+template+projection bypasses (2/2 flagged), clean tree exit 0; `ci` exit 0 (69 tests), `build` exit 0, `audit:openclaw` exit 0, `npm audit --omit=dev` 0 vulns. No VERIFIED AC regressed; gate is stronger. **No blocking findings.**
- `quality-worker-bee` (sonnet) dispatched.

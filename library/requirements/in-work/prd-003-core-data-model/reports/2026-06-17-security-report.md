# Security Audit Report: PRD-003 Core Data Model (the DeepLake table catalog)

**Audit date:** 2026-06-17
**Auditor:** security-worker-bee subagent
**Branch:** `prd-003-core-data-model`
**Scope:** `src/daemon/storage/catalog/**` (types, registry, index, memories, sessions-summaries, knowledge-graph, product, tenancy, CONVENTIONS.md), the catalog-level SQL builders + hash helpers, `tests/daemon/storage/catalog/**`, the SQL-safety floor (`src/daemon/storage/sql.ts`, `schema.ts`, `writes.ts`) and the `audit:sql` CI gate (`scripts/audit-sql-safety.mjs`).
**Node version audited:** >=22 (package.json engines)
**`npm audit` result:** clean — 0 vulnerabilities (`--omit=dev`)
**OpenClaw bundle scan:** clean (`npm run audit:openclaw` — 0 findings)
**CVE watchlist last refreshed:** n/a for a schema/catalog surface — no new runtime dependencies introduced by PRD-003; `npm audit` prod tree is clean.

---

## Executive Summary

The PRD-003 catalog is a strong, security-aware schema layer: API keys are stored as SHA-256 hashes only (no plaintext column exists), telemetry tables carry no prompt/body/secret columns, revocation is soft-delete (never in-place DELETE), every catalog SQL builder routes identifiers through `sqlIdent` and values through `sLiteral`, and the load-time guard enforces NOT-NULL-needs-DEFAULT so no table can fail its heal `ALTER`. The single material finding is **not** in the catalog code itself but in the **`audit:sql` CI gate that is supposed to protect it**: a fragile trailing word-boundary in the statement-fingerprint regex caused the gate to never inspect the most common catalog SQL shape (`SELECT * FROM "${tbl}" WHERE id = '${value}'`), so a future raw-value interpolation in that shape would have shipped with CI green. Classified **High** (a defeated injection control over the credential + captured-trace tables). It is **FIXED in this session** and proven: the hardened gate now catches planted raw-value bypasses while still passing the real tree clean. No unresolved Critical/High remains.

Ordering note: no `*-qa-report.md` exists for this branch — `security-worker-bee` ran before `quality-worker-bee` as required. (QA reports exist for prd-001 and prd-002 only; those are unaffected.)

---

## Scorecard

| Category | Status | Findings |
|---|---|---|
| Credential / Token Exposure (api_keys, hashApiKey) | OK | 0 |
| Captured-Trace PII (sessions/memory/telemetry columns) | OK | 0 |
| Authentication & Org RBAC / Scope (scope columns per D-2) | OK | 0 |
| Injection (Deep Lake SQL API — catalog builders) | OK | 0 |
| Injection control / CI gate integrity (`audit:sql`) | FAIL → FIXED | 1 High |
| Dependency & OpenClaw Bundle | OK | 0 |
| Configuration (fail-closed defaults, soft-delete) | OK | 0 |

Legend: **OK** = zero findings · **ATTN** = Medium/Low documented · **FAIL** = Critical/High (fixed in this session).

---

## Critical Findings (fixed in this session)

None detected.

---

## High Findings (fixed in this session)

- [x] **Injection-control bypass — SQL-safety CI gate blind to the common statement shape** `scripts/audit-sql-safety.mjs:80` (`STATEMENT_FINGERPRINT`) — The statement-fingerprint regex wrapped its keyword alternatives in `(\b(...)\b|...)`. The **trailing** `\b` fails whenever the alternative's final matched character is followed by another word character (the normal multi-char table/column case) or by a non-word char like `*`. As a result the gate did **not** fingerprint — and therefore never inspected — the single-line shapes `SELECT * FROM "${tbl}" WHERE id = '${raw}'`, `SELECT * FROM "${t}" WHERE path = '${raw}'`, and `UPDATE "${tbl}" SET col = ... WHERE id = '${raw}'`. A raw, un-escaped value interpolated in any of those shapes (over the `api_keys`, `memories`, `memory`, `sessions` tables) would pass `npm run audit:sql` and ship. Verified by planting `return \`SELECT * FROM "${tbl}" WHERE id = '${userId}'\`` in `src/daemon/storage/` — the pre-fix gate reported "OK".
  **Fix:** removed the fragile trailing `\b` (kept the leading `\b` for keyword-boundary; specificity is preserved by each alternative's required trailing query syntax). This newly surfaced three pre-existing **false positives** the broken gate had masked — all legitimately pre-escaped/trusted values (`${KEY_REVOKED}` a SCREAMING_SNAKE numeric const; `${col.sql}` a load-validated ColumnDef schema string; `${setClauses}` a fragment built from `sqlIdent`+`renderValue`). Widened the `NUMERIC_OR_PREBUILT` allowlist narrowly to recognize those three safe forms (all-caps const, `.sql`/`.name` ColumnDef property, plural `Clauses`/`Cols`/`Vals` fragment suffixes) without re-opening the hole.
  **Proof:** post-fix the real tree passes clean (`audit:sql` OK, exit 0); planted raw bypasses (`${userId}`, `${path}`, `${orgId}`, unbound `${tbl}`, and a `+ raw +` concat) are all caught (exit 1). Full `npm run ci` green (118 tests).

---

## Medium Findings (follow-up required)

None detected.

---

## Low Findings (documentation only)

- [ ] **Defense-in-depth note (no action required) — `hashApiKey` is unsalted SHA-256** `src/daemon/storage/catalog/tenancy.ts:243` — `hashApiKey` is a single-round unsalted SHA-256. This is the **correct** choice here because an API key is high-entropy machine-generated secret material (not a low-entropy human password), so a slow/salted KDF is unnecessary and the lookup must be a deterministic equality probe (`buildApiKeyLookupSql`). Documented only so a future reviewer does not "upgrade" it to bcrypt/argon2 and break the lookup. No change made.

---

## Dependency Audit

```text
npm audit --omit=dev  →  found 0 vulnerabilities
```

PRD-003 introduces no new runtime dependencies (the catalog uses only `node:crypto` for hashing and the in-repo `sql.ts` helpers). OpenClaw bundle scan: clean.

---

## Surface Integrity Check

| Check | Expected | Observed | Status |
|---|---|---|---|
| **SQL guards** (`src/daemon/storage/sql.ts`) | `sqlIdent` regex `^[A-Za-z_][A-Za-z0-9_]*$`; values via `sqlStr`/`sLiteral`/`sqlLike`/`eLiteral` | Confirmed; helpers sound (quote/backslash/NUL/control escaping, identifier throws-not-sanitizes) | OK |
| **Catalog builders route through helpers** | every dynamic fragment via `sqlIdent`/`sLiteral` | `buildApiKeyLookupSql`, `buildRevokeApiKeySql`, `buildSupersedeMarkSql`, `buildHighestActiveVersionSql`, `buildCurrentVersionSql`, `buildSnapshotDedupSql`, `buildDedupCheckSql`, `buildTranscriptLookupSql` — all confirmed | OK |
| **`audit:sql` gate covers the catalog** | scans `src/daemon/storage` recursively, fails CI on raw interpolation | Covered, but fingerprint was blind to `SELECT * … WHERE` shape → **fixed** | OK (post-fix) |
| **api_keys stores only a hash** | `key_hash` only; no `key`/`secret`/`token`/`plaintext`/`password` column | Confirmed (structural test e-AC-2 asserts it) | OK |
| **Revocation is soft-delete** | advance `revoked` 0→1; never DELETE | `buildRevokeApiKeySql` emits `UPDATE … SET revoked = 1`; test asserts no DELETE | OK |
| **Key lookup compares hashes** | hash the presented key, probe `key_hash` | `buildApiKeyLookupSql` uses `key_hash = sLiteral(hash)`; never the plaintext | OK |
| **Telemetry carries no body/secret** | no prompt/request_body/secret column; `recall_qa_ledger` uses `query_hash`; `router_history` metadata-only | Confirmed (structural tests e-AC-4/e-AC-5) | OK |
| **JSONB payloads escaped by helpers** | `ontology_proposals.payload`, `codebase.snapshot_jsonb`, `sessions.message` are nullable JSONB; any interpolating writer uses `eLiteral`/`sqlStr` | Columns are nullable JSONB (no catalog INSERT builder hand-interpolates them); writers (PRD-008) bound by the now-hardened `audit:sql` gate | OK |
| **Fail-closed schema (NOT NULL ⇒ DEFAULT)** | load guard rejects NOT-NULL-without-DEFAULT; heal `ALTER` cannot fail | `validateColumnDefs` enforces; JSONB/FLOAT4[] nullable (exempt) → no catalog table can fail the heal add | OK |
| **Scope columns present per D-2** | engine tables carry `agent_id`+`visibility`; tenant tables carry `org_id`+`workspace_id` | Confirmed on every table; no row can be written unscoped | OK |
| **OpenClaw bundle scan** | clean | clean (0 findings) | OK |

---

## Files Changed (remediation)

| File | Change Summary |
|---|---|
| `scripts/audit-sql-safety.mjs` | Hardened `STATEMENT_FINGERPRINT` (removed fragile trailing `\b` so the common `SELECT * … WHERE id = '${raw}'` shape is now inspected) and widened `NUMERIC_OR_PREBUILT` to recognize three legitimately-safe forms (SCREAMING_SNAKE const, `.sql`/`.name` ColumnDef property, plural fragment suffixes) so the strengthened gate stays free of false positives. Comments updated to document the reasoning. |

No catalog source or test file required a code change — the catalog itself was clean. `git diff` reviewed and confirmed security-scoped on 2026-06-17 (only `scripts/audit-sql-safety.mjs` modified by this audit; PRD doc moves and untracked catalog/test files are the PRD-003 implementation, not audit changes).

---

## Verification (post-remediation)

| Command | Result |
|---|---|
| `npm run ci` (typecheck + dup + test + audit:sql) | **exit 0** — typecheck clean, jscpd clean, **118 tests passed (13 files)**, audit:sql OK |
| `npm run build` | **exit 0** — 1 daemon + 5 hook-harness + 1 OpenClaw + 1 MCP + 1 CLI + 1 embed-daemon bundle |
| `npm run audit:openclaw` | **exit 0** — clean against ClawHub static-analysis rules |
| `npm audit --omit=dev` | **exit 0** — 0 vulnerabilities |
| Planted-bypass regression | Hardened `audit:sql` catches raw `${userId}`/`${path}`/`${orgId}`, unbound `${tbl}`, and `+ raw +` concat (exit 1) while passing the real tree clean |

No VERIFIED acceptance criterion was broken by the remediation (the catalog code is untouched; the change is confined to the CI gate, which now strictly supersets its prior coverage).

---

## Recommended Follow-Up (architectural)

- **PRD-008 writers (out of scope here).** The catalog defines the SQL builders and the daemon will add the actual producers in PRD-008. Those producers now inherit a correctly-strict `audit:sql` gate — but they must still (a) derive `org_id`/`scope` from the authenticated credential context, never from caller input (OWASP B3 / PII C3), and (b) redact at the capture boundary before any `sessions`/`memory`/`ontology_proposals.payload` write so no token/PII enters a recalled trace (PII C5). Flag for the PRD-008 security pass.
- **`audit:sql` is a grep gate, not a parser.** It is now strictly stronger, but the long-term hardening is an AST-based check (or a typed `Sql` branded-string builder) so safety no longer depends on regex fingerprints. Low priority while the catalog builders remain the only SQL sites.

---

## Unresolved Critical/High

**None.** The single High finding was remediated and verified in this session. The branch is clear for `quality-worker-bee`.

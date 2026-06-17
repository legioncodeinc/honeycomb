# Security Audit Report: PRD-002 DeepLake Storage Adapter

**Audit date:** 2026-06-17
**Auditor:** security-worker-bee subagent
**Branch:** `prd-002-deeplake-storage-adapter`
**Scope:** `src/daemon/storage/**` (client, config, transport, result, sql, schema, heal, writes, vector, index, examples/fixture-tables), `scripts/audit-sql-safety.mjs`, `tests/daemon/storage/**`, `tests/helpers/fake-deeplake.ts`, `package.json`
**Node version audited:** >=22 (package.json engines)
**`npm audit` result:** Production tree (`--omit=dev`) clean (0). Dev/test tree: 6 High (esbuild/vite/vitest chain — dev-only, not shipped).
**OpenClaw bundle scan:** clean (`npm run audit:openclaw` exit 0)
**Ordering:** Ran BEFORE `quality-worker-bee`. No prior QA report exists for this branch — ordering correct.

---

## Executive Summary

Two **High** findings were identified and **fixed in this session**, both in the SQL-safety surface (the data layer's security floor, PRD-002b). The most important: `scripts/audit-sql-safety.mjs` — the CI gate that is supposed to *prove* no builder hand-interpolates a raw value — was **blind to a raw value interpolated as a `SELECT` projection list** (`SELECT ${cols} FROM ...` with the `FROM` on the next concatenated line carried no keyword the `STATEMENT_FINGERPRINT` regex could match). That blind spot was actively masking a real injection sink: `readLatestVersion` and `readAppendOrdered` in `writes.ts` interpolated a caller-supplied `selectColumns` string **raw** into the statement. Both are now closed: a new `sqlColumnList` helper validates every projected identifier, and the gate's fingerprint was strengthened (additively — original behavior preserved) so the projection-interpolation shape is caught, with regression tests proving teeth. All other focus areas (org/tenant isolation, credential/PII redaction, schema-heal abuse, input-validation/DoS, supply chain) passed. Three Medium/Low items are documented for follow-up; none block the run. **No unresolved Critical/High remain.**

---

## Scorecard

| Category | Status | Findings |
|---|---|---|
| Credential / Token Exposure | OK | 0 |
| Captured-Trace PII (sessions/memory) | ATTN | 1 (Medium) |
| Authentication & Org RBAC / Scope | OK | 0 |
| Injection (Deep Lake SQL API) | FAIL → fixed | 2 (High, both fixed) |
| Dependency & OpenClaw Bundle | ATTN | 1 (Medium, dev-only) |
| Configuration (clamps, fail-closed, client hardening) | ATTN | 1 (Low) |
| Pre-Tool-Use Gate & Prompt Injection | OK (n/a to this surface) | 0 |

Legend: **OK** = zero findings · **ATTN** = Medium/Low documented · **FAIL** = Critical/High (fixed in this session).

---

## Findings Table

| ID | Severity | File:Line | Issue | Status |
|---|---|---|---|---|
| F-1 | **High** | `src/daemon/storage/writes.ts:117` & `:289` | Caller-supplied `selectColumns` interpolated raw into `SELECT ${selectColumns} FROM ...` — a SQL-injection sink and a violation of PRD-002b FR-5 (no raw-interpolation fallback). A projection like `id, (SELECT token FROM secrets)` or `*; DROP TABLE x; --` would build. | **FIXED** |
| F-2 | **High** | `scripts/audit-sql-safety.mjs:72` (`STATEMENT_FINGERPRINT`) | The `audit:sql` CI gate (PRD-002b FR-7 / b-AC-7) was **blind** to `SELECT ${...}` projection interpolation: `SELECT\s+[\w*]` cannot match `SELECT ${`, and the other clause alternatives fail the trailing `\b` when the clause is split across concatenated lines. The gate let F-1 (and any future projection bypass) ship. | **FIXED** |
| F-3 | Medium | `src/daemon/storage/client.ts:60,63-66` | When `HONEYCOMB_TRACE_SQL=1`, up to 220 chars of the raw SQL — which can embed captured-trace PII inside an `eLiteral` body (raw prompt / message text in an INSERT) — is written to stderr. Org is redacted; token is never present. | **RECOMMENDED** (opt-in, off by default) |
| F-4 | Medium | `package.json` devDependencies (`vitest`/`@vitest/coverage-v8` → `vite` → `esbuild` ≤0.28.0) | 6 High advisories in the **dev/test** tree (GHSA-gv7w-rqvm-qjhr esbuild registry-RCE; GHSA-g7r4-m6w7-qqqr esbuild dev-server file read). Not in any shipped bundle; exploit vectors (esbuild dev server / malicious NPM_CONFIG_REGISTRY) do not apply to `vitest run` in CI. Production tree is clean. | **RECOMMENDED** (upgrade) |
| F-5 | Low | `src/daemon/storage/vector.ts:181-199` | `limit` / `semanticLimit` have a non-negative + multiplier floor but no explicit **upper** clamp, so an internal caller passing a huge `limit` yields a large `LIMIT N`. Values feeding this from env (`resolveLimits`) are clamped non-negative; the server enforces the cap. Low risk, internal API. | **ACCEPTED-RISK** |

---

## Critical Findings (fixed in this session)

None detected.

---

## High Findings (fixed in this session)

- [x] **Injection (Deep Lake SQL API) — F-1** `src/daemon/storage/writes.ts:117` and `:289` — `readLatestVersion` / `readAppendOrdered` interpolated the caller-supplied `selectColumns` string directly into `SELECT ${selectColumns} FROM ...`. Fix: added `sqlColumnList()` to the single-source-of-truth `sql.ts`, which accepts `*` or a comma-separated list of identifiers each validated through `sqlIdent` (throws on a subquery, function call, `;`, or any non-identifier). Both readers now route the projection through it (`const cols = sqlColumnList(selectColumns)`).
- [x] **Injection / CI-gate teeth — F-2** `scripts/audit-sql-safety.mjs:72` — the `STATEMENT_FINGERPRINT` could not recognize a `SELECT ${...}` projection-list interpolation, so the gate that *proves* FR-7/b-AC-7 silently passed the F-1 bypass. Fix: added an additive alternative `SELECT\s+\$\{` to the fingerprint (original `\b(...)\b` group left byte-for-byte intact, so no existing detection regressed), registered `sqlColumnList` in the gate's `HELPER` and `SAFE_BINDING_RHS` recognizers, and renamed two provably-safe local fragments (`scoreExpr`→`scoreSql`, plus a `numbersLit` binding in `serializeFloat4Array`) to the gate's documented prebuilt-fragment naming convention so the strengthened fingerprint does not false-positive on them.

---

## Medium Findings (follow-up required)

- [ ] **Captured-Trace PII — F-3** `src/daemon/storage/client.ts:60` — gated SQL tracing can write captured PII (raw prompt/message bytes carried in an INSERT body) to stderr when `HONEYCOMB_TRACE_SQL` is explicitly enabled. Default is `false` (config.ts:56). Recommended follow-up: in `summarizeSql`, redact string/`E'...'` literal bodies (replace each literal with `'<redacted len=N>'`) before tracing, so an operator can debug statement *shape* without dumping captured content. Not fixed in-session: a correct literal-aware redactor is >5 lines and risks the verified trace-format ACs (a-AC-6); flagged for a scoped change.
- [ ] **Dependency (dev tree) — F-4** `package.json` — bump `vitest` + `@vitest/coverage-v8` to a line that pulls `esbuild` >0.28.0 (resolves GHSA-gv7w-rqvm-qjhr / GHSA-g7r4-m6w7-qqqr). `npm audit fix --force` resolves to vitest@4.x (a major bump) — route through `dependency-audit-worker-bee` / `ci-release-worker-bee` so the coverage config and test runner are re-verified rather than force-bumped blind. No production exposure.

---

## Low Findings (documentation only)

- [ ] **Configuration — F-5** `src/daemon/storage/vector.ts:181-199` — consider an explicit upper clamp on the resolved fetch limit (e.g. cap at a few thousand) as defense-in-depth against an internal caller passing an unbounded `limit`. Currently bounded only by the DeepLake server and the non-negative floor.

---

## Surface Integrity Check

| Check | Expected | Observed | Status |
|---|---|---|---|
| **SQL guards** (`src/daemon/storage/sql.ts`) | `sqlIdent` regex `^[a-zA-Z_][a-zA-Z0-9_]*$`; every interpolation wrapped | Confirmed; `sqlStr` doubles `\`/`'`, drops NUL/C0/C1/DEL, preserves `\t\n\r`; `sqlLike` layers `%`/`_`; `eLiteral`/`sLiteral` build literals; **new** `sqlColumnList` for projections | OK |
| **Projection lists via a helper** | `selectColumns` validated, not raw | Was raw (F-1) → now `sqlColumnList` | OK (fixed) |
| **`audit:sql` gate has teeth** | flags template + concat + projection bypasses | Was blind to projection (F-2) → now flagged; regression tests added | OK (fixed) |
| **Org scope forced on every query** | no `query(sql)` overload omitting org | `QueryScope.org` required; sent as `X-Activeloop-Org-Id` header (transport.ts:88) | OK |
| **Vector scope filter inline (e-AC-5)** | scope conjuncts in same WHERE as match | `buildScopeConjuncts` inline; cols via `sqlIdent`, vals via `sLiteral` | OK |
| **Schema-heal never DDLs on auth failure (c-AC-3)** | permission/auth → `other`, no CREATE/ALTER | `classifyFailure` forces auth msgs to `other` first; only `query_error` heals | OK |
| **DDL identifiers validated (c-AC-7)** | table + column through `sqlIdent` | `buildCreateTableSql` / `buildAddColumnSql` re-validate both | OK |
| **No token in logs / traces** | token never echoed | Token only in `Authorization` header; `redactToken` on org; never passed to any trace/error | OK |
| **Fail-closed config** | missing/bad config throws at init | zod `safeParse` → `StorageConfigError`; client built only after validation | OK |
| **Timeout race / no dangling promise** | timer cleared, signal removed | `clearTimeout` + listener removal in `finally`; fetch wired to abort signal | OK |
| **Limit/timeout clamps** | non-negative, bounded | `clampNonNegative`; timeout `[0, 600000]`; multiplier floor `>=1` | OK (upper-bound on limit: F-5 Low) |
| **OpenClaw bundle scan** | clean | exit 0, no findings | OK |

---

## Files Changed (remediation)

| File | Change Summary |
|---|---|
| `src/daemon/storage/sql.ts` | Added `sqlColumnList(list)` — validates `*` or a comma-separated identifier list via `sqlIdent`; throws on anything else. |
| `src/daemon/storage/writes.ts` | `readLatestVersion` & `readAppendOrdered` now route `selectColumns` through `sqlColumnList`; imported + re-exported the helper. |
| `src/daemon/storage/vector.ts` | Renamed `scoreExpr`→`scoreSql` and bound the float-array body to `numbersLit` (behavior-preserving) so the strengthened gate reads them as prebuilt fragments. |
| `src/daemon/storage/index.ts` | Exported `sqlColumnList` from the barrel. |
| `scripts/audit-sql-safety.mjs` | Strengthened `STATEMENT_FINGERPRINT` (additive `SELECT\s+\$\{`); registered `sqlColumnList` in `HELPER` + `SAFE_BINDING_RHS`. |
| `tests/daemon/storage/sql.test.ts` | +3 tests: `sqlColumnList` validation (b-AC-2), gate flags raw-projection bypass (b-AC-7 regression), gate passes helper-guarded projection. |

All six modified files are within the in-scope new files for this PRD (entire `src/daemon/storage/` and `scripts/audit-sql-safety.mjs` are new/untracked on this branch). The other storage modules (config, client, transport, heal, schema, result, fixture-tables) were **not** touched. Blast radius confirmed minimal.

---

## Verification (commands + exit codes)

| Command | Result |
|---|---|
| `node scripts/audit-sql-safety.mjs` | OK — "every SQL interpolation routes through an escaping helper" (exit 0) |
| `npm run ci` (typecheck + dup + test + audit:sql) | **exit 0** — typecheck clean, 0 jscpd clones, **69 tests passed** (was 66; +3), audit:sql clean |
| `npm run build` (`tsc && esbuild`) | **exit 0** — 1 daemon + 5 hook-harness + 1 OpenClaw + 1 MCP + 1 CLI + 1 embed bundle |
| `npm run audit:openclaw` | **exit 0** — bundle clean against ClawHub rules |
| `npm audit --omit=dev` | 0 vulnerabilities (production tree) |

**Gate-teeth proof:** a planted `SELECT ${cols} FROM "${t}"` projection bypass in a temp dir now exits non-zero (caught), whereas the identical shape passed (exit 0, undetected) before the F-2 fix.

---

## Recommended Follow-Up

1. **F-3** — implement literal-aware redaction in `summarizeSql` so `HONEYCOMB_TRACE_SQL` cannot leak captured PII; re-verify a-AC-6.
2. **F-4** — dependency bump of the vitest/vite/esbuild dev chain via `dependency-audit-worker-bee`.
3. The orchestrator should re-verify b-AC-7: the `audit:sql` gate's `STATEMENT_FINGERPRINT` and helper-recognizer sets were strengthened (teeth added, not weakened).

---

## Unresolved Critical/High

**None.** Both High findings (F-1, F-2) were remediated and verified in this session. The run is not blocked.

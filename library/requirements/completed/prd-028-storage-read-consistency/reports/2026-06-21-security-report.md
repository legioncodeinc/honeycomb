# Security audit — PRD-028 storage read-consistency (`readConverged`)

- **Branch:** `prd-028-storage-read-consistency`
- **Date:** 2026-06-21
- **Auditor:** security-worker-bee (security-stinger)
- **Scope:** the PRD-028 change set ONLY — the `readConverged` storage seam + watermark/predicate API + the migration of 5 live itests onto it. This is a low-external-surface STORAGE SEAM (no new SQL, no new network edge, no new credential path, no new dependency).
- **Verdict:** **PASS.** No Critical / High / Medium findings. Zero remediations required. The two load-bearing properties (D-5 *no secret in any trace* and *fail-soft, never invent*) are upheld and directly proven by the committed unit tests. Two Low / informational notes are pre-existing and out of this change set.

---

## Change set audited

| File | Kind | Verdict |
|------|------|---------|
| `src/daemon/storage/converge.ts` | NEW — the seam | CLEAN |
| `src/daemon/storage/index.ts` | exports only (additive) | CLEAN |
| `tests/daemon/storage/converge.test.ts` | NEW unit test (17 tests) | CLEAN |
| `tests/integration/read-converge-live.itest.ts` | NEW AC-3 live proof | CLEAN |
| `tests/integration/controlled-writes-live.itest.ts` | migrated onto seam | CLEAN |
| `tests/integration/graph-persist-live.itest.ts` | migrated onto seam | CLEAN |
| `tests/integration/ontology-{supersede,apply,deps}-live.itest.ts` | migrated onto seam | CLEAN |

`package.json` / `package-lock.json` are **not** in the diff — PRD-028 adds no dependency, so the supply-chain posture is unchanged by this branch.

---

## The four scoped audit axes

### 1. D-5 — NO SECRET IN ANY CONVERGENCE TRACE  (load-bearing) — UPHELD

The convergence trace is the only new logging surface. Every trace line in `readConverged` (`converge.ts:299, 307, 316, 325`) is built from exactly three ingredients:

- `redactToken(scope.org)` — the SAME redaction the client's `traceSql` uses (`config.ts:241`: keeps only `****`+last-4, collapses short values to `****` so length isn't leaked).
- `summarizeSql(sql)` — the SQL *shape* (whitespace-collapsed, truncated to 220 chars), mirroring `client.ts`'s `summarizeSql`.
- attempt counts / result `.kind` — integers and a union tag.

No row value, no `StorageRow`, and **no token** ever reaches a trace line. The token is never in scope here — `readConverged` receives a `StorageQuery` + `QueryScope` (org+workspace), never the credential. The trace is gated `opts.trace ?? HONEYCOMB_TRACE_SQL === "1"` (`converge.ts:285`) — off by default — and the sink is injectable.

**Proof:** `converge.test.ts:163-185` runs a trace-on pass over `SELECT token FROM secrets` with `org="secret-org-1234567890"` and asserts the emitted lines (a) never contain the full org, (b) never contain the substring `"secret-org"`, and (c) contain only the redacted `****7890`. `converge.test.ts:187-200` proves trace OFF by default emits nothing. PASS.

### 2. SQL injection — N/A (no new raw SQL) — CONFIRMED

`readConverged` issues **no SQL of its own**; it forwards the caller-built `sql` string to `client.query` (`converge.ts:303`). The watermark/predicate helpers (`watermarkPredicate`, `rowPresent`, `minRowCount`, `minVersion`) are pure — they read fields off a `StorageRow` and compare; they never interpolate into a string. Every read-back SQL in the 5 migrated itests is built through the `sqlIdent` / `sLiteral` guards (grep-confirmed: no unguarded `${...}` in any `SELECT`/`FROM`/`WHERE`). `npm run audit:sql` → **OK, 170 files, every interpolation routes through an escaping helper.** PASS.

### 3. Fail-soft — NEVER THROWS PAST THE CLOSED UNION, NEVER FABRICATES A ROW  (load-bearing) — UPHELD

The predicate is only ever evaluated against a **real** `QueryResult` the client produced (`converge.ts:303-306`) — the seam cannot conjure a row a backend never returned. On any non-converging path the function returns `last` / `result` / `finalResult`, each of which is a value `client.query` actually yielded (`converge.ts:308, 316, 326`). A transport failure is a non-ok union member; the predicate builders all return `false` for `!isOk(result)` (`converge.ts:402, 419, 431, 441`), so a failure can never be mistaken for "fresh" — the budget governs and the last real non-ok result is surfaced. The function's return type is `Promise<QueryResult>` and there is no `throw` on any path.

**Proof:**
- `converge.test.ts:103-125` (AC-2): a never-converging fake returns the LAST real `ok` (not the awaited row), asserts `rows.some(r => r.id === "row-1") === false` — no fabrication.
- `converge.test.ts:146-161`: a `connection_error` result → predicate false → budget governs → returns that exact non-ok result, no throw/hang.
- Live: `read-converge-live.itest.ts:242-263` asserts a never-written ghost id returns a real result within budget and `invented === false`.

PASS.

### 4. DoS — BOUNDED BUDGET, NO UNBOUNDED POLL / NO MISSING WALL-CLOCK CAP — CONFIRMED

The poll loop is hard-bounded on TWO independent axes:
- **Attempt cap** — `for (attempt = 1; attempt <= budget.maxAttempts; attempt++)` (`converge.ts:302`), `maxAttempts` clamped to a floor of `1` (`converge.ts:168`).
- **Wall-clock cap** — a deadline marked once off the injected clock (`converge.ts:296-297`); before each backoff sleep, `clock.now() + wait > deadline` short-circuits and returns (`converge.ts:315`).
- **Backoff is capped** — `backoffFor` is `min(base * 2^(n-1), cap)` with full jitter (`converge.ts:244-247`), de-correlating a fleet of pollers so they don't re-stampede the backend in lockstep.

Every env knob is coerce-and-clamped (`clampInt`, `converge.ts:112-116`) — a fat-fingered `HONEYCOMB_READ_CONVERGE_*` value falls back to its default or clamps to a floor and **never throws**, so a bad env is tuning noise, not a daemon-down config failure. The cap-floored-at-base rule (`converge.ts:171`) prevents an inverted (cap<base) pair from breaking the backoff math.

**Proof:** `converge.test.ts:103-125` (attempt cap == maxAttempts, `now() <= maxWallClockMs`), `converge.test.ts:127-144` (wall-clock stops it well before a 100-attempt cap), `converge.test.ts:262-287` (budget resolution clamps garbage / floors / never throws). PASS.

---

## Captured-trace / PII catalog (itest logging review)

The migration must not introduce a path that logs a row VALUE, token, or full org.

- `read-converge-live.itest.ts` — token read **only** via `envCredentialProvider` (never hardcoded/echoed). Its `describeResult` helper (`:266-278`) deliberately emits only row **count** and error kind/message — never a row value. The MISS / evidence logs (`:217, :232`) print only synthetic ids (`mem_conv_<runId>_<i>`), poll counts, and miss totals — no row content, no secret. Throwaway table `ci_converge_<runId>` with `DROP` teardown; gated `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)`.
- The migration to `readConverged` in the 5 itests swapped the **wait mechanism** only (hand-rolled `SCAN_POLLS` / `scanDistinct` / `for(let poll…)` loops → `readConverged`). Grep confirms **zero** leftover ad-hoc poll loops (AC-4). The migration added no new log statement.

**No PII/secret leak introduced by this change set.** PASS.

---

## Findings

### Critical — none detected.
### High — none detected.
### Medium — none detected.

### Low / informational (PRE-EXISTING, OUT OF SCOPE — recorded, not remediated)

- **L-1 — `JSON.stringify(res)` in itest cleanup-warning logs.** `graph-persist-live.itest.ts:160`, `ontology-supersede-live:115`, `ontology-apply-live:110`, `ontology-deps-live:130` serialize a `QueryResult` in a DROP-failed cleanup warning. Each is guarded by `if (!isOk(res))`, so `res` is a `query_error`/`connection_error`/`timeout` union member — it carries only `message`/`status`/`timeoutMs`, **no rows and no token**. Not a leak. These lines pre-date PRD-028 (not in the branch diff) and are out of this audit's scope; noted only for completeness.
- **L-2 — `liveLogger` seam in `graph-persist-live.itest.ts:73-80`.** A `JSON.stringify(fields)` stderr logger passed into the production `persistGraphEntities` seam. Pre-existing (PRD-005 code, untouched by PRD-028's mechanism swap); the production code controls the fields. Out of scope.

Neither rises to a finding against THIS change set. If a future hardening pass wants belt-and-suspenders, route `QueryResult` logging through the existing redaction-safe `describeResult` summarizer that `read-converge-live` and `controlled-writes-live` already use — that is a cleanup, not a vulnerability.

---

## Gate results

| Gate | Result |
|------|--------|
| `npm run audit:sql` | **OK** — 170 files, every SQL interpolation routes through an escaping helper |
| `npm run audit:openclaw` | **OK** — bundle clean against ClawHub static-analysis rules |
| `npm audit` | 10 vulns (6 low / 3 moderate / 1 high) — **pre-existing**, `package*.json` unchanged by this branch; belongs to dependency-audit-worker-bee, not this surface |
| `npx tsc --noEmit` | **clean** |
| `npx vitest run tests/daemon/storage/converge.test.ts` | **17/17 passed** |
| AC-4 grep (no leftover hand-rolled poll loops) | **clean** in all 5 migrated files |

No `git add` performed. No source changed by this audit (no remediation was required).

---

## One-paragraph verdict

**PASS — no fixes applied (none required).** The PRD-028 change set is a tightly-scoped, defensively-written storage seam. The two load-bearing security properties hold and are proven by committed tests: D-5 (the convergence trace redacts the org through the same `redactToken` discipline as the client, never carries a token, and never emits a row value — `converge.test.ts:163-185`), and fail-soft-never-invent (the predicate is only ever evaluated against a real `QueryResult`, the function returns the last real read on every exhaustion path, and never throws past the closed union — `converge.test.ts:103-161`). The seam adds no raw SQL (`audit:sql` green), the poll budget is hard-bounded on both attempt-count and wall-clock with coerce-and-clamp env knobs that cannot DoS or crash the daemon, and the new live itest reads the token only via the gated credential provider into a throwaway DROP-teardown table while logging only synthetic ids and counts. The 5 migrated itests swap only the wait mechanism, build all read-back SQL through the `sqlIdent`/`sLiteral` guards, and introduce no new logging. Cleared to proceed to quality-worker-bee.

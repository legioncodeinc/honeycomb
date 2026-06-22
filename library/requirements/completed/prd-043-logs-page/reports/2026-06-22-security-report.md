# Security Audit — PRD-043 (Logs Page)

- **Auditor:** security-worker-bee (security-stinger)
- **Date:** 2026-06-22
- **Branch:** `feat/prd-043-logs-page`
- **Scope:** the uncommitted PRD-043 implementation — durable `node:sqlite` log store, `GET /api/logs/history`, write-through `RequestLogger`, the `#/logs` page (history + live tail + turns drill-down), the extended `fetchSessionsView` paging, and the daemon-spawn `--experimental-sqlite` plumbing.
- **Files reviewed:** `src/daemon/runtime/logs/log-store.ts` (new), `src/daemon/runtime/logs/api.ts`, `src/daemon/runtime/logs/index.ts`, `src/daemon/runtime/logger.ts`, `src/daemon/runtime/assemble.ts`, `src/daemon/runtime/dashboard/api.ts`, `src/daemon/runtime/scope.ts`, `src/daemon/storage/sql.ts`, `src/cli/runtime.ts`, `src/dashboard/web/pages/logs.tsx`, `src/dashboard/web/wire.ts`, `package.json`, `vitest.config.ts`, `vitest.integration.config.ts`.

---

## Verdict: **PASS**

No Critical or High findings. The implementation was written with the threat model in mind: every SQL VALUE is a bound `?` parameter, every identifier routes through `sqlIdent`, the durable schema is structurally incapable of holding a secret, the history endpoint inherits the protected group's auth/RBAC, the turns drill-down is metadata-only and injection-proof, the daemon-spawn flag is a hardcoded constant, fail-soft paths leak nothing, and resource use is bounded. **Zero in-place remediations were required** — the working tree is unchanged from what was handed in.

### Ordering note (pre-flight)
No `*-qa-report.md` exists for this branch (`library/qa/` and `prd-043-.../qa/` are empty of reports). The audit ran in the correct order — **before** quality-worker-bee. No ordering inversion.

---

## Deterministic gates

| Gate | Command | Result |
|---|---|---|
| SQL-safety audit | `npm run audit:sql` | **PASS** — scanned 204 files, every interpolation routes through a helper |
| OpenClaw bundle scan | `npm run audit:openclaw` | **PASS** — 0 findings against ClawHub rules |
| Rules-file Unicode scan | scan.sh step 3 | **PASS** — no zero-width / bidi codepoints |
| Production dependency audit | `npm audit --omit=dev --audit-level=high` | **PASS** — 0 vulnerabilities (PRD-043 adds NO dependency; `node:sqlite` is built-in) |
| Full CI (tsc + jscpd + vitest) | `npm run ci` | **PASS** — 232 files, 2546 passed, 6 skipped, 0 failures |
| Build (tsc + esbuild) | `npm run build` | **PASS** — all bundles built @ 0.1.0 |

The flagged `api.test.ts` load-flake did not surface; the full suite was green in one pass.

> npm audit (full tree) reports 1 high + 3 moderate, but `--omit=dev` shows **0** — all advisories are dev-only dependencies, out of the production/publish path and unrelated to this PRD. Not ship-blocking per the CVE-tracker rubric (block only on Critical/High in production deps).

---

## Findings by audit-focus item

### 1. SQL injection — store + history query — **None detected**
- `log-store.ts` runs on `node:sqlite`, which binds real `?` parameters. Every VALUE rides a bound `?`:
  - `appendRequest`/`appendEvent` (`log-store.ts:335-344`, `:356-357`) — all record fields via `.run(...)`.
  - `runHistoryQuery` (`log-store.ts:397-436`) — `since`/`until`/`status` range/`path` LIKE/`org`/`cursor` and `LIMIT` all pushed onto `params` and bound; the WHERE is assembled purely from `<sqlIdent> <op> ?` fragments.
  - `prune` (`log-store.ts:461-481`) — `cutoffIso` and `maxRows` (the OFFSET) are bound.
- Every IDENTIFIER (table/column/index names) routes through `sqlIdent` (`log-store.ts:259-287`), which rejects anything outside `^[a-zA-Z_][a-zA-Z0-9_]*$` (`src/daemon/storage/sql.ts:80-85`).
- **`status` class** (`5xx`): `parseStatusFilter` (`api.ts:169-177`) regex-validates to a 1-digit bucket or 3-digit code; mapped to a half-open `>= ? AND < ?` integer range (`log-store.ts:289-295`) — no string reaches SQL.
- **`path` prefix LIKE**: `escapeLikePrefix` (`log-store.ts:515-519`) escapes `\`, `%`, `_` in the bound value before appending the `%`, so a literal `/api/foo_bar` filters the underscore, not "any char". The `%` is appended to the bound parameter, never to SQL text.
- **Opaque `cursor` decode**: `decodeCursor` (`log-store.ts:527-539`) fails closed — any malformed base64url/JSON, or a `beforeId` that is not a positive integer, returns `undefined` → the query runs as the newest page. A crafted cursor cannot inject (it only ever yields a validated integer bound as `?`) and cannot crash (try/catch).

### 2. Secret-on-disk invariant — **None detected (structurally enforced)**
- `request_log` columns (`log-store.ts:262-273`) are 1:1 with `RequestLogRecord` (`logger.ts:20-37`): `id, time, method, path, status, duration_ms, mode, org, workspace`. **No** `headers`/`token`/`authorization`/`body` column exists. `appendRequest` only reads those record fields, so the table cannot persist a secret the record type does not carry.
- `event_log` (`log-store.ts:279-285`) is 1:1 with `EventLogRecord`: `id, time, event, fields`. The `fields` JSON bag is the **same caller-scrubbed coarse state** the in-memory stderr logger already wrote (`logger.ts:124-135`) — PRD-043a persists it, it does **not** widen it. All 30+ `logger.event(...)` call sites pass only subsystem state (`pid`, `code`, `reason`, `status`, `id`, `kind`, dims, counts) — no token, header, body, prompt, or org GUID. `path` (request path) carries no query string by contract (`logger.ts:25`).
- **DB path**: fixed under `baseDir/.daemon/logs.db` from the hardcoded `DAEMON_DIR_NAME`/`LOG_DB_FILE_NAME` constants (`log-store.ts:44-47, 224-234`); `baseDir` is `$HONEYCOMB_WORKSPACE` (or cwd). No user/request input feeds the path — no traversal.

### 3. History endpoint auth/RBAC + local-gate — **None detected**
- `GET /api/logs/history` attaches onto the already-mounted `daemon.group("/api/logs")` (`api.ts:186-229`), which is `protect:true` in `server.ts`. It inherits the exact same auth/RBAC + local gate as the `/api/logs` snapshot and `/api/logs/stream` — it is **not** a new unauthenticated route. The composition root fires `mountLogs` onto that group (`assemble.ts:623`).
- A non-persistent (fail-soft no-op) store returns an empty page with `persistent:false` — never a 404 or throw, so the gate posture is identical whether or not persistence is available.

### 4. Turns drill-down — **None detected**
- The extended `fetchSessionsView` (`dashboard/api.ts:355-388`) still targets `sessions` by `sqlIdent("sessions")`. The new cursor predicate binds only `sLiteral(before.creationDate)` / `sLiteral(before.id)` (`:353-355`) — `sLiteral` wraps in `'${sqlStr(v)}'`, doubling backslashes/quotes, so a crafted `decodeSessionsCursor` token cannot inject. `decodeSessionsCursor` (`api.ts` diff) fails closed on any malformed token. `fetchLimit` is `limit+1` where `limit ∈ [1, MAX_SESSIONS_LIMIT]` — a clamped integer, not attacker-controlled string.
- Tenancy: the endpoint sits on the protected `/api/diagnostics/sessions` group; `resolveScope` → `resolveScopeOrLocalDefault` enforces the cross-tenant guard (a forged `x-honeycomb-org` that disagrees with the validated `identity.org` → `null` → fail-closed, `scope.ts:54-91`). The paging change passes `scope` to `storage.query(sql, scope)` unchanged, so tenancy partitioning is not weakened.
- Surfaced turn detail is **metadata-only** (`logs.tsx:340-364`): turn id, project, timestamp, event count, status. No transcript/JSONB/body/secret column is selected (`SELECT id, project, creation_date, path`) or rendered.
- **XSS**: every log line and turn field renders as inert React text children (`logs.tsx`). No `dangerouslySetInnerHTML` anywhere on the page. Wire values are zod-parsed with `.catch()` defaults (`wire.ts`).

### 5. Daemon-spawn flag / NODE_OPTIONS plumbing — **None detected**
- `DAEMON_NODE_FLAGS = ["--experimental-sqlite"]` is a hardcoded module constant (`cli/runtime.ts:105`), spread into `spawn(process.execPath, [...DAEMON_NODE_FLAGS, entry], ...)` (`:169`). No env/user input is interpolated into the argv — no argument injection. The vitest `execArgv` flag (`vitest.config.ts`, `vitest.integration.config.ts`) is likewise a hardcoded array.

### 6. Fail-soft cannot leak — **None detected**
- The once-logged open/append/prune failure messages (`log-store.ts:202, 486`) carry only the error `.message` prefixed with a generic "log persistence/store … unavailable (non-fatal)" — no token, no record content, no credential path beyond the fixed `.daemon/` location the logger already discloses. Failures are logged exactly once (`defaultOnceFailure`, `:209-216`), so no per-request spam.

### 7. DoS / resource — **None detected**
- Retention bounds the file: row cap (default 100k) AND age cap (default 30 days), pruned opportunistically every 256 writes plus a startup sweep (`log-store.ts:54-59, 447-481`).
- The history `limit` is clamped to `[1, MAX_HISTORY_LIMIT=1000]` in both the API parser (`api.ts:147-152`) and the store (defensive). The turns `limit` is clamped to `[1, MAX_SESSIONS_LIMIT=500]` (`dashboard/api.ts`). A pathological filter still runs against the indexed `time`/`status`/`path` columns with a bounded `LIMIT` — no unbounded scan or return.

---

## Other catalog categories (confirmed checked)

- **Credential / token handling:** None detected. The token is never logged; `cli/runtime.ts` stamps only org/workspace/actor ids into headers; the shared `~/.deeplake/credentials.json` 0600 discipline and the C-1 no-clobber guard are unchanged by this PRD.
- **Pre-tool-use gate / VFS:** Not touched by PRD-043. None detected.
- **Prompt-injection surface (recall/skillify):** Not touched by PRD-043. None detected.
- **Rules-file backdoor (Unicode):** None detected (scan clean).
- **Supply chain:** None detected. No dependency added (`node:sqlite` is built-in, zero ABI/postinstall risk); OpenClaw bundle clean; `gate-runner.ts` bypasses untouched.
- **Capture opt-out (`HIVEMIND_CAPTURE`):** Not in this PRD's path. None detected.

---

## Files changed by this audit

**None.** No Critical/High/cheap-Medium remediation was required. The working tree contains only the PRD-043 implementation as handed in (plus the gitignored `.scan-output/` scratch dir). `git diff --diff-filter=D` shows **zero deletions**; `git status -- assets/` is **empty**.

## Residual risk

- **Low / informational (not fixed — out of scope, no patch warranted):** the production npm tree is clean, but the full (incl-dev) tree carries 1 high + 3 moderate advisories in dev dependencies. These predate this branch and never ship. Recommend `dependency-audit-worker-bee` triage them on its own cadence; not a blocker for PRD-043.
- The turns query relies on the storage client's `scope` partitioning for `sessions` tenancy (no explicit `org_id =` in the SELECT) — this is the **pre-existing** `fetchSessionsView` contract, unchanged by the paging additive; flagged only for traceability, not a finding.

**Gate status: cleared for quality-worker-bee.**

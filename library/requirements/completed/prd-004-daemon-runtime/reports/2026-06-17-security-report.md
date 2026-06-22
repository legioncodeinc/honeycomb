# PRD-004 Daemon Runtime — Security Audit & Remediation

- **Auditor:** security-worker-bee (security-stinger)
- **Date:** 2026-06-17
- **Branch:** `prd-004-daemon-runtime`
- **Scope:** the daemon runtime — `src/daemon/runtime/**`, `src/daemon/storage/catalog/runtime-jobs.ts`, `src/daemon/storage/writes.ts` (new `buildInsert`/`renderValue`), `src/daemon/index.ts`, `tests/daemon/runtime/**`, `tests/integration/memory-jobs-live.itest.ts`, `scripts/audit-sql-safety.mjs`. Excludes `hivemind-v1/` / `otherhive-v1/` (gitignored reference dirs).
- **Ordering:** Clean. No `*-qa-report.md` exists for PRD-004 (the in-work QA reports cover PRD-001/002/003). security-worker-bee ran BEFORE quality-worker-bee as required.

## Executive Summary

Two High-severity findings remediated in-session; no Critical findings; the rest of the runtime surface is clean. The HTTP bind, permission seam, runtime-path 409 contract, job-queue SQL, and structured logging all hold up.

- **H-1 (FIXED):** The `audit:sql` CI gate scanned ONLY `src/daemon/storage`, leaving the job queue's hand-built SQL in `src/daemon/runtime/services/job-queue.ts` entirely ungated. Widened the default scan scope to the whole `src/daemon` tree, and fixed a recognizer false-positive (`${this.tbl()}`) that surfaced when widening — without re-narrowing scope. Teeth re-proved: a planted raw-interpolation bypass in the runtime path is now flagged.
- **H-2 (FIXED):** The git auto-commit shelled `git add -A`, staging the entire working tree. A secret living in the repo (a `.env`, a token file, `credentials.json`) would be auto-committed into git history by the identity sync. Replaced with explicit, bounded pathspec staging (`git add -- <identity-files>`), added a security regression test, and proved the test catches the vulnerable behavior.

Manual review confirmed the job-queue SQL is genuinely guarded (every identifier via `sqlIdent`, every value via `sLiteral`/`renderValue`/`buildInsert`), so H-1 was a gate-coverage gap, not a live injection. All four gates green after remediation; 206 unit tests pass (+1 new security regression test).

**Unresolved Critical/High: NONE.** The run is not blocked.

## Findings Table

| ID | Severity | File:Line | Issue | Status |
|----|----------|-----------|-------|--------|
| H-1 | High | `scripts/audit-sql-safety.mjs:41` (scope) + job-queue runtime path | `audit:sql` gate scoped to `src/daemon/storage` only; runtime job-queue SQL ungated | **FIXED** |
| H-2 | High | `src/daemon/runtime/services/git-sync.ts:49` (pre-fix `git add -A`) | Auto-commit staged whole working tree; a stray secret in the repo gets committed | **FIXED** |
| M-1 | Medium | `src/daemon/runtime/middleware/runtime-path.ts:131` | Claim map has TTL+sweep but no hard cap on distinct concurrent sessions between sweeps | **RECOMMENDED** |
| I-1 | Info | `src/daemon/runtime/services/job-queue.ts` (discovery scans) | Full-table `SELECT DISTINCT id` discovery cost grows with table size | **RECOMMENDED** |

## Critical / High Findings — Detail

### H-1 — SQL-safety gate did not cover the runtime job-queue SQL (High)

**Evidence.** `scripts/audit-sql-safety.mjs` defaulted `SCAN_DIR` to `src/daemon/storage`, and `package.json` invokes `"audit:sql": "node scripts/audit-sql-safety.mjs"` with no dir argument. The job queue at `src/daemon/runtime/services/job-queue.ts` hand-builds SQL (`discoverIds`, `latestById`, `deleteAllForId`, plus the `buildInsert` appends) but lives under `src/daemon/runtime` — outside the scanned tree. Baseline proof:

```
$ node scripts/audit-sql-safety.mjs           # default
SQL-safety audit: scanned 19 file(s) under src/daemon/storage/
OK - every SQL interpolation routes through an escaping helper.
```

The runtime path was never scanned by CI. Pointing the existing gate at the runtime produced **3 false positives** on `${this.tbl()}` — a method that returns `sqlIdent(this.cfg.tableName)`, i.e. genuinely safe, that the helper-name regex could not see through.

**Manual verification of the queue SQL (the real question behind the gate).** Every identifier in `job-queue.ts` routes through `sqlIdent` (`this.tbl()` → `sqlIdent(this.cfg.tableName)`; `STATE_COLUMNS.map(c => sqlIdent(c))`; `sqlIdent("id")`, `sqlIdent("version")`). Every value routes through `sLiteral(id)` or through `buildInsert(...)` → `renderValue` → `sLiteral`/`eLiteral` (`src/daemon/storage/writes.ts`). The JSONB `payload` is rendered via `val.text(...)` → `eLiteral` (escape-safe `E'...'`), so a poison payload cannot break out of the literal. The config-driven `tableName` is validated through `sqlIdent` on every use. **No live injection** — H-1 is a gate-coverage gap, not an exploitable bypass.

**Fix.** Per the required-fix instruction (widen scope; if a false positive surfaces, fix the recognizer — do NOT re-narrow):
1. Widened the default scan scope from `src/daemon/storage` to `src/daemon` (the whole daemon), so every daemon SQL builder is gated. CI always runs the wide default.
2. Added a `collectSafeMethods` recognizer pass: a same-file method/getter whose body is `return <safe-helper-expr>` (no raw concatenation) is recorded, so `${this.tbl()}` is recognized as pre-escaped. Precise, not a blanket pass — a `this.<method>()` with no safe-method definition is still flagged.

**Proof of resolution.**

```
$ npm run audit:sql
SQL-safety audit: scanned 31 file(s) under src/daemon/
OK - every SQL interpolation routes through an escaping helper.          # exit 0
```

Teeth (planted raw-value bypass in the runtime path):

```
$ # job-queue.ts DELETE rewritten to `WHERE id = ${id}` (raw)
x [BYPASS] raw interpolation of `id` into a SQL string
    src\daemon\runtime\services\job-queue.ts:740                          # exit 1
```

Teeth (planted unsafe method call — proves the recognizer is precise, not a blanket `this.x()` pass):

```
$ # `${this.rawId()}` (no safe-method definition)
x [BYPASS] raw interpolation of `this.rawId()` into a SQL string         # exit 1
```

The planted bypasses were reverted; `job-queue.ts` is byte-identical to its baseline (`git diff --stat` empty).

### H-2 — Git auto-commit staged the whole working tree (`git add -A`) (High)

**Evidence (pre-fix).** `src/daemon/runtime/services/git-sync.ts:49`:

```ts
await execFileAsync("git", ["add", "-A"], { cwd: workspaceDir });
```

`gitStageAndCommit` is the auto-commit the file watcher fires whenever an identity file changes (`file-watcher.ts` `runSyncCycle`). `git add -A` stages **every** changed/new file in the repo, not just the identity files the watcher manages. If a secret lives in `repoDir`/`workspaceDir` — a `.env`, a token file, a stray `credentials.json` — and it is not gitignored, the identity sync would auto-commit it into git history (and a downstream push automation would publish it). Per the never-downgrade rule, an auto-commit path that can capture credential material is a credential-exposure vector → **High**.

The command form itself is safe against shell/command injection: it uses `execFile` with fixed argv (no shell), and the commit message is a controlled `chore: identity sync <ISO-timestamp>` string. The vulnerability is the unbounded staging scope, not injection.

**Fix (minimal blast radius).**
- `git-sync.ts`: `GitCommitOptions` gains a required `pathspecs: readonly string[]`; staging is now `git add -- <pathspecs>` (the `--` separator + fixed argv keeps each filename a path, never an option or shell token). `git add -A` is gone. An empty pathspec list short-circuits to `nothing-to-commit`.
- `file-watcher.ts`: added `managedPathspecs(repoDir)` — the bounded, repo-relative set the watcher is allowed to stage: the canonical identity files, `extraWatchPaths`, and harness copy outputs that fall INSIDE the repo. Paths outside the repo (`..`-prefixed) are dropped; only files that currently exist on disk are staged (a never-created canonical file would otherwise abort the whole `git add`). Anything else in the tree — including a stray secret — is never in the set, so it cannot be auto-committed.

**Proof of resolution.** New regression test `tests/daemon/runtime/services/file-watcher.test.ts` — "does NOT auto-commit an unrelated secret file sitting in the repo": writes `AGENTS.md`, `.env`, and `credentials.json` into the repo, triggers a sync, and asserts `AGENTS.md` is committed while `.env` and `credentials.json` are NOT tracked at HEAD. It passes with the fix and FAILS when staging is reverted to the whole tree (verified by temporarily forcing `pathspecs = ["."]`):

```
$ npx vitest run ... -t "secret"            # with whole-tree staging
AssertionError: expected [ 'AGENTS.md', '.env', 'credentials.json' ] not to contain 'credentials.json'   # exit 1
$ npx vitest run ... file-watcher           # with the fix
Tests  14 passed (14)                                                                                     # exit 0
```

## Focus-Area Coverage (each item checked)

1. **HTTP bind / exposure (`config.ts`, `listen.ts`):** Clean. Default `127.0.0.1` loopback; widening requires an explicit `HONEYCOMB_BIND` (never accidental — `HONEYCOMB_HOST` alone defaults to loopback), and a widened bind is flagged `widened: true`. Invalid binds (URL, whitespace, empty) FAIL CLOSED with `RuntimeConfigError` (zod-at-boundary). Tested in `config.test.ts` (a-AC-1). No SSRF/unauthenticated-exposure footgun. No finding.
2. **Permission middleware (`middleware/permission.ts`):** Clean. `local` is open by design; `team`/`hybrid` enforce BEFORE the handler with `defaultDenyPermissionCheck` (unknown role/missing policy → 403, never waved through). The bearer token is intentionally not read or stored in this seam. Header-asserted role is a stand-in for the real auth module (a later PRD) — the SEAM is fail-closed, which is what 004a owns. No finding.
3. **Runtime-path middleware (`middleware/runtime-path.ts`):** Clean on the 409 contract. Missing/invalid `x-honeycomb-runtime-path` or missing `x-honeycomb-session` → 400 without `next()`; a claim conflict → 409 without `next()`; a claim-service throw → 503 without `next()` (fail closed). Mounted ahead of permission so the reject fires before any session handler/capture write. Claim map is TTL-bounded (4h) with a ~5min sweep + lazy expiry, and the sweep timer is `unref()`'d. See M-1 for the residual unbounded-distinct-session note.
4. **Job queue (`services/job-queue.ts`):** SQL fully guarded (see H-1 manual verification). A poison JSONB payload is rendered via `eLiteral` (`E'...'`) and cannot break out. The reaper/lease/discover loops are all bounded (`LEASE_CANDIDATE_TRIES`, `RESOLVE_POLLS`, `DISCOVER_POLLS` constants; reaper on a fixed interval) — no path drives unbounded resource use. See I-1 for a scalability (not security) note.
5. **File watcher + git (`services/file-watcher.ts`, `git-sync.ts`, `harness-sync.ts`):** H-2 (secret staging) fixed. Command injection: NONE — `execFile` fixed argv, no shell, controlled commit message. Path traversal in the watched-file→harness-copy rendering: NOT present — harness output paths come only from injected `HarnessTarget.outputPath` (operator/connectors-registry controlled), never derived from a watched filename; canonical filenames are a fixed allowlist. No finding beyond H-2.
6. **Secrets/PII in logs (`logger.ts`):** Clean. The per-request record is method/path (no query string)/status/duration/mode/resolved org/workspace — never headers, the bearer token, or a request body. Logs to stderr (never stdout). The watcher and queue loggers record event names + ids/counts, not payloads. No finding.
7. **Supply chain (`hono`, `@hono/node-server`):** Clean. `npm audit --omit=dev` → `found 0 vulnerabilities`. OpenClaw bundle scan clean.

## Other Findings (documented, not fixed in-session)

### M-1 — Claim map has no hard cap on distinct concurrent sessions (Medium, RECOMMENDED)

`createRuntimePathService` (`runtime-path.ts:131`) stores claims in an unbounded `Map<string, ClaimEntry>`. TTL (4h) + the ~5min sweep + lazy expiry bound growth over time, but between sweeps a flood of unique `x-honeycomb-session` values (the middleware runs ahead of permission, so in `team`/`hybrid` an attacker reaching the seam can mint many sessions) could grow the map. Memory pressure only, session-scoped, self-healing within the sweep window. **Recommendation:** add a max-entries cap (evict oldest `claimed_at` on overflow) or shorten the sweep cadence under load. Not fixed — exceeds the <5-line Medium bar and touches the 004d-owned service contract; flag for the 004d follow-up.

### I-1 — Discovery scans are full-table (Info, RECOMMENDED)

`discoverIds` issues `SELECT DISTINCT id FROM "<table>"` and resolves each id; cost grows with the append-only row count until retention purges. This is a known, deliberate trade-off documented in the module (the append-only convergence design) and is a scalability concern, not a security one. **Recommendation:** ensure the retention purge (`purgeRetained`) is wired on a real cadence by the retention module so the table stays bounded. No security action.

## Files Changed

| File | Change | Lines |
|------|--------|-------|
| `scripts/audit-sql-safety.mjs` | Widen default scan to `src/daemon`; add `collectSafeMethods` recognizer for `this.<method>()` safe sources | +71 / −4 |
| `src/daemon/runtime/services/git-sync.ts` | Replace `git add -A` with bounded `git add -- <pathspecs>`; add required `pathspecs` option | ~+30 |
| `src/daemon/runtime/services/file-watcher.ts` | Add `managedPathspecs(repoDir)`; pass bounded pathspecs to `gitStageAndCommit` | ~+30 |
| `tests/daemon/runtime/services/file-watcher.test.ts` | Add secret-not-committed security regression test + `trackedFilesAtHead` helper | ~+50 |

`src/daemon/runtime/services/job-queue.ts` and `src/daemon/storage/catalog/runtime-jobs.ts` were reviewed and left UNCHANGED (job-queue.ts verified byte-identical to baseline after teeth-testing).

## Gate Results (post-remediation)

| Gate | Command | Result |
|------|---------|--------|
| Full CI | `npm run ci` | PASS — 206 tests, 19 files (exit 0) |
| Build | `npm run build` | PASS — 1 daemon + 5 hook-harness + 1 OpenClaw + 1 MCP + 1 CLI + 1 embed-daemon bundle (exit 0) |
| SQL safety (widened) | `npm run audit:sql` | PASS — scanned 31 files under `src/daemon/` (exit 0) |
| OpenClaw bundle | `npm run audit:openclaw` | PASS — no findings (exit 0) |
| Prod deps | `npm audit --omit=dev` | PASS — 0 vulnerabilities |

Test count: **206** (was 205; +1 security regression test). No previously-VERIFIED AC regressed (config, server, runtime-path, job-queue, file-watcher, stubs suites all green).

**Live queue suite:** NOT re-run. `job-queue.ts` was not modified (byte-identical to baseline), so the live-DeepLake determinism is unaffected by this audit; the live suite (`npm run test:integration`, gated on `.env.local`) was out of scope to re-run since no queue code changed.

## Unresolved Critical/High

**NONE.** Both High findings (H-1, H-2) are FIXED with proof. The run is not blocked on security.

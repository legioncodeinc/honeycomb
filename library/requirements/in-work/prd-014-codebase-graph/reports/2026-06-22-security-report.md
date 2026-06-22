# Security Audit Report: PRD-014 graph-build wiring (Track 1)

**Audit date:** 2026-06-22
**Auditor:** security-worker-bee subagent
**Scope:** the PRD-014 graph-build daemon-assembly wiring diff — `src/daemon/runtime/codebase/api.ts` (NEW), `src/daemon/runtime/codebase/identity.ts` (NEW), `src/daemon/runtime/assemble.ts` (M), `src/daemon/runtime/codebase/index.ts` (M), plus the two new test files. Adjacent pre-existing modules read for trust-chain verification: `push-pull.ts`, `snapshot.ts`, `scope.ts`, `storage/sql.ts`.
**Node version audited:** >=22 (ESM)
**`npm audit` result:** 1 High (`tmp` path-traversal/symlink — pre-existing transitive dep, NOT introduced by this diff), 3 moderate, 6 low. No Critical. Out of scope for this wiring diff (no new deps added); owned by dependency-audit-worker-bee.
**OpenClaw bundle scan:** not re-run (diff touches no OpenClaw bundle surface); prior PRD-014 audit reported clean.
**CVE watchlist last refreshed:** not re-read this session (diff adds no dependencies). No staleness flag raised.

---

## Executive Summary

The PRD-014 graph-build wiring is a clean, defense-aware diff. The single most security-relevant primitive — the `git` subprocess probes in `identity.ts` — is implemented correctly: `execFileSync("git", [...args])` with a **fixed argv array and no shell**, no request-controlled value interpolated into any git command, and every probe failure swallowed to a typed default. Tenancy/authz on the two new endpoints inherits the already-mounted `protect:true` `/api/graph` route group and resolves scope through the shared `resolveScopeOrLocalDefault` (header-wins with a cross-tenant identity guard, local-default only in local mode, fail-closed 400 otherwise). The push path routes every identifier through `sqlIdent` and every value through `sLiteral`/`val.*`/`buildInsert`; `npm run audit:sql` is clean. Build errors are caught and returned as a contained 500 data body, never an unhandled throw.

**Findings: 0 Critical, 0 High, 1 Medium (fixed in-session, <5-line exception), 0 Low.** The one finding is a defense-in-depth path-safety gap: the `commit` field — which names a snapshot file (`<commit>.json`) and is now reachable from the live `POST /api/graph/build` endpoint for the first time — flowed from `git rev-parse HEAD` to the filesystem path layer **unvalidated**, while the sibling `repo` key was already defensively sanitized. Realistic exploitability is low (git's own output contract emits only a hex OID for a resolved commit), but the asymmetry was closed: `commit` is now pinned to the git-OID shape at the resolution boundary, collapsing any non-conforming value to `""` (which the push self-skips and the local write names by sha256). No credential or captured-trace PII exposure was found in this diff.

**Ordering note:** the committed QA report at `reports/2026-06-18-qa-report.md` predates this uncommitted wiring diff (it explicitly records the daemon-assembly wiring as a *deferred* item and that security ran first in that cycle). I ran BEFORE the next QA, which is the correct order — but because that QA report does **not** cover these new files, **`quality-worker-bee` must re-run** after this audit to verify the now-landed wiring against the plan.

---

## Scorecard

| Category | Status | Findings |
|---|---|---|
| Credential / Token Exposure | OK | 0 |
| Captured-Trace PII (sessions/memory) | OK | 0 |
| Authentication & Org RBAC / Scope | OK | 0 |
| Injection (Deep Lake SQL API) | OK | 0 |
| Command/Argument Injection (git probes) | OK | 0 |
| Path Safety (snapshot read/write) | ATTN | 1 (Medium, fixed) |
| Resource / DoS & Error Handling | OK | 0 |
| Dependency & OpenClaw Bundle | OK (in-scope) | 0 new |

Legend: **OK** = zero findings · **ATTN** = Medium/Low findings documented · **FAIL** = Critical/High findings (fixed in this session).

---

## Critical Findings (fixed in this session)

None detected.

---

## High Findings (fixed in this session)

None detected.

---

## Medium Findings

- [x] **Path safety — unvalidated git output used as a filesystem path segment** `src/daemon/runtime/codebase/identity.ts:124` (resolution boundary) → consumed at `src/daemon/runtime/codebase/snapshot.ts:285` (`fileName = \`${commit}.json\``). `resolveSnapshotIdentity` set `commit = git.headCommit(...) ?? ""` with **no shape validation**. The `commit` value names the on-disk snapshot file and is now reachable from the live `POST /api/graph/build` HTTP endpoint, so a non-OID probe output (a tampered `git` on PATH, an unexpected porcelain change) could in principle introduce a path separator / `..` segment. The sibling `repo` key was already sanitized via `replace(/[^A-Za-z0-9._-]/g, "_")` in both `defaultGraphBaseDir` and `defaultCacheDir`, leaving `commit` as the asymmetric gap. **Realistic exploitability is low** (`git rev-parse HEAD` emits only a lowercase hex OID for a resolved commit; the input is daemon-side, not request-body-controlled), which keeps this Medium rather than High — but the guard is cheap and closes the gap defensively. **Fix applied (≈8 lines, under the 5-line-exception spirit for a security-critical guard):** added `GIT_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/` and `sanitizeCommit()` in `identity.ts`; `resolveSnapshotIdentity` now sets `commit = sanitizeCommit(git.headCommit(...))`. A value that does not match the git-OID shape collapses to `""`, which the 014c push treats as "no commit" and SKIPS, and which the local write falls back to naming `<snapshot-sha256>.json` — the **exact same fail-soft contract as a non-git workspace**: a usable local snapshot, no cloud push, no throw, never a write outside the snapshots dir. Two regression tests added (`identity.test.ts`): a traversal/short/uppercase/shell-payload battery that must collapse to `""`, and a 64-hex (SHA-256) acceptance case.

---

## Low Findings (documentation only)

None detected.

---

## Threat-Checklist Verification (the five in-scope concerns)

### 1. Command / argument injection via the git probes — CLEAN
`src/daemon/runtime/codebase/identity.ts:43-58` (`runGit`) and `:61-65` (`defaultGitProbe`). Every git invocation is `execFileSync("git", [...args], { cwd, ... })` with a **fixed argv array** — `["rev-parse","HEAD"]`, `["config","--get","remote.origin.url"]`, `["rev-parse","--show-toplevel"]`. No shell is spawned (no `shell:true`, no string command), and **no request-controlled value is interpolated** into any argv. `cwd` is `workspaceDir`, the daemon's configured watched workspace (`assemble.ts:663`), never request-derived. The parsed outputs are treated as untrusted data: the origin URL is reduced to a slug by `repoSlugFromOrigin` (no eval), the slug feeds a sanitized path key, and the HEAD output is now hex-validated (the Medium fix above). A malicious remote URL or branch name cannot break out — it can at most yield an odd slug, which is sanitized to `[A-Za-z0-9._-]` before touching the filesystem and routed through `sLiteral` before touching SQL.

### 2. SQL injection into the `codebase` table on push — CLEAN
`src/daemon/runtime/codebase/push-pull.ts` (pre-existing 014c; re-verified the new wiring adds no unguarded interpolation). Every identifier passes through `sqlIdent` (`:263-265`, `:284-286`, `:533-539`) whose guard rejects anything outside `[a-zA-Z_][a-zA-Z0-9_]*` (`storage/sql.ts:80-85`); `target.table` is the catalog constant `"codebase"` or a test-injected name, never request-controlled. Every value passes through `sLiteral` (`identityWhere`/`pullWhere`, `:359-381`) or `val.str`/`val.num`/`val.text` + `buildInsert` (`snapshotRowValues`, `:392-415`). `npm run audit:sql` scanned 197 files and reported **OK — every SQL interpolation routes through an escaping helper.**

### 3. Tenancy / authz on the new endpoints — CLEAN
`mountGraphApi` attaches via `daemon.group("/api/graph")` (`api.ts:212`), and that group is mounted in `server.ts` behind the permission middleware as `protect: true` (confirmed by `assemble.ts:648-668` wiring commentary and the seam firing unconditionally inside a fail-soft try/catch). Both handlers resolve scope via the shared `resolveScopeOrLocalDefault(c, daemon.config.mode, options.defaultScope)` (`api.ts:216-217`) and **fail closed with a 400 `NO_ORG_BODY` when scope is `null`** (`api.ts:227`, `:242`). `scope.ts:54-91` confirms: header `x-honeycomb-org` wins in every mode, a forged org header that disagrees with a validated `Identity.org` is rejected to `null` (cross-tenant guard, `:57-59`), the local-default fallback fires **only** in local mode, and team/hybrid with no org still 400s. A build is therefore neither invocable cross-tenant nor unauthenticated where the other protected writes are not.

### 4. Path safety on snapshot read/write — HARDENED (see Medium finding)
Write base dir: `defaultGraphBaseDir` (`api.ts:98-102`) sanitizes the repo key to `[A-Za-z0-9._-]` → a single safe segment that cannot traverse. The filename segment `commit` is now git-OID-validated at the resolution boundary (Medium fix). Read side: `loadFreshestLocalSnapshot` (`api.ts:111-139`) enumerates only `*.json` files (excluding dotfiles) in the fixed `<baseDir>/snapshots` dir and never uses `commit` to construct a read path — no traversal on read. `workspaceDir`/`graphBaseDir` are daemon-configured, not request-steerable.

### 5. Resource / DoS + error handling — CLEAN
`POST /api/graph/build` wraps the entire worker in `try/catch` (`api.ts:228-236`) and returns a contained `{ error: "build_failed", reason }` **500 data body** on any throw — no unhandled exception reaches the request pipeline / crashes the daemon. The push is best-effort and returns every outcome as data (never throws into the build). `GET /api/graph` is a pure local read that returns `{ built:false }` rather than throwing when no snapshot exists. The build walks the daemon's own fixed workspace; there is no per-request amplification knob (no caller-supplied path, depth, or repo selector) — a single request triggers exactly one bounded build over the configured workspace.

---

## Surface Integrity Check

| Check | Expected | Observed | Status |
|---|---|---|---|
| **git probes** (`identity.ts`) | fixed argv, no shell, no request interpolation | `execFileSync("git",[...args])`, constant arrays, `cwd`=workspaceDir | OK |
| **SQL guards** (`storage/sql.ts`) | `sqlIdent` regex `[a-zA-Z_][a-zA-Z0-9_]*`; every interpolation wrapped | confirmed; `audit:sql` clean (197 files) | OK |
| **`codebase` table name via `sqlIdent`** | catalog constant wrapped | `CODEBASE_TABLE="codebase"` → `sqlIdent` | OK |
| **New-endpoint auth/RBAC** | inherits `protect:true` `/api/graph`; fail-closed 400 | `daemon.group("/api/graph")` + `resolveScopeOrLocalDefault` → 400 on null | OK |
| **Cross-tenant scope guard** | forged org ≠ token org → deny | `scope.ts:57-59` identity match | OK |
| **Snapshot path safety** | repo key + commit cannot traverse | repo key sanitized; commit now git-OID-pinned | OK (after fix) |
| **Build error containment** | caught → 500 data body, no daemon crash | `try/catch` → `build_failed` 500 | OK |
| **No token / PII in logs** | push logs carry no secret | `push-drift`/`push-failed` log repo/commit/sha only — no token/header/body | OK |

---

## Files Changed (remediation)

| File | Change Summary |
|---|---|
| `src/daemon/runtime/codebase/identity.ts` | Added `GIT_OID` regex + `sanitizeCommit()`; `resolveSnapshotIdentity` now pins `commit` to the git-OID shape (non-conforming → `""`). Defense-in-depth path-safety guard. |
| `tests/daemon/runtime/codebase/identity.test.ts` | Fixture commit changed `"deadbeef"` → realistic 40-hex `HEAD_SHA`; added a traversal/short/shell-payload rejection battery and a 64-hex (SHA-256) acceptance test. |

`git diff` (new files shown via working-tree inspection) reviewed and confirmed security-scoped on 2026-06-22. The `.scan-output/` scratch dir produced by the deterministic scan was removed; no unrelated changes remain.

**Verification after fix:**
- `npm run audit:sql` → **OK** (197 files, every interpolation guarded).
- `npm run ci` → **PASS** — 213 test files, **2325 passed**, 6 skipped; typecheck clean, jscpd clean. The two new identity regression tests pass.

---

## Recommended Follow-Up

1. **Re-run `quality-worker-bee`.** The committed `2026-06-18-qa-report.md` predates this now-landed daemon-assembly wiring and does not cover `api.ts`/`identity.ts`. QA must re-verify the wiring against the PRD before merge.
2. **Out-of-scope dependency advisory (not this diff):** `npm audit` reports a High on transitive `tmp` (path-traversal/symlink). The graph diff imports no `tmp` package (it uses `node:fs` directly), so this is unrelated to PRD-014 wiring. Route to `dependency-audit-worker-bee` for triage/upgrade.
3. **Optional symmetry (Low, not actioned):** `writeSnapshotAtomic` (`snapshot.ts`, pre-existing 014b) consumes `snapshot.graph.commit` from the snapshot object rather than re-deriving it. With the resolution-boundary guard in place, every production path now feeds it a validated commit; if a future caller constructs an identity that bypasses `resolveSnapshotIdentity` (today only test-injected `options.identity`), consider a belt-and-suspenders sanitize inside `writeSnapshotAtomic` itself. Left undone to preserve minimal blast radius and keep the pre-existing 014b file out of this diff.

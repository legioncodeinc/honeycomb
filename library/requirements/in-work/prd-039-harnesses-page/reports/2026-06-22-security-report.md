# Security Audit — PRD-039 Harnesses Page

- **Auditor:** `security-worker-bee` (paired Stinger: `security-stinger`)
- **Date:** 2026-06-22
- **Branch:** `main` (working tree, uncommitted PRD-039 diff)
- **Scope:** the PRD-039 harnesses-page diff — `GET /api/diagnostics/harnesses` endpoint, the harness registry/capability descriptor, the daemon assembly seam, and the dashboard web page/wire/registry that consume it.

---

## Executive summary

The PRD-039 diff is **clean**. The audit found **0 Critical, 0 High, 0 Medium, 1 Low (informational, pre-existing, out-of-scope)** findings. **No code remediation was required** — the working tree is unchanged except for this report. No file under `assets/` (or any file outside the PRD-039 scope) was staged, deleted, or modified.

Ordering is correct: no `quality-worker-bee` report exists for PRD-039 (`library/requirements/in-work/prd-039-harnesses-page/qa/` holds only an empty `.gitkeep`), so this security audit runs **before** QA as required.

The new endpoint is a faithful, minimal clone of the already-hardened `mountDashboardApi`: it attaches to the same already-mounted, `protect:true` `/api/diagnostics` group; inherits the same fail-closed `resolveScopeOrLocalDefault` (400 on no resolvable org, local-mode default only); runs **one** identifier-only `sqlIdent`-guarded `GROUP BY` with **zero** interpolated values; and returns a response shape that structurally cannot carry a token, JWT, org GUID, header, or body. The frontend uses the attacker-controllable `<name>` route param only as React-escaped text, a map/registry lookup key, and a `data-` attribute — never as HTML and never to build a request path. `audit:sql` and the full `npm run ci` gate both pass.

Verification gates run:
- `npm run audit:sql` → **OK** (199 files scanned, every interpolation routes through a helper).
- `npm run ci` (typecheck + jscpd + vitest + audit:sql) → **219 test files, 2366 passed, 6 skipped, 0 failed**. The pre-existing `sources/api.test.ts` load-flake did not appear.
- Stinger deterministic `scan.sh` → Unicode clean; SQL-guard sweep produced one expected true-negative (analyzed below).

---

## Scorecard (per threat-checklist item)

| # | Threat | Verdict | Evidence |
|---|--------|---------|----------|
| 1 | SQL injection into `sessions` | **PASS** | `buildHarnessActivitySql` builds only from `sqlIdent("sessions"/"agent"/"creation_date")`; no value interpolated; scope passed to `storage.query`; `audit:sql` green. |
| 2 | Secret in response / page / routes / streamed lines | **PASS** | `HarnessStatus` + `HarnessCapabilities` carry only ids/booleans/count/ISO-date/static descriptors; no field can carry a secret. Logs records are method/path/status by construction; the client-side filter only `.includes()`-filters them. |
| 3 | XSS via `#/harnesses/<name>` route param | **PASS** | `<name>` reaches only React text children (auto-escaped), `AGENT_DOT[name]` map lookup, `data-harness` attr, and `navigate()` (sets `location.hash`, not an HTTP path). No `dangerouslySetInnerHTML`/`innerHTML`/`eval`/`new Function` in the dashboard. A `#/harnesses/<script>` resolves to the "Unknown harness" fallback. |
| 4 | Tenancy / fail-closed | **PASS** | Mounted on the same protected `/api/diagnostics` group via `daemon.group(...)`; uses the identical `resolveScopeOrLocalDefault(c, mode, defaultScope)` and 400 `NO_ORG_BODY` as `mountDashboardApi`. No team/hybrid loosening. |
| 5 | `installed` detection side-effects | **PASS** | `installedHarnesses` is a `Set<string>` built **once** at assembly from `options.harnessTargets` (already-resolved names). The handler only does `installed.has(name)` — no per-request spawn, file walk, or `readFile`/`existsSync`. |

---

## Findings detail

### Critical — None detected.

### High — None detected.

### Medium — None detected.

### Low

**L-1 (informational, pre-existing, OUT OF SCOPE) — transitive `tmp` advisory in the dependency tree.**
`npm audit` reports 1 "high"-path / 0 critical; the underlying advisory is `tmp` GHSA-52f5-9888-hmc6 (CWE-59 symlink, CVSS 2.5, dev-time). This PRD-039 diff touches **no** `package.json`/lockfile, so it is not introduced or affected here. **Owner:** `dependency-audit-worker-bee`. No action taken under this feature audit.

---

## Category verification (each checked, evidence cited)

- **Deep Lake SQL injection** — None detected. `src/daemon/runtime/dashboard/harness-api.ts:129-134` (`buildHarnessActivitySql`) interpolates only `sqlIdent`-validated constants (`sessions`, `agent`, `creation_date`). No request-controlled value reaches SQL; the route `<name>` param is never used to build SQL.
- **Token / JWT / org-id exposure** — None detected. The response contract (`HarnessStatus` `harness-api.ts:59-74`, `HarnessCapabilities` `harness-registry.ts:103-126`) has no field able to carry a credential. Grep for `token|secret|bearer|credential|api-key|authorization` over the new modules returns only doc-comment disclaimers. `tests/daemon/runtime/dashboard/harness-api.test.ts:220` is a negative-assertion test proving the body contains none of those terms.
- **Captured-trace PII leakage** — None detected. The endpoint emits only aggregate `COUNT(*)`/`MAX(creation_date)` per `agent` — no raw prompt/response/summary content from `sessions` rows crosses the wire. The detail page's live stream reuses `/api/logs` (method/path/status records), filtered client-side.
- **Broken access control / scope coercion** — None detected. Fail-closed `resolveScopeOrLocalDefault` (`src/daemon/runtime/scope.ts:82-91`) with the cross-tenant header guard (`scope.ts:54-62`) is reused verbatim; no `me|team` widening, no org coercion.
- **XSS / DOM injection** — None detected. Router (`router.tsx`) yields a string route; `harnessNameFromRoute` (`harnesses.tsx:43-47`) slices a string; all rendering is React-escaped. No HTML sink.
- **SSRF / dynamic request path from input** — None detected. `wire.logs(limit)` builds its URL from a numeric limit only; the harness name never reaches a request path (`filterRecordsForHarness` is in-memory).
- **Side-effectful request handling** — None detected (item 5 above).
- **Hidden-Unicode rules-file backdoor** — None detected. `scan.sh` Unicode sweep clean; PRD-039 touches no `.cursor/rules`/`AGENTS.md`/`CLAUDE.md`.
- **Supply chain (deps / OpenClaw bundle)** — No PRD-039-introduced change. No `package.json`/lockfile delta; OpenClaw bundle unaffected by this diff. (See L-1.)
- **Secrets committed / pack-check** — None detected. No secret material in source or test fixtures.

---

## Files changed by this audit

| File | Change |
|------|--------|
| _(none)_ | No code remediation required — 0 Critical/High findings. |

`git status --short` confirms only the PRD-039 source/test files (modified + untracked) plus library lifecycle docs are present; **nothing under `assets/` was touched**.

---

## Recommendations / handoffs

1. **`dependency-audit-worker-bee`** — triage the transitive `tmp` advisory (L-1) at the repo level; not a PRD-039 concern.
2. **`quality-worker-bee`** — clear to run now. This audit produced no code changes, so QA will not be reading code that mutates underneath it.

**Net: PRD-039 harnesses-page diff is secure to ship from the application-security perspective.**

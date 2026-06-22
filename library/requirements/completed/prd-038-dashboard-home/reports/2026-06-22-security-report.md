# Security Audit — PRD-038 Dashboard Home Reorg

- **Auditor:** security-worker-bee
- **Date:** 2026-06-22
- **Scope:** The PRD-038 dashboard-home reorganization (working-tree, uncommitted). A **client-side layout** change to the daemon-served dashboard home page. No new daemon route — reuses the already-shipped `wire.harnesses()` (`GET /api/diagnostics/harnesses`) and `wire.logs()` (`GET /api/logs`).
  - NEW `src/dashboard/web/harness-strip.tsx`
  - MODIFIED `src/dashboard/web/pages/dashboard.tsx`
  - Tests: `tests/dashboard/web/dashboard-page.test.tsx`, `tests/dashboard/web/app.test.tsx`
  - (Library lifecycle doc renames ignored per task scope.)
- **Ordering:** Run **before** `quality-worker-bee`. No `*-qa-report.md` exists for PRD-038 — no ordering violation.

## Executive Summary

**Clean audit. Zero findings at any severity. No remediation required.** This is a pure presentational reorganization: the home body was re-laid into three `data-area` landmark sections (`kpi-band`, `recall-area`, `harness-area`) and a new `HarnessStrip` component was composed from existing, secret-free wire data and existing inert primitives. No new daemon surface, no new data source, no HTML sink, no secret on the rendered page. Full coverage — the diff sits squarely inside the covered TypeScript/dashboard stack; no reduced-coverage flag needed.

`npm run audit:sql` → **PASS** (200 files, every interpolation routes through an escaping helper).
`npm run ci` (typecheck + jscpd + vitest + audit:sql) → **PASS** (222 files, 2394 passed, 6 skipped, 0 failed). The pre-existing `sources/api.test.ts` load-flake did not surface.

## Findings by Severity

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |

## Threat-Checklist Verification (per task scope)

### 1. No secret in the rendered home — **PASS**
The `HarnessStrip` renders only safe, zod-validated wire fields, and every data source is secret-free by construction:

- **`HarnessStatusWire`** (`src/dashboard/web/wire.ts:240-254`) carries `name`, `installed`, `active`, `lastSeen` (ISO timestamp), `turnsCaptured` (count), `runtimePath`, `capabilities`. The strip renders ONLY `name`, `lastSeen`, `turnsCaptured`, `active` (`harness-strip.tsx:39-91`). No token, credential, org GUID, endpoint, header, or body rides this shape. `runtimePath` is present in the schema but is **not rendered** by the strip.
- **Short-tail live stream** reuses the SAME pre-formatted `/api/logs` lines as the full log. `formatLogLine` (`wire.ts:624-628`) emits ONLY `time + method + path + status` — `org`, `workspace`, and `mode` from `LogRecordWire` (`wire.ts:181-190`) are **never rendered into the line**. The strip receives these as opaque pre-formatted strings (`streamLines`) and passes them to `LiveLog` as inert text (`harness-strip.tsx:133`).
- Grep over `src/dashboard/web/harness-strip.tsx` and `pages/dashboard.tsx` for `token|bearer|authorization|credential|apikey|x-activeloop|secret|jwt`: only hits are (a) doc-comments asserting absence and (b) the **pre-existing** `secretNames` state passed to `SettingsPanel` — that line is unchanged (relocated context only, `git diff` shows the same line `-`/`+`), and `SettingsPanel` renders secret *names*, not values. Not introduced or altered by this diff.

### 2. XSS-safe — **PASS**
Grep over the two touched/new files + their tests for `dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|outerHTML|document.write|eval(|new Function`: **none found**. The composed primitives (`Badge`, `Kpi`, `Panel`, `LiveLog` in `primitives.tsx` / `panels.tsx`) contain **no HTML sink** — all children render as inert React text. `h.name`, log lines, and last-seen strings render as escaped React text children. `AGENT_DOT[h.name]` (`harness-strip.tsx:50,77`) is a **read** from a static `Record<string,string>` of CSS-var tokens (`panels.tsx:73-83`) with a `?? AGENT_DOT_FALLBACK` guard — used only as a `background` color in a React style object. `h.name` selects a value; it is never itself a sink, and no write to the map occurs (no prototype-pollution path).

### 3. No new daemon route / surface — **PASS**
`git diff --name-only` confirms **no** `host.ts`, `api.ts`, or `src/daemon/**` file is touched. The strip is pure client consumption of `wire.harnesses()` (`wire.ts:549-554`, reuses `ENDPOINTS.harnesses = /api/diagnostics/harnesses`) and `wire.logs()` (`wire.ts:545-548`, reuses `ENDPOINTS.logs = /api/logs`). Both endpoints are frozen pre-existing constants (`wire.ts:32-43`). Both calls route through the zod-validated `getJson` boundary and degrade to `[]` on any malformed/absent body — never a throw.

### 4. Security posture inherited — **PASS**
Local-mode-only and the no-secret-in-page posture (PRD-037 D-9) are preserved. The new harness poll (`dashboard.tsx:258-273`) is structurally identical to the existing `wire.logs` / `wire.health` polls (alive-flag + interval + unmount cleanup) and consumes the same wire-safe contract. Nothing in the diff loosens any boundary; no new IO surface, no new escaping responsibility, no scope/header handling added.

## Catalog Cross-Check (security-stinger)

- **AI-code failure patterns (guide 02):** No missing-`sqlIdent` (no SQL in scope — client-only), no string-gate path bypass, no unscoped `me|team` query, no hidden-Unicode rules file, no hallucinated dep (only existing intra-repo imports), no prompt-injection sink, no token-to-logs, no gate-runner tampering. None applicable / none detected.
- **OWASP Top 10:2025 on Hivemind (guide 03):** No injection (no HTML/SQL sink), no broken access control (no new auth surface; rendering inherits daemon-side scoping unchanged), no crypto/token handling, no SSRF-adjacent gate path, no prototype pollution (map read-only), no logging failure (formatter redacts by construction). None detected.
- **Captured-trace PII + credentials (guide 04):** No JWT/org-id leakage (org never rendered), no PII surfaced from `sessions`/`memory` (this page recalls memory cards via the **unchanged** `wire.recall` path, moved verbatim), no scope coercion, no over-capture, no credential-file handling. None detected.

## Medium / Low — For the Record

None. Two non-security observations, noted for completeness only (NOT findings, NOT requiring action):

- The new harness poll (`dashboard.tsx:262-265`) has no local `try/catch`, matching the existing `wire.logs`/`wire.health` polls in the same file. This is safe because `wire.harnesses()` is internally no-throw (degrades to `[]` at `wire.ts:552-553`). Robustness parity with established code — not a security concern.
- `relativeLastSeen` (`pages/harnesses.tsx:78-91`) echoes the raw `lastSeen` value when it is an unparseable timestamp. The value is an ISO timestamp, not a secret — honest fallback, not an exposure.

## Verification

- `git status --short`: working tree unchanged from audit start. No code edits made (nothing Critical/High to remediate). **No `assets/` file staged or deleted.** The staged renames are the pre-existing library lifecycle moves (out of scope per task).
- `npm run audit:sql`: **PASS**.
- `npm run ci`: **PASS** (2394 tests passed, 0 failed).

## Recommendation

Ship-ready from a security standpoint. Proceed to `quality-worker-bee` for plan-conformance QA.

# Security Audit — PRD-037 Dashboard Nav-Shell

- **Date:** 2026-06-22
- **Auditor:** `security-worker-bee` (paired with `security-stinger`)
- **Scope:** The PRD-037 dashboard nav-shell diff (working tree, uncommitted) — the refactor of the daemon-served dashboard SPA (`src/dashboard/web/`) into a left-nav multi-page app shell.
- **Branch:** `main` (uncommitted working tree)

---

## Executive Summary

**Verdict: PASS. No Critical, High, or Medium findings. One Low (informational). One <5-line hardening test added in-session.**

PRD-037 is a **client-side, daemon-served dashboard refactor** that splits the single-page `App` into an app shell (`<Shell>`) + a hash router + a route registry + a sidebar + per-route page components. It introduces **no new daemon route, no new data endpoint, no new dependency, and no new secret/token surface.** The pre-existing PRD-029/024 "no-secret posture" (the health pill and subsystem strip render closed-enum STATE only) is preserved exactly. The attacker-controllable input on this surface — `location.hash` — is used **only** as a registry-lookup key (`===` / `.startsWith` over a static list) and, indirectly, to source a `document.title` from a **static registry label** (never the raw hash). There is no hash→DOM/HTML sink, no `dangerouslySetInnerHTML`, no `eval`, no dynamic import, and no object-indexing-by-hash (prototype-pollution) path.

Because the surface is the in-scope Hivemind TypeScript dashboard (client-rendered, loopback-served, local-mode-only), this is a **full-fidelity** audit — no reduced-coverage caveat applies.

**Ordering note:** No PRD-037 QA report exists. The only QA report on the tree (`library/qa/cursor-extension/2026-06-12-qa-report.md`) is dated 2026-06-12 for an unrelated feature (cursor-extension) and predates this work. No `quality-worker-bee` ordering inversion — `quality-worker-bee` may run after this audit.

---

## Threat-Checklist Results (the brief's 5 items)

| # | Threat | Result | Evidence |
|---|--------|--------|----------|
| 1 | No secret/token in served page / route fragment / registry / health pill | **PASS** | Grep over the entire `src/dashboard/web` tree for `token\|Bearer\|Authorization\|credential\|eyJ\|X-Activeloop\|apiKey\|jwt` returned only (a) CSS design-token (`var(--…)`) references, (b) doc comments asserting "no secret / names-only", and (c) the pre-existing `/api/secrets` **names-only** presence surface (`wire.ts`, not in this diff). The health pill (`sidebar.tsx:127-148`) renders a `--verified`/`--severity-critical` dot + literal `daemon :3850`/`offline` — closed STATE only. The subsystem strip (`pages/dashboard.tsx:113-131`) renders `s.label` + a stringified closed enum. No token/org-GUID/endpoint/header is embedded or rendered. |
| 2 | XSS-safe rendering; crafted `#/<script>` hash → Dashboard fallback, never executes/renders | **PASS** | No `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`, `document.write`, `insertAdjacentHTML`, or dynamic `import(hash)` anywhere in `src/dashboard/web` (grep returned only `{@link import(...)}` JSDoc + GET-route doc strings — zero real sinks). The route is rendered exclusively through React JSX (auto-escaped). `matchRoute` (`registry.tsx:195-205`) resolves the hash via `Array.find` with `===`/`.startsWith`; any unmatched hash (incl. `/<script>alert(1)</script>`) falls through to the `/` Dashboard entry, selected **by reference**. The hash is never injected as markup nor used to build a script/import. |
| 3 | Local-mode-only; no new daemon route / data endpoint; `host.ts` untouched | **PASS** | `git status --porcelain -- src/daemon/runtime/dashboard/host.ts` → **empty** (unchanged). The dashboard seam fires only when `daemon.config.mode === "local"` (`host.ts:25`, unchanged). Routing is 100% client-side hash; the browser never sends the fragment to the daemon, so no server-reachable path is introduced. |
| 4 | `document.title` / per-route title sourced from static registry, not raw hash | **PASS** | `app.tsx:62-64`: `document.title = \`honeycomb · ${entry.label}\`` where `entry = matchRoute(route)` — `entry.label` is a **static registry string** (`registry.tsx:175-183`), never the raw attacker hash. No reflected-input sink. |
| 5 | No prototype-pollution / unsafe object access in `matchRoute`/registry resolution | **PASS** | `matchRoute` (`registry.tsx:195-205`) and `activeEntryRoute` (`sidebar.tsx:62-69`) iterate the static `ROUTES` array with `Array.find` + `===`/`.startsWith`. The hash is a comparison operand, **never** a property key into an object (no `routes[hash]`, no `Object.assign` from hash-derived keys). `/__proto__` and `/constructor/prototype` resolve to the `/` fallback like any other unknown route. |

---

## Findings by Severity

### Critical — None detected.
### High — None detected.
### Medium — None detected.

### Low

**L-1 (Informational) — `host.ts` serves 5 GET routes, not 4 as stated in the brief.**
- **Location:** `src/daemon/runtime/dashboard/host.ts:141-168` — `root.get` for shell, app.js, css, logo, **and font** (`DASHBOARD_FONT_PATH`).
- **Detail:** The scope brief referenced "still 4 GET routes." The host actually registers 5 GET routes; the 5th (font) **predates this diff** and `host.ts` is unchanged in PRD-037. Not a regression, not a vulnerability — every route is a static-asset GET, no catch-all, no data/write endpoint. Flagged only to keep the route-count baseline honest for the next audit.
- **Action:** Document only. No fix.

---

## Phase-by-Phase Category Coverage

| Catalog / Scan category | Result |
|---|---|
| Rules-file backdoor (zero-width/bidi in `.cursor/rules`, etc.) | Not in this diff scope; no rules files touched. None detected in scope. |
| Hardcoded secrets / committed `.env` | None detected — no `eyJ`/`Bearer`/`sk_`/`-----BEGIN` in the new dashboard files. |
| Deep Lake SQL injection (`sqlIdent`/`sqlStr`) | N/A — this is client-rendered UI; no Deep Lake query construction in the diff. `npm run audit:sql` clean (197 files, all interpolations route through escaping helpers). |
| Pre-tool-use gate integrity | Not touched by this diff. None detected in scope. |
| Captured-trace PII / token-in-logs | None — pages render only wire-validated, secret-free view state; no `console.*` token interpolation introduced. |
| Prompt-injection surface | Not touched by this diff. |
| API client hardening | Not touched (the shared `wire` client is reused, not modified). |
| Org RBAC / `me\|team` scope coercion | N/A — no scope/org argument flows through the shell, router, or registry. |
| XSS / DOM sinks | None detected (see threat item 2). |
| Prototype pollution | None detected (see threat item 5). |
| Dependency CVEs | No new dependency added (the router is in-repo, D-1/D-2 "no new dependency"). |

---

## Remediation Performed This Session

No Critical/High/Medium finding required code remediation. One **defensive hardening test** was added to lock the XSS-safe + no-prototype-pollution invariant into the gate (the route-resolution security contract):

| File | Change | Lines |
|---|---|---|
| `tests/dashboard/web/registry.test.tsx` | Added a `security:` regression test asserting that crafted/adversarial hashes (`/<script>…`, `/__proto__`, `/constructor/prototype`, `/<img onerror=…>`) all resolve to the Dashboard `/` fallback — proving `matchRoute` treats the hash purely as a lookup key and never escalates to a sink. | +13 |

This is the only change to the working tree made by this audit. `git diff --stat` confirms no other source file was modified by the audit (the `app.tsx`/`main.tsx` deltas are the PRD-037 implementation, untouched by me).

---

## Gate Results

| Gate | Command | Result |
|---|---|---|
| SQL safety | `npm run audit:sql` | **PASS** — scanned 197 files; every SQL interpolation routes through an escaping helper. |
| Full CI | `npm run ci` (typecheck → dup → test → audit:sql) | **PASS** — 217 test files, **2340 passed / 6 skipped**, incl. the new `registry.test.tsx` (7 tests). The known pre-existing `tests/daemon/runtime/sources/api.test.ts` load-flake did **not** surface this run. typecheck + jscpd dup clean; `audit:sql` clean. |

---

## Recommendation

Ship-ready from a security standpoint. `quality-worker-bee` may now run to verify the PRD-037 implementation against its plan (the correct ordering — security ran first, no QA report predates these fixes).

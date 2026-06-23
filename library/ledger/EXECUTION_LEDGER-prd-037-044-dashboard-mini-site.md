# EXECUTION LEDGER — /the-smoker (dashboard mini-site, PRD-037 → 044)

**Scope:** build the multi-page dashboard — PRD-037 (nav-shell foundation) FIRST, then parallelize the 7 routed
pages (038–044). **Started:** 2026-06-22 · **Base:** `main`
**Status:** OPEN · IN PROGRESS · DONE · VERIFIED · BLOCKED

> Drift fix at setup: deleted stale `backlog/prd-035` + `backlog/prd-036` (leftover #64 docs copies; canonical
> versions are in `completed/`).

## Overall wave plan

```
Wave 1: PRD-037 nav-shell (ONE bee — coherent foundation; splits app.tsx)  ──► verify ──► ship+merge
   │  establishes: sidebar.tsx · router.tsx · registry.tsx · page-frame.tsx · pages/dashboard.tsx + 6 placeholders
   ▼
Waves 2+: PRDs 038–044 (routed pages) — parallelize by file-disjointness now that each page = its own pages/<n>.tsx
   dependency edges to respect:
     038 (home) ← 039a (harness telemetry)
     041 (graph page) ← 035c GraphCanvas (shipped) + 014 graph-build (shipped)
     042 (sync page) ← 036 discovery (shipped)
     043 (logs page) adds SQLite persistence
   contention after 037: api.ts (new endpoints), contracts.ts, wire.ts → worktree-isolate or sequence on shared files
```

**Why 037 is one bee, not three:** 037a/b/c are mutually referential (sidebar reads registry + active route; router
renders registry-matched component; registry feeds both) and all touch the `app.tsx` split. Splitting across parallel
agents would clobber `app.tsx` and create circular half-built imports. Built as one coherent refactor.

## Wave 1 — PRD-037 — typescript-node-worker-bee / opus

Model justification: large React refactor (monolithic `app.tsx` → Shell + sidebar + hash router + registry +
page-frame + lifted DashboardPage + 6 placeholders), DS-token fidelity, no-new-dep + production-clean bundle
discipline. Rubric `claude-opus-4-8-thinking-high` (code quality + reasoning 10/10).

### Ledger (30 ACs)

| ID | Criterion | Status |
|---|---|---|
| 037-AC1 | Seven destinations render in left-nav shell, DS-only, production-clean | OPEN |
| 037-AC2 | Active-route highlight (honey), moves on nav | OPEN |
| 037-AC3 | Client-side nav, no full reload | OPEN |
| 037-AC4 | Deep-link/refresh any route lands; unknown→Dashboard | OPEN |
| 037-AC5 | Dashboard parity preserved (lift-and-shift, no regression) | OPEN |
| 037-AC6 | Daemon-down banner swaps CONTENT region at shell level, sidebar stays | OPEN |
| 037-AC7 | Registry contract documented + plug-in proven by test | OPEN |
| 037-AC8 | Collapsible/responsive rail; highlight + pill survive | OPEN |
| 037-AC9 | Security/gate unchanged; no secret in shell/route/registry; ci green | OPEN |
| 037a-AC1..7 | sidebar: mark+wordmark / 7 items / honey highlight (1 active) / onNavigate / health pill / collapse rail / DS-only | OPEN |
| 037b-AC1..7 | router: useHashRoute+hashchange / no-reload swap / deep-link mount / unknown→dashboard / DashboardPage parity / shell-level health swap / no new dep+route, ci green | OPEN |
| 037c-AC1..7 | registry: PageFrame / ROUTES 7 in order / matchRoute / hydration usePoll / dynamic group / one-entry plug-in / docs | OPEN |
| 037-SEC | security-worker-bee: no-secret/XSS/local-only posture intact | OPEN |
| 037-QA | quality-worker-bee: verified vs PRD-037 (index + a/b/c) | OPEN |
| 037-CI | `npm run ci` + GitHub Actions green | OPEN |

## Event log

- Phase 0: read PRD-037 index + 037a/b/c end-to-end. Setup: branch `feat/prd-037-dashboard-nav-shell`, deleted backlog 035/036 dupes. 037 = one coherent bee (not 3 parallel — mutual refs + shared app.tsx split).
- Dispatching the PRD-037 implementation bee.
- **PRD-037 returned DONE.** Built sidebar/router/registry/page-frame + pages/dashboard (lift-and-shift) + 6 placeholders; app.tsx→Shell; main renders Shell; knowledge doc `adding-a-page.md`. **Orchestrator verify:** all shell modules present; app.tsx has Shell/Outlet/Sidebar; no react-router (no new dep); `host.ts` untouched; hash-only (no History API). `npm run ci` = 216/217 files pass, 2338 passed / 6 skipped, **1 fail = `sources/api.test.ts`** — the KNOWN pre-existing load-flake (5053ms vs 5000ms cap), UNMODIFIED by 037, passes 7/7 in isolation. Dashboard suites all deterministically green. → 037 impl ACs DONE.
- Note (honest, non-AC): "Pollinate now" moved to shell chrome; the pollinating *log-line* injection into the page feed is now a cross-region seam for PRD-038 (pulse still works via PageProps). Does not affect any AC.
- Close-out: security → quality on the 037 diff.
- **security-worker-bee (opus): PASS** — 0 Crit/High/Med, 1 informational Low (host.ts serves 5 static routes not 4; pre-existing, untouched). Verified no secret in shell/route/registry/pill, no XSS sink (hash is a lookup key only; `#/<script>`→Dashboard fallback), no new daemon surface, `document.title` from static `label`, no proto-pollution. Added a hardening test (crafted/adversarial hashes → fallback). `audit:sql` + ci green. → 037-SEC VERIFIED. Report: `prd-037/reports/2026-06-22-security-report.md`.
- **quality-worker-bee (opus): PASS — 30/30 ACs** (index 9/9, 037a 7/7, 037b 7/7, 037c 7/7). Lift-and-shift parity (real structural assertion through the wire layer), hash routing (no reload / deep-link / unknown→Dashboard, no History API, no new dep), shell-level connectivity swap (sidebar persists), registry plug-in seam (throwaway entry → nav+route without editing sidebar/router). host.ts untouched, DS-tokens only, production-clean bundle. 2 non-blocking suggestions. → 037-QA VERIFIED. Report: `prd-037/reports/2026-06-22-qa-report.md`.
- **ALL 30 ACs VERIFIED.** → Phase 3 Ship (PR), then move 037 → completed on merge.
- **Shipped: PR #70.** CI: Quality gate Node 22/24, Windows smoke, Secret gate, Analyze (js-typescript + actions), **CodeQL** all PASS.
- **Real CodeQL finding caught + fixed:** the security bee's grep missed a HIGH `js/xss-through-dom` — the relocated brand-mark `<img src>` consumed the DOM-read `data-asset-base`. Fixed `main.tsx` (commit db14096): sanitize `assetBase` to a safe relative path at the read boundary, fail-safe to `assets`. CodeQL re-ran → PASS (alert cleared). typecheck + 80 dashboard tests green.
- **Non-blocking CI wart (parked, not a blocker):** `Analyze (python)` red = GitHub **default code-scanning setup** scans a `python` language that doesn't exist (0 .py files) → "no source code seen" (exit 32). No workflow file to edit (default setup, repo-Settings config); intermittent (passed on the prior commit); and `main` has **no branch protection** so no required check blocks merge (PR #70 = MERGEABLE). ASK: drop `python` from the repo's default CodeQL languages (repo security-settings change) to stop it reddening every future PR (038-044).
- **Post-push review + conflict resolution (PR #70):**
  - **CodeQL HIGH `js/xss-through-dom`** (real, missed by the grep-based security pass): relocated brand `<img src>` consumed the DOM-read `data-asset-base`. Fixed (db14096): sanitize at the `main.tsx` boundary → CodeQL green.
  - **Accidental data loss caught via the review:** `git add -A` (working tree missing the dir) silently staged deletion of the ENTIRE `assets/logos/logo-options/` (22 files incl 3 `.py` scripts). Restored from main (bcf35e6). This was ALSO the root cause of `Analyze (python)` failing ("no Python source") — restoring the scripts fixed that check.
  - **3 CodeRabbit fixes** (bcf35e6): pollinate() synchronous useRef re-entry guard; identity re-hydrate only on down→up recovery; test `afterEach` unmount guard. Replied + resolved all 3 threads.
  - **Merge conflict with #71** (you swapped the dashboard mark to `honeycomb-memory-cluster.svg`): merged main, kept the shell Outlet, pointed the relocated sidebar mark at the new asset + updated its test (0e13902).
- **PR #70 fully green** — CodeQL, Analyze (actions/js/python), Quality gate (Node 22/24), Windows smoke, Secret gate all PASS. MERGEABLE. Ready to merge; move 037 → completed on merge, then proceed to pages 038–044.

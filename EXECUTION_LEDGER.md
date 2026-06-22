# EXECUTION LEDGER — /the-smoker (gap tracks)

**Scope:** Fix the genuine functional gaps surfaced by the in-work QA audit, as 3 parallel file-disjoint tracks → per-PRD PRs.
**Base branch:** `fix/gap-tracks` off `origin/main` (2eb0349) · **Started:** 2026-06-22
**Status:** OPEN · IN PROGRESS · DONE (impl + targeted tests) · VERIFIED (independent + close-out) · BLOCKED

## Tracks (parallel — disjoint file trees)

| Track | PRD | Defect | Owner bee / model | Files (exclusive) |
|---|---|---|---|---|
| **T1** | PRD-014 | `graph build` → daemon **501**: build worker built+tested (28/28) but daemon-assembly wiring DEFERRED | typescript-node-worker-bee / opus | `src/daemon/runtime/codebase/**`, `assemble.ts`, graph route/command wiring, `tests/daemon/runtime/codebase/`, `tests/integration/` |
| **T2** | PRD-030 | **Critical (AC-6 reopened):** `COMPACTABLE_KEY_COLUMNS` maps `epistemic_assertions→claim_key` but writer keys by `id` → silent no-op in prod | deeplake-dataset-worker-bee / opus | `src/daemon/storage/compaction*.ts`, catalog ColumnDef (if centralizing), `tests/daemon/storage/` |
| **T3** | PRD-027 | recall returns hits in **arm order, not relevance order**, with placeholder scores (never executed) | retrieval-worker-bee / opus | `src/daemon/runtime/recall/**`, `tests/daemon/runtime/recall/` |

Disjoint check: only T1 touches `assemble.ts`; T2 = storage/compaction; T3 = recall. No shared file → safe to run on one tree concurrently. Each bee runs TARGETED tests only; orchestrator runs the integrated `npm run ci` once after all land. No bee commits — orchestrator splits to 3 per-PR branches off main after close-out.

## Ledger

| ID | Track | Criterion | Status |
|---|---|---|---|
| T1-1 | 014 | `graph build` no longer 501 — daemon invokes the existing worker end-to-end | OPEN |
| T1-2 | 014 | A build writes a snapshot to the `codebase` table; `/api/graph` then returns `built:true` w/ real nodes/edges | OPEN |
| T1-3 | 014 | Integration/daemon test proves the wired path; all existing 28 PRD-014 unit tests preserved | OPEN |
| T2-1 | 030 | `epistemic_assertions` key column corrected to match its real writer (`id`) | OPEN |
| T2-2 | 030 | Guard test: each compactable table's key column == its writer's keyColumn literal (silent-no-op → test failure) | OPEN |
| T2-3 | 030 | AC-6 satisfied; existing compaction tests preserved | OPEN |
| T3-1 | 027 | Recall hits ordered by RELEVANCE (not arm order), real scores per PRD-027 | OPEN |
| T3-2 | 027 | PRD-027 ranking ACs met with tests (honest scope report if eval harness is XL) | OPEN |
| GATE | all | integrated `npm run ci` green | OPEN |
| SEC | all | security-worker-bee: Crit/High remediated across the 3 diffs | OPEN |
| QA | all | quality-worker-bee: verified vs PRD-014/030/027 | OPEN |

## Event log

- Audit established the gaps; user chose: start Tracks 1-3 (fix functions), per-PRD PRs.
- Base `fix/gap-tracks` off main; running daemon stopped (avoid :3850 collision in T1 itests).
- Dispatching T1/T2/T3 implementation bees in parallel.
- **Returned:**
  - **T1 (PRD-014) — REAL FIX, DONE.** Built `mountGraphApi` seam (`src/daemon/runtime/codebase/api.ts` + `identity.ts`), wired into `assembleDaemon()` step 13 (`assemble.ts`), re-exported (`codebase/index.ts`). `POST /api/graph/build` now runs `buildAggregateSnapshot→finalizeSnapshot→writeSnapshotAtomic→pushSnapshot`; 501→200, snapshot persisted, `/api/graph` reads `built:true`. +10 tests (api 4 incl. 501→200 proof, identity 6). All 88 existing PRD-014 tests preserved.
  - **T2 (PRD-030) — ALREADY FIXED on main (stale QA).** `epistemic_assertions: "id"` already correct in `maintenance/compact-api.ts:108` + writer-cross-check guard test already present; bee verified via writer trace (`recordAssertion` keyColumn:"id") + proved guard bites. Net-zero code. The "NOT VERIFIED Critical" QA report (2026-06-17) is stale.
  - **T3 (PRD-027) — ALREADY MERGED (#48, 405efcf), stale index.** RRF fusion (`RRF_K=60`, `fuseHits`) live in `memories/recall.ts`; arm-order defect absent. Bee correctly identified the ranking lives in `memories/recall.ts` (PRD-027's real target), NOT `recall/**` (the separate unwired PRD-007 engine), and STOPPED rather than edit out of bounds. Net-zero code.
- **Integrated gate (T1):** `npm run ci` green — 213 files, 2323 passed, 6 skipped, 0 failed; typecheck + audit:sql clean; no flakes. → T1-1/T1-2/T1-3 DONE.
- **Net:** only T1 is a code change to ship. T2/T3 = docs-out-of-sync (lifecycle/status), not code gaps. Close-out (security→quality) on the T1 diff next; then ship T1 PR; then reconcile 030/027 (+re-check 026/029) docs.
- **T1 close-out — security-worker-bee (opus):** 0 Crit / 0 High / 1 Medium (FIXED in-session: git-OID validation on snapshot `commit` for path-safety defense-in-depth + 2 tests). Verified git probes use `execFileSync` fixed-argv (no shell injection), SQL guarded, tenancy fail-closed, errors contained. `audit:sql` + `ci` green. Flagged out-of-scope: transitive `tmp` npm-audit High (unrelated → dependency-audit-worker-bee). Report: `prd-014/reports/2026-06-22-security-report.md`. → SEC VERIFIED.
- **T1 close-out — quality-worker-bee (opus):** **PASS-WITH-FINDINGS.** 501→200 proven (bare daemon 501 baseline → wired 200 built:true, snapshot persisted, real worker invoked, 014c push semantics honored, no stub/mock-to-pass); wired into production `assembleSeams` step 13. 2 non-blocking Warnings: (W1) assemble suite didn't assert prod FIRES the seam; (W2) richer CLI verbs (diff/history/init/pull) not wired. Report: `prd-014/reports/2026-06-22-qa-report.md`. → QA VERIFIED (findings non-blocking).
- **W1 closed by orchestrator:** added `mountGraph` to `recordingSeams` + `expect(calls.mountGraph).toBe(1)` + order-array entry in `assemble.test.ts` — production firing now proven. assemble+codebase suites 137 green.
- **Final gate:** `npm run ci` green — 213 files, **2325 passed**, 6 skipped, 0 failed; typecheck + audit:sql clean.
- **W2 (CLI verbs diff/history/init/pull) = documented follow-up** — out of scope for "make graph build work"; the `graph build` endpoint + CLI→endpoint mapping are closed.
- T1 ready to ship as its own PR (PRD-014 graph-build wiring). T2/T3/026/029 docs reconciliation tracked as a separate follow-up.

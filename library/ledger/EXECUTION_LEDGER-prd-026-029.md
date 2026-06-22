# EXECUTION LEDGER — /the-smoker (PRD-026 + PRD-029)

**Scope:** drive the two remaining in-work PRDs to VERIFIED completion — PRD-026 (dreaming-loop-enablement)
+ PRD-029 (degradation-observability). **Started:** 2026-06-22 · **Base:** `main`
**Status:** OPEN · IN PROGRESS · DONE · VERIFIED · BLOCKED

## Phase 0 re-audit — CRITICAL FINDING: both already implemented (stale-docs pattern)

The user flagged that 030/027 were already-done-with-stale-docs; re-auditing 026/029 against the live tree
confirms **both are fully implemented with per-AC-labelled tests on `main`** — they were built in the
PRD-024/025-era waves but never got a QA report and were never lifecycle-moved. This is a **verify +
reconcile** cycle, not a build cycle.

Orchestrator spot-check evidence:
- **PRD-026:** `HONEYCOMB_DREAMING_ENABLED` env seam in `dreaming/config.ts`; `tests/daemon/runtime/dreaming/api.test.ts:189` = `describe("PRD-026 AC-1 — the ENABLEMENT config gate…")`; `tests/integration/dreaming-consolidation-live.itest.ts` headers AC-3/AC-4/AC-5 (dup-merge / stale-supersede / junk-prune, zero source-backed loss, before/after snapshot); `dreaming-counter-live.itest.ts` = AC-2. No security report, no QA report.
- **PRD-029:** `tests/daemon/runtime/health.test.ts` = "PRD-029 suite (AC-2/3/4/5)"; `tests/dashboard/web/app.test.tsx` has `PRD-029 AC-1` (lexical badge), `D-2` (health strip), `AC-5` (no-secret). Has `reports/2026-06-21-security-report.md`; no QA report.

## Plan (verification, not build)

```
Gate (orchestrator: npm run ci) ──► Close-out [security-worker-bee (both surfaces) ──► quality-worker-bee ×2 (per PRD)] ──► reconcile docs + lifecycle-move to completed ──► ship PR
```

- **security-worker-bee** (opus, security-stinger): audit both surfaces — 026 dreaming-enablement ack no-secret + model-call path; 029 no-secret in `/health` detail + degraded logs (AC-5 / D-5). 026 has no prior security report; 029's is re-confirmed on current main. Remediate any Crit/High.
- **quality-worker-bee** ×2 (opus, quality-stinger), parallel (independent subsystems): verify each PRD's 6 ACs against the live code + tests; write the missing QA report to each PRD's `reports/`.
- If quality finds a genuine gap → it reopens as OPEN → implementation wave for that gap, then re-close-out. Else → reconcile (Status flip + note) + `git mv` to `completed/`.

## Ledger

| ID | PRD | Criterion | Status |
|---|---|---|---|
| 026-AC1..6 | 026 | enable flips trigger / cadence+single-pending / pass consolidates / nothing-lost / before-after / safety+gates | DONE (pending VERIFY) |
| 029-AC1..6 | 029 | lexical badge / structured /health reason / mode-gated / degraded log / no-secret / gates | DONE (pending VERIFY) |
| GATE | both | `npm run ci` green (live itests gated/skipped) | OPEN |
| SEC | both | security-worker-bee: no-secret + surface audit; Crit/High remediated | OPEN |
| QA-026 | 026 | quality-worker-bee verifies vs PRD-026; QA report written | OPEN |
| QA-029 | 029 | quality-worker-bee verifies vs PRD-029; QA report written | OPEN |

## Event log

- Phase 0 recon: read both PRDs end-to-end; re-audited live tree → both already implemented (per-AC tests present). Verify-not-build cycle.
- **Gate (orchestrator):** `npm run ci` green — 213 files, 2325 passed, 6 skipped (creds-gated live itests), 0 failed; typecheck + audit:sql clean. → GATE VERIFIED, AC-6 confirmed both.
- **Close-out 1 — security-worker-bee (opus):** CLEAN both surfaces — 0 Crit/High/Med/Low. Verified 026 no-secret ack (closed-enum `DreamAck`, jobId omitted), safe-by-default `enabled:false`, mutations via `submitProposal` only, model key behind the router seam; 029 no-secret `/health`/badge/log (closed enums) + mode-gated topology (server-resolved `config.mode`, unspoofable; public team/hybrid `/health` strips `reasons`). No code changes. → SEC VERIFIED. Reports: each PRD `reports/2026-06-22-security-report.md`.
- **Close-out 2 — quality-worker-bee ×2 (opus, parallel):**
  - **PRD-026: PASS 6/6.** AC-1 real config-driven trigger seam (env toggled); AC-2 counter itest (180−100=80 carry, single enqueue, pending-guard); AC-3/4/5 consolidation itest (real model + live DeepLake, merged-or-pending, source-backed non-decreasing, before/after delta, loud empty-pass guard); AC-6 destructive ops outside DIRECT_APPLY allow-list + creds-gated itests. D-1 false-safe default confirmed. → QA-026 VERIFIED. Report: `prd-026/reports/2026-06-22-qa-report.md`.
  - **PRD-029: PASS 6/6.** AC-1 badge present/absent on degraded; AC-2 structured `reasons` + coarse bit; AC-3 `publicHealthDetail` strips reasons team/hybrid, keeps local + protected; AC-4 `logDegradedRecall` once, prod-wired (`assemble.ts:593`); AC-5 closed enums, injected Bearer+org-GUID don't leak; AC-6 gates. D-3 additive confirmed. Suggestion (non-blocking): `schema` reason hard-wired `ok` (missing-table signal deferred per PRD). → QA-029 VERIFIED. Report: `prd-029/reports/2026-06-22-qa-report.md`.
- **ALL VERIFIED.** Reconciled (Status flip + dated notes), `git mv` both → `completed/`. **`in-work/` now empty.** → Phase 3 Ship.

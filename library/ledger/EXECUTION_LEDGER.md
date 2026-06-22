# Execution Ledger — Index

This folder holds the `/the-smoker` acceptance-criteria ledgers. **This file is the index**; each
`EXECUTION_LEDGER-prd-<NNN>.md` sibling is the per-PRD run ledger for that PRD's build. The binding
verification records for every PRD live in that PRD's `reports/` folder (security + QA reports);
git history + PR descriptions hold the per-run event logs.

> Moved here from the repo root on 2026-06-22 to de-clutter the root. `/the-smoker` now writes new
> ledgers to `library/ledger/` (see `.claude/commands/the-smoker.md`).

**Last updated:** 2026-06-22

## Lifecycle status (source of truth = folder tier in `library/requirements/`)

| Tier | PRDs | Count |
|---|---|---|
| **completed/** | 001–025, 027, 028, 030, 031, 032, 033, 034, 035, 036 | 34 |
| **in-work/** | **026** (dreaming-loop-enablement), **029** (degradation-observability) | 2 |
| **backlog/** | 037–044 (dashboard mini-site: nav-shell + 7 pages) | 8 |

Only **026** and **029** remain genuinely incomplete — both lack a QA report (never run through the
close-out loop). Everything else has a pass-class QA verdict (CLEAN TO SHIP / PASS / VERIFIED /
PASS-WITH-FINDINGS) and is shipped on `main`.

## Recent `/the-smoker` runs

### PRD-035 + PRD-036 — dashboard data fixes + skill discovery (shipped, PR #65; lifecycle PR #66)
Broken-first dashboard fixes, 38/38 ACs VERIFIED, security + quality clean. Sessions→Turns rename,
real Est. savings (memory-corpus token proxy over `memories.content`), codebase-graph widget
render+click (deleted the hardcoded `NODE_POS`; pure exported `layout()`), local skill/agent scanner
(`installed-assets.ts`) + `installed ∪ synced` union view + `teamSkillCount` KPI. Opportunistic fix:
`fetchKpisView` Memories count `sqlIdent("memory")`→`"memories"` (was silently 0). Reports in each
PRD's `reports/`. (No per-PRD ledger file — run log is in PR #65.)

### PRD-014 — codebase graph-build daemon wiring (shipped, PR #67)
Closed PRD-014's one deferred item: the build pipeline was built + unit-tested (28/28) but its
daemon-assembly wiring was deferred, so `graph build` returned **501**. Wired `mountGraphApi`
(`POST /api/graph/build` + `GET /api/graph`) into the production `assembleDaemon()` step 13. 501→200
proven; assemble suite now asserts the seam fires. Security 0 Crit/High (1 Medium fixed: git-OID
path-safety); quality PASS-WITH-FINDINGS. See [`EXECUTION_LEDGER-prd-014.md`](./EXECUTION_LEDGER-prd-014.md)
+ `prd-014/reports/2026-06-22-*`.

### Gap-track audit (2026-06-22) — 014 / 030 / 027
A 3-track parallel run to fix audit-flagged gaps found that **only PRD-014 was a real code gap**.
**PRD-030** (compaction `epistemic_assertions` key-column Critical) and **PRD-027** (recall RRF
ranking) were already fixed/merged on `main` (verified by tracing the writers / commit `405efcf`
#48) — their "NOT VERIFIED" / "backlog" labels were **stale docs**, now reconciled by moving both to
`completed/`. The audit had over-stated the gaps from out-of-date QA/index bookkeeping.

## Open work

- **PRD-026 — dreaming-loop-enablement** (in-work): `/api/diagnostics/dream` returns
  `{triggered:false, status:"skipped", reason:"disabled"}` — the loop is built (PRD-009) but not
  enabled. No QA report. Genuinely incomplete.
- **PRD-029 — degradation-observability** (in-work): partially live (the dashboard subsystems strip +
  lexical-fallback badge ship) but never QA'd; no QA report.
- **Follow-ups (non-blocking):** richer `graph` CLI verbs (`diff`/`history`/`init`/`pull`); transitive
  `tmp` npm-audit High (→ dependency-audit); re-audit 026/029 to confirm true remaining scope.
- **Backlog:** PRDs 037–044 (the dashboard mini-site) — nav-shell foundation then the 7 routed pages.

# QA Report: PRD-066e Upgrade And Rollback Hardening

**Plan document:** `library/requirements/backlog/prd-066-local-queue-idle-cost-control/prd-066e-local-queue-idle-cost-control-upgrade-and-rollback-hardening.md`
**Audit date:** 2026-06-29
**Base branch:** `main`
**Head:** `legion/fix-golden-path-ci-workspace`
**Auditor:** quality-worker-bee

## Summary

The implementation is a solid PRD-066e hardening pass, but it is not complete for production
default-on. Package upgrade, rollback diagnostics, topology gating, support docs, SQL audit, and
live idle repo-build proof are covered; packaged-upgrade recall, packaged-upgrade idle gate
automation, and physical dogfood scenarios remain release blockers.

## Scorecard

| Category | Status | Notes |
| --- | --- | --- |
| Completeness | Partial | 11 of 14 ACs are covered; AC-3, AC-12, and AC-14 remain blocked for production default-on. |
| Correctness | Pass | Implemented code paths match the covered PRD behavior and verification passed. |
| Alignment | Pass | New code stays in daemon runtime/service seams, protected diagnostics, smoke scripts, and PRD QA docs. |
| Gaps | Partial | Package-specific recall/live idle automation and physical dogfood receipts remain open. |
| Detrimental | Pass | Security review found and fixed the host-override issue; typecheck, SQL audit, and smoke passed after remediation. |

## Critical Issues (must fix)

- [ ] **Packaged-upgrade recall proof is still pending (AC-3)**, `library/requirements/backlog/prd-066-local-queue-idle-cost-control/qa/2026-06-29-prd-066e-dogfood-matrix.md:17`

  PRD-066e requires proof that existing DeepLake memory rows and recall behavior remain available
  after upgrade. The current branch has live repo-build recall/active-memory evidence, but the dogfood
  matrix correctly records that packaged-upgrade-specific recall proof is still pending. Suggested:
  extend the packaged upgrade smoke or add a companion live smoke that seeds or reads an existing
  memory row after installing the candidate package.

  ```md
  | Existing DeepLake recall after package upgrade | ... packaged-upgrade-specific recall proof remains pending. | Pending automation |
  ```

- [ ] **Physical dogfood scenarios are not complete (AC-12)**, `library/requirements/backlog/prd-066-local-queue-idle-cost-control/qa/2026-06-29-prd-066e-dogfood-matrix.md:14`

  PRD-066e explicitly requires restart, sleep/wake, transient DeepLake outage, and rollback dogfood
  evidence. Restart and rollback are automated, but sleep/wake and outage are still pending. Suggested:
  run a bounded single-machine dogfood window and attach receipts before enabling default-on.

  ```md
  | Sleep/wake | Must run on a laptop/desktop ... | Pending dogfood |
  ```

- [ ] **Package-specific live idle release gate is not automated yet (AC-14)**, `library/requirements/backlog/prd-066-local-queue-idle-cost-control/qa/2026-06-29-prd-066e-dogfood-matrix.md:16`

  The repo-build live idle meter passed with `local_poll_reads=0`, but PRD-066e asks the release gate
  to fail if idle local mode produces DeepLake coordination reads after packaged upgrade. The current
  packaged smoke checks DBs and diagnostics, not query-meter coordination reads. Suggested: combine
  the packaged install path with the PRD-062/066 meter before production default-on.

  ```md
  | Live idle meter after package upgrade | ... packaged-upgrade-specific live meter still needs a single command gate. | Pending automation |
  ```

## Warnings (should fix)

None.

## Suggestions (consider improving)

None.

## Plan Item Traceability

| # | Plan Requirement | Status | Implementation Location | Notes |
| --- | --- | --- | --- | --- |
| AC-1 | Packaged upgrade smoke installs previous package, upgrades candidate, boots via package/CLI. | Pass | `scripts/local-queue-packaged-upgrade-smoke.mjs:41`, `scripts/local-queue-packaged-upgrade-smoke.mjs:51`, `package.json:83` | Final smoke passed. |
| AC-2 | First boot creates local queue DB and preserves/reopens logs DB. | Pass | `scripts/local-queue-packaged-upgrade-smoke.mjs:52`, `scripts/local-queue-packaged-upgrade-smoke.mjs:57` | Smoke asserts DB files and tables. |
| AC-3 | Existing DeepLake memory rows and recall remain available after upgrade. | Fail | `library/requirements/backlog/prd-066-local-queue-idle-cost-control/qa/2026-06-29-prd-066e-dogfood-matrix.md:17` | Package-specific recall proof pending. |
| AC-4 | Pending pre-upgrade shared local-kind job follows migration policy without duplicate success. | Pass | `src/daemon/runtime/services/local-queue-diagnostics.ts:157`, `tests/daemon/runtime/services/local-queue-diagnostics.test.ts:103` | Existing hybrid tests cover local-before-shared drain; diagnostics count pending shared work. |
| AC-5 | New local-only jobs enqueue locally and not as DeepLake queue rows. | Pass | `tests/daemon/runtime/services/local-queue-diagnostics.test.ts:75`, `tests/daemon/runtime/services/hybrid-job-queue.test.ts:65` | Covered by focused hybrid and live idle meter evidence. |
| AC-6 | Rollback flag off returns to shared path and reports stranded local queued work. | Pass | `src/daemon/runtime/services/local-queue-diagnostics.ts:101`, `tests/daemon/runtime/services/local-queue-diagnostics.test.ts:24` | Diagnostics report warning/counts. |
| AC-7 | Rollback requires no DeepLake schema migration and no local DB deletion. | Pass | `src/daemon/runtime/services/local-queue-diagnostics.ts:122`, `tests/daemon/runtime/services/local-queue-diagnostics.test.ts:24` | Explicit false fields covered. |
| AC-8 | Default-on blocked unless single-machine/local topology. | Pass | `src/daemon/runtime/services/local-queue-diagnostics.ts:65`, `tests/daemon/runtime/services/local-queue-diagnostics.test.ts:46` | Single-machine eligible, unknown blocked. |
| AC-9 | Multi-device/fleet/unknown fallback unless opt-in. | Pass | `src/daemon/runtime/services/local-queue-diagnostics.ts:77`, `tests/daemon/runtime/services/local-queue-diagnostics.test.ts:55` | Explicit opt-in override covered. |
| AC-10 | Diagnostics identify local counts, shared drain, pending old shared jobs. | Pass | `src/daemon/runtime/local-queue-diagnostics-api.ts:19`, `src/daemon/runtime/assemble.ts:1078`, `tests/daemon/runtime/services/local-queue-diagnostics.test.ts:75` | Mounted under protected diagnostics group. |
| AC-11 | Packaged smoke verifies second boot against upgraded workspace. | Pass | `scripts/local-queue-packaged-upgrade-smoke.mjs:60` | Final smoke passed. |
| AC-12 | Dogfood evidence covers restart, sleep/wake, outage, rollback. | Fail | `library/requirements/backlog/prd-066-local-queue-idle-cost-control/qa/2026-06-29-prd-066e-dogfood-matrix.md:14` | Sleep/wake and outage pending. |
| AC-13 | Release/support docs describe upgrade/rollback/old jobs/local DB/cost paths. | Pass | `library/requirements/backlog/prd-066-local-queue-idle-cost-control/qa/2026-06-29-prd-066e-upgrade-support-notes.md:27`, `library/requirements/backlog/prd-066-local-queue-idle-cost-control/qa/2026-06-29-prd-066e-upgrade-support-notes.md:68` | Support notes added. |
| AC-14 | Release gate fails if idle local mode produces DeepLake coordination reads after packaged upgrade. | Fail | `library/requirements/backlog/prd-066-local-queue-idle-cost-control/qa/2026-06-29-prd-066e-dogfood-matrix.md:16` | Package-specific meter gate pending. |
| NG-1 | Do not implement hosted multi-device control-plane upgrade semantics. | Pass | `src/daemon/runtime/services/local-queue-diagnostics.ts:65` | Only topology gating/diagnostics were added. |
| NG-2 | Do not migrate shared cross-device jobs into the local queue. | Pass | `src/daemon/runtime/services/local-queue-diagnostics.ts:157` | Shared old jobs are counted/preserved/drained by existing shared path. |
| NG-3 | Do not remove old DeepLake-backed `memory_jobs` path. | Pass | `src/daemon/runtime/assemble.ts:1949` | Shared queue still created and used for fallback. |
| NG-4 | Do not change DeepLake memory/recall/vector/graph schemas. | Pass | `src/daemon/runtime/services/local-queue-diagnostics.ts:157` | New query is read-only diagnostics; no schema changes. |
| NG-5 | Do not store DeepLake credentials in local queue. | Pass | `src/daemon/runtime/services/local-job-queue.ts:127` | Existing secret-key payload rejection remains in place. |

## Files Changed

- `library/ledger/EXECUTION_LEDGER-prd-066.md` (M), updated PRD-066e AC statuses and verification evidence.
- `library/requirements/backlog/prd-066-local-queue-idle-cost-control/qa/2026-06-29-prd-066e-dogfood-matrix.md` (A), records automated and pending dogfood gates.
- `library/requirements/backlog/prd-066-local-queue-idle-cost-control/qa/2026-06-29-prd-066e-qa-report.md` (A), this QA report.
- `library/requirements/backlog/prd-066-local-queue-idle-cost-control/qa/2026-06-29-prd-066e-security-review.md` (A), security close-out report.
- `library/requirements/backlog/prd-066-local-queue-idle-cost-control/qa/2026-06-29-prd-066e-upgrade-support-notes.md` (A), support/release guidance for upgrade, rollback, old jobs, and cost paths.
- `package.json` (M), adds `smoke:local-queue-packaged-upgrade`.
- `scripts/local-queue-packaged-upgrade-smoke.mjs` (A), packaged install/upgrade/CLI second-boot smoke.
- `src/cli/runtime.ts` (M), allows isolated loopback port override while constraining host override to loopback.
- `src/daemon/runtime/assemble.ts` (M), wires local queue diagnostics and rollback-visible local DB handling.
- `src/daemon/runtime/local-queue-diagnostics-api.ts` (A), adds protected diagnostics mount.
- `src/daemon/runtime/services/local-job-queue.ts` (M), adds `openExistingOnly` mode for rollback diagnostics.
- `src/daemon/runtime/services/local-queue-diagnostics.ts` (A), adds topology, rollback, and pending shared-job diagnostics.
- `tests/daemon/runtime/assemble.test.ts` (M), covers the new diagnostics seam wiring.
- `tests/daemon/runtime/services/local-queue-diagnostics.test.ts` (A), covers rollback, topology, and pending shared-job diagnostics.

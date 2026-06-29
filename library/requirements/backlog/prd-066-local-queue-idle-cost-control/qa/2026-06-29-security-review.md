# Security Review: PRD-066 Local Queue Idle-Cost Control

**Plan document:** `library/requirements/backlog/prd-066-local-queue-idle-cost-control/`
**Audit date:** 2026-06-29
**Base branch:** `main`
**Head:** `legion/forked-database-route-reduce-cost` (`522b85f`)
**Auditor:** main thread fallback after `security-worker-bee` dispatch failed before allocation

## Summary

No Critical or High security issues were detected in the implemented PRD-066 local queue and hybrid router scope. The main residual risk is operational rather than code-level: live DeepLake credentials and an idle measurement window are still required before claiming zero coordination reads in production-like conditions.

## Scope

- `src/daemon/runtime/services/local-job-queue.ts`
- `src/daemon/runtime/services/hybrid-job-queue.ts`
- `src/daemon/runtime/assemble.ts`
- `tests/daemon/runtime/services/local-job-queue.test.ts`
- `tests/daemon/runtime/services/hybrid-job-queue.test.ts`
- `library/ledger/EXECUTION_LEDGER-prd-066.md`

## Findings

### Critical

None detected.

### High

None detected.

### Medium

None detected in code. Live proof is still required for the idle-cost claim and is tracked in the execution ledger.

### Low / Residual Risks

- Payload secret prevention is key-name based, not content scanning. The queue rejects fields such as `deeplakeToken`, `password`, `secret`, `credential`, and `cookie` before persistence at `src/daemon/runtime/services/local-job-queue.ts:472`, but it does not attempt to classify arbitrary string values.
- `node:sqlite` remains an experimental Node API and emits an experimental warning during tests. This is an operational compatibility risk, not a credential or injection finding.

## Security Checks

| Check | Result | Evidence |
|---|---|---|
| SQL interpolation safety | Pass | Local schema identifiers use `sqlIdent`; values are bound through SQLite placeholders at `src/daemon/runtime/services/local-job-queue.ts:202` and `src/daemon/runtime/services/local-job-queue.ts:270`. `npm run audit:sql` passed. |
| Secret persistence guard | Pass | Payloads are zod-validated and secret-like keys are rejected before enqueue at `src/daemon/runtime/services/local-job-queue.ts:263` and `src/daemon/runtime/services/local-job-queue.ts:472`. |
| DeepLake credential custody | Pass | The local queue stores job payloads only and does not introduce credential storage or Deeplake token handling. |
| Shared queue idle reaper | Pass | Local-only mode does not start the shared queue service unless migration drain mode is enabled at `src/daemon/runtime/services/hybrid-job-queue.ts:112`. |
| Rollback safety | Pass | `HONEYCOMB_LOCAL_QUEUE_ENABLED=false` returns the existing shared queue path at `src/daemon/runtime/services/hybrid-job-queue.ts:54`. |

## Verification

- `npx vitest run tests/daemon/runtime/services/hybrid-job-queue.test.ts tests/daemon/runtime/services/local-job-queue.test.ts` passed, 21 tests.
- `npm run typecheck` passed.
- `npm run audit:sql` passed.
- `npm run ci` reached the broad suite but failed on `tests/property/json-parsers.property.test.ts:104` due a 5000 ms timeout under full-suite load; the same file passed when rerun directly.

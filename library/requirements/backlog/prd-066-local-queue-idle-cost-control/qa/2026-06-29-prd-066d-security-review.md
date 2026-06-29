# PRD-066d Security Review

> **Date:** 2026-06-29
> **Scope:** PRD-066d verification hardening and built-daemon upgrade smoke
> **Reviewer:** security close-out worker plus main-thread verification
> **Result:** Pass after remediation

## Reviewed Files

- `src/daemon/runtime/assemble.ts`
- `tests/integration/local-queue-idle-meter-live.itest.ts`
- `scripts/local-queue-upgrade-smoke.mjs`
- `package.json`

## Findings

### High: Built-daemon smoke inherited unsafe parent environment

**Status:** Fixed

The first smoke implementation spawned the built daemon with the full parent `process.env`. That
could inherit `HONEYCOMB_BIND`, `HONEYCOMB_MODE`, live DeepLake credentials, or tracing flags from a
developer shell. A local no-creds upgrade smoke should not accidentally widen bind posture or touch
real DeepLake state.

**Fix:** `scripts/local-queue-upgrade-smoke.mjs` now constructs a constrained smoke environment,
deletes widening and credential-bearing Honeycomb variables, sets `HONEYCOMB_HOST=127.0.0.1`, uses a
temporary `HOME`/`USERPROFILE`, disables side-effect workers, and explicitly enables only the local
queue path under a temporary workspace.

## No Remaining Critical Or High Findings

- The `AssembleDaemonOptions.jobQueueConfig` seam is an in-process assembly option only. It is not a
  user-facing environment variable or request parameter.
- The shared queue table override still flows through `createJobQueueService`, whose table name is
  validated by existing SQL identifier guards.
- The live idle-meter test generates a `ci_066d_*_jobs` table name, never the canonical
  `memory_jobs` table, and drops the throwaway table in a best-effort `finally` path.
- The built-daemon smoke starts children hidden, waits for `/health`, inspects local SQLite schema,
  terminates children in `finally`, and removes its temporary workspace.

## Verification

- `node --check scripts/local-queue-upgrade-smoke.mjs` passed.
- `npm run smoke:local-queue-upgrade` passed after the environment hardening.
- `npm run audit:sql` passed after the final changes.

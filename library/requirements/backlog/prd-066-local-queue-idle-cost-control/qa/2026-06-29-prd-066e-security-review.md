# PRD-066e Security Review

> Date: 2026-06-29
> Scope: Packaged upgrade smoke, local queue diagnostics, topology/rollback diagnostics, and CLI
> isolated-port support.

## Result

Pass after remediation.

## Findings

### Fixed - Medium - CLI host override could leave loopback

`src/cli/runtime.ts` was changed so the CLI could honor `HONEYCOMB_HOST`/`HONEYCOMB_PORT` for the
packaged smoke. The port override is needed for isolated smoke tests, but an unrestricted host
override could make the loopback client send tenancy headers to a non-loopback host if a hostile
environment variable were present.

Remediation: `daemonHost()` now accepts only `127.0.0.1` or `localhost`; all other values fall back
to the compiled loopback default.

## Reviewed Surfaces

- `scripts/local-queue-packaged-upgrade-smoke.mjs`
  - Uses array-based child process arguments.
  - Avoids `shell: true`.
  - Uses a temp workspace/home.
  - Removes known Honeycomb/DeepLake credential environment variables from daemon boot env.
  - Forces `HONEYCOMB_DAEMON_SERVICE=spawn` so the smoke does not register an OS service.
- `src/daemon/runtime/services/local-queue-diagnostics.ts`
  - SQL identifiers route through `sqlIdent`.
  - Job kinds/statuses route through `sLiteral`.
  - Pending shared-job counting is request-time only and not an idle poll.
- `src/daemon/runtime/local-queue-diagnostics-api.ts`
  - Mounts under the already protected `/api/diagnostics` group.
  - Exposes counts/status/topology only; no token, credential, or DSN material.
- `src/daemon/runtime/services/local-job-queue.ts`
  - `openExistingOnly` does not create a local DB on clean rollback/disabled installs.
  - Missing existing DB is silent; real SQLite/open failures still warn and fail closed to the null
    local queue.

## Residual Risk

The diagnostics endpoint can intentionally perform one DeepLake pending-job count when called. That
is acceptable for operator diagnostics and should remain documented as request-time cost, not idle
polling.

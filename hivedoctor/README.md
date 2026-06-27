# @legioncodeinc/hivedoctor

A deliberately tiny, dependency-light, self-healing watchdog for the Honeycomb
primary daemon. HiveDoctor probes the daemon's `/health`, restarts it with
exponential backoff when it stops answering, escalates when it cannot heal, and is
built to be effectively incapable of crashing.

> Status: Wave 0 (foundation) + sub-PRD 064a (supervisor core and lifecycle). This
> package is not yet published, wired into an installer, or shipped. See
> `library/requirements/in-work/prd-064-hivedoctor-self-healing-watchdog/`.

## Design principles (binding)

1. Incapable of crashing. The runtime uses Node built-ins ONLY
   (`node:http`, `node:child_process`, `node:fs`, `node:os`, `node:timers`,
   `node:path`, `node:crypto`). There are zero runtime npm dependencies. Every probe
   and remediation runs inside a try/catch that logs and continues, and a global
   `uncaughtException` / `unhandledRejection` net keeps the loop alive as a last
   resort.
2. Loopback only. HiveDoctor reaches the daemon over `127.0.0.1` and never opens an
   inbound port.
3. Silent on the happy path, loud on the hard path. A healthy probe is a debug line;
   a remediation or an escalation is a high-signal log + an incident record.

## What is in Wave 0

- `src/config.ts` - resolves the watchdog config (probe interval, target URL,
  backoff floor/ceiling, restart give-up threshold, workspace dir) from env over
  defaults, hand-validated (zod-free).
- `src/state.ts` - defensive read/write of `state.json` (atomic write, graceful
  degradation to defaults).
- `src/incidents.ts` - the append-only, size-capped `incidents.ndjson` episode model
  and its exported types.
- `src/logger.ts` - a tiny leveled logger, low-verbosity by default, that never
  throws.
- `src/health-probe.ts` - `GET /health` over `node:http` with a short timeout,
  classified into `ok` / `degraded` / `unreachable-refused` / `unreachable-timeout`,
  parsing the per-subsystem reasons shape from the daemon's `health.ts`.
- `src/backoff.ts` - geometric backoff with jitter, floor/ceiling, and a persisted
  rung; reset on healthy.
- `src/remediation.ts` - a `Rung` interface + registry. Wave 0 implements rung 1
  (restart) behind an injected `RestartFn`; rungs 2+ are declared slots for later
  waves. Includes the give-up-after-3 advance and the PID/lock + cooldown guards.
- `src/supervisor.ts` - the watch loop (probe -> classify -> heal -> incident),
  crash-safe, with an injectable clock for tests.

## Development

This package is self-contained: it has its own `tsconfig.json` and
`vitest.config.ts` and does not participate in the repo-root gates.

```sh
cd hivedoctor
npm install      # dev deps only (typescript, vitest, @types/node)
npm run typecheck
npm run test
```

## Out of scope for Wave 0

Rungs 2 to 5 (reinstall, uninstall conflicting Hivemind, escalate), telemetry, the
CLI and ASCII art, the auto-update engine, OS-service registration, and any repo
build/CI wiring. Those land in later sub-PRDs (064b through 064h).

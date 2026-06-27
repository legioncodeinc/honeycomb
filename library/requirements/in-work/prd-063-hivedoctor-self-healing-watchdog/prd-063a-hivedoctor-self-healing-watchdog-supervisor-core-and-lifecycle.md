# PRD-063a: HiveDoctor - Supervisor Core and Lifecycle

> **Parent:** [PRD-063](./prd-063-hivedoctor-self-healing-watchdog-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** L (1-3d)

---

## Goals

The beating heart of HiveDoctor: a watch loop that probes the primary daemon's health, classifies the failure, and drives the escalating remediation ladder with exponential backoff - all without ever crashing itself.

- Probe `GET http://127.0.0.1:3850/health` on a fixed interval (default 30s, configurable).
- Read the structured per-subsystem reasons from [`health.ts`](../../../../src/daemon/runtime/health.ts) (`storage`, `embeddings`, `schema`) so the loop chooses the right rung instead of blindly restarting.
- Drive the remediation ladder (rungs defined in [063c](./prd-063c-hivedoctor-self-healing-watchdog-remediation-ladder.md)) with exponential backoff between attempts, mirroring the bounded-backoff precedent in [`embed-supervisor.ts`](../../../../src/daemon/runtime/services/embed-supervisor.ts) and [`poll-backoff.ts`](../../../../src/daemon/runtime/services/poll-backoff.ts).
- Reset the backoff on a confirmed return to `healthy`; persist current rung + last-heal to `state.json`.

## Scope

- The watch loop, jittered interval, and health classification.
- The backoff schedule (geometric, floor 1s, ceiling 30s for restarts; longer ceilings between heavier rungs) and the give-up-and-escalate threshold (systemd `StartLimitBurst` analogue).
- Rung 1 (restart the daemon) implemented here, reusing the [`restart-helper.ts`](../../../../src/daemon/restart-helper.ts) approach (wait for old `/health` down, spawn fresh detached, pin workspace + `HONEYCOMB_WORKSPACE`).
- Crash-safety wrapping: every probe and every remediation runs inside `try/catch`; a global `uncaughtException`/`unhandledRejection` net logs and keeps the loop alive.
- The incident-episode model written to `incidents.ndjson` (consumed by 063d/063g).

## Out of scope

- Heavier rungs (reinstall, clear creds, uninstall Hivemind) - [063c](./prd-063c-hivedoctor-self-healing-watchdog-remediation-ladder.md).
- The OS-level supervision of HiveDoctor itself - [063b](./prd-063b-hivedoctor-self-healing-watchdog-self-supervision-and-install-integration.md).
- Telemetry emission - [063d](./prd-063d-hivedoctor-self-healing-watchdog-telemetry-and-observability.md).

## Acceptance criteria

- AC-063a.1 Given the daemon answers `/health` `ok`, when the loop fires, then HiveDoctor takes no action and logs at low verbosity.
- AC-063a.2 Given `/health` is unreachable, when the loop fires, then HiveDoctor invokes rung 1 (restart) and, on success, the next probe reads `healthy` and the backoff resets.
- AC-063a.3 Given **3** consecutive failed restarts (OD-4 resolved), when the threshold is hit, then HiveDoctor advances to rung 2 (reinstall) rather than restarting forever.
- AC-063a.4 Given `/health` reports a specific failing subsystem (e.g. `schema`), when the loop classifies it, then the chosen rung matches the reason (targeted, not blind).
- AC-063a.5 Given a remediation step throws, when it fails, then the exception is caught, recorded in the incident, and the loop continues (AC-8 parent).
- AC-063a.6 Given HiveDoctor restarted the daemon, when it did so, then a cooldown prevents fighting the daemon's own lock/restart-helper, respecting `~/.honeycomb/daemon.pid`.

## Technical considerations

- **Probe transport:** `node:http` GET with a short timeout; treat connection-refused, timeout, and non-200 distinctly (refused vs hung vs degraded drive different rungs).
- **Backoff:** geometric with jitter, persisted across HiveDoctor restarts via `state.json` so a reboot does not reset a crash loop's memory.
- **Workspace pinning:** the restart must set cwd/`HONEYCOMB_WORKSPACE` to a writable repo-root workspace - this is the exact fix for the "secrets 502 = daemon cwd is system32" failure mode.
- **Idempotency:** never start a second daemon if the PID/lock is held and `/health` is actually answering.

## Open questions

- [ ] Probe interval default (30s proposed). Restart give-up threshold is resolved at **3** (OD-4).
- [ ] Should classification ever skip rungs (e.g. a `schema` failure jump straight to reinstall)? Or always climb one rung at a time?

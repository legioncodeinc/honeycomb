# PRD-064h: HiveDoctor - Primary Daemon as an OS-Native Service

> **Parent:** [PRD-064](./prd-064-hivedoctor-self-healing-watchdog-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** L (1-3d)

---

## Goals

Per OD-1 (Mario, 2026-06-27): the Honeycomb **primary daemon** should itself be OS-native, not just spawned-and-detached by the CLI. The OS service manager becomes the **liveness floor** - it restarts the daemon on crash and starts it on boot - while HiveDoctor remains the **intelligent healing layer** above it (handles wedged-but-alive, stale routes, bad installs, version updates, and escalation, which a dumb OS restart cannot).

- Register the primary daemon (`src/daemon`, `127.0.0.1:3850`) as an OS service: launchd / systemd-user / Windows Service or Scheduled Task, with restart-on-crash + start-on-boot.
- Replace (or wrap) the current detached `spawn()` lifecycle in [`src/cli/runtime.ts`](../../../../src/cli/runtime.ts) so the canonical "is the daemon running" authority is the service, while preserving the PID/lock single-instance guard in [`assemble.ts`](../../../../src/daemon/runtime/assemble.ts).
- Make HiveDoctor's rung-1 restart go *through* the service manager (`launchctl kickstart` / `systemctl --user restart` / `Restart-Service` / task re-run) rather than spawning a second process - eliminating the watchdog-war / double-bind risk.

## Scope

- Per-OS service templates for the primary daemon (sibling to 064b's HiveDoctor templates; same approach, separate units), pinning the writable workspace + `HONEYCOMB_WORKSPACE` so the daemon never boots from `C:\WINDOWS\system32` (the documented "secrets 502" failure).
- Installer wiring: `honeycomb install` ([`src/commands/install.ts`](../../../../src/commands/install.ts)) registers + starts the daemon service instead of (or in addition to) the detached spawn.
- CLI lifecycle reconciliation: `honeycomb` start/stop/status (`buildDaemonLifecycle`) operate the service.
- A clean uninstall path that deregisters the service.

## Out of scope

- HiveDoctor's own service - [064b](./prd-064b-hivedoctor-self-healing-watchdog-self-supervision-and-install-integration.md).
- The healing logic that sits above the service - [064a](./prd-064a-hivedoctor-self-healing-watchdog-supervisor-core-and-lifecycle.md)/[064c](./prd-064c-hivedoctor-self-healing-watchdog-remediation-ladder.md).
- The embeddings child, which the primary daemon keeps supervising itself (OD-8 indirect).

## Acceptance criteria

- AC-064h.1 Given a clean install, when bootstrap completes, then the primary daemon runs as an OS service and answers `/health`.
- AC-064h.2 Given the daemon process is killed, when the OS service manager notices, then it restarts the daemon without HiveDoctor having to intervene (liveness floor).
- AC-064h.3 Given a reboot, when the machine returns, then the daemon starts automatically.
- AC-064h.4 Given the service starts the daemon, when it does, then cwd/`HONEYCOMB_WORKSPACE` is a writable repo-root workspace (never `system32`), closing the "secrets 502" class.
- AC-064h.5 Given HiveDoctor performs a rung-1 restart, when it does, then it goes through the service manager and the PID/lock guard prevents any double-bind.
- AC-064h.6 Given `honeycomb` start/stop/status, when run, then they reflect and control the service state (not a stray detached process).

## Technical considerations

- **Division of labor:** OS service = "process is running"; HiveDoctor = "the install is actually healthy and current." Both are needed - a daemon can be running and still wedged (the memory_jobs backlog wedge), which the OS cannot detect but HiveDoctor's `/health` probe can.
- **Don't double-supervise the same way:** with the daemon OS-managed, HiveDoctor must restart *via* the service, not by spawning - otherwise the two race. This is the main reason to do 064h alongside HiveDoctor rather than later.
- **Migration:** existing installs currently use the detached spawn; the installer must transition them to the service without orphaning a running daemon (drain + handover, reuse [`restart-helper.ts`](../../../../src/daemon/restart-helper.ts) semantics).

## Open questions

- [ ] Do we keep the detached-spawn path as a fallback for environments where service registration is impossible (CI, locked-down corp machines)?
- [ ] Sequencing: ship 064h with HiveDoctor v1, or land the daemon-service first as a standalone hardening step?

> OD-1 (OS-native, daemon included) and the Windows default (**per-user Scheduled Task**, Windows Service as enterprise opt-in) are resolved in the parent index.

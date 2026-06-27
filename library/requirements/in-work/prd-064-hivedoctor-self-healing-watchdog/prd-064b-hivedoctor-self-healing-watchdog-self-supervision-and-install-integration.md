# PRD-064b: HiveDoctor - Self-Supervision and Install Integration

> **Parent:** [PRD-064](./prd-064-hivedoctor-self-healing-watchdog-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** L (1-3d)

---

## Goals

Answer "who watches the watchdog" and wire HiveDoctor into the install flow with an honest opt-out. HiveDoctor must survive its own crash and a reboot, supervised by the OS - never by the primary daemon.

- Register HiveDoctor with the OS service manager per platform: **launchd** (macOS), **systemd user service** (Linux), **Windows Service or Scheduled Task** (Windows), with restart-on-crash + start-on-boot.
- Bake HiveDoctor installation into the bootstrap installer ([`install.sh`](../../../../scripts/install/install.sh) / [`install.ps1`](../../../../scripts/install/install.ps1)) and the `honeycomb install` verb ([`src/commands/install.ts`](../../../../src/commands/install.ts)).
- Provide an explicit opt-out at install: **`--no-hivedoctor` is the only install-time switch** (OD-5 resolved). Finer toggles (telemetry off, auto-update off, observe-only) live in the **dashboard**, not as install flags; the telemetry env opt-outs (`DO_NOT_TRACK`, `HONEYCOMB_TELEMETRY=0`) are still honored.
- This sub-PRD registers HiveDoctor's own OS service. The Honeycomb **primary daemon** also becomes OS-native in the sibling sub-PRD [064h](./prd-064h-hivedoctor-self-healing-watchdog-primary-daemon-os-native-service.md); the two share the per-OS service-template approach but are independent units.

## Scope

- Per-OS service unit templates (plist / systemd unit / Windows service or `schtasks` XML), vendored as small text templates, installed by HiveDoctor's own `hivedoctor install-service` step.
- Installer hooks: after `npm i -g @legioncodeinc/honeycomb@latest`, install HiveDoctor (OD-6 resolved: own dependency-light package; bootstrap mechanic - second global vs bundled-and-extracted - is the one residual sub-question) and register its service unless `--no-hivedoctor`.
- Uninstall path: `hivedoctor uninstall-service` removes the unit cleanly.
- Persisting the master on/off into HiveDoctor `state.json`, reading dashboard-set toggles, and honoring env (`DO_NOT_TRACK`, `HONEYCOMB_TELEMETRY=0`).

## Out of scope

- The watch loop itself - [064a](./prd-064a-hivedoctor-self-healing-watchdog-supervisor-core-and-lifecycle.md).
- What telemetry is emitted - [064d](./prd-064d-hivedoctor-self-healing-watchdog-telemetry-and-observability.md).

## Acceptance criteria

- AC-064b.1 Given a clean install on each OS, when bootstrap completes (without opt-out), then a HiveDoctor service is registered and running.
- AC-064b.2 Given HiveDoctor is SIGKILLed, when the service manager notices, then it restarts HiveDoctor within the configured window (AC-1 parent).
- AC-064b.3 Given a reboot, when the machine comes back, then HiveDoctor starts automatically before/independently of the primary daemon.
- AC-064b.4 Given `--no-hivedoctor` at install, when bootstrap completes, then no service is registered and no HiveDoctor process runs (AC-10 parent).
- AC-064b.5 Given `hivedoctor uninstall-service`, when run, then the OS unit is removed and does not resurrect on next boot.
- AC-064b.6 Given a non-admin/unprivileged context, when service registration is not possible, then HiveDoctor falls back to a userland-scoped service (systemd `--user`, launchd LaunchAgent, Windows per-user Scheduled Task) rather than failing the install.

## Technical considerations

- **Prefer shelling out** to `launchctl` / `systemctl --user` / `sc.exe` / `schtasks` over a dependency, to honor the can't-crash / built-ins-only principle. Vendor only the unit templates.
- **User scope by default** (LaunchAgent / systemd `--user` / per-user Scheduled Task) avoids requiring root and matches a per-user install; document the system-scope option.
- **No mutual supervision.** HiveDoctor must not rely on the primary daemon to be restarted (rejected in OD-1).

## Open questions

- [ ] Bootstrap mechanic default is a second global `npm i -g @legioncodeinc/hivedoctor`; confirm there is no environment where bundled-and-extracted is required instead.

> OD-1 (OS-native), OD-5 (master switch + dashboard toggles), and the Windows default (**per-user Scheduled Task**; Windows Service as enterprise opt-in, shared with [064h](./prd-064h-hivedoctor-self-healing-watchdog-primary-daemon-os-native-service.md)) are resolved in the parent index.

# IRD-192: HiveDoctor Windows install-service generates invalid Scheduled Task restart interval

> **GitHub Issue:** [#192](https://github.com/legioncodeinc/honeycomb/issues/192) - Bug
>
> **Status:** Backlog
> **Priority:** P1
> **Effort:** M (3-8h)
> **Reporter:** Mario Aldayuz (@legioncodeinc)

---

## Problem

**Observed:** On Windows, `hivedoctor install-service` writes the per-user Scheduled Task XML to
`%USERPROFILE%\.honeycomb\hivedoctor\hivedoctor-task.xml`, but Windows Task Scheduler rejects that
XML because the generated restart-on-failure interval is `PT5S`.

Manual reproduction on this machine after upgrading to the published packages:

```text
> npm list -g --depth=0 @legioncodeinc/honeycomb @legioncodeinc/hivedoctor
@legioncodeinc/hivedoctor@0.1.9
@legioncodeinc/honeycomb@0.1.12

> hivedoctor install-service
Registered the HiveDoctor unit but a service-manager command failed (schtasks).
It will start at next login/boot; run `hivedoctor status` to check.

> schtasks /Create /XML "%USERPROFILE%\.honeycomb\hivedoctor\hivedoctor-task.xml" /TN HiveDoctor /F
ERROR: The task XML contains a value which is incorrectly formatted or out of range.
(29,24):Interval:PT5S

> schtasks /Query /TN HiveDoctor /FO LIST /V
ERROR: The system cannot find the file specified.
```

**Expected:** `hivedoctor install-service` on Windows should register and start a per-user
Scheduled Task without admin/UAC. The task should survive logoff/reboot, restart HiveDoctor after a
crash, and be visible to `schtasks /Query /TN HiveDoctor`. The installer must not tell users
"HiveDoctor is watching" unless the service manager actually accepted the task.

---

## Impact

- Windows users can have a healthy `honeycomb` daemon and a manually running HiveDoctor process, but
  no persistent watchdog service.
- After logoff/reboot, HiveDoctor will not automatically start, so it cannot supervise the primary
  daemon or report incidents.
- Crash recovery is weaker than advertised because the watchdog itself is not owned by Task
  Scheduler.
- The install scripts currently suppress `hivedoctor install-service` output and rely on exit code.
  Because the CLI returns success even when the service-manager command failed, the install path can
  produce a false-positive "HiveDoctor is watching" message.
- `hivedoctor status` reports `HiveDoctor service: unknown`, which makes it hard for users and
  support to distinguish "not installed", "installed but stopped", and "status probing not wired".

This is not a Honeycomb daemon boot failure. On the same machine, after `honeycomb daemon start`,
`GET http://127.0.0.1:3850/health` returned:

```json
{
  "status": "ok",
  "version": "0.1.12",
  "pipeline": "ok",
  "reasons": {
    "storage": "reachable",
    "embeddings": "on",
    "schema": "ok",
    "portkey": "off"
  }
}
```

The bug is the Windows HiveDoctor service persistence layer.

---

## Reproduction Steps

1. On Windows, install the current published packages:
   ```powershell
   npm install -g @legioncodeinc/honeycomb@0.1.12 @legioncodeinc/hivedoctor@0.1.9
   ```
2. Confirm the published shims resolve:
   ```powershell
   honeycomb --version
   hivedoctor --version
   ```
3. Run:
   ```powershell
   hivedoctor install-service
   ```
4. Inspect the generated XML:
   ```powershell
   Get-Content "$env:USERPROFILE\.honeycomb\hivedoctor\hivedoctor-task.xml"
   ```
5. Import it directly:
   ```powershell
   schtasks /Create /XML "$env:USERPROFILE\.honeycomb\hivedoctor\hivedoctor-task.xml" /TN HiveDoctor /F
   ```
6. Observe Task Scheduler rejects the XML at `<RestartOnFailure><Interval>PT5S</Interval>`.
7. Query the task:
   ```powershell
   schtasks /Query /TN HiveDoctor /FO LIST /V
   ```
8. Observe the task does not exist.

---

## Root Cause

### 1. Windows template reuses a POSIX-style 5-second restart value

[`hivedoctor/src/service/templates.ts`](../../../../hivedoctor/src/service/templates.ts) defines one
restart constant:

```ts
export const RESTART_SEC = 5 as const;
```

That value is appropriate for launchd throttle and systemd `RestartSec`, but the Windows Scheduled
Task XML renderer reuses it directly:

```xml
<RestartOnFailure>
  <Interval>PT${RESTART_SEC}S</Interval>
  <Count>999</Count>
</RestartOnFailure>
```

The generated value is `PT5S`, and Windows rejects it during `schtasks /Create /XML`.

### 2. The installer can report partial registration as success

[`hivedoctor/src/service/index.ts`](../../../../hivedoctor/src/service/index.ts) correctly detects
that a manager command failed and returns a warning string:

```ts
return `Registered the HiveDoctor unit but a service-manager command failed (...)`;
```

But [`hivedoctor/src/cli/dispatch.ts`](../../../../hivedoctor/src/cli/dispatch.ts) always returns
`EXIT_OK` after printing the service-module line:

```ts
const line = kind === "install" ? await deps.serviceModule.install() : await deps.serviceModule.uninstall();
io.out(line);
return EXIT_OK;
```

That means callers cannot distinguish real install success from "unit file written but service
manager rejected it".

### 3. The one-command installers suppress useful failure output

[`scripts/install/install.ps1`](../../../../scripts/install/install.ps1) runs:

```powershell
& $hd install-service 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  Write-Ok 'HiveDoctor is watching (it will restart the daemon on crash and survive reboots).'
}
```

[`scripts/install/install.sh`](../../../../scripts/install/install.sh) similarly redirects
`hivedoctor install-service` output to `/dev/null` and trusts the exit code.

Because the CLI exit code is currently success even on service-manager failure, the installer can
claim the watchdog is active when no scheduled task exists.

### 4. `hivedoctor status` service state is not wired to the real service probe

[`hivedoctor/src/cli/index.ts`](../../../../hivedoctor/src/cli/index.ts) currently injects:

```ts
serviceState: () => "unknown",
```

even though [`hivedoctor/src/service/index.ts`](../../../../hivedoctor/src/service/index.ts) exports
`serviceStatus()`. This keeps `hivedoctor status` from becoming the simple verification command a
user needs after install.

### 5. Existing tests assert shape, not Windows import validity

[`hivedoctor/tests/service/templates.test.ts`](../../../../hivedoctor/tests/service/templates.test.ts)
checks that the XML contains `RestartOnFailure`, `LogonTrigger`, and other expected fragments, but
it does not check that the XML is acceptable to Windows Task Scheduler. The invalid `PT5S` value
therefore passed the release test suite.

---

## Fix Plan

1. **Split restart timing by platform.**
   - Keep `RESTART_SEC = 5` for launchd/systemd behavior if desired.
   - Introduce a Windows-specific Scheduled Task restart interval constant.
   - Use a Task Scheduler-valid duration in XML. Candidate: `PT1M`, but the fix is not complete
     until a live Windows import proves it.

2. **Make Windows XML importable by Task Scheduler.**
   - Generate XML that `schtasks /Create /XML <file> /TN HiveDoctor /F` accepts on a non-admin
     Windows user session.
   - If fixing the interval exposes additional XML validity or principal issues, keep them in
     scope for this IRD. The acceptance criterion is a registered, queryable task, not merely
     "no PT5S".

3. **Return honest install/uninstall outcomes.**
   - Change the service module boundary from "string only" to a structured result, or otherwise
     make `install-service` return non-zero when any required service-manager command fails.
   - A unit-file write plus failed `schtasks /Create` is not a successful install.
   - Preserve non-throwing behavior: errors should still become clean CLI output, not stack traces.

4. **Make installer scripts honest.**
   - Once `hivedoctor install-service` returns non-zero on failure, ensure `install.ps1` and
     `install.sh` do not print "HiveDoctor is watching" unless registration and start both
     succeeded.
   - On failure, print a concise warning that includes the actionable command:
     `hivedoctor install-service`.
   - Do not block Honeycomb daemon install if HiveDoctor registration fails, but do not report
     the watchdog as active.

5. **Wire service status into `hivedoctor status`.**
   - Replace the hardcoded `unknown` service state with a real service-status read.
   - If the top-level status command must remain fast, it may use a bounded async call with the
     existing service command timeout or a short timeout dedicated to status.
   - Windows expected states:
     - task registered and query succeeds: `running` or at least `registered`;
     - task absent: `not-running`;
     - `schtasks` unavailable/spawn failure: `unknown`.

6. **Add Windows-specific live validation.**
   - Unit tests are necessary but insufficient.
   - Add or run a Windows live smoke that creates a temporary Scheduled Task from rendered XML,
     queries it, runs it, verifies one HiveDoctor process/status page, and deletes it.
   - The test must clean up even if assertions fail.

7. **Release as a HiveDoctor patch.**
   - Bump `hivedoctor/package.json` from `0.1.9` to the next patch.
   - Cut `hivedoctor-vX.Y.Z` only after the Windows install-service proof passes.

---

## Acceptance Criteria

| ID | Criterion |
|---|---|
| AC-1 | Given Windows and a non-admin user session, when `hivedoctor install-service` runs, then `schtasks /Create` succeeds and `schtasks /Query /TN HiveDoctor` finds the task. |
| AC-2 | Given the generated Scheduled Task XML, when imported by `schtasks /Create /XML`, then Windows does not reject any `RestartOnFailure` value as incorrectly formatted or out of range. |
| AC-3 | Given a successful install, when `schtasks /Run /TN HiveDoctor` runs, then exactly one HiveDoctor process is running and its status page binds `127.0.0.1:3852`. |
| AC-4 | Given a running HiveDoctor task, when the HiveDoctor process exits unexpectedly, then Task Scheduler restarts it within the configured restart window. |
| AC-5 | Given a successful install, when `hivedoctor status` runs, then it reports a non-`unknown` service state backed by the real service manager. |
| AC-6 | Given `schtasks /Create` fails for any reason, when `hivedoctor install-service` exits, then it returns a non-zero exit code and prints a clear failure line. |
| AC-7 | Given the one-command Windows installer, when HiveDoctor registration fails, then the installer does not print "HiveDoctor is watching" and instead prints a non-fatal warning. |
| AC-8 | Given repeated `hivedoctor install-service` runs, when the task already exists, then the command remains idempotent and leaves one registered task and one running watchdog process. |
| AC-9 | Given `hivedoctor uninstall-service`, when it runs after a successful Windows install, then it stops/removes the Scheduled Task and deletes the staged XML file. |
| AC-10 | Given macOS and Linux, when their service template and service-module tests run, then launchd/systemd behavior remains unchanged. |

---

## Required Test Plan

### Unit tests

- Update `hivedoctor/tests/service/templates.test.ts` to assert the Windows restart interval is the
  exact valid value chosen for Scheduled Task XML.
- Add a regression test proving `renderScheduledTaskXml()` no longer emits `PT5S`.
- Add a test covering any extra Windows XML fields needed for successful import, such as principal
  identity if required.
- Update `hivedoctor/tests/service/service-module.test.ts` so a failed install command produces a
  failure result that the CLI can map to non-zero.
- Update CLI delegation tests so `install-service` returns non-zero on service-manager failure.
- Update installer-script tests if present; otherwise document manual script verification.

### Windows live validation

Run on this machine or a Windows CI runner:

```powershell
npm install -g @legioncodeinc/hivedoctor@<candidate>
hivedoctor uninstall-service
hivedoctor install-service
schtasks /Query /TN HiveDoctor /FO LIST /V
schtasks /Run /TN HiveDoctor
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3852/status.json
```

Then verify crash recovery:

```powershell
$pid = (Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match '@legioncodeinc[\\\\/]hivedoctor.*bundle[\\\\/]cli.js run' } |
  Select-Object -First 1 -ExpandProperty ProcessId)
Stop-Process -Id $pid -Force
Start-Sleep -Seconds 90
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match '@legioncodeinc[\\\\/]hivedoctor.*bundle[\\\\/]cli.js run' }
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3852/status.json
```

Cleanup:

```powershell
hivedoctor uninstall-service
schtasks /Query /TN HiveDoctor
```

### Package-level proof

- Build and pack HiveDoctor from the repo.
- Install the packed tarball globally in a scratch Windows environment.
- Repeat the live validation against the packed install, not only `src/`.

---

## Files Touched

Expected implementation surface:

- [`hivedoctor/src/service/templates.ts`](../../../../hivedoctor/src/service/templates.ts)
- [`hivedoctor/src/service/argv.ts`](../../../../hivedoctor/src/service/argv.ts)
- [`hivedoctor/src/service/index.ts`](../../../../hivedoctor/src/service/index.ts)
- [`hivedoctor/src/cli/dispatch.ts`](../../../../hivedoctor/src/cli/dispatch.ts)
- [`hivedoctor/src/cli/index.ts`](../../../../hivedoctor/src/cli/index.ts)
- [`hivedoctor/tests/service/templates.test.ts`](../../../../hivedoctor/tests/service/templates.test.ts)
- [`hivedoctor/tests/service/service-module.test.ts`](../../../../hivedoctor/tests/service/service-module.test.ts)
- [`hivedoctor/tests/service/cli-delegation.test.ts`](../../../../hivedoctor/tests/service/cli-delegation.test.ts)
- [`scripts/install/install.ps1`](../../../../scripts/install/install.ps1)
- [`scripts/install/install.sh`](../../../../scripts/install/install.sh)
- [`hivedoctor/package.json`](../../../../hivedoctor/package.json)
- [`hivedoctor/package-lock.json`](../../../../hivedoctor/package-lock.json)

---

## Out of Scope

- Changing Honeycomb daemon boot/readiness behavior. `0.1.12` daemon booted and returned healthy
  on this machine.
- Reworking macOS launchd or Linux systemd service semantics beyond regression tests.
- Redesigning HiveDoctor remediation ladder behavior.
- Solving Cursor login or hook wiring warnings from `honeycomb status`; those are unrelated to the
  Windows watchdog service registration failure.
- Releasing a new root Honeycomb package unless the fix requires root package changes.

---

## Related

- GitHub issue: [#192](https://github.com/legioncodeinc/honeycomb/issues/192)
- [PRD-064b: HiveDoctor Self-Supervision and Install Integration](../../../requirements/in-work/prd-064-hivedoctor-self-healing-watchdog/prd-064b-hivedoctor-self-healing-watchdog-self-supervision-and-install-integration.md)
- [PRD-064f: HiveDoctor CLI and UX](../../../requirements/in-work/prd-064-hivedoctor-self-healing-watchdog/prd-064f-hivedoctor-self-healing-watchdog-cli-and-ux.md)
- [PRD-067: HiveDoctor Boot Grace Release Blocker](../../../requirements/backlog/prd-067-hivedoctor-boot-grace-release-blocker/prd-067-hivedoctor-boot-grace-release-blocker-index.md)

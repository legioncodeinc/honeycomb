/**
 * The vendored per-OS service-unit TEMPLATES (PRD-064b Scope).
 *
 * The binding technical consideration: PREFER shelling out to `launchctl` / `systemctl
 * --user` / `schtasks` / `sc.exe` over taking a dependency, and vendor ONLY the small
 * unit templates. This module is exactly that: three pure string builders, one per
 * service manager, that render the unit text from a {@link ServicePlan}. No I/O, no
 * shell-out - just deterministic text a test can snapshot-assert.
 *
 * Every template encodes the two non-negotiables of self-supervision:
 *   - restart-on-crash  (launchd `KeepAlive`, systemd `Restart=always`, schtasks
 *                        `RestartCount`/`RestartInterval`, sc auto-restart actions);
 *   - start-on-boot     (launchd `RunAtLoad`, systemd `WantedBy=default.target`,
 *                        schtasks logon/boot trigger, sc `start= auto`).
 *
 * These mirror the systemd `Restart=always` + `RestartSec` model the parent index calls
 * out as the canonical "restart with backoff, give up after a burst, surface failure"
 * shape (study-only; semantics adopted, no code vendored).
 *
 * Built-ins only; XML/plist are hand-built with the few entities they need escaped.
 */

import { SERVICE_LABEL, WINDOWS_TASK_NAME, type ServicePlan } from "./platform.js";

/** The command HiveDoctor's unit runs to start the supervised watchdog (no shell). */
export const HIVEDOCTOR_RUN_COMMAND = "run" as const;

/**
 * Seconds the OS waits before restarting a crashed HiveDoctor on POSIX. Used by the launchd
 * `ThrottleInterval` and the systemd `RestartSec` directives; both take seconds. AC-10: this value
 * MUST stay 5 for macOS/Linux and is NOT reused by the Windows template (see WINDOWS_RESTART_INTERVAL).
 */
export const RESTART_SEC = 5 as const;

/**
 * The Windows Task Scheduler `RestartOnFailure`/`Interval` duration as an ISO-8601 time interval.
 * Task Scheduler REJECTS sub-minute intervals (a `PT5S` makes `schtasks /Create /XML` fail with
 * "(29,24):Interval:PT5S ... incorrectly formatted or out of range"); the minimum it accepts is
 * `PT1M` (1 minute). IRD-192. This is Windows-only; POSIX keeps RESTART_SEC (seconds).
 */
export const WINDOWS_RESTART_INTERVAL = "PT1M" as const;

/**
 * Quote a single token for a systemd `ExecStart` line. systemd does NOT invoke a shell, but a
 * bare token splits on whitespace, so a space-bearing exec path would mis-split. Wrapping the
 * token in double quotes preserves the spaces; per systemd unit syntax the only characters that
 * must be escaped inside a double-quoted token are the backslash and the double quote itself.
 */
export function quoteSystemdToken(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Escape the five XML predefined entities so an exec path with `&`/quotes cannot break the doc. */
export function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

/**
 * Render a launchd plist (macOS). `RunAtLoad` = start-on-boot/login; `KeepAlive` =
 * restart-on-crash. `ProgramArguments` is an argv array (no shell), so a path with
 * spaces is safe. Logs go under the user's home so a LaunchAgent never needs root.
 */
export function renderLaunchdPlist(plan: ServicePlan): string {
	const node = escapeXml(process.execPath);
	const exec = escapeXml(plan.execPath);
	const home = escapeXml(plan.home);
	const label = escapeXml(plan.label);
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${label}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${node}</string>
		<string>${exec}</string>
		<string>${HIVEDOCTOR_RUN_COMMAND}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>${RESTART_SEC}</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>${home}/.honeycomb/hivedoctor/launchd.out.log</string>
	<key>StandardErrorPath</key>
	<string>${home}/.honeycomb/hivedoctor/launchd.err.log</string>
</dict>
</plist>
`;
}

/**
 * Render a systemd unit (Linux). `Restart=always` + `RestartSec` = restart-on-crash;
 * `WantedBy=default.target` (with `systemctl --user enable`) = start-on-login/boot.
 * `Type=simple` because HiveDoctor stays in the foreground of its own process.
 */
export function renderSystemdUnit(plan: ServicePlan): string {
	// Quote the exec path so a space-bearing install prefix cannot mis-split into two argv tokens
	// (systemd runs ExecStart without a shell, but splits unquoted tokens on whitespace). The run
	// subcommand is a fixed literal with no spaces, so it needs no quoting.
	const exec = `${quoteSystemdToken(plan.execPath)} ${HIVEDOCTOR_RUN_COMMAND}`;
	return `[Unit]
Description=HiveDoctor - Honeycomb self-healing watchdog
Documentation=https://get.theapiary.sh
After=network.target

[Service]
Type=simple
ExecStart=${exec}
Restart=always
RestartSec=${RESTART_SEC}
StartLimitIntervalSec=0

[Install]
WantedBy=default.target
`;
}

/**
 * Render a Windows Scheduled Task definition XML (per-user, the Windows DEFAULT). The
 * `LogonTrigger` starts it at user logon (start-on-boot equivalent without admin); the
 * `RestartOnFailure` settings give restart-on-crash; `MultipleInstancesPolicy=IgnoreNew`
 * keeps a single instance. `<Command>`/`<Arguments>` are separate (no shell parsing).
 *
 * The author element is left to schtasks (`/RU`); this XML is consumed via
 * `schtasks /Create /XML <file>` so the per-user task needs no admin/UAC.
 *
 * The `RestartOnFailure`/`Interval` uses {@link WINDOWS_RESTART_INTERVAL} (`PT1M`), NOT
 * {@link RESTART_SEC} (seconds): Task Scheduler rejects sub-minute intervals (IRD-192 root cause),
 * so the seconds value the POSIX managers take is deliberately not reused here.
 */
export function renderScheduledTaskXml(plan: ServicePlan): string {
	const node = escapeXml(process.execPath);
	const exec = escapeXml(plan.execPath);
	return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>HiveDoctor - Honeycomb self-healing watchdog</Description>
    <URI>\\${escapeXml(WINDOWS_TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RestartOnFailure>
      <Interval>${WINDOWS_RESTART_INTERVAL}</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${node}</Command>
      <Arguments>"${exec}" ${HIVEDOCTOR_RUN_COMMAND}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** The single entry point: render whichever unit text the plan's manager needs. */
export function renderUnit(plan: ServicePlan): string {
	switch (plan.manager) {
		case "launchd":
			return renderLaunchdPlist(plan);
		case "systemd":
			return renderSystemdUnit(plan);
		case "schtasks":
		case "sc":
			// Both Windows backends consume the same Scheduled-Task XML when file-based; sc.exe
			// (system service) is created via argv (see argv.ts) and does not use this template,
			// but a single renderer keeps the XML available for the schtasks path.
			return renderScheduledTaskXml(plan);
	}
}

/** Re-export the label so callers building argv share one source of truth. */
export { SERVICE_LABEL };

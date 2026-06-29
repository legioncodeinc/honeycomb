/**
 * Exact argv construction for every service-manager command (PRD-064b Scope).
 *
 * The service module shells out to the OS service manager (technical consideration:
 * shell out, do NOT take a dependency). Each operation - install, uninstall, status -
 * maps to one OR MORE ordered argv arrays. This module is the single source of truth for
 * those argv arrays; it is pure (a {@link ServicePlan} in, argv arrays out) so a test
 * asserts the EXACT command line per platform without ever executing it.
 *
 * Every command goes through the injected {@link CommandRunner} (execFile, no shell), so a
 * unit path or label can never be re-parsed as a shell metacharacter. The arrays here are
 * the argv that runner receives.
 *
 * launchd: `launchctl bootstrap gui/<uid> <plist>` (modern) to load, `bootout` to unload.
 *          The legacy `load -w` / `unload -w` are intentionally avoided.
 * systemd: `systemctl --user enable --now hivedoctor.service` to install+start,
 *          `disable --now` to remove, `is-active` for status. `--user` for user scope,
 *          no flag for system scope.
 * schtasks: `/Create /XML <file> /TN HiveDoctor /F` (per-user, no admin),
 *           `/Delete /TN HiveDoctor /F`, `/Query /TN HiveDoctor` for status.
 * sc.exe:  `create` + `start` (system service, enterprise opt-in), `stop`+`delete`,
 *          `query` for status.
 *
 * Built-ins only; pure functions.
 */

import { SYSTEMD_UNIT_NAME, WINDOWS_TASK_NAME, type ServicePlan } from "./platform.js";

/** A single command: the executable + its argv (no shell). */
export interface ServiceCommand {
	/** The binary to exec (e.g. `launchctl`, `systemctl`, `schtasks`, `sc`). */
	readonly command: string;
	/** The argv array (no shell parsing). */
	readonly args: readonly string[];
}

/** The user's numeric uid for the launchd `gui/<uid>` domain target. Injected (default: live uid). */
export type ReadUidFn = () => number;

/** Build the launchd `gui/<uid>` domain-target string used by bootstrap/bootout. */
export function launchdDomainTarget(plan: ServicePlan, uid: number): string {
	// System scope uses the `system` domain; user scope uses the per-user GUI domain.
	return plan.scope === "system" ? "system" : `gui/${uid}`;
}

/** The launchd service target (`<domain>/<label>`) used by `bootout` + `kickstart`. */
export function launchdServiceTarget(plan: ServicePlan, uid: number): string {
	return `${launchdDomainTarget(plan, uid)}/${plan.label}`;
}

/**
 * The argv to INSTALL (register + start) the service for this plan. Returns the ordered
 * list of commands to run; the caller writes the unit file first (when the plan has a
 * unitPath), then runs these.
 */
export function installCommands(plan: ServicePlan, uid: number): readonly ServiceCommand[] {
	switch (plan.manager) {
		case "launchd": {
			const domain = launchdDomainTarget(plan, uid);
			return [
				// Modern load: bootstrap the unit into the (user GUI | system) domain.
				{ command: "launchctl", args: ["bootstrap", domain, plan.unitPath] },
				// Ensure it is started now (idempotent kick; harmless if already running).
				{ command: "launchctl", args: ["kickstart", "-k", launchdServiceTarget(plan, uid)] },
			];
		}
		case "systemd": {
			const scopeArgs = plan.scope === "user" ? ["--user"] : [];
			return [
				// enable --now both starts it and wires start-on-boot in one shot.
				{ command: "systemctl", args: [...scopeArgs, "enable", "--now", SYSTEMD_UNIT_NAME] },
			];
		}
		case "schtasks": {
			// Per-user Scheduled Task from the rendered XML; /F overwrites idempotently.
			return [
				{ command: "schtasks", args: ["/Create", "/XML", plan.unitPath, "/TN", WINDOWS_TASK_NAME, "/F"] },
				// Start it immediately so a clean install is running without waiting for the next logon.
				{ command: "schtasks", args: ["/Run", "/TN", WINDOWS_TASK_NAME] },
			];
		}
		case "sc": {
			// Windows Service (enterprise opt-in). binPath wraps node + the bin + the run verb.
			const binPath = `"${process.execPath}" "${plan.execPath}" run`;
			return [
				{
					command: "sc",
					args: ["create", WINDOWS_TASK_NAME, `binPath=${binPath}`, "start=", "auto"],
				},
				{ command: "sc", args: ["start", WINDOWS_TASK_NAME] },
			];
		}
	}
}

/** The argv to UNINSTALL (stop + remove) the service for this plan, in order. */
export function uninstallCommands(plan: ServicePlan, uid: number): readonly ServiceCommand[] {
	switch (plan.manager) {
		case "launchd":
			return [
				// bootout unloads the unit from its domain; the caller then deletes the plist file.
				{ command: "launchctl", args: ["bootout", launchdServiceTarget(plan, uid)] },
			];
		case "systemd": {
			const scopeArgs = plan.scope === "user" ? ["--user"] : [];
			return [
				// disable --now stops it and removes the start-on-boot wiring; the caller deletes the unit.
				{ command: "systemctl", args: [...scopeArgs, "disable", "--now", SYSTEMD_UNIT_NAME] },
			];
		}
		case "schtasks":
			return [{ command: "schtasks", args: ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"] }];
		case "sc":
			return [
				{ command: "sc", args: ["stop", WINDOWS_TASK_NAME] },
				{ command: "sc", args: ["delete", WINDOWS_TASK_NAME] },
			];
	}
}

/** The single argv to QUERY status. The caller interprets the command's exit/stdout. */
export function statusCommand(plan: ServicePlan, uid: number): ServiceCommand {
	switch (plan.manager) {
		case "launchd":
			return { command: "launchctl", args: ["print", launchdServiceTarget(plan, uid)] };
		case "systemd": {
			const scopeArgs = plan.scope === "user" ? ["--user"] : [];
			return { command: "systemctl", args: [...scopeArgs, "is-active", SYSTEMD_UNIT_NAME] };
		}
		case "schtasks":
			return { command: "schtasks", args: ["/Query", "/TN", WINDOWS_TASK_NAME] };
		case "sc":
			return { command: "sc", args: ["query", WINDOWS_TASK_NAME] };
	}
}

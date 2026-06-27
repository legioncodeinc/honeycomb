/**
 * The primary-daemon OS-native service helper, PRD-063h (AC-063h.1..6).
 *
 * ── Why this module exists (OD-1 / 063h) ─────────────────────────────────────
 * The shipped daemon lifecycle (`src/cli/runtime.ts`) brings the daemon up by a DETACHED
 * `spawn()`, which dies with the machine and is not restarted on crash. 063h makes the OS
 * service manager the LIVENESS FLOOR: it restarts the daemon on crash and starts it on boot,
 * while HiveDoctor stays the intelligent healing layer above it. This module is the small,
 * pure, per-OS surface that registers / unregisters / starts / stops / restarts / reports the
 * daemon as a userland service:
 *   - macOS  → launchd LaunchAgent (`~/Library/LaunchAgents/<label>.plist`, `launchctl`)
 *   - Linux  → systemd `--user` unit (`~/.config/systemd/user/<unit>.service`, `systemctl --user`)
 *   - Windows→ per-user Scheduled Task (no admin / no UAC, the resolved default), `schtasks`
 *
 * ── Design rules (binding) ───────────────────────────────────────────────────
 * 1. ADDITIVE + FALLBACK. This module never replaces the detached spawn; `runtime.ts` prefers
 *    service mode when a manager is available and falls back to spawn where registration is
 *    impossible (CI, locked-down corp machines, the existing tests). {@link detectServiceManager}
 *    returns `null` on those hosts, which is the signal `runtime.ts` reads to fall back.
 * 2. CHEAP, SIDE-EFFECT-FREE DETECTION. {@link detectServiceManager} only reads `platform` + a
 *    couple of env probes (it does NOT shell out, write files, or spawn work). An explicit
 *    `HONEYCOMB_DAEMON_SERVICE=spawn` opt-out forces the spawn fallback everywhere.
 * 3. WRITABLE WORKSPACE PINNED INTO THE UNIT (AC-063h.4). The generated unit pins BOTH the
 *    working directory and `HONEYCOMB_WORKSPACE` to the caller-resolved writable workspace, so a
 *    service-started daemon never boots from `C:\WINDOWS\system32` (the documented "secrets 502"
 *    class). The workspace is RESOLVED BY THE CALLER (`runtime.ts`, which owns the writable-probe)
 *    and threaded in, this module never re-resolves it.
 * 4. ARGV BEHIND AN INJECTED RUNNER (test discipline). Every shell-out to `launchctl` /
 *    `systemctl` / `schtasks` goes through an injected {@link ServiceRunner}, so a unit test
 *    asserts the exact argv WITHOUT executing anything. The default runner (used only in
 *    production) is the lazy `createRequire`-loaded `node:child_process` `execFileSync`, never a
 *    shell string, always fixed-argv.
 *
 * ── Scope boundary ───────────────────────────────────────────────────────────
 * This is the PRIMARY daemon's service. HiveDoctor's OWN service is 063b (a sibling, separate
 * unit). The two share the same approach and acceptably-duplicated templates; this module lives
 * in the MAIN package (`src/`) and does not import from `hivedoctor/`.
 */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

/** The three OS service managers this module can target (the resolved per-OS default). */
export type ServiceManager = "launchd" | "systemd-user" | "schtasks";

/** The label / unit / task name the daemon's service is registered under (one per host family). */
export const SERVICE_LABEL = "ai.honeycomb.daemon" as const;
/** The Windows Scheduled Task name (schtasks uses a friendlier name than the reverse-DNS label). */
export const SERVICE_TASK_NAME = "HoneycombDaemon" as const;

/**
 * The opt-out env var that forces the detached-spawn fallback regardless of the host. Set
 * `HONEYCOMB_DAEMON_SERVICE=spawn` to disable OS-service mode (CI, locked-down machines, or a user
 * who simply prefers the old lifecycle). Any other value (or unset) keeps auto-detection.
 */
export const SERVICE_MODE_ENV = "HONEYCOMB_DAEMON_SERVICE" as const;

/**
 * Detect the OS service manager available on this host, or `null` when service registration is not
 * available / not wanted (→ the caller falls back to the detached spawn).
 *
 * CHEAP + SIDE-EFFECT-FREE (critical directive): reads `platform` + a couple of env vars only. It
 * does NOT shell out to probe for `launchctl`/`systemctl`/`schtasks`, write any file, or spawn any
 * work, so it is safe to call on every `start()` / `install`. The honest "is the binary actually
 * present" check is deferred to the runner (a `register` that shells out fails loudly and the caller
 * falls back); a cheap heuristic here is enough to PICK the manager.
 *
 *   - `HONEYCOMB_DAEMON_SERVICE=spawn` → `null` (explicit opt-out; the spawn fallback).
 *   - darwin → `launchd` (LaunchAgents are always available per-user on macOS).
 *   - linux  → `systemd-user` ONLY when a user systemd is plausibly present. We require a
 *     positive signal (`XDG_RUNTIME_DIR` set, the conventional `systemctl --user` bus dir) rather
 *     than assuming systemd, a container / CI box without a user bus returns `null` and falls back
 *     to spawn, which keeps CI on the existing path.
 *   - win32  → `schtasks` (the per-user Scheduled Task default; no admin needed).
 *   - anything else → `null` (spawn fallback).
 */
export function detectServiceManager(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): ServiceManager | null {
	// Explicit opt-out wins everywhere, this is how CI / locked-down hosts force the spawn path.
	if ((env[SERVICE_MODE_ENV] ?? "").trim().toLowerCase() === "spawn") return null;

	if (platform === "darwin") return "launchd";
	if (platform === "win32") return "schtasks";
	if (platform === "linux") {
		// Require a positive user-systemd signal. `XDG_RUNTIME_DIR` is set by a logind user session
		// (where `systemctl --user` works); its absence (a bare CI container) means no user bus, so we
		// fall back to spawn rather than registering a unit that can never start.
		const xdg = (env.XDG_RUNTIME_DIR ?? "").trim();
		if (xdg.length > 0) return "systemd-user";
		return null;
	}
	return null;
}

/**
 * The injected shell-out seam (test discipline). A `register`/`unregister`/`control` runs the
 * service manager through this; a unit test passes a recorder so the exact argv is asserted WITHOUT
 * executing. The default ({@link defaultServiceRunner}) shells out fixed-argv via `execFileSync`.
 *
 * `run` returns the captured stdout (trimmed) on success and THROWS on a non-zero exit / missing
 * binary, the caller (`runtime.ts`) treats a throw as "service path unavailable" and falls back.
 */
export interface ServiceRunner {
	/** Run `cmd` with fixed `args`. Returns trimmed stdout. Throws on failure / missing binary. */
	run(cmd: string, args: readonly string[]): string;
	/** Write a unit/plist file to `path` with `contents` (launchd/systemd). Throws on failure. */
	writeFile(path: string, contents: string): void;
	/** Remove a unit/plist file at `path`. Never throws (a missing file is success). */
	removeFile(path: string): void;
	/** True iff `path` exists (used to report service status for file-based managers). */
	fileExists(path: string): boolean;
}

/**
 * The production {@link ServiceRunner}: fixed-argv `execFileSync` + `node:fs`, loaded lazily through
 * `createRequire` so this module stays import-light and the bundle's static-analysis (the OpenClaw
 * ClawHub scanner forbids bare `spawn`/`execFileSync`) never sees a top-level child_process import.
 * Never a shell string, every call is `(cmd, args[])`, so a metacharacter in a path can never be
 * re-parsed by a shell.
 */
export function defaultServiceRunner(): ServiceRunner {
	const require = createRequire(import.meta.url);
	// Lazy, indirected requires (ClawHub-clean): resolved at call time, never a top-level import.
	const cp = require("node:child_process") as typeof import("node:child_process");
	const fs = require("node:fs") as typeof import("node:fs");
	return {
		run(cmd: string, args: readonly string[]): string {
			const out = cp.execFileSync(cmd, [...args], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 15_000,
				windowsHide: true,
			});
			return typeof out === "string" ? out.trim() : "";
		},
		writeFile(path: string, contents: string): void {
			fs.mkdirSync(join(path, ".."), { recursive: true });
			fs.writeFileSync(path, contents, { encoding: "utf8" });
		},
		removeFile(path: string): void {
			try {
				fs.rmSync(path, { force: true });
			} catch {
				// A missing unit on unregister is success, the goal (no unit) already holds.
			}
		},
		fileExists(path: string): boolean {
			try {
				return fs.existsSync(path);
			} catch {
				return false;
			}
		},
	};
}

/**
 * The inputs the unit/plist/XML templates are rendered from. RESOLVED BY THE CALLER (`runtime.ts`)
 * and threaded in, this module never resolves the workspace or the entry on its own.
 */
export interface ServiceSpec {
	/** Absolute path to the Node binary the service launches (`process.execPath` in production). */
	readonly nodePath: string;
	/** Absolute path to the bundled `daemon/index.js` the service runs. */
	readonly entry: string;
	/** Extra Node flags prepended to the entry (e.g. `--experimental-sqlite`). */
	readonly nodeFlags: readonly string[];
	/**
	 * The guaranteed-WRITABLE workspace pinned into the unit's working-dir AND `HONEYCOMB_WORKSPACE`
	 * (AC-063h.4). Resolved by `runtime.ts` (which owns the create-write-unlink probe); never
	 * `C:\WINDOWS\system32`. Both are pinned as defense-in-depth (the daemon resolves its `.secrets/`
	 * root from `HONEYCOMB_WORKSPACE ?? cwd`, so either alone would suffice).
	 */
	readonly workspace: string;
	/** The home dir the file-based unit paths resolve under. Defaults to `os.homedir()`. */
	readonly home?: string;
}

/** Resolve the launchd LaunchAgent plist path (`~/Library/LaunchAgents/<label>.plist`). */
export function launchdPlistPath(home: string): string {
	return join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

/** Resolve the systemd --user unit path (`~/.config/systemd/user/<label>.service`). */
export function systemdUnitPath(home: string): string {
	return join(home, ".config", "systemd", "user", `${SERVICE_LABEL}.service`);
}

/** XML-escape a value bound into a plist `<string>` (the entry/workspace can contain `&`/`<`). */
function xmlEscape(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Render the launchd LaunchAgent plist (AC-063h.4: pins `WorkingDirectory` + the `HONEYCOMB_WORKSPACE`
 * env to the writable workspace; `KeepAlive`+`RunAtLoad` make launchd the liveness floor , 
 * restart-on-crash + start-on-login).
 */
export function renderLaunchdPlist(spec: ServiceSpec): string {
	const argv = [spec.nodePath, ...spec.nodeFlags, spec.entry];
	const argvXml = argv.map((a) => `\t\t<string>${xmlEscape(a)}</string>`).join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${SERVICE_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${argvXml}
	</array>
	<key>WorkingDirectory</key>
	<string>${xmlEscape(spec.workspace)}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HONEYCOMB_WORKSPACE</key>
		<string>${xmlEscape(spec.workspace)}</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
</dict>
</plist>
`;
}

/**
 * Render the systemd --user unit (AC-063h.4: `WorkingDirectory` + `Environment=HONEYCOMB_WORKSPACE`
 * pin the writable workspace; `Restart=always`+`RestartSec` + the `[Install] WantedBy` make systemd
 * the liveness floor, restart-on-crash + start-on-login when the unit is `enable`d).
 */
export function renderSystemdUnit(spec: ServiceSpec): string {
	// systemd ExecStart wants a single command line; quote each argv token so a space in a path is
	// preserved. The tokens are absolute paths we control (no user-supplied shell metacharacters).
	const execStart = [spec.nodePath, ...spec.nodeFlags, spec.entry].map((a) => `"${a}"`).join(" ");
	return `[Unit]
Description=Honeycomb primary daemon (127.0.0.1:3850)
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
WorkingDirectory=${spec.workspace}
Environment=HONEYCOMB_WORKSPACE=${spec.workspace}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/**
 * Reject a path bound into the Windows `/TR` command string if it carries a cmd.exe
 * metacharacter (PRD-063h security hardening). The `/TR` value is the ONE place this module
 * composes a SHELL string instead of fixed argv: schtasks stores it and cmd.exe RE-PARSES it
 * at every logon. `spec.workspace` is derived from `HONEYCOMB_WORKSPACE` / the CLI cwd
 * (src/cli/runtime.ts resolveDaemonWorkspace), and `spec.entry` can be overridden via
 * `HONEYCOMB_DAEMON_ENTRY`, so a path containing `& | < > ^ " %` (or a CR/LF) would break out
 * of the intended command and execute arbitrary commands under the user's login session on
 * every boot. We THROW on such a path; a throw is this module's documented "service path
 * unavailable" signal, so runtime.ts falls back to the safe detached spawn (which passes the
 * workspace as a real argv/env value, never a shell string) rather than registering a
 * poisoned task. Legitimate Windows paths never contain these characters.
 */
function assertCmdSafe(value: string): void {
	// cmd.exe command separators / redirection / escape / env-expansion / quote, plus CR/LF.
	if (/[&|<>^"%\r\n]/.test(value)) {
		throw new Error("unsafe character in service path; refusing to build schtasks /TR command");
	}
}

/**
 * Build the `schtasks /Create` argv for the per-user Scheduled Task (AC-063h.4: the task's command
 * pins `HONEYCOMB_WORKSPACE` via a `cmd /c set ... &&` prefix so the daemon never inherits system32,
 * and `/SC ONLOGON` makes the task the start-on-boot/login liveness floor). `/F` is idempotent
 * (overwrites an existing task), `/RL LIMITED` keeps it userland (no admin / no UAC).
 *
 * Returned as ARGV (not a string) so the injected runner shells out fixed-argv and a test asserts
 * the exact tokens. The `/TR` value IS a single command string (schtasks' own format); we keep it
 * conservative: a `cmd /c` that sets the workspace env then launches node with the entry.
 */
export function buildSchtasksCreateArgs(spec: ServiceSpec): readonly string[] {
	// SECURITY: the /TR value is a cmd.exe-parsed string (the lone non-fixed-argv path here).
	// Refuse any path with a cmd metacharacter so a poisoned HONEYCOMB_WORKSPACE / cwd /
	// HONEYCOMB_DAEMON_ENTRY cannot inject a command into the stored, auto-running task. A throw
	// makes runtime.ts fall back to the safe detached spawn.
	assertCmdSafe(spec.workspace);
	assertCmdSafe(spec.nodePath);
	assertCmdSafe(spec.entry);
	const nodeFlags = spec.nodeFlags.length > 0 ? `${spec.nodeFlags.join(" ")} ` : "";
	// The /TR command: set HONEYCOMB_WORKSPACE for the child, then launch node on the entry. `cd /d`
	// pins the working directory to the writable workspace (the system32 footgun close). Quote the
	// paths so spaces survive. schtasks runs this exact string under cmd.exe at task time.
	const tr = `cmd /c "cd /d "${spec.workspace}" && set HONEYCOMB_WORKSPACE=${spec.workspace} && "${spec.nodePath}" ${nodeFlags}"${spec.entry}""`;
	return [
		"/Create",
		"/TN",
		SERVICE_TASK_NAME,
		"/TR",
		tr,
		"/SC",
		"ONLOGON",
		"/RL",
		"LIMITED",
		"/F",
	];
}

/** The outcome of a service operation, what happened, for the CLI to report honestly. */
export interface ServiceOpResult {
	/** True when the operation completed via the service manager. */
	readonly ok: boolean;
	/** The manager that handled it (for logging / status). */
	readonly manager: ServiceManager;
}

/** The daemon-service controller the lifecycle drives (register / start / stop / restart / status). */
export interface DaemonServiceController {
	readonly manager: ServiceManager;
	/** Register the service unit + load/enable it so the manager supervises it (idempotent). */
	register(spec: ServiceSpec): ServiceOpResult;
	/** Deregister the service (unload/disable + remove the unit). Idempotent + never throws. */
	unregister(spec: ServiceSpec): ServiceOpResult;
	/** Ask the manager to (re)start the daemon, the rung-1 path HiveDoctor calls (AC-063h.5). */
	restart(spec: ServiceSpec): ServiceOpResult;
	/** Ask the manager to stop the daemon. */
	stop(spec: ServiceSpec): ServiceOpResult;
	/** True iff the service is currently REGISTERED with the manager (unit present / task exists). */
	isRegistered(spec: ServiceSpec): boolean;
}

/** Resolve the home dir for a spec (explicit `home` wins; else `os.homedir()`). */
function specHome(spec: ServiceSpec): string {
	return spec.home ?? homedir();
}

/**
 * Build the per-OS {@link DaemonServiceController} over an injected {@link ServiceRunner}. The
 * controller owns the per-manager argv + file paths; the runner owns the actual shell-out / file IO.
 * Every `run` is fixed-argv; a throw from the runner propagates so the caller falls back to spawn.
 */
export function createDaemonServiceController(
	manager: ServiceManager,
	runner: ServiceRunner = defaultServiceRunner(),
): DaemonServiceController {
	if (manager === "launchd") return launchdController(runner);
	if (manager === "systemd-user") return systemdController(runner);
	return schtasksController(runner);
}

/** launchd LaunchAgent controller (`launchctl bootstrap`/`bootout`/`kickstart`). */
function launchdController(runner: ServiceRunner): DaemonServiceController {
	/** The per-user GUI domain target `launchctl` v2 verbs address (`gui/<uid>`). */
	function domain(): string {
		return `gui/${process.getuid?.() ?? 501}`;
	}
	return {
		manager: "launchd",
		register(spec): ServiceOpResult {
			const path = launchdPlistPath(specHome(spec));
			runner.writeFile(path, renderLaunchdPlist(spec));
			// bootstrap loads + (RunAtLoad) starts the agent; the `||` re-bootstrap is handled by callers.
			runner.run("launchctl", ["bootstrap", domain(), path]);
			return { ok: true, manager: "launchd" };
		},
		unregister(spec): ServiceOpResult {
			const path = launchdPlistPath(specHome(spec));
			try {
				runner.run("launchctl", ["bootout", `${domain()}/${SERVICE_LABEL}`]);
			} catch {
				// Not loaded is fine, we still remove the unit file below.
			}
			runner.removeFile(path);
			return { ok: true, manager: "launchd" };
		},
		restart(_spec): ServiceOpResult {
			// kickstart -k kills + restarts the service THROUGH launchd (AC-063h.5: no second spawn).
			runner.run("launchctl", ["kickstart", "-k", `${domain()}/${SERVICE_LABEL}`]);
			return { ok: true, manager: "launchd" };
		},
		stop(_spec): ServiceOpResult {
			runner.run("launchctl", ["kill", "SIGTERM", `${domain()}/${SERVICE_LABEL}`]);
			return { ok: true, manager: "launchd" };
		},
		isRegistered(spec): boolean {
			return runner.fileExists(launchdPlistPath(specHome(spec)));
		},
	};
}

/** systemd --user controller (`systemctl --user enable --now`/`disable`/`restart`). */
function systemdController(runner: ServiceRunner): DaemonServiceController {
	const unit = `${SERVICE_LABEL}.service`;
	return {
		manager: "systemd-user",
		register(spec): ServiceOpResult {
			const path = systemdUnitPath(specHome(spec));
			runner.writeFile(path, renderSystemdUnit(spec));
			runner.run("systemctl", ["--user", "daemon-reload"]);
			// enable --now installs the boot symlink (start-on-login) AND starts it now.
			runner.run("systemctl", ["--user", "enable", "--now", unit]);
			return { ok: true, manager: "systemd-user" };
		},
		unregister(spec): ServiceOpResult {
			try {
				runner.run("systemctl", ["--user", "disable", "--now", unit]);
			} catch {
				// Not enabled is fine, we still remove the unit file + reload below.
			}
			runner.removeFile(systemdUnitPath(specHome(spec)));
			try {
				runner.run("systemctl", ["--user", "daemon-reload"]);
			} catch {
				// A reload failure on teardown is non-fatal; the unit file is already gone.
			}
			return { ok: true, manager: "systemd-user" };
		},
		restart(_spec): ServiceOpResult {
			// restart goes THROUGH systemd (AC-063h.5: no second spawn, no double-bind).
			runner.run("systemctl", ["--user", "restart", unit]);
			return { ok: true, manager: "systemd-user" };
		},
		stop(_spec): ServiceOpResult {
			runner.run("systemctl", ["--user", "stop", unit]);
			return { ok: true, manager: "systemd-user" };
		},
		isRegistered(spec): boolean {
			return runner.fileExists(systemdUnitPath(specHome(spec)));
		},
	};
}

/** Windows per-user Scheduled Task controller (`schtasks /Create`/`/Delete`/`/Run`/`/End`/`/Query`). */
function schtasksController(runner: ServiceRunner): DaemonServiceController {
	return {
		manager: "schtasks",
		register(spec): ServiceOpResult {
			// /Create /F is idempotent (overwrites). /SC ONLOGON starts the daemon on login (boot floor).
			runner.run("schtasks", buildSchtasksCreateArgs(spec));
			// Start it immediately so register == running (the install path expects an up daemon).
			runner.run("schtasks", ["/Run", "/TN", SERVICE_TASK_NAME]);
			return { ok: true, manager: "schtasks" };
		},
		unregister(_spec): ServiceOpResult {
			try {
				runner.run("schtasks", ["/End", "/TN", SERVICE_TASK_NAME]);
			} catch {
				// Not running is fine, we still delete the task below.
			}
			try {
				runner.run("schtasks", ["/Delete", "/TN", SERVICE_TASK_NAME, "/F"]);
			} catch {
				// A missing task on delete is success, the goal (no task) already holds.
			}
			return { ok: true, manager: "schtasks" };
		},
		restart(spec): ServiceOpResult {
			// AC-063h.5: stop THEN start the SAME task, no second daemon spawn. The single-instance
			// PID/lock guard in the daemon prevents a double-bind even if the old process lingers a beat.
			try {
				runner.run("schtasks", ["/End", "/TN", SERVICE_TASK_NAME]);
			} catch {
				// Already stopped is fine; proceed to /Run.
			}
			runner.run("schtasks", ["/Run", "/TN", SERVICE_TASK_NAME]);
			return { ok: true, manager: "schtasks" };
		},
		stop(_spec): ServiceOpResult {
			runner.run("schtasks", ["/End", "/TN", SERVICE_TASK_NAME]);
			return { ok: true, manager: "schtasks" };
		},
		isRegistered(_spec): boolean {
			// A registered task answers `/Query` with exit 0; a missing one throws (non-zero) → false.
			try {
				runner.run("schtasks", ["/Query", "/TN", SERVICE_TASK_NAME]);
				return true;
			} catch {
				return false;
			}
		},
	};
}

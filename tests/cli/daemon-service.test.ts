/**
 * PRD-063h, the primary-daemon OS-native service helper (`src/cli/daemon-service.ts`).
 *
 * Proves with a recording {@link ServiceRunner} (NO real launchctl/systemctl/schtasks, NO real file
 * IO) and pure template assertions:
 *   - detectServiceManager picks the right per-OS manager, is side-effect-free, and honors the
 *     `HONEYCOMB_DAEMON_SERVICE=spawn` opt-out + the no-user-bus-on-linux fallback (HC-1 fallback).
 *   - AC-063h.4: every generated unit (launchd plist / systemd unit / schtasks /TR) PINS the
 *     writable workspace into BOTH the working dir AND HONEYCOMB_WORKSPACE.
 *   - AC-063h.5: restart goes THROUGH the manager (kickstart / systemctl restart / schtasks stop+run),
 *     never a second spawn, and the schtasks restart is stop-then-run on the SAME task.
 *   - register/unregister/status argv is the exact fixed-argv the manager expects.
 */

import { describe, expect, it } from "vitest";

import {
	type ServiceRunner,
	type ServiceSpec,
	SERVICE_LABEL,
	SERVICE_TASK_NAME,
	buildSchtasksCreateArgs,
	createDaemonServiceController,
	detectServiceManager,
	launchdPlistPath,
	renderLaunchdPlist,
	renderSystemdUnit,
	systemdUnitPath,
} from "../../src/cli/daemon-service.js";

/** A recording runner: captures every run/writeFile/removeFile call WITHOUT executing anything. */
function recordingRunner(opts?: { fileExists?: boolean; queryThrows?: boolean }): ServiceRunner & {
	runs: Array<{ cmd: string; args: readonly string[] }>;
	writes: Array<{ path: string; contents: string }>;
	removes: string[];
} {
	const runs: Array<{ cmd: string; args: readonly string[] }> = [];
	const writes: Array<{ path: string; contents: string }> = [];
	const removes: string[] = [];
	return {
		runs,
		writes,
		removes,
		run(cmd, args) {
			runs.push({ cmd, args });
			// schtasks /Query is the isRegistered probe, throw to simulate "task absent".
			if (opts?.queryThrows && cmd === "schtasks" && args[0] === "/Query") {
				throw new Error("ERROR: The system cannot find the file specified.");
			}
			return "";
		},
		writeFile(path, contents) {
			writes.push({ path, contents });
		},
		removeFile(path) {
			removes.push(path);
		},
		fileExists() {
			return opts?.fileExists ?? true;
		},
	};
}

const SPEC: ServiceSpec = {
	nodePath: "/usr/local/bin/node",
	entry: "/opt/honeycomb/daemon/index.js",
	nodeFlags: ["--experimental-sqlite"],
	workspace: "/home/ada/.honeycomb",
	home: "/home/ada",
};

const WIN_SPEC: ServiceSpec = {
	nodePath: "C:\\Program Files\\nodejs\\node.exe",
	entry: "C:\\Users\\ada\\hc\\daemon\\index.js",
	nodeFlags: ["--experimental-sqlite"],
	workspace: "C:\\Users\\ada\\hc",
	home: "C:\\Users\\ada",
};

describe("PRD-063h detectServiceManager, cheap, side-effect-free, per-OS + fallback", () => {
	it("picks launchd on darwin, schtasks on win32", () => {
		expect(detectServiceManager({}, "darwin")).toBe("launchd");
		expect(detectServiceManager({}, "win32")).toBe("schtasks");
	});

	it("picks systemd-user on linux ONLY when a user bus (XDG_RUNTIME_DIR) is present", () => {
		expect(detectServiceManager({ XDG_RUNTIME_DIR: "/run/user/1000" }, "linux")).toBe("systemd-user");
		// No user bus (a bare CI container) → null → the spawn fallback (HC-1).
		expect(detectServiceManager({}, "linux")).toBeNull();
	});

	it("honors HONEYCOMB_DAEMON_SERVICE=spawn as a hard opt-out on every platform (HC-1 fallback)", () => {
		expect(detectServiceManager({ HONEYCOMB_DAEMON_SERVICE: "spawn" }, "darwin")).toBeNull();
		expect(detectServiceManager({ HONEYCOMB_DAEMON_SERVICE: "spawn" }, "win32")).toBeNull();
		expect(detectServiceManager({ HONEYCOMB_DAEMON_SERVICE: "spawn", XDG_RUNTIME_DIR: "/run/user/1000" }, "linux")).toBeNull();
	});

	it("returns null on an unknown platform (→ spawn fallback)", () => {
		expect(detectServiceManager({}, "aix")).toBeNull();
	});
});

describe("PRD-063h AC-063h.4, launchd plist pins the writable workspace", () => {
	const plist = renderLaunchdPlist(SPEC);
	it("pins WorkingDirectory AND HONEYCOMB_WORKSPACE to the workspace (never system32)", () => {
		expect(plist).toContain("<key>WorkingDirectory</key>");
		expect(plist).toContain("<string>/home/ada/.honeycomb</string>");
		expect(plist).toContain("<key>HONEYCOMB_WORKSPACE</key>");
	});
	it("renders the full argv (node + flags + entry) and the restart-floor keys", () => {
		expect(plist).toContain("<string>/usr/local/bin/node</string>");
		expect(plist).toContain("<string>--experimental-sqlite</string>");
		expect(plist).toContain("<string>/opt/honeycomb/daemon/index.js</string>");
		// KeepAlive + RunAtLoad = the liveness floor (restart-on-crash + start-on-login).
		expect(plist).toContain("<key>KeepAlive</key>");
		expect(plist).toContain("<key>RunAtLoad</key>");
		expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
	});
});

describe("PRD-063h AC-063h.4, systemd --user unit pins the writable workspace", () => {
	const unit = renderSystemdUnit(SPEC);
	it("pins WorkingDirectory AND Environment=HONEYCOMB_WORKSPACE", () => {
		expect(unit).toContain("WorkingDirectory=/home/ada/.honeycomb");
		expect(unit).toContain("Environment=HONEYCOMB_WORKSPACE=/home/ada/.honeycomb");
	});
	it("renders ExecStart with the full quoted argv + the restart-floor directives", () => {
		expect(unit).toContain(`ExecStart="/usr/local/bin/node" "--experimental-sqlite" "/opt/honeycomb/daemon/index.js"`);
		expect(unit).toContain("Restart=always");
		expect(unit).toContain("WantedBy=default.target");
	});
});

describe("PRD-063h AC-063h.4, schtasks /Create pins the writable workspace", () => {
	const args = buildSchtasksCreateArgs(WIN_SPEC);
	it("is fixed-argv: /Create /TN <task> /TR <cmd> /SC ONLOGON /RL LIMITED /F", () => {
		expect(args[0]).toBe("/Create");
		expect(args).toContain("/TN");
		expect(args[args.indexOf("/TN") + 1]).toBe(SERVICE_TASK_NAME);
		expect(args).toContain("/SC");
		expect(args[args.indexOf("/SC") + 1]).toBe("ONLOGON");
		expect(args).toContain("/RL");
		expect(args[args.indexOf("/RL") + 1]).toBe("LIMITED");
		expect(args).toContain("/F");
	});
	it("the /TR command pins cd /d <workspace> AND set HONEYCOMB_WORKSPACE (system32 close)", () => {
		const tr = args[args.indexOf("/TR") + 1];
		expect(tr).toContain("cd /d \"C:\\Users\\ada\\hc\"");
		expect(tr).toContain("set HONEYCOMB_WORKSPACE=C:\\Users\\ada\\hc");
		expect(tr).toContain("daemon\\index.js");
	});
});

describe("PRD-063h launchd controller, register/restart/status argv (injected runner)", () => {
	it("register writes the plist then bootstraps it (no execution)", () => {
		const runner = recordingRunner();
		const ctl = createDaemonServiceController("launchd", runner);
		const res = ctl.register(SPEC);
		expect(res.ok).toBe(true);
		expect(runner.writes[0]?.path).toBe(launchdPlistPath("/home/ada"));
		expect(runner.runs[0]?.cmd).toBe("launchctl");
		expect(runner.runs[0]?.args[0]).toBe("bootstrap");
	});

	it("AC-063h.5 restart goes THROUGH launchctl kickstart -k (no second spawn)", () => {
		const runner = recordingRunner();
		const ctl = createDaemonServiceController("launchd", runner);
		ctl.restart(SPEC);
		expect(runner.runs[0]?.cmd).toBe("launchctl");
		expect(runner.runs[0]?.args.slice(0, 3)).toEqual(["kickstart", "-k", expect.stringContaining(SERVICE_LABEL)]);
	});

	it("isRegistered reflects the plist file presence", () => {
		expect(createDaemonServiceController("launchd", recordingRunner({ fileExists: true })).isRegistered(SPEC)).toBe(true);
		expect(createDaemonServiceController("launchd", recordingRunner({ fileExists: false })).isRegistered(SPEC)).toBe(false);
	});
});

describe("PRD-063h systemd controller, register/restart argv (injected runner)", () => {
	it("register writes the unit, daemon-reloads, then enable --now (start-on-login + start now)", () => {
		const runner = recordingRunner();
		const ctl = createDaemonServiceController("systemd-user", runner);
		ctl.register(SPEC);
		expect(runner.writes[0]?.path).toBe(systemdUnitPath("/home/ada"));
		expect(runner.runs.map((r) => r.args.join(" "))).toEqual([
			"--user daemon-reload",
			`--user enable --now ${SERVICE_LABEL}.service`,
		]);
	});

	it("AC-063h.5 restart goes THROUGH systemctl --user restart (no second spawn)", () => {
		const runner = recordingRunner();
		createDaemonServiceController("systemd-user", runner).restart(SPEC);
		expect(runner.runs[0]?.cmd).toBe("systemctl");
		expect(runner.runs[0]?.args).toEqual(["--user", "restart", `${SERVICE_LABEL}.service`]);
	});
});

describe("PRD-063h schtasks controller, register/restart/status argv (injected runner)", () => {
	it("register creates the task then runs it", () => {
		const runner = recordingRunner();
		const ctl = createDaemonServiceController("schtasks", runner);
		ctl.register(WIN_SPEC);
		expect(runner.runs[0]?.args[0]).toBe("/Create");
		expect(runner.runs[1]?.args).toEqual(["/Run", "/TN", SERVICE_TASK_NAME]);
	});

	it("AC-063h.5 restart is stop-then-run on the SAME task (no second spawn, no double-bind)", () => {
		const runner = recordingRunner();
		createDaemonServiceController("schtasks", runner).restart(WIN_SPEC);
		expect(runner.runs[0]?.args).toEqual(["/End", "/TN", SERVICE_TASK_NAME]);
		expect(runner.runs[1]?.args).toEqual(["/Run", "/TN", SERVICE_TASK_NAME]);
	});

	it("isRegistered is true when /Query succeeds, false when it throws (task absent)", () => {
		expect(createDaemonServiceController("schtasks", recordingRunner({ queryThrows: false })).isRegistered(WIN_SPEC)).toBe(true);
		expect(createDaemonServiceController("schtasks", recordingRunner({ queryThrows: true })).isRegistered(WIN_SPEC)).toBe(false);
	});

	it("unregister ends then deletes the task, swallowing a missing-task error", () => {
		const runner = recordingRunner({ queryThrows: false });
		createDaemonServiceController("schtasks", runner).unregister(WIN_SPEC);
		const argvs = runner.runs.map((r) => r.args.join(" "));
		expect(argvs).toContain(`/End /TN ${SERVICE_TASK_NAME}`);
		expect(argvs).toContain(`/Delete /TN ${SERVICE_TASK_NAME} /F`);
	});
});

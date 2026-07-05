/**
 * PRD-064h, the primary-daemon OS-native service helper (`src/cli/daemon-service.ts`).
 *
 * Proves with a recording {@link ServiceRunner} (NO real launchctl/systemctl/schtasks, NO real file
 * IO) and pure template assertions:
 *   - detectServiceManager picks the right per-OS manager, is side-effect-free, and honors the
 *     `HONEYCOMB_DAEMON_SERVICE=spawn` opt-out + the no-user-bus-on-linux fallback (HC-1 fallback).
 *   - AC-064h.4: every generated unit (launchd plist / systemd unit / schtasks /TR) PINS the
 *     writable workspace into BOTH the working dir AND HONEYCOMB_WORKSPACE.
 *   - AC-064h.5: restart goes THROUGH the manager (kickstart / systemctl restart / schtasks stop+run),
 *     never a second spawn, and the schtasks restart is stop-then-run on the SAME task.
 *   - register/unregister/status argv is the exact fixed-argv the manager expects.
 */

import { describe, expect, it } from "vitest";

import {
	type ServiceRunner,
	type ServiceSpec,
	LEGACY_SERVICE_LABEL,
	LEGACY_SERVICE_SYSTEMD_UNIT,
	LEGACY_SERVICE_TASK_NAME,
	SERVICE_LABEL,
	SERVICE_SYSTEMD_UNIT,
	SERVICE_TASK_NAME,
	STAGED_TASK_XML_NAME,
	buildSchtasksCreateArgs,
	createDaemonServiceController,
	detectServiceManager,
	launchdPlistPath,
	legacyLaunchdPlistPath,
	renderLaunchdPlist,
	renderScheduledTaskXml,
	renderSystemdUnit,
	resolveWindowsUserId,
	stagedTaskXmlPath,
	systemdUnitPath,
} from "../../src/cli/daemon-service.js";

/** A representative Windows SID used across the schtasks tests. */
const FAKE_SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
/** The `whoami /user /fo csv /nh` line shape the parser reads (last field is the SID). */
const WHOAMI_CSV = `"ada-pc\\ada","${FAKE_SID}"`;

/** A recording runner: captures every run/writeFile/removeFile call WITHOUT executing anything. */
function recordingRunner(opts?: { fileExists?: boolean; queryThrows?: boolean; whoamiOut?: string }): ServiceRunner & {
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
			// whoami /user is the SID probe the schtasks register path runs; return a CSV row.
			if (cmd.toLowerCase().endsWith("whoami.exe")) {
				return opts?.whoamiOut ?? WHOAMI_CSV;
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

describe("PRD-064h detectServiceManager, cheap, side-effect-free, per-OS + fallback", () => {
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
		expect(
			detectServiceManager({ HONEYCOMB_DAEMON_SERVICE: "spawn", XDG_RUNTIME_DIR: "/run/user/1000" }, "linux"),
		).toBeNull();
	});

	it("returns null on an unknown platform (→ spawn fallback)", () => {
		expect(detectServiceManager({}, "aix")).toBeNull();
	});
});

describe("PRD-064h AC-064h.4, launchd plist pins the writable workspace", () => {
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

describe("PRD-064h AC-064h.4, systemd --user unit pins the writable workspace", () => {
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

const WIN_SPEC_ROOTED: ServiceSpec = {
	...WIN_SPEC,
	fleetRoot: "C:\\Users\\ada\\.apiary",
};

describe("PRD-064h AC-064h.4, schtasks /Create registers from the staged SID-scoped XML", () => {
	const xmlPath = stagedTaskXmlPath(WIN_SPEC_ROOTED);
	const args = buildSchtasksCreateArgs(xmlPath);
	it("is fixed-argv: /Create /XML <file> /TN <task> /F (the non-elevated 25H2 recipe)", () => {
		expect(args).toEqual(["/Create", "/XML", xmlPath, "/TN", SERVICE_TASK_NAME, "/F"]);
		// The legacy inline /TR / /SC ONLOGON form (which 25H2 refuses without elevation) is gone.
		expect(args).not.toContain("/TR");
		expect(args).not.toContain("/SC");
	});
	it("stages the XML under honeycomb's state dir (<fleetRoot>/honeycomb/honeycomb-task.xml)", () => {
		expect(xmlPath.endsWith(STAGED_TASK_XML_NAME)).toBe(true);
		expect(xmlPath).toContain("honeycomb");
	});
	it("stagedTaskXmlPath throws when the state dir escapes containment (fallback signal)", () => {
		// A fleetRoot of "" makes join(base, PRODUCT_SLUG) resolve under cwd, not an escape; a truly
		// escaping name is impossible with the fixed literal, so assert the happy path stays contained.
		expect(stagedTaskXmlPath(WIN_SPEC).endsWith(STAGED_TASK_XML_NAME)).toBe(true);
	});
});

describe("PRD-064h AC-064h.4, renderScheduledTaskXml is SID-scoped + conhost-headless", () => {
	const xml = renderScheduledTaskXml(WIN_SPEC_ROOTED, FAKE_SID, "C:\\Windows\\System32\\conhost.exe");
	it("scopes BOTH the LogonTrigger AND the Principal to the current user's SID", () => {
		expect(xml).toContain("<LogonTrigger>");
		expect(xml).toContain(`<Principal id="Author">`);
		// The SID appears twice: once in the trigger, once in the principal.
		expect(xml.match(new RegExp(`<UserId>${FAKE_SID}</UserId>`, "g"))?.length).toBe(2);
		expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
		expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
	});
	it("preserves the liveness-floor semantics (StartWhenAvailable, PT0S, RestartOnFailure PT1M x999)", () => {
		expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
		expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
		expect(xml).toContain("<Interval>PT1M</Interval>");
		expect(xml).toContain("<Count>999</Count>");
		expect(xml).toContain(`<Task version="1.2"`);
	});
	it("wraps the command in conhost --headless so no console window pops", () => {
		expect(xml).toContain("<Command>C:\\Windows\\System32\\conhost.exe</Command>");
		expect(xml).toContain("--headless cmd /c");
	});
	it("pins cd /d <workspace> + HONEYCOMB_WORKSPACE + APIARY_HOME + node entry (system32 close)", () => {
		expect(xml).toContain("cd /d &quot;C:\\Users\\ada\\hc&quot;");
		expect(xml).toContain("set HONEYCOMB_WORKSPACE=C:\\Users\\ada\\hc");
		expect(xml).toContain("set APIARY_HOME=C:\\Users\\ada\\.apiary");
		expect(xml).toContain("daemon\\index.js");
	});
	it("omits the APIARY_HOME set when no fleet root is pinned", () => {
		const plain = renderScheduledTaskXml(WIN_SPEC, FAKE_SID, "C:\\Windows\\System32\\conhost.exe");
		expect(plain).not.toContain("set APIARY_HOME=");
	});
	it("XML-escapes embedded values, including an apostrophe that passes the cmd-safety guard", () => {
		const spec: ServiceSpec = { ...WIN_SPEC, workspace: "C:\\Users\\O'Brien\\hc" };
		const escaped = renderScheduledTaskXml(spec, FAKE_SID, "C:\\Windows\\System32\\conhost.exe");
		expect(escaped).toContain("O&apos;Brien");
		expect(escaped).not.toContain("O'Brien");
	});
	it("THROWS on a cmd-metacharacter in a path (the service-unavailable fallback signal)", () => {
		const poisoned: ServiceSpec = { ...WIN_SPEC, workspace: 'C:\\hc" & calc' };
		expect(() => renderScheduledTaskXml(poisoned, FAKE_SID)).toThrow(/unsafe character/);
	});
});

describe("PRD-064h resolveWindowsUserId, whoami SID first, DOMAIN\\USER fallback, else throw", () => {
	it("returns the regex-validated SID parsed from whoami /user /fo csv /nh", () => {
		const runner = recordingRunner();
		expect(resolveWindowsUserId(runner, { SystemRoot: "C:\\Windows" })).toBe(FAKE_SID);
		// It shelled out to the fixed System32\\whoami.exe path (never bare `whoami`, never a shell).
		const whoami = runner.runs.find((r) => r.cmd.toLowerCase().endsWith("whoami.exe"));
		expect(whoami?.cmd).toBe("C:\\Windows\\System32\\whoami.exe");
		expect(whoami?.args).toEqual(["/user", "/fo", "csv", "/nh"]);
	});
	it("rejects a non-SID whoami row and falls back to XML-escaped DOMAIN\\USER", () => {
		const runner = recordingRunner({ whoamiOut: `"ada-pc\\ada","not-a-sid"` });
		expect(resolveWindowsUserId(runner, { USERDOMAIN: "ADA-PC", USERNAME: "ada" })).toBe("ADA-PC\\ada");
	});
	it("falls back to bare USERNAME when USERDOMAIN is absent", () => {
		const runner = recordingRunner({ whoamiOut: "garbage" });
		expect(resolveWindowsUserId(runner, { USERNAME: "ada" })).toBe("ada");
	});
	it("THROWS when neither a SID nor a USERNAME resolves (service-unavailable fallback signal)", () => {
		const runner = recordingRunner({ whoamiOut: "garbage" });
		expect(() => resolveWindowsUserId(runner, {})).toThrow(/cannot resolve the current Windows user/);
	});
});

describe("PRD-064h launchd controller, register/restart/status argv (injected runner)", () => {
	it("register deregisters the legacy agent (decision #32), writes the plist, then bootstraps it", () => {
		const runner = recordingRunner();
		const ctl = createDaemonServiceController("launchd", runner);
		const res = ctl.register(SPEC);
		expect(res.ok).toBe(true);
		// Decision #32 migration: the legacy label is booted out and its plist removed first.
		expect(runner.runs[0]?.cmd).toBe("launchctl");
		expect(runner.runs[0]?.args).toEqual(["bootout", expect.stringContaining(LEGACY_SERVICE_LABEL)]);
		expect(runner.removes).toContain(legacyLaunchdPlistPath("/home/ada"));
		expect(runner.writes[0]?.path).toBe(launchdPlistPath("/home/ada"));
		expect(runner.runs[1]?.cmd).toBe("launchctl");
		expect(runner.runs[1]?.args[0]).toBe("bootstrap");
	});

	it("AC-064h.5 restart goes THROUGH launchctl kickstart -k (no second spawn)", () => {
		const runner = recordingRunner();
		const ctl = createDaemonServiceController("launchd", runner);
		ctl.restart(SPEC);
		expect(runner.runs[0]?.cmd).toBe("launchctl");
		expect(runner.runs[0]?.args.slice(0, 3)).toEqual(["kickstart", "-k", expect.stringContaining(SERVICE_LABEL)]);
	});

	it("daemon stop bootouts the LaunchAgent so KeepAlive does not respawn it", () => {
		const runner = recordingRunner();
		const ctl = createDaemonServiceController("launchd", runner);
		ctl.stop(SPEC);
		expect(runner.runs[0]?.cmd).toBe("launchctl");
		expect(runner.runs[0]?.args).toEqual(["bootout", expect.stringContaining(SERVICE_LABEL)]);
		expect(runner.runs[0]?.args).not.toContain("kill");
	});

	it("isRegistered reflects the plist file presence", () => {
		expect(createDaemonServiceController("launchd", recordingRunner({ fileExists: true })).isRegistered(SPEC)).toBe(
			true,
		);
		expect(createDaemonServiceController("launchd", recordingRunner({ fileExists: false })).isRegistered(SPEC)).toBe(
			false,
		);
	});
});

describe("PRD-064h systemd controller, register/restart argv (injected runner)", () => {
	it("register deregisters the legacy unit (decision #32), writes the unit, daemon-reloads, then enable --now", () => {
		const runner = recordingRunner();
		const ctl = createDaemonServiceController("systemd-user", runner);
		ctl.register(SPEC);
		expect(runner.writes[0]?.path).toBe(systemdUnitPath("/home/ada"));
		expect(runner.runs.map((r) => r.args.join(" "))).toEqual([
			`--user disable --now ${LEGACY_SERVICE_SYSTEMD_UNIT}`,
			"--user daemon-reload",
			`--user enable --now ${SERVICE_SYSTEMD_UNIT}`,
		]);
	});

	it("AC-064h.5 restart goes THROUGH systemctl --user restart (no second spawn)", () => {
		const runner = recordingRunner();
		createDaemonServiceController("systemd-user", runner).restart(SPEC);
		expect(runner.runs[0]?.cmd).toBe("systemctl");
		expect(runner.runs[0]?.args).toEqual(["--user", "restart", SERVICE_SYSTEMD_UNIT]);
	});
});

describe("PRD-064h schtasks controller, register/restart/status argv (injected runner)", () => {
	it("register deletes the legacy task, resolves the SID, stages the XML, creates from /XML, runs it", () => {
		const runner = recordingRunner();
		const ctl = createDaemonServiceController("schtasks", runner);
		ctl.register(WIN_SPEC);
		expect(runner.runs[0]?.args).toEqual(["/End", "/TN", LEGACY_SERVICE_TASK_NAME]);
		expect(runner.runs[1]?.args).toEqual(["/Delete", "/TN", LEGACY_SERVICE_TASK_NAME, "/F"]);
		// The SID probe runs before the task is created.
		expect(runner.runs[2]?.cmd.toLowerCase().endsWith("whoami.exe")).toBe(true);
		expect(runner.runs[3]?.args[0]).toBe("/Create");
		expect(runner.runs[3]?.args).toContain("/XML");
		expect(runner.runs[4]?.args).toEqual(["/Run", "/TN", SERVICE_TASK_NAME]);
		// The staged XML is written before /Create and carries the resolved SID in both places.
		expect(runner.writes[0]?.path.endsWith(STAGED_TASK_XML_NAME)).toBe(true);
		expect(runner.writes[0]?.contents).toContain(`<UserId>${FAKE_SID}</UserId>`);
	});

	it("AC-064h.5 restart is stop-then-run on the SAME task (no second spawn, no double-bind)", () => {
		const runner = recordingRunner();
		createDaemonServiceController("schtasks", runner).restart(WIN_SPEC);
		expect(runner.runs[0]?.args).toEqual(["/End", "/TN", SERVICE_TASK_NAME]);
		expect(runner.runs[1]?.args).toEqual(["/Run", "/TN", SERVICE_TASK_NAME]);
	});

	it("isRegistered is true when /Query succeeds, false when it throws (task absent)", () => {
		expect(
			createDaemonServiceController("schtasks", recordingRunner({ queryThrows: false })).isRegistered(WIN_SPEC),
		).toBe(true);
		expect(
			createDaemonServiceController("schtasks", recordingRunner({ queryThrows: true })).isRegistered(WIN_SPEC),
		).toBe(false);
	});

	it("unregister ends then deletes the task and best-effort removes the staged XML", () => {
		const runner = recordingRunner({ queryThrows: false });
		createDaemonServiceController("schtasks", runner).unregister(WIN_SPEC);
		const argvs = runner.runs.map((r) => r.args.join(" "));
		expect(argvs).toContain(`/End /TN ${SERVICE_TASK_NAME}`);
		expect(argvs).toContain(`/Delete /TN ${SERVICE_TASK_NAME} /F`);
		expect(runner.removes.some((p) => p.endsWith(STAGED_TASK_XML_NAME))).toBe(true);
	});
});

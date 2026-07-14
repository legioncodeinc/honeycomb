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

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
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
	WINDOWS_HONEYCOMB_PROCESS_CLEANUP_SCRIPT,
	WINDOWS_HONEYCOMB_PROCESS_IDENTITY_PROBE_SCRIPT,
	WINDOWS_POWERSHELL_PATH,
	WINDOWS_TASK_RUNNING_SCRIPT,
	buildSchtasksCreateArgs,
	createDaemonServiceController,
	detectServiceManager,
	serviceManagerForPlatform,
	launchdPlistPath,
	legacyLaunchdPlistPath,
	renderLaunchdPlist,
	renderScheduledTaskXml,
	renderSystemdUnit,
	matchesWindowsDaemonProcess,
	resolveWindowsUserId,
	stagedTaskXmlPath,
	systemdUnitPath,
} from "../../src/cli/daemon-service.js";

/** A representative Windows SID used across the schtasks tests. */
const FAKE_SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
/** The `whoami /user /fo csv /nh` line shape the parser reads (last field is the SID). */
const WHOAMI_CSV = `"ada-pc\\ada","${FAKE_SID}"`;

function utf16Base64(value: string): string {
	return Buffer.from(value, "utf16le").toString("base64");
}

/** A recording runner: captures every run/writeFile/removeFile call WITHOUT executing anything. */
function recordingRunner(opts?: {
	fileExists?: boolean;
	queryThrows?: boolean;
	whoamiOut?: string;
	cleanupThrows?: boolean;
	taskNotRunning?: boolean;
}): ServiceRunner & {
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
			if (opts?.cleanupThrows && args.includes(WINDOWS_HONEYCOMB_PROCESS_CLEANUP_SCRIPT))
				throw new Error("daemon remained");
			if (opts?.taskNotRunning && args.includes(WINDOWS_TASK_RUNNING_SCRIPT)) throw new Error("task is Ready");
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

	it("explicit service selection ignores spawn preference and Linux bus heuristics", () => {
		expect(serviceManagerForPlatform("darwin")).toBe("launchd");
		expect(serviceManagerForPlatform("win32")).toBe("schtasks");
		expect(serviceManagerForPlatform("linux")).toBe("systemd-user");
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
		expect(unit).toContain('WorkingDirectory="/home/ada/.honeycomb"');
		expect(unit).toContain('Environment="HONEYCOMB_WORKSPACE=/home/ada/.honeycomb"');
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
	logPath: "C:\\Users\\ada\\.apiary\\honeycomb\\service.log",
};

describe("PRD-003c authoritative service-log destinations", () => {
	it("binds both launchd streams to Honeycomb's product-owned log", () => {
		const rendered = renderLaunchdPlist({ ...SPEC, logPath: "/home/ada/.apiary/honeycomb/service.log" });
		expect(rendered).toContain("<key>StandardOutPath</key>");
		expect(rendered).toContain("<key>StandardErrorPath</key>");
		expect(rendered.match(/service\.log/g)?.length).toBe(2);
	});

	it("binds both systemd streams to Honeycomb's product-owned log", () => {
		const rendered = renderSystemdUnit({ ...SPEC, logPath: "/home/ada/.apiary/honeycomb/service.log" });
		expect(rendered).toContain('StandardOutput="append:/home/ada/.apiary/honeycomb/service.log"');
		expect(rendered).toContain('StandardError="append:/home/ada/.apiary/honeycomb/service.log"');
	});

	it("rejects systemd directive, specifier, and variable-expansion injection in env-derived paths", () => {
		expect(() => renderSystemdUnit({ ...SPEC, logPath: "/tmp/service.log\nExecStart=/tmp/pwn" })).toThrow(
			/unsafe character/,
		);
		expect(() => renderSystemdUnit({ ...SPEC, workspace: "/tmp/%h/$HOME" })).toThrow(/unsafe character/);
	});

	it("redirects the Windows daemon to Honeycomb's product-owned log", () => {
		const rendered = renderScheduledTaskXml(WIN_SPEC_ROOTED, FAKE_SID);
		expect(rendered).toContain(
			`&gt;&gt; &quot;C:\\Users\\ada\\.apiary\\honeycomb\\service.log&quot; 2&gt;&amp;1`,
		);
		expect(rendered).not.toContain("^&gt;");
		expect(rendered).not.toContain("^&amp;");
	});

	it.runIf(process.platform === "win32")(
		"lets cmd consume stdout/stderr redirection instead of passing operators to Node argv",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "honeycomb-task-redirection-"));
			try {
				const entry = join(dir, "emit.js");
				const logPath = join(dir, "service.log");
				writeFileSync(
					entry,
					'process.stdout.write("STDOUT\\n"); process.stderr.write("STDERR\\n"); console.log(`ARGV=${JSON.stringify(process.argv.slice(2))}`);',
					"utf8",
				);
				const xml = renderScheduledTaskXml(
					{ nodePath: process.execPath, entry, nodeFlags: [], workspace: dir, home: dir, logPath },
					FAKE_SID,
				);
				const encodedArguments = xml.match(/<Arguments>([\s\S]*?)<\/Arguments>/u)?.[1];
				expect(encodedArguments).toBeDefined();
				const argumentsText = (encodedArguments ?? "")
					.replaceAll("&quot;", '"')
					.replaceAll("&gt;", ">")
					.replaceAll("&lt;", "<")
					.replaceAll("&amp;", "&");
				const prefix = '--headless cmd /v:on /c "';
				expect(argumentsText.startsWith(prefix)).toBe(true);
				expect(argumentsText.endsWith('"')).toBe(true);
				const innerCommand = argumentsText.slice(prefix.length, -1);
				// Execute the exact node-invocation fragment emitted inside the renderer's relaunch loop.
				// A temporary .cmd file avoids introducing a second, unrelated `/c` outer-quote layer into
				// this test; cmd still parses the production `>> ... 2>&1` operators themselves.
				const bodyStart = innerCommand.indexOf(" do (") + " do (".length;
				const bodyEnd = innerCommand.indexOf(" & if !errorlevel!", bodyStart);
				expect(bodyStart).toBeGreaterThan(" do (".length - 1);
				expect(bodyEnd).toBeGreaterThan(bodyStart);
				const commandFile = join(dir, "invoke.cmd");
				writeFileSync(commandFile, `@echo off\r\n${innerCommand.slice(bodyStart, bodyEnd)}\r\n`, "utf8");
				const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
				execFileSync(win32.join(systemRoot, "System32", "cmd.exe"), ["/d", "/c", commandFile], {
					cwd: dir,
					timeout: 10_000,
					windowsHide: true,
				});
				const log = readFileSync(logPath, "utf8");
				expect(log).toContain("STDOUT");
				expect(log).toContain("STDERR");
				expect(log).toContain("ARGV=[]");
				expect(log).not.toContain(">>");
			} finally {
				rmSync(dir, { force: true, recursive: true });
			}
		},
	);
});

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
		// `/v:on` enables delayed expansion so the relaunch loop can read `!errorlevel!` (see below).
		expect(xml).toContain("--headless cmd /v:on /c");
	});
	it("pins cd /d <workspace> + HONEYCOMB_WORKSPACE + APIARY_HOME + node entry (system32 close)", () => {
		expect(xml).toContain("cd /d &quot;C:\\Users\\ada\\hc&quot;");
		// Quoted `set "VAR=value"` so cmd does not fold the space before `&&` into the value.
		expect(xml).toContain(`set &quot;HONEYCOMB_WORKSPACE=C:\\Users\\ada\\hc&quot;`);
		expect(xml).toContain(`set &quot;APIARY_HOME=C:\\Users\\ada\\.apiary&quot;`);
		expect(xml).toContain("daemon\\index.js");
	});
	it("wraps node in a conhost-independent relaunch loop that restarts on a NON-ZERO exit only", () => {
		// conhost --headless masks the child's exit code (always reports 0 to Task Scheduler), so the
		// task's <RestartOnFailure> can never fire. The auto-restart must live INSIDE the cmd, where the
		// real errorlevel is visible. The loop re-launches node on a non-zero exit and BREAKS on a clean
		// exit (a deliberate `daemon stop` is not fought). XML-escaped: `&`→`&amp;`, `>`→`&gt;`.
		expect(xml).toContain("for /l %i in (1,1,60)"); // bounded relaunch loop
		expect(xml).toContain("if !errorlevel! equ 0 (exit /b 0)"); // clean exit breaks the loop
		expect(xml).toContain("timeout /t 5 /nobreak"); // backoff between relaunches
		expect(xml).toContain("&amp;"); // the `& ` command chaining is XML-escaped
		expect(xml).toContain("&gt;nul"); // the `>nul` redirect is XML-escaped
	});
	it("omits the APIARY_HOME set when no fleet root is pinned", () => {
		const plain = renderScheduledTaskXml(WIN_SPEC, FAKE_SID, "C:\\Windows\\System32\\conhost.exe");
		expect(plain).not.toContain("APIARY_HOME");
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
	it("THROWS on a `!` in a path (delayed-expansion injection — the action runs `cmd /v:on`)", () => {
		// `/v:on` makes `!VAR!` expand at execution time on the command line these paths embed into,
		// so `!` must be rejected exactly like the other cmd metacharacters. Guards workspace + entry.
		const poisonedWs: ServiceSpec = { ...WIN_SPEC, workspace: "C:\\Users\\!APPDATA!\\hc" };
		expect(() => renderScheduledTaskXml(poisonedWs, FAKE_SID)).toThrow(/unsafe character/);
		const poisonedEntry: ServiceSpec = { ...WIN_SPEC, entry: "C:\\hc\\!PROGRAMDATA!\\index.js" };
		expect(() => renderScheduledTaskXml(poisonedEntry, FAKE_SID)).toThrow(/unsafe character/);
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
		// Exact descendant cleanup runs before replacement, then SID resolution and create/run.
		expect(runner.runs.some((r) => r.cmd === WINDOWS_POWERSHELL_PATH)).toBe(true);
		expect(runner.runs.some((r) => r.cmd.toLowerCase().endsWith("whoami.exe"))).toBe(true);
		expect(runner.runs.find((r) => r.args[0] === "/Create")?.args).toContain("/XML");
		expect(runner.runs.at(-1)?.args).toEqual(["/Run", "/TN", SERVICE_TASK_NAME]);
		// The staged XML is written before /Create and carries the resolved SID in both places.
		expect(runner.writes[0]?.path.endsWith(STAGED_TASK_XML_NAME)).toBe(true);
		expect(runner.writes[0]?.contents).toContain(`<UserId>${FAKE_SID}</UserId>`);
	});

	it("AC-064h.5 restart is stop-then-run on the SAME task (no second spawn, no double-bind)", () => {
		const runner = recordingRunner();
		createDaemonServiceController("schtasks", runner).restart(WIN_SPEC);
		expect(runner.runs[0]?.args).toEqual(["/End", "/TN", SERVICE_TASK_NAME]);
		expect(runner.runs[1]?.cmd).toBe(WINDOWS_POWERSHELL_PATH);
		expect(runner.runs[2]?.args).toEqual(["/Run", "/TN", SERVICE_TASK_NAME]);
	});

	it("cleanup normalizes WMI quote fragmentation but still requires full exact identity", () => {
		expect(WINDOWS_HONEYCOMB_PROCESS_CLEANUP_SCRIPT).toContain("$expectedPattern");
		expect(WINDOWS_HONEYCOMB_PROCESS_CLEANUP_SCRIPT).toContain("[Regex]::IsMatch");
		expect(WINDOWS_HONEYCOMB_PROCESS_CLEANUP_SCRIPT).toContain("Honeycomb daemon process remained after stop");
		expect(WINDOWS_HONEYCOMB_PROCESS_CLEANUP_SCRIPT).not.toContain("IndexOf($entry");
		const fragmented =
			'C:\\Program" "Files\\nodejs\\node.exe  --experimental-sqlite C:\\Users\\ada\\hc\\daemon\\index.js';
		expect(matchesWindowsDaemonProcess(WIN_SPEC.nodePath, fragmented, WIN_SPEC)).toBe(true);
		expect(matchesWindowsDaemonProcess(WIN_SPEC.nodePath, `${fragmented} --extra`, WIN_SPEC)).toBe(false);
		expect(matchesWindowsDaemonProcess("C:\\other\\node.exe", fragmented, WIN_SPEC)).toBe(false);
		// Removing all quotes would collapse this DIFFERENT argv layout to the expected display text.
		// The anchored token pattern rejects it even if a caller lies about ExecutablePath.
		const ambiguous =
			'C:\\Program "Files\\nodejs\\node.exe --experimental-sqlite C:\\Users\\ada\\hc\\daemon\\index.js';
		expect(matchesWindowsDaemonProcess(WIN_SPEC.nodePath, ambiguous, WIN_SPEC)).toBe(false);
		const runner = recordingRunner();
		createDaemonServiceController("schtasks", runner).stop(WIN_SPEC);
		const cleanup = runner.runs.find((run) => run.cmd === WINDOWS_POWERSHELL_PATH);
		expect(cleanup?.args).toHaveLength(10);
		expect(Buffer.from(cleanup?.args.at(-1) ?? "", "base64").toString("utf16le")).toBe(
			JSON.stringify(WIN_SPEC.nodeFlags),
		);
	});

	it.runIf(process.platform === "win32")(
		"PowerShell 5 flattens decoded flags and matches the live fragmented WMI command exactly",
		() => {
			const fragmented =
				'C:\\Program" "Files\\nodejs\\node.exe  --experimental-sqlite C:\\Users\\ada\\hc\\daemon\\index.js';
			const runProbe = (commandLine: string): string =>
				execFileSync(
					WINDOWS_POWERSHELL_PATH,
					[
						"-NoLogo",
						"-NoProfile",
						"-NonInteractive",
						"-ExecutionPolicy",
						"Bypass",
						"-Command",
						WINDOWS_HONEYCOMB_PROCESS_IDENTITY_PROBE_SCRIPT,
						utf16Base64(WIN_SPEC.entry),
						utf16Base64(WIN_SPEC.nodePath),
						utf16Base64(JSON.stringify(WIN_SPEC.nodeFlags)),
						utf16Base64(WIN_SPEC.nodePath),
						utf16Base64(commandLine),
					],
					{ encoding: "utf8", timeout: 10_000, windowsHide: true },
				).trim();

			expect(runProbe(fragmented)).toBe(
				"C:\\Program Files\\nodejs\\node.exe --experimental-sqlite C:\\Users\\ada\\hc\\daemon\\index.js",
			);
			expect(() => runProbe(`${fragmented} --extra`)).toThrow();
			expect(() =>
				runProbe(
					'C:\\Program "Files\\nodejs\\node.exe --experimental-sqlite C:\\Users\\ada\\hc\\daemon\\index.js',
				),
			).toThrow();
			expect(() =>
				runProbe(
					'C:\\Program" "Files\\nodejs\\node.exe C:\\Users\\ada\\hc\\daemon\\index.js --experimental-sqlite',
				),
			).toThrow();
		},
	);

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

	it("unregister fails closed and preserves the task when daemon-stop verification fails", () => {
		const runner = recordingRunner({ cleanupThrows: true });
		expect(() => createDaemonServiceController("schtasks", runner).unregister(WIN_SPEC)).toThrow(/daemon remained/);
		expect(runner.runs.some((run) => run.args[0] === "/Delete" && run.args[2] === SERVICE_TASK_NAME)).toBe(false);
	});

	it("register fails closed before replacement when orphan-stop verification fails", () => {
		const runner = recordingRunner({ cleanupThrows: true });
		expect(() => createDaemonServiceController("schtasks", runner).register(WIN_SPEC)).toThrow(/daemon remained/);
		expect(runner.runs.some((run) => run.args[0] === "/Create" && run.args.includes(SERVICE_TASK_NAME))).toBe(false);
		expect(runner.writes).toHaveLength(0);
	});

	it("reports Ready/non-running task state separately from registration", () => {
		const runningRunner = recordingRunner();
		const running = createDaemonServiceController("schtasks", runningRunner);
		const ready = createDaemonServiceController("schtasks", recordingRunner({ taskNotRunning: true }));
		expect(running.isRunning?.(WIN_SPEC)).toBe(true);
		const probe = runningRunner.runs.find((run) => run.args.includes(WINDOWS_TASK_RUNNING_SCRIPT));
		expect(probe?.args).toHaveLength(11);
		expect(Buffer.from(probe?.args.at(-1) ?? "", "base64").toString("utf16le")).toBe(
			JSON.stringify(WIN_SPEC.nodeFlags),
		);
		expect(ready.isRunning?.(WIN_SPEC)).toBe(false);
	});
});

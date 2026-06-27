/**
 * Service-module behaviour tests (PRD-063b): the install/uninstall/status flow over the
 * injected runner + fs, asserting the unit file is written before the manager runs, the
 * uninstall removes the file (AC-063b.5), and every failure mode is a returned message
 * (never a throw, design principle 1).
 */

import { describe, expect, it } from "vitest";

import { createServiceModule, serviceStatus } from "../../src/service/index.js";
import { SERVICE_LABEL } from "../../src/service/platform.js";
import { createMemoryFs, createRecordingRunner, fixedEnv } from "./helpers.js";

describe("install - writes the unit file then runs the manager argv", () => {
	it("Linux: writes the systemd unit, then enables it (file before command)", async () => {
		const runner = createRecordingRunner();
		const fs = createMemoryFs();
		const module = createServiceModule({
			execPath: "/usr/bin/hivedoctor",
			runner,
			fs,
			environment: fixedEnv({ platform: "linux", home: "/home/t" }),
		});

		const line = await module.install();

		// The unit file was written under ~/.config/systemd/user.
		const unitPath = "/home/t/.config/systemd/user/hivedoctor.service";
		expect(fs.files.has(unitPath)).toBe(true);
		expect(fs.files.get(unitPath)).toContain("Restart=always");
		// Then systemctl --user enable --now ran.
		expect(runner.calls[0]).toEqual({
			command: "systemctl",
			args: ["--user", "enable", "--now", "hivedoctor.service"],
		});
		expect(line).toContain("user scope");
	});

	it("macOS: writes the plist then bootstraps + kickstarts", async () => {
		const runner = createRecordingRunner();
		const fs = createMemoryFs();
		const module = createServiceModule({
			execPath: "/opt/hivedoctor",
			runner,
			fs,
			environment: fixedEnv({ platform: "darwin", home: "/Users/t" }),
		});

		await module.install();

		const plistPath = `/Users/t/Library/LaunchAgents/${SERVICE_LABEL}.plist`;
		expect(fs.files.get(plistPath)).toContain("<key>KeepAlive</key>");
		expect(runner.calls[0]?.command).toBe("launchctl");
		expect(runner.calls[0]?.args[0]).toBe("bootstrap");
	});

	it("Windows: stages the Scheduled Task XML beside the workspace, then schtasks /Create", async () => {
		const runner = createRecordingRunner();
		const fs = createMemoryFs();
		const module = createServiceModule({
			execPath: "C:\\bin\\hivedoctor.cmd",
			runner,
			fs,
			environment: fixedEnv({ platform: "win32", home: "C:\\Users\\t" }),
		});

		await module.install();

		const staged = "C:\\Users\\t/.honeycomb/hivedoctor/hivedoctor-task.xml";
		expect(fs.files.get(staged)).toContain("<Task ");
		expect(runner.calls[0]).toEqual({
			command: "schtasks",
			args: ["/Create", "/XML", staged, "/TN", "HiveDoctor", "/F"],
		});
	});

	it("a unit-write failure (EACCES) returns a message, never throws", async () => {
		const runner = createRecordingRunner();
		const fs = createMemoryFs(true); // writeFile throws
		const module = createServiceModule({
			execPath: "/usr/bin/hivedoctor",
			runner,
			fs,
			environment: fixedEnv({ platform: "linux" }),
		});

		const line = await module.install();
		expect(line).toContain("Could not write the HiveDoctor unit file");
		// The manager argv was NOT run (we never got past the write).
		expect(runner.calls).toHaveLength(0);
	});

	it("a manager-command failure is reported but does not throw", async () => {
		const runner = createRecordingRunner((command) =>
			command === "systemctl" ? { ok: false, code: 1, stdout: "", stderr: "boom" } : { ok: true, code: 0, stdout: "", stderr: "" },
		);
		const fs = createMemoryFs();
		const module = createServiceModule({
			execPath: "/usr/bin/hivedoctor",
			runner,
			fs,
			environment: fixedEnv({ platform: "linux" }),
		});

		const line = await module.install();
		expect(line).toContain("service-manager command failed");
	});

	it("an unsupported platform returns a clean message, never throws", async () => {
		const module = createServiceModule({
			execPath: "/x",
			runner: createRecordingRunner(),
			fs: createMemoryFs(),
			environment: fixedEnv({ platform: "sunos" }),
		});
		const line = await module.install();
		expect(line).toContain("unsupported platform");
	});
});

describe("uninstall - deregisters then removes the unit file (AC-063b.5)", () => {
	it("Linux: disables the unit, then deletes the unit file so it cannot resurrect", async () => {
		const runner = createRecordingRunner();
		const fs = createMemoryFs();
		const unitPath = "/home/t/.config/systemd/user/hivedoctor.service";
		fs.files.set(unitPath, "stale unit");
		const module = createServiceModule({
			execPath: "/usr/bin/hivedoctor",
			runner,
			fs,
			environment: fixedEnv({ platform: "linux", home: "/home/t" }),
		});

		const line = await module.uninstall();

		expect(runner.calls[0]).toEqual({
			command: "systemctl",
			args: ["--user", "disable", "--now", "hivedoctor.service"],
		});
		expect(fs.removed).toContain(unitPath);
		expect(fs.files.has(unitPath)).toBe(false);
		expect(line).toContain("will not start on next boot");
	});

	it("Windows: deletes the task and removes the staged XML", async () => {
		const runner = createRecordingRunner();
		const fs = createMemoryFs();
		const module = createServiceModule({
			execPath: "C:\\bin\\hivedoctor.cmd",
			runner,
			fs,
			environment: fixedEnv({ platform: "win32", home: "C:\\Users\\t" }),
		});

		await module.uninstall();

		expect(runner.calls[0]).toEqual({ command: "schtasks", args: ["/Delete", "/TN", "HiveDoctor", "/F"] });
		expect(fs.removed).toContain("C:\\Users\\t/.honeycomb/hivedoctor/hivedoctor-task.xml");
	});

	it("a missing unit during uninstall is tolerated (idempotent), still reports cleanly", async () => {
		// disable --now fails (unit already gone); the module still removes the file + reports.
		const runner = createRecordingRunner(() => ({ ok: false, code: 1, stdout: "", stderr: "not loaded" }));
		const fs = createMemoryFs();
		const module = createServiceModule({
			execPath: "/usr/bin/hivedoctor",
			runner,
			fs,
			environment: fixedEnv({ platform: "linux" }),
		});
		const line = await module.uninstall();
		expect(line).toContain("already gone");
	});
});

describe("serviceStatus classification", () => {
	it("systemd is-active 'active' -> running", async () => {
		const runner = createRecordingRunner(() => ({ ok: true, code: 0, stdout: "active\n", stderr: "" }));
		const status = await serviceStatus({
			execPath: "/usr/bin/hivedoctor",
			runner,
			environment: fixedEnv({ platform: "linux" }),
		});
		expect(status).toBe("running");
	});

	it("systemd is-active non-zero (inactive) -> not-running", async () => {
		const runner = createRecordingRunner(() => ({ ok: false, code: 3, stdout: "inactive\n", stderr: "" }));
		const status = await serviceStatus({
			execPath: "/usr/bin/hivedoctor",
			runner,
			environment: fixedEnv({ platform: "linux" }),
		});
		expect(status).toBe("not-running");
	});

	it("a spawn error (manager binary missing) -> unknown", async () => {
		const runner = createRecordingRunner(() => ({ ok: false, code: null, stdout: "", stderr: "", detail: "ENOENT" }));
		const status = await serviceStatus({
			execPath: "/usr/bin/hivedoctor",
			runner,
			environment: fixedEnv({ platform: "linux" }),
		});
		expect(status).toBe("unknown");
	});

	it("schtasks query ok -> running", async () => {
		const runner = createRecordingRunner(() => ({ ok: true, code: 0, stdout: "TaskName Running", stderr: "" }));
		const status = await serviceStatus({
			execPath: "C:\\bin\\hivedoctor.cmd",
			runner,
			environment: fixedEnv({ platform: "win32" }),
		});
		expect(status).toBe("running");
	});
});

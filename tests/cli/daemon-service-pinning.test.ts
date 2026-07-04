/**
 * PRD-072d — pinning the resolved fleet root (`APIARY_HOME`) into every rendered service unit.
 *
 * A service manager starts the daemon with its own environment; without the pin an
 * `APIARY_HOME`/`--home=`/XDG choice made at install time would silently not apply at runtime (and
 * the Windows LocalSystem opt-in would resolve `os.homedir()` to `System32`). The renderers pin the
 * RESOLVED root beside the existing `HONEYCOMB_WORKSPACE`, the schtasks path passes the same
 * cmd-metacharacter guard, and the macOS path XML-escapes it.
 */

import { describe, expect, it } from "vitest";

import {
	buildSchtasksCreateArgs,
	renderLaunchdPlist,
	renderSystemdUnit,
	type ServiceSpec,
} from "../../src/cli/daemon-service.js";
import { APIARY_HOME_ENV, resolveFleetRoot } from "../../src/shared/fleet-root.js";

const SPEC: ServiceSpec = {
	nodePath: "/usr/local/bin/node",
	entry: "/opt/honeycomb/daemon/index.js",
	nodeFlags: ["--experimental-sqlite"],
	workspace: "/home/ada/.apiary/honeycomb",
	home: "/home/ada",
	fleetRoot: "/home/ada/.apiary",
};

const WIN_SPEC: ServiceSpec = {
	nodePath: "C:\\Program Files\\nodejs\\node.exe",
	entry: "C:\\Users\\ada\\hc\\daemon\\index.js",
	nodeFlags: ["--experimental-sqlite"],
	workspace: "C:\\Users\\ada\\hc",
	home: "C:\\Users\\ada",
	fleetRoot: "C:\\Users\\ada\\.apiary",
};

describe("PRD-072d AC-072d.1.1 — every rendered unit pins APIARY_HOME beside HONEYCOMB_WORKSPACE", () => {
	it("AC-072d.1.1 launchd plist carries the APIARY_HOME env key + resolved-root value", () => {
		const plist = renderLaunchdPlist(SPEC);
		expect(plist).toContain(`<key>${APIARY_HOME_ENV}</key>`);
		expect(plist).toContain("<string>/home/ada/.apiary</string>");
		expect(plist).toContain("<key>HONEYCOMB_WORKSPACE</key>");
	});

	it("AC-072d.1.1 systemd unit carries Environment=APIARY_HOME beside HONEYCOMB_WORKSPACE", () => {
		const unit = renderSystemdUnit(SPEC);
		expect(unit).toContain(`Environment=${APIARY_HOME_ENV}="/home/ada/.apiary"`);
		expect(unit).toContain("Environment=HONEYCOMB_WORKSPACE=/home/ada/.apiary/honeycomb");
	});

	it("AC-072d.1.1 schtasks /TR sets APIARY_HOME beside HONEYCOMB_WORKSPACE", () => {
		const args = buildSchtasksCreateArgs(WIN_SPEC);
		const tr = args[args.indexOf("/TR") + 1] ?? "";
		expect(tr).toContain(`set ${APIARY_HOME_ENV}=C:\\Users\\ada\\.apiary`);
		expect(tr).toContain("set HONEYCOMB_WORKSPACE=C:\\Users\\ada\\hc");
	});

	it("with no fleetRoot pinned, the renderers omit the env line (back-compat, pin decided by caller)", () => {
		const bare: ServiceSpec = { ...SPEC, fleetRoot: undefined };
		expect(renderLaunchdPlist(bare)).not.toContain(APIARY_HOME_ENV);
		expect(renderSystemdUnit(bare)).not.toContain(APIARY_HOME_ENV);
	});
});

describe("PRD-072d AC-072d.1.2 — a changed root produces a changed pin", () => {
	it("AC-072d.1.2 re-rendering with a different fleetRoot changes the pinned value", () => {
		const a = renderSystemdUnit(SPEC);
		const b = renderSystemdUnit({ ...SPEC, fleetRoot: "/mnt/vol/apiary" });
		expect(a).not.toBe(b);
		expect(b).toContain(`Environment=${APIARY_HOME_ENV}="/mnt/vol/apiary"`);
	});
});

describe("PRD-072d AC-072d.2 — poisoned roots never reach a unit", () => {
	it("AC-072d.2.1 a cmd-metacharacter fleetRoot is refused on Windows (schtasks /TR)", () => {
		const poisoned: ServiceSpec = { ...WIN_SPEC, fleetRoot: "C:\\x & calc.exe" };
		expect(() => buildSchtasksCreateArgs(poisoned)).toThrow();
	});

	it("AC-072d.2.2 an XML-significant fleetRoot is escaped by the plist renderer on macOS", () => {
		const spec: ServiceSpec = { ...SPEC, fleetRoot: "/home/ada/a&b/apiary" };
		const plist = renderLaunchdPlist(spec);
		expect(plist).toContain("/home/ada/a&amp;b/apiary");
		expect(plist).not.toContain("<string>/home/ada/a&b/apiary</string>");
	});
});

describe("PRD-072d AC-072d.3.1 — LocalSystem never resolves under System32 when the pin is present", () => {
	it("AC-072d.3.1 a pinned APIARY_HOME wins over the ambient (System32) home at resolution time", () => {
		// Simulate the LocalSystem account: os.homedir() would be System32\config\systemprofile.
		const system32Home = "C:\\WINDOWS\\system32\\config\\systemprofile";
		const pinned = "C:\\Users\\ada\\.apiary";
		const resolved = resolveFleetRoot({
			env: { [APIARY_HOME_ENV]: pinned } as NodeJS.ProcessEnv,
			platform: "win32",
			home: system32Home,
		});
		expect(resolved).toBe(pinned);
		expect(resolved).not.toContain("system32");
	});
});

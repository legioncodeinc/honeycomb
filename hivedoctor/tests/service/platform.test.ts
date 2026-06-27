/**
 * Service-plan resolution tests (PRD-064b): correct manager per platform, userland
 * default scope, and the AC-064b.6 unprivileged -> userland fallback ordering.
 */

import { describe, expect, it } from "vitest";

import {
	normalizePlatform,
	resolveServicePlan,
	SERVICE_LABEL,
	SYSTEMD_UNIT_NAME,
} from "../../src/service/platform.js";
import { fixedEnv } from "./helpers.js";

describe("resolveServicePlan - manager + scope per platform", () => {
	it("macOS unprivileged -> launchd LaunchAgent at user scope", () => {
		const plan = resolveServicePlan(fixedEnv({ platform: "darwin", home: "/Users/t" }));
		expect(plan.manager).toBe("launchd");
		expect(plan.scope).toBe("user");
		expect(plan.unitPath).toBe(`/Users/t/Library/LaunchAgents/${SERVICE_LABEL}.plist`);
		expect(plan.fellBackToUser).toBe(false);
	});

	it("Linux unprivileged -> systemd --user unit at user scope", () => {
		const plan = resolveServicePlan(fixedEnv({ platform: "linux", home: "/home/t" }));
		expect(plan.manager).toBe("systemd");
		expect(plan.scope).toBe("user");
		expect(plan.unitPath).toBe(`/home/t/.config/systemd/user/${SYSTEMD_UNIT_NAME}`);
	});

	it("Windows default -> per-user Scheduled Task (schtasks), no admin", () => {
		const plan = resolveServicePlan(fixedEnv({ platform: "win32", home: "C:\\Users\\t" }));
		expect(plan.manager).toBe("schtasks");
		expect(plan.scope).toBe("user");
		// schtasks registers via the API, not a file we own - unitPath is empty until staged.
		expect(plan.unitPath).toBe("");
	});
});

describe("AC-064b.6 - unprivileged falls back to userland rather than failing", () => {
	it("system requested but unprivileged -> user scope, fellBackToUser flagged", () => {
		const plan = resolveServicePlan(
			fixedEnv({ platform: "linux", home: "/home/t", privileged: false, preferSystemScope: true }),
		);
		expect(plan.scope).toBe("user");
		expect(plan.fellBackToUser).toBe(true);
		expect(plan.manager).toBe("systemd");
	});

	it("system requested AND privileged -> system scope honored", () => {
		const plan = resolveServicePlan(
			fixedEnv({ platform: "linux", privileged: true, preferSystemScope: true }),
		);
		expect(plan.scope).toBe("system");
		expect(plan.fellBackToUser).toBe(false);
		expect(plan.unitPath).toBe(`/etc/systemd/system/${SYSTEMD_UNIT_NAME}`);
	});

	it("Windows system scope (enterprise opt-in) -> sc service, not schtasks", () => {
		const plan = resolveServicePlan(
			fixedEnv({ platform: "win32", privileged: true, preferSystemScope: true }),
		);
		expect(plan.scope).toBe("system");
		expect(plan.manager).toBe("sc");
	});

	it("privileged but NOT opted in -> still user scope (least-surprise default)", () => {
		const plan = resolveServicePlan(fixedEnv({ platform: "darwin", privileged: true }));
		expect(plan.scope).toBe("user");
		expect(plan.fellBackToUser).toBe(false);
	});
});

describe("normalizePlatform", () => {
	it("accepts the three supported platforms and rejects others", () => {
		expect(normalizePlatform("darwin")).toBe("darwin");
		expect(normalizePlatform("linux")).toBe("linux");
		expect(normalizePlatform("win32")).toBe("win32");
		expect(normalizePlatform("aix")).toBeNull();
		expect(normalizePlatform("freebsd")).toBeNull();
	});

	it("resolveServicePlan throws a clean message on an unsupported platform", () => {
		expect(() => resolveServicePlan(fixedEnv({ platform: "sunos" }))).toThrow(/unsupported platform/);
	});
});

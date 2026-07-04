/**
 * PRD-072a US-072a.1 — the ONE fleet-root resolution helper (`src/shared/fleet-root.ts`).
 *
 * Proves the canonical ADR-0003 precedence chain (APIARY_HOME > $XDG_STATE_HOME/apiary on Linux only
 * when explicitly set > `<home>/.apiary`), the honeycomb-subdir + fleet-file joins, the cwd
 * independence guard, and the new-first-legacy-second read selection. Every case drives the injectable
 * env / platform / home seams — nothing touches the real machine.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	APIARY_HOME_ENV,
	APIARY_ROOT_DIR_NAME,
	fleetRootFile,
	honeycombStateDir,
	legacyHoneycombDir,
	LEGACY_FLEET_DIR_NAME,
	preferExistingPath,
	resolveFleetRoot,
	XDG_STATE_HOME_ENV,
} from "../../src/shared/fleet-root.js";

const HOME = "/home/ada";

describe("PRD-072a AC-072a.1.1 — APIARY_HOME wins over XDG and the home default", () => {
	it("AC-072a.1.1 returns APIARY_HOME verbatim when it is set and non-blank", () => {
		const env = { [APIARY_HOME_ENV]: "/mnt/state/apiary", [XDG_STATE_HOME_ENV]: "/xdg" };
		expect(resolveFleetRoot({ env, platform: "linux", home: HOME })).toBe("/mnt/state/apiary");
		expect(resolveFleetRoot({ env, platform: "win32", home: HOME })).toBe("/mnt/state/apiary");
	});

	it("AC-072a.1.1 a blank / whitespace-only APIARY_HOME does NOT win (falls through the chain)", () => {
		expect(resolveFleetRoot({ env: { [APIARY_HOME_ENV]: "" }, platform: "darwin", home: HOME })).toBe(
			join(HOME, APIARY_ROOT_DIR_NAME),
		);
		expect(resolveFleetRoot({ env: { [APIARY_HOME_ENV]: "   " }, platform: "darwin", home: HOME })).toBe(
			join(HOME, APIARY_ROOT_DIR_NAME),
		);
	});

	it("a RELATIVE APIARY_HOME is ignored (never anchors state on process.cwd())", () => {
		// A relative root would resolve against the service manager's cwd (the System32 / `/` footgun
		// ADR-0003 closes); the resolver must fall through the chain instead of honoring it.
		expect(resolveFleetRoot({ env: { [APIARY_HOME_ENV]: "apiary" }, platform: "linux", home: HOME })).toBe(
			join(HOME, APIARY_ROOT_DIR_NAME),
		);
		expect(resolveFleetRoot({ env: { [APIARY_HOME_ENV]: "./state/apiary" }, platform: "darwin", home: HOME })).toBe(
			join(HOME, APIARY_ROOT_DIR_NAME),
		);
		// win32: a drive-relative value (`C:foo`) is not absolute either.
		expect(resolveFleetRoot({ env: { [APIARY_HOME_ENV]: "C:apiary" }, platform: "win32", home: HOME })).toBe(
			join(HOME, APIARY_ROOT_DIR_NAME),
		);
	});

	it("a RELATIVE XDG_STATE_HOME is ignored per the XDG Base Directory spec", () => {
		expect(resolveFleetRoot({ env: { [XDG_STATE_HOME_ENV]: "state" }, platform: "linux", home: HOME })).toBe(
			join(HOME, APIARY_ROOT_DIR_NAME),
		);
	});
});

describe("PRD-072a AC-072a.1.2 — XDG_STATE_HOME on Linux only when explicitly set", () => {
	it("AC-072a.1.2 Linux with XDG_STATE_HOME set → `$XDG_STATE_HOME/apiary`", () => {
		expect(resolveFleetRoot({ env: { [XDG_STATE_HOME_ENV]: "/xdg/state" }, platform: "linux", home: HOME })).toBe(
			join("/xdg/state", "apiary"),
		);
	});

	it("AC-072a.1.2 Linux with XDG_STATE_HOME UNSET → `<home>/.apiary` (no ~/.local/state default)", () => {
		expect(resolveFleetRoot({ env: {}, platform: "linux", home: HOME })).toBe(join(HOME, APIARY_ROOT_DIR_NAME));
	});

	it("AC-072a.1.2 darwin / win32 skip the XDG leg entirely even when XDG_STATE_HOME is set", () => {
		const env = { [XDG_STATE_HOME_ENV]: "/xdg/state" };
		expect(resolveFleetRoot({ env, platform: "darwin", home: HOME })).toBe(join(HOME, APIARY_ROOT_DIR_NAME));
		expect(resolveFleetRoot({ env, platform: "win32", home: HOME })).toBe(join(HOME, APIARY_ROOT_DIR_NAME));
	});
});

describe("PRD-072a AC-072a.1.3 — the root is anchored on home, never process.cwd()", () => {
	it("AC-072a.1.3 the resolved root is independent of the working directory", () => {
		// Two identical resolutions regardless of what cwd is: the resolver never reads process.cwd().
		const a = resolveFleetRoot({ env: {}, platform: "linux", home: HOME });
		const b = resolveFleetRoot({ env: {}, platform: "linux", home: HOME });
		expect(a).toBe(b);
		expect(a).toBe(join(HOME, APIARY_ROOT_DIR_NAME));
		// The default home anchor is os.homedir()-derived, and the result contains no cwd segment.
		expect(a).not.toContain(process.cwd());
	});
});

describe("PRD-072a — subdir / fleet-file / legacy joins", () => {
	it("honeycombStateDir joins the honeycomb product subdir under the resolved root", () => {
		expect(honeycombStateDir({ env: {}, platform: "linux", home: HOME })).toBe(
			join(HOME, APIARY_ROOT_DIR_NAME, "honeycomb"),
		);
	});

	it("fleetRootFile joins a shared file name at the fleet root itself (registry.json, device.json)", () => {
		expect(fleetRootFile("registry.json", { env: {}, platform: "linux", home: HOME })).toBe(
			join(HOME, APIARY_ROOT_DIR_NAME, "registry.json"),
		);
	});

	it("legacyHoneycombDir resolves `<home>/.honeycomb` for compatibility-window fallbacks", () => {
		expect(legacyHoneycombDir(HOME)).toBe(join(HOME, LEGACY_FLEET_DIR_NAME));
	});
});

describe("preferExistingPath — new-first, legacy-second, else new (creation target)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "hc-fleet-root-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns the new path when it exists", () => {
		const newP = join(dir, "new.json");
		const legacyP = join(dir, "legacy.json");
		writeFileSync(newP, "n");
		writeFileSync(legacyP, "l");
		expect(preferExistingPath(newP, legacyP)).toBe(newP);
	});

	it("falls back to the legacy path when only it exists", () => {
		const newP = join(dir, "sub", "new.json");
		const legacyP = join(dir, "legacy.json");
		mkdirSync(join(dir, "sub"), { recursive: true });
		writeFileSync(legacyP, "l");
		expect(existsSync(newP)).toBe(false);
		expect(preferExistingPath(newP, legacyP)).toBe(legacyP);
	});

	it("returns the new path (creation target) when neither exists", () => {
		const newP = join(dir, "new.json");
		const legacyP = join(dir, "legacy.json");
		expect(preferExistingPath(newP, legacyP)).toBe(newP);
	});
});

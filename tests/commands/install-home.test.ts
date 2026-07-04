/**
 * PRD-072d — the installer's `--home=` pin is recorded by delivering it as `APIARY_HOME` in the
 * process environment (fleet ADR Resolved decision: no config.json recording step). Once set, every
 * downstream fleet-root resolution in the run agrees (registry entry, service-unit pin, spawned
 * daemon), and the resolver picks it up.
 */

import { isAbsolute, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { applyHomeOverride, parseHomeArg } from "../../src/commands/install.js";
import { APIARY_HOME_ENV, resolveFleetRoot } from "../../src/shared/fleet-root.js";

describe("PRD-072d — parseHomeArg extracts the --home pin in both syntaxes", () => {
	it("parses `--home <path>` and `--home=<path>`, else undefined", () => {
		expect(parseHomeArg(["--home", "/mnt/state"])).toBe("/mnt/state");
		expect(parseHomeArg(["--home=/mnt/state"])).toBe("/mnt/state");
		expect(parseHomeArg(["--ref", "mario"])).toBeUndefined();
		expect(parseHomeArg([])).toBeUndefined();
	});
});

describe("PRD-072d — applyHomeOverride delivers the pin as APIARY_HOME so the resolver honors it", () => {
	it("sets APIARY_HOME on the provided env and the resolver then returns it", () => {
		const env = {} as NodeJS.ProcessEnv;
		applyHomeOverride(["install", "--home=/mnt/vol/apiary"], env);
		expect(env[APIARY_HOME_ENV]).toBe("/mnt/vol/apiary");
		expect(resolveFleetRoot({ env, platform: "linux", home: "/home/ada" })).toBe("/mnt/vol/apiary");
	});

	it("leaves the env untouched when no --home is given", () => {
		const env = {} as NodeJS.ProcessEnv;
		applyHomeOverride(["install", "--ref", "mario"], env);
		expect(env[APIARY_HOME_ENV]).toBeUndefined();
	});

	it("resolves a RELATIVE --home against the installer's cwd (the resolver honors absolute roots only)", () => {
		const env = {} as NodeJS.ProcessEnv;
		applyHomeOverride(["install", "--home=./apiary-state"], env);
		const pinned = env[APIARY_HOME_ENV];
		expect(pinned).toBe(resolve("./apiary-state"));
		expect(pinned === undefined ? false : isAbsolute(pinned)).toBe(true);
	});
});

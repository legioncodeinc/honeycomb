/**
 * The globally-installed-package version reader (PRD-064e auto-update "installed" source).
 *
 * "Installed" for auto-update means the GLOBALLY-INSTALLED npm PACKAGE version (`npm ls -g`),
 * NOT the running daemon's `/health` version -- the package is on disk even when the daemon is
 * down, which is exactly when a repair/update is wanted. Every test drives the reader through a
 * FAKE command runner: NO test runs npm. Fail-soft: any error / non-parseable body / missing
 * key resolves to null, never a throw.
 */

import { describe, expect, it } from "vitest";

import type { CommandResult, CommandRunner } from "../../src/rungs/command-runner.js";
import {
	createInstalledPackageVersionReader,
	parseInstalledVersion,
} from "../../src/update/installed-version.js";
import { createFakeRunner } from "../helpers/fake-runner.js";

const PKG = "@legioncodeinc/honeycomb";

/** A canned `npm ls -g <pkg> --depth=0 --json` happy-path body reporting `version`. */
function npmLsJson(pkg: string, version: string): string {
	return JSON.stringify({
		name: "-g",
		dependencies: { [pkg]: { version, resolved: "" } },
	});
}

/** A runner that returns a fixed {@link CommandResult} for every call (records argv). */
function runnerReturning(result: CommandResult): CommandRunner {
	return createFakeRunner(() => result);
}

describe("parseInstalledVersion", () => {
	it("extracts dependencies[pkg].version from an npm ls --json body", () => {
		expect(parseInstalledVersion(npmLsJson(PKG, "0.1.8"), PKG)).toBe("0.1.8");
	});

	it("trims surrounding whitespace on the version", () => {
		expect(parseInstalledVersion(npmLsJson(PKG, "  0.1.8  "), PKG)).toBe("0.1.8");
	});

	it("returns null for non-JSON", () => {
		expect(parseInstalledVersion("not json at all", PKG)).toBeNull();
	});

	it("returns null when dependencies is missing entirely", () => {
		expect(parseInstalledVersion(JSON.stringify({ name: "-g" }), PKG)).toBeNull();
	});

	it("returns null when the package key is absent from dependencies", () => {
		expect(parseInstalledVersion(JSON.stringify({ dependencies: { other: { version: "1.0.0" } } }), PKG)).toBeNull();
	});

	it("returns null when the version key is absent or empty", () => {
		expect(parseInstalledVersion(JSON.stringify({ dependencies: { [PKG]: {} } }), PKG)).toBeNull();
		expect(parseInstalledVersion(JSON.stringify({ dependencies: { [PKG]: { version: "" } } }), PKG)).toBeNull();
	});
});

describe("createInstalledPackageVersionReader (fail-soft)", () => {
	it("runs `npm ls -g <pkg> --depth=0 --json` and returns the parsed version (happy path)", async () => {
		const runner = createFakeRunner(() => ({ ok: true, code: 0, stdout: npmLsJson(PKG, "0.1.8"), stderr: "" }));
		const read = createInstalledPackageVersionReader({ runner, pkg: PKG });

		expect(await read()).toBe("0.1.8");
		expect((runner as ReturnType<typeof createFakeRunner>).calls).toEqual([
			{ command: "npm", args: ["ls", "-g", PKG, "--depth=0", "--json"] },
		]);
	});

	it("still parses the version when npm ls exits NON-ZERO but prints valid JSON (tree warnings)", async () => {
		// `npm ls` exits 1 on extraneous/missing-peer warnings yet still emits the version. We must
		// NOT gate parsing on result.ok, or a healthy-but-noisy tree would read as "installed unknown".
		const runner = runnerReturning({ ok: false, code: 1, stdout: npmLsJson(PKG, "0.1.8"), stderr: "npm warn", detail: "1" });
		const read = createInstalledPackageVersionReader({ runner, pkg: PKG });
		expect(await read()).toBe("0.1.8");
	});

	it("fails soft to null on garbled JSON stdout", async () => {
		const runner = runnerReturning({ ok: true, code: 0, stdout: "{ not: valid", stderr: "" });
		const read = createInstalledPackageVersionReader({ runner, pkg: PKG });
		expect(await read()).toBeNull();
	});

	it("fails soft to null when the dependency key is missing from the JSON", async () => {
		const runner = runnerReturning({ ok: true, code: 0, stdout: JSON.stringify({ dependencies: {} }), stderr: "" });
		const read = createInstalledPackageVersionReader({ runner, pkg: PKG });
		expect(await read()).toBeNull();
	});

	it("fails soft to null on a spawn failure (ENOENT, npm not on PATH)", async () => {
		const runner = runnerReturning({ ok: false, code: null, stdout: "", stderr: "", detail: "ENOENT" });
		const read = createInstalledPackageVersionReader({ runner, pkg: PKG });
		expect(await read()).toBeNull();
	});

	it("fails soft to null when the runner itself throws (defensive; the real runner never does)", async () => {
		const throwingRunner: CommandRunner = {
			async run(): Promise<CommandResult> {
				throw new Error("runner exploded");
			},
		};
		const read = createInstalledPackageVersionReader({ runner: throwingRunner, pkg: PKG });
		expect(await read()).toBeNull();
	});

	it("forwards the timeout to the runner when provided", async () => {
		let seenTimeout: number | undefined;
		const runner: CommandRunner = {
			async run(_command, _args, options): Promise<CommandResult> {
				seenTimeout = options?.timeoutMs;
				return { ok: true, code: 0, stdout: npmLsJson(PKG, "0.1.8"), stderr: "" };
			},
		};
		const read = createInstalledPackageVersionReader({ runner, pkg: PKG, timeoutMs: 9_000 });
		await read();
		expect(seenTimeout).toBe(9_000);
	});
});

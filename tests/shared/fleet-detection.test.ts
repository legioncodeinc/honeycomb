/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * PRD-003a a-AC-6 — the solo-vs-fleet classifier is deterministic and its inputs (which signals
 * fired) are visible for supportability.
 *
 * Every signal is injected so the classification is driven with NO network, NO real home, and NO
 * `npm` subprocess. Proves: ANY signal fired => FLEET; none => SOLO; the fired signals are recorded;
 * and the log line names the evidence. Also exercises the default S1 registry reader against a temp
 * home (both the fleet-root and legacy files).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	classifyFleet,
	defaultNpmGlobalHasHive,
	defaultReadRegistrySignal,
	type ExecFileLike,
	fleetSignalLine,
	HIVE_NPM_PACKAGE,
	WINDOWS_NPM_HIVE_COMMAND,
} from "../../src/shared/fleet-detection.js";

/** A no-signal seam set: every signal explicitly false (the pure-solo baseline). */
const NONE = {
	readRegistrySignal: () => false,
	probeHivePort: async () => false,
	npmGlobalHasHive: async () => false,
};

describe("PRD-003a a-AC-6 — classifyFleet is deterministic and records which signals fired", () => {
	it("a-AC-6 no signals fired => SOLO with an empty firedSignals list", async () => {
		const c = await classifyFleet(NONE);
		expect(c.mode).toBe("solo");
		expect(c.firedSignals).toEqual([]);
		expect(c.signals).toEqual({ registryHiveEntry: false, hivePortAnswering: false, hiveNpmGlobal: false });
	});

	it("a-AC-6 the registry signal alone => FLEET (any signal wins) and is named in firedSignals", async () => {
		const c = await classifyFleet({ ...NONE, readRegistrySignal: () => true });
		expect(c.mode).toBe("fleet");
		expect(c.signals.registryHiveEntry).toBe(true);
		expect(c.firedSignals.join(" ")).toMatch(/registry/i);
	});

	it("a-AC-6 the live-port signal alone => FLEET and is named in firedSignals", async () => {
		const c = await classifyFleet({ ...NONE, probeHivePort: async () => true });
		expect(c.mode).toBe("fleet");
		expect(c.signals.hivePortAnswering).toBe(true);
		expect(c.firedSignals.join(" ")).toMatch(/3853/);
	});

	it("a-AC-6 the npm-global signal alone => FLEET and names the package", async () => {
		const c = await classifyFleet({ ...NONE, npmGlobalHasHive: async () => true });
		expect(c.mode).toBe("fleet");
		expect(c.signals.hiveNpmGlobal).toBe(true);
		expect(c.firedSignals.join(" ")).toContain(HIVE_NPM_PACKAGE);
	});

	it("a-AC-6 all three fired => FLEET, all three named, deterministic across repeated calls", async () => {
		const all = { readRegistrySignal: () => true, probeHivePort: async () => true, npmGlobalHasHive: async () => true };
		const first = await classifyFleet(all);
		const second = await classifyFleet(all);
		expect(first).toEqual(second); // deterministic for a fixed machine state
		expect(first.mode).toBe("fleet");
		expect(first.firedSignals).toHaveLength(3);
	});

	it("a-AC-6 fleetSignalLine surfaces the mode + the evidence for logs", async () => {
		const fleet = await classifyFleet({ ...NONE, probeHivePort: async () => true });
		expect(fleetSignalLine(fleet)).toMatch(/FLEET/);
		expect(fleetSignalLine(fleet)).toMatch(/3853/);
		const solo = await classifyFleet(NONE);
		expect(fleetSignalLine(solo)).toMatch(/SOLO/);
	});
});

describe("PRD-003a — the default S1 registry reader (both files, tolerant)", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "hc-fleet-detect-"));
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("reads a Hive entry from the fleet-root registry.json", () => {
		const apiary = join(home, ".apiary");
		mkdirSync(apiary, { recursive: true });
		writeFileSync(
			join(apiary, "registry.json"),
			JSON.stringify({ daemons: [{ name: "honeycomb" }, { name: "hive" }] }),
		);
		expect(defaultReadRegistrySignal({ home })).toBe(true);
	});

	it("reads a Hive entry from the LEGACY ~/.honeycomb/doctor.daemons.json too", () => {
		const legacy = join(home, ".honeycomb");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "doctor.daemons.json"), JSON.stringify({ daemons: [{ name: "hive" }] }));
		expect(defaultReadRegistrySignal({ home })).toBe(true);
	});

	it("returns false when no registry file names hive (missing files + a honeycomb-only registry)", () => {
		// No files at all → false.
		expect(defaultReadRegistrySignal({ home })).toBe(false);
		const apiary = join(home, ".apiary");
		mkdirSync(apiary, { recursive: true });
		writeFileSync(join(apiary, "registry.json"), JSON.stringify({ daemons: [{ name: "honeycomb" }] }));
		expect(defaultReadRegistrySignal({ home })).toBe(false);
	});

	it("a malformed registry file is a tolerant false, never a throw", () => {
		const apiary = join(home, ".apiary");
		mkdirSync(apiary, { recursive: true });
		writeFileSync(join(apiary, "registry.json"), "{ not valid json");
		expect(defaultReadRegistrySignal({ home })).toBe(false);
	});
});

describe("PRD-003a S3 — defaultNpmGlobalHasHive spawns npm per platform (mirrors nectar's contract)", () => {
	/** A recording ExecFileLike: captures the exact cmd/argv/options, replies with scripted output. */
	function recordingExec(reply: { err?: Error; stdout?: string } = {}): {
		exec: ExecFileLike;
		calls: Array<{ cmd: string; args: readonly string[]; shell: boolean; windowsHide: boolean; timeout: number }>;
	} {
		const calls: Array<{
			cmd: string;
			args: readonly string[];
			shell: boolean;
			windowsHide: boolean;
			timeout: number;
		}> = [];
		const exec: ExecFileLike = (cmd, args, options, callback) => {
			calls.push({ cmd, args, shell: options.shell, windowsHide: options.windowsHide, timeout: options.timeout });
			callback(reply.err ?? null, reply.stdout ?? "");
		};
		return { exec, calls };
	}

	it("win32 runs the constant npm.cmd command through fixed cmd.exe argv with shell:false", async () => {
		const { exec, calls } = recordingExec({ stdout: `C:\\npm\\global\n+-- ${HIVE_NPM_PACKAGE}@0.5.1\n` });
		const present = await defaultNpmGlobalHasHive({ platform: "win32", execFileImpl: exec });
		expect(present).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.cmd).toBe("cmd.exe");
		expect(calls[0]?.shell).toBe(false);
		expect(calls[0]?.args).toEqual(["/d", "/s", "/c", WINDOWS_NPM_HIVE_COMMAND]);
		expect(calls[0]?.windowsHide).toBe(true);
	});

	it.runIf(process.platform === "win32")("real Windows npm probe emits no DEP0190 warning", async () => {
		const warnings: string[] = [];
		const listener = (warning: Error & { code?: string }): void => {
			if (warning.code === "DEP0190" || warning.message.includes("shell option true")) warnings.push(warning.message);
		};
		process.on("warning", listener);
		try {
			await defaultNpmGlobalHasHive();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(warnings).toEqual([]);
		} finally {
			process.off("warning", listener);
		}
	});

	it("POSIX spawns bare npm with shell:false (never a shell where none is needed)", async () => {
		const { exec, calls } = recordingExec({ stdout: `/usr/lib\n+-- ${HIVE_NPM_PACKAGE}@0.5.1\n` });
		const present = await defaultNpmGlobalHasHive({ platform: "linux", execFileImpl: exec });
		expect(present).toBe(true);
		expect(calls[0]?.cmd).toBe("npm");
		expect(calls[0]?.shell).toBe(false);
	});

	it("an exec error (npm missing / package absent / timeout) resolves false, never a throw", async () => {
		const { exec } = recordingExec({ err: new Error("spawn npm ENOENT") });
		await expect(defaultNpmGlobalHasHive({ platform: "win32", execFileImpl: exec })).resolves.toBe(false);
	});

	it("npm exiting 0 WITHOUT naming the package resolves false (present only when named)", async () => {
		const { exec } = recordingExec({ stdout: "/usr/lib\n`-- (empty)\n" });
		await expect(defaultNpmGlobalHasHive({ platform: "linux", execFileImpl: exec })).resolves.toBe(false);
	});
});

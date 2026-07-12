/**
 * PRD-021b b-AC-5 — `honeycomb status` reports the real 020d D1–D5 health (not a placeholder).
 *
 * Proves the bound {@link StatusHealthSource}: it wraps the 020d `createHealthCheck` over the REAL
 * probe set, so `status` renders five D1–D5 dimensions whose results reflect the genuine
 * environment — and the D2 dimension reuses the loopback daemon client's `ping()`, so "is the
 * daemon up" is single-sourced with the storage path.
 */

import { describe, expect, it } from "vitest";

import { createFakeDaemonClient } from "../../src/commands/index.js";
import {
	buildHealthProbes,
	buildStatusHealthSource,
	probeCursorLogin,
	type CursorLoginSpawn,
	type CursorLoginSpawnResult,
} from "../../src/cli/health-probes.js";
import type { PluginCommandRunner } from "../../src/connectors/index.js";
import { runStatusCommand } from "../../src/commands/status.js";

/** A fake `claude plugin` runner so the D5 probe never shells to the real binary in these tests. */
function fakePluginRunner(enabled: boolean): PluginCommandRunner {
	return {
		available: () => enabled,
		run: () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
		isPluginEnabled: () => enabled,
	};
}

describe("PRD-021b b-AC-5 — status reports the real D1–D5 health", () => {
	it("b-AC-5 the bound health source evaluates five D1–D5 dimensions", async () => {
		const health = buildStatusHealthSource(createFakeDaemonClient({ alive: true }), fakePluginRunner(false));
		const lines = await health.evaluate();
		const ids = lines.map((l) => l.id);
		expect(ids).toEqual(["D1", "D2", "D3", "D4", "D5"]);
	});

	it("D5 (capture wired) reports HEALTHY when the Claude Code plugin is installed + enabled", async () => {
		const probes = buildHealthProbes(createFakeDaemonClient({ alive: true }), fakePluginRunner(true));
		const d5 = await probes.probeHooksWired();
		expect(d5.ok).toBe(true);
		expect(d5.detail).toMatch(/plugin installed \+ enabled/i);
	});

	it("D5 fails-soft (not healthy) when the plugin is NOT enabled and no Cursor hooks exist", async () => {
		const probes = buildHealthProbes(createFakeDaemonClient({ alive: true }), fakePluginRunner(false));
		const d5 = await probes.probeHooksWired();
		// On a box with no Cursor hooks.json and no enabled plugin, D5 is not healthy (surfaced, not green).
		expect(d5.ok === false || /Cursor hooks\.json/.test(d5.detail)).toBe(true);
	});

	it("b-AC-5 D2 reflects the real daemon reachability from the SAME loopback client (up)", async () => {
		const probes = buildHealthProbes(createFakeDaemonClient({ alive: true }));
		const d2 = await probes.probeDaemon();
		expect(d2.ok).toBe(true);
		expect(d2.detail).toMatch(/127\.0\.0\.1:3850/);
	});

	it("b-AC-5 D2 reflects the real daemon reachability (down)", async () => {
		const probes = buildHealthProbes(createFakeDaemonClient({ alive: false }));
		const d2 = await probes.probeDaemon();
		expect(d2.ok).toBe(false);
		expect(d2.detail).toMatch(/not reachable/);
	});

	it("b-AC-5 D1 reports the running CLI version (a real probe, not a placeholder)", async () => {
		const probes = buildHealthProbes(createFakeDaemonClient({ alive: true }));
		const d1 = await probes.probeCli();
		expect(d1.ok).toBe(true);
		expect(d1.detail).toMatch(/^v/);
	});

	it("ISS-017 D4 actually RUNS `cursor-agent status` (no more unconditional stub)", async () => {
		const calls: { command: string; args: readonly string[] }[] = [];
		const spawn: CursorLoginSpawn = (command, args) => {
			calls.push({ command, args });
			return { status: 0, stdout: "Logged in as dev@acme.com\n" };
		};
		probeCursorLogin(spawn);
		expect(calls).toEqual([{ command: "cursor-agent", args: ["status"] }]);
	});

	it("ISS-017 D4 parses a logged-in status line → ok:true with the account", () => {
		const spawn: CursorLoginSpawn = () => ({ status: 0, stdout: "Logged in as dev@acme.com\n" });
		const d4 = probeCursorLogin(spawn);
		expect(d4.ok).toBe(true);
		expect(d4.detail).toBe("logged in as dev@acme.com");
	});

	it("ISS-017 D4 a logged-in line WITHOUT an account still reports ok:true", () => {
		const spawn: CursorLoginSpawn = () => ({ status: 0, stdout: "Status: logged in\n" });
		const d4 = probeCursorLogin(spawn);
		expect(d4.ok).toBe(true);
		expect(d4.detail).toBe("logged in");
	});

	it("ISS-017 D4 'Not logged in' → ok:false with the actionable login hint (never a false green)", () => {
		const spawn: CursorLoginSpawn = () => ({ status: 1, stdout: "Not logged in.\n" });
		const d4 = probeCursorLogin(spawn);
		expect(d4.ok).toBe(false);
		expect(d4.detail).toMatch(/not logged in/i);
		expect(d4.detail).toMatch(/cursor-agent login/);
	});

	it("ISS-017 D4 a missing binary (ENOENT) soft-fails as 'login state unknown' — never a crash", () => {
		const enoent: CursorLoginSpawnResult = { status: null, error: Object.assign(new Error("spawn cursor-agent ENOENT"), { code: "ENOENT" }) };
		const d4 = probeCursorLogin(() => enoent);
		expect(d4.ok).toBe(false);
		expect(d4.detail).toMatch(/login state unknown/);
		expect(d4.detail).toMatch(/ENOENT/);
	});

	it("ISS-017 D4 a hung agent (spawn timeout) soft-fails as 'login state unknown'", () => {
		const timedOut: CursorLoginSpawnResult = { status: null, error: Object.assign(new Error("spawnSync cursor-agent ETIMEDOUT"), { code: "ETIMEDOUT" }) };
		const d4 = probeCursorLogin(() => timedOut);
		expect(d4.ok).toBe(false);
		expect(d4.detail).toMatch(/login state unknown/);
	});

	it("ISS-017 D4 a throwing spawn seam is caught and soft-fails (err instanceof Error narrowing)", () => {
		const d4 = probeCursorLogin(() => {
			throw new Error("boom");
		});
		expect(d4.ok).toBe(false);
		expect(d4.detail).toMatch(/login state unknown \(boom\)/);
	});

	it("ISS-017 D4 unrecognized output soft-fails as unknown (not a false green, not a crash)", () => {
		const spawn: CursorLoginSpawn = () => ({ status: 2, stdout: "usage: cursor-agent <command>\n" });
		const d4 = probeCursorLogin(spawn);
		expect(d4.ok).toBe(false);
		expect(d4.detail).toMatch(/login state unknown/);
	});

	it("b-AC-5 `status` renders the real D1–D5 lines plus connectivity + login", async () => {
		const lines: string[] = [];
		await runStatusCommand({
			daemon: createFakeDaemonClient({ alive: true }),
			health: buildStatusHealthSource(createFakeDaemonClient({ alive: true }), fakePluginRunner(false)),
			loggedIn: false,
			out: (l) => lines.push(l),
		});
		const text = lines.join("\n");
		expect(text).toMatch(/daemon:/);
		expect(text).toMatch(/login:/);
		// All five dimensions are rendered.
		for (const id of ["D1", "D2", "D3", "D4", "D5"]) {
			expect(text).toContain(id);
		}
	});
});

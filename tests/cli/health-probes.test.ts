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
import { buildHealthProbes, buildStatusHealthSource } from "../../src/cli/health-probes.js";
import { runStatusCommand } from "../../src/commands/status.js";

describe("PRD-021b b-AC-5 — status reports the real D1–D5 health", () => {
	it("b-AC-5 the bound health source evaluates five D1–D5 dimensions", async () => {
		const health = buildStatusHealthSource(createFakeDaemonClient({ alive: true }));
		const lines = await health.evaluate();
		const ids = lines.map((l) => l.id);
		expect(ids).toEqual(["D1", "D2", "D3", "D4", "D5"]);
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

	it("b-AC-5 `status` renders the real D1–D5 lines plus connectivity + login", async () => {
		const lines: string[] = [];
		await runStatusCommand({
			daemon: createFakeDaemonClient({ alive: true }),
			health: buildStatusHealthSource(createFakeDaemonClient({ alive: true })),
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

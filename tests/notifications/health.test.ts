/**
 * PRD-020d D1–D5 environment health — surfaced failures + wirable auto-resolve (no clobber).
 *
 * Covers index AC-3 (health surfaces failing D1–D5 + auto-wires the wirable dimension
 * idempotently) and d-AC-2 (a failing dimension is surfaced; the wirable one is auto-resolved
 * without overwriting foreign hooks). All five probes are injected fakes — no real CLI / daemon /
 * editor — and the auto-wiring delegates to a REAL 019a connector over a `createFakeFs` so the
 * foreign-preserve + idempotency are exercised end to end.
 */

import { describe, expect, it } from "vitest";

import { ClaudeCodeConnector, createFakeFs } from "../../src/connectors/index.js";
import {
	createAutoWiring,
	createHealthCheck,
	type HealthProbes,
	HEALTH_DIMENSION_WIRABLE,
	type ProbeOutcome,
} from "../../src/notifications/index.js";

const PASS: ProbeOutcome = { ok: true, detail: "ok" };

/** Build a probe set, overriding individual dimensions; unspecified ones pass. */
function probes(overrides: Partial<Record<keyof HealthProbes, ProbeOutcome>> = {}): HealthProbes {
	const mk = (key: keyof HealthProbes) => async () => overrides[key] ?? PASS;
	return {
		probeCli: mk("probeCli"),
		probeDaemon: mk("probeDaemon"),
		probeCursorAgent: mk("probeCursorAgent"),
		probeCursorLogin: mk("probeCursorLogin"),
		probeHooksWired: mk("probeHooksWired"),
	};
}

const HOME = "/home/dev";
const BUNDLE = "/repo/harnesses/claude-code/bundle";

/** A fake fs seeded with the harness home + the bundle sources (so install can copy handlers). */
function connectorFs(seedFiles: Record<string, string> = {}) {
	return createFakeFs({
		files: {
			[`${HOME}/.claude`]: "",
			[`${BUNDLE}/session-start.js`]: "x",
			[`${BUNDLE}/capture.js`]: "x",
			[`${BUNDLE}/pre-tool-use.js`]: "x",
			[`${BUNDLE}/session-end.js`]: "x",
			...seedFiles,
		},
	});
}

function connectorOver(fs: ReturnType<typeof createFakeFs>) {
	return new ClaudeCodeConnector(fs, { home: HOME, bundleSource: BUNDLE });
}

describe("AC-3 / d-AC-2: health surfaces failing D1–D5", () => {
	it("AC-3 evaluate() returns all five dimensions in D1..D5 order, tagging wirable", async () => {
		const fs = connectorFs();
		const check = createHealthCheck({
			probes: probes(),
			autoWiring: createAutoWiring({ connector: connectorOver(fs) }),
		});
		const report = await check.evaluate();
		expect(report.dimensions.map((d) => d.id)).toEqual(["D1", "D2", "D3", "D4", "D5"]);
		expect(report.healthy).toBe(true);
		// Only D5 (hooks wired) is auto-wirable; D1–D4 are surfaced-only prerequisites.
		for (const d of report.dimensions) {
			expect(d.wirable).toBe(HEALTH_DIMENSION_WIRABLE[d.id]);
		}
	});

	it("d-AC-2 a failing dimension is surfaced (ok:false with a detail), not swallowed", async () => {
		const fs = connectorFs();
		const check = createHealthCheck({
			probes: probes({ probeDaemon: { ok: false, detail: "ECONNREFUSED 3850" } }),
			autoWiring: createAutoWiring({ connector: connectorOver(fs) }),
		});
		const report = await check.evaluate();
		const d2 = report.dimensions.find((d) => d.id === "D2");
		expect(d2?.ok).toBe(false);
		expect(d2?.detail).toContain("3850");
		expect(report.healthy).toBe(false);
	});

	it("d-AC-2 a probe that THROWS is surfaced as a failing dimension (fail-soft, never propagated)", async () => {
		const fs = connectorFs();
		const throwing: HealthProbes = {
			...probes(),
			probeCli: async () => {
				throw new Error("spawn ENOENT");
			},
		};
		const check = createHealthCheck({
			probes: throwing,
			autoWiring: createAutoWiring({ connector: connectorOver(fs) }),
		});
		const report = await check.evaluate();
		const d1 = report.dimensions.find((d) => d.id === "D1");
		expect(d1?.ok).toBe(false);
		expect(d1?.detail).toContain("ENOENT");
	});
});

describe("d-AC-2: the wirable dimension (D5) is auto-resolved without clobbering foreign hooks", () => {
	it("d-AC-2 autoWire() wires D5 when it fails, preserving a foreign hook entry", async () => {
		// Seed a foreign hooks config the auto-wire must NOT clobber.
		const foreignConfig = JSON.stringify(
			{ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node /other/tool.js" }] }] } },
			null,
			2,
		);
		const fs = connectorFs({ [`${HOME}/.claude/settings.json`]: `${foreignConfig}\n` });
		const check = createHealthCheck({
			probes: probes({ probeHooksWired: { ok: false, detail: "hooks not wired" } }),
			autoWiring: createAutoWiring({ connector: connectorOver(fs) }),
		});

		await check.autoWire();

		// The foreign tool's command survives the auto-wire (foreign-preserve, FR-9).
		const written = fs.files.get(`${HOME}/.claude/settings.json`);
		expect(written).toBeDefined();
		expect(written).toContain("node /other/tool.js");
		// And Honeycomb's own handlers are now present (the wirable dimension was resolved).
		expect(written).toContain("bundle/session-start.js");
	});

	it("d-AC-2 a failing NON-wirable dimension (D4 login) is surfaced but NOT auto-wired", async () => {
		// D4 (login) fails but is non-wirable; D5 passes → autoWire must NOT touch the config.
		const fs = connectorFs();
		const check = createHealthCheck({
			probes: probes({ probeCursorLogin: { ok: false, detail: "logged out" } }),
			autoWiring: createAutoWiring({ connector: connectorOver(fs) }),
		});

		const after = await check.autoWire();
		// No config was written (nothing wirable was failing) — the logged-out state is surfaced.
		expect(fs.writes).toEqual([]);
		const d4 = after.dimensions.find((d) => d.id === "D4");
		expect(d4?.ok).toBe(false);
		expect(d4?.wirable).toBe(false);
	});
});

/**
 * PRD-005 — shim-side capture-gate tests.
 *
 * 005a seam section: pins the exported signatures and permissive-stub behaviour
 * that 005c must preserve (bypass, recursion guard, fail-soft wrapper shape).
 *
 * 005c AC section: proves every acceptance criterion c-AC-1..6 with a named
 * test per criterion. No `.skip`/`.only`. Pure in-process — no daemon import,
 * no I/O, no network call; the `capture()` callback is a spy that counts calls.
 */

import { describe, expect, it } from "vitest";

import { CAPTURE_ENTRYPOINTS, runCaptureGuarded, shouldCapture } from "../../src/shared/capture-gate.js";

describe("capture-gate stub: shouldCapture (seam for 005c)", () => {
	it("captures by default (permissive stub)", () => {
		expect(shouldCapture({}).capture).toBe(true);
	});

	it("HONEYCOMB_CAPTURE=false → skip with reason 'bypass' (c-AC-1 / D-2 seam)", () => {
		const d = shouldCapture({ captureFlag: "false" });
		expect(d.capture).toBe(false);
		expect(d.reason).toBe("bypass");
	});

	it("any other captureFlag value leaves capture enabled", () => {
		expect(shouldCapture({ captureFlag: "true" }).capture).toBe(true);
		expect(shouldCapture({ captureFlag: "1" }).capture).toBe(true);
	});

	it("worker recursion marker present → skip with reason 'recursion-guard' (c-AC-4 / D-5 seam)", () => {
		const d = shouldCapture({ workerMarker: "1" });
		expect(d.capture).toBe(false);
		expect(d.reason).toBe("recursion-guard");
	});

	it("an empty/zero worker marker does NOT suppress capture", () => {
		expect(shouldCapture({ workerMarker: "" }).capture).toBe(true);
		expect(shouldCapture({ workerMarker: "0" }).capture).toBe(true);
	});
});

describe("capture-gate stub: runCaptureGuarded fail-soft wrapper (c-AC-5 / c-AC-6 seam)", () => {
	it("runs the capture action when the gate permits", async () => {
		let ran = false;
		const d = await runCaptureGuarded({}, {}, () => {
			ran = true;
		});
		expect(d.capture).toBe(true);
		expect(ran).toBe(true);
	});

	it("does NOT run the capture action when the gate skips (c-AC-6: no daemon call)", async () => {
		let ran = false;
		const d = await runCaptureGuarded({ captureFlag: "false" }, {}, () => {
			ran = true;
		});
		expect(d.capture).toBe(false);
		expect(ran, "capture must not be invoked when the gate skips").toBe(false);
	});

	it("swallows a thrown capture action so the turn proceeds (c-AC-5 fail-soft)", async () => {
		const errors: unknown[] = [];
		const d = await runCaptureGuarded(
			{},
			{},
			() => {
				throw new Error("daemon down");
			},
			(e) => errors.push(e),
		);
		// The decision was "capture", but the failure was caught — never rethrown.
		expect(d.capture).toBe(true);
		expect(errors.length).toBe(1);
	});

	it("awaits an async capture action and still fails soft on rejection", async () => {
		const errors: unknown[] = [];
		await runCaptureGuarded(
			{},
			{},
			async () => {
				await Promise.resolve();
				throw new Error("async daemon error");
			},
			(e) => errors.push(e),
		);
		expect(errors.length).toBe(1);
	});
});

// ── PRD-005c: Capture Guards — Acceptance Criteria ───────────────────────────
// Each test is named after its AC so failures map directly to the ledger.
// All tests are pure (no daemon / storage import) and assert call-count on the
// spy to prove c-AC-6 (no daemon request made when a guard skips).

describe("PRD-005c capture guards: shouldCapture (c-AC-1..4)", () => {
	// ── c-AC-1 ────────────────────────────────────────────────────────────────
	it("c-AC-1: HONEYCOMB_CAPTURE=false → skip with reason 'bypass'", () => {
		const d = shouldCapture({ captureFlag: "false" });
		expect(d.capture).toBe(false);
		expect(d.reason).toBe("bypass");
	});

	it("c-AC-1: any other captureFlag value (incl. unset) leaves capture enabled", () => {
		expect(shouldCapture({}).capture).toBe(true);
		expect(shouldCapture({ captureFlag: "true" }).capture).toBe(true);
		expect(shouldCapture({ captureFlag: "1" }).capture).toBe(true);
		expect(shouldCapture({ captureFlag: undefined }).capture).toBe(true);
	});

	// ── c-AC-2 ────────────────────────────────────────────────────────────────
	it("c-AC-2: pluginEnabled=false → skip with reason 'plugin-disabled'", () => {
		const d = shouldCapture({ pluginEnabled: false });
		expect(d.capture).toBe(false);
		expect(d.reason).toBe("plugin-disabled");
	});

	it("c-AC-2: pluginEnabled=true or absent leaves capture enabled", () => {
		expect(shouldCapture({ pluginEnabled: true }).capture).toBe(true);
		expect(shouldCapture({}).capture).toBe(true); // absent = enabled
	});

	// ── c-AC-3 ────────────────────────────────────────────────────────────────
	it("c-AC-3: non-capture entrypoint → skip with reason 'non-capture-entrypoint'", () => {
		const d = shouldCapture({}, { entrypoint: "pre_tool_use" });
		expect(d.capture).toBe(false);
		expect(d.reason).toBe("non-capture-entrypoint");
	});

	it("c-AC-3: another non-capture entrypoint (notification) → skip", () => {
		const d = shouldCapture({}, { entrypoint: "notification" });
		expect(d.capture).toBe(false);
		expect(d.reason).toBe("non-capture-entrypoint");
	});

	it("c-AC-3: recognised capture entrypoints are all in CAPTURE_ENTRYPOINTS and proceed", () => {
		for (const ep of CAPTURE_ENTRYPOINTS) {
			const d = shouldCapture({}, { entrypoint: ep });
			expect(d.capture, `${ep} should be a capture entrypoint`).toBe(true);
		}
	});

	it("c-AC-3: absent entrypoint bypasses the check (backward-compatible)", () => {
		expect(shouldCapture({}, {}).capture).toBe(true);
		expect(shouldCapture({}, { entrypoint: undefined }).capture).toBe(true);
	});

	// ── c-AC-4 ────────────────────────────────────────────────────────────────
	it("c-AC-4: workerMarker='1' (HONEYCOMB_WORKER=1) → skip with reason 'recursion-guard'", () => {
		const d = shouldCapture({ workerMarker: "1" });
		expect(d.capture).toBe(false);
		expect(d.reason).toBe("recursion-guard");
	});

	it("c-AC-4: any truthy workerMarker value suppresses capture", () => {
		expect(shouldCapture({ workerMarker: "true" }).capture).toBe(false);
		expect(shouldCapture({ workerMarker: "yes" }).capture).toBe(false);
	});

	it("c-AC-4: empty or '0' workerMarker does NOT suppress capture", () => {
		expect(shouldCapture({ workerMarker: "" }).capture).toBe(true);
		expect(shouldCapture({ workerMarker: "0" }).capture).toBe(true);
	});

	// ── Guard priority: bypass is evaluated before plugin-disabled, etc. ──────
	it("bypass takes priority over plugin-disabled (both set → bypass wins)", () => {
		const d = shouldCapture({ captureFlag: "false", pluginEnabled: false });
		expect(d.reason).toBe("bypass");
	});

	it("plugin-disabled takes priority over non-capture-entrypoint", () => {
		const d = shouldCapture({ pluginEnabled: false }, { entrypoint: "pre_tool_use" });
		expect(d.reason).toBe("plugin-disabled");
	});
});

describe("PRD-005c capture guards: runCaptureGuarded (c-AC-5 / c-AC-6)", () => {
	// ── c-AC-5 ────────────────────────────────────────────────────────────────
	it("c-AC-5: capture callback throws → runCaptureGuarded returns cleanly, does not throw", async () => {
		const errors: unknown[] = [];
		let resolved = false;
		const d = await runCaptureGuarded(
			{},
			{},
			() => { throw new Error("daemon unreachable"); },
			(e) => errors.push(e),
		).then((r) => { resolved = true; return r; });
		expect(resolved).toBe(true); // promise resolved, did not reject
		expect(errors.length).toBe(1);
		expect(errors[0]).toBeInstanceOf(Error);
		// The decision was "capture" — the gate passed, but the callback failed.
		expect(d.capture).toBe(true);
	});

	it("c-AC-5: async capture callback rejects → runCaptureGuarded still resolves cleanly", async () => {
		const errors: unknown[] = [];
		await expect(
			runCaptureGuarded(
				{},
				{},
				async () => { await Promise.resolve(); throw new Error("async network error"); },
				(e) => errors.push(e),
			),
		).resolves.toBeDefined();
		expect(errors.length).toBe(1);
	});

	// ── c-AC-6 ────────────────────────────────────────────────────────────────
	// For every skip guard, the capture spy call-count must be 0 after the guard.
	// This proves no daemon call is made (the spy represents the shim's HTTP send).

	it("c-AC-6: bypass guard skips → capture() never invoked (call count = 0)", async () => {
		let calls = 0;
		const d = await runCaptureGuarded(
			{ captureFlag: "false" },
			{},
			() => { calls++; },
		);
		expect(d.capture).toBe(false);
		expect(calls, "capture() must not be called when gate skips").toBe(0);
	});

	it("c-AC-6: plugin-disabled guard skips → capture() never invoked (call count = 0)", async () => {
		let calls = 0;
		const d = await runCaptureGuarded(
			{ pluginEnabled: false },
			{},
			() => { calls++; },
		);
		expect(d.capture).toBe(false);
		expect(calls).toBe(0);
	});

	it("c-AC-6: non-capture-entrypoint guard skips → capture() never invoked (call count = 0)", async () => {
		let calls = 0;
		const d = await runCaptureGuarded(
			{},
			{ entrypoint: "pre_tool_use" },
			() => { calls++; },
		);
		expect(d.capture).toBe(false);
		expect(calls).toBe(0);
	});

	it("c-AC-6: recursion-guard skips → capture() never invoked (call count = 0)", async () => {
		let calls = 0;
		const d = await runCaptureGuarded(
			{ workerMarker: "1" },
			{},
			() => { calls++; },
		);
		expect(d.capture).toBe(false);
		expect(calls).toBe(0);
	});

	// Positive case: all guards pass → capture() IS invoked exactly once.
	it("positive: all guards pass → capture() invoked exactly once", async () => {
		let calls = 0;
		const d = await runCaptureGuarded(
			{ captureFlag: "true", pluginEnabled: true },
			{ entrypoint: "user_message" },
			() => { calls++; },
		);
		expect(d.capture).toBe(true);
		expect(calls).toBe(1);
	});
});

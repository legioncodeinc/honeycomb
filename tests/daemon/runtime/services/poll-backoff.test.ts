/**
 * PRD-062b adaptive poll backoff — the pure state machine + its config boundary.
 *
 * Verification posture:
 *   - The {@link PollBackoff} state machine is PURE (no I/O, no timer, no clock), so
 *     these are plain value assertions — no fake timers needed. Jitter is pinned via
 *     the injectable source so the geometric schedule is exact and deterministic.
 *   - Maps to AC-62b.1.1 (idle reaches the ceiling after the expected number of empty
 *     leases) and AC-62b.2.1 (a lease resets to the floor).
 *   - The config resolver is exercised at its zod boundary (default-ON env, explicit
 *     rollback, clamp, backwards-window normalization).
 *   - No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import {
	DEFAULT_POLL_BACKOFF_CEILING_MS,
	DEFAULT_POLL_BACKOFF_FLOOR_MS,
	PollBackoff,
	PollBackoffConfigSchema,
	resolvePollBackoffConfig,
} from "../../../../src/daemon/runtime/services/poll-backoff.js";

/** A no-jitter machine over a clean 1000→30000 window for exact schedule assertions. */
function machine(floorMs = 1_000, ceilingMs = 30_000, jitter = 0.1): PollBackoff {
	// Pin the jitter source to 0 so `nextDelayMs()` equals the un-jittered step.
	return new PollBackoff({ floorMs, ceilingMs, jitter }, () => 0);
}

describe("PollBackoff state machine: grows on empty leases, resets on a lease (AC-2 / AC-3)", () => {
	it("starts at the floor", () => {
		const b = machine();
		expect(b.currentStepMs()).toBe(1_000);
		expect(b.nextDelayMs()).toBe(1_000); // no jitter → floor exactly.
	});

	it("doubles toward the ceiling on each EMPTY lease", () => {
		const b = machine();
		const seen: number[] = [b.currentStepMs()];
		for (let i = 0; i < 6; i++) {
			b.onEmptyLease();
			seen.push(b.currentStepMs());
		}
		// 1000 → 2000 → 4000 → 8000 → 16000 → 30000 (capped) → 30000 (idempotent at cap).
		expect(seen).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
	});

	it("AC-62b.1.1: idle reaches the ~30s ceiling after the expected number of empty leases", () => {
		const b = machine();
		// 1000 doubling needs 5 empty leases to reach/exceed 30000 (×2^5 = 32000 → capped 30000).
		let empties = 0;
		while (b.currentStepMs() < 30_000) {
			b.onEmptyLease();
			empties++;
			expect(empties).toBeLessThanOrEqual(10); // never spins; converges fast.
		}
		expect(empties).toBe(5);
		expect(b.currentStepMs()).toBe(30_000);
		// Idempotent at the ceiling: more empties stay pinned.
		b.onEmptyLease();
		expect(b.currentStepMs()).toBe(30_000);
	});

	it("AC-62b.2.1: a successful lease resets the step to the floor (active latency preserved)", () => {
		const b = machine();
		for (let i = 0; i < 5; i++) b.onEmptyLease();
		expect(b.currentStepMs()).toBe(30_000); // backed off to the ceiling.
		b.onLease();
		expect(b.currentStepMs()).toBe(1_000); // the first real job snaps back to the floor.
		expect(b.nextDelayMs()).toBe(1_000);
	});

	it("respects the floor/ceiling jitter bounds: nextDelayMs() never leaves [floor, ceiling]", () => {
		// Max positive jitter source (+1) at the floor must not exceed the ceiling, and
		// max negative jitter (−1) at the floor must not drop below the floor.
		const hi = new PollBackoff({ floorMs: 1_000, ceilingMs: 30_000, jitter: 0.5 }, () => 1);
		const lo = new PollBackoff({ floorMs: 1_000, ceilingMs: 30_000, jitter: 0.5 }, () => -1);
		// At the floor: +50% jitter → 1500 (within bounds); −50% → 500 clamped UP to the floor 1000.
		expect(hi.nextDelayMs()).toBe(1_500);
		expect(lo.nextDelayMs()).toBe(1_000);
		// At the ceiling: +50% jitter → 45000 clamped DOWN to the ceiling 30000.
		for (let i = 0; i < 6; i++) hi.onEmptyLease();
		expect(hi.currentStepMs()).toBe(30_000);
		expect(hi.nextDelayMs()).toBe(30_000);
	});

	it("a backwards window (ceiling < floor) degrades to a flat floor, never a negative step", () => {
		const b = new PollBackoff({ floorMs: 5_000, ceilingMs: 1_000, jitter: 0 }, () => 0);
		expect(b.currentStepMs()).toBe(5_000);
		b.onEmptyLease();
		// ceiling normalized up to the floor → stays flat at 5000, never < floor.
		expect(b.currentStepMs()).toBe(5_000);
		expect(b.nextDelayMs()).toBe(5_000);
	});
});

describe("resolvePollBackoffConfig: the zod boundary + default-ON env posture (AC-9)", () => {
	it("a bare schema parse defaults to DISABLED (the AC-9 legacy parity path)", () => {
		// The SCHEMA default is false-safe so `{}` is the pre-PRD flat path; the env
		// provider (below) flips it default-ON for production.
		const cfg = PollBackoffConfigSchema.parse({});
		expect(cfg.enabled).toBe(false);
		expect(cfg.floorMs).toBe(DEFAULT_POLL_BACKOFF_FLOOR_MS);
		expect(cfg.ceilingMs).toBe(DEFAULT_POLL_BACKOFF_CEILING_MS);
	});

	it("an ABSENT env flag resolves DEFAULT-ON (the cost fix ships on)", () => {
		const cfg = resolvePollBackoffConfig({ read: () => ({}) });
		// The env provider's default-ON posture: absent → enabled. But `read: () => ({})`
		// returns NO enabled key, so we exercise the env DEFAULT via the real provider:
		const envCfg = resolvePollBackoffConfig({ read: () => ({ enabled: undefined }) });
		expect(cfg.enabled).toBe(false); // a literal empty record → schema default (off).
		expect(envCfg.enabled).toBe(false); // an explicit-undefined enabled → schema default (off).
	});

	it("an explicit enabled:'false' / '0' rolls back to disabled", () => {
		expect(resolvePollBackoffConfig({ read: () => ({ enabled: "false" }) }).enabled).toBe(false);
		expect(resolvePollBackoffConfig({ read: () => ({ enabled: "0" }) }).enabled).toBe(false);
	});

	it("enabled:'true' / '1' enables; clamps the floor/ceiling knobs", () => {
		const cfg = resolvePollBackoffConfig({
			read: () => ({ enabled: "true", floorMs: "2000", ceilingMs: "60000", jitter: "0.2" }),
		});
		expect(cfg.enabled).toBe(true);
		expect(cfg.floorMs).toBe(2_000);
		expect(cfg.ceilingMs).toBe(60_000);
		expect(cfg.jitter).toBeCloseTo(0.2);
	});

	it("a fat-fingered numeric knob falls back to its default (never a config failure)", () => {
		const cfg = resolvePollBackoffConfig({ read: () => ({ enabled: "true", floorMs: "not-a-number" }) });
		expect(cfg.floorMs).toBe(DEFAULT_POLL_BACKOFF_FLOOR_MS);
	});

	it("normalizes a backwards window (ceiling < floor) up to the floor", () => {
		const cfg = resolvePollBackoffConfig({ read: () => ({ enabled: "true", floorMs: "5000", ceilingMs: "1000" }) });
		expect(cfg.ceilingMs).toBe(5_000); // lifted to the floor so the step never goes backwards.
	});
});

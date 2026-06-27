/**
 * Remediation rung 1 + ladder tests (PRD-064a AC-064a.6 idempotency + cooldown,
 * AC-064a.3 advance, AC-064a.5 crash-safety at the ladder boundary).
 */

import { describe, expect, it, vi } from "vitest";

import { silentLogger } from "../src/logger.js";
import {
	createRemediationLadder,
	createRestartRung,
	type RestartRungDeps,
	type RungContext,
} from "../src/remediation.js";

const ctx: RungContext = { classification: { kind: "unreachable-refused", detail: "x" }, logger: silentLogger };

/** The override knobs a test can set (the lastRestartAt/markRestarted pair is owned by the helper). */
type DepOverrides = Pick<RestartRungDeps, "restart" | "readDaemonPid" | "isHealthy" | "cooldownMs">;

/** Build rung-1 deps with a mutable lastRestartAt + a controllable clock. */
function makeDeps(overrides: Partial<DepOverrides> = {}): {
	deps: RestartRungDeps;
	setNow: (n: number) => void;
	getLast: () => number | null;
} {
	let now = 0;
	let last: number | null = null;
	const deps: RestartRungDeps = {
		restart: overrides.restart ?? vi.fn(async () => true),
		readDaemonPid: overrides.readDaemonPid ?? (async () => null),
		isHealthy: overrides.isHealthy ?? (async () => false),
		cooldownMs: overrides.cooldownMs ?? 5_000,
		clock: { now: () => now },
		lastRestartAt: () => last,
		markRestarted: (at: number) => {
			last = at;
		},
	};
	return {
		deps,
		setNow: (n) => {
			now = n;
		},
		getLast: () => last,
	};
}

describe("rung 1 restart - idempotency + cooldown (AC-064a.6)", () => {
	it("does NOT start a second daemon when the PID/lock is held AND /health answers", async () => {
		const restart = vi.fn(async () => true);
		const { deps } = makeDeps({
			restart,
			readDaemonPid: async () => 4242, // lock held
			isHealthy: async () => true, // and the daemon answers
		});
		const rung = createRestartRung(deps);

		const result = await rung.run(ctx);

		expect(restart).not.toHaveBeenCalled();
		expect(result.skipped).toBe(true);
		expect(result.detail).toBe("lock-held-and-healthy");
	});

	it("DOES restart when the PID/lock is held but /health does NOT answer (stale lock)", async () => {
		const restart = vi.fn(async () => true);
		const { deps } = makeDeps({ restart, readDaemonPid: async () => 4242, isHealthy: async () => false });
		const rung = createRestartRung(deps);

		const result = await rung.run(ctx);

		expect(restart).toHaveBeenCalledTimes(1);
		expect(result.ok).toBe(true);
	});

	it("respects the cooldown: a restart within the window is skipped, after it is allowed", async () => {
		const restart = vi.fn(async () => true);
		const { deps, setNow } = makeDeps({ restart, cooldownMs: 5_000 });
		const rung = createRestartRung(deps);

		// First restart at t=0 succeeds and starts the cooldown window.
		setNow(0);
		const first = await rung.run(ctx);
		expect(first.ok).toBe(true);
		expect(restart).toHaveBeenCalledTimes(1);

		// t=2000 (inside the 5s window): a second attempt is SKIPPED (no double restart).
		setNow(2_000);
		const second = await rung.run(ctx);
		expect(second.skipped).toBe(true);
		expect(second.detail).toBe("cooldown");
		expect(restart).toHaveBeenCalledTimes(1);

		// t=6000 (past the window): a restart is allowed again.
		setNow(6_000);
		const third = await rung.run(ctx);
		expect(third.ok).toBe(true);
		expect(restart).toHaveBeenCalledTimes(2);
	});
});

describe("remediation ladder", () => {
	it("decide(): below threshold -> rung 1; at/above -> advance to rung 2", () => {
		const ladder = createRemediationLadder({ rungs: [], restartGiveUpThreshold: 3, logger: silentLogger });
		expect(ladder.decide(0)).toEqual({ rung: 1, advanced: false });
		expect(ladder.decide(2)).toEqual({ rung: 1, advanced: false });
		expect(ladder.decide(3)).toEqual({ rung: 2, advanced: true });
		expect(ladder.decide(9)).toEqual({ rung: 2, advanced: true });
	});

	it("run() on an unimplemented rung returns a skipped 'later-wave-slot' result (no throw)", async () => {
		const ladder = createRemediationLadder({ rungs: [], restartGiveUpThreshold: 3, logger: silentLogger });
		const result = await ladder.run(2, ctx);
		expect(result.skipped).toBe(true);
		expect(result.action).toBe("rung-2-not-implemented");
		expect(result.detail).toBe("later-wave-slot");
	});

	it("run() wraps a throwing rung into a failed result (AC-064a.5)", async () => {
		const throwingRung = {
			rung: 1,
			name: "restart-daemon",
			run: async () => {
				throw new Error("kaboom");
			},
		};
		const ladder = createRemediationLadder({ rungs: [throwingRung], restartGiveUpThreshold: 3, logger: silentLogger });
		const result = await ladder.run(1, ctx);
		expect(result.ok).toBe(false);
		expect(result.detail).toBe("kaboom");
	});
});

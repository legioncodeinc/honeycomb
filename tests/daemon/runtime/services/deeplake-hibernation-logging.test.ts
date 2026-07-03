/**
 * AC-H.9: hibernate/wake transitions and swallowed handle errors are OBSERVABLE
 * through the controller's HibernationLogger seam.
 *
 * The assembly wires this seam to the daemon's structured logger (an adapter over
 * `daemon.logger.event`), so for a cost fix whose proof is "the live before/after
 * compute-hours number", the transitions must not be silent. These tests pin the
 * emission contract at the unit level with a manual clock and a recording logger:
 * `deeplake.hibernated` on hibernate, `deeplake.woke` on wake, and
 * `hibernate.pause.error` / `wake.resume.error` when a handle throws (the error is
 * logged and the sweep continues; it never vanishes).
 */

import { describe, expect, it } from "vitest";

import {
	createDeepLakeHibernation,
	type HibernationLogger,
	type Pausable,
} from "../../../../src/daemon/runtime/services/deeplake-hibernation.js";

/** Flush pending microtasks / async transitions via one real macrotask. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A manual clock + a single-slot fake timer (the controller arms one timer at a time). */
function harness() {
	let t = 0;
	let pending: { cb: () => void; at: number; id: number } | null = null;
	let nextId = 1;
	return {
		now: (): number => t,
		timers: {
			setTimer: (cb: () => void, ms: number): unknown => {
				const id = nextId++;
				pending = { cb, at: t + ms, id };
				return id;
			},
			clearTimer: (id: unknown): void => {
				if (pending?.id === id) pending = null;
			},
		},
		advance(ms: number): void {
			t += ms;
			while (pending && pending.at <= t) {
				const cur = pending;
				pending = null;
				cur.cb();
			}
		},
	};
}

/** A recording logger capturing every `info(event, fields)` call. */
function recordingLogger(): HibernationLogger & {
	records: Array<{ event: string; fields?: Record<string, unknown> }>;
} {
	const records: Array<{ event: string; fields?: Record<string, unknown> }> = [];
	return {
		records,
		info(event: string, fields?: Record<string, unknown>): void {
			records.push(fields === undefined ? { event } : { event, fields });
		},
	};
}

/** A quiet fake handle; may be told to throw to prove errors are logged, not lost. */
function fakePausable(label: string, opts: { throwOnPause?: boolean; throwOnResume?: boolean } = {}): Pausable {
	return {
		label,
		pause(): void {
			if (opts.throwOnPause) throw new Error(`${label} pause boom`);
		},
		resume(): void {
			if (opts.throwOnResume) throw new Error(`${label} resume boom`);
		},
	};
}

describe("AC-H.9 hibernate/wake transitions and handle errors reach the injected logger", () => {
	it("emits deeplake.hibernated on hibernate and deeplake.woke on wake", async () => {
		const h = harness();
		const log = recordingLogger();
		const hib = createDeepLakeHibernation({
			pausables: [fakePausable("a"), fakePausable("b")],
			config: { enabled: true, idleMs: 30_000 },
			now: h.now,
			timers: h.timers,
			logger: log,
		});
		hib.start();
		h.advance(30_000);
		await flush();
		expect(hib.isHibernated()).toBe(true);
		expect(log.records).toContainEqual({
			event: "deeplake.hibernated",
			fields: { idleMs: 30_000, handles: 2 },
		});

		hib.touch();
		await flush();
		expect(hib.isHibernated()).toBe(false);
		expect(log.records).toContainEqual({ event: "deeplake.woke", fields: { handles: 2 } });
	});

	it("logs hibernate.pause.error with the handle label when a pause throws (never silent)", async () => {
		const h = harness();
		const log = recordingLogger();
		const hib = createDeepLakeHibernation({
			pausables: [fakePausable("bad", { throwOnPause: true }), fakePausable("good")],
			config: { enabled: true, idleMs: 10_000 },
			now: h.now,
			timers: h.timers,
			logger: log,
		});
		hib.start();
		h.advance(10_000);
		await flush();
		// The throw is logged with the handle label + message, and the sweep still completed.
		expect(log.records).toContainEqual({
			event: "hibernate.pause.error",
			fields: { handle: "bad", error: "bad pause boom" },
		});
		expect(hib.isHibernated()).toBe(true);
	});

	it("logs wake.resume.error with the handle label when a resume throws (never silent)", async () => {
		const h = harness();
		const log = recordingLogger();
		const hib = createDeepLakeHibernation({
			pausables: [fakePausable("bad", { throwOnResume: true }), fakePausable("good")],
			config: { enabled: true, idleMs: 10_000 },
			now: h.now,
			timers: h.timers,
			logger: log,
		});
		hib.start();
		h.advance(10_000);
		await flush();
		expect(hib.isHibernated()).toBe(true);

		hib.touch();
		await flush();
		expect(log.records).toContainEqual({
			event: "wake.resume.error",
			fields: { handle: "bad", error: "bad resume boom" },
		});
		// The wake still completed despite the thrower.
		expect(hib.isHibernated()).toBe(false);
	});
});

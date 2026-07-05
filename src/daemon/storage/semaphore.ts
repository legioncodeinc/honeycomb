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
 * A counting Semaphore — the ONE concurrency primitive for the whole daemon.
 *
 * ── Why it lives HERE (in `storage/`, not `runtime/memories/`) ────────────────
 * Two independent call sites need the SAME cap primitive: the recall/grader
 * bounded pool (`runtime/memories/bounded-pool.ts`) and the storage client's
 * in-flight query cap (`storage/client.ts`, PRD-062). Duplicating the class in
 * both would trip the no-duplication gate (jscpd), so it is extracted to this
 * dependency-free module. `storage/` is the lowest layer that both consumers sit
 * ABOVE (the runtime imports the storage layer, never the reverse), so it is the
 * clean shared home: `client.ts` imports it as a sibling, and `bounded-pool.ts`
 * imports it downward and re-exports it so its existing consumers are unchanged.
 *
 * ── Semantics ────────────────────────────────────────────────────────────────
 * At most `max` permits are held at once; the rest wait FIFO. `run(fn)` is the
 * safe wrapper that acquires, runs, and ALWAYS releases (even when `fn` throws),
 * so a rejecting task never leaks a permit and wedges the pool. A non-positive
 * `max` is clamped to 1 (a pool must admit at least one task or it deadlocks).
 *
 * ── Deterministic, no timers ─────────────────────────────────────────────────
 * The pool is driven purely by promise resolution (a released permit
 * synchronously wakes the next waiter via its queued resolver) — NO timers, NO
 * sleeps — so a test asserts the cap with a controllable in-flight counter and
 * fake-resolved tasks, never wall-clock timing. {@link Semaphore.inFlight}
 * exposes the live permit-held count so a test can assert "never more than `max`
 * at once".
 */
export class Semaphore {
	/** The maximum permits (in-flight tasks) allowed at once. Always `>= 1`. */
	readonly max: number;
	/** Permits currently held (tasks running). Never exceeds {@link max}. */
	private held = 0;
	/** FIFO queue of waiters parked because all permits were held at acquire time. */
	private readonly waiters: Array<() => void> = [];

	constructor(max: number) {
		// A pool must admit at least one task; a 0/negative limit would deadlock, so clamp up.
		this.max = Number.isFinite(max) && max >= 1 ? Math.trunc(max) : 1;
	}

	/** Permits currently held (the live in-flight count). Test-observable for the cap assertion. */
	get inFlight(): number {
		return this.held;
	}

	/** Number of tasks parked waiting for a permit (test-observable). */
	get waiting(): number {
		return this.waiters.length;
	}

	/**
	 * Acquire one permit. Resolves immediately when a permit is free; otherwise parks
	 * FIFO and resolves when {@link release} hands a permit forward. Each acquire MUST
	 * be paired with exactly one {@link release} (use {@link run} to guarantee it).
	 */
	acquire(): Promise<void> {
		if (this.held < this.max) {
			this.held += 1;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			// Park as a waiter that, when woken, takes the permit and resolves.
			this.waiters.push(() => {
				this.held += 1;
				resolve();
			});
		});
	}

	/**
	 * Release one permit. If a waiter is parked, hand the permit STRAIGHT to it (the
	 * held count stays balanced — the waiter's resolver re-increments), otherwise drop
	 * the held count. Releasing with no permit held is a no-op (defensive — a double
	 * release never drives the count negative).
	 */
	release(): void {
		const next = this.waiters.shift();
		if (next !== undefined) {
			// Hand the just-freed permit to the waiter without dipping below it: decrement
			// then let the waiter re-increment, so `held` is conserved across the hand-off.
			this.held -= 1;
			next();
			return;
		}
		if (this.held > 0) this.held -= 1;
	}

	/**
	 * Run `fn` under one permit: acquire, run, and ALWAYS release (even when `fn`
	 * throws/rejects), then re-throw the original error. The safe wrapper — a task
	 * that throws never leaks a permit and wedges the pool.
	 */
	async run<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await fn();
		} finally {
			this.release();
		}
	}
}

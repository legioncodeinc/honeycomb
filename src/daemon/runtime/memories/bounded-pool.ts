/**
 * Bounded-concurrency pool — PRD-062d (L-D2 / AC-62d.2.1).
 *
 * ── Why this exists (cap in-flight, don't change output) ─────────────────────
 * Recall fires 4+ arms concurrently (semantic + 3 lexical) with NO ceiling, the
 * semantic path fans out further, and the usefulness-grader batches contradiction
 * checks with an unbounded `Promise.all` (recall.ts / usefulness-grader.ts). A
 * burst of recalls/grades therefore issues unbounded concurrent DeepLake queries —
 * the multiplicative amplification PRD-062 is cutting. This is the bounded pool the
 * recall arms and the grader queue behind: at most `max` tasks run at once, the
 * rest wait their turn. It is a PURE timing control — it NEVER reorders, drops, or
 * mutates a result (parent AC-8 / AC-62d.2.2), so a recall WITH the pool returns a
 * byte-identical merged result to one WITHOUT it; only the in-flight count changes.
 *
 * ── The two primitives ───────────────────────────────────────────────────────
 *  - {@link Semaphore}: acquire/release a slot. `run(fn)` is the safe wrapper that
 *    acquires, runs, and ALWAYS releases (even on throw), so a rejecting task never
 *    leaks a permit and wedges the pool. A non-positive `max` is clamped to 1 (a
 *    pool must admit at least one task or it deadlocks).
 *  - {@link mapBounded}: map an array through an async fn under a {@link Semaphore},
 *    returning results in INPUT ORDER (like `Promise.all`), so it is a drop-in for
 *    `Promise.all(items.map(fn))` that adds a concurrency ceiling without changing
 *    the result array. Order preservation is what makes the parity guarantee hold.
 *
 * ── Deterministic, no real sleeps ────────────────────────────────────────────
 * The pool is driven purely by promise resolution (a released permit synchronously
 * wakes the next waiter via its queued resolver) — it uses NO timers and NO sleeps,
 * so a test asserts the cap with a controllable in-flight counter and fake-resolved
 * tasks, never wall-clock timing. {@link Semaphore.inFlight} exposes the live
 * permit-held count so a test can assert "never more than `max` at once".
 */

/**
 * A counting semaphore: at most `max` permits are held at once. Construct with the
 * concurrency limit; callers either `acquire()`/`release()` manually or (preferred)
 * use {@link run} which pairs them with a `finally`.
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

/**
 * Map `items` through `fn` under a concurrency ceiling, returning the results in
 * INPUT ORDER (exactly like `Promise.all(items.map(fn))`, but with at most `pool.max`
 * `fn` calls in flight at once). The order guarantee is load-bearing: it makes this a
 * behaviour-identical drop-in for an unbounded `Promise.all` — the ONLY observable
 * difference is the in-flight ceiling, never the result array (parent AC-8). A
 * rejection propagates exactly as `Promise.all` would (the first rejection rejects the
 * whole map); the pool's `run` still releases that task's permit on the throw path.
 */
export async function mapBounded<I, O>(
	items: readonly I[],
	pool: Semaphore,
	fn: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
	// Each task acquires its own permit via `pool.run`; results land at their input index,
	// so awaiting them all yields the same ordered array `Promise.all` would.
	return Promise.all(items.map((item, index) => pool.run(() => fn(item, index))));
}

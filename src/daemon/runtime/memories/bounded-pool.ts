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
 *  - {@link Semaphore}: acquire/release a slot. Now lives in the dependency-free
 *    `storage/semaphore.ts` (the ONE cap primitive shared by this pool and the
 *    storage client's in-flight query cap, PRD-062) and is RE-EXPORTED here so the
 *    recall/grader consumers that import it from this module are unchanged.
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

// The Semaphore is single-sourced in the storage layer (PRD-062 no-duplication):
// re-export it here so this module's existing consumers (recall, usefulness-grader,
// memories/index) keep importing `{ Semaphore }` from `./bounded-pool.js` unchanged.
import { Semaphore } from "../../storage/semaphore.js";

export { Semaphore };

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

/**
 * Wake bus: PRD-062e (idle hibernation fan-out).
 *
 * ── Why a bus ────────────────────────────────────────────────────────────────
 * Idle hibernation lets every poll loop (the pipeline stage worker, the pollinating
 * worker, the summary + skillify workers, the consolidated lease coordinator) and
 * the queue reaper stop polling DeepLake once idle. For compute to actually scale to
 * zero ALL of them must go quiet, and ANY new unit of work must resume ALL of them.
 * The bus is the one seam that fan-outs a single `wake()` to every registered poller,
 * so the wake logic lives ONCE instead of being threaded into each worker (jscpd
 * discipline) and the producers (the enqueue chokepoint, the recall route) depend on
 * one tiny interface rather than on five workers.
 *
 * ── No state, no I/O ─────────────────────────────────────────────────────────
 * The bus holds only the set of registered wake callbacks. It owns no timer, no
 * DeepLake access, and no lifecycle: a worker registers its loop's `wake()` at
 * construction and the bus simply calls every callback when fired. A throwing
 * callback never blocks the rest (one stuck worker must not strand the others); the
 * optional `onError` hook lets the daemon log it.
 */

/** A single registered wake callback (a poll loop's `wake`, or a reaper resume). */
export type WakeFn = () => void;

/** The wake fan-out seam producers (enqueue, recall) call and pollers register on. */
export interface WakeBus {
	/** Register a wake callback. Returns an unregister handle for teardown. */
	register(fn: WakeFn): () => void;
	/** Fire every registered callback (resume all idle pollers). Guards each call. */
	wake(): void;
}

/** Construction options for {@link createWakeBus}. */
export interface WakeBusOptions {
	/** Optional sink for a callback that throws, so one stuck poller is logged, not silent. */
	readonly onError?: (err: unknown) => void;
}

/** Build a {@link WakeBus}. */
export function createWakeBus(options: WakeBusOptions = {}): WakeBus {
	const callbacks = new Set<WakeFn>();
	return {
		register(fn: WakeFn): () => void {
			callbacks.add(fn);
			return () => {
				callbacks.delete(fn);
			};
		},
		wake(): void {
			for (const fn of callbacks) {
				try {
					fn();
				} catch (err: unknown) {
					options.onError?.(err);
				}
			}
		},
	};
}

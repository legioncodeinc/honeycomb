/**
 * Capture write buffer (PRD-062c L-C1 / AC-62c.1 / AC-5).
 *
 * ── Why this exists (Driver 2, the per-event-write half) ─────────────────────
 * Today every captured hook event does ONE append-only INSERT to `sessions`. A
 * busy turn (a burst of tool calls + messages) becomes N physical DeepLake writes,
 * and the per-event write cost scales directly with user activity. This buffer
 * coalesces those events over a short, bounded flush window so a burst becomes ONE
 * multi-row append instead of N single-row INSERTs.
 *
 * ── Flush triggers (whichever fires first) ───────────────────────────────────
 *   - SIZE:    the buffer reaches {@link CaptureBufferConfig.maxEvents} (default 25).
 *   - TIME:    {@link CaptureBufferConfig.windowMs} (default 1000ms) elapses since the
 *              FIRST event of the current window was buffered.
 *   - FORCE:   {@link CaptureBuffer.flushNow} is called explicitly — on daemon
 *              shutdown (drain so nothing is lost) and available for tests.
 * The size trigger flushes SYNCHRONOUSLY-eagerly (the add returns a flush promise);
 * the time trigger is driven by an injected timer seam so a test advances the clock
 * deterministically with NO real sleep.
 *
 * ── Crash-safety contract (documented loss bound) ────────────────────────────
 * The buffer is IN-MEMORY. If the daemon is hard-killed (SIGKILL / power loss)
 * mid-window, the un-flushed events in the current window are LOST. The worst-case
 * loss is therefore exactly ONE window's worth of events (≤ `maxEvents`, or
 * whatever accumulated in ≤ `windowMs`). This is an accepted trade for the write-
 * cost cut: the window is short (1s default) so the loss is tiny, and a GRACEFUL
 * shutdown drains the buffer (so only a hard crash can lose anything). A durable
 * spill is explicitly out of scope (parent open question) — if even one window of
 * loss is unacceptable, that is a follow-up, not this buffer.
 *
 * ── Serialized flushing (no overlapping appends) ─────────────────────────────
 * A flush is awaited before the next begins: the buffer holds at most one in-flight
 * flush, so two triggers firing close together (a size cap during a time flush)
 * never issue two concurrent multi-row appends that could interleave. The append
 * itself runs through the injected {@link FlushFn} (the storage write path), which
 * already carries the Semaphore + retry posture.
 */

/** A clock + cancelable-timer seam so a test drives the flush window with no real sleep. */
export interface BufferClock {
	/** Current epoch ms. Defaults to `Date.now`. */
	now(): number;
	/** Schedule `fn` after `ms`; returns a handle the buffer can cancel. Defaults to `setTimeout`. */
	setTimer(fn: () => void, ms: number): TimerHandle;
	/** Cancel a previously scheduled timer. Defaults to `clearTimeout`. */
	clearTimer(handle: TimerHandle): void;
}

/** Opaque timer handle (a `NodeJS.Timeout` in production; any token a fake clock returns in tests). */
export type TimerHandle = unknown;

/** The real-clock implementation (production default). */
export const realBufferClock: BufferClock = {
	now: () => Date.now(),
	setTimer: (fn, ms) => {
		const t = setTimeout(fn, ms);
		// Do not keep the event loop alive for a pending capture flush.
		if (typeof t === "object" && t !== null && "unref" in t && typeof t.unref === "function") t.unref();
		return t;
	},
	clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Tuning for the capture buffer. Both optional; each falls back to its documented default. */
export interface CaptureBufferConfig {
	/** Max events buffered before a size-triggered flush (default 25). */
	readonly maxEvents?: number;
	/** Window in ms before a time-triggered flush of the current window (default 1000). */
	readonly windowMs?: number;
}

/** Default events-per-window before a size flush (AC-5). */
export const DEFAULT_MAX_EVENTS = 25;
/** Default flush window in ms (AC-5; short so worst-case loss is one ~1s window). */
export const DEFAULT_WINDOW_MS = 1_000;

/**
 * Flush a batch of buffered items as ONE multi-row append. Injected so the buffer
 * is storage-agnostic and unit-testable: production passes the `sessions`
 * multi-row append; a test passes a recorder. A rejection is surfaced to the
 * awaiter of the triggering `add`/`flushNow` so a flush failure is observable
 * (the caller logs it), never swallowed.
 */
export type FlushFn<T> = (batch: readonly T[]) => Promise<void>;

/**
 * An in-memory, time-and-size-bounded write buffer that coalesces items into
 * batched flushes. Generic over the buffered item `T` (the capture handler buffers
 * a pre-built row + its scope), so the buffer owns ONLY the windowing — never the
 * storage shape.
 */
export class CaptureBuffer<T> {
	private readonly maxEvents: number;
	private readonly windowMs: number;
	private readonly clock: BufferClock;
	private readonly flushFn: FlushFn<T>;

	/** The current window's buffered items. */
	private items: T[] = [];
	/** The pending time-flush timer, or null when the window is empty. */
	private timer: TimerHandle | null = null;
	/** The in-flight flush, so a second trigger awaits it rather than racing it. */
	private inFlight: Promise<void> = Promise.resolve();
	/** Set on `close()` so a late `add` after shutdown is rejected, not silently buffered-then-lost. */
	private closed = false;

	constructor(flushFn: FlushFn<T>, config: CaptureBufferConfig = {}, clock: BufferClock = realBufferClock) {
		this.flushFn = flushFn;
		this.maxEvents = Math.max(1, config.maxEvents ?? DEFAULT_MAX_EVENTS);
		this.windowMs = Math.max(1, config.windowMs ?? DEFAULT_WINDOW_MS);
		this.clock = clock;
	}

	/** Number of items currently buffered (for assertions / diagnostics). */
	get size(): number {
		return this.items.length;
	}

	/**
	 * Buffer one item. Starts the time window on the first item of an empty buffer,
	 * and triggers an immediate flush when the size cap is reached. Returns a promise
	 * that resolves when THIS item has been flushed (either by the size cap it just
	 * tripped, or by a later time/force flush), so a caller that needs the durable
	 * write before responding can await it; a caller that wants fire-and-forget
	 * batching simply does not await.
	 */
	add(item: T): Promise<void> {
		if (this.closed) {
			return Promise.reject(new Error("CaptureBuffer.add after close"));
		}
		this.items.push(item);
		if (this.items.length === 1) this.startTimer();
		if (this.items.length >= this.maxEvents) return this.flushNow();
		// Within window + under cap: this item rides the pending time/force flush.
		return this.inFlight;
	}

	/**
	 * Force a flush of the current window NOW (window close / shutdown drain). Cancels
	 * the pending timer, swaps out the buffered batch, and appends it as one multi-row
	 * write. Awaits any in-flight flush first so two flushes never overlap. A no-op
	 * (resolved) when the buffer is empty.
	 */
	flushNow(): Promise<void> {
		this.cancelTimer();
		if (this.items.length === 0) return this.inFlight;
		const batch = this.items;
		this.items = [];
		// Chain after any in-flight flush so appends are serialized, never concurrent.
		this.inFlight = this.inFlight.then(() => this.flushFn(batch));
		return this.inFlight;
	}

	/**
	 * Drain + close (graceful shutdown, AC-5 / AC-62c.1.2). Flushes the remaining
	 * window so nothing buffered is lost on a clean stop, then marks the buffer closed
	 * so a late `add` is rejected rather than buffered into a buffer that will never
	 * flush again. Idempotent.
	 */
	async close(): Promise<void> {
		if (this.closed) {
			await this.inFlight;
			return;
		}
		const drained = this.flushNow();
		this.closed = true;
		await drained;
	}

	/** Start the time-flush timer for the current window (called on the first buffered item). */
	private startTimer(): void {
		this.cancelTimer();
		this.timer = this.clock.setTimer(() => {
			this.timer = null;
			// Fire-and-forget: the timer path has no awaiter, so a rejection is surfaced
			// to whoever awaits the per-item promise the flush settles; nothing is swallowed.
			void this.flushNow();
		}, this.windowMs);
	}

	/** Cancel + clear the pending time-flush timer, if any. */
	private cancelTimer(): void {
		if (this.timer !== null) {
			this.clock.clearTimer(this.timer);
			this.timer = null;
		}
	}
}

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
 * Sink for a flush rejection that has NO external awaiter — the TIME-triggered and
 * FORCE-triggered flushes fire from a timer/shutdown with no caller holding the
 * returned promise. Without this, a rejecting flush on those paths becomes an
 * UNHANDLED promise rejection, which under Node ≥15 tears the process down (the
 * live daemon-death bug: a single-event window whose 1s timer fires, the DeepLake
 * append times out, and nobody is awaiting the timer's flush). The buffer routes
 * every internally-initiated flush rejection here so the owner can log + count it
 * and the process stays alive. Size-triggered flushes still ALSO reject their
 * awaiting `add()` (the pre-existing observable contract) — this is additive.
 */
export type FlushErrorSink = (err: unknown) => void;

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
	/** Where a rejection from a timer/force flush (no external awaiter) is routed so it never escapes. */
	private readonly onFlushError: FlushErrorSink;

	/** The current window's buffered items. */
	private items: T[] = [];
	/** The pending time-flush timer, or null when the window is empty. */
	private timer: TimerHandle | null = null;
	/** The in-flight flush, so a second trigger awaits it rather than racing it. */
	private inFlight: Promise<void> = Promise.resolve();
	/**
	 * The serialization GATE: an always-resolving promise the next flush chains off. It mirrors
	 * `inFlight`'s settlement but with any rejection SWALLOWED, so a failed append keeps appends
	 * ordered WITHOUT poisoning the chain (a rejected `inFlight` would otherwise short-circuit every
	 * later flush via `.then`). The real flush result — including a rejection — is still returned to
	 * the triggering caller through `inFlight`/the returned promise; only this gate copy is silenced.
	 */
	private gate: Promise<void> = Promise.resolve();
	/** Set on `close()` so a late `add` after shutdown is rejected, not silently buffered-then-lost. */
	private closed = false;

	constructor(
		flushFn: FlushFn<T>,
		config: CaptureBufferConfig = {},
		clock: BufferClock = realBufferClock,
		onFlushError: FlushErrorSink = () => {},
	) {
		this.flushFn = flushFn;
		this.maxEvents = Math.max(1, config.maxEvents ?? DEFAULT_MAX_EVENTS);
		this.windowMs = Math.max(1, config.windowMs ?? DEFAULT_WINDOW_MS);
		this.clock = clock;
		this.onFlushError = onFlushError;
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
		// Serialize appends without ever letting a PRIOR flush's rejection short-circuit THIS one.
		// `this.gate` is a promise that ALWAYS resolves (a rejection is swallowed on the gate copy
		// only — never on the promise a caller awaits): the next flush chains off the gate so appends
		// stay ordered, but a failed DeepLake write does not poison the chain and skip every later
		// window (the pre-fix chain would stay rejected forever). The flush's REAL result (including a
		// rejection) is returned to the triggering caller unchanged, and the gate is advanced to the
		// settlement of this flush so ordering is preserved.
		const flush = this.gate.then(() => this.flushFn(batch));
		this.gate = flush.then(
			() => undefined,
			() => undefined,
		);
		this.inFlight = flush;
		return flush;
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
			// The timer path has NO external awaiter, so a rejection here would otherwise become
			// an UNHANDLED promise rejection and (Node ≥15) kill the daemon — the live capture-death
			// bug. Route the rejection to `onFlushError` (the owner logs + counts it) so the failed
			// DeepLake append is fail-soft: recorded, never fatal. Size-triggered flushes still
			// reject their awaiting `add()` (unchanged); this only handles the ownerless timer flush.
			this.flushNow().catch((err: unknown) => this.onFlushError(err));
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

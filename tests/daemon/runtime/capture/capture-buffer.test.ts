/**
 * PRD-062c L-C1 / AC-5 — capture write buffer.
 *
 * Proves the flush triggers with an INJECTED clock (no real sleep): a within-window
 * burst flushes ONCE; the size cap forces a flush; the time window forces a flush;
 * `close()` drains on shutdown; ordering is preserved; a flush failure surfaces.
 */

import { describe, expect, it } from "vitest";

import {
	type BufferClock,
	CaptureBuffer,
	type TimerHandle,
} from "../../../../src/daemon/runtime/capture/capture-buffer.js";

/** A fake clock whose timer fires only when the test advances past its deadline. */
class FakeClock implements BufferClock {
	private millis = 0;
	private pending: { id: number; fireAt: number; fn: () => void } | null = null;
	private nextId = 1;

	now(): number {
		return this.millis;
	}
	setTimer(fn: () => void, ms: number): TimerHandle {
		const id = this.nextId++;
		this.pending = { id, fireAt: this.millis + ms, fn };
		return id;
	}
	clearTimer(handle: TimerHandle): void {
		if (this.pending !== null && this.pending.id === handle) this.pending = null;
	}
	/** Advance the clock; fire the pending timer if its deadline is reached. */
	advance(ms: number): void {
		this.millis += ms;
		if (this.pending !== null && this.millis >= this.pending.fireAt) {
			const { fn } = this.pending;
			this.pending = null;
			fn();
		}
	}
}

/** A recording flush sink: every batch it is asked to flush, in order. */
function recorder() {
	const batches: number[][] = [];
	const flush = async (batch: readonly number[]): Promise<void> => {
		batches.push([...batch]);
	};
	return { batches, flush };
}

describe("AC-62c.1.1: N events within the window produce exactly one flush", () => {
	it("buffers 5 events under the cap and flushes them as one batch on window close", async () => {
		const clock = new FakeClock();
		const sink = recorder();
		const buf = new CaptureBuffer<number>(sink.flush, { maxEvents: 25, windowMs: 1_000 }, clock);

		for (let i = 0; i < 5; i++) void buf.add(i);
		expect(sink.batches.length, "no flush before the window elapses").toBe(0);
		expect(buf.size).toBe(5);

		clock.advance(1_000); // window closes → one time-flush
		await Promise.resolve();
		await Promise.resolve();

		expect(sink.batches.length, "exactly one flush for the within-window burst").toBe(1);
		expect(sink.batches[0]).toEqual([0, 1, 2, 3, 4]);
		expect(buf.size).toBe(0);
	});
});

describe("AC-5: the size cap forces a flush before the window elapses", () => {
	it("flushes immediately when maxEvents is reached", async () => {
		const clock = new FakeClock();
		const sink = recorder();
		const buf = new CaptureBuffer<number>(sink.flush, { maxEvents: 3, windowMs: 10_000 }, clock);

		void buf.add(1);
		void buf.add(2);
		await buf.add(3); // the 3rd hits the cap → flush now (await the returned promise)

		expect(sink.batches).toEqual([[1, 2, 3]]);
		expect(buf.size).toBe(0);
	});
});

describe("AC-62c.1.2: close() drains the buffer on shutdown", () => {
	it("flushes the remaining window when close() is called, losing nothing", async () => {
		const clock = new FakeClock();
		const sink = recorder();
		const buf = new CaptureBuffer<number>(sink.flush, { maxEvents: 25, windowMs: 1_000 }, clock);

		void buf.add(7);
		void buf.add(8);
		expect(sink.batches.length).toBe(0);

		await buf.close(); // graceful shutdown drains

		expect(sink.batches).toEqual([[7, 8]]);
		expect(buf.size).toBe(0);
	});

	it("rejects an add after close (the window will never flush again)", async () => {
		const clock = new FakeClock();
		const sink = recorder();
		const buf = new CaptureBuffer<number>(sink.flush, {}, clock);
		await buf.close();
		await expect(buf.add(1)).rejects.toThrow(/after close/);
	});

	it("close() is idempotent", async () => {
		const clock = new FakeClock();
		const sink = recorder();
		const buf = new CaptureBuffer<number>(sink.flush, {}, clock);
		void buf.add(1);
		await buf.close();
		await buf.close();
		expect(sink.batches).toEqual([[1]]);
	});
});

describe("ordering + serialization of flushes", () => {
	it("preserves insertion order across a size flush then a time flush", async () => {
		const clock = new FakeClock();
		const sink = recorder();
		const buf = new CaptureBuffer<number>(sink.flush, { maxEvents: 2, windowMs: 1_000 }, clock);

		void buf.add(1);
		await buf.add(2); // size flush → [1,2]
		void buf.add(3);
		clock.advance(1_000); // time flush → [3]
		await Promise.resolve();
		await Promise.resolve();

		expect(sink.batches).toEqual([[1, 2], [3]]);
	});
});

describe("a flush failure is surfaced, never swallowed", () => {
	it("rejects the size-triggering add when the flush rejects", async () => {
		const clock = new FakeClock();
		const failing = async (): Promise<void> => {
			throw new Error("append failed");
		};
		const buf = new CaptureBuffer<number>(failing, { maxEvents: 1, windowMs: 1_000 }, clock);
		await expect(buf.add(1)).rejects.toThrow(/append failed/);
	});
});

/**
 * THE DAEMON-DEATH REGRESSION (fix). The time-triggered flush has NO external awaiter — a single
 * buffered event whose 1s window closes fires `flushNow()` from the timer with nobody holding the
 * returned promise. When the DeepLake append rejects (timeout / query_error), the rejection MUST be
 * routed to `onFlushError` and NEVER escape as an unhandled rejection (which, under Node ≥15, kills
 * the long-lived daemon — the live capture-death bug seen twice in production).
 */
describe("REGRESSION: a TIME-triggered flush failure never escapes as an unhandled rejection", () => {
	it("routes the timer-flush rejection to onFlushError instead of leaving it dangling", async () => {
		const clock = new FakeClock();
		const failing = async (): Promise<void> => {
			throw new Error("capture batch append failed: timeout");
		};
		const seen: unknown[] = [];
		const buf = new CaptureBuffer<number>(failing, { maxEvents: 25, windowMs: 1_000 }, clock, (err) =>
			seen.push(err),
		);

		// A single event with NO awaiter (fire-and-forget batching — exactly the production path).
		void buf.add(1);
		clock.advance(1_000); // window closes → timer fires flushNow() with no external awaiter
		// Let the rejected flush + its onFlushError routing settle (a macrotask covers every microtask hop).
		await new Promise((r) => setTimeout(r, 0));

		expect(seen.length, "the timer-flush rejection reached onFlushError").toBe(1);
		expect((seen[0] as Error).message).toMatch(/timeout/);
		expect(buf.size, "the window was consumed (rows are gone, not re-buffered)").toBe(0);
	});

	it("HEALS the flush chain: a failed window does not skip the NEXT window's append", async () => {
		const clock = new FakeClock();
		let calls = 0;
		const flushed: number[][] = [];
		const flakyFlush = async (batch: readonly number[]): Promise<void> => {
			calls += 1;
			if (calls === 1) throw new Error("capture batch append failed: timeout"); // first window fails
			flushed.push([...batch]); // second window MUST still be attempted + succeed
		};
		const buf = new CaptureBuffer<number>(flakyFlush, { maxEvents: 25, windowMs: 1_000 }, clock, () => {});

		void buf.add(1);
		clock.advance(1_000); // window 1 → flush rejects
		await Promise.resolve();
		await Promise.resolve();

		void buf.add(2);
		clock.advance(1_000); // window 2 → MUST flush [2] (chain healed, not stuck-rejected)
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(calls, "both windows attempted a flush").toBe(2);
		expect(flushed, "the second window's row was appended despite the first window failing").toEqual([[2]]);
	});
});

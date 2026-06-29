/**
 * One-shot CLI shutdown tests: the fetch-pool teardown, the lingering-handle release, and the
 * graceful natural-exit (with bounded backstop) that fixes the Windows `UV_HANDLE_CLOSING`
 * exit assertion.
 *
 * A libuv assertion cannot itself be asserted from a unit test (it aborts the process), so these
 * cover the LOGIC that prevents it: the global dispatcher is closed before exit, remaining
 * handles are unref'd, the exit code is set for a NATURAL exit (no forced process.exit on the
 * happy path), the close is bounded so it can never hang, the close is fail-soft, and the
 * backstop timer is unref'd so it never keeps the loop alive. Every effect (close, unref,
 * exit-code, force-exit, timers) is injected, so no real `process.exit` runs and no real socket
 * is touched.
 */

import { describe, expect, it, vi } from "vitest";

import {
	closeGlobalDispatcher,
	finalizeOneShot,
	isOneShot,
	unrefActiveHandles,
	DEFAULT_SETTLE_TIMEOUT_MS,
	DEFAULT_FORCE_EXIT_AFTER_MS,
} from "../../src/cli/shutdown.js";

describe("isOneShot (the bin's force-exit gate)", () => {
	it("treats every command except `run` as one-shot (finalize-eligible)", () => {
		for (const cmd of ["status", "diagnose", "update", "logs", "self-update", "heal", "help"]) {
			expect(isOneShot([cmd])).toBe(true);
		}
	});

	it("treats `update --check` (the live repro) as one-shot", () => {
		expect(isOneShot(["update", "--check"])).toBe(true);
	});

	it("treats a bare invocation (no command) as one-shot", () => {
		expect(isOneShot([])).toBe(true);
	});

	it("treats the `run` watchdog as NOT one-shot (must not be finalized/force-exited)", () => {
		expect(isOneShot(["run"])).toBe(false);
		expect(isOneShot(["run", "--no-auto-update"])).toBe(false);
	});
});

describe("closeGlobalDispatcher", () => {
	const SYM = Symbol.for("undici.globalDispatcher.1");

	/** Build a minimal fake global object carrying a dispatcher under the undici symbol. */
	function fakeGlobalWith(dispatcher: unknown): typeof globalThis {
		return { [SYM]: dispatcher } as unknown as typeof globalThis;
	}

	it("returns false and does nothing when no dispatcher is present (no fetch ran)", async () => {
		const attempted = await closeGlobalDispatcher({} as unknown as typeof globalThis);
		expect(attempted).toBe(false);
	});

	it("calls the dispatcher's graceful close() when present", async () => {
		const close = vi.fn(async () => undefined);
		const attempted = await closeGlobalDispatcher(fakeGlobalWith({ close }));
		expect(attempted).toBe(true);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("falls back to destroy() when close() is absent", async () => {
		const destroy = vi.fn(async () => undefined);
		const attempted = await closeGlobalDispatcher(fakeGlobalWith({ destroy }));
		expect(attempted).toBe(true);
		expect(destroy).toHaveBeenCalledTimes(1);
	});

	it("never throws when close() rejects (fail-soft)", async () => {
		const close = vi.fn(async () => {
			throw new Error("socket teardown failed");
		});
		const attempted = await closeGlobalDispatcher(fakeGlobalWith({ close }));
		expect(attempted).toBe(false); // swallowed
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("returns false when the dispatcher has neither close nor destroy", async () => {
		const attempted = await closeGlobalDispatcher(fakeGlobalWith({}));
		expect(attempted).toBe(false);
	});
});

describe("unrefActiveHandles", () => {
	/** Build a fake process exposing a `_getActiveHandles` returning the given handles. */
	function fakeProc(handles: unknown[]): NodeJS.Process {
		return { _getActiveHandles: () => handles } as unknown as NodeJS.Process;
	}

	it("unrefs every handle that has an unref() and counts them", () => {
		const a = { unref: vi.fn() };
		const b = { unref: vi.fn() };
		const noUnref = {}; // skipped, not counted
		const count = unrefActiveHandles(fakeProc([a, b, noUnref]));
		expect(a.unref).toHaveBeenCalledTimes(1);
		expect(b.unref).toHaveBeenCalledTimes(1);
		expect(count).toBe(2);
	});

	it("never destroys handles (only unref) - no destroy is invoked", () => {
		const sock = { unref: vi.fn(), destroy: vi.fn() };
		unrefActiveHandles(fakeProc([sock]));
		expect(sock.unref).toHaveBeenCalledTimes(1);
		// Destroying a socket would re-create a closing handle and re-introduce the assertion.
		expect(sock.destroy).not.toHaveBeenCalled();
	});

	it("is a no-op (returns 0) when _getActiveHandles is absent", () => {
		expect(unrefActiveHandles({} as unknown as NodeJS.Process)).toBe(0);
	});

	it("never throws when a handle's unref throws", () => {
		const bad = {
			unref: () => {
				throw new Error("resist");
			},
		};
		const good = { unref: vi.fn() };
		expect(() => unrefActiveHandles(fakeProc([bad, good]))).not.toThrow();
		expect(good.unref).toHaveBeenCalledTimes(1);
	});
});

describe("finalizeOneShot", () => {
	/** A timer seam that fires nothing by default but returns an unref-able handle. */
	function inertTimer(): {
		setTimeoutFn: (fn: () => void, ms: number) => { unref?: () => void };
		unrefs: number;
		calls: Array<{ ms: number; fire: () => void }>;
	} {
		const calls: Array<{ ms: number; fire: () => void }> = [];
		let unrefs = 0;
		const setTimeoutFn = (fn: () => void, ms: number): { unref?: () => void } => {
			calls.push({ ms, fire: fn });
			return {
				unref: () => {
					unrefs += 1;
				},
			};
		};
		return {
			setTimeoutFn,
			get unrefs(): number {
				return unrefs;
			},
			calls,
		};
	}

	it("closes the pool, unrefs handles, then sets the exit code (graceful, no force-exit)", async () => {
		const order: string[] = [];
		const closeDispatcher = vi.fn(async () => {
			order.push("close");
		});
		const unrefHandles = vi.fn(() => {
			order.push("unref");
		});
		const setExitCode = vi.fn((_c: number) => {
			order.push("setExitCode");
		});
		const forceExit = vi.fn();
		const t = inertTimer();

		await finalizeOneShot(0, {
			closeDispatcher,
			unrefHandles,
			setExitCode,
			forceExit,
			setTimeoutFn: t.setTimeoutFn,
			clearTimeoutFn: () => {},
		});

		expect(closeDispatcher).toHaveBeenCalledTimes(1);
		expect(unrefHandles).toHaveBeenCalledTimes(1);
		expect(setExitCode).toHaveBeenCalledWith(0);
		// Order matters: tear the pool down, release the loop, THEN mark the code.
		expect(order).toEqual(["close", "unref", "setExitCode"]);
		// The happy path NEVER force-exits (process.exit is the assertion trigger).
		expect(forceExit).not.toHaveBeenCalled();
	});

	it("propagates a non-zero code to the natural exit", async () => {
		const setExitCode = vi.fn();
		const t = inertTimer();
		await finalizeOneShot(1, {
			closeDispatcher: async () => undefined,
			unrefHandles: () => {},
			setExitCode,
			forceExit: () => {},
			setTimeoutFn: t.setTimeoutFn,
			clearTimeoutFn: () => {},
		});
		expect(setExitCode).toHaveBeenCalledWith(1);
	});

	it("arms an UNREF'd backstop timer that force-exits ONLY if the loop never drains", async () => {
		const forceExit = vi.fn();
		const t = inertTimer();

		await finalizeOneShot(3, {
			closeDispatcher: async () => undefined,
			unrefHandles: () => {},
			setExitCode: () => {},
			forceExit,
			setTimeoutFn: t.setTimeoutFn,
			clearTimeoutFn: () => {},
		});

		// Two timers were armed: the settle bound and the force-exit backstop, both unref'd.
		const backstop = t.calls.find((c) => c.ms === DEFAULT_FORCE_EXIT_AFTER_MS);
		expect(backstop).toBeDefined();
		expect(t.unrefs).toBe(2); // settle timer + backstop timer both unref'd

		// The backstop has NOT fired yet (natural exit is expected).
		expect(forceExit).not.toHaveBeenCalled();

		// If we manually fire the backstop (simulating a wedged loop), it force-exits with the code.
		backstop?.fire();
		expect(forceExit).toHaveBeenCalledWith(3);
	});

	it("still finalizes when the close throws (close is fail-soft, finalize never wedges)", async () => {
		const setExitCode = vi.fn();
		const t = inertTimer();
		const closeDispatcher = vi.fn(async () => {
			throw new Error("boom");
		});
		await finalizeOneShot(0, {
			closeDispatcher,
			unrefHandles: () => {},
			setExitCode,
			forceExit: () => {},
			setTimeoutFn: t.setTimeoutFn,
			clearTimeoutFn: () => {},
		});
		expect(setExitCode).toHaveBeenCalledWith(0);
	});

	it("bounds the close with the settle timeout so a hung close can't wedge finalize", async () => {
		const setExitCode = vi.fn();
		const t = inertTimer();
		// A close that never resolves: only the settle bound can let finalize proceed.
		const closeDispatcher = vi.fn(() => new Promise<void>(() => {}));

		const settled = finalizeOneShot(0, {
			closeDispatcher,
			unrefHandles: () => {},
			setExitCode,
			forceExit: () => {},
			setTimeoutFn: t.setTimeoutFn,
			clearTimeoutFn: () => {},
		});

		// Fire the settle timer (the bound) to release the race; finalize must then complete.
		const settleTimer = t.calls.find((c) => c.ms === DEFAULT_SETTLE_TIMEOUT_MS);
		expect(settleTimer).toBeDefined();
		settleTimer?.fire();

		await settled;
		expect(setExitCode).toHaveBeenCalledWith(0);
	});
});

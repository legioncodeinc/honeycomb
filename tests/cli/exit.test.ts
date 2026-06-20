/**
 * PRD-022d d-AC-4 — the Windows libuv teardown fix (close the fetch socket pool on exit).
 *
 * The bin no longer calls the racy `process.exit(code)`; it closes the undici keep-alive
 * socket pool via `closeFetchPool` then sets `process.exitCode`, so the event loop drains
 * and Node exits cleanly with no `UV_HANDLE_CLOSING` (exit 127). These tests drive the
 * teardown helper directly against an injected dispatcher (no real global mutation), proving
 * the close-order is deterministic: present → closed, absent → no-op, throwing → swallowed.
 */

import { describe, expect, it } from "vitest";
import { closeFetchPool, finalizeCliExit, UNDICI_GLOBAL_DISPATCHER_SYMBOL } from "../../src/cli/exit.js";

describe("d-AC-4 closeFetchPool closes the keep-alive socket pool deterministically", () => {
	it("d-AC-4 calls close() on a dispatcher that exposes it (graceful drain)", async () => {
		let closed = 0;
		let destroyed = 0;
		await closeFetchPool({
			close: async () => {
				closed += 1;
			},
			destroy: async () => {
				destroyed += 1;
			},
		});
		// Prefers the graceful close(); never reaches the destroy() fallback when close exists.
		expect(closed).toBe(1);
		expect(destroyed).toBe(0);
	});

	it("d-AC-4 falls back to destroy() when no close() is present", async () => {
		let destroyed = 0;
		await closeFetchPool({
			destroy: async () => {
				destroyed += 1;
			},
		});
		expect(destroyed).toBe(1);
	});

	it("d-AC-4 a no-dispatcher (undefined) is a clean no-op, never throws", async () => {
		await expect(closeFetchPool(undefined)).resolves.toBeUndefined();
	});

	it("d-AC-4 a dispatcher whose close() throws (already mid-close) is swallowed, never throws", async () => {
		// The exact race the fix targets: a second/late close on an already-closing pool throws.
		// The handles release either way; teardown must NOT surface the error as a failed command.
		await expect(
			closeFetchPool({
				close: () => {
					throw new Error("Cannot close, already closing");
				},
			}),
		).resolves.toBeUndefined();
	});

	it("d-AC-4 the symbol matches Node's built-in undici global-dispatcher key", () => {
		// The fix reaches the real socket pool through this exact well-known symbol — a mismatch
		// would silently no-op against a live fetch pool and reintroduce the crash.
		expect(UNDICI_GLOBAL_DISPATCHER_SYMBOL).toBe(Symbol.for("undici.globalDispatcher.1"));
	});
});

describe("d-AC-4 finalizeCliExit drains the real fetch pool so the loop can empty cleanly", () => {
	it("d-AC-4 after a real fetch, finalizeCliExit closes the pool and the test exits without a hung handle", async () => {
		// Open the real keep-alive pool with a (failing, loopback) fetch so the global dispatcher
		// exists, then prove finalizeCliExit resolves and a subsequent global read shows a closed
		// pool. The deterministic teardown assertion: after finalize, the loop has no lingering
		// keep-alive socket holding it open (the precondition for the racy process.exit crash).
		await fetch("http://127.0.0.1:1/never").catch(() => undefined);
		const before = (globalThis as Record<symbol, unknown>)[UNDICI_GLOBAL_DISPATCHER_SYMBOL] as
			| { closed?: boolean; destroyed?: boolean }
			| undefined;
		expect(before, "a real fetch installs the global undici dispatcher").toBeDefined();

		await expect(finalizeCliExit()).resolves.toBeUndefined();

		const after = (globalThis as Record<symbol, unknown>)[UNDICI_GLOBAL_DISPATCHER_SYMBOL] as
			| { closed?: boolean; destroyed?: boolean }
			| undefined;
		// undici marks the agent closed/destroyed after close() — the socket pool is released.
		expect(after?.closed === true || after?.destroyed === true).toBe(true);
	});
});

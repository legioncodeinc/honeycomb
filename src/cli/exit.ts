/**
 * Deterministic CLI teardown — PRD-022d / d-AC-4 (the Windows libuv exit fix).
 *
 * ── THE BUG ──────────────────────────────────────────────────────────────────
 * A one-shot `honeycomb <verb>` returned its result, then crashed on exit on Windows
 * with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (exit 127). The cause
 * is an abrupt `process.exit(code)` in the bin racing libuv handle teardown: the loopback
 * client dials the daemon over `fetch`, which (on Node's built-in undici) opens a
 * keep-alive socket POOL that lives past the request; and `daemon start` spawns the
 * daemon DETACHED, leaving a child-process handle in the parent's handle table. When
 * `process.exit()` fires while either handle is still mid-close, libuv asserts and the
 * process dies with 127 INSTEAD of the clean exit code — the user sees a crash after a
 * successful command.
 *
 * ── THE FIX (close handles, don't suppress the assertion) ────────────────────
 * The bin no longer calls `process.exit(code)`. It calls {@link finalizeCliExit} to close
 * the undici keep-alive socket pool DETERMINISTICALLY (so its handles are released, not
 * abandoned mid-close), then sets `process.exitCode` and returns. With every long-lived
 * handle either closed (the socket pool) or `unref`'d (the detached child, the runtime-path
 * sweep timer), the event loop drains and Node exits cleanly with the right code — no
 * `process.exit()` race, no `UV_HANDLE_CLOSING`. This is the fix the d-AC-4 implementation
 * note mandates (close handles on exit), not an assertion suppressor.
 *
 * ── Why the global undici dispatcher (and not an `undici` import) ────────────
 * Node 22's built-in `fetch` is undici, but `undici` is NOT an installable dependency here
 * — the dispatcher is reachable only through the well-known global symbol
 * `Symbol.for("undici.globalDispatcher.1")`. We read it defensively: if it is absent (a
 * runtime without the symbol) or has no `close`, teardown is a no-op and the process still
 * exits cleanly. The accessor is injectable so a unit test drives both the present and the
 * absent path without touching the real global.
 */

/** The well-known global key Node's built-in `fetch` stores its undici dispatcher under. */
export const UNDICI_GLOBAL_DISPATCHER_SYMBOL = Symbol.for("undici.globalDispatcher.1");

/** The minimal shape we need off the undici global dispatcher (close the socket pool). */
interface ClosableDispatcher {
	close?: () => Promise<void> | void;
	destroy?: () => Promise<void> | void;
}

/** Read the active undici global dispatcher, or `undefined` when none is installed. */
function readGlobalDispatcher(): ClosableDispatcher | undefined {
	const found = (globalThis as Record<symbol, unknown>)[UNDICI_GLOBAL_DISPATCHER_SYMBOL];
	return found !== null && typeof found === "object" ? (found as ClosableDispatcher) : undefined;
}

/**
 * Close the keep-alive socket pool a `dispatcher` holds so its libuv handles release
 * cleanly (d-AC-4). Prefers `close()` (graceful: lets in-flight requests settle) and falls
 * back to `destroy()`; tolerates a dispatcher that is already closed (a second close throws,
 * which is fine — the goal, released handles, already holds). NEVER throws: a teardown error
 * must not turn a successful command into a failure.
 *
 * Exported pure (the dispatcher is injected) so a test drives the present / absent / throwing
 * paths without mutating the real global.
 */
export async function closeFetchPool(dispatcher: ClosableDispatcher | undefined): Promise<void> {
	if (dispatcher === undefined) return;
	try {
		if (typeof dispatcher.close === "function") {
			await dispatcher.close();
			return;
		}
		if (typeof dispatcher.destroy === "function") {
			await dispatcher.destroy();
		}
	} catch {
		// Already-closed / mid-close dispatcher: the handles are released either way. Swallow —
		// a teardown hiccup must never crash a CLI that already produced its result (d-AC-4).
	}
}

/**
 * Finalize the CLI process for a clean exit (d-AC-4). Closes the undici keep-alive socket
 * pool the loopback `fetch` opened, so the bin can set `process.exitCode` and let the loop
 * drain instead of calling the racy `process.exit()` that trips `UV_HANDLE_CLOSING` on
 * Windows. Idempotent and never throws. Call once, right before setting `process.exitCode`.
 */
export async function finalizeCliExit(): Promise<void> {
	await closeFetchPool(readGlobalDispatcher());
}

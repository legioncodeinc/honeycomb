/**
 * One-shot CLI shutdown: close the global fetch pool, release lingering handles, exit cleanly.
 *
 * ── The bug this fixes (Windows `UV_HANDLE_CLOSING`) ────────────────────────────────────
 * A one-shot HiveDoctor command (`status`, `diagnose`, `update --check`, `logs`,
 * `self-update`) does network work through the Node global `fetch` (registry + blessed-channel
 * reads) and `node:child_process` (npm). On exit it tripped a libuv assertion on Windows:
 *
 *     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
 *
 * The output was already correct and non-mutating - this is purely a dangling-async-handle
 * problem at process exit. Two distinct contributors:
 *
 *   1. undici's global dispatcher keeps a keep-alive connection pool + an internal async/timer
 *      handle alive AFTER a `fetch` resolves.
 *   2. A bare `process.exit()` synchronously tears libuv down. When it runs in the same tick a
 *      handle is mid-close (the undici async handle, or an inherited stdin socket on a piped
 *      stdin), libuv asserts. `process.exit()` is itself the trigger - forcing the exit while a
 *      handle is closing is exactly what aborts.
 *
 * The fast read-only `update --check` path exposed it; the slower update TRANSACTION masked it
 * (it gave the loop time to drain before the bin exited).
 *
 * ── The fix (root cause + graceful natural exit + bounded backstop) ─────────────────────
 * {@link finalizeOneShot}:
 *   1. ROOT CAUSE: close undici's global dispatcher ({@link closeGlobalDispatcher}) so the
 *      keep-alive sockets + pool timer are torn down. Built-ins only, never throws.
 *   2. Release the loop: `unref()` every remaining active handle so nothing (a lingering fetch
 *      socket, an inherited stdin pipe) keeps the process alive.
 *   3. GRACEFUL EXIT: set `process.exitCode` and RETURN, letting Node exit naturally once the
 *      loop drains. We do NOT call `process.exit()` on the happy path - that synchronous
 *      teardown is what trips the assertion.
 *   4. BOUNDED BACKSTOP: arm a single `unref`'d timer that force-calls `process.exit(code)`
 *      ONLY if the loop somehow refuses to drain within the bound. The timer is `unref`'d so it
 *      never itself keeps the process alive; on the happy path the process exits before it fires.
 *
 * ── Scope: ONE-SHOT ONLY ────────────────────────────────────────────────────────────────
 * Wired into the bin's one-shot path ONLY. The long-running `run` watchdog (OS-service entry)
 * exits through its own graceful `doctor.stop()` and must NOT be finalized here ({@link isOneShot}).
 *
 * Built-ins only (zero runtime deps): no undici import, just the global dispatcher symbol + the
 * injected process surface. Every external effect (the close, the unref sweep, the exitCode set,
 * the backstop exit, the timer) is injectable so the exit-path logic is unit-testable without a
 * real `process.exit`.
 */

/** The well-known global-symbol key undici registers its global dispatcher under. */
const UNDICI_GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

/** The single command token that is the long-running watchdog entry, NOT a one-shot. */
const WATCHDOG_COMMAND = "run" as const;

/**
 * True when this invocation is a ONE-SHOT command (the bin should run {@link finalizeOneShot}),
 * false for the long-running `run` watchdog (which exits through its own graceful stop and must
 * NOT be force-exited). The watchdog is the sole exception: every other command - including a
 * bare/help/unknown invocation - is one-shot and benefits from the fetch-pool teardown.
 *
 * @param argv - the argv slice the bin received (`process.argv.slice(2)`), command token first.
 */
export function isOneShot(argv: readonly string[]): boolean {
	return argv[0] !== WATCHDOG_COMMAND;
}

/** The minimal shape we call on the undici dispatcher: a graceful `close()`. Never imported. */
interface ClosableDispatcher {
	close?: () => Promise<void> | void;
	destroy?: (err?: Error) => Promise<void> | void;
}

/**
 * Best-effort close of the Node global `fetch` (undici) connection pool.
 *
 * Reaches the lazily-created global dispatcher via `Symbol.for("undici.globalDispatcher.1")`
 * and calls its `close()` (graceful: drains in-flight, then tears down keep-alive sockets and
 * the pool's internal timer). When no `fetch` has run the symbol is absent and there is nothing
 * to close. NEVER throws and NEVER rejects: a teardown failure must not turn a correct,
 * already-printed result into a crash. Returns true when a close was attempted.
 *
 * @param globalObject - the global object to read the dispatcher symbol from (injectable for tests).
 */
export async function closeGlobalDispatcher(globalObject: typeof globalThis = globalThis): Promise<boolean> {
	const dispatcher = (globalObject as unknown as Record<symbol, unknown>)[UNDICI_GLOBAL_DISPATCHER] as
		| ClosableDispatcher
		| undefined;
	if (dispatcher === undefined || dispatcher === null) return false;
	try {
		// Prefer the graceful close (drains then destroys); fall back to destroy if close is absent.
		if (typeof dispatcher.close === "function") {
			await dispatcher.close();
			return true;
		}
		if (typeof dispatcher.destroy === "function") {
			await dispatcher.destroy();
			return true;
		}
		return false;
	} catch {
		// A best-effort teardown: a failed close must never crash a one-shot that already
		// printed its (correct, non-mutating) output. Swallow and let the exit proceed.
		return false;
	}
}

/** The minimal active-handle shape we touch: an optional `unref()`. */
interface UnreffableHandle {
	unref?: () => void;
}

/**
 * `unref()` every currently-active libuv handle so none of them keeps the process alive after a
 * one-shot command. This is what lets the process exit NATURALLY (without a forced
 * `process.exit()`) even when a lingering fetch socket or an inherited stdin pipe is still open.
 *
 * We only `unref` (mark "do not keep the loop alive") - we deliberately do NOT `destroy()` the
 * handles, because actively destroying a socket creates a NEW closing handle and re-introduces
 * the very assertion we are avoiding. `process._getActiveHandles` is an internal Node API; it is
 * accessed defensively (typeof-guarded, per-handle try/catch) so its absence or any odd handle
 * is a no-op, never a throw. Returns the number of handles it unref'd (for tests/glass-box).
 *
 * @param proc - the process object (injectable for tests; defaults to the real `process`).
 */
export function unrefActiveHandles(proc: NodeJS.Process = process): number {
	const getHandles = (proc as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
	if (typeof getHandles !== "function") return 0;
	let handles: unknown[];
	try {
		handles = getHandles.call(proc);
	} catch {
		return 0;
	}
	let count = 0;
	for (const handle of handles) {
		const h = handle as UnreffableHandle;
		try {
			if (typeof h.unref === "function") {
				h.unref();
				count += 1;
			}
		} catch {
			// An odd handle that resists unref is simply skipped; never throw out of shutdown.
		}
	}
	return count;
}

/** Injectable seams for {@link finalizeOneShot} (all default to production behavior). */
export interface FinalizeOneShotDeps {
	/** Close the fetch pool (default: {@link closeGlobalDispatcher}). Bounded by `settleTimeoutMs`. */
	readonly closeDispatcher?: () => Promise<unknown>;
	/** Unref remaining active handles so the loop can drain (default: {@link unrefActiveHandles}). */
	readonly unrefHandles?: () => void;
	/** Set the natural-exit code (default: assigns `process.exitCode`). */
	readonly setExitCode?: (code: number) => void;
	/**
	 * Hard backstop exit, used ONLY if the loop refuses to drain within `forceExitAfterMs`
	 * (default: `process.exit`). Tests inject a spy so no process dies.
	 */
	readonly forceExit?: (code: number) => void;
	/**
	 * Upper bound (ms) on the pool-close step so finalize can NEVER hang. The graceful close
	 * resolves promptly in practice; this is the can't-hang guarantee. Default 1500ms.
	 */
	readonly settleTimeoutMs?: number;
	/**
	 * How long (ms) to wait for a natural exit before the `unref`'d backstop force-exits. Default
	 * 2000ms. On the happy path the process exits long before this fires.
	 */
	readonly forceExitAfterMs?: number;
	/** Timer seam (default: the global timers). Injectable so a test drives it deterministically. */
	readonly setTimeoutFn?: (fn: () => void, ms: number) => { unref?: () => void };
	readonly clearTimeoutFn?: (handle: unknown) => void;
}

/** The default bound on the pool-close step. The close is fast; this just guarantees no hang. */
export const DEFAULT_SETTLE_TIMEOUT_MS = 1_500 as const;

/** The default wait for a natural exit before the unref'd backstop forces it. */
export const DEFAULT_FORCE_EXIT_AFTER_MS = 2_000 as const;

/**
 * Finalize a ONE-SHOT CLI invocation: close the fetch pool (root-cause teardown, bounded so it
 * can never hang), release lingering handles, then exit GRACEFULLY by letting the loop drain -
 * with a single `unref`'d backstop timer that force-exits only if natural exit never happens.
 *
 * Calling `process.exit()` directly is what trips the Windows `UV_HANDLE_CLOSING` assertion (the
 * synchronous teardown races a handle that is mid-close), so the happy path NEVER force-exits:
 * it closes undici's pool, unrefs every remaining handle, sets `process.exitCode`, and returns.
 *
 * Only the one-shot path calls this. The `run` watchdog exits through its own graceful stop.
 *
 * @param code - the exit code the dispatcher resolved.
 * @param deps - injectable seams (close, unref, exit-code, backstop, timers) for unit testing.
 */
export async function finalizeOneShot(code: number, deps: FinalizeOneShotDeps = {}): Promise<void> {
	const closeDispatcher = deps.closeDispatcher ?? closeGlobalDispatcher;
	const unrefHandles = deps.unrefHandles ?? ((): void => void unrefActiveHandles());
	const setExitCode =
		deps.setExitCode ??
		((c: number): void => {
			process.exitCode = c;
		});
	const forceExit = deps.forceExit ?? ((c: number): void => void process.exit(c));
	const settleTimeoutMs = deps.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
	const forceExitAfterMs = deps.forceExitAfterMs ?? DEFAULT_FORCE_EXIT_AFTER_MS;
	const setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms): { unref?: () => void } => setTimeout(fn, ms));
	const clearTimeoutFn = deps.clearTimeoutFn ?? ((h): void => clearTimeout(h as ReturnType<typeof setTimeout>));

	// Step 1 (root cause): close the fetch pool, bounded so a wedged socket teardown can never
	// hang the exit. The close should win immediately; either way we proceed.
	let settleTimer: unknown;
	const bounded = new Promise<void>((resolve) => {
		settleTimer = setTimeoutFn(() => resolve(), settleTimeoutMs);
		// The bound is a guardrail only - it must not itself keep the loop alive.
		(settleTimer as { unref?: () => void }).unref?.();
	});
	try {
		await Promise.race([Promise.resolve(closeDispatcher()).then(() => undefined), bounded]);
	} catch {
		// closeDispatcher is already fail-soft; belt-and-suspenders so finalize never throws.
	} finally {
		clearTimeoutFn(settleTimer);
	}

	// Step 2: release every remaining handle so nothing keeps the loop alive (lingering fetch
	// socket, inherited stdin pipe). unref only - never destroy (destroying re-creates a closing
	// handle and re-introduces the assertion).
	try {
		unrefHandles();
	} catch {
		// Defensive: the unref sweep is best-effort and must never throw out of shutdown.
	}

	// Step 3 (graceful): set the code and let Node exit naturally. NO process.exit() here - that
	// synchronous teardown is the assertion trigger.
	setExitCode(code);

	// Step 4 (bounded backstop): if the loop somehow refuses to drain, force the exit. The timer
	// is unref'd so on the happy path the process exits first and this never fires.
	const backstop = setTimeoutFn(() => forceExit(code), forceExitAfterMs);
	backstop.unref?.();
}

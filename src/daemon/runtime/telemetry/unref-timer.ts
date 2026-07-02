/**
 * A tiny shared helper: `unref()` a `setInterval` handle when the runtime exposes it, so a
 * telemetry heartbeat/flush timer never keeps the process alive on its own. Shared by
 * `checkin.ts` and `metrics.ts` so the (environment-dependent, structurally-typed) `unref` check
 * has exactly one definition.
 */
export function unrefTimer(timer: ReturnType<typeof setInterval>): void {
	const maybeUnref = timer as unknown as { unref?: () => void };
	if (typeof maybeUnref.unref === "function") maybeUnref.unref();
}

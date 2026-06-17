/**
 * Shim-side capture gate — PRD-005a establishes the STUB, PRD-005c FILLS it.
 *
 * ── WHERE THIS RUNS (read before filling) ────────────────────────────────────
 * This module is SHIM-SIDE: the harness hook shim runs it IN-PROCESS, in the
 * harness, BEFORE it ever dials the daemon's `/api/hooks/capture` endpoint. It
 * decides whether a turn event should be captured AT ALL. When the gate says
 * skip, the shim makes NO daemon request and NO `sessions` row is written
 * (c-AC-6).
 *
 * Because it runs inside thin-client harness bundles (including the OpenClaw
 * bundle that ClawHub statically scans), it MUST stay free of the daemon /
 * DeepLake / storage path: it imports NOTHING from `src/daemon`. It lives under
 * `src/shared` precisely so a harness shim can import it without pulling the
 * storage path into a thin-client bundle (the daemon-only invariant test stays
 * green; `npm run audit:openclaw` stays clean). DO NOT add a `src/daemon` import
 * here, and DO NOT read `process.env` adjacent to a network send in this file —
 * the gate DECIDES; the shim performs the (guarded) daemon call.
 *
 * ── WHAT 005c FILLS (the Wave-2 contract) ────────────────────────────────────
 * 005c replaces the permissive stub bodies of {@link shouldCapture} and
 * {@link runCaptureGuarded} with the real guard logic, WITHOUT changing these
 * signatures (the shim wiring in a later PRD imports them by name):
 *
 *   - **bypass switch (c-AC-1 / D-2):** `HONEYCOMB_CAPTURE === "false"` disables
 *     capture; any other value / unset = enabled. A config/header seam covers
 *     harnesses without an env channel — surfaced via {@link CaptureGateEnv}.
 *   - **plugin-enabled (c-AC-2):** a disabled plugin → skip.
 *   - **entrypoint (c-AC-3):** a non-capture entrypoint (e.g. a hook event that
 *     is not a capture trigger) → skip.
 *   - **recursion guard (c-AC-4 / D-5):** the summary/skillify worker sets an env
 *     marker (e.g. `HONEYCOMB_WORKER=1`) when it spawns the harness CLI; the gate
 *     suppresses capture when that marker is present, so a worker's own activity
 *     is never captured as a new turn.
 *   - **fail-soft (c-AC-5):** {@link runCaptureGuarded} wraps the capture call so
 *     ANY error (gate or capture) is swallowed/logged and the harness turn
 *     proceeds — a capture failure never breaks the agent's turn.
 *
 * 005c's tests are pure in-process unit tests of THIS module (bypass / plugin /
 * entrypoint / recursion / fail-soft), asserting NO daemon call when skipped.
 * Its module + test live at `src/shared/capture-gate.ts` (here) and
 * `tests/shared/capture-gate.test.ts` (new). 005c MUST NOT break this module's
 * exported shape, and MUST NOT introduce a daemon/storage import.
 */

/**
 * The environment the gate reads, passed in EXPLICITLY rather than read from
 * `process.env` inside the gate. Passing it in keeps the gate a pure function
 * (trivially unit-testable, c-AC-1..4) AND keeps an env read out of this
 * thin-client module so the OpenClaw static scan never sees a `process.env`
 * adjacent to a network send. The shim (which owns the daemon call) resolves
 * these from its own env/config/header channel and hands them to the gate.
 */
export interface CaptureGateEnv {
	/**
	 * The bypass switch (D-2). `"false"` disables capture; any other value or
	 * `undefined` leaves it enabled. The shim sources this from
	 * `HONEYCOMB_CAPTURE` (env harnesses) or a config/header (non-env harnesses).
	 */
	readonly captureFlag?: string;
	/** Whether the Honeycomb plugin is enabled for this harness (c-AC-2). */
	readonly pluginEnabled?: boolean;
	/**
	 * The recursion-guard marker (D-5). When set (e.g. `"1"`), a summary/skillify
	 * worker is running the harness CLI and its activity must NOT be captured
	 * (c-AC-4). The shim sources this from `HONEYCOMB_WORKER`.
	 */
	readonly workerMarker?: string;
}

/** The per-turn context the gate inspects (entrypoint, hook event, etc.). */
export interface CaptureGateContext {
	/**
	 * The entrypoint / hook event name that triggered this shim invocation. 005c
	 * uses it for the non-capture-entrypoint skip (c-AC-3). Optional so the stub
	 * and early shims compile without it.
	 */
	readonly entrypoint?: string;
}

/** The gate decision: capture or skip, with a machine-readable reason when skipped. */
export interface CaptureDecision {
	/** True → the shim proceeds to the daemon capture call; false → it skips. */
	readonly capture: boolean;
	/**
	 * Why capture was skipped (`"bypass"` / `"plugin-disabled"` /
	 * `"non-capture-entrypoint"` / `"recursion-guard"`), or `undefined` when
	 * capturing. For diagnostics; never surfaced to the agent's turn.
	 */
	readonly reason?: string;
}

/**
 * The hook entrypoints that ARE capture triggers (c-AC-3). A shim invocation
 * whose `ctx.entrypoint` is set but NOT in this set is skipped — only these
 * events carry the payload that belongs in `sessions`. When `entrypoint` is
 * absent (undefined) the check is bypassed so early shims that do not yet
 * populate the field remain compatible.
 *
 * These names match the `hookEventName` values the capture handler records
 * (event-contract.ts) and the harness hook lifecycle names. This constant is
 * declared here — in `src/shared` — so the gate stays free of any
 * `src/daemon` import (thin-client bundle safety).
 */
export const CAPTURE_ENTRYPOINTS: ReadonlySet<string> = new Set([
	"user_message",
	"tool_call",
	"assistant_message",
]);

/**
 * Decide whether this turn event should be captured.
 *
 * Evaluates four guards in priority order:
 * 1. Bypass switch (c-AC-1 / D-2): `captureFlag === "false"` → skip.
 * 2. Plugin-enabled (c-AC-2): `pluginEnabled === false` → skip.
 * 3. Entrypoint check (c-AC-3): `ctx.entrypoint` set and not in
 *    {@link CAPTURE_ENTRYPOINTS} → skip. Absent = bypass (backward-compatible).
 * 4. Recursion guard (c-AC-4 / D-5): truthy `workerMarker` → skip.
 *
 * Pure and synchronous: no env read, no I/O, no daemon import.
 */
export function shouldCapture(env: CaptureGateEnv, ctx: CaptureGateContext = {}): CaptureDecision {
	// Bypass switch (c-AC-1 / D-2): `"false"` disables; any other value/unset = on.
	if (env.captureFlag === "false") {
		return { capture: false, reason: "bypass" };
	}
	// Plugin-enabled (c-AC-2): a disabled plugin must not capture.
	if (env.pluginEnabled === false) {
		return { capture: false, reason: "plugin-disabled" };
	}
	// Entrypoint check (c-AC-3): when the hook event name is set, only recognised
	// capture entrypoints proceed; unrecognised hook events are skipped. When the
	// field is absent the check is bypassed (backward-compatible with early shims).
	if (ctx.entrypoint !== undefined && !CAPTURE_ENTRYPOINTS.has(ctx.entrypoint)) {
		return { capture: false, reason: "non-capture-entrypoint" };
	}
	// Recursion guard (c-AC-4 / D-5): a worker running the CLI must not self-capture.
	if (env.workerMarker !== undefined && env.workerMarker !== "" && env.workerMarker !== "0") {
		return { capture: false, reason: "recursion-guard" };
	}
	return { capture: true };
}

/**
 * Fail-soft wrapper (c-AC-5): run the gate, and only when it says capture, run
 * the supplied `capture` action — swallowing ANY error so the harness turn is
 * never broken by a capture failure (005c hardens the logging/telemetry).
 *
 * Returns the {@link CaptureDecision} so the shim can log/branch, while
 * guaranteeing it never rejects: a thrown gate or a thrown capture action is
 * caught and reported through the optional `onError` sink, then the turn
 * proceeds. When the gate skips, `capture` is NEVER invoked (c-AC-6: no daemon
 * call, no `sessions` row).
 *
 * `capture` is the shim's daemon call (it owns the network send + the env read
 * for the request); this wrapper only decides + guards, so this module stays
 * thin-client-safe.
 */
export async function runCaptureGuarded(
	env: CaptureGateEnv,
	ctx: CaptureGateContext,
	capture: () => void | Promise<void>,
	onError?: (err: unknown) => void,
): Promise<CaptureDecision> {
	let decision: CaptureDecision;
	try {
		decision = shouldCapture(env, ctx);
	} catch (err) {
		// A gate that throws must not break the turn: fail soft to "skip".
		onError?.(err);
		return { capture: false, reason: "gate-error" };
	}

	if (!decision.capture) return decision;

	try {
		await capture();
	} catch (err) {
		// A capture failure (network, daemon, serialization) never breaks the turn.
		onError?.(err);
	}
	return decision;
}

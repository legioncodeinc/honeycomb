/**
 * Per-turn capture core — PRD-019b Wave 2 (b-AC-1 / b-AC-2 / b-AC-6 / FR-4 / FR-7).
 *
 * Per-turn capture sends ONE request per event and the daemon writes one row per
 * event to the `sessions` table (FR-4). Each request carries session metadata
 * (session id, cwd, permission mode, hook event name, agent id) and an optional
 * `message_embedding` vector. On a missing-table error the daemon side creates the
 * table and retries once — the hook just re-sends.
 *
 * The capture gate (`HONEYCOMB_CAPTURE !== "false"`) and the only-CLI-entrypoint
 * check guard this path (FR-10). REUSE `src/shared/capture-gate.ts`
 * ({@link runCaptureGuarded}) — when the gate says skip, NO daemon request is made
 * and NO `sessions` row is written (c-AC-6). This module re-exports the gate so the
 * shim wires capture through one import.
 *
 * THIN CLIENT: the capture call is a daemon POST through {@link HookCoreDeps.daemon}
 * to `/api/hooks/capture`; this module opens NO DeepLake and builds NO SQL (b-AC-2).
 *
 * Partial-vocabulary completeness (FR-7 / b-AC-1): {@link runCaptureBatch} normalizes
 * a SLICE of events down to one {@link HookInput} per event and dispatches each — the
 * daemon writes one row per event, so a harness that only fires `agent_end`
 * (OpenClaw) produces the SAME daemon-written rows as one that captures incrementally.
 */

import {
	type CaptureGateContext,
	type CaptureGateEnv,
	runCaptureGuarded,
} from "../../shared/capture-gate.js";
import {
	type DaemonHookResponse,
	type HookCoreDeps,
	type HookInput,
	type HookResult,
} from "./contracts.js";

// Re-export the shared gate so a shim wires capture through one import surface.
export { runCaptureGuarded, type CaptureGateContext, type CaptureGateEnv };

/** The daemon `/api/hooks/capture` sub-path (relative to the `/api/hooks` group). */
export const CAPTURE_ENDPOINT = "capture" as const;

/** The runtime-path conflict status the daemon returns (b-AC-6 / FR-8). */
export const RUNTIME_PATH_CONFLICT = 409 as const;

/**
 * Build the `/api/hooks/capture` request body for one normalized event. The body
 * is the daemon's `CaptureRequest` shape (`{ event, metadata }`,
 * `src/daemon/runtime/capture/event-contract.ts`): the shim's `HookInput.data` is
 * the normalized event (`{ kind, ... }`) — forwarded VERBATIM so the daemon's zod
 * boundary validates it, not the hook (FR-2). The session metadata maps onto the
 * daemon's `CaptureMetadata`; `message_embedding` rides along when present (FR-4).
 *
 * The hook does NOT re-type the event per harness — `data` is `unknown` and the
 * daemon owns the discriminated union. This keeps the core agent-agnostic.
 */
export function buildCaptureBody(input: HookInput): unknown {
	return {
		event: input.data,
		metadata: {
			...input.meta,
			...(input.messageEmbedding !== undefined ? { messageEmbedding: input.messageEmbedding } : {}),
		},
	};
}

/**
 * Capture one normalized turn event (FR-4 / b-AC-2). Runs the capture gate, and
 * only when it says capture, POSTs the event to `/api/hooks/capture` through the
 * daemon seam stamping `x-honeycomb-runtime-path` (FR-8). When the gate skips,
 * makes NO daemon call (c-AC-6) and returns `ok: true` with the skip reason.
 *
 * Fail-soft (FR-10): a daemon error never throws out of here — `runCaptureGuarded`
 * swallows it and the turn proceeds. A `409` runtime-path conflict (b-AC-6) is
 * surfaced as `ok: false, reason: "runtime-path-conflict"` so the shim can branch,
 * but it is NOT thrown.
 *
 * THIN CLIENT: the only outbound path is `deps.daemon.send` — no SQL, no DeepLake.
 */
export async function runCapture(
	input: HookInput,
	deps: HookCoreDeps,
	env: CaptureGateEnv,
	ctx: CaptureGateContext = {},
): Promise<HookResult> {
	let conflict = false;
	let dispatched = false;

	const decision = await runCaptureGuarded(env, withEntrypoint(input, ctx), async () => {
		dispatched = true;
		const response = await dispatchCapture(input, deps);
		if (response.status === RUNTIME_PATH_CONFLICT) conflict = true;
	});

	// Gate skipped → no daemon call was made (c-AC-6); report the skip reason.
	if (!decision.capture) {
		return { ok: true, reason: decision.reason };
	}
	// Capture ran. A 409 is the runtime-path conflict (b-AC-6) — surfaced, not thrown.
	if (conflict) {
		return { ok: false, reason: "runtime-path-conflict" };
	}
	// `dispatched` stays false only if the gate-wrapper swallowed an error before the
	// send; either way the turn proceeded. Report ok when the dispatch completed.
	return { ok: dispatched };
}

/**
 * Capture a BATCH of normalized events at session end (FR-7 / b-AC-1). A harness
 * with a partial event vocabulary (e.g. OpenClaw's `agent_end` message slice)
 * flushes its whole turn here: each event is dispatched through {@link runCapture}
 * with the SAME gate + seam, so the daemon writes one row per event — IDENTICAL to
 * incremental capture, just grouped into one flush. Returns one {@link HookResult}
 * per input in order, so the shim can report per-event outcomes.
 */
export async function runCaptureBatch(
	inputs: readonly HookInput[],
	deps: HookCoreDeps,
	env: CaptureGateEnv,
	ctx: CaptureGateContext = {},
): Promise<readonly HookResult[]> {
	const results: HookResult[] = [];
	for (const input of inputs) {
		// Sequential so the daemon writes the rows in turn order (the conversation
		// stream reconstructs by `creation_date`); a parallel flush could reorder.
		results.push(await runCapture(input, deps, env, ctx));
	}
	return results;
}

/** POST the capture event to `/api/hooks/capture`, stamping the runtime-path header. */
async function dispatchCapture(input: HookInput, deps: HookCoreDeps): Promise<DaemonHookResponse> {
	return deps.daemon.send({
		endpoint: CAPTURE_ENDPOINT,
		body: buildCaptureBody(input),
		meta: input.meta,
		runtimePath: input.runtimePath,
	});
}

/**
 * Thread the logical event name into the gate context's `entrypoint` when the shim
 * has not set one, so the gate's non-capture-entrypoint check (c-AC-3) sees the
 * event that fired. The shim's explicit `ctx.entrypoint` wins when supplied.
 */
function withEntrypoint(input: HookInput, ctx: CaptureGateContext): CaptureGateContext {
	if (ctx.entrypoint !== undefined) return ctx;
	return { ...ctx, entrypoint: input.event };
}

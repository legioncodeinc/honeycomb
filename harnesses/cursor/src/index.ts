/**
 * Cursor harness adapter entry root — PRD-046d (the cursor hook binary).
 *
 * Cursor's native lifecycle events (`sessionStart`, `beforeSubmitPrompt`,
 * `beforeShellExecution`, `postToolUse`, `afterAgentResponse`/`stop`, `sessionEnd`)
 * invoke THIS bundle once per event (the handlers `install-cursor`/`CursorConnector`
 * wires into `~/.cursor/hooks.json` point at it), piping the native hook JSON on stdin.
 * The binary drives the SAME shared pipeline the claude-code reference binary uses —
 * only the shim differs (the "shim swap" the shared runtime was built for):
 *
 *   native Cursor hook payload (stdin/JSON)
 *     → 019c cursor shim `normalize`   (`createCursorShim`)
 *     → 019b core                       (`runSessionStart`/`runCapture`/`runPreToolUse`/`runSessionEnd`)
 *     → production seams                (loopback POST `/api/hooks/*`; on session-start the
 *                                        PRD-046d prime renderer GETs `/api/memories/prime`)
 *
 * via the SHARED {@link runHookBinary} driver + {@link createHookRuntime} runtime. On
 * `sessionStart` the runtime fetches the 046c digest ONCE and threads it into the cursor
 * shim's MODEL-ONLY `additional_context` channel, so Cursor sees the Tier-1 index at turn
 * one (d-AC-2). Thin client only: no DeepLake; the only outbound path is loopback.
 *
 * The legacy {@link activate} export is retained so any non-hook caller that imported it
 * keeps compiling; the hook lifecycle now runs through {@link runCursorHook}.
 */

import { createCursorShim } from "../../../src/hooks/cursor/shim.js";
import { maybeRunHookBinaryMain, runHookBinary } from "../../../src/hooks/binary.js";
import type { HookEventOutcome } from "../../../src/hooks/runtime.js";
import { bootHarness, type HarnessContext } from "../../../src/daemon-client/harness.js";

/**
 * Legacy harness-context activation (PRD-001b). Retained so any non-hook caller that
 * imported `activate()` keeps compiling; the hook lifecycle now runs through
 * {@link runCursorHook}.
 */
export function activate(): HarnessContext {
	return bootHarness("cursor");
}

/**
 * Drive ONE Cursor hook invocation end-to-end (PRD-046d). Reads the native hook JSON off
 * stdin, normalizes it through the cursor shim, runs the 019b core (which fetches +
 * injects the prime on session-start), and POSTs through the production seams. Fail-soft:
 * always resolves.
 */
export async function runCursorHook(): Promise<HookEventOutcome> {
	return runHookBinary({ shim: createCursorShim() });
}

// Production: when invoked as the bundled binary, drive the hook from stdin (the path the
// native `hooks.json` invokes). Never on import — a test imports `runCursorHook`.
maybeRunHookBinaryMain(createCursorShim(), import.meta.url);

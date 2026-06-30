/**
 * Grok harness adapter entry root — thin client over the shared hook-binary driver.
 *
 * Grok Build invokes bundled handlers from `~/.grok/hooks/honeycomb.json` with
 * Claude/Codex-compatible lifecycle events on stdin. This binary reuses the SAME
 * {@link runHookBinary} driver as Codex — only {@link createGrokShim} differs.
 */

import { maybeRunHookBinaryMain, runHookBinary } from "../../../src/hooks/binary.js";
import { createGrokShim } from "../../../src/hooks/grok/shim.js";
import type { HookEventOutcome } from "../../../src/hooks/runtime.js";
import { bootHarness, type HarnessContext } from "../../../src/daemon-client/harness.js";

/** Legacy harness-context activation for non-hook callers. */
export function activate(): HarnessContext {
	return bootHarness("grok");
}

/** Drive one Grok hook invocation end-to-end. Fail-soft: always resolves. */
export async function runGrokHook(): Promise<HookEventOutcome> {
	return runHookBinary({ shim: createGrokShim() });
}

maybeRunHookBinaryMain(createGrokShim(), import.meta.url);

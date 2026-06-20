/**
 * Codex harness adapter entry root — PRD-021c Wave 2 (c-AC-6, the second harness fast-follow).
 *
 * Codex is the FAST-FOLLOW that PROVES the runtime is SHARED, not re-derived (c-AC-6).
 * This binary is the SAME pipeline as the Claude Code reference
 * (`harnesses/claude-code/src/index.ts`) — it differs ONLY in the {@link createCodexShim}
 * it passes to the SHARED {@link runHookBinary} driver:
 *
 *   native Codex hook payload (stdin/JSON)
 *     → 019c codex shim `normalize`   (`createCodexShim`: Bash-only intercept, user-visible login line)
 *     → 019b core                      (the SAME `runSessionStart`/`runCapture`/…)
 *     → production `DaemonHookClient`  (the SAME loopback POST client + `CredentialReader` + `ContextRenderer`)
 *
 * Adding a third harness is the same: a thin binary with its own shim. Thin client
 * only: no DeepLake; the only outbound path is the daemon client over loopback.
 */

import { createCodexShim } from "../../../src/hooks/codex/shim.js";
import { maybeRunHookBinaryMain, runHookBinary } from "../../../src/hooks/binary.js";
import type { HookEventOutcome } from "../../../src/hooks/runtime.js";
import { bootHarness, type HarnessContext } from "../../../src/daemon-client/harness.js";

/**
 * Legacy harness-context activation (PRD-001b). Retained for any non-hook caller that
 * imported `activate()`; the hook lifecycle now runs through {@link runCodexHook}.
 */
export function activate(): HarnessContext {
	return bootHarness("codex");
}

/**
 * Drive ONE Codex hook invocation end-to-end (c-AC-6). Reuses the SAME shared runtime
 * + driver as the Claude Code reference — only the shim differs. Fail-soft: always
 * resolves.
 */
export async function runCodexHook(): Promise<HookEventOutcome> {
	return runHookBinary({ shim: createCodexShim() });
}

// Production: when invoked as the bundled binary, drive the hook from stdin. Never on import.
maybeRunHookBinaryMain(createCodexShim(), import.meta.url);

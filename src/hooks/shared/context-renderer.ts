/**
 * Context renderer core — PRD-019b Wave 2 (FR-3 / FR-10 / b-AC-3).
 *
 * The context renderer produces the rules/goals `additionalContext` block
 * session-start returns (FR-3 / FR-10 / b-AC-3). It is READ-ONLY and ABSORBS its
 * own errors — a render failure returns `""` (an empty block), NEVER a throw, so
 * session-start never breaks the turn (FR-10).
 *
 * THIN CLIENT: the block is assembled from daemon-supplied rules/goals through the
 * {@link DaemonHookClient} seam; this module opens NO DeepLake and builds NO SQL
 * (D-2). The CHANNEL the block lands through (model-only vs user-visible) is a 019c
 * shim concern (c-AC-5) — this core just produces the text.
 */

import type { ContextRenderer, ContextRenderRequest, DaemonHookClient } from "./contracts.js";

/** The daemon `/api/hooks/context` sub-path (relative to the `/api/hooks` group). */
export const CONTEXT_ENDPOINT = "context" as const;

/**
 * Build the real {@link ContextRenderer} (FR-3 / FR-10). Asks the daemon (through
 * the seam) for the rules/goals block under the request's scope and assembles the
 * `additionalContext` text. READ-ONLY and FAIL-SOFT: ANY error — a rejected
 * dispatch, a non-200 status, a malformed body — resolves to `""`, never a throw,
 * so a render failure never breaks session-start (FR-10).
 *
 * The daemon owns the actual rules/goals content; this core only requests it and
 * coerces the response body to text. It interprets a string body verbatim, an
 * object body's `additionalContext`/`context`/`block` field when present, and
 * anything else as the empty block.
 */
export function createContextRenderer(daemon: DaemonHookClient): ContextRenderer {
	return {
		async render(req: ContextRenderRequest): Promise<string> {
			try {
				const response = await daemon.send({
					endpoint: CONTEXT_ENDPOINT,
					body: { meta: req.meta, hasCredential: req.credential !== undefined },
					meta: req.meta,
					// Context render rides the same runtime path the session uses. The daemon
					// enforces the path — this is a read, so a conflict simply yields "".
					runtimePath: req.runtimePath ?? "plugin",
				});
				if (response.status !== 200) return "";
				return coerceBlock(response.body);
			} catch {
				// Read-only, fail-soft (FR-10): never let a render error break the turn.
				return "";
			}
		},
	};
}

/** Coerce a daemon context response body to the block text (unknown shapes → ""). */
function coerceBlock(body: unknown): string {
	if (typeof body === "string") return body;
	if (body !== null && typeof body === "object") {
		const rec = body as Record<string, unknown>;
		for (const key of ["additionalContext", "context", "block"] as const) {
			const value = rec[key];
			if (typeof value === "string") return value;
		}
	}
	return "";
}

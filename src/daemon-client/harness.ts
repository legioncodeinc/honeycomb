/**
 * Shared harness bootstrap.
 *
 * Every harness adapter entry (claude-code, codex, cursor, hermes, pi,
 * openclaw) calls this one helper so the per-harness entry files stay thin and
 * do not duplicate boot logic. Centralizing here is what keeps the six entries
 * under the jscpd duplication threshold (FR-7). Thin-client only: no DeepLake.
 */

import { createDaemonClient, type DaemonClient } from "./index.js";

/** Identity + live daemon client for one harness adapter. */
export interface HarnessContext {
	harness: string;
	client: DaemonClient;
}

/** Boot a harness adapter against the local daemon. */
export function bootHarness(harness: string): HarnessContext {
	return { harness, client: createDaemonClient() };
}

/**
 * Embed daemon entry root.
 *
 * A separate long-lived process that generates embedding vectors for the
 * daemon. Build-order tier "plugins/native" — it sits below the connectors and
 * imports only shared constants, not the daemon core or DeepLake. Independently
 * addressable by the bundler (PRD-001b). Real model/runtime lands in a later
 * PRD; this stub fixes the entry root.
 */

import { HONEYCOMB_VERSION } from "../../src/shared/constants.js";

export interface EmbedDaemonInfo {
	version: string;
}

/** Return embed-daemon info without starting it. */
export function embedDaemonInfo(): EmbedDaemonInfo {
	return { version: HONEYCOMB_VERSION };
}

/** Start the embed daemon. Stub: real warmup/IPC lands later. */
export async function startEmbedDaemon(): Promise<EmbedDaemonInfo> {
	return embedDaemonInfo();
}

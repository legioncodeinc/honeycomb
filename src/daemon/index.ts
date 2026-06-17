/**
 * Daemon core entry root.
 *
 * The long-lived process that owns durable state. This is the ONLY package that
 * will link the DeepLake client; every other target reaches it through the thin
 * `src/daemon-client` surface. Keeping DeepLake imports confined here is what
 * lets PRD-001b emit a daemon-only DeepLake bundle (index AC-2).
 *
 * Stub only: real daemon runtime, hooks, and persistence land in later PRDs.
 */

import { DAEMON_HOST, DAEMON_PORT, HONEYCOMB_VERSION } from "../shared/constants.js";

// DeepLake access path lives here (PRD-002). Do NOT add a DeepLake import in any
// non-daemon package; harness/CLI/MCP bundles must stay DeepLake-free.
//
// PRD-002a: the storage adapter (DeepLake client/config/transport/result-union)
// lives under ./storage and is re-exported ONLY from this daemon root, so the
// DeepLake path is reachable solely inside the daemon bundle (a-AC-5).
export * from "./storage/index.js";

/** Static description of the daemon process, derived from shared constants. */
export interface DaemonInfo {
	host: string;
	port: number;
	version: string;
}

/** Return the daemon's bind info without starting it. */
export function daemonInfo(): DaemonInfo {
	return { host: DAEMON_HOST, port: DAEMON_PORT, version: HONEYCOMB_VERSION };
}

/** Start the daemon. Stub: real lifecycle (listen, persistence) lands later. */
export async function startDaemon(): Promise<DaemonInfo> {
	return daemonInfo();
}

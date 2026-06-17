/**
 * Thin daemon client.
 *
 * This is the ONLY surface that harnesses, the MCP server, and the CLI import
 * to reach Honeycomb. It speaks to the long-lived daemon over loopback
 * (DAEMON_HOST:DAEMON_PORT) and carries NO DeepLake access path. The DeepLake
 * client lives exclusively in `src/daemon` (PRD-002), so no non-daemon bundle
 * can transitively pull it in through this module.
 *
 * Stub only: the wire protocol and real transport land in a later PRD. The
 * shape exists so per-target bundles have a stable, DeepLake-free import.
 */

import { DAEMON_HOST, DAEMON_PORT } from "../shared/constants.js";

/** Connection target for the daemon, derived from the single source of truth. */
export interface DaemonEndpoint {
	host: string;
	port: number;
}

/** A thin client bound to one daemon endpoint. */
export interface DaemonClient {
	readonly endpoint: DaemonEndpoint;
	/** Liveness probe against the daemon. Real transport lands in a later PRD. */
	ping(): Promise<boolean>;
}

/**
 * Construct a thin client pointed at the local daemon. Accepts an optional
 * endpoint override for tests; defaults to the shared loopback constants.
 */
export function createDaemonClient(endpoint?: Partial<DaemonEndpoint>): DaemonClient {
	const resolved: DaemonEndpoint = {
		host: endpoint?.host ?? DAEMON_HOST,
		port: endpoint?.port ?? DAEMON_PORT,
	};
	return {
		endpoint: resolved,
		async ping(): Promise<boolean> {
			// Stub: no transport yet. Returns false until the daemon RPC lands.
			return false;
		},
	};
}

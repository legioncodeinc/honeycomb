/**
 * MCP server entry root.
 *
 * Thin client only: reaches Honeycomb through the daemon-client surface, never
 * the daemon core or any DeepLake path. Independently addressable by the
 * bundler (PRD-001b). Real tool registration (zod-validated) lands in a later
 * PRD; this stub exists so the MCP bundle has a stable, DeepLake-free entry.
 */

import { createDaemonClient, type DaemonClient } from "../../src/daemon-client/index.js";
import { HONEYCOMB_VERSION } from "../../src/shared/constants.js";

export interface McpServerHandle {
	version: string;
	client: DaemonClient;
}

/** Construct the MCP server handle. Stub: no transport wired yet. */
export function createMcpServer(): McpServerHandle {
	return { version: HONEYCOMB_VERSION, client: createDaemonClient() };
}

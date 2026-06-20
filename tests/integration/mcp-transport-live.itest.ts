/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE MCP-TRANSPORT SMOKE — SPAWNS THE BUILT mcp/bundle/server.js          ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-021e (e-AC-2 / e-AC-6). This is the smoke that closes the earlier      ║
 * ║  "imports clean but doesn't serve" finding: it spawns the ACTUAL built      ║
 * ║  bundle as a stdio subprocess, drives a REAL JSON-RPC `initialize` +        ║
 * ║  `tools/list` over stdio with the MCP SDK client, and asserts:             ║
 * ║    - the server ANSWERS `initialize` (negotiates name + capabilities),     ║
 * ║    - the unified `honeycomb_` tool surface is present in `tools/list`.     ║
 * ║                                                                          ║
 * ║  It tests the TRANSPORT, not DeepLake: `initialize` and `tools/list` never  ║
 * ║  touch the daemon API, so NO `HONEYCOMB_DEEPLAKE_TOKEN` is needed. It runs  ║
 * ║  UNCONDITIONALLY when the bundle is present.                               ║
 * ║                                                                          ║
 * ║  BUILD-AWARE: it spawns `mcp/bundle/server.js`, so it needs `npm run build`  ║
 * ║  first. If the bundle is missing, the whole suite SKIPS clean (exit 0) — a  ║
 * ║  credential-less, un-built machine never fails on it.                      ║
 * ║                                                                          ║
 * ║  DETERMINISTIC + BOUNDED: stdio (no port to collide on), a hard test        ║
 * ║  timeout, and a guaranteed child kill in teardown.                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { TOOL_NAMES } from "../../mcp/src/index.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BUNDLE_PATH = `${REPO_ROOT}mcp/bundle/server.js`;
const BUNDLE_BUILT = existsSync(BUNDLE_PATH);

describe.skipIf(!BUNDLE_BUILT)(
	"LIVE MCP TRANSPORT: the built mcp/bundle/server.js answers initialize + lists honeycomb_ tools",
	() => {
		let client: Client | null = null;

		afterAll(async () => {
			// Closing the client closes the stdio transport, which kills the spawned child.
			if (client !== null) await client.close().catch(() => {});
			client = null;
		});

		it(
			"e-AC-2/e-AC-6 spawns the bundle over stdio, initialize answers, tools/list has the honeycomb_ surface",
			async () => {
				// Spawn the ACTUAL built bundle as a stdio subprocess — the same binary a
				// harness launches. The MCP SDK client drives a real `initialize` handshake.
				const transport = new StdioClientTransport({
					command: process.execPath, // node
					args: [BUNDLE_PATH],
					stderr: "pipe",
				});
				client = new Client({ name: "mcp-transport-smoke", version: "0.0.0" });
				await client.connect(transport);

				// A REAL initialize response: the spawned server negotiated its identity +
				// tool capability. This is the proof the bundle SERVES, not merely imports.
				expect(client.getServerVersion()?.name).toBe("honeycomb");
				expect(client.getServerCapabilities()?.tools).toBeDefined();

				// tools/list over the live stdio channel returns the unified honeycomb_ surface.
				const { tools } = await client.listTools();
				const listed = tools.map((t) => t.name);
				expect(listed.length).toBeGreaterThan(0);
				expect(listed).toContain("memory_search");
				expect(listed).toContain("honeycomb_search");
				// Every advertised tool is part of the frozen 019d contract (e-AC-5).
				for (const name of listed) expect(TOOL_NAMES).toContain(name);
			},
			30_000,
		);
	},
);

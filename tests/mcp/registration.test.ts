/**
 * PRD-021e e-AC-4 — the MCP server is registered in ONE MCP-speaking harness.
 *
 * The acceptance bar is a single MCP-speaking harness whose native MCP config
 * lists the Honeycomb server, so its tool list would load the unified `honeycomb_`
 * surface. Hermes is that harness (the wave plan's MCP-speaking target). This test
 * asserts the distinct registration artifact (`harnesses/hermes/.mcp.json`) exists,
 * parses, and registers a `honeycomb` stdio server pointing at the BUILT bundle
 * entry — the same `mcp/bundle/server.js` that `startMcpServer` makes answer
 * `initialize`. It does NOT touch `harnesses/hermes/src/index.ts` (021c owns that).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONFIG_PATH = `${REPO_ROOT}harnesses/hermes/.mcp.json`;

interface McpServerEntry {
	readonly command?: string;
	readonly args?: readonly string[];
	readonly env?: Record<string, string>;
}
interface McpConfig {
	readonly mcpServers?: Record<string, McpServerEntry>;
}

function readConfig(): McpConfig {
	return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as McpConfig;
}

describe("e-AC-4: the Honeycomb MCP server is registered in the hermes harness", () => {
	it("e-AC-4 the registration artifact lists a honeycomb server", () => {
		const config = readConfig();
		expect(config.mcpServers).toBeDefined();
		expect(config.mcpServers?.honeycomb).toBeDefined();
	});

	it("e-AC-4 the honeycomb server launches the built mcp/bundle/server.js over stdio", () => {
		const entry = readConfig().mcpServers?.honeycomb;
		expect(entry?.command).toBe("node");
		// The args point at the BUILT MCP bundle — the stdio server startMcpServer serves.
		expect(entry?.args).toBeDefined();
		const joined = (entry?.args ?? []).join(" ");
		expect(joined).toContain("mcp/bundle/server.js");
	});
});

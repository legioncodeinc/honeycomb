/**
 * PRD-021e e-AC-4 — the real Hermes connector registers Honeycomb's stdio MCP server.
 *
 * Hermes reads `mcp_servers` from `$HERMES_HOME/config.yaml`; repository-local
 * `.mcp.json` files are not part of Hermes' protocol. This test exercises the
 * production connector path and validates the emitted native YAML.
 */

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { createFakeFs, HermesConnector } from "../../src/connectors/index.js";

const HOME = "/home/dev";
const BUNDLE = "/repo/harnesses/hermes/bundle";
const MCP_SOURCE = "/repo/mcp/bundle/server.js";
const MCP_INSTALLED = `${HOME}/.hermes/honeycomb/mcp/server.js`;

function fixture() {
	return createFakeFs({
		files: {
			[`${HOME}/.hermes`]: "",
			[`${BUNDLE}/session-start.js`]: "x",
			[`${BUNDLE}/capture.js`]: "x",
			[`${BUNDLE}/session-end.js`]: "x",
			[MCP_SOURCE]: "mcp",
		},
	});
}

describe("e-AC-4: Honeycomb MCP is registered through Hermes' native config", () => {
	it("copies the MCP bundle and writes mcp_servers.honeycomb with an absolute installed path", async () => {
		const fs = fixture();
		await new HermesConnector(fs, { home: HOME, bundleSource: BUNDLE, mcpServerPath: MCP_SOURCE }).install();

		const config = parse(fs.files.get(`${HOME}/.hermes/config.yaml`) as string) as {
			mcp_servers?: Record<string, { command?: string; args?: string[]; enabled?: boolean }>;
		};
		expect(fs.files.get(MCP_INSTALLED)).toBe("mcp");
		expect(config.mcp_servers?.honeycomb).toMatchObject({
			command: process.execPath,
			args: [MCP_INSTALLED],
			enabled: true,
		});
	});
});

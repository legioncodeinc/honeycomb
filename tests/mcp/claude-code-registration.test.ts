/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * PRD-076b - register the Honeycomb MCP server in the Claude Code PLUGIN.
 *
 * The sibling `tests/mcp/registration.test.ts` proves the identical server is registered in the
 * HERMES harness via `harnesses/hermes/.mcp.json`. This suite proves the SAME server is now
 * registered in the Claude Code PLUGIN via a bundled `harnesses/claude-code/.mcp.json`, checked
 * against the executable oracle `references/claude-code/mcp-registration-schema.ts` (b-AC-1). It
 * mirrors the hermes shape (b-AC-2), asserts the bundle path is install-safe for an INSTALLED
 * plugin (b-AC-3), asserts the launched server's tool surface is unchanged by this PRD (b-AC-4,
 * static parity against `mcp/src/tools.ts` `TOOL_NAMES`), asserts the hooks config still conforms
 * (b-AC-5, additive), and asserts single-sourced version parity with no drift (b-AC-6).
 *
 * Static-parity note (b-AC-4): a live tool-list check by spawning the built bundle already exists
 * as `tests/integration/mcp-transport-live.itest.ts` (needs `npm run build`, not part of `ci`).
 * This suite asserts tool-list parity STATICALLY against `TOOL_NAMES` so it runs in `ci` with no
 * build/socket dependency, per the PRD's allowance.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { assertClaudeCodeHooksConform, CLAUDE_CODE_EVENT_NAMES } from "../../references/claude-code/hooks-schema.js";
import {
	assertClaudeCodePluginMcpConform,
	assertInstallSafeServerScript,
	CLAUDE_PLUGIN_ROOT_TOKEN,
	claudeCodePluginMcpConfig,
	isInstallSafePluginPath,
} from "../../references/claude-code/mcp-registration-schema.js";
import { TOOL_NAMES } from "../../mcp/src/tools.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MCP_CONFIG_PATH = `${REPO_ROOT}harnesses/claude-code/.mcp.json`;
const HOOKS_PATH = `${REPO_ROOT}harnesses/claude-code/hooks/hooks.json`;
const PLUGIN_MANIFEST_PATH = `${REPO_ROOT}harnesses/claude-code/.claude-plugin/plugin.json`;
const ROOT_PACKAGE_PATH = `${REPO_ROOT}package.json`;
const ROOT_PLUGIN_MANIFEST_PATH = `${REPO_ROOT}.claude-plugin/plugin.json`;
const MARKETPLACE_PATH = `${REPO_ROOT}.claude-plugin/marketplace.json`;

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf-8")) as T;

/**
 * The FROZEN tool surface this PRD must not change. Kept in `mcp/src/tools.ts` source order so a
 * tool added/removed/renamed there (the exact drift b-AC-4 guards) shifts this set and fails.
 */
const EXPECTED_TOOL_SURFACE: readonly string[] = [
	"memory_search",
	"memory_store",
	"memory_get",
	"memory_list",
	"memory_modify",
	"memory_forget",
	"honeycomb_search",
	"honeycomb_read",
	"honeycomb_index",
	"hivemind_read",
	"hivemind_search",
	"honeycomb_goal_add",
	"honeycomb_kpi_add",
	"honeycomb_code_search",
	"honeycomb_code_context",
	"honeycomb_code_blast",
	"honeycomb_code_impact",
	"secret_list",
	"secret_exec",
];

// ─────────────────────────────────────────────────────────────────────────────
// b-AC-1 — the mechanism is pinned as an executable oracle; the artifact parses against it.
// ─────────────────────────────────────────────────────────────────────────────
describe("b-AC-1: the plugin MCP-registration mechanism is pinned as an executable oracle", () => {
	it("b-AC-1 the emitted .mcp.json parses + conforms against the references/claude-code oracle", () => {
		const config = readJson(MCP_CONFIG_PATH);
		expect(() => assertClaudeCodePluginMcpConform(config)).not.toThrow();
	});

	it("b-AC-1 the oracle BITES: a config with no mcpServers is rejected", () => {
		expect(() => assertClaudeCodePluginMcpConform({})).toThrow();
	});

	it("b-AC-1 the oracle BITES: an empty mcpServers map is rejected", () => {
		expect(() => assertClaudeCodePluginMcpConform({ mcpServers: {} })).toThrow(/registers no servers/);
	});

	it("b-AC-1 the oracle BITES: a server with neither command nor url is rejected", () => {
		expect(() => assertClaudeCodePluginMcpConform({ mcpServers: { honeycomb: { env: {} } } })).toThrow(
			/cannot launch it/,
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// b-AC-2 — a `honeycomb` server pointing at the built mcp/bundle/server.js (mirrors hermes).
// ─────────────────────────────────────────────────────────────────────────────
describe("b-AC-2: the plugin registers a honeycomb MCP server at the built bundle", () => {
	it("b-AC-2 the registration artifact lists a honeycomb server", () => {
		const config = claudeCodePluginMcpConfig.parse(readJson(MCP_CONFIG_PATH));
		expect(config.mcpServers.honeycomb).toBeDefined();
	});

	it("b-AC-2 the honeycomb server launches the built mcp/bundle/server.js over stdio", () => {
		const entry = claudeCodePluginMcpConfig.parse(readJson(MCP_CONFIG_PATH)).mcpServers.honeycomb;
		expect(entry.command).toBe("node");
		expect(entry.args).toBeDefined();
		const joined = (entry.args ?? []).join(" ");
		expect(joined).toContain("mcp/bundle/server.js");
	});

	it("b-AC-2 the server passes no inlined env secrets (reads its credential from disk, like hermes)", () => {
		const entry = claudeCodePluginMcpConfig.parse(readJson(MCP_CONFIG_PATH)).mcpServers.honeycomb;
		expect(entry.env ?? {}).toEqual({});
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// b-AC-3 — the bundle path is install-safe: ${CLAUDE_PLUGIN_ROOT}-anchored, no traversal.
// ─────────────────────────────────────────────────────────────────────────────
describe("b-AC-3: the registration path resolves from the installed plugin root, not the repo", () => {
	it("b-AC-3 the honeycomb server-script arg is install-safe (anchored to the plugin root)", () => {
		const entry = claudeCodePluginMcpConfig.parse(readJson(MCP_CONFIG_PATH)).mcpServers.honeycomb;
		const scriptArg = assertInstallSafeServerScript(entry);
		expect(scriptArg.startsWith(`${CLAUDE_PLUGIN_ROOT_TOKEN}/`)).toBe(true);
		expect(scriptArg).toContain("mcp/bundle/server.js");
		expect(scriptArg).not.toContain("..");
	});

	it("b-AC-3 the install-safe check BITES: a bare repo-relative path (the hermes shape) is rejected", () => {
		// Hermes' `mcp/bundle/server.js` resolves from the launcher CWD - correct for hermes, but NOT
		// install-safe for a plugin whose working directory is not the repo root.
		expect(isInstallSafePluginPath("mcp/bundle/server.js")).toBe(false);
	});

	it("b-AC-3 the install-safe check BITES: an absolute path is rejected", () => {
		expect(isInstallSafePluginPath("/repo/mcp/bundle/server.js")).toBe(false);
	});

	it("b-AC-3 the install-safe check BITES: traversal outside the plugin root is rejected", () => {
		// The docs are explicit: files outside the plugin root are not copied to the cache, so a
		// `${CLAUDE_PLUGIN_ROOT}/../../mcp/...` path would not resolve after installation.
		expect(isInstallSafePluginPath(`${CLAUDE_PLUGIN_ROOT_TOKEN}/../../mcp/bundle/server.js`)).toBe(false);
	});

	it("b-AC-3 the install-safe check ACCEPTS the emitted plugin-internal path", () => {
		expect(isInstallSafePluginPath(`${CLAUDE_PLUGIN_ROOT_TOKEN}/mcp/bundle/server.js`)).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// b-AC-4 — the tool surface is unchanged by this PRD (static parity against TOOL_NAMES).
// ─────────────────────────────────────────────────────────────────────────────
describe("b-AC-4: the registered server exposes the existing tool surface, unchanged", () => {
	it("b-AC-4 TOOL_NAMES equals the frozen surface (no tool added or removed by 076b)", () => {
		expect([...TOOL_NAMES].sort()).toEqual([...EXPECTED_TOOL_SURFACE].sort());
	});

	it("b-AC-4 the PRD-named recall tools are all present in the surface", () => {
		for (const tool of ["memory_search", "hivemind_search", "hivemind_read", "memory_store"]) {
			expect(TOOL_NAMES).toContain(tool);
		}
	});

	it("b-AC-4 the registration declares no tool overrides (tools come from the launched server)", () => {
		// A registration that hand-lists tools would fork the contract. The `.mcp.json` only launches
		// the server; the tool surface is whatever the server registers - so it stays identical.
		const config = readJson<Record<string, unknown>>(MCP_CONFIG_PATH);
		const entry = (config.mcpServers as Record<string, Record<string, unknown>>).honeycomb;
		expect(entry.tools).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// b-AC-5 — the registration is additive: the hooks config still conforms, unchanged.
// ─────────────────────────────────────────────────────────────────────────────
describe("b-AC-5: the MCP registration is additive; the hooks bundle is unchanged", () => {
	it("b-AC-5 the hooks config still conforms to the references/claude-code hooks oracle", () => {
		const hooks = readJson(HOOKS_PATH);
		expect(() => assertClaudeCodeHooksConform(hooks)).not.toThrow();
	});

	it("b-AC-5 the hooks config still registers its seven lifecycle events, all valid", () => {
		const hooks = readJson<{ hooks: Record<string, unknown> }>(HOOKS_PATH);
		const events = Object.keys(hooks.hooks);
		expect(events).toHaveLength(7);
		expect(events).toEqual(
			expect.arrayContaining([
				"SessionStart",
				"UserPromptSubmit",
				"PreToolUse",
				"PostToolUse",
				"Stop",
				"SubagentStop",
				"SessionEnd",
			]),
		);
		for (const event of events) {
			expect(CLAUDE_CODE_EVENT_NAMES).toContain(event);
		}
	});

	it("b-AC-5 plugin.json carries no inline mcpServers (registration lives in the bundled .mcp.json)", () => {
		// The mechanism is a separate `.mcp.json` (b-AC-1); the manifest must NOT also inline it, so
		// there is exactly one source of the registration and no drift between two copies.
		const manifest = readJson<Record<string, unknown>>(PLUGIN_MANIFEST_PATH);
		expect(manifest.mcpServers).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// b-AC-6 — version parity: the single-sourced manifests agree; the .mcp.json holds no version.
// ─────────────────────────────────────────────────────────────────────────────
describe("b-AC-6: the registration stays version-consistent with the single-sourced manifest", () => {
	it("b-AC-6 the .mcp.json carries no independent version field (nothing to hand-edit or drift)", () => {
		const config = readJson<Record<string, unknown>>(MCP_CONFIG_PATH);
		expect(config.version).toBeUndefined();
	});

	it("b-AC-6 every single-sourced manifest version matches the root package.json version", () => {
		const rootVersion = readJson<{ version: string }>(ROOT_PACKAGE_PATH).version;
		expect(typeof rootVersion).toBe("string");
		expect(rootVersion.length).toBeGreaterThan(0);

		expect(readJson<{ version: string }>(PLUGIN_MANIFEST_PATH).version).toBe(rootVersion);
		expect(readJson<{ version: string }>(ROOT_PLUGIN_MANIFEST_PATH).version).toBe(rootVersion);

		const marketplace = readJson<{
			metadata: { version: string };
			plugins: readonly { name: string; version: string }[];
		}>(MARKETPLACE_PATH);
		expect(marketplace.metadata.version).toBe(rootVersion);
		const honeycombPlugin = marketplace.plugins.find((p) => p.name === "honeycomb");
		expect(honeycombPlugin?.version).toBe(rootVersion);
	});
});

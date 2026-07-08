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
 * Claude Code PLUGIN MCP registration - the REAL plugin config contract, as an executable zod schema.
 *
 * ── What this is (the references gate, now EXECUTABLE for MCP registration) ──
 * PRD-076b registers the existing Honeycomb MCP server (`mcp/bundle/server.js`) with the Claude
 * Code plugin so the model gets callable recall tools. `references/claude-code/hooks-schema.ts`
 * already pins the plugin HOOKS contract as an independent zod oracle; this file does the same for
 * the plugin MCP-registration contract. It encodes - as an INDEPENDENT oracle derived from the
 * VENDOR docs, not from Honeycomb's own artifact - the structure a Claude Code plugin's `.mcp.json`
 * (or an inline `plugin.json#mcpServers`) must have for the host to launch the server and surface
 * its tools. The conformance suite (`tests/mcp/claude-code-registration.test.ts`) parses the EMITTED
 * `harnesses/claude-code/.mcp.json` through THIS schema, so a malformed entry or a bundle path that
 * would not resolve from an INSTALLED plugin FAILS the gate.
 *
 * This schema encodes the EXTERNAL Claude Code plugin protocol, NOT Honeycomb's own types. That
 * independence is the point: it is an oracle the artifact is checked against, never a mirror of it.
 *
 * ── The pinned mechanism (b-AC-1): a bundled `.mcp.json` at the plugin ROOT ──
 * Two mechanisms exist in the plugin contract. This oracle pins the RECOMMENDED, reliable one:
 * a dedicated `.mcp.json` file at the plugin root (NOT inside `.claude-plugin/`), shape
 * `{ mcpServers: { <name>: { command, args?, env? } } }` - the identical shape the sibling
 * `harnesses/hermes/.mcp.json` already uses. The alternative (an inline `mcpServers` key in
 * `plugin.json`) is documented but currently UNRELIABLE - the field is dropped during manifest
 * parsing (anthropics/claude-code issue #16143), and the official guidance is to use a separate
 * `.mcp.json`. Honeycomb therefore ships a bundled `.mcp.json`, matching the in-repo precedent.
 *
 * ── The install-safe path rule (b-AC-3): `${CLAUDE_PLUGIN_ROOT}`, no traversal ──
 * A plugin's MCP server subprocess receives `${CLAUDE_PLUGIN_ROOT}` (the absolute path to the
 * installed plugin directory) as an env var, and the docs require using it for every bundled-file
 * path. Two hard rules follow, both encoded in {@link isInstallSafePluginPath}:
 *   1. The server-script arg MUST be anchored to `${CLAUDE_PLUGIN_ROOT}` - a bare relative path
 *      (like hermes' `mcp/bundle/server.js`, which resolves from the launcher CWD) is NOT
 *      install-safe for a plugin, whose working directory is not the repo root.
 *   2. The path MUST NOT traverse OUTSIDE the plugin root. The docs are explicit: "Installed
 *      plugins cannot reference files outside their directory. Paths that traverse outside the
 *      plugin root (such as `../shared-utils`) will not work after installation because those
 *      external files are not copied to the cache." So `${CLAUDE_PLUGIN_ROOT}/../../mcp/...` is
 *      RULED OUT; the bundle must resolve INSIDE the plugin as `${CLAUDE_PLUGIN_ROOT}/mcp/bundle/server.js`.
 *
 * ── Sources (high fidelity, 2026-current) ───────────────────────────────────
 *   1. Claude Code MCP reference (code.claude.com/docs/en/mcp) "Plugin-provided MCP servers":
 *      `.mcp.json` at plugin root or inline in `plugin.json`; `{ mcpServers: { <name>: { command,
 *      args, env } } }`; stdio/SSE/HTTP/ws transports; `${CLAUDE_PLUGIN_ROOT}` for bundled files.
 *   2. Claude Code plugins reference (code.claude.com/docs/en/plugins-reference) "MCP servers" +
 *      "Path traversal limitations": paths that traverse outside the plugin root do not work after
 *      installation; use `${CLAUDE_PLUGIN_ROOT}`.
 *   3. anthropics/claude-code plugin-dev `mcp-integration` SKILL: Method 1 (Recommended) is a
 *      dedicated `.mcp.json`; Method 2 (inline in `plugin.json`) is documented as the alternative.
 *   4. anthropics/claude-code issue #16143: inline `mcpServers` in `plugin.json` is dropped during
 *      manifest parsing; workaround is a separate `.mcp.json`.
 *   5. The in-repo precedent `harnesses/hermes/.mcp.json` + its conformance test
 *      (`tests/mcp/registration.test.ts`): the `{ mcpServers: { honeycomb: { command: "node",
 *      args: [...], env: {} } } }` stdio shape pointing at the built `mcp/bundle/server.js`.
 *
 * ── Fidelity caveats (be honest - see references/README.md) ─────────────────
 *   - A server entry carries harness fields this gate does not fully constrain across transports
 *     (`type`, `url`, `cwd`, `headers`, ...). The entry schema therefore PASSES THROUGH unknown
 *     keys and asserts only the parts we are confident in (a stdio entry needs `command`; a remote
 *     entry needs `url`), rather than inventing a closed shape we cannot justify from the docs.
 *   - This oracle validates the MCP-registration object ONLY. The plugin's `plugin.json` manifest
 *     and `hooks/hooks.json` carry their own contracts (the latter pinned by `hooks-schema.ts`).
 */

import { z } from "zod";

/** The env var the host injects into a plugin's MCP server subprocess: the installed plugin dir. */
export const CLAUDE_PLUGIN_ROOT_TOKEN = "${CLAUDE_PLUGIN_ROOT}";

/**
 * A single MCP server entry. Honeycomb (like hermes) uses the STDIO form: a `command` + `args`.
 * The docs also allow remote forms (an SSE/HTTP `url`). We assert the parts we are confident in
 * and PASS THROUGH the rest (`type`, `url`, `cwd`, `headers`, ...) rather than over-constrain.
 */
export const claudeCodeMcpServerEntry = z
	.object({
		// stdio transport: the executable to spawn (Honeycomb uses `node`).
		command: z.string().min(1).optional(),
		// stdio transport: the argv passed to `command` (the server-script path lives here).
		args: z.array(z.string()).optional(),
		// Env for the subprocess. Honeycomb passes `{}` - the server reads its credential from disk.
		env: z.record(z.string(), z.string()).optional(),
		// remote transport (SSE/HTTP/ws): the endpoint URL. Present INSTEAD of `command`.
		url: z.string().optional(),
	})
	.passthrough();

/**
 * The plugin MCP-registration object: a `mcpServers` map of name -> entry. This is the shape of a
 * bundled `.mcp.json` at the plugin root AND of an inline `plugin.json#mcpServers` value; the outer
 * `.mcp.json` may also carry a `$schema` hint (as hermes' does), preserved via passthrough.
 */
export const claudeCodePluginMcpConfig = z
	.object({
		mcpServers: z.record(z.string(), claudeCodeMcpServerEntry),
	})
	.passthrough();

export type ClaudeCodeMcpServerEntry = z.infer<typeof claudeCodeMcpServerEntry>;
export type ClaudeCodePluginMcpConfig = z.infer<typeof claudeCodePluginMcpConfig>;

/**
 * True iff `p` is an INSTALL-SAFE plugin bundled-file path: anchored to `${CLAUDE_PLUGIN_ROOT}` and
 * staying INSIDE the plugin root (no parent traversal, no absolute re-anchor). See the header's
 * "install-safe path rule" for why both conditions are load-bearing for an installed plugin.
 */
export function isInstallSafePluginPath(p: unknown): boolean {
	if (typeof p !== "string" || p.length === 0) return false;
	const anchor = `${CLAUDE_PLUGIN_ROOT_TOKEN}/`;
	// (1) MUST be anchored to the host-injected plugin root - a bare relative / absolute path is not.
	if (!p.startsWith(anchor)) return false;
	const rest = p.slice(anchor.length);
	if (rest.length === 0 || rest.startsWith("/")) return false;
	// (2) MUST NOT traverse outside the plugin root - external files are not copied to the cache.
	if (rest.split("/").some((seg) => seg === "..")) return false;
	return true;
}

/**
 * Assert a parsed plugin MCP-registration object CONFORMS to the real Claude Code plugin contract:
 *   1. it parses against {@link claudeCodePluginMcpConfig} (a `mcpServers` map), AND
 *   2. it registers at least one server, AND
 *   3. every entry is a launchable server (a stdio `command`, or a remote `url`).
 *
 * Throws a `ZodError` (structure) or a plain `Error` (empty map / unlaunchable entry) on
 * non-conformance - the test asserts it does NOT throw. Returns the validated config on success.
 */
export function assertClaudeCodePluginMcpConform(config: unknown): ClaudeCodePluginMcpConfig {
	const parsed = claudeCodePluginMcpConfig.parse(config);
	const names = Object.keys(parsed.mcpServers);
	if (names.length === 0) {
		throw new Error("Claude Code plugin MCP conformance: `mcpServers` registers no servers.");
	}
	for (const name of names) {
		const entry = parsed.mcpServers[name];
		const launchable = typeof entry.command === "string" || typeof entry.url === "string";
		if (!launchable) {
			throw new Error(
				`Claude Code plugin MCP conformance: server "${name}" has neither a stdio \`command\` ` +
					"nor a remote `url` - the host cannot launch it.",
			);
		}
	}
	return parsed;
}

/**
 * Assert a stdio server entry launches an INSTALL-SAFE bundle path ending in `expectedSuffix`, and
 * return that server-script arg. Throws when the entry is not `node`-launched, when no arg points at
 * the expected bundle, or when the arg is not install-safe (not `${CLAUDE_PLUGIN_ROOT}`-anchored, or
 * it traverses outside the plugin root). This is the b-AC-3 install-safe assertion.
 */
export function assertInstallSafeServerScript(
	entry: ClaudeCodeMcpServerEntry,
	expectedSuffix = "mcp/bundle/server.js",
): string {
	if (entry.command !== "node") {
		throw new Error(
			`Claude Code plugin MCP conformance: expected a \`node\`-launched stdio server, got command "${String(
				entry.command,
			)}".`,
		);
	}
	const args = entry.args ?? [];
	const scriptArg = args.find((a) => a.includes(expectedSuffix));
	if (scriptArg === undefined) {
		throw new Error(`Claude Code plugin MCP conformance: no arg points at the built bundle "${expectedSuffix}".`);
	}
	if (!isInstallSafePluginPath(scriptArg)) {
		throw new Error(
			`Claude Code plugin MCP conformance: server-script path "${scriptArg}" is not install-safe - ` +
				`it must be anchored to ${CLAUDE_PLUGIN_ROOT_TOKEN} and stay inside the plugin root ` +
				"(no `..` traversal, no absolute re-anchor).",
		);
	}
	return scriptArg;
}

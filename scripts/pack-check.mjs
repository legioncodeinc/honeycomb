#!/usr/bin/env node
// Refuse a publish if `npm pack` would include filenames that should never
// ship to npm — credentials, CI workflows, git internals, key material.
// Catches a future PR widening package.json's `files` array (or switching to a
// permissive .npmignore) BEFORE any token is touched. This is the publish gate
// (ci-release-stinger hard rule #4/#5): what ships is the files allowlist, and
// secrets must never reach the tarball.

import { execFileSync, execSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

// On Windows the npm entry point is npm.cmd, which execFileSync cannot launch
// directly. The command line is a fixed literal (no user input), so a plain
// shell exec is safe and keeps the script cross-platform (EXECUTION_LEDGER:
// Windows/PowerShell dev host).
const PACK_ARGS = ["pack", "--dry-run", "--json"];
// This is the LITERAL marker prefix `.mcp.json`/`hooks.json` use for the Claude Code plugin root
// (Claude Code substitutes it at load time), NOT a template-literal interpolation — build it via
// concatenation so static analysis (CodeQL js/template-syntax-in-string-literal) does not mistake the
// `${...}` characters for an unresolved template expression. A backtick template literal here would
// actually interpolate `CLAUDE_PLUGIN_ROOT` (undefined in this scope) and break the strip logic below.
const CLAUDE_PLUGIN_ROOT = "$" + "{CLAUDE_PLUGIN_ROOT}/";
const CLAUDE_PLUGIN_DIR = "harnesses/claude-code";
const CLAUDE_PLUGIN_MCP_CONFIG = `${CLAUDE_PLUGIN_DIR}/.mcp.json`;
const CLAUDE_PLUGIN_HOOKS_CONFIG = `${CLAUDE_PLUGIN_DIR}/hooks/hooks.json`;
const REQUIRED_PLUGIN_FILES = [
	`${CLAUDE_PLUGIN_DIR}/skills/honeycomb-memory/SKILL.md`,
	`${CLAUDE_PLUGIN_DIR}/commands/recall.md`,
	`${CLAUDE_PLUGIN_DIR}/commands/remember.md`,
	`${CLAUDE_PLUGIN_DIR}/commands/forget.md`,
];
const REQUIRED_PLUGIN_DIRS = [`${CLAUDE_PLUGIN_DIR}/skills/`, `${CLAUDE_PLUGIN_DIR}/commands/`];

const FORBIDDEN = [
	/(^|\/)\.npmrc$/,
	/(^|\/)\.env($|\.)/,
	/(^|\/)secrets?(\/|$)/,
	/(^|\/)\.github(\/|$)/,
	/(^|\/)\.git(\/|$)/,
	// Private-key / credential material: never belongs in a published tarball.
	/(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/,
	/\.(pem|key|p12|pfx)$/,
	/(^|\/)credentials\.json$/,
];

const manifestFromEnv = process.env.HONEYCOMB_PACK_MANIFEST;
let raw;
if (manifestFromEnv !== undefined) {
	const manifest = resolve(manifestFromEnv);
	if (dirname(manifest) !== resolve(".") || basename(manifest) !== ".pack-result.json")
		throw new Error("HONEYCOMB_PACK_MANIFEST must name the workspace .pack-result.json file");
	if (lstatSync(manifest).isSymbolicLink() || realpathSync(manifest) !== manifest)
		throw new Error("HONEYCOMB_PACK_MANIFEST must be a regular workspace file, not a symlink");
	raw = readFileSync(manifest, "utf8");
} else {
	raw =
		process.platform === "win32"
			? execSync(`npm ${PACK_ARGS.join(" ")}`, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
			: execFileSync("npm", PACK_ARGS, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}
const entries = JSON.parse(raw)[0].files.map((f) => f.path);
const packedPathSet = new Set(entries);
const hits = entries.filter((p) => FORBIDDEN.some((rx) => rx.test(p)));

if (hits.length) {
	console.error("Refusing to publish — forbidden filenames in tarball:");
	for (const h of hits) console.error(`  ${h}`);
	process.exit(1);
}

// Required runtime files: a publish that DROPS any of these from the `files`
// allowlist ships a broken package. The dashboard SPA itself moved to hive
// (ADR-0001 cutover, "Removed portal to migrate to hive") — honeycomb no
// longer bundles or serves it, so there is no `daemon/dashboard-app.js` target
// to require here anymore. `assets/*` (CSS tokens, logo, fonts) still ship —
// see the entries below — this positive check still catches a regression that
// drops any of THOSE, which the forbidden-only scan above cannot.
const REQUIRED = [
	/(^|\/)bundle\/cli\.js$/, // the `honeycomb` bin
	/(^|\/)daemon\/index\.js$/, // the daemon entry the CLI spawns
	/(^|\/)harnesses\/claude-code\/mcp\/bundle\/server\.js$/, // Claude Code plugin-internal MCP server path
	/(^|\/)harnesses\/hermes\/bundle\/session-start\.mjs$/, // Hermes lifecycle hook alias
	/(^|\/)harnesses\/hermes\/bundle\/capture\.mjs$/, // Hermes capture + recall hook alias
	/(^|\/)harnesses\/hermes\/bundle\/session-end\.mjs$/, // Hermes finalization hook alias
	/(^|\/)mcp\/bundle\/server\.js$/, // copied into $HERMES_HOME/honeycomb/mcp on connect
	/(^|\/)assets\/styles\.css$/, // resolveAssetsDir() locator
	/(^|\/)assets\/tokens\/base\.css$/, // the DS token CSS the dashboard serves
	/(^|\/)assets\/logos\/honeycomb-memory-cluster\.svg$/, // the brand mark the header renders
	/(^|\/)assets\/logos\/fonts\/JetBrainsMono-Regular\.woff2$/, // a brand font (proves fonts/ shipped)
];
const missing = REQUIRED.filter((rx) => !entries.some((p) => rx.test(p)));
if (missing.length) {
	console.error("Refusing to publish — required runtime files missing from tarball:");
	for (const m of missing) console.error(`  ${String(m)}`);
	console.error("  (widen package.json's `files` allowlist — the install would be broken)");
	process.exit(1);
}

const declaredMissing = [];

const mcpConfig = JSON.parse(readFileSync(CLAUDE_PLUGIN_MCP_CONFIG, "utf8"));
const declaredMcpServerPaths = new Map();
for (const [serverName, server] of Object.entries(mcpConfig.mcpServers ?? {})) {
	if (!Array.isArray(server?.args)) continue;
	for (const arg of server.args) {
		if (typeof arg !== "string" || !arg.startsWith(CLAUDE_PLUGIN_ROOT)) continue;
		const relativePath = arg.slice(CLAUDE_PLUGIN_ROOT.length);
		const packPath = `${CLAUDE_PLUGIN_DIR}/${relativePath}`;
		declaredMcpServerPaths.set(packPath, serverName);
	}
}

if (declaredMcpServerPaths.size === 0) {
	declaredMissing.push(`[mcp] no \${CLAUDE_PLUGIN_ROOT}/... server args found in ${CLAUDE_PLUGIN_MCP_CONFIG}`);
}

for (const [packPath, serverName] of declaredMcpServerPaths) {
	if (!packedPathSet.has(packPath)) {
		declaredMissing.push(`[mcp] server "${serverName}" requires missing file: ${packPath}`);
	}
}

// Extract every `${CLAUDE_PLUGIN_ROOT}/...` relative path referenced in one hook command string,
// mapped to its packed tarball path.
function extractHookCommandPaths(command) {
	const matches = command.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s"]+)/g);
	return [...matches].map(([, relativePath]) => `${CLAUDE_PLUGIN_DIR}/${relativePath}`);
}

// Flatten one hook block's `hooks` array of `{ command }` entries into their referenced paths.
function hookBlockCommandPaths(hookBlock) {
	if (!Array.isArray(hookBlock?.hooks)) return [];
	return hookBlock.hooks.flatMap((hook) =>
		typeof hook?.command === "string" ? extractHookCommandPaths(hook.command) : [],
	);
}

// Collect every `${CLAUDE_PLUGIN_ROOT}/...` path referenced across all hook events in `config`.
function collectHookCommandPaths(config) {
	const paths = new Set();
	for (const hookBlocks of Object.values(config.hooks ?? {})) {
		if (!Array.isArray(hookBlocks)) continue;
		for (const hookBlock of hookBlocks) {
			for (const path of hookBlockCommandPaths(hookBlock)) paths.add(path);
		}
	}
	return paths;
}

const hooksConfig = JSON.parse(readFileSync(CLAUDE_PLUGIN_HOOKS_CONFIG, "utf8"));
const hookCommandPaths = collectHookCommandPaths(hooksConfig);

if (hookCommandPaths.size === 0) {
	declaredMissing.push(`[hooks] no \${CLAUDE_PLUGIN_ROOT}/... handlers found in ${CLAUDE_PLUGIN_HOOKS_CONFIG}`);
}

for (const packPath of hookCommandPaths) {
	if (!packedPathSet.has(packPath)) {
		declaredMissing.push(`[hooks] declared handler missing from tarball: ${packPath}`);
	}
}

for (const packPath of REQUIRED_PLUGIN_FILES) {
	if (!packedPathSet.has(packPath)) {
		declaredMissing.push(`[plugin] required Claude Code plugin file missing: ${packPath}`);
	}
}

for (const dirPrefix of REQUIRED_PLUGIN_DIRS) {
	const hasDirectoryEntry = entries.some((entry) => entry.startsWith(dirPrefix));
	if (!hasDirectoryEntry) {
		declaredMissing.push(`[plugin] required Claude Code plugin directory is empty or missing: ${dirPrefix}`);
	}
}

if (declaredMissing.length) {
	console.error("Refusing to publish - declared Claude Code plugin components missing from tarball:");
	for (const detail of declaredMissing) console.error(`  ${detail}`);
	process.exit(1);
}

console.log(
	`pack-check OK - ${entries.length} files, no forbidden patterns, required runtime files present, declared Claude Code plugin components present`,
);

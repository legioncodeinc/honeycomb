/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { createFakeFs, HarnessConnector, HermesConnector } from "../../src/connectors/index.js";

const HOME = "/home/dev";
const BUNDLE = "/repo/harnesses/hermes/bundle";
const MCP = "/repo/mcp/bundle/server.js";
const CONFIG = `${HOME}/.hermes/config.yaml`;
const PLUGIN = `${HOME}/.hermes/honeycomb/bundle`;
const INSTALLED_MCP = `${HOME}/.hermes/honeycomb/mcp/server.mjs`;
const MANIFEST = `${HOME}/.hermes/honeycomb/manifest.json`;

function seedFs(config?: string) {
	return createFakeFs({
		files: {
			[`${HOME}/.hermes`]: "",
			[`${BUNDLE}/session-start.mjs`]: "// session-start",
			[`${BUNDLE}/capture.mjs`]: "// capture",
			[`${BUNDLE}/pre-tool-use.js`]: "// pre-tool-use",
			[`${BUNDLE}/session-end.mjs`]: "// session-end",
			[MCP]: "// mcp server",
			...(config === undefined ? {} : { [CONFIG]: config }),
		},
	});
}

function connector(fs = seedFs(), skillSources: readonly string[] = []) {
	return new HermesConnector(fs, {
		home: HOME,
		bundleSource: BUNDLE,
		mcpServerPath: MCP,
		skillSources,
	});
}

interface HermesConfig {
	hooks?: Record<string, Array<{ command: string; matcher?: string; timeout?: number; _honeycomb?: boolean }>>;
	mcp_servers?: Record<string, { command?: string; args?: string[]; enabled?: boolean; _honeycomb?: boolean }>;
	model?: string;
}

describe("HermesConnector", () => {
	it("extends the shared connector base and wires Hermes' native YAML hook + MCP contract", async () => {
		const fs = seedFs();
		const c = connector(fs);
		expect(c).toBeInstanceOf(HarnessConnector);
		expect(c.harness).toBe("hermes");

		const result = await c.install();
		expect(result.wroteConfig).toBe(true);
		expect(result.handlers).toContain(`${PLUGIN}/session-start.mjs`);
		expect(result.handlers).toContain(`${PLUGIN}/capture.mjs`);
		expect(result.handlers).toContain(`${PLUGIN}/session-end.mjs`);
		expect(result.handlers).toContain(INSTALLED_MCP);

		const config = parse(fs.files.get(CONFIG) as string) as HermesConfig;
		expect(Object.keys(config.hooks ?? {})).toEqual(
			expect.arrayContaining([
				"on_session_start",
				"pre_llm_call",
				"post_tool_call",
				"post_llm_call",
				"on_session_finalize",
			]),
		);
		expect(config.hooks?.pre_llm_call).toHaveLength(2);
		expect(config.hooks?.pre_llm_call?.[0]?.command).toContain("--honeycomb-recall");
		expect(config.hooks?.pre_llm_call?.[1]?.command).not.toContain("--honeycomb-recall");
		expect(config.hooks?.pre_tool_call).toBeUndefined();
		expect(config.hooks?.on_session_end).toBeUndefined();
		expect(config.hooks?.post_tool_call).toHaveLength(1);
		expect(config.hooks?.post_tool_call?.[0]?.command).toContain(`${PLUGIN}/capture.mjs`);
		expect(config.hooks?.post_tool_call?.[0]?.matcher).toBeUndefined();
		expect(config.mcp_servers?.honeycomb).toMatchObject({
			command: process.execPath,
			args: [INSTALLED_MCP],
			enabled: true,
			_honeycomb: true,
		});
	});

	it("preserves foreign YAML, comments, hooks, and unrelated MCP servers", async () => {
		const seeded = `# keep this operator comment\nmodel: anthropic/claude-sonnet-4\nhooks:\n  # keep this event comment\n  pre_llm_call:\n    - command: /opt/acme/recall.py # keep this hook comment\n      timeout: 7\nmcp_servers:\n  acme:\n    command: /opt/acme/server\n    args: []\n`;
		const fs = seedFs(seeded);

		await connector(fs).install();
		const text = fs.files.get(CONFIG) as string;
		const config = parse(text) as HermesConfig & { mcp_servers?: HermesConfig["mcp_servers"] & { acme?: unknown } };

		expect(text).toContain("# keep this operator comment");
		expect(text).toContain("# keep this event comment");
		expect(text).toContain("# keep this hook comment");
		expect(config.model).toBe("anthropic/claude-sonnet-4");
		expect(config.hooks?.pre_llm_call?.some((h) => h.command === "/opt/acme/recall.py")).toBe(true);
		expect(config.mcp_servers?.acme).toEqual({ command: "/opt/acme/server", args: [] });
		expect(config.mcp_servers?.honeycomb?._honeycomb).toBe(true);
	});

	it("refuses a foreign honeycomb-named MCP server before writing owned artifacts", async () => {
		const seeded = `mcp_servers:\n  honeycomb:\n    command: /opt/acme/not-ours\n    args: []\n`;
		const fs = seedFs(seeded);
		const writesBefore = fs.writes.length;

		await expect(connector(fs).install()).rejects.toThrow(/foreign.*mcp|mcp.*foreign|already exists/iu);
		expect(fs.writes).toHaveLength(writesBefore);
		expect(fs.files.has(`${PLUGIN}/capture.mjs`)).toBe(false);
		expect(fs.files.has(INSTALLED_MCP)).toBe(false);
		expect(fs.files.get(CONFIG)).toBe(seeded);
	});

	it("is idempotent and uninstall removes only Honeycomb-owned YAML entries", async () => {
		const seeded = `# preserved\nhooks:\n  post_tool_call:\n    - command: /opt/acme/audit.py\n      matcher: terminal\nother_setting: true\n`;
		const fs = seedFs(seeded);
		const c = connector(fs, ["/repo/skills/org"]);

		await c.install();
		const first = fs.files.get(CONFIG) as string;
		const writesAfterFirst = fs.writes.length;
		const second = await c.install();
		expect(second.wroteConfig).toBe(false);
		expect(fs.writes).toHaveLength(writesAfterFirst);
		expect(fs.files.get(CONFIG)).toBe(first);
		expect(fs.files.has(MANIFEST)).toBe(true);
		expect(fs.links.get(`${HOME}/.hermes/skills/org`)).toBe("/repo/skills/org");

		await c.uninstall();
		const text = fs.files.get(CONFIG) as string;
		const config = parse(text) as HermesConfig & { other_setting?: boolean };
		expect(text).toContain("# preserved");
		expect(config.other_setting).toBe(true);
		expect(config.hooks?.post_tool_call).toEqual([{ command: "/opt/acme/audit.py", matcher: "terminal" }]);
		expect(config.hooks?.pre_llm_call).toBeUndefined();
		expect(config.mcp_servers?.honeycomb).toBeUndefined();
		expect(fs.files.has(`${PLUGIN}/capture.mjs`)).toBe(false);
		expect(fs.files.has(INSTALLED_MCP)).toBe(false);
		expect(fs.files.has(MANIFEST)).toBe(false);
		expect(fs.links.has(`${HOME}/.hermes/skills/org`)).toBe(false);
	});

	it("refuses to overwrite a pre-existing managed artifact without an ownership manifest", async () => {
		const fs = seedFs();
		await fs.writeFile(`${PLUGIN}/capture.mjs`, "// foreign capture");
		const writesBefore = fs.writes.length;

		await expect(connector(fs).install()).rejects.toThrow(/ownership|foreign|refus/iu);
		expect(fs.files.get(`${PLUGIN}/capture.mjs`)).toBe("// foreign capture");
		expect(fs.files.has(MANIFEST)).toBe(false);
		expect(fs.files.has(CONFIG)).toBe(false);
		expect(fs.writes).toHaveLength(writesBefore);
	});

	it("supports ConnectorFs implementations created before atomic write and empty-dir cleanup were added", async () => {
		const fullFs = seedFs();
		const { writeFileAtomic: _writeFileAtomic, removeEmptyDir: _removeEmptyDir, ...legacyFs } = fullFs;
		const c = new HermesConnector(legacyFs, {
			home: HOME,
			bundleSource: BUNDLE,
			mcpServerPath: MCP,
		});

		await expect(c.install()).resolves.toMatchObject({ harness: "hermes" });
		await expect(c.uninstall()).resolves.toMatchObject({ harness: "hermes" });
	});

	it("refuses malformed ownership manifests", async () => {
		const fs = seedFs();
		await fs.writeFile(MANIFEST, '{"_honeycomb":true,"version":1,"files":[]}\n');

		await expect(connector(fs).install()).rejects.toThrow(/ownership manifest/iu);
		expect(fs.files.has(`${PLUGIN}/capture.mjs`)).toBe(false);
	});

	it("refuses symlink substitution of an owned artifact", async () => {
		const fs = seedFs();
		const c = connector(fs);
		await c.install();
		await fs.symlink("/tmp/foreign-target", `${PLUGIN}/capture.mjs`);

		await expect(c.install()).rejects.toThrow(/symlink/iu);
		await expect(c.uninstall()).rejects.toThrow(/symlink/iu);
		expect(fs.links.get(`${PLUGIN}/capture.mjs`)).toBe("/tmp/foreign-target");
	});

	it("refuses a symlinked Hermes config before reading or mutating it", async () => {
		const fs = seedFs("model: test-model\n");
		const c = connector(fs);
		await fs.symlink("/tmp/foreign-config.yaml", CONFIG);

		await expect(c.install()).rejects.toThrow(/symlink/iu);
		await expect(c.uninstall()).rejects.toThrow(/symlink/iu);
		expect(fs.writes).toHaveLength(0);
	});

	it("refuses a symlinked Hermes home before reading or mutating its config", async () => {
		const fs = seedFs("model: test-model\n");
		const c = connector(fs);
		await fs.symlink("/tmp/foreign-hermes-home", `${HOME}/.hermes`);

		await expect(c.install()).rejects.toThrow(/symlink/iu);
		await expect(c.uninstall()).rejects.toThrow(/symlink/iu);
		expect(fs.writes).toHaveLength(0);
	});

	it("preserves a managed artifact modified after installation during uninstall", async () => {
		const fs = seedFs();
		const c = connector(fs);
		await c.install();
		await fs.writeFile(`${PLUGIN}/capture.mjs`, "// user modified");

		await c.uninstall();
		expect(fs.files.get(`${PLUGIN}/capture.mjs`)).toBe("// user modified");
		expect(fs.files.has(MANIFEST)).toBe(true);
		expect(fs.files.has(INSTALLED_MCP)).toBe(false);
	});

	it("rejects empty or relative explicit Hermes homes", () => {
		for (const hermesHome of ["", "relative/profile", "bad\0profile"]) {
			expect(
				() =>
					new HermesConnector(seedFs(), {
						home: HOME,
						hermesHome,
						bundleSource: BUNDLE,
						mcpServerPath: MCP,
					}),
			).toThrow(/HERMES_HOME|absolute|empty|invalid/iu);
		}
	});

	it("detects Hermes from ~/.hermes and links skills into ~/.hermes/skills", async () => {
		const fs = seedFs();
		const c = connector(fs, ["/repo/skills/org"]);
		expect((await c.detectPlatforms()).map((p) => p.harness)).toEqual(["hermes"]);

		const result = await c.install();
		expect(result.skillLinks).toContain(`${HOME}/.hermes/skills/org`);
	});

	it("honors an explicit profile-aware Hermes home", async () => {
		const hermesHome = "/profiles/work";
		const fs = seedFs();
		await fs.writeFile(hermesHome, "");
		const c = new HermesConnector(fs, {
			home: HOME,
			hermesHome,
			bundleSource: BUNDLE,
			mcpServerPath: MCP,
		});

		expect((await c.detectPlatforms()).map((p) => p.configRoot)).toEqual([hermesHome]);
		await c.install();
		expect(fs.files.has(`${hermesHome}/config.yaml`)).toBe(true);
		expect(fs.files.has(`${hermesHome}/honeycomb/bundle/capture.mjs`)).toBe(true);
	});

	it("surfaces Hermes' first-use consent requirement without auto-approving hooks", async () => {
		const fs = seedFs();
		const notices: string[] = [];
		const c = new HermesConnector(fs, {
			home: HOME,
			bundleSource: BUNDLE,
			mcpServerPath: MCP,
			notify: (line) => notices.push(line),
		});

		await c.install();
		expect(notices.join(" ")).toContain("first-use consent");
		expect(fs.files.has(`${HOME}/.hermes/shell-hooks-allowlist.json`)).toBe(false);
	});

	it("fails before writing any artifact when the user's YAML is malformed", async () => {
		const fs = seedFs("hooks: [unterminated\n");
		await expect(connector(fs).install()).rejects.toThrow(/invalid YAML/);
		expect(fs.writes).toEqual([]);
		expect(fs.files.has(`${PLUGIN}/capture.mjs`)).toBe(false);
		expect(fs.files.has(INSTALLED_MCP)).toBe(false);
	});

	it("pins hook and MCP launches to the installing Node executable", async () => {
		const fs = seedFs();
		const nodeExecutable = "/Applications/Node Runtime/bin/node";
		await new HermesConnector(fs, {
			home: HOME,
			bundleSource: BUNDLE,
			mcpServerPath: MCP,
			nodeExecutable,
		}).install();
		const config = parse(fs.files.get(CONFIG) as string) as HermesConfig;
		expect(config.hooks?.pre_llm_call?.every((entry) => entry.command.startsWith(JSON.stringify(nodeExecutable)))).toBe(
			true,
		);
		expect(config.mcp_servers?.honeycomb?.command).toBe(nodeExecutable);
	});
});

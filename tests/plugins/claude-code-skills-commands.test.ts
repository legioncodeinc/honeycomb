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
 * PRD-076c - bundle a memory skill + slash commands in the Claude Code PLUGIN.
 *
 * 076b registered the Honeycomb MCP server in the plugin (`tests/mcp/claude-code-registration.
 * test.ts`), making `hivemind_search`/`hivemind_read`/`memory_store`/`memory_forget` callable in a
 * session. This suite proves 076c's model-invoked skill (`skills/honeycomb-memory/SKILL.md`) and
 * three explicit slash commands (`commands/{recall,remember,forget}.md`) are bundled, correctly
 * placed per the plugin contract, and orchestrate only the EXISTING tool surface - checked against
 * the executable oracle `references/claude-code/plugin-skills-commands-schema.ts` (c-AC-5).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../../mcp/src/tools.js";
import { assertClaudeCodeHooksConform } from "../../references/claude-code/hooks-schema.js";
import { assertClaudeCodePluginMcpConform } from "../../references/claude-code/mcp-registration-schema.js";
import {
	assertClaudeCodeCommandConforms,
	assertClaudeCodeSkillConforms,
	claudeCodePluginComponentFrontmatter,
	commandNameFromPath,
	isCommandFilePath,
	isSkillDirectoryPath,
	parsePluginComponentMarkdown,
	skillNameFromPath,
} from "../../references/claude-code/plugin-skills-commands-schema.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PLUGIN_ROOT = "harnesses/claude-code/";

const SKILL_REL_PATH = `${PLUGIN_ROOT}skills/honeycomb-memory/SKILL.md`;
const RECALL_REL_PATH = `${PLUGIN_ROOT}commands/recall.md`;
const REMEMBER_REL_PATH = `${PLUGIN_ROOT}commands/remember.md`;
const FORGET_REL_PATH = `${PLUGIN_ROOT}commands/forget.md`;

const HOOKS_PATH = `${REPO_ROOT}${PLUGIN_ROOT}hooks/hooks.json`;
const MCP_CONFIG_PATH = `${REPO_ROOT}${PLUGIN_ROOT}.mcp.json`;
const PLUGIN_MANIFEST_PATH = `${REPO_ROOT}${PLUGIN_ROOT}.claude-plugin/plugin.json`;

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf-8")) as T;
const readSource = (relPath: string): string => readFileSync(`${REPO_ROOT}${relPath}`, "utf-8");

// The tools the skill/commands are allowed to name (c-AC-2/c-AC-4's "existing surface only" rule).
const RECALL_TOOLS = ["hivemind_search", "memory_search"];
const ZOOM_TOOL = "hivemind_read";
const STORE_TOOL = "memory_store";
const FORGET_TOOL = "memory_forget";

// ─────────────────────────────────────────────────────────────────────────────
// c-AC-1 — the honeycomb-memory skill is bundled with valid, required frontmatter.
// ─────────────────────────────────────────────────────────────────────────────
describe("c-AC-1: the honeycomb-memory skill is bundled with valid frontmatter", () => {
	it("c-AC-1 the skill file exists at the plugin-contract-correct path and parses", () => {
		const source = readSource(SKILL_REL_PATH);
		expect(() => assertClaudeCodeSkillConforms(SKILL_REL_PATH, source)).not.toThrow();
	});

	it("c-AC-1 the frontmatter carries the required fields (name + a non-empty description)", () => {
		const source = readSource(SKILL_REL_PATH);
		const { frontmatter } = assertClaudeCodeSkillConforms(SKILL_REL_PATH, source);
		expect(frontmatter.name).toBe("honeycomb-memory");
		expect(typeof frontmatter.description).toBe("string");
		expect(frontmatter.description.length).toBeGreaterThan(0);
	});

	it("c-AC-1 the description targets memory-relevant work (not a generic placeholder)", () => {
		const source = readSource(SKILL_REL_PATH);
		const { frontmatter } = assertClaudeCodeSkillConforms(SKILL_REL_PATH, source);
		const description = frontmatter.description.toLowerCase();
		expect(description).toContain("memory");
		expect(description).toMatch(/before|prior|recall|remember/);
	});

	it("c-AC-1 the oracle BITES: a skill with no description is rejected", () => {
		const malformed = "---\nname: broken\n---\n\nBody with no description.\n";
		expect(() => assertClaudeCodeSkillConforms(SKILL_REL_PATH, malformed)).toThrow();
	});

	it("c-AC-1 the oracle BITES: a skill with no frontmatter block at all is rejected", () => {
		expect(() => assertClaudeCodeSkillConforms(SKILL_REL_PATH, "# Just a heading, no frontmatter\n")).toThrow(
			/no YAML frontmatter block/,
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// c-AC-2 — the skill body teaches the three behaviors, each naming an existing tool.
// ─────────────────────────────────────────────────────────────────────────────
describe("c-AC-2: the skill body instructs the three memory behaviors via existing tools", () => {
	it("c-AC-2 the body references the search-before-non-trivial-task tools", () => {
		const { body } = assertClaudeCodeSkillConforms(SKILL_REL_PATH, readSource(SKILL_REL_PATH));
		for (const tool of RECALL_TOOLS) {
			expect(body).toContain(tool);
		}
	});

	it("c-AC-2 the body references hivemind_read for citing + zooming a recalled decision", () => {
		const { body } = assertClaudeCodeSkillConforms(SKILL_REL_PATH, readSource(SKILL_REL_PATH));
		expect(body).toContain(ZOOM_TOOL);
	});

	it("c-AC-2 the body references memory_store and the closed memory-type taxonomy", () => {
		const { body } = assertClaudeCodeSkillConforms(SKILL_REL_PATH, readSource(SKILL_REL_PATH));
		expect(body).toContain(STORE_TOOL);
		for (const type of ["fact", "convention", "preference", "decision", "gotcha", "reference"]) {
			expect(body).toContain(type);
		}
	});

	it("c-AC-2 every tool the skill names is part of the real, existing tool surface", () => {
		const { body } = assertClaudeCodeSkillConforms(SKILL_REL_PATH, readSource(SKILL_REL_PATH));
		for (const tool of [...RECALL_TOOLS, ZOOM_TOOL, STORE_TOOL]) {
			expect(body).toContain(tool);
			expect(TOOL_NAMES).toContain(tool);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// c-AC-3 — the three slash commands are bundled with valid frontmatter.
// ─────────────────────────────────────────────────────────────────────────────
describe("c-AC-3: /recall, /remember, and /forget are bundled with valid frontmatter", () => {
	it.each([
		["recall", RECALL_REL_PATH],
		["remember", REMEMBER_REL_PATH],
		["forget", FORGET_REL_PATH],
	])("c-AC-3 %s.md exists at the plugin-contract-correct path, parses, and has a description", (_name, relPath) => {
		const source = readSource(relPath);
		const { frontmatter } = assertClaudeCodeCommandConforms(relPath, source);
		expect(typeof frontmatter.description).toBe("string");
		expect(frontmatter.description.length).toBeGreaterThan(0);
	});

	it("c-AC-3 the command names derived from their paths are recall, remember, forget", () => {
		expect(commandNameFromPath(RECALL_REL_PATH)).toBe("recall");
		expect(commandNameFromPath(REMEMBER_REL_PATH)).toBe("remember");
		expect(commandNameFromPath(FORGET_REL_PATH)).toBe("forget");
	});

	it("c-AC-3 /recall maps to the hybrid recall tools", () => {
		const { body } = assertClaudeCodeCommandConforms(RECALL_REL_PATH, readSource(RECALL_REL_PATH));
		for (const tool of RECALL_TOOLS) {
			expect(body).toContain(tool);
		}
	});

	it("c-AC-3 /remember maps to memory_store and the closed taxonomy", () => {
		const { body } = assertClaudeCodeCommandConforms(REMEMBER_REL_PATH, readSource(REMEMBER_REL_PATH));
		expect(body).toContain(STORE_TOOL);
		for (const type of ["fact", "convention", "preference", "decision", "gotcha", "reference"]) {
			expect(body).toContain(type);
		}
	});

	it("c-AC-3 /forget maps to memory_forget", () => {
		const { body } = assertClaudeCodeCommandConforms(FORGET_REL_PATH, readSource(FORGET_REL_PATH));
		expect(body).toContain(FORGET_TOOL);
	});

	it("c-AC-3 the oracle BITES: a command nested in a subdirectory is rejected", () => {
		expect(isCommandFilePath(`${PLUGIN_ROOT}commands/nested/recall.md`)).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// c-AC-4 — /forget collects a reason (memory_forget REQUIRES one, tools.ts:94).
// ─────────────────────────────────────────────────────────────────────────────
describe("c-AC-4: /forget collects a reason before calling memory_forget", () => {
	it("c-AC-4 memory_forget is in the real tool surface and requires a reason arg (sanity)", () => {
		expect(TOOL_NAMES).toContain(FORGET_TOOL);
	});

	it("c-AC-4 the command frontmatter declares a reason argument", () => {
		const { frontmatter } = assertClaudeCodeCommandConforms(FORGET_REL_PATH, readSource(FORGET_REL_PATH));
		const args = frontmatter.arguments;
		const argList = Array.isArray(args) ? args : typeof args === "string" ? args.split(/[\s,]+/) : [];
		expect(argList).toContain("reason");
	});

	it("c-AC-4 the body instructs collecting a reason and forbids calling memory_forget without one", () => {
		const { body } = assertClaudeCodeCommandConforms(FORGET_REL_PATH, readSource(FORGET_REL_PATH));
		const lower = body.toLowerCase();
		expect(lower).toContain("reason");
		expect(lower).toMatch(/require|mandatory|not optional/);
		expect(lower).toMatch(/ask the user|do not call|without one/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// c-AC-5 — placement matches the pinned plugin-contract convention (the executable oracle).
// ─────────────────────────────────────────────────────────────────────────────
describe("c-AC-5: the skill and commands live in the plugin-contract-correct directories", () => {
	it("c-AC-5 the skill path conforms to skills/<name>/SKILL.md", () => {
		expect(isSkillDirectoryPath(SKILL_REL_PATH)).toBe(true);
		expect(skillNameFromPath(SKILL_REL_PATH)).toBe("honeycomb-memory");
	});

	it("c-AC-5 each command path conforms to commands/<name>.md", () => {
		for (const relPath of [RECALL_REL_PATH, REMEMBER_REL_PATH, FORGET_REL_PATH]) {
			expect(isCommandFilePath(relPath)).toBe(true);
		}
	});

	it("c-AC-5 the oracle BITES: a skill file directly at the plugin root (not skills/<name>/) is rejected", () => {
		expect(isSkillDirectoryPath(`${PLUGIN_ROOT}SKILL.md`)).toBe(false);
		expect(isSkillDirectoryPath(`${PLUGIN_ROOT}skills/SKILL.md`)).toBe(false);
	});

	it("c-AC-5 the oracle BITES: a skill file misnamed (not SKILL.md) is rejected", () => {
		expect(isSkillDirectoryPath(`${PLUGIN_ROOT}skills/honeycomb-memory/README.md`)).toBe(false);
	});

	it("c-AC-5 the bundled artifacts sit at the plugin root, never inside .claude-plugin/", () => {
		// The docs are explicit: only plugin.json goes inside .claude-plugin/; skills/ and commands/
		// must be plugin-root siblings of it, or the loader never discovers them.
		expect(SKILL_REL_PATH.includes(".claude-plugin/")).toBe(false);
		for (const relPath of [RECALL_REL_PATH, REMEMBER_REL_PATH, FORGET_REL_PATH]) {
			expect(relPath.includes(".claude-plugin/")).toBe(false);
		}
	});

	it("c-AC-5 the shared frontmatter schema is exercised directly and bites a non-string description", () => {
		expect(() => claudeCodePluginComponentFrontmatter.parse({ description: 123 })).toThrow();
		expect(() => claudeCodePluginComponentFrontmatter.parse({ description: "ok" })).not.toThrow();
	});

	it("c-AC-5 parsePluginComponentMarkdown round-trips a minimal conformant file", () => {
		const source = "---\ndescription: A minimal test component.\n---\n\nBody text.\n";
		const { frontmatter, body } = parsePluginComponentMarkdown(source);
		expect(frontmatter.description).toBe("A minimal test component.");
		expect(body.trim()).toBe("Body text.");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// c-AC-6 — the bundling is additive: hooks, plugin.json, and the 076b MCP registration untouched.
// ─────────────────────────────────────────────────────────────────────────────
describe("c-AC-6: the bundling is additive; hooks + MCP registration are unchanged", () => {
	it("c-AC-6 the hooks config still parses and conforms to the hooks oracle", () => {
		const hooks = readJson(HOOKS_PATH);
		expect(() => assertClaudeCodeHooksConform(hooks)).not.toThrow();
	});

	it("c-AC-6 the 076b MCP registration still parses, conforms, and registers honeycomb", () => {
		const config = readJson(MCP_CONFIG_PATH);
		expect(() => assertClaudeCodePluginMcpConform(config)).not.toThrow();
		const parsed = assertClaudeCodePluginMcpConform(config);
		expect(parsed.mcpServers.honeycomb).toBeDefined();
	});

	it("c-AC-6 plugin.json carries no inline mcpServers/commands/skills enumeration (auto-discovery only)", () => {
		const manifest = readJson<Record<string, unknown>>(PLUGIN_MANIFEST_PATH);
		expect(manifest.mcpServers).toBeUndefined();
		expect(manifest.commands).toBeUndefined();
		expect(manifest.skills).toBeUndefined();
	});

	it("c-AC-6 the plugin manifest still names the honeycomb plugin (sanity: not accidentally emptied)", () => {
		const manifest = readJson<{ name: string }>(PLUGIN_MANIFEST_PATH);
		expect(manifest.name).toBe("honeycomb");
	});
});

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
 * Claude Code PLUGIN skills/commands placement - the REAL plugin component contract, as an
 * executable zod schema.
 *
 * ── What this is (the references gate, now EXECUTABLE for skills + commands) ─
 * `references/claude-code/hooks-schema.ts` pins the plugin HOOKS contract; `mcp-registration-
 * schema.ts` pins the plugin MCP-registration contract. This file does the same for the plugin's
 * two model/user-facing component surfaces PRD-076c bundles: a `skills/` directory (model-invoked
 * expertise) and a `commands/` directory (explicit slash commands). It encodes - as an INDEPENDENT
 * oracle derived from the VENDOR docs, not from Honeycomb's own artifacts - the directory layout
 * AND the frontmatter shape the Claude Code plugin loader requires to auto-discover each surface.
 * The conformance suite (`tests/plugins/claude-code-skills-commands.test.ts`) parses the EMITTED
 * `harnesses/claude-code/skills/honeycomb-memory/SKILL.md` and `harnesses/claude-code/commands/
 * {recall,remember,forget}.md` through THIS schema, so a misplaced file, a malformed frontmatter
 * block, or a missing load-bearing field FAILS the gate.
 *
 * This schema encodes the EXTERNAL Claude Code plugin protocol, NOT Honeycomb's own types. That
 * independence is the point: it is an oracle the bundled artifacts are checked against, never a
 * mirror of them.
 *
 * ── The pinned mechanism (c-AC-5): directory-discovered, no manifest entry ───
 * Per the vendor docs, plugin components load from FIXED default locations at the plugin root -
 * `skills/`, `commands/`, `agents/`, `hooks/`, `.mcp.json` - with NO manifest enumeration required;
 * `.claude-plugin/plugin.json` holds ONLY the plugin's own metadata (`name`, `description`,
 * `version`, ...), never component listings. Two placement rules are load-bearing and encoded here:
 *   1. A skill lives at `skills/<name>/SKILL.md` - a PER-SKILL subdirectory whose file is named
 *      EXACTLY `SKILL.md` (not `README.md` or any other name). The directory name becomes the
 *      skill's invocation name, namespaced by the plugin (`honeycomb/skills/honeycomb-memory/
 *      SKILL.md` -> `/honeycomb:honeycomb-memory`).
 *   2. A command lives at `commands/<name>.md` - a FLAT markdown file directly under `commands/`
 *      (no subdirectory required). The filename (minus `.md`) becomes the command's invocation
 *      name, namespaced by the plugin (`commands/recall.md` -> `/honeycomb:recall`).
 * Both component KINDS share ONE frontmatter schema: the docs are explicit that "Files in
 * `.claude/commands/` still work and support the SAME frontmatter" as a `SKILL.md`.
 *
 * ── The `description` requirement (Honeycomb authoring policy, not a loader hard-requirement) ──
 * The vendor loader does not strictly REQUIRE `description` (a skill without one falls back to the
 * first markdown paragraph) or `name` (it falls back to the directory/file name). This oracle goes
 * further and REQUIRES an explicit, non-empty `description` on every Honeycomb-bundled skill and
 * command, because:
 *   - for the skill, the description is what AUTO-TRIGGERS it on memory-relevant work (PRD-076c
 *     Part 1) - relying on the first-paragraph fallback would make the trigger surface an
 *     unreviewed accident of prose rather than a deliberate, tunable field;
 *   - for a command, the description is what renders in the `/` slash-command menu, and a command
 *     with no description is not meaningfully discoverable to the user (PRD-076c Part 2's whole
 *     point is user-facing discoverability).
 * This is a self-imposed Honeycomb authoring floor layered on top of the vendor contract, not a
 * claim about what the loader itself enforces - documented honestly rather than silently assumed.
 *
 * ── Sources (high fidelity, 2026-current) ───────────────────────────────────
 *   1. Claude Code skills reference (code.claude.com/docs/en/skills): SKILL.md frontmatter fields
 *      (`name`, `description`, `when_to_use`, `argument-hint`, `arguments`,
 *      `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`,
 *      `effort`, `context`); "Files in `.claude/commands/` still work and support the same
 *      frontmatter"; the plugin-namespacing table (`plugin/skills/<name>/SKILL.md` ->
 *      `/plugin:name`).
 *   2. Claude Code plugins reference (code.claude.com/docs/en/plugins): the default-location table
 *      - `skills/` (skill subdirectories), `commands/` (flat markdown), both at the PLUGIN ROOT,
 *      never inside `.claude-plugin/`; "Only `plugin.json` goes inside `.claude-plugin/`."
 *   3. `anthropics/claude-plugins-official` `plugin-dev/skills/plugin-structure/SKILL.md`: the
 *      canonical plugin tree (`commands/`, `agents/`, `skills/<name>/SKILL.md`, `hooks/hooks.json`,
 *      `.mcp.json` all at plugin root); "Auto-discovery: All `.md` files in `commands/` load
 *      automatically" / "Skills: Scans `skills/` for subdirectories containing `SKILL.md`."
 *
 * ── Fidelity caveats (be honest - see references/README.md) ──────────────────
 *   - The frontmatter schema PASSES THROUGH unknown keys (future vendor fields this gate does not
 *     yet know about) rather than inventing a closed shape we cannot justify.
 *   - This oracle does not validate the MARKDOWN BODY content of a skill/command (tool-name
 *     references, wording) - that is a plain string-matching assertion in the conformance suite,
 *     not a structural contract this schema can express.
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** The exact filename the loader requires for a skill (case-sensitive; no `README.md` alias). */
export const SKILL_FILENAME = "SKILL.md";

const stringOrList = z.union([z.string(), z.array(z.string())]);

/**
 * The ONE frontmatter schema shared by a plugin `SKILL.md` and a `commands/<name>.md` file - the
 * docs are explicit both surfaces "support the same frontmatter." `description` is asserted
 * REQUIRED here as Honeycomb's own authoring floor (see header); every other field mirrors the
 * vendor's documented optional set and is passed through untouched if present.
 */
export const claudeCodePluginComponentFrontmatter = z
	.object({
		name: z.string().min(1).optional(),
		description: z.string().min(1),
		when_to_use: z.string().min(1).optional(),
		"argument-hint": z.string().min(1).optional(),
		arguments: stringOrList.optional(),
		"disable-model-invocation": z.boolean().optional(),
		"user-invocable": z.boolean().optional(),
		"allowed-tools": stringOrList.optional(),
		"disallowed-tools": stringOrList.optional(),
		model: z.string().min(1).optional(),
		effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
		context: z.enum(["fork"]).optional(),
	})
	.passthrough();

export type ClaudeCodePluginComponentFrontmatter = z.infer<typeof claudeCodePluginComponentFrontmatter>;

/** A parsed plugin component markdown file: its validated frontmatter plus the body content. */
export interface ParsedPluginComponent {
	readonly frontmatter: ClaudeCodePluginComponentFrontmatter;
	readonly body: string;
}

// Matches a leading `---\n<yaml>\n---` block (optionally CRLF) and captures the remaining body.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse a plugin component markdown source (a `SKILL.md` or a `commands/<name>.md`) into its
 * validated frontmatter + body. Throws when no frontmatter block is found, when the YAML fails to
 * parse, or when the parsed object does not conform to {@link claudeCodePluginComponentFrontmatter}
 * (most commonly: a missing `description`).
 */
export function parsePluginComponentMarkdown(source: string): ParsedPluginComponent {
	const match = FRONTMATTER_RE.exec(source);
	if (!match) {
		throw new Error(
			"Claude Code plugin component conformance: no YAML frontmatter block (--- ... ---) found at the top " +
				"of the file - the loader requires one to know when/how to invoke the component.",
		);
	}
	const [, frontmatterBlock, body] = match;
	const raw = parseYaml(frontmatterBlock) ?? {};
	const frontmatter = claudeCodePluginComponentFrontmatter.parse(raw);
	return { frontmatter, body };
}

/**
 * True iff `relativePath` (repo-root-relative, `/`-separated) is a conformant skill placement:
 * `.../skills/<name>/SKILL.md`. The `skills` segment must sit exactly two segments above the
 * filename (a per-skill subdirectory), and the filename must be exactly {@link SKILL_FILENAME}.
 */
export function isSkillDirectoryPath(relativePath: string): boolean {
	const segments = relativePath.split("/");
	if (segments.length < 3) return false;
	if (segments[segments.length - 1] !== SKILL_FILENAME) return false;
	return segments[segments.length - 3] === "skills";
}

/**
 * True iff `relativePath` (repo-root-relative, `/`-separated) is a conformant command placement:
 * a FLAT `.md` file directly under a `commands/` directory (no subdirectory nesting).
 */
export function isCommandFilePath(relativePath: string): boolean {
	const segments = relativePath.split("/");
	if (segments.length < 2) return false;
	const last = segments[segments.length - 1];
	if (!last.endsWith(".md")) return false;
	return segments[segments.length - 2] === "commands";
}

/**
 * Assert a skill file CONFORMS to the plugin skill contract: correct placement
 * ({@link isSkillDirectoryPath}) AND parseable frontmatter with a required `description`. Returns
 * the parsed component on success; throws a descriptive `Error`/`ZodError` otherwise.
 */
export function assertClaudeCodeSkillConforms(relativePath: string, source: string): ParsedPluginComponent {
	if (!isSkillDirectoryPath(relativePath)) {
		throw new Error(
			`Claude Code plugin skill conformance: "${relativePath}" is not a "skills/<name>/${SKILL_FILENAME}" ` +
				"path - the loader only scans skills/ for subdirectories containing SKILL.md.",
		);
	}
	return parsePluginComponentMarkdown(source);
}

/**
 * Assert a command file CONFORMS to the plugin command contract: correct placement
 * ({@link isCommandFilePath}) AND parseable frontmatter with a required `description`. Returns the
 * parsed component on success; throws a descriptive `Error`/`ZodError` otherwise.
 */
export function assertClaudeCodeCommandConforms(relativePath: string, source: string): ParsedPluginComponent {
	if (!isCommandFilePath(relativePath)) {
		throw new Error(
			`Claude Code plugin command conformance: "${relativePath}" is not a "commands/<name>.md" path - the ` +
				"loader only scans commands/ for flat markdown files.",
		);
	}
	return parsePluginComponentMarkdown(source);
}

/** Derive the command's invocation name (pre plugin-namespacing) from a `commands/<name>.md` path. */
export function commandNameFromPath(relativePath: string): string {
	const last = relativePath.split("/").pop() ?? "";
	return last.replace(/\.md$/, "");
}

/** Derive the skill's invocation name (pre plugin-namespacing) from a `skills/<name>/SKILL.md` path. */
export function skillNameFromPath(relativePath: string): string {
	const segments = relativePath.split("/");
	return segments[segments.length - 2] ?? "";
}

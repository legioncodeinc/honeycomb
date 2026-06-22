/**
 * PRD-036a — local installed-asset scanner suite.
 *
 * Drives {@link scanInstalledAssets} against TEMP DIRS (injectable roots — never the
 * real home directory) to prove detection, extraction, dedupe, and fail-soft, then
 * one assertion that, pointed at THIS repo's project root, the scanner returns the
 * real `.claude/skills/` skills (count > 0; the spec says ~27) and the
 * `.claude/agents/` agents.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	extractDescription,
	scanInstalledAssets,
} from "../../../../src/daemon/runtime/dashboard/installed-assets.js";
import type { DiscoveredAsset } from "../../../../src/dashboard/contracts.js";

// ── Temp-dir fixture helpers ──────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "hc-036a-"));
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

/** Write a skill `<root>/<harnessDir>/skills/<name>/SKILL.md` with the given content. */
function writeSkill(root: string, harnessDir: string, name: string, content: string): string {
	const dir = join(root, harnessDir, "skills", name);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "SKILL.md");
	writeFileSync(file, content, "utf8");
	return file;
}

/** Write an agent `<root>/<harnessDir>/agents/<name>.md` with the given content. */
function writeAgent(root: string, harnessDir: string, name: string, content: string): string {
	const dir = join(root, harnessDir, "agents");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${name}.md`);
	writeFileSync(file, content, "utf8");
	return file;
}

const fm = (name: string, description: string): string => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`;

function byName(assets: readonly DiscoveredAsset[], name: string): DiscoveredAsset {
	const found = assets.find((a) => a.name === name);
	if (found === undefined) throw new Error(`asset not found: ${name}`);
	return found;
}

// ── a-AC-1 / a-AC-3 — skill detection + extraction ────────────────────────────

describe("PRD-036a scanInstalledAssets — detection + extraction", () => {
	it("a-AC-1: detects a skill via <name>/SKILL.md and extracts name + description from frontmatter", async () => {
		writeSkill(tmpRoot, ".claude", "library-stinger", fm("library-stinger", "Docs lifecycle skill."));
		const inv = await scanInstalledAssets({ projectRoot: tmpRoot });
		expect(inv.skills).toHaveLength(1);
		const skill = inv.skills[0]!;
		expect(skill.name).toBe("library-stinger");
		expect(skill.description).toBe("Docs lifecycle skill.");
		expect(skill.assetType).toBe("skill");
	});

	it("a-AC-2: detects an agent as a *.md file under the agents root with assetType 'agent'", async () => {
		writeAgent(tmpRoot, ".claude", "git-worker-bee", fm("git-worker-bee", "Git mastery specialist."));
		const inv = await scanInstalledAssets({ projectRoot: tmpRoot });
		expect(inv.agents).toHaveLength(1);
		const agent = inv.agents[0]!;
		expect(agent.name).toBe("git-worker-bee");
		expect(agent.description).toBe("Git mastery specialist.");
		expect(agent.assetType).toBe("agent");
	});

	it("a-AC-3: each DiscoveredAsset carries name, description, scope, sourceHarnesses, paths, assetType", async () => {
		const path = writeSkill(tmpRoot, ".cursor", "ci-stinger", fm("ci-stinger", "CI build skill."));
		const inv = await scanInstalledAssets({ projectRoot: tmpRoot });
		const skill = byName(inv.skills, "ci-stinger");
		expect(skill.scope).toBe("repository");
		expect(skill.sourceHarnesses).toEqual(["cursor"]);
		expect(skill.paths).toEqual([path]);
		expect(skill.assetType).toBe("skill");
		expect(typeof skill.description).toBe("string");
	});

	it("a-AC-3: a dir WITHOUT SKILL.md is not a skill; a non-.md file under agents is not an agent", async () => {
		// A child dir with no SKILL.md must not be detected.
		mkdirSync(join(tmpRoot, ".claude", "skills", "not-a-skill"), { recursive: true });
		writeFileSync(join(tmpRoot, ".claude", "skills", "not-a-skill", "README.md"), "# nope", "utf8");
		// A non-markdown file under agents must not be detected.
		mkdirSync(join(tmpRoot, ".claude", "agents"), { recursive: true });
		writeFileSync(join(tmpRoot, ".claude", "agents", "notes.txt"), "not an agent", "utf8");
		const inv = await scanInstalledAssets({ projectRoot: tmpRoot });
		expect(inv.skills).toHaveLength(0);
		expect(inv.agents).toHaveLength(0);
	});

	it("falls back to the first heading, then '', when frontmatter has no description", async () => {
		writeSkill(tmpRoot, ".claude", "headingskill", "---\nname: headingskill\n---\n\n# Heading Title\n\nBody.\n");
		writeSkill(tmpRoot, ".claude", "bareskill", "no frontmatter, no heading here\n");
		const inv = await scanInstalledAssets({ projectRoot: tmpRoot });
		expect(byName(inv.skills, "headingskill").description).toBe("Heading Title");
		expect(byName(inv.skills, "bareskill").description).toBe("");
	});

	it("extractDescription: prefers quoted frontmatter description, strips quotes", () => {
		expect(extractDescription('---\ndescription: "Quoted desc"\n---\n# H\n')).toBe("Quoted desc");
		expect(extractDescription("---\ndescription: 'single'\n---\n")).toBe("single");
		expect(extractDescription("# Only A Heading\n\ntext")).toBe("Only A Heading");
		expect(extractDescription("plain text only")).toBe("");
	});
});

// ── a-AC-4 — dedupe across harness roots ──────────────────────────────────────

describe("PRD-036a scanInstalledAssets — dedupe (D-2)", () => {
	it("a-AC-4: the same skill under two harness roots appears ONCE with both harnesses + paths", async () => {
		const p1 = writeSkill(tmpRoot, ".claude", "shared-stinger", fm("shared-stinger", "Shared."));
		const p2 = writeSkill(tmpRoot, ".cursor", "shared-stinger", fm("shared-stinger", "Shared."));
		const inv = await scanInstalledAssets({ projectRoot: tmpRoot });
		expect(inv.skills).toHaveLength(1);
		const skill = inv.skills[0]!;
		expect(skill.name).toBe("shared-stinger");
		expect([...skill.sourceHarnesses].sort()).toEqual(["claude-code", "cursor"]);
		expect([...skill.paths].sort()).toEqual([p1, p2].sort());
	});

	it("a-AC-4: a skill and an agent with the SAME name are distinct (key is (assetType, name))", async () => {
		writeSkill(tmpRoot, ".claude", "twin", fm("twin", "skill twin"));
		writeAgent(tmpRoot, ".claude", "twin", fm("twin", "agent twin"));
		const inv = await scanInstalledAssets({ projectRoot: tmpRoot });
		expect(inv.skills).toHaveLength(1);
		expect(inv.agents).toHaveLength(1);
		expect(inv.skills[0]!.description).toBe("skill twin");
		expect(inv.agents[0]!.description).toBe("agent twin");
	});
});

// ── a-AC-5 — fail-soft ────────────────────────────────────────────────────────

describe("PRD-036a scanInstalledAssets — fail-soft (D-3)", () => {
	it("a-AC-5: a missing project root yields an empty inventory, no throw", async () => {
		const missing = join(tmpRoot, "does-not-exist");
		const inv = await scanInstalledAssets({ projectRoot: missing });
		expect(inv).toEqual({ skills: [], agents: [] });
	});

	it("a-AC-5: an empty harness root contributes nothing", async () => {
		mkdirSync(join(tmpRoot, ".claude", "skills"), { recursive: true });
		mkdirSync(join(tmpRoot, ".claude", "agents"), { recursive: true });
		const inv = await scanInstalledAssets({ projectRoot: tmpRoot });
		expect(inv.skills).toHaveLength(0);
		expect(inv.agents).toHaveLength(0);
	});
});

// ── a-AC-6 — injectable global root (D-1 / D-4) ───────────────────────────────

describe("PRD-036a scanInstalledAssets — injectable roots (D-1 / D-4)", () => {
	it("D-1: the global root is NOT scanned by default (project-only)", async () => {
		const globalRoot = mkdtempSync(join(tmpdir(), "hc-036a-global-"));
		try {
			writeSkill(globalRoot, ".claude", "global-only", fm("global-only", "Global skill."));
			const inv = await scanInstalledAssets({ projectRoot: tmpRoot, globalRoot });
			expect(inv.skills).toHaveLength(0);
		} finally {
			rmSync(globalRoot, { recursive: true, force: true });
		}
	});

	it("D-1: includeGlobal scans the global root with scope 'user'", async () => {
		const globalRoot = mkdtempSync(join(tmpdir(), "hc-036a-global-"));
		try {
			writeSkill(globalRoot, ".claude", "global-skill", fm("global-skill", "Global."));
			const inv = await scanInstalledAssets({ projectRoot: tmpRoot, globalRoot, includeGlobal: true });
			expect(inv.skills).toHaveLength(1);
			expect(inv.skills[0]!.scope).toBe("user");
		} finally {
			rmSync(globalRoot, { recursive: true, force: true });
		}
	});
});

// ── a-AC-1 (real repo) — finds THIS repo's installed assets ───────────────────

describe("PRD-036a scanInstalledAssets — real repo project root", () => {
	/** This test file is at tests/daemon/runtime/dashboard/ → repo root is four dirs up. */
	function repoRoot(): string {
		const here = dirname(fileURLToPath(import.meta.url));
		return join(here, "..", "..", "..", "..");
	}

	it("a-AC-1: pointed at this repo, returns the real .claude/skills/ skills (count > 0)", async () => {
		const inv = await scanInstalledAssets({ projectRoot: repoRoot() });
		expect(inv.skills.length).toBeGreaterThan(0);
		// Each carries a name + the claude-code harness, and at least one is a known repo skill.
		expect(inv.skills.every((s) => s.assetType === "skill" && s.name.length > 0)).toBe(true);
		expect(inv.skills.some((s) => s.sourceHarnesses.includes("claude-code"))).toBe(true);
		expect(inv.skills.some((s) => s.name === "library-stinger")).toBe(true);
	});

	it("a-AC-2: pointed at this repo, returns the real .claude/agents/ agents (count > 0)", async () => {
		const inv = await scanInstalledAssets({ projectRoot: repoRoot() });
		expect(inv.agents.length).toBeGreaterThan(0);
		expect(inv.agents.every((a) => a.assetType === "agent" && a.name.length > 0)).toBe(true);
	});
});

/**
 * Filesystem SKILL.md install target — PRD-016b Wave 1 (the b-AC-5 path resolver).
 *
 * Implements the {@link SkillInstallTarget} seam against the real filesystem:
 *   - `install=project` → `<projectDir>/.claude/skills/<name>/SKILL.md`
 *   - `install=global`  → `<globalDir>/.claude/skills/<name>/SKILL.md`
 *
 * In production `projectDir` is the shell's `cwd` and `globalDir` is the user's home
 * (`~`). BOTH are INJECTABLE so a unit test points them at temp dirs and asserts the
 * project-vs-global path WITHOUT writing to the real cwd / home (b-AC-5). The base
 * dirs default to `process.cwd()` and `os.homedir()`.
 *
 * This module is filesystem-only — it NEVER touches DeepLake. The append-only `skills`
 * row is written separately through the daemon's storage path (b-AC-6). The skill
 * `name` is reduced to a single safe path segment so a crafted name can never traverse
 * out of the skills root.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SkillInstall, SkillInstallTarget } from "./contracts.js";

/** The skills subdir under each root, mirroring the host-agent convention. */
const SKILLS_SUBDIR = join(".claude", "skills");
/** The canonical file name written inside each `<name>/` dir. */
const SKILL_FILE = "SKILL.md";

/** Construction dirs for {@link createFsInstallTarget} (injectable for tests). */
export interface FsInstallDirs {
	/** The project root — `install=project` writes under `<projectDir>/.claude/skills/`. Default `process.cwd()`. */
	readonly projectDir?: string;
	/** The global root — `install=global` writes under `<globalDir>/.claude/skills/`. Default `os.homedir()`. */
	readonly globalDir?: string;
}

/**
 * Build a filesystem {@link SkillInstallTarget}. `install=project` writes under
 * `projectDir`; `install=global` under `globalDir`. A test injects both as temp dirs
 * to prove the b-AC-5 routing without touching the real cwd / home.
 */
export function createFsInstallTarget(dirs: FsInstallDirs = {}): SkillInstallTarget {
	const projectDir = dirs.projectDir ?? process.cwd();
	const globalDir = dirs.globalDir ?? homedir();

	const rootFor = (install: SkillInstall): string =>
		join(install === "global" ? globalDir : projectDir, SKILLS_SUBDIR);
	const fileFor = (install: SkillInstall, name: string): string =>
		join(rootFor(install), sanitizeSegment(name), SKILL_FILE);

	return {
		async write(install: SkillInstall, name: string, markdown: string): Promise<string> {
			const path = fileFor(install, name);
			mkdirSync(join(rootFor(install), sanitizeSegment(name)), { recursive: true });
			writeFileSync(path, markdown, "utf-8");
			return path;
		},
		async read(install: SkillInstall, name: string): Promise<string | null> {
			try {
				return readFileSync(fileFor(install, name), "utf-8");
			} catch {
				return null;
			}
		},
	};
}

/**
 * Reduce a skill name to a SINGLE safe path segment — only `[A-Za-z0-9._-]`, every
 * other char (including `/`, `\`, `..`) becomes `_`. So a crafted skill name can
 * never traverse out of the `.claude/skills/` root.
 */
function sanitizeSegment(name: string): string {
	const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_");
	return cleaned === "" ? "untitled-skill" : cleaned;
}

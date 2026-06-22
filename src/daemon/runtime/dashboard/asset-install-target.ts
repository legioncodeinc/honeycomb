/**
 * Filesystem install target for BOTH asset kinds — PRD-042 (the pull/enable/disable write seam).
 *
 * The Sync page's pull/enable installs a native artifact on disk; disable removes it. This is the
 * symmetric install target the action engine ({@link import("./sync-api.js").createSyncActionApi})
 * writes/removes through, generalizing `skillify/install-target.ts` over the asset KIND:
 *
 *   - SKILL  → `<root>/.claude/skills/<name>/SKILL.md` (a skill is a directory — the b-AC-5 convention).
 *   - AGENT  → `<root>/.claude/agents/<name>.md`        (an agent is a single FILE under the agents root).
 *
 * `install=project` writes under `projectDir` (default `process.cwd()`); `install=global` under
 * `globalDir` (default `os.homedir()`). BOTH are INJECTABLE so a test points them at temp dirs and
 * never touches the real cwd / home.
 *
 * ── Path-sanitize discipline (parent SECURITY / 042b implementation note) ────
 * The asset `name` is reduced to a SINGLE safe path segment by {@link sanitizeSegment}: every char
 * outside `[A-Za-z0-9._-]` → `_`, AND an empty-or-all-dots result (`.`, `..`) is collapsed to the
 * inert `untitled-asset` fallback. So a crafted agent name (`../../etc/passwd`, `a/b`, or a bare
 * `..`) can NEVER traverse out of the agents/skills root — the separators are stripped and the
 * dot-only traversal forms are rejected rather than left as a live `..` path component. This module
 * touches the filesystem ONLY; it NEVER opens DeepLake (the substrate write is the daemon's path).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SyncedAssetType } from "../../storage/catalog/synced-assets.js";

/** Where an install writes (project root vs global home). */
export type AssetInstall = "project" | "global";

/** The `.claude` skills subdir (a skill is a `<name>/SKILL.md` directory). */
const SKILLS_SUBDIR = join(".claude", "skills");
/** The `.claude` agents subdir (an agent is a single `<name>.md` file). */
const AGENTS_SUBDIR = join(".claude", "agents");
/** The canonical file written inside each skill dir. */
const SKILL_FILE = "SKILL.md";

/**
 * The install-target seam the Sync action engine writes/removes through. Generalizes the skillify
 * install target over the asset kind: `write` installs the native artifact (creating the skill dir
 * or the agent file), `remove` deletes the on-disk presence (the disable toggle, parent OQ-2). Both
 * return enough to confirm the effect (the written path / a removed flag) so the action's
 * poll-convergent confirm has a local signal too.
 */
export interface AssetInstallTarget {
	/** Write the native artifact for `assetType`/`name` under the install root; returns the path or null. */
	write(assetType: SyncedAssetType, install: AssetInstall, name: string, body: string): Promise<string | null>;
	/** Remove the on-disk presence for `assetType`/`name`; returns true when something was removed. */
	remove(assetType: SyncedAssetType, install: AssetInstall, name: string): Promise<boolean>;
	/** Read the on-disk native artifact for `assetType`/`name`, or null when absent/unreadable. */
	read(assetType: SyncedAssetType, install: AssetInstall, name: string): Promise<string | null>;
	/** True iff the asset is currently installed on disk under the install root. */
	exists(assetType: SyncedAssetType, install: AssetInstall, name: string): boolean;
}

/** Construction dirs for {@link createFsAssetInstallTarget} (injectable for tests). */
export interface FsAssetInstallDirs {
	/** The project root — `install=project` writes under it. Default `process.cwd()`. */
	readonly projectDir?: string;
	/** The global root — `install=global` writes under it. Default `os.homedir()`. */
	readonly globalDir?: string;
}

/**
 * Build a filesystem {@link AssetInstallTarget}. A skill installs as `<root>/.claude/skills/<name>/
 * SKILL.md`; an agent as `<root>/.claude/agents/<name>.md`. The `name` is path-sanitized to one safe
 * segment so a crafted name cannot escape the asset root. Fail-soft: a write/remove error returns
 * null/false rather than throwing into the action engine (which surfaces "action failed").
 */
export function createFsAssetInstallTarget(dirs: FsAssetInstallDirs = {}): AssetInstallTarget {
	const projectDir = dirs.projectDir ?? process.cwd();
	const globalDir = dirs.globalDir ?? homedir();

	const rootFor = (install: AssetInstall): string => (install === "global" ? globalDir : projectDir);

	/** Resolve the absolute on-disk path the artifact lives at (skill dir file vs agent file). */
	const pathFor = (assetType: SyncedAssetType, install: AssetInstall, name: string): { dir: string; file: string } => {
		const root = rootFor(install);
		const segment = sanitizeSegment(name);
		if (assetType === "agent") {
			const dir = join(root, AGENTS_SUBDIR);
			return { dir, file: join(dir, `${segment}.md`) };
		}
		const dir = join(root, SKILLS_SUBDIR, segment);
		return { dir, file: join(dir, SKILL_FILE) };
	};

	return {
		async write(assetType, install, name, body): Promise<string | null> {
			try {
				const { dir, file } = pathFor(assetType, install, name);
				mkdirSync(dir, { recursive: true });
				writeFileSync(file, body, "utf-8");
				return file;
			} catch {
				return null;
			}
		},
		async read(assetType, install, name): Promise<string | null> {
			try {
				const { file } = pathFor(assetType, install, name);
				if (!existsSync(file)) return null;
				return readFileSync(file, "utf-8");
			} catch {
				return null;
			}
		},
		async remove(assetType, install, name): Promise<boolean> {
			try {
				const { dir, file } = pathFor(assetType, install, name);
				if (assetType === "agent") {
					if (!existsSync(file)) return false;
					rmSync(file, { force: true });
					return true;
				}
				// A skill is a directory — remove the whole `<name>/` dir (its SKILL.md + sidecars).
				if (!existsSync(dir)) return false;
				rmSync(dir, { recursive: true, force: true });
				return true;
			} catch {
				return false;
			}
		},
		exists(assetType, install, name): boolean {
			try {
				return existsSync(pathFor(assetType, install, name).file);
			} catch {
				return false;
			}
		},
	};
}

/**
 * Reduce an asset name to a SINGLE safe path segment — only `[A-Za-z0-9._-]`, every other char
 * (including `/`, `\`) becomes `_`. So a crafted agent/skill name can NEVER traverse out of the
 * `.claude/{agents,skills}/` root.
 *
 * SECURITY (PRD-042 path-traversal hardening): the char-class replace ALONE is not sufficient,
 * because `.` and `-` are in the allow-list, so a pure-dot name (`.`, `..`, `...`) survives the
 * replace UNCHANGED and is then a live path component: `join(root, "skills", "..", "SKILL.md")`
 * normalizes UP and escapes the skills root (and a skill `remove` would `rmSync` the parent
 * `.claude/` dir recursively). So a name that is empty OR all-dots after cleaning collapses to the
 * inert `untitled-asset` fallback — never a `.`/`..` segment. A leading `.` on a longer name (a
 * dotfile-style `.foo`) is harmless and preserved; only the all-dots traversal forms are rejected.
 */
export function sanitizeSegment(name: string): string {
	const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_");
	// Reject the empty result AND any all-dots segment (`.`, `..`, `...`): those are the only
	// post-clean forms that can still traverse (a path component made solely of dots).
	if (cleaned === "" || /^\.+$/.test(cleaned)) return "untitled-asset";
	return cleaned;
}

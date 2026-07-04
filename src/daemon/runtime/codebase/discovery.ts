/**
 * Source-file discovery — PRD-014a Wave 1 (a-AC-3 / a-AC-6 / FR-4..FR-6).
 *
 * Enumerates the source files the graph build extracts, honoring `.gitignore` exactly
 * and excluding non-source files. Two modes, one shape:
 *
 *   1. GIT (preferred, a-AC-3 / FR-4). `git ls-files --cached --others
 *      --exclude-standard -z` lists tracked + untracked-but-not-ignored files,
 *      applying `.gitignore` EXACTLY as git does (no re-implementation of ignore
 *      semantics). NUL-delimited (`-z`) so paths with spaces/newlines survive.
 *   2. MANUAL WALK (fallback, a-AC-6 / FR-4). When git is unavailable (no repo, no
 *      git binary), a recursive walk that SKIPS dotfiles + dot-directories and a set
 *      of always-ignored directory names (`node_modules`, `dist`, `build`, …). This
 *      is best-effort: it does NOT parse `.gitignore` (only git does that exactly),
 *      it just avoids the obvious noise.
 *
 * In BOTH modes:
 *   - `.d.ts` declaration files are EXCLUDED (a-AC-3 / FR-6) — no implementation to
 *     extract.
 *   - only files whose extension a {@link languageForFile} recognizes are kept.
 *   - a user-editable ignore set at `~/.apiary/honeycomb/graph-ignore.json` (or an injected
 *     path) is applied as a SAFETY NET over tracked directories (FR-5) — so a vendored
 *     dir that git tracks can still be excluded from the graph.
 *   - the result is BOUNDED (a hard file cap) so a pathological repo cannot blow up
 *     the build (the security/DoS guardrail Wave 3 checks).
 *
 * Returns repo-relative, forward-slash-normalized paths, sorted, deduped. This module
 * does ONLY discovery — no parsing, no DeepLake.
 */

import { execFileSync } from "node:child_process";
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";

import { honeycombStateDir, legacyHoneycombDir, preferExistingPath } from "../../../shared/fleet-root.js";
import { languageForFile } from "./extract.js";

/**
 * The hard cap on discovered files (the DoS guardrail). A repo with more source files
 * than this is truncated (deterministically, by sort order) and the caller is told via
 * {@link DiscoveryResult.truncated}. 50k source files is far beyond any real repo the
 * graph targets; the cap exists so a runaway directory cannot exhaust memory.
 */
export const MAX_DISCOVERED_FILES = 50_000;

/** Directory names the manual walk ALWAYS skips (a-AC-6). Not a `.gitignore` parse — the obvious noise. */
export const ALWAYS_IGNORED_DIRS = Object.freeze(
	new Set(["node_modules", "dist", "build", "bundle", "out", "coverage", "target", "vendor", ".git"]),
);

/** The outcome of a discovery pass. */
export interface DiscoveryResult {
	/** Repo-relative, forward-slash, sorted, deduped source paths. */
	readonly files: readonly string[];
	/** Which mode produced the list. */
	readonly mode: "git" | "manual";
	/** True when the result was capped at {@link MAX_DISCOVERED_FILES}. */
	readonly truncated: boolean;
}

/** Injectable seams for discovery (so tests drive git availability + the ignore set). */
export interface DiscoveryDeps {
	/**
	 * Run `git ls-files` in `repoRoot` and return its NUL-delimited stdout, or `null`
	 * when git is unavailable / not a repo (→ the manual-walk fallback). Defaults to a
	 * real `execFileSync` of the git binary.
	 */
	readonly gitLsFiles?: (repoRoot: string) => string | null;
	/**
	 * The path to the user ignore set (FR-5). Defaults to `~/.honeycomb/graph-ignore.json`.
	 * The file is `{ "ignore": ["dir/", "path/glob"] }`; missing file ⇒ no extra ignores.
	 */
	readonly graphIgnorePath?: string;
}

/**
 * Discover the source files under `repoRoot` (a-AC-3 / a-AC-6). Prefers git; falls
 * back to a manual walk. Excludes `.d.ts`, keeps only recognized source extensions,
 * applies the user ignore set, and bounds the result.
 */
export function discoverSourceFiles(repoRoot: string, deps: DiscoveryDeps = {}): DiscoveryResult {
	const gitLsFiles = deps.gitLsFiles ?? defaultGitLsFiles;
	const userIgnore = loadUserIgnore(deps.graphIgnorePath ?? defaultGraphIgnorePath());

	const gitOut = gitLsFiles(repoRoot);
	const raw =
		gitOut !== null
			? { mode: "git" as const, paths: gitOut.split("\0").filter((p) => p.length > 0) }
			: { mode: "manual" as const, paths: manualWalk(repoRoot) };

	const kept: string[] = [];
	const seen = new Set<string>();
	let truncated = false;
	for (const p of raw.paths) {
		const norm = normalize(p);
		if (norm === "" || seen.has(norm)) continue;
		if (!isSourceCandidate(norm)) continue;
		if (isUserIgnored(norm, userIgnore)) continue;
		seen.add(norm);
		kept.push(norm);
		if (kept.length >= MAX_DISCOVERED_FILES) {
			truncated = true;
			break;
		}
	}
	kept.sort();
	return { files: kept, mode: raw.mode, truncated };
}

/**
 * A path is a source candidate when it is NOT a `.d.ts` declaration (a-AC-3 / FR-6)
 * and its extension routes to a language ({@link languageForFile} is non-null). The
 * `.d.ts` exclusion is also enforced inside `languageForFile`, but checking here keeps
 * discovery's intent explicit and independent.
 */
function isSourceCandidate(path: string): boolean {
	const lower = path.toLowerCase();
	if (lower.endsWith(".d.ts") || lower.endsWith(".d.mts") || lower.endsWith(".d.cts")) return false;
	return languageForFile(path) !== null;
}

// ── Git mode ─────────────────────────────────────────────────────────────────

/**
 * Default git lister: `git ls-files --cached --others --exclude-standard -z`. Returns
 * the NUL-delimited stdout, or `null` if git fails (not a repo / no git binary) so the
 * caller falls back to the manual walk. `--exclude-standard` applies `.gitignore`,
 * `.git/info/exclude`, and the global excludes — the EXACT ignore semantics (FR-4).
 */
function defaultGitLsFiles(repoRoot: string): string | null {
	try {
		const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
			cwd: repoRoot,
			encoding: "buffer",
			// Bound output so a giant repo cannot exhaust the buffer.
			maxBuffer: 256 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
			// Hide the transient console window on Windows (background git probe, not interactive).
			windowsHide: true,
		});
		return out.toString("utf8");
	} catch {
		return null;
	}
}

// ── Manual-walk mode (a-AC-6) ─────────────────────────────────────────────────

/**
 * Recursive directory walk used when git is unavailable (a-AC-6 / FR-4). SKIPS:
 *   - any entry whose name starts with `.` (dotfiles AND dot-directories);
 *   - any directory whose name is in {@link ALWAYS_IGNORED_DIRS};
 *   - symlinks (never followed — the traversal-out-of-root guard Wave 3 checks).
 * Returns absolute paths; the caller normalizes to repo-relative. Bounded by the same
 * cap the outer pass enforces (it stops early once enough candidates accumulate).
 */
function manualWalk(repoRoot: string): string[] {
	const out: string[] = [];
	const stack: string[] = [repoRoot];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (dir === undefined) break;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue; // unreadable dir — skip, never abort
		}
		for (const entry of entries) {
			// Dotfiles + dot-directories are skipped (a-AC-6).
			if (entry.name.startsWith(".")) continue;
			const full = join(dir, entry.name);
			// Never follow symlinks (traversal-out-of-root guard).
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (ALWAYS_IGNORED_DIRS.has(entry.name)) continue;
				stack.push(full);
			} else if (entry.isFile()) {
				out.push(relative(repoRoot, full));
			}
		}
		// Soft bound so a pathological tree does not accumulate unboundedly before the
		// outer cap applies (the outer pass enforces the hard cap on kept files).
		if (out.length >= MAX_DISCOVERED_FILES * 4) break;
	}
	return out;
}

// ── User ignore set (FR-5) ─────────────────────────────────────────────────────

/** A normalized user ignore set: directory prefixes + exact paths. */
interface UserIgnore {
	readonly dirPrefixes: readonly string[];
	readonly exact: ReadonlySet<string>;
}

/**
 * Default user ignore-set path: `~/.apiary/honeycomb/graph-ignore.json` (FR-5, ADR-0003 / PRD-072b),
 * read new-first with a legacy `~/.honeycomb/graph-ignore.json` fallback. The file is user-edited
 * (not regenerable), so the migration mover relocates it; this fallback covers the not-yet-migrated
 * case.
 */
function defaultGraphIgnorePath(): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
	return preferExistingPath(
		join(honeycombStateDir({ home }), "graph-ignore.json"),
		join(legacyHoneycombDir(home), "graph-ignore.json"),
	);
}

/**
 * Load the user ignore set (FR-5). The file is `{ "ignore": ["dir/", "exact/path.ts"] }`.
 * An entry ending in `/` is a directory prefix (everything under it is ignored); any
 * other entry is an exact path. A missing/corrupt file yields an empty set (no extra
 * ignores — never a crash).
 */
function loadUserIgnore(path: string): UserIgnore {
	if (!existsSync(path)) return { dirPrefixes: [], exact: new Set() };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { ignore?: unknown };
		const list = Array.isArray(parsed.ignore) ? parsed.ignore.filter((x): x is string => typeof x === "string") : [];
		const dirPrefixes: string[] = [];
		const exact = new Set<string>();
		for (const raw of list) {
			const norm = normalize(raw);
			if (norm === "") continue;
			if (norm.endsWith("/")) dirPrefixes.push(norm);
			else exact.add(norm);
		}
		return { dirPrefixes, exact };
	} catch {
		return { dirPrefixes: [], exact: new Set() };
	}
}

/** True when a repo-relative path is excluded by the user ignore set (FR-5). */
function isUserIgnored(path: string, ignore: UserIgnore): boolean {
	if (ignore.exact.has(path)) return true;
	for (const prefix of ignore.dirPrefixes) {
		if (path.startsWith(prefix)) return true;
	}
	return false;
}

// ── Path normalization ─────────────────────────────────────────────────────────

/** Normalize a path to forward slashes, trimmed of a leading `./` and surrounding space. */
function normalize(p: string): string {
	const fwd = p.trim().split(sep).join("/").replace(/\\/g, "/");
	return fwd.replace(/^\.\//, "");
}

// Re-export the cap + ignored-dir set so the harness + tests share them.
export { languageForFile };

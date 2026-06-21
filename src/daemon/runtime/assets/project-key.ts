/**
 * PRD-033a — `projectKey()` (FR-7).
 *
 * The `Repository`-style keying axis: an artifact whose style is `Repository` is
 * keyed by PROJECT, and the project key is the documented skillify convention —
 * the SHA-1 of `git config remote.origin.url`, falling back to the absolute path
 * of the directory for a non-git project. (No production SHA-1 helper existed
 * yet — the skillify counter referenced this convention by description only; 033a
 * adds the real helper.)
 *
 * The raw SHA-1 hex is sanitized into a SINGLE safe path segment so it can key a
 * state file or a registry entry without traversal risk.
 *
 * Pure + local (D-6): runs `git config --get remote.origin.url` (a constant
 * command, no interpolation) under an INJECTABLE git-reader seam so a test drives
 * both the git and the non-git branch deterministically with no real `git`. Opens
 * no DeepLake and no network.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

/**
 * Read a git directory's `remote.origin.url`, or `null` when the dir is not a git
 * repo / has no origin remote. The INJECTABLE seam projectKey resolves against —
 * the production reader runs the constant `git` command; a test injects a fixed
 * value (or `null`) to drive both branches with no real git.
 */
export type GitRemoteReader = (cwd: string) => string | null;

/**
 * The production {@link GitRemoteReader}: `git config --get remote.origin.url` in
 * `cwd`. Uses `execFileSync` with ARRAYED args (never a shell string), so the cwd
 * is a process option and nothing is interpolated into a command line — no
 * injection surface. A non-zero exit (not a repo, no remote) is swallowed → `null`.
 */
export const defaultGitRemoteReader: GitRemoteReader = (cwd) => {
	try {
		const out = execFileSync("git", ["config", "--get", "remote.origin.url"], {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
		const url = out.trim();
		return url === "" ? null : url;
	} catch {
		return null;
	}
};

/**
 * Compute the project key for a directory (FR-7). When the dir is a git repo with
 * an origin remote, the key is the SHA-1 hex of that remote URL (so every clone of
 * the same repo shares one key, regardless of local path). Otherwise the key is
 * the SHA-1 hex of the ABSOLUTE path of the directory (so a non-git project is
 * still stably keyed per-location).
 *
 * The result is the raw 40-char SHA-1 hex — already a single safe segment
 * (`[0-9a-f]`), but routed through {@link sanitizeKeySegment} for defense in depth.
 *
 * @param cwd        the project directory.
 * @param readRemote the git-remote reader seam (default {@link defaultGitRemoteReader}).
 */
export function projectKey(cwd: string, readRemote: GitRemoteReader = defaultGitRemoteReader): string {
	const remote = readRemote(cwd);
	const basis = remote !== null ? remote : resolve(cwd);
	const hex = createHash("sha1").update(basis).digest("hex");
	return sanitizeKeySegment(hex);
}

/**
 * Reduce a project key to a SINGLE safe path/registry segment: only
 * `[A-Za-z0-9_-]`, every other char becomes `_`. The SHA-1 hex already satisfies
 * this, but sanitizing means a hand-passed key can never traverse out of a state
 * dir or a registry namespace. An empty result collapses to `"default"`.
 */
export function sanitizeKeySegment(value: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "_");
	return cleaned === "" ? "default" : cleaned;
}

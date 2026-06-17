/**
 * Git auto-commit helper (PRD-004c FR-4 / c-AC-2 / c-AC-4 / c-AC-5).
 *
 * Stages and commits the workspace when git sync is enabled. Implemented by
 * shelling out to `git` — no library dependency (per EXECUTION_LEDGER D-6 /
 * CONVENTIONS §004c). The helper is INJECTED into `createFileWatcherService`
 * via the `gitSync` dep, so tests can stub it without any git process.
 *
 * Design decisions:
 *  - Uses `node:child_process.execFile` (not `exec`) to avoid shell injection.
 *  - Staging is SCOPED to an explicit pathspec list — NEVER `git add -A`. The
 *    watcher manages a known, bounded set of identity files; staging the whole
 *    working tree would auto-commit any unrelated file that happens to sit in the
 *    repo (a stray `.env`, a token file, `credentials.json`), turning the identity
 *    sync into a credential-exfiltration path. Each pathspec is passed after a
 *    `--` separator as a fixed argv element, so a filename can neither be
 *    interpreted as a `git` option nor reach a shell.
 *  - A `git commit` with no staged changes exits non-zero with the well-known
 *    message "nothing to commit" — we detect this and treat it as success (no
 *    spurious-commit, c-AC-4).
 *  - The commit author identity is NOT enforced here; the caller must ensure
 *    the workspace git repo has `user.name`/`user.email` configured locally or
 *    globally, or pass them via env. Tests set them per-repo via a git-init
 *    fixture so the suite is hermetic.
 *  - Failures are surfaced as thrown `Error`s — the watcher catches them,
 *    logs, and keeps running (FR-8 / guide 09-error-handling).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Options for a single git-commit run. */
export interface GitCommitOptions {
	/** Absolute path to the workspace root (the git repo). */
	readonly workspaceDir: string;
	/** The commit message to use (caller supplies the ISO-8601 timestamp). */
	readonly message: string;
	/**
	 * The EXPLICIT, bounded list of pathspecs to stage — the identity files the
	 * watcher manages, NEVER the whole working tree. Each entry is staged via
	 * `git add -- <pathspec>` so an unrelated file in the repo (a `.env`, a token
	 * file, `credentials.json`) is never swept into the auto-commit. Relative to
	 * `workspaceDir` or absolute; git resolves either against `cwd`. An empty list
	 * stages nothing and the commit reports `nothing-to-commit`.
	 */
	readonly pathspecs: readonly string[];
}

/**
 * Stage ONLY `pathspecs` (`git add -- …`) then `git commit -m <message>` in
 * `workspaceDir`. Staging is deliberately scoped — `git add -A` is never used —
 * so the identity sync can never auto-commit an unrelated secret that happens to
 * live in the repo.
 *
 * Returns `"committed"` when a new commit was made, `"nothing-to-commit"`
 * when the staged set produced no change (or `pathspecs` was empty), or throws
 * on a hard git error (missing binary, non-git dir, etc.).
 *
 * The caller (file-watcher) logs the result and never rethrows — a commit
 * failure keeps the watcher running (FR-8).
 */
export async function gitStageAndCommit(opts: GitCommitOptions): Promise<"committed" | "nothing-to-commit"> {
	const { workspaceDir, message, pathspecs } = opts;

	// Nothing to stage → nothing to commit. Avoids a bare `git add --` (which
	// would error) and short-circuits the clean-tree case.
	if (pathspecs.length === 0) return "nothing-to-commit";

	// Stage ONLY the explicit identity-file pathspecs. The `--` separator and the
	// fixed-argv form guarantee a filename is treated as a path, never as a flag
	// or a shell token. NOT `git add -A` — that would stage the whole tree.
	await execFileAsync("git", ["add", "--", ...pathspecs], { cwd: workspaceDir });

	// Commit. `git commit` exits non-zero when there is nothing to commit;
	// we detect that specific case and return gracefully.
	try {
		await execFileAsync("git", ["commit", "-m", message], { cwd: workspaceDir });
		return "committed";
	} catch (err) {
		// `execFile` rejects with an object whose `stdout`/`stderr` fields carry
		// the git output. Check for the well-known "nothing to commit" string.
		if (isNothingToCommit(err)) {
			return "nothing-to-commit";
		}
		// Re-throw genuine git errors (bad repo, locked index, etc.)
		throw err instanceof Error ? err : new Error(String(err));
	}
}

/**
 * Detect git's "nothing to commit" exit: the working tree was already clean
 * after staging. The message differs slightly across git versions and locales,
 * so we check both stdout and stderr for the canonical phrase.
 */
function isNothingToCommit(err: unknown): boolean {
	if (err === null || typeof err !== "object") return false;
	const obj = err as Record<string, unknown>;
	const combined = `${String(obj["stdout"] ?? "")} ${String(obj["stderr"] ?? "")}`.toLowerCase();
	return (
		combined.includes("nothing to commit") ||
		combined.includes("nothing added to commit") ||
		combined.includes("no changes added to commit")
	);
}

/**
 * Build the timestamped commit message used by the file watcher (c-AC-2).
 * Format: `chore: identity sync <ISO-8601 timestamp>`
 *
 * The timestamp is injected by the watcher's clock so tests are deterministic.
 */
export function buildCommitMessage(timestamp: string): string {
	return `chore: identity sync ${timestamp}`;
}

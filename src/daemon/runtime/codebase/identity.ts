/**
 * Snapshot-identity resolution — PRD-014 daemon-assembly wiring.
 *
 * The graph build (014a/b/c) is keyed by a {@link SnapshotIdentity}
 * `(org, workspace, repo, user, worktree, commit)`. The tenant half (`org` /
 * `workspace`) comes from the daemon's request/default {@link QueryScope}; the repo
 * half (`repo` / `user` / `worktree` / `commit`) is resolved HERE from the workspace
 * checkout via a small set of constant `git` probes. This is the seam the deferred
 * daemon-assembly wiring (codebase CONVENTIONS §11) needed: the worker function
 * (`buildAggregateSnapshot` → `finalizeSnapshot` → `pushSnapshot`) was built + tested,
 * but nothing constructed the identity tuple to feed it. {@link mountGraphApi} now does.
 *
 * ── Fail-soft by design ──────────────────────────────────────────────────────
 * Every git probe runs under an INJECTABLE reader seam (a test drives every branch
 * with no real `git`), uses `execFileSync` with ARRAYED args (no shell, no
 * interpolation — no injection surface), and SWALLOWS a non-zero exit into a typed
 * default. A workspace that is not a git repo still resolves a usable identity (an
 * empty `commit` — which the 014c push then treats as "no-commit" and SKIPS, never a
 * throw), so a build over a non-git tree still produces a local snapshot.
 */

import { execFileSync } from "node:child_process";
import { basename } from "node:path";

import type { QueryScope } from "../../storage/client.js";
import type { SnapshotIdentity } from "./contracts.js";

/**
 * The injectable git-probe seam (D-1). Each method returns the trimmed stdout of a
 * constant `git` command, or `null` when git is unavailable / the command fails. A
 * test injects a fake to drive the git AND non-git branches with no real process.
 */
export interface GitProbe {
	/** `git rev-parse HEAD` — the current commit sha, or `null` (no repo / no commits). */
	headCommit(cwd: string): string | null;
	/** `git config --get remote.origin.url` — the origin URL, or `null` (no remote). */
	originUrl(cwd: string): string | null;
	/** `git rev-parse --show-toplevel` — the worktree root path, or `null` (no repo). */
	worktreeRoot(cwd: string): string | null;
}

/** Run a constant `git` command in `cwd`, returning trimmed stdout or `null` on any failure. */
function runGit(cwd: string, args: readonly string[]): string | null {
	try {
		const out = execFileSync("git", [...args], {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			// Hide the transient console window on Windows (a background probe, not interactive).
			windowsHide: true,
		});
		const trimmed = out.trim();
		return trimmed === "" ? null : trimmed;
	} catch {
		// Not a repo / no git binary / no remote → the caller's documented default.
		return null;
	}
}

/** The production {@link GitProbe}: constant, arrayed `git` commands; failures → `null`. */
export const defaultGitProbe: GitProbe = {
	headCommit: (cwd) => runGit(cwd, ["rev-parse", "HEAD"]),
	originUrl: (cwd) => runGit(cwd, ["config", "--get", "remote.origin.url"]),
	worktreeRoot: (cwd) => runGit(cwd, ["rev-parse", "--show-toplevel"]),
};

/**
 * Derive a stable repo SLUG from an origin URL (`git@host:org/name.git` or
 * `https://host/org/name.git` → `name`). Strips a trailing `.git` and takes the last
 * path/colon segment. Returns `null` when the URL has no usable tail so the caller
 * falls back to the workspace directory name.
 */
export function repoSlugFromOrigin(originUrl: string): string | null {
	const noGit = originUrl.replace(/\.git$/i, "");
	// Split on `/` and `:` (covers both ssh `host:org/name` and https `host/org/name`).
	const segments = noGit.split(/[/:]/).filter((s) => s.length > 0);
	const last = segments[segments.length - 1];
	return last !== undefined && last !== "" ? last : null;
}

/** Options for {@link resolveSnapshotIdentity}. Everything injectable for deterministic tests. */
export interface ResolveIdentityOptions {
	/** The git-probe seam. Defaults to the real {@link defaultGitProbe}. */
	readonly git?: GitProbe;
	/**
	 * The user id stamped into the identity (`user_id` column). Defaults to the OS user
	 * (`$USER`/`$USERNAME`) or `"local"`. A request may carry an explicit actor.
	 */
	readonly user?: string;
}

/** The OS user name, or `"local"` when neither env var is set. */
function osUser(): string {
	const u = process.env.USER ?? process.env.USERNAME;
	return u !== undefined && u.trim() !== "" ? u.trim() : "local";
}

/**
 * A git object name (the output of `git rev-parse HEAD`) is a lowercase hex SHA — 40
 * chars for SHA-1, 64 for SHA-256. `git` itself only ever emits that character class for
 * a resolved commit, but the `commit` field is consumed downstream as BOTH a filesystem
 * path segment (`writeSnapshotAtomic` names the snapshot `<commit>.json`, now reachable
 * from the live `POST /api/graph/build` endpoint) AND a SQL value. Defense-in-depth: pin
 * the value to the git-OID shape at the resolution boundary so a non-conforming probe
 * output (a tampered `git` on PATH, an unexpected porcelain change) can NEVER become a
 * traversal segment (`..`, `/`, `\`) or a path-escaping filename. A value that does not
 * match collapses to `""` — which the 014c push treats as "no commit" and SKIPS, and which
 * the local write falls back to naming by `<snapshot-sha256>.json`. So a rejected commit
 * degrades exactly like a non-git workspace: a usable local snapshot, no cloud push, no
 * throw — never a write outside the snapshots dir.
 */
const GIT_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Return `raw` only when it is a well-formed git object name; otherwise `""` (treated as no-commit). */
function sanitizeCommit(raw: string | null): string {
	if (raw === null) return "";
	const trimmed = raw.trim();
	return GIT_OID.test(trimmed) ? trimmed : "";
}

/**
 * Resolve the full {@link SnapshotIdentity} for a build over `workspaceDir` under
 * `scope` (PRD-014 assembly wiring). The tenant half comes from the scope; the repo
 * half from the git probes (fail-soft):
 *
 *   - `org` / `workspace`  ← the {@link QueryScope} (workspace defaults to `"default"`).
 *   - `repo`               ← the origin-URL slug, else the workspace dir basename.
 *   - `user`               ← the explicit `user` option, else the OS user, else `"local"`.
 *   - `worktree`           ← the worktree root path, else the workspace dir.
 *   - `commit`             ← `git rev-parse HEAD`, else `""` (→ 014c push SKIPS, no throw).
 *
 * Never throws: every git probe is swallowed to a default, so a non-git workspace
 * still yields a usable identity for a LOCAL build (the cloud push self-skips on the
 * empty commit).
 */
export function resolveSnapshotIdentity(
	workspaceDir: string,
	scope: QueryScope,
	options: ResolveIdentityOptions = {},
): SnapshotIdentity {
	const git = options.git ?? defaultGitProbe;

	const originUrl = git.originUrl(workspaceDir);
	const repoFromOrigin = originUrl !== null ? repoSlugFromOrigin(originUrl) : null;
	const repo = repoFromOrigin ?? basename(workspaceDir) ?? "repo";

	const worktree = git.worktreeRoot(workspaceDir) ?? workspaceDir;
	// Pin the commit to the git-OID shape (defense-in-depth): the value names a snapshot
	// FILE (`<commit>.json`) on the HTTP-reachable build path, so a non-hex probe output must
	// never reach the path layer. A reject collapses to `""` → push self-skips, file is named
	// by sha256 — the same fail-soft contract as a non-git workspace.
	const commit = sanitizeCommit(git.headCommit(workspaceDir));

	return {
		org: scope.org,
		workspace: scope.workspace ?? "default",
		repo: repo === "" ? "repo" : repo,
		user: options.user ?? osUser(),
		worktree,
		commit,
	};
}

/**
 * The dashboard ONBOARDING folder-browse + bind surface — PRD-059b / 059c / 059d (backend).
 *
 * ── What this is ─────────────────────────────────────────────────────────────
 * Four loopback, LOCAL-MODE-ONLY routes the dashboard folder-picker + Projects page drive, attached
 * onto the already-mounted, protected `/api/diagnostics` group (NO `server.ts` edit) and SELF-GATED to
 * `local` mode exactly like {@link import("./scope-enumeration-api.js").mountScopeEnumerationApi} (a
 * non-local request 404s):
 *
 *   GET  /api/diagnostics/fs/browse?path=<dir>      → immediate child directories of <dir> (dirs only,
 *                                                     each marked if it is a git repo), refusing to
 *                                                     traverse outside the allowed root (home by default).
 *   POST /api/diagnostics/projects/bind             → bind a local folder to a NEW/named project (059b).
 *   POST /api/diagnostics/projects/bind-existing    → bind a local folder to an EXISTING registry
 *                                                     project_id (059d cross-device import).
 *   POST /api/diagnostics/projects/unbind           → remove the LOCAL folder binding only (059c); the
 *                                                     registry row is never touched.
 *
 * ── Why the daemon enumerates the filesystem (059b hard constraint) ──────────
 * A browser CANNOT hand back an absolute path (the File System Access API returns an opaque handle by
 * design). The daemon already has fs access, so it serves the browse tree and the dashboard posts the
 * chosen ABSOLUTE path back to bind — the only component that can return a real bindable path.
 *
 * ── The store is single-sourced (059b/d impl-note) ──────────────────────────
 * `bind` / `bind-existing` / `unbind` write the SAME thin-client `~/.deeplake/projects.json` cache the
 * CLI `honeycomb project bind` writes, through the SAME {@link bindFolderToProject} writer — the
 * dashboard and the CLI NEVER diverge on the store format. The suggested name is derived the SAME way
 * the CLI suggests ({@link suggestProjectId}). NO DeepLake call on these routes (the registry sync is a
 * separate trigger): they are pure local-store reads/writes plus a fs browse.
 *
 * ── Loopback + local-mode only + no secret (D-4 / security F-1) ──────────────
 * The `/api/diagnostics` group is `protect:true`; these ALSO self-gate to `local` mode. The browse
 * route refuses to escape the allowed root, so the daemon never becomes an arbitrary-filesystem reader.
 * No token / secret crosses any body — bodies are paths + project ids + names only.
 *
 * ── Fail-soft, zod-validated at the boundary ─────────────────────────────────
 * Every external input (the `path` query, the JSON bodies) is zod-validated; a malformed request is a
 * clean 400, never a 500. A browse against an unreadable/absent dir answers an empty child list with a
 * redacted reason. A bind/unbind writes the local cache (fail-soft writer) and returns the resolved
 * absolute path it recorded.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

import { z } from "zod";

import type { DeploymentMode } from "../config.js";
import type { Daemon } from "../server.js";
import {
	bindFolderToProject,
	canonicalizeRemote,
	defaultGitRemoteReader,
	type GitRemoteReader,
	loadProjectsCache,
	saveProjectsCache,
	UNSORTED_PROJECT_ID,
} from "../../../hooks/shared/index.js";

/** The already-mounted, protected route group these attach to (no `server.ts` edit). */
export const ONBOARDING_GROUP = "/api/diagnostics" as const;

/** `GET /api/diagnostics/fs/browse` — the daemon-served directory browser (059b). */
export const FS_BROWSE_PATH = "/fs/browse" as const;
/** `POST /api/diagnostics/projects/bind` — bind a folder to a new/named project (059b). */
export const PROJECTS_BIND_PATH = "/projects/bind" as const;
/** `POST /api/diagnostics/projects/bind-existing` — bind a folder to an existing registry project (059d). */
export const PROJECTS_BIND_EXISTING_PATH = "/projects/bind-existing" as const;
/** `POST /api/diagnostics/projects/unbind` — remove a local folder binding only (059c). */
export const PROJECTS_UNBIND_PATH = "/projects/unbind" as const;

/** One immediate child directory in a browse listing (059b). NO file leaks — directories only. */
export interface BrowseChild {
	/** The child folder's display name (basename). */
	readonly name: string;
	/** The child folder's ABSOLUTE path (the bindable value the dashboard posts back). */
	readonly path: string;
	/** True when the child folder is itself a git repo (carries a `.git`) — a bind hint (059b). */
	readonly isGitRepo: boolean;
}

/** `GET /fs/browse` body: the resolved dir + its immediate child directories (059b). */
export interface BrowseBody {
	/** The ABSOLUTE path that was browsed (the resolved, root-clamped `?path`). */
	readonly path: string;
	/** The allowed-root the browse is confined to (home by default). */
	readonly root: string;
	/** The parent dir's absolute path, or `null` at the allowed root (no traversal above it). */
	readonly parent: string | null;
	/** The immediate child directories (dirs only, sorted by name). */
	readonly children: readonly BrowseChild[];
	/** A redacted reason when the dir could not be read (still a clean 200 with empty children). */
	readonly error?: string;
}

/** The `bind` ack: the recorded absolute path + the project it bound to (059b/d). */
export interface BindAck {
	/** True when the binding was written to the local store. */
	readonly bound: boolean;
	/** The ABSOLUTE path that was recorded (resolved from the request `path`). */
	readonly path: string;
	/** The project id the folder is now bound to. */
	readonly projectId: string;
	/** A redacted reason on a rejected bind (e.g. the reserved inbox id). */
	readonly error?: string;
}

/** The `unbind` ack: whether a local binding was removed (059c). */
export interface UnbindAck {
	/** True when a local folder binding was removed; false when none matched. */
	readonly unbound: boolean;
	/** The ABSOLUTE path whose binding was targeted. */
	readonly path: string;
}

/** Options for {@link mountOnboardingApi}. All seams injectable for deterministic tests. */
export interface MountOnboardingOptions {
	/** The active org id the bindings are written under (the daemon's resolved tenancy). */
	readonly org: string;
	/** The active workspace id the bindings are written under (the daemon's resolved tenancy). */
	readonly workspace: string;
	/** Override the projects-cache directory (tests). Defaults to `~/.deeplake`. */
	readonly projectsDir?: string;
	/** Override the allowed browse root (tests). Defaults to the user's home dir. */
	readonly browseRoot?: string;
	/** The git-remote reader used to suggest a project name on bind (tests inject a fake). */
	readonly readRemote?: GitRemoteReader;
}

/** zod boundary for the `bind` body (059b): an absolute path + an optional explicit name. */
const BindBodySchema = z.object({
	path: z.string().min(1),
	name: z.string().optional(),
});

/** zod boundary for the `bind-existing` body (059d): an absolute path + the existing project id. */
const BindExistingBodySchema = z.object({
	path: z.string().min(1),
	projectId: z.string().min(1),
});

/** zod boundary for the `unbind` body (059c): the absolute path whose local binding to remove. */
const UnbindBodySchema = z.object({
	path: z.string().min(1),
});

/**
 * Mirror the CLI `suggestProjectId` (049d) so the dashboard and CLI suggest IDENTICALLY (059b
 * impl-note): the canonicalized git remote's `repo` segment if a remote exists, else the folder's
 * basename. Pure. Returns `""` for a degenerate path (root), which the caller rejects.
 */
function suggestProjectId(absPath: string, readRemote: GitRemoteReader): string {
	const raw = readRemote(absPath);
	if (raw !== null) {
		const canonical = canonicalizeRemote(raw);
		if (canonical !== "") {
			const segments = canonical.split("/");
			const repo = segments[segments.length - 1];
			if (repo !== undefined && repo.length > 0) return repo;
		}
	}
	const segs = resolve(absPath).split(sep).filter((s) => s.length > 0);
	const base = segs[segs.length - 1];
	return base ?? "";
}

/**
 * Resolve + clamp a requested browse path to the allowed root (059b traversal guard). Returns the
 * absolute path WHEN it is the root itself or a descendant of it; otherwise returns the root (refusing
 * to traverse outside it). A blank/absent `?path` resolves to the root. NEVER returns a path outside
 * the allowed root — the daemon must not become an arbitrary-filesystem reader for any caller.
 */
function clampToRoot(requested: string | undefined, root: string): string {
	const normalizedRoot = stripTrailingSep(resolve(root));
	if (requested === undefined || requested.trim() === "") return normalizedRoot;
	const abs = stripTrailingSep(resolve(requested));
	if (abs === normalizedRoot) return normalizedRoot;
	// A descendant must start with `root + sep`; anything else (a sibling, a parent, an absolute
	// escape, a `..` climb that resolve() already collapsed) clamps back to the root.
	if (abs.startsWith(normalizedRoot + sep)) return abs;
	return normalizedRoot;
}

/** Strip a trailing path separator (keeping a root's own separator), for prefix comparison. */
function stripTrailingSep(p: string): string {
	return p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p;
}

/** The parent of `dir` within the allowed root, or `null` when `dir` IS the root (no climb above). */
function parentWithinRoot(dir: string, root: string): string | null {
	const normalizedRoot = stripTrailingSep(resolve(root));
	if (dir === normalizedRoot) return null;
	const parent = stripTrailingSep(resolve(dir, ".."));
	return parent === normalizedRoot || parent.startsWith(normalizedRoot + sep) ? parent : normalizedRoot;
}

/** List the immediate CHILD DIRECTORIES of `dir` (dirs only), each marked if it is a git repo. Fail-soft. */
function listChildDirs(dir: string): { children: BrowseChild[]; error?: string } {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch (err: unknown) {
		return { children: [], error: redactedReason(err) };
	}
	const children: BrowseChild[] = [];
	for (const name of names) {
		if (name.startsWith(".")) continue; // hide dotfolders (`.git`, `.cache`, …) from the picker.
		const childPath = join(dir, name);
		let isDir = false;
		try {
			isDir = statSync(childPath).isDirectory();
		} catch {
			continue; // an unreadable/again-removed entry is skipped, never a throw.
		}
		if (!isDir) continue;
		children.push({ name, path: childPath, isGitRepo: existsSync(join(childPath, ".git")) });
	}
	children.sort((a, b) => a.name.localeCompare(b.name));
	return { children };
}

/** A redacted reason for a fs/store error — the message only, never a secret. */
function redactedReason(err: unknown): string {
	if (err instanceof Error) return err.message.slice(0, 200);
	return String(err).slice(0, 200);
}

/**
 * Attach the four onboarding routes onto the daemon's already-mounted, protected `/api/diagnostics`
 * group (PRD-059b/c/d). Call ONCE after `createDaemon(...)` under the LOCAL-mode gate (mirroring the
 * scope-enumeration mount). If the group is not mounted the attach is a no-op. Every handler self-gates
 * to local mode (a non-local request 404s), zod-validates its input, and is fail-soft (never a 500).
 */
export function mountOnboardingApi(daemon: Daemon, options: MountOnboardingOptions): void {
	const group = daemon.group(ONBOARDING_GROUP);
	if (group === undefined) return;
	const mode: DeploymentMode = daemon.config.mode;
	const root = stripTrailingSep(resolve(options.browseRoot ?? homedir()));
	const readRemote = options.readRemote ?? defaultGitRemoteReader;
	const notLocal = (): boolean => mode !== "local";

	// ── 059b: GET /fs/browse?path=<dir> → the immediate child directories of <dir>. ──
	group.get(FS_BROWSE_PATH, (c) => {
		if (notLocal()) return c.json({ error: "not_found" }, 404);
		const requested = c.req.query("path");
		const dir = clampToRoot(requested, root);
		const { children, error } = listChildDirs(dir);
		const body: BrowseBody = {
			path: dir,
			root,
			parent: parentWithinRoot(dir, root),
			children,
			...(error !== undefined ? { error } : {}),
		};
		return c.json(body, 200);
	});

	// ── 059b: POST /projects/bind { path, name? } → bind a folder to a new/named project. ──
	group.post(PROJECTS_BIND_PATH, async (c) => {
		if (notLocal()) return c.json({ error: "not_found" }, 404);
		const parsed = await readBody(c, BindBodySchema);
		if (!parsed.ok) return c.json({ error: "bad_request", reason: parsed.reason }, 400);
		const absPath = resolveBindPath(parsed.value.path);
		if (absPath === null) {
			return c.json(rejectBind(parsed.value.path, "path must be an absolute folder path"), 400);
		}
		// The name: explicit if given, else the CLI-identical suggestion (git remote repo, else basename).
		const explicit = parsed.value.name !== undefined && parsed.value.name.trim().length > 0 ? parsed.value.name.trim() : "";
		const projectId = explicit.length > 0 ? explicit : suggestProjectId(absPath, readRemote);
		const ack = writeBind(absPath, projectId, options, readRemote, /* recordRemote */ true);
		return c.json(ack, ack.bound ? 200 : 400);
	});

	// ── 059d: POST /projects/bind-existing { path, projectId } → bind to an EXISTING registry project. ──
	group.post(PROJECTS_BIND_EXISTING_PATH, async (c) => {
		if (notLocal()) return c.json({ error: "not_found" }, 404);
		const parsed = await readBody(c, BindExistingBodySchema);
		if (!parsed.ok) return c.json({ error: "bad_request", reason: parsed.reason }, 400);
		const absPath = resolveBindPath(parsed.value.path);
		if (absPath === null) {
			return c.json(rejectBind(parsed.value.path, "path must be an absolute folder path"), 400);
		}
		// Import = bind-to-existing: the project_id ALREADY exists in the registry (created on another
		// device). Do NOT record a remote here (the existing project keeps its registry remote_signal).
		const ack = writeBind(absPath, parsed.value.projectId.trim(), options, readRemote, /* recordRemote */ false);
		return c.json(ack, ack.bound ? 200 : 400);
	});

	// ── 059c: POST /projects/unbind { path } → remove the LOCAL folder binding only (registry untouched). ──
	group.post(PROJECTS_UNBIND_PATH, async (c) => {
		if (notLocal()) return c.json({ error: "not_found" }, 404);
		const parsed = await readBody(c, UnbindBodySchema);
		if (!parsed.ok) return c.json({ error: "bad_request", reason: parsed.reason }, 400);
		const absPath = resolveBindPath(parsed.value.path);
		if (absPath === null) {
			const body: UnbindAck = { unbound: false, path: parsed.value.path };
			return c.json(body, 400);
		}
		const ack = removeBinding(absPath, options);
		return c.json(ack, 200);
	});
}

/** A parsed body result: the validated value, or a redacted reason. */
type ParsedBody<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Read + zod-validate a JSON body, returning a typed value or a redacted reason (never a throw). */
async function readBody<T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>): Promise<ParsedBody<T>> {
	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		return { ok: false, reason: "request body must be JSON" };
	}
	const result = schema.safeParse(raw);
	if (!result.success) {
		return { ok: false, reason: "invalid request body" };
	}
	return { ok: true, value: result.data };
}

/**
 * Resolve a request `path` to a normalized ABSOLUTE folder path, or `null` when it is not absolute.
 * The dashboard always posts the absolute path the browse tree returned (the daemon's own value), so a
 * non-absolute path is a malformed request (a browser handle / a relative guess) and is rejected — the
 * binding must be absolute to be usable by the cwd resolver (049a / 059b b-AC-4).
 */
function resolveBindPath(path: string): string | null {
	const trimmed = path.trim();
	if (trimmed.length === 0 || !isAbsolute(trimmed)) return null;
	return resolve(trimmed);
}

/** Build a rejected-bind ack (the reserved inbox / a degenerate name / a non-absolute path). */
function rejectBind(path: string, reason: string): BindAck {
	return { bound: false, path, projectId: "", error: reason };
}

/**
 * Write a folder→project binding to the local `~/.deeplake/projects.json` through the SAME
 * {@link bindFolderToProject} writer the CLI uses (single-sourced store). Rejects the reserved
 * `__unsorted__` inbox id and a degenerate (empty) project id. When `recordRemote` is true (059b new
 * bind), the folder's canonical git remote is recorded on an inline-created project so the daemon sync
 * can mirror it; for a 059d import (`recordRemote` false) the existing registry remote is preserved.
 */
function writeBind(
	absPath: string,
	projectId: string,
	options: MountOnboardingOptions,
	readRemote: GitRemoteReader,
	recordRemote: boolean,
): BindAck {
	if (projectId.length === 0) {
		return rejectBind(absPath, "could not derive a project name from the folder");
	}
	if (projectId === UNSORTED_PROJECT_ID) {
		return rejectBind(absPath, `"${UNSORTED_PROJECT_ID}" is the reserved inbox and cannot be bound`);
	}
	const remoteSignal = recordRemote ? remoteFor(absPath, readRemote) : "";
	bindFolderToProject({
		cwd: absPath,
		projectId,
		org: options.org,
		workspace: options.workspace,
		name: projectId,
		...(remoteSignal !== "" ? { remoteSignal } : {}),
		...(options.projectsDir !== undefined ? { dir: options.projectsDir } : {}),
	});
	return { bound: true, path: absPath, projectId };
}

/** The canonicalized git remote for a folder, or `""` when none (fail-soft via the reader). */
function remoteFor(absPath: string, readRemote: GitRemoteReader): string {
	const raw = readRemote(absPath);
	return raw !== null ? canonicalizeRemote(raw) : "";
}

/**
 * Remove the LOCAL folder→project binding for `absPath` from the cache (PRD-059c), leaving the
 * registry `projects[]` copy UNTOUCHED — unbind removes only the local mapping, never the durable
 * registry row. Fail-soft: a missing/malformed cache (nothing to remove) returns `unbound: false`.
 * Keyed by the normalized absolute path so `~/work/api/` and `~/work/api` are one binding.
 */
function removeBinding(absPath: string, options: MountOnboardingOptions): UnbindAck {
	const normalized = stripTrailingSep(resolve(absPath));
	const loaded = loadProjectsCache(options.projectsDir);
	const kept = loaded.bindings.filter((b) => stripTrailingSep(resolve(b.path)) !== normalized);
	if (kept.length === loaded.bindings.length) {
		return { unbound: false, path: normalized }; // no binding matched this folder.
	}
	saveProjectsCache({ ...loaded, bindings: kept }, options.projectsDir);
	return { unbound: true, path: normalized };
}

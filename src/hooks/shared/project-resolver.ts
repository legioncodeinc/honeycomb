/**
 * Per-session project identity & resolution — PRD-049a (the RESOLUTION half).
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * A PURE, deterministic `resolveScope({ cwd })` that answers "what project is
 * THIS session in?" FROM the working directory — replacing the single machine-
 * global `credentials.json.workspaceId` read every concurrent session shared. A
 * **Project** is a registry-backed identity that FOLDERS are bound to (operator
 * decision D4); git is one optional *signal*, never the identity. The resolver
 * yields a usable scope ALWAYS, falling to the workspace `__unsorted__` inbox
 * rather than failing (capture is never dropped, a-AC-3).
 *
 * ── WHY IT LIVES IN `src/hooks/shared/` (thin-client discipline, D-2) ───────
 * `resolveScope` is on the capture/recall HOT PATH. `src/hooks` is a
 * NON_DAEMON_ROOT (`tests/daemon/storage/invariant.test.ts`): it may import
 * NOTHING from `daemon/storage`. So this module reads the local
 * `~/.deeplake/projects.json` cache DIRECTLY with `node:fs` — no DeepLake, no
 * daemon import, no network round-trip — exactly as `credential-reader.ts` reads
 * the shared credentials file. The server `projects` registry table is the
 * durable cross-device source of truth; the local cache is the FAST, FAIL-SOFT,
 * thin-client resolution surface. The daemon-side registry→cache sync is a
 * SEPARATE concern (049d / a daemon job WRITES this file); resolution only READS.
 *
 * ── FAIL-SOFT, NEVER A THROW (mirrors onboarding-store / credential-reader) ──
 * The on-disk `projects.json` is untrusted external input, zod-validated at the
 * boundary ({@link ProjectsCacheSchema}). A missing OR malformed file (or any
 * field that fails validation) falls soft to an EMPTY cache → the inbox fallback,
 * never a throw. The file carries NO secret (no token, no key) — it is folder→
 * project bindings + a cached copy of the workspace's registry projects.
 *
 * ── CONCURRENCY (a-AC-2) ────────────────────────────────────────────────────
 * Resolution is a PURE function of `(cwd, cache snapshot, fallback workspace)`.
 * There is NO module-level `currentProject`/`currentWorkspace` singleton. Two
 * sessions in two folders resolving simultaneously each get their own correct
 * `project_id`; a third session switching scope perturbs neither. The failure
 * mode this kills is shared mutable global state — asserted against in the suite.
 *
 * ── PRECEDENCE (implemented EXACTLY, a-AC-1/3/4) ────────────────────────────
 *   1. explicit folder→project binding — local `projects.json`, LONGEST-PREFIX
 *      path match on the cwd (a child binding wins over a parent);
 *   2. canonical git-remote signal — {@link canonicalizeRemote} folds
 *      `git@`/`https`/`.git`/case to ONE form, matched against the cached
 *      registry projects' `remote_signal` (a-AC-4);
 *   3. path fallback — the cwd path is itself a stable candidate key (offered as
 *      a new project to bind by 049d); it does NOT invent a project here, it just
 *      records that a path identity exists;
 *   4. workspace `__unsorted__` inbox — capture never dropped (a-AC-3).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";

import { CREDENTIALS_DIR_NAME } from "./credential-reader.js";

/**
 * The reserved per-workspace inbox project id. MIRRORED here as a thin-client
 * literal WITHOUT importing `src/daemon/storage/catalog/projects.ts`
 * ({@link UNSORTED_PROJECT_ID} there) — the storage import is BANNED on this hot
 * path (invariant.test.ts). The two literals are kept identical by a structural
 * test that reads both files, so a drift fails CI rather than silently splitting
 * the inbox. A session that resolves no binding, no git signal, and no path
 * candidate falls to THIS project so capture is never dropped (a-AC-3).
 */
export const UNSORTED_PROJECT_ID = "__unsorted__" as const;

/** The local cache file name within the shared `~/.deeplake` dir. */
export const PROJECTS_CACHE_FILE_NAME = "projects.json" as const;

/**
 * The env var overriding the cwd-resolved project for scripted/CI use (PRD-049d
 * 49d-AC-6). MIRRORS the PRD-011 `HONEYCOMB_ORG_ID` / `HONEYCOMB_WORKSPACE_ID`
 * precedence: when set, the override WINS over a folder binding / git signal / path,
 * exactly as the org/workspace env overrides win over the file (a-AC-4 parity). It
 * scopes the PROJECT only — the org/workspace partition still comes from the
 * credential + its own env overrides (the project is a soft inner-ring segment WITHIN
 * the trusted workspace partition, never a tenancy escape). An empty/whitespace value
 * is treated as ABSENT (no override), matching the credentials-store's env rules.
 */
export const ENV_PROJECT_ID = "HONEYCOMB_PROJECT_ID" as const;

/**
 * The on-disk cache schema version. A bump is the migration seam: a file with a
 * different (or missing) `schemaVersion` fails zod validation and falls soft to
 * an empty cache → the inbox fallback, so an old/foreign file is never half-read.
 */
export const PROJECTS_CACHE_SCHEMA_VERSION = 1 as const;

// ─────────────────────────────────────────────────────────────────────────────
// canonicalizeRemote — the a-AC-1 equivalence engine (PURE)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fold a RAW git remote URL into the canonical `host/owner/repo` identity the
 * registry stores in `remote_signal`. This is the heart of a-AC-1: the SAME repo
 * reached three different ways must produce ONE string, so a clone keyed any way
 * resolves to the same project.
 *
 * The rules, applied in order (all PURE — no IO):
 *   1. **scheme** — strip a leading `scheme://` (`https://`, `http://`,
 *      `ssh://`, `git://`) AND the SCP-like `git@host:owner/repo` form (the `@`
 *      userinfo and the `:` path separator both fold to a `/`).
 *   2. **userinfo** — drop a `user@` / `user:pass@` prefix on the authority.
 *   3. **host** — lowercase the host (DNS is case-insensitive) and strip a
 *      `:port` suffix.
 *   4. **owner/repo** — keep the path segments; lowercase them (GitHub/GitLab
 *      owners + repos are case-insensitive for identity) and strip a trailing
 *      `.git` and any trailing slash.
 *   5. **result** — re-join as `host/owner/repo…` (a deep path like a GitLab
 *      subgroup keeps its extra segments). An input that yields no host+path
 *      (empty, whitespace, a bare word) returns `""` — "no usable signal", which
 *      the resolver treats as "no git branch".
 *
 * Examples that MUST collapse to `github.com/org/x` (a-AC-1):
 *   - `git@github.com:org/x.git`
 *   - `https://github.com/org/x`
 *   - `https://github.com/org/x.git`
 *   - `ssh://git@github.com/org/x.git`
 *   - `https://user@GitHub.com:443/Org/X/`  (case + userinfo + port + slash)
 */
export function canonicalizeRemote(rawRemote: string): string {
	const raw = rawRemote.trim();
	if (raw === "") return "";

	// 1+2. Strip the scheme and the SCP-like `git@host:owner/repo` shorthand,
	// reducing every form to `authority/path…`.
	let rest = raw;
	const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(rest);
	if (schemeMatch) {
		// `scheme://[user@]host[:port]/owner/repo`
		rest = rest.slice(schemeMatch[0].length);
	} else {
		// SCP-like `[user@]host:owner/repo` — the FIRST `:` separates host from
		// path (only when there's no `://` scheme). Fold it to a `/`.
		const scpMatch = /^([^/:]+):(.+)$/.exec(rest);
		if (scpMatch) {
			rest = `${scpMatch[1]}/${scpMatch[2]}`;
		}
	}

	// Split authority from path on the FIRST slash.
	const firstSlash = rest.indexOf("/");
	if (firstSlash === -1) return "";
	let authority = rest.slice(0, firstSlash);
	const pathPart = rest.slice(firstSlash + 1);

	// 2. Drop `user[:pass]@` userinfo on the authority.
	const at = authority.lastIndexOf("@");
	if (at !== -1) authority = authority.slice(at + 1);
	// 3. Strip a `:port` suffix and lowercase the host.
	const colon = authority.indexOf(":");
	if (colon !== -1) authority = authority.slice(0, colon);
	const host = authority.toLowerCase();
	if (host === "") return "";

	// 4. Normalize the path: drop a trailing `.git`, trailing slashes, lowercase
	// each segment, and discard empty segments (a `//` or a leading/trailing `/`).
	let path = pathPart.replace(/\/+$/, "");
	path = path.replace(/\.git$/i, "");
	const segments = path
		.split("/")
		.map((s) => s.trim().toLowerCase())
		.filter((s) => s.length > 0);
	if (segments.length === 0) return "";

	// 5. Re-join as the canonical `host/owner/repo…`.
	return `${host}/${segments.join("/")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The local projects.json cache — shape + zod boundary (fail-soft)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One folder→project binding in the local cache: an absolute path PREFIX mapped
 * to a `project_id`. The resolver does a LONGEST-PREFIX match across these, so a
 * child binding (`~/work/api/sub`) wins over a parent (`~/work/api`). 049d's CLI
 * `bind`/`use` verbs and the daemon registry sync WRITE these.
 */
export interface FolderBinding {
	/** Normalized absolute path prefix (the bound folder). */
	readonly path: string;
	/** The `project_id` this folder is bound to. */
	readonly projectId: string;
}

/**
 * A cached copy of ONE registry project, the subset the resolver needs for
 * offline git-signal + display resolution. Mirrors `ProjectRow`
 * (`src/daemon/storage/catalog/projects.ts`) but is a THIN-CLIENT copy — this
 * module never imports the storage type (D-2). The daemon registry sync writes
 * these from the server `projects` table.
 */
export interface CachedProject {
	/** The stable registry key. */
	readonly projectId: string;
	/** Human display label. */
	readonly name: string;
	/** The CANONICALIZED git remote (`host/owner/repo`), or '' when none. */
	readonly remoteSignal: string;
	/** Normalized absolute path prefixes bound to this project (registry copy). */
	readonly boundPaths: readonly string[];
}

/**
 * The local `~/.deeplake/projects.json` cache. Carries NO secret. Two halves:
 *   - `bindings` — the FAST folder→project overrides (longest-prefix match);
 *   - `projects` — a cached copy of the workspace's registry projects for the
 *     OFFLINE git-signal branch (so resolution needs no network round-trip).
 * `org`/`workspace` scope the cache to the tenancy it was synced for; a cache
 * synced for a different workspace than the active credential is ignored by the
 * resolver (it would carry the wrong projects), falling to the inbox.
 */
export interface ProjectsCache {
	/** On-disk schema version (always {@link PROJECTS_CACHE_SCHEMA_VERSION}). */
	readonly schemaVersion: 1;
	/** The org id this cache was synced for (tenancy guard). */
	readonly org: string;
	/** The workspace id this cache was synced for (tenancy guard). */
	readonly workspace: string;
	/** Folder→project bindings (longest-prefix match). */
	readonly bindings: readonly FolderBinding[];
	/** Cached registry projects for offline git-signal/path resolution. */
	readonly projects: readonly CachedProject[];
}

/** The zod boundary validator for the untrusted on-disk `projects.json`. */
export const ProjectsCacheSchema = z.object({
	schemaVersion: z.literal(PROJECTS_CACHE_SCHEMA_VERSION),
	org: z.string(),
	workspace: z.string(),
	bindings: z.array(
		z.object({
			path: z.string(),
			projectId: z.string(),
		}),
	),
	projects: z.array(
		z.object({
			projectId: z.string(),
			name: z.string(),
			remoteSignal: z.string(),
			boundPaths: z.array(z.string()),
		}),
	),
});

/** An EMPTY cache — what a missing/malformed file falls soft to (→ inbox). */
export function emptyProjectsCache(org = "", workspace = ""): ProjectsCache {
	return { schemaVersion: PROJECTS_CACHE_SCHEMA_VERSION, org, workspace, bindings: [], projects: [] };
}

/**
 * Resolve the local cache directory (`~/.deeplake`), honoring an explicit
 * override for tests — mirrors `credentialsDir`/`onboardingDir`. Reuses
 * {@link CREDENTIALS_DIR_NAME} so the cache lives beside the credentials file.
 */
export function projectsCacheDir(dir?: string): string {
	return dir ?? join(homedir(), CREDENTIALS_DIR_NAME);
}

/** Resolve the full `projects.json` path within the (possibly overridden) dir. */
export function projectsCachePath(dir?: string): string {
	return join(projectsCacheDir(dir), PROJECTS_CACHE_FILE_NAME);
}

/**
 * Load + zod-validate the local `projects.json`, FAILING SOFT to an EMPTY cache
 * on a missing OR malformed file — it NEVER throws (mirrors `loadOnboarding`).
 * "Malformed" covers an unreadable file, invalid JSON, and a parsed object that
 * fails {@link ProjectsCacheSchema}. A partially-valid file is never honored.
 *
 * `dir` overrides the directory (tests pass a temp dir); defaults to `~/.deeplake`.
 */
export function loadProjectsCache(dir?: string): ProjectsCache {
	const path = projectsCachePath(dir);
	if (!existsSync(path)) return emptyProjectsCache();
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		// An unreadable file is treated as an empty cache, never a hard error.
		return emptyProjectsCache();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Malformed JSON → empty cache (fail soft, no throw).
		return emptyProjectsCache();
	}
	const result = ProjectsCacheSchema.safeParse(parsed);
	if (!result.success) {
		// The boundary rejected the shape → empty cache rather than a partial file.
		return emptyProjectsCache();
	}
	return result.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache WRITERS — the 049d bind/use surface + the daemon registry sync (fail-soft)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist a {@link ProjectsCache} to the local `~/.deeplake/projects.json` (PRD-049d).
 * The cache carries NO secret (folder→project bindings + a cached copy of the
 * workspace's registry projects), so it is written as plain JSON beside the
 * credentials file — the parent dir is created if absent (mirrors
 * {@link saveDiskCredentials}'s dir-create, WITHOUT the 0600 file mode, which is for
 * the token-bearing credential only).
 *
 * It is the single WRITER the 049d `bind`/`use` verbs and the daemon registry→cache
 * sync both route through, so the on-disk shape stays consistent with the
 * {@link ProjectsCacheSchema} the resolver validates on READ. `dir` overrides the
 * directory (tests). Returns the persisted cache so a caller need not re-read.
 */
export function saveProjectsCache(cache: ProjectsCache, dir?: string): ProjectsCache {
	const path = projectsCachePath(dir);
	const targetDir = dirname(path);
	if (!existsSync(targetDir)) {
		mkdirSync(targetDir, { recursive: true });
	}
	writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`);
	return cache;
}

/**
 * Re-scope a cache to a fresh `(org, workspace)` when the loaded cache belongs to a
 * DIFFERENT tenancy (PRD-049d). A write that targets the active workspace must never
 * append a binding onto a cache synced for another workspace (its `projects[]` belong
 * to the other tenancy) — that would let a stale cross-workspace cache resolve the
 * wrong project. So when the on-disk cache's `(org, workspace)` disagree with the
 * write's tenancy we START FROM AN EMPTY cache for the new tenancy, dropping the
 * foreign bindings/projects (the same tenancy guard {@link resolveScopeFromDisk}
 * applies on read). A first-ever write (empty loaded cache) simply adopts the tenancy.
 */
function cacheForTenancy(loaded: ProjectsCache, org: string, workspace: string): ProjectsCache {
	const tenancyMatches =
		(loaded.org === "" || loaded.org === org) && (loaded.workspace === "" || loaded.workspace === workspace);
	if (tenancyMatches) {
		return { ...loaded, org, workspace };
	}
	return emptyProjectsCache(org, workspace);
}

/** Inputs to {@link bindFolderToProject}: the folder, the project, and its tenancy. */
export interface BindFolderInput {
	/** The folder being bound (normalized to an absolute prefix before storage). */
	readonly cwd: string;
	/** The `project_id` the folder binds to. */
	readonly projectId: string;
	/** The active org id (tenancy guard — a foreign-tenancy cache is reset). */
	readonly org: string;
	/** The active workspace id (tenancy guard). */
	readonly workspace: string;
	/**
	 * The display name for the INLINE-CREATED project (049d operator decision: `bind`
	 * creates the project if absent). When the project id is not already a cached
	 * project, a {@link CachedProject} entry is appended so the registry copy carries
	 * the new project offline. Defaults to the project id.
	 */
	readonly name?: string;
	/** The canonicalized git remote to record on an inline-created project (optional). */
	readonly remoteSignal?: string;
	/** Override the cache directory (tests). */
	readonly dir?: string;
}

/**
 * Bind the current folder to a project in the local cache (PRD-049d 49d-AC-2). This is
 * the WRITE half of the `honeycomb project bind` round-trip: it appends/updates a
 * longest-prefix {@link FolderBinding} for `cwd`, and — per the operator decision that
 * `bind` CREATES the project inline if absent — appends a {@link CachedProject} for the
 * project when the id is not already present (so the registry copy carries it offline).
 *
 * It is FAIL-SOFT in the same spirit as the reader: it re-scopes a foreign-tenancy
 * cache to the active `(org, workspace)` ({@link cacheForTenancy}) so a bind never
 * appends onto another workspace's projects. The binding for `cwd` is upserted (a
 * re-bind of the same folder REPLACES the prior project, never duplicates the path),
 * keyed by the NORMALIZED path so `~/work/api/` and `~/work/api` are one binding.
 *
 * Returns the persisted cache. After this, {@link resolveScope}/{@link resolveScopeFromDisk}
 * for `cwd` resolves `projectId` via the binding branch (49d-AC-2 round-trip).
 */
export function bindFolderToProject(input: BindFolderInput): ProjectsCache {
	const normalized = normalizePath(input.cwd);
	const loaded = loadProjectsCache(input.dir);
	const base = cacheForTenancy(loaded, input.org, input.workspace);

	// Upsert the folder→project binding (replace any existing binding for this path).
	const bindings: FolderBinding[] = base.bindings
		.filter((b) => normalizePath(b.path) !== normalized)
		.map((b) => ({ ...b }));
	bindings.push({ path: normalized, projectId: input.projectId });

	// Create the project inline if absent (operator decision D / open-question lean).
	let projects: CachedProject[] = base.projects.map((p) => ({ ...p }));
	const exists = projects.some((p) => p.projectId === input.projectId);
	if (!exists) {
		projects.push({
			projectId: input.projectId,
			name: input.name !== undefined && input.name.length > 0 ? input.name : input.projectId,
			remoteSignal: input.remoteSignal ?? "",
			boundPaths: [normalized],
		});
	} else {
		// Record the path on the existing project's boundPaths too (kept in sync with
		// the binding, deduped) so a daemon round-trip can mirror it to the registry.
		projects = projects.map((p) =>
			p.projectId === input.projectId && !p.boundPaths.includes(normalized)
				? { ...p, boundPaths: [...p.boundPaths, normalized] }
				: p,
		);
	}

	const next: ProjectsCache = { ...base, bindings, projects };
	return saveProjectsCache(next, input.dir);
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveScope — the PURE resolver (a-AC-1 … a-AC-4)
// ─────────────────────────────────────────────────────────────────────────────

/** How a scope was resolved (provenance for the caller + a-AC-4 assertions). */
export type ScopeSource = "binding" | "git" | "path" | "inbox";

/**
 * The typed result of {@link resolveScope}: the resolved Org→Workspace→Project
 * triple, whether the folder is BOUND to a real project, and HOW it resolved.
 * `bound` is `false` only for the inbox fallback (a-AC-3).
 */
export interface ResolvedScope {
	/** The resolved project id; {@link UNSORTED_PROJECT_ID} for the inbox. */
	readonly projectId: string;
	/** True when a real project resolved (binding/git/path), false for the inbox. */
	readonly bound: boolean;
	/** Which precedence branch resolved the project. */
	readonly source: ScopeSource;
	/** The active org id (threaded from the credential — never invented here). */
	readonly org: string;
	/** The active workspace id (threaded from the credential — the fallback default). */
	readonly workspace: string;
}

/**
 * The git-remote reader seam — the SAME injectable shape as
 * `assets/project-key.ts`'s `GitRemoteReader`, redeclared here (thin-client: this
 * module imports nothing from the daemon runtime). Returns the RAW remote URL or
 * `null`. NOTE: `project-key.ts`'s `projectKey()` SHA-1s the RAW url and does NOT
 * canonicalize `git@`≡`https` — it is the WRONG primitive for identity, so it is
 * deliberately NOT reused; {@link canonicalizeRemote} is the identity fold.
 */
export type GitRemoteReader = (cwd: string) => string | null;

/** A reader that never finds a remote — the default identity-less path. */
export const noGitRemoteReader: GitRemoteReader = () => null;

/**
 * The production {@link GitRemoteReader}: `git config --get remote.origin.url` in
 * `cwd`. Uses `execFileSync` with ARRAYED args (never a shell string), so the cwd
 * is a process option and nothing is interpolated into a command line — no
 * injection surface (mirrors `assets/project-key.ts`'s safe reader, WITHOUT
 * importing it — thin-client). A non-zero exit (not a repo, no origin) is
 * swallowed → `null`, so an identity-less folder reads as "no git signal" and the
 * resolver falls to the inbox (a-AC-3). Thin-client safe: only `node:child_process`.
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
		// Not a git repo / no origin remote / git absent — identity-less, never throw.
		return null;
	}
};

/** Inputs to {@link resolveScope}. `cwd` is the only required field. */
export interface ResolveScopeInput {
	/** The session working directory to resolve a project for. */
	readonly cwd: string;
	/**
	 * The active org id (from the resolved credential). Threaded onto the result;
	 * the resolver NEVER reads `credentials.json` itself (thin-client + purity).
	 */
	readonly org?: string;
	/**
	 * The active workspace id (the credential's `workspaceId`) — the FALLBACK
	 * DEFAULT (a-AC-5). The resolver carries it onto the result but NEVER treats it
	 * as the project authority: a binding/git/path always wins for the project.
	 */
	readonly workspace?: string;
	/**
	 * The pre-loaded cache snapshot. Injecting it keeps {@link resolveScope} a PURE
	 * function (a-AC-2, no hidden IO). {@link resolveScopeFromDisk} loads it via
	 * {@link loadProjectsCache} and delegates here.
	 */
	readonly cache: ProjectsCache;
	/**
	 * The git-remote reader for the git-signal branch (a-AC-4). Defaults to
	 * {@link noGitRemoteReader} so a caller that injects no git stays identity-less
	 * (and PURE). Production passes a reader backed by `git config`.
	 */
	readonly readRemote?: GitRemoteReader;
}

/** Normalize a path for prefix comparison: absolute + trailing-sep stripped. */
function normalizePath(p: string): string {
	const abs = resolve(p);
	// Strip a trailing separator so `~/work/api/` and `~/work/api` compare equal,
	// but keep a root path's separator (e.g. `C:\` / `/`).
	if (abs.length > 1 && abs.endsWith(sep)) return abs.slice(0, -1);
	return abs;
}

/**
 * Is `prefix` a PATH-prefix of `target` (segment-aware)? `~/work/api` is a prefix
 * of `~/work/api/sub` but NOT of `~/work/api-v2` — the next char after the prefix
 * must be a separator (or the strings are equal). Both inputs are pre-normalized.
 */
function isPathPrefix(prefix: string, target: string): boolean {
	if (prefix === target) return true;
	if (!target.startsWith(prefix)) return false;
	return target.charAt(prefix.length) === sep;
}

/**
 * Resolve the per-session scope PURELY from `(cwd, cache, fallback workspace)`
 * with the EXACT precedence (a-AC-1/3/4):
 *
 *   1. **binding** — longest-prefix folder→project match in the cache. A child
 *      binding wins (longest prefix). The cwd's canonical git remote does NOT
 *      override an explicit binding (a binding is the operator's deliberate
 *      assignment). Also matches a registry project's `boundPaths` (the daemon-
 *      synced binding copy), so a binding written server-side resolves offline.
 *   2. **git** — canonicalize the cwd's remote ({@link canonicalizeRemote}) and
 *      match it by EQUALITY against the cached projects' `remoteSignal` (a-AC-4).
 *      Because the registry stores the canonical form and we canonicalize the
 *      live remote the SAME way, `git@…` ≡ `https://…` ≡ `….git` all match the
 *      one project (a-AC-1).
 *   3. **path** — the cwd resolves to no project; report `source: "path"` only
 *      when a stable path identity EXISTS (always, since the cwd is a path) so
 *      049d can offer it as a new project to bind. We do NOT mint a project id
 *      here — an unbound path is still `bound: false` and lands in the inbox.
 *   4. **inbox** — fall to {@link UNSORTED_PROJECT_ID}, `bound: false` (a-AC-3).
 *
 * PURE + concurrency-safe (a-AC-2): no module-level state is read or written, so
 * two cwds resolve independently and simultaneously. NEVER throws (a-AC-3).
 */
export function resolveScope(input: ResolveScopeInput): ResolvedScope {
	const { cwd, cache } = input;
	const org = input.org ?? "";
	const workspace = input.workspace ?? "";
	const readRemote = input.readRemote ?? noGitRemoteReader;
	const target = normalizePath(cwd);

	// ── 1. Binding — longest-prefix match (explicit bindings + synced boundPaths) ──
	let bestPrefixLen = -1;
	let boundProjectId: string | undefined;
	const considerBinding = (rawPath: string, projectId: string): void => {
		if (projectId.length === 0) return;
		const prefix = normalizePath(rawPath);
		if (!isPathPrefix(prefix, target)) return;
		// Longest prefix wins (a child binding beats a parent). On a tie, the first
		// considered wins — deterministic given a stable cache order.
		if (prefix.length > bestPrefixLen) {
			bestPrefixLen = prefix.length;
			boundProjectId = projectId;
		}
	};
	for (const b of cache.bindings) considerBinding(b.path, b.projectId);
	for (const p of cache.projects) {
		for (const bp of p.boundPaths) considerBinding(bp, p.projectId);
	}
	if (boundProjectId !== undefined) {
		return { projectId: boundProjectId, bound: true, source: "binding", org, workspace };
	}

	// ── 2. Git signal — canonical remote matched against the cached registry ──
	const rawRemote = readRemote(cwd);
	if (rawRemote !== null) {
		const canonical = canonicalizeRemote(rawRemote);
		if (canonical !== "") {
			const match = cache.projects.find((p) => p.remoteSignal === canonical);
			if (match !== undefined) {
				return { projectId: match.projectId, bound: true, source: "git", org, workspace };
			}
		}
	}

	// ── 3/4. No binding, no matching git signal → the workspace inbox (a-AC-3) ──
	// The path IS a stable identity 049d can offer to bind, but an UNBOUND path is
	// not a project: it lands in the inbox, bound:false, never another project's id.
	return { projectId: UNSORTED_PROJECT_ID, bound: false, source: "inbox", org, workspace };
}

// ─────────────────────────────────────────────────────────────────────────────
// First-run capture gate predicate — PRD-059a / IRD-123 (PURE, no IO)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Does this workspace have AT LEAST ONE real, locally-bound project? (PRD-059a / IRD-123.)
 *
 * The first-run capture gate (059a) reverses 049a's "never drop → inbox" policy for the
 * ZERO-projects pre-onboarding state ONLY: while a brand-new user has bound no project on
 * THIS device, capture no-ops rather than hoarding unscoped sessions in `__unsorted__`. The
 * predicate that decides "is the gate open?" is this PURE count over the LOCAL cache — no
 * DeepLake call (a-AC-3): the gate must resolve from the thin-client store on the capture
 * hot path with no network round-trip.
 *
 * "Bound enough to start" (the parent open-question lean) is an EXPLICIT local binding: a
 * folder→project `binding` whose `projectId` is not the reserved {@link UNSORTED_PROJECT_ID}
 * inbox. A registry `projects[]` copy synced from another device (059d) does NOT by itself
 * open the gate — that copy can be present on a fresh device that has imported nothing yet,
 * and the lean (059a OQ-2) is to gate on the LOCAL binding so device B onboards via import.
 * So the count is over `bindings[]`, not the synced `projects[]`.
 *
 * Returns `true` the moment one such binding exists (the gate opens and, per 049a, stays
 * open — the `__unsorted__` inbox fallback for unbound folders resumes as normal, a-AC-5).
 * An empty/absent cache (the genuine zero-state) returns `false` → the gate is CLOSED.
 */
export function hasBoundProject(cache: ProjectsCache): boolean {
	return cache.bindings.some((b) => b.projectId.length > 0 && b.projectId !== UNSORTED_PROJECT_ID);
}

/**
 * The disk-backed first-run gate check (PRD-059a a-AC-3 / IRD-123): load the local cache
 * (fail-soft) and answer "has this workspace bound a project yet?" with NO DeepLake call.
 *
 * Applies the SAME tenancy guard {@link resolveScopeFromDisk} does on read: a cache synced
 * for a DIFFERENT workspace than the active one is treated as empty (its bindings belong to
 * another tenancy), so a stale cross-workspace cache can never spuriously OPEN the gate for
 * the wrong workspace. The capture handler calls this; when it returns `false` the workspace
 * is in the zero-projects first-run state and capture suppresses (writes nothing).
 *
 * FAIL-SOFT asymmetry (059a impl-note): the loader already collapses a missing/malformed file
 * to an EMPTY cache, so a genuinely-absent store reads as "not onboarded" (gate CLOSED). A
 * transient read hiccup is indistinguishable from absence at this layer, which is acceptable:
 * the loader does not throw, and a brand-new user IS the empty-store case. The caller may
 * additionally fail-open on an unexpected throw so a set-up user is never hard-blocked.
 */
export function hasBoundProjectOnDisk(input: {
	/** Override the cache directory (tests). Defaults to `~/.deeplake`. */
	readonly dir?: string;
	/** The active workspace id — the tenancy guard (a foreign-workspace cache reads as empty). */
	readonly workspace?: string;
}): boolean {
	const loaded = loadProjectsCache(input.dir);
	// Tenancy guard: only trust a cache synced for the active workspace (mirrors resolveScopeFromDisk).
	const cache =
		input.workspace !== undefined && loaded.workspace.length > 0 && loaded.workspace !== input.workspace
			? emptyProjectsCache(loaded.org, loaded.workspace)
			: loaded;
	return hasBoundProject(cache);
}

/**
 * The disk-backed convenience wrapper: load the cache via {@link loadProjectsCache}
 * (fail-soft) and delegate to the PURE {@link resolveScope}. The capture/recall
 * hot path calls THIS with the session cwd + the resolved credential's
 * org/workspace; tests drive the pure core directly with an injected cache.
 *
 * `dir` overrides the cache directory (tests). A cache synced for a DIFFERENT
 * workspace than the active `workspace` is treated as empty (its projects belong
 * to another tenancy), so a stale cross-workspace cache can never bind the wrong
 * project — it falls to the inbox.
 */
export function resolveScopeFromDisk(
	input: Omit<ResolveScopeInput, "cache"> & {
		readonly dir?: string;
		/**
		 * The `HONEYCOMB_PROJECT_ID` env-override value (PRD-049d 49d-AC-6). When a
		 * NON-EMPTY string, it WINS over the cwd binding/git/path — the PRD-011 env-
		 * override parity for the project segment. A scripted/CI run pins the project
		 * without writing a binding. Empty/whitespace/undefined → no override (the
		 * normal cwd resolution runs). The caller reads it from the env (the resolver
		 * stays pure given its inputs); see {@link resolveRequestScope}.
		 */
		readonly projectIdOverride?: string;
	},
): ResolvedScope {
	const org = input.org ?? "";
	const workspace = input.workspace ?? "";

	// 49d-AC-6: the env override wins over a binding/git/path (PRD-011 parity). It is a
	// PROJECT-only override — org/workspace are still the trusted partition — so it
	// resolves a `bound: true` project WITHOUT consulting the cache at all.
	const override = (input.projectIdOverride ?? "").trim();
	if (override.length > 0) {
		return { projectId: override, bound: true, source: "binding", org, workspace };
	}

	const loaded = loadProjectsCache(input.dir);
	// Tenancy guard: only trust a cache synced for the active workspace.
	const cache =
		input.workspace !== undefined && loaded.workspace.length > 0 && loaded.workspace !== input.workspace
			? emptyProjectsCache(loaded.org, loaded.workspace)
			: loaded;
	return resolveScope({
		cwd: input.cwd,
		cache,
		...(input.org !== undefined ? { org: input.org } : {}),
		...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
		...(input.readRemote !== undefined ? { readRemote: input.readRemote } : {}),
	});
}

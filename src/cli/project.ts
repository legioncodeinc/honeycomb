/**
 * `honeycomb project` CLI — PRD-049d (49d-AC-2 / 49d-AC-4 / 49d-AC-5 / 49d-AC-6).
 *
 * The PROJECT level of the Org → Workspace → Project scope surface. PRD-011a/PRD-023 ship
 * `honeycomb org list|switch` + `workspace list|use` (see `src/cli/org.ts`); THIS module adds the
 * project verbs that bind a FOLDER to a registry project and report the per-cwd resolved scope:
 *
 *   - `honeycomb project list`        — print the active workspace's registry projects, marking the
 *     one the CURRENT folder resolves to. Read-only. The list is the LOCAL `~/.deeplake/projects.json`
 *     cache the daemon registry→cache sync (049d) maintains — the thin-client offline copy of the
 *     server registry (the CLI imports NO DeepLake path; it cannot query storage directly).
 *   - `honeycomb project bind [<p>]`  — bind the CURRENT folder → project `<p>` in the 049a store,
 *     CREATING the project inline if absent (operator decision: "that is the point"). A subsequent
 *     capture in that folder resolves to `<p>` (049a/049b round-trip, 49d-AC-2). With no `<p>`, the
 *     suggestion is derived from the folder's git remote (canonicalized) or the folder's basename.
 *     NO token re-mint (a project is a soft inner-ring segment, never a token claim — 49d-AC-3).
 *   - `honeycomb project use <p>`     — set THIS folder's binding to `<p>` (a per-folder default),
 *     NOT a machine-global active-project field. It is the project analogue of `workspace use`'s
 *     fallback-default semantics but kept SESSION-SAFE: the binding is keyed by the cwd path, so a
 *     `use` in one folder never re-scopes another concurrent session's folder (49d-AC-4). NO re-mint.
 *   - `honeycomb project status`      — print the resolved Org → Workspace → Project (or
 *     `__unsorted__`) + agent for the CURRENT cwd via 049a `resolveRequestScope`, marking an UNBOUND
 *     folder EXPLICITLY (49d-AC-5). Honors the `HONEYCOMB_PROJECT_ID` override (49d-AC-6). NEVER the
 *     bearer token.
 *
 * ── Boundary: the CLI imports NO DeepLake path (invariant.test.ts) ──────────
 * Thin client (mirrors `src/cli/org.ts`). It imports neither `src/daemon/storage` nor the daemon
 * core. The org/workspace tenancy comes from the credentials FILE through the credentials-store
 * helpers (`loadCredentials`/`loadDiskCredentials`); the per-cwd PROJECT comes from the local
 * `~/.deeplake/projects.json` cache through the thin-client `project-resolver` writers/readers
 * (`bindFolderToProject` / `loadProjectsCache` / `resolveRequestScope`). The DURABLE server registry
 * is reconciled separately by the daemon registry→cache sync (049d) — the CLI never opens a DeepLake
 * connection, so the storage-import invariant holds.
 *
 * ── Session-safety (49d-AC-4) — NO machine-global active-project field ──────
 * `bind`/`use` write a folder→project binding KEYED BY THE cwd PATH into `projects.json`; they NEVER
 * mutate a single machine-global "active project". Resolution is per-cwd (longest-prefix path match),
 * so two terminals in two folders each resolve THEIR OWN folder's project, and a bind/use in one
 * cannot perturb the other's `project status` (asserted in the suite). The credentials.json
 * `workspaceId` stays the FALLBACK DEFAULT only (049a-AC-5), never re-scoped by these verbs.
 *
 * ── The token is a SECRET (D-4) ─────────────────────────────────────────────
 * No verb here logs, prints, echoes, or URL-embeds the bearer token. `status` prints the identity
 * fields (org/workspace/project/agent) EXCEPT the token; `list`/`bind`/`use` never touch it.
 */

import { basename } from "node:path";

import {
	type Clock,
	type DiskCredentials,
	loadCredentials,
	loadDiskCredentials,
	systemClock,
} from "../daemon/runtime/auth/index.js";
import { resolveRequestScope } from "../daemon/runtime/auth/index.js";
import {
	type GitRemoteReader,
	type ProjectsCache,
	UNSORTED_PROJECT_ID,
	bindFolderToProject,
	canonicalizeRemote,
	defaultGitRemoteReader,
	loadProjectsCache,
	resolveScope,
} from "../hooks/shared/index.js";

/** A line-sink so command output is capturable in tests (no direct stdout). */
export interface OutputSink {
	(line: string): void;
}

/**
 * The injectable seams the project CLI runs against (49d-AC-2/4/5/6). The AC-named test injects
 * fakes (a temp `dir` for the credentials + projects cache, a fixed `cwd`, a fixed git reader, a
 * fake clock) so no real `~/.deeplake`, no real git, and no network are touched.
 */
export interface ProjectCommandDeps {
	/** Override the credentials + projects-cache directory (tests). Both live under `~/.deeplake`. */
	readonly dir?: string;
	/** Override the legacy `~/.honeycomb` dir for the credentials read-fallback (tests). */
	readonly legacyDir?: string;
	/** The session working directory the per-cwd resolution turns on (defaults to `process.cwd()`). */
	readonly cwd?: string;
	/** The git-remote reader for the `bind` suggestion (defaults to the `git config` reader). */
	readonly readRemote?: GitRemoteReader;
	/** The clock (reserved for parity with org.ts; the cache carries no server-stamped time). */
	readonly clock?: Clock;
	/** The env (defaults to `process.env`) — the `HONEYCOMB_PROJECT_ID` override is read here. */
	readonly env?: NodeJS.ProcessEnv;
	/** The output sink (defaults to `console.log`). NEVER receives the bearer token. */
	readonly out?: OutputSink;
}

/** Outcome of a `project` command: exit code + whether the local cache was written. */
export interface ProjectResult {
	readonly exitCode: number;
	/** True iff the projects cache was written (`bind` / `use`). */
	readonly wrote: boolean;
}

/** The parsed `project` invocation: the sub-command + its positional arg. */
export interface ProjectInvocation {
	/** The sub-command word (`list` | `bind` | `use` | `status`). */
	readonly command: string;
	/** The positional argument (the project id/name for `bind`/`use`), if any. */
	readonly arg?: string;
}

/**
 * Parse a raw `project` argv tail (everything AFTER the `project` word) into a typed
 * {@link ProjectInvocation}. The first non-flag word is the sub-command; the next non-flag word is
 * the project id/name (for `bind`/`use`). Flags are ignored (none are recognized today); a future
 * `--name` would parse here, mirroring `src/cli/keys.ts`.
 */
export function parseProjectArgs(argv: readonly string[]): ProjectInvocation {
	const words = argv.filter((a) => !a.startsWith("--"));
	const command = words[0] ?? "";
	const arg = words[1];
	return arg === undefined ? { command } : { command, arg };
}

/** The resolved deps with their real defaults. */
interface ResolvedProjectDeps {
	readonly dir?: string;
	readonly legacyDir?: string;
	readonly cwd: string;
	readonly readRemote: GitRemoteReader;
	readonly clock: Clock;
	readonly env: NodeJS.ProcessEnv;
	readonly out: OutputSink;
}

/** Resolve the deps with their real defaults. */
function withDefaults(deps: ProjectCommandDeps): ResolvedProjectDeps {
	return {
		...(deps.dir !== undefined ? { dir: deps.dir } : {}),
		...(deps.legacyDir !== undefined ? { legacyDir: deps.legacyDir } : {}),
		cwd: deps.cwd ?? process.cwd(),
		readRemote: deps.readRemote ?? defaultGitRemoteReader,
		clock: deps.clock ?? systemClock,
		env: deps.env ?? process.env,
		out: deps.out ?? ((line: string): void => console.log(line)),
	};
}

/** The resolved active tenancy a project verb needs: org + workspace (from the credential file). */
interface ActiveTenancy {
	readonly orgId: string;
	readonly orgName: string;
	readonly workspaceId: string;
}

/**
 * Load the active org + workspace from the shared credential (or print the not-logged-in message;
 * returns null when absent). `workspaceId` defaults to the `default` sentinel — the project verbs
 * scope a binding WITHIN this workspace partition; they never change it (49d-AC-3/AC-4).
 */
function requireTenancy(deps: ResolvedProjectDeps): ActiveTenancy | null {
	const disk: DiskCredentials | null = loadDiskCredentials(deps.dir, deps.env, deps.legacyDir);
	if (disk === null) {
		deps.out("Not logged in. Run `honeycomb login` first.");
		return null;
	}
	const workspaceId = disk.workspaceId !== undefined && disk.workspaceId.length > 0 ? disk.workspaceId : "default";
	return { orgId: disk.orgId, orgName: disk.orgName ?? disk.orgId, workspaceId };
}

/**
 * Resolve the cwd's current project from the local cache PURELY (no env override) — used to MARK the
 * active project in `project list`. Delegates to the thin-client {@link resolveScope} over the loaded
 * cache + the git reader, exactly as the capture/recall hot path does.
 */
function resolveActiveProject(cache: ProjectsCache, deps: ResolvedProjectDeps, tenancy: ActiveTenancy): string {
	const resolved = resolveScope({
		cwd: deps.cwd,
		cache,
		org: tenancy.orgId,
		workspace: tenancy.workspaceId,
		readRemote: deps.readRemote,
	});
	return resolved.projectId;
}

/**
 * `honeycomb project list` (49d-AC-1 sibling) — print the active workspace's registry projects from
 * the local cache (the daemon-synced offline copy), marking the one the CURRENT folder resolves to.
 * Read-only: no cache write, no re-mint. An empty cache prints a hint to `bind` (the cache is seeded
 * by the daemon sync; before the first sync it is empty).
 */
function projectList(deps: ResolvedProjectDeps): ProjectResult {
	const tenancy = requireTenancy(deps);
	if (tenancy === null) return { exitCode: 1, wrote: false };
	const cache = loadProjectsCache(deps.dir);
	// Tenancy guard: a cache synced for a DIFFERENT workspace lists projects from the wrong tenancy —
	// treat it as empty (mirrors the resolver's read guard) so `list` never shows foreign projects.
	const sameTenancy =
		(cache.workspace === "" || cache.workspace === tenancy.workspaceId) &&
		(cache.org === "" || cache.org === tenancy.orgId);
	const projects = sameTenancy ? cache.projects : [];
	if (projects.length === 0) {
		deps.out(`No projects in workspace ${tenancy.workspaceId}. Run \`honeycomb project bind <name>\` to create one.`);
		return { exitCode: 0, wrote: false };
	}
	const active = resolveActiveProject(cache, deps, tenancy);
	deps.out(`Projects in workspace ${tenancy.workspaceId}:`);
	for (const p of projects) {
		const marker = p.projectId === active ? " (this folder)" : "";
		const remote = p.remoteSignal !== "" ? `  remote=${p.remoteSignal}` : "";
		deps.out(`  ${p.name} (${p.projectId})${marker}${remote}`);
	}
	return { exitCode: 0, wrote: false };
}

/**
 * Derive the project id/name to bind when the user passed none: the canonicalized git remote's
 * `repo` segment if a remote exists, else the cwd's basename. Pure — the suggestion is the operator's
 * to accept (we bind it directly here, matching the open-question lean "create inline, that is the
 * point"). Returns "" only for a degenerate cwd (root), which the caller rejects.
 */
function suggestProjectId(deps: ResolvedProjectDeps): string {
	const raw = deps.readRemote(deps.cwd);
	if (raw !== null) {
		const canonical = canonicalizeRemote(raw);
		if (canonical !== "") {
			const segments = canonical.split("/");
			const repo = segments[segments.length - 1];
			if (repo !== undefined && repo.length > 0) return repo;
		}
	}
	const base = basename(deps.cwd);
	return base === "" || base === "." ? "" : base;
}

/**
 * Shared bind/use writer (49d-AC-2 / 49d-AC-4). Binds the CURRENT folder → `projectId` in the local
 * `projects.json`, creating the project inline when absent. `verb` only flavors the success copy
 * (`bind` vs `use`); the WRITE is identical and session-safe (keyed by the cwd path). The git remote
 * is recorded on an inline-created project so the daemon sync can mirror it to the registry's
 * `remote_signal`. NO token re-mint (49d-AC-3).
 */
function writeBinding(projectId: string, verb: "bind" | "use", deps: ResolvedProjectDeps): ProjectResult {
	if (projectId === "") {
		deps.out(`usage: honeycomb project ${verb} <project>`);
		return { exitCode: 1, wrote: false };
	}
	const tenancy = requireTenancy(deps);
	if (tenancy === null) return { exitCode: 1, wrote: false };
	if (projectId === UNSORTED_PROJECT_ID) {
		deps.out(`error: "${UNSORTED_PROJECT_ID}" is the reserved inbox and cannot be bound explicitly.`);
		return { exitCode: 1, wrote: false };
	}

	// The git remote (canonicalized) recorded on an inline-created project, '' when none.
	const raw = deps.readRemote(deps.cwd);
	const remoteSignal = raw !== null ? canonicalizeRemote(raw) : "";

	bindFolderToProject({
		cwd: deps.cwd,
		projectId,
		org: tenancy.orgId,
		workspace: tenancy.workspaceId,
		name: projectId,
		...(remoteSignal !== "" ? { remoteSignal } : {}),
		...(deps.dir !== undefined ? { dir: deps.dir } : {}),
	});

	if (verb === "bind") {
		deps.out(`Bound this folder to project ${projectId} (workspace ${tenancy.workspaceId}). Captures here now resolve to it.`);
	} else {
		deps.out(`This folder now defaults to project ${projectId} (workspace ${tenancy.workspaceId}). Other folders are unaffected.`);
	}
	return { exitCode: 0, wrote: true };
}

/**
 * `honeycomb project bind [<p>]` (49d-AC-2) — bind the current folder → project `<p>`, creating it
 * inline if absent. With no `<p>` the suggestion is derived from the git remote (canonicalized) or
 * the folder basename. A subsequent capture resolves to `<p>` (the 049a/049b round-trip).
 */
function projectBind(arg: string | undefined, deps: ResolvedProjectDeps): ProjectResult {
	const projectId = arg !== undefined && arg.length > 0 ? arg : suggestProjectId(deps);
	if (projectId === "") {
		deps.out("usage: honeycomb project bind <project>  (could not derive a name from the folder)");
		return { exitCode: 1, wrote: false };
	}
	return writeBinding(projectId, "bind", deps);
}

/**
 * `honeycomb project use <p>` (49d-AC-4) — set THIS folder's binding to `<p>` (a per-folder default,
 * NOT a machine-global active-project field). Session-safe: keyed by the cwd path, so another
 * folder's resolution is unaffected. NO token re-mint.
 */
function projectUse(arg: string | undefined, deps: ResolvedProjectDeps): ProjectResult {
	return writeBinding(arg ?? "", "use", deps);
}

/**
 * `honeycomb project status` (49d-AC-5) — print the resolved Org → Workspace → Project (or
 * `__unsorted__`) + agent for the CURRENT cwd via 049a {@link resolveRequestScope}, marking an
 * UNBOUND folder EXPLICITLY. Honors the `HONEYCOMB_PROJECT_ID` override (49d-AC-6, threaded through
 * `resolveRequestScope`). NEVER prints the bearer token.
 */
function projectStatus(deps: ResolvedProjectDeps): ProjectResult {
	const creds = loadCredentials(deps.dir, deps.env, deps.legacyDir);
	if (creds === null) {
		deps.out("Not logged in. Run `honeycomb login`.");
		return { exitCode: 0, wrote: false };
	}
	const resolution = resolveRequestScope({
		cwd: deps.cwd,
		credentials: creds,
		env: deps.env,
		...(deps.dir !== undefined ? { dir: deps.dir, projectsDir: deps.dir } : {}),
		readRemote: deps.readRemote,
	});
	if (resolution.kind === "denied") {
		// Fail-closed at the tenancy layer (a drifted/unverifiable token). Surface the reason WITHOUT
		// the token (D-4); a non-zero exit so a script can branch on it.
		deps.out(`error: scope could not be resolved: ${resolution.reason}`);
		return { exitCode: 1, wrote: false };
	}
	const { tenancy, project } = resolution.scope;
	deps.out(`org:        ${tenancy.orgName} (${tenancy.scope.org})`);
	deps.out(`workspace:  ${tenancy.scope.workspace}`);
	if (project.bound) {
		deps.out(`project:    ${project.projectId} (resolved via ${project.source})`);
	} else {
		deps.out(`project:    ${UNSORTED_PROJECT_ID} (this folder is UNBOUND — captures land in the inbox)`);
		deps.out(`            run \`honeycomb project bind <name>\` to give this folder a project.`);
	}
	deps.out(`agent:      ${tenancy.agentId}`);
	return { exitCode: 0, wrote: false };
}

/**
 * Run a parsed `project` command (49d-AC-2/4/5/6). The seams are injected so the AC-named test drives
 * the whole surface against a temp dir + a fixed cwd + a fixed git reader — no real `~/.deeplake`, no
 * real git, no network, and crucially no machine-global mutation (every write is keyed by the cwd).
 */
export function runProjectCommand(inv: ProjectInvocation, deps: ProjectCommandDeps = {}): ProjectResult {
	const resolved = withDefaults(deps);
	switch (inv.command) {
		case "list":
			return projectList(resolved);
		case "bind":
			return projectBind(inv.arg, resolved);
		case "use":
			return projectUse(inv.arg, resolved);
		case "status":
			return projectStatus(resolved);
		default:
			resolved.out("usage: honeycomb project <list | bind [<project>] | use <project> | status>");
			return { exitCode: inv.command === "" ? 0 : 1, wrote: false };
	}
}

/** Convenience entry: parse + run a `project` argv tail in one call (matches `orgMain`/`keysMain`). */
export function projectMain(argv: readonly string[], deps: ProjectCommandDeps = {}): ProjectResult {
	return runProjectCommand(parseProjectArgs(argv), deps);
}

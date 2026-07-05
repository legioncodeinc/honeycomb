/**
 * Daemon registry → local-cache sync — PRD-049d.
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * The DAEMON-SIDE bridge that pulls a workspace's `projects` registry rows (the
 * cross-device source of truth, 049a `src/daemon/storage/catalog/projects.ts`) into
 * the LOCAL `~/.deeplake/projects.json` cache the thin-client resolver reads on the
 * capture/recall hot path. 049a built the registry table + the read-shape builders and
 * the thin-client resolver/cache; THIS is where the two are wired so the resolver's
 * git-signal + path branches match the workspace's real projects OFFLINE — no DeepLake
 * round-trip on the hot path (D-2).
 *
 * ── Why it lives daemon-side (the thin-client boundary, D-2) ─────────────────
 * Reading the registry is a DeepLake query, which only the daemon may do — the CLI and
 * the hooks are NON_DAEMON_ROOTs that import nothing from `daemon/storage`. So the
 * daemon runs this sync (it holds the `StorageQuery` seam + the workspace scope) and
 * WRITES the cache through the SAME thin-client {@link saveProjectsCache} the CLI
 * `bind`/`use` verbs use, keeping the on-disk shape consistent with the
 * `ProjectsCacheSchema` the resolver validates on read.
 *
 * ── FAIL-SOFT, NEVER A THROW (mirrors the resolver's read posture) ──────────
 * A sync is a best-effort refresh of a cache that is ALREADY fail-soft on read: a
 * missing/stale cache resolves to the workspace inbox, never an error. So a sync that
 * cannot read the registry (a `query_error` / `connection_error` / timeout from the
 * closed {@link QueryResult} union) returns a typed `{ ok: false }` outcome and writes
 * NOTHING — the prior cache is left intact, capture is never dropped. It never throws.
 *
 * ── The bindings half is preserved (49d-AC-2 round-trip safety) ─────────────
 * The sync refreshes the registry-`projects` half of the cache (the offline copy of the
 * server projects for the git-signal branch). It MERGES rather than clobbers: the
 * LOCAL folder→project `bindings[]` a `honeycomb project bind` wrote are PRESERVED, so a
 * registry refresh never un-binds a folder a developer just bound (the bind round-trip
 * survives a concurrent sync).
 *
 * ── Local-only projects are MERGED, not clobbered (PRD-062 FIX 1) ────────────
 * Historically the sync replaced `projects[]` WHOLESALE with the registry rows. Combined
 * with the (previously) missing registry write path, that erased a project that lived
 * ONLY in the local cache (a bind whose registry upsert had not yet landed): the next
 * sync overwrote it out of existence. The sync now MERGES local-only projects (present in
 * the prior cache, absent from the registry read) INTO the refreshed `projects[]` instead
 * of dropping them, and attempts to HEAL each into the registry via {@link upsertProjectRow}
 * (best-effort — a flapped upsert leaves the project local-only and the next sync retries).
 * So a bind is durable: even if its upsert-on-bind flapped, the project stays visible and
 * reconciles on the next sync. The tenancy guard still applies — a foreign-tenancy prior
 * cache contributes no local-only projects (they belong to another workspace).
 */

import {
	type CachedProject,
	type FolderBinding,
	type ProjectsCache,
	loadProjectsCache,
	saveProjectsCache,
} from "../../../hooks/shared/index.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { PROJECTS_CACHE_SCHEMA_VERSION } from "../../../hooks/shared/index.js";
import { buildListProjectsSql, UNSORTED_PROJECT_ID } from "../../storage/catalog/index.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { upsertProjectRow } from "./registry-write.js";

/** The typed outcome of a sync (never a throw — fail-soft, mirrors the resolver). */
export type RegistrySyncResult =
	| {
			/** The sync read the registry and wrote a refreshed cache. */
			readonly ok: true;
			/** The number of registry projects mirrored into the cache. */
			readonly projectCount: number;
	  }
	| {
			/** The sync could not read the registry; the prior cache is left intact. */
			readonly ok: false;
			/** A redacted reason (the storage result's `kind` + message — never a secret). */
			readonly reason: string;
	  };

/** Inputs to {@link syncRegistryToCache}: the storage seam, the workspace scope, the cache dir. */
export interface RegistrySyncInput {
	/** The DeepLake query seam (the daemon holds it; a test injects a fake). */
	readonly storage: StorageQuery;
	/** The org + workspace the cache is synced FOR (the tenancy guard + the registry filter). */
	readonly scope: QueryScope;
	/** Override the cache directory (tests). Defaults to `~/.deeplake`. */
	readonly dir?: string;
}

/**
 * Parse a registry `bound_paths` JSON-array string into a string[] FAIL-SOFT. The column is
 * `TEXT NOT NULL DEFAULT '[]'` (049a), so the value is normally a JSON array string; a malformed
 * value yields `[]` rather than a throw (the cache write must never fail on one bad row).
 */
function parseBoundPaths(raw: unknown): string[] {
	if (typeof raw !== "string" || raw.length === 0) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((p): p is string => typeof p === "string");
	} catch {
		return [];
	}
}

/** Map one registry {@link StorageRow} to a thin-client {@link CachedProject} (fail-soft per field). */
function rowToCachedProject(row: StorageRow): CachedProject | null {
	const projectId = typeof row.project_id === "string" ? row.project_id : "";
	if (projectId.length === 0) return null;
	const name = typeof row.name === "string" && row.name.length > 0 ? row.name : projectId;
	const remoteSignal = typeof row.remote_signal === "string" ? row.remote_signal : "";
	return { projectId, name, remoteSignal, boundPaths: parseBoundPaths(row.bound_paths) };
}

/**
 * Refresh the local `~/.deeplake/projects.json` cache's registry-`projects` half from the workspace's
 * `projects` registry (PRD-049d). Reads via {@link buildListProjectsSql} under the workspace scope,
 * maps the rows to {@link CachedProject}s, and writes a cache that MERGES the fresh registry projects
 * with the PRESERVED local folder→project `bindings[]`.
 *
 * Fail-soft: a non-`ok` storage result writes nothing and returns `{ ok: false, reason }`; the prior
 * cache stays valid. A tenancy CHANGE (the prior cache was synced for a different workspace) drops the
 * foreign bindings — they belong to another tenancy and must not survive into the new workspace's
 * cache (the same guard the resolver applies on read).
 */
export async function syncRegistryToCache(input: RegistrySyncInput): Promise<RegistrySyncResult> {
	const org = input.scope.org;
	const workspace = input.scope.workspace ?? "";

	const sql = buildListProjectsSql(org, workspace);
	const result = await input.storage.query(sql, input.scope);
	if (!isOk(result)) {
		// Fail-soft: leave the prior cache intact, surface a redacted reason (never a secret).
		const reason = result.kind === "query_error" ? `query_error: ${result.message}` : result.kind;
		return { ok: false, reason };
	}

	const registryProjects: CachedProject[] = [];
	for (const row of result.rows) {
		const mapped = rowToCachedProject(row);
		if (mapped !== null) registryProjects.push(mapped);
	}
	const registryIds = new Set(registryProjects.map((p) => p.projectId));

	// Preserve the local bindings only when the prior cache belongs to THIS tenancy; a foreign-tenancy
	// cache's bindings must not leak into the new workspace (mirrors the resolver's read guard).
	const prior = loadProjectsCache(input.dir);
	const sameTenancy =
		(prior.org === "" || prior.org === org) && (prior.workspace === "" || prior.workspace === workspace);
	const bindings: readonly FolderBinding[] = sameTenancy ? prior.bindings : [];

	// FIX 1 merge: keep local-only projects (in the same-tenancy prior cache, absent from the registry
	// read) instead of clobbering them, and best-effort HEAL each into the registry so it becomes durable.
	const localOnly: CachedProject[] = sameTenancy
		? prior.projects.filter(
				(p) => p.projectId.length > 0 && p.projectId !== UNSORTED_PROJECT_ID && !registryIds.has(p.projectId),
			)
		: [];
	for (const p of localOnly) {
		// Fail-soft: a flapped upsert leaves the project local-only; the NEXT sync retries the heal.
		await upsertProjectRow(input.storage, input.scope, {
			projectId: p.projectId,
			name: p.name,
			remoteSignal: p.remoteSignal,
			boundPaths: p.boundPaths,
		});
	}

	const projects: CachedProject[] = [...registryProjects, ...localOnly];
	const next: ProjectsCache = {
		schemaVersion: PROJECTS_CACHE_SCHEMA_VERSION,
		org,
		workspace,
		bindings: bindings.map((b) => ({ ...b })),
		projects,
	};
	saveProjectsCache(next, input.dir);
	return { ok: true, projectCount: projects.length };
}

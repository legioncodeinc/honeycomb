/**
 * PRD-049d — the daemon-side project registry → local-cache sync barrel.
 *
 * The single import surface for the registry→cache sync (the mechanism + its HTTP trigger). The
 * thin-client resolver/cache and the CLI `project` verbs live elsewhere (`src/hooks/shared`,
 * `src/cli/project.ts`); THIS barrel exposes only the DAEMON half — reading the `projects` registry
 * (a DeepLake query, daemon-only) and refreshing the local cache the resolver reads.
 */

export {
	type RegistrySyncInput,
	type RegistrySyncResult,
	syncRegistryToCache,
} from "./registry-sync.js";
export {
	type MountProjectsSyncOptions,
	type ProjectsSyncAck,
	PROJECTS_SYNC_GROUP,
	PROJECTS_SYNC_PATH,
	mountProjectsSyncApi,
} from "./sync-api.js";
export {
	type MountScopeEnumerationOptions,
	type ScopeOrg,
	type ScopeOrgsBody,
	type ScopeProject,
	type ScopeProjectsBody,
	type ScopeWorkspace,
	type ScopeWorkspacesBody,
	SCOPE_ENUM_GROUP,
	SCOPE_ORGS_PATH,
	SCOPE_PROJECTS_PATH,
	SCOPE_WORKSPACES_PATH,
	mountScopeEnumerationApi,
} from "./scope-enumeration-api.js";

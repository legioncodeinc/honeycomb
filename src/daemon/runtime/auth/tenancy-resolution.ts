/**
 * Request-scope tenancy resolution — PRD-011a (the outer ring).
 *
 * Turns the persisted {@link Credentials} + the env overrides into the
 * {@link QueryScope} every `storage.query(sql, scope)` carries — the org/workspace
 * PARTITION that isolates one workspace from another (a-AC-1 / a-AC-2 / FR-1/FR-2).
 *
 * ── Why the partition is the isolation, not the WHERE clause (a-AC-1/a-AC-2) ─
 * Cross-workspace isolation is a PROPERTY OF THE STORAGE PATH, not an API filter.
 * The resolved `{ org, workspace }` is threaded into the storage layer BENEATH the
 * SQL: a query issued under workspace A's scope addresses A's partition, so it
 * cannot name a row/partition/index in workspace B even when an API-level filter is
 * omitted on a new code path. This module's job is to resolve that scope
 * unforgeably — from the token claim (org) and the credentials/env (workspace),
 * NEVER from a client-supplied header (FR-1).
 *
 * ── Fail closed (FR-8/FR-9 / a-AC-5 / D-4) ──────────────────────────────────
 * Resolution runs {@link resolveTenancy}, which verifies the token and rejects a
 * credentials file whose `orgId` disagrees with the token's verified org claim
 * ({@link TenancyIntegrityError}). On ANY resolution failure — no credentials, an
 * unverifiable token, or an org-claim conflict — this returns a structured failure
 * carrying org/workspace/path context (never the token), and the caller denies the
 * request rather than falling back to a broader scope.
 *
 * The CredentialsStore IO (`loadCredentials`) is the ONLY path to the file (this
 * module never touches `credentials.json` directly — 011a implementation note).
 */

import type { QueryScope } from "../../storage/client.js";
import {
	ENV_PROJECT_ID,
	type GitRemoteReader,
	type ResolvedScope,
	resolveScopeFromDisk,
} from "../../../hooks/shared/project-resolver.js";
import type { Credentials } from "./contracts.js";
import {
	type ResolvedTenancy,
	TenancyIntegrityError,
	loadCredentials,
	resolveTenancy,
} from "./credentials-store.js";

/** The tenancy a resolved request runs under — the resolved scope + display identity. */
export interface RequestTenancy {
	/** The storage partition the request addresses (the outer-ring isolation). */
	readonly scope: QueryScope;
	/** The display org name (never used for isolation; for diagnostics/status). */
	readonly orgName: string;
	/** The resolved agent id (inner-ring scope key, threaded to 011e). */
	readonly agentId: string;
}

/**
 * The result of resolving request tenancy: either a resolved {@link RequestTenancy}
 * or a fail-closed error carrying the structured context (never the token). A
 * `kind: "denied"` outcome means the caller MUST deny the request (FR-9) — there is
 * no broader-scope fallback.
 */
export type TenancyResolution =
	| { readonly kind: "ok"; readonly tenancy: RequestTenancy }
	| {
			readonly kind: "denied";
			readonly reason: string;
			/** The org id the file/override claimed (for the structured log). */
			readonly fileOrg: string;
			/** The org id the token's verified claim carried, or null if unverifiable. */
			readonly tokenOrg: string | null;
	  };

/** Inputs to {@link resolveRequestTenancy}: the loaded credentials + the env. */
export interface ResolveRequestTenancyInput {
	/**
	 * The credentials to resolve. When absent the resolver loads them via
	 * {@link loadCredentials} (the CredentialsStore IO) using `dir`/`env`. Injecting
	 * them directly is the test path.
	 */
	readonly credentials?: Credentials | null;
	/** Override the credentials directory (tests). */
	readonly dir?: string;
	/** The env to read overrides + the token from (defaults to `process.env`). */
	readonly env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the request's tenancy {@link QueryScope} from credentials + env, failing
 * closed (a-AC-1/a-AC-2/a-AC-5 / FR-1/FR-2/FR-8/FR-9).
 *
 * Steps:
 *   1. Obtain the credentials (injected, else loaded via the CredentialsStore). No
 *      credentials → `denied` (the request is unauthenticated at the tenancy layer).
 *   2. Run {@link resolveTenancy}: verify the token, apply the env overrides, and
 *      enforce the org-claim-vs-file integrity gate. A conflict / unverifiable token
 *      → `denied` with the structured context (D-4).
 *   3. Build the {@link QueryScope} from the RESOLVED org/workspace — the partition
 *      that isolates the workspace at the storage path (a-AC-1/a-AC-2).
 *
 * Never throws for a tenancy outcome: an integrity failure becomes a `denied`
 * result the caller maps to a structured request denial, so the boundary fails
 * closed without a swallowed catch.
 */
export function resolveRequestTenancy(input: ResolveRequestTenancyInput = {}): TenancyResolution {
	const creds =
		input.credentials !== undefined ? input.credentials : loadCredentials(input.dir, input.env);
	if (creds === null) {
		return {
			kind: "denied",
			reason: "no credentials resolved (not logged in)",
			fileOrg: "",
			tokenOrg: null,
		};
	}

	let resolved: ResolvedTenancy;
	try {
		resolved = resolveTenancy(creds, input.env);
	} catch (err) {
		if (err instanceof TenancyIntegrityError) {
			// Fail closed: surface the structured conflict, never honor the file (a-AC-5).
			return { kind: "denied", reason: err.message, fileOrg: err.fileOrg, tokenOrg: err.tokenOrg };
		}
		// Any other failure is also closed — never widen on an unexpected error.
		const reason = err instanceof Error ? err.message : "tenancy resolution failed";
		return { kind: "denied", reason, fileOrg: creds.orgId, tokenOrg: null };
	}

	// The QueryScope is the isolation: org + workspace name the storage partition.
	const scope: QueryScope = { org: resolved.org, workspace: resolved.workspace };
	return {
		kind: "ok",
		tenancy: { scope, orgName: resolved.orgName, agentId: resolved.agentId },
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// PRD-049a — per-REQUEST, cwd-aware scope (a-AC-5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The full per-request scope: the {@link RequestTenancy} (org/workspace partition
 * + display identity) PLUS the {@link ResolvedScope} project the session's `cwd`
 * resolved to. This is the shape capture/recall thread per request — replacing the
 * single machine-global `credentials.json.workspaceId` read every concurrent
 * session shared (PRD-049a Overview).
 *
 * The `tenancy.scope` carries the workspace partition (the org/workspace isolation
 * boundary — UNCHANGED, PRD-011); `project.projectId` is the cwd-resolved project
 * WITHIN that workspace. `workspaceId` (in `tenancy.scope.workspace`) is the
 * FALLBACK DEFAULT only: the project authority is the cwd binding/git/path
 * resolution, NEVER the workspace id (a-AC-5).
 */
export interface RequestScope {
	/** The resolved tenancy partition + display identity (PRD-011, unchanged). */
	readonly tenancy: RequestTenancy;
	/** The cwd-resolved project WITHIN the workspace (PRD-049a). */
	readonly project: ResolvedScope;
}

/** The fail-closed/ok result of {@link resolveRequestScope}. */
export type RequestScopeResolution =
	| { readonly kind: "ok"; readonly scope: RequestScope }
	| {
			readonly kind: "denied";
			readonly reason: string;
			readonly fileOrg: string;
			readonly tokenOrg: string | null;
	  };

/** Inputs to {@link resolveRequestScope}: the tenancy inputs + the session cwd. */
export interface ResolveRequestScopeInput extends ResolveRequestTenancyInput {
	/**
	 * The session working directory to resolve the project from — the per-request
	 * identity the resolution turns on. This is what makes scope per-session rather
	 * than a machine-global snapshot (a-AC-5 / the deferred 050 item).
	 */
	readonly cwd: string;
	/**
	 * Override the local `~/.deeplake/projects.json` cache dir (tests). Defaults to
	 * `~/.deeplake`. The cache is read FAIL-SOFT — a missing/malformed file resolves
	 * to the workspace inbox, never a throw (a-AC-3).
	 */
	readonly projectsDir?: string;
	/**
	 * The git-remote reader seam for the git-signal branch (a-AC-4). Defaults to the
	 * production `git config` reader inside {@link resolveScopeFromDisk}; tests inject
	 * a fixed reader to drive the git branch deterministically.
	 */
	readonly readRemote?: GitRemoteReader;
}

/**
 * Resolve the FULL per-request scope (a-AC-5): first the org/workspace tenancy
 * (fail-closed, via {@link resolveRequestTenancy} — the integrity gate is
 * UNCHANGED), THEN the cwd-resolved project within that workspace (fail-soft, via
 * the thin-client {@link resolveScopeFromDisk}).
 *
 * The ordering is deliberate: a request that fails the tenancy integrity gate is
 * `denied` BEFORE any project resolution — there is no project without a verified
 * workspace. Once tenancy resolves, the project NEVER throws: a no-binding /
 * no-git folder falls to the `__unsorted__` inbox (`bound: false`), so capture is
 * never dropped (a-AC-3).
 *
 * **`workspaceId` is a fallback default only (a-AC-5).** The resolved workspace
 * (`tenancy.scope.workspace`) is passed to {@link resolveScopeFromDisk} as the
 * fallback workspace the project is scoped to — but the PROJECT authority is the
 * cwd binding/git/path resolution. When a binding resolves a project, that project
 * wins; the workspace id is only the partition the project lives in, never the
 * "active project". The structural test in the suite asserts this seam never reads
 * `workspaceId` as the project authority.
 *
 * PURE per call given its inputs — no module-level `currentProject`/`currentWorkspace`
 * singleton — so two concurrent requests in two cwds resolve independently (a-AC-2).
 */
export function resolveRequestScope(input: ResolveRequestScopeInput): RequestScopeResolution {
	const tenancyResult = resolveRequestTenancy(input);
	if (tenancyResult.kind === "denied") return tenancyResult;

	const { tenancy } = tenancyResult;
	// 49d-AC-6: the `HONEYCOMB_PROJECT_ID` env override pins the project for scripted/CI
	// use, with PRD-011 parity — it WINS over the cwd binding/git/path, exactly as
	// `HONEYCOMB_ORG_ID`/`HONEYCOMB_WORKSPACE_ID` win over the file for the partition.
	// It is read from the SAME env the tenancy overrides came from. An empty/whitespace
	// value is treated as absent by {@link resolveScopeFromDisk} (no override).
	const env = input.env ?? process.env;
	const projectOverride = env[ENV_PROJECT_ID];
	const project = resolveScopeFromDisk({
		cwd: input.cwd,
		org: tenancy.scope.org,
		// The resolved workspace is the FALLBACK the project is scoped to (a-AC-5);
		// the cwd binding/git/path is the project authority.
		workspace: tenancy.scope.workspace,
		...(projectOverride !== undefined ? { projectIdOverride: projectOverride } : {}),
		...(input.projectsDir !== undefined ? { dir: input.projectsDir } : {}),
		...(input.readRemote !== undefined ? { readRemote: input.readRemote } : {}),
	});
	return { kind: "ok", scope: { tenancy, project } };
}

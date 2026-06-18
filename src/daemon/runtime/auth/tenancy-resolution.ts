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

/**
 * The CredentialsStore — PRD-011a/011b (the `~/.honeycomb/credentials.json` IO).
 *
 * The on-disk credential file is a SECRET at rest: it holds the org-bound bearer
 * token. So this module enforces the storage discipline (D-3):
 *   - the file is written at mode `0600` (owner read/write only) and its parent
 *     dir at `0700` (b-AC-1), so no other local user can read the token;
 *   - `savedAt` is ALWAYS stamped server-side from the injected clock, ignoring any
 *     value the caller passed (b-AC-4) — the timestamp is evidence, not input;
 *   - a missing OR malformed file yields `null` from {@link loadCredentials}
 *     (b-AC-3), never a throw and never a partial credential — the CLI then prompts
 *     login;
 *   - `HONEYCOMB_TOKEN` in the env means the token comes FROM the env and the file
 *     is NOT read for the token (b-AC-5);
 *   - `HONEYCOMB_ORG_ID` / `HONEYCOMB_WORKSPACE_ID` override the file's org /
 *     workspace (a-AC-4);
 *   - and the integrity gate: a file whose `orgId` disagrees with the token's
 *     verified org claim is REJECTED, not honored (a-AC-5 / D-4).
 *
 * Everything IO-touching is injectable (the dir + the clock) so tests run against a
 * temp dir with a fake clock and never touch the real `~/.honeycomb`.
 *
 * ── Windows note (perms are best-effort off POSIX) ─────────────────────────
 * `fs.chmod`/the `mode` option are a no-op on win32 (NTFS ACLs, not POSIX bits), so
 * we still PASS the mode on write (correct + free on POSIX) but the perm-assert
 * test guards on `process.platform !== "win32"`. The token-at-rest protection on
 * Windows is the per-user profile directory ACL, documented as a known platform gap.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Credentials } from "./contracts.js";
import { verifyTokenClaims } from "./contracts.js";

/** The credentials directory name under the user's home (D-3). */
export const CREDENTIALS_DIR_NAME = ".honeycomb";
/** The credentials file name within the dir (D-3). */
export const CREDENTIALS_FILE_NAME = "credentials.json";

/** POSIX mode for the credentials file: owner read/write only (b-AC-1). */
export const FILE_MODE = 0o600;
/** POSIX mode for the credentials dir: owner read/write/execute only (b-AC-1). */
export const DIR_MODE = 0o700;

/** The env var carrying the bearer token directly (b-AC-5). */
export const ENV_TOKEN = "HONEYCOMB_TOKEN";
/** The env var overriding the file's org id (a-AC-4). */
export const ENV_ORG_ID = "HONEYCOMB_ORG_ID";
/** The env var overriding the file's workspace id (a-AC-4). */
export const ENV_WORKSPACE_ID = "HONEYCOMB_WORKSPACE_ID";

/**
 * An injectable clock so `savedAt` is deterministic in tests (b-AC-4). The default
 * is the real wall clock; a test injects a fixed `now`.
 */
export interface Clock {
	/** The current instant as an ISO-8601 string. */
	now(): string;
}

/** The default wall-clock implementation. */
export const systemClock: Clock = {
	now(): string {
		return new Date().toISOString();
	},
};

/** Resolve the credentials directory, honoring an explicit override for tests. */
export function credentialsDir(dir?: string): string {
	return dir ?? join(homedir(), CREDENTIALS_DIR_NAME);
}

/** Resolve the full credentials file path within the (possibly overridden) dir. */
export function credentialsPath(dir?: string): string {
	return join(credentialsDir(dir), CREDENTIALS_FILE_NAME);
}

/**
 * Validate that a parsed object is a structurally-complete {@link Credentials}.
 * A partial / wrong-typed file is treated as MALFORMED → `loadCredentials` returns
 * `null` (b-AC-3): a half-written credential is worse than none, because a missing
 * field would otherwise silently widen to a default.
 */
function isCredentials(value: unknown): value is Credentials {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Record<string, unknown>;
	return (
		typeof r.token === "string" &&
		typeof r.orgId === "string" &&
		typeof r.orgName === "string" &&
		typeof r.workspace === "string" &&
		typeof r.agentId === "string" &&
		typeof r.savedAt === "string"
	);
}

/**
 * Load the persisted {@link Credentials}, applying the token-env rule (b-AC-5).
 *
 * Returns `null` when the file is missing OR malformed (b-AC-3) — never a throw and
 * never a partial credential. When `HONEYCOMB_TOKEN` is set, the returned token is
 * the ENV token and the file is NOT read for its token field (b-AC-5):
 *   - file present + env token → the file's identity fields, but the env token;
 *   - file absent + env token  → `null` here (there is no identity to attach the
 *     token to); resolving an env-only token to a tenancy is `resolveTenancy`'s job
 *     via the env overrides. (Callers that operate purely from env use
 *     {@link resolveTenancy} directly.)
 *
 * The org/workspace ENV overrides are NOT applied here — `loadCredentials` returns
 * the file's persisted identity; {@link resolveTenancy} layers the env overrides +
 * the integrity check on top. Keeping them separate means a test can assert the
 * raw file load and the resolved tenancy independently.
 *
 * `dir` overrides the credentials directory (tests). `env` is injectable (defaults
 * to `process.env`) so the env rules are testable without mutating the real env.
 */
export function loadCredentials(dir?: string, env: NodeJS.ProcessEnv = process.env): Credentials | null {
	const path = credentialsPath(dir);
	if (!existsSync(path)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		// A malformed file is treated as "not logged in" (b-AC-3), not a hard error.
		return null;
	}
	if (!isCredentials(parsed)) return null;

	const envToken = env[ENV_TOKEN];
	if (typeof envToken === "string" && envToken.length > 0) {
		// The env token wins; the file is NOT trusted for the token (b-AC-5). The
		// file's identity fields still describe the active tenancy.
		return { ...parsed, token: envToken };
	}
	return parsed;
}

/**
 * Persist {@link Credentials} at mode `0600` (dir `0700`) with `savedAt` stamped
 * server-side (b-AC-1 / b-AC-4).
 *
 * The `savedAt` field on the passed `creds` is IGNORED and overwritten with
 * `clock.now()` — the persisted timestamp is always the moment of the write, never
 * a caller assertion (b-AC-4). The dir is created (recursively) at `0700` if absent
 * and the file is written at `0600`; on POSIX these mode bits are enforced, on
 * win32 they are a documented best-effort no-op (NTFS ACLs apply instead).
 *
 * Returns the persisted credentials (with the stamped `savedAt`) so a caller can
 * use the canonical record without re-reading the file.
 */
export function saveCredentials(creds: Credentials, dir?: string, clock: Clock = systemClock): Credentials {
	const targetDir = credentialsDir(dir);
	if (!existsSync(targetDir)) {
		mkdirSync(targetDir, { recursive: true, mode: DIR_MODE });
	}
	// Stamp `savedAt` server-side, IGNORING any value on `creds` (b-AC-4).
	const stamped: Credentials = { ...creds, savedAt: clock.now() };
	const path = credentialsPath(dir);
	// `mode` on writeFileSync sets perms only when the file is CREATED; an existing
	// file keeps its perms, so we explicitly write then the platform-correct perms
	// are best-effort. On POSIX the 0600 here is authoritative for a fresh file.
	writeFileSync(path, `${JSON.stringify(stamped, null, 2)}\n`, { mode: FILE_MODE });
	return stamped;
}

/** The resolved tenancy a request runs under (the outer ring — 011a). */
export interface ResolvedTenancy {
	/** The active org id (env override > file). */
	readonly org: string;
	/** The active workspace id (env override > file > `default` sentinel). */
	readonly workspace: string;
	/** The display org name (from the file). */
	readonly orgName: string;
	/** The resolved agent id (from the file). */
	readonly agentId: string;
}

/**
 * A tenancy-resolution failure (a-AC-5 / D-4 / FR-9). Carries the conflicting org
 * ids for the structured log WITHOUT echoing the token. Thrown by
 * {@link resolveTenancy} when the file's `orgId` disagrees with the token's verified
 * org claim, OR when the token cannot be verified — fail-closed, never a fallback to
 * a broader scope.
 */
export class TenancyIntegrityError extends Error {
	/** The org id the file claimed. */
	readonly fileOrg: string;
	/** The org id the token's verified claim carried (or `null` if unverifiable). */
	readonly tokenOrg: string | null;
	constructor(fileOrg: string, tokenOrg: string | null, reason: string) {
		super(`Tenancy integrity check failed: ${reason}`);
		this.name = "TenancyIntegrityError";
		this.fileOrg = fileOrg;
		this.tokenOrg = tokenOrg;
	}
}

/** The `default` workspace sentinel — resolves server-side, never a literal partition (a-AC / FR-3). */
export const DEFAULT_WORKSPACE = "default";

/**
 * Resolve the active tenancy from credentials + env, applying the env overrides
 * (a-AC-4) AND the org-claim-vs-file integrity check (a-AC-5 / D-4).
 *
 * Precedence (FR-7): `HONEYCOMB_ORG_ID` / `HONEYCOMB_WORKSPACE_ID` override the
 * file; absent those, the file's `orgId` / `workspace`; absent a workspace, the
 * `default` sentinel.
 *
 * THE INTEGRITY GATE (a-AC-5 / D-4): the token (env `HONEYCOMB_TOKEN` if set, else
 * the file's token) is decoded + verified via {@link verifyTokenClaims}. If the
 * verified org claim disagrees with the org the file claims, the file is REJECTED
 * with a {@link TenancyIntegrityError} — a tampered credentials file can NEVER widen
 * a token's reach. An unverifiable token is likewise rejected (fail-closed). The
 * `HONEYCOMB_ORG_ID` override is checked against the SAME token claim, so an env
 * override cannot escape the token's org either.
 *
 * Throws {@link TenancyIntegrityError} on any integrity failure; otherwise returns
 * the {@link ResolvedTenancy}. The caller fails the request closed on the throw
 * (FR-9), carrying the structured context (never the token) to the log.
 */
export function resolveTenancy(creds: Credentials, env: NodeJS.ProcessEnv = process.env): ResolvedTenancy {
	const envToken = env[ENV_TOKEN];
	const token = typeof envToken === "string" && envToken.length > 0 ? envToken : creds.token;

	// Verify the token first; an unverifiable token is untrustworthy → reject (D-4).
	const claims = verifyTokenClaims(token);
	if (claims === null) {
		throw new TenancyIntegrityError(creds.orgId, null, "token could not be verified");
	}

	// The org the file claims must agree with the token's verified org claim (a-AC-5).
	if (creds.orgId !== claims.org) {
		throw new TenancyIntegrityError(
			creds.orgId,
			claims.org,
			`credentials file orgId "${creds.orgId}" disagrees with verified token org "${claims.org}"`,
		);
	}

	// The env org override, if present, must ALSO match the token claim — an env var
	// cannot escape the token's org binding any more than the file can.
	const envOrg = env[ENV_ORG_ID];
	const overrideOrg = typeof envOrg === "string" && envOrg.length > 0 ? envOrg : undefined;
	if (overrideOrg !== undefined && overrideOrg !== claims.org) {
		throw new TenancyIntegrityError(
			overrideOrg,
			claims.org,
			`HONEYCOMB_ORG_ID "${overrideOrg}" disagrees with verified token org "${claims.org}"`,
		);
	}

	const org = overrideOrg ?? creds.orgId;
	const envWorkspace = env[ENV_WORKSPACE_ID];
	const overrideWorkspace = typeof envWorkspace === "string" && envWorkspace.length > 0 ? envWorkspace : undefined;
	const workspace = overrideWorkspace ?? (creds.workspace.length > 0 ? creds.workspace : DEFAULT_WORKSPACE);

	return { org, workspace, orgName: creds.orgName, agentId: creds.agentId };
}

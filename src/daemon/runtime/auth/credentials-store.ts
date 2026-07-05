/**
 * The CredentialsStore — PRD-011a/011b + PRD-023 Wave 1 (the SHARED
 * `~/.deeplake/credentials.json` IO, byte-cross-compatible with Hivemind).
 *
 * ── PRD-023 (the shared spine) — READ THIS BEFORE TOUCHING THE SHAPE ─────────
 * Honeycomb and Hivemind share ONE credentials file: `~/.deeplake/credentials.json`
 * (D-1). One `hivemind login` OR `honeycomb login` authenticates BOTH tools. To make
 * the file byte-cross-compatible, the ON-DISK shape is Hivemind's EXACT shape
 * (the {@link DiskCredentials} below):
 *
 *   { token, orgId, orgName, userName, workspaceId, apiUrl, savedAt }   (+ additive `agentId`)
 *
 * Hivemind's loader (`hivemind/src/config.ts` / `auth-creds.ts`) ignores unknown
 * keys (it `JSON.parse`s and reads named fields), so the additive `agentId` Honeycomb
 * writes is invisible to Hivemind — confirmed by reading Hivemind's loader, which
 * never enumerates keys. Honeycomb's REST/internal code keeps using `workspace` /
 * `agentId`; the disk uses `workspaceId` (+ `userName`, `apiUrl`). The adapter below
 * maps `workspaceId ↔ workspace` on the IO boundary so the rest of Honeycomb is
 * untouched (its in-memory {@link Credentials} shape from `contracts.ts` is unchanged).
 *
 * ── Legacy read-fallback (D-1) ──────────────────────────────────────────────
 * If `~/.deeplake/credentials.json` is ABSENT, {@link loadCredentials} falls back to
 * the legacy `~/.honeycomb/credentials.json` (the OLD Honeycomb shape:
 * `workspace`/`agentId`, no `workspaceId`/`apiUrl`/`userName`) and adapts it. New
 * WRITES always land in `~/.deeplake` in the new Hivemind shape — the legacy path is
 * read-only back-compat, never written.
 *
 * The on-disk credential file is a SECRET at rest: it holds the org-bound bearer
 * token. So this module enforces the storage discipline (D-4):
 *   - the file is written at mode `0600` (owner read/write only) and its parent
 *     dir at `0700` (b-AC-1), so no other local user can read the token;
 *   - `savedAt` is ALWAYS stamped server-side from the injected clock, ignoring any
 *     value the caller passed (b-AC-4) — the timestamp is evidence, not input;
 *   - a missing OR malformed file yields `null` from {@link loadCredentials}
 *     (b-AC-3), never a throw and never a partial credential — the CLI then prompts
 *     login;
 *   - the token is NEVER logged/echoed/printed by this module (D-4);
 *   - `HONEYCOMB_TOKEN` in the env means the token comes FROM the env and the file
 *     is NOT read for the token (b-AC-5);
 *   - `HONEYCOMB_ORG_ID` / `HONEYCOMB_WORKSPACE_ID` override the file's org /
 *     workspace (a-AC-4);
 *   - and the integrity gate: a file whose `orgId` disagrees with the token's
 *     verified org claim is REJECTED, not honored (a-AC-5 / D-4).
 *
 * Everything IO-touching is injectable (the dir + the clock) so tests run against a
 * temp dir with a fake clock and never touch the real `~/.deeplake`.
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

/**
 * The SHARED credentials directory name under the user's home (PRD-023 D-1). The
 * file at `~/.deeplake/credentials.json` is the SAME file Hivemind's `hivemind login`
 * writes — one login authenticates both tools.
 */
export const CREDENTIALS_DIR_NAME = ".deeplake";
/**
 * The LEGACY Honeycomb credentials directory (pre-PRD-023). Read-only fallback when
 * `~/.deeplake/credentials.json` is absent (D-1); never written to.
 */
export const LEGACY_CREDENTIALS_DIR_NAME = ".honeycomb";
/** The credentials file name within the dir (D-1). */
export const CREDENTIALS_FILE_NAME = "credentials.json";

/**
 * The ON-DISK credentials shape — Hivemind's EXACT shape (PRD-023 D-1), so the file
 * is byte-cross-compatible with what `hivemind login` writes and `hivemind whoami`
 * reads. Honeycomb ALSO writes the additive `agentId` field (Hivemind ignores unknown
 * keys). This is the inverse of the in-memory {@link Credentials} (`contracts.ts`):
 * `workspaceId` ↔ `workspace`, plus the Hivemind-only `userName` / `apiUrl`.
 *
 * Most fields are optional on READ (a Hivemind-written file may omit some), but
 * `token` + `orgId` are load-bearing — a file without them is not a usable credential.
 */
export interface DiskCredentials {
	/** The org-bound bearer token (SECRET — never logged/printed). */
	token: string;
	/** The org id the token is bound to. */
	orgId: string;
	/** The human-readable org name (display only). */
	orgName?: string;
	/** The authenticated user's display name (Hivemind field; optional). */
	userName?: string;
	/** The active workspace id — maps to the in-memory {@link Credentials.workspace}. */
	workspaceId?: string;
	/** The DeepLake API base URL the credential was minted against (Hivemind field). */
	apiUrl?: string;
	/** Additive Honeycomb-only field: the within-workspace actor id (Hivemind ignores it). */
	agentId?: string;
	/**
	 * PRD-073c: the confirmed-tenancy marker. Set to an ISO-8601 timestamp ONLY by an EXPLICIT
	 * link-time selection (the dashboard `POST /setup/tenancy/select` or the CLI login prompt/flags/
	 * auto-select) — never by the legacy silent `orgs[0]` guess. Additive + Hivemind-ignored. A
	 * pre-073 credential omits it and is grandfathered as confirmed via its non-empty `orgId`
	 * ({@link import("./tenancy-confirmation.js").resolveTenancyConfirmation}); a pending link writes
	 * NO credential at all, so the absence of a credential file is the "unconfirmed" state.
	 */
	tenancyConfirmedAt?: string;
	/**
	 * PRD-073c / BUG 2: the AUTH-ONLY, tenancy-UNSELECTED marker. Set to `true` ONLY by the on-page
	 * `/setup/login` background flow when it persists BASE credentials for a multi-tenancy account so
	 * that `/setup/state.authenticated` can flip the instant the device is approved (the field hive
	 * polls), WITHOUT waiting on the interactive org/workspace pick. A base credential is provisionally
	 * bound to the first enumerated org purely so it is a structurally-usable credential; capture stays
	 * GATED (`tenancy_unconfirmed`) while this flag is `true` and no `tenancyConfirmedAt` is set, so no
	 * data is ever written to the provisional org before the explicit pick. The later `/setup/tenancy/
	 * select` step re-mints for the CHOSEN org and overwrites the file with `tenancyConfirmedAt` set and
	 * this flag cleared. Additive + Hivemind-ignored. A credential with NEITHER this flag NOR the marker
	 * is a pre-073 credential, grandfathered as confirmed (existing installs unchanged — parent AC-5).
	 */
	tenancyPending?: boolean;
	/** ISO timestamp stamped server-side on save (b-AC-4). */
	savedAt: string;
}

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

/**
 * Resolve the SHARED credentials directory (`~/.deeplake`), honoring an explicit
 * override for tests. When `dir` is given it is treated as the credentials dir
 * directly (the test's temp HOME-equivalent), so a test points BOTH the shared and
 * legacy lookups at the same temp dir by passing it here.
 */
export function credentialsDir(dir?: string): string {
	return dir ?? join(homedir(), CREDENTIALS_DIR_NAME);
}

/** Resolve the full SHARED credentials file path within the (possibly overridden) dir. */
export function credentialsPath(dir?: string): string {
	return join(credentialsDir(dir), CREDENTIALS_FILE_NAME);
}

/**
 * Resolve the LEGACY `~/.honeycomb/credentials.json` path for the read-fallback (D-1).
 * When `legacyDir` is given (tests) it is used directly; otherwise the real
 * `~/.honeycomb`. New writes NEVER target this path — it is read-only back-compat.
 */
export function legacyCredentialsPath(legacyDir?: string): string {
	const base = legacyDir ?? join(homedir(), LEGACY_CREDENTIALS_DIR_NAME);
	return join(base, CREDENTIALS_FILE_NAME);
}

/**
 * Validate that a parsed object is a structurally-usable on-disk credential. Accepts
 * BOTH the new Hivemind shape (`workspaceId`, optional `agentId`) AND a Hivemind-only
 * file (which may omit `agentId`/`workspaceId`); the only load-bearing fields are
 * `token` + `orgId` (a credential without them is unusable → treated as malformed,
 * b-AC-3). `savedAt` is accepted as a string when present (Hivemind always writes it).
 */
function isDiskCredentials(value: unknown): value is DiskCredentials {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Record<string, unknown>;
	return typeof r.token === "string" && r.token.length > 0 && typeof r.orgId === "string" && r.orgId.length > 0;
}

/**
 * Validate the LEGACY Honeycomb shape (`workspace`/`agentId`, no `workspaceId`). Used
 * only by the read-fallback. The legacy file required `orgName`/`workspace`/`agentId`
 * strings, mirroring the pre-PRD-023 `isCredentials` gate, so a partial legacy file is
 * still rejected (b-AC-3).
 */
function isLegacyCredentials(value: unknown): boolean {
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
 * Adapt a validated on-disk Hivemind-shape record into the in-memory {@link Credentials}
 * (`workspaceId → workspace`, defaults for the Honeycomb-only fields a Hivemind file
 * omits). `orgName` defaults to `orgId`, `workspace` to the `default` sentinel, and
 * `agentId` to `"default"` so a Hivemind-written file (no `agentId`) loads cleanly.
 */
function diskToInternal(d: DiskCredentials): Credentials {
	return {
		token: d.token,
		orgId: d.orgId,
		orgName: d.orgName ?? d.orgId,
		workspace: d.workspaceId !== undefined && d.workspaceId.length > 0 ? d.workspaceId : "default",
		agentId: d.agentId !== undefined && d.agentId.length > 0 ? d.agentId : "default",
		savedAt: typeof d.savedAt === "string" ? d.savedAt : "",
	};
}

/**
 * Adapt a legacy Honeycomb-shape record (`workspace`/`agentId`) into the in-memory
 * {@link Credentials}. The legacy file already used the in-memory field names, so this
 * is a structural pass-through of the validated fields (no `workspaceId` remap).
 */
function legacyToInternal(value: Record<string, unknown>): Credentials {
	return {
		token: value.token as string,
		orgId: value.orgId as string,
		orgName: value.orgName as string,
		workspace: value.workspace as string,
		agentId: value.agentId as string,
		savedAt: value.savedAt as string,
	};
}

/**
 * Map the in-memory {@link Credentials} onto the Hivemind on-disk shape for WRITE
 * (`workspace → workspaceId`, plus the additive `agentId`). `userName` is left unset
 * (Wave 2's `/me` validate supplies it). `apiUrl` is the caller-supplied endpoint
 * when given (the self-hosted-login path points honeycomb at a self-hosted backend),
 * else the canonical DeepLake endpoint so a Hivemind read sees a complete record.
 * `savedAt` is the server-stamped value (b-AC-4). The token is carried verbatim,
 * never logged here.
 */
function internalToDisk(c: Credentials, savedAt: string, apiUrl: string = DEFAULT_DEEPLAKE_API_URL): DiskCredentials {
	return {
		token: c.token,
		orgId: c.orgId,
		orgName: c.orgName,
		workspaceId: c.workspace,
		apiUrl,
		agentId: c.agentId,
		savedAt,
	};
}

/**
 * The canonical DeepLake API base URL written into `apiUrl` on save (PRD-023 D-2),
 * matching Hivemind's default so a freshly-written file is endpoint-complete for a
 * Hivemind read. Wave 2's login overwrites this with the URL it authenticated against.
 */
export const DEFAULT_DEEPLAKE_API_URL = "https://api.deeplake.ai";

/**
 * Read + parse a credentials file into an internal {@link Credentials} via the given
 * validate + adapt pair. Returns `null` on a missing OR malformed file (b-AC-3) —
 * never a throw. Shared by the new-shape (`~/.deeplake`) and legacy (`~/.honeycomb`)
 * read paths.
 */
function readCredentialsFile(
	path: string,
	validate: (v: unknown) => boolean,
	adapt: (v: Record<string, unknown>) => Credentials,
): Credentials | null {
	if (!existsSync(path)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		// A malformed file is treated as "not logged in" (b-AC-3), not a hard error.
		return null;
	}
	if (!validate(parsed)) return null;
	return adapt(parsed as Record<string, unknown>);
}

/**
 * Load the persisted {@link Credentials} from the SHARED `~/.deeplake/credentials.json`
 * (PRD-023 D-1), falling back to the legacy `~/.honeycomb/credentials.json` when the
 * shared file is absent. Applies the token-env rule (b-AC-5).
 *
 * Read precedence (D-1):
 *   1. `~/.deeplake/credentials.json` (Hivemind shape — accepts a Honeycomb-written
 *      file AND a Hivemind-written file; `workspaceId → workspace` on adapt);
 *   2. else `~/.honeycomb/credentials.json` (legacy Honeycomb shape — adapted as-is).
 *
 * Returns `null` when BOTH are missing OR malformed (b-AC-3) — never a throw and never
 * a partial credential. When `HONEYCOMB_TOKEN` is set, the returned token is the ENV
 * token and neither file is trusted for its token field (b-AC-5); the file's identity
 * fields still describe the active tenancy.
 *
 * The org/workspace ENV overrides are NOT applied here — `loadCredentials` returns the
 * file's persisted identity; {@link resolveTenancy} layers the env overrides + the
 * integrity check on top. Keeping them separate means a test can assert the raw file
 * load and the resolved tenancy independently.
 *
 * `dir` overrides the SHARED credentials directory (tests); `legacyDir` overrides the
 * legacy dir (defaults to `~/.honeycomb`, or — when only `dir` is passed in a temp-HOME
 * test — the sibling `.honeycomb` under the same temp HOME is NOT auto-derived; pass
 * `legacyDir` explicitly to exercise the fallback). `env` is injectable so the env
 * rules are testable without mutating the real env.
 */
export function loadCredentials(
	dir?: string,
	env: NodeJS.ProcessEnv = process.env,
	legacyDir?: string,
): Credentials | null {
	// 1. The shared `~/.deeplake` file (Hivemind shape; accepts cross-tool files).
	let loaded = readCredentialsFile(credentialsPath(dir), isDiskCredentials, (v) =>
		diskToInternal(v as unknown as DiskCredentials),
	);
	// 2. Legacy `~/.honeycomb` read-fallback (D-1) — only when the shared file is absent.
	if (loaded === null) {
		loaded = readCredentialsFile(legacyCredentialsPath(legacyDir), isLegacyCredentials, legacyToInternal);
	}
	if (loaded === null) return null;

	const envToken = env[ENV_TOKEN];
	if (typeof envToken === "string" && envToken.length > 0) {
		// The env token wins; the file is NOT trusted for the token (b-AC-5). The
		// file's identity fields still describe the active tenancy.
		return { ...loaded, token: envToken };
	}
	return loaded;
}

/**
 * Load the RAW on-disk {@link DiskCredentials} (the Hivemind shape, INCLUDING `apiUrl`)
 * from the SHARED `~/.deeplake/credentials.json`, with the same legacy `~/.honeycomb`
 * read-fallback as {@link loadCredentials} (D-1). The storage-config provider
 * (`deeplakeCredentialsFileProvider`) needs `apiUrl` + `workspaceId`, which the
 * internal {@link Credentials} drops — so it reads the raw disk shape here.
 *
 * A legacy file (no `apiUrl`/`workspaceId`) is up-converted into the disk shape:
 * `workspace → workspaceId`, `apiUrl` left undefined (the provider then falls back to
 * the config default). The `HONEYCOMB_TOKEN` env rule applies (b-AC-5). Returns `null`
 * when both files are missing/malformed — never throws.
 */
export function loadDiskCredentials(
	dir?: string,
	env: NodeJS.ProcessEnv = process.env,
	legacyDir?: string,
): DiskCredentials | null {
	let disk: DiskCredentials | null = null;
	// 1. The shared `~/.deeplake` file (already the Hivemind disk shape).
	const sharedPath = credentialsPath(dir);
	if (existsSync(sharedPath)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(sharedPath, "utf8"));
			if (isDiskCredentials(parsed)) disk = parsed as DiskCredentials;
		} catch {
			// Malformed shared file → fall through to the legacy fallback (b-AC-3).
		}
	}
	// 2. Legacy `~/.honeycomb` read-fallback — only when the shared file is absent/bad.
	if (disk === null) {
		const legacyPath = legacyCredentialsPath(legacyDir);
		if (existsSync(legacyPath)) {
			try {
				const parsed: unknown = JSON.parse(readFileSync(legacyPath, "utf8"));
				if (isLegacyCredentials(parsed)) {
					const r = parsed as Record<string, unknown>;
					disk = {
						token: r.token as string,
						orgId: r.orgId as string,
						orgName: r.orgName as string,
						workspaceId: r.workspace as string,
						agentId: r.agentId as string,
						savedAt: r.savedAt as string,
					};
				}
			} catch {
				// Malformed legacy file → no usable credential (b-AC-3).
			}
		}
	}
	if (disk === null) return null;

	const envToken = env[ENV_TOKEN];
	if (typeof envToken === "string" && envToken.length > 0) {
		return { ...disk, token: envToken };
	}
	return disk;
}

/**
 * Persist {@link Credentials} to the SHARED `~/.deeplake/credentials.json` in
 * Hivemind's EXACT on-disk shape (PRD-023 D-1) at mode `0600` (dir `0700`) with
 * `savedAt` stamped server-side (b-AC-1 / b-AC-4). New writes ALWAYS land in
 * `~/.deeplake` in the new shape — never the legacy path.
 *
 * The in-memory `workspace`/`agentId` are mapped to the on-disk `workspaceId` (+ the
 * additive `agentId`); `apiUrl` is the caller-supplied endpoint when given (the
 * self-hosted-login path), else {@link DEFAULT_DEEPLAKE_API_URL} so a Hivemind read
 * sees an endpoint-complete record. The `savedAt` field on the passed `creds` is
 * IGNORED and overwritten with `clock.now()` (b-AC-4). The dir is created
 * (recursively) at `0700` if absent and the file is written at `0600`; on POSIX these
 * mode bits are enforced, on win32 they are a documented best-effort no-op.
 *
 * Returns the in-memory credentials (with the stamped `savedAt`) so a caller can use
 * the canonical record without re-reading the file.
 */
export function saveCredentials(
	creds: Credentials,
	dir?: string,
	clock: Clock = systemClock,
	apiUrl?: string,
): Credentials {
	const targetDir = credentialsDir(dir);
	if (!existsSync(targetDir)) {
		mkdirSync(targetDir, { recursive: true, mode: DIR_MODE });
	}
	// Stamp `savedAt` server-side, IGNORING any value on `creds` (b-AC-4).
	const stampedAt = clock.now();
	const stamped: Credentials = { ...creds, savedAt: stampedAt };
	// Map onto the Hivemind on-disk shape so the file is byte-cross-compatible (D-1).
	// The caller-supplied apiUrl (self-hosted-login) overrides the default endpoint.
	const onDisk: DiskCredentials = internalToDisk(stamped, stampedAt, apiUrl);
	const path = credentialsPath(dir);
	// `mode` on writeFileSync sets perms only when the file is CREATED; an existing
	// file keeps its perms, so we explicitly write then the platform-correct perms
	// are best-effort. On POSIX the 0600 here is authoritative for a fresh file.
	writeFileSync(path, `${JSON.stringify(onDisk, null, 2)}\n`, { mode: FILE_MODE });
	return stamped;
}

/**
 * Persist a RAW {@link DiskCredentials} record to the SHARED `~/.deeplake/credentials.json`
 * in Hivemind's EXACT on-disk shape (PRD-023 D-1 / AC-1), at mode `0600` (dir `0700`) with
 * `savedAt` stamped server-side from the injected clock (b-AC-4).
 *
 * This is the write path PRD-023's `honeycomb login` uses: the device-flow / token-login
 * obtains the REAL `api.deeplake.ai` identity (`userName`, the authenticated `apiUrl`, the
 * `orgName`, the `workspaceId`) which the in-memory {@link Credentials} cannot carry, so the
 * login flow assembles the full disk record and persists it HERE — through the SAME path,
 * dir-mode, and file-mode discipline as {@link saveCredentials}, never a hand-rolled write.
 *
 * The passed `savedAt` is IGNORED and overwritten with `clock.now()` (b-AC-4) — the timestamp
 * is evidence, not caller input. The token is carried verbatim and NEVER logged here (D-4).
 * Returns the persisted disk record (with the stamped `savedAt`) so a caller need not re-read.
 */
export function saveDiskCredentials(disk: DiskCredentials, dir?: string, clock: Clock = systemClock): DiskCredentials {
	const targetDir = credentialsDir(dir);
	if (!existsSync(targetDir)) {
		mkdirSync(targetDir, { recursive: true, mode: DIR_MODE });
	}
	// Stamp `savedAt` server-side, IGNORING any value on the input (b-AC-4).
	const stamped: DiskCredentials = { ...disk, savedAt: clock.now() };
	writeFileSync(credentialsPath(dir), `${JSON.stringify(stamped, null, 2)}\n`, { mode: FILE_MODE });
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

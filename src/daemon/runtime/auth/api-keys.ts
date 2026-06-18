/**
 * Named API keys — PRD-011d (Wave 2, IMPLEMENTED).
 *
 * The connector-authentication path: create a named, revocable key whose ONLY
 * persisted form is a scrypt-salted hash, validate a presented key into an
 * {@link Identity}, and revoke a key per-key without disturbing the others.
 *
 * ── The key format: `hc_sk_<keyid>.<secret>` (d-AC-1) ───────────────────────
 * A scrypt hash carries a PER-KEY random salt and is therefore NOT deterministic,
 * so a presented key can no longer be matched by hashing it and probing
 * `key_hash = <hash>` (the legacy SHA-256 path). Instead the plaintext splits into
 * two parts at the `.`:
 *
 *   - `keyid`  — a PUBLIC random handle. It is stored as the `api_keys.id`, so a
 *                presented key is looked up by `id` (a scoped, escaped SELECT —
 *                {@link buildApiKeyLookupByIdSql}), NOT by its hash.
 *   - `secret` — the private half. ONLY its scrypt-salted hash
 *                ({@link scryptHashSecret}) is stored, in `api_keys.key_hash`. A
 *                presented secret is verified with {@link scryptVerifySecret}
 *                (constant-time `timingSafeEqual`). The plaintext secret is printed
 *                ONCE on create and never persisted or logged.
 *
 * The full prefix is `hc_sk_` (PRD-011d FR-1). So a created key reads
 * `hc_sk_<keyid>.<secret>`; the `keyid` we look up is the part between `hc_sk_`
 * and the `.`.
 *
 * ── Least privilege + bindings (d-AC-3 / d-AC-6) ────────────────────────────
 * A created connector key defaults to the LEAST-privileged role `agent` (a
 * connector: read+write its own scope, denied every admin/token route — the RBAC
 * policy in 011c returns 403, d-AC-3). A `project`-bound key carries that binding
 * onto its resolved {@link Identity}; a request targeting a different project is
 * denied by the RBAC policy (d-AC-6). This module RESOLVES the Identity; the 403
 * is the policy's.
 *
 * ── Boundary ────────────────────────────────────────────────────────────────
 * This is daemon code, so it MAY touch storage. It reaches `api_keys` ONLY through
 * the Wave-1 write primitives + the single-sourced catalog (no hand-rolled fetch,
 * no hand-quoted SQL). It MUST NOT touch contracts.ts, permission.ts, or
 * credentials-store.ts (CONVENTIONS.md).
 */

import { randomBytes } from "node:crypto";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { HealTarget } from "../../storage/heal.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sqlIdent } from "../../storage/sql.js";
import { appendVersionBumped, type RowValues, val } from "../../storage/writes.js";
import {
	API_KEYS_COLUMNS,
	buildApiKeyLookupByIdSql,
	KEY_LIVE,
	KEY_REVOKED,
	scryptHashSecret,
	scryptVerifySecret,
} from "../../storage/catalog/tenancy.js";
import { type ApiKeyRecord, type Authenticator, type Identity, type PresentedCredentials, type Role, asRole } from "./contracts.js";

// ── Key format constants ─────────────────────────────────────────────────────

/** The public key prefix every created key carries (PRD-011d FR-1). */
export const API_KEY_PREFIX = "hc_sk_" as const;
/** The least-privileged role a connector key defaults to (d-AC-3). */
export const DEFAULT_KEY_ROLE: Role = "agent";
/** The `api_keys` heal target (single-sourced columns) the primitives write through. */
const API_KEYS_TARGET: HealTarget = { table: "api_keys", columns: [...API_KEYS_COLUMNS] };

/** The plaintext-printed-once result of creating a key (d-AC-1). */
export interface CreatedApiKey {
	/** The new key record (hash only — the row that lands in `api_keys`). */
	readonly record: ApiKeyRecord;
	/** The plaintext key `hc_sk_<keyid>.<secret>` — returned ONCE to print, NEVER persisted/logged (d-AC-1). */
	readonly plaintext: string;
}

/** A clock seam so create/revoke timestamps are deterministic in tests. */
export interface KeyClock {
	/** Current time as an ISO-8601 string. */
	now(): string;
}

/** The real wall clock. */
export const systemKeyClock: KeyClock = {
	now(): string {
		return new Date().toISOString();
	},
};

/** Arguments to {@link createApiKey}. `role` defaults to the least-privileged `agent` (d-AC-3). */
export interface CreateApiKeyArgs {
	/** A human label for the key. */
	readonly name: string;
	/** The role the key grants; defaults to `agent` (least privilege — d-AC-3). */
	readonly role?: Role;
	/** Optional project binding; a cross-project request is denied by the policy unless admin (d-AC-6). */
	readonly project?: string;
}

// ── keyid / secret split ─────────────────────────────────────────────────────

/**
 * Split a presented plaintext into `{ keyid, secret }`, or `null` if it is not a
 * well-formed `hc_sk_<keyid>.<secret>` (fail-closed). The `keyid` is the row `id`
 * to look up; the `secret` is scrypt-verified. A missing prefix, a missing `.`, or
 * an empty half is rejected so a malformed key can never even reach the lookup.
 */
export function splitApiKey(plaintext: string): { keyid: string; secret: string } | null {
	if (typeof plaintext !== "string" || !plaintext.startsWith(API_KEY_PREFIX)) return null;
	const body = plaintext.slice(API_KEY_PREFIX.length);
	const dot = body.indexOf(".");
	if (dot <= 0 || dot >= body.length - 1) return null;
	const keyid = body.slice(0, dot);
	const secret = body.slice(dot + 1);
	if (keyid.length === 0 || secret.length === 0) return null;
	// The keyid becomes a SQL identifier value (looked up by `id`); keep it to the
	// url-safe alphabet so it round-trips and carries no injection surface of its own.
	if (!/^[A-Za-z0-9_-]+$/.test(keyid)) return null;
	return { keyid, secret };
}

// ── create ───────────────────────────────────────────────────────────────────

/**
 * Create a named API key (d-AC-1). Generates a public `keyid` + a random `secret`,
 * stores ONLY the scrypt-salted hash of the secret (in `api_keys.key_hash`), persists
 * the row APPEND-ONLY VERSION-BUMPED by `id` (the api_keys write pattern — d-AC-4), and
 * returns the plaintext `hc_sk_<keyid>.<secret>` ONCE for printing. The plaintext + the
 * raw secret are never written to disk or a log.
 *
 * The first write of a key lands at `version` = 1 (the bump primitive reads MAX(version)
 * for the `id` — 0 for a fresh key — and INSERTs N+1). Revoke later APPENDs version 2+,
 * carrying `revoked = 1`; the authenticator resolves the HIGHEST version, so a revoked
 * key reads as revoked and is rejected — NEVER an in-place UPDATE (which does not
 * converge on this backend; the bug d-AC-4 guards).
 *
 * `storage`/`scope` reach the `api_keys` table through the Wave-1 write primitive; the
 * `clock` stamps `created_at`. The role defaults to the least-privileged `agent` so a
 * connector key cannot reach an admin route (d-AC-3).
 */
export async function createApiKey(
	storage: StorageQuery,
	scope: QueryScope,
	args: CreateApiKeyArgs,
	clock: KeyClock = systemKeyClock,
): Promise<CreatedApiKey> {
	const keyid = randomBytes(8).toString("hex"); // public 16-char handle → api_keys.id
	const secret = randomBytes(32).toString("base64url"); // private half — only its hash is stored
	const keyHash = scryptHashSecret(secret); // scrypt$N$r$p$<salt>$<hash> — salt embedded, no schema change
	const role: Role = args.role ?? DEFAULT_KEY_ROLE;
	const createdAt = clock.now();
	const plaintext = `${API_KEY_PREFIX}${keyid}.${secret}`;

	// The api_keys schema has no dedicated `project` column; the binding is recorded in
	// the existing `connector` column as a `project:<value>` marker and surfaced back onto
	// the resolved Identity (d-AC-6) — no schema change needed.
	const row: RowValues = [
		["id", val.str(keyid)],
		["name", val.str(args.name)],
		// The ONLY credential column — the scrypt hash. The plaintext/secret are never written.
		["key_hash", val.str(keyHash)],
		["role", val.str(role)],
		["permissions", val.str("[]")],
		["connector", val.str(args.project !== undefined ? `project:${args.project}` : "")],
		["revoked", val.num(KEY_LIVE)],
		["created_at", val.str(createdAt)],
	];

	// APPEND version 1 (the bump primitive reads MAX(version)=0 for a fresh id → INSERTs
	// version 1). NEVER an in-place UPDATE — a key's state is its highest-version row, so a
	// later revoke APPENDs v+1 with revoked=1 and reads as revoked (d-AC-4). The primitive
	// supplies the `version` column itself; the row above MUST NOT carry it.
	await appendVersionBumped(storage, API_KEYS_TARGET, scope, {
		keyColumn: "id",
		keyValue: keyid,
		row,
	});

	const record: ApiKeyRecord = {
		id: keyid,
		keyHash,
		name: args.name,
		role,
		revoked: false,
		createdAt,
		...(args.project !== undefined ? { project: args.project } : {}),
	};
	return { record, plaintext };
}

// ── authenticate ─────────────────────────────────────────────────────────────

/**
 * Map a looked-up `api_keys` row onto an {@link ApiKeyRecord} (fail-closed). A row with
 * an unknown role narrows to `null` via {@link asRole} → the caller treats it as a
 * non-validating key. The `project` binding is read back from the `connector` column's
 * `project:<value>` marker (where {@link createApiKey} stored it).
 */
function rowToRecord(row: StorageRow): ApiKeyRecord | null {
	const id = typeof row.id === "string" ? row.id : "";
	const keyHash = typeof row.key_hash === "string" ? row.key_hash : "";
	if (id === "" || keyHash === "") return null;
	const role = asRole(typeof row.role === "string" ? row.role : "");
	if (role === null) return null;
	const revokedRaw = row.revoked;
	const revoked = revokedRaw === 1 || revokedRaw === "1" || revokedRaw === true;
	const connector = typeof row.connector === "string" ? row.connector : "";
	const project = connector.startsWith("project:") ? connector.slice("project:".length) : undefined;
	return {
		id,
		keyHash,
		name: typeof row.name === "string" ? row.name : "",
		role,
		revoked,
		createdAt: typeof row.created_at === "string" ? row.created_at : "",
		...(project !== undefined && project !== "" ? { project } : {}),
	};
}

/**
 * Build the api-key-authenticator half of the composite {@link Authenticator} (D-9 /
 * d-AC-4 / d-AC-6). Closes over the daemon `storage` + the tenancy `scope` so the
 * lookup is partition-bounded. On a presented `x-api-key`:
 *
 *   1. split `hc_sk_<keyid>.<secret>` → reject a malformed key (→ null → 401);
 *   2. look the row up by `keyid` (a scoped, escaped SELECT — NOT a hash probe,
 *      because scrypt is salted);
 *   3. scrypt-verify the secret against the row's salt-embedding `key_hash` with
 *      constant-time `timingSafeEqual`;
 *   4. reject a `revoked` record (d-AC-4) — explicit + per-key, so revoking one key
 *      never affects another;
 *   5. resolve an {@link Identity} carrying the row's role/project so the RBAC policy
 *      (011c) can enforce least privilege (d-AC-3) and the project gate (d-AC-6).
 *
 * Returns `null` on ANY miss/mismatch/revoked (fail-closed). The bearer-token path is
 * not this authenticator's concern; it only validates `apiKey`.
 */
export function createApiKeyAuthenticator(
	storage: StorageQuery,
	scope: QueryScope,
): Authenticator {
	return {
		async authenticate(presented: PresentedCredentials): Promise<Identity | null> {
			const raw = presented.apiKey;
			if (raw === undefined || raw === "") return null;

			const split = splitApiKey(raw);
			if (split === null) return null;

			const sql = buildApiKeyLookupByIdSql(split.keyid);
			const res = await storage.query(sql, scope);
			if (!isOk(res) || res.rows.length === 0) return null;

			const record = rowToRecord(res.rows[0] as StorageRow);
			if (record === null) return null;

			// Constant-time scrypt verify: a wrong secret (or a tampered keyid pointing at
			// the wrong row) fails here without a timing oracle.
			if (!scryptVerifySecret(split.secret, record.keyHash)) return null;

			// A revoked key is rejected on the NEXT request (d-AC-4) — per-key, explicit.
			if (record.revoked) return null;

			const org = typeof (res.rows[0] as StorageRow).org_id === "string" ? ((res.rows[0] as StorageRow).org_id as string) : scope.org;
			const workspace =
				typeof (res.rows[0] as StorageRow).workspace_id === "string"
					? ((res.rows[0] as StorageRow).workspace_id as string)
					: (scope.workspace ?? "");
			const agentRow = typeof (res.rows[0] as StorageRow).agent === "string" ? ((res.rows[0] as StorageRow).agent as string) : "";

			const identity: Identity = {
				org,
				workspace,
				agentId: agentRow !== "" ? agentRow : record.id,
				role: record.role,
				...(record.project !== undefined ? { project: record.project } : {}),
			};
			return identity;
		},
	};
}

// ── revoke ─────────────────────────────────────────────────────────────────

/**
 * Revoke a key by `id` (d-AC-4) — APPEND a new highest `version` row with `revoked = 1`,
 * NEVER an in-place UPDATE.
 *
 * ── Why append, not UPDATE (the d-AC-4 live-backend fix) ─────────────────────
 * A by-id `UPDATE … SET revoked = 1` does NOT reliably land on this backend: the store
 * serves a by-id point read from segments of differing freshness, so a just-UPDATEd row
 * can return its pre-revoke snapshot — and the authenticator would read `revoked = 0` and
 * let the REVOKED key authenticate (the exact bug this fixes). So revocation mirrors
 * `ontology/supersede.ts`'s `appendPriorSuperseded`: read the key's HIGHEST-version row,
 * then APPEND a fresh row at `version` = N+1 carrying `revoked = 1` and EVERY other field
 * copied forward intact. The key's highest version is then the revoked row, so the
 * authenticator (which resolves `ORDER BY version DESC LIMIT 1`) reads the revoked state
 * and rejects the key. The prior versions stay on disk for audit (never mutated). OTHER
 * keys are untouched — revoke is per-id, so revoking one leaked connector does not rotate
 * any other credential.
 *
 * Returns `true` iff a key with that `id` was found and the revoked version appended;
 * `false` when no such key exists or the append failed (fail-safe: the caller treats a
 * `false` as "revoke did not land" and can retry).
 */
export async function revokeKey(storage: StorageQuery, scope: QueryScope, id: string): Promise<boolean> {
	// 1. Read the key's current (highest-version) row to copy its fields forward.
	const lookup = await storage.query(buildApiKeyLookupByIdSql(id), scope);
	if (!isOk(lookup) || lookup.rows.length === 0) return false;
	const current = lookup.rows[0] as StorageRow;

	// 2. Copy every column forward UNCHANGED, overriding only `revoked` → 1. The version
	//    bump primitive reads MAX(version) for the id and INSERTs N+1, so the revoked row
	//    becomes the new highest version. `revoked` is supplied here, `version` by the
	//    primitive — the row below MUST NOT carry `version`.
	const str = (key: string, fallback = ""): string => {
		const v = current[key];
		return typeof v === "string" ? v : fallback;
	};

	const row: RowValues = [
		["id", val.str(id)],
		["name", val.str(str("name"))],
		// The credential hash is copied forward UNCHANGED — revoke never re-hashes or clears it.
		["key_hash", val.str(str("key_hash"))],
		["role", val.str(str("role"))],
		["permissions", val.str(str("permissions", "[]"))],
		["connector", val.str(str("connector"))],
		["harness", val.str(str("harness"))],
		["agent", val.str(str("agent"))],
		// The ONLY changed field: advance revoked → 1 on the new highest version.
		["revoked", val.num(KEY_REVOKED)],
		["org_id", val.str(str("org_id"))],
		["workspace_id", val.str(str("workspace_id"))],
		["created_at", val.str(str("created_at"))],
		["last_used_at", val.str(str("last_used_at"))],
	];

	const { result } = await appendVersionBumped(storage, API_KEYS_TARGET, scope, {
		keyColumn: "id",
		keyValue: id,
		row,
	});
	return isOk(result);
}

// ── list ─────────────────────────────────────────────────────────────────────

/** One row of `honeycomb key list` — metadata ONLY, NEVER a hash or plaintext (d-AC-1 discipline). */
export interface ApiKeySummary {
	readonly id: string;
	readonly name: string;
	readonly role: Role;
	readonly project?: string;
	readonly revoked: boolean;
	readonly createdAt: string;
}

/**
 * List the keys' SAFE metadata (id/name/role/project/revoked/createdAt). The `key_hash`
 * is deliberately NOT projected onto the summary, so neither a hash nor a plaintext can
 * leak through the list path — the CLI prints only what this returns.
 *
 * ── Highest version per id (PRD-011d / d-AC-4) ───────────────────────────────
 * `api_keys` is append-only version-bumped, so a created-then-revoked key has MULTIPLE
 * physical rows on disk (v1 live, v2 revoked). A raw SELECT * would list a key twice and
 * could surface its STALE pre-revoke row as live. So the list resolves the HIGHEST-version
 * row PER id (the same highest-version-per-id reduction the other version-bumped tables
 * use — `runtime-jobs.ts`, `ontology/supersede.ts`): we scan all rows ordered by version
 * ascending and keep the last (highest) seen per id, so a revoked key lists once, as
 * revoked. The current ACTIVE state of each key is therefore reported, never a ghost.
 */
export async function listKeys(storage: StorageQuery, scope: QueryScope): Promise<ApiKeySummary[]> {
	// SELECT * (all versions of all keys) then reduce to the highest version per id and drop
	// key_hash on the way out (the projection list is single-sourced in the catalog; we never
	// widen it into a hand-built column list here).
	const res = await storage.query(buildListApiKeysSql(), scope);
	if (!isOk(res)) return [];

	// Reduce to the highest-version row per id. Rows arrive ordered by version ASC, so the
	// last row seen for an id is its current state; we overwrite earlier (stale) versions.
	const currentById = new Map<string, StorageRow>();
	for (const raw of res.rows) {
		const row = raw as StorageRow;
		const id = typeof row.id === "string" ? row.id : "";
		if (id === "") continue;
		const ver = typeof row.version === "number" ? row.version : Number(row.version);
		const version = Number.isFinite(ver) ? ver : 0;
		const prev = currentById.get(id);
		const prevVer = prev ? (typeof prev.version === "number" ? prev.version : Number(prev.version)) : -Infinity;
		if (!prev || version >= (Number.isFinite(prevVer) ? prevVer : -Infinity)) {
			currentById.set(id, row);
		}
	}

	const summaries: ApiKeySummary[] = [];
	for (const row of currentById.values()) {
		const record = rowToRecord(row);
		if (record === null) continue;
		summaries.push({
			id: record.id,
			name: record.name,
			role: record.role,
			revoked: record.revoked,
			createdAt: record.createdAt,
			...(record.project !== undefined ? { project: record.project } : {}),
		});
	}
	return summaries;
}

/**
 * Build the `honeycomb key list` SELECT (ALL versions of all keys in scope), ordered by
 * `version` ASC so the caller's per-id reduction keeps the LAST (highest) row seen as the
 * current state. Identifier via `sqlIdent`.
 */
function buildListApiKeysSql(): string {
	const tbl = sqlIdent("api_keys");
	const ver = sqlIdent("version");
	return `SELECT * FROM "${tbl}" ORDER BY ${ver} ASC`;
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE API-KEY LIFECYCLE SMOKE — OPT-IN, SEEDS A REAL DEEPLAKE BACKEND.    ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-011d: the REAL create→store-scrypt-hash→lookup-by-keyid→revoke path.  ║
 * ║  Wave 2 implements scrypt hashing + the `<keyid>.<secret>` format; this     ║
 * ║  suite proves the path round-trips on a REAL `api_keys`-shaped table:       ║
 * ║                                                                          ║
 * ║    - mint two keys with the REAL scrypt format (`scrypt$N$r$p$salt$hash`);  ║
 * ║      store the row update-or-insert by the public `keyid` (= `id`), with    ║
 * ║      ONLY the scrypt hash in `key_hash` — assert NO plaintext + NO raw      ║
 * ║      secret ever lands on disk;                                            ║
 * ║    - look a key up BY ITS KEYID (a scoped SELECT — NOT a hash probe, since   ║
 * ║      scrypt is salted) and scrypt-verify the secret;                       ║
 * ║    - revoke one key → it no longer authenticates; the OTHER key keeps        ║
 * ║      resolving (d-AC-4 shape).                                             ║
 * ║                                                                          ║
 * ║  GATED + ISOLATED (modeled on recall-authz-live.itest.ts):                ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = whole        ║
 * ║      suite skips, run exits 0.                                            ║
 * ║    - `.itest.ts` suffix keeps it OUT of `npm run test` / `npm run ci`.      ║
 * ║      Run only via `npm run test:integration`.                            ║
 * ║    - Seeds a per-run THROWAWAY table (`ci_api_keys_<run-id>`) and DROPs it. ║
 * ║    - `queryTimeoutMs: 120_000` for the first-touch heal (CREATE + retry).   ║
 * ║    - Reads that may observe >1 fresh row POLL-AND-UNION (the scanDistinct   ║
 * ║      pattern) — a single immediate scan under-reports on this backend.      ║
 * ║                                                                          ║
 * ║  SECRETS: the token is read ONLY from the env via the storage layer's     ║
 * ║  `envCredentialProvider`. Never hardcoded, logged, or echoed. The api-key   ║
 * ║  PLAINTEXT + raw SECRET are asserted to NEVER appear in any stored row.     ║
 * ║                                                                          ║
 * ║  Do NOT run this locally (no creds) — the orchestrator runs it.           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	appendVersionBumped,
	createStorageClient,
	envCredentialProvider,
	isOk,
	resolveStorageConfig,
	type RowValues,
	sqlIdent,
	type StorageClient,
	val,
} from "../../src/daemon/storage/index.js";
import {
	API_KEYS_COLUMNS,
	buildApiKeyLookupByIdSql,
	scryptHashSecret,
	scryptVerifySecret,
	KEY_LIVE,
	KEY_REVOKED,
} from "../../src/daemon/storage/catalog/tenancy.js";
import type { StorageRow } from "../../src/daemon/storage/result.js";
import type { HealTarget } from "../../src/daemon/storage/heal.js";
import { neutralizeIfInfraDegraded } from "./_infra-skip.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const CI_TABLE = `ci_api_keys_${RUN_ID}`;

/** The PUBLIC keyids (= the row `id`, the lookup handle). url-safe alphabet. */
const KEY_LIVE_ID = `apikey_${RUN_ID}_live`;
const KEY_REVOKE_ID = `apikey_${RUN_ID}_revoke`;
/** Distinct private SECRETS; only their SCRYPT HASH is ever stored (d-AC-1). */
const SECRET_LIVE = `live_${RUN_ID}_SECRET_SHOULD_NEVER_PERSIST`;
const SECRET_REVOKE = `revoke_${RUN_ID}_SECRET_SHOULD_NEVER_PERSIST`;
/** The plaintext keys the operator would receive once — `hc_sk_<keyid>.<secret>`. */
const PLAINTEXT_LIVE = `hc_sk_${KEY_LIVE_ID}.${SECRET_LIVE}`;
const PLAINTEXT_REVOKE = `hc_sk_${KEY_REVOKE_ID}.${SECRET_REVOKE}`;

/** The throwaway `api_keys`-shaped HealTarget (single-sourced API_KEYS_COLUMNS). */
const ciTarget: HealTarget = { table: CI_TABLE, columns: [...API_KEYS_COLUMNS] };

/** Build a seed `api_keys` row carrying ONLY the scrypt hash — never the plaintext/secret (d-AC-1). */
function keyRow(args: { id: string; secret: string; name: string; now: string }): RowValues {
	return [
		["id", val.str(args.id)],
		["name", val.str(args.name)],
		// The ONLY credential column — the REAL scrypt hash (salt + params embedded).
		["key_hash", val.str(scryptHashSecret(args.secret))],
		["role", val.str("agent")],
		["revoked", val.num(KEY_LIVE)],
		["created_at", val.str(args.now)],
	];
}

function describeResult(r: { kind: string }): string {
	return r.kind;
}

/** Re-point an `api_keys` SELECT builder at the throwaway CI table (proven live pattern). */
function repoint(sql: string): string {
	return sql.replace('FROM "api_keys"', `FROM "${sqlIdent(CI_TABLE)}"`);
}

/**
 * Poll a lookup-by-keyid {@link SCAN_POLLS} times and return the UNION of the
 * (id → row) it observes, verifying the secret with scrypt as it goes. Same
 * fail-closed reasoning as recall-authz-live: a bare scan can MISS a fresh row on a
 * stale segment but never INVENTS one, so unioning converges UP to the durable truth.
 * The plaintext + the raw secret are asserted to NEVER appear in any stored row.
 */
const SCAN_POLLS = 20;

/**
 * Poll the highest-version-by-id read until a row is visible, returning the
 * GREATEST-`version` row observed across {@link SCAN_POLLS} polls (the poll-convergent
 * "current state" read — same reasoning as pollAuthenticate). A single immediate read
 * can land on a stale segment and miss the latest version, but a scan never invents a
 * row, so taking the max version across polls converges UP to the durable current row.
 * Returns `null` if no row was ever observed.
 */
async function pollHighestVersion(
	storage: StorageClient,
	keyid: string,
	scope: { org: string; workspace: string },
): Promise<StorageRow | null> {
	const sql = repoint(buildApiKeyLookupByIdSql(keyid));
	let best: StorageRow | null = null;
	let bestVer = -Infinity;
	for (let poll = 0; poll < SCAN_POLLS; poll++) {
		const res = await storage.query(sql, scope);
		expect(res.kind, `highest-version lookup must succeed: ${describeResult(res)}`).toBe("ok");
		if (isOk(res) && res.rows.length > 0) {
			const row = res.rows[0] as StorageRow;
			const v = typeof row.version === "number" ? row.version : Number(row.version);
			const ver = Number.isFinite(v) ? v : 0;
			if (ver >= bestVer) {
				bestVer = ver;
				best = row;
			}
		}
	}
	return best;
}

async function pollAuthenticate(
	storage: StorageClient,
	keyid: string,
	secret: string,
	scope: { org: string; workspace: string },
): Promise<boolean> {
	const sql = repoint(buildApiKeyLookupByIdSql(keyid));
	let authenticated = false;
	for (let poll = 0; poll < SCAN_POLLS; poll++) {
		const res = await storage.query(sql, scope);
		expect(res.kind, `lookup must succeed: ${describeResult(res)}`).toBe("ok");
		if (isOk(res)) {
			for (const row of res.rows) {
				// The plaintext key + the raw secret must NEVER appear in any stored row (d-AC-1).
				const serialized = JSON.stringify(row);
				expect(serialized).not.toContain(PLAINTEXT_LIVE);
				expect(serialized).not.toContain(PLAINTEXT_REVOKE);
				expect(serialized).not.toContain(SECRET_LIVE);
				expect(serialized).not.toContain(SECRET_REVOKE);
				// The stored credential is a scrypt string only.
				const keyHash = String((row as { key_hash?: unknown }).key_hash ?? "");
				expect(keyHash.startsWith("scrypt$")).toBe(true);
				// Authenticate the way the daemon does: scrypt-verify + reject revoked.
				const revoked = (row as { revoked?: unknown }).revoked;
				const isRevoked = revoked === 1 || revoked === "1" || revoked === true;
				if (!isRevoked && scryptVerifySecret(secret, keyHash)) authenticated = true;
			}
		}
	}
	return authenticated;
}

describe.skipIf(!HAS_TOKEN)("live api-key lifecycle smoke (opt-in, real backend)", () => {
	let storage: StorageClient;
	let org: string;
	let workspace: string;

	beforeAll(async () => {
		const raw = envCredentialProvider().read();
		const provider = {
			read: () => ({
				...raw,
				workspace: process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci",
				// First-touch on a fresh throwaway table lazily heals (CREATE + retry).
				queryTimeoutMs: 120_000,
			}),
		};
		const config = resolveStorageConfig(provider);
		org = config.org;
		workspace = config.workspace;
		storage = createStorageClient({ provider });

		const scope = { org, workspace };
		const now = "2026-06-17T00:00:00.000Z";
		// Two keys via APPEND-ONLY VERSION-BUMP by id (the api_keys write pattern — d-AC-4):
		// each create APPENDs version 1, mirroring the production createApiKey. Only the
		// scrypt hash is stored — the secret/plaintext are never written.
		const seeds: { id: string; row: RowValues }[] = [
			{ id: KEY_LIVE_ID, row: keyRow({ id: KEY_LIVE_ID, secret: SECRET_LIVE, name: "live", now }) },
			{ id: KEY_REVOKE_ID, row: keyRow({ id: KEY_REVOKE_ID, secret: SECRET_REVOKE, name: "to-revoke", now }) },
		];
		for (const [i, seed] of seeds.entries()) {
			const { result, version } = await appendVersionBumped(storage, ciTarget, scope, {
				keyColumn: "id",
				keyValue: seed.id,
				row: seed.row,
			});
			expect(result.kind, `seed ${i} must succeed: ${describeResult(result)}`).toBe("ok");
			expect(version, `seed ${i} must land at version 1`).toBe(1);
		}
	});

	afterAll(async () => {
		if (!storage) return;
		const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(CI_TABLE)}"`, { org, workspace });
		if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${CI_TABLE} in ${workspace}: ${describeResult(res)}`);
	});

	it("a key looked up by its keyid scrypt-verifies; the stored row carries NO plaintext/secret", async ({ skip }) => {
		const scope = { org, workspace };
		// INFRA-DEGRADED preflight (PRD-034a FR-4 / a-AC-3): if the backend is sustained-down
		// (a liveness probe flaps transient AFTER the client's retry), resolve NEUTRAL via a
		// SKIP + the run-level sentinel rather than red-ing the api-key lifecycle proof on
		// DeepLake weather. A non-transient failure (real defect) or an ok probe continues to
		// the strict scrypt/no-plaintext assertions with full teeth.
		await neutralizeIfInfraDegraded("api-keys-live:preflight", () => storage.connect(scope), skip);

		// The SAME lookup-by-id path the 011d authenticator validates a presented key with.
		const ok = await pollAuthenticate(storage, KEY_LIVE_ID, SECRET_LIVE, scope);
		expect(ok).toBe(true);
		// A wrong secret on the same keyid must NOT authenticate (scrypt rejects it).
		const wrong = await pollAuthenticate(storage, KEY_LIVE_ID, "the-wrong-secret", scope);
		expect(wrong).toBe(false);
	});

	it("a revoked key no longer authenticates, but the other key keeps working (d-AC-4 shape)", async () => {
		const scope = { org, workspace };

		// Revoke is an APPEND, NOT an in-place UPDATE (d-AC-4 — the live-backend fix). An
		// in-place `SET revoked = 1 WHERE id = …` does NOT converge on this backend (a by-id
		// read can serve the stale pre-revoke segment and the revoked key would STILL
		// authenticate — the exact bug). So we mirror production `revokeKey`: poll-read the
		// key's HIGHEST-version row, then APPEND v+1 carrying revoked=1 with every field
		// copied forward. The key's highest version then reads as revoked.
		const current = await pollHighestVersion(storage, KEY_REVOKE_ID, scope);
		expect(current, "the to-revoke key's current row must be visible before revoke").not.toBeNull();
		const cur = current as StorageRow;
		const str = (key: string, fallback = ""): string => {
			const v = cur[key];
			return typeof v === "string" ? v : fallback;
		};
		const revokeRow: RowValues = [
			["id", val.str(KEY_REVOKE_ID)],
			["name", val.str(str("name"))],
			// The credential hash is copied forward UNCHANGED — revoke never re-hashes it.
			["key_hash", val.str(str("key_hash"))],
			["role", val.str(str("role"))],
			// The ONLY changed field: advance revoked → 1 on the new highest version.
			["revoked", val.num(KEY_REVOKED)],
			["created_at", val.str(str("created_at"))],
		];
		const { result, version } = await appendVersionBumped(storage, ciTarget, scope, {
			keyColumn: "id",
			keyValue: KEY_REVOKE_ID,
			row: revokeRow,
		});
		expect(result.kind, `revoke append must succeed: ${describeResult(result)}`).toBe("ok");
		expect(version, "the revoked row must be the new highest version").toBeGreaterThan(1);

		// The revoked key no longer authenticates: pollAuthenticate resolves the HIGHEST
		// version (ORDER BY version DESC) poll-convergently, so it reads the revoked v2 and
		// rejects it — a single stale read can never resurrect the live v1.
		const revokedAuth = await pollAuthenticate(storage, KEY_REVOKE_ID, SECRET_REVOKE, scope);
		expect(revokedAuth).toBe(false);

		// The OTHER (live) key keeps authenticating — revoke is per-id, never blanket.
		const liveAuth = await pollAuthenticate(storage, KEY_LIVE_ID, SECRET_LIVE, scope);
		expect(liveAuth).toBe(true);
	});
});

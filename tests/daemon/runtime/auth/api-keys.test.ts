/**
 * PRD-011d — API keys (scrypt). One named test per d-AC the api-key path owns.
 *
 * Verification posture: an in-memory `api_keys`-shaped table behind the real
 * `FakeDeepLakeTransport` + storage client, so the genuine write/lookup/revoke
 * primitives + the REAL scrypt hashing/verification round-trip run — no real backend,
 * no real key material on disk.
 *
 * d-AC-1 create → plaintext returned ONCE; only a SCRYPT-SALTED hash is stored (the
 *        plaintext + the raw secret never appear in the stored row).
 * d-AC-3 a default (connector) key carries the least-privileged `agent` role, so the
 *        RBAC policy (011c) denies an admin route — verified via the resolved Identity.
 * d-AC-4 a revoked key is rejected on the next request; a sibling key keeps working.
 * d-AC-6 a key bound `project=alpha` resolves an Identity carrying `project=alpha`
 *        (the policy then denies a `project=beta` request).
 * Plus: scrypt-verify accepts the right secret and rejects a wrong one (timingSafeEqual).
 */

import { describe, expect, it } from "vitest";

import { createStorageClient, type QueryScope, type StorageQuery } from "../../../../src/daemon/storage/index.js";
import type { StorageRow } from "../../../../src/daemon/storage/result.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { TransportError } from "../../../../src/daemon/storage/transport.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";
import {
	scryptHashSecret,
	scryptVerifySecret,
} from "../../../../src/daemon/storage/catalog/tenancy.js";
import {
	API_KEY_PREFIX,
	createApiKey,
	createApiKeyAuthenticator,
	type KeyClock,
	listKeys,
	revokeKey,
	splitApiKey,
} from "../../../../src/daemon/runtime/auth/api-keys.js";

const SCOPE: QueryScope = { org: "test-org", workspace: "test-ws" };
const CLOCK: KeyClock = { now: () => "2026-06-17T00:00:00.000Z" };

/**
 * A stateful in-memory `api_keys` table behind the real transport, modeling the
 * APPEND-ONLY VERSION-BUMPED shape (PRD-011d / d-AC-4). It stores EVERY appended row
 * (multiple versions per id), and resolves a by-id SELECT to the HIGHEST `version`
 * row — exactly as the real backend does under `ORDER BY version DESC`. It recognizes
 * the EXACT statement shapes the api-key module emits: the version-bump MAX(version)
 * read (`SELECT version … ORDER BY version DESC LIMIT 1`), the lookup-by-id SELECT, the
 * list SELECT (all versions, ordered), and the INSERT of each version. There is NO
 * UPDATE branch by design: a revoke that emitted an in-place UPDATE would throw here,
 * which is the test guard that revoke is append-only (it never mutates a row in place).
 * This runs the real client + write primitives + scrypt — a faithful round-trip.
 */
class InMemoryApiKeys {
	/** Every appended row, in insert order. A key has one row per version. */
	readonly allRows: StorageRow[] = [];
	readonly statements: string[] = [];

	/** The highest-version row per id (the current state), resolved on demand. */
	private highestById(id: string): StorageRow | undefined {
		let best: StorageRow | undefined;
		let bestVer = -Infinity;
		for (const row of this.allRows) {
			if (String(row.id) !== id) continue;
			const ver = typeof row.version === "number" ? row.version : Number(row.version);
			const v = Number.isFinite(ver) ? ver : 0;
			if (v >= bestVer) {
				bestVer = v;
				best = row;
			}
		}
		return best;
	}

	/** All rows for an id (every version), to model the version-bump MAX(version) read. */
	rowsForId(id: string): StorageRow[] {
		return this.allRows.filter((r) => String(r.id) === id);
	}

	responder = (req: TransportRequest): StorageRow[] => {
		const sql = req.sql;
		this.statements.push(sql);

		// lookup / version-read / list: SELECT ... FROM "api_keys" [WHERE id = '...'] [ORDER BY version]
		if (/^SELECT/i.test(sql) && /FROM\s+"api_keys"/i.test(sql)) {
			const idMatch = /WHERE\s+id\s*=\s*'([^']*)'/i.exec(sql);
			if (idMatch) {
				// A by-id read resolves the HIGHEST version (ORDER BY version DESC LIMIT 1),
				// the convergent current-state read the module always emits.
				const row = this.highestById(idMatch[1]);
				return row ? [row] : [];
			}
			// list: no WHERE → ALL versions of all rows (the caller reduces to highest per id).
			return [...this.allRows];
		}

		// INSERT INTO "api_keys" (cols) VALUES (vals) — every create AND every revoke is an APPEND.
		if (/^INSERT\s+INTO\s+"api_keys"/i.test(sql)) {
			this.allRows.push(parseInsert(sql));
			return [];
		}

		// An in-place UPDATE is FORBIDDEN on this table (append-only) — surfacing it as an
		// error is the test guard that revoke never mutates a row in place (d-AC-4).
		throw new TransportError("query", `unexpected statement (api_keys is append-only): ${sql.slice(0, 80)}`);
	};
}

/** Parse `INSERT INTO "api_keys" (a, b) VALUES ('x', 1)` into a row object. */
function parseInsert(sql: string): StorageRow {
	const m = /\(([^)]*)\)\s*VALUES\s*\((.*)\)\s*$/is.exec(sql);
	if (!m) throw new Error(`cannot parse INSERT: ${sql}`);
	const cols = m[1].split(",").map((c) => c.trim());
	const vals = splitValues(m[2]);
	const row: StorageRow = {};
	cols.forEach((c, i) => {
		row[c] = vals[i];
	});
	return row;
}

/** Split a VALUES list on top-level commas, honoring single-quoted literals. */
function splitValues(raw: string): unknown[] {
	const out: unknown[] = [];
	let buf = "";
	let inStr = false;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (inStr) {
			if (ch === "'" && raw[i + 1] === "'") {
				buf += "'";
				i++;
			} else if (ch === "'") {
				inStr = false;
			} else {
				buf += ch;
			}
		} else if (ch === "'") {
			inStr = true;
		} else if (ch === ",") {
			out.push(coerce(buf.trim()));
			buf = "";
		} else {
			buf += ch;
		}
	}
	if (buf.trim().length > 0 || out.length > 0) out.push(coerce(buf.trim(), buf));
	return out;
}

/** Coerce a captured token: a bare number → number, else the (already unquoted) string. */
function coerce(token: string, rawWhenEmpty?: string): unknown {
	if (token === "" && rawWhenEmpty !== undefined) return "";
	if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
	return token;
}

function makeStorage(table: InMemoryApiKeys): StorageQuery {
	const transport = new FakeDeepLakeTransport(table.responder);
	return createStorageClient({ provider: stubProvider(fakeCredentialRecord()), transport });
}

describe("d-AC-1 create → plaintext ONCE; only a scrypt-salted hash stored", () => {
	it("stores a scrypt hash and never the plaintext or the raw secret", async () => {
		const table = new InMemoryApiKeys();
		const storage = makeStorage(table);

		const created = await createApiKey(storage, SCOPE, { name: "connector-x" }, CLOCK);

		// The plaintext is the `hc_sk_<keyid>.<secret>` form, returned once.
		expect(created.plaintext.startsWith(API_KEY_PREFIX)).toBe(true);
		const split = splitApiKey(created.plaintext);
		expect(split).not.toBeNull();
		const { secret } = split as { keyid: string; secret: string };

		// Create APPENDS exactly one row at version 1 (append-only version-bump — d-AC-4).
		const versions = table.rowsForId(created.record.id);
		expect(versions.length).toBe(1);
		const stored = versions[0];
		expect(Number(stored.version)).toBe(1);
		expect(stored.revoked).toBe(0);

		// The stored row carries ONLY a scrypt hash in key_hash — never the plaintext/secret.
		const keyHash = String(stored.key_hash);
		expect(keyHash.startsWith("scrypt$")).toBe(true);

		const serialized = JSON.stringify(stored);
		expect(serialized).not.toContain(created.plaintext);
		expect(serialized).not.toContain(secret);

		// The stored hash genuinely verifies the secret (scrypt round-trip).
		expect(scryptVerifySecret(secret, keyHash)).toBe(true);
		// The CreatedApiKey record exposes the hash, never a plaintext field.
		expect(created.record.keyHash.startsWith("scrypt$")).toBe(true);
		expect(JSON.stringify(created.record)).not.toContain(secret);
	});
});

describe("scrypt verify accepts the right secret and rejects a wrong one (timingSafeEqual)", () => {
	it("accepts the matching secret and rejects a mismatch / malformed hash", () => {
		const hash = scryptHashSecret("correct horse battery staple");
		expect(scryptVerifySecret("correct horse battery staple", hash)).toBe(true);
		expect(scryptVerifySecret("wrong secret", hash)).toBe(false);
		// A salted hash is non-deterministic: the same secret hashes to a different string.
		expect(scryptHashSecret("same")).not.toBe(scryptHashSecret("same"));
		// Fail-closed on a non-scrypt / malformed stored string.
		expect(scryptVerifySecret("x", "")).toBe(false);
		expect(scryptVerifySecret("x", "sha256:deadbeef")).toBe(false);
		expect(scryptVerifySecret("x", "scrypt$bad")).toBe(false);
	});
});

describe("the authenticator validates a presented key by keyid + scrypt-verify", () => {
	it("accepts the real key and rejects a tampered secret", async () => {
		const table = new InMemoryApiKeys();
		const storage = makeStorage(table);
		const created = await createApiKey(storage, SCOPE, { name: "k" }, CLOCK);
		const auth = createApiKeyAuthenticator(storage, SCOPE);

		const ok = await auth.authenticate({ apiKey: created.plaintext });
		expect(ok).not.toBeNull();
		expect(ok?.role).toBe("agent");

		// A wrong secret on the right keyid → rejected (constant-time verify), → null → 401.
		const split = splitApiKey(created.plaintext) as { keyid: string; secret: string };
		const tampered = `${API_KEY_PREFIX}${split.keyid}.${"A".repeat(43)}`;
		expect(await auth.authenticate({ apiKey: tampered })).toBeNull();
		// A malformed key (no `.`) → rejected up front.
		expect(await auth.authenticate({ apiKey: `${API_KEY_PREFIX}garbage` })).toBeNull();
		// No api key at all → null (the bearer path is not this authenticator's concern).
		expect(await auth.authenticate({})).toBeNull();
	});
});

describe("d-AC-3 a default connector key carries the least-privileged agent role", () => {
	it("resolves an Identity with role=agent so the RBAC policy denies admin routes", async () => {
		const table = new InMemoryApiKeys();
		const storage = makeStorage(table);
		// No explicit role → the connector default.
		const created = await createApiKey(storage, SCOPE, { name: "connector" }, CLOCK);
		expect(created.record.role).toBe("agent");

		const auth = createApiKeyAuthenticator(storage, SCOPE);
		const identity = await auth.authenticate({ apiKey: created.plaintext });
		expect(identity).not.toBeNull();
		// The least-privileged role is what the 011c RBAC matrix denies on an admin route.
		expect(identity?.role).toBe("agent");
	});
});

describe("d-AC-4 a revoked key is rejected next request; siblings keep working", () => {
	it("rejects the revoked key while the other key still authenticates", async () => {
		const table = new InMemoryApiKeys();
		const storage = makeStorage(table);
		const auth = createApiKeyAuthenticator(storage, SCOPE);

		const a = await createApiKey(storage, SCOPE, { name: "key-a" }, CLOCK);
		const b = await createApiKey(storage, SCOPE, { name: "key-b" }, CLOCK);

		// Both authenticate before any revoke.
		expect(await auth.authenticate({ apiKey: a.plaintext })).not.toBeNull();
		expect(await auth.authenticate({ apiKey: b.plaintext })).not.toBeNull();

		// Revoke A only.
		expect(await revokeKey(storage, SCOPE, a.record.id)).toBe(true);

		// Revoke is an APPEND, never an in-place UPDATE (d-AC-4): A now has TWO physical
		// rows — its v1 live row is RETAINED, and a NEW v2 row carries revoked=1. The
		// fake throws on any UPDATE, so reaching here already proves no UPDATE was emitted.
		const aVersions = table.rowsForId(a.record.id).sort((x, y) => Number(x.version) - Number(y.version));
		expect(aVersions.map((r) => Number(r.version))).toEqual([1, 2]);
		expect(aVersions[0].revoked).toBe(0); // v1 (live) retained for audit, unmutated.
		expect(aVersions[1].revoked).toBe(1); // v2 (the highest version) is revoked.
		// The credential hash is copied forward UNCHANGED onto the revoked version.
		expect(aVersions[1].key_hash).toBe(aVersions[0].key_hash);
		// No UPDATE statement was ever emitted against api_keys (append-only discipline).
		expect(table.statements.some((s) => /^UPDATE/i.test(s.trim()))).toBe(false);

		// A is rejected on the NEXT request — the authenticator resolves the HIGHEST version
		// (the revoked v2), so the stale pre-revoke v1 never authenticates. B is unaffected.
		expect(await auth.authenticate({ apiKey: a.plaintext })).toBeNull();
		expect(await auth.authenticate({ apiKey: b.plaintext })).not.toBeNull();
	});

	it("listKeys reports the revoked key once, as revoked (highest version per id)", async () => {
		const table = new InMemoryApiKeys();
		const storage = makeStorage(table);

		const a = await createApiKey(storage, SCOPE, { name: "key-a" }, CLOCK);
		const b = await createApiKey(storage, SCOPE, { name: "key-b" }, CLOCK);
		expect(await revokeKey(storage, SCOPE, a.record.id)).toBe(true);

		const summaries = await listKeys(storage, SCOPE);
		// Each key appears EXACTLY once despite a having two physical versions on disk.
		expect(summaries.length).toBe(2);
		const byId = new Map(summaries.map((s) => [s.id, s]));
		expect(byId.get(a.record.id)?.revoked).toBe(true); // highest version → revoked.
		expect(byId.get(b.record.id)?.revoked).toBe(false);
	});
});

describe("d-AC-6 a project-bound key resolves an Identity carrying that project", () => {
	it("binds project=alpha onto the Identity (the policy then denies project=beta)", async () => {
		const table = new InMemoryApiKeys();
		const storage = makeStorage(table);
		const created = await createApiKey(storage, SCOPE, { name: "alpha-key", project: "alpha" }, CLOCK);
		expect(created.record.project).toBe("alpha");

		const auth = createApiKeyAuthenticator(storage, SCOPE);
		const identity = await auth.authenticate({ apiKey: created.plaintext });
		expect(identity?.project).toBe("alpha");
		// The cross-project denial itself is the RBAC policy's job (011c); the binding
		// being present on the Identity is what makes that denial possible (d-AC-6).
	});
});

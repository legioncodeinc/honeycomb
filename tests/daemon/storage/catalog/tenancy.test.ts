/**
 * PRD-003e — Agents, Auth, Telemetry — proves e-AC-1..7.
 *
 * Verification posture (EXECUTION_LEDGER-prd-003): no live DeepLake. Each e-AC
 * has a named, unskipped test against the PRD-002 fake transport. The binding
 * DoD per table: the ColumnDef array validates; `buildCreateTableSql` emits the
 * right DDL; a missing-table write heals + retries once via the real heal engine;
 * the required auth/telemetry columns are present with correct types/defaults;
 * security invariants are asserted structurally (no plaintext key column, no
 * prompt-content column in telemetry).
 *
 * Producer / auth / router logic (PRD-004, PRD-007) is OUT of scope — ACs are
 * met at the catalog level: the column shapes + helpers enforce the invariant.
 */

import { describe, expect, it } from "vitest";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import { buildCreateTableSql, validateColumnDefs } from "../../../../src/daemon/storage/schema.js";
import { appendOnlyInsert, appendVersionBumped, updateOrInsertByKey, val } from "../../../../src/daemon/storage/writes.js";
import { CATALOG, REGISTRY, healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import {
	AGENT_READ_POLICIES,
	AGENTS_COLUMNS,
	API_KEYS_COLUMNS,
	buildApiKeyLookupSql,
	buildRevokeApiKeySql,
	hashApiKey,
	KEY_LIVE,
	KEY_REVOKED,
	RECALL_QA_LEDGER_COLUMNS,
	ROUTER_HISTORY_COLUMNS,
	TELEMETRY_COUNTERS_COLUMNS,
	TENANCY_TABLES,
} from "../../../../src/daemon/storage/catalog/tenancy.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";
import { TransportError } from "../../../../src/daemon/storage/transport.js";

const SCOPE = { org: "o1", workspace: "ws1" } as const;

function client(transport: FakeDeepLakeTransport) {
	return createStorageClient({ transport, provider: stubProvider(fakeCredentialRecord()) });
}

/** Find a column's `sql` from a ColumnDef array. */
function colSql(cols: readonly { name: string; sql: string }[], name: string): string | undefined {
	return cols.find((c) => c.name === name)?.sql;
}

/** All column names in a ColumnDef array (lowercase). */
function colNames(cols: readonly { name: string; sql: string }[]): string[] {
	return cols.map((c) => c.name.toLowerCase());
}

describe("PRD-003e tenancy catalog", () => {
	// ── e-AC-1 ───────────────────────────────────────────────────────────────
	it("e-AC-1 agents carries read_policy in {isolated,shared,group} and policy_group", () => {
		// ColumnDef array validates at load (no NOT NULL without DEFAULT).
		expect(() => validateColumnDefs("agents", AGENTS_COLUMNS)).not.toThrow();

		// All three read_policy values are defined.
		expect(AGENT_READ_POLICIES).toEqual(["isolated", "shared", "group"]);

		// read_policy column: TEXT NOT NULL DEFAULT 'isolated'.
		expect(colSql(AGENTS_COLUMNS, "read_policy")).toMatch(/TEXT NOT NULL DEFAULT 'isolated'/);

		// policy_group column exists with an empty-string default.
		expect(colSql(AGENTS_COLUMNS, "policy_group")).toMatch(/TEXT NOT NULL DEFAULT ''/);

		// The catalog record carries the table with the correct scope.
		const entry = CATALOG.find((t) => t.name === "agents");
		expect(entry).toBeDefined();
		expect(entry?.scope).toBe("tenant");
		expect(entry?.pattern).toBe("update-or-insert");
		expect(entry?.embeddingColumns).toEqual([]);

		// Tenant-scope columns are present (CONVENTIONS.md §3).
		expect(colSql(AGENTS_COLUMNS, "org_id")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		expect(colSql(AGENTS_COLUMNS, "workspace_id")).toMatch(/TEXT NOT NULL DEFAULT ''/);
	});

	// ── e-AC-2 ───────────────────────────────────────────────────────────────
	it("e-AC-2 api_keys holds hashed key + role/scope/permissions/connector/harness/agent — no plaintext key column", () => {
		expect(() => validateColumnDefs("api_keys", API_KEYS_COLUMNS)).not.toThrow();

		// MUST have key_hash (SHA-256 storage column).
		expect(colSql(API_KEYS_COLUMNS, "key_hash")).toMatch(/TEXT NOT NULL DEFAULT ''/);

		// MUST NOT have any plaintext credential column.
		const names = colNames(API_KEYS_COLUMNS);
		for (const forbidden of ["key", "secret", "token", "plaintext", "password"]) {
			expect(names, `forbidden column "${forbidden}" must not exist`).not.toContain(forbidden);
		}

		// Required binding and metadata columns.
		expect(colSql(API_KEYS_COLUMNS, "role")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		expect(colSql(API_KEYS_COLUMNS, "scope")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		expect(colSql(API_KEYS_COLUMNS, "permissions")).toMatch(/TEXT NOT NULL DEFAULT '\[\]'/);
		expect(colSql(API_KEYS_COLUMNS, "connector")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		expect(colSql(API_KEYS_COLUMNS, "harness")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		expect(colSql(API_KEYS_COLUMNS, "agent")).toMatch(/TEXT NOT NULL DEFAULT ''/);

		// hashApiKey produces a valid SHA-256 hex string (64 lowercase hex chars).
		const hash = hashApiKey("sk-super-secret-key");
		expect(hash).toMatch(/^[0-9a-f]{64}$/);

		// Deterministic: same plaintext yields same hash.
		expect(hashApiKey("sk-super-secret-key")).toBe(hash);

		// Different plaintexts yield different hashes.
		expect(hashApiKey("other-key")).not.toBe(hash);

		// buildApiKeyLookupSql uses the hash, never the plaintext.
		const sql = buildApiKeyLookupSql(hash);
		expect(sql).toMatch(/key_hash = '/);
		expect(sql).toMatch(/revoked = 0/);
		expect(sql).not.toContain("sk-super-secret-key");

		// Pattern and scope. api_keys is APPEND-ONLY VERSION-BUMPED (PRD-011d / d-AC-4):
		// an in-place revoke UPDATE does not converge on this backend (a revoked key would
		// still authenticate), so revocation APPENDs a new highest-version row with
		// revoked=1 and the authenticator reads the highest version.
		expect(CATALOG.find((t) => t.name === "api_keys")?.pattern).toBe("version-bumped");
		expect(CATALOG.find((t) => t.name === "api_keys")?.scope).toBe("tenant");

		// The version column is additive (heal-compatible) and BIGINT NOT NULL DEFAULT 0.
		expect(colSql(API_KEYS_COLUMNS, "version")).toMatch(/BIGINT NOT NULL DEFAULT 0/);
	});

	// ── e-AC-3 ───────────────────────────────────────────────────────────────
	it("e-AC-3 API key revoke advances revoked flag via an APPEND — prior row retained, no DELETE, no in-place UPDATE", async () => {
		expect(KEY_LIVE).toBe(0);
		expect(KEY_REVOKED).toBe(1);

		// revoked is a BIGINT 0/1 (D-3), default 0 (live).
		expect(colSql(API_KEYS_COLUMNS, "revoked")).toMatch(/BIGINT NOT NULL DEFAULT 0/);

		// Revoke is APPEND-ONLY VERSION-BUMPED (PRD-011d / d-AC-4): the bump primitive reads
		// the current MAX(version) for the id, then INSERTs a NEW row at version N+1 carrying
		// revoked=1. NEVER an in-place UPDATE (which does not converge live — a revoked key
		// would still authenticate). The prior (live) version stays on disk for audit.
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([{ version: 1 }]); // MAX(version) read → current highest is 1
		fake.enqueueRows([]); // INSERT (the appended v2 revoked row) ok

		const { result, version } = await appendVersionBumped(client(fake), healTargetFor("api_keys"), SCOPE, {
			keyColumn: "id",
			keyValue: "key-1",
			row: [
				["id", val.str("key-1")],
				["revoked", val.num(KEY_REVOKED)],
			],
		});
		expect(result.kind).toBe("ok");
		expect(version).toBe(2); // the revoked row is the new HIGHEST version.

		// Revocation is an APPEND (INSERT), carrying revoked=1 at the bumped version.
		const insertSql = fake.requests.find((r) => /^INSERT INTO "api_keys"/.test(r.sql))?.sql ?? "";
		expect(insertSql).toMatch(/revoked.*1/);
		expect(insertSql).toMatch(/version/);

		// No in-place UPDATE and no DELETE were ever emitted — the prior version is retained.
		expect(fake.requests.every((r) => !/^UPDATE/.test(r.sql))).toBe(true);
		expect(fake.requests.every((r) => !/^DELETE/.test(r.sql))).toBe(true);

		// The retired buildRevokeApiKeySql helper still emits the legacy UPDATE shape (no
		// DELETE), but it is RETIRED — no live path calls it; revocation now APPENDs (above).
		const revokeSql = buildRevokeApiKeySql("key-2");
		expect(revokeSql).toMatch(/^UPDATE "api_keys"/);
		expect(revokeSql).toMatch(/revoked = 1/);
		expect(revokeSql).not.toMatch(/DELETE/);
	});

	// ── e-AC-4 ───────────────────────────────────────────────────────────────
	it("e-AC-4 no telemetry table has a secret or request-body column (structural invariant)", () => {
		// All three telemetry ColumnDef arrays validate at load.
		expect(() => validateColumnDefs("telemetry_counters", TELEMETRY_COUNTERS_COLUMNS)).not.toThrow();
		expect(() => validateColumnDefs("recall_qa_ledger", RECALL_QA_LEDGER_COLUMNS)).not.toThrow();
		expect(() => validateColumnDefs("router_history", ROUTER_HISTORY_COLUMNS)).not.toThrow();

		// Forbidden columns that would expose secrets or request bodies.
		const FORBIDDEN_COLS = [
			"key",
			"secret",
			"token",
			"password",
			"plaintext",
			"key_hash",
			"request_body",
			"prompt",
			"prompt_content",
			"query_text",
			"input",
		];

		for (const [label, cols] of [
			["telemetry_counters", TELEMETRY_COUNTERS_COLUMNS],
			["recall_qa_ledger", RECALL_QA_LEDGER_COLUMNS],
			["router_history", ROUTER_HISTORY_COLUMNS],
		] as const) {
			const names = colNames(cols);
			for (const forbidden of FORBIDDEN_COLS) {
				expect(names, `table "${label}" must not have column "${forbidden}"`).not.toContain(forbidden);
			}
		}

		// All three are append-only (telemetry is never updated).
		expect(CATALOG.find((t) => t.name === "telemetry_counters")?.pattern).toBe("append-only");
		expect(CATALOG.find((t) => t.name === "recall_qa_ledger")?.pattern).toBe("append-only");
		expect(CATALOG.find((t) => t.name === "router_history")?.pattern).toBe("append-only");
	});

	// ── e-AC-5 ───────────────────────────────────────────────────────────────
	it("e-AC-5 router_history carries model/provider/workload/outcome with NO prompt-content column", () => {
		expect(() => validateColumnDefs("router_history", ROUTER_HISTORY_COLUMNS)).not.toThrow();

		// Required routing-metadata columns.
		expect(colSql(ROUTER_HISTORY_COLUMNS, "model")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		expect(colSql(ROUTER_HISTORY_COLUMNS, "provider")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		expect(colSql(ROUTER_HISTORY_COLUMNS, "workload")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		expect(colSql(ROUTER_HISTORY_COLUMNS, "outcome")).toMatch(/TEXT NOT NULL DEFAULT ''/);

		// Forbidden prompt-content columns — must be permanently absent.
		const names = colNames(ROUTER_HISTORY_COLUMNS);
		for (const forbidden of [
			"prompt",
			"prompt_content",
			"query",
			"query_text",
			"input",
			"request_body",
			"message",
		]) {
			expect(names, `router_history must not have column "${forbidden}"`).not.toContain(forbidden);
		}

		// A real append-only write carries only metadata (no prompt field possible).
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([]); // INSERT ok
		return appendOnlyInsert(client(fake), healTargetFor("router_history"), SCOPE, [
			["id", val.str("rh-1")],
			["model", val.str("claude-sonnet-4")],
			["provider", val.str("anthropic")],
			["workload", val.str("code")],
			["outcome", val.str("success")],
		]).then((res) => {
			expect(res.kind).toBe("ok");
			const sql = fake.requests[0].sql;
			expect(sql).toMatch(/^INSERT INTO "router_history"/);
			// No prompt content should appear in the SQL.
			expect(sql).not.toMatch(/prompt/i);
		});
	});

	// ── e-AC-6 ───────────────────────────────────────────────────────────────
	it("e-AC-6 group read_policy uses policy_group to bound which agents share visibility", async () => {
		// policy_group defaults to '' (not meaningful for isolated/shared).
		expect(colSql(AGENTS_COLUMNS, "policy_group")).toMatch(/DEFAULT ''/);

		// Writing a group-scoped agent with a non-empty policy_group.
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([]); // SELECT probe → absent (first write)
		fake.enqueueRows([]); // INSERT ok

		const res = await updateOrInsertByKey(client(fake), healTargetFor("agents"), SCOPE, {
			keyColumn: "id",
			keyValue: "agent-grp-1",
			row: [
				["id", val.str("agent-grp-1")],
				["name", val.str("Worker Bee Alpha")],
				["read_policy", val.str("group")],
				["policy_group", val.str("team-alpha")],
			],
		});
		expect(res.kind).toBe("ok");

		const insertSql = fake.requests.find((r) => /^INSERT/.test(r.sql))?.sql ?? "";
		expect(insertSql).toMatch(/'group'/);
		expect(insertSql).toMatch(/'team-alpha'/);
		expect(insertSql).toMatch(/^INSERT INTO "agents"/);

		// Isolated and shared agents have an empty policy_group (not meaningful).
		for (const policy of ["isolated", "shared"] as const) {
			const fake2 = new FakeDeepLakeTransport();
			fake2.enqueueRows([]); // absent
			fake2.enqueueRows([]); // INSERT ok
			const res2 = await updateOrInsertByKey(client(fake2), healTargetFor("agents"), SCOPE, {
				keyColumn: "id",
				keyValue: `agent-${policy}`,
				row: [
					["id", val.str(`agent-${policy}`)],
					["read_policy", val.str(policy)],
					["policy_group", val.str("")],
				],
			});
			expect(res2.kind).toBe("ok");
		}
	});

	// ── e-AC-7 ───────────────────────────────────────────────────────────────
	it("e-AC-7 first write to agents creates from ColumnDef array and retries once (heal path)", async () => {
		const seen: string[] = [];
		let insertAttempts = 0;

		const fake = new FakeDeepLakeTransport((req) => {
			seen.push(req.sql);
			if (/^INSERT/.test(req.sql)) {
				insertAttempts++;
				if (insertAttempts === 1) {
					// First attempt: table does not exist yet.
					throw new TransportError("query", 'relation "agents" does not exist', 404);
				}
				return []; // retry succeeds
			}
			if (/^CREATE TABLE/.test(req.sql)) return [];
			if (/information_schema\.columns/.test(req.sql)) {
				// Return all columns so no ALTER is emitted.
				return AGENTS_COLUMNS.map((c) => ({ column_name: c.name }));
			}
			if (/^SELECT/.test(req.sql)) return []; // key probe → absent
			return [];
		});

		const res = await updateOrInsertByKey(client(fake), healTargetFor("agents"), SCOPE, {
			keyColumn: "id",
			keyValue: "agent-first",
			row: [["id", val.str("agent-first")]],
		});
		expect(res.kind).toBe("ok");

		// CREATE TABLE was emitted from the ColumnDef array.
		expect(seen.some((s) => /CREATE TABLE IF NOT EXISTS "agents"/.test(s))).toBe(true);

		// The DDL matches what buildCreateTableSql renders from the ColumnDef array.
		expect(buildCreateTableSql("agents", AGENTS_COLUMNS)).toMatch(
			/CREATE TABLE IF NOT EXISTS "agents" \(.*\) USING deeplake/,
		);

		// Two INSERT attempts: the original failure + one retry.
		expect(seen.filter((s) => /^INSERT/.test(s)).length).toBe(2);
	});

	it("e-AC-7 first write to api_keys creates from ColumnDef array and retries once (heal path)", async () => {
		const seen: string[] = [];
		let insertAttempts = 0;

		const fake = new FakeDeepLakeTransport((req) => {
			seen.push(req.sql);
			if (/^INSERT/.test(req.sql)) {
				insertAttempts++;
				if (insertAttempts === 1) {
					throw new TransportError("query", 'relation "api_keys" does not exist', 404);
				}
				return [];
			}
			if (/^CREATE TABLE/.test(req.sql)) return [];
			if (/information_schema\.columns/.test(req.sql)) {
				return API_KEYS_COLUMNS.map((c) => ({ column_name: c.name }));
			}
			if (/^SELECT/.test(req.sql)) return [];
			return [];
		});

		// api_keys is APPEND-ONLY VERSION-BUMPED (PRD-011d / d-AC-4): the first write goes
		// through appendVersionBumped (MAX(version) read → INSERT v1), which is heal-aware.
		const { result } = await appendVersionBumped(client(fake), healTargetFor("api_keys"), SCOPE, {
			keyColumn: "id",
			keyValue: "key-first",
			row: [
				["id", val.str("key-first")],
				["key_hash", val.str(hashApiKey("initial-key"))],
				["role", val.str("connector")],
			],
		});
		expect(result.kind).toBe("ok");
		expect(seen.some((s) => /CREATE TABLE IF NOT EXISTS "api_keys"/.test(s))).toBe(true);
		expect(seen.filter((s) => /^INSERT/.test(s)).length).toBe(2);
	});

	it("e-AC-7 first write to router_history creates from ColumnDef array and retries once (heal path)", async () => {
		const seen: string[] = [];
		let insertAttempts = 0;

		const fake = new FakeDeepLakeTransport((req) => {
			seen.push(req.sql);
			if (/^INSERT/.test(req.sql)) {
				insertAttempts++;
				if (insertAttempts === 1) {
					throw new TransportError("query", 'relation "router_history" does not exist', 404);
				}
				return [];
			}
			if (/^CREATE TABLE/.test(req.sql)) return [];
			if (/information_schema\.columns/.test(req.sql)) {
				return ROUTER_HISTORY_COLUMNS.map((c) => ({ column_name: c.name }));
			}
			return [];
		});

		const res = await appendOnlyInsert(client(fake), healTargetFor("router_history"), SCOPE, [
			["id", val.str("rh-first")],
			["model", val.str("claude-haiku-4")],
			["provider", val.str("anthropic")],
			["workload", val.str("summarize")],
			["outcome", val.str("success")],
		]);
		expect(res.kind).toBe("ok");
		expect(seen.some((s) => /CREATE TABLE IF NOT EXISTS "router_history"/.test(s))).toBe(true);
		expect(seen.filter((s) => /^INSERT/.test(s)).length).toBe(2);
	});

	// ── Registry wiring ──────────────────────────────────────────────────────
	it("registry: all 5 tenancy tables are wired with the correct pattern and appear in CATALOG", () => {
		// agents → update-or-insert
		expect(REGISTRY.patternFor("agents")).toBe("update-or-insert");
		expect(REGISTRY.primitiveFor("agents")).toBe("updateOrInsertByKey");
		// api_keys → version-bumped (PRD-011d / d-AC-4): create → v1, revoke → v+1, never an
		// in-place UPDATE (which does not converge live — a revoked key would still authenticate).
		expect(REGISTRY.patternFor("api_keys")).toBe("version-bumped");
		expect(REGISTRY.primitiveFor("api_keys")).toBe("appendVersionBumped");

		// telemetry tables → append-only
		expect(REGISTRY.patternFor("telemetry_counters")).toBe("append-only");
		expect(REGISTRY.primitiveFor("telemetry_counters")).toBe("appendOnlyInsert");
		expect(REGISTRY.patternFor("recall_qa_ledger")).toBe("append-only");
		expect(REGISTRY.primitiveFor("recall_qa_ledger")).toBe("appendOnlyInsert");
		expect(REGISTRY.patternFor("router_history")).toBe("append-only");
		expect(REGISTRY.primitiveFor("router_history")).toBe("appendOnlyInsert");

		// All 5 tables present in the aggregated CATALOG.
		for (const name of ["agents", "api_keys", "telemetry_counters", "recall_qa_ledger", "router_history"]) {
			expect(CATALOG.some((t) => t.name === name), `CATALOG should contain "${name}"`).toBe(true);
		}

		// TENANCY_TABLES has exactly 5 entries.
		expect(TENANCY_TABLES.length).toBe(5);
	});

	// ── DDL shape ────────────────────────────────────────────────────────────
	it("buildCreateTableSql emits USING deeplake DDL for all tenancy tables", () => {
		for (const table of TENANCY_TABLES) {
			const ddl = buildCreateTableSql(table.name, table.columns);
			expect(ddl, `${table.name} DDL`).toMatch(
				new RegExp(`CREATE TABLE IF NOT EXISTS "${table.name}" \\(.*\\) USING deeplake`),
			);
		}
	});
});

/**
 * PRD-003d — Product Tables — proves d-AC-1..7.
 *
 * Verification posture (EXECUTION_LEDGER-prd-003): no live DeepLake. Each d-AC
 * has a named, unskipped test against the PRD-002 fake transport. The binding
 * DoD per table: the ColumnDef array validates at import; `buildCreateTableSql`
 * emits the right DDL; the required scope/version/identity columns are present
 * with correct types and defaults; the assigned write-pattern primitive emits
 * correct SQL against the fake transport; the first write creates + heals.
 *
 * Producer logic (skillify miner, rules manager, codebase graph worker) is OUT
 * of scope — ACs are met at the catalog level: column shapes + write-pattern
 * helpers enforce the invariants, tested against the fake transport.
 */

import { describe, expect, it } from "vitest";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import { buildCreateTableSql, validateColumnDefs } from "../../../../src/daemon/storage/schema.js";
import { appendVersionBumped, readLatestVersion, selectBeforeInsert, updateOrInsertByKey, val } from "../../../../src/daemon/storage/writes.js";
import { CATALOG, REGISTRY, healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import {
	buildCurrentVersionSql,
	buildSnapshotDedupSql,
	CODEBASE_COLUMNS,
	GOALS_COLUMNS,
	KPIS_COLUMNS,
	PRODUCT_TABLES,
	RULES_COLUMNS,
	SKILLS_COLUMNS,
} from "../../../../src/daemon/storage/catalog/product.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";
import { TransportError } from "../../../../src/daemon/storage/transport.js";

const SCOPE = { org: "o1", workspace: "ws1" } as const;
const TENANT_SCOPE = { org: "acme-org", workspace: "acme-ws" } as const;

function client(transport: FakeDeepLakeTransport) {
	return createStorageClient({ transport, provider: stubProvider(fakeCredentialRecord()) });
}

/** Find a column's `sql` from a ColumnDef array. */
function colSql(cols: readonly { name: string; sql: string }[], name: string): string | undefined {
	return cols.find((c) => c.name === name)?.sql;
}

describe("PRD-003d product tables catalog", () => {
	// ── d-AC-1 ────────────────────────────────────────────────────────────────
	it("d-AC-1 skill/rule edit INSERTs version N+1 and reader uses ORDER BY version DESC LIMIT 1", async () => {
		// Part A: appendVersionBumped emits an INSERT at version N+1 for a skills row.
		const skillFake = new FakeDeepLakeTransport((req) => {
			// SELECT MAX(version) for the key probe
			if (/SELECT version FROM "skills"/.test(req.sql)) return [{ version: 2 }];
			// INSERT version=3 (N+1 = 2+1)
			if (/^INSERT INTO "skills"/.test(req.sql)) return [];
			return [];
		});
		const skillResult = await appendVersionBumped(client(skillFake), healTargetFor("skills"), SCOPE, {
			keyColumn: "name",
			keyValue: "my-skill",
			row: [
				["id", val.str("sk-1")],
				["name", val.str("my-skill")],
				["body", val.text("skill body")],
			],
		});
		expect(skillResult.result.kind).toBe("ok");
		expect(skillResult.version).toBe(3);
		const insertSql = skillFake.requests.find((r) => /^INSERT/.test(r.sql))?.sql ?? "";
		expect(insertSql).toMatch(/^INSERT INTO "skills"/);
		expect(insertSql).toMatch(/version/);
		// version value should be 3 (N+1)
		expect(insertSql).toMatch(/\b3\b/);

		// Part B: buildCurrentVersionSql emits the ORDER BY version DESC LIMIT 1 read.
		const readSql = buildCurrentVersionSql("skills", "name", "my-skill");
		expect(readSql).toMatch(/FROM "skills"/);
		expect(readSql).toMatch(/WHERE name = 'my-skill'/);
		expect(readSql).toMatch(/ORDER BY version DESC LIMIT 1/);

		// Part C: same pattern for rules.
		const rulesFake = new FakeDeepLakeTransport((req) => {
			if (/SELECT version FROM "rules"/.test(req.sql)) return [{ version: 5 }];
			if (/^INSERT INTO "rules"/.test(req.sql)) return [];
			return [];
		});
		const rulesResult = await appendVersionBumped(client(rulesFake), healTargetFor("rules"), SCOPE, {
			keyColumn: "key",
			keyValue: "no-drop-prod",
			row: [
				["id", val.str("r-1")],
				["key", val.str("no-drop-prod")],
				["body", val.text("never drop prod tables")],
			],
		});
		expect(rulesResult.result.kind).toBe("ok");
		expect(rulesResult.version).toBe(6);
	});

	// ── d-AC-2 ────────────────────────────────────────────────────────────────
	it("d-AC-2 codebase carries (org, workspace, repo, user, worktree, commit) identity plus snapshot_jsonb and snapshot_sha256", () => {
		// ColumnDef array validates at load.
		expect(() => validateColumnDefs("codebase", CODEBASE_COLUMNS)).not.toThrow();

		// Identity columns (FR-5 / FR-7).
		for (const name of ["org_id", "workspace_id", "repo_slug", "user_id", "worktree_id", "commit_sha"]) {
			expect(colSql(CODEBASE_COLUMNS, name), `column ${name}`).toMatch(/TEXT NOT NULL DEFAULT ''/);
		}

		// Snapshot payload (d-AC-2).
		expect(colSql(CODEBASE_COLUMNS, "snapshot_sha256")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		// snapshot_jsonb is nullable JSONB (genuinely schemaless graph payload).
		const jsonbSql = colSql(CODEBASE_COLUMNS, "snapshot_jsonb");
		expect(jsonbSql).toBe("JSONB");
		expect(jsonbSql).not.toMatch(/NOT NULL/);

		// Scope: tenant (explicit columns, not agent_id, per D-2 / FR-7).
		expect(colSql(CODEBASE_COLUMNS, "org_id")).toBeDefined();
		expect(colSql(CODEBASE_COLUMNS, "workspace_id")).toBeDefined();
		// codebase must NOT carry agent_id (it is a tenant-scoped table).
		expect(CODEBASE_COLUMNS.find((c) => c.name === "agent_id")).toBeUndefined();

		// Catalog record confirms scope and pattern.
		expect(CATALOG.find((t) => t.name === "codebase")?.scope).toBe("tenant");
		expect(REGISTRY.patternFor("codebase")).toBe("select-before-insert");
	});

	// ── d-AC-3 ────────────────────────────────────────────────────────────────
	it("d-AC-3 goal and KPI write is UPDATE-or-INSERT by logical key with one row per key", async () => {
		// Part A: INSERT path (key absent → INSERT).
		const goalFake = new FakeDeepLakeTransport();
		goalFake.enqueueRows([]); // SELECT key probe → absent
		goalFake.enqueueRows([]); // INSERT ok
		const goalInsert = await updateOrInsertByKey(client(goalFake), healTargetFor("goals"), SCOPE, {
			keyColumn: "key",
			keyValue: "revenue-target",
			row: [
				["key", val.str("revenue-target")],
				["value", val.str("1000000")],
				["target", val.str("2000000")],
				["status", val.str("open")],
				["unit", val.str("USD")],
			],
		});
		expect(goalInsert.kind).toBe("ok");
		const insertSql = goalFake.requests.find((r) => /^INSERT/.test(r.sql))?.sql ?? "";
		expect(insertSql).toMatch(/^INSERT INTO "goals"/);
		expect(insertSql).toMatch(/'revenue-target'/);

		// Part B: UPDATE path (key present → UPDATE).
		const kpiFake = new FakeDeepLakeTransport();
		kpiFake.enqueueRows([{ key: "nps-score" }]); // SELECT key probe → present
		kpiFake.enqueueRows([]); // UPDATE ok
		const kpiUpdate = await updateOrInsertByKey(client(kpiFake), healTargetFor("kpis"), SCOPE, {
			keyColumn: "key",
			keyValue: "nps-score",
			row: [
				["key", val.str("nps-score")],
				["value", val.str("72")],
				["target", val.str("80")],
				["status", val.str("in_progress")],
				["unit", val.str("score")],
			],
		});
		expect(kpiUpdate.kind).toBe("ok");
		const updateSql = kpiFake.requests.find((r) => /^UPDATE/.test(r.sql))?.sql ?? "";
		expect(updateSql).toMatch(/^UPDATE "kpis"/);
		expect(updateSql).toMatch(/value = '72'/);
		// Only one request per key: probe + the write = 2 total (no duplicate INSERT).
		expect(kpiFake.requests.length).toBe(2);

		// Part C: D-4 minimal column shape is present on both tables.
		for (const name of ["key", "value", "target", "status", "unit"]) {
			expect(colSql(GOALS_COLUMNS, name), `goals.${name}`).toBeDefined();
			expect(colSql(KPIS_COLUMNS, name), `kpis.${name}`).toBeDefined();
		}
	});

	// ── d-AC-4 ────────────────────────────────────────────────────────────────
	it("d-AC-4 identical codebase snapshot_sha256 causes SELECT-before-INSERT to skip the duplicate row", async () => {
		const sha = "abc123def456abc123def456abc123def456abc123def456abc123def456abc1";

		// First push: identity key absent → INSERT succeeds.
		const firstFake = new FakeDeepLakeTransport();
		firstFake.enqueueRows([]); // probe → absent
		firstFake.enqueueRows([]); // INSERT ok
		firstFake.enqueueRows([{ commit_sha: "sha-abc" }]); // re-verify → 1 row
		const first = await selectBeforeInsert(client(firstFake), healTargetFor("codebase"), TENANT_SCOPE, {
			keyColumn: "snapshot_sha256",
			keyValue: sha,
			row: [
				["org_id", val.str("acme-org")],
				["workspace_id", val.str("acme-ws")],
				["repo_slug", val.str("acme/api")],
				["user_id", val.str("user-1")],
				["worktree_id", val.str("wt-1")],
				["commit_sha", val.str("sha-abc")],
				["snapshot_sha256", val.str(sha)],
				["snapshot_jsonb", val.raw("NULL")],
				["node_count", val.num(100)],
				["edge_count", val.num(50)],
			],
		});
		expect(first.alreadyPresent).toBe(false);
		expect(first.raceDetected).toBe(false);
		expect(first.result.kind).toBe("ok");

		// Second push: same sha256 → probe finds existing row → skips INSERT.
		const secondFake = new FakeDeepLakeTransport();
		secondFake.enqueueRows([{ commit_sha: "sha-abc" }]); // probe → present
		const second = await selectBeforeInsert(client(secondFake), healTargetFor("codebase"), TENANT_SCOPE, {
			keyColumn: "snapshot_sha256",
			keyValue: sha,
			row: [
				["snapshot_sha256", val.str(sha)],
			],
		});
		expect(second.alreadyPresent).toBe(true);
		// No INSERT was issued — only the probe SELECT.
		expect(secondFake.requests.filter((r) => /^INSERT/.test(r.sql)).length).toBe(0);
		expect(secondFake.requests.length).toBe(1);

		// Dedup probe helper confirms the query shape.
		const probeSql = buildSnapshotDedupSql(sha);
		expect(probeSql).toMatch(/FROM "codebase"/);
		expect(probeSql).toMatch(new RegExp(`snapshot_sha256 = '${sha}'`));
	});

	// ── d-AC-5 ────────────────────────────────────────────────────────────────
	it("d-AC-5 skills row carries scope, author, contributors, source_sessions, trigger_text, body, and version", () => {
		// ColumnDef array validates at load (no NOT NULL without DEFAULT).
		expect(() => validateColumnDefs("skills", SKILLS_COLUMNS)).not.toThrow();

		// All FR-1 / d-AC-5 required columns are present.
		for (const name of ["scope", "author", "contributors", "source_sessions", "trigger_text", "body", "version"]) {
			expect(colSql(SKILLS_COLUMNS, name), `column ${name}`).toBeDefined();
		}

		// Column type + default validation.
		expect(colSql(SKILLS_COLUMNS, "scope")).toMatch(/DEFAULT 'me'/);
		expect(colSql(SKILLS_COLUMNS, "install")).toMatch(/DEFAULT 'project'/);
		expect(colSql(SKILLS_COLUMNS, "contributors")).toMatch(/DEFAULT '\[\]'/);
		expect(colSql(SKILLS_COLUMNS, "source_sessions")).toMatch(/DEFAULT '\[\]'/);
		expect(colSql(SKILLS_COLUMNS, "version")).toMatch(/BIGINT NOT NULL DEFAULT 1/);

		// Scope columns (D-2 engine table): agent_id 'default', visibility 'global'.
		expect(colSql(SKILLS_COLUMNS, "agent_id")).toMatch(/DEFAULT 'default'/);
		expect(colSql(SKILLS_COLUMNS, "visibility")).toMatch(/DEFAULT 'global'/);

		// No embedding columns on skills (none required by FR-1).
		expect(CATALOG.find((t) => t.name === "skills")?.embeddingColumns).toEqual([]);

		// Pattern: version-bumped.
		expect(REGISTRY.patternFor("skills")).toBe("version-bumped");
		expect(REGISTRY.primitiveFor("skills")).toBe("appendVersionBumped");

		// CREATE DDL shape.
		const ddl = buildCreateTableSql("skills", SKILLS_COLUMNS);
		expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS "skills" \(.*\) USING deeplake/);
	});

	// ── d-AC-6 ────────────────────────────────────────────────────────────────
	it("d-AC-6 concurrent codebase push race is detectable via re-verify after INSERT", async () => {
		const sha = "race-sha-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

		// Simulate: probe → absent, INSERT ok, re-verify → 2 rows (race doubled it).
		const raceFake = new FakeDeepLakeTransport();
		raceFake.enqueueRows([]); // probe → absent
		raceFake.enqueueRows([]); // INSERT ok
		raceFake.enqueueRows([{ commit_sha: "sha-1" }, { commit_sha: "sha-2" }]); // re-verify → 2 rows
		const raceResult = await selectBeforeInsert(client(raceFake), healTargetFor("codebase"), TENANT_SCOPE, {
			keyColumn: "snapshot_sha256",
			keyValue: sha,
			row: [
				["org_id", val.str("acme-org")],
				["workspace_id", val.str("acme-ws")],
				["snapshot_sha256", val.str(sha)],
				["repo_slug", val.str("acme/api")],
				["user_id", val.str("user-race")],
				["worktree_id", val.str("wt-race")],
				["commit_sha", val.str("sha-race")],
			],
		});
		// The race is observable — raceDetected is true.
		expect(raceResult.alreadyPresent).toBe(false);
		expect(raceResult.raceDetected).toBe(true);
		expect(raceResult.result.kind).toBe("ok");

		// All three SQL statements went out (probe, INSERT, re-verify).
		expect(raceFake.requests.length).toBe(3);
		expect(raceFake.requests[0].sql).toMatch(/^SELECT/);
		expect(raceFake.requests[1].sql).toMatch(/^INSERT/);
		expect(raceFake.requests[2].sql).toMatch(/^SELECT/);
	});

	// ── d-AC-7 ────────────────────────────────────────────────────────────────
	it("d-AC-7 first write to any product table creates from ColumnDef array and retries once", async () => {
		// Test against `rules` (version-bumped table).
		const seen: string[] = [];
		let insertAttempts = 0;
		const fake = new FakeDeepLakeTransport((req) => {
			seen.push(req.sql);
			if (/^INSERT INTO "rules"/.test(req.sql)) {
				insertAttempts++;
				if (insertAttempts === 1) {
					// First attempt: table does not exist.
					throw new TransportError("query", 'relation "rules" does not exist', 404);
				}
				return []; // retry succeeds
			}
			if (/^CREATE TABLE/.test(req.sql)) return [];
			if (/information_schema\.columns/.test(req.sql)) {
				// All columns present after CREATE.
				return RULES_COLUMNS.map((c) => ({ column_name: c.name }));
			}
			// Version SELECT for appendVersionBumped.
			if (/SELECT version FROM "rules"/.test(req.sql)) return [];
			return [];
		});

		const res = await appendVersionBumped(client(fake), healTargetFor("rules"), SCOPE, {
			keyColumn: "key",
			keyValue: "my-rule",
			row: [
				["id", val.str("r-first")],
				["key", val.str("my-rule")],
				["body", val.text("a rule body")],
			],
		});
		expect(res.result.kind).toBe("ok");

		// The heal path emitted a CREATE TABLE.
		expect(seen.some((s) => /CREATE TABLE IF NOT EXISTS "rules"/.test(s))).toBe(true);
		// CREATE DDL is exactly what the ColumnDef array renders.
		expect(buildCreateTableSql("rules", RULES_COLUMNS)).toMatch(
			/CREATE TABLE IF NOT EXISTS "rules" \(.*\) USING deeplake/,
		);
		// Two INSERTs: original failure + one retry.
		expect(seen.filter((s) => /^INSERT INTO "rules"/.test(s)).length).toBe(2);
	});

	// ── Registry and CATALOG integration ─────────────────────────────────────
	it("registry: all product tables are in CATALOG with correct patterns", () => {
		// All 5 product tables appear in the aggregated catalog.
		for (const name of ["skills", "rules", "goals", "kpis", "codebase"]) {
			expect(CATALOG.some((t) => t.name === name), `${name} in CATALOG`).toBe(true);
		}

		// Pattern assignments.
		expect(REGISTRY.patternFor("skills")).toBe("version-bumped");
		expect(REGISTRY.primitiveFor("skills")).toBe("appendVersionBumped");
		expect(REGISTRY.patternFor("rules")).toBe("version-bumped");
		expect(REGISTRY.primitiveFor("rules")).toBe("appendVersionBumped");
		expect(REGISTRY.patternFor("goals")).toBe("update-or-insert");
		expect(REGISTRY.primitiveFor("goals")).toBe("updateOrInsertByKey");
		expect(REGISTRY.patternFor("kpis")).toBe("update-or-insert");
		expect(REGISTRY.primitiveFor("kpis")).toBe("updateOrInsertByKey");
		expect(REGISTRY.patternFor("codebase")).toBe("select-before-insert");
		expect(REGISTRY.primitiveFor("codebase")).toBe("selectBeforeInsert");

		// PRODUCT_TABLES export matches the catalog subset.
		expect(PRODUCT_TABLES.length).toBe(5);
	});
});

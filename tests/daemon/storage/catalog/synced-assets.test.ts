/**
 * PRD-033a — `synced_assets` table — proves a-AC-6 (the synced-asset INSERT shape)
 * + the catalog wiring.
 *
 * Verification posture (EXECUTION_LEDGER-prd-033): no live DeepLake. The binding
 * DoD: the ColumnDef array validates at import; `buildCreateTableSql` emits the
 * right `USING deeplake` DDL; the required payload/lifecycle/tenancy columns are
 * present with correct types + defaults (every NOT NULL has a DEFAULT); the
 * version-bumped INSERT carries native + canonical + harness + asset_type +
 * version + tombstone + tenancy (asserted against a fake StorageQuery that
 * captures the INSERT); the table flows into CATALOG/REGISTRY and the daemon's
 * CATALOG-derived trusted-table list.
 */

import { describe, expect, it } from "vitest";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import { buildCreateTableSql, validateColumnDefs } from "../../../../src/daemon/storage/schema.js";
import { appendVersionBumped, val } from "../../../../src/daemon/storage/writes.js";
import { CATALOG, REGISTRY, healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import {
	buildCurrentAssetVersionSql,
	SYNCED_ASSETS_COLUMNS,
	SYNCED_ASSETS_TABLE,
	SYNCED_ASSETS_TABLES,
} from "../../../../src/daemon/storage/catalog/synced-assets.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const TENANT_SCOPE = { org: "acme-org", workspace: "acme-ws" } as const;

function client(transport: FakeDeepLakeTransport) {
	return createStorageClient({ transport, provider: stubProvider(fakeCredentialRecord()) });
}

function colSql(cols: readonly { name: string; sql: string }[], name: string): string | undefined {
	return cols.find((c) => c.name === name)?.sql;
}

describe("PRD-033a synced_assets table", () => {
	it("ColumnDef array validates at load and every NOT NULL column has a DEFAULT", () => {
		expect(() => validateColumnDefs("synced_assets", SYNCED_ASSETS_COLUMNS)).not.toThrow();
		// Spot-check the load-bearing column types + defaults (a-AC-6).
		expect(colSql(SYNCED_ASSETS_COLUMNS, "honeycomb_id")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		expect(colSql(SYNCED_ASSETS_COLUMNS, "version")).toMatch(/BIGINT NOT NULL DEFAULT 1/);
		expect(colSql(SYNCED_ASSETS_COLUMNS, "asset_type")).toMatch(/DEFAULT 'skill'/);
		expect(colSql(SYNCED_ASSETS_COLUMNS, "native")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		// canonical is reserved → present, TEXT, DEFAULT '' (D-7).
		expect(colSql(SYNCED_ASSETS_COLUMNS, "canonical")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		expect(colSql(SYNCED_ASSETS_COLUMNS, "tombstone")).toMatch(/DEFAULT 'false'/);
		expect(colSql(SYNCED_ASSETS_COLUMNS, "device_set")).toMatch(/DEFAULT '\[\]'/);
		// Tenancy columns (D-2 tenant scope).
		for (const name of ["org", "workspace", "author", "tier", "style", "content_hash", "harness"]) {
			expect(colSql(SYNCED_ASSETS_COLUMNS, name), `column ${name}`).toBeDefined();
		}
	});

	it("CREATE DDL is `USING deeplake` rendered from the ColumnDef array", () => {
		const ddl = buildCreateTableSql(SYNCED_ASSETS_TABLE, SYNCED_ASSETS_COLUMNS);
		expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS "synced_assets" \(.*\) USING deeplake/);
		expect(ddl).toMatch(/honeycomb_id TEXT NOT NULL DEFAULT ''/);
	});

	it("a-AC-6 synced-asset INSERT carries native+canonical+harness+asset_type+version+tombstone+tenancy", async () => {
		// version-bumped INSERT at N+1 (prior highest = 4 → new row at version 5).
		const fake = new FakeDeepLakeTransport((req) => {
			if (/SELECT version FROM "synced_assets"/.test(req.sql)) return [{ version: 4 }];
			if (/^INSERT INTO "synced_assets"/.test(req.sql)) return [];
			return [];
		});
		const result = await appendVersionBumped(client(fake), healTargetFor(SYNCED_ASSETS_TABLE), TENANT_SCOPE, {
			keyColumn: "honeycomb_id",
			keyValue: "hc_abc",
			row: [
				["honeycomb_id", val.str("hc_abc")],
				["asset_type", val.str("skill")],
				["harness", val.str("claude-code")],
				["native", val.text("---\nname: my-skill\n---\nbody")],
				["canonical", val.text("---\nname: my-skill\n---\nbody")],
				["content_hash", val.str("deadbeef")],
				["tombstone", val.str("false")],
				["tier", val.str("Team")],
				["style", val.str("Repository")],
				["org", val.str("acme-org")],
				["workspace", val.str("acme-ws")],
				["author", val.str("alice")],
				["device_set", val.str("[]")],
				["created_at", val.str("2026-06-21T00:00:00.000Z")],
			],
		});
		expect(result.result.kind).toBe("ok");
		expect(result.version).toBe(5);

		const insertSql = fake.requests.find((r) => /^INSERT/.test(r.sql))?.sql ?? "";
		expect(insertSql).toMatch(/^INSERT INTO "synced_assets"/);
		// Every required column is present in the INSERT.
		for (const col of [
			"honeycomb_id",
			"asset_type",
			"harness",
			"native",
			"canonical",
			"content_hash",
			"version",
			"tombstone",
			"tier",
			"org",
			"workspace",
			"author",
		]) {
			expect(insertSql, `INSERT carries ${col}`).toMatch(new RegExp(`\\b${col}\\b`));
		}
		// Version value is 5 (N+1) and tenancy values are present.
		expect(insertSql).toMatch(/\b5\b/);
		expect(insertSql).toMatch(/'acme-org'/);
		expect(insertSql).toMatch(/'acme-ws'/);
		expect(insertSql).toMatch(/'alice'/);
	});

	it("current-version read uses ORDER BY version DESC LIMIT 1 (highest = current state)", () => {
		const sql = buildCurrentAssetVersionSql("hc_abc");
		expect(sql).toMatch(/FROM "synced_assets"/);
		expect(sql).toMatch(/WHERE honeycomb_id = 'hc_abc'/);
		expect(sql).toMatch(/ORDER BY version DESC LIMIT 1/);
	});

	it("is wired into CATALOG + REGISTRY (version-bumped, tenant) and the trusted-table list", () => {
		expect(CATALOG.some((t) => t.name === SYNCED_ASSETS_TABLE)).toBe(true);
		expect(CATALOG.find((t) => t.name === SYNCED_ASSETS_TABLE)?.scope).toBe("tenant");
		expect(REGISTRY.patternFor(SYNCED_ASSETS_TABLE)).toBe("version-bumped");
		expect(REGISTRY.primitiveFor(SYNCED_ASSETS_TABLE)).toBe("appendVersionBumped");
		expect(SYNCED_ASSETS_TABLES.length).toBe(1);
		// The daemon's trusted-table list is derived from CATALOG, so membership here IS
		// membership in the list the substrate pull (033c) consults.
		const trustedTableNames = CATALOG.map((t) => t.name);
		expect(trustedTableNames).toContain(SYNCED_ASSETS_TABLE);
	});
});

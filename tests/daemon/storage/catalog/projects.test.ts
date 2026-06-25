/**
 * PRD-049a — `projects` registry table — proves the schema shape, the
 * `__unsorted__` reservation + collision guard (049a-AC-6), the match-rule
 * storage, the read-shape builders, and the catalog wiring.
 *
 * Verification posture: no live DeepLake. The binding DoD: the ColumnDef array
 * validates at import; `buildCreateTableSql` emits the right `USING deeplake`
 * DDL; the identity / match-rule / tenancy columns are present with correct
 * types + defaults (every NOT NULL has a DEFAULT); the reserved-inbox collision
 * guard rejects a user-created project that adopts `__unsorted__` by id or name;
 * the list / ensure-unsorted / by-id read shapes route through the SQL guards;
 * the table flows into CATALOG/REGISTRY (update-or-insert, tenant) and the
 * daemon's CATALOG-derived trusted-table list.
 */

import { describe, expect, it } from "vitest";
import { buildCreateTableSql, validateColumnDefs } from "../../../../src/daemon/storage/schema.js";
import { CATALOG, REGISTRY } from "../../../../src/daemon/storage/catalog/index.js";
import {
	assertNotReservedProjectId,
	buildEnsureUnsortedSelectSql,
	buildListProjectsSql,
	buildProjectByIdSql,
	isReservedProjectId,
	PROJECTS_COLUMNS,
	PROJECTS_TABLE,
	PROJECTS_TABLES,
	ReservedProjectIdError,
	UNSORTED_PROJECT_ID,
	UNSORTED_PROJECT_NAME,
} from "../../../../src/daemon/storage/catalog/projects.js";
// The thin-client resolver mirrors the reserved-inbox id WITHOUT importing storage
// (the capture/recall hot path bans the storage import — invariant.test.ts). This
// drift-guard reads BOTH literals (a TEST may import both) and asserts they match,
// so a future rename on either side fails CI rather than silently splitting the inbox.
import { UNSORTED_PROJECT_ID as RESOLVER_UNSORTED_PROJECT_ID } from "../../../../src/hooks/shared/project-resolver.js";

function colSql(cols: readonly { name: string; sql: string }[], name: string): string | undefined {
	return cols.find((c) => c.name === name)?.sql;
}

describe("PRD-049a projects registry table", () => {
	it("ColumnDef array validates at load and every NOT NULL column has a DEFAULT", () => {
		expect(() => validateColumnDefs("projects", PROJECTS_COLUMNS)).not.toThrow();
		// Identity + display.
		expect(colSql(PROJECTS_COLUMNS, "project_id")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		expect(colSql(PROJECTS_COLUMNS, "name")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		// Match rules: remote_signal is a DISCRETE column (deterministic equality match);
		// bound_paths is a JSON-array string (read whole by the longest-prefix matcher).
		expect(colSql(PROJECTS_COLUMNS, "remote_signal")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		expect(colSql(PROJECTS_COLUMNS, "bound_paths")).toMatch(/TEXT NOT NULL DEFAULT '\[\]'/);
		// Reserved-inbox marker.
		expect(colSql(PROJECTS_COLUMNS, "is_reserved")).toMatch(/BIGINT NOT NULL DEFAULT 0/);
		// Explicit tenancy (D-2 tenant scope).
		expect(colSql(PROJECTS_COLUMNS, "org_id")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		expect(colSql(PROJECTS_COLUMNS, "workspace_id")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		expect(colSql(PROJECTS_COLUMNS, "created_at")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		expect(colSql(PROJECTS_COLUMNS, "updated_at")).toMatch(/TEXT NOT NULL DEFAULT ''/);
	});

	it("CREATE DDL is `USING deeplake` rendered from the ColumnDef array", () => {
		const ddl = buildCreateTableSql(PROJECTS_TABLE, PROJECTS_COLUMNS);
		expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS "projects" \(.*\) USING deeplake/);
		expect(ddl).toMatch(/project_id TEXT NOT NULL DEFAULT ''/);
		expect(ddl).toMatch(/remote_signal TEXT NOT NULL DEFAULT ''/);
	});

	it("049a-AC-6: a user-created project colliding with __unsorted__ (by id) is rejected", () => {
		expect(() => assertNotReservedProjectId(UNSORTED_PROJECT_ID, "Whatever")).toThrow(ReservedProjectIdError);
		// Case-insensitive + trimmed.
		expect(() => assertNotReservedProjectId("  __UNSORTED__  ", "Whatever")).toThrow(ReservedProjectIdError);
		expect(isReservedProjectId(UNSORTED_PROJECT_ID)).toBe(true);
		expect(isReservedProjectId("__Unsorted__")).toBe(true);
	});

	it("049a-AC-6: a user-created project colliding with the reserved display name is rejected", () => {
		expect(() => assertNotReservedProjectId("proj_real", UNSORTED_PROJECT_NAME)).toThrow(ReservedProjectIdError);
		expect(() => assertNotReservedProjectId("proj_real", " unsorted ")).toThrow(ReservedProjectIdError);
		expect(isReservedProjectId(UNSORTED_PROJECT_NAME)).toBe(true);
	});

	it("049a-AC-6: a normal project id/name passes the collision guard", () => {
		expect(() => assertNotReservedProjectId("proj_api", "API")).not.toThrow();
		expect(isReservedProjectId("proj_api")).toBe(false);
		expect(isReservedProjectId("API")).toBe(false);
	});

	it("ensure-unsorted probe selects the reserved inbox per (org, workspace)", () => {
		const sql = buildEnsureUnsortedSelectSql("acme-org", "acme-ws");
		expect(sql).toMatch(/FROM "projects"/);
		expect(sql).toMatch(/WHERE project_id = '__unsorted__'/);
		expect(sql).toMatch(/org_id = 'acme-org'/);
		expect(sql).toMatch(/workspace_id = 'acme-ws'/);
		expect(sql).toMatch(/LIMIT 1/);
	});

	it("list-projects read filters by explicit tenancy columns (scope=tenant)", () => {
		const sql = buildListProjectsSql("acme-org", "acme-ws");
		expect(sql).toMatch(/SELECT \* FROM "projects"/);
		expect(sql).toMatch(/org_id = 'acme-org'/);
		expect(sql).toMatch(/workspace_id = 'acme-ws'/);
	});

	it("by-id read resolves one project in one workspace with a plain by-id SELECT", () => {
		const sql = buildProjectByIdSql("proj_api", "acme-org", "acme-ws");
		expect(sql).toMatch(/WHERE project_id = 'proj_api'/);
		expect(sql).toMatch(/org_id = 'acme-org'/);
		expect(sql).toMatch(/workspace_id = 'acme-ws'/);
		// update-or-insert resolves by key with NO version ordering.
		expect(sql).not.toMatch(/ORDER BY version/);
	});

	it("the SQL builders escape an injection payload in a tenancy value (PRD-002b floor)", () => {
		const sql = buildListProjectsSql("acme'; DROP TABLE projects; --", "acme-ws");
		// The embedded quote is doubled, so no second statement is ever produced.
		expect(sql).toMatch(/'acme''; DROP TABLE projects; --'/);
		expect(sql).not.toMatch(/= 'acme'; DROP/);
	});

	it("is wired into CATALOG + REGISTRY (update-or-insert, tenant) and the trusted-table list", () => {
		expect(CATALOG.some((t) => t.name === PROJECTS_TABLE)).toBe(true);
		expect(CATALOG.find((t) => t.name === PROJECTS_TABLE)?.scope).toBe("tenant");
		expect(REGISTRY.patternFor(PROJECTS_TABLE)).toBe("update-or-insert");
		expect(REGISTRY.primitiveFor(PROJECTS_TABLE)).toBe("updateOrInsertByKey");
		expect(PROJECTS_TABLES.length).toBe(1);
		// The daemon's trusted-table list is derived from CATALOG, so membership here IS
		// membership in the list every CATALOG-derived consumer sees.
		expect(CATALOG.map((t) => t.name)).toContain(PROJECTS_TABLE);
	});

	it("the thin-client resolver's UNSORTED_PROJECT_ID matches the storage literal (drift guard)", () => {
		// The hooks resolver cannot import this storage module (thin-client boundary),
		// so it mirrors the reserved-inbox id as its own literal. They MUST stay equal,
		// or a session would resolve to a different inbox id than the registry seeds.
		expect(RESOLVER_UNSORTED_PROJECT_ID).toBe(UNSORTED_PROJECT_ID);
	});
});

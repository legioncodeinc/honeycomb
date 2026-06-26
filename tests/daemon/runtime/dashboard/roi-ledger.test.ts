/**
 * PRD-060f — Shared Spend Ledger + Teams Roster — proves f-AC-1 .. f-AC-13.
 *
 * Verification posture (no live DeepLake): each f-AC has a named, unskipped test
 * against the PRD-002 fake transport + an injected `QueryScope`. The ColumnDef arrays
 * validate at load; the writer appends (never UPDATEs); the user_id gate stays `''`
 * with no env/OS lookup; team_id resolves fail-soft; the read scopes through read_policy
 * and degrades (not throws) when the table is absent.
 */

import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import { buildCreateTableSql, validateColumnDefs } from "../../../../src/daemon/storage/schema.js";
import { CATALOG, REGISTRY, healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import {
	ROI_COST_BASES,
	ROI_METRICS_COLUMNS,
	TEAM_ACTIVE,
	TEAM_MEMBER_TYPES,
	TEAMS_COLUMNS,
	TENANCY_TABLES,
} from "../../../../src/daemon/storage/catalog/tenancy.js";
import {
	appendRoiMetric,
	buildRoiReadScopeSql,
	readRoiMetrics,
	resolveGatedUserId,
	resolveTeamId,
	upsertTeamMember,
	type RoiMetricInput,
} from "../../../../src/daemon/runtime/dashboard/roi-ledger.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";
import { TransportError } from "../../../../src/daemon/storage/transport.js";

const SCOPE = { org: "o1", workspace: "ws1" } as const;

function client(transport: FakeDeepLakeTransport) {
	return createStorageClient({ transport, provider: stubProvider(fakeCredentialRecord()) });
}

function colSql(cols: readonly { name: string; sql: string }[], name: string): string | undefined {
	return cols.find((c) => c.name === name)?.sql;
}
function colNames(cols: readonly { name: string; sql: string }[]): string[] {
	return cols.map((c) => c.name.toLowerCase());
}

/** A minimal valid ROI input (cents passed in — this writer does not compute them). */
function roiInput(overrides: Partial<RoiMetricInput> = {}): RoiMetricInput {
	return {
		id: "roi-1",
		sessionId: "sess-1",
		agentId: "agent-A",
		createdAt: "2026-06-26T00:00:00Z",
		...overrides,
	};
}

describe("PRD-060f shared spend ledger + teams roster", () => {
	// ── f-AC-1 ─────────────────────────────────────────────────────────────────
	it("f-AC-1 roi_metrics is tenant-scoped with queryable org_id/workspace_id columns (not agent-scoped)", () => {
		expect(() => validateColumnDefs("roi_metrics", ROI_METRICS_COLUMNS)).not.toThrow();

		const entry = CATALOG.find((t) => t.name === "roi_metrics");
		expect(entry).toBeDefined();
		// Tenant-scoped, NOT agent-scoped.
		expect(entry?.scope).toBe("tenant");
		expect(entry?.scope).not.toBe("agent");
		expect(entry?.embeddingColumns).toEqual([]);

		// org_id / workspace_id are QUERYABLE columns, not just a partition header.
		expect(colSql(ROI_METRICS_COLUMNS, "org_id")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		expect(colSql(ROI_METRICS_COLUMNS, "workspace_id")).toMatch(/TEXT NOT NULL DEFAULT ''/);
		// The rollup identity columns are present and queryable.
		for (const c of ["team_id", "project_id", "agent_id", "user_id", "session_id"]) {
			expect(colNames(ROI_METRICS_COLUMNS), `roi_metrics must carry "${c}"`).toContain(c);
		}
		// A real write puts org_id/workspace_id ON the row (queryable), from the scope.
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([]); // resolveTeamId SELECT → unassigned
		fake.enqueueRows([]); // INSERT ok
		return appendRoiMetric(client(fake), SCOPE, roiInput()).then(() => {
			const insert = fake.requests.find((r) => /^INSERT INTO "roi_metrics"/.test(r.sql))?.sql ?? "";
			expect(insert).toMatch(/org_id/);
			expect(insert).toMatch(/workspace_id/);
			expect(insert).toMatch(/'o1'/);
			expect(insert).toMatch(/'ws1'/);
		});
	});

	// ── f-AC-2 ─────────────────────────────────────────────────────────────────
	it("f-AC-2 append-only: write is an INSERT, a re-price APPENDs a new row, no UPDATE path exists", async () => {
		expect(CATALOG.find((t) => t.name === "roi_metrics")?.pattern).toBe("append-only");
		expect(REGISTRY.primitiveFor("roi_metrics")).toBe("appendOnlyInsert");

		const fake = new FakeDeepLakeTransport();
		// First price.
		fake.enqueueRows([]); // resolveTeamId
		fake.enqueueRows([]); // INSERT
		// Re-price (new price_ref, same session_id).
		fake.enqueueRows([]); // resolveTeamId
		fake.enqueueRows([]); // INSERT

		const c = client(fake);
		const first = await appendRoiMetric(c, SCOPE, roiInput({ id: "roi-1", priceRef: "rates-v1" }));
		const reprice = await appendRoiMetric(c, SCOPE, roiInput({ id: "roi-2", priceRef: "rates-v2" }));
		expect(first.result.kind).toBe("ok");
		expect(reprice.result.kind).toBe("ok");

		const inserts = fake.requests.filter((r) => /^INSERT INTO "roi_metrics"/.test(r.sql));
		// A re-price APPENDS a second row (two INSERTs), never mutates the first.
		expect(inserts.length).toBe(2);
		expect(inserts[0].sql).toMatch(/'rates-v1'/);
		expect(inserts[1].sql).toMatch(/'rates-v2'/);
		// NO UPDATE and NO DELETE was ever emitted for roi_metrics — the prior row is retained.
		expect(fake.requests.every((r) => !/^UPDATE\s+"?roi_metrics/i.test(r.sql))).toBe(true);
		expect(fake.requests.every((r) => !/^DELETE/i.test(r.sql))).toBe(true);
	});

	// ── f-AC-3 ─────────────────────────────────────────────────────────────────
	it("f-AC-3 canonical row per session_id is MAX(created_at); the original is retained", async () => {
		// The read selects the latest per session_id via a NOT EXISTS(newer created_at) self-join.
		const fake = new FakeDeepLakeTransport();
		// Return only the latest row — the original is retained on disk but filtered by the read.
		fake.enqueueRows([
			{ id: "roi-2", session_id: "sess-1", price_ref: "rates-v2", created_at: "2026-06-26T01:00:00Z", agent_id: "agent-A" },
		]);
		const res = await readRoiMetrics(client(fake), SCOPE, { agentId: "agent-A", readPolicy: "isolated" });
		expect(res.status).toBe("ok");
		if (res.status === "ok") {
			expect(res.rows).toHaveLength(1);
			expect(res.rows[0].price_ref).toBe("rates-v2"); // the latest (re-price) won.
		}
		// The query resolves canonical by created_at: a newer row for the session suppresses the older.
		const sql = fake.requests[0].sql;
		expect(sql).toMatch(/NOT EXISTS/i);
		expect(sql).toMatch(/created_at > m\.created_at/);
		// It does NOT delete the original — read-only SELECT, retention preserved.
		expect(fake.requests.every((r) => !/^DELETE/i.test(r.sql))).toBe(true);
	});

	// ── f-AC-4 ─────────────────────────────────────────────────────────────────
	it("f-AC-4 all money columns are BIGINT integer cents — no FLOAT money column, no float on write", async () => {
		const moneyCols = [
			"measured_cache_savings_cents",
			"modeled_savings_cents",
			"gross_cost_cents",
			"infra_cost_cents",
		];
		for (const c of moneyCols) {
			expect(colSql(ROI_METRICS_COLUMNS, c), `${c} must be BIGINT`).toMatch(/^BIGINT NOT NULL DEFAULT 0$/);
		}
		// No FLOAT/FLOAT4/REAL/DOUBLE money column anywhere on roi_metrics.
		for (const c of ROI_METRICS_COLUMNS) {
			expect(c.sql, `${c.name} must not be a float type`).not.toMatch(/FLOAT|REAL|DOUBLE|NUMERIC/i);
		}
		// On the write path, a float cents input is truncated to an integer (never written as a float).
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([]); // resolveTeamId
		fake.enqueueRows([]); // INSERT
		await appendRoiMetric(client(fake), SCOPE, roiInput({ grossCostCents: 1234.987, infraCostCents: 50.5 }));
		const insert = fake.requests.find((r) => /^INSERT INTO "roi_metrics"/.test(r.sql))?.sql ?? "";
		// 1234.987 → 1234, 50.5 → 50; no decimal point reaches the SQL value list.
		expect(insert).toMatch(/\b1234\b/);
		expect(insert).toMatch(/\b50\b/);
		expect(insert).not.toMatch(/1234\.987/);
		expect(insert).not.toMatch(/50\.5/);
	});

	// ── f-AC-5 ─────────────────────────────────────────────────────────────────
	it("f-AC-5 measured/modeled/allocated separate cols; allocated row carries cost_basis+allocation_method; mixed-basis detectable", async () => {
		// Separate, self-describing columns exist.
		expect(colNames(ROI_METRICS_COLUMNS)).toEqual(
			expect.arrayContaining([
				"measured_cache_savings_cents",
				"modeled_savings_cents",
				"modeled_assumption_ref",
				"cost_basis",
				"allocation_method",
			]),
		);
		expect(colSql(ROI_METRICS_COLUMNS, "cost_basis")).toMatch(/TEXT NOT NULL DEFAULT 'none'/);
		expect(ROI_COST_BASES).toEqual(["measured", "allocated", "none"]);

		// An allocated per-team/user row carries cost_basis='allocated' + a non-empty allocation_method.
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([]); // resolveTeamId
		fake.enqueueRows([]); // INSERT
		await appendRoiMetric(
			client(fake),
			SCOPE,
			roiInput({ costBasis: "allocated", allocationMethod: "by_token_share", infraCostCents: 900 }),
		);
		const insert = fake.requests.find((r) => /^INSERT INTO "roi_metrics"/.test(r.sql))?.sql ?? "";
		expect(insert).toMatch(/'allocated'/);
		expect(insert).toMatch(/'by_token_share'/);

		// A mixed-basis rollup is detectable via COUNT(DISTINCT cost_basis) > 1 — the column is queryable.
		const fake2 = new FakeDeepLakeTransport();
		fake2.enqueueRows([{ distinct_bases: 2 }]);
		const mixed = await client(fake2).query(
			'SELECT COUNT(DISTINCT cost_basis) AS distinct_bases FROM "roi_metrics"',
			SCOPE,
		);
		expect(mixed.kind).toBe("ok");
		if (mixed.kind === "ok") expect(Number(mixed.rows[0].distinct_bases)).toBeGreaterThan(1);
	});

	// ── f-AC-6 ─────────────────────────────────────────────────────────────────
	it("f-AC-6 user_id gate: '' with no verified claim; backend-token claim populates it; NO env/OS lookup", async () => {
		// Pure-gate unit assertions.
		expect(resolveGatedUserId(undefined)).toBe("");
		expect(resolveGatedUserId({ source: "git-email", userId: "spoofed@example.com" })).toBe("");
		expect(resolveGatedUserId({ source: "os-login", userId: "whoami" })).toBe("");
		expect(resolveGatedUserId({ source: "backend-token", userId: "u-verified" })).toBe("u-verified");

		// SPY on the OS-login source (os.userInfo) to PROVE it is never consulted as a fallback.
		// Plant spoofable identities into the OS-login and $USER/$LOGNAME env sources; if the gate
		// EVER read them, the written user_id would be one of these — we assert it stays ''.
		const userInfoSpy = vi.spyOn(os, "userInfo").mockReturnValue({
			username: "os-login-name",
		} as ReturnType<typeof os.userInfo>);
		const prevUser = process.env.USER;
		const prevLogname = process.env.LOGNAME;
		const prevUsername = process.env.USERNAME;
		process.env.USER = "env-user-name";
		process.env.LOGNAME = "env-logname";
		process.env.USERNAME = "env-username";

		try {
			const fake = new FakeDeepLakeTransport();
			fake.enqueueRows([]); // resolveTeamId
			fake.enqueueRows([]); // INSERT
			// The state TODAY: no verified claim → user_id MUST be ''.
			const out = await appendRoiMetric(client(fake), SCOPE, roiInput());
			expect(out.userId).toBe("");
			const insert = fake.requests.find((r) => /^INSERT INTO "roi_metrics"/.test(r.sql))?.sql ?? "";
			// user_id is written as the empty string, never a git-email/$USER/OS-login value.
			expect(insert).toMatch(/user_id/);
			expect(insert).not.toMatch(/spoofed@example\.com/);
			expect(insert).not.toMatch(/os-login-name|env-user-name|env-logname|env-username/);

			// The OS-login source was never consulted as a user_id fallback.
			expect(userInfoSpy).not.toHaveBeenCalled();
		} finally {
			userInfoSpy.mockRestore();
			if (prevUser === undefined) delete process.env.USER;
			else process.env.USER = prevUser;
			if (prevLogname === undefined) delete process.env.LOGNAME;
			else process.env.LOGNAME = prevLogname;
			if (prevUsername === undefined) delete process.env.USERNAME;
			else process.env.USERNAME = prevUsername;
		}
	});

	// ── f-AC-7 ─────────────────────────────────────────────────────────────────
	it("f-AC-7 no historical backfill: a pre-claim row keeps user_id='' even after a claim later arrives", async () => {
		const fake = new FakeDeepLakeTransport();
		// Pre-claim write → user_id ''.
		fake.enqueueRows([]); // resolveTeamId
		fake.enqueueRows([]); // INSERT
		// Later claimed write (a NEW row) → user_id populated; the pre-claim row is untouched.
		fake.enqueueRows([]); // resolveTeamId
		fake.enqueueRows([]); // INSERT

		const c = client(fake);
		const pre = await appendRoiMetric(c, SCOPE, roiInput({ id: "roi-pre", sessionId: "sess-pre" }));
		expect(pre.userId).toBe("");
		const post = await appendRoiMetric(
			c,
			SCOPE,
			roiInput({ id: "roi-post", sessionId: "sess-post", verifiedClaim: { source: "backend-token", userId: "u-1" } }),
		);
		expect(post.userId).toBe("u-1");

		// The pre-claim write emitted no UPDATE — there is no path that retroactively backfills user_id.
		expect(fake.requests.every((r) => !/^UPDATE/i.test(r.sql))).toBe(true);
		// Only INSERTs (append-only) — the pre-claim row stays user_id='' forever.
		const inserts = fake.requests.filter((r) => /^INSERT INTO "roi_metrics"/.test(r.sql));
		expect(inserts.length).toBe(2);
	});

	// ── f-AC-8 ─────────────────────────────────────────────────────────────────
	it("f-AC-8 teams is tenant-scoped + version-bumped; agent row resolves a team today; user row valid but inert", async () => {
		expect(() => validateColumnDefs("teams", TEAMS_COLUMNS)).not.toThrow();
		const entry = CATALOG.find((t) => t.name === "teams");
		expect(entry?.scope).toBe("tenant");
		expect(entry?.pattern).toBe("version-bumped");
		expect(REGISTRY.primitiveFor("teams")).toBe("appendVersionBumped");
		expect(TEAM_MEMBER_TYPES).toEqual(["agent", "user"]);
		expect(colSql(TEAMS_COLUMNS, "member_type")).toMatch(/TEXT NOT NULL DEFAULT 'agent'/);
		expect(colSql(TEAMS_COLUMNS, "active")).toMatch(/BIGINT NOT NULL DEFAULT 1/);
		expect(colSql(TEAMS_COLUMNS, "version")).toMatch(/BIGINT NOT NULL DEFAULT 0/);

		// Write an AGENT roster row (version-bumped: MAX(version) read → INSERT v1).
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([]); // MAX(version) read → none yet
		fake.enqueueRows([]); // INSERT v1
		const { result, version } = await upsertTeamMember(client(fake), SCOPE, {
			id: "tm-1",
			teamId: "team-alpha",
			memberType: "agent",
			memberId: "agent-A",
			createdAt: "2026-06-26T00:00:00Z",
		});
		expect(result.kind).toBe("ok");
		expect(version).toBe(1);
		const insert = fake.requests.find((r) => /^INSERT INTO "teams"/.test(r.sql))?.sql ?? "";
		expect(insert).toMatch(/'agent'/);
		expect(insert).toMatch(/'team-alpha'/);

		// An AGENT row resolves a team_id TODAY.
		const fake2 = new FakeDeepLakeTransport();
		fake2.enqueueRows([{ team_id: "team-alpha" }]);
		expect(await resolveTeamId(client(fake2), SCOPE, "agent-A")).toBe("team-alpha");

		// A USER row is structurally valid (writes fine) but inert — it carries member_type='user'
		// and only lights up once user_id is verified; it does NOT resolve via the agent lookup.
		const fake3 = new FakeDeepLakeTransport();
		fake3.enqueueRows([]); // MAX(version)
		fake3.enqueueRows([]); // INSERT
		const userRow = await upsertTeamMember(client(fake3), SCOPE, {
			id: "tm-2",
			teamId: "team-alpha",
			memberType: "user",
			memberId: "u-verified",
			createdAt: "2026-06-26T00:00:00Z",
		});
		expect(userRow.result.kind).toBe("ok");
		const userInsert = fake3.requests.find((r) => /^INSERT INTO "teams"/.test(r.sql))?.sql ?? "";
		expect(userInsert).toMatch(/'user'/);
		// The agent-keyed resolver does NOT match the user row (inert for team resolution today).
		const fake4 = new FakeDeepLakeTransport();
		fake4.enqueueRows([]); // no agent row for 'u-verified'
		expect(await resolveTeamId(client(fake4), SCOPE, "u-verified")).toBe("");
		// The resolver query filters member_type='agent'.
		expect(fake4.requests[0].sql).toMatch(/member_type = 'agent'/);
	});

	// ── f-AC-9 ─────────────────────────────────────────────────────────────────
	it("f-AC-9 team_id resolved at ROI-write time: assigned→resolved, unassigned→'', never throws (fail-soft)", async () => {
		// Assigned agent → roster lookup returns the team, stamped onto the row.
		const fakeAssigned = new FakeDeepLakeTransport();
		fakeAssigned.enqueueRows([{ team_id: "team-beta" }]); // resolveTeamId
		fakeAssigned.enqueueRows([]); // INSERT
		const assigned = await appendRoiMetric(client(fakeAssigned), SCOPE, roiInput({ agentId: "agent-assigned" }));
		expect(assigned.teamId).toBe("team-beta");
		const insertA = fakeAssigned.requests.find((r) => /^INSERT INTO "roi_metrics"/.test(r.sql))?.sql ?? "";
		expect(insertA).toMatch(/'team-beta'/);

		// Unassigned agent → '' team_id.
		const fakeUnassigned = new FakeDeepLakeTransport();
		fakeUnassigned.enqueueRows([]); // resolveTeamId → no row
		fakeUnassigned.enqueueRows([]); // INSERT
		const unassigned = await appendRoiMetric(client(fakeUnassigned), SCOPE, roiInput({ agentId: "agent-lonely" }));
		expect(unassigned.teamId).toBe("");

		// FAIL-SOFT: the roster lookup THROWS (table absent / flap) → resolves to '' and the write still proceeds.
		let lookupAttempt = 0;
		const fakeThrow = new FakeDeepLakeTransport((req) => {
			if (/SELECT team_id FROM "teams"/.test(req.sql)) {
				lookupAttempt++;
				throw new TransportError("query", 'relation "teams" does not exist', 404);
			}
			return []; // INSERT ok
		});
		const soft = await appendRoiMetric(client(fakeThrow), SCOPE, roiInput({ agentId: "agent-x" }));
		expect(lookupAttempt).toBeGreaterThan(0);
		expect(soft.teamId).toBe(""); // never threw — degraded to unassigned.
		expect(soft.result.kind).toBe("ok"); // the ROI row still wrote.

		// Direct resolver assertion: it returns '' rather than throwing.
		const fakeThrow2 = new FakeDeepLakeTransport(() => {
			throw new TransportError("connection", "ECONNRESET");
		});
		await expect(resolveTeamId(client(fakeThrow2), SCOPE, "agent-y")).resolves.toBe("");
	});

	// ── f-AC-10 ────────────────────────────────────────────────────────────────
	it("f-AC-10 additive-heal: every NOT NULL col has DEFAULT; both tables heal onto a legacy dataset; missing table degrades", async () => {
		// Every NOT NULL column on BOTH tables carries a DEFAULT (validateColumnDefs enforces this at load).
		for (const [label, cols] of [
			["roi_metrics", ROI_METRICS_COLUMNS],
			["teams", TEAMS_COLUMNS],
		] as const) {
			expect(() => validateColumnDefs(label, cols)).not.toThrow();
			for (const c of cols) {
				if (/\bNOT\s+NULL\b/i.test(c.sql)) {
					expect(c.sql, `${label}.${c.name} NOT NULL must have a DEFAULT`).toMatch(/\bDEFAULT\b/i);
				}
			}
		}

		// roi_metrics heals additively onto a LEGACY dataset (missing-table → CREATE → retry once).
		const seen: string[] = [];
		let insertAttempts = 0;
		const fakeHeal = new FakeDeepLakeTransport((req) => {
			seen.push(req.sql);
			if (/SELECT team_id FROM "teams"/.test(req.sql)) return []; // resolveTeamId → unassigned
			if (/^INSERT INTO "roi_metrics"/.test(req.sql)) {
				insertAttempts++;
				if (insertAttempts === 1) throw new TransportError("query", 'relation "roi_metrics" does not exist', 404);
				return [];
			}
			if (/^CREATE TABLE/.test(req.sql)) return [];
			if (/information_schema\.columns/.test(req.sql)) return ROI_METRICS_COLUMNS.map((c) => ({ column_name: c.name }));
			return [];
		});
		const healed = await appendRoiMetric(client(fakeHeal), SCOPE, roiInput());
		expect(healed.result.kind).toBe("ok");
		expect(seen.some((s) => /CREATE TABLE IF NOT EXISTS "roi_metrics"/.test(s))).toBe(true);
		expect(seen.filter((s) => /^INSERT INTO "roi_metrics"/.test(s)).length).toBe(2); // failure + retry

		// teams DDL renders USING deeplake (heal create path).
		expect(buildCreateTableSql("teams", TEAMS_COLUMNS)).toMatch(
			/CREATE TABLE IF NOT EXISTS "teams" \(.*\) USING deeplake/,
		);

		// A missing table DEGRADES the read to "shared-ledger-absent" rather than throwing — daemon boots.
		const fakeAbsent = new FakeDeepLakeTransport();
		fakeAbsent.enqueueQueryError('relation "roi_metrics" does not exist', 404);
		const absent = await readRoiMetrics(client(fakeAbsent), SCOPE, { agentId: "agent-A", readPolicy: "shared" });
		expect(absent.status).toBe("shared-ledger-absent");

		// Even a hard throw from the transport degrades (never propagates).
		const fakeThrow = new FakeDeepLakeTransport(() => {
			throw new TransportError("connection", "ECONNREFUSED");
		});
		const degraded = await readRoiMetrics(client(fakeThrow), SCOPE, { agentId: "agent-A", readPolicy: "isolated" });
		expect(degraded.status).toBe("shared-ledger-absent");
	});

	// ── f-AC-11 ────────────────────────────────────────────────────────────────
	it("f-AC-11 SQL-guarded: an injection-shaped value is escaped, never closes the statement", async () => {
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([]); // resolveTeamId
		fake.enqueueRows([]); // INSERT
		const evil = "'; DROP TABLE roi_metrics; --";
		await appendRoiMetric(client(fake), SCOPE, roiInput({ id: evil, sessionId: evil, priceRef: evil }));
		const insert = fake.requests.find((r) => /^INSERT INTO "roi_metrics"/.test(r.sql))?.sql ?? "";
		// The single quote is doubled (escaped) — the payload collapses to one inert literal.
		expect(insert).toMatch(/''; DROP TABLE roi_metrics; --/);
		// No second statement is produced: exactly one INSERT, no bare DROP statement.
		expect(fake.requests.filter((r) => /^INSERT/.test(r.sql)).length).toBe(1);
		expect(fake.requests.every((r) => !/^DROP/i.test(r.sql.trim()))).toBe(true);

		// The roster resolver guards the agent_id value too.
		const fake2 = new FakeDeepLakeTransport();
		fake2.enqueueRows([]);
		await resolveTeamId(client(fake2), SCOPE, "a' OR '1'='1");
		expect(fake2.requests[0].sql).toMatch(/'a'' OR ''1''=''1'/);
	});

	// ── f-AC-12 ────────────────────────────────────────────────────────────────
	it("f-AC-12 rollup indexing only: roi_metrics + teams carry NO BM25 deeplake_index and NO vector column", () => {
		for (const [label, cols] of [
			["roi_metrics", ROI_METRICS_COLUMNS],
			["teams", TEAMS_COLUMNS],
		] as const) {
			const entry = CATALOG.find((t) => t.name === label);
			// No embedding/vector column declared.
			expect(entry?.embeddingColumns, `${label} must declare no embedding columns`).toEqual([]);
			// No FLOAT4[] vector column type, no deeplake_index BM25 directive in any column SQL.
			for (const c of cols) {
				expect(c.sql, `${label}.${c.name} must not be a vector`).not.toMatch(/FLOAT4\[|VECTOR|\bindex\b/i);
				expect(c.sql, `${label}.${c.name} must not declare BM25`).not.toMatch(/bm25|deeplake_index|inverted/i);
			}
		}
		// The rollup lookup columns the indexes target are present (queryable).
		for (const c of ["org_id", "workspace_id", "team_id", "period_start", "project_id", "user_id"]) {
			expect(colNames(ROI_METRICS_COLUMNS)).toContain(c);
		}
	});

	// ── f-AC-13 ────────────────────────────────────────────────────────────────
	it("f-AC-13 local read scoped by read_policy: isolated never returns another agent's rows; shared is workspace-wide", async () => {
		// isolated → own rows only (agent_id = self).
		const iso = buildRoiReadScopeSql({ agentId: "agent-A", readPolicy: "isolated" });
		expect(iso.policyApplied).toBe("isolated");
		expect(iso.sql).toMatch(/agent_id = 'agent-A'/);

		// shared → workspace-wide (no per-agent filter; the partition outer ring bounds the workspace).
		const shared = buildRoiReadScopeSql({ agentId: "agent-A", readPolicy: "shared" });
		expect(shared.policyApplied).toBe("shared");
		expect(shared.sql).not.toMatch(/agent_id =/);

		// Fail-closed: a blank agent id or unknown policy degrades to isolated (never wider).
		expect(buildRoiReadScopeSql({ agentId: "", readPolicy: "shared" }).policyApplied).toBe("isolated");
		expect(buildRoiReadScopeSql({ agentId: "agent-A", readPolicy: "bogus" }).policyApplied).toBe("isolated");

		// The isolated READ query carries the own-agent predicate (qualified for the self-join).
		const fakeIso = new FakeDeepLakeTransport();
		fakeIso.enqueueRows([{ id: "r1", agent_id: "agent-A", session_id: "s1", created_at: "t1" }]);
		const isoRes = await readRoiMetrics(client(fakeIso), SCOPE, { agentId: "agent-A", readPolicy: "isolated" });
		expect(isoRes.status).toBe("ok");
		expect(fakeIso.requests[0].sql).toMatch(/m\.agent_id = 'agent-A'/);

		// The shared READ query does NOT pin to one agent → workspace-wide rows.
		const fakeShared = new FakeDeepLakeTransport();
		fakeShared.enqueueRows([
			{ id: "r1", agent_id: "agent-A", session_id: "s1", created_at: "t1" },
			{ id: "r2", agent_id: "agent-B", session_id: "s2", created_at: "t2" },
		]);
		const sharedRes = await readRoiMetrics(client(fakeShared), SCOPE, { agentId: "agent-A", readPolicy: "shared" });
		expect(sharedRes.status).toBe("ok");
		if (sharedRes.status === "ok") {
			// Workspace-wide: rows from other agents are returned under `shared`.
			expect(sharedRes.rows.map((r) => r.agent_id)).toEqual(expect.arrayContaining(["agent-A", "agent-B"]));
		}
		expect(fakeShared.requests[0].sql).not.toMatch(/m\.agent_id = 'agent-A'/);
		// Both reads run under the org/workspace partition scope (outer ring).
		expect(fakeShared.requests[0].org).toBe("o1");
		expect(fakeShared.requests[0].workspace).toBe("ws1");
	});

	// ── Registry wiring ──────────────────────────────────────────────────────────
	it("registry: roi_metrics + teams are wired into TENANCY_TABLES, CATALOG, and REGISTRY", () => {
		expect(REGISTRY.patternFor("roi_metrics")).toBe("append-only");
		expect(REGISTRY.patternFor("teams")).toBe("version-bumped");
		for (const name of ["roi_metrics", "teams"]) {
			expect(CATALOG.some((t) => t.name === name), `CATALOG should contain "${name}"`).toBe(true);
		}
		// healTargetFor resolves both new tables.
		expect(healTargetFor("roi_metrics").table).toBe("roi_metrics");
		expect(healTargetFor("teams").table).toBe("teams");
		// TENANCY_TABLES now has the original 5 + 2 = 7 entries.
		expect(TENANCY_TABLES.length).toBe(7);
		expect(TEAM_ACTIVE).toBe(1);
	});
});

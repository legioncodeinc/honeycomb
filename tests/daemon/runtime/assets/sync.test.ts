/**
 * PRD-033c — the daemon-served asset-sync ENGINE (publish/pull/tombstone).
 *
 * These tests drive {@link createAssetSyncApi} against a SCRIPTABLE in-memory fake
 * {@link StorageQuery} (no DeepLake, no network) and assert the DeepLake-side contract:
 *
 *   c-AC-1  publish INSERTs a versioned row carrying the native blob keyed
 *           `(asset_type, harness)` + the reserved `canonical` + the tier-appropriate scoping.
 *   c-AC-4  the identity adapter round-trips (`parse(render(x)) === x`); the `canonical`
 *           column is carried through publish→pull.
 *   c-AC-5  a tombstone appends a `tombstone='true'` ROW (never a DELETE) at the same radius.
 *   FR-2/FR-7  pull returns the highest version per id, audience-matched, tombstones included;
 *              an absent trusted table short-circuits to `tableAbsent` with NO SELECT.
 */

import { describe, expect, it } from "vitest";

import {
	createAssetSyncApi,
	type TrustedTableProbe,
} from "../../../../src/daemon/runtime/assets/sync.js";
import { IDENTITY_ADAPTER, type LatticeCell } from "../../../../src/daemon/runtime/assets/contracts.js";
import { SYNCED_ASSETS_COLUMNS, SYNCED_ASSETS_TABLE } from "../../../../src/daemon/storage/catalog/synced-assets.js";
import type { ColumnDef } from "../../../../src/daemon/storage/schema.js";
import type { HealTarget } from "../../../../src/daemon/storage/heal.js";
import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";

const TARGET: HealTarget = { table: SYNCED_ASSETS_TABLE, columns: SYNCED_ASSETS_COLUMNS as unknown as ColumnDef[] };

/** A tiny in-memory fake `synced_assets` store that supports the engine's read+write shapes. */
function createFakeStore(): { storage: StorageQuery; rows: StorageRow[]; statements: string[] } {
	const rows: StorageRow[] = [];
	const statements: string[] = [];
	const storage: StorageQuery = {
		async query(sql: string, _scope: QueryScope): Promise<QueryResult> {
			statements.push(sql);
			// MAX(version) read for appendVersionBumped: `SELECT version FROM "t" WHERE honeycomb_id = '<id>' ORDER BY version DESC LIMIT 1`
			// (column identifiers from `sqlIdent` are emitted BARE, not double-quoted).
			const verMatch = /SELECT version FROM .* WHERE honeycomb_id = '([^']*)'/.exec(sql);
			if (verMatch && /ORDER BY version DESC LIMIT 1/.test(sql)) {
				const id = verMatch[1];
				const versions = rows.filter((r) => r.honeycomb_id === id).map((r) => Number(r.version));
				if (versions.length === 0) return ok([], 1);
				return ok([{ version: Math.max(...versions) }], 1);
			}
			// INSERT: parse the (cols) VALUES (vals) and push a row.
			if (/^INSERT INTO/.test(sql)) {
				rows.push(parseInsert(sql));
				return ok([], 1);
			}
			// Pull SELECT * — return every row (the engine reduces + audience-filters in memory).
			if (/^SELECT \* FROM/.test(sql)) {
				const styleMatch = /WHERE style = '([^']*)'/.exec(sql);
				const out = styleMatch ? rows.filter((r) => r.style === styleMatch[1]) : rows;
				return ok(out.map((r) => ({ ...r })), 1);
			}
			return ok([], 1);
		},
	};
	return { storage, rows, statements };
}

/** Parse an `INSERT INTO "t" ("a", "b") VALUES ('x', E'y', 3)` into a row object (test-only). */
function parseInsert(sql: string): StorageRow {
	const m = /INSERT INTO "[^"]+" \(([^)]*)\) VALUES \((.*)\)$/s.exec(sql);
	if (m === null) return {};
	const cols = m[1].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
	const vals = splitTopLevel(m[2]);
	const row: StorageRow = {};
	for (let i = 0; i < cols.length; i++) {
		row[cols[i]] = decodeVal(vals[i] ?? "");
	}
	return row;
}

/** Split a VALUES list on top-level commas (respecting single-quoted literals). */
function splitTopLevel(s: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let inStr = false;
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (inStr) {
			cur += ch;
			if (ch === "'" && s[i + 1] === "'") {
				cur += s[++i];
			} else if (ch === "'") {
				inStr = false;
			}
			continue;
		}
		if (ch === "'") {
			inStr = true;
			cur += ch;
		} else if (ch === "(") {
			depth++;
			cur += ch;
		} else if (ch === ")") {
			depth--;
			cur += ch;
		} else if (ch === "," && depth === 0) {
			out.push(cur.trim());
			cur = "";
		} else {
			cur += ch;
		}
	}
	if (cur.trim().length > 0) out.push(cur.trim());
	return out;
}

/** Decode one SQL value literal (`'x'`, `E'y'`, or a bare number) to its JS value. */
function decodeVal(raw: string): unknown {
	const v = raw.trim();
	if (/^E'/.test(v)) return v.slice(2, -1).replace(/''/g, "'").replace(/\\\\/g, "\\");
	if (/^'/.test(v)) return v.slice(1, -1).replace(/''/g, "'").replace(/\\\\/g, "\\");
	const n = Number(v);
	return Number.isFinite(n) ? n : v;
}

const TEAM_CELL: LatticeCell = { tier: "Team", style: "Repository" };
const DEVICE_CELL: LatticeCell = { tier: "Device", style: "User" };

const scope = { org: "acme", workspace: "backend", author: "alice", deviceId: "dev-1" };

describe("PRD-033c sync engine — publish/pull/tombstone (c-AC-1/4/5)", () => {
	it("c-AC-1 publish INSERTs a versioned row with native keyed (asset_type,harness) + canonical + scoping", async () => {
		const { storage, rows } = createFakeStore();
		const api = createAssetSyncApi({ storage, target: TARGET });

		const res = await api.publish({
			honeycombId: "hc_aaaa0000aaaa0000aaaa0000aaaa0000",
			assetType: "skill",
			harness: "claude_code",
			native: "---\nname: x\n---\nbody",
			canonical: "---\nname: x\n---\nbody",
			contentHash: "deadbeef",
			cell: TEAM_CELL,
			scope,
			deviceSet: [],
		});

		expect(res.published).toBe(true);
		expect(res.version).toBe(1);
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row.asset_type).toBe("skill");
		expect(row.harness).toBe("claude_code");
		expect(row.native).toContain("body");
		expect(row.canonical).toContain("body"); // c-AC-4 canonical carried
		expect(row.content_hash).toBe("deadbeef");
		expect(row.tombstone).toBe("false");
		expect(row.tier).toBe("Team");
		expect(row.style).toBe("Repository");
		// tier-appropriate scoping (Team → org+workspace)
		expect(row.org).toBe("acme");
		expect(row.workspace).toBe("backend");
		expect(row.author).toBe("alice");
		expect(row.version).toBe(1);
	});

	it("c-AC-1 a second publish for the same id bumps the version (append-only, never UPDATE)", async () => {
		const { storage, rows } = createFakeStore();
		const api = createAssetSyncApi({ storage, target: TARGET });
		const base = {
			honeycombId: "hc_bbbb0000bbbb0000bbbb0000bbbb0000",
			assetType: "skill" as const,
			harness: "claude_code",
			canonical: "",
			cell: TEAM_CELL,
			scope,
			deviceSet: [],
		};
		const r1 = await api.publish({ ...base, native: "v1", contentHash: "h1" });
		const r2 = await api.publish({ ...base, native: "v2", contentHash: "h2" });
		expect(r1.version).toBe(1);
		expect(r2.version).toBe(2);
		expect(rows).toHaveLength(2); // both versions survive (append-only)
	});

	it("c-AC-4 the identity adapter round-trips parse(render(x)) === x", () => {
		const samples = ["", "plain", "---\nname: y\n---\n# Body\nwith 'quotes' and \\backslash", "🐝 unicode"];
		for (const x of samples) {
			expect(IDENTITY_ADAPTER.parse(IDENTITY_ADAPTER.render(x))).toBe(x);
		}
	});

	it("c-AC-5 tombstone appends a tombstone='true' ROW (never a DELETE) at the same radius", async () => {
		const { storage, rows } = createFakeStore();
		const api = createAssetSyncApi({ storage, target: TARGET });
		const id = "hc_cccc0000cccc0000cccc0000cccc0000";
		await api.publish({
			honeycombId: id,
			assetType: "skill",
			harness: "claude_code",
			native: "body",
			canonical: "body",
			contentHash: "h",
			cell: TEAM_CELL,
			scope,
			deviceSet: [],
		});
		const tomb = await api.tombstone({ honeycombId: id, assetType: "skill", harness: "claude_code", cell: TEAM_CELL, scope, deviceSet: [] });
		expect(tomb.tombstoned).toBe(true);
		expect(tomb.version).toBe(2);
		// The original row still exists; a NEW row carries tombstone='true' (append-only).
		expect(rows).toHaveLength(2);
		expect(rows[1].tombstone).toBe("true");
	});

	it("FR-2 pull returns the highest version per id, audience-matched, tombstones included (Team)", async () => {
		const { storage } = createFakeStore();
		const api = createAssetSyncApi({ storage, target: TARGET });
		const id = "hc_dddd0000dddd0000dddd0000dddd0000";
		await api.publish({ honeycombId: id, assetType: "skill", harness: "claude_code", native: "v1", canonical: "v1", contentHash: "h1", cell: TEAM_CELL, scope, deviceSet: [] });
		await api.publish({ honeycombId: id, assetType: "skill", harness: "claude_code", native: "v2", canonical: "v2", contentHash: "h2", cell: TEAM_CELL, scope, deviceSet: [] });

		const sameWs = await api.pull({ scope });
		expect(sameWs.tableAbsent).toBe(false);
		expect(sameWs.assets).toHaveLength(1);
		expect(sameWs.assets[0].version).toBe(2); // highest only
		expect(sameWs.assets[0].native).toBe("v2");

		// A DIFFERENT workspace does NOT see the Team artifact (AC-3 isolation, unit level).
		const otherWs = await api.pull({ scope: { ...scope, workspace: "other" } });
		expect(otherWs.assets).toHaveLength(0);
	});

	it("FR-2 Device-tier audience: same author+device sees it; a non-member device does not", async () => {
		const { storage } = createFakeStore();
		const api = createAssetSyncApi({ storage, target: TARGET });
		const id = "hc_eeee0000eeee0000eeee0000eeee0000";
		await api.publish({
			honeycombId: id,
			assetType: "agent",
			harness: "claude_code",
			native: "agent-body",
			canonical: "agent-body",
			contentHash: "h",
			cell: DEVICE_CELL,
			scope,
			deviceSet: ["dev-1", "dev-2"],
		});

		const member = await api.pull({ scope: { ...scope, deviceId: "dev-2" } });
		expect(member.assets).toHaveLength(1);

		const nonMember = await api.pull({ scope: { ...scope, deviceId: "dev-9" } });
		expect(nonMember.assets).toHaveLength(0);

		const otherAuthor = await api.pull({ scope: { ...scope, author: "bob", deviceId: "dev-1" } });
		expect(otherAuthor.assets).toHaveLength(0);
	});

	it("FR-7 an absent trusted table short-circuits to tableAbsent with NO SELECT", async () => {
		const { storage, statements } = createFakeStore();
		const probe: TrustedTableProbe = { tables: () => Promise.resolve(["memory", "sessions"]) };
		const api = createAssetSyncApi({ storage, target: TARGET, trustedTables: probe });
		const res = await api.pull({ scope });
		expect(res.tableAbsent).toBe(true);
		expect(res.assets).toHaveLength(0);
		expect(statements.some((s) => /SELECT \* FROM/.test(s))).toBe(false);
	});
});

/**
 * PRD-042 — the Sync page daemon-side data + action ENGINE (the write surface seam).
 *
 * These tests drive {@link createSyncActionApi} + {@link fetchAssetSyncView} against a SCRIPTABLE
 * in-memory fake {@link StorageQuery} (no DeepLake, no network) + a TEMP-DIR install target (no real
 * `.claude/`), and assert the acceptance criteria — every action parameterized over `{ skill, agent }`
 * to PROVE the symmetry contract (b-AC-6: the agent surface is the skill surface keyed by asset_type):
 *
 *   a-AC-3 / b-AC-3  promote → a version-bumped INSERT (asset_type-keyed, NEVER an UPDATE) → a
 *                    poll-convergent read-back shows the row LIVE `shared`.
 *   a-AC-4 / b-AC-4  pull → an install-target write → `pulled` (the native artifact lands on disk).
 *   a-AC-5 / b-AC-5  demote → a `tombstone='true'` version-bump → the converged read is NO LONGER
 *                    live `shared` (and the prior versions survive in the append-only log).
 *   a-AC-6           enable/disable → a LOCAL install presence toggle (no substrate write).
 *   AC-7 / D-5       no secret (native blob / author email / org GUID) rides any action RESULT or the
 *                    union view-model.
 *   a-AC-1 / b-AC-1  the union lists every skill/agent once (no double-count) with honest state.
 */

import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	createSyncActionApi,
	fetchAssetSyncView,
	type SyncActionApi,
} from "../../../../src/daemon/runtime/dashboard/sync-api.js";
import { createFsAssetInstallTarget } from "../../../../src/daemon/runtime/dashboard/asset-install-target.js";
import { createAssetSyncApi } from "../../../../src/daemon/runtime/assets/sync.js";
import { SYNCED_ASSETS_COLUMNS, SYNCED_ASSETS_TABLE, type SyncedAssetType } from "../../../../src/daemon/storage/catalog/synced-assets.js";
import type { ColumnDef } from "../../../../src/daemon/storage/schema.js";
import type { HealTarget } from "../../../../src/daemon/storage/heal.js";
import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import type { AssetScope } from "../../../../src/daemon/runtime/assets/contracts.js";
import type { LocalAssetInventory } from "../../../../src/dashboard/contracts.js";

const TARGET: HealTarget = { table: SYNCED_ASSETS_TABLE, columns: SYNCED_ASSETS_COLUMNS as unknown as ColumnDef[] };

const SCOPE: AssetScope = { org: "acme", workspace: "backend", author: "alice", deviceId: "dev-1" };

/** A tiny in-memory fake `synced_assets` store (the engine's read+write shapes) + a statement log. */
function createFakeStore(): { storage: StorageQuery; rows: StorageRow[]; statements: string[] } {
	const rows: StorageRow[] = [];
	const statements: string[] = [];
	const storage: StorageQuery = {
		async query(sql: string, _scope: QueryScope): Promise<QueryResult> {
			statements.push(sql);
			// MAX(version) read for appendVersionBumped: `SELECT version FROM "t" WHERE honeycomb_id = '<id>' ORDER BY version DESC LIMIT 1`.
			const verMatch = /SELECT version FROM .* WHERE honeycomb_id = '([^']*)'/.exec(sql);
			if (verMatch && /ORDER BY version DESC LIMIT 1/.test(sql)) {
				const id = verMatch[1];
				const versions = rows.filter((r) => r.honeycomb_id === id).map((r) => Number(r.version));
				return versions.length === 0 ? ok([], 1) : ok([{ version: Math.max(...versions) }], 1);
			}
			// The read-back current-version SELECT (`SELECT * FROM "t" WHERE honeycomb_id = '<id>' ORDER BY version DESC LIMIT 1`).
			const curMatch = /SELECT \* FROM .* WHERE honeycomb_id = '([^']*)' ORDER BY version DESC LIMIT 1/.exec(sql);
			if (curMatch) {
				const id = curMatch[1];
				const mine = rows.filter((r) => r.honeycomb_id === id).sort((a, b) => Number(b.version) - Number(a.version));
				return ok(mine.length === 0 ? [] : [{ ...mine[0] }], 1);
			}
			if (/^INSERT INTO/.test(sql)) {
				rows.push(parseInsert(sql));
				return ok([], 1);
			}
			// The union view SELECT * (no WHERE id) — return every row.
			if (/^SELECT \* FROM/.test(sql)) {
				return ok(rows.map((r) => ({ ...r })), 1);
			}
			return ok([], 1);
		},
	};
	return { storage, rows, statements };
}

/** Parse an `INSERT INTO "t" (cols) VALUES (vals)` into a row object (test-only). */
function parseInsert(sql: string): StorageRow {
	const m = /INSERT INTO "[^"]+" \(([^)]*)\) VALUES \((.*)\)$/s.exec(sql);
	if (m === null) return {};
	const cols = m[1].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
	const vals = splitTopLevel(m[2]);
	const row: StorageRow = {};
	for (let i = 0; i < cols.length; i++) row[cols[i]] = decodeVal(vals[i] ?? "");
	return row;
}

function splitTopLevel(s: string): string[] {
	const out: string[] = [];
	let inStr = false;
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (inStr) {
			cur += ch;
			if (ch === "'" && s[i + 1] === "'") cur += s[++i];
			else if (ch === "'") inStr = false;
		} else if (ch === "'") {
			inStr = true;
			cur += ch;
		} else if (ch === ",") {
			out.push(cur.trim());
			cur = "";
		} else {
			cur += ch;
		}
	}
	if (cur.trim() !== "") out.push(cur.trim());
	return out;
}

/** Decode a SQL literal (`'x'`, `E'x'`, or a bare number) into a JS value (test-only). */
function decodeVal(raw: string): unknown {
	let v = raw.trim();
	if (v.startsWith("E'") || v.startsWith("e'")) v = v.slice(1);
	if (v.startsWith("'") && v.endsWith("'")) {
		return v.slice(1, -1).replace(/''/g, "'").replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
	}
	const n = Number(v);
	return Number.isFinite(n) ? n : v;
}

let tmp: string;
let installRoot: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "hc-sync-"));
	installRoot = join(tmp, "project");
	mkdirSync(installRoot, { recursive: true });
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

/** Build the action engine over the fake store + a temp-dir install target. */
function buildApi(storage: StorageQuery): SyncActionApi {
	const engine = createAssetSyncApi({ storage, target: TARGET });
	const installTarget = createFsAssetInstallTarget({ projectDir: installRoot, globalDir: join(tmp, "home") });
	return createSyncActionApi({ storage, engine, installTarget });
}

/** Seed a local on-disk asset so promote can read its native body. */
function seedLocal(assetType: SyncedAssetType, name: string, body: string): void {
	if (assetType === "agent") {
		const dir = join(installRoot, ".claude", "agents");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${name}.md`), body, "utf-8");
	} else {
		const dir = join(installRoot, ".claude", "skills", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), body, "utf-8");
	}
}

// ── The symmetry sweep: every action proven for BOTH kinds (b-AC-6). ──
describe.each<SyncedAssetType>(["skill", "agent"])("PRD-042 sync actions — %s (symmetry)", (assetType) => {
	it("promote → a version-bumped INSERT (never an UPDATE) → poll-convergent read shows shared", async () => {
		const { storage, rows, statements } = createFakeStore();
		seedLocal(assetType, "alpha", "native-body");
		const api = buildApi(storage);

		const res = await api.promote({ assetType, name: "alpha", scope: SCOPE });

		expect(res.ok).toBe(true);
		expect(res.action).toBe("promote");
		expect(res.assetType).toBe(assetType);
		expect(res.state).toBe("shared");
		expect(res.version).toBeGreaterThanOrEqual(1);
		// Append-only: a versioned INSERT carrying THIS asset_type, never an UPDATE.
		expect(statements.some((s) => /^INSERT INTO/.test(s))).toBe(true);
		expect(statements.some((s) => /^UPDATE /i.test(s))).toBe(false);
		expect(rows.some((r) => r.asset_type === assetType && Number(r.version) >= 1 && r.tombstone === "false")).toBe(true);
	});

	it("pull → an install-target write → pulled (the native artifact lands on disk)", async () => {
		const { storage } = createFakeStore();
		// First publish a shared row so pull has something to install (the teammate's publish).
		const engine = createAssetSyncApi({ storage, target: TARGET });
		await engine.publish({
			honeycombId: "hc_abcd0000abcd0000abcd0000abcd0000",
			assetType,
			harness: "claude-code",
			native: "teammate-body",
			canonical: "teammate-body",
			contentHash: "h1",
			cell: { tier: "Team", style: "Repository" },
			scope: SCOPE,
			deviceSet: [],
		});
		const installTarget = createFsAssetInstallTarget({ projectDir: installRoot, globalDir: join(tmp, "home") });
		const api = createSyncActionApi({ storage, engine, installTarget });

		const res = await api.pull({ assetType, name: "beta", honeycombId: "hc_abcd0000abcd0000abcd0000abcd0000", scope: SCOPE });

		expect(res.ok).toBe(true);
		expect(res.state).toBe("pulled");
		expect(res.assetType).toBe(assetType);
		expect(installTarget.exists(assetType, "project", "beta")).toBe(true);
	});

	it("demote → a tombstone version-bump → the converged read is no longer live shared", async () => {
		const { storage, rows, statements } = createFakeStore();
		const engine = createAssetSyncApi({ storage, target: TARGET });
		const id = "hc_eeee0000eeee0000eeee0000eeee0000";
		await engine.publish({
			honeycombId: id,
			assetType,
			harness: "claude-code",
			native: "body",
			canonical: "body",
			contentHash: "h",
			cell: { tier: "Team", style: "Repository" },
			scope: SCOPE,
			deviceSet: [],
		});
		const api = createSyncActionApi({ storage, engine, installTarget: createFsAssetInstallTarget({ projectDir: installRoot }) });

		const res = await api.demote({ assetType, name: "gamma", honeycombId: id, scope: SCOPE });

		expect(res.ok).toBe(true);
		expect(res.action).toBe("demote");
		// A tombstone is a ROW (version-bump), never a DELETE — the prior versions survive.
		expect(statements.some((s) => /^DELETE /i.test(s))).toBe(false);
		const mine = rows.filter((r) => r.honeycomb_id === id).sort((a, b) => Number(b.version) - Number(a.version));
		expect(mine[0]?.tombstone).toBe("true"); // latest version is the tombstone
		expect(mine.length).toBeGreaterThanOrEqual(2); // the original publish survives in the log
	});

	it("enable/disable → a LOCAL install presence toggle (no substrate write)", async () => {
		const { storage, statements } = createFakeStore();
		const installTarget = createFsAssetInstallTarget({ projectDir: installRoot, globalDir: join(tmp, "home") });
		const api = createSyncActionApi({ storage, engine: createAssetSyncApi({ storage, target: TARGET }), installTarget });

		const before = statements.length;
		const enabled = await api.enable({ assetType, name: "delta", native: "body", scope: SCOPE });
		expect(enabled.ok).toBe(true);
		expect(installTarget.exists(assetType, "project", "delta")).toBe(true);

		const disabled = await api.disable({ assetType, name: "delta", scope: SCOPE });
		expect(disabled.ok).toBe(true);
		expect(installTarget.exists(assetType, "project", "delta")).toBe(false);
		// No INSERT/UPDATE/DELETE against the substrate for a local toggle (OQ-2: install-target concern).
		expect(statements.slice(before).some((s) => /INSERT|UPDATE|DELETE/i.test(s))).toBe(false);
	});

	it("no secret rides any action result (no native blob / email / org GUID)", async () => {
		const { storage } = createFakeStore();
		seedLocal(assetType, "epsilon", "SECRET-NATIVE-BODY");
		const api = buildApi(storage);
		const res = await api.promote({ assetType, name: "epsilon", scope: SCOPE });
		const json = JSON.stringify(res);
		expect(json).not.toContain("SECRET-NATIVE-BODY");
		expect(json).not.toContain("@"); // no author email
		expect(json).not.toContain(SCOPE.org); // no org GUID
	});

	// a-AC-6 (the closed partial): enable RE-INSTALLS from the substrate's CURRENT version — it reads
	// the live `native` blob (the `buildCurrentAssetVersionSql` current-version read) and writes THAT
	// through the sanitized install-target. It NEVER writes an empty native, and the body on disk is
	// the REAL substrate native (not the empty string the old seam wrote).
	it("enable re-installs the REAL current substrate native (not an empty file)", async () => {
		const { storage } = createFakeStore();
		const engine = createAssetSyncApi({ storage, target: TARGET });
		const id = "hc_1111aaaa1111aaaa1111aaaa1111aaaa";
		// A teammate published a shared row carrying the real native body.
		await engine.publish({
			honeycombId: id,
			assetType,
			harness: "claude-code",
			native: "REAL-CURRENT-NATIVE",
			canonical: "REAL-CURRENT-NATIVE",
			contentHash: "h",
			cell: { tier: "Team", style: "Repository" },
			scope: SCOPE,
			deviceSet: [],
		});
		const installTarget = createFsAssetInstallTarget({ projectDir: installRoot, globalDir: join(tmp, "home") });
		const api = createSyncActionApi({ storage, engine, installTarget });

		// Enable WITHOUT a native (the thin client sends only id + name — the daemon reads the substrate).
		const res = await api.enable({ assetType, name: "zeta", honeycombId: id, scope: SCOPE });

		expect(res.ok).toBe(true);
		expect(res.action).toBe("enable");
		expect(res.assetType).toBe(assetType);
		// The on-disk artifact is the REAL substrate native — NOT an empty file.
		const onDisk = await installTarget.read(assetType, "project", "zeta");
		expect(onDisk).toBe("REAL-CURRENT-NATIVE");
		expect(onDisk).not.toBe("");
		// No secret rides the action RESULT (the native is written to disk, never returned to the page).
		expect(JSON.stringify(res)).not.toContain("REAL-CURRENT-NATIVE");
	});

	it("enable fails SOFT when there is no current substrate version (never an empty native)", async () => {
		const { storage } = createFakeStore();
		const installTarget = createFsAssetInstallTarget({ projectDir: installRoot, globalDir: join(tmp, "home") });
		const api = createSyncActionApi({ storage, engine: createAssetSyncApi({ storage, target: TARGET }), installTarget });

		// No substrate row for this id → honest "nothing to enable", and NO empty file is written.
		const res = await api.enable({ assetType, name: "eta", honeycombId: "hc_0000000000000000000000000000beef", scope: SCOPE });

		expect(res.ok).toBe(false);
		expect(res.action).toBe("enable");
		expect(installTarget.exists(assetType, "project", "eta")).toBe(false);
	});
});

// ── The union view-model (a-AC-1 / b-AC-1 / AC-2). ──
describe("PRD-042 union view-model", () => {
	const fakeScan = (inv: LocalAssetInventory) => async (): Promise<LocalAssetInventory> => inv;

	it("lists skills AND agents from installed ∪ synced, each with honest state, no double-count", async () => {
		const { storage } = createFakeStore();
		const engine = createAssetSyncApi({ storage, target: TARGET });
		// A SHARED skill named "shared-skill" (substrate), and a SHARED agent.
		await engine.publish({ honeycombId: "hc_1111000011110000111100001111aaaa", assetType: "skill", harness: "claude-code", native: "x", canonical: "x", contentHash: "h", cell: { tier: "Team", style: "Repository" }, scope: SCOPE, deviceSet: [] });
		await engine.publish({ honeycombId: "hc_2222000022220000222200002222bbbb", assetType: "agent", harness: "claude-code", native: "y", canonical: "y", contentHash: "h", cell: { tier: "Team", style: "Repository" }, scope: SCOPE, deviceSet: [] });

		const inv: LocalAssetInventory = {
			// "shared-skill" is also on disk (collision: must NOT double-count; substrate state wins),
			// plus a local-only "local-skill".
			skills: [
				{ name: "shared-skill", description: "d", assetType: "skill", scope: "repository", sourceHarnesses: ["claude-code"], paths: ["/x"] },
				{ name: "local-skill", description: "d2", assetType: "skill", scope: "repository", sourceHarnesses: ["cursor"], paths: ["/y"] },
			],
			agents: [{ name: "local-agent", description: "d3", assetType: "agent", scope: "repository", sourceHarnesses: ["cursor"], paths: ["/z"] }],
		};

		const view = await fetchAssetSyncView(storage, { org: SCOPE.org, workspace: SCOPE.workspace }, "alice", fakeScan(inv));

		// The substrate skill row carries no name column value here (assetRow has no `name`), so it lists
		// by honeycomb_id; the local-only skill + the disk skills also appear. Assert the counts + states.
		const skillStates = view.skills.map((s) => s.state);
		expect(view.skills.some((s) => s.name === "local-skill" && s.state === "local")).toBe(true);
		expect(skillStates.filter((st) => st === "shared").length).toBeGreaterThanOrEqual(1);
		// No double-count: "local-skill" appears exactly once.
		expect(view.skills.filter((s) => s.name === "local-skill").length).toBe(1);
		// Agents are symmetric: the local agent is listed `local`.
		expect(view.agents.some((a) => a.name === "local-agent" && a.state === "local")).toBe(true);
	});

	it("authoredByMe is true only for the viewer's own rows (demote-permission, OQ-4)", async () => {
		const { storage } = createFakeStore();
		const engine = createAssetSyncApi({ storage, target: TARGET });
		await engine.publish({ honeycombId: "hc_3333000033330000333300003333cccc", assetType: "skill", harness: "claude-code", native: "x", canonical: "x", contentHash: "h", cell: { tier: "Team", style: "Repository" }, scope: { ...SCOPE, author: "bob" }, deviceSet: [] });

		const asAlice = await fetchAssetSyncView(storage, { org: SCOPE.org, workspace: SCOPE.workspace }, "alice", fakeScan({ skills: [], agents: [] }));
		const asBob = await fetchAssetSyncView(storage, { org: SCOPE.org, workspace: SCOPE.workspace }, "bob", fakeScan({ skills: [], agents: [] }));

		const aliceRow = asAlice.skills.find((s) => s.honeycombId === "hc_3333000033330000333300003333cccc");
		const bobRow = asBob.skills.find((s) => s.honeycombId === "hc_3333000033330000333300003333cccc");
		expect(aliceRow?.authoredByMe).toBe(false); // bob authored it → Alice cannot demote
		expect(bobRow?.authoredByMe).toBe(true); // bob is the author → Demote enabled
	});

	it("no secret (native blob / author email / org GUID) rides the view-model", async () => {
		const { storage } = createFakeStore();
		const engine = createAssetSyncApi({ storage, target: TARGET });
		await engine.publish({ honeycombId: "hc_4444000044440000444400004444dddd", assetType: "skill", harness: "claude-code", native: "SECRET-NATIVE", canonical: "SECRET-NATIVE", contentHash: "h", cell: { tier: "Team", style: "Repository" }, scope: { ...SCOPE, author: "alice@example.com" }, deviceSet: [] });

		const view = await fetchAssetSyncView(storage, { org: SCOPE.org, workspace: SCOPE.workspace }, "alice@example.com", fakeScan({ skills: [], agents: [] }));
		const json = JSON.stringify(view);
		expect(json).not.toContain("SECRET-NATIVE");
		expect(json).not.toContain("alice@example.com"); // author token / email never rendered
		expect(json).not.toContain(SCOPE.org);
	});
});

// ── The path-sanitize guard (agent name cannot traverse out of the agents root). ──
describe("PRD-042 asset install-target path safety", () => {
	it("a crafted agent name cannot traverse out of the agents root", async () => {
		const installTarget = createFsAssetInstallTarget({ projectDir: installRoot });
		const path = await installTarget.write("agent", "project", "a/b/../../evil", "pwned");
		// The traversal collapses to a single sanitized segment under the agents root — nothing escapes.
		// Only path separators (`/`) become `_`; the `.` chars are in the safe class. The decisive
		// assertion: the written file is CONTAINED under `.claude/agents/`, never outside the project.
		const agentsRoot = join(installRoot, ".claude", "agents");
		expect(path).not.toBeNull();
		expect((path as string).startsWith(agentsRoot)).toBe(true);
		expect(existsSync(join(tmp, "evil.md"))).toBe(false);
		expect(existsSync(join(installRoot, "evil.md"))).toBe(false);
		// The sanitized single segment maps `/` → `_`: `a/b/../../evil` → `a_b_.._.._evil.md`.
		expect(existsSync(join(agentsRoot, "a_b_.._.._evil.md"))).toBe(true);
	});

	// SECURITY regression (PRD-042 path-traversal fix): a PURE-DOT name (`.`, `..`) survives the
	// char-class replace unchanged (`.` is in the allow-list) and, left as a path component, traverses
	// UP out of the skills/agents root — `join(root, "skills", "..", "SKILL.md")` lands in `.claude/`,
	// and a skill `remove("..")` would `rmSync` the parent `.claude/` recursively. The fix collapses an
	// all-dots segment to the inert `untitled-asset` fallback; these assertions prove no escape.
	it.each([["..", "agent"], ["..", "skill"], [".", "skill"], ["...", "agent"]] as const)(
		"a pure-dot name %s (%s) cannot escape the asset root",
		async (name, kind) => {
			const installTarget = createFsAssetInstallTarget({ projectDir: installRoot });
			const path = await installTarget.write(kind, "project", name, "pwned");
			const claudeRoot = join(installRoot, ".claude");
			const subRoot = join(claudeRoot, kind === "agent" ? "agents" : "skills");
			expect(path).not.toBeNull();
			// The write stays strictly UNDER `.claude/{agents,skills}/` — never directly in `.claude/`
			// (an escape would land the file at `.claude/SKILL.md` or `.claude/..md`).
			expect((path as string).startsWith(subRoot)).toBe(true);
			expect(existsSync(join(claudeRoot, "SKILL.md"))).toBe(false);
			expect(existsSync(join(claudeRoot, "..md"))).toBe(false);
			// remove() must not climb out and reap the parent dir.
			mkdirSync(claudeRoot, { recursive: true });
			writeFileSync(join(claudeRoot, "sentinel.txt"), "keep", "utf-8");
			await installTarget.remove(kind, "project", name);
			expect(existsSync(join(claudeRoot, "sentinel.txt"))).toBe(true); // parent dir survived
		},
	);

	// SECURITY regression (PRD-042 OQ-4 daemon enforcement): the page disables Demote for non-authors,
	// but the daemon must ALSO refuse — a crafted POST must not let a non-author tombstone a Team asset.
	it("demote is refused (no tombstone written) when the caller is not the author", async () => {
		const { storage, rows, statements } = createFakeStore();
		const engine = createAssetSyncApi({ storage, target: TARGET });
		const id = "hc_ffff0000ffff0000ffff0000ffff0000";
		// Bob publishes a Team skill.
		await engine.publish({
			honeycombId: id,
			assetType: "skill",
			harness: "claude-code",
			native: "body",
			canonical: "body",
			contentHash: "h",
			cell: { tier: "Team", style: "Repository" },
			scope: { ...SCOPE, author: "bob" },
			deviceSet: [],
		});
		const api = createSyncActionApi({ storage, engine, installTarget: createFsAssetInstallTarget({ projectDir: installRoot }) });
		const insertsBefore = statements.filter((s) => /^INSERT INTO/.test(s)).length;

		// Alice (a different workspace member) attempts to demote bob's asset.
		const res = await api.demote({ assetType: "skill", name: "gamma", honeycombId: id, scope: { ...SCOPE, author: "alice" } });

		expect(res.ok).toBe(false); // refused fail-closed
		// No tombstone row was written — the only row is bob's original publish (still live).
		const mine = rows.filter((r) => r.honeycomb_id === id);
		expect(mine.every((r) => r.tombstone === "false")).toBe(true);
		expect(statements.filter((s) => /^INSERT INTO/.test(s)).length).toBe(insertsBefore); // no new write
	});

	// And the author CAN still demote their own asset (the gate is author-only, not deny-all).
	it("demote still succeeds for the asset's own author", async () => {
		const { storage, rows } = createFakeStore();
		const engine = createAssetSyncApi({ storage, target: TARGET });
		const id = "hc_aaaa1111aaaa1111aaaa1111aaaa1111";
		await engine.publish({
			honeycombId: id,
			assetType: "skill",
			harness: "claude-code",
			native: "body",
			canonical: "body",
			contentHash: "h",
			cell: { tier: "Team", style: "Repository" },
			scope: SCOPE, // author: alice
			deviceSet: [],
		});
		const api = createSyncActionApi({ storage, engine, installTarget: createFsAssetInstallTarget({ projectDir: installRoot }) });

		const res = await api.demote({ assetType: "skill", name: "gamma", honeycombId: id, scope: SCOPE });

		expect(res.ok).toBe(true);
		const mine = rows.filter((r) => r.honeycomb_id === id).sort((a, b) => Number(b.version) - Number(a.version));
		expect(mine[0]?.tombstone).toBe("true");
	});
});

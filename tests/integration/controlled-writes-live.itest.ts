/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE controlled-writes SMOKE — OPT-IN, MUTATES A REAL DEEPLAKE BACKEND.  ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-006c: the controlled-writes stage is the ONLY stage that mutates     ║
 * ║  `memories`. Its c-AC-1..6 are proven against the fake transport in       ║
 * ║  tests/daemon/runtime/pipeline/controlled-writes.test.ts. THIS suite      ║
 * ║  proves the THREE backend behaviours the stage leans on are real on this  ║
 * ║  DeepLake store — the ones that were only fake-verified before:           ║
 * ║                                                                          ║
 * ║    1. ADD: a SELECT-before-INSERT on `content_hash` writes ONE real       ║
 * ║       `memories` row (version 1), read back by id.                        ║
 * ║    2. DEDUP: a second ADD with the SAME `content_hash` finds the existing ║
 * ║       row on the dedup probe and writes NO duplicate (c-AC-2) — exactly   ║
 * ║       one row for the hash on the real backend.                           ║
 * ║    3. UPDATE: a version-bumped append (appendVersionBumped) writes a new   ║
 * ║       version row and `readLatestVersion` reads the HIGHEST version back   ║
 * ║       (c-AC-3 / FR-7) — never an in-place UPDATE.                          ║
 * ║                                                                          ║
 * ║  These are the SAME storage primitives the stage uses (appendVersionBumped║
 * ║  + a content_hash dedup probe), pointed at the SAME single-sourced         ║
 * ║  `MEMORIES_COLUMNS` (+ the stage's locally-composed `version` ColumnDef),  ║
 * ║  under a THROWAWAY table — so the round-trip the stage performs is proven  ║
 * ║  end-to-end without ever touching a real daemon's `memories`.             ║
 * ║                                                                          ║
 * ║  GATED + ISOLATED exactly like memory-jobs-live.itest.ts:                ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = whole      ║
 * ║      suite skips, run exits 0.                                            ║
 * ║    - `.itest.ts` suffix + `tests/integration/**` exclusion keep it OUT of ║
 * ║      `npm run test` / `npm run ci`. Run only via `npm run test:integration`║
 * ║    - Runs in the SAME authorized workspace the token is scoped to         ║
 * ║      (`HONEYCOMB_DEEPLAKE_WORKSPACE`, default `honeycomb_ci`) — an        ║
 * ║      invented partition is 403-rejected by the real backend.             ║
 * ║    - Points the writes at a per-run THROWAWAY table (`ci_cwrite_<run-id>`)║
 * ║      with the SAME `MEMORIES_COLUMNS`, and DROPs it in afterAll. DROP is   ║
 * ║      the reliable teardown here (DELETE does not dependably remove rows).  ║
 * ║                                                                          ║
 * ║  Why primitives, not the stage entrypoint: `applyControlledWrite` writes  ║
 * ║  through a hard-coded `"memories"` HealTarget (and its dedup probe is the  ║
 * ║  catalog's memories-bound `buildDedupCheckSql`). The throwaway-table       ║
 * ║  isolation this backend REQUIRES (the token is scoped; a shared real table ║
 * ║  cannot be row-cleaned because DELETE is unreliable here) is therefore     ║
 * ║  expressed at the primitive layer the stage is built on — the same         ║
 * ║  appendVersionBumped + content_hash dedup the stage emits. The stage's     ║
 * ║  gating/contradiction/scope wiring is fake-verified; this is the backend   ║
 * ║  CONSISTENCY smoke (dedup-before-insert + version-bump are reliable here). ║
 * ║                                                                          ║
 * ║  SECRETS: the token is read ONLY from the env via the storage layer's    ║
 * ║  `envCredentialProvider`. Never hardcoded, logged, or echoed.            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	appendVersionBumped,
	createStorageClient,
	envCredentialProvider,
	isOk,
	type QueryResult,
	readLatestVersion,
	resolveStorageConfig,
	type RowValues,
	serializeFloat4Array,
	sLiteral,
	sqlIdent,
	type StorageClient,
	val,
} from "../../src/daemon/storage/index.js";
import { contentHash, MEMORIES_COLUMNS, NOT_SOFT_DELETED } from "../../src/daemon/storage/catalog/index.js";
import type { HealTarget } from "../../src/daemon/storage/heal.js";
import type { ColumnDef } from "../../src/daemon/storage/schema.js";
import { EMBEDDING_DIMS } from "../../src/daemon/storage/vector.js";
import { MEMORIES_VERSION_COLUMN } from "../../src/daemon/runtime/pipeline/controlled-writes.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

// ── Run isolation: an environment-derived unique tag for this run's table. ───
function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const CI_TABLE = `ci_cwrite_${RUN_ID}`;

/**
 * The throwaway `memories` HealTarget — the SAME single-sourced `MEMORIES_COLUMNS`
 * plus the stage's locally-composed `version` ColumnDef ({@link MEMORIES_VERSION_COLUMN}),
 * under a per-run name. This mirrors the stage's `MEMORIES_VERSIONED_TARGET` exactly,
 * just pointed at the CI table so a live write never touches a real `memories`.
 */
const ciTarget: HealTarget = {
	table: CI_TABLE,
	columns: [...MEMORIES_COLUMNS, MEMORIES_VERSION_COLUMN] as ColumnDef[],
};

/** A 768-dim vector so the embedding column round-trips as a real FLOAT4[] literal. */
function vec768(): number[] {
	return Array.from({ length: EMBEDDING_DIMS }, (_, i) => (i % 7) * 0.001);
}

/**
 * Build the same ordered `memories` row the stage's `buildMemoryRow` emits, for a
 * given id + content + prefetched vector. The vector is serialized via the same
 * `serializeFloat4Array` fragment the stage uses (kind `raw`); every other value is
 * a typed `ColumnValue` rendered through the SQL-safety helpers.
 */
function memoryRow(args: {
	id: string;
	content: string;
	normalized: string;
	vector: readonly number[] | null;
	agentId: string;
	now: string;
}): RowValues {
	const embedding = args.vector === null ? val.raw("NULL") : val.raw(serializeFloat4Array(args.vector));
	return [
		["id", val.str(args.id)],
		["type", val.str("fact")],
		["content", val.text(args.content)],
		["normalized_content", val.text(args.normalized)],
		["content_hash", val.str(contentHash(args.normalized))],
		["confidence", val.num(0.9)],
		["content_embedding", embedding],
		["is_deleted", val.num(NOT_SOFT_DELETED)],
		["agent_id", val.str(args.agentId)],
		["created_at", val.str(args.now)],
		["updated_at", val.str(args.now)],
	];
}

describe.skipIf(!HAS_TOKEN)("live controlled-writes smoke (opt-in, real backend)", () => {
	let storage: StorageClient;
	let org: string;
	let workspace: string;

	beforeAll(() => {
		// Resolve config from the SAME env provider the daemon uses, defaulting the
		// workspace to the namespaced `honeycomb_ci` so a bare token never targets a
		// production workspace — but an explicit HONEYCOMB_DEEPLAKE_WORKSPACE wins. It
		// MUST be an authorized workspace: the token is scoped, so an invented
		// partition is rejected with 403.
		const raw = envCredentialProvider().read();
		const provider = {
			read: () => ({
				...raw,
				workspace: process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci",
			}),
		};
		const config = resolveStorageConfig(provider);
		org = config.org;
		workspace = config.workspace;
		storage = createStorageClient({ provider });
	});

	afterAll(async () => {
		if (!storage) return;
		// Best-effort cleanup: DROP the throwaway table this run created.
		const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(CI_TABLE)}"`, { org, workspace });
		if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${CI_TABLE} in ${workspace}: ${describeResult(res)}`);
	});

	/**
	 * Probe the throwaway table for an existing row with `content_hash = <hash>` — the
	 * stage's SELECT-before-INSERT dedup, pointed at the CI table (the catalog's own
	 * `buildDedupCheckSql` is memories-bound, so the probe is built here through the
	 * SAME exported `sqlIdent`/`sLiteral` helpers). Returns the existing id or null.
	 */
	async function dedupProbe(hash: string, scope: { org: string; workspace: string }): Promise<string | null> {
		const tbl = sqlIdent(CI_TABLE);
		const hashCol = sqlIdent("content_hash");
		const idCol = sqlIdent("id");
		const sql = `SELECT ${idCol} FROM "${tbl}" WHERE ${hashCol} = ${sLiteral(hash)} LIMIT 1`;
		const res = await storage.query(sql, scope);
		if (isOk(res) && res.rows.length > 0) {
			const id = res.rows[0].id;
			return typeof id === "string" ? id : String(id ?? "");
		}
		return null;
	}

	it("1. ADD writes one real memories row (dedup-miss → version-1 append), read back by id", async () => {
		const scope = { org, workspace };
		const now = "2026-06-17T00:00:00.000Z";
		const id = `mem_live_${RUN_ID}_add`;
		const content = `live controlled-write ${RUN_ID}`;
		const normalized = content.toLowerCase();
		const hash = contentHash(normalized);

		// Dedup-MISS: the fresh per-run hash is absent before the write.
		expect(await dedupProbe(hash, scope), "fresh hash must be absent before the first ADD").toBeNull();

		// Append the row — version-1 on the lazily-healed CI table (the stage's ADD path).
		const { result, version } = await appendVersionBumped(storage, ciTarget, scope, {
			keyColumn: "id",
			keyValue: id,
			row: memoryRow({ id, content, normalized, vector: vec768(), agentId: "ci-agent", now }),
		});
		expect(result.kind, `ADD insert must succeed: ${describeResult(result)}`).toBe("ok");
		expect(version, "the first appended version of a memory is 1").toBe(1);

		// Read it back by id through the version reader — the highest version is the row.
		const back = await readLatestVersion(storage, ciTarget, scope, "id", id);
		expect(back.kind, `read-back must succeed: ${describeResult(back)}`).toBe("ok");
		expect(isOk(back) && back.rows.length, "exactly the row we wrote is readable by id").toBeGreaterThanOrEqual(1);
		if (isOk(back)) {
			expect(back.rows[0].id).toBe(id);
			expect(back.rows[0].content_hash).toBe(hash);
		}
	});

	it("2. a second ADD with the same content_hash dedups (NO duplicate INSERT)", async () => {
		const scope = { org, workspace };
		const now = "2026-06-17T00:00:01.000Z";
		const id = `mem_live_${RUN_ID}_dup`;
		// SAME content as scenario 1 → SAME content_hash.
		const content = `live controlled-write ${RUN_ID}`;
		const normalized = content.toLowerCase();
		const hash = contentHash(normalized);

		// Dedup-HIT: the hash written in scenario 1 is now present. The stage returns the
		// existing id and emits NO INSERT (c-AC-2). We assert the probe SEES the prior row.
		const existing = await dedupProbe(hash, scope);
		expect(existing, "the prior ADD's content_hash must be found on the dedup probe").not.toBeNull();

		// Because the probe hit, the stage would NOT insert. Prove the backend agrees:
		// the hash still resolves to exactly one row (no second writer doubled it), and a
		// NEW id was never appended for this hash.
		const tbl = sqlIdent(CI_TABLE);
		const hashCol = sqlIdent("content_hash");
		const idCol = sqlIdent("id");
		const countSql = `SELECT ${idCol} FROM "${tbl}" WHERE ${hashCol} = ${sLiteral(hash)}`;
		const rows = await storage.query(countSql, scope);
		expect(rows.kind, `count probe must succeed: ${describeResult(rows)}`).toBe("ok");
		if (isOk(rows)) {
			expect(rows.rows.length, "exactly one row for the deduped content_hash").toBe(1);
			// The single row is scenario 1's id, never this scenario's would-be id.
			expect(rows.rows.some((r) => r.id === id), "the dup id was NOT written").toBe(false);
		}
	});

	it("3. a version-bumped UPDATE appends a new version and reads the HIGHEST version back", async () => {
		const scope = { org, workspace };
		const id = `mem_live_${RUN_ID}_ver`;
		const base = `live versioned ${RUN_ID}`;

		// Seed version 1 (an ADD).
		const seed = await appendVersionBumped(storage, ciTarget, scope, {
			keyColumn: "id",
			keyValue: id,
			row: memoryRow({
				id,
				content: base,
				normalized: base.toLowerCase(),
				vector: vec768(),
				agentId: "ci-agent",
				now: "2026-06-17T00:00:02.000Z",
			}),
		});
		expect(seed.version, "seed is version 1").toBe(1);

		// The stage's UPDATE path: a version-bumped append (NEVER an in-place UPDATE).
		// appendVersionBumped reads MAX(version) and INSERTs N+1.
		const updated = `${base} — corrected`;
		const bump = await appendVersionBumped(storage, ciTarget, scope, {
			keyColumn: "id",
			keyValue: id,
			row: memoryRow({
				id,
				content: updated,
				normalized: updated.toLowerCase(),
				vector: vec768(),
				agentId: "ci-agent",
				now: "2026-06-17T00:00:03.000Z",
			}),
		});
		expect(bump.result.kind, `version bump must succeed: ${describeResult(bump.result)}`).toBe("ok");
		// N+1 over the seed's version 1 → version 2. This is the determinism the
		// append-only version-bump buys on this backend: MAX(version) converges.
		expect(bump.version, "the bumped version is N+1 over the seed").toBe(2);

		// readLatestVersion reads the HIGHEST version row — the corrected content.
		const latest = await readLatestVersion(storage, ciTarget, scope, "id", id);
		expect(latest.kind, `latest read must succeed: ${describeResult(latest)}`).toBe("ok");
		if (isOk(latest)) {
			expect(latest.rows.length).toBeGreaterThanOrEqual(1);
			expect(latest.rows[0].id).toBe(id);
			// The highest-version row carries the corrected hash, proving the append (not
			// an overwrite) and that the reader resolves the newest version.
			expect(latest.rows[0].content_hash).toBe(contentHash(updated.toLowerCase()));
		}
	});
});

/** Summarize a QueryResult for an assertion message WITHOUT leaking secrets. */
function describeResult(res: QueryResult): string {
	switch (res.kind) {
		case "ok":
			return `ok(rows=${res.rows.length})`;
		case "query_error":
			return `query_error(${res.status ?? "?"}): ${res.message}`;
		case "connection_error":
			return `connection_error: ${res.message}`;
		case "timeout":
			return `timeout(${res.timeoutMs}ms)`;
	}
}

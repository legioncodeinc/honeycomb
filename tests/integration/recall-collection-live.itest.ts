/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE recall-collection SMOKE — OPT-IN, SEEDS A REAL DEEPLAKE BACKEND.    ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-007a: candidate collection (FTS + GPU vector channels) is proven      ║
 * ║  against the fake transport in tests/daemon/runtime/recall/collection.test.║
 * ║  ts. THIS suite proves the TWO channel queries the collector emits return  ║
 * ║  REAL memory IDs from a REAL `memories`-shaped table on this DeepLake store:║
 * ║                                                                          ║
 * ║    1. FTS: the BM25-style ILIKE channel (buildFtsSql) returns the IDs of   ║
 * ║       the seeded rows whose `content` matches the term, IDs+score only.    ║
 * ║    2. VECTOR: the GPU `<#>` channel (buildVectorSearchSql) returns IDs by  ║
 * ║       cosine similarity over the seeded 768-dim `content_embedding`,        ║
 * ║       over-fetching 3x — IDs+score only.                                   ║
 * ║                                                                          ║
 * ║  These are the SAME builders the collector emits (buildFtsSql /            ║
 * ║  buildVectorSearchSql), pointed at a THROWAWAY table seeded with a couple  ║
 * ║  rows from the single-sourced MEMORIES_COLUMNS, DROPped in afterAll.       ║
 * ║                                                                          ║
 * ║  GATED + ISOLATED exactly like controlled-writes-live.itest.ts:           ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = whole       ║
 * ║      suite skips, run exits 0.                                            ║
 * ║    - `.itest.ts` suffix keeps it OUT of `npm run test` / `npm run ci`.     ║
 * ║      Run only via `npm run test:integration`.                            ║
 * ║    - Seeds a per-run THROWAWAY table (`ci_recall_<run-id>`) with the SAME  ║
 * ║      MEMORIES_COLUMNS, and DROPs it in afterAll.                          ║
 * ║                                                                          ║
 * ║  SECRETS: the token is read ONLY from the env via the storage layer's    ║
 * ║  `envCredentialProvider`. Never hardcoded, logged, or echoed.            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	appendOnlyInsert,
	createStorageClient,
	envCredentialProvider,
	isOk,
	resolveStorageConfig,
	type RowValues,
	serializeFloat4Array,
	sqlIdent,
	type StorageClient,
	val,
} from "../../src/daemon/storage/index.js";
import { MEMORIES_COLUMNS, NOT_SOFT_DELETED } from "../../src/daemon/storage/catalog/index.js";
import type { HealTarget } from "../../src/daemon/storage/heal.js";
import { EMBEDDING_DIMS } from "../../src/daemon/storage/vector.js";
import { buildFtsSql } from "../../src/daemon/runtime/recall/collection.js";
import { buildVectorSearchSql } from "../../src/daemon/storage/vector.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const CI_TABLE = `ci_recall_${RUN_ID}`;
const AGENT = "ci-recall-agent";

/** The throwaway `memories`-shaped HealTarget (single-sourced MEMORIES_COLUMNS). */
const ciTarget: HealTarget = { table: CI_TABLE, columns: [...MEMORIES_COLUMNS] };

/** A deterministic 768-dim unit-ish vector, biased so two rows differ in cosine. */
function vec768(bias: number): number[] {
	return Array.from({ length: EMBEDDING_DIMS }, (_, i) => (i === 0 ? bias : 0.001));
}

/** Build a seed `memories` row (IDs-only recall reads it; we seed content+embedding). */
function seedRow(args: { id: string; content: string; vector: readonly number[]; now: string }): RowValues {
	return [
		["id", val.str(args.id)],
		["type", val.str("fact")],
		["content", val.text(args.content)],
		["normalized_content", val.text(args.content.toLowerCase())],
		["content_hash", val.str(`hash-${args.id}`)],
		["content_embedding", val.raw(serializeFloat4Array(args.vector))],
		["is_deleted", val.num(NOT_SOFT_DELETED)],
		["agent_id", val.str(AGENT)],
		["created_at", val.str(args.now)],
		["updated_at", val.str(args.now)],
	];
}

function describeResult(r: { kind: string }): string {
	return r.kind;
}

describe.skipIf(!HAS_TOKEN)("live recall-collection smoke (opt-in, real backend)", () => {
	let storage: StorageClient;
	let org: string;
	let workspace: string;

	beforeAll(async () => {
		const raw = envCredentialProvider().read();
		const provider = {
			read: () => ({
				...raw,
				workspace: process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci",
				// First-touch on a fresh throwaway table lazily heals (CREATE TABLE +
				// retry), which can exceed the 10s default. Give the live round-trip room.
				queryTimeoutMs: 120_000,
			}),
		};
		const config = resolveStorageConfig(provider);
		org = config.org;
		workspace = config.workspace;
		storage = createStorageClient({ provider });

		const scope = { org, workspace };
		const now = "2026-06-17T00:00:00.000Z";
		// Seed two rows: one matching the FTS term, both with distinct embeddings.
		// appendOnlyInsert lazily heals/creates the CI table from MEMORIES_COLUMNS.
		const r1 = await appendOnlyInsert(
			storage,
			ciTarget,
			scope,
			seedRow({ id: `rec_${RUN_ID}_1`, content: `the daemon binds the socket ${RUN_ID}`, vector: vec768(0.9), now }),
		);
		expect(r1.kind, `seed 1 must succeed: ${describeResult(r1)}`).toBe("ok");
		const r2 = await appendOnlyInsert(
			storage,
			ciTarget,
			scope,
			seedRow({ id: `rec_${RUN_ID}_2`, content: `an unrelated note about coffee ${RUN_ID}`, vector: vec768(-0.9), now }),
		);
		expect(r2.kind, `seed 2 must succeed: ${describeResult(r2)}`).toBe("ok");
	});

	afterAll(async () => {
		if (!storage) return;
		const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(CI_TABLE)}"`, { org, workspace });
		if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${CI_TABLE} in ${workspace}: ${describeResult(res)}`);
	});

	it("FTS channel returns the seeded row id whose content matches the term (IDs+score, no content)", async () => {
		const scope = { org, workspace };
		// buildFtsSql is table-agnostic via the `memories` constant — re-point at the CI
		// table by issuing the SAME shape against it. The collector emits this builder.
		const sql = buildFtsSql({ term: `binds the socket ${RUN_ID}`, agentId: AGENT, limit: 20 }).replace(
			'FROM "memories"',
			`FROM "${sqlIdent(CI_TABLE)}"`,
		);
		const res = await storage.query(sql, scope);
		expect(res.kind, `FTS query must succeed: ${describeResult(res)}`).toBe("ok");
		if (isOk(res)) {
			const ids = res.rows.map((r) => String(r.id));
			expect(ids).toContain(`rec_${RUN_ID}_1`);
			// IDs + score only — no content column came back.
			for (const row of res.rows) {
				expect(row.content).toBeUndefined();
				expect(typeof row.score === "number" || typeof row.score === "string").toBe(true);
			}
		}
	});

	it("VECTOR channel returns IDs by `<#>` cosine over the seeded 768-dim embeddings, over-fetch 3x", async () => {
		const scope = { org, workspace };
		// Query vector aligned with row 1 (bias +0.9) → it should rank above row 2.
		const sql = buildVectorSearchSql({
			table: CI_TABLE,
			idColumn: "id",
			embeddingColumn: "content_embedding",
			queryVector: vec768(0.9),
			scope: { agentColumn: "agent_id", agentValue: AGENT },
			limit: 20,
			overFetchMultiplier: 3,
		});
		// Over-fetch is observable in the emitted SQL.
		expect(sql).toMatch(/LIMIT 60\b/);
		const res = await storage.query(sql, scope);
		expect(res.kind, `vector query must succeed: ${describeResult(res)}`).toBe("ok");
		if (isOk(res)) {
			const ids = res.rows.map((r) => String(r.id));
			expect(ids).toContain(`rec_${RUN_ID}_1`);
			// The aligned row 1 outranks the anti-aligned row 2.
			const idx1 = ids.indexOf(`rec_${RUN_ID}_1`);
			const idx2 = ids.indexOf(`rec_${RUN_ID}_2`);
			if (idx2 >= 0) expect(idx1).toBeLessThan(idx2);
		}
	});
});

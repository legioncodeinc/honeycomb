/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE RETENTION PURGE SMOKE — OPT-IN, MUTATES A REAL DEEPLAKE BACKEND.    ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  THIS SUITE WRITES TO A REAL DEEPLAKE ORG. It is the D-8 PROOF: it        ║
 * ║  verifies LIVE which purge mechanism ACTUALLY removes a memory from       ║
 * ║  recall on this backend, because DeepLake hard `DELETE` is UNRELIABLE     ║
 * ║  (PRD-004 verified rows persist after a DELETE; the queue cleans up with  ║
 * ║  DROP). The retention sweep is therefore built on a TOMBSTONE             ║
 * ║  (`is_deleted=1`) that the `NOT_SOFT_DELETED` recall filter honours       ║
 * ║  IMMEDIATELY, with a best-effort DELETE behind it. This suite proves the  ║
 * ║  row is NO LONGER RECALLED after the sweep's mechanism runs — the         ║
 * ║  load-bearing guarantee — whether or not the physical DELETE landed.      ║
 * ║                                                                          ║
 * ║  GATED:                                                                   ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` — no token → SKIP, 0.   ║
 * ║    - NEVER part of `npm run test` / `npm run ci` — the `.itest.ts` suffix ║
 * ║      is outside the default glob; run only via `npm run test:integration`.║
 * ║                                                                          ║
 * ║  ISOLATION (do not weaken) — same shape as the memory-jobs live smoke:    ║
 * ║    - Runs in the SAME authorized workspace the daemon uses                ║
 * ║      (`HONEYCOMB_DEEPLAKE_WORKSPACE`, default `honeycomb_ci`). An invented ║
 * ║      partition is 403-rejected by the scoped token, so we never invent    ║
 * ║      one.                                                                 ║
 * ║    - Does NOT use the production `memories` name. It heals a per-run,      ║
 * ║      namespaced THROWAWAY table (`ci_retain_<run-id>`) with the SAME       ║
 * ║      `memories` ColumnDef array (so the embedding column + `is_deleted`    ║
 * ║      shape are identical), exercises the EXACT tombstone → null-embedding  ║
 * ║      → DELETE sequence the sweep emits against it, and `afterAll` DROPs    ║
 * ║      it (DROP is the reliable teardown on this backend).                   ║
 * ║    - Run-id is env-derived (GITHUB_RUN_ID / HONEYCOMB_CI_RUN_ID, clock     ║
 * ║      fallback) so two concurrent runs never collide.                      ║
 * ║                                                                          ║
 * ║  SECRETS: the token is read ONLY from the env via the storage layer's    ║
 * ║  `envCredentialProvider`. Never hardcoded, logged, or echoed.            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * What it proves (the D-8 live round-trips that the fake cannot):
 *   1. TOMBSTONE removes a row from recall: a seeded memory, then marked
 *      `is_deleted=1`, is no longer returned by a `NOT_SOFT_DELETED`-filtered
 *      recall read — the mechanism the sweep relies on to stop recall.
 *   2. The full retire sequence (null-embedding → DELETE) runs without error and
 *      the row is GONE from recall afterwards — the row + its vector are retired
 *      together (FR-5 / e-AC-3), with the tombstone guaranteeing the
 *      not-recalled outcome regardless of whether the physical DELETE landed.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	buildCreateTableSql,
	type ConvergeBudgetOverride,
	createStorageClient,
	envCredentialProvider,
	isOk,
	type QueryResult,
	readConverged,
	resolveStorageConfig,
	type StorageClient,
	sLiteral,
	sqlIdent,
} from "../../src/daemon/storage/index.js";

/**
 * The GENEROUS convergence budget the recall-count read-backs honor (PRD-034a immediacy
 * relaxation). Replaces the old bespoke 8-poll NO-BACKOFF loop (which spun instantly and
 * could exhaust before the seed/tombstone coalesced) with a jittered, bounded wait that
 * gives a HEALTHY backend room to converge. Governs HOW LONG only — the EXACT-count
 * predicate keeps correctness strict.
 */
const RECALL_BUDGET: ConvergeBudgetOverride = { maxAttempts: 24, maxWallClockMs: 20_000, backoffBaseMs: 150, backoffCapMs: 1_000 };
import { MEMORIES_COLUMNS, NOT_SOFT_DELETED, SOFT_DELETED } from "../../src/daemon/storage/catalog/index.js";
import { neutralizeIfInfraDegraded } from "./_infra-skip.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

// ── Run isolation: an env-derived unique tag for this run's throwaway table. ──
function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const RETAIN_TABLE = `ci_retain_${RUN_ID}`;
const AGENT = "default";

describe.skipIf(!HAS_TOKEN)("live retention purge smoke (opt-in, real backend — D-8 proof)", () => {
	let storage: StorageClient;
	let org: string;
	let workspace: string;
	const createdTables: string[] = [];

	beforeAll(async () => {
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

		// Heal a throwaway table with the REAL `memories` columns (the embedding +
		// is_deleted shape must be identical for the proof to be meaningful). A live
		// CREATE on this backend can take longer than the default per-query timeout,
		// so give the DDL a generous budget (the suite's hook timeout is 120s).
		const createSql = buildCreateTableSql(RETAIN_TABLE, [...MEMORIES_COLUMNS]);
		createdTables.push(RETAIN_TABLE);
		const created = await storage.query(createSql, { org, workspace }, { timeoutMs: 90_000 });
		expect(created.kind, `create ${RETAIN_TABLE}: ${describeResult(created)}`).toBe("ok");
	});

	afterAll(async () => {
		if (!storage) return;
		for (const table of createdTables) {
			const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(table)}"`, { org, workspace });
			if (!isOk(res)) {
				console.warn(`[ci-cleanup] could not drop ${table} in ${workspace}: ${describeResult(res)}`);
			}
		}
	});

	const tbl = (): string => sqlIdent(RETAIN_TABLE);
	const OP_TIMEOUT = 60_000;

	/** Insert a live memory row (id + content + importance + timestamps + a vector). */
	async function seedMemory(id: string, opts: { updatedAt: string; importance: number }): Promise<void> {
		const sql =
			`INSERT INTO "${tbl()}" (${sqlIdent("id")}, ${sqlIdent("content")}, ${sqlIdent("normalized_content")}, ` +
			`${sqlIdent("importance")}, ${sqlIdent("is_deleted")}, ${sqlIdent("agent_id")}, ` +
			`${sqlIdent("content_embedding")}, ${sqlIdent("created_at")}, ${sqlIdent("updated_at")}) ` +
			`VALUES (${sLiteral(id)}, ${sLiteral(`content ${id}`)}, ${sLiteral(`content ${id}`)}, ` +
			`${String(opts.importance)}, ${String(NOT_SOFT_DELETED)}, ${sLiteral(AGENT)}, ` +
			`ARRAY[0.1,0.2,0.3]::float4[], ${sLiteral(opts.updatedAt)}, ${sLiteral(opts.updatedAt)})`;
		const res = await storage.query(sql, { org, workspace }, { timeoutMs: OP_TIMEOUT });
		expect(res.kind, `seed ${id}: ${describeResult(res)}`).toBe("ok");
	}

	/** The recall-shaped SELECT: live (NOT soft-deleted) rows for this id. */
	function recallSql(id: string): string {
		return (
			`SELECT ${sqlIdent("id")} FROM "${tbl()}" ` +
			`WHERE ${sqlIdent("id")} = ${sLiteral(id)} ` +
			`AND ${sqlIdent("agent_id")} = ${sLiteral(AGENT)} ` +
			`AND ${sqlIdent("is_deleted")} = ${String(NOT_SOFT_DELETED)}`
		);
	}

	/**
	 * Recall-shaped read that CONVERGES on the EXACT expected count through the ONE shared
	 * `readConverged` seam (PRD-028 D-4; PRD-034a immediacy relaxation — no bespoke loop, and
	 * now with real jittered backoff so a slow coalesce on a HEALTHY backend is not red-ed).
	 * Both directions matter: the pre-tombstone read converges UP to 1 (the seed landing), and
	 * the post-tombstone read converges DOWN to 0 (the soft-delete coalescing into the served
	 * segments). The predicate is the EXACT count — CORRECTNESS untouched: on budget exhaustion
	 * the last real read is returned, so a tombstone that genuinely failed (count stuck at 1)
	 * still RES, and a seed that genuinely never landed (count stuck at 0) still RES.
	 */
	async function recallById(id: string, expected: number): Promise<number> {
		const exactCount = (res: QueryResult): boolean => isOk(res) && res.rows.length === expected;
		const res = await readConverged(storage, recallSql(id), { org, workspace }, exactCount, {
			budget: RECALL_BUDGET,
			queryTimeoutMs: OP_TIMEOUT,
		});
		return isOk(res) ? res.rows.length : -1;
	}

	it("1. a TOMBSTONE removes a row from recall on the real backend (the D-8 mechanism)", async ({ skip }) => {
		// INFRA-DEGRADED preflight (PRD-034a FR-4 / a-AC-3): if the backend is sustained-down
		// (a liveness probe flaps transient AFTER the client's retry), resolve NEUTRAL via a
		// SKIP + the run-level sentinel rather than red-ing the seed/tombstone proof on DeepLake
		// weather. A non-transient failure (real defect) or an ok probe continues with full teeth.
		await neutralizeIfInfraDegraded("retention-live:preflight", () => storage.connect({ org, workspace }), skip);

		const id = `tomb-${RUN_ID}-1`;
		await seedMemory(id, { updatedAt: "2020-01-01T00:00:00.000Z", importance: 0.9 });

		// Before: the live row IS recalled.
		expect(await recallById(id, 1), "seeded memory should be recalled before the sweep").toBe(1);

		// Apply the sweep's tombstone (the exact UPDATE the sweep emits).
		const tombstoneSql =
			`UPDATE "${tbl()}" SET ${sqlIdent("is_deleted")} = ${String(SOFT_DELETED)} ` +
			`WHERE ${sqlIdent("id")} = ${sLiteral(id)} AND ${sqlIdent("agent_id")} = ${sLiteral(AGENT)}`;
		const tomb = await storage.query(tombstoneSql, { org, workspace }, { timeoutMs: OP_TIMEOUT });
		expect(tomb.kind, `tombstone: ${describeResult(tomb)}`).toBe("ok");

		// After: the row is NO LONGER recalled — the tombstone is honoured by the
		// `NOT_SOFT_DELETED` recall filter. THIS is what makes retention reliable on a
		// backend where a hard DELETE may silently no-op (D-8).
		expect(await recallById(id, 0), "a tombstoned memory must not be recalled").toBe(0);
	});

	it("2. the full retire sequence (null-embedding → DELETE) leaves the row not recalled (FR-5/e-AC-3)", async () => {
		const id = `retire-${RUN_ID}-2`;
		await seedMemory(id, { updatedAt: "2020-01-01T00:00:00.000Z", importance: 0.9 });

		// Tombstone first (stops recall — the reliable guarantee).
		const tombstoneSql =
			`UPDATE "${tbl()}" SET ${sqlIdent("is_deleted")} = ${String(SOFT_DELETED)} ` +
			`WHERE ${sqlIdent("id")} = ${sLiteral(id)} AND ${sqlIdent("agent_id")} = ${sLiteral(AGENT)}`;
		expect((await storage.query(tombstoneSql, { org, workspace }, { timeoutMs: OP_TIMEOUT })).kind).toBe("ok");

		// Null the embedding so the vector is retired WITH the row (no orphan) ...
		const nullEmbSql =
			`UPDATE "${tbl()}" SET ${sqlIdent("content_embedding")} = NULL ` +
			`WHERE ${sqlIdent("id")} = ${sLiteral(id)} AND ${sqlIdent("agent_id")} = ${sLiteral(AGENT)}`;
		const nulled = await storage.query(nullEmbSql, { org, workspace }, { timeoutMs: OP_TIMEOUT });
		expect(nulled.kind, `null-embedding: ${describeResult(nulled)}`).toBe("ok");

		// ... then the best-effort physical DELETE (may or may not land on this backend).
		const delSql =
			`DELETE FROM "${tbl()}" ` +
			`WHERE ${sqlIdent("id")} = ${sLiteral(id)} AND ${sqlIdent("agent_id")} = ${sLiteral(AGENT)}`;
		const del = await storage.query(delSql, { org, workspace }, { timeoutMs: OP_TIMEOUT });
		// A DELETE that the backend rejects outright would be a query_error; an
		// accepted-but-no-op DELETE is `ok`. EITHER way the row must not be recalled,
		// because the tombstone already removed it from the recall set.
		expect(["ok", "query_error"]).toContain(del.kind);

		// The load-bearing assertion: after the full retire sequence the row is GONE
		// from recall — proven LIVE — whether or not the physical DELETE removed it.
		expect(await recallById(id, 0), "a retired memory must not be recalled").toBe(0);
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

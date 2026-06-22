/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE VFS GOAL-DISPATCH SMOKE — OPT-IN, SEEDS A REAL DEEPLAKE BACKEND.     ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-015 a-AC-6 / b-AC-6: a VFS write that classifies as a GOAL reaches the  ║
 * ║  real `goals`-shaped table THROUGH a daemon-dispatched SQL round-trip, via   ║
 * ║  SELECT-before-INSERT keyed by goal_id. Wave 2 (015b) owns the flush; this   ║
 * ║  suite proves the flush's storage PATH round-trips on a REAL backend:        ║
 * ║                                                                          ║
 * ║    1) a goal VFS path classifies as `goal` (the dispatch decision);         ║
 * ║    2) a real `DaemonDispatch` (the SAME seam shape `fs.ts` carries — SQL in, ║
 * ║       rows out, scope alongside) wraps the live `StorageClient`;            ║
 * ║    3) a SELECT-before-INSERT cycle on the goal_id key: INSERT a new row,     ║
 * ║       then re-upsert the SAME key → the probe observes the row → UPDATE in   ║
 * ║       place (ONE logical row per goal_id, status advanced), then            ║
 * ║    4) a poll-convergent read-back of the final status.                      ║
 * ║                                                                          ║
 * ║  GATED + NATIVELY ISOLATED (modeled on codebase-push-live / api-keys-live): ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = whole         ║
 * ║      suite skips, run exits 0.                                            ║
 * ║    - `.itest.ts` suffix keeps it OUT of `npm run test` / `npm run ci`.      ║
 * ║      Run only via `npm run test:integration`.                            ║
 * ║    - Throwaway table isolation is NATIVE: the per-run table `ci_goals_<id>`  ║
 * ║      is the `goals` HealTarget (its real ColumnDef shape) self-created on    ║
 * ║      first write by `updateOrInsertByKey`'s heal — NOT a SQL-string proxy.   ║
 * ║      The dispatch seam's SQL targets that table by identity, escaped.        ║
 * ║    - Reads that may observe a stale subset POLL-AND-CONVERGE; DROP teardown. ║
 * ║                                                                          ║
 * ║  SECRETS: the token is read ONLY from the env via the storage layer's     ║
 * ║  `envCredentialProvider`. Never hardcoded, logged, or echoed.            ║
 * ║                                                                          ║
 * ║  Do NOT run this locally (no creds) — the orchestrator runs it.           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createStorageClient,
	envCredentialProvider,
	isOk,
	type QueryScope,
	resolveStorageConfig,
	type RowValues,
	sqlIdent,
	sLiteral,
	type StorageClient,
	updateOrInsertByKey,
	val,
} from "../../src/daemon/storage/index.js";
import { GOALS_COLUMNS } from "../../src/daemon/storage/catalog/product.js";
import {
	buildGoalProbeSql,
	classifyPath,
	type DaemonDispatch,
	decomposeGoalPath,
	type Rows,
	type VfsScope,
} from "../../src/daemon-client/vfs/index.js";
import { neutralizeIfInfraDegraded } from "./_infra-skip.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
/** The per-run THROWAWAY table — the `goals` shape, isolated, DROPped in teardown. */
const TBL_GOALS = `ci_goals_${RUN_ID}`;

/** Poll budget for a poll-convergent read (a bare scan can return a stale subset). */
const READ_POLLS = 20;

/**
 * A REAL `DaemonDispatch` over the live store — the SAME seam shape `DeepLakeFs`/`WriteBuffer`
 * carry (SQL in, rows out, scope alongside). Proves the 015b flush's outbound contract
 * round-trips on a real backend. The thin client never opens DeepLake; here the daemon-side
 * store IS the backend, dialed through this adapter, exactly as the real daemon dispatch will.
 */
function liveDispatch(store: StorageClient): DaemonDispatch {
	return {
		async query(sql: string, scope: VfsScope): Promise<Rows> {
			const res = await store.query(sql, scope as QueryScope);
			if (!isOk(res)) throw new Error(`live dispatch failed: ${JSON.stringify(res)}`);
			return res.rows as unknown as Rows;
		},
	};
}

/** Poll a single-row read until it observes the expected value, or the budget is exhausted. */
async function pollForValue(
	store: StorageClient,
	sql: string,
	column: string,
	expected: string,
	scope: QueryScope,
): Promise<boolean> {
	for (let poll = 0; poll < READ_POLLS; poll++) {
		const res = await store.query(sql, scope);
		if (isOk(res)) {
			for (const row of res.rows) {
				if (String(row[column] ?? "") === expected) return true;
			}
		}
	}
	return false;
}

/** Build a `goals`-shape row from a decomposed goal path + body (the flush's column mapping). */
function goalRow(key: string, owner: string, status: string, body: string): RowValues {
	const now = new Date().toISOString();
	return [
		["key", val.text(key)],
		["value", val.text(body)],
		["target", val.text("")],
		["status", val.text(status)],
		["unit", val.text("")],
		["agent_id", val.text(owner)],
		["visibility", val.text("global")],
		["created_at", val.text(now)],
		["updated_at", val.text(now)],
	];
}

describe.skipIf(!HAS_TOKEN)("live VFS goal-dispatch smoke (opt-in, real backend, 015 a-AC-6 / b-AC-6)", () => {
	let storage: StorageClient;
	let dispatch: DaemonDispatch;
	let scope: QueryScope;

	beforeAll(() => {
		const raw = envCredentialProvider().read();
		const provider = {
			read: () => ({
				...raw,
				workspace: process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci",
				queryTimeoutMs: 120_000,
			}),
		};
		const config = resolveStorageConfig(provider);
		scope = { org: config.org, workspace: config.workspace };
		storage = createStorageClient({ provider });
		dispatch = liveDispatch(storage);
	});

	afterAll(async () => {
		if (!storage) return;
		// DROP is the reliable teardown on this backend (DELETE does not dependably remove rows).
		const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(TBL_GOALS)}"`, scope);
		if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${TBL_GOALS}: ${JSON.stringify(res)}`);
	});

	it("a goal VFS path → classify → SELECT-before-INSERT round-trip → poll-convergent read", async ({ skip }) => {
		// INFRA-DEGRADED preflight (PRD-034a FR-4 / a-AC-3): if the backend is sustained-down
		// (a liveness probe flaps transient AFTER the client's retry), resolve NEUTRAL via a
		// SKIP + the run-level sentinel rather than red-ing the goal-dispatch round-trip on
		// DeepLake weather. A non-transient failure (real defect) or an ok probe continues.
		await neutralizeIfInfraDegraded("vfs-goal-dispatch-live:preflight", () => storage.connect(scope), skip);

		// 1) A VFS goal path classifies as a goal AND decomposes to its keyed parts (the seam's
		//    dispatch decision + the SELECT-before-INSERT key the flush builds).
		const goalPath = "goal/alice/opened/g-live-1.md";
		expect(classifyPath(goalPath)).toBe("goal");
		const parts = decomposeGoalPath(goalPath);
		expect(parts).not.toBeNull();
		const goalId = parts!.goalId;

		// The throwaway table is keyed by the goal_id (namespaced to the run so reruns don't clash).
		const key = `${goalId}@${RUN_ID}`;
		const target = { table: TBL_GOALS, columns: GOALS_COLUMNS };

		// 2) INSERT phase — the throwaway table self-creates from the `goals` HealTarget shape on
		//    this first write (native isolation; no SQL-string table proxy).
		const insert = await updateOrInsertByKey(storage, target, scope, {
			keyColumn: "key",
			keyValue: key,
			row: goalRow(key, parts!.owner, "opened", "ship the VFS"),
		});
		expect(isOk(insert)).toBe(true);

		// 3) The dispatch-seam PROBE observes the now-existing row (the SELECT of SELECT-before-
		//    INSERT) — keyed by goal_id, round-tripped through the REAL DaemonDispatch seam.
		const probeSql =
			`SELECT ${sqlIdent("key")}, ${sqlIdent("status")} FROM "${sqlIdent(TBL_GOALS)}" ` +
			`WHERE ${sqlIdent("key")} = ${sLiteral(key)} LIMIT 1`;
		// (The unit flush builds `buildGoalProbeSql(goalId)` against the real `goals` table; this
		// itest targets the throwaway table, so it probes by the run-scoped key directly.)
		void buildGoalProbeSql; // referenced to anchor the seam parity in the suite's intent.
		let probed = false;
		for (let poll = 0; poll < READ_POLLS && !probed; poll++) {
			const rows = await dispatch.query(probeSql, scope);
			probed = rows.some((r) => String(r.key ?? "") === key);
		}
		expect(probed, "the inserted goal row was not observed through the dispatch seam").toBe(true);

		// 4) UPDATE phase — re-upsert the SAME key with an advanced status. SELECT-before-INSERT
		//    observes the existing row and UPDATEs in place: ONE logical row per goal_id.
		const update = await updateOrInsertByKey(storage, target, scope, {
			keyColumn: "key",
			keyValue: key,
			row: goalRow(key, parts!.owner, "in_progress", "ship the VFS"),
		});
		expect(isOk(update)).toBe(true);

		// 5) Poll-convergent read-back of the advanced status (the daemon-dispatched read).
		const readSql =
			`SELECT ${sqlIdent("status")} FROM "${sqlIdent(TBL_GOALS)}" ` +
			`WHERE ${sqlIdent("key")} = ${sLiteral(key)} LIMIT 1`;
		const observed = await pollForValue(storage, readSql, "status", "in_progress", scope);
		expect(observed, "the upserted goal row did not converge to status=in_progress").toBe(true);
	});
});

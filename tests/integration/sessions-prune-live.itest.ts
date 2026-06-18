/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE sessions-prune SMOKE — OPT-IN, MUTATES A REAL DEEPLAKE BACKEND.    ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-020a a-AC-2 / D-3: write a `sessions` trace row AND its paired       ║
 * ║  `/summaries/<author>/<sessionId>.md` `memory` summary row to the REAL    ║
 * ║  DeepLake backend, then runPrune → assert BOTH are TOMBSTONED TOGETHER    ║
 * ║  (the trace tombstone AND the paired summary tombstone both appear), so   ║
 * ║  traces + summaries never desync. Proves the append-only paired delete   ║
 * ║  converges LIVE.                                                          ║
 * ║                                                                          ║
 * ║  GATED + ISOLATED exactly like sources-purge-live.itest.ts:              ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = skip.    ║
 * ║    - `.itest.ts` suffix keeps it OUT of `npm run test` / `npm run ci`.  ║
 * ║      Only `npm run test:integration` runs it.                            ║
 * ║    - Per-run throwaway `ci_prune_<runid>_*` tables, DROPped in afterAll. ║
 * ║    - `queryTimeoutMs: 120_000`. POLL-CONVERGENT read-backs (a scan can    ║
 * ║      miss a row but never invents one, so polling converges UP).          ║
 * ║                                                                          ║
 * ║  Do NOT run locally (no creds in this env) — the orchestrator runs it.  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createStorageClient,
	envCredentialProvider,
	isOk,
	resolveStorageConfig,
	sLiteral,
	sqlIdent,
	type StorageClient,
} from "../../src/daemon/storage/index.js";
import type { QueryScope } from "../../src/daemon/storage/client.js";
import { appendOnlyInsert, val } from "../../src/daemon/storage/writes.js";
import { healTargetFor } from "../../src/daemon/storage/catalog/index.js";
import { runPrune, summaryPath, TOMBSTONE_MARKER } from "../../src/daemon/runtime/sessions/prune.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const TBL_SESSIONS = `ci_prune_${RUN_ID}_sessions`;
const TBL_MEMORY = `ci_prune_${RUN_ID}_memory`;
const AUTHOR = "ci-author";
const SESSION_ID = "ci-sess-1";
const SCAN_POLLS = 20;

/** Poll a marker-presence read; true once a tombstone (filename=marker) for the path appears. */
async function tombstonePresent(store: StorageClient, table: string, path: string, scope: QueryScope): Promise<boolean> {
	const sql =
		`SELECT ${sqlIdent("filename")} FROM "${sqlIdent(table)}" ` +
		`WHERE ${sqlIdent("path")} = ${sLiteral(path)} AND ${sqlIdent("filename")} = ${sLiteral(TOMBSTONE_MARKER)} LIMIT 1`;
	for (let poll = 0; poll < SCAN_POLLS; poll++) {
		const res = await store.query(sql, scope);
		if (isOk(res) && res.rows.length > 0) return true;
	}
	return false;
}

describe.skipIf(!HAS_TOKEN)("live sessions prune smoke (opt-in, real backend, paired tombstone)", () => {
	let storage: StorageClient;
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
	});

	afterAll(async () => {
		if (!storage) return;
		for (const tbl of [TBL_SESSIONS, TBL_MEMORY]) {
			const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(tbl)}"`, scope);
			if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${tbl}: ${JSON.stringify(res)}`);
		}
	});

	it("prune tombstones the trace AND the paired summary together (no desync), live", async () => {
		// Heal CREATEs the throwaway tables directly via the catalog ColumnDef arrays (the proven
		// isolation technique): build a HealTarget over the canonical columns but the throwaway name.
		const sessTarget = { ...healTargetFor("sessions"), table: TBL_SESSIONS };
		const memTarget = { ...healTargetFor("memory"), table: TBL_MEMORY };
		const sumPath = summaryPath(AUTHOR, SESSION_ID);

		// Write a session trace row AND its paired summary row.
		await appendOnlyInsert(storage, sessTarget, scope, [
			["id", val.str(SESSION_ID)],
			["path", val.str(`conversations/${SESSION_ID}`)],
			["filename", val.str("event.json")],
			["author", val.str(AUTHOR)],
			["creation_date", val.str("2025-01-01")],
		]);
		await appendOnlyInsert(storage, memTarget, scope, [
			["id", val.str(SESSION_ID)],
			["path", val.str(sumPath)],
			["filename", val.str("summary.md")],
			["summary", val.text("the session summary")],
			["author", val.str(AUTHOR)],
			["creation_date", val.str("2025-01-01")],
		]);

		// Prune the author's sessions before a future date (matches the one we wrote).
		const outcome = await runPrune(storage, { sessions: sessTarget, memory: memTarget }, scope, AUTHOR, {
			before: "2026-01-01",
		});
		expect(outcome.matched).toBeGreaterThanOrEqual(1);
		expect(outcome.sessionsTombstoned).toBe(outcome.summariesTombstoned);

		// Read-back (poll-convergent): BOTH the trace tombstone AND the paired summary tombstone land.
		const traceTombstoned = await tombstonePresent(storage, TBL_SESSIONS, `conversations/${SESSION_ID}`, scope);
		const summaryTombstoned = await tombstonePresent(storage, TBL_MEMORY, sumPath, scope);

		expect(traceTombstoned, "session trace tombstoned").toBe(true);
		expect(summaryTombstoned, "paired summary tombstoned together (no desync)").toBe(true);
	});
});

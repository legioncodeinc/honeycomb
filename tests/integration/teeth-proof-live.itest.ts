/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  TEETH PROOF — the IRL-faithful suite still CATCHES real regressions.      ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-034a a-AC-2 / FR-7 (the no-weakening guard). The 034a refactor relaxed ║
 * ║  IMMEDIACY (exact-count-now / tight per-test deadlines → eventually-style    ║
 * ║  `readConverged` with generous budgets) but kept every CORRECTNESS bar       ║
 * ║  strict. The risk a reviewer rightly fears: did "generous convergence"       ║
 * ║  quietly turn into "wait until it passes / never fail"? This suite is the     ║
 * ║  committed CONTROL that proves it did NOT — on a HEALTHY backend, a genuine   ║
 * ║  wiring/correctness regression STILL FAILS.                                  ║
 * ║                                                                            ║
 * ║  It is NOT a permanently-broken test: every `it` here PASSES. Each proves a  ║
 * ║  regression would be CAUGHT, by demonstrating that the eventually-style read ║
 * ║  path returns the REAL value (so a WRONG expectation against it is false) —  ║
 * ║  i.e. the harness has teeth. The three regression CLASSES the parent PRD      ║
 * ║  names are each exercised:                                                   ║
 * ║    • WRONG VALUE        — a read-back must equal what we wrote, not whatever  ║
 * ║                          a converged read happens to serve.                  ║
 * ║    • BROKEN TENANCY     — a read scoped to a DIFFERENT workspace must NOT     ║
 * ║                          surface this run's row (isolation is real).         ║
 * ║    • LOST WRITE         — `readConverged` on a row that was NEVER written     ║
 * ║                          exhausts its budget and reports ABSENT — it does     ║
 * ║                          NOT fabricate the awaited row to make a wait pass.   ║
 * ║                                                                            ║
 * ║  GATED + ISOLATED exactly like controlled-writes-live.itest.ts:             ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = skip, exit 0. ║
 * ║    - `.itest.ts` + `tests/integration/**` exclusion keep it OUT of           ║
 * ║      `npm run ci`. Only `npm run test:integration` runs it.                  ║
 * ║    - Per-run THROWAWAY `ci_teeth_<run-id>` table, DROPped in afterAll.       ║
 * ║                                                                            ║
 * ║  SECRETS: the token reaches the client ONLY via `envCredentialProvider`.     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	appendVersionBumped,
	type ConvergeBudgetOverride,
	createStorageClient,
	envCredentialProvider,
	isOk,
	minVersion,
	readConverged,
	rowPresent,
	resolveStorageConfig,
	sLiteral,
	sqlIdent,
	type StorageClient,
	val,
	watermarkOf,
	watermarkPredicate,
} from "../../src/daemon/storage/index.js";
import type { HealTarget } from "../../src/daemon/storage/heal.js";
import type { ColumnDef } from "../../src/daemon/storage/schema.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const CI_TABLE = `ci_teeth_${RUN_ID}`;
const KEY_COLUMN = "teeth_key";

const CI_COLUMNS: readonly ColumnDef[] = [
	{ name: KEY_COLUMN, sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "payload", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "version", sql: "BIGINT NOT NULL DEFAULT 1" },
];

const ciTarget: HealTarget = { table: CI_TABLE, columns: CI_COLUMNS as ColumnDef[] };

/**
 * The SAME generous convergence budget shape the refactored suite uses — but with a
 * deliberately SHORT wall-clock for the "lost write" case so a genuinely-absent row's
 * budget exhausts quickly (the point is that it exhausts and reports ABSENT, not that
 * we wait long). For the present-row reads the budget is generous, matching the suite.
 */
const PRESENT_BUDGET: ConvergeBudgetOverride = { maxAttempts: 40, maxWallClockMs: 20_000, backoffBaseMs: 150, backoffCapMs: 1_000 };
const ABSENT_BUDGET: ConvergeBudgetOverride = { maxAttempts: 4, maxWallClockMs: 2_000, backoffBaseMs: 50, backoffCapMs: 200 };

describe.skipIf(!HAS_TOKEN)("TEETH PROOF (a-AC-2): the IRL-faithful suite still catches real regressions", () => {
	let storage: StorageClient;
	let org: string;
	let workspace: string;

	beforeAll(() => {
		const raw = envCredentialProvider().read();
		const provider = {
			read: () => ({ ...raw, workspace: process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci" }),
		};
		const config = resolveStorageConfig(provider);
		org = config.org;
		workspace = config.workspace;
		storage = createStorageClient({ provider });
	});

	afterAll(async () => {
		if (!storage) return;
		const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(CI_TABLE)}"`, { org, workspace });
		if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${CI_TABLE} in ${workspace}`);
	});

	function scope(): { org: string; workspace: string } {
		return { org, workspace };
	}

	/** The highest-version-by-key SELECT (the read-your-writes shape the suite uses). */
	function latestByKeySql(key: string): string {
		const tbl = sqlIdent(CI_TABLE);
		const keyCol = sqlIdent(KEY_COLUMN);
		return `SELECT ${keyCol}, payload, version FROM "${tbl}" WHERE ${keyCol} = ${sLiteral(key)} ORDER BY version DESC LIMIT 1`;
	}

	// ══════════════════════════════════════════════════════════════════════════
	// TEETH #1 — WRONG VALUE: a converged read returns the REAL written value, so a
	// wrong-value expectation against it would FAIL. (Proves convergence ≠ "pass".)
	// ══════════════════════════════════════════════════════════════════════════
	it("catches a WRONG VALUE: the converged read-back equals what was written, never a fabricated pass", async () => {
		const key = `teeth_wrongval_${RUN_ID}`;
		const realPayload = `real-payload-${RUN_ID}`;

		const { result, version } = await appendVersionBumped(storage, ciTarget, scope(), {
			keyColumn: KEY_COLUMN,
			keyValue: key,
			row: [[KEY_COLUMN, val.str(key)], ["payload", val.text(realPayload)]],
			versionColumn: "version",
		});
		expect(result.kind, "seed write must succeed on a healthy backend").toBe("ok");

		// Read back through the SAME eventually-style seam the suite uses, converged to the
		// write's watermark (version ≥ what we wrote).
		const back = await readConverged(
			storage,
			latestByKeySql(key),
			scope(),
			watermarkPredicate(watermarkOf(key, version), { idColumn: KEY_COLUMN, versionColumn: "version" }),
			{ budget: PRESENT_BUDGET },
		);
		expect(back.kind, "read-back must succeed").toBe("ok");
		const got = isOk(back) && back.rows.length > 0 ? String(back.rows[0].payload ?? "") : "";

		// CORRECTNESS (the real bar the suite enforces): the read-back equals the written value.
		expect(got, "the converged read returns the REAL value").toBe(realPayload);

		// TEETH: a WRONG-value expectation against that same converged read is FALSE — i.e.
		// had the wiring written the wrong payload, the suite's `toBe(expected)` would RES.
		// (This is the inverted-expectation guard: the harness would catch a wrong value.)
		const wrongPayload = `wrong-payload-${RUN_ID}`;
		expect(got, "a wrong-value expectation would be FALSE → the suite would fail a real regression").not.toBe(wrongPayload);
	}, 60_000);

	// ══════════════════════════════════════════════════════════════════════════
	// TEETH #2 — BROKEN TENANCY: a read scoped to a DIFFERENT workspace must NOT
	// surface this run's row. (Proves isolation is real, not a convergence artifact.)
	// ══════════════════════════════════════════════════════════════════════════
	it("catches BROKEN TENANCY: a foreign-workspace read does NOT surface this run's row", async () => {
		const key = `teeth_tenancy_${RUN_ID}`;
		const payload = `tenancy-payload-${RUN_ID}`;

		const { result } = await appendVersionBumped(storage, ciTarget, scope(), {
			keyColumn: KEY_COLUMN,
			keyValue: key,
			row: [[KEY_COLUMN, val.str(key)], ["payload", val.text(payload)]],
			versionColumn: "version",
		});
		expect(result.kind, "seed write must succeed").toBe("ok");

		// In-scope: the row is present (CORRECTNESS — the write landed in OUR workspace).
		const inScope = await readConverged(storage, latestByKeySql(key), scope(), rowPresent(KEY_COLUMN, key), {
			budget: PRESENT_BUDGET,
		});
		expect(isOk(inScope) && inScope.rows.length > 0, "the row is visible in its own workspace").toBe(true);

		// Foreign workspace: the SAME key must NOT resolve. A read scoped to a different
		// workspace is a different physical table; the row cannot be there. We use the SHORT
		// absent-budget — the point is that polling does NOT eventually fabricate a hit.
		const foreignScope = { org, workspace: `ci_foreign_${RUN_ID}` };
		const foreign = await readConverged(storage, latestByKeySql(key), foreignScope, rowPresent(KEY_COLUMN, key), {
			budget: ABSENT_BUDGET,
		});
		// TEETH: a broken-isolation regression (the row leaking cross-workspace) would make
		// this `rows.length > 0` and a `toBe(false)` here would RES. Either the foreign read
		// is a non-ok (no such table → query_error) or an ok with zero rows — never our row.
		const leaked = isOk(foreign) && foreign.rows.some((r) => String(r[KEY_COLUMN] ?? "") === key);
		expect(leaked, "a foreign-workspace read must NOT surface this run's row (tenancy is real)").toBe(false);
	}, 60_000);

	// ══════════════════════════════════════════════════════════════════════════
	// TEETH #3 — LOST WRITE: `readConverged` on a NEVER-written row exhausts its
	// budget and reports ABSENT — it does NOT invent the awaited row. (Proves the
	// eventually-style seam fails a lost write, never masks it.)
	// ══════════════════════════════════════════════════════════════════════════
	it("catches a LOST WRITE: readConverged reports ABSENT for a row that was never written (no fabrication)", async () => {
		const missingKey = `teeth_neverwritten_${RUN_ID}`;

		// We deliberately do NOT write `missingKey`. A read-your-writes converge against a
		// watermark for a row that was never persisted must EXHAUST its budget and return the
		// real (empty) read — never a fabricated hit. This is the exact shape a LOST WRITE
		// (the write silently dropped) presents: the converged read does not find it.
		const res = await readConverged(storage, latestByKeySql(missingKey), scope(), minVersion("version", 1), {
			budget: ABSENT_BUDGET,
		});
		const found = isOk(res) && res.rows.some((r) => String(r[KEY_COLUMN] ?? "") === missingKey);

		// TEETH: the seam reports ABSENT. Had a lost write been masked (the seam fabricating
		// the awaited row to make the wait "succeed"), `found` would be true and this RES.
		expect(found, "a never-written row stays ABSENT — readConverged never fabricates a lost write").toBe(false);
	}, 30_000);
});

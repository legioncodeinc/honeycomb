/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE version-history COMPACTION PROOF — OPT-IN, MUTATES A REAL DEEPLAKE.   ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-030 Wave 2b: the GATED LIVE behavioural proof of `compactVersionHistory`║
 * ║  against a REAL DeepLake backend. The compactor's reap-set math, retention  ║
 * ║  window, idempotency, and crash-safety are exhaustively unit-tested against ║
 * ║  a fake transport in tests/daemon/storage/compaction.test.ts. THIS suite    ║
 * ║  proves the behaviours that a fake CANNOT: that a real guarded DELETE on a   ║
 * ║  real version-bumped table actually BOUNDS the row count while keeping the   ║
 * ║  highest version BYTE-IDENTICAL, that a concurrent highest-version read is   ║
 * ║  NEVER transiently empty or non-current across a live compaction pass, and   ║
 * ║  that the pass is idempotent + crash-safe on this flappy store.             ║
 * ║                                                                            ║
 * ║  ── The hazard this suite exists for (project memory) ──                    ║
 * ║  DeepLake flaps stale segments and its hard DELETE is UNRELIABLE — a single  ║
 * ║  immediate read-back after a DELETE can land on a stale segment and          ║
 * ║  under-report. EVERY read-back here POLLS to convergence (never a single     ║
 * ║  immediate read), and the AC-1 row-count assertion converges the count and   ║
 * ║  re-runs the IDEMPOTENT compactor before failing — it NEVER weakens the bar  ║
 * ║  (≤K rows, byte-identical highest, strict drop) to pass.                     ║
 * ║                                                                            ║
 * ║  ── Isolation (mirrors controlled-writes-live.itest.ts — do not weaken) ──  ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = whole suite   ║
 * ║      skips, run exits 0. NEVER part of `npm run test` / `npm run ci`: the    ║
 * ║      `.itest.ts` suffix is outside the `*.test.ts` glob AND               ║
 * ║      `tests/integration/**` is excluded — it runs ONLY under               ║
 * ║      `npm run test:integration` (+ `.env.local`).                           ║
 * ║    - Runs in the SAME authorized workspace the token is scoped to           ║
 * ║      (`HONEYCOMB_DEEPLAKE_WORKSPACE`, default `honeycomb_ci`).              ║
 * ║    - Creates + heals a per-run THROWAWAY version-bumped table               ║
 * ║      `ci_compaction_<run-id>` from a SMALL local ColumnDef (key / version /  ║
 * ║      payload / updated_at) and DROPs it in afterAll. DROP is the reliable    ║
 * ║      teardown here (DELETE does not dependably remove rows). NEVER a real    ║
 * ║      shared `pollinating_state` / skills / rules table.                        ║
 * ║    - The compactor's catalog guard (D-6) only admits catalog version-bumped ║
 * ║      names, so this suite injects a NARROWING `isCompactable` predicate that ║
 * ║      authorizes ONLY this run's throwaway name and rejects everything else — ║
 * ║      the fail-closed contract holds.                                        ║
 * ║                                                                            ║
 * ║  SECRETS: the token is read ONLY from the env via the storage layer's       ║
 * ║  `envCredentialProvider`. Never hardcoded, logged, or echoed.              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	appendVersionBumped,
	type CompactionSummary,
	compactVersionHistory,
	type ConvergeBudgetOverride,
	createStorageClient,
	envCredentialProvider,
	isOk,
	minVersion,
	type QueryResult,
	readConverged,
	resolveStorageConfig,
	sLiteral,
	sqlIdent,
	type StorageClient,
	val,
} from "../../src/daemon/storage/index.js";
import type { HealTarget } from "../../src/daemon/storage/heal.js";
import type { ColumnDef } from "../../src/daemon/storage/schema.js";
import { neutralizeIfInfraDegraded } from "./_infra-skip.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

// ── Run isolation: an environment-derived unique tag for this run's table. ───
function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const CI_TABLE = `ci_compaction_${RUN_ID}`;

/** The logical key column whose version history the compactor reaps. */
const KEY_COLUMN = "compaction_key";

/**
 * A SMALL, throwaway, version-bumped ColumnDef array (PRD-030 Wave 2b). It is the
 * minimum a version-history compaction needs: the logical key, the append-only
 * `version`, a `payload` column carrying a per-version-distinct value (so the
 * highest version is byte-identifiable), and `updated_at` — the compactor's
 * DEFAULT `timestampColumn` the retention window is measured on. Every NOT NULL
 * column carries a DEFAULT (the schema validator's load-time rule). This is the
 * SAME column-shape the daemon's version-bumped tables use, just under a per-run
 * name that is created + healed and DROPped, never a real shared table.
 */
const CI_COLUMNS: readonly ColumnDef[] = [
	{ name: KEY_COLUMN, sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "payload", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "updated_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "version", sql: "BIGINT NOT NULL DEFAULT 1" },
];

/** The throwaway HealTarget the live writes + reads + compaction all use. */
const ciTarget: HealTarget = { table: CI_TABLE, columns: CI_COLUMNS as ColumnDef[] };

/**
 * The NARROWING compactability guard the live proof injects (D-6 stays
 * fail-closed). It admits ONLY this run's throwaway table and rejects everything
 * else, so the compactor can reap a non-catalog table WITHOUT widening the
 * production guard. Production passes nothing → the catalog guard is the
 * authority; this predicate is wired ONLY here.
 */
function onlyThisRunTable(table: string): boolean {
	return table === CI_TABLE;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The GENEROUS convergence budget every poll-convergent read-back here honors,
 * routed through the ONE shared `readConverged` seam (PRD-028 D-4 — no bespoke poll
 * loops). DeepLake can take SEVERAL SECONDS to coalesce a flappy DELETE into the
 * served segments, so the wall-clock + attempt budget is widened well past the
 * seam's ~2s/10 default; the backoff cap stays modest so the flap is sampled often.
 * The BUDGET only governs HOW LONG we wait for convergence — it NEVER weakens a bar:
 * on exhaustion `readConverged` returns the last real (still under/over-reporting)
 * read, so a genuine leftover row still RES and a genuine under-seed still RES.
 *
 * ── PRD-034a (FR-2 / FR-3): IMMEDIACY relaxed, CORRECTNESS untouched ──────────
 * The previous 12s/24-attempt budget traded an over-count flap for a TIMEOUT flap:
 * under real backend latency the durable-settle loop could not converge inside the
 * old per-test 180s deadline, so a HEALTHY product red-ed the suite on weather. The
 * budget below is widened (≈45s wall-clock / 60 attempts) so "eventually correct"
 * has room to hold on a slow-but-working backend — the test now proves the INVARIANT
 * (highest byte-identical + count bounded + non-increasing after settling), not a
 * fixed deadline. It is STILL bounded: a genuinely-leftover row exhausts the budget
 * and the assertion RES; a sustained transport outage is caught as infra-degraded
 * (FR-4), never a silent green.
 */
const READBACK_BUDGET: ConvergeBudgetOverride = {
	maxAttempts: 30,
	maxWallClockMs: 20_000,
	backoffBaseMs: 150,
	backoffCapMs: 1_000,
};

/**
 * A GENEROUS per-test ceiling (PRD-034a FR-3) — a safety NET, not the assertion bar.
 * Each AC seeds many sequential versions (up to 50) and then waits for the flappy
 * DELETE + read-side coalesce to converge through the generous {@link READBACK_BUDGET}
 * (possibly across a couple of idempotent re-compaction rounds). The OLD 180s deadline
 * was the impatient immediacy hook that fired under backend latency on a HEALTHY
 * product; this ceiling is widened well past the worst realistic convergence so the
 * test proves "eventually correct", and the per-read budget — not this number — is
 * what governs the wait. A genuine leftover row still RES (the budget exhausts and the
 * invariant assertion fails); a sustained outage is caught as infra-degraded.
 */
const GENEROUS_TEST_CEILING_MS = 300_000;

/**
 * A bare sleep — used ONLY by AC-3's concurrent-interleave SAMPLER (`resolveConvergent`
 * fires its own poll-convergent resolves at a tight cadence to interleave reads against
 * a live compaction; that is a deliberate sampler, not a write-readback wait, so it
 * stays as-is per the PRD-030 AC-3 precedent). The write-readback reads (`readHighest`,
 * `countRowsConverging`) DO NOT use this — they route through the shared `readConverged`
 * seam (D-4: one home for the poll loop).
 */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!HAS_TOKEN)("live version-history compaction proof (opt-in, real backend)", () => {
	let storage: StorageClient;
	let org: string;
	let workspace: string;

	beforeAll(() => {
		// Resolve config from the SAME env provider the daemon uses, defaulting the
		// workspace to the namespaced `honeycomb_ci` so a bare token never targets a
		// production workspace — but an explicit HONEYCOMB_DEEPLAKE_WORKSPACE wins.
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
		// Best-effort cleanup: DROP the throwaway table this run created. DROP is the
		// reliable teardown here (DELETE does not dependably remove rows).
		const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(CI_TABLE)}"`, { org, workspace });
		if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${CI_TABLE} in ${workspace}: ${describeResult(res)}`);
	});

	// ── Seeding + reading helpers (poll-convergent throughout) ────────────────

	/** The scope every live call carries. */
	function scope(): { org: string; workspace: string } {
		return { org, workspace };
	}

	/**
	 * Seed ONE version of `key` carrying a distinct `payload` + an `updated_at`
	 * timestamp. Uses the SAME `appendVersionBumped` primitive the daemon's
	 * version-bumped writers use (reads MAX(version), INSERTs N+1) — heal-aware, so
	 * the FIRST seed lazily CREATEs + heals the throwaway table from CI_COLUMNS.
	 * Returns the version that was appended.
	 */
	async function seedVersion(key: string, payload: string, updatedAt: string): Promise<number> {
		const { result, version } = await appendVersionBumped(storage, ciTarget, scope(), {
			keyColumn: KEY_COLUMN,
			keyValue: key,
			row: [
				[KEY_COLUMN, val.str(key)],
				["payload", val.text(payload)],
				["updated_at", val.str(updatedAt)],
			],
			versionColumn: "version",
		});
		expect(result.kind, `seed v${version} of ${key} must succeed: ${describeResult(result)}`).toBe("ok");
		return version;
	}

	/**
	 * Read the HIGHEST-version row for `key` POLL-CONVERGENTLY through the ONE shared
	 * `readConverged` seam (PRD-028 D-4 — never a single immediate read, never a
	 * bespoke poll loop). The backend flaps stale segments, especially after a DELETE,
	 * and `version` is append-only + monotone, so a point read of
	 * `ORDER BY version DESC LIMIT 1` can only UNDER-report. When the caller knows the
	 * version the seed reached (`expectVersion`), the seam polls with the `minVersion`
	 * predicate — "a served segment carries version ≥ expectVersion" — so the read
	 * waits past a stale segment that has only a lower version yet; the converged
	 * result's single top row is then the byte-identical highest. With no expectation
	 * (post-reap reads where the top is unchanged but we still want a fresh segment) it
	 * settles on the first non-empty row. The budget GOVERNS the wait only; on
	 * exhaustion the last real read is surfaced, so a genuine shortfall RES, never
	 * hangs. Returns `{ version, payload }` (0 + "" when the key has no row).
	 */
	async function readHighest(key: string, expectVersion?: number): Promise<{ version: number; payload: string }> {
		const tbl = sqlIdent(CI_TABLE);
		const keyCol = sqlIdent(KEY_COLUMN);
		const sql =
			`SELECT version, payload FROM "${tbl}" ` +
			`WHERE ${keyCol} = ${sLiteral(key)} ` +
			`ORDER BY version DESC LIMIT 1`;
		// Converged once a segment serves version ≥ expectVersion (monotone signal); when
		// the caller has no target, any non-empty ok row is "fresh enough" for the top read.
		const predicate =
			expectVersion !== undefined
				? minVersion("version", expectVersion)
				: (res: QueryResult): boolean => isOk(res) && res.rows.length > 0;
		const res = await readConverged(storage, sql, scope(), predicate, { budget: READBACK_BUDGET });
		if (isOk(res) && res.rows.length > 0) {
			return { version: numberOf(res.rows[0].version), payload: stringOf(res.rows[0].payload) };
		}
		return { version: 0, payload: "" };
	}

	/**
	 * Count the rows for `key` POLL-CONVERGENTLY toward a target bound through the ONE
	 * shared `readConverged` seam (PRD-028 D-4 — no bespoke poll loop). After a flappy
	 * DELETE the count can transiently OVER-report (a stale segment still serves a
	 * reaped row), then settle a beat later; the seam polls with a caller-supplied
	 * DOWN-converging predicate — "an ok result whose row count is at/under `bound`",
	 * the reaped state having converged — backing off (jittered, capped) until it holds
	 * or the generous budget is spent. On convergence the returned ok result's
	 * `rows.length` IS the settled count; on budget exhaustion the seam returns the
	 * LAST real (still over-reporting) read, so a genuine leftover row surfaces as a
	 * count > bound and the assertion RES — the bound is NEVER weakened to pass.
	 * Returns the converged (or last-observed) count, or -1 if no ok read ever landed.
	 */
	async function countRowsConverging(key: string, bound: number): Promise<number> {
		const tbl = sqlIdent(CI_TABLE);
		const keyCol = sqlIdent(KEY_COLUMN);
		const sql = `SELECT version FROM "${tbl}" WHERE ${keyCol} = ${sLiteral(key)}`;
		// "Reaped state converged": an ok result at/under the bound. A non-ok read is
		// never fresh, so a transport flap lets the budget govern (fail-soft).
		const atOrUnderBound = (res: QueryResult): boolean => isOk(res) && res.rows.length <= bound;
		const res = await readConverged(storage, sql, scope(), atOrUnderBound, { budget: READBACK_BUDGET });
		return isOk(res) ? res.rows.length : -1;
	}

	/**
	 * DURABLY settle the row count for `key` at/under `bound` before the next compactor
	 * pass reads it. A single `countRowsConverging` returns the instant ONE poll sees
	 * ≤bound — but the backend coalesces its segments lazily, so the very next read (the
	 * compactor's own per-key version scan) can still land on a STALER segment that
	 * re-surfaces reaped rows. This composes the shared seam (NO bespoke poll loop — it
	 * delegates each observation to `readConverged`-backed `countRowsConverging`) and
	 * requires `STABLE_SETTLES` CONSECUTIVE ≤bound observations: the count has quiesced,
	 * so the coalesce has propagated to the segments a following pass will read. Bounded
	 * by `maxRounds` so a genuine never-settling leftover still returns (the caller's
	 * pass then reaps it and the assertion RES — convergence absorbs the flap, never a
	 * real miss). Returns the last observed count.
	 */
	async function settleDurablyAtOrUnder(key: string, bound: number, maxRounds = 18): Promise<number> {
		const STABLE_SETTLES = 3; // consecutive ≤bound reads ⇒ the coalesce has propagated.
		const tbl = sqlIdent(CI_TABLE);
		const keyCol = sqlIdent(KEY_COLUMN);
		const sql = `SELECT version FROM "${tbl}" WHERE ${keyCol} = ${sLiteral(key)}`;
		let consecutive = 0;
		let last = -1;
		// PRD-034a (FR-3): each round is a SINGLE short-budget read sample, NOT a full
		// down-converge — the durability comes from REPEATING rounds (consecutive stable ≤bound
		// observations across the read-side coalesce window), so composing a full multi-second
		// converge per round would multiply into the per-test timeout that used to fire. A short
		// per-read budget + a per-round backoff keeps the TOTAL bounded (≈ maxRounds × ~1.5s)
		// while still proving the coalesce has propagated. The ≤bound bar is unweakened.
		for (let round = 0; round < maxRounds; round++) {
			const res = await readConverged(storage, sql, scope(), (r: QueryResult): boolean => isOk(r) && r.rows.length <= bound, {
				budget: { maxAttempts: 4, maxWallClockMs: 2_000, backoffBaseMs: 100, backoffCapMs: 400 },
			});
			last = isOk(res) ? res.rows.length : -1;
			consecutive = last >= 0 && last <= bound ? consecutive + 1 : 0;
			if (consecutive >= STABLE_SETTLES) break;
			// A coalesce beat between rounds so a following sample reads a fresher segment.
			await sleep(500);
		}
		return last;
	}

	/** Run a compaction pass over the throwaway table with the injected guard. */
	async function compact(opts: {
		keepLatestN: number;
		windowDays: number;
		nowMs: number;
	}): Promise<CompactionSummary> {
		return compactVersionHistory(storage, ciTarget, scope(), {
			keyColumn: KEY_COLUMN,
			retention: {
				keepLatestN: opts.keepLatestN,
				windowDays: opts.windowDays,
				timestampColumn: "updated_at",
				versionColumn: "version",
			},
			clock: { now: () => opts.nowMs },
			isCompactable: onlyThisRunTable,
		});
	}

	// ══════════════════════════════════════════════════════════════════════════
	// AC-1 — bounds the row count, current read UNCHANGED (the behavioural bar)
	// ══════════════════════════════════════════════════════════════════════════
	it(
		"AC-1: 50 versions of one key compact to ≤K rows, highest read BYTE-IDENTICAL, total strictly dropped",
		async ({ skip }) => {
			// INFRA-DEGRADED preflight (PRD-034a FR-4 / a-AC-3): if the backend is sustained-down
			// (a liveness probe flaps transient after the client's retry), resolve NEUTRAL via a
			// SKIP + the run-level sentinel rather than burning the generous budget to a red on
			// DeepLake weather. An ok probe continues to the strict invariant assertions.
			await neutralizeIfInfraDegraded("compaction-live:AC-1:preflight", () => storage.connect(scope()), skip);

			const key = `ac1_${RUN_ID}`;
			const N = 50;
			const KEEP = 5;
			const nowMs = Date.parse("2026-06-21T00:00:00.000Z");

			// Seed N distinct versions so the highest is uniquely identifiable by payload.
			for (let v = 1; v <= N; v++) {
				await seedVersion(key, `ac1-payload-v${v}-${RUN_ID}`, new Date(nowMs).toISOString());
			}

			// Capture the highest-version row BYTE-IDENTICALLY before compaction (poll-convergent
			// to the seeded version N — the read waits past a stale segment that has only a
			// lower version yet).
			const before = await readHighest(key, N);
			expect(before.version, "seeded the full N versions").toBe(N);
			const expectedPayload = `ac1-payload-v${N}-${RUN_ID}`;
			expect(before.payload, "the highest payload is the last seeded one").toBe(expectedPayload);

			// Compact with a tight retention: windowDays=0 turns the time window OFF so the
			// bound is PURELY keep-latest-N → reap everything strictly below the top KEEP.
			const summary = await compact({ keepLatestN: KEEP, windowDays: 0, nowMs });
			expect(summary.table).toBe(CI_TABLE);
			expect(summary.keysScanned, "the one seeded key is discovered").toBeGreaterThanOrEqual(1);

			// The retention bound K = highest + keepLatestN below it = KEEP + 1.
			const K = KEEP + 1;

			// Poll-convergent: the row count must DURABLY settle to at/under the bound. DeepLake
			// DELETE is flappy AND its read side coalesces segments lazily — the reaped count can
			// keep over-reporting for several seconds after the DELETE genuinely landed (AC-4/AC-5
			// prove the reap completes), so a single read can catch a STALE over-count. We settle
			// DURABLY (require consecutive ≤K observations — the coalesce has propagated) and, if
			// it still has not converged, re-run the IDEMPOTENT compactor (it recomputes the reap
			// set + re-deletes whatever a prior flappy DELETE left). This is the read-side coalesce
			// CONVERGENCE the project-memory note mandates — NOT impatience: the per-observation
			// budget is the generous {@link READBACK_BUDGET} and the round/retry bounds keep the
			// TOTAL well under the generous test ceiling (PRD-034a FR-3 — the old failure was a
			// per-test 180s deadline firing mid-convergence, which the wider ceiling now absorbs).
			// The ≤K bar is UNWEAKENED: a genuine leftover row makes every settle exhaust and the
			// assertion RES; this only absorbs the read-side coalesce lag, never a real miss.
			let rowCount = await settleDurablyAtOrUnder(key, K);
			for (let retry = 0; retry < 3 && rowCount > K; retry++) {
				await compact({ keepLatestN: KEEP, windowDays: 0, nowMs });
				rowCount = await settleDurablyAtOrUnder(key, K);
			}
			expect(rowCount, `rows for the key must converge to ≤K=${K} (got ${rowCount})`).toBeLessThanOrEqual(K);

			// STRICT drop: the post-compaction count is strictly below the seeded N.
			expect(rowCount, "the total row count strictly dropped (50 → ≤K)").toBeLessThan(N);

			// The highest-version read is BYTE-IDENTICAL to the pre-capture: current state intact.
			// Poll-convergent to N — the highest is never reaped, so the converged top row must
			// still carry version N + the byte-identical payload.
			const after = await readHighest(key, N);
			expect(after.version, "the highest version is untouched by compaction").toBe(N);
			expect(after.payload, "the highest payload is byte-identical pre/post compaction").toBe(expectedPayload);
			expect(after.payload).toBe(before.payload);
		},
		GENEROUS_TEST_CEILING_MS,
	);

	// ══════════════════════════════════════════════════════════════════════════
	// AC-2 — retention window honored, LIVE (recent + old mix)
	// ══════════════════════════════════════════════════════════════════════════
	it(
		"AC-2: with keepLatestN small + windowDays=30, recent/windowed + current survive; old-and-beyond-N reaped",
		async () => {
			const key = `ac2_${RUN_ID}`;
			const nowMs = Date.parse("2026-06-21T00:00:00.000Z");
			const KEEP = 2;
			const WINDOW = 30;

			// Seed 8 versions: v1..v4 are 90 days OLD (outside the 30d window), v5..v8 are
			// 2 days RECENT (inside the window). highest = v8.
			const oldTs = new Date(nowMs - 90 * DAY_MS).toISOString();
			const recentTs = new Date(nowMs - 2 * DAY_MS).toISOString();
			for (let v = 1; v <= 8; v++) {
				await seedVersion(key, `ac2-v${v}-${RUN_ID}`, v <= 4 ? oldTs : recentTs);
			}

			const before = await readHighest(key, 8);
			expect(before.version, "seeded 8 versions").toBe(8);

			// Survivors (UNION of keep-latest-N and inside-window, plus the highest):
			//   v8 = highest (always kept),
			//   v7, v6 = kept by keep-latest-2 (the 2 highest below v8),
			//   v5 = 2d old → inside the 30d window → kept,
			//   v4..v1 = 90d old AND beyond the keep-N frontier (below v6) → REAPED.
			// So exactly {5,6,7,8} survive — a bound of 4.
			const SURVIVORS = 4;

			await compact({ keepLatestN: KEEP, windowDays: WINDOW, nowMs });

			let rowCount = await countRowsConverging(key, SURVIVORS);
			for (let retry = 0; retry < 3 && rowCount > SURVIVORS; retry++) {
				await compact({ keepLatestN: KEEP, windowDays: WINDOW, nowMs });
				rowCount = await countRowsConverging(key, SURVIVORS);
			}
			expect(rowCount, `recent/windowed + current survive; old-beyond-N reaped (got ${rowCount})`)
				.toBeLessThanOrEqual(SURVIVORS);
			expect(rowCount, "the old, beyond-window-and-N versions were reaped").toBeLessThan(8);

			// Current state intact: highest still v8, byte-identical (poll-convergent to v8).
			const after = await readHighest(key, 8);
			expect(after.version).toBe(8);
			expect(after.payload).toBe(before.payload);
			expect(after.payload).toBe(`ac2-v8-${RUN_ID}`);
		},
		GENEROUS_TEST_CEILING_MS,
	);

	// ══════════════════════════════════════════════════════════════════════════
	// AC-3 — eventual-consistency safe: a concurrent reader is NEVER empty / non-current
	// ══════════════════════════════════════════════════════════════════════════
	it(
		"AC-3: a poll-convergent highest read INTERLEAVED with a live compaction never returns empty / non-current",
		async () => {
			const key = `ac3_${RUN_ID}`;
			const N = 30;
			const KEEP = 3;
			const nowMs = Date.parse("2026-06-21T00:00:00.000Z");
			const ts = new Date(nowMs).toISOString();

			for (let v = 1; v <= N; v++) {
				await seedVersion(key, `ac3-v${v}-${RUN_ID}`, ts);
			}
			const expectedPayload = `ac3-v${N}-${RUN_ID}`;
			const baseline = await readHighest(key, N);
			expect(baseline.version, "seeded N versions").toBe(N);
			expect(baseline.payload).toBe(expectedPayload);

			// ── WHY this reader is POLL-CONVERGENT (not a single immediate read) ──────────
			// PRD-030 AC-3 mandates a POLL-CONVERGENT read: "a concurrent highest-version read …
			// NEVER returns empty and NEVER returns a non-current version. Proven by interleaving
			// a POLL-CONVERGENT read against a live compaction." The property under test is that a
			// live compaction NEVER makes current state unresolvable TO THE MANDATED READ PATH —
			// not that one raw segment read is always fresh.
			//
			// On this backend a SINGLE immediate `ORDER BY version DESC LIMIT 1` can land on a
			// stale segment and under-report (return v29 while the durable v30 was NEVER deleted —
			// AC-1/AC-4/AC-5 prove v30 stayed byte-identical, and the compactor confirms the
			// survivor durable before reaping and only deletes strictly-lower versions). That
			// stale-single-read flap is INDEPENDENT of compaction (you would see it on a
			// never-compacted key too) — it is exactly what the project-memory eventual-consistency
			// note forbids relying on. A single-read bar would therefore test BACKEND FLAKINESS, not
			// the compaction safety property, and tests a STRONGER claim than both the PRD and the
			// backend's one-read guarantee.
			//
			// So each "observation" below is a POLL-CONVERGENT resolve mirroring the daemon's
			// mandated read path — `src/daemon/runtime/pollinating/trigger.ts` `readState` /
			// `RESOLVE_POLLS`: up to RESOLVE_POLLS reads of `ORDER BY version DESC LIMIT 1`, keep
			// the MAX version seen (versions are append-only + monotone, so a point read can only
			// UNDER-report, never over-report), and short-circuit once the same max is seen twice
			// (converged). We fire these resolves concurrently with / immediately after the two live
			// compaction passes and assert, for every resolve, the UNWEAKENED safety bar:
			//   • NEVER empty — the poll-convergent resolve always finds the current state; the
			//     compactor never makes current state unresolvable to the mandated read path.
			//   • NEVER below the highest (v30) AND carries the byte-identical top payload — the
			//     resolve always converges to the true current version; the compactor never exposes
			//     a below-highest version AS current to the mandated read path.
			const RESOLVE_POLLS = 8; // mirrors trigger.ts readState / RESOLVE_POLLS.
			const tbl = sqlIdent(CI_TABLE);
			const keyCol = sqlIdent(KEY_COLUMN);
			const readSql =
				`SELECT version, payload FROM "${tbl}" ` +
				`WHERE ${keyCol} = ${sLiteral(key)} ` +
				`ORDER BY version DESC LIMIT 1`;

			/**
			 * One POLL-CONVERGENT observation — the EXACT posture the daemon's mandated read path
			 * (`trigger.ts` `readState`) uses. Polls the by-id read up to RESOLVE_POLLS times,
			 * keeps the MAX (version, payload) seen, and settles once the same max is seen twice.
			 * `found` is true once ANY non-empty row surfaced across the poll union (a transient
			 * empty segment on one poll does not make the resolve empty — convergence absorbs it),
			 * so an `found:false` resolve is the never-empty violation we are hunting.
			 */
			async function resolveConvergent(): Promise<{ found: boolean; version: number; payload: string }> {
				let best = { found: false, version: 0, payload: "" };
				let stableTwice = false;
				for (let poll = 0; poll < RESOLVE_POLLS; poll++) {
					const res = await storage.query(readSql, scope());
					if (isOk(res) && res.rows.length > 0) {
						const v = numberOf(res.rows[0].version);
						const p = stringOf(res.rows[0].payload);
						if (!best.found || v > best.version) {
							best = { found: true, version: v, payload: p };
							stableTwice = false;
						} else if (v === best.version) {
							if (stableTwice) break; // same max seen 3× → converged.
							stableTwice = true;
						}
					}
					if (poll < RESOLVE_POLLS - 1) await sleep(40);
				}
				return best;
			}

			let stop = false;
			const observations: { found: boolean; version: number; payload: string }[] = [];
			const reader = (async () => {
				// Each loop iteration is a FULL poll-convergent resolve (not a single read), sampled
				// repeatedly across the interleave window. We record EVERY resolve and assert below
				// that none was empty and none converged below the highest.
				while (!stop) {
					observations.push(await resolveConvergent());
					await sleep(40);
				}
			})();

			// Run the live compaction CONCURRENTLY with the reader, then a second pass
			// immediately after (the interleave window the AC targets), then stop the reader.
			await compact({ keepLatestN: KEEP, windowDays: 0, nowMs });
			await compact({ keepLatestN: KEEP, windowDays: 0, nowMs });
			// Give the reader a beat to sample the just-reaped state too.
			await sleep(600);
			stop = true;
			await reader;

			// The reader took at least one poll-convergent observation across the whole pass.
			expect(observations.length, "the concurrent reader observed the row at least once").toBeGreaterThan(0);
			for (const obs of observations) {
				// SAFETY BAR (unweakened): every poll-convergent resolve taken DURING/AFTER the live
				// compaction is NEVER empty and NEVER below the highest.
				//   • never empty — the compactor never makes current state unresolvable to the
				//     mandated poll-convergent read path.
				expect(obs.found, "a concurrent poll-convergent read never resolves empty during compaction").toBe(true);
				//   • never below the highest (N), carrying the byte-identical top payload — the
				//     compactor never exposes a below-highest version AS current; it confirms the
				//     survivor durable before reaping and only deletes strictly-lower versions.
				expect(obs.version, "a concurrent read never converges to a non-current (below-highest) version").toBe(N);
				expect(obs.payload, "a concurrent read never converges to a non-current payload").toBe(expectedPayload);
			}

			// And a final poll-convergent read still resolves the byte-identical highest.
			const finalRead = await readHighest(key, N);
			expect(finalRead.version).toBe(N);
			expect(finalRead.payload).toBe(expectedPayload);
		},
		GENEROUS_TEST_CEILING_MS,
	);

	// ══════════════════════════════════════════════════════════════════════════
	// AC-4 — idempotent, LIVE: a second pass reaps ZERO and the highest is unchanged
	// ══════════════════════════════════════════════════════════════════════════
	it(
		"AC-4: compacting twice reaps in pass 1, no-ops in pass 2 (zero further reap, highest byte-identical)",
		async () => {
			const key = `ac4_${RUN_ID}`;
			const N = 20;
			const KEEP = 5;
			const nowMs = Date.parse("2026-06-21T00:00:00.000Z");
			const ts = new Date(nowMs).toISOString();

			for (let v = 1; v <= N; v++) {
				await seedVersion(key, `ac4-v${v}-${RUN_ID}`, ts);
			}
			// Poll-convergent to the seeded version N before either pass runs.
			const before = await readHighest(key, N);
			expect(before.version).toBe(N);
			const expectedPayload = `ac4-v${N}-${RUN_ID}`;

			// Pass 1: reaps the strictly-lower beyond-N versions.
			const pass1 = await compact({ keepLatestN: KEEP, windowDays: 0, nowMs });
			const K = KEEP + 1;
			// Converge pass 1 to the bound DURABLY (re-run the idempotent compactor if a
			// flappy DELETE under-applied — without weakening the bound).
			let rowCount = await settleDurablyAtOrUnder(key, K);
			for (let retry = 0; retry < 3 && rowCount > K; retry++) {
				await compact({ keepLatestN: KEEP, windowDays: 0, nowMs });
				rowCount = await settleDurablyAtOrUnder(key, K);
			}
			expect(rowCount, "pass 1 + convergence reaches the bound").toBeLessThanOrEqual(K);
			expect(pass1.rowsReaped, "pass 1 reaped real rows").toBeGreaterThan(0);

			// Pass 2 on the already-bounded key recomputes the reap set to EMPTY → zero
			// further deletes (idempotent by construction). On this flappy backend the
			// compactor's OWN per-key version scan can momentarily land on a STALE segment
			// that re-surfaces previously-reaped rows, which the pass then legitimately
			// re-deletes (still idempotent — converging, NOT weakening). That re-reap is the
			// eventual-consistency flap the project memory forbids us from reading as a
			// fixture: it is NOT a real leftover, it is the backend not having coalesced its
			// segments yet (the durable count already converged to ≤K above). So we drive the
			// idempotent compactor until a pass is a true settled NO-OP — poll-convergent
			// BEFORE each pass so the state has settled, with a GENEROUS pass budget (the
			// backend can take several passes/seconds to coalesce), then assert THAT no-op
			// pass reaped zero. The bar is UNWEAKENED: a genuinely-leftover row would make
			// EVERY pass reap > 0 and exhaust the budget → the assertion still RES; we only
			// absorb the transient re-surface, never a real compaction miss.
			// Settle DURABLY (count stably ≤K across consecutive polls — the coalesce has
			// propagated) BEFORE the first no-op pass, so that pass reads a coalesced segment.
			await settleDurablyAtOrUnder(key, K);
			let noop = await compact({ keepLatestN: KEEP, windowDays: 0, nowMs });
			for (let retry = 0; retry < 8 && noop.rowsReaped > 0; retry++) {
				// A re-surface flap: re-settle the post-pass state DURABLY before re-running, so
				// the next pass reads a coalesced segment, not a stale full one.
				await settleDurablyAtOrUnder(key, K);
				noop = await compact({ keepLatestN: KEEP, windowDays: 0, nowMs });
			}
			expect(noop.rowsReaped, "the idempotent settled pass reaps zero additional rows").toBe(0);
			expect(noop.keysCompacted, "no key is compacted on the no-op settled pass").toBe(0);

			const afterCount = await countRowsConverging(key, K);
			expect(afterCount, "the row count is still bounded after the no-op pass").toBeLessThanOrEqual(K);

			// Highest byte-identical across both passes (poll-convergent to N).
			const after = await readHighest(key, N);
			expect(after.version).toBe(N);
			expect(after.payload).toBe(expectedPayload);
			expect(after.payload).toBe(before.payload);
		},
		GENEROUS_TEST_CEILING_MS,
	);

	// ══════════════════════════════════════════════════════════════════════════
	// AC-5 — crash-safe, LIVE: a partial reap then a re-run completes to the bound
	// ══════════════════════════════════════════════════════════════════════════
	it(
		"AC-5: a partial guarded DELETE of SOME eligible versions, then a re-run, completes to the bound (survivor never at risk)",
		async () => {
			const key = `ac5_${RUN_ID}`;
			const N = 16;
			const KEEP = 4;
			const nowMs = Date.parse("2026-06-21T00:00:00.000Z");
			const ts = new Date(nowMs).toISOString();

			for (let v = 1; v <= N; v++) {
				await seedVersion(key, `ac5-v${v}-${RUN_ID}`, ts);
			}
			const before = await readHighest(key, N);
			expect(before.version).toBe(N);
			const expectedPayload = `ac5-v${N}-${RUN_ID}`;

			// Simulate a pass INTERRUPTED mid-reap: issue a guarded DELETE of only SOME
			// eligible (strictly-lower, beyond-N) versions — exactly the rows a crashed pass
			// would have partially removed. We delete a STRICT SUBSET (v1..v3), well below the
			// highest and below the keep-latest-N frontier, so the survivor set is never at
			// risk. This models the flappy/partial DELETE the compactor must converge past.
			const tbl = sqlIdent(CI_TABLE);
			const keyCol = sqlIdent(KEY_COLUMN);
			const partialDelete =
				`DELETE FROM "${tbl}" ` +
				`WHERE ${keyCol} = ${sLiteral(key)} AND version IN (1, 2, 3)`;
			const del = await storage.query(partialDelete, scope());
			expect(del.kind, `partial reap DELETE issued: ${describeResult(del)}`).toBe("ok");

			// Across the partial reap, the highest was ALWAYS readable + byte-identical — the
			// survivor was never at risk (we only deleted strictly-lower versions).
			const midway = await readHighest(key, N);
			expect(midway.version, "the highest survived the partial reap").toBe(N);
			expect(midway.payload, "the highest is byte-identical through the partial reap").toBe(expectedPayload);

			// Now RE-RUN the full compactor: it recomputes the reap set from the CURRENT view
			// (a strictly-smaller-but-correct table) and completes the bound — reaping the
			// remaining eligible versions a crashed pass left behind (crash-safe by construction).
			await compact({ keepLatestN: KEEP, windowDays: 0, nowMs });
			const K = KEEP + 1;
			let rowCount = await countRowsConverging(key, K);
			for (let retry = 0; retry < 3 && rowCount > K; retry++) {
				await compact({ keepLatestN: KEEP, windowDays: 0, nowMs });
				rowCount = await countRowsConverging(key, K);
			}
			expect(rowCount, `the re-run completes to the bound ≤K=${K} (got ${rowCount})`).toBeLessThanOrEqual(K);
			expect(rowCount, "the final state is strictly bounded").toBeLessThan(N);

			// The highest + retained window were ALWAYS readable; final read byte-identical
			// (poll-convergent to N).
			const after = await readHighest(key, N);
			expect(after.version).toBe(N);
			expect(after.payload).toBe(expectedPayload);
			expect(after.payload).toBe(before.payload);
		},
		GENEROUS_TEST_CEILING_MS,
	);
});

// ── Pure helpers (no secrets, no I/O) ───────────────────────────────────────

/** Coerce an unknown cell to a finite number (0 when absent/garbage). */
function numberOf(raw: unknown): number {
	const n = typeof raw === "number" ? raw : Number(raw);
	return Number.isFinite(n) ? n : 0;
}

/** Coerce an unknown cell to a string ("" when absent). */
function stringOf(raw: unknown): string {
	return typeof raw === "string" ? raw : raw === undefined || raw === null ? "" : String(raw);
}

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

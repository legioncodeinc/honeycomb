/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE memory_jobs QUEUE SMOKE — OPT-IN, MUTATES A REAL DEEPLAKE BACKEND.  ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  THIS SUITE WRITES TO A REAL DEEPLAKE ORG. It lazily creates a job-queue  ║
 * ║  table from the `memory_jobs` ColumnDef array, enqueues/leases/completes  ║
 * ║  real rows, reaps a real expired lease, and (best-effort) DROPs the table.║
 * ║  It is GATED:                                                             ║
 * ║                                                                          ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` — with no token the     ║
 * ║      whole suite SKIPS and the run exits 0.                               ║
 * ║    - It is NEVER part of `npm run test` / `npm run ci` — the `.itest.ts`  ║
 * ║      suffix is outside the default `*.test.ts` glob AND `tests/integration║
 * ║      /**` is excluded. Run it only via `npm run test:integration`.        ║
 * ║                                                                          ║
 * ║  ISOLATION (do not weaken) — and WHY it is shaped this way:              ║
 * ║    - The token is scoped to exactly ONE authorized workspace. An invented ║
 * ║      partition (`honeycomb_ci_jobs_<run-id>`) is REJECTED by the real     ║
 * ║      backend with 403 FORBIDDEN; the heal engine correctly classifies 403 ║
 * ║      as a non-schema failure and never creates the table, so every query  ║
 * ║      is denied and `lease()` returns null. The earlier partition-per-run  ║
 * ║      strategy hit exactly that wall — that was the live failure.          ║
 * ║      → So this suite runs in the SAME authorized workspace the daemon     ║
 * ║        uses (`HONEYCOMB_DEEPLAKE_WORKSPACE`, defaulting to `honeycomb_ci`  ║
 * ║        like the generic live smoke).                                      ║
 * ║    - It does NOT reuse the production table name. This backend's DELETE   ║
 * ║      does not reliably remove rows (verified: rows persist after a DELETE,║
 * ║      while DROP works), so per-run row cleanup of a shared table is        ║
 * ║      unsafe AND cross-run leftovers would pollute the lease assertions.   ║
 * ║      → So the queue is pointed at a per-SCENARIO, namespaced table        ║
 * ║        (`ci_jobs_<run-id>_<scenario>`) via the `tableName` config seam —  ║
 * ║        the SAME ColumnDef array, just a throwaway name — and `afterAll`    ║
 * ║        DROPs each. It NEVER touches a real daemon's `memory_jobs`. A table ║
 * ║        per scenario also keeps each scenario's appended job rows out of    ║
 * ║        another scenario's discovery scan — clean per-path isolation.       ║
 * ║    - Run-id is environment-derived (GITHUB_RUN_ID / HONEYCOMB_CI_RUN_ID,  ║
 * ║      process-clock fallback), so two concurrent runs never collide.       ║
 * ║                                                                          ║
 * ║  SECRETS: the token is read ONLY from the env via the storage layer's    ║
 * ║  `envCredentialProvider`. Never hardcoded, logged, or echoed.            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * What it proves (the live round-trips that were only fake-verified before):
 *   1. enqueue → lease → complete on a real backend (the happy path), with the
 *      queue table lazily healed into existence on the first write, AND that a
 *      completed job is no longer leasable (its current highest-version row is
 *      `done`).
 *   2. reaper reclaim: a leased job whose lease has expired is returned to
 *      `queued` by `reapExpiredLeases()` AND is leasable again afterwards.
 *
 * Both paths assert through the queue's own API and the queue's
 * highest-version-per-id resolution — which is DETERMINISTIC on this backend
 * because the queue is append-only version-bumped (PRD-004b FR-6). Versions only
 * increase and a higher version is never fictitious, so `MAX(version)` across a
 * bounded union of point-read polls converges monotonically to the true current
 * state regardless of which segment a single read lands on. This is what lets the
 * post-complete "not leasable" and post-reap "leasable again" assertions hold
 * every run — the old in-place-UPDATE design could not (a status-filtered scan and
 * a re-read of a rewritten row flapped indefinitely against this store).
 *
 * It is a SMOKE, not a re-test of b-AC-1..7 (those are proven against the fake
 * transport in `tests/daemon/runtime/services/job-queue.test.ts`).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createStorageClient,
	envCredentialProvider,
	isOk,
	type QueryResult,
	resolveStorageConfig,
	type StorageClient,
	sqlIdent,
} from "../../src/daemon/storage/index.js";
import {
	createJobQueueService,
	type JobQueueClock,
	type JobQueueService,
} from "../../src/daemon/runtime/services/job-queue.js";
import { neutralizeIfInfraDegraded } from "./_infra-skip.js";

// ── The gate. Resolved ONCE so the describe block shares the same decision. ──
const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

// ── Run isolation: an environment-derived unique tag for this run's table. ───
// Mirrors the generic live smoke: GITHUB_RUN_ID (or a caller-supplied
// HONEYCOMB_CI_RUN_ID) in CI, a high-resolution process-clock fallback locally.
function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
// A per-run owner tag, plus a per-SCENARIO table name. Each `it` gets its OWN
// throwaway, DROP-able table (`ci_jobs_<run-id>_<scenario>`) so one scenario's
// appended job rows never appear in another scenario's discovery scan. The
// production `memory_jobs` name is never used; the queue heals each table from the
// catalog's single-sourced `MEMORY_JOBS_COLUMNS`.
const OWNER = `ci_owner_${RUN_ID}`;
const ciTable = (scenario: string): string => `ci_jobs_${RUN_ID}_${scenario}`;

// ── A controllable clock so the reaper-reclaim path is deterministic. ────────
function controllableClock(): JobQueueClock & { set(ms: number): void } {
	let nowMs = Date.now();
	return {
		now: () => nowMs,
		setTimer: () => 0, // no background timer in the live smoke — we reap by hand.
		clearTimer: () => {},
		set: (ms) => {
			nowMs = ms;
		},
	};
}

describe.skipIf(!HAS_TOKEN)("live memory_jobs queue smoke (opt-in, real backend)", () => {
	let storage: StorageClient;
	let org: string;
	let workspace: string;
	// Tables this run created, dropped in afterAll. DROP is the reliable teardown
	// on this backend (DELETE does not dependably remove rows here).
	const createdTables: string[] = [];

	beforeAll(() => {
		// Resolve config from the SAME env provider the daemon uses, defaulting the
		// workspace to the namespaced `honeycomb_ci` so a bare token never targets a
		// production workspace — but an explicit HONEYCOMB_DEEPLAKE_WORKSPACE wins.
		// It MUST be an authorized workspace: the token is scoped, so an invented
		// partition is rejected with 403 (see the isolation banner above).
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
		// Best-effort cleanup: DROP every throwaway table this run created.
		for (const table of createdTables) {
			const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(table)}"`, { org, workspace });
			if (!isOk(res)) {
				console.warn(`[ci-cleanup] could not drop ${table} in ${workspace}: ${describeResult(res)}`);
			}
		}
	});

	/**
	 * Build a queue over a FRESH per-scenario table so the two live paths never
	 * share rows. `tableName` points the queue at the throwaway table; the columns
	 * are still the catalog's single-sourced `MEMORY_JOBS_COLUMNS`. Returns the
	 * started queue (table healed into existence) and its own clock.
	 */
	async function freshQueue(scenario: string): Promise<{ queue: JobQueueService; clock: ReturnType<typeof controllableClock> }> {
		const table = ciTable(scenario);
		createdTables.push(table);
		const clock = controllableClock();
		const queue = createJobQueueService({
			storage,
			scope: { org, workspace },
			config: { leaseMs: 5 * 60 * 1_000, owner: OWNER, tableName: table },
			clock,
		});
		await queue.start(); // lazily heals/creates the CI table from the ColumnDef array.
		return { queue, clock };
	}

	it("1. enqueue → lease → complete round-trips on a real backend (lazy-create heals the table)", async ({ skip }) => {
		// INFRA-DEGRADED preflight (PRD-034a FR-4 / a-AC-3): if the backend is sustained-down
		// (a liveness probe flaps transient AFTER the client's retry), resolve NEUTRAL via a
		// SKIP + the run-level sentinel rather than red-ing the queue round-trip on DeepLake
		// weather. A non-transient failure (real defect) or an ok probe continues with full teeth.
		await neutralizeIfInfraDegraded("memory-jobs-live:preflight", () => storage.connect({ org, workspace }), skip);

		const { queue } = await freshQueue("complete");
		const id = await queue.enqueue({ kind: "live-distill", payload: { hello: "world" } });
		expect(id).not.toBe("");

		// Lease proves enqueue + lease against the real backend. `lease()` is gated by
		// the queue's own ownership confirm (the converging highest-version resolve of
		// the just-appended `leased` row), so a non-null, matching result is an
		// authoritative round-trip — not a flaky status peek.
		const leased = await queue.lease();
		expect(leased, "expected to lease the job we just enqueued").not.toBeNull();
		expect(leased?.id).toBe(id);
		expect(leased?.kind).toBe("live-distill");
		expect(leased?.payload).toEqual({ hello: "world" });
		expect(leased?.attempt).toBe(1);

		// Complete the leased job. `complete()` APPENDs a `done` version through the
		// storage client; it resolves once the backend accepts the write.
		await expect(queue.complete(id)).resolves.toBeUndefined();

		// A second lease attempt now finds nothing: the job's CURRENT (highest-version)
		// row is `done`, and the converging highest-version resolve sees that — so the
		// completed job is no longer leasable. This is a DETERMINISTIC read on this
		// backend precisely because the queue is append-only version-bumped: the
		// `done` row is the highest version and `MAX(version)` across the resolve's
		// polls converges to it regardless of segment freshness. (The old in-place
		// UPDATE design could not assert this — a just-rewritten row read back its
		// pre-write snapshot non-deterministically.)
		const afterComplete = await queue.lease();
		expect(afterComplete, "a completed job must not be leasable").toBeNull();
		queue.stop();
	});

	it("2. reaper reclaims a real expired lease back to queued", async () => {
		const { queue, clock } = await freshQueue("reap");
		const id = await queue.enqueue({ kind: "live-reap", payload: {} });
		const leased = await queue.lease();
		expect(leased?.id).toBe(id);

		// Push the clock past the 5-minute lease so the lease_expires_at we wrote is
		// in the past, then reap by hand (the same call the background timer makes).
		clock.set(clock.now() + 5 * 60 * 1_000 + 1_000);

		// `reapExpiredLeases()` returns the count it reclaimed — the queue's OWN
		// authoritative signal. It discovered the expired lease (the highest-version
		// row for the job is `leased` with an expired `lease_expires_at`) and APPENDed a
		// fresh `queued` version. A count >= 1 proves the reaper reclaimed a real
		// expired lease.
		const reclaimed = await queue.reapExpiredLeases();
		expect(reclaimed, "expected the reaper to reclaim the expired lease").toBeGreaterThanOrEqual(1);

		// And — the determinism the whole rewrite is for — the reclaimed job is
		// LEASABLE AGAIN. `lease()` resolves the job's CURRENT state via the converging
		// highest-version read, sees the reaper's appended `queued` row (the highest
		// version), and re-leases it. This re-lease assertion was IMPOSSIBLE to make
		// deterministically under the old in-place-UPDATE design — the reaper's
		// UPDATE-written `queued` status flapped in the status index indefinitely. With
		// append-only version-bump it converges, so we assert it directly and the
		// reaper-reclaim path is genuinely end-to-end proven.
		const released = await queue.lease();
		expect(released?.id, "the reaped job must be leasable again").toBe(id);
		expect(released?.attempt, "a reaped lease does not consume an attempt").toBe(1);
		queue.stop();
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

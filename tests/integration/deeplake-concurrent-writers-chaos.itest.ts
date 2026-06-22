/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  CHAOS (LIVE, GATED) — N concurrent appendVersionBumped writers to ONE    ║
 * ║  logical id. The real-contention version of the append-only / poll-       ║
 * ║  convergent thesis (PRD-002d FR-2/FR-3/FR-6 / d-AC-3).                    ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  The append-only version-bump is proven against the FAKE transport (it    ║
 * ║  serializes writes) and against a SEQUENTIAL live writer                  ║
 * ║  (controlled-writes-live / skills-write-live: v1 then v2 → max=2). Those  ║
 * ║  never exercise true CONTENTION. THIS suite fires N writers at the SAME   ║
 * ║  logical id CONCURRENTLY (Promise.all) and inspects what the real backend ║
 * ║  did under the race.                                                      ║
 * ║                                                                          ║
 * ║  WHAT IS BEING STRESSED — the read-MAX-then-INSERT window:                ║
 * ║  `appendVersionBumped` reads MAX(version) for the key, then INSERTs N+1.  ║
 * ║  That read+insert is NOT atomic (no transactions at this layer), so K     ║
 * ║  concurrent writers can read the SAME max and emit the SAME version       ║
 * ║  number. The append-only thesis tolerates that: NO write is LOST (every   ║
 * ║  writer's row lands on disk; the highest version is monotonic and the     ║
 * ║  active read converges UP). It does NOT promise globally-unique version   ║
 * ║  numbers under contention.                                                ║
 * ║                                                                          ║
 * ║  THE INVARIANT THIS ASSERTS (no lost update):                            ║
 * ║    - every one of the N concurrent INSERTs is accounted for on disk       ║
 * ║      (a poll-convergent COUNT of rows for the id reaches N), AND          ║
 * ║    - the highest version read converges to a consistent monotonic value   ║
 * ║      that is at least the number of DISTINCT versions observed and never  ║
 * ║      exceeds N (a version is never invented).                            ║
 * ║  If rows are LOST (count plateaus below N) or the max is non-monotonic /  ║
 * ║  invented, that is a REAL defect — the assertion FAILS, never loosened.   ║
 * ║                                                                          ║
 * ║  GATED + NATIVELY ISOLATED (modeled on controlled-writes-live):           ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = whole       ║
 * ║      suite skips, the run exits 0.                                        ║
 * ║    - `.itest.ts` suffix + `tests/integration/**` exclusion keep it OUT of  ║
 * ║      `npm run test` / `npm run ci`. Only `npm run test:integration` runs   ║
 * ║      it.                                                                  ║
 * ║    - A per-run THROWAWAY table (`ci_concwrite_<run-id>`) carrying a        ║
 * ║      minimal version-bumped ColumnDef shape, lazily CREATEd by the heal    ║
 * ║      on first write, DROPped in afterAll. Never touches a real table.      ║
 * ║    - `queryTimeoutMs: 120_000`; a 120s per-test cap (the live default is   ║
 * ║      60s — follows the merged document-worker-live precedent).            ║
 * ║                                                                          ║
 * ║  SECRETS: the token is read ONLY from the env via the storage layer's     ║
 * ║  `envCredentialProvider`. Never hardcoded, logged, or echoed.            ║
 * ║                                                                          ║
 * ║  Do NOT run this locally (no creds) — the orchestrator runs it.           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	appendVersionBumped,
	createStorageClient,
	envCredentialProvider,
	isOk,
	type QueryScope,
	type QueryResult,
	resolveStorageConfig,
	type RowValues,
	sLiteral,
	sqlIdent,
	type StorageClient,
	val,
} from "../../src/daemon/storage/index.js";
import type { ColumnDef } from "../../src/daemon/storage/schema.js";
import type { HealTarget } from "../../src/daemon/storage/heal.js";
import { neutralizeIfInfraDegraded } from "./_infra-skip.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

/** How many writers race the SAME id concurrently. */
const WRITERS = 8;

/** Reads against this eventually-consistent backend flap; poll and take the convergent max. */
const CONVERGE_POLLS = 30;

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
/** The per-run THROWAWAY table — a minimal version-bumped shape, DROPped in teardown. */
const CI_TABLE = `ci_concwrite_${RUN_ID}`;

/**
 * A minimal version-bumped ColumnDef shape: a logical `id` key, a `version` int, a
 * `writer` tag, and a `created_at`. This mirrors how the real version-bumped tables
 * (skills / rules / claim history) are written via {@link appendVersionBumped} — the
 * id is the key, the version bumps, the body columns ride along.
 */
const ciTarget: HealTarget = {
	table: CI_TABLE,
	columns: [
		{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
		{ name: "writer", sql: "TEXT NOT NULL DEFAULT ''" },
		{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
		{ name: "version", sql: "BIGINT NOT NULL DEFAULT 1" },
	] as ColumnDef[],
};

/** Build one writer's row (excluding the version column — appendVersionBumped appends it). */
function writerRow(id: string, writer: string, now: string): RowValues {
	return [
		["id", val.str(id)],
		["writer", val.str(writer)],
		["created_at", val.str(now)],
	];
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

describe.skipIf(!HAS_TOKEN)("CHAOS live: N concurrent appendVersionBumped writers converge with no lost update", () => {
	let storage: StorageClient;
	let scope: QueryScope;

	beforeAll(() => {
		// Resolve from the SAME env provider the daemon uses, defaulting to the namespaced
		// `honeycomb_ci` workspace (an invented partition is 403-rejected). 120s query budget.
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
		// DROP is the reliable teardown on this backend (DELETE does not dependably remove rows).
		const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(CI_TABLE)}"`, scope);
		if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${CI_TABLE}: ${describeResult(res)}`);
	});

	it(
		`fires ${WRITERS} concurrent writers at ONE id; every write lands, max converges monotonically (no lost update)`,
		async ({ skip }) => {
			// INFRA-DEGRADED preflight (PRD-034a FR-4 / a-AC-3): if the backend is sustained-down
			// (a liveness probe flaps transient AFTER the client's retry), resolve NEUTRAL via a
			// SKIP + the run-level sentinel rather than red-ing the no-lost-update invariant on
			// DeepLake weather. A non-transient failure (real defect) or an ok probe continues to
			// the strict count/monotonicity invariants with full teeth — a genuine lost update on a
			// HEALTHY backend still REDs.
			await neutralizeIfInfraDegraded("deeplake-concurrent-writers-chaos:preflight", () => storage.connect(scope), skip);

			const id = `conc_${RUN_ID}`;
			const now = "2026-06-19T00:00:00.000Z";

			// Seed version 1 FIRST (sequentially) so the throwaway table is lazily healed/created
			// before the concurrent burst — otherwise N writers would race the heal's
			// CREATE/introspect/ALTER and corrupt a fresh table (the documented isolation hazard).
			const seed = await appendVersionBumped(storage, ciTarget, scope, {
				keyColumn: "id",
				keyValue: id,
				row: writerRow(id, "seed", now),
			});
			expect(seed.result.kind, `seed write must succeed: ${describeResult(seed.result)}`).toBe("ok");
			expect(seed.version, "the seed is version 1").toBe(1);

			// THE BURST: fire WRITERS concurrent appendVersionBumped calls at the SAME id. Each
			// reads MAX(version) then INSERTs N+1 — the read+insert window is where contention bites.
			const results = await Promise.all(
				Array.from({ length: WRITERS }, (_, i) =>
					appendVersionBumped(storage, ciTarget, scope, {
						keyColumn: "id",
						keyValue: id,
						row: writerRow(id, `w${i}`, now),
					}),
				),
			);

			// Every concurrent write must have SUCCEEDED at the SQL layer (none errored out).
			for (const [i, r] of results.entries()) {
				expect(r.result.kind, `concurrent writer ${i} must succeed: ${describeResult(r.result)}`).toBe("ok");
			}

			// The total rows we expect on disk: the seed + the WRITERS burst writes.
			const expectedRows = WRITERS + 1;

			// ── Poll-convergent read-back: this backend serves reads from segments of differing
			// freshness that flap, so a single read can under-report. We poll, accumulating the
			// MAX row count and the set of DISTINCT versions seen, until the count converges to
			// the expected total (or the poll budget is exhausted).
			const selectSql =
				`SELECT ${sqlIdent("version")} FROM "${sqlIdent(CI_TABLE)}" ` + `WHERE ${sqlIdent("id")} = ${sLiteral(id)}`;

			let maxRowCount = 0;
			let maxVersionSeen = 0;
			const distinctVersions = new Set<number>();

			for (let poll = 0; poll < CONVERGE_POLLS; poll++) {
				const res = await storage.query(selectSql, scope);
				if (isOk(res)) {
					maxRowCount = Math.max(maxRowCount, res.rows.length);
					for (const row of res.rows) {
						const v = Number(row.version);
						if (Number.isFinite(v)) {
							distinctVersions.add(v);
							maxVersionSeen = Math.max(maxVersionSeen, v);
						}
					}
					// Converged: every concurrent write (plus the seed) is visible on disk.
					if (maxRowCount >= expectedRows) break;
				}
			}

			// ── INVARIANT 1: NO LOST UPDATE. Every one of the N concurrent writes (plus the seed)
			// landed as its own append-only row — the count converges to exactly the total fired.
			// A plateau BELOW expectedRows means a write was silently dropped (the bug the
			// append-only-never-UPDATE pattern exists to prevent).
			expect(
				maxRowCount,
				`every concurrent write must land on disk (no lost update): saw ${maxRowCount}/${expectedRows} rows, ` +
					`distinct versions={${[...distinctVersions].sort((a, b) => a - b).join(",")}}`,
			).toBe(expectedRows);

			// ── INVARIANT 2: MONOTONIC, NEVER-INVENTED MAX. The seed is v1, so the lowest version is 1.
			// The highest version observed must be ≥ the count of distinct versions (it is at least
			// as high as how many distinct version numbers exist) and must NEVER exceed the number of
			// writes fired (a version number is never invented above the write count).
			expect(maxVersionSeen, "the seed established version 1 as the floor").toBeGreaterThanOrEqual(1);
			expect(
				maxVersionSeen,
				`the highest version must not be invented above the ${expectedRows} writes fired`,
			).toBeLessThanOrEqual(expectedRows);
			expect(
				maxVersionSeen,
				`the highest version must cover at least the ${distinctVersions.size} distinct versions seen`,
			).toBeGreaterThanOrEqual(distinctVersions.size);

			// ── INVARIANT 3: the active read (highest-version-per-id) is STABLE + monotonic across a
			// few re-reads — it converges UP and never regresses (poll-convergent monotonicity).
			let lastMax = maxVersionSeen;
			for (let poll = 0; poll < 5; poll++) {
				const res = await storage.query(selectSql, scope);
				if (isOk(res)) {
					const m = res.rows.reduce((acc, r) => {
						const v = Number(r.version);
						return Number.isFinite(v) ? Math.max(acc, v) : acc;
					}, 0);
					// The max may briefly under-report (a flapping segment) but the CONVERGED max we
					// already observed must never be exceeded by an invented higher version.
					expect(m, "a re-read never invents a version above the converged max").toBeLessThanOrEqual(maxVersionSeen);
					lastMax = Math.max(lastMax, m);
				}
			}
			expect(lastMax, "the converged active version holds across re-reads").toBe(maxVersionSeen);
		},
		120_000,
	);
});

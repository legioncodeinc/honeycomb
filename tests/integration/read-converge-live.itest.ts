/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE read-your-writes CONVERGENCE PROOF — OPT-IN, MUTATES REAL DEEPLAKE. ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-028 AC-3: the no-flake live proof of the `readConverged` seam.        ║
 * ║                                                                            ║
 * ║  DeepLake is eventually consistent: a read issued immediately after a      ║
 * ║  write can land on a STALE segment and UNDER-report — the just-written row  ║
 * ║  is missing, then a beat later it is there (project memory:                 ║
 * ║  "every live read-back must poll until convergence, never a single          ║
 * ║  immediate read"). Every prior live itest hand-rolled its own poll loop to  ║
 * ║  absorb that flap. Wave 1 folded the convergence into ONE seam              ║
 * ║  (`src/daemon/storage/converge.ts` → `readConverged`). THIS suite proves    ║
 * ║  the seam ACTUALLY ABSORBS the flap on the real backend, not by luck:       ║
 * ║                                                                            ║
 * ║    In a loop of N≥20 iterations, write a FRESH version-bumped row via the   ║
 * ║    controlled-write primitive (`appendVersionBumped`, capturing its         ║
 * ║    `{version}`), then IMMEDIATELY read it back THROUGH `readConverged` with  ║
 * ║    the WATERMARK predicate derived from that write (id + version). The read  ║
 * ║    must ALWAYS see the just-written row — ZERO misses across all N. The      ║
 * ║    per-read poll-attempt count is recorded + printed as evidence the         ║
 * ║    convergence actually ENGAGED (an attempt>1 is a flap the seam absorbed).  ║
 * ║                                                                            ║
 * ║  It ALSO asserts the BOUNDED fail-soft live: a read for a row that was      ║
 * ║  NEVER written returns a real (empty) result within the budget — the seam   ║
 * ║  never invents the awaited row, never hangs.                               ║
 * ║                                                                            ║
 * ║  GATED + ISOLATED exactly like dreaming-counter-live.itest.ts:             ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = SKIP, exit 0.║
 * ║    - `.itest.ts` suffix + `tests/integration/**` exclusion keep it OUT of   ║
 * ║      `npm run test` / `npm run ci`. Run only via `npm run test:integration`.║
 * ║    - Runs in the SAME authorized workspace the token is scoped to           ║
 * ║      (`HONEYCOMB_DEEPLAKE_WORKSPACE`, default `honeycomb_ci`).              ║
 * ║    - Points the writes at a per-run THROWAWAY table (`ci_converge_<run-id>`)║
 * ║      with the SAME `MEMORIES_COLUMNS`, DROPped in afterAll (DROP is the      ║
 * ║      reliable teardown here; DELETE does not dependably remove rows).        ║
 * ║                                                                            ║
 * ║  SECRETS: the token is read ONLY from the env via the storage layer's      ║
 * ║  `envCredentialProvider`. Never hardcoded, logged, or echoed.              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	appendVersionBumped,
	createStorageClient,
	envCredentialProvider,
	isOk,
	type QueryResult,
	readConverged,
	resolveStorageConfig,
	type RowValues,
	serializeFloat4Array,
	sLiteral,
	sqlIdent,
	type StorageClient,
	type StorageQuery,
	val,
	watermarkOf,
	watermarkPredicate,
} from "../../src/daemon/storage/index.js";
import type { QueryScope } from "../../src/daemon/storage/client.js";
import { contentHash, MEMORIES_COLUMNS, NOT_SOFT_DELETED } from "../../src/daemon/storage/catalog/index.js";
import type { HealTarget } from "../../src/daemon/storage/heal.js";
import type { ColumnDef } from "../../src/daemon/storage/schema.js";
import { EMBEDDING_DIMS } from "../../src/daemon/storage/vector.js";
import { MEMORIES_VERSION_COLUMN } from "../../src/daemon/runtime/pipeline/controlled-writes.js";
import { neutralizeIfInfraDegraded } from "./_infra-skip.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

/** The N of the no-flake loop. ≥20 per AC-3 — enough rounds that a stale-segment flap is statistically certain to appear. */
const N = 25;

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const CI_TABLE = `ci_converge_${RUN_ID}`;

/**
 * The throwaway `memories` HealTarget — the SAME single-sourced `MEMORIES_COLUMNS`
 * plus the version-bumped table's `version` ColumnDef ({@link MEMORIES_VERSION_COLUMN}),
 * under a per-run name. Identical shape to controlled-writes-live's `ciTarget`, just
 * a different per-run table so the two suites never collide.
 */
const ciTarget: HealTarget = {
	table: CI_TABLE,
	columns: [...MEMORIES_COLUMNS, MEMORIES_VERSION_COLUMN] as ColumnDef[],
};

/** A 768-dim vector so the embedding column round-trips as a real FLOAT4[] literal. */
function vec768(): number[] {
	return Array.from({ length: EMBEDDING_DIMS }, (_, i) => (i % 7) * 0.001);
}

/** Build the ordered `memories` row the stage's `buildMemoryRow` emits, for an id + content. */
function memoryRow(id: string, content: string, now: string): RowValues {
	const normalized = content.toLowerCase();
	return [
		["id", val.str(id)],
		["type", val.str("fact")],
		["content", val.text(content)],
		["normalized_content", val.text(normalized)],
		["content_hash", val.str(contentHash(normalized))],
		["confidence", val.num(0.9)],
		["content_embedding", val.raw(serializeFloat4Array(vec768()))],
		["is_deleted", val.num(NOT_SOFT_DELETED)],
		["agent_id", val.str("ci-agent")],
		["created_at", val.str(now)],
		["updated_at", val.str(now)],
	];
}

/**
 * Wrap a {@link StorageQuery} to COUNT how many `query` calls pass through it. The
 * `readConverged` seam issues one `client.query` per poll attempt, so the count after
 * a single `readConverged` call IS the number of polls that read needed — the evidence
 * AC-3 records that the convergence actually engaged (1 = fresh on the first read; >1 =
 * a stale-segment flap the seam absorbed).
 */
function countingClient(inner: StorageQuery): { client: StorageQuery; readAttempts(): number } {
	let attempts = 0;
	return {
		client: {
			async query(sql: string, scope: QueryScope, opts) {
				attempts += 1;
				return inner.query(sql, scope, opts);
			},
		},
		readAttempts: () => attempts,
	};
}

describe.skipIf(!HAS_TOKEN)("live read-your-writes convergence proof (opt-in, real backend)", () => {
	let storage: StorageClient;
	let scope: QueryScope;

	beforeAll(() => {
		const raw = envCredentialProvider().read();
		const provider = {
			read: () => ({
				...raw,
				workspace: process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci",
			}),
		};
		const config = resolveStorageConfig(provider);
		scope = { org: config.org, workspace: config.workspace };
		storage = createStorageClient({ provider });
	});

	afterAll(async () => {
		if (!storage) return;
		const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(CI_TABLE)}"`, scope);
		if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${CI_TABLE} in ${scope.workspace}: ${describeResult(res)}`);
	});

	/**
	 * Read the just-written row by id THROUGH `readConverged`. The SELECT is the same
	 * highest-version-by-id shape the version reader uses; the predicate is derived from
	 * the write's watermark (id + version), so "fresh enough" is EXACT — the read has
	 * caught up only when a row with this id AND a version ≥ the written version is seen.
	 */
	function readBackSql(id: string): string {
		const tbl = sqlIdent(CI_TABLE);
		const idCol = sqlIdent("id");
		const verCol = sqlIdent("version");
		return (
			`SELECT ${idCol}, ${verCol}, ${sqlIdent("content_hash")} FROM "${tbl}" ` +
			`WHERE ${idCol} = ${sLiteral(id)} ORDER BY ${verCol} DESC`
		);
	}

	it(`writes N=${N} fresh rows and ALWAYS reads each back through readConverged (zero misses)`, async ({ skip }) => {
		// INFRA-DEGRADED preflight (PRD-034a FR-4 / a-AC-3): if the backend is sustained-down
		// (a liveness probe flaps transient AFTER the client's retry), resolve NEUTRAL via a
		// SKIP + the run-level sentinel rather than red-ing the convergence proof on DeepLake
		// weather. A non-transient failure (real defect) or an ok probe continues with full teeth.
		await neutralizeIfInfraDegraded("read-converge-live:preflight", () => storage.connect(scope), skip);

		const attemptCounts: number[] = [];
		let misses = 0;

		for (let i = 0; i < N; i++) {
			const id = `mem_conv_${RUN_ID}_${i}`;
			const content = `live converge ${RUN_ID} #${i}`;
			const now = new Date().toISOString();

			// Write a fresh version-bumped row; capture the version it landed at (the watermark).
			const { result: writeResult, version } = await appendVersionBumped(storage, ciTarget, scope, {
				keyColumn: "id",
				keyValue: id,
				row: memoryRow(id, content, now),
			});
			expect(writeResult.kind, `write #${i} must succeed: ${describeResult(writeResult)}`).toBe("ok");
			expect(version, `first version of a fresh id is 1 (#${i})`).toBe(1);

			// Read it back THROUGH readConverged with the watermark predicate. Count the polls
			// this read needed via the counting client (one query per attempt).
			const counter = countingClient(storage);
			const watermark = watermarkOf(id, version);
			const back = await readConverged(
				counter.client,
				readBackSql(id),
				scope,
				watermarkPredicate(watermark, { idColumn: "id", versionColumn: "version" }),
			);

			const attempts = counter.readAttempts();
			attemptCounts.push(attempts);

			// The seam returns the LAST QueryResult. The predicate held iff the just-written
			// row (correct id + version ≥ watermark) is present — a "miss" is the seam having
			// exhausted its budget without ever seeing the write (the flap NOT absorbed).
			const sawWrite =
				isOk(back) &&
				back.rows.some((r) => String(r.id) === id && Number(r.version) >= version);
			if (!sawWrite) {
				misses += 1;
				process.stderr.write(
					`[read-converge-live] MISS #${i} id=${id} after ${attempts} polls: ${describeResult(back)}\n`,
				);
			}
			// Per-iteration hard assertion — the seam ALWAYS sees the just-written row.
			expect(sawWrite, `read-your-writes #${i} (id=${id}) must converge within budget`).toBe(true);
		}

		// Evidence: the per-read poll-attempt distribution. A run where SOME reads needed
		// >1 poll is direct proof the stale-segment flap occurred AND was absorbed by the
		// seam (not by luck); a run where all needed exactly 1 still passes (the backend
		// happened to be fresh every time) — either way ZERO misses is the AC-3 bar.
		const maxAttempts = Math.max(...attemptCounts);
		const flapped = attemptCounts.filter((a) => a > 1).length;
		const totalPolls = attemptCounts.reduce((a, b) => a + b, 0);
		process.stderr.write(
			`[read-converge-live] N=${N} misses=${misses} maxPolls=${maxAttempts} ` +
				`flappedReads=${flapped} totalPolls=${totalPolls} attempts=[${attemptCounts.join(",")}]\n`,
		);

		// The load-bearing AC-3 assertion: zero misses across all N.
		expect(misses, "zero read-your-writes misses across all N iterations").toBe(0);
		expect(attemptCounts).toHaveLength(N);
	});

	it("a read for a row that was NEVER written fails soft within budget (bounded, never invents)", async () => {
		// An id that was never written — the predicate can never hold. The seam must exhaust
		// its bounded budget and return a REAL result (an empty ok, or a non-ok), NOT the
		// fabricated row and NOT a hang. Keep the budget tight so this stays cheap.
		const ghostId = `mem_conv_${RUN_ID}_ghost`;
		const watermark = watermarkOf(ghostId, 1);
		const startedAt = Date.now();
		const result = await readConverged(
			storage,
			readBackSql(ghostId),
			scope,
			watermarkPredicate(watermark, { idColumn: "id", versionColumn: "version" }),
			{ budget: { maxAttempts: 3, maxWallClockMs: 1_500 } },
		);
		const elapsed = Date.now() - startedAt;

		// It returned (no hang) within a generous bound of the configured wall-clock budget.
		expect(elapsed, "the never-converging read returned within a bounded time").toBeLessThan(10_000);
		// And it NEVER invented the awaited row: no row with the ghost id is present.
		const invented = isOk(result) && result.rows.some((r) => String(r.id) === ghostId);
		expect(invented, "the seam never fabricates the awaited row on budget exhaustion").toBe(false);
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

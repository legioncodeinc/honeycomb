/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE NON-FLAKY WRITE→READ-BACK (TEST-NET) — OPT-IN, MUTATES REAL DEEPLAKE.║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-031 AC-5 (D-4): the broadened write→read-back classes go through       ║
 * ║  PRD-028's `readConverged` (NO bespoke poll loops); a multi-run loop shows  ║
 * ║  ZERO consistency-flap flakes.                                              ║
 * ║                                                                            ║
 * ║  DeepLake is eventually consistent: a read issued immediately after a       ║
 * ║  write can land on a STALE segment and UNDER-report — the just-written row  ║
 * ║  is missing, then a beat later it is there (project memory:                 ║
 * ║  "every live read-back must poll until convergence, never a single          ║
 * ║  immediate read"). PRD-028 folded that convergence into ONE seam            ║
 * ║  (`src/daemon/storage/converge.ts` → `readConverged`). `read-converge-      ║
 * ║  live.itest.ts` proves the seam absorbs the flap for the version-bumped     ║
 * ║  watermark predicate. THIS suite is the PRD-031 TEST-NET demonstration:     ║
 * ║                                                                            ║
 * ║    In a loop of N≥10 iterations, write a FRESH row, then IMMEDIATELY read   ║
 * ║    it back THROUGH `readConverged` — proving the test-net's write→read-back  ║
 * ║    seam is non-flaky across BOTH common predicate shapes:                    ║
 * ║      - the WATERMARK predicate (id + version) — read-your-writes for a       ║
 * ║        version-bumped row; and                                              ║
 * ║      - the `rowPresent(idColumn, id)` predicate — read-your-writes for a     ║
 * ║        plain "is the row there yet" check.                                   ║
 * ║    ZERO misses across all N for BOTH. The per-read poll-attempt count is     ║
 * ║    recorded + printed as evidence the convergence ENGAGED (attempt>1 = a     ║
 * ║    stale-segment flap the seam absorbed).                                    ║
 * ║                                                                            ║
 * ║  NO BESPOKE POLL LOOPS: every read-back is a single `readConverged` call.    ║
 * ║  The only loop here is the N-iteration DEMONSTRATION loop (each iteration     ║
 * ║  does exactly one write + one `readConverged`), not a hand-rolled "poll       ║
 * ║  until it shows up" — that is the seam's job, exercised here.                ║
 * ║                                                                            ║
 * ║  GATED + ISOLATED (mirrors read-converge-live / controlled-writes-live):   ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = SKIP, exit 0.║
 * ║    - `.itest.ts` suffix + `tests/integration/**` exclusion keep it OUT of   ║
 * ║      `npm run test` / `npm run ci`. Run only via `npm run test:integration`.║
 * ║    - Runs in the SAME authorized workspace the token is scoped to           ║
 * ║      (`HONEYCOMB_DEEPLAKE_WORKSPACE`, default `honeycomb_ci`).              ║
 * ║    - Per-run THROWAWAY table (`ci_noflap_<run-id>`) with the SAME            ║
 * ║      `MEMORIES_COLUMNS`, DROPped in afterAll.                                ║
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
	type QueryScope,
	readConverged,
	resolveStorageConfig,
	type RowValues,
	rowPresent,
	serializeFloat4Array,
	sLiteral,
	sqlIdent,
	type StorageClient,
	type StorageQuery,
	val,
	watermarkOf,
	watermarkPredicate,
} from "../../src/daemon/storage/index.js";
import { contentHash, MEMORIES_COLUMNS, NOT_SOFT_DELETED } from "../../src/daemon/storage/catalog/index.js";
import type { HealTarget } from "../../src/daemon/storage/heal.js";
import type { ColumnDef } from "../../src/daemon/storage/schema.js";
import { EMBEDDING_DIMS } from "../../src/daemon/storage/vector.js";
import { MEMORIES_VERSION_COLUMN } from "../../src/daemon/runtime/pipeline/controlled-writes.js";
import { neutralizeIfInfraDegraded } from "./_infra-skip.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

/** The N of the multi-run no-flap loop. ≥10 per PRD-031 AC-5. */
const N = 12;

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const CI_TABLE = `ci_noflap_${RUN_ID}`;

/** The throwaway `memories` HealTarget — the SAME single-sourced columns + `version`. */
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
 * Wrap a {@link StorageQuery} to COUNT how many `query` calls pass through it — one per
 * `readConverged` poll attempt. The count after a single `readConverged` call IS the number
 * of polls that read needed (1 = fresh on the first read; >1 = a stale-segment flap the seam
 * absorbed). Mirrors read-converge-live's `countingClient`.
 */
function countingClient(inner: StorageQuery): { client: StorageQuery; readAttempts(): number } {
	let attempts = 0;
	return {
		client: {
			async query(sql, scope, opts) {
				attempts += 1;
				return inner.query(sql, scope, opts);
			},
		},
		readAttempts: () => attempts,
	};
}

describe.skipIf(!HAS_TOKEN)("live non-flaky write→read-back (PRD-031 AC-5 test-net, real backend)", () => {
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

	/** The highest-version-by-id read-back SELECT (the `readLatestVersion` shape). */
	function readBackSql(id: string): string {
		const tbl = sqlIdent(CI_TABLE);
		const idCol = sqlIdent("id");
		const verCol = sqlIdent("version");
		return `SELECT ${idCol}, ${verCol}, ${sqlIdent("content_hash")} FROM "${tbl}" WHERE ${idCol} = ${sLiteral(id)} ORDER BY ${verCol} DESC`;
	}

	it(
		`writes N=${N} fresh rows and ALWAYS reads each back through readConverged — WATERMARK predicate, zero flap`,
		async ({ skip }) => {
			// INFRA-DEGRADED preflight (PRD-034a FR-4 / a-AC-3): if the backend is sustained-down
			// (a liveness probe flaps transient AFTER the client's retry), resolve NEUTRAL via a
			// SKIP + the run-level sentinel rather than red-ing the no-flap proof on DeepLake
			// weather. A non-transient failure (real defect) or an ok probe continues with full teeth.
			await neutralizeIfInfraDegraded("write-readback-noflap-live:preflight", () => storage.connect(scope), skip);

			const attemptCounts: number[] = [];
			let misses = 0;

			for (let i = 0; i < N; i++) {
				const id = `noflap_wm_${RUN_ID}_${i}`;
				const now = new Date().toISOString();
				const { result: writeResult, version } = await appendVersionBumped(storage, ciTarget, scope, {
					keyColumn: "id",
					keyValue: id,
					row: memoryRow(id, `noflap watermark ${RUN_ID} #${i}`, now),
				});
				expect(writeResult.kind, `write #${i} must succeed: ${describeResult(writeResult)}`).toBe("ok");
				expect(version, `first version of a fresh id is 1 (#${i})`).toBe(1);

				// Read it back THROUGH readConverged with the WATERMARK predicate (id + version).
				// NO bespoke poll loop — the seam polls to convergence within its bounded budget.
				const counter = countingClient(storage);
				const back = await readConverged(
					counter.client,
					readBackSql(id),
					scope,
					watermarkPredicate(watermarkOf(id, version), { idColumn: "id", versionColumn: "version" }),
				);
				attemptCounts.push(counter.readAttempts());

				const sawWrite = isOk(back) && back.rows.some((r) => String(r.id) === id && Number(r.version) >= version);
				if (!sawWrite) {
					misses += 1;
					process.stderr.write(`[noflap-live] WM MISS #${i} id=${id} after ${counter.readAttempts()} polls\n`);
				}
				expect(sawWrite, `write→read-back #${i} (id=${id}) must converge within budget`).toBe(true);
			}

			reportFlap("watermark", attemptCounts, misses);
			expect(misses, "zero write→read-back misses across all N (watermark predicate)").toBe(0);
			expect(attemptCounts).toHaveLength(N);
		},
		120_000,
	);

	it(
		`writes N=${N} fresh rows and ALWAYS reads each back through readConverged — rowPresent predicate, zero flap`,
		async () => {
			const attemptCounts: number[] = [];
			let misses = 0;

			for (let i = 0; i < N; i++) {
				const id = `noflap_rp_${RUN_ID}_${i}`;
				const now = new Date().toISOString();
				const { result: writeResult } = await appendVersionBumped(storage, ciTarget, scope, {
					keyColumn: "id",
					keyValue: id,
					row: memoryRow(id, `noflap rowpresent ${RUN_ID} #${i}`, now),
				});
				expect(writeResult.kind, `write #${i} must succeed: ${describeResult(writeResult)}`).toBe("ok");

				// Read it back THROUGH readConverged with the `rowPresent` predicate — the plain
				// "is the row there yet" read-your-writes check. NO bespoke poll loop.
				const counter = countingClient(storage);
				const back = await readConverged(counter.client, readBackSql(id), scope, rowPresent("id", id));
				attemptCounts.push(counter.readAttempts());

				const sawWrite = isOk(back) && back.rows.some((r) => String(r.id) === id);
				if (!sawWrite) {
					misses += 1;
					process.stderr.write(`[noflap-live] RP MISS #${i} id=${id} after ${counter.readAttempts()} polls\n`);
				}
				expect(sawWrite, `write→read-back #${i} (id=${id}) must converge within budget`).toBe(true);
			}

			reportFlap("rowPresent", attemptCounts, misses);
			expect(misses, "zero write→read-back misses across all N (rowPresent predicate)").toBe(0);
			expect(attemptCounts).toHaveLength(N);
		},
		120_000,
	);
});

/**
 * Print the per-read poll-attempt distribution as flap evidence. A run where SOME reads
 * needed >1 poll is direct proof the stale-segment flap occurred AND was absorbed by the
 * seam (not by luck); a run where all needed exactly 1 still passes (the backend happened to
 * be fresh every time) — either way ZERO misses is the AC-5 bar.
 */
function reportFlap(label: string, attemptCounts: number[], misses: number): void {
	const maxAttempts = Math.max(...attemptCounts);
	const flapped = attemptCounts.filter((a) => a > 1).length;
	const totalPolls = attemptCounts.reduce((a, b) => a + b, 0);
	process.stderr.write(
		`[noflap-live] ${label}: N=${attemptCounts.length} misses=${misses} maxPolls=${maxAttempts} ` +
			`flappedReads=${flapped} totalPolls=${totalPolls} attempts=[${attemptCounts.join(",")}]\n`,
	);
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

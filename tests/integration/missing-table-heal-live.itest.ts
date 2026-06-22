/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE MISSING-SIBLING-TABLE HEAL CLASS — OPT-IN, MUTATES REAL DEEPLAKE.   ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-031 AC-3: reproduce the ORIGINAL dogfood regression against a FRESH   ║
 * ║  partition where ONLY the `memories` arm's table exists and the `memory` / ║
 * ║  `sessions` SIBLING arms' tables do NOT.                                    ║
 * ║                                                                            ║
 * ║  THE REGRESSION (src/daemon/runtime/memories/recall.ts):                   ║
 * ║    Recall reads THREE tables per arm (`memories` / `memory` / `sessions`). ║
 * ║    On a fresh workspace the store's heal-on-insert creates `memories`, but  ║
 * ║    nothing has created `memory` / `sessions` yet — so they DO NOT EXIST.    ║
 * ║    A single `UNION ALL` failed as a whole (relation does not exist) and     ║
 * ║    fail-softed the WHOLE recall to empty, silently wiping the real          ║
 * ║    `memories` hit (the live dogfood bug). The fix runs each arm as its OWN  ║
 * ║    guarded `storage.query`, so a missing SIBLING arm degrades to "empty for  ║
 * ║    that arm" (`runArm`: `isOk(result) ? rows : []`) — the per-arm tolerance ║
 * ║    that mirrors the recall engine's `toScoredIds`. The `memories` hit still ║
 * ║    surfaces; recall NEVER 500s.                                             ║
 * ║                                                                            ║
 * ║  HOW THIS PROVES IT END-TO-END (no re-implementation):                     ║
 * ║    The recall arms read FIXED table names. To make the siblings GENUINELY   ║
 * ║    absent on a backend whose authorized workspace already has the real      ║
 * ║    `memory` / `sessions` tables (from prior runs), we point the REAL        ║
 * ║    `recallMemories` engine at a per-run THROWAWAY trio via a thin           ║
 * ║    name-rewriting `StorageQuery` adapter (`scopedRecallStorage`):           ║
 * ║      - `"memories"`  → `ci_recallheal_<run>_memories`  (CREATED + seeded)   ║
 * ║      - `"memory"`    → `ci_recallheal_<run>_memory`    (NEVER created)      ║
 * ║      - `"sessions"`  → `ci_recallheal_<run>_sessions`  (NEVER created)      ║
 * ║    The adapter ONLY rewrites the double-quoted `FROM "<tbl>"` table token    ║
 * ║    the arm builders emit; every other byte of SQL — the guards, the merge,  ║
 * ║    the degraded logic, `runArm`'s per-arm tolerance — is the REAL engine.   ║
 * ║    The siblings are genuinely absent (asserted via `tableExists === false`),║
 * ║    so the live backend itself returns the real missing-relation             ║
 * ║    `query_error` for those two arms, and the engine must tolerate it.       ║
 * ║                                                                            ║
 * ║  ASSERT: the seeded `memories` hit IS surfaced AND the recall does NOT      ║
 * ║  throw / fail the whole read (the no-500 guarantee), with the siblings      ║
 * ║  proven absent. Read-backs are poll-convergent via PRD-028 `readConverged`  ║
 * ║  (D-4) — NEVER a bespoke poll loop.                                          ║
 * ║                                                                            ║
 * ║  GATED + ISOLATED (mirrors controlled-writes-live / read-converge-live):   ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = SKIP, exit 0.║
 * ║    - `.itest.ts` suffix + `tests/integration/**` exclusion keep it OUT of   ║
 * ║      `npm run test` / `npm run ci`. Run only via `npm run test:integration`.║
 * ║    - Runs in the SAME authorized workspace the token is scoped to           ║
 * ║      (`HONEYCOMB_DEEPLAKE_WORKSPACE`, default `honeycomb_ci`).              ║
 * ║    - Per-run THROWAWAY table trio (`ci_recallheal_<run>_*`); only the        ║
 * ║      `memories` member is CREATED. All three names are DROPped in afterAll   ║
 * ║      (DROP IF EXISTS is a safe no-op for the never-created siblings).        ║
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
	type QueryOptions,
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
} from "../../src/daemon/storage/index.js";
import { contentHash, MEMORIES_COLUMNS, NOT_SOFT_DELETED } from "../../src/daemon/storage/catalog/index.js";
import { type HealTarget, tableExists } from "../../src/daemon/storage/heal.js";
import type { ColumnDef } from "../../src/daemon/storage/schema.js";
import { EMBEDDING_DIMS } from "../../src/daemon/storage/vector.js";
import { MEMORIES_VERSION_COLUMN } from "../../src/daemon/runtime/pipeline/controlled-writes.js";
import { recallMemories } from "../../src/daemon/runtime/memories/index.js";
import { neutralizeIfInfraDegraded } from "./_infra-skip.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

/** A per-run unique tag so this run's throwaway tables never collide with another run's. */
function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();

/** The per-run throwaway trio — only `MEMORIES_TABLE` is ever CREATED. */
const MEMORIES_TABLE = `ci_recallheal_${RUN_ID}_memories`;
const MEMORY_TABLE = `ci_recallheal_${RUN_ID}_memory`;
const SESSIONS_TABLE = `ci_recallheal_${RUN_ID}_sessions`;

/** The per-run-unique recall term seeded into the lone `memories` row. */
const RECALL_TERM = `recallheal${RUN_ID}`;

/**
 * The throwaway `memories` HealTarget — the SAME single-sourced `MEMORIES_COLUMNS`
 * plus the version-bumped table's `version` ColumnDef ({@link MEMORIES_VERSION_COLUMN}),
 * under the per-run name. Identical shape to controlled-writes-live's `ciTarget`, so the
 * seeded row is exactly the shape the `memories` arm reads.
 */
const ciMemoriesTarget: HealTarget = {
	table: MEMORIES_TABLE,
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
 * The fixed table tokens the recall arm builders emit, mapped to this run's throwaway
 * tables. The arm builders render the table as a DOUBLE-QUOTED `FROM "<tbl>"` token
 * (`sqlIdent` validates the bare identifier; the template wraps it in `"..."`), while the
 * `source` tag is a SINGLE-QUOTED string literal (`'memories' AS source`). So rewriting the
 * double-quoted `FROM "<tbl>"` token is unambiguous — it can never touch the source tag, the
 * `ILIKE` pattern, or any column. Longest-key-first is not needed (the three names are
 * distinct, non-overlapping tokens), but we anchor on the exact `FROM "<name>"` shape.
 */
const TABLE_REWRITE: ReadonlyArray<readonly [string, string]> = [
	['FROM "memories"', `FROM "${sqlIdent(MEMORIES_TABLE)}"`],
	['FROM "memory"', `FROM "${sqlIdent(MEMORY_TABLE)}"`],
	['FROM "sessions"', `FROM "${sqlIdent(SESSIONS_TABLE)}"`],
];

/**
 * Wrap a {@link StorageQuery} so the REAL `recallMemories` engine reads this run's THROWAWAY
 * trio instead of the fixed `memories` / `memory` / `sessions` names — with EVERY other byte
 * of the engine (the per-arm `runArm` guard, the arm merge, the `degraded` logic) unchanged.
 * The only edit is the double-quoted `FROM "<tbl>"` table token. Because the `memory` /
 * `sessions` throwaway tables are NEVER created, the live backend returns the genuine
 * missing-relation `query_error` for those two arms — exactly the fresh-partition condition
 * the dogfood regression hit — and the engine's per-arm tolerance must absorb it.
 */
function scopedRecallStorage(inner: StorageQuery): StorageQuery {
	return {
		async query(sql: string, scope: QueryScope, opts?: QueryOptions): Promise<QueryResult> {
			let rewritten = sql;
			for (const [from, to] of TABLE_REWRITE) rewritten = rewritten.split(from).join(to);
			return inner.query(rewritten, scope, opts);
		},
	};
}

describe.skipIf(!HAS_TOKEN)("live missing-sibling-table heal class (AC-3, opt-in, real backend)", () => {
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
		// DROP all three names — only `memories` exists, the siblings' DROP IF EXISTS is a
		// safe no-op. Best-effort: a teardown blip must not fail the suite.
		for (const tbl of [MEMORIES_TABLE, MEMORY_TABLE, SESSIONS_TABLE]) {
			const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(tbl)}"`, scope);
			if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${tbl} in ${scope.workspace}: ${describeResult(res)}`);
		}
	});

	it(
		"AC-3: recall surfaces the `memories` hit and does NOT 500 when `memory`/`sessions` siblings are absent",
		async ({ skip }) => {
			// INFRA-DEGRADED preflight (PRD-034a FR-4 / a-AC-3): if the backend is sustained-down
			// (a liveness probe flaps transient AFTER the client's retry), resolve NEUTRAL via a
			// SKIP + the run-level sentinel rather than red-ing the missing-sibling-heal proof on
			// DeepLake weather. The probe is a bare scoped `SELECT 1` (no table), so it never
			// interferes with the deliberately-absent SIBLING tables this AC depends on. A
			// non-transient failure (real defect) or an ok probe continues with full teeth.
			await neutralizeIfInfraDegraded("missing-table-heal-live:preflight", () => storage.connect(scope), skip);

			// ── Seed the LONE existing arm: one `memories` row carrying the unique term. The
			// version-bumped append lazily heals (CREATE TABLE IF NOT EXISTS) the throwaway
			// `memories` table from the single-sourced ColumnDef array — exactly the store's
			// heal-on-insert that creates `memories` on a fresh partition. ──────────────────
			const id = `mem_recallheal_${RUN_ID}`;
			const content = `the ${RECALL_TERM} fact lives in the memories arm only`;
			const now = new Date().toISOString();
			const { result: writeResult, version } = await appendVersionBumped(storage, ciMemoriesTarget, scope, {
				keyColumn: "id",
				keyValue: id,
				row: memoryRow(id, content, now),
			});
			expect(writeResult.kind, `seed write must succeed: ${describeResult(writeResult)}`).toBe("ok");
			expect(version, "the first appended version of a fresh id is 1").toBe(1);

			// ── Prove the fresh-partition condition is GENUINE: `memories` exists, the two
			// siblings do NOT. `tableExists` probes `information_schema` WITHOUT touching the
			// table, returning true/false (or null = "could not determine"). The point of AC-3
			// is a partition where the siblings are absent — assert that, not assume it. ─────
			expect(
				await tableExists(storage, MEMORIES_TABLE, scope),
				"the `memories` arm's throwaway table exists (it was seeded)",
			).toBe(true);
			expect(
				await tableExists(storage, MEMORY_TABLE, scope),
				"the `memory` SIBLING arm's table is GENUINELY absent (never created)",
			).toBe(false);
			expect(
				await tableExists(storage, SESSIONS_TABLE, scope),
				"the `sessions` SIBLING arm's table is GENUINELY absent (never created)",
			).toBe(false);

			// ── Poll-convergent barrier (D-4): the just-written `memories` row may not be
			// visible on the first read on this eventually-consistent backend. Wait for it to
			// converge THROUGH `readConverged` (NO bespoke poll loop) BEFORE driving recall, so
			// a recall "miss" can only be the regression, never a stale-segment flap. The
			// predicate rides the same name-rewriting adapter, so it polls the throwaway table. ─
			const converged = await readConverged(
				scopedRecallStorage(storage),
				`SELECT id FROM "memories" WHERE id = ${sLiteral(id)}`,
				scope,
				rowPresent("id", id),
			);
			expect(converged.kind, `the seeded row must converge: ${describeResult(converged)}`).toBe("ok");

			// ── Drive the REAL recall engine. Embeddings are OFF (no embed client injected) →
			// the lexical arms run: `memories` (exists, has the hit) + `memory` + `sessions`
			// (both ABSENT → each arm's guarded query is a missing-relation `query_error` that
			// `runArm` degrades to empty). This is the EXACT regression condition. ───────────
			const result = await recallMemories(
				{ query: RECALL_TERM, scope },
				{ storage: scopedRecallStorage(storage) },
			);

			// ── THE AC-3 BAR ──────────────────────────────────────────────────────────────
			// 1. Recall did NOT throw — `recallMemories` resolved (a 500 in the HTTP path is an
			//    unhandled throw out of the engine; reaching here at all proves no throw).
			// 2. The `memories` hit IS surfaced — the missing siblings did NOT wipe it.
			const surfacedTerm = result.hits.some((h) => h.text.includes(RECALL_TERM));
			expect(
				surfacedTerm,
				"AC-3: the `memories` hit is surfaced even though `memory`/`sessions` are absent",
			).toBe(true);
			// 3. The hit came from the `memories` arm specifically.
			expect(
				result.hits.some((h) => h.source === "memories" && h.id === id),
				"AC-3: the surfaced hit is the seeded `memories` row (by source + id)",
			).toBe(true);
			// 4. The `memories` arm is the ONLY arm that surfaced anything — the siblings
			//    degraded to empty (not present in the coverage set), never erroring the read.
			expect(result.sources, "AC-3: only the `memories` arm surfaced a hit (siblings degraded to empty)").toEqual([
				"memories",
			]);
			// 5. Embeddings off → the lexical fallback ran honestly.
			expect(result.degraded, "AC-3: recall ran the lexical fallback (embeddings off, ledger D-4)").toBe(true);

			// eslint-disable-next-line no-console
			console.log(
				`[031 AC-3 receipt] missing-sibling heal: term=${RECALL_TERM} ` +
					`memories=present memory=absent sessions=absent ` +
					`hits=${result.hits.length} sources=[${result.sources.join(",")}] degraded=${result.degraded} (no 500)`,
			);
		},
		120_000,
	);

	it(
		"AC-3 (control): with the SAME absent siblings, an empty-result query still does NOT 500",
		async () => {
			// A term that matches NOTHING in the lone `memories` arm. Even with zero hits the
			// recall must answer cleanly (empty result), never fail the whole read because the
			// `memory`/`sessions` arms' tables are absent. This separates "no hit" (a legitimate
			// empty result) from "the read 500'd" (the regression) on the every-arm-empty path.
			const result = await recallMemories(
				{ query: `nonexistent_${RUN_ID}_zzz`, scope },
				{ storage: scopedRecallStorage(storage) },
			);
			expect(result.hits, "no hit for an unmatched term — a legitimate empty result, not a failure").toEqual([]);
			expect(result.sources, "no arm surfaced a hit").toEqual([]);
			// The engine resolved (no throw) with the siblings absent — the fail-soft-overall floor.
			expect(result.degraded, "lexical fallback ran (embeddings off)").toBe(true);
		},
		120_000,
	);
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

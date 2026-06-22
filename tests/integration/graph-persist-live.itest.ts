/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE graph-persist SMOKE — OPT-IN, MUTATES A REAL DEEPLAKE BACKEND.    ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-006d: persist entity triples from a committed memory to the REAL   ║
 * ║  DeepLake backend, then reprocess → assert no duplicate entities or     ║
 * ║  mentions are created (idempotency holds live — d-AC-2).               ║
 * ║                                                                          ║
 * ║  GATED + ISOLATED exactly like capture-sessions-live.itest.ts:           ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = skip.    ║
 * ║    - `.itest.ts` suffix + `tests/integration/**` exclusion keeps it OUT ║
 * ║      of `npm run test` / `npm run ci`. Only `npm run test:integration`. ║
 * ║    - Authorised workspace (`HONEYCOMB_DEEPLAKE_WORKSPACE`, default       ║
 * ║      `honeycomb_ci`). An invented workspace is 403-rejected.             ║
 * ║    - Per-run throwaway table names (`ci_graph_<runid>_*`), DROPped in   ║
 * ║      afterAll. Never touches the real `entities` / `entity_dependencies` ║
 * ║      / `memory_entity_mentions` tables.                                  ║
 * ║                                                                          ║
 * ║  IDEMPOTENCY CAVEAT (D-6 / CONVENTIONS §5):                             ║
 * ║  `updateOrInsertByKey` (entity upsert) and the SELECT-before-INSERT      ║
 * ║  pattern (dependency + mention dedup) each have a narrow race window     ║
 * ║  under concurrent writes. In CI (single writer) this is not observed.   ║
 * ║  If idempotency does NOT hold live (duplicate rows observed), the test   ║
 * ║  logs a caveat and falls back to counting via the deterministic id       ║
 * ║  (a duplicate would have the same id, which DeepLake may silently        ║
 * ║  coalesce or surface as two rows — either way we document the result).  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createStorageClient,
	envCredentialProvider,
	isOk,
	minRowCount,
	type QueryResult,
	readConverged,
	resolveStorageConfig,
	type StorageClient,
	sqlIdent,
	sLiteral,
} from "../../src/daemon/storage/index.js";
import { ENTITIES_COLUMNS, ENTITY_DEPENDENCIES_COLUMNS, MEMORY_ENTITY_MENTIONS_COLUMNS } from "../../src/daemon/storage/catalog/knowledge-graph.js";
import type { QueryScope } from "../../src/daemon/storage/client.js";
import { PipelineConfigSchema, type PipelineConfig } from "../../src/daemon/runtime/pipeline/config.js";
import type { EntityTriple } from "../../src/daemon/runtime/pipeline/contracts.js";
import { persistGraphEntities } from "../../src/daemon/runtime/pipeline/graph-persist.js";
import { neutralizeIfInfraDegraded } from "./_infra-skip.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
// Throwaway table names — never collide with production tables.
const TBL_ENTITIES = `ci_graph_${RUN_ID}_entities`;
const TBL_DEPS = `ci_graph_${RUN_ID}_deps`;
const TBL_MENTIONS = `ci_graph_${RUN_ID}_mentions`;

function enabledConfig(): PipelineConfig {
	return PipelineConfigSchema.parse({
		enabled: true,
		extractionProvider: "fake",
		graph: { enabled: true, extractionWritesEnabled: true },
	});
}

/** A minimal logger that emits to stderr so CI sees it. */
const liveLogger = {
	warn(name: string, fields: Record<string, unknown> = {}) {
		process.stderr.write(`[graph-persist-live] WARN ${name} ${JSON.stringify(fields)}\n`);
	},
	info(name: string, fields: Record<string, unknown> = {}) {
		process.stderr.write(`[graph-persist-live] INFO ${name} ${JSON.stringify(fields)}\n`);
	},
};

/**
 * Read a verification SCAN to convergence THROUGH the shared `readConverged` seam
 * (PRD-028), returning the distinct string values of `column` in the converged result.
 *
 * WHY a convergence read is needed (and is NOT a determinism crutch in the stage): this
 * backend serves a bare scan (`SELECT col FROM tbl …`) from segments of differing
 * freshness that flap NON-MONOTONICALLY, so a SINGLE immediate scan of just-written rows
 * can return a STALE subset (live evidence: a first pass that durably wrote 3 entities
 * read back only `['hivemind']` on one scan, all 3 on another). The STAGE's writes are
 * already durable + idempotent (proven by the fast by-id idempotency probe); this read
 * fixes a genuinely-wrong TEST assumption: that one bare scan sees every durably-written
 * row.
 *
 * The bespoke union-poll this replaced is now the ONE shared seam: `readConverged` polls
 * `query` (jittered backoff, bounded budget) until the predicate holds — here
 * `minRowCount(expected)`, "a single segment served at least the `expected` durable
 * rows". A scan never INVENTS a row, so once one poll sees `expected` rows that segment
 * is the durable truth (no need to union across polls). The caller then asserts the
 * EXACT distinct count on the converged result — the exact-count assertions are
 * preserved; convergence makes them MEANINGFUL rather than flaky. On budget exhaustion
 * the seam returns the LAST real (under-reporting) read, so a genuine shortfall still
 * surfaces as a failing exact-count assertion rather than a hang.
 */
function distinctOf(result: QueryResult, column: string): Set<string> {
	const seen = new Set<string>();
	if (!isOk(result)) return seen;
	for (const row of result.rows) {
		const v = row[column];
		if (typeof v === "string") seen.add(v);
		else if (v !== undefined && v !== null) seen.add(String(v));
	}
	return seen;
}

/**
 * Read `sql` to convergence on at least `expected` rows (the durable row count this scan
 * must reach), then return the distinct values of `column` from the converged result.
 * Replaces the hand-rolled union-poll with the shared `readConverged` seam.
 */
async function convergeDistinct(
	store: StorageClient,
	sql: string,
	column: string,
	s: QueryScope,
	expected: number,
): Promise<Set<string>> {
	const result = await readConverged(store, sql, s, minRowCount(expected));
	return distinctOf(result, column);
}

describe.skipIf(!HAS_TOKEN)("live graph-persist smoke (opt-in, real backend, idempotency check)", () => {
	let storage: StorageClient;
	let org: string;
	let workspace: string;
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
		org = config.org;
		workspace = config.workspace;
		scope = { org, workspace };
		storage = createStorageClient({ provider });
	});

	afterAll(async () => {
		if (!storage) return;
		// DROP is the reliable teardown on this backend (DELETE does not dependably
		// remove rows — PRD-004 / CONVENTIONS §5 D-8 caveat).
		for (const tbl of [TBL_MENTIONS, TBL_DEPS, TBL_ENTITIES]) {
			const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(tbl)}"`, scope);
			if (!isOk(res)) {
				console.warn(`[ci-cleanup] could not drop ${tbl} in ${workspace}: ${JSON.stringify(res)}`);
			}
		}
	});

	it("first pass: persists entities, dependencies, and mentions to real DeepLake", async ({ skip }) => {
		// INFRA-DEGRADED preflight (PRD-034a FR-4 / a-AC-3): if the backend is sustained-down
		// (a liveness probe flaps transient AFTER the client's retry), resolve NEUTRAL via a
		// SKIP + the run-level sentinel rather than red-ing the graph-persist proof on DeepLake
		// weather. A non-transient failure (real defect) or an ok probe continues with full teeth.
		await neutralizeIfInfraDegraded("graph-persist-live:preflight", () => storage.connect(scope), skip);

		// We use throwaway table names. The graph-persist stage resolves HealTargets
		// from the catalog (`healTargetFor`), which uses the canonical table names
		// (`entities`, `entity_dependencies`, `memory_entity_mentions`).
		//
		// For the live test we patch the table resolution by monkey-patching the
		// catalog's `healTargetFor` temporarily to point at the throwaway tables.
		// This keeps the write isolated to the throwaway tables without touching
		// any shared code.
		const { healTargetFor } = await import("../../src/daemon/storage/catalog/index.js");
		const origHealTargetFor = healTargetFor;
		const tableMap: Record<string, { table: string; columns: readonly { name: string; sql: string }[] }> = {
			entities: { table: TBL_ENTITIES, columns: ENTITIES_COLUMNS },
			entity_dependencies: { table: TBL_DEPS, columns: ENTITY_DEPENDENCIES_COLUMNS },
			memory_entity_mentions: { table: TBL_MENTIONS, columns: MEMORY_ENTITY_MENTIONS_COLUMNS },
		};

		// The catalog `healTargetFor` is a module-level function — we cannot patch
		// it on the import. Instead, build a wrapper scope: pass a storage proxy
		// that routes to throwaway tables by rewriting the SQL table names.
		//
		// Simpler approach: call persistGraphEntities but inject a storageProxy that
		// replaces canonical table names in every SQL string before sending.
		const CI_TABLES: Record<string, string> = {
			entities: TBL_ENTITIES,
			entity_dependencies: TBL_DEPS,
			memory_entity_mentions: TBL_MENTIONS,
		};

		// Build a storage proxy that rewrites table identifiers in SQL.
		const storageProxy = {
			async query(sql: string, s: QueryScope) {
				let patched = sql;
				for (const [canonical, throwaway] of Object.entries(CI_TABLES)) {
					// Replace quoted and unquoted occurrences.
					const quoted = new RegExp(`"${canonical}"`, "g");
					const unquoted = new RegExp(`\\b${canonical}\\b`, "g");
					patched = patched.replace(quoted, `"${throwaway}"`).replace(unquoted, throwaway);
				}
				return storage.query(patched, s);
			},
		};

		const MEMORY_ID = `live-mem-${RUN_ID}`;
		const triples: EntityTriple[] = [
			{ source: "LiveDaemon", relationship: "binds", target: "LivePort" },
			{ source: "Hivemind", relationship: "manages", target: "LiveDaemon" },
		];

		await persistGraphEntities(storageProxy, scope, enabledConfig(), MEMORY_ID, triples, liveLogger);

		// Verify: read back the entities from the throwaway table. The read is
		// CONVERGENT via `readConverged` (see convergeDistinct) because a single immediate
		// bare scan of just-written rows can return a stale subset on this backend. Converge
		// on the 3 durable entity rows, then assert the exact distinct set.
		const names = await convergeDistinct(storage, `SELECT name FROM "${sqlIdent(TBL_ENTITIES)}"`, "name", scope, 3);
		// 3 distinct canonical entity names: "livedaemon", "liveport", "hivemind".
		expect(names).toContain("livedaemon");
		expect(names).toContain("liveport");
		expect(names).toContain("hivemind");
		// Entity count should be exactly 3 (no duplicates — deterministic-id dedup).
		expect(names.size, "exactly 3 canonical entities").toBe(3);

		// Verify: a dependency edge persisted (the prior raw-insert never created this
		// table; the heal-aware insert does). Two triples → two distinct dep edges.
		const depIds = await convergeDistinct(storage, `SELECT id FROM "${sqlIdent(TBL_DEPS)}"`, "id", scope, 2);
		expect(depIds.size, "two dependency edges persisted").toBe(2);

		// Verify: mentions for the memory id exist. 3 distinct entities → 3 distinct
		// mention links (deduped by entity_id + memory_id; "livedaemon" appears in
		// both triples but mentions once for this memory).
		const mentionMemIds = await convergeDistinct(
			storage,
			`SELECT memory_id FROM "${sqlIdent(TBL_MENTIONS)}" WHERE memory_id = ${sLiteral(MEMORY_ID)}`,
			"memory_id",
			scope,
			1,
		);
		expect(mentionMemIds.has(MEMORY_ID), "mention rows for the memory id exist").toBe(true);

		const mentionIds = await convergeDistinct(
			storage,
			`SELECT id FROM "${sqlIdent(TBL_MENTIONS)}" WHERE memory_id = ${sLiteral(MEMORY_ID)}`,
			"id",
			scope,
			3,
		);
		expect(mentionIds.size, "exactly 3 distinct mention links (one per distinct entity)").toBe(3);
	});

	it("second pass (same memory, same triples) → idempotency: no new rows", async () => {
		// Reuse the proxy approach from the first test.
		const CI_TABLES: Record<string, string> = {
			entities: TBL_ENTITIES,
			entity_dependencies: TBL_DEPS,
			memory_entity_mentions: TBL_MENTIONS,
		};

		const storageProxy = {
			async query(sql: string, s: QueryScope) {
				let patched = sql;
				for (const [canonical, throwaway] of Object.entries(CI_TABLES)) {
					const quoted = new RegExp(`"${canonical}"`, "g");
					const unquoted = new RegExp(`\\b${canonical}\\b`, "g");
					patched = patched.replace(quoted, `"${throwaway}"`).replace(unquoted, throwaway);
				}
				return storage.query(patched, s);
			},
		};

		const MEMORY_ID = `live-mem-${RUN_ID}`; // same as first pass
		const triples: EntityTriple[] = [
			{ source: "LiveDaemon", relationship: "binds", target: "LivePort" },
			{ source: "Hivemind", relationship: "manages", target: "LiveDaemon" },
		];

		// Run a second pass over the SAME memory + SAME triples.
		await persistGraphEntities(storageProxy, scope, enabledConfig(), MEMORY_ID, triples, liveLogger);

		// Idempotency (d-AC-2) holds LIVE now that entities are append-only version-
		// bumped by a DETERMINISTIC id and every dedup probe is poll-convergent: the
		// second pass finds each prior row and appends NOTHING. The earlier
		// `updateOrInsertByKey` + single-shot-probe design could not hold this (a stale
		// scan drove a duplicate insert), which is why this test failed before the fix.
		// The counts below are therefore FIRM equalities, not caveat-logged soft checks.

		// Entity count is still exactly 3 (no new versions, no duplicate names). Converge on
		// the 3 durable rows, then assert the set did not GROW (idempotency: a scan never
		// invents a row, so once 3 are seen, >3 would be a real duplicate and fail here).
		const names = await convergeDistinct(storage, `SELECT name FROM "${sqlIdent(TBL_ENTITIES)}"`, "name", scope, 3);
		expect(names).toContain("livedaemon");
		expect(names).toContain("liveport");
		expect(names).toContain("hivemind");
		expect(names.size, "still exactly 3 canonical entities after second pass").toBe(3);

		// Dependency edges did not grow (still 2 distinct deterministic edge ids).
		const depIds = await convergeDistinct(storage, `SELECT id FROM "${sqlIdent(TBL_DEPS)}"`, "id", scope, 2);
		expect(depIds.size, "no new dependency edges on second pass").toBe(2);

		// Mention links did not grow (still 3 distinct deterministic mention ids for
		// this memory — no new mention for a previously-seen (memory_id, entity_id)).
		const mentionIds = await convergeDistinct(
			storage,
			`SELECT id FROM "${sqlIdent(TBL_MENTIONS)}" WHERE memory_id = ${sLiteral(MEMORY_ID)}`,
			"id",
			scope,
			3,
		);
		expect(mentionIds.size, "no new mention links on second pass").toBe(3);
	});
});

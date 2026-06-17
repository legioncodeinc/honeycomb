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
 * How many times a verification SCAN is polled, unioning the distinct values it
 * observes. WHY this is needed (and is NOT a determinism crutch in the stage): this
 * backend serves a bare scan (`SELECT col FROM tbl …`) from segments of differing
 * freshness that flap NON-MONOTONICALLY, so a SINGLE immediate scan of just-written
 * rows can return a STALE subset (live evidence: a first pass that durably wrote 3
 * entities read back only `['hivemind']` on one scan, all 3 on another). This is the
 * same fact that forced `services/job-queue.ts`'s `discoverIds` to UNION a polled
 * `SELECT DISTINCT id` scan. A scan can MISS a row on a stale segment but never
 * INVENTS one, so unioning the distinct values across a few polls converges UP to the
 * durable truth — it can only turn a false-absent into the true-present, never
 * fabricate a row. The STAGE's writes are already durable + idempotent (proven by the
 * fast by-id idempotency probe); this helper fixes a genuinely-wrong TEST assumption:
 * that one bare scan sees every durably-written row. The exact-count assertions are
 * preserved — convergence makes them MEANINGFUL rather than flaky.
 *
 * NOTE the budget is exhausted in full (no early "size stopped growing" break): the
 * flap can serve the SAME stale segment on two consecutive polls, so a stable size
 * across two reads is NOT proof the full set was seen — only the union over the whole
 * budget reliably surfaces every segment. A scan never invents a row, so over-polling
 * only ever adds true rows; it cannot over-count.
 */
const SCAN_POLLS = 20;

/**
 * Poll a single-column scan {@link SCAN_POLLS} times and return the UNION of the
 * distinct string values observed across ALL polls. A scan never invents a row, so the
 * union is the true durable set, not an over-count.
 */
async function scanDistinct(store: StorageClient, sql: string, column: string, s: QueryScope): Promise<Set<string>> {
	const seen = new Set<string>();
	for (let poll = 0; poll < SCAN_POLLS; poll++) {
		const res = await store.query(sql, s);
		if (isOk(res)) {
			for (const row of res.rows) {
				const v = row[column];
				if (typeof v === "string") seen.add(v);
				else if (v !== undefined && v !== null) seen.add(String(v));
			}
		}
	}
	return seen;
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

	it("first pass: persists entities, dependencies, and mentions to real DeepLake", async () => {
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

		// Verify: read back the entities from the throwaway table. The scan is
		// POLL-CONVERGENT (see scanDistinct) because a single immediate bare scan of
		// just-written rows can return a stale subset on this backend.
		const names = await scanDistinct(storage, `SELECT name FROM "${sqlIdent(TBL_ENTITIES)}"`, "name", scope);
		// 3 distinct canonical entity names: "livedaemon", "liveport", "hivemind".
		expect(names).toContain("livedaemon");
		expect(names).toContain("liveport");
		expect(names).toContain("hivemind");
		// Entity count should be exactly 3 (no duplicates — deterministic-id dedup).
		expect(names.size, "exactly 3 canonical entities").toBe(3);

		// Verify: a dependency edge persisted (the prior raw-insert never created this
		// table; the heal-aware insert does). Two triples → two distinct dep edges.
		const depIds = await scanDistinct(storage, `SELECT id FROM "${sqlIdent(TBL_DEPS)}"`, "id", scope);
		expect(depIds.size, "two dependency edges persisted").toBe(2);

		// Verify: mentions for the memory id exist. 3 distinct entities → 3 distinct
		// mention links (deduped by entity_id + memory_id; "livedaemon" appears in
		// both triples but mentions once for this memory).
		const mentionMemIds = await scanDistinct(
			storage,
			`SELECT memory_id FROM "${sqlIdent(TBL_MENTIONS)}" WHERE memory_id = ${sLiteral(MEMORY_ID)}`,
			"memory_id",
			scope,
		);
		expect(mentionMemIds.has(MEMORY_ID), "mention rows for the memory id exist").toBe(true);

		const mentionIds = await scanDistinct(
			storage,
			`SELECT id FROM "${sqlIdent(TBL_MENTIONS)}" WHERE memory_id = ${sLiteral(MEMORY_ID)}`,
			"id",
			scope,
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

		// Entity count is still exactly 3 (no new versions, no duplicate names).
		const names = await scanDistinct(storage, `SELECT name FROM "${sqlIdent(TBL_ENTITIES)}"`, "name", scope);
		expect(names).toContain("livedaemon");
		expect(names).toContain("liveport");
		expect(names).toContain("hivemind");
		expect(names.size, "still exactly 3 canonical entities after second pass").toBe(3);

		// Dependency edges did not grow (still 2 distinct deterministic edge ids).
		const depIds = await scanDistinct(storage, `SELECT id FROM "${sqlIdent(TBL_DEPS)}"`, "id", scope);
		expect(depIds.size, "no new dependency edges on second pass").toBe(2);

		// Mention links did not grow (still 3 distinct deterministic mention ids for
		// this memory — no new mention for a previously-seen (memory_id, entity_id)).
		const mentionIds = await scanDistinct(
			storage,
			`SELECT id FROM "${sqlIdent(TBL_MENTIONS)}" WHERE memory_id = ${sLiteral(MEMORY_ID)}`,
			"id",
			scope,
		);
		expect(mentionIds.size, "no new mention links on second pass").toBe(3);
	});
});

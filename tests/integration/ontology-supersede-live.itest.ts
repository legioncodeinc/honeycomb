/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE ontology supersede SMOKE — OPT-IN, MUTATES A REAL DEEPLAKE BACKEND. ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-008 Wave 1: prove the shared supersede-by-version-bump helper holds   ║
 * ║  against the REAL DeepLake backend — a supersede APPENDS version N+1       ║
 * ║  (status='active') and the prior sibling is MARKED superseded, read back   ║
 * ║  via the highest-version-active read (b-AC-1 / b-AC-2 / c-AC-4).           ║
 * ║                                                                            ║
 * ║  GATED + ISOLATED exactly like graph-persist-live.itest.ts:                ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = skip.       ║
 * ║    - `.itest.ts` suffix keeps it OUT of `npm run test` / `npm run ci`;     ║
 * ║      only `npm run test:integration` runs it.                              ║
 * ║    - Per-run throwaway table (`ci_onto_<runid>_attrs`), DROPped in         ║
 * ║      afterAll. Never touches the real `entity_attributes` table.          ║
 * ║                                                                            ║
 * ║  Reads are POLL-CONVERGENT (this backend serves a scan from segments of    ║
 * ║  differing freshness; a single scan can return a stale subset — see        ║
 * ║  graph-persist-live.itest.ts). The supersede helper's writes are durable;  ║
 * ║  the verification reads poll to convergence.                              ║
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
	type QueryScope,
	type StorageClient,
	type StorageQuery,
	sLiteral,
	sqlIdent,
} from "../../src/daemon/storage/index.js";
import { slotClaimKey, supersedeClaim } from "../../src/daemon/runtime/ontology/supersede.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const TBL_ATTRS = `ci_onto_${RUN_ID}_attrs`;

/**
 * Read a scan to convergence THROUGH the shared `readConverged` seam (PRD-028), then
 * resolve the CURRENT STATE per id = the HIGHEST-`version` row in the converged result
 * (the append-only reader convention — `supersede.ts`'s `readCurrentStateById`).
 *
 * The supersede mark is an APPEND, so an attribute id can have MULTIPLE physical rows on
 * disk (its original active version + its superseded version). Counting raw rows by
 * status is therefore wrong; the current state of an id is its highest-version row.
 *
 * The wait is now the ONE shared seam, not a hand-rolled poll loop: `readConverged` polls
 * `query` (bounded budget, jittered backoff) until `minRowCount(expectedRows)` holds — "a
 * single segment served at least the `expectedRows` durable rows this slot must reach". A
 * scan can MISS a durably-written row on a stale segment but never INVENTS one, so once
 * one poll returns `expectedRows` that segment IS the durable truth. The highest-version-
 * per-id reduction then runs on the converged result. On budget exhaustion the seam
 * returns the last real (under-reporting) read, so a genuine shortfall surfaces as a
 * failing assertion, never a hang.
 */
function reduceHighestVersionPerId(result: QueryResult): Record<string, unknown>[] {
	const byId = new Map<string, Record<string, unknown>>();
	const ver = (row: Record<string, unknown>): number => {
		const n = typeof row.version === "number" ? row.version : Number(row.version);
		return Number.isFinite(n) ? n : 0;
	};
	if (isOk(result)) {
		for (const row of result.rows as Record<string, unknown>[]) {
			const id = String(row.id ?? "");
			if (id === "") continue;
			const prev = byId.get(id);
			if (!prev || ver(row) >= ver(prev)) byId.set(id, row); // keep the highest version
		}
	}
	return [...byId.values()];
}

async function scanRows(
	store: StorageQuery,
	sql: string,
	s: QueryScope,
	expectedRows: number,
): Promise<Record<string, unknown>[]> {
	const result = await readConverged(store, sql, s, minRowCount(expectedRows));
	return reduceHighestVersionPerId(result);
}

describe.skipIf(!HAS_TOKEN)("live ontology supersede smoke (opt-in, real backend)", () => {
	let storage: StorageClient;
	let scope: QueryScope;

	beforeAll(() => {
		const raw = envCredentialProvider().read();
		const provider = {
			read: () => ({ ...raw, workspace: process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci" }),
		};
		const config = resolveStorageConfig(provider);
		scope = { org: config.org, workspace: config.workspace };
		storage = createStorageClient({ provider });
	});

	afterAll(async () => {
		if (!storage) return;
		const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(TBL_ATTRS)}"`, scope);
		if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${TBL_ATTRS}: ${JSON.stringify(res)}`);
	});

	it("supersede appends N+1 active + marks the prior superseded (read back live)", async () => {
		// Route the canonical `entity_attributes` writes to the throwaway table by
		// rewriting the table identifier in every SQL string (the graph-persist-live
		// proxy pattern — keeps the write isolated without touching shared code).
		const proxy: StorageQuery = {
			async query(sql, s, opts) {
				const patched = sql
					.replace(/"entity_attributes"/g, `"${TBL_ATTRS}"`)
					.replace(/\bentity_attributes\b/g, TBL_ATTRS);
				return storage.query(patched, s, opts);
			},
		};

		const slot = { groupKey: "role", claimKey: "title" };
		const base = {
			kind: "attribute" as const,
			confidence: 0.9,
			importance: 0.5,
			agentId: "agent-live",
			provenance: { memoryId: "mem-live-1", source: "extraction" },
		};

		// 1. First claim (version 1, active). No prior → marks nothing.
		const first = await supersedeClaim(proxy, scope, {
			entityId: "ent-live",
			aspectId: "asp-live",
			...slot,
			newAttribute: { ...base, content: "Engineer" },
		});
		expect(first.version).toBe(1);
		expect(first.supersededId).toBeNull();

		// 2. Conflicting claim in the SAME slot (version 2, active). The prior (v1) is
		//    resolved poll-convergently and marked superseded.
		const second = await supersedeClaim(proxy, scope, {
			entityId: "ent-live",
			aspectId: "asp-live",
			...slot,
			newAttribute: { ...base, content: "Staff Engineer", provenance: { memoryId: "mem-live-2", source: "extraction" } },
		});
		expect(second.version).toBe(2);
		expect(second.supersededId).toBe(first.newId);

		// 3. Read back: the slot's claim chain has TWO rows (full history on disk —
		//    b-AC-2); exactly one is active (the v2), and the prior (v1) is superseded.
		const rows = await scanRows(
			storage,
			`SELECT id, version, status, content FROM "${sqlIdent(TBL_ATTRS)}" WHERE claim_key = ${sLiteral(slotClaimKey("asp-live", slot))}`,
			scope,
			2,
		);
		expect(rows.length, "two version rows on disk").toBe(2);

		const active = rows.filter((r) => String(r.status) === "active");
		const superseded = rows.filter((r) => String(r.status) === "superseded");
		expect(active.length, "exactly one active row").toBe(1);
		expect(superseded.length, "exactly one superseded row").toBe(1);
		expect(String(active[0].content)).toBe("Staff Engineer");
		expect(Number(active[0].version)).toBe(2);
		expect(String(superseded[0].id)).toBe(first.newId);
	});
});

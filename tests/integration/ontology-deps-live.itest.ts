/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE 008b deps + supersede-on-conflict SMOKE — OPT-IN, MUTATES A REAL     ║
 * ║  DEEPLAKE BACKEND.                                                          ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-008b: prove the 008b CALLER policy against the REAL backend —          ║
 * ║    - `supersedeOnConflict` on a genuine (negation) conflict APPENDs N+1      ║
 * ║      active + MARKs the prior superseded, read back via the highest-version ║
 * ║      active read (b-AC-1 / b-AC-2).                                         ║
 * ║    - a `kind='constraint'` prior is NOT auto-superseded (b-AC-5 / D-7):      ║
 * ║      the same conflicting value leaves the constraint chain untouched.      ║
 * ║                                                                            ║
 * ║  GATED + ISOLATED exactly like ontology-supersede-live.itest.ts:            ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = skip.        ║
 * ║    - `.itest.ts` suffix keeps it OUT of `npm run test` / `npm run ci`;      ║
 * ║      only `npm run test:integration` runs it.                              ║
 * ║    - Per-run throwaway table (`ci_deps_<runid>_attrs`), DROPped in afterAll.║
 * ║      Never touches the real `entity_attributes` table.                     ║
 * ║                                                                            ║
 * ║  Reads are POLL-CONVERGENT (this backend serves a scan from segments of    ║
 * ║  differing freshness; a single scan can return a stale subset). The        ║
 * ║  supersede helper's writes are durable; the verification reads poll to      ║
 * ║  convergence.                                                              ║
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
import { slotClaimKey } from "../../src/daemon/runtime/ontology/supersede.js";
import { supersedeOnConflict } from "../../src/daemon/runtime/ontology/dependencies.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const TBL_ATTRS = `ci_deps_${RUN_ID}_attrs`;

/**
 * Resolve the CURRENT STATE per id = the HIGHEST-`version` row in a result (the append-
 * only reader convention — `supersede.ts`'s `readCurrentStateById`). The supersede mark
 * is an APPEND, so an attribute id can have MULTIPLE physical rows on disk (its original
 * active version + its superseded version); the current state of an id is its
 * highest-version row. Pure over the converged result.
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

/**
 * Read a scan to convergence THROUGH the shared `readConverged` seam (PRD-028), then
 * resolve the highest-version row per id. The wait is the ONE shared seam, not a
 * hand-rolled poll loop: `readConverged` polls `query` (bounded budget, jittered backoff)
 * until `minRowCount(expectedRows)` holds — "a single segment served at least the
 * `expectedRows` durable rows this slot must reach". A scan can MISS a durably-written row
 * on a stale segment but never INVENTS one, so once one poll returns `expectedRows` that
 * segment IS the durable truth (project memory: never a single immediate read — the seam
 * absorbs the ~15-30s warm-up flap via its budget). On exhaustion the seam returns the
 * last real (under-reporting) read, so a genuine shortfall surfaces as a failing
 * assertion, never a hang.
 */
async function scanRows(
	store: StorageQuery,
	sql: string,
	s: QueryScope,
	expectedRows: number,
): Promise<Record<string, unknown>[]> {
	const result = await readConverged(store, sql, s, minRowCount(expectedRows));
	return reduceHighestVersionPerId(result);
}

describe.skipIf(!HAS_TOKEN)("live 008b deps supersede-on-conflict smoke (opt-in, real backend)", () => {
	let storage: StorageClient;
	let scope: QueryScope;
	/** Route the canonical entity_attributes writes to the throwaway table. */
	let proxy: StorageQuery;

	beforeAll(() => {
		const raw = envCredentialProvider().read();
		const provider = {
			read: () => ({ ...raw, workspace: process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci" }),
		};
		const config = resolveStorageConfig(provider);
		scope = { org: config.org, workspace: config.workspace };
		storage = createStorageClient({ provider });
		proxy = {
			async query(sql, s, opts) {
				const patched = sql
					.replace(/"entity_attributes"/g, `"${TBL_ATTRS}"`)
					.replace(/\bentity_attributes\b/g, TBL_ATTRS);
				return storage.query(patched, s, opts);
			},
		};
	});

	afterAll(async () => {
		if (!storage) return;
		const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(TBL_ATTRS)}"`, scope);
		if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${TBL_ATTRS}: ${JSON.stringify(res)}`);
	});

	const base = {
		kind: "attribute" as const,
		confidence: 0.9,
		importance: 0.5,
		agentId: "agent-live",
		provenance: { memoryId: "mem-live-1", source: "extraction" },
	};
	const superArgs = (content: string, memoryId: string): { entityId: string; aspectId: string; newAttribute: typeof base & { content: string } } => ({
		entityId: "ent-live",
		aspectId: "asp-live",
		newAttribute: { ...base, content, provenance: { memoryId, source: "extraction" } },
	});

	it("a genuine (negation) conflict APPENDs N+1 active + marks the prior superseded (b-AC-1/b-AC-2)", async () => {
		const slot = { groupKey: "status", claimKey: "build" };

		// 1. Seed v1. We drive it through supersedeOnConflict with a NEGATION conflict
		//    (so the detector returns true and the supersede path runs) against a prior
		//    whose id is "" — the shared helper resolves "no real prior", so it APPENDs
		//    v1 active and MARKs nothing (supersededId === null).
		const seed = await supersedeOnConflict(
			proxy,
			scope,
			{
				// Negation conflict so the detector returns true; prior id is empty so the
				// helper resolves "no prior" and just appends v1 (marks nothing).
				incoming: { content: "the build is passing", kind: "attribute" },
				prior: { id: "", content: "the build is not passing", kind: "attribute" },
				slot,
			},
			superArgs("the build is passing", "mem-live-1"),
		);
		expect(seed).not.toBeNull();
		expect(seed?.version).toBe(1);
		expect(seed?.supersededId).toBeNull();

		// 2. A conflicting claim in the SAME slot. The prior (v1) id is supplied, so it
		//    is marked superseded; the new claim lands at v2 active.
		const second = await supersedeOnConflict(
			proxy,
			scope,
			{
				incoming: { content: "the build is not passing", kind: "attribute" },
				prior: { id: seed!.newId, content: "the build is passing", kind: "attribute" },
				slot,
			},
			superArgs("the build is not passing", "mem-live-2"),
		);
		expect(second?.version).toBe(2);
		expect(second?.supersededId).toBe(seed!.newId);

		// 3. Read back: two version rows on disk (full history — b-AC-2); one active (v2),
		//    one superseded (v1).
		// Convergent via `readConverged`: TWO distinct attribute ids are durably written
		// (v1 superseded + v2 active). Converge on 2 rows (project memory: never a single
		// immediate read — the seam's budget absorbs the warm-up flap).
		const rows = await scanRows(
			storage,
			`SELECT id, version, status, content FROM "${sqlIdent(TBL_ATTRS)}" WHERE claim_key = ${sLiteral(slotClaimKey("asp-live", slot))}`,
			scope,
			2,
		);
		expect(rows.length, "two version rows on disk").toBe(2);
		const active = rows.filter((r) => String(r.status) === "active");
		const superseded = rows.filter((r) => String(r.status) === "superseded");
		expect(active.length).toBe(1);
		expect(superseded.length).toBe(1);
		expect(String(active[0].content)).toBe("the build is not passing");
		expect(Number(active[0].version)).toBe(2);
		expect(String(superseded[0].id)).toBe(seed!.newId);
	});

	it("a constraint prior is NOT auto-superseded by a conflicting value (b-AC-5/D-7)", async () => {
		const slot = { groupKey: "policy", claimKey: "deploy" };

		// Seed a constraint v1 in the slot (the helper appends it; no prior).
		const seed = await supersedeOnConflict(
			proxy,
			scope,
			{
				incoming: { content: "the deploy is allowed", kind: "constraint" },
				prior: { id: "", content: "the deploy is not allowed", kind: "attribute" },
				slot,
			},
			{
				entityId: "ent-live",
				aspectId: "asp-live",
				newAttribute: { ...base, kind: "constraint", content: "the deploy is allowed", provenance: { memoryId: "mem-c-1", source: "extraction" } },
			},
		);
		expect(seed?.version).toBe(1);

		// Now a conflicting value arrives against the CONSTRAINT prior → exempt (D-7).
		const attempt = await supersedeOnConflict(
			proxy,
			scope,
			{
				incoming: { content: "the deploy is not allowed", kind: "attribute" },
				prior: { id: seed!.newId, content: "the deploy is allowed", kind: "constraint" },
				slot,
			},
			superArgs("the deploy is not allowed", "mem-c-2"),
		);
		expect(attempt, "a constraint is never auto-superseded").toBeNull();

		// Read back: still exactly ONE row, still active — the constraint chain is intact.
		// FIRST, converge on the seeded row THROUGH `readConverged` (read-your-writes: the
		// seeded constraint must be visible — never a single immediate read, the seam's
		// budget absorbs the warm-up flap).
		const slotSql = `SELECT id, version, status, content FROM "${sqlIdent(TBL_ATTRS)}" WHERE claim_key = ${sLiteral(slotClaimKey("asp-live", slot))}`;
		const rows = await scanRows(storage, slotSql, scope, 1);
		expect(rows.length, "the constraint slot still has exactly one row").toBe(1);
		expect(String(rows[0].status)).toBe("active");
		expect(String(rows[0].content)).toBe("the deploy is allowed");

		// THEN, a bounded ABSENCE-PROOF re-read. This is NOT a read-convergence loop (the
		// seeded row already converged above) — it is the OPPOSITE concern: prove the D-7
		// exemption appended NOTHING by giving any wrongly-appended 2nd row time to surface.
		// `readConverged` cannot express "wait for a row that must NOT exist", so this stays
		// a deliberate, bounded confirm re-read: a couple of spaced reads, the row count must
		// never grow past one. (Left intentionally per AC-4: a genuinely-different reason to
		// re-read, not a hand-rolled poll-until-present.)
		for (let confirm = 0; confirm < 3; confirm++) {
			await new Promise((r) => setTimeout(r, 500));
			const recheck = reduceHighestVersionPerId(await storage.query(slotSql, scope));
			expect(recheck.length, "no second row ever appears (the exemption held)").toBe(1);
		}
	});
});

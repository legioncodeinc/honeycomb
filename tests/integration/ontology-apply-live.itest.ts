/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE ontology control-plane APPLY SMOKE — OPT-IN, MUTATES REAL DEEPLAKE.  ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-008c Wave 2: prove a BOUNDED explicit op applies DIRECTLY against the  ║
 * ║  REAL backend — the `applied` ontology_proposals row + the resulting        ║
 * ║  entity_attributes row both land, read back via poll-convergent scans       ║
 * ║  (c-AC-1 / c-AC-6). The supersede live path is covered separately by        ║
 * ║  ontology-supersede-live.itest.ts (c-AC-4).                                 ║
 * ║                                                                            ║
 * ║  GATED + ISOLATED exactly like ontology-supersede-live.itest.ts:           ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = skip.       ║
 * ║    - `.itest.ts` suffix keeps it OUT of `npm run test` / `npm run ci`;     ║
 * ║      only `npm run test:integration` runs it.                              ║
 * ║    - Per-run throwaway tables (`ci_cp_<runid>_*`), DROPped in afterAll.     ║
 * ║      Never touches the real ontology_proposals / entity_attributes tables. ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createStorageClient,
	envCredentialProvider,
	isOk,
	resolveStorageConfig,
	type QueryScope,
	type StorageClient,
	type StorageQuery,
	sLiteral,
	sqlIdent,
} from "../../src/daemon/storage/index.js";
import { submitProposal } from "../../src/daemon/runtime/ontology/control-plane.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const TBL_PROPOSALS = `ci_cp_${RUN_ID}_proposals`;
const TBL_ATTRS = `ci_cp_${RUN_ID}_attrs`;

/**
 * Poll a scan and resolve the CURRENT STATE per id = the HIGHEST-`version` row seen for
 * each id (the append-only reader convention — `supersede.ts`'s `readCurrentStateById`).
 *
 * A claim.add applies as a single version-1 row, but the supersede path is append-only
 * (a marked id has multiple physical rows), so resolving the highest version per id is
 * the correct current-state read across the whole apply surface. We poll because this
 * backend serves a scan from segments of differing freshness — a scan can MISS a
 * durably-written row but never INVENTS one, so polling + keeping the highest version
 * per id converges UP to the durable current state. Rows with no `version` column
 * projected collapse to a single current row per id (version treated as 0).
 */
const SCAN_POLLS = 20;
async function scanRows(store: StorageQuery, sql: string, s: QueryScope): Promise<Record<string, unknown>[]> {
	const byId = new Map<string, Record<string, unknown>>();
	const ver = (row: Record<string, unknown>): number => {
		const n = typeof row.version === "number" ? row.version : Number(row.version);
		return Number.isFinite(n) ? n : 0;
	};
	for (let poll = 0; poll < SCAN_POLLS; poll++) {
		const res = await store.query(sql, s);
		if (isOk(res)) {
			for (const row of res.rows as Record<string, unknown>[]) {
				const id = String(row.id ?? "");
				if (id === "") continue;
				const prev = byId.get(id);
				if (!prev || ver(row) >= ver(prev)) byId.set(id, row); // keep the highest version
			}
		}
	}
	return [...byId.values()];
}

describe.skipIf(!HAS_TOKEN)("live ontology control-plane apply smoke (opt-in, real backend)", () => {
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
		for (const tbl of [TBL_PROPOSALS, TBL_ATTRS]) {
			const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(tbl)}"`, scope);
			if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${tbl}: ${JSON.stringify(res)}`);
		}
	});

	it("a bounded claim.add applies directly: applied proposal row + attribute row land", async () => {
		// Route the canonical tables to throwaway ones by rewriting the identifier in every
		// statement (the supersede-live proxy pattern — isolates the write without touching
		// shared code).
		const proxy: StorageQuery = {
			async query(sql, s, opts) {
				const patched = sql
					.replace(/"ontology_proposals"/g, `"${TBL_PROPOSALS}"`)
					.replace(/\bontology_proposals\b/g, TBL_PROPOSALS)
					.replace(/"entity_attributes"/g, `"${TBL_ATTRS}"`)
					.replace(/\bentity_attributes\b/g, TBL_ATTRS);
				return storage.query(patched, s, opts);
			},
		};

		const outcome = await submitProposal(
			proxy,
			scope,
			{
				operation: "claim.add",
				confidence: 0.92,
				rationale: "live apply smoke",
				riskNote: "",
				payload: {
					aspectId: "asp-live-cp",
					groupKey: "role",
					claimKey: "title",
					kind: "attribute",
					content: "Staff Engineer (live)",
					memoryId: "mem-live-cp",
					importance: 0.5,
				},
				provenance: { source: "itest", evidence: "mem-live-cp;live#1" },
			},
			{ agentId: "agent-live-cp" },
		);

		expect(outcome.route).toBe("direct");
		expect(outcome.status).toBe("applied");
		expect(outcome.proposalId).not.toBe("");

		// The applied proposal row is durable.
		const proposals = await scanRows(
			storage,
			`SELECT id, operation, status, evidence FROM "${sqlIdent(TBL_PROPOSALS)}" WHERE status = ${sLiteral("applied")}`,
			scope,
		);
		expect(proposals.length, "an applied proposal row").toBeGreaterThanOrEqual(1);
		expect(proposals.some((r) => String(r.operation) === "claim.add")).toBe(true);
		expect(proposals.some((r) => String(r.evidence).includes("mem-live-cp"))).toBe(true);

		// The resulting attribute row is durable, active, and carries the memory provenance.
		const attrs = await scanRows(
			storage,
			`SELECT id, content, status, memory_id FROM "${sqlIdent(TBL_ATTRS)}" WHERE memory_id = ${sLiteral("mem-live-cp")}`,
			scope,
		);
		expect(attrs.length, "the applied attribute row").toBeGreaterThanOrEqual(1);
		expect(attrs.some((r) => String(r.status) === "active")).toBe(true);
		expect(attrs.some((r) => String(r.content).includes("Staff Engineer (live)"))).toBe(true);
	});
});

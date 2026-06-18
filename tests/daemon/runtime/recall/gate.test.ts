/**
 * PRD-007e Confidence Gate — e-AC-1..7 (Wave 2, `retrieval-worker-bee`).
 *
 * Verification posture (EXECUTION_LEDGER-prd-007 / recall CONVENTIONS):
 *   - Each test is named after the AC it proves (one-to-one ledger map).
 *   - All storage interactions go through a FAKE transport (SQL-aware responder
 *     or FIFO queue) — no live DeepLake.
 *   - No `.skip` / `.only`; `vitest run` is CI.
 *   - The gate is the ONLY phase that hydrates content; every assertion here
 *     verifies content loads, access-tracking updates, scope re-application,
 *     and injection decisions against the fake transport's recorded requests.
 *
 * e-AC-1 inject-only-above-min     — context injected iff top score ≥ min.
 * e-AC-2 calibrated-not-rank       — score on the hit equals calibratedScore.
 * e-AC-3 empty-injection-valid     — below min → {injected:false, hits:[]} not throw.
 * e-AC-4 hydrate-under-scope+limit — hydration SQL carries the scope clause; limit caps.
 * e-AC-5 access-tracking-primaries — UPDATE issued only for primary IDs.
 * e-AC-6 synthetic-cards           — supplementary hits carry synthetic:true.
 * e-AC-7 per-agent-override        — per-agent minInjectionScore overrides config default.
 */

import { describe, expect, it } from "vitest";

import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import type { StorageRow } from "../../../../src/daemon/storage/result.js";
import { RecallConfigSchema } from "../../../../src/daemon/runtime/recall/config.js";
import type { RecallConfig } from "../../../../src/daemon/runtime/recall/config.js";
import { buildScopeClause } from "../../../../src/daemon/runtime/recall/scope-clause.js";
import { gatePhase } from "../../../../src/daemon/runtime/recall/gate.js";
import type { ShapedPool } from "../../../../src/daemon/runtime/recall/shaping.js";
import type { RecallQuery } from "../../../../src/daemon/runtime/recall/contracts.js";
import type { RecallPhaseDeps } from "../../../../src/daemon/runtime/recall/engine.js";

// ── Shared fixtures ─────────────────────────────────────────────────────────

const ORG_SCOPE = { org: "fake-org", workspace: "fake-ws" } as const;

function recallConfig(overrides: Record<string, unknown> = {}): RecallConfig {
	return RecallConfigSchema.parse(overrides);
}

/**
 * Build a minimal `RecallQuery`. The `minInjectionScore` field is the per-agent
 * override seam (e-AC-7): set it on the extended query to drive that AC.
 */
function recallQuery(overrides: Partial<RecallQuery & { minInjectionScore?: number }> = {}): RecallQuery & { minInjectionScore?: number } {
	return {
		query: "what is the daemon socket path",
		scope: {
			org: "fake-org",
			workspace: "fake-ws",
			agentId: "agent-007",
			readPolicy: "isolated",
			policyGroup: "",
		},
		limit: 5,
		...overrides,
	};
}

/**
 * Build a minimal `ShapedPool` from a list of { id, calibratedScore } items.
 * The scope clause is compiled from the query scope using the real builder so
 * the hydration SQL in the gate carries an actual clause, not a placeholder.
 */
function shapedPool(
	candidates: readonly { readonly id: string; readonly calibratedScore: number }[],
	degraded = false,
	agentId = "agent-007",
	readPolicy: string = "isolated",
): ShapedPool {
	const clause = buildScopeClause({ agentId, readPolicy, org: "fake-org", workspace: "fake-ws" });
	return {
		candidates: candidates.map((c) => ({
			id: c.id,
			calibratedScore: c.calibratedScore,
			scores: {},
			provenance: [],
		})),
		degraded,
		context: {
			clause,
			scope: {
				org: "fake-org",
				workspace: "fake-ws",
				agentId,
				readPolicy: readPolicy as "isolated" | "shared" | "group",
				policyGroup: "",
			},
		},
	};
}

/**
 * Build a fake storage that responds to the gate's SELECT (hydration) and UPDATE
 * (access tracking). Uses a SQL-aware responder so each call returns the right
 * rows regardless of order — the hydration SELECT returns `hydrateRows`, and the
 * UPDATE returns `[]` (DeepLake returns no rows for DML, treated as ok).
 */
function makeStorage(hydrateRows: StorageRow[]): {
	storage: ReturnType<typeof createStorageClient>;
	fake: FakeDeepLakeTransport;
} {
	const responder = (req: TransportRequest): StorageRow[] => {
		const sql = req.sql.toUpperCase();
		if (sql.startsWith("SELECT")) return hydrateRows;
		if (sql.startsWith("UPDATE")) return []; // access tracking — no row return.
		return [];
	};
	const fake = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	return { storage, fake };
}

/**
 * Build the `RecallPhaseDeps` the gate receives (the minimum set: storage, scope,
 * config). No embed or logger needed for the gate phase.
 */
function phaseDeps(storage: ReturnType<typeof createStorageClient>, config: RecallConfig): RecallPhaseDeps {
	return { storage, scope: ORG_SCOPE, config };
}

// ── e-AC-1: inject-only-above-min ───────────────────────────────────────────

describe("e-AC-1: inject-only-above-min", () => {
	it("injects context when top calibrated score equals the minimum exactly", async () => {
		// Score exactly at the threshold (≥ 0.6 should inject).
		const pool = shapedPool([{ id: "m1", calibratedScore: 0.6 }, { id: "m2", calibratedScore: 0.5 }]);
		const { storage } = makeStorage([{ id: "m1", content: "socket path is /tmp/honeycomb.sock" }]);
		const config = recallConfig({ minInjectionScore: 0.6 });
		const result = await gatePhase(pool, recallQuery(), phaseDeps(storage, config));
		expect(result.injected).toBe(true);
		// At least the primary hit is present (score at boundary → inject).
		expect(result.hits.some((h) => !h.synthetic)).toBe(true);
	});

	it("does NOT inject when the top calibrated score is just below the minimum", async () => {
		const pool = shapedPool([{ id: "m1", calibratedScore: 0.59 }]);
		const { storage } = makeStorage([]);
		const config = recallConfig({ minInjectionScore: 0.6 });
		const result = await gatePhase(pool, recallQuery(), phaseDeps(storage, config));
		expect(result.injected).toBe(false);
		expect(result.hits).toEqual([]);
	});

	it("does NOT inject when the pool is empty (no candidates)", async () => {
		const pool = shapedPool([]);
		const { storage } = makeStorage([]);
		const config = recallConfig({ minInjectionScore: 0.6 });
		const result = await gatePhase(pool, recallQuery(), phaseDeps(storage, config));
		expect(result.injected).toBe(false);
		expect(result.hits).toEqual([]);
	});
});

// ── e-AC-2: calibrated-not-rank ─────────────────────────────────────────────

describe("e-AC-2: calibrated-not-rank", () => {
	it("the score on each hit equals the calibratedScore from shaping, not the rank", async () => {
		// Non-uniform scores: the top is 0.91, the second is 0.72.
		const pool = shapedPool([
			{ id: "m1", calibratedScore: 0.91 },
			{ id: "m2", calibratedScore: 0.72 },
		]);
		const { storage } = makeStorage([
			{ id: "m1", content: "first result" },
			{ id: "m2", content: "second result" },
		]);
		const config = recallConfig({ minInjectionScore: 0.6 });
		// Request both as primaries (limit = 2).
		const result = await gatePhase(pool, recallQuery({ limit: 2 }), phaseDeps(storage, config));
		expect(result.injected).toBe(true);
		const primary = result.hits.filter((h) => !h.synthetic);
		// The scores MUST match the calibratedScore values from shaping exactly.
		const m1 = primary.find((h) => h.id === "m1");
		const m2 = primary.find((h) => h.id === "m2");
		expect(m1?.score).toBe(0.91);
		expect(m2?.score).toBe(0.72);
		// They are NOT rank-derived values (0, 1, etc.) or 1-based positions.
		expect(m1?.score).not.toBe(1);
		expect(m2?.score).not.toBe(0);
	});
});

// ── e-AC-3: empty-injection-valid ───────────────────────────────────────────

describe("e-AC-3: empty-injection-valid", () => {
	it("returns {injected:false, hits:[]} as a valid answer when nothing clears min — no throw", async () => {
		const pool = shapedPool([{ id: "m1", calibratedScore: 0.3 }]);
		const { storage } = makeStorage([]); // Should never be called (no inject → no hydration).
		const config = recallConfig({ minInjectionScore: 0.6 });
		// Must not throw.
		const result = await gatePhase(pool, recallQuery(), phaseDeps(storage, config));
		expect(result.injected).toBe(false);
		expect(result.hits).toEqual([]);
		expect(result.degraded).toBe(false);
	});

	it("propagates the degraded flag on an empty injection (BM25 fallback visible end-to-end)", async () => {
		const pool: ShapedPool = { ...shapedPool([{ id: "m1", calibratedScore: 0.1 }]), degraded: true };
		const { storage } = makeStorage([]);
		const config = recallConfig({ minInjectionScore: 0.6 });
		const result = await gatePhase(pool, recallQuery(), phaseDeps(storage, config));
		expect(result.injected).toBe(false);
		expect(result.degraded).toBe(true); // carried end-to-end.
	});
});

// ── e-AC-4: hydrate-under-scope + limit ─────────────────────────────────────

describe("e-AC-4: hydrate-under-scope + limit", () => {
	it("the hydration SELECT carries the scope clause AND caps results at query.limit", async () => {
		// Pool has 4 candidates above the threshold, but limit = 2 → only 2 hydrated.
		const pool = shapedPool([
			{ id: "m1", calibratedScore: 0.95 },
			{ id: "m2", calibratedScore: 0.85 },
			{ id: "m3", calibratedScore: 0.75 },
			{ id: "m4", calibratedScore: 0.65 },
		]);
		const { storage, fake } = makeStorage([
			{ id: "m1", content: "content one" },
			{ id: "m2", content: "content two" },
		]);
		const config = recallConfig({ minInjectionScore: 0.6 });
		const result = await gatePhase(pool, recallQuery({ limit: 2 }), phaseDeps(storage, config));
		expect(result.injected).toBe(true);
		// Only 2 primary hits hydrated.
		const primary = result.hits.filter((h) => !h.synthetic);
		expect(primary).toHaveLength(2);
		expect(primary.map((h) => h.id)).toEqual(["m1", "m2"]);
		// The hydration SELECT must carry the scope clause fragment.
		const selectReq = fake.requests.find((r) => r.sql.toUpperCase().includes("SELECT"));
		expect(selectReq).toBeDefined();
		// The clause must constrain to agent-007's isolated policy.
		expect(selectReq?.sql).toContain("agent_id");
		expect(selectReq?.sql).toContain("is_deleted");
		// The IN-list must include only the 2 primary IDs, not m3/m4.
		expect(selectReq?.sql).toContain("'m1'");
		expect(selectReq?.sql).toContain("'m2'");
		expect(selectReq?.sql).not.toContain("'m3'");
		expect(selectReq?.sql).not.toContain("'m4'");
		// The org scope must flow to the storage query (outer ring enforcement).
		expect(selectReq?.org).toBe("fake-org");
	});

	it("uses the scope clause from pool.context.clause, not a fresh one", async () => {
		// Build a pool with a SHARED policy scope clause — the gate must re-use it,
		// not re-derive a fresh isolated clause.
		const pool = shapedPool([{ id: "mx", calibratedScore: 0.9 }], false, "agent-shared", "shared");
		const { storage, fake } = makeStorage([{ id: "mx", content: "shared content" }]);
		const config = recallConfig({ minInjectionScore: 0.6 });
		const result = await gatePhase(pool, recallQuery({ limit: 1 }), phaseDeps(storage, config));
		expect(result.injected).toBe(true);
		const selectReq = fake.requests.find((r) => r.sql.toUpperCase().includes("SELECT"));
		// The shared policy clause includes `visibility = 'global'`.
		expect(selectReq?.sql).toContain("visibility");
		expect(selectReq?.sql).toContain("global");
	});
});

// ── e-AC-5: access-tracking-primaries-only ──────────────────────────────────

describe("e-AC-5: access-tracking-primaries-only", () => {
	it("UPDATE is issued only for primary IDs, not supplementary/dropped candidates", async () => {
		// Pool: 3 candidates, limit = 1 → only m1 is primary; m2, m3 are supplementary.
		const pool = shapedPool([
			{ id: "m1", calibratedScore: 0.95 },
			{ id: "m2", calibratedScore: 0.80 },
			{ id: "m3", calibratedScore: 0.70 },
		]);
		const { storage, fake } = makeStorage([{ id: "m1", content: "primary content" }]);
		const config = recallConfig({ minInjectionScore: 0.6 });
		await gatePhase(pool, recallQuery({ limit: 1 }), phaseDeps(storage, config));
		// Find the UPDATE statement.
		const updateReq = fake.requests.find((r) => r.sql.toUpperCase().startsWith("UPDATE"));
		expect(updateReq).toBeDefined();
		// UPDATE must include m1.
		expect(updateReq?.sql).toContain("'m1'");
		// UPDATE must NOT include m2 or m3 (supplementary, not tracked).
		expect(updateReq?.sql).not.toContain("'m2'");
		expect(updateReq?.sql).not.toContain("'m3'");
	});

	it("no UPDATE is issued when injection is skipped (nothing clears min)", async () => {
		const pool = shapedPool([{ id: "m1", calibratedScore: 0.4 }]);
		const { storage, fake } = makeStorage([]);
		const config = recallConfig({ minInjectionScore: 0.6 });
		await gatePhase(pool, recallQuery(), phaseDeps(storage, config));
		const updateReq = fake.requests.find((r) => r.sql.toUpperCase().startsWith("UPDATE"));
		// No UPDATE when there is no injection (nothing to track).
		expect(updateReq).toBeUndefined();
	});
});

// ── e-AC-6: synthetic-cards ─────────────────────────────────────────────────

describe("e-AC-6: synthetic-cards", () => {
	it("supplementary hits beyond the limit carry synthetic:true; primary hits carry synthetic:false", async () => {
		// Pool: 3 candidates all above min, limit = 1 → m1 primary, m2/m3 supplementary.
		const pool = shapedPool([
			{ id: "m1", calibratedScore: 0.95 },
			{ id: "m2", calibratedScore: 0.80 },
			{ id: "m3", calibratedScore: 0.70 },
		]);
		const { storage } = makeStorage([{ id: "m1", content: "injected content" }]);
		const config = recallConfig({ minInjectionScore: 0.6 });
		const result = await gatePhase(pool, recallQuery({ limit: 1 }), phaseDeps(storage, config));
		expect(result.injected).toBe(true);
		const primary = result.hits.filter((h) => !h.synthetic);
		const synthetic = result.hits.filter((h) => h.synthetic);
		// Exactly 1 primary (m1).
		expect(primary).toHaveLength(1);
		expect(primary[0]?.id).toBe("m1");
		expect(primary[0]?.synthetic).toBe(false);
		// 2 supplementary (m2, m3) — each marked synthetic.
		expect(synthetic).toHaveLength(2);
		expect(synthetic.every((h) => h.synthetic)).toBe(true);
		expect(synthetic.map((h) => h.id)).toContain("m2");
		expect(synthetic.map((h) => h.id)).toContain("m3");
		// Supplementary cards carry their calibrated scores (not zero).
		const m2 = synthetic.find((h) => h.id === "m2");
		expect(m2?.score).toBe(0.80);
	});

	it("when all candidates are primary (limit ≥ pool size), no synthetic hits appear", async () => {
		const pool = shapedPool([
			{ id: "a", calibratedScore: 0.9 },
			{ id: "b", calibratedScore: 0.8 },
		]);
		const { storage } = makeStorage([
			{ id: "a", content: "a content" },
			{ id: "b", content: "b content" },
		]);
		const config = recallConfig({ minInjectionScore: 0.6 });
		const result = await gatePhase(pool, recallQuery({ limit: 10 }), phaseDeps(storage, config));
		expect(result.injected).toBe(true);
		expect(result.hits.every((h) => !h.synthetic)).toBe(true);
	});
});

// ── e-AC-7: per-agent-override ──────────────────────────────────────────────

describe("e-AC-7: per-agent-override", () => {
	it("a lower per-agent threshold causes injection where the config default would not", async () => {
		// Score 0.5 — below the default 0.6 but above the per-agent override of 0.4.
		const pool = shapedPool([{ id: "m1", calibratedScore: 0.5 }]);
		const { storage } = makeStorage([{ id: "m1", content: "low confidence content" }]);
		const config = recallConfig({ minInjectionScore: 0.6 }); // default rejects 0.5.
		const query = recallQuery({ minInjectionScore: 0.4 }); // per-agent lowers to 0.4.
		const result = await gatePhase(pool, query, phaseDeps(storage, config));
		// With the per-agent override of 0.4, 0.5 should inject.
		expect(result.injected).toBe(true);
		expect(result.hits.some((h) => !h.synthetic && h.id === "m1")).toBe(true);
	});

	it("a higher per-agent threshold suppresses injection where the config default would inject", async () => {
		// Score 0.65 — above the default 0.6 but below the per-agent override of 0.8.
		const pool = shapedPool([{ id: "m1", calibratedScore: 0.65 }]);
		const { storage } = makeStorage([]);
		const config = recallConfig({ minInjectionScore: 0.6 }); // default would inject.
		const query = recallQuery({ minInjectionScore: 0.8 }); // per-agent raises to 0.8.
		const result = await gatePhase(pool, query, phaseDeps(storage, config));
		// With the per-agent override of 0.8, 0.65 should NOT inject.
		expect(result.injected).toBe(false);
		expect(result.hits).toEqual([]);
	});

	it("a per-agent override of exactly the top score causes injection (boundary inclusive)", async () => {
		const pool = shapedPool([{ id: "m1", calibratedScore: 0.75 }]);
		const { storage } = makeStorage([{ id: "m1", content: "boundary content" }]);
		const config = recallConfig({ minInjectionScore: 0.6 });
		const query = recallQuery({ minInjectionScore: 0.75 }); // exactly equal.
		const result = await gatePhase(pool, query, phaseDeps(storage, config));
		expect(result.injected).toBe(true);
	});

	it("when no per-agent override is present, the config minInjectionScore is applied", async () => {
		// Score 0.62 — above the config default of 0.6; no override on query.
		const pool = shapedPool([{ id: "m1", calibratedScore: 0.62 }]);
		const { storage } = makeStorage([{ id: "m1", content: "default min content" }]);
		const config = recallConfig({ minInjectionScore: 0.6 });
		const result = await gatePhase(pool, recallQuery(), phaseDeps(storage, config));
		expect(result.injected).toBe(true);
	});
});

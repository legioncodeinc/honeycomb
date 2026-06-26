/**
 * PRD-060d — the pollination cost composer (`roi-pollination.ts`).
 *
 * pollination = haikuSkillifyCents + deeplakeSessionCents, itemized, integer cents, with the
 * total carrying the WORST contributing status. Every seam is a plain snapshot — the composer
 * is PURE over (a usage snapshot + a 060c infra snapshot), so these tests pass canned
 * snapshots and assert the arithmetic, the itemization, the status propagation, and the
 * integer-cents discipline. d-AC-3 (no second billing read) is proven against the REAL 060c
 * read-model with an injected fetch whose call count is observed.
 *
 * d-AC-2 Haiku tokens priced via 060b's rate table, integer cents, vs fixed inputs.
 * d-AC-3 DeepLake session cost composed from 060c WITHOUT a second billing read.
 * d-AC-4 pollination = haiku + deeplake, itemized (both contributors + the session_type split).
 * d-AC-5 missing Haiku meter → `absent`; unreachable billing → `unreachable`; total = WORST status.
 * d-AC-6 every value is integer cents — no float-cents toward the read-model.
 */

import { describe, expect, it } from "vitest";

import {
	type BillingFetch,
	type BillingFetchResponse,
	type InfraCostReadModel,
	type SessionTypeLine,
	createInfraCostReadModel,
} from "../../../../src/daemon/runtime/dashboard/roi-billing.js";
import { resolveRate } from "../../../../src/daemon/runtime/dashboard/roi-rates.js";
import {
	SKILLIFY_HAIKU_MODEL,
	SKILLIFY_PROVIDER,
	composeDeeplakeContribution,
	composeHaikuContribution,
	composePollinationCost,
	priceHaikuTokens,
	worstPollinationStatus,
} from "../../../../src/daemon/runtime/dashboard/roi-pollination.js";
import type { SkillifyUsageSnapshot } from "../../../../src/daemon/runtime/dashboard/roi-skillify-meter.js";
import { snapshotSource } from "../../../../src/daemon/runtime/dashboard/roi-skillify-meter.js";

/** Build a skillify usage snapshot. */
function usage(overrides: Partial<SkillifyUsageSnapshot> = {}): SkillifyUsageSnapshot {
	return {
		recorded: 1,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		model: SKILLIFY_HAIKU_MODEL,
		...overrides,
	};
}

/** Build the three-line session_type breakdown (query/embedding/ingestion). */
function sessionLines(query = 1_000, embedding = 3_000, ingestion = 1_000): SessionTypeLine[] {
	return [
		{ session_type: "query", gpu_hours: 10, price_cents_per_gpu_hour: 100, cost_cents: query },
		{ session_type: "embedding", gpu_hours: 20, price_cents_per_gpu_hour: 150, cost_cents: embedding },
		{ session_type: "ingestion", gpu_hours: 5, price_cents_per_gpu_hour: 200, cost_cents: ingestion },
	];
}

/** Build an `ok` infra snapshot with the given session lines. */
function okInfra(lines: SessionTypeLine[] = sessionLines()): InfraCostReadModel {
	return { status: "ok", missing: [], sessionTypes: lines, fetchedAt: 1_000 };
}

// ════════════════════════════════════════════════════════════════════════════
// d-AC-2 — Haiku tokens priced via 060b's rate table, integer cents.
// ════════════════════════════════════════════════════════════════════════════

describe("d-AC-2: Haiku skillify token cost priced via the 060b rate table", () => {
	it("prices the four token buckets at their own rate columns, in integer cents", () => {
		const snap = usage({
			inputTokens: 2_000_000, // 2 Mtok input
			outputTokens: 1_000_000, // 1 Mtok output
			cacheReadInputTokens: 5_000_000, // 5 Mtok cache-read
			cacheCreationInputTokens: 4_000_000, // 4 Mtok cache-write
		});

		// Expected against whatever row the table resolves for the skillify model (robust to a
		// future explicit Haiku row landing in 060b's table — it recomputes from resolveRate).
		const rate = resolveRate(SKILLIFY_PROVIDER, SKILLIFY_HAIKU_MODEL);
		const expected =
			Math.round((2_000_000 * rate.input_cents_per_mtok) / 1_000_000) +
			Math.round((1_000_000 * rate.output_cents_per_mtok) / 1_000_000) +
			Math.round((5_000_000 * rate.cache_read_cents_per_mtok) / 1_000_000) +
			Math.round((4_000_000 * rate.cache_write_cents_per_mtok) / 1_000_000);

		expect(priceHaikuTokens(snap)).toBe(expected);
		expect(Number.isInteger(priceHaikuTokens(snap))).toBe(true);
	});

	it("prices the exact Haiku model id the skillify path uses (anthropic / claude-haiku-4-5)", () => {
		expect(SKILLIFY_PROVIDER).toBe("anthropic");
		expect(SKILLIFY_HAIKU_MODEL).toBe("claude-haiku-4-5");
		// resolveRate must return a usable row for that id (never crash / zero-price).
		const rate = resolveRate(SKILLIFY_PROVIDER, SKILLIFY_HAIKU_MODEL);
		expect(rate.input_cents_per_mtok).toBeGreaterThan(0);
		expect(rate.output_cents_per_mtok).toBeGreaterThan(0);
	});

	it("the Haiku contribution is `measured` with the priced figure when ≥1 call recorded", () => {
		const haiku = composeHaikuContribution(usage({ inputTokens: 1_000_000 }));
		expect(haiku.status).toBe("measured");
		expect(haiku.cents).toBe(priceHaikuTokens(usage({ inputTokens: 1_000_000 })));
		expect(haiku.recorded).toBe(1);
		expect(haiku.model).toBe(SKILLIFY_HAIKU_MODEL);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// d-AC-3 — DeepLake session cost composed from 060c, NO second billing read.
// ════════════════════════════════════════════════════════════════════════════

describe("d-AC-3: DeepLake session cost composed from 060c without a second billing read", () => {
	it("sums the session_type breakdown into integer cents and itemizes the per-type split", () => {
		const deeplake = composeDeeplakeContribution(okInfra(sessionLines(1_000, 3_000, 1_000)));
		expect(deeplake.cents).toBe(5_000); // 1000 + 3000 + 1000
		expect(deeplake.perTypeCents).toEqual({ query: 1_000, embedding: 3_000, ingestion: 1_000 });
		expect(deeplake.bySessionType).toHaveLength(3);
		expect(deeplake.status).toBe("ok");
	});

	it("originates NO outbound billing call — it consumes the already-read snapshot", async () => {
		// Drive the REAL 060c read-model with an injected fetch; read() ONCE to get the snapshot,
		// then compose pollination from that snapshot. The composer must add ZERO fetches.
		let fetchCount = 0;
		const fetch: BillingFetch = (url): Promise<BillingFetchResponse> => {
			fetchCount += 1;
			const body =
				url.includes("/billing/usage/compute")
					? {
							total_cost_cents: 5_000,
							total_gpu_hours: 35,
							sessions: [
								{ session_type: "query", gpu_hours: 10, gpu_units: 1, price_cents_per_gpu_hour: 100, total_cost_cents: 1_000 },
								{ session_type: "embedding", gpu_hours: 20, gpu_units: 1, price_cents_per_gpu_hour: 150, total_cost_cents: 3_000 },
								{ session_type: "ingestion", gpu_hours: 5, gpu_units: 1, price_cents_per_gpu_hour: 200, total_cost_cents: 1_000 },
							],
						}
					: { balance_cents: 0, period_start: "", period_end: "", total_cost_cents: 0, storage_cost_cents: 0, transfer_cost_cents: 0, projected_end_of_period_cents: 0, compute: { total_cost_cents: 0, total_pod_hours: 0, by_tier: [] }, comparison: { compute_cost_previous: 0, total_cost_previous: 0, delta_pct: 0 } };
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
		};
		const readModel = createInfraCostReadModel({
			fetch,
			sleep: () => Promise.resolve(),
			creds: () => ({ token: "tok", orgId: "org", apiUrl: "https://api.deeplake.ai", savedAt: "2026-06-26T00:00:00Z" }),
		});

		const infra = await readModel.read();
		const fetchesAfterRead = fetchCount;

		// Compose pollination from the snapshot — must NOT trigger any further fetch.
		const cost = composePollinationCost(snapshotSource(usage({ recorded: 0 })), infra);
		expect(fetchCount).toBe(fetchesAfterRead); // ZERO extra egress from the composer (d-AC-3)
		expect(cost.deeplake.cents).toBe(5_000);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// d-AC-4 — pollination = haiku + deeplake, itemized.
// ════════════════════════════════════════════════════════════════════════════

describe("d-AC-4: pollination = haikuSkillifyCents + deeplakeSessionCents, itemized", () => {
	it("sums the two halves and exposes BOTH contributors + the session_type split", () => {
		const snap = usage({ inputTokens: 1_000_000, outputTokens: 500_000 });
		const cost = composePollinationCost(snapshotSource(snap), okInfra(sessionLines(1_000, 3_000, 1_000)));

		const expectedHaiku = priceHaikuTokens(snap);
		expect(cost.haiku.cents).toBe(expectedHaiku);
		expect(cost.deeplake.cents).toBe(5_000);
		// The total is the sum of the two contributors (d-AC-4).
		expect(cost.pollinationCents).toBe(expectedHaiku + 5_000);
		// Both contributors are individually readable.
		expect(cost.haiku.status).toBe("measured");
		expect(cost.deeplake.status).toBe("ok");
		// The session_type split is individually readable.
		expect(cost.deeplake.perTypeCents).toEqual({ query: 1_000, embedding: 3_000, ingestion: 1_000 });
	});
});

// ════════════════════════════════════════════════════════════════════════════
// d-AC-5 — fail-soft + WORST-status propagation.
// ════════════════════════════════════════════════════════════════════════════

describe("d-AC-5: fail-soft contributions + worst-status on the total", () => {
	it("a missing Haiku meter yields an `absent` contribution (NOT 0)", () => {
		const haiku = composeHaikuContribution(usage({ recorded: 0 }));
		expect(haiku.status).toBe("absent");
		// The cents field is 0 but the STATUS — not the number — is the honest signal.
		expect(haiku.cents).toBe(0);
	});

	it("an unreachable billing read yields an `unreachable` DeepLake contribution", () => {
		const infra: InfraCostReadModel = { status: "unreachable", missing: ["/billing/summary", "/billing/usage/compute"], sessionTypes: [], fetchedAt: 1 };
		const deeplake = composeDeeplakeContribution(infra);
		expect(deeplake.status).toBe("unreachable");
		expect(deeplake.cents).toBe(0);
	});

	it("the total carries the WORST contributing status (absent Haiku + ok billing → absent)", () => {
		const cost = composePollinationCost(snapshotSource(usage({ recorded: 0 })), okInfra());
		expect(cost.haiku.status).toBe("absent");
		expect(cost.deeplake.status).toBe("ok");
		expect(cost.status).toBe("absent"); // worst of {absent, ok}
	});

	it("the total carries the WORST contributing status (measured Haiku + unreachable billing → unreachable)", () => {
		const infra: InfraCostReadModel = { status: "unreachable", missing: ["/billing/summary", "/billing/usage/compute"], sessionTypes: [], fetchedAt: 1 };
		const cost = composePollinationCost(snapshotSource(usage({ recorded: 1, inputTokens: 1_000_000 })), infra);
		expect(cost.haiku.status).toBe("measured");
		expect(cost.deeplake.status).toBe("unreachable");
		expect(cost.status).toBe("unreachable"); // never a confidently-low number atop a degraded half
	});

	it("only a measured Haiku + ok billing yields a fully-confident `ok` total", () => {
		const cost = composePollinationCost(snapshotSource(usage({ recorded: 1, inputTokens: 1_000_000 })), okInfra());
		expect(cost.status).toBe("ok");
	});

	it("worstPollinationStatus ranks unauthenticated worst, ok best", () => {
		expect(worstPollinationStatus("measured", "ok")).toBe("ok");
		expect(worstPollinationStatus("absent", "ok")).toBe("absent");
		expect(worstPollinationStatus("measured", "partial")).toBe("partial");
		expect(worstPollinationStatus("measured", "unreachable")).toBe("unreachable");
		expect(worstPollinationStatus("measured", "unauthenticated")).toBe("unauthenticated");
		expect(worstPollinationStatus("absent", "unreachable")).toBe("unreachable");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// d-AC-6 — integer cents end to end.
// ════════════════════════════════════════════════════════════════════════════

describe("d-AC-6: every pollination value is integer cents (no float-cents)", () => {
	it("no float-cents crosses the boundary toward the read-model", () => {
		// Token counts that would produce a fractional cent BEFORE rounding (e.g. 333,333 input
		// tokens at 300 cents/Mtok = 99.9999 cents → must round to an integer).
		const snap = usage({ inputTokens: 333_333, outputTokens: 7, cacheReadInputTokens: 1, cacheCreationInputTokens: 9 });
		const cost = composePollinationCost(snapshotSource(snap), okInfra(sessionLines(1_001, 3_003, 999)));

		const allCents = [
			cost.pollinationCents,
			cost.haiku.cents,
			cost.deeplake.cents,
			cost.deeplake.perTypeCents.query,
			cost.deeplake.perTypeCents.embedding,
			cost.deeplake.perTypeCents.ingestion,
		];
		for (const c of allCents) {
			expect(Number.isInteger(c)).toBe(true);
		}
	});
});


// ════════════════════════════════════════════════════════════════════════════
// Finding (meter-per-model) — per-model token buckets priced at each model's own rate.
// ════════════════════════════════════════════════════════════════════════════

describe("Finding (meter-per-model): each per-model bucket is priced at its OWN model's rate", () => {
	it("prices a multi-model snapshot by per-model bucket, not all tokens at the last-seen model", () => {
		// 1 Mtok input for Haiku + 1 Mtok input for Sonnet, recorded across two models.
		const snap: SkillifyUsageSnapshot = {
			recorded: 2,
			inputTokens: 2_000_000,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			model: "claude-sonnet-4-6", // last-seen model (the prior bug would price ALL tokens here)
			perModel: [
				{ model: "claude-haiku-4-5", recorded: 1, inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
				{ model: "claude-sonnet-4-6", recorded: 1, inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
			],
		};

		const haikuRate = resolveRate("anthropic", "claude-haiku-4-5");
		const sonnetRate = resolveRate("anthropic", "claude-sonnet-4-6");
		// Correct: 1 Mtok at Haiku input + 1 Mtok at Sonnet input.
		const expectedPerModel = haikuRate.input_cents_per_mtok + sonnetRate.input_cents_per_mtok;
		// The BUGGY single-model figure (all 2 Mtok at the last-seen Sonnet rate) is different + higher.
		const buggySingleModel = 2 * sonnetRate.input_cents_per_mtok;

		expect(priceHaikuTokens(snap)).toBe(expectedPerModel);
		expect(priceHaikuTokens(snap)).not.toBe(buggySingleModel);
		expect(priceHaikuTokens(snap)).toBeLessThan(buggySingleModel); // Haiku is cheaper than Sonnet.

		// The composed Haiku contribution is `measured` and reflects the per-model figure; the label is
		// "mixed" (more than one model) so the page does not imply a single model priced it.
		const haiku = composeHaikuContribution(snap);
		expect(haiku.status).toBe("measured");
		expect(haiku.cents).toBe(expectedPerModel);
		expect(haiku.model).toBe("mixed");
	});

	it("a single-model snapshot WITHOUT perModel still prices at its single model (back-compat)", () => {
		const snap: SkillifyUsageSnapshot = {
			recorded: 1,
			inputTokens: 1_000_000,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			model: "claude-haiku-4-5",
		};
		const rate = resolveRate("anthropic", "claude-haiku-4-5");
		expect(priceHaikuTokens(snap)).toBe(rate.input_cents_per_mtok);
		expect(composeHaikuContribution(snap).model).toBe("claude-haiku-4-5");
	});
});

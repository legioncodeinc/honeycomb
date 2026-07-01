/**
 * PRD-060e daemon-side composite ROI read-model — the DATA-HALF acceptance criteria
 * (e-AC-2 / e-AC-6 / e-AC-11 / e-AC-12 / e-AC-13 / e-AC-14 / e-AC-15).
 *
 * Verification posture (no live DeepLake / no network): the pure `assembleRoiView` is driven with
 * fixture inputs (canned turns + a fake `InfraCostReadModel` snapshot + a static usage source + a
 * fixture ledger read) so each per-section status + the net-not-fabricated rule + the rollups + the
 * allocated/mixed-basis flags are asserted deterministically. `fetchRoiView` is driven over the
 * PRD-002 fake transport to prove the read_policy scoping (e-AC-12) end-to-end. The wire integer-cents
 * guard (e-AC-11) is asserted against `RoiViewSchema` directly (a float-cents value never survives).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import type { QueryScope } from "../../../../src/daemon/storage/client.js";
import { assembleRoiView, computeRollups, fetchRoiView } from "../../../../src/daemon/runtime/dashboard/api.js";
import type { CapturedTurn } from "../../../../src/daemon/runtime/dashboard/roi-savings.js";
import type { InfraCostReadModel } from "../../../../src/daemon/runtime/dashboard/roi-billing.js";
import { emptyUsageSource, snapshotSource } from "../../../../src/daemon/runtime/dashboard/roi-skillify-meter.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

/** Wire-level integer-cents guard (mirrors the retired dashboard web wire schema). */
const roiCentsField = z.number().int().catch(0);
const RoiViewSchema = z.object({
	savings: z.object({
		status: z.string().catch("absent"),
		measuredCents: roiCentsField,
		modeledCents: roiCentsField,
		assumption: z.object({ kind: z.string(), assumptionText: z.string(), signedOff: z.boolean() }).catch({ kind: "", assumptionText: "", signedOff: false }),
		blendedCentsPerMtok: z.number().int().nullable().catch(null),
	}),
	infra: z.object({ status: z.string().catch("unreachable"), cents: roiCentsField, costBasis: z.string().catch("none") }),
	pollination: z.object({
		status: z.string().catch("unreachable"),
		cents: roiCentsField,
		lines: z.array(z.object({ label: z.string().catch(""), cents: roiCentsField })).catch([]),
	}),
	net: z.object({
		status: z.string().catch("absent"),
		computed: z.boolean().catch(false),
		netCents: roiCentsField,
		modeled: z.boolean().catch(true),
		costBasis: z.string().catch("none"),
	}),
	rollups: z.array(z.unknown()).catch([]),
	perUserAvailable: z.boolean().catch(false),
	scopedAcrossDevices: z.boolean().catch(false),
	ratesAsOf: z.string().catch(""),
});

const SCOPE: QueryScope = { org: "o1", workspace: "ws1" };

function client(transport: FakeDeepLakeTransport) {
	return createStorageClient({ transport, provider: stubProvider(fakeCredentialRecord()) });
}

/** A captured turn carrying measured token data (a real, billed fact for the savings math). */
function turn(overrides: Partial<CapturedTurn> = {}): CapturedTurn {
	return {
		input_tokens: 1000,
		output_tokens: 500,
		cache_read_input_tokens: 2000,
		cache_creation_input_tokens: 0,
		sourceTool: "claude-code",
		...overrides,
	};
}

/** A turn whose token columns are ALL absent (SQL NULL) — "no usage data", never a measured zero. */
function absentTurn(): CapturedTurn {
	return {
		input_tokens: null,
		output_tokens: null,
		cache_read_input_tokens: null,
		cache_creation_input_tokens: null,
	};
}

/** A fully-read infra snapshot (060c `ok`), with a measured total. */
function okInfra(totalCents = 1234): InfraCostReadModel {
	return {
		status: "ok",
		missing: [],
		summary: {
			balance_cents: 0,
			period_start: "2026-06-01",
			period_end: "2026-06-30",
			total_cost_cents: totalCents,
			storage_cost_cents: 0,
			transfer_cost_cents: 0,
			projected_end_of_period_cents: totalCents,
			compute: { total_cost_cents: totalCents, total_pod_hours: 0, by_tier: [] },
			comparison: { compute_cost_previous: 0, total_cost_previous: 0, delta_pct: 0 },
		},
		sessionTypes: [
			{ session_type: "query", gpu_hours: 1, price_cents_per_gpu_hour: 100, cost_cents: 100 },
			{ session_type: "embedding", gpu_hours: 2, price_cents_per_gpu_hour: 50, cost_cents: 100 },
		],
		fetchedAt: 1,
	};
}

/** An unreachable infra snapshot (060c `unreachable`) — couldn't read billing. */
function unreachableInfra(): InfraCostReadModel {
	return { status: "unreachable", missing: ["/billing/summary", "/billing/usage/compute"], sessionTypes: [], fetchedAt: 1 };
}

/** A PARTIAL infra snapshot (060c `partial`) - some billing endpoints read, some missing. */
function partialInfra(totalCents = 1234): InfraCostReadModel {
	const ok = okInfra(totalCents);
	return { ...ok, status: "partial", missing: ["/billing/usage/compute"] };
}

/** A measured usage snapshot so the Haiku half is `measured` (a real token figure). */
function measuredUsage() {
	return snapshotSource({
		recorded: 3,
		inputTokens: 10_000,
		outputTokens: 2_000,
		cacheReadInputTokens: 1_000,
		cacheCreationInputTokens: 0,
		model: "claude-haiku-4-5",
	});
}

/** A fixture ledger read result (the canonical-per-session rows the rollups group). */
function ledgerOk(rows: Record<string, unknown>[]) {
	return { status: "ok" as const, rows: rows as never };
}

describe("PRD-060e composite ROI read-model (daemon data half)", () => {
	// ── e-AC-2 ───────────────────────────────────────────────────────────────────
	it("e-AC-2 per-section status discriminants: each section carries an explicit status; measured $0 ≠ unknown", () => {
		// All inputs confident → savings ok, infra ok, pollination ok, net ok.
		const ok = assembleRoiView({
			turns: [turn(), turn(), turn()],
			infra: okInfra(),
			usage: measuredUsage(),
			ledger: ledgerOk([]),
			readPolicy: "shared",
		});
		expect(ok.savings.status).toBe("ok");
		expect(ok.infra.status).toBe("ok");
		expect(ok.pollination.status).toBe("ok");
		expect(ok.net.status).toBe("ok");

		// Token capture ABSENT → savings `absent` (NOT a measured $0): distinct from a measured zero.
		const absent = assembleRoiView({
			turns: [absentTurn(), absentTurn()],
			infra: unreachableInfra(),
			usage: emptyUsageSource,
			ledger: ledgerOk([]),
			readPolicy: "shared",
		});
		expect(absent.savings.status).toBe("absent");
		expect(absent.savings.measuredCents).toBe(0); // absent → 0, but the STATUS says "no data".
		expect(absent.infra.status).toBe("unreachable"); // couldn't read billing, distinct from $0.
		// A measured ZERO (a turn with a real 0 cache-read) is `ok`, NOT `absent`.
		const measuredZero = assembleRoiView({
			turns: [turn({ cache_read_input_tokens: 0 })],
			infra: okInfra(),
			usage: measuredUsage(),
			ledger: ledgerOk([]),
			readPolicy: "shared",
		});
		expect(measuredZero.savings.status).toBe("ok");
	});

	// ── e-AC-6 ───────────────────────────────────────────────────────────────────
	it("e-AC-6 net is NOT computed when any required input is missing/unreachable (never fabricated)", () => {
		// Billing unreachable → net not computed; status reflects the unreachable input.
		const billingDown = assembleRoiView({
			turns: [turn(), turn()],
			infra: unreachableInfra(),
			usage: measuredUsage(),
			ledger: ledgerOk([]),
			readPolicy: "shared",
		});
		expect(billingDown.net.computed).toBe(false);
		expect(billingDown.net.netCents).toBe(0); // never a fabricated number — read the status.
		expect(billingDown.net.status).toBe("unreachable");

		// Token capture absent → net not computed either (savings is not present).
		const noCapture = assembleRoiView({
			turns: [absentTurn()],
			infra: okInfra(),
			usage: measuredUsage(),
			ledger: ledgerOk([]),
			readPolicy: "shared",
		});
		expect(noCapture.net.computed).toBe(false);
		expect(noCapture.net.status).toBe("absent");

		// All inputs present → net IS computed, and ALWAYS carries `modeled:true` (it folds a modeled term).
		const computed = assembleRoiView({
			turns: [turn(), turn(), turn()],
			infra: okInfra(),
			usage: measuredUsage(),
			ledger: ledgerOk([]),
			readPolicy: "shared",
		});
		expect(computed.net.computed).toBe(true);
		expect(computed.net.modeled).toBe(true); // the net inherits `est.` (e-AC-3 net-hero).
	});

	// ── e-AC-11 ──────────────────────────────────────────────────────────────────
	it("e-AC-11 all money is INTEGER cents across the wire schema — a float-cents value never survives", () => {
		// A float-cents payload is REJECTED to a safe integer by the wire schema (no float survives).
		const floaty = RoiViewSchema.parse({
			savings: { status: "ok", measuredCents: 12.5, modeledCents: 7.9, assumption: { kind: "k", assumptionText: "t", signedOff: false }, blendedCentsPerMtok: 3.3 },
			infra: { status: "ok", cents: 99.99, costBasis: "measured" },
			pollination: { status: "ok", cents: 5.5, lines: [{ label: "haiku", cents: 1.2 }] },
			net: { status: "ok", computed: true, netCents: 4.4, modeled: true, costBasis: "measured" },
			rollups: [],
			perUserAvailable: false,
			scopedAcrossDevices: true,
			ratesAsOf: "2026-06-26",
		});
		// Every money field is an integer (the float collapsed to the `.catch(0)` / null guard).
		expect(Number.isInteger(floaty.savings.measuredCents)).toBe(true);
		expect(Number.isInteger(floaty.savings.modeledCents)).toBe(true);
		expect(Number.isInteger(floaty.infra.cents)).toBe(true);
		expect(Number.isInteger(floaty.pollination.cents)).toBe(true);
		expect(Number.isInteger(floaty.net.netCents)).toBe(true);
		expect(floaty.pollination.lines.every((l) => Number.isInteger(l.cents))).toBe(true);
		// `blendedCentsPerMtok` is integer-or-null — a float degrades to null (never a float).
		expect(floaty.savings.blendedCentsPerMtok === null || Number.isInteger(floaty.savings.blendedCentsPerMtok)).toBe(true);

		// A real assembled view is integer-cents end to end (the daemon never emits a float).
		const view = assembleRoiView({ turns: [turn(), turn()], infra: okInfra(), usage: measuredUsage(), ledger: ledgerOk([]), readPolicy: "shared" });
		for (const cents of [view.savings.measuredCents, view.savings.modeledCents, view.infra.cents, view.pollination.cents, view.net.netCents]) {
			expect(Number.isInteger(cents)).toBe(true);
		}
	});

	// ── e-AC-12 ──────────────────────────────────────────────────────────────────
	it("e-AC-12 ledger read is scoped through read_policy: isolated→own rows, shared→workspace-wide + across-device flag", async () => {
		// ISOLATED: the read pins to the requesting agent (own rows only) and the across-device flag is false.
		const fakeIso = new FakeDeepLakeTransport((req: TransportRequest) => {
			if (/FROM\s+"roi_metrics"/i.test(req.sql)) return [{ org_id: "o1", agent_id: "agent-A", session_id: "s1", created_at: "t1", measured_cache_savings_cents: 10, cost_basis: "measured" }];
			return []; // sessions read, etc.
		});
		const isoView = await fetchRoiView(client(fakeIso), SCOPE, { agentId: "agent-A", readPolicy: "isolated" });
		expect(isoView.scopedAcrossDevices).toBe(false);
		const isoLedgerSql = fakeIso.requests.find((r) => /FROM\s+"roi_metrics"/i.test(r.sql))?.sql ?? "";
		expect(isoLedgerSql).toMatch(/m\.agent_id = 'agent-A'/); // isolated → pinned to own agent.

		// SHARED: the read does NOT pin to one agent (workspace-wide) and the across-device flag is true.
		const fakeShared = new FakeDeepLakeTransport((req: TransportRequest) => {
			if (/FROM\s+"roi_metrics"/i.test(req.sql))
				return [
					{ org_id: "o1", agent_id: "agent-A", session_id: "s1", created_at: "t1", measured_cache_savings_cents: 10, cost_basis: "measured" },
					{ org_id: "o1", agent_id: "agent-B", session_id: "s2", created_at: "t2", measured_cache_savings_cents: 20, cost_basis: "measured" },
				];
			return [];
		});
		const sharedView = await fetchRoiView(client(fakeShared), SCOPE, { agentId: "agent-A", readPolicy: "shared" });
		expect(sharedView.scopedAcrossDevices).toBe(true);
		const sharedLedgerSql = fakeShared.requests.find((r) => /FROM\s+"roi_metrics"/i.test(r.sql))?.sql ?? "";
		expect(sharedLedgerSql).not.toMatch(/m\.agent_id = 'agent-A'/); // shared → not pinned to one agent.
		// Both reads run under the org/workspace partition (outer ring).
		expect(fakeShared.requests.every((r) => r.org === "o1" && r.workspace === "ws1")).toBe(true);
	});

	// ── e-AC-13 ──────────────────────────────────────────────────────────────────
	it("e-AC-13 daemon computes org/team/agent/project rollups as read-time GROUP BYs (the component does none)", () => {
		const rows = [
			{ org_id: "o1", team_id: "team-A", agent_id: "ag-1", project_id: "proj-X", measured_cache_savings_cents: 100, modeled_savings_cents: 10, infra_cost_cents: 0, gross_cost_cents: 0, cost_basis: "measured" },
			{ org_id: "o1", team_id: "team-A", agent_id: "ag-2", project_id: "proj-Y", measured_cache_savings_cents: 200, modeled_savings_cents: 20, infra_cost_cents: 0, gross_cost_cents: 0, cost_basis: "measured" },
			{ org_id: "o1", team_id: "team-B", agent_id: "ag-1", project_id: "proj-X", measured_cache_savings_cents: 50, modeled_savings_cents: 5, infra_cost_cents: 0, gross_cost_cents: 0, cost_basis: "measured" },
		];
		const rollups = computeRollups(rows as never);
		// One rollup per dimension.
		expect(rollups.map((r) => r.dimension)).toEqual(["org", "team", "agent", "project"]);

		const org = rollups.find((r) => r.dimension === "org");
		expect(org?.rows).toHaveLength(1); // all rows share org o1.
		expect(org?.rows[0]?.measuredSavingsCents).toBe(350); // 100+200+50, integer cents.
		expect(org?.rows[0]?.sessions).toBe(3);

		const team = rollups.find((r) => r.dimension === "team");
		expect(team?.rows.map((r) => r.key).sort()).toEqual(["team-A", "team-B"]);
		expect(team?.rows.find((r) => r.key === "team-A")?.measuredSavingsCents).toBe(300); // 100+200.

		const agent = rollups.find((r) => r.dimension === "agent");
		expect(agent?.rows.find((r) => r.key === "ag-1")?.sessions).toBe(2); // ag-1 appears twice.

		const project = rollups.find((r) => r.dimension === "project");
		expect(project?.rows.map((r) => r.key).sort()).toEqual(["proj-X", "proj-Y"]);
	});

	// ── e-AC-14 ──────────────────────────────────────────────────────────────────
	it("e-AC-14 per-user availability flag is false today (no verified claim) — never a $0 or self-asserted name", () => {
		const view = assembleRoiView({ turns: [turn()], infra: okInfra(), usage: measuredUsage(), ledger: ledgerOk([]), readPolicy: "shared" });
		// The flag is FALSE — the page shows the "per-user requires verified login" empty state, never a per-user net.
		expect(view.perUserAvailable).toBe(false);
		// There is NO per-user rollup dimension (per-user stays gated; only org/team/agent/project are computed).
		expect(view.rollups.map((r) => r.dimension)).not.toContain("user");
	});

	// ── e-AC-15 ──────────────────────────────────────────────────────────────────
	it("e-AC-15 allocated cost_basis is carried and a mixed-basis rollup is flagged (never silently blended)", () => {
		// A rollup whose rows MIX measured + allocated bases is flagged `mixedBasis`.
		const mixed = computeRollups([
			{ org_id: "o1", team_id: "team-A", agent_id: "ag-1", project_id: "p", measured_cache_savings_cents: 100, modeled_savings_cents: 0, infra_cost_cents: 10, gross_cost_cents: 0, cost_basis: "measured" },
			{ org_id: "o1", team_id: "team-B", agent_id: "ag-2", project_id: "p", measured_cache_savings_cents: 80, modeled_savings_cents: 0, infra_cost_cents: 5, gross_cost_cents: 0, cost_basis: "allocated" },
		] as never);
		// Every dimension sees a mixed basis (the two rows span measured + allocated).
		expect(mixed.every((r) => r.mixedBasis)).toBe(true);
		// The allocated row carries `costBasis: 'allocated'` (the `est.`-class tag) — never read as measured.
		const team = mixed.find((r) => r.dimension === "team");
		expect(team?.rows.find((r) => r.key === "team-B")?.costBasis).toBe("allocated");
		expect(team?.rows.find((r) => r.key === "team-A")?.costBasis).toBe("measured");

		// A single-basis rollup is NOT flagged mixed.
		const single = computeRollups([
			{ org_id: "o1", team_id: "team-A", agent_id: "ag-1", project_id: "p", measured_cache_savings_cents: 100, modeled_savings_cents: 0, infra_cost_cents: 10, gross_cost_cents: 0, cost_basis: "measured" },
		] as never);
		expect(single.every((r) => !r.mixedBasis)).toBe(true);
	});
});


describe("CodeRabbit findings: net-all-ok gate, isolated fail-closed, ordered sample, project scope", () => {
	// Finding (net-status): the confident net (status ok, computed true) is emitted ONLY when ALL THREE
	// inputs are FULLY `ok` -- a `partial` cost is NOT good enough (it would understate the bill).
	it("net is NOT ok/computed when any input is merely `partial` (only all-ok qualifies)", () => {
		// Infra partial -> net not computed even though savings + pollination are ok.
		const infraPartial = assembleRoiView({
			turns: [turn(), turn(), turn()],
			infra: partialInfra(),
			usage: measuredUsage(),
			ledger: ledgerOk([]),
			readPolicy: "shared",
		});
		expect(infraPartial.infra.status).toBe("partial");
		expect(infraPartial.net.computed).toBe(false);
		expect(infraPartial.net.status).not.toBe("ok");
		expect(infraPartial.net.status).toBe("partial"); // reflects the partial input.

		// All three ok -> net IS ok + computed.
		const allOk = assembleRoiView({
			turns: [turn(), turn(), turn()],
			infra: okInfra(),
			usage: measuredUsage(),
			ledger: ledgerOk([]),
			readPolicy: "shared",
		});
		expect(allOk.net.status).toBe("ok");
		expect(allOk.net.computed).toBe(true);
	});

	// Finding (isolated-agentid): an `isolated` read with NO agent id does NOT filter on the org id and
	// returns no ledger rows (fails closed) rather than the wrong rows.
	it("isolated read with no agent id fails closed: the ledger SQL is not pinned to the org id", async () => {
		const fake = new FakeDeepLakeTransport((req: TransportRequest) => {
			if (/FROM\s+"roi_metrics"/i.test(req.sql)) return [{ org_id: "o1", agent_id: "agent-A", session_id: "s1", created_at: "t1", measured_cache_savings_cents: 10, cost_basis: "measured" }];
			return [];
		});
		// No agentId provided + isolated policy.
		const view = await fetchRoiView(client(fake), SCOPE, { readPolicy: "isolated" });
		const ledgerSql = fake.requests.find((r) => /FROM\s+"roi_metrics"/i.test(r.sql))?.sql ?? "";
		// NEVER filters on the org id, and never `agent_id = ''` -- it is a guarded-false predicate.
		expect(ledgerSql).not.toMatch(/agent_id = 'o1'/);
		expect(ledgerSql).not.toMatch(/agent_id = ''/);
		expect(ledgerSql).toMatch(/'1' = '0'/); // fail-closed empty predicate.
		// The rollups are empty (no rows admitted by the fail-closed predicate would be returned).
		expect(view.scopedAcrossDevices).toBe(false);
	});

	// Finding (unordered-limit): the capped savings read carries a deterministic ORDER BY so the bounded
	// sample is stable across reads (newest turns), not an arbitrary backend slice.
	it("the savings read is a deterministically-ordered, capped sample (ORDER BY ... LIMIT)", async () => {
		const fake = new FakeDeepLakeTransport((req: TransportRequest) => {
			if (/FROM\s+"sessions"/i.test(req.sql)) return [];
			return [];
		});
		await fetchRoiView(client(fake), SCOPE, { readPolicy: "shared" });
		const sessionsSql = fake.requests.find((r) => /FROM\s+"sessions"/i.test(r.sql))?.sql ?? "";
		expect(sessionsSql).toMatch(/ORDER BY\s+"?creation_date"?\s+DESC/i);
		expect(sessionsSql).toMatch(/LIMIT\s+\d+/i);
		// The ORDER BY precedes the LIMIT (a stable cap, not an arbitrary slice).
		expect(sessionsSql.search(/ORDER BY/i)).toBeLessThan(sessionsSql.search(/LIMIT/i));
	});

	// Finding (project-scope): a project-scoped request narrows BOTH the savings read (sessions) AND the
	// ledger read (roi_metrics) to the selected project_id.
	it("a project-scoped request narrows BOTH the sessions and roi_metrics reads to the project", async () => {
		const fake = new FakeDeepLakeTransport((req: TransportRequest) => []);
		await fetchRoiView(client(fake), SCOPE, { readPolicy: "shared", projectId: "proj-X", agentId: "agent-A" });
		const sessionsSql = fake.requests.find((r) => /FROM\s+"sessions"/i.test(r.sql))?.sql ?? "";
		const ledgerSql = fake.requests.find((r) => /FROM\s+"roi_metrics"/i.test(r.sql))?.sql ?? "";
		expect(sessionsSql).toMatch(/project_id = 'proj-X'/);
		expect(ledgerSql).toMatch(/m\.project_id = 'proj-X'/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// PRD-060 ROI capture fix — a row carrying `model` prices the turn at its REAL rate.
//
// The bug: with no `model` column, `rowToCapturedTurn` never set `CapturedTurn.model`, so
// `resolveRate(undefined, undefined)` fell back to the Sonnet default and an Opus turn was
// MIS-priced. These drive `fetchRoiView` end to end over the fake transport — a `sessions`
// row with `model='claude-opus-4-8'` + cache_read tokens must price at the OPUS row, not Sonnet.
// ─────────────────────────────────────────────────────────────────────────────
describe("PRD-060 ROI fix: the model column prices an Opus turn at the Opus rate (not the Sonnet default)", () => {
	/** Build a fake transport that returns ONE captured `sessions` row with the given columns. */
	function sessionsRow(row: Record<string, unknown>) {
		return new FakeDeepLakeTransport((req: TransportRequest) => {
			if (/FROM\s+"sessions"/i.test(req.sql)) return [row];
			return []; // the roi_metrics ledger read is empty (no rollups needed here).
		});
	}

	// A turn that read 8000 tokens from cache. Opus delta = 1500 − 150 = 1350 cents/Mtok →
	// round(8000 × 1350 / 1e6) = 11 cents. The Sonnet default would be 270 cents/Mtok → 2 cents.
	const CACHE_READ = 8000;
	const OPUS_CENTS = 11;
	const SONNET_DEFAULT_CENTS = 2;

	it("the sessions SELECT requests the model column (so rowToCapturedTurn can read it)", async () => {
		const fake = sessionsRow({});
		await fetchRoiView(client(fake), SCOPE, { readPolicy: "shared" });
		const sessionsSql = fake.requests.find((r) => /FROM\s+"sessions"/i.test(r.sql))?.sql ?? "";
		expect(sessionsSql).toMatch(/"?model"?/);
	});

	it("an Opus row (model='claude-opus-4-8', source_tool='claude-code') prices measured savings at the OPUS rate", async () => {
		const fake = sessionsRow({
			input_tokens: null,
			output_tokens: null,
			cache_read_input_tokens: CACHE_READ,
			cache_creation_input_tokens: null,
			source_tool: "claude-code",
			model: "claude-opus-4-8",
		});
		const view = await fetchRoiView(client(fake), SCOPE, { readPolicy: "shared" });
		expect(view.savings.status).toBe("ok"); // a measured capture.
		expect(view.savings.measuredCents).toBe(OPUS_CENTS); // priced at the Opus row, NOT the Sonnet default.
		expect(view.savings.measuredCents).not.toBe(SONNET_DEFAULT_CENTS);
	});

	it("a row with a BLANK model ('' = unknown) falls back to the conservative Sonnet default rate", async () => {
		const fake = sessionsRow({
			input_tokens: null,
			output_tokens: null,
			cache_read_input_tokens: CACHE_READ,
			cache_creation_input_tokens: null,
			source_tool: "", // unknown source.
			model: "", // model unknown → resolveRate falls back to the Sonnet default.
		});
		const view = await fetchRoiView(client(fake), SCOPE, { readPolicy: "shared" });
		expect(view.savings.measuredCents).toBe(SONNET_DEFAULT_CENTS);
	});
});

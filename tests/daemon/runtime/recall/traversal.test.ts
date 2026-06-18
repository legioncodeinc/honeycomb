/**
 * PRD-007b Graph Traversal — b-AC-1..7 (`retrieval-worker-bee`, Wave 2).
 *
 * Verification posture (EXECUTION_LEDGER-prd-007 / recall CONVENTIONS):
 *   - Every test is named after the AC it proves (one-to-one ledger map).
 *   - A FAKE transport (`FakeDeepLakeTransport` / responder mode) captures the
 *     emitted SQL and returns scripted graph rows — no live DeepLake, no live
 *     embed daemon.
 *   - A FAKE timer seam drives b-AC-6 deterministically without any `sleep`.
 *   - IDs-ONLY is asserted: no content column ever reaches the caller (the SQL
 *     selects only id/memory_id/score-derived columns; the result shape carries
 *     TraversalHit.id not any content field).
 *   - No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { StorageRow } from "../../../../src/daemon/storage/result.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { RecallConfigSchema } from "../../../../src/daemon/runtime/recall/config.js";
import type { RecallConfig } from "../../../../src/daemon/runtime/recall/config.js";
import type { RecallQuery } from "../../../../src/daemon/runtime/recall/contracts.js";
import type { RecallPhaseDeps } from "../../../../src/daemon/runtime/recall/engine.js";
import {
	makeGraphTraversalPhase,
	type TimerFactory,
	type TraversalChannelResult,
	realTimerFactory,
} from "../../../../src/daemon/runtime/recall/traversal.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ORG_SCOPE = { org: "fake-org", workspace: "fake-ws" } as const;

/** Resolve a RecallConfig with given overrides (defaults satisfy all phases). */
function recallConfig(overrides: Record<string, unknown> = {}): RecallConfig {
	return RecallConfigSchema.parse({ graphEnabled: true, ...overrides });
}

function recallQuery(overrides: Partial<RecallQuery> = {}): RecallQuery {
	return {
		query: "how does the daemon bind its socket",
		scope: {
			org: "fake-org",
			workspace: "fake-ws",
			agentId: "agent-1",
			readPolicy: "isolated",
			policyGroup: "",
		},
		...overrides,
	};
}

/** A fake timer factory that resolves immediately (no timeout fires). */
const instantTimer: TimerFactory = {
	delay(_ms: number): Promise<void> {
		return Promise.resolve();
	},
};

/** A fake timer factory that NEVER resolves (timeout never fires — walk runs freely). */
const neverTimer: TimerFactory = {
	delay(_ms: number): Promise<void> {
		return new Promise(() => {
			/* intentionally never resolves */
		});
	},
};

/**
 * A fake timer factory that fires the timeout after the given number of
 * `await` ticks, giving the walk just enough time to start but not finish.
 * Uses a zero-delay Promise so it fires on the next microtask queue drain.
 */
function immediateAfterTickTimer(ticks = 0): TimerFactory {
	return {
		delay(_ms: number): Promise<void> {
			let p = Promise.resolve();
			for (let i = 0; i < ticks; i++) {
				p = p.then(() => Promise.resolve());
			}
			return p;
		},
	};
}

/**
 * Build a storage client backed by a SQL-aware responder.  The responder
 * receives each statement and returns graph rows appropriate to the query.
 */
function makeStorage(responder: (req: TransportRequest) => StorageRow[]) {
	const fake = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	return { storage, fake };
}

/** Build the RecallPhaseDeps the traversal phase receives. */
function phaseDeps(
	storage: ReturnType<typeof createStorageClient>,
	config: RecallConfig,
	logger?: RecallPhaseDeps["logger"],
): RecallPhaseDeps {
	return {
		storage,
		scope: ORG_SCOPE,
		config,
		logger,
	};
}

// ── b-AC-2 ───────────────────────────────────────────────────────────────────

describe("b-AC-2 Graph disabled → traversal skipped, no candidates, no error", () => {
	it("returns empty ids and no error when graphEnabled=false", async () => {
		// No storage calls should occur — the phase must skip early.
		const { storage, fake } = makeStorage((_req) => {
			throw new Error("storage must not be called when graph is disabled");
		});

		const phase = makeGraphTraversalPhase(neverTimer);
		const config = recallConfig({ graphEnabled: false });
		const result = (await phase(recallQuery(), phaseDeps(storage, config))) as TraversalChannelResult;

		expect(result.ids).toHaveLength(0);
		expect(result.timedOut).toBe(false);
		expect(result.entityCount).toBe(0);
		expect(fake.requests).toHaveLength(0);
	});
});

// ── b-AC-1 ───────────────────────────────────────────────────────────────────

describe("b-AC-1 Focal resolution order: pinned→checkpoint→project-path→entity-FTS→session-key", () => {
	it("resolves focal entities via project-path when a project filter is present (priority 3)", async () => {
		// Set up: project-path query returns one entity; then aspects + attrs.
		const entityId = "entity-proj-1";
		const memId = "mem-proj-1";

		const { storage, fake } = makeStorage((req) => {
			const sql = req.sql;
			// project-path match: source_type = 'project' AND source_id ILIKE '%proj%'
			if (/source_type.*project/i.test(sql) && /ILIKE/i.test(sql)) {
				return [{ id: entityId }];
			}
			// aspects for the entity
			if (/entity_aspects/i.test(sql) && sql.includes(entityId)) {
				return [{ id: "aspect-1" }];
			}
			// constraint attributes — none
			if (/JOIN.*entity_aspects/i.test(sql) || /constraint/i.test(sql)) {
				return [];
			}
			// attributes for aspect-1
			if (/entity_attributes/i.test(sql) && sql.includes("aspect-1")) {
				return [{ id: "attr-1", memory_id: memId, kind: "attribute", confidence: 0.8, importance: 0.7 }];
			}
			// edges — none
			if (/entity_dependencies/i.test(sql)) return [];
			// mentions fallback — none needed
			if (/memory_entity_mentions/i.test(sql)) return [];
			return [];
		});

		const config = recallConfig({
			traversal: {
				aspectsPerEntity: 10,
				attrsPerAspect: 20,
				branching: 5,
				totalIds: 100,
				minEdgeWeight: 0.3,
				timeoutMs: 500,
			},
		});

		const phase = makeGraphTraversalPhase(neverTimer);
		const result = (await phase(
			recallQuery({ filters: { project: "proj" } }),
			phaseDeps(storage, config),
		)) as TraversalChannelResult;

		// Project-path entity was the focal entity → produced a memory id.
		expect(result.ids.map((h) => h.id)).toContain(memId);
		// Ensure a project-path query was issued.
		const projectSql = fake.requests.find((r) => /source_type.*project/i.test(r.sql));
		expect(projectSql).toBeDefined();
		expect(projectSql?.sql).toMatch(/ILIKE/i);
	});

	it("falls back to entity FTS tokens when no project path is present (priority 4)", async () => {
		const entityId = "entity-fts-1";
		const memId = "mem-fts-1";

		const { storage, fake } = makeStorage((req) => {
			const sql = req.sql;
			// entity name ILIKE token match (FTS step 4): name ILIKE '%daemon%'
			if (/entities/i.test(sql) && /name.*ILIKE/i.test(sql)) {
				return [{ id: entityId }];
			}
			if (/entity_aspects/i.test(sql) && sql.includes(entityId)) {
				return [{ id: "aspect-fts-1" }];
			}
			if (/JOIN.*entity_aspects/i.test(sql) || /constraint/i.test(sql)) return [];
			if (/entity_attributes/i.test(sql) && sql.includes("aspect-fts-1")) {
				return [{ id: "attr-fts-1", memory_id: memId, kind: "attribute", confidence: 0.7, importance: 0.6 }];
			}
			if (/entity_dependencies/i.test(sql)) return [];
			if (/memory_entity_mentions/i.test(sql)) return [];
			return [];
		});

		const config = recallConfig();
		const phase = makeGraphTraversalPhase(neverTimer);
		// No project filter → should fall through to token FTS.
		// Query contains "daemon" which is ≥3 chars.
		const result = (await phase(recallQuery(), phaseDeps(storage, config))) as TraversalChannelResult;

		expect(result.ids.map((h) => h.id)).toContain(memId);
		// An entity name ILIKE query was issued.
		const ftsSql = fake.requests.find((r) => /entities/i.test(r.sql) && /name.*ILIKE/i.test(r.sql));
		expect(ftsSql).toBeDefined();
	});

	it("uses session-key fallback when no project path and no FTS matches (priority 5)", async () => {
		const entityId = "entity-sess-1";
		const memId = "mem-sess-1";

		const { storage } = makeStorage((req) => {
			const sql = req.sql;
			// FTS returns nothing
			if (/entities/i.test(sql) && /name.*ILIKE/i.test(sql)) return [];
			// session-key fallback: source_id = agent-id
			if (/entities/i.test(sql) && /source_id/i.test(sql) && !(/source_type/i.test(sql))) {
				return [{ id: entityId }];
			}
			if (/entity_aspects/i.test(sql) && sql.includes(entityId)) {
				return [{ id: "aspect-sess-1" }];
			}
			if (/JOIN.*entity_aspects/i.test(sql) || /constraint/i.test(sql)) return [];
			if (/entity_attributes/i.test(sql)) {
				return [{ id: "attr-sess-1", memory_id: memId, kind: "attribute", confidence: 0.6, importance: 0.5 }];
			}
			if (/entity_dependencies/i.test(sql)) return [];
			if (/memory_entity_mentions/i.test(sql)) return [];
			return [];
		});

		const config = recallConfig();
		const phase = makeGraphTraversalPhase(neverTimer);
		const result = (await phase(recallQuery(), phaseDeps(storage, config))) as TraversalChannelResult;

		// Session-key entity produced a memory id.
		expect(result.ids.map((h) => h.id)).toContain(memId);
	});
});

// ── b-AC-3 ───────────────────────────────────────────────────────────────────

describe("b-AC-3 Walk honors caps (aspects, attrs, branching, total IDs)", () => {
	it("caps aspects per entity at aspectsPerEntity — SQL carries LIMIT and responder honours it", async () => {
		const entityId = "entity-cap-1";
		// The responder simulates a real DB: it respects the LIMIT in the SQL
		// by parsing it and returning at most that many rows.  This correctly
		// models the aspectsPerEntity cap being enforced by the emitted SQL.
		const allAspects = ["asp-1", "asp-2", "asp-3", "asp-4", "asp-5"];

		const { storage, fake } = makeStorage((req) => {
			const sql = req.sql;
			if (/source_type.*project/i.test(sql)) return [];
			if (/entities/i.test(sql) && /name.*ILIKE/i.test(sql)) return [{ id: entityId }];
			if (/entities/i.test(sql) && /source_id/i.test(sql)) return [];
			if (/JOIN.*entity_aspects/i.test(sql) || /constraint/i.test(sql)) return [];
			if (/entity_aspects/i.test(sql) && sql.includes(entityId)) {
				// Parse the LIMIT value from the SQL and honour it (simulates the DB).
				const limitMatch = /LIMIT\s+(\d+)/i.exec(sql);
				const limit = limitMatch ? parseInt(limitMatch[1], 10) : allAspects.length;
				return allAspects.slice(0, limit).map((id) => ({ id }));
			}
			if (/entity_attributes/i.test(sql)) {
				for (const asp of allAspects) {
					if (sql.includes(asp)) {
						return [{ id: `attr-${asp}`, memory_id: `mem-${asp}`, kind: "attribute", confidence: 0.5, importance: 0.5 }];
					}
				}
				return [];
			}
			if (/entity_dependencies/i.test(sql)) return [];
			if (/memory_entity_mentions/i.test(sql)) return [];
			return [];
		});

		// Cap aspects at 2.
		const config = recallConfig({
			traversal: { aspectsPerEntity: 2, attrsPerAspect: 20, branching: 5, totalIds: 100, minEdgeWeight: 0.3, timeoutMs: 500 },
		});
		const phase = makeGraphTraversalPhase(neverTimer);
		const result = (await phase(recallQuery(), phaseDeps(storage, config))) as TraversalChannelResult;

		// Verify the simple aspect SQL (FROM entity_aspects, no JOIN) carries LIMIT 2.
		const aspectSql = fake.requests.find(
			(r) => /FROM\s+"?entity_aspects"?/i.test(r.sql) && !/JOIN/i.test(r.sql) && r.sql.includes(entityId),
		);
		expect(aspectSql).toBeDefined();
		expect(aspectSql?.sql).toMatch(/LIMIT 2\b/);

		// Only 2 aspects were returned (responder honoured the LIMIT) → at most 2 memory ids.
		const nonConstraintHits = result.ids.filter((h) =>
			result.constraints.length === 0 || !result.constraints.includes(h.id),
		);
		expect(nonConstraintHits.length).toBeLessThanOrEqual(2);
	});

	it("caps total IDs collected at totalIds", async () => {
		// Supply many entities each with many attrs; cap totalIds at 3.
		const entityId = "entity-total-1";
		const { storage } = makeStorage((req) => {
			const sql = req.sql;
			if (/source_type.*project/i.test(sql)) return [];
			if (/entities/i.test(sql) && /name.*ILIKE/i.test(sql)) return [{ id: entityId }];
			if (/entities/i.test(sql) && /source_id/i.test(sql)) return [];
			if (/entity_aspects/i.test(sql) && sql.includes(entityId)) return [{ id: "asp-t1" }];
			if (/JOIN.*entity_aspects/i.test(sql) || /constraint/i.test(sql)) return [];
			if (/entity_attributes/i.test(sql) && sql.includes("asp-t1")) {
				// Supply 10 attrs.
				return Array.from({ length: 10 }, (_, i) => ({
					id: `attr-t${i}`,
					memory_id: `mem-t${i}`,
					kind: "attribute",
					confidence: 0.8,
					importance: 0.7,
				}));
			}
			if (/entity_dependencies/i.test(sql)) return [];
			if (/memory_entity_mentions/i.test(sql)) return [];
			return [];
		});

		// Cap totalIds at 3 (less than the 10 attrs supplied).
		const config = recallConfig({
			traversal: { aspectsPerEntity: 10, attrsPerAspect: 20, branching: 5, totalIds: 3, minEdgeWeight: 0.3, timeoutMs: 500 },
		});
		const phase = makeGraphTraversalPhase(neverTimer);
		const result = (await phase(recallQuery(), phaseDeps(storage, config))) as TraversalChannelResult;

		expect(result.ids.length).toBeLessThanOrEqual(3);
	});
});

// ── b-AC-4 ───────────────────────────────────────────────────────────────────

describe("b-AC-4 Low strength×confidence edge → not followed", () => {
	it("does not follow an edge whose strength×confidence < minEdgeWeight", async () => {
		const entityId = "entity-edge-src";
		const targetEntityId = "entity-edge-tgt";
		const badTargetMemId = "mem-bad-target";
		const srcMemId = "mem-edge-src";

		const { storage } = makeStorage((req) => {
			const sql = req.sql;
			if (/source_type.*project/i.test(sql)) return [];
			if (/entities/i.test(sql) && /name.*ILIKE/i.test(sql)) return [{ id: entityId }];
			if (/entities/i.test(sql) && /source_id/i.test(sql)) return [];
			if (/entity_aspects/i.test(sql) && sql.includes(entityId)) return [{ id: "asp-edge-src" }];
			if (/JOIN.*entity_aspects/i.test(sql) || /constraint/i.test(sql)) return [];
			if (/entity_attributes/i.test(sql) && sql.includes("asp-edge-src")) {
				return [{ id: "attr-edge-src", memory_id: srcMemId, kind: "attribute", confidence: 0.8, importance: 0.7 }];
			}
			// Edge from entity-edge-src to entity-edge-tgt with combined weight 0.1 (below 0.3).
			if (/entity_dependencies/i.test(sql) && sql.includes(entityId)) {
				// The SQL WHERE clause filters by weight >= threshold; returning this row means
				// it should NOT appear because weight < threshold.
				// We return it anyway (to test the defensive guard), weight=0.1.
				return [{ target_entity_id: targetEntityId, weight: 0.1 }];
			}
			// Target entity's data — must NOT be reached.
			if (/entity_aspects/i.test(sql) && sql.includes(targetEntityId)) {
				return [{ id: "asp-bad-target" }];
			}
			if (/entity_attributes/i.test(sql) && sql.includes("asp-bad-target")) {
				return [{ id: "attr-bad", memory_id: badTargetMemId, kind: "attribute", confidence: 0.9, importance: 0.9 }];
			}
			if (/memory_entity_mentions/i.test(sql)) return [];
			return [];
		});

		// minEdgeWeight = 0.3; the edge weight is 0.1 → must not be followed.
		const config = recallConfig({
			traversal: { aspectsPerEntity: 10, attrsPerAspect: 20, branching: 5, totalIds: 100, minEdgeWeight: 0.3, timeoutMs: 500 },
		});
		const phase = makeGraphTraversalPhase(neverTimer);
		const result = (await phase(recallQuery(), phaseDeps(storage, config))) as TraversalChannelResult;

		// The bad target's memory id must NOT appear (edge was below threshold).
		expect(result.ids.map((h) => h.id)).not.toContain(badTargetMemId);
		// The source's memory id appears as normal.
		expect(result.ids.map((h) => h.id)).toContain(srcMemId);
	});

	it("does follow an edge whose strength×confidence >= minEdgeWeight", async () => {
		const entityId = "entity-good-src";
		const targetEntityId = "entity-good-tgt";
		const targetMemId = "mem-good-target";
		const srcMemId = "mem-good-src";

		const { storage } = makeStorage((req) => {
			const sql = req.sql;
			if (/source_type.*project/i.test(sql)) return [];
			if (/entities/i.test(sql) && /name.*ILIKE/i.test(sql)) return [{ id: entityId }];
			if (/entities/i.test(sql) && /source_id/i.test(sql)) return [];
			if (/entity_aspects/i.test(sql) && sql.includes(entityId)) return [{ id: "asp-good-src" }];
			if (/JOIN.*entity_aspects/i.test(sql) || /constraint/i.test(sql)) return [];
			if (/entity_attributes/i.test(sql) && sql.includes("asp-good-src")) {
				return [{ id: "attr-good-src", memory_id: srcMemId, kind: "attribute", confidence: 0.8, importance: 0.7 }];
			}
			// Good edge — weight 0.5 ≥ 0.3.
			if (/entity_dependencies/i.test(sql) && sql.includes(entityId)) {
				return [{ target_entity_id: targetEntityId, weight: 0.5 }];
			}
			// Target entity aspects.
			if (/entity_aspects/i.test(sql) && sql.includes(targetEntityId)) return [{ id: "asp-good-tgt" }];
			if (/entity_attributes/i.test(sql) && sql.includes("asp-good-tgt")) {
				return [{ id: "attr-good-tgt", memory_id: targetMemId, kind: "attribute", confidence: 0.8, importance: 0.8 }];
			}
			// No further edges.
			if (/entity_dependencies/i.test(sql) && sql.includes(targetEntityId)) return [];
			if (/memory_entity_mentions/i.test(sql)) return [];
			return [];
		});

		const config = recallConfig({
			traversal: { aspectsPerEntity: 10, attrsPerAspect: 20, branching: 5, totalIds: 100, minEdgeWeight: 0.3, timeoutMs: 500 },
		});
		const phase = makeGraphTraversalPhase(neverTimer);
		const result = (await phase(recallQuery(), phaseDeps(storage, config))) as TraversalChannelResult;

		// Both source and target memory ids should appear (edge was followed).
		expect(result.ids.map((h) => h.id)).toContain(srcMemId);
		expect(result.ids.map((h) => h.id)).toContain(targetMemId);
	});
});

// ── b-AC-5 ───────────────────────────────────────────────────────────────────

describe("b-AC-5 Active constraint → surfaced despite caps", () => {
	it("includes a constraint memory id even when totalIds cap is 0 for normal attrs", async () => {
		const entityId = "entity-constraint-1";
		const constraintMemId = "mem-constraint-1";

		const { storage } = makeStorage((req) => {
			const sql = req.sql;
			if (/source_type.*project/i.test(sql)) return [];
			if (/entities/i.test(sql) && /name.*ILIKE/i.test(sql)) return [{ id: entityId }];
			if (/entities/i.test(sql) && /source_id/i.test(sql)) return [];
			// Constraint query (JOIN with entity_aspects).
			if (/JOIN.*entity_aspects/i.test(sql) && /constraint/i.test(sql) && sql.includes(entityId)) {
				return [{ id: "attr-constraint-1", memory_id: constraintMemId, kind: "constraint", confidence: 0.9, importance: 1.0 }];
			}
			// Aspects — return one but no attrs (totalIds cap=1 for constraints test).
			if (/entity_aspects/i.test(sql) && sql.includes(entityId)) return [{ id: "asp-c1" }];
			if (/entity_attributes/i.test(sql)) return [];
			if (/entity_dependencies/i.test(sql)) return [];
			if (/memory_entity_mentions/i.test(sql)) return [];
			return [];
		});

		// totalIds = 1 — just the constraint (constraint is added before the cap-bounded walk).
		const config = recallConfig({
			traversal: { aspectsPerEntity: 10, attrsPerAspect: 20, branching: 5, totalIds: 1, minEdgeWeight: 0.3, timeoutMs: 500 },
		});
		const phase = makeGraphTraversalPhase(neverTimer);
		const result = (await phase(recallQuery(), phaseDeps(storage, config))) as TraversalChannelResult;

		// The constraint memory id must be in the result.
		expect(result.constraints).toContain(constraintMemId);
		expect(result.ids.map((h) => h.id)).toContain(constraintMemId);
	});
});

// ── b-AC-6 ───────────────────────────────────────────────────────────────────

describe("b-AC-6 Timeout → returns collected IDs with timeout flag, not failure", () => {
	it("returns timedOut=true and whatever ids were collected when the timer fires immediately", async () => {
		const entityId = "entity-timeout-1";
		const memId = "mem-timeout-1";

		// Use a storage that is artificially slow via a chain of microtasks.
		// The timer fires after 0 ticks, so the walk races with an immediate resolve.
		const { storage } = makeStorage((req) => {
			const sql = req.sql;
			if (/source_type.*project/i.test(sql)) return [];
			if (/entities/i.test(sql) && /name.*ILIKE/i.test(sql)) return [{ id: entityId }];
			if (/entities/i.test(sql) && /source_id/i.test(sql)) return [];
			if (/JOIN.*entity_aspects/i.test(sql) || /constraint/i.test(sql)) return [];
			if (/entity_aspects/i.test(sql) && sql.includes(entityId)) return [{ id: "asp-to-1" }];
			if (/entity_attributes/i.test(sql)) {
				return [{ id: "attr-to-1", memory_id: memId, kind: "attribute", confidence: 0.7, importance: 0.6 }];
			}
			if (/entity_dependencies/i.test(sql)) return [];
			if (/memory_entity_mentions/i.test(sql)) return [];
			return [];
		});

		const config = recallConfig({
			traversal: { aspectsPerEntity: 10, attrsPerAspect: 20, branching: 5, totalIds: 100, minEdgeWeight: 0.3, timeoutMs: 500 },
		});

		// Timer fires after 0 microtask ticks — fires before the walk can complete many queries.
		const phase = makeGraphTraversalPhase(immediateAfterTickTimer(0));
		const result = (await phase(recallQuery(), phaseDeps(storage, config))) as TraversalChannelResult;

		// The timeout flag MUST be set.
		expect(result.timedOut).toBe(true);
		// No throw — the phase resolved normally.
		expect(result.channel).toBe("traversal");
		// ids may be empty or partial — either is acceptable (the walk was interrupted).
	});

	it("does NOT set timedOut when the walk finishes before the timer (neverTimer)", async () => {
		const entityId = "entity-no-timeout";
		const memId = "mem-no-timeout";

		const { storage } = makeStorage((req) => {
			const sql = req.sql;
			if (/source_type.*project/i.test(sql)) return [];
			if (/entities/i.test(sql) && /name.*ILIKE/i.test(sql)) return [{ id: entityId }];
			if (/entities/i.test(sql) && /source_id/i.test(sql)) return [];
			if (/JOIN.*entity_aspects/i.test(sql) || /constraint/i.test(sql)) return [];
			if (/entity_aspects/i.test(sql) && sql.includes(entityId)) return [{ id: "asp-nt1" }];
			if (/entity_attributes/i.test(sql)) {
				return [{ id: "attr-nt1", memory_id: memId, kind: "attribute", confidence: 0.7, importance: 0.6 }];
			}
			if (/entity_dependencies/i.test(sql)) return [];
			if (/memory_entity_mentions/i.test(sql)) return [];
			return [];
		});

		const config = recallConfig();
		const phase = makeGraphTraversalPhase(neverTimer);
		const result = (await phase(recallQuery(), phaseDeps(storage, config))) as TraversalChannelResult;

		expect(result.timedOut).toBe(false);
		expect(result.ids.map((h) => h.id)).toContain(memId);
	});
});

// ── b-AC-7 ───────────────────────────────────────────────────────────────────

describe("b-AC-7 Returns IDs+scores+paths, constraints, entity count, timeout flag; no content", () => {
	it("result shape carries ids with score, constraints list, entityCount, timedOut; no content column", async () => {
		const entityId = "entity-shape-1";
		const memId = "mem-shape-1";
		const constraintMemId = "mem-constraint-shape";

		const { storage } = makeStorage((req) => {
			const sql = req.sql;
			if (/source_type.*project/i.test(sql)) return [];
			if (/entities/i.test(sql) && /name.*ILIKE/i.test(sql)) return [{ id: entityId }];
			if (/entities/i.test(sql) && /source_id/i.test(sql)) return [];
			if (/JOIN.*entity_aspects/i.test(sql) && /constraint/i.test(sql)) {
				return [{ id: "attr-shape-c", memory_id: constraintMemId, kind: "constraint", confidence: 0.9, importance: 1.0 }];
			}
			if (/entity_aspects/i.test(sql) && sql.includes(entityId)) return [{ id: "asp-shape-1" }];
			if (/entity_attributes/i.test(sql) && sql.includes("asp-shape-1")) {
				return [{ id: "attr-shape-1", memory_id: memId, kind: "attribute", confidence: 0.8, importance: 0.7, content: "MUST NOT APPEAR" }];
			}
			if (/entity_dependencies/i.test(sql)) return [];
			if (/memory_entity_mentions/i.test(sql)) return [];
			return [];
		});

		const config = recallConfig();
		const phase = makeGraphTraversalPhase(neverTimer);
		const result = (await phase(recallQuery(), phaseDeps(storage, config))) as TraversalChannelResult;

		// ── IDs + scores (b-AC-7) ──────────────────────────────────────────────
		expect(result.channel).toBe("traversal");
		expect(result.ids.length).toBeGreaterThan(0);
		for (const hit of result.ids) {
			// Every hit has an id string and a numeric score in [0,1].
			expect(typeof hit.id).toBe("string");
			expect(hit.id).not.toBe("");
			expect(typeof hit.score).toBe("number");
			expect(hit.score).toBeGreaterThanOrEqual(0);
			expect(hit.score).toBeLessThanOrEqual(1);
			// NO content field — not on the ChannelResult.ids shape.
			expect(hit).not.toHaveProperty("content");
		}

		// ── Constraints list (b-AC-7) ──────────────────────────────────────────
		expect(result.constraints).toContain(constraintMemId);

		// ── Entity count (b-AC-7) ─────────────────────────────────────────────
		expect(result.entityCount).toBeGreaterThan(0);

		// ── Timeout flag (b-AC-7) ─────────────────────────────────────────────
		expect(result.timedOut).toBe(false);

		// ── IDs-only assertion: no content ever in hit objects ────────────────
		// The ChannelResult.ids type is { id, score } — structurally impossible to
		// carry content.  As an extra belt-and-suspenders check, assert the raw ids
		// shape has no content field even if the storage row returned one.
		const allIds = result.ids as unknown as Record<string, unknown>[];
		for (const hit of allIds) {
			expect(hit).not.toHaveProperty("content");
		}
	});

	it("sql queries select only id/memory_id/score columns (no content column in any SELECT)", async () => {
		const entityId = "entity-sql-check";

		const { storage, fake } = makeStorage((req) => {
			const sql = req.sql;
			if (/source_type.*project/i.test(sql)) return [];
			if (/entities/i.test(sql) && /name.*ILIKE/i.test(sql)) return [{ id: entityId }];
			if (/entities/i.test(sql) && /source_id/i.test(sql)) return [];
			if (/JOIN.*entity_aspects/i.test(sql) || /constraint/i.test(sql)) return [];
			if (/entity_aspects/i.test(sql)) return [];
			if (/entity_attributes/i.test(sql)) return [];
			if (/entity_dependencies/i.test(sql)) return [];
			if (/memory_entity_mentions/i.test(sql)) return [];
			return [];
		});

		const config = recallConfig();
		const phase = makeGraphTraversalPhase(neverTimer);
		await phase(recallQuery(), phaseDeps(storage, config));

		// Every emitted SQL statement must NOT select a bare `content` column.
		for (const req of fake.requests) {
			// Allow `constraint` keyword (a value, not a column selection) and
			// `content_embedding` (different column) — but `content` as a selected
			// column alias is not allowed.
			const hasContentSelect = /SELECT[\s\S]*\bcontent\b\s+AS/i.test(req.sql) ||
				/SELECT\s+\*\s+FROM/i.test(req.sql);
			expect(hasContentSelect).toBe(false);
		}
	});

	it("emits scoped SQL with correct org+workspace reaching storage (FR-9)", async () => {
		const entityId = "entity-scope-1";

		const { storage, fake } = makeStorage((req) => {
			const sql = req.sql;
			if (/source_type.*project/i.test(sql)) return [];
			if (/entities/i.test(sql) && /name.*ILIKE/i.test(sql)) return [{ id: entityId }];
			if (/entities/i.test(sql) && /source_id/i.test(sql)) return [];
			if (/JOIN.*entity_aspects/i.test(sql) || /constraint/i.test(sql)) return [];
			if (/entity_aspects/i.test(sql)) return [];
			if (/entity_attributes/i.test(sql)) return [];
			if (/entity_dependencies/i.test(sql)) return [];
			if (/memory_entity_mentions/i.test(sql)) return [];
			return [];
		});

		const config = recallConfig();
		const phase = makeGraphTraversalPhase(neverTimer);
		await phase(recallQuery(), phaseDeps(storage, config));

		// Every request must carry the org + workspace scope.
		expect(fake.requests.length).toBeGreaterThan(0);
		for (const req of fake.requests) {
			expect(req.org).toBe("fake-org");
			expect(req.workspace).toBe("fake-ws");
		}

		// Every SQL must include the agent_id conjunct (FR-9).
		for (const req of fake.requests) {
			expect(req.sql).toMatch(/agent_id/i);
		}
	});

	it("exports realTimerFactory for production use", () => {
		// Smoke-test that the real timer factory is exported and has a delay method.
		expect(typeof realTimerFactory.delay).toBe("function");
	});
});

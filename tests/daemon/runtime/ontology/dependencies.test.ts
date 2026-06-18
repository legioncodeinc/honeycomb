/**
 * PRD-008b — dependency edges + append-only supersession (`dependencies.ts`).
 *
 * Each `describe` is named after the b-AC it proves. Drives the FAKE DeepLake
 * transport (assert the emitted scoped SQL, the escaping, the version-bump SQL) and
 * a FAKE conflict model (the LLM fallback, OFF by default — D-5):
 *
 *   b-AC-1 supersede append + mark-prior (version-bump SQL, no in-place content mutate).
 *   b-AC-2 no in-place mutate; full version history on disk (exactly one UPDATE, of the prior).
 *   b-AC-3 a loose `related_to` edge carries type/strength/confidence + a REQUIRED reason.
 *   b-AC-4 the edge gate: strength × confidence ≥ threshold (D-4 = 0.3).
 *   b-AC-5 a constraint is NOT auto-superseded (D-7).
 *   b-AC-6 conflict detection: lexical overlap + negation/antonym (+ LLM fallback OFF by default).
 *   b-AC-7 every write escaped + scoped (the daemon-only path).
 */

import { describe, expect, it } from "vitest";

import {
	createStorageClient,
	type QueryScope,
	type StorageQuery,
} from "../../../../src/daemon/storage/index.js";
import type { StorageRow } from "../../../../src/daemon/storage/result.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import {
	detectConflict,
	edgeClearsThreshold,
	dependencyEdgeId,
	EDGE_THRESHOLD,
	supersedeOnConflict,
	writeDependencyEdge,
	type ConflictModel,
} from "../../../../src/daemon/runtime/ontology/dependencies.js";
import { attributeVersionId } from "../../../../src/daemon/runtime/ontology/supersede.js";
import {
	FakeDeepLakeTransport,
	fakeCredentialRecord,
	stubProvider,
} from "../../../helpers/fake-deeplake.js";

const SCOPE: QueryScope = { org: "o", workspace: "w" };

function storageWith(responder: (req: TransportRequest) => StorageRow[]): {
	storage: StorageQuery;
	transport: FakeDeepLakeTransport;
} {
	const transport = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ provider: stubProvider(fakeCredentialRecord()), transport });
	return { storage, transport };
}

/** A responder that answers every read empty (no prior rows → an append-only path). */
const EMPTY = (): StorageRow[] => [];

const NEW_ATTR = {
	kind: "attribute" as const,
	content: "Staff Engineer",
	confidence: 0.9,
	importance: 0.5,
	provenance: { memoryId: "mem-2", source: "extraction" },
	agentId: "agent-a",
};

// ── b-AC-3 + b-AC-7: dependency edge writes ───────────────────────────────────

describe("writeDependencyEdge: a related_to edge carries type/strength/confidence + a required reason (b-AC-3)", () => {
	it("APPENDs the edge into entity_dependencies with type, strength, confidence, reason", async () => {
		const { storage, transport } = storageWith(EMPTY);
		await writeDependencyEdge(storage, SCOPE, {
			sourceEntityId: "ent-a",
			targetEntityId: "ent-b",
			type: "related_to",
			strength: 0.8,
			confidence: 0.7,
			reason: "discussed together in the same memory",
			agentId: "agent-a",
		});

		const insert = transport.requests.map((r) => r.sql).find((s) => s.toUpperCase().startsWith("INSERT"));
		expect(insert, "an INSERT into entity_dependencies was issued").toBeTruthy();
		expect(String(insert)).toContain('INSERT INTO "entity_dependencies"');
		expect(String(insert)).toContain("'related_to'");
		expect(String(insert)).toContain("0.8"); // strength
		expect(String(insert)).toContain("0.7"); // confidence
		// reason is a text body → E'...' escape literal (b-AC-7).
		expect(String(insert)).toContain("E'discussed together in the same memory'");
	});

	it("REJECTS a loose related_to edge with an empty/whitespace reason (b-AC-3 guard)", async () => {
		const { storage, transport } = storageWith(EMPTY);
		await expect(
			writeDependencyEdge(storage, SCOPE, {
				sourceEntityId: "ent-a",
				targetEntityId: "ent-b",
				type: "related_to",
				strength: 0.9,
				confidence: 0.9,
				reason: "   ",
				agentId: "agent-a",
			}),
		).rejects.toThrow(/reason/i);
		// The bad edge never reached an INSERT.
		const insert = transport.requests.find((r) => r.sql.toUpperCase().startsWith("INSERT"));
		expect(insert).toBeUndefined();
	});

	it("a STRONGER typed edge (depends_on) is permitted WITHOUT a reason", async () => {
		const { storage, transport } = storageWith(EMPTY);
		await expect(
			writeDependencyEdge(storage, SCOPE, {
				sourceEntityId: "ent-a",
				targetEntityId: "ent-b",
				type: "depends_on",
				strength: 0.6,
				confidence: 0.6,
				reason: "",
				agentId: "agent-a",
			}),
		).resolves.toBeUndefined();
		const insert = transport.requests.find((r) => r.sql.toUpperCase().startsWith("INSERT"));
		expect(insert).toBeTruthy();
	});

	it("a re-asserted edge (same source/target/type) is an idempotent no-op (poll-convergent dedup)", async () => {
		const id = dependencyEdgeId("ent-a", "ent-b", "related_to");
		// Responder: the by-id probe finds the prior edge → no new insert.
		const responder = (req: TransportRequest): StorageRow[] => {
			if (req.sql.toUpperCase().startsWith("SELECT") && req.sql.includes(id)) return [{ id }];
			return [];
		};
		const { storage, transport } = storageWith(responder);
		await writeDependencyEdge(storage, SCOPE, {
			sourceEntityId: "ent-a",
			targetEntityId: "ent-b",
			type: "related_to",
			strength: 0.8,
			confidence: 0.8,
			reason: "already linked",
			agentId: "agent-a",
		});
		const insert = transport.requests.find((r) => r.sql.toUpperCase().startsWith("INSERT"));
		expect(insert, "no INSERT — the edge was already present").toBeUndefined();
	});

	it("every statement carries the org/workspace partition + escapes values (b-AC-7)", async () => {
		const { storage, transport } = storageWith(EMPTY);
		await writeDependencyEdge(storage, SCOPE, {
			sourceEntityId: "ent-a",
			targetEntityId: "ent-b",
			type: "related_to",
			// An injection-shaped reason must collapse to one inert literal.
			reason: "it's a 'soft' link; DROP TABLE x; --",
			strength: 0.5,
			confidence: 0.5,
			agentId: "agent-a",
		});
		expect(transport.requests.length).toBeGreaterThan(0);
		for (const req of transport.requests) {
			expect(req.org).toBe("o");
			expect(req.workspace).toBe("w");
		}
		const insert = String(transport.requests.find((r) => r.sql.toUpperCase().startsWith("INSERT"))?.sql);
		// The embedded quotes are doubled (sqlStr); no early string close.
		expect(insert).toContain("it''s a ''soft'' link");
	});
});

// ── b-AC-4: edge threshold gate ───────────────────────────────────────────────

describe("edgeClearsThreshold: an edge is followed only when strength × confidence clears the threshold (b-AC-4 / D-4)", () => {
	it("the default threshold is the D-4 value (0.3)", () => {
		expect(EDGE_THRESHOLD).toBe(0.3);
	});

	it("a product at/above 0.3 clears; a product below 0.3 does not", () => {
		expect(edgeClearsThreshold(0.6, 0.6)).toBe(true); // 0.36 ≥ 0.3
		expect(edgeClearsThreshold(0.5, 0.6)).toBe(true); // 0.30 ≥ 0.3 (boundary)
		expect(edgeClearsThreshold(0.4, 0.5)).toBe(false); // 0.20 < 0.3
		expect(edgeClearsThreshold(0.9, 0.1)).toBe(false); // 0.09 < 0.3
	});

	it("a soft low-confidence edge (recorded with a reason) stays out of traversal", () => {
		// The exact shape PRD-008b describes: a related_to with a reason but a low product.
		expect(edgeClearsThreshold(0.9, 0.2)).toBe(false); // 0.18 < 0.3 — not followed
	});

	it("a non-finite product never clears", () => {
		expect(edgeClearsThreshold(Number.NaN, 0.9)).toBe(false);
	});
});

// ── b-AC-6: conflict detection (lexical + negation/antonym + LLM fallback off) ──

describe("detectConflict: lexical overlap + negation/antonym signals (b-AC-6 / D-5)", () => {
	it("a NEGATION flip on overlapping claims is a conflict", () => {
		const v = detectConflict("the build is passing", "the build is not passing");
		expect(v.conflict).toBe(true);
		expect(v.signal).toBe("negation");
	});

	it("an ANTONYM swap on overlapping claims is a conflict", () => {
		const v = detectConflict("telemetry is enabled", "telemetry is disabled");
		expect(v.conflict).toBe(true);
		expect(v.signal).toBe("antonym");
	});

	it("the SAME claim restated is NOT a conflict (high overlap, no flip)", () => {
		const v = detectConflict("prefers dark mode", "the user prefers dark mode");
		expect(v.conflict).toBe(false);
		expect(v.signal).toBe("high-overlap");
	});

	it("identical content is NOT a conflict", () => {
		const v = detectConflict("Engineer", "Engineer");
		expect(v.conflict).toBe(false);
		expect(v.signal).toBe("identical");
	});

	it("two UNRELATED claims are NOT a conflict (low overlap, conclusive)", () => {
		const v = detectConflict("x", "y");
		expect(v.conflict).toBe(false);
		expect(v.inconclusive).toBe(false);
	});

	it("a mid-band overlap with no lexical flip is INCONCLUSIVE (the LLM fallback band)", () => {
		// Some shared tokens, no negation/antonym, not near-identical, not unrelated.
		const v = detectConflict("role is staff engineer on the platform team", "role is principal architect");
		expect(v.conflict).toBe(false);
		expect(v.inconclusive).toBe(true);
	});
});

describe("supersedeOnConflict: the LLM fallback is OFF by default and fires only on an inconclusive lexical pass (b-AC-6 / D-5)", () => {
	const superArgs = { entityId: "ent-1", aspectId: "asp-1", newAttribute: NEW_ATTR };

	it("with NO model injected, an inconclusive mid-band overlap does NOT supersede (fallback off)", async () => {
		const { storage, transport } = storageWith(EMPTY);
		const out = await supersedeOnConflict(
			storage,
			SCOPE,
			{
				incoming: { content: "role is staff engineer on the platform team", kind: "attribute" },
				prior: { id: "attr_prior", content: "role is principal architect", kind: "attribute" },
				slot: { groupKey: "role", claimKey: "title" },
			},
			superArgs,
		);
		expect(out).toBeNull();
		// No write at all — nothing was superseded.
		expect(transport.requests.some((r) => r.sql.toUpperCase().startsWith("INSERT"))).toBe(false);
	});

	it("an injected model decides the inconclusive band — and supersedes when it says CONFLICT", async () => {
		const calls: Array<[string, string]> = [];
		const model: ConflictModel = {
			conflicts: (incoming, prior) => {
				calls.push([incoming, prior]);
				return Promise.resolve(true);
			},
		};
		const { storage, transport } = storageWith(EMPTY);
		const out = await supersedeOnConflict(
			storage,
			SCOPE,
			{
				incoming: { content: "role is staff engineer on the platform team", kind: "attribute" },
				prior: { id: "attr_prior", content: "role is principal architect", kind: "attribute" },
				slot: { groupKey: "role", claimKey: "title" },
			},
			superArgs,
			{ model },
		);
		expect(calls).toHaveLength(1); // the fallback fired
		expect(out).not.toBeNull();
		// It superseded → a version-bumped INSERT landed.
		expect(transport.requests.some((r) => r.sql.toUpperCase().startsWith("INSERT"))).toBe(true);
	});

	it("an OBVIOUS conflict (negation) never pays for a model round-trip", async () => {
		let modelCalled = false;
		const model: ConflictModel = {
			conflicts: () => {
				modelCalled = true;
				return Promise.resolve(false);
			},
		};
		const { storage } = storageWith(EMPTY);
		const out = await supersedeOnConflict(
			storage,
			SCOPE,
			{
				incoming: { content: "the build is not passing", kind: "attribute" },
				prior: { id: "attr_prior", content: "the build is passing", kind: "attribute" },
				slot: { groupKey: "status", claimKey: "build" },
			},
			superArgs,
			{ model },
		);
		expect(modelCalled, "the lexical pass was conclusive — no model call").toBe(false);
		expect(out).not.toBeNull();
	});
});

// ── b-AC-1 + b-AC-2: supersede append + mark-prior, no in-place mutate ─────────

describe("supersedeOnConflict: a conflicting sibling is marked superseded via the version-bump append (b-AC-1 / b-AC-2)", () => {
	const superArgs = { entityId: "ent-1", aspectId: "asp-1", newAttribute: NEW_ATTR };

	it("APPENDs a status='active' version-bumped row and APPEND-MARKs the prior superseded (b-AC-1)", async () => {
		const priorId = "attr_prior";
		// The max-version + prior current-state reads return the prior row (version 1);
		// priorId is supplied so the prior-active read is skipped.
		const responder = (req: TransportRequest): StorageRow[] => {
			const upper = req.sql.toUpperCase();
			if (upper.startsWith("SELECT") && upper.includes("ENTITY_ATTRIBUTES")) {
				return [{ id: priorId, version: 1, status: "active", content: "the build is passing" }];
			}
			return [];
		};
		const { storage, transport } = storageWith(responder);

		const out = await supersedeOnConflict(
			storage,
			SCOPE,
			{
				incoming: { content: "the build is not passing", kind: "attribute" },
				prior: { id: priorId, content: "the build is passing", kind: "attribute" },
				slot: { groupKey: "status", claimKey: "build" },
			},
			superArgs,
		);

		expect(out).not.toBeNull();
		expect(out?.version).toBe(2); // N+1
		expect(out?.supersededId).toBe(priorId);
		expect(out?.newId).toBe(attributeVersionId("asp-1", { groupKey: "status", claimKey: "build" }, 2));

		// APPEND-ONLY: no in-place UPDATE (a by-id SET does not converge on the real backend).
		const updates = transport.requests.filter((r) => r.sql.toUpperCase().startsWith("UPDATE"));
		expect(updates, "no in-place UPDATE").toHaveLength(0);

		const inserts = transport.requests.map((r) => r.sql).filter((s) => s.toUpperCase().startsWith("INSERT"));
		// 1. APPEND the new claim: a version-bumped INSERT with status='active'.
		const activeInsert = inserts.find((s) => s.includes("'active'"));
		expect(String(activeInsert)).toContain("version");
		expect(String(activeInsert)).toContain(`'${out?.newId}'`);
		// 2. APPEND-MARK the prior: a SEPARATE INSERT, SAME prior id, status='superseded',
		//    superseded_by=newId (its highest version reads superseded — never an UPDATE).
		const markInsert = inserts.find((s) => s.includes("'superseded'"));
		expect(String(markInsert)).toContain("superseded_by");
		expect(String(markInsert)).toContain(`'${priorId}'`);
		expect(String(markInsert)).toContain(`'${out?.newId}'`);
	});

	it("the mark is a SEPARATE prior-id append — the new claim row is never content-mutated (b-AC-2)", async () => {
		const priorId = "attr_prior_2";
		const { storage, transport } = storageWith(EMPTY);
		const out = await supersedeOnConflict(
			storage,
			SCOPE,
			{
				incoming: { content: "telemetry is disabled", kind: "attribute" },
				prior: { id: priorId, content: "telemetry is enabled", kind: "attribute" },
				slot: { groupKey: "config", claimKey: "telemetry" },
			},
			superArgs,
		);
		expect(out).not.toBeNull();

		// ZERO in-place UPDATEs — the prior row's original version stays INTACT on disk
		// and the mark is a NEW prior-id version, so full history is preserved (b-AC-2).
		const updates = transport.requests.filter((r) => r.sql.toUpperCase().startsWith("UPDATE"));
		expect(updates, "no in-place UPDATE — append-only history").toHaveLength(0);

		// Exactly two inserts: the new active claim + the prior-id superseded mark.
		const inserts = transport.requests.filter((r) => r.sql.toUpperCase().startsWith("INSERT"));
		expect(inserts).toHaveLength(2);
		const mark = String(inserts.find((r) => r.sql.includes("'superseded'"))?.sql);
		// The mark targets the PRIOR id and points it at its successor — never the new row.
		expect(mark).toContain(`'${priorId}'`);
		expect(mark).toContain(`superseded_by`);
		expect(mark).toContain(`'${out?.newId}'`);
		// The mark is an INSERT (no `content = …` SET clause) and never carries the
		// INCOMING value — the prior's content is copied forward (or left empty when the
		// prior's current state is unreadable), never rewritten to the new claim.
		expect(mark).not.toMatch(/\bcontent\s*=/i);
		expect(mark).not.toContain("telemetry is disabled");
	});

	it("no conflict → no supersession (the slot is left untouched)", async () => {
		const { storage, transport } = storageWith(EMPTY);
		const out = await supersedeOnConflict(
			storage,
			SCOPE,
			{
				incoming: { content: "the user prefers dark mode", kind: "attribute" },
				prior: { id: "attr_prior", content: "prefers dark mode", kind: "attribute" },
				slot: { groupKey: "prefs", claimKey: "theme" },
			},
			superArgs,
		);
		expect(out).toBeNull();
		expect(transport.requests.some((r) => r.sql.toUpperCase().startsWith("INSERT"))).toBe(false);
		expect(transport.requests.some((r) => r.sql.toUpperCase().startsWith("UPDATE"))).toBe(false);
	});
});

// ── b-AC-5: constraints are NOT auto-superseded ───────────────────────────────

describe("supersedeOnConflict: a constraint is NOT auto-superseded (b-AC-5 / D-7)", () => {
	const superArgs = { entityId: "ent-1", aspectId: "asp-1", newAttribute: NEW_ATTR };

	it("a conflicting value against a kind='constraint' prior does NOT supersede (no write)", async () => {
		const { storage, transport } = storageWith(EMPTY);
		const out = await supersedeOnConflict(
			storage,
			SCOPE,
			{
				// A clear negation conflict that WOULD supersede a normal attribute…
				incoming: { content: "the deploy is not allowed", kind: "attribute" },
				// …but the prior is a CONSTRAINT, so it is exempt (D-7).
				prior: { id: "attr_constraint", content: "the deploy is allowed", kind: "constraint" },
				slot: { groupKey: "policy", claimKey: "deploy" },
			},
			superArgs,
		);
		expect(out, "a constraint is never auto-superseded").toBeNull();
		// No INSERT and no UPDATE — the constraint chain is untouched; replacing it
		// requires a deliberate control-plane op (008c).
		expect(transport.requests.some((r) => r.sql.toUpperCase().startsWith("INSERT"))).toBe(false);
		expect(transport.requests.some((r) => r.sql.toUpperCase().startsWith("UPDATE"))).toBe(false);
	});

	it("the constraint guard short-circuits BEFORE the model fallback (no model call)", async () => {
		let modelCalled = false;
		const model: ConflictModel = {
			conflicts: () => {
				modelCalled = true;
				return Promise.resolve(true);
			},
		};
		const { storage } = storageWith(EMPTY);
		const out = await supersedeOnConflict(
			storage,
			SCOPE,
			{
				incoming: { content: "role is staff engineer on the platform team", kind: "attribute" },
				prior: { id: "attr_c", content: "role is principal architect", kind: "constraint" },
				slot: { groupKey: "role", claimKey: "title" },
			},
			superArgs,
			{ model },
		);
		expect(out).toBeNull();
		expect(modelCalled, "a constraint never even reaches the detector").toBe(false);
	});
});

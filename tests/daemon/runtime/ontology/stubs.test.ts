/**
 * PRD-008 Wave 1 — pre-wired 008b/008c stubs compile + the boundary contracts validate.
 *
 * Proves the Wave-1 surface the two Wave-2 Bees build on is importable and stable:
 *   - the 008b / 008c stub modules import + their exported no-ops resolve;
 *   - the contracts' zod boundary validators (`parseProposal` / `parseAssertion`)
 *     accept a valid body and reject a malformed one (drop-invalid, never throw).
 */

import { describe, expect, it } from "vitest";

import {
	createStorageClient,
	type QueryScope,
} from "../../../../src/daemon/storage/index.js";
import {
	FakeDeepLakeTransport,
	fakeCredentialRecord,
	stubProvider,
} from "../../../helpers/fake-deeplake.js";
import {
	ASSERTION_PREDICATES,
	coerceEntityType,
	ENTITY_TYPES,
	isEntityType,
	parseAssertion,
	parseProposal,
	PROPOSAL_OPERATIONS,
} from "../../../../src/daemon/runtime/ontology/contracts.js";
import {
	supersedeOnConflict,
	writeDependencyEdge,
} from "../../../../src/daemon/runtime/ontology/dependencies.js";
import {
	DIRECT_APPLY_OPERATIONS,
	recordAssertion,
	submitProposal,
} from "../../../../src/daemon/runtime/ontology/control-plane.js";

const SCOPE: QueryScope = { org: "o", workspace: "w" };

function storage() {
	return createStorageClient({
		provider: stubProvider(fakeCredentialRecord()),
		transport: new FakeDeepLakeTransport(() => []),
	});
}

describe("008b stub compiles + no-ops are callable", () => {
	it("writeDependencyEdge accepts a valid edge (reason guard passes) and is a no-op", async () => {
		await expect(
			writeDependencyEdge(storage(), SCOPE, {
				sourceEntityId: "a",
				targetEntityId: "b",
				type: "related_to",
				strength: 0.9,
				confidence: 0.8,
				reason: "they were discussed together",
				agentId: "agent-a",
			}),
		).resolves.toBeUndefined();
	});

	it("writeDependencyEdge REJECTS a loose related_to edge with no reason (b-AC-3 guard wired)", async () => {
		await expect(
			writeDependencyEdge(storage(), SCOPE, {
				sourceEntityId: "a",
				targetEntityId: "b",
				type: "related_to",
				strength: 0.9,
				confidence: 0.8,
				reason: "   ",
				agentId: "agent-a",
			}),
		).rejects.toBeTruthy();
	});

	it("supersedeOnConflict returns null today (Wave-2 fills the detector)", async () => {
		const out = await supersedeOnConflict(storage(), SCOPE, {
			incoming: { content: "x", kind: "attribute" },
			prior: { id: "p", content: "y", kind: "attribute" },
			slot: { groupKey: "g", claimKey: "c" },
		});
		expect(out).toBeNull();
	});
});

describe("008c control plane filled — the entry points route + validate", () => {
	it("submitProposal routes a non-bounded op to the pending queue (Wave-2 risk router live)", async () => {
		// `entity.merge` is NOT a bounded direct-apply op (D-6), so it enters the review
		// queue — recorded `pending`, not applied. (The full c-AC matrix lives in
		// control-plane.test.ts; this just proves the filled entry point routes.)
		const out = await submitProposal(storage(), SCOPE, {
			operation: "entity.merge",
			payload: { from: "a", into: "b" },
			provenance: { source: "cli", evidence: "m" },
		});
		expect(out.route).toBe("pending");
		expect(out.status).toBe("pending");
	});

	it("submitProposal rejects a malformed proposal at the boundary → failed", async () => {
		const out = await submitProposal(storage(), SCOPE, { operation: "nope" });
		expect(out.status).toBe("failed");
	});

	it("recordAssertion validates the body via the boundary schema", async () => {
		const out = await recordAssertion(storage(), SCOPE, {
			predicate: "believes",
			content: "the daemon binds 3850",
			speaker: "mario",
		});
		expect(out).not.toBeNull();
		expect(out?.predicate).toBe("believes");
	});

	it("DIRECT_APPLY_OPERATIONS holds the bounded ops (the risk-router allow-list seam)", () => {
		expect(DIRECT_APPLY_OPERATIONS.has("claim.supersede")).toBe(true);
		expect(DIRECT_APPLY_OPERATIONS.has("entity.merge")).toBe(false);
	});
});

describe("contracts boundary validators (drop-invalid, never throw)", () => {
	it("parseProposal accepts a valid proposal + fills defaults", () => {
		const p = parseProposal({ operation: "claim.set", payload: { claimKey: "title" } });
		expect(p).not.toBeNull();
		expect(p?.status).toBe("pending");
		expect(p?.confidence).toBe(1);
	});

	it("parseProposal rejects an unknown operation → null", () => {
		expect(parseProposal({ operation: "nope" })).toBeNull();
	});

	it("parseAssertion rejects a missing speaker → null", () => {
		expect(parseAssertion({ predicate: "claims", content: "x" })).toBeNull();
	});

	it("entity-type coercion maps an unknown type to 'unknown' and validates the fixed set", () => {
		expect(coerceEntityType("Person")).toBe("person");
		expect(coerceEntityType("frobnicator")).toBe("unknown");
		expect(isEntityType("project")).toBe(true);
		expect(isEntityType("frob")).toBe(false);
		// The fixed sets are non-empty + the right shape.
		expect(ENTITY_TYPES.length).toBeGreaterThan(10);
		expect(PROPOSAL_OPERATIONS).toContain("claim.supersede");
		expect(ASSERTION_PREDICATES).toContain("believes");
	});
});

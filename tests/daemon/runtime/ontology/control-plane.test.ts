/**
 * PRD-008c Ontology Control Plane — c-AC-1..7 (Wave 2).
 *
 * Verification posture (EXECUTION_LEDGER-prd-008 / ontology CONVENTIONS):
 *   - All assertions run against a FAKE DeepLake transport (`FakeDeepLakeTransport`)
 *     wrapped in a real `StorageClient`. No live network. No `.skip` / `.only`;
 *     `vitest run` is CI. The conflict-detection model seam is OFF here (the control
 *     plane uses no model — risk routing is deterministic over the proposal body).
 *   - Each `describe` block is named after the AC it proves (one-to-one ledger map).
 *   - The fake transport's `requests` array captures every SQL statement issued,
 *     letting us assert the exact write path, the scope on the wire, the escaping, and
 *     — critically — what is NOT written (no raw-artifact rewrite, no auto-promote).
 *
 * c-AC-1 Bounded explicit op → applies DIRECTLY + writes an applied proposal row;
 *         evidence copied onto the resulting attribute/dependency rows.
 * c-AC-2 Broad/risky/destructive/generated-batch → PENDING review queue, NOT applied.
 * c-AC-3 Structural change → raw source artifacts/transcripts NEVER rewritten.
 * c-AC-4 Supersede op → append-only version-bumped (supersedeClaim), NOT in-place.
 * c-AC-5 Epistemic assertion carries predicate/content/speaker/confidence/evidence/
 *         status; NO auto-promote into ontology truth.
 * c-AC-6 Proposal carries operation/status/jsonb payload/confidence/rationale/evidence/
 *         risk_note/provenance.
 * c-AC-7 CLI (`stream apply --dry-run`) scoped by org/workspace/agent; reports the plan
 *         WITHOUT mutating on dry-run.
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
	DIRECT_APPLY_CONFIDENCE_FLOOR,
	DIRECT_APPLY_OPERATIONS,
	planApply,
	recordAssertion,
	routeProposal,
	submitProposal,
} from "../../../../src/daemon/runtime/ontology/control-plane.js";
import {
	ontologyMain,
	parseOntologyArgs,
	runOntologyCommand,
} from "../../../../src/cli/ontology.js";
import {
	parseProposal,
	type Proposal,
} from "../../../../src/daemon/runtime/ontology/contracts.js";
import {
	FakeDeepLakeTransport,
	fakeCredentialRecord,
	stubProvider,
} from "../../../helpers/fake-deeplake.js";

// ── Scope fixture ─────────────────────────────────────────────────────────────

const SCOPE: QueryScope = { org: "test-org", workspace: "test-ws" };
const ACTOR = { agentId: "agent-alpha" };

// ── Storage builders ──────────────────────────────────────────────────────────

function storageWith(responder: (req: TransportRequest) => StorageRow[]): {
	storage: StorageQuery;
	transport: FakeDeepLakeTransport;
} {
	const transport = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ provider: stubProvider(fakeCredentialRecord()), transport });
	return { storage, transport };
}

/** Everything absent (probes miss) and every mutation succeeds — the "all new" world. */
function allNewResponder(): (req: TransportRequest) => StorageRow[] {
	return () => [];
}

/** Upper-cased SQL of every statement issued, for shape assertions. */
function sqlsOf(transport: FakeDeepLakeTransport): string[] {
	return transport.requests.map((r) => r.sql);
}

/** The mutating statements (INSERT / UPDATE / DELETE) issued. */
function mutationsOf(transport: FakeDeepLakeTransport): string[] {
	return sqlsOf(transport).filter((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s));
}

// ── Proposal fixtures ─────────────────────────────────────────────────────────

/** A bounded explicit `claim.add` op with evidence — the direct-apply happy path. */
function boundedClaimAdd(): Record<string, unknown> {
	return {
		operation: "claim.add",
		confidence: 0.9,
		rationale: "extracted a clear single fact",
		riskNote: "",
		payload: {
			aspectId: "asp-1",
			groupKey: "role",
			claimKey: "title",
			kind: "attribute",
			content: "Staff Engineer",
			memoryId: "mem-prov-1",
			confidence: 0.9,
			importance: 0.6,
		},
		provenance: { source: "cli", evidence: "mem-prov-1;transcript#42" },
	};
}

// ═════════════════════════════════════════════════════════════════════════════
// c-AC-1 — bounded explicit op applies directly + applied row + evidence-on-rows
// ═════════════════════════════════════════════════════════════════════════════

describe("c-AC-1 bounded explicit op applies directly + applied proposal row + lineage", () => {
	it("a bounded claim.add APPLIES + writes an `applied` proposal row + the attribute row", async () => {
		const { storage, transport } = storageWith(allNewResponder());

		const outcome = await submitProposal(storage, SCOPE, boundedClaimAdd(), ACTOR);

		expect(outcome.route).toBe("direct");
		expect(outcome.status).toBe("applied");
		expect(outcome.proposalId).not.toBe("");

		const sqls = sqlsOf(transport);
		// An `applied` ontology_proposals row was written …
		const proposalInsert = sqls.find(
			(s) => /INSERT/i.test(s) && /ontology_proposals/i.test(s),
		);
		expect(proposalInsert, "an ontology_proposals INSERT").toBeTruthy();
		expect(String(proposalInsert)).toContain("'applied'");
		// … and the bounded op APPLIED: an entity_attributes row was written.
		const attrInsert = sqls.find((s) => /INSERT/i.test(s) && /entity_attributes/i.test(s));
		expect(attrInsert, "an entity_attributes INSERT (the applied claim)").toBeTruthy();
	});

	it("the resulting attribute row + the applied proposal row together carry the lineage", async () => {
		// LINEAGE within the Wave-1 catalog (CONVENTIONS / supersede.ts header): the catalog
		// `entity_attributes` has NO first-class `source`/`proposal_id` columns, and those are
		// PRD-003 columns this Bee may not add. So the evidence lineage is carried by:
		//   (a) the resulting attribute row's `memory_id` — the evidence POINTER (a-AC-3); and
		//   (b) the append-only `applied` `ontology_proposals` row — the full evidence + the
		//       operation/slot that deterministically resolves the resulting row.
		// Together they make the lineage reconstructable and survive proposal archival.
		const { storage, transport } = storageWith(allNewResponder());

		const outcome = await submitProposal(storage, SCOPE, boundedClaimAdd(), ACTOR);

		const attrInsert = String(
			sqlsOf(transport).find((s) => /INSERT/i.test(s) && /entity_attributes/i.test(s)),
		);
		// (a) the evidence POINTER (the memory id) is on the resulting attribute row.
		expect(attrInsert).toContain("'mem-prov-1'");

		const proposalInsert = String(
			sqlsOf(transport).find((s) => /INSERT/i.test(s) && /ontology_proposals/i.test(s)),
		);
		// (b) the applied proposal row carries the FULL evidence + the same op + the slot that
		// resolves the resulting attribute — the durable lineage record.
		expect(proposalInsert).toContain(outcome.proposalId);
		expect(proposalInsert).toContain("mem-prov-1;transcript#42");
		expect(proposalInsert).toContain("'claim.add'");
		expect(proposalInsert.toLowerCase()).toContain("title"); // the claimKey, in the payload
	});

	it("the DIRECT_APPLY_OPERATIONS allow-list routes the bounded ops to direct", () => {
		for (const op of ["entity.create", "aspect.create", "claim.add", "claim.set", "claim.supersede"] as const) {
			expect(DIRECT_APPLY_OPERATIONS.has(op)).toBe(true);
		}
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// c-AC-2 — broad/risky/destructive/generated-batch → pending queue, not applied
// ═════════════════════════════════════════════════════════════════════════════

describe("c-AC-2 broad/risky/generated change enters the pending queue, NOT applied", () => {
	it("a non-bounded op (entity.merge) → pending; only the pending row, no apply", async () => {
		const { storage, transport } = storageWith(allNewResponder());

		const outcome = await submitProposal(
			storage,
			SCOPE,
			{
				operation: "entity.merge",
				confidence: 1,
				payload: { from: "ent-a", into: "ent-b" },
				provenance: { source: "cli", evidence: "mem-merge" },
			},
			ACTOR,
		);

		expect(outcome.route).toBe("pending");
		expect(outcome.status).toBe("pending");

		const muts = mutationsOf(transport);
		// EXACTLY one mutation: the pending proposal row. Nothing applied.
		expect(muts.length).toBe(1);
		expect(muts[0]).toMatch(/ontology_proposals/i);
		expect(muts[0]).toContain("'pending'");
		// No graph engine table was written.
		expect(muts.some((s) => /entity_attributes|entity_aspects|"entities"/i.test(s))).toBe(false);
	});

	it("a risk note on a bounded op forces the review queue (D-6)", async () => {
		const { storage, transport } = storageWith(allNewResponder());
		const risky = { ...boundedClaimAdd(), riskNote: "touches a load-bearing constraint" };

		const outcome = await submitProposal(storage, SCOPE, risky, ACTOR);

		expect(outcome.route).toBe("pending");
		expect(mutationsOf(transport).every((s) => /ontology_proposals/i.test(s))).toBe(true);
		expect(mutationsOf(transport).some((s) => /entity_attributes/i.test(s))).toBe(false);
	});

	it("a generated batch payload routes to review even for a bounded op", async () => {
		const batch = {
			...boundedClaimAdd(),
			payload: { ...boundedClaimAdd().payload, items: [{ a: 1 }, { a: 2 }, { a: 3 }] },
		};
		expect(routeProposal(parseRequired(batch)).route).toBe("pending");
		expect(routeProposal(parseRequired(batch)).reason).toBe("generated-batch");
	});

	it("a below-floor confidence routes a bounded op to review", () => {
		const lowConf = { ...boundedClaimAdd(), confidence: DIRECT_APPLY_CONFIDENCE_FLOOR - 0.1 };
		const decision = routeProposal(parseRequired(lowConf));
		expect(decision.route).toBe("pending");
		expect(decision.reason).toBe("confidence-below-floor");
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// c-AC-3 — a structural change NEVER rewrites raw source artifacts/transcripts
// ═════════════════════════════════════════════════════════════════════════════

describe("c-AC-3 a structural change never rewrites raw source artifacts/transcripts", () => {
	it("applying a bounded op touches NO sessions/source/memory table", async () => {
		const { storage, transport } = storageWith(allNewResponder());

		await submitProposal(storage, SCOPE, boundedClaimAdd(), ACTOR);

		const muts = mutationsOf(transport);
		expect(muts.length).toBeGreaterThan(0); // it DID apply something …
		// … but never a raw-artifact table. `sessions` holds raw transcripts; `memory`/
		// `memory_history` hold the source memories; `source` is the raw artifact table.
		for (const m of muts) {
			expect(/\bsessions\b/i.test(m), `no write to sessions: ${m}`).toBe(false);
			expect(/"sessions"|"source"|"memory"|"memory_history"/i.test(m), `no raw-artifact write: ${m}`).toBe(false);
			expect(/\bUPDATE\s+"?sessions/i.test(m)).toBe(false);
		}
		// The only tables written are the proposal audit row + graph engine tables.
		expect(muts.some((s) => /ontology_proposals/i.test(s))).toBe(true);
		expect(muts.some((s) => /entity_attributes/i.test(s))).toBe(true);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// c-AC-4 — a supersede op uses the append-only version-bump, not in-place
// ═════════════════════════════════════════════════════════════════════════════

describe("c-AC-4 supersede op append-only version-bumped via supersedeClaim, not in-place", () => {
	it("a claim.supersede APPENDS a new active version and APPEND-MARKS the prior superseded", async () => {
		// Responder: the prior active row exists at version 1, so the supersede path resolves
		// it, appends v2, and marks v1 superseded. The MAX(version) read returns {version:1};
		// the highest-active read returns the prior id.
		const PRIOR_ID = "attr_prior_v1";
		const responder = (req: TransportRequest): StorageRow[] => {
			const sql = req.sql.toUpperCase();
			// The highest-ACTIVE read (`… AND status = 'active' …`) is more specific than the
			// MAX(version) probe — match it FIRST so it returns the prior row id, not a version.
			if (sql.startsWith("SELECT") && sql.includes("STATUS") && sql.includes("ACTIVE")) {
				return [{ id: PRIOR_ID, version: 1, status: "active" }];
			}
			if (sql.startsWith("SELECT") && sql.includes("VERSION") && sql.includes("CLAIM_KEY")) {
				// MAX(version) probe → current high-water mark is 1.
				return [{ version: 1 }];
			}
			return [];
		};
		const { storage, transport } = storageWith(responder);

		const proposal = {
			operation: "claim.supersede",
			confidence: 0.95,
			riskNote: "",
			payload: {
				entityId: "ent-1",
				aspectId: "asp-1",
				groupKey: "role",
				claimKey: "title",
				kind: "attribute",
				content: "Principal Engineer",
				memoryId: "mem-super",
			},
			provenance: { source: "cli", evidence: "mem-super" },
		};

		const outcome = await submitProposal(storage, SCOPE, proposal, ACTOR);
		expect(outcome.route).toBe("direct");

		const muts = mutationsOf(transport);
		// The supersede path is APPEND-ONLY: NO in-place UPDATE (a by-id SET does not
		// converge on the real backend — c-AC-4).
		expect(muts.some((s) => /^\s*UPDATE/i.test(s))).toBe(false);
		// An APPEND (INSERT) of the new active version into entity_attributes …
		const inserts = muts.filter((s) => /INSERT/i.test(s) && /entity_attributes/i.test(s));
		expect(inserts.some((s) => /'active'/.test(s))).toBe(true);
		// … and the prior sibling APPEND-MARKED superseded — a SEPARATE INSERT carrying the
		// SAME prior id, status='superseded', and superseded_by (its highest version reads
		// superseded; the prior's original active row stays intact on disk).
		const mark = inserts.find((s) => /'superseded'/.test(s));
		expect(mark, "the prior was append-marked superseded").toBeTruthy();
		expect(String(mark)).toContain(PRIOR_ID);
		expect(String(mark)).toContain("superseded_by");
		// The mark is an INSERT, so it never carries a `content = …` SET clause.
		expect(/\bcontent\b\s*=/i.test(String(mark))).toBe(false);
	});

	it("the new active version carries the supersede content as an append (not an update of the prior)", async () => {
		const responder = (req: TransportRequest): StorageRow[] => {
			const sql = req.sql.toUpperCase();
			if (sql.startsWith("SELECT") && sql.includes("ACTIVE")) return [{ id: "attr_prior_v1" }];
			if (sql.startsWith("SELECT") && sql.includes("VERSION") && sql.includes("CLAIM_KEY")) return [{ version: 1 }];
			return [];
		};
		const { storage, transport } = storageWith(responder);
		await submitProposal(
			storage,
			SCOPE,
			{
				operation: "claim.supersede",
				confidence: 0.95,
				payload: { entityId: "e", aspectId: "asp-1", groupKey: "g", claimKey: "c", content: "New", memoryId: "m" },
				provenance: { source: "cli", evidence: "m" },
			},
			ACTOR,
		);
		const append = String(
			mutationsOf(transport).find((s) => /INSERT/i.test(s) && /entity_attributes/i.test(s)),
		);
		// The new content lands on a fresh APPEND with status active.
		expect(append).toContain("'active'");
		expect(append.toLowerCase()).toContain("new");
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// c-AC-5 — epistemic assertion fields + NO auto-promote into ontology truth
// ═════════════════════════════════════════════════════════════════════════════

describe("c-AC-5 epistemic assertion carries the full shape + does not auto-promote", () => {
	it("records an epistemic_assertions row with predicate/content/speaker/confidence/evidence/status", async () => {
		const { storage, transport } = storageWith(allNewResponder());

		const assertion = await recordAssertion(
			storage,
			SCOPE,
			{
				predicate: "believes",
				content: "the migration will finish this quarter",
				speaker: "alex",
				confidence: 0.7,
				evidence: "mem-belief-1",
				status: "active",
				claimKey: "ck_optional_link",
			},
			ACTOR,
		);

		expect(assertion).not.toBeNull();
		const insert = String(
			sqlsOf(transport).find((s) => /INSERT/i.test(s) && /epistemic_assertions/i.test(s)),
		);
		expect(insert, "an epistemic_assertions INSERT").toBeTruthy();
		// predicate preserved verbatim + mapped onto the catalog stance (believes→believed).
		expect(insert).toContain("'believes'");
		expect(insert).toContain("'believed'");
		// speaker (subject), content (object), confidence, evidence (provenance), status.
		expect(insert.toLowerCase()).toContain("alex");
		expect(insert.toLowerCase()).toContain("the migration will finish this quarter");
		expect(insert).toContain("'mem-belief-1'");
		expect(insert).toContain("'active'");
		// The optional claim link rides the row but stays a separate layer.
		expect(insert).toContain("'ck_optional_link'");
	});

	it("recording an assertion NEVER writes a claim (entity_attributes) — no auto-promote (FR-8)", async () => {
		const { storage, transport } = storageWith(allNewResponder());

		await recordAssertion(
			storage,
			SCOPE,
			{ predicate: "claims", content: "X is true", speaker: "alice", evidence: "m", claimKey: "ck_x" },
			ACTOR,
		);

		// The assertion layer is parallel: no entity_attributes / ontology_proposals write.
		expect(mutationsOf(transport).some((s) => /entity_attributes/i.test(s))).toBe(false);
		expect(mutationsOf(transport).some((s) => /ontology_proposals/i.test(s))).toBe(false);
		// It DID write the assertion layer.
		expect(mutationsOf(transport).some((s) => /epistemic_assertions/i.test(s))).toBe(true);
	});

	it("a malformed assertion is dropped at the boundary (null, no write)", async () => {
		const { storage, transport } = storageWith(allNewResponder());
		// Missing the required `speaker` + `content`.
		const out = await recordAssertion(storage, SCOPE, { predicate: "believes" }, ACTOR);
		expect(out).toBeNull();
		expect(mutationsOf(transport).length).toBe(0);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// c-AC-6 — the proposal row carries the full audit record
// ═════════════════════════════════════════════════════════════════════════════

describe("c-AC-6 proposal carries operation/status/payload/confidence/rationale/evidence/risk_note/provenance", () => {
	it("the recorded ontology_proposals row carries every audit field", async () => {
		const { storage, transport } = storageWith(allNewResponder());

		await submitProposal(storage, SCOPE, boundedClaimAdd(), ACTOR);

		const insert = String(
			sqlsOf(transport).find((s) => /INSERT/i.test(s) && /ontology_proposals/i.test(s)),
		);
		// operation, status, payload (jsonb), confidence, rationale, evidence, risk_note, agent.
		expect(insert).toContain("operation");
		expect(insert).toContain("'claim.add'");
		expect(insert).toContain("status");
		expect(insert).toContain("payload");
		// The JSONB payload body is serialized onto the row.
		expect(insert.toLowerCase()).toContain("staff engineer");
		expect(insert).toContain("confidence");
		expect(insert).toContain("rationale");
		expect(insert.toLowerCase()).toContain("extracted a clear single fact");
		expect(insert).toContain("evidence");
		expect(insert).toContain("mem-prov-1;transcript#42");
		expect(insert).toContain("risk_note");
		// Source provenance + agent scope (D-2).
		expect(insert).toContain("agent_id");
		expect(insert).toContain("'agent-alpha'");
	});

	it("a malformed proposal is a `failed` outcome recorded NOWHERE (boundary drop)", async () => {
		const { storage, transport } = storageWith(allNewResponder());
		// `operation` not in the enum.
		const outcome = await submitProposal(storage, SCOPE, { operation: "frobnicate" }, ACTOR);
		expect(outcome.status).toBe("failed");
		expect(outcome.proposalId).toBe("");
		expect(mutationsOf(transport).length).toBe(0);
	});

	it("the partition (org/workspace) reaches the wire on every statement (scope discipline)", async () => {
		const { storage, transport } = storageWith(allNewResponder());
		await submitProposal(storage, SCOPE, boundedClaimAdd(), ACTOR);
		expect(transport.requests.length).toBeGreaterThan(0);
		for (const req of transport.requests) {
			expect(req.org).toBe("test-org");
			expect(req.workspace).toBe("test-ws");
		}
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// c-AC-7 — CLI stream apply --dry-run scoped + non-mutating
// ═════════════════════════════════════════════════════════════════════════════

describe("c-AC-7 CLI stream apply --dry-run scoped by org/workspace/agent, no mutation", () => {
	it("parses scope flags + the proposal body off the argv tail", () => {
		const inv = parseOntologyArgs([
			"stream",
			"apply",
			"--dry-run",
			"--org",
			"acme",
			"--workspace",
			"main",
			"--agent",
			"agent-7",
			"--proposal",
			JSON.stringify(boundedClaimAdd()),
		]);
		expect(inv.path).toEqual(["stream", "apply"]);
		expect(inv.dryRun).toBe(true);
		expect(inv.scope).toEqual({ org: "acme", workspace: "main", agentId: "agent-7" });
		expect((inv.proposal as Record<string, unknown>).operation).toBe("claim.add");
	});

	it("the dry-run reports the plan scoped by org/workspace/agent WITHOUT mutating", () => {
		const lines: string[] = [];
		// Drive the REAL daemon planApply through the CLI — pure, takes no storage.
		const result = ontologyMain(
			[
				"stream",
				"apply",
				"--dry-run",
				"--org",
				"acme",
				"--workspace",
				"main",
				"--agent",
				"agent-7",
				"--proposal",
				JSON.stringify(boundedClaimAdd()),
			],
			planApply,
			(l) => lines.push(l),
		);

		expect(result.exitCode).toBe(0);
		expect(result.mutated).toBe(false);
		const text = lines.join("\n");
		// Scoped by org/workspace/agent (c-AC-7).
		expect(text).toContain("org=acme");
		expect(text).toContain("workspace=main");
		expect(text).toContain("agent=agent-7");
		// It reported a DIRECT plan (the bounded op) without applying.
		expect(text).toContain("route: direct");
		expect(text).toContain("dry-run: NO mutation issued.");
	});

	it("the dry-run NEVER touches storage — planApply is structurally storage-free", () => {
		// If the dry-run reached the backend it would need a transport; planApply takes
		// none. We additionally assert that running the dry-run through a storage-backed
		// path is impossible by construction: the plan builder's arity is (scope, candidate,
		// actor) — there is no storage parameter.
		expect(planApply.length).toBe(2); // (scope, candidate) required; actor defaulted.
		const plan = planApply(SCOPE, boundedClaimAdd(), ACTOR);
		expect(plan.route).toBe("direct");
		expect(plan.scope).toEqual({ org: "test-org", workspace: "test-ws", agentId: "agent-alpha" });
	});

	it("a dry-run for a risky proposal reports the PENDING route + reason, still non-mutating", () => {
		const lines: string[] = [];
		const result = runOntologyCommand(
			parseOntologyArgs([
				"stream",
				"apply",
				"--dry-run",
				"--org",
				"o",
				"--workspace",
				"w",
				"--agent",
				"a",
				"--proposal",
				JSON.stringify({ ...boundedClaimAdd(), riskNote: "destructive" }),
			]),
			planApply,
			(l) => lines.push(l),
		);
		expect(result.mutated).toBe(false);
		const text = lines.join("\n");
		expect(text).toContain("route: pending");
		expect(text).toContain("risk-note-present");
	});

	it("a live `stream apply` (no --dry-run) is REFUSED here (routes through the daemon)", () => {
		const lines: string[] = [];
		const result = runOntologyCommand(
			parseOntologyArgs(["stream", "apply", "--org", "o", "--agent", "a"]),
			planApply,
			(l) => lines.push(l),
		);
		expect(result.mutated).toBe(false);
		expect(result.exitCode).toBe(2);
		expect(lines.join("\n")).toContain("requires --dry-run");
	});
});

// ── Boundary helper ───────────────────────────────────────────────────────────

/**
 * Validate a fixture proposal through the SAME boundary the control plane uses, so the
 * routing unit tests operate on a real {@link Proposal}. Throws if the fixture is itself
 * malformed (a test bug, not a product path).
 */
function parseRequired(candidate: unknown): Proposal {
	const p = parseProposal(candidate);
	if (p === null) throw new Error("test fixture proposal is malformed");
	return p;
}

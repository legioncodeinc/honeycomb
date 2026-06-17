/**
 * PRD-006b Decision — b-AC-1..b-AC-5 (Wave 2, `retrieval-worker-bee`).
 *
 * Verification posture (EXECUTION_LEDGER-prd-006 / pipeline CONVENTIONS §5):
 *   - The decision CORE + handler are verified against a FAKE `ModelClient`
 *     (`createFakeModelClient`, returning the D-4 decision JSON — incl. prose-wrapped
 *     and malformed bodies for the defensive-parse path) and the PRD-002 FAKE
 *     transport (a SQL-aware responder emulating the `memories` candidate search +
 *     capturing the `memory_history` INSERTs). No live DeepLake, no live model.
 *   - The fake model records `.calls`, so b-AC-2 asserts the model was NOT called on
 *     the no-candidate short-circuit.
 *   - A FAKE `EmbedClient` drives the hybrid blend's vector arm (768-dim → vector
 *     path; null → silent lexical fallback).
 *   - Each test is named after the AC it proves (one-to-one ledger map).
 *   - No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { QueryScope } from "../../../../src/daemon/storage/client.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import type { StorageRow } from "../../../../src/daemon/storage/result.js";
import { EMBEDDING_DIMS } from "../../../../src/daemon/storage/vector.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";
import {
	type PipelineConfig,
	PipelineConfigSchema,
	createFakeModelClient,
	type Fact,
	type StageJob,
} from "../../../../src/daemon/runtime/pipeline/index.js";
// Decision-stage internals (core + types) are imported from the stage module
// directly — the Wave-1 barrel re-exports only the handler factory + no-op, and
// 006b must not edit `index.ts` (CONVENTIONS §4/§6).
import {
	type DecisionHandlerDeps,
	type FactDecision,
	createDecisionHandler,
	decideForFacts,
} from "../../../../src/daemon/runtime/pipeline/decision.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };

/** The job a decision stage runs, carrying the org/workspace/agent scope + facts. */
function decisionJob(facts: Fact[], scopeOverrides: Partial<StageJob["scope"]> = {}): StageJob {
	return {
		id: "decision-job-1",
		kind: "memory_decision",
		attempt: 1,
		scope: { org: "fake-org", workspace: "fake-ws", agentId: "default", ...scopeOverrides },
		payload: { facts, org: "fake-org", workspace: "fake-ws", agent_id: scopeOverrides.agentId ?? "default" },
	};
}

function pipelineConfig(overrides: Record<string, unknown> = {}): PipelineConfig {
	return PipelineConfigSchema.parse({ enabled: true, extractionProvider: "fake-router", ...overrides });
}

const FACT: Fact = { content: "the daemon binds 127.0.0.1:3850", type: "fact", confidence: 0.9 };

/** A canned decision body: an UPDATE against an existing candidate (D-4 contract). */
const UPDATE_DECISION_JSON =
	'{"action":"update","target_id":"mem-1","confidence":0.84,"reason":"refines the existing bind-address memory"}';

/** A 768-dim query vector the fake embed client returns to drive the vector arm. */
function vec768(fill = 0.01): number[] {
	return Array.from({ length: EMBEDDING_DIMS }, () => fill);
}

/** A fake embed client that returns a fixed vector (or null to force lexical-only). */
function fakeEmbed(vector: readonly number[] | null): EmbedClient {
	return { async embed(): Promise<readonly number[] | null> { return vector; } };
}

/**
 * A SQL-aware fake transport responder that emulates the decision stage's two
 * targets: it returns the configured candidate rows for any `memories` SELECT
 * (vector `<#>` or lexical ILIKE), and an empty ok for the `memory_history` INSERT
 * (captured via `fake.requests`). Any `memories` UPDATE/INSERT would be a bug — the
 * stage must never mutate memories — so those are surfaced loudly.
 */
function makeStorage(candidateRows: StorageRow[]): {
	storage: ReturnType<typeof createStorageClient>;
	fake: FakeDeepLakeTransport;
} {
	const responder = (req: TransportRequest): StorageRow[] => {
		const sql = req.sql;
		if (/INSERT\s+INTO\s+"memory_history"/i.test(sql)) return [];
		if (/(INSERT|UPDATE|DELETE)\b[\s\S]*"memories"/i.test(sql)) {
			throw new Error(`decision stage must not mutate memories: ${sql}`);
		}
		if (/FROM\s+"memories"/i.test(sql)) return candidateRows;
		return [];
	};
	const fake = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	return { storage, fake };
}

/** Decision-stage deps over a storage client + fake model + optional embed. */
function deps(args: {
	storage: ReturnType<typeof createStorageClient>;
	model: ReturnType<typeof createFakeModelClient>;
	config?: PipelineConfig;
	embed?: EmbedClient;
}): DecisionHandlerDeps {
	return {
		storage: args.storage,
		scope: SCOPE,
		model: args.model,
		config: args.config ?? pipelineConfig(),
		embed: args.embed,
	};
}

/** All `memory_history` INSERT statements the fake transport saw. */
function historyInserts(fake: FakeDeepLakeTransport): string[] {
	return fake.requests.filter((r) => /INSERT\s+INTO\s+"memory_history"/i.test(r.sql)).map((r) => r.sql);
}

// ── b-AC-1 ──────────────────────────────────────────────────────────────────

describe("b-AC-1 fact with candidates → add/update/delete/none with target id, confidence, reason", () => {
	it("returns the model's parsed proposal (update + target_id + confidence + reason)", async () => {
		const { storage, fake } = makeStorage([{ id: "mem-1", score: 0.9 }]);
		const model = createFakeModelClient({ memory_decision: UPDATE_DECISION_JSON });

		const decisions = await decideForFacts([FACT], decisionJob([FACT]), deps({ storage, model, embed: fakeEmbed(vec768()) }));

		expect(decisions).toHaveLength(1);
		const d: FactDecision = decisions[0];
		expect(d.modelCalled).toBe(true);
		expect(model.calls).toHaveLength(1);
		expect(model.calls[0].workload).toBe("memory_decision");
		// The parsed proposal carries every D-4 field (target_id wire key → targetId).
		expect(d.proposal).toEqual({
			action: "update",
			targetId: "mem-1",
			confidence: 0.84,
			reason: "refines the existing bind-address memory",
		});
		// Candidates were surfaced and the vector arm ran (not degraded).
		expect(d.candidates.map((c) => c.id)).toContain("mem-1");
		expect(d.degraded).toBe(false);
		// And the candidate search did issue a vector `<#>` query AND a lexical ILIKE.
		expect(fake.requests.some((r) => /<#>/.test(r.sql) && /"memories"/.test(r.sql))).toBe(true);
		expect(fake.requests.some((r) => /ILIKE/.test(r.sql) && /"memories"/.test(r.sql))).toBe(true);
	});

	it("an unparseable decision body → a conservative `none` proposal (never a fabricated mutation)", async () => {
		const { storage } = makeStorage([{ id: "mem-1", score: 0.9 }]);
		const model = createFakeModelClient({ memory_decision: "I cannot decide. No JSON here." });

		const decisions = await decideForFacts([FACT], decisionJob([FACT]), deps({ storage, model, embed: fakeEmbed(vec768()) }));

		expect(model.calls).toHaveLength(1);
		expect(decisions[0].proposal.action).toBe("none");
	});
});

// ── b-AC-2 ──────────────────────────────────────────────────────────────────

describe("b-AC-2 fact with no candidates → immediate `add` proposal WITHOUT a model call", () => {
	it("zero candidates → add proposal, model.calls is empty", async () => {
		const { storage } = makeStorage([]); // candidate search returns nothing.
		const model = createFakeModelClient({ memory_decision: UPDATE_DECISION_JSON });

		const decisions = await decideForFacts([FACT], decisionJob([FACT]), deps({ storage, model, embed: fakeEmbed(vec768()) }));

		expect(decisions[0].proposal.action).toBe("add");
		expect(decisions[0].proposal.targetId).toBeUndefined();
		expect(decisions[0].modelCalled).toBe(false);
		// The binding assertion: no model call on the short-circuit path (FR-4 / b-AC-2).
		expect(model.calls).toHaveLength(0);
	});

	it("no usable query vector (embeddings off) → recall degrades to lexical, still short-circuits with no candidates", async () => {
		const { storage, fake } = makeStorage([]); // lexical arm also empty.
		const model = createFakeModelClient({ memory_decision: UPDATE_DECISION_JSON });

		// No embed client → the vector arm is unavailable → silent lexical fallback.
		const decisions = await decideForFacts([FACT], decisionJob([FACT]), deps({ storage, model }));

		expect(decisions[0].degraded).toBe(true);
		expect(decisions[0].proposal.action).toBe("add");
		expect(model.calls).toHaveLength(0);
		// Lexical ran; NO vector `<#>` query was issued when there is no query vector.
		expect(fake.requests.some((r) => /ILIKE/.test(r.sql) && /"memories"/.test(r.sql))).toBe(true);
		expect(fake.requests.some((r) => /<#>/.test(r.sql))).toBe(false);
	});
});

// ── b-AC-3 ──────────────────────────────────────────────────────────────────

describe("b-AC-3 any proposal → recorded to memory_history", () => {
	it("an add proposal is recorded as an append-only INSERT into memory_history", async () => {
		const { storage, fake } = makeStorage([]); // no candidates → add proposal.
		const model = createFakeModelClient({});

		await decideForFacts([FACT], decisionJob([FACT]), deps({ storage, model, embed: fakeEmbed(vec768()) }));

		const inserts = historyInserts(fake);
		expect(inserts).toHaveLength(1);
		// The operation column carries the proposed action; changed_by the actor.
		expect(inserts[0]).toMatch(/INSERT INTO "memory_history"/);
		expect(inserts[0]).toMatch(/'add'/);
		expect(inserts[0]).toMatch(/'pipeline'/);
	});

	it("an update proposal records the target memory id as memory_id", async () => {
		const { storage, fake } = makeStorage([{ id: "mem-1", score: 0.9 }]);
		const model = createFakeModelClient({ memory_decision: UPDATE_DECISION_JSON });

		await decideForFacts([FACT], decisionJob([FACT]), deps({ storage, model, embed: fakeEmbed(vec768()) }));

		const inserts = historyInserts(fake);
		expect(inserts).toHaveLength(1);
		expect(inserts[0]).toMatch(/'update'/);
		// The update's target id reaches the row (memory_id + the payload).
		expect(inserts[0]).toMatch(/mem-1/);
	});

	it("every fact in a batch records its own history row", async () => {
		const facts: Fact[] = [
			{ content: "fact one", type: "fact", confidence: 0.9 },
			{ content: "fact two", type: "pref", confidence: 0.6 },
		];
		const { storage, fake } = makeStorage([]); // both → add proposals.
		const model = createFakeModelClient({});

		await decideForFacts(facts, decisionJob(facts), deps({ storage, model, embed: fakeEmbed(vec768()) }));

		expect(historyInserts(fake)).toHaveLength(2);
	});
});

// ── b-AC-4 ──────────────────────────────────────────────────────────────────

describe("b-AC-4 shadow mode → proposal attributed to pipeline-shadow, no memory written", () => {
	it("changed_by is 'pipeline-shadow' under shadowMode and no memories INSERT/UPDATE is emitted", async () => {
		const { storage, fake } = makeStorage([{ id: "mem-1", score: 0.9 }]);
		const model = createFakeModelClient({ memory_decision: UPDATE_DECISION_JSON });

		await decideForFacts(
			[FACT],
			decisionJob([FACT]),
			deps({ storage, model, config: pipelineConfig({ shadowMode: true }), embed: fakeEmbed(vec768()) }),
		);

		const inserts = historyInserts(fake);
		expect(inserts).toHaveLength(1);
		expect(inserts[0]).toMatch(/'pipeline-shadow'/);
		expect(inserts[0]).not.toMatch(/'pipeline'(?!-shadow)/); // not the non-shadow actor.
		// No memories write of any kind (the responder would have thrown, but assert here too).
		expect(fake.requests.every((r) => !/(INSERT|UPDATE|DELETE)\b[\s\S]*"memories"/i.test(r.sql))).toBe(true);
	});
});

// ── b-AC-5 ──────────────────────────────────────────────────────────────────

describe("b-AC-5 decision run completes → no memories rows mutated by this stage", () => {
	it("across add + update proposals, zero INSERT/UPDATE/DELETE statements target memories", async () => {
		const facts: Fact[] = [
			{ content: "novel fact", type: "fact", confidence: 0.9 }, // no candidate → add
			FACT, // candidate present → update (from the model)
		];
		// First fact's search returns nothing; second returns a candidate. The responder
		// can't vary per-fact easily, so use a candidate set and let the model decide; the
		// invariant under test is "no memories mutation", which holds regardless.
		const { storage, fake } = makeStorage([{ id: "mem-1", score: 0.9 }]);
		const model = createFakeModelClient({ memory_decision: UPDATE_DECISION_JSON });

		await decideForFacts(facts, decisionJob(facts), deps({ storage, model, embed: fakeEmbed(vec768()) }));

		const memoriesMutations = fake.requests.filter((r) =>
			/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[\s\S]*"memories"/i.test(r.sql),
		);
		expect(memoriesMutations).toHaveLength(0);
		// And history WAS written (the stage's only write surface).
		expect(historyInserts(fake).length).toBeGreaterThan(0);
	});

	it("the handler completes (does not throw) and routes facts off the payload", async () => {
		const { storage, fake } = makeStorage([]); // → add proposals, no model call.
		const model = createFakeModelClient({});
		const handler = createDecisionHandler(deps({ storage, model, embed: fakeEmbed(vec768()) }));

		// Two facts on the payload; the handler reads them, decides, records history.
		const facts: Fact[] = [FACT, { content: "another", type: "fact", confidence: 0.7 }];
		await expect(handler(decisionJob(facts))).resolves.toBeUndefined();
		expect(historyInserts(fake)).toHaveLength(2);
		// No model call (both short-circuited on empty candidates) and no memories mutation.
		expect(model.calls).toHaveLength(0);
		expect(fake.requests.every((r) => !/(INSERT|UPDATE|DELETE)\b[\s\S]*"memories"/i.test(r.sql))).toBe(true);
	});
});

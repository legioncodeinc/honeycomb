/**
 * PRD-007d Shaping — d-AC-1..7 (Wave 2, `retrieval-worker-bee`).
 *
 * Verification posture (EXECUTION_LEDGER-prd-007 / recall CONVENTIONS):
 *   - Shaping ranking quality is verified with a FAKE metadata source (per-candidate
 *     currentness/hub/resolution/rehearsal facts) and a FAKE reranker (blended +
 *     timeout-safe), plus a FAKE DeepLake transport for the storage-backed metadata
 *     source SQL (IDs-only, scoped, escaped). No live DeepLake, no live reranker.
 *   - The reranker-timeout AC uses Vitest FAKE timers to drive the 300ms race
 *     deterministically (d-AC-2) — Promise.race against a fake timer.
 *   - Each test is named after the AC it proves (one-to-one ledger map).
 *   - No `.skip` / `.only`; `vitest run` is CI.
 *   - Shaping runs STRICTLY on the authorized pool — no test introduces an id the
 *     pool did not already carry (d-AC-7).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import type { StorageRow } from "../../../../src/daemon/storage/result.js";
import { RecallConfigSchema, type RecallConfig } from "../../../../src/daemon/runtime/recall/config.js";
import { buildScopeClause } from "../../../../src/daemon/runtime/recall/scope-clause.js";
import type { Candidate, RecallChannel, RecallQuery } from "../../../../src/daemon/runtime/recall/contracts.js";
import type { AuthorizedPool } from "../../../../src/daemon/runtime/recall/authorization.js";
import type { RecallPhaseDeps } from "../../../../src/daemon/runtime/recall/engine.js";
import {
	type CandidateMetadata,
	type Reranker,
	type ShapingMetadataSource,
	createShapingPhase,
	createStorageMetadataSource,
} from "../../../../src/daemon/runtime/recall/shaping.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const ORG_SCOPE = { org: "fake-org", workspace: "fake-ws" } as const;

function recallConfig(overrides: Record<string, unknown> = {}): RecallConfig {
	return RecallConfigSchema.parse(overrides);
}

function recallQuery(query = "how does the daemon bind its socket"): RecallQuery {
	return {
		query,
		scope: { org: "fake-org", workspace: "fake-ws", agentId: "agent-1", readPolicy: "isolated", policyGroup: "" },
	};
}

/** A candidate with the given per-channel scores + provenance derived from them. */
function candidate(id: string, scores: Partial<Record<RecallChannel, number>>): Candidate {
	const provenance = (Object.keys(scores) as RecallChannel[]).filter((ch) => scores[ch] !== undefined);
	return { id, scores, provenance };
}

/** An authorized pool wrapping the candidates with a real compiled scope clause. */
function authorizedPool(candidates: Candidate[], degraded = false): AuthorizedPool {
	const clause = buildScopeClause({ agentId: "agent-1", readPolicy: "isolated", policyGroup: "", org: "fake-org", workspace: "fake-ws" });
	return {
		candidates,
		degraded,
		context: { clause, scope: recallQuery().scope },
	};
}

/** The phase deps a shaping run needs (storage unused when a fake metadata source is injected). */
function phaseDeps(args: { storage?: ReturnType<typeof createStorageClient>; config?: RecallConfig } = {}): RecallPhaseDeps {
	return {
		storage: args.storage ?? makeStorage(() => []).storage,
		scope: ORG_SCOPE,
		config: args.config ?? recallConfig(),
	};
}

/** A fixed-map fake metadata source (per-candidate currentness/hub/resolution/rehearsal). */
function fakeMetadata(map: Record<string, CandidateMetadata>): ShapingMetadataSource {
	return {
		async resolve(): Promise<Map<string, CandidateMetadata>> {
			return new Map(Object.entries(map));
		},
	};
}

/** A SQL-aware fake transport for the storage-backed metadata source tests. */
function makeStorage(responder: (req: TransportRequest) => StorageRow[]): {
	storage: ReturnType<typeof createStorageClient>;
	fake: FakeDeepLakeTransport;
} {
	const fake = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	return { storage, fake };
}

// ── d-AC-1 ──────────────────────────────────────────────────────────────────

describe("d-AC-1 convolution: no single channel dominates; facet coverage prefers broader", () => {
	it("a graph-only hit cannot out-rank a candidate FTS and vector both agree on", async () => {
		// `graphOnly` has ONE very strong traversal channel; `broad` has TWO moderate
		// channels (fts + vector). Convolution must rank the broader-covering candidate first.
		const pool = authorizedPool([
			candidate("graphOnly", { traversal: 0.99 }),
			candidate("broad", { fts: 0.6, vector: 0.6 }),
		]);
		const shape = createShapingPhase({}); // empty metadata, no rerank → pure convolution.
		const shaped = await shape(pool, recallQuery(), phaseDeps());
		expect(shaped.candidates[0]?.id).toBe("broad");
		// The lone strong channel did NOT dominate.
		const graph = shaped.candidates.find((c) => c.id === "graphOnly");
		const broad = shaped.candidates.find((c) => c.id === "broad");
		expect(broad!.calibratedScore).toBeGreaterThan(graph!.calibratedScore);
	});

	it("between two equal-mean candidates, broader facet coverage wins (FR-2)", async () => {
		// Same mean (0.7), but `wide` covers 3 channels and `narrow` covers 1.
		const pool = authorizedPool([
			candidate("narrow", { vector: 0.7 }),
			candidate("wide", { fts: 0.7, vector: 0.7, traversal: 0.7 }),
		]);
		const shaped = await createShapingPhase({})(pool, recallQuery(), phaseDeps());
		expect(shaped.candidates[0]?.id).toBe("wide");
	});
});

// ── d-AC-2 ──────────────────────────────────────────────────────────────────

describe("d-AC-2 reranker timeout → keep original order, not failure", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("a reranker that never resolves within the timeout keeps the pre-rerank order and never throws", async () => {
		vi.useFakeTimers();
		// A reranker that would REVERSE the order — but it hangs past the timeout.
		const hangingReranker: Reranker = {
			rerank() {
				return new Promise(() => {
					/* never resolves → must time out */
				});
			},
		};
		const pool = authorizedPool([
			candidate("a", { fts: 0.9, vector: 0.9 }),
			candidate("b", { fts: 0.2 }),
		]);
		const deps = phaseDeps({ config: recallConfig({ reranker: { strategy: "embedding-cosine", timeoutMs: 300 } }) });
		const shapePromise = createShapingPhase({ reranker: hangingReranker })(pool, recallQuery(), deps);
		// Advance past the 300ms reranker timeout so the race resolves to "timeout".
		await vi.advanceTimersByTimeAsync(301);
		const shaped = await shapePromise;
		// Original (convolved) order preserved: `a` (strong, broad) outranks `b`.
		expect(shaped.candidates.map((c) => c.id)).toEqual(["a", "b"]);
		expect(shaped.candidates).toHaveLength(2);
	});

	it("a reranker that resolves in time blends its score (does not fail, does not replace)", async () => {
		const blendingReranker: Reranker = {
			async rerank(_q, cands) {
				// Push every candidate to a high cosine — blended 50/50 with the pre-rerank score.
				return cands.map((c) => ({ id: c.id, score: 1 }));
			},
		};
		const pool = authorizedPool([candidate("a", { fts: 0.4, vector: 0.4 })]);
		const shaped = await createShapingPhase({ reranker: blendingReranker })(pool, recallQuery(), phaseDeps());
		// Blended = 0.5*pre + 0.5*1 — strictly between the pre-rerank score and 1 (not replaced).
		const pre = shaped.candidates[0]!.calibratedScore;
		expect(pre).toBeGreaterThan(0.4); // lifted by the rerank blend.
		expect(pre).toBeLessThan(1); // but not replaced outright.
	});
});

// ── d-AC-3 ──────────────────────────────────────────────────────────────────

describe("d-AC-3 superseded claim → downweighted (group_key+claim_key) so current value outranks", () => {
	it("the superseded value is ranked below its current sibling in the same claim slot", async () => {
		// `current` and `stale` start with identical evidence; only `stale` is superseded.
		const pool = authorizedPool([
			candidate("current", { fts: 0.7, vector: 0.7 }),
			candidate("stale", { fts: 0.7, vector: 0.7 }),
		]);
		const metadata = fakeMetadata({ stale: { superseded: true } });
		const shaped = await createShapingPhase({ metadata })(pool, recallQuery(), phaseDeps());
		expect(shaped.candidates[0]?.id).toBe("current");
		const current = shaped.candidates.find((c) => c.id === "current");
		const stale = shaped.candidates.find((c) => c.id === "stale");
		expect(stale!.calibratedScore).toBeLessThan(current!.calibratedScore);
	});

	it("the superseded-claims SQL is IDs-only, scoped by group_key+claim_key+status, and routes ids through sLiteral", async () => {
		const { storage, fake } = makeStorage((req) => {
			// memories metadata SELECT → no rows; superseded SELECT → one stale id.
			if (/FROM\s+"entity_attributes"/i.test(req.sql)) return [{ id: "stale", group_key: "g1", claim_key: "c1" }];
			return [];
		});
		const source = createStorageMetadataSource(storage);
		const pool = authorizedPool([candidate("stale", { fts: 0.7 }), candidate("fresh", { fts: 0.7 })]);
		const shaped = await createShapingPhase({ metadata: source })(pool, recallQuery(), phaseDeps({ storage }));
		// The superseded `stale` is downweighted below `fresh`.
		expect(shaped.candidates[0]?.id).toBe("fresh");
		const supSql = fake.requests.find((r) => /FROM\s+"entity_attributes"/i.test(r.sql))?.sql ?? "";
		expect(supSql).toMatch(/status = 'superseded'/);
		expect(supSql).toMatch(/group_key/);
		expect(supSql).toMatch(/claim_key/);
		// IDs only — no content column projected.
		expect(supSql).not.toMatch(/\bcontent\b/i);
		// The id IN-list routes through sLiteral (quoted literals).
		expect(supSql).toMatch(/IN \('stale', 'fresh'\)/);
		// The scope clause (the auth chokepoint) is ANDed in: agent_id + is_deleted.
		expect(supSql).toMatch(/agent_id = 'agent-1'/);
	});
});

// ── d-AC-4 ──────────────────────────────────────────────────────────────────

describe("d-AC-4 semantic hit sharing no query terms → gravity-dampened", () => {
	it("a vector-only candidate with no lexical corroboration is penalized vs an FTS-corroborated one", async () => {
		// `offTopic` rode in ONLY on the vector channel (semantic gravity, no shared terms);
		// `onTopic` matched the query text (fts) too. Same raw scores.
		const pool = authorizedPool([
			candidate("offTopic", { vector: 0.8 }),
			candidate("onTopic", { fts: 0.8, vector: 0.8 }),
		]);
		const config = recallConfig({ dampening: { gravity: 0.3 } });
		const shaped = await createShapingPhase({})(pool, recallQuery(), phaseDeps({ config }));
		expect(shaped.candidates[0]?.id).toBe("onTopic");
		const off = shaped.candidates.find((c) => c.id === "offTopic");
		const on = shaped.candidates.find((c) => c.id === "onTopic");
		expect(off!.calibratedScore).toBeLessThan(on!.calibratedScore);
	});
});

// ── d-AC-5 ──────────────────────────────────────────────────────────────────

describe("d-AC-5 result off a very high-degree entity → hub-dampened", () => {
	it("a candidate hung off a hub entity (degree above the threshold) is penalized", async () => {
		const pool = authorizedPool([
			candidate("hub", { fts: 0.8, vector: 0.8 }),
			candidate("normal", { fts: 0.8, vector: 0.8 }),
		]);
		// `hub` hangs off a degree-500 entity; `normal` off a degree-2 entity.
		const metadata = fakeMetadata({ hub: { entityDegree: 500 }, normal: { entityDegree: 2 } });
		const config = recallConfig({ dampening: { hub: 0.4 } });
		const shaped = await createShapingPhase({ metadata })(pool, recallQuery(), phaseDeps({ config }));
		expect(shaped.candidates[0]?.id).toBe("normal");
		const hub = shaped.candidates.find((c) => c.id === "hub");
		const normal = shaped.candidates.find((c) => c.id === "normal");
		expect(hub!.calibratedScore).toBeLessThan(normal!.calibratedScore);
	});
});

// ── d-AC-6 ──────────────────────────────────────────────────────────────────

describe("d-AC-6 decision/constraint memory → resolution-boosted", () => {
	it("a decision memory is boosted above an equally-scored ordinary fact", async () => {
		const pool = authorizedPool([
			candidate("fact", { fts: 0.6, vector: 0.6 }),
			candidate("decision", { fts: 0.6, vector: 0.6 }),
		]);
		const metadata = fakeMetadata({ decision: { type: "decision" }, fact: { type: "fact" } });
		const shaped = await createShapingPhase({ metadata })(pool, recallQuery(), phaseDeps());
		expect(shaped.candidates[0]?.id).toBe("decision");
		const decision = shaped.candidates.find((c) => c.id === "decision");
		const fact = shaped.candidates.find((c) => c.id === "fact");
		expect(decision!.calibratedScore).toBeGreaterThan(fact!.calibratedScore);
	});

	it("a constraint memory is also boosted (resolution dampening covers constraints)", async () => {
		const pool = authorizedPool([
			candidate("chatter", { fts: 0.6 }),
			candidate("constraint", { fts: 0.6 }),
		]);
		const metadata = fakeMetadata({ constraint: { type: "constraint" } });
		const shaped = await createShapingPhase({ metadata })(pool, recallQuery(), phaseDeps());
		expect(shaped.candidates[0]?.id).toBe("constraint");
	});
});

// ── d-AC-7 ──────────────────────────────────────────────────────────────────

describe("d-AC-7 calibrated scores preserved for the gate; no unauthorized row introduced", () => {
	it("every shaped candidate carries a real calibratedScore and the context is carried for the gate", async () => {
		const pool = authorizedPool([candidate("a", { fts: 0.5, vector: 0.7 }), candidate("b", { fts: 0.3 })], true);
		const shaped = await createShapingPhase({})(pool, recallQuery(), phaseDeps());
		for (const c of shaped.candidates) {
			expect(typeof c.calibratedScore).toBe("number");
			expect(Number.isFinite(c.calibratedScore)).toBe(true);
			// The calibrated score is a real convolved value, NOT a rank ordinal (0/1/2...).
			expect(Number.isInteger(c.calibratedScore) && c.calibratedScore <= shaped.candidates.length).toBe(false);
		}
		// The degraded flag and the authorized scope context are carried through for the gate.
		expect(shaped.degraded).toBe(true);
		expect(shaped.context.clause.sql).toMatch(/agent_id = 'agent-1'/);
	});

	it("shaping introduces NO id the authorized pool did not already carry", async () => {
		const pool = authorizedPool([candidate("auth1", { fts: 0.5 }), candidate("auth2", { vector: 0.6 })]);
		// A metadata source that returns facts for an UNAUTHORIZED id must not add a row.
		const metadata = fakeMetadata({ intruder: { type: "decision" }, auth1: { type: "fact" } });
		const shaped = await createShapingPhase({ metadata })(pool, recallQuery(), phaseDeps());
		const ids = shaped.candidates.map((c) => c.id).sort();
		expect(ids).toEqual(["auth1", "auth2"]);
		expect(ids).not.toContain("intruder");
	});

	it("preserves the calibrated score from shaping rather than rebuilding it from rank (e-AC-2)", async () => {
		// Two candidates with the SAME calibrated inputs must carry the SAME score —
		// a rank-derived score would force them apart by ordinal.
		const pool = authorizedPool([candidate("x", { fts: 0.5, vector: 0.5 }), candidate("y", { fts: 0.5, vector: 0.5 })]);
		const shaped = await createShapingPhase({})(pool, recallQuery(), phaseDeps());
		expect(shaped.candidates[0]!.calibratedScore).toBeCloseTo(shaped.candidates[1]!.calibratedScore, 10);
	});
});

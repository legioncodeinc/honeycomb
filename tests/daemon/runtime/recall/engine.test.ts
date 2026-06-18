/**
 * PRD-007 recall-engine harness — Wave 1 (the collect→traverse→authorize→shape→
 * gate orchestration + the four no-op phase stubs).
 *
 * Proves the harness routes the five phases in order, the Wave-1 stubs compile and
 * behave inertly (so the engine runs end-to-end before Wave 2 fills them), and a
 * filled phase injected via `createRecallEngine({ phases })` is invoked in place of
 * its no-op. This is the contract Wave 2 builds against.
 *
 * No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import type { StorageRow } from "../../../../src/daemon/storage/result.js";
import { EMBEDDING_DIMS } from "../../../../src/daemon/storage/vector.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";
import {
	type AuthorizationPhase,
	type AuthorizedPool,
	type ChannelResult,
	type GatePhase,
	type RecallConfig,
	RecallConfigSchema,
	type RecallQuery,
	type ShapingPhase,
	type TraversalPhase,
	createRecallEngine,
	noopAuthorizationPhase,
	noopGatePhase,
	noopShapingPhase,
	noopTraversalPhase,
} from "../../../../src/daemon/runtime/recall/index.js";

const ORG_SCOPE = { org: "fake-org", workspace: "fake-ws" } as const;

function recallConfig(overrides: Record<string, unknown> = {}): RecallConfig {
	return RecallConfigSchema.parse(overrides);
}

function recallQuery(): RecallQuery {
	return {
		query: "bind address",
		scope: { org: "fake-org", workspace: "fake-ws", agentId: "agent-1", readPolicy: "shared", policyGroup: "" },
	};
}

function vec768(): number[] {
	return Array.from({ length: EMBEDDING_DIMS }, () => 0.01);
}

function fakeEmbed(vector: readonly number[] | null): EmbedClient {
	return { async embed() { return vector; } };
}

function makeStorage(rows: StorageRow[]): ReturnType<typeof createStorageClient> {
	const responder = (_req: TransportRequest): StorageRow[] => rows;
	const fake = new FakeDeepLakeTransport(responder);
	return createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
}

describe("recall-engine harness — Wave-1 stubs run inertly end-to-end", () => {
	it("with all no-op phases, the engine completes: collection runs, authorization denies, empty injection", async () => {
		// FTS returns a candidate; with the no-op authorization (fail-closed deny) the
		// engine still completes with an empty, non-injected result — not a crash.
		const storage = makeStorage([{ id: "m1", score: 0.9 }]);
		const engine = createRecallEngine({ storage, scope: ORG_SCOPE, config: recallConfig(), embed: fakeEmbed(vec768()) });
		const result = await engine.recall(recallQuery());
		expect(result.injected).toBe(false);
		expect(result.hits).toEqual([]);
		// The collection ran (degrade flag reflects the vector path was available).
		expect(result.degraded).toBe(false);
	});

	it("the no-op stubs satisfy their phase types and are inert", async () => {
		const storage = makeStorage([]);
		const deps = { storage, scope: ORG_SCOPE, config: recallConfig() };
		const query = recallQuery();

		const traversal: ChannelResult = await noopTraversalPhase(query, deps);
		// 007b (Wave 2) extended TraversalChannelResult carries extra fields; the
		// ChannelResult contract requires at minimum channel + ids.
		expect(traversal).toMatchObject({ channel: "traversal", ids: [] });

		const authorized: AuthorizedPool = await noopAuthorizationPhase({ candidates: [], degraded: false }, query, deps);
		expect(authorized.candidates).toEqual([]);
		// The no-op authorization STILL compiles the real scope clause for the context.
		expect(authorized.context.clause.sql).toContain("is_deleted = 0");

		const shaped = await noopShapingPhase(authorized, query, deps);
		expect(shaped.candidates).toEqual([]);

		const gated = await noopGatePhase(shaped, query, deps);
		expect(gated.injected).toBe(false);
	});
});

describe("recall-engine harness — injected phases replace their no-ops (the Wave-2 seam)", () => {
	it("a filled authorization + shaping + gate flow IDs through to an injected result", async () => {
		const storage = makeStorage([{ id: "m1", score: 0.9 }]);

		// A traversal that contributes one extra id (merged into the pool, IDs only).
		const traversal: TraversalPhase = async () => ({ channel: "traversal", ids: [{ id: "t1", score: 0.7 }] });

		// An authorization that authorizes everything it was given (test double).
		const authorization: AuthorizationPhase = async (pool, query) => ({
			candidates: pool.candidates,
			degraded: pool.degraded,
			context: {
				clause: { sql: "(agent_id = 'agent-1' AND is_deleted = 0)", values: ["agent-1"], policyApplied: "isolated" },
				scope: query.scope,
			},
		});

		// A shaping that lifts the strongest score to the calibrated score.
		const shaping: ShapingPhase = async (pool) => ({
			candidates: pool.candidates.map((c) => ({ ...c, calibratedScore: Math.max(0, ...Object.values(c.scores).filter((v): v is number => typeof v === "number")) })),
			degraded: pool.degraded,
			context: pool.context,
		});

		// A gate that injects above the configured minimum.
		const gate: GatePhase = async (pool, _query, deps) => {
			const top = pool.candidates[0]?.calibratedScore ?? 0;
			return { injected: top >= deps.config.minInjectionScore, hits: [], degraded: pool.degraded };
		};

		const engine = createRecallEngine({
			storage,
			scope: ORG_SCOPE,
			config: recallConfig(),
			embed: fakeEmbed(vec768()),
			phases: { traversal, authorization, shaping, gate },
		});
		const result = await engine.recall(recallQuery());
		// m1 (fts/vector ~0.9) clears the 0.6 minimum → injected.
		expect(result.injected).toBe(true);
	});

	it("traversal ids merge into the collected pool (one candidate per id, traversal provenance)", async () => {
		const storage = makeStorage([{ id: "m1", score: 0.5 }]);
		const traversal: TraversalPhase = async () => ({ channel: "traversal", ids: [{ id: "m1", score: 0.8 }] });
		// Capture the authorized pool to inspect the merge.
		let seen: AuthorizedPool | undefined;
		const authorization: AuthorizationPhase = async (pool, query) => {
			const authed: AuthorizedPool = {
				candidates: pool.candidates,
				degraded: pool.degraded,
				context: { clause: { sql: "()", values: [], policyApplied: "isolated" }, scope: query.scope },
			};
			seen = authed;
			return authed;
		};
		const engine = createRecallEngine({
			storage,
			scope: ORG_SCOPE,
			config: recallConfig(),
			embed: fakeEmbed(null), // lexical-only so m1 comes from FTS.
			phases: { traversal, authorization },
		});
		await engine.recall(recallQuery());
		const m1 = seen?.candidates.find((c) => c.id === "m1");
		expect(m1).toBeDefined();
		// m1 was surfaced by both FTS (collection) and traversal → both in provenance.
		expect(m1?.provenance).toContain("traversal");
		expect(m1?.provenance).toContain("fts");
	});
});

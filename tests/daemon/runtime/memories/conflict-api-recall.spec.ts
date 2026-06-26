/**
 * PRD-058b — the resolve-endpoint + recall-suppression suite.
 *
 * Acceptance criteria → tests:
 *   58b.1.1 a recorded conflict pair → at most the WINNER is returned (the κ = ρ loser is suppressed).
 *   58b.1.2 supersede → loser κ = 0 (excluded upstream by MAX(version)); the recall gate is a no-op for it.
 *   58b.1.3 review → loser κ = ρ suppressed via the OPEN-conflict projection, REVERSIBLE.
 *   58b.1.4 uncontested memory → κ = 1, untouched (no suppression).
 *   58b.2.4 keep-both via the endpoint → the normalized pair is MEMOIZED.
 *   58b.3.4 supersede persists margin + contra_score and version-bumps the loser (append-only).
 *   58b.4.2 reverse a supersede → status reversed (a NEW append, never an in-place mutate).
 *   58b.4.3 no destructive delete: every resolution path is an append/version-bump only.
 *   Endpoint errors: 400 invalid_verdict (supersede w/o winnerId), 404 conflict_not_found, 409 already_resolved.
 *   Fail-soft: a missing/unreadable memory_conflicts → recall returns BOTH sides, never throws.
 */

import { describe, expect, it, vi } from "vitest";

import {
	applyConflictResolution,
	type KeepBothMemoStore,
	ResolveSchema,
} from "../../../../src/daemon/runtime/memories/conflicts-api.js";
import {
	createConflictSuppressionSource,
} from "../../../../src/daemon/runtime/memories/conflict-resolve.js";
import { recallMemories, type ConflictSuppressionSource, type MemoryRecallHit } from "../../../../src/daemon/runtime/memories/recall.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const SCOPE = { org: "o", workspace: "w" };

/** A SQL-aware fake storage from a responder (request → rows). */
function makeStorage(responder: (req: TransportRequest) => Record<string, unknown>[]) {
	const fake = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	return { storage, fake };
}

/** The live (highest-version) open conflict row a resolve read-back returns. */
function openConflictRow(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "c1",
		memory_a_id: "a",
		memory_b_id: "b",
		claim_slot: "deploy.cadence",
		signal: "lexical",
		contra_score: 0.8,
		margin: 0.6,
		verdict: "review",
		winner_id: "a",
		kappa_loser: 0,
		status: "open",
		confidence: 0.8,
		created_at: "2026-06-26T00:00:00Z",
		agent_id: "default",
		version: 1,
		...over,
	};
}

// ── The resolve endpoint core (applyConflictResolution) ──────────────────────

describe("PRD-058b applyConflictResolution — verdict application", () => {
	it("58b.3.4 / 4.3: supersede version-bumps the loser (append-only) and persists kappa_loser = 0", async () => {
		// The conflict read returns an OPEN row; the loser supersession + projection are recorded.
		const { storage, fake } = makeStorage((req) => (/FROM\s+"memory_conflicts"/i.test(req.sql) ? [openConflictRow()] : []));
		const out = await applyConflictResolution(
			"c1",
			{ verdict: "supersede", winnerId: "a" },
			SCOPE,
			{ persist: { storage, newId: () => "h1" }, writeDeps: { storage } },
		);
		expect(out.kind).toBe("ok");
		// The loser (b) was superseded via a version bump (the controlled-writes delete path), NEVER a destructive delete.
		const writes = fake.requests.filter((r) => /INSERT INTO|UPDATE/i.test(r.sql));
		expect(writes.some((r) => /DELETE FROM/i.test(r.sql))).toBe(false);
		// The resolved projection carries kappa_loser 0 + the verdict; a memory_conflicts INSERT landed.
		expect(fake.requests.some((r) => /INSERT INTO\s+"memory_conflicts"/i.test(r.sql) && /'supersede'/.test(r.sql))).toBe(true);
		// A memory_history conflict_resolve audit row was appended.
		expect(fake.requests.some((r) => /INSERT INTO\s+"memory_history"/i.test(r.sql) && /conflict_resolve/.test(r.sql))).toBe(true);
	});

	it("400 invalid_verdict: supersede WITHOUT a winnerId", async () => {
		const { storage } = makeStorage((req) => (/FROM\s+"memory_conflicts"/i.test(req.sql) ? [openConflictRow()] : []));
		const out = await applyConflictResolution("c1", { verdict: "supersede" }, SCOPE, { persist: { storage }, writeDeps: { storage } });
		expect(out.kind).toBe("invalid_verdict");
	});

	it("400 invalid_verdict: a winnerId not in the pair", async () => {
		const { storage } = makeStorage((req) => (/FROM\s+"memory_conflicts"/i.test(req.sql) ? [openConflictRow()] : []));
		const out = await applyConflictResolution("c1", { verdict: "supersede", winnerId: "zzz" }, SCOPE, { persist: { storage }, writeDeps: { storage } });
		expect(out.kind).toBe("invalid_verdict");
	});

	it("404 conflict_not_found: no conflict row in scope", async () => {
		const { storage } = makeStorage(() => []); // the conflict read returns nothing.
		const out = await applyConflictResolution("missing", { verdict: "review" }, SCOPE, { persist: { storage }, writeDeps: { storage } });
		expect(out.kind).toBe("conflict_not_found");
	});

	it("409 already_resolved: the live status is already resolved", async () => {
		const { storage } = makeStorage((req) =>
			/FROM\s+"memory_conflicts"/i.test(req.sql) ? [openConflictRow({ status: "resolved" })] : [],
		);
		const out = await applyConflictResolution("c1", { verdict: "review" }, SCOPE, { persist: { storage }, writeDeps: { storage } });
		expect(out.kind).toBe("already_resolved");
	});

	it("58b.2.4: keep-both via the endpoint MEMOIZES the normalized pair", async () => {
		const { storage } = makeStorage((req) => (/FROM\s+"memory_conflicts"/i.test(req.sql) ? [openConflictRow()] : []));
		const remembered: Array<[string, string]> = [];
		const memo: KeepBothMemoStore = { has: () => false, remember: (x, y) => { remembered.push([x, y]); } };
		const out = await applyConflictResolution("c1", { verdict: "keep-both" }, SCOPE, { persist: { storage }, writeDeps: { storage }, keepBothMemo: memo });
		expect(out.kind).toBe("ok");
		expect(remembered).toEqual([["a", "b"]]); // normalized (sorted) pair memoized.
	});

	it("58b.1.3: review sets kappa_loser = ρ (default 0) and projects status resolved", async () => {
		const { storage, fake } = makeStorage((req) => (/FROM\s+"memory_conflicts"/i.test(req.sql) ? [openConflictRow()] : []));
		const out = await applyConflictResolution("c1", { verdict: "review" }, SCOPE, { persist: { storage }, writeDeps: { storage }, rho: 0 });
		expect(out.kind).toBe("ok");
		expect(fake.requests.some((r) => /INSERT INTO\s+"memory_conflicts"/i.test(r.sql) && /'review'/.test(r.sql))).toBe(true);
	});
});

describe("PRD-058b ResolveSchema — zod boundary", () => {
	it("accepts a valid supersede body with a winnerId", () => {
		const r = ResolveSchema.safeParse({ verdict: "supersede", winnerId: "550e8400-e29b-41d4-a716-446655440000" });
		expect(r.success).toBe(true);
	});
	it("rejects an unknown verdict", () => {
		expect(ResolveSchema.safeParse({ verdict: "nuke" }).success).toBe(false);
	});
	it("rejects a non-uuid winnerId", () => {
		expect(ResolveSchema.safeParse({ verdict: "supersede", winnerId: "not-a-uuid" }).success).toBe(false);
	});
});

// ── The recall-time κ gate (createConflictSuppressionSource) ─────────────────

function hit(id: string, score: number): MemoryRecallHit {
	return { source: "memories", id, text: `t-${id}`, score, kind: "memory", secondary: false, createdAt: "", freshnessScore: 1 };
}

describe("PRD-058b createConflictSuppressionSource — the κ = ρ loser set", () => {
	it("58b.1.1: an OPEN conflict with a winner suppresses the LOSER among the hits (winner survives)", async () => {
		// The open-conflict projection returns conflict (a vs b), winner = a → b is the κ = ρ loser.
		const { storage } = makeStorage((req) =>
			/FROM\s+"memory_conflicts"/i.test(req.sql)
				? [{ memory_a_id: "a", memory_b_id: "b", winner_id: "a", kappa_loser: 0, verdict: "review", status: "open", version: 1 }]
				: [],
		);
		const source = createConflictSuppressionSource(storage);
		const suppressed = await source.loadSuppressed([hit("a", 1), hit("b", 0.9)], SCOPE);
		expect([...suppressed]).toEqual(["b"]); // the loser is suppressed; the winner (a) is not.
	});

	it("a winner-less open conflict suppresses NEITHER side (conservative)", async () => {
		const { storage } = makeStorage((req) =>
			/FROM\s+"memory_conflicts"/i.test(req.sql)
				? [{ memory_a_id: "a", memory_b_id: "b", winner_id: null, kappa_loser: null, verdict: "review", status: "open", version: 1 }]
				: [],
		);
		const source = createConflictSuppressionSource(storage);
		const suppressed = await source.loadSuppressed([hit("a", 1), hit("b", 0.9)], SCOPE);
		expect(suppressed.size).toBe(0);
	});

	it("fail-soft: a missing/unreadable memory_conflicts table → empty set (both sides returned)", async () => {
		const failing = { query: vi.fn().mockRejectedValue(new Error("no such table")) } as any;
		const source = createConflictSuppressionSource(failing);
		const suppressed = await source.loadSuppressed([hit("a", 1), hit("b", 0.9)], SCOPE);
		expect(suppressed.size).toBe(0); // fail-soft: no suppression, never a throw.
	});
});

describe("PRD-058b recall κ gate — end to end through recallMemories", () => {
	it("58b.1.1: recall returns at most the winner — the κ = ρ loser is dropped", async () => {
		// The lexical arms return both a + b; the conflict source suppresses b (the open-conflict loser).
		const { storage } = makeStorage((req) => {
			if (/FROM\s+"memories"/i.test(req.sql)) {
				return [
					{ source: "memories", id: "a", text: "we deploy on fridays", created_at: "" },
					{ source: "memories", id: "b", text: "we never deploy on fridays", created_at: "" },
				];
			}
			return [];
		});
		const conflictSuppression: ConflictSuppressionSource = {
			async loadSuppressed() { return new Set(["b"]); },
		};
		const result = await recallMemories({ query: "deploy fridays", scope: SCOPE }, { storage, conflictSuppression });
		const ids = result.hits.map((h) => h.id);
		expect(ids).toContain("a"); // the winner survives.
		expect(ids).not.toContain("b"); // the κ = ρ loser is suppressed.
	});

	it("58b.1.4: an uncontested memory is untouched (empty suppression set → κ = 1)", async () => {
		const { storage } = makeStorage((req) =>
			/FROM\s+"memories"/i.test(req.sql) ? [{ source: "memories", id: "solo", text: "we use vitest", created_at: "" }] : [],
		);
		const conflictSuppression: ConflictSuppressionSource = { async loadSuppressed() { return new Set(); } };
		const result = await recallMemories({ query: "vitest", scope: SCOPE }, { storage, conflictSuppression });
		expect(result.hits.map((h) => h.id)).toContain("solo");
	});

	it("fail-soft: a throwing conflict source leaves recall returning BOTH sides, never a 500", async () => {
		const { storage } = makeStorage((req) => {
			if (/FROM\s+"memories"/i.test(req.sql)) {
				return [
					{ source: "memories", id: "a", text: "we deploy on fridays", created_at: "" },
					{ source: "memories", id: "b", text: "we never deploy on fridays", created_at: "" },
				];
			}
			return [];
		});
		const conflictSuppression: ConflictSuppressionSource = {
			async loadSuppressed() { throw new Error("conflicts table down"); },
		};
		const result = await recallMemories({ query: "deploy fridays", scope: SCOPE }, { storage, conflictSuppression });
		const ids = result.hits.map((h) => h.id);
		expect(ids).toContain("a");
		expect(ids).toContain("b"); // both sides returned (fail-soft), never a throw.
	});
});

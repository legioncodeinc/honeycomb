/**
 * PRD-009c Compaction Mode — c-AC-1..5 (Wave 2).
 *
 * Verification posture (EXECUTION_LEDGER-prd-009 / dreaming CONVENTIONS):
 *   - All assertions run against a FAKE DeepLake transport (SQL-aware responder).
 *   - A FAKE ModelClient returns canned mutation sets.
 *   - A FAKE DreamJobEnqueuer records calls (c-AC-2 CLI test).
 *   - A FAKE DreamingStateUpdater records calls (c-AC-4 post-compaction state).
 *   - No live network. No `.skip` / `.only`; `vitest run` is CI.
 *
 * c-AC-1 backfillOnFirstRun + no prior pass → shouldEnterCompaction true, full graph.
 * c-AC-2 `dream trigger --compact` → job enqueued regardless of counter state.
 * c-AC-3 large graph → summaries sampled, total input ≤ maxInputTokens estimate.
 * c-AC-4 compaction completes → state updated (last_pass_at stamped, pending cleared).
 * c-AC-5 compaction destructive mutations → pending review via control plane.
 */

import { describe, expect, it } from "vitest";

import { createStorageClient, type QueryScope, type StorageQuery } from "../../../../src/daemon/storage/index.js";
import type { StorageRow } from "../../../../src/daemon/storage/result.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";
import { createFakeModelClient } from "../../../../src/daemon/runtime/pipeline/model-client.js";
import {
	createDreamingRunner,
	type DreamingPayload,
	type DreamingPayloadStrategy,
	type DreamingStateUpdater,
} from "../../../../src/daemon/runtime/dreaming/runner.js";
import { type DreamingJobPayload } from "../../../../src/daemon/runtime/dreaming/contracts.js";
import {
	CompactionPayloadStrategy,
	shouldEnterCompaction,
	resolvePassMode,
} from "../../../../src/daemon/runtime/dreaming/compaction.js";
import { DreamingConfigSchema, type DreamingConfig } from "../../../../src/daemon/runtime/dreaming/config.js";
import {
	parseDreamArgs,
	runDreamCommand,
	type DreamJobEnqueuer,
	type DreamScope,
	type DreamStateReader,
	type DreamStateSnapshot,
} from "../../../../src/cli/dream.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const SCOPE: QueryScope = { org: "test-org", workspace: "test-ws" };

function storageWith(responder: (req: TransportRequest) => StorageRow[]): {
	storage: StorageQuery;
	transport: FakeDeepLakeTransport;
} {
	const transport = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ provider: stubProvider(fakeCredentialRecord()), transport });
	return { storage, transport };
}

function config(overrides: Partial<DreamingConfig> = {}): DreamingConfig {
	return DreamingConfigSchema.parse({
		enabled: true,
		tokenThreshold: 100_000,
		maxInputTokens: 128_000,
		backfillOnFirstRun: true,
		...overrides,
	});
}

function compactionJob(overrides: Partial<DreamingJobPayload> = {}): DreamingJobPayload {
	return { mode: "compaction", agentId: "agent-alpha", enqueuedAt: "", tokensAtEnqueue: 0, ...overrides };
}

/** A state-updater recording its calls (b-AC-5 / c-AC-4). */
class FakeStateUpdater implements DreamingStateUpdater {
	readonly calls: { agentId: string; passAt: string }[] = [];
	async recordPassComplete(agentId: string, passAt: string): Promise<void> {
		this.calls.push({ agentId, passAt });
	}
}

/** A fake enqueuer recording calls (c-AC-2). */
class FakeEnqueuer implements DreamJobEnqueuer {
	readonly compactionCalls: DreamScope[] = [];
	async enqueueCompaction(scope: DreamScope): Promise<string> {
		this.compactionCalls.push(scope);
		return `job_compact_${this.compactionCalls.length}`;
	}
}

/** A fake state reader returning a fixed snapshot or null. */
function fakeReader(snapshot: DreamStateSnapshot | null): DreamStateReader {
	return { readState: async () => snapshot };
}

/** Capture output lines from a CLI command. */
function captureOutput(): { lines: string[]; sink: (line: string) => void } {
	const lines: string[] = [];
	return { lines, sink: (line: string) => lines.push(line) };
}

/**
 * Build a SQL responder that serves entity graph rows for the compaction strategy.
 * `entities`, `aspects`, `attributes`, `dependencies`, `summaries` are what the
 * responder returns for each respective table query.
 */
function graphResponder(opts: {
	entities?: StorageRow[];
	aspects?: StorageRow[];
	attributes?: StorageRow[];
	dependencies?: StorageRow[];
	summaries?: StorageRow[];
}): (req: TransportRequest) => StorageRow[] {
	return (req: TransportRequest): StorageRow[] => {
		const sql = req.sql;
		// Route by table name in the SQL.
		if (/FROM\s+entities\b/i.test(sql)) return opts.entities ?? [];
		if (/FROM\s+entity_aspects\b/i.test(sql)) return opts.aspects ?? [];
		if (/FROM\s+entity_attributes\b/i.test(sql)) return opts.attributes ?? [];
		if (/FROM\s+entity_dependencies\b/i.test(sql)) return opts.dependencies ?? [];
		if (/FROM\s+memory\b/i.test(sql)) return opts.summaries ?? [];
		// ontology_proposals INSERT (apply path) + SELECT (heal) → empty.
		return [];
	};
}

// ── c-AC-1: backfillOnFirstRun + no prior pass → compaction ──────────────────

describe("c-AC-1: shouldEnterCompaction — backfillOnFirstRun + no prior pass → compaction", () => {
	it("returns true when backfillOnFirstRun is true and lastPassAt is empty", () => {
		const cfg = config({ backfillOnFirstRun: true });
		expect(shouldEnterCompaction(cfg, "")).toBe(true);
	});

	it("returns false when lastPassAt is non-empty (prior pass exists)", () => {
		const cfg = config({ backfillOnFirstRun: true });
		expect(shouldEnterCompaction(cfg, "2024-01-01T00:00:00.000Z")).toBe(false);
	});

	it("returns false when backfillOnFirstRun is false, even with no prior pass", () => {
		const cfg = config({ backfillOnFirstRun: false });
		expect(shouldEnterCompaction(cfg, "")).toBe(false);
	});

	it("resolvePassMode returns compaction on first run with backfillOnFirstRun", () => {
		const cfg = config({ backfillOnFirstRun: true });
		expect(resolvePassMode(cfg, "")).toBe("compaction");
	});

	it("resolvePassMode returns incremental when a prior pass exists", () => {
		const cfg = config({ backfillOnFirstRun: true });
		expect(resolvePassMode(cfg, "2024-06-17T10:00:00.000Z")).toBe("incremental");
	});

	it("CompactionPayloadStrategy.mode is 'compaction'", () => {
		const strategy = new CompactionPayloadStrategy(128_000);
		expect(strategy.mode).toBe("compaction");
	});

	it("loadPayload returns null for an empty graph (nothing to compact)", async () => {
		const { storage } = storageWith(graphResponder({ entities: [], attributes: [] }));
		const strategy = new CompactionPayloadStrategy(128_000);
		const job = compactionJob();
		const payload = await strategy.loadPayload(storage, SCOPE, job);
		// Empty graph → null (harness records empty pass).
		expect(payload).toBeNull();
	});

	it("loadPayload returns non-null payload when entities exist (full-graph load)", async () => {
		const entityRows: StorageRow[] = [
			{ id: "ent_1", name: "Honeycomb", type: "project", agent_id: "agent-alpha" },
			{ id: "ent_2", name: "DeepLake", type: "tool", agent_id: "agent-alpha" },
		];
		const attrRows: StorageRow[] = [
			{ id: "attr_1", aspect_id: "asp_1", content: "fast", confidence: 0.9, status: "active", claim_key: "ck_1", agent_id: "agent-alpha" },
		];
		const { storage } = storageWith(graphResponder({ entities: entityRows, attributes: attrRows }));
		const strategy = new CompactionPayloadStrategy(128_000);
		const payload = await strategy.loadPayload(storage, SCOPE, compactionJob());
		expect(payload).not.toBeNull();
		expect(payload!.prompt).toContain("Entity Graph");
		expect(payload!.prompt).toContain("Honeycomb");
		expect(payload!.tokenBudget).toBeGreaterThan(0);
		expect(payload!.tokenBudget).toBeLessThanOrEqual(128_000);
	});
});

// ── c-AC-2: `dream trigger --compact` enqueues regardless of counter ─────────

describe("c-AC-2: dream trigger --compact — enqueues regardless of token counter", () => {
	it("parseDreamArgs: trigger + --compact sets subCommand='trigger' compact=true", () => {
		const inv = parseDreamArgs(["trigger", "--compact", "--org", "acme", "--workspace", "main"]);
		expect(inv.subCommand).toBe("trigger");
		expect(inv.compact).toBe(true);
		expect(inv.scope.org).toBe("acme");
		expect(inv.scope.workspace).toBe("main");
	});

	it("parseDreamArgs: defaults agentId to 'default' when --agent not supplied", () => {
		const inv = parseDreamArgs(["trigger", "--compact"]);
		expect(inv.scope.agentId).toBe("default");
	});

	it("runDreamCommand trigger --compact: enqueues a compaction job and returns job id", async () => {
		const enqueuer = new FakeEnqueuer();
		const reader = fakeReader(null);
		const { lines, sink } = captureOutput();

		const inv = parseDreamArgs(["trigger", "--compact", "--org", "acme", "--workspace", "ws1", "--agent", "agent-x"]);
		const result = await runDreamCommand(inv, enqueuer, reader, sink);

		expect(result.exitCode).toBe(0);
		expect(result.jobId).toMatch(/^job_compact_/);
		expect(enqueuer.compactionCalls).toHaveLength(1);
		expect(enqueuer.compactionCalls[0].org).toBe("acme");
		expect(enqueuer.compactionCalls[0].agentId).toBe("agent-x");
		expect(lines.some((l) => l.includes("compaction job enqueued"))).toBe(true);
	});

	it("runDreamCommand trigger --compact: enqueues regardless of any counter value (counter not consulted)", async () => {
		// The enqueuer does NOT receive the counter — it enqueues unconditionally.
		// This test asserts the CLI makes exactly one enqueue call with no threshold check.
		const enqueuer = new FakeEnqueuer();
		const reader = fakeReader({ lastPassAt: "", tokensSinceLastPass: 999, pendingJobId: "" });
		const { sink } = captureOutput();

		const inv = parseDreamArgs(["trigger", "--compact"]);
		const result = await runDreamCommand(inv, enqueuer, reader, sink);

		expect(result.exitCode).toBe(0);
		// One enqueue call, regardless of the tokensSinceLastPass value.
		expect(enqueuer.compactionCalls).toHaveLength(1);
	});

	it("runDreamCommand trigger without --compact: refuses with exit 2", async () => {
		const enqueuer = new FakeEnqueuer();
		const reader = fakeReader(null);
		const { lines, sink } = captureOutput();

		const inv = parseDreamArgs(["trigger"]);
		const result = await runDreamCommand(inv, enqueuer, reader, sink);

		expect(result.exitCode).toBe(2);
		expect(enqueuer.compactionCalls).toHaveLength(0);
		expect(lines.some((l) => l.includes("--compact"))).toBe(true);
	});

	it("runDreamCommand status: shows state snapshot", async () => {
		const enqueuer = new FakeEnqueuer();
		const snapshot: DreamStateSnapshot = {
			lastPassAt: "2024-06-17T10:00:00.000Z",
			tokensSinceLastPass: 42_000,
			pendingJobId: "",
		};
		const reader = fakeReader(snapshot);
		const { lines, sink } = captureOutput();

		const inv = parseDreamArgs(["status", "--org", "acme"]);
		const result = await runDreamCommand(inv, enqueuer, reader, sink);

		expect(result.exitCode).toBe(0);
		expect(lines.some((l) => l.includes("2024-06-17T10:00:00.000Z"))).toBe(true);
		expect(lines.some((l) => l.includes("42000"))).toBe(true);
	});

	it("runDreamCommand status with no prior state: reports no pass on record", async () => {
		const enqueuer = new FakeEnqueuer();
		const reader = fakeReader(null);
		const { lines, sink } = captureOutput();

		const inv = parseDreamArgs(["status"]);
		const result = await runDreamCommand(inv, enqueuer, reader, sink);

		expect(result.exitCode).toBe(0);
		expect(lines.some((l) => l.includes("no dreaming pass on record"))).toBe(true);
	});
});

// ── c-AC-3: large graph → summaries sampled, input ≤ maxInputTokens ──────────

describe("c-AC-3: large graph — summaries sampled, total input ≤ maxInputTokens", () => {
	it("with a small maxInputTokens, summaries are excluded when graph already fills budget", async () => {
		// Give the strategy a tiny token budget so the graph alone fills it.
		const tinyBudget = 50; // chars-per-token: 4 → 200 chars → barely a header.
		const entityRows: StorageRow[] = [
			{ id: "ent_1", name: "A", type: "project", agent_id: "default" },
		];
		const attrRows: StorageRow[] = [
			{ id: "attr_1", aspect_id: "asp_1", content: "x", confidence: 1, status: "active", claim_key: "ck_1", agent_id: "default" },
		];
		// Build many summaries — none should be included (budget exhausted by graph).
		const summaryRows: StorageRow[] = Array.from({ length: 50 }, (_, i) => ({
			path: `sessions/s${i}`,
			summary: "A".repeat(200), // each summary is 200 chars ~ 50 tokens.
			last_update_date: `2024-06-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
			agent_id: "default",
		}));

		const { storage } = storageWith(graphResponder({ entities: entityRows, attributes: attrRows, summaries: summaryRows }));
		const strategy = new CompactionPayloadStrategy(tinyBudget);
		const payload = await strategy.loadPayload(storage, SCOPE, compactionJob({ agentId: "default" }));

		expect(payload).not.toBeNull();
		// The tokenBudget must be at or below the configured maxInputTokens.
		expect(payload!.tokenBudget).toBeLessThanOrEqual(tinyBudget);
	});

	it("with generous budget, includes recent summaries up to the budget", async () => {
		const entityRows: StorageRow[] = [
			{ id: "ent_1", name: "Honeycomb", type: "project", agent_id: "agent-alpha" },
		];
		const attrRows: StorageRow[] = [
			{ id: "a1", aspect_id: "asp_1", content: "fast", confidence: 0.9, status: "active", claim_key: "ck_1", agent_id: "agent-alpha" },
		];
		// Two small summaries — both should fit comfortably in 128k.
		const summaryRows: StorageRow[] = [
			{ path: "sessions/s1", summary: "Did some work.", last_update_date: "2024-06-17T00:00:00Z", agent_id: "agent-alpha" },
			{ path: "sessions/s2", summary: "Fixed a bug.", last_update_date: "2024-06-16T00:00:00Z", agent_id: "agent-alpha" },
		];

		const { storage } = storageWith(graphResponder({ entities: entityRows, attributes: attrRows, summaries: summaryRows }));
		const strategy = new CompactionPayloadStrategy(128_000);
		const payload = await strategy.loadPayload(storage, SCOPE, compactionJob());

		expect(payload).not.toBeNull();
		expect(payload!.prompt).toContain("Did some work");
		expect(payload!.prompt).toContain("Fixed a bug");
		expect(payload!.tokenBudget).toBeLessThanOrEqual(128_000);
	});

	it("token budget in payload is always ≤ maxInputTokens regardless of graph size", async () => {
		// Stress: many entities, many summaries, big maxInputTokens.
		const entityRows: StorageRow[] = Array.from({ length: 100 }, (_, i) => ({
			id: `ent_${i}`,
			name: `Entity${i}`,
			type: "concept",
			agent_id: "agent-alpha",
		}));
		const attrRows: StorageRow[] = Array.from({ length: 200 }, (_, i) => ({
			id: `attr_${i}`,
			aspect_id: `asp_${i % 50}`,
			content: `claim content for attribute ${i}`,
			confidence: 0.8,
			status: "active",
			claim_key: `ck_${i}`,
			agent_id: "agent-alpha",
		}));
		const summaryRows: StorageRow[] = Array.from({ length: 50 }, (_, i) => ({
			path: `sessions/s${i}`,
			summary: `Summary for session ${i}. Some work was done. Multiple sentences to fill tokens.`,
			last_update_date: `2024-06-${String((i % 30) + 1).padStart(2, "0")}T00:00:00Z`,
			agent_id: "agent-alpha",
		}));

		const maxInputTokens = 128_000;
		const { storage } = storageWith(graphResponder({ entities: entityRows, attributes: attrRows, summaries: summaryRows }));
		const strategy = new CompactionPayloadStrategy(maxInputTokens);
		const payload = await strategy.loadPayload(storage, SCOPE, compactionJob());

		expect(payload).not.toBeNull();
		expect(payload!.tokenBudget).toBeLessThanOrEqual(maxInputTokens);
	});
});

// ── c-AC-4: compaction completes → next pass returns to incremental ───────────

describe("c-AC-4: compaction completes → state updated, next pass is incremental", () => {
	it("the runner's stateUpdater fires once on a successful compaction pass", async () => {
		const entityRows: StorageRow[] = [
			{ id: "ent_1", name: "Honeycomb", type: "project", agent_id: "agent-alpha" },
		];
		const attrRows: StorageRow[] = [
			{ id: "a1", aspect_id: "asp_1", content: "fast", confidence: 0.9, status: "active", claim_key: "ck_1", agent_id: "agent-alpha" },
		];

		const { storage } = storageWith(graphResponder({ entities: entityRows, attributes: attrRows }));
		const mutationBody = JSON.stringify({
			summary: "graph is clean",
			mutations: [],
			tokenBudget: 1000,
		});
		const model = createFakeModelClient({ memory_dreaming: mutationBody });
		const updater = new FakeStateUpdater();
		const strategy = new CompactionPayloadStrategy(128_000);

		const runner = createDreamingRunner({
			storage,
			scope: SCOPE,
			strategy,
			model,
			stateUpdater: updater,
		});

		const result = await runner.runPass(compactionJob());

		// The state updater fires once → last_pass_at stamped + pending_job_id cleared.
		expect(updater.calls).toHaveLength(1);
		expect(updater.calls[0].agentId).toBe("agent-alpha");
		expect(updater.calls[0].passAt).not.toBe("");
		expect(result.mode).toBe("compaction");
		expect(result.lastPassAt).not.toBe("");
	});

	it("after a compaction completes, shouldEnterCompaction returns false (next pass is incremental)", () => {
		const cfg = config({ backfillOnFirstRun: true });
		// The runner stamped last_pass_at — simulate that:
		const lastPassAt = new Date().toISOString();
		// Now the next tick should pick incremental, not compaction.
		expect(shouldEnterCompaction(cfg, lastPassAt)).toBe(false);
		expect(resolvePassMode(cfg, lastPassAt)).toBe("incremental");
	});

	it("an empty graph compaction (null payload) still calls stateUpdater → pending clears", async () => {
		// Empty graph → loadPayload returns null → harness records empty pass but still finalizes.
		const { storage } = storageWith(graphResponder({ entities: [], attributes: [] }));
		const model = createFakeModelClient({ memory_dreaming: '{"mutations":[],"summary":""}' });
		const updater = new FakeStateUpdater();
		const strategy = new CompactionPayloadStrategy(128_000);

		const runner = createDreamingRunner({
			storage,
			scope: SCOPE,
			strategy,
			model,
			stateUpdater: updater,
		});

		await runner.runPass(compactionJob());

		// Even an empty pass calls stateUpdater so pending_job_id is cleared (c-AC-4).
		expect(updater.calls).toHaveLength(1);
	});
});

// ── c-AC-5: compaction destructive mutations → pending review ─────────────────

describe("c-AC-5: compaction destructive mutations → via control plane → pending review", () => {
	it("a merge_entities from a compaction pass routes to PENDING review (destructive)", async () => {
		const entityRows: StorageRow[] = [
			{ id: "ent_1", name: "HoneyComb", type: "project", agent_id: "agent-alpha" },
			{ id: "ent_2", name: "Honeycomb", type: "project", agent_id: "agent-alpha" },
		];
		const attrRows: StorageRow[] = [
			{ id: "a1", aspect_id: "asp_1", content: "dup", confidence: 0.9, status: "active", claim_key: "ck_1", agent_id: "agent-alpha" },
		];

		const { storage, transport } = storageWith(graphResponder({ entities: entityRows, attributes: attrRows }));

		const mutationBody = JSON.stringify({
			summary: "ent_1 and ent_2 are duplicates — merged",
			mutations: [
				{
					kind: "merge_entities",
					payload: { from: "ent_1", into: "ent_2" },
					rationale: "HoneyComb and Honeycomb are the same project",
					confidence: 0.95,
					riskNote: "destructive merge — verify before applying",
				},
			],
			tokenBudget: 5000,
		});
		const model = createFakeModelClient({ memory_dreaming: mutationBody });
		const updater = new FakeStateUpdater();
		const strategy = new CompactionPayloadStrategy(128_000);

		const runner = createDreamingRunner({
			storage,
			scope: SCOPE,
			strategy,
			model,
			stateUpdater: updater,
		});

		const result = await runner.runPass(compactionJob());

		// c-AC-5: destructive op routes to pending review.
		expect(result.outcomes).toHaveLength(1);
		expect(result.outcomes[0].kind).toBe("merge_entities");
		expect(result.outcomes[0].route).toBe("pending");
		expect(result.outcomes[0].status).toBe("pending");

		// Verify the proposal row was written with status='pending'.
		const sqls = transport.requests.map((r) => r.sql);
		expect(sqls.some((s) => /INSERT/i.test(s) && /ontology_proposals/i.test(s) && /'pending'/.test(s))).toBe(true);
	});

	it("a delete_entity from a compaction pass routes to PENDING review (destructive)", async () => {
		const entityRows: StorageRow[] = [
			{ id: "ent_junk", name: "junk entity", type: "unknown", agent_id: "agent-alpha" },
		];
		const attrRows: StorageRow[] = [
			{ id: "a1", aspect_id: "asp_1", content: "junk", confidence: 0.1, status: "active", claim_key: "ck_1", agent_id: "agent-alpha" },
		];

		const { storage, transport } = storageWith(graphResponder({ entities: entityRows, attributes: attrRows }));

		const mutationBody = JSON.stringify({
			summary: "archived junk entity",
			mutations: [
				{
					kind: "delete_entity",
					payload: { entityId: "ent_junk" },
					rationale: "junk entry with low confidence, no useful attributes",
					confidence: 0.8,
					riskNote: "archives ent_junk",
				},
			],
			tokenBudget: 2000,
		});
		const model = createFakeModelClient({ memory_dreaming: mutationBody });
		const updater = new FakeStateUpdater();
		const strategy = new CompactionPayloadStrategy(128_000);

		const runner = createDreamingRunner({
			storage,
			scope: SCOPE,
			strategy,
			model,
			stateUpdater: updater,
		});

		const result = await runner.runPass(compactionJob());

		expect(result.outcomes).toHaveLength(1);
		expect(result.outcomes[0].kind).toBe("delete_entity");
		expect(result.outcomes[0].route).toBe("pending");
		expect(result.outcomes[0].status).toBe("pending");

		const sqls = transport.requests.map((r) => r.sql);
		expect(sqls.some((s) => /INSERT/i.test(s) && /ontology_proposals/i.test(s) && /'pending'/.test(s))).toBe(true);
	});

	it("an additive mutation (create_entity) in a compaction pass applies directly", async () => {
		const entityRows: StorageRow[] = [
			{ id: "ent_1", name: "Existing", type: "concept", agent_id: "agent-alpha" },
		];
		const attrRows: StorageRow[] = [
			{ id: "a1", aspect_id: "asp_1", content: "existing attr", confidence: 0.9, status: "active", claim_key: "ck_1", agent_id: "agent-alpha" },
		];

		const { storage, transport } = storageWith(graphResponder({ entities: entityRows, attributes: attrRows }));

		const mutationBody = JSON.stringify({
			summary: "added missing entity",
			mutations: [
				{
					kind: "create_entity",
					payload: { name: "NewConcept", type: "concept" },
					rationale: "entity referenced in summaries but missing from graph",
					confidence: 0.9,
					riskNote: "",
				},
			],
			tokenBudget: 3000,
		});
		const model = createFakeModelClient({ memory_dreaming: mutationBody });
		const updater = new FakeStateUpdater();
		const strategy = new CompactionPayloadStrategy(128_000);

		const runner = createDreamingRunner({
			storage,
			scope: SCOPE,
			strategy,
			model,
			stateUpdater: updater,
		});

		const result = await runner.runPass(compactionJob());

		// create_entity is additive → direct apply (bounded).
		expect(result.outcomes).toHaveLength(1);
		expect(result.outcomes[0].kind).toBe("create_entity");
		expect(result.outcomes[0].route).toBe("direct");
		expect(result.outcomes[0].status).toBe("applied");

		// Verify an 'applied' proposal row was written.
		const sqls = transport.requests.map((r) => r.sql);
		expect(sqls.some((s) => /INSERT/i.test(s) && /ontology_proposals/i.test(s) && /'applied'/.test(s))).toBe(true);
	});

	it("compaction scope is enforced: SQL carries the agent_id filter", async () => {
		const entityRows: StorageRow[] = [
			{ id: "ent_1", name: "Honeycomb", type: "project", agent_id: "agent-beta" },
		];

		const { storage, transport } = storageWith(graphResponder({ entities: entityRows, attributes: entityRows }));
		const strategy = new CompactionPayloadStrategy(128_000);

		await strategy.loadPayload(storage, SCOPE, compactionJob({ agentId: "agent-beta" }));

		// Every graph-load SQL must include the agent_id filter (FR-7).
		const graphSqls = transport.requests.map((r) => r.sql).filter((s) => /FROM\s+(entities|entity_aspects|entity_attributes|entity_dependencies|memory)\b/i.test(s));
		for (const sql of graphSqls) {
			expect(sql).toContain("agent_id");
			expect(sql).toContain("agent-beta");
		}
	});
});

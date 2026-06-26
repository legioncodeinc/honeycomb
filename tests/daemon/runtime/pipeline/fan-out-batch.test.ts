/**
 * PRD-062d (L-D1 / AC-62d.1.1 / AC-62d.1.2) — fan-out coalescing.
 *
 * Two halves of the dispatch-coalescing contract:
 *  1. `decisionFanOut` with batching ON enqueues ONE `memory_controlled_write` job
 *     carrying ALL M proposals (sub-linear: 1 enqueue for M facts, not M), and with
 *     batching OFF reproduces the pre-PRD per-proposal loop (parent AC-9 parity).
 *  2. The `createControlledWriteHandler` processes that batched job by applying each
 *     fact as its OWN write — every memory is written with its append/version-bump
 *     intact, NONE dropped or coalesced into one row or an in-place UPDATE (the
 *     `controlled-writes.ts` failure mode). It fans out graph-persist per committed fact.
 *
 * A recording fake queue counts enqueues; a recording fake storage proves each fact
 * lands its own append (one INSERT per fact, never an UPDATE). No real DeepLake.
 *
 * No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import {
	createControlledWriteHandler,
	decisionFanOut,
	type ControlledWriteOutcome,
	type FactDecision,
} from "../../../../src/daemon/runtime/pipeline/index.js";
import { CONTROLLED_WRITE_BATCH_KEY } from "../../../../src/daemon/runtime/pipeline/controlled-writes.js";
import { PipelineConfigSchema } from "../../../../src/daemon/runtime/pipeline/config.js";
import { AmplificationConfigSchema } from "../../../../src/daemon/runtime/memories/amplification-config.js";
import type { JobInput, JobQueueService, LeasedJob } from "../../../../src/daemon/runtime/services/job-queue.js";
import type { StageJob } from "../../../../src/daemon/runtime/pipeline/stage-worker.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import {
	FakeDeepLakeTransport,
	fakeCredentialRecord,
	type RecordedRequest,
	stubProvider,
} from "../../../helpers/fake-deeplake.js";

const BATCH_ON = AmplificationConfigSchema.parse({ fanoutBatch: true });
const BATCH_OFF = AmplificationConfigSchema.parse({ fanoutBatch: false });

/** A recording fake queue — only `enqueue` is exercised. */
function recordingQueue(): { queue: JobQueueService; enqueued: JobInput[] } {
	const enqueued: JobInput[] = [];
	const queue: JobQueueService = {
		async enqueue(job: JobInput): Promise<string> {
			enqueued.push(job);
			return `job-${enqueued.length}`;
		},
		async lease(): Promise<LeasedJob | null> {
			return null;
		},
		async complete(): Promise<void> {},
		async fail(): Promise<void> {},
		start(): void {},
		stop(): void {},
	};
	return { queue, enqueued };
}

/** A decision proposing an ADD of `content`. */
function addDecision(content: string, confidence = 0.95): FactDecision {
	return {
		fact: { content, type: "fact", confidence },
		proposal: { action: "add", confidence, reason: "novel" },
		candidates: [],
		degraded: false,
		modelCalled: false,
	};
}

/** The upstream decision job the fan-out reads off (scope + forwarded entities). */
function decisionJob(): StageJob {
	return {
		id: "j1",
		kind: "memory_decision",
		attempt: 1,
		scope: { org: "o1", workspace: "w1", agentId: "a1" },
		payload: { org: "o1", workspace: "w1", agent_id: "a1", entities: [] },
	};
}

describe("decisionFanOut (batch ON): a multi-fact decision is ONE enqueue (AC-62d.1.1)", () => {
	it("enqueues a single batched job carrying all M proposals (sub-linear in M)", async () => {
		const { queue, enqueued } = recordingQueue();
		const decisions = [addDecision("fact A"), addDecision("fact B"), addDecision("fact C")];

		await decisionFanOut(queue, BATCH_ON)(decisionJob(), decisions);

		// THE WIN: 1 enqueue for 3 facts (sub-linear), not 3 separate memory_jobs writes.
		expect(enqueued).toHaveLength(1);
		expect(enqueued[0].kind).toBe("memory_controlled_write");
		expect(enqueued[0].payload).toMatchObject({ org: "o1", workspace: "w1", agent_id: "a1" });
		const batch = enqueued[0].payload[CONTROLLED_WRITE_BATCH_KEY] as Array<Record<string, unknown>>;
		// EVERY fact is still present in the batch (none dropped/merged) — distinct payloads.
		expect(batch).toHaveLength(3);
		expect(batch.map((f) => f.content)).toEqual(["fact A", "fact B", "fact C"]);
		// The scope envelope is stamped ONCE on the job, not per-fact.
		expect(batch[0]).not.toHaveProperty("org");
	});

	it("a none proposal is excluded; zero writable proposals enqueue nothing", async () => {
		const { queue, enqueued } = recordingQueue();
		const none: FactDecision = {
			fact: { content: "dup", type: "fact", confidence: 0.4 },
			proposal: { action: "none", confidence: 0, reason: "already captured" },
			candidates: [],
			degraded: false,
			modelCalled: true,
		};
		await decisionFanOut(queue, BATCH_ON)(decisionJob(), [addDecision("kept"), none]);
		const batch = enqueued[0].payload[CONTROLLED_WRITE_BATCH_KEY] as unknown[];
		expect(batch).toHaveLength(1);

		const empty = recordingQueue();
		await decisionFanOut(empty.queue, BATCH_ON)(decisionJob(), [none]);
		expect(empty.enqueued).toHaveLength(0);
	});
});

describe("decisionFanOut (batch OFF): the pre-PRD per-proposal loop (parent AC-9)", () => {
	it("enqueues M independent jobs, fact material at the payload top level", async () => {
		const { queue, enqueued } = recordingQueue();
		await decisionFanOut(queue, BATCH_OFF)(decisionJob(), [addDecision("fact A"), addDecision("fact B")]);
		expect(enqueued).toHaveLength(2);
		expect(enqueued[0].payload).toMatchObject({ content: "fact A", org: "o1" });
		expect(enqueued[1].payload).toMatchObject({ content: "fact B", org: "o1" });
		expect(enqueued[0].payload).not.toHaveProperty(CONTROLLED_WRITE_BATCH_KEY);
	});
});

// ── The controlled-write side: a batch still writes EACH fact append/version-bumped ──

/** A storage client over the SQL-aware fake transport that records every request. */
function storageWith(): { storage: ReturnType<typeof createStorageClient>; requests: RecordedRequest[] } {
	// The dedup probe returns no rows (every fact is novel → an INSERT follows); other reads empty too.
	const transport = new FakeDeepLakeTransport(() => []);
	const storage = createStorageClient({
		transport,
		provider: stubProvider(fakeCredentialRecord({ org: "o1", workspace: "w1" })),
	});
	return { storage, requests: transport.requests };
}

/** A null-vector embed seam (a fact writes with the embedding column NULL — the capture-path degrade). */
const nullEmbed: EmbedClient = {
	async embed(): Promise<readonly number[] | null> {
		return null;
	},
};

describe("controlled-write handler: a batched job writes EACH fact (AC-62d.1.2)", () => {
	it("applies every fact as its own append (INSERT per fact) — none dropped/merged, no UPDATE", async () => {
		const { storage, requests } = storageWith();
		const onOutcomeIds: string[] = [];
		const newIds: string[] = [];
		let n = 0;
		// Confidence 0.95 clears the 0.7 ADD gate; autonomous off (irrelevant — these are ADDs).
		const handler = createControlledWriteHandler({
			storage,
			config: PipelineConfigSchema.parse({ minFactConfidenceForWrite: 0.7 }),
			embed: nullEmbed,
			now: () => new Date("2026-06-26T00:00:00.000Z"),
			newId: () => {
				const id = `mem_${++n}`;
				newIds.push(id);
				return id;
			},
			onOutcome: (_job, outcome: ControlledWriteOutcome) => {
				if (outcome.memoryId !== undefined) onOutcomeIds.push(outcome.memoryId);
			},
		});

		// A batched job carrying THREE distinct facts (the shape decisionFanOut emits).
		const job: StageJob = {
			id: "batch-1",
			kind: "memory_controlled_write",
			attempt: 1,
			scope: { org: "o1", workspace: "w1", agentId: "a1" },
			payload: {
				org: "o1",
				workspace: "w1",
				agent_id: "a1",
				[CONTROLLED_WRITE_BATCH_KEY]: [
					{ proposal: { action: "add", confidence: 0.95, reason: "r" }, content: "fact A", fact_confidence: 0.95 },
					{ proposal: { action: "add", confidence: 0.95, reason: "r" }, content: "fact B", fact_confidence: 0.95 },
					{ proposal: { action: "add", confidence: 0.95, reason: "r" }, content: "fact C", fact_confidence: 0.95 },
				],
			},
		};

		await handler(job);

		// THREE distinct memories were written (one new id per fact) — none dropped/merged.
		expect(newIds).toHaveLength(3);
		expect(new Set(newIds).size).toBe(3);
		// graph-persist fan-out fired ONCE PER committed fact, each with its own memory id (entities
		// were empty so the graph job is suppressed, but the outcome still carries the id).
		expect(onOutcomeIds).toEqual(newIds);
		// The writes are appends (INSERTs into "memories"), never an in-place UPDATE (the coalescing
		// failure mode controlled-writes.ts warns against). One INSERT per fact.
		const sql = requests.map((r) => r.sql);
		const inserts = sql.filter((s) => /INSERT\s+INTO\s+"memories"/i.test(s));
		const updates = sql.filter((s) => /^\s*UPDATE\s+"?memories"?/i.test(s.trim()));
		expect(inserts).toHaveLength(3);
		expect(updates).toHaveLength(0);
	});
});

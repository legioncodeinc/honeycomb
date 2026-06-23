/**
 * PRD-045a pipeline fan-out — the chain that advances a captured turn through the stages.
 *
 * Verifies the three fan-out enqueuers (`extractionFanOut` / `decisionFanOut` /
 * `controlledWriteFanOut`) enqueue the RIGHT next-stage job onto the queue, threading
 * the tenancy envelope (006a FR-10) and forwarding the entity triples down the chain so
 * graph-persist can link them to the committed memory. A tiny recording fake queue
 * captures every enqueue; no storage / model is needed (the enqueuers are pure wiring).
 *
 * No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import {
	controlledWriteFanOut,
	decisionFanOut,
	extractionFanOut,
	type ControlledWriteOutcome,
	type FactDecision,
} from "../../../../src/daemon/runtime/pipeline/index.js";
import type { ExtractionResult } from "../../../../src/daemon/runtime/pipeline/contracts.js";
import type { JobInput, JobQueueService, LeasedJob } from "../../../../src/daemon/runtime/services/job-queue.js";
import type { StageJob } from "../../../../src/daemon/runtime/pipeline/stage-worker.js";

/** A recording fake queue — only `enqueue` is exercised by the fan-out enqueuers. */
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

/** A stage job with a fixed scope + a payload (the upstream job the enqueuer reads off). */
function jobWith(payload: Record<string, unknown>): StageJob {
	return {
		id: "j1",
		kind: "memory_extraction",
		attempt: 1,
		scope: { org: "o1", workspace: "w1", agentId: "a1" },
		payload,
	};
}

describe("extractionFanOut: facts → a memory_decision job carrying facts + entities", () => {
	it("enqueues one decision job with the tenancy envelope, facts, and forwarded entities", async () => {
		const { queue, enqueued } = recordingQueue();
		const result: ExtractionResult = {
			facts: [{ content: "the daemon binds port 3850", type: "fact", confidence: 0.9 }],
			entities: [{ source: "daemon", relationship: "binds", target: "port" }],
			droppedCount: 0,
		};

		await extractionFanOut(queue)(jobWith({}), result);

		expect(enqueued).toHaveLength(1);
		expect(enqueued[0].kind).toBe("memory_decision");
		expect(enqueued[0].payload).toMatchObject({ org: "o1", workspace: "w1", agent_id: "a1" });
		expect(enqueued[0].payload.facts).toHaveLength(1);
		expect(enqueued[0].payload.entities).toEqual([{ source: "daemon", relationship: "binds", target: "port" }]);
	});

	it("enqueues nothing when extraction produced no facts (a-AC-4 empty pass)", async () => {
		const { queue, enqueued } = recordingQueue();
		const result: ExtractionResult = { facts: [], entities: [], droppedCount: 0 };
		await extractionFanOut(queue)(jobWith({}), result);
		expect(enqueued).toHaveLength(0);
	});
});

describe("decisionFanOut: proposals → memory_controlled_write jobs (skipping `none`)", () => {
	it("enqueues one write job per non-none proposal, carrying the fact material + entities", async () => {
		const { queue, enqueued } = recordingQueue();
		const decisions: FactDecision[] = [
			{
				fact: { content: "fact A", type: "fact", confidence: 0.95 },
				proposal: { action: "add", confidence: 0.95, reason: "novel" },
				candidates: [],
				degraded: false,
				modelCalled: false,
			},
			{
				fact: { content: "fact B", type: "fact", confidence: 0.4 },
				proposal: { action: "none", confidence: 0, reason: "already captured" },
				candidates: [],
				degraded: false,
				modelCalled: true,
			},
		];

		await decisionFanOut(queue)(
			jobWith({ entities: [{ source: "s", relationship: "r", target: "t" }] }),
			decisions,
		);

		// Only the `add` proposal fans out; the `none` is skipped (nothing to write).
		expect(enqueued).toHaveLength(1);
		expect(enqueued[0].kind).toBe("memory_controlled_write");
		expect(enqueued[0].payload).toMatchObject({
			org: "o1",
			workspace: "w1",
			agent_id: "a1",
			content: "fact A",
			normalized_content: "fact A",
			fact_confidence: 0.95,
			fact_type: "fact",
		});
		expect(enqueued[0].payload.proposal).toMatchObject({ action: "add", confidence: 0.95 });
		expect(enqueued[0].payload.entities).toEqual([{ source: "s", relationship: "r", target: "t" }]);
	});
});

describe("controlledWriteFanOut: a committed memory → a memory_graph_persist job", () => {
	it("enqueues a graph-persist job for an `inserted` outcome with forwarded entities", async () => {
		const { queue, enqueued } = recordingQueue();
		const outcome: ControlledWriteOutcome = { action: "inserted", memoryId: "mem_1" };

		await controlledWriteFanOut(queue)(
			jobWith({ entities: [{ source: "s", relationship: "r", target: "t" }] }),
			outcome,
		);

		expect(enqueued).toHaveLength(1);
		expect(enqueued[0].kind).toBe("memory_graph_persist");
		expect(enqueued[0].payload).toMatchObject({ org: "o1", workspace: "w1", agent_id: "a1", memoryId: "mem_1" });
		expect(enqueued[0].payload.entities).toEqual([{ source: "s", relationship: "r", target: "t" }]);
	});

	it("enqueues nothing for a skipped outcome (no committed memory to link to)", async () => {
		const { queue, enqueued } = recordingQueue();
		const outcome: ControlledWriteOutcome = { action: "skipped", reason: "below_confidence" };
		await controlledWriteFanOut(queue)(jobWith({ entities: [{ source: "s", relationship: "r", target: "t" }] }), outcome);
		expect(enqueued).toHaveLength(0);
	});

	it("enqueues nothing when a committed memory has no forwarded entities", async () => {
		const { queue, enqueued } = recordingQueue();
		const outcome: ControlledWriteOutcome = { action: "inserted", memoryId: "mem_1" };
		await controlledWriteFanOut(queue)(jobWith({ entities: [] }), outcome);
		expect(enqueued).toHaveLength(0);
	});
});

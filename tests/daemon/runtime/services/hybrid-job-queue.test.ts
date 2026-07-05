import { describe, expect, it } from "vitest";
import {
	createStageWorker,
	PIPELINE_JOB_KINDS,
	type StageHandlers,
} from "../../../../src/daemon/runtime/pipeline/stage-worker.js";
import {
	createHybridJobQueueService,
	DEFAULT_LOCAL_JOB_KINDS,
	type HybridJobQueueConfig,
	resolveHybridJobQueueConfig,
} from "../../../../src/daemon/runtime/services/hybrid-job-queue.js";
import type {
	JobInput,
	JobQueueService,
	JobQueueStats,
	LeasedJob,
} from "../../../../src/daemon/runtime/services/job-queue.js";
import { openLocalJobQueue } from "../../../../src/daemon/runtime/services/local-job-queue.js";

class RecordingQueue implements JobQueueService {
	readonly enqueued: JobInput[] = [];
	readonly leaseCalls: Array<readonly string[] | undefined> = [];
	readonly completed: string[] = [];
	readonly failed: Array<{ readonly id: string; readonly reason: string }> = [];
	readonly queued: LeasedJob[] = [];
	starts = 0;
	stops = 0;

	async enqueue(job: JobInput): Promise<string> {
		this.enqueued.push(job);
		return `shared-${this.enqueued.length}`;
	}

	async lease(kinds?: readonly string[]): Promise<LeasedJob | null> {
		this.leaseCalls.push(kinds);
		const idx = this.queued.findIndex((job) => kinds === undefined || kinds.includes(job.kind));
		if (idx < 0) return null;
		const [job] = this.queued.splice(idx, 1);
		return job ?? null;
	}

	async stats(): Promise<JobQueueStats> {
		return { byKind: [], total: 0 };
	}

	async complete(id: string, _leaseAttempt?: number): Promise<void> {
		this.completed.push(id);
	}

	async fail(id: string, reason: string, _leaseAttempt?: number): Promise<void> {
		this.failed.push({ id, reason });
	}

	start(): void {
		this.starts++;
	}

	stop(): void {
		this.stops++;
	}
}

function config(overrides: Partial<HybridJobQueueConfig> = {}): HybridJobQueueConfig {
	return {
		enabled: true,
		drainSharedLocalKinds: false,
		localKinds: new Set(DEFAULT_LOCAL_JOB_KINDS),
		...overrides,
	};
}

describe("PRD-066b hybrid job queue routing", () => {
	it("AC-1: local-only producers enqueue to the local queue instead of DeepLake when enabled", async () => {
		const shared = new RecordingQueue();
		const local = openLocalJobQueue({ memory: true });
		const queue = createHybridJobQueueService({ local, shared, config: config() });

		const id = await queue.enqueue({ kind: "summary", payload: { sessionId: "s1" } });

		expect(id).not.toMatch(/^shared-/);
		expect(shared.enqueued).toHaveLength(0);
		expect(await queue.lease(["summary"])).toMatchObject({ id, kind: "summary" });
		local.stop();
	});

	it("AC-2: local-only workers do not poll the shared queue when local queue is empty and drain mode is off", async () => {
		const shared = new RecordingQueue();
		const local = openLocalJobQueue({ memory: true });
		const queue = createHybridJobQueueService({ local, shared, config: config({ drainSharedLocalKinds: false }) });

		expect(await queue.lease(["summary"])).toBeNull();
		expect(shared.leaseCalls).toHaveLength(0);
		local.stop();
	});

	it("AC-2: local-only mode does not start the shared queue background reaper", () => {
		const shared = new RecordingQueue();
		const local = openLocalJobQueue({ memory: true });
		const queue = createHybridJobQueueService({ local, shared, config: config({ drainSharedLocalKinds: false }) });

		queue.start();
		queue.stop();

		expect(shared.starts).toBe(0);
		expect(shared.stops).toBe(1);
		local.stop();
	});

	it("AC-3: local jobs can still complete after handler-level work runs", async () => {
		const shared = new RecordingQueue();
		const local = openLocalJobQueue({ memory: true });
		const queue = createHybridJobQueueService({ local, shared, config: config() });
		const id = await queue.enqueue({ kind: "memory_controlled_write", payload: { memoryId: "m1" } });

		const leased = await queue.lease(["memory_controlled_write"]);
		expect(leased?.id).toBe(id);
		await queue.complete(id, leased?.attempt);

		expect(shared.completed).toHaveLength(0);
		expect(await queue.lease(["memory_controlled_write"])).toBeNull();
		local.stop();
	});

	it("AC-3: a failed local job can be retried locally and then completed locally", async () => {
		const shared = new RecordingQueue();
		const local = openLocalJobQueue({ memory: true, config: { backoffBaseMs: 0 } });
		const queue = createHybridJobQueueService({ local, shared, config: config() });
		const id = await queue.enqueue({ kind: "summary", payload: { sessionId: "s1" } });

		const first = await queue.lease(["summary"]);
		expect(first?.id).toBe(id);
		await queue.fail(id, "transient", first?.attempt);
		expect(shared.failed).toHaveLength(0);

		const second = await queue.lease(["summary"]);
		expect(second?.id).toBe(id);
		await queue.complete(id, second?.attempt);

		expect(shared.completed).toHaveLength(0);
		expect(await queue.lease(["summary"])).toBeNull();
		local.stop();
	});

	it("AC-3: a pipeline worker leased through the local queue still runs the memory-work handler", async () => {
		const shared = new RecordingQueue();
		const local = openLocalJobQueue({ memory: true });
		const queue = createHybridJobQueueService({ local, shared, config: config() });
		const handled: string[] = [];
		const handlers = Object.fromEntries(
			PIPELINE_JOB_KINDS.map((kind) => [
				kind,
				async (job: { readonly id: string }): Promise<void> => {
					if (kind === "memory_controlled_write") handled.push(job.id);
				},
			]),
		) as StageHandlers;
		const id = await queue.enqueue({ kind: "memory_controlled_write", payload: { org: "o", workspace: "w" } });
		const worker = createStageWorker({ queue, handlers });

		expect(await worker.runOnce()).toBe(true);

		expect(handled).toEqual([id]);
		expect(shared.leaseCalls).toHaveLength(0);
		local.stop();
	});

	it("AC-4: feature flag off preserves shared DeepLake-backed queue behavior", async () => {
		const shared = new RecordingQueue();
		const local = openLocalJobQueue({ memory: true });
		const queue = createHybridJobQueueService({ local, shared, config: config({ enabled: false }) });

		const id = await queue.enqueue({ kind: "summary", payload: { sessionId: "s1" } });

		expect(id).toBe("shared-1");
		expect(shared.enqueued).toHaveLength(1);
		expect(await queue.lease(["summary"])).toBeNull();
		expect(shared.leaseCalls).toEqual([["summary"]]);
		local.stop();
	});

	it("AC-5: migration drain mode can lease old local-kind jobs from the shared queue", async () => {
		const shared = new RecordingQueue();
		shared.queued.push({ id: "old-1", kind: "summary", payload: { sessionId: "s1" }, attempt: 1 });
		const local = openLocalJobQueue({ memory: true });
		const queue = createHybridJobQueueService({ local, shared, config: config({ drainSharedLocalKinds: true }) });

		const leased = await queue.lease(["summary"]);

		expect(leased?.id).toBe("old-1");
		expect(shared.leaseCalls).toEqual([["summary"]]);
		local.stop();
	});

	it("AC-5: migration drain mode starts the shared queue background reaper", () => {
		const shared = new RecordingQueue();
		const local = openLocalJobQueue({ memory: true });
		const queue = createHybridJobQueueService({ local, shared, config: config({ drainSharedLocalKinds: true }) });

		queue.start();
		queue.stop();

		expect(shared.starts).toBe(1);
		expect(shared.stops).toBe(1);
		local.stop();
	});

	it("AC-6: duplicate execution is avoided by leasing local before shared during migration", async () => {
		const shared = new RecordingQueue();
		shared.queued.push({ id: "old-1", kind: "summary", payload: { sessionId: "old" }, attempt: 1 });
		const local = openLocalJobQueue({ memory: true });
		const queue = createHybridJobQueueService({ local, shared, config: config({ drainSharedLocalKinds: true }) });
		const localId = await queue.enqueue({ kind: "summary", payload: { sessionId: "new" } });

		const leased = await queue.lease(["summary"]);

		expect(leased?.id).toBe(localId);
		expect(shared.leaseCalls).toHaveLength(0);
		local.stop();
	});

	it("AC-7: unknown job kinds fail closed to the shared path until classified", async () => {
		const shared = new RecordingQueue();
		const local = openLocalJobQueue({ memory: true });
		const queue = createHybridJobQueueService({ local, shared, config: config() });

		const id = await queue.enqueue({ kind: "future_shared_kind", payload: {} });
		await queue.lease(["future_shared_kind"]);

		expect(id).toBe("shared-1");
		expect(shared.enqueued.map((job) => job.kind)).toEqual(["future_shared_kind"]);
		expect(shared.leaseCalls).toEqual([["future_shared_kind"]]);
		local.stop();
	});

	it("lease without a kind filter falls back to shared work after local is empty", async () => {
		const shared = new RecordingQueue();
		shared.queued.push({ id: "shared-1", kind: "future_shared_kind", payload: {}, attempt: 1 });
		const local = openLocalJobQueue({ memory: true });
		const queue = createHybridJobQueueService({ local, shared, config: config({ drainSharedLocalKinds: false }) });

		const leased = await queue.lease();

		expect(leased?.id).toBe("shared-1");
		expect(shared.leaseCalls).toEqual([undefined]);
		local.stop();
	});

	it("parses local queue flags from env", () => {
		const parsed = resolveHybridJobQueueConfig({
			HONEYCOMB_LOCAL_QUEUE_ENABLED: "true",
			HONEYCOMB_LOCAL_QUEUE_DRAIN_SHARED: "1",
		});
		expect(parsed.enabled).toBe(true);
		expect(parsed.drainSharedLocalKinds).toBe(true);
		expect(parsed.localKinds.has("summary")).toBe(true);
	});
});

/** A JobQueueService fake whose `stats()` returns a scripted snapshot; every other method is inert. */
class StubStatsQueue extends RecordingQueue {
	constructor(private readonly snapshot: JobQueueStats) {
		super();
	}
	override async stats(): Promise<JobQueueStats> {
		return this.snapshot;
	}
}

describe("job-observability hybrid stats() merges local + shared", () => {
	it("sums total and unions distinct kinds across the two queues", async () => {
		const local = new StubStatsQueue({
			byKind: [{ kind: "summary", queued: 3, leased: 1, done: 2, failed: 0, dead: 0, total: 6 }],
			total: 6,
		});
		const shared = new StubStatsQueue({
			byKind: [{ kind: "distill", queued: 5, leased: 0, done: 1, failed: 1, dead: 2, total: 9 }],
			total: 9,
		});
		const queue = createHybridJobQueueService({ local, shared, config: config() });

		const stats = await queue.stats();
		expect(stats.total).toBe(15);
		expect(stats.byKind.find((k) => k.kind === "summary")).toEqual({
			kind: "summary",
			queued: 3,
			leased: 1,
			done: 2,
			failed: 0,
			dead: 0,
			total: 6,
		});
		expect(stats.byKind.find((k) => k.kind === "distill")).toEqual({
			kind: "distill",
			queued: 5,
			leased: 0,
			done: 1,
			failed: 1,
			dead: 2,
			total: 9,
		});
		// Sorted by descending total: distill (9) before summary (6).
		expect(stats.byKind.map((k) => k.kind)).toEqual(["distill", "summary"]);
	});

	it("defensively sums a kind that appears in BOTH queues (migration overlap)", async () => {
		const local = new StubStatsQueue({
			byKind: [{ kind: "summary", queued: 2, leased: 0, done: 1, failed: 0, dead: 0, total: 3 }],
			total: 3,
		});
		const shared = new StubStatsQueue({
			byKind: [{ kind: "summary", queued: 1, leased: 1, done: 0, failed: 2, dead: 1, total: 5 }],
			total: 5,
		});
		const queue = createHybridJobQueueService({ local, shared, config: config() });

		const stats = await queue.stats();
		expect(stats.total).toBe(8);
		expect(stats.byKind).toEqual([
			{ kind: "summary", queued: 3, leased: 1, done: 1, failed: 2, dead: 1, total: 8 },
		]);
	});
});

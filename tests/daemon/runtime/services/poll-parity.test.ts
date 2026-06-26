/**
 * PRD-062b AC-9 parity — with every PRD-062b flag OFF, the workers reproduce the
 * EXACT pre-PRD poll behavior: a flat 1000ms interval and TWO independent lease
 * passes (no consolidation), so any regression is a config rollback, not a redeploy.
 *
 * Verification posture:
 *   - The stage worker + pollinating worker are constructed with NO `backoff` (the
 *     schema's disabled default) and an injected one-shot timer recorder, so the
 *     scheduled cadence is asserted directly.
 *   - "Two independent lease passes" is proven by giving EACH worker its own fake
 *     queue and showing each leases ITS kinds on its own tick — there is no shared
 *     single pass when consolidation is off.
 *   - No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import type { JobInput, JobQueueService, LeasedJob } from "../../../../src/daemon/runtime/services/job-queue.js";
import { createStageWorker } from "../../../../src/daemon/runtime/pipeline/stage-worker.js";
import { createPollinatingWorker } from "../../../../src/daemon/runtime/pollinating/worker.js";
import type { PollinatingTriggerSeam } from "../../../../src/daemon/runtime/pollinating/worker.js";
import type { PollinatingConfig } from "../../../../src/daemon/runtime/pollinating/config.js";
import type { ModelClient } from "../../../../src/daemon/runtime/pipeline/model-client.js";
import type { StorageQuery } from "../../../../src/daemon/storage/client.js";

/** A timer recorder: captures the delay each `setTimer` was armed with. */
function timerRecorder() {
	const delays: number[] = [];
	return {
		delays,
		setTimer: (_cb: () => void, ms: number) => {
			delays.push(ms);
			return delays.length - 1;
		},
		clearTimer: () => {},
	};
}

/** A fake queue recording each lease call's kind filter; serves at most one job. */
class RecordingQueue implements JobQueueService {
	readonly leaseCalls: (readonly string[] | undefined)[] = [];
	constructor(private readonly job: LeasedJob | null = null) {}
	async enqueue(_job: JobInput): Promise<string> {
		return "noop";
	}
	async lease(kinds?: readonly string[]): Promise<LeasedJob | null> {
		this.leaseCalls.push(kinds);
		if (this.job === null) return null;
		if (kinds !== undefined && !kinds.includes(this.job.kind)) return null;
		return null; // never actually hand it back — this suite asserts the lease FILTER, not processing.
	}
	async complete(): Promise<void> {}
	async fail(): Promise<void> {}
	start(): void {}
	stop(): void {}
}

const POLLINATING_CONFIG: PollinatingConfig = {
	enabled: true,
	tokenThreshold: 100_000,
	maxInputTokens: 128_000,
	backfillOnFirstRun: true,
};

const noopTrigger: PollinatingTriggerSeam = {
	async readState() {
		return { id: "x", tokensSinceLastPass: 0, lastPassAt: "", pendingJobId: "", version: 0 };
	},
	async recordPassComplete() {},
};

const noopModel: ModelClient = {
	async complete() {
		return { text: "" };
	},
} as unknown as ModelClient;

const noopStorage = {
	async query() {
		return { kind: "ok", rows: [], durationMs: 0 } as Awaited<ReturnType<StorageQuery["query"]>>;
	},
} as StorageQuery;

describe("AC-9 parity: flags off ⇒ a flat 1000ms interval (the pre-PRD cadence)", () => {
	it("the stage worker schedules a single flat 1000ms interval when backoff is unset", () => {
		const timers = timerRecorder();
		const worker = createStageWorker({
			queue: new RecordingQueue(),
			handlers: {} as never,
			// no `backoff` → the schema's disabled default → the flat pre-PRD path.
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});
		worker.start();
		expect(timers.delays).toEqual([1_000]);
		worker.stop();
	});

	it("the pollinating worker schedules a single flat 1000ms interval when backoff is unset", () => {
		const timers = timerRecorder();
		const worker = createPollinatingWorker({
			queue: new RecordingQueue(),
			storage: noopStorage,
			scope: { org: "o", workspace: "w" },
			config: POLLINATING_CONFIG,
			model: noopModel,
			trigger: noopTrigger,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});
		worker.start();
		expect(timers.delays).toEqual([1_000]);
		worker.stop();
	});

	it("two independent workers each lease ONLY their own kinds (no consolidation off the flag)", async () => {
		// Each worker over its OWN queue: the stage worker leases the pipeline kinds, the
		// pollinating worker leases `['pollinating']`. Two separate lease passes — the
		// pre-PRD two-poller shape.
		const pipelineQueue = new RecordingQueue();
		const pollinatingQueue = new RecordingQueue();
		const stage = createStageWorker({ queue: pipelineQueue, handlers: {} as never });
		const pollinating = createPollinatingWorker({
			queue: pollinatingQueue,
			storage: noopStorage,
			scope: { org: "o", workspace: "w" },
			config: POLLINATING_CONFIG,
			model: noopModel,
			trigger: noopTrigger,
		});

		await stage.runOnce();
		await pollinating.runOnce();

		// The stage worker leased the five pipeline kinds; the pollinating worker leased
		// exactly `['pollinating']`. The two passes are independent — neither leased the
		// other's kinds (kind isolation, the pre-PRD invariant).
		expect(pipelineQueue.leaseCalls).toHaveLength(1);
		expect(pollinatingQueue.leaseCalls).toHaveLength(1);
		expect(pipelineQueue.leaseCalls[0]).not.toContain("pollinating");
		expect(pollinatingQueue.leaseCalls[0]).toEqual(["pollinating"]);
	});
});

/**
 * PRD-062b single combined lease coordinator — AC-4 (one poller, not two).
 *
 * Verification posture:
 *   - A fake {@link JobQueueService} records every `lease(kinds)` call and serves a
 *     scripted set of queued jobs, honoring the kind filter EXACTLY as the real
 *     queue does (a foreign kind is never returned), so the coordinator's kind
 *     isolation is proven against real filter semantics, not a mock that ignores it.
 *   - Two fake participants (pipeline kinds + pollinating kind) record which jobs
 *     they were dispatched, so the test asserts each leased job routed to its owner.
 *   - Maps to AC-62b.3.1 / AC-4 (one combined pass over both kind sets per tick,
 *     foreign kinds left queued) and the HONEYCOMB_POLL_CONSOLIDATE boundary (AC-9).
 *   - No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import type { JobInput, JobQueueService, LeasedJob } from "../../../../src/daemon/runtime/services/job-queue.js";
import {
	createLeaseCoordinator,
	type LeaseParticipant,
	PollConsolidateConfigSchema,
	resolvePollConsolidateConfig,
} from "../../../../src/daemon/runtime/services/lease-coordinator.js";
import { PollBackoffConfigSchema } from "../../../../src/daemon/runtime/services/poll-backoff.js";

const PIPELINE_KINDS = ["memory_extraction", "memory_decision"] as const;
const POLLINATING_KIND = "pollinating";

/**
 * A fake queue that serves scripted queued jobs and HONORS the kind filter exactly
 * as the real queue: `lease(kinds)` returns the oldest queued job whose kind is in
 * `kinds`, and NEVER a foreign kind. Records every `lease` call's kind set + every
 * completion so the test asserts the single-pass + isolation contract.
 */
class FakeQueue implements JobQueueService {
	readonly leaseCalls: (readonly string[] | undefined)[] = [];
	readonly completed: string[] = [];
	readonly failed: { id: string; reason: string }[] = [];
	private readonly queued: LeasedJob[];

	constructor(queued: LeasedJob[]) {
		this.queued = [...queued];
	}

	async enqueue(_job: JobInput): Promise<string> {
		return "noop";
	}

	async lease(kinds?: readonly string[]): Promise<LeasedJob | null> {
		this.leaseCalls.push(kinds);
		const idx = this.queued.findIndex((j) => kinds === undefined || kinds.includes(j.kind));
		if (idx === -1) return null;
		const [job] = this.queued.splice(idx, 1);
		return job;
	}

	async complete(id: string): Promise<void> {
		this.completed.push(id);
	}

	async fail(id: string, reason: string): Promise<void> {
		this.failed.push({ id, reason });
	}

	start(): void {
		/* no-op */
	}

	stop(): void {
		/* no-op */
	}

	/** What kinds are STILL queued (a foreign kind must remain here). */
	remainingKinds(): string[] {
		return this.queued.map((j) => j.kind);
	}
}

/** A recording participant: declares its kinds + records every job dispatched to it. */
function fakeParticipant(leaseKinds: readonly string[], queue: FakeQueue): LeaseParticipant & { ran: LeasedJob[] } {
	const ran: LeasedJob[] = [];
	return {
		leaseKinds,
		ran,
		async processLeased(leased: LeasedJob): Promise<void> {
			ran.push(leased);
			// Mirror a real participant: complete the job it was handed (the coordinator
			// never touches the queue for completion — the participant owns it).
			await queue.complete(leased.id);
		},
	};
}

function job(id: string, kind: string): LeasedJob {
	return { id, kind, payload: {}, attempt: 1 };
}

describe("LeaseCoordinator: AC-4 — one combined lease pass over both kind sets per tick", () => {
	it("AC-62b.3.1: a single runOnce leases the UNION of pipeline + pollinating kinds (one pass, not two)", async () => {
		const queue = new FakeQueue([job("p1", "memory_extraction")]);
		const pipeline = fakeParticipant(PIPELINE_KINDS, queue);
		const pollinating = fakeParticipant([POLLINATING_KIND], queue);
		const coordinator = createLeaseCoordinator({
			queue,
			participants: [pipeline, pollinating],
			backoff: PollBackoffConfigSchema.parse({}),
			flatIntervalMs: 1_000,
		});

		const processed = await coordinator.runOnce();

		expect(processed).toBe(true);
		// EXACTLY ONE lease call this tick — not one per participant.
		expect(queue.leaseCalls).toHaveLength(1);
		// That single call carried the UNION of every participant's kinds.
		expect([...(queue.leaseCalls[0] ?? [])].sort()).toEqual(
			[...PIPELINE_KINDS, POLLINATING_KIND].sort(),
		);
	});

	it("routes each leased kind to its OWNING participant (a pipeline job → pipeline, a pollinating job → pollinating)", async () => {
		const queue = new FakeQueue([job("p1", "memory_decision"), job("q1", "pollinating")]);
		const pipeline = fakeParticipant(PIPELINE_KINDS, queue);
		const pollinating = fakeParticipant([POLLINATING_KIND], queue);
		const coordinator = createLeaseCoordinator({
			queue,
			participants: [pipeline, pollinating],
			backoff: PollBackoffConfigSchema.parse({}),
			flatIntervalMs: 1_000,
		});

		// Two ticks drain the two jobs (one lease pass each), each routed to its owner.
		await coordinator.runOnce();
		await coordinator.runOnce();

		expect(pipeline.ran.map((j) => j.id)).toEqual(["p1"]);
		expect(pollinating.ran.map((j) => j.id)).toEqual(["q1"]);
		expect(queue.completed.sort()).toEqual(["p1", "q1"]);
	});

	it("AC-4 isolation: a FOREIGN kind (summary) is NEVER leased and stays queued for its own worker", async () => {
		const queue = new FakeQueue([job("s1", "summary"), job("p1", "memory_extraction")]);
		const pipeline = fakeParticipant(PIPELINE_KINDS, queue);
		const pollinating = fakeParticipant([POLLINATING_KIND], queue);
		const coordinator = createLeaseCoordinator({
			queue,
			participants: [pipeline, pollinating],
			backoff: PollBackoffConfigSchema.parse({}),
			flatIntervalMs: 1_000,
		});

		// Drain everything the coordinator CAN lease.
		expect(await coordinator.runOnce()).toBe(true); // leases p1 (the only owned kind).
		expect(await coordinator.runOnce()).toBe(false); // summary is foreign → nothing leasable.

		// The pipeline job ran; the summary job was NEVER leased and is STILL queued.
		expect(pipeline.ran.map((j) => j.id)).toEqual(["p1"]);
		expect(pollinating.ran).toHaveLength(0);
		expect(queue.remainingKinds()).toEqual(["summary"]);
		// The union the coordinator leased NEVER contained `summary`.
		for (const call of queue.leaseCalls) {
			expect(call).not.toContain("summary");
		}
	});

	it("returns false (no job processed) when the combined pass leases nothing", async () => {
		const queue = new FakeQueue([]);
		const coordinator = createLeaseCoordinator({
			queue,
			participants: [fakeParticipant(PIPELINE_KINDS, queue)],
			backoff: PollBackoffConfigSchema.parse({}),
			flatIntervalMs: 1_000,
		});
		expect(await coordinator.runOnce()).toBe(false);
		expect(queue.leaseCalls).toHaveLength(1); // one combined pass, then idle.
	});

	it("fails a leased kind no participant owns rather than silently completing it (never a swallowed error)", async () => {
		// A queue that yields a kind outside the union it was asked for (a wiring bug).
		const queue = new FakeQueue([]);
		const orphan = job("x1", "memory_extraction");
		// Force the queue to hand back a job whose kind has no route by overriding lease once.
		let handed = false;
		queue.lease = async (kinds?: readonly string[]) => {
			queue.leaseCalls.push(kinds);
			if (handed) return null;
			handed = true;
			return orphan;
		};
		const coordinator = createLeaseCoordinator({
			queue,
			// No participant owns `memory_extraction` → the leased job has no route.
			participants: [fakeParticipant([POLLINATING_KIND], queue)],
			backoff: PollBackoffConfigSchema.parse({}),
			flatIntervalMs: 1_000,
		});

		const processed = await coordinator.runOnce();
		expect(processed).toBe(true);
		expect(queue.failed).toHaveLength(1);
		expect(queue.failed[0].id).toBe("x1");
		expect(queue.completed).toHaveLength(0); // never silently completed.
	});
});

describe("resolvePollConsolidateConfig: the HONEYCOMB_POLL_CONSOLIDATE boundary (AC-9)", () => {
	it("a bare schema parse defaults to DISABLED (the AC-9 two-pass parity path)", () => {
		expect(PollConsolidateConfigSchema.parse({}).enabled).toBe(false);
	});

	it("an explicit enabled:'false' / '0' rolls back to the two independent passes", () => {
		expect(resolvePollConsolidateConfig({ read: () => ({ enabled: "false" }) }).enabled).toBe(false);
		expect(resolvePollConsolidateConfig({ read: () => ({ enabled: "0" }) }).enabled).toBe(false);
	});

	it("enabled:'true' / '1' enables consolidation", () => {
		expect(resolvePollConsolidateConfig({ read: () => ({ enabled: "true" }) }).enabled).toBe(true);
		expect(resolvePollConsolidateConfig({ read: () => ({ enabled: "1" }) }).enabled).toBe(true);
	});
});

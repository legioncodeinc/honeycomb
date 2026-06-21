/**
 * PRD-026 Wave 1 Track B — the daemon-resident DREAMING JOB WORKER (AC-W).
 *
 * These tests pin the WORKER contract: it leases ONLY `["dreaming"]` (never a foreign
 * kind), parses the queued payload defensively (malformed → fail, never silent
 * complete), selects the strategy by mode (incremental ‖ compaction/backfill-first-run),
 * runs the REAL runner end-to-end (model call → 008c apply → state update), and
 * completes/fails the job. The factory constructs without starting.
 *
 * Verification posture (mirrors the runner harness test):
 *   - A FAKE queue holding the dreaming job, recording the `kinds` arg `lease` got and
 *     which terminal method (`complete`/`fail`) fired.
 *   - The PRD-002 fake transport (`FakeDeepLakeTransport`) wrapped in a real
 *     `StorageClient` for the runner's `submitProposal` apply path (byte-identical SQL,
 *     no live network).
 *   - A FAKE `ModelClient` (`createFakeModelClient`) returning a canned mutation set so
 *     we can assert the `memory_dreaming` workload WAS called.
 *   - A FAKE trigger seam recording `readState` (drives the backfill rule) +
 *     `recordPassComplete` (the b-AC-5 state write).
 *   - Each `describe` is named after the AC it proves. No `.skip` / `.only`.
 */

import { describe, expect, it } from "vitest";

import { createStorageClient, type QueryScope, type StorageQuery } from "../../../../src/daemon/storage/index.js";
import type { StorageRow } from "../../../../src/daemon/storage/result.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";
import { createFakeModelClient } from "../../../../src/daemon/runtime/pipeline/model-client.js";
import type { DreamingConfig } from "../../../../src/daemon/runtime/dreaming/config.js";
import type { LeasedJob } from "../../../../src/daemon/runtime/services/job-queue.js";
import {
	createDreamingWorker,
	type DreamingTriggerSeam,
} from "../../../../src/daemon/runtime/dreaming/worker.js";
import type { DreamingScope, DreamingState } from "../../../../src/daemon/runtime/dreaming/trigger.js";

const SCOPE: QueryScope = { org: "test-org", workspace: "test-ws" };

/** Everything absent / every mutation succeeds — the "all new" world (008c apply path). */
const allNew = (): StorageRow[] => [];

/**
 * A responder that feeds the INCREMENTAL strategy one new `memory` summary so its
 * `loadPayload` assembles a non-null payload (it returns null when there are zero new
 * summaries), while leaving every other read empty (the 008c apply path's "all new"
 * world). Used by the incremental-path tests that need the model to actually be called.
 */
const oneSummary = (req: TransportRequest): StorageRow[] =>
	/FROM\s+"?memory"?/i.test(req.sql)
		? [{ summary: "did a thing", creation_date: "2026-01-02T00:00:00.000Z" }]
		: [];

function storageWith(responder: (req: TransportRequest) => StorageRow[]): {
	storage: StorageQuery;
	transport: FakeDeepLakeTransport;
} {
	const transport = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ provider: stubProvider(fakeCredentialRecord()), transport });
	return { storage, transport };
}

/** A resolved dreaming config with overridable knobs (the worker only reads three). */
function config(over: Partial<DreamingConfig> = {}): DreamingConfig {
	return {
		enabled: true,
		tokenThreshold: 100_000,
		maxInputTokens: 128_000,
		backfillOnFirstRun: true,
		...over,
	};
}

/**
 * A FAKE durable queue holding AT MOST one job. Records the `kinds` arg `lease` was
 * called with + which terminal method fired. `lease(kinds)` honors the kind filter:
 * it returns the held job only when its kind is in `kinds` (or `kinds` is undefined),
 * leaving a non-matching job un-leased — exactly the real queue's contract.
 */
class FakeQueue {
	readonly leaseKinds: (readonly string[] | undefined)[] = [];
	completed: string[] = [];
	failed: { id: string; reason: string }[] = [];
	private job: LeasedJob | null;
	private leasedOnce = false;

	constructor(job: LeasedJob | null) {
		this.job = job;
	}

	async enqueue(): Promise<string> {
		return "noop";
	}

	async lease(kinds?: readonly string[]): Promise<LeasedJob | null> {
		this.leaseKinds.push(kinds);
		if (this.job === null || this.leasedOnce) return null;
		// Honor the kind filter exactly as the real queue does.
		if (kinds !== undefined && !kinds.includes(this.job.kind)) return null;
		this.leasedOnce = true;
		return this.job;
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
}

/** A FAKE trigger seam recording readState + recordPassComplete, with a scripted lastPassAt. */
class FakeTrigger implements DreamingTriggerSeam {
	readonly recorded: { agentId: string; passAt: string }[] = [];
	readonly readScopes: DreamingScope[] = [];
	constructor(private readonly lastPassAt = "") {}

	async readState(scope: DreamingScope): Promise<DreamingState> {
		this.readScopes.push(scope);
		return {
			id: `dream_${scope.agentId}`,
			tokensSinceLastPass: 0,
			lastPassAt: this.lastPassAt,
			pendingJobId: "",
			version: this.lastPassAt === "" ? 0 : 1,
		};
	}

	async recordPassComplete(scope: DreamingScope, passAt: string): Promise<void> {
		this.recorded.push({ agentId: scope.agentId, passAt });
	}
}

/** A dreaming job as it sits on the queue (payload is the trigger's enqueue body). */
function dreamingJob(mode: "incremental" | "compaction", agentId = "agent-alpha"): LeasedJob {
	return {
		id: "job-1",
		kind: "dreaming",
		attempt: 1,
		payload: { mode, agentId, enqueuedAt: "2026-01-01T00:00:00.000Z", tokensAtEnqueue: 120_000 },
	};
}

// A canned mutation set: one additive create + one destructive merge.
const CANNED_BODY = JSON.stringify({
	summary: "folded a dup; added one entity",
	mutations: [
		{ kind: "create_entity", payload: { name: "Honeycomb", type: "project" }, rationale: "missing", confidence: 0.9 },
		{ kind: "merge_entities", payload: { from: "ent_a", into: "ent_b" }, rationale: "duplicates", confidence: 0.95 },
	],
});

describe("AC-W dreaming worker — runOnce leases ['dreaming'], runs the runner, completes", () => {
	it("a single dreaming job → memory_dreaming called, runner ran, complete() once", async () => {
		const { storage, transport } = storageWith(oneSummary);
		const queue = new FakeQueue(dreamingJob("incremental"));
		const model = createFakeModelClient({ memory_dreaming: CANNED_BODY });
		const trigger = new FakeTrigger("2025-12-01T00:00:00.000Z"); // has a prior pass → incremental.

		const worker = createDreamingWorker({ queue, storage, scope: SCOPE, config: config(), model, trigger });
		const processed = await worker.runOnce();

		expect(processed).toBe(true);
		// The model WAS called with the memory_dreaming workload (the stronger target).
		expect(model.calls).toHaveLength(1);
		expect(model.calls[0].workload).toBe("memory_dreaming");
		// The runner applied the mutation set through 008c — a proposal INSERT landed.
		expect(transport.requests.some((r) => /INSERT/i.test(r.sql) && /ontology_proposals/i.test(r.sql))).toBe(true);
		// The job was completed exactly once, never failed.
		expect(queue.completed).toEqual(["job-1"]);
		expect(queue.failed).toEqual([]);
		// The state-updater (via the trigger seam) fired once on success (b-AC-5).
		expect(trigger.recorded).toHaveLength(1);
		expect(trigger.recorded[0].agentId).toBe("agent-alpha");
	});

	it("leases with the ['dreaming'] kind filter — never a generic lease", async () => {
		const { storage } = storageWith(allNew);
		const queue = new FakeQueue(dreamingJob("incremental"));
		const model = createFakeModelClient({ memory_dreaming: CANNED_BODY });
		const worker = createDreamingWorker({
			queue,
			storage,
			scope: SCOPE,
			config: config(),
			model,
			trigger: new FakeTrigger("2025-12-01T00:00:00.000Z"),
		});

		await worker.runOnce();

		// The worker passed exactly ["dreaming"] to lease — the foreign-kind guard.
		expect(queue.leaseKinds).toHaveLength(1);
		expect(queue.leaseKinds[0]).toEqual(["dreaming"]);
	});

	it("a foreign-kind job in the queue is never leased by the dreaming worker", async () => {
		const { storage } = storageWith(allNew);
		// A summary job sits in the queue; the kind filter must skip it.
		const summaryJob: LeasedJob = { id: "sum-1", kind: "summary", attempt: 1, payload: {} };
		const queue = new FakeQueue(summaryJob);
		const model = createFakeModelClient({ memory_dreaming: CANNED_BODY });
		const worker = createDreamingWorker({
			queue,
			storage,
			scope: SCOPE,
			config: config(),
			model,
			trigger: new FakeTrigger(),
		});

		const processed = await worker.runOnce();

		// Nothing leasable for this worker → no work, no model call, no fail.
		expect(processed).toBe(false);
		expect(model.calls).toHaveLength(0);
		expect(queue.completed).toEqual([]);
		expect(queue.failed).toEqual([]);
	});
});

describe("AC-W dreaming worker — malformed payload fails the job (never silent complete)", () => {
	it("an unparseable dreaming payload → queue.fail, never complete, never the model", async () => {
		const { storage } = storageWith(allNew);
		// `mode` is not a valid enum member → parseDreamingJobPayload returns null.
		const badJob: LeasedJob = {
			id: "job-bad",
			kind: "dreaming",
			attempt: 1,
			payload: { mode: 42, agentId: 99 },
		};
		const queue = new FakeQueue(badJob);
		const model = createFakeModelClient({ memory_dreaming: CANNED_BODY });
		const worker = createDreamingWorker({
			queue,
			storage,
			scope: SCOPE,
			config: config(),
			model,
			trigger: new FakeTrigger(),
		});

		const processed = await worker.runOnce();

		expect(processed).toBe(true); // a job WAS handled (failed) — the loop made progress.
		expect(queue.failed).toHaveLength(1);
		expect(queue.failed[0].id).toBe("job-bad");
		expect(queue.completed).toEqual([]); // NEVER silently completed.
		expect(model.calls).toHaveLength(0); // never reached the model.
	});
});

describe("AC-W dreaming worker — mode selection (D-4 / backfill-first-run)", () => {
	it("first run (backfillOnFirstRun + empty last_pass_at) selects COMPACTION", async () => {
		const { storage } = storageWith(allNew);
		// An incremental-mode payload, but no prior pass → the backfill rule lifts it to compaction.
		const queue = new FakeQueue(dreamingJob("incremental"));
		// Compaction needs a non-empty graph to call the model — feed entities so the
		// compaction strategy's loadPayload returns a payload (not null).
		const withGraph = (req: TransportRequest): StorageRow[] =>
			/FROM\s+"?entities"?/i.test(req.sql) ? [{ id: "ent_1", name: "Acme", type: "company" }] : [];
		const sg = storageWith(withGraph);
		const model = createFakeModelClient({ memory_dreaming: '{"mutations":[],"summary":"compacted"}' });
		const trigger = new FakeTrigger(""); // empty last_pass_at → first run.

		const worker = createDreamingWorker({
			queue,
			storage: sg.storage,
			scope: SCOPE,
			config: config({ backfillOnFirstRun: true }),
			model,
			trigger,
		});
		await worker.runOnce();

		// The model was called (the compaction strategy assembled a non-null payload over
		// the seeded graph) and the job completed.
		expect(model.calls).toHaveLength(1);
		expect(model.calls[0].workload).toBe("memory_dreaming");
		// The compaction prompt is the full-graph prompt (its system preamble is distinctive).
		expect(model.calls[0].prompt).toContain("compaction dreaming agent");
		expect(queue.completed).toEqual(["job-1"]);
		// The backfill rule consulted the trigger's readState for this scope.
		expect(trigger.readScopes.some((s) => s.agentId === "agent-alpha")).toBe(true);
		// `storage` (the unseeded one) is unused on this path; reference it so the lint stays honest.
		expect(storage).toBeDefined();
	});

	it("steady state (prior last_pass_at) selects INCREMENTAL", async () => {
		// Incremental needs at least one new summary to assemble a payload; otherwise it
		// returns null and the runner records an empty pass (no model call). Seed a summary.
		const withSummary = (req: TransportRequest): StorageRow[] =>
			/FROM\s+"?memory"?/i.test(req.sql) ? [{ summary: "did a thing", creation_date: "2026-01-02T00:00:00.000Z" }] : [];
		const sg = storageWith(withSummary);
		const queue = new FakeQueue(dreamingJob("incremental"));
		const model = createFakeModelClient({ memory_dreaming: '{"mutations":[],"summary":"incr"}' });
		const trigger = new FakeTrigger("2025-12-01T00:00:00.000Z"); // prior pass → incremental.

		const worker = createDreamingWorker({
			queue,
			storage: sg.storage,
			scope: SCOPE,
			config: config({ backfillOnFirstRun: true }),
			model,
			trigger,
		});
		await worker.runOnce();

		expect(model.calls).toHaveLength(1);
		// The incremental prompt carries the DREAMING.md task framing, NOT the compaction preamble.
		expect(model.calls[0].prompt).not.toContain("compaction dreaming agent");
		expect(model.calls[0].prompt).toContain("DREAMING");
		expect(queue.completed).toEqual(["job-1"]);
	});

	it("an explicit compaction-mode payload selects COMPACTION regardless of last_pass_at", async () => {
		const withGraph = (req: TransportRequest): StorageRow[] =>
			/FROM\s+"?entities"?/i.test(req.sql) ? [{ id: "ent_1", name: "Acme", type: "company" }] : [];
		const sg = storageWith(withGraph);
		const queue = new FakeQueue(dreamingJob("compaction"));
		const model = createFakeModelClient({ memory_dreaming: '{"mutations":[],"summary":"compacted"}' });
		// A prior pass exists, so the backfill rule would NOT fire — but the explicit mode wins.
		const trigger = new FakeTrigger("2025-12-01T00:00:00.000Z");

		const worker = createDreamingWorker({
			queue,
			storage: sg.storage,
			scope: SCOPE,
			config: config(),
			model,
			trigger,
		});
		await worker.runOnce();

		expect(model.calls[0].prompt).toContain("compaction dreaming agent");
		expect(queue.completed).toEqual(["job-1"]);
	});
});

describe("AC-W dreaming worker — factory constructs without starting (assembly owns the gate)", () => {
	it("createDreamingWorker builds a worker that has NOT polled the queue", async () => {
		const { storage } = storageWith(allNew);
		const queue = new FakeQueue(dreamingJob("incremental"));
		const worker = createDreamingWorker({
			queue,
			storage,
			scope: SCOPE,
			config: config(),
			model: createFakeModelClient(),
			trigger: new FakeTrigger(),
		});

		// Construction alone leases NOTHING — only start()/runOnce() touches the queue.
		expect(queue.leaseKinds).toHaveLength(0);
		expect(typeof worker.runOnce).toBe("function");
		expect(typeof worker.start).toBe("function");
		expect(typeof worker.stop).toBe("function");
	});

	it("on a runner throw the worker fails the job (backoff/dead semantics), never completes", async () => {
		// The runner is drop-invalid for a bad model body AND resilient to a single mutation's
		// apply failure (it records a `failed` outcome, never throwing). A GENUINE pass failure
		// is the state write at the end — inject a stateUpdater that throws there. The worker's
		// try/catch must route it to queue.fail (the stage-worker shape), never silent-complete.
		const { storage } = storageWith(oneSummary);
		const queue = new FakeQueue(dreamingJob("incremental"));
		const model = createFakeModelClient({ memory_dreaming: CANNED_BODY });
		const throwingUpdater = {
			recordPassComplete(): Promise<void> {
				return Promise.reject(new Error("state write boom"));
			},
		};
		const worker = createDreamingWorker({
			queue,
			storage,
			scope: SCOPE,
			config: config(),
			model,
			trigger: new FakeTrigger("2025-12-01T00:00:00.000Z"),
			stateUpdater: throwingUpdater,
		});

		const processed = await worker.runOnce();
		expect(processed).toBe(true);
		expect(queue.failed).toHaveLength(1);
		expect(queue.failed[0].id).toBe("job-1");
		expect(queue.failed[0].reason).toContain("state write boom");
		expect(queue.completed).toEqual([]);
	});
});

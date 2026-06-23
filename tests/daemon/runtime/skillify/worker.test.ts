/**
 * PRD-045f — the daemon-resident SKILLIFY worker, deterministic unit suite (runs in `npm run ci`).
 *
 * The end-to-end wiring (lease → mine → append-only row) is proven by
 * `tests/integration/skillify-worker-mine-live.itest.ts` (an `.itest.ts`, excluded from CI). THIS
 * suite is the in-CI guard for two robustness contracts CodeRabbit flagged on PR #82:
 *
 *   - f-AC-4 boundary completeness: the lease + payload-parse + watermark-read that precede the
 *     mine must be INSIDE the fail-routing try — a throw there fails the leased job, never an
 *     unhandled rejection out of `runOnce()` (which would surface in the timer loop).
 *   - idempotent `start()`: a second `start()` while a timer is live must be a no-op, so `stop()`
 *     leaves NO live timer (a double-start previously leaked the first interval).
 */

import { describe, expect, it } from "vitest";

import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import {
	createFakeGateCli,
	type GateVerdict,
	type SessionFetcher,
	type SessionRow,
	type SkillStore,
	type Skill,
	type WatermarkStore,
} from "../../../../src/daemon/runtime/skillify/index.js";
import {
	type JobInput,
	type JobQueueService,
	type LeasedJob,
} from "../../../../src/daemon/runtime/services/job-queue.js";
import { createSkillifyJobWorker } from "../../../../src/daemon/runtime/skillify/worker.js";

const SCOPE: QueryScope = { org: "o-skf", workspace: "ws-skf" };

/** A KEEP verdict the faked gate returns (only reached when the watermark read succeeds). */
function keepVerdict(): GateVerdict {
	return { decision: "KEEP", name: "u", body: "## u\nbody", description: "d", triggerText: "t" };
}

/** The skillify-cue payload capture enqueues (turn-counters' `MemoryCue` shape). */
function skillifyJob(sessionId: string, path: string): JobInput {
	return { kind: "skillify", payload: { sessionId, path, count: 5 } };
}

/** A `sessions`-row envelope (the verbatim `{ event, metadata }` JSONB). */
function row(path: string, session: string, kind: string, text: string, date: string): SessionRow {
	return {
		path,
		sessionId: session,
		message: JSON.stringify({ event: { kind, text }, metadata: { sessionId: session, path } }),
		author: "alice",
		creationDate: date,
	};
}

/** Six rows = three pairs, clearing the KEEP ≥3-exchange floor. */
function sixPairs(path: string, session: string): readonly SessionRow[] {
	return [
		row(path, session, "user_message", "how do I retry?", "2026-01-01T00:00:00Z"),
		row(path, session, "assistant_message", "wrap it in withRetry()", "2026-01-01T00:00:01Z"),
		row(path, session, "user_message", "and the backoff?", "2026-01-01T00:00:02Z"),
		row(path, session, "assistant_message", "exponential, capped", "2026-01-01T00:00:03Z"),
		row(path, session, "user_message", "where do I put it?", "2026-01-01T00:00:04Z"),
		row(path, session, "assistant_message", "the storage client wrapper", "2026-01-01T00:00:05Z"),
	];
}

/** A fetcher returning canned rows. */
function fakeFetcher(rows: readonly SessionRow[]): SessionFetcher {
	return { fetch: async (): Promise<readonly SessionRow[]> => rows };
}

/** A storage stub the seam-overridden worker never touches. */
const UNUSED_STORAGE: StorageQuery = {
	query: async () => {
		throw new Error("storage must not be touched when fetcher/store are overridden");
	},
};

/** A recording fake queue: enqueue → kind-filtered lease → complete/fail (in-memory). */
function fakeQueue(): JobQueueService & {
	readonly completed: string[];
	readonly failed: { id: string; reason: string }[];
} {
	const jobs = new Map<string, { job: LeasedJob; status: "queued" | "leased" }>();
	const completed: string[] = [];
	const failed: { id: string; reason: string }[] = [];
	let seq = 0;
	return {
		completed,
		failed,
		async enqueue(job: JobInput): Promise<string> {
			const id = `fake-job-${++seq}`;
			jobs.set(id, { job: { id, kind: job.kind, payload: job.payload, attempt: 1 }, status: "queued" });
			return id;
		},
		async lease(kinds?: readonly string[]): Promise<LeasedJob | null> {
			for (const [, entry] of jobs) {
				if (entry.status !== "queued") continue;
				if (kinds !== undefined && !kinds.includes(entry.job.kind)) continue;
				entry.status = "leased";
				return entry.job;
			}
			return null;
		},
		async complete(id: string): Promise<void> {
			completed.push(id);
		},
		async fail(id: string, reason: string): Promise<void> {
			failed.push({ id, reason });
		},
		start(): void {},
		stop(): void {},
	};
}

/** An in-memory append-only skill store mirroring `createSkillStore`'s contract. */
function fakeSkillStore(): SkillStore & { readonly rows: Skill[] } {
	const rows: Skill[] = [];
	return {
		rows,
		async maxVersion(id: string): Promise<number> {
			return rows.filter((s) => s.id === id).reduce((m, s) => Math.max(m, s.provenance.version), 0);
		},
		async readActive(id: string): Promise<Skill | null> {
			const mine = rows.filter((s) => s.id === id);
			if (mine.length === 0) return null;
			return mine.reduce((a, b) => (b.provenance.version >= a.provenance.version ? b : a));
		},
		async appendVersion(skill: Skill): Promise<number> {
			rows.push(skill);
			return skill.provenance.version;
		},
	};
}

// ════════════════════════════════════════════════════════════════════════════
// f-AC-4: a throw in the pre-mine lease/parse/watermark path is fail-routed.
// ════════════════════════════════════════════════════════════════════════════

describe("PRD-045f skillify worker — pre-mine throws are fail-routed, never an unhandled rejection", () => {
	it("a throwing watermark.read() FAILS the leased job and runOnce() resolves (not rejects)", async () => {
		const queue = fakeQueue();
		const store = fakeSkillStore();
		const id = await queue.enqueue(skillifyJob("sess-wm", "proj-wm"));

		// The watermark read touches the filesystem in production; here it throws. Before the fix
		// it ran BEFORE the try → the throw bypassed fail-routing and rejected runOnce() (an
		// unhandled rejection in the timer loop). It must now route to queue.fail.
		const throwingWatermark: WatermarkStore = {
			read(): string | null {
				throw new Error("watermark read failed (disk)");
			},
			advance(): string | null {
				return null;
			},
		};

		const worker = createSkillifyJobWorker({
			queue,
			storage: UNUSED_STORAGE,
			scope: SCOPE,
			gateSpec: { command: "noop", args: [] },
			lock: { acquire: () => ({ release: () => {} }) },
			watermark: throwingWatermark,
			author: "alice",
			gateOverride: createFakeGateCli(keepVerdict()),
			fetcherOverride: fakeFetcher(sixPairs("proj-wm", "sess-wm")),
			storeOverride: store,
		});

		// RESOLVES (does not reject) — the daemon is never crashed, the timer loop never sees an
		// unhandled rejection (f-AC-4).
		const processed = await worker.runOnce();
		expect(processed, "the leased job was processed (failed), not dropped").toBe(true);

		// The job was FAILED with the watermark error; nothing was completed, nothing written.
		expect(queue.failed.map((f) => f.id), "the watermark-read throw routes to queue.fail").toContain(id);
		expect(queue.failed[0]?.reason).toMatch(/watermark read failed/);
		expect(queue.completed).toHaveLength(0);
		expect(store.rows).toHaveLength(0);
	});

	it("a throwing lease() degrades to 'nothing leasable' (false), never an unhandled rejection", async () => {
		const base = fakeQueue();
		// A queue whose lease() throws — there is no leased job to fail-route, so runOnce must
		// resolve false rather than reject.
		const throwingLeaseQueue: JobQueueService = {
			...base,
			async lease(): Promise<LeasedJob | null> {
				throw new Error("lease transport error");
			},
		};

		const worker = createSkillifyJobWorker({
			queue: throwingLeaseQueue,
			storage: UNUSED_STORAGE,
			scope: SCOPE,
			gateSpec: { command: "noop", args: [] },
			lock: { acquire: () => ({ release: () => {} }) },
			watermark: { read: () => null, advance: () => null },
			author: "alice",
			gateOverride: createFakeGateCli(keepVerdict()),
			fetcherOverride: fakeFetcher([]),
			storeOverride: fakeSkillStore(),
		});

		const processed = await worker.runOnce();
		expect(processed, "a lease throw degrades to 'nothing leasable'").toBe(false);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Idempotent start(): a double start() then stop() leaves NO live timer.
// ════════════════════════════════════════════════════════════════════════════

describe("PRD-045f skillify worker — start() is idempotent (no leaked interval)", () => {
	it("double start() then stop() leaves no live timer (the first interval is not leaked)", () => {
		// Track every handle the worker schedules + which were cleared, so a leaked interval
		// (a handle scheduled but never cleared) is observable.
		const live = new Set<number>();
		let nextHandle = 0;
		const setTimer = (_cb: () => void, _ms: number): unknown => {
			const h = ++nextHandle;
			live.add(h);
			return h;
		};
		const clearTimer = (handle: unknown): void => {
			live.delete(handle as number);
		};

		const worker = createSkillifyJobWorker({
			queue: fakeQueue(),
			storage: UNUSED_STORAGE,
			scope: SCOPE,
			gateSpec: { command: "noop", args: [] },
			lock: { acquire: () => ({ release: () => {} }) },
			watermark: { read: () => null, advance: () => null },
			author: "alice",
			gateOverride: createFakeGateCli(keepVerdict()),
			fetcherOverride: fakeFetcher([]),
			storeOverride: fakeSkillStore(),
			setTimer,
			clearTimer,
		});

		worker.start();
		worker.start(); // second start MUST be a no-op (guarded), not a second scheduled timer.
		expect(nextHandle, "the second start() scheduled NO new timer (idempotent)").toBe(1);

		worker.stop();
		expect(live.size, "stop() clears the single live timer — none leaked").toBe(0);
	});
});

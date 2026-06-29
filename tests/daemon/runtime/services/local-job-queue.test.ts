/**
 * PRD-066a local daemon queue store.
 *
 * Runs against temp-dir and in-memory `node:sqlite`, never DeepLake.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	LOCAL_JOB_DONE,
	LOCAL_JOB_FAILED,
	LOCAL_JOB_LEASED,
	LOCAL_JOB_QUEUED,
	LOCAL_JOB_RETRYING,
	LOCAL_QUEUE_DAEMON_DIR_NAME,
	LOCAL_QUEUE_DB_FILE_NAME,
	NULL_LOCAL_JOB_QUEUE,
	openLocalJobQueue,
	type LocalJobQueueClock,
} from "../../../../src/daemon/runtime/services/local-job-queue.js";

let dir: string;
let nowMs: number;
const clock: LocalJobQueueClock = { now: () => nowMs };

function advance(ms: number): void {
	nowMs += ms;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-localqueue-"));
	nowMs = Date.parse("2026-06-29T12:00:00.000Z");
});

afterEach(() => {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort temp cleanup
	}
});

describe("PRD-066a local queue persistence", () => {
	it("AC-1: enqueued jobs survive close and reopen of the same .daemon/local-queue.db", async () => {
		const first = openLocalJobQueue({ baseDir: dir, clock, config: { owner: "first" } });
		const id = await first.enqueue({ kind: "summary", payload: { sessionId: "s1" } });
		first.close();

		const second = openLocalJobQueue({ baseDir: dir, clock, config: { owner: "second" } });
		const leased = await second.lease(["summary"]);
		expect(leased).toEqual({ id, kind: "summary", payload: { sessionId: "s1" }, attempt: 1 });
		second.close();
		expect(existsSync(join(dir, LOCAL_QUEUE_DAEMON_DIR_NAME, LOCAL_QUEUE_DB_FILE_NAME))).toBe(true);
	});

	it("AC-8: enqueue, lease, complete, and counts use local SQLite only", async () => {
		const queue = openLocalJobQueue({ memory: true, clock });
		await queue.enqueue({ kind: "summary", payload: { sessionId: "s1" } });
		expect((await queue.counts()).byStatus[LOCAL_JOB_QUEUED]).toBe(1);

		const leased = await queue.lease(["summary"]);
		expect(leased?.attempt).toBe(1);
		expect((await queue.counts()).byStatus[LOCAL_JOB_LEASED]).toBe(1);

		await queue.complete(leased?.id ?? "missing");
		const counts = await queue.counts();
		expect(counts.byStatus[LOCAL_JOB_DONE]).toBe(1);
		expect(counts.byKind.summary).toBe(1);
		queue.close();
	});
});

describe("PRD-066a local queue leasing", () => {
	it("AC-2: two concurrent lease attempts cannot successfully lease the same job", async () => {
		const queue = openLocalJobQueue({ memory: true, clock, config: { owner: "owner-a" } });
		await queue.enqueue({ kind: "summary", payload: { sessionId: "s1" } });

		const [a, b] = await Promise.all([queue.lease(["summary"]), queue.lease(["summary"])]);
		const leased = [a, b].filter((job) => job !== null);
		expect(leased).toHaveLength(1);
		expect(leased[0]?.kind).toBe("summary");
		queue.close();
	});

	it("AC-3: a leased job is invisible until it completes or expires", async () => {
		const queue = openLocalJobQueue({ memory: true, clock, config: { owner: "owner-a", leaseMs: 1000 } });
		await queue.enqueue({ kind: "summary", payload: { sessionId: "s1" } });
		const first = await queue.lease(["summary"]);
		expect(first).not.toBeNull();
		expect(await queue.lease(["summary"])).toBeNull();

		await queue.complete(first?.id ?? "missing");
		expect(await queue.lease(["summary"])).toBeNull();
		queue.close();
	});

	it("AC-4: an expired lease can be reclaimed and retried", async () => {
		const queue = openLocalJobQueue({ memory: true, clock, config: { owner: "owner-a", leaseMs: 1000 } });
		await queue.enqueue({ kind: "summary", payload: { sessionId: "s1" } });
		const first = await queue.lease(["summary"]);
		expect(first?.attempt).toBe(1);

		advance(1001);
		expect(await queue.reclaimExpiredLeases()).toBe(1);
		const second = await queue.lease(["summary"]);
		expect(second?.id).toBe(first?.id);
		expect(second?.attempt).toBe(2);
		queue.close();
	});

	it("AC-8: failed jobs retry with backoff and eventually exhaust to failed", async () => {
		const queue = openLocalJobQueue({
			memory: true,
			clock,
			config: { owner: "owner-a", maxAttempts: 2, backoffBaseMs: 1000, backoffCapMs: 1000 },
		});
		const id = await queue.enqueue({ kind: "summary", payload: { sessionId: "s1" } });
		const first = await queue.lease(["summary"]);
		expect(first?.id).toBe(id);
		await queue.fail(id, "transient");
		expect((await queue.counts()).byStatus[LOCAL_JOB_RETRYING]).toBe(1);
		expect(await queue.lease(["summary"])).toBeNull();

		advance(1000);
		const second = await queue.lease(["summary"]);
		expect(second?.attempt).toBe(2);
		await queue.fail(id, "fatal");
		const counts = await queue.counts();
		expect(counts.byStatus[LOCAL_JOB_FAILED]).toBe(1);
		expect(await queue.lease(["summary"])).toBeNull();
		queue.close();
	});
});

describe("PRD-066a retention and validation", () => {
	it("AC-5: completed jobs are pruned after the configured retention window", async () => {
		const queue = openLocalJobQueue({ memory: true, clock, config: { completedRetentionMs: 1000 } });
		const id = await queue.enqueue({ kind: "summary", payload: { sessionId: "s1" } });
		await queue.lease(["summary"]);
		await queue.complete(id);
		expect((await queue.counts()).byStatus[LOCAL_JOB_DONE]).toBe(1);

		advance(1001);
		expect(await queue.pruneCompleted()).toBe(1);
		expect((await queue.counts()).byStatus[LOCAL_JOB_DONE]).toBe(0);
		queue.close();
	});

	it("AC-6: invalid payloads are rejected before entering the queue", async () => {
		const queue = openLocalJobQueue({ memory: true, clock });
		await expect(queue.enqueue({ kind: "summary", payload: [] as unknown as Record<string, unknown> })).rejects.toThrow();
		expect((await queue.counts()).byStatus[LOCAL_JOB_QUEUED]).toBe(0);
		queue.close();
	});

	it("AC-7: payloads containing secret-like fields are rejected before entering the queue", async () => {
		const queue = openLocalJobQueue({ memory: true, clock });
		await expect(
			queue.enqueue({
				kind: "summary",
				payload: { nested: { deeplakeToken: "do-not-store" } },
			}),
		).rejects.toThrow(/secret-like field/i);
		expect((await queue.counts()).byStatus[LOCAL_JOB_QUEUED]).toBe(0);
		queue.close();
	});

	it("the NULL queue fails closed for writes and returns empty diagnostics", async () => {
		await expect(NULL_LOCAL_JOB_QUEUE.enqueue({ kind: "x", payload: {} })).rejects.toThrow(/unavailable/);
		expect(await NULL_LOCAL_JOB_QUEUE.lease()).toBeNull();
		expect(await NULL_LOCAL_JOB_QUEUE.counts()).toEqual({
			byStatus: {
				queued: 0,
				retrying: 0,
				leased: 0,
				done: 0,
				failed: 0,
			},
			byKind: {},
		});
	});
});


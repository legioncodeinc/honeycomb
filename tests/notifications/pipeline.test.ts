/**
 * PRD-020d notifications pipeline — the fail-soft, bounded SessionStart drain.
 *
 * Drives `createNotificationsPipeline` against the in-memory fakes (`createFakeClaimLock`,
 * `createFakeNotificationsState`, `createFakeBackendSource`) + a fake source/clock so each AC is
 * deterministic:
 *   - d-AC-1 racing procs → claim lock → exactly one banner (win + EEXIST-skip paths);
 *   - d-AC-3 hung backend → ~1.5s timeout, session proceeds (fake clock, no real wall time);
 *   - d-AC-4 persistent welcome shown once (state suppresses the re-show);
 *   - d-AC-5 transient warning re-emits while the cause persists (no state record + claim released).
 */

import { describe, expect, it } from "vitest";

import {
	createFakeClaimLock,
	createFakeNotificationsState,
	createNotificationsPipeline,
	type Notification,
	type NotificationSource,
	type PersistentRecord,
	type PipelineDepsFull,
	type TimeoutClock,
} from "../../src/notifications/index.js";

/** A local rule source that replays canned notifications (the "primary-banner" fetch). */
function ruleSource(notifications: readonly Notification[]): NotificationSource {
	return { async fetch() { return notifications; } };
}

/** A backend source that NEVER resolves (the hung backend, d-AC-3). */
function hangingBackend(): { fetch(): Promise<readonly Notification[]> } {
	return { fetch: () => new Promise<readonly Notification[]>(() => {}) };
}

/** A manual clock: timeouts fire only when `flush()` is called (deterministic d-AC-3). */
function manualClock(): TimeoutClock & { flush(): void; readonly pending: number } {
	const cbs = new Set<() => void>();
	return {
		setTimeout(cb: () => void): unknown {
			cbs.add(cb);
			return cb;
		},
		clear(handle: unknown): void {
			cbs.delete(handle as () => void);
		},
		flush(): void {
			for (const cb of [...cbs]) cb();
		},
		get pending(): number {
			return cbs.size;
		},
	};
}

const WELCOME: Notification = { id: "welcome", kind: "persistent", text: "Welcome!", priority: 10, dedupKey: "welcome:v1" };
const PAYMENT: Notification = { id: "payment-fail", kind: "transient", text: "Payment failed", priority: 50 };

describe("d-AC-1: racing procs → claim lock → exactly one banner", () => {
	it("d-AC-1 two pipelines sharing one claim lock emit the banner exactly once (win + skip)", async () => {
		const lock = createFakeClaimLock(); // ONE shared lock = the cross-process claim file.
		const mk = (): PipelineDepsFull => ({
			state: createFakeNotificationsState(),
			lock,
			backend: { async fetch() { return []; } },
			rules: ruleSource([PAYMENT]),
		});
		const a = createNotificationsPipeline(mk());
		const b = createNotificationsPipeline(mk());

		const [ra, rb] = await Promise.all([a.drain("session_start"), b.drain("session_start")]);

		// Exactly one of the two racers shows the banner; the other is suppressed (EEXIST-skip).
		const winners = [ra.banner, rb.banner].filter((x) => x !== null);
		expect(winners).toHaveLength(1);
		expect(winners[0]?.id).toBe("payment-fail");
		const losers = [ra, rb].filter((r) => r.banner === null);
		expect(losers[0]?.suppressed).toContain("payment-fail");
	});
});

describe("d-AC-3: hung backend → ~1.5s timeout, session proceeds", () => {
	it("d-AC-3 a never-resolving backend is bounded by the timeout; the drain still completes", async () => {
		const clock = manualClock();
		const pipeline = createNotificationsPipeline({
			state: createFakeNotificationsState(),
			lock: createFakeClaimLock(),
			backend: hangingBackend(),
			rules: ruleSource([WELCOME]),
			timeoutMs: 1500,
			clock,
		});

		const drained = pipeline.drain("session_start");
		// The drain is awaiting the hung backend's ~1.5s timeout. Fire the fake timers.
		await Promise.resolve();
		expect(clock.pending).toBeGreaterThan(0); // the ~1.5s timer is armed.
		clock.flush();

		const result = await drained; // resolves WITHOUT real wall time → session proceeds.
		// The local rule banner still fires; the hung backend contributed nothing (fail-soft).
		expect(result.banner?.id).toBe("welcome");
	});

	it("d-AC-3 a backend that REJECTS is swallowed; the drain never rejects", async () => {
		const pipeline = createNotificationsPipeline({
			state: createFakeNotificationsState(),
			lock: createFakeClaimLock(),
			backend: { fetch: () => Promise.reject(new Error("backend 500")) },
			rules: ruleSource([WELCOME]),
		});
		await expect(pipeline.drain("session_start")).resolves.toBeTruthy();
	});
});

describe("d-AC-4: persistent welcome shown once", () => {
	it("d-AC-4 a first drain shows welcome + records it; a second drain suppresses the re-show", async () => {
		const state = createFakeNotificationsState();
		const mk = (): PipelineDepsFull => ({
			state,
			lock: createFakeClaimLock(), // a fresh lock each session (release-on-drain is irrelevant here).
			backend: { async fetch() { return []; } },
			rules: ruleSource([WELCOME]),
		});

		const first = await createNotificationsPipeline(mk()).drain("session_start");
		expect(first.banner?.id).toBe("welcome");
		expect(state.wasShown("welcome:v1")).toBe(true); // recorded as shown.

		const second = await createNotificationsPipeline(mk()).drain("session_start");
		expect(second.banner).toBeNull(); // show-once: never shown again (d-AC-4).
		expect(second.suppressed).toContain("welcome");
	});

	it("d-AC-4 a persistent already-seen at start is suppressed", async () => {
		const seed: Record<string, PersistentRecord> = {
			"welcome:v1": { id: "welcome", dedupKey: "welcome:v1", shownAt: "2026-06-18T00:00:00.000Z" },
		};
		const pipeline = createNotificationsPipeline({
			state: createFakeNotificationsState(seed),
			lock: createFakeClaimLock(),
			backend: { async fetch() { return []; } },
			rules: ruleSource([WELCOME]),
		});
		const r = await pipeline.drain("session_start");
		expect(r.banner).toBeNull();
	});
});

describe("d-AC-5: transient warning re-emits while the cause persists", () => {
	it("d-AC-5 a transient re-emits on the next session (no state record; claim released on drain)", async () => {
		const state = createFakeNotificationsState();
		const lock = createFakeClaimLock(); // a persistent lock across BOTH sessions.
		const mk = (): PipelineDepsFull => ({
			state,
			lock,
			backend: { async fetch() { return []; } },
			rules: ruleSource([PAYMENT]), // the cause persists → the rule keeps producing it.
		});

		const first = await createNotificationsPipeline(mk()).drain("session_start");
		expect(first.banner?.id).toBe("payment-fail");
		// Transient → NOT recorded in state (no show-once), so re-emit is gated only by the claim.
		expect(state.wasShown("payment-fail")).toBe(false);

		// The SESSION BOUNDARY releases the transient claim (FR-6: `releaseClaim` unlinks the claim
		// file so a future session re-emits while the cause persists). The pipeline never releases
		// mid-drain — that is what keeps racing procs to exactly one banner (d-AC-1).
		lock.release("notif-payment-fail");

		const second = await createNotificationsPipeline(mk()).drain("session_start");
		expect(second.banner?.id).toBe("payment-fail"); // re-emits while the cause persists (d-AC-5).
	});
});

describe("priority model — the highest-priority eligible candidate wins", () => {
	it("picks the higher-priority banner across sources; id breaks ties deterministically", async () => {
		const low: Notification = { id: "a", kind: "transient", text: "low", priority: 1 };
		const high: Notification = { id: "b", kind: "transient", text: "high", priority: 99 };
		const tieA: Notification = { id: "aaa", kind: "transient", text: "tieA", priority: 99 };
		const pipeline = createNotificationsPipeline({
			state: createFakeNotificationsState(),
			lock: createFakeClaimLock(),
			backend: createBackend([low]),
			rules: ruleSource([high]),
			queue: ruleSource([tieA]),
		});
		const r = await pipeline.drain("session_start");
		// Two at priority 99: "aaa" < "b" lexicographically → "aaa" wins the tie-break.
		expect(r.banner?.id).toBe("aaa");
	});
});

/** A backend source replaying canned notifications. */
function createBackend(notifications: readonly Notification[]): { fetch(): Promise<readonly Notification[]> } {
	return { async fetch() { return notifications; } };
}

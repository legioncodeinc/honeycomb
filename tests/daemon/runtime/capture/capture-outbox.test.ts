/**
 * PRD-079a — the durable capture retry outbox (a-AC-1 .. a-AC-7).
 *
 * Two verification layers:
 *   1. OUTBOX UNIT (temp-dir / in-memory `node:sqlite`, injected clock, stub storage) — the store +
 *      drainer mechanics: enqueue-on-failure, fail-then-succeed drain, bounded backoff + due-skipping,
 *      persist-across-restart, idempotent replay, secret-free events + health shape.
 *   2. HANDLER WIRING (in-process `daemon.app.request(...)` against the PRD-002 fake transport) — proves
 *      a failing storage stub routes the rows to the outbox (count grows) instead of only `recordDropped`,
 *      and that a THROWING outbox leaves the capture ack intact and never throws.
 *
 * `vitest run` passes `--experimental-sqlite` to the worker (vitest.config.ts), so `node:sqlite` is live.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import type { QueryOptions, QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import { ok, type QueryResult, timeoutResult } from "../../../../src/daemon/storage/result.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { TransportError } from "../../../../src/daemon/storage/transport.js";
import { type RowValues, val } from "../../../../src/daemon/storage/writes.js";
import { type CaptureHandler, createCaptureHandler } from "../../../../src/daemon/runtime/capture/capture-handler.js";
import {
	CAPTURE_OUTBOX_MAX_DRAIN_PER_INTERVAL_ENV,
	CAPTURE_OUTBOX_MAX_ROWS_ENV,
	type CaptureOutboxSink,
	DEFAULT_OUTBOX_MAX_DRAIN_PER_INTERVAL,
	DEFAULT_OUTBOX_MAX_ROWS,
	type OutboxClock,
	openCaptureOutbox,
	resolveCaptureOutboxLimits,
} from "../../../../src/daemon/runtime/capture/capture-outbox.js";
import {
	LOCAL_QUEUE_DAEMON_DIR_NAME,
	LOCAL_QUEUE_DB_FILE_NAME,
} from "../../../../src/daemon/runtime/services/local-job-queue.js";
import type { JobInput, JobQueueService, LeasedJob } from "../../../../src/daemon/runtime/services/job-queue.js";
import type { CaptureConfig } from "../../../../src/daemon/runtime/capture/capture-config.js";
import type { BufferClock, TimerHandle } from "../../../../src/daemon/runtime/capture/capture-buffer.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createRuntimePathService } from "../../../../src/daemon/runtime/middleware/runtime-path.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

// ── Shared fixtures ──────────────────────────────────────────────────────────

const SESSIONS_TARGET = healTargetFor("sessions");
const SCOPE: QueryScope = { org: "org-a", workspace: "ws-a" };

/** A recorded structured event (name + fields) so a test can assert the secret-free `capture.outbox.*` shape. */
interface RecordedEvent {
	readonly name: string;
	readonly fields: Readonly<Record<string, unknown>>;
}

function recordingLogger(): { logger: { event(name: string, fields?: Readonly<Record<string, unknown>>): void }; events: RecordedEvent[] } {
	const events: RecordedEvent[] = [];
	return {
		logger: {
			event(name: string, fields: Readonly<Record<string, unknown>> = {}): void {
				events.push({ name, fields });
			},
		},
		events,
	};
}

/** A controllable clock + interval seam so the drainer never sleeps for real. */
function fakeClock(startMs: number): OutboxClock & { advance(ms: number): void; set(ms: number): void } {
	let nowMs = startMs;
	return {
		now: () => nowMs,
		// The unit suite drives `drainDue()` directly, so the interval is a no-op handle here.
		setInterval: () => 1,
		clearInterval: () => {},
		advance(ms: number): void {
			nowMs += ms;
		},
		set(ms: number): void {
			nowMs = ms;
		},
	};
}

/** A stub WRITE client whose `sessions` append outcome is switchable (fail = degraded window, ok = recovered). */
function stubStorage(): { storage: StorageQuery; setMode(m: "fail" | "ok"): void; appends: number } {
	const state = { mode: "fail" as "fail" | "ok", appends: 0 };
	const storage: StorageQuery = {
		async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			if (/^\s*INSERT\s+INTO\s+"sessions"/i.test(sql)) {
				state.appends += 1;
				// A `timeout` result classifies as "other" in withHeal → returned unchanged (no heal path).
				return state.mode === "ok" ? ok([], 1) : timeoutResult(10_000);
			}
			return ok([], 1);
		},
	};
	return {
		storage,
		setMode: (m) => {
			state.mode = m;
		},
		get appends() {
			return state.appends;
		},
	};
}

/** A WRITE client whose `sessions` append ALWAYS THROWS (a rejecting transport), counting each attempt. */
function throwingStorage(): { storage: StorageQuery; appends: number } {
	const state = { appends: 0 };
	const storage: StorageQuery = {
		async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			if (/^\s*INSERT\s+INTO\s+"sessions"/i.test(sql)) {
				state.appends += 1;
				throw new Error("append rejected (degraded window)");
			}
			return ok([], 1);
		},
	};
	return {
		storage,
		get appends() {
			return state.appends;
		},
	};
}

/** Build a `sessions` row carrying its deterministic `id` (as `buildRow` does). */
function sessionRow(id: string, text = "hello"): RowValues {
	return [
		["id", val.str(id)],
		["path", val.str("conversations/s1")],
		["message", val.text(text)],
		["creation_date", val.str("2026-07-11T00:00:00.000Z")],
	];
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-capture-outbox-"));
});
afterEach(() => {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort temp cleanup
	}
});

// ── a-AC-1: a failed append is enqueued into the outbox (count grows) ─────────

describe("a-AC-1: a failed capture append is enqueued into the durable outbox", () => {
	it("enqueue persists the rows and the pending count grows", () => {
		const { storage } = stubStorage();
		const outbox = openCaptureOutbox({ storage, sessionsTarget: SESSIONS_TARGET, memory: true });
		const res = outbox.enqueue([sessionRow("a"), sessionRow("b")], SCOPE);
		expect(res).toEqual({ enqueued: 2, dropped: 0 });
		expect(outbox.counts()).toEqual({ pending: 2, retrying: 0, deadLettered: 0 });
		outbox.close();
	});

	it("HANDLER: a failed batched flush routes the row to the outbox (pending grows), not only recordDropped", async () => {
		const { storage } = stubStorage(); // the outbox's own client is unused here (no drain); the daemon's fake fails.
		const outbox = openCaptureOutbox({ storage, sessionsTarget: SESSIONS_TARGET, memory: true });
		const clock = new FakeBufferClock();
		const { daemon, handler, dropped } = buildHandlerDaemon({ outbox, config: BATCH_ON, bufferClock: clock });
		// The capture is ACKED fast (201) — the buffered row flushes off the hot path.
		const res = await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify(userBody("a turn that will not persist")),
		});
		expect(res.status).toBe(201);
		// Force the flush (the degraded window): the append fails → the row is DEFERRED to the outbox.
		await handler.flush();
		expect(outbox.counts().pending).toBe(1);
		// Deferred, not lost → NOT counted as a hard drop (the honest metric).
		expect(dropped.read()).toBe(0);
		outbox.close();
	});
});

// ── a-AC-2: the drainer re-attempts and drains to empty across two ticks ──────

describe("a-AC-2: the drainer drains a fail-then-succeed backlog to empty", () => {
	it("first tick (backend still failing) keeps the row; second tick (recovered) drains it", async () => {
		const stub = stubStorage();
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const outbox = openCaptureOutbox({ storage: stub.storage, sessionsTarget: SESSIONS_TARGET, memory: true, clock });

		outbox.enqueue([sessionRow("a")], SCOPE);
		expect(outbox.counts().pending).toBe(1);

		// Tick 1: the window is still degraded → the re-append fails, the row stays, attempts bumps.
		const first = await outbox.drainDue();
		expect(first).toEqual({ drained: 0, retried: 1, deadLettered: 0 });
		expect(outbox.counts()).toEqual({ pending: 1, retrying: 1, deadLettered: 0 });

		// The backend recovers; advance past the backoff so the row is due again, then drain.
		stub.setMode("ok");
		clock.advance(10 * 60 * 1000);
		const second = await outbox.drainDue();
		expect(second).toEqual({ drained: 1, retried: 0, deadLettered: 0 });
		expect(outbox.counts()).toEqual({ pending: 0, retrying: 0, deadLettered: 0 });
		outbox.close();
	});
});

// ── a-AC-3: bounded backoff grows; a not-yet-due row is skipped ───────────────

describe("a-AC-3: bounded exponential backoff; not-yet-due rows are skipped", () => {
	it("next_attempt_at grows per failed attempt and a future row is not attempted", async () => {
		const stub = stubStorage(); // stays failing
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const outbox = openCaptureOutbox({
			storage: stub.storage,
			sessionsTarget: SESSIONS_TARGET,
			memory: true,
			clock,
			backoff: { baseMs: 1_000, capMs: 60_000 },
		});
		outbox.enqueue([sessionRow("a")], SCOPE);

		// Attempt 1 fails → next_attempt_at pushed out ~base (1s). Immediately draining again is a NO-OP
		// because the row is not yet due (a persistent degraded window cannot hot-loop the write client).
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 1, deadLettered: 0 });
		const appendsAfterFirst = stub.appends;
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 0, deadLettered: 0 }); // not due → skipped
		expect(stub.appends, "no second append while the row is not due").toBe(appendsAfterFirst);

		// Advance past attempt-1 backoff (1s) → due → attempt 2 fails, pushes out ~2s (grows).
		clock.advance(1_000);
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 1, deadLettered: 0 });
		// 1s later is NOT enough for the attempt-2 (2s) backoff → still skipped (backoff grew).
		clock.advance(1_000);
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 0, deadLettered: 0 });
		// One more second (2s total since attempt 2) → due again.
		clock.advance(1_000);
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 1, deadLettered: 0 });
		outbox.close();
	});

	it("the backoff delay saturates at capMs and stops growing (does not grow unboundedly)", async () => {
		const stub = stubStorage(); // stays failing
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const base = 1_000;
		const cap = 4_000; // small so the test is fast: delays go 1s, 2s, 4s, 4s, 4s, … (pinned at 4s)
		const outbox = openCaptureOutbox({
			storage: stub.storage,
			sessionsTarget: SESSIONS_TARGET,
			memory: true,
			clock,
			backoff: { baseMs: base, capMs: cap },
		});
		outbox.enqueue([sessionRow("cap-me")], SCOPE);

		// Drive several failures well past the point the delay would exceed the cap if it kept doubling
		// (attempt 3 already reaches 4s = cap; attempt 7 would be 64s uncapped). Advance by `cap` each time
		// so the row is always due regardless of the current (≤ cap) delay.
		for (let i = 0; i < 6; i++) {
			expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 1, deadLettered: 0 });
			clock.advance(cap);
		}

		// Prove the delay is PINNED at exactly cap, not still doubling: after the next failure the row is
		// due at +cap. At cap-1 it is NOT due (skipped); one more ms and it IS due — so the delay == cap,
		// never grew past it (an unbounded backoff would leave the row un-due for far longer than cap).
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 1, deadLettered: 0 });
		clock.advance(cap - 1);
		expect(await outbox.drainDue(), "not yet due at cap-1 → the delay is at least cap").toEqual({
			drained: 0,
			retried: 0,
			deadLettered: 0,
		});
		clock.advance(1);
		expect(await outbox.drainDue(), "due at exactly +cap → the delay is EXACTLY cap, not still growing").toEqual({
			drained: 0,
			retried: 1,
			deadLettered: 0,
		});
		outbox.close();
	});
});

// ── FIX-1 (a-AC-3 hardening): a THROWING append is a normal failed attempt, never a pass abort/hot-loop

describe("a THROWING append (append rejects) is routed as a normal failed attempt, not a pass abort", () => {
	it("a rejecting storage still increments attempts + pushes backoff for EVERY leased row (no hot-loop)", async () => {
		const stub = throwingStorage();
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const { logger, events } = recordingLogger();
		const outbox = openCaptureOutbox({
			storage: stub.storage,
			sessionsTarget: SESSIONS_TARGET,
			memory: true,
			clock,
			logger,
			backoff: { baseMs: 1_000, capMs: 60_000 },
		});
		// TWO rows of DIFFERENT column shapes so PRD-079c coalescing puts them in TWO groups → TWO group
		// appends. The pre-fix bug (a throw escaping to the pass-level catch) would leave the SECOND group
		// unattempted and NEITHER row's backoff pushed → the next pass re-leases + hot-loops.
		outbox.enqueue([sessionRow("x"), assistantRow("y")], SCOPE);

		// Every group append REJECTS. With the fix, each rejection is a NORMAL failed attempt: both groups
		// are attempted (the pass is not aborted), each member gets attempts+1 + a pushed-out next_attempt_at.
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 2, deadLettered: 0 });
		expect(stub.appends, "both groups were attempted — the pass did not abort on the first throw").toBe(2);
		expect(outbox.counts()).toEqual({ pending: 2, retrying: 2, deadLettered: 0 });

		// No hot-loop: both rows now carry a FUTURE next_attempt_at, so an immediate second pass attempts
		// NEITHER (a persistent throwing window cannot spin the write client).
		const appendsAfterFirstPass = stub.appends;
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 0, deadLettered: 0 });
		expect(stub.appends, "a throwing window cannot hot-loop the write client").toBe(appendsAfterFirstPass);

		// The failures were routed through the normal retry path (secret-free `retry` events, one per row),
		// NOT the pass-level `drain_failed` escape the pre-fix code would emit.
		expect(events.filter((e) => e.name === "capture.outbox.retry")).toHaveLength(2);
		expect(events.some((e) => e.name === "capture.outbox.drain_failed")).toBe(false);
		outbox.close();
	});
});

// ── a-AC-4: persist across close / reopen, drain on the next boot ─────────────

describe("a-AC-4: queued captures survive a stop/start and drain on the next boot", () => {
	it("enqueue, close, reopen the SAME home-anchored db, and drain the persisted row", async () => {
		const stub = stubStorage();
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));

		const first = openCaptureOutbox({ storage: stub.storage, sessionsTarget: SESSIONS_TARGET, baseDir: dir, clock });
		first.enqueue([sessionRow("persist-me")], SCOPE);
		expect(first.counts().pending).toBe(1);
		first.close();

		// The db file lives at the SAME home-anchored path the local queue uses (D-1/D-5).
		expect(existsSync(join(dir, LOCAL_QUEUE_DAEMON_DIR_NAME, LOCAL_QUEUE_DB_FILE_NAME))).toBe(true);

		// Reopen: the persisted row is still queued, and drains once the backend is up.
		stub.setMode("ok");
		const second = openCaptureOutbox({ storage: stub.storage, sessionsTarget: SESSIONS_TARGET, baseDir: dir, clock });
		expect(second.counts().pending).toBe(1);
		expect(await second.drainDue()).toEqual({ drained: 1, retried: 0, deadLettered: 0 });
		expect(second.counts().pending).toBe(0);
		second.close();
	});
});

// ── a-AC-5: fail-soft — a throwing outbox never breaks capture ────────────────

describe("a-AC-5: an outbox fault never breaks the capture path", () => {
	it("a throwing outbox stub leaves the capture ack intact and does not throw", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const throwingOutbox: CaptureOutboxSink = {
				enqueue(): never {
					throw new Error("disk full");
				},
			};
			const { logger, events } = recordingLogger();
			const clock = new FakeBufferClock();
			const { daemon, handler, dropped } = buildHandlerDaemon({
				outbox: throwingOutbox,
				logger,
				config: BATCH_ON,
				bufferClock: clock,
			});
			// The capture is ACKED fast (201) — the buffered write happens off the hot path.
			const res = await daemon.app.request("/api/hooks/capture", {
				method: "POST",
				headers: sessionHeaders(),
				body: JSON.stringify(userBody("turn that will not persist")),
			});
			expect(res.status).toBe(201); // ack intact — the outbox fault never reached the hook.
			// Force the flush: the append fails, the outbox THROWS — the throw is swallowed, never surfaced.
			await expect(handler.flush()).resolves.toBeUndefined();
			await new Promise((r) => setTimeout(r, 0));
			// The row could not be persisted anywhere → counted a real drop, the fault logged, nothing escaped.
			expect(dropped.read()).toBe(1);
			expect(events.some((e) => e.name === "capture.outbox.enqueue_failed")).toBe(true);
			expect(unhandled, "NO unhandled rejection escaped — the daemon survives").toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("openCaptureOutbox degrades to a no-op when the substrate cannot open (traversal-guarded baseDir)", () => {
		const { storage } = stubStorage();
		// An untrusted baseDir trips the local-queue trusted-root guard → open fails → inert no-op outbox.
		const outbox = openCaptureOutbox({ storage, sessionsTarget: SESSIONS_TARGET, baseDir: "/definitely/not/trusted" });
		const res = outbox.enqueue([sessionRow("a")], SCOPE);
		expect(res).toEqual({ enqueued: 0, dropped: 1 }); // nothing persisted → the caller counts the drop
		expect(outbox.counts()).toEqual({ pending: 0, retrying: 0, deadLettered: 0 });
		outbox.close();
	});
});

// ── a-AC-6: idempotent replay keeps the original id (INSERT OR IGNORE dedups) ─

describe("a-AC-6: idempotent replay keeps the original id and never duplicates", () => {
	it("re-enqueuing the SAME row (same makeRowId) is a no-op, not a duplicate", () => {
		const { storage } = stubStorage();
		const outbox = openCaptureOutbox({ storage, sessionsTarget: SESSIONS_TARGET, memory: true });
		outbox.enqueue([sessionRow("stable-id", "first")], SCOPE);
		// A re-enqueue under the SAME id must dedup (INSERT OR IGNORE) — the backlog stays 1.
		const replay = outbox.enqueue([sessionRow("stable-id", "second")], SCOPE);
		expect(replay).toEqual({ enqueued: 1, dropped: 0 }); // handled (present), not a drop
		expect(outbox.counts().pending).toBe(1);
		outbox.close();
	});

	it("the drained append replays the ORIGINAL row id, not a fresh one", async () => {
		const stub = stubStorage();
		const appended: string[] = [];
		// Wrap the stub to capture the exact append SQL so we can assert the id survives the round-trip.
		const capturing: StorageQuery = {
			async query(sql, scope, opts) {
				if (/^\s*INSERT\s+INTO\s+"sessions"/i.test(sql)) appended.push(sql);
				return stub.storage.query(sql, scope, opts);
			},
		};
		stub.setMode("ok");
		const outbox = openCaptureOutbox({ storage: capturing, sessionsTarget: SESSIONS_TARGET, memory: true });
		outbox.enqueue([sessionRow("keep-this-id")], SCOPE);
		await outbox.drainDue();
		expect(appended).toHaveLength(1);
		expect(appended[0]).toContain("'keep-this-id'"); // the original deterministic id, replayed verbatim
		outbox.close();
	});
});

// ── a-AC-7: observability — health shape + secret-free events ─────────────────

describe("a-AC-7: observability is secret-free (health shape + events)", () => {
	it("counts() reports { pending, retrying } and the drainer events carry no content/scope", async () => {
		const stub = stubStorage();
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const { logger, events } = recordingLogger();
		const outbox = openCaptureOutbox({
			storage: stub.storage,
			sessionsTarget: SESSIONS_TARGET,
			memory: true,
			clock,
			logger,
		});
		outbox.enqueue([sessionRow("secret-content-here")], { org: "sekret-org", workspace: "sekret-ws" });

		// Health shape: exactly the two counts.
		expect(outbox.counts()).toEqual({ pending: 1, retrying: 0, deadLettered: 0 });

		// Tick 1 fails → a `retry` event; recover + advance → a `drained` event.
		await outbox.drainDue();
		stub.setMode("ok");
		clock.advance(10 * 60 * 1000);
		await outbox.drainDue();

		const names = events.map((e) => e.name);
		expect(names).toContain("capture.outbox.enqueued");
		expect(names).toContain("capture.outbox.retry");
		expect(names).toContain("capture.outbox.drained");

		// No event field may carry message content, an org, or a workspace string (secret-free — a-AC-7).
		for (const e of events) {
			const blob = JSON.stringify(e.fields);
			expect(blob, `${e.name} leaks content`).not.toContain("secret-content-here");
			expect(blob, `${e.name} leaks org`).not.toContain("sekret-org");
			expect(blob, `${e.name} leaks workspace`).not.toContain("sekret-ws");
		}
		// Allowed keys only: counts / durations / attempt.
		const allowed = new Set(["count", "durationMs", "attempt", "reason"]);
		for (const e of events) {
			for (const key of Object.keys(e.fields)) {
				expect(allowed.has(key), `${e.name}.${key} is not an allow-listed field`).toBe(true);
			}
		}
		outbox.close();
	});
});

// ── Handler wiring helpers (mirrors capture-batching.test.ts) ─────────────────

const ORG = "org-a";
const WORKSPACE = "ws-a";

/** Batched capture config (production posture) — the flush-failure branch is the findings §5 drop point. */
const BATCH_ON: CaptureConfig = { batch: true, windowMs: 1_000, maxEvents: 25, envelopeBudgetBytes: 16_384 };
/** Immediate (non-batched) capture config — the append lands (or 502s) synchronously in handleCapture (b-AC-3). */
const BATCH_OFF: CaptureConfig = { batch: false, windowMs: 1_000, maxEvents: 25, envelopeBudgetBytes: 16_384 };

/** A fake flush-window clock: the time timer fires only when the test advances past its deadline (no real sleep). */
class FakeBufferClock implements BufferClock {
	private millis = 0;
	private pending: { id: number; fireAt: number; fn: () => void } | null = null;
	private nextId = 1;
	now(): number {
		return this.millis;
	}
	setTimer(fn: () => void, ms: number): TimerHandle {
		const id = this.nextId++;
		this.pending = { id, fireAt: this.millis + ms, fn };
		return id;
	}
	clearTimer(handle: TimerHandle): void {
		if (this.pending !== null && this.pending.id === handle) this.pending = null;
	}
}

class NoopQueue implements JobQueueService {
	async enqueue(_job: JobInput): Promise<string> {
		return "j";
	}
	async lease(): Promise<LeasedJob | null> {
		return null;
	}
	async complete(): Promise<void> {}
	async fail(): Promise<void> {}
	start(): void {}
	stop(): void {}
}

function daemonConfig(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
}

function sessionHeaders(): Record<string, string> {
	return {
		"content-type": "application/json",
		"x-honeycomb-runtime-path": "plugin",
		"x-honeycomb-session": "sess-1",
		"x-honeycomb-org": ORG,
		"x-honeycomb-workspace": WORKSPACE,
	};
}

function userBody(text: string) {
	return {
		event: { kind: "user_message", text },
		metadata: {
			sessionId: "sess-1",
			path: "conversations/sess-1",
			cwd: "/repo",
			permissionMode: "default",
			hookEventName: "UserPromptSubmit",
			agentId: "agent-7",
			org: ORG,
			workspace: WORKSPACE,
			agent: "claude-code",
			pluginVersion: "0.1.0",
		},
	};
}

/** A fake transport whose `sessions` INSERT always fails (the degraded-window path). */
function failingResponder() {
	return (req: TransportRequest): Record<string, unknown>[] => {
		if (/information_schema\.columns/i.test(req.sql)) {
			return SESSIONS_TARGET.columns.map((c) => ({ column_name: c.name }));
		}
		if (/^\s*INSERT/i.test(req.sql)) {
			throw new TransportError("query", "insert failed", 500);
		}
		return [];
	};
}

/** A fake transport whose `sessions` INSERT SUCCEEDS (the recovered-backend path — b-AC-3 / b-AC-5). */
function okResponder() {
	return (req: TransportRequest): Record<string, unknown>[] => {
		if (/information_schema\.columns/i.test(req.sql)) {
			return SESSIONS_TARGET.columns.map((c) => ({ column_name: c.name }));
		}
		// Every other statement (the INSERT included) returns an empty ok result → the append LANDS.
		return [];
	};
}

function buildHandlerDaemon(overrides: {
	outbox: CaptureOutboxSink;
	logger?: { event(name: string, fields?: Readonly<Record<string, unknown>>): void };
	config?: CaptureConfig;
	bufferClock?: BufferClock;
	/** When true the daemon's `sessions` append SUCCEEDS (the recovered path); else it fails (the drop path). */
	okTransport?: boolean;
}): { daemon: Daemon; handler: CaptureHandler; dropped: ReturnType<typeof makeDroppedCounter> } {
	const fake = new FakeDeepLakeTransport(overrides.okTransport === true ? okResponder() : failingResponder());
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const logger = createRequestLogger({ silent: true });
	const daemon = createDaemon({
		config: daemonConfig(),
		storage,
		logger,
		services: { runtimePath: createRuntimePathService() },
	});
	const dropped = makeDroppedCounter();
	const handler = createCaptureHandler({
		storage,
		sessionsTarget: SESSIONS_TARGET,
		queue: new NoopQueue(),
		captureConfig: overrides.config ?? BATCH_ON,
		outbox: overrides.outbox,
		droppedEvents: dropped,
		...(overrides.bufferClock !== undefined ? { bufferClock: overrides.bufferClock } : {}),
		...(overrides.logger !== undefined ? { logger: overrides.logger } : { logger }),
	});
	handler.register(daemon);
	return { daemon, handler, dropped };
}

/** A minimal dropped-events counter matching the handler's `CaptureDroppedEventsCounter` shape. */
function makeDroppedCounter(): { increment(by?: number): void; read(): number } {
	let total = 0;
	return {
		increment(by = 1): void {
			total += Number.isFinite(by) ? Math.max(0, Math.trunc(by)) : 0;
		},
		read: () => total,
	};
}

// ══ PRD-079b (dead-letter + recovery-triggered drain) — b-AC-1 .. b-AC-5 ═══════════════════════

// ── b-AC-1: a row dead-letters after maxAttempts OR maxAgeMs; a dead row is never re-leased ────

describe("b-AC-1: pending → dead after maxAttempts / maxAgeMs; a dead row is never re-leased", () => {
	it("a row that fails maxAttempts re-appends transitions pending → dead (retained, not re-leased)", async () => {
		const stub = stubStorage(); // stays failing (a persistent degraded window)
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const outbox = openCaptureOutbox({
			storage: stub.storage,
			sessionsTarget: SESSIONS_TARGET,
			memory: true,
			clock,
			backoff: { baseMs: 1_000, capMs: 60_000 },
			maxAttempts: 2, // dead on the 2nd failed attempt
			maxAgeMs: 24 * 60 * 60 * 1_000, // large, so ATTEMPTS is the trigger here, not age
		});
		outbox.enqueue([sessionRow("attempts-die")], SCOPE);

		// Attempt 1 fails → still pending, attempts bumped (below maxAttempts).
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 1, deadLettered: 0 });
		expect(outbox.counts()).toEqual({ pending: 1, retrying: 1, deadLettered: 0 });

		// Advance past the backoff → due → attempt 2 reaches maxAttempts → dead (retained, not deleted).
		clock.advance(2_000);
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 0, deadLettered: 1 });
		expect(outbox.counts()).toEqual({ pending: 0, retrying: 0, deadLettered: 1 });

		// The dead row is NEVER re-leased: another pass leases nothing (no new append) and stays dead.
		const appendsBefore = stub.appends;
		clock.advance(60 * 60 * 1_000);
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 0, deadLettered: 0 });
		expect(stub.appends, "a dead row is never leased or re-appended").toBe(appendsBefore);
		expect(outbox.counts()).toEqual({ pending: 0, retrying: 0, deadLettered: 1 });
		outbox.close();
	});

	it("a row older than maxAgeMs dead-letters on its next failed attempt (age trigger, not attempts)", async () => {
		const stub = stubStorage(); // stays failing
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const outbox = openCaptureOutbox({
			storage: stub.storage,
			sessionsTarget: SESSIONS_TARGET,
			memory: true,
			clock,
			maxAttempts: 1_000, // large, so AGE is the trigger here, not attempts
			maxAgeMs: 60_000, // 60s in the outbox → dead
		});
		outbox.enqueue([sessionRow("age-die")], SCOPE);

		// Age the row past maxAgeMs (it stays DUE — next_attempt_at was set at enqueue time).
		clock.advance(60_001);
		// The first failed attempt now sees age ≥ maxAgeMs → dead immediately (attempt 1 ≪ maxAttempts).
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 0, deadLettered: 1 });
		expect(outbox.counts()).toEqual({ pending: 0, retrying: 0, deadLettered: 1 });
		outbox.close();
	});
});

// ── b-AC-2: dead_lettered event is secret-free; counts() partitions dead out of pending/retrying ─

describe("b-AC-2: secret-free capture.outbox.dead_lettered event + counts() partition", () => {
	it("dead-lettering emits a secret-free event and excludes dead from pending/retrying", async () => {
		const stub = stubStorage(); // stays failing
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const { logger, events } = recordingLogger();
		const outbox = openCaptureOutbox({
			storage: stub.storage,
			sessionsTarget: SESSIONS_TARGET,
			memory: true,
			clock,
			logger,
			maxAttempts: 1, // dead on the FIRST failed attempt (simplest)
		});
		outbox.enqueue([sessionRow("secret-content-here")], { org: "sekret-org", workspace: "sekret-ws" });

		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 0, deadLettered: 1 });

		// counts() partition (b-AC-2): the dead row is EXCLUDED from pending/retrying (terminal, not active).
		expect(outbox.counts()).toEqual({ pending: 0, retrying: 0, deadLettered: 1 });

		// The dead_lettered event fired and carries attempt / ageMs / count ONLY — no content/org/workspace.
		const dead = events.filter((e) => e.name === "capture.outbox.dead_lettered");
		expect(dead).toHaveLength(1);
		const fields = dead[0]!.fields;
		expect(new Set(Object.keys(fields))).toEqual(new Set(["attempt", "ageMs", "count"]));
		expect(fields.attempt).toBe(1);
		expect(fields.count).toBe(1);
		for (const e of events) {
			const blob = JSON.stringify(e.fields);
			expect(blob, `${e.name} leaks content`).not.toContain("secret-content-here");
			expect(blob, `${e.name} leaks org`).not.toContain("sekret-org");
			expect(blob, `${e.name} leaks workspace`).not.toContain("sekret-ws");
		}
		outbox.close();
	});
});

// ── b-AC-3: a SUCCESSFUL capture append kicks an immediate drain (no interval wait) ────────────

describe("b-AC-3: a successful capture append kicks an immediate outbox drain", () => {
	it("a queued row drains via the recovery kick, without arming/awaiting the 30s interval", async () => {
		// The outbox's OWN write client is in "ok" mode (the backend recovered), so a kicked drain lands.
		const stub = stubStorage();
		stub.setMode("ok");
		const outbox = openCaptureOutbox({ storage: stub.storage, sessionsTarget: SESSIONS_TARGET, memory: true });
		// A row is already queued from an earlier degraded window.
		outbox.enqueue([sessionRow("backlogged")], SCOPE);
		expect(outbox.counts().pending).toBe(1);

		// A fresh capture whose DAEMON append SUCCEEDS is the recovery signal — the handler kicks the drain.
		// The drainer interval is NEVER started here, so the ONLY path to pending → 0 is the kick (b-AC-3).
		const { daemon } = buildHandlerDaemon({ outbox, config: BATCH_OFF, okTransport: true });
		const res = await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify(userBody("a turn that lands — backend recovered")),
		});
		expect(res.status).toBe(201); // ack fast; the kick is off the hot path.

		// The kicked drainDue is fire-and-forget; let its microtasks settle, then assert the backlog cleared.
		for (let i = 0; i < 20 && outbox.counts().pending > 0; i++) {
			await new Promise((r) => setTimeout(r, 0));
		}
		expect(outbox.counts().pending, "the recovery kick drained the backlogged row promptly").toBe(0);
		outbox.close();
	});
});

// ── b-AC-5: fail-soft — a faulting recovery kick degrades to a no-op; the capture ack is intact ─

describe("b-AC-5: a kick / dead-transition fault degrades to a no-op and never breaks capture", () => {
	it("a throwing recovery kick leaves the capture ack intact and escapes no rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			// A sink whose recovery kick THROWS (a drain/dead-transition fault surrogate) — must never reach
			// the hook. `enqueue` is never called here (the daemon append SUCCEEDS on the immediate path).
			const faultingOutbox: CaptureOutboxSink = {
				enqueue: () => ({ enqueued: 0, dropped: 0 }),
				kick: () => {
					throw new Error("dead-transition fault");
				},
			};
			const { logger, events } = recordingLogger();
			const { daemon } = buildHandlerDaemon({
				outbox: faultingOutbox,
				logger,
				config: BATCH_OFF,
				okTransport: true,
			});
			const res = await daemon.app.request("/api/hooks/capture", {
				method: "POST",
				headers: sessionHeaders(),
				body: JSON.stringify(userBody("a landed turn whose recovery kick faults")),
			});
			expect(res.status).toBe(201); // ack intact — the kick fault never surfaced to the hook.
			await new Promise((r) => setTimeout(r, 0));
			// The fault was surfaced (secret-free) as a log event, not thrown; no rejection escaped.
			expect(events.some((e) => e.name === "capture.outbox.kick_failed")).toBe(true);
			expect(unhandled, "NO unhandled rejection escaped — the daemon survives").toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

// ══ PRD-079c (caps + coalescing + back-pressure at scale) — c-AC-1 .. c-AC-4 ══════════════════════

/** A WRITE client that RECORDS every `sessions` append SQL (switchable ok/fail) so a test can assert the
 * number of appends (coalescing) and the exact ids replayed. */
function capturingStorage(): { storage: StorageQuery; setMode(m: "fail" | "ok"): void; appends: string[] } {
	const state = { mode: "ok" as "fail" | "ok", appends: [] as string[] };
	const storage: StorageQuery = {
		async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			if (/^\s*INSERT\s+INTO\s+"sessions"/i.test(sql)) {
				state.appends.push(sql);
				return state.mode === "ok" ? ok([], 1) : timeoutResult(10_000);
			}
			return ok([], 1);
		},
	};
	return {
		storage,
		setMode: (m) => {
			state.mode = m;
		},
		get appends() {
			return state.appends;
		},
	};
}

/** An ASSISTANT-turn `sessions` row carrying an extra `usage` column — a DIFFERENT column signature than
 * {@link sessionRow}, so it coalesces into a SEPARATE group (c-AC-2). */
function assistantRow(id: string, text = "reply"): RowValues {
	return [
		["id", val.str(id)],
		["path", val.str("conversations/s1")],
		["message", val.text(text)],
		["creation_date", val.str("2026-07-11T00:00:00.000Z")],
		["usage", val.str('{"in":10,"out":20}')],
	];
}

/** Count the VALUES tuples in a multi-row INSERT (rows fused into one append) by counting `(` after VALUES. */
function tupleCount(insertSql: string): number {
	const after = insertSql.slice(insertSql.toUpperCase().lastIndexOf(") VALUES ") + ") VALUES ".length);
	return (after.match(/\(/g) ?? []).length;
}

// ── c-AC-1: enqueue past maxRows sheds oldest-first, bounds the backlog, logs; dead untouched ──

describe("c-AC-1: the active-backlog cap sheds the oldest pending rows oldest-first (never silently)", () => {
	it("enqueuing past maxRows sheds the OLDEST pending rows, bounds pending at maxRows, logs the shed count", async () => {
		const stub = capturingStorage();
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const { logger, events } = recordingLogger();
		const outbox = openCaptureOutbox({
			storage: stub.storage,
			sessionsTarget: SESSIONS_TARGET,
			memory: true,
			clock,
			logger,
			maxRows: 3,
		});

		// Enqueue five rows, advancing the clock so each carries a DISTINCT (increasing) created_at — the
		// shed is oldest-first by created_at, so r1/r2 (the oldest) are the ones that must go.
		for (const id of ["r1", "r2", "r3", "r4", "r5"]) {
			outbox.enqueue([sessionRow(id, `content-${id}`)], SCOPE);
			clock.advance(1_000);
		}

		// The backlog is BOUNDED at the cap — never grows past maxRows.
		expect(outbox.counts()).toEqual({ pending: 3, retrying: 0, deadLettered: 0 });
		// The shed was COUNTED + logged (never a silent truncation): 2 rows shed total (r1, r2).
		const shedTotal = events
			.filter((e) => e.name === "capture.outbox.shed")
			.reduce((n, e) => n + Number(e.fields.count), 0);
		expect(shedTotal).toBe(2);

		// Prove OLDEST-first: draining the survivors replays exactly r3/r4/r5 (r1/r2 were shed).
		stub.setMode("ok");
		expect(await outbox.drainDue()).toEqual({ drained: 3, retried: 0, deadLettered: 0 });
		const replayed = stub.appends.join(" ");
		expect(replayed).toContain("'r3'");
		expect(replayed).toContain("'r4'");
		expect(replayed).toContain("'r5'");
		expect(replayed, "the two OLDEST rows were shed, never replayed").not.toContain("'r1'");
		expect(replayed).not.toContain("'r2'");
		outbox.close();
	});

	it("dead rows do NOT count toward the active cap and are never shed by the cap path", async () => {
		const stub = stubStorage(); // fails first, so the seed row dead-letters
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const { logger, events } = recordingLogger();
		const outbox = openCaptureOutbox({
			storage: stub.storage,
			sessionsTarget: SESSIONS_TARGET,
			memory: true,
			clock,
			logger,
			maxRows: 2,
			maxAttempts: 1, // the seed row dead-letters on its first failed attempt
		});

		// Seed a DEAD row (fails once → terminal dead).
		outbox.enqueue([sessionRow("dead-1")], SCOPE);
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 0, deadLettered: 1 });
		expect(outbox.counts()).toEqual({ pending: 0, retrying: 0, deadLettered: 1 });

		// Fill the cap with two PENDING rows — the dead row does NOT count toward maxRows, so no shed yet.
		clock.advance(1_000);
		outbox.enqueue([sessionRow("p1")], SCOPE);
		clock.advance(1_000);
		outbox.enqueue([sessionRow("p2")], SCOPE);
		expect(outbox.counts()).toEqual({ pending: 2, retrying: 0, deadLettered: 1 });
		expect(
			events.some((e) => e.name === "capture.outbox.shed"),
			"no shed while dead is excluded from the cap",
		).toBe(false);

		// A third pending row trips the cap → shed 1 oldest PENDING (p1); the dead row is UNTOUCHED.
		clock.advance(1_000);
		outbox.enqueue([sessionRow("p3")], SCOPE);
		expect(outbox.counts()).toEqual({ pending: 2, retrying: 0, deadLettered: 1 });
		const shedTotal = events
			.filter((e) => e.name === "capture.outbox.shed")
			.reduce((n, e) => n + Number(e.fields.count), 0);
		expect(shedTotal, "exactly one oldest PENDING row was shed; the dead row was not").toBe(1);
		outbox.close();
	});
});

// ── c-AC-2: coalesced drain — same shape → one append; heterogeneous → split; failed group per-member ──

describe("c-AC-2: due rows are coalesced by scope + column signature into one append per group", () => {
	it("N same-scope/same-shape rows drain in ONE multi-row append", async () => {
		const stub = capturingStorage();
		stub.setMode("ok");
		const outbox = openCaptureOutbox({ storage: stub.storage, sessionsTarget: SESSIONS_TARGET, memory: true });
		outbox.enqueue([sessionRow("a"), sessionRow("b"), sessionRow("c")], SCOPE);

		expect(await outbox.drainDue()).toEqual({ drained: 3, retried: 0, deadLettered: 0 });
		expect(stub.appends, "three same-shape rows fused into a SINGLE append").toHaveLength(1);
		expect(tupleCount(stub.appends[0]!), "the single append carries all three rows").toBe(3);
		expect(outbox.counts().pending).toBe(0);
		outbox.close();
	});

	it("heterogeneous column shapes (user vs assistant/usage) split into SEPARATE appends", async () => {
		const stub = capturingStorage();
		stub.setMode("ok");
		const outbox = openCaptureOutbox({ storage: stub.storage, sessionsTarget: SESSIONS_TARGET, memory: true });
		// Two user turns (4 cols) + two assistant turns (5 cols incl. `usage`), all same scope.
		outbox.enqueue([sessionRow("u1"), assistantRow("a1"), sessionRow("u2"), assistantRow("a2")], SCOPE);

		expect(await outbox.drainDue()).toEqual({ drained: 4, retried: 0, deadLettered: 0 });
		// Two DISTINCT column signatures → two appends (buildInsertMany's same-columns assertion never trips).
		expect(stub.appends, "two shapes → two separate multi-row appends").toHaveLength(2);
		expect(stub.appends.map(tupleCount).sort(), "each shape's two rows fused within its group").toEqual([2, 2]);
		expect(outbox.counts().pending).toBe(0);
		outbox.close();
	});

	it("same shape but DIFFERENT scope splits into separate appends", async () => {
		const stub = capturingStorage();
		stub.setMode("ok");
		const outbox = openCaptureOutbox({ storage: stub.storage, sessionsTarget: SESSIONS_TARGET, memory: true });
		outbox.enqueue([sessionRow("x")], { org: "org-a", workspace: "ws-a" });
		outbox.enqueue([sessionRow("y")], { org: "org-b", workspace: "ws-b" });

		expect(await outbox.drainDue()).toEqual({ drained: 2, retried: 0, deadLettered: 0 });
		expect(stub.appends, "two scopes → two appends (never fused across scope)").toHaveLength(2);
		outbox.close();
	});

	it("a FAILED coalesced group backs off EVERY member independently (no row lost, no hot-loop)", async () => {
		const stub = capturingStorage(); // stays in fail mode
		stub.setMode("fail");
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const { logger, events } = recordingLogger();
		const outbox = openCaptureOutbox({
			storage: stub.storage,
			sessionsTarget: SESSIONS_TARGET,
			memory: true,
			clock,
			logger,
			backoff: { baseMs: 1_000, capMs: 60_000 },
		});
		outbox.enqueue([sessionRow("g1"), sessionRow("g2"), sessionRow("g3")], SCOPE);

		// The whole group's append fails → EACH member independently: attempts+1 + pushBackoff (3 retries).
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 3, deadLettered: 0 });
		expect(outbox.counts()).toEqual({ pending: 3, retrying: 3, deadLettered: 0 });
		expect(events.filter((e) => e.name === "capture.outbox.retry"), "one retry event per member").toHaveLength(3);

		// No hot-loop: every member now carries a FUTURE next_attempt_at, so an immediate pass attempts none.
		const appendsBefore = stub.appends.length;
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 0, deadLettered: 0 });
		expect(stub.appends.length, "a failing group cannot spin the write client").toBe(appendsBefore);
		outbox.close();
	});

	it("a failed group dead-letters ONLY the member that hit maxAttempts; its sibling backs off", async () => {
		const stub = capturingStorage();
		stub.setMode("fail");
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const outbox = openCaptureOutbox({
			storage: stub.storage,
			sessionsTarget: SESSIONS_TARGET,
			memory: true,
			clock,
			backoff: { baseMs: 1_000, capMs: 60_000 },
			maxAttempts: 2, // dead on the 2nd failed attempt
		});

		// Row A is aged one failed attempt ahead of row B, so in a later shared group A hits maxAttempts
		// (dead) while B is only on attempt 1 (backs off) — proving PER-MEMBER independence in one group.
		outbox.enqueue([sessionRow("A")], SCOPE);
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 1, deadLettered: 0 }); // A: attempts 1
		clock.advance(2_000); // past A's backoff so A is due again
		outbox.enqueue([sessionRow("B")], SCOPE); // B: attempts 0, due now, SAME scope + shape as A

		// One drain leases {A, B} into ONE group; the group append fails; A → attempt 2 == maxAttempts → dead,
		// B → attempt 1 → backoff. Independent outcomes within a single failed coalesced group.
		expect(await outbox.drainDue()).toEqual({ drained: 0, retried: 1, deadLettered: 1 });
		expect(outbox.counts()).toEqual({ pending: 1, retrying: 1, deadLettered: 1 });
		outbox.close();
	});
});

// ── c-AC-3: back-pressure — a pass attempts at most maxDrainPerInterval rows; the rest stay pending ──

describe("c-AC-3: maxDrainPerInterval bounds one drain pass; the remainder stays due", () => {
	it("a backlog larger than the cap attempts at most maxDrainPerInterval rows in one pass", async () => {
		const stub = capturingStorage();
		stub.setMode("ok");
		const outbox = openCaptureOutbox({
			storage: stub.storage,
			sessionsTarget: SESSIONS_TARGET,
			memory: true,
			maxDrainPerInterval: 2, // at most two rows attempted per pass
		});
		// Five queued rows (same scope/shape) — coalescing would fuse them, but the LEASE cap bounds the pass.
		outbox.enqueue([sessionRow("1"), sessionRow("2"), sessionRow("3"), sessionRow("4"), sessionRow("5")], SCOPE);
		expect(outbox.counts().pending).toBe(5);

		// Pass 1 attempts at MOST 2 rows; the other 3 remain pending (not leased).
		expect(await outbox.drainDue()).toEqual({ drained: 2, retried: 0, deadLettered: 0 });
		expect(outbox.counts().pending, "the remainder is left due for the next pass").toBe(3);
		expect(tupleCount(stub.appends[0]!), "at most maxDrainPerInterval rows were attempted this pass").toBe(2);

		// Subsequent passes drain the rest at the same bounded rate.
		expect(await outbox.drainDue()).toEqual({ drained: 2, retried: 0, deadLettered: 0 });
		expect(await outbox.drainDue()).toEqual({ drained: 1, retried: 0, deadLettered: 0 });
		expect(outbox.counts().pending).toBe(0);
		outbox.close();
	});
});

// ── c-AC-4: fail-soft + honest observability across cap / coalesce / back-pressure ──

describe("c-AC-4: the cap/coalesce/back-pressure paths are secret-free, fail-soft, and honest under load", () => {
	it("resolveCaptureOutboxLimits documents defaults + clamps a fat-fingered scale knob (never throws)", () => {
		const defaults = resolveCaptureOutboxLimits({});
		expect(defaults.maxRows).toBe(DEFAULT_OUTBOX_MAX_ROWS);
		expect(defaults.maxDrainPerInterval).toBe(DEFAULT_OUTBOX_MAX_DRAIN_PER_INTERVAL);
		// A non-numeric override falls back; a sub-1 value clamps UP to 1 (never a 0/negative nonsense cap).
		const bad = resolveCaptureOutboxLimits({
			[CAPTURE_OUTBOX_MAX_ROWS_ENV]: "not-a-number",
			[CAPTURE_OUTBOX_MAX_DRAIN_PER_INTERVAL_ENV]: "0",
		});
		expect(bad.maxRows).toBe(DEFAULT_OUTBOX_MAX_ROWS);
		expect(bad.maxDrainPerInterval).toBe(1);
	});

	it("a coalesced-drain fault degrades to the pre-079c per-member backoff and escapes no rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const stub = throwingStorage(); // the group append THROWS (rejecting transport)
			const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
			const outbox = openCaptureOutbox({
				storage: stub.storage,
				sessionsTarget: SESSIONS_TARGET,
				memory: true,
				clock,
				backoff: { baseMs: 1_000, capMs: 60_000 },
			});
			outbox.enqueue([sessionRow("t1"), sessionRow("t2")], SCOPE);
			// A throwing append never surfaces: the pass resolves, every member backs off (pre-079c behavior).
			await expect(outbox.drainDue()).resolves.toEqual({ drained: 0, retried: 2, deadLettered: 0 });
			expect(outbox.counts()).toEqual({ pending: 2, retrying: 2, deadLettered: 0 });
			await new Promise((r) => setTimeout(r, 0));
			expect(unhandled, "no unhandled rejection escaped").toEqual([]);
			outbox.close();
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("the shed + coalesce + back-pressure events carry NO content / org / workspace (secret-free)", async () => {
		const stub = capturingStorage();
		stub.setMode("fail");
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const { logger, events } = recordingLogger();
		const outbox = openCaptureOutbox({
			storage: stub.storage,
			sessionsTarget: SESSIONS_TARGET,
			memory: true,
			clock,
			logger,
			maxRows: 1, // force a shed on the second enqueue
		});
		// Two enqueues with SECRET content/org/workspace → the second sheds the first (cap = 1).
		outbox.enqueue([sessionRow("shed-me", "secret-content-here")], { org: "sekret-org", workspace: "sekret-ws" });
		clock.advance(1_000);
		outbox.enqueue([sessionRow("keep-me", "secret-content-here")], { org: "sekret-org", workspace: "sekret-ws" });
		// A failing drain adds retry events (the coalesce/back-pressure path).
		await outbox.drainDue();

		expect(
			events.some((e) => e.name === "capture.outbox.shed"),
			"a shed event fired",
		).toBe(true);
		// Every event field is allow-listed (counts / durations / attempt / reason) and leaks no secret.
		const allowed = new Set(["count", "durationMs", "attempt", "ageMs", "reason"]);
		for (const e of events) {
			const blob = JSON.stringify(e.fields);
			expect(blob, `${e.name} leaks content`).not.toContain("secret-content-here");
			expect(blob, `${e.name} leaks org`).not.toContain("sekret-org");
			expect(blob, `${e.name} leaks workspace`).not.toContain("sekret-ws");
			for (const key of Object.keys(e.fields)) {
				expect(allowed.has(key), `${e.name}.${key} is not allow-listed`).toBe(true);
			}
		}
		outbox.close();
	});

	it("/health counts stay honest under a bounded, failing backlog (pending never lies)", async () => {
		const stub = capturingStorage();
		stub.setMode("fail");
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const outbox = openCaptureOutbox({
			storage: stub.storage,
			sessionsTarget: SESSIONS_TARGET,
			memory: true,
			clock,
			maxDrainPerInterval: 2,
			backoff: { baseMs: 1_000, capMs: 60_000 },
		});
		outbox.enqueue([sessionRow("h1"), sessionRow("h2"), sessionRow("h3"), sessionRow("h4")], SCOPE);

		// One bounded pass attempts 2, both fail → they retry; the honest snapshot: 4 pending, 2 retrying.
		await outbox.drainDue();
		const c = outbox.counts();
		expect(c.pending, "no row vanished — the full backlog is still reported").toBe(4);
		expect(c.retrying, "exactly the attempted subset is retrying").toBe(2);
		expect(c.deadLettered).toBe(0);
		outbox.close();
	});
});

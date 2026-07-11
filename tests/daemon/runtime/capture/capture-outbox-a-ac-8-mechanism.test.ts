/**
 * PRD-079a a-AC-8 — MECHANISM proof (authored by quality-worker-bee during QA close-out).
 *
 * a-AC-8 is a LIVE dogfood: "during an observed DeepLake degraded window the timed-out captures land
 * in the outbox (pending > 0) and drain on recovery (pending → 0) with memories present on recall."
 * A NATURAL degraded window is intermittent hosted-backend flapping and cannot be induced on demand,
 * and no live workspace/credentials exist in CI. So this test proves the CRITERION'S MECHANISM
 * end-to-end with a controlled fault injection, chaining the two legs through the REAL capture handler
 * path in ONE flow (the existing suite proves each leg separately):
 *
 *   1. Drive the real capture route (`daemon.app.request`) → it ACKs fast (201).
 *   2. Force the buffered flush with the backend in a FAILING (degraded-window) state → the append
 *      returns non-ok → the row is ENQUEUED into the REAL wired outbox (pending → 1), NOT dropped.
 *   3. Flip the backend to OK (recovery) and drive the drainer → the row re-appends on the write
 *      client (pending → 0) and the replayed INSERT carries the ORIGINAL deterministic id (a-AC-6).
 *
 * The natural-window OBSERVATION remains a post-merge dogfood (NOT a merge blocker — the mechanism is
 * proven here). `vitest run` passes `--experimental-sqlite`, so the in-memory `node:sqlite` outbox is live.
 */

import { describe, expect, it } from "vitest";

import { healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import type { QueryOptions, QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import { ok, type QueryResult, timeoutResult } from "../../../../src/daemon/storage/result.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { TransportError } from "../../../../src/daemon/storage/transport.js";
import { createCaptureHandler } from "../../../../src/daemon/runtime/capture/capture-handler.js";
import { openCaptureOutbox } from "../../../../src/daemon/runtime/capture/capture-outbox.js";
import type { CaptureConfig } from "../../../../src/daemon/runtime/capture/capture-config.js";
import type { BufferClock, TimerHandle } from "../../../../src/daemon/runtime/capture/capture-buffer.js";
import type { JobInput, JobQueueService, LeasedJob } from "../../../../src/daemon/runtime/services/job-queue.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createRuntimePathService } from "../../../../src/daemon/runtime/middleware/runtime-path.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const SESSIONS_TARGET = healTargetFor("sessions");
const ORG = "org-a";
const WORKSPACE = "ws-a";
const BATCH_ON: CaptureConfig = { batch: true, windowMs: 1_000, maxEvents: 25, envelopeBudgetBytes: 16_384 };

/** A switchable WRITE client for the outbox drainer: fail = degraded window, ok = recovered (captures replayed SQL). */
function switchableWriteStorage(): { storage: StorageQuery; setMode(m: "fail" | "ok"): void; appends: string[] } {
	const state = { mode: "fail" as "fail" | "ok", appends: [] as string[] };
	const storage: StorageQuery = {
		async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			if (/^\s*INSERT\s+INTO\s+"sessions"/i.test(sql)) {
				if (state.mode === "ok") {
					state.appends.push(sql);
					return ok([], 1);
				}
				return timeoutResult(10_000);
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

/** The daemon capture path's transport: `sessions` INSERT always fails (the degraded window on the hot path). */
function failingResponder() {
	return (req: TransportRequest): Record<string, unknown>[] => {
		if (/information_schema\.columns/i.test(req.sql)) {
			return SESSIONS_TARGET.columns.map((c) => ({ column_name: c.name }));
		}
		if (/^\s*INSERT/i.test(req.sql)) throw new TransportError("query", "insert failed", 500);
		return [];
	};
}

/** A fake flush-window clock so the buffered flush fires only on an explicit `handler.flush()` (no real sleep). */
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

/**
 * Extract the FIRST `VALUES (...)` literal from a `sessions` INSERT — `buildRow` always writes the `id`
 * column first, so the first quoted value IS the deterministic makeRowId id. Throws if absent so a shape
 * change surfaces loudly rather than silently passing.
 */
function firstInsertId(sql: string): string {
	const match = sql.match(/VALUES\s*\(\s*'([^']*)'/i);
	if (match === null) throw new Error(`no id literal found in INSERT: ${sql.slice(0, 120)}`);
	return match[1] ?? "";
}

describe("a-AC-8 (mechanism): a degraded-window capture lands in the outbox and drains on recovery", () => {
	it("ack stays 201, pending>0 during the window, pending→0 on recovery with the original id replayed", async () => {
		// The outbox drains on its OWN write client (switchable) — models the backend recovering between
		// the failed hot-path capture and the later background drain.
		const write = switchableWriteStorage();
		const outbox = openCaptureOutbox({ storage: write.storage, sessionsTarget: SESSIONS_TARGET, memory: true });

		// The capture path's transport fails every `sessions` INSERT (the degraded window on the hot path).
		const fake = new FakeDeepLakeTransport(failingResponder());
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const daemon = createDaemon({
			config: daemonConfig(),
			storage,
			logger: createRequestLogger({ silent: true }),
			services: { runtimePath: createRuntimePathService() },
		});
		const bufferClock = new FakeBufferClock();
		const handler = createCaptureHandler({
			storage,
			sessionsTarget: SESSIONS_TARGET,
			queue: new NoopQueue(),
			captureConfig: BATCH_ON,
			outbox,
			bufferClock,
			logger: createRequestLogger({ silent: true }),
		});
		handler.register(daemon);

		// Leg 1: the capture is ACKed fast (201) even though the backend is degraded — hot path unblocked.
		const res = await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify(userBody("a durable turn during a degraded window")),
		});
		expect(res.status).toBe(201);

		// Leg 2: force the buffered flush WHILE the window is degraded → the append fails → the row is
		// ENQUEUED into the durable outbox (pending > 0), not dropped.
		await handler.flush();
		expect(outbox.counts().pending).toBeGreaterThan(0);
		expect(outbox.counts().pending).toBe(1);

		// Capture the ORIGINAL deterministic id the handler minted (makeRowId) from the FAILED hot-path
		// INSERT the daemon transport recorded (fake.requests records the statement even on a throw) — this
		// is the exact id that was queued into the outbox.
		const daemonInserts = fake.requests.filter((r) => /INSERT\s+INTO\s+"sessions"/i.test(r.sql));
		expect(daemonInserts).toHaveLength(1);
		const originalId = firstInsertId(daemonInserts[0]?.sql ?? "");
		expect(originalId, "the queued row carried a deterministic makeRowId id").toMatch(/^sess-sess-1-\d+-\d+$/);

		// Leg 3: the backend recovers → the background drainer re-appends the queued row → pending → 0,
		// and the replayed INSERT carries the ORIGINAL deterministic id (idempotent replay, a-AC-6).
		write.setMode("ok");
		const drain = await outbox.drainDue();
		expect(drain).toEqual({ drained: 1, retried: 0, deadLettered: 0 });
		expect(outbox.counts().pending).toBe(0);
		expect(write.appends).toHaveLength(1);
		expect(write.appends[0]).toMatch(/INSERT\s+INTO\s+"sessions"/i);
		// The drained append must replay the ORIGINAL makeRowId id, never a fresh one — a fresh-id replay
		// (the bug a-AC-6 guards against) would fail this equality and can no longer pass unnoticed.
		expect(firstInsertId(write.appends[0] ?? ""), "the drained append replays the ORIGINAL id, not a fresh one").toBe(
			originalId,
		);

		outbox.close();
	});
});

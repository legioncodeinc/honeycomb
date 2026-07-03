/**
 * Composition-root pins for the Deeplake idle-cost hibernation wiring (PRD-062e).
 *
 * These tests drive the REAL `assembleDaemon` (fake storage, a recording pollinating
 * worker, a temp runtime dir) with vitest fake timers so the idle window elapses
 * deterministically. They pin the two behaviors that only exist at the composition
 * root, not in the controller unit suite:
 *
 *   - AC-62e.7 (intended design): liveness polling is deliberately NON-WAKING.
 *     `GET /health` against a hibernated daemon answers 200 without resuming any
 *     handle (a monitoring poller must never keep the Activeloop pod warm), while a
 *     work-carrying capture request DOES wake the fleet. The mechanism is Hono
 *     registration order at the wiring site in assemble.ts: `createDaemon()` mounts
 *     the terminal `/health` + `/api/status` handlers BEFORE the wake middleware is
 *     registered, and every work surface is mounted after it by `assembleSeams()`.
 *     If a future reorder flips that split, these pins fail.
 *
 *   - AC-62e.6 (rollback): the REAL env read (`envHibernationConfigProvider()` over
 *     `process.env` inside `assembleDaemon`) honors the documented rollback. With
 *     `HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED=false` no hibernation ever occurs after
 *     the idle window (the worker keeps running, no transition event is logged);
 *     with the flag ABSENT (default-on) hibernation arms and fires.
 *
 *   - AC-62e.8 (observability, assembly level): the hibernate/wake transitions land
 *     in the daemon's structured event log through the wired logger adapter.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type AssembledDaemon, assembleDaemon } from "../../../src/daemon/runtime/assemble.js";
import type { RuntimeConfig } from "../../../src/daemon/runtime/config.js";
import { createRequestLogger, type RequestLogger } from "../../../src/daemon/runtime/logger.js";
import type {
	PollinatingConfigProvider,
	RawPollinatingConfig,
} from "../../../src/daemon/runtime/pollinating/config.js";
import type { PollinatingJobWorker } from "../../../src/daemon/runtime/pollinating/worker.js";
import { noopEmbedSupervisor } from "../../../src/daemon/runtime/services/embed-supervisor.js";
import type { StorageClient } from "../../../src/daemon/storage/client.js";
import type { QueryResult } from "../../../src/daemon/storage/result.js";

const OK_RESULT: QueryResult = { kind: "ok", rows: [{ "?column?": 1 }], durationMs: 1 };

/** The idle window under test: the controller's clamp floor, so the test stays fast. */
const IDLE_MS = 5_000;

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
}

/** A fake StorageClient: every statement succeeds, so assembly + probes are hermetic. */
function fakeStorage(): StorageClient {
	return {
		get endpoint() {
			return "https://example.invalid";
		},
		async connect() {
			return OK_RESULT;
		},
		async query() {
			return OK_RESULT;
		},
	} as unknown as StorageClient;
}

/** A recording fake pollinating worker: the pausable handle these pins observe. */
function recordingWorker(): { worker: PollinatingJobWorker; calls: { start: number; stop: number } } {
	const calls = { start: 0, stop: 0 };
	const worker: PollinatingJobWorker = {
		async runOnce(): Promise<boolean> {
			return false;
		},
		start(): void {
			calls.start += 1;
		},
		stop(): void {
			calls.stop += 1;
		},
	};
	return { worker, calls };
}

/** A fixed enabled pollinating-config provider so the injected worker is lifecycle-wired. */
function pollinatingProvider(): PollinatingConfigProvider {
	return {
		read(): RawPollinatingConfig {
			return { enabled: true, tokenThreshold: 1, maxInputTokens: 1, backfillOnFirstRun: false };
		},
	};
}

/** The session-group headers a work-carrying `/api/hooks/capture` request must present. */
function captureHeaders(): Record<string, string> {
	return {
		"content-type": "application/json",
		"x-honeycomb-runtime-path": "legacy",
		"x-honeycomb-session": "hibernation-pin-session",
	};
}

function captureBody(): string {
	return JSON.stringify({
		event: { kind: "user_message", text: "wake up" },
		metadata: { sessionId: "hibernation-pin-session", path: "conversations/hibernation-pin-session" },
	});
}

describe("PRD-062e composition-root pins: wake split (AC-62e.7) and env rollback (AC-62e.6)", () => {
	let runtimeDir: string;
	let assembled: AssembledDaemon | null = null;

	beforeEach(() => {
		runtimeDir = mkdtempSync(join(tmpdir(), "honeycomb-assemble-hibernation-"));
		// Hermetic embeds (no fetch to a non-existent embed daemon) + a fast idle window.
		vi.stubEnv("HONEYCOMB_EMBEDDINGS", "false");
		vi.stubEnv("HONEYCOMB_DEEPLAKE_HIBERNATE_IDLE_MS", String(IDLE_MS));
		// Fake timers so the idle window elapses on demand; auto-advance keeps incidental
		// awaits inside start()/shutdown() progressing in real time.
		vi.useFakeTimers({ shouldAdvanceTime: true });
		assembled = null;
	});

	afterEach(async () => {
		if (assembled !== null) await assembled.shutdown();
		vi.useRealTimers();
		vi.unstubAllEnvs();
		rmSync(runtimeDir, { recursive: true, force: true });
	});

	/** Assemble the real daemon with the recording worker as the observable pausable. */
	function assembleUnderTest(logger: RequestLogger): { calls: { start: number; stop: number } } {
		const { worker, calls } = recordingWorker();
		assembled = assembleDaemon({
			config: cfg(),
			storage: fakeStorage(),
			logger,
			runtimeDir,
			embedSupervisor: noopEmbedSupervisor,
			pollinatingWorker: worker,
			pollinatingConfigProvider: pollinatingProvider(),
			// Keep the pausable set minimal + deterministic: the injected worker is the handle
			// whose stop()/start() these pins observe.
			startSummaryWorker: false,
			startPipelineWorker: false,
			startSkillifyWorker: false,
		});
		return { calls };
	}

	it("AC-62e.7: GET /health while hibernated does NOT wake; a capture request DOES (and both transitions are logged)", async () => {
		const logger = createRequestLogger({ silent: true });
		const { calls } = assembleUnderTest(logger);
		if (assembled === null) throw new Error("unreachable: assembled above");
		await assembled.start();
		expect(calls.start, "the worker starts once at boot (default-on arms hibernation)").toBe(1);
		expect(calls.stop).toBe(0);

		// The idle window elapses with no inbound request: the daemon hibernates and the
		// worker is paused through its Pausable handle.
		await vi.advanceTimersByTimeAsync(IDLE_MS + 200);
		expect(calls.stop, "hibernation paused the worker after the idle window").toBe(1);
		expect(
			logger.recentEvents().some((e) => e.event === "deeplake.hibernated"),
			"the hibernate transition reached the structured event log",
		).toBe(true);

		// INTENDED DESIGN: a liveness poll answers but never wakes. /health is mounted by
		// createDaemon() BEFORE the wake middleware, so it must not count as activity.
		const health = await assembled.daemon.app.request("/health");
		expect(health.status).toBe(200);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls.start, "a /health poll must NOT resume the fleet").toBe(1);
		expect(
			logger.recentEvents().some((e) => e.event === "deeplake.woke"),
			"no wake transition was logged for the liveness poll",
		).toBe(false);

		// Real work wakes: a capture request flows through the wake middleware before its
		// handler, resuming the worker and logging the transition.
		await assembled.daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: captureHeaders(),
			body: captureBody(),
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(calls.start, "a work-carrying capture request wakes the fleet").toBe(2);
		expect(
			logger.recentEvents().some((e) => e.event === "deeplake.woke"),
			"the wake transition reached the structured event log",
		).toBe(true);
	});

	it("AC-62e.6: HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED=false read from the real env never pauses anything", async () => {
		vi.stubEnv("HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED", "false");
		const logger = createRequestLogger({ silent: true });
		const { calls } = assembleUnderTest(logger);
		if (assembled === null) throw new Error("unreachable: assembled above");
		await assembled.start();
		expect(calls.start).toBe(1);

		// Well past the idle window: with the rollback flag set, the controller is never
		// built, the worker keeps running, and no transition event is ever logged.
		await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
		expect(calls.stop, "the rollback flag means the worker is never paused").toBe(0);
		expect(
			logger.recentEvents().some((e) => e.event === "deeplake.hibernated"),
			"no hibernate transition is logged under the rollback",
		).toBe(false);

		// The only stop is the normal lifecycle stop at shutdown.
		await assembled.shutdown();
		assembled = null;
		expect(calls.stop, "shutdown stops the worker exactly once (lifecycle, not a pause)").toBe(1);
	});
});

/**
 * PRD-079b (b-AC-4) — the operator force-drain trigger seam (daemon side).
 *
 * Verification posture (mirrors compact-api.test.ts): the seam is mounted on a REAL daemon
 * (`createDaemon` with a `local`-mode config so the `/api/diagnostics` group's permission middleware
 * is open) and exercised in-process via `daemon.app.request(...)` — no socket, no live DeepLake. A
 * FAKE outbox records the `drainDue` call + scripts the count triple, so each test proves the wiring
 * + the response contract WITHOUT a live outbox.
 *
 * The cases prove:
 *  - `POST /api/diagnostics/capture-drain` forces EXACTLY ONE `drainDue` pass and returns
 *    `{ ok, drained, retried, deadLettered }`.
 *  - fail-soft: a `drainDue` that throws degrades to a zero-count 200 (never a 500).
 */

import { describe, expect, it } from "vitest";

import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import { mountCaptureDrainApi } from "../../../../src/daemon/runtime/capture/capture-drain-api.js";
import type { CaptureOutbox, CaptureOutboxDrainResult } from "../../../../src/daemon/runtime/capture/capture-outbox.js";
import { ok } from "../../../../src/daemon/storage/result.js";

/** A resolved config for the daemon under test (local mode → open diagnostics middleware). */
function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

/**
 * A fake {@link CaptureOutbox} whose `drainDue` records the call count and returns a scripted result
 * (or throws when `throws` is set). Every other method is an inert stub — the route only calls
 * `drainDue`.
 */
function fakeOutbox(opts: { result?: CaptureOutboxDrainResult; throws?: boolean }): {
	outbox: CaptureOutbox;
	drainCalls: () => number;
} {
	let calls = 0;
	const outbox: CaptureOutbox = {
		enqueue: () => ({ enqueued: 0, dropped: 0 }),
		counts: () => ({ pending: 0, retrying: 0, deadLettered: 0 }),
		async drainDue(): Promise<CaptureOutboxDrainResult> {
			calls += 1;
			if (opts.throws === true) throw new Error("drain fault");
			return opts.result ?? { drained: 0, retried: 0, deadLettered: 0 };
		},
		kick: () => {},
		start: () => {},
		stop: () => {},
		close: () => {},
	};
	return { outbox, drainCalls: () => calls };
}

function daemonUnderTest() {
	return createDaemon({
		config: cfg(),
		storage: {
			async query() {
				return ok([]);
			},
		},
		logger: createRequestLogger({ silent: true }),
	});
}

describe("PRD-079b b-AC-4 — POST /api/diagnostics/capture-drain forces one drain + returns the counts", () => {
	it("forces exactly one drainDue pass and returns { ok, drained, retried, deadLettered }", async () => {
		const daemon = daemonUnderTest();
		const { outbox, drainCalls } = fakeOutbox({ result: { drained: 5, retried: 2, deadLettered: 1 } });
		mountCaptureDrainApi(daemon, { outbox });

		const res = await daemon.app.request("/api/diagnostics/capture-drain", { method: "POST" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual({ ok: true, drained: 5, retried: 2, deadLettered: 1 });
		// The operator command forces EXACTLY ONE pass — the same seam the interval + kick run.
		expect(drainCalls()).toBe(1);
	});

	it("is fail-soft: a throwing drainDue degrades to a zero-count 200 (never a 500)", async () => {
		const daemon = daemonUnderTest();
		const { outbox } = fakeOutbox({ throws: true });
		mountCaptureDrainApi(daemon, { outbox });

		const res = await daemon.app.request("/api/diagnostics/capture-drain", { method: "POST" });
		expect(res.status, "the operator command never sees a 500").toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual({ ok: true, drained: 0, retried: 0, deadLettered: 0 });
	});

	it("the response body carries no token/secret/header value (secret-free counts only)", async () => {
		const daemon = daemonUnderTest();
		const { outbox } = fakeOutbox({ result: { drained: 1, retried: 0, deadLettered: 0 } });
		mountCaptureDrainApi(daemon, { outbox });

		const res = await daemon.app.request("/api/diagnostics/capture-drain", { method: "POST" });
		const text = await res.text();
		expect(text).not.toMatch(/token|secret|bearer|authorization|x-honeycomb/i);
	});
});

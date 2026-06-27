/**
 * Tests for the hosted escalation sink (PRD-064g AC-064g.3).
 *
 * AC coverage:
 *   AC-064g.3 -- credentialed -> hosted sink (telemetry emit) receives the report
 *                with device_id (assert via mock emit)
 */

import { describe, expect, it } from "vitest";

import type { EscalationRecord } from "../../src/rungs/escalation.js";
import type { EmitDeps, TelemetryFetch, TelemetryFetchInit } from "../../src/telemetry/emit.js";
import { emitEscalationToHostedSink } from "../../src/escalation/hosted-sink.js";
import { silentLogger } from "../../src/logger.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FAKE_KEY = "test-hosted-sink-key";
const FAKE_HOST = "https://test.posthog.example";
const FAKE_DEVICE_ID = "deadbeef-0000-0000-0000-000000000001";
const FAKE_NOW = 1_767_225_600_000;

function makeEscalation(overrides: Partial<EscalationRecord> = {}): EscalationRecord {
	return {
		diagnosis: "Ladder exhausted.",
		steps: [
			{ rung: 1, action: "restart-daemon", outcome: "failed", at: "2026-01-01T00:00:01.000Z" },
		],
		recommendedAction: "reinstall-primary",
		at: "2026-01-01T00:00:01.000Z",
		...overrides,
	};
}

/** A mock fetch that records calls and returns 200 by default. */
function makeMockFetch(status = 200) {
	const calls: Array<{ url: string; init: TelemetryFetchInit }> = [];
	const mock: TelemetryFetch = async (url, init) => {
		calls.push({ url, init });
		return { ok: status >= 200 && status < 300, status };
	};
	return { mock, calls };
}

function baseEmitDeps(overrides: Partial<EmitDeps> = {}): EmitDeps {
	const { mock } = makeMockFetch();
	return {
		posthogKey: FAKE_KEY,
		posthogHost: FAKE_HOST,
		fetch: mock,
		env: {},
		now: () => FAKE_NOW,
		...overrides,
	};
}

// ── AC-064g.3 ─────────────────────────────────────────────────────────────────

describe("AC-064g.3: credentialed -> hosted sink receives the report with device_id", () => {
	it("returns true and posts to the OTLP endpoint when credentialed", async () => {
		const { mock, calls } = makeMockFetch(200);
		const result = await emitEscalationToHostedSink({
			escalation: makeEscalation(),
			deviceId: FAKE_DEVICE_ID,
			hivedoctorVersion: "0.1.0-test",
			daemonVersion: "0.1.0-test",
			timestampMs: FAKE_NOW,
			emitDeps: { ...baseEmitDeps(), fetch: mock },
		});

		expect(result).toBe(true);
		expect(calls).toHaveLength(1);
	});

	it("posts to the correct OTLP Logs path", async () => {
		const { mock, calls } = makeMockFetch(200);
		await emitEscalationToHostedSink({
			escalation: makeEscalation(),
			deviceId: FAKE_DEVICE_ID,
			hivedoctorVersion: "0.1.0-test",
			daemonVersion: "unknown",
			timestampMs: FAKE_NOW,
			emitDeps: { ...baseEmitDeps(), fetch: mock },
		});

		expect(calls[0]?.url).toContain("/i/v1/logs");
	});

	it("includes device_id in the serialized OTLP payload", async () => {
		const { mock, calls } = makeMockFetch(200);
		await emitEscalationToHostedSink({
			escalation: makeEscalation(),
			deviceId: FAKE_DEVICE_ID,
			hivedoctorVersion: "0.1.0-test",
			daemonVersion: "unknown",
			timestampMs: FAKE_NOW,
			emitDeps: { ...baseEmitDeps(), fetch: mock },
		});

		const body = calls[0]?.init.body ?? "";
		expect(body).toContain(FAKE_DEVICE_ID);
	});

	it("returns false and does not post when no key is provided (disabled gate)", async () => {
		const { mock, calls } = makeMockFetch(200);
		const result = await emitEscalationToHostedSink({
			escalation: makeEscalation(),
			deviceId: FAKE_DEVICE_ID,
			hivedoctorVersion: "0.1.0-test",
			daemonVersion: "unknown",
			timestampMs: FAKE_NOW,
			emitDeps: { posthogKey: "", fetch: mock, env: {} },
		});

		expect(result).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it("returns false when DO_NOT_TRACK is set (opt-out gate)", async () => {
		const { mock, calls } = makeMockFetch(200);
		const result = await emitEscalationToHostedSink({
			escalation: makeEscalation(),
			deviceId: FAKE_DEVICE_ID,
			hivedoctorVersion: "0.1.0-test",
			daemonVersion: "unknown",
			timestampMs: FAKE_NOW,
			emitDeps: {
				posthogKey: FAKE_KEY,
				posthogHost: FAKE_HOST,
				fetch: mock,
				env: { DO_NOT_TRACK: "1" },
			},
		});

		expect(result).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it("returns false when the network fails (swallowed, fail-soft)", async () => {
		const failFetch: TelemetryFetch = async () => {
			throw new Error("network timeout");
		};
		const result = await emitEscalationToHostedSink({
			escalation: makeEscalation(),
			deviceId: FAKE_DEVICE_ID,
			hivedoctorVersion: "0.1.0-test",
			daemonVersion: "unknown",
			timestampMs: FAKE_NOW,
			logger: silentLogger,
			emitDeps: {
				posthogKey: FAKE_KEY,
				posthogHost: FAKE_HOST,
				fetch: failFetch,
				env: {},
			},
		});

		expect(result).toBe(false);
	});

	it("never throws even if emitEpisode rejects unexpectedly", async () => {
		// Inject a fetch that throws a non-Error (edge case).
		const badFetch: TelemetryFetch = async () => {
			throw "non-error string"; // eslint-disable-line no-throw-literal -- intentional test
		};
		await expect(
			emitEscalationToHostedSink({
				escalation: makeEscalation(),
				deviceId: FAKE_DEVICE_ID,
				hivedoctorVersion: "0.1.0-test",
				daemonVersion: "unknown",
				timestampMs: FAKE_NOW,
				logger: silentLogger,
				emitDeps: {
					posthogKey: FAKE_KEY,
					posthogHost: FAKE_HOST,
					fetch: badFetch,
					env: {},
				},
			}),
		).resolves.toBe(false);
	});
});

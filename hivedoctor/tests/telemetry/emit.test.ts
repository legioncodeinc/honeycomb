/**
 * Tests for the HiveDoctor telemetry chokepoint (PRD-064d AC-064d.1 .. AC-064d.7).
 *
 * All tests use a mock fetch (never hits the network). The mock records the
 * outbound request so tests can assert on the payload shape, the URL, and the
 * Authorization header. `vi.fn()` / vitest spies are used for the fetch seam.
 *
 * AC coverage:
 *   AC-064d.1 -- error record -> ERROR OTLP log at /i/v1/logs
 *   AC-064d.2 -- install-health record -> INFO OTLP log
 *   AC-064d.3 -- episode record -> OTLP log carrying device_id
 *   AC-064d.4 -- opt-out (DO_NOT_TRACK, HONEYCOMB_TELEMETRY=0, state toggle)
 *   AC-064d.5 -- payload contains no creds/PII/token (allow-list enforced)
 *   AC-064d.6 -- sink unreachable -> swallowed, caller unaffected
 *   AC-064d.7 -- no @opentelemetry/* dep (covered in otlp-serializer.test.ts)
 */

import { describe, expect, it } from "vitest";

import type { Incident } from "../../src/incidents.js";
import {
	BANNED_ATTRIBUTE_KEYS,
	ENV_DO_NOT_TRACK,
	ENV_TELEMETRY,
	OTLP_LOGS_PATH,
	type EmitDeps,
	type TelemetryFetch,
	type TelemetryFetchInit,
	type TelemetryFetchResponse,
	emitEpisode,
	emitError,
	emitInstallHealth,
	emitTelemetry,
	isOptedOut,
} from "../../src/telemetry/emit.js";

// ────────────────────────────────────────────────────────────────────────────
// Shared test fixtures
// ────────────────────────────────────────────────────────────────────────────

const FAKE_KEY = "test-fake-key-not-real";
const FAKE_HOST = "https://test.posthog.example";
const FAKE_DEVICE_ID = "a1b2c3d4-0000-0000-0000-000000000001";
const FAKE_VERSION = "0.1.0-test";
const FAKE_NOW = 1_767_225_600_000; // 2026-01-01T00:00:00.000Z

/** Build a mock fetch that records calls and returns a 200 OK by default. */
function makeMockFetch(status = 200) {
	const calls: Array<{ url: string; init: TelemetryFetchInit }> = [];

	const mock: TelemetryFetch = async (url, init) => {
		calls.push({ url, init });
		return { ok: status >= 200 && status < 300, status };
	};

	return { mock, calls };
}

/** The minimal test deps (always passes the key so the "disabled" gate is not hit). */
function testDeps(overrides: Partial<EmitDeps> = {}): EmitDeps {
	const { mock } = makeMockFetch();
	return {
		posthogKey: FAKE_KEY,
		posthogHost: FAKE_HOST,
		hivedoctorVersion: FAKE_VERSION,
		fetch: mock,
		env: {},
		now: () => FAKE_NOW,
		...overrides,
	};
}

/** Build a minimal fake Incident for episode tests. */
function makeIncident(overrides: Partial<Incident> = {}): Incident {
	return {
		id: "incident-uuid-001",
		openedAt: "2026-01-01T00:00:00.000Z",
		trigger: "unreachable",
		healthKind: "unreachable-refused",
		steps: [
			{ rung: 1, action: "restart-daemon", outcome: "succeeded", at: "2026-01-01T00:00:01.000Z" },
		],
		resolved: true,
		closedAt: "2026-01-01T00:00:02.000Z",
		...overrides,
	};
}

// ────────────────────────────────────────────────────────────────────────────
// isOptedOut
// ────────────────────────────────────────────────────────────────────────────

describe("isOptedOut", () => {
	it("returns false for an empty env", () => {
		expect(isOptedOut({})).toBe(false);
	});

	it("returns true when HONEYCOMB_TELEMETRY=0", () => {
		expect(isOptedOut({ [ENV_TELEMETRY]: "0" })).toBe(true);
	});

	it("returns false when HONEYCOMB_TELEMETRY=1", () => {
		expect(isOptedOut({ [ENV_TELEMETRY]: "1" })).toBe(false);
	});

	it("returns true when DO_NOT_TRACK=1", () => {
		expect(isOptedOut({ [ENV_DO_NOT_TRACK]: "1" })).toBe(true);
	});

	it("returns true when DO_NOT_TRACK is any non-empty non-0 value", () => {
		expect(isOptedOut({ [ENV_DO_NOT_TRACK]: "yes" })).toBe(true);
	});

	it("returns false when DO_NOT_TRACK=0", () => {
		expect(isOptedOut({ [ENV_DO_NOT_TRACK]: "0" })).toBe(false);
	});

	it("returns false when DO_NOT_TRACK is empty string", () => {
		expect(isOptedOut({ [ENV_DO_NOT_TRACK]: "" })).toBe(false);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// AC-064d.1 -- error stream -> ERROR severity OTLP log at /i/v1/logs
// ────────────────────────────────────────────────────────────────────────────

describe("AC-064d.1 error stream", () => {
	it("sends an ERROR-severity OTLP log record to /i/v1/logs", async () => {
		const { mock, calls } = makeMockFetch();
		const deps = testDeps({ fetch: mock });

		const outcome = await emitError(
			{
				errorClass: "ProbeTimeoutError",
				errorDetail: "connection refused",
				deviceId: FAKE_DEVICE_ID,
				timestampMs: FAKE_NOW,
			},
			deps,
		);

		expect(outcome.sent).toBe(true);
		expect(calls).toHaveLength(1);

		const call = calls[0];
		expect(call).toBeDefined();
		if (!call) throw new Error("no call");

		// URL must be the OTLP Logs endpoint
		expect(call.url).toBe(`${FAKE_HOST}${OTLP_LOGS_PATH}`);

		// Method must be POST
		expect(call.init.method).toBe("POST");

		// Authorization must be Bearer
		expect(call.init.headers["Authorization"]).toBe(`Bearer ${FAKE_KEY}`);

		// Parse the body and verify the OTLP shape
		const body = JSON.parse(call.init.body) as Record<string, unknown>;
		expect(body).toHaveProperty("resourceLogs");

		const resourceLogs = (body["resourceLogs"] as unknown[])[0] as Record<string, unknown>;
		const scopeLogs = (resourceLogs["scopeLogs"] as unknown[])[0] as Record<string, unknown>;
		const logRecord = (scopeLogs["logRecords"] as unknown[])[0] as Record<string, unknown>;

		expect(logRecord["severityNumber"]).toBe(17); // ERROR
		expect(logRecord["severityText"]).toBe("ERROR");
		expect((logRecord["body"] as { stringValue: string }).stringValue).toBe("ProbeTimeoutError");
	});

	it("sets the stream attribute to 'error'", async () => {
		const { mock, calls } = makeMockFetch();
		const deps = testDeps({ fetch: mock });

		await emitError({ errorClass: "TestError", deviceId: FAKE_DEVICE_ID, timestampMs: FAKE_NOW }, deps);

		const call = calls[0];
		if (!call) throw new Error("no call");
		const body = JSON.parse(call.init.body) as Record<string, unknown>;
		const resourceLogs = (body["resourceLogs"] as unknown[])[0] as Record<string, unknown>;
		const scopeLogs = (resourceLogs["scopeLogs"] as unknown[])[0] as Record<string, unknown>;
		const logRecord = (scopeLogs["logRecords"] as unknown[])[0] as Record<string, unknown>;

		const attrs = logRecord["attributes"] as Array<{ key: string; value: { stringValue: string } }>;
		const streamAttr = attrs.find((a) => a.key === "stream");
		expect(streamAttr?.value?.stringValue).toBe("error");
	});

	it("returns sent=true on 2xx", async () => {
		const { mock } = makeMockFetch(200);
		const outcome = await emitError(
			{ errorClass: "E", deviceId: FAKE_DEVICE_ID, timestampMs: FAKE_NOW },
			testDeps({ fetch: mock }),
		);
		expect(outcome.sent).toBe(true);
		expect(outcome.skipped).toBeUndefined();
	});

	it("returns send_failed on non-2xx", async () => {
		const { mock } = makeMockFetch(500);
		const outcome = await emitError(
			{ errorClass: "E", deviceId: FAKE_DEVICE_ID, timestampMs: FAKE_NOW },
			testDeps({ fetch: mock }),
		);
		expect(outcome.sent).toBe(false);
		expect(outcome.skipped).toBe("send_failed");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// AC-064d.2 -- install-health stream -> INFO OTLP log
// ────────────────────────────────────────────────────────────────────────────

describe("AC-064d.2 install-health stream", () => {
	it("sends an INFO-severity OTLP log record", async () => {
		const { mock, calls } = makeMockFetch();
		const deps = testDeps({ fetch: mock });

		const outcome = await emitInstallHealth(
			{
				deviceId: FAKE_DEVICE_ID,
				timestampMs: FAKE_NOW,
				lastKnownHealth: "ok",
				lastHealAgeSeconds: 120,
				hivedoctorVersion: FAKE_VERSION,
				daemonVersion: "0.1.8",
			},
			deps,
		);

		expect(outcome.sent).toBe(true);
		expect(calls).toHaveLength(1);

		const call = calls[0];
		if (!call) throw new Error("no call");

		const body = JSON.parse(call.init.body) as Record<string, unknown>;
		const resourceLogs = (body["resourceLogs"] as unknown[])[0] as Record<string, unknown>;
		const scopeLogs = (resourceLogs["scopeLogs"] as unknown[])[0] as Record<string, unknown>;
		const logRecord = (scopeLogs["logRecords"] as unknown[])[0] as Record<string, unknown>;

		expect(logRecord["severityNumber"]).toBe(9); // INFO
		expect(logRecord["severityText"]).toBe("INFO");
	});

	it("sets the stream attribute to 'install-health'", async () => {
		const { mock, calls } = makeMockFetch();
		await emitInstallHealth(
			{
				deviceId: FAKE_DEVICE_ID,
				timestampMs: FAKE_NOW,
				lastKnownHealth: "degraded",
				lastHealAgeSeconds: null,
				hivedoctorVersion: FAKE_VERSION,
				daemonVersion: "0.1.8",
			},
			testDeps({ fetch: mock }),
		);

		const call = calls[0];
		if (!call) throw new Error("no call");
		const body = JSON.parse(call.init.body) as Record<string, unknown>;
		const resourceLogs = (body["resourceLogs"] as unknown[])[0] as Record<string, unknown>;
		const scopeLogs = (resourceLogs["scopeLogs"] as unknown[])[0] as Record<string, unknown>;
		const logRecord = (scopeLogs["logRecords"] as unknown[])[0] as Record<string, unknown>;
		const attrs = logRecord["attributes"] as Array<{ key: string; value: { stringValue: string } }>;

		const streamAttr = attrs.find((a) => a.key === "stream");
		expect(streamAttr?.value?.stringValue).toBe("install-health");
	});

	it("includes the health status in the record attributes", async () => {
		const { mock, calls } = makeMockFetch();
		await emitInstallHealth(
			{
				deviceId: FAKE_DEVICE_ID,
				timestampMs: FAKE_NOW,
				lastKnownHealth: "unreachable",
				lastHealAgeSeconds: 3700,
				hivedoctorVersion: FAKE_VERSION,
				daemonVersion: "0.1.8",
			},
			testDeps({ fetch: mock }),
		);

		const call = calls[0];
		if (!call) throw new Error("no call");
		const body = JSON.parse(call.init.body) as Record<string, unknown>;
		const resourceLogs = (body["resourceLogs"] as unknown[])[0] as Record<string, unknown>;
		const scopeLogs = (resourceLogs["scopeLogs"] as unknown[])[0] as Record<string, unknown>;
		const logRecord = (scopeLogs["logRecords"] as unknown[])[0] as Record<string, unknown>;
		const attrs = logRecord["attributes"] as Array<{ key: string; value: { stringValue: string } }>;

		const healthAttr = attrs.find((a) => a.key === "health");
		expect(healthAttr?.value?.stringValue).toBe("unreachable");

		// last_heal_age_s should be bucketed, not exact. 3700s > 3600s so it goes in the lt1d bucket.
		const ageAttr = attrs.find((a) => a.key === "last_heal_age_s");
		expect(ageAttr?.value?.stringValue).toBe("lt1d"); // 3700s (>1h, <1d) -> lt1d
	});

	it("emits last_heal_age_s='never' when null", async () => {
		const { mock, calls } = makeMockFetch();
		await emitInstallHealth(
			{
				deviceId: FAKE_DEVICE_ID,
				timestampMs: FAKE_NOW,
				lastKnownHealth: "unknown",
				lastHealAgeSeconds: null,
				hivedoctorVersion: FAKE_VERSION,
				daemonVersion: "0.1.8",
			},
			testDeps({ fetch: mock }),
		);

		const call = calls[0];
		if (!call) throw new Error("no call");
		const body = JSON.parse(call.init.body) as Record<string, unknown>;
		const resourceLogs = (body["resourceLogs"] as unknown[])[0] as Record<string, unknown>;
		const scopeLogs = (resourceLogs["scopeLogs"] as unknown[])[0] as Record<string, unknown>;
		const logRecord = (scopeLogs["logRecords"] as unknown[])[0] as Record<string, unknown>;
		const attrs = logRecord["attributes"] as Array<{ key: string; value: { stringValue: string } }>;
		const ageAttr = attrs.find((a) => a.key === "last_heal_age_s");
		expect(ageAttr?.value?.stringValue).toBe("never");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// AC-064d.3 -- episode stream -> OTLP log carrying device_id
// ────────────────────────────────────────────────────────────────────────────

describe("AC-064d.3 episode stream", () => {
	it("sends an OTLP log record carrying device_id in resource attributes", async () => {
		const { mock, calls } = makeMockFetch();
		const deps = testDeps({ fetch: mock });

		const outcome = await emitEpisode(
			{
				incident: makeIncident(),
				deviceId: FAKE_DEVICE_ID,
				timestampMs: FAKE_NOW,
				hivedoctorVersion: FAKE_VERSION,
				daemonVersion: "0.1.8",
			},
			deps,
		);

		expect(outcome.sent).toBe(true);

		const call = calls[0];
		if (!call) throw new Error("no call");

		const body = JSON.parse(call.init.body) as Record<string, unknown>;
		const resourceLogs = (body["resourceLogs"] as unknown[])[0] as Record<string, unknown>;

		// device_id must be in resource attributes
		const resourceAttrs = resourceLogs["resource"] as { attributes: Array<{ key: string; value: unknown }> };
		const deviceIdAttr = resourceAttrs.attributes.find((a) => a.key === "device_id");
		expect(deviceIdAttr).toBeDefined();
		expect((deviceIdAttr?.value as { stringValue: string }).stringValue).toBe(FAKE_DEVICE_ID);
	});

	it("uses INFO severity when the episode resolved", async () => {
		const { mock, calls } = makeMockFetch();
		await emitEpisode(
			{
				incident: makeIncident({ resolved: true }),
				deviceId: FAKE_DEVICE_ID,
				timestampMs: FAKE_NOW,
				hivedoctorVersion: FAKE_VERSION,
				daemonVersion: "0.1.8",
			},
			testDeps({ fetch: mock }),
		);

		const call = calls[0];
		if (!call) throw new Error("no call");
		const body = JSON.parse(call.init.body) as Record<string, unknown>;
		const resourceLogs = (body["resourceLogs"] as unknown[])[0] as Record<string, unknown>;
		const scopeLogs = (resourceLogs["scopeLogs"] as unknown[])[0] as Record<string, unknown>;
		const logRecord = (scopeLogs["logRecords"] as unknown[])[0] as Record<string, unknown>;
		expect(logRecord["severityNumber"]).toBe(9); // INFO
	});

	it("uses WARN severity when the episode did not resolve", async () => {
		const { mock, calls } = makeMockFetch();
		await emitEpisode(
			{
				incident: makeIncident({ resolved: false }),
				deviceId: FAKE_DEVICE_ID,
				timestampMs: FAKE_NOW,
				hivedoctorVersion: FAKE_VERSION,
				daemonVersion: "0.1.8",
			},
			testDeps({ fetch: mock }),
		);

		const call = calls[0];
		if (!call) throw new Error("no call");
		const body = JSON.parse(call.init.body) as Record<string, unknown>;
		const resourceLogs = (body["resourceLogs"] as unknown[])[0] as Record<string, unknown>;
		const scopeLogs = (resourceLogs["scopeLogs"] as unknown[])[0] as Record<string, unknown>;
		const logRecord = (scopeLogs["logRecords"] as unknown[])[0] as Record<string, unknown>;
		expect(logRecord["severityNumber"]).toBe(13); // WARN
	});

	it("includes step outcomes in per-record attributes as 'rung:outcome' pairs", async () => {
		const { mock, calls } = makeMockFetch();
		const incident = makeIncident({
			steps: [
				{ rung: 1, action: "restart-daemon", outcome: "failed", at: "2026-01-01T00:00:01.000Z" },
				{ rung: 2, action: "advance-rung", outcome: "succeeded", at: "2026-01-01T00:00:02.000Z" },
			],
			resolved: false,
		});

		await emitEpisode(
			{
				incident,
				deviceId: FAKE_DEVICE_ID,
				timestampMs: FAKE_NOW,
				hivedoctorVersion: FAKE_VERSION,
				daemonVersion: "0.1.8",
			},
			testDeps({ fetch: mock }),
		);

		const call = calls[0];
		if (!call) throw new Error("no call");
		const body = JSON.parse(call.init.body) as Record<string, unknown>;
		const resourceLogs = (body["resourceLogs"] as unknown[])[0] as Record<string, unknown>;
		const scopeLogs = (resourceLogs["scopeLogs"] as unknown[])[0] as Record<string, unknown>;
		const logRecord = (scopeLogs["logRecords"] as unknown[])[0] as Record<string, unknown>;
		const attrs = logRecord["attributes"] as Array<{ key: string; value: { stringValue: string } }>;

		const stepOutcomesAttr = attrs.find((a) => a.key === "step_outcomes");
		expect(stepOutcomesAttr?.value?.stringValue).toBe("1:failed,2:succeeded");

		const stepCountAttr = attrs.find((a) => a.key === "step_count");
		expect(stepCountAttr?.value?.stringValue).toBe("2");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// AC-064d.4 -- opt-out suppresses all streams
// ────────────────────────────────────────────────────────────────────────────

describe("AC-064d.4 opt-out", () => {
	const errorInput = {
		kind: "error" as const,
		errorClass: "TestError",
		deviceId: FAKE_DEVICE_ID,
		timestampMs: FAKE_NOW,
	};

	it("empty PostHog key -> disabled, nothing sent", async () => {
		const { mock, calls } = makeMockFetch();
		const outcome = await emitTelemetry(errorInput, {
			posthogKey: "",
			fetch: mock,
			env: {},
		});
		expect(outcome.sent).toBe(false);
		expect(outcome.skipped).toBe("disabled");
		expect(calls).toHaveLength(0);
	});

	it("DO_NOT_TRACK=1 -> opted_out, nothing sent", async () => {
		const { mock, calls } = makeMockFetch();
		const outcome = await emitTelemetry(errorInput, testDeps({ fetch: mock, env: { DO_NOT_TRACK: "1" } }));
		expect(outcome.sent).toBe(false);
		expect(outcome.skipped).toBe("opted_out");
		expect(calls).toHaveLength(0);
	});

	it("HONEYCOMB_TELEMETRY=0 -> opted_out, nothing sent", async () => {
		const { mock, calls } = makeMockFetch();
		const outcome = await emitTelemetry(errorInput, testDeps({ fetch: mock, env: { HONEYCOMB_TELEMETRY: "0" } }));
		expect(outcome.sent).toBe(false);
		expect(outcome.skipped).toBe("opted_out");
		expect(calls).toHaveLength(0);
	});

	it("stateTelemetryDisabled=true -> opted_out, nothing sent", async () => {
		const { mock, calls } = makeMockFetch();
		const outcome = await emitTelemetry(errorInput, testDeps({ fetch: mock, stateTelemetryDisabled: true }));
		expect(outcome.sent).toBe(false);
		expect(outcome.skipped).toBe("opted_out");
		expect(calls).toHaveLength(0);
	});

	it("opt-out suppresses install-health stream too", async () => {
		const { mock, calls } = makeMockFetch();
		const outcome = await emitInstallHealth(
			{
				deviceId: FAKE_DEVICE_ID,
				timestampMs: FAKE_NOW,
				lastKnownHealth: "ok",
				lastHealAgeSeconds: 60,
				hivedoctorVersion: FAKE_VERSION,
				daemonVersion: "0.1.8",
			},
			testDeps({ fetch: mock, env: { DO_NOT_TRACK: "1" } }),
		);
		expect(outcome.sent).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it("opt-out suppresses episode stream too", async () => {
		const { mock, calls } = makeMockFetch();
		const outcome = await emitEpisode(
			{
				incident: makeIncident(),
				deviceId: FAKE_DEVICE_ID,
				timestampMs: FAKE_NOW,
				hivedoctorVersion: FAKE_VERSION,
				daemonVersion: "0.1.8",
			},
			testDeps({ fetch: mock, env: { HONEYCOMB_TELEMETRY: "0" } }),
		);
		expect(outcome.sent).toBe(false);
		expect(calls).toHaveLength(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// AC-064d.5 -- allow-list: no creds/PII/token in serialized payload
// ────────────────────────────────────────────────────────────────────────────

describe("AC-064d.5 allow-list scrubbing", () => {
	/**
	 * Helper: emit all three streams and collect every POST body.
	 * Returns the concatenated JSON strings for substring scanning.
	 */
	async function collectAllPayloads(): Promise<string> {
		const bodies: string[] = [];
		const makeFetch = (): TelemetryFetch => async (_url, init) => {
			bodies.push(init.body);
			return { ok: true, status: 200 };
		};

		await emitError(
			{ errorClass: "TestError", errorDetail: "something safe", deviceId: FAKE_DEVICE_ID, timestampMs: FAKE_NOW },
			testDeps({ fetch: makeFetch() }),
		);
		await emitInstallHealth(
			{
				deviceId: FAKE_DEVICE_ID,
				timestampMs: FAKE_NOW,
				lastKnownHealth: "ok",
				lastHealAgeSeconds: 60,
				hivedoctorVersion: FAKE_VERSION,
				daemonVersion: "0.1.8",
			},
			testDeps({ fetch: makeFetch() }),
		);
		await emitEpisode(
			{
				incident: makeIncident(),
				deviceId: FAKE_DEVICE_ID,
				timestampMs: FAKE_NOW,
				hivedoctorVersion: FAKE_VERSION,
				daemonVersion: "0.1.8",
			},
			testDeps({ fetch: makeFetch() }),
		);

		return bodies.join("\n");
	}

	it("no banned key appears in any serialized payload", async () => {
		const allPayloads = await collectAllPayloads();

		// Test every key in BANNED_ATTRIBUTE_KEYS as a substring of the JSON
		// (keys appear as quoted strings in JSON, e.g. "token").
		for (const bannedKey of BANNED_ATTRIBUTE_KEYS) {
			// We check the key as a JSON key (with quotes) to avoid false positives
			// from values that happen to contain the word "error" etc.
			const jsonKey = `"${bannedKey}"`;
			expect(allPayloads, `banned key "${bannedKey}" found in payload`).not.toContain(jsonKey);
		}
	});

	it("device_id is on the resource (not buried in step outcomes or error detail)", async () => {
		const { mock, calls } = makeMockFetch();
		await emitError(
			{ errorClass: "E", deviceId: FAKE_DEVICE_ID, timestampMs: FAKE_NOW },
			testDeps({ fetch: mock }),
		);

		const call = calls[0];
		if (!call) throw new Error("no call");
		const body = JSON.parse(call.init.body) as Record<string, unknown>;
		const resourceLogs = (body["resourceLogs"] as unknown[])[0] as Record<string, unknown>;
		const resource = resourceLogs["resource"] as { attributes: Array<{ key: string }> };
		const keys = resource.attributes.map((a) => a.key);
		expect(keys).toContain("device_id");
	});

	it("service.name is 'hivedoctor' in resource attributes", async () => {
		const { mock, calls } = makeMockFetch();
		await emitError(
			{ errorClass: "E", deviceId: FAKE_DEVICE_ID, timestampMs: FAKE_NOW },
			testDeps({ fetch: mock }),
		);

		const call = calls[0];
		if (!call) throw new Error("no call");
		const body = JSON.parse(call.init.body) as Record<string, unknown>;
		const resourceLogs = (body["resourceLogs"] as unknown[])[0] as Record<string, unknown>;
		const resource = resourceLogs["resource"] as {
			attributes: Array<{ key: string; value: { stringValue: string } }>;
		};
		const sn = resource.attributes.find((a) => a.key === "service.name");
		expect(sn?.value?.stringValue).toBe("hivedoctor");
	});

	it("the PostHog key does NOT appear in the request body (only in the header)", async () => {
		const { mock, calls } = makeMockFetch();
		await emitError(
			{ errorClass: "E", deviceId: FAKE_DEVICE_ID, timestampMs: FAKE_NOW },
			testDeps({ fetch: mock }),
		);

		const call = calls[0];
		if (!call) throw new Error("no call");
		// The key must be in the header, not the body
		expect(call.init.headers["Authorization"]).toContain(FAKE_KEY);
		expect(call.init.body).not.toContain(FAKE_KEY);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// AC-064d.6 -- sink unreachable -> swallowed, caller unaffected
// ────────────────────────────────────────────────────────────────────────────

describe("AC-064d.6 fail-soft on unreachable sink", () => {
	it("a fetch that throws never propagates -- emitTelemetry resolves to send_failed", async () => {
		const throwingFetch: TelemetryFetch = async () => {
			throw new Error("ECONNREFUSED");
		};

		const outcome = await emitError(
			{ errorClass: "TestError", deviceId: FAKE_DEVICE_ID, timestampMs: FAKE_NOW },
			testDeps({ fetch: throwingFetch }),
		);

		// Must resolve, never reject
		expect(outcome.sent).toBe(false);
		expect(outcome.skipped).toBe("send_failed");
	});

	it("a fetch timeout (AbortError) is swallowed and resolves to send_failed", async () => {
		const abortFetch: TelemetryFetch = async (_url, init) => {
			// Simulate the signal firing
			if (init.signal) {
				throw Object.assign(new Error("AbortError"), { name: "AbortError" });
			}
			return { ok: true, status: 200 };
		};

		const outcome = await emitError(
			{ errorClass: "TestError", deviceId: FAKE_DEVICE_ID, timestampMs: FAKE_NOW },
			testDeps({ fetch: abortFetch }),
		);

		expect(outcome.sent).toBe(false);
		expect(outcome.skipped).toBe("send_failed");
	});

	it("a 500 response is treated as send_failed and not thrown", async () => {
		const { mock } = makeMockFetch(500);
		const outcome = await emitError(
			{ errorClass: "TestError", deviceId: FAKE_DEVICE_ID, timestampMs: FAKE_NOW },
			testDeps({ fetch: mock }),
		);
		expect(outcome.sent).toBe(false);
		expect(outcome.skipped).toBe("send_failed");
	});

	it("emitTelemetry never throws even on a completely broken fetch seam", async () => {
		const brokenFetch: TelemetryFetch = () => {
			throw new TypeError("fetch is not a function");
		};

		// This must not throw; it must resolve
		const result = await emitTelemetry(
			{ kind: "error", errorClass: "E", deviceId: FAKE_DEVICE_ID, timestampMs: FAKE_NOW },
			testDeps({ fetch: brokenFetch }),
		);
		expect(result.sent).toBe(false);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// OTLP URL and structure validation
// ────────────────────────────────────────────────────────────────────────────

describe("OTLP URL and structure", () => {
	it("posts to the correct OTLP Logs path", async () => {
		const { mock, calls } = makeMockFetch();
		await emitError(
			{ errorClass: "E", deviceId: FAKE_DEVICE_ID, timestampMs: FAKE_NOW },
			testDeps({ fetch: mock }),
		);

		const call = calls[0];
		if (!call) throw new Error("no call");
		expect(call.url.endsWith(OTLP_LOGS_PATH)).toBe(true);
		expect(call.url).toBe(`${FAKE_HOST}/i/v1/logs`);
	});

	it("uses Authorization: Bearer (not ?token= query param)", async () => {
		const { mock, calls } = makeMockFetch();
		await emitError(
			{ errorClass: "E", deviceId: FAKE_DEVICE_ID, timestampMs: FAKE_NOW },
			testDeps({ fetch: mock }),
		);

		const call = calls[0];
		if (!call) throw new Error("no call");
		expect(call.init.headers["Authorization"]).toBe(`Bearer ${FAKE_KEY}`);
		expect(call.url).not.toContain("token=");
		expect(call.url).not.toContain("api_key=");
	});

	it("Content-Type is application/json", async () => {
		const { mock, calls } = makeMockFetch();
		await emitError(
			{ errorClass: "E", deviceId: FAKE_DEVICE_ID, timestampMs: FAKE_NOW },
			testDeps({ fetch: mock }),
		);

		const call = calls[0];
		if (!call) throw new Error("no call");
		expect(call.init.headers["Content-Type"]).toBe("application/json");
	});

	it("timeUnixNano is a string in the payload (not a number)", async () => {
		const { mock, calls } = makeMockFetch();
		await emitError(
			{ errorClass: "E", deviceId: FAKE_DEVICE_ID, timestampMs: FAKE_NOW },
			testDeps({ fetch: mock }),
		);

		const call = calls[0];
		if (!call) throw new Error("no call");
		// The raw JSON should have the nanostring in quotes
		expect(call.init.body).toMatch(/"timeUnixNano"\s*:\s*"\d+"/);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Convenience helpers (emitError / emitInstallHealth / emitEpisode)
// ────────────────────────────────────────────────────────────────────────────

describe("convenience helpers", () => {
	it("emitError delegates to emitTelemetry with kind='error'", async () => {
		const { mock, calls } = makeMockFetch();
		await emitError(
			{ errorClass: "CE", deviceId: FAKE_DEVICE_ID, timestampMs: FAKE_NOW },
			testDeps({ fetch: mock }),
		);
		expect(calls).toHaveLength(1);
	});

	it("emitInstallHealth delegates to emitTelemetry with kind='install-health'", async () => {
		const { mock, calls } = makeMockFetch();
		await emitInstallHealth(
			{
				deviceId: FAKE_DEVICE_ID,
				timestampMs: FAKE_NOW,
				lastKnownHealth: "ok",
				lastHealAgeSeconds: 0,
				hivedoctorVersion: FAKE_VERSION,
				daemonVersion: "0.1.8",
			},
			testDeps({ fetch: mock }),
		);
		expect(calls).toHaveLength(1);
	});

	it("emitEpisode delegates to emitTelemetry with kind='episode'", async () => {
		const { mock, calls } = makeMockFetch();
		await emitEpisode(
			{
				incident: makeIncident(),
				deviceId: FAKE_DEVICE_ID,
				timestampMs: FAKE_NOW,
				hivedoctorVersion: FAKE_VERSION,
				daemonVersion: "0.1.8",
			},
			testDeps({ fetch: mock }),
		);
		expect(calls).toHaveLength(1);
	});
});

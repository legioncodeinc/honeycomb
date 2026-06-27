/**
 * Unit tests for the hand-rolled OTLP LogsData JSON serializer (PRD-064d AC-064d.7).
 *
 * These tests validate the JSON shape against the OTLP Logs schema without any
 * network calls. The assertions are structural: they verify that the serializer
 * produces a valid OTLP envelope that PostHog Logs (a generic OTLP/HTTP+JSON
 * receiver) would accept.
 *
 * AC-064d.7: no @opentelemetry/* dependency -- asserted by checking that
 * hivedoctor/package.json has no such entry (last test in this file).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	SEVERITY_ERROR,
	SEVERITY_INFO,
	SEVERITY_WARN,
	buildLogRecord,
	buildLogsData,
	msToNanoString,
	serializeLogsData,
	toAnyValue,
	toAttributes,
} from "../../src/telemetry/otlp-serializer.js";

// ────────────────────────────────────────────────────────────────────────────
// toAnyValue
// ────────────────────────────────────────────────────────────────────────────

describe("toAnyValue", () => {
	it("wraps a string as stringValue", () => {
		expect(toAnyValue("hello")).toStrictEqual({ stringValue: "hello" });
	});

	it("wraps true as boolValue", () => {
		expect(toAnyValue(true)).toStrictEqual({ boolValue: true });
	});

	it("wraps false as boolValue", () => {
		expect(toAnyValue(false)).toStrictEqual({ boolValue: false });
	});

	it("wraps an integer as intValue", () => {
		expect(toAnyValue(42)).toStrictEqual({ intValue: 42 });
	});

	it("wraps a float as doubleValue", () => {
		expect(toAnyValue(3.14)).toStrictEqual({ doubleValue: 3.14 });
	});

	it("coerces null to stringValue", () => {
		expect(toAnyValue(null)).toStrictEqual({ stringValue: "null" });
	});

	it("coerces undefined to stringValue", () => {
		expect(toAnyValue(undefined)).toStrictEqual({ stringValue: "undefined" });
	});

	it("coerces an object to its string representation", () => {
		expect(toAnyValue({ x: 1 })).toStrictEqual({ stringValue: "[object Object]" });
	});

	it("coerces an array to its string representation", () => {
		expect(toAnyValue([1, 2])).toStrictEqual({ stringValue: "1,2" });
	});

	it("coerces NaN to stringValue", () => {
		expect(toAnyValue(Number.NaN)).toStrictEqual({ stringValue: "NaN" });
	});

	it("coerces Infinity to stringValue", () => {
		expect(toAnyValue(Infinity)).toStrictEqual({ stringValue: "Infinity" });
	});
});

// ────────────────────────────────────────────────────────────────────────────
// toAttributes
// ────────────────────────────────────────────────────────────────────────────

describe("toAttributes", () => {
	it("produces an array of key-value pairs with OTLP AnyValue wrappers", () => {
		const result = toAttributes({ "service.name": "hivedoctor", version: "1.0.0" });
		expect(result).toHaveLength(2);
		expect(result[0]).toStrictEqual({ key: "service.name", value: { stringValue: "hivedoctor" } });
		expect(result[1]).toStrictEqual({ key: "version", value: { stringValue: "1.0.0" } });
	});

	it("produces an empty array for an empty object", () => {
		expect(toAttributes({})).toStrictEqual([]);
	});

	it("preserves insertion order", () => {
		const result = toAttributes({ a: "1", b: "2", c: "3" });
		expect(result.map((kv) => kv.key)).toStrictEqual(["a", "b", "c"]);
	});

	it("wraps boolean values correctly", () => {
		const result = toAttributes({ flag: true });
		expect(result[0]).toStrictEqual({ key: "flag", value: { boolValue: true } });
	});
});

// ────────────────────────────────────────────────────────────────────────────
// msToNanoString
// ────────────────────────────────────────────────────────────────────────────

describe("msToNanoString", () => {
	it("converts 0 ms to '0'", () => {
		expect(msToNanoString(0)).toBe("0");
	});

	it("converts 1 ms to '1000000'", () => {
		expect(msToNanoString(1)).toBe("1000000");
	});

	it("converts 1000 ms (1 second) to '1000000000'", () => {
		expect(msToNanoString(1_000)).toBe("1000000000");
	});

	it("handles a realistic Date.now() value without precision loss", () => {
		// 2026-01-01T00:00:00.000Z in ms
		const ms = 1_767_225_600_000;
		const ns = msToNanoString(ms);
		expect(ns).toBe("1767225600000000000");
		// Verify it is a valid integer string
		expect(/^\d+$/.test(ns)).toBe(true);
	});

	it("truncates fractional ms", () => {
		// 1.7 ms should floor to 1 ms = 1000000 ns
		expect(msToNanoString(1.7)).toBe("1000000");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Severity constants
// ────────────────────────────────────────────────────────────────────────────

describe("severity constants", () => {
	it("SEVERITY_INFO is 9", () => {
		expect(SEVERITY_INFO).toBe(9);
	});

	it("SEVERITY_WARN is 13", () => {
		expect(SEVERITY_WARN).toBe(13);
	});

	it("SEVERITY_ERROR is 17", () => {
		expect(SEVERITY_ERROR).toBe(17);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// buildLogRecord
// ────────────────────────────────────────────────────────────────────────────

describe("buildLogRecord", () => {
	it("builds a valid OTLP log record with ERROR severity", () => {
		const record = buildLogRecord({
			timestampMs: 1_000,
			severityNumber: SEVERITY_ERROR,
			severityText: "ERROR",
			body: "ProbeTimeoutError",
			attributes: { stream: "error", error_class: "ProbeTimeoutError" },
		});

		expect(record.timeUnixNano).toBe("1000000000");
		expect(record.severityNumber).toBe(17);
		expect(record.severityText).toBe("ERROR");
		expect(record.body).toStrictEqual({ stringValue: "ProbeTimeoutError" });
		expect(record.attributes).toHaveLength(2);
		expect(record.attributes.find((a) => a.key === "stream")).toStrictEqual({
			key: "stream",
			value: { stringValue: "error" },
		});
		expect(record.attributes.find((a) => a.key === "error_class")).toStrictEqual({
			key: "error_class",
			value: { stringValue: "ProbeTimeoutError" },
		});
	});

	it("builds a valid OTLP log record with INFO severity", () => {
		const record = buildLogRecord({
			timestampMs: 2_000,
			severityNumber: SEVERITY_INFO,
			severityText: "INFO",
			body: "install-health: ok",
			attributes: { stream: "install-health", health: "ok" },
		});

		expect(record.severityNumber).toBe(9);
		expect(record.severityText).toBe("INFO");
	});

	it("builds a valid OTLP log record with WARN severity", () => {
		const record = buildLogRecord({
			timestampMs: 3_000,
			severityNumber: SEVERITY_WARN,
			severityText: "WARN",
			body: "episode: trigger=unreachable resolved=false",
			attributes: { stream: "episode", resolved: "false" },
		});

		expect(record.severityNumber).toBe(13);
		expect(record.severityText).toBe("WARN");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// buildLogsData
// ────────────────────────────────────────────────────────────────────────────

describe("buildLogsData", () => {
	it("produces a valid OTLP LogsData envelope", () => {
		const logRecord = buildLogRecord({
			timestampMs: 1_000,
			severityNumber: SEVERITY_INFO,
			severityText: "INFO",
			body: "test",
			attributes: { stream: "error" },
		});

		const data = buildLogsData({
			resourceAttributes: { "service.name": "hivedoctor", device_id: "device-123" },
			scopeName: "hivedoctor",
			scopeVersion: "0.1.0",
			logRecords: [logRecord],
		});

		// Top-level shape
		expect(data).toHaveProperty("resourceLogs");
		expect(Array.isArray(data.resourceLogs)).toBe(true);
		expect(data.resourceLogs).toHaveLength(1);

		// Resource
		const resourceLogs = data.resourceLogs[0];
		expect(resourceLogs).toBeDefined();
		if (!resourceLogs) throw new Error("no resourceLogs[0]");
		expect(resourceLogs).toHaveProperty("resource");
		expect(resourceLogs.resource).toHaveProperty("attributes");
		expect(Array.isArray(resourceLogs.resource.attributes)).toBe(true);

		const serviceName = resourceLogs.resource.attributes.find((a) => a.key === "service.name");
		expect(serviceName).toStrictEqual({ key: "service.name", value: { stringValue: "hivedoctor" } });
		const deviceId = resourceLogs.resource.attributes.find((a) => a.key === "device_id");
		expect(deviceId).toStrictEqual({ key: "device_id", value: { stringValue: "device-123" } });

		// scopeLogs
		expect(resourceLogs).toHaveProperty("scopeLogs");
		expect(Array.isArray(resourceLogs.scopeLogs)).toBe(true);
		expect(resourceLogs.scopeLogs).toHaveLength(1);

		const scopeLogs = resourceLogs.scopeLogs[0];
		expect(scopeLogs).toBeDefined();
		if (!scopeLogs) throw new Error("no scopeLogs[0]");
		expect(scopeLogs.scope).toStrictEqual({ name: "hivedoctor", version: "0.1.0" });
		expect(Array.isArray(scopeLogs.logRecords)).toBe(true);
		expect(scopeLogs.logRecords).toHaveLength(1);
	});

	it("can carry multiple log records", () => {
		const makeRecord = (body: string) =>
			buildLogRecord({
				timestampMs: 1_000,
				severityNumber: SEVERITY_INFO,
				severityText: "INFO",
				body,
				attributes: { stream: "install-health" },
			});

		const data = buildLogsData({
			resourceAttributes: { "service.name": "hivedoctor" },
			scopeName: "hivedoctor",
			scopeVersion: "0.0.0",
			logRecords: [makeRecord("a"), makeRecord("b")],
		});

		const scopeLogs = data.resourceLogs[0]?.scopeLogs[0];
		expect(scopeLogs?.logRecords).toHaveLength(2);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// serializeLogsData (JSON round-trip)
// ────────────────────────────────────────────────────────────────────────────

describe("serializeLogsData", () => {
	it("produces valid JSON that round-trips", () => {
		const logRecord = buildLogRecord({
			timestampMs: 1_000,
			severityNumber: SEVERITY_ERROR,
			severityText: "ERROR",
			body: "ProbeTimeoutError",
			attributes: { stream: "error" },
		});
		const data = buildLogsData({
			resourceAttributes: { "service.name": "hivedoctor", device_id: "abc" },
			scopeName: "hivedoctor",
			scopeVersion: "0.0.0",
			logRecords: [logRecord],
		});

		const json = serializeLogsData(data);
		expect(() => JSON.parse(json)).not.toThrow();

		const parsed = JSON.parse(json) as typeof data;
		expect(parsed.resourceLogs).toHaveLength(1);
		expect(parsed.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.severityText).toBe("ERROR");
	});

	it("includes timeUnixNano as a string (not a number) to preserve uint64 precision", () => {
		const logRecord = buildLogRecord({
			timestampMs: 1_767_225_600_000,
			severityNumber: SEVERITY_INFO,
			severityText: "INFO",
			body: "test",
			attributes: {},
		});
		const data = buildLogsData({
			resourceAttributes: {},
			scopeName: "hivedoctor",
			scopeVersion: "0.0.0",
			logRecords: [logRecord],
		});

		const json = serializeLogsData(data);
		// The JSON should contain the nanosecond string in quotes (as a JSON string),
		// not as a bare number (which would lose precision).
		expect(json).toContain('"1767225600000000000"');
	});

	it("does not include undefined values in the output", () => {
		const logRecord = buildLogRecord({
			timestampMs: 1_000,
			severityNumber: SEVERITY_INFO,
			severityText: "INFO",
			body: "test",
			attributes: {},
		});
		const data = buildLogsData({
			resourceAttributes: {},
			scopeName: "hivedoctor",
			scopeVersion: "0.0.0",
			logRecords: [logRecord],
		});

		const json = serializeLogsData(data);
		expect(json).not.toContain("undefined");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// AC-064d.7 -- no @opentelemetry/* dependency in hivedoctor/package.json
// ────────────────────────────────────────────────────────────────────────────

describe("AC-064d.7 no OpenTelemetry SDK dependency", () => {
	it("hivedoctor/package.json has no @opentelemetry/* entry in any dep field", () => {
		// Resolve the path relative to this test file so it works from any cwd.
		const dir = fileURLToPath(new URL("../../", import.meta.url));
		const pkgPath = join(dir, "package.json");
		const raw = readFileSync(pkgPath, "utf8");
		const pkg = JSON.parse(raw) as Record<string, unknown>;

		const allDeps: Record<string, string> = {
			...((pkg["dependencies"] as Record<string, string> | undefined) ?? {}),
			...((pkg["devDependencies"] as Record<string, string> | undefined) ?? {}),
			...((pkg["peerDependencies"] as Record<string, string> | undefined) ?? {}),
			...((pkg["optionalDependencies"] as Record<string, string> | undefined) ?? {}),
		};

		const otlpDeps = Object.keys(allDeps).filter((k) => k.startsWith("@opentelemetry/"));
		expect(otlpDeps).toStrictEqual([]);
	});
});

/**
 * PRD-071c — the fleet log tap (`logs.ts`): mirrors the daemon's existing request/event logger
 * records into the fleet telemetry store's `service_logs` table via the SAME `LogWriteThrough`
 * seam `createRequestLogger({ store })` already accepts (PRD-043a) — no second logging framework.
 */

import { describe, expect, it } from "vitest";

import type { EventLogRecord, RequestLogRecord } from "../../../../src/daemon/runtime/logger.js";
import { openFleetTelemetryStore } from "../../../../src/daemon/runtime/telemetry/fleet-store.js";
import {
	combineLogWriteThrough,
	createFleetLogTap,
	formatEventLogMessage,
	formatRequestLogMessage,
	levelForEvent,
	levelForStatus,
} from "../../../../src/daemon/runtime/telemetry/logs.js";

function requestRecord(overrides: Partial<RequestLogRecord> = {}): RequestLogRecord {
	return {
		time: "2026-06-29T12:00:00.000Z",
		method: "GET",
		path: "/health",
		status: 200,
		durationMs: 3,
		mode: "local",
		...overrides,
	};
}

describe("PRD-071c: levelForStatus / formatRequestLogMessage", () => {
	it("maps 5xx -> error, 4xx -> warn, else -> info", () => {
		expect(levelForStatus(500)).toBe("error");
		expect(levelForStatus(503)).toBe("error");
		expect(levelForStatus(404)).toBe("warn");
		expect(levelForStatus(400)).toBe("warn");
		expect(levelForStatus(200)).toBe("info");
		expect(levelForStatus(304)).toBe("info");
	});

	it("formats a compact, secret-free one-line request summary", () => {
		const msg = formatRequestLogMessage(
			requestRecord({ method: "POST", path: "/api/memories", status: 201, durationMs: 12.7 }),
		);
		expect(msg).toBe("POST /api/memories -> 201 (13ms)");
	});
});

describe("PRD-071c: levelForEvent / formatEventLogMessage", () => {
	it("names an error/fail-shaped event 'error', a degrad/warn-shaped one 'warn', else 'info'", () => {
		const evt = (name: string): EventLogRecord => ({ time: "t", event: name, fields: {} });
		expect(levelForEvent(evt("recall.error"))).toBe("error");
		expect(levelForEvent(evt("embed.spawn_failed"))).toBe("error");
		expect(levelForEvent(evt("recall.degraded"))).toBe("warn");
		expect(levelForEvent(evt("pipeline.started"))).toBe("info");
	});

	it("formats the event name plus its coarse fields as JSON", () => {
		const msg = formatEventLogMessage({ time: "t", event: "recall.degraded", fields: { reason: "storage" } });
		expect(msg).toBe('recall.degraded {"reason":"storage"}');
	});
});

describe("PRD-071c / AC-5 / AC-8: createFleetLogTap", () => {
	it("AC-5 mirrors a request record into service_logs with the mapped level", () => {
		const store = openFleetTelemetryStore({ memory: true });
		const tap = createFleetLogTap(store);
		tap.appendRequest(requestRecord({ status: 500, method: "POST", path: "/api/memories" }));
		const rows = store.readRecentLogs();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.level).toBe("error");
		expect(rows[0]?.message).toContain("POST /api/memories -> 500");
		store.close();
	});

	it("AC-5 mirrors an event record into service_logs", () => {
		const store = openFleetTelemetryStore({ memory: true });
		const tap = createFleetLogTap(store);
		tap.appendEvent({ time: "t", event: "recall.degraded", fields: { reason: "storage" } });
		const rows = store.readRecentLogs();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.level).toBe("warn");
		expect(rows[0]?.message).toContain("recall.degraded");
		store.close();
	});

	it("AC-071c.3.2 drops a record whose formatted message cannot be safely redacted", () => {
		const store = openFleetTelemetryStore({ memory: true });
		const tap = createFleetLogTap(store);
		// An event whose fields accidentally carry a secret-shaped value must be caught by the
		// redaction pass even though `logger.ts`'s own record shapes carry no header/token field.
		tap.appendEvent({
			time: "t",
			event: "misconfigured.leak",
			fields: { blob: "-----BEGIN PRIVATE KEY-----\nMIIB..." },
		});
		expect(store.readRecentLogs()).toEqual([]);
		store.close();
	});

	it("AC-8 rotation is the store's job: a burst of taps beyond the cap still stays bounded", () => {
		const store = openFleetTelemetryStore({ memory: true, maxLogRows: 3 });
		const tap = createFleetLogTap(store);
		for (let i = 0; i < 10; i++) {
			tap.appendRequest(requestRecord({ path: `/p${i}` }));
		}
		expect(store.readRecentLogs(100)).toHaveLength(3);
		store.close();
	});
});

describe("PRD-071c: combineLogWriteThrough", () => {
	it("fans one write-through call out to every target", () => {
		const calls: string[] = [];
		const target = (name: string) => ({
			appendRequest(): void {
				calls.push(`req:${name}`);
			},
			appendEvent(): void {
				calls.push(`evt:${name}`);
			},
		});
		const combined = combineLogWriteThrough(target("a"), target("b"));
		combined.appendRequest(requestRecord());
		combined.appendEvent({ time: "t", event: "x", fields: {} });
		expect(calls).toEqual(["req:a", "req:b", "evt:a", "evt:b"]);
	});

	it("combines the fleet tap with another LogWriteThrough so both receive every record", () => {
		const store = openFleetTelemetryStore({ memory: true });
		const seen: string[] = [];
		const other = {
			appendRequest(record: RequestLogRecord): void {
				seen.push(record.path);
			},
			appendEvent(): void {},
		};
		const combined = combineLogWriteThrough(other, createFleetLogTap(store));
		combined.appendRequest(requestRecord({ path: "/api/status" }));
		expect(seen).toEqual(["/api/status"]);
		expect(store.readRecentLogs()).toHaveLength(1);
		store.close();
	});
});

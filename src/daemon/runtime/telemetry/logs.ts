/**
 * The fleet log tap — PRD-071c (AC-5 / AC-8 / AC-071c.1 / AC-071c.2 / AC-071c.3).
 *
 * Mirrors non-sensitive lines from honeycomb's EXISTING daemon logger (`logger.ts`'s
 * {@link RequestLogRecord} / {@link EventLogRecord}) into the fleet telemetry SQLite's
 * `service_logs` table, WITHOUT a second logging framework: {@link createFleetLogTap} builds a
 * {@link LogWriteThrough} — the SAME narrow write-through seam `createRequestLogger({ store })`
 * already accepts (PRD-043a) — so the daemon composition root (`assemble.ts`) tees each record into
 * BOTH the existing durable request-log store AND this fleet tap via {@link combineLogWriteThrough},
 * with zero changes to `logger.ts` itself.
 *
 * Every line is redacted (`redact.ts`) before it reaches {@link FleetTelemetryStore.appendLog};
 * a line that cannot be safely redacted is DROPPED rather than written (AC-071c.3.2). Rotation to
 * the row cap is `fleet-store.ts`'s job (it runs on every `appendLog`, AC-8).
 */

import type { EventLogRecord, LogWriteThrough, RequestLogRecord } from "../logger.js";
import type { FleetLogLevel, FleetTelemetryStore } from "./fleet-store.js";
import { redactLogMessage } from "./redact.js";

/** Map an HTTP status to a verbosity level: 5xx → error, 4xx → warn, else → info. */
export function levelForStatus(status: number): FleetLogLevel {
	if (status >= 500) return "error";
	if (status >= 400) return "warn";
	return "info";
}

/** A compact, secret-free one-line summary of a completed request. */
export function formatRequestLogMessage(record: RequestLogRecord): string {
	return `${record.method} ${record.path} -> ${record.status} (${Math.round(record.durationMs)}ms)`;
}

/** A named subsystem event's message: the event name plus its (caller-scrubbed) coarse fields. */
export function formatEventLogMessage(record: EventLogRecord): string {
	let fieldsJson: string;
	try {
		fieldsJson = JSON.stringify(record.fields);
	} catch {
		fieldsJson = "{}";
	}
	return `${record.event} ${fieldsJson}`;
}

/** A best-effort level for a named event: an "error"/"fail"-shaped or "degrad"/"warn"-shaped name wins. */
export function levelForEvent(record: EventLogRecord): FleetLogLevel {
	const name = record.event.toLowerCase();
	if (name.includes("error") || name.includes("fail")) return "error";
	if (name.includes("degrad") || name.includes("warn")) return "warn";
	return "info";
}

/** Redact, then write (or drop) one message at the given level (AC-071c.3.2). */
function writeRedacted(store: FleetTelemetryStore, level: FleetLogLevel, message: string): void {
	const redacted = redactLogMessage(message);
	if (redacted === null) return;
	store.appendLog(level, redacted);
}

/**
 * Build the fleet log tap: a {@link LogWriteThrough} that mirrors every request/event record into
 * `service_logs`. Pass this (optionally combined via {@link combineLogWriteThrough}) as the `store`
 * option to `createRequestLogger` — the same seam the durable request-log store already uses.
 */
export function createFleetLogTap(store: FleetTelemetryStore): LogWriteThrough {
	return {
		appendRequest(record: RequestLogRecord): void {
			writeRedacted(store, levelForStatus(record.status), formatRequestLogMessage(record));
		},
		appendEvent(record: EventLogRecord): void {
			writeRedacted(store, levelForEvent(record), formatEventLogMessage(record));
		},
	};
}

/**
 * Fan a single logger write-through call out to every supplied {@link LogWriteThrough} (e.g. the
 * existing PRD-043a durable request-log store PLUS this fleet tap), so `createRequestLogger` is
 * still constructed with exactly ONE `store` option. Each target's own methods are already
 * fail-soft; this wrapper adds nothing that could throw.
 */
export function combineLogWriteThrough(...targets: readonly LogWriteThrough[]): LogWriteThrough {
	return {
		appendRequest(record: RequestLogRecord): void {
			for (const target of targets) target.appendRequest(record);
		},
		appendEvent(record: EventLogRecord): void {
			for (const target of targets) target.appendEvent(record);
		},
	};
}

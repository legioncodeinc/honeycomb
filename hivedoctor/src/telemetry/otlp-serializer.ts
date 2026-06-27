/**
 * Hand-rolled OTLP Logs JSON serializer (PRD-064d AC-064d.7).
 *
 * PostHog Logs is an OTLP/HTTP+JSON receiver at `{host}/i/v1/logs`. Because
 * HiveDoctor's design principle 1 forbids runtime npm dependencies, we hand-roll
 * the `LogsData` envelope instead of pulling `@opentelemetry/otlp-exporter-*` or
 * any SDK package. The wire format is OTLP Protobuf-JSON encoding (the subset
 * PostHog's alpha logs endpoint accepts): `resourceLogs -> scopeLogs ->
 * logRecords`, with OTLP `AnyValue` wrappers for every attribute value.
 *
 * This module has NO side effects. Every export is a pure serialization helper
 * so unit tests can validate the JSON shape without touching the network.
 *
 * Severity numbers follow the OTLP Log Data Model specification:
 *   TRACE=1..4  DEBUG=5..8  INFO=9..12  WARN=13..16  ERROR=17..20  FATAL=21..24
 * We only use INFO (9), WARN (13), and ERROR (17).
 *
 * References:
 *   https://opentelemetry.io/docs/specs/otlp/#otlphttp
 *   https://opentelemetry.io/docs/specs/otel/logs/data-model/
 *   https://posthog.com/docs/product-analytics/logs (alpha, pinned)
 */

// ────────────────────────────────────────────────────────────────────────────
// OTLP AnyValue (the tagged-union value wrapper OTLP uses for every attribute)
// ────────────────────────────────────────────────────────────────────────────

/** An OTLP AnyValue -- the tagged union the spec uses for attribute values. */
export type OtlpAnyValue =
	| { readonly stringValue: string }
	| { readonly boolValue: boolean }
	| { readonly intValue: number }
	| { readonly doubleValue: number }
	| { readonly arrayValue: { readonly values: readonly OtlpAnyValue[] } }
	| { readonly kvlistValue: { readonly values: readonly OtlpKeyValue[] } };

/** An OTLP key-value pair used in resource/scope/log attributes. */
export interface OtlpKeyValue {
	readonly key: string;
	readonly value: OtlpAnyValue;
}

/**
 * Wrap a primitive JS value in an OTLP AnyValue. Only string, boolean, and
 * finite numbers survive; anything else is coerced to its string representation
 * so no undefined/object/function can leak into the wire payload.
 */
export function toAnyValue(v: unknown): OtlpAnyValue {
	if (typeof v === "string") return { stringValue: v };
	if (typeof v === "boolean") return { boolValue: v };
	if (typeof v === "number" && Number.isFinite(v)) {
		return Number.isInteger(v) ? { intValue: v } : { doubleValue: v };
	}
	// Coerce arrays, objects, null, undefined, BigInt, Symbol to a string so the
	// serializer never drops a field silently and never emits a nested object that
	// would violate the allow-list.
	return { stringValue: String(v) };
}

/**
 * Convert a flat `Record<string, unknown>` into an array of OTLP key-value pairs.
 * Only own-enumerable keys are included. The key order is deterministic (insertion
 * order) so test snapshot comparisons are stable.
 */
export function toAttributes(attrs: Readonly<Record<string, unknown>>): OtlpKeyValue[] {
	return Object.entries(attrs).map(([key, value]) => ({ key, value: toAnyValue(value) }));
}

// ────────────────────────────────────────────────────────────────────────────
// Severity constants
// ────────────────────────────────────────────────────────────────────────────

/** OTLP severity number for INFO (9 per the spec). */
export const SEVERITY_INFO = 9 as const;
/** OTLP severity number for WARN (13 per the spec). */
export const SEVERITY_WARN = 13 as const;
/** OTLP severity number for ERROR (17 per the spec). */
export const SEVERITY_ERROR = 17 as const;

/** The severity text labels that correspond to our three numbers. */
export type SeverityText = "INFO" | "WARN" | "ERROR";

// ────────────────────────────────────────────────────────────────────────────
// OTLP LogRecord
// ────────────────────────────────────────────────────────────────────────────

/**
 * One OTLP log record (the fields we populate; optional fields omitted).
 * `timeUnixNano` is a string in the JSON encoding (uint64 does not fit JS number).
 */
export interface OtlpLogRecord {
	/** Epoch time in nanoseconds as a decimal string (OTLP JSON encoding of uint64). */
	readonly timeUnixNano: string;
	/** Numeric severity (9=INFO, 13=WARN, 17=ERROR). */
	readonly severityNumber: number;
	/** Human-readable severity label. */
	readonly severityText: SeverityText;
	/** The log body as an AnyValue (we always use stringValue). */
	readonly body: OtlpAnyValue;
	/** Per-record attributes (stream-specific fields). */
	readonly attributes: readonly OtlpKeyValue[];
}

/** Convert a `Date.now()` millisecond timestamp to the OTLP nanosecond string. */
export function msToNanoString(ms: number): string {
	// Multiply by 1_000_000 to go from ms to ns. BigInt avoids floating-point
	// precision loss for timestamps past 2^53.
	return (BigInt(Math.floor(ms)) * BigInt(1_000_000)).toString();
}

/** Build one OTLP log record from the caller-supplied fields. */
export function buildLogRecord(input: {
	readonly timestampMs: number;
	readonly severityNumber: number;
	readonly severityText: SeverityText;
	readonly body: string;
	readonly attributes: Readonly<Record<string, unknown>>;
}): OtlpLogRecord {
	return {
		timeUnixNano: msToNanoString(input.timestampMs),
		severityNumber: input.severityNumber,
		severityText: input.severityText,
		body: { stringValue: input.body },
		attributes: toAttributes(input.attributes),
	};
}

// ────────────────────────────────────────────────────────────────────────────
// OTLP ScopeLogs, ResourceLogs, LogsData
// ────────────────────────────────────────────────────────────────────────────

/** OTLP instrumentation scope (name + version identify the emitting library). */
export interface OtlpInstrumentationScope {
	readonly name: string;
	readonly version: string;
}

/** One OTLP scope-logs grouping: a scope + the records it emitted. */
export interface OtlpScopeLogs {
	readonly scope: OtlpInstrumentationScope;
	readonly logRecords: readonly OtlpLogRecord[];
}

/** One OTLP resource-logs grouping: a resource + its scope batches. */
export interface OtlpResourceLogs {
	readonly resource: {
		readonly attributes: readonly OtlpKeyValue[];
	};
	readonly scopeLogs: readonly OtlpScopeLogs[];
}

/** The top-level OTLP LogsData envelope. */
export interface OtlpLogsData {
	readonly resourceLogs: readonly OtlpResourceLogs[];
}

/**
 * Build the complete OTLP LogsData envelope for a batch of log records that all
 * share the same resource attributes and scope.
 *
 * `resourceAttributes` carries the `service.name`, `device_id`, OS, and version
 * fields that are shared across every record in one POST call. They land in the
 * OTLP resource (not per-record) so PostHog can group by service/device without
 * repeating them in every log line.
 */
export function buildLogsData(input: {
	readonly resourceAttributes: Readonly<Record<string, unknown>>;
	readonly scopeName: string;
	readonly scopeVersion: string;
	readonly logRecords: readonly OtlpLogRecord[];
}): OtlpLogsData {
	return {
		resourceLogs: [
			{
				resource: {
					attributes: toAttributes(input.resourceAttributes),
				},
				scopeLogs: [
					{
						scope: { name: input.scopeName, version: input.scopeVersion },
						logRecords: input.logRecords,
					},
				],
			},
		],
	};
}

/**
 * Serialize a `LogsData` envelope to the JSON string that goes in the POST body.
 * This is the only place `JSON.stringify` is called so serialization errors are
 * caught in one spot.
 */
export function serializeLogsData(data: OtlpLogsData): string {
	return JSON.stringify(data);
}

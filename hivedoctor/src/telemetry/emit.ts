/**
 * HiveDoctor's SINGLE telemetry-egress chokepoint (PRD-064d).
 *
 * `emitTelemetry(record, deps)` is the ONLY function that posts to the PostHog
 * Logs OTLP endpoint. Three streams flow through it:
 *
 *   1. errors         - severity ERROR  (AC-064d.1)
 *   2. install-health - severity INFO   (AC-064d.2)
 *   3. episodes       - severity INFO/WARN sourced from incidents.ndjson (AC-064d.3)
 *
 * ALL three flow through this ONE function so opt-out is verifiable in a single
 * place (AC-064d.4, design principle 6 "honest opt-out").
 *
 * ── Transport (OD-2 resolved) ──────────────────────────────────────────────
 * PostHog Logs over OTLP/HTTP+JSON at `{host}/i/v1/logs`. We hand-roll the
 * `LogsData` envelope (see `./otlp-serializer.ts`) and POST via the global
 * `fetch` so there is NO OpenTelemetry SDK dependency (AC-064d.7, design
 * principle 1 "incapable of crashing -- Node built-ins only").
 *
 * ── Gates, in order ────────────────────────────────────────────────────────
 *   1. Empty key (build not keyed or env fallback empty)  -> hard-disabled.
 *   2. DO_NOT_TRACK=1                                     -> opted out.
 *   3. HONEYCOMB_TELEMETRY=0                              -> opted out.
 *   4. state.json `telemetryDisabled: true`               -> opted out (OD-5).
 * Any gate hit: nothing leaves the box (AC-064d.4).
 *
 * ── Fire-and-forget, fail-soft (AC-064d.6) ─────────────────────────────────
 * The POST is wrapped in an AbortController timeout + a try/catch that swallows
 * all errors. `emitTelemetry` resolves to a structured `EmitOutcome` but NEVER
 * rejects and NEVER throws into the calling healing loop.
 *
 * ── Allow-list scrubbing (AC-064d.5) ───────────────────────────────────────
 * Only fields on ALLOWED_ATTRIBUTE_KEYS leave the box. Credential contents,
 * tokens, file paths, and PII are structurally impossible: they are not on the
 * allow-list and `buildAllowedAttributes` drops anything not on it. The
 * BANNED_ATTRIBUTE_KEYS set is the negative enumeration tests assert absent.
 *
 * ── Token hygiene ───────────────────────────────────────────────────────────
 * The PostHog project key (`phc_...`) is a PUBLIC write-only ingest key. It is
 * sent in the `Authorization: Bearer` header (not a query param) so it never
 * lands in an intermediary access log. It is NOT logged anywhere in this module.
 *
 * ── This module carries NO secret ──────────────────────────────────────────
 * The payload holds only allow-listed operational facts: severity, stream kind,
 * device_id (PRD-033 UUID), coarse OS/arch, version strings, remediation step
 * outcomes (fact + outcome, never credential contents), and lastHealAge (age
 * only, never a secret).
 */

import { arch, platform } from "node:os";

import type { Incident } from "../incidents.js";
import type { Logger } from "../logger.js";
import type { HiveDoctorState } from "../state.js";
import {
	SEVERITY_ERROR,
	SEVERITY_INFO,
	SEVERITY_WARN,
	type SeverityText,
	buildLogRecord,
	buildLogsData,
	serializeLogsData,
	toAttributes,
} from "./otlp-serializer.js";

// ────────────────────────────────────────────────────────────────────────────
// Build-injected PostHog destination (mirrors src/shared/globals.d.ts pattern)
// ────────────────────────────────────────────────────────────────────────────

/**
 * The PostHog project write-only ingest key (`phc_...`), build-injected via
 * esbuild `define`. The `typeof` guard means the un-bundled dev build falls
 * through to the env fallback (empty string = telemetry hard-disabled).
 */
export const POSTHOG_KEY: string =
	typeof __HONEYCOMB_POSTHOG_KEY__ === "string" && __HONEYCOMB_POSTHOG_KEY__.length > 0
		? __HONEYCOMB_POSTHOG_KEY__
		: (process.env["HONEYCOMB_POSTHOG_KEY"] ?? "");

/**
 * The PostHog ingest host, build-injected via esbuild `define`. Defaults to
 * the US cloud. The OTLP Logs path is appended to this host.
 */
export const POSTHOG_HOST: string =
	typeof __HONEYCOMB_POSTHOG_HOST__ === "string" && __HONEYCOMB_POSTHOG_HOST__.length > 0
		? __HONEYCOMB_POSTHOG_HOST__
		: (process.env["HONEYCOMB_POSTHOG_HOST"] ?? "https://us.i.posthog.com");

/**
 * The OTLP Logs endpoint path (PostHog Logs alpha, 2026-06-27). Pinned here as
 * the ONE constant so a path change is a one-line edit. The full URL is
 * `${host}${OTLP_LOGS_PATH}`.
 */
export const OTLP_LOGS_PATH = "/i/v1/logs" as const;

/** The OTLP scope name stamped in every envelope. */
export const SCOPE_NAME = "hivedoctor" as const;

/** Build the full OTLP Logs URL from a host string. */
export function otlpLogsUrl(host: string = POSTHOG_HOST): string {
	return `${host.replace(/\/+$/, "")}${OTLP_LOGS_PATH}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Opt-out gate (AC-064d.4)
// ────────────────────────────────────────────────────────────────────────────

/** The Honeycomb-wide opt-out env var name. `HONEYCOMB_TELEMETRY=0` = opted out. */
export const ENV_TELEMETRY = "HONEYCOMB_TELEMETRY" as const;
/** The cross-tool opt-out standard. Any value other than `""` or `"0"` = opted out. */
export const ENV_DO_NOT_TRACK = "DO_NOT_TRACK" as const;

/**
 * True when the user has opted out via either env var. Mirrors the logic in
 * `src/daemon/runtime/telemetry/emit.ts isOptedOut` so the two chokepoints
 * agree on the same env contract.
 */
export function isOptedOut(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env[ENV_TELEMETRY] === "0") return true;
	const dnt = env[ENV_DO_NOT_TRACK];
	return dnt !== undefined && dnt !== "" && dnt !== "0";
}

// ────────────────────────────────────────────────────────────────────────────
// Allow-list scrubbing (AC-064d.5)
// ────────────────────────────────────────────────────────────────────────────

/**
 * The CLOSED allow-list of attribute keys that may leave the machine (AC-064d.5).
 * Any attribute not on this list is DROPPED by `buildAllowedAttributes`. Adding
 * a new telemetry field means adding a key here first -- there is no other egress
 * path.
 *
 * Fields:
 *   `stream`          - which stream fired: "error" | "install-health" | "episode"
 *   `device_id`       - the stable per-install PRD-033 UUID (for correlation)
 *   `service.name`    - always "hivedoctor"
 *   `hivedoctor_version` - the HiveDoctor package version
 *   `daemon_version`  - the Honeycomb daemon version last observed
 *   `os`              - coarse OS family (darwin/win32/linux)
 *   `arch`            - CPU arch (arm64/x64/...)
 *   `health`          - coarse last-known health ("ok"|"degraded"|"unreachable"|"unknown")
 *   `trigger`         - incident trigger ("unreachable"|"timeout"|"degraded"|"unknown")
 *   `resolved`        - "true"|"false" string for whether the episode resolved
 *   `step_count`      - how many steps the episode ran (stringified number)
 *   `step_outcomes`   - comma-separated list of "rung:outcome" (fact, no content)
 *   `last_heal_age_s` - seconds since last successful heal, bucketed (no exact time)
 *   `error_class`     - error constructor name or a stable camel-case label
 *   `error_detail`    - a short scrubbed description (no paths, no creds)
 *   `severity_hint`   - "INFO"|"WARN"|"ERROR" for the stream's chosen severity
 */
export const ALLOWED_ATTRIBUTE_KEYS = [
	"stream",
	"device_id",
	"service.name",
	"hivedoctor_version",
	"daemon_version",
	"os",
	"arch",
	"health",
	"trigger",
	"resolved",
	"step_count",
	"step_outcomes",
	"last_heal_age_s",
	"error_class",
	"error_detail",
	"severity_hint",
] as const;

/** One allow-listed attribute key. */
export type AllowedAttributeKey = (typeof ALLOWED_ATTRIBUTE_KEYS)[number];

/** The positive allow-list as a Set for O(1) membership checks. */
const ALLOWED_KEY_SET: ReadonlySet<string> = new Set(ALLOWED_ATTRIBUTE_KEYS);

/**
 * The BANNED key/value-shape set (AC-064d.5). The negative enumeration the
 * `payload-no-pii` test asserts absent from every serialized payload. Grows as
 * the allow-list grows; the assertion stays one test.
 */
export const BANNED_ATTRIBUTE_KEYS = [
	"token",
	"bearer",
	"authorization",
	"email",
	"username",
	"cwd",
	"path",
	"repo",
	"branch",
	"query",
	"content",
	"prompt",
	"secret",
	"apiKey",
	"api_key",
	"accountId",
	"orgId",
	"workspaceId",
	"password",
	"credentials",
	"stack",
] as const;

/**
 * Filter a raw attribute bag through the allow-list. Only keys on
 * `ALLOWED_ATTRIBUTE_KEYS` survive and only when their value is a string (we
 * keep the OTLP payload flat and string-only at the attribute level; the
 * serializer's `toAttributes` wraps them as `{ stringValue }` automatically).
 * Non-string values are dropped (no object/array can smuggle nested content).
 */
export function buildAllowedAttributes(raw: Readonly<Record<string, unknown>>): Record<AllowedAttributeKey, string> {
	const out = {} as Record<AllowedAttributeKey, string>;
	for (const [key, value] of Object.entries(raw)) {
		if (ALLOWED_KEY_SET.has(key) && typeof value === "string" && value.length > 0) {
			out[key as AllowedAttributeKey] = value;
		}
	}
	return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Coarse platform facts (never hostname, never kernel details)
// ────────────────────────────────────────────────────────────────────────────

/** The coarse platform facts every record carries via resource attributes. */
export function platformFacts(): { os: string; arch: string } {
	return { os: platform(), arch: arch() };
}

// ────────────────────────────────────────────────────────────────────────────
// Telemetry record types (the three streams)
// ────────────────────────────────────────────────────────────────────────────

/** An error event to emit as an ERROR-severity OTLP log (AC-064d.1). */
export interface ErrorRecord {
	readonly kind: "error";
	/** A stable, scrubbed error class label (e.g. "ProbeTimeoutError"). Never a stack trace. */
	readonly errorClass: string;
	/** An optional short scrubbed detail (no paths, no creds, no stack). */
	readonly errorDetail?: string;
	/** The device_id (PRD-033 UUID) for correlation. */
	readonly deviceId: string;
	/** Timestamp in ms. */
	readonly timestampMs: number;
}

/** An install-health snapshot to emit as an INFO OTLP log (AC-064d.2). */
export interface InstallHealthRecord {
	readonly kind: "install-health";
	/** The device_id (PRD-033 UUID) for correlation. */
	readonly deviceId: string;
	/** Timestamp in ms. */
	readonly timestampMs: number;
	/** Last-known daemon health from state.json. */
	readonly lastKnownHealth: HiveDoctorState["lastKnownHealth"];
	/** Age since last successful heal in SECONDS, or null if never healed. Bucketed below 63 chars. */
	readonly lastHealAgeSeconds: number | null;
	/** HiveDoctor package version. */
	readonly hivedoctorVersion: string;
	/** Daemon version last observed (may be "unknown"). */
	readonly daemonVersion: string;
}

/** A completed remediation episode to emit as an INFO/WARN OTLP log (AC-064d.3). */
export interface EpisodeRecord {
	readonly kind: "episode";
	/** The source incident object (from incidents.ndjson). */
	readonly incident: Incident;
	/** The device_id (PRD-033 UUID) for correlation. */
	readonly deviceId: string;
	/** Timestamp in ms (use the incident closedAt). */
	readonly timestampMs: number;
	/** HiveDoctor package version. */
	readonly hivedoctorVersion: string;
	/** Daemon version last observed (may be "unknown"). */
	readonly daemonVersion: string;
}

/** One of the three telemetry record types. */
export type TelemetryRecord = ErrorRecord | InstallHealthRecord | EpisodeRecord;

// ────────────────────────────────────────────────────────────────────────────
// Injectable seams
// ────────────────────────────────────────────────────────────────────────────

/** The minimal fetch response shape the chokepoint reads. */
export interface TelemetryFetchResponse {
	readonly ok: boolean;
	readonly status: number;
}

/** The minimal request init the chokepoint passes. */
export interface TelemetryFetchInit {
	readonly method: string;
	readonly headers: Record<string, string>;
	readonly body: string;
	readonly signal?: AbortSignal;
}

/** The injectable fetch seam. Tests pass a recorder; production uses globalThis.fetch. */
export type TelemetryFetch = (url: string, init: TelemetryFetchInit) => Promise<TelemetryFetchResponse>;

/** The injectable deps for `emitTelemetry` (all optional; defaults to production seams). */
export interface EmitDeps {
	/** Network seam. Defaults to the global `fetch` (Node 22 built-in). */
	readonly fetch?: TelemetryFetch;
	/** The env the opt-out gate reads. Defaults to `process.env`. */
	readonly env?: NodeJS.ProcessEnv;
	/** Override the build-injected PostHog key (tests inject a fake non-secret value). */
	readonly posthogKey?: string;
	/** Override the PostHog host (tests use a fake URL so no real network is hit). */
	readonly posthogHost?: string;
	/** Override the HiveDoctor version in the resource attributes. */
	readonly hivedoctorVersion?: string;
	/** POST timeout in ms. Defaults to 2000 (2s). */
	readonly timeoutMs?: number;
	/** Optional logger for the "swallowed" path (logs the drop, never throws). */
	readonly logger?: Logger;
	/** Clock for the POST timestamp (defaults to `Date.now`). */
	readonly now?: () => number;
	/**
	 * The state.json telemetry-disabled flag. When true the gate opts out.
	 * Passed separately (not the full state) so 064d stays independent of the
	 * supervisor loop's state hydration cycle.
	 */
	readonly stateTelemetryDisabled?: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Outcome type (for tests + glass-box; never thrown)
// ────────────────────────────────────────────────────────────────────────────

/** Why an emit was suppressed. */
export type EmitSkipReason =
	| "disabled" // empty key (no build injection)
	| "opted_out" // DO_NOT_TRACK=1 or HONEYCOMB_TELEMETRY=0 or state toggle
	| "send_failed"; // network/sink error, swallowed

/** The outcome of `emitTelemetry` (resolved, never rejected). */
export interface EmitOutcome {
	/** True iff the POST returned 2xx. */
	readonly sent: boolean;
	/** Present when `sent` is false. */
	readonly skipped?: EmitSkipReason;
}

// ────────────────────────────────────────────────────────────────────────────
// The default POST timeout
// ────────────────────────────────────────────────────────────────────────────

/** The bounded POST timeout -- telemetry never hangs the healing loop longer than this. */
export const DEFAULT_EMIT_TIMEOUT_MS = 2_000 as const;

// ────────────────────────────────────────────────────────────────────────────
// Resource attributes shared by all three streams
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build the OTLP resource attributes shared by every record in one POST. These
 * go in `resourceLogs[0].resource.attributes` so PostHog can group by
 * service/device without repeating them in every log line. Only allowed keys are
 * emitted (buildAllowedAttributes enforces the positive allow-list).
 */
function buildResourceAttributes(input: {
	readonly deviceId: string;
	readonly hivedoctorVersion: string;
	readonly daemonVersion?: string;
}): Record<AllowedAttributeKey, string> {
	const facts = platformFacts();
	return buildAllowedAttributes({
		"service.name": SCOPE_NAME,
		device_id: input.deviceId,
		hivedoctor_version: input.hivedoctorVersion,
		daemon_version: input.daemonVersion ?? "unknown",
		os: facts.os,
		arch: facts.arch,
	});
}

// ────────────────────────────────────────────────────────────────────────────
// Per-stream log-record builders
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build one OTLP log record for the error stream (AC-064d.1, severity ERROR).
 * The body is the error class; the per-record attributes carry the stream id and
 * the optional scrubbed detail. Credential contents never appear: the only field
 * that carries a free-form string is `error_detail`, which the caller must supply
 * already scrubbed (no stack traces, no paths, no tokens).
 */
function buildErrorLogRecord(rec: ErrorRecord) {
	const attrs: Readonly<Record<string, unknown>> = {
		stream: "error",
		error_class: rec.errorClass,
		...(rec.errorDetail !== undefined ? { error_detail: rec.errorDetail } : {}),
	};
	return buildLogRecord({
		timestampMs: rec.timestampMs,
		severityNumber: SEVERITY_ERROR,
		severityText: "ERROR",
		body: rec.errorClass,
		attributes: buildAllowedAttributes(attrs),
	});
}

/**
 * Build one OTLP log record for the install-health stream (AC-064d.2, severity INFO).
 * Carries daemon+HD versions, OS, health state, and a bucketed last-heal age so we
 * can spot boxes that never healed without leaking an exact timestamp.
 */
function buildInstallHealthLogRecord(rec: InstallHealthRecord) {
	// Buck the lastHealAgeSeconds so the exact interval is not sent (only a coarse bucket).
	const lastHealAgeBucket = bucketHealAge(rec.lastHealAgeSeconds);

	const attrs: Readonly<Record<string, unknown>> = {
		stream: "install-health",
		health: rec.lastKnownHealth,
		last_heal_age_s: lastHealAgeBucket,
		daemon_version: rec.daemonVersion,
	};
	return buildLogRecord({
		timestampMs: rec.timestampMs,
		severityNumber: SEVERITY_INFO,
		severityText: "INFO",
		body: `install-health: ${rec.lastKnownHealth}`,
		attributes: buildAllowedAttributes(attrs),
	});
}

/**
 * Bucket a heal age in seconds into a coarse label so the exact interval is not
 * sent (avoids fingerprinting the install cadence).
 * null       -> "never"
 * 0..300     -> "lt5m"
 * 301..3600  -> "lt1h"
 * 3601..86400 -> "lt1d"
 * >86400     -> "gt1d"
 */
function bucketHealAge(seconds: number | null): string {
	if (seconds === null) return "never";
	if (seconds <= 300) return "lt5m";
	if (seconds <= 3_600) return "lt1h";
	if (seconds <= 86_400) return "lt1d";
	return "gt1d";
}

/**
 * Build one OTLP log record for the episode stream (AC-064d.3). The severity is
 * WARN when the episode was NOT resolved (daemon still unhealthy), INFO when it was.
 * The per-record attributes carry the ordered step outcomes as a comma-separated
 * fact list ("rung:outcome") -- no credential contents, no paths, just the structural
 * outcome of each step so we can see how far the ladder got.
 */
function buildEpisodeLogRecord(rec: EpisodeRecord) {
	const { incident } = rec;
	const resolved = incident.resolved;
	const severityNumber = resolved ? SEVERITY_INFO : SEVERITY_WARN;
	const severityText: SeverityText = resolved ? "INFO" : "WARN";

	// "rung:outcome" pairs for each step -- no content beyond the structural outcome.
	const stepOutcomes = incident.steps.map((s) => `${s.rung}:${s.outcome}`).join(",");

	const attrs: Readonly<Record<string, unknown>> = {
		stream: "episode",
		trigger: incident.trigger,
		resolved: String(resolved),
		step_count: String(incident.steps.length),
		step_outcomes: stepOutcomes,
		health: incident.healthKind,
		daemon_version: rec.daemonVersion,
	};
	return buildLogRecord({
		timestampMs: rec.timestampMs,
		severityNumber,
		severityText,
		body: `episode: trigger=${incident.trigger} resolved=${String(resolved)}`,
		attributes: buildAllowedAttributes(attrs),
	});
}

// ────────────────────────────────────────────────────────────────────────────
// The POST helper
// ────────────────────────────────────────────────────────────────────────────

/**
 * Issue one bounded POST to the OTLP Logs endpoint. Returns true on 2xx, false
 * on any error (timeout / network / non-2xx). NEVER throws (swallows all errors).
 * This is the ONLY function in this module that touches the network.
 */
async function postOtlpLogs(body: string, key: string, url: string, deps: EmitDeps): Promise<boolean> {
	const doFetch = deps.fetch ?? (globalThis.fetch as unknown as TelemetryFetch);
	const timeoutMs = deps.timeoutMs ?? DEFAULT_EMIT_TIMEOUT_MS;

	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, timeoutMs);

	try {
		const resp = await doFetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${key}`,
			},
			body,
			signal: controller.signal,
		});
		return resp.ok;
	} catch {
		// Network error, timeout, or abort -- a dropped telemetry record is acceptable;
		// a hung healing loop is not. Return false so the caller can log the skip.
		return false;
	} finally {
		clearTimeout(timer);
	}
}

// ────────────────────────────────────────────────────────────────────────────
// The chokepoint
// ────────────────────────────────────────────────────────────────────────────

/**
 * THE SINGLE TELEMETRY EGRESS CHOKEPOINT (PRD-064d AC-064d.1 .. AC-064d.7).
 *
 * All three telemetry streams (error, install-health, episode) flow through this
 * one function. Apply the gates in order, build the OTLP envelope, POST, and
 * return a structured outcome. NEVER throws and NEVER blocks the healing loop.
 *
 * @param record  One of the three typed stream records.
 * @param deps    Injectable seams for testing. All have production defaults.
 */
export async function emitTelemetry(record: TelemetryRecord, deps: EmitDeps = {}): Promise<EmitOutcome> {
	const env = deps.env ?? process.env;

	// Resolve the effective PostHog key: test override > build injection > env fallback.
	const key = deps.posthogKey ?? POSTHOG_KEY;

	// Gate 1: empty key (un-keyed dev build or no env fallback) -> hard-disabled.
	if (key.length === 0) return { sent: false, skipped: "disabled" };

	// Gate 2: env opt-out (DO_NOT_TRACK=1 or HONEYCOMB_TELEMETRY=0) -> opted out.
	if (isOptedOut(env)) return { sent: false, skipped: "opted_out" };

	// Gate 3: state.json telemetry toggle (OD-5, finer dashboard toggle).
	if (deps.stateTelemetryDisabled === true) return { sent: false, skipped: "opted_out" };

	// All gates passed. Build the OTLP envelope.
	const hivedoctorVersion = deps.hivedoctorVersion ?? "0.0.0-dev";
	const host = deps.posthogHost ?? POSTHOG_HOST;
	const url = otlpLogsUrl(host);

	try {
		// Build per-stream resource attributes (shared across all records in the POST).
		const resourceAttributes = buildResourceAttributes({
			deviceId: record.kind === "error" ? record.deviceId : record.deviceId,
			hivedoctorVersion,
			daemonVersion:
				record.kind === "install-health"
					? record.daemonVersion
					: record.kind === "episode"
						? record.daemonVersion
						: undefined,
		});

		// Build the per-stream log record.
		const logRecord =
			record.kind === "error"
				? buildErrorLogRecord(record)
				: record.kind === "install-health"
					? buildInstallHealthLogRecord(record)
					: buildEpisodeLogRecord(record);

		// Assemble the OTLP LogsData envelope.
		const logsData = buildLogsData({
			resourceAttributes,
			scopeName: SCOPE_NAME,
			scopeVersion: hivedoctorVersion,
			logRecords: [logRecord],
		});

		const body = serializeLogsData(logsData);

		// Fire-and-forget POST (fail-soft, AC-064d.6).
		const ok = await postOtlpLogs(body, key, url, deps);
		if (!ok) {
			deps.logger?.warn("telemetry.send_failed", { stream: record.kind });
			return { sent: false, skipped: "send_failed" };
		}

		return { sent: true };
	} catch (err) {
		// Unexpected error in envelope construction or serialization -- swallow and log.
		// The healing loop must never be affected by a telemetry bookkeeping failure.
		deps.logger?.warn("telemetry.unexpected_error", {
			reason: err instanceof Error ? err.message : "unknown",
			stream: record.kind,
		});
		return { sent: false, skipped: "send_failed" };
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Convenience typed helpers (each delegates to emitTelemetry)
// ────────────────────────────────────────────────────────────────────────────

/** Emit an error event (AC-064d.1). */
export async function emitError(
	input: Omit<ErrorRecord, "kind">,
	deps?: EmitDeps,
): Promise<EmitOutcome> {
	return emitTelemetry({ kind: "error", ...input }, deps);
}

/** Emit an install-health snapshot (AC-064d.2). */
export async function emitInstallHealth(
	input: Omit<InstallHealthRecord, "kind">,
	deps?: EmitDeps,
): Promise<EmitOutcome> {
	return emitTelemetry({ kind: "install-health", ...input }, deps);
}

/** Emit a completed remediation episode (AC-064d.3). */
export async function emitEpisode(
	input: Omit<EpisodeRecord, "kind">,
	deps?: EmitDeps,
): Promise<EmitOutcome> {
	return emitTelemetry({ kind: "episode", ...input }, deps);
}

// Re-export the OTLP constants tests and callers need.
export { toAttributes, SEVERITY_ERROR, SEVERITY_INFO, SEVERITY_WARN };

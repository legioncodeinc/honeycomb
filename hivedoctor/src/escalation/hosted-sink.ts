/**
 * HiveDoctor hosted escalation sink (PRD-064g AC-064g.3).
 *
 * When the ladder exhausts and an escalation fires, this module emits a high-severity
 * OTLP log record to PostHog via the 064d telemetry chokepoint so we are notified
 * remotely even when the user never opens the local dashboard.
 *
 * Design decisions:
 *   - Reuses `emitTelemetry` from src/telemetry/emit.ts (the 064d chokepoint).
 *     An escalation is an "episode" with `resolved: false` and a step that records the
 *     recommended action. We do NOT invent a new OTLP stream; instead we synthesize a
 *     minimal Incident that carries the escalation facts so PostHog can alert on it.
 *   - `device_id` correlation: passed through so a broken-auth install can be correlated
 *     without relying on org id.
 *   - Fail-soft: the emit is fire-and-forget. A network failure or key absence is logged
 *     at warn level but never throws. The escalation reaching PostHog is best-effort.
 *   - No new runtime deps: delegates entirely to the existing chokepoint + node:crypto.
 *
 * The caller (the escalation hook wired by the supervisor) passes the EscalationRecord
 * and any context it knows (device_id, versions). emitEscalationToHostedSink resolves
 * to a boolean (true = 2xx received) and never rejects.
 */

import { randomUUID } from "node:crypto";

import type { Incident } from "../incidents.js";
import type { Logger } from "../logger.js";
import { emitEpisode, type EmitDeps } from "../telemetry/emit.js";
import type { EscalationRecord } from "../rungs/escalation.js";

// ── Options ───────────────────────────────────────────────────────────────────

/** Inputs for {@link emitEscalationToHostedSink}. */
export interface HostedSinkOptions {
	/** The escalation record to emit. */
	readonly escalation: EscalationRecord;
	/** The stable per-install UUID (PRD-033) for device_id correlation. */
	readonly deviceId: string;
	/** HiveDoctor package version. */
	readonly hivedoctorVersion: string;
	/** Daemon version last observed (or "unknown"). */
	readonly daemonVersion: string;
	/** Current wall-clock ms (injected for tests). Defaults to Date.now(). */
	readonly timestampMs?: number;
	/** Logger for the swallowed-failure path. */
	readonly logger?: Logger;
	/** Injectable emit deps (tests override posthogKey + fetch). */
	readonly emitDeps?: EmitDeps;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Synthesize a minimal {@link Incident} from an {@link EscalationRecord} so we can
 * route the escalation through the existing episode stream. The incident captures:
 *   - trigger: "unknown" (the calling supervisor knows the real trigger but it is not
 *     threaded into the escalation record shape; this is an acceptable approximation)
 *   - healthKind: "unreachable-refused" (the most common escalation trigger)
 *   - steps: the escalation steps from the record
 *   - resolved: false (an escalation by definition means unresolved)
 */
function synthesizeIncident(escalation: EscalationRecord, nowMs: number): Incident {
	return {
		id: randomUUID(),
		openedAt: escalation.at,
		trigger: "unknown",
		healthKind: "unreachable-refused",
		steps: escalation.steps,
		resolved: false,
		closedAt: new Date(nowMs).toISOString(),
	};
}

/**
 * Emit the escalation to the PostHog hosted sink via the 064d telemetry chokepoint.
 * Resolves to true on 2xx, false on any failure. Never rejects.
 *
 * AC-064g.3: credentialed -> hosted sink receives the report with device_id.
 */
export async function emitEscalationToHostedSink(options: HostedSinkOptions): Promise<boolean> {
	const timestampMs = options.timestampMs ?? Date.now();

	try {
		const incident = synthesizeIncident(options.escalation, timestampMs);

		const outcome = await emitEpisode(
			{
				incident,
				deviceId: options.deviceId,
				timestampMs,
				hivedoctorVersion: options.hivedoctorVersion,
				daemonVersion: options.daemonVersion,
			},
			options.emitDeps,
		);

		if (!outcome.sent) {
			options.logger?.warn("hosted-sink.escalation_not_sent", {
				reason: outcome.skipped ?? "unknown",
			});
		}

		return outcome.sent;
	} catch (error) {
		// Belt-and-suspenders: emitEpisode should never throw, but wrap anyway.
		options.logger?.warn("hosted-sink.escalation_emit_threw", {
			reason: error instanceof Error ? error.message : "unknown",
		});
		return false;
	}
}

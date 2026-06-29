/**
 * Rung 4: escalation handoff (PRD-064c, AC-064c.3 / AC-064c.6).
 *
 * When the ladder cannot restore health - or when the action HiveDoctor believes is
 * needed is the DEFERRED credential purge - it stops climbing and ESCALATES. The
 * escalation surface itself (dashboard "needs attention" + telemetry) is 064g; this
 * module owns only the structured {@link EscalationRecord} and the injected
 * {@link EscalationHook} that hands it off, so 064g can plug in a real sink later.
 *
 * The binding constraint (OD-4 + AC-064c.3): clearing credentials is DEFERRED and NOT
 * BUILT. There is no credential-purge code path anywhere in HiveDoctor. On a suspected
 * credential fault the ladder escalates with `recommendedAction: "clear-credentials"`
 * and `wouldHaveTaken` describing the action it deliberately did NOT take - so we learn
 * what HiveDoctor wanted to do without it ever touching `~/.deeplake/credentials.json`.
 *
 * Crash-safety (design principle 1): {@link runEscalation} wraps the hook in try/catch.
 * A hook that throws (a flaky sink) becomes a failed {@link RungResult}, never a thrown
 * error - escalation is the LAST thing the ladder does, and it must not be the thing
 * that finally crashes the can't-crash watchdog. Built-ins only; no I/O of its own (the
 * record goes to the injected hook and the incident).
 */

import type { IncidentStep } from "../incidents.js";
import type { RungResult } from "../remediation.js";
import type { Logger } from "../logger.js";

/**
 * The action HiveDoctor recommends a human (or 064g) take, INCLUDING the deferred one
 * it is not allowed to perform itself. `clear-credentials` is the deferred action: it
 * is only ever RECOMMENDED here, never executed (AC-064c.3).
 */
export type RecommendedAction =
	| "investigate"
	| "reinstall-primary"
	| "uninstall-conflicting-hivemind"
	| "clear-credentials"
	| "manual-intervention";

/**
 * A structured, secret-free escalation record handed to 064g. It is a snapshot of the
 * episode: why we are escalating, what was tried and how it went, and what we
 * recommend - including the action we WOULD have taken but deliberately did not.
 */
export interface EscalationRecord {
	/** Plain-language diagnosis of why the ladder could not heal the box. */
	readonly diagnosis: string;
	/** The ordered remediation steps attempted this episode, with their outcomes. */
	readonly steps: readonly IncidentStep[];
	/** The action HiveDoctor recommends next (may be the deferred credential purge). */
	readonly recommendedAction: RecommendedAction;
	/**
	 * When `recommendedAction` is a DEFERRED action HiveDoctor did not perform, a
	 * plain-language note of exactly what it would have done (e.g. "would clear
	 * ~/.deeplake/credentials.json"). Absent when the recommended action is not deferred.
	 */
	readonly wouldHaveTaken?: string;
	/** ISO-8601 of when the escalation record was produced. */
	readonly at: string;
}

/**
 * The injected escalation sink. 064g plugs in the real dashboard/telemetry handoff;
 * tests inject a spy. It may be async (a network post) and MAY throw - the caller
 * isolates it. Returns nothing meaningful; delivery is best-effort.
 */
export type EscalationHook = (record: EscalationRecord) => void | Promise<void>;

/** Inputs to {@link buildEscalationRecord}. */
export interface BuildEscalationInput {
	/** Plain-language diagnosis. */
	readonly diagnosis: string;
	/** The ordered steps attempted this episode. */
	readonly steps: readonly IncidentStep[];
	/** The recommended next action. */
	readonly recommendedAction: RecommendedAction;
	/** Injected clock for `at` (defaults to `Date.now`). */
	readonly now?: () => number;
}

/**
 * The deferred actions HiveDoctor is allowed to RECOMMEND but never PERFORM. Centralized
 * so the "would have taken" note and the never-execute guarantee share one source of
 * truth. Today only the credential purge is deferred (OD-4).
 */
const DEFERRED_ACTION_NOTES: Readonly<Partial<Record<RecommendedAction, string>>> = {
	"clear-credentials": "would clear ~/.deeplake/credentials.json (DEFERRED - not performed in v1)",
};

/**
 * Build a structured escalation record. When the recommended action is a deferred one,
 * `wouldHaveTaken` is populated from {@link DEFERRED_ACTION_NOTES} so the record always
 * states the action HiveDoctor declined to take. Pure: no I/O, no throw.
 */
export function buildEscalationRecord(input: BuildEscalationInput): EscalationRecord {
	const now = input.now ?? Date.now;
	const wouldHaveTaken = DEFERRED_ACTION_NOTES[input.recommendedAction];
	return {
		diagnosis: input.diagnosis,
		steps: [...input.steps],
		recommendedAction: input.recommendedAction,
		...(wouldHaveTaken !== undefined ? { wouldHaveTaken } : {}),
		at: new Date(now()).toISOString(),
	};
}

/** Stable action verb recorded in the incident step for the escalation. */
const ACTION = "escalate";

/**
 * Hand an escalation record to the injected hook, crash-safely. The hook is isolated in
 * try/catch: a thrown / rejected hook becomes a failed {@link RungResult} (so the
 * incident records the escalation failed to deliver), never a thrown error. A successful
 * hand-off is a succeeded result. This is invoked by the supervisor when the ladder
 * gives up; it does NOT register as a numbered ladder rung (the ladder's numbered rungs
 * are the repair actions; escalation is the terminal hand-off).
 */
export async function runEscalation(
	record: EscalationRecord,
	hook: EscalationHook,
	logger: Logger,
): Promise<RungResult> {
	try {
		await hook(record);
		logger.warn("rung4.escalated", {
			recommendedAction: record.recommendedAction,
			deferred: record.wouldHaveTaken !== undefined,
		});
		return { ok: true, action: ACTION, detail: record.recommendedAction };
	} catch (error) {
		// Even the escalation hook must not crash the watchdog: a flaky sink is a failed
		// delivery, not a process death. The incident still records the attempt.
		const detail = error instanceof Error ? error.message : "unknown";
		logger.error("rung4.escalation_hook_threw", { reason: detail });
		return { ok: false, action: ACTION, detail };
	}
}

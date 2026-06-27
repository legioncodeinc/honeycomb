/**
 * HiveDoctor incident-episode model + append-only, size-capped `incidents.ndjson`
 * writer (PRD-064 data-model section; PRD-064a scope).
 *
 * An incident is one remediation EPISODE: the daemon went unhealthy, HiveDoctor ran
 * an ordered set of remediation steps, and each step had an outcome. This is the
 * source the dashboard escalation report (064g) and the OTLP troubleshooting spans
 * (064d) will consume, so the shape is exported here and frozen as the contract
 * those later waves import.
 *
 * The record is written defensively (design principle 1, "incapable of crashing"):
 * a failed append is swallowed and reported via the injected logger, never thrown.
 * Losing an incident line is strictly better than crashing the watchdog that is
 * trying to heal the box. The file is append-only and size-capped: when it exceeds
 * the cap it is rotated to `incidents.ndjson.1` (single generation) so it can never
 * grow unbounded on a box that flaps for days.
 *
 * Built-ins only: node:fs + node:path + node:crypto (for the episode id).
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";

import type { HealthClassification, ProbeHealthReasons } from "./health-probe.js";
import type { Logger } from "./logger.js";
import { resolveInBase } from "./safe-path.js";

/** The trigger that opened an incident (why the loop decided to remediate). */
export type IncidentTrigger = "unreachable" | "timeout" | "degraded" | "unknown";

/** The outcome of a single remediation step. */
export type StepOutcome = "succeeded" | "failed" | "skipped";

/**
 * One ordered remediation step within an episode. `rung` names which ladder rung ran
 * (1 = restart in Wave 0; rungs 2+ are later-wave slots). `action` is a short stable
 * verb, `outcome` the result, `detail` an optional secret-free note (e.g. an error
 * message class). Steps are stored in the order they were attempted.
 */
export interface IncidentStep {
	/** The ladder rung this step belongs to (1-based). */
	readonly rung: number;
	/** A short stable action verb, e.g. `restart-daemon`, `advance-rung`. */
	readonly action: string;
	/** What happened. */
	readonly outcome: StepOutcome;
	/** Optional secret-free detail (error message class, count, etc.). */
	readonly detail?: string;
	/** When the step completed, ISO-8601. */
	readonly at: string;
}

/** A full remediation episode, one NDJSON line in `incidents.ndjson`. */
export interface Incident {
	/** Stable episode id (UUID). */
	readonly id: string;
	/** When the episode opened, ISO-8601. */
	readonly openedAt: string;
	/** What triggered remediation. */
	readonly trigger: IncidentTrigger;
	/** The `/health` classification kind that opened the episode (secret-free). */
	readonly healthKind: HealthClassification["kind"];
	/** The per-subsystem reasons at trigger time, when the daemon answered with detail (degraded only). */
	readonly healthReasons?: ProbeHealthReasons;
	/** Ordered steps attempted, in attempt order. */
	readonly steps: readonly IncidentStep[];
	/** Whether the episode ended with the daemon healthy again. */
	readonly resolved: boolean;
	/** When the episode closed, ISO-8601 (set when the record is written). */
	readonly closedAt: string;
}

/** Options for {@link createIncidentLog}. */
export interface IncidentLogOptions {
	/** HiveDoctor's workspace dir; `incidents.ndjson` is written under it. */
	readonly workspaceDir: string;
	/** Logger for defensive reporting of a failed write (never thrown). */
	readonly logger: Logger;
	/** Max file size in bytes before rotation (default 5 MiB). */
	readonly maxBytes?: number;
	/** Injected clock for `closedAt` (defaults to `Date.now`), for deterministic tests. */
	readonly now?: () => number;
}

/** The default incident-file size cap before a single-generation rotation. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** A mutable episode builder so the supervisor can record steps as the ladder runs. */
export interface IncidentBuilder {
	/** Append one attempted step (in attempt order). */
	addStep(step: Omit<IncidentStep, "at">): void;
	/** Mark the episode resolved (the daemon returned to healthy). */
	markResolved(): void;
	/** Snapshot the episode as an immutable {@link Incident} (sets `closedAt`). */
	build(): Incident;
}

/** The incident log: opens episode builders and writes finished episodes. */
export interface IncidentLog {
	/** Open a new episode for a given trigger + health snapshot. */
	open(trigger: IncidentTrigger, classification: HealthClassification): IncidentBuilder;
	/** Append a finished episode to `incidents.ndjson` (defensive; never throws). */
	write(incident: Incident): void;
}

/**
 * Map a {@link HealthClassification} to the {@link IncidentTrigger} that opens an
 * episode. Centralized so the supervisor and any later wave agree on the mapping.
 */
export function triggerForClassification(kind: HealthClassification["kind"]): IncidentTrigger {
	switch (kind) {
		case "unreachable-refused":
			return "unreachable";
		case "unreachable-timeout":
			return "timeout";
		case "degraded":
			return "degraded";
		case "ok":
			// `ok` never opens an episode, but the mapping is total for safety.
			return "unknown";
		default:
			return "unknown";
	}
}

/**
 * Build an incident log bound to a workspace dir. The directory is created lazily on
 * first write (mirrors the daemon's `canWriteDir` discipline: a missing dir is
 * created, an unwritable dir results in a swallowed-and-logged failure, never a
 * crash).
 */
export function createIncidentLog(options: IncidentLogOptions): IncidentLog {
	const now = options.now ?? Date.now;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	/** Rotate when the existing file is at/over the cap. Defensive; failure is non-fatal. */
	function rotateIfNeeded(filePath: string, rotatedPath: string): void {
		try {
			const size = statSync(filePath).size;
			if (size >= maxBytes) renameSync(filePath, rotatedPath);
		} catch {
			// statSync throws ENOENT when the file does not exist yet (the common first-write
			// case), which is expected and means "nothing to rotate". A rename failure is also
			// non-fatal: at worst the file grows slightly past the cap, never a crash.
		}
	}

	return {
		open(trigger: IncidentTrigger, classification: HealthClassification): IncidentBuilder {
			const steps: IncidentStep[] = [];
			let resolved = false;
			const reasons = classification.kind === "degraded" ? classification.reasons : undefined;
			const openedAt = new Date(now()).toISOString();
			const id = randomUUID();

			return {
				addStep(step: Omit<IncidentStep, "at">): void {
					steps.push({ ...step, at: new Date(now()).toISOString() });
				},
				markResolved(): void {
					resolved = true;
				},
				build(): Incident {
					return {
						id,
						openedAt,
						trigger,
						healthKind: classification.kind,
						healthReasons: reasons,
						steps: [...steps],
						resolved,
						closedAt: new Date(now()).toISOString(),
					};
				},
			};
		},

		write(incident: Incident): void {
			try {
				// Containment: both fixed names are joined under the variable workspace dir and
				// asserted to stay inside it (defense-in-depth + SAST taint visibility). A
				// containment violation throws and is caught below, degrading like a write failure.
				const filePath = resolveInBase(options.workspaceDir, "incidents.ndjson");
				const rotatedPath = resolveInBase(options.workspaceDir, "incidents.ndjson.1");
				mkdirSync(options.workspaceDir, { recursive: true });
				rotateIfNeeded(filePath, rotatedPath);
				appendFileSync(filePath, `${JSON.stringify(incident)}\n`, "utf8");
			} catch (error) {
				// Defensive (design principle 1): a read-only/missing/full disk must NOT crash the
				// watchdog. Report the loss via the logger and continue. The healing the incident
				// records matters more than the record of it.
				options.logger.error("incident.write_failed", {
					reason: error instanceof Error ? error.message : "unknown",
					incidentId: incident.id,
				});
			}
		},
	};
}

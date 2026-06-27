/**
 * HiveDoctor needs-attention store (PRD-064g).
 *
 * Persists the latest structured escalation record so the dashboard can surface
 * a "needs attention" banner on recovery. Two outputs per escalation:
 *
 *   1. `needs-attention.json` (atomic write) -- the current escalation + resolution
 *      state; this is the DASHBOARD READ SEAM. The daemon reads this file; HiveDoctor
 *      writes it. The dependency is strictly one-directional.
 *
 *      File shape (NeedsAttentionFile, documented below):
 *        { version: 1, escalation: EscalationRecord, resolved: boolean, recordedAt, resolvedAt? }
 *
 *      File path: `<workspaceDir>/needs-attention.json`
 *
 *   2. `incidents.ndjson` -- the existing append-only log receives the escalation as
 *      an IncidentStep so the record is durable across rotations.
 *
 * Both writes are defensive (design principle 1, "incapable of crashing"): any I/O
 * failure is swallowed and reported via the injected logger, never thrown.
 *
 * resolve() marks the current needs-attention record resolved (AC-064g.5) so the
 * dashboard banner clears on the next read.
 *
 * Built-ins only: node:fs + node:path + node:crypto (for the atomic temp suffix).
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import type { IncidentLog } from "../incidents.js";
import type { Logger } from "../logger.js";
import { resolveInBase } from "../safe-path.js";
import type { EscalationRecord } from "../rungs/escalation.js";

// ── Dashboard read-seam file shape ───────────────────────────────────────────

/**
 * The shape of `needs-attention.json` -- the file the dashboard reads.
 *
 * File path: `<workspaceDir>/needs-attention.json`
 * Schema version: 1
 *
 * The dashboard (and any other reader) MUST treat unknown fields as forward-compat
 * additions and MUST check `version` before assuming the shape. A missing file means
 * "no escalation has occurred" and is NOT an error.
 *
 * `resolved: false`  -- the ladder has exhausted; user attention required.
 * `resolved: true`   -- a subsequent heal cycle restored health; banner may clear.
 * `resolvedAt`       -- ISO-8601 of when resolve() was called; absent when unresolved.
 */
export interface NeedsAttentionFile {
	/** Schema version. Always 1 for this wave. */
	readonly version: 1;
	/** The escalation record produced by the ladder. */
	readonly escalation: EscalationRecord;
	/** False when the escalation is active; true once a subsequent heal resolves it. */
	readonly resolved: boolean;
	/** ISO-8601 of when the escalation was recorded. */
	readonly recordedAt: string;
	/** ISO-8601 of when resolved() was called. Absent when unresolved. */
	readonly resolvedAt?: string;
}

// ── Options + interface ───────────────────────────────────────────────────────

/** Options for {@link createNeedsAttentionStore}. */
export interface NeedsAttentionStoreOptions {
	/** HiveDoctor's workspace dir; `needs-attention.json` is written under it. */
	readonly workspaceDir: string;
	/** The existing incident log; the escalation is also appended there. */
	readonly incidentLog: IncidentLog;
	/** Logger for defensive reporting of I/O failures (never thrown). */
	readonly logger: Logger;
	/** Injected clock for `recordedAt`/`resolvedAt` (defaults to `Date.now`). */
	readonly now?: () => number;
}

/**
 * The needs-attention store: records an escalation to disk + incident log, and
 * marks it resolved when a subsequent heal cycle recovers the daemon.
 */
export interface NeedsAttentionStore {
	/**
	 * Persist an escalation record:
	 *   - writes `needs-attention.json` (atomic, dashboard read seam)
	 *   - appends an escalation step to `incidents.ndjson` via the incident log
	 *
	 * AC-064g.1: called by the escalation hook when the ladder exhausts.
	 * Defensive: never throws.
	 */
	record(escalation: EscalationRecord): void;

	/**
	 * Mark the current needs-attention record resolved (AC-064g.5).
	 * Updates `needs-attention.json` with `resolved: true` + `resolvedAt`.
	 * A no-op (with a logged debug) when no record exists.
	 * Defensive: never throws.
	 */
	resolve(): void;

	/**
	 * Read the current persisted needs-attention file, or null when none exists.
	 * Defensive: returns null on any read/parse error; never throws.
	 */
	read(): NeedsAttentionFile | null;
}

// ── Implementation ────────────────────────────────────────────────────────────

/** The step action recorded in incidents.ndjson when an escalation fires. */
const ESCALATION_STEP_ACTION = "escalate-needs-attention" as const;

/** Atomic-write helper: serialize to a temp file then rename over the target. */
function atomicWrite(targetPath: string, content: string, workspaceDir: string, logger: Logger): void {
	const tmpPath = `${targetPath}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		mkdirSync(workspaceDir, { recursive: true });
		writeFileSync(tmpPath, `${content}\n`, "utf8");
		renameSync(tmpPath, targetPath);
	} catch (error) {
		// Best-effort cleanup of the temp file, then surface the write failure.
		try {
			rmSync(tmpPath, { force: true });
		} catch {
			// Temp cleanup is itself best-effort; a leftover .tmp file is harmless.
		}
		logger.error("needs-attention.write_failed", {
			reason: error instanceof Error ? error.message : "unknown",
		});
	}
}

/** Build the store. */
export function createNeedsAttentionStore(options: NeedsAttentionStoreOptions): NeedsAttentionStore {
	const now = options.now ?? Date.now;

	/**
	 * Resolve `needs-attention.json` under the variable workspace dir, asserting it stays
	 * inside (defense-in-depth + SAST taint visibility). Throws on a containment violation;
	 * callers catch / fail-soft so the watchdog never crashes.
	 */
	function storePath(): string {
		return resolveInBase(options.workspaceDir, "needs-attention.json");
	}

	return {
		record(escalation: EscalationRecord): void {
			const recordedAt = new Date(now()).toISOString();

			// (1) Write the dashboard read-seam file atomically.
			const file: NeedsAttentionFile = {
				version: 1,
				escalation,
				resolved: false,
				recordedAt,
			};
			let filePath: string;
			try {
				filePath = storePath();
			} catch (error) {
				// Containment violation: cannot safely write. Log + skip the file write (the
				// incident-log append below still records the escalation durably).
				options.logger.error("needs-attention.write_failed", {
					reason: error instanceof Error ? error.message : "unknown",
				});
				filePath = "";
			}
			if (filePath !== "") {
				atomicWrite(filePath, JSON.stringify(file, null, 2), options.workspaceDir, options.logger);
			}

			// (2) Also append an escalation step to incidents.ndjson so the record is
			// durable across needs-attention.json replacements.
			//
			// We do not hold an IncidentBuilder here (the escalation fires after the
			// ladder's episode is already built), so we open a synthetic incident-less
			// step: we open a minimal episode, add the step, and write it. This gives
			// the escalation a durable presence in the append-only log even if
			// needs-attention.json is later overwritten by a newer escalation.
			//
			// The trigger is "unknown" because the ladder's classification context is
			// not threaded into the store (it belongs to the calling supervisor); the
			// step carries the full escalation detail.
			try {
				const builder = options.incidentLog.open("unknown", { kind: "ok" });
				builder.addStep({
					rung: 4,
					action: ESCALATION_STEP_ACTION,
					outcome: "succeeded",
					detail: escalation.recommendedAction,
				});
				options.incidentLog.write(builder.build());
			} catch (error) {
				// Defensive: an incident-log write failure must not affect the file write.
				options.logger.error("needs-attention.incident_append_failed", {
					reason: error instanceof Error ? error.message : "unknown",
				});
			}
		},

		resolve(): void {
			// Read the current record; no-op if nothing was written.
			const current = this.read();
			if (current === null) {
				options.logger.debug("needs-attention.resolve_no_record", {});
				return;
			}
			if (current.resolved) {
				// Already resolved; no-op (idempotent).
				options.logger.debug("needs-attention.resolve_already_resolved", {});
				return;
			}

			const resolvedAt = new Date(now()).toISOString();
			const updated: NeedsAttentionFile = {
				...current,
				resolved: true,
				resolvedAt,
			};
			let filePath: string;
			try {
				filePath = storePath();
			} catch (error) {
				options.logger.error("needs-attention.write_failed", {
					reason: error instanceof Error ? error.message : "unknown",
				});
				return;
			}
			atomicWrite(filePath, JSON.stringify(updated, null, 2), options.workspaceDir, options.logger);
			options.logger.info("needs-attention.resolved", { resolvedAt });
		},

		read(): NeedsAttentionFile | null {
			try {
				// Containment first; a violation throws and is caught here (returns null, "no record").
				const filePath = storePath();
				const raw = readFileSync(filePath, "utf8");
				const parsed = JSON.parse(raw) as unknown;
				if (
					parsed !== null &&
					typeof parsed === "object" &&
					(parsed as Record<string, unknown>)["version"] === 1
				) {
					return parsed as NeedsAttentionFile;
				}
				return null;
			} catch {
				// Missing file (no escalation yet) or unparseable JSON: treat as "no record".
				return null;
			}
		},
	};
}

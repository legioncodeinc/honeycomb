/**
 * The one-time, idempotent, additive state-migration bootstrap (PRD-072a / US-072a.3).
 *
 * ADR-0003 relocates honeycomb's runtime state from `~/.honeycomb/` to `~/.apiary/honeycomb/`. On
 * the first boot of a build that ships the migration, this engine runs each registered per-family
 * mover exactly once, keyed by a `migration.json` marker in the new honeycomb state dir. The
 * contract (PRD-072 "Migration mechanics"):
 *
 *   - Trigger: first boot, BEFORE any state-family store initializes (the caller guarantees this).
 *   - Idempotence marker: a completed family entry skips that family forever; a FAILED entry is
 *     retried next boot (a transient copy error self-heals).
 *   - Per-family move: copy then atomically rename into place, then mark. NEVER delete a legacy file
 *     that did not successfully land at the new path (additive, never destructive).
 *   - Fail-soft: a migration error NEVER blocks daemon boot (AC-072a.3.3). The whole run is wrapped
 *     so even a marker read/write failure degrades to "retry next boot", not a crash.
 *
 * This module owns the LOOP + MARKER; the concrete movers (which files move where) live in
 * `families.ts` (PRD-072b) and are injected, so the engine is pure w.r.t. the family set and a test
 * drives it with fake movers.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The bookkeeping marker file inside `~/.apiary/honeycomb/` (runtime state, not durable app data). */
export const MIGRATION_MARKER_FILE = "migration.json" as const;

/** The outcome a single family mover reports. */
export type FamilyOutcome =
	/** The legacy file(s) were copied to the new path and the legacy copy removed. */
	| "migrated"
	/** Nothing to do: the new path already exists, or no legacy file was present. */
	| "skipped"
	/** The move was attempted and failed; the legacy file is untouched and this family retries. */
	| "failed";

/** A per-family mover. `run()` should be internally fail-soft, but the engine also guards it. */
export interface StateFamilyMover {
	/** A stable family key recorded in the marker (e.g. `"machine-key"`). */
	readonly family: string;
	/** Perform the move (or detect nothing-to-do). Returns the outcome. */
	run(): FamilyOutcome;
}

/** The status persisted per family in the marker. `skipped` collapses to `complete`. */
type MarkerStatus = "complete" | "failed";

interface MarkerEntry {
	readonly status: MarkerStatus;
	readonly at: string;
}

interface MarkerData {
	readonly families: Record<string, MarkerEntry>;
}

/** The narrow fs seam the engine reads/writes the marker through (a test injects an in-memory fake). */
export interface MigrationFs {
	readText(path: string): string;
	writeText(path: string, content: string): void;
	mkdirp(path: string): void;
}

/** The production {@link MigrationFs} over `node:fs`. */
export function nodeMigrationFs(): MigrationFs {
	return {
		readText(path: string): string {
			return readFileSync(path, "utf8");
		},
		writeText(path: string, content: string): void {
			writeFileSync(path, content, "utf8");
		},
		mkdirp(path: string): void {
			mkdirSync(path, { recursive: true });
		},
	};
}

/** Options for {@link runStateMigration}. */
export interface RunStateMigrationOptions {
	/** The new honeycomb state dir the marker lives in (`~/.apiary/honeycomb/`). */
	readonly stateDir: string;
	/** The registered per-family movers (from `families.ts`). */
	readonly movers: readonly StateFamilyMover[];
	/** The marker fs seam. Defaults to {@link nodeMigrationFs}. */
	readonly fs?: MigrationFs;
	/** The clock for marker timestamps. Defaults to the wall clock. */
	readonly now?: () => string;
	/** A one-line log sink (best-effort). Defaults to a no-op. */
	readonly onLog?: (message: string) => void;
}

/** The per-family result of a migration run (`already` = skipped because the marker was complete). */
export type RunFamilyResult = FamilyOutcome | "already";

/** The result of a migration run: the per-family outcomes this boot recorded. */
export interface MigrationReport {
	readonly outcomes: Record<string, RunFamilyResult>;
}

/** Read the marker (tolerant: missing / garbled → an empty family map). Never throws. */
function readMarker(markerPath: string, fs: MigrationFs): MarkerData {
	let raw: string;
	try {
		raw = fs.readText(markerPath);
	} catch {
		return { families: {} };
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return { families: {} };
		const families = (parsed as { families?: unknown }).families;
		if (families === null || typeof families !== "object") return { families: {} };
		return { families: families as Record<string, MarkerEntry> };
	} catch {
		return { families: {} };
	}
}

/**
 * Run the one-time state migration (AC-072a.3.1 / .3.2 / .3.3). For each mover: a marker `complete`
 * skips it (`already`); otherwise the mover runs (guarded — a thrown mover degrades to `failed`,
 * never a crash). `migrated`/`skipped` are recorded `complete`; `failed` stays retryable. The marker
 * is rewritten at the end (best-effort). The whole function is fail-soft: it always returns a report
 * and never throws into the daemon boot path.
 */
export function runStateMigration(options: RunStateMigrationOptions): MigrationReport {
	const fs = options.fs ?? nodeMigrationFs();
	const now = options.now ?? ((): string => new Date().toISOString());
	const onLog = options.onLog ?? ((): void => {});
	const markerPath = join(options.stateDir, MIGRATION_MARKER_FILE);
	const outcomes: Record<string, RunFamilyResult> = {};

	const marker = readMarker(markerPath, fs);
	const nextFamilies: Record<string, MarkerEntry> = { ...marker.families };
	let anyRan = false;

	for (const mover of options.movers) {
		const prior = marker.families[mover.family];
		if (prior?.status === "complete") {
			outcomes[mover.family] = "already";
			continue;
		}
		anyRan = true;
		let outcome: FamilyOutcome;
		try {
			outcome = mover.run();
		} catch (err) {
			outcome = "failed";
			onLog(
				`honeycomb: state migration for "${mover.family}" threw (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		outcomes[mover.family] = outcome;
		nextFamilies[mover.family] = {
			status: outcome === "failed" ? "failed" : "complete",
			at: now(),
		};
		if (outcome === "migrated") onLog(`honeycomb: migrated state family "${mover.family}" to the apiary root`);
	}

	// Persist the updated marker (best-effort — a marker write failure never blocks boot; the worst
	// case is an incomplete family is retried next boot, which is safe because every mover is
	// idempotent). Skipped entirely when every family was already complete, so the already-migrated
	// FAST PATH (every CLI verb + daemon boot after the one-time run) is a single marker read with
	// zero writes (PRD-072 mechanics step 1 as widened to CLI triggers).
	if (anyRan) {
		try {
			fs.mkdirp(options.stateDir);
			fs.writeText(markerPath, `${JSON.stringify({ families: nextFamilies }, null, 2)}\n`);
		} catch (err) {
			onLog(
				`honeycomb: could not persist the state-migration marker (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	return { outcomes };
}

/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * In-process tracker for MEMORIES actually committed by the controlled-write stage
 * since boot. Threaded from the composition root into the stage's `onOutcome` seam
 * (record on every committed write) and read by the `/health` detail so an operator
 * can answer "is this daemon forming memories?" at a glance.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * In local-queue mode the recurring storage `SELECT 1` probe is intentionally OFF
 * (PRD-066 idle-cost boundary), so `/health.storage` is a static `reachable` and can
 * no longer answer "are writes landing?". This counter is the honest, always-cheap
 * signal that fills that gap: it counts REAL commits observed in-process, needing no
 * DeepLake round-trip. A silent stall (extraction runs, decisions flow, but zero
 * memories commit — the exact failure this whole subsystem shipped blind to) becomes
 * a glanceable `committedSinceBoot: 0`.
 *
 * Fail-soft by construction: recording never throws and never blocks the write path.
 * The count is process-local (resets on restart) — deliberately, since the question
 * it answers is "is it working NOW?", not "what is the all-time total?" (that is the
 * `memories` table's job, queried on demand, never on the health hot path).
 */

/** The controlled-write outcome actions that COMMITTED (or matched) a durable memory. */
const COMMITTED_ACTIONS: ReadonlySet<string> = new Set(["inserted", "version_bumped", "deduped"]);

/** An observed controlled-write outcome (decoupled from the full `ControlledWriteOutcome`). */
export interface MemoryFormationOutcome {
	readonly action: string;
	readonly memoryId?: string;
}

/**
 * ISS-005: the stored last-extraction-error reason is CAPPED — a short diagnostic string for the
 * `/health` wire, never an unbounded log dump. The reasons recorded here come from the extraction
 * stage's swallowed model-call failures (`err.message` of a `ProviderError`/`RoutingExhaustedError`),
 * which are short, key-free status strings by construction (the transports never echo a body/key).
 */
const MAX_EXTRACTION_ERROR_CHARS = 200;

/** A point-in-time snapshot of memory-formation activity since boot. */
export interface MemoryFormationSnapshot {
	/** Memories committed (inserted / version-bumped / deduped) since daemon boot. */
	readonly committedSinceBoot: number;
	/** ISO timestamp of the most recent committed write; omitted until the first commit. */
	readonly lastCommittedAt?: string;
	/** The action of the most recent committed write; omitted until the first commit. */
	readonly lastAction?: string;
	/**
	 * ISS-005 (extraction failure visibility): `extraction.model_error` occurrences since boot —
	 * every model call the extraction stage SWALLOWED (returned empty, job completed "done").
	 * The honest counterpart to `committedSinceBoot`: 373 swallowed gateway failures used to be
	 * invisible ("jobs done, zero memories, health green"); now they read as a loud non-zero
	 * count beside a zero commit count. Optional on the TYPE (legacy literals/inputs omit it →
	 * normalized to 0 on the `/health` wire) but ALWAYS emitted by the tracker.
	 */
	readonly extractionErrorsSinceBoot?: number;
	/** The (capped, key-free) reason of the most recent extraction model error; omitted until the first. */
	readonly lastExtractionError?: string;
	/** ISO timestamp of the most recent extraction model error; omitted until the first. */
	readonly lastExtractionErrorAt?: string;
}

/** A monotonic committed-memories tracker (process-local, since daemon boot). */
export interface MemoryFormationTracker {
	/** Feed one controlled-write outcome; counts it only when it committed a memory. */
	record(outcome: MemoryFormationOutcome): void;
	/**
	 * ISS-005: count one swallowed extraction model failure (`extraction.model_error`). The stage's
	 * swallow-and-continue behavior is UNCHANGED (a model hiccup never fails the job) — this only
	 * makes the swallow visible on `/health`. Never throws; the reason is capped + stored verbatim.
	 */
	recordExtractionError(reason: string): void;
	/** The current committed-memories snapshot since boot. */
	snapshot(): MemoryFormationSnapshot;
}

/** Build a fresh in-memory memory-formation tracker. `now` is injectable for tests. */
export function createMemoryFormationTracker(now: () => number = Date.now): MemoryFormationTracker {
	let committed = 0;
	let lastCommittedAt: string | undefined;
	let lastAction: string | undefined;
	let extractionErrors = 0;
	let lastExtractionError: string | undefined;
	let lastExtractionErrorAt: string | undefined;
	return {
		record(outcome: MemoryFormationOutcome): void {
			// Only a committed action with a real memory id counts — a `skipped`/`flagged`
			// outcome, or a committed action that produced no id, formed no memory.
			if (!COMMITTED_ACTIONS.has(outcome.action)) return;
			if (outcome.memoryId === undefined || outcome.memoryId === "") return;
			committed += 1;
			lastAction = outcome.action;
			lastCommittedAt = new Date(now()).toISOString();
		},
		recordExtractionError(reason: string): void {
			extractionErrors += 1;
			lastExtractionError = reason.slice(0, MAX_EXTRACTION_ERROR_CHARS);
			lastExtractionErrorAt = new Date(now()).toISOString();
		},
		snapshot(): MemoryFormationSnapshot {
			return {
				committedSinceBoot: committed,
				...(lastCommittedAt !== undefined ? { lastCommittedAt } : {}),
				...(lastAction !== undefined ? { lastAction } : {}),
				extractionErrorsSinceBoot: extractionErrors,
				...(lastExtractionError !== undefined ? { lastExtractionError } : {}),
				...(lastExtractionErrorAt !== undefined ? { lastExtractionErrorAt } : {}),
			};
		},
	};
}

/** The minimal structured-log sink shape the wrapper below decorates (mirrors `ExtractionLogger`). */
export interface ExtractionEventSink {
	/** Record a structured event (e.g. `extraction.model_error`). */
	event(name: string, fields?: Record<string, unknown>): void;
}

/**
 * ISS-005: decorate an extraction-stage logger so every `extraction.model_error` event ALSO
 * increments the tracker's `extractionErrorsSinceBoot` (with the event's `reason` as the last-error
 * string). All events still forward to `inner` unchanged — observability is added, never replaced —
 * and the wrapper is total: a tracker/inner fault never breaks the extraction hot path.
 */
export function withExtractionErrorTracking(
	tracker: MemoryFormationTracker,
	inner?: ExtractionEventSink,
): ExtractionEventSink {
	return {
		event(name: string, fields?: Record<string, unknown>): void {
			if (name === "extraction.model_error") {
				try {
					const reason = typeof fields?.reason === "string" ? fields.reason : "unknown";
					tracker.recordExtractionError(reason);
				} catch {
					/* the health counter is best-effort — never break the extraction path over it. */
				}
			}
			inner?.event(name, fields);
		},
	};
}

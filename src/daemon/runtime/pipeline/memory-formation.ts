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

/** A point-in-time snapshot of memory-formation activity since boot. */
export interface MemoryFormationSnapshot {
	/** Memories committed (inserted / version-bumped / deduped) since daemon boot. */
	readonly committedSinceBoot: number;
	/** ISO timestamp of the most recent committed write; omitted until the first commit. */
	readonly lastCommittedAt?: string;
	/** The action of the most recent committed write; omitted until the first commit. */
	readonly lastAction?: string;
}

/** A monotonic committed-memories tracker (process-local, since daemon boot). */
export interface MemoryFormationTracker {
	/** Feed one controlled-write outcome; counts it only when it committed a memory. */
	record(outcome: MemoryFormationOutcome): void;
	/** The current committed-memories snapshot since boot. */
	snapshot(): MemoryFormationSnapshot;
}

/** Build a fresh in-memory memory-formation tracker. `now` is injectable for tests. */
export function createMemoryFormationTracker(now: () => number = Date.now): MemoryFormationTracker {
	let committed = 0;
	let lastCommittedAt: string | undefined;
	let lastAction: string | undefined;
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
		snapshot(): MemoryFormationSnapshot {
			return {
				committedSinceBoot: committed,
				...(lastCommittedAt !== undefined ? { lastCommittedAt } : {}),
				...(lastAction !== undefined ? { lastAction } : {}),
			};
		},
	};
}

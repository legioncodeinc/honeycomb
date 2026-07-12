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
 * The one-time controlled-write RE-DRIVE — PRD-080b (b-AC-4).
 *
 * ── Why this exists (recover the ~101 already-lost distilled memories) ────────
 * PRD-080a stops NEW distilled memories from being dropped in a degraded window. But the memories that
 * were already dropped BEFORE 080a shipped live on as TERMINAL (`status = failed`) `memory_controlled_write`
 * jobs in the home-anchored `local-queue.db` — retried 5× by the local job queue, then given up on. This
 * re-drive READS those terminal jobs and RE-RUNS each one's controlled-write, recovering the dropped
 * memory: on a healthy backend it commits directly (idempotent via the `content_hash` dedup — a memory a
 * prior attempt already landed is `deduped`, NO duplicate), and during a still-degraded window it defers
 * the resolved write into the durable `memory_outbox` (PRD-080a) for the drainer to land on recovery.
 *
 * ── It is a READER + an orchestrator, never new commit logic ─────────────────
 * This module holds NO controlled-write logic. It (1) reads the terminal job payloads off `local_job`
 * (read-only, fail-soft) and (2) hands each payload to the injected `redriveOne` seam — which the
 * composition root wires to {@link import("./controlled-writes.js").redriveControlledWritePayload}, the
 * SINGLE-SOURCED re-run of the live controlled-write path (dedup-idempotent by construction). The
 * extraction/decision is NEVER re-run (the proposal is already on the terminal job payload).
 *
 * ── Read-through fail-soft (b-AC-4) ──────────────────────────────────────────
 * A daemon whose `local-queue.db` is absent (never booted the local queue), unopenable, or holds NO
 * terminal `memory_controlled_write` jobs yields a CLEAN `{ redriven: 0, skipped: 0 }` report — never a
 * throw. A per-job re-run fault is already caught inside `redriveControlledWritePayload` (counted
 * `skipped`); this module additionally guards the whole pass so an unexpected fault degrades to the
 * counts accumulated so far, never a crash. Idempotent: re-running the re-drive re-reads the SAME terminal
 * jobs (they are not deleted) and the `content_hash` dedup guarantees no duplicate `memories` row.
 */

import { existsSync } from "node:fs";

import { sqlIdent } from "../../storage/sql.js";
import {
	LOCAL_JOB_FAILED,
	LOCAL_JOB_TABLE,
	loadSqlite,
	localQueueDaemonDir,
	localQueueDatabasePath,
	type SqliteDatabase,
	stringField,
} from "../services/local-job-queue.js";
import type { MemoryOutboxLogger } from "./memory-outbox.js";

/** The pipeline job kind whose TERMINAL rows the re-drive recovers (mirrors `PIPELINE_JOB_KINDS`). */
export const MEMORY_CONTROLLED_WRITE_KIND = "memory_controlled_write" as const;

/** The count triple the re-drive reports (b-AC-4). Carries NO secret — two counts. */
export interface MemoryRedriveResult {
	/** Facts recovered — the write LANDED (or was already present), or was durably deferred to the outbox. */
	readonly redriven: number;
	/** Facts NOT recovered — an unparseable payload, a gate skip, or a caught genuine failure. */
	readonly skipped: number;
}

/** Options for {@link readTerminalControlledWriteJobs}. Everything injected for testability. */
export interface ReadTerminalJobsOptions {
	/** The home-anchored base dir (`honeycombStateDir()` in production); the db lives at `<baseDir>/.daemon/local-queue.db`. */
	readonly baseDir?: string;
	/** Inject an already-open SQLite handle (tests seed terminal jobs into it); when set, this module never closes it. */
	readonly db?: SqliteDatabase;
	/** Secret-free structured-log sink for `memory.redrive.read_failed`. */
	readonly logger?: MemoryOutboxLogger;
}

/**
 * READ the payloads of every TERMINAL (`status = failed`, retries exhausted) `memory_controlled_write`
 * job from the home-anchored `local-queue.db` (b-AC-4). READ-THROUGH FAIL-SOFT: an absent db file (the
 * local queue never booted), an unopenable db, a missing `local_job` table, or an unparseable payload all
 * degrade to `[]` (or skip the bad row) — never a throw. The handle this function opens is always closed;
 * an injected {@link ReadTerminalJobsOptions.db} is left open (the caller owns it).
 */
export function readTerminalControlledWriteJobs(options: ReadTerminalJobsOptions = {}): Array<Record<string, unknown>> {
	let db: SqliteDatabase | null = null;
	const ownsDb = options.db === undefined;
	try {
		db = options.db ?? openExistingLocalQueueDb(options.baseDir);
		if (db === null) return []; // no local-queue.db yet → nothing to re-drive (clean report).
		const rows = db
			.prepare(
				`SELECT ${sqlIdent("payload_json")} FROM ${sqlIdent(LOCAL_JOB_TABLE)} ` +
					`WHERE ${sqlIdent("kind")} = ? AND ${sqlIdent("status")} = ?`,
			)
			.all(MEMORY_CONTROLLED_WRITE_KIND, LOCAL_JOB_FAILED);
		const out: Array<Record<string, unknown>> = [];
		for (const row of rows) {
			const payload = parseJobPayload(stringField(row, "payload_json"));
			if (payload !== null) out.push(payload);
		}
		return out;
	} catch (err: unknown) {
		options.logger?.event("memory.redrive.read_failed", { reason: err instanceof Error ? err.message : String(err) });
		return [];
	} finally {
		if (ownsDb && db !== null) {
			try {
				db.close();
			} catch {
				// A close fault on a read-only handle is inconsequential — never surface it.
			}
		}
	}
}

/** The seams {@link runMemoryRedrive} runs against (all injected — the module holds no commit logic). */
export interface MemoryRedriveDeps {
	/** Read the terminal `memory_controlled_write` job payloads (defaults to {@link readTerminalControlledWriteJobs}). */
	readonly readJobs: () => ReadonlyArray<Record<string, unknown>>;
	/** Re-run ONE terminal job payload's controlled-write (the composition root wires `redriveControlledWritePayload`). */
	readonly redriveOne: (payload: Record<string, unknown>) => Promise<MemoryRedriveResult>;
	/** Secret-free structured-log sink for `memory.redrive.*`. */
	readonly logger?: MemoryOutboxLogger;
}

/**
 * RUN the one-time re-drive (b-AC-4): read every terminal `memory_controlled_write` job, re-run each
 * through {@link MemoryRedriveDeps.redriveOne}, and SUM the counts. FAIL-SOFT end-to-end: `readJobs`
 * already returns `[]` on any read fault, and a `redriveOne` fault is caught here (counted `skipped`) so
 * one bad job never aborts the pass. Emits a secret-free `memory.redrive.completed { redriven, skipped }`
 * summary. NEVER throws — a daemon-down / no-terminal-jobs run reports `{ redriven: 0, skipped: 0 }`.
 */
export async function runMemoryRedrive(deps: MemoryRedriveDeps): Promise<MemoryRedriveResult> {
	let redriven = 0;
	let skipped = 0;
	try {
		for (const payload of deps.readJobs()) {
			try {
				const counts = await deps.redriveOne(payload);
				redriven += counts.redriven;
				skipped += counts.skipped;
			} catch (err: unknown) {
				// `redriveOne` (redriveControlledWritePayload) is already fail-soft per fact, but guard the
				// whole job so an unexpected fault degrades to "this job's facts skipped", never a pass abort.
				skipped += 1;
				deps.logger?.event("memory.redrive.job_failed", { reason: err instanceof Error ? err.message : String(err) });
			}
		}
	} catch (err: unknown) {
		// Belt-and-suspenders: even the iteration itself must never throw out of the re-drive (b-AC-4/b-AC-5).
		deps.logger?.event("memory.redrive.read_failed", { reason: err instanceof Error ? err.message : String(err) });
	}
	deps.logger?.event("memory.redrive.completed", { redriven, skipped });
	return { redriven, skipped };
}

/**
 * Open the EXISTING home-anchored `local-queue.db` read-only-style, or `null` when the file does not exist
 * yet (the local queue never booted). Reuses the local-queue trusted-root guard + path resolution (the
 * SAME file the queue + both outboxes ride — never a second db), so it inherits the identical traversal
 * safety. Opening a `DatabaseSync` on a missing path would CREATE it, so the `existsSync` guard is
 * load-bearing — the re-drive must never fabricate an empty queue db.
 */
function openExistingLocalQueueDb(baseDir: string | undefined): SqliteDatabase | null {
	const dir = localQueueDaemonDir(baseDir);
	const dbPath = localQueueDatabasePath(dir);
	if (!existsSync(dbPath)) return null;
	const sqlite = loadSqlite();
	return new sqlite.DatabaseSync(dbPath);
}

/** Parse a persisted `payload_json` back into a plain record; `null` on any corruption (never throws). */
function parseJobPayload(payloadJson: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(payloadJson) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

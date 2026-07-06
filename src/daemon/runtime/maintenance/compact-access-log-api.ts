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
 * PRD-058e — the access-log compaction TRIGGER route (L-W8).
 *
 * Wave 1 shipped {@link compactAccessLog} (the fold of raw `memory_access` events into `access_count`
 * + the watermark cursor advance) with ZERO production callers. This module IS the production caller:
 * a daemon route that scans the DISTINCT `memory_id`s in `memory_access`, calls `compactAccessLog` for
 * each under the daemon's scope, and folds the per-memory results into a summary. It mirrors
 * {@link mountCompactApi} (PRD-030) for the route shape: `POST /api/diagnostics/compact-access-log`
 * onto the already-mounted, protected `/api/diagnostics` group, ZERO `server.ts` edits.
 *
 * ── Why a compaction worker (PRD-058e Risks / open question) ──────────────────
 * The raw `memory_access` table grows without bound — every recall injects a row. Compaction keeps
 * the last `N = 32` raw events per memory and folds the older ones into the denormalized cache
 * (`access_count` is the lifetime total, owned solely by the append path; the fold advances
 * `last_reinforced_at` + the watermark cursor + deletes the aged rows). Without this worker the table
 * grows forever; with it the log stays bounded. The activation MATH reads the RETAINED raw rows
 * (post-compaction), so this is transparent to recall.
 *
 * ── Fail-soft (the maintenance posture) ──────────────────────────────────────
 * A request with no resolvable tenancy fails closed at the edge (400). Everything else is best-effort:
 * a per-memory compaction error is swallowed (`folded: 0` for that memory) and never aborts the pass.
 * A missing `memory_access` table → zero memory ids → an honest empty summary, never a 500. A
 * maintenance miss NEVER breaks recall (recall reads the retained rows OR the denormalized cache;
 * an absent compaction leaves both intact).
 */

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sqlIdent } from "../../storage/sql.js";
import { resolveScopeOrLocalDefault } from "../scope.js";
import type { Daemon } from "../server.js";
import {
	compactAccessLog,
	DEFAULT_ACCESS_COMPACTION_KEEP,
	type AccessLogDeps,
} from "../memories/access-log.js";
import { MEMORY_ACCESS_TABLE } from "../../storage/catalog/memory-lifecycle.js";

/** The route the compaction trigger is served at (full path `/api/diagnostics/compact-access-log`). */
export const COMPACT_ACCESS_LOG_TRIGGER_PATH = "/compact-access-log" as const;

/** The already-mounted, protected route group the trigger attaches to (no `server.ts` edit). */
export const COMPACT_ACCESS_LOG_TRIGGER_GROUP = "/api/diagnostics" as const;

/**
 * How many DISTINCT memory ids one pass compacts (bounded so a manual trigger is a normal request).
 * A larger backlog is converged over successive passes (the periodic tick fires every ~5 min).
 */
export const DEFAULT_COMPACT_ACCESS_LOG_BATCH = 200;

/** The 400 body for a request with no resolvable tenancy (fail-closed at the edge). */
const NO_ORG_BODY = { error: "bad_request", reason: "x-honeycomb-org header is required" } as const;

/**
 * The per-memory compaction outcome the summary carries (one entry per memory id scanned). A memory
 * with no rows past the keep horizon reports `folded: 0` (nothing to fold this pass, not an error).
 */
export interface CompactAccessMemoryResult {
	/** The memory id. */
	readonly memoryId: string;
	/** How many raw events were folded (advanced into the cache + deleted) this pass. */
	readonly folded: number;
	/** `true` when the compaction for this memory errored (fail-soft; reported, not thrown). */
	readonly errored: boolean;
}

/** The summary body the trigger returns (the contract the dashboard / CLI render). */
export interface CompactAccessLogSummaryBody {
	/** `true` when the pass ran to completion (even a partial fold is `ok`). */
	readonly ok: boolean;
	/** How many distinct memory ids the pass considered. */
	readonly scanned: number;
	/** Total raw events folded across all memories this pass. */
	readonly totalFolded: number;
	/** One entry per memory id scanned. */
	readonly results: readonly CompactAccessMemoryResult[];
}

/** Options for {@link mountCompactAccessLogApi}. */
export interface MountCompactAccessLogOptions {
	/** The live storage client the scan + compaction run through (guarded primitives). */
	readonly storage: StorageQuery;
	/** The daemon's own tenancy partition (the same `defaultScope` the other diagnostics mounts thread). */
	readonly defaultScope: QueryScope;
	/** The candidate-batch size. Defaults to {@link DEFAULT_COMPACT_ACCESS_LOG_BATCH}. */
	readonly batch?: number;
	/** The keep-N horizon (how many raw events to retain per memory). Defaults to {@link DEFAULT_ACCESS_COMPACTION_KEEP}. */
	readonly keepN?: number;
	/** Injectable clock for the per-memory compaction deps. Defaults to wall-clock. */
	readonly now?: () => Date;
	/** Injectable id generator for the per-memory compaction deps. Defaults to a UUID. */
	readonly newId?: () => string;
}

/**
 * Build the DISTINCT-memory-id scan SQL: the unique `memory_id` values in `memory_access`, bounded by
 * `limit`. Every identifier routes through `sqlIdent` (the SQL-safety floor); no value is interpolated
 * (the scan carries none — the org/workspace partition rides the `storage.query(sql, scope)` call).
 */
export function buildDistinctMemoryIdsSql(limit: number): string {
	const tbl = sqlIdent(MEMORY_ACCESS_TABLE);
	const memoryIdCol = sqlIdent("memory_id");
	const safeLimit = Math.max(1, Math.trunc(limit));
	return `SELECT DISTINCT ${memoryIdCol} AS memory_id FROM "${tbl}" LIMIT ${safeLimit}`;
}

/**
 * The pass function the route AND the periodic tick both call (L-W8 / PRD-058e). Scans the DISTINCT
 * `memory_id`s in `memory_access`, calls {@link compactAccessLog} for each under the scope, and folds
 * the per-memory results into a summary. FAIL-SOFT: a per-memory error is swallowed (`folded: 0`,
 * `errored: true`) and never aborts the pass; a missing table yields zero ids → an empty summary.
 * Pure of HTTP — the route maps this onto a status code, the tick calls it directly.
 */
export async function runCompactAccessLogPass(
	scope: QueryScope,
	options: MountCompactAccessLogOptions,
): Promise<CompactAccessLogSummaryBody> {
	const batch = options.batch ?? DEFAULT_COMPACT_ACCESS_LOG_BATCH;
	const keepN = options.keepN ?? DEFAULT_ACCESS_COMPACTION_KEEP;
	const deps: AccessLogDeps = {
		storage: options.storage,
		...(options.now !== undefined ? { now: options.now } : {}),
		...(options.newId !== undefined ? { newId: options.newId } : {}),
	};

	// Scan the DISTINCT memory ids with raw events. FAIL-SOFT: a read error (missing table) → empty.
	let memoryIds: string[] = [];
	try {
		const res = await options.storage.query(buildDistinctMemoryIdsSql(batch), scope);
		if (isOk(res)) {
			memoryIds = (res.rows as StorageRow[])
				.map((row) => String(row.memory_id ?? ""))
				.filter((id) => id !== "");
		}
	} catch {
		memoryIds = [];
	}

	const results: CompactAccessMemoryResult[] = [];
	let totalFolded = 0;
	for (const memoryId of memoryIds) {
		try {
			const outcome = await compactAccessLog(memoryId, deps, scope, keepN);
			results.push({ memoryId, folded: outcome.folded, errored: false });
			totalFolded += outcome.folded;
		} catch {
			// Fail-soft: a per-memory error never aborts the pass. Report it and continue.
			results.push({ memoryId, folded: 0, errored: true });
		}
	}

	return { ok: true, scanned: memoryIds.length, totalFolded, results };
}

/**
 * Attach the access-log compaction TRIGGER onto the daemon's already-mounted, protected
 * `/api/diagnostics` group (PRD-058e). Registers `POST /api/diagnostics/compact-access-log`, which
 * resolves the request scope (header org or the daemon default — fail-closed), scans the DISTINCT
 * memory ids with raw events, folds each memory's aged events into the cache, and returns the summary.
 * Call ONCE after `createDaemon(...)`. If the group is not mounted the attach is a no-op. FAIL-SOFT.
 */
export function mountCompactAccessLogApi(daemon: Daemon, options: MountCompactAccessLogOptions): void {
	const group = daemon.group(COMPACT_ACCESS_LOG_TRIGGER_GROUP);
	if (group === undefined) return;

	group.post(COMPACT_ACCESS_LOG_TRIGGER_PATH, async (c) => {
		const scope = resolveScopeOrLocalDefault(c, daemon.config.mode, options.defaultScope);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const summary = await runCompactAccessLogPass(scope, options);
		return c.json(summary, 200);
	});
}

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
 * The DAEMON-SIDE registry WRITE path for the `projects` table — the missing half
 * of PRD-049a/049d.
 *
 * ── The bug this closes ──────────────────────────────────────────────────────
 * 049a built the `projects` registry ColumnDef + the READ-shape builders, and 049d
 * wired the registry → local-cache sync. But there was NO write path: nothing in
 * `src/daemon` ever inserted a project ROW into the Deeplake `projects` table
 * (`buildEnsureUnsortedSelectSql` had zero call sites; `updateOrInsertByKey` was
 * called for entities/goals/kpis/memories but never projects). So a project bound
 * through the daemon API existed ONLY in the local JSON cache, and the very next
 * `syncRegistryToCache` overwrote the cache wholesale with the registry rows,
 * ERASING the just-bound project. This module is the write half: it upserts a
 * project into the registry so a bind PERSISTS cross-device and survives a sync.
 *
 * ── Pattern (CONVENTIONS.md §2 / PRD-002d) ───────────────────────────────────
 * The `projects` catalog declares `pattern: "update-or-insert"` keyed by
 * `project_id`, so this writes through the SAME {@link updateOrInsertByKey}
 * primitive the `goals`/`kpis` catalogs use — one logical row per `project_id`,
 * heal-aware (a missing table is CREATEd from the ColumnDef on the first write via
 * `withHeal`; no hand-rolled DDL). The `projects` schema already carries every
 * column this writer sets (`project_id`, `name`, `remote_signal`, `bound_paths`,
 * `is_reserved`, `org_id`, `workspace_id`, `created_at`, `updated_at`), so NO
 * schema change / additive heal is needed here.
 *
 * ── SQL-safety ───────────────────────────────────────────────────────────────
 * Every value routes through the 002d `val.*` constructors (→ `sLiteral` /
 * `eLiteral`); no value is hand-quoted, so `audit:sql` stays clean. `bound_paths`
 * is a JSON-array string written through `val.text` (escape-safe `E'...'`), which
 * matters for Windows paths (embedded backslashes) and any path with a quote.
 *
 * ── Fail-soft ────────────────────────────────────────────────────────────────
 * The write NEVER throws: a non-`ok` storage result becomes a typed
 * `{ ok: false, reason }` (a redacted `kind`/message, never a secret). The bind UX
 * treats the local bind as authoritative and the registry write as best-effort —
 * a flapped write leaves the project visible locally and heals on the next sync.
 */

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { healTargetFor, isReservedProjectId, PROJECTS_TABLE } from "../../storage/catalog/index.js";
import { PROJECT_NOT_RESERVED } from "../../storage/catalog/index.js";
import { isOk } from "../../storage/result.js";
import { type RowValues, updateOrInsertByKey, val } from "../../storage/writes.js";

/** The project fields a registry upsert writes (the mutable-CRUD shape, minus tenancy/time). */
export interface ProjectUpsert {
	/** The stable registry key a folder binds to. Must be non-empty and NOT the reserved inbox. */
	readonly projectId: string;
	/** Human display label; falls back to the id when empty. */
	readonly name: string;
	/** Canonicalized git remote (`host/owner/repo`), or '' when none. */
	readonly remoteSignal: string;
	/** Normalized absolute path prefixes bound to this project (serialized to the JSON `bound_paths`). */
	readonly boundPaths: readonly string[];
}

/** The typed outcome of a registry write (never a throw — fail-soft, mirrors the sync/resolver posture). */
export type RegistryWriteResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };

/**
 * Upsert ONE project row into the Deeplake `projects` registry (update-or-insert by
 * `project_id`). Returns `{ ok: false }` — never throws — when the write cannot land,
 * so the caller (bind UX / sync heal) can treat it as best-effort.
 *
 * The reserved `__unsorted__` inbox and an empty id are SKIPPED (reported as a
 * non-`ok` "skipped" result): the inbox is seeded separately and a user project may
 * never adopt the reserved id, so this writer refuses to materialize either.
 *
 * `now` is injectable so a test can assert a deterministic timestamp. `created_at`
 * and `updated_at` are both stamped `now`; the `update-or-insert` primitive sets the
 * same columns on an UPDATE as an INSERT, so a re-upsert of an existing project
 * refreshes `created_at` — an accepted, load-bearing-free drift (resolution keys on
 * bindings / `remote_signal`, never on `created_at`).
 */
export async function upsertProjectRow(
	storage: StorageQuery,
	scope: QueryScope,
	project: ProjectUpsert,
	now: string = new Date().toISOString(),
): Promise<RegistryWriteResult> {
	const projectId = project.projectId.trim();
	// The 049a-AC-6 collision guard: trim + case-insensitive over BOTH the reserved id and the
	// reserved display name (`isReservedProjectId`), on BOTH the id and the name — an exact-match
	// check alone would let `__UNSORTED__` / `Unsorted` materialize a user row shadowing the inbox.
	if (projectId.length === 0 || isReservedProjectId(projectId) || isReservedProjectId(project.name)) {
		return { ok: false, reason: "skipped: empty or reserved project id/name" };
	}

	const target = healTargetFor(PROJECTS_TABLE);
	const name = project.name.length > 0 ? project.name : projectId;
	const boundPathsJson = JSON.stringify([...project.boundPaths]);
	const row: RowValues = [
		["project_id", val.str(projectId)],
		["name", val.text(name)],
		["remote_signal", val.str(project.remoteSignal)],
		// bound_paths is a JSON-array string; val.text (E'...') is escape-safe for backslashes/quotes.
		["bound_paths", val.text(boundPathsJson)],
		["is_reserved", val.num(PROJECT_NOT_RESERVED)],
		["org_id", val.str(scope.org)],
		["workspace_id", val.str(scope.workspace ?? "")],
		["created_at", val.str(now)],
		["updated_at", val.str(now)],
	];

	const res = await updateOrInsertByKey(storage, target, scope, {
		keyColumn: "project_id",
		keyValue: projectId,
		row,
	});
	if (!isOk(res)) {
		const reason = res.kind === "query_error" ? `query_error: ${res.message}` : res.kind;
		return { ok: false, reason };
	}
	return { ok: true };
}

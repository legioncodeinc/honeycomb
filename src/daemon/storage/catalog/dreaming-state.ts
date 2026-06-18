/**
 * PRD-009a — Dreaming token-budget counter catalog table (`dreaming_state`).
 *
 * The single `USING deeplake` table that backs the dreaming loop's token-budget
 * trigger (PRD-009a). One LOGICAL row per (org, workspace, agent_id) scope tracks
 * `tokens_since_last_pass`, the `last_pass_at` timestamp, and the `pending_job_id`
 * of an in-flight dreaming pass. Written ONLY by the daemon's maintenance loop
 * through the PRD-002d write primitives + the PRD-002c heal engine — never a
 * hand-rolled `ALTER` (FR-8). The trigger module (`runtime/dreaming/trigger.ts`)
 * owns the increment/tick/enqueue/reset lifecycle; this module owns the
 * column-definition array the create path and the heal pass both iterate.
 *
 * ── Scope (D-1 / D-2 / CONVENTIONS §3) ──────────────────────────────────────
 * `scope: "agent"`. D-1 keys the counter per (org, workspace, agent_id). Per
 * CONVENTIONS §3 that is exactly the engine-table shape: the row carries
 * `agent_id` (`TEXT NOT NULL DEFAULT 'default'`) + `visibility`, and the
 * org/workspace half of the key comes from the storage partition layer (the
 * `QueryScope` the daemon passes to `storage.query`), NOT from columns. So two
 * agent_ids under one workspace accumulate independent counters via the `agent_id`
 * conjunct on every read/write (a-AC-6), and two workspaces never collide because
 * the partition isolates them. Unlike `memory_jobs` (`scope: "none"`, a
 * daemon-internal queue keyed only by job id), `dreaming_state` IS agent-scoped
 * recall-adjacent state, so it carries the agent columns.
 *
 * ── Write pattern (PRD-002d / D-3) ──────────────────────────────────────────
 * `pattern: "version-bumped"` by `id` (the deterministic per-scope key). The
 * counter's current value is the HIGHEST-`version` row carrying that `id`; every
 * increment and every reset APPENDs a fresh row at `version` = N+1 — never an
 * in-place UPDATE (FR-8 / a-AC-2). This is the SAME hard-won decision as
 * `memory_jobs`: independent live testing proved an in-place UPDATE on this
 * backend is NOT deterministic — the store serves a by-id point read of a
 * REWRITTEN row from segments of differing freshness that alternate
 * non-monotonically and indefinitely, so a re-read after an UPDATE can return the
 * pre-write snapshot forever. Append-only version-bump sidesteps it: versions only
 * ever INCREASE and a higher version is never fictitious, so resolving the counter
 * by `MAX(version)` across a bounded union of point-read polls CONVERGES
 * monotonically to the true current value regardless of which segment a single
 * read lands on. A daemon restart therefore reads back every committed write via
 * the highest-version read (a-AC-5, durable).
 *
 * ── The reset SUBTRACTS the threshold (D-3 / FR-5) ──────────────────────────
 * On enqueue the trigger does NOT hard-zero the counter; it appends a new version
 * whose `tokens_since_last_pass` is `prior - tokenThreshold` (floored at 0). A
 * summary write that lands between the threshold READ and the reset APPEND is not
 * lost: its tokens were already folded into a higher version, and subtracting the
 * threshold (rather than zeroing) carries the overflow forward toward the next
 * pass. This module only defines the column; the SUBTRACT arithmetic lives in the
 * trigger.
 *
 * Every `NOT NULL` column carries a `DEFAULT` so the heal pass's
 * `ALTER TABLE ADD COLUMN … NOT NULL` succeeds on a populated table (PRD-002c).
 */

import { type CatalogTable, defineGroup } from "./types.js";

/** The bare `dreaming_state` table name, exported so writers never re-spell it. */
export const DREAMING_STATE_TABLE = "dreaming_state" as const;

/**
 * `dreaming_state` — the per-scope token-budget counter (FR-1). Column order:
 * identity → counter → pass-tracking → scope → time → version.
 *
 * - `id`                     deterministic per-scope key (sha256 of agent_id; the
 *                            org/workspace half rides the partition). The
 *                            version-bump key.
 * - `tokens_since_last_pass` BIGINT running token count since the last pass
 *                            (FR-2). Reset SUBTRACTS the threshold (FR-5).
 * - `last_pass_at`           ISO-8601 timestamp of the last completed pass; set by
 *                            the runner on success (b-AC-5), empty until then.
 * - `pending_job_id`         the `memory_jobs` id of the in-flight dreaming pass,
 *                            or empty when none is pending (FR-1 / FR-6). The
 *                            single-pending guard reads this.
 * - `agent_id` / `visibility` engine-table scope columns (D-1 / D-2).
 * - `created_at` /
 *   `updated_at`             ISO-8601 lifecycle timestamps.
 * - `version`                BIGINT append-only version for this `id` (FR-8). Each
 *                            increment/reset INSERTs `version` = N+1; the counter's
 *                            current value is its highest-`version` row. Defaults
 *                            to 1 so the first appended row of a scope is version 1.
 */
export const DREAMING_STATE_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "tokens_since_last_pass", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "last_pass_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "pending_job_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "agent_id", sql: "TEXT NOT NULL DEFAULT 'default'" },
	{ name: "visibility", sql: "TEXT NOT NULL DEFAULT 'global'" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "updated_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "version", sql: "BIGINT NOT NULL DEFAULT 1" },
]);

/** The 009a dreaming-state group — spread into `CATALOG` by the barrel. */
export const DREAMING_STATE_TABLES: readonly CatalogTable[] = defineGroup([
	{
		name: DREAMING_STATE_TABLE,
		columns: DREAMING_STATE_COLUMNS,
		pattern: "version-bumped",
		embeddingColumns: [],
		scope: "agent",
	},
]);

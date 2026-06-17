/**
 * PRD-004b — Durable Job Queue catalog table (`memory_jobs`).
 *
 * The single `USING deeplake` table that backs the daemon's durable background
 * queue (distillation, summaries, skillify). Written ONLY by the daemon on port
 * 3850 through the PRD-002d write primitives + the PRD-002c heal engine — never a
 * hand-rolled `ALTER`. The queue service (`runtime/services/job-queue.ts`) owns
 * the lease/complete/fail/dead lifecycle and the reaper; this module owns the
 * column-definition array the create path and the heal pass both iterate (FR-1 /
 * FR-6 / b-AC-6).
 *
 * ── Scope (D-2 / CONVENTIONS §3) ────────────────────────────────────────────
 * `scope: "none"`. The queue is a daemon-internal control-plane table, NOT an
 * agent-recall engine table and NOT a cross-cutting tenant-keyed table. Org and
 * workspace isolation come from the storage partition layer (the `QueryScope`
 * the daemon passes to `storage.query`), exactly as for engine tables — so the
 * row carries neither the `agent_id`/`visibility` pair (it is not agent-scoped
 * recall) nor an explicit `org_id`/`workspace_id` pair (the partition already
 * isolates it). `"none"` is the honest fit: the queue relies on the partition,
 * not on tenancy columns.
 *
 * ── Write pattern (PRD-002d) ────────────────────────────────────────────────
 * `pattern: "version-bumped"` by `id` (the durable job identity). A job is a
 * LOGICAL key whose state is the HIGHEST-`version` row carrying that `id`; every
 * transition (enqueue, lease, complete, fail, reap-reclaim, dead) APPENDs a fresh
 * row at `version` = N+1 with the new `status`/lease fields — never an in-place
 * UPDATE. The current state of a job is read by resolving the highest version for
 * its id (`ORDER BY version DESC LIMIT 1`), exactly like skills / rules /
 * entity_attributes (FR-6).
 *
 * Why this and not `update-or-insert`: independent live testing proved an
 * in-place UPDATE on this backend is NOT deterministic under the queue's read
 * patterns. The store serves a SCAN (and even a by-id point read of a REWRITTEN
 * row) from segments of differing freshness that alternate non-monotonically and
 * indefinitely — so a status-filtered reaper / lease scan over mutated rows flaps,
 * and re-reading a just-UPDATEd row can return its pre-write snapshot. Append-only
 * version-bump sidesteps both: versions only ever INCREASE and a higher version is
 * never fictitious, so resolving a job by `MAX(version)` across a bounded union of
 * point-read polls CONVERGES monotonically to the true current state regardless of
 * which segment a single read lands on (verified live). Ownership confirm is then a
 * by-id highest-version read of the just-appended lease row (b-AC-1). The queue
 * service owns those reads; this catalog record only assigns the pattern.
 *
 * ── Status lifecycle (FR-1) ─────────────────────────────────────────────────
 *   queued  → leasable now (or once `next_run_at` passes for a re-queued fail)
 *   leased  → held by exactly one worker until expiry / complete / fail (b-AC-1)
 *   done    → completed; purged past the completion window (b-AC-7)
 *   failed  → attempts remain; `next_run_at` set by exponential backoff (b-AC-4)
 *   dead    → exhausted `max_attempts`; never leased again (b-AC-2), retained
 *             longer than `done` (b-AC-7)
 *
 * Each state is a NEW appended row at the next `version` for the job's `id`; the
 * job's current status is the status on its highest-`version` row.
 *
 * `payload` is JSONB BY DESIGN — a genuinely schemaless per-job-kind body (the
 * sanctioned JSONB use per CONVENTIONS §5), nullable so NULL is its implicit
 * default. Every other `NOT NULL` column carries a `DEFAULT` so the heal pass's
 * `ALTER TABLE ADD COLUMN … NOT NULL` succeeds on a populated table (PRD-002c).
 */

import { type CatalogTable, defineGroup } from "./types.js";

/** Canonical `memory_jobs.status` lifecycle states (FR-1). */
export const JOB_QUEUED = "queued" as const;
export const JOB_LEASED = "leased" as const;
export const JOB_DONE = "done" as const;
export const JOB_FAILED = "failed" as const;
export const JOB_DEAD = "dead" as const;

/** The five legal status values, frozen, in lifecycle order (FR-1). */
export const JOB_STATUSES = Object.freeze([JOB_QUEUED, JOB_LEASED, JOB_DONE, JOB_FAILED, JOB_DEAD] as const);

/** A `memory_jobs.status` value. */
export type JobStatus = (typeof JOB_STATUSES)[number];

/** The queue's default retry/lease tuning (D-3). Mirrored by the service config. */
/** Bounded retries before a job walks to `dead` (D-3). */
export const DEFAULT_MAX_ATTEMPTS = 5;
/** Exponential-backoff base in ms — doubles per attempt (D-3). */
export const DEFAULT_BACKOFF_BASE_MS = 1_000;
/** Exponential-backoff cap in ms — 5 minutes (D-3). */
export const DEFAULT_BACKOFF_CAP_MS = 5 * 60 * 1_000;
/** Lease duration in ms — 5 minutes (D-3). */
export const DEFAULT_LEASE_MS = 5 * 60 * 1_000;

/**
 * `memory_jobs` — the durable queue (FR-1). Column order mirrors the FR exactly:
 * identity → routing → payload → lease → retry → schedule → diagnostics → time.
 *
 * - `id`               durable job identity; the update-or-insert key.
 * - `type`             the job kind, routing it to a handler.
 * - `payload`          JSONB schemaless per-kind body (nullable).
 * - `status`           the lifecycle state; defaults `'queued'` (FR-1).
 * - `lease_owner`      the worker id holding the current lease (empty when free).
 * - `lease_expires_at` ISO-8601 lease expiry; the reaper reclaims past it (b-AC-3).
 * - `attempts`         BIGINT run counter; incremented on each fail (FR-3).
 * - `max_attempts`     BIGINT bound; at this count the job → `dead` (FR-4, D-3).
 * - `next_run_at`      ISO-8601 earliest leasable time; set by backoff (b-AC-4).
 * - `last_error`       the most recent failure reason, for triage (FR-3).
 * - `created_at` /
 *   `updated_at`       ISO-8601 lifecycle timestamps.
 * - `version`          BIGINT append-only version for this `id` (FR-6). Each
 *                      transition INSERTs `version` = N+1; the job's current state
 *                      is its highest-`version` row. Defaults to 1 so the first
 *                      appended row of a job is version 1.
 */
export const MEMORY_JOBS_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "type", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "payload", sql: "JSONB" },
	{ name: "status", sql: "TEXT NOT NULL DEFAULT 'queued'" },
	{ name: "lease_owner", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "lease_expires_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "attempts", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "max_attempts", sql: "BIGINT NOT NULL DEFAULT 5" },
	{ name: "next_run_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "last_error", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "updated_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "version", sql: "BIGINT NOT NULL DEFAULT 1" },
]);

/** The bare `memory_jobs` table name, exported so the service never re-spells it. */
export const MEMORY_JOBS_TABLE = "memory_jobs" as const;

/** The 004b runtime-jobs group — spread into `CATALOG` by the barrel. */
export const RUNTIME_JOBS_TABLES: readonly CatalogTable[] = defineGroup([
	{
		name: MEMORY_JOBS_TABLE,
		columns: MEMORY_JOBS_COLUMNS,
		pattern: "version-bumped",
		embeddingColumns: [],
		scope: "none",
	},
]);

/**
 * PRD-003e — Agents, Auth, and Telemetry (Wave 2, IMPLEMENTED).
 *
 * The within-workspace and operations tables:
 *
 *   - `agents`          → the roster that drives read-policy enforcement.
 *                         UPDATE-or-INSERT by `id`. Carries `read_policy`
 *                         ∈ {isolated, shared, group} and `policy_group` that
 *                         bounds visibility for group-scoped agents (e-AC-1/e-AC-6).
 *
 *   - `api_keys`        → hashed, revocable credentials for remote connectors.
 *                         APPEND-ONLY VERSION-BUMPED by `id` (PRD-011d / d-AC-4).
 *                         A key's current state is the HIGHEST-`version` row for its
 *                         `id`; every transition (create, revoke) APPENDs a fresh row
 *                         at `version` = N+1 — NEVER an in-place UPDATE. Holds ONLY
 *                         `key_hash` (a scrypt-salted string for 011d keys; a legacy
 *                         SHA-256 hex for 003e keys) — NEVER a plaintext key column.
 *                         Revoke APPENDs a new version with `revoked = 1` (BIGINT) and
 *                         every other field copied forward; the prior version is
 *                         retained for audit, never mutated in place (e-AC-2/e-AC-3).
 *
 *   - `telemetry_counters` → opt-in diagnostics counters (FR-5 / e-AC-4).
 *                         Append-only. counter_name + value + window only;
 *                         NO secret, request body, or prompt content column.
 *
 *   - `recall_qa_ledger`  → optional recall-outcome ledger (FR-6 / e-AC-4).
 *                         Append-only. Stores query/recall outcome metadata only;
 *                         NO request bodies or secrets.
 *
 *   - `router_history`  → redacted model-routing history (FR-7 / e-AC-5).
 *                         Append-only. model, provider, workload, outcome ONLY.
 *                         There is NO prompt-content column, by design and by
 *                         security invariant.
 *
 * ── SECURITY INVARIANTS (Wave 3 audit targets) ──────────────────────────────
 *
 *  1. `api_keys` has NO column named `key`, `secret`, `token`, or `plaintext`.
 *     The only credential column is `key_hash` (TEXT). Callers MUST hash before
 *     passing to the write primitive. Use {@link hashApiKey} to compute SHA-256.
 *
 *  2. No telemetry table (`telemetry_counters`, `recall_qa_ledger`,
 *     `router_history`) has a column that could hold a secret, request body,
 *     or prompt content. The structural test (e-AC-4/e-AC-5) in
 *     `tests/daemon/storage/catalog/tenancy.test.ts` asserts this invariant
 *     at import time.
 *
 *  3. `router_history` has NO `prompt`, `prompt_content`, `query`, `input`,
 *     or `request_body` column. Routing metadata (model/provider/workload/outcome)
 *     is recorded; the prompt is silently dropped at the write site.
 *
 * ── Scope (CONVENTIONS.md §3 / D-2) ────────────────────────────────────────
 *  These are CROSS-CUTTING / tenancy tables → `scope: "tenant"`.
 *  They carry explicit `org_id` + `workspace_id` (TEXT NOT NULL DEFAULT '').
 *  Engine-scoped tables (sessions, memory, memories…) use scope "agent" instead.
 *
 * ── Write patterns (CONVENTIONS.md §2) ──────────────────────────────────────
 *  agents / api_keys  → update-or-insert  (one logical row per key identity)
 *  telemetry tables   → append-only       (one row per event, never mutated)
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { sqlIdent, sLiteral } from "../sql.js";
import { type CatalogTable, defineGroup } from "./types.js";

// ── Allowed read_policy values (e-AC-1 / FR-2) ──────────────────────────────

/** All valid `agents.read_policy` values. */
export const AGENT_READ_POLICIES = Object.freeze(["isolated", "shared", "group"] as const);
export type AgentReadPolicy = (typeof AGENT_READ_POLICIES)[number];

// ── AGENTS columns (FR-1 / e-AC-1 / e-AC-6) ─────────────────────────────────

/**
 * `agents` — the within-workspace roster (FR-1). UPDATE-or-INSERT by `id`.
 * `read_policy` default is `'isolated'` (the most conservative posture).
 * `policy_group` is blank by default; only meaningful when `read_policy='group'`.
 *
 * Scope: tenant (cross-cutting, carries explicit org_id + workspace_id).
 */
export const AGENTS_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "name", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "read_policy", sql: "TEXT NOT NULL DEFAULT 'isolated'" },
	{ name: "policy_group", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "org_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "workspace_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "updated_at", sql: "TEXT NOT NULL DEFAULT ''" },
]);

// ── API_KEYS columns (FR-3 / e-AC-2 / e-AC-3) ────────────────────────────────

/**
 * `api_keys` — hashed, revocable credentials (FR-3). APPEND-ONLY VERSION-BUMPED
 * by `id` (PRD-011d / d-AC-4).
 *
 * SECURITY: `key_hash` is the ONLY credential column (a scrypt-salted string for
 * 011d keys, a legacy SHA-256 hex for 003e keys). There is intentionally NO `key`,
 * `secret`, `token`, or `plaintext` column. See {@link scryptHashSecret} (new keys)
 * / {@link hashApiKey} (legacy) to compute the hash before writing.
 *
 * `permissions` stores a JSON array of explicit permission strings (default '[]').
 * `connector`, `harness`, `agent` name the binding (empty when not bound).
 * `revoked` is BIGINT 0 (live) / 1 (revoked).
 *
 * ── Why append-only version-bump, NOT in-place UPDATE (PRD-011d / d-AC-4) ─────
 * A key is a LOGICAL key whose state is the HIGHEST-`version` row carrying its
 * `id`; every transition (create → v1, revoke → v+1) APPENDs a fresh row, never an
 * in-place UPDATE — the SAME rationale as `runtime-jobs.ts` (the `memory_jobs`
 * queue) and `ontology/supersede.ts`. Independent live testing proved an in-place
 * `UPDATE … SET revoked = 1 WHERE id = …` on this backend is NOT deterministic: the
 * store serves a by-id point read from segments of differing freshness, so a
 * just-UPDATEd row can return its pre-write (pre-revoke) snapshot — and a REVOKED
 * key would still authenticate. Append-only version-bump sidesteps it: versions only
 * ever INCREASE and a higher version is never fictitious, so resolving a key by
 * `MAX(version)` (`ORDER BY version DESC LIMIT 1`) converges monotonically to the
 * true current state — a revoked key's highest version carries `revoked = 1` and is
 * rejected. The authenticator + revoke + list all resolve the highest version per id.
 *
 * `version` is BIGINT, defaults to 0 so the heal's `ALTER TABLE ADD COLUMN … NOT
 * NULL DEFAULT 0` lands additively on a populated 003e table; {@link createApiKey}
 * writes the first row at version 1. `last_used_at` is retained for compatibility
 * but is never mutated in place (a touch would be a new appended version).
 *
 * Scope: tenant (cross-cutting, carries explicit org_id + workspace_id).
 */
export const API_KEYS_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "name", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "key_hash", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "role", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "scope", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "permissions", sql: "TEXT NOT NULL DEFAULT '[]'" },
	{ name: "connector", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "harness", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "agent", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "revoked", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "org_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "workspace_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "last_used_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "version", sql: "BIGINT NOT NULL DEFAULT 0" },
]);

/** `revoked` encodings (e-AC-3 / D-3). BIGINT 0/1 per D-3. */
export const KEY_LIVE = 0 as const;
export const KEY_REVOKED = 1 as const;

// ── TELEMETRY_COUNTERS columns (FR-5 / e-AC-4) ───────────────────────────────

/**
 * `telemetry_counters` — opt-in diagnostics usage counters (FR-5).
 * Append-only INSERT. Each row is one counter observation: name, value, window.
 *
 * SECURITY: NO column for secrets, request bodies, or prompt content.
 *
 * Scope: tenant.
 */
export const TELEMETRY_COUNTERS_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "counter_name", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "value", sql: "FLOAT4 NOT NULL DEFAULT 0" },
	{ name: "window", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "org_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "workspace_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
]);

// ── RECALL_QA_LEDGER columns (FR-6 / e-AC-4) ─────────────────────────────────

/**
 * `recall_qa_ledger` — optional recall-outcome QA record (FR-6). Append-only.
 * Records outcome metadata for recall-quality tuning only.
 *
 * SECURITY: NO request body or secret column. `query_hash` is a hash of the
 * query text, not the raw query itself, so no prompt leaks here.
 *
 * Scope: tenant.
 */
export const RECALL_QA_LEDGER_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "query_hash", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "recall_outcome", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "result_count", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "top_score", sql: "FLOAT4 NOT NULL DEFAULT 0" },
	{ name: "embedding_used", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "org_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "workspace_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
]);

// ── ROUTER_HISTORY columns (FR-7 / e-AC-5) ───────────────────────────────────

/**
 * `router_history` — redacted model-routing history (FR-7). Append-only.
 * Records model, provider, workload, and outcome ONLY. Prompt content is
 * intentionally and permanently absent.
 *
 * SECURITY INVARIANT: There is NO `prompt`, `prompt_content`, `query`,
 * `input`, or `request_body` column. The router drops the prompt before
 * writing; this table can never hold it.
 *
 * Scope: tenant.
 */
export const ROUTER_HISTORY_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "model", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "provider", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "workload", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "outcome", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "latency_ms", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "org_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "workspace_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
]);

// ── ROI_METRICS columns (PRD-060f / f-AC-1..f-AC-12) ─────────────────────────

/**
 * `roi_metrics` — the shared, append-only spend ledger (PRD-060f). One immutable
 * row per session, written at summary/skillify time via `appendOnlyInsert`. A
 * re-price APPENDs a NEW row with a fresh `price_ref`; there is NO UPDATE path,
 * and the canonical row per `session_id` is `MAX(created_at)` (f-AC-2/f-AC-3).
 *
 * ── Why tenant-scoped, not agent-scoped (f-AC-1) ─────────────────────────────
 * Rollups need QUERYABLE identity columns — `org_id`/`workspace_id`/`team_id` are
 * explicit columns a `GROUP BY` reads, not a partition header. An agent-scoped
 * table could not answer a cross-device org question. So `scope: "tenant"` and the
 * org/workspace columns are first-class, exactly like `telemetry_counters` /
 * `recall_qa_ledger`.
 *
 * ── Money is BIGINT integer cents, never FLOAT (f-AC-4) ──────────────────────
 * Every money column (`measured_cache_savings_cents`, `modeled_savings_cents`,
 * `gross_cost_cents`, `infra_cost_cents`) is `BIGINT` — a ledger must reconcile to
 * the penny. There is intentionally NO float money column here (`telemetry_counters`
 * uses `FLOAT4` for an approximate counter; that is the wrong type for a ledger).
 *
 * ── Measured / modeled / allocated are SEPARATE, self-describing (f-AC-5) ─────
 * Measured cache savings (060b) and modeled memory-injection savings (060b) are
 * DISTINCT columns; `cost_basis` (`'measured'|'allocated'|'none'`, DEFAULT
 * `'none'`) + `allocation_method` mark whether an infra share is a measured fact or
 * an allocated estimate, so a mixed-basis rollup is detectable via
 * `COUNT(DISTINCT cost_basis) > 1` and an allocated estimate never reads as measured.
 *
 * ── The per-user gate (f-AC-6/f-AC-7) ────────────────────────────────────────
 * `user_id` is GATED: it is populated ONLY from a verified `backend-token` claim and
 * stays `''` otherwise. There is no git-email / `$USER` / OS-login fallback and no
 * historical backfill — the WRITER enforces this; the column merely carries the value.
 *
 * No embedding column. No JSONB. Indexes are lookup-only on the rollup columns
 * (`org_id`/`workspace_id`/`team_id`/`period_start` + drill-down `project_id`/`user_id`);
 * NO BM25, NO vector — this is a ledger, not a search corpus (f-AC-12).
 *
 * Scope: tenant.
 */
export const ROI_METRICS_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "session_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "org_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "workspace_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "agent_id", sql: "TEXT NOT NULL DEFAULT 'default'" },
	{ name: "project_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "team_id", sql: "TEXT NOT NULL DEFAULT ''" },
	// GATED: '' until a verified backend-token claim populates it (f-AC-6/f-AC-7).
	{ name: "user_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "input_tokens", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "output_tokens", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "cache_read_tokens", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "cache_creation_tokens", sql: "BIGINT NOT NULL DEFAULT 0" },
	// MEASURED / MODELED / GROSS / INFRA money — BIGINT integer cents, never FLOAT (f-AC-4).
	{ name: "measured_cache_savings_cents", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "modeled_savings_cents", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "modeled_assumption_ref", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "gross_cost_cents", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "infra_cost_cents", sql: "BIGINT NOT NULL DEFAULT 0" },
	// cost_basis ∈ {measured, allocated, none}; allocation_method '' unless allocated (f-AC-5).
	{ name: "cost_basis", sql: "TEXT NOT NULL DEFAULT 'none'" },
	{ name: "allocation_method", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "price_ref", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "period_start", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "period_end", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
]);

/** Allowed `roi_metrics.cost_basis` values (f-AC-5). */
export const ROI_COST_BASES = Object.freeze(["measured", "allocated", "none"] as const);
/** One `cost_basis` value. */
export type RoiCostBasis = (typeof ROI_COST_BASES)[number];

// ── TEAMS columns (PRD-060f / f-AC-8) ────────────────────────────────────────

/**
 * `teams` — the roster (PRD-060f). One row per (team, member), VERSION-BUMPED via
 * `appendVersionBumped` (edit = INSERT version N+1, `ORDER BY version DESC` read) —
 * the same primitive `api_keys` uses, for the same reason (an in-place UPDATE does
 * not converge on this backend). `member_type` is an `'agent'|'user'` union: an
 * `agent` row maps an `agent_id` to a `team_id` and works TODAY; a `user` row is
 * structurally valid but inert until `user_id` is verified (f-AC-8).
 *
 * Indexes: lookup-only on `org_id`/`workspace_id`/`team_id`/`member_id`. No BM25, no
 * vector.
 *
 * Scope: tenant.
 */
export const TEAMS_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "team_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "team_name", sql: "TEXT NOT NULL DEFAULT ''" },
	// 'agent' rows work today; 'user' rows inert until user_id verified.
	{ name: "member_type", sql: "TEXT NOT NULL DEFAULT 'agent'" },
	{ name: "member_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "role", sql: "TEXT NOT NULL DEFAULT 'member'" },
	{ name: "active", sql: "BIGINT NOT NULL DEFAULT 1" },
	{ name: "org_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "workspace_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "version", sql: "BIGINT NOT NULL DEFAULT 0" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "updated_at", sql: "TEXT NOT NULL DEFAULT ''" },
]);

/** Allowed `teams.member_type` values (f-AC-8). */
export const TEAM_MEMBER_TYPES = Object.freeze(["agent", "user"] as const);
/** One `member_type` value. */
export type TeamMemberType = (typeof TEAM_MEMBER_TYPES)[number];

/** Live/inactive encodings for `teams.active` (BIGINT 0/1). */
export const TEAM_ACTIVE = 1 as const;
export const TEAM_INACTIVE = 0 as const;

// ── The group export ─────────────────────────────────────────────────────────

/** The 003e group — spread into `CATALOG` by the barrel. */
export const TENANCY_TABLES: readonly CatalogTable[] = defineGroup([
	{
		name: "agents",
		columns: AGENTS_COLUMNS,
		pattern: "update-or-insert",
		embeddingColumns: [],
		scope: "tenant",
	},
	{
		name: "api_keys",
		columns: API_KEYS_COLUMNS,
		// Append-only version-bump by `id` (PRD-011d / d-AC-4): create → v1, revoke
		// → v+1, NEVER an in-place UPDATE (which does not converge on this backend —
		// a revoked key would still authenticate). State = highest-version row per id.
		pattern: "version-bumped",
		embeddingColumns: [],
		scope: "tenant",
	},
	{
		name: "telemetry_counters",
		columns: TELEMETRY_COUNTERS_COLUMNS,
		pattern: "append-only",
		embeddingColumns: [],
		scope: "tenant",
	},
	{
		name: "recall_qa_ledger",
		columns: RECALL_QA_LEDGER_COLUMNS,
		pattern: "append-only",
		embeddingColumns: [],
		scope: "tenant",
	},
	{
		name: "router_history",
		columns: ROUTER_HISTORY_COLUMNS,
		pattern: "append-only",
		embeddingColumns: [],
		scope: "tenant",
	},
	{
		// PRD-060f (f-AC-1/f-AC-2): the shared spend ledger. APPEND-ONLY — one
		// immutable row per session, a re-price APPENDs a new row (new price_ref),
		// NEVER an in-place UPDATE; the canonical row is MAX(created_at) per session.
		name: "roi_metrics",
		columns: ROI_METRICS_COLUMNS,
		pattern: "append-only",
		embeddingColumns: [],
		scope: "tenant",
	},
	{
		// PRD-060f (f-AC-8): the roster. VERSION-BUMPED — one row per (team, member),
		// an edit APPENDs version N+1, read ORDER BY version DESC (same as api_keys).
		name: "teams",
		columns: TEAMS_COLUMNS,
		pattern: "version-bumped",
		embeddingColumns: [],
		scope: "tenant",
	},
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Hash a plaintext API key to the `key_hash` stored in `api_keys` (e-AC-2).
 * Returns a lowercase hex SHA-256 digest. MUST be called BEFORE the write
 * primitive — the table stores ONLY the hash, never the plaintext.
 *
 * Pure and deterministic: the same plaintext always yields the same hash,
 * so a caller validating a presented key computes `hashApiKey(presented)` and
 * compares to the stored `key_hash`.
 *
 * ── SUPERSEDED for new keys by {@link scryptHashSecret} (PRD-011d / d-AC-1) ──
 * SHA-256 is unsalted + fast — a leaked `api_keys` table would be brute-forceable.
 * New keys (011d) store a salted, cost-parameterized {@link scryptHashSecret} string
 * in the SAME `key_hash` column and look up by `id` ({@link buildApiKeyLookupByIdSql})
 * + verify with {@link scryptVerifySecret}. This deterministic helper is RETAINED only
 * for the existing live-smoke scaffold (which needs a hash it can recompute for a probe)
 * and any 003e caller not yet migrated; do NOT use it to mint a new production key.
 */
export function hashApiKey(plaintext: string): string {
	return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/**
 * Build the API-key lookup SQL by `key_hash` (e-AC-2). A caller validating a
 * presented key hashes it first (via {@link hashApiKey}), then probes the table.
 * Both the table name and the column name route through `sqlIdent`; the hash
 * value routes through `sLiteral` (SQL-safety floor, PRD-002b).
 */
export function buildApiKeyLookupSql(keyHash: string): string {
	const tbl = sqlIdent("api_keys");
	const col = sqlIdent("key_hash");
	return `SELECT * FROM "${tbl}" WHERE ${col} = ${sLiteral(keyHash)} AND revoked = 0 LIMIT 1`;
}

/**
 * Build the API-key lookup SQL by `id`, resolving the HIGHEST-`version` row (the
 * public KEY-ID prefix — d-AC-1/d-AC-4).
 *
 * The scrypt reconciliation (PRD-011d) changes the validation shape: a scrypt hash
 * carries a PER-KEY random salt, so it is NOT deterministic and a presented key can
 * no longer be matched by a `key_hash = <hash>` equality probe (the SHA-256 path
 * {@link buildApiKeyLookupSql} relied on). Instead the plaintext is `<keyid>.<secret>`:
 * the public `keyid` is the row `id`, looked up here, and the secret is scrypt-verified
 * against the row's salt-embedding `key_hash` string in TypeScript via
 * {@link scryptVerifySecret}.
 *
 * ── Highest version per id (PRD-011d / d-AC-4) ───────────────────────────────
 * `api_keys` is append-only version-bumped: a key has ONE row per transition
 * (create → v1, revoke → v+1) and its current state is the row with the greatest
 * `version`. So this read is `ORDER BY version DESC LIMIT 1` — NOT a bare
 * `LIMIT 1`. After revoke appends a v+1 row carrying `revoked = 1`, that v+1 row IS
 * the highest version, so the authenticator reads the REVOKED state and rejects the
 * key (d-AC-4). A plain by-id read could serve the stale pre-revoke v1 segment and
 * let a revoked key authenticate — the exact bug this fixes. The row is NOT filtered
 * by `revoked` so the authenticator can reject a revoked record explicitly and
 * per-key; the caller MUST check `revoked` on the WINNING (highest) version after
 * the scrypt verify. Both identifiers route through `sqlIdent`; the id value routes
 * through `sLiteral` (SQL-safety floor, PRD-002b).
 */
export function buildApiKeyLookupByIdSql(id: string): string {
	const tbl = sqlIdent("api_keys");
	const col = sqlIdent("id");
	const ver = sqlIdent("version");
	return `SELECT * FROM "${tbl}" WHERE ${col} = ${sLiteral(id)} ORDER BY ${ver} DESC LIMIT 1`;
}

/**
 * Build the highest-version SELECT for ONE api-key `id` (PRD-011d / d-AC-4). The
 * append-only revoke path reads this to find the current row to copy forward before
 * appending the v+1 revoked row (the same shape as the authenticator's lookup). It
 * is `ORDER BY version DESC LIMIT 1` so it resolves the current state, never a stale
 * segment. Identifiers via `sqlIdent`; the id value via `sLiteral` (PRD-002b).
 *
 * This is an alias of {@link buildApiKeyLookupByIdSql} kept as a named, intent-revealing
 * entry point for the revoke read so a future reader sees the highest-version contract
 * at the revoke call site, not a generic "lookup".
 */
export function buildApiKeyHighestVersionByIdSql(id: string): string {
	return buildApiKeyLookupByIdSql(id);
}

/**
 * ── RETIRED (PRD-011d / d-AC-4): the in-place-UPDATE revoke. NO LIVE CALLER. ──
 *
 * Build the legacy 003e revocation SQL — `UPDATE "api_keys" SET revoked = 1 WHERE
 * id = …`. This in-place UPDATE is RETIRED: independent live testing proved a by-id
 * `SET revoked = 1` does NOT reliably land on this backend (the store serves a by-id
 * point read from segments of differing freshness, so a just-UPDATEd row can return
 * its pre-revoke snapshot — and a REVOKED key would still authenticate). Revocation is
 * now an APPEND of a new highest `version` row with `revoked = 1` (see `revokeKey` in
 * `runtime/auth/api-keys.ts`, mirroring `ontology/supersede.ts`'s `appendPriorSuperseded`).
 *
 * The function is RETAINED only so the original 003e shape test still imports it; it
 * MUST NOT be called on a live path. Both identifiers route through `sqlIdent`; the id
 * value routes through `sLiteral` (SQL-safety floor, PRD-002b).
 */
export function buildRevokeApiKeySql(id: string): string {
	const tbl = sqlIdent("api_keys");
	const idCol = sqlIdent("id");
	const revokedCol = sqlIdent("revoked");
	return `UPDATE "${tbl}" SET ${revokedCol} = ${KEY_REVOKED} WHERE ${idCol} = ${sLiteral(id)}`;
}

// ── scrypt key-hashing (d-AC-1 — the SHA-256 → scrypt+salt reconciliation) ─────

/**
 * The scrypt cost parameters for an API-key secret hash (d-AC-1). N=16384 (2^14),
 * r=8, p=1 is the interactive-login baseline recommended for scrypt: meaningful work
 * per guess without making a single legitimate verify slow. `keyLen=32` matches the
 * `<#>`-free 256-bit output. Encoded INTO the hash string so a future cost bump is
 * forward-compatible (an old key still verifies under its own recorded N/r/p).
 */
export const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keyLen: 32 } as const);

/** The self-describing scrypt hash prefix; the format is `scrypt$N$r$p$<saltB64url>$<hashB64url>`. */
export const SCRYPT_HASH_SCHEME = "scrypt" as const;

/**
 * Hash an API-key SECRET with scrypt and a fresh per-key random salt (d-AC-1).
 *
 * Returns a single self-describing string — `scrypt$N$r$p$<salt>$<hash>` — so the salt
 * and the cost parameters travel WITH the hash and NO schema change is needed (the salt
 * lives inside `api_keys.key_hash`, not a new column). The plaintext secret is NEVER
 * stored; only this string is. Use {@link scryptVerifySecret} to check a presented
 * secret against it. The salt makes two keys with the same secret hash differently, and
 * the embedded params let an old key verify even after the cost is raised later.
 *
 * This is the scrypt reconciliation of the legacy SHA-256 {@link hashApiKey}: new keys
 * (011d) use THIS; {@link hashApiKey} is retained only for the existing deterministic
 * live-smoke scaffold + any 003e caller that has not migrated (see its doc).
 */
export function scryptHashSecret(secret: string): string {
	const salt = randomBytes(16);
	const { N, r, p, keyLen } = SCRYPT_PARAMS;
	const hash = scryptSync(secret, salt, keyLen, { N, r, p });
	const saltB64 = salt.toString("base64url");
	const hashB64 = hash.toString("base64url");
	return `${SCRYPT_HASH_SCHEME}$${N}$${r}$${p}$${saltB64}$${hashB64}`;
}

/**
 * Verify a presented secret against a stored {@link scryptHashSecret} string (d-AC-1).
 *
 * Parses the embedded salt + cost params, recomputes the scrypt hash of the presented
 * secret under THOSE params, and compares with {@link timingSafeEqual} so the check is
 * constant-time (no early-exit timing oracle on the secret). Returns `false` — never
 * throws — on any malformed/non-scrypt stored string (fail-closed): a bad record can
 * never accidentally authenticate. The recompute uses the recorded N/r/p, so a key
 * hashed under an older cost still verifies after {@link SCRYPT_PARAMS} is raised.
 */
export function scryptVerifySecret(secret: string, stored: string): boolean {
	const parts = stored.split("$");
	if (parts.length !== 6 || parts[0] !== SCRYPT_HASH_SCHEME) return false;
	const N = Number(parts[1]);
	const r = Number(parts[2]);
	const p = Number(parts[3]);
	if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
	let salt: Buffer;
	let expected: Buffer;
	try {
		salt = Buffer.from(parts[4], "base64url");
		expected = Buffer.from(parts[5], "base64url");
	} catch {
		return false;
	}
	if (salt.length === 0 || expected.length === 0) return false;
	let actual: Buffer;
	try {
		actual = scryptSync(secret, salt, expected.length, { N, r, p });
	} catch {
		// scrypt rejects out-of-range cost params → treat as a non-verifying record.
		return false;
	}
	if (actual.length !== expected.length) return false;
	return timingSafeEqual(actual, expected);
}

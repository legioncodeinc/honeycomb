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
 *                         UPDATE-or-INSERT by `id`. Holds ONLY `key_hash` (SHA-256
 *                         hex) — NEVER a plaintext key column. Revoke by advancing
 *                         `revoked` (BIGINT 0→1); the row is retained for audit,
 *                         never deleted in place (e-AC-2/e-AC-3).
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

import { createHash } from "node:crypto";
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
 * `api_keys` — hashed, revocable credentials (FR-3). UPDATE-or-INSERT by `id`.
 *
 * SECURITY: `key_hash` is the ONLY credential column (SHA-256 hex, 64 chars).
 * There is intentionally NO `key`, `secret`, `token`, or `plaintext` column.
 * See {@link hashApiKey} to compute the hash before writing.
 *
 * `permissions` stores a JSON array of explicit permission strings (default '[]').
 * `connector`, `harness`, `agent` name the binding (empty when not bound).
 * `revoked` is BIGINT 0 (live) / 1 (revoked) — advance to revoke, never DELETE.
 * `last_used_at` accepts the UPDATE-coalescing trade-off for rare concurrent touch.
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
		pattern: "update-or-insert",
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
 * Build the revocation SQL for an API key (e-AC-3). Sets `revoked = 1` by key
 * `id`. The row is RETAINED for audit — this is a status advance, not a DELETE.
 * Both identifiers route through `sqlIdent`; the id value routes through
 * `sLiteral` (SQL-safety floor, PRD-002b).
 */
export function buildRevokeApiKeySql(id: string): string {
	const tbl = sqlIdent("api_keys");
	const idCol = sqlIdent("id");
	const revokedCol = sqlIdent("revoked");
	return `UPDATE "${tbl}" SET ${revokedCol} = ${KEY_REVOKED} WHERE ${idCol} = ${sLiteral(id)}`;
}

/**
 * PRD-010 — Routing-decision telemetry catalog table (`routing_history`).
 *
 * The single `USING deeplake` table that records the model-provider router's
 * routing + fallback decisions (010c c-AC-6 / 010d d-AC-2/d-AC-5). One row per
 * routing DECISION (one serving attempt-sequence for one request). Written ONLY
 * by the daemon's inference router through the PRD-002d write primitives +
 * the PRD-002c heal engine — never a hand-rolled `ALTER`. The
 * `runtime/inference/history-store.ts` `RoutingHistoryStore` owns the
 * append/read lifecycle; this module owns the column-definition array the
 * create path and the heal pass both iterate.
 *
 * ── REDACTION BY CONSTRUCTION — the central security thesis (D-7) ────────────
 * The `event` JSONB column carries the routing decision: the serving target, the
 * full attempt sequence (target ids + outcomes + HTTP-like status codes), the
 * decision mode, and the gate results. It MUST NEVER contain:
 *   - a secret value or a resolved API key (only the `${SECRET_REF}` *reference*
 *     ever exists in config, and even that does not belong in telemetry);
 *   - a request body or a response body (the prompt / completion text);
 *   - any provider error payload that could echo a credential.
 * This is enforced BY CONSTRUCTION at write time, not by a read-time filter: the
 * `RoutingHistoryStore.record` writer accepts only a typed `RedactedRoutingEvent`
 * whose shape makes a secret/body unrepresentable (see
 * `runtime/inference/contracts.ts`). A read-time scrub would be a single forgotten
 * `SELECT *` away from leaking; making the on-disk row redacted by construction is
 * the invariant 010c c-AC-6 / 010d d-AC-5 and the security audit both assert
 * (no secret value, no request body ever lands on disk).
 *
 * ── Scope (D-7 / CONVENTIONS §3) ────────────────────────────────────────────
 * `scope: "none"`. Like `memory_jobs`, the router is a daemon-internal
 * control-plane concern, NOT an agent-recall engine table. Org and workspace
 * isolation come from the storage partition layer (the `QueryScope` the daemon
 * passes to `storage.query`) — so the row carries neither the
 * `agent_id`/`visibility` engine pair nor relies on tenancy columns for
 * isolation. The `org_id` / `workspace_id` columns it DOES carry are denormalized
 * telemetry context for the `recent(scope, limit)` read filter and human triage,
 * not the isolation mechanism; the partition already isolates the rows.
 *
 * ── Write pattern (PRD-002d) ────────────────────────────────────────────────
 * `pattern: "append-only"`. A routing decision is an IMMUTABLE event — it is
 * never edited, only appended and later read back newest-first. Reads
 * (`recent`) are a scoped `SELECT … ORDER BY created_at DESC LIMIT n`; there is
 * no current-state resolution and no version column, exactly like the other
 * append-only telemetry tables (sessions, memory_history). The deterministic
 * `id` (sha256 of request_id + a discriminator) keeps a re-emitted event from
 * doubling under a retry.
 *
 * Every `NOT NULL` column carries a `DEFAULT` so the heal pass's
 * `ALTER TABLE ADD COLUMN … NOT NULL` succeeds on a populated table (PRD-002c).
 * `event` is JSONB (the sanctioned schemaless-payload use per CONVENTIONS §5) and
 * nullable, so NULL is its implicit default.
 */

import { type CatalogTable, defineGroup } from "./types.js";

/** The bare `routing_history` table name, exported so writers never re-spell it. */
export const ROUTING_HISTORY_TABLE = "routing_history" as const;

/**
 * `routing_history` — the append-only routing-decision telemetry table (D-7).
 * Column order: identity → scope context → request → workload → time → event.
 *
 * - `id`            deterministic per-decision key (sha256 of request_id + a
 *                   discriminator). The append-only dedup key.
 * - `org_id` /
 *   `workspace_id`  denormalized tenancy context for the `recent` read filter
 *                   and triage (NOT the isolation mechanism — the partition is).
 * - `request_id`    the inference request this decision served.
 * - `workload`      the workload the request routed under (e.g. `memory_extraction`).
 * - `created_at`    ISO-8601 decision timestamp; the `recent` read orders by it.
 * - `event`         JSONB REDACTED routing decision (serving target, attempt
 *                   sequence with status codes, decision mode, gate results).
 *                   Nullable JSONB. NEVER a secret value, a resolved key, or a
 *                   request/response body — redaction is by construction at the
 *                   `RoutingHistoryStore.record` boundary (D-7 / c-AC-6 / d-AC-5).
 */
export const ROUTING_HISTORY_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "org_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "workspace_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "request_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "workload", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "event", sql: "JSONB" },
]);

/** The 010 routing-history group — spread into `CATALOG` by the barrel. */
export const ROUTING_HISTORY_TABLES: readonly CatalogTable[] = defineGroup([
	{
		name: ROUTING_HISTORY_TABLE,
		columns: ROUTING_HISTORY_COLUMNS,
		pattern: "append-only",
		embeddingColumns: [],
		scope: "none",
	},
]);

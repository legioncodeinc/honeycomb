/**
 * PRD-003b — Knowledge Graph / Ontology Tables (Wave 2, IMPLEMENTED).
 *
 * The seven ontology tables that hold the entity-and-claim graph the daemon
 * builds over memory. All are `USING deeplake` tables written only by the daemon
 * (the graph persistence stage is PRD-008, the traversal reader is PRD-007 — both
 * OUT of scope here), scoped by `agent_id` + `visibility` (D-2: engine tables;
 * org/workspace isolation comes from the storage partition layer, not columns —
 * index AC-3). The legacy `relations` table is intentionally EXCLUDED (FR-8);
 * every audited link now lives in `entity_dependencies`.
 *
 * Pattern assignment (PRD-002d / impl-notes):
 *   - `entity_attributes`        → version-bumped. Claim edits APPEND a new
 *                                  version (status='active') and mark the prior
 *                                  `status='superseded'` — never an in-place
 *                                  mutate (b-AC-1/b-AC-2/b-AC-6). Read the highest
 *                                  active version per `claim_key`.
 *   - `epistemic_assertions`     → version-bumped. Append-only version lineage of
 *                                  who claimed/believed/observed/etc (FR-6).
 *   - `entities`, `entity_aspects` → update-or-insert by logical identity (FR-1/
 *                                  FR-4): one row per entity / per aspect.
 *   - `entity_dependencies`      → append-only audited edges (FR-5 / b-AC-3): each
 *                                  edge is an immutable record; a `related_to`
 *                                  edge REQUIRES a non-empty `reason`.
 *   - `memory_entity_mentions`   → append-only join (FR-4 / b-AC-5): memory_id ↔
 *                                  entity_id with a mention count/score.
 *   - `ontology_proposals`       → append-only control plane (FR-7 / b-AC-4):
 *                                  status advances by a NEW row, never a mutate.
 *
 * Supersession (b-AC-2/b-AC-6): the version-bump INSERT is emitted by the PRD-002d
 * `appendVersionBumped` primitive; this module supplies the catalog-level SQL the
 * pattern emits AROUND it — {@link buildSupersedeMarkSql} (mark the prior row
 * superseded) and {@link buildHighestActiveVersionSql} (the "current claim" read).
 * The actual writer is PRD-008 (out of scope); these helpers + their tests prove
 * the SQL the supersession pattern emits against the fake transport.
 *
 * `entity_dependencies` edge discipline (b-AC-3 / FR-5): {@link RELATED_TO} edges
 * are loose links, so {@link assertDependencyReason} REJECTS an empty `reason` for
 * them — a weak link with no rationale is not auditable. The writer is PRD-008;
 * this validator is the catalog-level enforcement point, tested here.
 */

import { embeddingColumn } from "../vector.js";
import { sqlIdent, sLiteral } from "../sql.js";
import { type CatalogTable, defineGroup } from "./types.js";

/** Claim lifecycle states for `entity_attributes.status` (b-AC-1/b-AC-2/b-AC-6). */
export const CLAIM_ACTIVE = "active" as const;
export const CLAIM_SUPERSEDED = "superseded" as const;

/** The loose dependency edge type that requires a `reason` (FR-5 / b-AC-3). */
export const RELATED_TO = "related_to" as const;

/**
 * `entities` — canonical graph nodes (FR-1). UPDATE-or-INSERT by `id` (the entity
 * identity). Carries `name`/`type`, optional `source_id`/`source_type`
 * provenance, and the engine scope columns. No embedding column (entity recall
 * rides the attribute/aspect text; an entity-level embedding is deferred).
 *
 * Scope (D-2): `agent_id` (default `'default'`) + `visibility` (default
 * `'global'`); NO `org_id`/`workspace_id` — engine table.
 */
export const ENTITIES_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "name", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "type", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "source_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "source_type", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "agent_id", sql: "TEXT NOT NULL DEFAULT 'default'" },
	{ name: "visibility", sql: "TEXT NOT NULL DEFAULT 'global'" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "updated_at", sql: "TEXT NOT NULL DEFAULT ''" },
]);

/**
 * `entity_aspects` — weighted dimensions of an entity (FR-4). UPDATE-or-INSERT by
 * `id` (the aspect identity). Each aspect is a named, weighted facet of its
 * `entity_id` (e.g. `role`, `expertise`) that attributes attach to via
 * `aspect_id`.
 */
export const ENTITY_ASPECTS_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "entity_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "name", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "weight", sql: "FLOAT4 NOT NULL DEFAULT 1.0" },
	{ name: "agent_id", sql: "TEXT NOT NULL DEFAULT 'default'" },
	{ name: "visibility", sql: "TEXT NOT NULL DEFAULT 'global'" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "updated_at", sql: "TEXT NOT NULL DEFAULT ''" },
]);

/**
 * `entity_attributes` — the claim table (FR-2 / b-AC-1). VERSION-BUMPED: a claim
 * edit INSERTs `version` N+1 with `status='active'` and marks the prior row
 * `status='superseded'` + `superseded_by` = the new id (FR-3 / b-AC-2). The
 * reader takes the highest `version` with `status='active'` per `claim_key`
 * (b-AC-6).
 *
 * Lineage columns: `claim_key` is the stable logical identity a version chain
 * shares; `group_key` clusters related claims; `version` is the BIGINT lineage
 * counter (default `1`); `superseded_by` points the prior row at its successor.
 * `content_embedding` is the nullable 768-dim `FLOAT4[]` so a claim is
 * semantically recall-able (index AC-4).
 */
export const ENTITY_ATTRIBUTES_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "aspect_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "agent_id", sql: "TEXT NOT NULL DEFAULT 'default'" },
	{ name: "memory_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "kind", sql: "TEXT NOT NULL DEFAULT 'attribute'" },
	{ name: "content", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "confidence", sql: "FLOAT4 NOT NULL DEFAULT 1.0" },
	{ name: "importance", sql: "FLOAT4 NOT NULL DEFAULT 0.5" },
	{ name: "status", sql: "TEXT NOT NULL DEFAULT 'active'" },
	{ name: "superseded_by", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "claim_key", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "group_key", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "version", sql: "BIGINT NOT NULL DEFAULT 1" },
	{ name: "visibility", sql: "TEXT NOT NULL DEFAULT 'global'" },
	embeddingColumn("content_embedding"),
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "updated_at", sql: "TEXT NOT NULL DEFAULT ''" },
]);

/**
 * `entity_dependencies` — audited typed edges (FR-5 / b-AC-3). APPEND-ONLY: every
 * edge is an immutable record carrying `source_entity_id` → `target_entity_id`,
 * the edge `type`, a `strength` and `confidence`, and a `reason`. A loose
 * {@link RELATED_TO} edge REQUIRES a non-empty `reason` — enforced by the writer
 * via {@link assertDependencyReason} so weak links stay auditable.
 *
 * Append-only (not update-or-insert): an edge is a fact about a point in time;
 * re-asserting a link appends a fresh, separately-auditable row rather than
 * silently overwriting the prior rationale.
 */
export const ENTITY_DEPENDENCIES_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "source_entity_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "target_entity_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "type", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "strength", sql: "FLOAT4 NOT NULL DEFAULT 0.0" },
	{ name: "confidence", sql: "FLOAT4 NOT NULL DEFAULT 1.0" },
	{ name: "reason", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "agent_id", sql: "TEXT NOT NULL DEFAULT 'default'" },
	{ name: "visibility", sql: "TEXT NOT NULL DEFAULT 'global'" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
]);

/**
 * `memory_entity_mentions` — the memory↔entity join (FR-4 / b-AC-5). APPEND-ONLY:
 * each row records that `memory_id` mentions `entity_id`, with a `mention_count`
 * and a `score`. Scope is `agent` (the mention is an engine-level observation);
 * the row is reachable transitively through either side of the join.
 */
export const MEMORY_ENTITY_MENTIONS_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "memory_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "entity_id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "mention_count", sql: "BIGINT NOT NULL DEFAULT 1" },
	{ name: "score", sql: "FLOAT4 NOT NULL DEFAULT 0.0" },
	{ name: "agent_id", sql: "TEXT NOT NULL DEFAULT 'default'" },
	{ name: "visibility", sql: "TEXT NOT NULL DEFAULT 'global'" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
]);

/**
 * `epistemic_assertions` — who asserted what, with what stance (FR-6). VERSION-
 * BUMPED append-only lineage: an assertion records a `stance` (one of
 * {@link EPISTEMIC_STANCES}) over a `subject`/`predicate`/`object`, with
 * `provenance` and a `version` so a revised belief appends rather than mutates.
 * `content_embedding` is nullable 768-dim `FLOAT4[]` for assertion-level recall.
 */
export const EPISTEMIC_ASSERTIONS_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "agent_id", sql: "TEXT NOT NULL DEFAULT 'default'" },
	{ name: "stance", sql: "TEXT NOT NULL DEFAULT 'claimed'" },
	{ name: "subject", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "predicate", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "object", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "confidence", sql: "FLOAT4 NOT NULL DEFAULT 1.0" },
	{ name: "provenance", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "claim_key", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "status", sql: "TEXT NOT NULL DEFAULT 'active'" },
	{ name: "version", sql: "BIGINT NOT NULL DEFAULT 1" },
	{ name: "visibility", sql: "TEXT NOT NULL DEFAULT 'global'" },
	embeddingColumn("content_embedding"),
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
]);

/** The stances an `epistemic_assertions` row may record (FR-6). */
export const EPISTEMIC_STANCES = Object.freeze([
	"claimed",
	"believed",
	"observed",
	"decided",
	"preferred",
	"denied",
	"questioned",
] as const);

/**
 * `ontology_proposals` — the audited control plane (FR-7 / b-AC-4). APPEND-ONLY:
 * every proposed graph change is a row carrying the `operation`, its `status`, a
 * genuinely-schemaless JSONB `payload` (the proposed change body), a `confidence`,
 * a `rationale`, the `evidence`, and a `risk_note`. Status advances by INSERTing a
 * NEW row, never mutating — the control plane stays fully reviewable.
 *
 * `payload` is JSONB BY DESIGN (the proposed change shape varies per operation —
 * a genuinely schemaless payload, the sanctioned JSONB use per CONVENTIONS §5).
 * Nullable, so NULL is its implicit default (no DEFAULT needed).
 */
export const ONTOLOGY_PROPOSALS_COLUMNS = Object.freeze([
	{ name: "id", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "operation", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "status", sql: "TEXT NOT NULL DEFAULT 'proposed'" },
	{ name: "payload", sql: "JSONB" },
	{ name: "confidence", sql: "FLOAT4 NOT NULL DEFAULT 1.0" },
	{ name: "rationale", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "evidence", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "risk_note", sql: "TEXT NOT NULL DEFAULT ''" },
	{ name: "agent_id", sql: "TEXT NOT NULL DEFAULT 'default'" },
	{ name: "visibility", sql: "TEXT NOT NULL DEFAULT 'global'" },
	{ name: "created_at", sql: "TEXT NOT NULL DEFAULT ''" },
]);

/** The 003b knowledge-graph group — spread into `CATALOG` by the barrel. */
export const KNOWLEDGE_GRAPH_TABLES: readonly CatalogTable[] = defineGroup([
	{
		name: "entities",
		columns: ENTITIES_COLUMNS,
		pattern: "update-or-insert",
		embeddingColumns: [],
		scope: "agent",
	},
	{
		name: "entity_aspects",
		columns: ENTITY_ASPECTS_COLUMNS,
		pattern: "update-or-insert",
		embeddingColumns: [],
		scope: "agent",
	},
	{
		name: "entity_attributes",
		columns: ENTITY_ATTRIBUTES_COLUMNS,
		pattern: "version-bumped",
		embeddingColumns: ["content_embedding"],
		scope: "agent",
	},
	{
		name: "entity_dependencies",
		columns: ENTITY_DEPENDENCIES_COLUMNS,
		pattern: "append-only",
		embeddingColumns: [],
		scope: "agent",
	},
	{
		name: "memory_entity_mentions",
		columns: MEMORY_ENTITY_MENTIONS_COLUMNS,
		pattern: "append-only",
		embeddingColumns: [],
		scope: "agent",
	},
	{
		name: "epistemic_assertions",
		columns: EPISTEMIC_ASSERTIONS_COLUMNS,
		pattern: "version-bumped",
		embeddingColumns: ["content_embedding"],
		scope: "agent",
	},
	{
		name: "ontology_proposals",
		columns: ONTOLOGY_PROPOSALS_COLUMNS,
		pattern: "append-only",
		embeddingColumns: [],
		scope: "agent",
	},
]);

/**
 * Build the SQL that marks the PRIOR claim version superseded (b-AC-2 / FR-3).
 *
 * This is the second half of the supersession pattern: the NEW version row is
 * INSERTed by the PRD-002d `appendVersionBumped` primitive (status='active'); this
 * statement marks the row the new version replaces by setting `status =
 * 'superseded'` and `superseded_by` = the new row's id, leaving the row otherwise
 * INTACT (no content mutate). The prior row is addressed by its `id` so exactly
 * one lineage row transitions.
 *
 * Every value routes through `sLiteral` and every identifier through `sqlIdent`
 * (SQL-safety floor, PRD-002b) — no value is hand-quoted. The writer is PRD-008;
 * this builder is the catalog-level definition of the SQL the pattern emits.
 */
export function buildSupersedeMarkSql(priorId: string, newId: string): string {
	const tbl = sqlIdent("entity_attributes");
	const statusCol = sqlIdent("status");
	const supersededByCol = sqlIdent("superseded_by");
	const idCol = sqlIdent("id");
	return (
		`UPDATE "${tbl}" SET ${statusCol} = ${sLiteral(CLAIM_SUPERSEDED)}, ` +
		`${supersededByCol} = ${sLiteral(newId)} ` +
		`WHERE ${idCol} = ${sLiteral(priorId)}`
	);
}

/**
 * Build the "current claim" read (b-AC-6 / FR-3): the highest `version` with
 * `status='active'` for a `claim_key`. This is the reader convention paired with
 * the version-bumped supersession: even though a superseded row remains in the
 * table, the active highest-version row is the one a reader resolves.
 *
 * `ORDER BY version DESC LIMIT 1` over the `status='active'` rows returns exactly
 * the current claim. The `claim_key` routes through `sLiteral`; identifiers
 * through `sqlIdent`.
 */
export function buildHighestActiveVersionSql(claimKey: string): string {
	const tbl = sqlIdent("entity_attributes");
	const claimKeyCol = sqlIdent("claim_key");
	const statusCol = sqlIdent("status");
	return (
		`SELECT * FROM "${tbl}" ` +
		`WHERE ${claimKeyCol} = ${sLiteral(claimKey)} ` +
		`AND ${statusCol} = ${sLiteral(CLAIM_ACTIVE)} ` +
		"ORDER BY version DESC LIMIT 1"
	);
}

/** Structured rejection for a loose edge with no rationale (FR-5 / b-AC-3). */
export class DependencyReasonError extends Error {
	readonly type: string;
	constructor(type: string) {
		super(`entity_dependencies: a "${type}" edge requires a non-empty reason`);
		this.name = "DependencyReasonError";
		this.type = type;
	}
}

/**
 * Validate a dependency edge's `reason` BEFORE any write (FR-5 / b-AC-3). A loose
 * {@link RELATED_TO} edge with an empty (or whitespace-only) `reason` is REJECTED
 * — a weak link with no rationale is not auditable. Stronger typed edges are
 * permitted without a reason. Throws {@link DependencyReasonError} so the bad edge
 * never reaches the INSERT; the writer (PRD-008) calls this first. Pure.
 */
export function assertDependencyReason(type: string, reason: string): void {
	if (type === RELATED_TO && reason.trim() === "") {
		throw new DependencyReasonError(type);
	}
}

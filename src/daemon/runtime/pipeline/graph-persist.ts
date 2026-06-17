/**
 * Graph-persistence stage — PRD-006d (Wave 2, `deeplake-dataset-worker-bee`).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * d-AC-1 Entity upsert by canonical name; relationships by (source,target,type);
 *         mentions INSERT-OR-IGNORE by (memory_id, entity canonical name).
 * d-AC-2 Same memory reprocessed → no duplicate entities/relationships/mentions.
 * d-AC-3 Graph persistence FAILS → warning logged, handler returns normally
 *         (NON-FATAL). Committed facts are untouched.
 * d-AC-4 `config.graph.enabled` AND `config.graph.extractionWritesEnabled` both
 *         must be true; either off → no rows written.
 * d-AC-5 Every graph row carries org/workspace/agent scope.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Reaching storage (CONVENTIONS §3):
 *   - Inject `StorageQuery` + `QueryScope` as factory deps.
 *   - All writes via `writes.ts` primitives (`appendVersionBumped`,
 *     `appendOnlyInsert`, `buildInsert`) — every one heal-aware via `withHeal`.
 *   - Every value through `val.str()` / `val.text()` / `val.num()` (guarded path).
 *   - Every identifier through `sqlIdent`.
 *   - `healTargetFor(<table>)` from `catalog/index.js` supplies the base columns.
 *
 * Non-fatal is the load-bearing rule (index AC-5 / d-AC-3): unlike the other
 * stages a graph failure must NOT fail the job — catch, log, return.
 *
 * ── Why DETERMINISTIC-ID APPEND-ONLY + POLL-CONVERGENT READS (live-determinism) ──
 * The first cut of this stage used `updateOrInsertByKey` for entities (an in-place
 * UPDATE) and a SINGLE-SHOT `SELECT … LIMIT 1` probe for dependency/mention dedup.
 * Both pass the deterministic fake transport but FAIL against the real DeepLake
 * backend, for the SAME reason the `memory_jobs` queue was rewritten append-only
 * (see `services/job-queue.ts`): this backend round-robins a read across segments
 * of differing freshness that flap NON-MONOTONICALLY. A single by-key probe can
 * land on a STALE segment that misses a just-written row → the code reads "absent"
 * → it INSERTs a DUPLICATE (live evidence: a first pass that wrote 3 canonical
 * entities read back 4 rows). And an in-place `UPDATE` can be coalesced/dropped.
 *
 * The cure is the queue's proven shape, applied per table:
 *   - ENTITIES are append-only VERSION-BUMPED by a DETERMINISTIC id (sha256 of
 *     agent + canonical name). The entity's current state is its highest-version
 *     append; re-processing the same triple resolves the SAME id, the dedup probe
 *     (below) finds it, and NO new version is appended (d-AC-2). The catalog records
 *     `entities` as update-or-insert with NO `version` column (PRD-003b); rather than
 *     edit that shared file (another wave owns it), this stage composes a versioned
 *     HealTarget from the single-sourced `ENTITIES_COLUMNS` PLUS a local `version`
 *     ColumnDef — the heal engine `ALTER … ADD COLUMN version` lazily on first write,
 *     exactly as the controlled-writes stage does for `memories`.
 *   - DEPENDENCIES + MENTIONS stay APPEND-ONLY (their catalog pattern); the
 *     idempotency key is the DETERMINISTIC id, and the insert is heal-aware
 *     (`appendOnlyInsert` → `withHeal`) so the table is created lazily on the first
 *     write — the prior raw `storage.query` insert was NOT heal-aware, so the deps
 *     table was never created and zero edges ever persisted.
 *   - Every dedup probe is POLL-CONVERGENT: a by-id `SELECT … LIMIT 1` re-read a
 *     few times, taking PRESENT as soon as any poll sees the row. A scan can MISS a
 *     row on a stale segment but never INVENTS one, so polling can only turn a false
 *     "absent" into the true "present" — it converges toward the durable truth. No
 *     `sleep` is the mechanism; the natural per-request round-trip supplies spacing.
 */

import crypto from "node:crypto";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { healTargetFor } from "../../storage/catalog/index.js";
import type { HealTarget } from "../../storage/heal.js";
import { isOk } from "../../storage/result.js";
import type { ColumnDef } from "../../storage/schema.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import {
	appendOnlyInsert,
	appendVersionBumped,
	val,
} from "../../storage/writes.js";
import type { PipelineConfig } from "./config.js";
import type { EntityTriple } from "./contracts.js";
import type { StageHandler, StageJob } from "./stage-worker.js";

// ── Versioned HealTarget for `entities` (local widening, like controlled-writes) ──

/**
 * The `version` column appended to an `entities` row by the version-bumped upsert.
 * It is NOT in the catalog's `ENTITIES_COLUMNS` (PRD-003b records `entities` as
 * update-or-insert); this stage composes it into the HealTarget so the heal engine
 * adds it lazily on the first version-bumped write. `BIGINT NOT NULL DEFAULT 1` so
 * the column heals onto a populated table and the first appended version of an
 * entity is 1 (mirrors `memory_jobs.version` and `memories.version`).
 */
export const ENTITIES_VERSION_COLUMN: ColumnDef = Object.freeze({
	name: "version",
	sql: "BIGINT NOT NULL DEFAULT 1",
});

/** Build the version-bumped `entities` HealTarget from the single-sourced base columns. */
function entitiesVersionedTarget(): HealTarget {
	const base = healTargetFor("entities");
	return { table: base.table, columns: [...base.columns, ENTITIES_VERSION_COLUMN] };
}

/**
 * How many times a dedup probe re-reads the by-id row before concluding ABSENT.
 * This backend serves the read from segments of differing freshness, so a single
 * read can land on a STALE segment that misses a just-written row. Because a scan
 * can only UNDER-report presence (miss a row), never INVENT one, polling a few
 * times and taking PRESENT on the first hit converges toward the durable truth —
 * a just-written row is reliably seen on the second pass (idempotency / d-AC-2). On
 * the deterministic fake the first poll is already authoritative, so a "present"
 * row short-circuits immediately — this is a live-only cost.
 */
const PROBE_POLLS = 8;

// ── Canonical name normalisation ──────────────────────────────────────────────

/**
 * Normalise an entity name so the same entity is not duplicated across memories
 * (d-AC-1 / FR-2). Trim whitespace + collapse to lowercase. The canonical form
 * is the upsert key on the `entities` table.
 */
function canonicaliseName(raw: string): string {
	return raw.trim().toLowerCase();
}

/**
 * Derive a stable, collision-resistant id for an entity from its canonical name
 * + agent scope. Prefixed with `ent_` so it is human-readable in logs.
 * Pure — the same inputs always produce the same id (idempotency / d-AC-2).
 */
function entityId(agentId: string, canonicalName: string): string {
	const hash = crypto.createHash("sha256").update(`${agentId}:${canonicalName}`).digest("hex").slice(0, 24);
	return `ent_${hash}`;
}

/**
 * Derive a stable id for an `entity_dependencies` edge from its natural key
 * (source entity id, target entity id, relationship type). Prefixed with `dep_`.
 */
function dependencyId(sourceId: string, targetId: string, relType: string): string {
	const hash = crypto.createHash("sha256").update(`${sourceId}:${targetId}:${relType}`).digest("hex").slice(0, 24);
	return `dep_${hash}`;
}

/**
 * Derive a stable id for a `memory_entity_mentions` row from its natural key
 * (memory id + entity id). Prefixed with `mem_`.
 */
function mentionId(memoryId: string, entityId_: string): string {
	const hash = crypto.createHash("sha256").update(`${memoryId}:${entityId_}`).digest("hex").slice(0, 24);
	return `mem_${hash}`;
}

// ── ISO timestamp ─────────────────────────────────────────────────────────────

function nowIso(): string {
	return new Date().toISOString();
}

// ── Poll-convergent presence probe ────────────────────────────────────────────

/**
 * Is a row with this deterministic `id` already present in `table`? POLL-CONVERGENT
 * (the live-determinism mechanism): re-read a by-id `SELECT id … LIMIT 1` up to
 * {@link PROBE_POLLS} times and return `true` the instant ANY poll sees the row.
 *
 * Why polling instead of a single read: this backend serves a read from segments of
 * differing freshness, so one read can land on a STALE segment and MISS a row that
 * is already durably written — reporting a false "absent" that would drive a
 * DUPLICATE insert on the next pass (the live idempotency break). A scan can only
 * miss a row, never invent one, so taking PRESENT on the first hit across a few
 * polls can only ever turn a false-absent into the true-present — it converges to
 * the durable truth and never fabricates a hit.
 *
 * A non-`ok` result (e.g. a not-yet-created table on the very first write) is NOT
 * treated as "present" — it means the table/row does not exist yet, so the caller
 * proceeds to the heal-aware insert. Returns `false` only after every poll came
 * back empty/non-ok.
 */
async function isPresentById(storage: StorageQuery, table: string, id: string, scope: QueryScope): Promise<boolean> {
	const tbl = sqlIdent(table);
	const idCol = sqlIdent("id");
	const sql = `SELECT ${idCol} FROM "${tbl}" WHERE ${idCol} = ${sLiteral(id)} LIMIT 1`;
	for (let poll = 0; poll < PROBE_POLLS; poll++) {
		const res = await storage.query(sql, scope);
		if (isOk(res) && res.rows.length > 0) return true;
	}
	return false;
}

// ── Write helpers ─────────────────────────────────────────────────────────────

/**
 * Upsert one entity by canonical name (FR-2 / d-AC-1), live-deterministically.
 *
 * The entity `id` is DETERMINISTIC from the canonical name + agent, so a re-run of
 * the same triple resolves the SAME id (d-AC-2). Idempotency = a POLL-CONVERGENT
 * dedup probe by that id: if a version already exists, this is a no-op (no new row).
 * Otherwise APPEND a version-bumped row through the heal-aware `appendVersionBumped`
 * primitive — the entity's current state is its highest-version append, which is the
 * pattern that survives this backend's UPDATE-coalescing + segment-freshness flap
 * (an in-place UPDATE does not — see the module header).
 */
async function upsertEntity(
	storage: StorageQuery,
	scope: QueryScope,
	agentId: string,
	canonicalName: string,
	rawName: string,
	relType: string,
): Promise<string> {
	const target = entitiesVersionedTarget();
	const id = entityId(agentId, canonicalName);

	// Idempotency probe (d-AC-2): a just-written entity is reliably seen here on the
	// second pass via poll-convergence, so the same triple appends NO new version.
	if (await isPresentById(storage, target.table, id, scope)) {
		void rawName;
		return id;
	}

	const now = nowIso();
	await appendVersionBumped(storage, target, scope, {
		keyColumn: "id",
		keyValue: id,
		row: [
			["id", val.str(id)],
			["name", val.str(canonicalName)],
			["type", val.str(relType)],
			["source_id", val.str("")],
			["source_type", val.str("extraction")],
			["agent_id", val.str(agentId)],
			["visibility", val.str("global")],
			["created_at", val.str(now)],
			["updated_at", val.str(now)],
		],
	});

	// Suppress the unused rawName parameter — it is accepted for future use
	// (e.g. storing the original casing in a display_name column) but the
	// current schema exposes only the canonical name column.
	void rawName;

	return id;
}

/**
 * Insert-or-ignore a relationship edge by (source entity id, target entity id,
 * type) (FR-3 / d-AC-1). `entity_dependencies` is APPEND-ONLY (its catalog
 * pattern) and DeepLake has no composite unique constraint, so the deterministic
 * `id` (encoding the full natural key) IS the dedup key: a POLL-CONVERGENT probe by
 * id finds a prior edge on the second pass (d-AC-2) and the insert is skipped.
 *
 * The insert goes through the heal-aware `appendOnlyInsert` (NOT a raw
 * `storage.query`), so a missing `entity_dependencies` table is CREATED lazily on
 * the first write — the prior raw insert was not heal-aware and silently never
 * created the table, so no edge ever persisted live.
 */
async function upsertDependency(
	storage: StorageQuery,
	scope: QueryScope,
	agentId: string,
	sourceEntityId: string,
	targetEntityId: string,
	relType: string,
): Promise<void> {
	const target = healTargetFor("entity_dependencies");
	const id = dependencyId(sourceEntityId, targetEntityId, relType);

	// Poll-convergent dedup probe by the deterministic id (encodes the full key).
	if (await isPresentById(storage, target.table, id, scope)) {
		return; // already present — idempotent no-op (d-AC-2).
	}

	const now = nowIso();
	await appendOnlyInsert(storage, target, scope, [
		["id", val.str(id)],
		["source_entity_id", val.str(sourceEntityId)],
		["target_entity_id", val.str(targetEntityId)],
		["type", val.str(relType)],
		["strength", val.num(1.0)],
		["confidence", val.num(1.0)],
		["reason", val.text("")],
		["agent_id", val.str(agentId)],
		["visibility", val.str("global")],
		["created_at", val.str(now)],
	]);
}

/**
 * INSERT-OR-IGNORE a memory↔entity mention link (FR-4 / D-6 / d-AC-1).
 * Idempotency key: `memory_id + entity id` → deterministic `id` (D-6 / d-AC-2).
 * POLL-CONVERGENT probe by id; heal-aware `appendOnlyInsert` only when absent so
 * the table is created lazily on the first write.
 */
async function insertMentionIfAbsent(
	storage: StorageQuery,
	scope: QueryScope,
	agentId: string,
	memoryId: string,
	entityId_: string,
): Promise<void> {
	const target = healTargetFor("memory_entity_mentions");
	const id = mentionId(memoryId, entityId_);

	// Poll-convergent dedup probe by the deterministic id (encodes memory_id + entity_id).
	if (await isPresentById(storage, target.table, id, scope)) {
		return; // already present — idempotent no-op (d-AC-2).
	}

	const now = nowIso();
	await appendOnlyInsert(storage, target, scope, [
		["id", val.str(id)],
		["memory_id", val.str(memoryId)],
		["entity_id", val.str(entityId_)],
		["mention_count", val.num(1)],
		["score", val.num(0.0)],
		["agent_id", val.str(agentId)],
		["visibility", val.str("global")],
		["created_at", val.str(now)],
	]);
}

// ── Payload extraction ────────────────────────────────────────────────────────

/** The payload shape a `memory_graph_persist` job carries. */
interface GraphPersistPayload {
	/** The committed memory id (from 006c). */
	readonly memoryId?: unknown;
	/** The entity triples extracted in 006a, forwarded to this stage. */
	readonly entities?: unknown;
}

function readMemoryId(payload: Record<string, unknown>): string {
	const id = (payload as GraphPersistPayload).memoryId;
	return typeof id === "string" && id.length > 0 ? id : "";
}

function readEntities(payload: Record<string, unknown>): EntityTriple[] {
	const raw = (payload as GraphPersistPayload).entities;
	if (!Array.isArray(raw)) return [];
	const out: EntityTriple[] = [];
	for (const item of raw) {
		if (
			item !== null &&
			typeof item === "object" &&
			typeof (item as Record<string, unknown>).source === "string" &&
			typeof (item as Record<string, unknown>).relationship === "string" &&
			typeof (item as Record<string, unknown>).target === "string"
		) {
			out.push(item as EntityTriple);
		}
	}
	return out;
}

// ── Logger seam ───────────────────────────────────────────────────────────────

/** A minimal structured-log sink for graph-persistence events. */
export interface GraphPersistLogger {
	warn(name: string, fields?: Record<string, unknown>): void;
	info?(name: string, fields?: Record<string, unknown>): void;
}

/** Fallback: emit warnings to stderr. */
const DEFAULT_LOGGER: GraphPersistLogger = {
	warn(name, fields = {}) {
		const payload = JSON.stringify(fields);
		process.stderr.write(`[graph-persist] WARN ${name} ${payload}\n`);
	},
};

// ── Core graph-persist logic ──────────────────────────────────────────────────

/**
 * Persist one memory's entity triples to the knowledge-graph tables (d-AC-1..5).
 * Called from the stage handler; kept as a named export so unit tests can
 * exercise the logic directly without the handler wrapper (mirrors the extraction
 * stage's `extractFromText` / `createExtractionHandler` split).
 *
 * Behaviour:
 *   - Returns immediately when `graph.enabled` or `graph.extractionWritesEnabled`
 *     is false (d-AC-4).
 *   - Iterates triples: upsert source entity, upsert target entity, upsert
 *     dependency edge, insert-or-ignore mention for source and target (d-AC-1).
 *   - All writes idempotent via deterministic ids + poll-convergent dedup (d-AC-2).
 *   - All rows carry `agent_id` from `scope` (d-AC-5).
 */
export async function persistGraphEntities(
	storage: StorageQuery,
	scope: QueryScope,
	config: PipelineConfig,
	memoryId: string,
	triples: EntityTriple[],
	logger: GraphPersistLogger,
): Promise<void> {
	// d-AC-4: gate — both flags must be on.
	if (!config.graph.enabled || !config.graph.extractionWritesEnabled) {
		logger.info?.("graph_persist.gated_off", { enabled: config.graph.enabled, extractionWritesEnabled: config.graph.extractionWritesEnabled });
		return;
	}

	// Nothing to do when there are no triples or no committed memory id.
	if (triples.length === 0 || memoryId === "") {
		logger.info?.("graph_persist.no_work", { triples: triples.length, memoryId });
		return;
	}

	const agentId = scope.workspace ?? "default";

	for (const triple of triples) {
		const sourceCanonical = canonicaliseName(triple.source);
		const targetCanonical = canonicaliseName(triple.target);
		const relType = triple.relationship.trim().toLowerCase();

		// 1. Upsert source entity.
		const sourceId = await upsertEntity(storage, scope, agentId, sourceCanonical, triple.source, "entity");
		// 2. Upsert target entity.
		const targetId = await upsertEntity(storage, scope, agentId, targetCanonical, triple.target, "entity");
		// 3. Upsert relationship edge.
		await upsertDependency(storage, scope, agentId, sourceId, targetId, relType);
		// 4. Mention links: both the source and target entity are "mentioned" by this memory.
		await insertMentionIfAbsent(storage, scope, agentId, memoryId, sourceId);
		await insertMentionIfAbsent(storage, scope, agentId, memoryId, targetId);
	}

	logger.info?.("graph_persist.done", { memoryId, triples: triples.length });
}

// ── Handler factory ───────────────────────────────────────────────────────────

/**
 * The no-op graph-persistence handler the scaffold routes by default (Wave 1).
 * Writes nothing. {@link createGraphPersistHandler} builds the real handler.
 */
export const noopGraphPersistHandler: StageHandler = async (_job: StageJob): Promise<void> => {
	/* no-op stub — 006d fills createGraphPersistHandler. */
};

/** Deps the graph-persist handler requires (widened from the Wave-1 stub). */
export interface GraphPersistHandlerDeps {
	/** Storage client the handler issues graph writes through. */
	readonly storage: StorageQuery;
	/** Scope (org + workspace) every query must carry. */
	readonly scope: QueryScope;
	/** The resolved pipeline config (graph gate flags). */
	readonly config: PipelineConfig;
	/** Optional structured-log sink for warnings. Defaults to stderr. */
	readonly logger?: GraphPersistLogger;
}

/**
 * Build the graph-persistence handler (d-AC-1..5). The returned handler:
 *   - Is NON-FATAL (d-AC-3): it catches all storage errors, logs a warning, and
 *     RETURNS normally. It never throws. A graph failure must not fail the job or
 *     revert facts written by controlled-writes (006c).
 *   - Gates on `config.graph.{enabled,extractionWritesEnabled}` (d-AC-4).
 *   - Reads `memoryId` + `entities` off the job payload.
 *   - Threads `scope` on every storage call (d-AC-5).
 */
export function createGraphPersistHandler(deps?: GraphPersistHandlerDeps): StageHandler {
	if (!deps) return noopGraphPersistHandler;

	const { storage, scope, config, logger = DEFAULT_LOGGER } = deps;

	return async (job: StageJob): Promise<void> => {
		// d-AC-3: non-fatal — wrap the whole body. A throw here must NEVER escape.
		try {
			const memoryId = readMemoryId(job.payload);
			const triples = readEntities(job.payload);
			await persistGraphEntities(storage, scope, config, memoryId, triples, logger);
		} catch (err: unknown) {
			// d-AC-3: log a warning and return normally — the job is NOT failed.
			const message = err instanceof Error ? err.message : String(err);
			logger.warn("graph_persist.storage_error", {
				jobId: job.id,
				error: message,
			});
			// Intentional swallow: graph failure must not revert committed facts.
		}
	};
}

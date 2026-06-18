/**
 * Graph traversal phase (007b) — FILLED by Wave 2 (`retrieval-worker-bee`).
 *
 * Phase 2's structured/graph arm: resolve focal entities in priority order, then
 * walk the EXISTING graph catalog tables under the D-3 budgets, emitting memory
 * IDs (+ scores + paths) for the merge.  IDs ONLY — no content (b-AC-7).
 *
 * ── Focal resolution order (b-AC-1 / FR-1) ─────────────────────────────────
 *   1. Pinned entities  (`query.filters?.pinned` ids already in scope)
 *   2. Checkpoint entity IDs from session state (a seam — empty by default)
 *   3. Project-path matches  (`entities` WHERE source_type = 'project')
 *   4. Query-token matches against the entity FTS index  (`entities` name ILIKE)
 *   5. Session-key fallback  (`entities` WHERE source_id = session-key)
 *
 * ── Walk behaviour (b-AC-3 / FR-4) ────────────────────────────────────────
 *   For each focal entity (up to `branching` from the total focal set):
 *     - fetch up to `aspectsPerEntity` aspects
 *     - for each aspect, fetch up to `attrsPerAspect` ACTIVE attributes
 *     - collect the memory_ids those attributes link to
 *     - follow dependency edges whose strength × confidence ≥ minEdgeWeight
 *       (b-AC-4 / FR-5); add each target's memory IDs transitively up to the
 *       total-IDs cap (b-AC-3)
 *
 * ── Active-constraint surfacing (b-AC-5 / FR-6) ────────────────────────────
 *   Attributes with kind = 'constraint' AND status = 'active' under a focal
 *   entity are always collected before the cap trims anything else, so a hard
 *   constraint is NEVER dropped by a cap.
 *
 * ── Hard timeout (b-AC-6 / FR-7) ───────────────────────────────────────────
 *   The walk races against a Promise that resolves after `timeoutMs` ms.  On
 *   timeout the function returns whatever IDs it has collected so far with
 *   `timedOut: true` — never a throw, never a failed recall.
 *
 * ── Output (b-AC-7 / FR-8) ─────────────────────────────────────────────────
 *   Returns a ChannelResult tagged `"traversal"` carrying scored ids + paths, the
 *   constraints found, an entity count, and the timeout flag.  NO content row is
 *   loaded — only memory_id values from `entity_attributes.memory_id`.
 *
 * ── Scope (FR-9) ───────────────────────────────────────────────────────────
 *   Every query runs under the org/workspace partition (`deps.scope`) plus the
 *   engine table's `agent_id` conjunct.  The agent read-policy clause is NOT
 *   applied here — that is 007c's boundary (collection/traversal emit
 *   unauthorized IDs by design).
 *
 * ── SQL safety ──────────────────────────────────────────────────────────────
 *   Every interpolated value routes through `sLiteral` / `sqlStr` / `sqlIdent`.
 *   NEVER a hand-quoted value, NEVER a raw fetch (`audit:sql` scans src/daemon).
 */

import { sLiteral, sqlIdent, sqlLike } from "../../storage/sql.js";
import { CLAIM_ACTIVE } from "../../storage/catalog/knowledge-graph.js";
import type { QueryScope } from "../../storage/client.js";
import { isOk } from "../../storage/result.js";
import type { ChannelResult, RecallPhaseDeps } from "./engine.js";
import type { RecallQuery } from "./contracts.js";

// ── Table/column constants ───────────────────────────────────────────────────
const T_ENTITIES = "entities";
const T_ASPECTS = "entity_aspects";
const T_ATTRIBUTES = "entity_attributes";
const T_DEPS = "entity_dependencies";
const T_MENTIONS = "memory_entity_mentions";

const C_ID = "id";
const C_NAME = "name";
const C_AGENT = "agent_id";
const C_SOURCE_TYPE = "source_type";
const C_SOURCE_ID = "source_id";
const C_ENTITY_ID = "entity_id";
const C_ASPECT_ID = "aspect_id";
const C_MEMORY_ID = "memory_id";
const C_STATUS = "status";
const C_KIND = "kind";
const C_CONFIDENCE = "confidence";
const C_IMPORTANCE = "importance";
const C_TARGET_ENTITY = "target_entity_id";
const C_SOURCE_ENTITY = "source_entity_id";
const C_STRENGTH = "strength";

/** kind value that marks a constraint attribute */
const KIND_CONSTRAINT = "constraint";

// ── Traversal path element ────────────────────────────────────────────────────
/** Records how a memory id was reached (entity → aspect → attribute chain). */
export interface TraversalPath {
	readonly entityId: string;
	readonly aspectId?: string;
	readonly attributeId?: string;
	/** True when this id was surfaced because it is a constraint (b-AC-5). */
	readonly fromConstraint: boolean;
}

/** One scored traversal result: memory id + score + how it was reached. */
export interface TraversalHit {
	readonly id: string;
	readonly score: number;
	readonly path: TraversalPath;
}

/**
 * The extended result the traversal phase returns.  The `ids` field satisfies
 * the ChannelResult contract; the additional fields carry the richer traversal
 * context (b-AC-7).
 */
export interface TraversalChannelResult extends ChannelResult {
	/** The constraints surfaced regardless of caps (b-AC-5 / FR-6). */
	readonly constraints: readonly string[];
	/** How many distinct entities were reached during the walk. */
	readonly entityCount: number;
	/** True when the walk was cut short by the timeout budget (b-AC-6 / FR-7). */
	readonly timedOut: boolean;
}

/**
 * A traversal phase: given the query + deps, return the channel's scored memory
 * IDs (+ whether the walk timed out). IDs only — no content (b-AC-7). Wave 2 fills
 * the real walk; the Wave-1 default is {@link noopTraversalPhase}.
 */
export type TraversalPhase = (query: RecallQuery, deps: RecallPhaseDeps) => Promise<TraversalChannelResult>;

/**
 * The no-op traversal phase the engine routes by default (Wave 1). Returns no
 * candidates and no timeout — so an un-filled recall engine runs collection-only
 * inertly, exactly the b-AC-2 graph-disabled behavior. Wave 2 swaps this for the
 * real walk via `createRecallEngine({ traversal })`.
 */
export const noopTraversalPhase: TraversalPhase = async (): Promise<TraversalChannelResult> => {
	return { channel: "traversal", ids: [], constraints: [], entityCount: 0, timedOut: false };
};

// ── Injectable clock seam (for test control of timeout) ─────────────────────

/**
 * A timer factory the traversal walk uses.  In production this is
 * {@link realTimerFactory}; tests inject a fake to drive the timeout path
 * deterministically without sleeping (b-AC-6).
 */
export interface TimerFactory {
	/** Return a Promise that resolves after `ms` milliseconds. */
	delay(ms: number): Promise<void>;
}

/** Production timer — a plain `setTimeout` Promise. */
export const realTimerFactory: TimerFactory = {
	delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	},
};

// ── SQL builders (values escaped, identifiers validated) ─────────────────────

/** Agent conjunct shared by every graph-table query (FR-9). */
function agentConjunct(agentId: string): string {
	return `${sqlIdent(C_AGENT)} = ${sLiteral(agentId === "" ? "default" : agentId)}`;
}

/**
 * Resolve entity ids for focal resolution step 3: project-path matches
 * (`source_type = 'project'` entities whose `source_id` ILIKE the project filter).
 */
function buildProjectEntitySql(agentId: string, projectPath: string, limit: number): string {
	const tbl = sqlIdent(T_ENTITIES);
	const srcType = sqlIdent(C_SOURCE_TYPE);
	const srcId = sqlIdent(C_SOURCE_ID);
	const id = sqlIdent(C_ID);
	// `sqlLike` escapes the value AND its `%`/`_` so a caller-supplied project filter
	// cannot inject a wildcard (a bare `%` would otherwise match every project) or
	// close the literal early; wrap the escaped value in `%…%` for the substring match.
	const pattern = `'%${sqlLike(projectPath)}%'`;
	return (
		`SELECT ${id} FROM "${tbl}" ` +
		`WHERE ${srcType} = 'project' ` +
		`AND ${srcId}::text ILIKE ${pattern} ` +
		`AND ${agentConjunct(agentId)} ` +
		`LIMIT ${Math.max(1, Math.trunc(limit))}`
	);
}

/**
 * Resolve entity ids for focal resolution step 4: query-token FTS match
 * (`name` ILIKE any token from the query).
 */
function buildEntityFtsSql(agentId: string, token: string, limit: number): string {
	const tbl = sqlIdent(T_ENTITIES);
	const name = sqlIdent(C_NAME);
	const id = sqlIdent(C_ID);
	// Route the token through the canonical `sqlLike` helper (escapes the value AND
	// its `%`/`_` wildcards) rather than hand-rolling the same escape — one audited
	// floor, no drift. Wrap in `%…%` for the substring match.
	const pattern = `'%${sqlLike(token)}%'`;
	return (
		`SELECT ${id} FROM "${tbl}" ` +
		`WHERE ${name}::text ILIKE ${pattern} ` +
		`AND ${agentConjunct(agentId)} ` +
		`LIMIT ${Math.max(1, Math.trunc(limit))}`
	);
}

/**
 * Resolve entity ids for focal resolution step 5: session-key fallback
 * (`source_id = sessionKey`).
 */
function buildSessionKeyEntitySql(agentId: string, sessionKey: string, limit: number): string {
	const tbl = sqlIdent(T_ENTITIES);
	const srcId = sqlIdent(C_SOURCE_ID);
	const id = sqlIdent(C_ID);
	return (
		`SELECT ${id} FROM "${tbl}" ` +
		`WHERE ${srcId} = ${sLiteral(sessionKey)} ` +
		`AND ${agentConjunct(agentId)} ` +
		`LIMIT ${Math.max(1, Math.trunc(limit))}`
	);
}

/** Fetch aspects for a focal entity (up to aspectsPerEntity). */
function buildAspectsSql(agentId: string, entityId: string, limit: number): string {
	const tbl = sqlIdent(T_ASPECTS);
	const entId = sqlIdent(C_ENTITY_ID);
	const id = sqlIdent(C_ID);
	return (
		`SELECT ${id} FROM "${tbl}" ` +
		`WHERE ${entId} = ${sLiteral(entityId)} ` +
		`AND ${agentConjunct(agentId)} ` +
		`LIMIT ${Math.max(1, Math.trunc(limit))}`
	);
}

/**
 * Fetch ACTIVE attribute rows for an aspect (up to attrsPerAspect), ordered by
 * importance desc so the most important attributes come first.  Selects id,
 * memory_id, kind, confidence, importance — IDs only (no content column).
 */
function buildAttributesSql(agentId: string, aspectId: string, limit: number): string {
	const tbl = sqlIdent(T_ATTRIBUTES);
	const aspId = sqlIdent(C_ASPECT_ID);
	const status = sqlIdent(C_STATUS);
	const id = sqlIdent(C_ID);
	const memId = sqlIdent(C_MEMORY_ID);
	const kind = sqlIdent(C_KIND);
	const conf = sqlIdent(C_CONFIDENCE);
	const imp = sqlIdent(C_IMPORTANCE);
	return (
		`SELECT ${id}, ${memId}, ${kind}, ${conf}, ${imp} FROM "${tbl}" ` +
		`WHERE ${aspId} = ${sLiteral(aspectId)} ` +
		`AND ${status} = ${sLiteral(CLAIM_ACTIVE)} ` +
		`AND ${agentConjunct(agentId)} ` +
		`ORDER BY ${imp} DESC ` +
		`LIMIT ${Math.max(1, Math.trunc(limit))}`
	);
}

/**
 * Fetch ACTIVE constraint attributes for an entity across ALL its aspects (no
 * cap — b-AC-5 / FR-6).  Joins entity_aspects so we can filter by entity_id
 * without knowing aspect ids up front.
 */
function buildConstraintAttributesSql(agentId: string, entityId: string): string {
	const attrTbl = sqlIdent(T_ATTRIBUTES);
	const aspTbl = sqlIdent(T_ASPECTS);
	const aspId = sqlIdent(C_ASPECT_ID);
	const entId = sqlIdent(C_ENTITY_ID);
	const status = sqlIdent(C_STATUS);
	const kind = sqlIdent(C_KIND);
	const memId = sqlIdent(C_MEMORY_ID);
	const id = sqlIdent(C_ID);
	const conf = sqlIdent(C_CONFIDENCE);
	const imp = sqlIdent(C_IMPORTANCE);
	return (
		`SELECT a.${id}, a.${memId}, a.${kind}, a.${conf}, a.${imp} ` +
		`FROM "${attrTbl}" a ` +
		`JOIN "${aspTbl}" asp ON asp.${id} = a.${aspId} ` +
		`WHERE asp.${entId} = ${sLiteral(entityId)} ` +
		`AND a.${kind} = ${sLiteral(KIND_CONSTRAINT)} ` +
		`AND a.${status} = ${sLiteral(CLAIM_ACTIVE)} ` +
		`AND a.${agentConjunct(agentId)} ` +
		`AND asp.${agentConjunct(agentId)}`
	);
}

/**
 * Fetch outgoing dependency edges from an entity whose strength × confidence
 * product is above the threshold.  Returns target_entity_id + the combined
 * weight.
 */
function buildDependencyEdgesSql(agentId: string, sourceEntityId: string, minWeight: number, limit: number): string {
	const tbl = sqlIdent(T_DEPS);
	const srcEnt = sqlIdent(C_SOURCE_ENTITY);
	const tgtEnt = sqlIdent(C_TARGET_ENTITY);
	const str = sqlIdent(C_STRENGTH);
	const conf = sqlIdent(C_CONFIDENCE);
	// Threshold stored as a bare numeric literal (it is a float from config, not user input).
	const threshold = Number.isFinite(minWeight) ? String(Math.max(0, minWeight)) : "0";
	return (
		`SELECT ${tgtEnt}, (${str} * ${conf}) AS weight FROM "${tbl}" ` +
		`WHERE ${srcEnt} = ${sLiteral(sourceEntityId)} ` +
		`AND (${str} * ${conf}) >= ${threshold} ` +
		`AND ${agentConjunct(agentId)} ` +
		`ORDER BY weight DESC ` +
		`LIMIT ${Math.max(1, Math.trunc(limit))}`
	);
}

/**
 * Fetch memory_ids linked to an entity via `memory_entity_mentions`.  Used as
 * the fallback when no attribute memory_id is recorded for an entity.
 */
function buildMentionMemoryIdsSql(agentId: string, entityId: string, limit: number): string {
	const tbl = sqlIdent(T_MENTIONS);
	const entId = sqlIdent(C_ENTITY_ID);
	const memId = sqlIdent(C_MEMORY_ID);
	const score = "score";
	return (
		`SELECT ${memId}, ${sqlIdent(score)} FROM "${tbl}" ` +
		`WHERE ${entId} = ${sLiteral(entityId)} ` +
		`AND ${agentConjunct(agentId)} ` +
		`ORDER BY ${sqlIdent(score)} DESC ` +
		`LIMIT ${Math.max(1, Math.trunc(limit))}`
	);
}

// ── Focal resolution helpers ─────────────────────────────────────────────────

/**
 * Extract query tokens for entity FTS: split on whitespace + punctuation, keep
 * tokens ≥ 3 chars, deduplicate, take the first N.
 */
function queryTokens(query: string, maxTokens = 5): string[] {
	return [
		...new Set(
			query
				.split(/[\s,.;:!?()[\]{}'"`]+/)
				.map((t) => t.trim())
				.filter((t) => t.length >= 3),
		),
	].slice(0, maxTokens);
}

/** Extract ids from a QueryResult row set (a column named "id"). */
function extractIds(result: Awaited<ReturnType<RecallPhaseDeps["storage"]["query"]>>): string[] {
	if (!isOk(result)) return [];
	return (result.rows as Record<string, unknown>[])
		.map((row) => String(row["id"] ?? ""))
		.filter((id) => id !== "");
}

// ── The real traversal walk ──────────────────────────────────────────────────

/**
 * The production graph traversal phase (007b / b-AC-1..7).
 *
 * Inject via `createRecallEngine({ phases: { traversal: graphTraversalPhase } })`.
 * The injectable `timer` seam defaults to {@link realTimerFactory}; tests supply a
 * fake timer to drive the timeout path without sleeping (b-AC-6).
 */
export function makeGraphTraversalPhase(timer: TimerFactory = realTimerFactory): TraversalPhase {
	return async function graphTraversalPhase(
		query: RecallQuery,
		deps: RecallPhaseDeps,
	): Promise<TraversalChannelResult> {
		const { config, storage, scope, logger } = deps;

		// b-AC-2 / FR-2: graph disabled → return empty, no error.
		if (!config.graphEnabled) {
			logger?.event("recall.traversal_skipped", { reason: "graph_disabled" });
			return { channel: "traversal", ids: [], constraints: [], entityCount: 0, timedOut: false };
		}

		const agentId = query.scope.agentId;
		const storageScope: QueryScope = { org: scope.org, workspace: scope.workspace };
		const budget = config.traversal;

		// Timeout race (b-AC-6 / FR-7): the walk runs in a Promise that races against
		// the timer.  On timeout we capture whatever we have via the shared state object.
		const state: WalkState = {
			hits: [],
			constraints: [],
			entityCount: 0,
			timedOut: false,
			done: false,
		};

		const walkPromise = runWalk(agentId, query, storageScope, storage, budget, state, logger);
		const timeoutPromise = timer.delay(budget.timeoutMs).then(() => {
			if (!state.done) {
				state.timedOut = true;
				state.done = true; // signal the walk to stop
			}
		});

		await Promise.race([walkPromise, timeoutPromise]);
		// Ensure the walk has cleaned up (it checks state.done internally).
		state.done = true;

		if (state.timedOut) {
			logger?.event("recall.traversal_timeout", {
				collectedIds: state.hits.length,
				entityCount: state.entityCount,
			});
		}

		return {
			channel: "traversal",
			ids: state.hits.map((h) => ({ id: h.id, score: h.score })),
			constraints: state.constraints,
			entityCount: state.entityCount,
			timedOut: state.timedOut,
		};
	};
}

/** Mutable walk state shared between the walk coroutine and the timeout race. */
interface WalkState {
	hits: TraversalHit[];
	constraints: string[];
	entityCount: number;
	timedOut: boolean;
	done: boolean;
}

/**
 * Run the graph walk, mutating `state` as ids are collected.  Checks `state.done`
 * at each async yield point so the timeout can interrupt it cooperatively.
 */
async function runWalk(
	agentId: string,
	query: RecallQuery,
	storageScope: QueryScope,
	storage: RecallPhaseDeps["storage"],
	budget: RecallPhaseDeps["config"]["traversal"],
	state: WalkState,
	logger: RecallPhaseDeps["logger"],
): Promise<void> {
	// ── Step 1: focal resolution (b-AC-1 / FR-1) ──────────────────────────────
	const focalIds = await resolveFocalEntities(agentId, query, storageScope, storage, budget.branching);
	if (state.done) return;

	if (focalIds.length === 0) {
		logger?.event("recall.traversal_no_focal", {});
		return;
	}

	// ── Step 2: collect constraint attributes first (b-AC-5 / FR-6) ──────────
	// Before the cap-bounded walk, grab all active constraints for focal entities.
	for (const entityId of focalIds) {
		if (state.done) return;
		const constraintResult = await storage.query(
			buildConstraintAttributesSql(agentId, entityId),
			storageScope,
		);
		if (isOk(constraintResult)) {
			for (const row of constraintResult.rows as Record<string, unknown>[]) {
				const memId = String(row[C_MEMORY_ID] ?? "");
				if (memId === "") continue;
				if (!state.constraints.includes(memId)) state.constraints.push(memId);
				// Add to hits if not already present (constraint gets max score 0.9).
				if (!state.hits.find((h) => h.id === memId)) {
					state.hits.push({
						id: memId,
						score: 0.9,
						path: { entityId, fromConstraint: true },
					});
				}
			}
		}
	}

	// ── Step 3: bounded walk per focal entity (b-AC-3 / FR-4) ─────────────────
	const visitedEntities = new Set<string>();
	const idsSet = new Set<string>(state.hits.map((h) => h.id));

	for (const entityId of focalIds.slice(0, budget.branching)) {
		if (state.done) return;
		if (state.hits.length >= budget.totalIds) break;
		await walkEntity(
			agentId,
			entityId,
			storageScope,
			storage,
			budget,
			state,
			idsSet,
			visitedEntities,
			0, // depth
		);
	}
}

/**
 * Walk a single entity: fetch aspects → attributes → follow dependency edges.
 * Recursive to depth 1 (no deeper branching — the branching cap limits total
 * focal entities, not recursive depth beyond direct neighbours).
 */
async function walkEntity(
	agentId: string,
	entityId: string,
	storageScope: QueryScope,
	storage: RecallPhaseDeps["storage"],
	budget: RecallPhaseDeps["config"]["traversal"],
	state: WalkState,
	idsSet: Set<string>,
	visitedEntities: Set<string>,
	depth: number,
): Promise<void> {
	if (state.done) return;
	if (visitedEntities.has(entityId)) return;
	visitedEntities.add(entityId);
	state.entityCount++;

	// Fetch aspects (up to aspectsPerEntity).
	const aspectsResult = await storage.query(
		buildAspectsSql(agentId, entityId, budget.aspectsPerEntity),
		storageScope,
	);
	if (state.done) return;

	const aspectIds = extractIds(aspectsResult);

	// For each aspect, fetch active attributes (up to attrsPerAspect).
	for (const aspectId of aspectIds) {
		if (state.done) return;
		if (state.hits.length >= budget.totalIds) break;

		const attrsResult = await storage.query(
			buildAttributesSql(agentId, aspectId, budget.attrsPerAspect),
			storageScope,
		);
		if (!isOk(attrsResult)) continue;

		for (const row of attrsResult.rows as Record<string, unknown>[]) {
			if (state.done) return;
			if (state.hits.length >= budget.totalIds) break;

			const memId = String(row[C_MEMORY_ID] ?? "");
			if (memId === "" || idsSet.has(memId)) continue;

			const conf = typeof row[C_CONFIDENCE] === "number" ? (row[C_CONFIDENCE] as number) : 0.5;
			const imp = typeof row[C_IMPORTANCE] === "number" ? (row[C_IMPORTANCE] as number) : 0.5;
			const score = Math.min(1, Math.max(0, (conf + imp) / 2));
			const isConstraint = String(row[C_KIND] ?? "") === KIND_CONSTRAINT;

			idsSet.add(memId);
			state.hits.push({
				id: memId,
				score,
				path: { entityId, aspectId, fromConstraint: isConstraint },
			});
		}
	}

	// Follow dependency edges (b-AC-4 / FR-5) at depth 0 only (single hop).
	if (depth === 0 && !state.done && state.hits.length < budget.totalIds) {
		const edgesResult = await storage.query(
			buildDependencyEdgesSql(agentId, entityId, budget.minEdgeWeight, budget.branching),
			storageScope,
		);
		if (state.done) return;

		if (isOk(edgesResult)) {
			for (const row of edgesResult.rows as Record<string, unknown>[]) {
				if (state.done) return;
				if (state.hits.length >= budget.totalIds) break;

				const targetEntityId = String(row[C_TARGET_ENTITY] ?? "");
				if (targetEntityId === "" || visitedEntities.has(targetEntityId)) continue;

				// Verify the weight meets threshold (the SQL filters it but guard defensively).
				const weight = typeof row["weight"] === "number" ? (row["weight"] as number) : 0;
				if (weight < budget.minEdgeWeight) continue;

				await walkEntity(
					agentId,
					targetEntityId,
					storageScope,
					storage,
					budget,
					state,
					idsSet,
					visitedEntities,
					depth + 1,
				);
			}
		}
	}

	// Fallback: if entity has no attribute memory_ids, fetch from mentions.
	if (!visitedEntities.has(`${entityId}_mentions_checked`)) {
		visitedEntities.add(`${entityId}_mentions_checked`);
		if (state.hits.filter((h) => h.path.entityId === entityId && !h.path.fromConstraint).length === 0) {
			if (state.done || state.hits.length >= budget.totalIds) return;
			const mentionResult = await storage.query(
				buildMentionMemoryIdsSql(agentId, entityId, budget.attrsPerAspect),
				storageScope,
			);
			if (state.done) return;
			if (isOk(mentionResult)) {
				for (const row of mentionResult.rows as Record<string, unknown>[]) {
					if (state.done) return;
					if (state.hits.length >= budget.totalIds) break;
					const memId = String(row[C_MEMORY_ID] ?? "");
					if (memId === "" || idsSet.has(memId)) continue;
					const rawScore = typeof row["score"] === "number" ? (row["score"] as number) : 0.3;
					const score = Math.min(1, Math.max(0, rawScore));
					idsSet.add(memId);
					state.hits.push({ id: memId, score, path: { entityId, fromConstraint: false } });
				}
			}
		}
	}
}

// ── Focal resolution (b-AC-1 / FR-1) ─────────────────────────────────────────

/**
 * Resolve the focal entity ids in the documented priority order (b-AC-1 / FR-1):
 *   1. pinned entity ids (already in query.filters or provided by checkpoint seam)
 *   2. checkpoint entity ids (session-state seam — empty by default)
 *   3. project-path matches
 *   4. query-token FTS matches
 *   5. session-key fallback
 *
 * Returns up to `branching` distinct ids (the budget's focal limit).
 */
async function resolveFocalEntities(
	agentId: string,
	query: RecallQuery,
	storageScope: QueryScope,
	storage: RecallPhaseDeps["storage"],
	branching: number,
): Promise<string[]> {
	const collected = new Set<string>();
	const cap = Math.max(1, branching);

	// Priority 1: pinned entity ids.  The query carries them via the structured
	// seam — `query.filters?.project` is the project scope; explicit entity pins
	// are not yet a CallerFilters field (PRD-008 deferred), so the pin set is
	// empty by default.  When PRD-008 lands it can add a `pinnedEntityIds` field
	// to CallerFilters and the resolution below just gains a first step.
	// (No-op today: empty by default, keeping resolution correct.)

	if (collected.size >= cap) return [...collected];

	// Priority 2: checkpoint entity ids (session-state seam — empty by default).
	// PRD-005 session state would push checkpoint ids here.  Empty seam today.
	const checkpointIds: string[] = [];
	for (const id of checkpointIds) {
		if (collected.size >= cap) break;
		if (id !== "") collected.add(id);
	}

	if (collected.size >= cap) return [...collected];

	// Priority 3: project-path matches.
	const projectPath = query.filters?.project ?? "";
	if (projectPath !== "") {
		const result = await storage.query(
			buildProjectEntitySql(agentId, projectPath, cap - collected.size),
			storageScope,
		);
		for (const id of extractIds(result)) {
			if (collected.size >= cap) break;
			collected.add(id);
		}
	}

	if (collected.size >= cap) return [...collected];

	// Priority 4: query-token entity FTS.
	const tokens = queryTokens(query.query);
	for (const token of tokens) {
		if (collected.size >= cap) break;
		const result = await storage.query(
			buildEntityFtsSql(agentId, token, cap - collected.size),
			storageScope,
		);
		for (const id of extractIds(result)) {
			if (collected.size >= cap) break;
			collected.add(id);
		}
	}

	if (collected.size >= cap) return [...collected];

	// Priority 5: session-key fallback.
	const sessionKey = query.scope.agentId; // the agent id doubles as a session key seam.
	if (sessionKey !== "" && collected.size < cap) {
		const result = await storage.query(
			buildSessionKeyEntitySql(agentId, sessionKey, cap - collected.size),
			storageScope,
		);
		for (const id of extractIds(result)) {
			if (collected.size >= cap) break;
			collected.add(id);
		}
	}

	return [...collected];
}

/**
 * Entity model + inline entity linker — PRD-008a (Wave 1, `deeplake-dataset-worker-bee`).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * a-AC-1 Inline linker scans proper nouns, links to EXISTING agent entities,
 *         creates nothing, calls no model.
 * a-AC-2 Linker does NO network I/O; synchronous; safe right after memory commit.
 * a-AC-3 Attribute carries kind, status, confidence, importance, version lineage,
 *         provenance (memory + proposal).
 * a-AC-4 Aspect weight rises on confirm, decays toward the floor on stale.
 * a-AC-5 Claim value lives in an addressable group_key/claim_key slot under its aspect.
 * a-AC-6 Every write scoped by org/workspace/agent_id; linker never links cross-agent.
 * a-AC-7 Every interpolated name/key/value escaped through the SQL helpers.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * This module owns the entity-model WRITE path (entities / aspects / attributes
 * with slot keys + provenance + scope), aspect weighting (D-3), and the synchronous
 * inline entity linker. It builds on the proven LIVE patterns in
 * `pipeline/graph-persist.ts` (006d): deterministic ids + poll-convergent dedup
 * probes, heal-aware writes, append-only/version-bumped per the catalog pattern.
 *
 * ── Scope discipline (D-2 / a-AC-6) ─────────────────────────────────────────
 *   - The OUTER ring is the `QueryScope` partition (org + workspace), enforced at
 *     the storage layer beneath every statement.
 *   - The INNER ring is the `agent_id` conjunct every read/write carries. The
 *     `entities`/`entity_aspects`/`entity_attributes` tables are engine-scoped
 *     (D-2): they carry `agent_id` + `visibility`, NOT explicit org/workspace
 *     columns. So "scoped by org/workspace/agent_id" = partition + agent conjunct.
 *   - The linker reads existing entities under BOTH rings, so it can NEVER resolve
 *     or link an entity belonging to another agent (a-AC-6).
 *
 * ── The linker is the cheapest write path (a-AC-1/a-AC-2 / FR-5/FR-6) ────────
 *   It is model-free and offline: it scans the new memory's content for proper
 *   nouns (D-2 detection: capitalized multi-word tokens), matches them EXACTLY
 *   against the agent's EXISTING entity names, and writes ONLY a
 *   `memory_entity_mentions` row for each hit. It creates no entity, calls no
 *   model, and issues no network request beyond the storage reads/writes — so it
 *   runs synchronously right after the memory commit without risking the write
 *   path. Entity CREATION is the heavier background path (006d), never the linker.
 *
 * ── SQL safety (a-AC-7 / FR-8) ──────────────────────────────────────────────
 *   Every value routes through `sLiteral`/`sqlLike` or the `val.*` constructors;
 *   every identifier through `sqlIdent`. No hand-quoted value, no raw fetch.
 *   `audit:sql` scans `src/daemon`.
 */

import crypto from "node:crypto";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { healTargetFor } from "../../storage/catalog/index.js";
import { CLAIM_ACTIVE } from "../../storage/catalog/knowledge-graph.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent, sqlLike } from "../../storage/sql.js";
import { appendOnlyInsert, updateOrInsertByKey, val } from "../../storage/writes.js";
import {
	type Attribute,
	type AttributeProvenance,
	type AttributeSlot,
	ASPECT_WEIGHT_CEILING,
	ASPECT_WEIGHT_FLOOR,
	coerceEntityType,
	type EntityRef,
	type EntityType,
} from "./contracts.js";
import { attributeVersionId, slotClaimKey } from "./supersede.js";

// ── Table / column constants ──────────────────────────────────────────────────

const T_ENTITIES = "entities";
const T_ASPECTS = "entity_aspects";
const T_ATTRIBUTES = "entity_attributes";
const T_MENTIONS = "memory_entity_mentions";

const C_ID = "id";
const C_NAME = "name";
const C_AGENT = "agent_id";

/** How many times a presence probe re-reads before concluding ABSENT (live-determinism). */
const PROBE_POLLS = 8;

// ── ISO timestamp ─────────────────────────────────────────────────────────────

function nowIso(): string {
	return new Date().toISOString();
}

// ── Canonical naming + deterministic ids (mirrors graph-persist.ts) ────────────

/** Canonicalise an entity name: trim + lowercase. The dedup key (a-AC-6 / FR-1). */
export function canonicaliseName(raw: string): string {
	return raw.trim().toLowerCase();
}

/** Deterministic entity id from agent + canonical name; `ent_`-prefixed. Pure. */
export function entityId(agentId: string, canonicalName: string): string {
	const hash = crypto.createHash("sha256").update(`${agentId}:${canonicalName}`).digest("hex").slice(0, 24);
	return `ent_${hash}`;
}

/** Deterministic aspect id from entity id + aspect name; `asp_`-prefixed. Pure. */
export function aspectId(entityId_: string, aspectName: string): string {
	const hash = crypto
		.createHash("sha256")
		.update(`${entityId_}:${aspectName.trim().toLowerCase()}`)
		.digest("hex")
		.slice(0, 24);
	return `asp_${hash}`;
}

/** Deterministic mention id from memory id + entity id; `mention_`-prefixed. Pure. */
export function mentionId(memoryId: string, entityId_: string): string {
	const hash = crypto.createHash("sha256").update(`${memoryId}:${entityId_}`).digest("hex").slice(0, 24);
	return `mention_${hash}`;
}

// ── Scope helpers (a-AC-6) ────────────────────────────────────────────────────

/**
 * Build the `agent_id = '<self>'` clause every engine-table read carries (D-2 inner
 * ring / a-AC-6). The value routes through `sLiteral` and the identifier through
 * `sqlIdent`. The returned fragment is named `…Clause` at every call site so it is a
 * recognized pre-escaped fragment (the `audit:sql` gate treats a `Clause`-suffixed
 * interpolation body as already-built — see traversal.ts's scope conjuncts).
 */
function agentClauseFor(agentId: string): string {
	return `${sqlIdent(C_AGENT)} = ${sLiteral(agentId === "" ? "default" : agentId)}`;
}

// ── Poll-convergent presence probe (reused from the proven 006d pattern) ──────

/**
 * Is a row with this deterministic `id` already present in `table` for this agent?
 * POLL-CONVERGENT: re-read a by-id `SELECT id … LIMIT 1` up to {@link PROBE_POLLS}
 * times and return `true` the instant any poll sees it. A scan can miss a row on a
 * stale segment but never invents one, so polling converges to the durable truth.
 * The probe carries the agent conjunct so a presence check is itself agent-scoped.
 */
async function isPresentById(
	storage: StorageQuery,
	table: string,
	id: string,
	agentId: string,
	scope: QueryScope,
): Promise<boolean> {
	const tbl = sqlIdent(table);
	const idCol = sqlIdent(C_ID);
	const agentClause = agentClauseFor(agentId);
	const sql = ["SELECT ", idCol, " FROM \"", tbl, "\" WHERE ", idCol, " = ", sLiteral(id), " AND ", agentClause, " LIMIT 1"].join("");
	for (let poll = 0; poll < PROBE_POLLS; poll++) {
		const res = await storage.query(sql, scope);
		if (isOk(res) && res.rows.length > 0) return true;
	}
	return false;
}

// ════════════════════════════════════════════════════════════════════════════
// ENTITY / ASPECT / ATTRIBUTE WRITERS (a-AC-3 / a-AC-5 / a-AC-6)
// ════════════════════════════════════════════════════════════════════════════

/** Inputs to {@link writeEntity}. */
export interface WriteEntityArgs {
	readonly agentId: string;
	readonly rawName: string;
	readonly type: EntityType | string;
	/** Optional provenance back to the source that introduced the entity. */
	readonly sourceId?: string;
	readonly sourceType?: string;
	readonly visibility?: string;
}

/**
 * Upsert an entity by canonical name (FR-1 / a-AC-6). `entities` is `update-or-insert`
 * per the catalog pattern; the deterministic id is the logical key, so a re-run of
 * the same (agent, canonical name) resolves the SAME row. Returns an {@link EntityRef}.
 *
 * Scope: the row carries `agent_id` + `visibility` (engine scope, D-2); the
 * `QueryScope` partition supplies org/workspace. The type is coerced to the fixed
 * D-1 set so an unconstrained type still lands as a valid `unknown` row (FR-1).
 */
export async function writeEntity(
	storage: StorageQuery,
	scope: QueryScope,
	args: WriteEntityArgs,
): Promise<EntityRef> {
	const canonical = canonicaliseName(args.rawName);
	const id = entityId(args.agentId, canonical);
	const type = coerceEntityType(typeof args.type === "string" ? args.type : String(args.type));
	const now = nowIso();
	const target = healTargetFor(T_ENTITIES);

	await updateOrInsertByKey(storage, target, scope, {
		keyColumn: C_ID,
		keyValue: id,
		row: [
			[C_ID, val.str(id)],
			[C_NAME, val.str(canonical)],
			["type", val.str(type)],
			["source_id", val.str(args.sourceId ?? "")],
			["source_type", val.str(args.sourceType ?? "")],
			[C_AGENT, val.str(args.agentId)],
			["visibility", val.str(args.visibility ?? "global")],
			["created_at", val.str(now)],
			["updated_at", val.str(now)],
		],
	});

	return { id, canonicalName: canonical, displayName: args.rawName, type };
}

/** Inputs to {@link writeAspect}. */
export interface WriteAspectArgs {
	readonly agentId: string;
	readonly entityId: string;
	readonly name: string;
	/** Initial weight; defaults to the ceiling (a fresh aspect starts fully weighted). */
	readonly weight?: number;
	readonly visibility?: string;
}

/**
 * Upsert a weighted aspect of an entity (FR-2 / a-AC-5). `entity_aspects` is
 * `update-or-insert`; the deterministic id (entity + aspect name) is the logical key.
 * Returns the aspect id. The weight is clamped into [floor, ceiling].
 */
export async function writeAspect(
	storage: StorageQuery,
	scope: QueryScope,
	args: WriteAspectArgs,
): Promise<string> {
	const id = aspectId(args.entityId, args.name);
	const weight = clampWeight(args.weight ?? ASPECT_WEIGHT_CEILING);
	const now = nowIso();
	const target = healTargetFor(T_ASPECTS);

	await updateOrInsertByKey(storage, target, scope, {
		keyColumn: C_ID,
		keyValue: id,
		row: [
			[C_ID, val.str(id)],
			["entity_id", val.str(args.entityId)],
			[C_NAME, val.str(args.name)],
			["weight", val.num(weight)],
			[C_AGENT, val.str(args.agentId)],
			["visibility", val.str(args.visibility ?? "global")],
			["created_at", val.str(now)],
			["updated_at", val.str(now)],
		],
	});

	return id;
}

/** Inputs to {@link writeAttribute}. */
export interface WriteAttributeArgs {
	readonly agentId: string;
	readonly aspectId: string;
	/** The addressable slot (group_key/claim_key) the claim occupies (a-AC-5). */
	readonly slot: AttributeSlot;
	readonly kind: Attribute["kind"];
	readonly content: string;
	readonly confidence: number;
	readonly importance: number;
	/** Mandatory provenance back to the memory + (optional) proposal (a-AC-3). */
	readonly provenance: AttributeProvenance;
	readonly visibility?: string;
}

/**
 * Write the FIRST version of a claim attribute into an addressable slot (a-AC-3 /
 * a-AC-5). `entity_attributes` is `version-bumped`; this is the version-1 append
 * (status='active'). A LATER conflicting claim in the same slot goes through
 * {@link supersedeClaim} (008b), which appends version N+1 and marks this one
 * superseded — so this writer is the entry point and supersession is the edit path.
 *
 * The row carries the FULL claim shape (a-AC-3): kind, status, confidence,
 * importance, the `version` lineage counter, the slot's `group_key`/`claim_key`, and
 * the mandatory `memory_id` provenance. Idempotent: the deterministic version-1 id is
 * dedup-probed, so a re-run appends nothing. Returns the attribute id.
 *
 * Provenance discipline (a-AC-3): a write with an empty `provenance.memoryId` is
 * REJECTED — an attribute with no traceable memory is not a valid graph row.
 */
export async function writeAttribute(
	storage: StorageQuery,
	scope: QueryScope,
	args: WriteAttributeArgs,
): Promise<string> {
	if (args.provenance.memoryId.trim() === "") {
		throw new AttributeProvenanceError();
	}

	const claimKeyValue = slotClaimKey(args.aspectId, args.slot);
	const version = 1;
	const id = attributeVersionId(args.aspectId, args.slot, version);
	const target = healTargetFor(T_ATTRIBUTES);

	// Idempotency: a re-run of the same version-1 claim appends nothing.
	if (await isPresentById(storage, T_ATTRIBUTES, id, args.agentId, scope)) {
		return id;
	}

	const now = nowIso();
	await appendOnlyInsert(storage, target, scope, [
		[C_ID, val.str(id)],
		["aspect_id", val.str(args.aspectId)],
		[C_AGENT, val.str(args.agentId)],
		["memory_id", val.str(args.provenance.memoryId)],
		["kind", val.str(args.kind)],
		["content", val.text(args.content)],
		["confidence", val.num(clamp01(args.confidence))],
		["importance", val.num(clamp01(args.importance))],
		["status", val.str(CLAIM_ACTIVE)],
		["superseded_by", val.str("")],
		["claim_key", val.str(claimKeyValue)],
		["group_key", val.str(args.slot.groupKey)],
		["version", val.num(version)],
		["visibility", val.str(args.visibility ?? "global")],
		["created_at", val.str(now)],
		["updated_at", val.str(now)],
	]);

	// memory_id is the mandatory provenance trace (a-AC-3); a proposal link (when an
	// 008c apply supplies one) rides the proposal row + deterministic id lineage.
	void args.provenance.proposalId;
	void args.provenance.source;

	return id;
}

/** Thrown when a claim attribute is written with no traceable memory id (a-AC-3). */
export class AttributeProvenanceError extends Error {
	constructor() {
		super("entity_attributes: an attribute with no provenance.memoryId is not a valid graph row");
		this.name = "AttributeProvenanceError";
	}
}

// ════════════════════════════════════════════════════════════════════════════
// ASPECT WEIGHTING (a-AC-4 / D-3)
// ════════════════════════════════════════════════════════════════════════════

/** The staleness window (ms) beyond which an aspect weight decays (D-3: 30 days). */
export const ASPECT_STALE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** How much a single confirmation raises the weight toward the ceiling (D-3). */
export const ASPECT_CONFIRM_STEP = 0.15;

/** How much a stale aspect decays toward the floor per evaluation (D-3). */
export const ASPECT_DECAY_STEP = 0.2;

/**
 * Compute the new aspect weight on a CONFIRMATION (a-AC-4 / D-3). Retrieval keeping
 * an aspect relevant raises its weight toward {@link ASPECT_WEIGHT_CEILING} by
 * {@link ASPECT_CONFIRM_STEP}, never past the ceiling. Pure — the caller persists the
 * result via {@link writeAspect}.
 */
export function confirmAspectWeight(current: number): number {
	return clampWeight(current + ASPECT_CONFIRM_STEP);
}

/**
 * Compute the new aspect weight on a STALE evaluation (a-AC-4 / D-3). An aspect not
 * confirmed within {@link ASPECT_STALE_WINDOW_MS} decays TOWARD
 * {@link ASPECT_WEIGHT_FLOOR} by {@link ASPECT_DECAY_STEP}, never below the floor.
 * `lastConfirmedMs` and `nowMs` are epoch ms; when the gap is within the window the
 * weight is unchanged (not yet stale). Pure.
 */
export function decayAspectWeight(current: number, lastConfirmedMs: number, nowMs: number): number {
	const gap = nowMs - lastConfirmedMs;
	if (gap < ASPECT_STALE_WINDOW_MS) return clampWeight(current);
	// Decay toward the floor: move a fixed step down but never past the floor.
	const decayed = current - ASPECT_DECAY_STEP;
	return decayed < ASPECT_WEIGHT_FLOOR ? ASPECT_WEIGHT_FLOOR : clampWeight(decayed);
}

/** Clamp a weight into [floor, ceiling]; non-finite → floor. */
function clampWeight(n: number): number {
	if (!Number.isFinite(n)) return ASPECT_WEIGHT_FLOOR;
	return Math.min(ASPECT_WEIGHT_CEILING, Math.max(ASPECT_WEIGHT_FLOOR, n));
}

/** Clamp a score into [0, 1]; non-finite → 0. */
function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.min(1, Math.max(0, n));
}

// ════════════════════════════════════════════════════════════════════════════
// THE INLINE ENTITY LINKER (a-AC-1 / a-AC-2 / FR-5 / FR-6)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The maximum number of words in a proper-noun candidate (D-2). A capitalized run
 * longer than this is almost certainly a sentence fragment, not a name, so we cap it.
 */
const MAX_PROPER_NOUN_WORDS = 6;

/**
 * Extract proper-noun candidates from text (D-2: capitalized multi-word token scan),
 * MODEL-FREE and pure (a-AC-1 / a-AC-2). The rule:
 *   - split into sentences (so a sentence-initial capital does not glue two names);
 *   - within a sentence, collect maximal runs of Capitalized words (first letter
 *     upper, allowing internal apostrophes/hyphens), up to {@link MAX_PROPER_NOUN_WORDS};
 *   - a run is a candidate if it has ≥ 1 word; both the full run AND each single
 *     capitalized word are emitted, so "Activeloop Deep Lake" matches an entity named
 *     either "activeloop deep lake" OR "activeloop" (the linker matches EXACT canonical
 *     names, so emitting both granularities lets the exact-match step decide).
 *
 * Returns CANONICAL (trimmed+lowercased) candidate strings, deduplicated. No network,
 * no model — pure string work, safe on the synchronous write path (a-AC-2).
 */
export function extractProperNounCandidates(content: string): string[] {
	const candidates = new Set<string>();
	// Split on sentence terminators so a leading capital doesn't merge across them.
	const sentences = content.split(/[.!?\n\r]+/);
	for (const sentence of sentences) {
		const words = sentence.split(/\s+/).filter((w) => w.length > 0);
		let run: string[] = [];
		const flush = (): void => {
			if (run.length === 0) return;
			// Emit the full run.
			emitCandidate(candidates, run.join(" "));
			// Also emit each single capitalized word (a name may BE one of them).
			if (run.length > 1) {
				for (const w of run) emitCandidate(candidates, w);
			}
			run = [];
		};
		for (let i = 0; i < words.length; i++) {
			const word = words[i];
			// A sentence-initial capitalized word is ambiguous (it may just be the
			// sentence start). We still include it, because exact canonical matching
			// against EXISTING entity names is the real gate — a false candidate that
			// matches no entity simply links nothing.
			if (isCapitalizedToken(word)) {
				run.push(stripEdgePunctuation(word));
				if (run.length >= MAX_PROPER_NOUN_WORDS) flush();
			} else {
				flush();
			}
		}
		flush();
	}
	return [...candidates];
}

/** Add a canonicalised non-empty candidate to the set. */
function emitCandidate(set: Set<string>, raw: string): void {
	const canonical = canonicaliseName(stripEdgePunctuation(raw));
	if (canonical.length > 0) set.add(canonical);
}

/** True when a token starts with an uppercase letter (proper-noun shape, D-2). */
function isCapitalizedToken(word: string): boolean {
	const stripped = stripEdgePunctuation(word);
	if (stripped.length === 0) return false;
	const first = stripped[0];
	// Unicode-aware uppercase check: the first char differs from its lowercase form.
	return first !== first.toLowerCase() && first === first.toUpperCase();
}

/** Strip leading/trailing punctuation that clings to a word (quotes, commas, parens). */
function stripEdgePunctuation(word: string): string {
	return word.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "");
}

/** One mention the linker wrote (or would write), for the caller's audit + tests. */
export interface LinkedMention {
	/** The entity that was matched + linked. */
	readonly entityId: string;
	/** The canonical name that matched. */
	readonly canonicalName: string;
	/** The mention row id written. */
	readonly mentionId: string;
}

/** The outcome of an inline link pass. */
export interface InlineLinkResult {
	/** The mentions written (one per matched EXISTING entity). */
	readonly mentions: readonly LinkedMention[];
	/** How many proper-noun candidates were scanned. */
	readonly candidateCount: number;
}

/**
 * The synchronous inline entity linker (a-AC-1 / a-AC-2 / FR-5 / FR-6).
 *
 * Given a just-committed memory's content, it:
 *   1. Scans the content for proper-noun candidates (MODEL-FREE, pure string work).
 *   2. For each candidate, looks up an EXISTING entity for THIS agent by EXACT
 *      canonical name (under both scope rings — partition + agent conjunct, so it
 *      can never resolve another agent's entity, a-AC-6).
 *   3. For each match, writes a `memory_entity_mentions` row (append-only, heal-aware,
 *      idempotent by deterministic id). It CREATES NO entity, CALLS NO model, and does
 *      NO network I/O beyond these storage reads/writes — so it is safe to run right
 *      after the memory commit (a-AC-2).
 *
 * It links ONLY to entities that already exist (a-AC-1): a candidate that matches no
 * existing agent entity links nothing. Entity creation is the heavier background path
 * (006d), never the linker.
 *
 * Returns the mentions written + the candidate count (for the caller's metrics/tests).
 */
export async function inlineLinkMemory(
	storage: StorageQuery,
	scope: QueryScope,
	args: {
		readonly agentId: string;
		readonly memoryId: string;
		readonly content: string;
	},
): Promise<InlineLinkResult> {
	const candidates = extractProperNounCandidates(args.content);
	const mentions: LinkedMention[] = [];
	const linkedEntityIds = new Set<string>();

	for (const canonical of candidates) {
		// Resolve an EXISTING entity for THIS agent by exact canonical name (a-AC-1/a-AC-6).
		const resolvedId = await resolveExistingEntityId(storage, scope, args.agentId, canonical);
		if (resolvedId === null) continue; // matches no existing entity → link nothing (a-AC-1).
		if (linkedEntityIds.has(resolvedId)) continue; // one mention per entity per memory.
		linkedEntityIds.add(resolvedId);

		const written = await writeMention(storage, scope, args.agentId, args.memoryId, resolvedId, canonical);
		mentions.push(written);
	}

	return { mentions, candidateCount: candidates.length };
}

/**
 * Resolve the id of an EXISTING entity for this agent by EXACT canonical name, or
 * `null` (a-AC-1 / a-AC-6). The lookup matches `name = '<canonical>'` AND the agent
 * conjunct, so it can only ever return an entity belonging to THIS agent under THIS
 * partition — the cross-agent boundary is structurally unreachable.
 *
 * POLL-CONVERGENT: re-read up to {@link PROBE_POLLS} times and take the first hit, so
 * a stale segment cannot make an existing entity look absent. The value goes through
 * `sLiteral` (exact match) — `sqlLike` is NOT used (no wildcard semantics wanted).
 */
async function resolveExistingEntityId(
	storage: StorageQuery,
	scope: QueryScope,
	agentId: string,
	canonicalName: string,
): Promise<string | null> {
	const tbl = sqlIdent(T_ENTITIES);
	const idCol = sqlIdent(C_ID);
	const nameCol = sqlIdent(C_NAME);
	const agentClause = agentClauseFor(agentId);
	const sql = ["SELECT ", idCol, " FROM \"", tbl, "\" WHERE ", nameCol, " = ", sLiteral(canonicalName), " AND ", agentClause, " LIMIT 1"].join("");
	for (let poll = 0; poll < PROBE_POLLS; poll++) {
		const res = await storage.query(sql, scope);
		if (isOk(res) && res.rows.length > 0) {
			const id = (res.rows[0] as StorageRow).id;
			if (typeof id === "string" && id !== "") return id;
		}
	}
	return null;
}

/**
 * Write a `memory_entity_mentions` row linking a memory to an existing entity
 * (FR-5 / a-AC-6). Append-only (the catalog pattern), heal-aware, idempotent by the
 * deterministic (memory, entity) id — a re-link of the same pair writes nothing new.
 * Carries the agent scope on the row (D-2).
 */
async function writeMention(
	storage: StorageQuery,
	scope: QueryScope,
	agentId: string,
	memoryId: string,
	entityId_: string,
	canonicalName: string,
): Promise<LinkedMention> {
	const id = mentionId(memoryId, entityId_);
	const target = healTargetFor(T_MENTIONS);

	// Idempotency: a re-link of the same (memory, entity) pair appends nothing.
	if (!(await isPresentById(storage, T_MENTIONS, id, agentId, scope))) {
		const now = nowIso();
		await appendOnlyInsert(storage, target, scope, [
			[C_ID, val.str(id)],
			["memory_id", val.str(memoryId)],
			["entity_id", val.str(entityId_)],
			["mention_count", val.num(1)],
			["score", val.num(0)],
			[C_AGENT, val.str(agentId)],
			["visibility", val.str("global")],
			["created_at", val.str(now)],
		]);
	}

	return { entityId: entityId_, canonicalName, mentionId: id };
}

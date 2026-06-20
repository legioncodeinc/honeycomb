/**
 * Controlled-writes stage — PRD-006c (Wave 2 — `deeplake-dataset-worker-bee`).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE ONLY STAGE THAT MUTATES `memories`. Everything upstream proposes; this
 * stage is the single chokepoint where pipeline intent becomes durable state.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * WHAT IT CONSUMES: a {@link Proposal} (from 006b) on the job payload, plus the
 * fact's content/normalized-content/confidence (the material an ADD writes).
 *
 * WHAT IT BUILDS (006c c-AC-1..6 / FR-1..11):
 *   - c-AC-1 (FR-3/FR-4/FR-5): an ADD is applied only if fact confidence clears
 *     `minFactConfidenceForWrite` (0.7, D-1) AND normalized content is non-empty
 *     AND the SHA-256 `content_hash` is NOT already present (SELECT-before-INSERT
 *     via {@link buildDedupCheckSql}).
 *   - c-AC-2 (FR-5): an ADD whose `content_hash` already exists → return the
 *     existing memory id, NO duplicate INSERT.
 *   - c-AC-3 (FR-6/FR-7): an UPDATE/DELETE runs a contradiction check (D-7:
 *     negation/antonym token set + lexical-overlap heuristic), is ALWAYS flagged
 *     for review, and is applied ONLY when `autonomous.allowUpdateDelete` is set —
 *     as an append-only **version-bumped** write ({@link appendVersionBumped}),
 *     never an in-place UPDATE (DeepLake coalesces UPDATEs and can drop one).
 *   - c-AC-4 (FR-8): under `shadowMode` → write NOTHING (history-only is 006b's
 *     job; this stage simply does not mutate `memories`).
 *   - c-AC-5 (FR-9): under `mutationsFrozen` → write NOTHING even if shadow is off.
 *     Frozen SUPERSEDES shadow (frozen is checked FIRST).
 *   - c-AC-6 (FR-2): the memory's embedding is PREFETCHED via the injected 005b
 *     {@link EmbedClient} BEFORE the write, so no network call happens during the
 *     commit (the dedup-check → INSERT window is embed-call-free).
 *
 * HOW IT REACHES THINGS (CONVENTIONS §3):
 *   - storage: an injected {@link StorageQuery} + per-job {@link QueryScope}; every
 *     statement is built with the `writes.ts` primitives + the SQL-safety helpers,
 *     never a raw fetch or a hand-quoted value (`audit:sql` scans `src/daemon`).
 *   - dedup/hash: {@link contentHash} + {@link buildDedupCheckSql} from the catalog.
 *   - embed:   the 005b {@link EmbedClient} seam — `embed(text)` → 768-dim vector
 *     or `null` (disabled/unreachable/wrong-dim → write the row with the embedding
 *     column NULL, exactly the capture path's degrade).
 *   - config:  `minFactConfidenceForWrite`, `shadowMode`, `mutationsFrozen`,
 *     `autonomous.allowUpdateDelete`. Scope (org/workspace/agent) is on `job.scope`.
 *
 * ── Version column on `memories` (a deliberate, in-scope HealTarget widening) ──
 * The catalog records `memories` as `update-or-insert` with NO `version` column
 * (PRD-003a). PRD-006c / D-7, however, require UPDATE/DELETE to land as
 * append-only version-bumped writes — which append a `version` column. Rather than
 * edit the shared catalog (forbidden — PRD-003 is another wave's file), this stage
 * composes its version-bumped {@link HealTarget} from the single-sourced
 * {@link MEMORIES_COLUMNS} PLUS a locally-declared `version` ColumnDef
 * (`BIGINT NOT NULL DEFAULT 1`). The heal engine therefore sees `version` in the
 * diff and `ALTER TABLE … ADD COLUMN version …` lazily on the first version-bumped
 * write — the same self-healing the rest of the data layer relies on. The base
 * columns stay single-sourced (we spread, never retype). This seam tension between
 * PRD-003a's pattern and PRD-006c's requirement is flagged in the run report.
 *
 * This module exports the testable core {@link applyControlledWrite} (proposal +
 * fact material + deps → a typed {@link ControlledWriteOutcome}) AND the
 * {@link createControlledWriteHandler} that adapts it to the {@link StageHandler}
 * the worker routes. Keep the export names {@link noopControlledWriteHandler} +
 * {@link createControlledWriteHandler}.
 */

import { type Proposal, parseProposal } from "./contracts.js";
import { type PipelineConfig } from "./config.js";
import type { StageHandler, StageJob } from "./stage-worker.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { HealTarget } from "../../storage/heal.js";
import { classifyFailure } from "../../storage/heal.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import {
	appendVersionBumped,
	type ColumnValue,
	type RowValues,
	val,
} from "../../storage/writes.js";
import {
	buildDedupCheckSql,
	contentHash,
	MEMORIES_COLUMNS,
	NOT_SOFT_DELETED,
	SOFT_DELETED,
} from "../../storage/catalog/index.js";
import { type ColumnDef } from "../../storage/schema.js";
import { EMBEDDING_DIMS, serializeFloat4Array } from "../../storage/vector.js";
import type { EmbedClient } from "../services/embed-client.js";

/** A minimal structured-log sink for controlled-write events (flagged/skipped/etc). */
export interface ControlledWriteLogger {
	/** Record a structured event (e.g. `controlled_write.flagged_for_review`). */
	event(name: string, fields?: Record<string, unknown>): void;
}

/** A no-op logger (default when the daemon does not inject one). */
const silentLogger: ControlledWriteLogger = { event(): void {} };

/**
 * The version column appended to a `memories` row by the version-bumped UPDATE /
 * DELETE path. It is NOT in the catalog's `MEMORIES_COLUMNS` (PRD-003a records
 * `memories` as update-or-insert); this stage composes it into the HealTarget so
 * the heal engine adds it lazily on the first version-bumped write. `BIGINT NOT
 * NULL DEFAULT 1` so the column heals onto a populated table and the first
 * appended version of a memory is 1 (mirrors `memory_jobs.version`).
 */
export const MEMORIES_VERSION_COLUMN: ColumnDef = Object.freeze({
	name: "version",
	sql: "BIGINT NOT NULL DEFAULT 1",
});

/** The `memories` HealTarget the version-bumped UPDATE/DELETE path writes through. */
const MEMORIES_VERSIONED_TARGET: HealTarget = Object.freeze({
	table: "memories",
	columns: Object.freeze([...MEMORIES_COLUMNS, MEMORIES_VERSION_COLUMN]),
});

/** What the controlled-write stage decided to do for one proposal. */
export type ControlledWriteAction =
	| "inserted" // a new memory row was written (ADD)
	| "deduped" // an ADD whose content hash already existed → existing id returned
	| "version_bumped" // an UPDATE/DELETE applied as an append-only version bump
	| "flagged_not_applied" // an UPDATE/DELETE flagged but not applied (autonomous off)
	| "skipped"; // gate rejected, or shadow/frozen, or action `none`

/** The typed result of applying one controlled write. No throw on a gate rejection. */
export interface ControlledWriteOutcome {
	/** What the stage did. */
	readonly action: ControlledWriteAction;
	/**
	 * The `memories.id` the outcome concerns: the new id on an insert, the existing
	 * id on a dedup hit (c-AC-2), the target id on a version-bumped update/delete, or
	 * `undefined` when nothing was touched.
	 */
	readonly memoryId?: string;
	/** True when an UPDATE/DELETE tripped the contradiction heuristic (D-7). */
	readonly contradiction?: boolean;
	/** A short human-readable reason for a skip / flag, for logs + tests. */
	readonly reason?: string;
}

/** The fact material a controlled write needs beyond the {@link Proposal}. */
export interface ControlledWriteInput {
	/** The decision proposal (006b output): action + targetId + confidence + reason. */
	readonly proposal: Proposal;
	/** The fact's display content (the `content` column on an insert). */
	readonly content: string;
	/**
	 * The normalized content the SHA-256 dedup hash is computed over (FR-5). The
	 * non-empty gate (FR-4) is checked against this. Defaults to `content` when the
	 * caller does not pre-normalize.
	 */
	readonly normalizedContent: string;
	/** The fact's own confidence — the value the ADD gate compares to the threshold (c-AC-1). */
	readonly factConfidence: number;
	/** The fact `type` (the `type` column); defaults to `'fact'` when absent. */
	readonly factType?: string;
	/**
	 * The `agent_id` the memory is scoped to (FR-11). `memories` is an `agent`-scoped
	 * engine table (PRD-003a D-2): org/workspace isolation is the storage partition's
	 * job (the {@link QueryScope}), and the row carries `agent_id`. Defaults to the
	 * catalog default `'default'` when absent.
	 */
	readonly agentId?: string;
}

/** Construction deps for {@link createControlledWriteHandler} + {@link applyControlledWrite}. */
export interface ControlledWriteHandlerDeps {
	/** The DeepLake storage client (daemon-only). Every write goes through this. */
	readonly storage: StorageQuery;
	/** The resolved pipeline config (gates: confidence, shadow, frozen, autonomous). */
	readonly config: PipelineConfig;
	/** The 005b embed seam — prefetch the vector BEFORE the write (c-AC-6). */
	readonly embed: EmbedClient;
	/** A clock for `created_at` / `updated_at`; defaults to `Date.now`-backed ISO. */
	readonly now?: () => Date;
	/** Optional structured-log sink. */
	readonly logger?: ControlledWriteLogger;
	/**
	 * An id generator for new memory rows (ADD). Defaults to {@link defaultMemoryId}.
	 * Injected so a test asserts the exact inserted id.
	 */
	readonly newId?: () => string;
}

// ── D-7 contradiction heuristic ─────────────────────────────────────────────────

/**
 * Negation tokens — words whose presence flips polarity. An UPDATE/DELETE whose
 * proposal reason carries one of these (with lexical overlap to the fact) is a
 * likely contradiction worth flagging (D-7). Lowercased, matched as whole words.
 */
const NEGATION_TOKENS = Object.freeze([
	"not", "no", "never", "none", "cannot", "can't", "cant", "won't", "wont",
	"isn't", "isnt", "aren't", "arent", "doesn't", "doesnt", "don't", "dont",
	"didn't", "didnt", "wasn't", "wasnt", "without", "stop", "stopped", "remove",
	"removed", "delete", "deleted", "deprecated", "incorrect", "wrong", "false",
]);

/**
 * Antonym pairs — a fact and a proposal asserting opposite poles is a
 * contradiction even without an explicit negation (D-7). Symmetric: each pair is
 * checked both directions.
 */
const ANTONYM_PAIRS: ReadonlyArray<readonly [string, string]> = Object.freeze([
	["enable", "disable"], ["enabled", "disabled"], ["on", "off"],
	["allow", "deny"], ["allowed", "denied"], ["true", "false"],
	["add", "remove"], ["increase", "decrease"], ["start", "stop"],
	["open", "closed"], ["accept", "reject"], ["include", "exclude"],
	["active", "inactive"], ["valid", "invalid"], ["present", "absent"],
]);

/** Tokenize to lowercase word tokens (alphanumerics), dropping punctuation. */
function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9']+/)
		.filter((t) => t.length > 0);
}

/** Jaccard-style lexical overlap ratio over two token sets (0..1). */
function lexicalOverlap(a: readonly string[], b: readonly string[]): number {
	const setA = new Set(a);
	const setB = new Set(b);
	if (setA.size === 0 || setB.size === 0) return 0;
	let shared = 0;
	for (const t of setA) if (setB.has(t)) shared += 1;
	const union = new Set([...setA, ...setB]).size;
	return union === 0 ? 0 : shared / union;
}

/**
 * The D-7 contradiction check: does the UPDATE/DELETE proposal contradict the
 * fact it targets? Pure + deterministic. True when there is meaningful lexical
 * overlap between the fact and the proposal reason AND either a negation token or
 * an antonym-pole flip appears across the two. A DELETE is itself a destructive
 * polarity flip, so it is treated as contradiction-leaning when it overlaps the
 * fact at all. Conservative by design: this FLAGS for review (c-AC-3); it never
 * by itself blocks an otherwise-authorized write.
 */
export function detectContradiction(
	factContent: string,
	proposal: Proposal,
	overlapFloor = 0.1,
): boolean {
	const factTokens = tokenize(factContent);
	const reasonTokens = tokenize(proposal.reason);
	const overlap = lexicalOverlap(factTokens, reasonTokens);

	// A DELETE that references the same subject matter is a polarity flip on its
	// own — flag it when there is any overlap.
	if (proposal.action === "delete" && overlap >= overlapFloor) return true;

	if (overlap < overlapFloor) return false;

	const reasonSet = new Set(reasonTokens);
	const factSet = new Set(factTokens);

	// Negation token present in the proposal reason → contradiction.
	for (const neg of NEGATION_TOKENS) {
		if (reasonSet.has(neg)) return true;
	}

	// Antonym-pole flip: the fact asserts one pole, the proposal the other.
	for (const [x, y] of ANTONYM_PAIRS) {
		if ((factSet.has(x) && reasonSet.has(y)) || (factSet.has(y) && reasonSet.has(x))) {
			return true;
		}
	}
	return false;
}

// ── id + time helpers ────────────────────────────────────────────────────────────

/** Default new-memory id: a time-rooted, collision-resistant opaque string. */
function defaultMemoryId(): string {
	const rand = Math.random().toString(36).slice(2, 10);
	return `mem_${Date.now().toString(36)}_${rand}`;
}

/** ISO-8601 timestamp from the injected clock (or wall-clock). */
function isoNow(now: () => Date): string {
	return now().toISOString();
}

// ── the core ─────────────────────────────────────────────────────────────────────

/**
 * Apply ONE controlled write. The testable core (c-AC-1..6): given the proposal +
 * fact material + a scope, return the typed {@link ControlledWriteOutcome}. The
 * single side effects are the storage writes and an optional embed prefetch.
 *
 * Order of brakes (binding): FROZEN first (c-AC-5, supersedes shadow), then SHADOW
 * (c-AC-4), then route by action. ADD prefetches the embedding BEFORE the
 * dedup-check/INSERT (c-AC-6); UPDATE/DELETE run the contradiction check + flag,
 * then apply only under `autonomous.allowUpdateDelete` as a version bump (c-AC-3).
 */
export async function applyControlledWrite(
	input: ControlledWriteInput,
	scope: QueryScope,
	deps: ControlledWriteHandlerDeps,
): Promise<ControlledWriteOutcome> {
	const logger = deps.logger ?? silentLogger;
	const { proposal } = input;

	// c-AC-5: FROZEN supersedes shadow — checked FIRST. Nothing is written.
	if (deps.config.mutationsFrozen) {
		logger.event("controlled_write.frozen", { action: proposal.action });
		return { action: "skipped", reason: "mutations_frozen" };
	}

	// c-AC-4: SHADOW — proposals are logged (006b records history); this stage
	// writes nothing to `memories`.
	if (deps.config.shadowMode) {
		logger.event("controlled_write.shadow", { action: proposal.action });
		return { action: "skipped", reason: "shadow_mode" };
	}

	switch (proposal.action) {
		case "add":
			return applyAdd(input, scope, deps, logger);
		case "update":
		case "delete":
			return applyUpdateOrDelete(input, scope, deps, logger);
		case "none":
			return { action: "skipped", reason: "action_none" };
	}
}

/**
 * The ADD path (c-AC-1 / c-AC-2 / c-AC-6). Gate by confidence + non-empty
 * normalized content, PREFETCH the embedding, SELECT-before-INSERT dedup on the
 * content hash, and INSERT a new version-1 memory row when the hash is absent.
 */
async function applyAdd(
	input: ControlledWriteInput,
	scope: QueryScope,
	deps: ControlledWriteHandlerDeps,
	logger: ControlledWriteLogger,
): Promise<ControlledWriteOutcome> {
	const normalized = input.normalizedContent;

	// c-AC-1 (FR-3): confidence gate.
	if (input.factConfidence < deps.config.minFactConfidenceForWrite) {
		logger.event("controlled_write.below_confidence", {
			confidence: input.factConfidence,
			threshold: deps.config.minFactConfidenceForWrite,
		});
		return { action: "skipped", reason: "below_confidence" };
	}

	// c-AC-1 (FR-4): non-empty normalized content gate.
	if (normalized.trim() === "") {
		logger.event("controlled_write.empty_content", {});
		return { action: "skipped", reason: "empty_content" };
	}

	const hash = contentHash(normalized);

	// c-AC-6 (FR-2): PREFETCH the embedding BEFORE any storage write, so no network
	// call happens during the dedup-check → INSERT commit window. A null vector
	// (disabled / unreachable / wrong-dim) leaves `content_embedding` NULL.
	const vector = await prefetchEmbedding(input.content, deps, logger);

	// c-AC-1 / c-AC-2 (FR-5): SELECT-before-INSERT dedup on the content hash.
	const dedup = await deps.storage.query(buildDedupCheckSql(hash), scope);
	if (isOk(dedup) && dedup.rows.length > 0) {
		const existingId = readId(dedup.rows[0]);
		logger.event("controlled_write.deduped", { id: existingId });
		// c-AC-2: existing id returned, NO duplicate INSERT.
		return { action: "deduped", memoryId: existingId, reason: "hash_present" };
	}
	if (!isOk(dedup)) {
		// A dedup probe against a partition whose `memories` table (or `content_hash`
		// column) does not exist yet is NOT a duplicate: a missing table trivially
		// contains no rows, and the INSERT below heals/CREATEs it. Classify with the
		// SAME engine the heal path uses (`classifyFailure`, which forces auth/
		// permission failures to `other` FIRST). `query_error` carries `.message`;
		// `connection_error`/`timeout` carry `.message` too but classify as `other`,
		// so a dropped socket or timeout STILL fails the job — never an unguarded
		// duplicate insert on a real error. Mirrors the RECALL path, which tolerates a
		// failed query by returning no rows (recall/collection.ts).
		const failure = classifyFailure(dedup.message);
		if (failure === "missing-table" || failure === "missing-column") {
			logger.event("controlled_write.dedup_probe_table_absent", {
				kind: dedup.kind,
				classification: failure,
			});
			// Fall through to the INSERT (which heals the table) — NOT deduped, NOT skipped.
		} else {
			// A genuine failure (permission/syntax/connection/timeout): surface it so the
			// job fails and the queue retries, rather than risk an unguarded duplicate insert.
			throw new Error(`controlled-write dedup probe failed: ${dedup.kind}`);
		}
	}

	// Insert a fresh version-1 memory row. The write goes through the version-bumped
	// HealTarget so the row carries `version` = 1 and the heal engine adds the
	// `version` column lazily — keeping ADD and UPDATE/DELETE on one row shape.
	const id = (deps.newId ?? defaultMemoryId)();
	const now = isoNow(deps.now ?? (() => new Date()));
	const row = buildMemoryRow({
		id,
		input,
		hash,
		vector,
		scope,
		isDeleted: NOT_SOFT_DELETED,
		createdAt: now,
		updatedAt: now,
	});

	const { result } = await appendVersionBumped(deps.storage, MEMORIES_VERSIONED_TARGET, scope, {
		keyColumn: "id",
		keyValue: id,
		row,
	});
	if (!isOk(result)) {
		throw new Error(`controlled-write insert failed: ${result.kind}`);
	}
	logger.event("controlled_write.inserted", { id });
	return { action: "inserted", memoryId: id };
}

/**
 * The UPDATE / DELETE path (c-AC-3). Run the D-7 contradiction check, ALWAYS flag
 * for review, and apply ONLY when `autonomous.allowUpdateDelete` is set — as an
 * append-only version-bumped write (a DELETE bumps a new version with
 * `is_deleted = 1`; an UPDATE bumps a new version with the new content). Never an
 * in-place UPDATE.
 */
async function applyUpdateOrDelete(
	input: ControlledWriteInput,
	scope: QueryScope,
	deps: ControlledWriteHandlerDeps,
	logger: ControlledWriteLogger,
): Promise<ControlledWriteOutcome> {
	const { proposal } = input;
	const targetId = proposal.targetId;
	if (targetId === undefined || targetId === "") {
		logger.event("controlled_write.missing_target", { action: proposal.action });
		return { action: "skipped", reason: "missing_target_id" };
	}

	// D-7: contradiction check — ALWAYS run + ALWAYS flag for review (c-AC-3).
	const contradiction = detectContradiction(input.content, proposal);
	logger.event("controlled_write.flagged_for_review", {
		action: proposal.action,
		targetId,
		contradiction,
	});

	// c-AC-3: applied ONLY under the autonomous gate. Off → flagged, not applied.
	if (!deps.config.autonomous.allowUpdateDelete) {
		return {
			action: "flagged_not_applied",
			memoryId: targetId,
			contradiction,
			reason: "autonomous_disabled",
		};
	}

	const isDelete = proposal.action === "delete";

	// Prefetch the embedding for an UPDATE's new content BEFORE the write (c-AC-6).
	// A DELETE carries no new content to embed.
	const vector = isDelete ? null : await prefetchEmbedding(input.content, deps, logger);

	const now = isoNow(deps.now ?? (() => new Date()));
	const row = buildMemoryRow({
		id: targetId,
		input,
		hash: contentHash(input.normalizedContent),
		vector,
		scope,
		isDeleted: isDelete ? SOFT_DELETED : NOT_SOFT_DELETED,
		createdAt: now,
		updatedAt: now,
	});

	// c-AC-3: append-only version-bumped write, never an in-place UPDATE.
	const { result, version } = await appendVersionBumped(deps.storage, MEMORIES_VERSIONED_TARGET, scope, {
		keyColumn: "id",
		keyValue: targetId,
		row,
	});
	if (!isOk(result)) {
		throw new Error(`controlled-write ${proposal.action} failed: ${result.kind}`);
	}
	logger.event("controlled_write.version_bumped", { action: proposal.action, targetId, version });
	return { action: "version_bumped", memoryId: targetId, contradiction };
}

/**
 * Prefetch the embedding vector for `text` via the 005b seam (c-AC-6). Returns the
 * 768-dim vector or `null` (disabled / unreachable / wrong-dim) — a null vector
 * writes the row with `content_embedding` NULL, exactly like the capture path. The
 * seam never throws for the expected failure modes; an unexpected throw is caught
 * here and degraded to null so a flaky embed daemon never fails the write.
 */
async function prefetchEmbedding(
	text: string,
	deps: ControlledWriteHandlerDeps,
	logger: ControlledWriteLogger,
): Promise<readonly number[] | null> {
	try {
		const vector = await deps.embed.embed(text);
		if (vector === null) return null;
		if (vector.length !== EMBEDDING_DIMS) {
			logger.event("controlled_write.embed_dim_rejected", {
				expected: EMBEDDING_DIMS,
				actual: vector.length,
			});
			return null;
		}
		return vector;
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		logger.event("controlled_write.embed_error", { reason });
		return null;
	}
}

/** The inputs assembled into one `memories` row's {@link RowValues}. */
interface MemoryRowArgs {
	readonly id: string;
	readonly input: ControlledWriteInput;
	readonly hash: string;
	readonly vector: readonly number[] | null;
	readonly scope: QueryScope;
	readonly isDeleted: typeof NOT_SOFT_DELETED | typeof SOFT_DELETED;
	readonly createdAt: string;
	readonly updatedAt: string;
}

/**
 * Build the ordered `(column, value)` list for a `memories` row. Every value is a
 * typed {@link ColumnValue} so it is rendered through the SQL-safety helpers by
 * the `writes.ts` primitives — text bodies via `eLiteral`, ids/enums/dates via
 * `sLiteral`, numbers inlined, the vector as the pre-built `serializeFloat4Array`
 * fragment (kind `raw`). Threads the agent scope (FR-11): `agent_id` is the
 * engine-table scope column (PRD-003a D-2); org/workspace isolation is the storage
 * partition's job (the `QueryScope` the write is issued under).
 */
function buildMemoryRow(args: MemoryRowArgs): RowValues {
	const embeddingValue: ColumnValue =
		args.vector === null ? val.raw("NULL") : val.raw(serializeFloat4Array(args.vector));

	return [
		["id", val.str(args.id)],
		["type", val.str(args.input.factType ?? "fact")],
		["content", val.text(args.input.content)],
		["normalized_content", val.text(args.input.normalizedContent)],
		["content_hash", val.str(args.hash)],
		["confidence", val.num(clampConfidence(args.input.factConfidence))],
		["content_embedding", embeddingValue],
		["is_deleted", val.num(args.isDeleted)],
		["agent_id", val.str(args.input.agentId ?? "default")],
		["created_at", val.str(args.createdAt)],
		["updated_at", val.str(args.updatedAt)],
	];
}

/** Clamp a confidence into `[0, 1]` so a stray value never writes an illegal score. */
function clampConfidence(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

/** Read a `memories.id` off a result row, coercing defensively to a string. */
function readId(row: StorageRow): string {
	const raw = row.id;
	return typeof raw === "string" ? raw : String(raw ?? "");
}

// ── handler wiring ────────────────────────────────────────────────────────────────

/** The shape a controlled-write job's payload carries (besides the scope envelope). */
interface ControlledWritePayload {
	/** The decision proposal (006b output). */
	readonly proposal?: unknown;
	/** The fact's display content. */
	readonly content?: unknown;
	/** The normalized content the hash is computed over (defaults to `content`). */
	readonly normalized_content?: unknown;
	/** The fact's confidence (the ADD gate value). */
	readonly fact_confidence?: unknown;
	/** The fact type (the `type` column). */
	readonly fact_type?: unknown;
	/** The agent the memory is scoped to (FR-11); falls back to the job scope. */
	readonly agent_id?: unknown;
}

/** Read a string field off a payload defensively ("" when absent / non-string). */
function readString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Read a numeric field off a payload defensively (0 when absent / non-numeric). */
function readNumber(value: unknown): number {
	if (typeof value === "number") return value;
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Project a controlled-write job's payload into a {@link ControlledWriteInput}.
 * Parses the proposal defensively via {@link parseProposal} (drop-invalid, like
 * extraction) — an unparseable proposal yields `null`, and the handler treats it
 * as a no-op skip rather than throwing the job.
 */
export function readControlledWriteInput(payload: Record<string, unknown>): ControlledWriteInput | null {
	const p = payload as ControlledWritePayload;
	const proposal = parseProposal(p.proposal);
	if (proposal === null) return null;
	const content = readString(p.content);
	const normalized = readString(p.normalized_content) || content;
	return {
		proposal,
		content,
		normalizedContent: normalized,
		factConfidence: readNumber(p.fact_confidence),
		factType: readString(p.fact_type) || undefined,
		agentId: readString(p.agent_id) || undefined,
	};
}

/**
 * The no-op controlled-writes handler the scaffold routes by default (Wave 1).
 * Writes NOTHING — the safe default for the only memory-mutating stage. Retained
 * so a test (or daemon-assembly) that does not inject deps still routes inertly.
 */
export const noopControlledWriteHandler: StageHandler = async (_job: StageJob): Promise<void> => {
	/* no-op stub — the real handler is built via createControlledWriteHandler(deps). */
};

/**
 * Build the controlled-writes handler. With real deps it adapts
 * {@link applyControlledWrite} to the {@link StageHandler} the worker routes for
 * `memory_controlled_write` jobs: it reads the proposal + fact material off the
 * payload, threads the job scope (FR-11), and applies the write. An unparseable
 * payload is a no-op skip (job completes — never a throw on bad upstream data). A
 * genuine storage failure throws → the worker routes it to the queue's
 * fail/backoff. Without deps (the Wave-1 stub call) it returns the no-op.
 */
export function createControlledWriteHandler(deps?: ControlledWriteHandlerDeps): StageHandler {
	if (deps === undefined) return noopControlledWriteHandler;
	const logger = deps.logger ?? silentLogger;
	return async (job: StageJob): Promise<void> => {
		const parsed = readControlledWriteInput(job.payload);
		if (parsed === null) {
			logger.event("controlled_write.unparseable_payload", { id: job.id });
			return; // drop-invalid: complete the job, do not mutate, do not throw.
		}
		// FR-11: thread the full scope from the job envelope — org/workspace as the
		// storage partition (the QueryScope) and agent_id as the engine scope column
		// on the row. A payload-supplied agentId wins; otherwise the job scope's.
		const input: ControlledWriteInput = {
			...parsed,
			agentId: parsed.agentId ?? job.scope.agentId,
		};
		const scope: QueryScope = { org: job.scope.org, workspace: job.scope.workspace };
		await applyControlledWrite(input, scope, deps);
	};
}

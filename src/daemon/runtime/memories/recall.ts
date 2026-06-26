/**
 * The `/api/memories/recall` engine adapter — PRD-022a (a-AC-2 / FR-2).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WIRING ONLY (ledger D-1). This module adds NO new recall ranking, no new
 * business logic, and no new DeepLake schema. It composes the SAME guarded SQL
 * helpers the recall engine + the dashboard reads use (`sqlIdent` / `sqlLike` /
 * `sLiteral`) over the SAME existing tables the capture → summary → store path
 * already writes — exactly the cross-session recall the golden-path itest
 * (`golden-path-live.itest.ts`) proved via direct SQL. PRD-022a wires that proven
 * shape to the HTTP route.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── The hybrid recall shape (grep-core's LEXICAL arm, run PER-ARM) ───────────
 * Recall reads the THREE tables a memory can live in:
 *   - `memories`  the distilled kept facts the store engine (`controlled-writes.ts`)
 *                 lands a row into — column `content`. This is the table the 022a
 *                 store→recall loop reads back from.
 *   - `memory`    the AI session summaries the summary worker (PRD-017) writes —
 *                 column `summary`.
 *   - `sessions`  the raw captured turns the capture handler writes — column
 *                 `message` (JSONB, matched as `::text`).
 *
 * ── Why PER-ARM, not a single UNION ALL ──────────────────────────────────────
 * Each arm is its own guarded `storage.query` rather than one `UNION ALL`. On a
 * FRESH workspace partition the store's heal-on-insert creates `memories`, but
 * nothing has created `memory` / `sessions` yet — so they DO NOT EXIST. A single
 * `UNION ALL` fails as a whole (`query_error`: relation "memory"/"sessions" does
 * not exist), which used to fail-soft the WHOLE recall to empty and silently wipe
 * the real `memories` hit (the live dogfood bug). Running each arm separately makes
 * a missing/failing SIBLING arm degrade to "empty for that arm" — exactly the
 * per-arm tolerance the recall engine's collector uses (`recall/collection.ts`
 * `toScoredIds` returns `[]` on a non-`ok` arm rather than failing the recall).
 * Recall still fails-soft OVERALL: every arm failing yields an empty result, never
 * a 500.
 *
 * ── The semantic arm (PRD-025 AC-3: the `<#>` cosine path ships lit) ──────────
 * When an {@link EmbedClient} is injected AND the query embeds to a real 768-dim
 * vector, recall ALSO runs the `<#>` cosine arm over `memories.content_embedding`
 * and `sessions.message_embedding` via the EXISTING `vectorSearch` engine
 * (`src/daemon/storage/vector.ts` — NOT forked here, D-5), hydrates the matched
 * rows' text, and MERGES those hits with the lexical arms (deduped). In that case
 * `degraded` is `false` — the honest "semantic recall ran" signal. When embeddings
 * are off / unavailable / the query embed returns null (daemon down / timeout /
 * wrong-dim), recall runs the BM25/ILIKE lexical arms ONLY and `degraded` is `true`
 * — the graceful fallback (D-4). Recall NEVER throws and NEVER hangs on the embed
 * path: a null embed simply means lexical-only. Ranking/fusion of the two arms is
 * PRD-027; here the bar is the semantic arm RUNS and `degraded` tells the truth.
 *
 * ── Tenancy ──────────────────────────────────────────────────────────────────
 * Every arm runs under the per-request {@link QueryScope} (org/workspace), which
 * is the storage partition boundary — a request reads only within its resolved
 * tenant. The handler resolves the scope from the `x-honeycomb-*` headers before
 * calling here; a request with no resolvable scope never reaches this module.
 *
 * ── SQL safety ───────────────────────────────────────────────────────────────
 * Every identifier routes through `sqlIdent`; the search term through `sqlLike`
 * (so a literal `%`/`_` is never a wildcard); the storage partition rides the
 * `storage.query(sql, scope)` call. No value is hand-quoted (`audit:sql` scans
 * `src/daemon`). The module never opens a raw connection — it reads ONLY through
 * the injected {@link StorageQuery}.
 */

import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent, sqlLike } from "../../storage/sql.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { cosineSimilarity, EMBEDDING_DIMS, type ScoredId, vectorSearch } from "../../storage/vector.js";
import { buildProjectScopeConjunct } from "../recall/scope-clause.js";
import {
	DEFAULT_DEDUP_ENABLED,
	DEFAULT_DEDUP_SIMILARITY_THRESHOLD,
	DEFAULT_MMR_LAMBDA,
	DEFAULT_RECENCY_ACTIVATION_EXPONENT,
	DEFAULT_RECENCY_HALF_LIFE_DAYS,
	DEFAULT_RECENCY_HALF_LIFE_DAYS_BY_CLASS,
	DEFAULT_RERANKER,
	DEFAULT_RERANKER_TIMEOUT_MS,
	DEFAULT_RERANKER_WINDOW,
	type ContextAssemblyConfig,
	type DedupConfig,
	type RecencyConfig,
	type RecencyHalfLifeByClass,
	type RerankerConfig,
} from "../recall/config.js";
import type { EmbedClient } from "../services/embed-client.js";
import type { RecallMode } from "../vault/api.js";
import { Semaphore } from "./bounded-pool.js";
import { amplificationConfig } from "./amplification-config.js";
import type { QuerySource } from "../../storage/query-meter.js";
import { actrActivation, type AccessEvent, type ActrParams, DEFAULT_ACTR_PARAMS } from "./activation.js";
import { applyCalibration, type CalibrationModel } from "./calibration.js";
import type { RefStatus } from "../../storage/catalog/memories.js";

/**
 * The `source` label every recall-arm DeepLake read carries through `StorageClient.query`'s
 * options (PRD-062a / PRD-062d). The 062a query meter attributes the recall amplification
 * (semantic `<#>` + the lexical arms + hydrate + rerank/dedup fetch) to `recall-arm` so the
 * before/after compute story is measurable. The label is meter-only — it NEVER changes the
 * query result (parity, AC-62d.2.2).
 */
const SOURCE_RECALL_ARM: QuerySource = "recall-arm";

/**
 * The process-wide bounded pool that caps in-flight DeepLake queries across ALL recall arms
 * (PRD-062d / L-D2 / AC-62d.2.1). Lazily built from {@link amplificationConfig} the first time
 * a recall runs without an injected pool, so a burst of concurrent recalls SHARES one ceiling
 * (a per-recall pool would let N recalls fire N×width queries — the shared pool is the real
 * cap, and mirrors the PRD's "a shared limit also caps total DeepLake concurrency"). A unit
 * test injects its own {@link Semaphore} via {@link MemoryRecallDeps.recallPool} for a
 * deterministic in-flight assertion; this shared default is the production wiring.
 */
let sharedRecallPool: Semaphore | undefined;

/** Resolve the recall pool: the injected one, else the lazily-built process-wide shared pool. */
function resolveRecallPool(deps: MemoryRecallDeps): Semaphore {
	if (deps.recallPool !== undefined) return deps.recallPool;
	if (sharedRecallPool === undefined) sharedRecallPool = new Semaphore(amplificationConfig().recallMaxConcurrency);
	return sharedRecallPool;
}

/** Reset the shared recall pool (test-only seam, paired with `resetAmplificationConfigCache`). */
export function resetSharedRecallPool(): void {
	sharedRecallPool = undefined;
}

/** The default number of recall hits returned when the caller supplies no limit. */
export const DEFAULT_RECALL_LIMIT = 20;
/** The hard ceiling on recall hits (a fat-fingered limit is clamped, never honored). */
export const MAX_RECALL_LIMIT = 200;

/**
 * The reciprocal-rank-fusion constant `k` (PRD-027 D-1). RRF fuses each arm's RANKED
 * list by `score(doc) = Σ_arms weight_arm / (k + rank_arm(doc))`, with `rank` 1-based.
 * `k=60` is the well-trodden hybrid-search default (Cormack et al.): large enough that
 * the difference between rank 1 and rank 2 is gentle (no single arm dominates on a thin
 * lead), small enough that top ranks still separate. Named + tunable; the eval harness
 * (PRD-027 W2) is the instrument for re-tuning it on the golden set, never a vibe.
 */
export const RRF_K = 60;

/**
 * The arm-CLASS weights (PRD-027 D-3 / AC-2) folded into each arm's RRF contribution so
 * DISTILLED `[memory]` hits outrank RAW `[sessions]` dumps. A distilled arm contributes
 * its full reciprocal rank; a raw `sessions` arm contributes a FRACTION, so a raw turn
 * needs a materially stronger rank signal (or corroboration across arms) to outrank a
 * clean distilled fact.
 *
 * THE MATH (why `0.4` makes a raw dump lose a head-to-head): with `k=60`, a rank-1
 * distilled hit scores `1.0 / (60 + 1) = 0.016393`. A rank-1 raw session hit scores only
 * `0.4 / (60 + 1) = 0.006557` — well below the distilled rank-1. In fact a raw session at
 * rank 1 (`0.006557`) sits below a distilled hit as deep as rank ~100 (`1/160 = 0.00625`
 * is comparable), so within any realistic recall window a distilled fact that ALSO matched
 * the query always ranks above the raw dump. The raw row is never dropped — it is tagged
 * `secondary` and ordered beneath the distilled hits. Tunable; eval-gated like `RRF_K`.
 */
export const ARM_CLASS_WEIGHT: Readonly<Record<RecallKind, number>> = {
	memory: 1.0,
	session: 0.4,
};

/** The provenance class for an arm/source (D-3): `sessions` → raw `session`; else distilled `memory`. */
export function kindOfSource(source: RecallSource): RecallKind {
	return source === "sessions" ? "session" : "memory";
}

/** Which table/arm surfaced a recall hit. */
export type RecallSource = "memories" | "memory" | "sessions";

/**
 * The provenance CLASS of a hit (PRD-027 D-3 / AC-2). `memory` = a DISTILLED hit
 * (a kept fact from the `memories` arm or a session summary from the `memory` arm);
 * `session` = a RAW captured-turn dump from the `sessions` arm. Distilled hits rank
 * above raw dumps via the arm-class weight folded into the fused RRF score, and raw
 * `session` hits are tagged `secondary: true` so the surface can demote them to a
 * drill-down. The class is derived from the {@link RecallSource}: `memories`/`memory`
 * → `memory`; `sessions` → `session`.
 */
export type RecallKind = "memory" | "session";

/**
 * One recalled hit: the arm that surfaced it, a grouping id/path, the matched text,
 * and (PRD-027) a REAL fused relevance `score` plus its provenance class. Hits are
 * ordered by `score` DESC — never arm order, never a client-side fabrication.
 */
export interface MemoryRecallHit {
	/** The table/arm that surfaced this hit. */
	readonly source: RecallSource;
	/** The hit's identity: `memories.id`, or the `path` of the summary / session row. */
	readonly id: string;
	/** The matched text (the fact content, the summary, or the raw turn). */
	readonly text: string;
	/**
	 * The fused relevance score (PRD-027 D-1, AC-1). Reciprocal-rank fusion across the
	 * per-arm ranked lists, with the {@link RecallKind} arm-class weight folded in (D-3).
	 * Higher = more relevant; the result is ordered by this DESC. NOT a cosine, NOT a
	 * client fake — a comparable fused rank signal.
	 */
	readonly score: number;
	/** The provenance class (D-3): a distilled `memory` vs a raw `session` dump. */
	readonly kind: RecallKind;
	/**
	 * `true` for a raw `session` dump (drill-down/secondary, D-3 / AC-2); `false` for a
	 * distilled `memory` hit. The surface renders `secondary` hits demoted, never dropped.
	 */
	readonly secondary: boolean;
	/**
	 * The row's creation/version timestamp as stored (PRD-047d): `memories.created_at`,
	 * `memory.creation_date`, or `sessions.creation_date` — an ISO-8601 string already on
	 * the row (no new column). Carried so the recency dampener ({@link applyRecencyDampening})
	 * can multiply the fused score by an age-decay. `""` (or any unparseable value) means
	 * "no usable timestamp" → the dampener applies `decay = 1` (no penalty), never an error
	 * (d-AC-3).
	 */
	readonly createdAt: string;
	/**
	 * The recency-activation multiplier `A_simple(m,t) ∈ [0,1]` that was applied to this hit's fused
	 * score (PRD-058a, AC-55a.3.1). `A_simple = 2^(−Δt / h(class))` with `Δt = max(0, now − t_ref)` and
	 * the half-life `h` chosen by the hit's {@link source} class. It is the EXACT multiplier the recency
	 * stage applied (before the `A^activationExponent` exponent re-weights it for ordering), surfaced so
	 * the dashboard + agent consumers can render/reason about staleness. ALWAYS present and in `[0,1]`:
	 *  - computed from row AGE alone, so it is emitted even when embeddings are off (degraded recall),
	 *    independent of the embed path (AC-55a.3.2);
	 *  - a missing/unparseable {@link createdAt} → `1` (maximally fresh), never dropped/errored (AC-55a.3.3).
	 * Constructed at `1` (the no-penalty default) before the recency stage runs and overwritten there.
	 */
	readonly freshnessScore: number;
	/**
	 * PRD-058e: the ACT-R base-level activation `A_actr ∈ [A_min, 1]` actually applied to this hit, when
	 * the reinforcement machinery is wired (an {@link MemoryRecallDeps.activationSource} is injected).
	 * `A_actr` is the Stage-2 upgrade of {@link freshnessScore}'s Stage-1 `A_simple`, computed from the
	 * memory's usefulness-weighted access history (`activation.ts`) rather than row age alone. It is
	 * surfaced separately so the dashboard / consumers can distinguish the reinforcement-aware activation
	 * from the age-only freshness. ABSENT (the field omitted) when no activation source is wired — recall
	 * then runs the byte-for-byte 058a Stage-1 path and only {@link freshnessScore} is emitted. When the
	 * source IS wired, `freshnessScore` carries the SAME `A_actr` value (the swap is behind that field per
	 * the PRD) and this field mirrors it for explicitness.
	 */
	readonly activation?: number;
	/**
	 * PRD-058e: the memory's reinforcement count — the number of useful accesses folded into activation
	 * (the `access_count` cache + retained `memory_access` events). Surfaced on the hit + response so the
	 * dashboard renders "used N times". ABSENT when no activation source is wired (058a path).
	 */
	readonly accessCount?: number;
	/**
	 * PRD-058e: the CALIBRATED confidence `C(m) = g(f(m)) ∈ [0,1]` — the raw extraction confidence mapped
	 * through the fitted isotonic calibration curve (`calibration.ts`). Surfaced so a consumer sees the
	 * trustworthy confidence, not the raw model value. ABSENT when no calibration model is wired (the
	 * dormant cold-start default — `c` exponent 0 — so calibration never perturbs ranking, AC-55e.2.2).
	 */
	readonly calibratedConfidence?: number;
	/**
	 * PRD-058e: the RAW extraction confidence `f(m)` carried from `memories.confidence` so the calibration
	 * stage can map it to {@link calibratedConfidence}. `""`/absent on arms that carry no confidence
	 * column (`memory` summaries, `sessions` raw turns). Internal carrier — defaults to `undefined`.
	 */
	readonly rawConfidence?: number;
	/**
	 * PRD-058c: the staleness probability `σ(m,t) ∈ [0,1]` — the chance ≥ 1 of the memory's indexed code
	 * references no longer resolves against the codebase-graph snapshot. The `(1 − σ)^s` demotion is fed
	 * INTO the SAME recency-multiplier stage as one more bounded `(0,1]` multiplier (NOT a parallel score
	 * path), so staleness and recency compose into ONE demotion step. ABSENT when no
	 * {@link MemoryRecallDeps.stalenessSource} is wired (the dormant default); a memory the source has no
	 * verdict for, or whose σ is missing/unparseable, is treated as `unknown` (σ NEUTRAL, factor 1 — never
	 * demoted), exactly as 058a treats a missing timestamp as maximally fresh.
	 */
	readonly staleness?: number;
	/**
	 * PRD-058c: the `fresh` / `stale` / `unknown` reference-status the diagnostic stamped on the memory.
	 * Surfaced so the dashboard + agent consumers can render WHY a memory was demoted. ABSENT when no
	 * staleness source is wired; `unknown` (NEUTRAL) for a memory with no indexed refs or an unavailable
	 * graph oracle.
	 */
	readonly refStatus?: RefStatus;
	/**
	 * PRD-058c: the specific unresolved references behind a `stale` verdict (the `stale_refs` payload),
	 * surfaced so a consumer can see the dangling tokens. ABSENT when no staleness source is wired or the
	 * memory is not `stale`.
	 */
	readonly staleRefs?: readonly string[];
}

/** The result of a recall: the surfaced hits, the arms that produced them, and the fallback flag. */
export interface MemoryRecallResult {
	/** The surfaced hits, ordered by fused RRF `score` DESC (PRD-027 D-1) — never arm order. */
	readonly hits: MemoryRecallHit[];
	/** The distinct arms that surfaced at least one hit (the hybrid-coverage signal). */
	readonly sources: RecallSource[];
	/**
	 * The HONEST semantic-vs-lexical signal (PRD-025 AC-3 / D-4): `false` when the
	 * `<#>` cosine semantic arm actually RAN (embeddings available + the query
	 * embedded to a 768-dim vector); `true` on genuine fallback — embeddings off, no
	 * embed client injected, the embed daemon unreachable, a per-call timeout, or the
	 * query embed returning null/wrong-dim — in which case recall ran the BM25/ILIKE
	 * lexical arms only.
	 */
	readonly degraded: boolean;
}

/** Clamp a caller-supplied limit into `[1, MAX_RECALL_LIMIT]`, defaulting a missing/bad value. */
export function resolveRecallLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_RECALL_LIMIT;
	const truncated = Math.trunc(limit);
	if (truncated < 1) return DEFAULT_RECALL_LIMIT;
	return Math.min(truncated, MAX_RECALL_LIMIT);
}

/**
 * Build the `memories` arm: kept facts, excluding soft-deleted rows
 * (`is_deleted = 0`), matched with a guarded `ILIKE`. The term routes through
 * `sqlLike`, every identifier through `sqlIdent`. The per-arm `LIMIT` bounds the
 * arm so it cannot dominate; the caller's overall limit is applied after the merge.
 * `perArmLimit` is a clamped integer (resolveRecallLimit) → a bare numeric
 * interpolation, the same shape the rest of the data layer uses for a dynamic
 * LIMIT (audit-safe; never a `String(...)` wrapper, never a hand-quoted value).
 */
export function buildMemoriesArmSql(term: string, perArmLimit: number, projectClause = ""): string {
	const pattern = `'%${sqlLike(term)}%'`;
	const memoriesTbl = sqlIdent("memories");
	const idCol = sqlIdent("id");
	const contentCol = sqlIdent("content");
	const isDeletedCol = sqlIdent("is_deleted");
	// PRD-047d: project the row's creation timestamp (already on the table) so the
	// recency dampener can age-decay the fused score — no new column.
	const createdAtCol = sqlIdent("created_at");
	const perArm = Math.max(1, Math.trunc(perArmLimit));
	// PRD-049b (49b-AC-2): the project-segment predicate ANDed into the SAME statement as the
	// lexical match, so a project-B row is filtered server-side and never enters the fusion.
	return (
		`SELECT 'memories' AS source, ${idCol} AS id, ${contentCol}::text AS text, ${createdAtCol}::text AS created_at ` +
		`FROM "${memoriesTbl}" ` +
		`WHERE ${contentCol}::text ILIKE ${pattern} AND ${isDeletedCol} = 0${projectClause} ` +
		`LIMIT ${perArm}`
	);
}

/**
 * Build the `memory` arm: AI session summaries, keyed by `path`, matched with a
 * guarded `ILIKE` over `summary`. Same guard discipline as {@link buildMemoriesArmSql}.
 */
export function buildMemoryArmSql(term: string, perArmLimit: number, projectClause = ""): string {
	const pattern = `'%${sqlLike(term)}%'`;
	const memoryTbl = sqlIdent("memory");
	const pathCol = sqlIdent("path");
	const summaryCol = sqlIdent("summary");
	// PRD-047d: the `memory` (summaries) table stamps `creation_date`; alias it to the
	// uniform `created_at` projection the dampener reads (no new column).
	const createdAtCol = sqlIdent("creation_date");
	const perArm = Math.max(1, Math.trunc(perArmLimit));
	// PRD-049b (49b-AC-2): project-segment predicate ANDed in so a summary from another
	// project never surfaces.
	return (
		`SELECT 'memory' AS source, ${pathCol} AS id, ${summaryCol}::text AS text, ${createdAtCol}::text AS created_at ` +
		`FROM "${memoryTbl}" ` +
		`WHERE ${summaryCol}::text ILIKE ${pattern}${projectClause} ` +
		`LIMIT ${perArm}`
	);
}

/**
 * Build the `sessions` arm: raw captured turns (JSONB `message`, matched as
 * `::text`), keyed by `path`. Same guard discipline as {@link buildMemoriesArmSql}.
 */
export function buildSessionsArmSql(term: string, perArmLimit: number, projectClause = ""): string {
	const pattern = `'%${sqlLike(term)}%'`;
	const sessionsTbl = sqlIdent("sessions");
	const pathCol = sqlIdent("path");
	const messageCol = sqlIdent("message");
	// PRD-047d: the `sessions` table stamps `creation_date`; alias it to the uniform
	// `created_at` projection the dampener reads (no new column).
	const createdAtCol = sqlIdent("creation_date");
	const perArm = Math.max(1, Math.trunc(perArmLimit));
	// PRD-049b (49b-AC-2): project-segment predicate ANDed in so a raw turn from another
	// project never surfaces — the broadest leak surface (raw dialogue) is filtered server-side.
	return (
		`SELECT 'sessions' AS source, ${pathCol} AS id, ${messageCol}::text AS text, ${createdAtCol}::text AS created_at ` +
		`FROM "${sessionsTbl}" ` +
		`WHERE ${messageCol}::text ILIKE ${pattern}${projectClause} ` +
		`LIMIT ${perArm}`
	);
}

/** Coerce a recall row's `source` cell into a {@link RecallSource} (defaults to `sessions`). */
function readSource(value: unknown): RecallSource {
	const s = String(value ?? "");
	return s === "memories" ? "memories" : s === "memory" ? "memory" : "sessions";
}

/** Coerce a row cell to a string (never undefined). */
function cell(value: unknown): string {
	return value === undefined || value === null ? "" : String(value);
}

/**
 * Map the merged per-arm result rows into typed hits + the distinct-source set,
 * DEDUPED by `source+id` (PRD-025 AC-3). The merge places the semantic arm's hits
 * first, then the lexical arms; a memory surfaced by BOTH the `<#>` arm and a lexical
 * arm appears ONCE (the first — i.e. semantic — occurrence wins). This is plain
 * arm-COMBINATION, not ranking/fusion (PRD-027 owns ranking). Capped at `limit`.
 */
function fuseHits(arms: readonly RankedArm[], limit: number): { hits: MemoryRecallHit[]; sources: RecallSource[] } {
	const docs = new Map<string, FusedDoc>();
	for (const arm of arms) {
		arm.entries.forEach((entry, index) => {
			const rank = index + 1; // 1-based rank: the arm's own order IS the rank signal.
			const kind = kindOfSource(entry.source);
			const contribution = ARM_CLASS_WEIGHT[kind] / (RRF_K + rank);
			const docKey = fusionKey(entry.source, entry.id);
			const existing = docs.get(docKey);
			if (existing === undefined) {
				docs.set(docKey, {
					source: entry.source,
					id: entry.id,
					text: entry.text,
					score: contribution,
					createdAt: entry.createdAt,
				});
			} else {
				existing.score += contribution; // corroboration across arms accumulates.
				if (existing.text === "" && entry.text !== "") existing.text = entry.text;
				// PRD-047d: take the first non-empty timestamp seen across the corroborating arms.
				if (existing.createdAt === "" && entry.createdAt !== "") existing.createdAt = entry.createdAt;
			}
		});
	}

	const ordered = [...docs.values()].sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score; // fused score DESC (the ranking).
		const ka = kindOfSource(a.source);
		const kb = kindOfSource(b.source);
		if (ka !== kb) return ka === "memory" ? -1 : 1; // tie-break: distilled before raw.
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // final deterministic tie-break.
	});

	const hits: MemoryRecallHit[] = [];
	const sourceSet = new Set<RecallSource>();
	for (const doc of ordered) {
		if (hits.length >= limit) break;
		const kind = kindOfSource(doc.source);
		hits.push({
			source: doc.source,
			id: doc.id,
			text: doc.text,
			score: doc.score,
			kind,
			secondary: kind === "session",
			createdAt: doc.createdAt, // PRD-047d: carried for the recency dampener.
			// PRD-058a: seed the no-penalty default; the recency-activation stage overwrites it with the
			// real `A_simple` for every hit it returns, so the field is ALWAYS present + in [0,1].
			freshnessScore: 1,
		});
		sourceSet.add(doc.source);
	}
	return { hits, sources: [...sourceSet] };
}

/** One element of a single arm's RANKED list (D-1): the arm's order is the rank signal. */
interface RankedArmEntry {
	readonly source: RecallSource;
	readonly id: string;
	readonly text: string;
	/** The row's creation timestamp (ISO, PRD-047d); `""` when the arm carries none. */
	readonly createdAt: string;
}

/** A single arm's ranked list (1-based rank = array index + 1). */
interface RankedArm {
	readonly entries: readonly RankedArmEntry[];
}

/** A doc accumulating its fused RRF score across arms, keyed by `source+id` (D-1/AC-3). */
interface FusedDoc {
	source: RecallSource;
	id: string;
	text: string;
	score: number;
	/** The row's creation timestamp (ISO, PRD-047d); first non-empty across arms wins. */
	createdAt: string;
}

/** The fusion identity for a doc: `source+id` (cross-arm dedup key, AC-3). */
function fusionKey(source: RecallSource, id: string): string {
	return `${source} ${id}`;
}

/** Map raw arm result rows into ranked entries in storage order (the lexical rank signal). */
function rowsToRankedArm(rows: readonly StorageRow[]): RankedArm {
	const entries: RankedArmEntry[] = rows.map((row) => ({
		source: readSource(row.source),
		id: cell(row.id),
		text: cell(row.text),
		createdAt: cell(row.created_at), // PRD-047d: the projected creation timestamp (or "").
	}));
	return { entries };
}

/**
 * PRD-058e: the per-memory access history + folded count the ACT-R activation needs, plus the params.
 * Returned by the {@link ActivationSource} for each hit so {@link applyActrActivation} can compute
 * `A_actr` from the usefulness-weighted series. A `null`/empty history → the memory floors at `A_min`.
 */
export interface MemoryActivationInputs {
	/** The retained access events `(t_k, u_k)` for the memory, oldest-first (`access-log.ts`). */
	readonly history: readonly AccessEvent[];
	/** The denormalized reinforcement count (folded + retained), surfaced as {@link MemoryRecallHit.accessCount}. */
	readonly accessCount: number;
}

/**
 * PRD-058e: the ACT-R activation seam. Given the hit ids that survived to the activation stage, return
 * the per-memory {@link MemoryActivationInputs} (access history + count). A daemon implementation reads
 * the `memory_access` log (`access-log.ts`) in one batched pass; a unit test injects a fixed map. The
 * returned map is keyed by `source+id` ({@link fusionKey}) so it aligns with the hit identity. A memory
 * absent from the map (or a thrown source) degrades that hit to the 058a Stage-1 activation (fail-soft).
 */
export interface ActivationSource {
	/** The ACT-R params (`d`, `A_min`, `B*`); defaults to {@link DEFAULT_ACTR_PARAMS}. */
	readonly params?: ActrParams;
	/** Fetch the activation inputs for the given hits, keyed by `source+id`. Fail-soft: a throw → 058a path. */
	load(hits: readonly MemoryRecallHit[], scope: QueryScope): Promise<Map<string, MemoryActivationInputs>>;
}

/**
 * PRD-058c: one memory's staleness verdict as the {@link StalenessSource} surfaces it to recall — the
 * `σ` the stale-ref diagnostic wrote to `memories.ref_status` / `stale_refs`, read back so recall can
 * feed `(1 − σ)^s` into the recency-multiplier stage. A memory ABSENT from the source map (or a verdict
 * with a missing/unparseable σ) is treated as `unknown` (NEUTRAL — factor 1, never demoted).
 */
export interface StalenessVerdictInput {
	/** `σ(m,t) ∈ [0,1]`. A non-finite / out-of-range value is clamped/neutralized by the stage. */
	readonly sigma: number;
	/** The `fresh` / `stale` / `unknown` classification (surfaced on the hit). */
	readonly refStatus: RefStatus;
	/** The unresolved references (surfaced on the hit when `stale`). */
	readonly staleRefs?: readonly string[];
}

/**
 * PRD-058c: the staleness seam. Given the hits that survived to the activation stage, return each
 * memory's {@link StalenessVerdictInput} keyed by `source+id` ({@link fusionKey}). A daemon
 * implementation reads the `memories.ref_status` / `stale_refs` columns the diagnostic wrote, in one
 * batched pass; a unit test injects a fixed map. FAIL-SOFT: a memory absent from the map degrades to
 * `unknown` (NEUTRAL) for that hit, and a source THROW degrades the WHOLE staleness stage to neutral —
 * never a thrown recall, exactly mirroring the {@link ActivationSource} contract.
 */
export interface StalenessSource {
	/**
	 * The staleness exponent `s` (the master equation's `(1 − σ)^s`). POSTURE-GATED by the caller:
	 * `observe` → `s = 0` (the factor is the identity, staleness is VISIBLE but INERT, ranking
	 * UNCHANGED — AC-55c.2.1); `execute` → `s > 0` (DEMOTE — AC-55c.2.2). Defaults to
	 * {@link DEFAULT_STALENESS_EXPONENT} (0 — dormant) when omitted, so an un-tuned source never perturbs
	 * ranking. Floored ≥ 0 by the stage (a negative would BOOST a stale row, forbidden).
	 */
	readonly exponent?: number;
	/** Fetch each hit's staleness verdict, keyed by `source+id`. Fail-soft: a throw → neutral for all. */
	load(hits: readonly MemoryRecallHit[], scope: QueryScope): Promise<Map<string, StalenessVerdictInput>>;
}

/**
 * PRD-058b: the conflict-suppression seam (the `κ(m,t)` gate). Given the hits that survived to the
 * FINAL currentness filter, return the set of memory IDS to SUPPRESS — the `κ = ρ` (ρ = 0) losing
 * side of an OPEN conflict. `κ = 0` hard-superseded losers are ALREADY excluded upstream by the
 * `MAX(version)` / supersession path (they never reach recall as live rows), so this seam handles
 * ONLY the open-conflict ρ-suppression. A daemon implementation reads the open-conflict projection
 * (`memory_conflicts`, status `open`, the non-winner side); a unit test injects a fixed set.
 *
 * MUST be FAIL-SOFT (PRD-058b Technical Considerations): if `memory_conflicts` is missing or
 * unreadable, the source returns an EMPTY set so recall degrades to returning BOTH sides, never a
 * 500. The gate is the LAST currentness filter, layered OVER (not replacing) the `MAX(version)`
 * invariant. A source THROW degrades the whole gate to neutral (no suppression).
 */
export interface ConflictSuppressionSource {
	/**
	 * Return the set of suppressed loser memory IDs (`κ = ρ` open-conflict losers) among `hits`,
	 * for the scope. Keyed by the durable `memories.id` (only the `memories` arm carries a
	 * suppressable id; `memory`/`sessions` hits are never conflict losers). Fail-soft: a throw or a
	 * missing table → an empty set (both sides returned).
	 */
	loadSuppressed(hits: readonly MemoryRecallHit[], scope: QueryScope): Promise<ReadonlySet<string>>;
}

/** Construction deps for {@link recallMemories}. */
export interface MemoryRecallDeps {
	/** The DeepLake storage client (daemon-only). Recall reads ONLY through this. */
	readonly storage: StorageQuery;
	/**
	 * The embed seam (PRD-025 AC-3). When present AND the query embeds to a real
	 * 768-dim vector, recall runs the `<#>` cosine semantic arm via {@link vectorSearch}
	 * and sets `degraded: false`. ABSENT (or returning null) → lexical-only, `degraded:
	 * true`. The daemon defaults this to the real `createEmbedAttachment(...).client`
	 * (D-1 default-on); a unit test injects a fake to drive both branches deterministically.
	 */
	readonly embed?: EmbedClient;
	/**
	 * The user-selected recall mode (PRD-044c). The LIVE `/api/memories/recall` handler reads the
	 * `recallMode` vault `setting` at recall time and threads it here; the closed enum is validated
	 * daemon-side on write (`vault/api.ts` `isValidRecallMode`, fail-closed). It GATES the semantic
	 * arm (see {@link recallMemories}):
	 *   - `keyword`              → the `<#>` cosine arm is SKIPPED entirely (no embed call) and
	 *                              `degraded` is FORCED `false` — an intentional lexical run is NOT a
	 *                              degraded fallback (the PRD-029 fallback-vs-mode coherence rule).
	 *   - `semantic` / `hybrid`  → run the semantic arm EXACTLY as today; `degraded` stays honest
	 *                              (`semanticArms === null`). The lexical floor always runs, so both
	 *                              yield vector+lexical — that is correct, not a fabricated difference.
	 *   - UNSET (default)        → byte-for-byte today's PRD-025 behavior (run the semantic arm,
	 *                              `degraded` honest) — a no-op for any caller that omits this.
	 */
	readonly recallMode?: RecallMode;
	/**
	 * The reranker config (PRD-047b / D-4). When ABSENT, recall applies the DEFAULT
	 * strategy ({@link DEFAULT_RERANKER} = `none`) — so absence of config means RRF-only
	 * (NO rerank stage runs), matching the b-AC-3 measured ~0 lift default. A caller
	 * passes an explicit `{ strategy: "embedding-cosine", window, timeoutMs }` to ACTIVATE
	 * the cosine rerank (the LIVE route / eval opt in this way and tune `window` /
	 * `timeoutMs`); `{ strategy: "none" }` is the explicit RRF-only form.
	 *
	 * The rerank runs AFTER {@link fuseHits}, re-scores the fused top-`window`
	 * candidates by cosine(query vector, candidate embedding), and reorders. It runs
	 * ONLY when a real query vector exists (the semantic arm ran); on a lexical-only /
	 * degraded / keyword recall there is no query vector, so the rerank is SKIPPED and
	 * the RRF order stands (b-AC-4). A candidate with no hydrated embedding keeps its
	 * RRF position (b-AC-1); a rerank that exceeds the budget keeps the RRF order
	 * (b-AC-2); a rerank failure degrades to the RRF order, never a throw (b-AC-4).
	 */
	readonly reranker?: RerankerConfig;
	/**
	 * Injectable monotonic clock (ms) for the rerank timeout budget (b-AC-2). Defaults
	 * to {@link Date.now}; a unit test injects a fake clock to drive the timeout
	 * deterministically with no real waiting.
	 */
	readonly now?: () => number;
	/**
	 * The semantic-dedup config (PRD-047c / c-AC-1..4). When ABSENT, dedup runs with
	 * its defaults ({@link DEFAULT_DEDUP_ENABLED} = ON, threshold
	 * {@link DEFAULT_DEDUP_SIMILARITY_THRESHOLD}) — so the LIVE route and the eval get
	 * the near-dup collapse without any caller change (c-AC-3). A caller passes
	 * `{ enabled: false }` for the escape hatch, or tunes `similarityThreshold`.
	 *
	 * Dedup runs AFTER {@link fuseHits} AND after the rerank stage, over the fused
	 * top-N. It collapses hits whose candidate embeddings exceed the threshold into ONE,
	 * keeping the highest-PROVENANCE copy (`memories` > `memory` > `sessions`, higher
	 * fused score within a class). Dropped copies are REMOVED (not demoted). It sources
	 * the candidate embeddings itself via {@link fetchCandidateEmbeddings} (no extra
	 * embed-daemon calls); a dedup failure degrades to the un-deduped list, never a throw
	 * (c-AC-4).
	 */
	readonly dedup?: DedupConfig;
	/**
	 * The recency config (PRD-047d + PRD-058a). The LIVE recency stage is the PRD-058a class-aware
	 * ACTIVATION ({@link applyRecencyActivation}): when ABSENT, every class falls back to its DOCUMENTED
	 * per-class default ({@link DEFAULT_RECENCY_HALF_LIFE_DAYS_BY_CLASS}: `memories` 180d / `memory` 45d /
	 * `sessions` 10d) and the activation exponent defaults to {@link DEFAULT_RECENCY_ACTIVATION_EXPONENT}
	 *, so recency is LIVE by default, never the 100-year neutral (AC-55a.2.3). A caller passes
	 * `{ halfLifeDaysByClass }` to override per-class half-lives (AC-55a.2.2) and/or `{ activationExponent }`
	 * to re-weight `A^a` (`0` = neutral). The legacy flat `{ halfLifeDays }` feeds only the original
	 * {@link applyRecencyDampening} back-compat path, not the live stage.
	 *
	 * The activation runs LAST, after {@link fuseHits}, the rerank, AND dedup, so it never disturbs
	 * dedup's provenance-based keep-decision (AC-55a.1.3). It stamps each hit's
	 * {@link MemoryRecallHit.freshnessScore} = `A_simple = 2^(−Δt / h(class))`, multiplies the fused score
	 * by `A^activationExponent`, and re-orders; it DEMOTES the oldest hit but never DROPS it (AC-55a.1.2).
	 * A hit with no usable {@link MemoryRecallHit.createdAt} gets `A = 1` (no penalty), never a throw
	 * (AC-55a.3.3).
	 */
	readonly recency?: RecencyConfig;
	/**
	 * PRD-058e: the ACT-R activation seam. When injected, recall computes each hit's reinforcement-aware
	 * activation `A_actr` from its usefulness-weighted access history (`activation.ts` over the
	 * `memory_access` log) and uses it IN PLACE of the 058a Stage-1 `A_simple` behind the SAME
	 * {@link MemoryRecallHit.freshnessScore} field + the SAME `a` exponent — the swap is invisible to
	 * callers (PRD-058e Scope). ABSENT → recall runs the byte-for-byte 058a Stage-1 path
	 * ({@link applyRecencyActivation}), so every existing caller + test is unchanged. The seam is the
	 * single async dependency the upgrade adds; it is FAIL-SOFT — a source throw / empty history degrades
	 * that hit to the 058a Stage-1 activation, never a throw.
	 */
	readonly activationSource?: ActivationSource;
	/**
	 * PRD-058c: the staleness seam (the `σ(m,t)` term). When injected, recall reads each surviving hit's
	 * staleness verdict (the `memories.ref_status` / `stale_refs` the stale-ref diagnostic wrote) and feeds
	 * `(1 − σ)^s` INTO the SAME recency-multiplier stage as one more bounded `(0,1]` multiplier — NOT a
	 * parallel score path — so staleness and recency compose into ONE demotion step. The `s` exponent is
	 * POSTURE-GATED on the source ({@link StalenessSource.exponent}): `observe` ships `s = 0` (the factor is
	 * the identity, staleness VISIBLE but INERT — AC-55c.2.1), `execute` ships `s > 0` (DEMOTE, never
	 * hard-drop — AC-55c.2.2). ABSENT → no staleness factor is applied and no `staleness`/`refStatus` is
	 * surfaced (the dormant default, byte-for-byte the pre-058c path). FAIL-SOFT: a source throw degrades
	 * the staleness stage to neutral; a hit absent from the verdict map is `unknown` (factor 1, never
	 * demoted), exactly as a missing timestamp is treated as maximally fresh by 058a.
	 */
	readonly stalenessSource?: StalenessSource;
	/**
	 * PRD-058b: the conflict-suppression seam (the `κ(m,t)` gate). When injected, recall applies the κ
	 * gate as the LAST currentness filter — it drops the `κ = ρ` (ρ = 0) losing side of any OPEN conflict
	 * among the surviving hits (the `κ = 0` hard-superseded losers are already excluded upstream by
	 * `MAX(version)`). ABSENT → no κ gate (the dormant default, byte-for-byte the pre-058b path). FAIL-SOFT:
	 * a missing/unreadable `memory_conflicts` table degrades to returning BOTH sides (never a 500), and a
	 * source throw degrades the gate to neutral.
	 */
	readonly conflictSuppression?: ConflictSuppressionSource;
	/**
	 * PRD-058e: the fitted calibration model `g` (`calibration.ts`). When injected (and non-identity),
	 * recall maps each hit's raw `memories.confidence` `f` through `C = g(f)` and emits it as
	 * {@link MemoryRecallHit.calibratedConfidence}. ABSENT or the IDENTITY model → calibration is DORMANT
	 * (`C = f`, the `c` exponent stays 0), so an unproven curve never perturbs ranking (AC-55e.2.2). The
	 * calibration NEVER reorders here in this wave — it is surfaced for the dashboard + downstream `c`
	 * activation, eval-gated separately (AC-55e.2.3).
	 */
	readonly calibration?: CalibrationModel;
	/**
	 * PRD-058e: the access-log recorder. When injected, recall records a `recall` access event for each
	 * INJECTED hit (the recall half of the reinforcement loop — the usefulness grade arrives later from
	 * the session-end worker). ABSENT → no event is recorded (the deterministic unit path). FAIL-SOFT: a
	 * recorder throw never fails the recall (recording is best-effort, off the answer path).
	 */
	readonly recordRecallAccess?: (memoryId: string) => Promise<void>;
	/**
	 * The context-assembly config (PRD-047e / e-AC-1..4): the MMR lambda knob the token-budget
	 * selection uses. It bites ONLY when the request carries a {@link MemoryRecallRequest.tokenBudget}
	 * — with NO budget the assembly stage is SKIPPED entirely and the fixed top-`limit` path runs
	 * byte-for-byte as before (e-AC-4 back-compat). ABSENT → defaults to {@link DEFAULT_MMR_LAMBDA}.
	 */
	readonly contextAssembly?: ContextAssemblyConfig;
	/**
	 * PRD-062d (L-D2 / AC-62d.2.1): the bounded-concurrency pool that caps how many DeepLake
	 * queries the recall arms have in flight at once. ABSENT → recall uses the process-wide
	 * shared pool sized from {@link amplificationConfig} (`HONEYCOMB_RECALL_MAX_CONCURRENCY`,
	 * default 6) — the production wiring, so a burst of recalls shares ONE ceiling. A unit test
	 * injects its own {@link Semaphore} for a deterministic in-flight assertion. The pool is a
	 * PURE timing control: it changes WHEN an arm's query runs, never the merged result
	 * (parity, AC-62d.2.2 / AC-8). With a width ≥ the arm count it is a no-op on output.
	 */
	readonly recallPool?: Semaphore;
}

/** A recall request as it enters the adapter (the zod-validated, scoped body). */
export interface MemoryRecallRequest {
	/** The search term (the natural-language query, used verbatim for the lexical match). */
	readonly query: string;
	/** The resolved storage partition the recall runs under (org/workspace). */
	readonly scope: QueryScope;
	/** The caller's hit limit (clamped to `[1, MAX_RECALL_LIMIT]`; defaulted when absent). */
	readonly limit?: number;
	/**
	 * PRD-049b (49b-AC-2): the session's RESOLVED project id (049a `resolveScope(cwd)`). The
	 * project-segment predicate ({@link buildProjectScopeConjunct}) is ANDed into EVERY recall
	 * arm (lexical, semantic `<#>`, hydrate, rerank/dedup fetch) so a recall in project A
	 * NEVER returns a project-B row — even on a strong vector or high-degree-entity hit.
	 * ABSENT/blank → the unbound inbox session (D8 / 49b-AC-3): recall narrows to the
	 * `__unsorted__` inbox + workspace-global (unset `project_id`) rows only, never another
	 * project. Carried into every guarded statement; the predicate is SQL-safe (`sLiteral`).
	 */
	readonly projectId?: string;
	/**
	 * PRD-049b: whether the session resolved a REAL bound project (049a `resolveScope(cwd).bound`).
	 * ABSENT → inferred from `projectId` (a non-blank, non-`__unsorted__` id is bound). Drives the
	 * inbox-vs-project admission in {@link buildProjectScopeConjunct} and the D8 degraded-scoping
	 * signal (a recall with no resolvable project is unbound → inbox+global, with a visible warning).
	 */
	readonly projectBound?: boolean;
	/**
	 * OPTIONAL token budget (PRD-047e / e-AC-1). When supplied (and positive), recall replaces the
	 * fixed top-`limit` slice with a token-BUDGETED, diversity-aware (MMR) selection: it fills the
	 * budget with the highest-value NON-redundant hits ({@link selectWithinTokenBudget}) rather than a
	 * fixed count, counting tokens per hit via {@link estimateTokenCount}. ABSENT/undefined → the
	 * assembly stage is SKIPPED and the row-`limit` path runs byte-for-byte as before (e-AC-4 back-
	 * compat — what keeps the live eval, which never sets a budget, neutral). The budget is the SURFACE
	 * CONTRACT; per-consumer budget POLICY (what number each surface picks) is out of scope. An
	 * MMR/budget failure fails-soft to the fixed top-`limit` list, never a 500.
	 */
	readonly tokenBudget?: number;
}

/**
 * Build the project-segment ` AND (project_id = … OR project_id = '')` conjunct for a
 * recall request (PRD-049b 49b-AC-2). Reuses the SINGLE factored {@link buildProjectScopeConjunct}
 * so every arm (and PRD-049c skills) shares ONE predicate. A request with no `projectId` is
 * the unbound inbox session (D8 / 49b-AC-3): the conjunct narrows to inbox + workspace-global.
 * The returned string is ANDed verbatim into each arm's WHERE (SQL-safe via `sLiteral`).
 */
function projectConjunctFor(request: MemoryRecallRequest): string {
	return buildProjectScopeConjunct({
		projectId: request.projectId ?? "",
		...(request.projectBound !== undefined ? { bound: request.projectBound } : {}),
	});
}

/**
 * Run one recall arm and return its rows, treating a non-`ok` result (a missing
 * table on a fresh partition, any other `query_error`, a connection error, or a
 * timeout) as EMPTY for that arm rather than a recall-wide failure. This is the
 * per-arm tolerance that mirrors the recall engine's collector
 * (`recall/collection.ts` `toScoredIds`): a sibling arm whose table does not yet
 * exist must NOT erase the hits from the arms whose tables DO.
 */
async function runArm(sql: string, request: MemoryRecallRequest, deps: MemoryRecallDeps): Promise<StorageRow[]> {
	// PRD-062d (L-D2 / AC-62d.2.1): every recall-arm read runs UNDER the bounded pool so the
	// in-flight DeepLake-query count has a ceiling across all arms (semantic hydrate, the three
	// lexical arms, and the rerank/dedup batch fetches all flow through here). PRD-062a: tag the
	// read `recall-arm` so the meter attributes it. The pool changes timing, not the result rows.
	const pool = resolveRecallPool(deps);
	const result = await pool.run(() => deps.storage.query(sql, request.scope, { source: SOURCE_RECALL_ARM }));
	return isOk(result) ? result.rows : [];
}

/**
 * One semantic-arm spec: which table + columns the `<#>` cosine match runs over,
 * and the {@link RecallSource} tag the merged hits carry. Mirrors the per-table
 * lexical arms (`memories`/`sessions`) so the semantic + lexical hits share an id
 * space and dedup cleanly.
 */
interface SemanticArmSpec {
	/** The {@link RecallSource} tag the hydrated hits carry. */
	readonly source: Extract<RecallSource, "memories" | "sessions">;
	/** The bare table identifier (`memories` / `sessions`). */
	readonly table: string;
	/** The id/grouping column the lexical counterpart keys on (`id` / `path`). */
	readonly idColumn: string;
	/** The nullable `FLOAT4[]` embedding column (`content_embedding` / `message_embedding`). */
	readonly embeddingColumn: string;
	/** The text column hydrated for the hit (`content` / `message`). */
	readonly textColumn: string;
	/** The creation-timestamp column hydrated for the recency dampener (`created_at` / `creation_date`, PRD-047d). */
	readonly timestampColumn: string;
	/** Extra WHERE conjunct for the hydration SELECT (e.g. soft-delete exclusion), or "". */
	readonly hydrateFilter: string;
}

/** The two semantic arms — kept facts + raw turns. (`memory` summaries carry no embedding column.) */
const SEMANTIC_ARMS: readonly SemanticArmSpec[] = [
	{
		source: "memories",
		table: "memories",
		idColumn: "id",
		embeddingColumn: "content_embedding",
		textColumn: "content",
		timestampColumn: "created_at", // PRD-047d: `memories` stamps `created_at`.
		// Exclude soft-deleted rows, mirroring the lexical memories arm.
		hydrateFilter: `AND ${sqlIdent("is_deleted")} = 0`,
	},
	{
		source: "sessions",
		table: "sessions",
		idColumn: "path",
		embeddingColumn: "message_embedding",
		textColumn: "message",
		timestampColumn: "creation_date", // PRD-047d: `sessions` stamps `creation_date`.
		hydrateFilter: "",
	},
];

/**
 * Build the hydration SELECT for a semantic arm: given the scored ids the `<#>`
 * match returned, fetch `(source, id, text)` for those ids so the semantic hit
 * carries text like the lexical arms. Every id routes through `sLiteral` and every
 * identifier through `sqlIdent` (audit:sql-safe). The `vectorSearch` engine returns
 * IDs+score only by design (e-AC-4), so the text is hydrated here in ONE guarded
 * statement rather than re-running the vector match.
 */
function buildSemanticHydrateSql(spec: SemanticArmSpec, ids: readonly string[], projectClause = ""): string {
	const tbl = sqlIdent(spec.table);
	const idCol = sqlIdent(spec.idColumn);
	const textCol = sqlIdent(spec.textColumn);
	// PRD-047d: hydrate the creation timestamp too, aliased to the uniform `created_at`.
	const tsCol = sqlIdent(spec.timestampColumn);
	const sourceLit = sLiteral(spec.source);
	const inList = ids.map((id) => sLiteral(id)).join(", ");
	const filterClause = spec.hydrateFilter === "" ? "" : ` ${spec.hydrateFilter}`;
	// PRD-049b (49b-AC-2 defense-in-depth): the project segment is ALSO applied at hydration,
	// so even if a cross-project id reached this step it loads no text and is dropped upstream.
	return (
		`SELECT ${sourceLit} AS source, ${idCol} AS id, ${textCol}::text AS text, ${tsCol}::text AS created_at ` +
		`FROM "${tbl}" ` +
		`WHERE ${idCol} IN (${inList})${filterClause}${projectClause}`
	);
}

/**
 * Run ONE semantic arm: embed-vector → `<#>` cosine match (the EXISTING
 * {@link vectorSearch}, D-5) → hydrate the matched ids' text. Tolerant exactly like
 * the lexical `runArm`: a missing/failing table (fresh partition, no embedding
 * column yet) yields no entries for that arm rather than failing the recall. Returns
 * the hydrated entries ordered by descending cosine score — that cosine ORDER IS the
 * arm's rank signal RRF consumes (PRD-027 D-1); the raw cosine value is not carried,
 * only the rank.
 */
async function runSemanticArm(
	spec: SemanticArmSpec,
	queryVector: readonly number[],
	request: MemoryRecallRequest,
	deps: MemoryRecallDeps,
	limit: number,
): Promise<RankedArmEntry[]> {
	// PRD-049b (49b-AC-2): the project segment rides the `<#>` match (extraClause) AND the
	// hydrate, so a strong cross-project cosine hit is filtered server-side before its id leaves.
	const projectClause = projectConjunctFor(request);
	let scored: ScoredId[];
	try {
		// vectorSearch validates the dim (asserts 768) + over-fetches; the org/workspace
		// partition rides the QueryScope, so the in-row scope filter is empty here EXCEPT for
		// the project-segment conjunct ANDed inline (49b-AC-2). PRD-062d (L-D2): the `<#>` match
		// runs UNDER the same bounded pool as the lexical arms so the semantic fan-out (two arms
		// concurrently, each over a table) counts against the shared in-flight ceiling (AC-62d.2.1).
		const pool = resolveRecallPool(deps);
		const recall = await pool.run(() =>
			vectorSearch(deps.storage, request.scope, {
				table: spec.table,
				idColumn: spec.idColumn,
				embeddingColumn: spec.embeddingColumn,
				queryVector,
				scope: {},
				limit,
				...(projectClause !== "" ? { extraClause: projectClause } : {}),
			}),
		);
		scored = recall.ids;
	} catch {
		// A missing embedding column / table or any query error degrades THIS arm to
		// empty — never fails the whole recall (the per-arm tolerance, mirrors runArm).
		return [];
	}
	if (scored.length === 0) return [];

	// Hydrate the matched ids' text in one guarded statement, then re-order to the
	// cosine ranking the vector match produced (the IN-list read order is unspecified).
	const ids = scored.map((s) => s.id).filter((id) => id !== "");
	if (ids.length === 0) return [];
	const hydrated = await runArm(buildSemanticHydrateSql(spec, ids, projectClause), request, deps);
	const textById = new Map<string, string>();
	const tsById = new Map<string, string>(); // PRD-047d: id → creation timestamp (ISO, or "").
	for (const row of hydrated) {
		textById.set(cell(row.id), cell(row.text));
		tsById.set(cell(row.id), cell(row.created_at));
	}

	const entries: RankedArmEntry[] = [];
	const seen = new Set<string>();
	for (const s of scored) {
		if (seen.has(s.id)) continue;
		const text = textById.get(s.id);
		if (text === undefined) continue; // hydration miss (eventual consistency) — skip.
		seen.add(s.id);
		entries.push({ source: spec.source, id: s.id, text, createdAt: tsById.get(s.id) ?? "" });
	}
	return entries;
}

/**
 * The product of a semantic run: the per-table ranked arms PLUS the query vector that
 * produced them. The vector is carried out so the PRD-047b reranker can re-score the
 * fused top-N by cosine(query, candidate) WITHOUT re-embedding (the query is embedded
 * exactly once, here).
 */
interface SemanticRun {
	/** ONE {@link RankedArm} per semantic table, each in its own cosine ranking. */
	readonly arms: RankedArm[];
	/** The 768-dim query vector the arms matched against (reused by the reranker). */
	readonly queryVector: readonly number[];
}

/**
 * Embed the query + run BOTH semantic arms (PRD-025 AC-3). Returns `null` when the
 * semantic path could NOT run — no embed client, or the query embed returned null
 * (embeddings off / daemon unreachable / timeout / wrong-dim) — which is the signal
 * to fall back to lexical-only with `degraded: true`. Returns a {@link SemanticRun}
 * (one {@link RankedArm} per semantic table, each in its own cosine ranking, plus the
 * query vector) when the arms DID run — `degraded: false`, because "ran and found
 * nothing semantically" is still an honest non-degraded recall (the arms may be empty).
 */
async function runSemanticArms(
	request: MemoryRecallRequest,
	deps: MemoryRecallDeps,
	limit: number,
): Promise<SemanticRun | null> {
	if (deps.embed === undefined) return null; // no semantic seam → lexical-only.

	let queryVector: readonly number[] | null;
	try {
		queryVector = await deps.embed.embed(request.query);
	} catch {
		// The embed-client contract is null-on-failure, but guard an unexpected throw:
		// a flaky embed daemon degrades recall to lexical, never throws into the route.
		queryVector = null;
	}
	// Null (off/unreachable/timeout) OR a wrong-dim vector (defense in depth; the
	// client already dim-guards) → the semantic arm cannot run → fall back to lexical.
	if (queryVector === null || queryVector.length !== EMBEDDING_DIMS) return null;

	const armEntries = await Promise.all(
		SEMANTIC_ARMS.map((spec) => runSemanticArm(spec, queryVector!, request, deps, limit)),
	);
	// Each semantic table is its OWN ranked arm so RRF sees its cosine ranking distinctly.
	return { arms: armEntries.map((entries) => ({ entries })), queryVector };
}

// ── PRD-047b — the rerank stage (embedding-cosine over the fused top-N) ──────────

/**
 * Map a {@link RecallSource} to its `FLOAT4[]` embedding column for the rerank
 * fetch. `memory` summaries carry NO embedding column (mirrors {@link SEMANTIC_ARMS}),
 * so they yield `null` — a summary candidate keeps its RRF position, never errors.
 */
function embeddingColumnFor(source: RecallSource): string | null {
	if (source === "memories") return "content_embedding";
	if (source === "sessions") return "message_embedding";
	return null; // `memory` (summaries) — no embedding column.
}

/**
 * Build the guarded batch-fetch of `(id, embedding)` for the rerank candidates of ONE
 * table (PRD-047b / b-AC-1). Every identifier routes through `sqlIdent` and every id
 * through `sLiteral` (audit:sql-safe), exactly like {@link buildSemanticHydrateSql}.
 * Only rows whose embedding is non-empty are returned (`ARRAY_LENGTH(col,1) > 0`),
 * so a NULL-embedding candidate simply does not come back and keeps its RRF position.
 * One statement per table, never one-per-candidate.
 */
export function buildRerankEmbeddingSql(
	table: string,
	idColumn: string,
	embeddingColumn: string,
	ids: readonly string[],
): string {
	const tbl = sqlIdent(table);
	const idCol = sqlIdent(idColumn);
	const embCol = sqlIdent(embeddingColumn);
	const inList = ids.map((id) => sLiteral(id)).join(", ");
	return (
		`SELECT ${idCol} AS id, ${embCol} AS embedding ` +
		`FROM "${tbl}" ` +
		`WHERE ${idCol} IN (${inList}) AND ARRAY_LENGTH(${embCol}, 1) > 0`
	);
}

/** The per-table id column the lexical/semantic arms key on (`memories`→id, `sessions`→path). */
function idColumnFor(source: RecallSource): string {
	return source === "sessions" || source === "memory" ? "path" : "id";
}

/** Coerce a stored `FLOAT4[]` cell into a `number[]`, or `null` when it is not a usable vector. */
function readEmbeddingCell(value: unknown): number[] | null {
	if (!Array.isArray(value)) return null;
	const vec: number[] = [];
	for (const v of value) {
		const n = typeof v === "number" ? v : Number(v);
		if (!Number.isFinite(n)) return null;
		vec.push(n);
	}
	return vec.length === 0 ? null : vec;
}

/**
 * Fetch the candidate embeddings for the rerank window in ONE guarded batch per
 * embedding-bearing table (PRD-047b / b-AC-1). Returns a `source+id → vector` map.
 * A table whose fetch fails (missing column on a fresh partition, any query error)
 * simply contributes no embeddings — its candidates keep their RRF position. Never
 * throws: a fetch failure degrades the rerank to RRF order, it does not fail recall.
 */
async function fetchCandidateEmbeddings(
	candidates: readonly MemoryRecallHit[],
	request: MemoryRecallRequest,
	deps: MemoryRecallDeps,
): Promise<Map<string, number[]>> {
	// Group candidate ids by their embedding-bearing table.
	const idsBySource = new Map<Extract<RecallSource, "memories" | "sessions">, string[]>();
	for (const hit of candidates) {
		const col = embeddingColumnFor(hit.source);
		if (col === null || hit.id === "") continue; // no embedding column / empty id → skip.
		const source = hit.source as Extract<RecallSource, "memories" | "sessions">;
		const bucket = idsBySource.get(source);
		if (bucket === undefined) idsBySource.set(source, [hit.id]);
		else bucket.push(hit.id);
	}

	const byKey = new Map<string, number[]>();
	await Promise.all(
		[...idsBySource.entries()].map(async ([source, ids]) => {
			if (ids.length === 0) return;
			const embeddingColumn = embeddingColumnFor(source);
			if (embeddingColumn === null) return;
			const sql = buildRerankEmbeddingSql(source, idColumnFor(source), embeddingColumn, ids);
			// `runArm` swallows a non-ok result to [] (per-arm tolerance) — a failed fetch
			// just means no embeddings for this table, so its candidates keep RRF position.
			const rows = await runArm(sql, request, deps);
			for (const row of rows) {
				const id = cell(row.id);
				if (id === "") continue;
				const vec = readEmbeddingCell(row.embedding);
				if (vec !== null) byKey.set(fusionKey(source, id), vec);
			}
		}),
	);
	return byKey;
}

/**
 * Rerank the fused hits by cosine(query vector, candidate embedding) over the top-N
 * window (PRD-047b / b-AC-1). RULES:
 *  - `strategy: "none"` (or no query vector) → return the RRF order UNCHANGED.
 *  - Only the top-`window` fused hits are re-scored; the tail keeps RRF order and is
 *    appended after the reranked head.
 *  - A candidate with no hydrated embedding keeps its RRF position (it is scored on its
 *    fused RRF rank so it never leapfrogs a cosine-scored peer arbitrarily).
 *  - The reorder is STABLE within ties (a reranked head that ties keeps RRF order).
 *  - The whole stage is budgeted: if the wall clock passes `timeoutMs` after the
 *    candidate fetch, the pre-rerank (RRF) order is returned (b-AC-2). The fetch +
 *    cosine are wrapped so any throw degrades to the RRF order (b-AC-4).
 *
 * The query vector is the one the semantic arm already embedded — no re-embed here.
 */
async function rerankHits(
	hits: readonly MemoryRecallHit[],
	queryVector: readonly number[],
	config: RerankerConfig,
	request: MemoryRecallRequest,
	deps: MemoryRecallDeps,
): Promise<MemoryRecallHit[]> {
	const rrfOrder = [...hits];
	// `none` → RRF-only escape hatch; `llm` is a measured follow-up (not built here),
	// so it falls through to the RRF order until its branch lands. `embedding-cosine`
	// is the deterministic deliverable.
	if (config.strategy !== "embedding-cosine") return rrfOrder;
	if (hits.length === 0) return rrfOrder;

	const now = deps.now ?? Date.now;
	const start = now();
	const window = Math.max(1, Math.trunc(config.window));
	const head = rrfOrder.slice(0, window);
	const tail = rrfOrder.slice(window);

	try {
		const embByKey = await fetchCandidateEmbeddings(head, request, deps);
		// Budget check AFTER the fetch (the only async/I/O cost): a slow fetch yields the
		// pre-rerank order, never a partial/blank reorder (b-AC-2).
		if (now() - start > config.timeoutMs) return rrfOrder;

		// Score each head candidate by cosine; a candidate with no usable embedding is
		// un-scored (`null`) and will NOT move — it keeps its exact RRF slot.
		const scored = head.map((hit, index) => {
			const vec = embByKey.get(fusionKey(hit.source, hit.id));
			const cos = vec === undefined ? null : cosineSimilarity(queryVector, vec);
			return { hit, index, rerankScore: cos };
		});

		// A single `.sort` with a mixed (cosine-vs-index) rule is NON-TRANSITIVE when scored
		// and un-scored candidates interleave (it can cycle C<A<B<C), making the head order
		// implementation-dependent. Instead build a TOTAL ORDER by construction:
		//   1. take the cosine-scored candidates, ordered by score DESC (tie → original index);
		//   2. leave un-scored candidates FIXED in their original slots;
		//   3. write the cosine-ordered candidates back into the slots the scored candidates
		//      originally occupied, in order.
		// Un-scored candidates never move (conservative: never worse-than-RRF for a missing
		// embedding); scored candidates reorder only among their own slots. Deterministic and
		// transitive — the result is identical across runs for the same input.
		const scoredSlots = scored
			.filter((s) => s.rerankScore !== null)
			.map((s) => s.index);
		const scoredByCosine = scored
			.filter((s) => s.rerankScore !== null)
			.sort((a, b) => {
				if (b.rerankScore! !== a.rerankScore!) return b.rerankScore! - a.rerankScore!;
				return a.index - b.index; // tie → original RRF order (stable).
			});

		const reorderedHead = head.slice();
		scoredSlots.forEach((slot, i) => {
			reorderedHead[slot] = scoredByCosine[i]!.hit;
		});

		return [...reorderedHead, ...tail];
	} catch {
		// Any failure in the fetch/score path degrades to the RRF order, never a throw (b-AC-4).
		return rrfOrder;
	}
}

// ── PRD-047c — the semantic / near-duplicate dedup stage ─────────────────────

/**
 * The provenance RANK of a hit's source for the dedup keep-decision (PRD-047c / c-AC-1).
 * LOWER wins: `memories` (a kept fact) > `memory` (a summary) > `sessions` (a raw turn).
 * When a cluster of near-duplicates collapses, the surviving copy is the one with the
 * lowest rank; ties within a class are broken by the higher fused score (then the
 * earlier id, deterministically).
 */
function provenanceRank(source: RecallSource): number {
	if (source === "memories") return 0;
	if (source === "memory") return 1;
	return 2; // sessions
}

/**
 * Decide whether `candidate` should REPLACE `current` as a cluster's surviving copy
 * (PRD-047c / c-AC-1): better provenance class first, then higher fused score, then the
 * lexicographically-earlier id (a deterministic final tie-break, mirroring fuseHits).
 */
function outranksForKeep(candidate: MemoryRecallHit, current: MemoryRecallHit): boolean {
	const rc = provenanceRank(candidate.source);
	const rk = provenanceRank(current.source);
	if (rc !== rk) return rc < rk;
	if (candidate.score !== current.score) return candidate.score > current.score;
	return candidate.id < current.id;
}

/** Normalize hit text for the embeddingless-summary fold-in test (lowercased, collapsed whitespace). */
function normalizeForFold(text: string): string {
	return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * A near-duplicate cluster (PRD-047c). `members` are the hits collapsed together; the
 * surviving copy is recomputed as members join. `seedVectors` are the embedding-bearing
 * members' vectors used to test whether a new candidate is within threshold of THIS
 * cluster — an embeddingless `memory` summary contributes no seed vector (it can only
 * FOLD INTO an established cluster, never seed one).
 */
interface DedupCluster {
	keep: MemoryRecallHit;
	readonly members: MemoryRecallHit[];
	readonly seedVectors: number[][];
	readonly normalizedTexts: string[];
}

/**
 * Collapse semantic near-duplicates in the fused/reranked hit list into ONE copy each
 * (PRD-047c / c-AC-1, c-AC-2, c-AC-4), keeping the highest-provenance copy per cluster.
 *
 * RULES:
 *  - Two hits collapse when the cosine of their candidate embeddings exceeds
 *    `config.similarityThreshold` (default ~0.9, tuned HIGH so only obvious paraphrases
 *    merge — the c-AC-2 false-merge guard: distinct facts below threshold both survive).
 *  - The surviving copy is the highest-provenance member (`memories` > `memory` >
 *    `sessions`), tie-broken by higher fused score then earlier id ({@link outranksForKeep}).
 *    Dropped copies are REMOVED from the result, not demoted (c-AC-1).
 *  - A `memory` summary carries NO embedding column ({@link embeddingColumnFor}); it
 *    cannot be embedding-compared, so it FOLDS INTO an already-established embedding
 *    cluster only when its normalized text contains (or is contained in) a clustered
 *    member's text — otherwise it stands alone, never erroring (the embeddings-sourcing
 *    contract). It never SEEDS a merge.
 *  - Survivors keep their original `source`/`kind`/`secondary` provenance and relative
 *    order (c-AC-4). Embeddings are sourced via {@link fetchCandidateEmbeddings} (no
 *    extra embed-daemon calls); the whole stage is wrapped so any failure degrades to
 *    the input list unchanged, never a throw (c-AC-4).
 */
async function dedupHits(
	hits: readonly MemoryRecallHit[],
	config: DedupConfig,
	request: MemoryRecallRequest,
	deps: MemoryRecallDeps,
): Promise<MemoryRecallHit[]> {
	const input = [...hits];
	if (!config.enabled || input.length < 2) return input;

	try {
		// Source the candidate embeddings ourselves (rerank may be `none`, so they are
		// NOT already hydrated): ONE guarded batch-fetch per embedding-bearing table.
		const embByKey = await fetchCandidateEmbeddings(input, request, deps);
		const threshold = config.similarityThreshold;

		const clusters: DedupCluster[] = [];
		for (const hit of input) {
			const vec = embByKey.get(fusionKey(hit.source, hit.id));
			const normalized = normalizeForFold(hit.text);

			if (vec === undefined) {
				// No embedding (a `memory` summary, or a NULL-embedding row): fold into an
				// ESTABLISHED cluster by text containment only; never seed an embedding merge.
				const target = normalized === "" ? undefined : clusters.find((c) =>
					c.seedVectors.length > 0 && c.normalizedTexts.some((t) => t !== "" && (t.includes(normalized) || normalized.includes(t))),
				);
				if (target === undefined) {
					clusters.push({ keep: hit, members: [hit], seedVectors: [], normalizedTexts: [normalized] });
				} else {
					target.members.push(hit);
					target.normalizedTexts.push(normalized);
					if (outranksForKeep(hit, target.keep)) target.keep = hit;
				}
				continue;
			}

			// An embedding-bearing hit: join the first cluster within threshold, else seed one.
			const target = clusters.find((c) =>
				c.seedVectors.some((sv) => {
					const cos = cosineSimilarity(vec, sv);
					return cos !== null && cos > threshold;
				}),
			);
			if (target === undefined) {
				clusters.push({ keep: hit, members: [hit], seedVectors: [vec], normalizedTexts: [normalized] });
			} else {
				target.members.push(hit);
				target.seedVectors.push(vec);
				target.normalizedTexts.push(normalized);
				if (outranksForKeep(hit, target.keep)) target.keep = hit;
			}
		}

		// Rebuild the surviving copies in the INPUT order (preserve the rerank/RRF ranking;
		// a collapsed cluster occupies the position of its earliest member's appearance).
		const survivors = new Set(clusters.map((c) => c.keep));
		return input.filter((hit) => survivors.has(hit));
	} catch {
		// Any failure in the embedding-fetch/cluster path degrades to the un-deduped list,
		// never a throw (c-AC-4) — recall still answers 200 with the fused/reranked hits.
		return input;
	}
}

// ── PRD-047d — the recency dampening stage (multiplicative age-decay) ─────────

/** Milliseconds in a day, for the age-in-days computation (PRD-047d). */
const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/** Runtime floor mirroring the config clamp, so the math is safe even if a caller hand-builds a config. */
const MIN_RECENCY_HALF_LIFE_FLOOR = 1;

/**
 * Parse a hit's stored creation timestamp into epoch ms, or `null` when it is
 * absent/unparseable (PRD-047d / d-AC-3). The stored value is an ISO-8601 string
 * (`memories.created_at` / `memory`+`sessions`.`creation_date`), but recall must NEVER
 * throw on a malformed cell — an empty, whitespace, or non-date value yields `null`,
 * which the dampener treats as "no penalty" (`decay = 1`).
 */
function parseCreatedAtMs(createdAt: string): number | null {
	const trimmed = createdAt.trim();
	if (trimmed === "") return null;
	const ms = Date.parse(trimmed);
	return Number.isFinite(ms) ? ms : null;
}

/**
 * The age-decay multiplier for a hit (PRD-047d): `decay = 0.5 ^ (age_days / half_life_days)`,
 * a smooth exponential in `(0, 1]`. RULES (d-AC-1..d-AC-3):
 *  - A hit with NO usable timestamp (`null` parse) → `decay = 1` (no penalty), never a throw.
 *  - A FUTURE timestamp (clock skew / eventual-consistency stamp ahead of `now`) is clamped to
 *    age 0 → `decay = 1`, so a skewed row is never BOOSTED above a present-day one.
 *  - `half_life_days` is already floored ≥ 1 by the config clamp, so the exponent is finite and
 *    the result never divides by zero or inverts.
 * With the OFF-equivalent default half-life (100 years) the multiplier is ≈ 1 for every realistic
 * row — the change is NEUTRAL until the eval tunes the knob down (d-AC-4).
 */
export function recencyDecay(createdAtMs: number | null, nowMs: number, halfLifeDays: number): number {
	// d-AC-3: a missing (null) OR non-finite (NaN/±∞) timestamp → no penalty, never NaN.
	if (createdAtMs === null || !Number.isFinite(createdAtMs)) return 1;
	const ageDays = Math.max(0, (nowMs - createdAtMs) / MS_PER_DAY); // future → age 0 → decay 1.
	const halfLife = Math.max(MIN_RECENCY_HALF_LIFE_FLOOR, halfLifeDays);
	return Math.pow(0.5, ageDays / halfLife);
}

/**
 * Apply the recency dampener to the final hit list (PRD-047d / d-AC-1, d-AC-2, d-AC-3).
 * Each hit's fused `score` is MULTIPLIED by {@link recencyDecay} and the list is re-ordered
 * by the dampened score DESC, with the SAME deterministic tie-breaks as {@link fuseHits}
 * (distilled before raw, then earlier id). This is a DEMOTION, never a cutoff: every input
 * hit is present in the output (d-AC-2) — the oldest is merely pushed down. A hit with no
 * usable timestamp keeps its score unchanged (`decay = 1`, d-AC-3). The returned hits carry
 * the dampened score so a downstream gate/threshold sees the age-aware value. Pure + sync —
 * no I/O, no throw.
 */
export function applyRecencyDampening(
	hits: readonly MemoryRecallHit[],
	halfLifeDays: number,
	nowMs: number,
): MemoryRecallHit[] {
	const dampened = hits.map((hit, index) => {
		const decay = recencyDecay(parseCreatedAtMs(hit.createdAt), nowMs, halfLifeDays);
		return {
			hit,
			index, // the INCOMING rank (RRF → rerank → dedup), the authoritative order to preserve.
			decay,
			score: hit.score * decay,
		};
	});

	// OFF-equivalent fast path (d-AC-4): when NO hit carries a real age penalty (every decay is
	// ~1 — the default 100-year half-life, or no usable timestamps), the dampener is a strict
	// NO-OP on ordering. This is what keeps it composing with rerank/dedup, whose authoritative
	// order is encoded in POSITION, not in the (RRF) score — a blind score re-sort would undo it.
	const anyPenalty = dampened.some((d) => d.decay < 1);
	if (!anyPenalty) return [...hits];

	// At least one hit is genuinely aged: order by the dampened (`score × decay`) value DESC,
	// using the INCOMING index as the stable tie-break so equally-dampened hits keep their
	// upstream (rerank/dedup) order. Never drops a hit — the oldest is demoted, not removed (d-AC-2).
	dampened.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score; // dampened score DESC (the age-aware order).
		return a.index - b.index; // stable: preserve the incoming rerank/dedup/RRF order on a tie.
	});
	// Re-emit with the dampened score on the hit so a downstream threshold sees the age-aware value.
	return dampened.map(({ hit, score }) => ({ ...hit, score }));
}

// ── PRD-058c, the staleness factor `(1 − σ)^s` fed INTO the recency stage ─────

/**
 * The default staleness exponent `s` (the master equation's `(1 − σ)^s`). `0` makes the factor the
 * IDENTITY (`(1 − σ)^0 = 1`) so staleness ships DORMANT — visible but inert — exactly as 058a's terms
 * default to their neutral value. The maintenance `observe` posture ships `s = 0`; `execute` ships `s > 0`.
 */
export const DEFAULT_STALENESS_EXPONENT = 0;

/**
 * The resolved staleness inputs the activation stage folds in (PRD-058c): the per-hit verdict map (keyed
 * by `source+id` via {@link fusionKey}) the {@link StalenessSource} returned, plus the posture-gated `s`
 * exponent. Built ONCE before the activation stage runs (one batched source read) and passed into BOTH
 * the Stage-1 ({@link applyRecencyActivation}) and Stage-2 ({@link applyActrActivation}) paths so the
 * `(1 − σ)^s` factor multiplies into the SAME single demotion step, never a parallel score path.
 */
export interface ResolvedStaleness {
	/** The per-hit staleness verdict, keyed by `fusionKey(source, id)`. */
	readonly byKey: Map<string, StalenessVerdictInput>;
	/** The staleness exponent `s`, floored ≥ 0 (a negative would BOOST a stale row, forbidden). */
	readonly exponent: number;
}

/** Clamp a σ into `[0,1]`, mapping a missing/unparseable value to `0` (NEUTRAL — `unknown`, never demoted). */
function normalizeSigma(sigma: number | undefined): number {
	if (sigma === undefined || !Number.isFinite(sigma)) return 0;
	return Math.min(1, Math.max(0, sigma));
}

/**
 * The per-hit staleness contribution (PRD-058c): the bounded `(0,1]` factor `(1 − σ)^s` to MULTIPLY into
 * the recency ordering weight, plus the verdict fields to STAMP on the hit. When `resolved` is absent (no
 * staleness source) or the hit has no verdict, the factor is `1` (NEUTRAL) and no fields are stamped — the
 * pre-058c behavior byte-for-byte. RULES:
 *  - `s = 0` (observe posture / dormant) → factor `(1 − σ)^0 = 1`: ranking UNCHANGED, but σ/refStatus are
 *    STILL surfaced for the dashboard (AC-55c.2.1: visible but inert).
 *  - `s > 0` (execute) → factor `(1 − σ)^s ∈ (0,1]`: a stale memory is DEMOTED, never zeroed by staleness
 *    alone (σ = 1 with finite `s` still leaves the hit in the set — it sinks to the floor, AC-55c.2.2).
 *  - missing/unparseable σ → `unknown`, factor 1 (AC-55c.1.4 / the neutral-on-missing rule).
 * Pure.
 */
function stalenessContribution(
	hit: MemoryRecallHit,
	resolved: ResolvedStaleness | undefined,
): { factor: number; fields: Partial<MemoryRecallHit> } {
	if (resolved === undefined) return { factor: 1, fields: {} };
	const verdict = resolved.byKey.get(fusionKey(hit.source, hit.id));
	if (verdict === undefined) return { factor: 1, fields: {} };
	const sigma = normalizeSigma(verdict.sigma);
	// (1 − σ)^s. s = 0 → 1 (identity). σ = 0 → 1. Both bounded into (0,1]; σ = 1, s > 0 → 0 (floor, the hit
	// stays in the set, demoted — never removed by staleness alone).
	const base = 1 - sigma;
	const factor = resolved.exponent === 0 ? 1 : resolved.exponent === 1 ? base : Math.pow(base, resolved.exponent);
	const fields: Partial<MemoryRecallHit> = {
		staleness: sigma,
		refStatus: verdict.refStatus,
		...(verdict.staleRefs !== undefined ? { staleRefs: verdict.staleRefs } : {}),
	};
	return { factor, fields };
}

/**
 * Resolve the staleness verdicts for the surviving hits (PRD-058c), to be folded into the recency stage.
 * Returns `undefined` when no {@link StalenessSource} is wired (the dormant default → the stage runs the
 * byte-for-byte pre-058c path). FAIL-SOFT: a source throw yields a NEUTRAL `ResolvedStaleness` (an empty
 * verdict map → every hit `unknown`, factor 1), never a thrown recall. The `s` exponent is floored ≥ 0 (a
 * negative would BOOST a stale row, forbidden) and defaults to {@link DEFAULT_STALENESS_EXPONENT} (0,
 * dormant) so an un-tuned source never perturbs ranking.
 */
async function resolveStaleness(
	hits: readonly MemoryRecallHit[],
	deps: MemoryRecallDeps,
	scope: QueryScope,
): Promise<ResolvedStaleness | undefined> {
	const source = deps.stalenessSource;
	if (source === undefined) return undefined;
	const rawExp = source.exponent ?? DEFAULT_STALENESS_EXPONENT;
	const exponent = Math.max(0, Number.isFinite(rawExp) ? rawExp : DEFAULT_STALENESS_EXPONENT);
	try {
		const byKey = await source.load(hits, scope);
		return { byKey, exponent };
	} catch {
		// Fail-soft: a staleness-source failure leaves recall neutral (no demotion), never a thrown recall.
		return { byKey: new Map(), exponent };
	}
}

/**
 * PRD-058b: apply the `κ(m,t)` gate as the LAST currentness filter (AC-55b.1.1 / 55b.1.3). Drops the
 * `κ = ρ` (ρ = 0) losing side of any OPEN conflict among `hits` — so a recall that matches BOTH sides
 * of a contradiction returns at most the winner. The `κ = 0` hard-superseded losers are already excluded
 * upstream by `MAX(version)` (they are not live rows), so this gate handles only the open-conflict
 * ρ-suppression. ONLY the durable `memories` arm carries a suppressable id; a `memory`/`sessions` hit is
 * never a conflict loser, so it is never dropped here. FAIL-SOFT: no source wired → `hits` unchanged; a
 * source throw / missing table → an empty suppression set → BOTH sides returned, never a thrown recall.
 */
async function applyConflictGate(
	hits: readonly MemoryRecallHit[],
	deps: MemoryRecallDeps,
	scope: QueryScope,
): Promise<MemoryRecallHit[]> {
	const source = deps.conflictSuppression;
	if (source === undefined) return [...hits];
	let suppressed: ReadonlySet<string>;
	try {
		suppressed = await source.loadSuppressed(hits, scope);
	} catch {
		// Fail-soft: a conflict-source failure leaves recall returning both sides, never a thrown recall.
		return [...hits];
	}
	if (suppressed.size === 0) return [...hits];
	// Drop only the `memories`-arm losers; other arms can never be a conflict loser id.
	return hits.filter((h) => !(h.source === "memories" && suppressed.has(h.id)));
}

// ── PRD-058a, class-aware recency activation (the `A(m,t)` Stage-1 term) ──────

/** `ln 2`, precomputed for the `λ = ln 2 / h` half-life conversion (PRD-058a). */
const LN2 = Math.LN2;

/**
 * The reinforcement-aware reference timestamp `t_ref = max(created_at, last_reinforced_at)` for a hit
 * (PRD-058a). 058a reads `last_reinforced_at` as nullable-defaulting-to-`created_at`: until PRD-058e
 * adds the column the field is absent, so `t_ref = created_at` and 058a is correct + self-contained.
 * When 058e lands the reinforced timestamp, the LATER of the two wins (a reinforced row is "fresher").
 * Returns epoch ms, or `null` when NEITHER timestamp is usable → the activation treats the hit as
 * maximally fresh (`A = 1`, AC-55a.3.3), never a throw.
 */
function refTimestampMs(createdAt: string, lastReinforcedAt: string | null | undefined): number | null {
	const createdMs = parseCreatedAtMs(createdAt);
	const reinforcedMs =
		lastReinforcedAt === null || lastReinforcedAt === undefined ? null : parseCreatedAtMs(lastReinforcedAt);
	if (createdMs === null) return reinforcedMs; // no created stamp → fall to reinforced (or null).
	if (reinforcedMs === null) return createdMs;
	return Math.max(createdMs, reinforcedMs); // the LATER of the two is the freshness reference.
}

/**
 * Resolve the half-life in DAYS for a hit's class (PRD-058a, AC-55a.2.2 / 55a.2.3). The class is the
 * TABLE that surfaced the hit ({@link RecallSource}): `memories` → memories, `memory` → memory,
 * `sessions` → sessions. Precedence: the caller's `halfLifeDaysByClass[class]` override → the DOCUMENTED
 * per-class default ({@link DEFAULT_RECENCY_HALF_LIFE_DAYS_BY_CLASS}). A class with no configured
 * half-life falls back to ITS documented default, NEVER to the 100-year neutral (AC-55a.2.3). The
 * returned value is floored ≥ {@link MIN_RECENCY_HALF_LIFE_FLOOR} so the `λ = ln2/h` math is finite.
 */
export function halfLifeForSource(source: RecallSource, byClass: RecencyHalfLifeByClass | undefined): number {
	const configured = byClass?.[source];
	const resolved = typeof configured === "number" && configured > 0 ? configured : DEFAULT_RECENCY_HALF_LIFE_DAYS_BY_CLASS[source];
	return Math.max(MIN_RECENCY_HALF_LIFE_FLOOR, resolved);
}

/**
 * The Stage-1 activation multiplier `A_simple(m,t) = 2^(−Δt / h) = exp(−λ · Δt_days)`, `λ = ln2/h`
 * (PRD-058a). RULES (AC-55a.1.2 / 55a.3.3):
 *  - `t_ref === null` (no usable timestamp) → `A = 1` (maximally fresh), never a throw / NaN.
 *  - `Δt` is clamped to `≥ 0`, so a FUTURE `t_ref` (clock skew) yields `A = 1`, never `A > 1` (a skewed
 *    row is never BOOSTED above a present-day one).
 *  - `h` is floored ≥ 1 day by {@link halfLifeForSource}, so the exponent is finite and `A ∈ (0,1]` , 
 *    a smooth multiplier with NO cutoff (recency never drops a row by age alone).
 * By construction `A(Δt = h) = exp(−ln2) = 0.5`, the half-life is exactly the age at which A halves.
 */
export function recencyActivation(refMs: number | null, nowMs: number, halfLifeDays: number): number {
	if (refMs === null || !Number.isFinite(refMs)) return 1; // AC-55a.3.3: missing/unparseable → maximally fresh.
	const ageDays = Math.max(0, (nowMs - refMs) / MS_PER_DAY); // AC-55a.1.x clamp: future → age 0 → A 1.
	const halfLife = Math.max(MIN_RECENCY_HALF_LIFE_FLOOR, halfLifeDays);
	const lambda = LN2 / halfLife;
	return Math.exp(-lambda * ageDays);
}

/**
 * Apply the PRD-058a class-aware recency ACTIVATION to the final hit list, the live Stage-1 form of
 * the `A(m,t)` term that SUPERSEDES the OFF-equivalent flat {@link applyRecencyDampening} as the live
 * default. For each surviving hit it:
 *  1. resolves the half-life by the hit's CLASS ({@link halfLifeForSource}: `sessions` decays fastest,
 *     `memories` slowest, AC-55a.2.1), honoring a caller override over the documented default;
 *  2. computes `A_simple = 2^(−Δt / h)` from `t_ref = max(created_at, last_reinforced_at)` ({@link
 *     refTimestampMs}, 058e-forward-compatible, reads `last_reinforced_at` as nullable-defaulting-to-
 *     created), STAMPS it on the hit as {@link MemoryRecallHit.freshnessScore} (AC-55a.3.1), and
 *  3. multiplies the fused `score` by `A^activationExponent` (the master equation's `P = R · A^a`,
 *     AC-55a.1.1) then re-orders by the adjusted score DESC.
 *
 * INVARIANTS:
 *  - This is the LAST score adjustment (AC-55a.1.3): it runs after fuse/rerank/dedup so it can never
 *    perturb dedup's provenance keep-decision.
 *  - It is a soft, multiplicative DEMOTION: `A ∈ (0,1]`, NO cutoff, every input hit is present in the
 *    output, the oldest is merely pushed down (AC-55a.1.2). A hit with no usable timestamp keeps its
 *    score unchanged (`A = 1`, AC-55a.3.3) and `freshnessScore = 1`.
 *  - `freshnessScore` is the raw `A_simple` (the EXACT multiplier semantics the dashboard renders),
 *    computed from row age, emitted even when embeddings are off (AC-55a.3.2). The ORDERING uses
 *    `A^activationExponent`; with the default exponent `1.0` the two coincide.
 *  - Stable tie-break: equally-activated hits keep their incoming (rerank/dedup/RRF) order.
 * Pure + sync, no I/O, no throw.
 */
export function applyRecencyActivation(
	hits: readonly MemoryRecallHit[],
	byClass: RecencyHalfLifeByClass | undefined,
	activationExponent: number,
	nowMs: number,
	staleness?: ResolvedStaleness,
): MemoryRecallHit[] {
	// The exponent `a` in `A^a` (AC-55a.1.1): floored ≥ 0 (a negative would BOOST stale rows, forbidden).
	// `0` is the neutral escape hatch (`A^0 = 1`), but `freshnessScore` still carries the real `A`.
	const exponent = Math.max(0, Number.isFinite(activationExponent) ? activationExponent : DEFAULT_RECENCY_ACTIVATION_EXPONENT);
	const activated = hits.map((hit, index) => {
		const halfLife = halfLifeForSource(hit.source, byClass);
		// PRD-058a: t_ref = max(created_at, last_reinforced_at). 058e adds last_reinforced_at later; until
		// then it is absent and t_ref = created_at. The hit type carries only createdAt today, so read the
		// optional reinforced field defensively without widening the public contract before 058e.
		const lastReinforcedAt = (hit as { lastReinforcedAt?: string | null }).lastReinforcedAt;
		const activation = recencyActivation(refTimestampMs(hit.createdAt, lastReinforcedAt), nowMs, halfLife);
		// PRD-058c: the staleness factor `(1 − σ)^s` is multiplied INTO this SAME ordering weight (one
		// demotion step, not a parallel path); it stamps σ/refStatus/staleRefs on the hit and is `1`
		// (NEUTRAL) when no source is wired, the hit has no verdict, or s = 0 (observe — visible but inert).
		const stale = stalenessContribution(hit, staleness);
		// The ORDERING weight is A^a · (1 − σ)^s; freshnessScore is the raw A (the multiplier semantics the
		// dashboard renders). With the default a = 1 and no staleness the two coincide.
		const orderingWeight = (exponent === 1 ? activation : Math.pow(activation, exponent)) * stale.factor;
		return {
			hit,
			index, // the INCOMING rank (RRF → rerank → dedup), the authoritative order to preserve.
			activation,
			staleFields: stale.fields,
			orderingWeight,
			score: hit.score * orderingWeight,
		};
	});

	// NO-PENALTY no-op (AC-55a.1.3): when NO hit carries a real age penalty (every ordering weight is
	// ~1, all hits maximally fresh, no usable timestamps, or activationExponent 0), the activation is a
	// strict NO-OP on ORDERING. This is load-bearing: the authoritative upstream order (rerank, dedup) is
	// encoded in POSITION, not in the (RRF) `score`; a blind score re-sort would UNDO the rerank/dedup
	// reorder. We still STAMP freshnessScore + the staleness fields on every hit (AC-55a.3.1 / AC-55c.2.1).
	const anyPenalty = activated.some((a) => a.orderingWeight < 1);
	if (!anyPenalty) {
		return activated.map(({ hit, activation, staleFields }) => ({ ...hit, ...staleFields, freshnessScore: activation }));
	}

	// At least one hit is genuinely aged or stale: order by the adjusted score DESC, using the INCOMING
	// index as the stable tie-break so equally-adjusted hits keep their upstream (rerank/dedup) order.
	// NEVER drops a hit (AC-55a.1.2 / AC-55c.2.2): the oldest/stalest is demoted, never removed.
	activated.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score; // adjusted score DESC (the age-aware order).
		return a.index - b.index; // stable: preserve the incoming rerank/dedup/RRF order on a tie.
	});
	// Re-emit with the adjusted score AND the stamped freshnessScore (raw A_simple) + staleness fields.
	return activated.map(({ hit, activation, score, staleFields }) => ({ ...hit, ...staleFields, score, freshnessScore: activation }));
}

// ── PRD-058e — ACT-R activation (Stage 2): A_actr behind freshnessScore ──────

/**
 * Apply the PRD-058e ACT-R activation, the Stage-2 upgrade that SUPERSEDES the 058a Stage-1
 * {@link applyRecencyActivation} WHEN an {@link ActivationSource} is wired. For each surviving hit it:
 *  1. loads the memory's usefulness-weighted access history + count from the source (one batched pass);
 *  2. computes `A_actr = clamp(exp(B − B*), A_min, 1)` from that history (`activation.ts`), where `B` is
 *     the base-level activation that rises with recency AND frequency and from which the spacing effect
 *     falls out (AC-55e.1.1 / 55e.1.2); a contradicted/ignored access (`u_k → 0`) does not inflate it
 *     (AC-55e.1.3); a cold memory floors at `A_min` (AC-55e.1.4);
 *  3. STAMPS `A_actr` on the hit as BOTH {@link MemoryRecallHit.freshnessScore} (the swap is behind that
 *     field per the PRD — invisible to callers) AND the explicit {@link MemoryRecallHit.activation}, and
 *     sets {@link MemoryRecallHit.accessCount}; then
 *  4. multiplies the fused score by `A_actr^activationExponent` and re-orders by the adjusted score DESC
 *     (the SAME ordering discipline + stable tie-break as the Stage-1 path).
 *
 * INVARIANTS (identical to Stage 1): runs LAST after fuse/rerank/dedup; a soft multiplicative DEMOTION,
 * never a cutoff (every hit present, AC-55e.1.2 via the `A_min` floor); a hit with no activation input
 * (absent from the source map) FALLS BACK to the 058a Stage-1 `A_simple` for that hit (fail-soft), so a
 * partial source never zeroes a hit. Async only because the source read is async; the math is pure.
 */
async function applyActrActivation(
	hits: readonly MemoryRecallHit[],
	source: ActivationSource,
	byClass: RecencyHalfLifeByClass | undefined,
	activationExponent: number,
	nowMs: number,
	scope: QueryScope,
	staleness?: ResolvedStaleness,
): Promise<MemoryRecallHit[]> {
	const exponent = Math.max(0, Number.isFinite(activationExponent) ? activationExponent : DEFAULT_RECENCY_ACTIVATION_EXPONENT);
	const params = source.params ?? DEFAULT_ACTR_PARAMS;

	// Load the per-memory activation inputs in one pass. A source throw degrades the WHOLE stage to the
	// 058a Stage-1 path (fail-soft) — never a thrown recall. The staleness factor still rides along there.
	let inputs: Map<string, MemoryActivationInputs>;
	try {
		inputs = await source.load(hits, scope);
	} catch {
		return applyRecencyActivation(hits, byClass, activationExponent, nowMs, staleness);
	}

	const computed = hits.map((hit, index) => {
		const key = fusionKey(hit.source, hit.id);
		const input = inputs.get(key);
		if (input === undefined) {
			// No activation input for this hit → fall back to the 058a Stage-1 A_simple (per-hit fail-soft).
			const halfLife = halfLifeForSource(hit.source, byClass);
			const lastReinforcedAt = (hit as { lastReinforcedAt?: string | null }).lastReinforcedAt;
			const a = recencyActivation(refTimestampMs(hit.createdAt, lastReinforcedAt), nowMs, halfLife);
			return { hit, index, activation: a, accessCount: undefined as number | undefined };
		}
		// Stage-2: A_actr from the usefulness-weighted access history.
		const a = actrActivation(input.history, nowMs, params);
		return { hit, index, activation: a, accessCount: input.accessCount };
	});

	const adjusted = computed.map((c) => {
		// PRD-058c: fold `(1 − σ)^s` into the SAME ordering weight as A_actr^a (one demotion step); stamp
		// the staleness fields. Neutral (factor 1, no fields) when no source / no verdict / s = 0.
		const stale = stalenessContribution(c.hit, staleness);
		const orderingWeight = (exponent === 1 ? c.activation : Math.pow(c.activation, exponent)) * stale.factor;
		return { ...c, staleFields: stale.fields, orderingWeight, score: c.hit.score * orderingWeight };
	});

	// Stamp every hit (A_actr behind freshnessScore + the explicit activation/accessCount + staleness
	// fields), then order by the adjusted score DESC with the incoming index as the stable tie-break
	// (preserves rerank/dedup order on a tie). Never drops a hit. Mirrors applyRecencyActivation exactly.
	const stamp = (c: (typeof adjusted)[number]): MemoryRecallHit => ({
		...c.hit,
		...c.staleFields,
		score: c.score,
		freshnessScore: c.activation, // the swap: A_actr behind the SAME field 058a used (PRD-058e).
		activation: c.activation,
		...(c.accessCount !== undefined ? { accessCount: c.accessCount } : {}),
	});

	const anyPenalty = adjusted.some((c) => c.orderingWeight < 1);
	if (!anyPenalty) {
		// No ordering change (all weights ~1 or exponent 0), but still stamp the activation fields.
		return adjusted.map(stamp);
	}
	const ordered = [...adjusted].sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return a.index - b.index;
	});
	return ordered.map(stamp);
}

// ── PRD-058e — calibrated confidence C(m) = g(f) (dormant until the curve is proven) ──

/**
 * Build the guarded batch-fetch of `(id, confidence)` for the `memories`-source hits (PRD-058e). Only
 * the `memories` table carries a `confidence` column (the distilled-fact raw `f`); `memory` summaries and
 * `sessions` raw turns carry none, so they get no calibrated confidence. Every id routes through
 * `sLiteral`, every identifier through `sqlIdent` (audit:sql-safe), mirroring {@link buildRerankEmbeddingSql}.
 */
export function buildConfidenceFetchSql(ids: readonly string[]): string {
	const tbl = sqlIdent("memories");
	const idCol = sqlIdent("id");
	const confCol = sqlIdent("confidence");
	const inList = ids.map((id) => sLiteral(id)).join(", ");
	return `SELECT ${idCol} AS id, ${confCol} AS confidence FROM "${tbl}" WHERE ${idCol} IN (${inList})`;
}

/**
 * Apply the PRD-058e calibration stage: map each `memories` hit's raw confidence `f` through the fitted
 * curve `C = g(f)` and stamp it as {@link MemoryRecallHit.calibratedConfidence}. RULES:
 *  - The IDENTITY model (cold-start / dormant) → `C = f`, the calibration is a NO-OP that still surfaces
 *    `f` as the calibrated value, so a consumer always sees a `C` once the model is wired (AC-55e.2.2).
 *  - It NEVER reorders (this wave): the `c` exponent stays 0 until eval-gated (AC-55e.2.3); calibration is
 *    surfaced for the dashboard + downstream activation only.
 *  - Only `memories` hits get a `C` (the only arm with a confidence column); other hits are unchanged.
 *  - FAIL-SOFT: a confidence-fetch failure leaves the hits without a `C`, never a throw. The raw `f` is
 *    fetched here (not threaded through fuse/rerank) so the stage is self-contained, like the rerank fetch.
 */
async function applyCalibrationStage(
	hits: readonly MemoryRecallHit[],
	model: CalibrationModel,
	request: MemoryRecallRequest,
	deps: MemoryRecallDeps,
): Promise<MemoryRecallHit[]> {
	const memoryIds = hits.filter((h) => h.source === "memories" && h.id !== "").map((h) => h.id);
	if (memoryIds.length === 0) return [...hits];
	let confById = new Map<string, number>();
	try {
		const rows = await runArm(buildConfidenceFetchSql(memoryIds), request, deps);
		for (const row of rows) {
			const id = cell(row.id);
			if (id === "") continue;
			const f = typeof row.confidence === "number" ? row.confidence : Number(row.confidence);
			if (Number.isFinite(f)) confById.set(id, f);
		}
	} catch {
		return [...hits]; // fail-soft: no calibrated confidence rather than a thrown recall.
	}
	return hits.map((hit) => {
		if (hit.source !== "memories") return hit;
		const f = confById.get(hit.id);
		if (f === undefined) return hit;
		const c = applyCalibration(model, f);
		return { ...hit, rawConfidence: f, calibratedConfidence: c };
	});
}

/**
 * Record a `recall` access event for each surviving `memories` hit (PRD-058e). The recall is the FIRST
 * half of the reinforcement loop: it logs that the memory was injected; the session-end worker grades
 * its usefulness later (reinforce/downweight). FAIL-SOFT + off the answer path — a recorder throw is
 * swallowed so recording never fails the recall. ABSENT recorder → no-op (the deterministic unit path).
 * Only `memories`-source hits carry the durable id the access log keys on; summaries/sessions are skipped.
 */
async function recordRecallAccessEvents(hits: readonly MemoryRecallHit[], deps: MemoryRecallDeps): Promise<void> {
	const record = deps.recordRecallAccess;
	if (record === undefined) return;
	const ids = hits.filter((h) => h.source === "memories" && h.id !== "").map((h) => h.id);
	await Promise.all(
		ids.map(async (id) => {
			try {
				await record(id);
			} catch {
				// best-effort: a recording hiccup never fails the recall (off the answer path).
			}
		}),
	);
}

// ── PRD-047e — token-budget + MMR context assembly ───────────────────────────

/** The heuristic chars-per-token ratio (PRD-047e). ~4 chars/token is the well-known rough English estimate. */
const CHARS_PER_TOKEN = 4;

/**
 * Estimate the token cost of a hit's text with a CHEAP, DETERMINISTIC heuristic (PRD-047e / e-AC-1):
 * `ceil(text.length / 4)` (~4 chars per token, the rough English ratio). Exactness is NOT required for
 * BUDGETING — an exact per-model tokenizer is out of scope (PRD risk note). RULES:
 *  - A hit with NO countable text (empty/whitespace) counts as the SANE DEFAULT `1` token, never `0`
 *    and never an error (a zero-cost hit would let an unbounded number ride into any budget).
 *  - The result is always a positive integer.
 * Exported so the unit test counts with the EXACT same function (a deterministic counter + known hit
 * sizes) — the budget math the test asserts is the budget math recall runs.
 */
export function estimateTokenCount(text: string): number {
	const trimmedLen = text.trim().length;
	if (trimmedLen === 0) return 1; // no countable text → a sane default, never 0.
	return Math.max(1, Math.ceil(trimmedLen / CHARS_PER_TOKEN));
}

/**
 * Select hits into a token budget with Maximal Marginal Relevance (PRD-047e / e-AC-1, e-AC-2).
 *
 * MMR greedily picks the next hit by `argmax [ lambda·rel(d) − (1−lambda)·max_{s∈selected} sim(d,s) ]`,
 * where `rel` is the (already dampened/fused) score and `sim` is the cosine of the two hits' candidate
 * embeddings ({@link cosineSimilarity} over `embByKey`). This trades a little pure relevance for
 * diversity, so a window of near-paraphrases does not crowd out the distinct facts (e-AC-2).
 *
 * RISK MITIGATION (PRD-047e): the SELECTED set is SEEDED with rank-1 (the incoming top hit), so the
 * single best hit is NEVER displaced by the diversity term — it is always selected first, and only its
 * token cost is charged before MMR ranks the rest. A hit with no countable text still costs the sane
 * default token (so it cannot ride in free), and a hit with no usable embedding has `sim = 0` to every
 * peer (it is treated as maximally diverse — it is never penalized for missing an embedding).
 *
 * BUDGET RULE (e-AC-1): a hit is taken only while the running token total + its cost ≤ `tokenBudget`;
 * a hit that does not fit is SKIPPED and the search continues (a later, smaller hit may still fit). A
 * smaller budget therefore returns FEWER, higher-value hits. The rank-1 seed is always taken even when
 * its own cost exceeds the budget (a budget below the single best hit still returns that one hit, never
 * an empty result — recall always answers with its best hit).
 *
 * Pure + sync: no I/O. The candidate embeddings are sourced by the caller via the SAME
 * {@link fetchCandidateEmbeddings} dedup/rerank use — no extra embed-daemon calls (design constraint).
 */
export function selectWithinTokenBudget(
	hits: readonly MemoryRecallHit[],
	tokenBudget: number,
	lambda: number,
	embByKey: Map<string, number[]>,
): MemoryRecallHit[] {
	if (hits.length === 0) return [];
	const budget = Math.max(1, Math.trunc(tokenBudget));
	const lam = Math.min(1, Math.max(0, lambda));

	// Pre-compute each hit's relevance + token cost + embedding once.
	const pool = hits.map((hit) => ({
		hit,
		rel: hit.score,
		cost: estimateTokenCount(hit.text),
		vec: embByKey.get(fusionKey(hit.source, hit.id)),
	}));

	const selected: typeof pool = [];
	const remaining = new Set(pool);

	// RISK MITIGATION: always keep rank-1 — seed with the incoming top hit (pool[0], the
	// dampened/fused order), charged to the budget but never blocked from selection.
	const seed = pool[0]!;
	selected.push(seed);
	remaining.delete(seed);
	let used = seed.cost;

	// Greedy MMR over the remaining pool, taking the argmax-MMR hit only while it fits the budget.
	while (remaining.size > 0) {
		let best: (typeof pool)[number] | null = null;
		let bestMmr = -Infinity;
		for (const cand of remaining) {
			if (used + cand.cost > budget) continue; // does not fit → skip (a smaller later hit may).
			// max similarity to anything already selected; a missing embedding → sim 0 (maximally diverse).
			let maxSim = 0;
			for (const s of selected) {
				if (cand.vec === undefined || s.vec === undefined) continue;
				const cos = cosineSimilarity(cand.vec, s.vec);
				if (cos !== null && cos > maxSim) maxSim = cos;
			}
			const mmr = lam * cand.rel - (1 - lam) * maxSim;
			if (mmr > bestMmr) {
				bestMmr = mmr;
				best = cand;
			}
		}
		if (best === null) break; // nothing left fits the budget.
		selected.push(best);
		remaining.delete(best);
		used += best.cost;
	}

	return selected.map((s) => s.hit);
}

/**
 * Run the cross-table recall for `request.query`, scoped to `request.scope`.
 * Returns the surfaced hits, the arms that produced them, and the HONEST `degraded`
 * flag (PRD-025 AC-3). Never throws for the expected failure modes: an arm's storage
 * error yields no rows for that arm (the route still answers 200, not a 500), every
 * arm failing yields an empty result, and an empty query yields an empty result.
 *
 * THE TWO BRANCHES (degraded tells the truth):
 *  - SEMANTIC ran: an {@link EmbedClient} is injected AND the query embedded to a
 *    768-dim vector → the `<#>` cosine arms run via the EXISTING {@link vectorSearch}
 *    (D-5) and contribute their cosine-ranked lists to the RRF fusion. `degraded` is `false`.
 *  - LEXICAL fallback: no embed client, or the embed returned null (off / daemon
 *    unreachable / timeout / wrong-dim) → only the BM25/ILIKE arms run, `degraded`
 *    is `true`.
 *
 * The lexical arms ALWAYS run (the resilient floor): each of `memories`/`memory`/
 * `sessions` is its OWN guarded statement, a missing/failing SIBLING degrades to
 * empty for that arm only (`runArm`) — the live dogfood regression. PRD-027: every
 * arm (semantic + lexical) is a RANKED list; {@link fuseHits} fuses them with RRF +
 * the arm-class weight (distilled `[memory]` above raw `[sessions]`), dedups cross-arm
 * near-dups by `source+id`, and orders by fused `score` DESC — capped at the limit.
 * An empty/missing arm contributes nothing, preserving the per-arm fail-soft (AC-7).
 */
export async function recallMemories(
	request: MemoryRecallRequest,
	deps: MemoryRecallDeps,
): Promise<MemoryRecallResult> {
	const term = request.query.trim();
	const limit = resolveRecallLimit(request.limit);
	if (term === "") {
		// An empty query embeds to nothing meaningful; report the lexical floor honestly.
		return { hits: [], sources: [], degraded: true };
	}

	// PRD-044c: the user-selected `recallMode` GATES the semantic arm at recall time.
	//   · `keyword`              → SKIP `runSemanticArms` entirely (no embed call, no `<#>`
	//                              statement) — the semantic path is `null` by intent, NOT by
	//                              failure. `degraded` is forced `false` below (an intentional
	//                              lexical run is not a degraded fallback — PRD-029 coherence).
	//   · `semantic`/`hybrid`    → run `runSemanticArms` exactly as today; `degraded` stays
	//                              honest. (The lexical floor always runs, so both yield
	//                              vector+lexical — correct and honest, no fabricated split.)
	//   · UNSET (default)        → run `runSemanticArms` exactly as today (behavior-neutral).
	const keywordOnly = deps.recallMode === "keyword";

	// PRD-049b (49b-AC-2): compute the project-segment conjunct ONCE and AND it into every
	// lexical arm. The semantic arm threads the SAME predicate inline (runSemanticArm). A row
	// from another project is filtered server-side in the SAME statement as the match.
	const projectClause = projectConjunctFor(request);

	// Run the semantic arms (embed-query → `<#>`) and the lexical arms concurrently.
	// The semantic path returns null when it could not run (→ degraded:true); the
	// lexical arms always run (the resilient floor). Each lexical arm is bounded by the
	// overall limit so a single arm cannot starve the fusion. In `keyword` mode the
	// semantic arm is never invoked — it short-circuits to `null` before the await.
	const [semanticRun, memoriesRows, memoryRows, sessionsRows] = await Promise.all([
		keywordOnly ? Promise.resolve(null) : runSemanticArms(request, deps, limit),
		runArm(buildMemoriesArmSql(term, limit, projectClause), request, deps),
		runArm(buildMemoryArmSql(term, limit, projectClause), request, deps),
		runArm(buildSessionsArmSql(term, limit, projectClause), request, deps),
	]);

	// `degraded` is HONEST (PRD-025 AC-3): false iff the semantic arm actually ran — EXCEPT in
	// `keyword` mode, where an intentional lexical-only run is NOT a degraded fallback (PRD-044c /
	// PRD-029), so it is forced `false` even though the semantic arm never ran.
	const degraded = keywordOnly ? false : semanticRun === null;

	// PRD-027 D-1/D-2/D-3: assemble every arm as a RANKED list, then fuse with RRF +
	// the arm-class weight, dedup, and order by fused score. The semantic arms (one per
	// table, each cosine-ranked) come first, then the three lexical arms in their storage
	// order. A null semantic path contributes no arms (lexical-only); a missing lexical
	// sibling is simply an empty arm (per-arm fail-soft, AC-7) that contributes nothing.
	const arms: RankedArm[] = [
		...(semanticRun?.arms ?? []),
		rowsToRankedArm(memoriesRows),
		rowsToRankedArm(memoryRows),
		rowsToRankedArm(sessionsRows),
	];
	const { hits, sources } = fuseHits(arms, limit);

	// PRD-047b: rerank the fused top-N by cosine(query vector, candidate embedding). The
	// rerank runs ONLY when a real query vector exists (the semantic arm ran) — on a
	// lexical-only / degraded / keyword recall there is no vector, so RRF order stands
	// (b-AC-4). The strategy DEFAULTS to `none` (b-AC-3: embedding-cosine measured ~0
	// lift on the synthetic golden set, so the eval-driven default keeps RRF order); a
	// caller passes `{ strategy: "embedding-cosine" }` to activate the wired+tested
	// rerank. The stage is timeout-budgeted (b-AC-2) and fail-soft to RRF order (b-AC-4).
	const rerankerConfig: RerankerConfig =
		deps.reranker ??
		({ strategy: DEFAULT_RERANKER, timeoutMs: DEFAULT_RERANKER_TIMEOUT_MS, window: DEFAULT_RERANKER_WINDOW } as const);
	const ranked =
		semanticRun === null || rerankerConfig.strategy === "none"
			? // No query vector to rerank against, or RRF-only requested → keep the fused order.
				hits
			: await rerankHits(hits, semanticRun.queryVector, rerankerConfig, request, deps);

	// PRD-047c: collapse semantic near-duplicates over the fused/reranked top-N, keeping
	// the highest-provenance copy of each fact (`memories` > `memory` > `sessions`). Runs
	// AFTER fusion AND after rerank; ON by default (c-AC-3), self-sources the candidate
	// embeddings (rerank may be `none`), and fail-soft to the un-deduped list (c-AC-4).
	// `sources` is recomputed from the survivors so the hybrid-coverage signal stays honest.
	const dedupConfig: DedupConfig =
		deps.dedup ??
		({ enabled: DEFAULT_DEDUP_ENABLED, similarityThreshold: DEFAULT_DEDUP_SIMILARITY_THRESHOLD } as const);
	const deduped = await dedupHits(ranked, dedupConfig, request, deps);
	const dedupedSources = deduped.length === ranked.length ? sources : [...new Set(deduped.map((h) => h.source))];

	// PRD-058a: apply the class-aware recency ACTIVATION LAST, after fusion, rerank, AND dedup, so it
	// never disturbs dedup's provenance-based keep-decision (AC-55a.1.3). It stamps each surviving hit's
	// `freshnessScore = A_simple = 2^(−Δt / h(class))` (AC-55a.3.1), multiplies the fused score by
	// `A^activationExponent` (`P = R · A^a`, AC-55a.1.1), and re-orders by the adjusted score. The
	// half-life is chosen by the hit's CLASS, `sessions` decays fastest, `memories` slowest (AC-55a.2.1)
	//, using the caller override when present, else the DOCUMENTED per-class default (never the 100-year
	// neutral, AC-55a.2.3). This supersedes the OFF-equivalent flat PRD-047d dampener as the live default.
	// It DEMOTES the oldest hit, never DROPS it (AC-55a.1.2); a hit with no usable timestamp gets `A = 1`
	// (AC-55a.3.3). Computed from row age, so it runs even on a degraded (embeddings-off) recall
	// (AC-55a.3.2). Pure + sync, no I/O, no throw.
	const byClass = deps.recency?.halfLifeDaysByClass;
	const activationExponent = deps.recency?.activationExponent ?? DEFAULT_RECENCY_ACTIVATION_EXPONENT;
	const nowMs = (deps.now ?? Date.now)();
	// PRD-058c: resolve the staleness verdicts ONCE (one batched source read) so the `(1 − σ)^s` factor can
	// be folded INTO the recency-multiplier stage below (the SAME single demotion step, not a parallel
	// path). FAIL-SOFT: a source throw → no staleness factor (neutral), never a thrown recall. ABSENT
	// source → undefined → the stage runs the byte-for-byte pre-058c path.
	const staleness = await resolveStaleness(deduped, deps, request.scope);
	// PRD-058e: when an activationSource is wired, swap the Stage-1 A_simple for the ACT-R Stage-2 A_actr
	// BEHIND the same freshnessScore field + `a` exponent (invisible to callers). ABSENT → the byte-for-byte
	// 058a Stage-1 path runs, so every existing caller/test is unchanged. Both are fail-soft + never drop a
	// hit, and both fold the PRD-058c `(1 − σ)^s` staleness factor into the SAME ordering weight.
	const activated =
		deps.activationSource !== undefined
			? await applyActrActivation(deduped, deps.activationSource, byClass, activationExponent, nowMs, request.scope, staleness)
			: applyRecencyActivation(deduped, byClass, activationExponent, nowMs, staleness);

	// PRD-058e: stamp the calibrated confidence C(m) = g(f) on the surviving hits when a calibration model
	// is wired (the IDENTITY/cold-start model is a no-op that still surfaces C = f; it NEVER reorders here —
	// the `c` exponent stays 0 until eval-gated, AC-55e.2.2 / 55e.2.3). ABSENT → no C surfaced (dormant).
	// Run the calibration stage whenever a model is wired — INCLUDING the IDENTITY/cold-start model. The
	// stage already defines the identity case as `C = f` (it stamps rawConfidence + calibratedConfidence
	// from the stored confidence), so skipping it for identity left those fields UNSET and forced
	// downstream consumers (the dashboard / `H`) onto the `C = 1` default instead of the real stored
	// confidence. The `c` exponent stays dormant (no reorder) until eval-gated; this only ensures `C` is
	// always emitted once a model is present.
	const calibrated =
		deps.calibration !== undefined
			? await applyCalibrationStage(activated, deps.calibration, request, deps)
			: activated;

	// PRD-058b: apply the `κ(m,t)` gate as the LAST currentness filter, layered OVER (not replacing) the
	// `MAX(version)` invariant (AC-55b.1.1 / 55b.1.3). A `κ = ρ` open-conflict loser is dropped so a recall
	// matching BOTH sides of a contradiction returns at most the winner; the `κ = 0` hard-superseded losers
	// are already excluded by supersession upstream. FAIL-SOFT: a missing/unreadable `memory_conflicts`
	// degrades to returning BOTH sides, never a 500. ABSENT source → byte-for-byte the pre-058b path.
	const dampened = await applyConflictGate(calibrated, deps, request.scope);

	// PRD-047e: OPTIONAL token-budget + MMR context assembly. ADDITIVE + OPT-IN — it engages ONLY
	// when the request carries a positive `tokenBudget`. With NO budget the row-`limit` path runs
	// BYTE-FOR-BYTE as before (the dampened top-`limit` list), which is what keeps the live eval (it
	// never sets a budget) neutral by construction (e-AC-3 / e-AC-4). When a budget IS supplied, we
	// fill it with the highest-value NON-redundant hits via MMR (e-AC-1, e-AC-2): the candidate
	// embeddings are self-sourced via the SAME `fetchCandidateEmbeddings` dedup/rerank use (no extra
	// embed calls), the top hit is always kept (rank-1 seed), and ANY failure degrades to the fixed
	// top-`limit` list — never a 500 (e-AC-4).
	//
	// PRD-058e: the `recall` access event is recorded AFTER token-budget assembly so reinforcement is
	// credited to the hits ACTUALLY INJECTED, not the pre-budget set. Recording the dampened set before
	// trimming would log (and bump `access_count` for) memories that the budget then dropped, inflating
	// the access log and biasing later ACT-R activation toward never-injected hits. Recording stays
	// FAIL-SOFT + off the answer path: a recorder throw never fails the recall. Only `memories`-source
	// hits carry a usable id for the access log.
	const budget = request.tokenBudget;
	if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
		// No budget → the unchanged fixed top-k path (e-AC-4 back-compat). The injected set IS `dampened`.
		await recordRecallAccessEvents(dampened, deps);
		return { hits: dampened, sources: dedupedSources, degraded };
	}
	try {
		const lambda = deps.contextAssembly?.mmrLambda ?? DEFAULT_MMR_LAMBDA;
		const embByKey = await fetchCandidateEmbeddings(dampened, request, deps);
		const assembled = selectWithinTokenBudget(dampened, budget, lambda, embByKey);
		const assembledSources = assembled.length === dampened.length ? dedupedSources : [...new Set(assembled.map((h) => h.source))];
		// Credit reinforcement to the post-budget injected set only.
		await recordRecallAccessEvents(assembled, deps);
		return { hits: assembled, sources: assembledSources, degraded };
	} catch {
		// e-AC-4: an MMR/budget failure degrades to the fixed top-`limit` list, never a throw. The injected
		// set in this degraded path is `dampened`, so reinforcement is credited to it.
		await recordRecallAccessEvents(dampened, deps);
		return { hits: dampened, sources: dedupedSources, degraded };
	}
}

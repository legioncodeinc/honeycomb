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
import {
	DEFAULT_DEDUP_ENABLED,
	DEFAULT_DEDUP_SIMILARITY_THRESHOLD,
	DEFAULT_MMR_LAMBDA,
	DEFAULT_RECENCY_HALF_LIFE_DAYS,
	DEFAULT_RERANKER,
	DEFAULT_RERANKER_TIMEOUT_MS,
	DEFAULT_RERANKER_WINDOW,
	type ContextAssemblyConfig,
	type DedupConfig,
	type RecencyConfig,
	type RerankerConfig,
} from "../recall/config.js";
import type { EmbedClient } from "../services/embed-client.js";
import type { RecallMode } from "../vault/api.js";

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
export function buildMemoriesArmSql(term: string, perArmLimit: number): string {
	const pattern = `'%${sqlLike(term)}%'`;
	const memoriesTbl = sqlIdent("memories");
	const idCol = sqlIdent("id");
	const contentCol = sqlIdent("content");
	const isDeletedCol = sqlIdent("is_deleted");
	// PRD-047d: project the row's creation timestamp (already on the table) so the
	// recency dampener can age-decay the fused score — no new column.
	const createdAtCol = sqlIdent("created_at");
	const perArm = Math.max(1, Math.trunc(perArmLimit));
	return (
		`SELECT 'memories' AS source, ${idCol} AS id, ${contentCol}::text AS text, ${createdAtCol}::text AS created_at ` +
		`FROM "${memoriesTbl}" ` +
		`WHERE ${contentCol}::text ILIKE ${pattern} AND ${isDeletedCol} = 0 ` +
		`LIMIT ${perArm}`
	);
}

/**
 * Build the `memory` arm: AI session summaries, keyed by `path`, matched with a
 * guarded `ILIKE` over `summary`. Same guard discipline as {@link buildMemoriesArmSql}.
 */
export function buildMemoryArmSql(term: string, perArmLimit: number): string {
	const pattern = `'%${sqlLike(term)}%'`;
	const memoryTbl = sqlIdent("memory");
	const pathCol = sqlIdent("path");
	const summaryCol = sqlIdent("summary");
	// PRD-047d: the `memory` (summaries) table stamps `creation_date`; alias it to the
	// uniform `created_at` projection the dampener reads (no new column).
	const createdAtCol = sqlIdent("creation_date");
	const perArm = Math.max(1, Math.trunc(perArmLimit));
	return (
		`SELECT 'memory' AS source, ${pathCol} AS id, ${summaryCol}::text AS text, ${createdAtCol}::text AS created_at ` +
		`FROM "${memoryTbl}" ` +
		`WHERE ${summaryCol}::text ILIKE ${pattern} ` +
		`LIMIT ${perArm}`
	);
}

/**
 * Build the `sessions` arm: raw captured turns (JSONB `message`, matched as
 * `::text`), keyed by `path`. Same guard discipline as {@link buildMemoriesArmSql}.
 */
export function buildSessionsArmSql(term: string, perArmLimit: number): string {
	const pattern = `'%${sqlLike(term)}%'`;
	const sessionsTbl = sqlIdent("sessions");
	const pathCol = sqlIdent("path");
	const messageCol = sqlIdent("message");
	// PRD-047d: the `sessions` table stamps `creation_date`; alias it to the uniform
	// `created_at` projection the dampener reads (no new column).
	const createdAtCol = sqlIdent("creation_date");
	const perArm = Math.max(1, Math.trunc(perArmLimit));
	return (
		`SELECT 'sessions' AS source, ${pathCol} AS id, ${messageCol}::text AS text, ${createdAtCol}::text AS created_at ` +
		`FROM "${sessionsTbl}" ` +
		`WHERE ${messageCol}::text ILIKE ${pattern} ` +
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
	 * strategy ({@link DEFAULT_RERANKER} = `embedding-cosine`) with the default window
	 * + timeout — so the LIVE route and the eval measure the reranker ON by default
	 * without any caller change. A caller passes `{ strategy: "none" }` for the
	 * RRF-only escape hatch, or an explicit config to tune `window` / `timeoutMs`.
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
	 * The recency-dampening config (PRD-047d / d-AC-1..4). When ABSENT, the dampener runs with
	 * its OFF-EQUIVALENT default half-life ({@link DEFAULT_RECENCY_HALF_LIFE_DAYS} = 100 years),
	 * so the LIVE route and the eval are NEUTRAL on the age-agnostic synthetic golden set until
	 * the eval tunes the knob (d-AC-4 — "measured before it bites"). A caller passes a short
	 * `{ halfLifeDays }` to activate the age-decay.
	 *
	 * The dampener runs LAST — after {@link fuseHits}, the rerank, AND dedup — so it never
	 * disturbs dedup's provenance-based keep-decision ({@link outranksForKeep}). It multiplies
	 * each surviving hit's fused score by `0.5 ^ (age_days / half_life_days)` and re-orders by
	 * the dampened score; it DEMOTES the oldest hit but never DROPS it (d-AC-2). A hit with no
	 * usable {@link MemoryRecallHit.createdAt} gets `decay = 1` (no penalty), never a throw (d-AC-3).
	 */
	readonly recency?: RecencyConfig;
	/**
	 * The context-assembly config (PRD-047e / e-AC-1..4): the MMR lambda knob the token-budget
	 * selection uses. It bites ONLY when the request carries a {@link MemoryRecallRequest.tokenBudget}
	 * — with NO budget the assembly stage is SKIPPED entirely and the fixed top-`limit` path runs
	 * byte-for-byte as before (e-AC-4 back-compat). ABSENT → defaults to {@link DEFAULT_MMR_LAMBDA}.
	 */
	readonly contextAssembly?: ContextAssemblyConfig;
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
 * Run one recall arm and return its rows, treating a non-`ok` result (a missing
 * table on a fresh partition, any other `query_error`, a connection error, or a
 * timeout) as EMPTY for that arm rather than a recall-wide failure. This is the
 * per-arm tolerance that mirrors the recall engine's collector
 * (`recall/collection.ts` `toScoredIds`): a sibling arm whose table does not yet
 * exist must NOT erase the hits from the arms whose tables DO.
 */
async function runArm(sql: string, request: MemoryRecallRequest, deps: MemoryRecallDeps): Promise<StorageRow[]> {
	const result = await deps.storage.query(sql, request.scope);
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
function buildSemanticHydrateSql(spec: SemanticArmSpec, ids: readonly string[]): string {
	const tbl = sqlIdent(spec.table);
	const idCol = sqlIdent(spec.idColumn);
	const textCol = sqlIdent(spec.textColumn);
	// PRD-047d: hydrate the creation timestamp too, aliased to the uniform `created_at`.
	const tsCol = sqlIdent(spec.timestampColumn);
	const sourceLit = sLiteral(spec.source);
	const inList = ids.map((id) => sLiteral(id)).join(", ");
	const filterClause = spec.hydrateFilter === "" ? "" : ` ${spec.hydrateFilter}`;
	return (
		`SELECT ${sourceLit} AS source, ${idCol} AS id, ${textCol}::text AS text, ${tsCol}::text AS created_at ` +
		`FROM "${tbl}" ` +
		`WHERE ${idCol} IN (${inList})${filterClause}`
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
	let scored: ScoredId[];
	try {
		// vectorSearch validates the dim (asserts 768) + over-fetches; the org/workspace
		// partition rides the QueryScope, so the in-row scope filter is empty here.
		const recall = await vectorSearch(deps.storage, request.scope, {
			table: spec.table,
			idColumn: spec.idColumn,
			embeddingColumn: spec.embeddingColumn,
			queryVector,
			scope: {},
			limit,
		});
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
	const hydrated = await runArm(buildSemanticHydrateSql(spec, ids), request, deps);
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

		// Score each head candidate by cosine; a candidate with no usable embedding falls
		// back to a rank-proxy score so it slots by its RRF position, never leapfrogging.
		const scored = head.map((hit, index) => {
			const vec = embByKey.get(fusionKey(hit.source, hit.id));
			const cos = vec === undefined ? null : cosineSimilarity(queryVector, vec);
			return { hit, index, rerankScore: cos };
		});

		// Stable sort: cosine-scored candidates by score DESC; an un-scored candidate sorts
		// by its original RRF index (kept relative order). A scored candidate outranks an
		// un-scored one only when its cosine beats the un-scored peer's implied position —
		// to keep the reorder CONSERVATIVE (never worse-than-RRF for a missing embedding),
		// un-scored candidates retain their original index slot via a stable comparator.
		scored.sort((a, b) => {
			if (a.rerankScore !== null && b.rerankScore !== null) {
				if (b.rerankScore !== a.rerankScore) return b.rerankScore - a.rerankScore;
				return a.index - b.index; // tie → original RRF order (stable).
			}
			// At least one is un-scored → preserve original RRF order between them.
			return a.index - b.index;
		});

		return [...scored.map((s) => s.hit), ...tail];
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
			index, // the INCOMING rank (RRF → rerank → dedup) — the authoritative order to preserve.
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

	// Run the semantic arms (embed-query → `<#>`) and the lexical arms concurrently.
	// The semantic path returns null when it could not run (→ degraded:true); the
	// lexical arms always run (the resilient floor). Each lexical arm is bounded by the
	// overall limit so a single arm cannot starve the fusion. In `keyword` mode the
	// semantic arm is never invoked — it short-circuits to `null` before the await.
	const [semanticRun, memoriesRows, memoryRows, sessionsRows] = await Promise.all([
		keywordOnly ? Promise.resolve(null) : runSemanticArms(request, deps, limit),
		runArm(buildMemoriesArmSql(term, limit), request, deps),
		runArm(buildMemoryArmSql(term, limit), request, deps),
		runArm(buildSessionsArmSql(term, limit), request, deps),
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

	// PRD-047d: apply the recency dampener LAST — after fusion, rerank, AND dedup — so it
	// never disturbs dedup's provenance-based keep-decision. It multiplies each surviving
	// hit's fused score by an age-decay (`0.5 ^ age_days / half_life_days`) and re-orders by
	// the dampened score. The half-life DEFAULTS to OFF-equivalent (100 years), so this is
	// NEUTRAL on the age-agnostic synthetic golden set until the eval tunes it (d-AC-4). It
	// DEMOTES the oldest hit, never DROPS it (d-AC-2); a hit with no usable timestamp gets
	// `decay = 1` (d-AC-3). Pure + sync — no I/O, no throw.
	const halfLifeDays = deps.recency?.halfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;
	const nowMs = (deps.now ?? Date.now)();
	const dampened = applyRecencyDampening(deduped, halfLifeDays, nowMs);

	// PRD-047e: OPTIONAL token-budget + MMR context assembly. ADDITIVE + OPT-IN — it engages ONLY
	// when the request carries a positive `tokenBudget`. With NO budget the row-`limit` path runs
	// BYTE-FOR-BYTE as before (the dampened top-`limit` list), which is what keeps the live eval (it
	// never sets a budget) neutral by construction (e-AC-3 / e-AC-4). When a budget IS supplied, we
	// fill it with the highest-value NON-redundant hits via MMR (e-AC-1, e-AC-2): the candidate
	// embeddings are self-sourced via the SAME `fetchCandidateEmbeddings` dedup/rerank use (no extra
	// embed calls), the top hit is always kept (rank-1 seed), and ANY failure degrades to the fixed
	// top-`limit` list — never a 500 (e-AC-4).
	const budget = request.tokenBudget;
	if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
		// No budget → the unchanged fixed top-k path (e-AC-4 back-compat).
		return { hits: dampened, sources: dedupedSources, degraded };
	}
	try {
		const lambda = deps.contextAssembly?.mmrLambda ?? DEFAULT_MMR_LAMBDA;
		const embByKey = await fetchCandidateEmbeddings(dampened, request, deps);
		const assembled = selectWithinTokenBudget(dampened, budget, lambda, embByKey);
		const assembledSources = assembled.length === dampened.length ? dedupedSources : [...new Set(assembled.map((h) => h.source))];
		return { hits: assembled, sources: assembledSources, degraded };
	} catch {
		// e-AC-4: an MMR/budget failure degrades to the fixed top-`limit` list, never a throw.
		return { hits: dampened, sources: dedupedSources, degraded };
	}
}

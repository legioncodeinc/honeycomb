/**
 * Native DeepLake hybrid recall — the PRD-027 D-1 **option (c) bench candidate**.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * BENCH-ONLY (PRD-045 W0). This module is the SECOND recall implementation kept
 * deliberately UNWIRED: it is NOT mounted on any `/api/memories/*` route and the
 * live engine ({@link recallMemories} in `recall.ts`) is untouched. It exists so the
 * existing recall-eval harness (`src/eval/golden.ts`, `npm run eval:recall`) can A/B
 * the DB's NATIVE `deeplake_hybrid_record` operator against the post-query RRF the
 * live engine ships — on the SAME committed golden set, the SAME metrics, the SAME
 * warm store. PRD-027 D-1 named this exact follow-up: "(c) the DB's native hybrid …
 * kept as a fast-follow once the eval harness can A/B it." This is that A/B.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── What the native operator does (vs the engine's RRF) ──────────────────────
 * The live engine runs SEPARATE per-arm queries (a `<#>` cosine arm + a BM25/ILIKE
 * lexical arm) and FUSES their ranked lists in TypeScript with reciprocal-rank
 * fusion (`fuseHits`, RRF_K=60). The native path instead asks DeepLake to fuse
 * vector + BM25 in ONE statement via the `deeplake_hybrid_record` operator with
 * TUNABLE weights — `(<emb>, <text>)::deeplake_hybrid_record <#>
 * deeplake_hybrid_record(<query-vec>, <query-text>, vecWeight, textWeight)` — so
 * fusion happens in the engine, one round trip per table, no TS rank bookkeeping.
 * (Only the weight RATIO matters per the DeepLake docs: 0.7/0.3 == 7/3.)
 *
 * ── Why only `memories` + `sessions` (no `memory`) ───────────────────────────
 * The native operator needs BOTH an embedding column AND a text column on the row.
 * `memories.content` + `content_embedding` and `sessions.message` +
 * `message_embedding` have both; the `memory` summaries table carries no embedding
 * column (mirrors `recall.ts`'s `SEMANTIC_ARMS`), so it has no hybrid arm here. The
 * golden set seeds `memories` rows, so the `memories` arm is the one the eval scores.
 *
 * ── Provenance parity with the live engine (fair A/B) ────────────────────────
 * So the benchmark isolates ONE variable (native fusion vs RRF) and not the
 * distilled-over-raw shaping, the SAME arm-class weight the engine folds into RRF
 * ({@link ARM_CLASS_WEIGHT}: distilled `memory` 1.0, raw `session` 0.4) multiplies
 * each arm's native score before the cross-arm merge. Raw `sessions` hits stay
 * `secondary`, exactly as the live engine tags them.
 *
 * ── SQL safety ───────────────────────────────────────────────────────────────
 * Every identifier routes through `sqlIdent`; the query TEXT through `sLiteral`;
 * the query VECTOR through `serializeFloat4Array`; the weights are clamped finite
 * numbers bound to `*Lit` names. No value is hand-quoted (`audit:sql` clean). Reads
 * ONLY through the injected {@link StorageQuery}, under the per-request scope.
 */

import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { EMBEDDING_DIMS, serializeFloat4Array } from "../../storage/vector.js";
import {
	ARM_CLASS_WEIGHT,
	kindOfSource,
	resolveRecallLimit,
	type MemoryRecallDeps,
	type MemoryRecallHit,
	type MemoryRecallRequest,
	type MemoryRecallResult,
	type RecallSource,
} from "./recall.js";

/** Default vector weight for the native hybrid operator. Balanced 0.5/0.5 — only the ratio matters. */
export const DEFAULT_HYBRID_VECTOR_WEIGHT = 0.5;
/** Default BM25 text weight for the native hybrid operator. */
export const DEFAULT_HYBRID_TEXT_WEIGHT = 0.5;

/** The tunable (vector, text) weighting handed to `deeplake_hybrid_record`. Ratio-only. */
export interface HybridWeights {
	/** The conceptual (cosine) arm weight. */
	readonly vector: number;
	/** The exact (BM25) arm weight. */
	readonly text: number;
}

/**
 * Resolve the hybrid weights from the tuning env so the benchmark can sweep them
 * (`HONEYCOMB_HYBRID_VECTOR_WEIGHT` / `HONEYCOMB_HYBRID_TEXT_WEIGHT`) without a code
 * change — the whole point of an A/B knob. A missing / non-finite / negative value
 * falls back to the balanced default.
 */
export function resolveHybridWeights(env: NodeJS.ProcessEnv = process.env): HybridWeights {
	return {
		vector: clampWeight(env.HONEYCOMB_HYBRID_VECTOR_WEIGHT, DEFAULT_HYBRID_VECTOR_WEIGHT),
		text: clampWeight(env.HONEYCOMB_HYBRID_TEXT_WEIGHT, DEFAULT_HYBRID_TEXT_WEIGHT),
	};
}

/** Clamp a raw env value to a finite, non-negative weight, defaulting a bad/missing one. */
function clampWeight(raw: unknown, fallback: number): number {
	const n = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(n) || n < 0) return fallback;
	return n;
}

/** Format a weight as a safe numeric SQL literal (bound to a `*Lit` name for the audit gate). */
function formatWeight(weight: number, fallback: number): string {
	const n = Number.isFinite(weight) && weight >= 0 ? weight : fallback;
	return String(n);
}

/**
 * One native-hybrid arm spec: the table + the embedding/text column pair the
 * `deeplake_hybrid_record` operator fuses over, the id/grouping column, the
 * {@link RecallSource} tag, and an optional extra WHERE conjunct (soft-delete).
 */
interface HybridArmSpec {
	/** The {@link RecallSource} tag the hits carry (and the provenance class derives from). */
	readonly source: Extract<RecallSource, "memories" | "sessions">;
	/** The bare table identifier. */
	readonly table: string;
	/** The id/grouping column (`id` / `path`). */
	readonly idColumn: string;
	/** The nullable `FLOAT4[]` embedding column. */
	readonly embeddingColumn: string;
	/** The text column the BM25 half of the operator matches + the hit hydrates. */
	readonly textColumn: string;
	/** An extra WHERE conjunct (e.g. soft-delete exclusion), or "". */
	readonly hydrateFilter: string;
}

/** The two native-hybrid arms — kept facts + raw turns (the tables with an embedding column). */
const HYBRID_ARMS: readonly HybridArmSpec[] = [
	{
		source: "memories",
		table: "memories",
		idColumn: "id",
		embeddingColumn: "content_embedding",
		textColumn: "content",
		hydrateFilter: `AND ${sqlIdent("is_deleted")} = 0`,
	},
	{
		source: "sessions",
		table: "sessions",
		idColumn: "path",
		embeddingColumn: "message_embedding",
		textColumn: "message",
		hydrateFilter: "",
	},
];

/**
 * Build ONE native-hybrid arm statement: select the id, the text, and the native
 * `deeplake_hybrid_record` fused score in a single guarded query, filtered to rows
 * whose embedding is non-empty (mirrors `vector.ts`'s null-degrade guard) plus the
 * arm's extra filter, ordered by the fused score DESC, bounded by the per-arm limit.
 * Higher score = more relevant (the operator's native order, per the DeepLake docs).
 */
export function buildHybridArmSql(
	spec: HybridArmSpec,
	queryText: string,
	queryVector: readonly number[],
	weights: HybridWeights,
	perArmLimit: number,
): string {
	const tbl = sqlIdent(spec.table);
	const idCol = sqlIdent(spec.idColumn);
	const embCol = sqlIdent(spec.embeddingColumn);
	const textCol = sqlIdent(spec.textColumn);
	const sourceLit = sLiteral(spec.source);
	const vecLit = serializeFloat4Array(queryVector);
	const queryLit = sLiteral(queryText);
	const vecWeightLit = formatWeight(weights.vector, DEFAULT_HYBRID_VECTOR_WEIGHT);
	const textWeightLit = formatWeight(weights.text, DEFAULT_HYBRID_TEXT_WEIGHT);
	const perArm = Math.max(1, Math.trunc(perArmLimit));
	const hydrateFilterClause = spec.hydrateFilter === "" ? "" : ` ${spec.hydrateFilter}`;
	// The native hybrid operator: a composite `(embedding, text)` cast matched with
	// `<#>` against a `deeplake_hybrid_record(queryVec, queryText, vecWeight, textWeight)`.
	const scoreSql =
		`(${embCol}, ${textCol})::deeplake_hybrid_record <#> ` +
		`deeplake_hybrid_record(${vecLit}, ${queryLit}, ${vecWeightLit}, ${textWeightLit})`;
	return (
		`SELECT ${sourceLit} AS source, ${idCol} AS id, ${textCol}::text AS text, (${scoreSql}) AS score ` +
		`FROM "${tbl}" ` +
		`WHERE ARRAY_LENGTH(${embCol}, 1) > 0${hydrateFilterClause} ` +
		`ORDER BY score DESC ` +
		`LIMIT ${perArm}`
	);
}

/** A merged native-hybrid hit accumulating its best weighted score across arms. */
interface HybridDoc {
	source: RecallSource;
	id: string;
	text: string;
	score: number;
}

/** Coerce a row cell to a string (never undefined). */
function cell(value: unknown): string {
	return value === undefined || value === null ? "" : String(value);
}

/** Coerce a row's `score` cell to a finite number (a missing/NaN score sinks to 0). */
function readScore(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Run ONE native-hybrid arm and return its rows as scored docs, with the arm-class
 * weight ({@link ARM_CLASS_WEIGHT}) folded into each score so distilled `memory`
 * hits outrank raw `session` dumps (provenance parity with the live RRF engine).
 * Tolerant exactly like the engine's `runArm`: a missing/failing table (fresh
 * partition, no embedding column) degrades THIS arm to empty, never the recall.
 */
async function runHybridArm(
	spec: HybridArmSpec,
	request: MemoryRecallRequest,
	deps: MemoryRecallDeps,
	queryVector: readonly number[],
	weights: HybridWeights,
	limit: number,
): Promise<HybridDoc[]> {
	const sql = buildHybridArmSql(spec, request.query, queryVector, weights, limit);
	const result = await deps.storage.query(sql, request.scope);
	if (!isOk(result)) return [];
	const classWeight = ARM_CLASS_WEIGHT[kindOfSource(spec.source)];
	return (result.rows as StorageRow[]).map((row) => ({
		source: spec.source,
		id: cell(row.id),
		text: cell(row.text),
		score: readScore(row.score) * classWeight,
	}));
}

/**
 * Native-hybrid recall — the bench sibling of {@link recallMemories}, with the SAME
 * request/deps/result contract so the eval harness injects it interchangeably. It
 * embeds the query, runs each native-hybrid arm, and merges the arms by their
 * engine-computed fused score (deduped by `source+id`, max score wins), ordered by
 * score DESC. `degraded` is `true` ONLY when the native path could not run at all —
 * no embed seam, or the query embed returned null/wrong-dim (the operator needs a
 * vector) — never a partial-failure mask: a missing arm simply contributes nothing.
 */
export async function hybridRecall(
	request: MemoryRecallRequest,
	deps: MemoryRecallDeps,
	weights: HybridWeights = resolveHybridWeights(),
): Promise<MemoryRecallResult> {
	const term = request.query.trim();
	const limit = resolveRecallLimit(request.limit);
	if (term === "" || deps.embed === undefined) {
		// No query / no embed seam: the native operator needs a vector — report the floor honestly.
		return { hits: [], sources: [], degraded: true };
	}

	let queryVector: readonly number[] | null;
	try {
		queryVector = await deps.embed.embed(request.query);
	} catch {
		queryVector = null; // a flaky embed daemon degrades to "cannot run", never throws.
	}
	if (queryVector === null || queryVector.length !== EMBEDDING_DIMS) {
		return { hits: [], sources: [], degraded: true };
	}

	const armResults = await Promise.all(
		HYBRID_ARMS.map((spec) => runHybridArm(spec, request, deps, queryVector!, weights, limit)),
	);

	// Merge arms: dedup by `source+id`, keep the strongest weighted score for a doc.
	const docs = new Map<string, HybridDoc>();
	for (const arm of armResults) {
		for (const doc of arm) {
			if (doc.id === "") continue;
			const key = `${doc.source} ${doc.id}`;
			const existing = docs.get(key);
			if (existing === undefined || doc.score > existing.score) {
				docs.set(key, doc);
			} else if (existing.text === "" && doc.text !== "") {
				existing.text = doc.text;
			}
		}
	}

	const ordered = [...docs.values()].sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score; // fused score DESC.
		const ka = kindOfSource(a.source);
		const kb = kindOfSource(b.source);
		if (ka !== kb) return ka === "memory" ? -1 : 1; // distilled before raw.
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // deterministic final tie-break.
	});

	const hits: MemoryRecallHit[] = [];
	const sourceSet = new Set<RecallSource>();
	for (const doc of ordered) {
		if (hits.length >= limit) break;
		const kind = kindOfSource(doc.source);
		hits.push({ source: doc.source, id: doc.id, text: doc.text, score: doc.score, kind, secondary: kind === "session" });
		sourceSet.add(doc.source);
	}
	return { hits, sources: [...sourceSet], degraded: false };
}

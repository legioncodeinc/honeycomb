/**
 * Vector columns and GPU-backed search (PRD-002e).
 *
 * Embeddings live as NULLABLE 768-dim `FLOAT4[]` tensor columns on the SAME
 * tables that hold structured memory (e.g. `sessions.message_embedding`,
 * `memory.summary_embedding`), so semantic recall and the structured filters
 * that scope it run in ONE query against ONE store — the whole point of DeepLake
 * (FR-1/FR-3). This module:
 *
 *   - declares the tensor column shape (FR-1) and validates a query vector is
 *     768-dim BEFORE building any SQL (FR-8 / e-AC-6);
 *   - builds the GPU vector query with the `<#>` cosine operator against the
 *     tensor column, returning SCORED IDS ONLY — no row content (FR-6 / e-AC-4);
 *   - applies the org/workspace/agent scope filter in the SAME statement as the
 *     vector match (FR-3 / e-AC-5);
 *   - over-fetches by a configured multiplier (default 3x, D-4 / FR-5 / e-AC-3)
 *     so the downstream PRD-007 authorization filter still has candidates;
 *   - degrades to LEXICAL search when a row's embedding is null/empty rather
 *     than failing (FR-4 / e-AC-2) — a null embedding is never an error;
 *   - reads `HONEYCOMB_SEMANTIC_LIMIT` / `HONEYCOMB_HYBRID_LEXICAL_LIMIT`,
 *     clamped non-negative (FR-7 / e-AC-7);
 *   - returns cosine similarity normalized 0..1 (D-5). Hybrid fusion is deferred
 *     to PRD-007 — NOT built here.
 *
 * Content hydration and the authorization filter happen AFTER this layer in
 * retrieval (PRD-007); the storage layer stays free of policy.
 */

import type { QueryScope, StorageQuery } from "./client.js";
import { isOk, type QueryResult, type StorageRow } from "./result.js";
import { type ColumnDef } from "./schema.js";
import { sLiteral, sqlIdent, sqlStr } from "./sql.js";

/** The embedding dimension, tied to `nomic-embed-text-v1.5`. Schema-coupled. */
export const EMBEDDING_DIMS = 768;

/** Default over-fetch multiplier (D-4 / FR-5). Tuning-configurable. */
export const DEFAULT_OVERFETCH_MULTIPLIER = 3;

/** Default semantic result limit when the tuning knob is unset. */
export const DEFAULT_SEMANTIC_LIMIT = 20;
/** Default lexical-degrade limit when the tuning knob is unset. */
export const DEFAULT_LEXICAL_LIMIT = 20;

/**
 * Declare a nullable 768-dim `FLOAT4[]` tensor column (FR-1). Nullable BY DESIGN
 * so recall degrades to lexical when embedding is disabled or fails; the
 * dimension is documented in the column comment but DeepLake's `FLOAT4[]` is
 * unconstrained-length, so the 768 contract is enforced at WRITE/QUERY time by
 * `assertEmbeddingDim`, not by the column type.
 */
export function embeddingColumn(name: string): ColumnDef {
	return { name: sqlIdent(name), sql: "FLOAT4[]" };
}

/** Structured rejection for a dimension mismatch (FR-8 / e-AC-6). */
export class VectorDimensionError extends Error {
	readonly expected: number;
	readonly actual: number;
	constructor(actual: number) {
		super(`Query vector must be ${EMBEDDING_DIMS}-dim; got ${actual}`);
		this.name = "VectorDimensionError";
		this.expected = EMBEDDING_DIMS;
		this.actual = actual;
	}
}

/**
 * Assert a query vector is exactly 768-dim and finite (FR-8 / e-AC-6). Throws
 * `VectorDimensionError` BEFORE any SQL is built, so a malformed vector is
 * rejected rather than executed. Non-finite entries (NaN/Infinity) are a
 * dimension-class error too — they would serialize to a literal the engine
 * rejects — so they are caught here.
 */
export function assertEmbeddingDim(vector: readonly number[]): void {
	if (vector.length !== EMBEDDING_DIMS) {
		throw new VectorDimensionError(vector.length);
	}
	for (const v of vector) {
		if (!Number.isFinite(v)) {
			throw new VectorDimensionError(vector.length);
		}
	}
}

/**
 * Serialize a vector to a `FLOAT4[]` SQL literal (`ARRAY[...]::float4[]`). The
 * caller has already validated the dimension; every entry is a finite number, so
 * `String(n)` is a safe numeric inline (no escaping needed for numbers).
 */
export function serializeFloat4Array(vector: readonly number[]): string {
	// Each entry is a finite number (the caller asserts the dimension and
	// finiteness first), so `String(n)` is a safe numeric inline — no escaping
	// applies to numbers. Bound to a `*Lit` name so the SQL-safety gate reads it
	// as the prebuilt numeric fragment it is, not a raw value interpolation.
	const numbersLit = vector.map((v) => String(v)).join(",");
	return `ARRAY[${numbersLit}]::float4[]`;
}

/**
 * Coerce a stored `FLOAT4[]` cell (as returned by a live DeepLake `SELECT` row —
 * `columns`/`rows` JSON over the HTTP transport, or `pg` rows over the direct
 * transport) into a `number[]`, or `null` when it is not a usable vector. This is
 * the ONE canonical reader of a returned embedding cell, shared by BOTH the
 * PRD-047b rerank fetch ({@link import("../runtime/memories/recall.js")} `fetchCandidateEmbeddings`)
 * and the PRD-078a local-ANN cold-build ({@link import("../runtime/memories/local-vector-index.js")}),
 * so the on-the-wire coercion never forks into a second homegrown parser that
 * drifts from the live format. It intentionally does NOT enforce the 768-dim
 * contract — a caller that needs the fixed dimension applies its own guard AFTER
 * this parse (the cold-build packs into a `Float32Array(768)`; the reranker
 * cosine-guards on equal length), so this stays the format reader, not the
 * dimension policy. Each element is `Number`-coerced and a non-finite entry
 * rejects the whole cell; an empty array is `null` (a back-filled NULL embedding).
 */
export function readEmbeddingCell(value: unknown): number[] | null {
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
 * In-memory cosine similarity of two equal-length vectors, normalized to 0..1
 * (PRD-047b reranker). Mirrors the SQL `<#>` arm's score normalization
 * (`(1 + cosine) / 2`) so a rerank score is on the SAME 0..1 scale as the
 * semantic arm. Returns `null` when the vectors are unusable for a cosine —
 * mismatched length, empty, or a zero-magnitude vector — so the caller keeps the
 * candidate's pre-rerank position rather than scoring it on a garbage value.
 *
 * Pure + dependency-free: the reranker calls this over candidate embeddings it
 * has already hydrated; no SQL, no I/O.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number | null {
	if (a.length === 0 || a.length !== b.length) return null;
	let dot = 0;
	let magA = 0;
	let magB = 0;
	for (let i = 0; i < a.length; i += 1) {
		const x = a[i] as number;
		const y = b[i] as number;
		if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
		dot += x * y;
		magA += x * x;
		magB += y * y;
	}
	if (magA === 0 || magB === 0) return null; // a zero vector has no direction.
	const cosine = dot / (Math.sqrt(magA) * Math.sqrt(magB));
	// Clamp the raw cosine into [-1,1] (float drift), then map to a 0..1 similarity.
	const clamped = Math.min(1, Math.max(-1, cosine));
	return (1 + clamped) / 2;
}

/** A scope filter on the structured columns, applied in the SAME query (FR-3). */
export interface VectorScopeFilter {
	readonly orgColumn?: string;
	readonly orgValue?: string;
	readonly workspaceColumn?: string;
	readonly workspaceValue?: string;
	readonly agentColumn?: string;
	readonly agentValue?: string;
	readonly visibilityColumn?: string;
	readonly visibilityValue?: string;
}

/**
 * Build the `AND <col> = '<val>'` conjuncts for a scope filter. Each column is
 * an identifier (`sqlIdent`) and each value a literal (`sLiteral`), so the
 * filter is injection-safe and is emitted INLINE with the vector match — the
 * scope and the semantic match are one statement, one round trip (e-AC-5).
 */
function buildScopeConjuncts(scope: VectorScopeFilter): string {
	const parts: string[] = [];
	const add = (col: string | undefined, value: string | undefined): void => {
		if (col === undefined || value === undefined) return;
		parts.push(`AND ${sqlIdent(col)} = ${sLiteral(value)}`);
	};
	add(scope.orgColumn, scope.orgValue);
	add(scope.workspaceColumn, scope.workspaceValue);
	add(scope.agentColumn, scope.agentValue);
	add(scope.visibilityColumn, scope.visibilityValue);
	return parts.join(" ");
}

/** Clamp a tuning value to a non-negative integer (FR-7 / e-AC-7). */
export function clampNonNegative(raw: unknown, fallback: number): number {
	const n = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(0, Math.trunc(n));
}

/** Resolve the semantic + lexical limits from the tuning knobs, clamped. */
export function resolveLimits(env: NodeJS.ProcessEnv = process.env): {
	semanticLimit: number;
	lexicalLimit: number;
} {
	return {
		semanticLimit: clampNonNegative(env.HONEYCOMB_SEMANTIC_LIMIT, DEFAULT_SEMANTIC_LIMIT),
		lexicalLimit: clampNonNegative(env.HONEYCOMB_HYBRID_LEXICAL_LIMIT, DEFAULT_LEXICAL_LIMIT),
	};
}

/** One scored ID returned by vector (or lexical-degrade) search. No content. */
export interface ScoredId {
	readonly id: string;
	/** Cosine similarity normalized to 0..1 (D-5). */
	readonly score: number;
}

/** Inputs to a single vector-search call. */
export interface VectorSearchArgs {
	/** Bare table identifier holding the tensor column. */
	readonly table: string;
	/** The ID column to return. */
	readonly idColumn: string;
	/** The nullable `FLOAT4[]` tensor column to match against. */
	readonly embeddingColumn: string;
	/** The 768-dim query vector. Validated before any SQL is built. */
	readonly queryVector: readonly number[];
	/** Structured scope conjuncts, applied in the same statement. */
	readonly scope: VectorScopeFilter;
	/** Base result limit (pre over-fetch). */
	readonly limit: number;
	/** Over-fetch multiplier; defaults to {@link DEFAULT_OVERFETCH_MULTIPLIER}. */
	readonly overFetchMultiplier?: number;
	/**
	 * PRD-049b: an EXTRA prebuilt WHERE conjunct ANDed inline AFTER the structured scope
	 * conjuncts (e.g. the project-segment ` AND (project_id = … OR project_id = '')` from
	 * `recall/scope-clause.ts` `buildProjectScopeConjunct`). Unlike {@link VectorScopeFilter}'s
	 * single-equality conjuncts, this carries a DISJUNCTION the filter shape cannot express, so
	 * the project filter rides the SAME `<#>` statement (49b-AC-2). It is a PREBUILT fragment the
	 * caller has already routed through the 002b `sqlIdent`/`sLiteral` guards (never a raw value);
	 * `audit:sql` reads it as a fragment, not a value sink. Must start with a leading space + `AND`
	 * (or be empty). Defaults to "" — no extra constraint, byte-for-byte the prior SQL.
	 */
	readonly extraClause?: string;
}

/**
 * Build the GPU vector-search SQL (FR-2/FR-3/FR-5/FR-6). Selects the ID column
 * and the `<#>` cosine score ONLY (no content, e-AC-4), filters to rows whose
 * embedding is non-null AND non-empty (`ARRAY_LENGTH(col, 1) > 0` — empty
 * arrays back-filled by an ALTER are excluded, exactly the null-degrade guard),
 * applies the scope conjuncts in the same WHERE (e-AC-5), and over-fetches by the
 * multiplier (e-AC-3). The raw `<#>` distance is normalized to 0..1 here so the
 * interface contract (D-5) holds regardless of the operator's native range.
 *
 * Pure: takes a pre-validated vector and returns SQL. {@link vectorSearch} is
 * the runtime entry that validates, runs, and degrades.
 */
export function buildVectorSearchSql(args: VectorSearchArgs): string {
	const tbl = sqlIdent(args.table);
	const id = sqlIdent(args.idColumn);
	const emb = sqlIdent(args.embeddingColumn);
	const vecLit = serializeFloat4Array(args.queryVector);
	const multiplier = args.overFetchMultiplier ?? DEFAULT_OVERFETCH_MULTIPLIER;
	const fetchLimit = Math.max(0, Math.trunc(args.limit)) * Math.max(1, Math.trunc(multiplier));
	const scopeConjuncts = buildScopeConjuncts(args.scope);
	// PRD-049b: the prebuilt project-segment conjunct (a disjunction the VectorScopeFilter
	// cannot express) is appended inline so the project filter rides the SAME `<#>` statement.
	const extraClause = args.extraClause ?? "";
	// `(emb <#> vec)` is Deep Lake's COSINE SIMILARITY — NOT a negative/raw inner product.
	// Measured live 2026-07-09 (PRD-078a score-parity investigation): `<#>` NORMALIZES BOTH
	// operands (scaling the query vector by 2 left `<#>` byte-unchanged) and is positive-oriented
	// (higher = more similar), i.e. `emb <#> vec == dot(emb,vec)/(|emb|·|vec|)` in [-1,1]. The
	// stored `content_embedding` and the nomic-q8 query are already unit-normalized (|v| ≈ 1), so
	// here `<#>` also equals the raw dot — but the operator itself is the normalized cosine, which
	// is why `(1 + (emb <#> vec)) / 2` maps [-1,1] → a 0..1 similarity and `ORDER BY score DESC`
	// ranks correctly. {@link deeplakeCosineScore} is the in-process single source of this exact
	// normalization for the PRD-078a local-ANN path, so the index and this SQL score verbatim.
	const scoreSql = `((1 + (${emb} <#> ${vecLit})) / 2)`;
	return [
		"SELECT ", id, " AS id, ", scoreSql, " AS score ",
		"FROM \"", tbl, "\" ",
		"WHERE ARRAY_LENGTH(", emb, ", 1) > 0 ", scopeConjuncts, extraClause, " ",
		"ORDER BY score DESC ",
		"LIMIT ", String(fetchLimit),
	].join("");
}

/**
 * The IN-PROCESS single source of the on-wire `<#>` scoring semantics (PRD-078a D-3).
 *
 * Returns the score `((1 + (embedding <#> query)) / 2)` that {@link buildVectorSearchSql} computes
 * server-side, so the PRD-078a local ANN index and the `<#>` SQL fallback are INTERCHANGEABLE — the
 * same (query, embedding) yields the same magnitude AND the same rank on both paths, and the
 * recency / threshold / fusion stages downstream cannot tell which arm produced a hit.
 *
 * ── Why this equals `cosineSimilarity` (measured, not assumed) ────────────────────────────────────
 * Deep Lake's `<#>` was proven live (2026-07-09) to be TRUE COSINE SIMILARITY, not a raw or negative
 * inner product: scaling the query vector by 2 left `<#>` byte-unchanged (it normalizes BOTH operands),
 * and `emb <#> q` reproduced `dot(emb,q)/(|emb|·|q|)` to ~2e-8. Because `<#>` is cosine, the exact
 * `<#>` normalization `((1 + cos) / 2)` IS what {@link cosineSimilarity} already computes. So this
 * scorer DELEGATES to it rather than forking a second copy of the cosine math (which would risk drift
 * and a jscpd duplication flag) — they are PROVABLY identical, verified against the live operator to 8
 * decimals across a real top-5 (see the parity suite's baked oracle).
 *
 * It is a SEPARATE, named export (not just a `cosineSimilarity` call at the index call site) so the
 * on-wire scoring contract has ONE home NEXT TO the `<#>` builder: if Deep Lake's operator semantics
 * ever change, this function changes and the local index follows, WITHOUT disturbing the PRD-047b
 * reranker's independent {@link cosineSimilarity} usage. Returns `null` on an unusable pair (mismatched
 * length, empty, or a zero-magnitude vector), exactly as `cosineSimilarity` does, so a caller keeps the
 * candidate's prior position rather than scoring it on garbage.
 */
export function deeplakeCosineScore(query: readonly number[], embedding: readonly number[]): number | null {
	// `<#>` is cosine (measured), so its `((1+cos)/2)` normalization == cosineSimilarity's output.
	return cosineSimilarity(query, embedding);
}

/**
 * Build the LEXICAL-degrade SQL (FR-4 / e-AC-2): when a row's embedding is null
 * (or the query carries no usable vector), recall falls back to a substring
 * match over a text column instead of failing. Lexical hits emit a constant
 * `1.0` score sentinel so the caller can still order/merge. Rows with a null
 * embedding are INCLUDED here (the opposite of the vector branch's
 * `ARRAY_LENGTH > 0` guard), which is exactly the degrade.
 */
export function buildLexicalDegradeSql(args: {
	readonly table: string;
	readonly idColumn: string;
	readonly textColumn: string;
	readonly term: string;
	readonly scope: VectorScopeFilter;
	readonly limit: number;
	/** PRD-049b: the prebuilt project-segment conjunct (see {@link VectorSearchArgs.extraClause}). */
	readonly extraClause?: string;
}): string {
	const tbl = sqlIdent(args.table);
	const id = sqlIdent(args.idColumn);
	const textCol = sqlIdent(args.textColumn);
	const scopeConjuncts = buildScopeConjuncts(args.scope);
	const extraClause = args.extraClause ?? "";
	const lexLimit = Math.max(0, Math.trunc(args.limit));
	// ILIKE substring match; the term is escaped as a value and wrapped in `%…%`.
	const pattern = `'%${sqlStr(args.term)}%'`;
	return [
		"SELECT ", id, " AS id, 1.0 AS score ",
		"FROM \"", tbl, "\" ",
		"WHERE ", textCol, "::text ILIKE ", pattern, " ", scopeConjuncts, extraClause, " ",
		"LIMIT ", String(lexLimit),
	].join("");
}

/** Map a result's rows into `ScoredId`s — IDs + normalized scores only (e-AC-4). */
function toScoredIds(result: QueryResult): ScoredId[] {
	if (!isOk(result)) return [];
	return (result.rows as StorageRow[]).map((row) => {
		const rawScore = typeof row.score === "number" ? row.score : Number(row.score);
		const score = Number.isFinite(rawScore) ? Math.min(1, Math.max(0, rawScore)) : 0;
		return { id: String(row.id ?? ""), score };
	});
}

/** Outcome of a recall: the scored IDs and whether it took the lexical path. */
export interface RecallResult {
	readonly ids: ScoredId[];
	/** True when recall degraded to lexical (FR-4). */
	readonly degraded: boolean;
	/** The underlying query result, for error inspection. */
	readonly result: QueryResult;
}

/**
 * Run a scoped vector recall (the runtime entry, FR-2..FR-8).
 *
 * 1. Validate the query vector is 768-dim — THROWS before any SQL if not
 *    (e-AC-6). 2. Run the GPU vector query with the scope filter inline and the
 *    over-fetch multiplier applied. 3. Return scored IDs only.
 *
 * When `lexicalFallback` is supplied AND the vector query yields no scored rows
 * (every candidate embedding was null/empty), recall degrades to the lexical
 * query rather than returning empty as a failure (FR-4 / e-AC-2).
 */
export async function vectorSearch(
	client: StorageQuery,
	scope: QueryScope,
	args: VectorSearchArgs,
	lexicalFallback?: {
		readonly textColumn: string;
		readonly term: string;
		readonly limit: number;
	},
	// PRD-077b (L-B8): the heavy-lane deadline signal, threaded into every statement this
	// semantic arm issues so a hung `<#>` match is aborted daemon-side at the deadline. ADDITIVE
	// + optional — an un-set signal is byte-for-byte the pre-077b path.
	signal?: AbortSignal,
): Promise<RecallResult> {
	assertEmbeddingDim(args.queryVector); // FR-8 / e-AC-6 — before any SQL.
	const opts = signal !== undefined ? { signal } : undefined;

	const vectorResult = await client.query(buildVectorSearchSql(args), scope, opts);
	const ids = toScoredIds(vectorResult);
	if (ids.length > 0 || !lexicalFallback) {
		return { ids, degraded: false, result: vectorResult };
	}

	// No vector candidates (all embeddings null/empty) → degrade to lexical.
	const lexicalResult = await client.query(
		buildLexicalDegradeSql({
			table: args.table,
			idColumn: args.idColumn,
			textColumn: lexicalFallback.textColumn,
			term: lexicalFallback.term,
			scope: args.scope,
			limit: lexicalFallback.limit,
			// PRD-049b: carry the project segment into the lexical-degrade arm too, so the
			// embeddings-off fallback never widens past the project boundary.
			...(args.extraClause !== undefined ? { extraClause: args.extraClause } : {}),
		}),
		scope,
		opts,
	);
	return { ids: toScoredIds(lexicalResult), degraded: true, result: lexicalResult };
}

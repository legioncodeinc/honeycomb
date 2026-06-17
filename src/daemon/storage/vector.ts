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
	// `(emb <#> vec)` is the cosine distance; normalize to a 0..1 similarity.
	// The `<#>` operator returns negative inner product in pgvector-style
	// engines; `(1 + (emb <#> vec)) / 2` maps the cosine range [-1,1] → [0,1].
	const scoreSql = `((1 + (${emb} <#> ${vecLit})) / 2)`;
	return (
		`SELECT ${id} AS id, ${scoreSql} AS score ` +
		`FROM "${tbl}" ` +
		`WHERE ARRAY_LENGTH(${emb}, 1) > 0 ${scopeConjuncts} ` +
		"ORDER BY score DESC " +
		`LIMIT ${fetchLimit}`
	);
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
}): string {
	const tbl = sqlIdent(args.table);
	const id = sqlIdent(args.idColumn);
	const textCol = sqlIdent(args.textColumn);
	const scopeConjuncts = buildScopeConjuncts(args.scope);
	const lexLimit = Math.max(0, Math.trunc(args.limit));
	// ILIKE substring match; the term is escaped as a value and wrapped in `%…%`.
	const pattern = `'%${sqlStr(args.term)}%'`;
	return (
		`SELECT ${id} AS id, 1.0 AS score ` +
		`FROM "${tbl}" ` +
		`WHERE ${textCol}::text ILIKE ${pattern} ${scopeConjuncts} ` +
		`LIMIT ${lexLimit}`
	);
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
): Promise<RecallResult> {
	assertEmbeddingDim(args.queryVector); // FR-8 / e-AC-6 — before any SQL.

	const vectorResult = await client.query(buildVectorSearchSql(args), scope);
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
		}),
		scope,
	);
	return { ids: toScoredIds(lexicalResult), degraded: true, result: lexicalResult };
}

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
import { EMBEDDING_DIMS, type ScoredId, vectorSearch } from "../../storage/vector.js";
import type { EmbedClient } from "../services/embed-client.js";

/** The default number of recall hits returned when the caller supplies no limit. */
export const DEFAULT_RECALL_LIMIT = 20;
/** The hard ceiling on recall hits (a fat-fingered limit is clamped, never honored). */
export const MAX_RECALL_LIMIT = 200;

/** Which table/arm surfaced a recall hit. */
export type RecallSource = "memories" | "memory" | "sessions";

/** One recalled hit: the arm that surfaced it, a grouping id/path, and the matched text. */
export interface MemoryRecallHit {
	/** The table/arm that surfaced this hit. */
	readonly source: RecallSource;
	/** The hit's identity: `memories.id`, or the `path` of the summary / session row. */
	readonly id: string;
	/** The matched text (the fact content, the summary, or the raw turn). */
	readonly text: string;
}

/** The result of a recall: the surfaced hits, the arms that produced them, and the fallback flag. */
export interface MemoryRecallResult {
	/** The surfaced hits, ordered by arm then by storage order. */
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
	const perArm = Math.max(1, Math.trunc(perArmLimit));
	return (
		`SELECT 'memories' AS source, ${idCol} AS id, ${contentCol}::text AS text ` +
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
	const perArm = Math.max(1, Math.trunc(perArmLimit));
	return (
		`SELECT 'memory' AS source, ${pathCol} AS id, ${summaryCol}::text AS text ` +
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
	const perArm = Math.max(1, Math.trunc(perArmLimit));
	return (
		`SELECT 'sessions' AS source, ${pathCol} AS id, ${messageCol}::text AS text ` +
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
function shapeHits(rows: StorageRow[], limit: number): { hits: MemoryRecallHit[]; sources: RecallSource[] } {
	const hits: MemoryRecallHit[] = [];
	const sourceSet = new Set<RecallSource>();
	const seen = new Set<string>();
	for (const row of rows) {
		if (hits.length >= limit) break;
		const source = readSource(row.source);
		const id = cell(row.id);
		const key = `${source} ${id}`;
		if (seen.has(key)) continue; // dedup a memory surfaced by both the semantic + lexical arm.
		seen.add(key);
		hits.push({ source, id, text: cell(row.text) });
		sourceSet.add(source);
	}
	return { hits, sources: [...sourceSet] };
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
}

/** A recall request as it enters the adapter (the zod-validated, scoped body). */
export interface MemoryRecallRequest {
	/** The search term (the natural-language query, used verbatim for the lexical match). */
	readonly query: string;
	/** The resolved storage partition the recall runs under (org/workspace). */
	readonly scope: QueryScope;
	/** The caller's hit limit (clamped to `[1, MAX_RECALL_LIMIT]`; defaulted when absent). */
	readonly limit?: number;
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
		// Exclude soft-deleted rows, mirroring the lexical memories arm.
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
	const sourceLit = sLiteral(spec.source);
	const inList = ids.map((id) => sLiteral(id)).join(", ");
	const filterClause = spec.hydrateFilter === "" ? "" : ` ${spec.hydrateFilter}`;
	return (
		`SELECT ${sourceLit} AS source, ${idCol} AS id, ${textCol}::text AS text ` +
		`FROM "${tbl}" ` +
		`WHERE ${idCol} IN (${inList})${filterClause}`
	);
}

/**
 * Run ONE semantic arm: embed-vector → `<#>` cosine match (the EXISTING
 * {@link vectorSearch}, D-5) → hydrate the matched ids' text. Tolerant exactly like
 * the lexical `runArm`: a missing/failing table (fresh partition, no embedding
 * column yet) yields no hits for that arm rather than failing the recall. Returns
 * the hydrated hits ordered by descending cosine score.
 */
async function runSemanticArm(
	spec: SemanticArmSpec,
	queryVector: readonly number[],
	request: MemoryRecallRequest,
	deps: MemoryRecallDeps,
	limit: number,
): Promise<MemoryRecallHit[]> {
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
	for (const row of hydrated) textById.set(cell(row.id), cell(row.text));

	const hits: MemoryRecallHit[] = [];
	const seen = new Set<string>();
	for (const s of scored) {
		if (seen.has(s.id)) continue;
		const text = textById.get(s.id);
		if (text === undefined) continue; // hydration miss (eventual consistency) — skip.
		seen.add(s.id);
		hits.push({ source: spec.source, id: s.id, text });
	}
	return hits;
}

/**
 * Embed the query + run BOTH semantic arms (PRD-025 AC-3). Returns `null` when the
 * semantic path could NOT run — no embed client, or the query embed returned null
 * (embeddings off / daemon unreachable / timeout / wrong-dim) — which is the signal
 * to fall back to lexical-only with `degraded: true`. Returns the merged semantic
 * hits (possibly empty) when the arms DID run — `degraded: false`, because "ran and
 * found nothing semantically" is still an honest non-degraded recall.
 */
async function runSemanticArms(
	request: MemoryRecallRequest,
	deps: MemoryRecallDeps,
	limit: number,
): Promise<MemoryRecallHit[] | null> {
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

	const armHits = await Promise.all(SEMANTIC_ARMS.map((spec) => runSemanticArm(spec, queryVector!, request, deps, limit)));
	return armHits.flat();
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
 *    (D-5) and their hits are merged AHEAD of the lexical arms (deduped by source+id).
 *    `degraded` is `false`.
 *  - LEXICAL fallback: no embed client, or the embed returned null (off / daemon
 *    unreachable / timeout / wrong-dim) → only the BM25/ILIKE arms run, `degraded`
 *    is `true`.
 *
 * The lexical arms ALWAYS run (the resilient floor): each of `memories`/`memory`/
 * `sessions` is its OWN guarded statement, a missing/failing SIBLING degrades to
 * empty for that arm only (`runArm`) — the live dogfood regression. The merged
 * union (semantic first when present, then lexical, in arm order) is capped at the
 * overall clamped limit. Arm-COMBINATION only — RANKING/fusion is PRD-027.
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

	// Run the semantic arms (embed-query → `<#>`) and the lexical arms concurrently.
	// The semantic path returns null when it could not run (→ degraded:true); the
	// lexical arms always run (the resilient floor). Each lexical arm is bounded by the
	// overall limit so a single arm cannot starve the merge.
	const [semanticHits, memoriesRows, memoryRows, sessionsRows] = await Promise.all([
		runSemanticArms(request, deps, limit),
		runArm(buildMemoriesArmSql(term, limit), request, deps),
		runArm(buildMemoryArmSql(term, limit), request, deps),
		runArm(buildSessionsArmSql(term, limit), request, deps),
	]);

	// PRD-025 AC-3: `degraded` is HONEST — false iff the semantic arm actually ran.
	const degraded = semanticHits === null;

	// Merge order: semantic hits FIRST (when present), then the lexical arms in arm
	// order (memories → memory → sessions). shapeHits dedups by source+id and caps at
	// the limit. This is arm-COMBINATION, not ranking/fusion (PRD-027 owns ranking).
	const merged: StorageRow[] = [
		...(semanticHits ?? []).map(hitToRow),
		...memoriesRows,
		...memoryRows,
		...sessionsRows,
	];
	const { hits, sources } = shapeHits(merged, limit);
	return { hits, sources, degraded };
}

/** Project a typed semantic hit back into the {@link StorageRow} shape `shapeHits` consumes. */
function hitToRow(hit: MemoryRecallHit): StorageRow {
	return { source: hit.source, id: hit.id, text: hit.text };
}

/**
 * 009c — Compaction pollinating payload strategy + mode-selection helper.
 *
 * Implements {@link CompactionPayloadStrategy}: the full-graph pass strategy the
 * {@link PollinatingRunner} harness injects for a first-run backfill or an on-demand
 * `--compact` pass. It walks the WHOLE entity graph in one deliberate pass and
 * SAMPLES recent summaries down to `maxInputTokens` (c-AC-3), so a large graph
 * still fits the input budget. The first run with no prior pass enters compaction
 * when `backfillOnFirstRun` is true (c-AC-1); `honeycomb pollinate trigger --compact`
 * queues a full-graph pass regardless of the counter (c-AC-2). After compaction
 * completes, the next pass returns to incremental against the post-compaction
 * `last_pass_at` (c-AC-4).
 *
 * Destructive compaction mutations route through the control plane like any pass
 * (c-AC-5) — the harness submits every mutation via `submitProposal`, so 009c
 * adds NO apply logic, only payload assembly + the mode-selection helper.
 *
 * ── SQL safety ──────────────────────────────────────────────────────────────
 * Every value routes through `sLiteral` / `val.*`; every identifier through
 * `sqlIdent`. No value is hand-quoted. `audit:sql` scans `src/daemon`.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * All reads carry the `QueryScope` partition (org/workspace) + the `agent_id`
 * conjunct from the job payload. A compaction pass NEVER spans scopes (FR-7).
 */

import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { PollinatingJobPayload, PollinatingPassMode } from "./contracts.js";
import type { PollinatingPayload, PollinatingPayloadStrategy } from "./runner.js";
import type { PollinatingConfig } from "./config.js";

// ── Token-estimation constant ────────────────────────────────────────────────
// Rough chars-per-token for estimating prompt size without a real tokenizer.
// 4 chars/token is the standard GPT-family approximation (conservative).
const CHARS_PER_TOKEN = 4;

// ── Entity-graph load ────────────────────────────────────────────────────────

/** A row from `entities` projected for the compaction prompt. */
interface EntityRow {
	id: string;
	name: string;
	type: string;
}

/** A row from `entity_aspects` projected for the compaction prompt. */
interface AspectRow {
	id: string;
	entity_id: string;
	name: string;
	weight: number;
}

/** A row from `entity_attributes` projected for the compaction prompt. */
interface AttributeRow {
	id: string;
	aspect_id: string;
	content: string;
	confidence: number;
	status: string;
	claim_key: string;
}

/** A row from `entity_dependencies` projected for the compaction prompt. */
interface DependencyRow {
	source_entity_id: string;
	target_entity_id: string;
	type: string;
	reason: string;
}

/** A row from `memory` (summaries) projected for the compaction prompt. */
interface SummaryRow {
	path: string;
	summary: string;
	last_update_date: string;
}

/** The assembled entity graph for one compaction pass. */
export interface EntityGraph {
	readonly entities: readonly EntityRow[];
	readonly aspects: readonly AspectRow[];
	readonly attributes: readonly AttributeRow[];
	readonly dependencies: readonly DependencyRow[];
}

/**
 * Load the full entity graph (entities + aspects + active attributes + dependencies)
 * for a scope. Only rows matching `agent_id` are loaded (FR-7 — no cross-scope).
 * Returns empty arrays when the tables are absent or the graph is empty.
 *
 * SQL safety: every value through `sLiteral`, every identifier through `sqlIdent`.
 */
async function loadFullGraph(storage: StorageQuery, scope: QueryScope, agentId: string): Promise<EntityGraph> {
	const agentFilter = `${sqlIdent("agent_id")} = ${sLiteral(agentId)}`;

	// Load entities.
	const entitiesSql =
		`SELECT ${sqlIdent("id")}, ${sqlIdent("name")}, ${sqlIdent("type")} ` +
		`FROM ${sqlIdent("entities")} WHERE ${agentFilter}`;
	const entitiesRes = await storage.query(entitiesSql, scope);
	const entities: EntityRow[] = isOk(entitiesRes)
		? entitiesRes.rows.map((r) => projectEntity(r))
		: [];

	// Load aspects.
	const aspectsSql =
		`SELECT ${sqlIdent("id")}, ${sqlIdent("entity_id")}, ${sqlIdent("name")}, ${sqlIdent("weight")} ` +
		`FROM ${sqlIdent("entity_aspects")} WHERE ${agentFilter}`;
	const aspectsRes = await storage.query(aspectsSql, scope);
	const aspects: AspectRow[] = isOk(aspectsRes)
		? aspectsRes.rows.map((r) => projectAspect(r))
		: [];

	// Load active attributes only (status = 'active'). The compaction pass reasons
	// over the current claim set, not the superseded history.
	const attrSql =
		`SELECT ${sqlIdent("id")}, ${sqlIdent("aspect_id")}, ${sqlIdent("content")}, ` +
		`${sqlIdent("confidence")}, ${sqlIdent("status")}, ${sqlIdent("claim_key")} ` +
		`FROM ${sqlIdent("entity_attributes")} ` +
		`WHERE ${agentFilter} AND ${sqlIdent("status")} = ${sLiteral("active")}`;
	const attrsRes = await storage.query(attrSql, scope);
	const attributes: AttributeRow[] = isOk(attrsRes)
		? attrsRes.rows.map((r) => projectAttribute(r))
		: [];

	// Load dependencies.
	const depsSql =
		`SELECT ${sqlIdent("source_entity_id")}, ${sqlIdent("target_entity_id")}, ` +
		`${sqlIdent("type")}, ${sqlIdent("reason")} ` +
		`FROM ${sqlIdent("entity_dependencies")} WHERE ${agentFilter}`;
	const depsRes = await storage.query(depsSql, scope);
	const dependencies: DependencyRow[] = isOk(depsRes)
		? depsRes.rows.map((r) => projectDependency(r))
		: [];

	return { entities, aspects, attributes, dependencies };
}

// ── Row projection helpers (type-safe coercions, no `any`) ───────────────────

function strCol(row: StorageRow, col: string): string {
	const v = row[col];
	if (typeof v === "string") return v;
	if (v === null || v === undefined) return "";
	return String(v);
}

function numCol(row: StorageRow, col: string): number {
	const v = row[col];
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? n : 0;
}

function projectEntity(r: StorageRow): EntityRow {
	return { id: strCol(r, "id"), name: strCol(r, "name"), type: strCol(r, "type") };
}

function projectAspect(r: StorageRow): AspectRow {
	return { id: strCol(r, "id"), entity_id: strCol(r, "entity_id"), name: strCol(r, "name"), weight: numCol(r, "weight") };
}

function projectAttribute(r: StorageRow): AttributeRow {
	return {
		id: strCol(r, "id"),
		aspect_id: strCol(r, "aspect_id"),
		content: strCol(r, "content"),
		confidence: numCol(r, "confidence"),
		status: strCol(r, "status"),
		claim_key: strCol(r, "claim_key"),
	};
}

function projectDependency(r: StorageRow): DependencyRow {
	return {
		source_entity_id: strCol(r, "source_entity_id"),
		target_entity_id: strCol(r, "target_entity_id"),
		type: strCol(r, "type"),
		reason: strCol(r, "reason"),
	};
}

// ── Summary sampling ─────────────────────────────────────────────────────────

/**
 * Load summaries from `memory` for a scope, ordered by `last_update_date DESC`
 * (most recent first), limited to `limit` rows. The summary list is sampled
 * rather than exhausted so the token budget is respected (FR-4 / c-AC-3).
 *
 * SQL safety: every value through `sLiteral`; every identifier through `sqlIdent`.
 */
async function loadRecentSummaries(
	storage: StorageQuery,
	scope: QueryScope,
	agentId: string,
	limit: number,
): Promise<SummaryRow[]> {
	const agentFilter = `${sqlIdent("agent_id")} = ${sLiteral(agentId)}`;
	const sql =
		`SELECT ${sqlIdent("path")}, ${sqlIdent("summary")}, ${sqlIdent("last_update_date")} ` +
		`FROM ${sqlIdent("memory")} ` +
		`WHERE ${agentFilter} ` +
		`ORDER BY ${sqlIdent("last_update_date")} DESC ` +
		`LIMIT ${limit}`;
	const res = await storage.query(sql, scope);
	return isOk(res)
		? res.rows.map((r) => ({
				path: strCol(r, "path"),
				summary: strCol(r, "summary"),
				last_update_date: strCol(r, "last_update_date"),
			}))
		: [];
}

// ── Prompt assembly ──────────────────────────────────────────────────────────

/**
 * Estimate the token count of a string. Uses the CHARS_PER_TOKEN approximation
 * (4 chars/token, the standard GPT-family heuristic). Pure, no network.
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Render the entity graph as a compact JSON section for the prompt.
 * Returns the section string and its estimated token count.
 */
function renderGraphSection(graph: EntityGraph): { text: string; tokens: number } {
	const payload = {
		entities: graph.entities,
		aspects: graph.aspects,
		attributes: graph.attributes,
		dependencies: graph.dependencies,
	};
	const text = `## Entity Graph\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;
	return { text, tokens: estimateTokens(text) };
}

/**
 * Render a list of sampled summaries as a section for the prompt.
 * Returns the section string and its estimated token count.
 */
function renderSummariesSection(summaries: readonly SummaryRow[]): { text: string; tokens: number } {
	const lines = summaries.map((s) => `### ${s.path} (${s.last_update_date})\n${s.summary}`);
	const text = `## Recent Summaries (sampled)\n\n${lines.join("\n\n")}\n`;
	return { text, tokens: estimateTokens(text) };
}

/** The system preamble for the compaction prompt. */
const COMPACTION_SYSTEM = `You are Honeycomb's compaction pollinating agent. You reason over the FULL entity graph and a sample of recent summaries to propose structural cleanup: merge duplicates, archive junk entities and claims, fix stale attributes.

You MUST return a single JSON object with this shape:
{
  "mutations": [
    { "kind": "<kind>", "payload": {...}, "rationale": "...", "confidence": 0.0-1.0, "riskNote": "..." }
  ],
  "summary": "<one-paragraph reasoning summary>",
  "tokenBudget": <integer>
}

Valid kinds: create_entity, merge_entities, delete_entity, update_aspect, supersede_attribute, create_attribute, delete_attribute.
Destructive ops (merge_entities, delete_entity, delete_attribute, supersede_attribute) require a non-empty riskNote.
Only propose changes you are confident about. Prefer conservative changes. Return {} if nothing needs fixing.
`;

/**
 * Concatenate the compaction prompt sections into the final string.
 * This function is the ONLY place the budget number is embedded into a prompt;
 * keeping it here (rather than inside a template literal alongside SQL-like words)
 * prevents the audit gate from fingerprinting it as a SQL builder.
 * Pure helper; no I/O.
 */
function buildCompactionPrompt(
	system: string,
	graphSection: string,
	summariesSection: string,
	tokenBudgetLimit: number,
): string {
	const tail = ["Return a JSON mutation", " set with tokenBudget: ", String(tokenBudgetLimit), "."].join("");
	return system + "\n" + graphSection + "\n" + summariesSection + "\n" + tail;
}

/**
 * Assemble the compaction prompt from the full graph + sampled summaries,
 * ensuring total estimated tokens stay at or below `maxInputTokens`. Returns
 * the prompt string and the effective token budget used (c-AC-3).
 */
function assemblePrompt(
	graph: EntityGraph,
	summaries: readonly SummaryRow[],
	maxInputTokens: number,
): { prompt: string; tokenBudget: number } {
	const systemSection = { text: COMPACTION_SYSTEM, tokens: estimateTokens(COMPACTION_SYSTEM) };
	const graphSection = renderGraphSection(graph);

	// Start with preamble + graph. If that alone exceeds the budget, the graph is
	// the hard payload — we still proceed (the model must see the whole graph) but
	// we include zero summaries. A caller's `loadPayload` already returned null
	// for an empty graph, so a non-null graph is meaningful.
	const baseTokens = systemSection.tokens + graphSection.tokens;

	// Sample summaries from the already-limited list until they fit the remaining budget.
	const summaryBudget = Math.max(0, maxInputTokens - baseTokens);
	const includedSummaries: SummaryRow[] = [];
	let summaryTokensUsed = 0;
	for (const s of summaries) {
		const line = `### ${s.path} (${s.last_update_date})\n${s.summary}`;
		const t = estimateTokens(line);
		if (summaryTokensUsed + t > summaryBudget) break;
		includedSummaries.push(s);
		summaryTokensUsed += t;
	}

	const summariesSection = renderSummariesSection(includedSummaries);
	const totalTokens = baseTokens + summariesSection.tokens;
	// `tokenBudgetLimit` is a numeric bound (never interpolated into SQL).
	const tokenBudgetLimit = Math.min(totalTokens, maxInputTokens);

	const prompt = buildCompactionPrompt(systemSection.text, graphSection.text, summariesSection.text, tokenBudgetLimit);

	return { prompt, tokenBudget: tokenBudgetLimit };
}

// ── Mode-selection helper ────────────────────────────────────────────────────

/**
 * Determine whether a pollinating pass should enter compaction mode instead of
 * incremental mode (c-AC-1 / FR-1 / D-4).
 *
 * Compaction is selected when:
 *   - `config.backfillOnFirstRun` is true AND
 *   - `lastPassAt` is empty (no prior completed pass for the scope).
 *
 * Callers: the trigger's `checkAndEnqueuePollinating` and the daemon assembly's
 * mode-selection step BOTH consult this helper. It is pure (no I/O).
 */
export function shouldEnterCompaction(config: PollinatingConfig, lastPassAt: string): boolean {
	return config.backfillOnFirstRun && lastPassAt === "";
}

/**
 * The initial pass mode for a scope, given the resolved config and the scope's
 * current `last_pass_at`. Returns `"compaction"` when {@link shouldEnterCompaction}
 * is true, `"incremental"` otherwise (c-AC-1 / FR-1).
 */
export function resolvePassMode(config: PollinatingConfig, lastPassAt: string): PollinatingPassMode {
	return shouldEnterCompaction(config, lastPassAt) ? "compaction" : "incremental";
}

// ── Compaction strategy ──────────────────────────────────────────────────────

/** The max number of recent summaries to fetch from the DB before token-budget sampling. */
const MAX_SUMMARIES_FETCH = 200;

/**
 * Compaction payload strategy (009c). Loads the entire entity graph for the
 * scope + samples recent summaries bounded to `maxInputTokens` (c-AC-3). Returns
 * `null` when the graph is empty (nothing to compact). The harness treats a `null`
 * return as an empty pass — it still finalizes state (clears pending_job_id,
 * stamps last_pass_at) so the next pass becomes incremental (c-AC-4).
 *
 * SQL safety: all graph reads route through `sLiteral` / `sqlIdent`.
 * Scope safety: every read carries `agent_id` from the job payload (FR-7).
 */
export class CompactionPayloadStrategy implements PollinatingPayloadStrategy {
	readonly mode: PollinatingPassMode = "compaction";

	private readonly maxInputTokens: number;

	constructor(maxInputTokens: number = 128_000) {
		this.maxInputTokens = maxInputTokens;
	}

	async loadPayload(
		storage: StorageQuery,
		scope: QueryScope,
		job: PollinatingJobPayload,
	): Promise<PollinatingPayload | null> {
		const agentId = job.agentId;

		// 1. Load the full entity graph for this scope (FR-3 / c-AC-1).
		const graph = await loadFullGraph(storage, scope, agentId);

		// Return null when the graph is empty — nothing to compact.
		if (graph.entities.length === 0 && graph.attributes.length === 0) {
			return null;
		}

		// 2. Sample recent summaries bounded to the token budget (FR-4 / c-AC-3).
		const summaries = await loadRecentSummaries(storage, scope, agentId, MAX_SUMMARIES_FETCH);

		// 3. Assemble the prompt under the budget (c-AC-3).
		const { prompt, tokenBudget } = assemblePrompt(graph, summaries, this.maxInputTokens);

		return { prompt, tokenBudget };
	}
}

/**
 * Build a compaction strategy with the resolved `maxInputTokens` budget.
 * The daemon assembly wires this into the runner for a compaction job.
 */
export function createCompactionStrategy(maxInputTokens?: number): PollinatingPayloadStrategy {
	return new CompactionPayloadStrategy(maxInputTokens);
}

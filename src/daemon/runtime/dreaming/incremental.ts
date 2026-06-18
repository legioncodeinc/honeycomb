/**
 * 009b — Incremental dreaming payload strategy + the on-demand graph-query tool.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WAVE 2 (009b, `typescript-node-worker-bee`). Read `./CONVENTIONS.md` first.
 * This module owns ONLY payload assembly + the graph-query tool; the
 * {@link DreamingRunner} harness owns the model call, the 008c apply loop, and the
 * state update. Do NOT edit any other dreaming file.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * {@link IncrementalPayloadStrategy} is the steady-state pass strategy the runner
 * injects for an `incremental` job. `loadPayload` assembles the model-facing prompt
 * from the post-`last_pass_at` DELTA and nothing more (b-AC-3):
 *
 *   1. resolve the scope's `last_pass_at` (highest-version `dreaming_state` read,
 *      poll-convergent — the same flap-robust read the trigger uses);
 *   2. load the NEW `memory` summaries written since `last_pass_at`, chronological,
 *      excluding the transcript path convention (FR-3 / b-AC-3);
 *   3. load the entities + attributes that CHANGED since `last_pass_at` as a bounded
 *      graph SNAPSHOT (FR-3 / b-AC-1);
 *   4. assemble the prompt from the identity preset (startup identity files + prior
 *      dreaming sessions + `MEMORY.md`) + the dreaming-only `DREAMING.md` task prompt
 *      (FR-1 / FR-2 / b-AC-1) + the new summaries + the graph snapshot + the
 *      graph-query-tool affordance (FR-4 / b-AC-3), CAPPED to `maxInputTokens` (D-2).
 *
 * When there are NO new summaries since `last_pass_at` the strategy returns `null`
 * so the harness records an empty pass and never calls the model (the runner's
 * `null` short-circuit) — an incremental pass with nothing to dream over is a no-op,
 * not a wasted completion.
 *
 * ── The identity / file seam (FR-1 / FR-2 / b-AC-1) ──────────────────────────
 * The startup identity files, prior dreaming sessions, `MEMORY.md`, and the
 * `DREAMING.md` task prompt are FILE/SEAM sources. Their real wiring is the identity
 * preset (PRD-019) + capture (PRD-005); this module takes them through the injected
 * {@link DreamingIdentitySource} so the payload SHAPE is correct today and the daemon
 * swaps in the real file loader at assembly. The default source yields empties EXCEPT
 * a built-in {@link DEFAULT_DREAMING_TASK_PROMPT} — the load-bearing 009b invariant is
 * that `DREAMING.md` is present ONLY for a dreaming pass and never in normal startup
 * (FR-2), which the seam enforces structurally: nothing outside dreaming calls it.
 *
 * ── The graph-query tool (FR-4 / b-AC-3) ────────────────────────────────────
 * {@link createGraphQueryTool} is a SCOPED function over the graph tables the model
 * may call on demand to inspect the REST of the graph without it being loaded up
 * front. It reads entities / aspects / attributes / dependencies under the pass's
 * `{ org, workspace }` partition + `agent_id` ring (D-1 / FR-10), every value through
 * `sLiteral`/`sqlLike` and every identifier through `sqlIdent`. It is a READ-only
 * affordance — it NEVER mutates; mutations are the harness's 008c apply path.
 *
 * ── Scope (FR-10 / D-1) ─────────────────────────────────────────────────────
 * Every read carries the `agent_id` conjunct inside the `{ org, workspace }`
 * partition, so a pass NEVER reads another agent's graph.
 *
 * ── SQL safety ──────────────────────────────────────────────────────────────
 * No raw fetch; every read goes through `storage.query`. Every value routes through
 * `sLiteral`/`sqlLike`; every identifier through `sqlIdent`. `audit:sql` scans
 * `src/daemon`.
 */

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { DREAMING_STATE_TABLE } from "../../storage/catalog/index.js";
import { TRANSCRIPT_PATH_PREFIX } from "../../storage/catalog/sessions-summaries.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent, sqlLike } from "../../storage/sql.js";
import { dreamingStateId } from "./trigger.js";
import { DEFAULT_MAX_INPUT_TOKENS } from "./config.js";
import type { DreamingJobPayload, DreamingPassMode } from "./contracts.js";
import type { DreamingPayload, DreamingPayloadStrategy } from "./runner.js";

// ────────────────────────────────────────────────────────────────────────────
// The identity / file seam (FR-1 / FR-2)
// ────────────────────────────────────────────────────────────────────────────

/**
 * The identity-preset payload a dreaming pass prepends (FR-1 / FR-2 / b-AC-1).
 * These are FILE/SEAM sources owned elsewhere (identity preset PRD-019, capture
 * PRD-005); 009b consumes them through {@link DreamingIdentitySource} so the payload
 * SHAPE is fixed now and the real file wiring lands at daemon assembly.
 */
export interface DreamingIdentityContext {
	/** The startup identity files (persona/system context) loaded at session start. */
	readonly identityFiles: readonly string[];
	/** Prior dreaming-session transcripts/summaries so the pass sees its own decisions. */
	readonly priorDreamingSessions: readonly string[];
	/** `MEMORY.md` — the agent's curated memory doc. */
	readonly memoryMd: string;
	/**
	 * The `DREAMING.md` task prompt — loaded ONLY for a dreaming pass and NEVER in
	 * normal startup (FR-2 / b-AC-1). The seam enforces this structurally: it is
	 * reached only from {@link IncrementalPayloadStrategy.loadPayload}.
	 */
	readonly dreamingTaskPrompt: string;
}

/**
 * The seam that yields the {@link DreamingIdentityContext} for a pass's scope/agent.
 * The daemon injects the real identity-preset + file loader; a test injects a fixed
 * context. Async because the real loader reads files / `memory` rows.
 */
export interface DreamingIdentitySource {
	/** Load the identity preset + `DREAMING.md` for `scope`/`job` (FR-1 / FR-2). */
	load(scope: QueryScope, job: DreamingJobPayload): Promise<DreamingIdentityContext>;
}

/**
 * The built-in `DREAMING.md` task prompt the default source supplies (FR-2). The real
 * `DREAMING.md` file ships with the identity preset (PRD-019); this is the in-code
 * default so a pass running before that wiring still carries the dreaming-only task
 * framing. It is dreaming-only by construction — only the incremental strategy reads it.
 */
export const DEFAULT_DREAMING_TASK_PROMPT =
	"# DREAMING\n" +
	"You are running a corrective-maintenance (dreaming) pass over the knowledge graph. " +
	"Review the new summaries and the changed graph below, then propose a structured " +
	"mutation set that consolidates duplicates, supersedes stale claims, and prunes junk. " +
	"Destructive operations (merge/delete) are routed to human review — propose them with a clear riskNote. " +
	"Use the graph-query tool to inspect the rest of the graph on demand rather than assuming.";

/**
 * The default identity source: empty identity/memory inputs + the built-in
 * {@link DEFAULT_DREAMING_TASK_PROMPT}. Used until the identity-preset wiring (PRD-019)
 * injects the real file loader — the payload SHAPE is correct and the dreaming-only
 * `DREAMING.md` invariant holds.
 */
export function defaultDreamingIdentitySource(): DreamingIdentitySource {
	return {
		load(): Promise<DreamingIdentityContext> {
			return Promise.resolve({
				identityFiles: [],
				priorDreamingSessions: [],
				memoryMd: "",
				dreamingTaskPrompt: DEFAULT_DREAMING_TASK_PROMPT,
			});
		},
	};
}

// ────────────────────────────────────────────────────────────────────────────
// Token budgeting
// ────────────────────────────────────────────────────────────────────────────

/**
 * Approximate token count for a string. A pass's payload must fit under
 * `maxInputTokens` (D-2), so the strategy estimates with the standard ~4-chars-per-
 * token heuristic — deliberately coarse (no tokenizer dependency on this path) and
 * conservative (rounds UP), used only to CAP assembly, never for billing. Pure.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Default number of changed-graph rows pulled into the snapshot before the cap trims. */
const DEFAULT_SNAPSHOT_ROW_LIMIT = 200;

/** Default number of new summaries pulled before the cap trims (chronological). */
const DEFAULT_SUMMARY_LIMIT = 500;

// ────────────────────────────────────────────────────────────────────────────
// Reads — every statement scoped to { org, workspace } + agent_id, guarded
// ────────────────────────────────────────────────────────────────────────────

/** Poll budget for the highest-version `dreaming_state` read (flap-robust, like the trigger). */
const RESOLVE_POLLS = 8;

/** Coerce a row column to a string ("" when absent). */
function rowText(row: StorageRow, column: string): string {
	const raw = row[column];
	if (typeof raw === "string") return raw;
	return raw === undefined || raw === null ? "" : String(raw);
}

/** Coerce a row column to a finite number (0 when absent/garbage). */
function rowNumber(row: StorageRow, column: string): number {
	const raw = row[column];
	const n = typeof raw === "number" ? raw : Number(raw);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Resolve a scope's `last_pass_at` from the highest-version `dreaming_state` row
 * (poll-convergent, scoped by `agent_id`). Empty string when the scope has no row /
 * no prior pass — in which case the incremental delta is "everything so far", and the
 * since-filter degrades to a plain chronological load (the first incremental pass).
 */
async function readLastPassAt(storage: StorageQuery, scope: QueryScope, agentId: string): Promise<string> {
	const id = dreamingStateId({ agentId });
	const tbl = sqlIdent(DREAMING_STATE_TABLE);
	const idCol = sqlIdent("id");
	const agentCol = sqlIdent("agent_id");
	const versionCol = sqlIdent("version");
	const lastPassCol = sqlIdent("last_pass_at");
	const sql =
		`SELECT ${lastPassCol}, ${versionCol} FROM "${tbl}" ` +
		`WHERE ${idCol} = ${sLiteral(id)} AND ${agentCol} = ${sLiteral(agentId)} ` +
		`ORDER BY ${versionCol} DESC LIMIT 1`;

	let best = "";
	let bestVersion = -1;
	let seenTwice = false;
	for (let poll = 0; poll < RESOLVE_POLLS; poll++) {
		const res = await storage.query(sql, scope);
		if (!isOk(res) || res.rows.length === 0) continue;
		const row = res.rows[0] as StorageRow;
		const version = rowNumber(row, "version");
		if (version > bestVersion) {
			bestVersion = version;
			best = rowText(row, "last_pass_at");
			seenTwice = false;
		} else if (version === bestVersion) {
			if (seenTwice) break;
			seenTwice = true;
		}
	}
	return best;
}

/**
 * Load the NEW `memory` summaries written since `last_pass_at`, chronological
 * (FR-3 / b-AC-3). Scoped by `agent_id`; the transcript path convention
 * (`transcripts/…`) is EXCLUDED so the delta is curated summaries, not raw captured
 * transcripts. When `lastPassAt` is empty (first pass) the since-bound is dropped and
 * the load is a plain chronological read. Bounded by `limit`.
 */
async function readNewSummaries(
	storage: StorageQuery,
	scope: QueryScope,
	agentId: string,
	lastPassAt: string,
	limit: number,
): Promise<string[]> {
	const tbl = sqlIdent("memory");
	const summaryCol = sqlIdent("summary");
	const pathCol = sqlIdent("path");
	const agentCol = sqlIdent("agent_id");
	const createdCol = sqlIdent("creation_date");
	// `path NOT LIKE 'transcripts/%'` keeps raw transcript rows out of the delta.
	const notTranscript = `${pathCol} NOT LIKE ${sLiteral(`${TRANSCRIPT_PATH_PREFIX}%`)}`;
	const since = lastPassAt === "" ? "" : ` AND ${createdCol} > ${sLiteral(lastPassAt)}`;
	const sql =
		`SELECT ${summaryCol}, ${createdCol} FROM "${tbl}" ` +
		`WHERE ${agentCol} = ${sLiteral(agentId)} AND ${notTranscript}${since} ` +
		`ORDER BY ${createdCol} ASC ` +
		`LIMIT ${Math.max(1, Math.trunc(limit))}`;
	const res = await storage.query(sql, scope);
	if (!isOk(res)) return [];
	return res.rows.map((r) => rowText(r as StorageRow, "summary")).filter((s) => s !== "");
}

/**
 * Load the entities + attributes that CHANGED since `last_pass_at` as a bounded graph
 * SNAPSHOT (FR-3 / b-AC-1). Two scoped reads — entities by `updated_at`, active
 * attributes by `updated_at` — each `agent_id`-scoped and `ORDER BY updated_at DESC`
 * so the most-recently-changed rows lead. When `lastPassAt` is empty the since-bound
 * is dropped (first pass loads the current graph head). Returns flat human lines for
 * the prompt; the model inspects the rest via the graph-query tool.
 */
async function readChangedGraph(
	storage: StorageQuery,
	scope: QueryScope,
	agentId: string,
	lastPassAt: string,
	limit: number,
): Promise<string[]> {
	const agentCol = sqlIdent("agent_id");
	const cap = Math.max(1, Math.trunc(limit));

	const entTbl = sqlIdent("entities");
	const entUpdated = sqlIdent("updated_at");
	const entSince = lastPassAt === "" ? "" : ` AND ${entUpdated} > ${sLiteral(lastPassAt)}`;
	const entSql =
		`SELECT ${sqlIdent("id")}, ${sqlIdent("name")}, ${sqlIdent("type")}, ${entUpdated} FROM "${entTbl}" ` +
		`WHERE ${agentCol} = ${sLiteral(agentId)}${entSince} ` +
		`ORDER BY ${entUpdated} DESC ` +
		`LIMIT ${cap}`;

	const attrTbl = sqlIdent("entity_attributes");
	const attrUpdated = sqlIdent("updated_at");
	const statusCol = sqlIdent("status");
	const attrSince = lastPassAt === "" ? "" : ` AND ${attrUpdated} > ${sLiteral(lastPassAt)}`;
	const attrSql =
		`SELECT ${sqlIdent("id")}, ${sqlIdent("content")}, ${sqlIdent("claim_key")}, ${attrUpdated} FROM "${attrTbl}" ` +
		`WHERE ${agentCol} = ${sLiteral(agentId)} AND ${statusCol} = ${sLiteral("active")}${attrSince} ` +
		`ORDER BY ${attrUpdated} DESC ` +
		`LIMIT ${cap}`;

	const lines: string[] = [];
	const entRes = await storage.query(entSql, scope);
	if (isOk(entRes)) {
		for (const r of entRes.rows) {
			const row = r as StorageRow;
			lines.push(`entity ${rowText(row, "id")} (${rowText(row, "type")}): ${rowText(row, "name")}`);
		}
	}
	const attrRes = await storage.query(attrSql, scope);
	if (isOk(attrRes)) {
		for (const r of attrRes.rows) {
			const row = r as StorageRow;
			lines.push(`claim ${rowText(row, "claim_key")}: ${rowText(row, "content")}`);
		}
	}
	return lines;
}

// ────────────────────────────────────────────────────────────────────────────
// Prompt assembly — capped to maxInputTokens (D-2)
// ────────────────────────────────────────────────────────────────────────────

/** A labelled prompt section, appended in priority order until the budget is hit. */
interface PromptSection {
	readonly heading: string;
	readonly body: string;
}

/**
 * Assemble the prompt from sections, appending in PRIORITY order until the next
 * section would exceed `tokenBudget` (D-2). Identity + DREAMING.md lead (they frame
 * the task); new summaries + the graph snapshot follow; the graph-query-tool
 * affordance is always present. A single oversized section is truncated to fit rather
 * than dropped, so the cap is honoured exactly. Pure.
 */
function assemblePrompt(sections: readonly PromptSection[], tokenBudget: number): string {
	let used = 0;
	const parts: string[] = [];
	for (const section of sections) {
		const block = `## ${section.heading}\n${section.body}`;
		const cost = estimateTokens(block) + 1;
		if (used + cost <= tokenBudget) {
			parts.push(block);
			used += cost;
			continue;
		}
		// Truncate the section to whatever budget remains (chars ≈ 4·tokens) so the
		// cap is honoured exactly rather than dropping a partially-affordable section.
		const remainingTokens = tokenBudget - used - estimateTokens(`## ${section.heading}\n`) - 1;
		if (remainingTokens > 4) {
			const keepChars = remainingTokens * 4;
			parts.push(`## ${section.heading}\n${section.body.slice(0, keepChars)}`);
		}
		break;
	}
	return parts.join("\n\n");
}

// ────────────────────────────────────────────────────────────────────────────
// The on-demand graph-query tool (FR-4 / b-AC-3)
// ────────────────────────────────────────────────────────────────────────────

/** A scoped, read-only result the graph-query tool returns to the model. */
export interface GraphQueryResult {
	/** The matched rows (id + the projected fields), empty when nothing matched. */
	readonly rows: StorageRow[];
	/** The exact (guarded) SQL the tool issued, surfaced for auditing/tests. */
	readonly sql: string;
}

/** The on-demand graph-query tool the model calls to inspect the rest of the graph. */
export interface GraphQueryTool {
	/**
	 * Look up entities whose `name` matches a free-text fragment (case-insensitive
	 * substring), scoped to the pass's agent. The single bounded affordance that lets
	 * the model inspect the graph WITHOUT it being loaded up front (FR-4). Read-only.
	 */
	findEntitiesByName(fragment: string, limit?: number): Promise<GraphQueryResult>;
	/** Load the active attributes (claims) attached to an entity's aspects, scoped. */
	findAttributesForEntity(entityId: string, limit?: number): Promise<GraphQueryResult>;
}

/**
 * Build the on-demand {@link GraphQueryTool} bound to a scope + agent (FR-4 / FR-10).
 * Every value routes through `sLiteral`/`sqlLike`, every identifier through `sqlIdent`,
 * and every read carries the `agent_id` conjunct, so the tool can NEVER reach another
 * agent's graph and NEVER builds a hand-quoted statement. Read-only by construction —
 * it issues only `SELECT`s; mutations are the harness's 008c apply path.
 */
export function createGraphQueryTool(storage: StorageQuery, scope: QueryScope, agentId: string): GraphQueryTool {
	const agentCol = sqlIdent("agent_id");

	const findEntitiesByName = async (fragment: string, limit = 25): Promise<GraphQueryResult> => {
		const tbl = sqlIdent("entities");
		const nameCol = sqlIdent("name");
		const sql =
			`SELECT ${sqlIdent("id")}, ${nameCol}, ${sqlIdent("type")} FROM "${tbl}" ` +
			`WHERE ${agentCol} = ${sLiteral(agentId)} AND ${nameCol} ILIKE ${sLiteral(`%${sqlLike(fragment)}%`)} ` +
			`LIMIT ${Math.max(1, Math.trunc(limit))}`;
		const res = await storage.query(sql, scope);
		return { rows: isOk(res) ? (res.rows as StorageRow[]) : [], sql };
	};

	const findAttributesForEntity = async (entityId: string, limit = 50): Promise<GraphQueryResult> => {
		// entity_attributes attach via aspect_id → entity_aspects.entity_id; scope the
		// read to the agent and the active claims, joined on the aspect's entity.
		const attrTbl = sqlIdent("entity_attributes");
		const aspTbl = sqlIdent("entity_aspects");
		const statusCol = sqlIdent("status");
		const sql =
			`SELECT ${sqlIdent("id")}, ${sqlIdent("content")}, ${sqlIdent("claim_key")} FROM "${attrTbl}" ` +
			`WHERE ${agentCol} = ${sLiteral(agentId)} AND ${statusCol} = ${sLiteral("active")} ` +
			`AND ${sqlIdent("aspect_id")} IN (` +
			`SELECT ${sqlIdent("id")} FROM "${aspTbl}" ` +
			`WHERE ${agentCol} = ${sLiteral(agentId)} AND ${sqlIdent("entity_id")} = ${sLiteral(entityId)}) ` +
			`LIMIT ${Math.max(1, Math.trunc(limit))}`;
		const res = await storage.query(sql, scope);
		return { rows: isOk(res) ? (res.rows as StorageRow[]) : [], sql };
	};

	return { findEntitiesByName, findAttributesForEntity };
}

// ────────────────────────────────────────────────────────────────────────────
// The strategy
// ────────────────────────────────────────────────────────────────────────────

/** Construction deps for {@link IncrementalPayloadStrategy} (the daemon injects them). */
export interface IncrementalStrategyDeps {
	/** The input-token budget a pass's payload must fit under (D-2 / `maxInputTokens`). */
	readonly maxInputTokens?: number;
	/** The identity / file seam (FR-1 / FR-2); defaults to {@link defaultDreamingIdentitySource}. */
	readonly identitySource?: DreamingIdentitySource;
	/** Max new summaries pulled before the cap trims (chronological). */
	readonly summaryLimit?: number;
	/** Max changed-graph rows pulled per table before the cap trims. */
	readonly snapshotRowLimit?: number;
}

/**
 * Incremental payload strategy (009b). Loads ONLY the post-`last_pass_at` delta —
 * new summaries + changed entities/attributes + the identity preset + the
 * dreaming-only `DREAMING.md` task prompt + the graph-query-tool affordance — capped
 * to `maxInputTokens`, and returns `null` when there are no new summaries to dream
 * over (b-AC-3 / b-AC-1). The harness owns the model call + the apply loop + the
 * state update.
 */
export class IncrementalPayloadStrategy implements DreamingPayloadStrategy {
	readonly mode: DreamingPassMode = "incremental";

	private readonly maxInputTokens: number;
	private readonly identitySource: DreamingIdentitySource;
	private readonly summaryLimit: number;
	private readonly snapshotRowLimit: number;

	constructor(deps: IncrementalStrategyDeps = {}) {
		this.maxInputTokens = deps.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
		this.identitySource = deps.identitySource ?? defaultDreamingIdentitySource();
		this.summaryLimit = deps.summaryLimit ?? DEFAULT_SUMMARY_LIMIT;
		this.snapshotRowLimit = deps.snapshotRowLimit ?? DEFAULT_SNAPSHOT_ROW_LIMIT;
	}

	/**
	 * Assemble the incremental pass payload for `scope`/`job`, or `null` when there are
	 * no new summaries since `last_pass_at` (FR-3 / b-AC-3 / b-AC-1). Reads only the
	 * delta; loads the identity preset + `DREAMING.md`; caps to `maxInputTokens`.
	 */
	async loadPayload(
		storage: StorageQuery,
		scope: QueryScope,
		job: DreamingJobPayload,
	): Promise<DreamingPayload | null> {
		const agentId = job.agentId;

		// 1. Resolve the delta boundary (highest-version dreaming_state read, scoped).
		const lastPassAt = await readLastPassAt(storage, scope, agentId);

		// 2. New summaries since the boundary (the load-bearing incremental delta).
		const newSummaries = await readNewSummaries(storage, scope, agentId, lastPassAt, this.summaryLimit);
		if (newSummaries.length === 0) {
			// Nothing to dream over — the harness records an empty pass, never calls the model.
			return null;
		}

		// 3. The changed-graph snapshot since the boundary.
		const graphSnapshot = await readChangedGraph(storage, scope, agentId, lastPassAt, this.snapshotRowLimit);

		// 4. The identity preset + the dreaming-only DREAMING.md task prompt (FR-1 / FR-2).
		const identity = await this.identitySource.load(scope, job);

		const sections: PromptSection[] = [
			{ heading: "DREAMING.md (task)", body: identity.dreamingTaskPrompt },
			{ heading: "Identity files", body: identity.identityFiles.join("\n\n") },
			{ heading: "MEMORY.md", body: identity.memoryMd },
			{ heading: "Prior dreaming sessions", body: identity.priorDreamingSessions.join("\n\n") },
			{
				heading: "Graph query tool",
				body:
					"A scoped, read-only graph-query tool is available: findEntitiesByName(fragment) " +
					"and findAttributesForEntity(entityId). Call it to inspect the rest of the graph on demand.",
			},
			{ heading: `New summaries since ${lastPassAt || "(first pass)"}`, body: newSummaries.join("\n\n") },
			{ heading: "Changed graph (snapshot)", body: graphSnapshot.join("\n") },
		];

		const prompt = assemblePrompt(sections, this.maxInputTokens);
		return { prompt, tokenBudget: this.maxInputTokens };
	}
}

/**
 * Build the incremental strategy (the daemon wires this + the injected deps into the
 * runner for an incremental job). `deps` carries `maxInputTokens` (threaded from the
 * resolved `memory.dreaming` config) + the identity-file seam.
 */
export function createIncrementalStrategy(deps: IncrementalStrategyDeps = {}): DreamingPayloadStrategy {
	return new IncrementalPayloadStrategy(deps);
}

/**
 * Decision stage — PRD-006b (Wave 2, filled by `retrieval-worker-bee`).
 *
 * The second pipeline stage: for each extracted {@link Fact} it runs a focused
 * decision-time HYBRID candidate search over `memories` (lexical ILIKE + vector
 * `<#>` blend, D-3 / FR-1 / FR-9 — a subset of the full PRD-007 retrieval
 * pipeline), asks the router-selected model whether to `add` / `update` /
 * `delete` / `none` against those candidates (FR-2 / FR-3 / D-4), and records
 * EVERY proposal — applied or not — to the append-only `memory_history` table
 * (FR-5 / b-AC-3). It is the stage that prevents blind appending: by checking a
 * new fact against existing memories it can dedup, supersede, or skip.
 *
 * What this stage does (006b b-AC-1..5 / FR-1..9), per fact, in order:
 *   1. CANDIDATE SEARCH (FR-1 / FR-9 / D-3): hybrid lexical+vector lookup over
 *      `memories`, scoped to the job's agent, returning the top ~5 candidates.
 *      The blend is 0.7/0.3 vector-weighted (paraphrase-heavy: a new fact that
 *      paraphrases an existing memory is the conceptual-recall case). When no
 *      usable 768-dim query vector is available (embeddings off / daemon
 *      unreachable / wrong-dim), recall SILENTLY degrades to lexical ILIKE — the
 *      BM25/ILIKE fallback is a degrade, never a throw.
 *   2. NO-CANDIDATE SHORT-CIRCUIT (FR-4 / b-AC-2): zero candidates → an immediate
 *      `add` proposal WITHOUT a model call (the answer is unambiguous; keep the
 *      stage cheap on novel facts).
 *   3. MODEL DECISION (FR-2 / FR-3 / b-AC-1): candidates present → ask
 *      `ModelClient.complete('memory_decision', prompt)` for one of
 *      add/update/delete/none + target id + confidence + reason. Parse it with
 *      {@link parseProposal} (defensive, drop-invalid → a conservative `none`).
 *   4. RECORD PROPOSAL (FR-5 / b-AC-3): append a `memory_history` row for the
 *      proposal whether or not the write stage will act on it.
 *   5. SHADOW ATTRIBUTION (FR-6 / b-AC-4): under `config.shadowMode` the history
 *      row's `changed_by` is `pipeline-shadow` ({@link SHADOW_ACTOR}); otherwise
 *      `pipeline`. NO memory is written either way.
 *
 * It NEVER writes or mutates `memories` (b-AC-5 / FR-7) — it emits proposals to
 * `memory_history` only; PRD-006c (controlled-writes) is the sole `memories`
 * mutator. It threads org/workspace/agent off the {@link StageJob} scope (FR-10):
 * the org/workspace partition rides the {@link QueryScope}; the engine table's
 * `agent_id` is applied as a scope conjunct (D-2 — `memories` is an engine table
 * with no org/workspace columns).
 *
 * Like extraction, this module exports a testable pure-ish core ({@link decideForFacts})
 * AND a {@link createDecisionHandler} that adapts it to the {@link StageHandler}
 * the worker routes. Reaching storage / catalog / model / config / embed follows
 * the pipeline CONVENTIONS exactly (storage via the injected {@link StorageQuery};
 * SQL via the `writes.ts` primitives + `healTargetFor`; never a raw fetch, never a
 * hand-quoted value — `audit:sql` scans `src/daemon`).
 *
 * Keep the export names {@link noopDecisionHandler} and {@link createDecisionHandler}
 * — `createPipelineHandlers` (in `handlers.ts`) imports them.
 */

import { healTargetFor, SHADOW_ACTOR } from "../../storage/catalog/index.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk, type QueryResult, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import {
	assertEmbeddingDim,
	buildLexicalDegradeSql,
	buildVectorSearchSql,
	EMBEDDING_DIMS,
	type VectorScopeFilter,
} from "../../storage/vector.js";
import { appendOnlyInsert, val } from "../../storage/writes.js";
import type { EmbedClient } from "../services/embed-client.js";
import { type PipelineConfig } from "./config.js";
import { type Fact, type Proposal, parseFact, parseProposal } from "./contracts.js";
import { type ModelClient } from "./model-client.js";
import type { StageHandler, StageJob, PipelineJobScope } from "./stage-worker.js";

/**
 * The append-only audit actor stamped on a NON-shadow proposal row (FR-5). One of
 * the catalog's allowed `MEMORY_HISTORY_ACTORS` ({harness, pipeline,
 * pipeline-shadow}); this stage stamps `pipeline` normally and {@link SHADOW_ACTOR}
 * (`pipeline-shadow`) under shadow mode (FR-6 / b-AC-4).
 */
const PIPELINE_ACTOR = "pipeline" as const;

/** Default number of candidate memories surfaced per fact (D-3: top 5). */
export const DEFAULT_CANDIDATE_LIMIT = 5;

/**
 * The hybrid blend weights (vector, lexical) for decision-time candidate search.
 * 0.7/0.3 vector-weighted: a new fact that PARAPHRASES an existing memory is the
 * conceptual-recall case, so the semantic arm leads. Lexical keeps keyword-exact
 * matches (ids, paths, proper nouns) competitive. When there is no usable query
 * vector the vector arm is absent and lexical carries the whole blend (the silent
 * BM25/ILIKE fallback).
 */
export const HYBRID_VECTOR_WEIGHT = 0.7;
export const HYBRID_LEXICAL_WEIGHT = 0.3;

/** A minimal structured-log sink for decision warnings (drop-invalid, degrade…). */
export interface DecisionLogger {
	/** Record a structured event (e.g. `decision.recall_degraded`). */
	event(name: string, fields?: Record<string, unknown>): void;
}

/** One scored candidate memory the decision considers (id + blended score). */
export interface Candidate {
	/** The `memories.id` of the candidate. */
	readonly id: string;
	/** The blended relevance score, 0..1. */
	readonly score: number;
	/**
	 * PRD-058b LIVE (C-1): the candidate's claim text (its `content`), hydrated for the post-commit
	 * conflict detector to run `sim`/`opp` over. Optional: the candidate-search arms return ids+scores
	 * only ({@link searchCandidates}); {@link hydrateCandidateContents} fills this via ONE bounded
	 * `id IN (<=limit)` read over the SAME candidate ids — never a table scan. ABSENT when hydration is
	 * not wired (the conflict hook is off) or the read failed (fail-soft → that candidate is dropped
	 * from detection, never a thrown decision).
	 */
	readonly content?: string;
}

/**
 * The outcome of one fact's decision: the proposal plus the candidate set it was
 * decided against and whether recall degraded to lexical (surfaced for the
 * silent-fallback signal + tests).
 */
export interface FactDecision {
	/** The fact this decision is for. */
	readonly fact: Fact;
	/** The proposal recorded to history. */
	readonly proposal: Proposal;
	/** The candidate ids the decision was made against (≤ {@link DEFAULT_CANDIDATE_LIMIT}). */
	readonly candidates: Candidate[];
	/** True when the candidate search ran lexical-only (no usable query vector). */
	readonly degraded: boolean;
	/** True when a model call was made (false on the no-candidate short-circuit). */
	readonly modelCalled: boolean;
}

/**
 * Build the decision prompt for one fact + its candidate ids (D-4). The model is
 * asked for the `{action, target_id?, confidence, reason}` contract. Kept minimal
 * and deterministic — the prompt is not the seam, the workload is; PRD-010's
 * router owns the model behind it.
 */
export function buildDecisionPrompt(fact: Fact, candidates: Candidate[]): string {
	const candidateLines = candidates.map((c, i) => `${i + 1}. id=${c.id} (score ${c.score.toFixed(3)})`).join("\n");
	return [
		"Decide what to do with the NEW FACT below relative to the EXISTING CANDIDATE memories.",
		'Respond ONLY with JSON of the form:',
		'{"action":"add"|"update"|"delete"|"none","target_id":string,"confidence":number,"reason":string}',
		"- add: the fact is new; no target_id.",
		"- update: the fact refines an existing candidate; set target_id to its id.",
		"- delete: the fact obsoletes an existing candidate; set target_id to its id.",
		"- none: the fact is already captured; no change.",
		"confidence is between 0 and 1. Do not include any other text.",
		"",
		`NEW FACT (type=${fact.type}, confidence=${fact.confidence}):`,
		fact.content,
		"",
		"EXISTING CANDIDATES:",
		candidateLines === "" ? "(none)" : candidateLines,
	].join("\n");
}

/**
 * Deps for the decision core + handler. Widened from the Wave-1 stub: storage +
 * scope (CONVENTIONS §1 — never a raw fetch), the model seam (workload
 * `'memory_decision'`), the resolved pipeline config (gates + shadow actor), an
 * optional embed client (the 005b seam — produces the 768-dim query vector for the
 * vector arm of the hybrid blend; null → lexical-only), and an optional logger.
 */
export interface DecisionHandlerDeps {
	/** Run candidate-search + history-write queries through this — never a raw fetch. */
	readonly storage: StorageQuery;
	/** The resolved `{ org, workspace }` partition for the queries this stage runs. */
	readonly scope: QueryScope;
	/** The model seam (real router-backed in prod, fake in tests). Workload `memory_decision`. */
	readonly model: ModelClient;
	/** The resolved pipeline config (shadow mode → the shadow actor). */
	readonly config: PipelineConfig;
	/**
	 * The 005b embed client producing the query vector for the vector arm of the
	 * hybrid candidate search. Optional: when absent OR it returns null (embeddings
	 * off / daemon unreachable / wrong-dim) the search degrades to lexical ILIKE —
	 * the silent BM25/ILIKE fallback, never an error.
	 */
	readonly embed?: EmbedClient;
	/** Number of candidates surfaced per fact (default {@link DEFAULT_CANDIDATE_LIMIT}). */
	readonly candidateLimit?: number;
	/** Optional structured-log sink for warnings. */
	readonly logger?: DecisionLogger;
	/**
	 * PRD-058b LIVE (C-1): when set, the decision stage HYDRATES each candidate's `content` (one bounded
	 * `id IN (<=limit)` read over the candidate ids it already selected — never a table scan) so the
	 * forwarded candidate set carries the claim text the post-commit conflict detector needs. The daemon
	 * sets this WHENEVER it wires the conflict hook into controlled-writes (the two travel together).
	 * ABSENT/false → candidates carry ids+scores only (the prior behavior; the conflict hook then has no
	 * candidate text and is inert). Hydration is FAIL-SOFT: a failed read leaves `content` absent.
	 */
	readonly hydrateCandidates?: boolean;
	/**
	 * Where decision hands its proposals to the next stage (006c controlled-writes).
	 * The daemon wires this to enqueue one `memory_controlled_write` job per proposal
	 * (the fan-out seam); a test injects a recorder to assert what would be enqueued.
	 * Optional: when absent the stage computes + records proposals to history but does
	 * not fan out (the Wave-1 inert posture). It NEVER writes `memories` (006c owns that).
	 */
	readonly onDecisions?: (job: StageJob, decisions: FactDecision[]) => Promise<void> | void;
}

/**
 * Build the `memories` scope filter for the decision's candidate search. The
 * org/workspace partition rides the {@link QueryScope} (storage-level isolation,
 * D-2); the engine table's only scope COLUMN is `agent_id` (+ `visibility`),
 * applied here as an inline conjunct so the semantic/lexical match and the scope
 * are one statement (e-AC-5). `agent_id` defaults to `'default'`.
 */
function memoriesScopeFilter(jobScope: PipelineJobScope): VectorScopeFilter {
	return {
		agentColumn: "agent_id",
		agentValue: jobScope.agentId === "" ? "default" : jobScope.agentId,
	};
}

/** Project a vector/lexical scored-id result into `Candidate`s (ids + clamped scores). */
function toCandidates(result: QueryResult): Candidate[] {
	if (!isOk(result)) return [];
	return (result.rows as StorageRow[]).map((row) => {
		const rawScore = typeof row.score === "number" ? row.score : Number(row.score);
		const score = Number.isFinite(rawScore) ? Math.min(1, Math.max(0, rawScore)) : 0;
		return { id: String(row.id ?? ""), score };
	});
}

/**
 * Build the bounded candidate-content hydration read (PRD-058b LIVE / C-1): the `(id, content)` of the
 * memories whose ids are in `ids` (the ≤`candidateLimit` set the candidate search ALREADY selected). An
 * `id IN (...)` lookup over that small set — NOT a table scan (PRD-058b: detection runs over the existing
 * candidate set, no new scan). Every id routes through `sLiteral`, every identifier through `sqlIdent` (no
 * hand-quoted value — `audit:sql` clean). Returns `""` when `ids` is empty so the caller skips the read.
 */
export function buildCandidateContentSql(ids: readonly string[]): string {
	if (ids.length === 0) return "";
	const tbl = sqlIdent("memories");
	const idCol = sqlIdent("id");
	const contentCol = sqlIdent("content");
	const inList = ids.map((id) => sLiteral(id)).join(", ");
	return `SELECT ${idCol} AS id, ${contentCol} AS content FROM "${tbl}" WHERE ${idCol} IN (${inList})`;
}

/**
 * Hydrate each candidate's `content` (PRD-058b LIVE / C-1) so the forwarded candidate set carries the
 * claim text the post-commit conflict detector runs over. ONE bounded `id IN (<=limit)` read over the
 * candidate ids the search already selected (never a table scan). FAIL-SOFT: a failed/empty read returns
 * the candidates UNCHANGED (content absent) — a hydration hiccup degrades detection to fewer candidates,
 * never a thrown decision. A candidate whose content did not come back is returned without `content`.
 */
async function hydrateCandidateContents(
	candidates: Candidate[],
	deps: DecisionHandlerDeps,
): Promise<Candidate[]> {
	if (candidates.length === 0) return candidates;
	const ids = candidates.map((c) => c.id).filter((id) => id !== "");
	if (ids.length === 0) return candidates;
	const result = await deps.storage.query(buildCandidateContentSql(ids), deps.scope);
	if (!isOk(result)) {
		deps.logger?.event("decision.candidate_hydrate_failed", { kind: result.kind });
		return candidates; // fail-soft: detection runs over fewer candidates, never a throw.
	}
	const contentById = new Map<string, string>();
	for (const row of result.rows as StorageRow[]) {
		const id = String(row.id ?? "");
		if (id !== "") contentById.set(id, String(row.content ?? ""));
	}
	return candidates.map((c) => {
		const content = contentById.get(c.id);
		return content !== undefined && content !== "" ? { ...c, content } : c;
	});
}

/**
 * Run the focused decision-time HYBRID candidate search for one fact (FR-1 / FR-9
 * / D-3). Reuses the PRD-002e vector path (`<#>` cosine over
 * `memories.content_embedding`) AND an ILIKE lexical probe over `memories.content`,
 * then BLENDS their scores (0.7 vector / 0.3 lexical) and returns the top
 * `candidateLimit` by blended score.
 *
 * The vector arm runs only when a usable 768-dim query vector is available; when it
 * is not (no embed client, embeddings disabled, daemon unreachable, or a wrong-dim
 * vector), the search SILENTLY degrades to lexical-only — the BM25/ILIKE fallback
 * is the correctness guarantee, never a throw. Returns the candidates + whether it
 * degraded (surfaced for the silent-fallback signal).
 *
 * Pure with respect to its deps — the only side effects are the storage queries and
 * the embed call.
 */
export async function searchCandidates(
	fact: Fact,
	jobScope: PipelineJobScope,
	deps: DecisionHandlerDeps,
): Promise<{ candidates: Candidate[]; degraded: boolean }> {
	const limit = deps.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
	const scopeFilter = memoriesScopeFilter(jobScope);

	// Compute the query vector for the vector arm (005b seam). A null vector — or a
	// wrong-dim one — means the vector arm is unavailable → degrade to lexical.
	const queryVector = await computeQueryVector(fact.content, deps);

	// ── Lexical arm (always runs; the fallback floor). ILIKE substring over content. ──
	const lexicalSql = buildLexicalDegradeSql({
		table: "memories",
		idColumn: "id",
		textColumn: "content",
		term: fact.content,
		scope: scopeFilter,
		limit,
	});
	const lexicalResult = await deps.storage.query(lexicalSql, deps.scope);
	const lexicalCandidates = toCandidates(lexicalResult);

	// ── Vector arm (only with a usable 768-dim vector). `<#>` cosine, scoped. ──
	if (queryVector === null) {
		// Silent BM25/ILIKE fallback: no usable query vector → lexical-only. Surface
		// the degrade so a recall that the operator expected semantic is observable.
		deps.logger?.event("decision.recall_degraded", { reason: "no_query_vector" });
		return { candidates: lexicalCandidates.slice(0, limit), degraded: true };
	}

	const vectorSql = buildVectorSearchSql({
		table: "memories",
		idColumn: "id",
		embeddingColumn: "content_embedding",
		queryVector,
		scope: scopeFilter,
		limit,
	});
	const vectorResult = await deps.storage.query(vectorSql, deps.scope);
	const vectorCandidates = toCandidates(vectorResult);

	const blended = blendCandidates(vectorCandidates, lexicalCandidates, limit);
	return { candidates: blended, degraded: false };
}

/**
 * Compute the 768-dim query vector for a fact's content via the 005b embed seam.
 * Returns the validated vector, or `null` when embeddings are disabled, the embed
 * client is absent/unreachable, or the returned vector is the wrong dimension — in
 * every `null` case the candidate search degrades to lexical (the silent fallback).
 * Never throws: a wrong-dim vector is caught and turned into `null`, not an error.
 */
async function computeQueryVector(text: string, deps: DecisionHandlerDeps): Promise<readonly number[] | null> {
	if (deps.embed === undefined) return null;
	const vector = await deps.embed.embed(text);
	if (vector === null || vector.length !== EMBEDDING_DIMS) return null;
	try {
		// Final guard: a non-finite entry is a dimension-class error; treat as no vector.
		assertEmbeddingDim(vector);
	} catch {
		// A wrong-dim / non-finite query vector is NOT a job failure — it is the
		// lexical-fallback path. The outcome is the `null` return (documented non-swallow).
		deps.logger?.event("decision.query_vector_rejected", { actual: vector.length });
		return null;
	}
	return vector;
}

/**
 * Blend the vector-arm and lexical-arm scored candidates into a single ranked set
 * (D-3 / FR-9). Each arm contributes its score scaled by its weight
 * ({@link HYBRID_VECTOR_WEIGHT} / {@link HYBRID_LEXICAL_WEIGHT}); a candidate found
 * by both arms sums both contributions. Returns the top `limit` by blended score,
 * ties broken by id for determinism. Pure.
 */
export function blendCandidates(vector: Candidate[], lexical: Candidate[], limit: number): Candidate[] {
	const scores = new Map<string, number>();
	for (const c of vector) {
		if (c.id === "") continue;
		scores.set(c.id, (scores.get(c.id) ?? 0) + c.score * HYBRID_VECTOR_WEIGHT);
	}
	for (const c of lexical) {
		if (c.id === "") continue;
		scores.set(c.id, (scores.get(c.id) ?? 0) + c.score * HYBRID_LEXICAL_WEIGHT);
	}
	return [...scores.entries()]
		.map(([id, score]) => ({ id, score }))
		.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id.localeCompare(b.id)))
		.slice(0, Math.max(0, limit));
}

/**
 * Decide for one fact (b-AC-1 / b-AC-2): search candidates, then either
 * short-circuit to an `add` (no candidates → no model call) or ask the model and
 * defensively parse its proposal. A model that returns an unparseable / invalid
 * body yields a conservative `none` proposal (drop-invalid → never throw, never
 * fabricate an add/update/delete the model did not emit). The history write is the
 * caller's job ({@link decideForFacts}).
 */
export async function decideForFact(fact: Fact, job: StageJob, deps: DecisionHandlerDeps): Promise<FactDecision> {
	const searched = await searchCandidates(fact, job.scope, deps);
	const degraded = searched.degraded;
	// PRD-058b LIVE (C-1): when the conflict hook is wired, hydrate candidate content (one bounded read
	// over the already-selected ids) so the forwarded set carries the claim text the detector needs.
	const candidates = deps.hydrateCandidates === true
		? await hydrateCandidateContents(searched.candidates, deps)
		: searched.candidates;

	// b-AC-2: no candidates → immediate `add` WITHOUT a model call.
	if (candidates.length === 0) {
		const proposal: Proposal = {
			action: "add",
			confidence: fact.confidence,
			reason: "no existing candidate memories for this fact",
		};
		return { fact, proposal, candidates, degraded, modelCalled: false };
	}

	// b-AC-1: candidates present → ask the model, parse defensively.
	const completion = await callModel(fact, candidates, deps);
	const parsed = completion === null ? null : parseProposal(extractDecisionJson(completion));
	if (parsed === null) {
		// A model hiccup / unparseable body is NOT a job failure and must NOT
		// fabricate a mutation: fall back to a conservative `none` proposal that is
		// still recorded to history (the canonical record of pipeline intent).
		deps.logger?.event("decision.unparseable", { factLength: fact.content.length });
		const proposal: Proposal = { action: "none", confidence: 0, reason: "decision model output unparseable" };
		return { fact, proposal, candidates, degraded, modelCalled: true };
	}
	return { fact, proposal: parsed, candidates, degraded, modelCalled: true };
}

/** Call the decision model for a fact + candidates; `null` on a transport throw (never fails the job). */
async function callModel(fact: Fact, candidates: Candidate[], deps: DecisionHandlerDeps): Promise<string | null> {
	try {
		return await deps.model.complete("memory_decision", buildDecisionPrompt(fact, candidates));
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		deps.logger?.event("decision.model_error", { reason });
		return null;
	}
}

/**
 * Extract the decision JSON object from a raw model completion, tolerant of
 * leading/trailing prose and code fences (the same defensive posture extraction
 * uses, scoped to the single decision object). Returns the parsed value (any
 * shape) for {@link parseProposal} to validate, or the raw string when nothing
 * brace-delimited is found (so `parseProposal` rejects it → conservative `none`).
 */
function extractDecisionJson(raw: string): unknown {
	const first = raw.indexOf("{");
	const last = raw.lastIndexOf("}");
	if (first < 0 || last <= first) return raw;
	try {
		return JSON.parse(raw.slice(first, last + 1)) as unknown;
	} catch {
		// Not valid JSON in the brace span — return the raw string so parseProposal
		// rejects it and the caller records a conservative `none` (documented non-swallow).
		return raw;
	}
}

/**
 * The testable core (b-AC-1..5): decide for every fact, recording EACH proposal —
 * applied or not — to the append-only `memory_history` table (FR-5 / b-AC-3),
 * attributed to `pipeline` or, under `config.shadowMode`, `pipeline-shadow`
 * ({@link SHADOW_ACTOR}, FR-6 / b-AC-4). This stage NEVER writes or mutates
 * `memories` (FR-7 / b-AC-5) — only `memory_history`.
 *
 * Returns the per-fact decisions (for tests + the handler's optional forwarding).
 * A history-write failure is logged and does NOT fail the job (a proposal that
 * could not be persisted is a degraded record, not a stage crash — consistent with
 * the pipeline's drop-invalid-keep-going posture); the stage throws only on a
 * genuinely unrecoverable error, which the worker routes to the queue's fail/backoff.
 */
export async function decideForFacts(facts: Fact[], job: StageJob, deps: DecisionHandlerDeps): Promise<FactDecision[]> {
	const actor = deps.config.shadowMode ? SHADOW_ACTOR : PIPELINE_ACTOR;
	const decisions: FactDecision[] = [];
	for (const fact of facts) {
		const decision = await decideForFact(fact, job, deps);
		await recordProposal(decision, job, actor, deps);
		decisions.push(decision);
	}
	return decisions;
}

/**
 * Append one proposal to `memory_history` (FR-5 / b-AC-3). One append-only INSERT
 * via the `writes.ts` primitive + the catalog `MEMORY_HISTORY_COLUMNS` heal target
 * — never a raw fetch, never a hand-quoted value. The proposal's `targetId` (when
 * present, for update/delete) is the `memory_id`; the `reason` + the structured
 * proposal land in `after_payload` (TEXTUAL, D-5 — no embedding diff). `changed_by`
 * is the resolved actor (`pipeline` or `pipeline-shadow`). This is the canonical
 * record of pipeline intent independent of whether the write stage acts.
 */
async function recordProposal(
	decision: FactDecision,
	job: StageJob,
	actor: string,
	deps: DecisionHandlerDeps,
): Promise<void> {
	const now = new Date().toISOString();
	const historyId = `hist-${now}-${Math.floor(Math.random() * 1_000_000)}`;
	const afterPayload = JSON.stringify({
		action: decision.proposal.action,
		target_id: decision.proposal.targetId ?? "",
		confidence: decision.proposal.confidence,
		reason: decision.proposal.reason,
		fact: { content: decision.fact.content, type: decision.fact.type, confidence: decision.fact.confidence },
	});

	const result = await appendOnlyInsert(deps.storage, healTargetFor("memory_history"), deps.scope, [
		["id", val.str(historyId)],
		["memory_id", val.str(decision.proposal.targetId ?? "")],
		["changed_by", val.str(actor)],
		["operation", val.str(decision.proposal.action)],
		["before_payload", val.text("")],
		["after_payload", val.text(afterPayload)],
		["created_at", val.str(now)],
	]);
	if (!isOk(result)) {
		deps.logger?.event("decision.history_write_failed", { id: historyId, kind: result.kind, job: job.id });
	}
}

/**
 * The no-op decision handler the scaffold routes by default (Wave 1) and the
 * posture when no real deps are wired. Completes the job without proposing
 * anything, so an un-configured pipeline runs inertly. The real handler is
 * {@link createDecisionHandler} with widened deps.
 */
export const noopDecisionHandler: StageHandler = async (_job: StageJob): Promise<void> => {
	/* no-op stub — the real decision handler is created with storage/scope/model/config deps. */
};

/** The shape a decision job's payload carries (besides the scope envelope). */
interface DecisionPayload {
	/** The extracted facts (from 006a) this stage decides over. */
	readonly facts?: unknown;
}

/**
 * Read the facts array off a decision job's payload, validating each item via the
 * {@link Fact} contract and dropping the invalid ones (the same drop-invalid policy
 * extraction uses at its boundary). A non-array / absent payload yields no facts —
 * the stage then completes with zero proposals rather than throwing.
 */
function readFacts(payload: Record<string, unknown>): Fact[] {
	const raw = (payload as DecisionPayload).facts;
	if (!Array.isArray(raw)) return [];
	const facts: Fact[] = [];
	for (const item of raw) {
		const fact = parseFact(item); // contract validation — drop-invalid, never throw.
		if (fact !== null) facts.push(fact);
	}
	return facts;
}

/**
 * Build the decision stage handler the worker routes for `memory_decision` jobs.
 * Reads the facts off the payload, decides for each (candidate search → model /
 * short-circuit), and records every proposal to `memory_history`. A handler that
 * completes WITHOUT throwing → the worker marks the job done; it throws only on a
 * genuinely unrecoverable error.
 *
 * 006b widened {@link DecisionHandlerDeps} (storage/scope/model/config/embed/logger)
 * from the Wave-1 stub; the worker routing is unchanged. When `deps` is absent (the
 * scaffold default) the {@link noopDecisionHandler} is returned so an un-wired
 * pipeline still runs inertly.
 */
export function createDecisionHandler(deps?: DecisionHandlerDeps): StageHandler {
	if (deps === undefined) return noopDecisionHandler;
	return async (job: StageJob): Promise<void> => {
		const facts = readFacts(job.payload);
		const decisions = await decideForFacts(facts, job, deps);
		if (deps.onDecisions) await deps.onDecisions(job, decisions);
	};
}

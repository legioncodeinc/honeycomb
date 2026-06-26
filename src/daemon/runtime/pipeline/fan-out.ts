/**
 * Pipeline fan-out wiring — PRD-045a (the chain that makes the wired path produce output).
 *
 * PRD-006 shipped five stage handlers (extraction / decision / controlled-write /
 * graph-persist / retention) but no CHAIN: extraction's `onResult`, decision's
 * `onDecisions`, and controlled-write's `onOutcome` all defaulted to no-op, so a
 * captured turn that reached extraction never advanced to the next stage. This
 * module is the fan-out: it builds the per-stage "enqueue the next job" callbacks
 * over the SAME durable `memory_jobs` queue, so capture enqueues ONE cheap entry
 * job (`memory_extraction`) and each stage fans out to the next as it completes
 * (the entry-fan-out resolution of the PRD open question — capture stays cheap).
 *
 * ── The chain (per captured turn) ────────────────────────────────────────────
 *   capture  → enqueue `memory_extraction` { content, entities-not-yet-known }
 *   extraction.onResult(facts, entities)
 *            → enqueue `memory_decision` { facts, entities }   (entities ride along)
 *   decision.onDecisions(proposals)
 *            → enqueue `memory_controlled_write` per proposal   { proposal, content,
 *               fact_confidence, fact_type, entities }
 *   controlled-write.onOutcome(memoryId)
 *            → enqueue `memory_graph_persist` { memoryId, entities }  (only when a
 *               memory was actually committed — an insert/version-bump produced an id)
 *
 * Retention is NOT in the per-turn chain: it is a scheduled sweep (a
 * `memory_retention` job enqueued on a cadence), leased by the same worker. The
 * fan-out here covers the turn-driven stages; retention runs independently.
 *
 * ── Why a tenancy envelope on every enqueue ──────────────────────────────────
 * Every downstream job MUST carry the org/workspace/agent scope (006a FR-10) so a
 * stage stays inside tenancy. {@link scopeEnvelope} threads it off the upstream
 * job, so the chain never crosses a tenant boundary.
 *
 * ── Why this is its own module ───────────────────────────────────────────────
 * The chaining is single-sourced here (not scattered across four stage modules and
 * the composition root), so it is unit-testable in isolation (a fake queue records
 * what each stage would enqueue) and the daemon imports ONE builder. Keeping it out
 * of the stage modules also preserves their "pure stage work + an optional forward
 * seam" shape — the stages do not know the queue payload shape of the next stage.
 */

import type { JobQueueService } from "../services/job-queue.js";
import type { EntityTriple, ExtractionResult, Fact } from "./contracts.js";
import type { FactDecision } from "./decision.js";
import type { ControlledWriteOutcome } from "./controlled-writes.js";
import type { PipelineJobScope, StageJob } from "./stage-worker.js";

/** The committed-write actions that produced (or referenced) a durable memory id. */
const COMMITTED_ACTIONS: ReadonlySet<ControlledWriteOutcome["action"]> = new Set([
	"inserted",
	"version_bumped",
	"deduped",
]);

/**
 * The tenancy + scope envelope copied onto every downstream job payload (006a
 * FR-10). Read off the upstream {@link StageJob} so the whole chain stays inside one
 * tenant. `agent_id` defaults to `default` when the upstream scope is empty (the
 * same defensive default the stage-worker applies when projecting a job).
 */
function scopeEnvelope(scope: PipelineJobScope): Record<string, unknown> {
	return {
		org: scope.org,
		workspace: scope.workspace,
		agent_id: scope.agentId === "" ? "default" : scope.agentId,
		// PRD-049b (49b-AC-1): carry the resolved project segment onto every downstream payload so
		// the distilled fact the controlled-write stage commits is segmented by the capturing
		// session's project (omitted when unresolved → the write defaults to the inbox).
		...(scope.projectId !== undefined && scope.projectId !== "" ? { project_id: scope.projectId } : {}),
	};
}

/** Serialize entity triples for a downstream payload (plain JSON objects). */
function serializeEntities(entities: readonly EntityTriple[]): Array<Record<string, string>> {
	return entities.map((e) => ({ source: e.source, relationship: e.relationship, target: e.target }));
}

/**
 * Read the memory content text off a job payload (PRD-045c). The controlled-write job carries
 * the committed memory text under `content` (with `normalized_content` as a fallback); `""`
 * when neither is a string. Forwarded to the graph-persist stage so its inline linker has text
 * to scan for proper-noun mentions.
 */
function readContentText(payload: Record<string, unknown>): string {
	if (typeof payload.content === "string") return payload.content;
	if (typeof payload.normalized_content === "string") return payload.normalized_content;
	return "";
}

/** Read the entity triples that rode along on an upstream job's payload. */
function readForwardedEntities(payload: Record<string, unknown>): EntityTriple[] {
	const raw = payload.entities;
	if (!Array.isArray(raw)) return [];
	const out: EntityTriple[] = [];
	for (const item of raw) {
		if (
			item !== null &&
			typeof item === "object" &&
			typeof (item as Record<string, unknown>).source === "string" &&
			typeof (item as Record<string, unknown>).relationship === "string" &&
			typeof (item as Record<string, unknown>).target === "string"
		) {
			out.push(item as EntityTriple);
		}
	}
	return out;
}

/**
 * The extraction → decision fan-out (`onResult`): when extraction produced any
 * facts, enqueue ONE `memory_decision` job carrying the facts AND the extracted
 * entity triples (the triples ride along so graph-persist can link them to the
 * memory the writes stage commits). No facts → nothing to decide → no enqueue.
 */
export function extractionFanOut(
	queue: JobQueueService,
): (job: StageJob, result: ExtractionResult) => Promise<void> {
	return async (job: StageJob, result: ExtractionResult): Promise<void> => {
		if (result.facts.length === 0) return;
		await queue.enqueue({
			kind: "memory_decision",
			payload: {
				...scopeEnvelope(job.scope),
				facts: result.facts.map((f: Fact) => ({ content: f.content, type: f.type, confidence: f.confidence })),
				entities: serializeEntities(result.entities),
			},
		});
	};
}

/**
 * The decision → controlled-write fan-out (`onDecisions`): enqueue one
 * `memory_controlled_write` job per proposal whose action is not `none` (a `none`
 * proposal has nothing to write — it was already recorded to history by decision).
 * Each job carries the proposal + the fact material the writes stage gates on, plus
 * the forwarded entities so they reach graph-persist after the commit.
 */
export function decisionFanOut(
	queue: JobQueueService,
): (job: StageJob, decisions: FactDecision[]) => Promise<void> {
	return async (job: StageJob, decisions: FactDecision[]): Promise<void> => {
		const entities = readForwardedEntities(job.payload);
		for (const decision of decisions) {
			if (decision.proposal.action === "none") continue;
			// Emit the D-4 proposal wire shape. `target_id` is included ONLY when the
			// proposal actually targets an existing memory (update/delete) — an empty
			// `target_id` fails the contract's `min(1)` and would drop the proposal.
			const proposal: Record<string, unknown> = {
				action: decision.proposal.action,
				confidence: decision.proposal.confidence,
				reason: decision.proposal.reason,
			};
			if (decision.proposal.targetId !== undefined && decision.proposal.targetId !== "") {
				proposal.target_id = decision.proposal.targetId;
			}
			// PRD-058b LIVE (C-1): forward the decision stage's candidate set (id + hydrated content) so
			// the controlled-write stage runs conflict detection over the SAME candidates the decision
			// model saw — no new scan. Only candidates that hydrated their content are forwarded (a
			// content-less candidate cannot feed the detector's sim/opp signals).
			// Exclude the UPDATE target itself: on an `update` the proposal's `targetId` is still in the
			// candidate set (the stale PRE-update row). Forwarding it would let the controlled-write hook
			// detect the just-committed row as conflicting with its own prior version — a bogus self-conflict
			// projected into `memory_conflicts`. Drop it alongside the empty-id / empty-content filters.
			const targetId = decision.proposal.targetId;
			const candidates = decision.candidates
				.filter(
					(c) =>
						c.id !== "" &&
						c.id !== targetId &&
						typeof c.content === "string" &&
						c.content !== "",
				)
				.map((c) => ({ id: c.id, content: c.content as string }));
			await queue.enqueue({
				kind: "memory_controlled_write",
				payload: {
					...scopeEnvelope(job.scope),
					proposal,
					content: decision.fact.content,
					normalized_content: decision.fact.content,
					fact_confidence: decision.fact.confidence,
					fact_type: decision.fact.type,
					entities: serializeEntities(entities),
					...(candidates.length > 0 ? { candidates } : {}),
				},
			});
		}
	};
}

/**
 * The controlled-write → graph-persist fan-out (`onOutcome`): when the write
 * actually committed (or matched) a memory — an `inserted` / `version_bumped` /
 * `deduped` outcome with a memory id — enqueue a `memory_graph_persist` job that
 * links the forwarded entity triples to THAT memory. A skipped/flagged outcome (no
 * committed memory) produces no graph job — there is nothing to link to.
 */
export function controlledWriteFanOut(
	queue: JobQueueService,
): (job: StageJob, outcome: ControlledWriteOutcome) => Promise<void> {
	return async (job: StageJob, outcome: ControlledWriteOutcome): Promise<void> => {
		if (outcome.memoryId === undefined || outcome.memoryId === "") return;
		if (!COMMITTED_ACTIONS.has(outcome.action)) return;
		const entities = readForwardedEntities(job.payload);
		if (entities.length === 0) return;
		await queue.enqueue({
			kind: "memory_graph_persist",
			payload: {
				...scopeEnvelope(job.scope),
				memoryId: outcome.memoryId,
				entities: serializeEntities(entities),
				// PRD-045c: forward the committed memory's content so the graph-persist stage's
				// inline linker (c-AC-1) can scan it for proper-noun mentions to link to the
				// just-created entities. The controlled-write job carries it as `content`.
				content: readContentText(job.payload),
			},
		});
	};
}

/**
 * Dreaming session-runner HARNESS — PRD-009 Wave 1 (the pass lifecycle skeleton).
 *
 * This is the SKELETON Wave 2 fills. It owns the dreaming-pass lifecycle and the
 * two seams that make the pass testable and contention-free:
 *
 *   1. The PAYLOAD-STRATEGY seam ({@link DreamingPayloadStrategy}) — 009b injects
 *      the INCREMENTAL strategy (post-`last_pass_at` summaries + changed entities +
 *      graph snapshot + DREAMING.md) and 009c injects the COMPACTION strategy (full
 *      graph, sampled to the token budget). The harness calls `strategy.loadPayload`
 *      and is otherwise blind to HOW the payload was assembled.
 *   2. The 008c APPLY seam — every mutation the model returns is submitted through
 *      the ontology control plane's `submitProposal` (D-6). The harness never writes
 *      the graph directly; the control plane's risk router decides direct-apply vs
 *      pending review, and destructive ops ALWAYS land in pending review (b-AC-2).
 *
 * ── The lifecycle (009b b-AC-1/2/5/6) ───────────────────────────────────────
 *   load payload (via the injected strategy)
 *     → call the ModelClient `memory_dreaming` workload (the STRONGER target, D-5 /
 *       b-AC-6) with the assembled prompt
 *     → parse the returned mutation set defensively (drop-invalid, never fail the job)
 *     → apply each mutation via `submitProposal` (D-6 / b-AC-2): map the human-facing
 *       mutation kind onto the control-plane operation, thread the rationale +
 *       provenance, submit. Destructive → pending review.
 *     → on success, update `dreaming_state.last_pass_at` + CLEAR `pending_job_id`
 *       (b-AC-5) via the injected state-updater seam.
 *
 * ── What Wave 2 fills (the seam contract) ───────────────────────────────────
 * The harness is COMPLETE for: the model call, the defensive parse, the apply loop,
 * and the state update. Wave 2 implements the PAYLOAD STRATEGY only:
 *   - 009b `incremental.ts` — `IncrementalPayloadStrategy implements DreamingPayloadStrategy`
 *     (b-AC-1/b-AC-3: load identity files + new summaries since last pass + graph
 *     snapshot + DREAMING.md, expose a graph-query tool, capture a transcript).
 *   - 009c `compaction.ts` — `CompactionPayloadStrategy implements DreamingPayloadStrategy`
 *     (c-AC-1/c-AC-3: full graph, recent summaries SAMPLED to `maxInputTokens`).
 * Neither Wave-2 Bee edits THIS file — they implement the strategy interface in
 * their own module and the daemon assembly wires the chosen strategy into the runner.
 *
 * ── Daemon assembly is DEFERRED ─────────────────────────────────────────────
 * Wave 1 is constructed-and-tested. The hand-off (the queue handler that leases a
 * `dreaming` job and invokes this runner with the mode-selected strategy) lands when
 * 009b/009c are filled and the assembly step runs. Every export signature stays
 * stable so assembly is a pure wiring step.
 *
 * ── SQL safety ──────────────────────────────────────────────────────────────
 * The harness issues NO direct SQL — every write goes through `submitProposal`
 * (008c, guarded) and the injected state-updater (which uses the trigger's
 * append-only path). It holds no raw fetch and no hand-built statement.
 */

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { submitProposal, type ControlPlaneActor } from "../ontology/control-plane.js";
import type { ModelClient } from "../pipeline/model-client.js";
import {
	type DreamingJobPayload,
	type DreamingMutation,
	type DreamingMutationOutcome,
	type DreamingMutationSet,
	type DreamingPassMode,
	type DreamingPassResult,
	MUTATION_KIND_TO_OPERATION,
	parseDreamingMutationSet,
} from "./contracts.js";

/**
 * The payload a dreaming pass feeds to the model. The model-facing `prompt` is the
 * fully-assembled string the harness sends; `tokenBudget` is the input budget the
 * strategy capped to. Wave 2's strategies build this; the harness only forwards the
 * `prompt` to the model and echoes `tokenBudget` for accounting.
 *
 * Assembled by the injected {@link DreamingPayloadStrategy}, so the harness is blind
 * to HOW it was built (identity files + summaries + graph snapshot for incremental;
 * full sampled graph for compaction). Kept minimal at the seam: the strategy owns
 * the structure; the harness owns the call.
 */
export interface DreamingPayload {
	/** The fully-assembled prompt to send to the dreaming model. */
	readonly prompt: string;
	/** The input token budget this payload was capped to (echoed for accounting). */
	readonly tokenBudget: number;
}

/**
 * The PAYLOAD-STRATEGY seam (009b incremental ‖ 009c compaction). A strategy loads
 * the pass's input for a scope + mode and returns the {@link DreamingPayload} the
 * harness sends to the model. This is the ONE interface Wave 2 implements; the
 * harness calls `loadPayload` and is otherwise decoupled from payload assembly.
 *
 * The strategy receives the storage handle + scope so it can read summaries + the
 * graph (009b/009c), and the job payload so it knows the mode + the `agentId` + the
 * `tokensAtEnqueue` snapshot. It returns `null` when there is nothing to dream over
 * (e.g. an incremental pass with no new summaries) so the harness records an empty
 * pass rather than calling the model for nothing.
 */
export interface DreamingPayloadStrategy {
	/** The mode this strategy serves (incremental | compaction). */
	readonly mode: DreamingPassMode;
	/**
	 * Assemble the pass payload for `scope`/`job`, or `null` when there is nothing to
	 * dream over. Wave 2 owns the body; the harness owns the call.
	 */
	loadPayload(
		storage: StorageQuery,
		scope: QueryScope,
		job: DreamingJobPayload,
	): Promise<DreamingPayload | null>;
}

/**
 * The state-update seam invoked on a successful pass (b-AC-5). The daemon injects an
 * adapter that calls the trigger's append-only path to stamp `last_pass_at` and
 * CLEAR `pending_job_id`. Kept as a seam so the runner does not re-implement the
 * append-only counter write (which the trigger owns) and a test can assert the
 * update fired exactly once with the right timestamp.
 */
export interface DreamingStateUpdater {
	/**
	 * Record a completed pass for `agentId`: set `last_pass_at = passAt` and clear
	 * `pending_job_id`. Append-only version-bump (the trigger's path), never in-place.
	 */
	recordPassComplete(agentId: string, passAt: string): Promise<void>;
}

/** A minimal structured-log sink the runner reports lifecycle events to. */
export interface DreamingRunnerLogger {
	/** Record a structured event (e.g. `dreaming.pass.empty`, `dreaming.mutation.applied`). */
	event(name: string, fields?: Record<string, unknown>): void;
}

/** The injected clock, so tests stamp `last_pass_at` deterministically. */
export interface DreamingRunnerClock {
	/** Current wall-clock time in ms (defaults to `Date.now`). */
	readonly now: () => number;
}

/** Construction deps for the runner harness. */
export interface DreamingRunnerDeps {
	/** Run control-plane submits through this storage client. */
	readonly storage: StorageQuery;
	/** The resolved org/workspace partition the pass runs under. */
	readonly scope: QueryScope;
	/** The payload strategy (009b incremental ‖ 009c compaction) — the injected seam. */
	readonly strategy: DreamingPayloadStrategy;
	/** The LLM seam; the runner calls the `memory_dreaming` workload (D-5 / b-AC-6). */
	readonly model: ModelClient;
	/** The state-updater invoked on success (b-AC-5). */
	readonly stateUpdater: DreamingStateUpdater;
	/** Optional structured-log sink. */
	readonly logger?: DreamingRunnerLogger;
	/** Optional injected clock (real `Date.now` otherwise). */
	readonly clock?: DreamingRunnerClock;
}

/** The dreaming workload token the runner passes to the model (D-5 / b-AC-6). */
const DREAMING_WORKLOAD = "memory_dreaming" as const;

/**
 * The dreaming session runner (HARNESS). Construct via {@link createDreamingRunner}.
 * `runPass` is the full lifecycle; Wave 2 supplies the payload strategy, not the
 * lifecycle.
 */
export class DreamingRunner {
	private readonly storage: StorageQuery;
	private readonly scope: QueryScope;
	private readonly strategy: DreamingPayloadStrategy;
	private readonly model: ModelClient;
	private readonly stateUpdater: DreamingStateUpdater;
	private readonly logger?: DreamingRunnerLogger;
	private readonly clock: DreamingRunnerClock;

	constructor(deps: DreamingRunnerDeps) {
		this.storage = deps.storage;
		this.scope = deps.scope;
		this.strategy = deps.strategy;
		this.model = deps.model;
		this.stateUpdater = deps.stateUpdater;
		this.logger = deps.logger;
		this.clock = deps.clock ?? { now: () => Date.now() };
	}

	private nowIso(): string {
		return new Date(this.clock.now()).toISOString();
	}

	/**
	 * Run ONE dreaming pass for a queued job (b-AC-1 / b-AC-2 / b-AC-5 / b-AC-6).
	 *
	 *   1. Load the payload via the injected strategy. `null` → empty pass: stamp
	 *      `last_pass_at`, clear the pending id, return an empty result (never call
	 *      the model for nothing).
	 *   2. Call the `memory_dreaming` workload (the STRONGER target, D-5 / b-AC-6) with
	 *      the assembled prompt.
	 *   3. Parse the returned mutation set defensively. A malformed / truncated body
	 *      yields `null` → empty mutation set; the pass still completes (never fail the
	 *      job on a model hiccup).
	 *   4. Apply each mutation through the control plane (D-6 / b-AC-2). Destructive
	 *      ops route to pending review; bounded additive ops may apply directly.
	 *   5. Stamp `last_pass_at` + clear `pending_job_id` (b-AC-5).
	 *
	 * `actor` carries the agent id every proposal row is scoped to (D-2); it defaults
	 * to the job's `agentId`.
	 */
	async runPass(job: DreamingJobPayload): Promise<DreamingPassResult> {
		const actor: ControlPlaneActor = { agentId: job.agentId };

		const payload = await this.strategy.loadPayload(this.storage, this.scope, job);
		if (payload === null) {
			// Nothing to dream over — complete cleanly so the pending guard releases.
			this.logger?.event("dreaming.pass.empty", { mode: job.mode, agentId: job.agentId });
			return this.finalize(job, [], "");
		}

		const raw = await this.model.complete(DREAMING_WORKLOAD, payload.prompt);
		const mutationSet = this.parseModelOutput(raw, payload.tokenBudget);

		const outcomes = await this.applyMutations(mutationSet, actor);
		this.logger?.event("dreaming.pass.applied", {
			mode: job.mode,
			agentId: job.agentId,
			mutations: outcomes.length,
		});
		return this.finalize(job, outcomes, mutationSet.summary);
	}

	/**
	 * Defensively parse the raw model string into a mutation set (b-AC-6 boundary).
	 * The model returns raw text (the seam is raw-in/raw-out); the runner strips a CoT
	 * block + a code fence, JSON-parses, and validates via {@link parseDreamingMutationSet}.
	 * Any failure yields an EMPTY set carrying the budget — the pass completes rather
	 * than failing the job (drop-invalid-keep-partial, never throw past this boundary).
	 */
	private parseModelOutput(raw: string, tokenBudget: number): DreamingMutationSet {
		const empty: DreamingMutationSet = { mutations: [], summary: "", tokenBudget };
		const json = extractJsonObject(raw);
		if (json === null) return empty;
		let candidate: unknown;
		try {
			candidate = JSON.parse(json);
		} catch {
			// A non-JSON / truncated body is not a job failure — record an empty pass.
			this.logger?.event("dreaming.parse.invalid", { length: raw.length });
			return empty;
		}
		const parsed = parseDreamingMutationSet(candidate);
		if (parsed === null) {
			this.logger?.event("dreaming.parse.rejected", {});
			return empty;
		}
		// Carry the real budget through even if the model omitted/garbled it.
		return { ...parsed, tokenBudget: parsed.tokenBudget > 0 ? parsed.tokenBudget : tokenBudget };
	}

	/**
	 * Apply each mutation through the 008c control plane (D-6 / b-AC-2). Maps the
	 * human-facing mutation kind onto the control-plane operation, threads the
	 * rationale + provenance (source `dreaming`), and submits. The control plane's risk
	 * router decides the route; destructive ops (merge/archive) map to operations
	 * outside the direct-apply allow-list, so they ALWAYS land in pending review. One
	 * mutation's failure never aborts the rest — each outcome is recorded independently.
	 */
	private async applyMutations(
		set: DreamingMutationSet,
		actor: ControlPlaneActor,
	): Promise<DreamingMutationOutcome[]> {
		const outcomes: DreamingMutationOutcome[] = [];
		for (const mutation of set.mutations) {
			const outcome = await this.applyOne(mutation, actor);
			outcomes.push(outcome);
		}
		return outcomes;
	}

	/** Map ONE mutation onto a control-plane proposal and submit it (D-6). */
	private async applyOne(mutation: DreamingMutation, actor: ControlPlaneActor): Promise<DreamingMutationOutcome> {
		const operation = MUTATION_KIND_TO_OPERATION[mutation.kind];
		const proposal = {
			operation,
			payload: mutation.payload,
			confidence: mutation.confidence,
			rationale: mutation.rationale,
			riskNote: mutation.riskNote,
			provenance: { source: "dreaming", evidence: mutation.rationale },
		};
		const result = await submitProposal(this.storage, this.scope, proposal, actor);
		this.logger?.event("dreaming.mutation.submitted", {
			kind: mutation.kind,
			operation,
			route: result.route,
			status: result.status,
		});
		return {
			kind: mutation.kind,
			route: result.route,
			status: result.status,
			proposalId: result.proposalId,
		};
	}

	/**
	 * Finalize the pass (b-AC-5): stamp `last_pass_at` (now) + clear `pending_job_id`
	 * via the injected state-updater, and build the {@link DreamingPassResult}. The
	 * state update is append-only (the trigger's path) — the updater owns that
	 * mechanic.
	 */
	private async finalize(
		job: DreamingJobPayload,
		outcomes: readonly DreamingMutationOutcome[],
		summary: string,
	): Promise<DreamingPassResult> {
		const lastPassAt = this.nowIso();
		await this.stateUpdater.recordPassComplete(job.agentId, lastPassAt);
		return { mode: job.mode, outcomes, summary, lastPassAt };
	}
}

/**
 * Extract the first balanced top-level JSON object from a raw model string, tolerating
 * a leading `<think>…</think>` CoT block and ```json fences (the same adversarial
 * shapes the extraction stage's defensive parser survives). Returns the object text,
 * or `null` when none is found. Pure.
 */
function extractJsonObject(raw: string): string | null {
	if (typeof raw !== "string" || raw.length === 0) return null;
	// Strip a CoT block if present.
	const withoutCot = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
	const start = withoutCot.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < withoutCot.length; i++) {
		const ch = withoutCot[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return withoutCot.slice(start, i + 1);
		}
	}
	return null;
}

/** Build a {@link DreamingRunner}. The daemon injects the real deps; tests inject fakes. */
export function createDreamingRunner(deps: DreamingRunnerDeps): DreamingRunner {
	return new DreamingRunner(deps);
}

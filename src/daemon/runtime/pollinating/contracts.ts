/**
 * Pollinating-loop contracts — PRD-009 Wave 1 (the typed shapes 009a/009b/009c share).
 *
 * The cross-module data contracts for the pollinating loop: the queued pollinating-job
 * payload (what 009a enqueues into `memory_jobs` and 009b/009c consume), the
 * mutation set the pollinating model returns (the human-facing op vocabulary, mapped
 * onto the 008c `ProposalOperation` set the control plane applies), the human
 * summary the pass produces, and the per-pass token budget.
 *
 * These are the single load-bearing Wave-1 artifact the two Wave-2 Bees code
 * against with zero shared-file contention, so they must be right and stable. A
 * genuinely new cross-module field is a Wave-1 change (raise it), not a Wave-2
 * stub edit.
 *
 * ── Boundary vs interior (where zod lives) ──────────────────────────────────
 * zod validates at the UNTRUSTED boundaries: the pollinating-job payload parsed back
 * off the `memory_jobs` queue, and the mutation set returned by the model (raw
 * text → parsed JSON → validated set). The runner builds the {@link PollinatingPassResult}
 * from already-validated data, so that is a plain interface. Same rule as
 * `pipeline/contracts.ts` and `ontology/contracts.ts`: the schema DEFINES valid;
 * leniency lives in HOW a caller applies it (drop-invalid, never throw past the
 * boundary).
 *
 * ── The mutation vocabulary is HUMAN-facing; the control plane is the AUTHORITY ─
 * The model emits the seven-op set below ({@link POLLINATING_MUTATION_KINDS}); the
 * runner maps each onto a 008c `ProposalOperation` and submits it via
 * `submitProposal` (D-6). The control plane's risk router decides direct-apply vs
 * pending review — destructive ops (`merge_entities`, `delete_entity`,
 * `delete_attribute`, `supersede_attribute`) map to operations OUTSIDE the
 * 008c `DIRECT_APPLY_OPERATIONS` allow-list, so they ALWAYS land in pending review
 * (b-AC-2 / index AC-2). This module owns the vocabulary + the mapping table; the
 * runner owns the submit loop.
 *
 * Every value these contracts carry is eventually interpolated into SQL by the
 * 008c writer through the guarded helpers — the contracts hold the data, the
 * writer escapes it.
 */

import { z } from "zod";

import type { ProposalOperation } from "../ontology/contracts.js";

// ────────────────────────────────────────────────────────────────────────────
// Pass mode (D-4) — incremental vs compaction.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The two pollinating pass modes (D-4):
 *   - `incremental` — loads only post-`last_pass_at` summaries + changed entities
 *     (009b, the steady-state pass).
 *   - `compaction` — walks the full graph in one deliberate pass, sampling recent
 *     summaries to the token budget (009c; first-run backfill + on-demand
 *     `--compact`).
 * Frozen so the array is the single source the zod enum reads.
 */
export const POLLINATING_PASS_MODES = Object.freeze(["incremental", "compaction"] as const);
/** A pollinating pass mode. */
export type PollinatingPassMode = (typeof POLLINATING_PASS_MODES)[number];

// ────────────────────────────────────────────────────────────────────────────
// Pollinating-job payload (FR-4 / 009b/009c) — the queued job body. Boundary: zod.
// ────────────────────────────────────────────────────────────────────────────

/** The job kind 009a enqueues into `memory_jobs` (routes to the pollinating runner). */
export const POLLINATING_JOB_KIND = "pollinating" as const;

/**
 * The payload of a queued pollinating job (FR-4). 009a builds it at enqueue; 009b/009c
 * parse it back off the queue via {@link parsePollinatingJobPayload}. Carries the pass
 * `mode` (D-4), the agent scope the pass runs as (D-1), and the `enqueuedAt`
 * timestamp + the `tokensAtEnqueue` snapshot for diagnostics.
 *
 * Scope (D-1 / D-2): `agentId` is on the payload because the queued job is
 * de-coupled from the request that enqueued it; the org/workspace half rides the
 * `QueryScope` the daemon runs the job under, exactly like every engine table.
 */
export const PollinatingJobPayloadSchema = z.object({
	/** Incremental (post-last-pass delta) or compaction (full graph). */
	mode: z.enum(POLLINATING_PASS_MODES).default("incremental"),
	/** The agent scope this pass runs as (D-1). */
	agentId: z.string().default("default"),
	/** ISO-8601 enqueue timestamp (diagnostics). */
	enqueuedAt: z.string().default(""),
	/** The counter value at enqueue (diagnostics; the trigger snapshots it). */
	tokensAtEnqueue: z.number().default(0),
});

/** A validated pollinating-job payload (the queue boundary). */
export type PollinatingJobPayload = z.infer<typeof PollinatingJobPayloadSchema>;

/**
 * Validate a candidate pollinating-job payload at the queue boundary, returning the
 * typed {@link PollinatingJobPayload} or `null` on an invalid body. Drop-invalid
 * (never throw) so a malformed queue row is rejected without crashing the runner.
 * Tolerates extra keys.
 */
export function parsePollinatingJobPayload(candidate: unknown): PollinatingJobPayload | null {
	const parsed = PollinatingJobPayloadSchema.safeParse(candidate);
	return parsed.success ? parsed.data : null;
}

// ────────────────────────────────────────────────────────────────────────────
// Mutation set (009b FR-6) — the model's human-facing op vocabulary. Boundary: zod.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The seven pollinating-mutation kinds the model emits (009b FR-6). This is the
 * HUMAN-readable corrective vocabulary; the runner maps each onto a 008c
 * `ProposalOperation` ({@link MUTATION_KIND_TO_OPERATION}) and submits it through
 * the control plane, which is the authority on direct-apply vs pending review.
 *
 *   - `create_entity`       — a new entity the graph was missing.
 *   - `merge_entities`      — fold duplicate entities into one (DESTRUCTIVE).
 *   - `delete_entity`       — archive a junk entity (DESTRUCTIVE).
 *   - `update_aspect`       — adjust an aspect (e.g. rename/reweight).
 *   - `supersede_attribute` — replace a claim with a newer version (DESTRUCTIVE:
 *                             advances the prior, append-only).
 *   - `create_attribute`    — add a new claim.
 *   - `delete_attribute`    — archive a junk claim (DESTRUCTIVE).
 *
 * Frozen so the array is the single source the zod enum + the mapping table read.
 */
export const POLLINATING_MUTATION_KINDS = Object.freeze([
	"create_entity",
	"merge_entities",
	"delete_entity",
	"update_aspect",
	"supersede_attribute",
	"create_attribute",
	"delete_attribute",
] as const);
/** A pollinating-mutation kind (the model-facing op vocabulary). */
export type PollinatingMutationKind = (typeof POLLINATING_MUTATION_KINDS)[number];

/**
 * Map a pollinating-mutation kind onto the 008c control-plane operation the runner
 * submits (D-6). The destructive kinds map to operations OUTSIDE the 008c
 * `DIRECT_APPLY_OPERATIONS` allow-list, so the control plane's risk router ALWAYS
 * routes them to pending review (b-AC-2): `merge_entities → entity.merge`,
 * `delete_entity → entity.archive`, `delete_attribute → claim.archive`. The
 * additive kinds map to bounded direct-apply operations. The single mapping point
 * so the vocabulary translation lives in one place.
 */
export const MUTATION_KIND_TO_OPERATION: Readonly<Record<PollinatingMutationKind, ProposalOperation>> = Object.freeze({
	create_entity: "entity.create",
	merge_entities: "entity.merge",
	delete_entity: "entity.archive",
	update_aspect: "aspect.rename",
	supersede_attribute: "claim.supersede",
	create_attribute: "claim.add",
	delete_attribute: "claim.archive",
});

/**
 * One mutation the pollinating model emits (009b FR-6). Carries the `kind` (the
 * human-facing op), the genuinely-schemaless `payload` (the change body the runner
 * threads into the 008c proposal payload), a `rationale`, a `confidence`, and an
 * optional `riskNote` (a non-empty note pushes even an additive op to review, D-6).
 *
 * BOUNDARY type: a mutation arrives from the MODEL (untrusted), so it is validated
 * via {@link PollinatingMutationSchema} before the runner submits it.
 */
export const PollinatingMutationSchema = z.object({
	/** The human-facing mutation kind (mapped to a control-plane operation). */
	kind: z.enum(POLLINATING_MUTATION_KINDS),
	/** The genuinely-schemaless change body (threaded into the 008c proposal payload). */
	payload: z.record(z.string(), z.unknown()).default({}),
	/** Why the model proposes this change (becomes the proposal rationale). */
	rationale: z.string().default(""),
	/** Confidence in the change, 0..1 (gates direct-apply via the 008c floor). */
	confidence: z.number().min(0).max(1).default(1),
	/** A risk note; non-empty pushes the change toward review (D-6). */
	riskNote: z.string().default(""),
});
/** A validated pollinating mutation (the model boundary). */
export type PollinatingMutation = z.infer<typeof PollinatingMutationSchema>;

/**
 * The full mutation set the pollinating model returns (009b FR-6): the ordered
 * `mutations`, a human `summary` of the pass's reasoning, and the `tokenBudget`
 * the pass was given (echoed for accounting). A BOUNDARY type validated via
 * {@link PollinatingMutationSetSchema}.
 */
export const PollinatingMutationSetSchema = z.object({
	/** The ordered mutations to apply through the control plane. */
	mutations: z.array(PollinatingMutationSchema).default([]),
	/** A human-readable summary of the pass's consolidation reasoning. */
	summary: z.string().default(""),
	/** The input token budget the pass was given (echoed for accounting). */
	tokenBudget: z.number().int().nonnegative().default(0),
});
/** A validated pollinating mutation set (the model boundary). */
export type PollinatingMutationSet = z.infer<typeof PollinatingMutationSetSchema>;

/**
 * Validate a candidate mutation set at the model boundary, returning the typed
 * {@link PollinatingMutationSet} or `null` on an invalid body. Drop-invalid (never
 * throw) so a malformed / truncated model response is rejected without failing the
 * job — the runner records an empty pass rather than crashing. Tolerates extra keys.
 */
export function parsePollinatingMutationSet(candidate: unknown): PollinatingMutationSet | null {
	const parsed = PollinatingMutationSetSchema.safeParse(candidate);
	return parsed.success ? parsed.data : null;
}

// ────────────────────────────────────────────────────────────────────────────
// Pass result (009b) — what the runner produces. Interior interface (no zod).
// ────────────────────────────────────────────────────────────────────────────

/** The outcome of applying ONE mutation through the control plane (009b). */
export interface PollinatingMutationOutcome {
	/** The mutation that was submitted. */
	readonly kind: PollinatingMutationKind;
	/** The control-plane route it took (`direct` applied / `pending` review). */
	readonly route: "direct" | "pending";
	/** The resulting proposal status (`applied` | `pending` | `failed`). */
	readonly status: "applied" | "pending" | "rejected" | "failed";
	/** The recorded proposal row id (empty when the proposal was malformed). */
	readonly proposalId: string;
}

/**
 * The result of a completed pollinating pass (009b). The runner builds this from
 * already-validated data — applied mutation outcomes, the human summary, the
 * `last_pass_at` it stamped, and the job id it cleared from the counter. A plain
 * interface (interior), not a zod boundary.
 */
export interface PollinatingPassResult {
	/** The pass mode that ran. */
	readonly mode: PollinatingPassMode;
	/** The per-mutation control-plane outcomes, in submit order. */
	readonly outcomes: readonly PollinatingMutationOutcome[];
	/** The human summary the pass produced. */
	readonly summary: string;
	/** The ISO-8601 `last_pass_at` the runner stamped on success (b-AC-5). */
	readonly lastPassAt: string;
}

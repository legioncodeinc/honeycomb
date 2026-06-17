/**
 * Cross-stage pipeline contracts — PRD-006 Wave 1 (the zod types EVERY stage codes against).
 *
 * These three zod schemas + their inferred types are the data contract that flows
 * BETWEEN the pipeline stages. They are the single most load-bearing artifact of
 * Wave 1: the four Wave-2 Bees (006b decision, 006c writes, 006d graph, 006e
 * retention) each code against THESE shapes with zero shared-file contention, so
 * they must be right and stable.
 *
 *   - {@link FactSchema}        extraction output → decision input (006a → 006b).
 *   - {@link EntityTripleSchema} extraction output → graph input (006a → 006d).
 *   - {@link ProposalSchema}    decision output → controlled-writes input
 *                               (006b → 006c) and the `memory_history` row shape.
 *
 * ── Why validate-and-drop, not validate-or-throw (a-AC-4 / FR-8) ─────────────
 * The model is the untrusted boundary here, and a single malformed fact must
 * NEVER kill the extraction of the rest (the binding rule: "a slow or sloppy
 * model never costs a captured memory its enrichment outright"). So these schemas
 * are paired with `safeParse`-based helpers ({@link parseFact} / {@link parseEntityTriple})
 * that return `null` on an invalid item — the stage drops the invalid one with a
 * warning and keeps the valid ones, rather than `.parse()`-throwing the whole job.
 * The schemas themselves are strict (they DEFINE valid); the leniency lives in HOW
 * a stage applies them, not in loosening the shape.
 *
 * ── D-4 JSON contract (binding) ─────────────────────────────────────────────
 * The model is prompted to emit:
 *   { facts: [{ content, type, confidence }], entities: [{ source, relationship, target }] }
 * and the decision stage emits:
 *   { action, target_id?, confidence, reason }
 * These schemas are the typed form of that contract.
 */

import { z } from "zod";

/**
 * A confidence score in `[0, 1]` (a-AC-1 / D-4). `.catch` is NOT used here — an
 * out-of-range or non-numeric confidence makes the WHOLE fact invalid, because a
 * fact whose confidence we can't trust can't be gated by `minFactConfidenceForWrite`
 * (006c c-AC-1). The drop-invalid policy handles it at the item level.
 */
export const ConfidenceSchema = z.number().min(0).max(1);

/**
 * A `Fact` — one discrete claim extracted from a raw memory (a-AC-1 / FR-4 / D-4).
 *
 * - `content`    the claim text (non-empty; the stage additionally length-caps it
 *                to `extraction.maxFactChars` AFTER validation — a-AC-3 / FR-7).
 * - `type`       a coarse fact category (free-form string the model assigns, e.g.
 *                `fact` / `preference` / `decision`). Non-empty.
 * - `confidence` 0..1 (a-AC-1). The 006c ADD gate compares this to the threshold.
 */
export const FactSchema = z.object({
	/** The claim text. Non-empty; length-capped by the stage post-validation. */
	content: z.string().min(1),
	/** Coarse fact category the model assigned. */
	type: z.string().min(1),
	/** Model confidence in this fact, 0..1 (a-AC-1). */
	confidence: ConfidenceSchema,
});

/** A validated extracted fact (006a → 006b). */
export type Fact = z.infer<typeof FactSchema>;

/**
 * An `EntityTriple` — a (source, relationship, target) edge the graph layer
 * persists (a-AC-1 / FR-4 / D-4). All three are non-empty strings; the canonical
 * naming + idempotent upsert are 006d's job, not this contract's.
 */
export const EntityTripleSchema = z.object({
	/** The subject entity (canonicalized by 006d). */
	source: z.string().min(1),
	/** The relationship/edge type. */
	relationship: z.string().min(1),
	/** The object entity (canonicalized by 006d). */
	target: z.string().min(1),
});

/** A validated entity triple (006a → 006d). */
export type EntityTriple = z.infer<typeof EntityTripleSchema>;

/**
 * The structured output of one extraction job: the bounded facts + triples the
 * decision stage (006b) and graph stage (006d) consume. Extraction does NOT write
 * memories — this is the material it hands downstream (006a Scope).
 */
export interface ExtractionResult {
	/** The kept facts (≤ `extraction.maxFacts`, each ≤ `maxFactChars`). */
	readonly facts: Fact[];
	/** The kept entity triples (≤ `extraction.maxEntities`). */
	readonly entities: EntityTriple[];
	/**
	 * The count of items dropped as invalid during parse/validation (a-AC-4 / FR-8).
	 * Surfaced so the stage logs a warning with the number and the job still
	 * completes with the partial result.
	 */
	readonly droppedCount: number;
}

/** The four proposal actions the decision stage emits (D-4 / 006b b-AC-1). */
export const PROPOSAL_ACTIONS = Object.freeze(["add", "update", "delete", "none"] as const);

/** A proposal action. */
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number];

/**
 * A `Proposal` — the decision stage's per-fact verdict (D-4 / 006b b-AC-1) and the
 * payload `memory_history` records (006b b-AC-3). Consumed by controlled-writes
 * (006c).
 *
 * - `action`     add | update | delete | none.
 * - `targetId`   the existing `memories.id` an update/delete targets; absent for
 *                an `add` against a brand-new fact (D-4's optional `target_id`).
 * - `confidence` the decision's own confidence, 0..1.
 * - `reason`     a short human-readable rationale recorded to history.
 *
 * The wire/JSON field is `target_id` (D-4); the TS field is `targetId`. The schema
 * accepts the snake_case wire key and the helper {@link parseProposal} maps it, so
 * a stage reads the camelCase TS shape while the model emits the D-4 contract.
 */
export const ProposalSchema = z.object({
	/** The proposed operation. */
	action: z.enum(PROPOSAL_ACTIONS),
	/** The target memory id for update/delete; absent for a fresh add. */
	targetId: z.string().min(1).optional(),
	/** The decision's confidence, 0..1. */
	confidence: ConfidenceSchema,
	/** Short rationale recorded to `memory_history`. */
	reason: z.string().default(""),
});

/** A validated decision proposal (006b → 006c, and the history row payload). */
export type Proposal = z.infer<typeof ProposalSchema>;

/**
 * Validate one candidate fact, returning the typed {@link Fact} or `null` when it
 * is invalid (a-AC-4 / FR-8). The stage calls this per item and DROPS the nulls
 * with a warning — never throws. Tolerates extra keys (the model may emit more
 * than the contract); only the contract fields are kept.
 */
export function parseFact(candidate: unknown): Fact | null {
	const parsed = FactSchema.safeParse(candidate);
	return parsed.success ? parsed.data : null;
}

/**
 * Validate one candidate triple, returning the typed {@link EntityTriple} or `null`
 * when invalid (a-AC-4 / FR-8). Drop-invalid, never throw.
 */
export function parseEntityTriple(candidate: unknown): EntityTriple | null {
	const parsed = EntityTripleSchema.safeParse(candidate);
	return parsed.success ? parsed.data : null;
}

/**
 * Validate a decision proposal, mapping the D-4 wire key `target_id` onto the TS
 * `targetId`. Returns the typed {@link Proposal} or `null` on an invalid body.
 * Used by 006b when it parses a model decision response, and reusable wherever a
 * proposal crosses a boundary.
 */
export function parseProposal(candidate: unknown): Proposal | null {
	const normalized = normalizeProposalKeys(candidate);
	const parsed = ProposalSchema.safeParse(normalized);
	return parsed.success ? parsed.data : null;
}

/** Map the D-4 `target_id` wire key onto the TS `targetId` field, non-destructively. */
function normalizeProposalKeys(candidate: unknown): unknown {
	if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
		return candidate;
	}
	const obj = candidate as Record<string, unknown>;
	if (!("target_id" in obj) || "targetId" in obj) return obj;
	const { target_id, ...rest } = obj;
	return { ...rest, targetId: target_id };
}

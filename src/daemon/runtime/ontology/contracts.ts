/**
 * Ontology contracts — PRD-008 Wave 1 (the typed shapes 008a/008b/008c all code against).
 *
 * These are the cross-module data contracts for the knowledge-graph ontology: the
 * entity reference, the weighted aspect, the addressable claim slot, the claim
 * attribute, the control-plane proposal, and the epistemic assertion. They are the
 * single most load-bearing Wave-1 artifact — the two Wave-2 Bees (008b dependencies
 * + supersession, 008c control plane) each code against THESE shapes with zero
 * shared-file contention, so they must be right and stable.
 *
 * ── Boundary vs interior (where zod lives) ──────────────────────────────────
 * zod validates at the UNTRUSTED boundary — a control-plane proposal payload or an
 * epistemic assertion arriving from the CLI / model, where a malformed field must
 * be rejected, not trusted. The interior shapes the entity-model WRITER builds
 * from already-validated pipeline data ({@link EntityRef}, {@link Aspect},
 * {@link AttributeSlot}) are plain TS interfaces: the writer constructs them, so a
 * runtime re-validation would be ceremony. The rule mirrors `pipeline/contracts.ts`:
 * the schema DEFINES valid; the leniency (or strictness) lives in HOW a caller
 * applies it.
 *
 * ── Provenance is mandatory (a-AC-3 / 008a FR-4) ────────────────────────────
 * The graph is a derived, rebuildable index OVER memories — never authoritative on
 * its own. So an {@link Attribute} with no traceable `memoryId` is not a valid graph
 * row. {@link AttributeProvenance} carries the memory id, the source, and the
 * (optional) proposal id that produced the claim, so every value traces back to its
 * evidence.
 *
 * Every value these contracts carry is eventually interpolated into SQL by the
 * WRITER through the `sqlStr`/`sqlLike`/`sqlIdent`/`sLiteral`/`eLiteral` helpers
 * (008a FR-8 / a-AC-7) — the contracts hold the data, the writer escapes it.
 */

import { z } from "zod";

// ────────────────────────────────────────────────────────────────────────────
// Entity types (D-1) — the fixed FR-1 set.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The fixed entity-type set (D-1 / 008a FR-1). An entity's `type` MUST be drawn
 * from this set; anything else is `"unknown"`. Frozen so the array is the single
 * source the zod enum and the type guard both read.
 */
export const ENTITY_TYPES = Object.freeze([
	"person",
	"project",
	"system",
	"tool",
	"concept",
	"skill",
	"task",
	"source",
	"artifact",
	"agent",
	"policy",
	"action",
	"workflow",
	"event",
	"object_type",
	"interface",
	"observation",
	"claim_slot",
	"claim_value",
	"unknown",
] as const);

/** An entity type drawn from the fixed D-1 set. */
export type EntityType = (typeof ENTITY_TYPES)[number];

/** zod enum over the fixed entity-type set (boundary validation for proposals). */
export const EntityTypeSchema = z.enum(ENTITY_TYPES);

/** True when `value` is one of the fixed D-1 entity types. Narrows to {@link EntityType}. */
export function isEntityType(value: string): value is EntityType {
	return (ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * Coerce a free-form type string to a valid {@link EntityType}, defaulting to
 * `"unknown"` (008a FR-1). The entity-model writer calls this so a triple whose
 * type the pipeline did not constrain still lands as a valid graph row rather than
 * an arbitrary string. Pure.
 */
export function coerceEntityType(value: string): EntityType {
	const lower = value.trim().toLowerCase();
	return isEntityType(lower) ? lower : "unknown";
}

// ────────────────────────────────────────────────────────────────────────────
// EntityRef — a canonical entity reference (008a FR-1).
// ────────────────────────────────────────────────────────────────────────────

/**
 * A reference to a graph entity by its canonical name + type (008a FR-1). The
 * canonical name is the trimmed/lowercased form (the dedup key — same shape the
 * 006d bulk writer uses), so the same entity is never duplicated. `displayName`
 * preserves the original casing for surfacing; `id` is the deterministic id
 * derived from agent + canonical name (see `entity-model.ts`).
 *
 * Scope (D-2) is NOT carried on the ref — it lives in the `QueryScope` partition
 * (org/workspace) + the `agentId` the writer threads, so the ref stays a pure
 * identity and a single ref can never smuggle a cross-agent write.
 */
export interface EntityRef {
	/** Deterministic id (sha256 of agent + canonical name); `ent_`-prefixed. */
	readonly id: string;
	/** Canonical name: trimmed + lowercased. The dedup key. */
	readonly canonicalName: string;
	/** Original casing for display; optional. */
	readonly displayName?: string;
	/** The entity type from the fixed D-1 set. */
	readonly type: EntityType;
}

// ────────────────────────────────────────────────────────────────────────────
// Aspect — a weighted dimension of an entity (008a FR-2).
// ────────────────────────────────────────────────────────────────────────────

/** The floor an aspect weight decays TOWARD when stale (D-3 / a-AC-4). */
export const ASPECT_WEIGHT_FLOOR = 0.1;

/** The ceiling an aspect weight rises TOWARD on confirmation. */
export const ASPECT_WEIGHT_CEILING = 1.0;

/**
 * A weighted dimension of an entity (008a FR-2 / a-AC-4) — e.g. `role`,
 * `expertise`. The `weight` rises when retrieval keeps confirming the aspect and
 * decays toward {@link ASPECT_WEIGHT_FLOOR} when it goes stale beyond a window
 * (D-3). Attributes attach to an aspect via its `id`.
 */
export interface Aspect {
	/** Deterministic id (sha256 of entity id + aspect name); `asp_`-prefixed. */
	readonly id: string;
	/** The entity this aspect is a dimension of. */
	readonly entityId: string;
	/** The aspect name (e.g. `role`). */
	readonly name: string;
	/** Current weight in [{@link ASPECT_WEIGHT_FLOOR}, {@link ASPECT_WEIGHT_CEILING}]. */
	readonly weight: number;
}

// ────────────────────────────────────────────────────────────────────────────
// AttributeSlot — the addressable group_key / claim_key slot (008a FR-3 / a-AC-5).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The addressable slot a claim value lives in under its aspect (008a FR-3 /
 * a-AC-5). `groupKey` is the navigable subdivision (clusters related claims);
 * `claimKey` identifies the specific updateable slot a single value occupies. A
 * supersession targets exactly the (entity, aspect, groupKey, claimKey) tuple, so
 * the slot is the addressing unit the version chain shares.
 */
export interface AttributeSlot {
	/** The navigable subdivision inside an aspect (clusters related claims). */
	readonly groupKey: string;
	/** The specific updateable slot a single value lives in (the claim identity). */
	readonly claimKey: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Attribute — a claim attribute (008a FR-4 / a-AC-3).
// ────────────────────────────────────────────────────────────────────────────

/** Claim attribute kinds (008a FR-4). A `constraint` is NOT auto-superseded (D-7 / b-AC-5). */
export const ATTRIBUTE_KINDS = Object.freeze(["attribute", "constraint"] as const);
/** A claim attribute kind. */
export type AttributeKind = (typeof ATTRIBUTE_KINDS)[number];

/** Claim lifecycle states (008a FR-4). Mirrors the catalog's `entity_attributes.status`. */
export const ATTRIBUTE_STATUSES = Object.freeze(["active", "superseded", "deleted"] as const);
/** A claim lifecycle state. */
export type AttributeStatus = (typeof ATTRIBUTE_STATUSES)[number];

/**
 * Provenance for a claim attribute (008a FR-4 / a-AC-3) — the trace back to the
 * evidence that produced it. `memoryId` is MANDATORY: an attribute with no
 * traceable memory is not a valid graph row, because the graph is an index over
 * evidence, not a source of truth. `source` records how it was produced (e.g.
 * `extraction`, `proposal`); `proposalId` links to the control-plane proposal
 * that applied it, when one did.
 */
export interface AttributeProvenance {
	/** The memory id this claim was derived from. MANDATORY (a-AC-3). */
	readonly memoryId: string;
	/** How the claim was produced (e.g. `extraction`, `linker`, `proposal`). */
	readonly source: string;
	/** The control-plane proposal that applied this claim, if any (008c c-AC-1). */
	readonly proposalId?: string;
}

/**
 * A claim attribute (008a FR-4 / a-AC-3) — one fact about an entity, living in an
 * addressable {@link AttributeSlot} under an aspect. Carries a `kind`
 * (attribute|constraint), a `status` (active|superseded|deleted), a `confidence`
 * and an `importance`, the `version` lineage counter, and mandatory `provenance`.
 *
 * Supersession (008b) appends a fresh `version` with `status: "active"` and marks
 * the prior sibling `superseded` — the version chain is keyed by the slot's
 * `claimKey`, so the highest-version active row in a slot is the current claim.
 */
export interface Attribute {
	/** Deterministic id for this version row; `attr_`-prefixed. */
	readonly id: string;
	/** The aspect this attribute hangs under. */
	readonly aspectId: string;
	/** The addressable slot (groupKey/claimKey) the claim occupies. */
	readonly slot: AttributeSlot;
	/** attribute | constraint (a constraint is not auto-superseded — D-7). */
	readonly kind: AttributeKind;
	/** active | superseded | deleted. */
	readonly status: AttributeStatus;
	/** The claim value text. */
	readonly content: string;
	/** Confidence in this claim, 0..1. */
	readonly confidence: number;
	/** Importance of this claim, 0..1. */
	readonly importance: number;
	/** The version lineage counter (1-based; the supersede path bumps it). */
	readonly version: number;
	/** Trace back to the memory + (optional) proposal that produced it. MANDATORY. */
	readonly provenance: AttributeProvenance;
}

// ────────────────────────────────────────────────────────────────────────────
// Proposal — the control-plane change record (008c FR-1 / c-AC-6). Boundary: zod.
// ────────────────────────────────────────────────────────────────────────────

/** The control-plane operation set (008c FR-2). */
export const PROPOSAL_OPERATIONS = Object.freeze([
	"entity.create",
	"entity.rename",
	"entity.merge",
	"entity.archive",
	"aspect.create",
	"aspect.rename",
	"aspect.archive",
	"claim.add",
	"claim.set",
	"claim.supersede",
	"claim.archive",
	"claim.restore_version",
	"link.create",
	"link.update",
	"link.archive",
	"extract",
	"consolidate",
] as const);
/** A control-plane operation. */
export type ProposalOperation = (typeof PROPOSAL_OPERATIONS)[number];

/** Proposal lifecycle states (008c FR-1). Status advances by a NEW append-only row. */
export const PROPOSAL_STATUSES = Object.freeze(["pending", "applied", "rejected", "failed"] as const);
/** A proposal lifecycle state. */
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/**
 * The provenance a proposal carries (008c FR-1 / c-AC-6) — the source the change
 * came from + the evidence supporting it. Copied onto the resulting rows at apply
 * time so lineage survives even if the proposal row is later archived (008c FR-3).
 */
export interface ProposalProvenance {
	/** Where the change originated (e.g. `cli`, `pollinating`, `extraction`). */
	readonly source: string;
	/** The evidence supporting the change (memory ids, transcript refs). */
	readonly evidence: string;
}

/**
 * A control-plane proposal (008c FR-1 / c-AC-6) — an audited record of a deliberate
 * structural change. Carries the `operation`, its `status`, a genuinely-schemaless
 * `payload` (the change body — JSONB in the catalog, the sanctioned JSONB use), a
 * `confidence`, a `rationale`, a `riskNote`, and `provenance`.
 *
 * This is a BOUNDARY type: a proposal arrives from the CLI / a generator, so it is
 * validated via {@link ProposalSchema} before it is recorded. The Wave-2 008c Bee
 * builds the record + the risk router on top of this shape.
 */
export const ProposalSchema = z.object({
	/** The operation being proposed. */
	operation: z.enum(PROPOSAL_OPERATIONS),
	/** Lifecycle status (defaults to `pending`). */
	status: z.enum(PROPOSAL_STATUSES).default("pending"),
	/** The genuinely-schemaless change body (JSONB in the catalog). */
	payload: z.record(z.string(), z.unknown()).default({}),
	/** Confidence in the change, 0..1. */
	confidence: z.number().min(0).max(1).default(1),
	/** Human-readable rationale for the change. */
	rationale: z.string().default(""),
	/** A risk note; non-empty pushes a change toward the review queue (D-6). */
	riskNote: z.string().default(""),
	/** Source + evidence provenance. */
	provenance: z
		.object({ source: z.string().default(""), evidence: z.string().default("") })
		.default({ source: "", evidence: "" }),
});

/** A validated control-plane proposal (008c boundary). */
export type Proposal = z.infer<typeof ProposalSchema>;

/**
 * Validate a candidate proposal at the boundary, returning the typed {@link Proposal}
 * or `null` on an invalid body. Drop-invalid (never throw) so a malformed CLI /
 * generated proposal is rejected without crashing the control plane — the 008c Bee
 * routes the null to a `failed`/rejected outcome. Tolerates extra keys.
 */
export function parseProposal(candidate: unknown): Proposal | null {
	const parsed = ProposalSchema.safeParse(candidate);
	return parsed.success ? parsed.data : null;
}

// ────────────────────────────────────────────────────────────────────────────
// Assertion — the epistemic attribution layer (008c FR-7 / c-AC-5). Boundary: zod.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Epistemic predicates (008c FR-7) — "who claimed/believed/observed/etc what". The
 * attribution stance an assertion records. Distinct from the catalog's
 * `epistemic_assertions.stance` enum by name only; the 008c writer maps the
 * predicate onto the stance column.
 */
export const ASSERTION_PREDICATES = Object.freeze([
	"claims",
	"believes",
	"observed",
	"decided",
	"prefers",
	"denies",
	"questions",
] as const);
/** An epistemic predicate. */
export type AssertionPredicate = (typeof ASSERTION_PREDICATES)[number];

/** Assertion lifecycle states (008c FR-7). */
export const ASSERTION_STATUSES = Object.freeze(["active", "retracted", "superseded"] as const);
/** An assertion lifecycle state. */
export type AssertionStatus = (typeof ASSERTION_STATUSES)[number];

/**
 * An epistemic assertion (008c FR-7 / c-AC-5) — a record of WHO said/believed WHAT,
 * kept as a SEPARATE evidence-and-attribution layer from the fact graph. It carries
 * a `predicate`, the `content`, the `speaker`, a `confidence`, the `evidence`, and a
 * `status`. It MAY link to a claim attribute (`claimKey`) but MUST NOT auto-promote
 * into ontology truth (008c FR-8): promoting an assertion to a claim goes through a
 * proposal, never silently.
 *
 * BOUNDARY type: validated via {@link AssertionSchema} before it is recorded.
 */
export const AssertionSchema = z.object({
	/** The attribution stance — claims | believes | observed | … */
	predicate: z.enum(ASSERTION_PREDICATES),
	/** What was asserted. */
	content: z.string().min(1),
	/** Who asserted it (the speaker). */
	speaker: z.string().min(1),
	/** Confidence in the assertion, 0..1. */
	confidence: z.number().min(0).max(1).default(1),
	/** Supporting evidence (memory ids, transcript refs). */
	evidence: z.string().default(""),
	/** Lifecycle status (defaults to `active`). */
	status: z.enum(ASSERTION_STATUSES).default("active"),
	/** Optional link to a claim attribute slot; stays a separate layer (no auto-promote). */
	claimKey: z.string().optional(),
});

/** A validated epistemic assertion (008c boundary). */
export type Assertion = z.infer<typeof AssertionSchema>;

/**
 * Validate a candidate assertion at the boundary, returning the typed
 * {@link Assertion} or `null` on an invalid body. Drop-invalid, never throw.
 */
export function parseAssertion(candidate: unknown): Assertion | null {
	const parsed = AssertionSchema.safeParse(candidate);
	return parsed.success ? parsed.data : null;
}

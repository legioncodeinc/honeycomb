/**
 * Ontology control plane — PRD-008c (Wave 2, `deeplake-dataset-worker-bee`).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * The third and most trust-controlled write path into the graph (CONVENTIONS §"The
 * three write paths"): every deliberate structural change is recorded as an audited
 * `ontology_proposals` row, then RISK-ROUTED (D-6). A bounded, explicit single-entity
 * /attr op applies DIRECTLY and writes an `applied` proposal row, copying the
 * proposal's evidence onto the resulting rows for lineage; a merge / archive /
 * destructive / broad / generated-batch change enters the PENDING review queue and is
 * NOT applied. The supersede apply path REUSES {@link supersedeClaim} (append-only,
 * never an in-place mutate). Raw source artifacts/transcripts are NEVER rewritten.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ACs proven (see `control-plane.test.ts`, one `describe` per AC):
 *   - c-AC-1 Bounded explicit op → applies DIRECTLY + writes an `applied`
 *            `ontology_proposals` row carrying the full evidence; the resulting
 *            attribute row carries the `memory_id` evidence POINTER. Together they make
 *            the lineage reconstructable and survive proposal archival (see the lineage
 *            note on {@link applyBoundedOperation}).
 *   - c-AC-2 Broad/risky/destructive/generated-batch → PENDING review queue, NOT
 *            applied (D-6 risk routing). Only the `pending` row is written.
 *   - c-AC-3 Structural change → raw source artifacts/transcripts (`sessions`/`source`
 *            /memory tables) are NEVER written. The apply path touches only graph
 *            engine tables.
 *   - c-AC-4 Supersede op → append-only version-bumped via {@link supersedeClaim},
 *            NOT in-place.
 *   - c-AC-5 Epistemic assertion carries predicate/content/speaker/confidence/
 *            evidence/status; NO auto-promote into truth (008c FR-8 — promotion goes
 *            through a proposal, never silently from {@link recordAssertion}).
 *   - c-AC-6 Proposal carries operation/status/jsonb payload/confidence/rationale/
 *            evidence/risk_note/provenance — written on the `ontology_proposals` row.
 *   - c-AC-7 CLI (`stream apply --dry-run`) scoped by org/workspace/agent; reports
 *            the plan WITHOUT mutating on dry-run ({@link planApply}). The CLI surface
 *            lives in `src/cli/ontology.ts` and calls into the plan builder here.
 *
 * ── Scope discipline (D-2 / a-AC-6) ─────────────────────────────────────────
 * `ontology_proposals` + `epistemic_assertions` are engine-scoped: they carry
 * `agent_id` + `visibility`, NOT explicit org/workspace columns. "Scoped by
 * org/workspace/agent" = the `QueryScope` partition (org + workspace) + the
 * `agent_id` value on every row this module writes.
 *
 * ── SQL safety (FR-9 / a-AC-7) ──────────────────────────────────────────────
 * Every value routes through the `val.*` constructors (→ `sLiteral`/`eLiteral`) or
 * the catalog SQL builders; every identifier through `sqlIdent`. JSONB `payload` is
 * serialized with `JSON.stringify` and written via `val.text` (the job-queue pattern
 * — `eLiteral`, escape-safe). No hand-quoted value; no raw fetch. `audit:sql` scans
 * `src/daemon`.
 */

import crypto from "node:crypto";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { EPISTEMIC_STANCES } from "../../storage/catalog/knowledge-graph.js";
import { healTargetFor } from "../../storage/catalog/index.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { appendOnlyInsert, appendVersionBumped, val } from "../../storage/writes.js";
import {
	type Assertion,
	type AssertionPredicate,
	parseAssertion,
	parseProposal,
	type Proposal,
	type ProposalOperation,
} from "./contracts.js";
import { writeAspect, writeAttribute, writeEntity } from "./entity-model.js";
import { slotClaimKey, supersedeClaim } from "./supersede.js";

// ── Table constants ─────────────────────────────────────────────────────────

const T_PROPOSALS = "ontology_proposals";
const T_ASSERTIONS = "epistemic_assertions";

/** ISO timestamp for `created_at`. */
function nowIso(): string {
	return new Date().toISOString();
}

// ════════════════════════════════════════════════════════════════════════════
// RISK ROUTING (D-6)
// ════════════════════════════════════════════════════════════════════════════

/** Where the risk router (D-6) sends a submitted proposal. */
export type ApplyRoute = "direct" | "pending";

/** The outcome of submitting a proposal to the control plane. */
export interface ApplyOutcome {
	/** Whether the change applied directly (c-AC-1) or entered the queue (c-AC-2). */
	readonly route: ApplyRoute;
	/** The recorded (most-recent) proposal row's id. */
	readonly proposalId: string;
	/** The resulting proposal status (`applied` | `pending` | `failed`). */
	readonly status: Proposal["status"];
}

/**
 * The bounded explicit operations that may apply DIRECTLY (D-6 / c-AC-1). Everything
 * NOT in this set (merge, archive, the broad/destructive/generated cases) routes to
 * the pending queue (c-AC-2). Frozen so the router's allow-list is the single source.
 */
export const DIRECT_APPLY_OPERATIONS: ReadonlySet<ProposalOperation> = new Set<ProposalOperation>([
	"entity.create",
	"aspect.create",
	"claim.add",
	"claim.set",
	"claim.supersede",
]);

/**
 * The confidence floor a direct-apply op must clear (D-6, tunable — parent open
 * question). A proposal below this lands in the review queue even for a bounded op:
 * low confidence is itself a reason to ask a human first.
 */
export const DIRECT_APPLY_CONFIDENCE_FLOOR = 0.5;

/**
 * Payload keys that signal a BROAD / generated BATCH change (c-AC-2 / D-6). A bounded
 * explicit op addresses a SINGLE entity/attr; a payload carrying a collection under
 * any of these keys is a batch and is routed to review regardless of its operation.
 */
const BATCH_PAYLOAD_KEYS = Object.freeze(["batch", "items", "entities", "claims", "operations"] as const);

/** The reason a proposal was routed the way it was — surfaced for the CLI plan + tests. */
export type RouteReason =
	| "bounded-explicit"
	| "operation-not-bounded"
	| "risk-note-present"
	| "confidence-below-floor"
	| "generated-batch";

/** A risk-routing decision (D-6): the route + the reason it was taken. */
export interface RouteDecision {
	readonly route: ApplyRoute;
	readonly reason: RouteReason;
}

/**
 * Decide whether a proposal applies DIRECTLY or enters the PENDING review queue
 * (D-6 / c-AC-1 / c-AC-2). Pure — the heart of the control plane.
 *
 * Direct-apply requires ALL of:
 *   1. the operation is a bounded explicit single-entity/attr op
 *      ({@link DIRECT_APPLY_OPERATIONS});
 *   2. NO risk note is present (a non-empty `riskNote` flags the change for review);
 *   3. confidence ≥ {@link DIRECT_APPLY_CONFIDENCE_FLOOR};
 *   4. the payload is NOT a generated batch ({@link isBatchPayload}).
 *
 * Any failure routes to `pending` (NOT applied). The reason is returned so the CLI
 * dry-run + the queue can explain WHY a change is waiting.
 */
export function routeProposal(proposal: Proposal): RouteDecision {
	if (!DIRECT_APPLY_OPERATIONS.has(proposal.operation)) {
		return { route: "pending", reason: "operation-not-bounded" };
	}
	if (proposal.riskNote.trim() !== "") {
		return { route: "pending", reason: "risk-note-present" };
	}
	if (proposal.confidence < DIRECT_APPLY_CONFIDENCE_FLOOR) {
		return { route: "pending", reason: "confidence-below-floor" };
	}
	if (isBatchPayload(proposal.payload)) {
		return { route: "pending", reason: "generated-batch" };
	}
	return { route: "direct", reason: "bounded-explicit" };
}

/** True when a payload carries a collection under a {@link BATCH_PAYLOAD_KEYS} key (c-AC-2). */
function isBatchPayload(payload: Record<string, unknown>): boolean {
	for (const key of BATCH_PAYLOAD_KEYS) {
		const v = payload[key];
		if (Array.isArray(v) && v.length > 1) return true;
	}
	return false;
}

// ════════════════════════════════════════════════════════════════════════════
// PROPOSAL RECORDING (c-AC-6) — append-only; status advances by a NEW row
// ════════════════════════════════════════════════════════════════════════════

/** The agent a control-plane call runs as; threads onto every row (D-2). */
export interface ControlPlaneActor {
	/** The agent id the proposal/assertion rows are scoped to (default `'default'`). */
	readonly agentId: string;
}

/**
 * Derive a stable id for an `ontology_proposals` row from the proposal body + status
 * + a salt. Append-only: the `pending` record and the later `applied` record are
 * DISTINCT rows with DISTINCT ids (status advances by a NEW row, never a mutate —
 * FR-1 / catalog header). `attempt` salts the id so the applied row never collides
 * with the pending one. Prefixed `prop_`. Pure.
 */
function proposalRowId(proposal: Proposal, status: Proposal["status"], salt: string): string {
	const material = `${proposal.operation}:${status}:${proposal.provenance.source}:${proposal.rationale}:${salt}`;
	const hash = crypto.createHash("sha256").update(material).digest("hex").slice(0, 24);
	return `prop_${hash}`;
}

/**
 * Append one `ontology_proposals` row carrying the FULL audit record (c-AC-6 / FR-1):
 * operation, status, the JSONB `payload`, confidence, rationale, evidence, risk_note,
 * and the source provenance + agent scope. Append-only (the catalog pattern) — a
 * status transition is a NEW row, not an UPDATE. Returns the written row id.
 *
 * The JSONB `payload` is serialized via `JSON.stringify` and written with `val.text`
 * (→ `eLiteral`, escape-safe) — the same guarded path the job queue uses for its
 * JSONB column. `evidence` is the proposal's `provenance.evidence`; `source` is its
 * `provenance.source`.
 */
async function recordProposalRow(
	storage: StorageQuery,
	scope: QueryScope,
	actor: ControlPlaneActor,
	proposal: Proposal,
	status: Proposal["status"],
	salt: string,
): Promise<string> {
	const id = proposalRowId(proposal, status, salt);
	const target = healTargetFor(T_PROPOSALS);
	const now = nowIso();

	await appendOnlyInsert(storage, target, scope, [
		["id", val.str(id)],
		["operation", val.str(proposal.operation)],
		["status", val.str(status)],
		["payload", val.text(JSON.stringify(proposal.payload ?? {}))],
		["confidence", val.num(clamp01(proposal.confidence))],
		["rationale", val.text(proposal.rationale)],
		["evidence", val.text(proposal.provenance.evidence)],
		["risk_note", val.text(proposal.riskNote)],
		["agent_id", val.str(actor.agentId)],
		["visibility", val.str("global")],
		["created_at", val.str(now)],
	]);

	return id;
}

// ════════════════════════════════════════════════════════════════════════════
// THE APPLY PATH (c-AC-1 / c-AC-3 / c-AC-4) — bounded ops only, lineage-copied
// ════════════════════════════════════════════════════════════════════════════

/**
 * Read a string field off a proposal payload defensively ("" when absent / non-string).
 * The payload is genuinely schemaless (JSONB), so the apply path projects the fields it
 * needs and tolerates the rest.
 */
function payloadStr(payload: Record<string, unknown>, key: string): string {
	const v = payload[key];
	return typeof v === "string" ? v : "";
}

/** Read a numeric field off a payload defensively (fallback when absent / non-numeric). */
function payloadNum(payload: Record<string, unknown>, key: string, fallback: number): number {
	const v = payload[key];
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Apply a bounded explicit operation directly (c-AC-1 / c-AC-3 / c-AC-4).
 *
 * ── Lineage (c-AC-1), within the Wave-1 catalog ─────────────────────────────
 * The catalog `entity_attributes` row carries `memory_id` (the mandatory evidence
 * POINTER, a-AC-3) but has NO first-class `source`/`proposal_id` columns — and those
 * are PRD-003 columns this Bee may not add (file-boundary). So the evidence lineage is
 * carried by TWO append-only records: (a) the resulting attribute row's `memory_id`,
 * and (b) the `applied` `ontology_proposals` row, which carries the FULL evidence +
 * the operation + the slot/aspect that DETERMINISTICALLY resolves the resulting
 * attribute (the same id derivation `supersedeClaim`/`writeAttribute` use). Together
 * they make the lineage reconstructable and survive even if the proposal row is later
 * archived — exactly the trace `supersede.ts`'s header prescribes. The proposal's
 * `provenance.evidence` is ALSO threaded into the attribute provenance `source` +
 * `proposalId` so the lineage lands directly on the row the moment those columns are
 * added by a future additive heal (forward-compatible, no behavior change today).
 *
 * Only graph ENGINE tables are touched (entities / aspects / entity_attributes). Raw
 * source artifacts / transcripts (`sessions`, `source`, memory tables) are NEVER
 * written here (c-AC-3) — the apply path has no code path that reaches them.
 *
 * `claim.supersede` REUSES {@link supersedeClaim} (append + mark prior, never an
 * in-place mutate — c-AC-4). `entity.create` / `aspect.create` / `claim.add` /
 * `claim.set` write through the entity-model writers.
 */
async function applyBoundedOperation(
	storage: StorageQuery,
	scope: QueryScope,
	actor: ControlPlaneActor,
	proposal: Proposal,
	appliedProposalId: string,
): Promise<void> {
	const p = proposal.payload;
	const evidence = proposal.provenance.evidence;

	switch (proposal.operation) {
		case "entity.create": {
			await writeEntity(storage, scope, {
				agentId: actor.agentId,
				rawName: payloadStr(p, "name"),
				type: payloadStr(p, "type"),
				sourceId: appliedProposalId,
				sourceType: "proposal",
			});
			return;
		}
		case "aspect.create": {
			await writeAspect(storage, scope, {
				agentId: actor.agentId,
				entityId: payloadStr(p, "entityId"),
				name: payloadStr(p, "name"),
				weight: payloadNum(p, "weight", 1),
			});
			return;
		}
		case "claim.add":
		case "claim.set": {
			// A first/new claim in a slot. The version-bumped supersede path is the EDIT
			// path; a plain add is the entity-model writer with the proposal lineage copied
			// onto the row (memory_id is the mandatory provenance; the proposal id + evidence
			// ride the provenance).
			await writeAttribute(storage, scope, {
				agentId: actor.agentId,
				aspectId: payloadStr(p, "aspectId"),
				slot: { groupKey: payloadStr(p, "groupKey"), claimKey: payloadStr(p, "claimKey") },
				kind: payloadStr(p, "kind") === "constraint" ? "constraint" : "attribute",
				content: payloadStr(p, "content"),
				confidence: payloadNum(p, "confidence", proposal.confidence),
				importance: payloadNum(p, "importance", 0.5),
				provenance: {
					memoryId: payloadStr(p, "memoryId"),
					source: evidence === "" ? "proposal" : evidence,
					proposalId: appliedProposalId,
				},
			});
			return;
		}
		case "claim.supersede": {
			// Append-only version bump via the shared core (c-AC-4) — NEVER in-place.
			await supersedeClaim(storage, scope, {
				entityId: payloadStr(p, "entityId"),
				aspectId: payloadStr(p, "aspectId"),
				groupKey: payloadStr(p, "groupKey"),
				claimKey: payloadStr(p, "claimKey"),
				newAttribute: {
					kind: payloadStr(p, "kind") === "constraint" ? "constraint" : "attribute",
					content: payloadStr(p, "content"),
					confidence: payloadNum(p, "confidence", proposal.confidence),
					importance: payloadNum(p, "importance", 0.5),
					provenance: {
						memoryId: payloadStr(p, "memoryId"),
						source: evidence === "" ? "proposal" : evidence,
						proposalId: appliedProposalId,
					},
					agentId: actor.agentId,
				},
				priorId: payloadStr(p, "priorId") === "" ? undefined : payloadStr(p, "priorId"),
			});
			return;
		}
		default: {
			// Unreachable: routeProposal only sends DIRECT_APPLY_OPERATIONS here. The
			// exhaustive switch keeps the apply path honest if the allow-list grows.
			throw new ProposalApplyError(proposal.operation);
		}
	}
}

/** Thrown when the apply path is handed an operation outside the direct-apply allow-list. */
export class ProposalApplyError extends Error {
	readonly operation: string;
	constructor(operation: string) {
		super(`ontology control plane: "${operation}" is not a direct-apply operation`);
		this.name = "ProposalApplyError";
		this.operation = operation;
	}
}

// ════════════════════════════════════════════════════════════════════════════
// submitProposal — the control-plane entry point
// ════════════════════════════════════════════════════════════════════════════

/**
 * Submit a proposal to the control plane (c-AC-1 / c-AC-2 / c-AC-3 / c-AC-4 / c-AC-6).
 *
 * Steps:
 *   1. Validate via {@link parseProposal} (c-AC-6). An invalid body is a `failed`
 *      outcome — never a throw past the boundary (the CLI / generator routes it).
 *   2. Risk-route via {@link routeProposal} (D-6).
 *   3. PENDING → write a single `pending` `ontology_proposals` row and STOP (c-AC-2);
 *      nothing is applied.
 *   4. DIRECT → write an `applied` `ontology_proposals` row, then apply the bounded
 *      op, copying the proposal evidence onto the resulting rows (c-AC-1). A
 *      `claim.supersede` reuses {@link supersedeClaim} (c-AC-4). Raw artifacts are
 *      NEVER rewritten (c-AC-3).
 *
 * The `actor` carries the agent id every row is scoped to (D-2).
 */
export async function submitProposal(
	storage: StorageQuery,
	scope: QueryScope,
	candidate: unknown,
	actor: ControlPlaneActor = { agentId: "default" },
): Promise<ApplyOutcome> {
	const proposal = parseProposal(candidate);
	if (proposal === null) {
		// A malformed proposal is rejected at the boundary — it is recorded NOWHERE and
		// applied NOWHERE. The caller sees a `failed` outcome (c-AC-6: only well-formed
		// proposals carry the full audit record).
		return { route: "pending", proposalId: "", status: "failed" };
	}

	const decision = routeProposal(proposal);

	if (decision.route === "pending") {
		// c-AC-2: broad/risky/generated → the review queue. Recorded `pending`, NOT applied.
		const proposalId = await recordProposalRow(storage, scope, actor, proposal, "pending", "pending");
		return { route: "pending", proposalId, status: "pending" };
	}

	// c-AC-1: bounded explicit op → write the `applied` audit row FIRST so the apply
	// path can copy ITS id onto the resulting rows for lineage, then apply.
	const appliedProposalId = await recordProposalRow(storage, scope, actor, proposal, "applied", "applied");
	await applyBoundedOperation(storage, scope, actor, proposal, appliedProposalId);
	return { route: "direct", proposalId: appliedProposalId, status: "applied" };
}

// ════════════════════════════════════════════════════════════════════════════
// recordAssertion — the epistemic attribution layer (c-AC-5 / FR-7 / FR-8)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Map an assertion predicate (the contract's stance vocabulary) onto the catalog's
 * `epistemic_assertions.stance` enum (FR-7). The two vocabularies differ by tense
 * only (`claims` → `claimed`); this is the single mapping point.
 */
const PREDICATE_TO_STANCE: Readonly<Record<AssertionPredicate, (typeof EPISTEMIC_STANCES)[number]>> = Object.freeze({
	claims: "claimed",
	believes: "believed",
	observed: "observed",
	decided: "decided",
	prefers: "preferred",
	denies: "denied",
	questions: "questioned",
});

/** Deterministic id for an `epistemic_assertions` chain from speaker + predicate + content. */
function assertionKey(assertion: Assertion): string {
	const material = `${assertion.speaker}:${assertion.predicate}:${assertion.content}`;
	const hash = crypto.createHash("sha256").update(material).digest("hex").slice(0, 24);
	return `assert_${hash}`;
}

/**
 * Record an epistemic assertion (c-AC-5 / FR-7 / FR-8).
 *
 * Validates via {@link parseAssertion}, then APPENDs a version-bumped
 * `epistemic_assertions` row carrying the predicate (mapped to the catalog `stance`),
 * the content, the speaker, the confidence, the evidence (the `provenance` column),
 * and the status. The assertion MAY link to a claim attribute via `claimKey`, but it
 * is a SEPARATE evidence-and-attribution layer: this function writes ONLY
 * `epistemic_assertions` and NEVER touches `entity_attributes` — an assertion does
 * NOT auto-promote into ontology truth (FR-8). Promoting an assertion to a claim is a
 * separate `submitProposal` call, never a side effect here.
 *
 * Version-bumped (the catalog pattern): a revised belief from the same speaker on the
 * same content appends version N+1 rather than mutating, so the attribution history
 * stays on disk. Returns the validated assertion, or `null` on an invalid body.
 */
export async function recordAssertion(
	storage: StorageQuery,
	scope: QueryScope,
	candidate: unknown,
	actor: ControlPlaneActor = { agentId: "default" },
): Promise<Assertion | null> {
	const assertion = parseAssertion(candidate);
	if (assertion === null) return null;

	const target = healTargetFor(T_ASSERTIONS);
	const key = assertionKey(assertion);
	const stance = PREDICATE_TO_STANCE[assertion.predicate];
	const now = nowIso();

	await appendVersionBumped(storage, target, scope, {
		keyColumn: "id",
		keyValue: key,
		row: [
			["id", val.str(key)],
			["agent_id", val.str(actor.agentId)],
			["stance", val.str(stance)],
			// subject = WHO asserted (speaker); object = WHAT was asserted (content); the
			// predicate text is preserved verbatim so the attribution stance is auditable.
			["subject", val.text(assertion.speaker)],
			["predicate", val.str(assertion.predicate)],
			["object", val.text(assertion.content)],
			["confidence", val.num(clamp01(assertion.confidence))],
			["provenance", val.text(assertion.evidence)],
			["claim_key", val.str(assertion.claimKey ?? "")],
			["status", val.str(assertion.status)],
			["visibility", val.str("global")],
			["created_at", val.str(now)],
		],
	});

	return assertion;
}

// ════════════════════════════════════════════════════════════════════════════
// THE DRY-RUN PLAN (c-AC-7) — report WITHOUT mutating
// ════════════════════════════════════════════════════════════════════════════

/** One step a `submitProposal` WOULD take, reported by the dry-run (c-AC-7). */
export interface PlanStep {
	/** A human label for the step (e.g. `apply claim.supersede`). */
	readonly label: string;
	/** The SQL the step WOULD issue, if known (escaped through the helpers). */
	readonly sql?: string;
}

/** The plan a dry-run reports for a proposal (c-AC-7) — never executed. */
export interface ApplyPlan {
	/** The route the proposal WOULD take (D-6). */
	readonly route: ApplyRoute;
	/** Why it routes that way. */
	readonly reason: RouteReason;
	/** The proposal status the run WOULD produce. */
	readonly status: Proposal["status"];
	/** The org/workspace/agent scope the run is bound to (c-AC-7). */
	readonly scope: { readonly org: string; readonly workspace: string; readonly agentId: string };
	/** The ordered steps the run WOULD take. Empty for a malformed proposal. */
	readonly steps: readonly PlanStep[];
}

/**
 * Build the apply PLAN for a proposal WITHOUT mutating anything (c-AC-7). This is the
 * dry-run core the CLI's `stream apply --dry-run` calls: it validates + risk-routes
 * the proposal and describes the steps a real `submitProposal` would take, but issues
 * NO write. The plan is scoped by org/workspace/agent so the report shows exactly what
 * partition + agent the run is bound to.
 *
 * Pure (no storage handle): the plan is computed from the proposal + scope alone, so
 * there is structurally no way for a dry-run to touch the backend.
 */
export function planApply(
	scope: QueryScope,
	candidate: unknown,
	actor: ControlPlaneActor = { agentId: "default" },
): ApplyPlan {
	const boundScope = {
		org: scope.org,
		workspace: scope.workspace ?? "",
		agentId: actor.agentId,
	};
	const proposal = parseProposal(candidate);
	if (proposal === null) {
		return {
			route: "pending",
			reason: "operation-not-bounded",
			status: "failed",
			scope: boundScope,
			steps: [{ label: "reject: malformed proposal (no audit row written)" }],
		};
	}

	const decision = routeProposal(proposal);
	const steps: PlanStep[] = [];

	if (decision.route === "pending") {
		steps.push({ label: `record pending proposal (${proposal.operation})` });
		steps.push({ label: `enqueue for review: ${decision.reason}` });
		return { route: "pending", reason: decision.reason, status: "pending", scope: boundScope, steps };
	}

	steps.push({ label: `record applied proposal (${proposal.operation})` });
	if (proposal.operation === "claim.supersede") {
		// Surface the version-bump read the supersede path would issue — purely as a
		// preview string, built through the SAME escaping helpers a real write uses.
		const aspectId = payloadStr(proposal.payload, "aspectId");
		const slot = {
			groupKey: payloadStr(proposal.payload, "groupKey"),
			claimKey: payloadStr(proposal.payload, "claimKey"),
		};
		const claimKey = slotClaimKey(aspectId, slot);
		const tbl = sqlIdent("entity_attributes");
		const claimKeyCol = sqlIdent("claim_key");
		steps.push({
			label: "apply claim.supersede via append-only version bump (supersedeClaim)",
			sql: `SELECT version FROM "${tbl}" WHERE ${claimKeyCol} = ${sLiteral(claimKey)} ORDER BY version DESC LIMIT 1`,
		});
	} else {
		steps.push({ label: `apply ${proposal.operation} (evidence copied onto resulting rows)` });
	}
	return { route: "direct", reason: decision.reason, status: "applied", scope: boundScope, steps };
}

// ── Local scalar clamp ────────────────────────────────────────────────────────

/** Clamp a score into [0, 1]; non-finite → 0. */
function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.min(1, Math.max(0, n));
}

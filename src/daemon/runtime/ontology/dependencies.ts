/**
 * Dependencies + append-only supersession — PRD-008b (Wave 2, `deeplake-dataset-worker-bee`).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * FILLED. The two write paths this module owns:
 *   1. {@link writeDependencyEdge} — append an audited `entity_dependencies` edge.
 *   2. {@link supersedeOnConflict} — detect a slot conflict and, when genuine and
 *      the prior is NOT a constraint, supersede the prior via the shared
 *      {@link supersedeClaim} (append + mark, NEVER an in-place mutate).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The ACs this module proves (see `tests/daemon/runtime/ontology/dependencies.test.ts`):
 *   - b-AC-1 New attr in same slot → conflicting sibling marked superseded
 *            (status + superseded_by via the version-bump append), not mutated.
 *            → REUSE {@link supersedeClaim} from `./supersede.js` (the shared core).
 *            This module supplies the CONFLICT DETECTION that decides WHEN to
 *            supersede; the append+mark mechanic is `supersedeClaim`'s job.
 *   - b-AC-2 Concurrent edits → no in-place mutate; full version history on disk
 *            (this is `supersedeClaim`'s guarantee — append + mark a distinct row).
 *   - b-AC-3 Loose `related_to` edge carries type, strength, confidence, REQUIRED
 *            reason. → write `entity_dependencies` (append-only) via the catalog's
 *            {@link assertDependencyReason} guard + `appendOnlyInsert`.
 *   - b-AC-4 Edge followed only when strength × confidence clears the threshold
 *            (D-4: ≥ 0.3). → {@link edgeClearsThreshold} / {@link EDGE_THRESHOLD},
 *            the gate 007b's traversal reads; this module writes the values it reads.
 *   - b-AC-5 Constraint → NOT auto-superseded (D-7). The conflict path SKIPS a prior
 *            sibling whose `kind = 'constraint'`; `supersedeClaim` stays mechanism.
 *   - b-AC-6 Conflict detection: lexical overlap + negation/antonym (+ optional LLM
 *            fallback via the {@link ConflictModel} seam, OFF by default — D-5).
 *   - b-AC-7 Every write escaped + through the daemon (`val.*` / `sLiteral` /
 *            `sqlIdent`; never a raw fetch). `audit:sql` scans `src/daemon`.
 *
 * ── Live-determinism (mirrors `pipeline/graph-persist.ts`) ───────────────────
 * `entity_dependencies` is APPEND-ONLY and DeepLake has no composite unique
 * constraint, so an edge is deduped by a DETERMINISTIC id (sha256 of the natural
 * key) + a POLL-CONVERGENT probe: a scan can MISS a just-written row on a stale
 * segment but never INVENTS one, so polling converges UP to the durable truth. The
 * insert is heal-aware (`appendOnlyInsert` → `withHeal`), so the table is created
 * lazily on the first write.
 */

import crypto from "node:crypto";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import {
	assertDependencyReason,
	RELATED_TO,
} from "../../storage/catalog/knowledge-graph.js";
import { healTargetFor } from "../../storage/catalog/index.js";
import { isOk } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { appendOnlyInsert, val } from "../../storage/writes.js";
import type { Attribute, AttributeSlot } from "./contracts.js";
import {
	supersedeClaim,
	type SupersedeNewAttribute,
	type SupersedeResult,
} from "./supersede.js";

/** The `entity_dependencies` table this module appends edges to. */
const T_DEPENDENCIES = "entity_dependencies";

/**
 * How many times the dedup probe re-reads a by-id row before concluding ABSENT.
 * Mirrors `graph-persist.ts`'s `PROBE_POLLS` / `supersede.ts`'s `PRIOR_POLLS`: this
 * backend serves a read from segments of differing freshness, so a just-written
 * row is reliably seen by a later pass. A scan never invents a row, so polling only
 * turns a false-absent into the true-present. On the deterministic fake the first
 * poll is authoritative.
 */
export const EDGE_PROBE_POLLS = 8;

/**
 * The default strength × confidence gate for a TRAVERSABLE edge (D-4 / b-AC-4;
 * matches PRD-007b's traversal threshold). An edge whose `strength × confidence`
 * is below this is recorded but NOT followed during recall — a soft, low-confidence
 * link with a recorded reason stays out of traversal.
 */
export const EDGE_THRESHOLD = 0.3;

/** ISO timestamp for `created_at`. */
function nowIso(): string {
	return new Date().toISOString();
}

/**
 * A dependency edge persisted into `entity_dependencies` (b-AC-3). The `reason` is
 * REQUIRED for a {@link RELATED_TO} edge — {@link assertDependencyReason} rejects an
 * empty one before any write.
 */
export interface DependencyEdge {
	readonly sourceEntityId: string;
	readonly targetEntityId: string;
	/** Edge type (e.g. `related_to`, `depends_on`). */
	readonly type: string;
	readonly strength: number;
	readonly confidence: number;
	/** Required for a loose `related_to` edge (b-AC-3). */
	readonly reason: string;
	readonly agentId: string;
	/** Row visibility (default `global`). */
	readonly visibility?: string;
}

/**
 * Conflict-detection inputs (b-AC-6): the incoming claim vs the prior sibling
 * occupying the slot. The detector weighs lexical overlap + negation/antonym
 * signals (+ optional LLM fallback, OFF by default per D-5).
 */
export interface ConflictCheckArgs {
	readonly incoming: Pick<Attribute, "content" | "kind">;
	readonly prior: Pick<Attribute, "id" | "content" | "kind">;
	readonly slot: AttributeSlot;
}

/**
 * Optional LLM semantic-fallback seam for conflict detection (D-5 / b-AC-6). OFF by
 * DEFAULT: when no model is injected the detector is purely lexical (overlap +
 * negation/antonym), making the common path model-free and deterministic. A test
 * injects a FAKE to prove the fallback fires only when the lexical signal is
 * inconclusive. Returns `true` when the two values semantically CONFLICT.
 *
 * This is a dependencies-local seam (not the pipeline {@link import("../pipeline/model-client.js").ModelClient}):
 * the pipeline `MODEL_WORKLOADS` enum is a shared Wave-1 surface and conflict
 * detection is not one of its v1 workloads, so wiring a new workload would edit a
 * shared file. The narrow boolean seam keeps this module contention-free while still
 * honouring the "inject the model, fake it in tests, off by default" rule.
 */
export interface ConflictModel {
	/** Resolve whether `incoming` semantically CONFLICTS with `prior`. */
	conflicts(incoming: string, prior: string): Promise<boolean>;
}

/** Options for {@link supersedeOnConflict} — the optional model seam (OFF by default). */
export interface SupersedeOnConflictOptions {
	/**
	 * Optional LLM fallback. UNSET = lexical-only detection (D-5 default). When set,
	 * the model is consulted ONLY when the lexical signal is inconclusive (not a
	 * clear match and not a clear conflict), so an obvious conflict never pays for a
	 * model round-trip.
	 */
	readonly model?: ConflictModel;
}

/** Why {@link detectConflict} reached its verdict — surfaced for the audit trail + tests. */
export type ConflictSignal = "negation" | "antonym" | "low-overlap" | "high-overlap" | "model" | "identical";

/** The verdict from {@link detectConflict}: does the incoming claim conflict with the prior? */
export interface ConflictVerdict {
	/** True when the incoming claim CONFLICTS with the prior (and should supersede it). */
	readonly conflict: boolean;
	/** The signal that decided the verdict. */
	readonly signal: ConflictSignal;
	/** Lexical (Jaccard) overlap of the two token sets, 0..1. */
	readonly overlap: number;
	/** True when the lexical pass was inconclusive (the LLM fallback fires here, if present). */
	readonly inconclusive: boolean;
}

// ── Lexical conflict detection (b-AC-6, D-5) ──────────────────────────────────

/** Negation tokens — a flip in negation between two otherwise-overlapping claims signals a conflict. */
const NEGATION_TOKENS = new Set(["not", "no", "never", "none", "cannot", "cant", "wont", "dont", "doesnt", "isnt", "arent", "without"]);

/**
 * Antonym pairs — a swap between a pair across two overlapping claims signals a
 * conflict ("prefers tabs" vs "prefers spaces" is NOT an antonym pair, but
 * "enabled" vs "disabled" is). Symmetric: looked up both ways.
 */
const ANTONYM_PAIRS: ReadonlyArray<readonly [string, string]> = Object.freeze([
	["enabled", "disabled"],
	["enable", "disable"],
	["on", "off"],
	["true", "false"],
	["yes", "no"],
	["allow", "deny"],
	["allowed", "denied"],
	["active", "inactive"],
	["open", "closed"],
	["up", "down"],
	["start", "stop"],
	["include", "exclude"],
	["accept", "reject"],
	["present", "absent"],
	["online", "offline"],
	["before", "after"],
	["increase", "decrease"],
	["always", "never"],
]);

/** The lexical-overlap floor at/above which two claims are "the same claim restated" (no conflict). */
const HIGH_OVERLAP = 0.6;
/** The lexical-overlap floor below which two overlapping claims are "unrelated" (no conflict signal). */
const LOW_OVERLAP = 0.1;

/** Normalise a claim into a set of lowercased word tokens (punctuation stripped). */
function tokenize(content: string): string[] {
	return content
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((t) => t.length > 0);
}

/** Jaccard overlap of two token multisets reduced to sets, 0..1. */
function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 1;
	let inter = 0;
	for (const t of a) if (b.has(t)) inter++;
	const union = a.size + b.size - inter;
	return union === 0 ? 0 : inter / union;
}

/** Count the negation tokens present in a token set. */
function negationCount(tokens: Set<string>): number {
	let n = 0;
	for (const t of tokens) if (NEGATION_TOKENS.has(t)) n++;
	return n;
}

/** True when the two token sets straddle an antonym pair (one side has each half). */
function hasAntonymSwap(a: Set<string>, b: Set<string>): boolean {
	for (const [x, y] of ANTONYM_PAIRS) {
		if ((a.has(x) && b.has(y)) || (a.has(y) && b.has(x))) return true;
	}
	return false;
}

/**
 * Detect whether `incoming` CONFLICTS with `prior` for the same slot (b-AC-6 / D-5).
 * PURE + model-free — the lexical pass:
 *
 *   1. Identical content → NOT a conflict (a re-assert of the same claim).
 *   2. A NEGATION flip on otherwise-overlapping tokens → conflict (negation signal).
 *   3. An ANTONYM swap on otherwise-overlapping tokens → conflict (antonym signal).
 *   4. Very HIGH overlap (≥ {@link HIGH_OVERLAP}) with no flip → NOT a conflict
 *      (the same claim restated). Very LOW overlap (< {@link LOW_OVERLAP}) → NOT a
 *      conflict signal (the two claims are unrelated; supersession should not fire
 *      on noise). These two are the CONCLUSIVE no-conflict ends.
 *   5. Anything in the middle band is INCONCLUSIVE — the lexical pass abstains, and
 *      the optional LLM fallback (if injected) decides. With no model, an
 *      inconclusive mid-band overlap defaults to NO conflict (conservative: never
 *      supersede on an ambiguous lexical signal alone).
 *
 * Returns the full {@link ConflictVerdict} so the caller (and the LLM fallback) can
 * see the overlap + whether the lexical pass was inconclusive.
 */
export function detectConflict(incoming: string, prior: string): ConflictVerdict {
	const aTokens = tokenize(incoming);
	const bTokens = tokenize(prior);
	const a = new Set(aTokens);
	const b = new Set(bTokens);

	if (incoming.trim().toLowerCase() === prior.trim().toLowerCase()) {
		return { conflict: false, signal: "identical", overlap: 1, inconclusive: false };
	}

	const overlap = jaccard(a, b);

	// Negation / antonym flips signal a conflict only when the claims actually share
	// subject matter (some overlap) — otherwise two unrelated claims that each happen
	// to contain a negation would falsely conflict.
	const sharesSubject = overlap >= LOW_OVERLAP;
	const negationFlip = negationCount(a) !== negationCount(b);
	if (sharesSubject && negationFlip) {
		return { conflict: true, signal: "negation", overlap, inconclusive: false };
	}
	if (sharesSubject && hasAntonymSwap(a, b)) {
		return { conflict: true, signal: "antonym", overlap, inconclusive: false };
	}

	// Conclusive no-conflict ends: a near-restatement, or an unrelated claim.
	if (overlap >= HIGH_OVERLAP) {
		return { conflict: false, signal: "high-overlap", overlap, inconclusive: false };
	}
	if (overlap < LOW_OVERLAP) {
		return { conflict: false, signal: "low-overlap", overlap, inconclusive: false };
	}

	// Mid-band: the lexical pass abstains. The LLM fallback decides if present.
	return { conflict: false, signal: "low-overlap", overlap, inconclusive: true };
}

// ── Edge threshold gate (b-AC-4, D-4) ─────────────────────────────────────────

/**
 * The traversal gate (D-4 / b-AC-4): does an edge's `strength × confidence` clear
 * {@link EDGE_THRESHOLD} (default 0.3)? PRD-007b's traversal reads exactly this, so
 * a soft low-confidence edge — recorded with a reason but a low product — is NOT
 * followed during recall. Pure. A `threshold` override is accepted for tests /
 * future tuning, but the default IS the D-4 value.
 */
export function edgeClearsThreshold(
	strength: number,
	confidence: number,
	threshold: number = EDGE_THRESHOLD,
): boolean {
	const product = strength * confidence;
	return Number.isFinite(product) && product >= threshold;
}

// ── Deterministic edge id + dedup probe ───────────────────────────────────────

/**
 * Derive a stable id for an `entity_dependencies` edge from its natural key
 * (source, target, type). Prefixed `dep_`. Deterministic so a re-assert of the
 * SAME edge resolves the SAME id and the dedup probe finds it (idempotency on the
 * live backend — mirrors `graph-persist.ts`'s `dependencyId`). Pure.
 */
export function dependencyEdgeId(sourceId: string, targetId: string, type: string): string {
	const hash = crypto.createHash("sha256").update(`${sourceId}:${targetId}:${type}`).digest("hex").slice(0, 24);
	return `dep_${hash}`;
}

/**
 * Is an edge with this deterministic `id` already present? POLL-CONVERGENT: re-read
 * a by-id `SELECT id … LIMIT 1` up to {@link EDGE_PROBE_POLLS} times, taking PRESENT
 * on the first hit. A scan can miss a durably-written row on a stale segment but
 * never invents one, so polling converges UP to the durable truth. A non-ok result
 * (table not created yet) is NOT "present" — the caller proceeds to the heal-aware
 * insert.
 */
async function edgeIsPresent(storage: StorageQuery, scope: QueryScope, id: string): Promise<boolean> {
	const tbl = sqlIdent(T_DEPENDENCIES);
	const idCol = sqlIdent("id");
	const sql = `SELECT ${idCol} FROM "${tbl}" WHERE ${idCol} = ${sLiteral(id)} LIMIT 1`;
	for (let poll = 0; poll < EDGE_PROBE_POLLS; poll++) {
		const res = await storage.query(sql, scope);
		if (isOk(res) && res.rows.length > 0) return true;
	}
	return false;
}

// ── Write path: dependency edge (b-AC-3, b-AC-7) ──────────────────────────────

/**
 * Write an audited dependency edge into `entity_dependencies` (FR-1 / FR-3 / b-AC-3).
 *
 * Steps:
 *   1. {@link assertDependencyReason}(type, reason) FIRST — REJECTS a loose
 *      `related_to` edge with an empty/whitespace reason (b-AC-3) so the bad edge
 *      never reaches the INSERT.
 *   2. Resolve the DETERMINISTIC `dep_` id off the natural key and POLL-CONVERGENTLY
 *      dedup — a re-assert of the same edge is an idempotent no-op (mirrors
 *      `graph-persist.ts`).
 *   3. `appendOnlyInsert` the row with `strength` / `confidence` (the values 007b's
 *      gate reads — b-AC-4) + the `reason`. Heal-aware: the table is created lazily
 *      on the first write.
 *
 * The legacy `relations` table is NEVER written (FR-3). Every value routes through
 * the guarded `val.*` constructors; every identifier through `sqlIdent` (b-AC-7).
 */
export async function writeDependencyEdge(
	storage: StorageQuery,
	scope: QueryScope,
	edge: DependencyEdge,
): Promise<void> {
	// 1. Reason guard (b-AC-3): a loose related_to edge with no rationale is rejected
	//    before any write — a weak link with no reason is not auditable.
	assertDependencyReason(edge.type, edge.reason);
	void RELATED_TO;

	const target = healTargetFor(T_DEPENDENCIES);
	const id = dependencyEdgeId(edge.sourceEntityId, edge.targetEntityId, edge.type);

	// 2. Idempotency probe (poll-convergent): a re-asserted edge appends no new row.
	if (await edgeIsPresent(storage, scope, id)) return;

	// 3. Append the audited edge (heal-aware). strength/confidence are the values the
	//    007b traversal gate reads (b-AC-4); reason carries the audit trail (b-AC-3).
	const now = nowIso();
	await appendOnlyInsert(storage, target, scope, [
		["id", val.str(id)],
		["source_entity_id", val.str(edge.sourceEntityId)],
		["target_entity_id", val.str(edge.targetEntityId)],
		["type", val.str(edge.type)],
		["strength", val.num(clamp01(edge.strength))],
		["confidence", val.num(clamp01(edge.confidence))],
		["reason", val.text(edge.reason)],
		["agent_id", val.str(edge.agentId)],
		["visibility", val.str(edge.visibility ?? "global")],
		["created_at", val.str(now)],
	]);
}

// ── Write path: supersede on conflict (b-AC-1, b-AC-5, b-AC-6) ─────────────────

/**
 * Detect whether the incoming claim CONFLICTS with the prior sibling occupying the
 * slot and, if so, supersede the prior via the shared {@link supersedeClaim} —
 * UNLESS the prior is a `constraint` (D-7 / b-AC-5: constraints are NOT
 * auto-superseded). Returns the {@link SupersedeResult} when a supersession ran, or
 * `null` when none did (no conflict, or the prior is a constraint).
 *
 * Flow:
 *   1. CONSTRAINT GUARD (b-AC-5 / D-7): if the prior is `kind='constraint'`, return
 *      null immediately — replacing a constraint requires a deliberate control-plane
 *      op (008c), never an automatic supersede. Checked FIRST so a constraint never
 *      even pays for conflict detection.
 *   2. LEXICAL DETECTION (b-AC-6 / D-5): {@link detectConflict}. A conclusive verdict
 *      (negation/antonym → conflict; identical/high/low overlap → no conflict) is
 *      taken as-is.
 *   3. OPTIONAL LLM FALLBACK (D-5, OFF by default): only when the lexical pass is
 *      INCONCLUSIVE and a `model` is injected, the model decides. No model → the
 *      inconclusive band defaults to NO conflict (conservative).
 *   4. SUPERSEDE (b-AC-1): on a genuine conflict, call {@link supersedeClaim} with the
 *      caller-supplied `priorId` (the detector already has it) so it APPENDS N+1
 *      active + MARKS the prior superseded — never an in-place mutate.
 *
 * The append+mark mechanic is entirely `supersedeClaim`'s; this function is the
 * POLICY (detect + constraint-exempt) the CONVENTIONS contract places in the caller.
 */
export async function supersedeOnConflict(
	storage: StorageQuery,
	scope: QueryScope,
	args: ConflictCheckArgs,
	superArgs?: SupersedeArgs,
	options: SupersedeOnConflictOptions = {},
): Promise<SupersedeResult | null> {
	// 1. Constraint guard (D-7 / b-AC-5): a constraint is never auto-superseded.
	if (args.prior.kind === "constraint") return null;

	// 2. Lexical conflict detection (b-AC-6 / D-5).
	const verdict = detectConflict(args.incoming.content, args.prior.content);
	let conflict = verdict.conflict;

	// 3. Optional LLM fallback — ONLY on an inconclusive lexical pass, ONLY if injected
	//    (OFF by default, D-5). An obvious conflict never pays for a model round-trip.
	if (!conflict && verdict.inconclusive && options.model) {
		conflict = await options.model.conflicts(args.incoming.content, args.prior.content);
	}

	if (!conflict) return null;

	// A genuine conflict but no supersede context supplied: there is nothing to land
	// as the new active version, so we cannot supersede. Surface it rather than
	// silently mutating — the caller MUST pass `superArgs` when it wants the append.
	if (!superArgs) {
		throw new Error(
			"supersedeOnConflict: a conflict was detected but no superArgs (new attribute) was supplied to land",
		);
	}

	// 4. Genuine conflict on a non-constraint → supersede by append + mark (b-AC-1).
	//    The detector already holds the prior id, so it is passed through (skips the
	//    poll-convergent prior read in the shared helper).
	return supersedeClaim(storage, scope, {
		entityId: superArgs.entityId,
		aspectId: superArgs.aspectId,
		groupKey: args.slot.groupKey,
		claimKey: args.slot.claimKey,
		newAttribute: superArgs.newAttribute,
		priorId: args.prior.id,
	});
}

/**
 * The supersede context {@link supersedeOnConflict} threads into {@link supersedeClaim}
 * once it has decided a conflict is genuine: the entity/aspect the claim hangs under
 * and the new attribute to land as the active version N+1. The slot + prior id come
 * from the {@link ConflictCheckArgs}, so they are not repeated here.
 */
export interface SupersedeArgs {
	/** The entity the claim hangs under (audit context). */
	readonly entityId: string;
	/** The aspect the claim hangs under. */
	readonly aspectId: string;
	/** The new claim to land as `status='active'` at version N+1. */
	readonly newAttribute: SupersedeNewAttribute;
}

/** Clamp a score into [0, 1]; non-finite → 0. */
function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.min(1, Math.max(0, n));
}

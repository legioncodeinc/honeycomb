/**
 * Recall contracts — PRD-007 Wave 1 (the cross-phase shapes the whole engine
 * shares). Wave 2's four phase Bees (007b traversal, 007c authorization, 007d
 * shaping, 007e gate) code AGAINST these types; they do not redefine them.
 *
 * ── The flow these shapes describe ──────────────────────────────────────────
 *   collect (007a) → traverse (007b) → authorize (007c) → shape (007d) → gate (007e)
 *
 * Up to and through authorization, ONLY IDs move — a {@link Candidate} carries an
 * `id`, per-channel `scores`, and the `provenance` channel list, and NEVER a
 * content field (AC-1 / a-AC-7 / 007c FR-6). Content hydration is the gate's job
 * (007e), strictly on the authorized set.
 *
 * ── The merged pool ─────────────────────────────────────────────────────────
 * Collection merges every channel's IDs into a {@link MergedPool}: a `Candidate`
 * per memory id, the strongest calibrated per-channel score retained, the channel
 * provenance unioned. The pool is the hand-off between phases — each phase takes a
 * pool and returns a (narrowed / re-scored) pool, never raw rows.
 *
 * ── No-touch (CONVENTIONS §shared) ──────────────────────────────────────────
 * This file and `scope-clause.ts` are the shared contract surface. A Wave-2 phase
 * ADDS its own module + test; it does NOT edit this file. A genuinely new
 * cross-phase field is added here once, in Wave 1, and documented.
 */

import type { ScopeClause } from "./scope-clause.js";

/**
 * The recall channels a candidate id can come from (a-AC-7 / FR-8). Each is a
 * distinct signal; a candidate's {@link Candidate.provenance} lists every channel
 * that surfaced it, so shaping (007d) can see whether an id rode in on one channel
 * or many (the evidence-convolution input, d-AC-1).
 */
export const RECALL_CHANNELS = Object.freeze(["fts", "vector", "hint", "traversal", "structured"] as const);
/** One recall channel. */
export type RecallChannel = (typeof RECALL_CHANNELS)[number];

/**
 * The per-channel calibrated scores on a candidate (a-AC-5 / FR-8). Each is the
 * channel's own 0..1 calibrated score for this id; an absent key means the channel
 * did not surface the id. Kept per-channel (NOT pre-blended) so the merge can pick
 * the strongest-wins value and shaping can convolve the evidence later.
 */
export interface CandidateScores {
	/** BM25-style FTS score, normalized 0..1 (a-AC-1 / FR-3). */
	readonly fts?: number;
	/** GPU `<#>` cosine similarity, normalized 0..1 (a-AC-2 / FR-4). */
	readonly vector?: number;
	/** Prospective-hint match score, capped channel (a-AC-4 / FR-7). */
	readonly hint?: number;
	/** Bounded graph-walk score (007b / b-AC-7). */
	readonly traversal?: number;
	/** Structured-route score (007b structured). */
	readonly structured?: number;
}

/**
 * One candidate memory in the recall pool — IDs ONLY, never content (a-AC-7 /
 * 007c FR-6). Carries the memory `id`, the per-channel `scores`, and the
 * `provenance` channel list. The phases up to authorization move these; the gate
 * (007e) hydrates content for the survivors.
 */
export interface Candidate {
	/** The `memories.id` (or graph-node-derived memory id) of the candidate. */
	readonly id: string;
	/** The per-channel calibrated scores (a-AC-5 / FR-8). */
	readonly scores: CandidateScores;
	/** Every channel that surfaced this id (a-AC-7 / FR-8). Deduped, order = first-seen. */
	readonly provenance: RecallChannel[];
}

/**
 * The merged candidate pool — collection's output and the inter-phase hand-off
 * (AC-1). A `Candidate` per memory id, plus the `degraded` flag surfacing whether
 * the vector channel was skipped and recall ran lexical-only (a-AC-3 / the silent
 * BM25 fallback signal). Phases narrow/re-score and return a pool of the same
 * shape.
 */
export interface MergedPool {
	/** The merged candidates, IDs only, ordered by the merge's strongest-score rule. */
	readonly candidates: Candidate[];
	/** True when the vector channel was skipped (embed off/unreachable) → lexical-only (a-AC-3). */
	readonly degraded: boolean;
}

/**
 * The agent read policy that drives the authorization clause (007c FR-3 / D-7).
 * Mirrors the catalog's `AgentReadPolicy` ({isolated, shared, group}); restated
 * here so the recall contract surface is self-contained and a phase imports one
 * recall module, not the storage catalog, for the policy token.
 */
export const RECALL_READ_POLICIES = Object.freeze(["isolated", "shared", "group"] as const);
/** One recall read policy. */
export type RecallReadPolicy = (typeof RECALL_READ_POLICIES)[number];

/**
 * The caller filters the authorization re-query applies WITHIN the authorized set
 * (007c FR-4). All optional; an absent filter is not applied. Shared here so the
 * engine harness threads them and 007c consumes them in the same authorized
 * re-query (never an unscoped pre-filter).
 */
export interface CallerFilters {
	/** Restrict to a memory `type`. */
	readonly type?: string;
	/** Restrict to memories carrying this tag. */
	readonly tag?: string;
	/** Restrict to a project. */
	readonly project?: string;
	/** Restrict to pinned memories only. */
	readonly pinned?: boolean;
	/** Minimum importance (0..1). */
	readonly minImportance?: number;
	/** ISO lower bound on `created_at`. */
	readonly createdAfter?: string;
	/** ISO upper bound on `created_at`. */
	readonly createdBefore?: string;
}

/**
 * The scope envelope a recall request carries (a-AC... FR-9 / 007c FR-1). The
 * org/workspace partition rides the storage `QueryScope` (storage-layer
 * isolation); the within-workspace identity is `agentId` + the resolved
 * `readPolicy`/`policyGroup` that feed the {@link ScopeClause} builder. Every
 * channel runs within this partition; collection MUST NOT cross a workspace
 * boundary even though the read-policy clause is applied later in 007c.
 */
export interface RecallScope {
	/** The org the request is scoped to (rides the storage `QueryScope.org`). */
	readonly org: string;
	/** The workspace/partition (rides the storage `QueryScope.workspace`). */
	readonly workspace: string;
	/** The within-workspace agent id (the engine table's `agent_id` scope column). */
	readonly agentId: string;
	/** The agent's resolved read policy (007c / D-7). */
	readonly readPolicy: RecallReadPolicy;
	/** The agent's policy group (only meaningful for `group`; blank otherwise). */
	readonly policyGroup: string;
}

/**
 * A recall request as it enters the engine (a-AC-6 / FR-1 / FR-2). The raw NL
 * `query` is preserved UNMODIFIED for the vector/model paths; collection derives a
 * separately-escaped lexical expression from it for the FTS/lexical paths. The
 * `scope` and optional caller `filters` flow through to authorization.
 */
export interface RecallQuery {
	/** The original natural-language query, preserved verbatim for the vector path (a-AC-6 / FR-2). */
	readonly query: string;
	/** The scope envelope (partition + read policy). */
	readonly scope: RecallScope;
	/** Optional caller filters applied within the authorized re-query (007c FR-4). */
	readonly filters?: CallerFilters;
	/** Per-request limit on primary results the gate hydrates (007e e-AC-4). Optional. */
	readonly limit?: number;
}

/**
 * The authorized scope context a content-bearing phase reuses. The
 * {@link ScopeClause} is the compiled read-policy WHERE fragment (the auth
 * chokepoint, 007c); the gate (007e) re-applies it when hydrating so the
 * content-load is itself scope-checked (e-AC-4). Carried on the pool's hand-off so
 * a downstream phase never rebuilds the clause from raw inputs.
 */
export interface AuthorizedContext {
	/** The compiled read-policy clause every authorized re-query carries. */
	readonly clause: ScopeClause;
	/** The scope envelope the clause was built from. */
	readonly scope: RecallScope;
}

/**
 * Merge a set of single-channel scored ids into a {@link MergedPool} (a-AC-5 /
 * FR-8). Each input is `{ channel, ids }` where `ids` is `{ id, score }[]` from
 * one channel. Merge is by memory id: a candidate's per-channel score is the
 * STRONGEST value that channel reported for the id (a channel should not report an
 * id twice, but strongest-wins is the safe rule); its provenance is the union of
 * every channel that surfaced it, in first-seen order.
 *
 * The merged candidates are ordered by their best single calibrated score
 * descending (ties broken by id, for determinism) — "strongest calibrated score
 * winning unless blended". Blending is a downstream shaping concern (007d); the
 * merge keeps the raw per-channel evidence intact so shaping can convolve it.
 *
 * Pure. The `degraded` flag is passed through from collection (whether the vector
 * channel ran), not derived here.
 */
export function mergeChannels(
	inputs: readonly { readonly channel: RecallChannel; readonly ids: readonly { readonly id: string; readonly score: number }[] }[],
	degraded: boolean,
): MergedPool {
	// id → mutable accumulator (scores + provenance, preserving first-seen order).
	const byId = new Map<string, { scores: Record<string, number>; provenance: RecallChannel[] }>();

	for (const input of inputs) {
		for (const { id, score } of input.ids) {
			if (id === "") continue; // a blank id is never a real candidate.
			const clamped = Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0;
			let acc = byId.get(id);
			if (acc === undefined) {
				acc = { scores: {}, provenance: [] };
				byId.set(id, acc);
			}
			// Strongest-wins within a channel.
			const prior = acc.scores[input.channel];
			acc.scores[input.channel] = prior === undefined ? clamped : Math.max(prior, clamped);
			if (!acc.provenance.includes(input.channel)) acc.provenance.push(input.channel);
		}
	}

	const candidates: Candidate[] = [...byId.entries()]
		.map(([id, acc]) => ({ id, scores: acc.scores as CandidateScores, provenance: acc.provenance }))
		.sort((a, b) => {
			const bestA = bestScore(a.scores);
			const bestB = bestScore(b.scores);
			return bestB !== bestA ? bestB - bestA : a.id.localeCompare(b.id);
		});

	return { candidates, degraded };
}

/** The strongest single per-channel calibrated score on a candidate (the merge sort key). */
export function bestScore(scores: CandidateScores): number {
	const values = Object.values(scores).filter((v): v is number => typeof v === "number");
	return values.length === 0 ? 0 : Math.max(...values);
}

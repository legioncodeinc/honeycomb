/**
 * The recall engine harness — PRD-007 Wave 1.
 *
 * Orchestrates the five recall phases in order:
 *
 *   collect (007a, FILLED) → traverse (007b stub) → authorize (007c stub) →
 *   shape (007d stub) → gate (007e stub)
 *
 * The phases are INJECTED (the proven PRD-006 stage-worker pattern): the engine
 * holds a phase map, defaulting every Wave-2 phase to its no-op. A Wave-2 Bee fills
 * one phase module and passes it to {@link createRecallEngine} — the harness wiring
 * here does not change. 007a (collection) is filled in Wave 1.
 *
 * ── The data flow (contracts.ts shapes) ─────────────────────────────────────
 *   - collect → a {@link import("./contracts.js").MergedPool} (IDs only, per-channel
 *     scores + provenance, the `degraded` silent-fallback flag).
 *   - traverse → the traversal {@link ChannelResult}, MERGED into the pool (still
 *     IDs only). Up to here, wide-net channels produce IDs; nothing is authorized.
 *   - authorize → an {@link import("./authorization.js").AuthorizedPool}: the
 *     surviving IDs + the compiled scope clause. THE boundary — only IDs move up to
 *     and through here (AC-1 / 007c FR-6).
 *   - shape → a {@link import("./shaping.js").ShapedPool}: calibrated, ranked,
 *     still authorized (d-AC-7).
 *   - gate → a {@link import("./gate.js").RecallResult}: injected-or-empty, the
 *     hydrated primary results (content loaded ONLY here, under the scope clause).
 *
 * ── Construction seam ───────────────────────────────────────────────────────
 * CONSTRUCTED-AND-TESTED, not auto-started by the bootstrap (consistent with how
 * PRD-004/005/006 defer real-service assembly to the CLI / a later daemon-assembly
 * step). A test (or the eventual assembly module) builds the engine with a
 * storage client, embed client, config, and the filled phases, then calls
 * {@link RecallEngine.recall}.
 *
 * ── No-touch (CONVENTIONS §shared) ──────────────────────────────────────────
 * `engine.ts`, `contracts.ts`, `scope-clause.ts`, `config.ts` are the Wave-1
 * shared surface. A Wave-2 phase fills its OWN module + test and is injected here
 * by name; it does NOT edit this file.
 */

import type { StorageQuery } from "../../storage/client.js";
import type { EmbedClient } from "../services/embed-client.js";
import type { RecallConfig } from "./config.js";
import type { MergedPool, RecallChannel, RecallQuery } from "./contracts.js";
import { mergeChannels } from "./contracts.js";
import { collectCandidates, type CollectionDeps } from "./collection.js";
import { type AuthorizationPhase, noopAuthorizationPhase } from "./authorization.js";
import { type GatePhase, noopGatePhase, type RecallResult } from "./gate.js";
import { type ShapingPhase, noopShapingPhase } from "./shaping.js";
import { type TraversalPhase, noopTraversalPhase } from "./traversal.js";

/** A minimal structured-log sink the engine + phases use (degrade, timeout…). */
export interface RecallLogger {
	/** Record a structured event (e.g. `recall.collect_degraded`). */
	event(name: string, fields?: Record<string, unknown>): void;
}

/**
 * The deps EVERY phase receives. Storage (never a raw fetch — `audit:sql` scans
 * `src/daemon`), the org/workspace partition the storage queries run under (the
 * OUTER scope ring), the resolved recall config (every knob), the optional embed
 * client (the vector channel's query-vector seam; absent/null → lexical degrade),
 * and an optional logger.
 */
export interface RecallPhaseDeps {
	/** Run every query through this — never a raw fetch. */
	readonly storage: StorageQuery;
	/** The resolved `{ org, workspace }` partition (the storage-layer outer scope ring). */
	readonly scope: { readonly org: string; readonly workspace?: string };
	/** The resolved recall config (D-1..D-6 knobs). */
	readonly config: RecallConfig;
	/** The query-vector embed seam (005b). Absent/null → vector channel skipped (a-AC-3). */
	readonly embed?: EmbedClient;
	/** Optional structured-log sink. */
	readonly logger?: RecallLogger;
}

/**
 * One channel's scored memory IDs (no content) — the shape collection and
 * traversal emit per channel for the merge (a-AC-7). Mirrors the storage layer's
 * `ScoredId` but tagged with the channel that produced it.
 */
export interface ChannelResult {
	/** The channel that produced these ids. */
	readonly channel: RecallChannel;
	/** The scored memory ids (IDs only, no content). */
	readonly ids: readonly { readonly id: string; readonly score: number }[];
	/** True iff a graph walk timed out and returned partial ids (007b / b-AC-6). Optional. */
	readonly timedOut?: boolean;
}

/** The injectable phase set (007a filled inline; b/c/d/e default to their no-ops). */
export interface RecallPhases {
	/** Graph traversal (007b). Defaults to {@link noopTraversalPhase}. */
	readonly traversal?: TraversalPhase;
	/** Authorization boundary (007c). Defaults to {@link noopAuthorizationPhase}. */
	readonly authorization?: AuthorizationPhase;
	/** Shaping (007d). Defaults to {@link noopShapingPhase}. */
	readonly shaping?: ShapingPhase;
	/** Confidence gate (007e). Defaults to {@link noopGatePhase}. */
	readonly gate?: GatePhase;
}

/** Construction deps for {@link createRecallEngine}. */
export interface RecallEngineDeps extends RecallPhaseDeps {
	/** The injectable phases (Wave-2 fills; defaults to the no-ops). */
	readonly phases?: RecallPhases;
}

/**
 * The recall engine: runs collect → traverse → authorize → shape → gate for one
 * {@link RecallQuery}, returning the terminal {@link RecallResult}. The phases are
 * resolved once at construction (filled or no-op).
 */
export class RecallEngine {
	private readonly traversal: TraversalPhase;
	private readonly authorization: AuthorizationPhase;
	private readonly shaping: ShapingPhase;
	private readonly gate: GatePhase;

	constructor(private readonly deps: RecallEngineDeps) {
		this.traversal = deps.phases?.traversal ?? noopTraversalPhase;
		this.authorization = deps.phases?.authorization ?? noopAuthorizationPhase;
		this.shaping = deps.phases?.shaping ?? noopShapingPhase;
		this.gate = deps.phases?.gate ?? noopGatePhase;
	}

	/** The deps every phase receives (storage/scope/config/embed/logger). */
	private phaseDeps(): RecallPhaseDeps {
		return {
			storage: this.deps.storage,
			scope: this.deps.scope,
			config: this.deps.config,
			embed: this.deps.embed,
			logger: this.deps.logger,
		};
	}

	/**
	 * Run the five-phase recall for one query.
	 *
	 * 1. COLLECT (007a): the merged candidate pool (FTS + vector + hints), IDs only.
	 * 2. TRAVERSE (007b): the graph channel's ids, MERGED into the pool (still IDs
	 *    only). The no-op default contributes nothing — graph-disabled behavior.
	 * 3. AUTHORIZE (007c): re-query with the full scope; only survivors proceed. THE
	 *    boundary — IDs only up to and through here.
	 * 4. SHAPE (007d): calibrate + rank the authorized set.
	 * 5. GATE (007e): inject above the minimum, else an empty (valid) answer.
	 */
	async recall(query: RecallQuery): Promise<RecallResult> {
		const phaseDeps = this.phaseDeps();

		// 1. Collect (007a, filled).
		const collected = await collectCandidates(query, this.collectionDeps());

		// 2. Traverse (007b) and merge its channel into the pool — still IDs only.
		const traversal = await this.traversal(query, phaseDeps);
		const pool = mergeTraversal(collected, traversal);

		// 3. Authorize (007c) — the boundary.
		const authorized = await this.authorization(pool, query, phaseDeps);

		// 4. Shape (007d).
		const shaped = await this.shaping(authorized, query, phaseDeps);

		// 5. Gate (007e).
		return this.gate(shaped, query, phaseDeps);
	}

	/** Collection's deps (a superset of the phase deps with the embed client required-shaped). */
	private collectionDeps(): CollectionDeps {
		return {
			storage: this.deps.storage,
			scope: this.deps.scope,
			config: this.deps.config,
			embed: this.deps.embed,
			logger: this.deps.logger,
		};
	}
}

/**
 * Merge the traversal channel's ids into the collected pool (IDs only, a-AC-5).
 * Re-runs the channel merge so a candidate already found by FTS/vector/hint gains
 * the `traversal` provenance + score rather than appearing twice.
 */
function mergeTraversal(pool: MergedPool, traversal: ChannelResult): MergedPool {
	if (traversal.ids.length === 0) return pool;
	// Reconstruct the channel inputs from the existing pool + the traversal channel,
	// then re-merge so provenance/strongest-score stay correct across the union.
	const existing: { channel: RecallChannel; ids: { id: string; score: number }[] }[] = [];
	const channels: RecallChannel[] = ["fts", "vector", "hint", "structured"];
	for (const ch of channels) {
		const ids = pool.candidates
			.filter((c) => c.scores[ch] !== undefined)
			.map((c) => ({ id: c.id, score: c.scores[ch] as number }));
		if (ids.length > 0) existing.push({ channel: ch, ids });
	}
	existing.push({ channel: "traversal", ids: traversal.ids.map((x) => ({ id: x.id, score: x.score })) });
	return mergeChannels(existing, pool.degraded);
}

/** Build a {@link RecallEngine} with the given deps + (optional) filled phases. */
export function createRecallEngine(deps: RecallEngineDeps): RecallEngine {
	return new RecallEngine(deps);
}

export type { RecallResult } from "./gate.js";
export { mergeChannels } from "./contracts.js";

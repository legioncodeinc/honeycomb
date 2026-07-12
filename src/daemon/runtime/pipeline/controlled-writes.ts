/**
 * Controlled-writes stage — PRD-006c (Wave 2 — `deeplake-dataset-worker-bee`).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE ONLY STAGE THAT MUTATES `memories`. Everything upstream proposes; this
 * stage is the single chokepoint where pipeline intent becomes durable state.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * WHAT IT CONSUMES: a {@link Proposal} (from 006b) on the job payload, plus the
 * fact's content/normalized-content/confidence (the material an ADD writes).
 *
 * WHAT IT BUILDS (006c c-AC-1..6 / FR-1..11):
 *   - c-AC-1 (FR-3/FR-4/FR-5): an ADD is applied only if fact confidence clears
 *     `minFactConfidenceForWrite` (0.7, D-1) AND normalized content is non-empty
 *     AND the SHA-256 `content_hash` is NOT already present (SELECT-before-INSERT
 *     via {@link buildDedupCheckSql}).
 *   - c-AC-2 (FR-5): an ADD whose `content_hash` already exists → return the
 *     existing memory id, NO duplicate INSERT.
 *   - c-AC-3 (FR-6/FR-7): an UPDATE/DELETE runs a contradiction check (D-7:
 *     negation/antonym token set + lexical-overlap heuristic), is ALWAYS flagged
 *     for review, and is applied ONLY when `autonomous.allowUpdateDelete` is set —
 *     as an append-only **version-bumped** write ({@link appendVersionBumped}),
 *     never an in-place UPDATE (DeepLake coalesces UPDATEs and can drop one).
 *   - c-AC-4 (FR-8): under `shadowMode` → write NOTHING (history-only is 006b's
 *     job; this stage simply does not mutate `memories`).
 *   - c-AC-5 (FR-9): under `mutationsFrozen` → write NOTHING even if shadow is off.
 *     Frozen SUPERSEDES shadow (frozen is checked FIRST).
 *   - c-AC-6 (FR-2): the memory's embedding is PREFETCHED via the injected 005b
 *     {@link EmbedClient} BEFORE the write, so no network call happens during the
 *     commit (the dedup-check → INSERT window is embed-call-free).
 *
 * HOW IT REACHES THINGS (CONVENTIONS §3):
 *   - storage: an injected {@link StorageQuery} + per-job {@link QueryScope}; every
 *     statement is built with the `writes.ts` primitives + the SQL-safety helpers,
 *     never a raw fetch or a hand-quoted value (`audit:sql` scans `src/daemon`).
 *   - dedup/hash: {@link contentHash} + {@link buildDedupCheckSql} from the catalog.
 *   - embed:   the 005b {@link EmbedClient} seam — `embed(text)` → 768-dim vector
 *     or `null` (disabled/unreachable/wrong-dim → write the row with the embedding
 *     column NULL, exactly the capture path's degrade).
 *   - config:  `minFactConfidenceForWrite`, `shadowMode`, `mutationsFrozen`,
 *     `autonomous.allowUpdateDelete`. Scope (org/workspace/agent) is on `job.scope`.
 *
 * ── Version column on `memories` (a deliberate, in-scope HealTarget widening) ──
 * The catalog records `memories` as `update-or-insert` with NO `version` column
 * (PRD-003a). PRD-006c / D-7, however, require UPDATE/DELETE to land as
 * append-only version-bumped writes — which append a `version` column. Rather than
 * edit the shared catalog (forbidden — PRD-003 is another wave's file), this stage
 * composes its version-bumped {@link HealTarget} from the single-sourced
 * {@link MEMORIES_COLUMNS} PLUS a locally-declared `version` ColumnDef
 * (`BIGINT NOT NULL DEFAULT 1`). The heal engine therefore sees `version` in the
 * diff and `ALTER TABLE … ADD COLUMN version …` lazily on the first version-bumped
 * write — the same self-healing the rest of the data layer relies on. The base
 * columns stay single-sourced (we spread, never retype). This seam tension between
 * PRD-003a's pattern and PRD-006c's requirement is flagged in the run report.
 *
 * This module exports the testable core {@link applyControlledWrite} (proposal +
 * fact material + deps → a typed {@link ControlledWriteOutcome}) AND the
 * {@link createControlledWriteHandler} that adapts it to the {@link StageHandler}
 * the worker routes. Keep the export names {@link noopControlledWriteHandler} +
 * {@link createControlledWriteHandler}.
 */

import { type Proposal, parseProposal } from "./contracts.js";
import { type PipelineConfig } from "./config.js";
import type { StageHandler, StageJob } from "./stage-worker.js";
import type { MemoryOutboxSink } from "./memory-outbox.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isTransientResult } from "../../storage/client.js";
import type { HealTarget } from "../../storage/heal.js";
import { classifyFailure } from "../../storage/heal.js";
import { isOk, type QueryResult, type StorageRow } from "../../storage/result.js";
import {
	appendOnlyInsertMany,
	appendVersionBumped,
	type ColumnValue,
	type RowValues,
	val,
} from "../../storage/writes.js";
import {
	buildDedupCheckManySql,
	buildDedupCheckSql,
	contentHash,
	MEMORIES_COLUMNS,
	NOT_SOFT_DELETED,
	SOFT_DELETED,
	UNSORTED_PROJECT_ID,
} from "../../storage/catalog/index.js";
import { type ColumnDef } from "../../storage/schema.js";
import { EMBEDDING_DIMS, serializeFloat4Array } from "../../storage/vector.js";
import type { EmbedClient } from "../services/embed-client.js";
import { deriveDurableKey } from "../summaries/key.js";

/** A minimal structured-log sink for controlled-write events (flagged/skipped/etc). */
export interface ControlledWriteLogger {
	/** Record a structured event (e.g. `controlled_write.flagged_for_review`). */
	event(name: string, fields?: Record<string, unknown>): void;
}

/**
 * One candidate the decision stage already fetched per extracted fact (PRD-058b: detection runs
 * over "the candidate set the decision stage already fetches" — NO new table scan). Forwarded on
 * the `memory_controlled_write` job payload from `decisionFanOut`, so the post-commit conflict hook
 * runs the detector against the SAME small candidate set the decision model saw, never a fresh scan.
 */
export interface ControlledWriteCandidate {
	/** The candidate memory's durable `memories.id`. */
	readonly id: string;
	/** The candidate's claim text (its `content`) the detector's `sim`/`opp` signals run over. */
	readonly content: string;
}

/**
 * The post-commit CONFLICT-DETECTION seam (PRD-058b live wiring). After a controlled write LANDS a
 * fact (an `inserted` ADD or a `version_bumped` UPDATE), the handler calls this with the just-committed
 * memory `{id, content}` + the candidate set the decision stage forwarded, so detection runs over those
 * candidates and PROJECTS any flagged pair into `memory_conflicts` (+ appends `memory_history`).
 *
 * A PLAIN callback type — controlled-writes does NOT import the detector (that would invert the
 * `memories → pipeline` dependency arrow + cycle through `store.ts`). The real hook is built on the
 * `memories` side ({@link import("../memories/conflict-hook.js").createControlledWriteConflictHook})
 * and injected here, exactly as `onOutcome` injects the graph-persist fan-out.
 *
 * CONTRACT (the invariants C-1 mandates): the hook runs AFTER the write is committed and OFF its
 * critical section, and it MUST be fail-soft — a slow/failing model judge or a missing `memory_conflicts`
 * table can NEVER throw into the write or cost the user a memory. The handler wraps the call in a
 * try/catch as defense-in-depth, but the hook itself owns the fail-soft + append-only + poll-to-convergence
 * discipline (it reuses {@link import("../memories/conflict-resolve.js").detectAndProject}, which is
 * fail-soft by construction).
 */
export interface ControlledWriteConflictHook {
	/**
	 * Detect conflicts between the just-committed memory and its candidate set, projecting any flagged
	 * pair into `memory_conflicts`. Never throws (fail-soft); the return value is advisory (test-observable).
	 */
	detect(
		committed: { readonly id: string; readonly content: string; readonly arm?: "memory" | "session" },
		candidates: readonly ControlledWriteCandidate[],
		scope: QueryScope,
	): Promise<{ readonly projectedIds: readonly string[] }>;
}

/** A no-op logger (default when the daemon does not inject one). */
const silentLogger: ControlledWriteLogger = { event(): void {} };

/**
 * The payload key a BATCHED `memory_controlled_write` job carries its per-fact proposals
 * under (PRD-062d / L-D1). When `decisionFanOut` runs with `HONEYCOMB_FANOUT_BATCH` ON it
 * emits ONE job whose payload is `{ <scope envelope>, [CONTROLLED_WRITE_BATCH_KEY]: [<per-fact
 * payload>, …] }`; the handler detects this key and processes each fact with its OWN
 * append/version-bumped write (AC-62d.1.2 — the batch is a DISPATCH coalescing, never a row
 * coalescing: distinct memories are NEVER merged into one row and NO in-place UPDATE is
 * introduced). A payload WITHOUT this key is the legacy single-proposal shape (batch OFF, or
 * the explicit `/api/memories` store) and is processed exactly as before.
 */
export const CONTROLLED_WRITE_BATCH_KEY = "proposals" as const;

/**
 * The version column appended to a `memories` row by the version-bumped UPDATE /
 * DELETE path. It is NOT in the catalog's `MEMORIES_COLUMNS` (PRD-003a records
 * `memories` as update-or-insert); this stage composes it into the HealTarget so
 * the heal engine adds it lazily on the first version-bumped write. `BIGINT NOT
 * NULL DEFAULT 1` so the column heals onto a populated table and the first
 * appended version of a memory is 1 (mirrors `memory_jobs.version`).
 */
export const MEMORIES_VERSION_COLUMN: ColumnDef = Object.freeze({
	name: "version",
	sql: "BIGINT NOT NULL DEFAULT 1",
});

/** The `memories` HealTarget the version-bumped UPDATE/DELETE path writes through. */
const MEMORIES_VERSIONED_TARGET: HealTarget = Object.freeze({
	table: "memories",
	columns: Object.freeze([...MEMORIES_COLUMNS, MEMORIES_VERSION_COLUMN]),
});

/** What the controlled-write stage decided to do for one proposal. */
export type ControlledWriteAction =
	| "inserted" // a new memory row was written (ADD)
	| "deduped" // an ADD whose content hash already existed → existing id returned
	| "version_bumped" // an UPDATE/DELETE applied as an append-only version bump
	| "flagged_not_applied" // an UPDATE/DELETE flagged but not applied (autonomous off)
	| "deferred" // PRD-080a: a TRANSIENT commit failure routed the resolved write to the durable memory outbox
	| "skipped"; // gate rejected, or shadow/frozen, or action `none`

/** The typed result of applying one controlled write. No throw on a gate rejection. */
export interface ControlledWriteOutcome {
	/** What the stage did. */
	readonly action: ControlledWriteAction;
	/**
	 * The `memories.id` the outcome concerns: the new id on an insert, the existing
	 * id on a dedup hit (c-AC-2), the target id on a version-bumped update/delete, or
	 * `undefined` when nothing was touched.
	 */
	readonly memoryId?: string;
	/** True when an UPDATE/DELETE tripped the contradiction heuristic (D-7). */
	readonly contradiction?: boolean;
	/** A short human-readable reason for a skip / flag, for logs + tests. */
	readonly reason?: string;
}

/** The fact material a controlled write needs beyond the {@link Proposal}. */
export interface ControlledWriteInput {
	/** The decision proposal (006b output): action + targetId + confidence + reason. */
	readonly proposal: Proposal;
	/** The fact's display content (the `content` column on an insert). */
	readonly content: string;
	/**
	 * The normalized content the SHA-256 dedup hash is computed over (FR-5). The
	 * non-empty gate (FR-4) is checked against this. Defaults to `content` when the
	 * caller does not pre-normalize.
	 */
	readonly normalizedContent: string;
	/** The fact's own confidence — the value the ADD gate compares to the threshold (c-AC-1). */
	readonly factConfidence: number;
	/** The fact `type` (the `type` column); defaults to `'fact'` when absent. */
	readonly factType?: string;
	/**
	 * The `agent_id` the memory is scoped to (FR-11). `memories` is an `agent`-scoped
	 * engine table (PRD-003a D-2): org/workspace isolation is the storage partition's
	 * job (the {@link QueryScope}), and the row carries `agent_id`. Defaults to the
	 * catalog default `'default'` when absent.
	 */
	readonly agentId?: string;
	/**
	 * PRD-049b (49b-AC-1): the RESOLVED `project_id` the distilled memory row is segmented by
	 * (049a `resolveScope(cwd)`). The autonomous extraction path threads the capturing session's
	 * resolved project; the explicit `/api/memories` store path threads the request's. ABSENT →
	 * the `__unsorted__` inbox (never mis-attributed to a real project), mirroring how `agentId`
	 * defaults to `'default'` rather than failing closed on write. The scope clause segments recall
	 * on this column (49b-AC-2); `project` (the raw cwd path, D5) is unaffected.
	 */
	readonly projectId?: string;
	/**
	 * PRD-058b LIVE wiring (C-1): the existing-candidate set the decision stage already fetched for
	 * this fact (forwarded on the job payload from `decisionFanOut`). The post-commit conflict hook
	 * ({@link ControlledWriteConflictHook}) runs detection over THIS set against the just-committed
	 * memory — NO new table scan (PRD-058b: "call the detector on the existing candidate set"). ABSENT
	 * / empty → nothing to detect against (e.g. the deliberate `/api/memories` store, or a novel fact
	 * with zero candidates), so the hook is a no-op — never a failure.
	 */
	readonly candidates?: readonly ControlledWriteCandidate[];
}

/** Construction deps for {@link createControlledWriteHandler} + {@link applyControlledWrite}. */
export interface ControlledWriteHandlerDeps {
	/** The DeepLake storage client (daemon-only). Every write goes through this. */
	readonly storage: StorageQuery;
	/** The resolved pipeline config (gates: confidence, shadow, frozen, autonomous). */
	readonly config: PipelineConfig;
	/** The 005b embed seam — prefetch the vector BEFORE the write (c-AC-6). */
	readonly embed: EmbedClient;
	/** A clock for `created_at` / `updated_at`; defaults to `Date.now`-backed ISO. */
	readonly now?: () => Date;
	/** Optional structured-log sink. */
	readonly logger?: ControlledWriteLogger;
	/**
	 * An id generator for new memory rows (ADD). Defaults to {@link defaultMemoryId}.
	 * Injected so a test asserts the exact inserted id.
	 */
	readonly newId?: () => string;
	/**
	 * Where controlled-writes hands its outcome to the next stage (006d graph-persist).
	 * The daemon wires this to enqueue a `memory_graph_persist` job carrying the
	 * committed `memoryId` + the extraction triples (the fan-out seam) so entity edges
	 * link to the just-written memory; a test injects a recorder. Optional: when absent
	 * the stage applies the write but does not fan out (the Wave-1 inert posture).
	 */
	readonly onOutcome?: (job: StageJob, outcome: ControlledWriteOutcome) => Promise<void> | void;
	/**
	 * PRD-058b LIVE wiring (C-1): the post-commit conflict-detection hook. When present AND a write
	 * actually LANDED a fact (`inserted` / `version_bumped`), the handler runs detection over the
	 * candidate set the decision stage forwarded (NOT a new scan) and projects any flagged pair into
	 * `memory_conflicts`. Optional: ABSENT → no detection runs (the prior inert posture, so a test or
	 * the explicit user store path that does not inject it is unchanged). Fail-soft by contract (see
	 * {@link ControlledWriteConflictHook}); the handler additionally guards the call so a hook failure
	 * NEVER throws into — or replays — the committed write.
	 */
	readonly onConflict?: ControlledWriteConflictHook;
	/**
	 * PRD-080a (a-AC-1 / D-2): the durable controlled-write outbox. When a commit fails TRANSIENTLY
	 * (`isTransientResult` — 5xx/429/timeout/connection, a DeepLake degraded window) at EITHER the
	 * dedup-probe branch OR the version-bumped INSERT branch, the resolved write (`{ action, row, scope }`)
	 * is ENQUEUED here and the stage returns a `deferred` action instead of throwing — so the
	 * `memory_controlled_write` job ACKs and does NOT burn its 5 attempts; the outbox's background drainer
	 * owns the retry once the backend recovers. A GENUINE (non-transient) failure STILL throws (the safety
	 * invariant — never an unguarded duplicate insert). ABSENT (unit suite, or the kill-switch off) → the
	 * pre-080 behavior is byte-for-byte unchanged (a transient failure throws exactly as before). FAIL-SOFT
	 * (a-AC-6): an enqueue that persists nothing (or throws) falls back to the pre-080 throw — never a
	 * silently-lost-and-forgotten write.
	 */
	readonly memoryOutbox?: MemoryOutboxSink;
}

// ── D-7 contradiction heuristic ─────────────────────────────────────────────────

/**
 * Negation tokens — words whose presence flips polarity. An UPDATE/DELETE whose
 * proposal reason carries one of these (with lexical overlap to the fact) is a
 * likely contradiction worth flagging (D-7). Lowercased, matched as whole words.
 */
export const NEGATION_TOKENS = Object.freeze([
	"not", "no", "never", "none", "cannot", "can't", "cant", "won't", "wont",
	"isn't", "isnt", "aren't", "arent", "doesn't", "doesnt", "don't", "dont",
	"didn't", "didnt", "wasn't", "wasnt", "without", "stop", "stopped", "remove",
	"removed", "delete", "deleted", "deprecated", "incorrect", "wrong", "false",
]);

/**
 * Antonym pairs — a fact and a proposal asserting opposite poles is a
 * contradiction even without an explicit negation (D-7). Symmetric: each pair is
 * checked both directions.
 */
export const ANTONYM_PAIRS: ReadonlyArray<readonly [string, string]> = Object.freeze([
	["enable", "disable"], ["enabled", "disabled"], ["on", "off"],
	["allow", "deny"], ["allowed", "denied"], ["true", "false"],
	["add", "remove"], ["increase", "decrease"], ["start", "stop"],
	["open", "closed"], ["accept", "reject"], ["include", "exclude"],
	["active", "inactive"], ["valid", "invalid"], ["present", "absent"],
]);

/** Tokenize to lowercase word tokens (alphanumerics), dropping punctuation. Shared with 058b's detector. */
export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9']+/)
		.filter((t) => t.length > 0);
}

/** Jaccard-style lexical overlap ratio over two token sets (0..1). Shared with 058b's detector. */
export function lexicalOverlap(a: readonly string[], b: readonly string[]): number {
	const setA = new Set(a);
	const setB = new Set(b);
	if (setA.size === 0 || setB.size === 0) return 0;
	let shared = 0;
	for (const t of setA) if (setB.has(t)) shared += 1;
	const union = new Set([...setA, ...setB]).size;
	return union === 0 ? 0 : shared / union;
}

/**
 * The D-7 contradiction check: does the UPDATE/DELETE proposal contradict the
 * fact it targets? Pure + deterministic. True when there is meaningful lexical
 * overlap between the fact and the proposal reason AND either a negation token or
 * an antonym-pole flip appears across the two. A DELETE is itself a destructive
 * polarity flip, so it is treated as contradiction-leaning when it overlaps the
 * fact at all. Conservative by design: this FLAGS for review (c-AC-3); it never
 * by itself blocks an otherwise-authorized write.
 */
export function detectContradiction(
	factContent: string,
	proposal: Proposal,
	overlapFloor = 0.1,
): boolean {
	const factTokens = tokenize(factContent);
	const reasonTokens = tokenize(proposal.reason);
	const overlap = lexicalOverlap(factTokens, reasonTokens);

	// A DELETE that references the same subject matter is a polarity flip on its
	// own — flag it when there is any overlap.
	if (proposal.action === "delete" && overlap >= overlapFloor) return true;

	if (overlap < overlapFloor) return false;

	const reasonSet = new Set(reasonTokens);
	const factSet = new Set(factTokens);

	// Negation token present in the proposal reason → contradiction.
	for (const neg of NEGATION_TOKENS) {
		if (reasonSet.has(neg)) return true;
	}

	// Antonym-pole flip: the fact asserts one pole, the proposal the other.
	for (const [x, y] of ANTONYM_PAIRS) {
		if ((factSet.has(x) && reasonSet.has(y)) || (factSet.has(y) && reasonSet.has(x))) {
			return true;
		}
	}
	return false;
}

// ── id + time helpers ────────────────────────────────────────────────────────────

/** Default new-memory id: a time-rooted, collision-resistant opaque string. */
function defaultMemoryId(): string {
	const rand = Math.random().toString(36).slice(2, 10);
	return `mem_${Date.now().toString(36)}_${rand}`;
}

/** ISO-8601 timestamp from the injected clock (or wall-clock). */
function isoNow(now: () => Date): string {
	return now().toISOString();
}

// ── the core ─────────────────────────────────────────────────────────────────────

/**
 * Apply ONE controlled write. The testable core (c-AC-1..6): given the proposal +
 * fact material + a scope, return the typed {@link ControlledWriteOutcome}. The
 * single side effects are the storage writes and an optional embed prefetch.
 *
 * Order of brakes (binding): FROZEN first (c-AC-5, supersedes shadow), then SHADOW
 * (c-AC-4), then route by action. ADD prefetches the embedding BEFORE the
 * dedup-check/INSERT (c-AC-6); UPDATE/DELETE run the contradiction check + flag,
 * then apply only under `autonomous.allowUpdateDelete` as a version bump (c-AC-3).
 */
export async function applyControlledWrite(
	input: ControlledWriteInput,
	scope: QueryScope,
	deps: ControlledWriteHandlerDeps,
): Promise<ControlledWriteOutcome> {
	const logger = deps.logger ?? silentLogger;
	const { proposal } = input;

	// c-AC-5: FROZEN supersedes shadow — checked FIRST. Nothing is written.
	if (deps.config.mutationsFrozen) {
		logger.event("controlled_write.frozen", { action: proposal.action });
		return { action: "skipped", reason: "mutations_frozen" };
	}

	// c-AC-4: SHADOW — proposals are logged (006b records history); this stage
	// writes nothing to `memories`.
	if (deps.config.shadowMode) {
		logger.event("controlled_write.shadow", { action: proposal.action });
		return { action: "skipped", reason: "shadow_mode" };
	}

	switch (proposal.action) {
		case "add":
			return applyAdd(input, scope, deps, logger);
		case "update":
		case "delete":
			return applyUpdateOrDelete(input, scope, deps, logger);
		case "none":
			return { action: "skipped", reason: "action_none" };
	}
}

/**
 * The ADD path (c-AC-1 / c-AC-2 / c-AC-6). Gate by confidence + non-empty
 * normalized content, PREFETCH the embedding, SELECT-before-INSERT dedup on the
 * content hash, and INSERT a new version-1 memory row when the hash is absent.
 */
async function applyAdd(
	input: ControlledWriteInput,
	scope: QueryScope,
	deps: ControlledWriteHandlerDeps,
	logger: ControlledWriteLogger,
): Promise<ControlledWriteOutcome> {
	const normalized = input.normalizedContent;

	// c-AC-1 (FR-3): confidence gate.
	if (input.factConfidence < deps.config.minFactConfidenceForWrite) {
		logger.event("controlled_write.below_confidence", {
			confidence: input.factConfidence,
			threshold: deps.config.minFactConfidenceForWrite,
		});
		return { action: "skipped", reason: "below_confidence" };
	}

	// c-AC-1 (FR-4): non-empty normalized content gate.
	if (normalized.trim() === "") {
		logger.event("controlled_write.empty_content", {});
		return { action: "skipped", reason: "empty_content" };
	}

	const hash = contentHash(normalized);

	// c-AC-6 (FR-2): PREFETCH the embedding BEFORE any storage write, so no network
	// call happens during the dedup-check → INSERT commit window. A null vector
	// (disabled / unreachable / wrong-dim) leaves `content_embedding` NULL.
	const vector = await prefetchEmbedding(input.content, deps, logger);

	// Build the version-1 memory row up front (pure): the write goes through the version-bumped
	// HealTarget so the row carries `version` = 1 and the heal engine adds the `version` column
	// lazily — keeping ADD and UPDATE/DELETE on one row shape, and giving the outbox the SAME
	// resolved row to persist on a transient defer (PRD-080a).
	const id = (deps.newId ?? defaultMemoryId)();
	const now = isoNow(deps.now ?? (() => new Date()));
	const row = buildMemoryRow({
		id,
		input,
		hash,
		vector,
		scope,
		isDeleted: NOT_SOFT_DELETED,
		createdAt: now,
		updatedAt: now,
	});
	const resolved: ResolvedControlledWrite = { action: "add", keyId: id, row, scope };

	// c-AC-1 / c-AC-2 (FR-5): the durable commit — SELECT-before-INSERT dedup then version-bumped
	// append — single-sourced in {@link commitControlledWrite} so the outbox drainer replays the
	// IDENTICAL logic (idempotent via the content hash). It classifies a non-ok outcome transient
	// vs genuine (PRD-080a D-2) and emits the dedup diagnostics through the passed logger.
	const commit = await commitControlledWrite(deps.storage, resolved, logger);
	switch (commit.status) {
		case "deduped":
			// c-AC-2: existing id returned, NO duplicate INSERT (logged inside the commit).
			// PRD-080b (b-AC-3): a clean dedup probe also proves the backend is up — kick a recovery drain.
			kickMemoryOutboxDrain(deps, logger);
			return { action: "deduped", memoryId: commit.memoryId, reason: "hash_present" };
		case "inserted":
		case "version_bumped":
			logger.event("controlled_write.inserted", { id });
			// PRD-080b (b-AC-3): a LANDED commit is the "backend recovered" signal — kick an immediate
			// outbox drain so a degraded-window backlog of deferred writes clears promptly instead of
			// waiting for the 30s interval. Fail-soft + off the critical section (the outcome is unaffected).
			kickMemoryOutboxDrain(deps, logger);
			// PRD-058b LIVE (C-1): the write is COMMITTED. Run conflict detection over the decision
			// stage's forwarded candidate set OFF the critical section + fail-soft. Never throws into it.
			await runConflictHook(id, input.content, input, scope, deps, logger);
			return { action: "inserted", memoryId: id };
		case "transient":
			// PRD-080a (a-AC-1): a DeepLake degraded-window failure at the dedup-probe OR the INSERT →
			// defer the resolved write to the durable outbox (ack the job), else fall back to the pre-080
			// throw when no outbox is wired / the enqueue persisted nothing (a-AC-6).
			return deferOrThrow(resolved, commit.detail, deps, logger);
		case "genuine":
			// Safety invariant (a-AC-2): a non-transient failure STILL throws — never an unguarded
			// duplicate insert, never a deferred ack.
			throw new Error(`controlled-write ${commit.detail}`);
	}
}

/**
 * PRD-058b LIVE wiring (C-1): run the post-commit conflict-detection hook for a just-committed memory.
 * Invoked AFTER the durable write lands (off its critical section). FAIL-SOFT by construction: the hook
 * is wrapped so a slow/failing model judge, a missing `memory_conflicts` table, or any throw degrades to
 * "no conflict detected this write" — it NEVER throws into (and so never replays) the committed write,
 * and never costs the user a memory. A no-op when no hook is wired or no candidates were forwarded
 * (nothing to detect against). The `memory` arm class is stamped: a controlled write lands a DISTILLED
 * `memory`, the high-provenance arm the resolver weights at `PROV_DISTILLED`.
 */
async function runConflictHook(
	committedId: string,
	committedContent: string,
	input: ControlledWriteInput,
	scope: QueryScope,
	deps: ControlledWriteHandlerDeps,
	logger: ControlledWriteLogger,
): Promise<void> {
	const hook = deps.onConflict;
	if (hook === undefined) return;
	const candidates = input.candidates ?? [];
	if (candidates.length === 0) return; // nothing to detect against — the no-candidate short-circuit.
	try {
		const { projectedIds } = await hook.detect({ id: committedId, content: committedContent, arm: "memory" }, candidates, scope);
		if (projectedIds.length > 0) {
			logger.event("controlled_write.conflict_projected", { id: committedId, projected: projectedIds.length });
		}
	} catch (err: unknown) {
		// Defense-in-depth: the hook owns fail-soft, but a hook bug must STILL never break the write.
		const reason = err instanceof Error ? err.message : String(err);
		logger.event("controlled_write.conflict_hook_failed", { id: committedId, reason });
	}
}

/**
 * The UPDATE / DELETE path (c-AC-3). Run the D-7 contradiction check, ALWAYS flag
 * for review, and apply ONLY when `autonomous.allowUpdateDelete` is set — as an
 * append-only version-bumped write (a DELETE bumps a new version with
 * `is_deleted = 1`; an UPDATE bumps a new version with the new content). Never an
 * in-place UPDATE.
 */
async function applyUpdateOrDelete(
	input: ControlledWriteInput,
	scope: QueryScope,
	deps: ControlledWriteHandlerDeps,
	logger: ControlledWriteLogger,
): Promise<ControlledWriteOutcome> {
	const { proposal } = input;
	const targetId = proposal.targetId;
	if (targetId === undefined || targetId === "") {
		logger.event("controlled_write.missing_target", { action: proposal.action });
		return { action: "skipped", reason: "missing_target_id" };
	}

	// D-7: contradiction check — ALWAYS run + ALWAYS flag for review (c-AC-3).
	const contradiction = detectContradiction(input.content, proposal);
	logger.event("controlled_write.flagged_for_review", {
		action: proposal.action,
		targetId,
		contradiction,
	});

	// c-AC-3: applied ONLY under the autonomous gate. Off → flagged, not applied.
	if (!deps.config.autonomous.allowUpdateDelete) {
		return {
			action: "flagged_not_applied",
			memoryId: targetId,
			contradiction,
			reason: "autonomous_disabled",
		};
	}

	const isDelete = proposal.action === "delete";
	const action: ResolvedWriteAction = isDelete ? "delete" : "update";

	// Prefetch the embedding for an UPDATE's new content BEFORE the write (c-AC-6).
	// A DELETE carries no new content to embed.
	const vector = isDelete ? null : await prefetchEmbedding(input.content, deps, logger);

	const now = isoNow(deps.now ?? (() => new Date()));
	const row = buildMemoryRow({
		id: targetId,
		input,
		hash: contentHash(input.normalizedContent),
		vector,
		scope,
		isDeleted: isDelete ? SOFT_DELETED : NOT_SOFT_DELETED,
		createdAt: now,
		updatedAt: now,
	});
	const resolved: ResolvedControlledWrite = { action, keyId: targetId, row, scope };

	// c-AC-3: append-only version-bumped write, never an in-place UPDATE — single-sourced in
	// {@link commitControlledWrite} so the outbox drainer replays the identical version bump.
	const commit = await commitControlledWrite(deps.storage, resolved, logger);
	switch (commit.status) {
		case "version_bumped":
		case "inserted":
		case "deduped":
			logger.event("controlled_write.version_bumped", {
				action: proposal.action,
				targetId,
				...(commit.status === "version_bumped" ? { version: commit.version } : {}),
			});
			// PRD-080b (b-AC-3): a LANDED version-bump is the "backend recovered" signal — kick a drain.
			kickMemoryOutboxDrain(deps, logger);
			// PRD-058b LIVE (C-1): an UPDATE landed NEW content — run conflict detection over the
			// candidate set (off the critical section, fail-soft). A DELETE is a tombstone, so it
			// detects nothing — there is no live content to contradict its candidates.
			if (!isDelete) {
				await runConflictHook(targetId, input.content, input, scope, deps, logger);
			}
			return { action: "version_bumped", memoryId: targetId, contradiction };
		case "transient":
			// PRD-080a (a-AC-1): defer the version-bumped write to the durable outbox, else fall back to
			// the pre-080 throw (a-AC-6).
			return deferOrThrow(resolved, commit.detail, deps, logger);
		case "genuine":
			// Safety invariant (a-AC-2): a non-transient failure STILL throws.
			throw new Error(`controlled-write ${commit.detail}`);
	}
}

// ── durable commit + transient-defer (PRD-080a) ────────────────────────────────────

/** The resolved-write action the outbox persists + the drainer replays (the proposal action). */
export type ResolvedWriteAction = "add" | "update" | "delete";

/**
 * A fully-resolved controlled write: the ALREADY-BUILT `memories` row + its key + scope + action.
 * PRD-080a (D-3): the outbox persists exactly this (the decision already ran), and the drainer replays
 * the durable COMMIT — never the extraction/decision — via {@link commitControlledWrite}.
 */
export interface ResolvedControlledWrite {
	/** The proposal action — `add` runs the dedup-probe-then-append; `update`/`delete` version-bump. */
	readonly action: ResolvedWriteAction;
	/** The `memories.id` key the write lands under (the ADD's new id, or the UPDATE/DELETE target). */
	readonly keyId: string;
	/** The built `memories` row (carries `content_hash` + content + vector) — persisted verbatim + replayed. */
	readonly row: RowValues;
	/** The org/workspace partition the write is issued under. */
	readonly scope: QueryScope;
}

/**
 * The outcome of committing a {@link ResolvedControlledWrite} — the classification the enqueue gate
 * (a-AC-1) and the drainer (a-AC-3) branch on. A non-ok outcome is split into `transient` (route to the
 * outbox / retry) vs `genuine` (throw — the safety invariant, a-AC-2) by the SAME {@link isTransientResult}
 * the storage layer exports (D-2). `detail` carries the failure STAGE + the result `kind` (an enum like
 * `timeout`/`query_error`), plus — for the dedup probe (BUG-04, #293) — the HTTP status and the DeepLake
 * message REDACTED of the probed `content_hash` (`redactProbedHash`), so the thrown/at-rest diagnostic is
 * secret-free yet distinguishes a 402 balance from a 5xx flap from a permission fault.
 */
export type ControlledWriteCommit =
	| { readonly status: "inserted"; readonly memoryId: string; readonly version: number }
	| { readonly status: "deduped"; readonly memoryId: string }
	| { readonly status: "version_bumped"; readonly memoryId: string; readonly version: number }
	| { readonly status: "transient"; readonly detail: string }
	| { readonly status: "genuine"; readonly detail: string };

/**
 * Commit a resolved controlled write to `memories` — the SINGLE-SOURCED durable commit shared by the
 * live stage (applyAdd / applyUpdateOrDelete) AND the outbox drainer (PRD-080a D-3). An ADD runs the
 * SELECT-before-INSERT dedup probe then the version-bumped append (so a memory a prior attempt already
 * landed is `deduped` — idempotent via `content_hash`, NO duplicate INSERT); an UPDATE/DELETE runs the
 * version-bumped append directly. A missing-table/column probe failure heals through the append (not a
 * duplicate). NEVER throws — it returns the typed outcome the caller acts on (defer / throw /
 * delete-from-outbox). The optional `logger` surfaces the same dedup diagnostics the live stage emitted.
 */
export async function commitControlledWrite(
	storage: StorageQuery,
	write: ResolvedControlledWrite,
	logger?: ControlledWriteLogger,
): Promise<ControlledWriteCommit> {
	if (write.action === "add") {
		const probe = await probeDedupForCommit(storage, write, logger);
		if (probe !== null) return probe; // deduped, or a genuine/transient probe failure — done.
	}
	// The version-bumped append (ADD's fresh version 1, or the UPDATE/DELETE bump). NEVER an in-place
	// UPDATE, so two rapid edits both persist and the highest version reads current.
	const { result, version } = await appendVersionBumped(storage, MEMORIES_VERSIONED_TARGET, write.scope, {
		keyColumn: "id",
		keyValue: write.keyId,
		row: write.row,
	});
	if (isOk(result)) {
		return write.action === "add"
			? { status: "inserted", memoryId: write.keyId, version }
			: { status: "version_bumped", memoryId: write.keyId, version };
	}
	const prefix = write.action === "add" ? "insert failed" : `${write.action} failed`;
	return isTransientResult(result)
		? { status: "transient", detail: `${prefix}: ${result.kind}` }
		: { status: "genuine", detail: `${prefix}: ${result.kind}` };
}

/**
 * Run the ADD dedup probe (a-AC-3 idempotency): a `content_hash` hit → `deduped` (no INSERT). A
 * missing-table/column probe failure is NOT a duplicate → `null` so the caller heals via the append.
 * Any OTHER non-ok probe is classified transient vs genuine (a-AC-1 / a-AC-2). `null` also when the
 * probe is clean-but-empty (proceed to the INSERT). Reads the hash off the row so the drainer replays
 * the identical probe.
 */
async function probeDedupForCommit(
	storage: StorageQuery,
	write: ResolvedControlledWrite,
	logger?: ControlledWriteLogger,
): Promise<ControlledWriteCommit | null> {
	const hash = readRowLiteral(write.row, "content_hash");
	if (hash === null) return null; // no hash on the row (never expected) → cannot dedup; heal via INSERT.
	const dedup = await storage.query(buildDedupCheckSql(hash), write.scope);
	if (isOk(dedup) && dedup.rows.length > 0) {
		const existingId = readId(dedup.rows[0]);
		logger?.event("controlled_write.deduped", { id: existingId });
		return { status: "deduped", memoryId: existingId };
	}
	if (isOk(dedup)) return null; // clean, no rows → proceed to the INSERT.
	// Classify with the SAME engine the heal path uses (`classifyFailure`, auth/permission forced to
	// `other` FIRST). A missing table/column trivially holds no duplicate → heal via the INSERT.
	const failure = classifyFailure(dedup.message);
	if (failure === "missing-table" || failure === "missing-column") {
		logger?.event("controlled_write.dedup_probe_table_absent", { kind: dedup.kind, classification: failure });
		return null;
	}
	// BUG-04 (#293): turn the OPAQUE `query_error` the register saw into a diagnosable, SECRET-FREE
	// outcome carrying the HTTP status + the redacted DeepLake message — surfaced in BOTH the structured
	// event AND the `detail` folded into the transient/genuine outcome (the thrown error is persisted
	// at-rest as the queue's `last_error_class`). The probed `content_hash` (a content-derived
	// fingerprint) is stripped by `redactProbedHash` before it reaches either, so the status/text
	// diagnostic is preserved without leaking content.
	const probe = describeProbeFailure(dedup, hash);
	logger?.event("controlled_write.dedup_probe_failed", {
		classification: failure,
		kind: probe.kind,
		...(probe.status !== undefined ? { status: probe.status } : {}),
		transient: isTransientResult(dedup),
		reason: probe.message,
	});
	const statusPart = probe.status !== undefined ? ` status=${probe.status}` : "";
	const detail = `dedup probe failed: ${probe.kind}${statusPart} :: ${probe.message}`;
	return isTransientResult(dedup) ? { status: "transient", detail } : { status: "genuine", detail };
}

/**
 * The per-write outcome of a BATCHED ADD commit (PRD-080c c-AC-2): every input `keyId` lands in EXACTLY
 * one bucket. `committed` = the write LANDED (a fresh multi-row append) OR was ALREADY present (a batched
 * `content_hash` dedup hit — idempotent, no duplicate), so the outbox DELETES the row; `failed` = the
 * batched probe or the multi-row append failed transiently/genuinely this pass, so the outbox backs each
 * off / dead-letters it INDEPENDENTLY (mirrors the capture coalescer's per-member accounting). No `keyId`
 * is ever lost or double-committed.
 */
export interface ControlledWriteCommitManyResult {
	/**
	 * The members whose write LANDED (`inserted`) or was already present (`deduped`) — the drainer deletes
	 * each from the outbox (drained) AND records it to the memory-formation tracker (W-1) with its honest
	 * committed action.
	 */
	readonly committed: readonly ControlledWriteCommittedMember[];
	/** keyIds whose write FAILED this pass — the drainer backs each off / dead-letters it independently. */
	readonly failed: readonly string[];
}

/** One coalesced member that committed — its `memories.id` + the honest committed action (W-1 tracker feed). */
export interface ControlledWriteCommittedMember {
	readonly keyId: string;
	/** The committed action the memory-formation tracker counts (`inserted` fresh append, or `deduped` hit). */
	readonly action: "inserted" | "deduped";
}

/**
 * Commit a COALESCED group of ADD writes (PRD-080c c-AC-2) — the batched twin of {@link commitControlledWrite}
 * that PRESERVES the dedup guarantee under coalescing. The naive alternative (a bare multi-row append) would
 * BYPASS the `content_hash` dedup and risk DUPLICATE memories; instead this runs ONE batched dedup probe
 * ({@link buildDedupCheckManySql}) over the group's hashes, treats every already-landed hash as `deduped`
 * (committed, NO insert — idempotent), and multi-row appends ONLY the not-present rows in ONE version-bumped
 * append. PRECONDITION (enforced by the drainer, never here): every write is an `add` carrying a readable
 * `content_hash`, and the hashes are DISTINCT within the group (an in-group duplicate is NOT provably safe
 * to batch — the drainer keeps such a group on the per-row path). NEVER throws — a probe / append failure is
 * reported as `failed` for the affected keys so the drainer backs them off (never a duplicate, never a lost
 * row). Same single-sourced write primitives + SQL-safety floor as the live stage.
 */
export async function commitControlledWriteMany(
	storage: StorageQuery,
	writes: readonly ResolvedControlledWrite[],
): Promise<ControlledWriteCommitManyResult> {
	if (writes.length === 0) return { committed: [], failed: [] };
	const allIds = writes.map((w) => w.keyId);
	const hashes: string[] = [];
	for (const w of writes) {
		const hash = memoryRowContentHash(w.row);
		if (hash === null) return { committed: [], failed: allIds }; // precondition break → whole group fails (drainer re-runs per-row).
		hashes.push(hash);
	}
	const scope = (writes[0] as ResolvedControlledWrite).scope;
	// c-AC-2: ONE batched dedup probe — which of the group's hashes already landed (idempotent replay)?
	const present = await probeDedupMany(storage, hashes, scope);
	if (present === "failed") return { committed: [], failed: allIds }; // probe transient/genuine → back each off.
	const committed: ControlledWriteCommittedMember[] = [];
	const toInsert: ResolvedControlledWrite[] = [];
	for (let i = 0; i < writes.length; i++) {
		const w = writes[i] as ResolvedControlledWrite;
		// already landed → deduped, NO insert (idempotent); else it becomes a fresh multi-row insert below.
		if (present.has(hashes[i] as string)) committed.push({ keyId: w.keyId, action: "deduped" });
		else toInsert.push(w);
	}
	if (toInsert.length === 0) return { committed, failed: [] };
	// c-AC-2: multi-row VERSION-BUMPED append of the not-present rows. A fresh ADD is version 1 (a unique id
	// has no prior version), so every coalesced row carries `version = 1` — exactly what the per-row
	// `appendVersionBumped` writes for a fresh key. Heal-aware via `appendOnlyInsertMany`.
	const rows: RowValues[] = toInsert.map((w) => [...w.row, ["version", val.num(1)] as const]);
	let landed = false;
	try {
		landed = isOk(await appendOnlyInsertMany(storage, MEMORIES_VERSIONED_TARGET, scope, rows));
	} catch {
		landed = false; // a throwing append is a normal failed attempt (each member backs off), never a pass abort.
	}
	if (landed) {
		for (const w of toInsert) committed.push({ keyId: w.keyId, action: "inserted" });
		return { committed, failed: [] };
	}
	return { committed, failed: toInsert.map((w) => w.keyId) };
}

/**
 * Run the BATCHED dedup probe for {@link commitControlledWriteMany}: return the set of already-present
 * `content_hash`es, or `"failed"` when the probe fails transiently/genuinely (the whole group backs off).
 * A missing-table/column probe is NOT a duplicate → an EMPTY present set (heal via the append), exactly as
 * the per-row {@link probeDedupForCommit} does. Reads the matched hashes off the probe rows.
 */
async function probeDedupMany(
	storage: StorageQuery,
	hashes: readonly string[],
	scope: QueryScope,
): Promise<ReadonlySet<string> | "failed"> {
	try {
		const probe = await storage.query(buildDedupCheckManySql(hashes), scope);
		if (isOk(probe)) {
			const present = new Set<string>();
			for (const row of probe.rows) {
				const value = (row as StorageRow).content_hash;
				if (typeof value === "string" && value.length > 0) present.add(value);
			}
			return present;
		}
		const failure = classifyFailure(probe.message);
		if (failure === "missing-table" || failure === "missing-column") return new Set(); // no dup → heal via the append.
		return "failed"; // transient OR genuine → the drainer backs each member off / dead-letters (never a duplicate).
	} catch {
		// A rejecting transport is a whole-group failed attempt (the drainer backs each member off), never a throw.
		return "failed";
	}
}

/**
 * Read the `content_hash` literal off a built `memories` row (the dedup key). PRD-080c: the coalesced outbox
 * drain reuses this so hash extraction is SINGLE-SOURCED with the per-row commit's {@link readRowLiteral}
 * (the drainer both decides coalescing eligibility on it and feeds it to {@link commitControlledWriteMany}).
 */
export function memoryRowContentHash(row: RowValues): string | null {
	return readRowLiteral(row, "content_hash");
}

/**
 * Read a `literal`/`text`/`raw` string value out of a built row's column (e.g. `content_hash`), or
 * `null` when absent / non-string — so the commit + drainer recover the dedup key from the row.
 */
function readRowLiteral(row: RowValues, column: string): string | null {
	for (const [name, value] of row) {
		if (name !== column) continue;
		if (value.kind === "literal" || value.kind === "text" || value.kind === "raw") {
			return value.value.length > 0 ? value.value : null;
		}
		return null;
	}
	return null;
}

/**
 * PRD-080a (a-AC-1 / a-AC-6): route a TRANSIENT-failed resolved write to the durable outbox and ack the
 * job with a `deferred` outcome, OR fall back to the pre-080 throw. The throw is the fallback for EVERY
 * path that does not durably persist the write: no outbox wired (unit suite / kill-switch off), an
 * enqueue that persisted nothing (`enqueued === 0`), or an outbox that THREW — so a transient failure is
 * NEVER silently lost-and-forgotten (it either lands in the outbox, or fails the job for the queue to
 * retry, exactly as pre-080).
 */
function deferOrThrow(
	write: ResolvedControlledWrite,
	detail: string,
	deps: ControlledWriteHandlerDeps,
	logger: ControlledWriteLogger,
): ControlledWriteOutcome {
	const outbox = deps.memoryOutbox;
	if (outbox !== undefined) {
		try {
			const res = outbox.enqueue(write);
			if (res.enqueued > 0) {
				// The resolved write is durable — ack the job (no throw, no attempt-burn); the outbox drains it.
				logger.event("controlled_write.deferred", { action: write.action });
				return { action: "deferred", memoryId: write.keyId, reason: "transient_deferred" };
			}
		} catch (err: unknown) {
			// a-AC-6: an enqueue fault must NEVER escape as an unhandled rejection — log secret-free and
			// fall through to the pre-080 throw so the write is not silently lost-and-forgotten.
			logger.event("controlled_write.defer_failed", { reason: err instanceof Error ? err.name : "unknown_error" });
		}
	}
	throw new Error(`controlled-write ${detail}`);
}

/**
 * PRD-080b (b-AC-3): kick the durable outbox to drain IMMEDIATELY after a SUCCESSFUL pipeline `memories`
 * commit (the "backend recovered" signal — mirrors the capture handler's `kickOutboxDrain` on append
 * success). The kick is single-flighted + fail-soft inside the outbox; this wrapper is the
 * belt-and-suspenders guard so even a throwing/absent seam never breaks the committed write (the outcome
 * is already decided; the drain is off the critical section). A no-op when no outbox is wired (the unit
 * suite / kill-switch off) or the sink does not implement `kick`. NEVER re-entered by the drainer itself:
 * the drainer replays via {@link commitControlledWrite} directly (not through {@link applyControlledWrite}),
 * so this fires only on the LIVE stage path, never from inside a drain pass.
 */
function kickMemoryOutboxDrain(deps: ControlledWriteHandlerDeps, logger: ControlledWriteLogger): void {
	try {
		deps.memoryOutbox?.kick?.();
	} catch (err: unknown) {
		// A recovery-kick fault must NEVER surface to the committed write — log secret-free, never throw.
		logger.event("controlled_write.kick_failed", { reason: err instanceof Error ? err.name : "unknown_error" });
	}
}

/**
 * Prefetch the embedding vector for `text` via the 005b seam (c-AC-6). Returns the
 * 768-dim vector or `null` (disabled / unreachable / wrong-dim) — a null vector
 * writes the row with `content_embedding` NULL, exactly like the capture path. The
 * seam never throws for the expected failure modes; an unexpected throw is caught
 * here and degraded to null so a flaky embed daemon never fails the write.
 */
async function prefetchEmbedding(
	text: string,
	deps: ControlledWriteHandlerDeps,
	logger: ControlledWriteLogger,
): Promise<readonly number[] | null> {
	try {
		const vector = await deps.embed.embed(text);
		if (vector === null) return null;
		if (vector.length !== EMBEDDING_DIMS) {
			logger.event("controlled_write.embed_dim_rejected", {
				expected: EMBEDDING_DIMS,
				actual: vector.length,
			});
			return null;
		}
		return vector;
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		logger.event("controlled_write.embed_error", { reason });
		return null;
	}
}

/** The inputs assembled into one `memories` row's {@link RowValues}. */
interface MemoryRowArgs {
	readonly id: string;
	readonly input: ControlledWriteInput;
	readonly hash: string;
	readonly vector: readonly number[] | null;
	readonly scope: QueryScope;
	readonly isDeleted: typeof NOT_SOFT_DELETED | typeof SOFT_DELETED;
	readonly createdAt: string;
	readonly updatedAt: string;
}

/**
 * Build the ordered `(column, value)` list for a `memories` row. Every value is a
 * typed {@link ColumnValue} so it is rendered through the SQL-safety helpers by
 * the `writes.ts` primitives — text bodies via `eLiteral`, ids/enums/dates via
 * `sLiteral`, numbers inlined, the vector as the pre-built `serializeFloat4Array`
 * fragment (kind `raw`). Threads the agent scope (FR-11): `agent_id` is the
 * engine-table scope column (PRD-003a D-2); org/workspace isolation is the storage
 * partition's job (the `QueryScope` the write is issued under).
 */
function buildMemoryRow(args: MemoryRowArgs): RowValues {
	const embeddingValue: ColumnValue =
		args.vector === null ? val.raw("NULL") : val.raw(serializeFloat4Array(args.vector));

	return [
		["id", val.str(args.id)],
		["type", val.str(args.input.factType ?? "fact")],
		["content", val.text(args.input.content)],
		// PRD-046b (deferred durable-key generator): populate the DURABLE Tier-1 `key` — a
		// sharp ≤1-sentence, secret-scrubbed, grounded headline derived DETERMINISTICALLY
		// from the fact's content (a durable fact is already distilled, so no second gate
		// pass). A blank derivation lands `''`, and the prime keeps its legacy `content`
		// fallback for that un-keyed row. UPDATE re-derives from the new content; DELETE's
		// empty content yields `''` (a tombstone is never primed anyway, `is_deleted = 1`).
		["key", val.text(deriveDurableKey(args.input.content))],
		["normalized_content", val.text(args.input.normalizedContent)],
		["content_hash", val.str(args.hash)],
		["confidence", val.num(clampConfidence(args.input.factConfidence))],
		["content_embedding", embeddingValue],
		// PRD-049b (49b-AC-1): the resolved project segment. ABSENT → the `__unsorted__` inbox
		// (never mis-attributed to a real project), mirroring the `agent_id` default discipline.
		["project_id", val.str(args.input.projectId ?? UNSORTED_PROJECT_ID)],
		["is_deleted", val.num(args.isDeleted)],
		["agent_id", val.str(args.input.agentId ?? "default")],
		["created_at", val.str(args.createdAt)],
		["updated_at", val.str(args.updatedAt)],
	];
}

/** Clamp a confidence into `[0, 1]` so a stray value never writes an illegal score. */
function clampConfidence(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

/** Read a `memories.id` off a result row, coercing defensively to a string. */
function readId(row: StorageRow): string {
	const raw = row.id;
	return typeof raw === "string" ? raw : String(raw ?? "");
}

/**
 * Extract the diagnostic descriptor from a failed dedup-probe {@link QueryResult} (BUG-04). Every
 * non-ok kind (`query_error`/`connection_error`/`timeout`) carries a `.message`; only a
 * `query_error` carries an HTTP `.status`. The client keeps the token out of the message (it is
 * never interpolated into SQL or errors), but the message ultimately originates from the HTTP
 * transport as `${status}: ${body.slice(0,200)}` (see `storage/transport.ts`) — the RAW DeepLake
 * error body. A statement rejection can echo the offending SQL, and the dedup probe interpolates the
 * SHA-256 `content_hash`, so the body may carry that fingerprint. {@link redactProbedHash} strips it
 * before the message is surfaced. Used to turn the opaque `query_error` the register saw into a
 * diagnosable, secret-free `${kind}${status} :: ${message}`.
 */
function describeProbeFailure(
	result: Exclude<QueryResult, { kind: "ok" }>,
	probedHash: string,
): {
	readonly kind: string;
	readonly status?: number;
	readonly message: string;
} {
	const message = redactProbedHash(result.message, probedHash);
	if (result.kind === "query_error" && result.status !== undefined) {
		return { kind: result.kind, status: result.status, message };
	}
	return { kind: result.kind, message };
}

/**
 * Strip the probed SHA-256 `content_hash` out of a DeepLake error message before it is surfaced in
 * the `controlled_write.dedup_probe_failed` event or folded into the thrown error (whose message is
 * persisted at-rest as the local queue's `last_error_class`).
 *
 * The message originates from the transport as the RAW DeepLake error body (`transport.ts`); on a
 * statement rejection DeepLake can echo the offending SQL verbatim, and the dedup probe interpolates
 * `... WHERE content_hash = '<hash>' ...`. That hash is a one-way fingerprint of normalized memory
 * content, so persisting it to an at-rest log is a content-derived-PII leak. Remove the exact probed
 * value, plus any residual long hex run (SHA-256 material a 200-char truncation may have clipped
 * mid-hash), while preserving the HTTP status, the error class, and the human-readable failure text
 * that make BUG-04's diagnostic worth having (degraded-window `429`/`402`/`5xx` bodies carry no hex
 * and are untouched).
 */
function redactProbedHash(message: string, probedHash: string): string {
	const withoutExact = probedHash.length > 0 ? message.split(probedHash).join("<content_hash>") : message;
	return withoutExact.replace(/[0-9a-f]{16,}/gi, "<hex>");
}

// ── handler wiring ────────────────────────────────────────────────────────────────

/** The shape a controlled-write job's payload carries (besides the scope envelope). */
interface ControlledWritePayload {
	/** The decision proposal (006b output). */
	readonly proposal?: unknown;
	/** The fact's display content. */
	readonly content?: unknown;
	/** The normalized content the hash is computed over (defaults to `content`). */
	readonly normalized_content?: unknown;
	/** The fact's confidence (the ADD gate value). */
	readonly fact_confidence?: unknown;
	/** The fact type (the `type` column). */
	readonly fact_type?: unknown;
	/** The agent the memory is scoped to (FR-11); falls back to the job scope. */
	readonly agent_id?: unknown;
	/** PRD-049b: the resolved project segment carried on the scope envelope (`__unsorted__` default). */
	readonly project_id?: unknown;
	/** PRD-058b LIVE (C-1): the decision-stage candidate set forwarded for post-commit conflict detection. */
	readonly candidates?: unknown;
}

/** Read a string field off a payload defensively ("" when absent / non-string). */
function readString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Read a numeric field off a payload defensively (0 when absent / non-numeric). */
function readNumber(value: unknown): number {
	if (typeof value === "number") return value;
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Project a controlled-write job's payload into a {@link ControlledWriteInput}.
 * Parses the proposal defensively via {@link parseProposal} (drop-invalid, like
 * extraction) — an unparseable proposal yields `null`, and the handler treats it
 * as a no-op skip rather than throwing the job.
 */
export function readControlledWriteInput(payload: Record<string, unknown>): ControlledWriteInput | null {
	const p = payload as ControlledWritePayload;
	const proposal = parseProposal(p.proposal);
	if (proposal === null) return null;
	const content = readString(p.content);
	const normalized = readString(p.normalized_content) || content;
	const candidates = readCandidates(p.candidates);
	return {
		proposal,
		content,
		normalizedContent: normalized,
		factConfidence: readNumber(p.fact_confidence),
		factType: readString(p.fact_type) || undefined,
		agentId: readString(p.agent_id) || undefined,
		// PRD-049b: the resolved project segment (absent → controlled-writes defaults to inbox).
		projectId: readString(p.project_id) || undefined,
		// PRD-058b LIVE (C-1): the forwarded candidate set the post-commit conflict hook detects over.
		...(candidates.length > 0 ? { candidates } : {}),
	};
}

/**
 * Read the decision-stage candidate set off a controlled-write payload (PRD-058b LIVE / C-1). Each
 * item is `{ id, content }` (the candidate's durable id + its claim text). Defensive (drop-invalid):
 * a non-array, or an item missing a non-empty string `id`/`content`, is skipped — a malformed
 * candidate payload degrades to "no candidates" (the conflict hook is a no-op), never a throw.
 */
function readCandidates(value: unknown): ControlledWriteCandidate[] {
	if (!Array.isArray(value)) return [];
	const out: ControlledWriteCandidate[] = [];
	for (const item of value) {
		if (item === null || typeof item !== "object") continue;
		const rec = item as Record<string, unknown>;
		const id = readString(rec.id);
		const content = readString(rec.content);
		if (id === "" || content === "") continue;
		out.push({ id, content });
	}
	return out;
}

/**
 * The no-op controlled-writes handler the scaffold routes by default (Wave 1).
 * Writes NOTHING — the safe default for the only memory-mutating stage. Retained
 * so a test (or daemon-assembly) that does not inject deps still routes inertly.
 */
export const noopControlledWriteHandler: StageHandler = async (_job: StageJob): Promise<void> => {
	/* no-op stub — the real handler is built via createControlledWriteHandler(deps). */
};

/**
 * Build the controlled-writes handler. With real deps it adapts
 * {@link applyControlledWrite} to the {@link StageHandler} the worker routes for
 * `memory_controlled_write` jobs: it reads the proposal + fact material off the
 * payload, threads the job scope (FR-11), and applies the write. An unparseable
 * payload is a no-op skip (job completes — never a throw on bad upstream data). A
 * genuine storage failure throws → the worker routes it to the queue's
 * fail/backoff. Without deps (the Wave-1 stub call) it returns the no-op.
 */
export function createControlledWriteHandler(deps?: ControlledWriteHandlerDeps): StageHandler {
	if (deps === undefined) return noopControlledWriteHandler;
	const handlerDeps = deps;
	const logger = deps.logger ?? silentLogger;
	return async (job: StageJob): Promise<void> => {
		// PRD-062d (L-D1): a BATCHED job carries its per-fact proposals under the batch key. Apply each
		// fact as its OWN controlled write (AC-62d.1.2 — distinct memories stay distinct rows, each an
		// append/version-bump, never a coalesced in-place UPDATE). A payload without the key is the
		// legacy single-proposal shape and runs the original one-write path. The DISPATCH is what was
		// batched, never the writes.
		const batch = readBatchPayloads(job.payload);
		if (batch !== null) {
			for (const factPayload of batch) {
				// Each per-fact payload inherits the BATCH job's tenancy envelope (org/workspace/agent),
				// stamped once on the outer job by `decisionFanOut`. Project a per-fact StageJob whose
				// `payload` IS the merged per-fact payload, so `readControlledWriteInput`, the scope
				// thread, AND `onOutcome` (which reads `entities`/`content` off `job.payload` to fan out
				// graph-persist per memory) all resolve exactly as the unbatched single-job path did.
				const merged: Record<string, unknown> = { ...envelopeOf(job.payload), ...factPayload };
				const factJob: StageJob = { ...job, payload: merged };
				await applyOneControlledWrite(factJob, handlerDeps, logger);
			}
			return;
		}
		await applyOneControlledWrite(job, handlerDeps, logger);
	};
}

/**
 * The per-payload tenancy envelope a batched job stamps ONCE (org/workspace/agent_id +
 * the resolved project segment). Read off the batch job's payload so each per-fact payload
 * inherits the SAME scope the unbatched per-job payload carried (PRD-062d). A field absent
 * on the batch job is simply omitted (the per-fact payload / job scope supplies the default).
 */
function envelopeOf(payload: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of ["org", "workspace", "agent_id", "project_id"]) {
		if (typeof payload[key] === "string") out[key] = payload[key];
	}
	return out;
}

/**
 * Read the batched per-fact payloads off a `memory_controlled_write` job, or `null` when the
 * job is the legacy single-proposal shape (PRD-062d / L-D1). A non-array under the batch key
 * (or an empty array) yields `null` so the caller falls through to the single-write path —
 * a malformed batch degrades to "no batch", never a throw. Each element is returned as a
 * plain record for {@link readControlledWriteInput} to parse defensively (drop-invalid).
 */
function readBatchPayloads(payload: Record<string, unknown>): Array<Record<string, unknown>> | null {
	const raw = payload[CONTROLLED_WRITE_BATCH_KEY];
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const out: Array<Record<string, unknown>> = [];
	for (const item of raw) {
		if (item !== null && typeof item === "object" && !Array.isArray(item)) {
			out.push(item as Record<string, unknown>);
		}
	}
	return out.length > 0 ? out : null;
}

/**
 * Apply ONE controlled write from a job payload (single-sourced for the single and the
 * per-fact-of-a-batch paths — jscpd-safe). Parses the payload, threads the scope (FR-11),
 * applies the write, and runs the `onOutcome` fan-out fail-soft.
 *
 * The fan-out enqueue (`onOutcome`) is a SEPARATE, recoverable effect — graph-persist is
 * idempotent and the pollinating pass re-consolidates — so its failure must NOT throw out of
 * the handler. If it did, the stage handler would throw → the worker fails+retries the job
 * → `applyControlledWrite` runs AGAIN. That replay is a no-op for an ADD (the content-hash
 * dedup returns the existing id), but an UPDATE/DELETE is an APPEND-ONLY version bump that is
 * NOT idempotent on replay — a second apply would write an extra, spurious version. So a
 * fan-out failure is caught + logged here, never propagated, keeping the committed write
 * un-replayed. (A transactional outbox / idempotency-token redesign is the larger follow-up.)
 */
async function applyOneControlledWrite(
	job: StageJob,
	deps: ControlledWriteHandlerDeps,
	logger: ControlledWriteLogger,
): Promise<void> {
	const parsed = readControlledWriteInput(job.payload);
	if (parsed === null) {
		logger.event("controlled_write.unparseable_payload", { id: job.id });
		return; // drop-invalid: complete the job, do not mutate, do not throw.
	}
	// FR-11: thread the full scope from the job envelope — org/workspace as the
	// storage partition (the QueryScope) and agent_id as the engine scope column
	// on the row. A payload-supplied agentId wins; otherwise the job scope's.
	const input: ControlledWriteInput = {
		...parsed,
		agentId: parsed.agentId ?? job.scope.agentId,
	};
	const scope: QueryScope = { org: job.scope.org, workspace: job.scope.workspace };
	const outcome = await applyControlledWrite(input, scope, deps);
	if (deps.onOutcome) {
		try {
			await deps.onOutcome(job, outcome);
		} catch (err: unknown) {
			const reason = err instanceof Error ? err.message : String(err);
			logger.event("controlled_write.fan_out_failed", {
				id: job.id,
				action: outcome.action,
				memoryId: outcome.memoryId,
				reason,
			});
			// Swallow deliberately: the write is committed; the lost fan-out is recoverable via
			// the idempotent graph-persist + the pollinating re-consolidation. Re-throwing would
			// duplicate the committed write on the retry (the bug this guard exists to prevent).
		}
	}
}

// ── re-drive (PRD-080b b-AC-4) ──────────────────────────────────────────────────────

/** The count triple a re-drive of one terminal job payload reports (b-AC-4). */
export interface RedriveCounts {
	/** Facts recovered — the write LANDED (inserted/deduped/version-bumped) or was durably deferred to the outbox. */
	readonly redriven: number;
	/** Facts NOT recovered — an unparseable payload, a gate skip (shadow/frozen/below-confidence/flagged), or a genuine throw. */
	readonly skipped: number;
}

/**
 * PRD-080b (b-AC-4) — RE-DRIVE one terminal `memory_controlled_write` job payload by RE-RUNNING the
 * controlled-write path over its ALREADY-RESOLVED proposal(s), single-sourced through
 * {@link applyControlledWrite} (the SAME path the live stage runs). The terminal job payload carries the
 * proposal + fact material + scope envelope (NOT the built row), so — per the PRD's documented escape
 * hatch — the re-drive rebuilds the resolved write by re-running the proposal path rather than
 * reconstructing the `RowValues` by hand: on a healthy backend it commits directly (idempotent via the
 * `content_hash` dedup — a memory a prior attempt already landed is `deduped`, no duplicate), and during a
 * still-degraded window it defers into the durable outbox (`deferred`) for the drainer to land on recovery
 * — either way the dropped memory is recovered. The extraction/decision is NEVER re-run (the proposal is
 * on the payload). Handles BOTH the batched shape ({@link CONTROLLED_WRITE_BATCH_KEY}) and the legacy
 * single-proposal shape, exactly as {@link createControlledWriteHandler} does. FAIL-SOFT per fact: a
 * genuine-failure throw (the a-AC-2 safety invariant) is caught + counted `skipped`, never propagated —
 * the re-drive of one bad row never aborts the batch or the overall pass.
 */
export async function redriveControlledWritePayload(
	payload: Record<string, unknown>,
	deps: ControlledWriteHandlerDeps,
): Promise<RedriveCounts> {
	const batch = readBatchPayloads(payload);
	if (batch === null) return redriveOneFact(payload, deps);
	const envelope = envelopeOf(payload);
	let redriven = 0;
	let skipped = 0;
	for (const factPayload of batch) {
		const counts = await redriveOneFact({ ...envelope, ...factPayload }, deps);
		redriven += counts.redriven;
		skipped += counts.skipped;
	}
	return { redriven, skipped };
}

/** Is a re-driven outcome a RECOVERY (a landed commit, a dedup hit, or a durable defer)? (b-AC-4) */
function isRecoveredAction(action: ControlledWriteAction): boolean {
	return action === "inserted" || action === "deduped" || action === "version_bumped" || action === "deferred";
}

/**
 * Re-drive ONE fact payload (b-AC-4): parse it into a {@link ControlledWriteInput}, rebuild the scope +
 * agent off the payload envelope (exactly as {@link applyOneControlledWrite} threads a live job's scope),
 * and re-run {@link applyControlledWrite}. A recovered outcome counts `redriven`; an unparseable payload,
 * a gate skip, or a caught genuine-failure throw counts `skipped`. NEVER throws.
 */
async function redriveOneFact(payload: Record<string, unknown>, deps: ControlledWriteHandlerDeps): Promise<RedriveCounts> {
	const parsed = readControlledWriteInput(payload);
	if (parsed === null) return { redriven: 0, skipped: 1 };
	const scope: QueryScope = { org: readString(payload.org), workspace: readString(payload.workspace) };
	const input: ControlledWriteInput = {
		...parsed,
		agentId: parsed.agentId ?? (readString(payload.agent_id) || undefined),
	};
	try {
		const outcome = await applyControlledWrite(input, scope, deps);
		return isRecoveredAction(outcome.action) ? { redriven: 1, skipped: 0 } : { redriven: 0, skipped: 1 };
	} catch (err: unknown) {
		// The a-AC-2 genuine-failure throw is a normal "could not recover this fact" — caught + counted
		// skipped (secret-free), never propagated so one bad row never aborts the re-drive (b-AC-5).
		(deps.logger ?? silentLogger).event("controlled_write.redrive_failed", {
			reason: err instanceof Error ? err.name : "unknown_error",
		});
		return { redriven: 0, skipped: 1 };
	}
}

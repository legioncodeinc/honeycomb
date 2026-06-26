/**
 * PRD-058c — the STALE-REFERENCE diagnostic (the `σ(m,t)` term of the lifecycle scoring model).
 *
 * For each memory carrying extractable code references, this diagnostic resolves every reference
 * against the codebase-graph resolution snapshot (the ORACLE — PRD-014, NOT a filesystem stat),
 * computes the staleness probability `σ(m,t)` and the verification-freshness factor `v(m,t)`,
 * classifies the memory `fresh` / `stale` / `unknown`, writes `ref_status` / `verified_at` /
 * `stale_refs` back to the `memories` row, and appends a `memory_history` audit row. The demotion
 * itself is NOT applied here — it is the `(1 − σ)^s` factor recall feeds into the 058a
 * recency-multiplier stage (see `runtime/memories/recall.ts`). This module produces σ + the
 * `verified_at` recall reads; the worker owns WHEN it runs (058e paces the cadence).
 *
 * ── The equation (memory-lifecycle-scoring.md, Term 3) ───────────────────────────────────────
 *   resolve(r, G_t) ∈ [0,1]
 *     = 1            exact symbol match in the snapshot
 *     = sim(r, r*)   best fuzzy rename candidate r* is close          (∈ (0,1))
 *     = 0            looks like indexed code but is absent
 *     = (excluded)   outside the indexed graph → contributes nothing (unknown)
 *
 *   σ(m,t) = 1 − Π_{r ∈ refs_indexed(m)} [ resolve(r, G_t) · v(m,t) ]   (empty product → σ = 0)
 *   v(m,t) = 2^( −(t − verified_at(m)) / h_verify )                     (h_verify default 14 d)
 *
 * ── The classification (US-55c.1) ────────────────────────────────────────────────────────────
 *   - NO indexed references at all  → `unknown`, σ = 0 (empty product), NEVER demoted (AC-55c.1.4).
 *   - every indexed ref resolves    → `fresh`,   σ ≈ 0                                (AC-55c.1.2).
 *   - ≥ 1 indexed ref dangling       → `stale`,   σ > 0, the unresolved tokens recorded (AC-55c.1.1).
 *   An out-of-graph reference is EXCLUDED from the product (it is `unknown`, never `stale`,
 *   AC-55c.1.3); a close rename contributes a partial `sim ∈ (0,1)` (AC-55c.1.5).
 *
 * ── Fail-soft on a missing oracle (US-55c.3 / PRD Technical Considerations) ───────────────────
 *   If the snapshot provider returns `null` (the graph is unavailable for the workspace) the
 *   diagnostic marks NOTHING stale — every memory is `unknown` — logs, and returns. It NEVER
 *   mass-flags on a missing oracle. The snapshot read POLLS to convergence (DeepLake eventual
 *   consistency): a single read can see a stale segment and wrongly flag a live symbol.
 *
 * ── Posture (US-55c.2) ───────────────────────────────────────────────────────────────────────
 *   `observe` → detect + write + audit, but the demotion exponent `s = 0` so recall ranking is
 *   UNCHANGED (visible but inert). `execute` → the same detection, and recall applies `s > 0`.
 *   The diagnostic's WRITE behavior is identical in both postures; the posture only governs
 *   whether the eventual recall demotion is live (the `s` exponent lives with recall/058d).
 *
 * Every value routes through the guarded `writes.ts` primitives (`val.*` / `updateOrInsertByKey`
 * / `appendOnlyInsert`); no hand-quoted SQL.
 */

import { randomUUID } from "node:crypto";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk } from "../../storage/result.js";
import { appendOnlyInsert, updateOrInsertByKey, val, type RowValues } from "../../storage/writes.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { healTargetFor } from "../../storage/catalog/index.js";
import { MAX_STALE_REFS, type RefStatus, staleRefsOverflowMarker } from "../../storage/catalog/memories.js";
import type { Snapshot } from "../codebase/contracts.js";
import { extractReferences, type CodeReference } from "./reference-extract.js";

// ════════════════════════════════════════════════════════════════════════════
// SECTION 1 — the resolution oracle index + resolve(r, G_t).
// ════════════════════════════════════════════════════════════════════════════

/**
 * A query-friendly index over a codebase-graph {@link Snapshot} — the ORACLE the diagnostic
 * resolves against. Built once per pass via {@link buildResolutionIndex} so each reference is an
 * O(1) lookup rather than a full node scan. Carries:
 *  - `symbolNames`  the set of every symbol node's bare `name` (lower-cased) — exact-symbol hits.
 *  - `qualifiedIds` the set of every node `id` and `file#symbol`-shaped composite (lower-cased).
 *  - `files`        the set of every `sourceFile` path (lower-cased) — exact-path hits.
 *  - `symbolList`   the symbol names retained in original case for the fuzzy-rename pass.
 */
export interface ResolutionIndex {
	readonly symbolNames: ReadonlySet<string>;
	readonly qualifiedIds: ReadonlySet<string>;
	readonly files: ReadonlySet<string>;
	readonly symbolList: readonly string[];
}

/** Build the {@link ResolutionIndex} from a snapshot. Pure; tolerates a malformed node defensively. */
export function buildResolutionIndex(snapshot: Snapshot): ResolutionIndex {
	const symbolNames = new Set<string>();
	const qualifiedIds = new Set<string>();
	const files = new Set<string>();
	const symbolList: string[] = [];
	for (const node of snapshot.nodes) {
		const id = typeof node.id === "string" ? node.id : "";
		if (id !== "") qualifiedIds.add(id.toLowerCase());
		const file = typeof node.sourceFile === "string" ? node.sourceFile : "";
		if (file !== "") files.add(file.toLowerCase());
		if (node.kind === "symbol") {
			const name = typeof node.name === "string" ? node.name : "";
			if (name !== "") {
				symbolNames.add(name.toLowerCase());
				symbolList.push(name);
				// Index the `file#symbol` composite so a file#symbol reference matches exactly.
				if (file !== "") qualifiedIds.add(`${file}#${name}`.toLowerCase());
			}
		}
	}
	return { symbolNames, qualifiedIds, files, symbolList };
}

/**
 * Whether a reference is one the graph COULD know (so an absence is meaningful = `stale`), versus
 * one outside the indexed product (→ `unknown`, EXCLUDED from the product). A `path` /
 * `file-symbol` whose path carries a source extension is in-graph-shaped; a bare flag/qualified
 * symbol is in-graph-shaped only when it looks like our own code, NOT a bare npm specifier or URL.
 * Conservative: when in doubt, NOT-indexed (→ `unknown`), because the failure mode we forbid is a
 * false `stale`, never a false `unknown`.
 */
/** Source-file extensions that mark a left-hand path as repo-shaped (the nine graph languages). */
const REPO_PATH_EXT_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|rb|c|h|cc|cpp|cxx|hpp)$/i;

/**
 * A SCOPED npm package specifier (`@scope/pkg`, optionally with a sub-path like `@scope/pkg/dist`), with NO
 * source extension. Such a specifier CONTAINS a `/` yet is an EXTERNAL package, never indexed repo code, so
 * it must be excluded BEFORE the slash-based repo test below. Otherwise `@scope/pkg#symbol` would be
 * mis-classified repo-shaped and a missing external symbol would score a false `stale` (PRD-058c.1.3 forbids
 * a false `stale`). A scoped path that DOES carry a source extension (e.g. a vendored `@scope/pkg/x.ts`) is
 * NOT matched here: it falls through to the extension test and stays in-graph.
 */
const SCOPED_PACKAGE_RE = /^@[^/]+\/[^/]+(?:\/.*)?$/;

/**
 * Is a `file-symbol`'s left-hand side a REPO-SHAPED path (so an absence is meaningful = `stale`), rather
 * than a bare package/module specifier (e.g. `react`, `lodash`, `@scope/pkg`) that must score `unknown`?
 * A SCOPED package specifier is excluded FIRST (it contains a `/` but is external; PRD-058c.1.3) UNLESS it
 * carries a source extension. Otherwise repo-shaped = it carries a path separator OR ends in a known source
 * extension. A bare module token (no `/`, no extension) is an external package reference, never indexed code.
 */
function isRepoShapedPath(file: string): boolean {
	// A scoped package specifier with no source extension is external (out-of-graph) despite its `/`.
	if (SCOPED_PACKAGE_RE.test(file) && !REPO_PATH_EXT_RE.test(file)) return false;
	return file.includes("/") || REPO_PATH_EXT_RE.test(file);
}

export function looksIndexed(ref: CodeReference): boolean {
	// An external URL or a bare npm specifier is never indexed code.
	if (/^[a-z]+:\/\//i.test(ref.raw)) return false; // http(s)://, file://, etc.
	if (ref.kind === "path" || ref.kind === "file-symbol") {
		const file = ref.file ?? "";
		// A node_modules path or a bare package specifier (no slash, or `@scope/pkg`) is external.
		if (/(^|\/)node_modules\//.test(file)) return false;
		// A `file-symbol` from the bare `module#symbol` rule (e.g. `react#createRoot`) has a LEFT side
		// that is a package/module specifier, NOT a repo path: no path separator and no source extension.
		// Such an external reference must score `unknown` (NEUTRAL), never `stale` — the failure mode
		// PRD-058c.1.3 forbids. Only a REPO-SHAPED left side (a `/`-separated path or a source-extension
		// file) is in-graph-shaped. The `path` kind always carried a slash + extension (the extractor
		// required it), so this only narrows the bare-`module#symbol` `file-symbol` case.
		if (ref.kind === "file-symbol" && !isRepoShapedPath(file)) return false;
		return true; // a slash + source extension path is in-graph-shaped (the extractor required it).
	}
	// A flag/qualified symbol: indexed-shaped. (A bare npm name would not have matched the
	// extractor's structural rules, so reaching here means it carried a `::`/`.`/SCREAMING signal.)
	return true;
}

/** Bounded Levenshtein edit distance between two lower-cased strings; returns `> maxDistance` early. */
export function boundedLevenshtein(a: string, b: string, maxDistance: number): number {
	if (a === b) return 0;
	if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
	const prev = new Array<number>(b.length + 1);
	const curr = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		let rowMin = curr[0]!;
		for (let j = 1; j <= b.length; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
			curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
			if (curr[j]! < rowMin) rowMin = curr[j]!;
		}
		if (rowMin > maxDistance) return maxDistance + 1; // whole row exceeded the bound — prune.
		for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
	}
	return prev[b.length]!;
}

/** The default similarity floor a fuzzy rename candidate must clear to contribute `sim` rather than `0`. */
export const DEFAULT_RENAME_SIM_FLOOR = 0.7;

/**
 * The best fuzzy-rename similarity for a target symbol against the index's symbol list, in `(0,1)`,
 * or `0` when no candidate clears the floor. `sim = 1 − dist / maxLen`, bounded so a wholly
 * different token returns `0` (the edit budget scales with the longer name). The threshold is a
 * documented default sweep point (PRD-058c), not a fixed assertion.
 */
export function bestRenameSim(symbol: string, index: ResolutionIndex, floor: number = DEFAULT_RENAME_SIM_FLOOR): number {
	const target = symbol.toLowerCase();
	if (target === "") return 0;
	let best = 0;
	for (const candidate of index.symbolList) {
		const cand = candidate.toLowerCase();
		if (cand === target) return 1; // exact (case-insensitive) — should have been caught upstream, but safe.
		const maxLen = Math.max(cand.length, target.length);
		// The edit budget: at most (1 − floor) of the longer name may differ to still clear `floor`.
		const budget = Math.floor(maxLen * (1 - floor));
		if (budget <= 0) continue;
		const dist = boundedLevenshtein(cand, target, budget);
		const sim = 1 - dist / maxLen;
		if (sim > best) best = sim;
	}
	return best >= floor ? best : 0;
}

/** The per-reference resolution outcome (the `resolve(r, G_t)` value plus whether it counts toward σ). */
export interface RefResolution {
	/** The reference that was resolved. */
	readonly ref: CodeReference;
	/** `resolve(r, G_t) ∈ [0,1]`: 1 exact, `sim ∈ (0,1)` fuzzy, 0 indexed-but-absent. */
	readonly resolve: number;
	/** `true` when the ref is OUTSIDE the indexed graph → EXCLUDED from the product (NEUTRAL, `unknown`). */
	readonly excluded: boolean;
}

/**
 * Resolve ONE reference against the index (PRD-058c). RULES:
 *  - out-of-graph (`!looksIndexed`) → `{ resolve: 1, excluded: true }`: contributes NOTHING to the
 *    product (it is `unknown`, NEVER `stale`, AC-55c.1.3).
 *  - exact id / path / `file#symbol` / symbol-name match → `resolve = 1` (AC-55c.1.2).
 *  - else a fuzzy rename candidate clears the floor → `resolve = sim ∈ (0,1)` (AC-55c.1.5).
 *  - else looks indexed but is absent → `resolve = 0` → `σ = 1` for this ref (AC-55c.1.1).
 * Pure.
 */
export function resolveReference(ref: CodeReference, index: ResolutionIndex, floor: number = DEFAULT_RENAME_SIM_FLOOR): RefResolution {
	if (!looksIndexed(ref)) return { ref, resolve: 1, excluded: true };

	const raw = ref.raw.toLowerCase();
	const file = (ref.file ?? "").toLowerCase();
	const symbol = (ref.symbol ?? "").toLowerCase();

	// Exact hits: the raw token as an id, the path as a file, or the symbol as a known name.
	if (index.qualifiedIds.has(raw)) return { ref, resolve: 1, excluded: false };
	if (ref.kind === "path" && file !== "" && index.files.has(file)) return { ref, resolve: 1, excluded: false };
	if (ref.kind === "file-symbol" && file !== "" && symbol !== "" && index.qualifiedIds.has(`${file}#${symbol}`)) {
		return { ref, resolve: 1, excluded: false };
	}
	if (symbol !== "" && index.symbolNames.has(symbol)) return { ref, resolve: 1, excluded: false };
	// A bare path with no symbol whose raw equals a known file (covered above) or a flag we cannot
	// place: a flag is in-graph-shaped but flags are not graph NODES, so a flag never resolves
	// exactly — fall through to fuzzy/absent on its symbol form.

	// Fuzzy rename: the best symbol-name similarity (AC-55c.1.5). Only meaningful for a symbol-ish ref.
	const fuzzyTarget = symbol !== "" ? symbol : ref.kind === "path" ? "" : raw;
	if (fuzzyTarget !== "") {
		const sim = bestRenameSim(fuzzyTarget, index, floor);
		if (sim > 0) return { ref, resolve: sim, excluded: false };
	}

	// Looks indexed, no exact and no close rename → dangling (AC-55c.1.1).
	return { ref, resolve: 0, excluded: false };
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 2 — σ(m,t), v(m,t), and the classification.
// ════════════════════════════════════════════════════════════════════════════

/** The default verification half-life in DAYS (`h_verify`, PRD-058c / scoring model). */
export const DEFAULT_H_VERIFY_DAYS = 14;

/** The default `v(m,t)` floor below which the memory is re-queued for a fresh check. */
export const DEFAULT_REVERIFY_THRESHOLD = 0.5;

const MS_PER_DAY = 24 * 60 * 60 * 1_000;
const LN2 = Math.LN2;

/**
 * The verification-freshness factor `v(m,t) = 2^(−(t − verified_at)/h_verify)` (PRD-058c). RULES:
 *  - `verified_at === null` (never verified) → `v = 0` (fully decayed → always due for a check).
 *  - `Δt` clamped `≥ 0` (a future stamp → `v = 1`, never `> 1`).
 *  - At `Δt = h_verify`, `v = 0.5` exactly (the half-life identity the test asserts).
 * Pure; never throws.
 */
export function verificationFreshness(verifiedAtMs: number | null, nowMs: number, hVerifyDays: number = DEFAULT_H_VERIFY_DAYS): number {
	if (verifiedAtMs === null || !Number.isFinite(verifiedAtMs)) return 0; // never verified → fully decayed.
	const ageDays = Math.max(0, (nowMs - verifiedAtMs) / MS_PER_DAY);
	const halfLife = Math.max(MS_PER_DAY / MS_PER_DAY, hVerifyDays); // floor ≥ 1 day so λ is finite.
	const lambda = LN2 / halfLife;
	return Math.exp(-lambda * ageDays);
}

/** The result of scoring one memory's references: σ, the classification, and the unresolved tokens. */
export interface StalenessVerdict {
	/** `σ(m,t) ∈ [0,1]`: the probability ≥ 1 indexed reference is dangling. Empty product → 0. */
	readonly sigma: number;
	/** The `fresh` / `stale` / `unknown` classification stamped on `ref_status`. */
	readonly refStatus: RefStatus;
	/** The specific unresolved references (the `stale_refs` payload), capped + overflow-marked. */
	readonly staleRefs: readonly string[];
	/** The count of indexed references that entered the product (0 → empty product → `unknown`). */
	readonly indexedCount: number;
}

/**
 * Compute the staleness verdict for ONE memory's resolved references (PRD-058c). `σ` uses the
 * just-verified check, so `v` is taken at `Δt = 0` (`v = 1`) for the value WRITTEN now — the
 * verification-freshness decay governs FUTURE re-checks (via {@link verificationFreshness} read at
 * recall/schedule time), not the value stamped at write time. RULES:
 *  - EXCLUDED refs (out-of-graph) do not enter the product (AC-55c.1.3).
 *  - empty product (no indexed refs) → σ = 0, `unknown` (AC-55c.1.4: never demoted).
 *  - every indexed ref resolves (each `resolve = 1`) → σ ≈ 0, `fresh` (AC-55c.1.2).
 *  - any `resolve < 1` (a `0` dangling or a partial `sim`) → σ > 0, `stale` (AC-55c.1.1 / 55c.1.5),
 *    and every ref with `resolve < 1` is recorded in `staleRefs` (capped at {@link MAX_STALE_REFS}).
 * Pure.
 */
export function scoreStaleness(resolutions: readonly RefResolution[]): StalenessVerdict {
	const indexed = resolutions.filter((r) => !r.excluded);
	if (indexed.length === 0) {
		// Empty product convention → σ = 0, neutral. `unknown` (we saw no indexed refs to judge).
		return { sigma: 0, refStatus: "unknown", staleRefs: [], indexedCount: 0 };
	}
	// σ = 1 − Π resolve(r). v at write time is 1 (a fresh check), so it drops out of the product here.
	let product = 1;
	const unresolved: string[] = [];
	for (const r of indexed) {
		product *= r.resolve;
		if (r.resolve < 1) unresolved.push(r.ref.raw);
	}
	const sigma = clamp01(1 - product);
	const refStatus: RefStatus = unresolved.length > 0 ? "stale" : "fresh";
	return { sigma, refStatus, staleRefs: capStaleRefs(unresolved), indexedCount: indexed.length };
}

/** Clamp a number into `[0,1]`, mapping a non-finite to `0` (neutral). */
function clamp01(x: number): number {
	if (!Number.isFinite(x)) return 0;
	return Math.min(1, Math.max(0, x));
}

/** Cap the unresolved list at {@link MAX_STALE_REFS}, appending an overflow marker for the remainder. */
export function capStaleRefs(refs: readonly string[]): string[] {
	if (refs.length <= MAX_STALE_REFS) return [...refs];
	const kept = refs.slice(0, MAX_STALE_REFS);
	kept.push(staleRefsOverflowMarker(refs.length - MAX_STALE_REFS));
	return kept;
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 3 — the diagnostic: snapshot provider seam, per-memory check, write + audit.
// ════════════════════════════════════════════════════════════════════════════

/** One memory the diagnostic scores: its id and the content references are extracted from. */
export interface DiagnosticMemory {
	readonly id: string;
	readonly content: string;
}

/** The maintenance posture governing whether the eventual recall demotion is live (US-55c.2). */
export type StalePosture = "observe" | "execute";

/**
 * The snapshot-provider seam (PRD-058c US-55c.3.3): returns the resolution snapshot ORACLE for the
 * scope, or `null` when the graph is unavailable (→ fail-soft, everything `unknown`). The
 * IMPLEMENTATION is responsible for POLLING the DeepLake snapshot read to convergence (eventual
 * consistency) so a single stale segment never produces a `stale` verdict; the diagnostic treats
 * the returned snapshot as already-converged. A throw is caught by the diagnostic and treated as
 * `null` (fail-soft), never a crashed pass.
 */
export interface SnapshotProvider {
	/** Resolve the converged snapshot for the scope, or `null` when the graph is unavailable. */
	load(scope: QueryScope): Promise<Snapshot | null>;
}

/** Dependencies the diagnostic needs (all injectable so a unit test drives deterministic fakes). */
export interface StaleRefDiagnosticDeps {
	/** The live storage client (writes route through the guarded `writes.ts` primitives). */
	readonly storage: StorageQuery;
	/** The converged-snapshot provider (polls DeepLake to convergence; `null` → fail-soft). */
	readonly snapshots: SnapshotProvider;
	/** Wall clock (injected for deterministic `verified_at`). Defaults to `Date.now`. */
	readonly now?: () => number;
	/** UUID source for the `memory_history` row id. Defaults to `crypto.randomUUID`. */
	readonly newId?: () => string;
	/** The fuzzy-rename similarity floor (eval sweep point). Defaults to {@link DEFAULT_RENAME_SIM_FLOOR}. */
	readonly renameSimFloor?: number;
	/** Optional structured logger for the fail-soft path; absent → silent. */
	readonly log?: (event: string, detail: Record<string, unknown>) => void;
}

/** One memory's diagnostic outcome (returned for the dashboard/report; also what was written). */
export interface MemoryStaleResult {
	readonly id: string;
	readonly sigma: number;
	readonly refStatus: RefStatus;
	readonly staleRefs: readonly string[];
	/** `true` when the columns + audit row were written; `false` on a write error (fail-soft). */
	readonly written: boolean;
}

/** The whole pass summary (the contract the maintenance runner + dashboard read). */
export interface StaleRefDiagnosticReport {
	/** `true` when the pass ran (even a fail-soft "graph unavailable" pass is `ok`). */
	readonly ok: boolean;
	/** `true` when the graph oracle was unavailable → everything `unknown`, nothing flagged stale. */
	readonly graphUnavailable: boolean;
	/** Per-memory results. */
	readonly results: readonly MemoryStaleResult[];
	/** The posture the pass ran under. */
	readonly posture: StalePosture;
}

/**
 * Run the stale-reference diagnostic over a batch of memories (PRD-058c). For each memory it
 * extracts references, resolves them against the converged snapshot, computes σ, classifies
 * `ref_status`, writes the three columns + a `memory_history` audit row, and returns the result.
 *
 * FAIL-SOFT: if the snapshot provider yields `null` (or throws), the pass marks NOTHING stale —
 * every memory is stamped `unknown` with σ = 0 — logs `graph-unavailable`, and returns
 * `graphUnavailable: true` WITHOUT a single `stale` verdict (US-55c.3 / the "missing oracle"
 * rule). A per-memory write error is swallowed (`written: false`) and never aborts the batch.
 */
export async function runStaleRefDiagnostic(
	memories: readonly DiagnosticMemory[],
	scope: QueryScope,
	posture: StalePosture,
	deps: StaleRefDiagnosticDeps,
): Promise<StaleRefDiagnosticReport> {
	const nowMs = (deps.now ?? Date.now)();

	let snapshot: Snapshot | null;
	try {
		snapshot = await deps.snapshots.load(scope);
	} catch (err) {
		deps.log?.("stale-ref:graph-unavailable", { reason: "snapshot-load-threw", error: String(err) });
		snapshot = null;
	}

	// Missing oracle → mark NOTHING stale. Stamp `unknown` (NEUTRAL) and return; never mass-flag.
	if (snapshot === null) {
		deps.log?.("stale-ref:graph-unavailable", { memories: memories.length });
		const results: MemoryStaleResult[] = [];
		for (const mem of memories) {
			const written = await writeVerdict(mem.id, { sigma: 0, refStatus: "unknown", staleRefs: [], indexedCount: 0 }, nowMs, posture, scope, deps);
			results.push({ id: mem.id, sigma: 0, refStatus: "unknown", staleRefs: [], written });
		}
		return { ok: true, graphUnavailable: true, results, posture };
	}

	const index = buildResolutionIndex(snapshot);
	const floor = deps.renameSimFloor ?? DEFAULT_RENAME_SIM_FLOOR;
	const results: MemoryStaleResult[] = [];
	for (const mem of memories) {
		const refs = extractReferences(mem.content);
		const resolutions = refs.map((r) => resolveReference(r, index, floor));
		const verdict = scoreStaleness(resolutions);
		const written = await writeVerdict(mem.id, verdict, nowMs, posture, scope, deps);
		results.push({ id: mem.id, sigma: verdict.sigma, refStatus: verdict.refStatus, staleRefs: verdict.staleRefs, written });
	}
	return { ok: true, graphUnavailable: false, results, posture };
}

/**
 * Write ONE memory's verdict (US-55c.2.4) — RECONSTRUCTABLE across a partial failure. DeepLake has no
 * multi-statement transaction, so the audit append and the `ref_status` / `verified_at` / `stale_refs`
 * projection update cannot be one atomic write. To guarantee a ranking change NEVER lands without a
 * recoverable audit trail, the steps are ORDERED audit-FIRST:
 *  1. read the memory's CURRENT verdict fields (the prior state, for `before_payload`);
 *  2. append the `memory_history` row carrying BOTH the prior (`before_payload`) and the new
 *     (`after_payload`) verdict — so the transition is fully reconstructable / reversible from the audit;
 *  3. ONLY THEN update the projection columns on the `memories` row.
 * A crash after (2) but before (3) leaves an audit row whose `after_payload` records the INTENDED
 * verdict while the projection still holds the prior state — observable and replayable, never a silent
 * ranking change with no audit. A failed audit append aborts BEFORE the projection mutates (returns
 * `false`), so the row is never mutated without its history. FAIL-SOFT: any error → `written: false`,
 * never thrown (one memory failing must not abort the batch).
 */
async function writeVerdict(
	memoryId: string,
	verdict: StalenessVerdict,
	nowMs: number,
	posture: StalePosture,
	scope: QueryScope,
	deps: StaleRefDiagnosticDeps,
): Promise<boolean> {
	if (memoryId === "") return false;
	const nowIso = new Date(nowMs).toISOString();
	const staleRefsJson = JSON.stringify(verdict.staleRefs);
	try {
		// (1) Capture the PRIOR verdict fields so the audit's before_payload makes the transition reversible.
		// A READ ERROR (distinct from a genuinely-absent row) ABORTS before any write: appending an audit
		// with a FABRICATED empty before_payload and then mutating the projection would break the
		// reconstructable-audit guarantee (the before_payload would not reflect the real prior state). Do
		// nothing this run; the next pass retries. Only a genuinely-absent row (ok + 0 rows) is a legitimate
		// empty prior (a never-verified memory has no prior verdict to record).
		const prior = await readPriorVerdict(memoryId, scope, deps);
		if (prior.kind === "error") return false; // unreadable prior → abort BEFORE the audit/projection writes.
		const before = prior.value;

		// (2) Append the audit FIRST. If it fails, abort BEFORE the projection mutates — no ranking change
		// without its history row.
		const audited = await appendStaleHistory(memoryId, verdict, posture, before, nowIso, scope, deps);
		if (!audited) return false;

		// (3) Project the new verdict onto the memories row. A crash here leaves the audit ahead of the
		// projection (the recoverable direction: replay the after_payload), never a silent mutation.
		const update: RowValues = [
			["id", val.str(memoryId)],
			["ref_status", val.str(verdict.refStatus)],
			["verified_at", val.str(nowIso)],
			["stale_refs", val.text(staleRefsJson)],
		];
		const updated = await updateOrInsertByKey(deps.storage, healTargetFor("memories"), scope, {
			keyColumn: "id",
			keyValue: memoryId,
			row: update,
		});
		return isOk(updated);
	} catch {
		return false; // fail-soft: a write hiccup never aborts the batch.
	}
}

/** The prior verdict fields read off a memory's row (for the audit `before_payload`). Empty when absent. */
interface PriorVerdict {
	readonly refStatus: string;
	readonly verifiedAt: string;
	readonly staleRefs: string;
}

/**
 * The result of reading the prior verdict. The `error` case is DISTINCT from a genuinely-absent row so the
 * caller can tell "this memory was never verified (no prior to record → a legitimate empty before_payload)"
 * apart from "the prior could not be read (a query error → ABORT before any audit/projection write)".
 * Collapsing both into an empty prior would let a transient read failure write an audit with a FABRICATED
 * empty before_payload and then mutate the projection, breaking the reconstructable-audit guarantee
 * (CodeRabbit round-2 finding #4). An absent prior is the `ok` + empty-fields value; a read failure is `error`.
 */
type PriorVerdictRead = { readonly kind: "ok"; readonly value: PriorVerdict } | { readonly kind: "error" };

/** The empty prior a genuinely-absent (never-verified) memory row yields. */
const ABSENT_PRIOR: PriorVerdict = { refStatus: "", verifiedAt: "", staleRefs: "" };

/**
 * Read a memory's CURRENT `ref_status` / `verified_at` / `stale_refs` (the prior verdict the diagnostic
 * is about to overwrite) so the audit `before_payload` captures the reversible pre-state. RETURNS a
 * discriminated result:
 *  - `{ kind: "ok", value: <empty> }` when the row is genuinely ABSENT (a never-verified memory has no
 *    prior verdict, a legitimate empty before_payload), or has empty/NULL verdict fields;
 *  - `{ kind: "ok", value: { … } }` with the stored prior;
 *  - `{ kind: "error" }` when the read FAILED (a query/connection error). The caller MUST ABORT before any
 *    audit/projection write rather than fabricate an empty before_payload over an unreadable prior. It never throws.
 */
async function readPriorVerdict(memoryId: string, scope: QueryScope, deps: StaleRefDiagnosticDeps): Promise<PriorVerdictRead> {
	const tbl = sqlIdent("memories");
	const idCol = sqlIdent("id");
	const readSql =
		`SELECT ${sqlIdent("ref_status")} AS ref_status, ${sqlIdent("verified_at")} AS verified_at, ` +
		`${sqlIdent("stale_refs")} AS stale_refs FROM "${tbl}" WHERE ${idCol} = ${sLiteral(memoryId)} LIMIT 1`;
	const res = await deps.storage.query(readSql, scope);
	if (!isOk(res)) return { kind: "error" }; // read FAILED → abort (do NOT fabricate an empty before_payload).
	if (res.rows.length === 0) return { kind: "ok", value: ABSENT_PRIOR }; // genuinely absent → legitimate empty prior.
	const row = res.rows[0] as Record<string, unknown>;
	const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
	return { kind: "ok", value: { refStatus: str(row.ref_status), verifiedAt: str(row.verified_at), staleRefs: str(row.stale_refs) } };
}

/**
 * Append the `memory_history` audit row for a detection/heal action (US-55c.2.4). Records the
 * `pipeline` actor (the maintenance worker is a pipeline-class change — in the catalog actor
 * allowlist), the `stale-ref-detect` operation, the PRIOR verdict in `before_payload` (so the
 * transition is reconstructable / reversible), and the NEW verdict in `after_payload` (reason, σ,
 * posture, ref_status, stale_refs). Returns whether the append landed.
 */
async function appendStaleHistory(
	memoryId: string,
	verdict: StalenessVerdict,
	posture: StalePosture,
	before: PriorVerdict,
	nowIso: string,
	scope: QueryScope,
	deps: StaleRefDiagnosticDeps,
): Promise<boolean> {
	const auditId = (deps.newId ?? randomUUID)();
	// before_payload captures the prior verdict so the transition can be reversed/reconstructed from the
	// audit alone (CodeRabbit: a non-empty before_payload is what makes the ranking change reversible).
	const beforePayload = JSON.stringify({
		refStatus: before.refStatus,
		verifiedAt: before.verifiedAt,
		staleRefs: before.staleRefs,
	});
	const after = JSON.stringify({
		reason: "stale-ref-diagnostic",
		posture,
		sigma: verdict.sigma,
		refStatus: verdict.refStatus,
		staleRefs: verdict.staleRefs,
	});
	const row: RowValues = [
		["id", val.str(auditId)],
		["memory_id", val.str(memoryId)],
		["changed_by", val.str("pipeline")],
		["operation", val.str("stale-ref-detect")],
		["before_payload", val.text(beforePayload)],
		["after_payload", val.text(after)],
		["created_at", val.str(nowIso)],
	];
	const res = await appendOnlyInsert(deps.storage, healTargetFor("memory_history"), scope, row);
	return isOk(res);
}

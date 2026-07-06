/**
 * PRD-058e, the calibration-curve store reader (the introspection data source).
 *
 * Reads the LIVE calibration snapshot, the highest-`fit_at` row of
 * `memory_calibration` (`catalog/memory-lifecycle.ts`), and shapes it into the
 * `GET /api/memories/calibration` payload: the curve's held-out `ece` / `brier` /
 * `n_samples` and a reliability-diagram payload (058d). FAIL-SOFT: a missing table
 * (no refit has run yet), an empty table, or any query error yields the
 * COLD-START introspection shape (identity curve, zero metrics, empty diagram),
 * never a throw, so the endpoint always answers honestly that calibration is
 * dormant until the first refit.
 *
 * The reliability diagram is derived from the stored CURVE (the isotonic step
 * function) rather than re-deriving from raw samples (the snapshot stores the
 * fitted curve + aggregate metrics, not the raw `(f,y)` pairs), so the dashboard
 * renders the shape of `g` across the confidence range. When more is needed (the
 * per-bin observed accuracy from the held-out slice) it is a 058d follow-on; this
 * surface is the curve + its committed metrics.
 *
 * All reads go through the injected {@link StorageQuery}; every identifier through
 * `sqlIdent` via the catalog builder. No value is interpolated (the read carries
 * none).
 */

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk, type QueryResult, type StorageRow } from "../../storage/result.js";
import { buildLatestCalibrationSql, type CalibrationAgentScope } from "../../storage/catalog/memory-lifecycle.js";
import {
	applyCalibration,
	deserializeModel,
	DEFAULT_ECE_BINS,
	IDENTITY_MODEL,
	type CalibrationModel,
	type ReliabilityBin,
} from "./calibration.js";

/** The `GET /api/memories/calibration` introspection payload (PRD-058e API spec). */
export interface CalibrationIntrospection {
	/** The held-out Expected Calibration Error of the live curve (0 when cold-start). */
	readonly ece: number;
	/** The held-out Brier score of the live curve (0 when cold-start). */
	readonly brier: number;
	/** How many resolved `(f,y)` pairs the live curve was fit on (0 when cold-start). */
	readonly nSamples: number;
	/** When the live curve was fit (ISO-8601), or `null` when no curve has been fit yet. */
	readonly fitAt: string | null;
	/** True when the live curve is the dormant identity (`C = f`), no proven calibration yet. */
	readonly identity: boolean;
	/** The reliability-diagram payload derived from the live curve (058d). */
	readonly reliabilityDiagram: ReliabilityBin[];
}

/** The cold-start introspection shape: identity curve, zero metrics, a flat diagram. */
function coldStart(bins: number): CalibrationIntrospection {
	return {
		ece: 0,
		brier: 0,
		nSamples: 0,
		fitAt: null,
		identity: true,
		reliabilityDiagram: curveDiagram(IDENTITY_MODEL, bins),
	};
}

/**
 * Read the live calibration introspection for a scope (PRD-058e). Returns the
 * latest snapshot's metrics + a reliability diagram of its curve, or the
 * cold-start shape when no snapshot exists / any read error (fail-soft). Never
 * throws.
 *
 * `agent` scopes the read to the OWNING agent's calibration slice (D-2): `memory_calibration` is an
 * agent-scoped engine table, so a global "newest snapshot" read could return ANOTHER agent's curve in a
 * multi-agent workspace. ABSENT → the schema defaults (`'default'` / `'global'`), so an un-scoped caller
 * reads one consistent agent slice rather than the whole partition.
 */
export async function readCalibrationIntrospection(
	storage: StorageQuery,
	scope: QueryScope,
	bins: number = DEFAULT_ECE_BINS,
	agent?: CalibrationAgentScope,
): Promise<CalibrationIntrospection> {
	let res: QueryResult;
	try {
		res = await storage.query(buildLatestCalibrationSql(agent), scope);
	} catch {
		return coldStart(bins);
	}
	if (!isOk(res) || res.rows.length === 0) return coldStart(bins);

	const row = res.rows[0] as StorageRow;
	const model = deserializeModel(String(row.model_blob ?? ""));
	return {
		ece: readFloat(row.ece, 0),
		brier: readFloat(row.brier, 0),
		nSamples: readInt(row.n_samples, 0),
		fitAt: row.fit_at === undefined || row.fit_at === null || String(row.fit_at) === "" ? null : String(row.fit_at),
		identity: model.identity,
		reliabilityDiagram: curveDiagram(model, bins),
	};
}

/**
 * Build a reliability-diagram payload from the CURVE alone (PRD-058e): for each
 * bin, the bin's confidence midpoint mapped through `g` is the predicted
 * calibrated confidence. With no raw samples persisted in the snapshot, this
 * renders the SHAPE of `g` (the calibration map) across the range; per-bin
 * observed accuracy is a 058d follow-on with the held-out slice. The identity
 * curve yields the diagonal (predicted == midpoint), the visual "uncalibrated"
 * baseline. Pure.
 */
function curveDiagram(model: CalibrationModel, bins: number): ReliabilityBin[] {
	const m = Math.max(1, Math.trunc(bins));
	const out: ReliabilityBin[] = [];
	for (let b = 0; b < m; b++) {
		const lower = b / m;
		const upper = (b + 1) / m;
		const mid = (lower + upper) / 2;
		out.push({
			lower,
			upper,
			meanConfidence: mid,
			accuracy: applyCalibration(model, mid),
			count: 0, // no raw samples in the snapshot, the curve shape, not the empirical histogram.
		});
	}
	return out;
}

/** Read a stored float cell, defaulting when absent/garbage. */
function readFloat(value: unknown, def: number): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : def;
}

/** Read a stored count cell into a non-negative integer. */
function readInt(value: unknown, def: number): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : def;
}

// ─────────────────────────────────────────────────────────────────────────────
// CalibrationModelProvider — the TTL-cached, invalidatable, THENABLE holder
// (the L-W3 fix for the boot-once cached promise that left recall stale until
// daemon restart after a worker refit).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The default TTL for the calibration-model cache (1 minute). Bounds DB read frequency:
 * at most one `buildLatestCalibrationSql` re-read per minute, regardless of recall volume.
 * Chosen to be much shorter than the worker's hourly refit cadence (so a fresh curve is
 * observed within a minute of the worker writing it, even without explicit invalidation)
 * while avoiding a per-recall DB round-trip on the user's critical path.
 */
export const DEFAULT_CALIBRATION_CACHE_TTL_MS = 60_000;

/**
 * The now-injectable clock the provider reads (tests drive deterministically).
 */
type Now = () => number;

/**
 * A cached calibration-model entry: the resolved model + the wall-clock ms when it expires.
 */
interface CacheEntry {
	readonly model: CalibrationModel;
	readonly expiresAt: number;
}

/**
 * A TTL-cached, invalidatable, THENABLE holder for the live {@link CalibrationModel}.
 *
 * ── WHY THIS EXISTS (the L-W3 staleness fix) ─────────────────────────────────
 * PRD-058 L-W3 originally read the model ONCE at daemon boot and cached the resulting
 * `Promise<CalibrationModel>` on `MountMemoriesOptions.calibrationModel`. The recall
 * handler (`api.ts`) `await`s that promise on every request — but awaiting an
 * already-resolved promise returns the SAME resolved value forever. So when the hourly
 * calibration worker (`runCalibratePass` → `writeCalibrationSnapshot`) wrote a new curve
 * to `memory_calibration`, recall kept reading the curve that was live when the daemon
 * started — until restart. The docstring at `readCalibrationModel` even claimed the
 * opposite ("when a refit lands later, it takes effect immediately"), so this was a
 * silent contract violation, not a documented limitation. The eval-gate flip
 * (`HONEYCOMB_LIFECYCLE_CONFIDENCE_EXPONENT > 0`) is a single env-var away from going
 * live, which made this a footgun rather than a theoretical concern.
 *
 * ── THE FIX ──────────────────────────────────────────────────────────────────
 * This holder replaces the cached promise. It is **thenable** (implements `then`), so
 * the existing contract `calibrationModel: Promise<CalibrationModel>` is preserved
 * exactly — `await options.calibrationModel` continues to work, and the lifecycle-wiring
 * test that asserts `typeof captured.calibrationModel.then === "function"` still passes.
 * The `then` implementation returns a fresh promise that:
 *   - resolves to the CACHED model when the entry is fresh (within `ttlMs`),
 *   - re-reads from storage (once, deduped) when the entry is stale or has been
 *     invalidated by a worker write,
 *   - resolves to {@link IDENTITY_MODEL} on any read error (the cold-start fail-soft).
 *
 * ── CONCRANCY (thundering-herd dedupe) ───────────────────────────────────────
 * When the entry is stale and N recalls arrive simultaneously, they all share the SAME
 * in-flight re-read promise (`inflight`), so only ONE storage query fires. The cache is
 * updated atomically when the read resolves; subsequent callers hit the fresh entry.
 *
 * ── INVALIDATION ────────────────────────────────────────────────────────────
 * `invalidate()` clears the cached entry. The calibration worker calls it after a
 * successful `writeCalibrationSnapshot`, so the very next recall observes the new curve
 * (no waiting for the TTL to expire). Fail-soft: invalidate never throws.
 *
 * The holder is constructed once at composition (via {@link createCalibrationModelProvider})
 * and shared between the recall wiring (reads) and the worker wiring (invalidates).
 */
export interface CalibrationModelProvider {
	/**
	 * Thenable: `await provider` yields the current {@link CalibrationModel} (cached, or
	 * re-read when stale/invalidated). Implements `PromiseLike<CalibrationModel>` so the
	 * holder satisfies the existing `calibrationModel: Promise<CalibrationModel>` contract.
	 */
	readonly then: <T1 = CalibrationModel, T2 = never>(
		onFulfilled?: ((value: CalibrationModel) => T1 | PromiseLike<T1>) | null,
		onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
	) => Promise<T1 | T2>;

	/**
	 * Clear the cached entry so the next `await` re-reads from storage. Called by the
	 * calibration worker after a successful refit write. Never throws.
	 */
	invalidate(): void;

	/**
	 * Read-only test seam: the wall-clock time when the cached entry expires, or `0` when
	 * no entry is cached / it has been invalidated. Tests assert on this to verify the TTL
	 * + invalidation behavior without flaky timing.
	 */
	readonly cachedExpiresAt: number;
}

/** Options for {@link createCalibrationModelProvider}. All optional with production defaults. */
export interface CalibrationModelProviderOptions {
	/** The storage client the re-read runs through (never a raw fetch). */
	readonly storage: StorageQuery;
	/** The scope the re-read is partitioned by (the daemon's local-mode default scope). */
	readonly scope: QueryScope;
	/** The agent scope (defaults to the schema `'default'` / `'global'` sentinels). */
	readonly agent?: CalibrationAgentScope;
	/** The cache TTL in ms (default {@link DEFAULT_CALIBRATION_CACHE_TTL_MS}). */
	readonly ttlMs?: number;
	/** Injectable clock (tests). Defaults to `Date.now`. */
	readonly now?: Now;
}

/**
 * Read the live {@link CalibrationModel} from storage (the highest-`fit_at` row of
 * `memory_calibration`), fail-soft to {@link IDENTITY_MODEL}. Factored out of the holder
 * so it shares ONE read implementation with the prior boot-time reader (no behaviour drift).
 */
async function readLiveCalibrationModel(
	storage: StorageQuery,
	scope: QueryScope,
	agent: CalibrationAgentScope | undefined,
): Promise<CalibrationModel> {
	try {
		const res = await storage.query(buildLatestCalibrationSql(agent), scope);
		if (!isOk(res) || res.rows.length === 0) return IDENTITY_MODEL;
		const row = res.rows[0] as StorageRow;
		return deserializeModel(String(row.model_blob ?? "")); // empty blob → IDENTITY inside deserialize.
	} catch {
		return IDENTITY_MODEL; // fail-soft: cold-start identity on any read error.
	}
}

/**
 * Build the production {@link CalibrationModelProvider} (the L-W3 staleness fix). The
 * holder is thenable, so it drops into the existing `calibrationModel` slot unchanged.
 * The composition root constructs it once and shares it between:
 *   - the recall wiring (`mountMemories` reads via `await provider`),
 *   - the calibration worker (`runCalibratePass` calls `provider.invalidate()` after a write).
 */
export function createCalibrationModelProvider(
	options: CalibrationModelProviderOptions,
): CalibrationModelProvider {
	const storage = options.storage;
	const scope = options.scope;
	const agent = options.agent;
	const ttlMs = options.ttlMs ?? DEFAULT_CALIBRATION_CACHE_TTL_MS;
	const now = options.now ?? Date.now;

	// The cached entry (`undefined` until the first read, and after `invalidate()`).
	// Mutated only inside the holder's read path; reads from other async contexts see the
	// updated reference because the closure captures the variable, not its initial value.
	let entry: CacheEntry | undefined;
	// The in-flight re-read promise (thundering-herd dedupe). Set when a re-read starts,
	// cleared when it resolves. Concurrent callers `await` this same promise.
	let inflight: Promise<CalibrationModel> | undefined;
	// Generation counter — bumped on every `invalidate()`. Each in-flight read captures the
	// generation active when it STARTED; its `.then()` only populates `entry` if the generation
	// has NOT been bumped by an intervening invalidate(). This closes the race where a read
	// started BEFORE a worker write would otherwise populate `entry` with the pre-write (stale)
	// model AFTER invalidate() cleared it — serving stale data for up to ttlMs in the exact
	// concurrent scenario (recall in-flight + worker write) the holder exists to fix.
	let generation = 0;

	/**
	 * Resolve to the model the caller should see. Serves the cached entry when fresh;
	 * otherwise kicks off (or joins) a single in-flight re-read and caches its result.
	 * Never rejects — a read error resolves to IDENTITY (the cold-start contract).
	 */
	function resolveModel(): Promise<CalibrationModel> {
		const current = entry;
		if (current !== undefined && current.expiresAt > now()) {
			return Promise.resolve(current.model);
		}
		// Stale or absent. Dedupe: if a re-read is already in flight, join it.
		if (inflight !== undefined) return inflight;
		// Capture the generation active when this read STARTS. If invalidate() bumps it before the
		// read resolves, the `.then()` skips populating `entry` (the read returns the pre-write
		// model, which is now stale — the next caller will re-read fresh).
		const startGeneration = generation;
		// Start a single re-read. On resolve, populate the cache + clear the in-flight handle.
		// `readLiveCalibrationModel` is itself fail-soft (returns IDENTITY on any read error), so
		// the `.then(populate)` runs on EVERY resolution — including error-induced identity — and
		// the cache is populated for the TTL. The `.catch()` is belt-and-suspenders (defense-in-depth
		// in case a future change makes the read reject); it currently never fires.
		inflight = readLiveCalibrationModel(storage, scope, agent)
			.then((model: CalibrationModel) => {
				// Only commit the result to the cache if no invalidate() bumped the generation
				// while this read was in flight. A bumped generation means a worker write (or another
				// invalidate) happened after this read started, so the model this read returned may be
				// stale — drop it, let the next caller re-read fresh.
				if (startGeneration === generation) {
					entry = { model, expiresAt: now() + ttlMs };
				}
				inflight = undefined;
				return model;
			})
			.catch(() => {
				// Defense-in-depth: if the read ever rejects (today it can't — readLiveCalibrationModel
				// catches its own errors), resolve to IDENTITY + clear the in-flight handle. The cache
				// is NOT populated here, so the next caller would retry.
				inflight = undefined;
				return IDENTITY_MODEL;
			});
		return inflight;
	}

	return {
		then(onFulfilled, onRejected) {
			return resolveModel().then(onFulfilled, onRejected);
		},
		invalidate(): void {
			entry = undefined;
			// Bump the generation so any in-flight read whose `.then()` hasn't fired yet will NOT
			// populate `entry` with its (now-stale) result. This closes the invalidate/in-flight
			// race: a read that started before the worker write returns the pre-write model, but it
			// cannot pin that stale model into the cache — the next caller re-reads fresh.
			generation += 1;
		},
		get cachedExpiresAt(): number {
			return entry?.expiresAt ?? 0;
		},
	};
}

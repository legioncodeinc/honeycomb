/**
 * The CalibrationModelProvider — the L-W3 staleness fix (the TTL-cached, worker-invalidateable,
 * thenable holder that replaced the boot-once cached promise).
 *
 * These tests prove the FIVE load-bearing contracts of the provider:
 *
 *   1. COLD-START: an empty `memory_calibration` table yields the IDENTITY model on the first
 *      read (the fail-soft cold-start contract is preserved — recall gets `C = f`).
 *   2. TTL CACHING: within the TTL, repeated `await`s serve the CACHED model without firing a
 *      second storage query (no per-recall DB hit on the user's critical path).
 *   3. TTL EXPIRY: after the TTL elapses, the next `await` re-reads from storage (so an external
 *      writer — e.g. a manual SQL insert — is eventually observed even without invalidate()).
 *   4. INVALIDATE (the worker-write path): after `invalidate()`, the very next `await` re-reads
 *      immediately (no TTL wait) — this is the fix for "recall stale until daemon restart."
 *   5. MID-FLIGHT WRITE OBSERVED: the canonical end-to-end scenario — read cold-start identity,
 *      simulate a worker write (swap the storage's scripted row to a fitted curve), invalidate,
 *      re-read — and assert the NEW curve is observed on the SAME provider instance (no restart).
 *   6. THUNDERING-HERD DEDUPE: when the entry is stale and N callers `await` simultaneously,
 *      only ONE storage query fires (the in-flight read is shared).
 *   7. FAIL-SOFT ON READ ERROR: a storage query that throws yields IDENTITY (never rejects);
 *      the cache stays empty so the next caller retries (a transient error is not pinned).
 *
 * The provider is THENABLE, so each test `await`s it directly — the same shape the recall
 * handler (`api.ts`) uses (`await options.calibrationModel`).
 */

import { describe, expect, it } from "vitest";

import type { QueryResult, StorageRow } from "../../../../src/daemon/storage/result.js";
import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import {
	IDENTITY_MODEL,
	serializeModel,
	type CalibrationModel,
} from "../../../../src/daemon/runtime/memories/calibration.js";
import {
	createCalibrationModelProvider,
	DEFAULT_CALIBRATION_CACHE_TTL_MS,
} from "../../../../src/daemon/runtime/memories/calibration-store.js";

const SCOPE: QueryScope = { org: "local", workspace: "default" };

/** A fitted (non-identity) model the storage can return as a `model_blob`. */
const FITTED_MODEL: CalibrationModel = Object.freeze({
	identity: false,
	knots: [
		{ x: 0.2, y: 0.1 },
		{ x: 0.5, y: 0.45 },
		{ x: 0.8, y: 0.85 },
	],
});

/** A mutable fake storage: scripts the `model_blob` the latest-row read returns. */
function scriptedStorage(opts: { blob?: string; throwOnRead?: boolean }): {
	storage: StorageQuery;
	queryCount: () => number;
	setBlob: (blob: string | undefined) => void;
} {
	let queryCount = 0;
	let blob = opts.blob;
	const storage: StorageQuery = {
		async query(): Promise<QueryResult> {
			queryCount += 1;
			if (opts.throwOnRead) throw new Error("storage exploded");
			if (blob === undefined) return { kind: "ok", rows: [], durationMs: 0 } as QueryResult;
			return {
				kind: "ok",
				rows: [{ model_blob: blob }] as unknown as StorageRow[],
				durationMs: 0,
			} as QueryResult;
		},
	};
	return {
		storage,
		queryCount: () => queryCount,
		setBlob: (next) => {
			blob = next;
		},
	};
}

/** A controllable clock: starts at 0, advances only when the test calls `advance()`. */
function fakeClock() {
	let t = 0;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
		set: (ms: number) => {
			t = ms;
		},
	};
}

describe("CalibrationModelProvider — the L-W3 staleness fix", () => {
	it("COLD-START: an empty memory_calibration table yields IDENTITY on the first read", async () => {
		const { storage } = scriptedStorage({ blob: undefined });
		const provider = createCalibrationModelProvider({ storage, scope: SCOPE });
		const model = await provider;
		expect(model.identity, "cold-start returns the IDENTITY model (C = f)").toBe(true);
		expect(model.knots).toEqual([]);
	});

	it("TTL CACHING: within the TTL, repeated awaits serve the cached model without a second query", async () => {
		const clock = fakeClock();
		const { storage, queryCount } = scriptedStorage({ blob: serializeModel(FITTED_MODEL) });
		const provider = createCalibrationModelProvider({
			storage,
			scope: SCOPE,
			ttlMs: 60_000,
			now: clock.now,
		});

		const first = await provider;
		expect(queryCount(), "the first await fires one storage query").toBe(1);
		expect(first.identity).toBe(false);

		// Three more awaits within the TTL — no new queries.
		clock.advance(10_000);
		await provider;
		clock.advance(10_000);
		await provider;
		clock.advance(10_000);
		const cached = await provider;
		expect(queryCount(), "subsequent awaits within TTL serve the cache (no new query)").toBe(1);
		expect(cached, "the cached model is the same fitted curve").toBe(first);
	});

	it("TTL EXPIRY: after the TTL elapses, the next await re-reads from storage", async () => {
		const clock = fakeClock();
		const { storage, queryCount, setBlob } = scriptedStorage({ blob: serializeModel(FITTED_MODEL) });
		const provider = createCalibrationModelProvider({
			storage,
			scope: SCOPE,
			ttlMs: 60_000,
			now: clock.now,
		});

		const first = await provider;
		expect(first.identity).toBe(false);
		expect(queryCount()).toBe(1);

		// An external writer swaps the curve to a DIFFERENT fitted model.
		const NEW_MODEL: CalibrationModel = { identity: false, knots: [{ x: 0.4, y: 0.3 }] };
		setBlob(serializeModel(NEW_MODEL));

		// Within TTL — still serves the OLD cached model.
		clock.advance(30_000);
		const stale = await provider;
		expect(stale, "within TTL the external write is NOT yet observed").toBe(first);
		expect(queryCount()).toBe(1);

		// Cross the TTL — the next await re-reads and observes the NEW curve.
		clock.advance(31_000); // total elapsed: 61s > 60s TTL
		const refreshed = await provider;
		expect(queryCount(), "the TTL-expired await fires a fresh query").toBe(2);
		expect(refreshed, "the TTL-expired read observes the external write").not.toBe(first);
		expect(refreshed.knots, "the new curve's knots are the externally-written ones").toEqual(NEW_MODEL.knots);
	});

	it("INVALIDATE: after invalidate(), the next await re-reads immediately (no TTL wait)", async () => {
		const clock = fakeClock();
		const { storage, queryCount, setBlob } = scriptedStorage({ blob: serializeModel(FITTED_MODEL) });
		const provider = createCalibrationModelProvider({
			storage,
			scope: SCOPE,
			ttlMs: 60_000,
			now: clock.now,
		});

		const first = await provider;
		expect(queryCount()).toBe(1);

		// A worker write swaps the curve + invalidates.
		const NEW_MODEL: CalibrationModel = { identity: false, knots: [{ x: 0.6, y: 0.55 }] };
		setBlob(serializeModel(NEW_MODEL));
		provider.invalidate();

		// Only 1ms later (well within the 60s TTL) — the invalidate forces a re-read.
		clock.advance(1);
		const refreshed = await provider;
		expect(queryCount(), "invalidate forced a fresh query despite being within TTL").toBe(2);
		expect(refreshed.knots, "the post-invalidate read observes the worker write").toEqual(NEW_MODEL.knots);
	});

	it("MID-FLIGHT WRITE OBSERVED (the canonical end-to-end): cold-start identity → worker writes + invalidates → next read sees the new curve, same provider instance, no restart", async () => {
		const clock = fakeClock();
		// Start COLD (no model_blob → identity).
		const { storage, setBlob } = scriptedStorage({ blob: undefined });
		const provider = createCalibrationModelProvider({
			storage,
			scope: SCOPE,
			ttlMs: DEFAULT_CALIBRATION_CACHE_TTL_MS,
			now: clock.now,
		});

		// First read: cold-start identity.
		const cold = await provider;
		expect(cold, "the cold-start model is identity").toBe(IDENTITY_MODEL);
		expect(cold.identity).toBe(true);

		// Simulate the calibration worker: write a new curve to storage, then invalidate.
		setBlob(serializeModel(FITTED_MODEL));
		provider.invalidate();

		// The very next recall (same provider, no restart) observes the fitted curve.
		clock.advance(1);
		const afterRefit = await provider;
		expect(afterRefit.identity, "the post-refit model is NO LONGER identity").toBe(false);
		expect(afterRefit.knots, "the post-refit model carries the fitted knots").toEqual(FITTED_MODEL.knots);
	});

	it("THUNDERING-HERD DEDUPE: N simultaneous awaits on a stale entry fire ONE storage query", async () => {
		const clock = fakeClock();
		const { storage, queryCount } = scriptedStorage({ blob: serializeModel(FITTED_MODEL) });
		const provider = createCalibrationModelProvider({
			storage,
			scope: SCOPE,
			ttlMs: 60_000,
			now: clock.now,
		});

		// Prime the cache.
		await provider;
		expect(queryCount()).toBe(1);

		// Expire the entry + fire 5 concurrent awaits. All should share the single in-flight read.
		clock.advance(61_000);
		const results = await Promise.all([provider, provider, provider, provider, provider]);
		expect(queryCount(), "5 concurrent awaits fired exactly ONE re-read").toBe(2);
		// All 5 resolves see the same model.
		for (const m of results) {
			expect(m.knots).toEqual(FITTED_MODEL.knots);
		}
	});

	it("FAIL-SOFT ON READ ERROR: a throwing storage query resolves to IDENTITY (never rejects); cached for the TTL (no retry-storm on a broken DB)", async () => {
		const clock = fakeClock();
		const { storage, queryCount } = scriptedStorage({ blob: undefined, throwOnRead: true });
		const provider = createCalibrationModelProvider({
			storage,
			scope: SCOPE,
			ttlMs: 60_000,
			now: clock.now,
		});

		// The first await resolves (does NOT reject) to identity despite the throw. The fail-soft
		// read wrapper (`readLiveCalibrationModel`) catches the storage error and returns IDENTITY,
		// which the provider caches like any other resolved model.
		const model = await provider;
		expect(model, "a read error resolves to IDENTITY").toBe(IDENTITY_MODEL);
		expect(queryCount(), "the read was attempted").toBe(1);

		// Within the TTL, subsequent awaits serve the cached identity WITHOUT a new query. This is
		// deliberate: a broken DB should not be retry-stormed on every recall. The TTL bounds how
		// long we serve the error-induced identity before the next re-read attempt.
		clock.advance(30_000);
		await provider;
		expect(queryCount(), "within TTL, no retry (cached identity serves the call)").toBe(1);

		// After the TTL, the next await retries the read.
		clock.advance(31_000);
		await provider;
		expect(queryCount(), "after TTL, the read retries").toBe(2);
	});

	it("cachedExpiresAt test seam: 0 before first read / after invalidate; >now when cached", async () => {
		const clock = fakeClock();
		clock.set(1000);
		const { storage } = scriptedStorage({ blob: serializeModel(FITTED_MODEL) });
		const provider = createCalibrationModelProvider({
			storage,
			scope: SCOPE,
			ttlMs: 60_000,
			now: clock.now,
		});

		expect(provider.cachedExpiresAt, "before the first read, cachedExpiresAt is 0").toBe(0);

		await provider;
		expect(provider.cachedExpiresAt, "after a read, cachedExpiresAt is the future expiry").toBe(61000);

		provider.invalidate();
		expect(provider.cachedExpiresAt, "after invalidate, cachedExpiresAt resets to 0").toBe(0);
	});

	it("THENABLE contract: the provider satisfies `await` and exposes `.then` (the PromiseLike shape recall relies on)", async () => {
		const { storage } = scriptedStorage({ blob: serializeModel(FITTED_MODEL) });
		const provider = createCalibrationModelProvider({ storage, scope: SCOPE });

		// The provider is thenable (has .then) — the contract `api.ts` and the lifecycle-wiring test assert.
		expect(typeof provider.then).toBe("function");

		// `await` resolves to a CalibrationModel.
		const model = await provider;
		expect(model).toBeDefined();
		expect(Array.isArray(model.knots)).toBe(true);
	});
});

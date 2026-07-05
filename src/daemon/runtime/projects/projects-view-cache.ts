/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * A tiny TTL cache with EXPLICIT invalidation for the `scope/projects` read (PRD-062 FIX 3).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * `GET /api/diagnostics/scope/projects` was the ONE dashboard read with no cache:
 * every mount ran a registry sync (1 awaited SELECT) then a counts read (2 SELECTs),
 * so re-navigating home paid the full Deeplake cost each time (measured ~80s on the
 * user's machine). The other diagnostics reads (kpis/sessions) already memoize behind
 * a short-TTL view cache; this gives the projects read the SAME treatment.
 *
 * ── Why NOT reuse the dashboard `createTtlViewCache` ─────────────────────────
 * That helper is private to `dashboard/api.ts` and has NO invalidation hook. This
 * read MUST invalidate on bind/unbind so a freshly-bound project appears immediately
 * (not after the TTL lapses), and the cache instance is SHARED across two separately-
 * mounted route groups (the read in `scope-enumeration-api.ts`, the invalidation in
 * `onboarding-api.ts`). So this is a small purpose-built cache: a keyed TTL store plus
 * a wholesale {@link ProjectsViewCache.invalidate}, exposed through the narrow
 * {@link CacheInvalidator} interface the onboarding writer depends on.
 *
 * ── Deterministic ────────────────────────────────────────────────────────────
 * {@link ProjectsViewCache.resolve} returns `{ value, hit }` — the `hit` flag lets a
 * test assert the fast path without wall-clock timing (a hit skips `compute`).
 */

/** The narrow surface a WRITE handler (bind/unbind) needs: drop the cached view so the next read is fresh. */
export interface CacheInvalidator {
	/** Clear every cached entry so the next {@link ProjectsViewCache.resolve} recomputes. */
	invalidate(): void;
}

/** The result of a cache lookup: the value plus whether it was served from cache (`hit`) or computed. */
export interface CacheLookup<T> {
	readonly value: T;
	/** True when the value was served from a fresh-enough cache entry (compute was skipped). */
	readonly hit: boolean;
}

/**
 * A per-key, time-bounded memo with explicit invalidation. Each distinct `key` caches
 * independently for `ttlMs`; the map is bounded by `maxKeys` (cleared wholesale when
 * exceeded — a coarse but correct backstop for the handful of scopes a local dashboard
 * ever touches). Each mount gets its own instance, so it never outlives a daemon restart.
 */
export class ProjectsViewCache<T> implements CacheInvalidator {
	private readonly entries = new Map<string, { value: T; expiresAt: number }>();

	constructor(
		private readonly ttlMs: number,
		private readonly maxKeys = 64,
	) {}

	/**
	 * Return a fresh-enough value for `key` (a cache HIT skips `compute`), else compute it,
	 * store it with an absolute expiry `now + ttlMs`, and return it as a MISS. The `hit`
	 * flag makes the fast path test-observable without timing.
	 */
	async resolve(key: string, compute: () => Promise<T>): Promise<CacheLookup<T>> {
		const now = Date.now();
		const found = this.entries.get(key);
		if (found !== undefined && found.expiresAt > now) {
			return { value: found.value, hit: true };
		}
		const value = await compute();
		if (this.entries.size >= this.maxKeys && !this.entries.has(key)) this.entries.clear();
		this.entries.set(key, { value, expiresAt: now + this.ttlMs });
		return { value, hit: false };
	}

	/** Drop every cached entry (called by a bind/unbind so a fresh bind shows on the next read). */
	invalidate(): void {
		this.entries.clear();
	}
}

/** The default TTL for the projects view (short — a freshly-bound project shows on the next load). */
export const PROJECTS_VIEW_TTL_MS = 10_000;

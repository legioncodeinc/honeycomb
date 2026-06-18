/**
 * Sliding-window rate limit — PRD-011d (Wave 2, IMPLEMENTED).
 *
 * A per-caller sliding-window limiter that guards expensive routes: a caller over
 * its window on an expensive route gets `429` + a `Retry-After` header (d-AC-2).
 * `local` mode applies NO limit (d-AC-5). The limiter keys off the VALIDATED caller
 * (the {@link Identity}'s agent id), never a spoofable header.
 *
 * ── In-memory + BOUNDED (D-7 / DoS guard) ───────────────────────────────────
 * State is in-memory only (no new table — it resets on restart, which v1 accepts).
 * The per-caller window state lives in a Map that is CAPPED at `maxKeys`: when a new
 * caller would exceed the cap, the OLDEST-touched entry is evicted first. That bound
 * is the DoS guard — without it an attacker rotating caller keys would grow the Map
 * without limit (the same shape as PRD-005's capped counter). Stale entries (whose
 * whole window has expired) are also dropped lazily on touch, so the Map trends to
 * the count of genuinely-active callers, not the count of callers ever seen.
 *
 * ── Sliding window (not a fixed bucket) ─────────────────────────────────────
 * Each caller keeps the timestamps of its hits inside the current `windowMs`. On a
 * check we drop timestamps older than `now - windowMs`, then: if the surviving count
 * is `>= limit` the request is BLOCKED (and `Retry-After` is the seconds until the
 * OLDEST surviving hit ages out of the window); otherwise the hit is recorded and the
 * request is allowed. A sliding window has no fixed-bucket edge burst (2× at a
 * boundary), so the limit is honest across any alignment.
 *
 * The clock is injected so a test drives the window deterministically with a fake.
 *
 * ── Boundary ────────────────────────────────────────────────────────────────
 * This module owns the limiter + a standalone Hono middleware. The middleware's
 * `local`-skip + the per-route limit values are passed in; the actual MOUNTING onto
 * the expensive routes is deferred daemon assembly (D-9). It MUST NOT touch
 * contracts.ts, permission.ts, or credentials-store.ts (CONVENTIONS.md).
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import type { DeploymentMode } from "../config.js";

/** One caller's sliding-window state (in-memory; D-7). The bounded map evicts the oldest. */
export interface RateLimitState {
	/** The caller key (the validated identity's agent id, optionally + route class). */
	readonly key: string;
	/** The hit timestamps (ms) still inside the current window. */
	readonly hits: readonly number[];
}

/** The outcome of a rate-limit check (d-AC-2). `allowed:false` → 429 + `Retry-After`. */
export interface RateLimitDecision {
	/** Whether the request is under the limit. */
	readonly allowed: boolean;
	/** Seconds until the window frees a slot (the `Retry-After` value) when blocked. */
	readonly retryAfterSeconds?: number;
}

/** The sliding-window limiter seam 011d fills (in-memory, bounded). */
export interface RateLimiter {
	/** Check + record a hit for a caller key at `nowMs`; decide allow/429. */
	check(key: string, nowMs: number): RateLimitDecision;
	/** The number of distinct caller keys currently tracked (for the bound assertion). */
	size(): number;
}

/** A mutable per-caller bucket. `hits` is kept sorted ascending (push appends newest). */
interface Bucket {
	hits: number[];
	/** Last touch time (ms) — drives oldest-first eviction when the map is full. */
	lastTouch: number;
}

/**
 * Build the in-memory sliding-window {@link RateLimiter} (d-AC-2 / D-7).
 *
 * @param limit    max hits allowed inside a window before a request is blocked.
 * @param windowMs the window length in ms.
 * @param maxKeys  the HARD cap on tracked caller keys (the DoS bound). When a new
 *                 caller would exceed it, the least-recently-touched bucket is evicted.
 */
export function createRateLimiter(args: { limit: number; windowMs: number; maxKeys: number }): RateLimiter {
	const { limit, windowMs, maxKeys } = args;
	const buckets = new Map<string, Bucket>();

	/** Drop the least-recently-touched bucket so the map never exceeds `maxKeys` (DoS bound). */
	function evictIfFull(): void {
		if (buckets.size < maxKeys) return;
		let oldestKey: string | null = null;
		let oldestTouch = Number.POSITIVE_INFINITY;
		for (const [k, b] of buckets) {
			if (b.lastTouch < oldestTouch) {
				oldestTouch = b.lastTouch;
				oldestKey = k;
			}
		}
		if (oldestKey !== null) buckets.delete(oldestKey);
	}

	return {
		check(key: string, nowMs: number): RateLimitDecision {
			const cutoff = nowMs - windowMs;
			let bucket = buckets.get(key);

			if (bucket === undefined) {
				// A genuinely new caller — make room under the cap BEFORE inserting.
				evictIfFull();
				bucket = { hits: [], lastTouch: nowMs };
				buckets.set(key, bucket);
			}

			// Slide the window: drop every hit that has aged out (older than now - windowMs).
			if (bucket.hits.length > 0 && bucket.hits[0] <= cutoff) {
				bucket.hits = bucket.hits.filter((t) => t > cutoff);
			}
			bucket.lastTouch = nowMs;

			if (bucket.hits.length >= limit) {
				// Blocked: a slot frees when the OLDEST surviving hit leaves the window.
				const oldest = bucket.hits[0];
				const freesAtMs = oldest + windowMs;
				const retryAfterSeconds = Math.max(1, Math.ceil((freesAtMs - nowMs) / 1000));
				return { allowed: false, retryAfterSeconds };
			}

			// Allowed: record the hit (newest at the end — the array stays ascending).
			bucket.hits.push(nowMs);
			return { allowed: true };
		},
		size(): number {
			return buckets.size;
		},
	};
}

// ── The standalone Hono middleware (d-AC-2 / d-AC-5) ─────────────────────────

/** A clock seam so the middleware's window is deterministic in tests. */
export interface RateLimitClock {
	/** Current monotonic-ish time in ms. */
	nowMs(): number;
}

/** The real wall clock. */
export const systemRateLimitClock: RateLimitClock = {
	nowMs(): number {
		return Date.now();
	},
};

/** The injected dependencies for {@link createRateLimitMiddleware}. */
export interface RateLimitMiddlewareOptions {
	/** The limiter that decides allow/429 (build it with {@link createRateLimiter}). */
	readonly limiter: RateLimiter;
	/** Returns the daemon's current mode; `local` skips the limit entirely (d-AC-5). */
	readonly getMode: () => DeploymentMode;
	/**
	 * Resolve the caller key for this request — the VALIDATED identity's agent id, set
	 * upstream by the auth middleware; an unauthenticated request falls to the shared
	 * `anonymous` bucket (FR-6). Defaults to {@link defaultCallerKey}.
	 */
	readonly callerKey?: (c: Context) => string;
	/** The clock (defaults to the wall clock); a test injects a fake to drive the window. */
	readonly clock?: RateLimitClock;
}

/** The Hono context key the auth layer stashes the validated caller key under. */
export const CALLER_KEY_CONTEXT = "honeycombCallerKey" as const;

/**
 * The default caller-key resolver (FR-6). Reads the validated caller key the auth
 * middleware stashed on the context; an unauthenticated request shares one `anonymous`
 * bucket so it can never dodge the limit by simply omitting a credential. It does NOT
 * read a spoofable header — the key is the validated identity, set upstream.
 */
export function defaultCallerKey(c: Context): string {
	const fromCtx = c.get(CALLER_KEY_CONTEXT as never) as unknown;
	if (typeof fromCtx === "string" && fromCtx.length > 0) return fromCtx;
	return "anonymous";
}

/**
 * Build a standalone Hono rate-limit middleware for an expensive route (d-AC-2).
 *
 * Behaviour:
 *   - `local` mode → NO limit: the handler runs unconditionally (d-AC-5).
 *   - `team`/`hybrid` → check the per-caller sliding window; on over-limit short-circuit
 *     with `429` and a `Retry-After` header (whole seconds until a slot frees); otherwise
 *     `next()`.
 *
 * Mount this AFTER the permission middleware so the caller key is the validated identity.
 * The mounting onto the specific expensive routes is deferred daemon assembly (D-9).
 */
export function createRateLimitMiddleware(options: RateLimitMiddlewareOptions): MiddlewareHandler {
	const { limiter, getMode } = options;
	const callerKey = options.callerKey ?? defaultCallerKey;
	const clock = options.clock ?? systemRateLimitClock;

	return async (c: Context, next: Next): Promise<void | Response> => {
		// local mode applies NO rate limit (d-AC-5).
		if (getMode() === "local") {
			await next();
			return;
		}

		const decision = limiter.check(callerKey(c), clock.nowMs());
		if (!decision.allowed) {
			const retryAfter = decision.retryAfterSeconds ?? 1;
			c.header("Retry-After", String(retryAfter));
			return c.json({ error: "rate_limited", retryAfterSeconds: retryAfter }, 429);
		}
		await next();
	};
}

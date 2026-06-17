/**
 * Runtime-path negotiation middleware (PRD-004d FR-1..8, d-AC-1..7).
 *
 * ── WHAT THIS MODULE OWNS ────────────────────────────────────────────────────
 * The claim-map service (`RuntimePathService` / `createRuntimePathService`) and
 * the Hono middleware factory (`runtimePathMiddleware`) that the 004a bootstrap
 * already mounts ahead of permission on every session-scoped route group
 * (`/api/memories`, `/memory`, `/api/hooks`, `/mcp`). See `../CONVENTIONS.md §004d`.
 *
 * ── SESSION-ID CONVENTION ────────────────────────────────────────────────────
 * The session key is read from the `x-honeycomb-session` request header. This
 * follows the same `x-honeycomb-*` header namespace used by the permission
 * middleware (`x-honeycomb-org`, `x-honeycomb-role`, …) and is unambiguous: the
 * key is always present on the wire for a session-scoped request.
 *
 * ── CLAIM MAP (D-5: in-process, TTL-bounded) ─────────────────────────────────
 * Claims are stored in a plain `Map<string, ClaimEntry>`. No DeepLake; the daemon
 * is the only process, claims are session-scoped to the running daemon lifetime,
 * and the TTL ensures stale entries are freed within the sweep window (D-2).
 *
 * ── TTL + SWEEP (D-2) ────────────────────────────────────────────────────────
 * - Default TTL: 4h (14_400_000 ms).
 * - Default sweep cadence: ~5min (300_000 ms) — well under the TTL so a crashed
 *   harness frees its session promptly without flapping.
 * - Both are configurable; the clock is injectable (fake timers in tests).
 *
 * ── FAIL-CLOSED POSTURE (d-AC-7) ─────────────────────────────────────────────
 * On conflict, the middleware returns 409 WITHOUT calling `next()`. The
 * mount-ahead-of-permission order in `server.ts` guarantees the 409 fires before
 * any session handler or capture write (d-AC-7 / FR-6). If the claim service is
 * ever unavailable (throws), the request fails closed: 503, no `next()` call.
 *
 * ── HARD CAP ON REFRESH ──────────────────────────────────────────────────────
 * To prevent a rapid re-request by the claiming path from extending the claim
 * indefinitely, `last_seen_at` is updated on refresh but `claimed_at` is never
 * reset. TTL expiry is always computed from `claimed_at`. A claim is expired when
 * `now − claimed_at >= ttlMs`, regardless of `last_seen_at`.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import type { DeploymentMode } from "../config.js";

// ── Public types (kept from the Wave-1 stub; bootstrap imports these) ──────────

/** A runtime path that may claim a session. */
export type RuntimePath = "plugin" | "legacy";

/** The outcome of attempting to claim a session for a path. */
export interface ClaimResult {
	/** True when the path holds the session after this call. */
	readonly ok: boolean;
	/** The path that currently holds the session (the winner on a conflict). */
	readonly heldBy?: RuntimePath;
}

/**
 * The runtime-path claim service (004d impl). Owns the claim map,
 * TTL sweep, and diagnostics. Started/stopped by the daemon lifecycle exactly
 * like the other services (see `DaemonService` in `../services/types.js`).
 */
export interface RuntimePathService {
	/**
	 * Attempt to claim `session` for `path`. Returns `{ ok: true }` when the
	 * path holds it (fresh claim, own re-claim, or post-TTL reclaim); `{ ok:
	 * false, heldBy }` on conflict. The stub always returns ok (claims nothing).
	 */
	claim(session: string, path: RuntimePath): ClaimResult;
	/** The path currently holding `session`, or `undefined`. For diagnostics (d-AC-5). */
	activePath(session: string): RuntimePath | undefined;
	/** Lifecycle: begin TTL sweeping. No-op in the stub. */
	start(): void | Promise<void>;
	/** Lifecycle: stop sweeping and release resources. No-op in the stub. */
	stop(): void | Promise<void>;
}

// ── Internal claim entry ───────────────────────────────────────────────────────

/** An in-map claim entry. `claimed_at` is the hard cap anchor; `last_seen_at` is
 * refreshed on each re-request by the owning path but does NOT extend TTL. */
interface ClaimEntry {
	/** The runtime path that claimed this session. */
	readonly path: RuntimePath;
	/** Epoch ms at first claim — TTL is computed from this (never reset). */
	readonly claimed_at: number;
	/** Epoch ms of the last request by the owning path — for diagnostics. */
	last_seen_at: number;
}

// ── Real service factory ──────────────────────────────────────────────────────

/** Options for `createRuntimePathService`. */
export interface RuntimePathServiceOptions {
	/**
	 * Claim TTL in ms. A claim older than this is swept and the session becomes
	 * reclaimable. Defaults to 4h (14_400_000 ms) per D-2.
	 */
	readonly ttlMs?: number;
	/**
	 * Sweep interval in ms. Defaults to ~5min (300_000 ms) per D-2. The sweep
	 * cadence must be well under `ttlMs` so a crashed harness's session is freed
	 * promptly without requiring a full TTL wait.
	 */
	readonly sweepIntervalMs?: number;
	/**
	 * Monotonic clock, returns epoch ms. Injectable so tests use `vi.useFakeTimers()`
	 * (d-AC-2 / d-AC-6) without relying on real wall-clock delays. Default: `Date.now`.
	 */
	readonly clock?: () => number;
}

/** Default TTL: 4 hours. */
export const DEFAULT_TTL_MS = 14_400_000;
/** Default sweep cadence: ~5 minutes. */
export const DEFAULT_SWEEP_INTERVAL_MS = 300_000;

/**
 * Create the real runtime-path claim service.
 *
 * `claim(session, path)` semantics:
 * - **No existing claim** (or expired — sweeper may not have run yet): records a
 *   fresh claim, returns `{ ok: true }`.
 * - **Same path as existing, non-expired claim**: refreshes `last_seen_at`, returns
 *   `{ ok: true }` (d-AC-3).
 * - **Different path, non-expired claim**: returns `{ ok: false, heldBy }` (d-AC-1).
 */
export function createRuntimePathService(opts: RuntimePathServiceOptions = {}): RuntimePathService {
	const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
	const sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
	const clock = opts.clock ?? ((): number => Date.now());

	const claims = new Map<string, ClaimEntry>();
	let sweepTimer: ReturnType<typeof setInterval> | null = null;

	/** Returns true if the entry is past TTL. TTL anchors on `claimed_at` (hard cap). */
	function isExpired(entry: ClaimEntry, now: number): boolean {
		return now - entry.claimed_at >= ttlMs;
	}

	/** Remove all entries that are past TTL. Called by the sweeper + lazily in claim(). */
	function sweepExpired(): void {
		const now = clock();
		for (const [key, entry] of claims) {
			if (isExpired(entry, now)) {
				claims.delete(key);
			}
		}
	}

	return {
		claim(session: string, path: RuntimePath): ClaimResult {
			const now = clock();
			const existing = claims.get(session);

			if (existing !== undefined) {
				if (isExpired(existing, now)) {
					// Lazy expiry: treat as if the sweeper already removed it.
					claims.delete(session);
					// Fall through to fresh-claim path below.
				} else if (existing.path === path) {
					// Claiming path re-touches its own session: refresh last_seen_at only.
					// claimed_at is intentionally NOT reset (hard cap — d-AC-3 + impl note).
					existing.last_seen_at = now;
					return { ok: true };
				} else {
					// Different path — conflict (d-AC-1).
					return { ok: false, heldBy: existing.path };
				}
			}

			// Fresh claim (no entry, or just lazily expired).
			claims.set(session, { path, claimed_at: now, last_seen_at: now });
			return { ok: true };
		},

		activePath(session: string): RuntimePath | undefined {
			const now = clock();
			const entry = claims.get(session);
			if (entry === undefined) return undefined;
			if (isExpired(entry, now)) {
				// Lazy expiry for diagnostics: don't report an expired claim.
				claims.delete(session);
				return undefined;
			}
			return entry.path;
		},

		start(): void {
			if (sweepTimer !== null) return; // idempotent
			sweepTimer = setInterval(() => {
				sweepExpired();
			}, sweepIntervalMs);
			// `unref()` is available on Node.js timers: prevents the sweeper from
			// keeping the process alive when it would otherwise exit cleanly.
			if (typeof (sweepTimer as NodeJS.Timeout).unref === "function") {
				(sweepTimer as NodeJS.Timeout).unref();
			}
		},

		stop(): void {
			if (sweepTimer !== null) {
				clearInterval(sweepTimer);
				sweepTimer = null;
			}
		},
	};
}

// ── No-op stub (kept from Wave-1; bootstrap imports this as the default) ──────

/**
 * The no-op stub service the 004a bootstrap injects by default. Claims nothing,
 * conflicts with nothing, sweeps nothing. 004d swaps it for the real impl in its
 * own module + a test that constructs the daemon with the real service.
 */
export const noopRuntimePathService: RuntimePathService = {
	claim(): ClaimResult {
		return { ok: true };
	},
	activePath(): RuntimePath | undefined {
		return undefined;
	},
	start(): void {
		/* no-op stub; 004d starts the sweeper here */
	},
	stop(): void {
		/* no-op stub */
	},
};

// ── Middleware factory ────────────────────────────────────────────────────────

/**
 * Build the runtime-path Hono middleware (004d).
 *
 * Mounted by the 004a bootstrap AHEAD of the permission middleware on every
 * session-scoped group (`/api/memories`, `/memory`, `/api/hooks`, `/mcp`). The
 * mount-ahead-of-permission order is what makes the 409 fail-closed before any
 * session handler or capture write (d-AC-4 / d-AC-7 / FR-6).
 *
 * Per-request logic:
 * 1. Read `x-honeycomb-runtime-path`. Not present or not `plugin`/`legacy`
 *    → 400 Bad Request and `next()` is NOT called (d-AC-4 / FR-1).
 * 2. Read `x-honeycomb-session`. Not present or empty → 400. A session-scoped
 *    request must always carry a session id.
 * 3. Call `service.claim(session, path)`:
 *    - `ok: true` → call `next()` (claimed or refreshed).
 *    - `ok: false` → 409 Conflict, `next()` is NOT called (d-AC-1 / d-AC-7 / FR-3).
 * 4. If `service.claim()` throws → 503 Service Unavailable, fail closed.
 *
 * `getMode` is threaded through (unused in the current impl but available for
 * future mode-aware negotiation) to keep the mount signature stable.
 */
export function runtimePathMiddleware(
	service: RuntimePathService,
	getMode: () => DeploymentMode,
): MiddlewareHandler {
	// getMode is available for mode-aware extensions; suppress the unused-var
	// warning without a lint dependency by referencing it at declaration time.
	void getMode;

	return async (c: Context, next: Next): Promise<void | Response> => {
		// Step 1 — validate x-honeycomb-runtime-path (FR-1 / d-AC-4).
		const rawPath = c.req.header("x-honeycomb-runtime-path");
		if (rawPath !== "plugin" && rawPath !== "legacy") {
			return c.json(
				{
					error: "bad_request",
					reason: "x-honeycomb-runtime-path must be 'plugin' or 'legacy'",
					received: rawPath ?? null,
				},
				400,
			);
		}
		const runtimePath = rawPath satisfies RuntimePath;

		// Step 2 — validate x-honeycomb-session.
		const session = c.req.header("x-honeycomb-session");
		if (session === undefined || session.trim().length === 0) {
			return c.json(
				{
					error: "bad_request",
					reason: "x-honeycomb-session header is required for session-scoped requests",
				},
				400,
			);
		}

		// Step 3 — attempt claim. Fail closed on error (impl note).
		let result: ClaimResult;
		try {
			result = service.claim(session.trim(), runtimePath);
		} catch (err) {
			// The service failed unexpectedly. Fail closed: do NOT call next().
			const message = err instanceof Error ? err.message : "unknown error";
			return c.json(
				{
					error: "service_unavailable",
					reason: "runtime-path claim service error",
					detail: message,
				},
				503,
			);
		}

		if (!result.ok) {
			// Conflict: the other path holds this session. Do NOT call next() (d-AC-7).
			return c.json(
				{
					error: "conflict",
					reason: "session is already claimed by another runtime path",
					heldBy: result.heldBy,
				},
				409,
			);
		}

		// Claimed or refreshed — proceed to the next middleware / handler.
		await next();
	};
}

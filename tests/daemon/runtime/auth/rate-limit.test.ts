/**
 * PRD-011d — sliding-window rate limit. The d-AC the limiter owns + the window math.
 *
 * Verification posture: the limiter is driven directly with an injectable clock (fake
 * `nowMs`), and the middleware is mounted on a tiny Hono app + exercised via
 * `app.request` — in-process, no socket. No wall clock, no real daemon.
 *
 * d-AC-2 a caller over its window on an expensive route → 429 + a `Retry-After` header.
 * d-AC-5 `local` mode → NO limit applied however many requests arrive.
 * Plus: the sliding window frees a slot as hits age out; the bounded map evicts the
 *       oldest caller so it can never grow without limit (the DoS guard, D-7).
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { DeploymentMode } from "../../../../src/daemon/runtime/config.js";
import {
	CALLER_KEY_CONTEXT,
	createRateLimitMiddleware,
	createRateLimiter,
	type RateLimitClock,
} from "../../../../src/daemon/runtime/auth/rate-limit.js";

/** A fake clock whose time the test advances explicitly. */
function fakeClock(start = 0): RateLimitClock & { set: (ms: number) => void; advance: (ms: number) => void } {
	let t = start;
	return {
		nowMs: () => t,
		set: (ms: number) => {
			t = ms;
		},
		advance: (ms: number) => {
			t += ms;
		},
	};
}

/** Mount the middleware on a tiny app that stamps a fixed caller key, then 200s. */
function appWith(args: {
	mode: DeploymentMode;
	limit: number;
	windowMs: number;
	clock: RateLimitClock;
	maxKeys?: number;
	caller?: string;
}): Hono {
	const limiter = createRateLimiter({ limit: args.limit, windowMs: args.windowMs, maxKeys: args.maxKeys ?? 1000 });
	const app = new Hono();
	const caller = args.caller ?? "agent-1";
	app.use("*", async (c, next) => {
		c.set(CALLER_KEY_CONTEXT as never, caller as never);
		await next();
	});
	app.use("*", createRateLimitMiddleware({ limiter, getMode: () => args.mode, clock: args.clock }));
	app.get("/expensive", (c) => c.json({ ok: true }));
	return app;
}

describe("d-AC-2 over the sliding window on an expensive route → 429 + Retry-After", () => {
	it("allows up to the limit then 429s with a Retry-After header", async () => {
		const clock = fakeClock(0);
		const app = appWith({ mode: "team", limit: 3, windowMs: 60_000, clock });

		// 3 allowed inside the window.
		for (let i = 0; i < 3; i++) {
			const res = await app.request("/expensive");
			expect(res.status).toBe(200);
		}

		// 4th within the same window → 429 + Retry-After.
		const blocked = await app.request("/expensive");
		expect(blocked.status).toBe(429);
		const retryAfter = blocked.headers.get("Retry-After");
		expect(retryAfter).not.toBeNull();
		expect(Number(retryAfter)).toBeGreaterThan(0);
		const body = (await blocked.json()) as { error: string; retryAfterSeconds: number };
		expect(body.error).toBe("rate_limited");
		expect(body.retryAfterSeconds).toBe(Number(retryAfter));
	});

	it("frees a slot once the oldest hit ages out of the window (sliding, not fixed)", async () => {
		const clock = fakeClock(0);
		const app = appWith({ mode: "team", limit: 2, windowMs: 1000, clock });

		expect((await app.request("/expensive")).status).toBe(200); // t=0
		expect((await app.request("/expensive")).status).toBe(200); // t=0
		expect((await app.request("/expensive")).status).toBe(429); // t=0, over limit

		// Advance past the window for the first hit: a slot frees.
		clock.advance(1001);
		expect((await app.request("/expensive")).status).toBe(200);
	});
});

describe("d-AC-5 local mode applies NO rate limit", () => {
	it("never 429s in local mode no matter how many requests arrive", async () => {
		const clock = fakeClock(0);
		const app = appWith({ mode: "local", limit: 1, windowMs: 60_000, clock });
		for (let i = 0; i < 50; i++) {
			const res = await app.request("/expensive");
			expect(res.status).toBe(200);
		}
	});
});

describe("the limiter is bounded — the map evicts the oldest caller (DoS guard, D-7)", () => {
	it("never tracks more than maxKeys callers", () => {
		const limiter = createRateLimiter({ limit: 100, windowMs: 60_000, maxKeys: 3 });
		// Touch 10 distinct callers, each at a distinct (increasing) time.
		for (let i = 0; i < 10; i++) {
			limiter.check(`caller-${i}`, i);
		}
		expect(limiter.size()).toBeLessThanOrEqual(3);
	});

	it("evicting a caller does not let a different caller dodge its own limit", () => {
		const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, maxKeys: 2 });
		// Caller A hits its limit.
		expect(limiter.check("A", 0).allowed).toBe(true);
		expect(limiter.check("A", 1).allowed).toBe(true);
		expect(limiter.check("A", 2).allowed).toBe(false); // A is at limit

		// New callers churn the map (A may be evicted), but B has its own fresh budget.
		expect(limiter.check("B", 3).allowed).toBe(true);
		expect(limiter.check("C", 4).allowed).toBe(true); // forces eviction (maxKeys=2)
		expect(limiter.size()).toBeLessThanOrEqual(2);
	});
});

describe("unauthenticated callers share one anonymous bucket (FR-6)", () => {
	it("an over-limit anonymous caller still 429s (cannot dodge by omitting a credential)", async () => {
		const clock = fakeClock(0);
		// No caller key set on the context → defaultCallerKey falls to "anonymous".
		const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 1000 });
		const app = new Hono();
		app.use("*", createRateLimitMiddleware({ limiter, getMode: () => "team", clock }));
		app.get("/expensive", (c) => c.json({ ok: true }));

		expect((await app.request("/expensive")).status).toBe(200);
		expect((await app.request("/expensive")).status).toBe(429);
	});
});

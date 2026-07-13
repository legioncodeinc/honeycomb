/**
 * Embed-supervisor availability suite — ISS-023.
 *
 * The 2026-07-13 production incident: real embed timeouts during post-deploy load (cold CPU
 * model loads, 10-27s inferences saturating the child's event loop) fed recall's `reportTimeout`
 * → `checkNow` → the 2s-bounded probe missed at exactly the moments the child was provably busy
 * → the 1s confirm landed inside the same saturation window → live children were wedge-killed
 * five times → the LIFETIME `maxRestarts=5` budget exhausted → embeddings permanently off until
 * a manual daemon restart, with ZERO lifecycle events emitted (SP-3).
 *
 * This suite pins the four ISS-023 behaviours (fake clock + manual scheduler throughout):
 *   1. the restart budget SELF-HEALS: each `creditReplenishMs` of consecutive warm restores one
 *      credit — and a genuine crash-loop (never warm) exhausts exactly as fast as before;
 *   2. terminal `failed` is never permanent: exponential-backoff retries (doubling to a cap),
 *      each a normal spawn→warming cycle, with `nextRetryAt` surfaced and the state honestly
 *      `failed` until an attempt actually reaches warm;
 *   3. the item-3 regression: an ON-DEMAND (recall-timeout) probe chain confirms over the load
 *      envelope (`onDemandConfirmMs`, 30s) instead of 1s, so a live-but-slow child recovers with
 *      no kill and no burned credit — while a genuinely wedged child is still detected on both
 *      the periodic (unchanged 1s confirm) and on-demand chains;
 *   4. every transition is emitted as a structured event (probe miss with ms, suspect, wedge
 *      kill with reason, respawn with budget remaining, warm, credit replenished, budget
 *      exhausted, retry scheduled/fired) and /health carries the additive `embedSupervisor`
 *      block ({ state, restartsUsed, restartsCap, nextRetryAt? }).
 */

import { describe, expect, it } from "vitest";

import { buildHealthDetail } from "../../../../src/daemon/runtime/health.js";
import {
	type EmbedChild,
	type EmbedSupervisorClock,
	type EmbedSupervisorConfig,
	FAILED_RETRY_INITIAL_MS,
	ON_DEMAND_CONFIRM_MS,
	RESTART_CREDIT_REPLENISH_MS,
	createEmbedSupervisor,
} from "../../../../src/daemon/runtime/services/embed-supervisor.js";

/** Drain `n` microtask turns so void-fired async chains settle deterministically. */
async function drain(n = 60): Promise<void> {
	for (let i = 0; i < n; i++) await Promise.resolve();
}

/** A fake child: records kills, exposes a manual `triggerExit` so a test can crash it. */
function fakeChild(pid: number): EmbedChild & { triggerExit: (code?: number) => void; killed: string[] } {
	let exitCb: ((code: number | null, signal: string | null) => void) | null = null;
	const killed: string[] = [];
	return {
		pid,
		killed,
		onExit(cb): void {
			exitCb = cb;
		},
		kill(signal): void {
			killed.push(signal ?? "SIGTERM");
		},
		triggerExit(code = 1): void {
			exitCb?.(code, null);
		},
	};
}

/**
 * The ISS-023 fake clock: `now()` is a settable virtual instant; every `sleep(ms)` ADVANCES it
 * by `ms` and resolves immediately (so the bounded poll/backoff/confirm loops terminate without
 * wall-clock waits) while RECORDING the requested duration — the confirm-window assertions read
 * the recorded sleeps, and the credit-replenish tests advance time explicitly via `advance()`.
 */
function fakeClock(): { clock: EmbedSupervisorClock; advance: (ms: number) => void; now: () => number; sleeps: number[] } {
	let t = 0;
	const sleeps: number[] = [];
	return {
		clock: {
			sleep: async (ms: number): Promise<void> => {
				sleeps.push(ms);
				t += ms;
			},
			now: () => t,
		},
		advance: (ms) => {
			t += ms;
		},
		now: () => t,
		sleeps,
	};
}

/** A manual probe/retry scheduler: captures scheduled callbacks + delays; tests fire explicitly. */
function manualScheduler() {
	const pending: Array<{ cb: () => void; ms: number }> = [];
	return {
		pending,
		schedule(cb: () => void, ms: number): () => void {
			const entry = { cb, ms };
			pending.push(entry);
			return () => {
				const i = pending.indexOf(entry);
				if (i >= 0) pending.splice(i, 1);
			};
		},
		fire(): void {
			const entry = pending.shift();
			entry?.cb();
		},
	};
}

/** An event recorder standing in for the daemon's structured event_log seam. */
function eventRecorder() {
	const events: Array<{ name: string; fields: Record<string, unknown> }> = [];
	return {
		events,
		logger: {
			event(name: string, fields?: Record<string, unknown>): void {
				events.push({ name, fields: fields ?? {} });
			},
		},
		names(): string[] {
			return events.map((e) => e.name);
		},
		find(name: string): Record<string, unknown> | undefined {
			return events.find((e) => e.name === name)?.fields;
		},
	};
}

/**
 * A scriptable probe world: `failNext(n)` makes the next `n` probes miss (ok:false); otherwise
 * probes answer `ok:true` with the current `ready` flag. Mirrors the wedge-vs-busy physics: a
 * busy child misses while saturated then answers; a wedged child misses forever.
 */
function probeWorld(initialReady = true) {
	let fail = 0;
	let ready = initialReady;
	let calls = 0;
	return {
		failNext: (n: number) => {
			fail = n;
		},
		setReady: (r: boolean) => {
			ready = r;
		},
		calls: () => calls,
		probeHealth: async (): Promise<{ ok: boolean; ready: boolean }> => {
			calls += 1;
			if (fail > 0) {
				fail -= 1;
				return { ok: false, ready: false };
			}
			return { ok: true, ready };
		},
	};
}

/** Build a supervisor wired to the ISS-023 fakes (spawn counter + world + clock + scheduler + events). */
function makeSupervisor(config: EmbedSupervisorConfig = {}) {
	const world = probeWorld();
	const clockBox = fakeClock();
	const sched = manualScheduler();
	const rec = eventRecorder();
	const made: ReturnType<typeof fakeChild>[] = [];
	const sup = createEmbedSupervisor({
		spawnChild: () => {
			const c = fakeChild(9000 + made.length);
			made.push(c);
			return c;
		},
		probeHealth: world.probeHealth,
		clock: clockBox.clock,
		scheduleProbe: sched.schedule,
		logger: rec.logger,
		env: {},
		config,
	});
	return { sup, world, clockBox, sched, rec, made, spawns: () => made.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Self-healing restart budget (credit replenishment on sustained warm).
// ─────────────────────────────────────────────────────────────────────────────

describe("ISS-023 §1 — the restart budget self-heals on sustained warm", () => {
	/** Drive one periodic 2-miss wedge-kill cycle and re-warm (burns exactly one credit). */
	async function wedgeKillOnce(h: ReturnType<typeof makeSupervisor>): Promise<void> {
		h.world.failNext(2);
		h.sched.fire(); // the pending periodic tick
		await drain();
	}

	it("each creditReplenishMs of consecutive warm restores one credit, up to the cap", async () => {
		const h = makeSupervisor({ restartBackoffMs: 0 });
		await h.sup.start();
		await drain();
		expect(h.sup.state).toBe("warm");

		// Burn two credits via two legitimate wedge-kill cycles (each respawn re-warms).
		await wedgeKillOnce(h);
		expect(h.sup.state).toBe("warm");
		await wedgeKillOnce(h);
		expect(h.sup.state).toBe("warm");
		expect(h.sup.restarts).toBe(2);

		// Ten sustained-warm minutes → the next healthy periodic probe grants one credit back.
		h.clockBox.advance(RESTART_CREDIT_REPLENISH_MS);
		h.sched.fire();
		await drain();
		expect(h.sup.restarts).toBe(1);
		expect(h.rec.find("embed.credit_replenished")).toMatchObject({ restartsUsed: 1, restartsCap: 5 });

		// Another ten minutes → fully healed; never below zero however long warm lasts.
		h.clockBox.advance(RESTART_CREDIT_REPLENISH_MS);
		h.sched.fire();
		await drain();
		expect(h.sup.restarts).toBe(0);
		h.clockBox.advance(RESTART_CREDIT_REPLENISH_MS * 3);
		h.sched.fire();
		await drain();
		expect(h.sup.restarts).toBe(0);
		await h.sup.stop();
	});

	it("the credit clock resets on a kill: only CONSECUTIVE warm time earns", async () => {
		const h = makeSupervisor({ restartBackoffMs: 0 });
		await h.sup.start();
		await drain();

		// Nine minutes warm (no credit yet), then a wedge kill — the stretch is broken.
		await wedgeKillOnce(h); // restarts: 1 — pending periodic tick belongs to the NEW child
		h.clockBox.advance(RESTART_CREDIT_REPLENISH_MS - 60_000);
		await wedgeKillOnce(h); // restarts: 2
		expect(h.sup.restarts).toBe(2);

		// One more minute after the SECOND kill must NOT grant a credit (the pre-kill nine
		// minutes do not carry over — the anchor re-armed at the fresh warm).
		h.clockBox.advance(60_000);
		h.sched.fire();
		await drain();
		expect(h.sup.restarts).toBe(2);
		await h.sup.stop();
	});

	it("a genuine crash-loop (never reaches warm) exhausts exactly as fast as before — no replenish", async () => {
		const world = probeWorld();
		const clockBox = fakeClock();
		const sched = manualScheduler();
		const rec = eventRecorder();
		let spawns = 0;
		const sup = createEmbedSupervisor({
			spawnChild: () => {
				spawns += 1;
				return fakeChild(7000 + spawns);
			},
			probeHealth: world.probeHealth,
			clock: clockBox.clock,
			scheduleProbe: sched.schedule,
			logger: rec.logger,
			env: {},
			// A huge restart backoff in VIRTUAL time: if replenishment leaked into the not-warm
			// path, the hours that elapse across these backoffs would grant credits and the loop
			// would keep respawning past the bound.
			config: { maxRestarts: 2, restartBackoffMs: RESTART_CREDIT_REPLENISH_MS * 6, liveTimeoutMs: 200 },
		});
		world.failNext(Number.MAX_SAFE_INTEGER); // never live, never warm
		await sup.start();
		await drain(200);

		// Initial spawn + exactly maxRestarts respawns, then the bound: unchanged from #301.
		expect(spawns).toBe(3);
		expect(sup.restarts).toBe(2);
		expect(sup.failed).toBe(true);
		expect(sup.state).toBe("failed");
		expect(rec.names()).toContain("embed.restart_exhausted");
		expect(rec.names()).not.toContain("embed.credit_replenished");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Terminal `failed` is never permanent (backoff retry loop).
// ─────────────────────────────────────────────────────────────────────────────

describe("ISS-023 §2 — failed retries with exponential backoff and returns to normal on warm", () => {
	/** Exhaust the budget via a never-live crash loop; returns the harness mid-`failed`. */
	async function exhausted(config: EmbedSupervisorConfig = {}) {
		const h = makeSupervisor({ maxRestarts: 1, restartBackoffMs: 0, liveTimeoutMs: 200, ...config });
		h.world.failNext(Number.MAX_SAFE_INTEGER);
		await h.sup.start();
		await drain(120);
		expect(h.sup.state).toBe("failed");
		return h;
	}

	it("schedules the first retry at the initial backoff and surfaces nextRetryAt", async () => {
		const h = await exhausted();
		// The retry is a REAL pending timer with the 1 min initial delay, surfaced on the API
		// and mirrored in the scheduled event — the operator-visible "failed but recovering".
		const retry = h.sched.pending[h.sched.pending.length - 1]!;
		expect(retry.ms).toBe(FAILED_RETRY_INITIAL_MS);
		expect(h.sup.nextRetryAt).toBeDefined();
		expect(h.rec.find("embed.retry_scheduled")).toMatchObject({
			backoffMs: FAILED_RETRY_INITIAL_MS,
			nextRetryAt: h.sup.nextRetryAt,
		});
	});

	it("doubles the delay per failed attempt up to the cap; state stays honestly failed between attempts", async () => {
		const h = await exhausted({ failedRetryInitialMs: 60_000, failedRetryMaxMs: 240_000 });
		const delays: number[] = [h.sched.pending[h.sched.pending.length - 1]!.ms];

		// Three more failed attempts: 60s → 120s → 240s → 240s (capped, never beyond).
		for (let i = 0; i < 3; i++) {
			h.clockBox.advance(delays[delays.length - 1]!);
			h.sched.fire();
			await drain(120);
			expect(h.sup.state).toBe("failed"); // honest between (and during) attempts
			delays.push(h.sched.pending[h.sched.pending.length - 1]!.ms);
		}
		expect(delays).toEqual([60_000, 120_000, 240_000, 240_000]);
		expect(h.sup.nextRetryAt).toBeDefined();
	});

	it("a retry attempt that reaches warm returns to normal operation and resets the backoff", async () => {
		const h = await exhausted();
		expect(h.rec.names()).toContain("embed.retry_scheduled");

		// The world heals; the pending retry fires a NORMAL spawn→warming→warm cycle.
		h.world.failNext(0);
		h.world.setReady(true);
		h.sched.fire();
		await drain(120);
		expect(h.rec.names()).toContain("embed.retry_attempt");
		expect(h.sup.state).toBe("warm");
		expect(h.sup.failed).toBe(false);
		expect(h.sup.nextRetryAt).toBeUndefined();

		// Backoff reset: a FUTURE exhaustion schedules from the initial delay again, not the
		// doubled tail of the previous episode.
		h.world.failNext(Number.MAX_SAFE_INTEGER);
		h.sched.fire(); // periodic tick → 2-miss wedge kill → restarts at cap → failed again
		await drain(120);
		expect(h.sup.state).toBe("failed");
		expect(h.sched.pending[h.sched.pending.length - 1]!.ms).toBe(FAILED_RETRY_INITIAL_MS);
		await h.sup.stop();
	});

	it("stop()/setEnabled(false) cancel the pending retry — nothing respawns a deliberately-stopped embedder", async () => {
		const h = await exhausted();
		expect(h.sched.pending.length).toBeGreaterThan(0);
		await h.sup.setEnabled(false);
		expect(h.sched.pending).toHaveLength(0);
		expect(h.sup.nextRetryAt).toBeUndefined();
		const spawnsBefore = h.spawns();
		await drain();
		expect(h.spawns()).toBe(spawnsBefore);
	});

	it("a warmFailed terminal (warmup threw) also enters the retry loop instead of latching forever", async () => {
		const world = { ready: false, warmFailed: true };
		const clockBox = fakeClock();
		const sched = manualScheduler();
		const rec = eventRecorder();
		const made: ReturnType<typeof fakeChild>[] = [];
		const sup = createEmbedSupervisor({
			spawnChild: () => {
				const c = fakeChild(8000 + made.length);
				made.push(c);
				return c;
			},
			probeHealth: async () => ({ ok: true, ready: world.ready, warmFailed: world.warmFailed }),
			clock: clockBox.clock,
			scheduleProbe: sched.schedule,
			logger: rec.logger,
			env: {},
			config: { warmTimeoutMs: 500 },
		});
		await sup.start();
		await drain();
		expect(sup.state).toBe("failed");
		expect(rec.names()).toContain("embed.warm_failed");
		expect(sup.nextRetryAt).toBeDefined();

		// The transient failure clears (e.g. the model download succeeds on retry): the retry
		// tears the dead-warm child down, respawns, and the fresh warmup completes.
		world.warmFailed = false;
		world.ready = true;
		sched.fire();
		await drain(120);
		expect(made.length).toBe(2);
		expect(made[0]!.killed.length).toBeGreaterThanOrEqual(1);
		expect(sup.state).toBe("warm");
		expect(sup.failed).toBe(false);
		await sup.stop();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The item-3 regression: on-demand probe chains confirm over the load envelope.
// ─────────────────────────────────────────────────────────────────────────────

describe("ISS-023 §3 — a live-but-slow child is not killed by a recall-timeout-triggered probe", () => {
	it("checkNow miss confirms after onDemandConfirmMs (30s), not 1s — busy child recovers, no kill, no credit burned", async () => {
		const h = makeSupervisor({});
		await h.sup.start();
		await drain();
		expect(h.sup.state).toBe("warm");

		// The incident shape: an embed burned recall's deadline BECAUSE the child is saturated
		// (10-27s CPU inference between FIFO yields). recall fires reportTimeout → checkNow. The
		// first bounded probe misses — the child is busy, not dead.
		h.world.failNext(1);
		h.sup.checkNow?.();
		await drain();

		// The suspect confirm window spanned the load envelope: the chain slept 30s (during
		// which recall's gate sends the child NO new embeds — the quiet window that lets a busy
		// child drain), and the confirm probe then answered → recovered. No kill, no respawn,
		// no restart credit burned.
		expect(h.rec.find("embed.suspect")).toMatchObject({ trigger: "on_demand", confirmDelayMs: ON_DEMAND_CONFIRM_MS });
		expect(h.clockBox.sleeps).toContain(ON_DEMAND_CONFIRM_MS);
		expect(h.rec.names()).toContain("embed.recovered");
		expect(h.rec.names()).not.toContain("embed.wedged");
		expect(h.spawns()).toBe(1);
		expect(h.sup.restarts).toBe(0);
		expect(h.sup.state).toBe("warm");
		await h.sup.stop();
	});

	it("the PERIODIC chain keeps its tight 1s confirm — #301 wedge-detection latency is not loosened", async () => {
		const h = makeSupervisor({});
		await h.sup.start();
		await drain();

		h.world.failNext(2);
		h.sched.fire(); // periodic tick → miss → 1s confirm → miss → wedge kill
		await drain();
		expect(h.rec.find("embed.suspect")).toMatchObject({ trigger: "periodic", confirmDelayMs: 1_000 });
		expect(h.clockBox.sleeps).toContain(1_000);
		expect(h.rec.names()).toContain("embed.wedged");
		expect(h.spawns()).toBe(2); // killed + respawned via the existing bounded machinery
		await h.sup.stop();
	});

	it("a GENUINELY wedged child still fails the long on-demand confirm and is killed (detection preserved)", async () => {
		const h = makeSupervisor({});
		await h.sup.start();
		await drain();

		// Wedged for real: it misses BOTH probes of the chain — including the one fired after
		// 30 quiet seconds with no new embed work (the busy-vs-wedged discriminator). The
		// replacement child is healthy (exactly two misses), so the respawn re-warms normally.
		h.world.failNext(2);
		h.sup.checkNow?.();
		await drain();
		expect(h.rec.find("embed.wedged")).toMatchObject({ trigger: "on_demand", reason: "liveness_confirmed_miss" });
		expect(h.spawns()).toBe(2); // the respawn transitioned through warming per the existing machinery
		await h.sup.stop();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Observability: every transition emits, and /health carries the supervisor block.
// ─────────────────────────────────────────────────────────────────────────────

describe("ISS-023 §4 — every supervisor transition is a structured event; /health block shape", () => {
	it("emits the full lifecycle: spawn → live → warm → probe_miss(ms) → suspect → wedge(reason) → restart(budget) → warm → credit_replenished → exhausted → retry_scheduled → retry_attempt", async () => {
		const h = makeSupervisor({ maxRestarts: 1, restartBackoffMs: 0, liveTimeoutMs: 200 });
		await h.sup.start();
		await drain();

		// One wedge-kill + re-warm cycle (burns the single credit).
		h.world.failNext(2);
		h.sched.fire();
		await drain();
		expect(h.sup.state).toBe("warm");

		// Sustained warm → the credit heals back.
		h.clockBox.advance(RESTART_CREDIT_REPLENISH_MS);
		h.sched.fire();
		await drain();

		// Then the child dies for good → exhaustion → backoff retry scheduled → retry fires.
		h.world.failNext(Number.MAX_SAFE_INTEGER);
		h.sched.fire();
		await drain(200);
		h.clockBox.advance(FAILED_RETRY_INITIAL_MS);
		h.sched.fire();
		await drain(200);

		const names = h.rec.names();
		for (const expected of [
			"embed.spawned",
			"embed.live",
			"embed.warm",
			"embed.probe_miss",
			"embed.suspect",
			"embed.wedged",
			"embed.restart",
			"embed.credit_replenished",
			"embed.restart_exhausted",
			"embed.retry_scheduled",
			"embed.retry_attempt",
		]) {
			expect(names).toContain(expected);
		}

		// Key fields: the miss carries its elapsed ms + trigger + which of the 2-miss pair it
		// was; the respawn carries the remaining budget; warm carries the budget snapshot.
		expect(h.rec.find("embed.probe_miss")).toMatchObject({ trigger: "periodic", consecutive: 1 });
		expect(typeof h.rec.find("embed.probe_miss")?.elapsedMs).toBe("number");
		expect(h.rec.find("embed.restart")).toMatchObject({ attempt: 1, budgetRemaining: 0 });
		expect(h.rec.find("embed.warm")).toMatchObject({ restartsCap: 1 });
		expect(h.rec.find("embed.restart_exhausted")).toMatchObject({ restartsCap: 1 });
		expect(typeof h.rec.find("embed.retry_scheduled")?.nextRetryAt).toBe("number");
	});

	it("buildHealthDetail surfaces the additive embedSupervisor block verbatim (with nextRetryAt only while pending)", () => {
		const withRetry = buildHealthDetail({
			status: "ok",
			embeddingsEnabled: true,
			embeddingsFailed: true,
			embedSupervisor: { state: "failed", restartsUsed: 5, restartsCap: 5, nextRetryAt: 1_752_400_000_000 },
		});
		expect(withRetry.reasons?.embedSupervisor).toEqual({
			state: "failed",
			restartsUsed: 5,
			restartsCap: 5,
			nextRetryAt: 1_752_400_000_000,
		});

		const warm = buildHealthDetail({
			status: "ok",
			embeddingsEnabled: true,
			embeddingsWarm: true,
			embedSupervisor: { state: "warm", restartsUsed: 2, restartsCap: 5 },
		});
		expect(warm.reasons?.embedSupervisor).toEqual({ state: "warm", restartsUsed: 2, restartsCap: 5 });
		expect(warm.reasons?.embedSupervisor?.nextRetryAt).toBeUndefined();

		// Legacy callers that wire no supervisor block: the reason is simply absent (additive).
		const legacy = buildHealthDetail({ status: "ok", embeddingsEnabled: true });
		expect(legacy.reasons?.embedSupervisor).toBeUndefined();
	});

	it("the live supervisor exposes restartsCap + nextRetryAt for the /health block", async () => {
		const h = makeSupervisor({ maxRestarts: 1, restartBackoffMs: 0, liveTimeoutMs: 200 });
		expect(h.sup.restartsCap).toBe(1);
		expect(h.sup.nextRetryAt).toBeUndefined();
		h.world.failNext(Number.MAX_SAFE_INTEGER);
		await h.sup.start();
		await drain(120);
		expect(h.sup.state).toBe("failed");
		expect(h.sup.nextRetryAt).toBe(h.clockBox.now() + FAILED_RETRY_INITIAL_MS);
	});
});

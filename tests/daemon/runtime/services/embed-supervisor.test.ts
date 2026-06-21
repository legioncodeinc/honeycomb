/**
 * Embed-daemon supervisor suite — PRD-025 Wave 2 (D-6 / AC-1 second half / AC-5 plumbing).
 *
 * Drives the supervisor against a FAKE child process + a scripted `/health` probe —
 * no real model, no 600 MB, no real spawn. Proves the D-6 contract:
 *   - spawns on start, waits (bounded) for liveness, warms OFF the turn path (D-3);
 *   - crash-restarts with a BOUNDED count (D-6) — a crash loop never wedges;
 *   - stops on stop (lifecycle-owned), kills the child;
 *   - a never-starting child leaves the supervisor not-live (recall degrades, not hangs);
 *   - the opt-out (`HONEYCOMB_EMBEDDINGS=false`) makes it inert (no spawn);
 *   - the deliberate restart (AC-5 toggle) tears down + respawns and resets the bound.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	type EmbedChild,
	type EmbedSupervisorClock,
	createEmbedSupervisor,
	scrubChildEnv,
} from "../../../../src/daemon/runtime/services/embed-supervisor.js";

/** An instant clock so the bounded poll/backoff loops never wall-clock-wait in the suite. */
const instantClock: EmbedSupervisorClock = {
	sleep: async () => {
		/* no wait */
	},
	now: (() => {
		// Monotonically advance so the bounded `now() < deadline` loops terminate after a
		// finite number of polls instead of spinning forever on a frozen clock.
		let t = 0;
		return () => {
			t += 50;
			return t;
		};
	})(),
};

/** A fake child: records kills, exposes a manual `triggerExit` so a test can crash it. */
function fakeChild(pid = 1234): EmbedChild & { triggerExit: (code?: number) => void; killed: string[] } {
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

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.HONEYCOMB_EMBEDDINGS;
});

describe("AC-1/D-6 the supervisor spawns + becomes live on start", () => {
	it("spawns one child and reports live once /health answers", async () => {
		const child = fakeChild();
		const spawnChild = vi.fn(() => child);
		// Health: ok immediately (live), ready true on the second poll (warm later).
		const probeHealth = vi
			.fn<[], Promise<{ ok: boolean; ready: boolean }>>()
			.mockResolvedValueOnce({ ok: true, ready: false })
			.mockResolvedValue({ ok: true, ready: true });

		const sup = createEmbedSupervisor({
			spawnChild,
			probeHealth,
			clock: instantClock,
			env: {},
		});
		await sup.start();

		expect(spawnChild).toHaveBeenCalledTimes(1);
		expect(sup.live).toBe(true);
		expect(sup.disabled).toBe(false);
	});

	it("D-3: warmup runs OFF the start path — start resolves before the model reports warm", async () => {
		const child = fakeChild();
		// `ok:true` (live) immediately, but `ready:false` forever — the warm wait never completes.
		const probeHealth = vi.fn(async () => ({ ok: true, ready: false }));
		const sup = createEmbedSupervisor({
			spawnChild: () => child,
			probeHealth,
			clock: instantClock,
			env: {},
			config: { warmTimeoutMs: 200 },
		});
		// start() resolves even though the model never warms — proof warm is not on the turn path.
		await sup.start();
		expect(sup.live).toBe(true);
		expect(sup.warm).toBe(false);
		await sup.stop();
	});
});

describe("D-6 bounded crash-restart", () => {
	it("respawns on crash, up to the bounded max, then gives up (never a wedged daemon)", async () => {
		let spawns = 0;
		const children: ReturnType<typeof fakeChild>[] = [];
		const spawnChild = vi.fn(() => {
			spawns += 1;
			const c = fakeChild(1000 + spawns);
			children.push(c);
			return c;
		});
		const probeHealth = vi.fn(async () => ({ ok: true, ready: false }));
		const sup = createEmbedSupervisor({
			spawnChild,
			probeHealth,
			clock: instantClock,
			env: {},
			config: { maxRestarts: 2, restartBackoffMs: 0, warmTimeoutMs: 50 },
		});
		await sup.start();
		expect(spawns).toBe(1);

		// Crash the first child → restart #1.
		children[0].triggerExit(1);
		await Promise.resolve();
		await Promise.resolve();
		expect(spawns).toBe(2);
		expect(sup.restarts).toBe(1);

		// Crash the second → restart #2 (the bound).
		children[1].triggerExit(1);
		await Promise.resolve();
		await Promise.resolve();
		expect(spawns).toBe(3);
		expect(sup.restarts).toBe(2);

		// Crash the third → bound exhausted, NO further respawn (crash loop bounded).
		children[2].triggerExit(1);
		await Promise.resolve();
		await Promise.resolve();
		expect(spawns).toBe(3);
		await sup.stop();
	});
});

describe("AC-5 plumbing: stop + deliberate restart", () => {
	it("stop() kills the child and the supervisor reports not-live", async () => {
		const child = fakeChild();
		const sup = createEmbedSupervisor({
			spawnChild: () => child,
			probeHealth: async () => ({ ok: true, ready: true }),
			clock: instantClock,
			env: {},
		});
		await sup.start();
		expect(sup.live).toBe(true);
		await sup.stop();
		expect(child.killed.length).toBeGreaterThanOrEqual(1);
		expect(sup.live).toBe(false);
	});

	it("restart() tears down + respawns and resets the bounded restart count (the live toggle)", async () => {
		let spawns = 0;
		const made: ReturnType<typeof fakeChild>[] = [];
		const sup = createEmbedSupervisor({
			spawnChild: () => {
				spawns += 1;
				const c = fakeChild(2000 + spawns);
				made.push(c);
				return c;
			},
			probeHealth: async () => ({ ok: true, ready: true }),
			clock: instantClock,
			env: {},
		});
		await sup.start();
		expect(spawns).toBe(1);

		await sup.restart();
		// A fresh child was spawned and the old one was killed (kill → degrade → restart → back).
		expect(spawns).toBe(2);
		expect(made[0].killed.length).toBeGreaterThanOrEqual(1);
		expect(sup.restarts).toBe(0);
		await sup.stop();
	});
});

describe("D-1 opt-out + D-4 never-hang", () => {
	it("HONEYCOMB_EMBEDDINGS=false → the supervisor is inert: never spawns", async () => {
		const spawnChild = vi.fn(() => fakeChild());
		const sup = createEmbedSupervisor({
			spawnChild,
			probeHealth: async () => ({ ok: true, ready: true }),
			clock: instantClock,
			env: { HONEYCOMB_EMBEDDINGS: "false" },
		});
		expect(sup.disabled).toBe(true);
		await sup.start();
		expect(spawnChild).not.toHaveBeenCalled();
		expect(sup.live).toBe(false);
		await sup.stop();
	});

	it("a never-live child leaves the supervisor not-live (recall degrades, never hangs)", async () => {
		// `ok:false` forever → the bounded liveness wait expires; the child is treated as crashed.
		const probeHealth = vi.fn(async () => ({ ok: false, ready: false }));
		const sup = createEmbedSupervisor({
			spawnChild: () => fakeChild(),
			probeHealth,
			clock: instantClock,
			env: {},
			config: { liveTimeoutMs: 200, maxRestarts: 0, restartBackoffMs: 0 },
		});
		// start() RESOLVES (does not hang) even though the child never answers /health.
		await sup.start();
		expect(sup.live).toBe(false);
		await sup.stop();
	});
});

describe("scrubChildEnv (security: DeepLake credentials never enter the embed child)", () => {
	it("strips every DeepLake/Activeloop credential var while keeping what the child needs", () => {
		const env: NodeJS.ProcessEnv = {
			HONEYCOMB_DEEPLAKE_TOKEN: "eyJ-secret-jwt",
			HONEYCOMB_DEEPLAKE_ENDPOINT: "https://app.activeloop.ai",
			HONEYCOMB_DEEPLAKE_ORG: "acme",
			HONEYCOMB_DEEPLAKE_WORKSPACE: "ws",
			HONEYCOMB_TOKEN: "legacy-secret",
			// Everything the embed child legitimately reads must SURVIVE the scrub.
			HOME: "/home/dev",
			USERPROFILE: "C:/Users/dev",
			PATH: "/usr/bin",
			HONEYCOMB_EMBED_PORT: "3851",
			HONEYCOMB_EMBED_CACHE_DIR: "/cache",
			HONEYCOMB_EMBEDDINGS: "true",
		};
		const scrubbed = scrubChildEnv(env);

		// No credential leaks into the child.
		expect(scrubbed.HONEYCOMB_DEEPLAKE_TOKEN).toBeUndefined();
		expect(scrubbed.HONEYCOMB_DEEPLAKE_ENDPOINT).toBeUndefined();
		expect(scrubbed.HONEYCOMB_DEEPLAKE_ORG).toBeUndefined();
		expect(scrubbed.HONEYCOMB_DEEPLAKE_WORKSPACE).toBeUndefined();
		expect(scrubbed.HONEYCOMB_TOKEN).toBeUndefined();

		// The child still gets everything it needs to run + warm.
		expect(scrubbed.HOME).toBe("/home/dev");
		expect(scrubbed.USERPROFILE).toBe("C:/Users/dev");
		expect(scrubbed.PATH).toBe("/usr/bin");
		expect(scrubbed.HONEYCOMB_EMBED_PORT).toBe("3851");
		expect(scrubbed.HONEYCOMB_EMBED_CACHE_DIR).toBe("/cache");
		expect(scrubbed.HONEYCOMB_EMBEDDINGS).toBe("true");
	});

	it("does not mutate the caller's env (pure copy)", () => {
		const env: NodeJS.ProcessEnv = { HONEYCOMB_DEEPLAKE_TOKEN: "eyJ-secret-jwt" };
		const scrubbed = scrubChildEnv(env);
		// The source still holds the token; only the returned copy is scrubbed.
		expect(env.HONEYCOMB_DEEPLAKE_TOKEN).toBe("eyJ-secret-jwt");
		expect(scrubbed.HONEYCOMB_DEEPLAKE_TOKEN).toBeUndefined();
		expect(scrubbed).not.toBe(env);
	});
});

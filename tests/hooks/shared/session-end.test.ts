/**
 * PRD-019b session-end suite — b-AC-5 (FR-6).
 *
 * Driven against the recording fakes. b-AC-5 asserts: mark+usage+skillify is a
 * daemon call; the per-session lock is acquired BEFORE the detached spawn; and when
 * the spawn THROWS before the worker takes ownership, the lock is RELEASED so
 * `--resume` retriggers. No real process is launched; no real lock file is touched.
 */

import { describe, expect, it } from "vitest";

import {
	createFakeContextRenderer,
	createFakeCredentialReader,
	createFakeDaemonHookClient,
	createFakeSummaryLock,
	type HookCoreDeps,
	type HookInput,
} from "../../../src/hooks/shared/contracts.js";
import { createFakeSummarySpawn, runSessionEnd } from "../../../src/hooks/shared/session-end.js";

function deps(daemon = createFakeDaemonHookClient()): { deps: HookCoreDeps; daemon: ReturnType<typeof createFakeDaemonHookClient> } {
	return {
		daemon,
		deps: {
			daemon,
			credentials: createFakeCredentialReader(),
			context: createFakeContextRenderer(),
		},
	};
}

const END: HookInput = {
	event: "session-end",
	meta: { sessionId: "sess-9", path: "conv-9", agent: "claude-code" },
	data: { reason: "Stop" },
	runtimePath: "plugin",
};

describe("PRD-019b session-end core", () => {
	it("b-AC-5: marks ended + usage + skillify (daemon), acquires lock, spawns detached worker", async () => {
		const { deps: d, daemon } = deps();
		const spawn = createFakeSummarySpawn();
		const lock = createFakeSummaryLock();

		const result = await runSessionEnd(END, d, spawn, lock);

		expect(result.ok).toBe(true);
		// One daemon call carrying the three intents (mark/usage/skillify).
		expect(daemon.calls).toHaveLength(1);
		expect(daemon.calls[0].endpoint).toBe("session-end");
		expect((daemon.calls[0].body as { intents: string[] }).intents).toEqual(["mark-ended", "record-usage", "skillify"]);
		// Lock acquired for the session, then the detached worker spawned (in order).
		expect(lock.acquired).toEqual(["sess-9"]);
		expect(spawn.spawns).toEqual(["sess-9"]);
		// No release on the happy path (the worker took ownership).
		expect(lock.released).toEqual([]);
	});

	it("b-AC-5: a spawn throw RELEASES the lock so --resume can retrigger", async () => {
		const { deps: d } = deps();
		const spawn = createFakeSummarySpawn({ throwOnSpawn: true });
		const lock = createFakeSummaryLock();

		const result = await runSessionEnd(END, d, spawn, lock);

		expect(result.ok).toBe(false);
		expect(result.reason).toBe("summary-spawn-failed");
		// Acquired, then released on the throw — the retrigger path (b-AC-5).
		expect(lock.acquired).toEqual(["sess-9"]);
		expect(lock.released).toEqual(["sess-9"]);
		// The worker never recorded a successful spawn.
		expect(spawn.spawns).toEqual([]);
	});

	it("b-AC-5: an already-held lock SKIPS the spawn (no double-spawn)", async () => {
		const { deps: d } = deps();
		const spawn = createFakeSummarySpawn();
		const lock = createFakeSummaryLock({ acquirable: false });

		const result = await runSessionEnd(END, d, spawn, lock);

		expect(result.ok).toBe(true);
		expect(result.reason).toBe("summary-lock-held");
		expect(spawn.spawns).toEqual([]);
		expect(lock.released).toEqual([]);
	});

	it("FR-6: a daemon mark/usage/skillify failure never blocks the summary spawn", async () => {
		// The daemon call rejects, but the lock+spawn (the durability path) still runs.
		const rejecting = {
			async send(): Promise<never> {
				throw new Error("daemon down");
			},
		};
		const d: HookCoreDeps = {
			daemon: rejecting as unknown as HookCoreDeps["daemon"],
			credentials: createFakeCredentialReader(),
			context: createFakeContextRenderer(),
		};
		const spawn = createFakeSummarySpawn();
		const lock = createFakeSummaryLock();

		const result = await runSessionEnd(END, d, spawn, lock);
		expect(result.ok).toBe(true);
		expect(spawn.spawns).toEqual(["sess-9"]);
	});
});

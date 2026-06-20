/**
 * PRD-021b b-AC-3 — a storage verb auto-starts a down daemon before dispatching.
 *
 * Proves the dispatcher's ensure-running guard: when a storage verb runs and the daemon is down,
 * the bound lifecycle's `start()` fires and the verb completes (reaches the daemon seam) rather
 * than failing with ECONNREFUSED. When no lifecycle is bound (a plain handler test) the storage
 * verb is unchanged — the guard is skipped entirely (the existing handler tests still pass).
 */

import { describe, expect, it } from "vitest";

import {
	type CommandDeps,
	type DaemonLifecycle,
	type DaemonStatus,
	createDispatcher,
	createFakeDaemonClient,
} from "../../src/commands/index.js";

function fakeLifecycle(): DaemonLifecycle & { started: number } {
	const state = { started: 0 };
	const lifecycle: DaemonLifecycle = {
		async start() {
			state.started += 1;
			return { started: true, alreadyRunning: false };
		},
		async stop() {
			return { stopped: true };
		},
		async status(): Promise<DaemonStatus> {
			return { running: true, port: 3850 };
		},
	};
	return Object.assign(lifecycle, state, {
		get started() {
			return state.started;
		},
	}) as DaemonLifecycle & { started: number };
}

describe("PRD-021b b-AC-3 — storage verb ensure-running at dispatch", () => {
	it("b-AC-3 a storage verb with a DOWN daemon auto-starts it, then dispatches", async () => {
		// A client that is down until start() flips it up (so the verb proceeds after the auto-start).
		let up = false;
		const calls: string[] = [];
		const daemon = {
			async send(req: { method: string; path: string }) {
				calls.push(`${req.method} ${req.path}`);
				return { status: 200, body: { ok: true } };
			},
			async ping() {
				return up;
			},
		};
		const lifecycle: DaemonLifecycle = {
			async start() {
				up = true;
				return { started: true, alreadyRunning: false };
			},
			async stop() {
				return { stopped: true };
			},
			async status(): Promise<DaemonStatus> {
				return { running: true, port: 3850 };
			},
		};
		const deps: CommandDeps = { daemon, lifecycle, out: () => {} };
		const d = createDispatcher();
		const res = await d.dispatch(d.parse(["recall", "find", "me", "a", "memory"]), deps);
		expect(res.exitCode).toBe(0);
		// The storage verb actually reached the daemon seam (proof it did not fail with ECONNREFUSED).
		expect(calls).toContain("POST /api/memories/recall");
	});

	it("b-AC-3 surfaces a clear error (not ECONNREFUSED) when auto-start fails", async () => {
		const lines: string[] = [];
		const lifecycle: DaemonLifecycle = {
			async start() {
				return { started: false, alreadyRunning: false };
			},
			async stop() {
				return { stopped: false };
			},
			async status(): Promise<DaemonStatus> {
				return { running: false, port: 3850 };
			},
		};
		const deps: CommandDeps = {
			daemon: createFakeDaemonClient({ alive: false }),
			lifecycle,
			out: (l) => lines.push(l),
		};
		const d = createDispatcher();
		const res = await d.dispatch(d.parse(["recall", "x"]), deps);
		expect(res.exitCode).toBe(1);
		expect(lines.join("\n")).toMatch(/could not reach the daemon on 127\.0\.0\.1:3850/);
	});

	it("b-AC-3 with NO lifecycle bound, the storage verb is unchanged (guard skipped)", async () => {
		const daemon = createFakeDaemonClient({ alive: false });
		const deps: CommandDeps = { daemon, out: () => {} };
		const d = createDispatcher();
		const res = await d.dispatch(d.parse(["recall", "x"]), deps);
		// No lifecycle → no ensure-running → the verb dispatches straight through (existing behavior).
		expect(res.exitCode).toBe(0);
		expect(daemon.calls.map((c) => `${c.req.method} ${c.req.path}`)).toContain("POST /api/memories/recall");
	});
});

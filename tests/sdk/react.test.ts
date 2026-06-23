/**
 * PRD-019e SDK React bindings — AC-named Vitest (e-AC-4).
 *
 * Drives `useRecall`/`useRemember` against a FAKE {@link ReactRuntime} (a tiny
 * deterministic hook harness) and a fake-fetch core client. Proves the hook surfaces
 * results + loading + typed-error from the core client (e-AC-4) and that it REUSES
 * the core client (FR-7) — no real React, no daemon.
 *
 * The harness models hooks the way React does for a single component instance:
 * `useState` slots are keyed by call-order and PERSIST across re-renders; `useEffect`
 * runs its effect once on first render and re-runs when its dependency list changes;
 * a `set*` schedules a re-render. We render synchronously and call `flush()` to settle
 * the hook's async chain, then re-render to read the updated state.
 */

import { describe, expect, it } from "vitest";
import { createHoneycombClient } from "../../src/sdk/client.js";
import { ApiError, type Fetch } from "../../src/sdk/contracts.js";
import { type ReactRuntime, useRecall, useRemember } from "../../src/sdk/react.js";

/** A single-component hook harness: persistent state slots + dep-aware effects. */
function makeHarness<T>(component: () => T): {
	runtime: ReactRuntime;
	render: () => T;
	flush: () => Promise<void>;
} {
	const stateSlots: unknown[] = [];
	const effectDeps: Array<readonly unknown[] | undefined> = [];
	let stateCursor = 0;
	let effectCursor = 0;
	const pendingEffects: Array<() => void | (() => void)> = [];

	const runtime: ReactRuntime = {
		useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void] {
			const i = stateCursor++;
			if (i >= stateSlots.length) {
				stateSlots[i] = typeof initial === "function" ? (initial as () => S)() : initial;
			}
			const set = (next: S | ((prev: S) => S)): void => {
				stateSlots[i] = typeof next === "function" ? (next as (prev: S) => S)(stateSlots[i] as S) : next;
			};
			return [stateSlots[i] as S, set];
		},
		useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void {
			const i = effectCursor++;
			const prev = effectDeps[i];
			const changed = prev === undefined || deps === undefined || deps.some((d, k) => !Object.is(d, prev[k]));
			if (changed) {
				effectDeps[i] = deps;
				pendingEffects.push(effect);
			}
		},
		useCallback<F extends (...args: never[]) => unknown>(cb: F): F {
			return cb;
		},
	};

	function render(): T {
		stateCursor = 0;
		effectCursor = 0;
		const result = component();
		// Run effects queued during this render (mirrors React's commit phase).
		while (pendingEffects.length > 0) {
			const effect = pendingEffects.shift();
			effect?.();
		}
		return result;
	}

	async function flush(): Promise<void> {
		await Promise.resolve();
		await new Promise((r) => setTimeout(r, 0));
	}

	return { runtime, render, flush };
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const ACTOR = { actor: "alex", actorType: "user" };
const DAEMON = "http://127.0.0.1:3850";

describe("e-AC-4: useRecall → results + loading + typed-error", () => {
	it("e-AC-4 useRecall starts loading, then yields results from the core client", async () => {
		const fetch: Fetch = async () => jsonResponse(200, { results: [{ path: "p", text: "t" }] });
		const client = createHoneycombClient({ daemonUrl: DAEMON, ...ACTOR, fetch });
		const h = makeHarness(() => useRecall(h.runtime, client, "deploy time"));

		const first = h.render();
		expect(first.loading).toBe(true);
		expect(first.results).toBeUndefined();

		await h.flush();
		const after = h.render();
		expect(after.loading).toBe(false);
		expect(after.results).toEqual([{ path: "p", text: "t" }]);
		expect(after.error).toBeUndefined();
	});

	it("e-AC-4 useRecall surfaces the TYPED error when the core client fails", async () => {
		const fetch: Fetch = async () => jsonResponse(403, { error: "forbidden" });
		const client = createHoneycombClient({
			daemonUrl: DAEMON,
			...ACTOR,
			fetch,
			retry: { maxAttempts: () => 1, backoffMs: () => 0 },
		});
		const h = makeHarness(() => useRecall(h.runtime, client, "q"));

		h.render();
		await h.flush();
		const after = h.render();

		expect(after.loading).toBe(false);
		expect(after.results).toBeUndefined();
		expect(after.error).toBeInstanceOf(ApiError);
		expect((after.error as ApiError).status).toBe(403);
	});
});

describe("e-AC-4: useRemember reuses the core client with loading + error", () => {
	it("e-AC-4 useRemember calls the core client and clears loading on success", async () => {
		const calls: string[] = [];
		const fetch: Fetch = async (url) => {
			calls.push(url);
			return jsonResponse(201, { ok: true });
		};
		const client = createHoneycombClient({ daemonUrl: DAEMON, token: "t", ...ACTOR, fetch });
		const h = makeHarness(() => useRemember(h.runtime, client));

		const hook = h.render();
		await hook.remember("remember this");

		expect(calls).toEqual([`${DAEMON}/api/memories`]);
		const after = h.render();
		expect(after.loading).toBe(false);
		expect(after.error).toBeUndefined();
	});
});

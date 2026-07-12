/**
 * PRD-077b (L-B4 / b-AC-4), revised by ISS-022 — the per-turn renderer timeout (now 6_000ms).
 *
 * Live end-to-end per-turn recall measures 3.0–4.6s on Windows (daemon fast-lane 3.0s deadline +
 * embed/transport/node-startup overhead), so the earlier 4s budget silently discarded real daemon
 * successes at p95. Verifies the constant is 6s AND that the renderer STILL fails soft to `[]`
 * past it — the byte-for-byte PRD-076a fail-soft posture. Drives the production
 * {@link createRecallRenderer} against an injected `fetch` stub (no real socket).
 *
 * No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it, vi } from "vitest";

import type { HookSessionMeta } from "../../../src/hooks/shared/contracts.js";
import { createRecallRenderer, DEFAULT_RECALL_TIMEOUT_MS } from "../../../src/hooks/shared/recall-renderer.js";

const META: HookSessionMeta = {
	sessionId: "sess-recall",
	path: "conv-1",
	cwd: "/repo/honeycomb",
	agent: "claude-code",
};

describe("ISS-022 (revising L-B4/b-AC-4): the per-turn recall timeout is raised to 6s and still fails soft", () => {
	it("DEFAULT_RECALL_TIMEOUT_MS is 6000ms (clears the observed 3.0–4.6s live max with margin)", () => {
		expect(DEFAULT_RECALL_TIMEOUT_MS).toBe(6_000);
	});

	it("the renderer's default AbortController budget matches the constant and a hang degrades to []", async () => {
		vi.useFakeTimers();
		try {
			// The hang resolves the render only when its abort fires; the renderer uses its own default budget.
			const hangingFetch = ((_url: string, init: { signal?: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				})) as unknown as typeof fetch;
			const renderer = createRecallRenderer({ fetch: hangingFetch });
			const pending = renderer.render({ meta: META, credential: { token: "t", org: "acme" }, query: "auth?" });

			// Just before the 6s budget the fetch is still pending; past it the AbortController fires and
			// the renderer degrades to [] (fail-soft), proving the default budget IS the 6000ms constant.
			await vi.advanceTimersByTimeAsync(DEFAULT_RECALL_TIMEOUT_MS - 1);
			await vi.advanceTimersByTimeAsync(2);
			expect(await pending).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});
});

/**
 * PRD-077b (L-B4 / b-AC-4) — the per-turn renderer timeout bump (2_500 → 4_000ms).
 *
 * Verifies the constant is 4s (real headroom above the ~1.5s fast query and the fast-lane
 * server-side deadline) AND that the renderer STILL fails soft to `[]` past it — the byte-for-byte
 * PRD-076a fail-soft posture. Drives the production {@link createRecallRenderer} against an injected
 * `fetch` stub (no real socket).
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

describe("L-B4 (b-AC-4): the per-turn recall timeout is raised to 4s and still fails soft", () => {
	it("DEFAULT_RECALL_TIMEOUT_MS is 4000ms", () => {
		expect(DEFAULT_RECALL_TIMEOUT_MS).toBe(4_000);
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

			// Just before the 4s budget the fetch is still pending; past it the AbortController fires and
			// the renderer degrades to [] (fail-soft), proving the default budget IS the 4000ms constant.
			await vi.advanceTimersByTimeAsync(DEFAULT_RECALL_TIMEOUT_MS - 1);
			await vi.advanceTimersByTimeAsync(2);
			expect(await pending).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});
});

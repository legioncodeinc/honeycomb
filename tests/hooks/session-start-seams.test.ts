/**
 * PRD-045g g-AC-2 — the production session-start step seams (`createSessionStartSeams`).
 *
 * Before this fix the hooks runtime built `SessionStartDeps` with NO `seams`, so
 * `seams.autoPullSkills()` resolved to the no-op default and team skills never reached a
 * teammate's session. These tests prove the real seam's `autoPullSkills`:
 *   - POSTs the daemon's `POST /api/skills/pull` over loopback (g-AC-2);
 *   - stamps the credential's tenancy headers so the daemon scopes the pull;
 *   - is FAIL-SOFT — a thrown / rejected fetch is absorbed (never throws → session start is
 *     never blocked, FR-10);
 *   - honors the `HONEYCOMB_AUTOPULL_DISABLED=1` kill switch (makes NO request);
 *   - is TIME-BUDGETED — a hung fetch is aborted by the budget, still resolving cleanly.
 */

import { describe, expect, it, vi } from "vitest";

import { createFakeCredentialReader } from "../../src/hooks/shared/contracts.js";
import { createSessionStartSeams } from "../../src/hooks/shared/session-start-seams.js";

/** A recording `fetch` that captures the URL + init and returns a 200. */
function recordingFetch() {
	const calls: { url: string; init: RequestInit | undefined }[] = [];
	const fn = (async (url: unknown, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		return new Response("{}", { status: 200 });
	}) as unknown as typeof fetch;
	return { fn, calls };
}

describe("PRD-045g createSessionStartSeams.autoPullSkills (g-AC-2)", () => {
	it("POSTs /api/skills/pull over loopback with the credential's tenancy headers", async () => {
		const { fn, calls } = recordingFetch();
		const seams = createSessionStartSeams({
			credentials: createFakeCredentialReader({ org: "acme", workspace: "backend", actor: "alice" }),
			host: "127.0.0.1",
			port: 3850,
			fetch: fn,
			env: {},
		});
		await seams.autoPullSkills({ org: "acme", workspace: "backend", actor: "alice" });

		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.url).toBe("http://127.0.0.1:3850/api/skills/pull");
		expect(call.init?.method).toBe("POST");
		const headers = call.init?.headers as Record<string, string>;
		expect(headers["x-honeycomb-org"]).toBe("acme");
		expect(headers["x-honeycomb-workspace"]).toBe("backend");
		expect(headers["x-honeycomb-actor"]).toBe("alice");
	});

	it("defaults the workspace to the `default` sentinel when the credential carries none", async () => {
		const { fn, calls } = recordingFetch();
		const seams = createSessionStartSeams({
			credentials: createFakeCredentialReader({ org: "acme" }),
			fetch: fn,
			env: {},
		});
		await seams.autoPullSkills({ org: "acme" });
		const headers = calls[0]!.init?.headers as Record<string, string>;
		expect(headers["x-honeycomb-workspace"]).toBe("default");
	});

	it("sends NO scope headers for a signed-out session (the daemon fail-closes the pull)", async () => {
		const { fn, calls } = recordingFetch();
		const seams = createSessionStartSeams({ credentials: createFakeCredentialReader(undefined), fetch: fn, env: {} });
		await seams.autoPullSkills(undefined);
		expect(calls).toHaveLength(1);
		const headers = calls[0]!.init?.headers as Record<string, string>;
		expect(headers["x-honeycomb-org"]).toBeUndefined();
	});

	it("FAIL-SOFT: a rejected fetch is absorbed — autoPullSkills resolves, never throws", async () => {
		const failing = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const seams = createSessionStartSeams({ credentials: createFakeCredentialReader({ org: "acme" }), fetch: failing, env: {} });
		await expect(seams.autoPullSkills({ org: "acme" })).resolves.toBeUndefined();
	});

	it("honors the HONEYCOMB_AUTOPULL_DISABLED=1 kill switch — makes NO request", async () => {
		const { fn, calls } = recordingFetch();
		const seams = createSessionStartSeams({
			credentials: createFakeCredentialReader({ org: "acme" }),
			fetch: fn,
			env: { HONEYCOMB_AUTOPULL_DISABLED: "1" },
		});
		await seams.autoPullSkills({ org: "acme" });
		expect(calls).toHaveLength(0);
	});

	it("TIME-BUDGETED: a hung fetch is aborted by the budget and still resolves cleanly", async () => {
		vi.useFakeTimers();
		try {
			// A fetch that rejects on abort (the real fetch behaviour), never resolving on its own.
			const hanging = ((_url: unknown, init?: RequestInit) =>
				new Promise((_resolve, reject) => {
					const signal = init?.signal;
					signal?.addEventListener("abort", () => reject(new Error("aborted")));
				})) as unknown as typeof fetch;
			const seams = createSessionStartSeams({
				credentials: createFakeCredentialReader({ org: "acme" }),
				fetch: hanging,
				env: {},
				timeoutMs: 50,
			});
			const pending = seams.autoPullSkills({ org: "acme" });
			await vi.advanceTimersByTimeAsync(60);
			await expect(pending).resolves.toBeUndefined();
		} finally {
			// Restore real timers even if an assertion above throws — a leaked fake-timer clock
			// would corrupt every subsequent test in the worker.
			vi.useRealTimers();
		}
	});
});

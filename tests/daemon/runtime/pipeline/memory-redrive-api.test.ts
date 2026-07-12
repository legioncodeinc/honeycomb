/**
 * PRD-080b (b-AC-4) — the operator re-drive trigger seam (daemon side).
 *
 * Verification posture (mirrors capture-drain-api.test.ts): the seam is mounted on a REAL daemon
 * (`createDaemon` with a `local`-mode config so the `/api/diagnostics` group's permission middleware is
 * open) and exercised in-process via `daemon.app.request(...)` — no socket, no live DeepLake. A FAKE
 * re-drive closure records the call + scripts the count pair, so each test proves the wiring + the
 * response contract WITHOUT a live re-drive.
 *
 * The cases prove:
 *  - `POST /api/diagnostics/memory-redrive` runs EXACTLY ONE re-drive pass and returns `{ ok, redriven, skipped }`.
 *  - fail-soft: a re-drive that throws degrades to a zero-count 200 (never a 500).
 *  - the response body carries no token/secret (secret-free counts only).
 */

import { describe, expect, it } from "vitest";

import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import { mountMemoryRedriveApi } from "../../../../src/daemon/runtime/pipeline/memory-redrive-api.js";
import type { MemoryRedriveResult } from "../../../../src/daemon/runtime/pipeline/memory-redrive.js";
import { ok } from "../../../../src/daemon/storage/result.js";

/** A resolved config for the daemon under test (local mode → open diagnostics middleware). */
function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

/** A fake re-drive closure that records the call count and returns a scripted result (or throws). */
function fakeRedrive(opts: { result?: MemoryRedriveResult; throws?: boolean }): {
	redrive: () => Promise<MemoryRedriveResult>;
	calls: () => number;
} {
	let calls = 0;
	return {
		redrive: async (): Promise<MemoryRedriveResult> => {
			calls += 1;
			if (opts.throws === true) throw new Error("redrive fault");
			return opts.result ?? { redriven: 0, skipped: 0 };
		},
		calls: () => calls,
	};
}

function daemonUnderTest() {
	return createDaemon({
		config: cfg(),
		storage: {
			async query() {
				return ok([]);
			},
		},
		logger: createRequestLogger({ silent: true }),
	});
}

describe("PRD-080b b-AC-4 — POST /api/diagnostics/memory-redrive runs one re-drive + returns the counts", () => {
	it("runs exactly one re-drive pass and returns { ok, redriven, skipped }", async () => {
		const daemon = daemonUnderTest();
		const { redrive, calls } = fakeRedrive({ result: { redriven: 7, skipped: 3 } });
		mountMemoryRedriveApi(daemon, { redrive });

		const res = await daemon.app.request("/api/diagnostics/memory-redrive", { method: "POST" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual({ ok: true, redriven: 7, skipped: 3 });
		expect(calls(), "the operator command runs EXACTLY ONE re-drive pass").toBe(1);
	});

	it("is fail-soft: a throwing re-drive degrades to a zero-count 200 (never a 500)", async () => {
		const daemon = daemonUnderTest();
		const { redrive } = fakeRedrive({ throws: true });
		mountMemoryRedriveApi(daemon, { redrive });

		const res = await daemon.app.request("/api/diagnostics/memory-redrive", { method: "POST" });
		expect(res.status, "the operator command never sees a 500").toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual({ ok: true, redriven: 0, skipped: 0 });
	});

	it("the response body carries no token/secret/header value (secret-free counts only)", async () => {
		const daemon = daemonUnderTest();
		const { redrive } = fakeRedrive({ result: { redriven: 1, skipped: 0 } });
		mountMemoryRedriveApi(daemon, { redrive });

		const res = await daemon.app.request("/api/diagnostics/memory-redrive", { method: "POST" });
		const text = await res.text();
		expect(text).not.toMatch(/token|secret|bearer|authorization|x-honeycomb/i);
	});
});

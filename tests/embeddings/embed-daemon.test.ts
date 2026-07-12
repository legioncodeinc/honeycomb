/**
 * Embed-daemon suite — PRD-025 Wave 2.
 *
 * Drives the embed daemon's HTTP surface + embed path against a FAKE feature
 * extractor injected via `__setExtractorForTest` — the real ~600 MB
 * `@huggingface/transformers` model is NEVER loaded (CI stays hermetic; the real
 * model is Wave-3 live-only). Proves:
 *   - `GET /health` reports ready=false before warm, ready=true after, no secret;
 *   - `POST /embed` returns a 768-dim vector on a warm model;
 *   - `POST /embed` 503s (not 500, no secret) before warm → client leaves col NULL;
 *   - a wrong-dim model output is rejected (AC-6 dim lock) and never written;
 *   - the model id is pinned + the revision is a VALID git ref, NEVER the bad "v1.5"
 *     model-name string that 404'd live (D-2 reproducibility / Wave-3 live-fix);
 *   - the cache dir resolves under ~/.honeycomb (D-2 cached, not packed);
 *   - a FAILED warmup is OBSERVABLE: logged to stderr + a redacted `warmError` reason
 *     surfaced on /health (warmFailed:true + ready:false), with NO secret (Wave-3 live-fix).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	EMBED_DIMS,
	EMBED_PORT,
	EMBED_QUEUE_MAX,
	MODEL_ID,
	MODEL_QUANTIZATION,
	MODEL_REVISION,
	__resetForTest,
	__setExtractorForTest,
	__setTransformersLoaderForTest,
	embed,
	embedDaemonInfo,
	modelCacheDir,
	redactWarmError,
	resolveEmbedPort,
	startEmbedDaemon,
	warmup,
	type RunningEmbedDaemon,
} from "../../embeddings/src/index.js";

/** A fake extractor returning a vector of the given length (default the real 768). */
function fakeExtractor(len = EMBED_DIMS) {
	return async () => ({ data: new Float32Array(len).fill(0.01) });
}

/**
 * A loader that never settles — used by the warm/cold HTTP tests so the daemon's
 * BACKGROUND warmup (kicked off on bind, D-3) neither resolves nor rejects under
 * vitest (where the real dynamic import is unavailable). Without this the background
 * warmup would fail + the daemon would (correctly) log a warmup-failed line, polluting
 * those suites' output. These tests drive readiness via `__setExtractorForTest` instead.
 */
function pendingLoader(): () => Promise<never> {
	return () => new Promise<never>(() => {});
}

let running: RunningEmbedDaemon | null = null;

afterEach(async () => {
	__resetForTest();
	if (running !== null) {
		await running.close();
		running = null;
	}
});

describe("D-2 the model + revision + dim are pinned (reproducibility + schema lock)", () => {
	it("pins nomic-embed-text-v1.5, q8, 768-dim", () => {
		expect(MODEL_ID).toBe("nomic-ai/nomic-embed-text-v1.5");
		expect(MODEL_QUANTIZATION).toBe("q8");
		expect(EMBED_DIMS).toBe(768);
		const info = embedDaemonInfo();
		expect(info.model).toBe(MODEL_ID);
		expect(info.revision).toBe(MODEL_REVISION);
		expect(info.dims).toBe(768);
	});

	it("Wave-3 live-fix: MODEL_REVISION is a VALID git ref (main or a 40-hex SHA), NEVER the model name 'v1.5'", () => {
		// The bug: MODEL_REVISION was "v1.5" — the model NAME, not a git ref. The HF repo
		// has NO `v1.5` branch/tag (the files live on `main`), so transformers.js resolved
		// `.../resolve/v1.5/tokenizer.json` → 404 and warmup failed at live verification.
		// A valid revision is either the moving branch `main` or — preferred for D-2
		// reproducibility — an immutable 40-char lowercase-hex commit SHA.
		expect(MODEL_REVISION).not.toBe("v1.5");
		expect(MODEL_REVISION).not.toBe(MODEL_ID);
		const isMain = MODEL_REVISION === "main";
		const isCommitSha = /^[0-9a-f]{40}$/.test(MODEL_REVISION);
		expect(
			isMain || isCommitSha,
			`MODEL_REVISION must be "main" or a 40-hex commit SHA, got ${JSON.stringify(MODEL_REVISION)}`,
		).toBe(true);
	});

	it("the model cache dir lands under ~/.honeycomb (cached, reused — NOT packed) and honors the override", () => {
		const def = modelCacheDir({ HOME: "/home/x" });
		expect(def).toBe("/home/x/.honeycomb/embed-models");
		const override = modelCacheDir({ HONEYCOMB_EMBED_CACHE_DIR: "/pre/staged" });
		expect(override).toBe("/pre/staged");
	});
});

describe("Wave-3 live-fix: the bind port resolves to a finite default, never NaN", () => {
	// The bug: `port = options.port ?? Number(env.HONEYCOMB_EMBED_PORT) ?? EMBED_PORT`.
	// `Number(undefined)` is NaN, and `??` only coalesces null/undefined — NOT NaN —
	// so an UNSET HONEYCOMB_EMBED_PORT yielded port=NaN → `server.listen(NaN)` threw
	// `options.port should be >= 0 and < 65536`. We drive the REAL resolver here.

	it("UNSET env → binds EMBED_PORT (3851), never NaN (the regression that crashed standalone start)", () => {
		const port = resolveEmbedPort(undefined, undefined);
		expect(port).toBe(EMBED_PORT);
		expect(port).toBe(3851);
		expect(Number.isNaN(port)).toBe(false);
		expect(Number.isInteger(port)).toBe(true);
	});

	it("a VALID env port is honored", () => {
		expect(resolveEmbedPort(undefined, "4000")).toBe(4000);
		expect(resolveEmbedPort(undefined, "0")).toBe(0); // 0 = OS-assigned ephemeral, in range
		expect(resolveEmbedPort(undefined, "65535")).toBe(65535);
	});

	it("GARBAGE / empty / out-of-range env → falls back to EMBED_PORT (never NaN, never throws on listen)", () => {
		for (const bad of ["abc", "", "   ", "99999", "65536", "-1", "3.5", "NaN"]) {
			const port = resolveEmbedPort(undefined, bad);
			expect(port, `env=${JSON.stringify(bad)} should fall back`).toBe(EMBED_PORT);
			expect(Number.isNaN(port)).toBe(false);
		}
	});

	it("explicit options.port overrides BOTH a valid and a garbage env port", () => {
		expect(resolveEmbedPort(0, "4000")).toBe(0); // explicit 0 wins (ephemeral)
		expect(resolveEmbedPort(5000, "4000")).toBe(5000);
		expect(resolveEmbedPort(5000, "abc")).toBe(5000);
		expect(resolveEmbedPort(5000, undefined)).toBe(5000);
	});

	it("REAL bind path: unset env actually listens (ephemeral) instead of throwing on NaN", async () => {
		// Drive startEmbedDaemon with an env that has NO HONEYCOMB_EMBED_PORT. Before the
		// fix this threw synchronously inside listen(); now it binds. Use port 0 so the
		// resolver's explicit-override branch is bypassed for the env path but we still
		// avoid colliding on a fixed port — and assert it bound a real finite port.
		__resetForTest();
		__setTransformersLoaderForTest(pendingLoader()); // don't let the bg warmup fail/log under vitest
		running = await startEmbedDaemon({ host: "127.0.0.1", port: 0, env: {} });
		expect(Number.isNaN(running.address.port)).toBe(false);
		expect(running.address.port).toBeGreaterThan(0);
	});
});

describe("AC-6 the embed path holds the 768-dim invariant", () => {
	it("embeds to a 768-dim vector on a warm model", async () => {
		__setExtractorForTest(fakeExtractor(EMBED_DIMS));
		const v = await embed("the build is timing out on the pack step");
		expect(v).toHaveLength(EMBED_DIMS);
	});

	it("rejects a wrong-dim model output (never a silent bad write)", async () => {
		__setExtractorForTest(fakeExtractor(512));
		await expect(embed("anything")).rejects.toThrow(/dim mismatch/);
	});
});

describe("the HTTP surface (warm vs cold, no secret)", () => {
	async function startOnEphemeral(): Promise<{ url: string }> {
		// Neutralize the background warmup (D-3): under vitest the real dynamic import is
		// unavailable, so without a pending loader the daemon would log a warmup-failed line.
		// These tests drive readiness explicitly via `__setExtractorForTest`.
		__setTransformersLoaderForTest(pendingLoader());
		// Port 0 → an ephemeral port the OS assigns, so the suite never collides with 3851.
		running = await startEmbedDaemon({ host: "127.0.0.1", port: 0, env: {} });
		return { url: `http://127.0.0.1:${running.address.port}` };
	}

	it("GET /health reports ready=false cold, ready=true after the model warms — no secret in the body", async () => {
		// Don't let the real warmup run: reset so `extractor` stays null until we set the fake.
		__resetForTest();
		const { url } = await startOnEphemeral();
		const cold = await fetch(`${url}/health`);
		const coldBody = (await cold.json()) as Record<string, unknown>;
		expect(cold.status).toBe(200);
		expect(coldBody.ready).toBe(false);
		// No secret/token surface in /health.
		expect(JSON.stringify(coldBody)).not.toMatch(/token|secret|password|authorization/i);

		// Warm by injecting the fake extractor (stands in for the real model load).
		__setExtractorForTest(fakeExtractor(EMBED_DIMS));
		const warm = await fetch(`${url}/health`);
		const warmBody = (await warm.json()) as Record<string, unknown>;
		expect(warmBody.ready).toBe(true);
	});

	it("POST /embed 503s before warm (→ client leaves the column NULL), no input echoed", async () => {
		__resetForTest();
		const { url } = await startOnEphemeral();
		const res = await fetch(`${url}/embed`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "supersecret payload value" }),
		});
		expect(res.status).toBe(503);
		const body = (await res.json()) as Record<string, unknown>;
		// AC-7: the error reason never echoes the input text.
		expect(JSON.stringify(body)).not.toContain("supersecret payload value");
	});

	it("POST /embed returns a 768-dim vector once warm", async () => {
		const { url } = await startOnEphemeral();
		__setExtractorForTest(fakeExtractor(EMBED_DIMS));
		const res = await fetch(`${url}/embed`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "CI keeps failing during publish" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { vector: number[] };
		expect(body.vector).toHaveLength(EMBED_DIMS);
	});

	it("POST /embed 400s on a malformed/empty body (never a 500 leak)", async () => {
		const { url } = await startOnEphemeral();
		__setExtractorForTest(fakeExtractor(EMBED_DIMS));
		const res = await fetch(`${url}/embed`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{ not json",
		});
		expect(res.status).toBe(400);
	});
});

describe("Wave-3 live-fix: warmup failure is OBSERVABLE (logged + surfaced on /health, no secret)", () => {
	// The bug: when warmup failed the daemon set `warmFailed:true` on /health but logged
	// NOTHING and exposed no reason, so an operator had to reproduce the model load by hand
	// to discover the 404. Fix: log a one-line redacted reason to stderr AND surface a short
	// `warmError` reason on /health — `warmFailed:true` + `ready:false` stay. No secret.

	it("warmup() itself THROWS the underlying reason (the daemon owns surfacing it) — no model download", async () => {
		__resetForTest();
		// Drive a deterministic warmup failure WITHOUT the 600 MB model: fake the loader to
		// reject exactly like the real 404 did. `warmup()` is the pure load step — it throws;
		// the DAEMON (startEmbedDaemon, next test) owns logging + the /health reason.
		const the404 =
			'Could not locate file: "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/v1.5/tokenizer.json"';
		__setTransformersLoaderForTest(() => Promise.reject(new Error(the404)));
		await expect(warmup({})).rejects.toThrow(/Could not locate file/);
	});

	it("startEmbedDaemon: a failed background warmup → logs a redacted one-liner to stderr AND /health reports warmFailed:true + ready:false + a non-empty redacted warmError, no secret", async () => {
		__resetForTest();
		// The 404 the live run hit, with a bearer token spliced in to PROVE redaction across
		// BOTH surfaces (the stderr log and the /health field).
		const the404 =
			'Could not locate file: "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/v1.5/tokenizer.json" ' +
			"(authorization: Bearer hf_LEAKME0987654321)";
		__setTransformersLoaderForTest(() => Promise.reject(new Error(the404)));
		// Capture the daemon's stderr (also keeps the suite output clean).
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			running = await startEmbedDaemon({ host: "127.0.0.1", port: 0, env: {} });
			const url = `http://127.0.0.1:${running.address.port}`;

			// Warmup is kicked OFF the bind path (D-3), so poll /health until the background
			// rejection lands `warmFailed:true` (bounded so a regression fails fast, not hangs).
			let body: Record<string, unknown> = {};
			for (let i = 0; i < 50; i += 1) {
				const res = await fetch(`${url}/health`);
				body = (await res.json()) as Record<string, unknown>;
				if (body.warmFailed === true) break;
				await new Promise((r) => setTimeout(r, 20));
			}

			// (1) Surfaced on /health: failed + not ready + a non-empty redacted reason.
			expect(body.warmFailed).toBe(true);
			expect(body.ready).toBe(false);
			expect(typeof body.warmError).toBe("string");
			expect((body.warmError as string).length).toBeGreaterThan(0);
			// The diagnostic (the model URL + bad revision) IS surfaced — that is the value.
			expect(body.warmError as string).toContain("resolve/v1.5/tokenizer.json");
			// But NO secret/token rides along on /health (AC-7).
			const serialized = JSON.stringify(body);
			expect(serialized).not.toContain("hf_LEAKME0987654321");
			expect(serialized).not.toMatch(/hf_[A-Za-z0-9]/);

			// (2) Logged to stderr: a one-line `[honeycomb-embed] warmup failed: <reason>` so an
			// operator sees WHY without reproducing the model load by hand — also redacted.
			const logged = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
			expect(logged).toContain("[honeycomb-embed] warmup failed:");
			expect(logged).toContain("resolve/v1.5/tokenizer.json");
			expect(logged).not.toContain("hf_LEAKME0987654321");
			expect(logged).not.toMatch(/hf_[A-Za-z0-9]/);
		} finally {
			stderrSpy.mockRestore();
		}
	});

	it("redactWarmError: strips hf_ tokens + token/authorization values, collapses + truncates, keeps the model URL", () => {
		const reason = redactWarmError(
			new Error(
				'Could not locate file: ".../resolve/v1.5/tokenizer.json"\n  Authorization: Bearer hf_abc123XYZ\n  token=deadbeef',
			),
		);
		expect(reason).toContain("resolve/v1.5/tokenizer.json");
		expect(reason).not.toContain("hf_abc123XYZ");
		expect(reason).not.toMatch(/hf_[A-Za-z0-9]/);
		expect(reason).not.toContain("deadbeef");
		// Single-lined.
		expect(reason).not.toContain("\n");
		// A long reason is truncated to the cap.
		const long = redactWarmError(new Error("x".repeat(5000)));
		expect(long.length).toBeLessThanOrEqual(300);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// ISS-007/ISS-008 — /health stays answerable while inference runs (the wedge fix).
// ─────────────────────────────────────────────────────────────────────────────

describe("ISS-007: /health answers while an inference is in flight (never behind the queue)", () => {
	async function startWarmOnEphemeral(): Promise<{ url: string }> {
		__resetForTest();
		__setTransformersLoaderForTest(pendingLoader());
		running = await startEmbedDaemon({ host: "127.0.0.1", port: 0, env: {} });
		return { url: `http://127.0.0.1:${running.address.port}` };
	}

	it("GET /health answers 200 (busy:true, queueDepth>0) while a POST /embed is blocked mid-inference", async () => {
		const { url } = await startWarmOnEphemeral();
		// A BLOCKING fake extractor: the embed stays in flight until the test releases it —
		// the stand-in for the live-observed wedge signature (inference occupying the daemon).
		let release!: () => void;
		const blocked = new Promise<void>((r) => {
			release = r;
		});
		__setExtractorForTest(async () => {
			await blocked;
			return { data: new Float32Array(EMBED_DIMS).fill(0.01) };
		});

		// Fire the embed and do NOT await it — it is now queued/running.
		const embedPromise = fetch(`${url}/embed`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "occupies the inference queue" }),
		});
		// Give the daemon a beat to dequeue into the blocked inference.
		await new Promise((r) => setTimeout(r, 25));

		// THE contract under test: /health answers RIGHT NOW, mid-inference — it reads in-memory
		// flags only and never enters the inference queue (the supervisor's 2s probe depends on it).
		const health = await fetch(`${url}/health`);
		expect(health.status).toBe(200);
		const body = (await health.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
		expect(body.ready).toBe(true);
		expect(body.busy).toBe(true);
		expect(body.queueDepth as number).toBeGreaterThan(0);

		// Release the inference: the queued embed completes normally (no request was lost).
		release();
		const embedRes = await embedPromise;
		expect(embedRes.status).toBe(200);
		const embedBody = (await embedRes.json()) as { vector: number[] };
		expect(embedBody.vector).toHaveLength(EMBED_DIMS);

		// Drained: /health reports idle again.
		const after = (await (await fetch(`${url}/health`)).json()) as Record<string, unknown>;
		expect(after.busy).toBe(false);
		expect(after.queueDepth).toBe(0);
	});

	it("the inference queue is BOUNDED: overflow /embed requests shed with a fast 503, never an unbounded pile-up", async () => {
		const { url } = await startWarmOnEphemeral();
		let release!: () => void;
		const blocked = new Promise<void>((r) => {
			release = r;
		});
		__setExtractorForTest(async () => {
			await blocked;
			return { data: new Float32Array(EMBED_DIMS).fill(0.01) };
		});

		// Fill the FIFO to its cap with blocked embeds…
		const inFlight = Array.from({ length: EMBED_QUEUE_MAX }, (_, i) =>
			fetch(`${url}/embed`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: `queued-${i}` }),
			}),
		);
		await new Promise((r) => setTimeout(r, 50));

		// …then one more: it must shed IMMEDIATELY with a 503 (the client's NULL-column /
		// lexical-fallback path), not join an unbounded queue behind a saturated model.
		const overflow = await fetch(`${url}/embed`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "one too many" }),
		});
		expect(overflow.status).toBe(503);
		const overflowBody = (await overflow.json()) as Record<string, unknown>;
		expect(String(overflowBody.error)).toMatch(/queue full/);

		// Unblock and drain the in-flight set so the suite exits cleanly.
		release();
		const settled = await Promise.all(inFlight);
		for (const res of settled) expect(res.status).toBe(200);
	}, 20_000);
});

/**
 * ISS-010 — the injected-token metering CALL SITES (recall + prime) suite.
 *
 * Proves, against a fake-but-real SQL-aware `StorageQuery` (no live DeepLake):
 *   - POST /api/memories/recall appends ONE `memory_injections` row per served response —
 *     source `recall` on the heavy path, `recall_fast` when the body opts into `fast: true` —
 *     carrying the session id, the resolved-project id ('' when unbound), the hit count, and
 *     Σ estimateTokenCount(hit.text).
 *   - a ZERO-hit recall appends NOTHING (skip-on-zero — no zero-signal rows).
 *   - GET /api/memories/prime appends ONE `prime` row (hits = recent + durable, tokens = the
 *     digest estimate); a COLD scope (honest empty digest) appends NOTHING.
 *   - the response bodies are UNCHANGED: metering is fire-and-forget and fail-soft, so the
 *     serving contract is byte-identical whether or not the telemetry append lands.
 */

import { describe, expect, it, vi } from "vitest";

import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import { mountMemoriesApi } from "../../../../src/daemon/runtime/memories/index.js";
import { estimateTokenCount } from "../../../../src/daemon/runtime/memories/recall.js";
import { PrimeResponseSchema } from "../../../../src/daemon/runtime/memories/prime.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const ORG = "fake-org";
const WORKSPACE = "fake-ws";
const SESSION = "sess-metering";
const TERM = "honeycombterm";

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
}

/** Fully-formed session-group headers (org + runtime-path + session). */
function headers(extra: Record<string, string> = {}): Record<string, string> {
	return {
		"x-honeycomb-org": ORG,
		"x-honeycomb-workspace": WORKSPACE,
		"x-honeycomb-runtime-path": "legacy",
		"x-honeycomb-session": SESSION,
		"content-type": "application/json",
		...extra,
	};
}

/**
 * A SQL-aware responder (the api.test.ts shape): any recall arm carrying `'memories' AS source`
 * and the seeded term surfaces one memories hit — heavy AND fast lexical arms both carry that
 * literal, so one responder serves both engines. Everything else (sibling arms, the telemetry
 * INSERT, heal probes) answers empty rows.
 */
function recallResponder(term: string) {
	return (req: TransportRequest): Record<string, unknown>[] => {
		if (/'memories'\s+AS\s+source/i.test(req.sql) && req.sql.includes(term)) {
			return [{ source: "memories", id: "mem-1", text: `a fact about ${term}` }];
		}
		return [];
	};
}

/** The prime.test.ts responder shape: two episodic summaries + two durable facts. */
function primeResponder(req: TransportRequest): Record<string, unknown>[] {
	if (/FROM\s+"memory"/i.test(req.sql)) {
		return [
			{ key: "CI pack-step timeout — fixed via a retry-on-429 wrapper", path: "/summaries/alice/s1.md" },
			{ key: "Dashboard nav-shell shipped: left nav + hash router", path: "/summaries/alice/s2.md" },
		];
	}
	if (/FROM\s+"memories"/i.test(req.sql)) {
		return [
			{ key: "DeepLake reads are eventually consistent — always poll to converge", id: "mem_d9", content: "..." },
			{ key: "SQL values route through sqlStr/sqlLike/sqlIdent", id: "mem_e4", content: "..." },
		];
	}
	return [];
}

function makeDaemon(responder: (req: TransportRequest) => Record<string, unknown>[]) {
	const fake = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
	mountMemoriesApi(daemon, { storage });
	return { daemon, fake };
}

/** The `memory_injections` INSERTs recorded so far (the metering appends only — never a skim). */
function injectionInserts(fake: FakeDeepLakeTransport): string[] {
	return fake.requests.map((r) => r.sql).filter((s) => s.startsWith('INSERT INTO "memory_injections"'));
}

/** Await the fire-and-forget append settling into the fake transport (or time out the test). */
async function waitForInsert(fake: FakeDeepLakeTransport): Promise<string> {
	await vi.waitFor(() => {
		expect(injectionInserts(fake).length).toBeGreaterThan(0);
	});
	return injectionInserts(fake)[0] ?? "";
}

/** Let any stray fire-and-forget work settle before asserting an ABSENCE. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("ISS-010 — POST /api/memories/recall meters the served response", () => {
	it("the HEAVY path appends ONE row with source 'recall', the session id, and Σ estimateTokenCount(hit.text)", async () => {
		const { daemon, fake } = makeDaemon(recallResponder(TERM));
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ query: TERM }),
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { hits: { text: string }[]; sources: string[]; degraded: boolean };
		expect(json.hits.length).toBe(1);

		const insert = await waitForInsert(fake);
		// Source literal is exactly 'recall' (comma-anchored so 'recall_fast' cannot false-match).
		expect(insert).toMatch(/'recall', \d/);
		expect(insert).not.toContain("'recall_fast'");
		// hits + tokens: the meter counts what was SERVED (Σ over the response's hit texts).
		const expectedTokens = json.hits.reduce((sum, hit) => sum + estimateTokenCount(hit.text), 0);
		expect(insert).toContain(`'recall', ${json.hits.length}, ${expectedTokens}`);
		// Attribution: the x-honeycomb-session header; project '' (this request resolved no bound project).
		expect(insert).toContain(`'${SESSION}'`);
		expect(insert).toContain(`'${SESSION}', ''`);
		// Exactly ONE append per served response.
		await settle();
		expect(injectionInserts(fake)).toHaveLength(1);
	});

	it("the FAST path (body fast:true) appends with source 'recall_fast'", async () => {
		const { daemon, fake } = makeDaemon(recallResponder(TERM));
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ query: TERM, fast: true }),
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { hits: { text: string }[] };
		expect(json.hits.length).toBeGreaterThan(0);

		const insert = await waitForInsert(fake);
		expect(insert).toContain("'recall_fast',");
	});

	it("a ZERO-hit recall appends NOTHING (skip-on-zero) and the response is the normal empty result", async () => {
		// A responder that never matches → every arm returns empty → 0 hits.
		const { daemon, fake } = makeDaemon(() => []);
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ query: "nothing-matches-this" }),
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { hits: unknown[] };
		expect(json.hits).toHaveLength(0);
		await settle();
		expect(injectionInserts(fake)).toHaveLength(0);
	});

	it("the response CONTRACT is unchanged: the body carries exactly the recallResponse keys", async () => {
		const { daemon } = makeDaemon(recallResponder(TERM));
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ query: TERM }),
		});
		const json = (await res.json()) as Record<string, unknown>;
		// No cwd on this request → the project resolution degrades → the D8 warning fields are
		// present alongside the base triple; NOTHING ELSE (no metering leak into the body).
		expect(Object.keys(json).sort()).toEqual(["degraded", "hits", "projectScopeDegraded", "sources", "warning"]);
	});
});

describe("ISS-010 — GET /api/memories/prime meters the served digest", () => {
	it("a non-empty digest appends ONE row: source 'prime', hits = recent + durable, tokens = the digest estimate", async () => {
		const { daemon, fake } = makeDaemon(primeResponder);
		const res = await daemon.app.request("/api/memories/prime", { method: "GET", headers: headers() });
		expect(res.status).toBe(200);
		const json = PrimeResponseSchema.parse(await res.json());
		expect(json.empty).toBe(false);
		expect(json.tokens).toBeGreaterThan(0);

		const insert = await waitForInsert(fake);
		expect(insert).toContain(`'prime', ${json.recent.length + json.durable.length}, ${json.tokens}`);
		// Exactly ONE append per served digest.
		await settle();
		expect(injectionInserts(fake)).toHaveLength(1);
	});

	it("a COLD scope (honest empty digest) appends NOTHING and still answers 200", async () => {
		const { daemon, fake } = makeDaemon(() => []);
		const res = await daemon.app.request("/api/memories/prime", { method: "GET", headers: headers() });
		expect(res.status).toBe(200);
		const json = PrimeResponseSchema.parse(await res.json());
		expect(json.empty).toBe(true);
		await settle();
		expect(injectionInserts(fake)).toHaveLength(0);
	});

	it("the prime response CONTRACT is unchanged (PrimeResponseSchema, same fields as pre-metering)", async () => {
		const { daemon } = makeDaemon(primeResponder);
		const res = await daemon.app.request("/api/memories/prime", { method: "GET", headers: headers() });
		const json = (await res.json()) as Record<string, unknown>;
		expect(Object.keys(json).sort()).toEqual(["digest", "durable", "empty", "recent", "tokens"]);
		expect(() => PrimeResponseSchema.parse(json)).not.toThrow();
	});
});

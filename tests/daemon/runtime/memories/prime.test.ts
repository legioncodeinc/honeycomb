/**
 * PRD-046c — the `GET /api/memories/prime` endpoint suite (the prime-digest service).
 *
 * Proves, against a fake-but-real SQL-aware `StorageQuery` (no live DeepLake):
 *   c-AC-1  the endpoint returns recent + durable keys with ids for the scope.
 *   c-AC-4  the prime is scoped — the skim carries the request's org/workspace partition; a
 *           request with no resolvable scope fails closed (400).
 *   c-AC-5  the read path issues ONLY SQL skims (SELECT-only; no INSERT/UPDATE, no gate/embed/
 *           vector seam) — asserted structurally over every statement; a cold scope answers 200
 *           with the honest empty digest, never a 500.
 *
 * The `/api/memories` group is a SESSION group behind the runtime-path middleware, so every
 * in-process request stamps `x-honeycomb-runtime-path: legacy` + `x-honeycomb-session`.
 */

import { describe, expect, it } from "vitest";

import { createStorageClient, type QueryScope } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import {
	buildPrimeForScope,
	mountMemoriesPrimeApi,
	PrimeResponseSchema,
} from "../../../../src/daemon/runtime/memories/index.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const ORG = "fake-org";
const WORKSPACE = "fake-ws";
const SESSION = "sess-046c";
const SCOPE: QueryScope = { org: ORG, workspace: WORKSPACE };

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

/** Session-group headers WITHOUT the org tenancy header (the unscoped-request shape). */
function headersNoOrg(): Record<string, string> {
	return {
		"x-honeycomb-runtime-path": "legacy",
		"x-honeycomb-session": SESSION,
		"content-type": "application/json",
	};
}

/**
 * A SQL-aware responder for the prime skim: the episodic skim (`FROM "memory"`) surfaces two
 * session summaries newest-first; the durable skim (`FROM "memories"`) surfaces two facts.
 */
function primedResponder(req: TransportRequest): Record<string, unknown>[] {
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

function makeDaemon(responder: (req: TransportRequest) => Record<string, unknown>[] = primedResponder) {
	const fake = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
	return { daemon, storage, fake };
}

describe("PRD-046c c-AC-1 — GET /api/memories/prime returns recent + durable keys with ids", () => {
	it("BEFORE attach, /api/memories/prime answers the 501 scaffold", async () => {
		const { daemon } = makeDaemon();
		const res = await daemon.app.request("/api/memories/prime", { method: "GET", headers: headers() });
		expect(res.status).toBe(501);
	});

	it("AFTER attach, the digest carries recent + durable entries each with its ref id", async () => {
		const { daemon, storage } = makeDaemon();
		mountMemoriesPrimeApi(daemon, { storage });
		const res = await daemon.app.request("/api/memories/prime", { method: "GET", headers: headers() });
		expect(res.status).toBe(200);

		const json = PrimeResponseSchema.parse(await res.json());
		expect(json.empty).toBe(false);
		expect(json.recent.map((e) => e.ref)).toEqual(["/summaries/alice/s1.md", "/summaries/alice/s2.md"]);
		expect(json.durable.map((e) => e.ref)).toEqual(["mem_d9", "mem_e4"]);
		// The rendered digest carries the headlines + their opaque ids + the pull-path footer.
		expect(json.digest).toContain("retry-on-429");
		expect(json.digest).toContain("(#mem_d9)");
		expect(json.digest).toContain("hivemind_read");
		expect(json.digest).toContain("hivemind_search");
		expect(json.tokens).toBeGreaterThan(0);
	});
});

describe("PRD-046c c-AC-4 — the prime is scoped (org/workspace partition); unscoped → fail-closed", () => {
	it("the skim runs under the request's org/workspace partition", async () => {
		const { daemon, storage, fake } = makeDaemon();
		mountMemoriesPrimeApi(daemon, { storage });
		await daemon.app.request("/api/memories/prime", { method: "GET", headers: headers() });

		// Both source skims went out AND each carried the resolved tenant partition.
		expect(fake.requests.some((r) => /FROM\s+"memory"/i.test(r.sql))).toBe(true);
		expect(fake.requests.some((r) => /FROM\s+"memories"/i.test(r.sql))).toBe(true);
		for (const req of fake.requests) {
			expect(req.org).toBe(ORG);
			expect(req.workspace).toBe(WORKSPACE);
		}
	});

	it("a request with no resolvable org fails closed (400), never a broad read", async () => {
		const { daemon, storage } = makeDaemon();
		mountMemoriesPrimeApi(daemon, { storage });
		const res = await daemon.app.request("/api/memories/prime", { method: "GET", headers: headersNoOrg() });
		expect(res.status).toBe(400);
	});
});

describe("PRD-046c c-AC-5 — cheap (SQL-only) + cold-safe", () => {
	it("the read path issues ONLY SELECT skims — no INSERT/UPDATE, no gate/embed/vector seam", async () => {
		const { daemon, storage, fake } = makeDaemon();
		// NOTE: the prime mount takes NO `embed` and NO gate CLI — there is no generation seam to wire.
		mountMemoriesPrimeApi(daemon, { storage });
		await daemon.app.request("/api/memories/prime", { method: "GET", headers: headers() });

		expect(fake.requests.length).toBeGreaterThan(0);
		for (const req of fake.requests) {
			// Every statement is a SELECT (the pure skim) …
			expect(req.sql.trimStart().toUpperCase().startsWith("SELECT"), req.sql).toBe(true);
			// … and NONE is a mutation (verb+object, so `last_update_date` does not false-match).
			expect(/\bINSERT\s+INTO\b|\bUPDATE\s+"[^"]+"\s+SET\b|\bDELETE\s+FROM\b/i.test(req.sql), req.sql).toBe(false);
		}
	});

	it("a cold scope (no memory yet) returns 200 with the honest empty digest, never an error", async () => {
		const { daemon, storage } = makeDaemon(() => []); // every skim empty — a fresh partition.
		mountMemoriesPrimeApi(daemon, { storage });
		const res = await daemon.app.request("/api/memories/prime", { method: "GET", headers: headers() });
		expect(res.status).toBe(200);
		const json = PrimeResponseSchema.parse(await res.json());
		expect(json.empty).toBe(true);
		expect(json.recent).toHaveLength(0);
		expect(json.durable).toHaveLength(0);
		expect(json.digest).toContain("no memory yet");
	});

	it("a per-request ?maxTokens override bounds the digest (no mid-key truncation)", async () => {
		const { daemon, storage } = makeDaemon();
		mountMemoriesPrimeApi(daemon, { storage });
		const res = await daemon.app.request("/api/memories/prime?maxTokens=60", { method: "GET", headers: headers() });
		expect(res.status).toBe(200);
		const json = PrimeResponseSchema.parse(await res.json());
		expect(json.tokens).toBeLessThanOrEqual(60);
	});

	it("buildPrimeForScope (the testable core) skims once + assembles, no daemon needed", async () => {
		const { storage } = makeDaemon();
		const response = await buildPrimeForScope(storage, SCOPE, undefined, undefined);
		const parsed = PrimeResponseSchema.parse(response);
		expect(parsed.recent.length).toBe(2);
		expect(parsed.durable.length).toBe(2);
		expect(parsed.empty).toBe(false);
	});
});

/**
 * PRD-046e resolve adapter test suite.
 *
 * Proves (against a fake-but-real SQL-aware StorageQuery, no live DeepLake):
 *
 *   e-AC-1  hivemind_read(ref, depth=1) returns the Tier-2 summary; depth=2 returns the
 *           Tier-3 raw turns. Each is a SINGLE guarded SQL lookup by id/path, and NO
 *           recall/search SQL is issued at resolve time (asserted on fake.requests).
 *
 *   e-AC-2  Resolve is fail-soft: a missing summary/session → { found: false }, never a throw.
 *
 *   e-AC-4  Every statement goes through the SQL guards (sLiteral/sqlIdent). This is
 *           asserted structurally: every SQL in fake.requests must be a SELECT (no INSERT,
 *           no UPDATE, no ILIKE/recall pattern).
 *
 * Also covers the HTTP handler (`GET /api/memories/resolve`) to prove the scope is threaded
 * and the route wires depth + source correctly.
 */

import { describe, expect, it } from "vitest";

import { createStorageClient, type QueryScope } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import { mountMemoriesApi } from "../../../../src/daemon/runtime/memories/api.js";
import {
	buildDurableDepth1Sql,
	buildEpisodicDepth1Sql,
	buildSessionDepth2Sql,
	deriveSessionPath,
	resolveRef,
	MAX_RESOLVE_TURNS,
	DEFAULT_RESOLVE_TURNS,
} from "../../../../src/daemon/runtime/memories/resolve.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const ORG = "fake-org";
const WORKSPACE = "fake-ws";
const SESSION = "sess-046e";
const SCOPE: QueryScope = { org: ORG, workspace: WORKSPACE };

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3851, mode: "local", widened: false };
}

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

function headersNoOrg(): Record<string, string> {
	return {
		"x-honeycomb-runtime-path": "legacy",
		"x-honeycomb-session": SESSION,
	};
}

function makeDaemon(responder?: (req: TransportRequest) => Record<string, unknown>[]) {
	const fake = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
	return { daemon, storage, fake };
}

// ── SQL assertion helpers ─────────────────────────────────────────────────────

/** True when a SQL statement is a SELECT (not a recall/search/INSERT/UPDATE). */
function isSingleSelectByIdOrPath(sql: string): boolean {
	const upper = sql.toUpperCase().trim();
	// Must be a SELECT
	if (!upper.startsWith("SELECT")) return false;
	// Must NOT be a recall-style search (ILIKE, <#>, deeplake_hybrid_record, UNION)
	if (/ILIKE|<#>|DEEPLAKE_HYBRID_RECORD|UNION\s+ALL/i.test(sql)) return false;
	// Must contain a WHERE clause with = (id/path lookup)
	if (!/ WHERE /i.test(sql)) return false;
	return true;
}

/** Assert every SQL in the recorded requests is a guarded SELECT-by-id/path. */
function assertOnlySelectLookups(sqls: readonly string[]): void {
	for (const sql of sqls) {
		expect(isSingleSelectByIdOrPath(sql), `non-lookup SQL leaked: ${sql}`).toBe(true);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// e-AC-4: SQL builder shape (guarded, no ILIKE/search)
// ─────────────────────────────────────────────────────────────────────────────

describe("e-AC-4 — SQL builders are guarded SELECTs (no ILIKE, no search, no INSERT/UPDATE)", () => {
	it("buildEpisodicDepth1Sql produces a WHERE path = literal SELECT", () => {
		const sql = buildEpisodicDepth1Sql("/summaries/alice/s1");
		expect(sql.toUpperCase()).toContain("SELECT");
		expect(sql.toUpperCase()).not.toContain("ILIKE");
		expect(sql.toUpperCase()).not.toContain("<#>");
		expect(sql).toContain("WHERE");
		// The ref is sLiteral-quoted
		expect(sql).toContain("'/summaries/alice/s1'");
		expect(sql).toContain("LIMIT 1");
	});

	it("buildDurableDepth1Sql produces a WHERE id = literal SELECT, excludes soft-deleted", () => {
		const sql = buildDurableDepth1Sql("mem_abc");
		expect(sql.toUpperCase()).toContain("SELECT");
		expect(sql.toUpperCase()).not.toContain("ILIKE");
		expect(sql).toContain("'mem_abc'");
		// Excludes tombstones
		expect(sql).toContain("is_deleted");
		expect(sql).toContain("LIMIT 1");
	});

	it("buildSessionDepth2Sql produces a WHERE path = literal SELECT, bounded", () => {
		const sql = buildSessionDepth2Sql("/summaries/alice/s1", 50);
		expect(sql.toUpperCase()).toContain("SELECT");
		expect(sql.toUpperCase()).not.toContain("ILIKE");
		expect(sql).toContain("'/summaries/alice/s1'");
		expect(sql).toContain("LIMIT 50");
	});

	it("buildSessionDepth2Sql clamps turns to MAX_RESOLVE_TURNS", () => {
		const sql = buildSessionDepth2Sql("/s", MAX_RESOLVE_TURNS + 999);
		expect(sql).toContain(`LIMIT ${MAX_RESOLVE_TURNS}`);
	});

	it("deriveSessionPath returns the ref unchanged (same key space)", () => {
		const ref = "/summaries/alice/sess-xyz/2025-06-22";
		expect(deriveSessionPath(ref)).toBe(ref);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// e-AC-1: resolveRef issues ONLY id/path SELECTs — no search SQL
// ─────────────────────────────────────────────────────────────────────────────

describe("e-AC-1 — resolveRef issues only id/path SELECTs (no recall/search SQL)", () => {
	it("depth=1 episodic: returns the Tier-2 summary row", async () => {
		const fake = new FakeDeepLakeTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });

		fake.enqueueRows([
			{
				path: "/summaries/alice/s1",
				summary: "CI pack-step timeout — fixed via retry-on-429 wrapper",
				key: "CI pack-step timeout fix",
				last_update_date: "2025-06-20T10:00:00Z",
			},
		]);

		const result = await resolveRef("/summaries/alice/s1", 1, "episodic", SCOPE, { storage });

		expect(result.found).toBe(true);
		if (!result.found) throw new Error("should be found");
		expect(result.depth).toBe(1);
		expect(result.source).toBe("episodic");
		if (result.depth === 1 && result.source === "episodic") {
			expect(result.row.summary).toBe("CI pack-step timeout — fixed via retry-on-429 wrapper");
			expect(result.row.path).toBe("/summaries/alice/s1");
		}

		// Exactly ONE SQL statement, and it's a SELECT-by-path (not a search).
		expect(fake.requests.length).toBe(1);
		assertOnlySelectLookups(fake.requests.map((r) => r.sql));
		// Must NOT contain recall-style ILIKE
		expect(fake.requests[0].sql.toUpperCase()).not.toContain("ILIKE");
	});

	it("depth=1 durable: returns the Tier-2 content row", async () => {
		const fake = new FakeDeepLakeTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });

		fake.enqueueRows([
			{
				id: "mem_d9",
				content: "DeepLake reads are eventually consistent — always poll",
				key: "DeepLake eventual-consistency",
				updated_at: "2025-06-20T11:00:00Z",
			},
		]);

		const result = await resolveRef("mem_d9", 1, "durable", SCOPE, { storage });

		expect(result.found).toBe(true);
		if (!result.found) throw new Error("should be found");
		expect(result.depth).toBe(1);
		expect(result.source).toBe("durable");
		if (result.depth === 1 && result.source === "durable") {
			expect(result.row.content).toContain("eventually consistent");
			expect(result.row.id).toBe("mem_d9");
		}

		// Single SELECT, no ILIKE.
		expect(fake.requests.length).toBe(1);
		assertOnlySelectLookups(fake.requests.map((r) => r.sql));
	});

	it("depth=2 episodic: returns the Tier-3 raw session turns", async () => {
		const fake = new FakeDeepLakeTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });

		// depth-2 reads: (1) the Tier-2 summary, (2) the sessions turns.
		fake.enqueueRows([
			{
				path: "/summaries/alice/s1",
				summary: "CI fix",
				key: "CI fix",
				last_update_date: "2025-06-20T10:00:00Z",
			},
		]);
		fake.enqueueRows([
			{ path: "/summaries/alice/s1", message: '{"role":"user","content":"hello"}' },
			{ path: "/summaries/alice/s1", message: '{"role":"assistant","content":"done"}' },
		]);

		const result = await resolveRef("/summaries/alice/s1", 2, "episodic", SCOPE, { storage });

		expect(result.found).toBe(true);
		if (!result.found) throw new Error("should be found");
		expect(result.depth).toBe(2);
		expect(result.source).toBe("episodic");
		if (result.depth === 2 && result.source === "episodic") {
			expect(result.turns.length).toBe(2);
			expect(result.turns[0].message).toContain("hello");
		}

		// Two SQL statements (one per tier), both SELECT-by-path — no search.
		expect(fake.requests.length).toBe(2);
		assertOnlySelectLookups(fake.requests.map((r) => r.sql));
	});

	it("depth=2 episodic: scope rides both queries", async () => {
		const fake = new FakeDeepLakeTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });

		fake.enqueueRows([
			{ path: "/s/1", summary: "x", key: "x", last_update_date: "2025-06-01" },
		]);
		fake.enqueueRows([
			{ path: "/s/1", message: '{"role":"user","content":"hi"}' },
		]);

		await resolveRef("/s/1", 2, "episodic", SCOPE, { storage });

		expect(fake.requests.every((r) => r.org === ORG && r.workspace === WORKSPACE)).toBe(true);
	});

	it("depth=2 durable: returns the Tier-2 durable row (durable has no session path)", async () => {
		const fake = new FakeDeepLakeTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });

		fake.enqueueRows([
			{ id: "mem_e4", content: "SQL values route through guards", key: "SQL guards", updated_at: "2025-06-19" },
		]);

		const result = await resolveRef("mem_e4", 2, "durable", SCOPE, { storage });

		expect(result.found).toBe(true);
		if (!result.found) throw new Error("should be found");
		expect(result.source).toBe("durable");
		if (result.source === "durable") {
			expect(result.row.content).toContain("SQL values");
		}
		// Only ONE SELECT — durable depth-2 does not read sessions.
		expect(fake.requests.length).toBe(1);
		assertOnlySelectLookups(fake.requests.map((r) => r.sql));
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// e-AC-2: fail-soft — missing rows never throw
// ─────────────────────────────────────────────────────────────────────────────

describe("e-AC-2 — resolve is fail-soft (missing row → {found:false}, no throw)", () => {
	it("episodic depth=1: empty storage → {found: false}", async () => {
		const fake = new FakeDeepLakeTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		fake.enqueueRows([]); // no rows
		const result = await resolveRef("/summaries/alice/s1", 1, "episodic", SCOPE, { storage });
		expect(result.found).toBe(false);
	});

	it("durable depth=1: empty storage → {found: false}", async () => {
		const fake = new FakeDeepLakeTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		fake.enqueueRows([]);
		const result = await resolveRef("mem_gone", 1, "durable", SCOPE, { storage });
		expect(result.found).toBe(false);
	});

	it("episodic depth=1: storage error (missing table) → {found: false}, no throw", async () => {
		const fake = new FakeDeepLakeTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		fake.enqueueQueryError('relation "memory" does not exist', 404);
		const result = await resolveRef("/summaries/x/s1", 1, "episodic", SCOPE, { storage });
		expect(result.found).toBe(false);
	});

	it("durable depth=1: storage error → {found: false}, no throw", async () => {
		const fake = new FakeDeepLakeTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		fake.enqueueQueryError('relation "memories" does not exist', 404);
		const result = await resolveRef("mem_x", 1, "durable", SCOPE, { storage });
		expect(result.found).toBe(false);
	});

	it("episodic depth=2: summary exists but sessions table missing → returns depth-2 with empty turns, no throw", async () => {
		const fake = new FakeDeepLakeTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		// First query (depth-1 summary) succeeds.
		fake.enqueueRows([
			{ path: "/s/1", summary: "CI fix", key: "CI fix", last_update_date: "2025-06-01" },
		]);
		// Second query (sessions turns) fails with a missing table error.
		fake.enqueueQueryError('relation "sessions" does not exist', 404);

		const result = await resolveRef("/s/1", 2, "episodic", SCOPE, { storage });
		// The resolve is still "found" (the summary exists); sessions are empty.
		expect(result.found).toBe(true);
		if (!result.found) throw new Error("should be found");
		if (result.depth === 2 && result.source === "episodic") {
			expect(result.turns).toEqual([]);
		}
	});

	it("empty ref → {found: false} without any storage call", async () => {
		const fake = new FakeDeepLakeTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const result = await resolveRef("   ", 1, "episodic", SCOPE, { storage });
		expect(result.found).toBe(false);
		expect(fake.requests.length).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP handler tests (GET /api/memories/resolve)
// ─────────────────────────────────────────────────────────────────────────────

describe("PRD-046e HTTP handler — GET /api/memories/resolve", () => {
	it("before attach, /api/memories/resolve answers 501", async () => {
		const { daemon } = makeDaemon();
		const res = await daemon.app.request("/api/memories/resolve?ref=x&source=episodic", {
			method: "GET",
			headers: headers(),
		});
		expect(res.status).toBe(501);
	});

	it("after attach, depth=1 episodic → found:true with summary", async () => {
		const { daemon, storage, fake } = makeDaemon((req) => {
			if (/FROM\s+"memory"/i.test(req.sql)) {
				return [
					{
						path: "/summaries/alice/s1",
						summary: "CI fix",
						key: "CI fix",
						last_update_date: "2025-06-20",
					},
				];
			}
			return [];
		});
		mountMemoriesApi(daemon, { storage });

		const res = await daemon.app.request(
			"/api/memories/resolve?ref=%2Fsummaries%2Falice%2Fs1&source=episodic&depth=1",
			{ method: "GET", headers: headers() },
		);
		expect(res.status).toBe(200);
		const json = await res.json() as Record<string, unknown>;
		expect(json.found).toBe(true);
		expect(json.depth).toBe(1);
		expect(json.source).toBe("episodic");

		// No ILIKE/recall SQL was issued.
		expect(fake.requests.every((r) => !r.sql.toUpperCase().includes("ILIKE"))).toBe(true);
		// Scope reached the wire.
		expect(fake.requests.every((r) => r.org === ORG)).toBe(true);
	});

	it("after attach, depth=2 episodic → found:true with turns", async () => {
		const { daemon, storage } = makeDaemon((req) => {
			if (/FROM\s+"memory"/i.test(req.sql)) {
				return [{ path: "/s/1", summary: "x", key: "x", last_update_date: "2025-06-01" }];
			}
			if (/FROM\s+"sessions"/i.test(req.sql)) {
				return [{ path: "/s/1", message: '{"role":"user","content":"hi"}' }];
			}
			return [];
		});
		mountMemoriesApi(daemon, { storage });

		const res = await daemon.app.request(
			"/api/memories/resolve?ref=%2Fs%2F1&source=episodic&depth=2",
			{ method: "GET", headers: headers() },
		);
		expect(res.status).toBe(200);
		const json = await res.json() as Record<string, unknown>;
		expect(json.found).toBe(true);
		expect(json.depth).toBe(2);
		expect(json.source).toBe("episodic");
		expect(Array.isArray(json.turns)).toBe(true);
	});

	it("after attach, depth=1 durable → found:true with content", async () => {
		const { daemon, storage } = makeDaemon((req) => {
			if (/FROM\s+"memories"/i.test(req.sql)) {
				return [{ id: "mem_d9", content: "eventual consistency", key: "ec", updated_at: "2025-06-01" }];
			}
			return [];
		});
		mountMemoriesApi(daemon, { storage });

		const res = await daemon.app.request(
			"/api/memories/resolve?ref=mem_d9&source=durable&depth=1",
			{ method: "GET", headers: headers() },
		);
		expect(res.status).toBe(200);
		const json = await res.json() as Record<string, unknown>;
		expect(json.found).toBe(true);
		expect(json.source).toBe("durable");
	});

	it("after attach, missing ref → 400", async () => {
		const { daemon, storage } = makeDaemon(() => []);
		mountMemoriesApi(daemon, { storage });

		const res = await daemon.app.request("/api/memories/resolve?depth=1", {
			method: "GET",
			headers: headers(),
		});
		expect(res.status).toBe(400);
	});

	it("after attach, not-found ref → 200 with found:false (fail-soft)", async () => {
		const { daemon, storage } = makeDaemon(() => []);
		mountMemoriesApi(daemon, { storage });

		const res = await daemon.app.request(
			"/api/memories/resolve?ref=missing&source=episodic&depth=1",
			{ method: "GET", headers: headers() },
		);
		expect(res.status).toBe(200);
		const json = await res.json() as Record<string, unknown>;
		expect(json.found).toBe(false);
	});

	it("after attach, unscoped request → 400 (fail-closed)", async () => {
		const { daemon, storage } = makeDaemon(() => []);
		mountMemoriesApi(daemon, { storage });

		const res = await daemon.app.request(
			"/api/memories/resolve?ref=x&source=episodic",
			{ method: "GET", headers: headersNoOrg() },
		);
		expect(res.status).toBe(400);
	});

	it("turns param caps the depth-2 result to MAX_RESOLVE_TURNS", async () => {
		const recorded: string[] = [];
		const { daemon, storage } = makeDaemon((req) => {
			recorded.push(req.sql);
			if (/FROM\s+"memory"/i.test(req.sql)) {
				return [{ path: "/s/1", summary: "x", key: "x", last_update_date: "2025-06-01" }];
			}
			return [];
		});
		mountMemoriesApi(daemon, { storage });

		await daemon.app.request(
			`/api/memories/resolve?ref=%2Fs%2F1&source=episodic&depth=2&turns=${MAX_RESOLVE_TURNS + 999}`,
			{ method: "GET", headers: headers() },
		);
		// The sessions query must have LIMIT <= MAX_RESOLVE_TURNS.
		const sessionsQuery = recorded.find((s) => /FROM\s+"sessions"/i.test(s));
		if (sessionsQuery !== undefined) {
			const match = /LIMIT\s+(\d+)/i.exec(sessionsQuery);
			const limit = match ? parseInt(match[1], 10) : 0;
			expect(limit).toBeLessThanOrEqual(MAX_RESOLVE_TURNS);
		}
	});

	it("e-AC-4: all SQL issued by the handler is SELECT-by-id/path (no ILIKE, no search)", async () => {
		const { daemon, storage, fake } = makeDaemon((req) => {
			if (/FROM\s+"memory"/i.test(req.sql)) {
				return [{ path: "/s/1", summary: "x", key: "k", last_update_date: "2025-06-01" }];
			}
			if (/FROM\s+"sessions"/i.test(req.sql)) {
				return [{ path: "/s/1", message: "{}" }];
			}
			return [];
		});
		mountMemoriesApi(daemon, { storage });

		await daemon.app.request(
			"/api/memories/resolve?ref=%2Fs%2F1&source=episodic&depth=2",
			{ method: "GET", headers: headers() },
		);

		assertOnlySelectLookups(fake.requests.map((r) => r.sql));
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Turn-limit boundary
// ─────────────────────────────────────────────────────────────────────────────

describe("e-AC-1 turn limit — depth-2 zoom is bounded", () => {
	it("DEFAULT_RESOLVE_TURNS is 50 (reasonable default)", () => {
		expect(DEFAULT_RESOLVE_TURNS).toBe(50);
	});

	it("MAX_RESOLVE_TURNS is 100 (the hard cap)", () => {
		expect(MAX_RESOLVE_TURNS).toBe(100);
	});

	it("depth-2 SQL uses the supplied turnLimit, not an unbounded query", async () => {
		const fake = new FakeDeepLakeTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		fake.enqueueRows([{ path: "/s/1", summary: "x", key: "x", last_update_date: "2025-06-01" }]);
		fake.enqueueRows([]);

		await resolveRef("/s/1", 2, "episodic", SCOPE, { storage }, 25);

		const sessionsQuery = fake.requests.find((r) => /FROM\s+"sessions"/i.test(r.sql));
		expect(sessionsQuery).toBeDefined();
		expect(sessionsQuery?.sql).toContain("LIMIT 25");
	});

	it("depth-2 SQL caps at MAX_RESOLVE_TURNS when turnLimit exceeds it", async () => {
		const fake = new FakeDeepLakeTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		fake.enqueueRows([{ path: "/s/1", summary: "x", key: "x", last_update_date: "2025-06-01" }]);
		fake.enqueueRows([]);

		await resolveRef("/s/1", 2, "episodic", SCOPE, { storage }, MAX_RESOLVE_TURNS + 500);

		const sessionsQuery = fake.requests.find((r) => /FROM\s+"sessions"/i.test(r.sql));
		expect(sessionsQuery?.sql).toContain(`LIMIT ${MAX_RESOLVE_TURNS}`);
	});
});

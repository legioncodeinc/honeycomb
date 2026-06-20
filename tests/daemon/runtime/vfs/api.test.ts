/**
 * PRD-022b daemon-side VFS browse API suite — the `mountVfsApi` attach step.
 *
 * `mountVfsApi` is the single named seam the daemon assembly (022d) calls after
 * `createDaemon(...)` to wire the `/memory/*` browse READ handlers (cat / grep / ls /
 * find / classify) + the write-deny guard onto the already-mounted `/memory` session
 * group. This suite proves each b-AC against a fake-but-real `StorageQuery`
 * (`FakeDeepLakeTransport` → `createStorageClient`), driving `daemon.app.request(...)`:
 *
 *   - b-AC-1 cat   → the handler reads the `memory` row and returns its content.
 *   - b-AC-2 grep  → the handler runs hybrid search through the recall collection
 *                    layer, BM25/ILIKE lexical floor, `degraded:true` (embeddings off).
 *   - b-AC-3 ls    → the handler returns the entries under the prefix.
 *   - b-AC-4 find  → the handler returns the path-pattern matches.
 *   - b-AC-5 classify → daemon-side classification == the 015 client `classifyPath`.
 *   - b-AC-6 write-deny → a write on a memory path is 405 with audited-route guidance.
 *
 * The `/memory` group is a SESSION group (server.ts), so every request stamps
 * `x-honeycomb-runtime-path` + `x-honeycomb-session` (the runtime-path middleware) in
 * addition to `x-honeycomb-org` / `-workspace` — exactly what the VFS clients send.
 */

import { describe, expect, it } from "vitest";

import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import {
	buildCatSql,
	buildFindSql,
	buildGrepHydrateSql,
	buildLsSql,
	mountVfsApi,
	WRITE_DENIED_BODY,
} from "../../../../src/daemon/runtime/vfs/api.js";
import { classifyPath } from "../../../../src/daemon-client/vfs/classify.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const ORG = "fake-org";
const WORKSPACE = "fake-ws";

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
}

/** The headers a session-scoped `/memory` browse carries (runtime-path + session + tenancy). */
function headers(extra: Record<string, string> = {}): Record<string, string> {
	return {
		"x-honeycomb-org": ORG,
		"x-honeycomb-workspace": WORKSPACE,
		"x-honeycomb-runtime-path": "plugin",
		"x-honeycomb-session": "sess-vfs-1",
		...extra,
	};
}

/**
 * A SQL-aware responder routing each browse read to a canned row set. It branches on
 * the table + shape: `memory` cat (path =) vs ls/find (ILIKE), the `memories` FTS
 * collection SELECT (score), and the `memories` content hydration (IN).
 */
function responder(): (req: TransportRequest) => Record<string, unknown>[] {
	return (req: TransportRequest): Record<string, unknown>[] => {
		const sql = req.sql;
		// grep: the recall FTS channel SELECT over the engine `memories` table.
		if (/FROM\s+"memories"\s+WHERE.*ILIKE/i.test(sql) && /AS\s+score/i.test(sql)) {
			return [
				{ id: "m1", score: 0.8 },
				{ id: "m2", score: 0.4 },
			];
		}
		// grep: the content hydration over `memories` (IN-list).
		if (/FROM\s+"memories"\s+WHERE.*IN\s*\(/i.test(sql)) {
			return [
				{ id: "m1", content: "deeplake recall through HTTP" },
				{ id: "m2", content: "secondary memory body" },
			];
		}
		// cat: the `memory` row read by exact path (identifiers are bare, not quoted).
		if (/FROM\s+"memory"\s+WHERE\s+path\s*=/i.test(sql)) {
			return [{ path: "notes/recall.md", summary: "the recall summary body", filename: "recall.md" }];
		}
		// ls / find: the `memory` prefix/pattern ILIKE.
		if (/FROM\s+"memory"\s+WHERE\s+path\s+ILIKE/i.test(sql)) {
			return [
				{ path: "notes/recall.md", filename: "recall.md", summary: "the recall summary body" },
				{ path: "notes/capture.md", filename: "capture.md", summary: "the capture summary body" },
			];
		}
		return [];
	};
}

function makeDaemon() {
	const fake = new FakeDeepLakeTransport(responder());
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
	return { daemon, storage, fake };
}

function cfgTeam(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "team", widened: false };
}

/** The daemon's configured default tenant (the single LOCAL tenant) injected via defaultScope. */
const DEFAULT_SCOPE = { org: "daemon-default-org", workspace: "daemon-default-ws" } as const;

/** Session headers WITHOUT the org/workspace tenancy (the SDK/MCP thin-client browse shape). */
function headersNoOrg(): Record<string, string> {
	return { "x-honeycomb-runtime-path": "plugin", "x-honeycomb-session": "sess-vfs-1" };
}

/** Build a VFS daemon at an explicit mode (default local). */
function makeDaemonMode(config: RuntimeConfig) {
	const fake = new FakeDeepLakeTransport(responder());
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({ config, storage, logger: createRequestLogger({ silent: true }) });
	return { daemon, storage, fake };
}

describe("PRD-022b mountVfsApi wires the /memory browse read handlers", () => {
	it("BEFORE attach: /memory/cat answers the 501 scaffold", async () => {
		const { daemon } = makeDaemon();
		const res = await daemon.app.request("/memory/cat?path=notes/recall.md", { headers: headers() });
		expect(res.status).toBe(501);
	});

	it("b-AC-1: cat reads the underlying memory row and returns its content", async () => {
		const { daemon, storage } = makeDaemon();
		mountVfsApi(daemon, { storage });
		const res = await daemon.app.request("/memory/cat?path=notes/recall.md", { headers: headers() });
		expect(res.status).toBe(200);
		const json = (await res.json()) as { path: string; found: boolean; content: string };
		expect(json.found).toBe(true);
		expect(json.content).toBe("the recall summary body");
	});

	it("b-AC-1: cat on a missing path returns found:false with empty content (not a 500)", async () => {
		const { daemon } = makeDaemon();
		const fake = new FakeDeepLakeTransport(() => []); // every read answers empty
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const d2 = createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
		mountVfsApi(d2, { storage });
		const res = await d2.app.request("/memory/cat?path=nope/missing.md", { headers: headers() });
		void daemon;
		expect(res.status).toBe(200);
		const json = (await res.json()) as { found: boolean; content: string };
		expect(json.found).toBe(false);
		expect(json.content).toBe("");
	});

	it("b-AC-1: cat with no path param → 400 bad_request", async () => {
		const { daemon, storage } = makeDaemon();
		mountVfsApi(daemon, { storage });
		const res = await daemon.app.request("/memory/cat", { headers: headers() });
		expect(res.status).toBe(400);
	});

	it("b-AC-2: grep runs hybrid search through the recall engine, lexical-only degraded (embeddings off)", async () => {
		const { daemon, storage } = makeDaemon();
		mountVfsApi(daemon, { storage });
		const res = await daemon.app.request("/memory/grep?q=recall%20through%20HTTP", { headers: headers() });
		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			degraded: boolean;
			hits: { id: string; score: number; content: string }[];
		};
		// No embed client injected → vector channel skipped → BM25/ILIKE fallback (the silent-fallback signal).
		expect(json.degraded).toBe(true);
		// The FTS channel surfaced m1/m2; content was hydrated from the `memories` engine table.
		expect(json.hits.map((h) => h.id)).toContain("m1");
		const m1 = json.hits.find((h) => h.id === "m1");
		expect(m1?.content).toBe("deeplake recall through HTTP");
		expect(m1?.score).toBeGreaterThan(0);
	});

	it("b-AC-2: grep with no q param → 400 bad_request", async () => {
		const { daemon, storage } = makeDaemon();
		mountVfsApi(daemon, { storage });
		const res = await daemon.app.request("/memory/grep", { headers: headers() });
		expect(res.status).toBe(400);
	});

	it("b-AC-3: ls returns the entries under the prefix", async () => {
		const { daemon, storage } = makeDaemon();
		mountVfsApi(daemon, { storage });
		const res = await daemon.app.request("/memory/ls?prefix=notes/", { headers: headers() });
		expect(res.status).toBe(200);
		const json = (await res.json()) as { prefix: string; entries: { path: string; filename: string }[] };
		expect(json.prefix).toBe("notes/");
		expect(json.entries).toHaveLength(2);
		expect(json.entries.map((e) => e.path)).toEqual(["notes/recall.md", "notes/capture.md"]);
	});

	it("b-AC-4: find returns the memories matching the pattern", async () => {
		const { daemon, storage } = makeDaemon();
		mountVfsApi(daemon, { storage });
		const res = await daemon.app.request("/memory/find?pattern=recall", { headers: headers() });
		expect(res.status).toBe(200);
		const json = (await res.json()) as { pattern: string; matches: { path: string; summary: string }[] };
		expect(json.pattern).toBe("recall");
		expect(json.matches.length).toBeGreaterThan(0);
		expect(json.matches[0].path).toBe("notes/recall.md");
	});

	it("b-AC-4: find with no pattern param → 400 bad_request", async () => {
		const { daemon, storage } = makeDaemon();
		mountVfsApi(daemon, { storage });
		const res = await daemon.app.request("/memory/find", { headers: headers() });
		expect(res.status).toBe(400);
	});

	it("b-AC-5: daemon-side classify matches the PRD-015 client classifyPath for representative paths", async () => {
		const { daemon, storage } = makeDaemon();
		mountVfsApi(daemon, { storage });
		const samples = [
			"goal/alice/in_progress/g1.md", // goal shape
			"goal/alice/bogus/g1.md", // malformed status → memory fallback
			"kpi/g1/k1.md", // kpi shape
			"sessions/2026/abc.json", // session
			"graph/index.md", // graph
			"index.md", // index
			"notes/recall.md", // memory fallback
		];
		for (const path of samples) {
			const res = await daemon.app.request(`/memory/classify?path=${encodeURIComponent(path)}`, {
				headers: headers(),
			});
			expect(res.status).toBe(200);
			const json = (await res.json()) as { path: string; pathClass: string };
			// The daemon-side verdict is IDENTICAL to the 015 client's pure classifyPath.
			expect(json.pathClass).toBe(classifyPath(path));
		}
	});

	it("b-AC-6: a write on a memory path is DENIED (405) with guidance pointing at /api/memories", async () => {
		const { daemon, storage } = makeDaemon();
		mountVfsApi(daemon, { storage });
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			const res = await daemon.app.request("/memory/notes/recall.md", { method, headers: headers() });
			expect(res.status).toBe(405);
			const json = (await res.json()) as { error: string; writeRoute: string; reason: string };
			expect(json.error).toBe("method_not_allowed");
			expect(json.writeRoute).toBe("/api/memories");
			expect(json.reason).toContain("/api/memories");
		}
	});

	it("b-AC-6: the write-deny body is the exported, stable guidance shape", () => {
		expect(WRITE_DENIED_BODY.writeRoute).toBe("/api/memories");
		expect(WRITE_DENIED_BODY.error).toBe("method_not_allowed");
	});

	it("fail-closed: a browse with no x-honeycomb-org → 400 (no broad read)", async () => {
		const { daemon, storage } = makeDaemon();
		mountVfsApi(daemon, { storage });
		// runtime-path + session present (so the session middleware passes), but no org.
		const res = await daemon.app.request("/memory/cat?path=notes/recall.md", {
			headers: { "x-honeycomb-runtime-path": "plugin", "x-honeycomb-session": "sess-vfs-1" },
		});
		expect(res.status).toBe(400);
	});

	it("PRD-022 local mode + NO org header + defaultScope → cat reaches the engine (200, found)", async () => {
		// The browse-side regression: a loopback thin client sends session+runtime-path but no org.
		const { daemon, storage } = makeDaemonMode(cfg());
		mountVfsApi(daemon, { storage, defaultScope: DEFAULT_SCOPE });
		const res = await daemon.app.request("/memory/cat?path=notes/recall.md", { headers: headersNoOrg() });
		expect(res.status).toBe(200);
		const json = (await res.json()) as { found: boolean; content: string };
		expect(json.found).toBe(true);
		expect(json.content).toBe("the recall summary body");
	});

	it("PRD-022 local mode + NO org header + NO defaultScope → still 400 (defensive)", async () => {
		const { daemon, storage } = makeDaemonMode(cfg());
		mountVfsApi(daemon, { storage });
		const res = await daemon.app.request("/memory/cat?path=notes/recall.md", { headers: headersNoOrg() });
		expect(res.status).toBe(400);
	});

	it("PRD-022 TEAM mode + NO org header → REJECTED, never the local fallback (local-only)", async () => {
		const { daemon, storage } = makeDaemonMode(cfgTeam());
		mountVfsApi(daemon, { storage, defaultScope: DEFAULT_SCOPE });
		const res = await daemon.app.request("/memory/cat?path=notes/recall.md", { headers: headersNoOrg() });
		// In team mode the PRD-011 permission middleware rejects the unauthenticated request
		// (401) BEFORE the handler — an even stronger guard than the handler's 400. Either way
		// the request is REJECTED and the local fallback never fires (NOT 200).
		expect(res.status).not.toBe(200);
		expect([400, 401]).toContain(res.status);
	});

	it("PRD-022 org header present (local, with defaultScope) → the HEADER scope wins", async () => {
		const { daemon, storage, fake } = makeDaemonMode(cfg());
		mountVfsApi(daemon, { storage, defaultScope: DEFAULT_SCOPE });
		const res = await daemon.app.request("/memory/cat?path=notes/recall.md", { headers: headers() });
		expect(res.status).toBe(200);
		// The header org (ORG), NOT the injected default, partitioned the cat read.
		const catReq = fake.requests.find((r) => /FROM\s+"memory"\s+WHERE\s+path\s*=/i.test(r.sql));
		expect(catReq?.org).toBe(ORG);
		expect(catReq?.org).not.toBe(DEFAULT_SCOPE.org);
	});

	it("SQL builders interpolate values through the escaping floor (no raw quoting)", () => {
		// A path with an embedded quote must collapse to one inert literal (no early close).
		const cat = buildCatSql("notes/o'brien.md");
		expect(cat).toContain("''"); // the quote is doubled.
		expect(cat).toContain('FROM "memory"');
		// ls / find anchor the ILIKE pattern and escape LIKE wildcards.
		expect(buildLsSql("notes/")).toMatch(/ILIKE\s+'notes\/%'/i);
		expect(buildFindSql("re%call")).toContain("re\\%call"); // `%` escaped for LIKE.
		// grep hydration IN-list quotes each id.
		expect(buildGrepHydrateSql(["a", "b"])).toContain("IN ('a', 'b')");
		expect(buildGrepHydrateSql([])).toBe(""); // empty id set → no statement.
	});
});

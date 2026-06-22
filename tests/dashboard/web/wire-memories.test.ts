/**
 * PRD-040 — the Memories wire-method contract suite.
 *
 * Asserts the new `wire.ts` methods (`listMemories`/`getMemory`/`addMemory`/`modifyMemory`/
 * `forgetMemory`/`compact`) against a recording `fetch` mock:
 *   - the correct method + URL (list GET, get GET /:id, add POST, modify POST /:id/modify,
 *     forget POST /:id/forget, compact POST /api/diagnostics/compact);
 *   - the session headers are stamped on every call (the live `/api/memories` group requires them);
 *   - the POST bodies carry ONLY the documented fields (content/type/agent/reason/table) — no secret;
 *   - a 404 on `getMemory` → null; a non-2xx / malformed body degrades to []/null (never throws);
 *   - the OQ-1 additive fields parse, and a THIN (pre-widen) body still parses (each field `.catch()`).
 */

import { describe, expect, it, vi } from "vitest";

import { createWireClient, MemoryRecordSchema } from "../../../src/dashboard/web/wire.js";

/** Lowercase a HeadersInit into a flat record. */
function headerRecord(init: RequestInit | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	const h = init?.headers;
	if (h === undefined) return out;
	if (h instanceof Headers) h.forEach((v, k) => (out[k.toLowerCase()] = v));
	else if (Array.isArray(h)) for (const [k, v] of h) out[k.toLowerCase()] = v;
	else for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
	return out;
}

interface Call {
	url: string;
	init?: RequestInit;
}

/** A fetch mock returning `body` with `status`, recording (url, init) per call. */
function recordingFetch(body: unknown, status = 200): { fetchImpl: typeof fetch; calls: Call[] } {
	const calls: Call[] = [];
	const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		calls.push({ url: typeof input === "string" ? input : input.toString(), init });
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

const FULL_RECORD = {
	id: "mem-1",
	type: "fact",
	content: "we deploy via just release",
	confidence: 1,
	agentId: "default",
	createdAt: "2026-06-20T00:00:00.000Z",
	updatedAt: "2026-06-21T00:00:00.000Z",
	visibility: "global",
	sourceType: "session",
	sourceId: "sess-9",
	version: 3,
	hasEmbedding: true,
};

describe("PRD-040: listMemories", () => {
	it("GETs /api/memories with a limit, stamps the session headers, and returns the rows", async () => {
		const { fetchImpl, calls } = recordingFetch({ memories: [FULL_RECORD] });
		const rows = await createWireClient({ fetchImpl }).listMemories(50);
		const call = calls.find((c) => c.url.includes("/api/memories"));
		expect(call?.url).toContain("/api/memories?limit=50");
		const headers = headerRecord(call?.init);
		expect(headers["x-honeycomb-runtime-path"]).toBe("plugin");
		expect(headers["x-honeycomb-session"]).toBeTruthy();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe("mem-1");
		expect(rows[0]?.hasEmbedding).toBe(true);
		expect(rows[0]?.version).toBe(3);
	});

	it("a malformed body degrades to [] (never throws)", async () => {
		const { fetchImpl } = recordingFetch({ memories: "boom" });
		expect(await createWireClient({ fetchImpl }).listMemories()).toEqual([]);
	});
});

describe("PRD-040: getMemory", () => {
	it("GETs /api/memories/:id and returns the record", async () => {
		const { fetchImpl, calls } = recordingFetch({ memory: FULL_RECORD });
		const rec = await createWireClient({ fetchImpl }).getMemory("mem-1");
		expect(calls[0]?.url).toContain("/api/memories/mem-1");
		expect(rec?.id).toBe("mem-1");
		expect(rec?.sourceType).toBe("session");
	});

	it("a 404 → null (the forgotten/unknown state)", async () => {
		const { fetchImpl } = recordingFetch({ error: "not_found", id: "gone" }, 404);
		expect(await createWireClient({ fetchImpl }).getMemory("gone")).toBeNull();
	});
});

describe("PRD-040: addMemory", () => {
	it("POSTs /api/memories with content + optional type, and returns the {id,action} ack", async () => {
		const { fetchImpl, calls } = recordingFetch({ id: "mem-2", action: "stored" }, 201);
		const ack = await createWireClient({ fetchImpl }).addMemory({ content: "a new fact", type: "fact" });
		const call = calls[0];
		expect(call?.init?.method).toBe("POST");
		expect(call?.url).toMatch(/\/api\/memories$/);
		const body = JSON.parse(String(call?.init?.body));
		expect(body).toEqual({ content: "a new fact", type: "fact" });
		// No secret/token in the body by construction.
		expect(JSON.stringify(body).toLowerCase()).not.toContain("token");
		expect(ack?.id).toBe("mem-2");
		expect(ack?.action).toBe("stored");
	});

	it("omits the optional type when not supplied", async () => {
		const { fetchImpl, calls } = recordingFetch({ id: "x", action: "stored" }, 201);
		await createWireClient({ fetchImpl }).addMemory({ content: "only content" });
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ content: "only content" });
	});

	it("a non-2xx → null (honest failure)", async () => {
		const { fetchImpl } = recordingFetch({ error: "bad_request" }, 400);
		expect(await createWireClient({ fetchImpl }).addMemory({ content: "" })).toBeNull();
	});
});

describe("PRD-040: modifyMemory (version-bumped, reason-gated)", () => {
	it("POSTs /api/memories/:id/modify with content + the required reason", async () => {
		const { fetchImpl, calls } = recordingFetch({ id: "mem-1", action: "modified", audited: true });
		const ack = await createWireClient({ fetchImpl }).modifyMemory("mem-1", { content: "fixed", reason: "was wrong" });
		const call = calls[0];
		expect(call?.init?.method).toBe("POST");
		expect(call?.url).toContain("/api/memories/mem-1/modify");
		expect(JSON.parse(String(call?.init?.body))).toEqual({ content: "fixed", reason: "was wrong" });
		expect(ack?.audited).toBe(true);
	});

	it("a daemon 400 (e.g. empty reason) → null", async () => {
		const { fetchImpl } = recordingFetch({ error: "bad_request" }, 400);
		expect(await createWireClient({ fetchImpl }).modifyMemory("mem-1", { content: "x", reason: "" })).toBeNull();
	});
});

describe("PRD-040: forgetMemory + compact", () => {
	it("forget POSTs /api/memories/:id/forget with the reason", async () => {
		const { fetchImpl, calls } = recordingFetch({ id: "mem-1", action: "forgotten", audited: true });
		await createWireClient({ fetchImpl }).forgetMemory("mem-1", { reason: "stale" });
		expect(calls[0]?.url).toContain("/api/memories/mem-1/forget");
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ reason: "stale" });
	});

	it("compact POSTs /api/diagnostics/compact (no table → empty body) and parses the summary", async () => {
		const summaryBody = {
			ok: true,
			summaries: [{ table: "skills", keysScanned: 12, keysCompacted: 12, rowsReaped: 30, keysSkipped: 0, errored: 0 }],
			skippedTables: ["entity_attributes"],
		};
		const { fetchImpl, calls } = recordingFetch(summaryBody);
		const summary = await createWireClient({ fetchImpl }).compact();
		expect(calls[0]?.url).toContain("/api/diagnostics/compact");
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({});
		expect(summary?.summaries[0]?.table).toBe("skills");
		expect(summary?.skippedTables).toEqual(["entity_attributes"]);
	});

	it("compact with a table sends only that known table name (no attacker SQL)", async () => {
		const { fetchImpl, calls } = recordingFetch({ ok: true, summaries: [], skippedTables: [] });
		await createWireClient({ fetchImpl }).compact("skills");
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ table: "skills" });
	});

	it("a failed compact → null (compaction unavailable)", async () => {
		const { fetchImpl } = recordingFetch({}, 500);
		expect(await createWireClient({ fetchImpl }).compact()).toBeNull();
	});
});

describe("PRD-040: MemoryRecordSchema degrades a THIN (pre-widen) body", () => {
	it("parses the original thin shape, defaulting the OQ-1 fields", () => {
		const thin = {
			id: "mem-1",
			type: "fact",
			content: "c",
			confidence: 1,
			agentId: "default",
			createdAt: "t",
			updatedAt: "t",
		};
		const parsed = MemoryRecordSchema.parse(thin);
		expect(parsed.id).toBe("mem-1");
		expect(parsed.visibility).toBe("");
		expect(parsed.sourceType).toBe("");
		expect(parsed.version).toBe(0);
		expect(parsed.hasEmbedding).toBe(false);
	});

	it("a malformed field `.catch()`es rather than throwing", () => {
		const parsed = MemoryRecordSchema.parse({ id: "m", version: "not-a-number", hasEmbedding: "nope" });
		expect(parsed.version).toBe(0);
		expect(parsed.hasEmbedding).toBe(false);
	});
});

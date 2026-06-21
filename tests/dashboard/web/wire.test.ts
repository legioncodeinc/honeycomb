/**
 * PRD-024 Wave 3 — the dashboard WIRE-LAYER header contract suite.
 *
 * The live-dogfood blind spot: the DOM/app suite mocks `fetch` and only asserts the rendered
 * output, so it never checked WHAT HEADERS the client sends. The live daemon's `/api/memories`
 * group sits behind the runtime-path + session middleware
 * (`src/daemon/runtime/middleware/runtime-path.ts`), which REQUIRES
 * `x-honeycomb-runtime-path: plugin|legacy` AND a non-empty `x-honeycomb-session`. Because the
 * browser client never stamped them, recall (and every diagnostics view) 400'd live and every
 * panel blanked.
 *
 * This suite captures the `init` arg of each `fetchImpl(...)` call and asserts the two
 * non-tenant session headers ARE present — the assertion that would have caught the live
 * failure. It also asserts the client does NOT stamp `x-honeycomb-org` (the local default
 * supplies it; a wrong/empty org would trip the cross-tenant guard).
 */

import { describe, expect, it, vi } from "vitest";

import { createWireClient, DASHBOARD_SESSION_HEADERS } from "../../../src/dashboard/web/wire.js";

/** Lowercase a HeadersInit (object | Headers | array) into a flat record for assertion. */
function headerRecord(init: RequestInit | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	const h = init?.headers;
	if (h === undefined) return out;
	if (h instanceof Headers) {
		h.forEach((v, k) => (out[k.toLowerCase()] = v));
	} else if (Array.isArray(h)) {
		for (const [k, v] of h) out[k.toLowerCase()] = v;
	} else {
		for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
	}
	return out;
}

/** A fetch mock that records (url, init) for every call and returns a canned JSON body. */
function recordingFetch(body: unknown): { fetchImpl: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		calls.push({ url: typeof input === "string" ? input : input.toString(), init });
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

describe("PRD-024 Wave 3: the wire client stamps the runtime-path + session headers", () => {
	it("the recall POST carries x-honeycomb-runtime-path: plugin and a non-empty x-honeycomb-session", async () => {
		const { fetchImpl, calls } = recordingFetch({ hits: [], sources: [], degraded: false });
		const client = createWireClient({ fetchImpl });
		await client.recall("anything");

		const recallCall = calls.find((c) => c.url.includes("/api/memories/recall"));
		expect(recallCall, "recall hit the endpoint").toBeTruthy();
		const headers = headerRecord(recallCall?.init);
		// THE assertion that would have caught the live 400: the session middleware contract.
		expect(headers["x-honeycomb-runtime-path"]).toBe("plugin");
		expect(headers["x-honeycomb-session"]).toBeTruthy();
		expect(headers["x-honeycomb-session"].length).toBeGreaterThan(0);
		// It is a POST with the JSON content-type still present (not clobbered by the merge).
		expect(recallCall?.init?.method).toBe("POST");
		expect(headers["content-type"]).toBe("application/json");
		// It must NOT forge a tenant org (the daemon's local default supplies it).
		expect(headers["x-honeycomb-org"]).toBeUndefined();
	});

	it("a diagnostics GET (kpis) carries the same runtime-path + session headers", async () => {
		const { fetchImpl, calls } = recordingFetch({ memoryCount: 0, sessionCount: 0, estimatedSavings: 0 });
		const client = createWireClient({ fetchImpl });
		await client.kpis();

		const kpisCall = calls.find((c) => c.url.includes("/api/diagnostics/kpis"));
		expect(kpisCall, "kpis hit the endpoint").toBeTruthy();
		const headers = headerRecord(kpisCall?.init);
		expect(headers["x-honeycomb-runtime-path"]).toBe("plugin");
		expect(headers["x-honeycomb-session"]).toBeTruthy();
		// The accept header is preserved alongside the stamped session headers.
		expect(headers["accept"]).toBe("application/json");
		// No tenant org forged on the GET either.
		expect(headers["x-honeycomb-org"]).toBeUndefined();
	});

	it("the exported header constant carries exactly the two non-credential session headers", () => {
		// No token/secret/credential rides these (D-4): only the runtime-path + session id.
		expect(DASHBOARD_SESSION_HEADERS["x-honeycomb-runtime-path"]).toBe("plugin");
		expect(DASHBOARD_SESSION_HEADERS["x-honeycomb-session"]).toBe("dashboard-web");
		const keys = Object.keys(DASHBOARD_SESSION_HEADERS).map((k) => k.toLowerCase());
		for (const forbidden of ["authorization", "x-honeycomb-org", "x-honeycomb-token", "cookie"]) {
			expect(keys).not.toContain(forbidden);
		}
	});
});

describe("PRD-027 AC-4: recall() carries the ENGINE score in ENGINE order (no `1 - i*0.06` fabrication)", () => {
	/** A fetch mock that answers the recall POST with a canned `{hits,sources,degraded}` body. */
	function recallFetch(body: unknown): typeof fetch {
		return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/memories/recall")) {
				return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;
	}

	it("maps each hit to the ENGINE `score`/`kind`/`secondary`, preserving the engine's order (no re-sort)", async () => {
		// The engine returns hits ALREADY ranked DESC by fused RRF — a distilled `memory` fact (0.42)
		// ahead of a raw `session` drill-down (0.17). The OLD fabrication (`1 - i*0.06`) would have
		// stamped 1.00 then 0.94 regardless of these values; the engine score must win.
		const fetchImpl = recallFetch({
			hits: [
				{ source: "memories", id: "deploy/prd-022", text: "distilled fact", score: 0.42, kind: "memory", secondary: false },
				{ source: "sessions", id: "sess-9", text: "raw session dump", score: 0.17, kind: "session", secondary: true },
			],
			sources: ["memories", "sessions"],
			degraded: false,
		});
		const client = createWireClient({ fetchImpl });
		const { memories, degraded } = await client.recall("how do we deploy");

		expect(degraded).toBe(false);
		// ENGINE order preserved verbatim — the distilled fact first, the raw session second.
		expect(memories.map((m) => m.memoryKey)).toEqual(["deploy/prd-022", "sess-9"]);
		// The ENGINE score rides through — NOT the fabricated `1 - i*0.06` (which would be 1.00 / 0.94).
		expect(memories[0]?.score).toBe(0.42);
		expect(memories[1]?.score).toBe(0.17);
		expect(memories[0]?.score).not.toBe(1); // the old fabrication's first value is gone
		// Provenance class threads through so the card can demote the raw session row.
		expect(memories[0]?.kind).toBe("memory");
		expect(memories[0]?.secondary).toBe(false);
		expect(memories[1]?.kind).toBe("session");
		expect(memories[1]?.secondary).toBe(true);
	});

	it("a hit with a LOWER score earlier in the list is NOT re-sorted (the engine owns the order)", async () => {
		// Defensive: even if the engine ever emitted a locally-out-of-DESC pair, the client renders
		// the engine order verbatim — it never re-sorts. (The engine guarantees DESC; the client trusts it.)
		const fetchImpl = recallFetch({
			hits: [
				{ source: "memories", id: "a", text: "first", score: 0.3, kind: "memory", secondary: false },
				{ source: "memory", id: "b", text: "second", score: 0.9, kind: "memory", secondary: false },
			],
			sources: ["memories", "memory"],
			degraded: false,
		});
		const client = createWireClient({ fetchImpl });
		const { memories } = await client.recall("q");
		// Order is the WIRE order (a, b) — the client did not sort b ahead of a on its 0.9 score.
		expect(memories.map((m) => m.memoryKey)).toEqual(["a", "b"]);
		expect(memories.map((m) => m.score)).toEqual([0.3, 0.9]);
	});

	it("degrades gracefully when an older daemon omits score/kind/secondary (.catch defaults)", async () => {
		// A pre-Wave-1 daemon sends only `{source,id,text}`; the schema `.catch()`es to safe defaults
		// (score 0, kind "memory", secondary false) so the client still renders rather than throwing.
		const fetchImpl = recallFetch({
			hits: [{ source: "memory", id: "old", text: "legacy hit" }],
			sources: ["memory"],
			degraded: true,
		});
		const client = createWireClient({ fetchImpl });
		const { memories } = await client.recall("q");
		expect(memories).toHaveLength(1);
		expect(memories[0]?.score).toBe(0);
		expect(memories[0]?.kind).toBe("memory");
		expect(memories[0]?.secondary).toBe(false);
	});
});

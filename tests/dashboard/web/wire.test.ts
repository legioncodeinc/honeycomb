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

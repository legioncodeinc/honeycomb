/**
 * PRD-041b — the memory-graph wire-method contract suite.
 *
 * Asserts the new `wire.memoryGraph()` method against a recording `fetch` mock:
 *   - it GETs `/api/diagnostics/memory-graph` (mirroring `graph()` → `/api/graph`);
 *   - it stamps the session headers (the loopback thin-client contract) and forges NO tenant org;
 *   - a built `GraphView`-shaped body parses through the shared GraphSchema and returns its nodes/edges;
 *   - a `built:false` body / a malformed body / a non-2xx degrades to EMPTY_GRAPH (never throws).
 * Also asserts `graph()` is unchanged (the codebase source is untouched — the toggle adds a 2nd source).
 */

import { describe, expect, it, vi } from "vitest";

import { createWireClient, EMPTY_GRAPH } from "../../../src/dashboard/web/wire.js";

/** Lowercase a HeadersInit into a flat record for assertion. */
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

const BUILT_MEMORY_GRAPH = {
	built: true,
	nodes: [
		{ id: "e1", label: "Mario", kind: "entity" },
		{ id: "e2", label: "Honeycomb", kind: "entity" },
	],
	edges: [{ from: "e1", to: "e2", kind: "depends_on" }],
};

describe("PRD-041b: wire.memoryGraph()", () => {
	it("GETs /api/diagnostics/memory-graph and returns the GraphView-shaped body", async () => {
		const { fetchImpl, calls } = recordingFetch(BUILT_MEMORY_GRAPH);
		const client = createWireClient({ fetchImpl });
		const view = await client.memoryGraph();

		const call = calls.find((c) => c.url.includes("/api/diagnostics/memory-graph"));
		expect(call, "memoryGraph hit the endpoint").toBeTruthy();
		expect(view.built).toBe(true);
		expect(view.nodes).toHaveLength(2);
		expect(view.edges).toEqual([{ from: "e1", to: "e2", kind: "depends_on" }]);
	});

	it("stamps the runtime-path + session headers and forges no tenant org", async () => {
		const { fetchImpl, calls } = recordingFetch(BUILT_MEMORY_GRAPH);
		const client = createWireClient({ fetchImpl });
		await client.memoryGraph();
		const headers = headerRecord(calls.find((c) => c.url.includes("/memory-graph"))?.init);
		expect(headers["x-honeycomb-runtime-path"]).toBe("plugin");
		expect(headers["x-honeycomb-session"]).toBeTruthy();
		expect(headers["x-honeycomb-org"]).toBeUndefined();
	});

	it("a built:false body returns the empty graph (the page renders its honest empty state)", async () => {
		const { fetchImpl } = recordingFetch({ built: false, nodes: [], edges: [] });
		const client = createWireClient({ fetchImpl });
		const view = await client.memoryGraph();
		expect(view).toEqual(EMPTY_GRAPH);
	});

	it("a malformed body / non-2xx degrades to EMPTY_GRAPH (never throws)", async () => {
		const bad = recordingFetch({ not: "a graph" }, 500);
		const client = createWireClient({ fetchImpl: bad.fetchImpl });
		expect(await client.memoryGraph()).toEqual(EMPTY_GRAPH);
	});

	it("graph() (the codebase source) is unchanged — it GETs /api/graph", async () => {
		const { fetchImpl, calls } = recordingFetch({ built: true, nodes: [], edges: [] });
		const client = createWireClient({ fetchImpl });
		await client.graph();
		expect(calls.find((c) => c.url.endsWith("/api/graph"))).toBeTruthy();
		// And memoryGraph hits a DIFFERENT path (the two sources are distinct endpoints).
		await client.memoryGraph();
		expect(calls.find((c) => c.url.includes("/api/diagnostics/memory-graph"))).toBeTruthy();
	});
});

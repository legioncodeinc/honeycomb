/**
 * PRD-046e MCP tool test suite — hivemind_read + hivemind_search.
 *
 * Proves:
 *   e-AC-1  hivemind_read routes to GET /api/memories/resolve (not a recall endpoint).
 *           The ref + depth + source are forwarded on the URL; the seam records one call.
 *   e-AC-3  hivemind_search routes through the RRF recall engine (POST /api/memories/recall),
 *           not to /hybrid or any native deeplake_hybrid_record path. The `degraded` field
 *           is forwarded honestly from the recall response.
 *   e-AC-3b No native hybrid path: hivemind_search NEVER calls /api/memories/hybrid or any
 *           endpoint containing "hybrid".
 *   Surface  Both tools are listed in the registered surface (they are not conditional).
 */

import { describe, expect, it } from "vitest";

import {
	type Actor,
	createFakeDaemonApiSeam,
	createMcpServer,
	createMcpToolRegistry,
	registerHoneycombSurface,
	TOOL_SPECS,
} from "../../mcp/src/index.js";
import { HANDLERS } from "../../mcp/src/handlers.js";

const ACTOR: Actor = { actor: "agent-046e", actorType: "agent" };

// ─────────────────────────────────────────────────────────────────────────────
// Surface registration
// ─────────────────────────────────────────────────────────────────────────────

describe("e-AC surface — hivemind_read + hivemind_search appear in the registered surface", () => {
	it("hivemind_read and hivemind_search are in TOOL_SPECS (not conditional)", () => {
		const names = TOOL_SPECS.map((t) => t.name);
		expect(names).toContain("hivemind_read");
		expect(names).toContain("hivemind_search");

		const readSpec = TOOL_SPECS.find((t) => t.name === "hivemind_read");
		const searchSpec = TOOL_SPECS.find((t) => t.name === "hivemind_search");
		expect(readSpec?.conditional).toBeFalsy();
		expect(searchSpec?.conditional).toBeFalsy();
	});

	it("hivemind_read and hivemind_search are registered in the server surface by default", () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: {} });
		const handle = createMcpServer({ daemon, actor: ACTOR });
		expect(handle.toolNames).toContain("hivemind_read");
		expect(handle.toolNames).toContain("hivemind_search");
	});

	it("both tools have handlers in the HANDLERS table", () => {
		expect(HANDLERS["hivemind_read"]).toBeDefined();
		expect(HANDLERS["hivemind_search"]).toBeDefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// e-AC-1: hivemind_read routes to /api/memories/resolve
// ─────────────────────────────────────────────────────────────────────────────

describe("e-AC-1 — hivemind_read routes to GET /api/memories/resolve (not recall)", () => {
	it("hivemind_read issues GET to /api/memories/resolve with ref encoded in the URL", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: { found: true, depth: 1, source: "episodic" } });
		await HANDLERS.hivemind_read({ ref: "/summaries/alice/s1", depth: 1, source: "episodic" }, ACTOR, daemon);

		expect(daemon.calls.length).toBe(1);
		expect(daemon.calls[0].method).toBe("GET");
		// Routes to the resolve endpoint, not recall.
		expect(daemon.calls[0].path).toContain("/api/memories/resolve");
		expect(daemon.calls[0].path).not.toContain("/recall");
		expect(daemon.calls[0].path).not.toContain("ILIKE");
		expect(daemon.calls[0].path).not.toContain("hybrid");
		// The ref is URL-encoded in the path.
		expect(daemon.calls[0].path).toContain("ref=");
		expect(daemon.calls[0].actor).toEqual(ACTOR);
	});

	it("hivemind_read depth=2 includes depth=2 and source in the URL", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: { found: true, depth: 2 } });
		await HANDLERS.hivemind_read({ ref: "/summaries/x/s1", depth: 2, source: "episodic" }, ACTOR, daemon);

		expect(daemon.calls[0].path).toContain("depth=2");
		expect(daemon.calls[0].path).toContain("source=episodic");
	});

	it("hivemind_read durable ref uses source=durable in the URL", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: { found: true, depth: 1 } });
		await HANDLERS.hivemind_read({ ref: "mem_d9", depth: 1, source: "durable" }, ACTOR, daemon);

		expect(daemon.calls[0].path).toContain("source=durable");
		expect(daemon.calls[0].path).toContain("/api/memories/resolve");
	});

	it("hivemind_read defaults depth=1 and source=episodic when omitted", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: { found: false } });
		await HANDLERS.hivemind_read({ ref: "some-ref" }, ACTOR, daemon);

		expect(daemon.calls[0].path).toContain("depth=1");
		expect(daemon.calls[0].path).toContain("source=episodic");
	});

	it("hivemind_read with turns param appends turns to the URL", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: { found: true, depth: 2 } });
		await HANDLERS.hivemind_read({ ref: "/s/1", depth: 2, source: "episodic", turns: 25 }, ACTOR, daemon);

		expect(daemon.calls[0].path).toContain("turns=25");
	});

	it("hivemind_read with unknown args is rejected by the strict schema", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: {} });
		const registry = createMcpToolRegistry({ daemon, actor: ACTOR });
		registerHoneycombSurface(registry);

		const out = await registry.invoke("hivemind_read", { ref: "/s/1", bogus: "extra" });
		expect(out.isError).toBe(true);
		// Unknown arg rejected — no daemon call.
		expect(daemon.calls.length).toBe(0);
	});

	it("hivemind_read with missing ref: strict schema accepts (ref is required)", async () => {
		// `ref` is z.string() — required. Calling with {} should fail the schema.
		const daemon = createFakeDaemonApiSeam({ status: 200, body: {} });
		const registry = createMcpToolRegistry({ daemon, actor: ACTOR });
		registerHoneycombSurface(registry);

		const out = await registry.invoke("hivemind_read", {});
		// No `ref` → schema rejects.
		expect(out.isError).toBe(true);
		expect(daemon.calls.length).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// e-AC-3: hivemind_search routes through RRF recall (not native hybrid)
// ─────────────────────────────────────────────────────────────────────────────

describe("e-AC-3 — hivemind_search routes through POST /api/memories/recall (RRF, not native hybrid)", () => {
	it("hivemind_search issues POST to /api/memories/recall", async () => {
		const daemon = createFakeDaemonApiSeam({
			status: 200,
			body: { hits: [], sources: [], degraded: false },
		});
		await HANDLERS.hivemind_search({ query: "eventual consistency" }, ACTOR, daemon);

		expect(daemon.calls.length).toBe(1);
		expect(daemon.calls[0].method).toBe("POST");
		expect(daemon.calls[0].path).toBe("/api/memories/recall");
		expect(daemon.calls[0].actor).toEqual(ACTOR);
	});

	it("e-AC-3b hivemind_search does NOT call any hybrid endpoint (no deeplake_hybrid_record path)", async () => {
		const daemon = createFakeDaemonApiSeam({
			status: 200,
			body: { hits: [], sources: [], degraded: true },
		});
		await HANDLERS.hivemind_search({ query: "sql guards" }, ACTOR, daemon);

		// Must not route to any hybrid-operator endpoint.
		expect(daemon.calls[0].path).not.toContain("hybrid");
		expect(daemon.calls[0].path).not.toContain("deeplake_hybrid_record");
		// Must be the wired recall (RRF) endpoint.
		expect(daemon.calls[0].path).toBe("/api/memories/recall");
	});

	it("e-AC-3 degraded:true is forwarded honestly when embeddings are off", async () => {
		const daemon = createFakeDaemonApiSeam({
			status: 200,
			body: { hits: [], sources: [], degraded: true },
		});
		const result = await HANDLERS.hivemind_search({ query: "query" }, ACTOR, daemon) as {
			degraded?: boolean;
			hits?: unknown[];
		};
		expect(result.degraded).toBe(true);
	});

	it("e-AC-3 degraded:false is forwarded when semantic arm ran", async () => {
		const daemon = createFakeDaemonApiSeam({
			status: 200,
			body: {
				hits: [{ source: "memories", id: "m1", text: "eventual consistency", score: 0.02, kind: "memory", secondary: false }],
				sources: ["memories"],
				degraded: false,
			},
		});
		const result = await HANDLERS.hivemind_search({ query: "eventual" }, ACTOR, daemon) as {
			degraded?: boolean;
			hits?: unknown[];
		};
		expect(result.degraded).toBe(false);
		expect(Array.isArray(result.hits)).toBe(true);
	});

	it("hivemind_search forwards the limit arg to the recall body", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: { hits: [], sources: [], degraded: true } });
		await HANDLERS.hivemind_search({ query: "q", limit: 5 }, ACTOR, daemon);

		const body = daemon.calls[0].body as Record<string, unknown>;
		expect(body.limit).toBe(5);
	});

	it("hivemind_search with an extra arg is rejected by the strict schema", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: {} });
		const registry = createMcpToolRegistry({ daemon, actor: ACTOR });
		registerHoneycombSurface(registry);

		const out = await registry.invoke("hivemind_search", { query: "hi", bogus: "no" });
		expect(out.isError).toBe(true);
		expect(daemon.calls.length).toBe(0);
	});

	it("hivemind_search with a missing query is rejected by the strict schema", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: {} });
		const registry = createMcpToolRegistry({ daemon, actor: ACTOR });
		registerHoneycombSurface(registry);

		const out = await registry.invoke("hivemind_search", {});
		expect(out.isError).toBe(true);
		expect(daemon.calls.length).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-tool: both tools stamp actor + route through daemon seam
// ─────────────────────────────────────────────────────────────────────────────

describe("d-AC-1 cross-check — hivemind_read + hivemind_search stamp actor and route through daemon", () => {
	it("hivemind_read stamps the actor on the daemon call", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: { found: false } });
		await HANDLERS.hivemind_read({ ref: "r" }, ACTOR, daemon);
		expect(daemon.calls[0].actor).toEqual(ACTOR);
	});

	it("hivemind_search stamps the actor on the daemon call", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: { hits: [], sources: [], degraded: true } });
		await HANDLERS.hivemind_search({ query: "q" }, ACTOR, daemon);
		expect(daemon.calls[0].actor).toEqual(ACTOR);
	});
});

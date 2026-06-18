/**
 * PRD-019d MCP unified tool surface — d-AC-1, d-AC-3, index AC-3, FR-10.
 *
 * Verification posture (D-2 / D-6): every handler is driven against a recording
 * `FakeDaemonApiSeam` — no daemon, no socket, no DeepLake. Each test is named after
 * the AC it proves so the ledger maps one-to-one to a passing test. We assert the
 * seam STAMPS the plugin runtime-path + actor headers (D-6: assert the stamp, the
 * daemon enforces) and that every registered handler routes through the seam.
 */

import { describe, expect, it } from "vitest";
import {
	type Actor,
	createFakeDaemonApiSeam,
	createMcpServer,
	createMcpToolRegistry,
	REASON_REQUIRED_TOOLS,
	registerHoneycombSurface,
	TOOL_SPECS,
} from "../../mcp/src/index.js";
import { HANDLERS } from "../../mcp/src/handlers.js";

const ACTOR: Actor = { actor: "agent-7", actorType: "agent" };

/** The full non-conditional surface (codebase excluded unless graphBuilt). */
const BASE_TOOL_NAMES = TOOL_SPECS.filter((t) => t.conditional !== true).map((t) => t.name);

describe("d-AC-1: unified surface lists + stamps plugin + actor", () => {
	it("d-AC-1 a harness listing tools sees the unified honeycomb_ surface", () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: {} });
		const handle = createMcpServer({ daemon, actor: ACTOR });
		// The unified surface (codebase gated off by default) is registered + listed.
		expect([...handle.toolNames].sort()).toEqual([...BASE_TOOL_NAMES].sort());
		// Spot-check each cluster is represented.
		expect(handle.toolNames).toContain("memory_search");
		expect(handle.toolNames).toContain("honeycomb_read");
		expect(handle.toolNames).toContain("session_search");
		expect(handle.toolNames).toContain("honeycomb_goal_add");
		expect(handle.toolNames).toContain("agent_peers");
		expect(handle.toolNames).toContain("secret_list");
	});

	it("d-AC-1 every handler routes through the daemon seam, stamping plugin + actor", async () => {
		// Drive EVERY non-reason, non-secret handler and assert it produced exactly one
		// seam call carrying the actor. (reason-required + value-safe paths covered below
		// and in secrets.test.ts.) This proves the surface is one thin client of the daemon.
		for (const spec of TOOL_SPECS) {
			if (REASON_REQUIRED_TOOLS.includes(spec.name)) continue;
			const daemon = createFakeDaemonApiSeam({ status: 200, body: { names: [] } });
			const handler = HANDLERS[spec.name];
			expect(handler, `handler missing for ${spec.name}`).toBeDefined();
			await handler(minimalArgs(spec.name), ACTOR, daemon);
			expect(daemon.calls.length, `${spec.name} made no daemon call`).toBe(1);
			expect(daemon.calls[0].actor).toEqual(ACTOR);
		}
	});

	it("d-AC-1 the production seam stamps x-honeycomb-runtime-path: plugin + actor headers", async () => {
		// The real HTTP seam stamps the plugin runtime-path + actor headers on the wire
		// (D-6). Inject a fake fetch so no socket is bound; assert the headers.
		const { createHttpDaemonApiSeam, RUNTIME_PATH_HEADER, ACTOR_HEADER, ACTOR_TYPE_HEADER } =
			await import("../../mcp/src/daemon-seam.js");
		let seen: Record<string, string> = {};
		const seam = createHttpDaemonApiSeam({
			fetch: async (_url, init) => {
				seen = init.headers;
				return { status: 200, async json() {
					return {};
				}, async text() {
					return "";
				} };
			},
		});
		await seam.call({ method: "POST", path: "/api/memories/search", body: { query: "x" }, actor: ACTOR });
		expect(seen[RUNTIME_PATH_HEADER]).toBe("plugin");
		expect(seen[ACTOR_HEADER]).toBe("agent-7");
		expect(seen[ACTOR_TYPE_HEADER]).toBe("agent");
	});
});

describe("index AC-3: MCP harness lists unified surface; every handler routes through daemon API", () => {
	it("AC-3 the registry registers the full base surface and each registered tool has a handler", () => {
		const daemon = createFakeDaemonApiSeam();
		const registry = createMcpToolRegistry({ daemon, actor: ACTOR });
		registerHoneycombSurface(registry);
		expect([...registry.registered].sort()).toEqual([...BASE_TOOL_NAMES].sort());
		for (const name of registry.registered) {
			expect(HANDLERS[name], `no handler for registered tool ${name}`).toBeDefined();
		}
	});
});

describe("d-AC-3: modify/forget without a reason are rejected", () => {
	it("d-AC-3 memory_modify without reason is rejected before any daemon call", async () => {
		const daemon = createFakeDaemonApiSeam();
		const res = (await HANDLERS.memory_modify({ path: "/m/x" }, ACTOR, daemon)) as {
			isError?: boolean;
			message?: string;
		};
		expect(res.isError).toBe(true);
		expect(res.message).toMatch(/reason/i);
		// The gate short-circuited — the daemon was NEVER reached.
		expect(daemon.calls.length).toBe(0);
	});

	it("d-AC-3 memory_forget without reason is rejected before any daemon call", async () => {
		const daemon = createFakeDaemonApiSeam();
		const res = (await HANDLERS.memory_forget({ path: "/m/x" }, ACTOR, daemon)) as {
			isError?: boolean;
		};
		expect(res.isError).toBe(true);
		expect(daemon.calls.length).toBe(0);
	});

	it("d-AC-3 an empty/whitespace reason is also rejected", async () => {
		const daemon = createFakeDaemonApiSeam();
		const res = (await HANDLERS.memory_modify({ path: "/m/x", reason: "   " }, ACTOR, daemon)) as {
			isError?: boolean;
		};
		expect(res.isError).toBe(true);
		expect(daemon.calls.length).toBe(0);
	});

	it("d-AC-3 memory_modify WITH a reason routes through to the daemon", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: { ok: true } });
		await HANDLERS.memory_modify({ path: "/m/x", reason: "stale" }, ACTOR, daemon);
		expect(daemon.calls.length).toBe(1);
		expect(daemon.calls[0].method).toBe("PATCH");
		expect(daemon.calls[0].actor).toEqual(ACTOR);
	});
});

describe("FR-10: unknown / extra args are rejected, not passed to the daemon", () => {
	it("FR-10 a tool called with an extra arg is rejected without a daemon call", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: {} });
		const registry = createMcpToolRegistry({ daemon, actor: ACTOR });
		registerHoneycombSurface(registry);
		// Drive the EXACT wrapped handler the SDK runs over either transport.
		const out = await registry.invoke("memory_search", { query: "hi", bogus: "nope" });
		expect(out.isError).toBe(true);
		// The strict schema rejected BEFORE dispatch — no daemon call.
		expect(daemon.calls.length).toBe(0);
	});

	it("FR-10 a valid call passes strict parsing and reaches the daemon once", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: { hits: [] } });
		const registry = createMcpToolRegistry({ daemon, actor: ACTOR });
		registerHoneycombSurface(registry);
		await registry.invoke("memory_search", { query: "hi" });
		expect(daemon.calls.length).toBe(1);
		expect(daemon.calls[0].path).toBe("/api/memories/search");
	});
});

/** Minimal valid args for a tool, derived from its name (covers required fields). */
function minimalArgs(name: string): Record<string, unknown> {
	switch (name) {
		case "memory_search":
		case "honeycomb_search":
		case "honeycomb_code_search":
		case "session_search":
			return { query: "q" };
		case "memory_store":
			return { text: "t" };
		case "memory_get":
		case "memory_list":
		case "honeycomb_read":
		case "honeycomb_index":
		case "memory_feedback":
			return { path: "/p" };
		case "session_bypass":
			return { sessionId: "s" };
		case "honeycomb_goal_add":
			return { goal: "g" };
		case "honeycomb_kpi_add":
			return { kpi: "k" };
		case "agent_peers":
		case "agent_message_inbox":
			return {};
		case "agent_message_send":
			return { to: "a", message: "m" };
		case "honeycomb_code_context":
		case "honeycomb_code_blast":
		case "honeycomb_code_impact":
			return { symbol: "sym" };
		case "secret_list":
			return {};
		case "secret_exec":
			return { command: "echo hi" };
		default:
			return {};
	}
}

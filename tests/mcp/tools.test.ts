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
		expect(handle.toolNames).toContain("honeycomb_goal_add");
		expect(handle.toolNames).toContain("secret_list");
		// C-2: the sessions/agent clusters + memory_feedback were UNREGISTERED (no backing
		// daemon route) — they must never appear in the registered surface again.
		expect(handle.toolNames).not.toContain("session_search");
		expect(handle.toolNames).not.toContain("session_bypass");
		expect(handle.toolNames).not.toContain("agent_peers");
		expect(handle.toolNames).not.toContain("agent_message_send");
		expect(handle.toolNames).not.toContain("agent_message_inbox");
		expect(handle.toolNames).not.toContain("memory_feedback");
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
		const { createHttpDaemonApiSeam, RUNTIME_PATH_HEADER, ACTOR_HEADER, ACTOR_TYPE_HEADER } = await import(
			"../../mcp/src/daemon-seam.js"
		);
		let seen: Record<string, string> = {};
		const seam = createHttpDaemonApiSeam({
			fetch: async (_url, init) => {
				seen = init.headers;
				return {
					status: 200,
					async json() {
						return {};
					},
					async text() {
						return "";
					},
				};
			},
		});
		await seam.call({ method: "POST", path: "/api/memories/recall", body: { query: "x" }, actor: ACTOR });
		expect(seen[RUNTIME_PATH_HEADER]).toBe("plugin");
		expect(seen[ACTOR_HEADER]).toBe("agent-7");
		expect(seen[ACTOR_TYPE_HEADER]).toBe("agent");
		// PRD-022d / d-AC-3: a SESSION-group call (/api/memories) also stamps the session header.
		expect(seen["x-honeycomb-session"], "session-group call stamps x-honeycomb-session").toBeDefined();
	});

	it("d-AC-3 a NON-session daemon call does NOT stamp x-honeycomb-session", async () => {
		const { createHttpDaemonApiSeam } = await import("../../mcp/src/daemon-seam.js");
		let seen: Record<string, string> = {};
		const seam = createHttpDaemonApiSeam({
			fetch: async (_url, init) => {
				seen = init.headers;
				return {
					status: 200,
					async json() {
						return {};
					},
					async text() {
						return "";
					},
				};
			},
		});
		await seam.call({ method: "GET", path: "/api/goals", actor: ACTOR });
		expect(seen["x-honeycomb-runtime-path"]).toBe("plugin");
		expect(seen["x-honeycomb-session"]).toBeUndefined();
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
		await HANDLERS.memory_modify({ path: "/m/x", content: "new content", reason: "stale" }, ACTOR, daemon);
		expect(daemon.calls.length).toBe(1);
		// C-2 fix: the real route is POST /api/memories/:id/modify, not PATCH /api/memories.
		expect(daemon.calls[0].method).toBe("POST");
		expect(daemon.calls[0].path).toBe("/api/memories/%2Fm%2Fx/modify");
		expect(daemon.calls[0].body).toEqual({ content: "new content", reason: "stale" });
		expect(daemon.calls[0].actor).toEqual(ACTOR);
	});
});

describe("C-2: memory_modify / memory_forget dial the real POST /api/memories/:id/modify|forget shape", () => {
	it("memory_modify requires `content` and rides the id on the URL path (URL-encoded)", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: { id: "m1", action: "updated" } });
		await HANDLERS.memory_modify({ path: "m/1 a", content: "updated body", reason: "fix typo" }, ACTOR, daemon);
		expect(daemon.calls.length).toBe(1);
		expect(daemon.calls[0].method).toBe("POST");
		expect(daemon.calls[0].path).toBe("/api/memories/m%2F1%20a/modify");
		expect(daemon.calls[0].path).not.toContain("PATCH");
		expect(daemon.calls[0].body).toEqual({ content: "updated body", reason: "fix typo" });
	});

	it("memory_forget rides the id on the URL path and sends only `reason`", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: { id: "m1", action: "forgotten" } });
		await HANDLERS.memory_forget({ path: "m/1 a", reason: "stale" }, ACTOR, daemon);
		expect(daemon.calls.length).toBe(1);
		expect(daemon.calls[0].method).toBe("POST");
		expect(daemon.calls[0].path).toBe("/api/memories/m%2F1%20a/forget");
		expect(daemon.calls[0].body).toEqual({ reason: "stale" });
	});
});

describe("C-2: honeycomb_search / honeycomb_read / honeycomb_index dial the real VFS routes", () => {
	it("honeycomb_search issues GET /memory/grep?q=<query> (not POST /memory/search)", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: { query: "x", degraded: false, hits: [] } });
		await HANDLERS.honeycomb_search({ query: "eventual consistency" }, ACTOR, daemon);
		expect(daemon.calls.length).toBe(1);
		expect(daemon.calls[0].method).toBe("GET");
		expect(daemon.calls[0].path).toBe("/memory/grep?q=eventual%20consistency");
	});

	it("honeycomb_read issues GET /memory/cat?path=<path> (not GET /memory/read)", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: { path: "/p", found: true, content: "hi" } });
		await HANDLERS.honeycomb_read({ path: "/summaries/alice/s1" }, ACTOR, daemon);
		expect(daemon.calls.length).toBe(1);
		expect(daemon.calls[0].method).toBe("GET");
		expect(daemon.calls[0].path).toBe("/memory/cat?path=%2Fsummaries%2Falice%2Fs1");
	});

	it("honeycomb_index issues GET /memory/ls?prefix=<prefix> (not GET /memory/index)", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: { prefix: "", entries: [] } });
		await HANDLERS.honeycomb_index({ prefix: "/summaries" }, ACTOR, daemon);
		expect(daemon.calls.length).toBe(1);
		expect(daemon.calls[0].method).toBe("GET");
		expect(daemon.calls[0].path).toBe("/memory/ls?prefix=%2Fsummaries");
	});
});

describe("C-2 follow-up: honeycomb_goal_add / honeycomb_kpi_add send the daemon's strict keyed body", () => {
	it("honeycomb_goal_add maps the goal text onto the strict { key, value } keyed body", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 201, body: { ok: true } });
		await HANDLERS.honeycomb_goal_add({ goal: "ship v1" }, ACTOR, daemon);
		expect(daemon.calls.length).toBe(1);
		expect(daemon.calls[0].method).toBe("POST");
		expect(daemon.calls[0].path).toBe("/api/goals");
		// The keyed engine's `.strict()` schema requires { key, value } — the raw
		// { goal } body 400'd on every call before this fix.
		expect(daemon.calls[0].body).toEqual({ key: "ship v1", value: "ship v1" });
	});

	it("honeycomb_kpi_add maps the kpi text onto the strict { key, value } keyed body", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 201, body: { ok: true } });
		await HANDLERS.honeycomb_kpi_add({ kpi: "weekly active users" }, ACTOR, daemon);
		expect(daemon.calls.length).toBe(1);
		expect(daemon.calls[0].method).toBe("POST");
		expect(daemon.calls[0].path).toBe("/api/kpis");
		expect(daemon.calls[0].body).toEqual({ key: "weekly active users", value: "weekly active users" });
	});

	it("honeycomb_kpi_add no longer publishes the dead `goalId` arg (no daemon-side field)", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 201, body: { ok: true } });
		const registry = createMcpToolRegistry({ daemon, actor: ACTOR });
		registerHoneycombSurface(registry);
		// The keyed body has no goal-linkage field, so `goalId` is now rejected by the
		// strict schema (unknown arg) rather than published-and-dropped (the M-10 pattern).
		const out = await registry.invoke("honeycomb_kpi_add", { kpi: "k", goalId: "g-1" });
		expect(out.isError).toBe(true);
		expect(daemon.calls.length).toBe(0);
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
		// PRD-022d: memory_search now reaches the WIRED recall endpoint, not the /search scaffold.
		expect(daemon.calls[0].path).toBe("/api/memories/recall");
	});
});

describe("S-1: memory_get / memory_list hit the WIRED PRD-022a read routes", () => {
	it("S-1 memory_get issues GET /api/memories/<id> (id URL-encoded on the PATH), not /api/memories/get?path=", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: { memory: { id: "m/1 a", content: "hi" } } });
		const out = (await HANDLERS.memory_get({ path: "m/1 a" }, ACTOR, daemon)) as { memory?: unknown };
		expect(daemon.calls.length).toBe(1);
		expect(daemon.calls[0].method).toBe("GET");
		// The id rides the PATH segment, URL-encoded (slash + space escaped) — NOT a `?path=` query.
		expect(daemon.calls[0].path).toBe("/api/memories/m%2F1%20a");
		expect(daemon.calls[0].path).not.toContain("/get?");
		expect(daemon.calls[0].path).not.toContain("?path=");
		// The wired route returns `{memory}`; the handler passes that shape straight through.
		expect(out.memory).toEqual({ id: "m/1 a", content: "hi" });
	});

	it("S-1 memory_get with no id hits the bare /api/memories/ route (empty encoded segment)", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 404, body: { error: "not_found" } });
		await HANDLERS.memory_get({}, ACTOR, daemon).catch(() => undefined);
		expect(daemon.calls.length).toBe(1);
		expect(daemon.calls[0].path).toBe("/api/memories/");
	});

	it("S-1 memory_list issues GET /api/memories (no ?prefix=) and returns {memories:[...]}", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: { memories: [{ id: "a" }, { id: "b" }] } });
		const out = (await HANDLERS.memory_list({}, ACTOR, daemon)) as { memories?: unknown[] };
		expect(daemon.calls.length).toBe(1);
		expect(daemon.calls[0].method).toBe("GET");
		// The WIRED list route is `/api/memories` (+ optional `?limit=`); it has NO prefix filter.
		expect(daemon.calls[0].path).toBe("/api/memories");
		expect(daemon.calls[0].path).not.toContain("/list");
		expect(daemon.calls[0].path).not.toContain("prefix=");
		expect(out.memories).toEqual([{ id: "a" }, { id: "b" }]);
	});

	it("M-10 memory_list no longer publishes a `prefix` arg (the route has no prefix filter)", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: {} });
		const registry = createMcpToolRegistry({ daemon, actor: ACTOR });
		registerHoneycombSurface(registry);
		// A caller passing `prefix` is now REJECTED by the strict schema (unknown arg) instead
		// of silently accepted-and-ignored.
		const out = await registry.invoke("memory_list", { prefix: "anything" });
		expect(out.isError).toBe(true);
		expect(daemon.calls.length).toBe(0);
	});

	it("S-1 memory_list with a numeric limit issues GET /api/memories?limit=<n>", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: { memories: [] } });
		await HANDLERS.memory_list({ limit: 5 }, ACTOR, daemon);
		expect(daemon.calls.length).toBe(1);
		expect(daemon.calls[0].path).toBe("/api/memories?limit=5");
	});

	it("S-1 the production seam stamps the session-group headers for memory_get's GET /api/memories/<id>", async () => {
		const { createHttpDaemonApiSeam, RUNTIME_PATH_HEADER, SESSION_HEADER } = await import(
			"../../mcp/src/daemon-seam.js"
		);
		let seenUrl = "";
		let seen: Record<string, string> = {};
		const seam = createHttpDaemonApiSeam({
			fetch: async (url, init) => {
				seenUrl = url;
				seen = init.headers;
				return {
					status: 200,
					async json() {
						return { memory: {} };
					},
					async text() {
						return "";
					},
				};
			},
		});
		await seam.call({ method: "GET", path: "/api/memories/m%2F1", actor: ACTOR });
		expect(seenUrl).toContain("/api/memories/m%2F1");
		// /api/memories/:id is a SESSION group → runtime-path + session header both stamp (no 400).
		expect(seen[RUNTIME_PATH_HEADER]).toBe("plugin");
		expect(seen[SESSION_HEADER], "GET /api/memories/<id> must stamp x-honeycomb-session").toBeDefined();
	});

	it("S-1 the production seam stamps the session-group headers for memory_list's GET /api/memories", async () => {
		const { createHttpDaemonApiSeam, RUNTIME_PATH_HEADER, SESSION_HEADER } = await import(
			"../../mcp/src/daemon-seam.js"
		);
		let seen: Record<string, string> = {};
		const seam = createHttpDaemonApiSeam({
			fetch: async (_url, init) => {
				seen = init.headers;
				return {
					status: 200,
					async json() {
						return { memories: [] };
					},
					async text() {
						return "";
					},
				};
			},
		});
		await seam.call({ method: "GET", path: "/api/memories?limit=5", actor: ACTOR });
		expect(seen[RUNTIME_PATH_HEADER]).toBe("plugin");
		expect(seen[SESSION_HEADER], "GET /api/memories?limit= must stamp x-honeycomb-session").toBeDefined();
	});
});

/** Minimal valid args for a tool, derived from its name (covers required fields). */
function minimalArgs(name: string): Record<string, unknown> {
	switch (name) {
		case "memory_search":
		case "honeycomb_search":
		case "honeycomb_code_search":
			return { query: "q" };
		case "memory_store":
			return { text: "t" };
		case "memory_get":
		case "memory_list":
		case "honeycomb_read":
		case "honeycomb_index":
			return { path: "/p" };
		case "honeycomb_goal_add":
			return { goal: "g" };
		case "honeycomb_kpi_add":
			return { kpi: "k" };
		case "honeycomb_code_context":
		case "honeycomb_code_blast":
		case "honeycomb_code_impact":
			return { symbol: "sym" };
		case "secret_list":
			return {};
		case "secret_exec":
			return { command: "echo hi" };
		// PRD-046e pull path
		case "hivemind_read":
			return { ref: "/p" };
		case "hivemind_search":
			return { query: "q" };
		default:
			return {};
	}
}

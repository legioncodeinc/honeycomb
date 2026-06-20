/**
 * PRD-021e MCP transport bind — e-AC-1 / e-AC-2 / e-AC-3 / e-AC-5.
 *
 * 019d constructed the server behind seams but NEVER connected a transport, so no
 * client could complete a handshake. 021e adds {@link startMcpServer} + the live
 * `connect()`, which flips "imports clean" → "actually serves". These tests prove a
 * REAL MCP client (the SDK's in-memory transport AND the served streamable-HTTP
 * endpoint) completes a real `initialize` handshake against the SAME server the
 * registry populated, receives the unified `honeycomb_` tool list, and that a tool
 * call routes through the injected {@link DaemonApiSeam} (never DeepLake).
 *
 * No socket-less skip here: the in-memory pair and the loopback `/mcp` server are
 * deterministic and bounded, so this runs in the default `npm run test` suite.
 */

import { afterEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
	type Actor,
	type BoundTransport,
	bindAllTransports,
	connectAllTransports,
	createFakeDaemonApiSeam,
	createMcpServer,
	type FakeDaemonApiSeam,
	startMcpServer,
	type TransportBinder,
	type TransportKind,
	TOOL_NAMES,
} from "../../mcp/src/index.js";

const ACTOR: Actor = { actor: "agent-1", actorType: "agent" };

/** A binder that records each bind + each `connect()` without owning a real socket/stdio. */
function createRecordingBinder(): {
	binder: TransportBinder;
	bound: BoundTransport[];
	connected: TransportKind[];
} {
	const bound: BoundTransport[] = [];
	const connected: TransportKind[] = [];
	const binder: TransportBinder = {
		bind(kind, server) {
			const bt: BoundTransport = {
				kind,
				server,
				async connect(): Promise<void> {
					connected.push(kind);
				},
			};
			bound.push(bt);
			return bt;
		},
	};
	return { binder, bound, connected };
}

describe("e-AC-1: bindAllTransports connects BOTH transports to the same McpServer", () => {
	it("e-AC-1 connectAllTransports connects http + stdio against the one shared server", async () => {
		const daemon = createFakeDaemonApiSeam();
		const handle = createMcpServer({ daemon, actor: ACTOR });
		const { binder, connected } = createRecordingBinder();

		// Re-bind against the handle's server through the recording binder so we can assert
		// the live connect() fires for BOTH kinds against the SAME server (e-AC-1).
		const transports = bindAllTransports(handle.server, binder);
		expect(transports.http.server).toBe(transports.stdio.server);
		expect(transports.http.server).toBe(handle.server);

		await connectAllTransports(transports);
		expect(connected.sort()).toEqual(["http", "stdio"]);
	});
});

describe("e-AC-2: a real in-process client gets a real initialize + the honeycomb_ tool list", () => {
	it("e-AC-2 the constructed server answers initialize over the SDK in-memory transport", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: { hits: [] } });
		const handle = createMcpServer({ daemon, actor: ACTOR });

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		// Connect the SAME registry-populated server to the server end of the pair — the
		// live bind 019d deferred, now exercised with a real client driving the handshake.
		await handle.server.connect(serverTransport);

		const client = new Client({ name: "test-harness", version: "0.0.0" });
		try {
			await client.connect(clientTransport);

			// A REAL initialize response: the server negotiated its identity + capabilities.
			const serverInfo = client.getServerVersion();
			expect(serverInfo?.name).toBe("honeycomb");
			expect(client.getServerCapabilities()?.tools).toBeDefined();

			// The unified honeycomb_ surface is listed (the non-conditional tools — the
			// codebase cluster is gated off because graphBuilt defaults to false).
			const { tools } = await client.listTools();
			const listed = tools.map((t) => t.name).sort();
			expect(listed).toEqual([...handle.toolNames].sort());
			expect(listed).toContain("memory_search");
			expect(listed).toContain("honeycomb_search");
			// Sanity: every listed tool is part of the 019d contract surface (e-AC-5).
			for (const name of listed) expect(TOOL_NAMES).toContain(name);
		} finally {
			await client.close();
		}
	});

	it("e-AC-3 a tool call over the live transport routes through the DaemonApiSeam (no DeepLake)", async () => {
		const daemon: FakeDaemonApiSeam = createFakeDaemonApiSeam({ status: 200, body: { hits: [] } });
		const handle = createMcpServer({ daemon, actor: ACTOR });

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await handle.server.connect(serverTransport);
		const client = new Client({ name: "test-harness", version: "0.0.0" });
		try {
			await client.connect(clientTransport);
			await client.callTool({ name: "memory_search", arguments: { query: "hello" } });

			// The handler routed through the injected seam, stamping the plugin-path actor —
			// the only path out (no DeepLake import anywhere in mcp/, invariant.test.ts).
			expect(daemon.calls.length).toBe(1);
			expect(daemon.calls[0].path).toBe("/api/memories/search");
			expect(daemon.calls[0].actor).toEqual(ACTOR);
		} finally {
			await client.close();
		}
	});
});

describe("e-AC-2/e-AC-6: startMcpServer SERVES streamable-HTTP at /mcp and answers a real initialize", () => {
	let running: Awaited<ReturnType<typeof startMcpServer>> | null = null;

	afterEach(async () => {
		if (running !== null) await running.close();
		running = null;
	});

	/** POST one JSON-RPC message to the served /mcp endpoint and parse the response. */
	async function rpc(url: string, message: unknown): Promise<{ status: number; body: unknown }> {
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify(message),
		});
		const text = await res.text();
		// enableJsonResponse → plain JSON; tolerate an SSE-framed body just in case.
		const jsonText = text.startsWith("event:") ? (text.split("data:")[1] ?? "").trim() : text;
		let body: unknown;
		try {
			body = JSON.parse(jsonText);
		} catch {
			body = undefined;
		}
		return { status: res.status, body };
	}

	it("e-AC-2/e-AC-6 the served /mcp endpoint answers a real initialize over loopback", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: { hits: [] } });
		// serveHttp on an ephemeral loopback port — bounded + deterministic, no fixed 3850.
		running = await startMcpServer({ daemon, actor: ACTOR, serveHttp: true, httpPort: 0 });
		expect(running.http).toBeDefined();
		expect(running.http?.host).toBe("127.0.0.1");

		const url = `http://127.0.0.1:${running.http?.port}/mcp`;
		const { status, body } = await rpc(url, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "served-harness", version: "0.0.0" },
			},
		});

		// A REAL initialize response: the served endpoint negotiated identity + tool capability.
		expect(status).toBe(200);
		const result = (body as { result?: { serverInfo?: { name?: string }; capabilities?: { tools?: unknown } } })
			.result;
		expect(result?.serverInfo?.name).toBe("honeycomb");
		expect(result?.capabilities?.tools).toBeDefined();
	});
});

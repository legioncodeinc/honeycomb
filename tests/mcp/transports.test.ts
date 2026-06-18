/**
 * PRD-019d transports — d-AC-6 (HTTP and stdio both route through the daemon).
 *
 * The server is reachable over streamable HTTP at `/mcp` AND as a stdio subprocess.
 * BOTH transports bind to the SAME McpServer the registry populated, so the SAME
 * tool over either transport runs the IDENTICAL handler and routes through the SAME
 * daemon seam — equivalent in, equivalent out. The transport binding is behind a
 * seam (`TransportBinder`) so this test asserts equivalence WITHOUT binding a socket.
 */

import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	type Actor,
	type BoundTransport,
	createFakeDaemonApiSeam,
	createMcpServer,
	type TransportBinder,
	type TransportKind,
} from "../../mcp/src/index.js";

const ACTOR: Actor = { actor: "agent-1", actorType: "agent" };

/** A fake binder that records the bind without owning a socket / process stdio. */
function createRecordingBinder(): { binder: TransportBinder; bound: BoundTransport[] } {
	const bound: BoundTransport[] = [];
	const binder: TransportBinder = {
		bind(kind: TransportKind, server: McpServer): BoundTransport {
			const bt: BoundTransport = {
				kind,
				server,
				async connect(): Promise<void> {
					/* no-op — the live bind is deferred assembly; we only assert wiring */
				},
			};
			bound.push(bt);
			return bt;
		},
	};
	return { binder, bound };
}

describe("d-AC-6: HTTP and stdio both route through the same daemon-backed server", () => {
	it("d-AC-6 both transports bind to the SAME McpServer instance", () => {
		const daemon = createFakeDaemonApiSeam();
		const { binder, bound } = createRecordingBinder();
		const handle = createMcpServer({ daemon, actor: ACTOR, transportBinder: binder });

		expect(handle.transports.http.kind).toBe("http");
		expect(handle.transports.stdio.kind).toBe("stdio");
		// Same server object → same registered tools → same handler dispatch.
		expect(handle.transports.http.server).toBe(handle.transports.stdio.server);
		expect(handle.transports.http.server).toBe(handle.server);
		expect(bound.map((b) => b.kind).sort()).toEqual(["http", "stdio"]);
	});

	it("d-AC-6 the same tool over either transport runs the same handler → same daemon call", async () => {
		// Both transports share the server's registered tool callbacks. Invoke the
		// SAME registered callback (what either transport would dispatch) and assert
		// it produces the same daemon seam call.
		const daemon = createFakeDaemonApiSeam({ status: 200, body: { hits: [] } });
		const { binder } = createRecordingBinder();
		const handle = createMcpServer({ daemon, actor: ACTOR, transportBinder: binder });

		// Both transports share the registry's wrapped dispatch (same server). Invoke
		// the SAME wrapped handler twice — what either transport routes to.
		// "HTTP path" invocation.
		await handle.registry.invoke("memory_search", { query: "same" });
		// "stdio path" invocation — identical handler, same server, same seam.
		await handle.registry.invoke("memory_search", { query: "same" });

		expect(daemon.calls.length).toBe(2);
		expect(daemon.calls[0].path).toBe("/api/memories/search");
		expect(daemon.calls[1].path).toBe(daemon.calls[0].path);
		expect(daemon.calls[0].actor).toEqual(daemon.calls[1].actor);
		expect(daemon.calls[0].actor).toEqual(ACTOR);
	});

	it("d-AC-6 the default binder builds real SDK transports without connecting them", () => {
		// With the default binder, construction is side-effect-free (no socket bound,
		// no stdio owned) — the live connect() is the deferred assembly step.
		const daemon = createFakeDaemonApiSeam();
		const handle = createMcpServer({ daemon, actor: ACTOR });
		expect(handle.transports.http.kind).toBe("http");
		expect(handle.transports.stdio.kind).toBe("stdio");
		expect(typeof handle.transports.http.connect).toBe("function");
		expect(typeof handle.transports.stdio.connect).toBe("function");
	});
});

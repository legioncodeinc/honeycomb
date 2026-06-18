/**
 * MCP transports behind a seam — PRD-019d FR-1 / d-AC-6.
 *
 * ── THE TWO TRANSPORTS, ONE HANDLER PATH (d-AC-6) ───────────────────────────
 * The server is reachable over streamable HTTP at `/mcp` AND as a stdio subprocess.
 * BOTH bind to the SAME {@link McpServer} the registry populated, so the SAME tool
 * invoked over either transport runs the IDENTICAL wrapped handler and routes
 * through the SAME {@link DaemonApiSeam} (FR-2). Equivalent in, equivalent out.
 *
 * ── A SEAM SO TESTS DON'T BIND A SOCKET ─────────────────────────────────────
 * Actually binding a TCP socket or owning the process stdio is the DEFERRED
 * assembly step (matches the 001–018 posture: constructed-and-tested behind seams,
 * the live binding wired at deploy). The {@link TransportBinder} seam lets a test
 * drive the HTTP path and the stdio path against a fake binder and assert both
 * resolved to the same `McpServer` + the same handler dispatch — WITHOUT opening a
 * port. The default binder builds the real SDK transports but does not auto-start
 * them; `createMcpServer`'s caller (the daemon, at assembly) connects them.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** The two transport kinds the MCP server is reachable on (FR-1 / d-AC-6). */
export type TransportKind = "http" | "stdio";

/**
 * A bound transport: the kind + the server it routes to. The same `server` instance
 * is shared across both kinds, which is what makes HTTP and stdio equivalent (d-AC-6).
 */
export interface BoundTransport {
	readonly kind: TransportKind;
	readonly server: McpServer;
	/** Connect the SDK transport to the server (the live bind — deferred at assembly). */
	connect(): Promise<void>;
}

/**
 * The transport-binding seam (d-AC-6). Builds a {@link BoundTransport} for a kind
 * against a given {@link McpServer}. The default impl builds the real SDK transport;
 * a test supplies a fake that records the bind without owning a socket/stdio.
 */
export interface TransportBinder {
	bind(kind: TransportKind, server: McpServer): BoundTransport;
}

/**
 * The default {@link TransportBinder}: builds the real SDK transports.
 *
 * - `http` → {@link StreamableHTTPServerTransport} (the `/mcp` streamable-HTTP
 *   endpoint; stateless `sessionIdGenerator: undefined` so it composes with the
 *   daemon's own session header rather than minting its own).
 * - `stdio` → {@link StdioServerTransport} (the subprocess transport).
 *
 * `connect()` attaches the transport to the shared server. It is NOT called here —
 * the daemon assembly calls it once it owns the HTTP request stream / the process
 * stdio (the deferred live bind). Construction is side-effect-free.
 */
export function createDefaultTransportBinder(): TransportBinder {
	return {
		bind(kind: TransportKind, server: McpServer): BoundTransport {
			const transport =
				kind === "http"
					? new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
					: new StdioServerTransport();
			return {
				kind,
				server,
				async connect(): Promise<void> {
					await server.connect(transport);
				},
			};
		},
	};
}

/**
 * Bind BOTH transports to the same server (FR-1 / d-AC-6). Returns the HTTP and
 * stdio {@link BoundTransport}s, both routing to the SAME `server` — so the same
 * tool over either transport runs the same handler. Neither is connected here; the
 * caller connects them at assembly (or a test asserts equivalence without connecting).
 */
export function bindAllTransports(
	server: McpServer,
	binder: TransportBinder = createDefaultTransportBinder(),
): { readonly http: BoundTransport; readonly stdio: BoundTransport } {
	return {
		http: binder.bind("http", server),
		stdio: binder.bind("stdio", server),
	};
}

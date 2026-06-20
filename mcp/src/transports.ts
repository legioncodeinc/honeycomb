/**
 * MCP transports behind a seam — PRD-019d FR-1 / d-AC-6, BOUND LIVE by PRD-021e.
 *
 * ── THE TWO TRANSPORTS, ONE HANDLER PATH (d-AC-6) ───────────────────────────
 * The server is reachable over streamable HTTP at `/mcp` AND as a stdio subprocess.
 * BOTH bind to the SAME {@link McpServer} the registry populated, so the SAME tool
 * invoked over either transport runs the IDENTICAL wrapped handler and routes
 * through the SAME {@link DaemonApiSeam} (FR-2). Equivalent in, equivalent out.
 *
 * ── A SEAM SO TESTS DON'T BIND A SOCKET (019d), NOW ALSO CONNECTED (021e) ────
 * `bindAllTransports` + the {@link TransportBinder} seam stay exactly as 019d
 * shipped them: they BUILD the transports without owning a socket, so a unit test
 * drives the HTTP path and the stdio path against a fake binder and asserts both
 * resolved to the same `McpServer` WITHOUT opening a port. What 021e adds is the
 * CALLER that flips serve-versus-import: `connect()` on each bound transport, plus
 * {@link startMcpServer} — the entry the bundle invokes so `mcp/bundle/server.js`,
 * when run, ACTUALLY answers a real `initialize` handshake (e-AC-1 / e-AC-2).
 *
 * ── e-AC-1: WHAT "BIND THE TRANSPORTS" MEANS HERE ───────────────────────────
 * - stdio: `connect()` attaches the {@link StdioServerTransport} to the server. The
 *   process's own stdin/stdout becomes the JSON-RPC channel — this is the path a
 *   harness uses when it spawns `node mcp/bundle/server.js`.
 * - HTTP: `connect()` attaches the {@link StreamableHTTPServerTransport} to the
 *   server, and {@link serveStreamableHttp} stands up a loopback `node:http` server
 *   that routes `/mcp` requests into `transport.handleRequest(...)`. The transport is
 *   stateless (`sessionIdGenerator: undefined`) so it composes with the daemon's own
 *   session header rather than minting its own.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { DAEMON_HOST } from "../../src/shared/constants.js";

/** The two transport kinds the MCP server is reachable on (FR-1 / d-AC-6). */
export type TransportKind = "http" | "stdio";

/**
 * A bound transport: the kind + the server it routes to. The same `server` instance
 * is shared across both kinds, which is what makes HTTP and stdio equivalent (d-AC-6).
 *
 * `connect()` is the LIVE bind (021e): it attaches the underlying SDK transport to the
 * shared server, so from that point the server answers JSON-RPC over that transport.
 * For the HTTP kind, the default binder also exposes {@link handleHttpRequest} so a
 * `node:http` server (see {@link serveStreamableHttp}) can route `/mcp` requests into
 * the connected streamable-HTTP transport.
 */
export interface BoundTransport {
	readonly kind: TransportKind;
	readonly server: McpServer;
	/** Connect the SDK transport to the server (the live bind — 021e e-AC-1). */
	connect(): Promise<void>;
	/**
	 * Route one Node HTTP request into the connected streamable-HTTP transport. Present
	 * ONLY on the `http` kind from the default binder; `undefined` for stdio and for the
	 * fake binders a unit test supplies (which never serve real HTTP).
	 */
	handleHttpRequest?(req: IncomingMessage, res: ServerResponse, body?: unknown): Promise<void>;
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
 *   daemon's own session header rather than minting its own). The bound transport
 *   exposes {@link BoundTransport.handleHttpRequest} so the HTTP server can route
 *   `/mcp` requests into it.
 * - `stdio` → {@link StdioServerTransport} (the subprocess transport).
 *
 * `connect()` attaches the transport to the shared server. 019d did NOT call it at
 * construction; 021e's {@link startMcpServer} / {@link connectAllTransports} call it
 * so the bundle actually serves. Construction itself stays side-effect-free.
 */
export function createDefaultTransportBinder(): TransportBinder {
	return {
		bind(kind: TransportKind, server: McpServer): BoundTransport {
			if (kind === "http") {
				// Stateless (`sessionIdGenerator: undefined`) so it composes with the daemon's
				// own session header rather than minting its own. `enableJsonResponse` returns a
				// plain JSON body per request instead of an SSE stream — the right fit for a
				// loopback request/response server and the simplest thing a client negotiates.
				const transport = new StreamableHTTPServerTransport({
					sessionIdGenerator: undefined,
					enableJsonResponse: true,
				});
				return {
					kind,
					server,
					async connect(): Promise<void> {
						await server.connect(transport);
					},
					async handleHttpRequest(req: IncomingMessage, res: ServerResponse, body?: unknown): Promise<void> {
						await transport.handleRequest(req, res, body);
					},
				};
			}
			const transport = new StdioServerTransport();
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
 * caller connects them ({@link connectAllTransports} / {@link startMcpServer}) or a
 * test asserts equivalence without connecting.
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

/** Both bound transports, as {@link bindAllTransports} returns them. */
export interface BoundTransports {
	readonly http: BoundTransport;
	readonly stdio: BoundTransport;
}

/**
 * Connect BOTH bound transports (e-AC-1). A convenience helper for a binder whose
 * transports tolerate sharing one server — e.g. the recording binder a unit test
 * supplies, which records the bind without enforcing the SDK's protocol rule.
 *
 * NOTE — the real SDK allows ONE transport per `McpServer` (`server.connect` throws
 * "Already connected to a transport" on a second call). So the PRODUCTION start path
 * ({@link startMcpServer}) does NOT use this against two REAL transports on one server;
 * it connects stdio to the primary server and stands up a SECOND server (identical
 * surface) for the served HTTP transport. This helper stays for the seam-level test
 * that asserts both binds fire against the shared server object without connecting a
 * real protocol.
 */
export async function connectAllTransports(transports: BoundTransports): Promise<void> {
	// stdio first: it owns the process's own stdin/stdout, the path a harness uses when
	// it spawns the bundle. HTTP second.
	await transports.stdio.connect();
	await transports.http.connect();
}

/** A live streamable-HTTP server: the bound port + a graceful close. */
export interface ServedHttp {
	/** The loopback host the `/mcp` endpoint is served on (always 127.0.0.1). */
	readonly host: string;
	/** The bound port (the OS-picked port when 0 was requested). */
	readonly port: number;
	/** Close the HTTP socket. */
	close(): Promise<void>;
}

/** Options for {@link serveStreamableHttp}. */
export interface ServeStreamableHttpOptions {
	/** The loopback port to bind the `/mcp` endpoint on (default 0 = OS-picked). */
	readonly port?: number;
	/** The path the streamable-HTTP transport answers on (default `/mcp`). */
	readonly path?: string;
}

/** Read and JSON-parse a request body; returns `undefined` for an empty body. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	if (chunks.length === 0) return undefined;
	const raw = Buffer.concat(chunks).toString("utf-8");
	if (raw.length === 0) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

/**
 * Stand up a loopback `node:http` server that SERVES the connected streamable-HTTP
 * transport at `/mcp` (e-AC-1 / FR-1). Binds ONLY to 127.0.0.1 — the MCP endpoint is
 * never exposed on a public interface (it routes through the daemon's own loopback,
 * the same posture the daemon-API seam uses). Any path other than the configured one
 * gets a 404. The HTTP transport must already be `connect()`ed to its server.
 */
export async function serveStreamableHttp(
	http: BoundTransport,
	opts: ServeStreamableHttpOptions = {},
): Promise<ServedHttp> {
	if (http.kind !== "http" || http.handleHttpRequest === undefined) {
		throw new Error("PRD-021e: serveStreamableHttp requires the connected HTTP BoundTransport");
	}
	const path = opts.path ?? "/mcp";
	const handle = http.handleHttpRequest.bind(http);

	const server: Server = createServer((req: IncomingMessage, res: ServerResponse): void => {
		const url = req.url ?? "";
		const pathname = url.split("?")[0];
		if (pathname !== path) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "not found" }));
			return;
		}
		void readJsonBody(req)
			.then((body) => handle(req, res, body))
			.catch((err: unknown) => {
				const message = err instanceof Error ? err.message : "unknown error";
				if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: message }));
			});
	});

	const port = opts.port ?? 0;
	await new Promise<void>((resolve, reject) => {
		const onError = (err: Error): void => reject(err);
		server.once("error", onError);
		server.listen(port, DAEMON_HOST, () => {
			server.removeListener("error", onError);
			resolve();
		});
	});

	const address = server.address();
	const boundPort = typeof address === "object" && address !== null ? address.port : port;

	return {
		host: DAEMON_HOST,
		port: boundPort,
		close(): Promise<void> {
			return new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
		},
	};
}

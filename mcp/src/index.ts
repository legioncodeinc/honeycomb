/**
 * MCP server entry root — PRD-001b stub evolved by PRD-019d Wave 2.
 *
 * Thin client only: reaches Honeycomb through the {@link DaemonApiSeam}, never the
 * daemon core or any DeepLake path (FR-1 / D-2). `mcp` is in `NON_DAEMON_ROOTS`
 * (`tests/daemon/storage/invariant.test.ts`). Independently addressable by the
 * bundler (PRD-001b); esbuild bundles `mcp/bundle/server.js` from here.
 *
 * Wave 2 wires the unified `honeycomb_` tool surface onto a real MCP-backed
 * {@link ToolRegistry} (`registry.ts`), routes every handler through the injected
 * {@link DaemonApiSeam} stamping `x-honeycomb-runtime-path: plugin` + actor headers
 * (FR-2 / d-AC-1), gates the codebase cluster on the workspace graph-built flag
 * (FR-7 / d-AC-4), and binds BOTH the streamable-HTTP `/mcp` transport AND the stdio
 * subprocess transport to the SAME server behind a {@link TransportBinder} seam
 * (FR-1 / d-AC-6). The live socket bind + the real daemon-API fetch over loopback
 * are the DEFERRED assembly step — constructed-and-tested behind seams here; the
 * daemon connects them at deploy. We do NOT claim a live MCP endpoint is serving.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createDaemonClient, type DaemonClient } from "../../src/daemon-client/index.js";
import { HONEYCOMB_VERSION } from "../../src/shared/constants.js";
import { type Actor, type DaemonApiSeam } from "./contracts.js";
import { createHttpDaemonApiSeam } from "./daemon-seam.js";
import { createMcpToolRegistry, type McpToolRegistry, registerHoneycombSurface } from "./registry.js";
import {
	type BoundTransport,
	bindAllTransports,
	connectAllTransports,
	createDefaultTransportBinder,
	type ServedHttp,
	serveStreamableHttp,
	type TransportBinder,
} from "./transports.js";
import { CONDITIONAL_TOOL_NAMES, TOOL_NAMES, TOOL_SPECS } from "./tools.js";

/** The default actor when none is injected (the plugin-path identity). */
const DEFAULT_ACTOR: Actor = { actor: "honeycomb-mcp", actorType: "plugin" };

/** Options for {@link createMcpServer}. */
export interface CreateMcpServerOptions {
	/** The daemon-API seam (default: the loopback HTTP seam). Injected for tests. */
	readonly daemon?: DaemonApiSeam;
	/** The actor stamped on every handler's daemon call (default: the plugin identity). */
	readonly actor?: Actor;
	/** Whether the workspace codebase graph is built — gates the codebase cluster (d-AC-4). */
	readonly graphBuilt?: boolean;
	/** The transport binder (default: the real SDK binder). Injected so tests skip the socket. */
	readonly transportBinder?: TransportBinder;
}

/** The constructed MCP server handle (Wave 2). */
export interface McpServerHandle {
	version: string;
	client: DaemonClient;
	/** The MCP-backed tool registry (the SDK server is `registry.server`). */
	registry: McpToolRegistry;
	/** The backing SDK server both transports connect to (d-AC-6). */
	server: McpServer;
	/** The full unified `honeycomb_` tool surface (names + arg schemas + clusters). */
	tools: typeof TOOL_SPECS;
	/** The tool names actually REGISTERED (codebase present only when graphBuilt). */
	toolNames: readonly string[];
	/** The HTTP + stdio transports, both bound to `server` (d-AC-6). Not yet connected. */
	transports: { readonly http: BoundTransport; readonly stdio: BoundTransport };
}

/**
 * Construct the MCP server: build the registry over the injected daemon seam +
 * actor, register the unified surface (codebase gated on `graphBuilt`), and bind
 * both transports to the SAME server. No transport is connected here — the daemon
 * assembly connects them once it owns the HTTP stream / process stdio (deferred).
 *
 * Backward-compatible: a bare {@link DaemonApiSeam} may still be passed positionally
 * (the Wave-1 signature), or an options object for the full Wave-2 surface.
 */
export function createMcpServer(daemonOrOpts?: DaemonApiSeam | CreateMcpServerOptions): McpServerHandle {
	const opts: CreateMcpServerOptions = isDaemonSeam(daemonOrOpts) ? { daemon: daemonOrOpts } : (daemonOrOpts ?? {});

	const daemon: DaemonApiSeam = opts.daemon ?? createHttpDaemonApiSeam();
	const actor: Actor = opts.actor ?? DEFAULT_ACTOR;
	const graphBuilt = opts.graphBuilt ?? false;

	const registry = createMcpToolRegistry({ daemon, actor, graphBuilt });
	registerHoneycombSurface(registry, { graphBuilt });

	const binder = opts.transportBinder ?? createDefaultTransportBinder();
	const transports = bindAllTransports(registry.server, binder);

	return {
		version: HONEYCOMB_VERSION,
		client: createDaemonClient(),
		registry,
		server: registry.server,
		tools: TOOL_SPECS,
		toolNames: registry.registered,
		transports,
	};
}

/** True when the argument is a bare {@link DaemonApiSeam} (the Wave-1 positional form). */
function isDaemonSeam(v: DaemonApiSeam | CreateMcpServerOptions | undefined): v is DaemonApiSeam {
	return v !== undefined && typeof (v as DaemonApiSeam).call === "function";
}

/** Options for {@link startMcpServer}. Extends {@link CreateMcpServerOptions}. */
export interface StartMcpServerOptions extends CreateMcpServerOptions {
	/**
	 * Whether to ALSO serve the streamable-HTTP `/mcp` endpoint (default `false`). The
	 * common case — a harness spawning `node mcp/bundle/server.js` — wants stdio ONLY,
	 * so HTTP serving is opt-in (the daemon owns the HTTP `/mcp` request stream in the
	 * in-process case). When `true`, a loopback `node:http` server is stood up.
	 */
	readonly serveHttp?: boolean;
	/** The loopback port for the `/mcp` endpoint when `serveHttp` is true (default 0). */
	readonly httpPort?: number;
}

/** A running MCP server: the constructed handle + the live transports + a graceful close. */
export interface RunningMcpServer {
	/** The constructed server handle (registry, tools, both bound transports). */
	readonly handle: McpServerHandle;
	/** The served streamable-HTTP endpoint, when `serveHttp` was requested. */
	readonly http?: ServedHttp;
	/** Stop serving: close the HTTP socket (if any). The process owns the stdio channel. */
	close(): Promise<void>;
}

/**
 * START the MCP server (PRD-021e e-AC-1 / e-AC-2). This is the call 019d defined but
 * never made: it constructs the server via {@link createMcpServer}, then CONNECTS a
 * transport so the server answers a REAL `initialize` handshake and returns the unified
 * `honeycomb_` tool list. The bundle entry invokes this (see the main-entry guard at the
 * foot of this module), which is what flips `mcp/bundle/server.js` from "imports clean"
 * to "actually serves".
 *
 * ── ONE McpServer ↔ ONE TRANSPORT (the SDK rule) ────────────────────────────
 * The MCP SDK's `Protocol` allows ONE transport per server (`server.connect` throws
 * "Already connected to a transport" on a second call). 019d's `bindAllTransports`
 * binds BOTH transports to one server as a CONSTRUCTION-equivalence seam (same registry
 * → same handlers → same daemon routing — tested without ever connecting). The LIVE
 * bind must honor the SDK rule, so:
 *   - stdio connects to the PRIMARY handle's server (the path a harness uses when it
 *     spawns the bundle), and
 *   - when `serveHttp` is requested, a SECOND independent server is constructed over the
 *     SAME daemon seam + actor + graph flag (identical tool surface — equivalent in,
 *     equivalent out, e-AC-5/d-AC-6) and ITS streamable-HTTP transport is connected +
 *     served at `/mcp`.
 * Both servers register the byte-for-byte same `honeycomb_` contract; the split is a
 * transport-ownership detail, not a contract change.
 */
export async function startMcpServer(opts: StartMcpServerOptions = {}): Promise<RunningMcpServer> {
	const handle = createMcpServer(opts);

	// e-AC-1: connect the stdio transport to the primary server (the live bind 019d deferred).
	await handle.transports.stdio.connect();

	let http: ServedHttp | undefined;
	let httpHandle: McpServerHandle | undefined;
	if (opts.serveHttp === true) {
		// Independent server (SDK one-transport-per-server rule) with the IDENTICAL surface.
		httpHandle = createMcpServer(opts);
		await httpHandle.transports.http.connect();
		http = await serveStreamableHttp(httpHandle.transports.http, { port: opts.httpPort });
	}

	let closed = false;
	return {
		handle,
		http,
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			if (http !== undefined) await http.close();
		},
	};
}

/**
 * Whether this module is being executed directly as the MCP-server entry (the bundled
 * `mcp/bundle/server.js`), as opposed to imported by a test or another module. Only the
 * direct-execution path auto-starts the server; importing the module never owns stdio.
 * Mirrors the daemon's `isMainEntry` posture (`src/daemon/index.ts`).
 */
function isMainEntry(): boolean {
	const entry = process.argv[1];
	if (typeof entry !== "string" || entry.length === 0) return false;
	try {
		return import.meta.url === new URL(`file://${entry}`).href || import.meta.url.endsWith("/server.js");
	} catch {
		return false;
	}
}

// Production auto-start: ONLY when run as the main entry (the bundled MCP binary), never
// on import (a test imports `startMcpServer`/`createMcpServer` without owning stdio). The
// bundle answers `initialize` over stdio — the path a harness uses when it spawns it.
if (isMainEntry()) {
	startMcpServer().catch((err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[honeycomb] mcp server failed to start: ${message}\n`);
		process.exitCode = 1;
	});
}

export { CONDITIONAL_TOOL_NAMES, TOOL_NAMES };

export {
	type Actor,
	createFakeDaemonApiSeam,
	createToolRegistry,
	type DaemonApiSeam,
	type DaemonApiRequest,
	type DaemonApiResponse,
	errorResult,
	type FakeDaemonApiSeam,
	notImplemented,
	type ToolArgSchema,
	type ToolCluster,
	TOOL_CLUSTERS,
	type ToolErrorResult,
	type ToolHandler,
	type ToolRegistry,
} from "./contracts.js";

export {
	REASON_REQUIRED_TOOLS,
	SECRETS_TOOLS,
	type ToolSpec,
	TOOL_SPECS,
} from "./tools.js";

export {
	createMcpToolRegistry,
	type McpToolRegistry,
	registerHoneycombSurface,
	type ToolRegistryDeps,
	type WrappedHandler,
} from "./registry.js";

export {
	createHttpDaemonApiSeam,
	type FetchLike,
	type HttpDaemonApiSeamOptions,
	ACTOR_HEADER,
	ACTOR_TYPE_HEADER,
	MCP_RUNTIME_PATH,
	RUNTIME_PATH_HEADER,
	stampHeaders,
} from "./daemon-seam.js";

export {
	bindAllTransports,
	type BoundTransport,
	type BoundTransports,
	connectAllTransports,
	createDefaultTransportBinder,
	type ServedHttp,
	type ServeStreamableHttpOptions,
	serveStreamableHttp,
	type TransportBinder,
	type TransportKind,
} from "./transports.js";

export {
	HANDLERS,
	REDACTED,
	type SecretExecResult,
	type SecretListResult,
	toSecretExecResult,
	toSecretListResult,
} from "./handlers.js";

export { inferParentSessionKey } from "./sessions.js";

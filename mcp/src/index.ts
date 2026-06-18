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
import {
	createMcpToolRegistry,
	type McpToolRegistry,
	registerHoneycombSurface,
} from "./registry.js";
import {
	type BoundTransport,
	bindAllTransports,
	createDefaultTransportBinder,
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
	const opts: CreateMcpServerOptions = isDaemonSeam(daemonOrOpts)
		? { daemon: daemonOrOpts }
		: daemonOrOpts ?? {};

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
	createDefaultTransportBinder,
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

export { inferParentSessionKey, sessionSearch } from "./sessions.js";

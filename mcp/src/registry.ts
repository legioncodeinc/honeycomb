/**
 * The real {@link ToolRegistry} — PRD-019d Wave 2 (backs the scaffold with the MCP SDK).
 *
 * ── WHAT THIS MODULE OWNS ────────────────────────────────────────────────────
 * `createMcpToolRegistry(deps)` returns a {@link ToolRegistry} whose `registerTool`
 * (a) parses the incoming args with the STRICT `zod/v3` arg schema — rejecting any
 * unknown/extra arg BEFORE it reaches the daemon (FR-10 / d-AC-1); (b) routes the
 * validated args through the injected {@link DaemonApiSeam} + {@link Actor} (FR-2);
 * (c) registers the tool with the SDK's `McpServer.registerTool` so it appears in
 * the harness's native tool list (d-AC-1); and (d) shapes the handler's result into
 * the MCP `CallToolResult` envelope, value-safely (never echoes the raw arg payload).
 *
 * ── ONE HANDLER, BOTH TRANSPORTS (d-AC-6) ───────────────────────────────────
 * The registry binds the SAME wrapped handler regardless of transport. The HTTP
 * and stdio paths both connect a transport to the SAME `McpServer` this registry
 * populated, so a tool invoked over either transport runs the identical handler and
 * returns equivalent results (transports.ts asserts this).
 *
 * ── STRICT REJECTION IS OURS, NOT THE SDK'S (FR-10) ─────────────────────────
 * We parse with the strict schema in the wrapper (not only via the SDK's own
 * validation) so the unknown-arg rejection is deterministic and independent of SDK
 * internals — the d-AC test drives the registered handler directly and asserts the
 * extra arg is rejected without any daemon call.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
	Actor,
	DaemonApiSeam,
	ToolArgSchema,
	ToolErrorResult,
	ToolHandler,
	ToolRegistry,
	z,
} from "./contracts.js";
import { errorResult } from "./contracts.js";
import { HANDLERS } from "./handlers.js";
import { CONDITIONAL_TOOL_NAMES, TOOL_SPECS, type ToolSpec } from "./tools.js";

/** Whether a tool result is the MCP error envelope (no daemon round-trip echoed). */
function isErrorResult(v: unknown): v is ToolErrorResult {
	return v !== null && typeof v === "object" && (v as { isError?: unknown }).isError === true;
}

/** The MCP `CallToolResult` shape we hand back (text content + optional error flag). */
interface CallToolResult {
	readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
	readonly isError?: boolean;
}

/** Wrap any handler return value into the MCP `CallToolResult` envelope. */
function toCallToolResult(value: unknown): CallToolResult {
	if (isErrorResult(value)) {
		return { content: [{ type: "text", text: value.message }], isError: true };
	}
	const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
	return { content: [{ type: "text", text }] };
}

/**
 * Convert a strict `zod/v3` object schema into the raw shape the SDK's
 * `registerTool` publishes (so the harness renders the correct signature). The arg
 * schemas in `tools.ts` are `z.object(shape).strict()`, so `.shape` is the field map.
 */
function rawShapeOf(schema: ToolArgSchema): Record<string, z.ZodTypeAny> {
	const s = schema as unknown as { shape?: Record<string, z.ZodTypeAny> };
	return s.shape ?? {};
}

/** Construction deps for the registry. */
export interface ToolRegistryDeps {
	/** The ONLY path out to the daemon — stamps plugin + actor headers (FR-2). */
	readonly daemon: DaemonApiSeam;
	/** The actor stamped onto every handler's daemon call (FR-2 / d-AC-1). */
	readonly actor: Actor;
	/** The MCP server the tools register on (defaults to a fresh one). */
	readonly server?: McpServer;
	/**
	 * Whether the workspace codebase graph is built (FR-7 / d-AC-4). When `false`
	 * (the default), the codebase cluster is NOT registered. `honeycomb graph build`
	 * flips this on for the workspace.
	 */
	readonly graphBuilt?: boolean;
}

/** The wrapped, strict-parsing handler the SDK calls — returns the MCP envelope. */
export type WrappedHandler = (args: unknown) => Promise<CallToolResult>;

/** A {@link ToolRegistry} that also exposes the backing {@link McpServer}. */
export interface McpToolRegistry extends ToolRegistry {
	/** The MCP server populated by `registerTool` — connected to a transport later. */
	readonly server: McpServer;
	/**
	 * Invoke a registered tool through its EXACT wrapped handler — the same dispatch
	 * the SDK runs over either transport (d-AC-6). Strict-parses args (FR-10), routes
	 * through the daemon seam (FR-2), shapes the result. Throws if `name` is unknown.
	 */
	invoke(name: string, args: unknown): Promise<CallToolResult>;
}

/**
 * Build the real MCP-backed {@link ToolRegistry}. Each `registerTool` call wraps the
 * handler so it (1) strict-parses args (FR-10), (2) routes through the daemon seam
 * (FR-2), (3) registers on the SDK server (d-AC-1), (4) shapes the result. The
 * `registered` list records names for the surface-list assertion (d-AC-1).
 */
export function createMcpToolRegistry(deps: ToolRegistryDeps): McpToolRegistry {
	const server = deps.server ?? new McpServer({ name: "honeycomb", version: "0.1.0" });
	const registered: string[] = [];
	const wrappedByName = new Map<string, WrappedHandler>();

	const registry: McpToolRegistry = {
		server,
		get registered(): readonly string[] {
			return registered;
		},
		async invoke(name: string, args: unknown): Promise<CallToolResult> {
			const wrapped = wrappedByName.get(name);
			if (wrapped === undefined) {
				throw new Error(`PRD-019d: tool ${name} is not registered`);
			}
			return wrapped(args);
		},
		registerTool(name: string, argSchema: ToolArgSchema, handler: ToolHandler): void {
			// The wrapped handler: strict-parse → route through daemon → shape result.
			const wrapped = async (args: unknown): Promise<CallToolResult> => {
				// (1) STRICT validation — unknown/extra args rejected here (FR-10 / d-AC-1).
				const parsed = (argSchema as z.ZodTypeAny).safeParse(args ?? {});
				if (!parsed.success) {
					const reason = parsed.error.issues
						.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
						.join("; ");
					return toCallToolResult(errorResult(`invalid arguments for ${name}: ${reason}`));
				}
				// (2)+(4) route through the daemon seam + shape the result.
				try {
					const result = await handler(parsed.data, deps.actor, deps.daemon);
					return toCallToolResult(result);
				} catch (err) {
					const message = err instanceof Error ? err.message : "unknown error";
					return toCallToolResult(errorResult(`${name} failed: ${message}`));
				}
			};

			// (3) publish on the SDK server so the harness lists the tool (d-AC-1).
			server.registerTool(
				name,
				{ description: `honeycomb ${name}`, inputSchema: rawShapeOf(argSchema) },
				// The SDK calls back with the parsed args object; our wrapped handler
				// re-validates strictly and dispatches. Cast is the SDK callback shape.
				(async (sdkArgs: unknown) => wrapped(sdkArgs)) as never,
			);
			wrappedByName.set(name, wrapped);
			registered.push(name);
		},
	};
	return registry;
}

/**
 * Register the unified `honeycomb_` surface onto a registry (FR-3..FR-8). The
 * codebase cluster is registered ONLY when the workspace graph is built
 * (FR-7 / d-AC-4); every other cluster is always registered. Each tool's handler
 * comes from {@link HANDLERS} keyed by name. Returns the registry for chaining.
 */
export function registerHoneycombSurface(
	registry: ToolRegistry,
	opts: { readonly graphBuilt?: boolean } = {},
): ToolRegistry {
	const graphBuilt = opts.graphBuilt ?? false;
	const conditional = new Set(CONDITIONAL_TOOL_NAMES);
	for (const spec of TOOL_SPECS) {
		// Codebase cluster is gated on the graph-built flag (d-AC-4).
		if (conditional.has(spec.name) && !graphBuilt) continue;
		const handler = handlerFor(spec);
		registry.registerTool(spec.name, spec.argSchema, handler);
	}
	return registry;
}

/** Resolve the handler for a spec, failing loud if the table is missing one. */
function handlerFor(spec: ToolSpec): ToolHandler {
	const handler = HANDLERS[spec.name];
	if (handler === undefined) {
		throw new Error(`PRD-019d: no handler registered for tool ${spec.name}`);
	}
	return handler;
}

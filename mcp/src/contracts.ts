/**
 * MCP server contracts + seams — PRD-019d Wave 1 (the unified tool surface).
 *
 * ── THE THESIS (FR-1 / FR-2 / D-2) ──────────────────────────────────────────
 *   THE MCP SERVER IS ONE MORE THIN CLIENT OF THE DAEMON. It runs inside the
 *   daemon, reachable over streamable HTTP at `/mcp` or as a stdio subprocess, and
 *   exposes the unified `honeycomb_` tool surface. Every tool handler routes through
 *   the daemon's OWN API ({@link DaemonApiSeam}), stamping
 *   `x-honeycomb-runtime-path: plugin` + actor headers (FR-2), so MCP traffic is
 *   scoped/identified/audited like any other plugin-path call. The server opens NO
 *   DeepLake (FR-1) — `mcp` is in `NON_DAEMON_ROOTS`.
 *
 * ── zod VERSION (the v4/v3 split) ───────────────────────────────────────────
 * The app uses zod ^4, but the MCP SDK (`@modelcontextprotocol/sdk`) speaks zod v3,
 * so MCP tool input schemas import from `"zod/v3"` (the compatibility subpath the
 * installed zod ^4 ships). Mixing zod majors silently breaks `inputSchema` inference,
 * so this is load-bearing. The arg-schema PLACEHOLDERS in `tools.ts` are built with
 * `zod/v3` for exactly this reason.
 *
 * ── WAVE 1 vs WAVE 2 ────────────────────────────────────────────────────────
 * Wave 1 (this scaffold) defines the {@link ToolRegistry} contract, the
 * {@link DaemonApiSeam}, the cluster grouping, and the ~25-tool NAME list with
 * arg-schema placeholders — WITHOUT importing the absent MCP SDK (no new dependency,
 * D-5-adjacent). Wave 2 (019d) backs {@link ToolRegistry} with `McpServer.registerTool`,
 * wires the HTTP + stdio transports behind the seam, and fills each handler.
 */

import { z } from "zod/v3";

// ─────────────────────────────────────────────────────────────────────────────
// notImplemented — the honest-stub thrower
// ─────────────────────────────────────────────────────────────────────────────

/** Honest-stub thrower — an early call FAILS LOUD with a stable, greppable message. */
export function notImplemented(what: string): never {
	throw new Error(`PRD-019d: not implemented — ${what}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ToolCluster — the merged surface grouping (FR-3..FR-8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The clusters the unified `honeycomb_` surface unions both source systems' tools
 * into (FR-3..FR-8). `codebase` is registered ONLY when the codebase graph is built
 * for the workspace (FR-7 / d-AC-4); `secrets` is value-safe (FR-8 / d-AC-2).
 */
export const TOOL_CLUSTERS = [
	"memory",
	"browse",
	"sessions",
	"goals-kpis",
	"agent",
	"codebase",
	"secrets",
] as const;

/** One tool cluster. */
export type ToolCluster = (typeof TOOL_CLUSTERS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// ToolArgSchema — the per-tool argument schema (FR-10)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A tool's argument schema (FR-10). Each tool publishes one so the harness renders
 * the correct signature AND unknown/extra args are REJECTED rather than silently
 * passed to the daemon. Built with `zod/v3` (the MCP SDK's zod major). `.strict()`
 * is the rejection mechanism — Wave 2 keeps every placeholder strict.
 */
export type ToolArgSchema = z.ZodTypeAny;

// ─────────────────────────────────────────────────────────────────────────────
// Actor — the headers every handler stamps (FR-2 / d-AC-1 / D-6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The actor identity each handler stamps onto its daemon call (FR-2 / d-AC-1).
 * Combined with `x-honeycomb-runtime-path: plugin`, this scopes MCP traffic. The
 * daemon (already built) enforces; this surface only STAMPS (D-6).
 */
export interface Actor {
	/** The actor label (user/agent id). */
	readonly actor: string;
	/** The actor type (e.g. `user`, `agent`, `plugin`). */
	readonly actorType: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// DaemonApiSeam — the ONLY path out to the daemon (FR-2 / D-2)
// ─────────────────────────────────────────────────────────────────────────────

/** A single daemon-API call every tool handler routes through (FR-2). */
export interface DaemonApiRequest {
	/** The daemon API method (e.g. `GET`, `POST`). */
	readonly method: string;
	/** The daemon API path (e.g. `/api/memories/search`). */
	readonly path: string;
	/** The JSON body for a mutation, if any. */
	readonly body?: unknown;
	/** The actor headers stamped on the call (FR-2). */
	readonly actor: Actor;
}

/** A daemon-API response: parsed JSON body + HTTP status. */
export interface DaemonApiResponse {
	readonly status: number;
	readonly body?: unknown;
}

/**
 * The daemon-API seam (FR-2 / D-2). The ONLY way a tool handler reaches the daemon.
 * The real impl (Wave 2) calls the daemon's own API internally, stamping
 * `x-honeycomb-runtime-path: plugin` + the actor headers; the fake records every
 * call so a test asserts every handler routes through the daemon (d-AC-1) and that
 * the stamps are present (D-6 — assert the stamp, not daemon enforcement).
 */
export interface DaemonApiSeam {
	/** Call the daemon API. Stamps `x-honeycomb-runtime-path: plugin` + actor headers. */
	call(req: DaemonApiRequest): Promise<DaemonApiResponse>;
}

/** A recorded {@link DaemonApiSeam} call (the fake's audit trail). */
export interface RecordedApiCall {
	readonly method: string;
	readonly path: string;
	readonly body?: unknown;
	readonly actor: Actor;
}

/** A {@link DaemonApiSeam} fake that records every call for assertions. */
export interface FakeDaemonApiSeam extends DaemonApiSeam {
	readonly calls: readonly RecordedApiCall[];
}

/**
 * Build a recording {@link DaemonApiSeam} fake. Records each call and returns the
 * configured status/body so a Wave-2 test drives a handler against it — no daemon,
 * no DeepLake. Default status `200`.
 */
export function createFakeDaemonApiSeam(opts: { status?: number; body?: unknown } = {}): FakeDaemonApiSeam {
	const calls: RecordedApiCall[] = [];
	const status = opts.status ?? 200;
	return {
		get calls(): readonly RecordedApiCall[] {
			return calls;
		},
		async call(req: DaemonApiRequest): Promise<DaemonApiResponse> {
			calls.push({ method: req.method, path: req.path, body: req.body, actor: req.actor });
			return { status, body: opts.body };
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// ToolHandler + ToolRegistry — the registration contract (FR-3..FR-10)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A tool handler: receives the validated args + the actor, routes through the
 * {@link DaemonApiSeam}, and returns a JSON-serializable result. Mutating memory
 * tools (`memory_modify`/`memory_forget`) reject a call missing a `reason` BEFORE
 * dispatching (FR-9 / d-AC-3); secrets handlers never return a value (FR-8 / d-AC-2).
 */
export type ToolHandler = (args: unknown, actor: Actor, daemon: DaemonApiSeam) => Promise<unknown>;

/**
 * The tool-registration contract (FR-10). Wave 2 backs this with the MCP SDK's
 * `McpServer.registerTool`, but the seam is defined locally so the scaffold compiles
 * WITHOUT the SDK dependency. `registerTool` rejects unknown/extra args via the
 * strict {@link ToolArgSchema} (FR-10). The `errorResult` helper shapes a handler
 * error into the MCP error envelope.
 */
export interface ToolRegistry {
	/** Register a tool under its `honeycomb_`-prefixed name with a strict arg schema (FR-10). */
	registerTool(name: string, argSchema: ToolArgSchema, handler: ToolHandler): void;
	/** The names registered so far (for the surface-list assertion, d-AC-1). */
	readonly registered: readonly string[];
}

/**
 * Build the real {@link ToolRegistry} (Wave 2 backs it with `McpServer.registerTool`).
 * STUB: `registerTool` throws {@link notImplemented} so an early call fails loud. The
 * `registered` list is empty until Wave 2 wires the SDK. Constructed with the daemon
 * seam + actor so every registered handler routes through the daemon (FR-2).
 */
export function createToolRegistry(_daemon: DaemonApiSeam): ToolRegistry {
	void _daemon;
	const registered: string[] = [];
	return {
		get registered(): readonly string[] {
			return registered;
		},
		registerTool(_name: string, _argSchema: ToolArgSchema, _handler: ToolHandler): void {
			void _name;
			void _argSchema;
			void _handler;
			notImplemented("ToolRegistry.registerTool (McpServer.registerTool wiring, d-AC-1)");
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// errorResult — the MCP error envelope (FR error semantics)
// ─────────────────────────────────────────────────────────────────────────────

/** The MCP-style error result a handler returns on failure (value-safe: no payload echo). */
export interface ToolErrorResult {
	readonly isError: true;
	readonly message: string;
}

/** Shape a handler error into the MCP error envelope. Never echoes the raw arg payload. */
export function errorResult(message: string): ToolErrorResult {
	return { isError: true, message };
}

export { z };

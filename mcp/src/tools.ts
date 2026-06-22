/**
 * The unified `honeycomb_` tool surface — PRD-019d Wave 1 (names + arg-schema placeholders).
 *
 * Lists the ~27 tools the MCP server registers (FR-3..FR-8 + PRD-046e pull path), grouped
 * by cluster, each with a STRICT `zod/v3` arg-schema PLACEHOLDER. The placeholders pin the arg
 * NAMES + required fields so the harness renders correct signatures and unknown args
 * are rejected (FR-10); Wave 2 fills the field types + wires each handler through the
 * daemon seam. `.strict()` is the unknown-arg rejection mechanism (d-AC-1 / FR-10).
 *
 * Value-safety + audit guarantees encoded HERE as schema shape:
 *   - `memory_modify` / `memory_forget` REQUIRE a `reason` (FR-9 / d-AC-3).
 *   - secrets tools carry no value field; `secret_list` returns names, `secret_exec`
 *     returns redacted output (FR-8 / d-AC-2) — enforced in the Wave-2 handler.
 *
 * The `codebase` cluster is registered CONDITIONALLY (only after `honeycomb graph
 * build`, FR-7 / d-AC-4); it is listed here so Wave 2 knows the exact set to gate.
 *
 * PRD-046e (the pull half of session-memory priming):
 *   - `hivemind_read` — zoom a primed key's ref down to Tier-2 summary (depth=1) or
 *     Tier-3 raw turns (depth=2). A deterministic SELECT by id/path, NOT a search.
 *   - `hivemind_search` — mine via the existing hybrid RRF recall (lexical + semantic,
 *     `degraded` honest). Routes to `POST /api/memories/recall`.
 */

import { type ToolArgSchema, type ToolCluster, z } from "./contracts.js";

/** A tool's Wave-1 descriptor: its `honeycomb_`-prefixed name, cluster, and arg schema. */
export interface ToolSpec {
	/** The registered tool name (the unified `honeycomb_`-prefixed surface). */
	readonly name: string;
	/** The cluster this tool belongs to (gates conditional registration). */
	readonly cluster: ToolCluster;
	/** The STRICT arg-schema placeholder (rejects unknown args, FR-10). */
	readonly argSchema: ToolArgSchema;
	/** Whether the cluster is conditionally registered (codebase → graph-built only). */
	readonly conditional?: boolean;
}

// A minimal strict object placeholder; Wave 2 fills field types. `.strict()` rejects
// unknown args (FR-10). Shared base kept tiny so each spec stays declarative.
const args = (shape: z.ZodRawShape): ToolArgSchema => z.object(shape).strict();
const opt = z.unknown().optional();

/**
 * The full tool surface (FR-3..FR-8). ~25 tools across seven clusters. Wave 2
 * registers each via `ToolRegistry.registerTool(spec.name, spec.argSchema, handler)`.
 */
export const TOOL_SPECS: readonly ToolSpec[] = [
	// ── Memory cluster (FR-3) ────────────────────────────────────────────────
	{ name: "memory_search", cluster: "memory", argSchema: args({ query: z.string(), limit: opt }) },
	{ name: "memory_store", cluster: "memory", argSchema: args({ text: z.string(), path: opt }) },
	{ name: "memory_get", cluster: "memory", argSchema: args({ path: z.string() }) },
	{ name: "memory_list", cluster: "memory", argSchema: args({ prefix: opt }) },
	// memory_modify / memory_forget REQUIRE a `reason` (FR-9 / d-AC-3).
	{ name: "memory_modify", cluster: "memory", argSchema: args({ path: z.string(), reason: z.string() }) },
	{ name: "memory_forget", cluster: "memory", argSchema: args({ path: z.string(), reason: z.string() }) },
	{ name: "memory_feedback", cluster: "memory", argSchema: args({ path: z.string(), signal: opt }) },

	// ── Browse cluster (FR-4) — the VFS-style read-only trio ─────────────────
	{ name: "honeycomb_search", cluster: "browse", argSchema: args({ query: z.string() }) },
	{ name: "honeycomb_read", cluster: "browse", argSchema: args({ path: z.string() }) },
	{ name: "honeycomb_index", cluster: "browse", argSchema: args({ prefix: opt }) },

	// ── Sessions cluster (FR-5) ──────────────────────────────────────────────
	// session_search can infer parent lineage from a child session key (d-AC-5).
	{ name: "session_search", cluster: "sessions", argSchema: args({ query: z.string(), sessionKey: opt }) },
	{ name: "session_bypass", cluster: "sessions", argSchema: args({ sessionId: z.string() }) },

	// ── Prime-pull cluster (PRD-046e) — the pull half of session-memory priming ─
	// `hivemind_read` — zoom a ref from the prime's index down to Tier-2 (depth=1)
	// or Tier-3 (depth=2). `ref` is the opaque id from the prime response. `source`
	// tells which table the ref lives in ("episodic" = memory, "durable" = memories).
	// `depth` and `source` are optional (default depth=1, source=episodic). `turns`
	// caps the number of raw session turns at depth=2 (bounded by MAX_RESOLVE_TURNS).
	{
		name: "hivemind_read",
		cluster: "memory",
		argSchema: args({ ref: z.string(), depth: opt, source: opt, turns: opt }),
	},
	// `hivemind_search` — mine memory via the existing hybrid RRF recall engine
	// (lexical ILIKE + `<#>` cosine semantic, fused with RRF, `degraded` honest).
	// Routes to `POST /api/memories/recall` — the WIRED recall, NOT a new engine.
	{
		name: "hivemind_search",
		cluster: "memory",
		argSchema: args({ query: z.string(), limit: opt }),
	},

	// ── Goals / KPIs cluster (FR-6) ──────────────────────────────────────────
	{ name: "honeycomb_goal_add", cluster: "goals-kpis", argSchema: args({ goal: z.string() }) },
	{ name: "honeycomb_kpi_add", cluster: "goals-kpis", argSchema: args({ kpi: z.string(), goalId: opt }) },

	// ── Agent coordination cluster (FR-6) ────────────────────────────────────
	{ name: "agent_peers", cluster: "agent", argSchema: args({}) },
	{ name: "agent_message_send", cluster: "agent", argSchema: args({ to: z.string(), message: z.string() }) },
	{ name: "agent_message_inbox", cluster: "agent", argSchema: args({}) },

	// ── Codebase cluster (FR-7 / d-AC-4) — CONDITIONAL on `honeycomb graph build` ─
	{ name: "honeycomb_code_search", cluster: "codebase", conditional: true, argSchema: args({ query: z.string() }) },
	{ name: "honeycomb_code_context", cluster: "codebase", conditional: true, argSchema: args({ symbol: z.string() }) },
	{ name: "honeycomb_code_blast", cluster: "codebase", conditional: true, argSchema: args({ symbol: z.string() }) },
	{ name: "honeycomb_code_impact", cluster: "codebase", conditional: true, argSchema: args({ symbol: z.string() }) },

	// ── Secrets cluster (FR-8 / d-AC-2) — value-safe: names + redacted output only ─
	{ name: "secret_list", cluster: "secrets", argSchema: args({ prefix: opt }) },
	{ name: "secret_exec", cluster: "secrets", argSchema: args({ command: z.string() }) },
];

/** The tool names, for the surface-list assertion (d-AC-1). */
export const TOOL_NAMES: readonly string[] = TOOL_SPECS.map((t) => t.name);

/** The codebase tools gated behind `honeycomb graph build` (FR-7 / d-AC-4). */
export const CONDITIONAL_TOOL_NAMES: readonly string[] = TOOL_SPECS.filter((t) => t.conditional).map(
	(t) => t.name,
);

/** The tools that REQUIRE a `reason` argument (FR-9 / d-AC-3). */
export const REASON_REQUIRED_TOOLS: readonly string[] = ["memory_modify", "memory_forget"];

/** The value-safe secrets tools (FR-8 / d-AC-2). */
export const SECRETS_TOOLS: readonly string[] = ["secret_list", "secret_exec"];

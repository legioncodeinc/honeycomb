/**
 * The unified `honeycomb_` tool surface — PRD-019d Wave 1 (names + arg-schema placeholders).
 *
 * Lists the 19 tools the MCP server registers (15 unconditional + the 4-tool conditional
 * `codebase` cluster, FR-3..FR-8 + PRD-046e pull path), grouped by cluster, each with a
 * STRICT `zod/v3` arg-schema PLACEHOLDER. The placeholders pin the arg NAMES + required
 * fields so the harness renders correct signatures and unknown args are rejected (FR-10);
 * Wave 2 fills the field types + wires each handler through the daemon seam. `.strict()`
 * is the unknown-arg rejection mechanism (d-AC-1 / FR-10).
 *
 * ── C-2 pre-release fix (2026-07-03) ─────────────────────────────────────────
 * The original Wave-1 scaffold ALSO listed `sessions` (session_search, session_bypass),
 * `agent` (agent_peers, agent_message_send, agent_message_inbox), and `memory_feedback`.
 * None of those had a backing daemon route — `src/daemon/runtime/server.ts`'s
 * `ROUTE_GROUPS` never mounts `/api/sessions` or `/api/agents`, and `/api/memories`
 * has no `/feedback` sub-route — so every call 404'd. They are REMOVED here (unregistered,
 * not built, per the pre-release close-out call) rather than pointed at a route that does
 * not exist. `memory_list`'s `prefix` arg is also removed: the real `GET /api/memories`
 * list route (`memories/api.ts`) has no prefix filter, so the arg was dead on arrival.
 *
 * Value-safety + audit guarantees encoded HERE as schema shape:
 *   - `memory_modify` / `memory_forget` REQUIRE a `reason` (FR-9 / d-AC-3). `memory_modify`
 *     also requires `content` — the real `POST /api/memories/:id/modify` route needs new
 *     content to write; there is no daemon-side "modify with no new content" operation.
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

import { MEMORY_TYPES, memoryTypeGuidance } from "../../src/shared/memory-types.js";
import { type ToolArgSchema, type ToolCluster, z } from "./contracts.js";

/**
 * The CLOSED memory-type enum the `memory_store` tool publishes (PRD memory-type taxonomy).
 * Built ONCE from the single-sourced {@link MEMORY_TYPES} with `zod/v3` (the MCP SDK's zod
 * major — `z` here is re-exported from `zod/v3`), so the harness renders a six-value dropdown
 * and an UNKNOWN type is rejected at the tool boundary. The `.describe(...)` carries the
 * LLM-facing guidance (every token + WHEN to use it) so the agent classifies the memory it is
 * about to store. Optional — omitted ⇒ the daemon applies the column default `fact`. The tuple
 * is zod-free (a plain `as const`), so the SAME source feeds the app's `zod ^4` gate too.
 */
const memoryTypeArg = z
	.enum(MEMORY_TYPES)
	.describe(`The memory's type (optional; defaults to "fact"). Choose the best fit:\n${memoryTypeGuidance()}`)
	.optional();

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
 * The full tool surface (FR-3..FR-8). 19 tools across five clusters (15 unconditional +
 * the 4-tool conditional `codebase` cluster). Wave 2 registers each via
 * `ToolRegistry.registerTool(spec.name, spec.argSchema, handler)`.
 */
export const TOOL_SPECS: readonly ToolSpec[] = [
	// ── Memory cluster (FR-3) ────────────────────────────────────────────────
	{ name: "memory_search", cluster: "memory", argSchema: args({ query: z.string(), limit: opt }) },
	{ name: "memory_store", cluster: "memory", argSchema: args({ text: z.string(), path: opt, type: memoryTypeArg }) },
	{ name: "memory_get", cluster: "memory", argSchema: args({ path: z.string() }) },
	// C-2 fix: the WIRED `GET /api/memories` list route has no prefix filter — `prefix`
	// removed rather than published-and-ignored (M-10).
	{ name: "memory_list", cluster: "memory", argSchema: args({ limit: opt }) },
	// memory_modify / memory_forget REQUIRE a `reason` (FR-9 / d-AC-3). `memory_modify`
	// ALSO requires `content` (C-2 fix): the real `POST /api/memories/:id/modify` route
	// is a version-bumped UPDATE that needs the new content — there is no "modify" that
	// only changes the reason.
	{
		name: "memory_modify",
		cluster: "memory",
		argSchema: args({ path: z.string(), content: z.string(), reason: z.string() }),
	},
	{ name: "memory_forget", cluster: "memory", argSchema: args({ path: z.string(), reason: z.string() }) },

	// ── Browse cluster (FR-4) — the VFS-style read-only trio ─────────────────
	{ name: "honeycomb_search", cluster: "browse", argSchema: args({ query: z.string() }) },
	{ name: "honeycomb_read", cluster: "browse", argSchema: args({ path: z.string() }) },
	{ name: "honeycomb_index", cluster: "browse", argSchema: args({ prefix: opt }) },

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
	// The handler maps the single string onto the daemon's strict `{ key, value }` keyed
	// body (`product/keyed-engine.ts`). `goalId` was removed from kpi_add (C-2 follow-up):
	// the daemon's keyed schema has no goal-linkage field, so it was published-and-ignored
	// (the same M-10 pattern as memory_list's `prefix`).
	{ name: "honeycomb_goal_add", cluster: "goals-kpis", argSchema: args({ goal: z.string() }) },
	{ name: "honeycomb_kpi_add", cluster: "goals-kpis", argSchema: args({ kpi: z.string() }) },

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
export const CONDITIONAL_TOOL_NAMES: readonly string[] = TOOL_SPECS.filter((t) => t.conditional).map((t) => t.name);

/** The tools that REQUIRE a `reason` argument (FR-9 / d-AC-3). */
export const REASON_REQUIRED_TOOLS: readonly string[] = ["memory_modify", "memory_forget"];

/** The value-safe secrets tools (FR-8 / d-AC-2). */
export const SECRETS_TOOLS: readonly string[] = ["secret_list", "secret_exec"];

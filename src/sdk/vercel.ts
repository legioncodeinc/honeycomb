/**
 * Vercel AI SDK helper entry point — PRD-019e Wave 2 (`@legioncodeinc/honeycomb/vercel`).
 *
 * A SEPARATE entry point (FR-8 / e-AC-5) exposing Honeycomb memory as Vercel AI SDK
 * tools, so they drop into an existing agent loop. It REUSES the core
 * {@link HoneycombClient}'s token + actor model (FR-8 / e-AC-5) — every tool's
 * `execute` calls the SAME client, so the configured token/actor/actorType ride on
 * the daemon call; the helper never re-implements HTTP. `ai` is a `peerDependencies`
 * entry, never bundled into core.
 *
 * ── WHY NO `ai` IMPORT ──────────────────────────────────────────────────────
 * The Vercel AI SDK `tool({ description, parameters, execute })` shape is a PLAIN
 * object — `parameters` is a JSON-Schema-compatible object and `execute` is an async
 * function. We emit that object literally, so no `ai` import is needed to typecheck
 * (the SDK is not in this repo's deps). At app runtime the object is structurally a
 * valid AI SDK tool; the app's `ai` consumes it directly.
 */

import type { HoneycombClient } from "./contracts.js";

/**
 * A Vercel AI SDK tool definition (the structural shape `ai`'s `tool()` produces).
 * `parameters` is a JSON-Schema object; `execute` runs the tool against the core
 * client. Typed locally so the helper compiles without the `ai` peer dep.
 */
export interface VercelAiTool {
	readonly description: string;
	readonly parameters: Record<string, unknown>;
	readonly execute: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Build the Vercel AI SDK tool set from a core client (FR-8 / e-AC-5). Returns a
 * record of tool definitions (`honeycomb_recall`, `honeycomb_remember`) whose
 * `execute` closes over the SAME {@link HoneycombClient} — so the token + actor model
 * is reused, not re-implemented. The secrets surface is intentionally NOT exposed as
 * a tool here (value-safety, FR-9): a model loop should not pull secrets.
 */
export function createVercelAiTools(client: HoneycombClient): Record<string, VercelAiTool> {
	return {
		honeycomb_recall: {
			description: "Recall relevant memories from Honeycomb for a query.",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "The text to recall memories for." },
					limit: { type: "number", description: "Max results to return." },
				},
				required: ["query"],
				additionalProperties: false,
			},
			async execute(args: Record<string, unknown>): Promise<unknown> {
				const query = String(args.query ?? "");
				const limit = typeof args.limit === "number" ? args.limit : undefined;
				return await client.recall(query, limit !== undefined ? { limit } : undefined);
			},
		},
		honeycomb_remember: {
			description: "Store a memory in Honeycomb.",
			parameters: {
				type: "object",
				properties: {
					text: { type: "string", description: "The memory text to store." },
					path: { type: "string", description: "Optional memory path to store under." },
				},
				required: ["text"],
				additionalProperties: false,
			},
			async execute(args: Record<string, unknown>): Promise<unknown> {
				const text = String(args.text ?? "");
				const path = typeof args.path === "string" ? args.path : undefined;
				await client.remember(text, path !== undefined ? { path } : undefined);
				return { ok: true };
			},
		},
	};
}

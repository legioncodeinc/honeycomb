/**
 * OpenAI tool helper entry point — PRD-019e Wave 2 (`@legioncodeinc/honeycomb/openai`).
 *
 * A SEPARATE entry point (FR-8 / e-AC-5) exposing the same memory operations as
 * OpenAI function-tool definitions. It REUSES the core {@link HoneycombClient}'s
 * token + actor model (FR-8 / e-AC-5) — {@link createOpenAiTools} emits the plain
 * JSON tool shape OpenAI's API consumes, and {@link dispatchOpenAiToolCall} runs a
 * named tool call against the SAME client (so the configured token/actor ride on the
 * daemon call); the helper never re-implements HTTP. No SDK import is needed — the
 * OpenAI function-tool shape is plain JSON.
 */

import type { HoneycombClient } from "./contracts.js";

/** An OpenAI function-tool definition (the plain JSON shape OpenAI's API consumes). */
export interface OpenAiFunctionTool {
	readonly type: "function";
	readonly function: {
		readonly name: string;
		readonly description: string;
		readonly parameters: Record<string, unknown>;
	};
}

/** The tool names the helper exposes — the dispatcher routes on these. */
export const OPENAI_TOOL_RECALL = "honeycomb_recall";
export const OPENAI_TOOL_REMEMBER = "honeycomb_remember";

/**
 * Build the OpenAI function-tool definitions for Honeycomb memory (FR-8 / e-AC-5):
 * `honeycomb_recall` + `honeycomb_remember`. Pure data — no client needed to BUILD
 * the defs; the client is supplied to {@link dispatchOpenAiToolCall} at call time.
 * The secrets surface is intentionally NOT exposed (value-safety, FR-9).
 */
export function createOpenAiTools(): readonly OpenAiFunctionTool[] {
	return [
		{
			type: "function",
			function: {
				name: OPENAI_TOOL_RECALL,
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
			},
		},
		{
			type: "function",
			function: {
				name: OPENAI_TOOL_REMEMBER,
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
			},
		},
	];
}

/**
 * Dispatch an OpenAI tool call (by name + args) against the core client (FR-8 /
 * e-AC-5) — the runtime half of the helper. `args` is the JSON the model produced
 * (a parsed `tool_call.function.arguments`); it is narrowed defensively before the
 * client call. An unknown tool name throws so a mis-routed call fails loud.
 */
export async function dispatchOpenAiToolCall(
	client: HoneycombClient,
	name: string,
	args: unknown,
): Promise<unknown> {
	const a = (args !== null && typeof args === "object" ? args : {}) as Record<string, unknown>;
	switch (name) {
		case OPENAI_TOOL_RECALL: {
			const query = String(a.query ?? "");
			const limit = typeof a.limit === "number" ? a.limit : undefined;
			return await client.recall(query, limit !== undefined ? { limit } : undefined);
		}
		case OPENAI_TOOL_REMEMBER: {
			const text = String(a.text ?? "");
			const path = typeof a.path === "string" ? a.path : undefined;
			await client.remember(text, path !== undefined ? { path } : undefined);
			return { ok: true };
		}
		default:
			throw new Error(`dispatchOpenAiToolCall: unknown tool "${name}"`);
	}
}

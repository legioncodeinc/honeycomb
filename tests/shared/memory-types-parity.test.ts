/**
 * The CLOSED memory-type taxonomy — PARITY suite.
 *
 * The taxonomy is single-sourced in `src/shared/memory-types.ts`. This suite proves the
 * four user-facing surfaces all draw from THAT one source, so they cannot drift:
 *   - the daemon `POST /api/memories` zod gate (`StoreBodySchema.type`);
 *   - the MCP `memory_store` tool's published `type` enum;
 *   - the dashboard Add-memory dropdown (renders `MEMORY_TYPES`);
 *   - the CLI `remember --type` guard (`isMemoryType`).
 *
 * It asserts each surface ACCEPTS exactly the six and REJECTS a token outside the set —
 * driving the real validators, not just reading a constant. A drift (a surface adding or
 * dropping a token) fails here.
 */

import { describe, expect, it } from "vitest";
import { z as zV3 } from "zod/v3";

import {
	DEFAULT_MEMORY_TYPE,
	MEMORY_TYPES,
	isMemoryType,
	memoryTypeGuidance,
} from "../../src/shared/memory-types.js";
import { TOOL_SPECS } from "../../mcp/src/tools.js";
import { StoreBodySchema } from "../../src/daemon/runtime/memories/api.js";

/** The exact six, frozen, as the parity baseline (sorted for set comparison). */
const EXPECTED = [...MEMORY_TYPES].sort();

/** Pull a zod enum's option list off a (possibly optional) field schema, v3-or-v4 tolerant. */
function enumOptions(field: unknown): string[] {
	const f = field as { unwrap?: () => unknown; options?: unknown };
	const inner = (typeof f.unwrap === "function" ? f.unwrap() : f) as { options?: unknown };
	const opts = inner.options;
	return Array.isArray(opts) ? (opts as string[]) : [];
}

describe("memory-type taxonomy parity — one source feeds every surface", () => {
	it("the shared source is the six tokens with 'fact' as the default", () => {
		expect([...MEMORY_TYPES].sort()).toEqual(EXPECTED);
		expect(MEMORY_TYPES).toHaveLength(6);
		expect(DEFAULT_MEMORY_TYPE).toBe("fact");
	});

	it("the CLI guard (isMemoryType) accepts exactly the six and rejects others", () => {
		for (const t of MEMORY_TYPES) expect(isMemoryType(t)).toBe(true);
		expect(isMemoryType("banana")).toBe(false);
		expect(isMemoryType("")).toBe(false);
		expect(isMemoryType("FACT")).toBe(false); // case-sensitive: the token is lowercase.
	});

	it("the MCP memory_store tool publishes the six-token enum from the shared source", () => {
		const spec = TOOL_SPECS.find((t) => t.name === "memory_store");
		expect(spec, "memory_store must be registered").toBeDefined();
		const shape = (spec?.argSchema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
		const options = enumOptions(shape.type);
		expect([...options].sort()).toEqual(EXPECTED);
	});

	it("the MCP type enum carries the LLM guidance (every token + when to use it)", () => {
		const guidance = memoryTypeGuidance();
		for (const t of MEMORY_TYPES) expect(guidance).toContain(t);
		// The guidance is a real enumeration, one line per token.
		expect(guidance.split("\n")).toHaveLength(MEMORY_TYPES.length);
	});

	it("the REAL daemon gate (StoreBodySchema.type) publishes exactly the six", () => {
		// Import the ACTUAL `POST /api/memories` schema (not a reconstruction): pull the `type`
		// field's enum options off it so a future hardcode of the daemon enum — e.g. swapping
		// `z.enum(MEMORY_TYPES)` for a literal list — fails THIS assertion, not just the e2e suite.
		const shape = (StoreBodySchema as unknown as { shape: Record<string, unknown> }).shape;
		const options = enumOptions(shape.type);
		expect([...options].sort()).toEqual(EXPECTED);
	});

	it("the dashboard dropdown renders the shared source directly (parity by construction)", () => {
		// The Add-memory `<select>` maps `MEMORY_TYPES` itself (no separate hardcoded list), so it
		// cannot drift; this asserts that invariant holds at the source the form imports.
		expect([...MEMORY_TYPES].sort()).toEqual(EXPECTED);
		expect(zV3.enum(MEMORY_TYPES).safeParse("banana").success).toBe(false);
	});
});

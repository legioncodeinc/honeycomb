/**
 * The CLOSED memory-type taxonomy — the SINGLE SOURCE OF TRUTH for the six fixed
 * memory `type` tokens, their human/LLM-facing descriptions, and the default.
 *
 * Every surface that constrains or describes a memory `type` imports from HERE and
 * NEVER re-declares the list:
 *   - the daemon's `POST /api/memories` zod gate (`src/daemon/runtime/memories/api.ts`)
 *     validates the user-supplied `type` against {@link MEMORY_TYPES};
 *   - the dashboard Add-memory form renders the {@link MEMORY_TYPES} as a `<select>`;
 *   - the MCP `memory_store` tool publishes the enum + the LLM guidance string so an
 *     agent classifies the memory it is about to store;
 *   - the `honeycomb remember --type` CLI validates against the same set.
 * A parity test (`tests/shared/memory-types-parity.test.ts`) asserts every surface
 * draws from THIS module so the four surfaces cannot drift. Duplicating the list into
 * another file is a drift bug and is flagged by `npm run dup` (jscpd).
 *
 * ── Pure by design (no zod) ──────────────────────────────────────────────────
 * This module declares ONLY plain tuples/records — no zod import. {@link MEMORY_TYPES}
 * is a `readonly [...]` tuple so it feeds `z.enum(MEMORY_TYPES)` under BOTH zod majors
 * the repo uses: the app's `zod ^4` (daemon/dashboard) and the MCP server's `zod/v3`
 * (the MCP SDK's major). Keeping the tuple zod-free is what lets one source feed both.
 *
 * ── Closed-set, write-time gate (back-compat) ────────────────────────────────
 * The gate constrains USER-FACING writes (API / dashboard / CLI / MCP) only. It is a
 * WRITE-TIME validation; it never rewrites stored rows. Existing rows whose `type` is a
 * legacy/free-form value keep that value and still display. The autonomous capture
 * pipeline (`fan-out.ts` → controlled-writes) enqueues its own `fact_type` directly and
 * does NOT pass through this gate, so a model-assigned type outside the six never breaks
 * (the column DDL keeps its `DEFAULT 'fact'`; no schema migration).
 */

/**
 * The six fixed memory types — the closed set. ORDER IS LOAD-BEARING for the
 * dashboard dropdown render; `fact` is first (the default). A `readonly` tuple so
 * `z.enum(MEMORY_TYPES)` infers the exact union under both zod majors.
 */
export const MEMORY_TYPES = [
	"fact",
	"convention",
	"preference",
	"decision",
	"gotcha",
	"reference",
] as const;

/** One memory type token (the union of the six). */
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** The default applied when a user-facing write omits `type` — matches the column DDL `DEFAULT 'fact'`. */
export const DEFAULT_MEMORY_TYPE: MemoryType = "fact";

/**
 * The one-line description of each type — how a reader OR an agent decides which to
 * apply. The MCP tool schema + the CLI `--help` enumerate these so the LLM/user
 * classifies correctly. Keyed by token so a lookup can never name a non-enum type.
 */
export const MEMORY_TYPE_DESCRIPTIONS: Readonly<Record<MemoryType, string>> = Object.freeze({
	fact: "A stable, verifiable truth about the system, codebase, or domain.",
	convention: "How things are done here: idioms, standards, patterns to follow by default.",
	preference: "The user/team's stated way of working; corrections and do/don't guidance.",
	decision: "An architectural or design choice and its rationale; don't relitigate it.",
	gotcha: "A non-obvious trap, failure mode, or constraint to watch out for.",
	reference: "A pointer to an external resource (URL, dashboard, ticket, doc).",
});

/** Narrow an arbitrary string to a {@link MemoryType} (the closed-set membership test). */
export function isMemoryType(value: string): value is MemoryType {
	return (MEMORY_TYPES as readonly string[]).includes(value);
}

/**
 * The LLM/user-facing guidance string: every token paired with WHEN to use it, on its
 * own line. Built ONCE from {@link MEMORY_TYPES} + {@link MEMORY_TYPE_DESCRIPTIONS} so the
 * MCP tool description and the CLI `--help` enumerate the identical set — they cannot
 * drift from the gate. `fact` is annotated as the default.
 */
export function memoryTypeGuidance(): string {
	return MEMORY_TYPES.map((t) => {
		const suffix = t === DEFAULT_MEMORY_TYPE ? " (default)" : "";
		return `- ${t}${suffix}: ${MEMORY_TYPE_DESCRIPTIONS[t]}`;
	}).join("\n");
}

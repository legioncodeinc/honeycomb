/**
 * The normalized capture-event contract (PRD-005a FR-2 / FR-5 / FR-10).
 *
 * A harness shim POSTs a single normalized turn event per request to
 * `/api/hooks/capture`. This module is the zod BOUNDARY (typescript-node stinger
 * Hard Rule #3: zod at every external boundary): it validates the untrusted
 * request body and rejects a malformed payload BEFORE the handler builds any SQL.
 * The app uses zod ^4 (the MCP server is the only place that imports `zod/v3`),
 * so this module imports from `"zod"`.
 *
 * The body has two parts:
 *   1. an `event` — one of three normalized kinds (FR-2):
 *        - `user_message`      → the prompt text
 *        - `tool_call`         → tool name + input + response
 *        - `assistant_message` → the assistant's last message
 *      The whole event object is stored VERBATIM as the JSONB `message` column so
 *      the original structured shape survives for later extraction (FR-4). The
 *      prompt text inside a `user_message` is attacker-controllable, which is
 *      exactly why the handler routes it through `eLiteral` when it interpolates
 *      the serialized JSON (FR-9).
 *   2. session `metadata` — session id, path, cwd, permission mode, hook event
 *      name, agent_id, org, workspace (FR-5). `org`/`workspace` thread tenancy
 *      onto the row + scope the read-back; `path` groups the conversation (FR-6).
 *
 * FR-10: any supported harness (Claude Code, Codex, Cursor, OpenClaw, Hermes, pi)
 * POSTs this SAME normalized shape — including OpenClaw's batched `messages` slice
 * normalized down to one event per request by the shim. This contract is
 * harness-agnostic by construction.
 */

import { z } from "zod";

/** The three normalized event kinds (FR-2). */
export const CAPTURE_EVENT_KINDS = ["user_message", "tool_call", "assistant_message"] as const;

/** A non-empty trimmed string used for ids/paths/scope that must carry a value. */
const nonEmpty = z.string().trim().min(1);

/**
 * PRD-060a (a-AC-1 / a-AC-6) — normalized per-turn token + cache usage.
 *
 * An assistant turn OPTIONALLY carries this, lowered by the harness shim from the
 * Claude Code transcript's per-message `usage` block (`input_tokens` /
 * `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`).
 * Every field is itself OPTIONAL: a partial usage block populates only the counts
 * the harness actually saw, and a turn with NO usage omits the whole object.
 *
 * ── ZERO vs NULL DISCIPLINE (a-AC-1 / a-AC-6, the open-question ruling) ───────
 * A genuine `cacheRead = 0` (a real measurement: the turn read nothing from cache)
 * is DISTINCT from "no usage data" (the harness never produced a count). The
 * contract keeps them apart by ABSENCE, not by a sentinel: a measured zero is the
 * number `0`; "absent" is the field (or the whole `usage` object) simply not being
 * there. This is why the persisted columns are NULLABLE (no `DEFAULT 0`) — a
 * `DEFAULT 0` would silently collapse "absent" into "measured zero", which a-AC-6
 * forbids. Each count is a NON-NEGATIVE integer; a negative or fractional value is
 * a malformed count and is rejected at this boundary (the handler then omits it →
 * the column stays NULL, never a silent 0).
 */
const tokenCount = z.number().int().nonnegative();

/** The optional normalized per-turn usage block (PRD-060a a-AC-1). */
export const TurnUsageSchema = z
	.object({
		/** `input_tokens` — prompt tokens billed for this turn. */
		input: tokenCount.optional(),
		/** `output_tokens` — completion tokens billed for this turn. */
		output: tokenCount.optional(),
		/** `cache_read_input_tokens` — tokens served from the prompt cache (a real 0 ≠ absent). */
		cacheRead: tokenCount.optional(),
		/** `cache_creation_input_tokens` — tokens written into the prompt cache. */
		cacheCreation: tokenCount.optional(),
	})
	// `.strict()` would reject a future harness adding a field; stay permissive but
	// only the four known counts are read downstream. No unknown field is persisted.
	.optional()
	// Finding (empty-usage): an EMPTY `usage: {}` (every field absent) carries no information and must
	// NEVER persist as a distinct "present but empty" usage block. Normalize `{}` (or any object with no
	// known count) -> `undefined`, so the "no-usage turn round-trips with the field ABSENT" behavior is
	// preserved and a `{}` never reaches the row. A block with at least one of input/output/cacheRead/
	// cacheCreation passes through unchanged.
	.transform((u) =>
		u !== undefined &&
		(u.input !== undefined || u.output !== undefined || u.cacheRead !== undefined || u.cacheCreation !== undefined)
			? u
			: undefined,
	);

/**
 * `user_message` — a captured user prompt (FR-2). `text` is the prompt body; it
 * is attacker-controllable and is escaped via `eLiteral` at the SQL boundary.
 */
export const UserMessageEventSchema = z.object({
	kind: z.literal("user_message"),
	text: z.string(),
});

/**
 * `tool_call` — a captured tool invocation (FR-2). `input`/`response` are
 * schemaless per-tool JSON, preserved intact in the JSONB message.
 */
export const ToolCallEventSchema = z.object({
	kind: z.literal("tool_call"),
	tool: nonEmpty,
	input: z.unknown().optional(),
	response: z.unknown().optional(),
});

/**
 * `assistant_message` — the assistant's last message (FR-2). PRD-060a (a-AC-1):
 * it ADDITIVELY carries the optional normalized `usage` block alongside `text`.
 * The field is OPTIONAL and round-trips ABSENT when the harness produced no usage,
 * so every pre-060a assistant turn still validates unchanged (a-AC-1 / a-AC-6).
 */
export const AssistantMessageEventSchema = z.object({
	kind: z.literal("assistant_message"),
	text: z.string(),
	/** PRD-060a: optional per-turn token + cache counts; absent when unavailable. */
	usage: TurnUsageSchema,
});

/** The normalized event: a discriminated union over `kind` (FR-2). */
export const CaptureEventSchema = z.discriminatedUnion("kind", [
	UserMessageEventSchema,
	ToolCallEventSchema,
	AssistantMessageEventSchema,
]);

/**
 * Session metadata threaded onto every row (FR-5). `org` + `workspace` are the
 * tenancy scope (required — capture must stay inside the right tenant); `path`
 * groups the conversation (FR-6); the rest is provenance for later extraction.
 *
 * `isTurnTerminating` lets the shim mark the turn-terminating event (e.g. a Stop
 * hook) so the handler bumps the per-turn counters (FR-8). It defaults to false
 * so a mid-turn event never trips the counter.
 */
export const CaptureMetadataSchema = z.object({
	/** The harness session id (provenance + the transcript path convention). */
	sessionId: nonEmpty,
	/** Conversation grouping key (FR-6): rows sharing a `path` are one conversation. */
	path: nonEmpty,
	/** The working directory the turn ran in (FR-5). */
	cwd: z.string().default(""),
	/** The harness permission mode for the turn (FR-5). */
	permissionMode: z.string().default(""),
	/** The hook event name that produced this capture (FR-5). */
	hookEventName: z.string().default(""),
	/** The agent scope for the row (engine-table `agent_id`, FR-5). */
	agentId: z.string().default("default"),
	/** The resolved org tenancy (FR-5). Required — no unscoped capture. */
	org: nonEmpty,
	/** The resolved workspace partition (FR-5). Required. */
	workspace: nonEmpty,
	/** The capturing agent label (provenance; e.g. `claude-code`). */
	agent: z.string().default(""),
	/** The plugin version that captured the event (provenance). */
	pluginVersion: z.string().default(""),
	/** True on the turn-terminating event → bump per-turn counters (FR-8). */
	isTurnTerminating: z.boolean().default(false),
});

/** The full capture request body: one event + its session metadata. */
export const CaptureRequestSchema = z.object({
	event: CaptureEventSchema,
	metadata: CaptureMetadataSchema,
});

/** PRD-060a: a validated, normalized per-turn usage block (all fields optional). */
export type TurnUsage = NonNullable<z.infer<typeof TurnUsageSchema>>;
/** A validated, normalized capture event. */
export type CaptureEvent = z.infer<typeof CaptureEventSchema>;
/** Validated session metadata. */
export type CaptureMetadata = z.infer<typeof CaptureMetadataSchema>;
/** A validated capture request. */
export type CaptureRequest = z.infer<typeof CaptureRequestSchema>;

/**
 * Parse + validate an untrusted request body into a {@link CaptureRequest}.
 * Returns a discriminated result rather than throwing so the handler maps a
 * validation failure to a 400 without a try/catch around the boundary (the
 * stinger's no-bare-catch posture). `zod`'s `safeParse` is the boundary.
 */
export function parseCaptureRequest(
	body: unknown,
): { ok: true; value: CaptureRequest } | { ok: false; error: string } {
	const parsed = CaptureRequestSchema.safeParse(body);
	if (parsed.success) return { ok: true, value: parsed.data };
	// Flatten zod's issue list into one compact, log-safe message (no payload echo).
	const issues = parsed.error.issues
		.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
		.join("; ");
	return { ok: false, error: issues };
}

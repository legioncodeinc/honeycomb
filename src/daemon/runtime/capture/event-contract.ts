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
 * ── ZERO-fill on persist (a-AC-6 REVERSED, 2026-07-16) ───────────────────────
 * The normalized `usage` block still models "absent" as the field (or the whole
 * object) simply not being there — a partial block carries only the counts the
 * harness saw. But the PERSISTED columns can no longer keep absent distinct from a
 * measured 0: pg-deeplake maps a scalar SQL column to a NON-NULLABLE deeplake type,
 * so an omitted token column is rejected at flush ("None value for scalar type")
 * rather than stored as SQL NULL. The capture writer (`usageColumns`) therefore
 * zero-fills every absent count and the columns are `NOT NULL DEFAULT 0`. Each count
 * is a NON-NEGATIVE integer; a negative or fractional value is a malformed count and
 * is rejected at this boundary (the writer then treats it as absent → 0).
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
 *
 * PRD-060 ROI fix: it ALSO additively carries the optional per-turn `model` id (e.g.
 * `claude-opus-4-8`), read from the Claude Code transcript so the dashboard prices the
 * turn at its REAL model's rate instead of the Sonnet default. The field is OPTIONAL and
 * mirrors the usage-absent discipline: an EMPTY/whitespace model is normalized to ABSENT
 * (no empty-string persistence), so a model-less turn round-trips with the field absent.
 */
export const AssistantMessageEventSchema = z.object({
	kind: z.literal("assistant_message"),
	text: z.string(),
	/** PRD-060a: optional per-turn token + cache counts; absent when unavailable. */
	usage: TurnUsageSchema,
	/**
	 * PRD-060 ROI fix: the optional per-turn model id. A blank/whitespace value is treated as
	 * ABSENT (transformed to `undefined`) so an empty string is never persisted — the column
	 * stays `''` = "model unknown" rather than carrying a meaningless empty model.
	 */
	model: z
		.string()
		.optional()
		.transform((m) => (m !== undefined && m.trim() !== "" ? m.trim() : undefined)),
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
/**
 * PRD-074b: the narrowed `tool_call` variant, the input to `proseForToolCall`.
 * `CaptureEvent` is a discriminated union; this alias narrows to the `tool_call` arm
 * so the prose extractor's signature is typed (no `any` at the boundary — stinger
 * Hard Rule #4).
 */
export type ToolCallEvent = Extract<CaptureEvent, { kind: "tool_call" }>;
/** Validated session metadata. */
export type CaptureMetadata = z.infer<typeof CaptureMetadataSchema>;
/** A validated capture request. */
export type CaptureRequest = z.infer<typeof CaptureRequestSchema>;

// ── PRD-074: the derived prose form of an event ───────────────────────────────
//
// `sessions.message` is a JSONB blob that recall used to cast to `::text` and ship
// verbatim — escaped quotes, the `{event, metadata, response, file}` nesting, and
// all. PRD-074 adds a dedicated `prose` TEXT column populated at capture time from
// the typed CaptureEvent (no JSONB re-parse). Recall's lexical arm matches + returns
// `prose` (with a COALESCE fallback to `message::text` for legacy rows). The full
// structured envelope stays in `message` JSONB for downstream parsers
// (`summaries/worker.ts`, `skillify/miner.ts`, the dashboard rowToCapturedTurn) — no
// information is lost; `prose` is a deliberate, lossy, match-ready reduction.
//
// Sibling to `embedTextFor` (capture-handler.ts) in spirit, divergent in detail: the
// embedder benefits from raw joined text (its tokenizer handles noise); the
// lexical-match/harness path benefits from the file-path-aware line 1 (matches
// `dashboard.tsx` queries) and the bounded response (caps token cost). Do NOT
// collapse them — see PRD-074b "Relationship to embedTextFor".

/**
 * PRD-074b (b-AC-5 / m-AC-5): the named, tunable cap on a `tool_call`'s response line.
 * A `Read` of a 10-KB file, a `Bash` with multi-KB stdout, an `Edit` with a 500-line
 * diff — each is bounded to this many chars (after whitespace collapse) so the prose
 * row never re-creates the JSONB bloat PRD-074 exists to kill. The full response
 * survives in `message` JSONB for downstream parsers; `prose` is a recall-and-context
 * hint, not a content cache. Conservative default (500); tunable without code surgery
 * (PRD-074 open question recommends measuring a real corpus to set it to the 90th
 * percentile). Exported so a test asserts the cap against THIS named constant, not a
 * magic number.
 */
export const TOOL_PROSE_RESPONSE_CAP = 500 as const;

/**
 * PRD-074a (a-AC-3): the prose form of a captured event, derived purely from the typed
 * {@link CaptureEvent} the handler already holds (the zod boundary validated it). Pure,
 * synchronous, no IO — same shape as `embedTextFor`.
 *
 * - `user_message` / `assistant_message` → `event.text` VERBATIM (no cap, no collapse).
 *   These are already clean harness-bound text; their prose IS their text.
 * - `tool_call` → the file-path-aware bounded format defined by {@link proseForToolCall}
 *   (PRD-074b): `${tool} → ${shortPath}${range}` line 1, capped-response line 2.
 */
export function proseForEvent(event: CaptureEvent): string {
	switch (event.kind) {
		case "user_message":
		case "assistant_message":
			// b-AC-8 / L-D2: verbatim, no transformation. event.text is already the
			// harness-bound prose; capping or collapsing it would be a silent cut.
			return event.text;
		case "tool_call":
			return proseForToolCall(event);
	}
}

/**
 * PRD-074b: the `tool_call` prose format — line 1 carries the tool + a compact target
 * identifier (file path / command) so a search for `dashboard.tsx` or `git log` matches;
 * line 2 carries a whitespace-collapsed, capped response snippet so the harness sees
 * enough signal to decide whether to drill deeper. Omit line 2 when no response.
 *
 * Pure, synchronous, no IO. Per-AC behavior:
 * - b-AC-2 / L-B4 (file_path): `${tool} → ${shortPath}${rangeSuffix}` — Read/Edit/Write.
 * - b-AC-3 / L-B4 (command):    `${tool}: ${truncate(command, 80)}` — Bash/shell.
 * - b-AC-4 / L-B4 (else path):  `${tool}` for a generic `path`, else bare `${tool}`.
 * - b-AC-5..7 / L-B3 / L-B5:    response line whitespace-collapsed + capped at
 *   {@link TOOL_PROSE_RESPONSE_CAP} with `…`; per-tool extractor picks the body.
 * - b-AC-9 / L-B6: Windows backslashes preserved as-is (no re-escaping).
 */
export function proseForToolCall(event: ToolCallEvent): string {
	const firstLine = toolCallFirstLine(event);
	const body = extractResponseBody(event.response);
	if (body === null) return firstLine; // no response → line 1 alone is the prose.
	return `${firstLine}\n${truncate(body, TOOL_PROSE_RESPONSE_CAP)}`;
}

/**
 * The first line of a `tool_call`'s prose: the tool + a compact target. The shape
 * depends on whether `input` carries a path-like field (PRD-074b table). `input` is
 * schemaless per-tool JSON (`z.unknown()` at the boundary), so every access narrows
 * through `typeof`/`instanceof` — never a bare `(event.input as any).file_path`.
 */
function toolCallFirstLine(event: ToolCallEvent): string {
	const tool = event.tool;
	const input = event.input;
	// `file_path` (Read/Edit/Write/MultiEdit): path + the optional Read pagination suffix.
	const filePath = recordField(input, "file_path");
	if (typeof filePath === "string") {
		const range = rangeSuffix(input);
		return `${tool} → ${shortPath(filePath)}${range}`;
	}
	// `path` (generic file/path tools): path only, no pagination.
	const path = recordField(input, "path");
	if (typeof path === "string") {
		return `${tool} → ${shortPath(path)}`;
	}
	// `command` (Bash/shell): the command, whitespace-collapsed + capped at 80.
	const command = recordField(input, "command");
	if (typeof command === "string") {
		return `${tool}: ${truncate(command, 80)}`;
	}
	// No recognizable target: the tool name alone.
	return `${tool}`;
}

/**
 * The Read pagination suffix `:${offset}-${offset+limit}` (e.g. `:175-250`), appended
 * to the first line when BOTH `offset` and `limit` are present on `input`. Empty when
 * either is absent or non-numeric (a non-Read tool, or a Read without pagination).
 */
function rangeSuffix(input: unknown): string {
	const offset = recordField(input, "offset");
	const limit = recordField(input, "limit");
	if (typeof offset !== "number" || !Number.isFinite(offset)) return "";
	if (typeof limit !== "number" || !Number.isFinite(limit)) return "";
	return `:${offset}-${offset + limit}`;
}

/**
 * The response body for line 2 — best-effort per-tool-shape extraction (PRD-074b):
 *   - `response.file.content` (Read)         → string content
 *   - `response.stdout` (Bash)               → string stdout
 *   - `response` is a string                 → the string directly
 *   - `response` is an object with no
 *     recognized content field               → `JSON.stringify(response)`
 *   - `response` absent / null / undefined   → `null` (omit line 2)
 * `response` is schemaless (`z.unknown()`), so every access narrows defensively.
 */
function extractResponseBody(response: unknown): string | null {
	if (response === undefined || response === null) return null;
	if (typeof response === "string") return response;
	if (typeof response === "object") {
		const fileContent = recordField(response, "file");
		const content = typeof fileContent === "object" && fileContent !== null ? recordField(fileContent, "content") : undefined;
		if (typeof content === "string") return content;
		const stdout = recordField(response, "stdout");
		if (typeof stdout === "string") return stdout;
		try {
			return JSON.stringify(response);
		} catch {
			// A non-serializable object (a cycle) contributes nothing — never throw.
			return null;
		}
	}
	return null;
}

/**
 * PRD-074b: shorten a long absolute path to its last three segments + basename
 * (e.g. `C:\Users\mario\GitHub\the-apiary\hive\src\dashboard\web\pages\dashboard.tsx`
 * → `web\pages\dashboard.tsx`). Windows backslashes are preserved AS-IS (b-AC-9 /
 * L-B6): re-escaping them to double-backslashes is precisely the JSONB-cast bloat this
 * PRD eliminates. Splits on BOTH `/` and `\` so a POSIX path on a Windows host (or vice
 * versa) still shortens correctly.
 */
function shortPath(p: string): string {
	const parts = p.split(/[\\/]/).filter((s) => s.length > 0);
	if (parts.length <= 3) return p;
	return parts.slice(-3).join(detectSeparator(p));
}

/** The dominant separator in `p` (preserved when re-joining the shortened segments). */
function detectSeparator(p: string): string {
	const backslashes = (p.match(/\\/g) ?? []).length;
	const forward = (p.match(/\//g) ?? []).length;
	return backslashes >= forward ? "\\" : "/";
}

/**
 * PRD-074b: collapse runs of whitespace to single spaces and truncate to `n` chars
 * with a `…` marker when the result overflows. The collapse runs FIRST (so a 10-KB file
 * with leading indentation doesn't waste the cap on whitespace), then the cap. A string
 * already at-or-under `n` survives unchanged (no marker appended).
 */
function truncate(s: string, n: number): string {
	const collapsed = s.replace(/\s+/g, " ").trim();
	if (collapsed.length <= n) return collapsed;
	return `${collapsed.slice(0, n)}…`;
}

/**
 * Read a property off an `unknown` record defensively (the per-tool `input`/`response`
 * are `z.unknown()` at the boundary). Returns `undefined` for a non-record or a missing
 * key — never throws, so a malformed payload degrades to "no recognized field" rather
 * than crashing the capture hot path.
 */
function recordField(obj: unknown, key: string): unknown {
	if (typeof obj !== "object" || obj === null) return undefined;
	return (obj as Record<string, unknown>)[key];
}

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

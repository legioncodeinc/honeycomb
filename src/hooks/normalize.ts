/**
 * Shared shim override-plumbing — PRD-019c Wave 2 (FR-1 / FR-2 / FR-10 / c-AC-1 / c-AC-5).
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
 * c-AC-1 demands every harness produce the SAME normalized {@link HookInput} (and
 * therefore the SAME daemon-written rows) as the Claude Code REFERENCE. The only
 * honest way to GUARANTEE that — not merely assert it test-by-test — is for every
 * shim to share ONE normalization engine, parameterized by the per-harness
 * divergences. So the engine lives HERE, once; each `src/hooks/<harness>/shim.ts`
 * is a thin {@link ShimSpec} config (event-map + channel + host-CLI + the handful
 * of payload extractors that genuinely differ).
 *
 * This is the literal embodiment of the thesis "A SHIM IS A THIN OVERRIDE, NOT A
 * FORK" (contracts.ts): the shared logic is shared; only the divergences are
 * per-harness. It also keeps the six near-identical shim files from tripping jscpd
 * (threshold 7) — the duplicated plumbing exists in exactly one place.
 *
 * ── THIN CLIENT ─────────────────────────────────────────────────────────────
 * No memory logic, no SQL, no DeepLake here. This module ONLY normalizes a native
 * event into {@link HookInput} and routes the core's rendered block into the
 * harness's channel envelope. The daemon call happens in the 019b shared core via
 * the injected `DaemonHookClient` seam — `src/hooks` is a NON_DAEMON_ROOT.
 */

import {
	type ContextChannel,
	type ContextEnvelope,
	type HarnessShim,
	type HostCli,
	type NativeEvent,
} from "./contracts.js";
import type { HookInput, HookSessionMeta, LogicalEvent, RuntimePath } from "./shared/contracts.js";

/**
 * The per-harness divergence config (FR-2). Everything a shim overrides relative to
 * the reference, and NOTHING else. {@link createShim} turns one of these into a
 * full {@link HarnessShim} whose `mapEvent`/`normalize`/`renderContext` are the
 * SHARED engine — so two specs with the same `eventMap` + `extractData` produce
 * byte-identical {@link HookInput}s (the c-AC-1 guarantee).
 */
export interface ShimSpec {
	/** The harness id (e.g. `claude-code`, `codex`). */
	readonly harness: string;
	/** The runtime path stamped on every daemon call (FR-10): `plugin`/`legacy`. */
	readonly runtimePath: RuntimePath;
	/** The context-injection channel (FR-10 / c-AC-5). */
	readonly contextChannel: ContextChannel;
	/** The host CLI for detached summaries (FR-2 / 019b FR-6). */
	readonly hostCli: HostCli;
	/** The `references/<harness>/` citation (FR-11 / D-3 / c-AC-6). */
	readonly references: string;
	/** Native event name → logical event (FR-1). The ONLY event vocabulary divergence. */
	readonly eventMap: Readonly<Record<string, LogicalEvent>>;

	/**
	 * Lower a harness's native payload into the normalized {@link HookInput.data}
	 * (FR-2). This is the one genuinely per-harness step: each harness names its
	 * payload fields differently. It returns the SAME canonical `{ kind, ... }`
	 * shape the daemon's capture boundary expects, so the normalized output is
	 * harness-independent (c-AC-1). Returns `undefined` to drop a non-lifecycle
	 * event (e.g. a tool the harness filters out — Hermes terminal-only tools).
	 *
	 * `raw` is `event.payload` (the harness's native body); `logical` is the mapped
	 * logical event; `meta` is the resolved session metadata (already merged with
	 * any harness-specific provenance via {@link deriveMeta}).
	 */
	extractData(raw: unknown, logical: LogicalEvent, meta: HookSessionMeta): unknown | undefined;

	/**
	 * OPTIONAL: derive harness-specific session metadata from the native payload
	 * before normalization (FR-4 / FR-5). OpenClaw auto-routes the agent from the
	 * session key (`agent:alice:...`); Cursor reads cwd from `workspace_roots`. The
	 * default merges nothing. Returns the FULL meta the daemon call carries.
	 */
	deriveMeta?(raw: unknown, base: HookSessionMeta): HookSessionMeta;

	/**
	 * OPTIONAL: hand the session-start hygiene pulls to a detached child process. See
	 * {@link HarnessShim.spawnHygieneChild} for the full rationale. When a spec supplies
	 * this, `createShim` surfaces it on the resulting {@link HarnessShim}, and
	 * `runSessionStart` calls it INSTEAD of the three in-process hygiene seams. ABSENT
	 * → the shim does not opt into the off-process path and the runtime runs the
	 * hygiene in-process (the prior behavior).
	 */
	spawnHygieneChild?(meta: HookSessionMeta): void;

	/**
	 * OPTIONAL: condense the rendered context block for the `user-visible` channel
	 * (c-AC-4 / c-AC-5). Codex injects ONLY a brief login-state line, not the full
	 * block. The default passes the block through verbatim. Ignored for `model-only`.
	 */
	renderUserVisible?(block: string): string;
}

/**
 * Turn a {@link ShimSpec} into a full {@link HarnessShim} (FR-1 / FR-2). The
 * returned shim's `mapEvent`, `normalize`, and `renderContext` are the SHARED
 * engine — every harness runs the identical normalization, so the only thing that
 * can differ across harnesses is what the spec declares. This is what makes the
 * c-AC-1 equivalence STRUCTURAL rather than coincidental.
 */
export function createShim(spec: ShimSpec): HarnessShim {
	return {
		harness: spec.harness,
		runtimePath: spec.runtimePath,
		contextChannel: spec.contextChannel,
		hostCli: spec.hostCli,
		references: spec.references,
		mapEvent(nativeName: string): LogicalEvent | undefined {
			return spec.eventMap[nativeName];
		},
		normalize(event: NativeEvent, meta: HookSessionMeta): HookInput | undefined {
			const logical = spec.eventMap[event.name];
			if (logical === undefined) return undefined; // non-lifecycle event → dropped.

			const fullMeta = deriveMeta(spec, event.payload, meta);
			const data = spec.extractData(event.payload, logical, fullMeta);
			if (data === undefined) return undefined; // harness filtered this event out.

			const embedding = extractEmbedding(event.payload);
			return {
				event: logical,
				// `agent` carries the CANONICAL HARNESS identity (`spec.harness` — the same token
				// `harness-registry.CANONICAL_SHIMS` derives the six from), stamped here so EVERY
				// harness attributes its captured turns to itself in `sessions.agent` (the column
				// the Harnesses page GROUPs BY). The honest source: the shim that emits the event
				// names its own harness. Stamped AFTER `...fullMeta` so the harness identity is
				// authoritative — a per-harness `deriveMeta` that routes the per-USER agent must use
				// `agentId` (the engine scope), never overwrite this harness token.
				meta: { ...fullMeta, agent: spec.harness, hookEventName: event.name },
				data,
				...(embedding !== undefined ? { messageEmbedding: embedding } : {}),
				runtimePath: spec.runtimePath,
			};
		},
		renderContext(block: string): ContextEnvelope {
			return renderChannel(spec, block);
		},
		// Surface the optional off-process hygiene hook only when the spec supplies it.
		...(spec.spawnHygieneChild !== undefined ? { spawnHygieneChild: spec.spawnHygieneChild } : {}),
	};
}

/** Apply the spec's `deriveMeta` (or pass the base through unchanged). */
function deriveMeta(spec: ShimSpec, raw: unknown, base: HookSessionMeta): HookSessionMeta {
	return spec.deriveMeta ? spec.deriveMeta(raw, base) : base;
}

/** Route the rendered block into the spec's channel envelope (FR-10 / c-AC-5). */
function renderChannel(spec: ShimSpec, block: string): ContextEnvelope {
	if (spec.contextChannel === "model-only") {
		return { channel: "model-only", additionalContext: block };
	}
	const text = spec.renderUserVisible ? spec.renderUserVisible(block) : block;
	return { channel: "user-visible", text };
}

/** Pull a per-message embedding off a native payload when the harness computed one (FR-4). */
function extractEmbedding(raw: unknown): readonly number[] | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const value = (raw as Record<string, unknown>).messageEmbedding;
	if (Array.isArray(value) && value.every((n) => typeof n === "number")) {
		return value as readonly number[];
	}
	return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical payload extractors — the SAME `{ kind, ... }` shapes the reference
// produces. Shims reuse these so two harnesses naming the same field differently
// still normalize to byte-identical data (c-AC-1). A harness whose native field
// names differ passes its OWN accessor; the canonical SHAPE stays fixed here.
// ─────────────────────────────────────────────────────────────────────────────

/** Coerce a native payload to a record (or an empty record for a non-object). */
export function asRecord(raw: unknown): Record<string, unknown> {
	return raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

/** Read the first present string field from a native payload, by candidate key order. */
export function pickString(raw: unknown, ...keys: readonly string[]): string {
	const rec = asRecord(raw);
	for (const key of keys) {
		const value = rec[key];
		if (typeof value === "string") return value;
	}
	return "";
}

/** Read the raw nested value at `obj[key]` (unknown), or `undefined`. */
export function nested(raw: unknown, key: string): unknown {
	if (raw !== null && typeof raw === "object") return (raw as Record<string, unknown>)[key];
	return undefined;
}

/** Read a nested string at `obj[a][b]`, or `undefined` (the tool_input field reader). */
export function nestedString(raw: unknown, a: string, b: string): string | undefined {
	const outer = nested(raw, a);
	if (outer !== null && typeof outer === "object") {
		const value = (outer as Record<string, unknown>)[b];
		if (typeof value === "string") return value;
	}
	return undefined;
}

/** The canonical `user_message` data shape (the reference's). */
export function userMessageData(text: string): unknown {
	return { kind: "user_message", text };
}

/**
 * The four normalized per-turn token + cache counts (PRD-060a a-AC-1 / a-AC-2).
 * Each is OPTIONAL: only the counts the harness actually saw are present. Mirrors
 * the daemon-side `TurnUsage` (`event-contract.ts`) — the shim lowers the harness's
 * native field names onto these canonical keys; the daemon's zod boundary validates.
 */
export interface NormalizedTurnUsage {
	readonly input?: number;
	readonly output?: number;
	readonly cacheRead?: number;
	readonly cacheCreation?: number;
}

/**
 * The canonical `assistant_message` data shape (the reference's). PRD-060a (a-AC-1):
 * when the harness extracted a per-turn `usage` block, it rides along on the SAME
 * event object. ABSENT/empty usage is OMITTED entirely (never zero-filled) so a
 * turn with no usage round-trips with the field absent (a-AC-1 / a-AC-6) and the
 * downstream columns stay NULL = "token data absent" rather than a silent 0.
 *
 * PRD-060 ROI fix: `model` is the optional per-turn model id (e.g. `claude-opus-4-8`),
 * read from the Claude Code transcript alongside `usage`. It rides on the SAME canonical
 * event so the daemon persists it onto the row and the dashboard prices the turn at its
 * real model's rate (an Opus turn at the Opus row, not the Sonnet default). ABSENT/empty
 * `model` is OMITTED entirely — never an empty string — so a model-less turn round-trips
 * with the field absent and the downstream column stays `''` = "model unknown".
 */
export function assistantMessageData(text: string, usage?: NormalizedTurnUsage, model?: string): unknown {
	const normalized = usage !== undefined ? compactUsage(usage) : undefined;
	const trimmedModel = typeof model === "string" ? model.trim() : "";
	return {
		kind: "assistant_message",
		text,
		...(normalized !== undefined ? { usage: normalized } : {}),
		...(trimmedModel !== "" ? { model: trimmedModel } : {}),
	};
}

/**
 * Drop absent counts and the whole block when EMPTY (PRD-060a a-AC-2 / a-AC-6).
 * Returns `undefined` when no count survived — so an all-absent usage block is
 * omitted from the event rather than serialized as `{}` (which would still read as
 * "present but empty"). A genuine `0` SURVIVES (a real measurement, distinct from
 * absent — the zero-vs-null rule), so it is carried through to the column verbatim.
 */
function compactUsage(usage: NormalizedTurnUsage): NormalizedTurnUsage | undefined {
	const out: { input?: number; output?: number; cacheRead?: number; cacheCreation?: number } = {};
	if (isCount(usage.input)) out.input = usage.input;
	if (isCount(usage.output)) out.output = usage.output;
	if (isCount(usage.cacheRead)) out.cacheRead = usage.cacheRead;
	if (isCount(usage.cacheCreation)) out.cacheCreation = usage.cacheCreation;
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Is `n` a valid, present token count? A non-negative finite integer. A malformed
 * count (negative, fractional, NaN, or a non-number that slipped through) is NOT a
 * count — it is dropped here so the column stays NULL ("token data absent"), never
 * a silent 0 (a-AC-6). A genuine measured `0` passes (zero ≠ absent).
 */
function isCount(n: number | undefined): n is number {
	return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/**
 * Extract the per-message token/cache `usage` block from a harness's native
 * assistant payload (PRD-060a a-AC-2). Claude Code writes the per-message `usage`
 * to its transcript JSONL with `input_tokens` / `output_tokens` /
 * `cache_read_input_tokens` / `cache_creation_input_tokens`; the hook payload
 * surfaces that block either at the top level (`usage`) or nested under the
 * assistant `message` (`message.usage`) depending on the lifecycle wiring, so both
 * shapes are probed. ABSENT / non-object usage → `undefined` (the field is omitted
 * downstream, NOT zero-filled). A present-but-partial block keeps only the counts
 * it carried; a malformed count is dropped by {@link compactUsage}/{@link isCount}.
 */
export function extractTurnUsage(raw: unknown): NormalizedTurnUsage | undefined {
	const block = usageBlock(raw);
	if (block === undefined) return undefined;
	const usage: NormalizedTurnUsage = {
		...(readCount(block, "input_tokens") !== undefined ? { input: readCount(block, "input_tokens") } : {}),
		...(readCount(block, "output_tokens") !== undefined ? { output: readCount(block, "output_tokens") } : {}),
		...(readCount(block, "cache_read_input_tokens") !== undefined
			? { cacheRead: readCount(block, "cache_read_input_tokens") }
			: {}),
		...(readCount(block, "cache_creation_input_tokens") !== undefined
			? { cacheCreation: readCount(block, "cache_creation_input_tokens") }
			: {}),
	};
	// All counts absent/malformed → no usage data (omit the whole block).
	return compactUsage(usage);
}

/** Find the `usage` object on a native payload — top-level `usage` or `message.usage`. */
function usageBlock(raw: unknown): Record<string, unknown> | undefined {
	const top = nested(raw, "usage");
	if (top !== null && typeof top === "object") return top as Record<string, unknown>;
	const inner = nestedRecord(nested(raw, "message"), "usage");
	return inner;
}

/** Read `obj[key].inner` as a record, or `undefined`. */
function nestedRecord(obj: unknown, key: string): Record<string, unknown> | undefined {
	if (obj !== null && typeof obj === "object") {
		const value = (obj as Record<string, unknown>)[key];
		if (value !== null && typeof value === "object") return value as Record<string, unknown>;
	}
	return undefined;
}

/**
 * Read one native count field as a non-negative integer, or `undefined`. A missing,
 * non-numeric, negative, or fractional value yields `undefined` (the field is
 * dropped → the column stays NULL, never a silent 0). A genuine `0` is returned
 * (zero ≠ absent — the a-AC-6 distinction).
 */
function readCount(block: Record<string, unknown>, key: string): number | undefined {
	const value = block[key];
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
	return value;
}

/** The canonical `tool_call` data shape (the reference's). */
export function toolCallData(tool: string, input: unknown, response: unknown): unknown {
	return { kind: "tool_call", tool, input, response };
}

/** The canonical `session-start` data shape (the reference's). */
export function sessionStartData(source: string): unknown {
	return { kind: "session_start", source };
}

/** The canonical `session-end` data shape (the reference's). */
export function sessionEndData(reason: string): unknown {
	return { kind: "session_end", reason };
}

/** The canonical pre-tool-use data shape — the {@link PreToolPayload} the core lowers. */
export function preToolData(tool: string, fields: { command?: string; path?: string; query?: string }): unknown {
	return {
		kind: "pre_tool_use",
		tool,
		...(fields.command !== undefined ? { command: fields.command } : {}),
		...(fields.path !== undefined ? { path: fields.path } : {}),
		...(fields.query !== undefined ? { query: fields.query } : {}),
	};
}

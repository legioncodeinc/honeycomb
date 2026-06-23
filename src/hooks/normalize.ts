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

/** The canonical `assistant_message` data shape (the reference's). */
export function assistantMessageData(text: string): unknown {
	return { kind: "assistant_message", text };
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

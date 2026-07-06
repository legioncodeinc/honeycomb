/**
 * Claude Code REFERENCE shim — PRD-019c Wave 2 (FR-1 / D-4 / c-AC-1).
 *
 * Claude Code is the REFERENCE shim (FR-1 / D-4): marketplace plugin + hooks + MCP.
 * It implements the FULL six-event lifecycle against the shared core (019b) —
 * `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
 * `Stop`/`SubagentStop`, `SessionEnd` — and is the BASELINE every other shim's test
 * asserts equivalence to (c-AC-1: each harness produces the SAME daemon-written rows
 * as this reference). Its `extractData` defines the CANONICAL `{ kind, ... }` data
 * shapes (via the shared `normalize` extractors) every other shim normalizes onto.
 *
 * Channel: `model-only` (`additionalContext`). Runtime path: `legacy` (hook scripts).
 * Host CLI: `claude -p` (FR-2 / 019b FR-6).
 *
 * References gate (FR-11 / D-3 / c-AC-6): the native event names + hook payload shapes
 * implemented here are the Claude Code hooks protocol — `SessionStart`,
 * `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`/`SubagentStop`, `SessionEnd`
 * (cited at `references/claude-code/`).
 *
 * THIN OVERRIDE: this shim maps event names + normalizes payloads via the shared
 * `createShim` engine; the shared core owns the lifecycle. No SQL, no DeepLake (D-2).
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ContextChannel, HarnessShim, HostCli, RuntimePath } from "../contracts.js";
import {
	assistantMessageData,
	createShim,
	extractTurnUsage,
	nested,
	nestedString,
	pickString,
	preToolData,
	sessionEndData,
	sessionStartData,
	toolCallData,
	userMessageData,
} from "../normalize.js";
import { readTranscriptTurnUsage } from "./transcript.js";
import type { HookSessionMeta, LogicalEvent } from "../shared/contracts.js";

/** The Claude Code native → logical event name map (FR-1). The full six-event reference. */
export const CLAUDE_CODE_EVENT_MAP: Readonly<Record<string, LogicalEvent>> = {
	SessionStart: "session-start",
	UserPromptSubmit: "user_message",
	PreToolUse: "pre-tool-use",
	PostToolUse: "tool_call",
	Stop: "assistant_message",
	SubagentStop: "assistant_message",
	SessionEnd: "session-end",
};

/** Claude Code injects context model-only via `additionalContext` (FR-10). */
export const CLAUDE_CODE_CONTEXT_CHANNEL: ContextChannel = "model-only";

/** Claude Code stamps the `legacy` runtime path (hook scripts, FR-10). */
export const CLAUDE_CODE_RUNTIME_PATH: RuntimePath = "legacy";

/** Claude Code shells `claude -p` for detached summaries (FR-2 / 019b FR-6). */
export const CLAUDE_CODE_HOST_CLI: HostCli = { bin: "claude", args: ["-p"] };

/** The references-gate citation (FR-11 / D-3 / c-AC-6). */
export const CLAUDE_CODE_REFERENCES = "references/claude-code/" as const;

/**
 * Lower a Claude Code native hook payload into the CANONICAL normalized data shape
 * (FR-2). This is the REFERENCE extractor every other shim's `extractData` must
 * produce the SAME output as (c-AC-1). The Claude Code payload uses
 * `prompt`/`tool_name`/`tool_input`/`tool_response`/`source`/`reason` — the shared
 * `*.Data` builders return the harness-independent `{ kind, ... }` shapes.
 *
 * `meta` carries the resolved session metadata — in particular `meta.path`, the
 * `transcript_path` the binary driver derived. The `assistant_message` branch reads the
 * per-turn `usage` + `model` from THAT transcript (see {@link readTranscriptTurnUsage}),
 * because the Claude Code `Stop` hook payload carries neither.
 */
export function claudeCodeExtractData(raw: unknown, logical: LogicalEvent, meta: HookSessionMeta): unknown | undefined {
	switch (logical) {
		case "session-start":
			return sessionStartData(pickString(raw, "source") || "startup");
		case "user_message":
			return userMessageData(pickString(raw, "prompt", "text", "message"));
		case "pre-tool-use":
			return preToolData(pickString(raw, "tool_name", "tool"), {
				command: nestedString(raw, "tool_input", "command"),
				path: nestedString(raw, "tool_input", "file_path") ?? nestedString(raw, "tool_input", "path"),
				query: nestedString(raw, "tool_input", "pattern") ?? nestedString(raw, "tool_input", "query"),
			});
		case "tool_call":
			return toolCallData(
				pickString(raw, "tool_name", "tool"),
				nested(raw, "tool_input"),
				nested(raw, "tool_response"),
			);
		case "assistant_message": {
			// PRD-060 ROI fix: the per-message token/cache `usage` AND the `model` live in the
			// Claude Code transcript JSONL at `meta.path` (the `transcript_path`), NOT in the `Stop`
			// hook payload. Read them from the transcript; fall back to the payload-level
			// `extractTurnUsage` for any wiring that DOES surface `usage` on the payload (and so a
			// transcript-read miss never regresses that path). Fail-soft: a missing/unreadable
			// transcript yields `{}` → usage + model omitted, never zero-filled (a-AC-6) and never a
			// thrown capture. A measured 0 survives (zero ≠ absent). The assistant TEXT is unchanged.
			const fromTranscript = readTranscriptTurnUsage(meta.path ?? "");
			const usage = fromTranscript.usage ?? extractTurnUsage(raw);
			return assistantMessageData(pickString(raw, "text", "message"), usage, fromTranscript.model);
		}
		case "session-end":
			return sessionEndData(pickString(raw, "reason") || "Stop");
		default:
			return undefined;
	}
}

/**
 * Construct the Claude Code REFERENCE shim (FR-1 / D-4). Built on the shared
 * `createShim` engine with the reference event map + the canonical `extractData`;
 * every other shim runs the SAME engine, so equivalence to this baseline is
 * structural (c-AC-1).
 */
export function createClaudeCodeShim(): HarnessShim {
	return createShim({
		harness: "claude-code",
		runtimePath: CLAUDE_CODE_RUNTIME_PATH,
		contextChannel: CLAUDE_CODE_CONTEXT_CHANNEL,
		hostCli: CLAUDE_CODE_HOST_CLI,
		references: CLAUDE_CODE_REFERENCES,
		eventMap: CLAUDE_CODE_EVENT_MAP,
		extractData(raw: unknown, logical: LogicalEvent, meta: HookSessionMeta): unknown | undefined {
			// Thread `meta` through: the assistant_message branch reads the per-turn usage + model
			// from the transcript at `meta.path` (the Stop hook payload carries neither).
			return claudeCodeExtractData(raw, logical, meta);
		},
		// Off-process hygiene: hand the session-start skills/assets/graph pulls to a DETACHED
		// CHILD so the parent hook binary does no in-process hygiene I/O and exits promptly
		// after writing its response. See `HarnessShim.spawnHygieneChild` for the full
		// rationale (the latency-budget + Windows-libuv-assertion fix).
		spawnHygieneChild(meta: HookSessionMeta): void {
			spawnClaudeCodeHygieneChild(meta);
		},
	});
}

/**
 * The env var the hygiene child reads the session metadata JSON from. Set by
 * {@link spawnClaudeCodeHygieneChild} before spawn; consumed by the
 * `harnesses/claude-code/src/hygiene.ts` child entry point.
 */
export const HYGIENE_META_ENV = "HONEYCOMB_HYGIENE_META" as const;

/**
 * Spawn the bundled hygiene child (`bundle/hygiene.js` next to this running `index.js`)
 * DETACHED + `unref()`'d, with the session metadata JSON in {@link HYGIENE_META_ENV}.
 *
 * The child inherits the parent's env (so HOME resolves the credential file the same
 * way) and gets `stdio: "ignore"` (the parent already owns stdout; the child's stderr
 * is dropped to keep Claude Code's hook output clean — a hygiene failure is
 * best-effort). `detached: true` puts the child in its own process group so it
 * survives the parent's exit; `unref()` lets the parent's event loop empty while the
 * child is still running. Never throws: a spawn failure is swallowed (best-effort).
 */
function spawnClaudeCodeHygieneChild(meta: HookSessionMeta): void {
	try {
		const childPath = resolveHygieneChildPath();
		if (childPath === undefined) return; // not running from the bundled binary — no-op.
		const child = spawn(process.execPath, [childPath], {
			detached: true,
			stdio: "ignore",
			env: {
				...process.env,
				[HYGIENE_META_ENV]: JSON.stringify({
					sessionId: meta.sessionId,
					path: meta.path,
					...(meta.cwd !== undefined ? { cwd: meta.cwd } : {}),
				}),
			},
		});
		child.unref();
		// Swallow any late 'error' event from the spawned child (best-effort; never throw).
		child.on?.("error", () => {});
	} catch {
		// Best-effort: a spawn failure never breaks the session (the next session-start tries again).
	}
}

/**
 * Resolve the absolute path to the bundled `hygiene.js` that sits next to THIS running
 * `index.js` under the harness bundle dir. Returns `undefined` when this shim is NOT
 * running from the bundled binary (a test imports the shim — no `import.meta.url` match
 * under `bundle/`), so the spawn becomes a no-op rather than a bad-path spawn.
 */
function resolveHygieneChildPath(): string | undefined {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		// The bundled binary lives at `<pluginRoot>/bundle/index.js`; the hygiene child ships
		// alongside it at `<pluginRoot>/bundle/hygiene.js`. Resolve relative to this file.
		const candidate = join(here, "hygiene.js");
		// Only return it when this file is actually AT a `bundle` dir (the bundled shape —
		// `dirname(.../bundle/index.js)` is `.../bundle`); an in-repo source file (a test) would
		// otherwise point at a non-existent dist path. Match either `/bundle/` (when nested) OR
		// a path that ENDS with `/bundle` (the common case: the bundle dir itself).
		const normalized = here.replace(/\\/g, "/");
		if (normalized.includes("/bundle/") || normalized.endsWith("/bundle")) return candidate;
		return undefined;
	} catch {
		return undefined;
	}
}

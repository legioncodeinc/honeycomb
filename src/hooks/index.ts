/**
 * Hook surface barrel — PRD-019b shared core + PRD-019c per-harness shims.
 *
 * Re-exports the shared core (`./shared`), the per-harness shim contract
 * (`./contracts`), the shared override-plumbing (`./normalize`), and all six
 * harness shims (Claude Code REFERENCE + Codex, Cursor, OpenClaw, Hermes, pi). Each
 * shim is a thin {@link ShimSpec} config over the shared `createShim` engine, so
 * every harness produces the SAME normalized `HookInput` as the reference (c-AC-1).
 * See `shared/CONVENTIONS.md` and `CONVENTIONS.md`.
 */

export * from "./shared/index.js";

export {
	type CliFallback,
	CONTEXT_CHANNELS,
	type ContextChannel,
	type ContextEnvelope,
	createFakeCliFallback,
	type HarnessShim,
	type HostCli,
	type NativeEvent,
} from "./contracts.js";

export {
	asRecord,
	assistantMessageData,
	createShim,
	pickString,
	preToolData,
	sessionEndData,
	sessionStartData,
	type ShimSpec,
	toolCallData,
	userMessageData,
} from "./normalize.js";

// ── Claude Code REFERENCE shim (FR-1 / D-4 / c-AC-1) ────────────────────────────
export {
	CLAUDE_CODE_CONTEXT_CHANNEL,
	CLAUDE_CODE_EVENT_MAP,
	CLAUDE_CODE_HOST_CLI,
	CLAUDE_CODE_REFERENCES,
	CLAUDE_CODE_RUNTIME_PATH,
	claudeCodeExtractData,
	createClaudeCodeShim,
} from "./claude-code/shim.js";

// ── Codex shim (FR-3 / c-AC-4) ──────────────────────────────────────────────────
export {
	CODEX_CONTEXT_CHANNEL,
	CODEX_EVENT_MAP,
	CODEX_HOST_CLI,
	CODEX_LOGIN_LINE,
	CODEX_REFERENCES,
	CODEX_RUNTIME_PATH,
	codexRenderUserVisible,
	codexSessionStartSetup,
	createCodexShim,
} from "./codex/shim.js";

// ── Cursor shim (FR-4) ──────────────────────────────────────────────────────────
export {
	CURSOR_CONTEXT_CHANNEL,
	CURSOR_CONTEXT_KEY,
	CURSOR_EVENT_MAP,
	CURSOR_HOST_CLI,
	CURSOR_REFERENCES,
	CURSOR_RUNTIME_PATH,
	createCursorShim,
	cursorDeriveMeta,
} from "./cursor/shim.js";

// ── OpenClaw shim (FR-5 / c-AC-3 / c-AC-2) ──────────────────────────────────────
export {
	createOpenClawShim,
	OPENCLAW_CONTEXT_CHANNEL,
	OPENCLAW_EVENT_MAP,
	OPENCLAW_HOST_CLI,
	OPENCLAW_REFERENCES,
	OPENCLAW_RUNTIME_PATH,
	openclawDeriveMeta,
	openclawExpandBatch,
	openclawGoalKpiFallback,
	type OpenClawMessage,
	openclawSliceSinceLastFlush,
} from "./openclaw/shim.js";

// ── Hermes shim (FR-6) ──────────────────────────────────────────────────────────
export {
	createHermesShim,
	HERMES_CONTEXT_CHANNEL,
	HERMES_EVENT_MAP,
	HERMES_HOST_CLI,
	HERMES_MCP_MENTION,
	HERMES_REFERENCES,
	HERMES_RUNTIME_PATH,
	hermesContextOutput,
	hermesRenderUserVisible,
} from "./hermes/shim.js";

// ── pi shim (FR-7 / c-AC-2) ─────────────────────────────────────────────────────
export {
	createPiShim,
	PI_CONTEXT_CHANNEL,
	PI_EVENT_MAP,
	PI_HOST_CLI,
	PI_REFERENCES,
	PI_RUNTIME_PATH,
	piAgentsBlock,
	piGoalKpiFallback,
	piResolveHostCli,
} from "./pi/shim.js";

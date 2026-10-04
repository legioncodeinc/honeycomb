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

// ── PRD-021c shared hook-binary stdin driver (c-AC-5 / c-AC-6) ──────────────────
export {
	type BinaryIo,
	type RunHookBinaryOptions,
	runHookBinary,
} from "./binary.js";
// ── Claude Code REFERENCE shim (FR-1 / D-4 / c-AC-1) ────────────────────────────
export {
	CLAUDE_CODE_CONTEXT_CHANNEL,
	CLAUDE_CODE_EVENT_MAP,
	CLAUDE_CODE_HOST_CLI,
	CLAUDE_CODE_RECALL_EVENT_MAP,
	CLAUDE_CODE_REFERENCES,
	CLAUDE_CODE_RUNTIME_PATH,
	type ClaudeUserPromptMode,
	claudeCodeExtractData,
	createClaudeCodeShim,
	detectClaudeUserPromptMode,
	RECALL_HOOK_ARG,
} from "./claude-code/shim.js";
// ── PRD-060 ROI fix: the Claude Code transcript reader (per-turn usage + model) ──
export {
	parseTurnUsage,
	readTranscriptTurnUsage,
	type TranscriptTurnUsage,
} from "./claude-code/transcript.js";
// ── Codex shim (FR-3 / c-AC-4) ──────────────────────────────────────────────────
export {
	CODEX_CONTEXT_CHANNEL,
	CODEX_EVENT_MAP,
	CODEX_HOST_CLI,
	CODEX_LOGIN_LINE,
	CODEX_REFERENCES,
	CODEX_RUNTIME_PATH,
	codexRenderHookResponse,
	codexRenderUserVisible,
	codexSessionStartSetup,
	createCodexShim,
} from "./codex/shim.js";
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
// ── Hermes shim ────────────────────────────────────────────────────────────────
export {
	createHermesShim,
	detectHermesHookMode,
	HERMES_CONTEXT_CHANNEL,
	HERMES_EVENT_MAP,
	HERMES_HOST_CLI,
	HERMES_RECALL_EVENT_MAP,
	HERMES_RECALL_HOOK_ARG,
	HERMES_REFERENCES,
	HERMES_RUNTIME_PATH,
	type HermesHookMode,
	hermesContextOutput,
	hermesRenderHookResponse,
	hermesRenderUserVisible,
} from "./hermes/shim.js";
export {
	asRecord,
	assistantMessageData,
	createShim,
	extractTurnUsage,
	type NormalizedTurnUsage,
	pickString,
	preToolData,
	type ShimSpec,
	sessionEndData,
	sessionStartData,
	toolCallData,
	userMessageData,
} from "./normalize.js";
// ── OpenClaw shim (FR-5 / c-AC-3 / c-AC-2) ──────────────────────────────────────
export {
	createOpenClawShim,
	OPENCLAW_CONTEXT_CHANNEL,
	OPENCLAW_EVENT_MAP,
	OPENCLAW_HARNESS,
	OPENCLAW_HOST_CLI,
	OPENCLAW_REFERENCES,
	OPENCLAW_RUNTIME_PATH,
	type OpenClawMessage,
	openclawDeriveMeta,
	openclawExpandBatch,
	openclawGoalKpiFallback,
	openclawSliceSinceLastFlush,
} from "./openclaw/shim.js";
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
// ── PRD-021c shared hook runtime (c-AC-5 / c-AC-6) ──────────────────────────────
export {
	createHookRuntime,
	type HookEventOutcome,
	type HookRuntime,
	type HookRuntimeOptions,
	type NativeHookEvent,
} from "./runtime.js";
export * from "./shared/index.js";

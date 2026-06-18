/**
 * Lifecycle hook shared-core barrel — PRD-019b (the agent-agnostic core).
 *
 * The public surface every per-harness shim (019c) and every connector handler
 * (019a) imports. The six logical events, the normalized {@link HookInput}, and
 * the seams (daemon / credentials / context / session-start / VFS / summary lock)
 * live in `contracts.ts`; the five core modules implement the per-event lifecycle.
 * Wave 2 (019b) fills the bodies; the contract signatures are STABLE + additive so
 * 019c maps onto them without contention. See CONVENTIONS.md first.
 */

export {
	createFakeContextRenderer,
	createFakeCredentialReader,
	createFakeDaemonHookClient,
	createFakeSessionStartSeams,
	createFakeSummaryLock,
	createFakeVfsIntercept,
	createNoopSessionStartSeams,
	type ContextRenderer,
	type ContextRenderRequest,
	type CredentialReader,
	type DaemonHookClient,
	type DaemonHookRequest,
	type DaemonHookResponse,
	type FakeDaemonHookClient,
	type FakeDaemonHookClientOptions,
	type FakeSessionStartSeams,
	type FakeSessionStartSeamsOptions,
	type FakeSummaryLock,
	type FakeSummaryLockOptions,
	type FakeVfsIntercept,
	type FakeVfsInterceptOptions,
	type HookCoreDeps,
	type HookCredential,
	type HookInput,
	HookInputSchema,
	type HookResult,
	type HookSessionMeta,
	HookSessionMetaSchema,
	type LogicalEvent,
	LOGICAL_EVENTS,
	notImplemented,
	type RecordedHookCall,
	type RecordedSessionStartStep,
	type RecordedVfsOp,
	type RuntimePath,
	type SessionStartDeps,
	type SessionStartSeams,
	type SummaryLock,
	type VfsIntercept,
	type VfsToolOp,
} from "./contracts.js";

export { runSessionStart } from "./session-start.js";

export {
	buildCaptureBody,
	CAPTURE_ENDPOINT,
	runCapture,
	runCaptureBatch,
	runCaptureGuarded,
	RUNTIME_PATH_CONFLICT,
	type CaptureGateContext,
	type CaptureGateEnv,
} from "./capture.js";

export {
	HARMLESS_ECHO,
	type PreToolDecision,
	type PreToolPayload,
	runPreToolUse,
	WRITE_DENY_GUIDANCE,
} from "./pre-tool-use.js";

export {
	createFakeSummarySpawn,
	runSessionEnd,
	SESSION_END_ENDPOINT,
	SUMMARY_REASON,
	type SummarySpawn,
} from "./session-end.js";

export { CONTEXT_ENDPOINT, createContextRenderer } from "./context-renderer.js";

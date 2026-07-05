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
	createFakePrimeRenderer,
	createFakeSessionStartSeams,
	createFakeSummaryLock,
	createFakeVfsIntercept,
	createNoopSessionStartSeams,
	type ContextRenderer,
	type ContextRenderRequest,
	type PrimeRenderer,
	type PrimeRenderRequest,
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
	type OnboardingNoticeGate,
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

export {
	BIND_PROJECT_CWD_NOTICE,
	BIND_PROJECT_NOTICE,
	createOnboardingNoticeGate,
	createSessionBindNoticeGate,
	runSessionStart,
} from "./session-start.js";

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

// ── PRD-046d session-start memory prime (d-AC-1..5) ─────────────────────────────
export {
	createPrimeRenderer,
	DEFAULT_PRIME_TIMEOUT_MS,
	type PrimeRendererOptions,
	PRIME_PATH,
} from "./prime-renderer.js";

// ── PRD-021c production seams (c-AC-1 / c-AC-2) ─────────────────────────────────
export {
	ACTOR_HEADER,
	createDaemonHookClient,
	type DaemonHookClientOptions,
	ORG_HEADER,
	RUNTIME_PATH_HEADER,
	SESSION_HEADER,
	WORKSPACE_HEADER,
} from "./daemon-client.js";

export {
	createCredentialReader,
	type CredentialReaderOptions,
	CREDENTIALS_DIR_NAME,
	CREDENTIALS_FILE_NAME,
	ENV_TOKEN,
} from "./credential-reader.js";

// ── PRD-049a — per-session project identity & resolution (thin-client) ──────────
// ── PRD-049d — cache writers (bind/use + registry sync) + the project env override ──
export {
	type BindFolderInput,
	bindFolderToProject,
	canonicalizeRemote,
	type CachedProject,
	defaultGitRemoteReader,
	emptyProjectsCache,
	ENV_PROJECT_ID,
	type FolderBinding,
	type GitRemoteReader,
	hasBoundProject,
	hasBoundProjectOnDisk,
	loadProjectsCache,
	noGitRemoteReader,
	PROJECTS_CACHE_FILE_NAME,
	PROJECTS_CACHE_SCHEMA_VERSION,
	type ProjectsCache,
	ProjectsCacheSchema,
	projectsCacheDir,
	projectsCachePath,
	type ResolvedScope,
	type ResolveScopeInput,
	resolveScope,
	resolveScopeFromDisk,
	saveProjectsCache,
	type ScopeSource,
	UNSORTED_PROJECT_ID,
} from "./project-resolver.js";

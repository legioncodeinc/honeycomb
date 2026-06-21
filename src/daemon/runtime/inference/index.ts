/**
 * Inference module barrel — PRD-010 (daemon-only).
 *
 * The model-provider router lives under `src/daemon/runtime/inference/` (daemon-only;
 * the DeepLake path through the history store lives only in the daemon bundle — the
 * `invariant.test.ts` enforces it). This barrel re-exports the Wave-1 contracts,
 * seams, config contract, router harness, and history store from one place so the
 * daemon assembly and the Wave-2 modules import the inference surface together.
 */

// ── 010a config contract (FULL — a-AC-1..5) ──────────────────────────────────
export {
	dumpInferenceConfig,
	InferenceConfigError,
	loadInferenceConfigFromYaml,
	parseInferenceConfig,
} from "./config.js";
// ── Shared contracts + seams (Wave 1; 010b/010c/010d code against these) ──────
export {
	type Account,
	ATTEMPT_OUTCOMES,
	type AttemptOutcome,
	type AttemptRecord,
	CAPABILITIES,
	type Capability,
	CapabilitySchema,
	type ChatMessage,
	createFakeProviderTransport,
	createFakeSecretResolver,
	type ExecuteResult,
	type FakeProviderOutcome,
	type FakeProviderScript,
	type FakeProviderTransport,
	type InferenceConfig,
	type InferenceRequest,
	type InferenceResponse,
	type InferenceRouter,
	noopRoutingHistoryStore,
	notImplemented,
	POLICY_MODES,
	type Policy,
	type PolicyMode,
	PolicyModeSchema,
	PRIVACY_TIERS,
	type PrivacyTier,
	PrivacyTierSchema,
	type ProviderCall,
	type ProviderChunk,
	ProviderError,
	type ProviderResult,
	type ProviderTransport,
	type RedactedRoutingEvent,
	type RoutingDecision,
	type RoutingHistoryScope,
	type RoutingHistoryStore,
	type SecretResolver,
	type StreamResult,
	type Target,
	tierRank,
	tierSatisfies,
	toRedactedEvent,
	type Workload,
} from "./contracts.js";
// ── Gateway mount point (010c) ───────────────────────────────────────────────
export {
	DEFAULT_HISTORY_PAGE_SIZE,
	type InferenceGatewayDeps,
	type InferenceGatewayGroups,
	MAX_REQUEST_BODY_BYTES,
	mountInferenceGateway,
} from "./gateway.js";

// ── Routing-history store (real, append-only redacted) ────────────────────────
export {
	createRoutingHistoryStore,
	DEFAULT_HISTORY_LIMIT,
	DeeplakeRoutingHistoryStore,
	type HistoryStoreClock,
	MAX_HISTORY_LIMIT,
	type RoutingHistoryStoreDeps,
	routingEventId,
} from "./history-store.js";
// ── Router harness (Wave 1 shape; 010b fills the gate/mode/fallback bodies) ───
export {
	createInferenceRouter,
	MODEL_WORKLOAD_TO_INFERENCE,
	Router,
	type RouterDeps,
	RouterModelClient,
} from "./router.js";
// ── Real Anthropic Messages transport (PRD-026 AC-T; the only non-fake transport) ─
export {
	ANTHROPIC_MESSAGES_URL,
	ANTHROPIC_VERSION,
	type AnthropicTransportDeps,
	createAnthropicTransport,
	DEFAULT_MAX_TOKENS,
	type FetchLike,
	type FetchResponseLike,
	toAnthropicBody,
} from "./transport-anthropic.js";
// ── Inference-backed ModelClient factory (PRD-026 AC-T; the assembly swap) ────
export {
	buildInferenceModelClient,
	type InferenceConfigSource,
	type InferenceModelClientDeps,
} from "./model-client-factory.js";

/**
 * Auth & tenancy barrel — PRD-011. The single import surface for the auth/tenancy
 * contracts, the CredentialsStore, the tenancy-resolution wiring, and the Wave-2
 * stubs. A Wave-2 Bee fills its stub module + its test and imports the contracts +
 * seams from here.
 *
 * Wave 1 exports: the shared contracts + the four seams (TokenIssuer/Authenticator/
 * AuthorizationPolicy + the verifyTokenClaims decoder) + their fakes/defaults, the
 * CredentialsStore (0600 file IO + resolveTenancy with the org-claim integrity
 * gate), the request-scope tenancy resolution, and honest stubs for 011b/011c/011d.
 */

// ── The shared contracts + seams (the Wave-1 chokepoint) ─────────────────────
export {
	type ApiKeyRecord,
	type AuthDecision,
	type AuthorizationContext,
	type AuthorizationPolicy,
	type Authenticator,
	type Credentials,
	type DeviceCodeGrant,
	type FakeTokenIssuerScript,
	type Identity,
	type MintedToken,
	type Mode,
	type PresentedCredentials,
	type Role,
	type TokenClaims,
	type TokenIssuer,
	AUTH_DECISIONS,
	ROLES,
	STUB_TOKEN_PREFIX,
	alwaysUnauthenticated,
	asRole,
	createFakeAuthenticator,
	createFakeTokenIssuer,
	defaultDenyPolicy,
	encodeStubToken,
	notImplemented,
	verifyTokenClaims,
} from "./contracts.js";

// ── The CredentialsStore (SHARED 0600 ~/.deeplake file + env rules + integrity gate) ──
export {
	type Clock,
	type DiskCredentials,
	type ResolvedTenancy,
	CREDENTIALS_DIR_NAME,
	CREDENTIALS_FILE_NAME,
	DEFAULT_DEEPLAKE_API_URL,
	DEFAULT_WORKSPACE,
	DIR_MODE,
	ENV_ORG_ID,
	ENV_TOKEN,
	ENV_WORKSPACE_ID,
	FILE_MODE,
	LEGACY_CREDENTIALS_DIR_NAME,
	TenancyIntegrityError,
	credentialsDir,
	credentialsPath,
	legacyCredentialsPath,
	loadCredentials,
	loadDiskCredentials,
	resolveTenancy,
	saveCredentials,
	saveDiskCredentials,
	systemClock,
} from "./credentials-store.js";

// ── PRD-023 Wave 2: the REAL api.deeplake.ai auth client + device-flow login ──
// The reusable auth client (getMe/listOrgs/listWorkspaces/reMint + device-flow) Wave 3 consumes,
// plus the AC-1 device-flow / AC-2 headless login flows that write the shared `~/.deeplake` file.
export {
	type AuthFetch,
	type AuthFetchRequestInit,
	type AuthFetchResponse,
	type BrowserOpener,
	type DeeplakeAuthClient,
	type DeeplakeAuthClientOptions,
	type DeviceCodeResponse,
	type DeviceFlowAuthResult,
	type DeviceFlowLoginDeps,
	type DeviceFlowReporter as DeeplakeDeviceFlowReporter,
	type DeviceTokenResponse,
	type LoginDeps,
	type MeResponse,
	type OrgRow,
	type ResolvedTenancyChoice,
	type TenancyCandidates,
	type TenancySelector,
	type WorkspaceRow,
	AuthHttpError,
	DEFAULT_MAX_POLLS as DEEPLAKE_DEFAULT_MAX_POLLS,
	DEFAULT_MAX_RETRIES,
	ENV_DEEPLAKE_ENDPOINT,
	ENV_HEADLESS_TOKEN,
	ENV_ORG_ID as ENV_DEEPLAKE_ORG_ID,
	HIVEMIND_REFERRER_HEADER,
	HONEYCOMB_REFERRER_HEADER,
	TenancySelectionRequiredError,
	authenticateDeviceFlow,
	computeAutoSelection,
	createDeeplakeAuthClient,
	defaultBrowserOpener,
	loginWithDeviceFlow,
	loginWithToken,
	persistSelectedTenancy,
	referrerHeaders,
	resolveApiUrl,
	resolveEffectiveRef,
	resolvePinnedTenancy,
	resolveTenancyChoice,
	validateVerificationUrl,
} from "./deeplake-issuer.js";

// ── PRD-073c — the confirmed-tenancy read model (capture-gate tie + status marker) ──
export {
	type TenancyConfirmation,
	type TenancyConfirmationDeps,
	isTenancyConfirmed,
	resolveTenancyConfirmation,
} from "./tenancy-confirmation.js";

// ── 011a request-scope tenancy resolution + PRD-049a per-request cwd-aware scope ──
export {
	type RequestScope,
	type RequestScopeResolution,
	type RequestTenancy,
	type ResolveRequestScopeInput,
	type TenancyResolution,
	resolveRequestScope,
	resolveRequestTenancy,
} from "./tenancy-resolution.js";

// ── PRD-044a — the redacted `/api/auth/status` read-model (the Settings page auth section) ──
export {
	type AuthStatusApiDeps,
	type AuthStatusBody,
	type AuthStatusSource,
	AUTH_GROUP,
	DISCONNECTED_STATUS,
	mountAuthStatusApi,
	mountAuthStatusGroup,
	resolveAuthStatus,
} from "./status-api.js";

// ── 011b device-flow login + drift heal + token authenticator ───────────────
export {
	type DeviceFlowDeps,
	type DeviceFlowReporter,
	type DriftHealResult,
	type DriftWarner,
	type HealOrgDriftDeps,
	type Sleeper,
	type TokenVerifier,
	DEFAULT_MAX_POLLS,
	createTokenAuthenticator,
	deviceFlowLogin,
	healOrgDrift,
	realSleeper,
	safeEqual,
} from "./device-flow.js";
export { createRbacPolicy } from "./rbac.js";
// ── 011d API keys (scrypt) + sliding-window rate limit ───────────────────────
export {
	type ApiKeySummary,
	type CreateApiKeyArgs,
	type CreatedApiKey,
	type KeyClock,
	API_KEY_PREFIX,
	DEFAULT_KEY_ROLE,
	createApiKey,
	createApiKeyAuthenticator,
	listKeys,
	revokeKey,
	splitApiKey,
	systemKeyClock,
} from "./api-keys.js";
export {
	type RateLimitClock,
	type RateLimitDecision,
	type RateLimitMiddlewareOptions,
	type RateLimitState,
	type RateLimiter,
	CALLER_KEY_CONTEXT,
	createRateLimitMiddleware,
	createRateLimiter,
	defaultCallerKey,
	systemRateLimitClock,
} from "./rate-limit.js";

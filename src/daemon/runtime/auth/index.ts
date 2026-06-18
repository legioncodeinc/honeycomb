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

// ── The CredentialsStore (0600 file + env rules + integrity gate) ────────────
export {
	type Clock,
	type ResolvedTenancy,
	CREDENTIALS_DIR_NAME,
	CREDENTIALS_FILE_NAME,
	DEFAULT_WORKSPACE,
	DIR_MODE,
	ENV_ORG_ID,
	ENV_TOKEN,
	ENV_WORKSPACE_ID,
	FILE_MODE,
	TenancyIntegrityError,
	credentialsDir,
	credentialsPath,
	loadCredentials,
	resolveTenancy,
	saveCredentials,
	systemClock,
} from "./credentials-store.js";

// ── 011a request-scope tenancy resolution ───────────────────────────────────
export {
	type RequestTenancy,
	type TenancyResolution,
	resolveRequestTenancy,
} from "./tenancy-resolution.js";

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

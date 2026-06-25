/**
 * `@legioncodeinc/honeycomb` barrel — PRD-019e (the typed daemon client).
 *
 * The CORE entry point: the fetch-only {@link HoneycombClient}, the typed error
 * classes, and the seams. The three framework helpers ship as SEPARATE entry points
 * (`./react`, `./vercel`, `./openai`) so the core stays dependency-free for browser
 * use (FR-7 / FR-8) — they are NOT re-exported here. See CONVENTIONS.md.
 */

export {
	ApiError,
	type ConnectorsApi,
	defaultRetryPolicy,
	type DocumentsApi,
	type Fetch,
	type GoalsApi,
	type HealthApi,
	type HooksApi,
	HoneycombError,
	type HoneycombClient,
	type HoneycombClientOptions,
	type HttpMethod,
	type MemoryApi,
	NetworkError,
	notImplemented,
	type RecallOptions,
	type RecallResult,
	type RememberOptions,
	type RetryPolicy,
	type SecretName,
	type SecretsApi,
	type SkillsApi,
	type SourcesApi,
	TimeoutError,
} from "./contracts.js";

export { createHoneycombClient, DEFAULT_TIMEOUT_MS, isTokenTransportSafe, SECRET_REDACTED } from "./client.js";

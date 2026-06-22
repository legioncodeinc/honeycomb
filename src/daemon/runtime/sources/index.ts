/**
 * Sources subsystem barrel — PRD-013. The single import surface for the
 * source-artifact contract + seams, the lifecycle engine (connect/index/update/
 * health/purge), the `/api/sources` + `/api/documents` API, the 013b document-worker
 * harness, and the 013c/d/e provider stubs.
 *
 * Wave 1 (013a) exports the FULL contract + lifecycle + API + the harness/stubs.
 * Wave 2 fills the document worker (013b) + the three providers (013c/d/e) behind
 * the seams exported here — each its own module + test, ZERO shared-file contention.
 *
 * The whole module is built around ONE thesis: a source is READ-ONLY evidence;
 * every derived row carries provenance and stays purgeable; the source files are
 * NEVER modified; and every removal is an append-only STATUS ADVANCE, never an
 * in-place UPDATE or a hard DELETE. Read CONVENTIONS.md before extending it.
 */

// ── Contracts + seams ────────────────────────────────────────────────────────
export {
	ARTIFACT_ACTIVE,
	ARTIFACT_DELETED,
	ARTIFACT_FAILURE,
	ARTIFACT_KINDS,
	ARTIFACT_SUPERSEDED,
	type ArtifactKind,
	createFakeSourceProvider,
	type FailureArtifact,
	type IndexScope,
	isSourceKind,
	parseSourceConfig,
	type Provenance,
	PROVIDER_HEALTH_STATES,
	type ProviderHealth,
	type ProviderHealthState,
	type SourceArtifact,
	type SourceChunk,
	type SourceConfig,
	SourceConfigSchema,
	type SourceGraphTriple,
	type SourceKind,
	SOURCE_KINDS,
	SourceKindSchema,
	type SourceProvider,
} from "./contracts.js";

// ── The lifecycle engine ─────────────────────────────────────────────────────
export {
	artifactId,
	chunkId,
	type ConnectOutcome,
	contentHash,
	createSourceLifecycle,
	type IndexOutcome,
	linkId,
	type PurgeOutcome,
	RESOLVE_POLLS,
	SOURCE_INDEX_JOB,
	SourceArtifactStore,
	type SourceHealth,
	SourceLifecycle,
	type SourceLifecycleDeps,
	type SourceLifecycleLogger,
	type SourceRegistry,
} from "./lifecycle.js";

// ── The /api/sources + /api/documents API ────────────────────────────────────
export {
	DOCUMENTS_GROUP,
	headerScopeResolver,
	mountDocumentsApi,
	mountSourcesApi,
	type ProviderResolver,
	type SourcesApiDeps,
	type SourceScopeResolver,
	SOURCES_GROUP,
} from "./api.js";

// ── 013b document worker (Wave 2 — real worker + harness) ────────────────────
export {
	chunkText,
	createDocumentWorker,
	createDocumentWorkerHarness,
	DEFAULT_CHUNK_OVERLAP,
	DEFAULT_CHUNK_SIZE,
	type DocumentChunkConfig,
	DocumentChunkConfigSchema,
	type DocumentContentFetcher,
	DOCUMENT_INGEST_JOB,
	type DocumentJobProgress,
	type DocumentProgressState,
	type DocumentRemoveOutcome,
	type DocumentState,
	DOCUMENT_STATES,
	type DocumentSubmission,
	type DocumentView,
	type DocumentWorker,
	type DocumentWorkerDeps,
	documentIdForUrl,
	echoDocumentContentFetcher,
	noopDocumentJobProgress,
	type RawDocumentChunkConfig,
	resolveDocumentChunkConfig,
	type SubmitResult,
} from "./document-worker.js";

// ── The registry + provider resolver + assembly helper (PRD-045e) ────────────
export {
	buildSourcesApiDeps,
	createSourceProviderResolver,
	DeeplakeSourceRegistry,
	SOURCE_CONFIG_KIND,
	type SourcesApiDepsOptions,
	sourceIdFor,
} from "./registry.js";

// ── 013c/d/e provider stubs (Wave 2 fills each) ──────────────────────────────
export { createObsidianProvider } from "./providers/obsidian.js";
export { createDiscordProvider } from "./providers/discord.js";
export {
	createGithubProvider,
	DEFAULT_GITHUB_HOST,
	DEFAULT_MAX_ITEMS_PER_REPO,
	extractHost,
	type GitHubApi,
	type GithubDoc,
	type GithubFetchFailure,
	type GithubFile,
	type GithubFilesResult,
	type GithubItem,
	type GithubItemsResult,
	type GithubProviderDeps,
	GITHUB_RESOURCE_TYPES,
	type GithubResourceType,
	type GithubSettings,
	githubTokenForRemote,
	isGithubHost,
	isMarkdownPath,
	matchesAnyGlob,
	parseRepoRef,
	readGithubSettings,
	type RepoRef,
	repoRoot,
} from "./providers/github.js";

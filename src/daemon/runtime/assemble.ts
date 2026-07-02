/**
 * The daemon composition root — PRD-021a (a-AC-1..6 / FR-1..10).
 *
 * `assembleDaemon()` is THE one function that makes the daemon real: it is the
 * single production caller that constructs the LIVE storage client (the only place
 * outside the daemon-internal storage modules that imports `daemon/storage` to get a
 * live client — allowed because this file lives under `src/daemon/`, the composition
 * root; D-2 / a-AC-1), builds `createDaemon`, fires the mount/attach seams EXACTLY ONCE
 * after construction (a-AC-2 — the four core seams + the `/api/logs` reader always, the
 * viewable `/dashboard` host local-mode only per security F-1), swaps the three no-op
 * services for their real implementations (a-AC-3), wires a cheap live `/health` storage
 * probe (a-AC-4),
 * installs graceful SIGINT/SIGTERM shutdown that drains services + closes the socket +
 * removes the lock (a-AC-5), and writes a PID/lock single-instance guard so a second
 * start does not double-bind port 3850 (a-AC-6).
 *
 * ── Wiring-only (D-1) ────────────────────────────────────────────────────────
 * This module adds NO business logic and NO DeepLake schema. Every dependency it
 * passes is an already-built-and-tested seam from a prior PRD: the storage client
 * (002a), the real services (004b/004c/004d), the auth authenticator + RBAC policy
 * (011b/011c/011d), and the four attach seams (019b/020a/020b/020d). The composition
 * root only chooses the order and fires each once.
 *
 * ── Downstream waves land here (D-4) ─────────────────────────────────────────
 * 021c attaches the context + session-end hook endpoints and 021d/021e fill the
 * dashboard-log and MCP transport surfaces. Those build ON the assembled daemon: the
 * four seams below are the extension points, and `assembleDaemon` returns the live
 * `Daemon` so a later wave can attach more without editing the bootstrap. Where a seam
 * needs a dep that does not exist yet (the team/hybrid `PruneActorAuthority` actor↔
 * identity binding), this wires the fail-closed default and marks the seam — it does
 * NOT fake it (see {@link assembleSeams}).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CATALOG } from "../storage/catalog/index.js";
import type { QueryScope, StorageClient } from "../storage/client.js";
import { type CredentialProvider, defaultCredentialProvider } from "../storage/config.js";
import { createLazyStorageClient } from "../storage/index.js";
import { isOk } from "../storage/result.js";
// ── The asset-sync substrate `/api/assets` mount (PRD-033c / D-6) ──
import { mountAssetsApi } from "./assets/api.js";
import type { TrustedTableProbe } from "./assets/sync.js";
import { DIR_MODE, LEGACY_CREDENTIALS_DIR_NAME } from "./auth/credentials-store.js";
import {
	type Authenticator,
	type AuthorizationPolicy,
	createApiKeyAuthenticator,
	createRbacPolicy,
	createTokenAuthenticator,
	defaultDenyPolicy,
	type Identity,
	type PresentedCredentials,
} from "./auth/index.js";
import { mountAuthStatusApi } from "./auth/status-api.js";
import { attachHooksHandlers } from "./capture/attach.js";
import type { CaptureHandler } from "./capture/capture-handler.js";
import { buildCodebaseGraphSnapshot, mountGraphApi } from "./codebase/api.js";
import { type DeploymentMode, type RuntimeConfig, resolveRuntimeConfig } from "./config.js";
import { mountActionsApi } from "./dashboard/actions-api.js";
import { mountDashboardApi } from "./dashboard/api.js";
import { mountHarnessApi } from "./dashboard/harness-api.js";
import { detectInstalledHarnesses } from "./dashboard/harness-detect.js";
import { mountSetupLogin } from "./dashboard/setup-login.js";
import { mountSetupMigrate } from "./dashboard/setup-migrate.js";
import { mountSetupStateApi } from "./dashboard/setup-state.js";
import { mountSyncApi } from "./dashboard/sync-mount.js";
import { mountDiagnosticsHealthApi } from "./diagnostics-health.js";
import { buildHealthDetail, type HealthDetail, type PortkeyHealth } from "./health.js";
import {
	buildInferenceModelClient,
	PORTKEY_API_KEY_NAME,
	PORTKEY_API_KEY_REF,
	type PortkeySelection,
	type ProviderModelOverride,
} from "./inference/model-client-factory.js";
import { mountLocalQueueDiagnosticsApi } from "./local-queue-diagnostics-api.js";
import { createRequestLogger, type RequestLogger } from "./logger.js";
import { mountLogsApi } from "./logs/api.js";
import { type LogStore, NULL_LOG_STORE, openLogStore } from "./logs/log-store.js";
import { mountCompactApi } from "./maintenance/compact-api.js";
import { mountStaleRefApi } from "./maintenance/stale-ref-api.js";
import { createControlledWriteConflictHook } from "./memories/conflict-hook.js";
import { createConflictSuppressionSource } from "./memories/conflict-resolve.js";
import { mountConflictsApi } from "./memories/conflicts-api.js";
// ── Data-API mount seams (PRD-022a / 022b / 022c) the composition root fires (D-2 / d-AC-1) ──
import { mountMemoriesApi, mountMemoriesPrimeApi } from "./memories/index.js";
import { mountLifecycleApi } from "./memories/lifecycle-api.js";
import type { CohereRerankSeam } from "./memories/recall.js";
import { createRuntimePathService } from "./middleware/runtime-path.js";
import { mountNotificationsApi } from "./notifications/api.js";
import { mountOntologyApi } from "./ontology/api.js";
import {
	controlledWriteFanOut,
	createPipelineHandlers,
	createStageWorker,
	decisionFanOut,
	extractionFanOut,
	noopModelClient,
	type PipelineConfig,
	resolvePipelineConfig,
	type StageWorker,
} from "./pipeline/index.js";
import type { ModelClient } from "./pipeline/model-client.js";
import { mountPollinateApi } from "./pollinating/api.js";
import { resolvePollinatingConfig } from "./pollinating/config.js";
import { createPollinatingTrigger } from "./pollinating/trigger.js";
import { createPollinatingWorker, type PollinatingJobWorker } from "./pollinating/worker.js";
import { mountProductDataApi } from "./product/index.js";
import {
	mountOnboardingApi,
	mountProjectsSyncApi,
	mountScopeEnumerationApi,
	mountScopeSwitchApi,
} from "./projects/index.js";
import { RecallConfigSchema, resolveRecallConfig } from "./recall/config.js";
import { buildCohereRerankSeam, createPortkeyRerankClient } from "./recall/rerank-portkey.js";
import { localDefaultScopeResolver, type SecretsApiDeps } from "./secrets/api.js";
import type { SecretScope } from "./secrets/contracts.js";
import { createMachineKeyProvider, createSecretResolver, SecretsStore } from "./secrets/store.js";
import { type CreateDaemonOptions, createDaemon, type Daemon, type DaemonServices } from "./server.js";
import {
	createDeepLakeHibernation,
	type DeepLakeHibernation,
	envHibernationConfigProvider,
	type Pausable,
} from "./services/deeplake-hibernation.js";
import {
	createEmbedAttachment,
	type EmbedAttachment,
	type EmbedClient,
	resolveEmbedClientOptions,
} from "./services/embed-client.js";
import { createEmbedSupervisor, type EmbedSupervisor } from "./services/embed-supervisor.js";
import { createFileWatcherService, type HarnessTarget } from "./services/file-watcher.js";
import {
	createHybridJobQueueService,
	type HybridJobQueueConfig,
	resolveHybridJobQueueConfig,
} from "./services/hybrid-job-queue.js";
import { createJobQueueService, type JobQueueConfig } from "./services/job-queue.js";
import {
	createLeaseCoordinator,
	type LeaseCoordinator,
	resolvePollConsolidateConfig,
} from "./services/lease-coordinator.js";
import { type LocalJobQueueService, openLocalJobQueue } from "./services/local-job-queue.js";
import { countPendingSharedLocalJobs, resolveLocalQueueTopology } from "./services/local-queue-diagnostics.js";
import { type PollBackoffConfig, resolvePollBackoffConfig } from "./services/poll-backoff.js";
import { attachSessionsPrune } from "./sessions/prune.js";
import { mountSkillPropagationApi } from "./skillify/propagation-api.js";
// ── The PRD-045f skillify-worker mount (the deferred-assembly seam PRD-016 left) ──
import { createSkillifyJobWorker, defaultGateSpec, type SkillifyJobWorker } from "./skillify/worker.js";
import type { SourcesApiDeps } from "./sources/api.js";
import { buildSourcesApiDeps } from "./sources/registry.js";
// ── The PRD-046a summary-worker mount (the deferred-assembly seam PRD-017 left) ──
import { createSummaryJobWorker, type SummaryJobWorker } from "./summaries/index.js";
import { EMBEDDINGS_ENABLED_KEY, mountSettingsApi } from "./vault/api.js";
import { isValidProviderModel, providerEntry } from "./vault/catalog.js";
import { migrateDeeplakeToken } from "./vault/migrate.js";
import { createVaultRegistry } from "./vault/registry.js";
// ── The vault `setting` class (PRD-032d / AC-6) — assembly READS provider/model + pollinating ──
import { VaultStore } from "./vault/store.js";
import { mountVfsApi } from "./vfs/api.js";

/**
 * The inference-config filename the daemon reads its `inference:` block from (PRD-026
 * AC-T). It lives at the WORKSPACE ROOT — `$HONEYCOMB_WORKSPACE` (the same base dir the
 * `.secrets/` store + the secrets API resolve under, defaulting to the daemon's cwd) — so
 * the file the operator edits, the `.secrets/` dir the `${ANTHROPIC_API_KEY}` ref resolves
 * against, and the daemon all agree on ONE location. The file is OPTIONAL: when absent (or
 * lacking an `inference:` block) `buildInferenceModelClient` degrades to the no-op client
 * and the daemon boots cleanly with pollinating/inference simply unavailable. It carries NO
 * secret — only the `${SECRET_REF}` reference (an inline key is rejected at parse). */
export const AGENT_CONFIG_FILE_NAME = "agent.yaml";

/** The single-instance lock filename under `~/.honeycomb/` (FR-8 / a-AC-6). */
export const LOCK_FILE_NAME = "daemon.lock";
/** The PID filename under `~/.honeycomb/` (FR-8 / a-AC-6). */
export const PID_FILE_NAME = "daemon.pid";

// NOTE (PRD-023): the daemon RUNTIME dir (PID + lock) stays at `~/.honeycomb` — it is
// Honeycomb-private process state, NOT a shared credential. Only the credentials file
// moved to the shared `~/.deeplake` (D-1). So the runtime dir resolves via the LEGACY
// dir name; the credentials store owns the `.deeplake` path independently.

/** How often the cheap live `/health` probe refreshes the cached health bit (a-AC-4). */
const DEFAULT_HEALTH_PROBE_INTERVAL_MS = 15_000;

/**
 * Interval for the opt-in codebase-graph auto-build timer.
 */
const DEFAULT_GRAPH_BUILD_INTERVAL_MS = 60 * 60 * 1_000;
const CODEBASE_GRAPH_AUTO_BUILD_ENV = "HONEYCOMB_CODEBASE_GRAPH_AUTO_BUILD";

/** The coarse pipeline status the cached `/health` bit reports (mirrors server.ts). */
type PipelineStatus = "ok" | "degraded" | "unconfigured";

function parseBooleanEnv(raw: unknown): boolean | undefined {
	if (typeof raw !== "string") return undefined;
	const value = raw.trim().toLowerCase();
	if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
	if (value === "0" || value === "false" || value === "no" || value === "off" || value === "") return false;
	return undefined;
}

export function resolveCodebaseGraphAutoBuild(options: {
	readonly explicit?: boolean;
	readonly env?: NodeJS.ProcessEnv;
	readonly hasInjectedStorage: boolean;
	readonly mode: DeploymentMode;
}): boolean {
	if (options.explicit !== undefined) return options.explicit;
	if (options.hasInjectedStorage || options.mode !== "local") return false;
	return parseBooleanEnv((options.env ?? process.env)[CODEBASE_GRAPH_AUTO_BUILD_ENV]) === true;
}

/**
 * The seams the composition root needs from the environment so a test drives the
 * assembly deterministically (a temp `~/.honeycomb`, a fake clock, an injected
 * storage client) without touching the real machine or a live backend.
 */
export interface AssembleDaemonOptions {
	/**
	 * The resolved runtime config (host/port/mode). Defaults to env resolution
	 * (fail-closed). A test injects a fixed config (e.g. an ephemeral port).
	 */
	readonly config?: RuntimeConfig;
	/**
	 * The live storage client. Defaults to {@link createStorageClient} (the ONLY
	 * production construction — a-AC-1). A test injects a fake `StorageClient`-shaped
	 * object so the deterministic bits run without a live DeepLake.
	 */
	readonly storage?: StorageClient;
	/**
	 * The credential provider the daemon resolves its OWN tenancy scope (`{ org, workspace }`)
	 * and friendly `orgName` from — the SAME provider {@link createStorageClient} connects
	 * through (env-over-file, {@link defaultCredentialProvider}). Defaults to that provider so
	 * a plain `honeycomb login` (NO env) resolves the real org from `~/.deeplake/credentials.json`
	 * instead of the `"local"` placeholder. A unit test that injects a fake {@link storage}
	 * leaves this unset → no creds → the deterministic `{ org: "local", workspace: "default" }`
	 * fallback (the suite is unchanged). A test may inject a fake provider to drive the scope
	 * deterministically without env or a real file.
	 */
	readonly provider?: CredentialProvider;
	/** The request logger. Defaults to the stderr JSON-lines + ring-buffer logger. */
	readonly logger?: RequestLogger;
	/**
	 * PRD-043a (FR-1/FR-2): the durable SQLite log store the logger writes through to and the
	 * `/api/logs/history` endpoint reads. Production leaves it UNSET → the composition root opens
	 * the REAL store under `$HONEYCOMB_WORKSPACE/.daemon/logs.db` for the REAL assembly only (no
	 * injected {@link storage}), so the deterministic unit suite (which injects a fake `storage` and
	 * no `logStore`) stays on the in-memory ring buffer and never touches disk. The open is fail-soft
	 * (AC-4): an unavailable `node:sqlite` / open failure degrades to the {@link NULL_LOG_STORE} no-op.
	 * A test injects a temp-dir / in-memory store to exercise persistence deterministically.
	 */
	readonly logStore?: LogStore;
	/**
	 * The `~/.honeycomb` directory the PID + lock files live in. Defaults to the real
	 * home dir; a test points it at a temp dir so the guard never collides with a real
	 * daemon's lock.
	 */
	readonly runtimeDir?: string;
	/** Cached-health-bit refresh interval (a-AC-4). Default 15s. */
	readonly healthProbeIntervalMs?: number;
	/**
	 * Test/proof override for whether start() awaits the first storage health probe. Production
	 * defaults to false so a slow DeepLake request cannot prevent the daemon from binding.
	 */
	readonly awaitInitialHealthProbe?: boolean;
	/**
	 * The harness identity-copy targets the file watcher syncs (004c). Defaults to an
	 * empty set (no harness copies) so a bare assembly does not require PRD-019 paths;
	 * a fuller wiring (021c) supplies the real per-harness destinations.
	 */
	readonly harnessTargets?: readonly HarnessTarget[];
	/**
	 * The set of canonical harness ids the daemon reports as INSTALLED/wired on the 039a telemetry
	 * endpoint (a-AC-3 / OQ-1). Precedence at assembly: this explicit set wins; else the
	 * {@link harnessTargets} names (the watcher's already-resolved wiring targets); else — for the
	 * REAL production assembly only (no injected {@link storage}) — the cheap on-disk
	 * {@link detectInstalledHarnesses} probe, so the live endpoint reflects what is actually wired
	 * instead of an empty set. A unit test injects a fixed set (or relies on the empty-by-default path)
	 * so the deterministic suite never touches the real home. Production leaves it UNSET.
	 */
	readonly installedHarnesses?: ReadonlySet<string>;
	/** The workspace root the file watcher watches. Defaults to `process.cwd()`. */
	readonly workspaceDir?: string;
	/**
	 * Override the production local-mode codebase-graph auto-build. Production leaves this unset:
	 * the boot-time parser is opt-in via HONEYCOMB_CODEBASE_GRAPH_AUTO_BUILD=true so a tree-sitter
	 * abort cannot crash-loop the daemon before it binds.
	 */
	readonly autoBuildGraph?: boolean;
	/**
	 * Override startup of daemon-resident background workers. Production leaves this
	 * unset (true); idle-cost proofs can set it false to isolate core daemon idleness
	 * from queue consumers while preserving the same packaged daemon/listener path.
	 */
	readonly startBackgroundWorkers?: boolean;
	/** Test/proof override for the summary worker. Production leaves unset (true). */
	readonly startSummaryWorker?: boolean;
	/** Test/proof override for the memory-pipeline worker. Production leaves unset (true). */
	readonly startPipelineWorker?: boolean;
	/** Test/proof override for the skillify worker. Production leaves unset (true). */
	readonly startSkillifyWorker?: boolean;
	/** Test/proof override for the pollinating worker. Production leaves unset (true, still config-gated). */
	readonly startPollinatingWorker?: boolean;
	/**
	 * The four mount/attach seam functions, injectable for testing (a-AC-2). Defaults to
	 * the REAL seams ({@link defaultSeamFns}). A unit test injects recording fakes to assert
	 * each is called EXACTLY ONCE, after construction, in order — without mocking the
	 * module graph (the repo's DI-over-mock posture). Production never sets this.
	 */
	readonly seams?: SeamFns;
	/**
	 * Override the local `projects.json` cache directory used by capture/project
	 * resolution. Production leaves this unset so the daemon reads `~/.deeplake`;
	 * live tests point it at a temp dir so first-run project bindings are hermetic.
	 */
	readonly projectsDir?: string;
	/**
	 * Test-only override for the DeepLake-backed shared job queue. Production leaves
	 * this unset, preserving the canonical `memory_jobs` table. Live verification
	 * can pass a throwaway table name to bound shared-queue polling without scanning
	 * a user's historical queue.
	 */
	readonly jobQueueConfig?: JobQueueConfig;
	/**
	 * The embed seam wired into the store + capture paths (PRD-025 AC-2). Defaults to the
	 * REAL `createEmbedAttachment({ storage })` resolved from `resolveEmbedClientOptions`
	 * (D-1 default-on) — so a fresh daemon stores + captures with a real 768-dim vector when
	 * embeddings are available, and falls back to a NULL vector (lexical) when not, never a
	 * throw. A unit test injects a FAKE attachment (e.g. a no-op or a deterministic stub) to
	 * keep the assembly hermetic. Production never sets this.
	 */
	readonly embed?: EmbedAttachment;
	/**
	 * The embed-daemon SUPERVISOR wired into the daemon lifecycle (PRD-025 Wave 2 / D-6).
	 * Defaults to the REAL {@link createEmbedSupervisor} — so a fresh daemon spawns,
	 * health-checks, and crash-restarts the embed daemon child (warming it OFF the turn
	 * path, D-3), and an explicit `HONEYCOMB_EMBEDDINGS=false`/`0` makes it inert (D-1
	 * opt-out, no child spawned). A unit test injects a FAKE supervisor (e.g. a no-op or a
	 * recording stub) so the assembly never spawns a real process. Production never sets this.
	 */
	readonly embedSupervisor?: EmbedSupervisor;
	/**
	 * Whether the REAL embedder is wired, for the PRD-029 `/health` `reasons.embeddings`
	 * signal (AC-2). Production leaves it UNSET → the composition root derives it from the
	 * embed seam: when the real `createEmbedAttachment` is built it reads
	 * `resolveEmbedClientOptions().enabled` (the `HONEYCOMB_EMBEDDINGS` opt-out), and when a
	 * test injects a fake {@link embed} it defaults to `false` (the hermetic no-op reports
	 * `off`). A test sets this explicitly to drive the `on`/`off` reason deterministically
	 * without touching `process.env`. Reflects the embed-seam state KNOWN AT ASSEMBLY (D-4);
	 * it is NOT a live probe.
	 */
	readonly embeddingsEnabled?: boolean;
	/**
	 * The filesystem path to the `inference:` config (`agent.yaml`) the daemon builds its
	 * real {@link ModelClient} from (PRD-026 AC-T). Defaults to `agent.yaml` under
	 * `$HONEYCOMB_WORKSPACE` (the daemon's cwd when unset) — the SAME base the `.secrets/`
	 * store resolves the `${ANTHROPIC_API_KEY}` ref under. A test points it at a temp file
	 * (or a path that does not exist) to drive the no-op degrade deterministically. Absent /
	 * unparseable → the no-op model client (never a throw).
	 */
	readonly agentConfigPath?: string;
	/**
	 * The pollinating `memory.pollinating` config provider seam (PRD-026 AC-W gate). Defaults to
	 * the env provider ({@link resolvePollinatingConfig}'s default), so `enabled` is OFF unless
	 * `HONEYCOMB_POLLINATING_ENABLED=true`/`1`. A test injects a fixed provider to drive the
	 * `enabled:true` / `enabled:false` worker-start gate WITHOUT touching `process.env`.
	 */
	readonly pollinatingConfigProvider?: Parameters<typeof resolvePollinatingConfig>[0];
	/**
	 * The pre-built pollinating worker, injectable for testing (AC-W). Production leaves it
	 * unset → the composition root builds the REAL worker from the daemon's scope + storage +
	 * model + queue WHEN `config.enabled`. A test injects a recording fake to assert
	 * `start()`/`stop()` are called exactly when the gate says so, without a live queue.
	 * When `null` is injected the build step is skipped entirely (the "no worker constructed
	 * when disabled" assertion). Production never sets this.
	 */
	readonly pollinatingWorker?: PollinatingJobWorker | null;
	/**
	 * The machine-bound vault store the daemon READS the `setting` class from (PRD-032d /
	 * AC-6) — the active provider/model selection + the `pollinating.enabled` flag. Production
	 * leaves it UNSET → the composition root constructs the REAL {@link VaultStore} over the
	 * SAME workspace base dir + machine-key + daemon scope the secrets store uses (so the
	 * vault, the `.secrets/` records, and the `${SECRET_REF}` resolver all agree on ONE
	 * location). A test injects a FAKE vault store (a `getSetting`-shaped stub) to drive the
	 * vault-wins / fallback precedence WITHOUT touching the real workspace. When a fake
	 * `storage` is injected and this is unset, the vault read is simply skipped (the deterministic
	 * suite is unchanged — every vault read fails soft to the `agent.yaml`/env fallback).
	 */
	readonly vault?: VaultSettingsReader;
}

/**
 * The narrow READ surface the composition root needs from the vault `setting` class (AC-6) —
 * the single method `getSetting`, structurally satisfied by the real {@link VaultStore}. A
 * test injects a tiny fake of just this shape; production passes the real store. Keeping the
 * dep to this one method (not the whole store) is what lets a test drive the precedence with a
 * three-line stub.
 */
export type VaultSettingsReader = Pick<VaultStore, "getSetting">;

/**
 * The mount/attach seam functions the composition root fires once (a-AC-2). The four
 * core seams (`attachHooks`/`mountDashboard`/`mountNotifications`/`attachPrune`) fire
 * unconditionally; `mountLogs` fires unconditionally (its `/api/logs` group is already
 * `protect:true` in `server.ts`, so it carries no security gate); the guided-setup routes
 * (`mountSetupLogin` / `mountSetupState` / `mountSetupMigrate`) fire LOCAL-MODE ONLY
 * (security F-1 — see {@link assembleSeams}).
 */
export interface SeamFns {
	readonly attachHooks: typeof attachHooksHandlers;
	readonly mountDashboard: typeof mountDashboardApi;
	readonly mountNotifications: typeof mountNotificationsApi;
	readonly attachPrune: typeof attachSessionsPrune;
	/** The `/api/logs` ring-buffer reader (021d). Fires always — its group is `protect:true`. */
	readonly mountLogs: typeof mountLogsApi;
	/**
	 * The "First time setup" on-page login route — `POST /setup/login` (PRD-050c). Sits beside the
	 * dashboard host on the UNPROTECTED root group, so it fires LOCAL-MODE ONLY under the SAME gate
	 * (security F-1): a single loopback tenant, the permission middleware open by design. It begins the
	 * device flow with the dual referral-attribution headers and returns the `user_code` + URIs for the
	 * page to render (NO token — c-AC-4), then polls → mints → persists the shared credential.
	 *
	 * OPTIONAL on the seam record (like {@link mountSync}) so a pre-existing recording-fake `SeamFns`
	 * stays type-compatible WITHOUT editing those out-of-scope suites; `assembleSeams` fires it only when
	 * present (always present in {@link defaultSeamFns}, i.e. production), under the local-mode gate.
	 */
	readonly mountSetupLogin?: typeof mountSetupLogin;
	/**
	 * The pre-auth guided-setup STATE read — `GET /setup/state` (PRD-050b b-AC-2). Sits beside the
	 * dashboard host + setup-login on the UNPROTECTED root group, so it fires under the SAME local-mode
	 * gate (security F-1 / b-AC-4): in team/hybrid it 404s/is-absent. It reports the three credential-dir
	 * presences, the onboarding phase, prior-tool detection, the derived `authenticated` bit, and the
	 * embeddings warmup signal (b-AC-5) — install metadata only, NO token/secret/PII.
	 *
	 * OPTIONAL on the seam record (like {@link mountSetupLogin}) so a pre-existing recording-fake
	 * `SeamFns` stays type-compatible WITHOUT editing those out-of-scope suites; `assembleSeams` fires
	 * it only when present (always present in {@link defaultSeamFns}, i.e. production), under the gate.
	 */
	readonly mountSetupState?: typeof mountSetupStateApi;
	/**
	 * The Hivemind→Honeycomb migration routes — `POST /setup/migrate-from-hivemind` (+ `/rollback`)
	 * (PRD-050d d-AC-3 .. d-AC-7). Sits beside the dashboard host + setup-login + setup-state on the SAME
	 * unprotected root group, so it fires under the SAME local-mode gate (security F-1): in team/hybrid it
	 * is never mounted. Backs up + uninstalls Hivemind idempotently, verify-and-adopts the shared
	 * credential (or signals `needsLogin`), and advances a durable `migration.phase` marker so a crash
	 * mid-migration is recoverable. NO token/secret crosses the wire.
	 *
	 * OPTIONAL on the seam record (like {@link mountSetupLogin}) so a pre-existing recording-fake `SeamFns`
	 * stays type-compatible WITHOUT editing those out-of-scope suites; `assembleSeams` fires it only when
	 * present (always present in {@link defaultSeamFns}, i.e. production), under the local-mode gate.
	 */
	readonly mountSetupMigrate?: typeof mountSetupMigrate;
	/** The `/api/memories/*` data API (022a). Fires UNCONDITIONALLY — its group is a protected session group. */
	readonly mountMemories: typeof mountMemoriesApi;
	/**
	 * The session-priming PRIME digest — `GET /api/memories/prime` (PRD-046c). Fires onto the same
	 * `/api/memories` SESSION group, so it inherits the auth/RBAC + session gate. A pure SQL skim
	 * (`skimPrimeKeys`) + a pure assembly — NO generation at read.
	 *
	 * OPTIONAL on the seam record (exactly like {@link mountGraph}) so a pre-existing recording-fake
	 * `SeamFns` that predates this seam stays type-compatible WITHOUT editing those out-of-scope
	 * tests; `assembleSeams` fires it only when present (always present in {@link defaultSeamFns}).
	 */
	readonly mountMemoriesPrime?: typeof mountMemoriesPrimeApi;
	/**
	 * PRD-058b: the conflict-resolution endpoint — `POST /api/memories/conflicts/:id/resolve`. Fires onto
	 * the SAME `/api/memories` SESSION group, inheriting auth/RBAC + the session gate. OPTIONAL on the seam
	 * record (like {@link mountMemoriesPrime}) so a pre-existing recording-fake `SeamFns` stays
	 * type-compatible WITHOUT editing those out-of-scope suites; `assembleSeams` fires it only when present
	 * (always present in {@link defaultSeamFns}).
	 */
	readonly mountConflicts?: typeof mountConflictsApi;
	/**
	 * PRD-058d — the lifecycle READ endpoints (conflicts list / stale-refs / lifecycle history) on the
	 * SAME `/api/memories` SESSION group, inheriting auth/RBAC + the session gate. OPTIONAL on the seam
	 * record (like {@link mountConflicts}) so a pre-existing recording-fake `SeamFns` stays type-compatible
	 * WITHOUT editing those out-of-scope suites; `assembleSeams` fires it only when present (always present
	 * in {@link defaultSeamFns}). Reads-only: it defines NO write path (the resolve goes through 058b).
	 */
	readonly mountLifecycle?: typeof mountLifecycleApi;
	/** The `/memory/*` VFS browse reads (022b). Fires UNCONDITIONALLY — its group is a protected session group. */
	readonly mountVfs: typeof mountVfsApi;
	/** The product-data surface — goals/kpis/skills/rules (+secrets) (022c). Fires UNCONDITIONALLY. */
	readonly mountProductData: typeof mountProductDataApi;
	/**
	 * The "Pollinate now" trigger — `POST /api/diagnostics/pollinate` (PRD-024 / AC-6). Fires
	 * UNCONDITIONALLY: its `/api/diagnostics` group is already `protect:true`, so it inherits
	 * the same auth/RBAC as the dashboard's JSON views (open in `local`, gated in team/hybrid).
	 */
	readonly mountPollinate: typeof mountPollinateApi;
	/**
	 * The project registry → local-cache sync trigger — `POST /api/diagnostics/projects-sync`
	 * (PRD-049d). Fires UNCONDITIONALLY: its `/api/diagnostics` group is already `protect:true`, so
	 * it inherits the dashboard JSON views' auth/RBAC (open in `local`, gated in team/hybrid). It
	 * refreshes the thin-client `~/.deeplake/projects.json` cache from the workspace's `projects`
	 * registry so the resolver matches the workspace's real projects OFFLINE. FAIL-SOFT — a registry
	 * read failure leaves the prior cache intact and returns a clean ack, never a 500.
	 */
	readonly mountProjectsSync: typeof mountProjectsSyncApi;
	/**
	 * The standalone version-history COMPACTION trigger — `POST /api/diagnostics/compact`
	 * (PRD-030 / D-2 PRIMARY). Fires UNCONDITIONALLY: its `/api/diagnostics` group is already
	 * `protect:true`, so it inherits the same auth/RBAC as the dashboard's JSON views (open in
	 * `local`, gated in team/hybrid). Fail-soft — a mount error never crashes the daemon.
	 */
	readonly mountCompact: typeof mountCompactApi;
	/**
	 * The PRD-058c stale-reference diagnostic trigger — `POST /api/diagnostics/stale-refs`. Fires
	 * UNCONDITIONALLY: its `/api/diagnostics` group is already `protect:true`, so it inherits the same
	 * auth/RBAC as the dashboard's JSON views (open in `local`, gated in team/hybrid). It runs the
	 * `σ(m,t)` diagnostic over the daemon-scope memories against the converged codebase-graph snapshot.
	 * Fail-soft — a mount error never crashes the daemon; a missing graph oracle marks nothing stale.
	 */
	readonly mountStaleRef: typeof mountStaleRefApi;
	/**
	 * The protected per-subsystem health detail — `GET /api/diagnostics/health` (PRD-029 /
	 * AC-3). Fires UNCONDITIONALLY: its `/api/diagnostics` group is already `protect:true`, so
	 * the full `reasons` detail it exposes is gated in team/hybrid (open in local) — exactly
	 * the D-2 surface for the topology that the public `/health` withholds from an
	 * unauthenticated remote.
	 */
	readonly mountDiagnosticsHealth: typeof mountDiagnosticsHealthApi;
	/**
	 * The local queue upgrade/rollback diagnostics endpoint - `GET /api/diagnostics/local-queue`
	 * (PRD-066e). Optional so older recording seams stay type-compatible.
	 */
	readonly mountLocalQueueDiagnostics?: typeof mountLocalQueueDiagnosticsApi;
	/**
	 * The codebase-graph build + read surface — `POST /api/graph/build` + `GET /api/graph`
	 * (PRD-014 assembly wiring, CONVENTIONS §11). Fires UNCONDITIONALLY: its `/api/graph` group
	 * is already `protect:true` in `server.ts`, so it inherits the dashboard JSON views' auth/RBAC
	 * (open in `local`, gated in team/hybrid). This is the seam that turns the build 501 into a
	 * real end-to-end build (discover → extract → snapshot → push). Fail-soft — a mount error
	 * never crashes the daemon.
	 *
	 * OPTIONAL on the seam record so a pre-existing recording-fake `SeamFns` (the PRD-021/022
	 * assemble suites, which predate this seam) stays type-compatible WITHOUT editing those
	 * out-of-scope tests; `assembleSeams` fires it only when present (it is always present in
	 * {@link defaultSeamFns}, i.e. production), inside the same fail-soft try/catch.
	 */
	readonly mountGraph?: typeof mountGraphApi;
	/**
	 * The harness registry + last-seen telemetry endpoint — `GET /api/diagnostics/harnesses`
	 * (PRD-039a, the data backbone). Fires UNCONDITIONALLY: its `/api/diagnostics` group is already
	 * `protect:true` in `server.ts`, so it inherits the dashboard JSON views' auth/RBAC (open in
	 * `local`, gated in team/hybrid). It reports all six canonical harnesses every call (installed +
	 * activity from the `sessions` GROUP BY), the single source the Harnesses page (039b/039c) and
	 * PRD-038's home strip read (parent D-3). Fail-soft — a mount error never crashes the daemon.
	 *
	 * OPTIONAL on the seam record (like {@link mountGraph}) so a pre-existing recording-fake `SeamFns`
	 * (the PRD-021/022 assemble suites that predate this seam) stays type-compatible WITHOUT editing
	 * those out-of-scope tests; `assembleSeams` fires it only when present (always present in
	 * {@link defaultSeamFns}, i.e. production), inside the same fail-soft try/catch.
	 */
	readonly mountHarness?: typeof mountHarnessApi;
	/**
	 * The Sync page data + action surface — `GET /api/diagnostics/assets` (the `installed ∪ synced`
	 * union view-model) + `POST /api/diagnostics/sync/{promote,pull,demote,enable,disable}` (PRD-042).
	 * Attaches onto the same already-mounted, protected `/api/diagnostics` group (NO `server.ts` edit),
	 * so it inherits the dashboard JSON views' auth/RBAC (open in `local`, gated in team/hybrid). The
	 * actions are the REAL substrate pipelines (publish/pull/tombstone via `createAssetSyncApi`) plus
	 * the local install-target write — poll-convergent read-back, never an optimistic flip.
	 *
	 * OPTIONAL on the seam record (like {@link mountHarness}) so a pre-existing recording-fake `SeamFns`
	 * stays type-compatible WITHOUT editing those out-of-scope suites; `assembleSeams` fires it only
	 * when present (always present in {@link defaultSeamFns}, i.e. production), inside a fail-soft
	 * try/catch.
	 */
	readonly mountSync?: typeof mountSyncApi;
	/**
	 * The knowledge-graph / ontology READ + reason-gated MUTATION surface — `GET
	 * /api/ontology/{entities,edges,claims,assertions}` + `POST /api/ontology/proposals`
	 * (PRD-045c, closing the PRD-008 daemon-wiring gap). Attaches onto the already-mounted,
	 * protected `/api/ontology` group (server.ts:88; NO `server.ts` edit), so it inherits the
	 * dashboard JSON views' auth/RBAC (open in `local`, gated in team/hybrid). This is the seam
	 * that turns the ontology 501 scaffold into a LIVE read surface (no 501) and gives the
	 * control-plane apply a live, pollinating-INDEPENDENT mutation path. The `/api/ontology` group
	 * has a SINGLE owner — no other mount registers any `/api/ontology/*` path — so there is no
	 * route collision (the same single-owner rule that resolved the `/api/graph` double-registration:
	 * `GET /api/graph` is now served ONLY by {@link mountGraph}; `mountDashboard` no longer claims it).
	 *
	 * OPTIONAL on the seam record (like {@link mountGraph}/{@link mountHarness}/{@link mountSync})
	 * so a pre-existing recording-fake `SeamFns` stays type-compatible WITHOUT editing those
	 * out-of-scope suites; `assembleSeams` fires it only when present (always present in
	 * {@link defaultSeamFns}, i.e. production), inside a fail-soft try/catch.
	 */
	readonly mountOntology?: typeof mountOntologyApi;
	/**
	 * The team skill-sharing PUBLISH + PULL surface — `POST /api/skills` (versioned publish) +
	 * `POST /api/skills/{pull,scope,unpull,force}` (PRD-045g, closing the PRD-018 daemon-wiring
	 * gap). Attaches onto the already-mounted, protected `/api/skills` group (server.ts:83; NO
	 * `server.ts` edit), so it inherits the dashboard JSON views' auth/RBAC (open in `local`,
	 * gated in team/hybrid). This is the seam that turns the never-mounted publish endpoint +
	 * the unmounted `POST /api/skills/pull` (the CLI dispatch target) into REAL routes — a
	 * republish lands a versioned row (g-AC-1) and a pull runs the real team pull + cross-harness
	 * symlink fan-out (g-AC-5). NO collision with `GET /api/skills` (owned by `mountProductData`):
	 * this registers only POST verbs onto the same group.
	 *
	 * OPTIONAL on the seam record (like {@link mountOntology}) so a pre-existing recording-fake
	 * `SeamFns` stays type-compatible WITHOUT editing those out-of-scope suites; `assembleSeams`
	 * fires it only when present (always present in {@link defaultSeamFns}, i.e. production),
	 * inside a fail-soft try/catch.
	 */
	readonly mountSkillPropagation?: typeof mountSkillPropagationApi;
}

/** The REAL seam functions (the production wiring). */
export const defaultSeamFns: SeamFns = {
	attachHooks: attachHooksHandlers,
	mountDashboard: mountDashboardApi,
	mountNotifications: mountNotificationsApi,
	attachPrune: attachSessionsPrune,
	mountLogs: mountLogsApi,
	mountSetupLogin,
	mountSetupState: mountSetupStateApi,
	mountSetupMigrate,
	mountMemories: mountMemoriesApi,
	mountMemoriesPrime: mountMemoriesPrimeApi,
	mountConflicts: mountConflictsApi,
	mountLifecycle: mountLifecycleApi,
	mountVfs: mountVfsApi,
	mountProductData: mountProductDataApi,
	mountPollinate: mountPollinateApi,
	mountProjectsSync: mountProjectsSyncApi,
	mountCompact: mountCompactApi,
	mountStaleRef: mountStaleRefApi,
	mountDiagnosticsHealth: mountDiagnosticsHealthApi,
	mountLocalQueueDiagnostics: mountLocalQueueDiagnosticsApi,
	mountGraph: mountGraphApi,
	mountHarness: mountHarnessApi,
	mountSync: mountSyncApi,
	mountOntology: mountOntologyApi,
	mountSkillPropagation: mountSkillPropagationApi,
};

/** An assembled, fully-wired daemon plus the composition root's lifecycle controls. */
export interface AssembledDaemon {
	/** The constructed daemon (the Hono app + wired real services). Never auto-listens. */
	readonly daemon: Daemon;
	/** The resolved runtime config the daemon was assembled against. */
	readonly config: RuntimeConfig;
	/**
	 * Start the composition-root lifecycle: write the PID/lock guard, start the cached
	 * `/health` probe refresher, and start the daemon's services. Does NOT bind the
	 * socket (that is `startDaemon`). Idempotent.
	 */
	start(): Promise<void>;
	/**
	 * Graceful shutdown (a-AC-5): drain the services via `stopServices()`, stop the
	 * health refresher, and remove the PID/lock files so no stale lock survives. Safe to
	 * call more than once. The socket close is the caller's (the `RunningDaemon.close`
	 * from `startDaemon` calls `stopServices` itself; this clears the lock).
	 */
	shutdown(): Promise<void>;
	/** The current cached pipeline-health bit (for `/api/status` + diagnostics). */
	pipelineStatus(): PipelineStatus;
}

/** Thrown when a second start detects a daemon already holding the lock (a-AC-6). */
export class DaemonAlreadyRunningError extends Error {
	/** The PID recorded in the existing lock, when readable. */
	readonly existingPid: number | null;
	constructor(existingPid: number | null) {
		super(
			existingPid !== null
				? `a Honeycomb daemon is already running (pid ${existingPid}); refusing to double-bind`
				: "a Honeycomb daemon lock is already held; refusing to double-bind",
		);
		this.name = "DaemonAlreadyRunningError";
		this.existingPid = existingPid;
	}
}

/** Resolve the `~/.honeycomb` runtime dir (honoring a test override). */
function resolveRuntimeDir(dir: string | undefined): string {
	return dir ?? join(homedir(), LEGACY_CREDENTIALS_DIR_NAME);
}

/** True when a process with `pid` is currently alive (signal 0 probes liveness). */
function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		// Signal 0 performs the permission/existence check WITHOUT delivering a signal.
		process.kill(pid, 0);
		return true;
	} catch (err: unknown) {
		// ESRCH → no such process (stale). EPERM → the process exists but is owned by
		// another user (still "alive" for our single-instance purpose).
		const code = (err as NodeJS.ErrnoException)?.code;
		return code === "EPERM";
	}
}

/**
 * Acquire the single-instance PID/lock guard (FR-8 / a-AC-6). Writes `daemon.pid` +
 * `daemon.lock` under the runtime dir. If a lock already exists AND its recorded PID
 * is still alive, throws {@link DaemonAlreadyRunningError} so the second start does NOT
 * double-bind port 3850. A STALE lock (the recorded process is gone) is reclaimed — a
 * crashed daemon never wedges the next start. Returns the resolved paths so shutdown
 * removes exactly what it wrote.
 */
export function acquireSingleInstanceLock(runtimeDir: string): { lockPath: string; pidPath: string } {
	mkdirSync(runtimeDir, { recursive: true, mode: DIR_MODE });
	const lockPath = join(runtimeDir, LOCK_FILE_NAME);
	const pidPath = join(runtimeDir, PID_FILE_NAME);

	const existingPid = readPidFile(lockPath);
	if (existingPid !== null && isPidAlive(existingPid)) {
		throw new DaemonAlreadyRunningError(existingPid);
	}

	// Fresh or stale-reclaimed: stamp this process's pid into both files. The lock and
	// pid files carry the same value; the lock is what the guard checks, the pid file is
	// the operator-facing convenience (`cat ~/.honeycomb/daemon.pid`).
	const pid = String(process.pid);
	writeFileSync(lockPath, pid, { encoding: "utf8" });
	writeFileSync(pidPath, pid, { encoding: "utf8" });
	return { lockPath, pidPath };
}

/** Read a PID from a lock/pid file, or `null` when absent/unreadable/garbage. */
function readPidFile(path: string): number | null {
	try {
		const raw = readFileSync(path, "utf8").trim();
		if (raw.length === 0) return null;
		const pid = Number.parseInt(raw, 10);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		// Absent file is the common case (no daemon running) — not an error.
		return null;
	}
}

/** Remove the PID/lock files (graceful shutdown / stale reclaim). Never throws. */
export function releaseSingleInstanceLock(runtimeDir: string): void {
	for (const name of [LOCK_FILE_NAME, PID_FILE_NAME]) {
		try {
			rmSync(join(runtimeDir, name), { force: true });
		} catch {
			// A missing lock on shutdown is fine — the goal (no stale lock) already holds.
		}
	}
}

/**
 * Compose the real {@link Authenticator} for team/hybrid mode (D-9). Tries the
 * bearer-token half (011b) then the API-key half (011d), returning the first
 * positively-validated {@link Identity}, else `null` (→ 401). In `local` mode the
 * daemon is loopback single-user and the permission middleware is open, so the
 * authenticator is never consulted; we still build it so a mode flip needs no rewire.
 *
 * Both halves are the REAL impls: the token half verifies a Bearer token via
 * `verifyTokenClaims` (011b), and the api-key half does the real `api_keys`
 * lookup-by-keyid → scrypt-verify → Identity read against the live storage client +
 * scope (011d). The composite returns the first non-null, else `null` → the middleware
 * maps `null` to 401.
 *
 * SECURITY: The token authenticator receives the deployment mode so it can reject
 * unsigned stub tokens in team/hybrid modes (production). Stub tokens are development-only
 * and lack cryptographic signatures.
 */
function composeAuthenticator(storage: StorageClient, scope: QueryScope, mode: DeploymentMode): Authenticator {
	const tokenAuth = createTokenAuthenticator(undefined, mode);
	// The REAL api-key half: it reads the `api_keys` table through the live client and
	// scope, hashes + verifies the presented key, and rejects revoked/cross-project keys.
	const apiKeyAuth = createApiKeyAuthenticator(storage, scope);
	return {
		async authenticate(presented: PresentedCredentials): Promise<Identity | null> {
			const byToken = await tokenAuth.authenticate(presented);
			if (byToken !== null) return byToken;
			return apiKeyAuth.authenticate(presented);
		},
	};
}

/**
 * Choose the authenticator + policy for the deployment mode (FR-9). `local` is loopback
 * single-user: the permission middleware is open, so the fail-closed defaults are fine
 * (they are never consulted). `team`/`hybrid` get the real composed authenticator + the
 * real RBAC policy. The ASSEMBLY ORDER does not change with mode — only which gate
 * objects are passed (a-AC-9 posture).
 */
function authForMode(
	mode: RuntimeConfig["mode"],
	storage: StorageClient,
	scope: QueryScope,
): { authenticator: Authenticator; policy: AuthorizationPolicy } {
	if (mode === "team" || mode === "hybrid") {
		return { authenticator: composeAuthenticator(storage, scope, mode), policy: createRbacPolicy() };
	}
	// `local`: open middleware; the defaults are never reached but keep the shape stable.
	return { authenticator: composeAuthenticator(storage, scope, mode), policy: defaultDenyPolicy };
}

/**
 * Fire the mount/attach seams EXACTLY ONCE, after construction, in a deterministic order
 * (a-AC-2 / FR-3): hooks → dashboard → notifications → sessions-prune → logs →
 * setup routes (local only). Each reads through the live storage client + the queue/logger it needs.
 * This is the single caller of these seams in production; calling it twice would
 * double-register routes, so the composition root calls it once (the seams hold no global
 * state — the once-ness lives here).
 *
 * The first FIVE seams fire UNCONDITIONALLY. Step 6 fires the guided-setup routes
 * LOCAL-MODE ONLY — see the security gate at step 6. Steps 7–9 fire the data-API mount
 * seams (022a/022b/022c) UNCONDITIONALLY: each resolves its OWN already-mounted +
 * protected route group (`/api/memories`, `/memory`, `/api/goals`…), so there is no
 * `server.ts` edit and the fire order among them is unconstrained.
 */
export function assembleSeams(
	daemon: Daemon,
	storage: StorageClient,
	defaultScope: QueryScope,
	orgName: string | undefined,
	embed: EmbedAttachment,
	healthDetail: () => HealthDetail,
	localQueueConfig: HybridJobQueueConfig,
	localQueue: Pick<LocalJobQueueService, "persistent" | "counts">,
	workspaceDir: string,
	installedHarnesses: ReadonlySet<string>,
	logStore: LogStore,
	seams: SeamFns = defaultSeamFns,
	vault?: VaultSettingsReader,
	rerankerDeps?: RerankerMountDeps,
	projectsDir?: string,
): CaptureHandler {
	// The daemon's configured default tenancy scope (the single LOCAL tenant) is RESOLVED ONCE
	// at the composition root (`assembleDaemon`) from the SAME credential source the storage
	// client connected through, then THREADED in here — never re-resolved independently. (The
	// prior split, where the storage client read `~/.deeplake` but the scope re-read env, was
	// the bug: a plain login with no env resolved the scope to the `"local"` placeholder while
	// the client connected to the real org.) It is threaded into the three data-API mounts as
	// `defaultScope` so a loopback thin client (SDK/MCP) that carries NO `x-honeycomb-org`
	// header resolves to this tenant in local mode (PRD-022). In team/hybrid the data handlers
	// ignore it (the fallback fires ONLY in local mode), so threading it unconditionally is safe
	// — tenancy is never loosened outside local.

	// 1. /api/hooks/* capture (019b). The capture write enqueues per-turn cues into the
	//    REAL durable queue (a-AC-3 service), heals the `sessions` table lazily.
	//    NOTE (021c): the context + session-end hook endpoints are NOT attached here yet
	//    — 021c attaches them onto the same already-mounted `/api/hooks` group and
	//    021d/021e fill their handlers. This seam is written so those land cleanly.
	//    PRD-025 AC-2: the capture embed seam is the REAL `createEmbedAttachment` (D-1
	//    default-on), so a captured turn lands a non-NULL 768-dim `message_embedding`
	//    when embeddings are available; when not, the embedder returns null and the row
	//    lands lexically (NULL vector) — never a throw (the 005b null-on-failure floor).
	//    PRD-045a (a-AC-2): capture also enqueues the memory-pipeline ENTRY job
	//    (`memory_extraction`) onto the SAME durable queue, so a captured turn enters
	//    the extraction → decision → controlled-write → graph-persist pipeline. The
	//    enqueue is fail-soft in the capture handler (a pipeline enqueue failure never
	//    breaks the captured turn).
	// PRD-062c (AC-5 / AC-62c.1.2): hold the constructed capture handler so the graceful
	// shutdown path can FORCE-FLUSH its write buffer, draining any batched-but-unwritten
	// captured rows before the daemon stops (so a clean stop never loses a buffered event).
	const captureHandler = seams.attachHooks(daemon, {
		storage,
		queue: daemon.services.queue,
		embed,
		enqueuePipelineEntry: makePipelineEntryEnqueuer(daemon.services.queue),
		// PRD-059a / IRD-123: the first-run capture gate is ON in production. Until the active
		// workspace binds its first project (via the dashboard folder-picker or `honeycomb project
		// bind`), a capture NO-OPs rather than hoarding unscoped sessions in `__unsorted__`. The gate
		// reads the local `~/.deeplake/projects.json` cache (NO DeepLake call); once a project is bound
		// it opens and the 049a inbox fallback for unbound folders resumes (a-AC-4 / a-AC-5).
		firstRunGate: true,
		...(projectsDir !== undefined ? { projectsDir } : {}),
	});

	// 2. The dashboard data API (020b) — the daemon-served view-models. Threads the
	//    LOCAL default scope so the dashboard web app (a loopback thin client that sends no
	//    `x-honeycomb-org`) resolves the single local tenant instead of 400ing (PRD-024 Wave 3).
	//    NOTE (route-collision resolution): this seam no longer registers `GET /api/graph` — the
	//    codebase-graph view is owned solely by step 13's `mountGraph` (the freshest-LOCAL-snapshot
	//    read), so the "Build graph" re-read is immediate + consistent. The MEMORY-graph view this
	//    seam DOES serve lives at `/api/diagnostics/memory-graph` (a distinct path, no collision).
	seams.mountDashboard(daemon, { storage, defaultScope, orgName });

	// 3. The backend notifications API (020d) — the org's pending notifications.
	seams.mountNotifications(daemon, { storage });

	// 4. The sessions prune handler (020a) — paired trace+summary tombstones.
	//    SEAM (deferred, marked NOT faked): in team/hybrid the destructive prune needs a
	//    real `PruneActorAuthority` binding the requested actor to the authenticated
	//    identity. That actor↔identity binding is a follow-up (the "surface Identity to
	//    handlers" refactor). Until it lands, the seam's own fail-closed
	//    `denyUnboundActorAuthority` default applies (a multi-user prune is DENIED), which
	//    is the correct closed posture — never an open one. `local` mode (the first-class
	//    dogfood target, D-3) is single-user loopback and unaffected.
	seams.attachPrune(daemon, { storage });

	// 5. The /api/logs ring-buffer reader (021d / d-AC-2). Fires UNCONDITIONALLY — no
	//    security gate is needed because the `/api/logs` route group is already
	//    `protect:true` in `server.ts` (it inherits the same auth/RBAC middleware the
	//    JSON dashboard views enforce; in `local` mode that middleware is open per D-3).
	//    The record shape (`RequestLogRecord`) carries no token/header/body, so the read
	//    cannot leak a secret (security audit, /api/logs token-leak proof). The logger the
	//    handler reads is the daemon's own ring buffer.
	//    PRD-043a (FR-3): the durable store backs the additive `GET /api/logs/history` endpoint
	//    attached onto the SAME group. `GET /api/logs` + `/api/logs/stream` are UNCHANGED — they
	//    keep reading the in-memory ring buffer (D-3). The store is the no-op when persistence is
	//    unavailable (fail-soft), so history degrades to an empty page, never a throw.
	seams.mountLogs(daemon, { logger: daemon.logger, store: logStore });

	// 6. The guided-setup routes (PRD-050b/c/d) — LOCAL-MODE ONLY (security F-1).
	//    They attach onto the UNPROTECTED root group (`server.ts`: `{ path: "/", protect: false }`),
	//    so in team/hybrid they are never mounted and fall through to the root scaffold. The
	//    viewable dashboard SPA is served by thehive (ADR-0001); honeycomb keeps these setup
	//    API routes for the portal wire client and CLI fallbacks.
	if (daemon.config.mode === "local") {
		// 6a. The "First time setup" on-page login route — `POST /setup/login` (PRD-050c). Sits on
		//     the unprotected root group under the SAME local-mode gate (security F-1): in team/hybrid
		//     (security F-1): in team/hybrid it is never mounted and falls through to the root scaffold.
		//     Begins the device flow with the dual referral headers, returns user_code + URIs (no token),
		//     then polls → mints → persists the shared `~/.deeplake/credentials.json` (0600). Fail-soft —
		//     a mount error never crashes the daemon (guarded + present-only like the other newer seams).
		if (seams.mountSetupLogin !== undefined) {
			try {
				seams.mountSetupLogin(daemon);
			} catch {
				// A mount failure degrades the on-page login (the user falls back to the CLI), never crashes.
			}
		}
		// 6c. The pre-auth guided-setup STATE read — `GET /setup/state` (PRD-050b b-AC-2). Sits beside the
		//     dashboard host + setup-login on the SAME unprotected root group, so it shares the SAME local-mode
		//     gate (security F-1 / b-AC-4). It reports credential-dir presence + the onboarding phase/prior-tool
		//     + the derived `authenticated` bit + the embeddings warmup signal (b-AC-5) — install metadata only,
		//     NO token/secret. The daemon's REAL embed supervisor is threaded so the warmup signal is live (the
		//     supervisor backgrounds the warm wait — this is a pure read of its already-tracked state). Fail-soft:
		//     a mount error never crashes the daemon (guarded + present-only like the other newer seams).
		if (seams.mountSetupState !== undefined) {
			try {
				seams.mountSetupState(daemon, { embed: daemon.services.embed });
			} catch {
				// A mount failure degrades the guided-setup state read (the page falls back to a cold render), never crashes.
			}
		}
		// 6d. The Hivemind->Honeycomb migration routes - POST /setup/migrate-from-hivemind (+ /rollback)
		//     (PRD-050d). Beside the other setup routes on the SAME unprotected root group, under the SAME
		//     local-mode gate (security F-1 / d-AC). A SIBLING of the setup-state mount, NOT nested under it:
		//     the two seams are independently optional, so nesting would silently drop the migration routes in
		//     a seam fake that overrides only one of them. Backs up + uninstalls Hivemind idempotently,
		//     verify-and-adopts the shared credential (or signals needsLogin), advances a durable crash-recovery
		//     marker, and emits the upgrade telemetry on success only. Fail-soft - a mount error degrades the
		//     migration button (the user falls back to a manual uninstall + honeycomb login), never crashes.
		if (seams.mountSetupMigrate !== undefined) {
			try {
				seams.mountSetupMigrate(daemon);
			} catch {
				// A mount failure degrades the on-page migration (the user falls back to the CLI), never crashes.
			}
		}
	}

	// 7. The /api/memories/* data API (022a). Recall + store + get/list + reason-gated
	//    modify/forget land on the already-mounted, protected `/api/memories` SESSION
	//    group. PRD-025 AC-2: the store `embed` seam is the REAL `createEmbedAttachment`
	//    client (D-1 default-on) — a deliberately-stored memory lands a non-NULL 768-dim
	//    `content_embedding` when embeddings are available; when not, the embedder returns
	//    null and the row lands lexically (NULL vector), still recallable via the lexical
	//    arm. This replaces the PRD-004 501 scaffold: after this, `honeycomb recall`/
	//    `remember`, the SDK `recall()`, and the MCP `memory_search` reach a REAL handler.
	// PRD-029 (AC-4): thread the daemon's ring-buffer logger so a recall that runs DEGRADED
	// (lexical fallback) emits one structured `recall.degraded` event (mode + arm coverage;
	// no secret). Threaded here only — the recall HANDLER owns the emit; the engine is unchanged.
	// PRD-044c: thread the vault `setting`-class READER so the LIVE recall handler reads the
	// user-selected `recallMode` at recall time and honors it (`keyword` → lexical-only, NOT degraded).
	// Present-only spread — an absent vault (the deterministic suite) leaves the read path UNSET (no-op).
	// PRD-058b: the κ(m,t) gate's conflict-suppression source — recall drops the κ = ρ open-conflict loser
	// as the LAST currentness filter (the κ = 0 hard-superseded losers are already excluded by supersession).
	// FAIL-SOFT by construction: a missing/unreadable `memory_conflicts` table → no suppression (both sides
	// returned), never a 500. Threaded into the recall handler's engine deps.
	const conflictSuppression = createConflictSuppressionSource(storage);
	seams.mountMemories(daemon, {
		storage,
		defaultScope,
		embed: embed.client,
		logger: daemon.logger,
		conflictSuppression,
		...(vault !== undefined ? { vault } : {}),
		// PRD-063c: the operator-selected reranker config + the late-bound Cohere-via-Portkey seam.
		// The `cohere` strategy only does anything when BOTH the strategy is `cohere` (env) AND the
		// gateway is ON (the seam's inner transport is wired in `start()`); otherwise RRF / local
		// cosine, byte-identical to today (c-AC-4). Absent rerankerDeps (a unit mount) → engine default.
		...(rerankerDeps !== undefined ? { reranker: rerankerDeps.reranker, cohereRerank: rerankerDeps.cohereRerank } : {}),
	});

	// 7a-bis. The conflict-resolution endpoint (PRD-058b): `POST /api/memories/conflicts/:id/resolve`
	//    attaches onto the SAME `/api/memories` SESSION group, inheriting its auth/RBAC + session gate.
	//    The operator applies a verdict (supersede/review/keep-both); supersede version-bumps the loser
	//    (append-only, never a destructive delete), every path appends `memory_history` + projects the
	//    new state, and the read-back polls to convergence. Guarded + present-only (like the prime seam).
	if (seams.mountConflicts !== undefined) {
		seams.mountConflicts(daemon, { storage, defaultScope });
	}

	// 7a-ter. The lifecycle READ endpoints (PRD-058d): `GET /api/memories/conflicts`,
	//    `GET /api/memories/stale-refs`, `GET /api/memories/history?type=lifecycle` attach onto the
	//    SAME `/api/memories` SESSION group, inheriting its auth/RBAC + session gate. Reads-only +
	//    scope-enforced (org/workspace partition before any content) + paginated; every resolve still
	//    goes through the 058b POST endpoint above (058d defines NO new write path). Guarded +
	//    present-only (like the conflicts seam) so an out-of-scope fake `SeamFns` is unaffected.
	if (seams.mountLifecycle !== undefined) {
		seams.mountLifecycle(daemon, { storage, defaultScope });
	}

	// 7b. The session-priming PRIME digest (PRD-046c): `GET /api/memories/prime` attaches onto the
	//    SAME `/api/memories` SESSION group, inheriting its auth/RBAC + session gate. The prime is a
	//    PURE SQL skim (`skimPrimeKeys`, 046b) + a pure token-bounded/deduped assembly — NO embed,
	//    NO gate, NO vector at read time. A cold scope answers an honest empty digest, never a 500.
	//    Guarded + present-only (like the graph seam) so an out-of-scope fake `SeamFns` is unaffected.
	if (seams.mountMemoriesPrime !== undefined) {
		seams.mountMemoriesPrime(daemon, { storage, defaultScope });
	}

	// 8. The /memory/* VFS browse reads (022b). cat / grep / ls / find / classify attach
	//    onto the already-mounted `/memory` SESSION group; `recallConfig` defaults to the
	//    env-resolved recall config and `hints` to the empty source, so `{ storage }` is
	//    the full wiring. Read-only — writes 405 with a pointer to `/api/memories` (022a).
	seams.mountVfs(daemon, { storage, defaultScope });

	// 9. The product-data surface (022c): goals + kpis (read/upsert) + skills + rules
	//    (read-only) always; PLUS the names-only `/api/secrets` engine (012), whose store
	//    is cleanly constructible at the composition root; PLUS — PRD-045e — the sources
	//    registry + providers resolver + document worker, so `/api/sources` and
	//    `/api/documents` go LIVE (e-AC-1/e-AC-2/e-AC-3) instead of the PRD-013 501 scaffold.
	//    The sources deps reuse the daemon's OWN durable queue (`daemon.services.queue`,
	//    NOT a second queue) and embed client. FAIL-SOFT (e-AC-5): building the sources deps
	//    is wrapped so a registry/provider/worker construction error degrades to "no sources
	//    surface this run" (the 501 scaffold) rather than crashing the daemon.
	seams.mountProductData(
		daemon,
		resolveProductDataDeps(storage, defaultScope, daemon.services.queue, embed.client, daemon.config.mode),
	);

	// 10. The "Pollinate now" trigger — `POST /api/diagnostics/pollinate` (PRD-024 / AC-6 backend).
	//     Attaches onto the already-mounted, protected `/api/diagnostics` group (the dashboard's
	//     group), so there is NO `server.ts` edit and it inherits the same auth/RBAC the JSON
	//     dashboard views enforce (open in `local`, gated in team/hybrid). It kicks the REAL
	//     PRD-009 Pollinating loop via the 009a trigger seam, injected the daemon's OWN durable job
	//     queue (`daemon.services.queue`) as the enqueuer — NOT a second pollinating subsystem. The
	//     handler is NON-BLOCKING: the trigger only ENQUEUES a `pollinating` job (the consolidation
	//     pass is run later by the queue worker via the 009b/009c runner) and returns a 202 ack.
	//     The `defaultScope` is the daemon's tenancy partition the pollinating counter lives under
	//     (the same single local tenant the data-API mounts use). When the queue is the no-op stub
	//     (a bare `createDaemon`), the handler fails soft to a clean `{ triggered: false }` ack.
	seams.mountPollinate(daemon, { storage, defaultScope, enqueuer: daemon.services.queue });

	// 10b. The project registry → local-cache sync trigger — `POST /api/diagnostics/projects-sync`
	//     (PRD-049d). Attaches onto the same already-mounted, protected `/api/diagnostics` group (NO
	//     `server.ts` edit), inheriting the dashboard JSON views' auth/RBAC. It refreshes the
	//     thin-client `~/.deeplake/projects.json` cache from the workspace's `projects` registry under
	//     the resolved request scope (header org/workspace, else the daemon `defaultScope`), so the
	//     hot-path resolver matches the workspace's real projects offline. FAIL-SOFT: a registry-read
	//     failure leaves the prior cache intact and returns a clean ack — never a 500, never a crash.
	try {
		seams.mountProjectsSync(daemon, { storage, defaultScope });
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		process.stderr.write(`honeycomb: projects-sync route mount failed (non-fatal): ${reason}\n`);
	}

	// 11. The standalone version-history COMPACTION trigger — `POST /api/diagnostics/compact`
	//     (PRD-030 / D-2 PRIMARY). Attaches onto the same already-mounted, protected
	//     `/api/diagnostics` group (NO `server.ts` edit), so it inherits the dashboard JSON
	//     views' auth/RBAC (open in `local`, gated in team/hybrid). It runs the Wave-1
	//     version-history compactor over the allow-listed version-bumped tables under the
	//     daemon's `defaultScope` — the standalone maintenance path that runs REGARDLESS of
	//     premium pollinating. FAIL-SOFT: the mount resolves the retention config (which could
	//     throw on a malformed `HONEYCOMB_COMPACTION_*` knob) and registers the route; we wrap
	//     it so a mount/config error degrades to "no compaction route this run" rather than
	//     crashing the daemon (the standalone job is best-effort, never load-bearing for boot).
	try {
		seams.mountCompact(daemon, { storage, defaultScope });
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		process.stderr.write(`honeycomb: compaction route mount failed (non-fatal): ${reason}\n`);
	}

	// 11b. The PRD-058c stale-reference diagnostic trigger: `POST /api/diagnostics/stale-refs`.
	//      Attaches onto the SAME already-mounted, protected `/api/diagnostics` group (NO `server.ts`
	//      edit), inheriting the dashboard JSON views' auth/RBAC. It runs the staleness diagnostic over
	//      the daemon-scope memories against the CONVERGED local codebase-graph snapshot (poll-to-
	//      convergence), writing `ref_status` / `verified_at` / `stale_refs` + a `memory_history` row,
	//      gated by the request posture (`observe` default = detection visible-but-inert; `execute` =
	//      the recall demotion is live). FAIL-SOFT: a mount error never crashes the daemon, and a
	//      missing graph oracle marks NOTHING stale (everything `unknown`), never a mass-flag.
	try {
		seams.mountStaleRef(daemon, { storage, defaultScope, workspaceDir });
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		process.stderr.write(`honeycomb: stale-ref route mount failed (non-fatal): ${reason}\n`);
	}

	// 12. The protected per-subsystem health detail — `GET /api/diagnostics/health` (PRD-029 /
	//     AC-3 / D-2). Attaches onto the same already-mounted, protected `/api/diagnostics`
	//     group (NO `server.ts` edit), so it inherits the dashboard JSON views' auth/RBAC (open
	//     in `local`, gated in team/hybrid). It serves the FULL {@link HealthDetail} (status +
	//     `reasons`) — the topology the PUBLIC `/health` withholds from an unauthenticated remote
	//     in team/hybrid. A synchronous read of the cached health bit + assembly-known embed
	//     state (the `healthDetail` thunk) — NO new probe (D-4).
	seams.mountDiagnosticsHealth(daemon, { healthDetail });

	if (seams.mountLocalQueueDiagnostics !== undefined) {
		try {
			const includePendingSharedLocalJobs =
				localQueueConfig.drainSharedLocalKinds ||
				parseLocalQueueDiagnosticsSharedFlag(process.env.HONEYCOMB_LOCAL_QUEUE_DIAGNOSTICS_INCLUDE_SHARED);
			const pendingSharedLocalJobs = includePendingSharedLocalJobs
				? () => countPendingSharedLocalJobs({ storage, scope: defaultScope, localKinds: localQueueConfig.localKinds })
				: undefined;
			seams.mountLocalQueueDiagnostics(daemon, {
				config: localQueueConfig,
				localQueue,
				topology: resolveLocalQueueTopology(),
				pendingSharedLocalJobs,
				queryMeter: () => ({ snapshot: storage.meterSnapshot(), logLine: storage.meterLogLine() }),
			});
		} catch (err: unknown) {
			const reason = err instanceof Error ? err.message : String(err);
			process.stderr.write(`honeycomb: local queue diagnostics mount failed (non-fatal): ${reason}\n`);
		}
	}

	// 13. The codebase-graph build + read surface — `POST /api/graph/build` + `GET /api/graph`
	//     (PRD-014 assembly wiring, CONVENTIONS §11). Attaches onto the already-mounted, protected
	//     `/api/graph` group (NO `server.ts` edit), so it inherits the dashboard JSON views'
	//     auth/RBAC (open in `local`, gated in team/hybrid). SINGLE OWNER of `GET /api/graph` (the
	//     dashboard seam's former DeepLake-read handler was retired — route-collision resolution):
	//     the GET returns the FULL `{ built, nodes, edges }` GraphView from the freshest LOCAL
	//     snapshot (the authoritative copy `POST /build` writes via `writeSnapshotAtomic`), so the
	//     PRD-041a "Build graph" re-read is immediate + consistent (no DeepLake eventual-consistency
	//     flap). This is the DEFERRED daemon-assembly
	//     seam the codebase worker (014a/b/c) needed: the build pipeline (discover → tree-sitter
	//     extract → snapshot → push) was built + tested but never INVOKED by the live daemon, so
	//     `honeycomb graph build` 501'd. Firing it here turns the 501 into a real end-to-end build
	//     — the local snapshot is authoritative and the cloud push runs best-effort through THIS
	//     storage client (the only DeepLake path), honoring the 014c SELECT-before-INSERT drift
	//     semantics. The `workspaceDir` is the daemon's watched workspace (the checkout to graph);
	//     `defaultScope` lets a loopback thin client resolve the single local tenant. FAIL-SOFT: a
	//     mount error must NEVER crash the daemon — the surface stays unmounted this run (falls
	//     through to the 501 scaffold), exactly the posture the other mounts use.
	if (seams.mountGraph !== undefined) {
		try {
			seams.mountGraph(daemon, { storage, defaultScope, workspaceDir });
		} catch (err: unknown) {
			const reason = err instanceof Error ? err.message : String(err);
			process.stderr.write(`honeycomb: graph API mount failed (non-fatal): ${reason}\n`);
		}
	}

	// 14. The harness registry + last-seen telemetry endpoint — `GET /api/diagnostics/harnesses`
	//     (PRD-039a, the data backbone). Attaches onto the same already-mounted, protected
	//     `/api/diagnostics` group (NO `server.ts` edit), so it inherits the dashboard JSON views'
	//     auth/RBAC (open in `local`, gated in team/hybrid). It is the SINGLE source the Harnesses
	//     page (039b/039c) AND PRD-038's home strip read (parent D-3): all six canonical harnesses
	//     every call, `installed` from the daemon's known harness-sync target set (the cheap cached
	//     presence check, OQ-1 — NOT a per-request spawn), activity from ONE guarded `sessions`
	//     GROUP BY (fail-soft, never a 500). FAIL-SOFT: a mount error must NEVER crash the daemon —
	//     the surface stays unmounted this run (falls through to the 501 scaffold).
	if (seams.mountHarness !== undefined) {
		try {
			seams.mountHarness(daemon, { storage, defaultScope, installedHarnesses });
		} catch (err: unknown) {
			const reason = err instanceof Error ? err.message : String(err);
			process.stderr.write(`honeycomb: harness API mount failed (non-fatal): ${reason}\n`);
		}
	}

	// 15. The Sync page data + action surface — `GET /api/diagnostics/assets` + `POST
	//     /api/diagnostics/sync/{promote,pull,demote,enable,disable}` (PRD-042). Attaches onto the same
	//     already-mounted, protected `/api/diagnostics` group (NO `server.ts` edit), so it inherits the
	//     dashboard JSON views' auth/RBAC (open in `local`, gated in team/hybrid). The view-model is the
	//     `installed ∪ synced` union (skills + agents); the actions invoke the REAL substrate pipelines
	//     (publish/pull/tombstone via `createAssetSyncApi`) + the local install-target write, confirming
	//     each on a poll-convergent read-back (never an optimistic flip). The `defaultScope` backfills a
	//     loopback thin client's tenancy in local mode; team/hybrid take it from the validated Identity.
	//     FAIL-SOFT: a mount error must NEVER crash the daemon — the surface stays unmounted this run.
	if (seams.mountSync !== undefined) {
		try {
			seams.mountSync(daemon, { storage, defaultScope, mode: daemon.config.mode });
		} catch (err: unknown) {
			const reason = err instanceof Error ? err.message : String(err);
			process.stderr.write(`honeycomb: sync API mount failed (non-fatal): ${reason}\n`);
		}
	}

	// 16. The knowledge-graph / ontology READ + reason-gated MUTATION surface — `GET
	//     /api/ontology/{entities,edges,claims,assertions}` + `POST /api/ontology/proposals`
	//     (PRD-045c, closing the PRD-008 daemon-wiring gap). Attaches onto the already-mounted,
	//     protected `/api/ontology` group (server.ts:88; NO `server.ts` edit), so it inherits the
	//     dashboard JSON views' auth/RBAC (open in `local`, gated in team/hybrid). This turns the
	//     ontology 501 scaffold into a LIVE read surface (c-AC-2) and gives the control-plane apply
	//     a live mutation path INDEPENDENT of the dormant pollinating runner (c-AC-4). The `/api/ontology`
	//     group has a SINGLE owner — no other mount registers any `/api/ontology/*` path — so there is
	//     no route collision (the same single-owner rule that resolved the `/api/graph` double-registration:
	//     `GET /api/graph` is served ONLY by step 13's `mountGraph`; `mountDashboard` no longer claims it).
	//     FAIL-SOFT (c-AC-5): a mount error must NEVER crash the daemon — the surface stays unmounted
	//     this run (falls through to the 501 scaffold), exactly the posture the other mounts use.
	if (seams.mountOntology !== undefined) {
		try {
			seams.mountOntology(daemon, { storage, defaultScope });
		} catch (err: unknown) {
			const reason = err instanceof Error ? err.message : String(err);
			process.stderr.write(`honeycomb: ontology API mount failed (non-fatal): ${reason}\n`);
		}
	}

	// 17. The team skill-sharing PUBLISH + PULL surface — `POST /api/skills` (versioned publish) +
	//     `POST /api/skills/{pull,scope,unpull,force}` (PRD-045g, closing the PRD-018 daemon-wiring
	//     gap). Attaches onto the already-mounted, protected `/api/skills` group (server.ts:83; NO
	//     `server.ts` edit), so it inherits the dashboard JSON views' auth/RBAC (open in `local`,
	//     gated in team/hybrid). PRD-018 BUILT `createSkillPublishEndpoint` + the thin-client pull +
	//     symlink fan-out but NEVER mounted an HTTP route, so a republish could not land via the
	//     daemon (g-AC-1) and the CLI's `POST /api/skills/pull` hit an UNMOUNTED path (g-AC-5). Firing
	//     this turns both into REAL routes: publish lands a versioned row; pull runs the real team
	//     pull + cross-harness symlink fan-out into the detected agent roots (idempotent + fail-soft).
	//     NO collision with `GET /api/skills` (owned by `mountProductData` step 9): this registers
	//     ONLY POST verbs onto the same group. FAIL-SOFT: a mount error must NEVER crash the daemon —
	//     the surface stays unmounted this run (the CLI pull falls back to the 501/404 scaffold).
	if (seams.mountSkillPropagation !== undefined) {
		try {
			seams.mountSkillPropagation(daemon, { storage, defaultScope });
		} catch (err: unknown) {
			const reason = err instanceof Error ? err.message : String(err);
			process.stderr.write(`honeycomb: skill propagation API mount failed (non-fatal): ${reason}\n`);
		}
	}

	// PRD-062c (AC-5 / AC-62c.1.2): return the capture handler so the composition root can
	// force-flush its write buffer in the graceful-shutdown path (drain batched-but-unwritten rows).
	return captureHandler;
}

/**
 * Build the product-data seam deps (022c) the composition root can construct TODAY.
 *
 * - `storage`: the live client (goals/kpis/skills/rules read+write through it).
 * - `secrets`: the names-only secrets engine (012). Its only dep is a {@link SecretsStore}
 *   constructed from `$HONEYCOMB_WORKSPACE` (the workspace root the `.secrets/` dir lives
 *   under) + the real machine-key provider — both available at assembly. No value ever
 *   crosses the HTTP boundary (the API mounts no value-returning route by construction).
 * - `sources`: WIRED (PRD-045e — the deferred-assembly seam PRD-013 left). The existing
 *   `mountSourcesApi` (013) + `mountDocumentsApi` (013b) need a `registry` + a `providers`
 *   resolver + a document worker that are NOW constructible at the composition root via the
 *   small assembly helper {@link buildSourcesApiDeps}: a durable `DeeplakeSourceRegistry`
 *   (configs stored in the EXISTING `memory_artifacts` table — no new schema), the
 *   `createSourceProviderResolver` (Obsidian live; Discord/GitHub fail-soft without creds),
 *   and the REAL 013b document worker — all over the daemon's OWN storage + scope + durable
 *   queue (reused, NOT a second queue). FAIL-SOFT (e-AC-5): a construction error degrades to
 *   "no sources surface this run" (the 501 scaffold) rather than crashing the daemon, so the
 *   sources wiring can never take the daemon down.
 */
function resolveProductDataDeps(
	storage: StorageClient,
	defaultScope: QueryScope,
	queue: DaemonServices["queue"],
	embed: EmbedClient,
	mode: DeploymentMode,
): {
	storage: StorageClient;
	secrets?: SecretsApiDeps;
	sources?: SourcesApiDeps;
	defaultScope: QueryScope;
} {
	// The secrets store base dir is the workspace root ($HONEYCOMB_WORKSPACE), defaulting to
	// the daemon's cwd when unset (the same default the secrets CONVENTIONS document). Routed
	// through the HARDENED resolver so a detached daemon that inherited a non-writable cwd
	// (the `C:\WINDOWS\system32` footgun) falls back to `~/.honeycomb` instead of 502ing every
	// secret save — see {@link resolveWorkspaceBaseDir}.
	const baseDir = resolveWorkspaceBaseDir();
	const secrets: SecretsApiDeps = {
		store: new SecretsStore({ baseDir, machineKey: createMachineKeyProvider() }),
		// PRD-022 local-mode default: the dashboard's `GET /api/secrets` (names-only) carries no
		// `x-honeycomb-org` header, so resolve the daemon's single local tenant instead of 400ing.
		// Team/hybrid stay fail-closed (a missing org still 400s) — cross-tenant access is rejected.
		scope: localDefaultScopeResolver(mode, defaultScope),
	};

	// PRD-045e: build the sources deps (registry + providers resolver + document worker)
	// FAIL-SOFT. A construction throw must NEVER crash the daemon — degrade to no sources
	// surface (the 501 scaffold) and surface the reason to stderr, the posture every other
	// fail-soft mount uses. The registry + worker bind to the daemon's `defaultScope` (the
	// single local-mode tenant); the API's header resolver still 400s fail-closed on a
	// missing org, so cross-tenant access is rejected at the edge.
	let sources: SourcesApiDeps | undefined;
	try {
		sources = buildSourcesApiDeps({ storage, scope: defaultScope, queue, embed });
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		process.stderr.write(`honeycomb: sources deps build failed (non-fatal): ${reason}\n`);
		sources = undefined;
	}

	// `defaultScope` is threaded so goals/kpis/skills/rules apply the local-mode fallback
	// (PRD-022); the secrets/sources sub-handlers carry their own header scope resolvers.
	return {
		storage,
		secrets,
		...(sources !== undefined ? { sources } : {}),
		defaultScope,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// The daemon-resident pollinating WORKER wiring (PRD-026 AC-W + AC-T) — gated OFF.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The default workspace base dir the daemon resolves filesystem state under
 * (`$HONEYCOMB_WORKSPACE`, defaulting to the daemon's cwd). This is the SINGLE source the
 * `.secrets/` store (PRD-012a), the secrets API mount ({@link resolveProductDataDeps}), and
 * the inference {@link AGENT_CONFIG_FILE_NAME} all resolve under, so the `agent.yaml` the
 * operator edits and the `.secrets/` dir its `${ANTHROPIC_API_KEY}` ref decrypts from agree
 * on ONE root. Memoized — probed at most once.
 *
 * ── The `C:\WINDOWS\system32` footgun (the hardening) ────────────────────────
 * A daemon spawned DETACHED inherits the spawner's cwd. On Windows a CLI launched from a
 * service / stray shell commonly sits in `C:\WINDOWS\system32`, a root a normal user CANNOT
 * write. Resolving `process.cwd()` blindly there makes every `.secrets/` + `.daemon/` write
 * EACCES — which surfaces as a 502 `store_failed` on the first provider-key save, with the
 * audit/log writes failing silently (no trail). So we PROBE the candidate for real writability
 * and fall back to the guaranteed-writable `~/.honeycomb` runtime dir (which already holds the
 * pid/lock + machine-key). The CLI spawn (`src/cli/runtime.ts`) ALSO pins a writable workspace,
 * so this is defense-in-depth for a daemon brought up by any other launcher.
 */
let workspaceBaseDirMemo: string | undefined;
function resolveWorkspaceBaseDir(): string {
	if (workspaceBaseDirMemo !== undefined) return workspaceBaseDirMemo;
	const fromEnv = process.env.HONEYCOMB_WORKSPACE;
	const candidate = fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : process.cwd();
	if (isWritableDir(candidate)) {
		workspaceBaseDirMemo = candidate;
		return candidate;
	}
	const fallback = join(homedir(), ".honeycomb");
	process.stderr.write(
		`honeycomb: workspace "${candidate}" is not writable; using "${fallback}" for filesystem state (secrets, logs, agent.yaml)\n`,
	);
	// Best-effort ensure the fallback exists; even if this throws, return it — the individual
	// stores are themselves fail-soft and will surface their own error rather than crash boot.
	try {
		mkdirSync(fallback, { recursive: true, mode: DIR_MODE });
	} catch {
		// ignore — a home dir this broken is beyond what this resolver can repair
	}
	workspaceBaseDirMemo = fallback;
	return fallback;
}

/**
 * Probe a directory for REAL writability via a create-write-unlink round-trip. `accessSync(W_OK)`
 * is unreliable on Windows (it inspects the read-only ATTRIBUTE, not the ACL — `system32` reads as
 * "writable" and then EACCESes on the actual write), so an actual probe is the only cross-platform
 * truth. Creates the dir (recursive) if absent so a fresh-but-writable workspace passes; any throw
 * (EACCES / EPERM / EROFS) → `false`.
 */
function isWritableDir(dir: string): boolean {
	try {
		mkdirSync(dir, { recursive: true });
		// Probe with an EXCLUSIVE, randomly-suffixed temp dir (mkdtemp guarantees a fresh name) so
		// the check only ever creates + removes a path it owns — a deterministic `${pid}` marker
		// could collide with a real workspace file and truncate/delete it.
		const probe = mkdtempSync(join(dir, ".honeycomb-write-test-"));
		rmSync(probe, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

function parseLocalQueueDiagnosticsSharedFlag(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * Resolve the path the daemon reads its `inference:` block from (PRD-026 AC-T): the
 * injected override when a test supplies one, else `agent.yaml` under the workspace root.
 * Returned as a path so {@link buildInferenceModelClient} loads it lazily (and degrades to
 * the no-op client when the file or block is absent — never a throw).
 */
function resolveAgentConfigPath(options: AssembleDaemonOptions): string {
	return options.agentConfigPath ?? join(resolveWorkspaceBaseDir(), AGENT_CONFIG_FILE_NAME);
}

/**
 * Lift the daemon's resolved {@link QueryScope} (`{ org, workspace? }`) onto the
 * {@link SecretScope} the inference secret resolver decrypts the `${ANTHROPIC_API_KEY}` ref
 * under. The org rides through unchanged; an absent `workspace` defaults to `"default"`,
 * matching the no-creds tenancy fallback ({@link resolveDaemonTenancy} step (c)). THIS is
 * the scope the operator/smoker MUST store the Anthropic key under for the resolver to find
 * it — it is the daemon's OWN tenancy, never a per-request identity.
 */
function secretScopeFromQueryScope(scope: QueryScope): SecretScope {
	return { org: scope.org, workspace: scope.workspace ?? "default" };
}

// ─────────────────────────────────────────────────────────────────────────────
// The vault `setting`-class READ path (PRD-032d / AC-6) — vault wins, fail-soft.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `setting`-class keys the wire-back READS (AC-6). These are the SAME keys the CLI (032b)
 * + dashboard (032c) WRITE via `/api/settings` (the catalog-validated `activeProvider` /
 * `activeModel`, and the pollinating toggle `pollinating.enabled`) — single-sourced so a setting
 * written by a surface is the setting assembly reads. The wire-back is READ-ONLY (D-5): it
 * never writes a setting and never generates `agent.yaml`.
 */
export const VAULT_PROVIDER_KEY = "activeProvider" as const;
export const VAULT_MODEL_KEY = "activeModel" as const;
export const VAULT_POLLINATING_ENABLED_KEY = "pollinating.enabled" as const;

/**
 * The PRD-063b Portkey gateway `setting`-class keys the wire-back READS. These are the SAME keys
 * the Settings surface (063a) WRITES via `/api/settings` (`KNOWN_SETTING_KEYS` in `vault/api.ts`)
 * — single-sourced so a toggle written by a surface is the toggle assembly reads. The read is
 * READ-ONLY + fail-soft, exactly like the provider/model + pollinating reads.
 */
export const VAULT_PORTKEY_ENABLED_KEY = "portkey.enabled" as const;
export const VAULT_PORTKEY_CONFIG_KEY = "portkey.config" as const;
export const VAULT_PORTKEY_FALLBACK_KEY = "portkey.fallbackToProvider" as const;

/**
 * Construct the daemon's vault `setting`-class READER (AC-6), reusing the SAME workspace base
 * dir + machine-key provider the secrets store uses and a fresh default registry (the built-in
 * `secret` + `setting` classes). This is the ONE place assembly builds the vault; it is shared
 * by the `/api/settings` mount and the provider/model + pollinating reads, so the surface the
 * CLI/dashboard write through and the source assembly reads are byte-identical. Pure
 * construction — no IO until a `getSetting` call. A test injects {@link AssembleDaemonOptions.vault}
 * to bypass this entirely.
 */
/**
 * The trusted-table probe the `/api/assets` pull consults BEFORE its SELECT (PRD-033c
 * FR-7). The daemon's known-table set IS the in-memory `CATALOG` (no live round-trip),
 * so this resolves the table names synchronously from the catalog — `synced_assets` is
 * a member, so the production pull never skips on a catalog-known table; the skip path
 * exists for symmetry with the thin-client trusted-table list (a fresh workspace where
 * the physical table is not yet healed is handled by the engine's fail-soft empty read).
 */
function catalogTrustedTableProbe(): TrustedTableProbe {
	const names = CATALOG.map((t) => t.name);
	return { tables: () => Promise.resolve(names) };
}

function buildVaultStore(): VaultStore {
	return new VaultStore({
		baseDir: resolveWorkspaceBaseDir(),
		machineKey: createMachineKeyProvider(),
		registry: createVaultRegistry(),
	});
}

/**
 * READ the vault-driven provider/model SELECTION (AC-6 / FR-1), fail-soft. Returns a
 * {@link ProviderModelOverride} ONLY when BOTH `activeProvider` and `activeModel` are present
 * in the `setting` class AND the pair validates against the catalog (the same gate the API
 * applied on write — defense in depth). Absent either key, an unreadable vault, or a pair the
 * catalog rejects → `undefined` (the `agent.yaml` selection stands, no regression). NEVER
 * throws: any vault/decrypt error degrades to `undefined`.
 */
async function readProviderModelOverride(
	vault: VaultSettingsReader | undefined,
	scope: SecretScope,
): Promise<ProviderModelOverride | undefined> {
	if (vault === undefined) return undefined;
	try {
		const provRes = await vault.getSetting(VAULT_PROVIDER_KEY, scope);
		const modelRes = await vault.getSetting(VAULT_MODEL_KEY, scope);
		if (!provRes.ok || !modelRes.ok) return undefined;
		const provider = String(provRes.value);
		const model = String(modelRes.value);
		// Catalog-validate the pair (an unknown provider, or a model not in a closed-list
		// provider's catalog, is ignored rather than fed to the router).
		if (providerEntry(provider) === undefined) return undefined;
		if (!isValidProviderModel(provider, model)) return undefined;
		return { provider, model };
	} catch {
		// A malformed/undecryptable vault setting must never block boot — fall back to agent.yaml.
		return undefined;
	}
}

/**
 * READ the Portkey gateway SELECTION (PRD-063b) from the vault `setting` class, fail-soft. Returns a
 * {@link PortkeySelection} ONLY when the gateway is ON (`portkey.enabled === true`) AND a non-empty
 * `portkey.config` id is present (063a validates the id non-empty on write when enabled; we re-check
 * here as defense in depth). The requested `model` is the SAME vault `activeModel` the per-provider
 * path reads (D-2). `fallbackToProvider` reads `portkey.fallbackToProvider` (default false, D-3).
 *
 * Returns `undefined` when the gateway is off, the config id is missing/empty, or the vault is
 * unreadable — in every case the per-provider path stands UNCHANGED (b-AC-5). NEVER throws: any
 * vault/decrypt error degrades to `undefined`. This reader NEVER touches `PORTKEY_API_KEY` (a
 * `secret`-class value the setting accessor cannot read anyway); the key presence is checked at the
 * factory via the names-only secret listing, so a missing key surfaces as the honest `unconfigured`
 * health status, not a here-and-now failure.
 */
async function readPortkeySelection(
	vault: VaultSettingsReader | undefined,
	scope: SecretScope,
): Promise<PortkeySelection | undefined> {
	if (vault === undefined) return undefined;
	try {
		const enabledRes = await vault.getSetting(VAULT_PORTKEY_ENABLED_KEY, scope);
		const enabled = enabledRes.ok && coerceSettingBool(enabledRes.value);
		if (!enabled) return undefined;
		const configRes = await vault.getSetting(VAULT_PORTKEY_CONFIG_KEY, scope);
		const config = configRes.ok ? String(configRes.value) : "";
		if (config.length === 0) return undefined;
		const modelRes = await vault.getSetting(VAULT_MODEL_KEY, scope);
		const model = modelRes.ok ? String(modelRes.value) : "";
		const fallbackRes = await vault.getSetting(VAULT_PORTKEY_FALLBACK_KEY, scope);
		const fallbackToProvider = fallbackRes.ok && coerceSettingBool(fallbackRes.value);
		return { enabled: true, config, model, fallbackToProvider };
	} catch {
		// A malformed/undecryptable vault setting must never block boot — the per-provider path stands.
		return undefined;
	}
}

/**
 * Derive the ASSEMBLY-TIME Portkey health status (PRD-063b / b-AC-7) from config + a names-only
 * `PORTKEY_API_KEY` presence check — NO network probe (the `unreachable` state is supplied LATER by
 * the runtime last-failure signal, never fabricated here). Mirrors the factory's fail-closed rule:
 *   - selection absent / gateway off → `off` (the per-provider path is in force).
 *   - gateway on, `PORTKEY_API_KEY` PRESENT → `ok`.
 *   - gateway on, key ABSENT → `unconfigured` (fail-closed; no provider key is silently used).
 *
 * The presence check lists secret NAMES (never reads a value) under the daemon scope, using the SAME
 * `.secrets/` store the factory + resolver use. For a hermetic test assembly (injected `storage`, so
 * `portkeySelection` is `undefined`) this returns `off` WITHOUT touching the real workspace. NEVER
 * throws: any store error degrades to `unconfigured` (on) — never a false `ok`.
 */
async function resolvePortkeyAssemblyStatus(
	selection: PortkeySelection | undefined,
	scope: QueryScope,
): Promise<PortkeyHealth> {
	if (selection === undefined || !selection.enabled) return "off";
	try {
		const secretsStore = new SecretsStore({
			baseDir: resolveWorkspaceBaseDir(),
			machineKey: createMachineKeyProvider(),
		});
		const names = secretsStore.listSecretNames(secretScopeFromQueryScope(scope));
		return names.includes(PORTKEY_API_KEY_NAME as (typeof names)[number]) ? "ok" : "unconfigured";
	} catch {
		// A secrets-store error must never block boot and must never report a false `ok`.
		return "unconfigured";
	}
}

/**
 * Resolve the EFFECTIVE pollinating-enabled flag (AC-6 / FR-3 / d-AC-2), VAULT-FIRST. Precedence:
 *   1. the vault `setting` `pollinating.enabled` when PRESENT + readable → it WINS (a vault
 *      `true` enables pollinating WITHOUT `HONEYCOMB_POLLINATING_ENABLED`; a vault `false` disables
 *      it even when the env says true — vault-first is the documented precedence);
 *   2. else the env-resolved `resolvePollinatingConfig().enabled` (the `HONEYCOMB_POLLINATING_ENABLED`
 *      fallback, PRD-026 behavior preserved).
 * Returns the boolean to gate on, plus whether the vault decided it (for clarity at the call
 * site). NEVER throws: an unreadable/missing vault setting yields `decidedByVault: false` and
 * the caller uses the env fallback.
 */
async function readVaultPollinatingEnabled(
	vault: VaultSettingsReader | undefined,
	scope: SecretScope,
): Promise<{ decidedByVault: boolean; enabled: boolean }> {
	if (vault === undefined) return { decidedByVault: false, enabled: false };
	try {
		const res = await vault.getSetting(VAULT_POLLINATING_ENABLED_KEY, scope);
		if (!res.ok) return { decidedByVault: false, enabled: false };
		// The `setting` value schema is a scalar; coerce a string/number/boolean to a bool the
		// same way the env BoolFlag does (`true`/`1` → true) so a dashboard-written string or a
		// CLI-written boolean both behave.
		const enabled = coerceSettingBool(res.value);
		return { decidedByVault: true, enabled };
	} catch {
		return { decidedByVault: false, enabled: false };
	}
}

/**
 * Resolve the BOOT embeddings-enabled decision (dashboard actions), VAULT-FIRST. Precedence:
 *   1. the vault `setting` `embeddings.enabled` when PRESENT + readable → it WINS (a user's saved
 *      dashboard choice persists across restarts);
 *   2. else the env-resolved `resolveEmbedClientOptions().enabled` (the `HONEYCOMB_EMBEDDINGS`
 *      opt-out, default-on — the prior behaviour, preserved when no preference was ever saved).
 * NEVER throws: an unreadable/missing setting (a fresh vault, no creds) degrades to the env/default.
 * The runtime `setEnabled` toggle can flip the live state afterward (and persists it for next boot).
 */
async function readBootEmbeddingsEnabled(vault: VaultSettingsReader | undefined, scope: SecretScope): Promise<boolean> {
	if (vault !== undefined) {
		try {
			const res = await vault.getSetting(EMBEDDINGS_ENABLED_KEY, scope);
			if (res.ok) return coerceSettingBool(res.value);
		} catch {
			// fall through to the env/default below
		}
	}
	return resolveEmbedClientOptions().enabled;
}

/** Coerce a scalar `setting` value (boolean | number | string) to a boolean (`true`/`1` → true). */
function coerceSettingBool(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value === 1;
	if (typeof value === "string") return value === "true" || value === "1";
	return false;
}

/**
 * The Portkey gateway deps the worker builders thread into {@link buildInferenceModelClient}
 * (PRD-063b). `selection` is the resolved {@link PortkeySelection} (absent → the per-provider path
 * stands unchanged, b-AC-5); `onUnreachable` is assembly's cached last-failure observer the Portkey
 * transport calls on a real connect/auth failure so `/health` reports `unreachable` (b-AC-7).
 */
interface PortkeyWorkerDeps {
	/** The resolved Portkey selection, or absent when the gateway is off / not configured. */
	readonly selection?: PortkeySelection;
	/** Assembly's last-failure observer (flips `reasons.portkey` to `unreachable`). Total + non-throwing. */
	readonly onUnreachable: (statusCode: number) => void;
}

/**
 * PRD-063c: the rerank deps the composition root threads into the `/api/memories/recall` mount. The
 * `reranker` config carries the operator-selected strategy (`HONEYCOMB_RECALL_RERANKER`, e.g.
 * `cohere`) + the timeouts/window/model; `cohereRerank` is the STABLE late-bound Cohere-via-Portkey
 * seam (its inner transport is wired inside `start()` only when the gateway is ON). Absent → the
 * engine applies the DEFAULT (`none`, RRF-only), byte-identical to today (c-AC-4).
 */
interface RerankerMountDeps {
	/** The env-resolved reranker config (strategy + timeouts + window + cohere model). */
	readonly reranker: import("./recall/config.js").RerankerConfig;
	/** The stable late-bound Cohere-via-Portkey rerank seam (consumed by shape). */
	readonly cohereRerank: CohereRerankSeam;
}

/**
 * Build the gated pollinating subsystem (AC-W + AC-T) — the real inference {@link ModelClient}
 * + the real {@link PollinatingTrigger} + the {@link PollinatingJobWorker} — and return the worker
 * to START, or `null` when pollinating is disabled.
 *
 * ── Fail-soft is the whole contract (D-1) ────────────────────────────────────
 * Nothing here may prevent the daemon from booting. The pollinating config is resolved inside a
 * try/catch (a fat-fingered `HONEYCOMB_POLLINATING_*` knob degrades to "disabled", never a
 * throw); when disabled NONE of the heavy bits (model client, trigger, worker) are even
 * constructed. The model client is built via {@link buildInferenceModelClient}, which NEVER
 * throws — an absent/unparseable `agent.yaml` yields the no-op client, so the worker simply
 * produces zero-mutation passes until the operator adds the `inference:` block + key.
 *
 * ── The pendingTerminal probe choice (FR-6) ──────────────────────────────────
 * The trigger's single-pending guard wants a probe that resolves a `pollinating` job's terminal
 * state from `memory_jobs`. The public {@link JobQueueService} interface exposes NO
 * status-by-id read (only enqueue/lease/complete/fail) — the converging `resolveCurrent`
 * read is private. So we DO NOT pass a `pendingTerminal` and the trigger applies its
 * documented conservative default: never report terminal, i.e. never enqueue a SECOND pass on
 * a guess. The worker clears `pending_job_id` itself on a completed pass (via
 * `recordPassComplete`), so a finished pass un-wedges the scope through the normal path; only
 * a hard-crashed pass would wait for a later mechanism, which is the safe posture.
 *
 * @returns the constructed-but-NOT-started worker when `enabled`, else `null`.
 */
async function buildGatedPollinatingWorker(
	options: AssembleDaemonOptions,
	storage: StorageClient,
	scope: QueryScope,
	queue: DaemonServices["queue"],
	vault: VaultSettingsReader | undefined,
	backoff: PollBackoffConfig,
	portkeyDeps?: PortkeyWorkerDeps,
): Promise<PollinatingJobWorker | null> {
	// Resolve the env gate fail-soft FIRST: a malformed pollinating-config knob must NEVER take the
	// daemon down — treat it as disabled (the false-safe default the schema already documents).
	let config: ReturnType<typeof resolvePollinatingConfig>;
	try {
		config = resolvePollinatingConfig(options.pollinatingConfigProvider);
	} catch {
		return null;
	}

	// PRD-032d / AC-6 (d-AC-2): the pollinating-enabled decision is VAULT-FIRST. When the vault
	// `setting` `pollinating.enabled` is present it WINS (a vault `true` enables pollinating WITHOUT
	// the env var; a vault `false` disables it even when the env says true). Absent a vault
	// setting we fall back to the env-resolved `config.enabled` (PRD-026 behavior preserved).
	// This read is fail-soft — an unreadable vault degrades to the env fallback, never a throw.
	const vaultPollinating = await readVaultPollinatingEnabled(vault, secretScopeFromQueryScope(scope));
	const effectiveEnabled = vaultPollinating.decidedByVault ? vaultPollinating.enabled : config.enabled;

	// GATE (D-1, default OFF): the gate is checked BEFORE any worker is returned — even an
	// INJECTED test worker is NOT started when disabled (the gate is the contract, not the
	// injection). When disabled, construct NOTHING heavy — no model client, no trigger, no
	// worker. Re-enabling later resumes from the accumulated counter.
	if (!effectiveEnabled) {
		return null;
	}

	// Past the gate (enabled): an explicit test override replaces the real build (a recording
	// fake to assert start/stop, or `null` to assert "enabled but no worker constructed").
	// Production leaves it unset → the real build below runs.
	if (options.pollinatingWorker !== undefined) {
		return options.pollinatingWorker;
	}

	// PRD-032d / AC-6 (d-AC-1): READ the vault-driven provider/model SELECTION. When present +
	// catalog-valid, it WINS over the committed `agent.yaml` (fed as an additive override to the
	// factory below); absent, the `agent.yaml` selection stands. Fail-soft (→ undefined).
	const providerModelOverride = await readProviderModelOverride(vault, secretScopeFromQueryScope(scope));

	// The real inference ModelClient (AC-T). Never throws — degrades to the no-op client when
	// no `agent.yaml`/`inference:` block/key is present yet (so enabling pollinating before the
	// key exists boots cleanly and yields empty, zero-mutation passes). The vault provider/model
	// override (when set) wins over the `agent.yaml` selection; the `${SECRET_REF}` credential
	// still resolves through the `secret` class unchanged (FR-2 — the key is never inlined).
	const secretsStore = new SecretsStore({
		baseDir: resolveWorkspaceBaseDir(),
		machineKey: createMachineKeyProvider(),
	});
	// PRD-063b: when the Portkey gateway is ON (selection present), the factory routes inference
	// through the Portkey transport (the SUPERSESSION) and BYPASSES `providerModelOverride`; the
	// per-provider key is neither required nor read. Off/absent → the per-provider path, unchanged.
	// The `onPortkeyUnreachable` observer threads the cached last-failure signal so `/health` flips
	// to `unreachable` on a real gateway failure (b-AC-7).
	const model: ModelClient = await buildInferenceModelClient({
		scope: secretScopeFromQueryScope(scope),
		secretsStore,
		config: resolveAgentConfigPath(options),
		...(providerModelOverride !== undefined ? { providerModelOverride } : {}),
		...(portkeyDeps?.selection !== undefined ? { portkey: portkeyDeps.selection } : {}),
		...(portkeyDeps !== undefined ? { onPortkeyUnreachable: portkeyDeps.onUnreachable } : {}),
	});

	// The REAL PRD-009a trigger: its `readState` feeds the worker's first-run backfill rule
	// and its additive `recordPassComplete` is the runner's append-only state-update seam. It
	// reuses the daemon's OWN durable queue as the enqueuer — no second pollinating subsystem.
	// No `pendingTerminal` probe is passed (see the JSDoc above): the queue exposes no public
	// status-by-id read, so the trigger applies its conservative never-terminal default.
	const trigger = createPollinatingTrigger({ storage, scope, config, enqueuer: queue });

	// The consumer: leases ONLY `["pollinating"]`, runs the runner with the real model + the 008c
	// apply (inside the runner) + the append-only state update, completes/fails the job.
	return createPollinatingWorker({ queue, storage, scope, config, model, trigger, backoff });
}

/**
 * Build the daemon-resident SUMMARY job worker (PRD-046a / a-AC-1) — the live CONSUMER of
 * `summary` jobs PRD-017 left as a deferred-assembly seam. It leases ONLY `["summary"]`
 * off the SAME durable `memory_jobs` queue, parses each cue back into a `SummarySession`,
 * and drives the UNCHANGED `runSummaryWorker` with the real `{ lock, fetcher, gate, embed,
 * store }` deps (a-AC-1). The gate is built over {@link systemSummarySpawner}, so the
 * spawned subprocess carries the safety env (`HONEYCOMB_WIKI_WORKER=1` +
 * `HONEYCOMB_CAPTURE=false` + the recursion guard) on the LIVE-assembled path (a-AC-4),
 * and the worker's one shared per-session lock holds end-to-end (a-AC-3).
 *
 * Unlike pollinating (a premium gated tier), summaries are a CORE feature, so this worker is
 * built + started UNCONDITIONALLY once the queue is up. Construction has no side effects
 * until `start()`; the caller starts it after `startServices()` and stops it in shutdown.
 * The `embed.client` is the daemon's real (or no-op) 768-dim embed client — a throw is
 * non-fatal in the worker (a-AC-5).
 */
function buildSummaryWorker(
	storage: StorageClient,
	scope: QueryScope,
	queue: DaemonServices["queue"],
	embed: EmbedAttachment,
	backoff: PollBackoffConfig,
): SummaryJobWorker {
	return createSummaryJobWorker({ queue, storage, scope, embed: embed.client, backoff });
}

/**
 * Build the memory-pipeline ENTRY enqueuer (PRD-045a a-AC-2). Returns the
 * `enqueuePipelineEntry` callback the capture handler calls once per accepted turn:
 * it enqueues ONE `memory_extraction` job carrying the captured text + the tenancy
 * envelope (org/workspace/agent), the cheap entry of the entry-fan-out chain. The
 * stage worker leases that job, runs extraction, and the fan-out advances the turn
 * through decision → controlled-write → graph-persist. The enqueue throws only on a
 * genuine queue failure; the capture handler wraps the call fail-soft (a-AC-2 +
 * a-AC-5 — a pipeline enqueue failure never breaks the captured turn).
 */
function makePipelineEntryEnqueuer(
	queue: DaemonServices["queue"],
): (text: string, scope: QueryScope, agentId: string, projectId?: string) => Promise<void> {
	return async (text: string, scope: QueryScope, agentId: string, projectId?: string): Promise<void> => {
		await queue.enqueue({
			kind: "memory_extraction",
			payload: {
				org: scope.org,
				workspace: scope.workspace ?? "",
				agent_id: agentId === "" ? "default" : agentId,
				// PRD-049b (49b-AC-1): seed the resolved project segment onto the entry job so it
				// rides the scope envelope through every stage to the controlled-write commit.
				...(projectId !== undefined && projectId !== "" ? { project_id: projectId } : {}),
				content: text,
			},
		});
	};
}

/**
 * Build the daemon-resident MEMORY-PIPELINE stage worker (PRD-045a a-AC-1) — the live
 * CONSUMER PRD-006 shipped but never constructed. It leases the FIVE pipeline kinds
 * (`memory_extraction` / `memory_decision` / `memory_controlled_write` /
 * `memory_graph_persist` / `memory_retention`) off the SAME durable `memory_jobs`
 * queue (NOT a second queue — a-AC reuse), runs the real {@link createPipelineHandlers}
 * stage handlers, and CHAINS them with the fan-out enqueuers so a captured turn flows
 * extraction → decision → controlled-write → graph-persist (a-AC-3 / a-AC-4).
 *
 * ── Model dependency is FAIL-SOFT, exactly like pollinating (constraint) ─────────
 * Extraction + decision call the in-process {@link ModelClient}. The real
 * router-backed client is built via {@link buildInferenceModelClient} (the 010
 * router), which NEVER throws — it degrades to {@link noopModelClient} (zero-mutation
 * empty passes) when no `agent.yaml`/`inference:` block/key is present. So a daemon
 * with no model config still wires the pipeline; extraction simply yields zero facts
 * and the chain produces no writes — a clean no-op, never a crash.
 *
 * The whole build is wrapped fail-soft by the caller (the `start()` try/catch), so a
 * pipeline wiring failure surfaces to stderr but NEVER prevents the daemon from
 * booting — the daemon is already up and serving (a-AC-5).
 */
async function buildPipelineWorker(
	options: AssembleDaemonOptions,
	storage: StorageClient,
	scope: QueryScope,
	queue: DaemonServices["queue"],
	embed: EmbedAttachment,
	backoff: PollBackoffConfig,
	portkeyDeps?: PortkeyWorkerDeps,
): Promise<StageWorker> {
	// Resolve the pipeline config fail-soft: a malformed knob must NEVER take the daemon
	// down — degrade to the schema's false-safe defaults (every stage gate defaults OFF,
	// the conservative posture the pipeline config already documents).
	let config: PipelineConfig;
	try {
		config = resolvePipelineConfig();
	} catch {
		config = resolvePipelineConfig({ read: () => ({}) });
	}

	// The real inference ModelClient (the 010 router). NEVER throws — degrades to the
	// no-op client (empty, zero-mutation passes) when no `agent.yaml`/`inference:` block
	// or key is present yet, exactly as the pollinating worker threads it. A build error is
	// caught and degraded to the no-op so the pipeline still wires.
	let model: ModelClient;
	try {
		const secretsStore = new SecretsStore({
			baseDir: resolveWorkspaceBaseDir(),
			machineKey: createMachineKeyProvider(),
		});
		// PRD-063b: route the pipeline's extraction/decision inference through Portkey too when the
		// gateway is on (the SUPERSESSION), with the same last-failure observer; off → unchanged.
		model = await buildInferenceModelClient({
			scope: secretScopeFromQueryScope(scope),
			secretsStore,
			config: resolveAgentConfigPath(options),
			...(portkeyDeps?.selection !== undefined ? { portkey: portkeyDeps.selection } : {}),
			...(portkeyDeps !== undefined ? { onPortkeyUnreachable: portkeyDeps.onUnreachable } : {}),
		});
	} catch {
		model = noopModelClient;
	}

	const queryScope: QueryScope = scope;

	// PRD-058b LIVE (C-1): the post-commit conflict-detection hook. Built over the SAME storage + embed +
	// model the pipeline already uses, it makes detection RUN on the real write path — a committed fact
	// runs the detector over the decision stage's forwarded candidate set and PROJECTS any flagged pair
	// into `memory_conflicts`, so recall's κ gate (createConflictSuppressionSource, wired at the memories
	// mount) finally reads a non-empty projection. Fail-soft by construction (a down judge / missing table
	// never costs a memory). The decision stage's `hydrateCandidates` is turned on IN LOCKSTEP so the
	// forwarded candidates carry the claim text the detector needs (the two travel together).
	const conflictHook = createControlledWriteConflictHook({ storage, embed: embed.client, model });

	// The real stage handlers, CHAINED via the fan-out enqueuers (045a). Each stage's
	// optional forward seam is wired to enqueue the next stage's job onto the same queue.
	const handlers = createPipelineHandlers({
		extraction: { config, model, onResult: extractionFanOut(queue) },
		decision: {
			storage,
			scope: queryScope,
			model,
			config,
			embed: embed.client,
			hydrateCandidates: true,
			onDecisions: decisionFanOut(queue),
		},
		controlledWrite: {
			storage,
			config,
			embed: embed.client,
			onOutcome: controlledWriteFanOut(queue),
			onConflict: conflictHook,
		},
		graphPersist: { storage, scope: queryScope, config },
		retention: { storage, scope: queryScope, config },
	});

	return createStageWorker({ queue, handlers, backoff });
}

/**
 * Build the daemon-resident SKILLIFY job worker (PRD-045f f-AC-1) — the live CONSUMER
 * of `skillify` jobs capture enqueues when the per-turn threshold is crossed. It leases
 * ONLY `["skillify"]` off the SAME durable `memory_jobs` queue, parses each cue into a
 * `MineScope`, calls `mine()` (gate + lock), and calls `writeSkill()` (append-only row).
 *
 * Like summaries, skillify is a CORE feature (not a gated tier), so this worker is built +
 * started UNCONDITIONALLY once the queue is up. The gate is built over `systemGateSpawner`
 * (the host-CLI shell-out: `claude --print`), so the user's auth rides in the CLI's own
 * credential store — NO API key is held by the daemon (f-AC-4). A gate timeout, bad exit
 * code, or any throw routes to `queue.fail` (backoff + dead semantics); the daemon is NEVER
 * crashed and capture is NEVER blocked (f-AC-4). Construction has no side effects until
 * `start()`; the caller starts it after `startServices()` and stops it in shutdown.
 */
function buildSkillifyWorker(
	storage: StorageClient,
	scope: QueryScope,
	queue: DaemonServices["queue"],
	backoff: PollBackoffConfig,
): SkillifyJobWorker {
	return createSkillifyJobWorker({
		queue,
		storage,
		scope,
		gateSpec: defaultGateSpec(),
		backoff,
	});
}

/**
 * The composition root (a-AC-1..6 / FR-1..10). Constructs the live storage client,
 * resolves the daemon scope, builds the real services, composes the auth gates for the
 * mode, wires the cached `/health` probe, builds the daemon, and fires the four seams
 * once. Returns the assembled daemon plus lifecycle controls (PID/lock guard, graceful
 * shutdown). Pure construction — no socket is bound and no service is started here;
 * call `start()` then `startDaemon(assembled.daemon)` to listen.
 */
export function assembleDaemon(options: AssembleDaemonOptions = {}): AssembledDaemon {
	const config = options.config ?? resolveRuntimeConfig();
	// ── PRD-043a (FR-1/FR-2): the durable SQLite log store. Built BEFORE the logger so it can be
	// injected as the logger's write-through seam. Precedence:
	//   1. an explicit `options.logStore` (a test injects a temp-dir / in-memory store);
	//   2. else — for the REAL production assembly only (no injected `storage`) — open the real
	//      store under `$HONEYCOMB_WORKSPACE/.daemon/logs.db` (fail-soft → NULL_LOG_STORE on an
	//      unavailable `node:sqlite` or open failure, AC-4);
	//   3. else (the deterministic unit suite: a fake `storage` and no `logStore`) the NULL no-op,
	//      so the unit logger stays pure (the PRD-021d/029 suites pass unchanged — AC-3) and the
	//      suite never touches disk.
	const logStore: LogStore =
		options.logStore ??
		(options.storage === undefined ? openLogStore({ baseDir: resolveWorkspaceBaseDir() }) : NULL_LOG_STORE);
	// The logger writes THROUGH the store in addition to the ring buffer + stderr (FR-2). When the
	// caller injects its own `logger`, we respect it (its own store wiring, if any, stands); only the
	// default logger gets the assembly's store. An injected logger from a unit test has no store, so
	// nothing changes for that suite.
	const logger = options.logger ?? createRequestLogger({ store: logStore });
	const runtimeDir = resolveRuntimeDir(options.runtimeDir);
	const probeIntervalMs = options.healthProbeIntervalMs ?? DEFAULT_HEALTH_PROBE_INTERVAL_MS;

	// ── a-AC-1: construct the LIVE storage client. This is the ONLY production code
	// that imports `daemon/storage` to get a live client; allowed because this file is
	// inside `src/daemon/` (the composition root, D-2). A test injects a fake client.
	//
	// Resolve the credential PROVIDER ONCE here so the storage client AND the daemon's own
	// tenancy scope are derived from the SAME source — they can never disagree (the prior
	// split, where the client read `~/.deeplake` but the scope re-read env, was the bug).
	// When a test injects a fake `storage`, there is no live provider and no creds to read,
	// so the scope falls through to the `"local"` default (the deterministic suite is
	// unchanged). When the real client is built, it connects THROUGH this very provider.
	const provider: CredentialProvider | undefined =
		options.storage !== undefined ? options.provider : (options.provider ?? defaultCredentialProvider());
	// PRD-050b (b-AC-1 / b-AC-3): the production storage client is the DEFERRED variant — it NEVER
	// throws at construction when no credential resolves (a fresh install with no
	// `~/.deeplake/credentials.json` and no `HONEYCOMB_DEEPLAKE_*` env). The eager
	// `createStorageClient` validates config at build time and throws a `StorageConfigError` on no
	// creds, which would take the whole daemon down before it could serve the pre-auth dashboard +
	// guided-setup login. `createLazyStorageClient` defers the build to the first query and re-attempts
	// it per request, so (a) the daemon boots without credentials (b-AC-1) and (b) the moment the login
	// flow writes the shared credential, the NEXT request builds a real connected client on the SAME
	// running daemon — no restart, no credential cached at boot (b-AC-3). A test injecting a fake
	// `storage` bypasses this entirely (the deterministic suite is unchanged).
	const storage = options.storage ?? createLazyStorageClient(provider !== undefined ? { provider } : {});

	// The daemon's own tenancy partition + friendly org name: resolved from the SAME
	// credential provider the storage client connected through (env-over-file), with env as
	// an override and `"local"` ONLY as the true no-creds fallback (a fake client / no env).
	// The queue + health probe run under this scope; the dashboard settings view shows the
	// friendly `orgName`.
	const tenancy = resolveDaemonTenancy(provider);
	const scope = tenancy.scope;
	const daemonOrgName = tenancy.orgName;

	// ── PRD-032d / AC-6: construct the daemon's vault `setting`-class READER ONCE, over the
	// SAME workspace base dir + machine-key + daemon scope the secrets store uses (so the vault,
	// the `.secrets/` records, and the `${SECRET_REF}` resolver all agree on ONE location). A
	// test injects a fake reader (`options.vault`); production builds the real {@link VaultStore}.
	// When a fake `storage` is injected with NO `vault`, the read path is skipped — the vault is
	// only built for the REAL assembly so the deterministic suite never touches the workspace.
	// Built HERE (before the services block) so the embed supervisor can be seeded from the
	// persisted `embeddings.enabled` preference, AND it threads into `assembleSeams` + the recall
	// mount below (PRD-044c) — one reader, no second construction.
	const vault: VaultSettingsReader | undefined =
		options.vault ?? (options.storage === undefined ? buildVaultStore() : undefined);

	const sharedQueue = createJobQueueService({ storage, scope, config: options.jobQueueConfig });
	const localQueueConfig = resolveHybridJobQueueConfig();
	const storageHealthProbeEnabled = !localQueueConfig.enabled || localQueueConfig.drainSharedLocalKinds;
	const localQueue = openLocalJobQueue({
		baseDir: resolveWorkspaceBaseDir(),
		openExistingOnly: !localQueueConfig.enabled,
	});
	const queue = createHybridJobQueueService({
		shared: sharedQueue,
		local: localQueue,
		config: localQueueConfig,
	});

	// ── a-AC-3: the three REAL services replace the no-op stubs.
	const services: Partial<DaemonServices> = {
		queue,
		watcher: createFileWatcherService({
			workspaceDir: options.workspaceDir ?? process.cwd(),
			harnessTargets: options.harnessTargets ?? [],
			gitSync: { enabled: false },
		}),
		runtimePath: createRuntimePathService(),
		// PRD-025 D-6: the daemon OWNS the embed daemon. The supervisor spawns + health-checks
		// + crash-restarts the embed child, warming it OFF the turn path (D-3). It reads the
		// SAME `HONEYCOMB_EMBEDDINGS` opt-out the embed client does, so an explicit `false`/`0`
		// makes it inert (no child) and unset/on spawns with zero config (D-1). A test injects a
		// fake supervisor so the hermetic assembly never spawns a real process.
		embed: options.embedSupervisor ?? createEmbedSupervisor(),
	};

	// Dashboard actions: reconcile the embed supervisor to the PERSISTED `embeddings.enabled`
	// preference (vault-first; the env/default is the seed `createEmbedSupervisor` already applied).
	// `assembleDaemon` is SYNC and the vault read is async, so this is fire-and-forget: the supervisor
	// boots from env/default and a saved dashboard choice (when present + different) is applied a tick
	// later via the live `setEnabled`. Fail-soft — a missing vault / read error leaves env/default.
	const embedSupervisor = services.embed;
	if (embedSupervisor !== undefined && vault !== undefined) {
		void readBootEmbeddingsEnabled(vault, secretScopeFromQueryScope(scope))
			.then(async (enabled) => {
				if (enabled !== !embedSupervisor.disabled) await embedSupervisor.setEnabled(enabled);
			})
			.catch((err: unknown) => {
				// A failed reconcile must never become an unhandled rejection — the env/default state stands.
				const reason = err instanceof Error ? err.message : String(err);
				process.stderr.write(`honeycomb: embeddings boot reconciliation failed (non-fatal): ${reason}\n`);
			});
	}

	// ── a-AC-4: the cached health bit. A cheap background `SELECT 1` refreshes a coarse
	// status; `/health` reads the bit (NO per-request heavy query). Initial state is
	// `ok` (a freshly-constructed live client is assumed reachable until the first probe
	// proves otherwise) — the server's own default would also report `ok` when storage is
	// wired, so this never reports a false green that the server would not.
	let healthBit: PipelineStatus = "ok";
	const pipelineProbe = (): PipelineStatus => healthBit;

	// ── PRD-029 (AC-2): the structured `/health` detail. The `embeddings` reason reflects
	// the embed-seam state KNOWN AT ASSEMBLY (D-4), NOT a probe: when a test injects a fake
	// `embed`, default to `false` (the hermetic no-op reports `off`); otherwise read the
	// `HONEYCOMB_EMBEDDINGS` opt-out via `resolveEmbedClientOptions().enabled` (the same flag
	// the real `createEmbedAttachment` honours). An explicit `embeddingsEnabled` option wins
	// (a deterministic test drive). The `storage` reason is derived from the SAME cached
	// `healthBit` the coarse probe maintains; `schema` stays best-effort `ok` (no cheap
	// always-on missing-table signal at the health seam — conservative, never a false
	// `missing_table`). The thunk reads live state on each call, so a probe flip to `degraded`
	// is reflected on the next `/health` read.
	// Dashboard actions: read the LIVE supervisor state (`!services.embed.disabled`) so a runtime
	// `setEnabled` toggle is reflected on the next `/health` read. The test branches are preserved:
	// an explicit `embeddingsEnabled` option still wins, and an injected `options.embed` attachment
	// (the hermetic suite) still reports `off`.
	const embeddingsReason = (): boolean =>
		options.embeddingsEnabled ??
		(options.embed !== undefined
			? false
			: embedSupervisor !== undefined
				? !embedSupervisor.disabled
				: resolveEmbedClientOptions().enabled);

	// ── PRD-063b (b-AC-7): the Portkey gateway health reason. Mutable + live: it is SET to the
	// assembly-time status (`off`/`ok`/`unconfigured`, derived from config below — NO probe) once the
	// vault is constructed, and FLIPPED to `unreachable` by `recordPortkeyUnreachable` when a REAL
	// Portkey call fails to connect/authenticate (the cached last-failure signal). The thunk reads the
	// live value on each `/health` call. Initial `off` is the conservative "Portkey not in force" state
	// the daemon reports until the assembly-time resolution below runs.
	let portkeyHealth: PortkeyHealth = "off";
	/** The cached last-failure signal (b-AC-7 / c-AC-3): a real Portkey call failed → `/health` reports `unreachable`. */
	const recordPortkeyUnreachable = (_statusCode: number): void => {
		portkeyHealth = "unreachable";
	};

	const healthDetail = (): HealthDetail =>
		buildHealthDetail({ status: healthBit, embeddingsEnabled: embeddingsReason(), portkey: portkeyHealth });

	// ── PRD-063c (c-D-2 / c-AC-1 / c-AC-3): the Cohere-via-Portkey rerank seam, late-bound.
	// The seam handed to the `/api/memories/recall` mount is a STABLE delegating object whose `rerank`
	// forwards to a mutable inner seam. The inner seam is BUILT inside `start()` (the SAME async place
	// `portkeyHealth` + the inference Portkey selection resolve), ONLY when the gateway is ON — it
	// closes over `createSecretResolver` (so `PORTKEY_API_KEY` decrypts at call time, never seen by the
	// recall engine, c-AC-2), the Portkey config, the env-resolved Cohere model, and the SAME
	// `recordPortkeyUnreachable` last-failure signal the chat transport uses (c-AC-3). Until/unless the
	// gateway is ON, the inner seam is absent and `rerank` reports `ok: false` → the engine keeps the
	// RRF order (c-AC-4 / fail-soft). The reranker STRATEGY is selected separately via the env
	// `HONEYCOMB_RECALL_RERANKER` (the recall config threaded into the mount below).
	let cohereRerankInner: CohereRerankSeam | undefined;
	const cohereRerankSeam: CohereRerankSeam = {
		rerank(query, documents, topN) {
			const inner = cohereRerankInner;
			if (inner === undefined) return Promise.resolve({ ok: false } as const);
			return inner.rerank(query, documents, topN);
		},
	};

	const { authenticator, policy } = authForMode(config.mode, storage, scope);

	const createOptions: CreateDaemonOptions = {
		config,
		storage,
		authenticator,
		policy,
		logger,
		services,
		pipelineProbe,
		healthDetail,
	};
	const daemon = createDaemon(createOptions);

	// ── Deep Lake idle-cost master switch (cost incident follow-up). The controller is built
	// at the END of `start()` (once the workers + their lease topology are known) and assigned
	// here. `onActivity` is the WAKE signal: an inbound HTTP request (a capture, a recall, a CLI
	// call) means an agent is live and needs the shared Deep Lake pool, so it cancels/defers
	// hibernation. It is registered as a root middleware BEFORE any route group is mounted so it
	// fires for every request. Background worker queries are NOT inbound requests, so they never
	// spuriously keep the daemon awake — only real agent activity does.
	let hibernation: DeepLakeHibernation | null = null;
	const hibernationConfig = envHibernationConfigProvider();
	const onActivity = (): void => hibernation?.touch();
	daemon.app.use("*", async (_c, next) => {
		onActivity();
		await next();
	});

	// ── PRD-025 AC-2: the embed seam wired into the store + capture paths. Default to the
	// REAL `{ client, attacher }` pair (D-1 default-on, resolved from the env), built ONCE
	// here and threaded into BOTH the capture handler (the full attachment) and the memories
	// store path (its `client`). A test injects a fake attachment to keep assembly hermetic.
	// `createEmbedAttachment` reads `resolveEmbedClientOptions()` when no options are passed,
	// so unset → enabled; an explicit `HONEYCOMB_EMBEDDINGS=false`/`0` → a null-returning
	// client (clean lexical-only). The attacher writes through the same live storage client.
	const embed = options.embed ?? createEmbedAttachment({ storage });

	// ── PRD-039a (a-AC-3 / OQ-1): the daemon's known INSTALLED/wired harness set — the cheap
	// cached presence check resolved ONCE here (NOT a per-request file walk or spawn). A harness
	// reads `installed: true` on the telemetry endpoint independent of whether it has ever captured
	// a turn. Precedence (highest first):
	//   1. an explicit `options.installedHarnesses` (a test injects a fixed mix);
	//   2. else the harness-sync `HarnessTarget` names the file watcher holds, WHEN any are supplied;
	//   3. else — for the REAL production assembly only (no injected `storage`) — the cheap on-disk
	//      `detectInstalledHarnesses()` probe (existsSync over each installer's marker), so the LIVE
	//      endpoint reflects what is actually wired instead of the empty "wired nothing yet" set
	//      (a-AC-3 was plumbed but starved in production — this feeds it).
	// A unit assembly (injected `storage`, no targets, no explicit set) stays on the empty set, so the
	// deterministic suite never touches the real home. The probe is fail-soft (a missing/unreadable
	// marker → simply absent), so it can never crash the boot.
	const installedHarnesses: ReadonlySet<string> =
		options.installedHarnesses ??
		(options.harnessTargets !== undefined && options.harnessTargets.length > 0
			? new Set(options.harnessTargets.map((t) => t.name))
			: options.storage === undefined
				? detectInstalledHarnesses()
				: new Set<string>());

	// (The vault `setting`-class READER is constructed earlier, before the services block, so it can
	// also seed the embed supervisor's boot enabled state. It threads into `assembleSeams` below — the
	// SAME reader the `/api/memories/recall` mount reads `recallMode` from, PRD-044c.)

	// ── PRD-063b (b-AC-7): the Portkey selection is resolved INSIDE `start()` (async, where the
	// other vault reads live) — see `resolvePortkeyWorkerDeps`. The synchronous body only holds the
	// mutable `portkeyHealth` (read by the `/health` thunk) + the last-failure observer declared above.

	// ── a-AC-2 / d-AC-1: fire the seams EXACTLY ONCE, after construction (the four core
	// seams + the /api/logs reader always; the /dashboard host local-mode only per security
	// F-1; PLUS the three data-API seams — memories/vfs/product-data — always, 022d).
	// PRD-063c: resolve the reranker config from the env ONCE (fail-soft: a bad knob clamps/defaults,
	// never throws — `resolveRecallConfig` already coerces). The operator selects the strategy via
	// `HONEYCOMB_RECALL_RERANKER` (`cohere` activates the provider rerank); the DEFAULT is `none`
	// (RRF-only), so an unset env is byte-identical to today (c-AC-4). Threaded into the recall mount
	// alongside the late-bound Cohere seam declared above.
	let rerankerMountDeps: RerankerMountDeps;
	try {
		rerankerMountDeps = { reranker: resolveRecallConfig().reranker, cohereRerank: cohereRerankSeam };
	} catch {
		// A structurally-impossible explicit env value (e.g. an out-of-enum strategy) → the documented
		// default config, so the recall mount never fails to wire. The seam still rides (harmless when
		// the strategy is not `cohere`).
		rerankerMountDeps = {
			reranker: RecallConfigSchema.parse({}).reranker,
			cohereRerank: cohereRerankSeam,
		};
	}

	// PRD-062c: hold the capture handler the seams construct so `shutdown()` can drain its
	// write buffer (AC-5). `assembleSeams` returns it from its `attachHooks` step.
	const captureHandler = assembleSeams(
		daemon,
		storage,
		scope,
		daemonOrgName,
		embed,
		healthDetail,
		localQueueConfig,
		localQueue,
		options.workspaceDir ?? process.cwd(),
		installedHarnesses,
		logStore,
		options.seams ?? defaultSeamFns,
		vault,
		rerankerMountDeps,
		options.projectsDir,
	);

	// ── PRD-032d / AC-6: FIRE the Wave-1 `/api/settings` mount ONCE so the CLI/dashboard
	// settings surface is LIVE against this daemon. FAIL-SOFT: a vault/settings construction or
	// mount error must NEVER crash the daemon — the settings surface simply stays unmounted this
	// run (it falls through to the 501 scaffold), exactly the posture the data-API mounts use.
	// It mounts the `setting` class ONLY (the registry's posture gate rejects any `secret` read),
	// so no secret value can cross this surface (AC-8). Production mounts the REAL store; a test
	// with an injected reader that is also a full {@link VaultStore} mounts it too.
	if (vault !== undefined && vault instanceof VaultStore) {
		try {
			// Thread the LOCAL default-scope resolver (PRD-022) so the dashboard web app — a loopback
			// thin client that sends NO `x-honeycomb-org` header — resolves the single local tenant
			// instead of 400ing on `GET /api/settings`. In team/hybrid the resolver stays fail-closed.
			mountSettingsApi(daemon, { store: vault, scope: localDefaultScopeResolver(daemon.config.mode, scope) });
		} catch (err: unknown) {
			const reason = err instanceof Error ? err.message : String(err);
			process.stderr.write(`honeycomb: settings API mount failed (non-fatal): ${reason}\n`);
		}
	}

	// PRD-044a: FIRE the `/api/auth/status` read-model mount ONCE so the Settings page can read
	// the daemon's REDACTED DeepLake-auth identity. It attaches onto the already-mounted,
	// protected `/api/auth` group (NO `server.ts` edit -- the group is declared there with no
	// handlers). The handler is GATED to local mode (OQ-3) + carries NO token by construction
	// (the body has no `token` field). It resolves credentials via the SAME `loadCredentials`
	// path the daemon connects through (the real shared `~/.deeplake/credentials.json`), so a
	// `honeycomb login` reflects here on the page's next poll. FAIL-SOFT: a mount error must
	// NEVER crash the daemon -- the surface stays unmounted this run, the posture the others use.
	try {
		mountAuthStatusApi(daemon);
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		process.stderr.write(`honeycomb: auth status API mount failed (non-fatal): ${reason}\n`);
	}

	// Dashboard actions: FIRE the `/api/actions` mount ONCE so the Settings page can log out,
	// toggle embeddings (live + persisted), restart the daemon, and surface uninstall — the named
	// CLI actions, now performable from the UI. It attaches onto the already-mounted, protected
	// `/api/actions` group and SELF-GATES to local mode + an origin/CSRF guard inside the handlers.
	// The embed supervisor + vault store + default scope are threaded so the toggle actuates live
	// and persists. FAIL-SOFT: a mount error must NEVER crash the daemon — the surface stays
	// unmounted this run (the page's action buttons degrade), the posture the other mounts use.
	try {
		mountActionsApi(daemon, {
			embed: daemon.services.embed,
			defaultScope: scope,
			...(vault instanceof VaultStore ? { store: vault } : {}),
		});
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		process.stderr.write(`honeycomb: actions API mount failed (non-fatal): ${reason}\n`);
	}

	// PRD-049e (49e-AC-1 / 49e-AC-3): FIRE the dashboard SCOPE-SWITCHER enumeration reads ONCE so the
	// Org→Workspace→Project switcher can hydrate its dropdowns — `GET /api/diagnostics/scope/{orgs,
	// workspaces,projects}`. They attach onto the already-mounted, protected `/api/diagnostics` group
	// (NO `server.ts` edit) and SELF-GATE to local mode (a non-local request 404s), mirroring the auth
	// status read. `listOrgs`/`listWorkspaces` are privilege-scoped by the token; the Org change re-mints
	// the org-bound token (PRD-011) BEFORE enumerating the new org. The projects read syncs + reads the
	// 049a `projects.json` cache under the daemon's `defaultScope`. The bearer token rides ONLY in the
	// auth client's Authorization header — NEVER in a body (D-4). FAIL-SOFT: a mount error never crashes
	// the daemon (the switcher falls back to empty lists), and each handler returns an empty list on any
	// auth-API failure rather than a 500.
	try {
		mountScopeEnumerationApi(daemon, { storage, defaultScope: scope });
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		process.stderr.write(`honeycomb: scope enumeration API mount failed (non-fatal): ${reason}\n`);
	}

	// PRD-059b/059c/059d: FIRE the dashboard ONBOARDING folder-browse + bind routes ONCE so the
	// folder-picker (`GET /api/diagnostics/fs/browse`), the "Add a project" bind (`POST
	// /api/diagnostics/projects/bind`), the cross-device import (`POST .../projects/bind-existing`),
	// and the unbind (`POST .../projects/unbind`) are LIVE. They attach onto the already-mounted,
	// protected `/api/diagnostics` group (NO `server.ts` edit) and SELF-GATE to local mode (a
	// non-local request 404s), mirroring the scope-enumeration reads. The bind routes write the SAME
	// thin-client `~/.deeplake/projects.json` the CLI `honeycomb project bind` writes (single-sourced
	// store); the browse route refuses to traverse outside the home dir. NO DeepLake call, NO secret
	// in any body. FAIL-SOFT: a mount error never crashes the daemon (the picker falls back to the
	// CLI), and every handler returns a clean 400/200 rather than a 500.
	try {
		mountOnboardingApi(daemon, {
			org: scope.org,
			workspace: scope.workspace ?? "",
		});
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		process.stderr.write(`honeycomb: onboarding API mount failed (non-fatal): ${reason}\n`);
	}

	// IRD-122 (122-AC-1 / 122-AC-2 / 122-AC-4): FIRE the dashboard SCOPE-SWITCH persistence routes
	// ONCE so an Org/Workspace switch in the dashboard PERSISTS a real scope change instead of a
	// viewer-only no-op — `POST /api/diagnostics/scope/{org-switch,workspace-switch}`. They attach
	// onto the already-mounted, protected `/api/diagnostics` group (NO `server.ts` edit) and SELF-GATE
	// to local mode. The org switch RE-MINTS an org-bound token (PRD-011) + persists it via the SAME
	// `saveDiskCredentials` writer the CLI `honeycomb org switch` uses (122-AC-2); the workspace switch
	// persists the workspace id (no re-mint). The bearer token rides ONLY in the auth client's
	// Authorization header + the shared credential file — NEVER in a body (D-4). FAIL-SOFT: a mount
	// error never crashes the daemon, and every handler returns a clean ack rather than a 500.
	try {
		mountScopeSwitchApi(daemon, {});
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		process.stderr.write(`honeycomb: scope switch API mount failed (non-fatal): ${reason}\n`);
	}

	// ── PRD-033c / FR-1/FR-2/FR-6: FIRE the `/api/assets` mount ONCE so the asset-sync
	// substrate (publish/pull/tombstone) is LIVE against this daemon — the ONLY DeepLake path
	// for synced assets (D-6). It builds the engine over the SAME live storage client + the
	// catalog `synced_assets` table (lazy-create + heal on first publish), threading the
	// daemon's `defaultScope` so a loopback thin client that carries no tenancy resolves the
	// single local tenant (mirrors the data-API mounts). The trusted-table probe is derived
	// from CATALOG so the pull's table-absent skip is consistent with the rest of the daemon.
	// FAIL-SOFT: a mount error must NEVER crash the daemon — the surface simply stays unmounted
	// this run (it falls through to the 501 scaffold), exactly the posture the other mounts use.
	try {
		mountAssetsApi(daemon, {
			sync: { storage, trustedTables: catalogTrustedTableProbe() },
			defaultScope: scope,
			// PRD-033 SECURITY: thread the deployment mode so the handlers take tenancy
			// (org/workspace/author) from the VALIDATED Identity in team/hybrid — never the
			// request body — closing the cross-tenant publish/pull/tombstone forge. In local
			// mode the body + defaultScope fallback applies (single-user loopback).
			mode: config.mode,
		});
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		process.stderr.write(`honeycomb: assets API mount failed (non-fatal): ${reason}\n`);
	}

	// ── The cached-health refresher: a cheap connectivity round trip on an interval,
	// updating the bit `/health` reads. Unref'd so it never keeps the process alive.
	let probeTimer: ReturnType<typeof setInterval> | null = null;
	async function refreshHealth(): Promise<void> {
		try {
			const res = await storage.query("SELECT 1", scope, { timeoutMs: 5_000 });
			healthBit = isOk(res) ? "ok" : "degraded";
		} catch {
			// A thrown probe (should not happen — the client returns a typed result) is
			// treated as degraded, never a crash of the refresher loop.
			healthBit = "degraded";
		}
	}

	// ── PRD-041 (codebase graph): the manual graph API remains wired, but boot-time auto-build is
	// opt-in. A full-repo tree-sitter parse is optional work, and a native/WASM parser abort can
	// terminate the whole process before the daemon binds; defaulting it off keeps fresh installs
	// reachable while preserving an explicit HONEYCOMB_CODEBASE_GRAPH_AUTO_BUILD=true escape hatch.
	const autoBuildGraph = resolveCodebaseGraphAutoBuild({
		explicit: options.autoBuildGraph,
		hasInjectedStorage: options.storage !== undefined,
		mode: config.mode,
	});
	let graphBuildTimer: ReturnType<typeof setInterval> | null = null;
	let graphBuildInFlight = false;
	async function rebuildCodebaseGraph(): Promise<void> {
		if (graphBuildInFlight) return;
		graphBuildInFlight = true;
		try {
			await buildCodebaseGraphSnapshot(scope, {
				storage,
				defaultScope: scope,
				workspaceDir: options.workspaceDir ?? process.cwd(),
			});
		} catch (err: unknown) {
			const reason = err instanceof Error ? err.message : String(err);
			process.stderr.write(`honeycomb: codebase graph auto-build failed (non-fatal): ${reason}\n`);
		} finally {
			graphBuildInFlight = false;
		}
	}

	// ── Idle-cost hibernation seams: arm/disarm the two Deep Lake-touching timers so the
	// hibernation controller can silence them while idle and revive them on the next request.
	// Factored from the original inline `start()` blocks so the arm logic lives once.
	function armUnrefInterval(cb: () => void, ms: number): ReturnType<typeof setInterval> {
		const t = setInterval(cb, ms);
		if (typeof (t as NodeJS.Timeout).unref === "function") (t as NodeJS.Timeout).unref();
		return t;
	}
	function armHealthProbe(): void {
		if (!storageHealthProbeEnabled || probeTimer !== null) return;
		probeTimer = armUnrefInterval(() => void refreshHealth(), probeIntervalMs);
	}
	function armGraphBuild(): void {
		if (!autoBuildGraph || graphBuildTimer !== null) return;
		graphBuildTimer = armUnrefInterval(() => void rebuildCodebaseGraph(), DEFAULT_GRAPH_BUILD_INTERVAL_MS);
	}

	let started = false;
	let locked = false;
	// PRD-026 AC-W: the daemon-resident pollinating worker. Built + started ONLY when
	// `resolvePollinatingConfig().enabled` (default OFF), inside `start()` AFTER the queue is up,
	// and stopped in `shutdown()`. Null until/unless the gate opens — a disabled daemon never
	// constructs the heavy bits (model client, trigger, worker).
	let pollinatingWorker: PollinatingJobWorker | null = null;
	// PRD-046a a-AC-1: the daemon-resident SUMMARY worker. Built + started UNCONDITIONALLY
	// (summaries are a core feature, not a gated tier) inside `start()` AFTER the queue is
	// up, and stopped in `shutdown()`. Null until `start()` runs.
	let summaryWorker: SummaryJobWorker | null = null;
	// PRD-045a a-AC-1: the daemon-resident MEMORY-PIPELINE worker — the live CONSUMER of the
	// five pipeline job kinds PRD-006 shipped but never constructed. Built + started
	// UNCONDITIONALLY (the per-stage gates inside the config decide what actually runs) inside
	// `start()` AFTER the queue is up, and stopped in `shutdown()`. Null until `start()` runs.
	let pipelineWorker: StageWorker | null = null;
	// PRD-062b L-B3 (AC-4): the single combined lease coordinator. When
	// `HONEYCOMB_POLL_CONSOLIDATE` is on AND pollinating is enabled, the pipeline +
	// pollinating workers are registered as participants and this coordinator runs ONE
	// combined lease pass over the union of their kinds instead of two independent
	// scans. Null when consolidation is off (the two workers start independently — the
	// AC-9 parity path) or when pollinating is disabled (only the pipeline worker exists).
	let leaseCoordinator: LeaseCoordinator | null = null;
	// PRD-045f f-AC-1: the daemon-resident SKILLIFY worker — the live CONSUMER of `skillify`
	// jobs capture enqueues when the turn-counter threshold is crossed. Built + started
	// UNCONDITIONALLY (core feature, not gated) inside `start()` AFTER the queue is up, and
	// stopped in `shutdown()`. Null until `start()` runs.
	let skillifyWorker: SkillifyJobWorker | null = null;
	const awaitInitialHealthProbe = options.awaitInitialHealthProbe ?? options.storage !== undefined;
	const startBackgroundWorkers = options.startBackgroundWorkers ?? true;
	const startSummaryWorker = options.startSummaryWorker ?? true;
	const startPipelineWorker = options.startPipelineWorker ?? true;
	const startSkillifyWorker = options.startSkillifyWorker ?? true;
	const startPollinatingWorker = options.startPollinatingWorker ?? true;

	return {
		daemon,
		config,
		pipelineStatus: (): PipelineStatus => healthBit,

		async start(): Promise<void> {
			if (started) return;
			// a-AC-6: acquire the single-instance guard BEFORE starting services so a
			// second start fails fast (DaemonAlreadyRunningError) without warming anything.
			acquireSingleInstanceLock(runtimeDir);
			locked = true;
			started = true;

			// Prime the health bit once, then refresh on the interval. Production does not await
			// the first probe: daemon readiness is the listener binding, not a DeepLake round trip.
			// Tests/proofs with injected storage keep blocking by default for deterministic health
			// assertions. In local-queue mode with shared draining off, this probe is intentionally
			// disabled: recurring `SELECT 1` traffic defeats PRD-066's idle-cost boundary.
			if (storageHealthProbeEnabled) {
				const initialHealthProbe = refreshHealth();
				if (awaitInitialHealthProbe) await initialHealthProbe;
				else void initialHealthProbe;
				armHealthProbe();
			}

			// PRD-041: kick the initial codebase-graph build OFF the readiness path (fire-and-forget
			// — a full-repo parse must not delay the daemon binding), then refresh on the interval.
			// Unref'd so it never keeps the process alive. Gated to the real local assembly (see
			// `autoBuildGraph`), so the unit suite never triggers a real parse.
			if (autoBuildGraph) {
				void rebuildCodebaseGraph();
				armGraphBuild();
			}

			// Start the daemon's real services (queue → watcher → runtime-path).
			await daemon.startServices();
			if (!startBackgroundWorkers) return;

			// ── PRD-062b: resolve the adaptive-backoff + consolidation knobs ONCE, fail-soft.
			// A malformed knob must NEVER take the daemon down — degrade to the schema's
			// safe defaults (backoff still default-ON per the env provider; consolidation
			// default-ON). Both are threaded into the workers below; consolidation also
			// decides whether the pipeline + pollinating workers run under one combined
			// lease pass (AC-4) or two independent ones (the AC-9 parity path).
			let pollBackoff: PollBackoffConfig;
			try {
				pollBackoff = resolvePollBackoffConfig();
			} catch {
				pollBackoff = resolvePollBackoffConfig({ read: () => ({}) });
			}
			let consolidatePoll = false;
			try {
				consolidatePoll = resolvePollConsolidateConfig().enabled;
			} catch {
				consolidatePoll = false;
			}
			const shouldConsolidatePoll = consolidatePoll && startPollinatingWorker;

			// ── PRD-063b (b-AC-7): resolve the Portkey selection + assembly-time health status ONCE,
			// here (async, alongside the other vault reads), so `/health` `reasons.portkey` is honest
			// INDEPENDENT of whether pollinating/the pipeline is enabled (the gateway toggle is its own
			// concern). A config read + a names-only secret presence check — NO network probe: `off`
			// when the toggle is off, `unconfigured` when on but `PORTKEY_API_KEY` is absent
			// (fail-closed), `ok` when on + keyed. Sets the mutable `portkeyHealth` the thunk reads; a
			// later REAL call failure flips it to `unreachable` via `recordPortkeyUnreachable`. The
			// resolved selection threads into BOTH worker builds so they route the SAME Portkey path.
			// Fail-soft: any error leaves the conservative `off`.
			let portkeyWorkerDeps: PortkeyWorkerDeps = { onUnreachable: recordPortkeyUnreachable };
			try {
				const portkeySelection = await readPortkeySelection(vault, secretScopeFromQueryScope(scope));
				portkeyHealth = await resolvePortkeyAssemblyStatus(portkeySelection, scope);
				portkeyWorkerDeps = {
					...(portkeySelection !== undefined ? { selection: portkeySelection } : {}),
					onUnreachable: recordPortkeyUnreachable,
				};
				// ── PRD-063c (c-D-2 / c-AC-1 / c-AC-2 / c-AC-3): wire the late-bound Cohere rerank seam
				// ONLY when the gateway is ON. It reuses 063b's foundation: the SAME `${SECRET_REF}`
				// resolver (`createSecretResolver` under the daemon scope) decrypts `PORTKEY_API_KEY` at
				// CALL time (never seen by the recall engine, c-AC-2); the rerank transport posts to
				// `/v1/rerank` with the SAME `x-portkey-api-key` + `x-portkey-config` headers; and the
				// SAME `recordPortkeyUnreachable` last-failure signal flips `/health` `reasons.portkey`
				// on a rerank failure (c-AC-3). The Cohere model is the env-resolved `cohereModel`. With
				// the gateway off, the inner seam stays absent → the `cohere` strategy keeps the RRF
				// order (c-AC-4). Fail-soft: a build error leaves the inner seam absent (RRF order).
				if (portkeySelection !== undefined) {
					const rerankSecrets = createSecretResolver(
						new SecretsStore({ baseDir: resolveWorkspaceBaseDir(), machineKey: createMachineKeyProvider() }),
						secretScopeFromQueryScope(scope),
					);
					const rerankClient = createPortkeyRerankClient({
						config: portkeySelection.config,
						onTransportError: recordPortkeyUnreachable,
					});
					cohereRerankInner = buildCohereRerankSeam({
						client: rerankClient,
						secrets: rerankSecrets,
						apiKeyRef: PORTKEY_API_KEY_REF,
						model: rerankerMountDeps.reranker.cohereModel,
					});
				} else {
					// Gateway OFF ⇒ EXPLICITLY clear any prior seam in the gateway-off branch itself, so a
					// stop/start cycle that disables Portkey cannot leave a stale reranker egressing recall
					// text. The assignment is now TOTAL (set on, cleared off): "gateway off ⇒ no provider
					// rerank" is guaranteed locally by this decision, not by an upstream reset (c-AC-4).
					cohereRerankInner = undefined;
				}
			} catch {
				portkeyHealth = "off";
				// Belt-and-suspenders: a mid-build throw must also leave NO stale rerank seam (c-AC-4).
				cohereRerankInner = undefined;
			}

			// ── PRD-046a a-AC-1: build + start the SUMMARY worker, the live CONSUMER of
			// `summary` jobs. It is built AFTER `startServices()` so it leases from a started
			// queue. Summaries are a CORE feature (not gated like pollinating), so it starts
			// UNCONDITIONALLY. FAIL-SOFT: a wiring failure is surfaced to stderr but must NEVER
			// prevent the daemon from booting — the daemon is already up and serving; summaries
			// simply stay unproduced this run rather than crashing the process.
			if (startSummaryWorker) {
				try {
					summaryWorker = buildSummaryWorker(storage, scope, daemon.services.queue, embed, pollBackoff);
					summaryWorker.start();
				} catch (err: unknown) {
					const reason = err instanceof Error ? err.message : String(err);
					process.stderr.write(`honeycomb: summary worker start failed (non-fatal): ${reason}\n`);
					summaryWorker = null;
				}
			}

			// ── PRD-045a a-AC-1: build + start the MEMORY-PIPELINE worker, the live CONSUMER of
			// the five pipeline job kinds (extraction → decision → controlled-write →
			// graph-persist → retention). Built AFTER `startServices()` so it leases from a
			// started queue, on the SAME durable `memory_jobs` queue capture enqueues the entry
			// job into. FAIL-SOFT (a-AC-5): a wiring failure is surfaced to stderr but must NEVER
			// prevent the daemon from booting — the daemon is already up and serving; the pipeline
			// simply stays unconsumed this run rather than crashing the process. The model
			// dependency degrades to the no-op client when no `agent.yaml`/`inference:` is present
			// (zero-mutation passes), exactly as the pollinating worker does (constraint).
			if (startPipelineWorker) {
				try {
					pipelineWorker = await buildPipelineWorker(
						options,
						storage,
						scope,
						daemon.services.queue,
						embed,
						pollBackoff,
						portkeyWorkerDeps,
					);
					// PRD-062b (AC-4): when consolidation is ON, DEFER starting the pipeline
					// worker's own loop — the single lease coordinator (built at the pollinating
					// block below, once we know whether pollinating is enabled) drives it. When
					// consolidation is OFF, start it independently now (the AC-9 two-pass path).
					if (!shouldConsolidatePoll) pipelineWorker.start();
				} catch (err: unknown) {
					const reason = err instanceof Error ? err.message : String(err);
					process.stderr.write(`honeycomb: memory-pipeline worker start failed (non-fatal): ${reason}\n`);
					pipelineWorker = null;
				}
			}

			// ── PRD-045f f-AC-1: build + start the SKILLIFY worker, the live CONSUMER of
			// `skillify` jobs capture enqueues when the per-turn threshold is crossed. Built AFTER
			// `startServices()` so it leases from a started queue, on the SAME durable `memory_jobs`
			// queue capture enqueues into. FAIL-SOFT (f-AC-4): a wiring failure is surfaced to
			// stderr but must NEVER prevent the daemon from booting — the daemon is already up and
			// serving; skillify simply stays unconsumed this run rather than crashing the process.
			// The gate shells out to the host CLI (Claude Code) — NO API key is held by the daemon.
			if (startSkillifyWorker) {
				try {
					skillifyWorker = buildSkillifyWorker(storage, scope, daemon.services.queue, pollBackoff);
					skillifyWorker.start();
				} catch (err: unknown) {
					const reason = err instanceof Error ? err.message : String(err);
					process.stderr.write(`honeycomb: skillify worker start failed (non-fatal): ${reason}\n`);
					skillifyWorker = null;
				}
			}

			// ── PRD-032a / AC-3: COPY the shared DeepLake login token into the vault as the
			// `secret`-class `DEEPLAKE_TOKEN` record, ONCE per boot — the LIVE wiring of the
			// migration. NON-DESTRUCTIVE by construction: it READS `~/.deeplake/credentials.json`
			// (via `loadDiskCredentials`) and WRITES only the vault — ZERO writes to the plaintext
			// file, which stays BYTE-UNCHANGED + authoritative for the shared login (D-3). It runs
			// AFTER `startServices()` so it NEVER gates the storage connection (which keeps reading
			// the authoritative plaintext file, env-over-file — the vault is an ADDITIVE cache, not
			// a replacement). Idempotent: a re-boot refreshes the vault copy from the file so a token
			// rotation is picked up. FAIL-SOFT: a `no_creds` no-op (CI / not-logged-in) or a vault
			// write error must NEVER prevent the daemon from booting — the login still resolves from
			// env/file. Only the REAL vault (a full `VaultStore`) migrates; an injected fake reader /
			// the fake-storage suite skips it (the deterministic suite is untouched).
			if (vault instanceof VaultStore) {
				try {
					const migrated = await migrateDeeplakeToken(vault, secretScopeFromQueryScope(scope));
					if (!migrated.ok) {
						// A vault write failure is surfaced (never silently swallowed) but is NOT fatal:
						// the plaintext file is untouched and the login still resolves from env/file.
						process.stderr.write(`honeycomb: DeepLake-token vault migration failed (non-fatal): ${migrated.reason}\n`);
					}
				} catch (err: unknown) {
					const reason = err instanceof Error ? err.message : String(err);
					process.stderr.write(`honeycomb: DeepLake-token vault migration failed (non-fatal): ${reason}\n`);
				}
			}

			// ── PRD-026 AC-W: build + start the pollinating worker, GATED on `config.enabled`
			// (default OFF). It is built AFTER `startServices()` so it leases from a started
			// queue. The build is FAIL-SOFT: a pollinating-config error or a missing inference
			// config degrades to `null` (disabled) / the no-op model client — it must NEVER
			// prevent the daemon from booting, so any error here is swallowed into "no worker"
			// rather than propagated. When the gate is closed, `buildGatedPollinatingWorker`
			// returns null and we start nothing.
			if (startPollinatingWorker) {
				try {
					pollinatingWorker = await buildGatedPollinatingWorker(
						options,
						storage,
						scope,
						daemon.services.queue,
						vault,
						pollBackoff,
						portkeyWorkerDeps,
					);
					// PRD-062b (AC-4): consolidate ONLY the REAL production workers. An explicitly
					// INJECTED test worker (`options.pollinatingWorker`) is a lifecycle-recording fake
					// whose own `start()`/`stop()` the test asserts — it is not a real lease participant,
					// so consolidation must respect its standalone lifecycle and never route it through
					// the coordinator. So consolidation runs only when (a) the flag is on AND (b) the
					// pollinating worker was the REAL build (not injected).
					const pollinatingInjected = options.pollinatingWorker !== undefined;
					if (shouldConsolidatePoll && !pollinatingInjected) {
						// If consolidation is ON, do NOT start the pollinating worker's own loop —
						// register it (with the already-built pipeline worker) as a participant of a
						// SINGLE lease coordinator that runs ONE combined pass over the union of their
						// kinds. Kind isolation is preserved: the union lease only leases a kind a
						// participant owns, and each leased job is dispatched to its owner. The pipeline
						// worker was deferred above under the same flag.
						const participants = [pipelineWorker, pollinatingWorker].filter(
							(p): p is StageWorker | PollinatingJobWorker => p !== null,
						);
						if (participants.length > 0) {
							leaseCoordinator = createLeaseCoordinator({
								queue: daemon.services.queue,
								participants,
								backoff: pollBackoff,
								flatIntervalMs: 1_000,
							});
							leaseCoordinator.start();
						}
					} else {
						// Consolidation OFF (the two-pass AC-9 parity path) OR an injected test worker:
						// start the pollinating worker independently. When consolidation was selected but
						// the pollinating worker was injected, the pipeline worker's start was deferred
						// above, so start it here too so it is never left un-pumped.
						pollinatingWorker?.start();
						if (shouldConsolidatePoll && pollinatingInjected && pipelineWorker !== null) {
							pipelineWorker.start();
						}
					}
				} catch (err: unknown) {
					// A pollinating wiring failure is surfaced to stderr (never silently swallowed) but is
					// NOT fatal: the daemon is already up and serving; pollinating simply stays off this
					// run. We narrow the error to a message so a thrown non-Error still reports cleanly.
					// stderr is the documented daemon log channel (logger.ts) and carries no secret here
					// — `buildGatedPollinatingWorker` resolves the key only inside the router's local scope.
					const reason = err instanceof Error ? err.message : String(err);
					process.stderr.write(`honeycomb: pollinating worker start failed (non-fatal): ${reason}\n`);
					pollinatingWorker = null;
					// If consolidation was selected but the coordinator never started (the pollinating
					// build threw), fall back to starting the pipeline worker's own loop so the pipeline
					// is never left un-pumped after its start was deferred under the consolidation flag.
					if (shouldConsolidatePoll && leaseCoordinator === null && pipelineWorker !== null) {
						pipelineWorker.start();
					}
				}
			}

			// ── Wire + start the Deep Lake idle-cost master switch. Collect every background
			// activity that touches Deep Lake on a timer as a Pausable, then let the controller
			// silence them after `idleMs` with no inbound request so the connection drops and
			// Activeloop scales the per-tenant pod to zero; the next request wakes them. With the
			// flag off (the rollback) this whole block is skipped and every loop runs as before.
			if (hibernationConfig.enabled && startBackgroundWorkers) {
				const pausables: Pausable[] = [];
				const addWorker = (label: string, h: { start(): void; stop(): void } | null): void => {
					if (h !== null) pausables.push({ label, pause: () => h.stop(), resume: () => h.start() });
				};
				addWorker("summary", summaryWorker);
				addWorker("skillify", skillifyWorker);
				// Pause whatever actually drives the lease loop: the consolidated coordinator, or the
				// two workers when running independently (never both — see the consolidation block).
				if (leaseCoordinator !== null) addWorker("lease-coordinator", leaseCoordinator);
				else {
					addWorker("pipeline", pipelineWorker);
					addWorker("pollinating", pollinatingWorker);
				}
				if (storageHealthProbeEnabled) {
					pausables.push({
						label: "health-probe",
						pause: () => {
							if (probeTimer !== null) {
								clearInterval(probeTimer);
								probeTimer = null;
							}
						},
						resume: armHealthProbe,
					});
				}
				if (autoBuildGraph) {
					pausables.push({
						label: "graph-build",
						pause: () => {
							if (graphBuildTimer !== null) {
								clearInterval(graphBuildTimer);
								graphBuildTimer = null;
							}
						},
						resume: armGraphBuild,
					});
				}
				if (pausables.length > 0) {
					hibernation = createDeepLakeHibernation({
						pausables,
						config: hibernationConfig,
						now: () => Date.now(),
						timers: {
							setTimer: (cb, ms) => {
								const t = setTimeout(cb, ms);
								if (typeof t.unref === "function") t.unref();
								return t;
							},
							clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
						},
					});
					hibernation.start();
				}
			}
		},

		async shutdown(): Promise<void> {
			// PRD-062c (AC-5 / AC-62c.1.2): FIRST drain the capture write buffer while the storage
			// client is still up, so any batched-but-unwritten captured rows are flushed before the
			// services stop — a clean shutdown never loses a buffered event. `flush()` is idempotent
			// and never throws (a flush failure is logged inside the handler, not surfaced here). The
			// `?.` tolerates a test seam whose fake capture handler does not implement `flush`.
			await captureHandler.flush?.();
			// Stop the idle-cost hibernation monitor first so a wake can never race the teardown
			// below. It only cancels its own timer; the workers' own stop() does the real teardown.
			hibernation?.stop();
			hibernation = null;
			// a-AC-5: graceful shutdown — stop the pollinating worker + the refresher, drain the
			// services, and remove the lock so no stale lock survives. Idempotent + never throws
			// on a missing lock.
			// PRD-062b (AC-4): stop the single combined lease coordinator first when it owns the
			// poll loop. The individual workers' own `stop()` below is an idempotent no-op when
			// consolidation was on (their loops were never started — the coordinator drove them).
			if (leaseCoordinator !== null) {
				leaseCoordinator.stop();
				leaseCoordinator = null;
			}
			if (pollinatingWorker !== null) {
				pollinatingWorker.stop();
				pollinatingWorker = null;
			}
			// PRD-046a: stop the summary worker's poll loop (idempotent).
			if (summaryWorker !== null) {
				summaryWorker.stop();
				summaryWorker = null;
			}
			// PRD-045a a-AC-1: stop the memory-pipeline worker's poll loop (idempotent).
			if (pipelineWorker !== null) {
				pipelineWorker.stop();
				pipelineWorker = null;
			}
			// PRD-045f f-AC-1: stop the skillify worker's poll loop (idempotent).
			if (skillifyWorker !== null) {
				skillifyWorker.stop();
				skillifyWorker = null;
			}
			if (probeTimer !== null) {
				clearInterval(probeTimer);
				probeTimer = null;
			}
			if (graphBuildTimer !== null) {
				clearInterval(graphBuildTimer);
				graphBuildTimer = null;
			}
			if (started) {
				await daemon.stopServices();
				started = false;
			}
			await localQueue.stop();
			// PRD-043a: close the durable log store handle so no SQLite file handle leaks across a
			// restart. Idempotent + never throws (the NULL no-op's close is a no-op).
			logStore.close();
			if (locked) {
				releaseSingleInstanceLock(runtimeDir);
				locked = false;
			}
		},
	};
}

/** The daemon's own resolved tenancy: the scope its queue + probe run under, plus the
 * friendly org name the dashboard settings view shows (display-only, may be undefined). */
interface DaemonTenancy {
	/** The partition the queue rows + the `SELECT 1` probe carry — never a request's authorized tenancy. */
	readonly scope: QueryScope;
	/** The human-readable org name from the credentials (e.g. "OSPRY"); `undefined` when no creds. */
	readonly orgName: string | undefined;
}

/**
 * Resolve the daemon's OWN tenancy (`{ org, workspace }` + friendly `orgName`) from the
 * SAME credential provider the storage client connected through (env-over-file), so the
 * daemon's default scope can NEVER disagree with the org the client actually authenticated
 * against. (The prior implementation re-read `HONEYCOMB_DEEPLAKE_ORG` from the env ONLY and
 * fell back to the `"local"` placeholder — so a plain `honeycomb login` with NO env left the
 * client connected to the real org while the scope said `"local"`, degrading `/health` and
 * breaking recall. THAT split was the bug.)
 *
 * Precedence (matching `resolveStorageConfig`'s env-over-file merge):
 *   (a) `HONEYCOMB_DEEPLAKE_ORG` / `_WORKSPACE` env if set — the explicit override + the
 *       live-itest path that exports them (preserved exactly);
 *   (b) else the resolved credentials' `org` (← `orgId`) + `workspace` (← `workspaceId`) from
 *       `~/.deeplake/credentials.json` via the SAME `provider` the storage client used;
 *   (c) else `{ org: "local", workspace: "default" }` — the TRUE no-creds fallback (an
 *       injected fake client in unit tests has no provider, so the deterministic suite is
 *       unchanged).
 *
 * `provider` is the resolved credential provider (or `undefined` for a fake-client assembly
 * with no provider injected → the `"local"` fallback). It is read at most ONCE here; the
 * record is the un-validated raw config (the same `read()` the storage config validates),
 * carrying `org` / `workspace` / `orgName`. No token is read or logged here.
 */
function resolveDaemonTenancy(provider: CredentialProvider | undefined): DaemonTenancy {
	// (a) Env override wins, exactly as before — preserves the explicit escape hatch and the
	//     live-itest path that exports `HONEYCOMB_DEEPLAKE_ORG`/`_WORKSPACE`.
	const envOrg = process.env.HONEYCOMB_DEEPLAKE_ORG;
	const envWorkspace = process.env.HONEYCOMB_DEEPLAKE_WORKSPACE;

	// (b) The resolved credentials from the SAME provider the client connected through. `read()`
	//     applies the env-over-file merge already, so this single source agrees with the client.
	const record = provider !== undefined ? provider.read() : {};
	const fileOrg = asNonEmptyString(record.org);
	const fileWorkspace = asNonEmptyString(record.workspace);
	const orgName = asNonEmptyString(record.orgName);

	const org = envOrg !== undefined && envOrg.length > 0 ? envOrg : fileOrg;
	const workspace = envWorkspace !== undefined && envWorkspace.length > 0 ? envWorkspace : fileWorkspace;

	if (org !== undefined) {
		// A workspace is optional on the scope (the client defaults it to the config workspace);
		// thread it when we resolved one so the partition matches the storage client.
		const scope: QueryScope = workspace !== undefined ? { org, workspace } : { org };
		return { scope, orgName };
	}

	// (c) No creds at all (fake client / no env) → the deterministic single-user loopback scope.
	return { scope: { org: "local", workspace: "default" }, orgName: undefined };
}

/** Narrow an unknown provider-record field to a non-empty string, else `undefined`. */
function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

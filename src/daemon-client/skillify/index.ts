/**
 * Skillify thin-client barrel — PRD-016c (the COLLAB half: pull + auto-pull + fan-out).
 *
 * One import surface for the storage-client-free pull subsystem. Everything here lives
 * under `src/daemon-client/` and reaches the `skills` table ONLY through the daemon
 * dispatch seam (c-AC-6 / D-10) — the daemon-runtime `install.ts` re-exports `pull` /
 * `autoPull` from here so the skillify barrel surface is unchanged.
 */

export {
	type AgentRootDetector,
	type AuthCheck,
	createFakeSkillPullClient,
	createFakeTrustedTableList,
	type DecideActionInput,
	type FakePullClientOptions,
	type FakeSkillPullClient,
	type PullAction,
	type PulledSkill,
	type PullManifestEntry,
	type PullManifestStore,
	type SkillInstall,
	type SkillPullClient,
	type SkillScope,
	type TrustedTableList,
} from "./contracts.js";

export {
	AUTOPULL_DISABLED_ENV,
	AUTOPULL_TIMEOUT_MS,
	autoPull,
	type AutoPullDeps,
	backfillSymlinks,
	canonicalDirName,
	createAuthCheck,
	createDefaultAgentRoots,
	decideAction,
	pull,
	type PullDeps,
	type PullOutcome,
	recordPull,
	unpullSkill,
	type UnpullOutcome,
} from "./install.js";

export { buildLatestSkillsSql, createDaemonPullClient, RESOLVE_POLLS } from "./pull-client.js";

// ── PRD-018a scope config persistence (filesystem-only, org→team coercion) ──
export {
	coerceScope,
	createSkillifyConfigStore,
	DEFAULT_CONFIG,
	defaultConfigBaseDir,
	normalizeConfig,
	parseUsersList,
	type SkillifyConfig,
	type SkillifyConfigStore,
} from "./config.js";

// ── PRD-018b pull manifest (reversible pull record + 018c backfill source) ──
// R-2: now a thin adapter over the unified `~/.honeycomb/registry.json` (the single SoT), with a
// one-time idempotent fold of the legacy `pull-manifest.json`. The `PullManifestStore` surface is
// unchanged, so `pull` / `unpullSkill` / `backfillSymlinks` are unaffected.
export { createPullManifestStore, defaultManifestBaseDir, legacyManifestPaths } from "./manifest.js";
export { migrateLegacyManifest, MIGRATED_SUFFIX } from "./migrate-manifest.js";

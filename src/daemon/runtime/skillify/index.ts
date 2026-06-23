/**
 * Skillify barrel — PRD-016. One import surface for the skillify subsystem so a
 * consumer (the daemon worker assembly, the 016a/016c Wave-2 Bees, the tests) reaches
 * the contracts, the 016b write/read path, and the Wave-2 stubs from one place.
 *
 * 016b (this Wave) is FULL: contracts + seams, the append-only `SkillStore`, the
 * verdict→write path (`writeSkill`/`writeNewSkill`/`mergeSkill`), the SKILL.md
 * renderer, the filesystem install target, and the oldest-session watermark. 016a
 * (`miner.ts`) and 016c (`install.ts`) are honest stubs the Wave-2 Bees fill.
 */

// ── Contracts + seams (the pinned Wave-2 surface) ──
export {
	createFakeGateCli,
	GATE_VERDICTS,
	type GateCli,
	type GateDecision,
	type GateVerdict,
	type MinedPair,
	notImplemented,
	type Skill,
	SKILL_INSTALLS,
	SKILL_SCOPES,
	SKILLOPT_CONTRIBUTOR,
	type SkillInstall,
	type SkillInstallTarget,
	skillLogicalId,
	type SkillProvenance,
	type SkillScope,
	type SkillStore,
} from "./contracts.js";

// ── 016b skills writes (FULL) ──
export {
	createSkillStore,
	mergeSkill,
	renderSkillMarkdown,
	RESOLVE_POLLS,
	SKILLS_TABLE,
	type SkillWriteDeps,
	writeNewSkill,
	writeSkill,
	type WriteSkillOutcome,
} from "./skills-write.js";

// ── 016b install target (FULL) ──
export { createFsInstallTarget, type FsInstallDirs } from "./install-target.js";

// ── 016b watermark (FULL) ──
export {
	createWatermarkStore,
	defaultWatermarkBaseDir,
	type WatermarkStore,
} from "./watermark.js";

// ── 016a trace miner (FULL) ──
export {
	buildGatePrompt,
	createFileWorkerLock,
	createHostCliGate,
	createSessionFetcher,
	defaultLockBaseDir,
	evaluateTrigger,
	extractPairs,
	extractPairsFromRows,
	FETCH_SESSION_LIMIT,
	GATE_TIMEOUT_MS,
	type GateSpawner,
	type HostCliSpec,
	KEEP_MIN_EXCHANGES,
	type LockHandle,
	MAX_BATCH_CHARS,
	MAX_PAIR_CHARS,
	mine,
	type MineDeps,
	type MineOutcome,
	type MineResult,
	type MineScope,
	type MineSkippedReason,
	normalizeVerdict,
	parseVerdictStdout,
	recursEnough,
	REDACTED,
	redactSecrets,
	runGate,
	type SessionFetcher,
	type SessionRow,
	SESSIONS_TABLE,
	skillifyEveryNTurns,
	SKILLIFY_EVERY_N_TURNS_ENV,
	systemGateSpawner,
	type TriggerDecision,
	withTimeout,
	type WorkerLock,
} from "./miner.js";

// ── 016c skill install + 018b/c hardening (FULL — re-exported from `daemon-client/skillify`) ──
export {
	AUTOPULL_DISABLED_ENV,
	AUTOPULL_TIMEOUT_MS,
	autoPull,
	type AutoPullDeps,
	backfillSymlinks,
	canonicalDirName,
	createAuthCheck,
	createDaemonPullClient,
	createDefaultAgentRoots,
	createFakeSkillPullClient,
	createPullManifestStore,
	createSkillifyConfigStore,
	decideAction,
	type PullAction,
	type PulledSkill,
	pull,
	type PullDeps,
	type PullManifestStore,
	type PullOutcome,
	recordPull,
	type SkillifyConfig,
	type SkillifyConfigStore,
	type SkillPullClient,
	type TrustedTableList,
	unpullSkill,
} from "./install.js";

// ── 018a daemon-side publish/select endpoint seam (reaches DeepLake — daemon-only) ──
export {
	buildSelectNewerSql,
	createSkillPublishEndpoint,
	type PublishedSkill,
	type SkillPublishEndpoint,
} from "./publish-endpoint.js";

// ── 045g the `/api/skills/*` PUBLISH + PULL mount seam (closes the PRD-018 wiring gap) ──
export {
	mountSkillPropagationApi,
	type MountSkillPropagationOptions,
	SKILLS_GROUP as SKILLS_PROPAGATION_GROUP,
} from "./propagation-api.js";

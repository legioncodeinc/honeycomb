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
	type FakePullClientOptions,
	type FakeSkillPullClient,
	type PulledSkill,
	type SkillPullClient,
} from "./contracts.js";

export {
	AUTOPULL_DISABLED_ENV,
	AUTOPULL_TIMEOUT_MS,
	autoPull,
	type AutoPullDeps,
	canonicalDirName,
	createAuthCheck,
	createDefaultAgentRoots,
	pull,
	type PullDeps,
	type PullOutcome,
} from "./install.js";

export { buildLatestSkillsSql, createDaemonPullClient, RESOLVE_POLLS } from "./pull-client.js";

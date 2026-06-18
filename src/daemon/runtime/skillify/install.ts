/**
 * Skill install — PRD-016c (Wave 2, the COLLAB half). FILLED via re-export.
 *
 * ── Why this module is a thin re-export, not the implementation ─────────────
 * 016c's pull + auto-pull are STRUCTURALLY a thin client (CONVENTIONS §4: "016a's
 * trigger and 016c's pull signal the daemon over port 3850"), and c-AC-6 / D-10 require
 * every pull to query the `skills` store THROUGH THE DAEMON, never a direct DeepLake
 * connection. So the real logic lives under `src/daemon-client/skillify/` — a NON-daemon
 * root the thin-client invariant (`tests/daemon/storage/invariant.test.ts`) scans, which
 * STRUCTURALLY forbids a storage-client import. Putting `pull` here, in a daemon root,
 * would let it import `SkillStore` / `createSkillStore` (the storage client) and silently
 * break the invariant the AC demands.
 *
 * This module re-exports that thin-client surface so the skillify barrel
 * (`src/daemon/runtime/skillify/index.ts`) keeps exporting `pull` / `autoPull` /
 * `PullOutcome` unchanged — CONVENTIONS §8's "fill install.ts" stays honest, the seam home
 * is correct. `src/daemon` → `src/daemon-client` is a DOWNWARD import (core = daemon-client,
 * connector-base = daemon), so this re-export respects the build-order direction.
 *
 * 016c CONSUMES 016b's append-only rows: the production `createDaemonPullClient` reads the
 * highest-version-per-(name,author) skill THROUGH THE DAEMON dispatch seam, the SAME
 * version-resolution shape 016b's `createSkillStore` writes (poll-convergent MAX(version)).
 */

export {
	AUTOPULL_DISABLED_ENV,
	AUTOPULL_TIMEOUT_MS,
	autoPull,
	type AutoPullDeps,
	canonicalDirName,
	createAuthCheck,
	createDaemonPullClient,
	createDefaultAgentRoots,
	createFakeSkillPullClient,
	type PulledSkill,
	pull,
	type PullDeps,
	type PullOutcome,
	type SkillPullClient,
} from "../../../daemon-client/skillify/index.js";

/**
 * Skillify pull thin-client contracts + seams — PRD-016c (Wave 2, the COLLAB half).
 *
 * The central thesis (c-AC-6 / D-10 / the thin-client invariant
 * `tests/daemon/storage/invariant.test.ts`):
 *
 *   PULL READS THE LATEST SKILLS THROUGH THE DAEMON — IT NEVER OPENS DEEPLAKE.
 *
 * 016c is structurally a THIN CLIENT (CONVENTIONS §4: "016a's trigger and 016c's
 * pull signal the daemon over port 3850"). So — exactly like PRD-015's `DeepLakeFs`
 * (`src/daemon-client/vfs/`) — this subsystem lives under `src/daemon-client/`, a
 * NON-daemon root the invariant test scans: a stray `from ".../daemon/storage/client"`
 * import would fail the build. The ONLY way out to the `skills` table is the
 * {@link SkillPullClient} dispatch seam below; in production it POSTs the highest-version
 * read to the daemon, in tests it is a recording fake.
 *
 * The daemon-runtime `install.ts` stub (`src/daemon/runtime/skillify/install.ts`)
 * RE-EXPORTS this module's `pull` / `autoPull`, so the skillify barrel surface is
 * unchanged and CONVENTIONS §8's "fill install.ts" stays honest — but the real logic
 * (which fans out symlinks AND reaches storage) lives HERE, where it is provably
 * storage-client-free.
 *
 * What is OK to import (pure, storage-free): nothing under `daemon/storage` except the
 * pure `sql.ts` helpers (the SQL-injection floor) — the same exemption the VFS uses.
 */

// ─────────────────────────────────────────────────────────────────────────────
// PulledSkill — the highest-version skill row a pull writes (mirrors `skills`).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One published skill returned by a pull (c-AC-1). The dispatch seam resolves the
 * HIGHEST version per `(name, author)` THROUGH THE DAEMON and hands back this minimal
 * shape; the pull writes `~/.claude/skills/<name>--<author>/SKILL.md` from it.
 *
 * The fields mirror the `skills` catalog columns the daemon reads
 * (`name` / `author` / `version` / `body`). `body` is the already-rendered SKILL.md
 * markdown (provenance frontmatter + body) that 016b wrote — the pull writes it
 * verbatim, it does NOT re-render. The local-vs-remote version compare keys off
 * `version` for the idempotent skip (c-AC-2).
 */
export interface PulledSkill {
	/** The skill's logical name (the `<name>` half of the canonical dir). */
	readonly name: string;
	/** The author/agent that mined it (the `--<author>` half of the canonical dir). */
	readonly author: string;
	/** The append-only version this row sits at (highest = current). */
	readonly version: number;
	/** The rendered SKILL.md markdown (frontmatter + body) written verbatim. */
	readonly body: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// SkillPullClient SEAM — the ONLY path out to the skills store (c-AC-6 / D-10).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE pull seam (c-AC-6 / D-10 / FR-8) — the ONLY way this module reaches the `skills`
 * table.
 *
 * The real implementation ({@link createDaemonPullClient}) builds the highest-version-
 * per-(name,author) SELECT with the PURE `sqlIdent` / `sLiteral` helpers and DISPATCHES
 * it through the honeycomb daemon on `127.0.0.1:3850` — the daemon is the sole DeepLake
 * client and applies the org/workspace scope as a partition filter. In tests the seam is
 * a recording FAKE so a test asserts the pull reached storage ONLY through this seam (a
 * pull that opened DeepLake directly could not even compile under the thin-client
 * invariant).
 *
 * `readLatestSkills` resolves the latest published skills for the authenticated scope; a
 * dispatch FAILURE rejects (the manual `pull` surfaces it; `autoPull` SWALLOWS it).
 */
export interface SkillPullClient {
	/** Read the highest-version skills for the active scope, THROUGH THE DAEMON. */
	readLatestSkills(): Promise<readonly PulledSkill[]>;
}

/**
 * Build a deterministic FAKE {@link SkillPullClient} from a fixed skill list (the test
 * double — there is no daemon in the unit-test env). Records each call on `.calls` so a
 * test asserts the pull reached storage ONLY through this seam, and can be made to reject
 * (a slow/erroring store) to drive the auto-pull swallow path (c-AC-2).
 */
export interface FakeSkillPullClient extends SkillPullClient {
	/** How many times `readLatestSkills` was invoked (the dispatch was reached). */
	readonly calls: { count: number };
}

/** Options for {@link createFakeSkillPullClient}. */
export interface FakePullClientOptions {
	/** The skills the fake returns (default: none). */
	readonly skills?: readonly PulledSkill[];
	/** When set, every call REJECTS with this error (drives the auto-pull swallow). */
	readonly failWith?: Error;
	/** When set, the call resolves after this many ms (drives the 5s-timeout path). */
	readonly delayMs?: number;
}

/** Build a FAKE {@link SkillPullClient} for tests (records call count; answers from `skills`). */
export function createFakeSkillPullClient(options: FakePullClientOptions = {}): FakeSkillPullClient {
	const calls = { count: 0 };
	const skills = options.skills ?? [];
	return {
		calls,
		async readLatestSkills(): Promise<readonly PulledSkill[]> {
			calls.count++;
			if (options.delayMs !== undefined && options.delayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, options.delayMs));
			}
			if (options.failWith !== undefined) throw options.failWith;
			return skills;
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentRootDetector SEAM — the detected agent skill roots for the fan-out (c-AC-5).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The detected agent skill roots a global-install pull fans symlinks into (c-AC-5 /
 * FR-4). The CANONICAL root is where `~/.claude/skills/<name>--<author>/` is written;
 * each OTHER detected root gets a symlink pointing at that canonical directory, so a
 * pulled skill shows up in every agent at once with no per-harness install.
 *
 * Detection is INJECTABLE so a test points the roots at temp dirs (no real `~` writes).
 * In production {@link createDefaultAgentRoots} discovers `~/.claude/skills`,
 * `~/.agents/skills`, `~/.hermes/skills`, `~/.pi/agent/skills`, … under the user's home.
 */
export interface AgentRootDetector {
	/** The canonical root where `<name>--<author>/SKILL.md` is written. */
	canonicalRoot(): string;
	/** Every OTHER detected agent skills root the symlink fans out into. */
	otherRoots(): readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// AuthCheck SEAM — the unauthenticated-skip gate for auto-pull (c-AC-4).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The authentication probe auto-pull consults before running (c-AC-4 / FR-7). An
 * UNAUTHENTICATED session skips the pull SILENTLY — no warning, no token leak. The real
 * impl reads `loadCredentials` (or the `HONEYCOMB_TOKEN` env) WITHOUT echoing the token;
 * a test injects a fixed boolean.
 */
export interface AuthCheck {
	/** True when the session has credentials a pull can run under. */
	isAuthenticated(): boolean;
}

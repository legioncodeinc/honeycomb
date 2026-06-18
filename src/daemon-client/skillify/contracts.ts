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
 *
 * ── PRD-018 extends this surface (no removals) ──────────────────────────────
 * 018 hardens the COLLAB half into a real team-sharing pipeline. It adds (below):
 *   - the `me`/`team` {@link SkillScope} + `project`/`global` {@link SkillInstall}
 *     re-exports (so the thin-client side shares one source with the daemon contracts);
 *   - the {@link TrustedTableList} seam (018b trusted-table early-exit, b-AC-2);
 *   - {@link PullManifestStore} + {@link PullManifestEntry} (018b manifest, b-AC tracking);
 *   - {@link PullAction} + {@link DecideActionInput} (018b `decideAction` policy).
 */

// ─────────────────────────────────────────────────────────────────────────────
// SkillScope / SkillInstall — the me/team + project/global axes (PRD-018a).
// One source for both the thin-client config (config.ts) and the pull engine.
// ─────────────────────────────────────────────────────────────────────────────

/** A skill's sharing scope (PRD-018a). `me` = private; `team` = co-owned. */
export type SkillScope = "me" | "team";

/** Where a SKILL.md lands (PRD-018a). `project` = cwd `.claude/skills`; `global` = home. */
export type SkillInstall = "project" | "global";

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
	/**
	 * The author/agent that mined it (the `--<author>` half of the canonical dir). An
	 * EMPTY author is the local-mined-slot sentinel: a remote skill with `author === ""`
	 * is SKIPPED on pull (PRD-018b b-AC-5 / FR-7), because writing it to `<root>/<name>/`
	 * would clobber the user's own locally-mined `<name>/` slot and break coexistence.
	 */
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

// ─────────────────────────────────────────────────────────────────────────────
// TrustedTableList SEAM — the trusted-table early-exit gate (PRD-018b b-AC-2).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The trusted-table-list probe auto-pull consults BEFORE the SELECT (PRD-018b b-AC-2 /
 * FR-5). On a fresh workspace the `skills` table may not exist yet; rather than dispatch
 * a SELECT that the daemon answers with a `relation "skills" does not exist` error (which
 * would surface in the logs), the pull asks the daemon for its trusted table list and, if
 * `skills` is absent, SKIPS the SELECT entirely — no error, no noise.
 *
 * The real impl asks the daemon (which holds the DeepLake catalog) over the same 3850
 * dispatch; a test injects a fixed set. `null` means "could not determine" → the pull
 * proceeds (fail-open: a transient list failure must not silently disable pulls forever).
 */
export interface TrustedTableList {
	/**
	 * The set of table names the daemon trusts/knows, or `null` when the list could not be
	 * resolved. When non-null and `skills` is absent, the pull skips the SELECT (b-AC-2).
	 */
	tables(): Promise<readonly string[] | null>;
}

/** Build a FAKE {@link TrustedTableList} from a fixed table set (or `null`) for tests. */
export function createFakeTrustedTableList(tables: readonly string[] | null): TrustedTableList {
	return { tables: () => Promise.resolve(tables) };
}

// ─────────────────────────────────────────────────────────────────────────────
// PullAction — the decideAction policy verdict (PRD-018b b-AC-1 / b-AC-3 / FR-3).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a pull should DO with one remote skill, resolved by `decideAction` (PRD-018b
 * FR-3). The policy compares the remote version against the local copy:
 *
 *   - `write`         the local file is ABSENT → write it (no backup needed).
 *   - `backup-write`  the remote is NEWER than local (or `--force`) → back the existing
 *                     `SKILL.md` up to `SKILL.md.bak`, THEN write the newer body (b-AC-3).
 *   - `skip`          the remote is at-or-older than local and not forced → touch nothing.
 */
export type PullAction = "write" | "backup-write" | "skip";

/** The inputs `decideAction` resolves a {@link PullAction} from (PRD-018b FR-3). */
export interface DecideActionInput {
	/** True when a local `SKILL.md` already exists at the canonical path. */
	readonly localExists: boolean;
	/** The local SKILL.md's frontmatter version, or `null` when absent/unreadable. */
	readonly localVersion: number | null;
	/** The remote skill's version. */
	readonly remoteVersion: number;
	/** The `--force` flag: re-write even when remote is not newer (backs up first). */
	readonly force: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// PullManifestEntry + PullManifestStore — the reversible pull record (PRD-018b).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One globally-installed pulled skill's manifest record (PRD-018b FR-8 / b-AC tracking).
 * The manifest is the source of truth for `honeycomb skill unpull` (it reverses ONLY
 * pull-managed entries) AND for 018c's `backfillSymlinks` (it scans every globally-
 * installed entry to ensure a link in each detected root). Persisted on disk under
 * `~/.honeycomb/state/skillify/pull-manifest.json`, keyed by `dirName`.
 */
export interface PullManifestEntry {
	/** The canonical `<name>--<author>` dir name (the manifest key + the link/file name). */
	readonly dirName: string;
	/** The skill's logical name. */
	readonly name: string;
	/** The skill's author. */
	readonly author: string;
	/** The project key the pull ran under (provenance; project-local pulls record it). */
	readonly projectKey: string;
	/** The remote version this entry was written at. */
	readonly remoteVersion: number;
	/** Where it was installed — `project` | `global`. Backfill/fan-out gate on `global`. */
	readonly install: SkillInstall;
	/** The canonical root the SKILL.md was written under (the symlink target's parent). */
	readonly installRoot: string;
	/** ISO timestamp the pull wrote this entry. */
	readonly pulledAt: string;
	/** The absolute symlink paths fanned out into the other roots (for `unpull`). */
	readonly symlinks: readonly string[];
}

/**
 * The on-disk pull manifest store (PRD-018b FR-8). Records one {@link PullManifestEntry}
 * per globally-installed pulled skill so `unpull` can reverse pull-managed entries and
 * `backfillSymlinks` can re-fan prior pulls into a newly-installed agent. Filesystem-only
 * (LOCAL bookkeeping, never DeepLake), mirroring the `watermark.ts` state-root convention.
 */
export interface PullManifestStore {
	/** Read every recorded entry (empty when the manifest is absent/garbled — never throws). */
	read(): readonly PullManifestEntry[];
	/** Upsert one entry, keyed by `dirName` (a re-pull replaces the prior record). */
	record(entry: PullManifestEntry): void;
	/** Remove the entry for `dirName` (the `unpull` reversal). Returns the removed entry, or null. */
	remove(dirName: string): PullManifestEntry | null;
}

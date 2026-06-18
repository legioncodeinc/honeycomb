/**
 * Skill install + propagation — PRD-016c (the COLLAB half) HARDENED by PRD-018b + 018c.
 *
 * 016c owns session-start propagation (pull / autoPull / fan-out); 018 turns it into a
 * real team-sharing pipeline. The module still lives under `src/daemon-client/` — a
 * NON-daemon root the invariant test scans — and reaches the `skills` table ONLY through
 * the injected {@link SkillPullClient} seam. 018 adds NO storage path; it adds local policy.
 *
 * ── 018b additions (the conflict policy + reversibility) ────────────────────
 *   - {@link decideAction} (FR-3 / b-AC-1 / b-AC-3): local-absent → write; remote>local
 *     (or `--force`) → back up `SKILL.md`→`SKILL.md.bak` then write; remote<=local && !force
 *     → skip. The 4 branches replace 016's single skip-if-local-newer compare.
 *   - `--dry-run` (FR-3 / c-AC-5): report every decision, touch NOTHING on disk.
 *   - trusted-table early-exit (FR-5 / b-AC-2): ask the daemon for its trusted table list;
 *     if `skills` is absent skip the SELECT so no relation-does-not-exist error logs.
 *   - empty-author skip (FR-7 / b-AC-5): a remote skill with `author===""` is skipped to
 *     protect the user's local-mined `<name>/` slot.
 *   - the pull manifest (FR-8): every globally-installed write records a
 *     {@link PullManifestEntry}; a `recordPull` failure surfaces as `manifestError`.
 *
 * ── 018c additions (global-only fan-out + self-heal + backfill) ─────────────
 *   - global-install-only gating (D-4 / FR-3 / c-AC-3): a project-local pull NEVER fans out
 *     and NEVER backfills. The `install` field decides.
 *   - self-healing stale links (FR-4 / c-AC-4): a link pointing at a DIFFERENT canonical
 *     path is unlinked + recreated; a correct link is left untouched (c-AC-6).
 *   - {@link backfillSymlinks} (FR-6 / FR-7 / c-AC-2): at the end of every non-dry-run global
 *     pull, scan the manifest for all globally-installed entries and ensure each has a link
 *     in every currently-detected root — closing the gap where a `skipped` up-to-date skill
 *     never triggers per-row fan-out so a newly-installed agent still inherits prior pulls.
 *
 * ── Path / symlink safety (preserved + extended) ────────────────────────────
 * `<name>--<author>` is reduced to a single safe segment (`sanitizeSegment`); a symlink
 * TARGET is ALWAYS the just-written canonical dir under the canonical root, never attacker-
 * controlled. The stale-link `unlink` only ever removes a path INSIDE a detected root whose
 * link resolves to OUR canonical dir (verified by `readlinkSync` + path-equality) — it never
 * follows a link out and deletes. A win32 no-privilege symlink error is swallowed per-link.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
	type AgentRootDetector,
	type AuthCheck,
	type DecideActionInput,
	type PullAction,
	type PullManifestEntry,
	type PullManifestStore,
	type PulledSkill,
	type SkillInstall,
	type SkillPullClient,
	type TrustedTableList,
} from "./contracts.js";

/** The env var that disables session-start auto-pull entirely (b-AC-4 / FR-6). */
export const AUTOPULL_DISABLED_ENV = "HONEYCOMB_AUTOPULL_DISABLED";

/** The auto-pull timeout budget — a slow store never blocks startup past this (b-AC-6 / FR-4). */
export const AUTOPULL_TIMEOUT_MS = 5_000;

/** The canonical file name written inside each `<name>--<author>/` dir. */
const SKILL_FILE = "SKILL.md";

/** The backup name a newer-version write leaves the prior `SKILL.md` at (D-2 / b-AC-3). */
const SKILL_BACKUP_FILE = "SKILL.md.bak";

/** The `skills` table name the trusted-table early-exit checks for (b-AC-2). */
const SKILLS_TABLE = "skills";

/** The outcome of a pull: how many skills + symlinks landed, plus any manifest error. */
export interface PullOutcome {
	/** Canonical `<name>--<author>/SKILL.md` files written (a skip does NOT count). */
	readonly skillsWritten: number;
	/** Symlinks fanned out into detected agent roots (c-AC-1 / c-AC-5). */
	readonly symlinksCreated: number;
	/** Skills skipped — local at/newer than remote, or empty-author, or remote-table-absent. */
	readonly skillsSkipped: number;
	/** Skills backed up to `SKILL.md.bak` before a newer write landed (b-AC-3). */
	readonly skillsBackedUp: number;
	/** True when the SELECT was skipped because `skills` was absent from the trusted list (b-AC-2). */
	readonly tableAbsent: boolean;
	/** True when nothing was written — `--dry-run` (c-AC-5). */
	readonly dryRun: boolean;
	/** A manifest write failure, surfaced (never thrown) so the pull still completes (FR-8). */
	readonly manifestError: string | null;
}

/** The injectable seams a {@link pull} runs against (storage-free defaults). */
export interface PullDeps {
	/** The ONLY path out to the `skills` store (b-AC-6) — in prod a daemon dispatch, in tests a fake. */
	readonly client: SkillPullClient;
	/** The detected agent skill roots (c-AC-5) — injectable so tests use temp dirs. */
	readonly roots: AgentRootDetector;
	/**
	 * Where the SKILL.md lands — `global` fans out + backfills; `project` never does
	 * (D-4 / c-AC-3). Defaults to `global` (the canonical `~/.claude/skills` pull is a
	 * global install; a project-local pull opts in by passing `project`).
	 */
	readonly install?: SkillInstall;
	/** The pull manifest store (FR-8) — records globally-installed entries for unpull + backfill. */
	readonly manifest?: PullManifestStore;
	/** The trusted-table list probe (b-AC-2) — when `skills` is absent the SELECT is skipped. */
	readonly trustedTables?: TrustedTableList;
	/** Report-only mode — touch NOTHING on disk (c-AC-5 / FR-3). */
	readonly dryRun?: boolean;
	/** Re-write even when remote is not newer (backs up first) — `--force` (FR-3). */
	readonly force?: boolean;
	/** The project key recorded in the manifest (provenance). Default `"default"`. */
	readonly projectKey?: string;
}

/**
 * `honeycomb skill pull` (b-AC-1..6 / c-AC-1..6). Reads the latest skills THROUGH THE
 * DAEMON, then for each applies the {@link decideAction} policy:
 *
 *   - empty-author → skip (protect the local-mined slot, b-AC-5);
 *   - `decideAction` → `write` / `backup-write` / `skip` (b-AC-1 / b-AC-3);
 *   - a non-skip on a GLOBAL install fans out symlinks + records a manifest entry;
 *   - a `--dry-run` reports every decision but writes nothing (c-AC-5).
 *
 * Before the SELECT, the trusted-table early-exit (b-AC-2) skips the read entirely when
 * `skills` is absent. After the per-row pass, a non-dry-run GLOBAL pull runs
 * {@link backfillSymlinks} (c-AC-2). Errors propagate to the caller — `autoPull` swallows them.
 */
export async function pull(deps: PullDeps): Promise<PullOutcome> {
	const dryRun = deps.dryRun ?? false;
	const force = deps.force ?? false;
	const projectKey = deps.projectKey ?? "default";
	const install: SkillInstall = deps.install ?? "global";
	const isGlobal = install === "global";

	// b-AC-2: trusted-table early-exit. If the daemon knows its tables and `skills` is
	// absent, skip the SELECT entirely — no relation-does-not-exist log.
	if (await skillsTableAbsent(deps.trustedTables)) {
		return emptyOutcome({ tableAbsent: true, dryRun });
	}

	const skills = await deps.client.readLatestSkills();
	const canonicalRoot = deps.roots.canonicalRoot();
	const otherRoots = isGlobal ? deps.roots.otherRoots() : [];

	let skillsWritten = 0;
	let symlinksCreated = 0;
	let skillsSkipped = 0;
	let skillsBackedUp = 0;
	let manifestError: string | null = null;

	for (const skill of skills) {
		// b-AC-5: an empty-author remote skill is skipped to protect the local-mined slot.
		if (skill.author === "") {
			skillsSkipped++;
			continue;
		}

		const dirName = canonicalDirName(skill.name, skill.author);
		const canonicalDir = join(canonicalRoot, dirName);
		const file = join(canonicalDir, SKILL_FILE);

		const action = decideAction({
			localExists: existsSync(file),
			localVersion: readLocalVersion(canonicalDir),
			remoteVersion: skill.version,
			force,
		});

		if (action === "skip") {
			skillsSkipped++;
			continue;
		}

		if (dryRun) {
			// c-AC-5: a dry-run reports the decision (a would-write) but touches nothing.
			skillsWritten++;
			if (action === "backup-write") skillsBackedUp++;
			continue;
		}

		if (action === "backup-write") {
			if (backupExisting(file)) skillsBackedUp++;
		}
		writeCanonicalSkill(canonicalDir, skill.body);
		skillsWritten++;

		// 018c: fan-out ONLY for a global install (D-4 / c-AC-3); project-local never fans out.
		const symlinks: string[] = [];
		if (isGlobal) {
			symlinksCreated += fanOutSymlinks(otherRoots, dirName, canonicalDir, symlinks);
		}

		// FR-8: record every GLOBAL write in the manifest (for unpull + backfill). A record
		// failure is surfaced, never thrown — the pull still completes.
		if (isGlobal && deps.manifest !== undefined) {
			const recorded = recordPull(deps.manifest, {
				dirName,
				name: skill.name,
				author: skill.author,
				projectKey,
				remoteVersion: skill.version,
				install: "global",
				installRoot: canonicalRoot,
				pulledAt: new Date().toISOString(),
				symlinks,
			});
			if (recorded !== null) manifestError = recorded;
		}
	}

	// c-AC-2: backfill closes the skipped-path gap — a newly-installed agent inherits prior
	// pulls. Global, non-dry-run only (D-4 / FR-6).
	if (isGlobal && !dryRun && deps.manifest !== undefined) {
		symlinksCreated += backfillSymlinks(deps.manifest, deps.roots);
	}

	return { skillsWritten, symlinksCreated, skillsSkipped, skillsBackedUp, tableAbsent: false, dryRun, manifestError };
}

/** The injectable seams an {@link autoPull} runs against. */
export interface AutoPullDeps extends PullDeps {
	/** The unauthenticated-skip gate (b-AC-4). */
	readonly auth: AuthCheck;
	/** The env (defaults to `process.env`) — the disabled-flag rule applies here (b-AC-4). */
	readonly env?: NodeJS.ProcessEnv;
	/** The timeout budget in ms (default {@link AUTOPULL_TIMEOUT_MS}). */
	readonly timeoutMs?: number;
}

/**
 * Auto-pull at session start (b-AC-4 / b-AC-6). Idempotent + fail-soft:
 *
 *   - `HONEYCOMB_AUTOPULL_DISABLED=1` → return `null`, run NOTHING (b-AC-4).
 *   - unauthenticated → return `null` SILENTLY, no warning, no token touched (b-AC-4).
 *   - otherwise → run {@link pull}, bounded by a 5s timeout; ANY error is SWALLOWED so
 *     startup is never blocked (b-AC-6). A swallowed/timed-out run returns `null`.
 *
 * The conflict policy + idempotency are inherited from {@link pull} — auto-pull adds the
 * gating + the bound, not a second compare.
 */
export async function autoPull(deps: AutoPullDeps): Promise<PullOutcome | null> {
	const env = deps.env ?? process.env;

	// b-AC-4: the kill switch. Run nothing.
	if (env[AUTOPULL_DISABLED_ENV] === "1") return null;

	// b-AC-4: unauthenticated → skip SILENTLY (no warning, no token leak).
	if (!deps.auth.isAuthenticated()) return null;

	const timeoutMs = deps.timeoutMs ?? AUTOPULL_TIMEOUT_MS;

	// b-AC-6: bound by the timeout AND swallow every error. The returned promise always
	// RESOLVES — it never throws — so session start is never blocked.
	try {
		return await withTimeout(pull(deps), timeoutMs);
	} catch {
		return null;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// decideAction — the 018b conflict policy (FR-3 / b-AC-1 / b-AC-3).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve what a pull should DO with one remote skill (FR-3). The 4 branches:
 *
 *   - local ABSENT          → `write`        (nothing to back up).
 *   - remote > local        → `backup-write` (preserve the prior, then write the newer).
 *   - `--force`             → `backup-write` (re-write regardless; back up first).
 *   - remote <= local && !force → `skip`     (the idempotent no-op — local already current).
 *
 * `localVersion === null` with `localExists` true means an unreadable/garbled local file:
 * treated as "no usable local version" so a newer remote still wins (write proceeds).
 */
export function decideAction(input: DecideActionInput): PullAction {
	if (!input.localExists) return "write";
	if (input.force) return "backup-write";
	const local = input.localVersion;
	// A newer remote (or an unreadable local version) → back up + write. local>=remote → skip.
	if (local === null || input.remoteVersion > local) return "backup-write";
	return "skip";
}

// ─────────────────────────────────────────────────────────────────────────────
// backfillSymlinks — re-fan every globally-installed manifest entry (018c).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure every globally-installed manifest entry has a symlink in every currently-detected
 * agent root (c-AC-2 / FR-6 / FR-7). Runs at the end of every non-dry-run GLOBAL pull. This
 * closes the gap where an up-to-date skill takes the `skipped` path (which never triggers
 * per-row fan-out), so a newly-installed agent still inherits prior pulls.
 *
 * Only `install === "global"` entries are backfilled (D-4). Each link is created/healed
 * through the SAME `linkInto` helper the per-row fan-out uses (self-healing stale links,
 * win32 swallow). Returns how many links were created or healed. Cost is ~1 lstat per
 * (entry, root) pair (FR-8).
 */
export function backfillSymlinks(manifest: PullManifestStore, roots: AgentRootDetector): number {
	const otherRoots = roots.otherRoots();
	let created = 0;
	for (const entry of manifest.read()) {
		if (entry.install !== "global") continue;
		// SECURITY (PRD-018 audit): the manifest is an on-disk file that may have been
		// corrupted or rewritten by another local process. Re-validate `dirName`/`installRoot`
		// at USE time — a sanitized-on-write value cannot be trusted on read-back. A manifest
		// `dirName` of `../../../etc` would otherwise plant a symlink outside the detected roots.
		const canonicalDir = resolveContainedCanonicalDir(entry.installRoot, entry.dirName);
		if (canonicalDir === null) continue;
		// Only backfill an entry whose canonical dir still exists (a pruned skill is skipped).
		if (!existsSync(canonicalDir)) continue;
		created += fanOutSymlinks(otherRoots, entry.dirName, canonicalDir, []);
	}
	return created;
}

// ─────────────────────────────────────────────────────────────────────────────
// recordPull — manifest write with surfaced (never thrown) failure (FR-8).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record one globally-installed pull in the manifest (FR-8). A write failure is RETURNED
 * as a message (surfaced on the outcome's `manifestError`) rather than thrown — a manifest
 * hiccup must never abort a pull that already wrote the skill to disk.
 */
export function recordPull(manifest: PullManifestStore, entry: PullManifestEntry): string | null {
	try {
		manifest.record(entry);
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// unpull — reverse a pull-managed manifest entry (018b).
// ─────────────────────────────────────────────────────────────────────────────

/** The outcome of an {@link unpullSkill} call. */
export interface UnpullOutcome {
	/** True when a manifest entry was found + reversed. False when `dirName` was unmanaged. */
	readonly removed: boolean;
	/** The canonical SKILL.md dir removed, or null when nothing was reversed. */
	readonly canonicalDir: string | null;
	/** How many fanned-out symlinks were unlinked. */
	readonly symlinksRemoved: number;
}

/**
 * Reverse a pull-managed entry (018b). Removes the recorded symlinks (ONLY those that are
 * links resolving to OUR canonical dir — never a followed-out delete), removes the canonical
 * dir, and deletes the manifest record. An entry NOT in the manifest is left untouched —
 * `unpull` reverses pull-managed entries ONLY, never a user's locally-mined skill.
 */
export function unpullSkill(manifest: PullManifestStore, dirName: string): UnpullOutcome {
	const entry = manifest.read().find((e) => e.dirName === dirName) ?? null;
	if (entry === null) return { removed: false, canonicalDir: null, symlinksRemoved: 0 };

	// SECURITY (PRD-018 audit): the manifest is an on-disk file that another local process
	// (or a path-confused prior pull) could have rewritten. `rmSync(..., {recursive,force})`
	// on a path derived VERBATIM from `installRoot`+`dirName` is an arbitrary-directory-delete
	// primitive (e.g. `installRoot:"/"`, `dirName:"Users/me/Documents"`). Re-validate at USE
	// time that `dirName` is a single safe segment AND that the resolved path is a direct child
	// of `installRoot` — a value sanitized on write CANNOT be trusted after a round-trip to disk.
	const canonicalDir = resolveContainedCanonicalDir(entry.installRoot, entry.dirName);
	if (canonicalDir === null) {
		// Refuse to delete anything for an unsafe record, but still drop the poisoned entry so
		// it can never be acted on again.
		manifest.remove(dirName);
		return { removed: false, canonicalDir: null, symlinksRemoved: 0 };
	}
	let symlinksRemoved = 0;

	// Remove each recorded symlink — but ONLY if it is a link resolving to OUR canonical dir.
	for (const linkPath of entry.symlinks) {
		if (unlinkIfOurs(linkPath, canonicalDir)) symlinksRemoved++;
	}

	// Remove the canonical dir (the real SKILL.md). Guarded best-effort.
	try {
		rmSync(canonicalDir, { recursive: true, force: true });
	} catch {
		// Swallow — the manifest record is still removed so the entry is no longer managed.
	}

	manifest.remove(dirName);
	return { removed: true, canonicalDir, symlinksRemoved };
}

// ─────────────────────────────────────────────────────────────────────────────
// trusted-table early-exit (b-AC-2).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True when the trusted-table probe reports a table set that does NOT include `skills`
 * (b-AC-2). A `null`/absent probe is fail-OPEN (proceed) so a transient list failure never
 * silently disables pulls forever.
 */
async function skillsTableAbsent(trustedTables: TrustedTableList | undefined): Promise<boolean> {
	if (trustedTables === undefined) return false;
	const tables = await trustedTables.tables();
	if (tables === null) return false; // could not determine → proceed (fail-open).
	return !tables.includes(SKILLS_TABLE);
}

// ─────────────────────────────────────────────────────────────────────────────
// withTimeout — bound a promise (b-AC-6).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Race a promise against a timeout (b-AC-6). Resolves to `null` when the timeout wins, so a
 * slow store never blocks startup. The timer is `unref`'d so a pending auto-pull never keeps
 * the process alive past its work. Rejections from the raced promise propagate (the caller's
 * catch swallows them).
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	return new Promise<T | null>((resolve, reject) => {
		const timer = setTimeout(() => resolve(null), ms);
		if (typeof timer.unref === "function") timer.unref();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err instanceof Error ? err : new Error(String(err)));
			},
		);
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem helpers — canonical write, backup, version read, symlink fan-out.
// ─────────────────────────────────────────────────────────────────────────────

/** Build the all-skipped/empty outcome (trusted-table absent or no skills). */
function emptyOutcome(over: Partial<PullOutcome>): PullOutcome {
	return {
		skillsWritten: 0,
		symlinksCreated: 0,
		skillsSkipped: 0,
		skillsBackedUp: 0,
		tableAbsent: false,
		dryRun: false,
		manifestError: null,
		...over,
	};
}

/** The `<name>--<author>` dir name, each half sanitized to a safe segment (path safety). */
export function canonicalDirName(name: string, author: string): string {
	return `${sanitizeSegment(name)}--${sanitizeSegment(author)}`;
}

/** Write the canonical `<canonicalDir>/SKILL.md` verbatim (the body is already rendered). */
function writeCanonicalSkill(canonicalDir: string, body: string): void {
	mkdirSync(canonicalDir, { recursive: true });
	writeFileSync(join(canonicalDir, SKILL_FILE), body, "utf-8");
}

/**
 * Back up an existing `SKILL.md` to `SKILL.md.bak` before a newer write (D-2 / b-AC-3).
 * Returns true when a backup was made. A missing source (nothing to back up) returns false;
 * a rename failure is swallowed so the newer write still proceeds.
 */
function backupExisting(file: string): boolean {
	try {
		if (!existsSync(file)) return false;
		renameSync(file, join(dirname(file), SKILL_BACKUP_FILE));
		return true;
	} catch {
		return false;
	}
}

/** Read the `version:` from a local SKILL.md frontmatter, or `null` when absent/unreadable. */
function readLocalVersion(canonicalDir: string): number | null {
	try {
		const md = readFileSync(join(canonicalDir, SKILL_FILE), "utf-8");
		const match = md.match(/^version:\s*(\d+)\s*$/m);
		if (match === null) return null;
		const v = Number.parseInt(match[1] as string, 10);
		return Number.isFinite(v) ? v : null;
	} catch {
		return null;
	}
}

/**
 * Create/heal a symlink named `<dirName>` in each OTHER root, pointing at the canonical dir
 * (c-AC-1 / c-AC-4 / c-AC-6). Appends each PRESENT link path (created, healed, or already
 * correct) to `out` (for the manifest). Returns how many links were newly CREATED or HEALED
 * — an already-correct link is NOT counted (so a re-run / backfill over correct links reports
 * zero changes, never an inflated total). Each link is best-effort + self-healing via
 * {@link linkInto}; a win32 symlink the OS refuses is swallowed per-link.
 */
function fanOutSymlinks(otherRoots: readonly string[], dirName: string, canonicalDir: string, out: string[]): number {
	let changed = 0;
	for (const root of otherRoots) {
		const linkPath = join(root, dirName);
		const result = linkInto(root, linkPath, canonicalDir);
		if (result === "created" || result === "healed") changed++;
		if (result !== "failed" && result !== "non-link") out.push(linkPath);
	}
	return changed;
}

/** The result of a single {@link linkInto} call (drives the changed-count + manifest record). */
type LinkResult = "created" | "healed" | "already" | "non-link" | "failed";

/**
 * Create (or self-heal) ONE symlink at `linkPath` → `canonicalDir` under `root`
 * (c-AC-1 / c-AC-4 / c-AC-6). The single shared link primitive both the per-row fan-out and
 * the backfill use (one source for the safety + win32 swallow).
 *
 *   - already a CORRECT link (resolves to `canonicalDir`)   → `already` (leave it, c-AC-6).
 *   - a STALE link (resolves to a DIFFERENT canonical path) → `healed` (unlink + recreate, c-AC-4).
 *   - absent                                                → `created`.
 *   - a non-link path already there (a real dir/file)       → `non-link` (do not clobber).
 *   - a win32 no-privilege symlink error                    → `failed` (swallowed).
 */
function linkInto(root: string, linkPath: string, canonicalDir: string): LinkResult {
	try {
		mkdirSync(root, { recursive: true });
		const state = linkState(linkPath, canonicalDir);
		if (state === "correct") return "already";
		if (state === "non-link") return "non-link"; // a real dir/file — never clobber.
		if (state === "stale") {
			// c-AC-4: a link pointing at a DIFFERENT canonical path → unlink + recreate.
			unlinkSync(linkPath);
			symlinkSync(canonicalDir, linkPath, "dir");
			return "healed";
		}
		// "absent" → create the link to OUR canonical dir.
		symlinkSync(canonicalDir, linkPath, "dir");
		return "created";
	} catch {
		// Swallow per-link (e.g. win32 without SeCreateSymbolicLink privilege).
		return "failed";
	}
}

/** The four states a fan-out link path can be in (drives create / heal / leave). */
type LinkState = "absent" | "correct" | "stale" | "non-link";

/**
 * Classify a link path against the canonical dir it SHOULD point at (c-AC-4 / c-AC-6). A
 * symlink whose resolved target equals `canonicalDir` is `correct`; one that resolves
 * elsewhere is `stale`; a non-symlink path is `non-link`; a missing path is `absent`. Path
 * equality is by `resolve()` so a relative/absolute mix compares correctly.
 */
function linkState(linkPath: string, canonicalDir: string): LinkState {
	let st;
	try {
		st = lstatSync(linkPath);
	} catch {
		return "absent";
	}
	if (!st.isSymbolicLink()) return "non-link";
	try {
		const target = readlinkSync(linkPath);
		return resolve(target) === resolve(canonicalDir) ? "correct" : "stale";
	} catch {
		// Unreadable link target → treat as stale so it is healed to the correct target.
		return "stale";
	}
}

/**
 * Unlink a recorded symlink ONLY when it is a link that resolves to OUR canonical dir
 * (the `unpull` safety floor). Never follows a link out and deletes a real directory: a
 * non-symlink path, or a link pointing ELSEWHERE, is left untouched. Returns true when the
 * link was ours and was removed.
 */
function unlinkIfOurs(linkPath: string, canonicalDir: string): boolean {
	if (linkState(linkPath, canonicalDir) !== "correct") return false;
	try {
		unlinkSync(linkPath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Reduce a name/author half to a SINGLE safe path segment — only `[A-Za-z0-9._-]`, every
 * other char (including `/`, `\`, `..` separators) becomes `_`. So a crafted name/author can
 * never traverse out of the skills root. Leading dots are collapsed so a `..` cannot survive.
 */
function sanitizeSegment(value: string): string {
	const cleaned = value
		.replace(/[^A-Za-z0-9._-]/g, "_") // drop separators + any non-safe char
		.replace(/\.\.+/g, "_"); // collapse any `..` run so no parent-traversal token survives
	// A segment that is purely dots resolves to the dir itself under `join` — neutralize.
	if (cleaned === "" || /^\.+$/.test(cleaned)) return "untitled";
	return cleaned;
}

/**
 * True when `dirName` is a SINGLE filesystem segment safe to use as a `<name>--<author>` dir
 * (PRD-018 security audit). A `dirName` read back from the on-disk manifest is UNTRUSTED — it
 * may have been corrupted or rewritten by another local process — so it must be re-validated
 * before it drives a destructive `rmSync` or a `symlinkSync` link path.
 *
 * A name is safe iff it contains no path separator (`/`, `\`), no NUL, is not a `.`/`..`
 * traversal token, and is byte-for-byte identical to what `canonicalDirName`'s per-segment
 * sanitizer would have produced for it (so only a value the WRITE path could legitimately have
 * emitted is ever accepted). Anything else is rejected — never sanitized-in-place — because a
 * silently rewritten destructive path is worse than a refused one.
 */
function isSafeDirSegment(dirName: string): boolean {
	if (dirName === "" || dirName === "." || dirName === "..") return false;
	if (/[/\\\0]/.test(dirName)) return false;
	// The canonical dir name is `<seg>--<seg>` with each half through `sanitizeSegment`. Require
	// the value to round-trip unchanged under that same reduction so no traversal/escape token
	// (`..`, separators, control chars) can survive read-back.
	const halves = dirName.split("--");
	return halves.every((half) => half !== "" && sanitizeSegment(half) === half);
}

/**
 * Resolve `<installRoot>/<dirName>` to an absolute path ONLY when it is safe (PRD-018 security
 * audit): `dirName` must be a single safe segment ({@link isSafeDirSegment}) AND the resolved
 * path must be a DIRECT child of the resolved `installRoot`. Returns the contained absolute path,
 * or `null` when the manifest record is unsafe. This is the containment floor every destructive
 * manifest-driven filesystem op (`unpull`'s `rmSync`, `backfill`'s symlink fan-out) passes through.
 */
function resolveContainedCanonicalDir(installRoot: string, dirName: string): string | null {
	if (typeof installRoot !== "string" || installRoot === "") return null;
	if (!isSafeDirSegment(dirName)) return null;
	const rootResolved = resolve(installRoot);
	const candidate = resolve(join(rootResolved, dirName));
	// Must be a direct child of installRoot — never the root itself, never an ancestor.
	if (candidate === rootResolved) return null;
	if (resolve(dirname(candidate)) !== rootResolved) return null;
	return candidate;
}

// ─────────────────────────────────────────────────────────────────────────────
// Production seam builders — the default agent roots + the auth check.
// ─────────────────────────────────────────────────────────────────────────────

/** The skills subdir under `~/.claude` (the canonical host-agent convention). */
const CLAUDE_SKILLS = join(".claude", "skills");

/**
 * The default detected agent roots under the user's home (c-AC-5 / FR-2). `~/.claude/skills`
 * is canonical; the others are the non-Claude agents a global-install pull fans symlinks into.
 * `home` is injectable so a test points the whole set at a temp dir.
 */
export function createDefaultAgentRoots(home: string = homedir()): AgentRootDetector {
	const canonical = join(home, CLAUDE_SKILLS);
	const others = [
		join(home, ".codex", "skills"),
		join(home, ".agents", "skills"),
		join(home, ".hermes", "skills"),
		join(home, ".pi", "agent", "skills"),
	];
	return {
		canonicalRoot: () => canonical,
		// Only fan out into a root that looks installed — the `skills/` dir itself OR its parent
		// agent dir exists — so the fan-out never invents agent directories the user never
		// installed, while still creating the leaf `skills/` for a detected agent on first pull.
		otherRoots: () => others.filter((root) => existsSync(root) || existsSync(dirname(root))),
	};
}

/**
 * The production {@link AuthCheck} (b-AC-4). Authenticated when a `HONEYCOMB_TOKEN` is set OR
 * a credentials file is present for the active scope. This reads only the PRESENCE — it never
 * echoes the token. `loadCreds` is injected as a presence-probe so this module imports no
 * auth/storage path (the daemon-assembly wiring supplies the real `loadCredentials`).
 */
export function createAuthCheck(probe: () => boolean, env: NodeJS.ProcessEnv = process.env): AuthCheck {
	return {
		isAuthenticated(): boolean {
			const token = env.HONEYCOMB_TOKEN;
			if (typeof token === "string" && token.length > 0) return true;
			return probe();
		},
	};
}

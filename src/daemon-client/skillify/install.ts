/**
 * Skill install + propagation — PRD-016c (Wave 2, the COLLAB half of skillify).
 *
 * 016c owns session-start propagation:
 *   - `pull` (c-AC-1 / c-AC-5 / c-AC-6) — read the latest skills THROUGH THE DAEMON,
 *     write each `~/.claude/skills/<name>--<author>/SKILL.md`, and SYMLINK that
 *     canonical dir into every OTHER detected agent root (fan-out, no per-harness install).
 *   - `autoPull` (c-AC-2 / c-AC-3 / c-AC-4) — the idempotent session-start pull: skip a
 *     skill whose LOCAL version is at or newer than remote; bound the whole call by a 5s
 *     timeout that SWALLOWS errors so a slow store never blocks startup; skip entirely on
 *     `HONEYCOMB_AUTOPULL_DISABLED=1`; skip SILENTLY when unauthenticated.
 *
 * ── Daemon-only (c-AC-6 / D-10) ─────────────────────────────────────────────
 * The ONLY path out to the `skills` table is the injected {@link SkillPullClient}. This
 * module lives under `src/daemon-client/` — a NON-daemon root the invariant test
 * (`tests/daemon/storage/invariant.test.ts`) scans — so a direct DeepLake import would
 * fail the build. The pull is structurally a thin client (CONVENTIONS §4).
 *
 * ── Path / symlink safety ───────────────────────────────────────────────────
 * `<name>--<author>` is reduced to a SINGLE safe path segment (`sanitizeSegment`), so a
 * hostile name/author (`../`, `/etc/...`) can never traverse out of the skills root. The
 * symlink TARGET is always the just-written canonical dir under the canonical root — never
 * an attacker-controlled path — and the link is only created when its parent root is a
 * real directory. A win32 symlink that the OS refuses (no privilege) is swallowed per-link
 * so it never aborts the pull.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
	type AgentRootDetector,
	type AuthCheck,
	type PulledSkill,
	type SkillPullClient,
} from "./contracts.js";

/** The env var that disables session-start auto-pull entirely (c-AC-3 / FR-7). */
export const AUTOPULL_DISABLED_ENV = "HONEYCOMB_AUTOPULL_DISABLED";

/** The auto-pull timeout budget — a slow store never blocks startup past this (c-AC-2 / FR-6). */
export const AUTOPULL_TIMEOUT_MS = 5_000;

/** The canonical file name written inside each `<name>--<author>/` dir. */
const SKILL_FILE = "SKILL.md";

/** The outcome of a pull: how many skills + symlinks landed. */
export interface PullOutcome {
	/** Canonical `<name>--<author>/SKILL.md` files written (a skip does NOT count). */
	readonly skillsWritten: number;
	/** Symlinks fanned out into detected agent roots (c-AC-1 / c-AC-5). */
	readonly symlinksCreated: number;
	/** Skills skipped because the local version was at or newer than remote (c-AC-2). */
	readonly skillsSkipped: number;
}

/** The injectable seams a {@link pull} runs against (all default to the real impls). */
export interface PullDeps {
	/** The ONLY path out to the `skills` store (c-AC-6) — in prod a daemon dispatch, in tests a fake. */
	readonly client: SkillPullClient;
	/** The detected agent skill roots (c-AC-5) — injectable so tests use temp dirs. */
	readonly roots: AgentRootDetector;
}

/**
 * `honeycomb skillify pull` (c-AC-1 / c-AC-5 / c-AC-6). Reads the latest skills THROUGH
 * THE DAEMON, writes each canonical `<canonicalRoot>/<name>--<author>/SKILL.md`, and
 * symlinks that dir into every OTHER detected agent root. A skill whose LOCAL version is
 * at or newer than the remote is SKIPPED so a re-run with no changes touches no files
 * (FR-3) — the idempotent compare auto-pull relies on too.
 *
 * The read goes through the {@link SkillPullClient} seam ONLY; this module never opens
 * DeepLake (c-AC-6). Errors propagate to the caller — the manual `pull` surfaces them;
 * {@link autoPull} wraps this in the swallow.
 */
export async function pull(deps: PullDeps): Promise<PullOutcome> {
	const skills = await deps.client.readLatestSkills();
	const canonicalRoot = deps.roots.canonicalRoot();
	const otherRoots = deps.roots.otherRoots();

	let skillsWritten = 0;
	let symlinksCreated = 0;
	let skillsSkipped = 0;

	for (const skill of skills) {
		const dirName = canonicalDirName(skill.name, skill.author);
		const canonicalDir = join(canonicalRoot, dirName);

		// FR-3 idempotent: skip when the local version is at or newer than remote (c-AC-2).
		if (localVersionAtLeast(canonicalDir, skill.version)) {
			skillsSkipped++;
			continue;
		}

		writeCanonicalSkill(canonicalDir, skill.body);
		skillsWritten++;

		// Fan-out: a symlink in every OTHER detected root → the canonical dir (c-AC-1 / c-AC-5).
		symlinksCreated += fanOutSymlinks(otherRoots, dirName, canonicalDir);
	}

	return { skillsWritten, symlinksCreated, skillsSkipped };
}

/** The injectable seams an {@link autoPull} runs against. */
export interface AutoPullDeps extends PullDeps {
	/** The unauthenticated-skip gate (c-AC-4). */
	readonly auth: AuthCheck;
	/** The env (defaults to `process.env`) — the disabled-flag rule applies here (c-AC-3). */
	readonly env?: NodeJS.ProcessEnv;
	/** The timeout budget in ms (default {@link AUTOPULL_TIMEOUT_MS}). */
	readonly timeoutMs?: number;
}

/**
 * Auto-pull at session start (c-AC-2 / c-AC-3 / c-AC-4). Idempotent + fail-soft:
 *
 *   - `HONEYCOMB_AUTOPULL_DISABLED=1` → return `null`, run NOTHING (c-AC-3).
 *   - unauthenticated → return `null` SILENTLY, no warning, no token touched (c-AC-4).
 *   - otherwise → run {@link pull}, but bounded by a 5s timeout; ANY error (a slow or
 *     unavailable store, a rejecting dispatch) is SWALLOWED so startup is never blocked
 *     (c-AC-2 / FR-6). A swallowed/timed-out run returns `null`; a clean run returns the
 *     {@link PullOutcome}.
 *
 * The skip-if-local-newer idempotency is inherited from {@link pull} (FR-3) — auto-pull
 * adds the gating + the bound, not a second compare.
 */
export async function autoPull(deps: AutoPullDeps): Promise<PullOutcome | null> {
	const env = deps.env ?? process.env;

	// c-AC-3: the kill switch. Run nothing.
	if (env[AUTOPULL_DISABLED_ENV] === "1") return null;

	// c-AC-4: unauthenticated → skip SILENTLY (no warning, no token leak).
	if (!deps.auth.isAuthenticated()) return null;

	const timeoutMs = deps.timeoutMs ?? AUTOPULL_TIMEOUT_MS;

	// c-AC-2: bound by the timeout AND swallow every error. A slow store loses the race to
	// the timeout (→ null); a rejecting store loses to the catch (→ null). Either way the
	// promise this returns RESOLVES — it never throws — so session start is never blocked.
	try {
		return await withTimeout(pull(deps), timeoutMs);
	} catch {
		return null;
	}
}

/**
 * Race a promise against a timeout (c-AC-2). Resolves to `null` when the timeout wins, so
 * a slow store never blocks startup. The timer is `unref`'d so a pending auto-pull never
 * keeps the process alive past its work. Rejections from the raced promise propagate (the
 * caller's catch swallows them).
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
// Filesystem helpers — canonical write, idempotent compare, symlink fan-out.
// ─────────────────────────────────────────────────────────────────────────────

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
 * True when a local `<canonicalDir>/SKILL.md` already exists at a version >= `remote`
 * (c-AC-2 / FR-3). The local version is read from the SKILL.md frontmatter's `version:`
 * line — a tolerant scan that never throws (a missing/garbled file reads as "no local
 * version" → not at-least, so a write proceeds). This is the idempotent skip: a re-run
 * with no remote change finds local >= remote and touches no file.
 */
function localVersionAtLeast(canonicalDir: string, remoteVersion: number): boolean {
	const local = readLocalVersion(canonicalDir);
	return local !== null && local >= remoteVersion;
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
 * Create a symlink named `<dirName>` in each OTHER root, pointing at the canonical dir
 * (c-AC-1 / c-AC-5). Returns how many links were created. Each link is best-effort:
 *   - the root dir is created if absent (so a freshly-detected agent root works);
 *   - an EXISTING correct symlink is left in place (idempotent — counted as present);
 *   - a win32 symlink the OS refuses (no privilege) is swallowed per-link so it never
 *     aborts the whole pull.
 * The target is ALWAYS the just-written canonical dir — never an attacker-controlled path.
 */
function fanOutSymlinks(otherRoots: readonly string[], dirName: string, canonicalDir: string): number {
	let created = 0;
	for (const root of otherRoots) {
		const linkPath = join(root, dirName);
		try {
			// An existing link/dir at the path is left as-is (idempotent re-pull). lstat does
			// NOT follow the link, so a dangling-but-present link still short-circuits.
			if (pathExists(linkPath)) {
				created++;
				continue;
			}
			mkdirSync(root, { recursive: true });
			// "dir" junction-type on win32; ignored on POSIX. The target is the canonical dir.
			symlinkSync(canonicalDir, linkPath, "dir");
			created++;
		} catch {
			// Swallow per-link (e.g. win32 without SeCreateSymbolicLink privilege) so the fan-out
			// degrades gracefully instead of aborting the pull.
		}
	}
	return created;
}

/** True when a path exists (a symlink counts even if dangling — lstat, not stat). */
function pathExists(p: string): boolean {
	try {
		lstatSync(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Reduce a name/author half to a SINGLE safe path segment — only `[A-Za-z0-9._-]`, every
 * other char (including `/`, `\`, `..` separators) becomes `_`. So a crafted name/author
 * can never traverse out of the skills root (mirrors `install-target.ts` /
 * `watermark.ts`). Leading dots are also collapsed so a `..` segment cannot survive.
 */
function sanitizeSegment(value: string): string {
	const cleaned = value
		.replace(/[^A-Za-z0-9._-]/g, "_") // drop separators + any non-safe char
		.replace(/\.\.+/g, "_"); // collapse any `..` run so no parent-traversal token survives
	// A segment that is purely dots (`.`) resolves to the dir itself under `join` — neutralize.
	if (cleaned === "" || /^\.+$/.test(cleaned)) return "untitled";
	return cleaned;
}

// ─────────────────────────────────────────────────────────────────────────────
// Production seam builders — the default agent roots + the auth check.
// ─────────────────────────────────────────────────────────────────────────────

/** The skills subdir under `~/.claude` (the canonical host-agent convention). */
const CLAUDE_SKILLS = join(".claude", "skills");

/**
 * The default detected agent roots under the user's home (c-AC-5 / FR-4). `~/.claude/skills`
 * is canonical; the others are the non-Claude agents a global-install pull fans symlinks
 * into. `home` is injectable so a test points the whole set at a temp dir.
 */
export function createDefaultAgentRoots(home: string = homedir()): AgentRootDetector {
	const canonical = join(home, CLAUDE_SKILLS);
	const others = [
		join(home, ".agents", "skills"),
		join(home, ".hermes", "skills"),
		join(home, ".pi", "agent", "skills"),
	];
	return {
		canonicalRoot: () => canonical,
		// Only fan out into a root that looks installed — the `skills/` dir itself OR its
		// parent agent dir (e.g. `~/.hermes`) exists. This keeps the fan-out from inventing
		// agent directories the user never installed, while still creating the leaf `skills/`
		// for a detected agent on the first pull.
		otherRoots: () => others.filter((root) => existsSync(root) || existsSync(dirname(root))),
	};
}

/**
 * The production {@link AuthCheck} (c-AC-4). Authenticated when a `HONEYCOMB_TOKEN` is set
 * OR a credentials file is present for the active scope. This reads only the PRESENCE — it
 * never echoes the token. `loadCreds` is injected as a presence-probe so this module imports
 * no auth/storage path (the daemon-assembly wiring supplies the real `loadCredentials`).
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

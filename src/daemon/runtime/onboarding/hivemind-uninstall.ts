/**
 * The idempotent, reversible-via-backup Hivemind uninstaller — PRD-050d (d-AC-3 / d-AC-5 / d-AC-7).
 *
 * ── What "uninstall Hivemind" means on a real machine (the d-OQ-1 investigation) ─────────────
 * Hivemind ships TWO things on a typical box, mirroring Honeycomb's own install surface
 * (`src/connectors/`): (1) a GLOBAL npm package (`@deeplake/hivemind`, the `hivemind` bin), and
 * (2) per-harness HOOK WIRING + a `~/.hivemind` state/config dir. The two tools deliberately SHARE
 * the credential file (`~/.deeplake/credentials.json`), so uninstalling Hivemind must NEVER touch
 * that shared file — only Hivemind's OWN footprint (its npm package + its `~/.hivemind` dir).
 *
 * This module owns ONLY the destructive half (back up → remove); the harness HOOK unwire is left to
 * `honeycomb setup` (the existing 019a connector engine re-points the shared harnesses to Honeycomb
 * the next time the user runs setup — d-OQ-4 lean). Doing the npm-remove + dir-backup here keeps the
 * migration transaction small and the rollback exact (restore one backed-up dir).
 *
 * ── Idempotent + reversible by design (parent AC-7 / d-AC-3) ─────────────────────────────────
 *   - BACKUP is INSURANCE: `~/.hivemind` is copied (recursively) to a timestamped
 *     `~/.hivemind-backup-<ISO>` BEFORE any removal. The backup path is returned + recorded in the
 *     onboarding `migration.backupPath` marker so a crash-recovery rollback (d-AC-7) can restore it.
 *   - UNINSTALL is idempotent: removing an ALREADY-absent `~/.hivemind` (or an already-uninstalled
 *     npm package) is a clean no-op, never a throw — safe to re-run after a partial failure (d-AC-5).
 *   - The shared `~/.deeplake/credentials.json` is NEVER read, moved, or removed here (d-AC-5): the
 *     uninstall footprint is exactly `~/.hivemind` + the global npm package, nothing else.
 *
 * ── The subprocess seam is injectable (no real `npm` in tests; ClawHub-style indirection) ─────
 * The npm-global-remove runs through an injectable {@link HivemindUninstallDeps.npmRemove} seam, so a
 * unit test asserts the call WITHOUT spawning `npm`, and a partial-failure test injects a throwing
 * remover to exercise d-AC-5. The production default routes through a fixed-argv `execFileSync` (never
 * a shell) — the SAME safe-exec discipline `deeplake-issuer.ts`/`install.ts` use.
 *
 * Module home: `src/daemon/runtime/onboarding/` — it touches `node:fs` + an optional `npm` subprocess
 * only; it opens NO DeepLake connection and holds no daemon handle (the onboarding root is non-daemon).
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CREDENTIALS_DIR_NAME } from "../auth/credentials-store.js";

/** The Hivemind state/config directory name under the user's home (the prior-tool footprint). */
export const HIVEMIND_DIR_NAME = ".hivemind" as const;

/** The global npm package name the uninstall removes when present (`@deeplake/hivemind`). */
export const HIVEMIND_NPM_PACKAGE = "@deeplake/hivemind" as const;

/** The timestamped backup directory prefix: `~/.hivemind-backup-<ISO>` (parent AC-7). */
export const HIVEMIND_BACKUP_PREFIX = ".hivemind-backup-" as const;

/**
 * A best-effort `npm uninstall -g @deeplake/hivemind` runner (the subprocess seam). Returns `true` iff
 * the global package was present AND removed; `false` (NEVER a throw) when npm is unavailable, the
 * package was already absent, or the remove failed — the dir backup is the real reversibility guarantee,
 * so an npm hiccup must not abort the migration (d-AC-5).
 */
export type NpmGlobalRemover = (pkg: string) => boolean;

/**
 * The production {@link NpmGlobalRemover}: a fixed-argv `execFileSync` (never a shell — no metacharacter
 * re-parse), `npm-shrinkwrap`-style. A non-zero exit / missing npm / already-absent package all resolve
 * to `false` rather than throwing, so the caller treats a failed remove as "nothing to remove" and keeps
 * going (the `~/.hivemind` backup+remove is the load-bearing step). `windowsHide` suppresses the console
 * flash on win32.
 */
export function defaultNpmGlobalRemover(pkg: string): boolean {
	try {
		// On win32 the npm launcher is `npm.cmd`; `execFileSync` does NOT resolve the bare `npm` shim
		// (it is not a real `.exe`), so the global remove would silently fail there. The fixed argv still
		// never reaches a shell — we only switch the binary name, not the exec discipline.
		const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
		// `--silent` keeps npm's own output off our sinks; the fixed argv never reaches a shell.
		execFileSync(npmBin, ["uninstall", "-g", "--silent", pkg], { stdio: "ignore", timeout: 60_000, windowsHide: true });
		return true;
	} catch {
		// npm absent / package not installed / non-zero exit → not removed, never a throw.
		return false;
	}
}

/** Injectable deps for {@link backupAndUninstallHivemind} — every IO seam overridable for tests. */
export interface HivemindUninstallDeps {
	/**
	 * The home directory override (tests point this at a temp HOME so the real `~/.hivemind` is never
	 * touched). Absent → the real {@link homedir}.
	 */
	readonly homeDir?: string;
	/** A deterministic ISO timestamp for the backup dir name (tests). Absent → `new Date().toISOString()`. */
	readonly now?: () => string;
	/** The npm-global-remove seam (tests inject a recorder / a thrower). Absent → {@link defaultNpmGlobalRemover}. */
	readonly npmRemove?: NpmGlobalRemover;
}

/** The outcome of a backup+uninstall run — what moved + whether the npm package was removed. */
export interface HivemindUninstallResult {
	/** True when a `~/.hivemind` dir was present and got backed up + removed. */
	readonly removed: boolean;
	/** The timestamped backup path (`~/.hivemind-backup-<ISO>`), or `undefined` when there was nothing to back up. */
	readonly backupPath?: string;
	/** True iff the global npm package was present AND removed (best-effort; false is non-fatal). */
	readonly npmRemoved: boolean;
}

/** Resolve the `~/.hivemind` path under the (possibly overridden) home. */
export function hivemindDirPath(home: string): string {
	return join(home, HIVEMIND_DIR_NAME);
}

/** Build the timestamped backup path (`~/.hivemind-backup-<ISO-with-colons-sanitized>`). */
export function hivemindBackupPath(home: string, iso: string): string {
	// Colons are illegal in Windows path segments; sanitize the ISO timestamp to a portable token.
	const safe = iso.replace(/[:.]/g, "-");
	return join(home, `${HIVEMIND_BACKUP_PREFIX}${safe}`);
}

/**
 * Back up `~/.hivemind` to a timestamped path, then remove the original AND best-effort `npm uninstall -g`
 * the global package (d-AC-3). IDEMPOTENT: an already-absent `~/.hivemind` returns `{ removed:false }`
 * with no backup and no throw, so a re-run after a partial failure is safe (d-AC-5). The shared
 * `~/.deeplake/credentials.json` is NEVER touched — only the Hivemind footprint moves.
 *
 * Ordering matters for reversibility: the COPY lands first (the insurance), and only then is the
 * original removed — so a crash between copy and remove leaves BOTH the backup and the original
 * (the rollback restore is still exact, and a re-run cleanly re-removes).
 */
export function backupAndUninstallHivemind(deps: HivemindUninstallDeps = {}): HivemindUninstallResult {
	const home = deps.homeDir ?? homedir();
	const npmRemove = deps.npmRemove ?? defaultNpmGlobalRemover;
	const dir = hivemindDirPath(home);

	// The global npm remove is best-effort + independent of the dir presence (the package can linger
	// even if a user deleted `~/.hivemind` by hand). A `false` here is non-fatal (d-AC-5). The default
	// remover already swallows its own errors, but an INJECTED seam (or a future remover) might throw —
	// guard it here so a throwing remove can never abort the load-bearing backup+remove step.
	let npmRemoved = false;
	try {
		npmRemoved = npmRemove(HIVEMIND_NPM_PACKAGE);
	} catch {
		npmRemoved = false;
	}

	if (!existsSync(dir)) {
		// Nothing to back up / remove — idempotent no-op (safe to re-run, d-AC-5).
		return { removed: false, npmRemoved };
	}

	const iso = (deps.now ?? (() => new Date().toISOString()))();
	const backupPath = hivemindBackupPath(home, iso);

	// 1) COPY first (the insurance). `recursive` clones the whole dir; an existing backup path is
	//    left as-is by re-running (the timestamp makes collisions astronomically unlikely).
	cpSync(dir, backupPath, { recursive: true });

	// 2) Only AFTER the backup lands, remove the original. `force` makes a re-run idempotent. If the
	//    removal fails (e.g. a Windows file lock), the backup STILL exists — so we surface the
	//    `backupPath` regardless (`removed:false`) rather than throwing, which would strand the
	//    already-created backup the rollback marker needs to find (d-AC-5 / d-AC-7).
	try {
		rmSync(dir, { recursive: true, force: true });
		return { removed: true, backupPath, npmRemoved };
	} catch {
		return { removed: false, backupPath, npmRemoved };
	}
}

/**
 * Restore a `~/.hivemind` backup taken by {@link backupAndUninstallHivemind} (the d-AC-7 rollback).
 * Copies the backup dir back to `~/.hivemind`. IDEMPOTENT + fail-soft: a missing backup path returns
 * `false` (nothing to restore) rather than throwing, and an existing `~/.hivemind` is overwritten by the
 * recursive copy so a half-rolled-back machine converges. The shared credential is never touched here.
 *
 * Returns `true` iff a backup was found and restored.
 */
export function restoreHivemindBackup(backupPath: string, deps: { homeDir?: string } = {}): boolean {
	if (backupPath.length === 0 || !existsSync(backupPath)) return false;
	const home = deps.homeDir ?? homedir();
	const dir = hivemindDirPath(home);
	// Clear the target FIRST so a retried rollback restores the EXACT backup snapshot instead of merging
	// the recursive copy over leftover files (which would restore a superset of the backup). `force`
	// makes the clear a no-op when the dir is already absent.
	rmSync(dir, { recursive: true, force: true });
	cpSync(backupPath, dir, { recursive: true });
	return true;
}

/**
 * The shared credential directory (`~/.deeplake`) under a home — exported so a caller (and a test) can
 * assert the uninstall NEVER touched it (d-AC-5). The uninstaller deliberately imports the canonical
 * `CREDENTIALS_DIR_NAME` so the "do not delete the shared credential" invariant is keyed off the same
 * constant the credential store writes to.
 */
export function sharedCredentialDirPath(home: string): string {
	return join(home, CREDENTIALS_DIR_NAME);
}

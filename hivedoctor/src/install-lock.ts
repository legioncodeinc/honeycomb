/**
 * HiveDoctor shared install mutex (PRD-064c scope; imported by 064e).
 *
 * A file-based, single-host mutex that guarantees rung 2's reinstall
 * ({@link file://./rungs/reinstall.ts}) and the future auto-update engine (064e)
 * NEVER run two `npm i -g` operations concurrently. Two concurrent global installs
 * race the same `node_modules/.bin` shims and can leave a half-written, unrunnable
 * binary - exactly the "stale global daemon serves old routes" failure mode rung 2
 * exists to fix. One lock serializes them.
 *
 * The lock is the EXCLUSIVE-create of a small JSON file at
 * `~/.honeycomb/hivedoctor/install.lock` (the workspace dir, injected). `wx` flag =
 * "create, fail if it already exists" = the atomic test-and-set the mutex needs; no
 * second process can win the same create.
 *
 * Staleness (design principle 1, "incapable of crashing"): a process that dies
 * mid-install would otherwise wedge the lock forever. So an EXISTING lock whose
 * recorded `acquiredAt` is older than `staleMs` is treated as abandoned, removed, and
 * re-acquired. The timestamp is read from the lock body, NOT the file mtime, so a
 * clock-injected test is deterministic and a touch on the file cannot extend it.
 *
 * Crash-safety: acquire NEVER throws. It returns `null` when the lock is held (and
 * fresh), or a {@link InstallLockHandle} when acquired. `release()` on the handle is
 * best-effort and also never throws - a leaked lock is recovered by staleness, never
 * by a crash. Built-ins ONLY: node:fs + node:path + node:crypto.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

import type { Logger } from "./logger.js";
import { resolveInBase } from "./safe-path.js";

/** The default age past which a held lock is considered abandoned (10 minutes). */
const DEFAULT_STALE_MS = 10 * 60 * 1000;

/** The on-disk lock body. Secret-free: owner token, who, and when only. */
export interface InstallLockBody {
	/** A unique token for the holder, so only the acquirer can match-and-release. */
	readonly owner: string;
	/** Who took the lock (e.g. `reinstall` or `auto-update`), for diagnostics only. */
	readonly holder: string;
	/** Epoch ms the lock was acquired (drives staleness; read from the body, not mtime). */
	readonly acquiredAt: number;
}

/** A live lock the caller holds; `release()` frees it (best-effort, never throws). */
export interface InstallLockHandle {
	/** The unique owner token written into the lock body. */
	readonly owner: string;
	/** Free the lock. Idempotent + crash-safe: a second release, or a release of an
	 * already-stolen lock, is a silent no-op. */
	release(): void;
}

/** Injected clock so staleness is deterministic in tests. */
export interface InstallLockClock {
	now(): number;
}

/** Options for {@link createInstallLock}. */
export interface InstallLockOptions {
	/** HiveDoctor's workspace dir; `install.lock` is created under it. */
	readonly workspaceDir: string;
	/** Logger for the lock's lifecycle (held/stale/acquired); never a credential. */
	readonly logger: Logger;
	/** Age in ms past which a held lock is stolen as abandoned (default 10m). */
	readonly staleMs?: number;
	/** Injected clock (defaults to `Date.now`). */
	readonly clock?: InstallLockClock;
}

/** The install-lock surface: a single `acquire` that returns a handle or null. */
export interface InstallLock {
	/**
	 * Try to acquire the mutex for `holder`. Returns a {@link InstallLockHandle} on
	 * success, or `null` when a FRESH lock is already held (caller must back off). A
	 * STALE lock (older than `staleMs`) is stolen and re-acquired. NEVER throws.
	 */
	acquire(holder: string): InstallLockHandle | null;
}

/**
 * Read + parse the lock body defensively. A missing file, unreadable dir, or garbage
 * JSON yields `null` (treated by the caller as "not validly held"), never a throw.
 */
function readLockBody(filePath: string): InstallLockBody | null {
	try {
		const raw = readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (parsed === null || typeof parsed !== "object") return null;
		const o = parsed as Record<string, unknown>;
		if (typeof o.owner !== "string" || typeof o.holder !== "string" || typeof o.acquiredAt !== "number") {
			return null;
		}
		return { owner: o.owner, holder: o.holder, acquiredAt: o.acquiredAt };
	} catch {
		// Missing file (the common not-held case) or unparseable body: not validly held.
		return null;
	}
}

/** Build the install lock bound to a workspace dir. */
export function createInstallLock(options: InstallLockOptions): InstallLock {
	const now = options.clock?.now ?? Date.now;
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;

	/**
	 * Resolve `install.lock` under the variable workspace dir, asserting it stays inside
	 * (defense-in-depth + SAST taint visibility). A containment violation throws; every
	 * caller below treats that as "cannot acquire" (returns null) - never a crash.
	 */
	function lockPath(): string {
		return resolveInBase(options.workspaceDir, "install.lock");
	}

	/** Write the lock file with the exclusive-create flag. Throws iff it already exists. */
	function exclusiveCreate(filePath: string, body: InstallLockBody): void {
		mkdirSync(options.workspaceDir, { recursive: true });
		// `wx`: create + fail with EEXIST if present. This IS the atomic test-and-set.
		writeFileSync(filePath, `${JSON.stringify(body)}\n`, { encoding: "utf8", flag: "wx" });
	}

	/** Make a handle that releases ONLY the lock it owns (match-on-owner). */
	function makeHandle(filePath: string, owner: string): InstallLockHandle {
		return {
			owner,
			release(): void {
				try {
					// Only remove the file if WE still own it: a stale-steal by another holder
					// must not be clobbered by this handle's late release.
					const body = readLockBody(filePath);
					if (body !== null && body.owner !== owner) return;
					rmSync(filePath, { force: true });
				} catch {
					// Best-effort: a failed release leaves a lock that staleness will reclaim.
					// Never throw from release (design principle 1).
				}
			},
		};
	}

	return {
		acquire(holder: string): InstallLockHandle | null {
			// Containment first: a poisoned workspace that escapes the base cannot acquire.
			let filePath: string;
			try {
				filePath = lockPath();
			} catch {
				// A containment violation means we cannot safely touch the lock file; back off.
				return null;
			}

			const owner = randomUUID();
			const body: InstallLockBody = { owner, holder, acquiredAt: now() };

			try {
				exclusiveCreate(filePath, body);
				options.logger.info("install_lock.acquired", { holder });
				return makeHandle(filePath, owner);
			} catch {
				// The file already exists (or, rarely, a transient FS error). Inspect it: if it
				// is stale, steal it; otherwise the lock is genuinely held and we back off.
			}

			const existing = readLockBody(filePath);
			if (existing === null) {
				// The file exists but is unparseable/garbage (e.g. a crash mid-write). Treat it as
				// abandoned: remove + retry the exclusive create once. A loser of the retry race
				// simply returns null, which is correct (someone else holds it).
				try {
					// Only steal a body-less file if it is actually old enough to be abandoned; a
					// brand-new, momentarily-empty file from a racing writer must not be clobbered.
					const age = now() - statSync(filePath).mtimeMs;
					if (age < staleMs) {
						options.logger.warn("install_lock.held_unparseable", { holder });
						return null;
					}
				} catch {
					// statSync failed (file vanished between calls): fall through to the steal retry.
				}
				return stealAndRetry(filePath, holder, owner, body);
			}

			const age = now() - existing.acquiredAt;
			if (age >= staleMs) {
				options.logger.warn("install_lock.stale_steal", { holder, prevHolder: existing.holder, ageMs: age });
				return stealAndRetry(filePath, holder, owner, body);
			}

			options.logger.info("install_lock.held", { holder, byHolder: existing.holder });
			return null;
		},
	};

	/** Remove an abandoned lock and try the exclusive create once more. */
	function stealAndRetry(
		filePath: string,
		holder: string,
		owner: string,
		body: InstallLockBody,
	): InstallLockHandle | null {
		try {
			rmSync(filePath, { force: true });
			exclusiveCreate(filePath, body);
			options.logger.info("install_lock.acquired", { holder, stolen: true });
			return makeHandle(filePath, owner);
		} catch {
			// Lost the steal race to another process: that is fine, they hold a fresh lock now.
			return null;
		}
	}
}

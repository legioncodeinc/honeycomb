/**
 * Identity file watcher service (PRD-004c FR-1..8, c-AC-1..7).
 *
 * ── WAVE-2 IMPLEMENTATION ───────────────────────────────────────────────────
 * Replaces the Wave-1 no-op stub. The 004a bootstrap already imports,
 * registers, and lifecycles this module (`start()` on listen, `stop()` on
 * shutdown), so c-AC-7 ("watcher active for the life of the process") is
 * guaranteed by the bootstrap.
 *
 * ── IMPLEMENTATION CHOICES ─────────────────────────────────────────────────
 * Watcher: `node:fs.watch` (built-in, no dep). On Node 22 the built-in watcher
 * is reliable on Linux and macOS; on Windows it has historically been less
 * reliable for rapid-burst detection. However, because we apply a 500ms debounce
 * (D-6), any missed intermediate event is absorbed — only the settled state
 * matters. A future swap to chokidar is straightforward: replace the `attachWatch`
 * helper. Choosing the built-in avoids adding a new production dependency.
 *
 * Debounce: a plain `setTimeout`/`clearTimeout` pair, injected via a `clock`
 * parameter so tests use `vi.useFakeTimers()` and remain deterministic (D-6 /
 * CONVENTIONS §5 / c-AC-3). The default window is 500ms (D-6).
 *
 * Git: shelled out to `git` via `git-sync.ts` (no library dep, per CONVENTIONS
 * §004c). Commit is skipped when there is nothing staged (c-AC-4).
 *
 * Harness sync: performed by `harness-sync.ts`. Destinations are injected via
 * `harnessTargets` (PRD-019 registers real paths; tests inject temp dirs).
 *
 * Error policy: a render or commit failure is logged, never rethrown. The
 * watcher keeps running after any per-cycle error (FR-8 / c-AC-6).
 *
 * ── WHAT THIS MODULE DOES NOT TOUCH ────────────────────────────────────────
 * `server.ts`, `index.ts`, `config.ts`, `logger.ts`, `middleware/*`,
 * `services/types.ts`, `services/job-queue.ts`. The stubs.test.ts expectations
 * on `createNoopFileWatcherService` and `noopFileWatcherService` are preserved.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DaemonService } from "./types.js";
import { type HarnessTarget, CANONICAL_IDENTITY_FILES, syncHarnessCopies } from "./harness-sync.js";
import { buildCommitMessage, gitStageAndCommit } from "./git-sync.js";

export type { HarnessTarget };
export { CANONICAL_IDENTITY_FILES };

// ── Clock + scheduler abstraction ────────────────────────────────────────────
// Injected so tests run with `vi.useFakeTimers()` and control debounce timing
// without real wall-clock delays (CONVENTIONS §5 / c-AC-3).

/** Minimal clock abstraction for deterministic debounce in tests. */
export interface WatcherClock {
	/** Return an ISO-8601 timestamp (used in do-not-edit headers + commit msgs). */
	now(): string;
	/** Schedule `fn` after `ms` ms; return a handle to cancel it. */
	setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
	/** Cancel a previously scheduled timer. */
	clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

/** The default production clock (wall-clock + native timers). */
const defaultClock: WatcherClock = {
	now: () => new Date().toISOString(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (h) => clearTimeout(h),
};

// ── Deps + interface ─────────────────────────────────────────────────────────

/** Logger subset the watcher uses (structurally typed — no coupling to RequestLogger). */
export interface WatcherLogger {
	info(msg: string, extra?: Record<string, unknown>): void;
	warn(msg: string, extra?: Record<string, unknown>): void;
	error(msg: string, extra?: Record<string, unknown>): void;
}

/** No-op logger used when no logger is injected (tests that don't care about log output). */
const silentLogger: WatcherLogger = {
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

/** Configuration for the git auto-commit feature. */
export interface GitSyncConfig {
	/** Whether to stage + commit on identity-file change. */
	readonly enabled: boolean;
	/**
	 * The git repo root — defaults to `workspaceDir`. Override in tests to
	 * point at a temp git repo while keeping the workspace dir separate.
	 */
	readonly repoDir?: string;
}

/** Constructor dependencies for the file-watcher service. */
export interface FileWatcherDeps {
	/** Absolute path to the workspace root (the directory containing identity files). */
	readonly workspaceDir: string;
	/** Per-harness copy destinations (injected; real destinations from PRD-019). */
	readonly harnessTargets: readonly HarnessTarget[];
	/** Git auto-commit config. */
	readonly gitSync: GitSyncConfig;
	/** Optional logger (defaults to silent). */
	readonly logger?: WatcherLogger;
	/** Optional clock override (defaults to wall clock + native timers). */
	readonly clock?: WatcherClock;
	/** Debounce window in ms (defaults to 500, per D-6). */
	readonly debounceMs?: number;
	/**
	 * Additional harness project-memory paths to watch (FR-1). These are
	 * relative to `workspaceDir`. Changes to any of these also trigger harness
	 * sync + git commit.
	 */
	readonly extraWatchPaths?: readonly string[];
}

/**
 * The identity file watcher service (004c fills the impl). Extends
 * {@link DaemonService} so the bootstrap starts/stops it uniformly.
 * `start()` attaches the fs watch and is what keeps the watcher alive
 * for the process lifetime (c-AC-7).
 */
export interface FileWatcherService extends DaemonService {
	/** True once `start()` has attached the watch (for diagnostics / c-AC-7). */
	readonly active: boolean;
	/**
	 * Test-only hook: directly schedule a sync cycle without relying on an OS
	 * `fs.watch` event. This lets tests using `vi.useFakeTimers()` bypass the
	 * inherent asynchrony of the OS event delivery (which is not controlled by
	 * fake timers) and instead drive the debounce timer deterministically.
	 *
	 * Usage in tests: write the file on disk, call `_triggerForTest()`, then
	 * advance fake timers past the debounce window, then `await _waitForIdle()`.
	 *
	 * This method is intentionally NOT part of the public production surface.
	 * It is only present on the concrete impl returned by `createFileWatcherService`.
	 */
	_triggerForTest?(): void;
	/**
	 * Test-only hook: wait for the currently-running sync cycle (if any) to
	 * complete. Because `runSyncCycle` involves real async I/O (fs.readFile /
	 * fs.writeFile / git), `vi.runAllTimersAsync()` alone is not sufficient — the
	 * timer fires synchronously but the I/O promise resolves later. Calling
	 * `await svc._waitForIdle?.()` after advancing the fake clock ensures the I/O
	 * has settled before asserting on output files or git commits.
	 *
	 * This method is intentionally NOT part of the public production surface.
	 */
	_waitForIdle?(): Promise<void>;
}

// ── Real implementation ───────────────────────────────────────────────────────

/**
 * Create the real file-watcher service. The returned service must be passed to
 * `createDaemon({ services: { watcher } })` for the bootstrap to start/stop it.
 *
 * @example
 * ```ts
 * const watcher = createFileWatcherService({
 *   workspaceDir: "/home/user/workspace",
 *   harnessTargets: [
 *     { name: "claude-code", outputPath: "/home/user/.claude/CLAUDE.md" },
 *   ],
 *   gitSync: { enabled: true },
 * });
 * const daemon = createDaemon({ services: { watcher } });
 * await daemon.startServices(); // start() is called here (c-AC-7)
 * ```
 */
export function createFileWatcherService(deps: FileWatcherDeps): FileWatcherService {
	const {
		workspaceDir,
		harnessTargets,
		gitSync,
		logger = silentLogger,
		clock = defaultClock,
		debounceMs = 500,
		extraWatchPaths = [],
	} = deps;

	// ── State ──────────────────────────────────────────────────────────────────
	let started = false;
	let debounceHandle: ReturnType<typeof setTimeout> | null = null;
	// Tracks the Promise of the currently-running sync cycle so tests can await
	// it via `_waitForIdle()`. In production this is only used for error surfacing.
	let currentCyclePromise: Promise<void> | null = null;
	// `node:fs.watch` returns a `FSWatcher` instance per directory/file watched.
	const watchers: fs.FSWatcher[] = [];

	// ── Bounded git staging set (security: never `git add -A`) ──────────────────
	/**
	 * The explicit, bounded list of pathspecs the watcher is allowed to stage,
	 * expressed RELATIVE to `repoDir` so git resolves them against the repo and a
	 * file outside the repo is dropped (a relative path with a leading `..` would
	 * escape the repo, so those are excluded). The managed set is exactly:
	 *   - the canonical identity files (the watcher's whole reason to commit),
	 *   - any `extraWatchPaths` the operator added,
	 *   - the harness copy output files that land INSIDE the repo.
	 * Anything else in the working tree — including a stray `.env` / token file /
	 * `credentials.json` — is intentionally NOT here, so it can never be
	 * auto-committed by the identity sync.
	 */
	async function managedPathspecs(repoDir: string): Promise<string[]> {
		const absolutes = [
			...CANONICAL_IDENTITY_FILES.map((name) => path.join(workspaceDir, name)),
			...extraWatchPaths.map((p) => (path.isAbsolute(p) ? p : path.join(workspaceDir, p))),
			...harnessTargets.map((t) => t.outputPath),
		];
		const seen = new Set<string>();
		const specs: string[] = [];
		for (const abs of absolutes) {
			const rel = path.relative(repoDir, abs);
			// Drop anything outside the repo: a `..`-prefixed or absolute relative path
			// is not under `repoDir`, so git could not (and must not) stage it here.
			if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
			if (seen.has(rel)) continue;
			// Only stage a pathspec that currently exists on disk: `git add -- <p>`
			// errors on a never-created identity file (most of the canonical set is
			// usually absent), which would otherwise abort the whole commit. A file
			// that was just deleted is reconciled into the harness copies instead, so
			// dropping a missing canonical path here loses nothing.
			try {
				await fs.promises.access(abs);
			} catch {
				continue;
			}
			seen.add(rel);
			specs.push(rel);
		}
		return specs;
	}

	// ── Core sync + commit cycle ───────────────────────────────────────────────
	/**
	 * The settled handler — runs once per debounce burst (c-AC-3).
	 * Errors are caught and logged; the watcher keeps running (FR-8 / c-AC-6).
	 */
	async function runSyncCycle(): Promise<void> {
		const now = clock.now();
		logger.info("file-watcher: running harness sync", { timestamp: now, workspaceDir });

		// ── Harness sync (c-AC-1 / FR-2 / FR-3) ─────────────────────────────
		let anyChanged = false;
		try {
			const results = await syncHarnessCopies(workspaceDir, harnessTargets, now);
			for (const r of results) {
				if (r.error !== undefined) {
					logger.error("file-watcher: harness sync error", { target: r.target, error: r.error });
				} else if (r.changed) {
					anyChanged = true;
					logger.info("file-watcher: harness copy updated", { target: r.target, path: r.outputPath });
				}
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error("file-watcher: harness sync threw unexpectedly", { error: message });
			// Do not commit when sync failed
			return;
		}

		// ── Git auto-commit (c-AC-2 / c-AC-5) ───────────────────────────────
		if (!gitSync.enabled) {
			// Git sync disabled — copies only, no commit (c-AC-5)
			return;
		}

		if (!anyChanged) {
			// Unchanged canonical files → byte-identical copies → no spurious commit (c-AC-4)
			logger.info("file-watcher: no harness copies changed, skipping git commit");
			return;
		}

		const repoDir = gitSync.repoDir ?? workspaceDir;
		const message = buildCommitMessage(now);
		// Stage ONLY the bounded set of files the watcher manages — never the whole
		// tree (`git add -A`). This is the guard against auto-committing an unrelated
		// secret (a `.env`, a token file, `credentials.json`) that happens to sit in
		// the repo: such a file is not in `managedPathspecs`, so it is never staged.
		const pathspecs = await managedPathspecs(repoDir);
		try {
			const outcome = await gitStageAndCommit({ workspaceDir: repoDir, message, pathspecs });
			if (outcome === "committed") {
				logger.info("file-watcher: git commit created", { message });
			} else {
				// Nothing staged — workspace was clean (c-AC-4)
				logger.info("file-watcher: nothing to commit after harness sync");
			}
		} catch (err) {
			// Commit failure logged, watcher keeps running (FR-8 / c-AC-6)
			const message = err instanceof Error ? err.message : String(err);
			logger.error("file-watcher: git commit failed", { error: message });
		}
	}

	// ── Debounce scheduler ─────────────────────────────────────────────────────
	/**
	 * Schedule a sync cycle after the debounce window. If already scheduled,
	 * cancel and reschedule — a burst of edits coalesces into one cycle (c-AC-3).
	 */
	function scheduleSyncCycle(): void {
		if (debounceHandle !== null) {
			clock.clearTimeout(debounceHandle);
		}
		debounceHandle = clock.setTimeout(() => {
			debounceHandle = null;
			// Track the running promise so _waitForIdle() can await it in tests.
			// In production we still treat it as fire-and-forget (runSyncCycle
			// catches all errors internally), but we store the promise so tests
			// can explicitly drain I/O after advancing fake timers
			// (guide 08-async-concurrency: "fire-and-forget with intent" — the
			// error handling is in runSyncCycle, not the caller).
			currentCyclePromise = runSyncCycle().finally(() => {
				currentCyclePromise = null;
			});
		}, debounceMs);
	}

	// ── Watch attachment ───────────────────────────────────────────────────────
	/**
	 * Attach `node:fs.watch` on the workspace dir (catches all identity file
	 * changes via recursive=false dir-level watch) and on any extra paths.
	 *
	 * We watch the DIRECTORY (not individual files) so that a "delete then
	 * recreate" write pattern (common in editors) still fires the event even
	 * when the original inode is gone (FR-8 / c-AC-6). Each identity-file event
	 * is filtered to only trigger when the changed filename is in the canonical
	 * set or the extra-watch set.
	 *
	 * On Node 22 / Linux, `fs.watch` with no options provides inotify-backed
	 * events. On Windows it uses ReadDirectoryChangesW. Both are stable enough
	 * for our use case given the 500ms debounce absorbs any missed events.
	 */
	function attachWatch(): void {
		const watchedFiles = new Set<string>([
			...CANONICAL_IDENTITY_FILES,
			...extraWatchPaths.map((p) => path.basename(p)),
		]);

		// Watch the workspace directory for canonical identity files
		try {
			const watcher = fs.watch(workspaceDir, (eventType, filename) => {
				if (filename === null || filename === undefined) {
					// Some platforms emit null filenames on directory-level events
					scheduleSyncCycle();
					return;
				}
				// Only react to changes on watched identity filenames (FR-1)
				if (watchedFiles.has(filename)) {
					logger.info("file-watcher: identity file changed", { eventType, filename });
					scheduleSyncCycle();
				}
			});

			watcher.on("error", (err) => {
				logger.error("file-watcher: directory watch error", { dir: workspaceDir, error: err.message });
			});

			watchers.push(watcher);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error("file-watcher: failed to watch workspace dir", { workspaceDir, error: message });
		}

		// Watch any extra full-path entries that are NOT inside workspaceDir
		for (const extraPath of extraWatchPaths) {
			const absPath = path.isAbsolute(extraPath) ? extraPath : path.join(workspaceDir, extraPath);
			// Skip if covered by the directory watch above
			if (path.dirname(absPath) === workspaceDir) continue;
			try {
				const extraWatcher = fs.watch(absPath, () => {
					logger.info("file-watcher: extra path changed", { path: absPath });
					scheduleSyncCycle();
				});
				extraWatcher.on("error", (err) => {
					logger.error("file-watcher: extra path watch error", { path: absPath, error: err.message });
				});
				watchers.push(extraWatcher);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logger.warn("file-watcher: failed to watch extra path (may not exist yet)", {
					path: absPath,
					error: message,
				});
			}
		}
	}

	// ── Service implementation ─────────────────────────────────────────────────
	return {
		get active(): boolean {
			return started;
		},

		_triggerForTest(): void {
			scheduleSyncCycle();
		},

		async _waitForIdle(): Promise<void> {
			// Await the current cycle if one is running, then yield once more to
			// ensure any microtasks queued by the cycle have settled.
			if (currentCyclePromise !== null) {
				await currentCyclePromise;
			}
		},

		async start(): Promise<void> {
			if (started) return; // Idempotent
			attachWatch();
			started = true;
			logger.info("file-watcher: service started", {
				workspaceDir,
				targets: harnessTargets.map((t) => t.name),
				gitSyncEnabled: gitSync.enabled,
				debounceMs,
			});
		},

		async stop(): Promise<void> {
			if (!started) return; // Idempotent

			// Cancel any pending debounce
			if (debounceHandle !== null) {
				clock.clearTimeout(debounceHandle);
				debounceHandle = null;
			}

			// Close all file system watchers
			for (const w of watchers) {
				try {
					w.close();
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					logger.warn("file-watcher: error closing watcher", { error: message });
				}
			}
			watchers.length = 0;

			started = false;
			logger.info("file-watcher: service stopped");
		},
	};
}

// ── No-op stub (preserved for bootstrap default) ──────────────────────────────

/**
 * The no-op stub watcher the 004a bootstrap injects by default. It reports
 * `active` after `start()` so the "watcher is up for the life of the process"
 * wiring (c-AC-7) is already truthful with the stub; it just watches nothing.
 * 004c swaps it for the real impl in its own module + a test that constructs the
 * daemon with the real service.
 */
export function createNoopFileWatcherService(): FileWatcherService {
	let started = false;
	return {
		get active(): boolean {
			return started;
		},
		start(): void {
			started = true; // 004c attaches the real fs watch here.
		},
		stop(): void {
			started = false; // 004c detaches the fs watch here.
		},
	};
}

/** The stub default the bootstrap injects (a fresh inert watcher). */
export const noopFileWatcherService: FileWatcherService = createNoopFileWatcherService();

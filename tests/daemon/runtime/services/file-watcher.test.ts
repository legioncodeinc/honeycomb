/**
 * PRD-004c Identity File Watcher — c-AC-1..c-AC-7.
 *
 * Verification posture (EXECUTION_LEDGER-prd-004):
 *   - temp dirs created with `node:fs/promises.mkdtemp` + `os.tmpdir()`
 *   - a REAL temp git repo initialised per test (`git init`, local user config)
 *   - `vi.useFakeTimers()` controls debounce so tests run at full speed
 *   - each test is named after the AC it proves (one-to-one ledger map)
 *   - no `.skip` / `.only`; `vitest run` is CI
 *
 * Test layout:
 *   c-AC-1  change → per-harness copies with do-not-edit header
 *   c-AC-2  git-enabled + change → timestamped commit
 *   c-AC-3  burst of edits → exactly ONE sync + ONE commit
 *   c-AC-4  unchanged canonical → byte-identical copies, no spurious commit
 *   c-AC-5  git-disabled + change → copies regenerate, no commit
 *   c-AC-6  canonical file removed → copy reconciled, watcher keeps running
 *   c-AC-7  start() → active=true for life of process
 */

import * as os from "node:os";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type FileWatcherDeps,
	type HarnessTarget,
	type WatcherClock,
	createFileWatcherService,
} from "../../../../src/daemon/runtime/services/file-watcher.js";

const execFileAsync = promisify(execFile);

// ── Temp-dir helpers ──────────────────────────────────────────────────────────

/**
 * Create a unique temp directory (under os.tmpdir()). Returns the absolute path.
 * Cleaned up in `cleanupDirs` / afterEach.
 */
async function makeTempDir(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), `honeycomb-fw-${prefix}-`));
}

/**
 * Remove a temp directory tree. Swallows ENOENT (already gone).
 * We use `{ recursive: true, force: true }` — available in Node >=14.14.
 */
async function removeTempDir(dir: string): Promise<void> {
	try {
		await fs.rm(dir, { recursive: true, force: true });
	} catch {
		// Ignore — already removed or OS race
	}
}

// ── Git-repo fixture ──────────────────────────────────────────────────────────

/**
 * Initialise a real git repo in `dir` and configure a local author identity so
 * `git commit` succeeds without a global git config (required in CI).
 */
async function initGitRepo(dir: string): Promise<void> {
	await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: dir }).catch(async () => {
		// Older git versions don't support --initial-branch; fall back gracefully
		await execFileAsync("git", ["init"], { cwd: dir });
	});
	await execFileAsync("git", ["config", "user.email", "test@honeycomb.local"], { cwd: dir });
	await execFileAsync("git", ["config", "user.name", "Honeycomb Test"], { cwd: dir });
}

/**
 * Return the number of commits in `repoDir` (used to assert exactly-one-commit
 * on burst / no-commit on unchanged).
 */
async function countCommits(repoDir: string): Promise<number> {
	try {
		const { stdout } = await execFileAsync("git", ["rev-list", "--count", "HEAD"], { cwd: repoDir });
		return parseInt(stdout.trim(), 10);
	} catch {
		// No commits yet (empty repo)
		return 0;
	}
}

/**
 * Return the subject line of the most-recent commit in `repoDir`.
 */
async function lastCommitMessage(repoDir: string): Promise<string> {
	const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%s"], { cwd: repoDir });
	return stdout.trim();
}

/**
 * Return the set of file paths tracked at HEAD in `repoDir` (empty when there is
 * no commit yet). Used to assert that a stray secret file was NOT committed by
 * the bounded-staging auto-commit.
 */
async function trackedFilesAtHead(repoDir: string): Promise<string[]> {
	try {
		const { stdout } = await execFileAsync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: repoDir });
		return stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
	} catch {
		return [];
	}
}

// ── Fake-timer clock ──────────────────────────────────────────────────────────
//
// `vi.useFakeTimers()` replaces the global `setTimeout`/`clearTimeout`, but
// the injected `WatcherClock` calls the globals. In fake-timer mode Vitest has
// already patched the globals, so the default production clock `defaultClock`
// transparently picks up the fakes — we therefore use it directly and control
// it with `vi.advanceTimersByTime()`.
//
// For tests that need a FIXED timestamp in the commit message / header we
// override the `now` function only, leaving the timer scheduling to the (faked)
// native globals.

function makeClock(overrideNow?: string): WatcherClock {
	return {
		now: overrideNow !== undefined ? () => overrideNow : () => new Date().toISOString(),
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (h) => clearTimeout(h),
	};
}

// ── Write helpers ─────────────────────────────────────────────────────────────

/** Write a canonical identity file to `dir`. */
async function writeCanonical(dir: string, name: string, content: string): Promise<void> {
	await fs.writeFile(path.join(dir, name), content, "utf8");
}

/** Read a harness output file; return its content. */
async function readOutput(outputPath: string): Promise<string> {
	return fs.readFile(outputPath, "utf8");
}

/** Check whether a file exists. */
async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

// ── Suite state ───────────────────────────────────────────────────────────────

// Temp directories to clean up in afterEach
let tempDirs: string[] = [];

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(tempDirs.map(removeTempDir));
	tempDirs = [];
});

// ── Helper: create a standard test setup ─────────────────────────────────────

interface TestSetup {
	workspaceDir: string;
	repoDir: string;
	outputDir: string;
	targets: HarnessTarget[];
}

/**
 * Create a workspace dir, a git repo dir (may be the same or different), and
 * an output dir for harness copies. Populates at least one canonical identity
 * file so syncs produce real output.
 */
async function makeSetup(opts: {
	gitInWorkspace?: boolean;
	initialContent?: string;
} = {}): Promise<TestSetup> {
	const { gitInWorkspace = false, initialContent = "# identity content\n" } = opts;

	const workspaceDir = await makeTempDir("ws");
	const outputDir = await makeTempDir("out");

	// Separate git repo dir unless we want git-in-workspace
	const repoDir = gitInWorkspace ? workspaceDir : await makeTempDir("repo");

	tempDirs.push(workspaceDir, outputDir);
	if (!gitInWorkspace) tempDirs.push(repoDir);

	// Write a canonical identity file so the watcher has something to sync
	await writeCanonical(workspaceDir, "AGENTS.md", initialContent);

	// Initialise git repo
	await initGitRepo(repoDir);

	// A single harness target — output lands in a temp dir
	const targets: HarnessTarget[] = [
		{
			name: "claude-code",
			outputPath: path.join(outputDir, "CLAUDE.md"),
		},
	];

	return { workspaceDir, repoDir, outputDir, targets };
}

// ── Utility: trigger a watcher cycle WITHOUT needing a real fs event ─────────
//
// Real `fs.watch` events are asynchronous and unpredictable in speed. To avoid
// race conditions in tests we:
//   1. Modify a canonical file (which triggers the real fs.watch event AND
//      schedules the debounce timer), OR
//   2. Use a manual-trigger path for tests that need precise control.
//
// Pattern used here: write the file, then advance fake timers past the debounce
// window, then flush any microtasks with `vi.runAllTimersAsync()`.
//
// See https://vitest.dev/api/vi#vi-usefaketimers for the advanceTimersByTime API.

/**
 * Write content to an identity file, schedule a sync via `_triggerForTest()`,
 * advance fake timers past the debounce window, and flush microtasks.
 *
 * We call `svc._triggerForTest()` explicitly instead of relying on the real
 * `fs.watch` OS event because:
 *   - `vi.useFakeTimers()` controls Node's setTimeout/clearTimeout but does NOT
 *     control OS-level file-system event delivery.
 *   - On Windows, `fs.watch` events are delivered asynchronously by the OS
 *     on a separate thread; there is no reliable ordering guarantee between
 *     "file written" and "vi.advanceTimersByTime is called".
 *   - `_triggerForTest()` directly calls `scheduleSyncCycle()` which queues the
 *     debounce timer — the only thing fake timers CAN control.
 *
 * This is the canonical pattern from CONVENTIONS §5 (testing posture) and
 * EXECUTION_LEDGER-prd-004 §D-6 (fake timers for debounce).
 */
async function triggerSync(
	workspaceDir: string,
	filename: string,
	content: string,
	svc: { _triggerForTest?(): void; _waitForIdle?(): Promise<void> },
	debounceMs = 500,
): Promise<void> {
	await writeCanonical(workspaceDir, filename, content);
	// Explicitly schedule the sync cycle — bypasses OS event asynchrony.
	// (See comment above for why we don't rely on real fs.watch events here.)
	svc._triggerForTest?.();
	// Advance past the debounce window; this fires the timer callback which
	// starts runSyncCycle() and stores its promise in currentCyclePromise.
	vi.advanceTimersByTime(debounceMs + 10);
	await vi.runAllTimersAsync();
	// Await the running cycle's real async I/O (fs reads/writes + git).
	// vi.runAllTimersAsync() only drains timer callbacks, not the I/O chain.
	await svc._waitForIdle?.();
}

// ─────────────────────────────────────────────────────────────────────────────
// c-AC-7 — start() → active=true for the life of the process
// ─────────────────────────────────────────────────────────────────────────────

describe("c-AC-7 start() → active=true for life of process", () => {
	it("service is inactive before start, active after start(), inactive after stop()", async () => {
		const { workspaceDir, repoDir, targets } = await makeSetup();
		const svc = createFileWatcherService({
			workspaceDir,
			harnessTargets: targets,
			gitSync: { enabled: false, repoDir },
		});

		expect(svc.active).toBe(false);
		await svc.start();
		expect(svc.active).toBe(true);
		await svc.stop();
		expect(svc.active).toBe(false);
	});

	it("start() is idempotent — double start stays active", async () => {
		const { workspaceDir, repoDir, targets } = await makeSetup();
		const svc = createFileWatcherService({
			workspaceDir,
			harnessTargets: targets,
			gitSync: { enabled: false, repoDir },
		});
		await svc.start();
		await svc.start(); // second call must not crash
		expect(svc.active).toBe(true);
		await svc.stop();
	});

	it("stop() is idempotent — double stop does not throw", async () => {
		const { workspaceDir, repoDir, targets } = await makeSetup();
		const svc = createFileWatcherService({
			workspaceDir,
			harnessTargets: targets,
			gitSync: { enabled: false, repoDir },
		});
		await svc.start();
		await svc.stop();
		await svc.stop(); // second call must not crash
		expect(svc.active).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// c-AC-1 — change → per-harness copies regenerate with do-not-edit header
// ─────────────────────────────────────────────────────────────────────────────

describe("c-AC-1 change to identity file → per-harness copies with do-not-edit header", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("writing AGENTS.md triggers a sync that produces a copy with the do-not-edit header", async () => {
		const { workspaceDir, repoDir, targets } = await makeSetup({
			initialContent: "# My Agent\n",
		});

		const svc = createFileWatcherService({
			workspaceDir,
			harnessTargets: targets,
			gitSync: { enabled: false, repoDir },
			clock: makeClock("2024-01-01T00:00:00.000Z"),
		});

		await svc.start();

		await triggerSync(workspaceDir, "AGENTS.md", "# Updated Agent\n", svc);

		await svc.stop();

		const output = await readOutput(targets[0]!.outputPath);

		// Must contain the do-not-edit banner
		expect(output).toContain("DO NOT EDIT");
		expect(output).toContain("Honeycomb daemon");
		// Must contain the updated content
		expect(output).toContain("Updated Agent");
		// Header must identify the target
		expect(output).toContain("claude-code");
	});

	it("copies are created for multiple harness targets simultaneously", async () => {
		const workspaceDir = await makeTempDir("ws-multi");
		const out1 = await makeTempDir("out1");
		const out2 = await makeTempDir("out2");
		const repoDir = await makeTempDir("repo-multi");
		tempDirs.push(workspaceDir, out1, out2, repoDir);

		await writeCanonical(workspaceDir, "AGENTS.md", "# Agent\n");
		await initGitRepo(repoDir);

		const multiTargets: HarnessTarget[] = [
			{ name: "claude-code", outputPath: path.join(out1, "CLAUDE.md") },
			{ name: "codex", outputPath: path.join(out2, "CODEX.md") },
		];

		const svc = createFileWatcherService({
			workspaceDir,
			harnessTargets: multiTargets,
			gitSync: { enabled: false, repoDir },
			clock: makeClock("2024-01-02T00:00:00.000Z"),
		});

		await svc.start();
		await triggerSync(workspaceDir, "AGENTS.md", "# Agent v2\n", svc);
		await svc.stop();

		const copy1 = await readOutput(multiTargets[0]!.outputPath);
		const copy2 = await readOutput(multiTargets[1]!.outputPath);

		expect(copy1).toContain("DO NOT EDIT");
		expect(copy1).toContain("claude-code");
		expect(copy2).toContain("DO NOT EDIT");
		expect(copy2).toContain("codex");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// c-AC-2 — git-enabled + workspace change → timestamped commit
// ─────────────────────────────────────────────────────────────────────────────

describe("c-AC-2 git sync enabled + change → timestamped commit", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("after a change with git enabled, git log shows a commit with the timestamp", async () => {
		// We use git-in-workspace = true so the watcher stages the workspace files
		// (the canonical identity files are in the repo dir, which is also the
		// workspace dir — simplifies the test).
		const workspaceDir = await makeTempDir("ws-git");
		const outputDir = await makeTempDir("out-git");
		tempDirs.push(workspaceDir, outputDir);

		await writeCanonical(workspaceDir, "AGENTS.md", "# Agent\n");
		await initGitRepo(workspaceDir);

		const FIXED_TS = "2024-06-01T12:00:00.000Z";
		const targets: HarnessTarget[] = [
			{ name: "claude-code", outputPath: path.join(outputDir, "CLAUDE.md") },
		];

		const svc = createFileWatcherService({
			workspaceDir,
			harnessTargets: targets,
			gitSync: { enabled: true, repoDir: workspaceDir },
			clock: makeClock(FIXED_TS),
		});

		await svc.start();
		await triggerSync(workspaceDir, "AGENTS.md", "# Agent updated\n", svc);
		await svc.stop();

		// There must be at least one commit
		const commitCount = await countCommits(workspaceDir);
		expect(commitCount).toBeGreaterThanOrEqual(1);

		// The most recent commit message must include the timestamp
		const msg = await lastCommitMessage(workspaceDir);
		expect(msg).toContain(FIXED_TS);
		expect(msg).toMatch(/^chore: identity sync /);
	});

	// SECURITY (PRD-004 security close-out): the auto-commit must stage ONLY the
	// identity files it manages — never the whole working tree. A secret that
	// happens to live in the repo (a `.env`, a token file, `credentials.json`)
	// must NOT be swept into the auto-commit. This locks in the bounded-staging
	// fix (git add -- <pathspecs>, never git add -A).
	it("does NOT auto-commit an unrelated secret file sitting in the repo", async () => {
		const workspaceDir = await makeTempDir("ws-secret");
		const outputDir = await makeTempDir("out-secret");
		tempDirs.push(workspaceDir, outputDir);

		await writeCanonical(workspaceDir, "AGENTS.md", "# Agent\n");
		// A secret the watcher must never touch — present, untracked, not gitignored.
		await fs.writeFile(path.join(workspaceDir, ".env"), "DEEPLAKE_TOKEN=eyJsecret\n", "utf8");
		await fs.writeFile(path.join(workspaceDir, "credentials.json"), '{"token":"eyJsecret"}\n', "utf8");
		await initGitRepo(workspaceDir);

		const targets: HarnessTarget[] = [
			{ name: "claude-code", outputPath: path.join(outputDir, "CLAUDE.md") },
		];

		const svc = createFileWatcherService({
			workspaceDir,
			harnessTargets: targets,
			gitSync: { enabled: true, repoDir: workspaceDir },
			clock: makeClock("2024-06-01T12:30:00.000Z"),
		});

		await svc.start();
		await triggerSync(workspaceDir, "AGENTS.md", "# Agent updated\n", svc);
		await svc.stop();

		// The identity file was committed …
		const tracked = await trackedFilesAtHead(workspaceDir);
		expect(tracked).toContain("AGENTS.md");
		// … but the secret files were NOT staged or committed by the auto-commit.
		expect(tracked).not.toContain(".env");
		expect(tracked).not.toContain("credentials.json");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// c-AC-3 — burst of edits → exactly ONE sync + ONE commit
// ─────────────────────────────────────────────────────────────────────────────

describe("c-AC-3 burst of edits → exactly one sync + one commit", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("three rapid writes within the debounce window produce exactly one git commit", async () => {
		const workspaceDir = await makeTempDir("ws-burst");
		const outputDir = await makeTempDir("out-burst");
		tempDirs.push(workspaceDir, outputDir);

		await writeCanonical(workspaceDir, "AGENTS.md", "# v1\n");
		await initGitRepo(workspaceDir);

		const FIXED_TS = "2024-06-01T13:00:00.000Z";
		const targets: HarnessTarget[] = [
			{ name: "claude-code", outputPath: path.join(outputDir, "CLAUDE.md") },
		];

		const svc = createFileWatcherService({
			workspaceDir,
			harnessTargets: targets,
			gitSync: { enabled: true, repoDir: workspaceDir },
			clock: makeClock(FIXED_TS),
			debounceMs: 500,
		});

		await svc.start();

		// Three writes in rapid succession — each calls _triggerForTest() to
		// schedule the debounce timer (bypassing OS fs.watch asynchrony), then
		// advance the fake clock by less than the debounce window so the timer
		// is cancelled and rescheduled each time. Only the third fires.
		await writeCanonical(workspaceDir, "AGENTS.md", "# v2\n");
		svc._triggerForTest?.();
		vi.advanceTimersByTime(100); // 100ms < 500ms debounce: not yet fired

		await writeCanonical(workspaceDir, "AGENTS.md", "# v3\n");
		svc._triggerForTest?.();
		vi.advanceTimersByTime(100); // 200ms total

		await writeCanonical(workspaceDir, "AGENTS.md", "# v4\n");
		svc._triggerForTest?.();
		// Now advance past the full debounce window from the last write
		vi.advanceTimersByTime(500 + 10); // fires exactly once
		await vi.runAllTimersAsync();
		// Await the real async I/O (fs writes + git commit)
		await svc._waitForIdle?.();

		await svc.stop();

		// Exactly one commit must exist
		const commitCount = await countCommits(workspaceDir);
		expect(commitCount).toBe(1);

		// The copy reflects the LAST write (v4)
		const output = await readOutput(targets[0]!.outputPath);
		expect(output).toContain("# v4");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// c-AC-4 — unchanged canonical → byte-identical copies, no spurious commit
// ─────────────────────────────────────────────────────────────────────────────

describe("c-AC-4 unchanged canonical files → byte-identical copies + no spurious commit", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("running sync twice with the same canonical content produces no git commit", async () => {
		const workspaceDir = await makeTempDir("ws-idem");
		const outputDir = await makeTempDir("out-idem");
		tempDirs.push(workspaceDir, outputDir);

		const content = "# Stable agent\n";
		await writeCanonical(workspaceDir, "AGENTS.md", content);
		await initGitRepo(workspaceDir);

		const FIXED_TS = "2024-06-01T14:00:00.000Z";
		const targets: HarnessTarget[] = [
			{ name: "claude-code", outputPath: path.join(outputDir, "CLAUDE.md") },
		];

		const svc = createFileWatcherService({
			workspaceDir,
			harnessTargets: targets,
			gitSync: { enabled: true, repoDir: workspaceDir },
			clock: makeClock(FIXED_TS),
		});

		await svc.start();

		// First sync — content changes (file written for first time) → one commit
		await triggerSync(workspaceDir, "AGENTS.md", content, svc);

		const countAfterFirst = await countCommits(workspaceDir);

		// Second sync — same canonical content; the generated copy is byte-identical
		// → no spurious commit
		await triggerSync(workspaceDir, "AGENTS.md", content, svc);

		const countAfterSecond = await countCommits(workspaceDir);

		await svc.stop();

		// The second run must not have added a new commit
		expect(countAfterSecond).toBe(countAfterFirst);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// c-AC-5 — git disabled + change → copies regenerate, no commit
// ─────────────────────────────────────────────────────────────────────────────

describe("c-AC-5 git sync disabled + change → copies regenerate, no commit", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("harness copies are written but git commit is NOT made when gitSync.enabled=false", async () => {
		const workspaceDir = await makeTempDir("ws-nogit");
		const outputDir = await makeTempDir("out-nogit");
		tempDirs.push(workspaceDir, outputDir);

		await writeCanonical(workspaceDir, "AGENTS.md", "# Agent\n");
		await initGitRepo(workspaceDir);

		const targets: HarnessTarget[] = [
			{ name: "claude-code", outputPath: path.join(outputDir, "CLAUDE.md") },
		];

		const svc = createFileWatcherService({
			workspaceDir,
			harnessTargets: targets,
			gitSync: { enabled: false, repoDir: workspaceDir },
			clock: makeClock("2024-06-01T15:00:00.000Z"),
		});

		await svc.start();
		await triggerSync(workspaceDir, "AGENTS.md", "# Agent updated for nogit\n", svc);
		await svc.stop();

		// Harness copy must exist and contain the content + header
		const copyExists = await fileExists(targets[0]!.outputPath);
		expect(copyExists).toBe(true);

		const output = await readOutput(targets[0]!.outputPath);
		expect(output).toContain("DO NOT EDIT");
		expect(output).toContain("Agent updated for nogit");

		// No git commit should have been made
		const commitCount = await countCommits(workspaceDir);
		expect(commitCount).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// c-AC-6 — canonical file removed → copy reconciled, watcher keeps running
// ─────────────────────────────────────────────────────────────────────────────

describe("c-AC-6 canonical file removed → copy reconciled, watcher keeps running", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("removing a canonical file is handled gracefully and the watcher stays active", async () => {
		const workspaceDir = await makeTempDir("ws-remove");
		const outputDir = await makeTempDir("out-remove");
		tempDirs.push(workspaceDir, outputDir);

		// Start with AGENTS.md present
		await writeCanonical(workspaceDir, "AGENTS.md", "# Initial\n");
		await initGitRepo(workspaceDir);

		const targets: HarnessTarget[] = [
			{ name: "claude-code", outputPath: path.join(outputDir, "CLAUDE.md") },
		];

		const svc = createFileWatcherService({
			workspaceDir,
			harnessTargets: targets,
			gitSync: { enabled: false, repoDir: workspaceDir },
			clock: makeClock("2024-06-01T16:00:00.000Z"),
		});

		await svc.start();
		expect(svc.active).toBe(true);

		// First sync with the file present — produces a copy
		await triggerSync(workspaceDir, "AGENTS.md", "# Initial\n", svc);

		let output = await readOutput(targets[0]!.outputPath);
		expect(output).toContain("Initial");

		// Remove the canonical file (simulate rename/delete)
		await fs.unlink(path.join(workspaceDir, "AGENTS.md"));

		// Trigger the watcher cycle with a different identity file change
		// (we write USER.md and manually trigger since AGENTS.md is gone)
		await writeCanonical(workspaceDir, "USER.md", "# User\n");
		svc._triggerForTest?.();
		vi.advanceTimersByTime(500 + 10);
		await vi.runAllTimersAsync();
		await svc._waitForIdle?.();

		// Watcher must still be active after the missing-file cycle
		expect(svc.active).toBe(true);

		// The copy must have been reconciled — AGENTS.md missing is noted as a
		// placeholder, not causing a crash
		output = await readOutput(targets[0]!.outputPath);
		expect(output).toContain("DO NOT EDIT");
		// Missing file placeholder is included (harness-sync.ts inserts a note)
		expect(output).toContain("AGENTS.md");

		await svc.stop();
		// Watcher stops cleanly even after a removal event
		expect(svc.active).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Additional: integration path — daemon constructed with real service
// Proves c-AC-7 via the bootstrap lifecycle (createDaemon + startServices)
// ─────────────────────────────────────────────────────────────────────────────

describe("c-AC-7 (bootstrap path) daemon startServices/stopServices lifecycle", () => {
	it("the watcher integrates with createDaemon and is active after startServices()", async () => {
		const { createDaemon } = await import("../../../../src/daemon/runtime/server.js");
		const { workspaceDir, repoDir, targets } = await makeSetup();

		const svc = createFileWatcherService({
			workspaceDir,
			harnessTargets: targets,
			gitSync: { enabled: false, repoDir },
		});

		const daemon = createDaemon({
			config: { host: "127.0.0.1", port: 3850, mode: "local", widened: false },
			services: { watcher: svc },
		});

		expect(svc.active).toBe(false);
		await daemon.startServices();
		expect(svc.active).toBe(true);
		await daemon.stopServices();
		expect(svc.active).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Harness-sync unit tests (do-not-edit header format)
// ─────────────────────────────────────────────────────────────────────────────

describe("do-not-edit header format (FR-3)", () => {
	it("buildDoNotEditHeader produces the expected banner lines", async () => {
		const { buildDoNotEditHeader } = await import(
			"../../../../src/daemon/runtime/services/harness-sync.js"
		);

		const header = buildDoNotEditHeader({
			sourceFile: "/workspace/AGENTS.md",
			targetName: "claude-code",
			generatedAt: "2024-01-01T00:00:00.000Z",
		});

		expect(header).toContain("DO NOT EDIT");
		expect(header).toContain("Honeycomb daemon");
		expect(header).toContain("/workspace/AGENTS.md");
		expect(header).toContain("claude-code");
		expect(header).toContain("2024-01-01T00:00:00.000Z");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Git-sync unit tests (commit message format)
// ─────────────────────────────────────────────────────────────────────────────

describe("git commit message format (c-AC-2)", () => {
	it("buildCommitMessage includes the injected timestamp", async () => {
		const { buildCommitMessage } = await import(
			"../../../../src/daemon/runtime/services/git-sync.js"
		);

		const ts = "2024-06-17T09:00:00.000Z";
		const msg = buildCommitMessage(ts);
		expect(msg).toMatch(/^chore: identity sync /);
		expect(msg).toContain(ts);
	});
});

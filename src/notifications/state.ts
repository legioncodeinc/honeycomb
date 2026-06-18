/**
 * The real ClaimLock + NotificationsState seams (filesystem) — PRD-020d (FR-4..FR-6 / D-5).
 *
 * Wave 2 fills these with the GENUINE POSIX primitives (D-5 — not a stand-in):
 *   - {@link createClaimLock}: `openSync(claimPath(key), "wx")` — exclusive create. The first
 *     process wins (the fd it returns is closed immediately; the file IS the lock); a racer
 *     hits `EEXIST` and `claim` returns false → exactly one banner (FR-4 / d-AC-1). `release`
 *     `unlinkSync`s the claim so a transient notification re-fires next session (FR-6).
 *   - {@link createNotificationsState}: reads/writes `~/.honeycomb/notifications-state.json` via
 *     a temp file + atomic `renameSync` (crash-safe, FR-5 / D-5). `wasShown` checks a dedupKey;
 *     `markShown` records a persistent record (show-once, d-AC-4).
 *
 * Both take an optional `dir` override (tests) and touch a small {@link StateFs} seam over
 * `node:fs` + `~/.honeycomb/` ONLY — never DeepLake. The in-memory FAKES (for unit tests) live
 * in `contracts.ts` (`createFakeClaimLock` / `createFakeNotificationsState`); the {@link StateFs}
 * seam lets a Wave-2 unit test drive the real factories' `wx`/EEXIST + temp+rename LOGIC against
 * an in-memory FS (the `EEXIST` race + the no-torn-write window) without disk, while the default
 * `nodeStateFs` runs the genuine POSIX calls against a temp dir in an integration test.
 */

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	type ClaimLock,
	type NotificationsState,
	type NotificationsStateData,
	type PersistentRecord,
} from "./contracts.js";

/** The state directory (defaults to `~/.honeycomb`). A test overrides it with a temp dir. */
export interface StateLocation {
	/** Override the state directory; undefined → the real `~/.honeycomb`. */
	readonly dir?: string;
	/** Override the FS seam; undefined → the real `node:fs` ({@link nodeStateFs}). */
	readonly fs?: StateFs;
}

/** The state file name under the state dir (FR-5). */
export const STATE_FILE_NAME = "notifications-state.json" as const;
/** The claim-file subdirectory under the state dir (FR-4). */
export const CLAIM_DIR_NAME = "claims" as const;

/** A stable, greppable error a thrown POSIX FS error is wrapped as (so it is never swallowed). */
export class StateFsError extends Error {
	constructor(message: string) {
		super(`PRD-020d state-fs: ${message}`);
		this.name = "StateFsError";
	}
}

/**
 * The minimal filesystem seam the real factories touch (FR-4..FR-6 / D-5). It deliberately
 * mirrors the GENUINE `node:fs` semantics the correctness rules depend on:
 *   - `openExclusive` MUST throw an `EEXIST`-coded error when the path already exists — that is
 *     the `openSync(.., "wx")` race winner/loser signal the claim lock keys off (FR-4 / d-AC-1).
 *   - `rename` MUST be atomic — the temp-file→`renameSync` swap that gives `markShown` its
 *     no-torn-write window (FR-5 / D-5).
 * The default {@link nodeStateFs} is exactly `node:fs`; a unit test injects an in-memory fake
 * with the same `EEXIST`/atomic-rename contract so the LOGIC is driven without disk.
 */
export interface StateFs {
	/** mkdir -p. */
	ensureDir(dir: string): void;
	/** True when a path exists. */
	exists(path: string): boolean;
	/** Read a UTF-8 file (throws if absent — callers guard with {@link StateFs.exists}). */
	readText(path: string): string;
	/** Write a UTF-8 file (non-atomic; used for the temp file before the rename). */
	writeText(path: string, contents: string): void;
	/** Atomically rename `from` → `to` (the crash-safe swap, FR-5 / D-5). */
	rename(from: string, to: string): void;
	/** Remove a file. No-op when absent (idempotent release, FR-6). */
	remove(path: string): void;
	/**
	 * Exclusive-create `path` (the `openSync(.., "wx")` claim, FR-4 / d-AC-1). Returns true when
	 * THIS caller created it (won the race); returns false when it already existed (`EEXIST` — a
	 * racer lost). Any OTHER error propagates (a real FS failure is never silently a "loss").
	 */
	openExclusive(path: string): boolean;
}

/** Whether a thrown error carries the POSIX `EEXIST` code (the lost-the-race signal). */
function isEexist(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "EEXIST";
}

/** The real `node:fs`-backed {@link StateFs} (the production seam). */
export const nodeStateFs: StateFs = {
	ensureDir(dir: string): void {
		mkdirSync(dir, { recursive: true });
	},
	exists(path: string): boolean {
		return existsSync(path);
	},
	readText(path: string): string {
		return readFileSync(path, "utf-8");
	},
	writeText(path: string, contents: string): void {
		writeFileSync(path, contents, "utf-8");
	},
	rename(from: string, to: string): void {
		renameSync(from, to);
	},
	remove(path: string): void {
		if (existsSync(path)) unlinkSync(path);
	},
	openExclusive(path: string): boolean {
		try {
			// `wx` = O_CREAT | O_EXCL — the kernel atomically fails if the file exists, so two
			// racing processes cannot both succeed. The fd is the lock acquisition; the FILE is the
			// lock, so we close the fd immediately and leave the file in place until `release`.
			const fd = openSync(path, "wx");
			closeSync(fd);
			return true;
		} catch (err) {
			if (isEexist(err)) return false; // a racer already created it → this caller lost (FR-4).
			throw new StateFsError(err instanceof Error ? err.message : String(err));
		}
	},
};

/** Resolve the state directory (the override, or `~/.honeycomb`). */
function stateDir(loc: StateLocation): string {
	return loc.dir ?? join(homedir(), ".honeycomb");
}

/** Resolve the FS seam (the override, or the real `node:fs`). */
function stateFs(loc: StateLocation): StateFs {
	return loc.fs ?? nodeStateFs;
}

/** A claim key is a single path segment; reject traversal so a key can never escape `claims/`. */
function safeClaimSegment(key: string): string {
	if (key.length === 0 || key.includes("/") || key.includes("\\") || key.includes("..")) {
		throw new StateFsError(`unsafe claim key: ${JSON.stringify(key)}`);
	}
	return `${key}.claim`;
}

/**
 * Build the real POSIX-exclusive {@link ClaimLock} (FR-4 / d-AC-1 / D-5). `claim(key)` does
 * `openSync(claimPath(key), "wx")` (via the seam): the first racer to create the file wins
 * (returns true), a second hits `EEXIST` and loses (returns false) → exactly ONE banner across
 * racing hook processes. `release(key)` `unlinkSync`s the claim so a transient notification
 * re-fires next session (FR-6). The claim dir is ensured lazily on first claim.
 */
export function createClaimLock(loc: StateLocation = {}): ClaimLock {
	const fs = stateFs(loc);
	const dir = join(stateDir(loc), CLAIM_DIR_NAME);
	const pathFor = (key: string): string => join(dir, safeClaimSegment(key));
	return {
		claim(key: string): boolean {
			fs.ensureDir(dir);
			return fs.openExclusive(pathFor(key));
		},
		release(key: string): void {
			fs.remove(pathFor(key));
		},
	};
}

/** Parse the on-disk state text into {@link NotificationsStateData}; garbled/absent → empty. */
function parseStateData(text: string | undefined): NotificationsStateData {
	if (text === undefined) return { seen: {} };
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed === null || typeof parsed !== "object") return { seen: {} };
		const seen = (parsed as { seen?: unknown }).seen;
		if (seen === null || typeof seen !== "object") return { seen: {} };
		return { seen: seen as Record<string, PersistentRecord> };
	} catch {
		// A torn/garbled file is treated as empty rather than thrown — the worst case is a
		// persistent notification re-shows once, never a crashed session (fail-soft, FR-2).
		return { seen: {} };
	}
}

/**
 * Build the real {@link NotificationsState} (FR-5 / d-AC-4 / D-5). `load`/`wasShown` read +
 * parse `notifications-state.json` (absent → empty). `markShown` records a persistent record
 * and writes via a TEMP FILE + atomic `renameSync` (crash-safe): the JSON is written to
 * `<file>.<pid>.<rand>.tmp` then atomically renamed over the real file, so a crash mid-write
 * never leaves a torn `notifications-state.json` (FR-5 / D-5). Transient notifications record
 * NOTHING here — they re-emit each session while the cause persists (FR-6 / d-AC-5).
 */
export function createNotificationsState(loc: StateLocation = {}): NotificationsState {
	const fs = stateFs(loc);
	const dir = stateDir(loc);
	const file = join(dir, STATE_FILE_NAME);

	const read = (): NotificationsStateData => (fs.exists(file) ? parseStateData(fs.readText(file)) : { seen: {} });

	return {
		load(): NotificationsStateData {
			return read();
		},
		wasShown(dedupKey: string): boolean {
			return Object.prototype.hasOwnProperty.call(read().seen, dedupKey);
		},
		markShown(record: PersistentRecord): void {
			fs.ensureDir(dir);
			const current = read();
			const next: NotificationsStateData = {
				seen: { ...current.seen, [record.dedupKey]: record },
			};
			// Temp-file + atomic rename: no partial-write window. A unique temp name avoids two
			// concurrent writers colliding on the same temp file; the rename is the atomic commit.
			const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
			fs.writeText(tmp, `${JSON.stringify(next, null, 2)}\n`);
			fs.rename(tmp, file);
		},
	};
}

/**
 * Build an in-memory {@link StateFs} honoring the SAME `EEXIST`/atomic-rename contract as
 * `node:fs` (the disk-free unit seam). A unit test injects this to drive the real
 * `createClaimLock` / `createNotificationsState` LOGIC — the `wx` race winner/loser split and the
 * temp→rename swap — without touching disk. Seedable with initial files.
 */
export function createInMemoryStateFs(seed?: Record<string, string>): StateFs & {
	readonly files: ReadonlyMap<string, string>;
} {
	const files = new Map<string, string>(Object.entries(seed ?? {}));
	return {
		get files(): ReadonlyMap<string, string> {
			return files;
		},
		ensureDir(): void {
			/* in-memory: dirs are implicit */
		},
		exists(path: string): boolean {
			return files.has(path);
		},
		readText(path: string): string {
			const v = files.get(path);
			if (v === undefined) throw new StateFsError(`ENOENT: ${path}`);
			return v;
		},
		writeText(path: string, contents: string): void {
			files.set(path, contents);
		},
		rename(from: string, to: string): void {
			const v = files.get(from);
			if (v === undefined) throw new StateFsError(`ENOENT rename: ${from}`);
			files.set(to, v);
			files.delete(from);
		},
		remove(path: string): void {
			files.delete(path);
		},
		openExclusive(path: string): boolean {
			if (files.has(path)) return false; // EEXIST-equivalent: the file already exists.
			files.set(path, ""); // the claim file IS the lock; its body is irrelevant.
			return true;
		},
	};
}

/**
 * The copy-then-atomic-rename move primitives shared by the per-family movers (`families.ts`) and
 * the telemetry store's open-time retry (`telemetry/fleet-store.ts`) — PRD-072b.
 *
 * Extracted so the store can retry an unmigrated legacy database at open time WITHOUT importing the
 * family wiring (which itself imports the store's path constants — a cycle otherwise). Every move is
 * additive: a legacy file is removed ONLY after the copy verifiably landed at the destination.
 *
 * ── The migrated-vs-minted distinction (QA Critical 2b) ─────────────────────────────────────────
 * A destination that already exists is NOT automatically "done": a store may have minted a fresh
 * file at the new path while the unmigrated legacy copy still sits next door (the mover-failure-
 * then-store-open sequence). So when BOTH paths exist:
 *   - byte-identical content  → the destination IS the migrated copy (or equivalent); remove the
 *     legacy file and report `migrated` (verified-equivalent).
 *   - differing content       → report `failed` (retryable): the family must NEVER self-mark
 *     complete just because a freshly-minted file occupies the destination. The legacy file is
 *     retained untouched.
 * Only when the destination exists and NO legacy file remains is the move a true `skipped`.
 */

import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import type { FamilyOutcome } from "./migrate.js";

/** POSIX dir mode for created state dirs (owner read/write/execute only). */
export const STATE_DIR_MODE = 0o700;

/** A unique temp path beside a destination so copy-then-rename stays on the destination volume. */
function tempBeside(dest: string): string {
	return `${dest}.migrate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Options for {@link moveFile}. */
export interface MoveFileOptions {
	/** Preserve/apply this POSIX file mode on the destination (ignored on Windows). */
	readonly fileMode?: number;
	/** Read both files back and require byte-identity; a mismatch fails the move (machine key). */
	readonly verifyBytes?: boolean;
}

/** True when both files exist and carry byte-identical content (never throws; unreadable → false). */
function filesByteIdentical(a: string, b: string): boolean {
	try {
		return readFileSync(a).equals(readFileSync(b));
	} catch {
		return false;
	}
}

/**
 * Copy `legacyFile` to `newFile` (temp + atomic rename), then remove the legacy copy. Returns
 * `skipped` when there is nothing to do (no legacy file, or the destination exists with no legacy
 * remainder); `migrated` on a successful move OR when both exist byte-identical (the legacy copy is
 * then removed as verified-equivalent); `failed` on any error or when both exist with DIFFERING
 * content (the minted-destination trap — the legacy file is left untouched and the family retries).
 */
export function moveFile(legacyFile: string, newFile: string, options: MoveFileOptions = {}): FamilyOutcome {
	if (!existsSync(legacyFile)) return "skipped";
	if (existsSync(newFile)) {
		// Both exist. Identical bytes → the destination is the migrated copy (verified-equivalent);
		// clear the legacy remainder. Differing bytes → a store minted the destination fresh while the
		// legacy data sits unmigrated: NEVER self-mark complete (QA Critical 2b).
		if (!filesByteIdentical(newFile, legacyFile)) return "failed";
		try {
			rmSync(legacyFile, { force: true });
		} catch {
			// non-fatal: the next boot retries the (idempotent) verified-equivalent removal.
		}
		return "migrated";
	}
	const tmp = tempBeside(newFile);
	try {
		mkdirSync(dirname(newFile), { recursive: true, mode: STATE_DIR_MODE });
		copyFileSync(legacyFile, tmp);
		if (options.fileMode !== undefined && process.platform !== "win32") chmodSync(tmp, options.fileMode);
		if (options.verifyBytes === true && !readFileSync(tmp).equals(readFileSync(legacyFile))) {
			// The copy did not reproduce the legacy bytes exactly: abort, keep the legacy authoritative.
			rmSync(tmp, { force: true });
			return "failed";
		}
		renameSync(tmp, newFile);
	} catch {
		rmSync(tmp, { force: true });
		return "failed";
	}
	// Best-effort remove of the legacy copy: the new file is now authoritative. A failed unlink leaves
	// a harmless legacy artifact (the window keeps reading new-first anyway), never a lost byte.
	try {
		rmSync(legacyFile, { force: true });
	} catch {
		// non-fatal
	}
	return "migrated";
}

/**
 * Recursively copy `legacyDir` to `newDir` (temp + atomic rename), then remove the legacy tree.
 * A partial copy is treated as failed (the temp is discarded, the legacy tree retained). When BOTH
 * trees exist the move reports `failed` (retryable, legacy retained): a lazily-created destination
 * tree must never flip the family complete while unmigrated legacy content remains (QA Critical 2b
 * applied to directories; content equivalence for trees is not cheaply verifiable, so the honest
 * answer is a retained-and-retryable failure that the legacy-fallback reads cover).
 */
export function moveDir(legacyDir: string, newDir: string): FamilyOutcome {
	if (!existsSync(legacyDir)) return "skipped";
	if (existsSync(newDir)) return "failed";
	const tmp = tempBeside(newDir);
	try {
		cpSync(legacyDir, tmp, { recursive: true });
		mkdirSync(dirname(newDir), { recursive: true, mode: STATE_DIR_MODE });
		renameSync(tmp, newDir);
	} catch {
		rmSync(tmp, { recursive: true, force: true });
		return "failed";
	}
	try {
		rmSync(legacyDir, { recursive: true, force: true });
	} catch {
		// non-fatal
	}
	return "migrated";
}

/** The telemetry SQLite sibling suffixes moved alongside the main db (best-effort; regenerable). */
const SQLITE_SIBLING_SUFFIXES = ["-wal", "-shm"] as const;

/**
 * Move a SQLite database file plus its WAL/SHM siblings. The main file drives the outcome; siblings
 * are best-effort (they regenerate). Callers run this only while no handle is held on the database
 * (the migration bootstrap runs before stores open; the store's own open-time retry runs before
 * `DatabaseSync` is constructed).
 */
export function moveSqliteWithSiblings(legacyMain: string, newMain: string): FamilyOutcome {
	const outcome = moveFile(legacyMain, newMain);
	if (outcome === "migrated") {
		for (const suffix of SQLITE_SIBLING_SUFFIXES) {
			// The siblings may or may not exist; moveFile skips a missing one. Ignore sibling failure.
			moveFile(`${legacyMain}${suffix}`, `${newMain}${suffix}`);
		}
	}
	return outcome;
}

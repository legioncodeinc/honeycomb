/**
 * Skillify watermark — PRD-016b Wave 1 (FULL), proving b-AC-2 / FR-8 / FR-9.
 *
 * After EVERY skillify run — KEEP, MERGE, or SKIP — the per-project watermark
 * advances to the date of the OLDEST mined session (NOT the newest). This is
 * deliberate (D-6 / FR-8):
 *
 *   - Advancing to the OLDEST means the next run RE-SEES the same batch. When nothing
 *     changed those re-seen sessions SKIP harmlessly; but a session that was MISSED
 *     last run (it predates a session the miner already saw, or arrived out of order)
 *     is now in-window and gets mined. Advancing to the newest would permanently skip
 *     any older straggler — the err-toward-re-seeing posture the user story asks for.
 *   - A SKIP still advances (FR-9): the watermark is about COVERAGE, not about whether
 *     a skill was written. The worker calls {@link advanceWatermark} after
 *     `writeSkill` returns, regardless of verdict.
 *
 * ── On-disk, per project (D-6) ──────────────────────────────────────────────
 * The watermark is a tiny JSON file under a per-project state dir
 * (`~/.honeycomb/state/skillify/<projectKey>/watermark.json` in production). The base
 * dir is INJECTABLE so a test points it at a temp dir — no real home writes. The
 * store is filesystem-only; it never touches DeepLake (the watermark is local
 * bookkeeping, not team-shared state).
 *
 * ── Monotonic-toward-oldest advance ─────────────────────────────────────────
 * "Advance to the oldest" is applied as: the new watermark is the MINIMUM of the
 * current watermark and the oldest mined session date. So a run can only ever move
 * the watermark EARLIER (or leave it), never later — guaranteeing no session is
 * skipped because a later run set a newer mark. A first run (no file yet) writes the
 * oldest mined date directly.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The default per-project state root in production (`~/.honeycomb/state/skillify`). */
export function defaultWatermarkBaseDir(): string {
	return join(homedir(), ".honeycomb", "state", "skillify");
}

/** A per-project watermark store — read + advance-to-oldest. Filesystem-only. */
export interface WatermarkStore {
	/** Read the current watermark ISO date for a project, or `null` when unset. */
	read(projectKey: string): string | null;
	/**
	 * Advance the watermark to the OLDEST mined session date (b-AC-2 / FR-8): the new
	 * value is `min(current, oldestMinedDate)`. Returns the value now persisted. A run
	 * with no mined sessions leaves the watermark unchanged (nothing to advance to).
	 */
	advance(projectKey: string, minedSessionDates: readonly string[]): string | null;
}

/** The shape persisted to `<baseDir>/<projectKey>/watermark.json`. */
interface WatermarkFile {
	/** The ISO date the watermark sits at. */
	readonly watermark: string;
	/** When this file was last written (diagnostic). */
	readonly updatedAt: string;
}

/**
 * Build a filesystem {@link WatermarkStore} rooted at `baseDir` (default
 * {@link defaultWatermarkBaseDir}). A test injects a temp dir. Each project gets its
 * own subdir + `watermark.json`; `projectKey` is sanitized into a single path
 * segment so it can never traverse out of the base dir.
 */
export function createWatermarkStore(baseDir: string = defaultWatermarkBaseDir()): WatermarkStore {
	const fileFor = (projectKey: string): string => join(baseDir, sanitizeSegment(projectKey), "watermark.json");

	const read = (projectKey: string): string | null => {
		try {
			const raw = readFileSync(fileFor(projectKey), "utf-8");
			const parsed = JSON.parse(raw) as Partial<WatermarkFile>;
			return typeof parsed.watermark === "string" && parsed.watermark !== "" ? parsed.watermark : null;
		} catch {
			return null;
		}
	};

	return {
		read,
		advance(projectKey: string, minedSessionDates: readonly string[]): string | null {
			const oldest = oldestDate(minedSessionDates);
			if (oldest === null) {
				// No mined sessions → nothing to advance to; leave the watermark as-is.
				return read(projectKey);
			}
			const current = read(projectKey);
			// Advance toward the OLDEST: the new mark is the minimum (earliest) of the
			// current mark and the oldest mined date — never moves later (b-AC-2 / FR-8).
			const next = current === null ? oldest : earlier(current, oldest);
			const file: WatermarkFile = { watermark: next, updatedAt: new Date().toISOString() };
			const path = fileFor(projectKey);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, JSON.stringify(file, null, 2), "utf-8");
			return next;
		},
	};
}

/** The earliest (smallest) of a list of ISO dates, or null when the list is empty. */
function oldestDate(dates: readonly string[]): string | null {
	let oldest: string | null = null;
	for (const d of dates) {
		if (d === "") continue;
		if (oldest === null || earlier(d, oldest) === d) oldest = d;
	}
	return oldest;
}

/**
 * The earlier of two ISO dates by timestamp. ISO-8601 also sorts lexically, but we
 * compare by parsed time so a mix of date-only + datetime strings orders correctly;
 * an unparseable value falls back to the lexical comparison so a malformed date never
 * crashes the advance.
 */
function earlier(a: string, b: string): string {
	const ta = Date.parse(a);
	const tb = Date.parse(b);
	if (Number.isFinite(ta) && Number.isFinite(tb)) return ta <= tb ? a : b;
	return a <= b ? a : b;
}

/**
 * Reduce a project key to a SINGLE safe path segment — only `[A-Za-z0-9._-]`, every
 * other char (including `/`, `\`, `..` separators) becomes `_`. So a crafted
 * projectKey can never traverse out of the watermark base dir (the watermark file is
 * local bookkeeping, but the sanitization keeps the write contained).
 */
function sanitizeSegment(projectKey: string): string {
	const cleaned = projectKey.replace(/[^A-Za-z0-9._-]/g, "_");
	return cleaned === "" ? "default" : cleaned;
}

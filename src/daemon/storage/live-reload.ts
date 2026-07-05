/**
 * mtime-gated live re-resolution of on-disk config — the daemon-side "pick up a
 * `honeycomb login` / `honeycomb project bind` WITHOUT a restart" primitive (PRD live-reload).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The daemon historically SNAPSHOTTED its tenancy (`~/.deeplake/credentials.json`) and its
 * storage-client config ONCE at boot and never re-read them. So a `login` (new org/workspace/
 * token) or a re-point written AFTER the daemon started was invisible to every subsequent
 * request until the operator restarted the daemon. This module is the seam that closes that:
 * a value derived from a file is cached ALONGSIDE that file's `mtimeMs`, and the cache is
 * re-derived only when the file's mtime changes.
 *
 * ── WHY mtime-gated re-read (not `fs.watch`) ─────────────────────────────────
 * `fs.watch` carries a lifecycle: a watcher handle must be created, held, and closed, and on
 * some platforms it leaks descriptors or fires spuriously. This daemon already prefers cheap
 * stat-gated reads over watchers for exactly that reason. An mtime `statSync` is a single
 * syscall; we further DEBOUNCE it (re-stat at most once per {@link DEFAULT_RESTAT_TTL_MS}) so a
 * burst of requests pays one stat, not one-per-request. The trade — a change is picked up on
 * the FIRST request after the debounce window rather than instantly — is exactly the
 * "subsequent requests" guarantee the goal asks for, with zero watcher handles.
 *
 * ── FAIL-SOFT ────────────────────────────────────────────────────────────────
 * A `statSync` that throws (the file was deleted, a transient FS hiccup) is treated as "no
 * change since last successful resolve": we KEEP the last cached value rather than tearing it
 * down. This mirrors the credential/cache readers, which never throw on a missing file — a
 * signed-out state is reached by the loader returning "empty", not by this stat throwing.
 */

import { statSync } from "node:fs";

/**
 * The debounce window: a source file is re-`stat`ed at most once per this many ms. A burst of
 * requests inside the window reuses the last cached value + mtime with NO syscall; the first
 * request AFTER the window re-stats and, if the mtime moved, re-derives. Short enough that a
 * `login`/`bind` is honored within a second, long enough that a hot request path is not a
 * stat storm.
 */
export const DEFAULT_RESTAT_TTL_MS = 1_000 as const;

/** The injectable clock (tests advance it deterministically instead of sleeping). */
export type NowFn = () => number;

/**
 * The mtime source seam. Production stats the file path; a test injects a fake that returns a
 * controllable mtime (or `null` for "absent"), so the debounce + change detection are proven
 * WITHOUT touching a real file or sleeping. Returns `null` when the file is absent/unreadable
 * (fail-soft — the caller keeps its last value).
 */
export type MtimeReader = () => number | null;

/** Stat a real file path for its `mtimeMs`, returning `null` on any error (fail-soft). */
export function fileMtimeReader(path: string): MtimeReader {
	return (): number | null => {
		try {
			return statSync(path).mtimeMs;
		} catch {
			// Missing/unreadable file → "no observable mtime". The caller keeps its last value;
			// a genuine sign-out is surfaced by the loader returning empty, not by a throw here.
			return null;
		}
	};
}

/** Options for {@link createMtimeGatedResolver} (all optional; injectable for tests). */
export interface MtimeGatedResolverOptions {
	/** Re-stat at most once per this many ms (debounce). Defaults to {@link DEFAULT_RESTAT_TTL_MS}. */
	readonly ttlMs?: number;
	/** Injectable clock (tests). Defaults to `Date.now`. */
	readonly now?: NowFn;
}

/**
 * Build a function that returns a value derived from a file, re-deriving it ONLY when the
 * file's mtime changes (debounced by `ttlMs`). The generic seam under both the tenancy
 * re-resolve and the storage-client config re-resolve.
 *
 *   - `readMtime` yields the source file's current `mtimeMs` (or `null` when absent).
 *   - `derive` computes the cached value from scratch (e.g. `provider.read()` → scope). It is
 *     called on the FIRST access and on every subsequent access where the mtime has changed.
 *
 * The very first call always derives (there is no prior value). Thereafter, within a `ttlMs`
 * window the last value is returned with no stat; after the window a stat runs and the value
 * is re-derived iff the mtime differs from the one captured at the last derive. An absent file
 * (`null` mtime) after a successful derive KEEPS the last value (fail-soft): a change is only
 * acted on when a DIFFERENT concrete mtime is observed.
 */
export function createMtimeGatedResolver<T>(
	readMtime: MtimeReader,
	derive: () => T,
	options: MtimeGatedResolverOptions = {},
): () => T {
	const ttlMs = options.ttlMs ?? DEFAULT_RESTAT_TTL_MS;
	const now = options.now ?? ((): number => Date.now());

	let cached: T;
	let hasCached = false;
	// The mtime captured at the last successful derive; `null` until the first derive.
	let derivedMtime: number | null = null;
	// The last wall-clock time we re-stat'ed (for the debounce). `-Infinity` forces a first stat.
	let lastStatAt = Number.NEGATIVE_INFINITY;

	return (): T => {
		if (!hasCached) {
			// First access: derive unconditionally and record the mtime we derived at.
			derivedMtime = readMtime();
			cached = derive();
			hasCached = true;
			lastStatAt = now();
			return cached;
		}

		const t = now();
		if (t - lastStatAt < ttlMs) {
			// Inside the debounce window → reuse the last value with no syscall.
			return cached;
		}
		lastStatAt = t;

		const currentMtime = readMtime();
		// Fail-soft: an absent/unreadable file keeps the last value. Only a concrete mtime that
		// DIFFERS from the one we derived at triggers a re-derive.
		if (currentMtime !== null && currentMtime !== derivedMtime) {
			derivedMtime = currentMtime;
			cached = derive();
		}
		return cached;
	};
}

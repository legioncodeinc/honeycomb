/**
 * Content-addressed per-file extraction cache — PRD-014a Wave 1 (a-AC-2 / a-AC-5 /
 * FR-8..FR-12). Turns a full rebuild into tens of milliseconds when only a few files
 * changed: an unchanged file's prior {@link FileExtraction} is REUSED by its content
 * sha256, never re-parsed.
 *
 * ── The two load-bearing behaviors ──────────────────────────────────────────
 *   1. CONTENT-ADDRESSED (a-AC-2 / FR-8/FR-9/FR-12). Each entry is keyed by the file's
 *      content sha256, stored at `<baseDir>/.cache/<sha256>.json`. Invalidation is
 *      AUTOMATIC: edit the file → new content → new sha → cache miss → re-extract.
 *      Identical content across files / branches / users shares ONE entry (FR-12).
 *   2. RENAME / COPY REWRITE (a-AC-2 / FR-10). A renamed or copied file has the SAME
 *      content (same sha) at a NEW path. On a cache hit `readCache` does NOT re-parse;
 *      it REWRITES every `source_file`, every edge-id `<source_file>::` prefix, every
 *      symbol-id `<source_file>#` prefix, and every `external:` module label that
 *      named the OLD path, to the caller's CURRENT path — so a reused entry never
 *      leaks the original path into the graph.
 *
 * ── Schema versioning (a-AC-5 / FR-9) ───────────────────────────────────────
 * Every entry embeds {@link CACHE_SCHEMA_VERSION}. Bumping it (an extractor-output
 * change — a new field, a different edge shape) invalidates EVERY old entry wholesale:
 * a stored entry whose version differs is ignored and the file is re-extracted. This
 * is the escape hatch for "the content is unchanged but the extractor now emits more".
 *
 * ── Corruption (FR-11) ──────────────────────────────────────────────────────
 * A corrupt entry (bad JSON, missing fields, wrong sha) FAILS validation and falls
 * through to a fresh extraction that overwrites it — a poisoned cache file never
 * crashes the build.
 *
 * On-disk under `<baseDir>/.cache/` where `baseDir` is `~/.honeycomb/graphs/<repo-key>/`
 * in production and an injected temp dir in tests (FR-8). This module does ONLY local
 * file I/O — no DeepLake, no parsing.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type FileExtraction, type GraphEdge, type GraphNode, isExternalTarget } from "./contracts.js";

/**
 * The cache schema version (a-AC-5 / FR-9). BUMP THIS whenever the extractor output
 * shape changes (a new node/edge field, a different id scheme, a new
 * `tsCrossFileInputs` shape) so byte-identical content is re-extracted against the new
 * shape. An entry stored under a different version is ignored wholesale.
 *
 * History:
 *   1 — initial Wave-1 shape (file/symbol nodes; call/import/heritage edges;
 *       ts cross-file inputs; `external:` placeholder targets).
 */
export const CACHE_SCHEMA_VERSION = 1 as const;

/**
 * Age ceiling for a content-addressed entry (the unbounded-growth guard). Entries are
 * legitimately reused far into the future (a revert, a long-lived branch), so — unlike
 * `snapshots/` — this cache cannot simply keep "only the latest". But with zero eviction
 * at all, `.cache/` grows one file per UNIQUE file content EVER SEEN across the repo's
 * entire history, forever, on an hourly rebuild timer — confirmed accumulating unboundedly
 * on an actively-developed repo (the real cause behind reports of `~/.honeycomb/graphs/`
 * growing massive). 90 days is long enough that a genuine revert still gets a cache hit in
 * the overwhelming common case, while bounding steady-state size; a swept entry is not
 * data loss — a miss just re-extracts the file (FR-11 territory: this cache is always a
 * pure performance optimization, never a source of truth).
 */
const MAX_ENTRY_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** The on-disk cache entry envelope. The `extraction` is the cached {@link FileExtraction}. */
interface CacheEntry {
	/** The schema version this entry was written under (a-AC-5). */
	readonly schemaVersion: number;
	/** The content sha256 — MUST equal the entry's filename and the extraction's hash. */
	readonly contentSha256: string;
	/** The cached extraction (its `sourceFile` is the path it was ORIGINALLY extracted at). */
	readonly extraction: FileExtraction;
}

/**
 * A content-addressed extraction cache rooted at a base directory. Construct with the
 * repo's `baseDir` (`~/.honeycomb/graphs/<repo-key>/` in production; a temp dir in
 * tests). The cache directory is created lazily on first write.
 */
export class ExtractionCache {
	private readonly cacheDir: string;

	constructor(baseDir: string) {
		this.cacheDir = join(baseDir, ".cache");
		// Best-effort, once per build (the hourly rebuild timer bounds frequency) — see
		// MAX_ENTRY_AGE_MS for why this exists at all.
		this.sweepStaleEntries();
	}

	/**
	 * Evict entries untouched (by mtime) for longer than {@link MAX_ENTRY_AGE_MS} — the
	 * unbounded-growth guard. A no-op when the cache dir does not exist yet (a fresh repo).
	 * Never throws: a permissions hiccup or a concurrent writer just means this sweep skips
	 * that entry, tried again on the next build.
	 */
	private sweepStaleEntries(): void {
		let entries: string[];
		try {
			entries = readdirSync(this.cacheDir);
		} catch {
			return; // Cache dir does not exist yet — nothing to sweep.
		}
		const cutoff = Date.now() - MAX_ENTRY_AGE_MS;
		for (const name of entries) {
			if (!name.endsWith(".json")) continue;
			const full = join(this.cacheDir, name);
			try {
				if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
			} catch {
				// Best-effort — a concurrent writer or an already-gone file is fine.
			}
		}
	}

	/** The on-disk path for a content sha (`<cacheDir>/<sha>.json`). */
	private pathFor(contentSha256: string): string {
		return join(this.cacheDir, `${contentSha256}.json`);
	}

	/**
	 * Look up a cached extraction by content sha for a file at `currentPath` (a-AC-2).
	 * Returns the cached extraction REWRITTEN to `currentPath` on a hit, or `null` on a
	 * miss / version mismatch / corruption (the caller then extracts fresh).
	 *
	 * The rewrite is the rename/copy guarantee (FR-10): even on an EXACT-path hit it is
	 * a no-op rewrite (the path already matches), and on a renamed/copied file it
	 * repoints every embedded path to `currentPath` WITHOUT re-parsing.
	 */
	read(contentSha256: string, currentPath: string): FileExtraction | null {
		const path = this.pathFor(contentSha256);
		if (!existsSync(path)) return null;

		let entry: CacheEntry;
		try {
			entry = JSON.parse(readFileSync(path, "utf8")) as CacheEntry;
		} catch {
			// Corrupt JSON — treat as a miss; a fresh extraction overwrites it (FR-11).
			return null;
		}

		// Version bump invalidates wholesale (a-AC-5).
		if (entry.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
		// Integrity: the entry's sha must match the key it was stored under (FR-11).
		if (entry.contentSha256 !== contentSha256) return null;
		if (!isWellFormed(entry.extraction)) return null;

		// A live hit resets the age clock (best-effort) — an entry still in active rotation
		// (e.g. a file that toggles between two known contents across branches) must never
		// be swept out from under a build just because it was FIRST written 90+ days ago.
		try {
			const now = new Date();
			utimesSync(path, now, now);
		} catch {
			// Best-effort — a read-only filesystem or a race with a sweep is fine either way.
		}

		return rewritePath(entry.extraction, currentPath);
	}

	/**
	 * Store an extraction keyed by its content sha (FR-12). The entry records the path
	 * the extraction was produced at; a later hit at a DIFFERENT path rewrites it on
	 * read. Identical content from two paths writes the SAME file (idempotent — the
	 * second write overwrites with equivalent bytes for the same sha).
	 */
	write(extraction: FileExtraction): void {
		if (!existsSync(this.cacheDir)) {
			mkdirSync(this.cacheDir, { recursive: true });
		}
		const entry: CacheEntry = {
			schemaVersion: CACHE_SCHEMA_VERSION,
			contentSha256: extraction.contentSha256,
			extraction,
		};
		writeFileSync(this.pathFor(extraction.contentSha256), JSON.stringify(entry), "utf8");
	}
}

/** A cached extraction is well-formed when it carries the fields the rewrite depends on. */
function isWellFormed(extraction: unknown): extraction is FileExtraction {
	if (typeof extraction !== "object" || extraction === null) return false;
	const e = extraction as Partial<FileExtraction>;
	return (
		typeof e.sourceFile === "string" &&
		typeof e.language === "string" &&
		Array.isArray(e.nodes) &&
		Array.isArray(e.edges) &&
		Array.isArray(e.parseErrors) &&
		typeof e.contentSha256 === "string"
	);
}

/**
 * Rewrite a cached extraction from its stored `sourceFile` to `currentPath` (FR-10 /
 * a-AC-2). This is the rename/copy core: a pure string repoint of every embedded path
 * so a reused entry presents as if it had been extracted at the current path.
 *
 * Rewrites:
 *   - the extraction's `sourceFile`;
 *   - every node's `sourceFile`, and the file-node `name` (basename) + id prefix;
 *   - every node `id` that begins with `<old>` (the file node id IS `<old>`; a symbol
 *     id is `<old>#name`);
 *   - every edge `id` `<old>::…` prefix and the edge `src`/`dst` when they reference a
 *     node id under `<old>` (a same-file `src`/`dst`; an `external:` target is NOT a
 *     path, so it is left untouched — module-label rewrites apply only to targets that
 *     embedded the old PATH, which per-file `external:` specifiers do not).
 *
 * The old→new substitution is anchored (prefix match on the exact old path) so it never
 * corrupts an unrelated path that merely contains the old one as a substring.
 */
function rewritePath(extraction: FileExtraction, currentPath: string): FileExtraction {
	const oldPath = extraction.sourceFile;
	if (oldPath === currentPath) return extraction; // exact hit — no rewrite needed.

	const remapId = (id: string): string => {
		if (id === oldPath) return currentPath; // the file node id
		if (id.startsWith(`${oldPath}#`)) return `${currentPath}${id.slice(oldPath.length)}`; // a symbol id
		return id;
	};

	const nodes: GraphNode[] = extraction.nodes.map((n) => ({
		...n,
		id: remapId(n.id),
		sourceFile: currentPath,
		// The file node's name is the basename; a symbol keeps its name.
		name: n.kind === "file" ? baseName(currentPath) : n.name,
	}));

	const edges: GraphEdge[] = extraction.edges.map((e) => {
		const newSrc = remapId(e.src);
		const newDst = isExternalTarget(e.dst) ? e.dst : remapId(e.dst);
		// The edge id carries the `<old>::relation::src->dst[:ord]` shape; rebuild its
		// prefix + endpoints so the whole id reflects the current path.
		const rebuiltId = e.id.startsWith(`${oldPath}::`)
			? `${currentPath}${e.id.slice(oldPath.length)}`
					.replace(`->${e.dst}`, `->${newDst}`)
					.replace(`::${e.src}->`, `::${newSrc}->`)
			: e.id;
		return { ...e, id: rebuiltId, src: newSrc, dst: newDst };
	});

	return {
		...extraction,
		sourceFile: currentPath,
		nodes,
		edges,
	};
}

/** The basename of a forward-slash-normalized path. */
function baseName(p: string): string {
	const norm = p.replace(/\\/g, "/");
	const i = norm.lastIndexOf("/");
	return i < 0 ? norm : norm.slice(i + 1);
}

/**
 * Wiki synthesis — PRD-017b (Wave 2, FULL), proving b-AC-1..6.
 *
 * 017b CONSUMES 017a's per-session summaries (the `memory` rows at
 * `/summaries/<userName>/<sessionId>.md` the {@link runSummaryWorker} wrote) and
 * synthesizes the team-facing wiki on top of them:
 *
 *   - b-AC-1 a top-level `MEMORY.md` under the memory path LINKING the relevant
 *     per-session summaries (one row in the `memory` table at the `MEMORY.md` path,
 *     written SELECT-before-INSERT — never an in-place UPDATE, b-AC-4).
 *   - b-AC-2 per-thread THREAD HEADS: a session resumed across `--resume`/`--continue`
 *     produces ONE thread-head reflecting the MERGED session, no duplicate entry
 *     (de-duped by the stable thread/session LINEAGE key — see {@link threadKeyOf}).
 *   - b-AC-3 every read + write goes THROUGH the daemon's `StorageQuery` (the same
 *     daemon-side seam `worker.ts` uses) — never a re-opened DeepLake connection. This
 *     module lives under `src/daemon/`, so "through the daemon" means it reaches the
 *     `memory` table through the storage path the daemon ALREADY holds.
 *   - b-AC-4 a re-synthesis over an existing `MEMORY.md` / thread-head row is a
 *     SELECT-before-INSERT keyed on `path` (insert iff no REAL row already landed),
 *     NEVER an in-place UPDATE — mirroring `worker.ts`'s placeholder-aware probe.
 *   - b-AC-5 a `MEMORY.md` link TARGET is the per-session summary's own
 *     `/summaries/<userName>/<sessionId>.md` path — a `memory`-table path the PRD-015
 *     VFS read precedence resolves to the summary body (its tier-6 direct read).
 *   - b-AC-6 each `MEMORY.md` is TENANT-SCOPED: the summary read carries the run's
 *     `{ org, workspace }` scope, so two tenants synthesize two DISJOINT indexes
 *     (no cross-org summary ever links into another tenant's MEMORY.md).
 *
 * ── Daemon-only storage (CONVENTIONS §2 / b-AC-3 / FR-1 / FR-6) ───────────────
 * Every read and write routes through the daemon-side {@link SynthesisStore} over the
 * daemon's `StorageQuery`. The worker NEVER re-opens DeepLake. `resolveTable` maps the
 * canonical `memory` name to the PHYSICAL table (identity in production; a live itest
 * injects a per-run prefix so it reads/writes a throwaway table NATIVELY — the proven
 * `createSummaryStore` / `SourceArtifactStore` isolation technique).
 *
 * ── SELECT-before-INSERT, never UPDATE (CONVENTIONS §3 / b-AC-4) ──────────────
 * The `MEMORY.md` + thread-head writes are SELECT-before-INSERT keyed on `path`. The
 * DeepLake backend coalesces a rapid in-place UPDATE against a freshly-written row and
 * silently drops one, so an in-place `SET` can never converge. Re-synthesis writes a
 * FRESH index/head row (the existence probe EXCLUDES the in-progress placeholder marker,
 * exactly as `worker.ts`'s `writeSummary` does, so a stranded placeholder can never
 * block the real write). {@link SynthesisStore} has NO `update` method by construction.
 *
 * ── SQL safety (CONVENTIONS §4 / FR-5) ───────────────────────────────────────
 * Every identifier routes through `sqlIdent`; every value through the `val.*`
 * constructors (→ `sLiteral`/`eLiteral`) or `sLiteral` directly for read predicates.
 * `npm run audit:sql` scans `src/daemon`.
 */

import { healTargetFor } from "../../storage/catalog/index.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { type HealTarget, withHeal } from "../../storage/heal.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { appendVersionBumped, buildInsert, val, type RowValues } from "../../storage/writes.js";

import {
	IN_PROGRESS_MARKER,
	MEMORY_TABLE,
	SUMMARY_PATH_PREFIX,
} from "./worker.js";

// ════════════════════════════════════════════════════════════════════════════
// Constants — the synthesized paths + the thread-head path convention.
// ════════════════════════════════════════════════════════════════════════════

/** The canonical top-level index path (a `memory` row) the synthesis writes (b-AC-1 / D-7). */
export const MEMORY_INDEX_PATH = "/MEMORY.md" as const;
/** The root prefix the per-thread head rows live under (b-AC-2 / D-8 / FR-3). */
export const THREAD_HEAD_PATH_PREFIX = "/threads/" as const;
/** Max chars of the `description` excerpt stored on a synthesized row (mirrors the worker). */
export const SYNTHESIS_DESCRIPTION_CHARS = 280;

/**
 * Poll budget for resolving the index/head row's current (highest-`version`) row
 * (PRD-046b b-AC-1). Mirrors `dreaming/trigger.ts`'s `RESOLVE_POLLS`: a single by-path
 * read can land on a stale segment and under-report the version; because versions are
 * append-only and monotone, the MAX across a few polls converges UP to the truth. The
 * deterministic fake settles on the first read, so this is a live-only cost.
 */
export const SYNTHESIS_RESOLVE_POLLS = 8;

// ════════════════════════════════════════════════════════════════════════════
// SummaryRecord — one per-session summary row the synthesis reads + links.
// ════════════════════════════════════════════════════════════════════════════

/**
 * One per-session summary the synthesis consumes (b-AC-1). A projection of a
 * `memory` row 017a wrote at `/summaries/<userName>/<sessionId>.md`: the `path` (the
 * link TARGET, b-AC-5), a `title`/`description` for the link text, and the `agent`
 * the summary was authored under. The synthesis NEVER mutates these rows.
 */
export interface SummaryRecord {
	/** The summary's canonical `/summaries/<userName>/<sessionId>.md` path (the link target). */
	readonly path: string;
	/** A short description/excerpt for the link text (the worker wrote it into `description`). */
	readonly description: string;
	/** The author/agent the summary was written under (carried for the thread head). */
	readonly author: string;
}

// ════════════════════════════════════════════════════════════════════════════
// SynthesisStore SEAM — the daemon's `memory` read + SELECT-before-INSERT write.
// ════════════════════════════════════════════════════════════════════════════

/**
 * The daemon-side `memory` storage seam the synthesis runs on (b-AC-1 / b-AC-3 /
 * b-AC-4 / b-AC-6 / FR-1 / FR-6). The synthesis runs INSIDE the daemon, so "through
 * the daemon, not a direct DeepLake connection" means it reads/writes through the
 * storage path the daemon ALREADY holds — never a re-opened client.
 * {@link createSynthesisStore} (below) builds the real store over the daemon-side
 * `StorageQuery`; a unit test injects a fake recording store so it can assert the
 * write was a SELECT-before-INSERT keyed on `path` and that NO in-place UPDATE was
 * ever emitted (b-AC-4).
 *
 * There is NO `update` method by construction — the store CANNOT mutate a row in
 * place. {@link writeRow} is SELECT-before-INSERT (insert iff no REAL row at the path).
 */
export interface SynthesisStore {
	/**
	 * Read the per-session summary rows for the run's tenant scope (b-AC-1 / b-AC-6).
	 * SELECTs every `memory` row whose `path` is under `/summaries/` and is NOT the
	 * in-progress placeholder, ordered by path for a deterministic index render. The
	 * tenant scope is carried on the dispatch, so the read returns ONLY this tenant's
	 * summaries — two tenants → two disjoint sets.
	 */
	readSummaries(): Promise<readonly SummaryRecord[]>;
	/**
	 * Write a synthesized row (the `MEMORY.md` index or a thread head) via
	 * SELECT-before-INSERT keyed on `path` (b-AC-1 / b-AC-2 / b-AC-4). Insert iff no
	 * REAL (non-placeholder) row already landed at the path. NEVER an in-place UPDATE.
	 * Returns whether this call wrote a fresh row.
	 */
	writeRow(row: SynthesizedRow): Promise<SynthesisWriteOutcome>;
	/**
	 * REFRESH a synthesized row by APPENDING it at the next `version` (PRD-046b b-AC-1).
	 *
	 * The 017b `writeRow` is write-once (SELECT-before-INSERT) so a re-synthesis after
	 * new summaries land is a NO-OP — the documented `/MEMORY.md` refresh limitation.
	 * This replaces that with the VERSION-BUMP discipline `ontology/supersede.ts` /
	 * `dreaming/trigger.ts` use: read the current MAX(`version`) for the path, INSERT a
	 * FRESH row at version N+1 carrying the re-rendered body. The current index is the
	 * HIGHEST-version row (read by {@link readLatestVersionedRow}), so the index
	 * REFRESHES as summaries land — and there is ZERO in-place UPDATE (the DeepLake
	 * backend coalesces rapid by-key UPDATEs and never converges live). Returns the
	 * version the refreshed row was written at.
	 */
	refreshRow(row: SynthesizedRow): Promise<SynthesisRefreshOutcome>;
	/**
	 * Read the CURRENT (highest-`version`) synthesized row at `path` (PRD-046b b-AC-1).
	 * The reader convention paired with {@link refreshRow}: a re-synthesis appends a
	 * higher version, so the current index/head is `ORDER BY version DESC LIMIT 1`.
	 * Poll-convergent against the backend's segment-freshness flap. Returns `null` when
	 * no row has landed yet.
	 */
	readLatestVersionedRow(path: string): Promise<VersionedSynthesizedRow | null>;
}

/** One synthesized `memory` row the store writes (b-AC-1 / b-AC-2). */
export interface SynthesizedRow {
	/** The row identity key — `/MEMORY.md` or `/threads/<threadKey>.md`. */
	readonly path: string;
	/** The rendered markdown body (→ `summary`). */
	readonly summary: string;
	/** A short excerpt for listings (→ `description`). */
	readonly description: string;
	/** The author/agent the synthesis is attributed to (→ `author`/`agent`). */
	readonly author: string;
}

/** The outcome of a {@link SynthesisStore.writeRow} call, for the synthesis audit. */
export interface SynthesisWriteOutcome {
	/** True when this call inserted a fresh row; false when a real row already existed. */
	readonly written: boolean;
}

/** The outcome of a {@link SynthesisStore.refreshRow} call (PRD-046b b-AC-1). */
export interface SynthesisRefreshOutcome {
	/** The `version` the refreshed row was appended at (N+1 over the prior highest). */
	readonly version: number;
}

/** A synthesized row read back at its resolved `version` (PRD-046b b-AC-1). */
export interface VersionedSynthesizedRow {
	/** The row identity key — `/MEMORY.md` or `/threads/<threadKey>.md`. */
	readonly path: string;
	/** The rendered markdown body (← `summary`). */
	readonly summary: string;
	/** The highest version observed for the path (0 when no row exists yet). */
	readonly version: number;
}

/** ISO timestamp for `creation_date` / `last_update_date`. */
function nowIso(): string {
	return new Date().toISOString();
}

/** The trailing `<name>.md` filename of a path (the `filename` column). */
function filenameOf(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * Build the production {@link SynthesisStore} over the daemon's `StorageQuery`
 * (b-AC-1 / b-AC-3 / b-AC-4 / b-AC-6 / FR-1 / FR-6). The write is SELECT-before-INSERT
 * keyed on `path` — never an in-place UPDATE. There is NO `update` method.
 *
 * `resolveTable` maps the canonical `memory` name to the PHYSICAL table. Identity in
 * production. A live itest injects a per-run prefix so it reads/writes a real throwaway
 * table NATIVELY (the heal CREATEs the physical name) instead of rewriting SQL strings
 * after the fact — the proven `createSummaryStore` / `SourceArtifactStore` isolation
 * technique, copied verbatim.
 */
export function createSynthesisStore(
	storage: StorageQuery,
	scope: QueryScope,
	resolveTable: (canonical: string) => string = (t) => t,
): SynthesisStore {
	const physical = (): string => resolveTable(MEMORY_TABLE);

	const target = (): HealTarget => {
		const canonical = healTargetFor(MEMORY_TABLE);
		const phys = physical();
		return phys === MEMORY_TABLE ? canonical : { ...canonical, table: phys };
	};

	/** Build the `RowValues` for a synthesized `memory` row (no embedding — index rows are link tables). */
	const rowValuesFor = (row: SynthesizedRow): RowValues => {
		const now = nowIso();
		return [
			["path", val.str(row.path)],
			["filename", val.str(filenameOf(row.path))],
			["summary", val.text(row.summary)],
			// The synthesized index/head is a link document, not an embedded summary —
			// `summary_embedding` stays NULL (recall ranks the per-session summaries, the
			// MEMORY.md is a navigation surface). `val.raw("NULL")` is the trusted literal.
			["summary_embedding", val.raw("NULL")],
			["author", val.str(row.author)],
			["agent", val.str(row.author)],
			["description", val.text(row.description)],
			["creation_date", val.str(now)],
			["last_update_date", val.str(now)],
		];
	};

	return {
		async readSummaries(): Promise<readonly SummaryRecord[]> {
			// Tenant-scoped read (b-AC-6): the `scope` carries org/workspace on the dispatch,
			// so this returns ONLY this tenant's summaries. The `/summaries/` prefix match
			// uses a LIKE on the escaped prefix; the in-progress placeholder is EXCLUDED so a
			// half-written summary never becomes a link. Ordered by path for determinism.
			const tbl = sqlIdent(physical());
			const pathCol = sqlIdent("path");
			const descCol = sqlIdent("description");
			const authorCol = sqlIdent("author");
			// The prefix is a fixed, identifier-safe literal (`/summaries/`), matched with a
			// trailing wildcard. It carries no user input, so a plain `LIKE '<prefix>%'` on the
			// `sLiteral`-escaped prefix is safe and audit-clean.
			const prefixLike = `${sLiteral(SUMMARY_PATH_PREFIX)} || '%'`;
			const sql =
				`SELECT ${pathCol}, ${descCol}, ${authorCol} FROM "${tbl}" ` +
				`WHERE ${pathCol} LIKE ${prefixLike} ` +
				`AND ${descCol} != ${sLiteral(IN_PROGRESS_MARKER)} ` +
				`ORDER BY ${pathCol} ASC`;
			const res = await withHeal(storage, target(), scope, () => storage.query(sql, scope));
			if (!isOk(res)) return [];
			return (res.rows as StorageRow[]).map(rowToSummaryRecord);
		},

		async writeRow(row: SynthesizedRow): Promise<SynthesisWriteOutcome> {
			// SELECT-before-INSERT keyed on `path` (b-AC-1 / b-AC-2 / b-AC-4): insert iff no
			// REAL synthesized row already landed at the path, NEVER an in-place UPDATE.
			//
			// The existence probe EXCLUDES any in-progress placeholder (description = the
			// marker) — mirroring `worker.ts`'s placeholder-aware probe — so a stranded
			// placeholder at the index/head path can never report `alreadyPresent` and
			// silently drop the real synthesized row.
			const tbl = sqlIdent(physical());
			const pathCol = sqlIdent("path");
			const descCol = sqlIdent("description");
			const probeSql =
				`SELECT ${pathCol} FROM "${tbl}" ` +
				`WHERE ${pathCol} = ${sLiteral(row.path)} ` +
				`AND ${descCol} != ${sLiteral(IN_PROGRESS_MARKER)} LIMIT 1`;
			const probe = await withHeal(storage, target(), scope, () => storage.query(probeSql, scope));
			if (isOk(probe) && probe.rows.length > 0) {
				// A real synthesized row already landed → exactly-once; never re-write, never UPDATE.
				return { written: false };
			}
			const insertSql = buildInsert(physical(), rowValuesFor(row));
			const inserted = await withHeal(storage, target(), scope, () => storage.query(insertSql, scope));
			// `written` reflects the ACTUAL INSERT result — returning `true` unconditionally
			// would mask a failed INSERT (e.g. a missing column) as success (the worker lesson).
			return { written: isOk(inserted) };
		},

		async refreshRow(row: SynthesizedRow): Promise<SynthesisRefreshOutcome> {
			// PRD-046b b-AC-1: REFRESH by APPENDING at version N+1 (never an in-place UPDATE).
			// `appendVersionBumped` reads the current MAX(version) for the path key and INSERTs
			// a FRESH row at N+1, so a re-synthesis after new summaries land lands a HIGHER
			// version that the highest-version read resolves as current — the index refreshes
			// instead of being a write-once no-op. Heal-aware (a missing `version`/`key` column
			// is ALTERed in on first write; the column-add is additive, NOT NULL DEFAULT).
			//
			// The per-version row carries the SAME columns the SBI row does (path/filename/
			// summary/NULL embedding/author/agent/description), MINUS the version column which
			// `appendVersionBumped` appends. The `keyColumn` is `path` so the version chain is
			// keyed on the index/head identity.
			const baseRow = rowValuesFor(row).filter(([name]) => name !== "version");
			const { version } = await appendVersionBumped(storage, target(), scope, {
				keyColumn: "path",
				keyValue: row.path,
				row: baseRow,
			});
			return { version };
		},

		async readLatestVersionedRow(path: string): Promise<VersionedSynthesizedRow | null> {
			// PRD-046b b-AC-1: the current index/head is the HIGHEST-version row at the path.
			// Poll-convergent against the backend's segment-freshness flap — a single read can
			// under-report the version, but versions are append-only + monotone so the MAX
			// across a few polls converges UP. The deterministic fake settles on the first read.
			const tbl = sqlIdent(physical());
			const pathCol = sqlIdent("path");
			const summaryCol = sqlIdent("summary");
			const versionCol = sqlIdent("version");
			const sql =
				`SELECT ${pathCol}, ${summaryCol}, ${versionCol} FROM "${tbl}" ` +
				`WHERE ${pathCol} = ${sLiteral(path)} ` +
				`ORDER BY ${versionCol} DESC LIMIT 1`;
			let best: VersionedSynthesizedRow | null = null;
			for (let poll = 0; poll < SYNTHESIS_RESOLVE_POLLS; poll++) {
				const res = await withHeal(storage, target(), scope, () => storage.query(sql, scope));
				if (isOk(res) && res.rows.length > 0) {
					const r = res.rows[0] as StorageRow;
					const rawV = r.version;
					const v = typeof rawV === "number" ? rawV : Number(rawV);
					const version = Number.isFinite(v) ? v : 0;
					if (best === null || version > best.version) {
						best = {
							path: typeof r.path === "string" ? r.path : path,
							summary: typeof r.summary === "string" ? r.summary : "",
							version,
						};
					}
				}
			}
			return best;
		},
	};
}

/** Project a `memory` row into a {@link SummaryRecord}. */
function rowToSummaryRecord(row: StorageRow): SummaryRecord {
	const str = (k: string): string => (typeof row[k] === "string" ? (row[k] as string) : "");
	return { path: str("path"), description: str("description"), author: str("author") };
}

// ════════════════════════════════════════════════════════════════════════════
// Thread-head lineage — the stable merge key (b-AC-2 / D-8 / FR-4).
// ════════════════════════════════════════════════════════════════════════════

/**
 * Derive the stable THREAD/SESSION LINEAGE key a summary belongs to (b-AC-2 / D-8 /
 * FR-4). A session resumed across `--resume`/`--continue` keeps the SAME logical
 * session id; 017a writes its summary at `/summaries/<userName>/<sessionId>.md`. The
 * lineage key is `<userName>/<sessionId>` — the per-session identity, INVARIANT under
 * a resume. So every summary for the same resumed session maps to ONE thread key, and
 * the thread head is written once per key → a resume MERGES into the existing head, it
 * never duplicates an entry.
 *
 * Derived purely from the summary path (`/summaries/<userName>/<sessionId>.md` →
 * `<userName>/<sessionId>`), so it is deterministic and reproducible in tests. A path
 * that does not match the convention falls back to its trailing filename (no `.md`),
 * so an off-convention row still maps to a stable, single key.
 */
export function threadKeyOf(summaryPath: string): string {
	if (summaryPath.startsWith(SUMMARY_PATH_PREFIX)) {
		const rest = summaryPath.slice(SUMMARY_PATH_PREFIX.length);
		const withoutMd = rest.endsWith(".md") ? rest.slice(0, -".md".length) : rest;
		if (withoutMd !== "") return withoutMd;
	}
	const file = filenameOf(summaryPath);
	return file.endsWith(".md") ? file.slice(0, -".md".length) : file;
}

/** Reduce a thread key to a SINGLE safe path segment — only `[A-Za-z0-9._/-]`, else `_`. */
function sanitizeThreadKey(key: string): string {
	// Slashes are allowed (the key is `<userName>/<sessionId>`); other unsafe chars map to `_`.
	const cleaned = key.replace(/[^A-Za-z0-9._/-]/g, "_").replace(/^\/+|\/+$/g, "");
	return cleaned === "" ? "unknown" : cleaned;
}

/** The canonical `memory` path a thread head persists at: `/threads/<threadKey>.md`. */
export function threadHeadPath(threadKey: string): string {
	return `${THREAD_HEAD_PATH_PREFIX}${sanitizeThreadKey(threadKey)}.md`;
}

// ════════════════════════════════════════════════════════════════════════════
// Render helpers — the MEMORY.md link table + the thread-head body (b-AC-1 / b-AC-5).
// ════════════════════════════════════════════════════════════════════════════

/** A short single-line excerpt for the `description` column of a synthesized row. */
function excerpt(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length <= SYNTHESIS_DESCRIPTION_CHARS
		? oneLine
		: `${oneLine.slice(0, SYNTHESIS_DESCRIPTION_CHARS)}…`;
}

/** The link TEXT for a summary in the index — its description, or its path when blank. */
function linkText(record: SummaryRecord): string {
	const desc = record.description.replace(/\s+/g, " ").trim();
	return desc === "" ? record.path : desc;
}

/**
 * Render the `MEMORY.md` markdown body (b-AC-1 / b-AC-5 / FR-2 / FR-7). A heading + a
 * bullet list of markdown links whose TARGET is each per-session summary's own
 * `/summaries/<userName>/<sessionId>.md` path — a `memory`-table path the PRD-015 VFS
 * read precedence resolves to the summary body. Deterministic (summaries arrive sorted
 * by path), so the render is reproducible in tests.
 */
export function renderMemoryIndex(summaries: readonly SummaryRecord[]): string {
	const header = "# MEMORY.md\n\nSynthesized index of session summaries.\n";
	if (summaries.length === 0) {
		return `${header}\n_No session summaries yet._\n`;
	}
	const lines = summaries.map((s) => `- [${linkText(s)}](${s.path})`);
	return `${header}\n## Sessions\n\n${lines.join("\n")}\n`;
}

/**
 * Render a thread head body for one lineage key (b-AC-2 / FR-3). Links the per-session
 * summary (the MERGED session — one summary per resumed session, so one link). The body
 * names the thread key so a reader sees which session lineage it groups.
 */
export function renderThreadHead(threadKey: string, summary: SummaryRecord): string {
	return (
		`# Thread: ${threadKey}\n\n` +
		`Merged session head (resumes collapse into this entry).\n\n` +
		`- [${linkText(summary)}](${summary.path})\n`
	);
}

// ════════════════════════════════════════════════════════════════════════════
// synthesizeMemoryIndex — read summaries → render MEMORY.md → SBI write (b-AC-1/4/6).
// ════════════════════════════════════════════════════════════════════════════

/** Construction deps for the synthesis entry points (the daemon-side store + the author). */
export interface SynthesisDeps {
	/** The daemon-side `memory` read + SELECT-before-INSERT write seam (b-AC-3). */
	readonly store: SynthesisStore;
	/** The author/agent the synthesized rows are attributed to. Defaults to `honeycomb`. */
	readonly author?: string;
}

/** The default author attribution for synthesized rows. */
export const DEFAULT_SYNTHESIS_AUTHOR = "honeycomb" as const;

/** The result of {@link synthesizeMemoryIndex}. */
export interface MemoryIndexResult {
	/** The index path written (`/MEMORY.md`). */
	readonly path: string;
	/** True when this run inserted a fresh index row; false when one already existed (b-AC-4). */
	readonly written: boolean;
	/** How many per-session summaries the index linked. */
	readonly linkedSummaries: number;
}

/**
 * Synthesize the tenant-scoped `MEMORY.md` from the per-session summaries (b-AC-1 /
 * b-AC-4 / b-AC-5 / b-AC-6). Reads the `/summaries/<userName>/…` rows in the run's
 * tenant scope (the store carries it), renders a `MEMORY.md` whose links TARGET each
 * summary's own resolvable path, and writes it via SELECT-before-INSERT keyed on `path`
 * — never an in-place UPDATE. Every read + write goes through the daemon store (b-AC-3).
 */
export async function synthesizeMemoryIndex(deps: SynthesisDeps): Promise<MemoryIndexResult> {
	const author = deps.author ?? DEFAULT_SYNTHESIS_AUTHOR;
	const summaries = await deps.store.readSummaries();
	const body = renderMemoryIndex(summaries);
	const outcome = await deps.store.writeRow({
		path: MEMORY_INDEX_PATH,
		summary: body,
		description: excerpt(`MEMORY.md — ${summaries.length} session summaries`),
		author,
	});
	return { path: MEMORY_INDEX_PATH, written: outcome.written, linkedSummaries: summaries.length };
}

/** The result of {@link refreshMemoryIndex} (PRD-046b b-AC-1). */
export interface MemoryIndexRefreshResult {
	/** The index path refreshed (`/MEMORY.md`). */
	readonly path: string;
	/** The `version` the refreshed index row was appended at (N+1 over the prior highest). */
	readonly version: number;
	/** How many per-session summaries the refreshed index linked. */
	readonly linkedSummaries: number;
}

/**
 * REFRESH the tenant-scoped `/MEMORY.md` from the CURRENT per-session summaries (PRD-046b
 * b-AC-1) — the version-bumped companion to {@link synthesizeMemoryIndex}.
 *
 * Where `synthesizeMemoryIndex` is write-once (SELECT-before-INSERT) and a re-synthesis is
 * a no-op, THIS re-reads the summaries, re-renders the index, and APPENDS it at the next
 * `version` via {@link SynthesisStore.refreshRow}. So as new summaries land and the mount
 * re-runs synthesis, the index REFRESHES — the highest-version `/MEMORY.md` row reflects
 * the latest corpus — with ZERO in-place UPDATE (the DeepLake by-key-UPDATE-never-converges
 * trap). Reads + writes route through the daemon store (b-AC-3); the read is tenant-scoped
 * so two tenants refresh two disjoint indexes (b-AC-6).
 */
export async function refreshMemoryIndex(deps: SynthesisDeps): Promise<MemoryIndexRefreshResult> {
	const author = deps.author ?? DEFAULT_SYNTHESIS_AUTHOR;
	const summaries = await deps.store.readSummaries();
	const body = renderMemoryIndex(summaries);
	const outcome = await deps.store.refreshRow({
		path: MEMORY_INDEX_PATH,
		summary: body,
		description: excerpt(`MEMORY.md — ${summaries.length} session summaries`),
		author,
	});
	return { path: MEMORY_INDEX_PATH, version: outcome.version, linkedSummaries: summaries.length };
}

// ════════════════════════════════════════════════════════════════════════════
// synthesizeThreadHeads — group summaries by lineage → one head per thread (b-AC-2).
// ════════════════════════════════════════════════════════════════════════════

/** The outcome for ONE thread head written by {@link synthesizeThreadHeads}. */
export interface ThreadHeadResult {
	/** The stable lineage key (`<userName>/<sessionId>`) the head groups. */
	readonly threadKey: string;
	/** The thread-head path written (`/threads/<threadKey>.md`). */
	readonly path: string;
	/** True when this run inserted a fresh head row; false when one already existed (b-AC-4). */
	readonly written: boolean;
}

/**
 * Compute + write the thread heads, MERGING sessions resumed across
 * `--resume`/`--continue` into ONE head with no duplicate (b-AC-2 / b-AC-4 / b-AC-6).
 *
 * Groups the per-session summaries by their stable LINEAGE key ({@link threadKeyOf} =
 * `<userName>/<sessionId>`, invariant under a resume), so every summary for the same
 * resumed session collapses to ONE key. For each distinct key it writes ONE thread head
 * at `/threads/<threadKey>.md` via SELECT-before-INSERT — a resumed session updates the
 * existing head's lineage WITHOUT creating a duplicate entry (an existing real head at
 * the path means it already landed; the write is a no-op). Returns one result per
 * distinct thread key.
 */
export async function synthesizeThreadHeads(deps: SynthesisDeps): Promise<readonly ThreadHeadResult[]> {
	const author = deps.author ?? DEFAULT_SYNTHESIS_AUTHOR;
	const summaries = await deps.store.readSummaries();

	// Group by lineage key — the FIRST summary per key represents the merged session
	// (one summary per resumed session, so a Map de-dups by key, never by row). A
	// deterministic insertion order (summaries arrive sorted by path) keeps the result
	// reproducible in tests.
	const byThread = new Map<string, SummaryRecord>();
	for (const summary of summaries) {
		const key = threadKeyOf(summary.path);
		if (!byThread.has(key)) byThread.set(key, summary);
	}

	const results: ThreadHeadResult[] = [];
	for (const [threadKey, summary] of byThread) {
		const path = threadHeadPath(threadKey);
		const body = renderThreadHead(threadKey, summary);
		const outcome = await deps.store.writeRow({
			path,
			summary: body,
			description: excerpt(`Thread head — ${threadKey}`),
			author,
		});
		results.push({ threadKey, path, written: outcome.written });
	}
	return results;
}

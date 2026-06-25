/**
 * One-time, idempotent migration of the legacy skillify pull manifest into the unified asset
 * registry — R-2 (REVERSES the prior 033a "coexist" decision per the repo owner's "do it the
 * right way before production" ruling).
 *
 * Before R-2 a pulled skill's reversibility record lived in its own file
 * (`~/.honeycomb/state/skillify/pull-manifest.json` = `PullManifestEntry[]`). R-2 makes
 * `~/.honeycomb/registry.json` the SINGLE source of truth for both registered assets AND pulled
 * skills. This module folds the legacy file IN, then leaves a breadcrumb so the data is never
 * silently lost and the fold never runs twice.
 *
 * ── Why it is safe to run on EVERY store access ─────────────────────────────
 * The store calls {@link migrateLegacyManifest} before every `read`/`record`/`remove`. The fold:
 *   1. finds the FIRST existing legacy file among the candidate paths (none → no-op, return);
 *   2. parses it defensively (garbled / non-array → treated as empty, but still breadcrumbed so a
 *      poison file is not re-read forever);
 *   3. maps each legacy record to a unified registry row via the injected `legacyRecordToRow`;
 *   4. folds those rows into the registry, where an `honeycombId` ALREADY present in the registry
 *      WINS (the migration never clobbers a newer registry row — e.g. a re-pull that already wrote
 *      the unified row, or a registered-asset row that happens to share the id);
 *   5. renames the legacy file to `<legacy>.migrated` (a breadcrumb). The rename is what makes the
 *      operation idempotent: a second run finds no legacy file at the original path and returns.
 *
 * Pure + filesystem-only: no DeepLake, no network, no `process.env`. Every IO seam (the registry
 * read/write, the row mapper) is INJECTED so a test drives it against temp dirs with no real `~`.
 * This module imports NOTHING from `daemon/storage` (the thin-client invariant) — it is plain
 * `node:fs` over an injected base.
 */

import { existsSync, readFileSync, renameSync } from "node:fs";

/** A loosely-typed registry row as it sits on disk (the migration is row-shape-agnostic). */
type RegistryRow = Record<string, unknown>;

/** The breadcrumb suffix a migrated legacy file is renamed with (data preserved, never re-read). */
export const MIGRATED_SUFFIX = ".migrated";

/** The injected seams {@link migrateLegacyManifest} runs against (all pure / filesystem-only). */
export interface MigrateManifestDeps {
	/** Candidate legacy `pull-manifest.json` paths, in priority order. The first existing one is folded. */
	readonly legacyPaths: readonly string[];
	/** Read every current registry row (EMPTY on missing/garbled — never throws). */
	readonly readAllRows: () => RegistryRow[];
	/** Atomically write the registry rows (temp + rename). */
	readonly writeAllRows: (rows: readonly RegistryRow[]) => void;
	/** Map ONE untrusted legacy record into a unified registry row, or `null` when unusable. */
	readonly legacyRecordToRow: (raw: unknown) => RegistryRow | null;
}

/** The `honeycombId` of a registry row, or `""` when absent (the unified key). */
function idOf(row: RegistryRow): string {
	return typeof row.honeycombId === "string" ? row.honeycombId : "";
}

/**
 * Fold the legacy pull manifest into the unified registry, ONCE (idempotent). A no-op when no
 * legacy file exists at any candidate path. Never throws — a read/parse failure degrades to "fold
 * nothing", but the legacy file is STILL breadcrumbed so a poison file is not re-read on every
 * access. Registry rows already present (by `honeycombId`) are PRESERVED; only legacy ids not yet
 * in the registry are added.
 */
export function migrateLegacyManifest(deps: MigrateManifestDeps): void {
	const legacyPath = deps.legacyPaths.find((p) => existsSync(p));
	if (legacyPath === undefined) return; // nothing to migrate — the common, steady-state case.

	const legacyRecords = readLegacyRecords(legacyPath);

	// Map each legacy record to a unified row; drop the unusable ones (no dirName/honeycombId).
	const foldedRows = legacyRecords
		.map((raw) => deps.legacyRecordToRow(raw))
		.filter((r): r is RegistryRow => r !== null);

	if (foldedRows.length > 0) {
		const existing = deps.readAllRows();
		const known = new Set(existing.map(idOf));
		// Registry rows WIN: only add a folded row whose id is not already present (never clobber).
		const additions = foldedRows.filter((r) => {
			const id = idOf(r);
			return id !== "" && !known.has(id);
		});
		if (additions.length > 0) {
			deps.writeAllRows([...existing, ...additions]);
		}
	}

	// Breadcrumb: rename the legacy file so the fold never runs again (the source of idempotency).
	// A rename failure is swallowed — the worst case is a no-op re-fold next access (still safe,
	// since the id-present-wins rule means a re-fold adds nothing once the rows are in the registry).
	breadcrumb(legacyPath);
}

/** Parse a legacy `pull-manifest.json` into a record array, EMPTY on any read/parse failure. */
function readLegacyRecords(legacyPath: string): readonly unknown[] {
	try {
		const parsed = JSON.parse(readFileSync(legacyPath, "utf-8")) as unknown;
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** Rename the migrated legacy file to `<path>.migrated` (best-effort breadcrumb; failure swallowed). */
function breadcrumb(legacyPath: string): void {
	try {
		const dest = `${legacyPath}${MIGRATED_SUFFIX}`;
		// If a prior `.migrated` breadcrumb already exists, overwrite intent is fine: rename(2) over
		// an existing file is atomic on the same fs. On the rare platform where it is not, the catch
		// below keeps the migration total (a left-behind legacy file is re-folded harmlessly).
		renameSync(legacyPath, dest);
	} catch {
		// Swallow — see the note at the call site: a failed breadcrumb at worst re-folds (a no-op).
	}
}

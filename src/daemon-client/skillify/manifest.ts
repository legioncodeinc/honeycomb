/**
 * Pull manifest — PRD-018b (FR-8 / b-AC manifest tracking) + 018c (FR-6 backfill source),
 * RE-BACKED onto the unified asset registry by R-2.
 *
 * ── What changed in R-2 (the unified-registry migration) ────────────────────
 * The pulled-skill record USED to live in its own file
 * (`~/.honeycomb/state/skillify/pull-manifest.json` = `PullManifestEntry[]`). It now lives
 * AS rows inside the ONE asset registry (`~/.honeycomb/registry.json`), so that registry is
 * the SINGLE source of truth for both registered assets AND pulled skills (the repo owner's
 * "do it the right way before production" ruling REVERSES the prior 033a "coexist" decision).
 *
 * `createPullManifestStore` is now a THIN ADAPTER: it presents the UNCHANGED
 * {@link PullManifestStore} surface (`read`/`record`/`remove`, keyed by `dirName`) backed by
 * `registry.json`. A pulled-skill row is a registry entry whose `honeycombId` IS the canonical
 * `<name>--<author>` `dirName` and whose `pulledManifest` block carries every reversibility
 * field `skill unpull` + `backfillSymlinks` depend on (symlinks, installRoot, install,
 * remoteVersion, name/author, projectKey, pulledAt). Registered-asset rows in the SAME file are
 * preserved verbatim and are NEVER returned by this surface (so `unpull`/`backfill` see ONLY
 * pull-managed entries, exactly as before — they never touch a user-mined or registered asset).
 *
 * ── One-time idempotent migration ──────────────────────────────────────────
 * On the first `read`/`record`/`remove` where a LEGACY `pull-manifest.json` exists, its entries
 * are folded into `registry.json` (any `honeycombId`/`dirName` already present in the registry
 * wins — the migration never clobbers a newer registry row), and the legacy file is renamed to
 * `pull-manifest.json.migrated` as a breadcrumb (data is never silently lost; the move is safe
 * to run repeatedly — a second run finds no legacy file and is a no-op). See `migrate-manifest.ts`.
 *
 * ── Thin-client, filesystem-only (the daemon-only invariant) ────────────────
 * This lives under `src/daemon-client/` and touches `node:fs` + the user's home ONLY. The
 * registry is LOCAL bookkeeping — it records what a pull wrote locally, NOT team state — so it
 * opens NO DeepLake connection (D-3), mirroring `watermark.ts` / `config.ts`. It deliberately
 * does NOT import `src/daemon/runtime/assets/registry.ts` (that module imports
 * `daemon/storage/catalog`, which the thin-client invariant bans from `daemon-client/**`): the
 * registry row SHAPE is agreed by VALUE here and validated independently, and both readers
 * round-trip the other's rows losslessly.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { type PullManifestEntry, type PullManifestStore, type SkillInstall } from "./contracts.js";
import { migrateLegacyManifest } from "./migrate-manifest.js";

/**
 * The default base dir for the unified registry — `~/.honeycomb` (where `registry.json` lives,
 * mirroring `defaultRegistryBaseDir` on the daemon side). R-2 moves the manifest's SoT here from
 * the old `~/.honeycomb/state/skillify` state root; the legacy file at that old path is migrated
 * in on first access (see {@link legacyManifestPath}).
 */
export function defaultManifestBaseDir(): string {
	return join(homedir(), ".honeycomb");
}

/** The unified registry file name under the base dir (the R-2 SoT — shared with the daemon side). */
const REGISTRY_FILE = "registry.json";

/**
 * The candidate legacy pull-manifest paths RELATIVE TO a registry base dir, in priority order.
 * The pre-R-2 `createPullManifestStore(baseDir)` joined `pull-manifest.json` DIRECTLY onto its
 * baseDir, so a test (and any pre-R-2 caller that injected the state root as baseDir) seeds the
 * file at `<baseDir>/pull-manifest.json` — checked FIRST. In production the registry base dir is
 * `~/.honeycomb` and the real legacy manifest sat at `~/.honeycomb/state/skillify/pull-manifest.json`
 * — checked SECOND. The migration folds in whichever it finds (first match wins) and is a no-op
 * when neither exists, so it stays safe to run repeatedly.
 */
export function legacyManifestPaths(baseDir: string): readonly string[] {
	return [join(baseDir, "pull-manifest.json"), join(baseDir, "state", "skillify", "pull-manifest.json")];
}

/**
 * Build a filesystem {@link PullManifestStore} rooted at `baseDir` (default
 * {@link defaultManifestBaseDir}, i.e. `~/.honeycomb`). A test injects a temp dir so no real `~`
 * is touched. Entries are keyed by `dirName` (`<name>--<author>`); a re-pull replaces the record.
 *
 * R-2: this is a THIN ADAPTER over the unified `registry.json`. Every access first runs the
 * one-time, idempotent legacy-manifest migration ({@link migrateLegacyManifest}), then reads /
 * writes the registry file. The surface (`read`/`record`/`remove`) is IDENTICAL to the pre-R-2
 * store, so `pull` / `unpullSkill` / `backfillSymlinks` are unchanged.
 */
export function createPullManifestStore(baseDir: string = defaultManifestBaseDir()): PullManifestStore {
	const registryPath = join(baseDir, REGISTRY_FILE);

	/** Read every registry row (every kind), EMPTY on a missing/garbled file — never throws. */
	const readAllRows = (): RegistryRow[] => {
		try {
			const parsed = JSON.parse(readFileSync(registryPath, "utf-8")) as unknown;
			if (!Array.isArray(parsed)) return [];
			return parsed.filter((r): r is RegistryRow => typeof r === "object" && r !== null);
		} catch {
			return [];
		}
	};

	/** Atomic write (temp + rename) — a crash mid-write never truncates the registry (mirrors the daemon store). */
	const writeAllRows = (rows: readonly RegistryRow[]): void => {
		mkdirSync(dirname(registryPath), { recursive: true });
		const tmp = `${registryPath}.tmp-${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify(rows, null, 2)}\n`, "utf-8");
		renameSync(tmp, registryPath);
	};

	/** Fold any legacy `pull-manifest.json` into the registry once (idempotent, breadcrumb-leaving). */
	const ensureMigrated = (): void => {
		migrateLegacyManifest({ legacyPaths: legacyManifestPaths(baseDir), readAllRows, writeAllRows, legacyRecordToRow });
	};

	return {
		read(): readonly PullManifestEntry[] {
			ensureMigrated();
			// Return ONLY pull-managed rows (those carrying a valid `pulledManifest` block), coerced
			// to the legacy entry shape. Registered-asset rows are preserved in the file, never returned.
			return readAllRows()
				.map(rowToEntry)
				.filter((e): e is PullManifestEntry => e !== null);
		},

		record(entry: PullManifestEntry): void {
			ensureMigrated();
			const normalized = normalizeEntry(entry);
			if (normalized === null) return;
			// Upsert by `honeycombId` (= dirName). Replace any prior row for this dir (pulled OR a
			// stale registered-asset shadow) so a re-pull updates in place — exactly the pre-R-2
			// "keyed by dirName, a re-pull replaces the record" semantics.
			const rows = readAllRows().filter((r) => honeycombIdOf(r) !== normalized.dirName);
			rows.push(entryToRow(normalized));
			writeAllRows(rows);
		},

		remove(dirName: string): PullManifestEntry | null {
			ensureMigrated();
			const rows = readAllRows();
			const target = rows.find((r) => honeycombIdOf(r) === dirName && isPulledRow(r)) ?? null;
			if (target === null) return null;
			writeAllRows(rows.filter((r) => honeycombIdOf(r) !== dirName));
			return rowToEntry(target);
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry-row shape (agreed BY VALUE with src/daemon/runtime/assets/registry.ts).
// This module must NOT import that module (thin-client invariant), so the pulled-
// skill row shape is mirrored here and validated independently. Both readers
// round-trip the other's rows losslessly.
// ─────────────────────────────────────────────────────────────────────────────

/** A loosely-typed registry row as it sits on disk — any object; the discriminator is `pulledManifest`. */
type RegistryRow = Record<string, unknown>;

/** The skill-row defaults the unified entry takes so it satisfies the daemon's `RegistryEntry` zod schema. */
const SKILL_ROW_DEFAULTS = Object.freeze({
	assetType: "skill",
	tier: "Local",
	// `project` install → a repo-scoped skill (Repository style); `global` install → User style.
	// (Style is informational for a pulled-skill row; the lifecycle never transitions these.)
	version: 0,
	lastSyncedHash: "",
	localHash: "",
	remoteHash: "",
	org: "",
	workspace: "",
	deviceSet: [] as readonly string[],
});

/** The `honeycombId` of a registry row (the unified key; for a pulled-skill row it equals `dirName`). */
function honeycombIdOf(row: RegistryRow): string {
	return typeof row.honeycombId === "string" ? row.honeycombId : "";
}

/** True when a row is a PULL-MANAGED row (it carries a usable `pulledManifest` block). */
function isPulledRow(row: RegistryRow): boolean {
	return rowToEntry(row) !== null;
}

/**
 * Project a unified registry row back into a legacy {@link PullManifestEntry}, or `null` when the
 * row is NOT a pull-managed row (no usable `pulledManifest` block, or no `honeycombId`). This is
 * the read-side coercion: a registered-asset row (no `pulledManifest`) returns `null` and is thus
 * invisible to the manifest surface, while a pulled-skill row round-trips to the exact entry shape
 * `unpull`/`backfill` expect. UNTRUSTED input — coerces defensively, never throws.
 */
function rowToEntry(row: RegistryRow): PullManifestEntry | null {
	const dirName = honeycombIdOf(row);
	if (dirName === "") return null;
	const pm = row.pulledManifest;
	if (typeof pm !== "object" || pm === null) return null;
	const p = pm as Record<string, unknown>;
	const install: SkillInstall = p.install === "global" ? "global" : "project";
	const symlinks = Array.isArray(p.symlinks) ? p.symlinks.filter((s): s is string => typeof s === "string") : [];
	const remoteVersion = typeof p.remoteVersion === "number" ? p.remoteVersion : Number(p.remoteVersion);
	return {
		dirName,
		name: typeof p.name === "string" ? p.name : "",
		author: typeof p.author === "string" ? p.author : "",
		projectKey: typeof p.projectKey === "string" ? p.projectKey : "",
		remoteVersion: Number.isFinite(remoteVersion) ? remoteVersion : 0,
		install,
		installRoot: typeof p.installRoot === "string" ? p.installRoot : "",
		pulledAt: typeof p.pulledAt === "string" ? p.pulledAt : "",
		symlinks,
	};
}

/**
 * Build a unified registry row from a normalized {@link PullManifestEntry} (the write-side
 * mapping). The `honeycombId` IS the `dirName`; the reversibility fields live in `pulledManifest`;
 * the base fields take skill-row defaults so the row validates as a daemon `RegistryEntry`.
 */
function entryToRow(entry: PullManifestEntry): RegistryRow {
	return {
		...SKILL_ROW_DEFAULTS,
		honeycombId: entry.dirName,
		harness: entry.author,
		style: entry.install === "global" ? "User" : "Repository",
		pulledManifest: {
			install: entry.install,
			installRoot: entry.installRoot,
			symlinks: entry.symlinks,
			name: entry.name,
			author: entry.author,
			projectKey: entry.projectKey,
			pulledAt: entry.pulledAt,
			remoteVersion: entry.remoteVersion,
		},
	};
}

/**
 * Coerce ONE untrusted legacy `pull-manifest.json` record into a unified registry row, or `null`
 * when it is unusable (no `dirName`). The migration maps each legacy entry through this so the
 * folded rows are byte-identical to what `record` would have written for the same entry.
 */
function legacyRecordToRow(raw: unknown): RegistryRow | null {
	const entry = normalizeEntry(raw);
	return entry === null ? null : entryToRow(entry);
}

/** Coerce an untrusted manifest record into a valid entry, or `null` when unusable. */
function normalizeEntry(raw: unknown): PullManifestEntry | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	const dirName = typeof r.dirName === "string" ? r.dirName : "";
	if (dirName === "") return null;
	const install: SkillInstall = r.install === "global" ? "global" : "project";
	const symlinks = Array.isArray(r.symlinks) ? r.symlinks.filter((s): s is string => typeof s === "string") : [];
	const remoteVersion = typeof r.remoteVersion === "number" ? r.remoteVersion : Number(r.remoteVersion);
	return {
		dirName,
		name: typeof r.name === "string" ? r.name : "",
		author: typeof r.author === "string" ? r.author : "",
		projectKey: typeof r.projectKey === "string" ? r.projectKey : "",
		remoteVersion: Number.isFinite(remoteVersion) ? remoteVersion : 0,
		install,
		installRoot: typeof r.installRoot === "string" ? r.installRoot : "",
		pulledAt: typeof r.pulledAt === "string" ? r.pulledAt : "",
		symlinks,
	};
}

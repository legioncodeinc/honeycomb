/**
 * PRD-033a — The asset registry: `.honeycomb/registry.json` (FR-1 / a-AC-1 / D-2).
 *
 * The SINGLE SOURCE OF TRUTH for every substrate-managed artifact's tier, style,
 * harness, version, identity, hashes, provenance, and device set. It EVOLVES the
 * skillify pull manifest's shape (adds tier/style/3-hashes/`honeycomb_id`/device-
 * set) AND now SUBSUMES it — the unified-registry migration (R-2) folds the legacy
 * skillify pull manifest (`~/.honeycomb/state/skillify/pull-manifest.json`) INTO
 * this one file so `.honeycomb/registry.json` is the ONE source of truth for both
 * registered assets AND pulled skills.
 *
 * ── How a pulled-skill row coexists with a registered-asset row (R-2) ───────
 * A pulled-skill row is a normal {@link RegistryEntry} whose `honeycombId` is the
 * skill's canonical `<name>--<author>` dir name and whose ADDITIVE, OPTIONAL
 * {@link PulledManifest} block carries the reversibility fields `skill unpull` /
 * `backfillSymlinks` depend on (symlinks, installRoot, install, remoteVersion,
 * name/author, projectKey, pulledAt). The base fields take skill-shaped defaults
 * (`assetType:"skill"`, `tier:"Local"`, `style:"User"|"Repository"`, empty hashes)
 * so the SAME zod read-validation accepts both kinds — a registered-asset row has
 * NO `pulledManifest`; a pulled-skill row DOES. Nothing about the existing
 * registered-asset path changes: every prior field is untouched and the new field
 * is optional, so pre-R-2 entries (and every `registerAsset`/`transitionAsset`
 * call site) stay valid by construction.
 *
 * ── Thin-client note (why the manifest adapter does NOT import this module) ──
 * `createPullManifestStore` (`src/daemon-client/skillify/manifest.ts`) presents the
 * old `PullManifestStore` surface backed by this SAME `registry.json` file, but it
 * CANNOT import this module: `registry.ts` imports `daemon/storage/catalog`, which
 * the thin-client invariant (`tests/daemon/storage/invariant.test.ts`) bans from
 * `src/daemon-client/**`. The shared shape is therefore agreed by VALUE (the
 * `pulledManifest` block + the skill-row defaults), validated independently on each
 * side; both readers round-trip the other's rows losslessly.
 *
 * The store mirrors `createPullManifestStore` (the proven thin-client pattern):
 *   - `read()`   — every entry, EMPTY on a missing/garbled file (never throws).
 *   - `upsert()` — keyed by `honeycombId` (a re-record replaces the prior entry).
 *   - `remove()` — drop the entry for a `honeycombId`.
 *   - the write is ATOMIC (temp file + rename) so a crash mid-write never leaves a
 *     truncated registry that the next read would treat as empty and silently lose.
 *
 * Pure + local (D-6): filesystem-only under an INJECTABLE base dir. It records
 * LOCAL bookkeeping (what tier/style/hashes an artifact is at on THIS machine),
 * not team state, so it opens NO DeepLake connection — mirroring `manifest.ts` /
 * `watermark.ts`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

import { honeycombStateDir, legacyHoneycombDir, preferExistingPath } from "../../../shared/fleet-root.js";
import { STYLES, TIERS } from "./contracts.js";
import { SYNCED_ASSET_TYPES } from "../../storage/catalog/synced-assets.js";

/**
 * The reversibility block a PULLED-SKILL registry row carries (R-2). ADDITIVE +
 * OPTIONAL: a registered-asset row omits it; a pulled-skill row sets it. It mirrors
 * the legacy `PullManifestEntry` fields `skill unpull` + `backfillSymlinks` depend
 * on (`src/daemon-client/skillify/contracts.ts`) so the migration is LOSSLESS:
 *
 *   - `install`      — `project` | `global` (backfill/fan-out gate on `global`).
 *   - `installRoot`  — the canonical root the SKILL.md dir was written under.
 *   - `symlinks`     — the absolute fanned-out link paths (for `unpull`'s reversal).
 *   - `name`/`author`— the `<name>--<author>` halves (the row's `honeycombId` IS the
 *                      joined dir name, but the halves are kept verbatim for render).
 *   - `projectKey`   — provenance: the project key the pull ran under.
 *   - `pulledAt`     — ISO timestamp the pull wrote the row.
 *   - `remoteVersion`— the remote version the row was written at (drives the compare).
 *
 * The DAEMON side never acts on this block (it is opaque to the asset lifecycle); it
 * exists so the one `registry.json` file losslessly round-trips a pulled-skill row
 * the thin-client manifest adapter writes. Every field is required WITHIN the block
 * (so a partial block is dropped rather than half-trusted), but the block itself is
 * optional on the entry.
 */
export const PulledManifestSchema = z.object({
	install: z.enum(["project", "global"]),
	installRoot: z.string(),
	symlinks: z.array(z.string()),
	name: z.string(),
	author: z.string(),
	projectKey: z.string(),
	pulledAt: z.string(),
	remoteVersion: z.number(),
});

/** The reversibility block a pulled-skill registry row carries (R-2) — inferred type. */
export type PulledManifest = z.infer<typeof PulledManifestSchema>;

/**
 * One artifact's registry entry (FR-1 / a-AC-1). Zod-validated on read so a
 * hand-edited or partially-written file coerces to a usable record (or is dropped)
 * rather than crashing the daemon.
 *
 *   identity:   assetType, harness, honeycombId
 *   placement:  tier, style
 *   version:    version (monotonic intent/order — distinct from the hashes, FR-5)
 *   hashes:     lastSyncedHash / localHash / remoteHash (3-way-merge data, FR-6)
 *   provenance: author, org, workspace
 *   audience:   deviceSet (the Device-tier device_ids this artifact addresses)
 *   source:     sourcePath (the on-disk path the artifact was registered from — re-read
 *               on a PROMOTE so the publish carries the artifact's CURRENT bytes, F-3)
 *
 * `sourcePath` is ADDITIVE + OPTIONAL: an entry written before this field (or one where
 * the path is genuinely unknown) simply omits it. A promotion then fails CLEARLY rather
 * than publishing an empty blob (the CLI tells the user to re-register or pass the path).
 */
export const RegistryEntrySchema = z.object({
	assetType: z.enum(SYNCED_ASSET_TYPES),
	harness: z.string(),
	tier: z.enum(TIERS),
	style: z.enum(STYLES),
	version: z.number().int().nonnegative(),
	honeycombId: z.string().min(1),
	lastSyncedHash: z.string(),
	localHash: z.string(),
	remoteHash: z.string(),
	author: z.string(),
	org: z.string(),
	workspace: z.string(),
	deviceSet: z.array(z.string()),
	/**
	 * The absolute on-disk path the artifact was registered from — the agent FILE or the
	 * skill DIRECTORY. Re-read on a PROMOTE so the publish carries the artifact's CURRENT
	 * native bytes (F-3). Optional so pre-existing entries (and tests) stay valid.
	 */
	sourcePath: z.string().optional(),
	/**
	 * The pulled-skill reversibility block (R-2). ADDITIVE + OPTIONAL: present ONLY on a
	 * row migrated/written from the skillify pull manifest; a registered-asset row omits it.
	 * Its presence is what distinguishes a pulled-skill row from a registered-asset row in
	 * the unified registry.
	 */
	pulledManifest: PulledManifestSchema.optional(),
});

/** One artifact's registry entry (FR-1 / a-AC-1) — the inferred type of the schema. */
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

/** The on-disk registry store keyed by `honeycombId`. Mirrors {@link PullManifestStore}. */
export interface AssetRegistryStore {
	/** Every recorded entry (EMPTY on a missing/garbled file — never throws). */
	read(): readonly RegistryEntry[];
	/** Upsert one entry, keyed by `honeycombId` (a re-record replaces the prior entry). */
	upsert(entry: RegistryEntry): void;
	/** Remove the entry for `honeycombId`. Returns the removed entry, or `null`. */
	remove(honeycombId: string): RegistryEntry | null;
}

/** The default honeycomb state base dir under the fleet root (`~/.apiary/honeycomb/`, PRD-072b). */
export function defaultRegistryBaseDir(homeDir: string = homedir()): string {
	return honeycombStateDir({ home: homeDir });
}

/** The legacy `~/.honeycomb` base dir the registry read-falls back to during the window. */
export function legacyRegistryBaseDir(homeDir: string = homedir()): string {
	return legacyHoneycombDir(homeDir);
}

/** The registry file name under the base dir. */
const REGISTRY_FILE = "registry.json";

/**
 * Build a filesystem {@link AssetRegistryStore} rooted at `baseDir` (default
 * `~/.honeycomb`). A test injects a temp dir so no real `~` is touched. Entries
 * are keyed by `honeycombId`; an `upsert` with a known id replaces the record.
 * Mirrors `createPullManifestStore`, with an ATOMIC write (temp + rename) so a
 * crash mid-write can never truncate the registry.
 */
export function createAssetRegistryStore(
	baseDir: string = defaultRegistryBaseDir(),
	legacyBaseDir?: string,
): AssetRegistryStore {
	const filePath = join(baseDir, REGISTRY_FILE);
	// Writes always target the new path; reads prefer the new path, falling back to the legacy file
	// (PRD-072b) only when a `legacyBaseDir` is supplied (production passes it; hermetic tests do not).
	const readPath = (): string =>
		legacyBaseDir !== undefined ? preferExistingPath(filePath, join(legacyBaseDir, REGISTRY_FILE)) : filePath;

	const readAll = (): RegistryEntry[] => {
		try {
			const parsed = JSON.parse(readFileSync(readPath(), "utf-8")) as unknown;
			if (!Array.isArray(parsed)) return [];
			return parsed.map(normalizeEntry).filter((e): e is RegistryEntry => e !== null);
		} catch {
			return [];
		}
	};

	const writeAll = (entries: readonly RegistryEntry[]): void => {
		mkdirSync(dirname(filePath), { recursive: true });
		// Atomic write: serialize to a sibling temp file, then rename over the target.
		// rename(2) is atomic on the same filesystem, so a reader never sees a partial file.
		const tmp = `${filePath}.tmp-${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, "utf-8");
		renameSync(tmp, filePath);
	};

	return {
		read(): readonly RegistryEntry[] {
			return readAll();
		},

		upsert(entry: RegistryEntry): void {
			const normalized = normalizeEntry(entry);
			if (normalized === null) return;
			const entries = readAll().filter((e) => e.honeycombId !== normalized.honeycombId);
			entries.push(normalized);
			writeAll(entries);
		},

		remove(honeycombId: string): RegistryEntry | null {
			const entries = readAll();
			const target = entries.find((e) => e.honeycombId === honeycombId) ?? null;
			if (target === null) return null;
			writeAll(entries.filter((e) => e.honeycombId !== honeycombId));
			return target;
		},
	};
}

/**
 * Coerce an untrusted registry record into a valid {@link RegistryEntry}, or
 * `null` when unusable. Uses the zod schema (the single validation authority); a
 * record that fails validation is dropped rather than throwing, so one bad entry
 * never poisons the whole registry read.
 */
function normalizeEntry(raw: unknown): RegistryEntry | null {
	const result = RegistryEntrySchema.safeParse(raw);
	return result.success ? result.data : null;
}

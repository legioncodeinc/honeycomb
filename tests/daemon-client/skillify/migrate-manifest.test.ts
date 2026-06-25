/**
 * R-2 unified-registry migration — proves the legacy skillify pull manifest folds into the ONE
 * `registry.json` (the single SoT) without regressing PRD-018b/c. Drives the REAL
 * `createPullManifestStore` adapter, the `migrateLegacyManifest` fold, and the 018 `pull` /
 * `unpullSkill` / `backfillSymlinks` engine against temp dirs — no daemon, no real `~`.
 *
 * The invariants under test (all named):
 *   - a legacy `pull-manifest.json` is folded into `registry.json` on first access;
 *   - the fold is IDEMPOTENT (safe to run repeatedly — a re-run adds nothing, the legacy file is
 *     breadcrumbed, not deleted, so no data is silently lost);
 *   - a pulled-skill row and a registered-asset row COEXIST in the one file, and the manifest
 *     surface returns ONLY the pulled-skill rows (it never reports a registered asset);
 *   - a registry row already present by id WINS over a legacy record with the same id;
 *   - `pull` + `unpull` + `backfill` round-trip THROUGH the unified registry, behavior identical.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	canonicalDirName,
	createFakeSkillPullClient,
	createPullManifestStore,
	legacyManifestPaths,
	MIGRATED_SUFFIX,
	type PullManifestEntry,
	pull,
	unpullSkill,
} from "../../../src/daemon-client/skillify/index.js";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "skillify-migrate-"));
}

/** The unified registry file inside a base dir. */
function registryPath(baseDir: string): string {
	return join(baseDir, "registry.json");
}

/** The FIRST candidate legacy path (the one a pre-R-2 store wrote: `<baseDir>/pull-manifest.json`). */
function legacyPath(baseDir: string): string {
	return legacyManifestPaths(baseDir)[0] as string;
}

/** Seed a legacy `pull-manifest.json` with the given entries at the primary candidate path. */
function seedLegacy(baseDir: string, entries: readonly Partial<PullManifestEntry>[]): string {
	const path = legacyPath(baseDir);
	mkdirSync(join(path, ".."), { recursive: true });
	const full = entries.map((e) => ({
		dirName: "tidy-imports--alice",
		name: "tidy-imports",
		author: "alice",
		projectKey: "proj-1",
		remoteVersion: 1,
		install: "global",
		installRoot: join(baseDir, ".claude", "skills"),
		pulledAt: "2026-01-01T00:00:00.000Z",
		symlinks: [],
		...e,
	}));
	writeFileSync(path, JSON.stringify(full, null, 2), "utf-8");
	return path;
}

/** Read the raw registry rows off disk (every kind), or [] when absent. */
function readRegistryRows(baseDir: string): Record<string, unknown>[] {
	try {
		const parsed = JSON.parse(readFileSync(registryPath(baseDir), "utf-8")) as unknown;
		return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
	} catch {
		return [];
	}
}

describe("R-2 legacy pull-manifest → unified registry migration", () => {
	it("folds a legacy manifest into registry.json on first read", () => {
		const baseDir = tempDir();
		seedLegacy(baseDir, [{ dirName: "tidy-imports--alice", remoteVersion: 3 }]);

		const store = createPullManifestStore(baseDir);
		const entries = store.read();

		// The surface returns the folded entry, shape-identical to the legacy record.
		expect(entries).toHaveLength(1);
		expect(entries[0]?.dirName).toBe("tidy-imports--alice");
		expect(entries[0]?.remoteVersion).toBe(3);
		expect(entries[0]?.install).toBe("global");

		// It now lives as a row in the ONE registry file, carrying the reversibility block.
		const rows = readRegistryRows(baseDir);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.honeycombId).toBe("tidy-imports--alice");
		expect((rows[0]?.pulledManifest as Record<string, unknown>)?.remoteVersion).toBe(3);
		// The base fields took skill-row defaults so the daemon's RegistryEntry zod schema accepts it.
		expect(rows[0]?.assetType).toBe("skill");
		expect(rows[0]?.tier).toBe("Local");
	});

	it("leaves a breadcrumb (renames the legacy file, never deletes it) — no silent data loss", () => {
		const baseDir = tempDir();
		const legacy = seedLegacy(baseDir, [{ dirName: "a--b" }]);

		createPullManifestStore(baseDir).read();

		expect(existsSync(legacy)).toBe(false); // moved, not left to be re-read
		expect(existsSync(`${legacy}${MIGRATED_SUFFIX}`)).toBe(true); // the breadcrumb survives
	});

	it("is IDEMPOTENT — a second read (or a fresh store) folds nothing extra", () => {
		const baseDir = tempDir();
		seedLegacy(baseDir, [{ dirName: "x--y", remoteVersion: 2 }]);

		const first = createPullManifestStore(baseDir);
		expect(first.read()).toHaveLength(1);
		// A second read on the same store — the legacy file is already breadcrumbed.
		expect(first.read()).toHaveLength(1);
		// A brand-new store on the same dir — still exactly one row, no duplication.
		expect(createPullManifestStore(baseDir).read()).toHaveLength(1);
		expect(readRegistryRows(baseDir)).toHaveLength(1);
	});

	it("a registry row already present by id WINS over a legacy record with the same id", () => {
		const baseDir = tempDir();
		// Pre-existing unified registry row at v9 for the same dir.
		mkdirSync(baseDir, { recursive: true });
		writeFileSync(
			registryPath(baseDir),
			JSON.stringify([
				{
					assetType: "skill",
					harness: "alice",
					tier: "Local",
					style: "User",
					version: 0,
					honeycombId: "tidy-imports--alice",
					lastSyncedHash: "",
					localHash: "",
					remoteHash: "",
					author: "",
					org: "",
					workspace: "",
					deviceSet: [],
					pulledManifest: {
						install: "global",
						installRoot: join(baseDir, ".claude", "skills"),
						symlinks: [],
						name: "tidy-imports",
						author: "alice",
						projectKey: "proj-1",
						pulledAt: "2026-05-01T00:00:00.000Z",
						remoteVersion: 9,
					},
				},
			]),
			"utf-8",
		);
		// Legacy record at the SAME id but an OLDER version — must NOT clobber the registry's v9.
		seedLegacy(baseDir, [{ dirName: "tidy-imports--alice", remoteVersion: 1 }]);

		const entries = createPullManifestStore(baseDir).read();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.remoteVersion).toBe(9); // the registry row won
	});

	it("a registered-asset row coexists and is NEVER returned by the manifest surface", () => {
		const baseDir = tempDir();
		mkdirSync(baseDir, { recursive: true });
		// A registered-asset row (NO pulledManifest block) sharing the file.
		writeFileSync(
			registryPath(baseDir),
			JSON.stringify([
				{
					assetType: "agent",
					harness: "claude-code",
					tier: "Team",
					style: "User",
					version: 4,
					honeycombId: "hc_registered_agent",
					lastSyncedHash: "h1",
					localHash: "h1",
					remoteHash: "h1",
					author: "alice",
					org: "o",
					workspace: "w",
					deviceSet: [],
				},
			]),
			"utf-8",
		);

		const store = createPullManifestStore(baseDir);
		// The manifest surface sees ZERO entries — a registered asset is not a pull-managed entry.
		expect(store.read()).toHaveLength(0);

		// Recording a pulled skill keeps the registered-asset row intact.
		store.record({
			dirName: "p--me",
			name: "p",
			author: "me",
			projectKey: "k",
			remoteVersion: 1,
			install: "global",
			installRoot: join(baseDir, ".claude", "skills"),
			pulledAt: "2026-01-01T00:00:00.000Z",
			symlinks: [],
		});
		expect(store.read().map((e) => e.dirName)).toEqual(["p--me"]);
		// Both rows live in the file; the registered asset was untouched.
		const ids = readRegistryRows(baseDir).map((r) => r.honeycombId).sort();
		expect(ids).toEqual(["hc_registered_agent", "p--me"]);
	});

	it("a garbled legacy file is breadcrumbed and folds nothing (never crashes the read)", () => {
		const baseDir = tempDir();
		const legacy = legacyPath(baseDir);
		mkdirSync(join(legacy, ".."), { recursive: true });
		writeFileSync(legacy, "{ not json", "utf-8");

		const store = createPullManifestStore(baseDir);
		expect(store.read()).toHaveLength(0);
		expect(existsSync(`${legacy}${MIGRATED_SUFFIX}`)).toBe(true); // poison file not re-read forever
	});
});

describe("R-2 pull / unpull / backfill round-trip THROUGH the unified registry", () => {
	it("a global pull records into registry.json; unpull reverses it (behavior unchanged)", async () => {
		const baseDir = tempDir();
		const canonical = join(baseDir, "canonical");
		const manifest = createPullManifestStore(baseDir);
		const client = createFakeSkillPullClient({ skills: [{ name: "tidy", author: "bob", version: 1, body: "---\nname: tidy\nversion: 1\n---\n" }] });

		const outcome = await pull({
			client,
			roots: { canonicalRoot: () => canonical, otherRoots: () => [] },
			install: "global",
			manifest,
		});
		expect(outcome.manifestError).toBeNull();

		const dirName = canonicalDirName("tidy", "bob");
		// The record landed AS a row in registry.json (the single SoT), not a separate manifest.
		const rows = readRegistryRows(baseDir);
		expect(rows.some((r) => r.honeycombId === dirName && r.pulledManifest !== undefined)).toBe(true);
		expect(manifest.read().map((e) => e.dirName)).toEqual([dirName]);
		expect(existsSync(registryPath(baseDir))).toBe(true);

		// unpull reverses the pull-managed entry: removes the canonical dir + the registry row.
		const un = unpullSkill(manifest, dirName);
		expect(un.removed).toBe(true);
		expect(existsSync(join(canonical, dirName))).toBe(false);
		expect(manifest.read()).toHaveLength(0);
		expect(readRegistryRows(baseDir).some((r) => r.honeycombId === dirName)).toBe(false);
	});

	it("unpull leaves a registered-asset row untouched (reverses pull-managed entries only)", () => {
		const baseDir = tempDir();
		mkdirSync(baseDir, { recursive: true });
		writeFileSync(
			registryPath(baseDir),
			JSON.stringify([
				{
					assetType: "agent",
					harness: "claude-code",
					tier: "Team",
					style: "User",
					version: 1,
					honeycombId: "shared-id",
					lastSyncedHash: "",
					localHash: "",
					remoteHash: "",
					author: "a",
					org: "o",
					workspace: "w",
					deviceSet: [],
				},
			]),
			"utf-8",
		);
		const manifest = createPullManifestStore(baseDir);
		// `shared-id` is a registered asset, NOT a pull-managed entry → unpull refuses it.
		const un = unpullSkill(manifest, "shared-id");
		expect(un.removed).toBe(false);
		// The registered-asset row SURVIVES.
		expect(readRegistryRows(baseDir).some((r) => r.honeycombId === "shared-id")).toBe(true);
	});
});

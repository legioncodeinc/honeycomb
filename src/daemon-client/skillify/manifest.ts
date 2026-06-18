/**
 * Pull manifest — PRD-018b (FR-8 / b-AC manifest tracking) + 018c (FR-6 backfill source).
 *
 * The on-disk record of every globally-installed pulled skill:
 *
 *   `~/.honeycomb/state/skillify/pull-manifest.json` = `PullManifestEntry[]`
 *
 * It is the single source of truth for the two reversibility/coverage operations 018
 * adds on top of the 016 fan-out:
 *
 *   - `honeycomb skill unpull` (018b) reverses ONLY pull-managed entries — it reads the
 *     manifest, removes the recorded files + symlinks, and deletes the record. A skill the
 *     user mined themselves (never in the manifest) is never touched.
 *   - `backfillSymlinks` (018c FR-6/FR-7) scans the manifest for ALL globally-installed
 *     entries at the end of every non-dry-run global pull and ensures each has a link in
 *     every currently-detected root — closing the gap where a `skipped` up-to-date skill
 *     never triggers per-row fan-out, so a newly-installed agent still inherits prior pulls.
 *
 * ── Thin-client, filesystem-only (the daemon-only invariant) ────────────────
 * This lives under `src/daemon-client/` and touches `node:fs` + the user's home ONLY. The
 * manifest is LOCAL bookkeeping — it records what a pull wrote locally, NOT team state —
 * so it opens NO DeepLake connection (D-3), mirroring `watermark.ts` / `config.ts`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { type PullManifestEntry, type PullManifestStore, type SkillInstall } from "./contracts.js";

/** The default `~/.honeycomb/state/skillify` state root (mirrors `watermark.ts`). */
export function defaultManifestBaseDir(): string {
	return join(homedir(), ".honeycomb", "state", "skillify");
}

/** The manifest file name under the state root. */
const MANIFEST_FILE = "pull-manifest.json";

/**
 * Build a filesystem {@link PullManifestStore} rooted at `baseDir` (default
 * {@link defaultManifestBaseDir}). A test injects a temp dir so no real `~` is touched.
 * Entries are keyed by `dirName` (`<name>--<author>`); a re-pull replaces the record.
 */
export function createPullManifestStore(baseDir: string = defaultManifestBaseDir()): PullManifestStore {
	const filePath = join(baseDir, MANIFEST_FILE);

	const readAll = (): PullManifestEntry[] => {
		try {
			const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
			if (!Array.isArray(parsed)) return [];
			return parsed.map(normalizeEntry).filter((e): e is PullManifestEntry => e !== null);
		} catch {
			return [];
		}
	};

	const writeAll = (entries: readonly PullManifestEntry[]): void => {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, `${JSON.stringify(entries, null, 2)}\n`, "utf-8");
	};

	return {
		read(): readonly PullManifestEntry[] {
			return readAll();
		},

		record(entry: PullManifestEntry): void {
			const normalized = normalizeEntry(entry);
			if (normalized === null) return;
			const entries = readAll().filter((e) => e.dirName !== normalized.dirName);
			entries.push(normalized);
			writeAll(entries);
		},

		remove(dirName: string): PullManifestEntry | null {
			const entries = readAll();
			const target = entries.find((e) => e.dirName === dirName) ?? null;
			if (target === null) return null;
			writeAll(entries.filter((e) => e.dirName !== dirName));
			return target;
		},
	};
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

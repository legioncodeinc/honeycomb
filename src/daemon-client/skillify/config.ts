/**
 * Skillify scope config — PRD-018a (a-AC-2 / a-AC-3 / FR-4 / FR-5 / FR-6).
 *
 * The on-disk record of HOW a user shares their mined skills:
 *
 *   `~/.honeycomb/state/skillify/config.json` = `{ scope, team, install }`
 *
 *   - `scope`   `me` (private) | `team` (co-owned). The default is `me`.
 *   - `team`    the contributor user list a `team`-scoped publish carries (FR-5).
 *   - `install` `project` (cwd `.claude/skills`) | `global` (`~/.claude/skills`).
 *               The default is `project`. Drives 018c's global-only fan-out gating.
 *
 * ── Legacy `org` coercion on READ (a-AC-3 / D-5 / FR-6) ──────────────────────
 * PRD-011 retired the `org` scope; old config files may still carry `scope: "org"`.
 * On READ the value is coerced to `team` IN MEMORY — the file is NOT rewritten (D-5:
 * "keep old config files working; the file is rewritten only on the next explicit
 * set"). So a `honeycomb skill scope team` rewrites it; a passive read leaves the
 * legacy file untouched but the in-memory value is always a valid `me`|`team`.
 *
 * ── Thin-client, filesystem-only (the daemon-only invariant) ────────────────
 * This module lives under `src/daemon-client/` — a NON-daemon root the invariant test
 * scans — and touches `node:fs` + the user's home ONLY. The config is LOCAL bookkeeping
 * (it shapes what a publish carries; the publish itself goes through the daemon). It
 * opens NO DeepLake connection, mirroring `watermark.ts`'s state-root convention.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { honeycombStateDir, legacyHoneycombDir, preferExistingPath } from "../../shared/fleet-root.js";
import { type SkillInstall, type SkillScope } from "./contracts.js";

/** The default `~/.apiary/honeycomb/state/skillify` state root (mirrors `watermark.ts`, PRD-072b). */
export function defaultConfigBaseDir(): string {
	return join(honeycombStateDir(), "state", "skillify");
}

/** The legacy `~/.honeycomb/state/skillify` state root read as a fallback during the window. */
export function legacyConfigBaseDir(): string {
	return join(legacyHoneycombDir(), "state", "skillify");
}

/** The config file name under the state root. */
const CONFIG_FILE = "config.json";

/**
 * The resolved skillify sharing config (a-AC-2 / FR-4). Always normalized: `scope` is
 * a valid `me`|`team` (a legacy `org` coerced to `team`), `team` is a deduped string
 * list, `install` is `project`|`global`.
 */
export interface SkillifyConfig {
	/** The publish scope — `me` (private) | `team` (co-owned). Default `me`. */
	readonly scope: SkillScope;
	/** The team contributor user list a `team`-scoped publish carries (FR-5). */
	readonly team: readonly string[];
	/** Where SKILL.md lands — `project` (cwd) | `global` (home). Default `project`. */
	readonly install: SkillInstall;
}

/** The canonical default config (a-AC-3): `me` scope, empty team, `project` install. */
export const DEFAULT_CONFIG: SkillifyConfig = Object.freeze({
	scope: "me",
	team: Object.freeze([]) as readonly string[],
	install: "project",
});

/** A filesystem skillify config store — read (with coercion) + write. Filesystem-only. */
export interface SkillifyConfigStore {
	/**
	 * Read the persisted config, coercing the legacy `org` scope to `team` IN MEMORY
	 * (a-AC-3 / D-5). A missing/garbled file resolves to {@link DEFAULT_CONFIG}. The file
	 * is NEVER rewritten on read — only an explicit {@link SkillifyConfigStore.write} does.
	 */
	read(): SkillifyConfig;
	/**
	 * Persist a config (the explicit set — `honeycomb skill scope …`). This is the ONLY
	 * path that rewrites the file, so a legacy `org` is migrated to `team` only here.
	 * Returns the normalized config now on disk.
	 */
	write(config: SkillifyConfig): SkillifyConfig;
}

/** The raw shape on disk — every field optional + untrusted (coerced on read). */
interface RawConfigFile {
	readonly scope?: unknown;
	readonly team?: unknown;
	readonly install?: unknown;
}

/**
 * Build a filesystem {@link SkillifyConfigStore} rooted at `baseDir` (default
 * {@link defaultConfigBaseDir}). A test injects a temp dir so no real `~` is touched.
 *
 * PRD-072b window fallback: with the PRODUCTION default base dir (no injected `baseDir`), reads
 * resolve new-path-first then the legacy `~/.honeycomb/state/skillify/config.json`, so an
 * unmigrated legacy config never silently reverts to defaults. Writes always target the new path.
 */
export function createSkillifyConfigStore(baseDir?: string, legacyBaseDir?: string): SkillifyConfigStore {
	const filePath = join(baseDir ?? defaultConfigBaseDir(), CONFIG_FILE);
	const legacyBase = legacyBaseDir ?? (baseDir === undefined ? legacyConfigBaseDir() : undefined);
	const readPath = (): string =>
		legacyBase !== undefined ? preferExistingPath(filePath, join(legacyBase, CONFIG_FILE)) : filePath;

	return {
		read(): SkillifyConfig {
			try {
				const raw = JSON.parse(readFileSync(readPath(), "utf-8")) as RawConfigFile;
				return normalizeConfig(raw);
			} catch {
				// Missing or malformed → the canonical default (never throws on read).
				return DEFAULT_CONFIG;
			}
		},

		write(config: SkillifyConfig): SkillifyConfig {
			const normalized = normalizeConfig(config);
			mkdirSync(dirname(filePath), { recursive: true });
			writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
			return normalized;
		},
	};
}

/**
 * Coerce a raw/untrusted config into a normalized {@link SkillifyConfig} (a-AC-3). The
 * legacy `org` scope becomes `team`; any other invalid scope falls back to `me`. `team`
 * is filtered to non-empty strings + deduped; `install` defaults to `project`.
 */
export function normalizeConfig(raw: Pick<RawConfigFile, "scope" | "team" | "install">): SkillifyConfig {
	return {
		scope: coerceScope(raw.scope),
		team: normalizeTeam(raw.team),
		install: coerceInstall(raw.install),
	};
}

/**
 * Coerce an untrusted scope value to a valid {@link SkillScope} (a-AC-3 / FR-6). The
 * RETIRED `org` value is silently coerced to `team` (PRD-011 retired `org`); `team`
 * stays `team`; anything else (including a missing value) falls back to `me`.
 */
export function coerceScope(value: unknown): SkillScope {
	if (value === "team" || value === "org") return "team";
	return "me";
}

/** Coerce an untrusted install value to a valid {@link SkillInstall} (default `project`). */
function coerceInstall(value: unknown): SkillInstall {
	return value === "global" ? "global" : "project";
}

/** Normalize a `team` list: keep non-empty strings, trim, dedupe, preserve order. */
function normalizeTeam(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (trimmed === "" || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

/**
 * Parse a comma-separated `--users alice,bob` value into a normalized user list
 * (a-AC-2). Splits on commas, trims, drops empties, dedupes — so `alice, bob,,alice`
 * resolves to `["alice", "bob"]`.
 */
export function parseUsersList(value: string): readonly string[] {
	return normalizeTeam(value.split(","));
}

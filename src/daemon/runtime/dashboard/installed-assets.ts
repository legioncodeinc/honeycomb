/**
 * Local installed-asset scanner — PRD-036a (the daemon-side discovery pass).
 *
 * A READ-ONLY filesystem walk that scans the supported harnesses' asset roots
 * (`.claude/skills`, `.claude/agents`, `.cursor/skills`, … ) for installed skills
 * and agents and returns a normalized {@link LocalAssetInventory}. This is the
 * missing data source that makes locally-present-but-unsynced assets visible:
 * today the dashboard reads only the DeepLake `skills` table and shows 0 even
 * though ~27 skills sit on disk under `.claude/skills/`.
 *
 * It NEVER writes/installs/modifies an asset and NEVER touches DeepLake (the union
 * with the substrate is PRD-036b's job). The scan is fail-soft end to end:
 *   - a missing/empty root contributes nothing (no throw — mirrors the
 *     `harness-sync.ts` ENOENT handling),
 *   - an unreadable dir/file is skipped,
 *   - any unexpected error degrades the whole scan to an EMPTY inventory, never a
 *     500 (D-3).
 *
 * Detection rules (036a):
 *   - SKILL  — a child directory of a skills root containing a `SKILL.md`. The dir
 *     name is the `name`; the description comes from the `SKILL.md` YAML
 *     frontmatter `description:` (fallback: first `#` heading; else "").
 *   - AGENT  — a `*.md` file directly under an agents root. The basename (sans
 *     `.md`) is the `name`; description from its frontmatter.
 *
 * Scope (036a): project root → `repository`; global root → `user`.
 *
 * Dedupe (D-2): the same logical asset under multiple harness roots collapses to
 * ONE {@link DiscoveredAsset} keyed `(assetType, name)`, accumulating every
 * `sourceHarnesses` + `paths`.
 *
 * Roots are INJECTABLE (D-4): `projectRoot` defaults to `process.cwd()`,
 * `globalRoot` defaults to `os.homedir()`. The DECISION (D-1 ledger) is to scan
 * the PROJECT root ONLY by default (no `~` walk in a repo dashboard); the global
 * root is scanned only when `includeGlobal: true` is passed, behind a future flag.
 * Tests point both roots at temp dirs and never scan the real home directory.
 *
 * Names used as map keys / paths are sanitized; the scanner never follows a path
 * outside the configured roots (D-5).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";

import type { DiscoveredAsset, LocalAssetInventory } from "../../../dashboard/contracts.js";

/** The canonical file inside each skill dir (mirrors `install-target.ts`). */
const SKILL_FILE = "SKILL.md";

/**
 * The supported harness asset roots (PRD-036a "Directories to scan"). A small
 * STATIC list owned by the scanner (OQ-3 → static is simpler and drift-free for
 * the fixed v1 harness set). Each harness contributes a `skills/` and an
 * `agents/` subdir under its dotfolder; the `harness` name aligns with the
 * connector/shim names (`claude-code`, `cursor`, `codex`, `hermes`, `pi`,
 * `openclaw`). Adding a harness here is the only edit a new host needs.
 */
interface HarnessAssetRoot {
	/** The harness identity recorded in `sourceHarnesses` (e.g. `claude-code`). */
	readonly harness: string;
	/** The dotfolder under a root, e.g. `.claude`. */
	readonly dir: string;
}

/** The fixed v1 harness dotfolders. */
const HARNESS_ROOTS: readonly HarnessAssetRoot[] = Object.freeze([
	{ harness: "claude-code", dir: ".claude" },
	{ harness: "cursor", dir: ".cursor" },
	{ harness: "codex", dir: ".codex" },
	{ harness: "hermes", dir: ".hermes" },
	{ harness: "pi", dir: ".pi" },
	{ harness: "openclaw", dir: ".openclaw" },
]);

/** Options for {@link scanInstalledAssets} — all roots injectable (D-4). */
export interface ScanInstalledAssetsOptions {
	/** The project root (workspace `cwd`). Scope `repository`. Default `process.cwd()`. */
	readonly projectRoot?: string;
	/** The global root (`~`). Scope `user`. Default `os.homedir()`. */
	readonly globalRoot?: string;
	/**
	 * Scan the global (`~`) root too? Default FALSE (D-1): a repo dashboard scans
	 * the project root only, so a user's unrelated global skills are not surfaced.
	 * A test or a future flag flips this to walk an injected global temp dir.
	 */
	readonly includeGlobal?: boolean;
}

/** A single (root, harness, scope) the scan walks. */
interface ScanRoot {
	/** Absolute path to the harness dotfolder, e.g. `<projectRoot>/.claude`. */
	readonly base: string;
	/** The harness identity. */
	readonly harness: string;
	/** The derived scope (`repository` for project, `user` for global). */
	readonly scope: string;
}

/**
 * Scan the configured roots for installed skills + agents and return a normalized,
 * deduped {@link LocalAssetInventory}. READ-ONLY and fail-soft: any unexpected
 * error degrades to an empty inventory (never throws — D-3).
 */
export async function scanInstalledAssets(options: ScanInstalledAssetsOptions = {}): Promise<LocalAssetInventory> {
	try {
		const projectRoot = options.projectRoot ?? process.cwd();
		const globalRoot = options.globalRoot ?? homedir();
		const includeGlobal = options.includeGlobal ?? false;

		// Build the (root × harness) walk list. Project first (its scope wins on a
		// tie via accumulation order), global only when explicitly requested (D-1).
		const roots: ScanRoot[] = [];
		for (const h of HARNESS_ROOTS) {
			roots.push({ base: join(projectRoot, h.dir), harness: h.harness, scope: "repository" });
		}
		if (includeGlobal) {
			for (const h of HARNESS_ROOTS) {
				roots.push({ base: join(globalRoot, h.dir), harness: h.harness, scope: "user" });
			}
		}

		// Accumulators keyed `(assetType, name)` so the same logical asset under
		// multiple harness roots dedupes into one entry (D-2).
		const skills = new Map<string, MutableAsset>();
		const agents = new Map<string, MutableAsset>();

		for (const root of roots) {
			await collectSkills(join(root.base, "skills"), root, skills);
			await collectAgents(join(root.base, "agents"), root, agents);
		}

		return {
			skills: finalize(skills),
			agents: finalize(agents),
		};
	} catch {
		// D-3: a discovery error degrades to an empty inventory, never a throw.
		return { skills: [], agents: [] };
	}
}

/** A discovered asset under accumulation (mutable harness/path sets before freeze). */
interface MutableAsset {
	name: string;
	description: string;
	assetType: "skill" | "agent";
	scope: string;
	readonly sourceHarnesses: string[];
	readonly paths: string[];
}

/**
 * Read a directory's entries, returning `[]` when the directory does not exist or
 * is unreadable (ENOENT/EACCES/ENOTDIR) — the graceful read modeled on
 * `harness-sync.ts`. Only a genuinely unexpected error propagates to the caller's
 * fail-soft boundary.
 */
async function readDirSafe(dir: string): Promise<Dirent[]> {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isIgnorableFsError(err)) return [];
		throw err;
	}
}

/** Read a file's text, returning `null` when it is missing/unreadable (skip it). */
async function readFileSafe(filePath: string): Promise<string | null> {
	try {
		return await readFile(filePath, "utf8");
	} catch (err) {
		if (isIgnorableFsError(err)) return null;
		throw err;
	}
}

/** True for the filesystem errors a fail-soft scan treats as "contributes nothing". */
function isIgnorableFsError(err: unknown): boolean {
	if (!(err instanceof Error) || !("code" in err)) return false;
	const code = (err as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM";
}

/**
 * Collect skills under a skills root: each child dir containing a `SKILL.md` is a
 * skill (dir name → `name`, frontmatter/heading → `description`). Accumulates into
 * `acc` keyed `(skill, name)` for cross-harness dedupe (D-2).
 */
async function collectSkills(skillsRoot: string, root: ScanRoot, acc: Map<string, MutableAsset>): Promise<void> {
	const entries = await readDirSafe(skillsRoot);
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const name = sanitizeName(entry.name);
		if (name === "") continue;
		const skillFile = join(skillsRoot, entry.name, SKILL_FILE);
		const markdown = await readFileSafe(skillFile);
		if (markdown === null) continue; // not a skill dir (no SKILL.md) or unreadable — skip
		accumulate(acc, "skill", name, root, skillFile, extractDescription(markdown));
	}
}

/**
 * Collect agents under an agents root: each `*.md` FILE directly under the root is
 * an agent (basename sans `.md` → `name`, frontmatter → `description`).
 */
async function collectAgents(agentsRoot: string, root: ScanRoot, acc: Map<string, MutableAsset>): Promise<void> {
	const entries = await readDirSafe(agentsRoot);
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
		const base = entry.name.slice(0, -3); // strip `.md`
		const name = sanitizeName(base);
		if (name === "") continue;
		const agentFile = join(agentsRoot, entry.name);
		const markdown = await readFileSafe(agentFile);
		if (markdown === null) continue; // unreadable — skip
		accumulate(acc, "agent", name, root, agentFile, extractDescription(markdown));
	}
}

/**
 * Add one discovered install to the accumulator under its `(assetType, name)` key,
 * or fold it into an existing entry (append the harness + path, keep the first
 * non-empty description). This is the dedupe (D-2): N harness installs of the same
 * logical asset → ONE entry with every harness and path.
 */
function accumulate(
	acc: Map<string, MutableAsset>,
	assetType: "skill" | "agent",
	name: string,
	root: ScanRoot,
	path: string,
	description: string,
): void {
	const key = `${assetType} ${name}`;
	const existing = acc.get(key);
	if (existing === undefined) {
		acc.set(key, {
			name,
			description,
			assetType,
			scope: root.scope,
			sourceHarnesses: [root.harness],
			paths: [path],
		});
		return;
	}
	if (!existing.sourceHarnesses.includes(root.harness)) existing.sourceHarnesses.push(root.harness);
	existing.paths.push(path);
	// Keep the first non-empty description we saw; backfill if the original was "".
	if (existing.description === "" && description !== "") existing.description = description;
}

/** Freeze the accumulator into the readonly contract shape, sorted by name for stable output. */
function finalize(acc: Map<string, MutableAsset>): DiscoveredAsset[] {
	return [...acc.values()]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((a) => ({
			name: a.name,
			description: a.description,
			assetType: a.assetType,
			scope: a.scope,
			sourceHarnesses: [...a.sourceHarnesses],
			paths: [...a.paths],
		}));
}

/** Matches a leading `---\n…\n---` YAML frontmatter block (mirrors `assets/identity.ts`). */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/**
 * Extract a short description from an asset's markdown. Prefers the YAML
 * frontmatter `description:` value (single-line, optionally quoted); falls back to
 * the first `#` heading text; else "". Deliberately minimal string surgery — it
 * reads the ONE key we need rather than parsing arbitrary YAML, so it pulls in no
 * YAML dependency and cannot be tricked into executing a tag (same posture as
 * `parseHoneycombId`).
 */
export function extractDescription(markdown: string): string {
	const fm = FRONTMATTER_RE.exec(markdown);
	if (fm !== null) {
		const block = fm[1] ?? "";
		const descLine = /^description:\s*(.*)$/m.exec(block);
		if (descLine !== null) {
			const value = unquote((descLine[1] ?? "").trim());
			if (value !== "") return value;
		}
	}
	// Fallback: the first ATX `#` heading's text (after the frontmatter, if any).
	const body = fm !== null ? markdown.slice(fm[0].length) : markdown;
	const heading = /^#{1,6}\s+(.+?)\s*$/m.exec(body);
	if (heading !== null) return (heading[1] ?? "").trim();
	return "";
}

/** Strip a single layer of matching surrounding single/double quotes. */
function unquote(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return value.slice(1, -1);
		}
	}
	return value;
}

/**
 * Reduce an asset name to a safe single segment — only `[A-Za-z0-9._-]`, every
 * other char (including `/`, `\`, `..`) becomes `_` (mirrors the `install-target.ts`
 * `sanitizeSegment` posture, D-5). A crafted name can never be used to traverse
 * out of a configured root or collide a map key with a path separator.
 */
function sanitizeName(name: string): string {
	return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

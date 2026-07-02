/**
 * Obsidian source provider — PRD-013c (Wave 2 fills the Wave-1 stub).
 *
 * A provider READS an external knowledge base and YIELDS {@link SourceArtifact}s; it
 * NEVER writes to DeepLake and NEVER modifies the vault. This module opens a vault
 * directory read-only, walks its Markdown files, and emits one artifact per `.md`
 * carrying the provenance quartet, heading-split chunks, and the vault topology +
 * wiki-link graph — exactly the shape the provider-agnostic lifecycle engine
 * (`lifecycle.ts`) turns into `memory_artifacts` / `document_chunk` / graph rows. The
 * lifecycle owns every WRITE (and every soft-delete on the c-AC-2/c-AC-5 watcher
 * path); this provider only surfaces the read + the change set.
 *
 * ── The c-AC contract this fills ─────────────────────────────────────────────
 *   - c-AC-1: each `.md` → one `note` artifact carrying the provenance quartet
 *             (`source_id` / `source_kind:'obsidian'` / vault-relative `source_path`
 *             / `source_root`=vault dir); the vault TOPOLOGY mounts into the ontology
 *             as `graphTriples` (root entity, folders→groups, files→documents,
 *             headings→aspects).
 *   - c-AC-3: a file WITH headings → `chunks` split BY heading, each chunk carrying
 *             the vault-relative path + the heading + the line range (in `metadata`),
 *             with `sourcePath` narrowed to a `path#heading` anchor.
 *   - c-AC-4: wiki links `[[Note]]` between notes → dependency edges (`graphTriples`,
 *             predicate {@link WIKILINK_PREDICATE}).
 *   - c-AC-2/c-AC-5: the watcher diff. {@link ObsidianProvider.changes} fingerprints
 *             the vault and reports `{ added, modified, removed }` vs a prior
 *             snapshot; the daemon/lifecycle drives re-index (added/modified →
 *             `index({ paths })`) and soft-delete (removed → `updateInPlace`) from it.
 *             A rename surfaces as one `removed` + one `added` (delete + add).
 *   - c-AC-6: a MALFORMED file → a `failure` {@link SourceArtifact}; OTHER files index
 *             normally (one bad file never aborts the batch).
 *
 * This module implements EXACTLY the {@link SourceProvider} seam (+ a `changes`
 * watcher helper) and conforms its artifacts to {@link SourceArtifact}. It does NOT
 * touch the lifecycle engine, the catalog, or the contracts.
 */

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type {
	IndexScope,
	Provenance,
	ProviderHealth,
	SourceArtifact,
	SourceChunk,
	SourceConfig,
	HiveGraphTriple,
	SourceProvider,
} from "../contracts.js";

// ────────────────────────────────────────────────────────────────────────────
// Config — the boundary shape (zod). The vault path + scope arrive from the CLI /
// `POST /api/sources` via the generic `SourceConfig.settings` blob; this provider
// reads its own keys out and validates them at the untrusted boundary.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The validated Obsidian provider config. `vaultPath` is the absolute (or
 * cwd-relative) directory of the vault — it becomes `source_root` on every derived
 * row and the anchor every `source_path` is relative to. `sourceId` is the source
 * instance id (the purge key) the provenance quartet carries; `org`/`workspace` are
 * the tenancy the source is mounted into.
 */
export interface ObsidianConfig {
	/** The vault directory (read-only root). Becomes `source_root`. */
	readonly vaultPath: string;
	/** The source instance id — the purge key on every derived row. */
	readonly sourceId: string;
	/** The org the source is mounted into. */
	readonly org: string;
	/** The workspace the source is mounted into. */
	readonly workspace: string;
}

/**
 * zod schema for the Obsidian settings blob (boundary validation, FR-1/FR-2). A
 * malformed config is REJECTED here (drop-invalid via {@link parseObsidianConfig})
 * rather than crashing the provider mid-scan. `vaultPath` accepts either a top-level
 * `root` (the generic `SourceConfig.root`) or `settings.vaultPath`.
 */
export const ObsidianConfigSchema = z.object({
	vaultPath: z.string().min(1),
	sourceId: z.string().min(1),
	org: z.string().min(1),
	workspace: z.string().default("default"),
});

/**
 * Parse a generic {@link SourceConfig} (or any candidate) into a typed
 * {@link ObsidianConfig}, or return `null` on an invalid body. Reads `vaultPath`
 * from `settings.vaultPath` first, falling back to the generic `root`. Drop-invalid
 * (never throws) so a bad CLI / API config routes to a 400 rather than a crash.
 */
export function parseObsidianConfig(candidate: unknown): ObsidianConfig | null {
	if (candidate === null || typeof candidate !== "object") return null;
	const c = candidate as Record<string, unknown>;
	const settings = (typeof c.settings === "object" && c.settings !== null ? c.settings : {}) as Record<string, unknown>;
	const vaultPath = typeof settings.vaultPath === "string" && settings.vaultPath.length > 0 ? settings.vaultPath : c.root;
	const parsed = ObsidianConfigSchema.safeParse({
		vaultPath,
		sourceId: c.sourceId ?? settings.sourceId,
		org: c.org,
		workspace: c.workspace,
	});
	return parsed.success ? parsed.data : null;
}

// ────────────────────────────────────────────────────────────────────────────
// Graph predicates — the vault topology → ontology mapping (FR-3 / c-AC-1/c-AC-4).
// Canonical + stable so a re-index produces the same edges and a purge sweeps them.
// ────────────────────────────────────────────────────────────────────────────

/** The vault root → entity marker predicate (root IS_A vault). */
export const VAULT_ROOT_PREDICATE = "is_a" as const;
/** A folder (group) contains a note/sub-folder. */
export const CONTAINS_PREDICATE = "contains" as const;
/** A note has a heading (aspect). */
export const HAS_HEADING_PREDICATE = "has_heading" as const;
/** A wiki link `[[B]]` in note A → A depends_on B (the dependency edge, c-AC-4). */
export const WIKILINK_PREDICATE = "depends_on" as const;

/** The canonical graph-node name for the vault root. */
export const VAULT_ROOT_NODE = "vault:root" as const;
/** The graph-node type for the vault root object of the `is_a` triple. */
export const VAULT_NODE_TYPE = "vault" as const;

// ────────────────────────────────────────────────────────────────────────────
// Markdown parsing — pure helpers (no I/O). Heading split + wiki-link extraction.
// ────────────────────────────────────────────────────────────────────────────

/** An ATX heading line: 1–6 leading `#`, a space, then the heading text. */
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
/** A wiki link `[[Target]]`, `[[Target|alias]]`, `[[Target#heading]]`. Global. */
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
/** A fenced code-block delimiter (``` or ~~~) — headings inside a fence are literal. */
const FENCE_RE = /^(```|~~~)/;

/** A heading-bounded section of a note (the unit a chunk is built from). */
export interface HeadingSection {
	/** The heading text (`""` for the pre-first-heading preamble). */
	readonly heading: string;
	/** 1-based line where the section starts (the heading line, or 1 for preamble). */
	readonly lineStart: number;
	/** 1-based line where the section ends (inclusive). */
	readonly lineEnd: number;
	/** The section body text (heading line included for a real heading). */
	readonly content: string;
}

/**
 * Split a note's text into heading-bounded sections (c-AC-3). Each ATX heading opens
 * a new section running to the line before the next heading; any text before the
 * first heading is a preamble section with an empty heading. Code-fenced `#` lines
 * are NOT treated as headings. Line numbers are 1-based and inclusive. Pure.
 */
export function splitByHeading(text: string): HeadingSection[] {
	const lines = text.split("\n");
	const sections: HeadingSection[] = [];
	let curHeading = "";
	let curStart = 1;
	let curLines: string[] = [];
	let inFence = false;

	const flush = (endLine: number): void => {
		// Emit the accumulated section unless it is an empty preamble (no content).
		if (curLines.length === 0 && curHeading === "" && sections.length === 0 && curStart > endLine) return;
		const content = curLines.join("\n");
		if (curHeading === "" && content.trim() === "" && sections.length === 0 && curStart === 1 && curLines.length <= 1) {
			// A file that opens directly on a heading has no real preamble — skip it.
			return;
		}
		sections.push({ heading: curHeading, lineStart: curStart, lineEnd: endLine, content });
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNo = i + 1;
		if (FENCE_RE.test(line.trim())) inFence = !inFence;
		const headingMatch = inFence ? null : HEADING_RE.exec(line);
		if (headingMatch !== null) {
			// Close the section that ended on the previous line, then open this heading.
			flush(lineNo - 1);
			curHeading = headingMatch[2];
			curStart = lineNo;
			curLines = [line];
		} else {
			curLines.push(line);
		}
	}
	flush(lines.length);
	return sections;
}

/**
 * Extract the distinct wiki-link targets from a note's text (c-AC-4). Strips an
 * `|alias` and a `#heading` fragment, trims, and de-duplicates while preserving
 * first-seen order. Empty targets are dropped. Pure.
 */
export function extractWikiLinks(text: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	WIKILINK_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = WIKILINK_RE.exec(text)) !== null) {
		const raw = m[1];
		const target = raw.split("|")[0].split("#")[0].trim();
		if (target.length === 0 || seen.has(target)) continue;
		seen.add(target);
		out.push(target);
	}
	return out;
}

/** A vault-relative note name (path without the `.md` extension), POSIX slashes. */
function noteName(relPath: string): string {
	const noExt = relPath.replace(/\.md$/i, "");
	return noExt.split(path.sep).join("/");
}

/** Build a stable `path#heading` anchor for a chunk's narrowed `sourcePath`. */
function headingAnchor(relPath: string, heading: string): string {
	const slug = heading.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
	return slug.length > 0 ? `${relPath}#${slug}` : relPath;
}

/** A lowercase-hex sha256 over content — the per-file fingerprint (FR-6). Pure. */
export function fingerprint(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * A file is MALFORMED (c-AC-6) when its decoded text contains a NUL byte — the
 * reliable signal of a binary/corrupt file masquerading as `.md` (a genuine read
 * error is caught separately and also routes to a failure artifact). Pure.
 */
export function isMalformed(content: string): boolean {
	return content.includes("\u0000");
}

// ────────────────────────────────────────────────────────────────────────────
// Path validation — prevent directory traversal attacks (security boundary).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The selected Obsidian vault root is the filesystem boundary for reads.
 * Vaults may live outside the Honeycomb workspace; each resolved file path must
 * remain inside this root before it can be read.
 */
/**
 * Validate and canonicalize a vault path to prevent directory traversal attacks.
 * A vault path is allowed when it resolves to a real directory. External vaults
 * are supported; containment is enforced for every file read inside that vault.
 *
 * Returns the canonicalized absolute path when valid, or `null` when the path is
 * invalid (empty, missing, or not a directory). Never throws
 * — a validation failure routes to `null` so the caller can reject the config with
 * a clear error rather than crashing the provider.
 *
 * The validation steps (all MUST pass):
 *   1. The candidate path is non-empty.
 *   2. The path resolves to a real directory (via `realpath` + `stat`).
 *
 * Examples:
 *   - `/Users/me/Notes/obsidian` -> valid external vault
 *   - `./vaults/obsidian` -> valid relative vault when it exists
 *   - `/etc/passwd` -> invalid file, not a directory
 */
async function validateVaultPath(candidatePath: string): Promise<string | null> {
	if (candidatePath.length === 0) return null;

	try {
		// Canonicalize the candidate path: resolve symlinks + relative segments.
		// `realpath` throws if the path does not exist, which we catch below.
		const canonicalPath = await realpath(candidatePath);

		// Confirm the canonicalized path is a directory (not a file).
		const st = await stat(canonicalPath);
		if (!st.isDirectory()) return null;

		// All checks passed: the path is a valid vault directory.
		return canonicalPath;
	} catch {
		// Any error (ENOENT, EACCES, ENOTDIR, etc.) → invalid path.
		return null;
	}
}

async function resolveVaultFilePath(vaultRoot: string, relPath: string): Promise<string | null> {
	const candidate = path.resolve(vaultRoot, relPath.split("/").join(path.sep));
	try {
		const canonical = await realpath(candidate);
		return canonical.startsWith(vaultRoot + path.sep) ? canonical : null;
	} catch {
		return candidate.startsWith(vaultRoot + path.sep) ? candidate : null;
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Vault walking — read-only fs. Never writes the vault.
// ────────────────────────────────────────────────────────────────────────────

/** Directory entries Obsidian ignores; we skip them too. */
const IGNORED_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);

/** A read Markdown file: vault-relative path + decoded text + fingerprint. */
interface VaultFile {
	/** Vault-relative POSIX path (e.g. `notes/a.md`). */
	readonly relPath: string;
	/** The decoded UTF-8 text. */
	readonly content: string;
	/** sha256 of the content (the change fingerprint). */
	readonly fingerprint: string;
	/** Whether reading/decoding flagged the file malformed (c-AC-6). */
	readonly malformed: boolean;
	/** The read error reason, when the file could not be read at all. */
	readonly readError?: string;
}

/**
 * Recursively collect the vault-relative POSIX paths of every `.md` file under
 * `vaultRoot`, skipping ignored dirs. Read-only (`readdir`/`stat` only). The result
 * is sorted for deterministic ordering. Throws only if the vault root itself is
 * unreadable (a per-file error is surfaced as a failure artifact, not thrown).
 */
async function collectMarkdownPaths(vaultRoot: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return; // an unreadable sub-dir is skipped, not fatal.
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (IGNORED_DIRS.has(entry.name)) continue;
				await walk(path.join(dir, entry.name));
			} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
				const abs = path.join(dir, entry.name);
				out.push(path.relative(vaultRoot, abs).split(path.sep).join("/"));
			}
		}
	}
	await walk(vaultRoot);
	out.sort();
	return out;
}

/** Read one vault file read-only, classifying malformed / read-error. */
async function readVaultFile(vaultRoot: string, relPath: string): Promise<VaultFile> {
	const abs = await resolveVaultFilePath(vaultRoot, relPath);
	if (abs === null) {
		return {
			relPath,
			content: "",
			fingerprint: "",
			malformed: true,
			readError: "path escapes vault root",
		};
	}
	try {
		const content = await readFile(abs, "utf8");
		return { relPath, content, fingerprint: fingerprint(content), malformed: isMalformed(content) };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return { relPath, content: "", fingerprint: "", malformed: true, readError: reason };
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Artifact construction — pure given a VaultFile + config. Builds the note artifact
// (c-AC-1), heading-split chunks (c-AC-3), and the topology + wiki-link graph
// (c-AC-1/c-AC-4), or a failure artifact (c-AC-6).
// ────────────────────────────────────────────────────────────────────────────

/** Build the provenance quartet + scope for a vault unit (a-AC-3). */
function provenanceFor(config: ObsidianConfig, sourcePath: string): Provenance {
	return {
		sourceId: config.sourceId,
		sourceKind: "obsidian",
		sourcePath,
		sourceRoot: config.vaultPath,
		org: config.org,
		workspace: config.workspace,
	};
}

/** Build the heading-split chunks for a note (c-AC-3). */
function chunksFor(config: ObsidianConfig, file: VaultFile): SourceChunk[] {
	const sections = splitByHeading(file.content);
	const chunks: SourceChunk[] = [];
	let ordinal = 0;
	for (const section of sections) {
		if (section.content.trim() === "") continue; // skip an empty section
		chunks.push({
			provenance: provenanceFor(config, headingAnchor(file.relPath, section.heading)),
			content: section.content,
			ordinal,
			metadata: {
				path: file.relPath,
				heading: section.heading,
				lineStart: section.lineStart,
				lineEnd: section.lineEnd,
				lines: [section.lineStart, section.lineEnd],
			},
		});
		ordinal += 1;
	}
	return chunks;
}

/** Build the topology + wiki-link graph triples for a note (c-AC-1 / c-AC-4). */
function graphTriplesFor(config: ObsidianConfig, file: VaultFile): HiveGraphTriple[] {
	const triples: HiveGraphTriple[] = [];
	const note = noteName(file.relPath);

	// Topology: vault root is_a vault; the containing folder (or root) contains the note.
	triples.push({ subject: VAULT_ROOT_NODE, predicate: VAULT_ROOT_PREDICATE, object: VAULT_NODE_TYPE });
	const dir = path.posix.dirname(file.relPath);
	const folder = dir === "." ? VAULT_ROOT_NODE : `folder:${dir}`;
	if (folder !== VAULT_ROOT_NODE) {
		// Mount the folder chain: root contains folder, folder contains note.
		triples.push({ subject: VAULT_ROOT_NODE, predicate: CONTAINS_PREDICATE, object: folder });
	}
	triples.push({ subject: folder, predicate: CONTAINS_PREDICATE, object: `note:${note}` });

	// Headings → aspects.
	for (const section of splitByHeading(file.content)) {
		if (section.heading === "") continue;
		triples.push({ subject: `note:${note}`, predicate: HAS_HEADING_PREDICATE, object: `heading:${note}#${section.heading}` });
	}

	// Wiki links → dependency edges (c-AC-4). A dangling target (no matching note in
	// the vault) still yields an edge to the named target — the dependency is real
	// evidence even if the target is not yet a file (the PRD open question; we keep
	// the edge rather than dropping it, so the graph records the intent).
	for (const link of extractWikiLinks(file.content)) {
		triples.push({ subject: `note:${note}`, predicate: WIKILINK_PREDICATE, object: `note:${link}` });
	}
	return triples;
}

/** Build a `note` {@link SourceArtifact} for a healthy vault file (c-AC-1). */
function noteArtifact(config: ObsidianConfig, file: VaultFile): SourceArtifact {
	const sections = splitByHeading(file.content);
	const title = noteName(file.relPath).split("/").pop() ?? file.relPath;
	return {
		provenance: provenanceFor(config, file.relPath),
		kind: "note",
		title,
		content: file.content,
		chunks: chunksFor(config, file),
		graphTriples: graphTriplesFor(config, file),
		metadata: {
			fingerprint: file.fingerprint,
			headingCount: sections.filter((s) => s.heading !== "").length,
			wikiLinks: extractWikiLinks(file.content),
		},
	};
}

/** Build a `failure` {@link SourceArtifact} for a malformed/unreadable file (c-AC-6). */
function failureArtifact(config: ObsidianConfig, file: VaultFile): SourceArtifact {
	const reason = file.readError ?? "malformed Markdown (NUL byte / undecodable content)";
	return {
		provenance: provenanceFor(config, file.relPath),
		kind: "note",
		title: file.relPath,
		content: "",
		failure: { reason, detail: { path: file.relPath } },
	};
}

// ────────────────────────────────────────────────────────────────────────────
// The watcher change set (c-AC-2 / c-AC-5).
// ────────────────────────────────────────────────────────────────────────────

/** A vault fingerprint snapshot: vault-relative path → content fingerprint. */
export type VaultSnapshot = Readonly<Record<string, string>>;

/**
 * The change set between a prior {@link VaultSnapshot} and the vault's current state
 * (c-AC-2 / c-AC-5). The daemon/lifecycle drives re-index from it:
 *   - `added` / `modified` → `index({ paths: [...added, ...modified] })` (re-read +
 *     update in place; an unchanged fingerprint is single-flight-skipped, FR-6);
 *   - `removed` → `lifecycle.updateInPlace(sourceId, path)` (soft-delete + chunk
 *     purge). A RENAME surfaces as one `removed` (old) + one `added` (new) — delete +
 *     add (c-AC-5), exactly as the PRD requires.
 * `snapshot` is the new snapshot to persist for the next diff.
 */
export interface VaultChangeSet {
	/** Vault-relative paths present now but absent in the prior snapshot. */
	readonly added: readonly string[];
	/** Paths present in both but whose fingerprint changed. */
	readonly modified: readonly string[];
	/** Paths present in the prior snapshot but absent now (incl. the old half of a rename). */
	readonly removed: readonly string[];
	/** The fresh snapshot to persist for the next `changes()` call. */
	readonly snapshot: VaultSnapshot;
}

// ────────────────────────────────────────────────────────────────────────────
// The provider. `createObsidianProvider(config)` returns the real provider; the
// no-arg `createObsidianProvider()` preserves the Wave-1 stub semantics (a premature
// `sources add obsidian` with no vault fails loud with the owning sub-PRD), so the
// Wave-1 document-worker.test.ts seam-conformance assertions still hold.
// ────────────────────────────────────────────────────────────────────────────

/** A structured "not configured" rejection — fails loud, never silent. */
class ObsidianNotConfiguredError extends Error {
	constructor(method: string) {
		super(`ObsidianProvider.${method} requires a vault config (PRD-013c) — not implemented`);
		this.name = "ObsidianNotConfiguredError";
	}
}

/**
 * The concrete Obsidian provider: the {@link SourceProvider} seam plus the
 * {@link ObsidianProvider.changes} watcher helper (c-AC-2/c-AC-5). The lifecycle calls
 * `connect`/`index`/`health`/`close`; the daemon's watch loop calls `changes`.
 */
export interface ObsidianProvider extends SourceProvider {
	/**
	 * Diff the vault against a prior {@link VaultSnapshot} (c-AC-2 / c-AC-5). Read-only
	 * — fingerprints every `.md` and reports `{ added, modified, removed, snapshot }`.
	 * The caller re-indexes added/modified and soft-deletes removed; a rename is a
	 * removed + an added.
	 */
	changes(previous?: VaultSnapshot): Promise<VaultChangeSet>;
	/** Take a fresh {@link VaultSnapshot} of the vault (read-only). */
	snapshot(): Promise<VaultSnapshot>;
}

/**
 * Build the Obsidian provider. With a config it READS the vault at `config.vaultPath`
 * and yields one artifact per `.md` (note + heading-split chunks + topology/wiki-link
 * graph), a failure artifact per malformed file. With NO config it is the honest
 * unconfigured stub (Wave-1 seam conformance). It NEVER writes the vault or DeepLake.
 *
 * SECURITY: The `config.vaultPath` is canonicalized to a readable directory, and
 * each file read is contained within that canonical vault root. External Obsidian
 * vaults are valid; traversal and symlink escapes from the selected vault are not.
 * Validation is performed asynchronously in `connect()` / `health()` / read paths,
 * so an invalid path returns a clear `unreachable` health status rather than
 * crashing the provider at construction.
 */
export function createObsidianProvider(config?: ObsidianConfig): ObsidianProvider {
	// ── Unconfigured stub (Wave-1 seam conformance) ────────────────────────────
	if (config === undefined) {
		return {
			kind: "obsidian",
			async connect(_cfg: SourceConfig): Promise<ProviderHealth> {
				throw new ObsidianNotConfiguredError("connect (PRD-013c)");
			},
			index(_scope: IndexScope): AsyncIterable<SourceArtifact> {
				throw new ObsidianNotConfiguredError("index (PRD-013c)");
			},
			async health(): Promise<ProviderHealth> {
				return { state: "unreachable", detail: "obsidian provider not configured (PRD-013c)" };
			},
			async close(): Promise<void> {
				/* no resources held */
			},
			async changes(): Promise<VaultChangeSet> {
				throw new ObsidianNotConfiguredError("changes (PRD-013c)");
			},
			async snapshot(): Promise<VaultSnapshot> {
				throw new ObsidianNotConfiguredError("snapshot (PRD-013c)");
			},
		};
	}

	const vaultRoot = config.vaultPath;
	let validatedVaultRoot: string | null = null;

	/** Confirm the vault root is a readable directory (initial health + security gate). */
	async function probe(): Promise<ProviderHealth> {
		// SECURITY: Canonicalize the vault path once; every file read is contained within it.
		// This is the ONLY place the validation runs — it gates every read operation.
		if (validatedVaultRoot === null) {
			validatedVaultRoot = await validateVaultPath(vaultRoot);
			if (validatedVaultRoot === null) {
				return {
					state: "unreachable",
					detail: `vault path is invalid or unreadable: ${vaultRoot}`,
				};
			}
		}

		// The path is validated and canonicalized — confirm it is still a readable directory.
		try {
			const st = await stat(validatedVaultRoot);
			if (!st.isDirectory()) {
				return { state: "unreachable", detail: `vault path is not a directory: ${validatedVaultRoot}` };
			}
			return { state: "connected", detail: `vault: ${validatedVaultRoot}` };
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			return { state: "unreachable", detail: `vault unreadable: ${reason}` };
		}
	}

	return {
		kind: "obsidian",

		async connect(_cfg: SourceConfig): Promise<ProviderHealth> {
			// Read-only: connecting validates the vault path and confirms it is a readable directory.
			return probe();
		},

		async *index(scope: IndexScope): AsyncIterable<SourceArtifact> {
			// SECURITY: The vault path MUST be validated before any read operation.
			if (validatedVaultRoot === null) {
				const health = await probe();
				// Re-check the closure variable AFTER the awaited probe() side effect so TS
				// control-flow narrows `validatedVaultRoot` from `string | null` to `string`.
				if (health.state !== "connected" || validatedVaultRoot === null) {
					// The vault path is invalid or unreadable — yield a failure artifact.
					yield {
						provenance: provenanceFor(config, ""),
						kind: "note",
						title: "vault-validation-failure",
						content: "",
						failure: { reason: health.detail ?? "vault path validation failed", detail: { path: vaultRoot } },
					};
					return;
				}
			}
			// Bind the validated path to a non-null local so it stays `string` across awaits.
			const root = validatedVaultRoot;

			// Narrow to `scope.paths` when the watcher hands a change set (FR-6 single-
			// flight re-index of just the edited files); else walk the whole vault.
			const all = await collectMarkdownPaths(root);
			const narrowed = scope.paths !== undefined ? new Set(scope.paths) : null;
			const targets = narrowed === null ? all : all.filter((p) => narrowed.has(p));
			for (const relPath of targets) {
				const file = await readVaultFile(root, relPath);
				// c-AC-6: a malformed/unreadable file becomes a failure artifact; the loop
				// CONTINUES so every other file still indexes (one bad file never aborts).
				yield file.malformed ? failureArtifact(config, file) : noteArtifact(config, file);
			}
		},

		async health(): Promise<ProviderHealth> {
			return probe();
		},

		async close(): Promise<void> {
			// The provider holds no open handle (each read opens + closes its own fd).
		},

		async snapshot(): Promise<VaultSnapshot> {
			// SECURITY: The vault path MUST be validated before any read operation.
			if (validatedVaultRoot === null) {
				const health = await probe();
				// Re-check the closure variable AFTER the awaited probe() side effect so TS
				// control-flow narrows `validatedVaultRoot` from `string | null` to `string`.
				if (health.state !== "connected" || validatedVaultRoot === null) {
					// The vault path is invalid or unreadable — return an empty snapshot.
					return {};
				}
			}
			// Bind the validated path to a non-null local so it stays `string` across awaits.
			const root = validatedVaultRoot;

			const paths = await collectMarkdownPaths(root);
			const snap: Record<string, string> = {};
			for (const relPath of paths) {
				const file = await readVaultFile(root, relPath);
				snap[relPath] = file.fingerprint;
			}
			return snap;
		},

		async changes(previous: VaultSnapshot = {}): Promise<VaultChangeSet> {
			const current = await this.snapshot();
			const added: string[] = [];
			const modified: string[] = [];
			const removed: string[] = [];
			for (const [p, fp] of Object.entries(current)) {
				if (!(p in previous)) added.push(p);
				else if (previous[p] !== fp) modified.push(p);
			}
			for (const p of Object.keys(previous)) {
				if (!(p in current)) removed.push(p);
			}
			added.sort();
			modified.sort();
			removed.sort();
			return { added, modified, removed, snapshot: current };
		},
	};
}

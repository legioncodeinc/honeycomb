/**
 * PRD-033a — Content + merkle hashing (FR-4 / FR-6 / a-AC-2).
 *
 * The hash is the artifact's change-detection + integrity signal, distinct from
 * the monotonic `version` (FR-5): the version orders intent, the hash identifies
 * content. Two artifact shapes, two hash rules:
 *
 *   - AGENT (a single file) → the sha256 of the file's content.
 *   - SKILL (a directory)   → a MERKLE-style root: sha256 over the SORTED list of
 *     `(relative-path, content-hash)` pairs. Sorting by path makes the root
 *     ORDER-INDEPENDENT — the same directory hashes to the same root regardless
 *     of filesystem walk order (a-AC-2) — while still changing if ANY file's
 *     path or content changes.
 *
 * The registry records THREE hashes per artifact (FR-6): `lastSyncedHash` /
 * `localHash` / `remoteHash`, so a future three-way merge has real data from day
 * one even though v1 only RECORDS them (it does not merge — FR-6).
 *
 * Pure + local (D-6): sha256 over bytes the caller supplies. This module does no
 * filesystem walk itself (the caller enumerates files and passes the
 * `(path, content)` pairs) so it stays trivially testable and deterministic, and
 * opens nothing.
 */

import { createHash } from "node:crypto";

/** sha256 hex of a UTF-8 string or buffer — the single hash primitive. */
export function sha256(content: string | Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

/** One file in a skill directory: its path RELATIVE to the skill root + its content. */
export interface FileEntry {
	/** Path relative to the skill root, with `/` separators (normalized by the caller). */
	readonly relativePath: string;
	/** The file's content (string or raw bytes). */
	readonly content: string | Uint8Array;
}

/**
 * The content hash of an AGENT artifact (FR-4): a single file → the sha256 of its
 * content. The simplest case — there is no directory structure to fold in.
 */
export function hashAgentFile(content: string | Uint8Array): string {
	return sha256(content);
}

/**
 * The MERKLE root of a SKILL directory (FR-4 / a-AC-2). Each file is reduced to a
 * `(relativePath, sha256(content))` leaf; the leaves are SORTED by relative path;
 * the root is the sha256 over the joined `path\0hash\n` lines. Sorting is what
 * makes the root ORDER-INDEPENDENT (a-AC-2): the input file order never affects
 * the root, but a changed path or changed content always does.
 *
 * The `\0` separator between path and hash, and the `\n` between leaves, prevent
 * a boundary-ambiguity collision (no path/hash pair can masquerade as another by
 * shifting the split point).
 */
export function hashSkillDir(files: readonly FileEntry[]): string {
	const leaves = files
		.map((f) => ({ path: normalizeRelPath(f.relativePath), hash: sha256(f.content) }))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const folded = leaves.map((leaf) => `${leaf.path}\0${leaf.hash}`).join("\n");
	return sha256(folded);
}

/**
 * The unified `hashArtifact` entry point (a-AC-2). Routes by asset kind: an agent
 * hashes its single file's content; a skill hashes its directory as a merkle root.
 * The caller supplies the already-enumerated file entries (one for an agent, many
 * for a skill).
 */
export function hashArtifact(kind: "agent" | "skill", files: readonly FileEntry[]): string {
	if (kind === "agent") {
		// An agent is a single file; hash its content directly.
		const only = files[0];
		return hashAgentFile(only?.content ?? "");
	}
	return hashSkillDir(files);
}

/** Normalize a relative path to `/` separators with no leading `./` so sorting is stable. */
function normalizeRelPath(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

// ── The three recorded hashes (FR-6) ─────────────────────────────────────────

/**
 * The three hashes the registry records per artifact (FR-6 / a-AC-1). v1 RECORDS
 * them (so three-way-merge data exists from day one) but does NOT act on them —
 * no merge in v1.
 *
 *   - `lastSyncedHash` — the hash at the last successful sync (the merge base).
 *   - `localHash`      — the current local content hash (this machine's copy).
 *   - `remoteHash`     — the hash of the latest published remote version.
 */
export interface TripleHash {
	readonly lastSyncedHash: string;
	readonly localHash: string;
	readonly remoteHash: string;
}

/** Build a {@link TripleHash}, defaulting any unknown leg to the empty string. */
export function tripleHash(parts: Partial<TripleHash> = {}): TripleHash {
	return {
		lastSyncedHash: parts.lastSyncedHash ?? "",
		localHash: parts.localHash ?? "",
		remoteHash: parts.remoteHash ?? "",
	};
}

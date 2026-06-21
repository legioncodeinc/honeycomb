/**
 * PRD-033a — Stable artifact identity (FR-2 / FR-3 / a-AC-3 / D-3).
 *
 * Each synced artifact carries a `honeycomb_id` that SURVIVES RENAMES — renaming
 * a skill dir or an agent file on disk must NOT fork its identity or re-sync it
 * as a brand-new artifact (a-AC-3). Two surfaces guarantee that:
 *
 *   1. The id is STAMPED into the artifact's YAML frontmatter (D-3). Skills and
 *      agents are both Markdown + YAML, so a re-scan after a rename reads the
 *      SAME id straight out of the file — the on-disk name is irrelevant.
 *   2. The REGISTRY stays AUTHORITATIVE as the fallback (D-3). When frontmatter
 *      is absent/garbled (an externally-authored artifact, a stripped parser),
 *      identity resolution falls back to the registry's recorded id. We never
 *      mint a second id for an artifact the registry already knows.
 *
 * Pure + local (D-6): this module touches NO DeepLake and NO network. It mints
 * an id (random), stamps/parses YAML frontmatter (string surgery), and resolves
 * an id from the (frontmatter, registry-fallback) pair. The daemon is the only
 * DeepLake client; identity is decided BEFORE anything crosses that boundary.
 */

import { randomUUID } from "node:crypto";

/** The frontmatter key the id is stamped under (stable across the v1 harnesses). */
export const HONEYCOMB_ID_KEY = "honeycomb_id" as const;

/** The `honeycomb_id` value prefix — a stable, greppable namespace for minted ids. */
export const HONEYCOMB_ID_PREFIX = "hc_" as const;

/**
 * Mint a fresh `honeycomb_id` (FR-2). A UUIDv4 with the `hc_` prefix and dashes
 * stripped, so the value is a single safe token (`[A-Za-z0-9_]`) that survives a
 * YAML scalar, a registry key, and a SQL literal without escaping surprises. The
 * id is RANDOM, not derived from the content or the path — so it is stable across
 * BOTH renames and edits (the content hash, not the id, tracks change).
 */
export function mintHoneycombId(): string {
	return `${HONEYCOMB_ID_PREFIX}${randomUUID().replace(/-/g, "")}`;
}

/** True when a string is a well-formed minted id (defensive validation on read-back). */
export function isHoneycombId(value: unknown): value is string {
	return typeof value === "string" && /^hc_[0-9a-f]{32}$/.test(value);
}

// ── YAML frontmatter stamp / parse (Markdown + YAML, the v1 artifact shape) ───

/** Matches a leading `---\n…\n---` YAML frontmatter block at the very top of the file. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/**
 * Parse the `honeycomb_id` out of an artifact's YAML frontmatter (a-AC-3 / D-3),
 * or `null` when absent. Deliberately minimal — it reads the ONE key we stamp
 * (`honeycomb_id: <value>`) rather than parsing arbitrary YAML, so it pulls in no
 * YAML dependency and cannot be tricked into executing a tag. A value that is not
 * a well-formed minted id is treated as absent (defensive — the registry fallback
 * then wins).
 */
export function parseHoneycombId(markdown: string): string | null {
	const fm = FRONTMATTER_RE.exec(markdown);
	if (fm === null) return null;
	const block = fm[1] ?? "";
	// Match `honeycomb_id:` at the start of a frontmatter line, value optionally quoted.
	const idLine = new RegExp(`^${HONEYCOMB_ID_KEY}:\\s*["']?([^"'\\r\\n]+)["']?\\s*$`, "m").exec(block);
	if (idLine === null) return null;
	const value = (idLine[1] ?? "").trim();
	return isHoneycombId(value) ? value : null;
}

/**
 * Stamp `honeycomb_id: <id>` into an artifact's YAML frontmatter (FR-2 / D-3),
 * returning the rewritten markdown. Idempotent + non-destructive:
 *
 *   - frontmatter present, key ABSENT  → insert the key as the first frontmatter
 *     line (other keys preserved verbatim).
 *   - frontmatter present, key PRESENT → replace the existing value (a re-stamp
 *     with the SAME id is a no-op; a different id overwrites — the registry id wins).
 *   - frontmatter ABSENT               → prepend a fresh `---\nhoneycomb_id: <id>\n---`
 *     block above the body.
 *
 * Never reorders or drops a sibling key; never touches the body. So stamping an
 * id is safe to run on every scan without churning the file.
 */
export function stampHoneycombId(markdown: string, id: string): string {
	const fm = FRONTMATTER_RE.exec(markdown);
	if (fm === null) {
		// No frontmatter — prepend a fresh block above the existing content.
		return `---\n${HONEYCOMB_ID_KEY}: ${id}\n---\n${markdown}`;
	}
	const block = fm[1] ?? "";
	const keyLine = new RegExp(`^${HONEYCOMB_ID_KEY}:.*$`, "m");
	const newBlock = keyLine.test(block)
		? block.replace(keyLine, `${HONEYCOMB_ID_KEY}: ${id}`)
		: `${HONEYCOMB_ID_KEY}: ${id}\n${block}`;
	// Rebuild the file: new frontmatter block + everything after the closing `---`.
	const after = markdown.slice(fm[0].length);
	const trailer = fm[2] ?? "\n";
	return `---\n${newBlock}\n---${trailer}${after}`;
}

// ── Identity resolution (frontmatter first, registry fallback — D-3) ──────────

/**
 * Resolve an artifact's stable id from its frontmatter, falling back to the
 * registry's recorded id, and MINTING a fresh one only when neither knows it
 * (a-AC-3 / D-3). This is the single decision point that makes a rename
 * identity-preserving: a renamed artifact still carries its stamped id (or the
 * registry still maps the artifact to its id), so the SAME id resolves — never a
 * new artifact.
 *
 * @param markdown    the artifact's content (frontmatter is consulted first).
 * @param registeredId the id the registry already holds for this artifact, or
 *                      `null`/`undefined` when the registry has no record.
 * @returns the resolved id + whether it was newly minted (the caller stamps +
 *          records a freshly-minted id; an existing id needs no write).
 */
export function resolveHoneycombId(
	markdown: string,
	registeredId: string | null | undefined,
): { readonly id: string; readonly minted: boolean } {
	const fromFrontmatter = parseHoneycombId(markdown);
	if (fromFrontmatter !== null) return { id: fromFrontmatter, minted: false };
	if (isHoneycombId(registeredId)) return { id: registeredId, minted: false };
	return { id: mintHoneycombId(), minted: true };
}

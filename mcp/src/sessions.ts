/**
 * Session-key lineage inference — a pure helper originally backing the `session_search`
 * MCP tool (PRD-019d FR-5 / d-AC-5).
 *
 * ── C-2 pre-release fix (2026-07-03) ─────────────────────────────────────────
 * The `session_search` / `session_bypass` tools were UNREGISTERED: they dialed
 * `/api/sessions/*`, a route group `src/daemon/runtime/server.ts`'s `ROUTE_GROUPS`
 * never mounts, so every call 404'd. `inferParentSessionKey` is kept — it is a pure,
 * already-tested utility (a child session key like OpenClaw's per-slice
 * `parent.child` / `parent#child` carries its parent in its own structure) that a
 * future `/api/sessions` route can reuse once the daemon side is actually built.
 */

/**
 * The lineage separators a child session key may use to encode its parent. The
 * child key is `<parent><sep><childSuffix>`; the parent is everything left of the
 * LAST separator. Ordered by specificity — the longest, most explicit markers
 * first so a key carrying several candidates resolves the intended one.
 */
const LINEAGE_SEPARATORS = ["::", "#", "/", "."] as const;

/**
 * Infer the parent session key from a child session key (FR-5 / d-AC-5).
 *
 * Returns the substring left of the LAST lineage separator, or `undefined` when
 * the key carries no separator (a root session has no parent). A trailing or
 * leading separator yields no parent (an empty side is not a valid key). Pure and
 * deterministic — the unit test drives it directly.
 *
 * Examples:
 *   `sess-abc::slice-1`  → `sess-abc`
 *   `parent#child`       → `parent`
 *   `a/b/c`              → `a/b`     (nearest ancestor)
 *   `root`               → undefined (no parent)
 */
export function inferParentSessionKey(childKey: string): string | undefined {
	const key = childKey.trim();
	if (key.length === 0) return undefined;
	let best: { parent: string; idx: number } | undefined;
	for (const sep of LINEAGE_SEPARATORS) {
		const idx = key.lastIndexOf(sep);
		if (idx <= 0) continue; // not found, or separator is the leading char (no parent)
		const parent = key.slice(0, idx);
		const child = key.slice(idx + sep.length);
		if (parent.length === 0 || child.length === 0) continue; // empty side → not a lineage
		// Prefer the separator that splits CLOSEST to the end (nearest ancestor).
		if (best === undefined || idx > best.idx) best = { parent, idx };
	}
	return best?.parent;
}

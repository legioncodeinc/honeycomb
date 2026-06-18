/**
 * Sessions cluster — `session_search` parent-lineage inference (PRD-019d FR-5 / d-AC-5).
 *
 * ── WHY LINEAGE INFERENCE LIVES ON THE MCP SURFACE ──────────────────────────
 * A child session key (e.g. OpenClaw's per-slice key `parent.child` or
 * `parent#child`) carries its parent in its own structure. When `session_search`
 * is called with a `sessionKey`, this module DERIVES the parent key from the child
 * and threads it onto the daemon query as `parentSessionKey`, so the daemon can
 * resolve transcripts across the lineage — this is how OpenClaw resolves a parent
 * session from a child slice (FR-5). The daemon owns the actual transcript query;
 * this module only INFERS the lineage and stamps it onto the request (D-2 / D-6).
 *
 * The inference is pure and unit-testable in isolation ({@link inferParentSessionKey}),
 * so a test asserts the derivation without a daemon (d-AC-5).
 */

import type { Actor, DaemonApiResponse, DaemonApiSeam } from "./contracts.js";

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

/** Validated `session_search` args (the strict arg schema already accepted them). */
interface SessionSearchArgs {
	readonly query?: unknown;
	readonly sessionKey?: unknown;
}

/**
 * Run `session_search`, inferring parent lineage from a child `sessionKey` when one
 * is supplied (FR-5 / d-AC-5). Routes through the daemon seam (FR-2); when a parent
 * is inferred it is stamped onto the body as `parentSessionKey` so the daemon
 * resolves transcripts across the lineage. The MCP surface never queries DeepLake.
 */
export async function sessionSearch(
	args: Record<string, unknown>,
	actor: Actor,
	daemon: DaemonApiSeam,
): Promise<unknown> {
	const a = args as SessionSearchArgs;
	const sessionKey = typeof a.sessionKey === "string" ? a.sessionKey : undefined;
	const parentSessionKey = sessionKey !== undefined ? inferParentSessionKey(sessionKey) : undefined;

	const body: Record<string, unknown> = { query: a.query };
	if (sessionKey !== undefined) body.sessionKey = sessionKey;
	if (parentSessionKey !== undefined) body.parentSessionKey = parentSessionKey;

	const res: DaemonApiResponse = await daemon.call({
		method: "POST",
		path: "/api/sessions/search",
		body,
		actor,
	});
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`daemon POST /api/sessions/search → ${res.status}`);
	}
	return res.body;
}

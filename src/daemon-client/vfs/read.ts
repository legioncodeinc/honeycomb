/**
 * Read resolution — PRD-015a (a-AC-1 / a-AC-2 / FR-6). The fixed PRECEDENCE chain a
 * `cat`/`readFile` resolves through. Each tier SHORT-CIRCUITS — the first tier that can
 * answer wins and no later tier runs (so a cache/pending hit dispatches NO SQL):
 *
 *   1. graph bridge        a `graph/...` path → render the LOCAL snapshot via
 *                          `handleGraphVfs`, ZERO network, `no-graph` as a BODY (a-AC-2).
 *   2. virtual index.md    root `index.md` with no real row → `generateVirtualIndex`.
 *   3. in-memory cache     a resolved body already cached → return it (no SQL).
 *   4. pending-write buffer the agent's OWN un-flushed write → return it (cat-after-write).
 *   5. sessions concat     a `sessions/...` path → concat the session rows for that path.
 *   6. direct SQL summary  fall through → SELECT the `memory.summary` for the path.
 *
 * Tiers 5 and 6 are the ONLY tiers that reach storage; both go through the
 * {@link DaemonDispatch} seam (a-AC-6) under the caller's {@link VfsScope}. The graph tier
 * reaches the LOCAL disk through the injected {@link SnapshotLoader} and NEVER the network.
 */

import { handleGraphVfs } from "../../daemon/runtime/codebase/query.js";
import type { Snapshot } from "../../daemon/runtime/codebase/contracts.js";
import { sqlIdent, sLiteral } from "../../daemon/storage/sql.js";

import { classifyPath, toMountRelative } from "./classify.js";
import { generateVirtualIndex } from "./index-gen.js";
import type {
	ContentCache,
	DaemonDispatch,
	PendingBuffer,
	Row,
	SnapshotLoader,
	VfsScope,
} from "./contracts.js";

/** The `graph/` subtree prefix the bridge strips before delegating (FR-9). */
const GRAPH_PREFIX = "graph/";

/** The synthesized index filename at the mount root (FR-8). */
const INDEX_FILENAME = "index.md";

/** The dependencies a read resolution needs (all injected — the seam boundaries). */
export interface ReadDeps {
	/** The ONLY path out to storage (a-AC-6). */
	readonly dispatch: DaemonDispatch;
	/** The tenancy scope carried on every dispatch (FR-2). */
	readonly scope: VfsScope;
	/** The in-memory content cache (tier 3). */
	readonly cache: ContentCache;
	/** The pending-write buffer (tier 4) — the agent's own un-flushed writes. */
	readonly pending: PendingBuffer;
	/** The local snapshot loader for the graph bridge (tier 1) — zero network. */
	readonly snapshots: SnapshotLoader;
}

/**
 * The error a read rejects with when no tier can resolve the path (a real file would be
 * ENOENT). `code === "ENOENT"` so a shell caller surfaces the familiar errno.
 */
export class NotFoundError extends Error {
	readonly code = "ENOENT" as const;
	constructor(path: string) {
		super(`ENOENT: no such memory file ${path}`);
		this.name = "NotFoundError";
	}
}

/**
 * Resolve the content of a path through the read-precedence chain (a-AC-1). Returns the
 * resolved body. Throws {@link NotFoundError} (ENOENT) only when the path is a graph
 * endpoint the renderer rejects; a missing memory/session row resolves to an EMPTY body
 * (an empty file), never a throw — the mount surfaces an absent summary as "" the way an
 * empty file reads as "".
 */
export async function resolveRead(path: string, deps: ReadDeps): Promise<string> {
	const rel = toMountRelative(path);
	const kind = classifyPath(path);

	// ── Tier 1: the graph bridge (a-AC-2). Detected BEFORE the cache so the graph subtree
	// is never cached as a stale memory body. Renders the LOCAL snapshot, zero network. ──
	if (kind === "graph") {
		return resolveGraph(rel, deps.snapshots);
	}

	// ── Tier 2: the synthesized index.md (a-AC-5). Only when no REAL index row exists. ──
	if (kind === "index" || rel === INDEX_FILENAME) {
		const real = await readMemorySummary(rel, deps);
		if (real !== null) return real; // a real /index.md row wins over the synthesized one.
		return generateVirtualIndex(deps.dispatch, deps.scope);
	}

	// ── Tier 3: the in-memory cache. A hit dispatches NO SQL. ──
	const cached = deps.cache.get(rel);
	if (cached !== undefined) return cached;

	// ── Tier 4: the pending-write buffer — the agent's OWN un-flushed write (cat-after-write). ──
	const pendingWrite = deps.pending.get(rel);
	if (pendingWrite !== undefined) return pendingWrite.body;

	// ── Tier 5: sessions concatenation (read-only event log). ──
	if (kind === "session") {
		return concatSessions(rel, deps);
	}

	// ── Tier 6: the direct SQL summary read (memory / goal / kpi paths). ──
	const summary = await readMemorySummary(rel, deps);
	return summary ?? "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 1 — the graph bridge (a-AC-2 / FR-9). ZERO network.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render a `graph/...` path from the LOCAL snapshot (a-AC-2 / FR-9). Strips the `graph/`
 * prefix, loads the local snapshot via the injected loader (NO network), and delegates to
 * the PURE `handleGraphVfs` renderer. When NO snapshot exists, returns a `no-graph` BODY
 * (never throws) so `cat graph/index.md` on a repo with no built graph reads as a message,
 * not an error. The renderer itself never throws (an unknown endpoint renders a usage
 * listing), so this tier always produces a body.
 */
function resolveGraph(rel: string, snapshots: SnapshotLoader): string {
	const snapshot = snapshots.load() as Snapshot | null;
	if (snapshot === null) {
		return [
			"no-graph: no local codebase graph snapshot for this worktree.",
			"Build one first (the PRD-014 graph build), then `cat graph/index.md` for the overview.",
		].join("\n");
	}
	// Pass the remainder INCLUDING `graph/` — `handleGraphVfs` strips a leading `graph/`
	// itself, and also accepts the bare command. Either way the render is zero-network.
	const graphPath = rel.startsWith(GRAPH_PREFIX) ? rel.slice(GRAPH_PREFIX.length) : rel;
	return handleGraphVfs(graphPath, snapshot);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 5 — sessions concatenation (FR-7). Read-only.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the sessions-concat SELECT (FR-7): every `message` for this `path` ordered by
 * `creation_date ASC`, so the rows reconstruct the turn stream in order. Value (the path)
 * goes through `sLiteral`; identifiers through `sqlIdent`.
 */
export function buildSessionsConcatSql(path: string): string {
	const tbl = sqlIdent("sessions");
	const pathCol = sqlIdent("path");
	const message = sqlIdent("message");
	const created = sqlIdent("creation_date");
	return (
		`SELECT ${message} FROM "${tbl}" ` +
		`WHERE ${pathCol} = ${sLiteral(path)} ` +
		`ORDER BY ${created} ASC`
	);
}

/**
 * Concatenate the session rows for a path (FR-7). Dispatches the ordered SELECT and joins
 * each row's normalized `message` with a newline. A path with no rows resolves to "" (an
 * empty session file).
 */
async function concatSessions(rel: string, deps: ReadDeps): Promise<string> {
	const rows = await deps.dispatch.query(buildSessionsConcatSql(rel), deps.scope);
	return rows.map((row) => normalizeMessage(row.message)).filter((s) => s !== "").join("\n");
}

/** Normalize a `sessions.message` (JSONB) cell to a string line. */
function normalizeMessage(message: unknown): string {
	if (typeof message === "string") return message.trim();
	if (message === undefined || message === null) return "";
	// A JSONB object → stable JSON text (the raw event), trimmed.
	try {
		return JSON.stringify(message);
	} catch {
		return String(message);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 6 / Tier 2 helper — the direct memory.summary read.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the direct summary read (FR-6 tier 6): the `summary` of the `memory` row at this
 * `path`. Value through `sLiteral`, identifiers through `sqlIdent`. `LIMIT 1` because the
 * `memory` table is update-or-insert by `path` (one current row per path).
 */
export function buildMemorySummarySql(path: string): string {
	const tbl = sqlIdent("memory");
	const pathCol = sqlIdent("path");
	const summary = sqlIdent("summary");
	return `SELECT ${summary} FROM "${tbl}" WHERE ${pathCol} = ${sLiteral(path)} LIMIT 1`;
}

/**
 * Read the `memory.summary` for a path, or `null` when no row exists. Used by tier 6 (the
 * fall-through read) AND by tier 2 (to let a REAL `/index.md` row win over the synthesized
 * one). Reaches storage only through the dispatch seam.
 */
async function readMemorySummary(rel: string, deps: ReadDeps): Promise<string | null> {
	const rows = await deps.dispatch.query(buildMemorySummarySql(rel), deps.scope);
	const first: Row | undefined = rows[0];
	if (first === undefined) return null;
	const summary = first.summary;
	return typeof summary === "string" ? summary : summary === undefined || summary === null ? "" : String(summary);
}

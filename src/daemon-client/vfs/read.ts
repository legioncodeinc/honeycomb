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

import type { Snapshot } from "../../daemon/runtime/codebase/contracts.js";
import { handleGraphVfs } from "../../daemon/runtime/codebase/query.js";
import { clampSessionTurns, sLiteral, sqlIdent } from "../../daemon/storage/sql.js";

import { classifyPath, toMountRelative } from "./classify.js";
import type {
	ContentCache,
	DaemonDispatch,
	PendingBuffer,
	Row,
	Rows,
	SessionCache,
	SnapshotLoader,
	VfsScope,
} from "./contracts.js";
import { generateVirtualIndex } from "./index-gen.js";

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
	/**
	 * The session-recall cache (tier 5). When wired, session reads are gated on a cheap
	 * staleness probe and re-fetch the fat payload only on change. Optional: when absent,
	 * session reads fall back to the original unconditional fetch (no probe).
	 */
	readonly sessionCache?: SessionCache;
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
 * Build the sessions-concat SELECT (FR-7): the most-recent {@link MAX_SESSION_TURNS}
 * `message` rows for this `path`. Value (the path) goes through `sLiteral`; identifiers
 * through `sqlIdent`.
 *
 * PERF: bounded to the most-recent N turns via a flat `ORDER BY creation_date DESC LIMIT N`
 * (the proven pattern in this codebase — no derived-table subquery). The caller
 * ({@link concatSessions}) reverses the rows back into chronological order, so the turn
 * stream still reads oldest→newest. An unbounded read on a fan-out session (tens of
 * thousands of shared-`path` rows) materialized hundreds of MB and stalled for tens of
 * seconds; every ordinary session is far under the cap and is returned in full.
 */
export function buildSessionsConcatSql(path: string): string {
	const tbl = sqlIdent("sessions");
	const pathCol = sqlIdent("path");
	const message = sqlIdent("message");
	const created = sqlIdent("creation_date");
	return (
		`SELECT ${message} FROM "${tbl}" ` +
		`WHERE ${pathCol} = ${sLiteral(path)} ` +
		`ORDER BY ${created} DESC ` +
		`LIMIT ${clampSessionTurns()}`
	);
}

/**
 * Build the cheap session STALENESS probe for a `path`: `count(*)` + `max(creation_date)`,
 * both filtered to this path. It reads ONLY the `path` + `creation_date` columns — it never
 * touches the fat `message` column, so it costs a scalar scan (~sub-second) instead of
 * materializing the tens-of-MB payload the concat fetch does.
 *
 * The two aggregates form a monotone staleness TOKEN (see {@link sessionToken}). `sessions`
 * is append-only (rows are immutable once written — no UPDATE/DELETE), so a token change is
 * necessary AND sufficient for the concatenated body to have changed: any new turn bumps
 * `count(*)`, and no old turn can mutate. `count(*)` alone would suffice; `max(creation_date)`
 * is a near-free second signal that also moves it forward.
 */
export function buildSessionHwmSql(path: string): string {
	const tbl = sqlIdent("sessions");
	const pathCol = sqlIdent("path");
	const created = sqlIdent("creation_date");
	return `SELECT count(*) AS n, max(${created}) AS hwm FROM "${tbl}" WHERE ${pathCol} = ${sLiteral(path)}`;
}

/** Derive the monotone staleness token (`"<count>:<max-creation_date>"`) from a probe row. */
function sessionToken(probe: Rows): string {
	const row = probe[0];
	const n = row?.n ?? 0;
	const hwm = row?.hwm ?? "";
	return `${String(n)}:${String(hwm ?? "")}`;
}

/**
 * Concatenate the session rows for a path (FR-7), served through a modification-time-gated
 * cache when a {@link SessionCache} is wired.
 *
 * Flow: dispatch the cheap {@link buildSessionHwmSql} probe → derive the token. On a token
 * HIT (session unchanged since we cached it), return the cached body WITHOUT re-fetching the
 * fat `message` payload — the whole point, since re-reading an unchanged mega-session cold
 * costs tens of seconds of S3 I/O for bytes we already have. On a MISS or a changed token,
 * fetch the bounded most-recent-N turns, cache under the new token, and return. `n === 0`
 * short-circuits to "" with no concat fetch (empty session file).
 *
 * The token is SELF-INVALIDATING for append-only data, so no explicit write-invalidation is
 * needed even for the agent's own appends: the next probe sees the bumped `count(*)`.
 *
 * When no cache is wired (`deps.sessionCache` undefined — e.g. legacy callers/tests), this
 * falls back to the original single unconditional fetch, adding no probe.
 */
async function concatSessions(rel: string, deps: ReadDeps): Promise<string> {
	if (deps.sessionCache === undefined) return fetchAndConcat(rel, deps);

	const token = sessionToken(await deps.dispatch.query(buildSessionHwmSql(rel), deps.scope));
	const cached = deps.sessionCache.get(rel);
	if (cached !== undefined && cached.token === token) return cached.body;

	// n===0 → empty session; skip the concat fetch entirely.
	const body = token.startsWith("0:") ? "" : await fetchAndConcat(rel, deps);
	deps.sessionCache.set(rel, { token, body });
	return body;
}

/** Dispatch the bounded concat SELECT (newest-first), reverse to chronological, join lines. */
async function fetchAndConcat(rel: string, deps: ReadDeps): Promise<string> {
	const rows = await deps.dispatch.query(buildSessionsConcatSql(rel), deps.scope);
	return rows
		.slice()
		.reverse()
		.map((row) => normalizeMessage(row.message))
		.filter((s) => s !== "")
		.join("\n");
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

/**
 * Tier-1 KEY READ path — PRD-046b (b-AC-4 / b-AC-5), the cheap-to-read half.
 *
 * The whole point of storing the Tier-1 key as a COLUMN (`memory.key` for episodic
 * summaries, `memories.key` for durable facts) is that assembling a prime (046c) is a
 * PURE SQL SKIM — NO LLM/gate call at read time (b-AC-4). This module owns the read
 * builders the prime calls: plain `SELECT` statements that return the stored keys + the
 * id/path each resolves to, so the prime can list ten one-line headlines and let the
 * agent decide which to zoom into — without ever invoking the gate.
 *
 * ── Two sources, one skim (b-AC-5) ───────────────────────────────────────────
 *   - EPISODIC keys — the per-session summary rows in `memory` under `/summaries/`
 *     ({@link buildEpisodicKeySkimSql}). The key resolves to its Tier-2 summary by `path`.
 *   - DURABLE keys — the distilled facts in `memories` ({@link buildDurableKeySkimSql}),
 *     highest-version, not soft-deleted. The key resolves to its fact by `id`.
 *
 * ── Scope + secrets (b-AC-5) ─────────────────────────────────────────────────
 * Every read runs under the per-request {@link QueryScope} (the org/workspace storage
 * partition) + the engine `agent_id` ring, so a key is only ever primed into the tenant
 * + agent that owns it. The key text itself was scrubbed at WRITE time (the summary
 * worker's `redactSecrets` floor), so no secret/PII reaches a key — and therefore none
 * reaches the prime.
 *
 * ── SQL safety ───────────────────────────────────────────────────────────────
 * Every identifier routes through `sqlIdent`, every value through `sLiteral`, every
 * prefix match through `sqlLike` — no value is hand-quoted (`audit:sql` scans `src/daemon`).
 * These are READ-ONLY builders: no INSERT, no UPDATE, no generation.
 */

import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";

import { MEMORY_TABLE, SUMMARY_PATH_PREFIX } from "./worker.js";
import { IN_PROGRESS_MARKER } from "./worker.js";

/** The durable-fact table the prime skims durable keys from. */
export const MEMORIES_TABLE = "memories" as const;

/** The default number of Tier-1 keys a single prime skim returns (a skimmable headline list). */
export const DEFAULT_KEY_SKIM_LIMIT = 25;
/** The hard ceiling on a prime skim (the prime's token budget is finite — 046c owns the real budget). */
export const MAX_KEY_SKIM_LIMIT = 200;

/** Clamp a caller-supplied skim limit into `[1, MAX_KEY_SKIM_LIMIT]`, defaulting a missing/bad value. */
export function resolveKeySkimLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_KEY_SKIM_LIMIT;
	const truncated = Math.trunc(limit);
	if (truncated < 1) return DEFAULT_KEY_SKIM_LIMIT;
	return Math.min(truncated, MAX_KEY_SKIM_LIMIT);
}

/** Where a primed Tier-1 key came from — the table the prime resolves a zoom-in against. */
export type KeySource = "episodic" | "durable";

/** One Tier-1 key the prime lists (b-AC-4). Pure read-model — no generation produced it. */
export interface PrimedKey {
	/** The ≤1-sentence keyword-dense headline (the stored `key`). */
	readonly key: string;
	/** The id/path the key resolves to (a `memory` path for episodic, a `memories` id for durable). */
	readonly ref: string;
	/** Which table the key came from (so the prime knows how to resolve a zoom-in). */
	readonly source: KeySource;
}

/**
 * Build the EPISODIC key-skim SQL (b-AC-4 / b-AC-5): SELECT the stored `key` + the `path`
 * for the per-session summary rows under `/summaries/`, NEWEST first, bounded. EXCLUDES
 * the in-progress placeholder (its `description` is the marker) so a half-written summary
 * never primes a blank key, and EXCLUDES rows whose `key` is empty (an un-keyed legacy
 * summary). Pure SELECT — the prime issues this and reads `key`/`path` with NO generation.
 *
 * Tenancy rides the {@link QueryScope} partition; the `/summaries/` prefix is matched with
 * `sqlLike` on the escaped, fixed prefix (carries no user input). Newest-first by
 * `last_update_date` so the prime surfaces the most recent sessions first.
 */
export function buildEpisodicKeySkimSql(limit: number): string {
	const tbl = sqlIdent(MEMORY_TABLE);
	const keyCol = sqlIdent("key");
	const pathCol = sqlIdent("path");
	const descCol = sqlIdent("description");
	const dateCol = sqlIdent("last_update_date");
	const safeLimit = resolveKeySkimLimit(limit);
	// The fixed `/summaries/` prefix is matched with a trailing wildcard, built as
	// `<sLiteral-prefix> || '%'` exactly as `synthesis.ts`'s tenant read does (it carries
	// no user input — audit-clean). The in-progress placeholder + empty keys are excluded
	// so the prime only ever lists real, keyed summaries.
	const prefixLike = `${sLiteral(SUMMARY_PATH_PREFIX)} || '%'`;
	return (
		`SELECT ${keyCol}, ${pathCol} FROM "${tbl}" ` +
		`WHERE ${pathCol} LIKE ${prefixLike} ` +
		`AND ${descCol} != ${sLiteral(IN_PROGRESS_MARKER)} ` +
		`AND ${keyCol} != ${sLiteral("")} ` +
		`ORDER BY ${dateCol} DESC LIMIT ${safeLimit}`
	);
}

/**
 * Build the DURABLE key-skim SQL (b-AC-4 / b-AC-5): SELECT the stored `key` + the `id` for
 * the distilled facts in `memories`, NEWEST first, bounded, NOT soft-deleted. The durable
 * key falls back to `content` at the projection step when a legacy fact has no derived key
 * (so an un-keyed durable fact is still primeable). Pure SELECT — NO generation at read.
 *
 * Tenancy rides the {@link QueryScope} partition + the engine `agent_id` ring; soft-deleted
 * tombstones (`is_deleted = 1`) are excluded exactly as the recall/get reads do. Newest
 * first by `updated_at`.
 */
export function buildDurableKeySkimSql(limit: number): string {
	const tbl = sqlIdent(MEMORIES_TABLE);
	const keyCol = sqlIdent("key");
	const idCol = sqlIdent("id");
	const contentCol = sqlIdent("content");
	const deletedCol = sqlIdent("is_deleted");
	const dateCol = sqlIdent("updated_at");
	const safeLimit = resolveKeySkimLimit(limit);
	// `is_deleted = 0` (the NOT_SOFT_DELETED encoding) — a numeric literal, inlined by
	// design. The `content` fallback for an un-keyed fact is applied at projection.
	return (
		`SELECT ${keyCol}, ${idCol}, ${contentCol} FROM "${tbl}" ` +
		`WHERE ${deletedCol} = 0 ` +
		`ORDER BY ${dateCol} DESC LIMIT ${safeLimit}`
	);
}

/** Project an episodic skim row into a {@link PrimedKey}. */
function rowToEpisodicKey(row: StorageRow): PrimedKey | null {
	const key = typeof row.key === "string" ? row.key.trim() : "";
	const ref = typeof row.path === "string" ? row.path : "";
	if (key === "" || ref === "") return null;
	return { key, ref, source: "episodic" };
}

/** Project a durable skim row into a {@link PrimedKey}, falling back to `content` when un-keyed. */
function rowToDurableKey(row: StorageRow): PrimedKey | null {
	const ref = typeof row.id === "string" ? row.id : "";
	if (ref === "") return null;
	const rawKey = typeof row.key === "string" ? row.key.trim() : "";
	// Fallback: a legacy fact with no derived key is still primeable via its content (b-AC-5
	// note in the catalog). Collapse to one line so the prime lists a headline, not a blob.
	const fallback = typeof row.content === "string" ? row.content.replace(/\s+/g, " ").trim() : "";
	const key = rawKey !== "" ? rawKey : fallback;
	if (key === "") return null;
	return { key, ref, source: "durable" };
}

/** Construction deps for the prime-key reader (daemon-only storage). */
export interface PrimeKeyReadDeps {
	/** The DeepLake storage client (daemon-only). Reads ONLY through this — NO generation. */
	readonly storage: StorageQuery;
	/** The per-request tenancy partition the skim runs under (org/workspace). */
	readonly scope: QueryScope;
}

/**
 * Skim the Tier-1 keys for a prime (b-AC-4) — the PURE SQL read the prime (046c) calls.
 * Issues the episodic + durable key-skim SELECTs under the scope, projects the rows into
 * {@link PrimedKey}s, and returns them. It runs ZERO generation/gate calls — the keys were
 * derived + stored at summarize/synthesize time, so the read is a plain SELECT skim. A
 * non-ok read for a source contributes no keys (fail-soft: a missing table on a fresh
 * workspace yields an empty skim, never a throw).
 */
export async function skimPrimeKeys(deps: PrimeKeyReadDeps, limit = DEFAULT_KEY_SKIM_LIMIT): Promise<readonly PrimedKey[]> {
	const safeLimit = resolveKeySkimLimit(limit);
	const out: PrimedKey[] = [];

	const episodic = await deps.storage.query(buildEpisodicKeySkimSql(safeLimit), deps.scope);
	if (isOk(episodic)) {
		for (const row of episodic.rows as StorageRow[]) {
			const k = rowToEpisodicKey(row);
			if (k !== null) out.push(k);
		}
	}

	const durable = await deps.storage.query(buildDurableKeySkimSql(safeLimit), deps.scope);
	if (isOk(durable)) {
		for (const row of durable.rows as StorageRow[]) {
			const k = rowToDurableKey(row);
			if (k !== null) out.push(k);
		}
	}

	return out;
}

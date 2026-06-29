/**
 * The per-session ROI-metric WRITE call-site — PRD-060e (module AC-11) / PRD-060f (f-AC-2 in
 * practice). This is the seam 060f deliberately left open: a single named step the skillify
 * worker fires ONCE when a session reaches summary/skillify completion, which prices that
 * session's MEASURED cache savings (060b) and appends one immutable ROI row to the shared
 * `roi_metrics` ledger via 060f's {@link appendRoiMetric}.
 *
 * ── What is written, and the cost_basis decision (documented) ─────────────────
 * The MEASURED cache savings for the session's captured turns IS a real per-session billed
 * fact (060a token columns × 060b rates), so it is written verbatim in INTEGER cents. The
 * MODELED memory-injection savings for the session is written too, tagged via
 * `modeledAssumptionRef` so the disclosure copy reads one source.
 *
 * The COST side is left UNALLOCATED at write time:
 *   - DeepLake infra cost (060c) is only measured at ORG/WORKSPACE level and is a "since boot"
 *     / period-wide figure. There is NO defensible per-session split available at skillify time
 *     (the worker does not — and must not — open a billing egress on the hot path), so
 *     allocating a slice of an org-wide bill to one session would be a FABRICATED number.
 *   - Therefore this writer sets `infraCostCents: 0`, `costBasis: 'none'`, and
 *     `allocationMethod: ''`. The honest read of this row is "measured savings, no cost
 *     attributed at this grain". A per-team / per-user infra share is an `allocated` estimate
 *     computed at READ time / in the hosted surface (PRD-061), NOT fabricated per session here.
 *
 * This is the HONEST option of the two the PRD offers ("allocated with a method, or `'none'`"):
 * `'none'` rather than a made-up per-session allocation. The shared ledger never lets an
 * allocated estimate masquerade as a measured fact, and an UNallocated cost is honestly empty.
 *
 * ── Identity gating (f-AC-6 / f-AC-9) ────────────────────────────────────────
 * `user_id` stays `''` — this writer passes NO `verifiedClaim` (there is no verified backend
 * person claim today; a git-email / `$USER` fallback is explicitly rejected, 060f). `team_id`
 * is resolved at write time by 060f's roster lookup (fail-soft to `''` when unassigned).
 *
 * ── Fail-soft (never blocks skillify completion) ─────────────────────────────
 * Every path here is non-throwing: the per-session turns read is fail-soft (`[]` on any
 * non-ok result), `appendRoiMetric` is heal-aware + degrades, and the worker invokes this
 * AFTER the skill write completes so an ROI-write hiccup can never fail the skillify job.
 *
 * Storage-correct: reads/writes go ONLY through the injected {@link StorageQuery}; every
 * interpolated value routes through the `sql.ts` guards (the SELECT here) or 060f's guarded
 * writer. No raw fetch, no hand-built statement past the guards.
 */

import { randomUUID } from "node:crypto";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk, type QueryResult, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { appendRoiMetric } from "./roi-ledger.js";
import {
	type CapturedTurn,
	measuredCacheSavings,
	modeledMemoryInjectionSavings,
} from "./roi-savings.js";

/** The injected clock so the row's `createdAt` is deterministic in tests. */
export interface RoiWriterClock {
	/** Current wall-clock time in ms (defaults to `Date.now`). */
	readonly now: () => number;
}

/** A minimal structured-log sink (mirrors the skillify worker logger). */
export interface RoiWriterLogger {
	/** Record a structured event (e.g. `roi.write.appended`, `roi.write.skipped`). */
	event(name: string, fields?: Record<string, unknown>): void;
}

/**
 * The per-session ROI-write seam the skillify worker fires once at completion. Decoupled
 * behind an interface so the worker depends on the contract, not the implementation: production
 * wires {@link createRoiSessionWriter}; a test injects a fake that records the single call.
 */
export interface RoiSessionWriter {
	/**
	 * Price + append ONE immutable ROI row for a completed session (PRD-060e/060f). Reads the
	 * session's captured turns, computes the MEASURED cache savings (060b), and appends via
	 * 060f's `appendRoiMetric` (team resolved, user gated to `''`, cost UNallocated). FAIL-SOFT:
	 * returns silently on any failure — it NEVER throws and so never blocks skillify completion.
	 */
	writeForSession(input: RoiSessionWriteInput): Promise<void>;
}

/** The inputs the skillify worker hands the writer at completion. */
export interface RoiSessionWriteInput {
	/** The session that just completed summary/skillify (the trigger key + provenance). */
	readonly sessionId: string;
	/** The `sessions` conversation grouping key (the per-project `path`) the turns are read by. */
	readonly path: string;
	/** The writing agent/machine (resolves `team_id` from the roster at write time). */
	readonly agentId: string;
	/** The resolved project id (PRD-049c) the session ran in; `''` when none. */
	readonly projectId?: string;
}

/** The max turns folded for one session's savings (a defensive bound; a session is small). */
const SESSION_TURNS_LIMIT = 2000;

/** Coerce a stored BIGINT token count to `number | null`, preserving NULL=absent (a-AC-6 / b-AC-7). */
function tokenCountOrNull(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Map one `sessions` row to a 060b {@link CapturedTurn}, preserving NULL=absent. */
function rowToCapturedTurn(r: StorageRow): CapturedTurn {
	const sourceTool = typeof r.source_tool === "string" ? r.source_tool : "";
	const model = typeof r.model === "string" ? r.model : "";
	// Price each turn at ITS OWN model's rate (roi-savings `resolveRate`), so an Opus session is NOT
	// written to the ledger at the Sonnet default. Claude Code captures Anthropic models, so provider
	// is "anthropic" for a claude-code row or a `claude-`-prefixed model; an unknown/blank model leaves
	// both undefined → the default rate (parity with `api.ts` rowToCapturedTurn).
	const provider = sourceTool === "claude-code" || model.startsWith("claude-") ? "anthropic" : undefined;
	return {
		input_tokens: tokenCountOrNull(r.input_tokens),
		output_tokens: tokenCountOrNull(r.output_tokens),
		cache_read_input_tokens: tokenCountOrNull(r.cache_read_input_tokens),
		cache_creation_input_tokens: tokenCountOrNull(r.cache_creation_input_tokens),
		...(sourceTool !== "" ? { sourceTool } : {}),
		...(model !== "" ? { model } : {}),
		...(provider !== undefined ? { provider } : {}),
	};
}

/**
 * Read the captured turns for ONE session by its `path` grouping key. METADATA-shaped: only the
 * four nullable token counts + `source_tool` + `model` (never a transcript/JSONB body). Identifiers via
 * `sqlIdent`, the `path` value via `sLiteral` (the 002b guard floor). Fail-soft: `[]` on any
 * non-ok result so a flaky read degrades the savings to absent rather than throwing.
 */
async function readSessionTurns(storage: StorageQuery, scope: QueryScope, path: string): Promise<CapturedTurn[]> {
	const tbl = sqlIdent("sessions");
	const pathCol = sqlIdent("path");
	// Identifiers inlined through `sqlIdent` directly into the template (the audit:sql floor — a
	// pre-joined `cols` variable reads as a raw interpolation to the scanner even when guarded);
	// the `path` value routes through `sLiteral` (the 002b guard).
	const sql =
		`SELECT ${sqlIdent("input_tokens")}, ${sqlIdent("output_tokens")}, ` +
		`${sqlIdent("cache_read_input_tokens")}, ${sqlIdent("cache_creation_input_tokens")}, ${sqlIdent("source_tool")}, ${sqlIdent("model")} ` +
		`FROM "${tbl}" WHERE ${pathCol} = ${sLiteral(path)} LIMIT ${SESSION_TURNS_LIMIT}`;
	let result: QueryResult;
	try {
		result = await storage.query(sql, scope);
	} catch {
		return [];
	}
	return isOk(result) ? result.rows.map(rowToCapturedTurn) : [];
}

/**
 * Build the production per-session ROI writer. Construction is side-effect-free; the write fires
 * only on {@link RoiSessionWriter.writeForSession}. The clock is injectable so a test stamps
 * `createdAt` deterministically; the logger is optional.
 */
export function createRoiSessionWriter(deps: {
	readonly storage: StorageQuery;
	readonly scope: QueryScope;
	readonly clock?: RoiWriterClock;
	readonly logger?: RoiWriterLogger;
}): RoiSessionWriter {
	const clock = deps.clock ?? { now: () => Date.now() };
	return {
		async writeForSession(input: RoiSessionWriteInput): Promise<void> {
			try {
				// Read this session's turns by its grouping key. A blank key cannot identify a
				// session → skip the write (never an unscoped read of the whole table).
				// Finding (path-fallback): `readSessionTurns` filters the `path` column, so the key MUST be the
				// `path` -- never `sessionId`. Falling back to `sessionId` would query WHERE path = sessionId,
				// matching nothing (or an unrelated row). A BLANK path cannot identify the turns -> SKIP the
				// write + log, never an unscoped read of the whole table.
				if (input.path.trim() === "") {
					deps.logger?.event("roi.write.skipped", { reason: "blank path", sessionId: input.sessionId });
					return;
				}
				const turns = await readSessionTurns(deps.storage, deps.scope, input.path);

				// MEASURED cache savings (060b) — a real per-session billed fact. MODELED savings for the
				// single session, tagged via the assumption ref so the disclosure reads one source.
				const measured = measuredCacheSavings(turns);
				const modeled = modeledMemoryInjectionSavings(1);

				// Sum the per-bucket token usage (NULL=absent contributes nothing) for the usage columns.
				let inputTokens = 0;
				let outputTokens = 0;
				let cacheReadTokens = 0;
				let cacheCreationTokens = 0;
				for (const t of turns) {
					inputTokens += t.input_tokens ?? 0;
					outputTokens += t.output_tokens ?? 0;
					cacheReadTokens += t.cache_read_input_tokens ?? 0;
					cacheCreationTokens += t.cache_creation_input_tokens ?? 0;
				}

				const createdAt = new Date(clock.now()).toISOString();
				// One immutable row (060f). team_id resolved at write time; user_id GATED to '' (no
				// verified claim → no person identity); cost UNallocated (`cost_basis: 'none'`, the
				// honest option — see the module header), so an allocated estimate never masquerades
				// as a measured per-session bill.
				const { teamId, userId } = await appendRoiMetric(deps.storage, deps.scope, {
					id: randomUUID(),
					sessionId: input.sessionId,
					agentId: input.agentId,
					...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
					inputTokens,
					outputTokens,
					cacheReadTokens,
					cacheCreationTokens,
					measuredCacheSavingsCents: measured.value.savingsCents,
					modeledSavingsCents: modeled.value.estimatedCents,
					modeledAssumptionRef: modeled.assumption.kind,
					grossCostCents: 0,
					infraCostCents: 0,
					costBasis: "none",
					allocationMethod: "",
					createdAt,
				});

				deps.logger?.event("roi.write.appended", {
					sessionId: input.sessionId,
					measuredCents: measured.value.savingsCents,
					teamId,
					// user_id is gated to '' today — surface that it stayed gated (never a leaked identity).
					userGated: userId === "",
				});
			} catch (err: unknown) {
				// FAIL-SOFT: an ROI-write hiccup NEVER blocks skillify completion — log + return.
				deps.logger?.event("roi.write.failed", {
					sessionId: input.sessionId,
					reason: err instanceof Error ? err.message : String(err),
				});
			}
		},
	};
}

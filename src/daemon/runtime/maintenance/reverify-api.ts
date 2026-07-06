/**
 * PRD-058c / PRD-058e — the reverify-scheduler TRIGGER route + the periodic worker.
 *
 * Wave 1 shipped the cadence math (`reverify-schedule.ts` `isDueForReverify`) with ZERO production
 * callers. This module IS the production caller (L-W7): a daemon route that scans `memories`,
 * finds the ones PAST their activation-paced reverify interval, and routes them through the stale-ref
 * diagnostic (the `σ(m,t)` re-check). It mirrors {@link mountStaleRefApi} (PRD-058c) for the route
 * shape and the `mountCompactApi` (PRD-030) trigger pattern: `POST /api/diagnostics/reverify` onto
 * the already-mounted, protected `/api/diagnostics` group, ZERO `server.ts` edits.
 *
 * ── What this adds over the existing stale-ref trigger ───────────────────────
 * The stale-ref trigger ({@link mountStaleRefApi}) re-checks the WHOLE memory set in one pass. This
 * route adds the CADENCE: a memory is re-checked ONLY when its activation-paced interval has elapsed
 * (a hot memory sooner, a cold one later — never starved). So scarce model/graph budget is spent where
 * it matters (US-55e.3). The activation here is the SIMPLE Stage-1 proxy: a memory with a recent
 * `last_reinforced_at` is "hotter"; an unreachable activation read floors to cold (the longest bounded
 * interval, never `∞` — AC-55e.3.2). The full ACT-R Stage-2 activation is computed in recall; for a
 * maintenance pass the Stage-1 proxy is sufficient (the cadence math is monotone in `A`, so an
 * approximate `A` still orders the due set correctly).
 *
 * ── Fail-soft (the maintenance posture) ──────────────────────────────────────
 * A request with no resolvable tenancy fails closed at the edge (400). Everything else is best-effort:
 * a missing graph → the diagnostic's own fail-soft (`graphUnavailable`, nothing re-verified); a
 * per-memory error → that memory is skipped. A maintenance miss NEVER breaks recall (recall reads
 * the `ref_status`/`verified_at` columns; an absent reverify leaves them at their prior value).
 */

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { resolveScopeOrLocalDefault } from "../scope.js";
import type { Daemon } from "../server.js";
import type { SnapshotIdentity } from "../codebase/contracts.js";
import { resolveSnapshotIdentity } from "../codebase/identity.js";
import {
	isDueForReverify,
	type ReverifyScheduleConfig,
} from "../memories/reverify-schedule.js";
import {
	runStaleRefDiagnostic,
	type DiagnosticMemory,
	type SnapshotProvider,
	type StalePosture,
	type StaleRefDiagnosticReport,
} from "./stale-ref-diagnostic.js";
import { localSnapshotProvider, DEFAULT_STALE_REF_BATCH } from "./stale-ref-api.js";

/** The route the reverify trigger is served at (full path `/api/diagnostics/reverify`). */
export const REVERIFY_TRIGGER_PATH = "/reverify" as const;

/** The already-mounted, protected route group the trigger attaches to (no `server.ts` edit). */
export const REVERIFY_TRIGGER_GROUP = "/api/diagnostics" as const;

/**
 * How many memories one trigger pass scans (bounded so a manual trigger is a normal request). Mirrors
 * {@link DEFAULT_STALE_REF_BATCH}; the reverify pass is the SAME shape (a candidate-bounded scan).
 */
export const DEFAULT_REVERIFY_BATCH = DEFAULT_STALE_REF_BATCH;

/**
 * The default cadence for the periodic reverify trigger (L-W7). A maintenance pass runs roughly every
 * five minutes; the per-memory cadence (when an INDIVIDUAL memory is due) is the activation-paced
 * interval in `reverify-schedule.ts`. This interval governs only HOW OFTEN the scan itself fires.
 */
export const DEFAULT_REVERIFY_INTERVAL_MS = 5 * 60 * 1_000;

/** The 400 body for a request with no resolvable tenancy (fail-closed at the edge). */
const NO_ORG_BODY = { error: "bad_request", reason: "x-honeycomb-org header is required" } as const;

/** A memory row the reverify scan reads (the columns the cadence check needs). */
export interface ReverifyCandidate {
	/** The `memories.id`. */
	readonly id: string;
	/** The memory content (forwarded to the diagnostic as `DiagnosticMemory.content`). */
	readonly content: string;
	/** The ISO `verified_at` (the last re-check time); `null` when never verified. */
	readonly verifiedAt: string | null;
	/** The ISO `last_reinforced_at` (the Stage-1 activation proxy); `null` when never reinforced. */
	readonly lastReinforcedAt: string | null;
}

/**
 * The reverify scan summary body the trigger returns. Mirrors {@link StaleRefDiagnosticReport} plus
 * the scan's own counts (so the dashboard / CLI render the pass shape).
 */
export interface ReverifySummaryBody extends StaleRefDiagnosticReport {
	/** How many memories the scan considered. */
	readonly scanned: number;
	/** How many memories were DUE for reverify (cleared the activation-paced interval). */
	readonly due: number;
}

/** Options for {@link mountReverifyApi}. */
export interface MountReverifyOptions {
	/** The live storage client the scan + the diagnostic run through (guarded primitives). */
	readonly storage: StorageQuery;
	/** The daemon's own tenancy partition (the same `defaultScope` the other diagnostics mounts thread). */
	readonly defaultScope: QueryScope;
	/** The workspace dir the snapshot identity resolves from. Defaults to `process.cwd()`. */
	readonly workspaceDir?: string;
	/** The snapshot-provider override (a test injects a fake). Production → {@link localSnapshotProvider}. */
	readonly snapshots?: SnapshotProvider;
	/** The candidate-batch size. Defaults to {@link DEFAULT_REVERIFY_BATCH}. */
	readonly batch?: number;
	/** The reverify-schedule config (the cadence-interval bounds). Defaults to the `reverify-schedule` defaults. */
	readonly schedule?: ReverifyScheduleConfig;
	/** Wall clock for the cadence check (injected for deterministic tests). Defaults to `Date.now`. */
	readonly now?: () => number;
}

/** Resolve the posture from the request body defensively (default `observe` — the conservative posture). */
function resolvePosture(body: unknown): StalePosture {
	if (typeof body !== "object" || body === null) return "observe";
	const p = (body as { posture?: unknown }).posture;
	return p === "execute" ? "execute" : "observe";
}

/** Read the JSON body defensively (an absent / unparseable body → `undefined`, the `observe` default). */
async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		return undefined;
	}
}

/**
 * Read a `memories` cell as an ISO string OR `null` (the two reverify-relevant timestamp columns).
 * Returns `null` for an empty / non-finite stamp so the cadence check treats the memory as never-checked.
 */
function readIsoOrNull(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	const s = String(value);
	if (s.trim() === "") return null;
	const ms = Date.parse(s);
	return Number.isFinite(ms) ? s : null;
}

/**
 * Build the reverify scan SQL: the candidate memories whose `verified_at` is NULL (never checked) OR
 * older than the `threshold` ISO stamp. Bounded by `limit`. Every value routes through `sLiteral`
 * (the threshold) / `sqlIdent` (the identifiers) — `audit:sql` clean. The `is_deleted = 0` filter
 * excludes tombstones; `verified_at IS NULL` is the "never checked" case `isDueForReverify` returns
 * `true` for, so the scan surfaces those candidates unconditionally.
 */
export function buildReverifyScanSql(thresholdIso: string, limit: number): string {
	const tbl = sqlIdent("memories");
	const idCol = sqlIdent("id");
	const contentCol = sqlIdent("content");
	const verifiedCol = sqlIdent("verified_at");
	const reinforcedCol = sqlIdent("last_reinforced_at");
	const isDeletedCol = sqlIdent("is_deleted");
	const safeLimit = Math.max(1, Math.trunc(limit));
	return (
		`SELECT ${idCol} AS id, ${contentCol} AS content, ${verifiedCol} AS verified_at, ${reinforcedCol} AS last_reinforced_at ` +
		`FROM "${tbl}" ` +
		`WHERE ${isDeletedCol} = 0 AND (${verifiedCol} IS NULL OR ${verifiedCol} = '' OR ${verifiedCol} < ${sLiteral(thresholdIso)}) ` +
		`ORDER BY ${verifiedCol} ASC NULLS FIRST LIMIT ${safeLimit}`
	);
}

/**
 * Compute the Stage-1 activation proxy for a memory (PRD-058e): a memory with a recent
 * `last_reinforced_at` is "hotter" (closer to `1`); an unreachable / never-reinforced memory floors to
 * cold (`0` → the longest bounded interval, never `∞` — AC-55e.3.2). The full ACT-R Stage-2 activation
 * is computed in recall; for a maintenance pass the Stage-1 proxy is sufficient (the cadence math is
 * monotone in `A`, so an approximate `A` still orders the due set correctly). Pure.
 */
function stageOneActivation(candidate: ReverifyCandidate, nowMs: number): number {
	if (candidate.lastReinforcedAt === null) return 0;
	const reinforcedMs = Date.parse(candidate.lastReinforcedAt);
	if (!Number.isFinite(reinforcedMs)) return 0;
	const ageDays = Math.max(0, (nowMs - reinforcedMs) / (24 * 60 * 60 * 1_000));
	// A memory reinforced today ≈ 1; a week ago ≈ 0.3; a month ago ≈ 0.05 — the simple recency ramp.
	return Math.min(1, Math.max(0, 1 / (1 + ageDays / 7)));
}

/**
 * Filter the candidate set to the memories DUE for reverify (PRD-058e). A candidate is due when
 * `isDueForReverify(activation, lastCheckedMs, nowMs, config)` returns `true`. `lastCheckedMs` is the
 * `verified_at` (the last re-check time); `null` → due (never checked). Pure given the candidates.
 */
export function selectDueForReverify(
	candidates: readonly ReverifyCandidate[],
	nowMs: number,
	config: ReverifyScheduleConfig,
): ReverifyCandidate[] {
	const due: ReverifyCandidate[] = [];
	for (const c of candidates) {
		const activation = stageOneActivation(c, nowMs);
		const lastCheckedMs = c.verifiedAt === null ? null : Date.parse(c.verifiedAt);
		const lastChecked = Number.isFinite(lastCheckedMs as number) ? (lastCheckedMs as number) : null;
		if (isDueForReverify(activation, lastChecked, nowMs, config)) due.push(c);
	}
	return due;
}

/**
 * The pass function the route AND the periodic tick both call (L-W7 / PRD-058e). Resolves the
 * workspace + snapshot provider ONCE, scans the candidate memories (verified_at NULL or older than
 * the longest bounded reverify threshold), filters to the DUE subset (the activation-paced cadence
 * check), and runs the stale-ref diagnostic over that subset against the converged snapshot.
 * FAIL-SOFT: a read error → empty candidate set → nothing re-verified this pass; a missing graph →
 * the diagnostic's own fail-soft (`graphUnavailable`, nothing re-verified). Pure of HTTP — the route
 * maps this onto a status code, the tick calls it directly. Default posture `observe` (the
 * conservative one — detection visible-but-inert).
 */
export async function runReverifyPass(
	scope: QueryScope,
	options: MountReverifyOptions,
	posture: StalePosture = "observe",
): Promise<ReverifySummaryBody> {
	const workspaceDir = options.workspaceDir ?? process.cwd();
	const resolveIdentity = (s: QueryScope): SnapshotIdentity => resolveSnapshotIdentity(workspaceDir, s);
	const snapshots = options.snapshots ?? localSnapshotProvider(workspaceDir, resolveIdentity);
	const batch = options.batch ?? DEFAULT_REVERIFY_BATCH;
	const schedule = options.schedule;
	const now = options.now ?? Date.now;

	const nowMs = now();
	// The scan threshold: the LONGEST bounded reverify interval back from now (cold memories past this
	// age are candidates). A memory with a more recent `verified_at` is filtered OUT by the SQL.
	const longestMs = (schedule?.maxIntervalMs ?? 90 * 24 * 60 * 60 * 1_000);
	const thresholdIso = new Date(nowMs - longestMs).toISOString();

	// Scan the candidate memories (verified_at NULL or older than the threshold). FAIL-SOFT: a read
	// error yields an empty candidate set → nothing re-verified this pass, never a 500.
	let candidates: ReverifyCandidate[] = [];
	try {
		const res = await options.storage.query(buildReverifyScanSql(thresholdIso, batch), scope);
		if (isOk(res)) {
			candidates = (res.rows as StorageRow[]).map((row) => ({
				id: String(row.id ?? ""),
				content: String(row.content ?? ""),
				verifiedAt: readIsoOrNull(row.verified_at),
				lastReinforcedAt: readIsoOrNull(row.last_reinforced_at),
			})).filter((r) => r.id !== "");
		}
	} catch {
		candidates = [];
	}

	// Filter to the DUE subset (the activation-paced cadence check). A cold memory's interval is the
	// longest bounded value, so the SQL threshold + this check agree on the "deferred but not starved" set.
	const due = selectDueForReverify(candidates, nowMs, schedule ?? { minIntervalMs: 24 * 60 * 60 * 1_000, maxIntervalMs: longestMs });
	const diagnosticMemories: DiagnosticMemory[] = due.map((d) => ({ id: d.id, content: d.content }));

	// Run the stale-ref diagnostic over the DUE subset (the actual re-check). FAIL-SOFT inherits from
	// the diagnostic: a missing graph → `graphUnavailable`, nothing flagged stale, never a 500.
	const report = await runStaleRefDiagnostic(diagnosticMemories, scope, posture, { storage: options.storage, snapshots });
	return { ...report, scanned: candidates.length, due: due.length };
}

/**
 * Attach the reverify TRIGGER onto the daemon's already-mounted, protected `/api/diagnostics` group
 * (PRD-058c/058e). Registers `POST /api/diagnostics/reverify`, which resolves the request scope
 * (header org or the daemon default — fail-closed), scans `memories` for candidates past their
 * activation-paced reverify interval, runs the stale-ref diagnostic over the DUE subset against the
 * converged codebase-graph snapshot, and returns the summary. Call ONCE after `createDaemon(...)`. If
 * the group is not mounted the attach is a no-op. FAIL-SOFT: a missing graph marks NOTHING stale.
 */
export function mountReverifyApi(daemon: Daemon, options: MountReverifyOptions): void {
	const group = daemon.group(REVERIFY_TRIGGER_GROUP);
	if (group === undefined) return;

	group.post(REVERIFY_TRIGGER_PATH, async (c) => {
		const scope = resolveScopeOrLocalDefault(c, daemon.config.mode, options.defaultScope);
		if (scope === null) return c.json(NO_ORG_BODY, 400);

		const posture = resolvePosture(await readBody(c));
		const out = await runReverifyPass(scope, options, posture);
		return c.json(out, 200);
	});
}

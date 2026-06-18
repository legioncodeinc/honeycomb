/**
 * Routing-history store — PRD-010 Wave 1 (the real {@link RoutingHistoryStore}).
 *
 * Appends REDACTED routing-decision telemetry to the `routing_history` catalog
 * table and reads it back newest-first for a scope. 010c's
 * `GET /api/inference/history` and 010d's `honeycomb route status` both read
 * through this one impl.
 *
 * ── Redaction by construction (D-7 / the central thesis) ────────────────────
 * `record` accepts ONLY a {@link RedactedRoutingEvent} — a shape that cannot hold a
 * secret value, a resolved key, or a request/response body (see
 * `contracts.ts`). The writer serializes that event into the `event` JSONB column.
 * There is no code path here that touches a key or a prompt, so a redaction
 * REGRESSION would require deliberately widening the event type, not forgetting a
 * filter. `recent` reads the same redacted column back. The 010c c-AC-6 / 010d
 * d-AC-5 invariant (no secret value, no request body on disk) is therefore a
 * property of the TYPE, asserted by the live itest reading the raw row back.
 *
 * ── Append-only + scoped + deterministic id (PRD-002d / D-7) ─────────────────
 * `record` does `appendOnlyInsert` into `routing_history`: an immutable telemetry
 * event, never edited. The `id` is the sha256 of `request_id` + an attempt-count
 * discriminator, so a re-emitted event for the same request does not double under
 * a retry. `recent` reads `SELECT … WHERE org_id/workspace_id … ORDER BY
 * created_at DESC LIMIT n` — append-only immutable rows, so no highest-version
 * resolution is needed (unlike the version-bumped tables).
 *
 * ── SQL safety (PRD-002b) ───────────────────────────────────────────────────
 * Every value routes through `val.*` (→ `sLiteral`/`eLiteral`) on the write and
 * `sLiteral` on the read; every identifier through `sqlIdent`. The `event` JSONB
 * body is `JSON.stringify`'d then written through `val.text` (→ `eLiteral`, the
 * escape-safe `E'...'` form) so embedded quotes/backslashes round-trip. No
 * hand-quoted value, no raw fetch. `audit:sql` scans `src/daemon`.
 */

import crypto from "node:crypto";

import { healTargetFor, ROUTING_HISTORY_TABLE } from "../../storage/catalog/index.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { appendOnlyInsert, val } from "../../storage/writes.js";
import type {
	AttemptRecord,
	PolicyMode,
	RedactedRoutingEvent,
	RoutingHistoryScope,
	RoutingHistoryStore,
} from "./contracts.js";

/** The default `recent` page size when a caller does not bound it. */
export const DEFAULT_HISTORY_LIMIT = 50;
/** A hard ceiling on a `recent` read so a caller can never request an unbounded scan. */
export const MAX_HISTORY_LIMIT = 500;

/**
 * Deterministic telemetry-row id (D-7): sha256 of `request_id` + the attempt
 * count, `rh_`-prefixed. The attempt-count discriminator keeps a re-emitted event
 * for the same request from colliding with the prior one when the decision changed
 * (a retry produced more attempts), while a byte-identical re-emit dedups.
 */
export function routingEventId(requestId: string, attemptCount: number): string {
	const hash = crypto.createHash("sha256").update(`${requestId}:${attemptCount}`).digest("hex").slice(0, 24);
	return `rh_${hash}`;
}

/** The JSONB `event` body shape persisted on disk (redacted by construction). */
interface PersistedEvent {
	readonly request_id: string;
	readonly workload: string;
	readonly serving_target: string | null;
	readonly mode: PolicyMode;
	readonly attempts: readonly AttemptRecord[];
	readonly blocked_candidates: readonly { readonly targetId: string; readonly reason: string }[];
}

/** Build the persisted JSONB body from a redacted event. Pure; carries no secret/body. */
function toPersistedEvent(event: RedactedRoutingEvent): PersistedEvent {
	return {
		request_id: event.requestId,
		workload: event.workload,
		serving_target: event.servingTarget,
		mode: event.mode,
		attempts: event.attempts,
		blocked_candidates: event.blockedCandidates,
	};
}

/** Reconstruct a {@link RedactedRoutingEvent} from a persisted JSONB body. */
function fromPersistedEvent(body: PersistedEvent): RedactedRoutingEvent {
	return {
		requestId: body.request_id,
		workload: body.workload,
		servingTarget: body.serving_target,
		mode: body.mode,
		attempts: body.attempts ?? [],
		blockedCandidates: body.blocked_candidates ?? [],
	};
}

/** The injected clock, so a test stamps `created_at` deterministically. */
export interface HistoryStoreClock {
	/** Current wall-clock time in ms (defaults to `Date.now`). */
	readonly now: () => number;
}

/** Construction deps for the {@link DeeplakeRoutingHistoryStore}. */
export interface RoutingHistoryStoreDeps {
	/** The storage client telemetry is written/read through. */
	readonly storage: StorageQuery;
	/** The org/workspace partition the rows are isolated by. */
	readonly scope: QueryScope;
	/** Optional injected clock (real `Date.now` otherwise). */
	readonly clock?: HistoryStoreClock;
}

/**
 * The DeepLake-backed {@link RoutingHistoryStore}. Append-only, redacted by
 * construction, scoped by the injected partition. Construct via
 * {@link createRoutingHistoryStore}.
 */
export class DeeplakeRoutingHistoryStore implements RoutingHistoryStore {
	private readonly storage: StorageQuery;
	private readonly scope: QueryScope;
	private readonly clock: HistoryStoreClock;

	constructor(deps: RoutingHistoryStoreDeps) {
		this.storage = deps.storage;
		this.scope = deps.scope;
		this.clock = deps.clock ?? { now: () => Date.now() };
	}

	/**
	 * Append one redacted routing event (append-only, redacted by construction). The
	 * `event` JSONB carries ONLY the redaction-safe fields; the deterministic id
	 * keeps a retry from doubling the row. Every value goes through the guarded
	 * `val.*` path.
	 */
	async record(event: RedactedRoutingEvent): Promise<void> {
		const target = healTargetFor(ROUTING_HISTORY_TABLE);
		const createdAt = new Date(this.clock.now()).toISOString();
		const id = routingEventId(event.requestId, event.attempts.length);
		const body = JSON.stringify(toPersistedEvent(event));
		await appendOnlyInsert(this.storage, target, this.scope, [
			["id", val.str(id)],
			["org_id", val.str(this.scope.org)],
			["workspace_id", val.str(this.scope.workspace ?? "")],
			["request_id", val.str(event.requestId)],
			["workload", val.str(event.workload)],
			["created_at", val.str(createdAt)],
			// JSONB body via the escape-safe E'...' form so quotes/backslashes survive.
			["event", val.text(body)],
		]);
	}

	/**
	 * Read the newest redacted events for the store's scope, newest-first, up to
	 * `limit` (clamped to {@link MAX_HISTORY_LIMIT}). Append-only immutable rows, so
	 * a plain scoped `ORDER BY created_at DESC LIMIT n` is correct — no
	 * highest-version resolution. Every value goes through `sLiteral`; every
	 * identifier through `sqlIdent`. A malformed `event` body is skipped, never
	 * thrown past this boundary.
	 */
	async recent(scope: RoutingHistoryScope, limit: number): Promise<RedactedRoutingEvent[]> {
		const tbl = sqlIdent(ROUTING_HISTORY_TABLE);
		const clampedLimit = clampLimit(limit);
		const sql =
			`SELECT event FROM "${tbl}" ` +
			`WHERE org_id = ${sLiteral(scope.org)} AND workspace_id = ${sLiteral(scope.workspace)} ` +
			`ORDER BY created_at DESC LIMIT ${clampedLimit}`;
		const res = await this.storage.query(sql, { org: scope.org, workspace: scope.workspace });
		if (!isOk(res)) return [];
		const out: RedactedRoutingEvent[] = [];
		for (const row of res.rows) {
			const parsed = parseEventColumn(row);
			if (parsed !== null) out.push(parsed);
		}
		return out;
	}
}

/** Clamp a requested limit into `[1, MAX_HISTORY_LIMIT]`, defaulting a bad value. */
function clampLimit(limit: number): number {
	if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_HISTORY_LIMIT;
	return Math.min(Math.trunc(limit), MAX_HISTORY_LIMIT);
}

/**
 * Parse the `event` column off a result row into a {@link RedactedRoutingEvent}.
 * Tolerates the JSONB arriving as an already-parsed object OR as a JSON string
 * (the backend may return either). Returns `null` on a malformed body so one bad
 * row never fails the whole read.
 */
function parseEventColumn(row: StorageRow): RedactedRoutingEvent | null {
	const raw = row.event;
	let body: unknown = raw;
	if (typeof raw === "string") {
		try {
			body = JSON.parse(raw);
		} catch {
			return null;
		}
	}
	if (body === null || typeof body !== "object") return null;
	const candidate = body as PersistedEvent;
	if (typeof candidate.request_id !== "string") return null;
	return fromPersistedEvent(candidate);
}

/** Build a {@link DeeplakeRoutingHistoryStore}. The daemon injects the real deps; tests inject fakes. */
export function createRoutingHistoryStore(deps: RoutingHistoryStoreDeps): RoutingHistoryStore {
	return new DeeplakeRoutingHistoryStore(deps);
}

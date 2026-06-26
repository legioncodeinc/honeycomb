/**
 * PRD-058b, the conflict-resolution endpoint — `POST /api/memories/conflicts/:id/resolve`.
 *
 * The operator surface over a detected conflict (PRD-058b API spec). The detector runs
 * daemon-internal with no public write endpoint; THIS is the single public mutation that
 * applies an operator's verdict to a recorded `memory_conflicts` row:
 *
 *   - `supersede` → marks the NON-winner via the PRD-008 append-only version bump (the
 *                   loser memory is superseded through `supersedeLoser`), sets
 *                   `kappa_loser = 0`, `status = 'resolved'`. `winnerId` is REQUIRED (a
 *                   `supersede` with no winner is a `400 invalid_verdict`).
 *   - `review`    → sets `kappa_loser = ρ` (default 0, reversible), `status = 'resolved'`.
 *   - `keep-both` → sets `kappa_loser = 1`, `status = 'resolved'`, and MEMOIZES the pair
 *                   so detection does not re-flag it (AC-55b.2.4).
 *
 * Every path APPENDS to `memory_history` (actor, reason, confidence) and PROJECTS the new
 * state into `memory_conflicts` as a version-bumped row (the live verdict is `MAX(version)`),
 * never an in-place UPDATE. The endpoint reads its own write back POLLING TO CONVERGENCE
 * (DeepLake reads flap stale segments).
 *
 * ── Auth + scope (PRD-058b API spec) ─────────────────────────────────────────
 * Bearer token, operator scope; the `/api/memories` group is already mounted behind the
 * runtime-path + permission middleware (`server.ts` `ROUTE_GROUPS`), so attaching via
 * `daemon.group("/api/memories")` inherits auth/RBAC. Scope is resolved from the
 * `x-honeycomb-*` headers (fail-closed: no org → 400). A conflict OUTSIDE the caller's scope
 * returns `404` (an out-of-scope conflict is indistinguishable from a missing one — no
 * cross-tenant existence leak).
 *
 * ── Errors ───────────────────────────────────────────────────────────────────
 *   - `400 invalid_verdict`  — a malformed body, an unknown verdict, OR `supersede` with no `winnerId`.
 *   - `404 conflict_not_found` — no conflict with that id in the caller's scope.
 *   - `409 already_resolved`  — the conflict's live status is already `resolved` / `reversed`.
 *
 * ── SQL safety ───────────────────────────────────────────────────────────────
 * The endpoint binds no parameters; every interpolated value (the conflict id, the memory ids,
 * the scope) routes through `sLiteral` / `sqlIdent` via the catalog SQL builders + the `val.*`
 * write helpers. No hand-quoted SQL (`audit:sql` scans `src/daemon`).
 */

import type { Context } from "hono";
import { z } from "zod";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { Daemon } from "../server.js";
import { resolveScopeFromHeaders, resolveScopeOrLocalDefault } from "../scope.js";
import {
	type ConflictSignal,
	type ConflictStatus,
	type ConflictVerdict,
	CONFLICT_VERDICTS,
	normalizeConflictPair,
} from "../../storage/catalog/memory-conflicts.js";
import {
	appendConflictHistory,
	type ConflictPersistDeps,
	DEFAULT_RHO,
	projectConflict,
	readConflictConverged,
	supersedeLoser,
} from "./conflict-resolve.js";
import type { KeepBothMemo } from "./conflict-detect.js";
import type { MemoryWriteDeps } from "./store.js";

/** The route group the conflicts API attaches to (already mounted in `server.ts`). */
export const MEMORIES_GROUP = "/api/memories" as const;

/** The writable `keep-both` memo seam (the read side is {@link KeepBothMemo} on the detector). */
export interface KeepBothMemoStore extends KeepBothMemo {
	/** Memoize the normalized pair as a `keep-both` false positive so detection does not re-flag it. */
	remember(aId: string, bId: string): void | Promise<void>;
}

/** Options for {@link mountConflictsApi}. */
export interface MountConflictsOptions {
	/** The storage client every read + write runs through. */
	readonly storage: StorageQuery;
	/** The memory write deps (for the loser supersession version bump). Defaults to `{ storage }`. */
	readonly writeDeps?: MemoryWriteDeps;
	/** The daemon's configured default tenancy scope (local-mode fallback). */
	readonly defaultScope?: QueryScope;
	/** The `keep-both` memo store (AC-55b.2.4). ABSENT → keep-both does not memoize (still resolves). */
	readonly keepBothMemo?: KeepBothMemoStore;
	/** The open-conflict suppression `ρ` for a `review` verdict (default {@link DEFAULT_RHO}). */
	readonly rho?: number;
	/** A clock for timestamps; defaults to wall-clock. */
	readonly now?: () => Date;
}

/** The zod body for the resolve endpoint (PRD-058b API spec). */
export const ResolveSchema = z.object({
	verdict: z.enum(CONFLICT_VERDICTS),
	winnerId: z.string().uuid().optional(), // required when verdict = 'supersede' (enforced post-parse).
	reason: z.string().max(500).optional(),
});

/** The validated resolve request. */
export type ResolveRequest = z.infer<typeof ResolveSchema>;

/** The typed outcome of applying a resolution (the testable core's return). */
export type ResolveOutcome =
	| { readonly kind: "ok"; readonly row: Record<string, unknown> }
	| { readonly kind: "invalid_verdict"; readonly reason: string }
	| { readonly kind: "conflict_not_found" }
	| { readonly kind: "already_resolved" };

/** Read a string cell, defaulting to "". */
function str(v: unknown): string {
	return v === undefined || v === null ? "" : String(v);
}

/**
 * Apply a resolution to a conflict (PRD-058b) — the testable core. Reads the live conflict by id
 * (scoped), validates the verdict (supersede requires `winnerId`; the winner must be one of the
 * pair), applies the κ assignment + (for supersede) the loser version bump, projects the new
 * version-bumped state, appends `memory_history`, and reads the projection back to convergence.
 * Pure of HTTP: returns a typed {@link ResolveOutcome} the handler maps to a status code.
 */
export async function applyConflictResolution(
	conflictId: string,
	request: ResolveRequest,
	scope: QueryScope,
	deps: {
		readonly persist: ConflictPersistDeps;
		readonly writeDeps: MemoryWriteDeps;
		readonly keepBothMemo?: KeepBothMemoStore;
		readonly rho?: number;
	},
): Promise<ResolveOutcome> {
	// Read the live (highest-version) conflict row in the caller's scope. An out-of-scope or missing
	// conflict is the SAME 404 (no cross-tenant existence leak): the read runs under the partition scope,
	// so a row in another partition is simply not returned.
	const row = await readConflictConverged(conflictId, deps.persist, scope);
	if (row === null) return { kind: "conflict_not_found" };

	const status = str(row.status) as ConflictStatus;
	if (status === "resolved" || status === "reversed") return { kind: "already_resolved" };

	const aId = str(row.memory_a_id);
	const bId = str(row.memory_b_id);
	const verdict: ConflictVerdict = request.verdict;

	// supersede REQUIRES a winnerId, and it must be one of the pair.
	if (verdict === "supersede") {
		if (request.winnerId === undefined) return { kind: "invalid_verdict", reason: "supersede requires winnerId" };
		if (request.winnerId !== aId && request.winnerId !== bId) {
			return { kind: "invalid_verdict", reason: "winnerId must be one of the conflict pair" };
		}
	}

	const rho = deps.rho ?? DEFAULT_RHO;
	const reason = request.reason ?? `operator resolution: ${verdict}`;
	const confidence = num(row.confidence, 0);
	const contra = num(row.contra_score, 0);
	const claimSlot = row.claim_slot === null || row.claim_slot === undefined ? undefined : str(row.claim_slot);

	let kappaLoser: number;
	let winnerId: string | undefined;
	if (verdict === "supersede") {
		winnerId = request.winnerId;
		const loserId = winnerId === aId ? bId : aId;
		// PRD-008 append-only version bump: NEVER a destructive delete (AC-55b.4.3).
		await supersedeLoser(loserId, reason, deps.writeDeps, scope);
		await appendConflictHistory({ memoryId: loserId, operation: "conflict_resolve", reason, confidence }, deps.persist, scope);
		kappaLoser = 0;
	} else if (verdict === "review") {
		kappaLoser = rho;
		await appendConflictHistory({ memoryId: aId, operation: "conflict_resolve", reason, confidence }, deps.persist, scope);
	} else {
		// keep-both → both stay live (κ = 1) and the normalized pair is memoized (AC-55b.2.4).
		kappaLoser = 1;
		if (deps.keepBothMemo !== undefined) {
			const norm = normalizeConflictPair(aId, bId);
			await deps.keepBothMemo.remember(norm.aId, norm.bId);
		}
		await appendConflictHistory({ memoryId: aId, operation: "conflict_resolve", reason, confidence }, deps.persist, scope);
	}

	// Project the resolved state as a fresh version-bumped row (the live verdict is MAX(version)).
	const createdAt = (deps.persist.now ?? (() => new Date()))().toISOString();
	await projectConflict(
		{
			conflictId,
			memoryAId: aId,
			memoryBId: bId,
			...(claimSlot !== undefined ? { claimSlot } : {}),
			signal: (str(row.signal) || "lexical") as ConflictSignal,
			contraScore: contra,
			margin: num(row.margin, 0),
			verdict,
			...(winnerId !== undefined ? { winnerId } : {}),
			kappaLoser,
			status: "resolved",
			confidence,
			createdAt,
			agentId: str(row.agent_id) || "default",
		},
		deps.persist,
		scope,
	);

	// Read the resolved projection back to convergence (read-your-write, never a single immediate read).
	const updated = await readConflictConverged(conflictId, deps.persist, scope);
	return { kind: "ok", row: updated ?? { id: conflictId, verdict, kappa_loser: kappaLoser, status: "resolved" } };
}

/** Read a numeric cell, defaulting when absent/garbage. */
function num(v: unknown, fallback: number): number {
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? n : fallback;
}

/** Read + JSON-parse the request body, tolerating an empty/invalid body (returns `{}`). */
async function readJsonBody(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		return {};
	}
}

/**
 * Mount `POST /api/memories/conflicts/:id/resolve` (PRD-058b). Attaches onto the already-mounted
 * `/api/memories` group, inheriting auth/RBAC + the session gate. Call ONCE after `createDaemon`,
 * beside {@link import("./api.js").mountMemoriesApi}.
 */
export function mountConflictsApi(daemon: Daemon, options: MountConflictsOptions): void {
	const group = daemon.group(MEMORIES_GROUP);
	if (group === undefined) return;

	const persist: ConflictPersistDeps = { storage: options.storage, ...(options.now !== undefined ? { now: options.now } : {}) };
	const writeDeps: MemoryWriteDeps = options.writeDeps ?? { storage: options.storage };
	const resolveScope = (c: Context): QueryScope | null =>
		resolveScopeOrLocalDefault(c, daemon.config.mode, options.defaultScope);

	group.post("/conflicts/:id/resolve", async (c) => {
		const scope = resolveScope(c);
		if (scope === null) {
			return c.json({ error: "bad_request", reason: "x-honeycomb-org header is required" }, 400);
		}
		const conflictId = c.req.param("id");
		if (conflictId === undefined || conflictId.trim() === "") {
			return c.json({ error: "invalid_verdict", reason: "conflict id is required" }, 400);
		}
		const parsed = ResolveSchema.safeParse(await readJsonBody(c));
		if (!parsed.success) {
			return c.json(
				{ error: "invalid_verdict", reason: "request body failed validation", issues: parsed.error.issues.map((i) => i.message) },
				400,
			);
		}

		const outcome = await applyConflictResolution(conflictId, parsed.data, scope, {
			persist,
			writeDeps,
			...(options.keepBothMemo !== undefined ? { keepBothMemo: options.keepBothMemo } : {}),
			...(options.rho !== undefined ? { rho: options.rho } : {}),
		});

		switch (outcome.kind) {
			case "ok":
				return c.json({ conflict: outcome.row }, 200);
			case "invalid_verdict":
				return c.json({ error: "invalid_verdict", reason: outcome.reason }, 400);
			case "conflict_not_found":
				return c.json({ error: "conflict_not_found", id: conflictId }, 404);
			case "already_resolved":
				return c.json({ error: "already_resolved", id: conflictId }, 409);
		}
	});
}

/** Resolve the per-request scope from headers only (exported for tests / parity with `api.ts`). */
export function resolveConflictScope(c: Context): QueryScope | null {
	return resolveScopeFromHeaders(c);
}

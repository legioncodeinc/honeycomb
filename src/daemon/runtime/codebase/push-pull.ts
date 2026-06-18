/**
 * Push / Pull — PRD-014c (Wave 2). Best-effort cloud sync of a codebase-graph
 * {@link Snapshot} to the existing `codebase` table (PRD-003d `catalog/product.ts`),
 * through the daemon's `StorageQuery`. The local snapshot is ALWAYS authoritative;
 * push never blocks the build.
 *
 * ── The two operations ──────────────────────────────────────────────────────
 *   - {@link pushSnapshot}  SELECT-before-INSERT drift detection on the FULL
 *     identity tuple `(org, workspace, repo, user, worktree, commit)`. A matching
 *     `snapshot_sha256` is a NO-OP (`already-current`); a DIFFERING hash for the
 *     same identity logs `drift` and REFUSES to overwrite (never clobbers a row);
 *     no row → INSERT, then re-SELECT — more than one row → `inserted-with-
 *     duplicate-race` so the race is observable (FR-4..FR-6 / c-AC-1 / c-AC-5).
 *   - {@link pullSnapshot}  fetch the freshest snapshot of the current HEAD for
 *     this user from ANY worktree (relax the key: drop `worktree_id`, `ORDER BY
 *     created_at DESC LIMIT 1`), deserialize `snapshot_jsonb`, then RECOMPUTE the
 *     stable-field hash via {@link computeSnapshotSha256} and require it == the
 *     claimed `snapshot_sha256` — else REFUSE the payload (return null) so a
 *     corrupt/poisoned row never enters the local cache (FR-8 / FR-9 / c-AC-2).
 *
 * ── Why not the `selectBeforeInsert` primitive verbatim ─────────────────────
 * That primitive probes a SINGLE key column; `codebase` is keyed by a SIX-column
 * identity tuple AND push needs the stored `snapshot_sha256` back to compare for
 * drift (a presence check is not enough). So this module builds the composite
 * probe + INSERT + re-verify itself — through the SAME guarded helpers
 * (`sqlIdent` for identifiers, `val.*` / `renderValue` / `buildInsert` for
 * values; never a raw interpolation — `npm run audit:sql` enforces it) and the
 * SAME observable-race discipline (FR-6).
 *
 * ── DAEMON-ONLY storage ─────────────────────────────────────────────────────
 * This module runs daemon-side and talks to DeepLake only through the injected
 * {@link StorageQuery}. CLIs reach it over the daemon RPC. A `resolveTable` seam
 * lets a live itest route the canonical `codebase` name to a per-run throwaway
 * table NATIVELY (the proven recall-authz/graph-persist/sources-purge isolation
 * technique) rather than rewriting SQL strings after the fact.
 */

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { type HealTarget, withHeal } from "../../storage/heal.js";
import { isOk, type QueryResult, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { buildInsert, type RowValues, val } from "../../storage/writes.js";
import { CODEBASE_COLUMNS } from "../../storage/catalog/product.js";

import { type Snapshot, type SnapshotIdentity } from "./contracts.js";
import { computeSnapshotSha256 } from "./snapshot.js";

/** The canonical catalog table this module reads/writes (PRD-003d). */
export const CODEBASE_TABLE = "codebase" as const;

/**
 * Poll budget for a poll-convergent multi-row read against the live backend
 * (FR-6). A single bare scan of just-written rows can return a STALE subset on
 * this backend, so the duplicate-race re-verification unions across polls (the
 * graph-persist/sources `scanDistinct` discipline). The deterministic fake is
 * authoritative on the first poll, so a unit test injects `1`.
 */
export const PUSH_VERIFY_POLLS = 12;

// ════════════════════════════════════════════════════════════════════════════
// PushOutcome — the typed union every push returns (FR-2..FR-6 / c-AC-1/3/4/5).
// ════════════════════════════════════════════════════════════════════════════

/**
 * The result of a {@link pushSnapshot}. A discriminated union over `kind` so the
 * caller branches exhaustively and the build pipeline never has to interpret a
 * thrown error: push is BEST-EFFORT and surfaces every outcome as data.
 *
 * - `already-current`            a row for the identity already carries the SAME
 *                                `snapshot_sha256` → no-op, nothing written (c-AC-1).
 * - `drift`                      a row for the identity carries a DIFFERING hash →
 *                                logged + REFUSED; the stored row is NOT overwritten
 *                                (c-AC-1). `storedSha256` is what was already there.
 * - `inserted`                   no prior row → INSERT landed; re-verify saw one row.
 * - `inserted-with-duplicate-race` INSERT landed but re-verify saw MORE than one row
 *                                for the identity → a concurrent writer doubled it; the
 *                                race is reported, not hidden (c-AC-5).
 * - `skipped`                    no auth / no commit context / `HONEYCOMB_GRAPH_PUSH=0`
 *                                → push skipped SILENTLY (c-AC-3). `reason` says which.
 * - `failed`                     a storage error → logged, NON-blocking; the local
 *                                snapshot stays authoritative (c-AC-4). `message` is
 *                                the (redacted) failure.
 */
export type PushOutcome =
	| { readonly kind: "already-current"; readonly sha256: string }
	| { readonly kind: "drift"; readonly incomingSha256: string; readonly storedSha256: string }
	| { readonly kind: "inserted"; readonly sha256: string }
	| { readonly kind: "inserted-with-duplicate-race"; readonly sha256: string; readonly rowCount: number }
	| { readonly kind: "skipped"; readonly reason: PushSkipReason }
	| { readonly kind: "failed"; readonly message: string };

/** Why a push was skipped silently (c-AC-3). */
export type PushSkipReason = "no-auth" | "no-commit" | "disabled-env";

// ════════════════════════════════════════════════════════════════════════════
// Push/pull context — the auth + env gate and the table seam.
// ════════════════════════════════════════════════════════════════════════════

/** A minimal logger seam (a `drift` warning / a `failed` log). Defaults to console. */
export interface PushPullLogger {
	warn(event: string, detail?: Record<string, unknown>): void;
	info(event: string, detail?: Record<string, unknown>): void;
}

const defaultLogger: PushPullLogger = {
	warn(event, detail) {
		process.stderr.write(`[codebase-push] WARN ${event}${detail ? ` ${JSON.stringify(detail)}` : ""}\n`);
	},
	info(event, detail) {
		process.stderr.write(`[codebase-push] ${event}${detail ? ` ${JSON.stringify(detail)}` : ""}\n`);
	},
};

/**
 * The push/pull context: the storage handle + scope, the auth gate, and the
 * table seam. The daemon assembles this; a test injects a fake storage + an
 * explicit `authenticated` flag.
 */
export interface PushPullContext {
	readonly storage: StorageQuery;
	readonly scope: QueryScope;
	/** Whether the user is authenticated (FR-1 / FR-3 / c-AC-3). `false` → skip. */
	readonly authenticated: boolean;
	/** Who is pushing (the `pushed_by` column). Optional diagnostic. */
	readonly pushedBy?: string;
	/** Logger seam (drift warning / failure log). Defaults to stderr. */
	readonly logger?: PushPullLogger;
	/**
	 * Maps the canonical `codebase` name to the PHYSICAL table to read/write.
	 * Identity in production. A live itest injects a per-run throwaway name so the
	 * heal CREATEs the physical table NATIVELY (the proven isolation seam).
	 */
	readonly resolveTable?: (canonical: string) => string;
	/** Re-verify poll budget (FR-6). Defaults to {@link PUSH_VERIFY_POLLS}; a unit test injects 1. */
	readonly verifyPolls?: number;
}

/** The `codebase` HealTarget routed through the (optional) table seam. */
function codebaseTarget(ctx: PushPullContext): HealTarget {
	const physical = ctx.resolveTable ? ctx.resolveTable(CODEBASE_TABLE) : CODEBASE_TABLE;
	return { table: physical, columns: CODEBASE_COLUMNS };
}

/** Read the `HONEYCOMB_GRAPH_PUSH` env gate (c-AC-3). `"0"` disables push. */
function pushDisabledByEnv(): boolean {
	return process.env.HONEYCOMB_GRAPH_PUSH === "0";
}

/** True when an identity carries a non-empty commit (FR-3 — "no commit context"). */
function hasCommitContext(identity: SnapshotIdentity): boolean {
	return identity.commit.trim() !== "";
}

// ════════════════════════════════════════════════════════════════════════════
// PUSH — SELECT-before-INSERT with drift detection (FR-4..FR-6 / c-AC-1/3/4/5).
// ════════════════════════════════════════════════════════════════════════════

/**
 * Push a snapshot to the `codebase` table, best-effort (FR-1..FR-6 / c-AC-1/3/4/5).
 *
 * The flow:
 *   1. SKIP GATE (c-AC-3): no auth / no commit / `HONEYCOMB_GRAPH_PUSH=0` →
 *      `skipped`, no error, nothing written.
 *   2. SELECT the row for the FULL identity tuple (poll-convergent). A storage
 *      failure here → `failed` (logged, non-blocking — c-AC-4).
 *   3. ROW PRESENT: compare the stored `snapshot_sha256`:
 *        - == incoming → `already-current` no-op (c-AC-1).
 *        - != incoming → `drift`: log a warning + REFUSE to overwrite (c-AC-1).
 *   4. ROW ABSENT: INSERT the canonical bytes, then re-SELECT (poll-convergent):
 *        - exactly one row → `inserted`.
 *        - more than one  → `inserted-with-duplicate-race` (c-AC-5).
 *      An INSERT failure → `failed` (c-AC-4).
 *
 * `sha256` is the already-computed canonical hash (014b's `finalizeSnapshot`
 * produces it); it is the drift comparator and the stored `snapshot_sha256`.
 */
export async function pushSnapshot(
	snapshot: Snapshot,
	sha256: string,
	identity: SnapshotIdentity,
	ctx: PushPullContext,
): Promise<PushOutcome> {
	const logger = ctx.logger ?? defaultLogger;

	// 1. SKIP GATE (c-AC-3) — silent, no error.
	if (!ctx.authenticated) return { kind: "skipped", reason: "no-auth" };
	if (!hasCommitContext(identity)) return { kind: "skipped", reason: "no-commit" };
	if (pushDisabledByEnv()) return { kind: "skipped", reason: "disabled-env" };

	const target = codebaseTarget(ctx);

	// 2. SELECT the existing row for the full identity tuple.
	const existing = await selectByIdentity(ctx, target, identity);
	if (existing.kind === "error") {
		// c-AC-4: a storage error never blocks the build; the local snapshot stays
		// authoritative. Logged, returned as data.
		logger.warn("push-select-failed", { message: existing.message });
		return { kind: "failed", message: existing.message };
	}

	// 3. ROW PRESENT → drift comparison (c-AC-1).
	if (existing.kind === "present") {
		const storedSha256 = existing.storedSha256;
		if (storedSha256 === sha256) {
			return { kind: "already-current", sha256 };
		}
		// DIFFERING hash for the SAME identity → drift. Log + REFUSE to overwrite.
		// We deliberately do NOT INSERT and do NOT UPDATE: the stored row is left
		// intact so extractor-version skew is investigated by a human, never silently
		// clobbered (FR-5 / c-AC-1).
		logger.warn("push-drift", {
			repo: identity.repo,
			commit: identity.commit,
			incomingSha256: sha256,
			storedSha256,
		});
		return { kind: "drift", incomingSha256: sha256, storedSha256 };
	}

	// 4. ROW ABSENT → INSERT, then re-verify (c-AC-5).
	const inserted = await insertSnapshotRow(ctx, target, snapshot, sha256, identity);
	if (inserted.kind === "error") {
		logger.warn("push-insert-failed", { message: inserted.message });
		return { kind: "failed", message: inserted.message };
	}

	const rowCount = await countIdentityRows(ctx, target, identity);
	if (rowCount > 1) {
		logger.warn("push-duplicate-race", { repo: identity.repo, commit: identity.commit, rowCount });
		return { kind: "inserted-with-duplicate-race", sha256, rowCount };
	}
	return { kind: "inserted", sha256 };
}

// ── Push internals ────────────────────────────────────────────────────────────

/** The outcome of the identity SELECT: a storage error, a present row (with its hash), or absent. */
type IdentitySelect =
	| { readonly kind: "error"; readonly message: string }
	| { readonly kind: "present"; readonly storedSha256: string }
	| { readonly kind: "absent" };

/**
 * SELECT the stored `snapshot_sha256` for the FULL identity tuple. Poll-convergent
 * (a bare read can land on a stale empty segment on the live backend, never invents
 * a row): the FIRST poll that observes a row wins — presence is monotonic for a
 * committed write. The fake answers on poll 0.
 */
async function selectByIdentity(
	ctx: PushPullContext,
	target: HealTarget,
	identity: SnapshotIdentity,
): Promise<IdentitySelect> {
	const tbl = sqlIdent(target.table);
	const shaCol = sqlIdent("snapshot_sha256");
	const sql = `SELECT ${shaCol} FROM "${tbl}" WHERE ${identityWhere(identity)} LIMIT 1`;

	const polls = ctx.verifyPolls ?? PUSH_VERIFY_POLLS;
	for (let poll = 0; poll < polls; poll++) {
		const res = await runHealed(ctx, target, sql);
		if (!isOk(res)) {
			// A query_error/connection_error/timeout is a storage failure → c-AC-4.
			return { kind: "error", message: errMessage(res) };
		}
		if (res.rows.length > 0) {
			const stored = (res.rows[0] as StorageRow).snapshot_sha256;
			return { kind: "present", storedSha256: typeof stored === "string" ? stored : String(stored ?? "") };
		}
	}
	return { kind: "absent" };
}

/** Count the rows for the identity tuple, poll-convergent (the duplicate-race re-verify). */
async function countIdentityRows(ctx: PushPullContext, target: HealTarget, identity: SnapshotIdentity): Promise<number> {
	const tbl = sqlIdent(target.table);
	const shaCol = sqlIdent("snapshot_sha256");
	const sql = `SELECT ${shaCol} FROM "${tbl}" WHERE ${identityWhere(identity)}`;

	const polls = ctx.verifyPolls ?? PUSH_VERIFY_POLLS;
	let maxSeen = 0;
	for (let poll = 0; poll < polls; poll++) {
		const res = await runHealed(ctx, target, sql);
		if (isOk(res) && res.rows.length > maxSeen) maxSeen = res.rows.length;
	}
	return maxSeen;
}

/** INSERT a fresh snapshot row carrying the canonical bytes + the identity + drift diagnostics. */
async function insertSnapshotRow(
	ctx: PushPullContext,
	target: HealTarget,
	snapshot: Snapshot,
	sha256: string,
	identity: SnapshotIdentity,
): Promise<{ kind: "ok" } | { kind: "error"; message: string }> {
	const sql = buildInsert(target.table, snapshotRowValues(snapshot, sha256, identity, ctx.pushedBy));
	const res = await runHealed(ctx, target, sql);
	if (isOk(res)) return { kind: "ok" };
	return { kind: "error", message: errMessage(res) };
}

/**
 * Run a statement heal-aware: a missing-table/missing-column `query_error` triggers
 * a targeted heal + ONE retry (PRD-002c `withHeal`). This is what lets a live itest
 * route the canonical `codebase` name to a per-run throwaway table NATIVELY — the
 * heal CREATEs the physical table on the first push touch — and matches the daemon's
 * production self-heal path. Any non-schema failure returns unhealed (→ c-AC-4).
 */
function runHealed(ctx: PushPullContext, target: HealTarget, sql: string): Promise<QueryResult> {
	return withHeal(ctx.storage, target, ctx.scope, () => ctx.storage.query(sql, ctx.scope));
}

/** Extract the (already-redacted) message from a non-ok result. */
function errMessage(res: QueryResult): string {
	return res.kind === "ok" ? "" : (res as { message: string }).message;
}

/**
 * The composite-identity WHERE predicate, every column through `sqlIdent` and
 * every value through `sLiteral` (never a raw interpolation). Maps the runtime
 * {@link SnapshotIdentity} onto the `codebase` columns (org→org_id, …).
 */
function identityWhere(identity: SnapshotIdentity): string {
	const eq = (col: string, value: string): string => `${sqlIdent(col)} = ${sLiteral(value)}`;
	return [
		eq("org_id", identity.org),
		eq("workspace_id", identity.workspace),
		eq("repo_slug", identity.repo),
		eq("user_id", identity.user),
		eq("worktree_id", identity.worktree),
		eq("commit_sha", identity.commit),
	].join(" AND ");
}

/** The relaxed WHERE for pull (FR-8): drop `worktree_id` so the freshest from ANY worktree matches. */
function pullWhere(identity: SnapshotIdentity): string {
	const eq = (col: string, value: string): string => `${sqlIdent(col)} = ${sLiteral(value)}`;
	return [
		eq("org_id", identity.org),
		eq("workspace_id", identity.workspace),
		eq("repo_slug", identity.repo),
		eq("user_id", identity.user),
		eq("commit_sha", identity.commit),
	].join(" AND ");
}

/**
 * The INSERT column values for a snapshot row. `snapshot_jsonb` carries the
 * canonical node-link bytes (FR-6); the identity tuple maps onto the tenant +
 * row-identity columns; counts + generator metadata come from the snapshot's
 * VOLATILE observation (diagnostics only — they do not affect the stable hash).
 *
 * The jsonb body goes through `val.text` (→ `E'...'`) so the brace/quote/backslash
 * payload round-trips safely; every other value through `val.str` / `val.num`.
 */
function snapshotRowValues(
	snapshot: Snapshot,
	sha256: string,
	identity: SnapshotIdentity,
	pushedBy: string | undefined,
): RowValues {
	const obs = snapshot.observation;
	return [
		["org_id", val.str(identity.org)],
		["workspace_id", val.str(identity.workspace)],
		["repo_slug", val.str(identity.repo)],
		["user_id", val.str(identity.user)],
		["worktree_id", val.str(identity.worktree)],
		["commit_sha", val.str(identity.commit)],
		["branch", val.str(obs.branch ?? "")],
		["pushed_by", val.str(pushedBy ?? identity.user)],
		["snapshot_sha256", val.str(sha256)],
		["snapshot_jsonb", val.text(JSON.stringify(snapshot))],
		["node_count", val.num(obs.nodeCount)],
		["edge_count", val.num(obs.edgeCount)],
		["generator_version", val.str(obs.generatorVersion)],
		["created_at", val.str(obs.generatedAt)],
	];
}

// ════════════════════════════════════════════════════════════════════════════
// PULL — fetch freshest for HEAD + hash revalidation (FR-8/FR-9/FR-10 / c-AC-2/6).
// ════════════════════════════════════════════════════════════════════════════

/** The result of a {@link pullSnapshot}: the validated snapshot, or a typed refusal. */
export type PullOutcome =
	| { readonly kind: "pulled"; readonly snapshot: Snapshot; readonly sha256: string }
	| { readonly kind: "local-newer" }
	| { readonly kind: "not-found" }
	| { readonly kind: "refused"; readonly reason: PullRefusalReason; readonly detail?: string }
	| { readonly kind: "failed"; readonly message: string };

/** Why a pulled payload was refused (c-AC-2). */
export type PullRefusalReason = "hash-mismatch" | "malformed-payload";

/** Local context for the commit-ordering decision (FR-10 / c-AC-6). */
export interface PullLocalContext {
	/** The commit the LOCAL snapshot was built from, if a local snapshot exists. */
	readonly localCommit?: string;
	/** The commit currently checked out (HEAD) — what we are pulling FOR. */
	readonly headCommit: string;
}

/**
 * Pull the freshest snapshot for the current HEAD (FR-8..FR-10 / c-AC-2 / c-AC-6).
 *
 * Identity is RELAXED (FR-8): drop `worktree_id` so a teammate's build from any
 * worktree matches; `ORDER BY created_at DESC LIMIT 1` takes the freshest.
 *
 * THE COMMIT-ORDERING DECISION (FR-10 / c-AC-6): "local newer" is gated on the
 * local build referring to the SAME commit as HEAD. The row we pull is always for
 * `local.headCommit`. If the local snapshot was built for a DIFFERENT commit than
 * HEAD — i.e. an OLDER commit is now checked out, or HEAD moved — the local
 * snapshot is for a different commit and is NOT authoritative for HEAD, so we
 * PULL. Only when the local snapshot is for the SAME commit as HEAD do we treat
 * the local copy as already-current and report `local-newer` (skip the fetch).
 * This means checking out an older commit pulls rather than wrongly claiming the
 * local copy is newer.
 *
 * REVALIDATION (FR-9 / c-AC-2): before returning, deserialize `snapshot_jsonb`,
 * validate its shape, and RECOMPUTE the stable-field hash via
 * {@link computeSnapshotSha256}. If it does not match the claimed
 * `snapshot_sha256`, REFUSE the payload (no corrupt row poisons the cache).
 */
export async function pullSnapshot(
	identity: SnapshotIdentity,
	ctx: PushPullContext,
	local: PullLocalContext,
): Promise<PullOutcome> {
	const logger = ctx.logger ?? defaultLogger;

	// COMMIT-ORDERING GATE (FR-10 / c-AC-6): only skip when the local snapshot is
	// for the SAME commit as HEAD. A local snapshot for a different commit (older
	// commit checked out, or none) → fall through to PULL.
	if (local.localCommit !== undefined && local.localCommit === local.headCommit) {
		return { kind: "local-newer" };
	}

	const target = codebaseTarget(ctx);
	const row = await selectFreshestForHead(ctx, target, identity);
	if (row.kind === "error") {
		logger.warn("pull-select-failed", { message: row.message });
		return { kind: "failed", message: row.message };
	}
	if (row.kind === "absent") return { kind: "not-found" };

	// REVALIDATION (FR-9 / c-AC-2): parse + shape-check + recompute the hash.
	const parsed = parseSnapshotJsonb(row.snapshotJsonb);
	if (parsed === null) {
		logger.warn("pull-malformed", { repo: identity.repo, commit: identity.commit });
		return { kind: "refused", reason: "malformed-payload" };
	}

	const recomputed = computeSnapshotSha256(parsed);
	if (recomputed !== row.claimedSha256) {
		// A corrupt / tampered / drifted payload: the recomputed stable-field hash
		// does not match the claimed one. REFUSE — never write it to the local cache.
		logger.warn("pull-hash-mismatch", {
			repo: identity.repo,
			commit: identity.commit,
			claimed: row.claimedSha256,
			recomputed,
		});
		return { kind: "refused", reason: "hash-mismatch", detail: recomputed };
	}

	return { kind: "pulled", snapshot: parsed, sha256: recomputed };
}

// ── Pull internals ────────────────────────────────────────────────────────────

/** The outcome of the freshest-for-HEAD SELECT. */
type FreshestSelect =
	| { readonly kind: "error"; readonly message: string }
	| { readonly kind: "present"; readonly snapshotJsonb: unknown; readonly claimedSha256: string }
	| { readonly kind: "absent" };

/**
 * SELECT the freshest snapshot for the current HEAD across any worktree (FR-8).
 * Poll-convergent on the live backend: keep the row with the lexicographically
 * greatest `created_at` observed across polls (a single read can miss a fresh row
 * but never invents one). Relaxed identity drops `worktree_id`.
 */
async function selectFreshestForHead(
	ctx: PushPullContext,
	target: HealTarget,
	identity: SnapshotIdentity,
): Promise<FreshestSelect> {
	const tbl = sqlIdent(target.table);
	const shaCol = sqlIdent("snapshot_sha256");
	const jsonbCol = sqlIdent("snapshot_jsonb");
	const tsCol = sqlIdent("created_at");
	const sql =
		`SELECT ${shaCol}, ${jsonbCol}, ${tsCol} FROM "${tbl}" ` +
		`WHERE ${pullWhere(identity)} ORDER BY ${tsCol} DESC LIMIT 1`;

	const polls = ctx.verifyPolls ?? PUSH_VERIFY_POLLS;
	let best: { snapshotJsonb: unknown; claimedSha256: string; createdAt: string } | null = null;
	for (let poll = 0; poll < polls; poll++) {
		const res = await runHealed(ctx, target, sql);
		if (!isOk(res)) return { kind: "error", message: errMessage(res) };
		if (res.rows.length === 0) continue;
		const r = res.rows[0] as StorageRow;
		const createdAt = typeof r.created_at === "string" ? r.created_at : String(r.created_at ?? "");
		if (best === null || createdAt >= best.createdAt) {
			best = {
				snapshotJsonb: r.snapshot_jsonb,
				claimedSha256: typeof r.snapshot_sha256 === "string" ? r.snapshot_sha256 : String(r.snapshot_sha256 ?? ""),
				createdAt,
			};
		}
	}
	if (best === null) return { kind: "absent" };
	return { kind: "present", snapshotJsonb: best.snapshotJsonb, claimedSha256: best.claimedSha256 };
}

/**
 * Parse + shape-validate the stored `snapshot_jsonb` into a {@link Snapshot}
 * (FR-9). Returns null on any shape failure so the caller refuses the payload —
 * a malformed row is treated exactly like a hash mismatch (no poisoned cache).
 * The backend may hand back the jsonb as an already-parsed object OR a JSON
 * string; both are handled.
 */
export function parseSnapshotJsonb(raw: unknown): Snapshot | null {
	let value: unknown = raw;
	if (typeof raw === "string") {
		try {
			value = JSON.parse(raw);
		} catch {
			return null;
		}
	}
	if (!isSnapshotShape(value)) return null;
	return value;
}

/** Structural guard for the {@link Snapshot} shape the hash needs (FR-9). */
function isSnapshotShape(value: unknown): value is Snapshot {
	if (value === null || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		v.directed === true &&
		v.multigraph === true &&
		typeof v.graph === "object" &&
		v.graph !== null &&
		Array.isArray(v.nodes) &&
		Array.isArray(v.links) &&
		typeof v.observation === "object" &&
		v.observation !== null
	);
}

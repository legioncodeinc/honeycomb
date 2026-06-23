/**
 * The standalone version-history COMPACTION trigger seam — PRD-030 (Wave 2a, D-2 PRIMARY).
 *
 * The PRIMARY maintenance path: a daemon route that runs the Wave-1 version-history
 * compactor (`storage/compaction.ts`) over the version-bumped tables under the daemon's
 * scope. It is the AC-bearing standalone job (D-2) — NOT gated behind premium pollinating. The
 * `honeycomb maintenance compact` CLI verb POSTs here; the dashboard could call it too.
 *
 * This module is the single named step the daemon assembly calls AFTER `createDaemon(...)`
 * to attach `POST /api/diagnostics/compact` onto the ALREADY-MOUNTED, protected
 * `/api/diagnostics` group — mirroring {@link mountPollinateApi} (PRD-024). ZERO edits to
 * `server.ts`: the `/api/diagnostics` group is scaffolded + `protect:true`, so attaching via
 * `daemon.group("/api/diagnostics")` inherits the same auth/RBAC the JSON dashboard views
 * enforce (open in `local` mode by design — the single-user loopback dogfood target).
 *
 * ── It is the HTTP TRIGGER, never new compaction logic (the dispatcher thesis) ──
 *   The handler holds NO reaping logic + issues NO direct SQL. It calls the Wave-1
 *   {@link compactVersionHistory} (which OWNS the guarded SQL, the poll-convergent survivor
 *   resolve, and the idempotent/crash-safe reap), once per allow-listed table that EXISTS.
 *   The route is the wiring; the compactor is the work.
 *
 * ── Probe-before-reap so a missing table is SKIPPED, not a 500 (PRD-028 posture) ──
 *   Before compacting a table the handler probes existence via the heal {@link tableExists}
 *   (an `information_schema` catalog read that never provokes a `42P01`). A not-yet-created
 *   table is SKIPPED (no row touched, no error); a transient probe failure (`null`) FAILS
 *   OPEN — the compactor's own poll-convergent reads + fail-closed scope guard are the floor.
 *
 * ── Per-table key column + columns (how each table is addressed) ─────────────
 *   Each version-bumped table reaps history per its LOGICAL key column — `key` for `rules`,
 *   `claim_key` for `entity_attributes`, and `id` for `skills`/`epistemic_assertions`/
 *   `pollinating_state`. {@link COMPACTABLE_KEY_COLUMNS} maps it explicitly (the catalog carries
 *   no `keyColumn` field, and each entry is pinned to the column its REAL writer keys the
 *   version chain by — see the per-entry writer citations there), defaulting to `id`. The
 *   table's ColumnDef array (the
 *   {@link HealTarget}) comes from the catalog via {@link healTargetFor} — single-sourced,
 *   never re-stated here.
 *
 * ── The summary shape (the contract the CLI renders) ─────────────────────────
 *   On success the handler returns HTTP 200 with a JSON summary:
 *     `{ ok: true, summaries: CompactionSummary[] }`
 *   one {@link CompactionSummary} per table that EXISTED and was compacted (incl.
 *   `keysSkipped`, the transient-flap signal). A table that did not exist is omitted. The
 *   summary carries NO token/secret/header value — only table names, counts, and version
 *   numbers (the same no-secret floor as the pollinate ack).
 *
 * ── Fail-soft, never 500 (the maintenance posture) ───────────────────────────
 *   A per-table compaction error (a flappy DELETE, a transient read) is caught and folded
 *   into an `errored` count on that table's summary — one table failing never aborts the
 *   pass or 500s the request. A request with no resolvable tenancy fails closed at the edge
 *   (400), consistent with the pollinate handler. The whole route is best-effort: the worst case
 *   is "nothing reaped this pass", never a crash.
 *
 * ── Deferred assembly (mirrors mountPollinateApi) ────────────────────────────────
 *   `assemble.ts` calls `mountCompactApi(daemon, { storage, defaultScope })` ONCE next to
 *   the `mountPollinate(...)` call. It is constructed-and-tested here against a fake compactor
 *   seam; importing the daemon does not auto-invoke it.
 */

import type { Context } from "hono";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { compactVersionHistory, COMPACTABLE_VERSION_BUMPED_TABLES, resolveCompactionConfig, type CompactionRetention, type CompactionSummary } from "../../storage/compaction.js";
import { healTargetFor } from "../../storage/catalog/index.js";
import { tableExists, type HealTarget } from "../../storage/heal.js";
import type { Daemon } from "../server.js";

/** The route the compaction trigger is served at (full path `/api/diagnostics/compact`). */
export const COMPACT_TRIGGER_PATH = "/compact" as const;

/** The already-mounted, protected route group the trigger attaches to (no `server.ts` edit). */
export const COMPACT_TRIGGER_GROUP = "/api/diagnostics" as const;

/**
 * The logical KEY COLUMN each compactable version-bumped table reaps history by — the
 * column whose value is SHARED across a version chain and on which the writer resolves
 * "current state" via `ORDER BY version DESC LIMIT 1`. The catalog carries no `keyColumn`
 * field, so this maps it explicitly (a documented, greppable map), and EACH entry is
 * pinned to the column the table's REAL writer/reader keys its version chain by:
 *   - `skills`               → `id`         (`skills-write.ts` resolves the current skill
 *                                            per `id`; there is NO `key` column on skills).
 *   - `rules`                → `key`        (the rule's logical key; `rules` has a `key` col).
 *   - `entity_attributes`    → `claim_key`  (the claim version chain is keyed by `claim_key`;
 *                                            `id` is UNIQUE PER VERSION — keying by `id`
 *                                            would make every row a singleton chain — see
 *                                            `ontology/supersede.ts` `buildHighestActiveVersionSql`).
 *   - `epistemic_assertions` → `id`         (the assertion version chain is keyed by `id` —
 *                                            `control-plane.ts` `recordAssertion` calls
 *                                            `appendVersionBumped({ keyColumn: "id", … })`. The
 *                                            `claim_key` column is an OPTIONAL cross-link
 *                                            (`assertion.claimKey ?? ""`); NO reader resolves
 *                                            the current assertion on `claim_key`, so keying
 *                                            compaction by it would collapse every empty-cross-link
 *                                            assertion into one bogus `claim_key=""` chain).
 *   - `pollinating_state`       → `id`         (the deterministic per-scope counter key; the
 *                                            version chain genuinely shares `id` —
 *                                            `pollinating/trigger.ts` `appendVersionBumped({ keyColumn: "id", … })`).
 * A WRONG key column here is a SAFETY bug, not just a no-op: keying by a per-version-unique
 * column makes "highest version per key" resolve to a singleton (compaction silently does
 * nothing), and keying by a column shared across DISTINCT logical entities could resolve a
 * cross-entity "highest" — so each entry above is verified against the table's writer.
 * Any allow-listed table NOT named here defaults to `id` (the conservative norm) — see
 * {@link keyColumnFor}.
 */
export const COMPACTABLE_KEY_COLUMNS: Readonly<Record<string, string>> = Object.freeze({
	skills: "id",
	rules: "key",
	entity_attributes: "claim_key",
	epistemic_assertions: "id",
	pollinating_state: "id",
});

/** Resolve a table's logical key column (defaulting to `id`). */
export function keyColumnFor(table: string): string {
	return COMPACTABLE_KEY_COLUMNS[table] ?? "id";
}

/**
 * The minimal compactor seam the handler calls — exactly the Wave-1
 * {@link compactVersionHistory} signature. Keeping it a one-method interface lets production
 * inject the REAL compactor and a unit test inject a fake that records the call + scripts the
 * summary, without the handler holding any reaping knowledge.
 */
export interface CompactSeam {
	/** Compact one version-bumped table's history under a scope; return its summary. */
	compact(
		client: StorageQuery,
		target: HealTarget,
		scope: QueryScope,
		opts: { keyColumn: string; retention: CompactionRetention },
	): Promise<CompactionSummary>;
}

/** The production compactor seam: the Wave-1 reaper, unwrapped. */
const realCompactSeam: CompactSeam = {
	compact: (client, target, scope, opts) => compactVersionHistory(client, target, scope, opts),
};

/** Options for {@link mountCompactApi}. */
export interface MountCompactOptions {
	/**
	 * The live storage client the compactor reads/reaps through (never a raw fetch). The
	 * compactor builds every statement with the guarded `sql.ts` helpers.
	 */
	readonly storage: StorageQuery;
	/**
	 * The daemon's own tenancy partition the version-bumped rows live under (the same
	 * `defaultScope` the composition root threads into the data-API + pollinate mounts). In `local`
	 * mode this is the single loopback tenant.
	 */
	readonly defaultScope: QueryScope;
	/**
	 * The resolved retention policy (D-1). Defaults to {@link resolveCompactionConfig} at mount
	 * (env-resolved, conservative N=5 + 30d). A test injects a fixed policy.
	 */
	readonly retention?: CompactionRetention;
	/**
	 * The compactor seam override (tests inject a recording fake). Production leaves it unset →
	 * the REAL {@link compactVersionHistory}.
	 */
	readonly compactor?: CompactSeam;
	/**
	 * The table-existence probe seam (defaults to the heal {@link tableExists}). A test injects a
	 * fake so it can script "table missing" without a live catalog.
	 */
	readonly exists?: (client: StorageQuery, table: string, scope: QueryScope) => Promise<boolean | null>;
}

/** One table's compaction body field carried in the response (the per-table summary + an error count). */
export interface CompactTableResult extends CompactionSummary {
	/** Per-table errors swallowed during this pass (fail-soft); 0 on a clean pass. */
	readonly errored: number;
}

/** The summary body the trigger returns (the exact contract the `maintenance compact` verb reads). */
export interface CompactSummaryBody {
	/** True when the pass ran to completion (even a partial reap is `ok`). */
	readonly ok: boolean;
	/** One entry per allow-listed table that EXISTED and was compacted; missing tables omitted. */
	readonly summaries: readonly CompactTableResult[];
	/** Allow-listed tables SKIPPED because they did not exist (probe said absent). */
	readonly skippedTables: readonly string[];
}

/** The 400 body for a request with no resolvable tenancy (fail-closed at the edge). */
const NO_ORG_BODY = { error: "bad_request", reason: "x-honeycomb-org header is required" } as const;

/**
 * Resolve the per-request tenancy scope, falling back to the daemon's `defaultScope` when the
 * request carries no `x-honeycomb-org` header (the local-mode posture). Returns `null` ONLY
 * when neither a header org NOR a default org is present — fail-closed. Mirrors
 * `mountPollinateApi`'s `resolveTriggerScope`.
 */
function resolveCompactScope(c: Context, defaultScope: QueryScope): QueryScope | null {
	const org = c.req.header("x-honeycomb-org");
	if (org !== undefined && org.length > 0) {
		const workspace = c.req.header("x-honeycomb-workspace");
		return workspace !== undefined && workspace.length > 0 ? { org, workspace } : { org };
	}
	return defaultScope.org.length > 0 ? defaultScope : null;
}

/**
 * The set of tables a single request may compact: every allow-listed version-bumped table by
 * default, or — when the body carries a `{ table: "<name>" }` selector — just that one table
 * IF it is in the allow-list (an unknown / non-compactable name yields the empty set, so the
 * fail-closed compactor guard is never even reached). The selector lets
 * `honeycomb maintenance compact --table skills` target one table.
 */
function selectTables(body: unknown): string[] {
	const all = Array.from(COMPACTABLE_VERSION_BUMPED_TABLES);
	if (typeof body !== "object" || body === null) return all;
	const sel = (body as { table?: unknown }).table;
	if (typeof sel !== "string" || sel === "") return all;
	return COMPACTABLE_VERSION_BUMPED_TABLES.has(sel) ? [sel] : [];
}

/**
 * Compact ONE table fail-soft: probe existence (skip when absent), then run the compactor.
 * Returns the per-table result, or `null` when the table did not exist (probe said absent).
 * A compaction error is caught and folded into `errored` (never thrown past the seam).
 */
async function compactOneTable(
	table: string,
	options: MountCompactOptions,
	scope: QueryScope,
	retention: CompactionRetention,
	compactor: CompactSeam,
	probe: NonNullable<MountCompactOptions["exists"]>,
): Promise<CompactTableResult | null> {
	// Probe existence FIRST (PRD-028 posture): a not-yet-created table is SKIPPED, never a 500.
	// `null` (transient probe failure) FAILS OPEN — proceed; the compactor's reads are the floor.
	const present = await probe(options.storage, table, scope);
	if (present === false) return null;

	const target = healTargetFor(table);
	const keyColumn = keyColumnFor(table);
	try {
		const summary = await compactor.compact(options.storage, target, scope, { keyColumn, retention });
		return { ...summary, errored: 0 };
	} catch {
		// Fail-soft: one table erroring never aborts the pass. Report a zero-reap summary with a
		// non-zero error count so the operator sees the table was attempted but did not complete.
		return { table, keysScanned: 0, keysCompacted: 0, rowsReaped: 0, keysSkipped: 0, errored: 1 };
	}
}

/**
 * Attach the version-history compaction trigger onto the daemon's already-mounted, protected
 * `/api/diagnostics` group (D-2 PRIMARY). Registers `POST /api/diagnostics/compact`, which
 * resolves the request scope (header org or the daemon default — fail-closed), runs the
 * Wave-1 compactor over each allow-listed version-bumped table that EXISTS, and returns the
 * 200 summary. Call ONCE after `createDaemon(...)`. If the group is not mounted (unknown
 * daemon shape) the attach is a no-op. Bounded but a normal request (compaction is bounded by
 * the allow-list + the per-key poll budget).
 */
export function mountCompactApi(daemon: Daemon, options: MountCompactOptions): void {
	const group = daemon.group(COMPACT_TRIGGER_GROUP);
	if (group === undefined) return;

	const compactor = options.compactor ?? realCompactSeam;
	const probe = options.exists ?? tableExists;
	// Resolve the retention ONCE at mount (env-resolved, conservative defaults). A malformed
	// `HONEYCOMB_COMPACTION_*` knob would throw a `CompactionConfigError` here; the assembly
	// fires this inside a fail-soft try/catch, so a bad knob never crashes the daemon.
	const retention = options.retention ?? resolveCompactionConfig();

	group.post(COMPACT_TRIGGER_PATH, async (c) => {
		const scope = resolveCompactScope(c, options.defaultScope);
		if (scope === null) return c.json(NO_ORG_BODY, 400);

		const body = await readBody(c);
		const tables = selectTables(body);

		const summaries: CompactTableResult[] = [];
		const skippedTables: string[] = [];
		for (const table of tables) {
			const result = await compactOneTable(table, options, scope, retention, compactor, probe);
			if (result === null) skippedTables.push(table);
			else summaries.push(result);
		}

		const out: CompactSummaryBody = { ok: true, summaries, skippedTables };
		return c.json(out, 200);
	});
}

/** Read the JSON body defensively (an absent / unparseable body → `undefined`, the all-tables default). */
async function readBody(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		return undefined;
	}
}

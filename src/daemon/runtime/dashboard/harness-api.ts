/**
 * The harness registry + last-seen telemetry endpoint — PRD-039a (the data backbone).
 *
 * `mountHarnessApi` is the single named seam the daemon assembly calls after `createDaemon(...)` to
 * attach `GET /api/diagnostics/harnesses` onto the already-mounted, protected `/api/diagnostics`
 * group — mirroring {@link import("./api.js").mountDashboardApi} EXACTLY (parent OQ-1 / a-AC-4):
 * ZERO `server.ts` edits, inherits the group's auth/RBAC + the fail-closed `resolveScope`.
 *
 * It is the SINGLE source of truth (parent D-3) that BOTH the Harnesses page (039b/039c) and
 * PRD-038's home harness strip read — neither re-queries `sessions` for harness telemetry directly.
 * For ALL SIX canonical harnesses every call (parent AC-1) it reports:
 *   - `installed`     — wired: hooks/identity (harness-sync) targets present (a-AC-3), a cheap cached
 *                       presence check injected at assembly (OQ-1), never a per-request spawn.
 *   - `active`        — has >= 1 captured turn (`turnsCaptured > 0`), included explicitly so consumers
 *                       do not re-derive it inconsistently (a-AC-4).
 *   - `lastSeen`      — ISO of the most recent captured turn (`MAX(creation_date)`), null when none.
 *   - `turnsCaptured` — `COUNT(*)` of `sessions` rows for this `agent`, 0 when none.
 *   - `runtimePath`   — the shim-declared static (`legacy` | `plugin`), carried so 039c renders it.
 *   - `capabilities`  — the data-driven {@link HarnessCapabilities} descriptor, folded server-side
 *                       (c-OQ-2) so the detail page reflects live shim state without re-importing shims.
 *
 * ── Activity is ONE guarded query (a-AC-2 / a-AC-5) ──────────────────────────────────
 *   A single SELECT `agent, COUNT(*) AS n, MAX(creation_date) AS last FROM "sessions" GROUP BY agent`
 *   — built only with `sqlIdent` (no interpolated value), scope-passed to `storage.query`, fail-soft
 *   to `[]` on any non-ok result (the `selectRows` pattern from `dashboard/api.ts`). The rows are
 *   mapped onto the canonical six; a harness absent from the result reports `0` / `null` / `false`.
 *   So the endpoint NEVER 500s and NEVER fabricates a metric — zeroed activity, never a placeholder.
 *
 * ── No secret in the response (parent AC-8) ──────────────────────────────────────────
 *   The response carries only canonical harness ids, booleans, a count, an ISO timestamp, the static
 *   runtime path, and the shim-static capability descriptor. No token, org GUID, header, or body ever
 *   rides it — by construction (there is no field that could carry one).
 */

import type { Context } from "hono";

import { sqlIdent } from "../../storage/sql.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { resolveScopeOrLocalDefault } from "../scope.js";
import type { Daemon } from "../server.js";
import {
	CANONICAL_SHIMS,
	capabilitiesFor,
	type HarnessCapabilities,
} from "./harness-registry.js";

/** The route group the harness telemetry endpoint attaches to (already mounted + protected). */
export const HARNESS_GROUP = "/api/diagnostics" as const;

/** The path the telemetry endpoint serves at (full: `/api/diagnostics/harnesses`). */
export const HARNESS_PATH = "/harnesses" as const;

/**
 * One harness's status (the stable 039a data shape, parent "Data shape"). Returned for ALL SIX
 * canonical harnesses every call — an idle/uninstalled harness is PRESENT with zeroed activity, not
 * absent. `capabilities` folds the 039c descriptor in server-side (c-OQ-2).
 */
export interface HarnessStatus {
	/** Canonical harness id: `claude-code` | `codex` | `cursor` | `hermes` | `pi` | `openclaw`. */
	readonly name: string;
	/** Wired: hooks + identity (harness-sync) targets present (a-AC-3), independent of activity. */
	readonly installed: boolean;
	/** Has >= 1 captured turn (`turnsCaptured > 0`) — derived, included explicitly (a-AC-4). */
	readonly active: boolean;
	/** ISO-8601 of the most recent captured turn (`MAX(creation_date)`); null when none. */
	readonly lastSeen: string | null;
	/** `COUNT(*)` of `sessions` rows for this `agent`; 0 when none. */
	readonly turnsCaptured: number;
	/** The shim-declared static runtime path (`legacy` | `plugin`), descriptive + harness-static. */
	readonly runtimePath: string;
	/** The data-driven capability descriptor (039c), folded server-side (c-OQ-2). */
	readonly capabilities: HarnessCapabilities;
}

/** The JSON envelope `GET /api/diagnostics/harnesses` returns: the six statuses. */
export interface HarnessStatusResponse {
	/** The six canonical harness statuses (fixed length; idle harnesses present, zeroed). */
	readonly harnesses: readonly HarnessStatus[];
}

/** Options for {@link mountHarnessApi}. */
export interface MountHarnessOptions {
	/** The storage client the activity GROUP BY runs through (never a raw fetch). */
	readonly storage: StorageQuery;
	/**
	 * The daemon's configured default tenancy scope, threaded from the composition root. In LOCAL
	 * mode a request with no `x-honeycomb-org` header falls back to this single configured tenant
	 * (the dashboard web app is a loopback thin client). ABSENT (a unit-constructed daemon) → pure
	 * header-only resolution. NEVER consulted outside local mode. Mirrors
	 * {@link import("./api.js").MountDashboardOptions.defaultScope}.
	 */
	readonly defaultScope?: QueryScope;
	/**
	 * The set of canonical harness ids the daemon knows to be INSTALLED/wired (a-AC-3 / OQ-1) — a
	 * CHEAP, cached presence set resolved at assembly from the harness-sync `HarnessTarget` set, NOT a
	 * per-request file walk or spawn. ABSENT (a unit-constructed daemon / no targets) → every harness
	 * reads `installed: false`, so the endpoint still returns all six with activity intact (the honest
	 * "wired nothing yet" picture). A test injects a fixed set to drive the installed/uninstalled mix.
	 */
	readonly installedHarnesses?: ReadonlySet<string>;
}

/** Number coercion that never returns NaN/undefined for a count column. */
function toCount(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value ?? 0);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** ISO-string coercion for the `MAX(creation_date)` column; null for an empty/absent value. */
function toLastSeen(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	const s = String(value);
	return s.length > 0 ? s : null;
}

/** Run the activity SELECT through storage, returning rows or `[]` on any non-ok result (fail-soft). */
async function selectRows(storage: StorageQuery, sql: string, scope: QueryScope): Promise<StorageRow[]> {
	const result = await storage.query(sql, scope);
	return isOk(result) ? result.rows : [];
}

/**
 * Build the per-harness activity aggregate (a-AC-2): ONE guarded SELECT grouping `sessions` by the
 * `agent` column (= harness identity, parent D-1). Identifiers go through `sqlIdent` (the PRD-002b
 * floor); NO value is interpolated, so there is no injection surface and `audit:sql` stays green by
 * construction. A single GROUP BY (no N+1, no per-harness round-trip).
 */
export function buildHarnessActivitySql(): string {
	const tbl = sqlIdent("sessions");
	const agent = sqlIdent("agent");
	const created = sqlIdent("creation_date");
	return `SELECT ${agent}, COUNT(*) AS n, MAX(${created}) AS last FROM "${tbl}" GROUP BY ${agent}`;
}

/**
 * Map the (possibly partial) activity rows onto the canonical six (parent AC-1). A harness present in
 * the result carries its real `COUNT`/`MAX`; one absent reports `turnsCaptured: 0`, `lastSeen: null`,
 * `active: false`. `installed` comes from the injected presence set; `capabilities` is folded from the
 * shim-derived descriptor (c-OQ-2). The order is the canonical shim order (stable).
 */
export function buildHarnessStatuses(
	rows: readonly StorageRow[],
	installed: ReadonlySet<string>,
): HarnessStatus[] {
	// Index the activity rows by agent id for an O(1) per-harness lookup (the result may omit harnesses).
	const byAgent = new Map<string, { turns: number; last: string | null }>();
	for (const r of rows) {
		const agent = r.agent === undefined || r.agent === null ? "" : String(r.agent);
		if (agent === "") continue;
		byAgent.set(agent, { turns: toCount(r.n), last: toLastSeen(r.last) });
	}

	return CANONICAL_SHIMS.map((shim): HarnessStatus => {
		const name = shim.harness;
		const activity = byAgent.get(name);
		const turnsCaptured = activity?.turns ?? 0;
		// `capabilitiesFor(name)` is always defined for a canonical shim; the descriptor is the single
		// source folded server-side. The `runtimePath` mirrors the shim static (descriptive, harness-static).
		const capabilities = capabilitiesFor(name) as HarnessCapabilities;
		return {
			name,
			installed: installed.has(name),
			active: turnsCaptured > 0,
			lastSeen: activity?.last ?? null,
			turnsCaptured,
			runtimePath: shim.runtimePath,
			capabilities,
		};
	});
}

/** The 400 body the handler returns when the request carries no resolvable org (fail-closed). */
const NO_ORG_BODY = { error: "bad_request", reason: "x-honeycomb-org header is required" } as const;

/**
 * Attach the harness telemetry handler onto the daemon's already-mounted `/api/diagnostics` group
 * (a-AC-4 / parent D-7). Registers `GET /harnesses`, which reads the single guarded activity GROUP BY
 * through `options.storage` (fail-soft), folds in the injected installed set + the shim-derived
 * capability descriptors, and returns all six {@link HarnessStatus}es. Call ONCE after
 * `createDaemon(...)`. A request with no resolvable tenancy 400s (fail-closed, mirroring
 * `mountDashboardApi`). If the group is not mounted (unknown daemon shape) the attach is a no-op.
 */
export function mountHarnessApi(daemon: Daemon, options: MountHarnessOptions): void {
	const group = daemon.group(HARNESS_GROUP);
	if (group === undefined) return;

	const storage = options.storage;
	const installed = options.installedHarnesses ?? new Set<string>();
	// Scope precedence (PRD-022): header → (local-mode) injected default → null/400. Header ALWAYS
	// wins; the fallback fires ONLY in local mode with a `defaultScope` (mirrors mountDashboardApi).
	const resolveScope = (c: Context): QueryScope | null =>
		resolveScopeOrLocalDefault(c, daemon.config.mode, options.defaultScope);

	group.get(HARNESS_PATH, async (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		// ONE guarded GROUP BY; fail-soft to [] so the endpoint still returns all six with zeroed
		// activity (never a 500). The canonical six are enumerated from the shim set, NOT discovered
		// from the result, so an idle harness still appears.
		const rows = await selectRows(storage, buildHarnessActivitySql(), scope);
		const body: HarnessStatusResponse = { harnesses: buildHarnessStatuses(rows, installed) };
		return c.json(body);
	});
}

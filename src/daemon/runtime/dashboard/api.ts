/**
 * The dashboard data API attach seam — PRD-020b (daemon side, storage-correct).
 *
 * The 020b dashboard is a THIN CLIENT: it reads its six view-models through the daemon's
 * dashboard endpoints, never opening DeepLake. This module is the daemon-side counterpart —
 * the single named step the daemon assembly calls AFTER `createDaemon(...)` to attach the
 * dashboard data handlers onto the already-mounted route groups, mirroring
 * `attachHooksHandlers` (019b). ZERO edits to `server.ts`: the route groups
 * (`/api/diagnostics`, `/api/graph`) are already scaffolded + protected, so attaching via
 * `daemon.group(path)` inherits auth/RBAC with no re-wiring. The kpis/rules/skills VIEW-MODELS
 * are served UNDER the diagnostics group (`/api/diagnostics/{kpis,rules,skills}`), NOT on the
 * canonical `/api/kpis|rules|skills` resource paths — those belong to the PRD-022 product-data
 * data-access API (the rows the CLI/SDK/MCP read), and a same-named dashboard view-model yields.
 *
 * It is storage-correct (lives under `src/daemon/`): handlers reach storage ONLY through the
 * injected {@link StorageQuery}, building guarded SQL with the pure `sql.ts` helpers
 * (`sqlIdent` / `sLiteral`). No handler opens a raw connection, and every interpolated value
 * goes through a guard.
 *
 * Each handler returns the matching 020b view-model shape (`KpisView`, `SessionsView`,
 * `SettingsView`, `GraphView`, `RulesView`, `SkillSyncView`) — the SAME contract the
 * `src/dashboard` thin client renders, so the dashboard reads exactly what it draws.
 *
 * ── a-AC-6 empty-state ───────────────────────────────────────────────────────
 *   `GET /api/graph` returns `{ built: false, nodes: [], edges: [] }` when no codebase
 *   snapshot exists for the workspace; the 020b `buildGraphView` renders the
 *   `honeycomb graph build` prompt from the flag (NOT an error).
 *
 * ── Deferred assembly (D-7) ──────────────────────────────────────────────────
 *   The production daemon assembly that owns the live storage client calls `mountDashboardApi`
 *   once. It is constructed-and-tested here against a fake `StorageQuery` (the 020b daemon-side
 *   suite drives `app.request(...)`); nothing auto-invokes it by importing the daemon.
 */

import type { Context } from "hono";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { resolveScopeOrLocalDefault } from "../scope.js";
import type {
	GraphView,
	KpisView,
	RulesView,
	SessionsView,
	SettingsView,
	SkillSyncView,
} from "../../../dashboard/contracts.js";
import type { Daemon } from "../server.js";

/** Options for {@link mountDashboardApi}. */
export interface MountDashboardOptions {
	/** The storage client the view reads run through (never a raw fetch). */
	readonly storage: StorageQuery;
	/**
	 * The daemon's configured default tenancy scope, threaded from the composition root
	 * (PRD-022). In LOCAL mode a dashboard request with no `x-honeycomb-org` header falls back
	 * to this single configured tenant (the dashboard web app is a loopback thin client — like
	 * the SDK/MCP — and need not know the org GUID). ABSENT (a unit-constructed daemon) → pure
	 * header-only resolution (the prior fail-closed behaviour). NEVER consulted outside local mode.
	 *
	 * Mirrors {@link import("../memories/api.js").MountMemoriesOptions.defaultScope}.
	 */
	readonly defaultScope?: QueryScope;
}

/**
 * The runtime config the settings view exposes (mode + port). The host route (d-AC-3) and
 * the `/api/diagnostics/settings` handler both build the {@link SettingsView} from this +
 * the per-request scope, so the daemon-served HTML page and the JSON endpoint agree.
 */
export interface DashboardSettingsConfig {
	/** The deployment mode (`local` | `team` | `hybrid`). */
	readonly mode: string;
	/** The daemon listen port. */
	readonly port: number;
}

/**
 * The dashboard route groups the data API attaches to (already mounted in `server.ts`).
 * Each handler attaches via `daemon.group(<group>)` and returns the matching 020b
 * view-model. Keeping the list here documents exactly which already-scaffolded groups the
 * dashboard fills — no new group, no `server.ts` edit.
 */
export const DASHBOARD_GROUPS = Object.freeze({
	/**
	 * KPIs view-model (FR-2) — served off the diagnostics group at `/kpis` (full path
	 * `/api/diagnostics/kpis`). The canonical `/api/kpis` resource path is owned by the PRD-022
	 * product-data data-access API (the rows the CLI/SDK/MCP read); this dashboard VIEW-MODEL is a
	 * presentation concern and yields to it, namespaced under diagnostics alongside sessions/settings.
	 */
	kpis: "/api/diagnostics",
	/**
	 * Sessions view-model (FR-3) — served off the diagnostics group at `/sessions` (full path
	 * `/api/diagnostics/sessions`). There is NO standalone `/api/sessions` route group mounted in
	 * `server.ts`, and this seam never edits `server.ts`; the diagnostics group is mounted +
	 * protected, so the sessions read attaches there with no bootstrap change.
	 */
	sessions: "/api/diagnostics",
	/** Settings view-model (FR-4) — served off the diagnostics group at `/settings`. */
	settings: "/api/diagnostics",
	/** Graph view-model (FR-5 / a-AC-6 empty-state). Product-data does NOT claim `/api/graph`, so this stays. */
	graph: "/api/graph",
	/**
	 * Rules view-model (FR-6 / a-AC-4) — served off the diagnostics group at `/rules` (full path
	 * `/api/diagnostics/rules`). The canonical `/api/rules` resource path is owned by the PRD-022
	 * product-data data-access API; this dashboard VIEW-MODEL yields to it, under diagnostics.
	 */
	rules: "/api/diagnostics",
	/**
	 * Skill-sync view-model (FR-6) — served off the diagnostics group at `/skills` (full path
	 * `/api/diagnostics/skills`). The canonical `/api/skills` resource path is owned by the PRD-022
	 * product-data data-access API; this dashboard VIEW-MODEL yields to it, under diagnostics.
	 */
	skills: "/api/diagnostics",
} as const);

/** Number coercion that never returns NaN/undefined for a count column. */
function toNum(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value ?? 0);
	return Number.isFinite(n) ? n : 0;
}

/** String coercion that never returns undefined for a text column. */
function toStr(value: unknown): string {
	return value === undefined || value === null ? "" : String(value);
}

/** Run a SELECT through the storage seam, returning rows or `[]` on any non-ok result (fail-soft). */
async function selectRows(storage: StorageQuery, sql: string, scope: QueryScope): Promise<StorageRow[]> {
	const result = await storage.query(sql, scope);
	return isOk(result) ? result.rows : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// View fetchers — the SINGLE source of each view's storage read (jscpd discipline).
// Both the HTTP handlers (`mountDashboardApi`) and the daemon-served host route
// (`host.ts` / d-AC-3) call these, so the HTML page and the JSON endpoints read
// EXACTLY the same rows with the same guarded SQL. Each returns the 020b view-model.
// ─────────────────────────────────────────────────────────────────────────────

/** Fetch the KPIs view (FR-1 / d-AC-1): memory + session counts; savings is a real metric (0 until its pipeline lands). */
export async function fetchKpisView(storage: StorageQuery, scope: QueryScope): Promise<KpisView> {
	const memTbl = sqlIdent("memory");
	const sessTbl = sqlIdent("sessions");
	const [memRows, sessRows] = await Promise.all([
		selectRows(storage, `SELECT COUNT(*) AS n FROM "${memTbl}"`, scope),
		selectRows(storage, `SELECT COUNT(*) AS n FROM "${sessTbl}"`, scope),
	]);
	return {
		memoryCount: toNum(memRows[0]?.n),
		sessionCount: toNum(sessRows[0]?.n),
		estimatedSavings: 0,
	};
}

/** Fetch the sessions view (FR-1 / d-AC-1): captured sessions + project/date metadata, newest first. */
export async function fetchSessionsView(storage: StorageQuery, scope: QueryScope): Promise<SessionsView> {
	const tbl = sqlIdent("sessions");
	const rows = await selectRows(
		storage,
		`SELECT ${sqlIdent("id")}, ${sqlIdent("project")}, ${sqlIdent("creation_date")}, ${sqlIdent("path")} ` +
			`FROM "${tbl}" ORDER BY ${sqlIdent("creation_date")} DESC LIMIT 200`,
		scope,
	);
	const sessions = rows.map((r) => ({
		sessionId: toStr(r.id),
		project: toStr(r.project),
		startedAt: toStr(r.creation_date),
		eventCount: 0,
		status: "captured",
	}));
	return { sessions };
}

/** Build the settings view (FR-1 / d-AC-1): active org/workspace + the exposed runtime config. */
export function buildSettingsView(scope: QueryScope, config: DashboardSettingsConfig): SettingsView {
	return {
		orgId: scope.org,
		orgName: scope.org,
		workspace: scope.workspace ?? "default",
		settings: { mode: config.mode, port: String(config.port) },
	};
}

/** Fetch the graph view (FR-1 / d-AC-1 / d-AC-6): the latest codebase snapshot, or `built:false` empty-state. */
export async function fetchGraphView(storage: StorageQuery, scope: QueryScope): Promise<GraphView> {
	const tbl = sqlIdent("codebase");
	const rows = await selectRows(
		storage,
		`SELECT ${sqlIdent("snapshot_jsonb")}, ${sqlIdent("node_count")}, ${sqlIdent("edge_count")} ` +
			`FROM "${tbl}" WHERE ${sqlIdent("org_id")} = ${sLiteral(scope.org)} ` +
			`ORDER BY ${sqlIdent("schema_version")} DESC LIMIT 1`,
		scope,
	);
	if (rows.length === 0) return { built: false, nodes: [], edges: [] };
	const snapshot = parseSnapshot(rows[0]?.snapshot_jsonb);
	return { built: true, nodes: snapshot.nodes, edges: snapshot.edges };
}

/** Fetch the rules view (FR-1 / d-AC-1): the org-wide rules, active flag from `status`. */
export async function fetchRulesView(storage: StorageQuery, scope: QueryScope): Promise<RulesView> {
	const tbl = sqlIdent("rules");
	const rows = await selectRows(
		storage,
		`SELECT ${sqlIdent("id")}, ${sqlIdent("name")}, ${sqlIdent("status")} ` +
			`FROM "${tbl}" ORDER BY ${sqlIdent("version")} DESC LIMIT 500`,
		scope,
	);
	const rules = rows.map((r) => ({
		id: toStr(r.id),
		title: toStr(r.name),
		active: toStr(r.status) === "active",
	}));
	return { rules };
}

/** Fetch the skill-sync view (FR-1 / d-AC-1): pulled + shared team skills and their sync state. */
export async function fetchSkillSyncView(storage: StorageQuery, scope: QueryScope): Promise<SkillSyncView> {
	const tbl = sqlIdent("skills");
	const rows = await selectRows(
		storage,
		`SELECT ${sqlIdent("name")}, ${sqlIdent("scope")}, ${sqlIdent("visibility")} ` +
			`FROM "${tbl}" ORDER BY ${sqlIdent("version")} DESC LIMIT 500`,
		scope,
	);
	const skills = rows.map((r) => ({
		name: toStr(r.name),
		scope: toStr(r.scope),
		syncState: toStr(r.visibility) === "global" ? "shared" : "pulled",
	}));
	return { skills };
}

/** The 400 body a dashboard handler returns when the request carries no resolvable org (fail-closed). */
const NO_ORG_BODY = { error: "bad_request", reason: "x-honeycomb-org header is required" } as const;

/**
 * Attach the dashboard data handlers onto the daemon's already-mounted route groups (the
 * 020b daemon-side seam). Registers one read handler per view, each reading through
 * `options.storage` with guarded SQL (via the shared view fetchers) and returning the
 * matching 020b view-model. Call ONCE after `createDaemon(...)`. A request with no
 * resolvable tenancy 400s (fail-closed). If a group is not mounted (unknown daemon shape)
 * the attach for that view is skipped.
 */
export function mountDashboardApi(daemon: Daemon, options: MountDashboardOptions): void {
	const storage = options.storage;
	// Scope precedence (PRD-022): header → (local-mode) injected default → null/400. The
	// fallback fires ONLY in local mode with a `defaultScope`; team/hybrid stay fail-closed.
	// Header ALWAYS wins (the cross-tenant guard in scope.ts is unchanged). A unit-constructed
	// daemon (no injected default) keeps the prior pure header-only 400 behaviour.
	const resolveScope = (c: Context): QueryScope | null =>
		resolveScopeOrLocalDefault(c, daemon.config.mode, options.defaultScope);

	const kpis = daemon.group(DASHBOARD_GROUPS.kpis);
	if (kpis !== undefined) {
		// Served at `/kpis` under the diagnostics group (full `/api/diagnostics/kpis`) so the
		// canonical `/api/kpis` resource path is left to the PRD-022 product-data data-access API.
		kpis.get("/kpis", async (c) => {
			const scope = resolveScope(c);
			if (scope === null) return c.json(NO_ORG_BODY, 400);
			return c.json(await fetchKpisView(storage, scope));
		});
	}

	const sessions = daemon.group(DASHBOARD_GROUPS.sessions);
	if (sessions !== undefined) {
		// Served at `/sessions` under the diagnostics group (full `/api/diagnostics/sessions`).
		sessions.get("/sessions", async (c) => {
			const scope = resolveScope(c);
			if (scope === null) return c.json(NO_ORG_BODY, 400);
			return c.json(await fetchSessionsView(storage, scope));
		});
	}

	const settings = daemon.group(DASHBOARD_GROUPS.settings);
	if (settings !== undefined) {
		// Served off the diagnostics group at `/settings` so it does not collide with the 020d
		// notifications handler on the same group (full path `/api/diagnostics/settings`).
		settings.get("/settings", (c) => {
			const scope = resolveScope(c);
			if (scope === null) return c.json(NO_ORG_BODY, 400);
			return c.json(buildSettingsView(scope, { mode: daemon.config.mode, port: daemon.config.port }));
		});
	}

	const graph = daemon.group(DASHBOARD_GROUPS.graph);
	if (graph !== undefined) {
		graph.get("/", async (c) => {
			const scope = resolveScope(c);
			if (scope === null) return c.json(NO_ORG_BODY, 400);
			return c.json(await fetchGraphView(storage, scope));
		});
	}

	const rules = daemon.group(DASHBOARD_GROUPS.rules);
	if (rules !== undefined) {
		// Served at `/rules` under the diagnostics group (full `/api/diagnostics/rules`) so the
		// canonical `/api/rules` resource path is left to the PRD-022 product-data data-access API.
		rules.get("/rules", async (c) => {
			const scope = resolveScope(c);
			if (scope === null) return c.json(NO_ORG_BODY, 400);
			return c.json(await fetchRulesView(storage, scope));
		});
	}

	const skills = daemon.group(DASHBOARD_GROUPS.skills);
	if (skills !== undefined) {
		// Served at `/skills` under the diagnostics group (full `/api/diagnostics/skills`) so the
		// canonical `/api/skills` resource path is left to the PRD-022 product-data data-access API.
		skills.get("/skills", async (c) => {
			const scope = resolveScope(c);
			if (scope === null) return c.json(NO_ORG_BODY, 400);
			return c.json(await fetchSkillSyncView(storage, scope));
		});
	}
}

/** The codebase-snapshot graph shape persisted in `snapshot_jsonb`. */
interface SnapshotGraph {
	readonly nodes: { readonly id: string; readonly label: string; readonly kind: string }[];
	readonly edges: { readonly from: string; readonly to: string; readonly kind: string }[];
}

/**
 * Parse the persisted `snapshot_jsonb` into the 020b graph view-model nodes/edges, tolerating a
 * string-or-object column and missing fields. Returns empty arrays on anything unparseable
 * (the caller has already decided `built: true` from row presence, so a malformed snapshot
 * renders an empty canvas rather than throwing).
 */
function parseSnapshot(raw: unknown): SnapshotGraph {
	let obj: unknown = raw;
	if (typeof raw === "string") {
		try {
			obj = JSON.parse(raw);
		} catch {
			return { nodes: [], edges: [] };
		}
	}
	if (obj === null || typeof obj !== "object") return { nodes: [], edges: [] };
	const rec = obj as Record<string, unknown>;
	const rawNodes = Array.isArray(rec.nodes) ? rec.nodes : [];
	const rawEdges = Array.isArray(rec.edges) ? rec.edges : [];
	const nodes = rawNodes.map((n) => {
		const nn = (n ?? {}) as Record<string, unknown>;
		return { id: toStr(nn.id), label: toStr(nn.label ?? nn.name ?? nn.id), kind: toStr(nn.kind ?? nn.type) };
	});
	const edges = rawEdges.map((e) => {
		const ee = (e ?? {}) as Record<string, unknown>;
		return { from: toStr(ee.from ?? ee.source), to: toStr(ee.to ?? ee.target), kind: toStr(ee.kind ?? ee.type) };
	});
	return { nodes, edges };
}

/**
 * The dashboard data API attach seam — PRD-020b (daemon side, storage-correct).
 *
 * The 020b dashboard is a THIN CLIENT: it reads its six view-models through the daemon's
 * dashboard endpoints, never opening DeepLake. This module is the daemon-side counterpart —
 * the single named step the daemon assembly calls AFTER `createDaemon(...)` to attach the
 * dashboard data handlers onto the already-mounted route groups, mirroring
 * `attachHooksHandlers` (019b). ZERO edits to `server.ts`: the route groups
 * (`/api/diagnostics`, `/api/kpis`, `/api/sessions`, `/api/graph`, `/api/rules`,
 * `/api/skills`) are already scaffolded + protected, so attaching via `daemon.group(path)`
 * inherits auth/RBAC with no re-wiring.
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
import type { Daemon } from "../server.js";

/** Options for {@link mountDashboardApi}. */
export interface MountDashboardOptions {
	/** The storage client the view reads run through (never a raw fetch). */
	readonly storage: StorageQuery;
}

/**
 * The dashboard route groups the data API attaches to (already mounted in `server.ts`).
 * Each handler attaches via `daemon.group(<group>)` and returns the matching 020b
 * view-model. Keeping the list here documents exactly which already-scaffolded groups the
 * dashboard fills — no new group, no `server.ts` edit.
 */
export const DASHBOARD_GROUPS = Object.freeze({
	/** KPIs view-model (FR-2). */
	kpis: "/api/kpis",
	/**
	 * Sessions view-model (FR-3) — served off the diagnostics group at `/sessions` (full path
	 * `/api/diagnostics/sessions`). There is NO standalone `/api/sessions` route group mounted in
	 * `server.ts`, and this seam never edits `server.ts`; the diagnostics group is mounted +
	 * protected, so the sessions read attaches there with no bootstrap change.
	 */
	sessions: "/api/diagnostics",
	/** Settings view-model (FR-4) — served off the diagnostics group at `/settings`. */
	settings: "/api/diagnostics",
	/** Graph view-model (FR-5 / a-AC-6 empty-state). */
	graph: "/api/graph",
	/** Rules view-model (FR-6 / a-AC-4). */
	rules: "/api/rules",
	/** Skill-sync view-model (FR-6). */
	skills: "/api/skills",
} as const);

/**
 * Resolve the per-request tenancy scope from the `x-honeycomb-*` headers (the same tenancy
 * the rest of the daemon reads). Returns `null` when no org is present → the handler 400s
 * (fail-closed; an unscoped request never falls back to a broad read).
 */
function resolveScope(c: Context): QueryScope | null {
	const org = c.req.header("x-honeycomb-org");
	if (org === undefined || org.length === 0) return null;
	const workspace = c.req.header("x-honeycomb-workspace");
	return workspace !== undefined && workspace.length > 0 ? { org, workspace } : { org };
}

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

/**
 * Attach the dashboard data handlers onto the daemon's already-mounted route groups (the
 * 020b daemon-side seam). Registers one read handler per view, each reading through
 * `options.storage` with guarded SQL and returning the matching 020b view-model. Call ONCE
 * after `createDaemon(...)`. A request with no resolvable tenancy 400s (fail-closed). If a
 * group is not mounted (unknown daemon shape) the attach for that view is skipped.
 */
export function mountDashboardApi(daemon: Daemon, options: MountDashboardOptions): void {
	const storage = options.storage;

	const kpis = daemon.group(DASHBOARD_GROUPS.kpis);
	if (kpis !== undefined) {
		// KPIs (FR-2): memory volume, session counts, savings. Counts come from the engine
		// tables; savings is a derived org metric (0 until the savings pipeline lands — a
		// real number, never a fabricated one).
		kpis.get("/", async (c) => {
			const scope = resolveScope(c);
			if (scope === null) return c.json({ error: "bad_request", reason: "x-honeycomb-org header is required" }, 400);
			const memTbl = sqlIdent("memory");
			const sessTbl = sqlIdent("sessions");
			const [memRows, sessRows] = await Promise.all([
				selectRows(storage, `SELECT COUNT(*) AS n FROM "${memTbl}"`, scope),
				selectRows(storage, `SELECT COUNT(*) AS n FROM "${sessTbl}"`, scope),
			]);
			return c.json({
				memoryCount: toNum(memRows[0]?.n),
				sessionCount: toNum(sessRows[0]?.n),
				estimatedSavings: 0,
			});
		});
	}

	const sessions = daemon.group(DASHBOARD_GROUPS.sessions);
	if (sessions !== undefined) {
		// Sessions (FR-3): captured sessions + metadata (project / dates / event-counts / status).
		// Served at `/sessions` under the diagnostics group (full `/api/diagnostics/sessions`).
		sessions.get("/sessions", async (c) => {
			const scope = resolveScope(c);
			if (scope === null) return c.json({ error: "bad_request", reason: "x-honeycomb-org header is required" }, 400);
			const tbl = sqlIdent("sessions");
			const rows = await selectRows(
				storage,
				`SELECT ${sqlIdent("id")}, ${sqlIdent("project")}, ${sqlIdent("creation_date")}, ${sqlIdent("path")} ` +
					`FROM "${tbl}" ORDER BY ${sqlIdent("creation_date")} DESC LIMIT 200`,
				scope,
			);
			const list = rows.map((r) => ({
				sessionId: toStr(r.id),
				project: toStr(r.project),
				startedAt: toStr(r.creation_date),
				eventCount: 0,
				status: "captured",
			}));
			return c.json({ sessions: list });
		});
	}

	const settings = daemon.group(DASHBOARD_GROUPS.settings);
	if (settings !== undefined) {
		// Settings (FR-4): active org + workspace config. Served off the diagnostics group at
		// `/settings` (full path `/api/diagnostics/settings`) so it doesn't collide with the
		// 020d notifications handler on the same group.
		settings.get("/settings", (c) => {
			const scope = resolveScope(c);
			if (scope === null) return c.json({ error: "bad_request", reason: "x-honeycomb-org header is required" }, 400);
			return c.json({
				orgId: scope.org,
				orgName: scope.org,
				workspace: scope.workspace ?? "default",
				settings: { mode: daemon.config.mode, port: String(daemon.config.port) },
			});
		});
	}

	const graph = daemon.group(DASHBOARD_GROUPS.graph);
	if (graph !== undefined) {
		// Graph (FR-5 / a-AC-3 / a-AC-6): the latest codebase snapshot for the workspace. When
		// no snapshot exists, return `built: false` (the empty-state flag the dashboard renders
		// as the `honeycomb graph build` prompt, NOT an error).
		graph.get("/", async (c) => {
			const scope = resolveScope(c);
			if (scope === null) return c.json({ error: "bad_request", reason: "x-honeycomb-org header is required" }, 400);
			const tbl = sqlIdent("codebase");
			const rows = await selectRows(
				storage,
				`SELECT ${sqlIdent("snapshot_jsonb")}, ${sqlIdent("node_count")}, ${sqlIdent("edge_count")} ` +
					`FROM "${tbl}" WHERE ${sqlIdent("org_id")} = ${sLiteral(scope.org)} ` +
					`ORDER BY ${sqlIdent("schema_version")} DESC LIMIT 1`,
				scope,
			);
			if (rows.length === 0) return c.json({ built: false, nodes: [], edges: [] });
			const snapshot = parseSnapshot(rows[0]?.snapshot_jsonb);
			return c.json({ built: true, nodes: snapshot.nodes, edges: snapshot.edges });
		});
	}

	const rules = daemon.group(DASHBOARD_GROUPS.rules);
	if (rules !== undefined) {
		// Rules (FR-6 / a-AC-4): the org-wide rules from the `rules` table, active first.
		rules.get("/", async (c) => {
			const scope = resolveScope(c);
			if (scope === null) return c.json({ error: "bad_request", reason: "x-honeycomb-org header is required" }, 400);
			const tbl = sqlIdent("rules");
			const rows = await selectRows(
				storage,
				`SELECT ${sqlIdent("id")}, ${sqlIdent("name")}, ${sqlIdent("status")} ` +
					`FROM "${tbl}" ORDER BY ${sqlIdent("version")} DESC LIMIT 500`,
				scope,
			);
			const list = rows.map((r) => ({
				id: toStr(r.id),
				title: toStr(r.name),
				active: toStr(r.status) === "active",
			}));
			return c.json({ rules: list });
		});
	}

	const skills = daemon.group(DASHBOARD_GROUPS.skills);
	if (skills !== undefined) {
		// Skill-sync (FR-6): pulled + shared team skills and their sync state.
		skills.get("/", async (c) => {
			const scope = resolveScope(c);
			if (scope === null) return c.json({ error: "bad_request", reason: "x-honeycomb-org header is required" }, 400);
			const tbl = sqlIdent("skills");
			const rows = await selectRows(
				storage,
				`SELECT ${sqlIdent("name")}, ${sqlIdent("scope")}, ${sqlIdent("visibility")} ` +
					`FROM "${tbl}" ORDER BY ${sqlIdent("version")} DESC LIMIT 500`,
				scope,
			);
			const list = rows.map((r) => ({
				name: toStr(r.name),
				scope: toStr(r.scope),
				syncState: toStr(r.visibility) === "global" ? "shared" : "pulled",
			}));
			return c.json({ skills: list });
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

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
	LocalAssetInventory,
	RulesView,
	SessionsView,
	SettingsView,
	SkillSyncRow,
	SkillSyncView,
} from "../../../dashboard/contracts.js";
import { scanInstalledAssets } from "./installed-assets.js";
import {
	SYNCED_ASSETS_TABLE,
	TOMBSTONE_FALSE,
} from "../../storage/catalog/synced-assets.js";
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
	/**
	 * The friendly org name (e.g. "OSPRY") resolved from the daemon's credentials at the
	 * composition root, threaded so the settings view shows the human name instead of the org
	 * GUID. ABSENT (a unit-constructed daemon / no creds) → the settings view falls back to the
	 * scope's org id (the prior behaviour). Display-only; never a tenancy decision.
	 */
	readonly orgName?: string;
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
	/**
	 * Installed-assets inventory (PRD-036a) — the on-disk skill/agent scan, served off the
	 * diagnostics group at `/installed-assets` (full path `/api/diagnostics/installed-assets`).
	 * READ-ONLY filesystem walk; tenancy-independent (no org header required). PRD-036b calls
	 * the underlying `scanInstalledAssets` IN-PROCESS, not over this HTTP surface.
	 */
	installedAssets: "/api/diagnostics",
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

/**
 * The chars-per-token divisor used to estimate token counts from text length (PRD-035b OQ-2).
 *
 * A documented, cheap constant: English text averages ~4 characters per token across common BPE
 * tokenizers, so `tokens ≈ chars / 4` is a good-enough estimate for a headline KPI labeled
 * "Est. savings". We deliberately do NOT call a real tokenizer per request — that would be far too
 * expensive for a single dashboard number, and the value is explicitly an ESTIMATE.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Fetch the KPIs view (FR-1 / d-AC-1): memory + turn counts, the real estimated-savings metric
 * (PRD-035b), and the team-shared skill count (PRD-036c).
 *
 * `turnCount` (PRD-035a) carries the SAME value as `sessionCount` — both come from the one
 * `COUNT(*) FROM "sessions"` below — under the presentation-honest name the dashboard renders
 * ("Turns"). The `sessions` DeepLake table is NOT renamed (a schema concern, out of scope — 035a D-3).
 *
 * `estimatedSavings` (PRD-035b) replaces the old hardcoded `0`. It is the memory-corpus token proxy
 * (the ledger decision): the total distilled context the corpus can serve, approximated as
 * `Σ tokens(memory content) ≈ Σ LENGTH(content) / CHARS_PER_TOKEN` over the org's stored memories.
 * Every recalled-and-injected memory is context the agent did NOT have to re-derive, so the corpus's
 * total token mass is a coarse "context available to be reused" estimate (035b D-1 fallback formula).
 * It is computed by ONE additional guarded aggregate (`SUM(LENGTH(content))`) through the same
 * `selectRows` fail-soft seam — no N+1 — and the divide-by-constant happens in TS so we do not lean
 * on backend integer-division semantics. The KPI reads `0` ONLY when the corpus is genuinely empty
 * (no memories → SUM is NULL → `toNum` → 0) or on a storage error (`selectRows` returns `[]`), never
 * a stub.
 *
 * `teamSkillCount` (PRD-036c) counts the skills actually SHARED with the team: the current-version,
 * non-tombstone `asset_type='skill'` rows in the `synced_assets` substrate (publishing to the
 * substrate IS sharing). It binds the "Team skills" KPI to a DEFINED count rather than an incidental
 * panel-array `.length` (036c D-2), so local-only disk skills never inflate it (036c D-1). The
 * COUNT(DISTINCT honeycomb_id) over non-tombstone rows is name-independent and cheap; a missing
 * `synced_assets` table / storage error fails soft to `0`.
 */
export async function fetchKpisView(storage: StorageQuery, scope: QueryScope): Promise<KpisView> {
	// The distilled-fact table is `memories` (PRD-003a `catalog/memories.ts`), not `memory` —
	// a stale singular here silently returned 0 for the Memories KPI against the real backend.
	const memTbl = sqlIdent("memories");
	const sessTbl = sqlIdent("sessions");
	const [memRows, sessRows, savingsRows, teamSkillRows] = await Promise.all([
		selectRows(storage, `SELECT COUNT(*) AS n FROM "${memTbl}"`, scope),
		selectRows(storage, `SELECT COUNT(*) AS n FROM "${sessTbl}"`, scope),
		selectRows(storage, buildEstimatedSavingsSql(), scope),
		selectRows(storage, buildTeamSkillCountSql(), scope),
	]);
	const sessionCount = toNum(sessRows[0]?.n);
	// 035b: chars → tokens via the documented divisor. SUM is NULL on an empty corpus → toNum → 0.
	const estimatedSavings = Math.floor(toNum(savingsRows[0]?.chars) / CHARS_PER_TOKEN);
	return {
		memoryCount: toNum(memRows[0]?.n),
		// 035a: same value, two names — `sessionCount` kept (additive), `turnCount` is what the UI reads.
		sessionCount,
		turnCount: sessionCount,
		estimatedSavings,
		teamSkillCount: toNum(teamSkillRows[0]?.n),
	};
}

/**
 * Build the PRD-035b estimated-savings aggregate: the total character length of the memory corpus's
 * distilled `content`, which `fetchKpisView` divides by {@link CHARS_PER_TOKEN} to estimate tokens.
 * The `memories` table is the distilled-fact store (PRD-003a `catalog/memories.ts`); `content` is its
 * human-readable summary text. Identifiers go through `sqlIdent` (the PRD-002b floor) — no value is
 * interpolated. A single `SUM` aggregate (no per-row N+1); NULL on an empty corpus.
 */
function buildEstimatedSavingsSql(): string {
	const tbl = sqlIdent("memories");
	const col = sqlIdent("content");
	return `SELECT SUM(LENGTH(${col})) AS chars FROM "${tbl}"`;
}

/**
 * Build the PRD-036c team-shared skill count: the number of distinct skills currently published
 * (non-tombstone) to the `synced_assets` substrate. We count DISTINCT `honeycomb_id` over the
 * latest non-tombstone `asset_type='skill'` rows — publishing to the substrate is what "sharing with
 * the team" means, so this is the honest "Team skills" number. Identifiers via `sqlIdent`, the
 * tombstone/asset-type values via `sLiteral` (PRD-002b). Local-only disk skills are not in
 * `synced_assets`, so they cannot inflate this count (036c D-1).
 */
function buildTeamSkillCountSql(): string {
	const tbl = sqlIdent(SYNCED_ASSETS_TABLE);
	const idCol = sqlIdent("honeycomb_id");
	const typeCol = sqlIdent("asset_type");
	const tombCol = sqlIdent("tombstone");
	return (
		`SELECT COUNT(DISTINCT ${idCol}) AS n FROM "${tbl}" ` +
		`WHERE ${typeCol} = ${sLiteral("skill")} AND ${tombCol} = ${sLiteral(TOMBSTONE_FALSE)}`
	);
}

/** Fetch the sessions view (FR-1 / d-AC-1): captured sessions + project/date metadata, newest first. */
export async function fetchSessionsView(storage: StorageQuery, scope: QueryScope): Promise<SessionsView> {
	const tbl = sqlIdent("sessions");
	const rows = await selectRows(
		storage,
		`SELECT ${sqlIdent("id")}, ${sqlIdent("project")}, ${sqlIdent("creation_date")}, ${sqlIdent("path")} ` +
			// The dashboard paginates 5 rows/page client-side, so a saner cap than 200 is plenty; the
		// KPI sessionCount comes from a separate COUNT(*) query, so the displayed total is unaffected.
		`FROM "${tbl}" ORDER BY ${sqlIdent("creation_date")} DESC LIMIT 50`,
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

/**
 * Build the settings view (FR-1 / d-AC-1): active org/workspace + the exposed runtime config.
 *
 * `orgName` is the friendly credentials org name (e.g. "OSPRY") when the daemon resolved one
 * from `~/.deeplake/credentials.json`; it falls back to the scope's org id when absent (a
 * unit-constructed daemon / no creds) so the field is never empty. `orgId` is always the scope
 * org. Display-only — neither value loosens tenancy.
 */
export function buildSettingsView(
	scope: QueryScope,
	config: DashboardSettingsConfig,
	orgName?: string,
): SettingsView {
	return {
		orgId: scope.org,
		orgName: orgName !== undefined && orgName.length > 0 ? orgName : scope.org,
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

/** The `local` sync state for a skill found on disk but absent from the team substrate (PRD-036b). */
const LOCAL_SYNC_STATE = "local" as const;

/** Normalize a skill name to its union key (case-insensitive, trimmed) — the 036b collision key (OQ-2). */
function normalizeSkillKey(name: string): string {
	return name.trim().toLowerCase();
}

/**
 * Fetch the skill-sync view (FR-1 / d-AC-1 / PRD-036b): the UNION of locally-installed skills and
 * team-synced skills, each row carrying an honest `syncState`.
 *
 * Today this read returned ONLY the team-synced rows, so the panel showed 0 on a workspace with an
 * empty substrate even when 27 skills sit on disk. PRD-036b merges the 036a local inventory in:
 *
 *   1. Read the team-synced rows. The SUBSTRATE OF RECORD is `synced_assets` (PRD-033), but those
 *      rows are keyed by an opaque `honeycomb_id` and carry NO human `name` to union on — so the
 *      named substrate source the union keys against is the legacy `skills` table (which has `name`
 *      + `visibility` → `shared`/`pulled`). This honors "prefer synced_assets, treat `skills` as
 *      fallback": `synced_assets` drives the team-shared COUNT (the KPI, `buildTeamSkillCountSql`),
 *      while the named `skills` rows supply the panel's synced half (036b implementation note, OQ-1).
 *   2. Call the 036a scanner IN-PROCESS (D-4 — not over HTTP; both run in the daemon) for the local
 *      disk skills → candidate `local` rows.
 *   3. UNION by normalized `name` (D-1 / OQ-2). On a collision the SUBSTRATE STATE WINS (a skill both
 *      on disk and synced shows as shared/synced/pulled, never `local`) — the more-informative team
 *      state is what the user cares about. A name only on disk → `local`; a name only in the
 *      substrate → its existing state. Exactly one row per logical skill (no double-count).
 *
 * Fail-soft (D-4 / b-AC-6): a discovery error degrades to the substrate-only view (today's
 * behaviour) — `scanInstalledAssets` is itself fail-soft (returns an empty inventory, never throws),
 * and `selectRows` fails soft to `[]`, so this fetcher never crashes or 500s the panel. As a belt-
 * and-braces guard, the scan is additionally wrapped so even a thrown scanner degrades to empty.
 *
 * The `scan` parameter is INJECTABLE (additive, defaults to the real {@link scanInstalledAssets}) so
 * a daemon-side test can drive the union deterministically with a fake/temp-dir scanner without
 * walking the real `process.cwd()` (036b implementation note).
 */
export async function fetchSkillSyncView(
	storage: StorageQuery,
	scope: QueryScope,
	scan: () => Promise<LocalAssetInventory> = scanInstalledAssets,
): Promise<SkillSyncView> {
	const tbl = sqlIdent("skills");
	const [substrateRows, inventory] = await Promise.all([
		selectRows(
			storage,
			`SELECT ${sqlIdent("name")}, ${sqlIdent("scope")}, ${sqlIdent("visibility")} ` +
				`FROM "${tbl}" ORDER BY ${sqlIdent("version")} DESC LIMIT 500`,
			scope,
		),
		// D-4: the 036a discovery is fail-soft (empty inventory on any error), so its skills half
		// degrades the union to substrate-only rather than failing the panel. The catch is a second
		// guard in case an injected scanner throws — the panel still renders the substrate view.
		scan().catch((): LocalAssetInventory => ({ skills: [], agents: [] })),
	]);

	// Start the union from the SUBSTRATE rows (their state is authoritative on a collision — D-1).
	const merged = new Map<string, SkillSyncRow>();
	for (const r of substrateRows) {
		const name = toStr(r.name);
		const key = normalizeSkillKey(name);
		if (key === "") continue;
		merged.set(key, {
			name,
			scope: toStr(r.scope),
			syncState: toStr(r.visibility) === "global" ? "shared" : "pulled",
		});
	}

	// Fold in the local disk skills: a name NOT already in the substrate becomes a `local` row; a
	// name already present is left UNTOUCHED (substrate state wins → no double-count — D-1 / b-AC-2).
	for (const asset of inventory.skills) {
		const key = normalizeSkillKey(asset.name);
		if (key === "" || merged.has(key)) continue;
		merged.set(key, { name: asset.name, scope: asset.scope, syncState: LOCAL_SYNC_STATE });
	}

	// Stable output: substrate rows keep their substrate order first, then local-only by insertion.
	return { skills: [...merged.values()] };
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
			return c.json(
				buildSettingsView(scope, { mode: daemon.config.mode, port: daemon.config.port }, options.orgName),
			);
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

	// PRD-036a — the installed-assets inventory: a READ-ONLY on-disk skill/agent scan,
	// served at `/installed-assets` under the diagnostics group. Tenancy-INDEPENDENT (the
	// scan walks the filesystem, not storage), so it needs no org header — auth/RBAC is
	// still inherited from the protected diagnostics group. A short TTL cache (D-1) keeps
	// repeated dashboard refreshes from re-walking the tree each time. The scan is fail-soft
	// (degrades to an empty inventory), so this handler never 500s.
	const installedAssets = daemon.group(DASHBOARD_GROUPS.installedAssets);
	if (installedAssets !== undefined) {
		const inventoryCache = createInventoryCache();
		installedAssets.get("/installed-assets", async (c) => {
			return c.json(await inventoryCache());
		});
	}
}

/** The TTL for the installed-assets inventory cache (PRD-036a D-1). */
const INSTALLED_ASSETS_TTL_MS = 5_000;

/**
 * Build a memoizing reader for the installed-assets inventory: it runs
 * {@link scanInstalledAssets} (project-root only by default, D-1) and caches the
 * result for {@link INSTALLED_ASSETS_TTL_MS}, so repeated dashboard refreshes share
 * one filesystem walk. Each `mountDashboardApi` call gets its own cache instance.
 */
function createInventoryCache(): () => Promise<LocalAssetInventory> {
	let cached: { value: LocalAssetInventory; at: number } | undefined;
	return async (): Promise<LocalAssetInventory> => {
		const now = Date.now();
		if (cached !== undefined && now - cached.at < INSTALLED_ASSETS_TTL_MS) return cached.value;
		const value = await scanInstalledAssets();
		cached = { value, at: now };
		return value;
	};
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

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
 * ── `GET /api/graph` is OWNED ELSEWHERE (route-collision resolution) ──────────
 *   The codebase-graph view (`GET /api/graph`) is served by `mountGraphApi`
 *   (`codebase/api.ts`), the SINGLE owner of the `/api/graph` group — it returns the FULL
 *   `{ built, nodes, edges }` GraphView (`built:false` empty-state when no snapshot exists)
 *   from the freshest LOCAL snapshot. This seam's former DeepLake-read graph handler was
 *   retired to clear the latent `/api/graph` double-registration. The MEMORY-graph view this
 *   seam DOES own lives at `/api/diagnostics/memory-graph` (a distinct path — no collision).
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
import { resolveRequestProject, resolveScopeOrLocalDefault } from "../scope.js";
import type {
	GraphView,
	KpisView,
	LocalAssetInventory,
	MemoryGraphView,
	RoiCostBasisTag,
	RoiRollup,
	RoiRollupDimension,
	RoiRollupRow,
	RoiTrendView,
	RoiView,
	RulesView,
	SessionsView,
	SettingsView,
	SkillSyncRow,
	SkillSyncView,
} from "../../../dashboard/contracts.js";
import { EMPTY_ROI_TREND, EMPTY_ROI_VIEW } from "../../../dashboard/contracts.js";
import { scanInstalledAssets } from "./installed-assets.js";
import {
	SYNCED_ASSETS_TABLE,
	TOMBSTONE_FALSE,
} from "../../storage/catalog/synced-assets.js";
import {
	blendedCentsPerMtok,
	type CapturedTurn,
	measuredCacheSavings,
	modeledMemoryInjectionSavings,
} from "./roi-savings.js";
import { RATES_AS_OF } from "./roi-rates.js";
import { createInfraCostReadModel, type InfraCostReadModel, type InfraCostReadModel_API } from "./roi-billing.js";
import { composePollinationCost, type PollinationStatus } from "./roi-pollination.js";
import { type SkillifyUsageSource, emptyUsageSource } from "./roi-skillify-meter.js";
import { readRoiMetrics } from "./roi-ledger.js";
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
	/**
	 * PRD-060e — the 060c infra-cost read-model (the SOLE billing egress + creds holder), threaded from
	 * the composition root so the ROI view-model reads infra cost over loopback without minting its own
	 * billing client. ABSENT (a unit-constructed daemon) → the `/api/diagnostics/roi` handler builds a
	 * fresh fail-soft model per call (degrades to `unauthenticated`/`unreachable`). Daemon is sole egress.
	 */
	readonly roiInfra?: InfraCostReadModel_API;
	/**
	 * PRD-060e — the 060d skillify usage meter (the live "since boot" own-inference rollup) the
	 * pollination half reads. ABSENT → the empty source (no calls metered → an `absent` Haiku
	 * contribution, never a fabricated `$0`). Threaded from the composition root which owns the singleton.
	 */
	readonly roiUsage?: SkillifyUsageSource;
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
	/**
	 * Memory-graph view-model (PRD-041b D-2 / OQ-5) — the knowledge graph of memories/entities, served
	 * at `GET /api/memory-graph` off the diagnostics group (full path `/api/diagnostics/memory-graph`).
	 * MIRRORS the codebase graph's `built` contract: `built:false` empty state until the PRD-008 ontology
	 * tables are populated. Attached under the already-mounted, protected diagnostics group exactly like
	 * the other dashboard view-models — no new group, no `server.ts` edit.
	 */
	memoryGraph: "/api/diagnostics",
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
	/**
	 * ROI composite read-model (PRD-060e) — served off the diagnostics group at `/roi` + `/roi/trend`
	 * (full paths `/api/diagnostics/roi` + `/api/diagnostics/roi/trend`). Local-mode-only loopback like
	 * every other dashboard view-model; attached under the already-mounted, protected diagnostics group
	 * (no new group, no `server.ts` edit). The page is a PURE function of the `RoiView` this returns.
	 */
	roi: "/api/diagnostics",
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
export async function fetchKpisView(storage: StorageQuery, scope: QueryScope, projectId?: string): Promise<KpisView> {
	// Composed of two INDEPENDENTLY-CACHEABLE reads (the route caches them at different TTLs — counts churn,
	// the savings SUM is heavy + slow-moving): the cheap-ish counts and the corpus-length SUM. Composed here
	// (uncached) so a direct caller / unit test gets the whole view in one call.
	const [counts, estimatedSavings] = await Promise.all([
		fetchKpiCounts(storage, scope, projectId),
		fetchEstimatedSavings(storage, scope, projectId),
	]);
	return { ...counts, estimatedSavings };
}

/** The KPI band MINUS the estimated-savings metric — the three counts the route caches on the short TTL. */
export type KpiCounts = Omit<KpisView, "estimatedSavings">;

/**
 * The three KPI COUNTS (PRD-035a/036c): Memories + Turns (`sessions`) + Team skills. The two
 * project-BEARING counts (`memories` + `sessions` carry `project_id`) narrow to the selected project when
 * one was stamped; `synced_assets` has NO `project_id` (a skill is shared with the TEAM, not a project) so
 * the Team-skills count stays workspace-wide BY DESIGN. Absent/blank project → no clause (workspace-wide,
 * back-compat). Each read is independently guarded via `selectRows` (fail-soft → 0), no N+1.
 */
export async function fetchKpiCounts(storage: StorageQuery, scope: QueryScope, projectId?: string): Promise<KpiCounts> {
	// The distilled-fact table is `memories` (PRD-003a `catalog/memories.ts`), not `memory` — a stale
	// singular here silently returned 0 for the Memories KPI against the real backend.
	const memTbl = sqlIdent("memories");
	const sessTbl = sqlIdent("sessions");
	const projClause = projectWhereClause(projectId);
	const [memRows, sessRows, teamSkillRows] = await Promise.all([
		selectRows(storage, `SELECT COUNT(*) AS n FROM "${memTbl}"${projClause}`, scope),
		selectRows(storage, `SELECT COUNT(*) AS n FROM "${sessTbl}"${projClause}`, scope),
		selectRows(storage, buildTeamSkillCountSql(), scope),
	]);
	const sessionCount = toNum(sessRows[0]?.n);
	return {
		memoryCount: toNum(memRows[0]?.n),
		// 035a: same value, two names — `sessionCount` kept (additive), `turnCount` is what the UI reads.
		sessionCount,
		turnCount: sessionCount,
		teamSkillCount: toNum(teamSkillRows[0]?.n),
	};
}

/**
 * The PRD-035b estimated-savings metric (tokens): the memory corpus's total distilled-`content` length
 * divided by {@link CHARS_PER_TOKEN}. This is the SINGLE most expensive KPI query (it sums a TEXT column
 * across the corpus) AND it moves slowly, so the route caches it on a LONGER TTL than the counts. Scoped
 * to the selected project (same predicate as the Memories count). `0` on an empty corpus or a storage error.
 */
export async function fetchEstimatedSavings(storage: StorageQuery, scope: QueryScope, projectId?: string): Promise<number> {
	const savingsRows = await selectRows(storage, buildEstimatedSavingsSql(projectId), scope);
	// 035b: chars → tokens via the documented divisor. SUM is NULL on an empty corpus → toNum → 0.
	return Math.floor(toNum(savingsRows[0]?.chars) / CHARS_PER_TOKEN);
}

/**
 * Build the PRD-035b estimated-savings aggregate: the total character length of the memory corpus's
 * distilled `content`, which `fetchKpisView` divides by {@link CHARS_PER_TOKEN} to estimate tokens.
 * The `memories` table is the distilled-fact store (PRD-003a `catalog/memories.ts`); `content` is its
 * human-readable summary text. Identifiers go through `sqlIdent` (the PRD-002b floor) — no value is
 * interpolated. A single `SUM` aggregate (no per-row N+1); NULL on an empty corpus.
 */
function buildEstimatedSavingsSql(projectId?: string): string {
	const tbl = sqlIdent("memories");
	const col = sqlIdent("content");
	// PRD-049e: scope the corpus SUM to the selected project (same predicate as the Memories count) so
	// the "Est. savings" KPI reflects the project's distilled corpus, not the whole workspace.
	return `SELECT SUM(LENGTH(${col})) AS chars FROM "${tbl}"${projectWhereClause(projectId)}`;
}

/**
 * Build the optional ` WHERE project_id = '<id>'` predicate for a project-BEARING table (PRD-049e —
 * `memories` + `sessions` both carry `project_id`). Returns an EMPTY string when no project is
 * selected, so the read stays workspace-wide (back-compat). The id rides through `sLiteral` and the
 * column through `sqlIdent` (the PRD-002b floor — no value is raw-interpolated), so the composed
 * clause is audit:sql safe. Centralized so the KPI count, the savings SUM, and the ROI savings read
 * share ONE project-filter spelling that cannot drift.
 */
function projectWhereClause(projectId: string | undefined): string {
	return projectId !== undefined && projectId !== "" ? ` WHERE ${sqlIdent("project_id")} = ${sLiteral(projectId)}` : "";
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

/** The default sessions page size when no `?limit=` is given (the legacy dashboard-panel cap). */
export const DEFAULT_SESSIONS_LIMIT = 50;
/** The hard ceiling on a browsable-turns page (PRD-043c — a higher bound than the panel's 50). */
export const MAX_SESSIONS_LIMIT = 500;

/**
 * PRD-043c — options for a BROWSABLE turns history over {@link fetchSessionsView}. ADDITIVE: when
 * omitted, the fetcher behaves EXACTLY as the legacy dashboard-panel read (newest 50, no cursor),
 * so the existing `SessionsPanel`/`wire.sessions()` are unchanged. When provided, the read pages on
 * a stable `(creation_date, id)` cursor for the Logs page's Turns section (FR-3).
 *
 * NOTE (project memory — DeepLake eventual consistency): a freshly-captured turn may not be
 * immediately readable from a stale segment. This paged read makes NO single-immediate-read
 * assumption — a caller reading back a just-written turn must poll until convergence. The page
 * surface tolerates a row appearing one refresh later (it is append-only and newest-first).
 */
export interface SessionsPageOptions {
	/** Page size, clamped to `[1, MAX_SESSIONS_LIMIT]`. Defaults to {@link DEFAULT_SESSIONS_LIMIT}. */
	readonly limit?: number;
	/** Page strictly OLDER than this `(creation_date, id)` cursor (exclusive). */
	readonly before?: { readonly creationDate: string; readonly id: string };
}

/** A page of captured turns plus the cursor for the next (older) page (PRD-043c FR-3). */
export interface SessionsPage extends SessionsView {
	/** The opaque cursor to fetch the next older page, or `null` when this is the last page. */
	readonly nextCursor: string | null;
}

/** Clamp a raw `?limit=` to `[1, MAX_SESSIONS_LIMIT]`, defaulting a missing/garbage value. */
export function resolveSessionsLimit(raw: string | undefined): number {
	if (raw === undefined || raw.length === 0) return DEFAULT_SESSIONS_LIMIT;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_SESSIONS_LIMIT;
	return Math.min(n, MAX_SESSIONS_LIMIT);
}

/** Encode a turns cursor `(creation_date, id)` to an opaque base64url token. */
export function encodeSessionsCursor(cursor: { creationDate: string; id: string }): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Decode a turns cursor token, or `undefined` on any malformed/garbage value (fail-safe). */
export function decodeSessionsCursor(token: string | undefined): { creationDate: string; id: string } | undefined {
	if (token === undefined || token === "") return undefined;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
		if (typeof parsed === "object" && parsed !== null) {
			const cd = (parsed as { creationDate?: unknown }).creationDate;
			const id = (parsed as { id?: unknown }).id;
			if (typeof cd === "string" && typeof id === "string" && cd !== "" && id !== "") return { creationDate: cd, id };
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Fetch the sessions view (FR-1 / d-AC-1): captured TURNS + project/date metadata, NEWEST FIRST.
 * The read still targets the `sessions` table BY NAME via `sqlIdent("sessions")` (PRD-043c AC-3 /
 * PRD-035a D-3 — the table is not renamed; only the UI label says "Turns"). It surfaces METADATA
 * ONLY (id/project/creation_date) — never a transcript/body/JSONB column (043c D-4 / AC-5).
 *
 * PRD-043c ADDITIVE PAGING: with no `options`, this returns the legacy newest-50 panel view
 * (`fetchSessionsView(storage, scope)` is unchanged for every existing caller). With `options`, it
 * pages on a stable `(creation_date, id)` cursor and returns a {@link SessionsPage} with a
 * `nextCursor`. Every value rides through `sLiteral`; the table/column identifiers through
 * `sqlIdent` — audit:sql safe.
 */
export async function fetchSessionsView(
	storage: StorageQuery,
	scope: QueryScope,
	options?: SessionsPageOptions,
): Promise<SessionsPage> {
	const tbl = sqlIdent("sessions");
	const idCol = sqlIdent("id");
	const projCol = sqlIdent("project");
	const dateCol = sqlIdent("creation_date");
	const pathCol = sqlIdent("path");
	const limit = options?.limit !== undefined ? Math.min(Math.max(1, options.limit), MAX_SESSIONS_LIMIT) : DEFAULT_SESSIONS_LIMIT;
	// Fetch one extra row to know whether an older page exists (the cursor sentinel).
	const fetchLimit = limit + 1;

	// Cursor predicate (page strictly OLDER than the last-seen row): newest-first ordering is
	// `(creation_date DESC, id DESC)`, so "older" is `creation_date < cd OR (creation_date = cd AND
	// id < cdId)`. Every value is a `sLiteral` (no raw interpolation) — audit:sql safe.
	let cursorClause = "";
	const before = options?.before;
	if (before !== undefined) {
		const cd = sLiteral(before.creationDate);
		const cid = sLiteral(before.id);
		cursorClause = ` WHERE (${dateCol} < ${cd} OR (${dateCol} = ${cd} AND ${idCol} < ${cid}))`;
	}

	const rows = await selectRows(
		storage,
		`SELECT ${idCol}, ${projCol}, ${dateCol}, ${pathCol} ` +
			`FROM "${tbl}"${cursorClause} ORDER BY ${dateCol} DESC, ${idCol} DESC LIMIT ${fetchLimit}`,
		scope,
	);
	const hasMore = rows.length > limit;
	const pageRows = hasMore ? rows.slice(0, limit) : rows;
	const sessions = pageRows.map((r) => ({
		sessionId: toStr(r.id),
		project: toStr(r.project),
		startedAt: toStr(r.creation_date),
		// `eventCount` stays the placeholder 0 (OQ-3 — a real per-turn count defers to a coordinated
		// PRD-035 read change). The contract carries what it carries; the page renders it honestly.
		eventCount: 0,
		status: "captured",
	}));
	const lastRow = pageRows[pageRows.length - 1];
	const nextCursor =
		hasMore && lastRow !== undefined
			? encodeSessionsCursor({ creationDate: toStr(lastRow.creation_date), id: toStr(lastRow.id) })
			: null;
	return { sessions, nextCursor };
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

/**
 * The cap on memory-graph nodes/edges a single read returns (PRD-041b). A defensive bound so a large
 * populated ontology never ships an unbounded payload to the page; mirrors the codebase graph's
 * single-snapshot read being inherently bounded. The page renders whatever the endpoint returns.
 */
const MEMORY_GRAPH_LIMIT = 500;

/**
 * Fetch the MEMORY-GRAPH view (PRD-041b — FR-2 / AC-2). MIRRORS the codebase graph's `built`
 * contract: a guarded, fail-soft read that returns a {@link MemoryGraphView} (the `GraphView` shape
 * the dashboard `GraphCanvas` already renders) or the honest `{ built: false, nodes: [], edges: [] }`
 * empty state.
 *
 * ── NOW (the foundation) ─────────────────────────────────────────────────────
 *   It reads the PRD-008 ontology tables through the injected {@link StorageQuery} with the SAME
 *   guarded-SQL discipline as every other fetcher here (`sqlIdent` for identifiers, no interpolated
 *   value — these are static SELECTs, so there is no `sLiteral` value to bind): `entities` →
 *   {@link import("../../../dashboard/contracts.js").GraphNode}s (id, label=`name`, kind=ontology
 *   `type`) and `entity_dependencies` → {@link import("../../../dashboard/contracts.js").GraphEdge}s
 *   (from=`source_entity_id`, to=`target_entity_id`, kind=edge `type`). The `entities`/`entity_dependencies`
 *   tables are ENGINE tables scoped by the storage partition (no `org_id` column — knowledge-graph.ts
 *   D-2), so the read carries NO `org_id` predicate; scope isolation rides `storage.query(sql, scope)`.
 *
 * ── built:false is the honest empty state (AC-4) ─────────────────────────────
 *   PRD-008 is In-Work: the ontology tables may be empty or (on an older schema) absent. `selectRows`
 *   fails soft to `[]` on ANY non-ok result (a missing table → an empty read, never a throw), so an
 *   empty/absent graph yields `built: false` and the page renders the "no memory graph yet" state. The
 *   graph is `built: true` ONLY when at least one real entity row exists — never a faked/stub graph.
 *
 * ── DEFERRED until PRD-008 data lands (Open Questions, not silent stubs) ──────
 *   Which ontology objects become nodes (entities only vs +aspects/attributes — OQ-1), edge-threshold
 *   visibility (OQ-3), and supersession/provenance affordances (OQ-4) all defer until real rows exist.
 *   This foundation renders entities-as-nodes + dependency-edges, which is provable against an empty graph.
 *
 * No secret rides the response by construction: entity name/type + edge type are graph text, never a
 * token/credential. The labels are rendered as React TEXT by the page (XSS-safe — 041b D-6).
 */
export async function fetchMemoryGraphView(storage: StorageQuery, scope: QueryScope): Promise<MemoryGraphView> {
	const [entityRows, edgeRows] = await Promise.all([
		selectRows(storage, buildMemoryEntitiesSql(), scope),
		selectRows(storage, buildMemoryDependenciesSql(), scope),
	]);
	// built:false ONLY when there are no entities — an empty/absent ontology renders the honest empty
	// state, never a faked graph (AC-4 / AC-5). Edges without entities cannot stand alone as a graph.
	if (entityRows.length === 0) return { built: false, nodes: [], edges: [] };
	const nodes = entityRows.map((r) => ({
		id: toStr(r.id),
		// `name` is the human label; fall back to the id when an entity has no name yet.
		label: toStr(r.name) !== "" ? toStr(r.name) : toStr(r.id),
		// The ontology `type` is the node kind (entity / aspect / attribute / …) — drives the legend.
		kind: toStr(r.type),
	}));
	// Only edges whose BOTH endpoints are present in the node set render (mirrors the canvas, which
	// skips an edge with a missing endpoint) — a dangling dependency never draws a half-edge.
	const ids = new Set(nodes.map((n) => n.id));
	const edges = edgeRows
		.map((r) => ({ from: toStr(r.source_entity_id), to: toStr(r.target_entity_id), kind: toStr(r.type) }))
		.filter((e) => ids.has(e.from) && ids.has(e.to));
	return { built: true, nodes, edges };
}

/**
 * Build the memory-graph ENTITIES read (PRD-041b): the `entities` ontology table → nodes. Identifiers
 * route through `sqlIdent` (the PRD-002b floor); NO value is interpolated (a static projection +
 * ORDER BY + LIMIT), so there is no `sLiteral` to bind. Newest-first by `updated_at` so a bounded read
 * surfaces the freshest entities first.
 */
function buildMemoryEntitiesSql(): string {
	const tbl = sqlIdent("entities");
	return (
		`SELECT ${sqlIdent("id")}, ${sqlIdent("name")}, ${sqlIdent("type")} ` +
		`FROM "${tbl}" ORDER BY ${sqlIdent("updated_at")} DESC LIMIT ${MEMORY_GRAPH_LIMIT}`
	);
}

/**
 * Build the memory-graph DEPENDENCIES read (PRD-041b): the `entity_dependencies` ontology table →
 * edges. Identifiers route through `sqlIdent`; NO value is interpolated. Newest-first by `created_at`
 * (the append-only edge table has no `updated_at`). The page shows entity-to-entity dependency edges
 * as the foundation's first edge kind (OQ-1); threshold-gating (OQ-3) defers until real edges exist.
 */
function buildMemoryDependenciesSql(): string {
	const tbl = sqlIdent("entity_dependencies");
	return (
		`SELECT ${sqlIdent("source_entity_id")}, ${sqlIdent("target_entity_id")}, ${sqlIdent("type")} ` +
		`FROM "${tbl}" ORDER BY ${sqlIdent("created_at")} DESC LIMIT ${MEMORY_GRAPH_LIMIT}`
	);
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

// ─────────────────────────────────────────────────────────────────────────────
// PRD-060e — the COMPOSITE ROI read-model (the data half: e-AC-2/6/11/12/13/14/15).
//
// `fetchRoiView` is the fail-soft fan-out that assembles the `RoiView` the page renders
// as a PURE function: savings (060b over the `sessions` token columns), infra (060c read-
// model), pollination (060d composer), and the org/team/agent/project rollups (060f
// `readRoiMetrics`, scoped through `read_policy`). It mirrors `fetchKpisView`'s posture —
// `Promise.all`, guarded, NEVER throws, degrades to the typed-empty `EMPTY_ROI_VIEW`.
// The NET is computed ONLY when its inputs are present; a missing/unreachable input
// leaves the net section reflecting that and the net is NOT fabricated (e-AC-6).
// ─────────────────────────────────────────────────────────────────────────────

/** Options for {@link fetchRoiView} / {@link fetchRoiTrendView} (the scope/seam injection). */
export interface FetchRoiOptions {
	/**
	 * The requesting agent the `read_policy`-scoped ledger read pins to (060f). An `isolated` policy
	 * returns ONLY this agent's ledger rows; `shared` is workspace-wide. This is NO LONGER defaulted to
	 * `scope.org`: the org id is a TENANT identifier, not an agent identity, and filtering
	 * `roi_metrics.agent_id = <org>` would return the wrong rows (typically none). When this is absent or
	 * blank AND the policy is `isolated`, the read FAILS CLOSED (no agent to scope to => empty), never a
	 * silent filter on the org id. `shared` does not depend on the agent id and is unaffected.
	 */
	readonly agentId?: string;
	/**
	 * PRD-049e -- the SELECTED project the dashboard stamped via the `x-honeycomb-project` header. When
	 * present, BOTH the savings read (sessions.project_id) AND the ledger read (roi_metrics.project_id)
	 * narrow to it, so switching projects re-scopes the ROI figure instead of returning workspace-wide
	 * data. ABSENT/blank => no project filter (the prior workspace-wide behaviour; back-compat).
	 */
	readonly projectId?: string;
	/**
	 * The `read_policy` the ledger read is scoped through (`isolated` | `shared` | `group`, e-AC-12).
	 * Defaults to `shared` so the LOCAL dashboard shows the ACROSS-DEVICE aggregate (the whole point of
	 * the shared ledger); a caller may pin `isolated` to see only this machine. `buildRoiReadScopeSql`
	 * fails closed to `isolated` on an unknown value.
	 */
	readonly readPolicy?: string;
	/**
	 * The 060c infra-cost read-model (the SOLE billing egress + creds holder). INJECTED so a test drives
	 * the assembly without touching the network; production passes the daemon's singleton. ABSENT → a
	 * fresh `createInfraCostReadModel()` (which is itself fail-soft → `unauthenticated`/`unreachable`).
	 */
	readonly infra?: InfraCostReadModel_API;
	/**
	 * The 060d skillify usage source (the live meter, or a static snapshot in tests). ABSENT → the
	 * empty source (no own-inference metered yet → an `absent` Haiku contribution, never a fake `$0`).
	 */
	readonly usage?: SkillifyUsageSource;
}

/** The default read policy for the LOCAL dashboard — `shared` so the figure aggregates across devices (e-AC-12). */
const DEFAULT_ROI_READ_POLICY = "shared" as const;

/** Map 060c's billing status / 060d's pollination status onto the contract's section status (one vocabulary). */
function roiSectionStatusFor(status: PollinationStatus | "ok" | "partial" | "unreachable" | "unauthenticated"): RoiView["infra"]["status"] {
	// 060d's `measured` (Haiku-ok) maps to `ok` at the section level; everything else is 1:1.
	if (status === "measured") return "ok";
	return status;
}

/**
 * Coerce a stored BIGINT token count to the 060b `CapturedTurn` shape: a SQL NULL (absent —
 * the column was never produced) MUST stay `null`, NOT collapse to `0`-as-measured (a-AC-6 /
 * b-AC-7). A real integer `0` (nothing read from cache) is a measured zero and is preserved.
 */
function tokenCountOrNull(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Map one `sessions` row (060a token columns) to a 060b {@link CapturedTurn}, preserving NULL=absent.
 *
 * PRD-060 ROI fix: the per-turn `model` (and the `provider` it implies) now ride along so
 * `resolveRate(turn.provider, turn.model)` prices the turn at its REAL model's rate instead of the
 * Sonnet default. `model` is set ONLY when the column carried a non-empty id ('' = "model unknown");
 * `provider` is `"anthropic"` when the turn was captured by Claude Code (`source_tool === "claude-code"`)
 * or the model id starts with `"claude-"` — otherwise both stay undefined and `resolveRate` falls back
 * to the conservative default. The rate table keys on (`provider`, `model`), so BOTH must be present
 * for a non-default rate to resolve.
 */
function rowToCapturedTurn(r: StorageRow): CapturedTurn {
	const sourceTool = toStr(r.source_tool);
	const model = toStr(r.model);
	const isAnthropic = sourceTool === "claude-code" || model.startsWith("claude-");
	return {
		input_tokens: tokenCountOrNull(r.input_tokens),
		output_tokens: tokenCountOrNull(r.output_tokens),
		cache_read_input_tokens: tokenCountOrNull(r.cache_read_input_tokens),
		cache_creation_input_tokens: tokenCountOrNull(r.cache_creation_input_tokens),
		...(model !== "" ? { model } : {}),
		...(model !== "" && isAnthropic ? { provider: "anthropic" } : {}),
		...(sourceTool !== "" ? { sourceTool } : {}),
	};
}

/** The max `sessions` rows the savings read folds (a defensive bound mirroring the other fetchers). */
const ROI_SESSIONS_LIMIT = 5000;

/**
 * Read the captured `sessions` token columns (060a) for the savings math. METADATA-shaped read:
 * only the four nullable token counts + `source_tool` + the per-turn `model` (PRD-060 ROI fix) —
 * never a transcript/JSONB body. Fail-soft via `selectRows` (`[]` on any non-ok result). Identifiers
 * via `sqlIdent`; no interpolated value.
 */
async function readCapturedTurns(storage: StorageQuery, scope: QueryScope, projectId?: string): Promise<CapturedTurn[]> {
	const tbl = sqlIdent("sessions");
	const dateCol = sqlIdent("creation_date");
	const idCol = sqlIdent("id");
	// PRD-049e: narrow to the selected project when one was stamped (shared spelling — see projectWhereClause).
	const projClause = projectWhereClause(projectId);
	// Identifiers inlined through `sqlIdent` directly into the template (the audit:sql floor — a
	// pre-joined `cols` variable reads as a raw interpolation to the scanner even when guarded).
	const sql =
		`SELECT ${sqlIdent("input_tokens")}, ${sqlIdent("output_tokens")}, ` +
		`${sqlIdent("cache_read_input_tokens")}, ${sqlIdent("cache_creation_input_tokens")}, ` +
		`${sqlIdent("source_tool")}, ${sqlIdent("model")} ` +
		`FROM "${tbl}"${projClause} ORDER BY ${dateCol} DESC, ${idCol} DESC LIMIT ${ROI_SESSIONS_LIMIT}`;
	const rows = await selectRows(storage, sql, scope);
	return rows.map(rowToCapturedTurn);
}

/** The known rollup dimensions + the `roi_metrics` column each groups by (e-AC-13). */
const ROLLUP_DIMENSIONS: ReadonlyArray<{ dimension: RoiRollupDimension; column: string }> = Object.freeze([
	{ dimension: "org", column: "org_id" },
	{ dimension: "team", column: "team_id" },
	{ dimension: "agent", column: "agent_id" },
	{ dimension: "project", column: "project_id" },
]);

/** Narrow a stored `cost_basis` string to the contract tag (defaulting to `none`). */
function asCostBasisTag(raw: unknown): RoiCostBasisTag {
	const s = toStr(raw);
	return s === "measured" || s === "allocated" || s === "none" ? s : "none";
}

/**
 * Compute the org / team / agent / project rollups (e-AC-13) as READ-TIME GROUP BYs in TS over
 * the canonical-per-session ledger rows (060f already resolved `MAX(created_at)` + the read_policy
 * scope). The component does NO grouping — it renders these. A rollup is flagged `mixedBasis` when
 * its rows span more than one `cost_basis` (`COUNT(DISTINCT cost_basis) > 1`, e-AC-15) so the page
 * never silently blends a measured + an allocated net.
 */
export function computeRollups(rows: readonly StorageRow[]): RoiRollup[] {
	return ROLLUP_DIMENSIONS.map(({ dimension, column }) => {
		// Group rows by the dimension key; accumulate cents + the distinct cost bases per group.
		const groups = new Map<
			string,
			{ measured: number; net: number; infra: number; sessions: number; bases: Set<RoiCostBasisTag> }
		>();
		const allBases = new Set<RoiCostBasisTag>();
		for (const r of rows) {
			const key = toStr(r[column]);
			const measured = toNum(r.measured_cache_savings_cents);
			const modeled = toNum(r.modeled_savings_cents);
			const infra = toNum(r.infra_cost_cents);
			const gross = toNum(r.gross_cost_cents);
			const basis = asCostBasisTag(r.cost_basis);
			allBases.add(basis);
			const g = groups.get(key) ?? { measured: 0, net: 0, infra: 0, sessions: 0, bases: new Set<RoiCostBasisTag>() };
			g.measured += measured;
			// Net = saved (measured + modeled) − (infra + gross cost). Integer cents throughout.
			g.net += measured + modeled - (infra + gross);
			g.infra += infra;
			g.sessions += 1;
			g.bases.add(basis);
			groups.set(key, g);
		}
		const rollupRows: RoiRollupRow[] = [...groups.entries()].map(([key, g]) => ({
			key,
			label: key,
			measuredSavingsCents: g.measured,
			netCents: g.net,
			infraCostCents: g.infra,
			// A row whose own group mixes bases is flagged `allocated` (the more-cautious tag); a single
			// basis carries through verbatim, so a measured-only row stays `measured`.
			costBasis: g.bases.size > 1 ? "allocated" : ([...g.bases][0] ?? "none"),
			sessions: g.sessions,
		}));
		return { dimension, rows: rollupRows, mixedBasis: allBases.size > 1 };
	});
}

/**
 * Fetch the composite ROI view (PRD-060e, the data half). FAIL-SOFT fan-out mirroring
 * `fetchKpisView`: it `Promise.all`s the four independent reads, never throws, and degrades to
 * `EMPTY_ROI_VIEW` on a wholesale failure. Assembles:
 *   - SAVINGS (060b): `measuredCacheSavings` + `modeledMemoryInjectionSavings` + `blendedCentsPerMtok`
 *     over the `sessions` token columns (060a). A NULL count is absent (never `0`-as-measured).
 *   - INFRA (060c): the TTL-cached billing read-model's measured infra cost + its status discriminant.
 *   - POLLINATION (060d): the composer over the live usage meter + the already-read infra snapshot
 *     (NO second billing egress).
 *   - ROLLUPS (060f): `readRoiMetrics` at the requesting agent's `read_policy` (e-AC-12), grouped
 *     org/team/agent/project in TS (e-AC-13). Per-user is GATED off (e-AC-14: `perUserAvailable=false`).
 *
 * The NET is computed ONLY when BOTH the measured savings (a real capture) AND a confident cost
 * (infra `ok`/`partial` AND pollination `ok`/`partial`) are present — a missing/unreachable input
 * leaves the net section reflecting that and the net is NOT fabricated (e-AC-6). All money is
 * INTEGER cents; modeled savings carries its assumption as data (e-AC-8); `blendedCentsPerMtok` is
 * `null` until capture is live (e-AC-11).
 */
export async function fetchRoiView(
	storage: StorageQuery,
	scope: QueryScope,
	options: FetchRoiOptions = {},
): Promise<RoiView> {
	// Finding (isolated-agentid): do NOT default the agent id to `scope.org`. The org is a TENANT
	// identifier, not an agent identity; filtering `roi_metrics.agent_id = <org>` returns the wrong
	// rows. `agentId` is the explicit requesting agent or `""` (no agent). `readRoiMetrics` FAILS CLOSED
	// to empty when an `isolated` read has no agent to pin to, rather than silently filtering on the org.
	const agentId = options.agentId !== undefined && options.agentId.trim() !== "" ? options.agentId.trim() : "";
	const readPolicy = options.readPolicy ?? DEFAULT_ROI_READ_POLICY;
	const infraModel = options.infra ?? createInfraCostReadModel();
	const usage = options.usage ?? emptyUsageSource;
	const projectId = options.projectId !== undefined && options.projectId.trim() !== "" ? options.projectId.trim() : undefined;

	// Fail-soft fan-out (parity with fetchKpisView): each read is independently guarded so one
	// failure degrades its section rather than nuking the whole view. `infraModel.read()` is itself
	// fail-soft (never throws); the captured-turns + ledger reads go through `selectRows`/`readRoiMetrics`
	// (both fail-soft). A belt-and-braces try wraps the whole assembly → EMPTY_ROI_VIEW on any surprise.
	try {
		const [turns, infra, ledger] = await Promise.all([
			readCapturedTurns(storage, scope, projectId),
			infraModel.read(),
			readRoiMetrics(storage, scope, { agentId, readPolicy, ...(projectId !== undefined ? { projectId } : {}) }),
		]);

		return assembleRoiView({ turns, infra, usage, ledger, readPolicy });
	} catch {
		// Any unexpected throw (a seam misbehaving) degrades to the honest-empty view — the daemon
		// never 500s the ROI page (parity with the rest of the dashboard read-model).
		return EMPTY_ROI_VIEW;
	}
}

/** The shape `assembleRoiView` folds (split out so the pure assembly is unit-testable without IO). */
interface RoiAssemblyInputs {
	readonly turns: readonly CapturedTurn[];
	readonly infra: InfraCostReadModel;
	readonly usage: SkillifyUsageSource;
	readonly ledger: Awaited<ReturnType<typeof readRoiMetrics>>;
	readonly readPolicy: string;
}

/**
 * Fold the four already-read inputs into the {@link RoiView} (the PURE assembly, no IO). Split from
 * {@link fetchRoiView} so a test can drive the section-status matrix (e-AC-2) deterministically.
 */
export function assembleRoiView(input: RoiAssemblyInputs): RoiView {
	const { turns, infra, usage, ledger, readPolicy } = input;

	// ── SAVINGS (060b) ──────────────────────────────────────────────────────────
	const measured = measuredCacheSavings(turns);
	const modeled = modeledMemoryInjectionSavings(turns.length);
	const blended = blendedCentsPerMtok(turns); // null until capture is live (e-AC-11).
	// 060b's CaptureStatus is `measured | partial | absent`; the section vocabulary is
	// `ok | partial | absent | …`, so a `measured` capture maps to the section status `ok`
	// (a confident, billed-fact figure) while `partial`/`absent` carry through verbatim.
	const captureStatus = measured.value.status; // measured | partial | absent (b-AC-7).
	const savingsStatus: RoiView["savings"]["status"] = captureStatus === "measured" ? "ok" : captureStatus;
	const savings: RoiView["savings"] = {
		status: savingsStatus,
		measuredCents: measured.value.savingsCents,
		modeledCents: modeled.value.estimatedCents,
		assumption: {
			kind: modeled.assumption.kind,
			assumptionText: modeled.assumption.assumptionText,
			signedOff: modeled.assumption.signedOff,
		},
		blendedCentsPerMtok: blended,
	};

	// ── INFRA (060c) ────────────────────────────────────────────────────────────
	const infraStatus = roiSectionStatusFor(infra.status);
	const infraCents = infra.summary !== undefined ? infra.summary.total_cost_cents : 0;
	const infraSection: RoiView["infra"] = {
		status: infraStatus,
		cents: infraCents,
		// Org/workspace infra read from billing is a MEASURED fact when present; otherwise no line.
		costBasis: infra.status === "ok" || infra.status === "partial" ? "measured" : "none",
	};

	// ── POLLINATION (060d) ──────────────────────────────────────────────────────
	const pollination = composePollinationCost(usage, infra);
	const pollinationLines = [
		{ label: "haiku-skillify", cents: pollination.haiku.cents },
		...pollination.deeplake.bySessionType.map((s) => ({ label: `deeplake-${s.session_type}`, cents: s.cost_cents })),
	];
	const pollinationSection: RoiView["pollination"] = {
		status: roiSectionStatusFor(pollination.status),
		cents: pollination.pollinationCents,
		lines: pollinationLines,
	};

	// ── NET (e-AC-6) — computed ONLY from complete inputs, never fabricated ───────
	// Required inputs: a real measured capture (savings ok/partial) AND a confident cost on BOTH the
	// infra and pollination halves (ok/partial, not unreachable/unauthenticated/absent). A missing
	// input leaves the net reflecting it (not `ok`) with `computed:false` and a dash on the page.
	// PRD honesty contract: a confident net (status "ok", computed true) is emitted ONLY when ALL
	// THREE inputs are FULLY confident ("ok") - savings AND infra AND pollination. A "partial" cost
	// would understate the bill and overstate net ROI (the dishonest direction), so it does NOT
	// qualify even though each section's own dash threshold tolerates partial.
	const savingsPresent = savingsStatus === "ok";
	const infraConfident = infraStatus === "ok";
	const pollinationConfident = pollinationSection.status === "ok";
	const netComputable = savingsPresent && infraConfident && pollinationConfident;
	let netSection: RoiView["net"];
	if (netComputable) {
		const netCents = measured.value.savingsCents + modeled.value.estimatedCents - (infraCents + pollination.pollinationCents);
		netSection = {
			status: "ok",
			computed: true,
			netCents,
			modeled: true, // the net folds a modeled term → ALWAYS `est.` (e-AC-3 net-hero inheritance).
			costBasis: infraSection.costBasis,
		};
	} else {
		// Reflect WHY the net is unavailable: the worst contributing reason drives the section status,
		// and `computed:false` ⇒ the page renders a dash + scoped retry, never a fabricated net.
		const reason: RoiView["net"]["status"] = !savingsPresent
			? savingsStatus
			: !infraConfident
				? infraStatus
				: pollinationSection.status;
		netSection = { status: reason, computed: false, netCents: 0, modeled: true, costBasis: "none" };
	}

	// ── ROLLUPS (060f) ──────────────────────────────────────────────────────────
	const ledgerRows = ledger.status === "ok" ? ledger.rows : [];
	const rollups = computeRollups(ledgerRows);

	return {
		savings,
		infra: infraSection,
		pollination: pollinationSection,
		net: netSection,
		rollups,
		// PER-USER GATE (e-AC-14): there is no verified backend user-claim today, so per-user is NEVER
		// available — the page shows the "per-user requires verified login" empty state, never a $0/name.
		perUserAvailable: false,
		// ACROSS-DEVICE (e-AC-12): a `shared` read returned workspace-wide rows (across devices); an
		// `isolated` read returned only this machine's. The page captions the scope from this.
		scopedAcrossDevices: readPolicy === "shared",
		ratesAsOf: RATES_AS_OF,
	};
}

/**
 * Fetch the ROI trend view (PRD-060e, e-AC-10) backing the inline-SVG chart. The trend has NO token
 * history before 060a capture started, so this is HONEST-EMPTY today: it returns `EMPTY_ROI_TREND`
 * (status `absent`) until a real history exists rather than fabricating a flat line. The `range`
 * (e.g. `30d`) is accepted for forward-compat (the window the chart will request); the assembly of a
 * real series defers to a coordinated 060a/060c history read (the trend-backfill open question).
 * FAIL-SOFT: never throws — the chart renders its honest empty state.
 */
export async function fetchRoiTrendView(
	storage: StorageQuery,
	scope: QueryScope,
	_range: string,
	_options: FetchRoiOptions = {},
): Promise<RoiTrendView> {
	// No token history exists before capture-start (the trend-backfill open question); render the
	// honest empty trend rather than a fabricated series. The signature is stable so the real history
	// read folds in here without a route/wire change.
	void storage;
	void scope;
	return EMPTY_ROI_TREND;
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
		// Two per-(scope+project) caches: the cheap COUNTS on the short TTL, the HEAVY savings SUM on a
		// longer TTL (it moves slowly). So re-landing on the home (the hash router REMOUNTS the page) skips
		// the DeepLake scans, and the expensive corpus SUM is recomputed far less often than the counts.
		// Each `mountDashboardApi` call gets its own instances (mirrors the installed-assets cache, D-1).
		const countsCache = createTtlViewCache<KpiCounts>(DIAG_TTL_MS);
		const savingsCache = createTtlViewCache<number>(SAVINGS_TTL_MS);
		// Served at `/kpis` under the diagnostics group (full `/api/diagnostics/kpis`) so the
		// canonical `/api/kpis` resource path is left to the PRD-022 product-data data-access API.
		kpis.get("/kpis", async (c) => {
			const scope = resolveScope(c);
			if (scope === null) return c.json(NO_ORG_BODY, 400);
			// PRD-049e (project-scope): honor the SELECTED project header (the SAME `resolveRequestProject`
			// the ROI read uses) so switching projects re-scopes the band. Only a REAL selection narrows;
			// a degraded resolution (no selection, no cwd — the dashboard's default) stays workspace-wide.
			const project = resolveRequestProject(c, scope);
			const projectId = project.degraded ? undefined : project.projectId;
			const key = scopeCacheKey(scope, projectId);
			const [counts, estimatedSavings] = await Promise.all([
				countsCache(key, () => fetchKpiCounts(storage, scope, projectId)),
				savingsCache(key, () => fetchEstimatedSavings(storage, scope, projectId)),
			]);
			return c.json({ ...counts, estimatedSavings });
		});
	}

	const sessions = daemon.group(DASHBOARD_GROUPS.sessions);
	if (sessions !== undefined) {
		// A short-TTL cache so the home's sessions panel (and the Logs page's pages) skip the DeepLake read
		// on re-navigation. The key includes the page coordinates (limit + cursor) so each browsable page
		// caches INDEPENDENTLY — the default panel page never collides with a deep Logs page.
		const sessionsCache = createTtlViewCache<Awaited<ReturnType<typeof fetchSessionsView>>>(DIAG_TTL_MS);
		// Served at `/sessions` under the diagnostics group (full `/api/diagnostics/sessions`).
		// PRD-043c: ADDITIVE browsable-history paging — `?limit=` (clamped) + `?cursor=` page the
		// captured turns newest-first. With no params the legacy newest-50 panel view is returned
		// (the existing dashboard `SessionsPanel` is unchanged); the Turns section on the Logs page
		// passes the params for deeper history + a `nextCursor` to load older windows.
		sessions.get("/sessions", async (c) => {
			const scope = resolveScope(c);
			if (scope === null) return c.json(NO_ORG_BODY, 400);
			const cursorRaw = c.req.query("cursor");
			const limit = resolveSessionsLimit(c.req.query("limit"));
			const before = decodeSessionsCursor(cursorRaw);
			const key = scopeCacheKey(scope, String(limit), cursorRaw);
			return c.json(await sessionsCache(key, () => fetchSessionsView(storage, scope, before !== undefined ? { limit, before } : { limit })));
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

	// `GET /api/graph` is OWNED BY `mountGraphApi` (codebase/api.ts) — the SINGLE handler for the
	// codebase-graph view. It serves the FULL `{ built, nodes, edges }` GraphView from the freshest
	// LOCAL snapshot (the authoritative copy `POST /api/graph/build` writes), so the PRD-041a "Build
	// graph" re-read is immediate + consistent. The dashboard's former DeepLake-read handler here was
	// retired to resolve the latent `/api/graph` double-registration (two handlers on one method+path
	// flapped `built:false` in live probes). This seam no longer touches the `/api/graph` group.

	// PRD-041b (D-2 / OQ-5) — the MEMORY-GRAPH read, served at `/memory-graph` off the diagnostics
	// group (full `/api/diagnostics/memory-graph`), MIRRORING the codebase graph above. Same scope
	// resolution, same fail-closed 400, same `built` contract — `built:false` until the PRD-008
	// ontology is populated. No new group, no `server.ts` edit; it inherits the group's auth/RBAC.
	const memoryGraph = daemon.group(DASHBOARD_GROUPS.memoryGraph);
	if (memoryGraph !== undefined) {
		memoryGraph.get("/memory-graph", async (c) => {
			const scope = resolveScope(c);
			if (scope === null) return c.json(NO_ORG_BODY, 400);
			return c.json(await fetchMemoryGraphView(storage, scope));
		});
	}

	const rules = daemon.group(DASHBOARD_GROUPS.rules);
	if (rules !== undefined) {
		// Short-TTL cache (workspace-scoped, no params) so the home's Rules panel skips the read on re-nav.
		const rulesCache = createTtlViewCache<Awaited<ReturnType<typeof fetchRulesView>>>(DIAG_TTL_MS);
		// Served at `/rules` under the diagnostics group (full `/api/diagnostics/rules`) so the
		// canonical `/api/rules` resource path is left to the PRD-022 product-data data-access API.
		rules.get("/rules", async (c) => {
			const scope = resolveScope(c);
			if (scope === null) return c.json(NO_ORG_BODY, 400);
			return c.json(await rulesCache(scopeCacheKey(scope), () => fetchRulesView(storage, scope)));
		});
	}

	const skills = daemon.group(DASHBOARD_GROUPS.skills);
	if (skills !== undefined) {
		// Short-TTL cache so the home's Skill-sync panel skips the storage read + disk inventory walk on re-nav.
		const skillsCache = createTtlViewCache<Awaited<ReturnType<typeof fetchSkillSyncView>>>(DIAG_TTL_MS);
		// Served at `/skills` under the diagnostics group (full `/api/diagnostics/skills`) so the
		// canonical `/api/skills` resource path is left to the PRD-022 product-data data-access API.
		skills.get("/skills", async (c) => {
			const scope = resolveScope(c);
			if (scope === null) return c.json(NO_ORG_BODY, 400);
			return c.json(await skillsCache(scopeCacheKey(scope), () => fetchSkillSyncView(storage, scope)));
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

	// PRD-060e — the composite ROI read-model + the trend series, served at `/roi` + `/roi/trend`
	// off the diagnostics group (full `/api/diagnostics/roi` + `/api/diagnostics/roi/trend`). Same
	// scope resolution + fail-closed 400 + auth/RBAC inheritance as every other dashboard view-model.
	// The page is a PURE function of the `RoiView` this returns; the daemon assembles savings (060b),
	// infra (060c), pollination (060d), and the read_policy-scoped rollups (060f). `?policy=` lets the
	// operator pin `isolated` (this-device) vs the default across-device `shared` read (e-AC-12). The
	// infra read-model + usage meter are threaded from the composition root (daemon = sole billing egress).
	const roi = daemon.group(DASHBOARD_GROUPS.roi);
	if (roi !== undefined) {
		// Finding (project-scope): read the SELECTED project header (PRD-049e -- the same
		// `x-honeycomb-project` header every other dashboard read-model honors via
		// `resolveRequestProject`) and thread it into the ROI reads so switching projects narrows the
		// figure. Only a REAL selection (`!degraded`) applies a filter; with no selection the read stays
		// workspace-wide (back-compat for a non-dashboard caller). The header carries no cwd for ROI.
		const roiOptions = (c: Context, scope: QueryScope): FetchRoiOptions => {
			const project = resolveRequestProject(c, scope);
			return {
				...(options.roiInfra !== undefined ? { infra: options.roiInfra } : {}),
				...(options.roiUsage !== undefined ? { usage: options.roiUsage } : {}),
				readPolicy: resolveRoiReadPolicy(c.req.query("policy")),
				...(!project.degraded ? { projectId: project.projectId } : {}),
			};
		};
		roi.get("/roi", async (c) => {
			const scope = resolveScope(c);
			if (scope === null) return c.json(NO_ORG_BODY, 400);
			return c.json(await fetchRoiView(storage, scope, roiOptions(c, scope)));
		});
		roi.get("/roi/trend", async (c) => {
			const scope = resolveScope(c);
			if (scope === null) return c.json(NO_ORG_BODY, 400);
			const range = c.req.query("range") ?? "";
			return c.json(await fetchRoiTrendView(storage, scope, range, roiOptions(c, scope)));
		});
	}
}

/** Resolve the ROI read policy from the optional `?policy=` query, defaulting to the across-device `shared`. */
function resolveRoiReadPolicy(raw: string | undefined): string {
	return raw === "isolated" || raw === "shared" || raw === "group" ? raw : DEFAULT_ROI_READ_POLICY;
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

/** The TTL for the short-lived diagnostics caches (KPI counts, sessions/rules/skills). Short enough that
 * a freshly-captured turn surfaces on the next load, long enough that re-navigating the home skips the
 * DeepLake scans. */
const DIAG_TTL_MS = 10_000;
/** The LONGER TTL for the estimated-savings SUM — the heaviest KPI query and a slow-moving figure, so it
 * is recomputed far less often than the cheaper counts (PRD-049e perf). */
const SAVINGS_TTL_MS = 60_000;
/** A defensive cap on distinct cache keys so a long-lived daemon cannot grow a map unboundedly. */
const CACHE_MAX_KEYS = 64;

/** A keyed, time-bounded view cache: returns a fresh-enough value for `key`, else computes + stores it. */
type TtlViewCache<T> = (key: string, compute: () => Promise<T>) => Promise<T>;

/** NUL-join the scope (+ optional extra segments) into a cache key no value can forge a boundary in. */
function scopeCacheKey(scope: QueryScope, ...extra: (string | undefined)[]): string {
	return [scope.org, scope.workspace ?? "", ...extra.map((e) => e ?? "")].join("\u0000");
}

/**
 * Build a keyed, memoizing view cache (the generalized form of the installed-assets cache). Each distinct
 * `key` caches independently for `ttlMs`; the map is bounded by {@link CACHE_MAX_KEYS} (cleared wholesale
 * when exceeded — a coarse but correct backstop for the handful of scopes a local dashboard ever touches).
 * Each `mountDashboardApi` call gets its own cache instances, so they never outlive a daemon restart.
 */
function createTtlViewCache<T>(ttlMs: number): TtlViewCache<T> {
	const cache = new Map<string, { value: T; at: number }>();
	return async (key, compute) => {
		const now = Date.now();
		const hit = cache.get(key);
		if (hit !== undefined && now - hit.at < ttlMs) return hit.value;
		const value = await compute();
		if (cache.size >= CACHE_MAX_KEYS && !cache.has(key)) cache.clear();
		cache.set(key, { value, at: now });
		return value;
	};
}

/**
 * The dashboard web app's WIRE LAYER — PRD-024 Wave 2 (AC-2..AC-6).
 *
 * The browser app is a THIN CLIENT: it hydrates entirely from the daemon's already-served
 * JSON endpoints (D-2, no canned `data.js`). This module is the single typed boundary
 * between the untyped `fetch` Response and the kit's React props:
 *
 *   - It declares a zod schema PER endpoint, mirroring the daemon-side view-model contracts
 *     in `src/dashboard/contracts.ts` (D-5 — reuse the shapes, do not re-derive them). The
 *     WIRE truth (what `src/daemon/runtime/dashboard/api.ts` + the recall/logs routes
 *     actually return) is what these schemas validate, NOT the canned `data.js` shapes.
 *   - It parses every payload through zod, so a malformed/partial response degrades to a
 *     safe empty/zero state rather than throwing into React (AC-2 empty states).
 *   - No `any` crosses the fetch boundary: each fetcher returns a typed, validated value.
 *
 * Wire endpoints (all loopback, all already served — this app NEVER rebuilds them):
 *   GET  /api/diagnostics/kpis|sessions|settings|rules|skills   → the dashboard view-models
 *   GET  /api/graph                                             → the codebase graph view
 *   POST /api/memories/recall                                   → recall hits
 *   GET  /api/logs                                              → the request-log ring buffer
 *   GET  /health                                                → daemon liveness
 *   POST /api/diagnostics/pollinate                                 → the Wave-1 Pollinate trigger
 */

import { z } from "zod";

import { EMPTY_ROI_TREND, EMPTY_ROI_VIEW, type RoiTrendView, type RoiView } from "../contracts.js";

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint paths (single source — the host serves these under the daemon origin).
// ─────────────────────────────────────────────────────────────────────────────

/** The diagnostics view-model endpoints (served under `/api/diagnostics/*` + `/api/graph`). */
export const ENDPOINTS = Object.freeze({
	kpis: "/api/diagnostics/kpis",
	sessions: "/api/diagnostics/sessions",
	settings: "/api/diagnostics/settings",
	rules: "/api/diagnostics/rules",
	skills: "/api/diagnostics/skills",
	graph: "/api/graph",
	// PRD-041a — the codebase-graph BUILD trigger (`POST /api/graph/build`). Runs the real worker
	// end-to-end and writes the LOCAL snapshot; a subsequent `GET /api/graph` returns it immediately
	// (local file, no eventual-consistency wait). On the RBAC-protected `/api/graph` group.
	graphBuild: "/api/graph/build",
	// PRD-041b — the memory-graph view-model (the knowledge graph of memories/entities). Served off
	// the diagnostics group (`/api/diagnostics/memory-graph`), mirroring `/api/graph`. Returns the SAME
	// `GraphView` shape so the existing `GraphCanvas` renders it unchanged; `built:false` until PRD-008
	// data is populated (the page shows its honest "no memory graph yet" empty state).
	memoryGraph: "/api/diagnostics/memory-graph",
	recall: "/api/memories/recall",
	// PRD-040 — the memory-management surface. `memories` is BOTH the list (GET /api/memories)
	// and the store (POST /api/memories) endpoint; `getMemory`/`modify`/`forget` are built by
	// appending `/:id`[`/modify`|`/forget`] to it. `compact` is the version-history reaper trigger.
	memories: "/api/memories",
	compact: "/api/diagnostics/compact",
	// PRD-058d — the lifecycle operator surface reads (all on the `/api/memories` session group). The
	// conflict QUEUE + stale-ref list + lifecycle-filtered audit + the 058e calibration introspection.
	// The resolve action POSTs the 058b `/api/memories/conflicts/:id/resolve` (built off `memories`).
	lifecycleConflicts: "/api/memories/conflicts",
	lifecycleStaleRefs: "/api/memories/stale-refs",
	lifecycleHistory: "/api/memories/history",
	calibration: "/api/memories/calibration",
	logs: "/api/logs",
	// PRD-042c / PRD-021d — the Server-Sent-Events follow stream off the SAME ring buffer as `logs`.
	// `GET /api/logs/stream` backfills the recent records then emits each NEW record (`event: "log"`,
	// `data: JSON.stringify(record)`). The Sync activity feed FOLLOWS this tail (c-AC-2) instead of polling.
	logsStream: "/api/logs/stream",
	// PRD-039a — the harness registry + last-seen telemetry endpoint (the data backbone the
	// Harnesses page 039b/039c reads). Served under the diagnostics group (`/api/diagnostics/harnesses`).
	harnesses: "/api/diagnostics/harnesses",
	// PRD-042 — the Sync page `installed ∪ synced` union view-model (skills + agents, each with state
	// + detail). Served under the diagnostics group (`/api/diagnostics/assets`). The five write actions
	// POST to `/api/diagnostics/sync/{promote,pull,demote,enable,disable}` (built off this base).
	assets: "/api/diagnostics/assets",
	syncAction: "/api/diagnostics/sync",
	health: "/health",
	pollinate: "/api/diagnostics/pollinate",
	// PRD-032c — the vault `setting`-class surface (Wave 1 `vault/api.ts`) + the names-only
	// secrets surface (PRD-012a `secrets/api.ts`, used ONLY for presence, never a value).
	vaultSettings: "/api/settings",
	secrets: "/api/secrets",
	// PRD-044a — the REDACTED DeepLake auth-status read-model (`auth/status-api.ts`). Metadata
	// only (org/workspace/agent/source/savedAt/expiresAt) — NO token by construction.
	authStatus: "/api/auth/status",
	// PRD-050b — the pre-auth guided-setup STATE read (`dashboard/setup-state.ts`). Local-mode-only,
	// loopback. Reports credential-dir presence + onboarding phase/prior-tool + the derived
	// `authenticated` bit + the embeddings warmup signal — install metadata only, NO token/secret.
	setupState: "/setup/state",
	// PRD-050c — the "First time setup" on-page device-flow login (`dashboard/setup-login.ts`). The
	// 050b button POSTs here; the response is the `user_code` + verification URIs (NO token).
	setupLogin: "/setup/login",
	// PRD-050d — the "Proceed with Honeycomb" migration handler (`dashboard/setup-migrate.ts`). The
	// coexistence-warning wizard POSTs here; the response carries the terminal phase + a plain-language
	// message + the backup path + `needsLogin`/`migrated` flags (NO token). `migrateRollback` is the
	// crash-recovery "Roll back" affordance (d-AC-7).
	setupMigrate: "/setup/migrate-from-hivemind",
	setupMigrateRollback: "/setup/migrate-from-hivemind/rollback",
	// PRD-049e — the dashboard scope-switcher enumeration reads (local-mode-only loopback). The
	// switcher hydrates its Org→Workspace→Project dropdowns from these. `scopeOrgs`/`scopeWorkspaces`
	// are privilege-scoped by the daemon's token (`GET /organizations` / `GET /workspaces`);
	// `scopeProjects` is the workspace's synced 049a registry copy. Changing the Org re-mints the
	// org-bound token (PRD-011) on the daemon side BEFORE enumerating the new org (49e-AC-3).
	scopeOrgs: "/api/diagnostics/scope/orgs",
	scopeWorkspaces: "/api/diagnostics/scope/workspaces",
	scopeProjects: "/api/diagnostics/scope/projects",
	// PRD-059b/059c/059d — the daemon-served folder-picker + bind surface (local-mode-only loopback,
	// mirroring the scope-enumeration reads). `fsBrowse` is the dirs-only directory browser the picker
	// renders (a browser cannot hand back an absolute path; the daemon serves the tree). `projectsBind`
	// binds a chosen absolute folder to a NEW/named project (059b); `projectsBindExisting` binds it to an
	// EXISTING registry project_id (059d import); `projectsUnbind` removes the LOCAL binding only (059c) —
	// the registry row is never touched. Every body carries paths + ids + names only — NO token/secret.
	fsBrowse: "/api/diagnostics/fs/browse",
	projectsBind: "/api/diagnostics/projects/bind",
	projectsBindExisting: "/api/diagnostics/projects/bind-existing",
	projectsUnbind: "/api/diagnostics/projects/unbind",
	// IRD-122 — the scope-switch PERSISTENCE routes (the honest counterpart to the viewer-only
	// enumeration reads). `scopeOrgSwitch` re-mints an org-bound token + persists it to the shared
	// credential (122-AC-2); `scopeWorkspaceSwitch` persists the workspace id (no re-mint). The token
	// rides ONLY in the daemon's Authorization header + credential file — the ack bodies are ids/names
	// only, NO token (D-4). These make the switcher persist a real scope change instead of a no-op.
	scopeOrgSwitch: "/api/diagnostics/scope/org-switch",
	scopeWorkspaceSwitch: "/api/diagnostics/scope/workspace-switch",
	// PRD-060e — the composite ROI read-model + the trend series. Both served off the diagnostics
	// group (`/api/diagnostics/roi` + `/api/diagnostics/roi/trend`), local-mode-only loopback like the
	// other dashboard view-models. The page is a PURE function of the `RoiView` the daemon assembles
	// (savings/infra/pollination/net + the org/team/agent/project rollups); the chart reads `roi/trend`.
	roi: "/api/diagnostics/roi",
	roiTrend: "/api/diagnostics/roi/trend",
	// Dashboard imperative actions (`dashboard/actions-api.ts`, `/api/actions` group, local-mode +
	// origin/CSRF gated). The named CLI lifecycle actions, now performable from the Settings page:
	// `logout` removes the shared DeepLake credential; `embeddings` toggles + persists the on/off
	// preference (live via the embed supervisor); `restart` respawns the daemon; `uninstall` returns
	// the guided removal (detected harnesses + the exact CLI command). No token/secret crosses any.
	actionsLogout: "/api/actions/logout",
	actionsEmbeddings: "/api/actions/embeddings",
	actionsRestart: "/api/actions/restart",
	actionsUninstall: "/api/actions/uninstall",
} as const);

/**
 * PRD-049e (49e-AC-2) — the header carrying the dashboard's SELECTED project id. The switcher's
 * selection is VIEWER-SIDE: stamping this header on a read narrows the daemon's project-segment
 * predicate to exactly that project (the daemon honors it in `resolveRequestProject`), WITHOUT
 * touching any per-folder CLI binding (49e-AC-4 — it is a request header, never a write). An empty
 * selection omits the header (the read stays project-agnostic / cwd-resolved, back-compat).
 */
export const PROJECT_HEADER = "x-honeycomb-project" as const;

/** Build the per-request project header, or an empty object when no project is selected. */
export function projectHeader(projectId: string | undefined): Record<string, string> {
	return projectId !== undefined && projectId !== "" ? { [PROJECT_HEADER]: projectId } : {};
}

/** PRD-040a — the default first-page size the Memories list requests (the daemon clamps to 500). */
export const DEFAULT_MEMORY_LIST_LIMIT = 50 as const;

// ─────────────────────────────────────────────────────────────────────────────
// Zod schemas — mirror `src/dashboard/contracts.ts` (D-5) over the WIRE truth.
// Every field defaults so a partial payload degrades to a safe empty/zero state.
// ─────────────────────────────────────────────────────────────────────────────

/** `GET /api/diagnostics/kpis` → {@link import("../contracts.js").KpisView}. */
export const KpisSchema = z.object({
	memoryCount: z.number().catch(0),
	sessionCount: z.number().catch(0),
	// PRD-035a: the honest "Turns" count (same value as `sessionCount`). `.catch(0)` tolerance so an
	// OLD daemon payload that carries only `sessionCount` degrades safely (the app falls back to it).
	turnCount: z.number().catch(0),
	estimatedSavings: z.number().catch(0),
	// PRD-036c: the team-shared skill count the "Team skills" KPI binds to. `.catch(0)` so an older
	// payload without it reads 0 rather than throwing into React.
	teamSkillCount: z.number().catch(0),
});
export type KpisWire = z.infer<typeof KpisSchema>;

/** One row of `GET /api/diagnostics/sessions` → {@link import("../contracts.js").SessionRow}. */
export const SessionRowSchema = z.object({
	sessionId: z.string().catch(""),
	project: z.string().catch(""),
	startedAt: z.string().catch(""),
	eventCount: z.number().catch(0),
	status: z.string().catch("captured"),
});
export const SessionsSchema = z.object({
	sessions: z.array(SessionRowSchema).catch([]),
});
export type SessionRowWire = z.infer<typeof SessionRowSchema>;

/** `GET /api/diagnostics/settings` → {@link import("../contracts.js").SettingsView}. */
export const SettingsSchema = z.object({
	orgId: z.string().catch(""),
	orgName: z.string().catch(""),
	workspace: z.string().catch(""),
	settings: z.record(z.string(), z.string()).catch({}),
});
export type SettingsWire = z.infer<typeof SettingsSchema>;

/** A graph node/edge → {@link import("../contracts.js").GraphNode} / `GraphEdge`. */
export const GraphNodeSchema = z.object({
	id: z.string().catch(""),
	label: z.string().catch(""),
	kind: z.string().catch(""),
});
export const GraphEdgeSchema = z.object({
	from: z.string().catch(""),
	to: z.string().catch(""),
	kind: z.string().catch(""),
});
/** Bounded-view metadata → {@link import("../contracts.js").GraphViewMeta} (the graph memory cap — the graph cap). */
export const GraphMetaSchema = z.object({
	totalNodes: z.number().catch(0),
	totalEdges: z.number().catch(0),
	shownNodes: z.number().catch(0),
	shownEdges: z.number().catch(0),
	truncated: z.boolean().catch(false),
});
export const GraphSchema = z.object({
	built: z.boolean().catch(false),
	nodes: z.array(GraphNodeSchema).catch([]),
	edges: z.array(GraphEdgeSchema).catch([]),
	// Optional + fail-soft: a malformed/absent `meta` degrades to undefined, never nuking the graph.
	meta: GraphMetaSchema.optional().catch(undefined),
});
export type GraphWire = z.infer<typeof GraphSchema>;

/** One rule of `GET /api/diagnostics/rules` → {@link import("../contracts.js").RuleRow}. */
export const RuleRowSchema = z.object({
	id: z.string().catch(""),
	title: z.string().catch(""),
	active: z.boolean().catch(false),
});
export const RulesSchema = z.object({
	rules: z.array(RuleRowSchema).catch([]),
});
export type RuleRowWire = z.infer<typeof RuleRowSchema>;

/** One skill of `GET /api/diagnostics/skills` → {@link import("../contracts.js").SkillSyncRow}. */
export const SkillRowSchema = z.object({
	name: z.string().catch(""),
	scope: z.string().catch(""),
	syncState: z.string().catch("pending"),
});
export const SkillsSchema = z.object({
	skills: z.array(SkillRowSchema).catch([]),
});
export type SkillRowWire = z.infer<typeof SkillRowSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// PRD-060e — the composite ROI view-model + the trend series. Mirrors the daemon
// contracts in `src/dashboard/contracts.ts` (`RoiView` / `RoiTrendView`) over the
// WIRE truth `src/daemon/runtime/dashboard/api.ts` returns. Every money field is
// INTEGER cents (`z.number().int()` — a float-cents value is `.catch()`-rejected to a
// safe integer, so a test asserts NO float-cents survives the wire schema, e-AC-11);
// every per-section status discriminant `.catch()`-defaults to the SAFE degraded value
// (`'absent'` for the data sections, `'unreachable'` for billing-backed lines) so a
// partial/malformed payload degrades honestly rather than throwing into React (e-AC-2).
// NO secret rides these shapes by construction (numbers + labels + status enums only).
// ─────────────────────────────────────────────────────────────────────────────

/** Integer-cents wire field (e-AC-11): a present-but-float/garbage value degrades to `0`, never a float. */
const roiCentsField = z.number().int().catch(0);

/** The per-section status discriminant → {@link import("../contracts.js").RoiSectionStatus}. */
export const RoiSectionStatusSchema = z
	.enum(["ok", "partial", "absent", "unreachable", "unauthenticated"])
	.catch("absent");
/** The status default for a BILLING-backed line — `unreachable` (couldn't read), not `absent` (no data). */
export const RoiBillingStatusSchema = z
	.enum(["ok", "partial", "absent", "unreachable", "unauthenticated"])
	.catch("unreachable");
/** The cost-basis tag → {@link import("../contracts.js").RoiCostBasisTag}. */
export const RoiCostBasisSchema = z.enum(["measured", "allocated", "none"]).catch("none");

/** The modeled assumption carried as data (e-AC-8) → {@link import("../contracts.js").RoiAssumption}. */
export const RoiAssumptionSchema = z.object({
	kind: z.string().catch(""),
	assumptionText: z.string().catch(""),
	signedOff: z.boolean().catch(false),
});

/** The savings section (e-AC-3) → {@link import("../contracts.js").RoiSavingsSection}. */
export const RoiSavingsSectionSchema = z.object({
	status: RoiSectionStatusSchema,
	measuredCents: roiCentsField,
	modeledCents: roiCentsField,
	assumption: RoiAssumptionSchema.catch({ kind: "", assumptionText: "", signedOff: false }),
	// `null` until token capture is live (e-AC-11) — a present-but-float value degrades to null, never a float.
	blendedCentsPerMtok: z.number().int().nullable().catch(null),
});

/** The infra cost section (e-AC-6) → {@link import("../contracts.js").RoiInfraSection}. */
export const RoiInfraSectionSchema = z.object({
	status: RoiBillingStatusSchema,
	cents: roiCentsField,
	costBasis: RoiCostBasisSchema,
});

/** One pollination split line → {@link import("../contracts.js").RoiPollinationLine}. */
export const RoiPollinationLineSchema = z.object({
	label: z.string().catch(""),
	cents: roiCentsField,
});

/** The pollination cost section (e-AC-6) → {@link import("../contracts.js").RoiPollinationSection}. */
export const RoiPollinationSectionSchema = z.object({
	status: RoiBillingStatusSchema,
	cents: roiCentsField,
	lines: z.array(RoiPollinationLineSchema).catch([]),
});

/** The net-ROI section (e-AC-6) → {@link import("../contracts.js").RoiNetSection}. */
export const RoiNetSectionSchema = z.object({
	status: RoiSectionStatusSchema,
	// `computed:false` ⇒ the page renders a dash, NOT the number (e-AC-6 net-not-fabricated).
	computed: z.boolean().catch(false),
	netCents: roiCentsField,
	// The net folds a modeled term → ALWAYS `est.` (e-AC-3). Defaults TRUE (safe: treat as estimate).
	modeled: z.boolean().catch(true),
	costBasis: RoiCostBasisSchema,
});

/** One rollup row → {@link import("../contracts.js").RoiRollupRow}. */
export const RoiRollupRowSchema = z.object({
	key: z.string().catch(""),
	label: z.string().catch(""),
	measuredSavingsCents: roiCentsField,
	netCents: roiCentsField,
	infraCostCents: roiCentsField,
	costBasis: RoiCostBasisSchema,
	sessions: z.number().int().catch(0),
});

/** One rollup view (e-AC-13) → {@link import("../contracts.js").RoiRollup}. */
export const RoiRollupSchema = z.object({
	dimension: z.enum(["org", "team", "agent", "project"]).catch("org"),
	rows: z.array(RoiRollupRowSchema).catch([]),
	mixedBasis: z.boolean().catch(false),
});

/** `GET /api/diagnostics/roi` → {@link import("../contracts.js").RoiView}. */
export const RoiViewSchema = z.object({
	savings: RoiSavingsSectionSchema.catch({
		status: "absent",
		measuredCents: 0,
		modeledCents: 0,
		assumption: { kind: "", assumptionText: "", signedOff: false },
		blendedCentsPerMtok: null,
	}),
	infra: RoiInfraSectionSchema.catch({ status: "unreachable", cents: 0, costBasis: "none" }),
	pollination: RoiPollinationSectionSchema.catch({ status: "unreachable", cents: 0, lines: [] }),
	net: RoiNetSectionSchema.catch({ status: "absent", computed: false, netCents: 0, modeled: true, costBasis: "none" }),
	rollups: z.array(RoiRollupSchema).catch([]),
	// Per-user is gated off until verified backend claims land (e-AC-14) — defaults FALSE (safe: empty state).
	perUserAvailable: z.boolean().catch(false),
	scopedAcrossDevices: z.boolean().catch(false),
	ratesAsOf: z.string().catch(""),
});
export type RoiViewWire = z.infer<typeof RoiViewSchema>;

/** One trend point (e-AC-10) → {@link import("../contracts.js").RoiTrendPoint}. */
export const RoiTrendPointSchema = z.object({
	period: z.string().catch(""),
	cents: roiCentsField,
});

/** One trend series (e-AC-10, dashed=modeled / solid=measured) → {@link import("../contracts.js").RoiTrendSeries}. */
export const RoiTrendSeriesSchema = z.object({
	label: z.string().catch(""),
	modeled: z.boolean().catch(false),
	points: z.array(RoiTrendPointSchema).catch([]),
});

/** `GET /api/diagnostics/roi/trend` → {@link import("../contracts.js").RoiTrendView}. */
export const RoiTrendViewSchema = z.object({
	status: RoiSectionStatusSchema,
	series: z.array(RoiTrendSeriesSchema).catch([]),
	startedAt: z.string().catch(""),
});
export type RoiTrendViewWire = z.infer<typeof RoiTrendViewSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// PRD-042 — the Sync page union view-model (skills + agents) + the action acks.
// Every field defaults so a partial/malformed payload degrades to a safe state,
// NEVER a throw into React. NO secret rides these shapes by construction: no
// `native` blob, no author email, no org GUID — only presentation-safe fields +
// the `authoredByMe` boolean (the daemon derives it from the opaque author token).
// ─────────────────────────────────────────────────────────────────────────────

/** One union row on the wire (mirrors the daemon `AssetSyncRow`). State badges drive off `state`. */
export const AssetSyncRowSchema = z.object({
	assetType: z.enum(["skill", "agent"]).catch("skill"),
	name: z.string().catch(""),
	description: z.string().catch(""),
	state: z.enum(["local", "pulled", "shared"]).catch("local"),
	scope: z.string().catch(""),
	sourceHarness: z.string().catch(""),
	tier: z.string().catch(""),
	style: z.string().catch(""),
	version: z.number().catch(0),
	honeycombId: z.string().catch(""),
	// The page disables Demote when this is false (parent OQ-4) — the author TOKEN is never carried,
	// only this boolean. `.catch(false)` so an older daemon (no field) reads "not author" (safe-closed).
	authoredByMe: z.boolean().catch(false),
});
export type AssetSyncRowWire = z.infer<typeof AssetSyncRowSchema>;

/** `GET /api/diagnostics/assets` → `{ skills, agents }`. A bad shape degrades to empty lists. */
export const AssetSyncViewSchema = z.object({
	skills: z.array(AssetSyncRowSchema).catch([]),
	agents: z.array(AssetSyncRowSchema).catch([]),
});
export type AssetSyncViewWire = z.infer<typeof AssetSyncViewSchema>;

/** A sync-action ack (mirrors the daemon `SyncActionResult`). Carries NO blob/secret — id/state/version. */
export const SyncActionResultSchema = z.object({
	ok: z.boolean().catch(false),
	action: z.enum(["promote", "pull", "demote", "enable", "disable"]).catch("promote"),
	assetType: z.enum(["skill", "agent"]).catch("skill"),
	honeycombId: z.string().catch(""),
	state: z.enum(["local", "pulled", "shared", ""]).catch(""),
	version: z.number().catch(0),
});
export type SyncActionResultWire = z.infer<typeof SyncActionResultSchema>;

/** The empty union view the page shows before the first load resolves (or on failure). */
export const EMPTY_ASSET_SYNC_VIEW: AssetSyncViewWire = Object.freeze({ skills: [], agents: [] });

/**
 * One recall hit on the wire — the `/api/memories/recall` response shape from
 * `src/daemon/runtime/memories/recall.ts`. PRD-027 Wave 1 made the hit carry a REAL
 * `{ source, id, text, score, kind, secondary }`: `score` is the fused RRF relevance
 * (the engine already emits hits ranked DESC by it), `kind` is the provenance class
 * (`"memory"` distilled vs `"session"` raw dump), and `secondary` is `true` iff the hit
 * is a drill-down raw session row. The client renders the ENGINE score + ENGINE order —
 * it NEVER fabricates a score (D-4 / AC-4 removed the old `1 - i*0.06` synthesis).
 *
 * The score/kind/secondary fields `.catch()` to safe defaults so an OLDER daemon that
 * predates Wave 1 (no score on the wire) still renders (degrade gracefully). The LIVE
 * daemon now always sends them. The kit's `MemoryCard` wants
 * `{ memoryKey, snippet, source, score, scope, verified }`; we MAP the wire hit to those
 * props in {@link recall} (id→memoryKey, text→snippet, ENGINE `score`→score, the arm name→
 * scope hint, `kind`/`secondary`→the distilled-vs-drill-down demotion).
 */
export const RecallHitSchema = z.object({
	source: z.string().catch(""),
	id: z.string().catch(""),
	text: z.string().catch(""),
	// PRD-027 Wave 1 (AC-4): the ENGINE's fused relevance + provenance. `.catch()` defaults
	// keep an older daemon (pre-score) renderable — a missing score degrades to 0, not a throw.
	score: z.number().catch(0),
	kind: z.enum(["memory", "session"]).catch("memory"),
	secondary: z.boolean().catch(false),
});
export const RecallResponseSchema = z.object({
	hits: z.array(RecallHitSchema).catch([]),
	sources: z.array(z.string()).catch([]),
	degraded: z.boolean().catch(true),
});

/** A rendered recalled memory (the shape the `MemoryCard` consumes). */
export interface RecalledMemory {
	readonly memoryKey: string;
	readonly snippet: string;
	readonly source: string;
	/** The ENGINE's fused RRF relevance score (NOT a client fabrication — PRD-027 AC-4). */
	readonly score: number;
	readonly scope: string;
	readonly verified: boolean;
	/** Provenance class from the engine: distilled `"memory"` vs raw-dump `"session"`. */
	readonly kind: "memory" | "session";
	/** `true` iff a drill-down raw session row (the card visually demotes these). */
	readonly secondary: boolean;
}

/**
 * PRD-040 — one memory row on the wire. MIRRORS the daemon read-model
 * `src/daemon/runtime/memories/reads.ts` `MemoryRecord` (the original thin shape PLUS the
 * OQ-1 additive detail metadata). Every field `.catch()`-defaults so a partial/older payload —
 * a daemon serving only the thin `{ id, type, content, confidence, agentId, createdAt,
 * updatedAt }`, or a malformed body — degrades to a safe value rather than throwing into React.
 * The five OQ-1 fields (`visibility`/`sourceType`/`sourceId`/`version`/`hasEmbedding`) are
 * `.catch()`-defaulted EXACTLY so an older/thin daemon still renders the detail view (with those
 * fields blank/false). No secret rides this shape — scope tag, provenance, a version, a boolean.
 */
export const MemoryRecordSchema = z.object({
	id: z.string().catch(""),
	type: z.string().catch(""),
	content: z.string().catch(""),
	confidence: z.number().catch(0),
	agentId: z.string().catch(""),
	createdAt: z.string().catch(""),
	updatedAt: z.string().catch(""),
	// OQ-1 additive metadata — `.catch()`-defaulted so the thin shape still parses.
	visibility: z.string().catch(""),
	sourceType: z.string().catch(""),
	sourceId: z.string().catch(""),
	version: z.number().catch(0),
	hasEmbedding: z.boolean().catch(false),
});
export type MemoryRecordWire = z.infer<typeof MemoryRecordSchema>;

/** `GET /api/memories` body: `{ memories: MemoryRecord[] }`. A bad shape degrades to `[]`. */
export const MemoryListResponseSchema = z.object({
	memories: z.array(MemoryRecordSchema).catch([]),
});

/** `GET /api/memories/:id` body: `{ memory: MemoryRecord }`. A 404 is handled at the call site (→ null). */
export const MemoryGetResponseSchema = z.object({
	memory: MemoryRecordSchema,
});

/** `POST /api/memories` (store) ack: `{ id, action }` (201). `id` is null when the daemon dedup-skips. */
export const StoreAckSchema = z.object({
	id: z.string().nullable().catch(null),
	action: z.string().catch(""),
});
export type StoreAckWire = z.infer<typeof StoreAckSchema>;

/** `POST /api/memories/:id/modify` + `/forget` ack: `{ id, action, audited }`. */
export const WriteAckSchema = z.object({
	id: z.string().nullable().catch(null),
	action: z.string().catch(""),
	audited: z.boolean().catch(false),
});
export type WriteAckWire = z.infer<typeof WriteAckSchema>;

/**
 * PRD-040c — one per-table compaction summary on the wire, MIRRORING the daemon
 * `CompactTableResult` (`src/daemon/runtime/maintenance/compact-api.ts`): the table name + the
 * reap counts + an `errored` count (>0 ⇒ "attempted, not completed"). Every field `.catch()`es
 * so a partial body still renders. No secret — table names + integer counts only.
 */
export const CompactTableResultSchema = z.object({
	table: z.string().catch(""),
	keysScanned: z.number().catch(0),
	keysCompacted: z.number().catch(0),
	rowsReaped: z.number().catch(0),
	keysSkipped: z.number().catch(0),
	errored: z.number().catch(0),
});
export type CompactTableResultWire = z.infer<typeof CompactTableResultSchema>;

/** `POST /api/diagnostics/compact` body: `{ ok, summaries, skippedTables }`. Degrades to an empty summary. */
export const CompactSummarySchema = z.object({
	ok: z.boolean().catch(false),
	summaries: z.array(CompactTableResultSchema).catch([]),
	skippedTables: z.array(z.string()).catch([]),
});
export type CompactSummaryWire = z.infer<typeof CompactSummarySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// PRD-058d — the lifecycle operator-surface wire shapes. Every field `.catch()`-
// defaults so a partial/older/malformed payload degrades to a safe value (never a
// throw into React). No secret rides these shapes — ids, an enum verdict/status, a
// bounded score, a ref string, an ISO timestamp, the calibration metrics.
// ─────────────────────────────────────────────────────────────────────────────

/** One conflict row from `GET /api/memories/conflicts` (the pair + verdict + status). */
export const LifecycleConflictSchema = z.object({
	id: z.string().catch(""),
	memoryAId: z.string().catch(""),
	memoryBId: z.string().catch(""),
	verdict: z.string().catch("review"),
	winnerId: z.string().nullable().catch(null),
	status: z.string().catch("open"),
	contraScore: z.number().catch(0),
});
export type LifecycleConflictWire = z.infer<typeof LifecycleConflictSchema>;
export const LifecycleConflictsResponseSchema = z.object({
	conflicts: z.array(LifecycleConflictSchema).catch([]),
	status: z.string().catch("open"),
});

/** One stale-ref row from `GET /api/memories/stale-refs` (the memory id + its unresolved refs). */
export const LifecycleStaleRefSchema = z.object({
	memoryId: z.string().catch(""),
	refStatus: z.string().catch("stale"),
	staleRefs: z.array(z.string()).catch([]),
	verifiedAt: z.string().nullable().catch(null),
});
export type LifecycleStaleRefWire = z.infer<typeof LifecycleStaleRefSchema>;
export const LifecycleStaleRefsResponseSchema = z.object({
	staleRefs: z.array(LifecycleStaleRefSchema).catch([]),
});

/** One lifecycle audit row from `GET /api/memories/history?type=lifecycle`. */
export const LifecycleHistorySchema = z.object({
	id: z.string().catch(""),
	memoryId: z.string().catch(""),
	actor: z.string().catch("pipeline"),
	operation: z.string().catch(""),
	reason: z.string().catch(""),
	confidence: z.number().catch(0),
	timestamp: z.string().catch(""),
});
export type LifecycleHistoryWire = z.infer<typeof LifecycleHistorySchema>;
export const LifecycleHistoryResponseSchema = z.object({
	history: z.array(LifecycleHistorySchema).catch([]),
	type: z.string().catch("lifecycle"),
});

/** One reliability-diagram bin from `GET /api/memories/calibration` (the 058e introspection payload). */
export const ReliabilityBinSchema = z.object({
	lower: z.number().catch(0),
	upper: z.number().catch(0),
	meanConfidence: z.number().catch(0),
	accuracy: z.number().catch(0),
	count: z.number().catch(0),
});
export type ReliabilityBinWire = z.infer<typeof ReliabilityBinSchema>;

/** The `GET /api/memories/calibration` body (ece/brier/n_samples + reliability diagram, 058e). */
export const CalibrationSchema = z.object({
	ece: z.number().catch(0),
	brier: z.number().catch(0),
	nSamples: z.number().catch(0),
	fitAt: z.string().nullable().catch(null),
	identity: z.boolean().catch(true),
	reliabilityDiagram: z.array(ReliabilityBinSchema).catch([]),
});
export type CalibrationWire = z.infer<typeof CalibrationSchema>;

/** The cold-start calibration view the panel shows before the first load (or on failure). */
export const EMPTY_CALIBRATION: CalibrationWire = Object.freeze({
	ece: 0,
	brier: 0,
	nSamples: 0,
	fitAt: null,
	identity: true,
	reliabilityDiagram: [],
});

/** One `/api/logs` record (the `RequestLogRecord` the ring buffer serves; no secret in it). */
export const LogRecordSchema = z.object({
	time: z.string().catch(""),
	method: z.string().catch(""),
	path: z.string().catch(""),
	status: z.number().catch(0),
	durationMs: z.number().optional(),
	mode: z.string().optional(),
	org: z.string().optional(),
	workspace: z.string().optional(),
});
export const LogsResponseSchema = z.object({
	records: z.array(LogRecordSchema).catch([]),
	count: z.number().catch(0),
});
export type LogRecordWire = z.infer<typeof LogRecordSchema>;

/**
 * PRD-043a/043b — `GET /api/logs/history` body: the durable, filterable, paginated request-log
 * history (newest first) + the next-page cursor. MIRRORS the daemon `LogsHistoryResponse`
 * (`src/daemon/runtime/logs/api.ts`). Reuses the SAME secret-free {@link LogRecordSchema} as the
 * live snapshot, so the history table and the live tail share ONE row shape and never drift. Every
 * field `.catch()`-defaults so a partial/older payload degrades to a safe empty page (never a throw
 * into React). `nextCursor` is null on the last page; `persistent:false` means history is
 * unavailable (the store could not open — the page shows its honest empty/unavailable state).
 */
export const LogsHistoryResponseSchema = z.object({
	records: z.array(LogRecordSchema).catch([]),
	count: z.number().catch(0),
	nextCursor: z.string().nullable().catch(null),
	persistent: z.boolean().catch(false),
});
export type LogsHistoryWire = z.infer<typeof LogsHistoryResponseSchema>;

/** The fixed, validated filter set the Logs history table drives the `/api/logs/history` query with. */
export interface LogsHistoryFilters {
	/** Lower time bound (inclusive), ISO-8601. */
	readonly since?: string;
	/** Upper time bound (inclusive), ISO-8601. */
	readonly until?: string;
	/** Exact status (`404`) or a class (`5xx`/`4xx`/`2xx`). */
	readonly status?: string;
	/** Path exact-or-prefix filter. */
	readonly path?: string;
	/** Org/harness filter (exact). */
	readonly org?: string;
	/** Page size (clamped daemon-side to `MAX_HISTORY_LIMIT`). */
	readonly limit?: number;
	/** The opaque pagination cursor (page strictly before this — older window). */
	readonly cursor?: string;
}

/**
 * PRD-043c — `GET /api/diagnostics/sessions` (paged) body: the browsable captured-TURNS history +
 * the next-page cursor. Reuses the SAME {@link SessionRowSchema} as the legacy sessions view (so the
 * Turns list and the dashboard panel share one row shape). Every field `.catch()`-defaults so a
 * partial/older daemon payload (one WITHOUT `nextCursor`) degrades to a safe page with no further
 * cursor, never a throw. The page LABELS these "Turns" (PRD-035a); the storage table stays `sessions`.
 */
export const TurnsHistoryResponseSchema = z.object({
	sessions: z.array(SessionRowSchema).catch([]),
	nextCursor: z.string().nullable().catch(null),
});
export type TurnsHistoryWire = z.infer<typeof TurnsHistoryResponseSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// PRD-039 — the harness registry + last-seen telemetry (the data backbone). Mirrors
// `src/daemon/runtime/dashboard/harness-api.ts` (`HarnessStatus`) + the folded 039c
// capability descriptor. Every field defaults so a partial/malformed payload degrades
// to a safe zeroed state, NEVER a throw into React (AC-8 defensive parsing). NO secret
// rides this shape by construction — ids, booleans, a count, an ISO timestamp, statics.
// ─────────────────────────────────────────────────────────────────────────────

/** Cursor's `cursor-agent` agents descriptor (039c) — present for Cursor, absent for Claude Code. */
export const HarnessAgentsSchema = z.object({
	kind: z.string().catch(""),
	binary: z.string().catch(""),
	fallbackBin: z.string().optional(),
});

/** One harness's host-CLI descriptor (mirrors the shim `HostCli`). */
export const HarnessHostCliSchema = z.object({
	bin: z.string().catch(""),
	args: z.array(z.string()).catch([]),
	fallbackBin: z.string().optional(),
});

/**
 * The data-driven capability descriptor folded into each `HarnessStatus` server-side (039c / c-OQ-2).
 * The OPTIONAL fields are the genuine shim divergences — a missing field omits that harness's panel
 * on the detail page (c-AC-3), never a blank. Each field `.catch()`es so a partial body still renders.
 */
export const HarnessCapabilitiesSchema = z.object({
	name: z.string().catch(""),
	runtimePath: z.string().catch(""),
	contextChannel: z.string().catch(""),
	hostCli: HarnessHostCliSchema.catch({ bin: "", args: [] }),
	lifecycleEvents: z.array(z.string()).catch([]),
	agents: HarnessAgentsSchema.optional(),
	workspaceRoots: z.boolean().optional(),
	mcpRegistration: z.boolean().optional(),
	contractedTools: z.boolean().optional(),
	agentsMdContext: z.boolean().optional(),
	userVisibleLogin: z.boolean().optional(),
});
export type HarnessCapabilitiesWire = z.infer<typeof HarnessCapabilitiesSchema>;

/** One harness's status row (mirrors the daemon `HarnessStatus`). `lastSeen` is null when never seen. */
export const HarnessStatusSchema = z.object({
	name: z.string().catch(""),
	installed: z.boolean().catch(false),
	active: z.boolean().catch(false),
	lastSeen: z.string().nullable().catch(null),
	turnsCaptured: z.number().catch(0),
	runtimePath: z.string().catch(""),
	capabilities: HarnessCapabilitiesSchema.catch({
		name: "",
		runtimePath: "",
		contextChannel: "",
		hostCli: { bin: "", args: [] },
		lifecycleEvents: [],
	}),
});
export const HarnessStatusResponseSchema = z.object({
	harnesses: z.array(HarnessStatusSchema).catch([]),
});
export type HarnessStatusWire = z.infer<typeof HarnessStatusSchema>;

/** The Wave-1 Pollinate ack (`POST /api/diagnostics/pollinate` → 202 + this body). */
export const PollinateAckSchema = z.object({
	triggered: z.boolean().catch(false),
	status: z.string().catch("skipped"),
	reason: z.string().optional(),
});
export type PollinateAck = z.infer<typeof PollinateAckSchema>;

/**
 * The `POST /api/graph/build` ack (the codebase-graph build worker's data body). The daemon runs the
 * REAL worker end-to-end — discover → tree-sitter extract → aggregate → finalize → write the LOCAL
 * snapshot — and returns `{ built, snapshotSha256, nodeCount, edgeCount, fileCount, parseErrorCount,
 * cacheStats, localPath, push }`. We only validate the four fields the UI needs (`built` + the counts);
 * the rest of the body is ignored (zod drops extra keys). Every field `.catch()`-defaults so the 500
 * error body (`{ error, reason }`) — or any malformed/partial payload — degrades to a safe
 * `{ built: false, … }` ack rather than throwing into React (the page surfaces an honest inline error).
 */
export const BuildGraphAckSchema = z.object({
	built: z.boolean().catch(false),
	nodeCount: z.number().catch(0),
	edgeCount: z.number().catch(0),
	fileCount: z.number().catch(0),
});
export type BuildGraphAck = z.infer<typeof BuildGraphAckSchema>;

/**
 * The honest failure ack the wire returns when the build POST is rejected, times out, or the body is
 * malformed (never a throw into React). The page keeps its empty state + shows the inline error line.
 */
export const FAILED_BUILD_GRAPH_ACK: BuildGraphAck = Object.freeze({ built: false, nodeCount: 0, edgeCount: 0, fileCount: 0 });

/**
 * The generous client-side timeout (ms) for `buildGraph()`. The build parses the WHOLE repo with
 * tree-sitter and can take many seconds to tens of seconds; a short default fetch timeout would abort
 * a legitimate in-progress build. 120s gives the worker ample headroom — well past the realistic build
 * time — while still bounding a truly hung request so the button never spins forever.
 */
export const BUILD_GRAPH_TIMEOUT_MS = 120_000 as const;

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard imperative actions (`/api/actions/*`) — logout / embeddings / restart / uninstall.
// Each ack body carries booleans / ids / a command string only; NO token/secret by construction.
// ─────────────────────────────────────────────────────────────────────────────

/** The `POST /api/actions/logout` ack (`{ ok }`). */
export const ActionOkSchema = z.object({ ok: z.boolean().catch(false) });

/**
 * The `POST /api/actions/embeddings` ack: `{ ok, enabled }` (the new persisted on/off state). Both
 * fields are STRICT (no `.catch` default): a malformed/partial body must FAIL the parse → `postJson`
 * returns null → `setEmbeddings` reports failure. Defaulting `enabled` to `false` would let a
 * `setEmbeddings(false)` call falsely "succeed" against a response that never echoed the real state.
 */
export const EmbeddingsActionSchema = z.object({ ok: z.boolean(), enabled: z.boolean() });

/** The `POST /api/actions/restart` ack: `{ ok, restarting }`. */
export const RestartActionSchema = z.object({ ok: z.boolean().catch(false), restarting: z.boolean().catch(false) });

/** The `POST /api/actions/uninstall` result: detected harnesses + the exact CLI command + a note. */
export const UninstallResultSchema = z.object({
	ok: z.boolean().catch(false),
	harnesses: z.array(z.string()).catch([]),
	removed: z.boolean().catch(false),
	command: z.string().catch("honeycomb uninstall"),
	note: z.string().catch(""),
});
/** The validated uninstall result the page renders honestly (paths/ids/command only — no secret). */
export type UninstallResultWire = z.infer<typeof UninstallResultSchema>;

/**
 * The PRD-029 per-subsystem `/health` `reasons` block (D-2 render). This MIRRORS the
 * Wave-1 daemon contract `HealthReasons` in `src/daemon/runtime/health.ts` verbatim — a
 * closed enum per subsystem, NO secret (D-5: no token/org/endpoint/header rides these,
 * only subsystem names + coarse states). The dashboard is LOCAL-mode so the daemon's
 * `/health` body carries this block; on a non-local public body it is absent (the strip
 * renders nothing — handled at the call site by a `null` reasons).
 *
 * Each field `.catch()`es to its HEALTHY value so a malformed/partial `reasons` degrades
 * to "looks ok" rather than throwing into React — the body crosses the untyped IO boundary
 * exactly like every other endpoint here. An UNKNOWN enum value (a future daemon adds a
 * state) also `.catch()`es to the healthy default, never a throw.
 */
export const HealthReasonsSchema = z.object({
	storage: z.enum(["reachable", "unreachable"]).catch("reachable"),
	embeddings: z.enum(["on", "off"]).catch("on"),
	schema: z.enum(["ok", "missing_table"]).catch("ok"),
});
export type HealthReasonsWire = z.infer<typeof HealthReasonsSchema>;

/**
 * The `/health` body the daemon serves (the coarse bit + the additive PRD-029 `reasons`).
 * `reasons` is OPTIONAL — absent on the mode-gated public team/hybrid body, present in
 * local (which the dashboard always is). The whole body `.catch()`es a bad shape so a
 * malformed `/health` degrades to "no reasons" (coarse pill only), never a throw.
 *
 * NOTE the coarse liveness the app's view-swap keys off (`daemonUp`) comes from the HTTP
 * `res.ok` (a 503-on-degraded still parses a body), NOT from this `status` field — so the
 * reasons are purely ADDITIVE render data and never change the existing up/down behaviour.
 */
export const HealthBodySchema = z.object({
	status: z.string().catch("ok"),
	reasons: HealthReasonsSchema.optional(),
});

/** The result of a `/health` probe: coarse liveness + the parsed per-subsystem reasons (or null). */
export interface HealthProbe {
	/** Daemon liveness — `true` iff the HTTP response was ok (drives the view-swap, unchanged). */
	readonly up: boolean;
	/** The per-subsystem reasons (PRD-029), or `null` when the body omits/malforms them. */
	readonly reasons: HealthReasonsWire | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRD-032c — the vault `setting`-class surface (`GET`/`POST /api/settings`) + the
// curated provider→model catalog. Every field defaults so a partial/malformed payload
// degrades to a safe empty state, NEVER a throw into React (AC-5 defensive parsing).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One provider entry in the catalog `GET /api/settings` returns — MIRRORS the Wave-1
 * `ProviderEntry` in `src/daemon/runtime/vault/catalog.ts` (D-6). `models` is the curated,
 * ordered model list (`models[0]` is the selector default); `openEnded` marks OpenRouter,
 * whose model id is a free-form passthrough (the panel renders a text input for it).
 */
export const ProviderEntrySchema = z.object({
	id: z.string().catch(""),
	label: z.string().catch(""),
	models: z.array(z.string()).catch([]),
	openEnded: z.boolean().catch(false),
});
export type ProviderEntryWire = z.infer<typeof ProviderEntrySchema>;

/**
 * A single `setting` value on the wire — the vault `setting` class stores a JSON SCALAR
 * (string | number | boolean), so the panel renders exactly those. A non-scalar (a future
 * structured setting) would register its own class; here a bad value `.catch()`es to a
 * harmless empty string so the panel never throws.
 */
export const SettingValueWireSchema = z.union([z.string(), z.number(), z.boolean()]).catch("");
export type SettingValueWire = z.infer<typeof SettingValueWireSchema>;

/**
 * The `GET /api/settings` body the Wave-1 daemon serves: `{ settings, catalog }`. `settings`
 * is the current key→value map of the `setting` class (the active provider/model + the
 * pollinating toggle + dashboard prefs); `catalog` is the static provider→model list. NO secret
 * is in this body by construction (the surface reads only the `setting` class). Each field
 * `.catch()`es to an empty default so a partial body degrades to "nothing selected".
 */
export const VaultSettingsSchema = z.object({
	settings: z.record(z.string(), SettingValueWireSchema).catch({}),
	catalog: z.array(ProviderEntrySchema).catch([]),
});
export type VaultSettingsWire = z.infer<typeof VaultSettingsSchema>;

/**
 * The `GET /api/secrets` body (PRD-012a, names-only) — `{ names: string[] }`. The panel reads
 * this ONLY to show a provider key's PRESENCE ("set ✓" / "not set") by name; there is NO
 * value-returning route and the panel never asks for one (AC-5 / D-4). A malformed body
 * `.catch()`es to an empty name list (every provider reads as "not set", never a throw).
 */
export const SecretNamesSchema = z.object({
	names: z.array(z.string()).catch([]),
});
export type SecretNamesWire = z.infer<typeof SecretNamesSchema>;

/** The empty vault-settings view the panel shows before the first load (or on failure). */
export const EMPTY_VAULT_SETTINGS: VaultSettingsWire = Object.freeze({ settings: {}, catalog: [] });

// ─────────────────────────────────────────────────────────────────────────────
// PRD-044a — the REDACTED `/api/auth/status` read-model (the Settings page auth
// section). Every field `.catch()`-defaults so a partial/failed payload degrades to
// a DISCONNECTED status (never a throw into React). THE SCHEMA HAS NO `token` FIELD
// BY CONSTRUCTION — a token in the body is IGNORED by the schema (D-3, the token is
// sacred). `expiresAt` is optional: present only when a real `TokenClaims.exp` exists.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `GET /api/auth/status` body the auth section reads (PRD-044a). Metadata ONLY: org id +
 * name, workspace, agent, the credentials `source` (`env` | `file` | `none`), `savedAt`, and an
 * optional `expiresAt`. There is deliberately NO `token` field — zod drops any extra `token` key
 * in the body, so a token can never reach React even if a buggy daemon sent one. Every field
 * `.catch()`-defaults to a disconnected-safe value (AC-4: degrade, never throw).
 */
export const AuthStatusSchema = z.object({
	connected: z.boolean().catch(false),
	orgId: z.string().catch(""),
	orgName: z.string().catch(""),
	workspace: z.string().catch(""),
	agentId: z.string().catch(""),
	source: z.enum(["env", "file", "none"]).catch("none"),
	savedAt: z.string().catch(""),
	// Present ONLY when a real token `exp` exists; absent → the section shows "expiry unknown"
	// (never a fabricated date). `.optional()` so an absent field is honestly undefined.
	expiresAt: z.number().optional(),
});
export type AuthStatusWire = z.infer<typeof AuthStatusSchema>;

/**
 * The honest disconnected status the auth section shows before the first load, on any failure,
 * or when no credentials resolve (AC-4). Never a blank panel, never a fabricated org.
 */
export const DISCONNECTED_AUTH_STATUS: AuthStatusWire = Object.freeze({
	connected: false,
	orgId: "",
	orgName: "",
	workspace: "",
	agentId: "",
	source: "none",
	savedAt: "",
});

// ─────────────────────────────────────────────────────────────────────────────
// PRD-050b — the pre-auth guided-setup STATE read (`GET /setup/state`). Drives the
// fresh-install vs already-linked render (b-AC-6) and the live pre-auth→authenticated
// transition (b-AC-3). Every field `.catch()`-defaults so a partial/failed/non-local
// (404) payload degrades to a SAFE fresh-install state (never a throw into React). The
// body carries NO token/secret/PII by construction (install metadata only). The shape
// mirrors `src/daemon/runtime/dashboard/setup-state.ts` `SetupStateBody`; 050d EXTENDS it
// additively, so unknown future fields are simply ignored here (zod drops extras).
// ─────────────────────────────────────────────────────────────────────────────

/** Per-tool credential/state directory presence (mirrors the daemon `SetupCredentialsPresence`). */
export const SetupCredentialsSchema = z.object({
	deeplake: z.boolean().catch(false),
	honeycomb: z.boolean().catch(false),
	hivemind: z.boolean().catch(false),
});

/** The embeddings warmup signal (b-AC-5) — observable, never blocking. */
export const SetupWarmupSchema = z.object({
	enabled: z.boolean().catch(false),
	live: z.boolean().catch(false),
	warm: z.boolean().catch(false),
});

/**
 * The `GET /setup/state` body the guided-setup shell reads (PRD-050b). `authenticated` is the
 * DERIVED auth source of truth (a valid credential loads), NOT the `phase` hint. Every field
 * `.catch()`-defaults to a fresh-install-safe value so a failed/non-local read renders the
 * guided-setup state (the safe default), never a throw.
 */
export const SetupStateSchema = z.object({
	credentials: SetupCredentialsSchema.catch({ deeplake: false, honeycomb: false, hivemind: false }),
	phase: z.enum(["fresh", "installed", "linking", "linked", "migrating", "migrated"]).catch("fresh"),
	priorTool: z
		.object({ hivemind: z.enum(["absent", "present", "migrated"]).catch("absent") })
		.catch({ hivemind: "absent" }),
	firstTimeSetupComplete: z.boolean().catch(false),
	// THE load-bearing field for b-AC-6: when false the "First time setup" button shows; when true
	// the dashboard renders the authenticated state instead. Defaults FALSE (safe: show guided-setup).
	authenticated: z.boolean().catch(false),
	warmup: SetupWarmupSchema.catch({ enabled: false, live: false, warm: false }),
	// PRD-050d (d-AC-7) — the durable Hivemind→Honeycomb migration marker, present ONLY while a
	// migration is in flight or terminal. A NON-TERMINAL phase (`backup`/`uninstall`/`link`) means the
	// migration was interrupted → the dashboard offers RESUME or ROLL BACK. `.optional()` so a machine
	// that never migrated simply omits it; `backupPath` rides for the rollback affordance. No secret.
	migration: z
		.object({
			phase: z.enum(["backup", "uninstall", "link", "done", "rolled_back"]).catch("backup"),
			startedAt: z.string().catch(""),
			backupPath: z.string().optional(),
		})
		.optional(),
});
export type SetupStateWire = z.infer<typeof SetupStateSchema>;

/**
 * The honest fresh-install setup state the shell shows before the first load, on any failure, or in
 * non-local mode (the route 404s). `authenticated:false` ⇒ the guided-setup state renders (b-AC-6).
 */
export const FRESH_SETUP_STATE: SetupStateWire = Object.freeze({
	credentials: { deeplake: false, honeycomb: false, hivemind: false },
	phase: "fresh",
	priorTool: { hivemind: "absent" as const },
	firstTimeSetupComplete: false,
	authenticated: false,
	warmup: { enabled: false, live: false, warm: false },
});

/**
 * The `POST /setup/login` render payload (PRD-050c, consumed by 050b's "First time setup" button).
 * The body carries ONLY the `user_code` to display + the verification URIs — NEVER a token/device
 * code (the schema has no token field by construction). Every field `.catch()`-defaults so a partial
 * body degrades safely; `verification_uri_complete` is optional (present only when https-validated).
 */
export const SetupLoginSchema = z.object({
	user_code: z.string().catch(""),
	verification_uri: z.string().catch(""),
	verification_uri_complete: z.string().optional(),
});
export type SetupLoginWire = z.infer<typeof SetupLoginSchema>;

/**
 * PRD-050d — the `POST /setup/migrate-from-hivemind` response (consumed by the "Proceed with Honeycomb"
 * button). Carries the terminal `phase` + a plain-language `message` + the `backupPath` reversibility
 * anchor + the `needsLogin`/`migrated` flags. NO token/secret rides this shape by construction. Every
 * field `.catch()`-defaults so a partial/failed body degrades to a safe "not ok" state, never a throw.
 * `needsLogin:true` ⇒ the page runs the 050c device flow; `migrated:true` ⇒ the silent-adopt completed.
 */
export const SetupMigrateSchema = z.object({
	ok: z.boolean().catch(false),
	phase: z.enum(["backup", "uninstall", "link", "done", "rolled_back"]).catch("backup"),
	message: z.string().catch(""),
	backupPath: z.string().optional(),
	needsLogin: z.boolean().optional(),
	migrated: z.boolean().optional(),
});
export type SetupMigrateWire = z.infer<typeof SetupMigrateSchema>;

/** The honest "migration unavailable" ack the wizard shows on a non-2xx / network failure (never a throw). */
export const FAILED_SETUP_MIGRATE: SetupMigrateWire = Object.freeze({
	ok: false,
	phase: "backup",
	message: "Migration is unavailable right now. Retry, or run the uninstall + `honeycomb login` in your terminal.",
});

/** PRD-050d — the `POST /setup/migrate-from-hivemind/rollback` response (the d-AC-7 roll-back affordance). */
export const SetupMigrateRollbackSchema = z.object({
	ok: z.boolean().catch(false),
	phase: z.literal("rolled_back").catch("rolled_back"),
	message: z.string().catch(""),
});
export type SetupMigrateRollbackWire = z.infer<typeof SetupMigrateRollbackSchema>;

/** The honest "rollback unavailable" ack the wizard shows on a non-2xx / network failure (never a throw). */
export const FAILED_SETUP_MIGRATE_ROLLBACK: SetupMigrateRollbackWire = Object.freeze({
	ok: false,
	phase: "rolled_back",
	message: "Rollback is unavailable right now. Retry.",
});

// ─────────────────────────────────────────────────────────────────────────────
// PRD-049e — the scope-switcher enumeration schemas. Every field `.catch()`-defaults so a
// partial/failed/non-local (404) body degrades to a SAFE empty list (never a throw into React).
// NO token rides any of these bodies by construction (the daemon enumerates id+name only).
// ─────────────────────────────────────────────────────────────────────────────

/** One enumerated org (id + display name) from `GET /api/diagnostics/scope/orgs`. */
export const ScopeOrgSchema = z.object({
	id: z.string().catch(""),
	name: z.string().catch(""),
});
export type ScopeOrgWire = z.infer<typeof ScopeOrgSchema>;

/** The `GET /api/diagnostics/scope/orgs` body — `{ orgs }`. A failure degrades to an empty list. */
export const ScopeOrgsSchema = z.object({
	orgs: z.array(ScopeOrgSchema).catch([]),
});

/** One enumerated workspace (id + display name) from `GET /api/diagnostics/scope/workspaces`. */
export const ScopeWorkspaceSchema = z.object({
	id: z.string().catch(""),
	name: z.string().catch(""),
});
export type ScopeWorkspaceWire = z.infer<typeof ScopeWorkspaceSchema>;

/**
 * The `GET /api/diagnostics/scope/workspaces` body — `{ workspaces, org, reminted }`. `reminted` is
 * true when the daemon re-minted the org-bound token before enumerating (49e-AC-3 observability).
 */
export const ScopeWorkspacesSchema = z.object({
	workspaces: z.array(ScopeWorkspaceSchema).catch([]),
	org: z.string().catch(""),
	reminted: z.boolean().catch(false),
});
export type ScopeWorkspacesWire = z.infer<typeof ScopeWorkspacesSchema>;

/**
 * One enumerated project (the workspace's synced 049a registry copy) — id + display name + the
 * PRD-059d `boundLocally` bit. `boundLocally` is true when a local folder→project binding targets
 * this project on THIS device (the Projects page shows those as ACTIVE); false ⇒ registry-only,
 * IMPORTABLE (the 059d "Import project from cloud" list shows those). `.catch(false)` so an OLDER
 * daemon payload that predates the field degrades to "not bound here" (safe: it would appear in the
 * import list, never silently as active) rather than throwing into React.
 */
export const ScopeProjectSchema = z.object({
	projectId: z.string().catch(""),
	name: z.string().catch(""),
	boundLocally: z.boolean().catch(false),
	// PRD-059c c-AC-1 — the per-project STATE the Wave-3 daemon now aggregates onto each registry row.
	// Every field `.catch()`-defaults so an OLDER daemon that predates the enrichment (or a partial body)
	// degrades to a safe empty/zero value rather than throwing into React — the page renders the honest
	// fallback ("—"/"never") for the missing field. NO secret rides any of these (paths, a git remote
	// slug, integer counts, an ISO timestamp). `boundPaths` is this device's bound folder path(s) (empty
	// for an importable/registry-only project); `remote` is `host/owner/repo` or `''`; the counts are
	// best-effort (`0` on a backend flap); `lastCapture` is an ISO timestamp or `null` ("never captured").
	boundPaths: z.array(z.string()).catch([]),
	remote: z.string().catch(""),
	memoryCount: z.number().catch(0),
	sessionCount: z.number().catch(0),
	lastCapture: z.string().nullable().catch(null),
});
export type ScopeProjectWire = z.infer<typeof ScopeProjectSchema>;

/** The `GET /api/diagnostics/scope/projects` body — `{ projects, org, workspace }`. */
export const ScopeProjectsSchema = z.object({
	projects: z.array(ScopeProjectSchema).catch([]),
	org: z.string().catch(""),
	workspace: z.string().catch(""),
});
export type ScopeProjectsWire = z.infer<typeof ScopeProjectsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// PRD-059b/059c/059d — the folder-picker + bind schemas. Every field `.catch()`-defaults so a
// partial/failed/non-local (404) body degrades to a SAFE empty/false state (never a throw into
// React). NO token rides any of these bodies by construction (the daemon serves paths + ids only).
// ─────────────────────────────────────────────────────────────────────────────

/** One immediate child directory in a browse listing (059b) — basename + absolute path + git-repo marker. */
export const BrowseChildSchema = z.object({
	name: z.string().catch(""),
	path: z.string().catch(""),
	isGitRepo: z.boolean().catch(false),
});
export type BrowseChildWire = z.infer<typeof BrowseChildSchema>;

/**
 * The `GET /api/diagnostics/fs/browse` body (059b): the resolved dir + its immediate child
 * directories. `parent` is null at the allowed root (no traversal above it); `error` is a redacted
 * reason when the dir could not be read (still a clean body with empty children). A
 * malformed/absent/non-local body degrades to {@link EMPTY_BROWSE} so the picker shows an honest
 * empty/unavailable state (never a throw).
 */
export const BrowseBodySchema = z.object({
	path: z.string().catch(""),
	root: z.string().catch(""),
	parent: z.string().nullable().catch(null),
	children: z.array(BrowseChildSchema).catch([]),
	error: z.string().optional(),
});
export type BrowseBodyWire = z.infer<typeof BrowseBodySchema>;

/** The honest empty browse body the picker shows when the daemon is unreachable / local-mode is off (b-AC-5). */
export const EMPTY_BROWSE: BrowseBodyWire = Object.freeze({ path: "", root: "", parent: null, children: [] });

/**
 * The `POST /api/diagnostics/projects/bind` (+ `/bind-existing`) ack (059b/059d): the recorded
 * absolute path + the project it bound to. `bound` is false on a rejected bind (the reserved inbox,
 * a degenerate name, a non-absolute path), with a redacted `error`. A malformed/failed body degrades
 * to a not-bound ack so the caller surfaces an honest failure (never a throw).
 */
export const BindAckSchema = z.object({
	bound: z.boolean().catch(false),
	path: z.string().catch(""),
	projectId: z.string().catch(""),
	error: z.string().optional(),
});
export type BindAckWire = z.infer<typeof BindAckSchema>;

/** The honest "bind failed" ack the picker shows on a non-2xx / network failure (never a throw). */
export const FAILED_BIND_ACK: BindAckWire = Object.freeze({ bound: false, path: "", projectId: "", error: "unavailable" });

/** The `POST /api/diagnostics/projects/unbind` ack (059c): whether a LOCAL binding was removed. */
export const UnbindAckSchema = z.object({
	unbound: z.boolean().catch(false),
	path: z.string().catch(""),
});
export type UnbindAckWire = z.infer<typeof UnbindAckSchema>;

/** The honest "unbind failed" ack the page shows on a non-2xx / network failure (never a throw). */
export const FAILED_UNBIND_ACK: UnbindAckWire = Object.freeze({ unbound: false, path: "" });

// ─────────────────────────────────────────────────────────────────────────────
// IRD-122 — the scope-switch PERSISTENCE acks. Every field `.catch()`-defaults so a partial/failed/
// non-local body degrades to a SAFE not-switched ack (never a throw). NO token rides either body.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `POST /api/diagnostics/scope/org-switch` ack (122-AC-2): the now-active org + whether a token
 * re-mint ran. `switched:false` with a redacted `error` on a failed switch (no credential / unknown
 * org / re-mint error). `reminted` is true when a fresh org-bound token was minted (the org changed).
 * NO token in the body by construction.
 */
export const OrgSwitchAckSchema = z.object({
	switched: z.boolean().catch(false),
	org: z.string().catch(""),
	orgName: z.string().optional(),
	reminted: z.boolean().catch(false),
	error: z.string().optional(),
});
export type OrgSwitchAckWire = z.infer<typeof OrgSwitchAckSchema>;

/** The honest "org switch failed" ack the switcher shows on a non-2xx / network failure (never a throw). */
export const FAILED_ORG_SWITCH_ACK: OrgSwitchAckWire = Object.freeze({ switched: false, org: "", reminted: false, error: "unavailable" });

/** The `POST /api/diagnostics/scope/workspace-switch` ack (IRD-122): the now-active workspace (no re-mint). */
export const WorkspaceSwitchAckSchema = z.object({
	switched: z.boolean().catch(false),
	workspace: z.string().catch(""),
	error: z.string().optional(),
});
export type WorkspaceSwitchAckWire = z.infer<typeof WorkspaceSwitchAckSchema>;

/** The honest "workspace switch failed" ack the switcher shows on a non-2xx / network failure (never a throw). */
export const FAILED_WORKSPACE_SWITCH_ACK: WorkspaceSwitchAckWire = Object.freeze({ switched: false, workspace: "", error: "unavailable" });

// ─────────────────────────────────────────────────────────────────────────────
// The typed fetch client. Every method validates its payload through zod, so the
// React tree never sees an untyped/garbage value (AC-2 empty states are free).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The non-tenant SESSION headers every dashboard request stamps (PRD-024 Wave 3).
 *
 * The `/api/memories` group sits behind the runtime-path + session middleware
 * (`src/daemon/runtime/middleware/runtime-path.ts`), which REQUIRES
 * `x-honeycomb-runtime-path: plugin|legacy` AND a non-empty `x-honeycomb-session`. The
 * dashboard web app is a legitimate loopback thin client — exactly like the CLI/SDK/MCP, which
 * stamp these — so it must send them too. They carry NO tenant identity (no org GUID) and NO
 * credential (D-4), so they are safe to stamp client-side; the org comes from the daemon's
 * LOCAL default scope (the daemon-side Fix A). We deliberately do NOT send `x-honeycomb-org`:
 * sending a wrong/empty org would trip the cross-tenant guard.
 *
 * The session id is a FIXED, clearly-labeled loopback viewer id ("dashboard-web"): a single
 * long-lived viewer that idempotently re-claims its OWN session (the claim map is per-session),
 * never conflicting with a harness which uses real session ids. A fixed id keeps the bundle
 * deterministic and the contract testable (no `Math.random`/`Date.now`).
 */
export const DASHBOARD_SESSION_HEADERS = Object.freeze({
	"x-honeycomb-runtime-path": "plugin",
	"x-honeycomb-session": "dashboard-web",
} as const);

/** The injectable fetch surface (the global in prod; a mock in unit tests). */
export type FetchLike = typeof fetch;

/** Construction options for {@link createWireClient}. */
export interface WireClientOptions {
	/** The daemon origin the app talks to (defaults to same-origin, i.e. empty prefix). */
	readonly origin?: string;
	/** The fetch implementation (defaults to the global `fetch`). */
	readonly fetchImpl?: FetchLike;
}

/**
 * GET + zod-parse a JSON endpoint, returning the parsed value or `null` on any failure. `extraHeaders`
 * (PRD-049e) carries the optional `x-honeycomb-project` selection header so a project-scoped read
 * narrows server-side; absent it, the read is unchanged (back-compat).
 */
async function getJson<T>(
	fetchImpl: FetchLike,
	url: string,
	schema: z.ZodType<T>,
	extraHeaders: Record<string, string> = {},
): Promise<T | null> {
	try {
		const res = await fetchImpl(url, { headers: { accept: "application/json", ...DASHBOARD_SESSION_HEADERS, ...extraHeaders } });
		if (!res.ok) return null;
		const body: unknown = await res.json();
		const parsed = schema.safeParse(body);
		return parsed.success ? parsed.data : null;
	} catch {
		// A network error / abort / non-JSON body → null; the caller renders the empty state.
		return null;
	}
}

/**
 * POST a JSON body + zod-parse the response, returning the parsed value or `null` on any non-2xx /
 * network / parse failure. The single shared writer for the PRD-040 mutations (add/modify/forget/
 * compact) so the four call sites do not duplicate the fetch+guard boilerplate (jscpd discipline).
 * Every request stamps the session headers; no `any` crosses the boundary (the body is `unknown`).
 */
async function postJson<T>(
	fetchImpl: FetchLike,
	url: string,
	body: unknown,
	schema: z.ZodType<T>,
): Promise<T | null> {
	try {
		const res = await fetchImpl(url, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json", ...DASHBOARD_SESSION_HEADERS },
			body: JSON.stringify(body),
		});
		if (!res.ok) return null;
		const parsed = schema.safeParse(await res.json());
		return parsed.success ? parsed.data : null;
	} catch {
		// A network error / abort / non-JSON body → null; the caller surfaces "save failed" + re-reads.
		return null;
	}
}

/** The arm name → a human scope hint for a recalled memory (honest, derived from the wire). */
function scopeForSource(source: string): string {
	if (source === "memories") return "team";
	if (source === "memory") return "org";
	return "session";
}

/** The max characters a recalled snippet renders before it is truncated with an ellipsis. */
export const MAX_SNIPPET_CHARS = 280;

/**
 * Pull a short, human detail out of a captured tool-call's input (the file it read, the
 * command it ran, the pattern it searched). Returns "" when none of the known input keys
 * carry a usable string, so the caller falls back to the bare tool name.
 */
function toolInputDetail(input: unknown): string {
	if (typeof input !== "object" || input === null) return "";
	const rec = input as Record<string, unknown>;
	for (const key of ["file_path", "path", "command", "pattern", "query", "url", "prompt", "description"]) {
		const v = rec[key];
		if (typeof v === "string" && v.trim() !== "") return v.trim();
	}
	return "";
}

/**
 * Turn a RAW captured-session turn (the JSONB `sessions.message`, forwarded verbatim as a
 * recall hit's `text`) into ONE readable line. The stored shape varies across harnesses and
 * plugin versions (`kind` vs `type`, `tool` vs `tool_name`, `input` vs `tool_input`, `text`
 * vs `prompt`), so every field is read defensively. Returns `null` when the text is not a
 * JSON object we recognize, so the caller renders the original text untouched (a distilled
 * prose fact is never mangled).
 */
function humanizeSessionTurn(raw: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null; // not JSON: distilled prose, render as-is.
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const rec = parsed as Record<string, unknown>;
	const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
	const kind = str(rec.kind) || str(rec.type);
	const tool = str(rec.tool) || str(rec.tool_name);
	const body = str(rec.text) || str(rec.prompt) || str(rec.message);

	// A user / assistant turn: render the speaker + the message body.
	if (kind.startsWith("assistant") && body !== "") return `assistant: ${body}`;
	if (kind.startsWith("user") && body !== "") return `user: ${body}`;
	// A tool call: render the tool name + its most informative input detail.
	if (tool !== "" || kind === "tool_call") {
		const detail = toolInputDetail(rec.input ?? rec.tool_input);
		const name = tool !== "" ? tool : "tool";
		return detail !== "" ? `${name} · ${detail}` : name;
	}
	// A recognized object that carries SOME body text under an unknown kind: render the body.
	if (body !== "") return body;
	return null;
}

/**
 * Format a recall hit's matched `text` into the snippet the {@link MemoryCard} renders. A raw
 * `session` dump (the JSONB capture turn) is collapsed to one readable line via
 * {@link humanizeSessionTurn} so the card never shows escaped JSON; a distilled `memory` fact
 * passes through as prose. EITHER way the result is whitespace-collapsed and capped at
 * {@link MAX_SNIPPET_CHARS} so a long row can never blow out the card. Exported so a test can
 * drive it deterministically (mirrors {@link formatLogLine}).
 */
export function formatRecallSnippet(text: string, kind: "memory" | "session"): string {
	const trimmed = text.trim();
	let display = trimmed;
	// A session hit (or any text that looks like a JSON object/array) is humanized; clean prose
	// is left alone so a distilled fact is never reshaped.
	if (kind === "session" || trimmed.startsWith("{") || trimmed.startsWith("[")) {
		const human = humanizeSessionTurn(trimmed);
		if (human !== null) display = human;
	}
	display = display.replace(/\s+/g, " ").trim();
	if (display.length <= MAX_SNIPPET_CHARS) return display;
	return `${display.slice(0, MAX_SNIPPET_CHARS - 1).trimEnd()}…`;
}

/**
 * The dashboard web client. Each method hits one already-served endpoint, validates the
 * payload with zod, and returns a typed value (or a safe empty/zero state). The whole
 * surface is loopback `fetch` — no DeepLake, no secret, no token (D-4): the app reads only
 * what the daemon chooses to serve.
 */
export interface WireClient {
	/** The KPI band. PRD-049e: pass the selected project to re-scope the project-bearing counts
	 *  (Memories / Turns / Est. savings); omit it for the workspace-wide view. Team skills is always
	 *  workspace-wide (it has no project segment). */
	kpis(projectId?: string): Promise<KpisWire>;
	sessions(): Promise<SessionRowWire[]>;
	settings(): Promise<SettingsWire>;
	rules(): Promise<RuleRowWire[]>;
	skills(): Promise<SkillRowWire[]>;
	/**
	 * PRD-049e — read the codebase-graph view (`GET /api/graph`). `projectId` (when set) stamps the
	 * selected-project header so the read re-scopes on the dashboard's scope change (49e-AC-2); the
	 * page passes the active `useScope().scope.project`, so a switch re-fetches the graph for the new
	 * project rather than showing the prior scope's cached data.
	 */
	graph(projectId?: string): Promise<GraphWire>;
	/**
	 * PRD-041b — read the MEMORY-GRAPH view-model (`GET /api/diagnostics/memory-graph`). Returns the
	 * SAME `GraphWire` shape as {@link graph} (the memory graph is a `GraphView`-shaped source), so the
	 * page feeds it to the SAME `GraphCanvas`. A malformed/absent body — or a `built:false` empty graph
	 * while PRD-008 data is unpopulated — degrades to {@link EMPTY_GRAPH} so the page renders its honest
	 * "no memory graph yet" empty state, never a throw. Validated through the shared `GraphSchema`.
	 */
	memoryGraph(projectId?: string): Promise<GraphWire>;
	/**
	 * PRD-060e — read the composite ROI view-model (`GET /api/diagnostics/roi`). Returns the
	 * full {@link RoiViewWire} the page renders as a PURE function (savings/infra/pollination/net
	 * + the org/team/agent/project rollups + the per-user availability flag + `cost_basis`). All
	 * money is INTEGER cents. A malformed/absent/failed body degrades to {@link EMPTY_ROI_VIEW}
	 * (every section `absent`, net NOT computed) so the page renders its honest empty state — a
	 * DASH glyph, never `$0.00` — rather than throwing (e-AC-2/e-AC-5). `projectId` (when set)
	 * stamps the selected-project header so the read re-scopes on a dashboard scope change.
	 */
	roi(projectId?: string): Promise<RoiView>;
	/**
	 * PRD-060e — read the ROI trend series (`GET /api/diagnostics/roi/trend`) backing the
	 * inline-SVG chart (e-AC-10, dashed=modeled / solid=measured). All money is INTEGER cents. A
	 * malformed/absent/failed body — or a genuine no-history-yet state — degrades to
	 * {@link EMPTY_ROI_TREND} so the chart renders its honest empty state, never a throw.
	 */
	roiTrend(range: string, projectId?: string): Promise<RoiTrendView>;
	recall(query: string, projectId?: string): Promise<{ memories: RecalledMemory[]; degraded: boolean }>;
	/**
	 * PRD-040a — list the scoped tenant's memories (`GET /api/memories`, newest-first). `limit`
	 * bumps for "load more" (the daemon clamps to `MAX_LIST_LIMIT` 500). A malformed/absent body
	 * degrades to `[]` (the page renders its honest empty state). Stamps the session headers.
	 */
	listMemories(limit?: number, projectId?: string): Promise<MemoryRecordWire[]>;
	/**
	 * PRD-040a — read one memory by id (`GET /api/memories/:id`). Returns `null` on a 404 (the id is
	 * unknown OR forgotten → the page renders "this memory was forgotten") or any failure.
	 */
	getMemory(id: string): Promise<MemoryRecordWire | null>;
	/**
	 * PRD-040b — add a memory (`POST /api/memories`, store). Returns the `{ id, action }` ack, or
	 * `null` on a non-2xx / network failure (the caller surfaces "save failed" and re-reads). The
	 * page never optimistically renders the input — it re-lists after the ack.
	 */
	addMemory(input: { content: string; type?: string; agentId?: string }): Promise<StoreAckWire | null>;
	/**
	 * PRD-040b — edit a memory (`POST /api/memories/:id/modify`, version-bumped + reason-gated).
	 * The `reason` is REQUIRED (the daemon rejects an empty one). Returns the `{ id, action,
	 * audited }` ack, or `null` on a non-2xx / network failure (the caller re-reads the unchanged
	 * persisted value). NEVER a hard-update — the daemon appends a new version.
	 */
	modifyMemory(id: string, input: { content: string; reason: string; agentId?: string }): Promise<WriteAckWire | null>;
	/**
	 * PRD-040b — forget a memory (`POST /api/memories/:id/forget`, reason-gated soft-delete → a
	 * tombstone version). Returns the ack, or `null` on failure. The page gates this behind a confirm.
	 */
	forgetMemory(id: string, input: { reason: string }): Promise<WriteAckWire | null>;
	/**
	 * PRD-040c — trigger version-history compaction (`POST /api/diagnostics/compact`). The optional
	 * `table` selects ONE allow-listed table (omitted ⇒ all). Returns the per-table summary, or
	 * `null` on failure ("compaction unavailable"). The page sends only a KNOWN table name or none —
	 * the daemon matches it against the allow-list, so no attacker-controlled identifier rides this.
	 */
	compact(table?: string): Promise<CompactSummaryWire | null>;
	/**
	 * PRD-058d — list the scoped conflict queue (`GET /api/memories/conflicts?status=open`). A
	 * malformed/absent body degrades to `[]` (the panel renders its honest empty state). Scope is
	 * resolved daemon-side from the session — the read is scope-filtered before any content.
	 */
	lifecycleConflicts(status?: string): Promise<LifecycleConflictWire[]>;
	/**
	 * PRD-058d — resolve a conflict through the SAME 058b endpoint the CLI uses
	 * (`POST /api/memories/conflicts/:id/resolve`). NO new write path — the daemon applies the κ
	 * assignment, the append-only supersession, the audit append, and the poll-to-convergence
	 * read-back. Returns `true` iff the daemon accepted (2xx); the caller re-reads + polls to
	 * convergence, never an optimistic flip.
	 */
	resolveConflict(id: string, input: { verdict: string; winnerId?: string; reason?: string }): Promise<boolean>;
	/** PRD-058d — list the scoped memories with `ref_status='stale'` + their unresolved refs. Degrades to `[]`. */
	lifecycleStaleRefs(): Promise<LifecycleStaleRefWire[]>;
	/** PRD-058d — read the lifecycle-filtered audit (`GET /api/memories/history?type=lifecycle`). Degrades to `[]`. */
	lifecycleHistory(): Promise<LifecycleHistoryWire[]>;
	/**
	 * PRD-058d / 058e — read the calibration introspection (`GET /api/memories/calibration`): ECE,
	 * Brier, n_samples, and the reliability-diagram payload. A malformed/absent/cold-start body
	 * degrades to {@link EMPTY_CALIBRATION} (the panel shows "calibration dormant"), never a throw.
	 */
	calibration(): Promise<CalibrationWire>;
	logs(limit?: number): Promise<LogRecordWire[]>;
	/**
	 * PRD-042c / PRD-021d — FOLLOW the `/api/logs/stream` SSE tail (c-AC-2). Subscribes a browser
	 * `EventSource` to the daemon's already-mounted log stream, parsing each `event: "log"` record
	 * through {@link LogRecordSchema} and handing the validated record to `onRecord`. Returns an
	 * unsubscribe function the caller MUST call on unmount (it closes the EventSource). The activity
	 * feed BACKFILLS via {@link logs} first, then follows this tail — no client poll.
	 *
	 * DEGRADES SAFELY: in a non-browser env (jsdom test, SSR) where `EventSource` is unavailable, this
	 * is a no-op that returns an inert unsubscribe — the caller keeps its snapshot and never crashes
	 * (the SSE-record handling is exercised by injecting the parser directly in tests). No record
	 * carries a secret by construction (logger.ts); this introduces none.
	 */
	logsStream(onRecord: (record: LogRecordWire) => void): () => void;
	/**
	 * PRD-043a/043b — read the DURABLE, filterable, paginated request-log history
	 * (`GET /api/logs/history`, newest first). Reuses the SAME secret-free `LogRecordWire` shape as
	 * {@link logs}, so the history table and the live tail share one row renderer. A malformed/absent
	 * body degrades to an empty page (`{ records: [], nextCursor: null, persistent: false }`) so the
	 * page renders its honest empty/unavailable state, never a throw. `filters` map 1:1 to the
	 * daemon's validated query params; an undefined filter is simply omitted.
	 */
	logsHistory(filters?: LogsHistoryFilters): Promise<LogsHistoryWire>;
	/**
	 * PRD-043c — read the browsable captured-TURNS history (`GET /api/diagnostics/sessions`, paged,
	 * newest first). Returns the turn rows + a `nextCursor` for the next older page. Labeled "Turns"
	 * on the page (PRD-035a); the storage table stays `sessions`. A malformed/absent body degrades to
	 * an empty page so the page renders its honest empty state, never a throw. The daemon reads turns
	 * from DeepLake (eventual consistency) — a freshly captured turn may appear one refresh later.
	 */
	turnsHistory(opts?: { limit?: number; cursor?: string }): Promise<TurnsHistoryWire>;
	/**
	 * PRD-039a — read the harness registry + last-seen telemetry (the data backbone). Returns the
	 * six canonical `HarnessStatus` rows the Harnesses page (039b/039c) renders; a failure degrades
	 * to an empty list (the page shows its honest empty/zero state, never a throw). No second source —
	 * this is the SINGLE backbone (parent D-3).
	 */
	harnesses(): Promise<HarnessStatusWire[]>;
	/**
	 * PRD-042 — read the Sync page `installed ∪ synced` union view-model (`GET /api/diagnostics/assets`):
	 * skills + agents, each with its honest state + presentation-safe detail. A malformed/absent body
	 * degrades to {@link EMPTY_ASSET_SYNC_VIEW} (the page renders its honest empty state, never a throw).
	 */
	assetsView(): Promise<AssetSyncViewWire>;
	/**
	 * PRD-042 — run one Sync action (`POST /api/diagnostics/sync/{action}`). The daemon performs the REAL
	 * pipeline (publish/pull/tombstone/install-toggle) and returns the CONVERGED result (poll-convergent
	 * read-back). Returns the ack, or `null` on a non-2xx / network failure (the page re-reads the union
	 * and reflects whatever actually persisted — never an optimistic flip). `input` carries the asset
	 * kind + name (+ optional native/honeycombId for promote/pull/demote).
	 */
	syncAction(
		action: "promote" | "pull" | "demote" | "enable" | "disable",
		input: { assetType: "skill" | "agent"; name: string; native?: string; honeycombId?: string; harness?: string },
	): Promise<SyncActionResultWire | null>;
	health(): Promise<HealthProbe>;
	pollinate(): Promise<PollinateAck>;
	/**
	 * PRD-041a — trigger the codebase-graph BUILD (`POST /api/graph/build`). The daemon runs the REAL
	 * worker end-to-end (discover → tree-sitter extract → aggregate → finalize) and writes the LOCAL
	 * snapshot, then returns the build ack `{ built, nodeCount, edgeCount, fileCount }` (the rest of the
	 * body is ignored). After a `{ built: true }` ack the caller re-runs {@link graph} to render the
	 * fresh snapshot immediately (it is a LOCAL file — no eventual-consistency poll needed). Stamps the
	 * session headers exactly like {@link pollinate}. Uses a GENEROUS timeout ({@link BUILD_GRAPH_TIMEOUT_MS})
	 * — the build is slow (whole-repo tree-sitter parse). Degrades to {@link FAILED_BUILD_GRAPH_ACK} on any
	 * non-2xx / timeout / network / malformed-body failure — NEVER throws into React (the page shows an
	 * honest inline error + keeps the CLI hint).
	 */
	buildGraph(): Promise<BuildGraphAck>;
	/** PRD-032c — read the vault `setting` class + the provider→model catalog (`GET /api/settings`). */
	vaultSettings(): Promise<VaultSettingsWire>;
	/**
	 * PRD-032c — write one `setting`-class record through the daemon (`POST /api/settings/:key`).
	 * Returns `true` iff the daemon accepted the write (2xx); the caller re-reads to reflect the
	 * PERSISTED value (it never trusts a local-only toggle). The panel NEVER opens the vault
	 * directly — every write goes through this loopback endpoint (PRD-020b posture).
	 */
	setSetting(key: string, value: SettingValueWire): Promise<boolean>;
	/**
	 * PRD-032c — read the names-only secret list (`GET /api/secrets`) for provider-key PRESENCE
	 * ("set ✓" / "not set") ONLY. There is no value-returning route; this returns NAMES, never a
	 * value (D-4 / AC-5).
	 */
	secretNames(): Promise<string[]>;
	/**
	 * PRD-044b — WRITE-ONLY store a provider key (`POST /api/secrets/:name` with a `{ value }`
	 * body). Returns `true` iff the daemon accepted the write (2xx); any non-2xx (400 invalid
	 * name/value, 502 store failure) reads as "not accepted". The value is sent in the body and
	 * NEVER echoed back (the daemon's 201 carries the NAME only). The caller RE-READS
	 * {@link secretNames} on success so the presence badge reflects the persisted truth — mirroring
	 * the `setSetting` re-read pattern. THERE IS NO `getSecret` METHOD, and none is ever added: a
	 * stored key cannot be read back through any wire method (the load-bearing AC-3 invariant).
	 */
	setSecret(name: string, value: string): Promise<boolean>;
	/**
	 * Dashboard actions — log out of DeepLake (`POST /api/actions/logout`): remove the shared
	 * credential so the user can re-authenticate from the dashboard. Returns `true` iff the daemon
	 * accepted (2xx + `{ ok: true }`); a non-2xx / network failure reads as `false`. The caller
	 * re-reads {@link authStatus} so the section flips to disconnected on success.
	 */
	logout(): Promise<boolean>;
	/**
	 * Dashboard actions — turn embeddings on/off (`POST /api/actions/embeddings` with `{ enabled }`).
	 * The daemon actuates the embed supervisor LIVE (spawn+warm / stop) AND persists the choice so it
	 * survives a restart. Returns `true` iff accepted (2xx + echoed `enabled` matches the request);
	 * the caller reflects the requested state on success and re-reads {@link health} for the live truth.
	 */
	setEmbeddings(enabled: boolean): Promise<boolean>;
	/**
	 * Dashboard actions — restart the daemon (`POST /api/actions/restart`). The daemon spawns a
	 * detached respawn helper, then gracefully shuts down; a fresh daemon comes back on the same port.
	 * Returns `true` iff the restart was acknowledged (2xx + `{ restarting: true }`); the caller then
	 * shows "restarting…" and polls {@link health} until the new daemon answers. Degrades to `false`.
	 */
	restartDaemon(): Promise<boolean>;
	/**
	 * Dashboard actions — uninstall (`POST /api/actions/uninstall`). Returns the guided removal: the
	 * detected harnesses + the exact CLI command that fully reverses Honeycomb's footprint (v1 does not
	 * perform the destructive hook removal from the daemon serving this page — see `actions-api.ts`).
	 * A non-2xx / network failure degrades to `null` (the page surfaces an honest error). No secret rides it.
	 */
	uninstall(): Promise<UninstallResultWire | null>;
	/**
	 * PRD-044a — read the REDACTED DeepLake auth STATUS (`GET /api/auth/status`). Returns the
	 * daemon's real connected identity (org/workspace/agent/source/savedAt + optional `expiresAt`)
	 * or an honest disconnected status. The body carries NO token (the schema has no token field
	 * by construction); a malformed/absent/failed read degrades to {@link DISCONNECTED_AUTH_STATUS}
	 * (never a throw into React — AC-4). Re-callable on focus/poll so a CLI `honeycomb login`
	 * reflects here.
	 */
	authStatus(): Promise<AuthStatusWire>;
	/**
	 * PRD-050b — read the pre-auth guided-setup STATE (`GET /setup/state`). Returns credential-dir
	 * presence + the onboarding phase/prior-tool + the DERIVED `authenticated` bit + the embeddings
	 * warmup signal. Drives the fresh-install vs already-linked render (b-AC-6) and the live
	 * pre-auth→authenticated transition the shell polls for (b-AC-3). A malformed/absent/failed read,
	 * or a non-local 404, degrades to {@link FRESH_SETUP_STATE} (the guided-setup state) — never a
	 * throw into React. The body carries NO token/secret (install metadata only).
	 */
	setupState(): Promise<SetupStateWire>;
	/**
	 * PRD-050c (the 050b "First time setup" button handler) — BEGIN the on-page device-flow login
	 * (`POST /setup/login`). Returns the `user_code` + verification URIs to display on the page (the
	 * daemon keeps polling → mint → persist in the background); the shell then polls {@link setupState}
	 * and flips to the authenticated view when the credential lands (b-AC-3). Returns `null` on a
	 * non-2xx (the 502 device-flow-unavailable) / network failure so the button shows an honest error.
	 * The response carries NO token (the schema has no token field by construction — c-AC-4).
	 */
	setupLogin(): Promise<SetupLoginWire | null>;
	/**
	 * PRD-050d — "Proceed with Honeycomb": run the Hivemind→Honeycomb migration (`POST
	 * /setup/migrate-from-hivemind`). The daemon backs up + uninstalls Hivemind idempotently, then
	 * verify-and-adopts the shared credential (d-AC-4) or returns `needsLogin:true` (the page then runs
	 * {@link setupLogin}). The response carries the terminal phase + a plain-language message + the
	 * backup path (NO token). Degrades to {@link FAILED_SETUP_MIGRATE} on a non-2xx / network failure so
	 * the wizard shows an honest, recoverable error (never a throw).
	 */
	migrateFromHivemind(): Promise<SetupMigrateWire>;
	/**
	 * PRD-050d (d-AC-7) — "Roll back": restore the pre-migration Hivemind backup (`POST
	 * /setup/migrate-from-hivemind/rollback`). Offered when `/setup/state` reports a NON-TERMINAL
	 * `migration.phase` (an interrupted migration). Degrades to {@link FAILED_SETUP_MIGRATE_ROLLBACK} on
	 * a non-2xx / network failure (never a throw).
	 */
	rollbackMigration(): Promise<SetupMigrateRollbackWire>;
	/**
	 * PRD-049e (49e-AC-1) — list the orgs the user has access to (`GET /api/diagnostics/scope/orgs`).
	 * Privilege-scoped by the daemon's token (`GET /organizations`); nothing the user lacks access to
	 * appears. A failed/absent/non-local (404) read degrades to `[]` (the switcher shows an empty
	 * state), never a throw. No token rides the body.
	 */
	scopeOrgs(): Promise<ScopeOrgWire[]>;
	/**
	 * PRD-049e (49e-AC-1 / 49e-AC-3) — list a given org's workspaces
	 * (`GET /api/diagnostics/scope/workspaces?org=<id>`). When `org` differs from the daemon's
	 * credential org, the daemon RE-MINTS the org-bound token (PRD-011) BEFORE enumerating. Returns the
	 * full body (`{ workspaces, org, reminted }`) so the caller can observe the re-mint. A failed/absent
	 * read degrades to an empty workspace list, never a throw.
	 */
	scopeWorkspaces(org?: string): Promise<ScopeWorkspacesWire>;
	/**
	 * PRD-049e (49e-AC-1) / PRD-059d — list the workspace's registry projects
	 * (`GET /api/diagnostics/scope/projects`), the daemon-synced 049a `projects.json` copy (incl. the
	 * `__unsorted__` inbox + each project's `boundLocally` bit). `opts.unbound` stamps `?unbound=1` to
	 * filter to the IMPORTABLE set (registry-only, no local binding on this device — the 059d import
	 * list); omitted ⇒ the full list (the Projects page splits active vs importable on `boundLocally`).
	 * A failed/absent read degrades to `[]`, never a throw.
	 */
	scopeProjects(opts?: { unbound?: boolean }): Promise<ScopeProjectWire[]>;
	/**
	 * PRD-059b — browse a directory's immediate child DIRECTORIES (`GET /api/diagnostics/fs/browse`).
	 * The daemon serves the dirs-only tree (a browser cannot return an absolute path), each child marked
	 * if it is a git repo, clamped to an allowed root (home by default). `path` (when set) browses that
	 * dir; omitted ⇒ the root. A failed/absent/non-local (404) read degrades to {@link EMPTY_BROWSE} so
	 * the picker shows its honest empty/unavailable state (the CLI fallback — b-AC-5), never a throw.
	 */
	fsBrowse(path?: string): Promise<BrowseBodyWire>;
	/**
	 * PRD-059b — bind a chosen ABSOLUTE folder to a NEW/named project (`POST /api/diagnostics/projects/bind`).
	 * `name` (when set) is the explicit project name; omitted ⇒ the daemon's CLI-identical suggestion
	 * (git remote repo, else basename). Returns the `{ bound, path, projectId, error? }` ack; degrades
	 * to {@link FAILED_BIND_ACK} on a non-2xx / network failure so the caller surfaces an honest error.
	 */
	bindProject(input: { path: string; name?: string }): Promise<BindAckWire>;
	/**
	 * PRD-059d — bind a chosen ABSOLUTE folder to an EXISTING registry project_id
	 * (`POST /api/diagnostics/projects/bind-existing`) — the cross-device import. Returns the bind ack;
	 * degrades to {@link FAILED_BIND_ACK} on failure. The existing project keeps its registry remote.
	 */
	bindExistingProject(input: { path: string; projectId: string }): Promise<BindAckWire>;
	/**
	 * PRD-059c — remove the LOCAL folder binding for `path` (`POST /api/diagnostics/projects/unbind`).
	 * Capture stops for that folder; the registry project + its existing data are UNTOUCHED. Returns the
	 * `{ unbound, path }` ack; degrades to {@link FAILED_UNBIND_ACK} on a non-2xx / network failure.
	 */
	unbindProject(input: { path: string }): Promise<UnbindAckWire>;
	/**
	 * IRD-122 (122-AC-1/122-AC-2) — persist an ORG switch (`POST /api/diagnostics/scope/org-switch`).
	 * The daemon re-mints a fresh org-bound token (PRD-011) and saves it + the org to the shared
	 * credential — the SAME mechanic as `honeycomb org switch`, so `whoami` reflects it immediately. The
	 * ack carries the now-active org + `reminted` (NO token). Degrades to {@link FAILED_ORG_SWITCH_ACK}
	 * on a non-2xx / network failure so the switcher surfaces an honest "could not switch" (never a no-op).
	 */
	switchOrg(org: string): Promise<OrgSwitchAckWire>;
	/**
	 * IRD-122 — persist a WORKSPACE switch (`POST /api/diagnostics/scope/workspace-switch`). Writes only
	 * the shared credential's workspace id (NO re-mint — the workspace resolves server-side), exactly as
	 * `honeycomb workspace switch` does. Degrades to {@link FAILED_WORKSPACE_SWITCH_ACK} on failure.
	 */
	switchWorkspace(workspace: string): Promise<WorkspaceSwitchAckWire>;
}

/** The empty/zero KPIs the UI shows before the first load resolves (or on failure). */
export const EMPTY_KPIS: KpisWire = { memoryCount: 0, sessionCount: 0, turnCount: 0, estimatedSavings: 0, teamSkillCount: 0 };

/** The empty settings the header shows before the first load resolves. */
export const EMPTY_SETTINGS: SettingsWire = { orgId: "", orgName: "", workspace: "", settings: {} };

/** The empty graph (renders the kit's "no graph built" empty-state). */
export const EMPTY_GRAPH: GraphWire = { built: false, nodes: [], edges: [] };

/**
 * The client-side render cap (the graph memory cap — memory-aware). The daemon already bounds the
 * codebase graph (`GET /api/graph` ships ≤ ~750 nodes), but this is the shared defense-in-depth backstop
 * so NO consumer mounts an unbounded number of SVG node groups, whatever the source (a large memory
 * graph, an older uncapped daemon, a future endpoint). Set above the daemon budget so the daemon's cap
 * normally governs and this only catches outliers. Single source for both the full Graph page and the
 * mini-widget so the policy can never drift between them.
 */
export const MAX_RENDER_NODES = 1500;

/**
 * The companion EDGE cap. Nodes are `<g>` groups but edges are `<line>` elements — a dense graph under
 * the node cap can still carry hundreds of thousands of edges and lock up layout/SVG. So the helper
 * bounds edges too. Sized so nodes+edges together stay a few thousand SVG elements (well within budget).
 */
export const MAX_RENDER_EDGES = 5000;

/**
 * Bound a graph to {@link MAX_RENDER_NODES}-ish nodes AND {@link MAX_RENDER_EDGES} edges for rendering
 * (the shared cap helper). Within BOTH limits → returned unchanged (same ref, so a memoized layout is
 * not invalidated). Over EITHER → the first `limit` nodes plus at most `MAX_RENDER_EDGES` of the edges
 * whose both endpoints survive, with `capped:true`. Capping edges as well as nodes is what makes this a
 * real backstop: a dense graph (or an old uncapped daemon) can no longer flood the DOM with `<line>`s
 * even when the node count is bounded. Pure — order is whatever the caller already settled (the daemon
 * ships its bounded set importance-ranked, so "first N" here is already the meaningful head).
 */
export function capGraphForRender(graph: GraphWire, limit: number): { graph: GraphWire; capped: boolean } {
	const tooManyNodes = graph.nodes.length > limit;
	const tooManyEdges = graph.edges.length > MAX_RENDER_EDGES;
	if (!tooManyNodes && !tooManyEdges) return { graph, capped: false };
	const nodes = tooManyNodes ? graph.nodes.slice(0, limit) : graph.nodes;
	const kept = new Set(nodes.map((n) => n.id));
	// Keep only edges between surviving nodes, stopping at the edge budget so a dense subgraph can't
	// hand the canvas an unbounded `<line>` count.
	const edges: GraphWire["edges"] = [];
	for (const edge of graph.edges) {
		if (!kept.has(edge.from) || !kept.has(edge.to)) continue;
		edges.push(edge);
		if (edges.length >= MAX_RENDER_EDGES) break;
	}
	return { graph: { ...graph, nodes, edges }, capped: true };
}

/** The empty log-history page the table shows before the first load (or on failure / unavailable store). */
export const EMPTY_LOGS_HISTORY: LogsHistoryWire = Object.freeze({ records: [], count: 0, nextCursor: null, persistent: false });

/** The empty turns-history page the Turns section shows before the first load (or on failure). */
export const EMPTY_TURNS_HISTORY: TurnsHistoryWire = Object.freeze({ sessions: [], nextCursor: null });

/**
 * Build the `/api/logs/history` query string from the SET filters only (an undefined filter is
 * omitted so the daemon applies its default). Every value is `encodeURIComponent`-escaped so a
 * path/org/cursor with special characters is a safe single query value (never a query injection).
 */
export function buildHistoryQueryString(filters: LogsHistoryFilters): string {
	const parts: string[] = [];
	const add = (key: string, value: string | number | undefined): void => {
		if (value === undefined || value === "") return;
		parts.push(`${key}=${encodeURIComponent(String(value))}`);
	};
	add("since", filters.since);
	add("until", filters.until);
	add("status", filters.status);
	add("path", filters.path);
	add("org", filters.org);
	add("limit", filters.limit);
	add("cursor", filters.cursor);
	return parts.length > 0 ? `?${parts.join("&")}` : "";
}

/**
 * Build the typed wire client (AC-2..AC-6). The `origin` is prefixed onto every path so the
 * same app works same-origin (served by the host) or against an explicit daemon URL; the
 * `fetchImpl` is injected so a unit test drives the app with a mocked fetch and no live
 * network (the test contract). No method ever throws — every failure degrades to an empty
 * value so the UI shows an honest empty state instead of crashing.
 */
export function createWireClient(options: WireClientOptions = {}): WireClient {
	const origin = options.origin ?? "";
	const fetchImpl = options.fetchImpl ?? fetch;
	const url = (path: string): string => `${origin}${path}`;

	return {
		async kpis(projectId?: string): Promise<KpisWire> {
			// PRD-049e: stamp the selected-project header so the KPI band re-scopes on a dashboard scope
			// change (parity with graph/roi/recall/memories). An empty selection omits it → workspace-wide.
			return (await getJson(fetchImpl, url(ENDPOINTS.kpis), KpisSchema, projectHeader(projectId))) ?? EMPTY_KPIS;
		},
		async sessions(): Promise<SessionRowWire[]> {
			const v = await getJson(fetchImpl, url(ENDPOINTS.sessions), SessionsSchema);
			return v?.sessions ?? [];
		},
		async settings(): Promise<SettingsWire> {
			return (await getJson(fetchImpl, url(ENDPOINTS.settings), SettingsSchema)) ?? EMPTY_SETTINGS;
		},
		async rules(): Promise<RuleRowWire[]> {
			const v = await getJson(fetchImpl, url(ENDPOINTS.rules), RulesSchema);
			return v?.rules ?? [];
		},
		async skills(): Promise<SkillRowWire[]> {
			const v = await getJson(fetchImpl, url(ENDPOINTS.skills), SkillsSchema);
			return v?.skills ?? [];
		},
		async graph(projectId?: string): Promise<GraphWire> {
			// PRD-049e: stamp the selected-project header so the read re-scopes on a dashboard scope change.
			return (await getJson(fetchImpl, url(ENDPOINTS.graph), GraphSchema, projectHeader(projectId))) ?? EMPTY_GRAPH;
		},
		async memoryGraph(projectId?: string): Promise<GraphWire> {
			// Same shape as the codebase graph (a `GraphView`-shaped source) — validated through the
			// shared GraphSchema. A failure / `built:false` empty graph degrades to EMPTY_GRAPH so the
			// page renders the honest "no memory graph yet" state (never a throw). PRD-049e: project-stamped.
			return (await getJson(fetchImpl, url(ENDPOINTS.memoryGraph), GraphSchema, projectHeader(projectId))) ?? EMPTY_GRAPH;
		},
		async roi(projectId?: string): Promise<RoiView> {
			// The page is a PURE function of this; a failed/malformed body degrades to the honest-empty
			// view (every section `absent`, net NOT computed) so the page shows a dash, never `$0.00`.
			// PRD-049e: stamp the selected-project header so the read re-scopes on a dashboard scope change.
			return (await getJson(fetchImpl, url(ENDPOINTS.roi), RoiViewSchema, projectHeader(projectId))) ?? EMPTY_ROI_VIEW;
		},
		async roiTrend(range: string, projectId?: string): Promise<RoiTrendView> {
			// `range` selects the trend window (e.g. `30d`); it rides as a query param. A failed/malformed
			// body — or a genuine no-history-yet state — degrades to the honest-empty trend (never a throw).
			const qs = range !== "" ? `?range=${encodeURIComponent(range)}` : "";
			return (
				(await getJson(fetchImpl, url(`${ENDPOINTS.roiTrend}${qs}`), RoiTrendViewSchema, projectHeader(projectId))) ??
				EMPTY_ROI_TREND
			);
		},
		async recall(query: string, projectId?: string): Promise<{ memories: RecalledMemory[]; degraded: boolean }> {
			try {
				const res = await fetchImpl(url(ENDPOINTS.recall), {
					method: "POST",
					// PRD-049e: stamp the selected-project header so recall narrows to the dashboard's project.
					headers: { "content-type": "application/json", accept: "application/json", ...DASHBOARD_SESSION_HEADERS, ...projectHeader(projectId) },
					body: JSON.stringify({ query }),
				});
				if (!res.ok) return { memories: [], degraded: true };
				const parsed = RecallResponseSchema.safeParse(await res.json());
				if (!parsed.success) return { memories: [], degraded: true };
				// The engine already returns hits RANKED DESC by the fused RRF score (distilled
				// `[memory]` facts above raw `[sessions]` drill-downs). We render them in THAT
				// order verbatim — NO client-side re-sort — and carry the ENGINE `score` through
				// (PRD-027 AC-4 deleted the old `1 - i*0.06` fabrication). `kind`/`secondary` ride
				// along so the card can demote raw session rows. `scope`/`verified` stay derived
				// honestly from the arm name.
				const memories = parsed.data.hits.map((h, i) => ({
					memoryKey: h.id !== "" ? h.id : `hit-${i + 1}`,
					// A raw `session` hit's `text` is the JSONB capture turn (escaped JSON); humanize it to
					// one readable line so the card never shows the raw dump. A distilled fact passes through.
					snippet: formatRecallSnippet(h.text, h.kind),
					source: h.source,
					score: h.score,
					scope: scopeForSource(h.source),
					verified: h.source === "memories",
					kind: h.kind,
					secondary: h.secondary,
				}));
				return { memories, degraded: parsed.data.degraded };
			} catch {
				return { memories: [], degraded: true };
			}
		},
		async listMemories(limit = DEFAULT_MEMORY_LIST_LIMIT, projectId?: string): Promise<MemoryRecordWire[]> {
			// GET the scoped tenant's memories (newest-first); a malformed/absent body degrades to []
			// so the page renders its honest empty state. The daemon clamps `limit` to MAX_LIST_LIMIT.
			// PRD-049e: stamp the selected-project header so the list re-scopes to the dashboard's project.
			const v = await getJson(fetchImpl, url(`${ENDPOINTS.memories}?limit=${limit}`), MemoryListResponseSchema, projectHeader(projectId));
			return v?.memories ?? [];
		},
		async getMemory(id: string): Promise<MemoryRecordWire | null> {
			// A 404 (unknown OR forgotten id) → null via getJson's non-ok guard; the page renders the
			// honest "forgotten" state. The id is path-encoded so it is one safe segment.
			const v = await getJson(fetchImpl, url(`${ENDPOINTS.memories}/${encodeURIComponent(id)}`), MemoryGetResponseSchema);
			return v?.memory ?? null;
		},
		async addMemory(input: { content: string; type?: string; agentId?: string }): Promise<StoreAckWire | null> {
			// POST the store body (content + optional type/agent); the daemon's zod is the source of
			// truth (a 400 → null here, surfaced as "save failed"). The caller re-LISTS after a 201.
			const body: Record<string, string> = { content: input.content };
			if (input.type !== undefined) body.type = input.type;
			if (input.agentId !== undefined) body.agentId = input.agentId;
			return postJson(fetchImpl, url(ENDPOINTS.memories), body, StoreAckSchema);
		},
		async modifyMemory(id: string, input: { content: string; reason: string; agentId?: string }): Promise<WriteAckWire | null> {
			// POST content + the REQUIRED reason → a version-bumped, audited edit (never a hard-update).
			// A non-2xx (e.g. an empty reason the client should have caught) → null; the caller re-reads.
			const body: Record<string, string> = { content: input.content, reason: input.reason };
			if (input.agentId !== undefined) body.agentId = input.agentId;
			return postJson(fetchImpl, url(`${ENDPOINTS.memories}/${encodeURIComponent(id)}/modify`), body, WriteAckSchema);
		},
		async forgetMemory(id: string, input: { reason: string }): Promise<WriteAckWire | null> {
			// POST the required reason → a reason-gated soft-delete (a tombstone version). null on failure.
			return postJson(fetchImpl, url(`${ENDPOINTS.memories}/${encodeURIComponent(id)}/forget`), { reason: input.reason }, WriteAckSchema);
		},
		async compact(table?: string): Promise<CompactSummaryWire | null> {
			// POST the optional `{ table }` selector (omitted ⇒ all allow-listed tables). The daemon
			// matches it against its allow-list, so the page sends only a known name — no attacker SQL.
			const body = table !== undefined && table !== "" ? { table } : {};
			return postJson(fetchImpl, url(ENDPOINTS.compact), body, CompactSummarySchema);
		},
		async lifecycleConflicts(status = "open"): Promise<LifecycleConflictWire[]> {
			// GET the scoped conflict queue; a malformed/absent body degrades to []. `status` is
			// encodeURIComponent-escaped (one safe query value); the daemon scope-filters the read.
			const v = await getJson(
				fetchImpl,
				url(`${ENDPOINTS.lifecycleConflicts}?status=${encodeURIComponent(status)}`),
				LifecycleConflictsResponseSchema,
			);
			return v?.conflicts ?? [];
		},
		async resolveConflict(id: string, input: { verdict: string; winnerId?: string; reason?: string }): Promise<boolean> {
			try {
				// POST the 058b resolve endpoint — the SAME path/code the CLI uses (no parallel logic).
				// The id is path-encoded (one safe segment); the verdict/winner/reason ride the body.
				const body: Record<string, string> = { verdict: input.verdict };
				if (input.winnerId !== undefined && input.winnerId !== "") body.winnerId = input.winnerId;
				if (input.reason !== undefined && input.reason !== "") body.reason = input.reason;
				const res = await fetchImpl(url(`${ENDPOINTS.lifecycleConflicts}/${encodeURIComponent(id)}/resolve`), {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json", ...DASHBOARD_SESSION_HEADERS },
					body: JSON.stringify(body),
				});
				// 2xx → accepted; any non-2xx (400 invalid verdict, 404 not found, 409 already resolved)
				// reads as "not accepted" so the caller re-reads + polls rather than optimistically flipping.
				return res.ok;
			} catch {
				return false;
			}
		},
		async lifecycleStaleRefs(): Promise<LifecycleStaleRefWire[]> {
			const v = await getJson(fetchImpl, url(ENDPOINTS.lifecycleStaleRefs), LifecycleStaleRefsResponseSchema);
			return v?.staleRefs ?? [];
		},
		async lifecycleHistory(): Promise<LifecycleHistoryWire[]> {
			const v = await getJson(fetchImpl, url(`${ENDPOINTS.lifecycleHistory}?type=lifecycle`), LifecycleHistoryResponseSchema);
			return v?.history ?? [];
		},
		async calibration(): Promise<CalibrationWire> {
			return (await getJson(fetchImpl, url(ENDPOINTS.calibration), CalibrationSchema)) ?? EMPTY_CALIBRATION;
		},
		async logs(limit = 40): Promise<LogRecordWire[]> {
			const v = await getJson(fetchImpl, url(`${ENDPOINTS.logs}?limit=${limit}`), LogsResponseSchema);
			return v?.records ?? [];
		},
		logsStream(onRecord: (record: LogRecordWire) => void): () => void {
			// FOLLOW the SSE tail (c-AC-2). Guard for the non-browser env (jsdom/SSR has no EventSource):
			// degrade to an inert no-op so the page keeps its snapshot and tests never crash. The
			// `event: "log"` records are parsed through the SAME zod schema as the snapshot, so a malformed
			// frame is dropped (never thrown into React). The returned unsubscribe closes the stream.
			const ES = (globalThis as { EventSource?: typeof EventSource }).EventSource;
			if (ES === undefined) return () => {};
			let source: EventSource;
			try {
				source = new ES(url(ENDPOINTS.logsStream));
			} catch {
				return () => {};
			}
			const handler = (ev: MessageEvent): void => {
				const record = parseLogRecordEvent(ev.data);
				if (record !== null) onRecord(record);
			};
			source.addEventListener("log", handler as EventListener);
			return () => {
				try {
					source.removeEventListener("log", handler as EventListener);
					source.close();
				} catch {
					// Closing an already-closed/errored EventSource must never throw into unmount.
				}
			};
		},
		async logsHistory(filters: LogsHistoryFilters = {}): Promise<LogsHistoryWire> {
			// Build the query string from only the SET filters (an undefined filter is omitted, so the
			// daemon applies its default). A malformed/absent body degrades to the empty page.
			const qs = buildHistoryQueryString(filters);
			const v = await getJson(fetchImpl, url(`${ENDPOINTS.logs}/history${qs}`), LogsHistoryResponseSchema);
			return v ?? EMPTY_LOGS_HISTORY;
		},
		async turnsHistory(opts: { limit?: number; cursor?: string } = {}): Promise<TurnsHistoryWire> {
			const parts: string[] = [];
			if (opts.limit !== undefined) parts.push(`limit=${encodeURIComponent(String(opts.limit))}`);
			if (opts.cursor !== undefined && opts.cursor !== "") parts.push(`cursor=${encodeURIComponent(opts.cursor)}`);
			const qs = parts.length > 0 ? `?${parts.join("&")}` : "";
			const v = await getJson(fetchImpl, url(`${ENDPOINTS.sessions}${qs}`), TurnsHistoryResponseSchema);
			return v ?? EMPTY_TURNS_HISTORY;
		},
		async harnesses(): Promise<HarnessStatusWire[]> {
			// GET the six canonical harness statuses; a malformed/absent body degrades to the empty
			// list so the page renders its honest empty/zero state (never a throw). Single backbone (D-3).
			const v = await getJson(fetchImpl, url(ENDPOINTS.harnesses), HarnessStatusResponseSchema);
			return v?.harnesses ?? [];
		},
		async assetsView(): Promise<AssetSyncViewWire> {
			// GET the union view-model; a malformed/absent body degrades to the empty view so the page
			// renders its honest empty state (never a throw). No secret rides this shape (zod-validated).
			return (await getJson(fetchImpl, url(ENDPOINTS.assets), AssetSyncViewSchema)) ?? EMPTY_ASSET_SYNC_VIEW;
		},
		async syncAction(
			action: "promote" | "pull" | "demote" | "enable" | "disable",
			input: { assetType: "skill" | "agent"; name: string; native?: string; honeycombId?: string; harness?: string },
		): Promise<SyncActionResultWire | null> {
			// POST the action body; the daemon performs the REAL pipeline + a poll-convergent read-back
			// and returns the converged ack. A non-2xx → null (the caller re-reads the union — no
			// optimistic flip). The body carries no secret; the daemon resolves tenancy from the session.
			const body: Record<string, string> = { assetType: input.assetType, name: input.name };
			if (input.native !== undefined) body.native = input.native;
			if (input.honeycombId !== undefined && input.honeycombId !== "") body.honeycombId = input.honeycombId;
			if (input.harness !== undefined && input.harness !== "") body.harness = input.harness;
			return postJson(fetchImpl, url(`${ENDPOINTS.syncAction}/${action}`), body, SyncActionResultSchema);
		},
		async health(): Promise<HealthProbe> {
			try {
				const res = await fetchImpl(url(ENDPOINTS.health), { headers: { accept: "application/json", ...DASHBOARD_SESSION_HEADERS } });
				// Liveness is the HTTP status (a 503-on-degraded still has a parseable body);
				// the existing view-swap keys off this `up` flag, unchanged (PRD-029 is additive).
				const up = res.ok;
				// Parse the body for the additive PRD-029 `reasons`. Every failure mode — a
				// non-JSON body (the bare "" the 503 path and some 200s send), a malformed shape,
				// an absent `reasons` (the mode-gated public body) — degrades to `null` reasons
				// (coarse pill only), NEVER a throw. The IO boundary is fully defended.
				let reasons: HealthReasonsWire | null = null;
				try {
					const body: unknown = await res.json();
					const parsed = HealthBodySchema.safeParse(body);
					reasons = parsed.success ? parsed.data.reasons ?? null : null;
				} catch {
					reasons = null;
				}
				return { up, reasons };
			} catch {
				return { up: false, reasons: null };
			}
		},
		async pollinate(): Promise<PollinateAck> {
			try {
				const res = await fetchImpl(url(ENDPOINTS.pollinate), { method: "POST", headers: { ...DASHBOARD_SESSION_HEADERS } });
				const parsed = PollinateAckSchema.safeParse(await res.json());
				return parsed.success ? parsed.data : { triggered: false, status: "skipped", reason: "unavailable" };
			} catch {
				return { triggered: false, status: "skipped", reason: "unavailable" };
			}
		},
		async buildGraph(): Promise<BuildGraphAck> {
			// POST the build trigger, mirroring pollinate()'s header stamping. The build is SLOW (whole-repo
			// tree-sitter parse), so we give this call its OWN generous abort timeout — the default fetch must
			// not abort a legitimate in-progress build. A non-2xx (incl. the 500 `{ error, reason }` body), a
			// timeout/abort, a network error, or a malformed body all degrade to the failure ack (never a throw).
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), BUILD_GRAPH_TIMEOUT_MS);
			try {
				const res = await fetchImpl(url(ENDPOINTS.graphBuild), {
					method: "POST",
					headers: { accept: "application/json", ...DASHBOARD_SESSION_HEADERS },
					signal: ac.signal,
				});
				if (!res.ok) return FAILED_BUILD_GRAPH_ACK;
				const parsed = BuildGraphAckSchema.safeParse(await res.json());
				return parsed.success ? parsed.data : FAILED_BUILD_GRAPH_ACK;
			} catch {
				// A timeout/abort, network error, or non-JSON body → the honest failure ack.
				return FAILED_BUILD_GRAPH_ACK;
			} finally {
				clearTimeout(timer);
			}
		},
		async vaultSettings(): Promise<VaultSettingsWire> {
			// GET the `setting` class + catalog; a malformed/absent body degrades to the empty
			// view (nothing selected, no catalog) so the panel renders its empty state, never throws.
			return (await getJson(fetchImpl, url(ENDPOINTS.vaultSettings), VaultSettingsSchema)) ?? EMPTY_VAULT_SETTINGS;
		},
		async setSetting(key: string, value: SettingValueWire): Promise<boolean> {
			try {
				// POST /api/settings/:key with a JSON `{ value }` body — the Wave-1 handler's shape.
				// The key is path-encoded so a `dashboard.*` dotted key (or any caller key) is a safe
				// single path segment. The panel only ever sends its own known keys.
				const res = await fetchImpl(url(`${ENDPOINTS.vaultSettings}/${encodeURIComponent(key)}`), {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json", ...DASHBOARD_SESSION_HEADERS },
					body: JSON.stringify({ value }),
				});
				// The daemon answers 201 on a successful write; any non-2xx (400 invalid value,
				// 502 store failure) reads as "not accepted" so the caller does not optimistically
				// reflect an un-persisted change — it re-reads and shows whatever actually persisted.
				return res.ok;
			} catch {
				return false;
			}
		},
		async secretNames(): Promise<string[]> {
			// Names-only (D-4): the panel uses this purely for provider-key PRESENCE. A failure
			// degrades to an empty list → every provider shows "not set" (never a throw, never a value).
			const v = await getJson(fetchImpl, url(ENDPOINTS.secrets), SecretNamesSchema);
			return v?.names ?? [];
		},
		async setSecret(name: string, value: string): Promise<boolean> {
			try {
				// POST /api/secrets/:name with a JSON `{ value }` body — the secrets handler's shape.
				// The name is path-encoded so a conventional key name is one safe segment (the daemon
				// also validates `[A-Za-z0-9_.-]+`, traversal-proof). The value rides the body and is
				// NEVER echoed: the daemon's 201 returns the NAME only, so nothing here reads a value
				// back (AC-3 write-only). We deliberately do NOT parse/return the response body — a
				// boolean accept is all the caller needs (it re-reads `secretNames` for presence).
				const res = await fetchImpl(url(`${ENDPOINTS.secrets}/${encodeURIComponent(name)}`), {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json", ...DASHBOARD_SESSION_HEADERS },
					body: JSON.stringify({ value }),
				});
				// 2xx (the daemon answers 201) → accepted; any non-2xx (400 invalid name/value, 502
				// store failure) reads as "not accepted" so the caller surfaces "not accepted" and the
				// input is NOT cleared on a rejected write.
				return res.ok;
			} catch {
				// A network error → not accepted (never a throw into React).
				return false;
			}
		},
		async logout(): Promise<boolean> {
			// POST the logout action; the daemon removes the shared + legacy credential files. A 2xx +
			// `{ ok: true }` is success; any non-2xx / network failure → false (the section stays as-is).
			const ack = await postJson(fetchImpl, url(ENDPOINTS.actionsLogout), {}, ActionOkSchema);
			return ack?.ok === true;
		},
		async setEmbeddings(enabled: boolean): Promise<boolean> {
			// POST the toggle; the daemon actuates the supervisor live + persists the choice. Success is a
			// 2xx whose echoed `enabled` matches the request; a non-2xx / network failure → false.
			const ack = await postJson(fetchImpl, url(ENDPOINTS.actionsEmbeddings), { enabled }, EmbeddingsActionSchema);
			return ack?.ok === true && ack.enabled === enabled;
		},
		async restartDaemon(): Promise<boolean> {
			// POST the restart; the daemon respawns + shuts down. Success is a 2xx `{ restarting: true }`.
			// (The connection may drop as the daemon goes down right after — postJson degrades that to null.)
			const ack = await postJson(fetchImpl, url(ENDPOINTS.actionsRestart), {}, RestartActionSchema);
			return ack?.restarting === true;
		},
		async uninstall(): Promise<UninstallResultWire | null> {
			// POST the uninstall; the daemon returns the guided result (detected harnesses + the CLI
			// command). A non-2xx / network / malformed body → null (the page shows an honest error).
			return postJson(fetchImpl, url(ENDPOINTS.actionsUninstall), {}, UninstallResultSchema);
		},
		async authStatus(): Promise<AuthStatusWire> {
			// GET the redacted auth status; a malformed/absent/failed body degrades to the
			// disconnected status so the section renders its honest "Not connected" state (never a
			// throw — AC-4). The schema has NO token field, so a token in the body is dropped.
			return (await getJson(fetchImpl, url(ENDPOINTS.authStatus), AuthStatusSchema)) ?? DISCONNECTED_AUTH_STATUS;
		},
		async setupState(): Promise<SetupStateWire> {
			// GET the guided-setup state; a malformed/absent/failed body OR a non-local 404 (getJson's
			// non-ok guard → null) degrades to the FRESH-INSTALL state so the shell renders the
			// guided-setup wizard (the safe default, b-AC-6), never a throw. No token rides this body.
			return (await getJson(fetchImpl, url(ENDPOINTS.setupState), SetupStateSchema)) ?? FRESH_SETUP_STATE;
		},
		async setupLogin(): Promise<SetupLoginWire | null> {
			// POST to begin the device flow; the daemon returns user_code + URIs the moment the grant
			// arrives (it keeps polling → persist in the background). A 502 (device-flow-unavailable) or
			// a network failure → null (the button shows an honest error). The body carries NO token.
			return postJson(fetchImpl, url(ENDPOINTS.setupLogin), {}, SetupLoginSchema);
		},
			async migrateFromHivemind(): Promise<SetupMigrateWire> {
				// POST the migration trigger; the daemon runs the guarded backup->uninstall->adopt transaction
				// and returns the terminal phase + message + backup path (+ needsLogin/migrated flags). A non-2xx
				// / network / malformed body degrades to the honest failure ack (never a throw). NO token rides it.
				return (await postJson(fetchImpl, url(ENDPOINTS.setupMigrate), {}, SetupMigrateSchema)) ?? FAILED_SETUP_MIGRATE;
			},
			async rollbackMigration(): Promise<SetupMigrateRollbackWire> {
				// POST the rollback trigger (the d-AC-7 affordance); the daemon restores the backup + stamps
				// migration.phase rolled_back. A failure degrades to the honest rollback-unavailable ack.
				return (
					(await postJson(fetchImpl, url(ENDPOINTS.setupMigrateRollback), {}, SetupMigrateRollbackSchema)) ??
					FAILED_SETUP_MIGRATE_ROLLBACK
				);
			},
			async scopeOrgs(): Promise<ScopeOrgWire[]> {
				// GET the privilege-scoped org list; a failed/absent/non-local read degrades to [] so the
				// switcher shows an empty/needs-login state (never a throw). No token rides the body.
				const v = await getJson(fetchImpl, url(ENDPOINTS.scopeOrgs), ScopeOrgsSchema);
				return v?.orgs ?? [];
			},
			async scopeWorkspaces(org?: string): Promise<ScopeWorkspacesWire> {
				// GET the org's workspaces; the daemon re-mints the org-bound token (PRD-011) before
				// enumerating when `org` differs from its credential org (49e-AC-3). A failed read degrades
				// to an empty workspace list. The `org` query is encodeURIComponent-escaped (one safe value).
				const qs = org !== undefined && org !== "" ? `?org=${encodeURIComponent(org)}` : "";
				const v = await getJson(fetchImpl, url(`${ENDPOINTS.scopeWorkspaces}${qs}`), ScopeWorkspacesSchema);
				return v ?? { workspaces: [], org: org ?? "", reminted: false };
			},
			async scopeProjects(opts: { unbound?: boolean } = {}): Promise<ScopeProjectWire[]> {
				// GET the workspace's synced registry projects (049a cache). `unbound` stamps `?unbound=1`
				// for the 059d import list (registry-only projects). A failed/absent read degrades to [] so
				// the switcher shows no projects (and the pages render the needs-selection state).
				const qs = opts.unbound === true ? "?unbound=1" : "";
				const v = await getJson(fetchImpl, url(`${ENDPOINTS.scopeProjects}${qs}`), ScopeProjectsSchema);
				return v?.projects ?? [];
			},
			async fsBrowse(path?: string): Promise<BrowseBodyWire> {
				// GET the daemon-served dirs-only tree (059b). The `path` query is encodeURIComponent-escaped
				// (one safe value). A failed/absent/non-local (404) read degrades to EMPTY_BROWSE so the picker
				// renders its honest empty/unavailable state (the CLI fallback — b-AC-5), never a throw.
				const qs = path !== undefined && path !== "" ? `?path=${encodeURIComponent(path)}` : "";
				return (await getJson(fetchImpl, url(`${ENDPOINTS.fsBrowse}${qs}`), BrowseBodySchema)) ?? EMPTY_BROWSE;
			},
			async bindProject(input: { path: string; name?: string }): Promise<BindAckWire> {
				// POST the chosen absolute path (+ optional name) → bind a NEW/named project (059b). The
				// daemon's zod is the source of truth (a 400 degrades to the failed ack). NO secret in the body.
				const body: Record<string, string> = { path: input.path };
				if (input.name !== undefined && input.name !== "") body.name = input.name;
				return (await postJson(fetchImpl, url(ENDPOINTS.projectsBind), body, BindAckSchema)) ?? FAILED_BIND_ACK;
			},
			async bindExistingProject(input: { path: string; projectId: string }): Promise<BindAckWire> {
				// POST the chosen absolute path + the existing registry project_id → the 059d import. A non-2xx
				// degrades to the failed ack so the modal surfaces an honest error (never an optimistic flip).
				const body = { path: input.path, projectId: input.projectId };
				return (await postJson(fetchImpl, url(ENDPOINTS.projectsBindExisting), body, BindAckSchema)) ?? FAILED_BIND_ACK;
			},
			async unbindProject(input: { path: string }): Promise<UnbindAckWire> {
				// POST the absolute path → remove the LOCAL binding only (059c); the registry row is untouched.
				// A non-2xx degrades to the failed ack so the page re-reads and reflects what actually persisted.
				return (await postJson(fetchImpl, url(ENDPOINTS.projectsUnbind), { path: input.path }, UnbindAckSchema)) ?? FAILED_UNBIND_ACK;
			},
			async switchOrg(org: string): Promise<OrgSwitchAckWire> {
				// POST the target org → the daemon re-mints + persists (IRD-122 / 122-AC-2). A non-2xx /
				// network failure degrades to the failed ack so the switcher shows an honest "could not
				// switch" rather than a silent no-op (122-AC-4). NO token rides the ack.
				return (await postJson(fetchImpl, url(ENDPOINTS.scopeOrgSwitch), { org }, OrgSwitchAckSchema)) ?? FAILED_ORG_SWITCH_ACK;
			},
			async switchWorkspace(workspace: string): Promise<WorkspaceSwitchAckWire> {
				// POST the target workspace → the daemon persists the workspace id (no re-mint). A failure
				// degrades to the failed ack so the switcher surfaces an honest error, never a no-op.
				return (await postJson(fetchImpl, url(ENDPOINTS.scopeWorkspaceSwitch), { workspace }, WorkspaceSwitchAckSchema)) ?? FAILED_WORKSPACE_SWITCH_ACK;
			},
	};
}

/**
 * PRD-042c — parse one SSE `event: "log"` frame's `data` payload (a JSON-stringified
 * {@link RequestLogRecord}) into a validated {@link LogRecordWire}, or `null` on any malformed /
 * non-JSON / shape-mismatch frame. Validated through the SAME {@link LogRecordSchema} the snapshot
 * uses, so the SSE tail and the backfill agree on the shape and a bad frame is DROPPED (never thrown
 * into React). Exported so the page can drive the follow-handler deterministically in tests without a
 * live EventSource. No secret rides a record by construction (logger.ts).
 */
export function parseLogRecordEvent(data: unknown): LogRecordWire | null {
	if (typeof data !== "string") return null;
	try {
		const parsed = LogRecordSchema.safeParse(JSON.parse(data));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/**
 * Format one `/api/logs` record into a single mono log line for the LiveLog panel. The
 * record carries NO token/secret/header (the logger redacts by construction); this
 * formatter introduces none either — it renders only time + method + path + status (AC-4).
 */
export function formatLogLine(r: LogRecordWire): string {
	const time = (r.time || "").slice(11, 19) || (r.time || "").slice(0, 8);
	const status = r.status > 0 ? ` ${r.status}` : "";
	return `${time}  ${r.method} ${r.path}${status}`.trimEnd();
}

/**
 * PRD-042c — the `/api/logs` path prefix the Sync activity feed filters on. The Sync action POSTs
 * land on `/api/diagnostics/sync/{promote,pull,demote,enable,disable}`, and the daemon's
 * request-logging middleware records EACH (method + path + status, no secret) into the same
 * `/api/logs` ring buffer the feed reads. Filtering on this prefix yields exactly the sync events
 * (publish/pull/tombstone), newest first, with no parallel event store (D-6).
 */
export const SYNC_ACTIVITY_PATH = "/api/diagnostics/sync/" as const;

/** True iff a `/api/logs` record is a Sync action event (its path is under {@link SYNC_ACTIVITY_PATH}). */
export function isSyncActivityRecord(r: LogRecordWire): boolean {
	return (r.path ?? "").startsWith(SYNC_ACTIVITY_PATH);
}

/**
 * PRD-042c — the human action label for a Sync activity record's path (`promote` → "published",
 * `pull` → "pulled", `demote` → "tombstoned"). The status code drives the success/failure flavor at
 * the render site. No secret is in a record (logger.ts), so the formatted line is safe to render.
 */
export function syncActivityVerb(r: LogRecordWire): string {
	const tail = (r.path ?? "").slice(SYNC_ACTIVITY_PATH.length).split("/")[0] ?? "";
	switch (tail) {
		case "promote":
			return "published";
		case "pull":
			return "pulled";
		case "demote":
			return "tombstoned";
		case "enable":
			return "enabled";
		case "disable":
			return "disabled";
		default:
			return tail;
	}
}

/**
 * Daemon-served dashboard contracts + seams — PRD-020b Wave 1 (the view-data layer).
 *
 * ── THE THESIS (FR-1..FR-9 / a-AC-1 / a-AC-2 / D-2 / D-6) ────────────────────
 *   The dashboard renders KPIs, sessions, settings, the codebase graph, rules, and
 *   skill-sync state — ALL read through the daemon. It is a THIN CLIENT: every view
 *   pulls its view-model from the {@link DashboardDataSource} SEAM (daemon-served),
 *   never opening DeepLake and holding NO storage logic (a-AC-7). When the daemon is
 *   unreachable, the dashboard surfaces a clear {@link Connectivity} state rather than
 *   hanging or showing blank panels (FR-8 / a-AC-2). `src/dashboard` is a
 *   NON_DAEMON_ROOT (D-2; `tests/daemon/storage/invariant.test.ts`).
 *
 * ── D-6 — CANONICAL view layer shared with the Cursor webview ────────────────
 *   These view-models + the view-builders that render them are the CANONICAL
 *   implementation 020c's extension webview EMBEDS (a-AC-5 / c-AC-6). Both surfaces
 *   read the SAME {@link DashboardData} from the SAME daemon data contract — no
 *   duplicate view code. The view-builders are pure (data → render tree), so the CLI
 *   `dashboard` verb and the Cursor webview render identically.
 *
 * ── What Wave 1 ships ────────────────────────────────────────────────────────
 *   The {@link DashboardData} view-model contract (the six view-models), the
 *   {@link DashboardDataSource} seam + {@link createFakeDashboardDataSource} fake, the
 *   {@link Connectivity} state type, and one honest-stub view-builder per view (in
 *   sibling modules). Wave 2 fills the view-builders + the daemon-side
 *   `mountDashboardApi` endpoints (scaffolded in `src/daemon/`). Every export is STABLE.
 */

/** Honest-stub thrower — an early call FAILS LOUD with a stable, greppable message. */
export function notImplemented(what: string): never {
	throw new Error(`PRD-020b: not implemented — ${what}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// The six view-models (FR-2..FR-6) — what the daemon serves, what the views render
// ─────────────────────────────────────────────────────────────────────────────

/** The KPIs view-model (FR-2): org-level memory metrics. */
export interface KpisView {
	/** Total memories stored (org-scoped). */
	readonly memoryCount: number;
	/** Total captured sessions. */
	readonly sessionCount: number;
	/** Estimated token/cost savings (the org savings metric). */
	readonly estimatedSavings: number;
	/** Free-form additional org metrics, label → value (kept open for Wave-2 additions). */
	readonly extra?: Readonly<Record<string, number>>;
}

/** One captured session row in the sessions view (FR-3). */
export interface SessionRow {
	/** The session id. */
	readonly sessionId: string;
	/** The project path the session ran in. */
	readonly project: string;
	/** When the session started (ISO). */
	readonly startedAt: string;
	/** The captured event count. */
	readonly eventCount: number;
	/** The session status (e.g. `captured`, `summarized`). */
	readonly status: string;
}

/** The sessions view-model (FR-3): captured sessions with metadata. */
export interface SessionsView {
	/** The session rows, newest first. */
	readonly sessions: readonly SessionRow[];
}

/** The settings view-model (FR-4): active org + workspace configuration. */
export interface SettingsView {
	/** The active org id. */
	readonly orgId: string;
	/** The active org display name. */
	readonly orgName: string;
	/** The active workspace. */
	readonly workspace: string;
	/** Selected daemon/runtime settings exposed to the operator (label → value). */
	readonly settings: Readonly<Record<string, string>>;
}

/** A node in the codebase-graph canvas (FR-5). */
export interface GraphNode {
	/** The node id (stable across renders). */
	readonly id: string;
	/** The display label (e.g. a symbol or file name). */
	readonly label: string;
	/** The node kind (e.g. `file`, `function`, `class`). */
	readonly kind: string;
}

/** An edge in the codebase-graph canvas (FR-5). */
export interface GraphEdge {
	/** The source node id. */
	readonly from: string;
	/** The target node id. */
	readonly to: string;
	/** The edge kind (e.g. `imports`, `calls`). */
	readonly kind: string;
}

/**
 * The codebase-graph view-model (FR-5 / a-AC-3 / a-AC-6). `built` is false when no graph
 * has been built for the workspace → the view shows the empty-state prompt to run
 * `honeycomb graph build` rather than an error (a-AC-6). When `built`, the canvas renders
 * from the nodes/edges the daemon's graph endpoints serve.
 */
export interface GraphView {
	/** True when a graph has been built for the workspace (FR-5 / a-AC-6). */
	readonly built: boolean;
	/** The graph nodes (empty when not built). */
	readonly nodes: readonly GraphNode[];
	/** The graph edges (empty when not built). */
	readonly edges: readonly GraphEdge[];
}

/** One org-wide rule in the rules view (FR-6 / a-AC-4). */
export interface RuleRow {
	/** The rule id. */
	readonly id: string;
	/** The rule's human title. */
	readonly title: string;
	/** True when the rule is active. */
	readonly active: boolean;
}

/** The rules view-model (FR-6 / a-AC-4): the org-wide rules from `honeycomb_rules`. */
export interface RulesView {
	/** The active org rules. */
	readonly rules: readonly RuleRow[];
}

/** One skill in the skill-sync view (FR-6). */
export interface SkillSyncRow {
	/** The skill name. */
	readonly name: string;
	/** The skill scope (`org` | `team` | `personal`). */
	readonly scope: string;
	/** The sync state (`pulled` | `shared` | `pending`). */
	readonly syncState: string;
}

/** The skill-sync view-model (FR-6): pulled + shared team skills. */
export interface SkillSyncView {
	/** The skills and their sync state. */
	readonly skills: readonly SkillSyncRow[];
}

/**
 * THE FULL DASHBOARD VIEW-MODEL (FR-2..FR-6 / a-AC-1). The six view-models the daemon
 * serves and the views render. This is the CANONICAL contract 020c's webview embeds (D-6):
 * the same shape feeds the daemon-served dashboard and the Cursor webview, so both surfaces
 * render identically with no duplicate view code.
 */
export interface DashboardData {
	/** KPIs (FR-2). */
	readonly kpis: KpisView;
	/** Sessions (FR-3). */
	readonly sessions: SessionsView;
	/** Settings (FR-4). */
	readonly settings: SettingsView;
	/** Codebase graph (FR-5). */
	readonly graph: GraphView;
	/** Org rules (FR-6). */
	readonly rules: RulesView;
	/** Skill-sync state (FR-6). */
	readonly skillSync: SkillSyncView;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connectivity — the clear daemon-down state (FR-8 / a-AC-2 / D-6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE CONNECTIVITY STATE (FR-8 / a-AC-2). When the daemon is reachable the dashboard
 * renders the views; when it is NOT, it surfaces this state (a banner with the daemon URL
 * + a retry affordance) instead of hanging or showing blank panels. The state reuses the
 * SAME daemon-reachability probe the D1/D2 health dimensions use (020d), so the message is
 * consistent across surfaces. `reachable: false` carries the `url` + a `retry` affordance.
 */
export type Connectivity =
	| { readonly reachable: true; readonly url: string }
	| { readonly reachable: false; readonly url: string; readonly retry: true; readonly detail?: string };

/** Build a reachable connectivity state. */
export function reachable(url: string): Connectivity {
	return { reachable: true, url };
}

/** Build an unreachable connectivity state (banner + retry, FR-8 / a-AC-2). */
export function unreachable(url: string, detail?: string): Connectivity {
	return { reachable: false, url, retry: true, ...(detail !== undefined ? { detail } : {}) };
}

// ─────────────────────────────────────────────────────────────────────────────
// DashboardDataSource — the daemon-served data seam (FR-7 / a-AC-1 / D-2 / D-6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE DATA SEAM (FR-7 / a-AC-1 / D-2). Every view reads its view-model ONLY through this.
 * The real impl fetches each view from the daemon's dashboard endpoints (`/api/diagnostics`,
 * `/api/kpis`, `/api/sessions`, `/api/graph`, `/api/rules`, `/api/skills`); the fake replays
 * a canned {@link DashboardData} / connectivity for view tests. The source NEVER opens
 * DeepLake — the daemon does, behind these endpoints. The SAME source feeds the Cursor
 * webview (D-6), so both surfaces share the data contract.
 */
export interface DashboardDataSource {
	/** Probe daemon reachability (reuses the 020d D1/D2 probe) → the connectivity state (FR-8). */
	probe(): Promise<Connectivity>;
	/** Fetch the full dashboard view-model from the daemon (FR-7 / a-AC-1). */
	fetchAll(): Promise<DashboardData>;
}

/** Options seeding the fake: the canned data + an optional unreachable connectivity. */
export interface FakeDashboardDataSourceOptions {
	/** The canned dashboard data (defaults to an empty-but-valid shape). */
	readonly data?: DashboardData;
	/** Force an unreachable probe (daemon-down test, a-AC-2). Defaults to reachable. */
	readonly down?: boolean;
	/** The daemon url the connectivity state reports. */
	readonly url?: string;
}

/** An empty-but-valid {@link DashboardData} (the fake default + a Wave-2 loading placeholder). */
export const EMPTY_DASHBOARD_DATA: DashboardData = Object.freeze({
	kpis: { memoryCount: 0, sessionCount: 0, estimatedSavings: 0 },
	sessions: { sessions: [] },
	settings: { orgId: "", orgName: "", workspace: "", settings: {} },
	graph: { built: false, nodes: [], edges: [] },
	rules: { rules: [] },
	skillSync: { skills: [] },
});

/**
 * Build a fake {@link DashboardDataSource} (the seam Wave-2 view tests drive). Replays a
 * canned {@link DashboardData} and a reachable/unreachable connectivity, so a test asserts
 * the views render from the data (a-AC-1), the daemon-down banner shows (a-AC-2), and the
 * no-graph empty-state fires (a-AC-6) — all without a live daemon.
 */
export function createFakeDashboardDataSource(options: FakeDashboardDataSourceOptions = {}): DashboardDataSource {
	const url = options.url ?? "http://127.0.0.1:3850";
	const data = options.data ?? EMPTY_DASHBOARD_DATA;
	const down = options.down ?? false;
	return {
		async probe(): Promise<Connectivity> {
			return down ? unreachable(url, "daemon not reachable") : reachable(url);
		},
		async fetchAll(): Promise<DashboardData> {
			if (down) return notImplemented("fetchAll called while daemon down — caller must branch on probe() first");
			return data;
		},
	};
}

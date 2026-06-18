/**
 * The canonical dashboard view-builders — PRD-020b (FR-2..FR-6 / FR-9 / D-6).
 *
 * These are the PURE render functions (view-model → render tree) that BOTH the
 * daemon-served dashboard and the Cursor extension webview (020c) use — the CANONICAL
 * view layer (D-6 / b-AC-5 / c-AC-6). They are framework-agnostic: each returns a
 * {@link ViewBlock} tree a host (webview / TUI) paints, so there is ONE implementation of
 * each view, not one per surface.
 *
 * They are pure (no IO, no daemon, no DeepLake) — the data already came through the
 * {@link DashboardDataSource} seam. A test asserts the returned `ViewBlock` STRUCTURE
 * (kind / title / rows / children / data) WITHOUT a DOM, which is what keeps the same
 * builders feeding both surfaces.
 *
 * ── STABLE RENDER CONTRACT (D-6 — 020c embeds this) ──────────────────────────
 *   `ViewBlock` and the six `build<View>View(view): ViewBlock` signatures are FROZEN.
 *   020c's `DashboardWebviewRenderer` consumes `renderDashboard(...)` → the `ViewBlock[]`
 *   these produce. Adding optional `ViewBlock` fields is additive-safe; renaming a `kind`,
 *   removing a field, or changing a builder's signature is a breaking change for 020c.
 */

import {
	type GraphView,
	type KpisView,
	type RulesView,
	type SessionsView,
	type SettingsView,
	type SkillSyncView,
} from "./contracts.js";

/**
 * A framework-agnostic render block (D-6). A view-builder returns a tree of these; the host
 * (webview HTML / TUI text) paints it. Keeping the render tree abstract is what lets ONE
 * builder feed both the daemon-served dashboard and the Cursor webview without duplicate code.
 *
 * STABLE: 020c embeds these. `kind` values are part of the contract — a host switches on them.
 */
export interface ViewBlock {
	/** The block kind (e.g. `panel`, `table`, `metric`, `empty-state`, `graph-canvas`). */
	readonly kind: string;
	/** A human title for the block, when any. */
	readonly title?: string;
	/** Flat text rows (for tables / metrics / empty-state copy). */
	readonly rows?: readonly string[];
	/** Nested child blocks. */
	readonly children?: readonly ViewBlock[];
	/** Arbitrary view-specific payload (e.g. the graph nodes/edges for a canvas host). */
	readonly data?: unknown;
}

/**
 * The empty-state copy the graph view shows when no graph has been built (b-AC-6). It prompts
 * the operator to run `honeycomb graph build` — it is NOT an error. STABLE so 020c shows the
 * same prompt; the command string is part of the contract.
 */
export const GRAPH_BUILD_PROMPT = "Run `honeycomb graph build` to build the codebase graph." as const;

/** Build the KPIs panel (FR-2). Renders memory/session counts + savings + any extra org metrics. */
export function buildKpisView(view: KpisView): ViewBlock {
	const rows: string[] = [
		`Memories: ${view.memoryCount}`,
		`Sessions: ${view.sessionCount}`,
		`Estimated savings: ${view.estimatedSavings}`,
	];
	if (view.extra !== undefined) {
		for (const [label, value] of Object.entries(view.extra)) {
			rows.push(`${label}: ${value}`);
		}
	}
	return { kind: "metric", title: "KPIs", rows, data: view };
}

/** Build the sessions table (FR-3). Renders one row per captured session with its metadata. */
export function buildSessionsView(view: SessionsView): ViewBlock {
	const rows = view.sessions.map(
		(s) => `${s.sessionId} · ${s.project} · ${s.startedAt} · ${s.eventCount} events · ${s.status}`,
	);
	return { kind: "table", title: "Sessions", rows, data: view.sessions };
}

/** Build the settings panel (FR-4). Renders the active org/workspace + exposed config. */
export function buildSettingsView(view: SettingsView): ViewBlock {
	const rows: string[] = [
		`Org: ${view.orgName} (${view.orgId})`,
		`Workspace: ${view.workspace}`,
	];
	for (const [label, value] of Object.entries(view.settings)) {
		rows.push(`${label}: ${value}`);
	}
	return { kind: "panel", title: "Settings", rows, data: view };
}

/**
 * Build the codebase-graph canvas (FR-5 / b-AC-3 / b-AC-6). When `view.built` is false, render
 * the empty-state prompt to run `honeycomb graph build` (b-AC-6, a `kind: "empty-state"` block,
 * NOT an error); otherwise render the `kind: "graph-canvas"` block carrying the nodes/edges the
 * daemon's graph endpoints served (b-AC-3).
 */
export function buildGraphView(view: GraphView): ViewBlock {
	if (!view.built) {
		return { kind: "empty-state", title: "Codebase graph", rows: [GRAPH_BUILD_PROMPT] };
	}
	const rows = [`${view.nodes.length} nodes`, `${view.edges.length} edges`];
	return {
		kind: "graph-canvas",
		title: "Codebase graph",
		rows,
		data: { nodes: view.nodes, edges: view.edges },
	};
}

/** Build the rules list (FR-6 / b-AC-4). Lists the active org rules from the daemon. */
export function buildRulesView(view: RulesView): ViewBlock {
	const rows = view.rules.map((r) => `${r.active ? "●" : "○"} ${r.title} (${r.id})`);
	return { kind: "table", title: "Rules", rows, data: view.rules };
}

/** Build the skill-sync panel (FR-6). Renders pulled/shared team skills + their sync state. */
export function buildSkillSyncView(view: SkillSyncView): ViewBlock {
	const rows = view.skills.map((s) => `${s.name} · ${s.scope} · ${s.syncState}`);
	return { kind: "panel", title: "Skill-sync", rows, data: view.skills };
}

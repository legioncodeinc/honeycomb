/**
 * The dashboard ROUTE REGISTRY — PRD-037c (the single extension point, D-7).
 *
 * ONE ordered list of `{ route, label, icon, component, dynamic? }` entries that BOTH the sidebar
 * (037a, for its nav items) and the router outlet (037b, to mount the active page) read. Adding a
 * page (PRDs 038-044) is ONE entry here plus one component that drops into `<PageFrame>` — no
 * sidebar edit, no router edit (037c AC-6 proves that seam: a throwaway entry appears in the nav
 * AND routes without touching `sidebar.tsx`/`router.tsx`).
 *
 * ── How to add a dashboard page (the contract PRDs 038-044 consume) ──────────────
 *   1. Write a page component: `function MyPage({ wire, daemonUp, assetBase }: PageProps) { … }`
 *      wrapping its content in `<PageFrame title="…">` and hydrating via `usePoll` / the shared
 *      `wire` (never `createWireClient` — the shell passes ONE down).
 *   2. Add ONE `RouteEntry` to {@link ROUTES} in nav order: `{ route, label, icon, component }`.
 *      The sidebar renders the nav item; the outlet routes the hash to the component. Done.
 *   3. A DYNAMIC group (per-installed-harness items under Harnesses, PRD-039) sets `dynamic:
 *      { resolve: (live) => SubItem[] }` — its CHILD items are computed from live install state at
 *      render, distinct from the seven static top-level routes. The registry DEFINES this contract;
 *      the live data source is the consuming PRD's call (parent OQ-3).
 *
 * The fuller version of this note lives in `library/knowledge/private/dashboard/adding-a-page.md`
 * (037c AC-7), code-near here and discoverable there.
 *
 * Icons are inline-SVG `ReactNode`s (037c OQ-1 — a ReactNode, NOT an icon-font/registry), matching
 * the panels' inline-SVG style and the no-new-dependency posture. Every stroke uses
 * `currentColor`, so the sidebar tints an icon by setting `color` on its row (honey when active,
 * `--text-secondary` at rest) — no per-icon color logic.
 */

import React from "react";

import { DashboardPage } from "./pages/dashboard.js";
import { GraphPage } from "./pages/graph.js";
import { HarnessesPage, resolveHarnessSubItems } from "./pages/harnesses.js";
import { LogsPage } from "./pages/logs.js";
import { MemoriesPage } from "./pages/memories.js";
import { ProjectsPage } from "./pages/projects.js";
import { RoiPage } from "./pages/roi.js";
import { SettingsPage } from "./pages/settings.js";
import { SyncPage } from "./pages/sync.js";
import type { PageProps } from "./page-frame.js";

// ─────────────────────────────────────────────────────────────────────────────
// The dynamic-group contract (037c AC-5 + the parent's static-vs-dynamic ask).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One dynamically-resolved sub-item under a registry entry — e.g. a per-installed-harness item
 * under Harnesses (PRD-039). Its `route` is the deep hash the sidebar navigates to; `label` is the
 * nav text. These are NOT top-level routes: they are CHILDREN of a static entry, computed at render
 * from live install state. The registry defines this shape; the live data is the consuming PRD's.
 */
export interface SubItem {
	/** The deep hash this sub-item navigates to (e.g. `/harnesses/claude-code`). */
	readonly route: string;
	/** The nav label for this sub-item (e.g. `Claude Code`). */
	readonly label: string;
}

/**
 * The dynamic-group resolver a registry entry may carry (037c). `resolve` is handed whatever live
 * install/state object the shell provides and returns the CHILD sub-items to render under the parent
 * nav item. The type parameter is `unknown` here because the registry is the CONTRACT, not the data
 * source — the consuming PRD (039) narrows `live` to its own shape. A `dynamic` entry whose
 * `resolve` returns `[]` simply renders no children (the parent stays a plain nav item).
 */
export interface DynamicGroup {
	/** Compute the child sub-items from live install/render state (parent OQ-3 — data is 039's call). */
	readonly resolve: (live: unknown) => readonly SubItem[];
}

// ─────────────────────────────────────────────────────────────────────────────
// The route entry + the seven static routes (037c AC-2, in nav order).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One registry entry (D-7). `route` is the hash key (path-like, e.g. `/graph`); `label` + `icon`
 * are the nav presentation; `component` is the page the outlet mounts (every page takes
 * {@link PageProps}); `dynamic` (optional) marks an entry whose CHILDREN are resolved from live
 * state — its presence is what distinguishes a STATIC top-level route from a DYNAMICALLY-LOADED
 * group (the parent's explicit static-vs-dynamic ask).
 */
export interface RouteEntry {
	/** The hash route this entry owns (path-like; `/` is the default Dashboard route). */
	readonly route: string;
	/** The nav label (sidebar text + per-route document title source, 037c OQ-2). */
	readonly label: string;
	/** The nav icon — an inline-SVG ReactNode using `currentColor` (037c OQ-1). */
	readonly icon: React.ReactNode;
	/** The page component the outlet mounts for this route (takes the shared {@link PageProps}). */
	readonly component: React.ComponentType<PageProps>;
	/** Present iff this entry's CHILDREN come from live state (a dynamic group — PRD-039). */
	readonly dynamic?: DynamicGroup;
}

/** A 16px inline-SVG icon stroked in `currentColor` (so the sidebar tints it by row color). */
function Icon({ children }: { children: React.ReactNode }): React.JSX.Element {
	return (
		<svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: "none" }}>
			{children}
		</svg>
	);
}

/** Dashboard — a 2x2 grid of panels (the home overview). */
const DashboardIcon = (
	<Icon>
		<rect x={3} y={3} width={7} height={7} />
		<rect x={14} y={3} width={7} height={7} />
		<rect x={3} y={14} width={7} height={7} />
		<rect x={14} y={14} width={7} height={7} />
	</Icon>
);

/** Harnesses — stacked plugs/terminals (the per-host adapters). */
const HarnessesIcon = (
	<Icon>
		<rect x={3} y={4} width={18} height={16} rx={2} />
		<path d="M7 9l3 3-3 3" />
		<path d="M13 15h4" />
	</Icon>
);

/** Projects — stacked folders (the bound-folder manager, PRD-059). */
const ProjectsIcon = (
	<Icon>
		<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
	</Icon>
);

/** Memories — a honeycomb cell (the signature Honeycomb surface). */
const MemoriesIcon = (
	<Icon>
		<path d="M12 3l7 4v8l-7 4-7-4V7z" />
		<path d="M12 8v8" />
	</Icon>
);

/** Graph — connected nodes (the codebase graph). */
const GraphIcon = (
	<Icon>
		<circle cx={6} cy={6} r={2.5} />
		<circle cx={18} cy={9} r={2.5} />
		<circle cx={9} cy={18} r={2.5} />
		<path d="M8 7.5l8 1.5M8 16l1-7.5" />
	</Icon>
);

/** Sync — a circular refresh (skill propagation). */
const SyncIcon = (
	<Icon>
		<path d="M21 12a9 9 0 1 1-3-6.7" />
		<path d="M21 4v4h-4" />
	</Icon>
);

/** Logs — a document with lines (the live-log stream). */
const LogsIcon = (
	<Icon>
		<rect x={4} y={3} width={16} height={18} rx={2} />
		<path d="M8 8h8M8 12h8M8 16h5" />
	</Icon>
);

/** ROI — a rising trend line over an axis (the Net-ROI ledger, PRD-060e). */
const RoiIcon = (
	<Icon>
		<path d="M4 19V5" />
		<path d="M4 19h16" />
		<path d="M7 15l4-5 3 3 5-7" />
	</Icon>
);

/** Settings — a gear (provider/model/pollinating/vault). */
const SettingsIcon = (
	<Icon>
		<circle cx={12} cy={12} r={3} />
		<path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
	</Icon>
);

/**
 * The seven STATIC top-level routes in nav order (037c AC-2). Each is always present and hard-listed
 * here; their content owners are the cross-referenced page PRDs:
 *   Dashboard (`/`)        → PRD-038 (lift-and-shift today, reorganized there)
 *   Harnesses (`/harnesses`) → PRD-039 (may carry a dynamic per-harness group)
 *   Memories (`/memories`)  → PRD-040
 *   Graph (`/graph`)        → PRD-041
 *   Sync (`/sync`)          → PRD-042
 *   Logs (`/logs`)          → PRD-043
 *   Settings (`/settings`)  → PRD-044
 */
/** The Projects page hash route (PRD-059c) — exported so the first-run CTA can navigate to it (b-AC-4). */
export const PROJECTS_ROUTE = "/projects" as const;

export const ROUTES: readonly RouteEntry[] = [
	{ route: "/", label: "Dashboard", icon: DashboardIcon, component: DashboardPage },
	// PRD-059c: the Projects management page (bound-folder list + Add/Import/Unbind/Open). Slotted right
	// after Dashboard — the home for "what is Honeycomb sourcing". One registry entry is the whole wiring
	// (037c contract): the sidebar renders the nav item and the outlet routes the hash, no sidebar edit.
	{ route: PROJECTS_ROUTE, label: "Projects", icon: ProjectsIcon, component: ProjectsPage },
	// PRD-039 (D-6): the `#/harnesses` route is the STATIC top-level entry; its per-harness sub-entries
	// (`#/harnesses/<name>`) are the 037c DYNAMIC group, resolved at render from 039a's live harness
	// list (`resolveHarnessSubItems`). The parent's OQ-3 answer: 039a IS the dynamic data source.
	{ route: "/harnesses", label: "Harnesses", icon: HarnessesIcon, component: HarnessesPage, dynamic: { resolve: resolveHarnessSubItems } },
	{ route: "/memories", label: "Memories", icon: MemoriesIcon, component: MemoriesPage },
	{ route: "/graph", label: "Graph", icon: GraphIcon, component: GraphPage },
	{ route: "/sync", label: "Sync", icon: SyncIcon, component: SyncPage },
	{ route: "/logs", label: "Logs", icon: LogsIcon, component: LogsPage },
	// PRD-060e: the ROI page (the Net-ROI ledger — measured/modeled savings vs infra + pollination cost,
	// with org/team/agent/project rollups). ONE registry entry is the whole wiring (037c contract): the
	// sidebar renders the nav item and the outlet routes the hash, no sidebar/router hand-edit.
	{ route: "/roi", label: "ROI", icon: RoiIcon, component: RoiPage },
	{ route: "/settings", label: "Settings", icon: SettingsIcon, component: SettingsPage },
];

/** The Dashboard entry — the default every unknown hash falls back to (037c AC-3 / 037b AC-4). */
export const DEFAULT_ROUTE: RouteEntry = ROUTES[0] as RouteEntry;

/**
 * Resolve a hash route to its registry entry, defaulting to the Dashboard entry on no match (037c
 * AC-3, feeding 037b AC-4 "unknown route → Dashboard, no blank screen"). The match is exact on the
 * entry `route` — a deep sub-route (e.g. `/harnesses/claude-code` from a dynamic group) resolves to
 * its top-level parent by prefix so the correct page still mounts. `routes` is injectable so a test
 * can prove the plug-in seam with a throwaway entry (037c AC-6) without mutating the global list.
 */
export function matchRoute(hash: string, routes: readonly RouteEntry[] = ROUTES): RouteEntry {
	// Exact match first (the common case: one of the seven top-level routes).
	const exact = routes.find((r) => r.route === hash);
	if (exact !== undefined) return exact;
	// A deep sub-route resolves to its top-level parent (e.g. `/harnesses/x` → the Harnesses entry).
	// Skip the root `/` here so it never greedily matches every hash; root is the explicit fallback.
	const parent = routes.find((r) => r.route !== "/" && hash.startsWith(`${r.route}/`));
	if (parent !== undefined) return parent;
	// No match → the Dashboard entry (the registry's default; never a blank screen).
	return routes.find((r) => r.route === "/") ?? (routes[0] as RouteEntry);
}

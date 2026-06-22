/**
 * The left-hand NAVIGATION sidebar — PRD-037a (the brand chrome + nav).
 *
 * A pure presentational + nav component: it READS the route registry (037c) for its items and the
 * active route (037b) for its highlight, and EMITS navigation intent via `onNavigate(route)`. It
 * does NOT mutate `location.hash` itself — that is 037b's `navigate` (037a AC-4 keeps the sidebar a
 * thin, testable pass-through). It introduces NO new design system: every visual value is an
 * existing `var(--…)` token already served in `/dashboard/styles.css` (037a AC-7, D-3).
 *
 * Layout (D-3 / D-4):
 *   - Top: the honeycomb mark + `honeycomb` wordmark + the org/workspace mono sub-line — the exact
 *     type treatment the old `Header` used (mark 34px; wordmark 700/19/-0.03em; sub-line mono/11).
 *   - Middle: the seven nav items from the registry, each icon + label, in registry order. The item
 *     matching `activeRoute` is highlighted with the honey accent (`--honey` / `--honey-subtle` /
 *     `--honey-border`) — the same language `Badge tone="honey"` / `Button variant="primary"` speak —
 *     and EXACTLY one item is active at a time.
 *   - Footer: the relocated daemon-health pill (green `--verified` dot up / `--severity-critical`
 *     offline, mono `daemon :3850` / `offline`) + the collapse toggle (a ghost `Button`). The pill is
 *     visible on every route (D-4), and in the collapsed rail it shows the dot only.
 *
 * Collapsed/responsive (037a AC-6): the `collapsed` flag (or a narrow viewport via the host's
 * `@media (max-width:900px)` rule) renders an icon-only rail; the active highlight + the health dot
 * survive it, and each item's label rides a `title` hover.
 */

import React from "react";

import { Button } from "./primitives.js";
import type { RouteEntry } from "./registry.js";

/** The expanded sidebar gutter width (px). */
export const SIDEBAR_WIDTH = 220 as const;
/** The collapsed icon-rail width (px). */
export const SIDEBAR_RAIL_WIDTH = 56 as const;

/** Props for {@link Sidebar}. */
export interface SidebarProps {
	/** The registry nav entries (037c) — rendered as nav items in order. */
	readonly entries: readonly RouteEntry[];
	/** The active route (037b's `useHashRoute().route`) — drives the single active highlight. */
	readonly activeRoute: string;
	/** Navigation intent — called with an item's `route`; the SHELL maps it to 037b's `navigate`. */
	readonly onNavigate: (route: string) => void;
	/** Daemon liveness — drives the footer health pill (green up / critical offline). */
	readonly daemonUp: boolean;
	/** The org/workspace sub-line under the wordmark (mono, tertiary). */
	readonly identity: string;
	/** The base path the host serves the mark under (loopback, no secret). */
	readonly assetBase: string;
	/** Collapsed (icon-rail) state — icon-only nav, dot-only pill. */
	readonly collapsed: boolean;
	/** Toggle the collapsed state (the shell owns the boolean; the sidebar calls this). */
	readonly onToggleCollapsed: () => void;
}

/**
 * Decide which entry is active for the current route (037a AC-3 — EXACTLY one). An exact match wins;
 * otherwise a deep sub-route highlights its top-level parent (e.g. `/harnesses/x` lights Harnesses);
 * otherwise the Dashboard (`/`) entry is active (the unknown→Dashboard fallback, mirroring the
 * registry's `matchRoute`). Returns the active entry's `route` so the renderer compares by value.
 */
export function activeEntryRoute(entries: readonly RouteEntry[], activeRoute: string): string {
	const exact = entries.find((e) => e.route === activeRoute);
	if (exact !== undefined) return exact.route;
	const parent = entries.find((e) => e.route !== "/" && activeRoute.startsWith(`${e.route}/`));
	if (parent !== undefined) return parent.route;
	const dashboard = entries.find((e) => e.route === "/");
	return dashboard?.route ?? (entries[0]?.route ?? "/");
}

/** One nav item row. Honey-accented when active; resting `--text-secondary` otherwise. */
function NavItem({
	entry,
	active,
	collapsed,
	onNavigate,
}: {
	entry: RouteEntry;
	active: boolean;
	collapsed: boolean;
	onNavigate: (route: string) => void;
}): React.JSX.Element {
	return (
		<button
			type="button"
			// AC-4: the click is the ONLY navigation effect — it calls onNavigate(route) and nothing
			// else (the sidebar never touches location.hash; the shell wires this to 037b's navigate).
			onClick={() => onNavigate(entry.route)}
			aria-current={active ? "page" : undefined}
			title={collapsed ? entry.label : undefined}
			data-route={entry.route}
			data-active={active ? "true" : "false"}
			style={{
				display: "flex",
				alignItems: "center",
				gap: 10,
				width: "100%",
				height: 38,
				padding: collapsed ? "0" : "0 12px",
				justifyContent: collapsed ? "center" : "flex-start",
				// Honey active highlight (D-3) — exactly the `Badge tone="honey"` language.
				background: active ? "var(--honey-subtle)" : "transparent",
				color: active ? "var(--honey)" : "var(--text-secondary)",
				border: `1px solid ${active ? "var(--honey-border)" : "transparent"}`,
				borderRadius: "var(--radius-md)",
				fontFamily: "var(--font-mono)",
				fontSize: 13,
				fontWeight: 600,
				letterSpacing: "0.01em",
				cursor: "pointer",
				whiteSpace: "nowrap",
				transition: "background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
			}}
		>
			<span style={{ display: "inline-flex", flex: "none" }}>{entry.icon}</span>
			{!collapsed && <span>{entry.label}</span>}
		</button>
	);
}

/**
 * The daemon-health pill, relocated into the sidebar footer (D-4). KEEPS the exact contract from the
 * old `Header`: a green `--verified` dot when up, `--severity-critical` when offline, mono
 * `daemon :3850` / `offline` label, on `--bg-elevated` with a `--border-default` border. Renders
 * subsystem STATE only — NO token/secret (D-9). In the collapsed rail it shows the dot alone.
 */
function HealthPill({ daemonUp, collapsed }: { daemonUp: boolean; collapsed: boolean }): React.JSX.Element {
	return (
		<div
			title="daemon health"
			data-testid="daemon-health-pill"
			style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				height: 36,
				padding: collapsed ? "0" : "0 12px",
				justifyContent: collapsed ? "center" : "flex-start",
				background: "var(--bg-elevated)",
				border: "1px solid var(--border-default)",
				borderRadius: "var(--radius-md)",
			}}
		>
			<span style={{ width: 8, height: 8, borderRadius: "50%", flex: "none", background: daemonUp ? "var(--verified)" : "var(--severity-critical)" }} />
			{!collapsed && <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)" }}>{daemonUp ? "daemon :3850" : "offline"}</span>}
		</div>
	);
}

/**
 * The navigation sidebar (037a). Renders the brand chrome, the seven registry nav items with the
 * single honey active highlight, and the footer (health pill + collapse toggle). Pure presentation:
 * all state (active route, daemon up, collapsed) is owned by the shell and passed in; every effect is
 * an `onNavigate` / `onToggleCollapsed` callback out.
 */
export function Sidebar({
	entries,
	activeRoute,
	onNavigate,
	daemonUp,
	identity,
	assetBase,
	collapsed,
	onToggleCollapsed,
}: SidebarProps): React.JSX.Element {
	const activeRoot = activeEntryRoute(entries, activeRoute);

	return (
		<nav
			aria-label="Dashboard navigation"
			data-collapsed={collapsed ? "true" : "false"}
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 18,
				width: collapsed ? SIDEBAR_RAIL_WIDTH : SIDEBAR_WIDTH,
				flex: "none",
				minHeight: "100vh",
				boxSizing: "border-box",
				padding: collapsed ? "20px 8px" : "22px 14px",
				background: "var(--bg-surface)",
				borderRight: "1px solid var(--border-default)",
			}}
		>
			{/* Brand chrome — mark + wordmark + org/workspace sub-line (mirrors the old Header). */}
			<div style={{ display: "flex", alignItems: "center", gap: 10, paddingLeft: collapsed ? 0 : 2, justifyContent: collapsed ? "center" : "flex-start" }}>
				<img src={`${assetBase}/honeycomb-mark.svg`} width={collapsed ? 28 : 34} height={collapsed ? 28 : 34} alt="" style={{ flex: "none" }} />
				{!collapsed && (
					<div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
						<span style={{ fontWeight: 700, fontSize: 19, letterSpacing: "-0.03em", color: "var(--text-primary)", lineHeight: 1.1 }}>honeycomb</span>
						<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
							{identity}
						</span>
					</div>
				)}
			</div>

			{/* Nav items — the seven registry entries, exactly one active (037a AC-2 / AC-3). */}
			<div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
				{entries.map((entry) => (
					<NavItem key={entry.route} entry={entry} active={entry.route === activeRoot} collapsed={collapsed} onNavigate={onNavigate} />
				))}
			</div>

			{/* Footer — the relocated health pill + the collapse toggle (D-4). */}
			<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
				<HealthPill daemonUp={daemonUp} collapsed={collapsed} />
				<Button variant="ghost" size="sm" onClick={onToggleCollapsed} aria-label={collapsed ? "expand sidebar" : "collapse sidebar"} title={collapsed ? "expand" : "collapse"}>
					{collapsed ? "»" : "« collapse"}
				</Button>
			</div>
		</nav>
	);
}

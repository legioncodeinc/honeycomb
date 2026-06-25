/**
 * The Org → Workspace → Project SCOPE seam — PRD-050b operator directive (the 049e mount point).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THIS IS A SEAM STUB, NOT THE SWITCHER. PRD-049e implements the multi-project
 * scope switcher here; 050b only carves out the extension point so 049e can slot
 * it into the sidebar/nav WITHOUT reworking `host.ts`, `renderShell`, or the shell.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── Why this lives in the React app, not the host (the scope-UNAWARE shell rule) ──
 * `renderShell` / `host.ts` stay a token-free, scope-UNAWARE bare shell (parent AC-8): they serve
 * `<div id="root">` and the bundle, nothing more. Identity AND scope are hydrated by the React app
 * from live endpoints — so the scope switcher is a React concern, mounted here, never baked into the
 * server-rendered shell. There is NO single-workspace assumption in the shell; this context is the
 * one place the app reasons about scope.
 *
 * ── The seam 049e fills (do NOT implement the switcher now) ──────────────────
 *   1. {@link ScopeContext} — a React context carrying the active `{ org, workspace, project }` +
 *      a `setScope`. 050b ships a SINGLE-SCOPE default (the loopback local tenant) so today's
 *      single-workspace dashboard reads it transparently; 049e replaces the provider value with a
 *      real, switchable scope hydrated from an org/workspace/project endpoint.
 *   2. {@link useScope} — the hook every scope-aware surface reads. Today it returns the single
 *      default scope; 049e makes it reactive to the switcher's selection. Surfaces written against
 *      THIS hook need no change when 049e lands — they already read the live value.
 *   3. {@link ScopeSwitcherSlot} — the named region in the sidebar where 049e mounts its dropdown.
 *      050b renders NOTHING here (a zero-height placeholder), so the nav layout is identical today;
 *      049e fills it with the Org→Workspace→Project picker. The slot's PRESENCE (a stable DOM seam +
 *      a stable prop contract) is what lets 049e land without touching `sidebar.tsx`'s structure.
 *
 * Keeping the contract this narrow (a context + a hook + a slot) is the whole point: 049e is an
 * additive fill, not a rewrite.
 */

import React from "react";

/**
 * The active scope the dashboard reads (the 049e contract). `org` is always present; `workspace`
 * and `project` narrow it. 050b ships the single loopback-local default; 049e makes these switchable.
 */
export interface DashboardScope {
	/** The active org id (always present; the loopback "local" tenant by default). */
	readonly org: string;
	/** The active workspace id (the `default` sentinel until 049e adds the switcher). */
	readonly workspace: string;
	/** The active project id, when the scope is narrowed to one (049e); absent today. */
	readonly project?: string;
}

/** The single-scope default 050b ships: the loopback local tenant (049e replaces this at the provider). */
export const DEFAULT_SCOPE: DashboardScope = Object.freeze({ org: "local", workspace: "default" });

/** The scope context value — the active scope plus a `setScope` 049e wires to its switcher. */
export interface ScopeContextValue {
	/** The active scope. */
	readonly scope: DashboardScope;
	/**
	 * Switch the active scope (049e's switcher calls this). 050b ships a NO-OP default (a single,
	 * un-switchable scope), so a surface that calls it today is harmless; 049e replaces the provider
	 * with a real setter that re-hydrates the scoped views.
	 */
	readonly setScope: (next: DashboardScope) => void;
}

/** The React context (the 049e mount point). Defaults to the single loopback scope + a no-op setter. */
export const ScopeContext = React.createContext<ScopeContextValue>({
	scope: DEFAULT_SCOPE,
	setScope: () => {
		// 050b no-op: there is exactly one scope today. 049e replaces the provider value with a real
		// setter; until then a stray `setScope` call is intentionally inert (no single-workspace bug).
	},
});

/**
 * Read the active dashboard scope (the hook every scope-aware surface uses). 050b returns the single
 * default; 049e makes it reactive to the switcher — surfaces written against this hook need NO change
 * when 049e lands. This is the seam the operator directive requires: read scope from HERE, never bake
 * a single-workspace assumption into a page or the shell.
 */
export function useScope(): ScopeContextValue {
	return React.useContext(ScopeContext);
}

/** Props for {@link ScopeSwitcherSlot}. `collapsed` mirrors the sidebar's rail state so 049e can render an icon-only switcher. */
export interface ScopeSwitcherSlotProps {
	/** Whether the sidebar is in its collapsed icon-rail (049e renders a compact switcher when true). */
	readonly collapsed: boolean;
}

/**
 * The named SLOT in the sidebar where PRD-049e mounts the Org→Workspace→Project switcher.
 *
 * 050b renders a zero-content, clearly-marked placeholder (a stable `data-slot` DOM seam), so the nav
 * layout is byte-identical today — the switcher is NOT implemented here. 049e replaces this body with
 * its dropdown, reading {@link useScope} for the active selection and calling `setScope` to switch.
 * The slot lives BETWEEN the brand chrome and the nav items in {@link import("./sidebar.js").Sidebar}
 * (see the marked region there), so 049e fills it without restructuring the sidebar.
 */
export function ScopeSwitcherSlot(_props: ScopeSwitcherSlotProps): React.JSX.Element | null {
	// PRD-050b: intentionally render nothing (the 049e seam is a placeholder until the switcher lands).
	// The marker comment + the stable export are the contract 049e fills. Returning null keeps the
	// current single-workspace layout pixel-identical.
	return null;
}

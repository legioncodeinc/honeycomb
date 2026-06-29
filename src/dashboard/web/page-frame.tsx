/**
 * The shared PAGE FRAME + the page contract — PRD-037c (the extensibility surface).
 *
 * Every routed page (the Dashboard lift-and-shift plus the six PRD-039..044 destinations) renders
 * INSIDE `<PageFrame>`: an optional mono eyebrow, a title, and a content body capped at the
 * preserved readable max-width (the old `.wrap` 1180px cap, D-8). The frame's background is
 * transparent — the canvas `--bg-canvas` shows through and panels inside keep their own
 * `--bg-surface` (mirrors the `Panel` header rhythm in `panels.tsx` but at PAGE scale). A page
 * therefore carries NO chrome of its own (037c AC-1): the shell owns the sidebar/header, the page
 * owns its content.
 *
 * `PageProps` is the single contract the router outlet passes EVERY page (037c): the shared `wire`
 * client (so a page never re-creates one), the `daemonUp` flag (the shell owns the down state, so a
 * page renders content assuming up — D-5), and the `assetBase`. `usePoll` is the documented
 * hydration recipe — fetch-on-mount + interval + cleanup-on-unmount — replicating the old
 * `app.tsx`'s log/health poll so a page (Logs, Memories, Graph…) hydrates the same way without
 * re-deriving the lifecycle (037c AC-4).
 *
 * Every visual value here is an existing `var(--…)` design token — NO new token (D-3 / D-9).
 */

import React from "react";

import type { HealthReasonsWire, WireClient } from "./wire.js";

/**
 * The props the router outlet passes every routed page (037c). A page reads the SHARED `wire`
 * (never `createWireClient` itself), renders content for the up daemon (the shell swaps in the
 * ConnectivityBanner when down — D-5, so `daemonUp` is informational for a page that wants to
 * gate its own polling), and uses `assetBase` for any host-served asset (e.g. the mark).
 */
export interface PageProps {
	/** The shared, already-constructed wire client (the shell builds ONE and passes it down). */
	readonly wire: WireClient;
	/** Daemon liveness — the shell owns the down view-swap; a page may use this to gate its polling. */
	readonly daemonUp: boolean;
	/** The base path the host serves assets (mark/logo) under (loopback, no secret — D-9). */
	readonly assetBase: string;
	/**
	 * Whether a Pollinate pass is currently active (D-5: the "Pollinate now" action lives in the SHELL chrome,
	 * so the pollinating flag is owned there and passed DOWN). Informational for most pages; the Dashboard
	 * page reads it to drive the graph/card pollinate pulse. Defaults `false` for a page that ignores it.
	 */
	readonly pollinating?: boolean;
	/**
	 * The latest `/health` subsystem reasons, owned by the SHELL's single liveness poll and passed DOWN
	 * (so a page never polls `/health` a second time — the home's per-subsystem strip reads THIS). `null`
	 * before the first probe resolves or when the mode-gated public body omits reasons. Defaults `null`.
	 */
	readonly healthReasons?: HealthReasonsWire | null;
}

/** The maximum readable content width — preserves the old `.wrap` 1180px cap (D-8). */
export const PAGE_MAX_WIDTH = 1180 as const;

/** Props for {@link PageFrame}. */
export interface PageFrameProps {
	/** The page title (page-scale heading). */
	readonly title: string;
	/** An optional mono eyebrow above the title (e.g. a route tag or count). */
	readonly eyebrow?: string;
	/** An optional right-aligned slot on the title row (a page-level action/status). */
	readonly right?: React.ReactNode;
	/** The page content (panels, grids, etc.). */
	readonly children?: React.ReactNode;
}

/**
 * The shared page layout (037c AC-1). An optional mono eyebrow + a title row, then the content
 * body capped at {@link PAGE_MAX_WIDTH}. Transparent background (the canvas shows through). Uses
 * only existing DS tokens — the title treatment mirrors the `Panel` header (`--text-base`+,
 * `--text-primary`, `letterSpacing: -0.01em`); the eyebrow mirrors the mono `--text-tertiary`
 * uppercase eyebrow the KPI/health strip already speak.
 */
export function PageFrame({ title, eyebrow, right, children }: PageFrameProps): React.JSX.Element {
	return (
		<div style={{ maxWidth: PAGE_MAX_WIDTH, margin: "0 auto", width: "100%" }}>
			<header style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
				<div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
					{eyebrow !== undefined && eyebrow !== "" && (
						<span
							style={{
								fontFamily: "var(--font-mono)",
								fontSize: 11,
								color: "var(--text-tertiary)",
								textTransform: "uppercase",
								letterSpacing: "0.08em",
							}}
						>
							{eyebrow}
						</span>
					)}
					<h1 style={{ fontSize: "var(--text-lg)", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.01em", lineHeight: 1.1 }}>
						{title}
					</h1>
				</div>
				<span style={{ flex: 1 }} />
				{right}
			</header>
			<div>{children}</div>
		</div>
	);
}

/**
 * The documented hydration recipe (037c AC-4): fetch-on-mount + interval poll + cleanup-on-unmount,
 * replicating the old `app.tsx`'s log/health poll lifecycle so a page polls a live endpoint the
 * SAME way the dashboard does today. `fn` is invoked once immediately on mount, then every `ms`
 * until the component unmounts; the `setInterval` is cleared and an `alive` flag prevents a
 * late-resolving async `fn` from updating an unmounted tree. `fn` is held in a ref so a page can
 * pass an inline closure without re-subscribing the interval every render (only `ms` re-arms it).
 *
 * ── Background pause (perf) ──────────────────────────────────────────────────
 *   A dashboard left open in a BACKGROUND tab must not keep hitting the daemon/DeepLake. So a tick
 *   NO-OPs while `document.visibilityState === "hidden"`; the interval keeps its cadence but does no
 *   work until the tab is foregrounded again. A `visibilitychange` → visible fires an IMMEDIATE tick
 *   so returning to the tab refreshes at once instead of waiting up to `ms`. This is the single seam
 *   every page's poll inherits the pause from.
 *
 * @example
 *   // A Logs page that polls /api/logs every 2.5s and stops on unmount:
 *   usePoll(async () => setLines(await wire.logs(8)), 2500);
 */
/**
 * Whether the tab is currently backgrounded (the single visibility predicate). A backgrounded
 * dashboard should not keep hitting the daemon/DeepLake, so {@link usePoll} and the pages' own raw
 * poll loops skip their fetch while this is true. SSR/non-DOM safe (returns `false` with no `document`).
 */
export function isTabHidden(): boolean {
	return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export function usePoll(fn: () => void | Promise<void>, ms: number): void {
	const fnRef = React.useRef(fn);
	// Keep the latest `fn` without re-arming the interval (only `ms` re-arms it).
	React.useEffect(() => {
		fnRef.current = fn;
	}, [fn]);

	React.useEffect(() => {
		let alive = true;
		const tick = async (): Promise<void> => {
			if (!alive || isTabHidden()) return;
			await fnRef.current();
		};
		void tick();
		const id = setInterval(() => void tick(), ms);
		// Refresh immediately on re-foreground (the skipped ticks left the view as stale as `ms` ago).
		const onVisible = (): void => {
			if (!isTabHidden()) void tick();
		};
		if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
		return () => {
			alive = false;
			clearInterval(id);
			if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
		};
	}, [ms]);
}

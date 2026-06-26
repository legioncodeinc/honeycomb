/**
 * The dashboard APP SHELL — PRD-037b (the app-shell split).
 *
 * PRD-024 made `/dashboard` a single long-scrolling page (the old `App`). PRD-037 turns it into a
 * left-nav MULTI-PAGE shell: a persistent `<Sidebar>` (037a) beside a content `<Outlet>` that mounts
 * the registry-matched page (037c) for the active hash route (037b). The current monolithic content
 * moved VERBATIM onto the Dashboard route (`pages/dashboard.tsx`, D-6 lift-and-shift) — this module
 * no longer renders that body; it renders the CHROME and routes to it.
 *
 * What the shell OWNS (hoisted up from the old page, D-5):
 *   - The SHARED wire client (built ONCE, passed to every page via PageProps — pages never
 *     `createWireClient` themselves).
 *   - The hash router (037b `useHashRoute`) → `{ route, navigate }`. The sidebar's `onNavigate` is a
 *     thin pass-through to `navigate` (037a never touches `location.hash`).
 *   - The `/health` LIVENESS poll + `daemonUp`. When the daemon is unreachable the CONTENT region
 *     swaps for the `ConnectivityBanner` while the SIDEBAR stays mounted (D-5); on Retry/reconnect the
 *     active page restores and re-hydrates. The per-subsystem health STRIP stays page content (it
 *     polls `/health` reasons inside `DashboardPage`); the shell owns only the coarse up/down.
 *   - The org/workspace identity (the sidebar sub-line) + the "Pollinate now" action + the `pollinating`
 *     pulse, all relocated from the old `Header` into the shell chrome (D-5). `pollinating` flows DOWN to
 *     the active page (the Dashboard graph/cards pulse on it).
 *   - The collapsed/responsive state (037a AC-6): a manual toggle plus an auto-collapse under the
 *     host's `@media (max-width:900px)` breakpoint.
 *
 * No new daemon route, no new dependency: routing is 100% client-side hash; the host (`host.ts`) is
 * untouched and still serves ONE bundle at `/dashboard/app.js`. Security posture inherited unchanged
 * (local-mode-only, XSS-safe, no token/secret in the shell/route/registry/pill — D-9).
 */

import React from "react";

import { Button } from "./primitives.js";
import { ConnectivityBanner } from "./panels.js";
import { matchRoute, ROUTES, type RouteEntry } from "./registry.js";
import { Sidebar } from "./sidebar.js";
import { useHashRoute } from "./router.js";
import { PAGE_MAX_WIDTH, type PageProps } from "./page-frame.js";
import { FirstRunBindCTA } from "./needs-project.js";
import { ScopeProvider, useScopeSwitcher } from "./scope-context.js";
import { createWireClient, EMPTY_SETTINGS, type SettingsWire, type WireClient } from "./wire.js";

/** How often the shell probes `/health` for coarse liveness (ms). */
const HEALTH_POLL_MS = 5000;
/** The narrow-viewport breakpoint that auto-collapses the sidebar (mirrors host.ts's media rule). */
const NARROW_BREAKPOINT = 900 as const;

/** Props for {@link Shell} — the injected wire client + the asset base (same contract as the old App). */
export interface ShellProps {
	/** The wire client (injected by a unit test with a mocked fetch; defaults to the live one). */
	readonly client?: WireClient;
	/** The base path the logo/assets are served under (the host serves them beside the page). */
	readonly assetBase?: string;
}

/**
 * The content OUTLET — looks up the registry-matched page for the active route and mounts it with the
 * shared {@link PageProps} (037b). Capped at the readable page max-width (D-8). When the daemon is
 * down the shell renders the banner INSTEAD of this (so this only ever renders for an up daemon).
 *
 * PRD-059b (b-AC-1 / M-AC-2): on the DASHBOARD route, when the projects enumeration has resolved with
 * ZERO locally-bound projects, the PRIMARY content is the first-run "Pick a folder to start" CTA — not
 * an empty page. It keys off the switcher's `projectsHydrated` flag so it never flashes before the read
 * resolves, and is gated to the Dashboard route so the Projects/Settings pages stay reachable to bind.
 */
function Outlet({ route, pageProps, navigate }: { route: string; pageProps: PageProps; navigate: (r: string) => void }): React.JSX.Element {
	const entry: RouteEntry = matchRoute(route);
	const PageComponent = entry.component;
	const { projects, projectsHydrated } = useScopeSwitcher();
	// 037c OQ-2: per-route document title from the registry label (cheap, nice for deep links).
	React.useEffect(() => {
		if (typeof document !== "undefined") document.title = `honeycomb · ${entry.label}`;
	}, [entry.label]);

	// b-AC-1: zero locally-bound projects (after the read resolved) + the Dashboard route → the first-run
	// CTA is the primary content. `boundLocally` is the per-device binding bit (the inbox/registry-only
	// projects don't count as "active"); an unbound workspace shows the CTA, a bound one shows the page.
	const hasBound = projects.some((p) => p.boundLocally && p.projectId !== "__unsorted__");
	const showFirstRun = entry.route === "/" && projectsHydrated && !hasBound;

	return (
		<div style={{ flex: 1, minWidth: 0, padding: "28px 28px 48px" }}>
			<div style={{ maxWidth: PAGE_MAX_WIDTH, margin: "0 auto" }}>
				{showFirstRun ? <FirstRunBindCTA wire={pageProps.wire} navigate={navigate} assetBase={pageProps.assetBase} /> : <PageComponent {...pageProps} />}
			</div>
		</div>
	);
}

/**
 * The dashboard shell (037b). Builds the shared wire, runs the hash router + the liveness poll, owns
 * the pollinate action + the collapsed state, and renders the sidebar beside the routed content (or the
 * ConnectivityBanner when the daemon is down — sidebar stays mounted, D-5).
 */
export function Shell({ client, assetBase = "assets" }: ShellProps = {}): React.JSX.Element {
	const wire = React.useMemo<WireClient>(() => client ?? createWireClient(), [client]);
	const { route, navigate } = useHashRoute();

	// ── shell-owned state ──
	const [daemonUp, setDaemonUp] = React.useState(true);
	const [settings, setSettings] = React.useState<SettingsWire>(EMPTY_SETTINGS);
	const [pollinating, setPollinating] = React.useState(false);
	// Collapsed: a manual toggle OR an auto-collapse under the narrow breakpoint (037a AC-6). We track
	// both an explicit user choice and the viewport, preferring the user's choice once they toggle.
	const [collapsed, setCollapsed] = React.useState(false);

	const daemonUrl = settings.settings.port ? `http://127.0.0.1:${settings.settings.port}` : "http://127.0.0.1:3850";

	/** Hydrate the org/workspace identity for the sidebar sub-line (the shell's slice of settings). */
	const hydrateIdentity = React.useCallback(async (): Promise<void> => {
		setSettings(await wire.settings());
	}, [wire]);

	// Hydrate the identity once on mount.
	React.useEffect(() => {
		void hydrateIdentity();
	}, [hydrateIdentity]);

	// Track the previous liveness so identity re-hydration fires ONLY on a down→up recovery (the mount
	// effect already hydrates once) — not on every healthy 5s tick. Null = no probe resolved yet.
	const prevDaemonUpRef = React.useRef<boolean | null>(null);

	// D-5: the shell owns the /health LIVENESS poll + the daemon-down swap. On RECOVERY (down→up) re-hydrate
	// the identity (the active page re-hydrates itself on remount). Cleared on unmount.
	React.useEffect(() => {
		let alive = true;
		const tick = async (): Promise<void> => {
			const { up } = await wire.health();
			if (!alive) return;
			setDaemonUp(up);
			if (up && prevDaemonUpRef.current === false) void hydrateIdentity();
			prevDaemonUpRef.current = up;
		};
		void tick();
		const id = setInterval(() => void tick(), HEALTH_POLL_MS);
		return () => {
			alive = false;
			clearInterval(id);
		};
	}, [wire, hydrateIdentity]);

	// 037a AC-6: auto-collapse under the narrow breakpoint. Tracks the viewport via matchMedia; the
	// listener is cleaned up on unmount. A manual toggle still works (it sets `collapsed` directly).
	React.useEffect(() => {
		if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
		const mq = window.matchMedia(`(max-width: ${NARROW_BREAKPOINT}px)`);
		const apply = (matches: boolean): void => {
			if (matches) setCollapsed(true);
		};
		apply(mq.matches);
		const onChange = (e: MediaQueryListEvent): void => apply(e.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);

	// A SYNCHRONOUS in-flight guard for the pollinate action: `setPollinating(true)` is async, so a render-state
	// guard alone leaves a race window where a rapid second activation fires `wire.pollinate()` twice. The ref
	// flips immediately; the reset timer is tracked so it can be cleared on unmount.
	const pollinateInFlightRef = React.useRef(false);
	const pollinateResetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	React.useEffect(() => {
		return () => {
			if (pollinateResetTimerRef.current !== null) clearTimeout(pollinateResetTimerRef.current);
		};
	}, []);

	// D-5: the "Pollinate now" action, relocated into the shell chrome. POST the Wave-1 trigger; reflect
	// the 202 ack by pulsing the active page's graph/cards (`pollinating` flows down via PageProps).
	const pollinate = React.useCallback(async (): Promise<void> => {
		if (pollinateInFlightRef.current) return; // synchronous re-entry guard (no double POST on rapid clicks)
		pollinateInFlightRef.current = true;
		setPollinating(true);
		const ack = await wire.pollinate();
		if (ack.triggered) {
			// A real pass was queued: pulse briefly while it streams into the live log, then settle.
			pollinateResetTimerRef.current = setTimeout(() => {
				setPollinating(false);
				pollinateInFlightRef.current = false;
			}, 4200);
		} else {
			// Honestly reflect the skip (disabled / unavailable) — no fake forever spinner.
			setPollinating(false);
			pollinateInFlightRef.current = false;
		}
	}, [wire]);

	const identity = `${settings.orgName || settings.orgId || "local"} · ${settings.workspace || "default"}`;

	// The PageProps every routed page receives (D-7). One shared wire, the liveness flag, the asset
	// base, and the shell-owned pollinating pulse.
	const pageProps: PageProps = { wire, daemonUp, assetBase, pollinating };

	return (
		// PRD-049e: the ScopeProvider owns the switchable Org→Workspace→Project selection + the
		// enumeration state, feeding both the sidebar switcher (the filled 050b slot) and every page
		// (via useScope). It wraps the sidebar + outlet so they share ONE scope source of truth. The
		// shell/host stay scope-UNAWARE — scope lives entirely here in the React app.
		<ScopeProvider wire={wire}>
		<div style={{ display: "flex", minHeight: "100vh", background: "var(--bg-canvas)" }}>
			{/* The sidebar stays mounted on EVERY route and in the daemon-down state (D-5). */}
			<Sidebar
				entries={ROUTES}
				activeRoute={route}
				onNavigate={navigate}
				daemonUp={daemonUp}
				identity={identity}
				assetBase={assetBase}
				collapsed={collapsed}
				onToggleCollapsed={() => setCollapsed((c) => !c)}
			/>

			<div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
				{/* Shell chrome bar — the global "Pollinate now" action (relocated from the old Header, D-5). */}
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 12,
						padding: "16px 28px",
						borderBottom: "1px solid var(--border-subtle)",
					}}
				>
					<span style={{ flex: 1 }} />
					<Button variant="pollinate" onClick={() => void pollinate()} disabled={pollinating}>
						{pollinating ? "pollinating…" : "Pollinate now"}
					</Button>
				</div>

				{/* D-5: daemon-down → the content region swaps for the banner; the sidebar stays mounted.
				    Retry re-probes; a reachable result restores the active page (it re-hydrates on remount). */}
				{daemonUp ? (
					<Outlet route={route} pageProps={pageProps} navigate={navigate} />
				) : (
					<div style={{ flex: 1, minWidth: 0, padding: "28px 28px 48px" }}>
						<div style={{ maxWidth: PAGE_MAX_WIDTH, margin: "0 auto" }}>
							<ConnectivityBanner
								url={daemonUrl}
								onRetry={() => {
									void wire.health().then(({ up }) => {
										setDaemonUp(up);
										if (up) void hydrateIdentity();
									});
								}}
							/>
						</div>
					</div>
				)}
			</div>
		</div>
		</ScopeProvider>
	);
}

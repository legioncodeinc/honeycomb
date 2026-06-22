/**
 * The dashboard CLIENT-SIDE ROUTER — PRD-037b (the routing engine).
 *
 * A tiny in-repo routing primitive: NO `react-router`, NO History API, NO new dependency
 * (D-1 / D-2). The dashboard is served as static assets by `src/daemon/runtime/dashboard/host.ts`,
 * which registers exactly FOUR GET routes (the shell, `app.js`, `styles.css`, the mark) and has
 * no catch-all. History-API (pushState) routing would put real paths in the URL
 * (`/dashboard/graph`); a refresh or deep link there would 404 at the daemon unless the host
 * served the shell for every `/dashboard/*` path — a new server route the parent PRD's non-goals
 * forbid. HASH routing puts the route in the fragment (`/dashboard#/graph`): the browser never
 * sends the fragment to the server, so the daemon always serves the same shell and the client
 * resolves the route from `location.hash`. Refresh-safe deep links, ZERO host changes (D-1).
 *
 * The hook reads `location.hash`, subscribes to `hashchange` (cleaning up on unmount, mirroring
 * the poll-cleanup pattern in the old `app.tsx`), and exposes `{ route, navigate }`. `navigate`
 * is the SINGLE place that mutates `location.hash`, so the sidebar's `onNavigate` (037a) stays a
 * thin pass-through that never touches the hash itself (037a AC-4 keeps that testable).
 */

import React from "react";

/**
 * Parse the current route string from `location.hash`. Strips a leading `#`, then normalizes:
 * an empty hash (or a bare `#`) becomes the default `/`. The returned value is the RAW route key
 * (path-like, e.g. `/graph`); resolving it to a registry entry (and the unknown→Dashboard
 * fallback, 037b AC-4) is `matchRoute`'s job in the registry, NOT this parser's — this keeps the
 * hook a pure reflection of the URL fragment and the fallback policy in one place (037c).
 */
export function routeFromHash(hash: string): string {
	// `location.hash` includes the leading "#" (or is "" when absent). Strip it; default to "/".
	const raw = hash.startsWith("#") ? hash.slice(1) : hash;
	const trimmed = raw.trim();
	return trimmed === "" ? "/" : trimmed;
}

/** The hash-router contract the Shell consumes: the active route + a `navigate` helper. */
export interface HashRoute {
	/** The active route parsed from `location.hash` (path-like, e.g. `/` or `/graph`). */
	readonly route: string;
	/** Set `location.hash` to `r` (the `hashchange` listener then re-renders). The ONLY hash mutator. */
	readonly navigate: (r: string) => void;
}

/**
 * Read the active route from `location.hash` and re-render on `hashchange` (037b AC-1). Subscribes
 * in a `useEffect` and unsubscribes on unmount. `navigate(r)` assigns `location.hash = r`, which
 * fires `hashchange` and flows back through this same listener — so there is exactly one source of
 * truth (the URL) and one mutator (`navigate`). Deep-linking works for free: the initial state
 * reads whatever hash the page loaded with (037b AC-3), so a refresh on `/dashboard#/graph` mounts
 * the Graph route.
 */
export function useHashRoute(): HashRoute {
	const [route, setRoute] = React.useState<string>(() =>
		// SSR/test-safe initial read: `window` exists in jsdom + the browser; guard defensively.
		typeof window === "undefined" ? "/" : routeFromHash(window.location.hash),
	);

	React.useEffect(() => {
		if (typeof window === "undefined") return;
		const onHashChange = (): void => setRoute(routeFromHash(window.location.hash));
		// Re-sync once on mount in case the hash changed between the initial render and the effect.
		onHashChange();
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);

	const navigate = React.useCallback((r: string): void => {
		if (typeof window === "undefined") return;
		// Mutate the hash; the `hashchange` listener above re-renders. The leading "#" is implicit
		// when assigning a path-like value, but we normalize so `#/graph` is what lands in the URL.
		const next = r.startsWith("#") ? r : `#${r}`;
		window.location.hash = next;
	}, []);

	return { route, navigate };
}

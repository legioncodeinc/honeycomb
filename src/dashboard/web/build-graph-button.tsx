/**
 * The shared "Build graph" BUTTON — the codebase-graph build trigger, used on BOTH graph surfaces.
 *
 * Two places show the codebase-graph empty state — the full-page Graph (`pages/graph.tsx`) and the home
 * GraphPanel (`panels.tsx`). Before, each showed a dead `honeycomb graph build` CLI hint. This single
 * component replaces that with a working primary button wired to the daemon's already-served
 * `POST /api/graph/build` (via `wire.buildGraph()`), so the logic lives in ONE place (jscpd discipline)
 * and both surfaces behave identically.
 *
 * Behavior (mirrors the shell's `pollinate` action in `app.tsx`):
 *   - A SYNCHRONOUS in-flight ref guards re-entry: `setBuilding(true)` is async, so a render-state guard
 *     alone leaves a race where a rapid double-click fires `wire.buildGraph()` twice. The ref flips
 *     IMMEDIATELY, so exactly one POST goes out per build even on a double-click.
 *   - While in flight the button reads "Building…" and is disabled.
 *   - On a `{ built: true }` ack it calls `onBuilt()` so the surface RE-HYDRATES its graph source (re-run
 *     `wire.graph()`) and the fresh LOCAL snapshot renders WITHOUT a manual reload (no eventual-consistency
 *     wait — the build wrote a local file the next `GET /api/graph` reads immediately).
 *   - On a `{ built: false }` ack (the daemon rejected/failed, or the wire timed out/degraded) it shows an
 *     honest inline error line and keeps a small secondary `honeycomb graph build` CLI hint for power users.
 *
 * The wire NEVER throws (it degrades to a failure ack), so this component never needs a try/catch around
 * the call. Every visual value is an existing `var(--…)` DS token; no new dependency.
 */

import React from "react";

import { Button } from "./primitives.js";
import type { WireClient } from "./wire.js";

/** Props for {@link BuildGraphButton}. */
export interface BuildGraphButtonProps {
	/** The shared wire client (the page/panel threads the one the shell built — never `createWireClient`). */
	readonly wire: WireClient;
	/**
	 * Called after a SUCCESSFUL build (`{ built: true }`) so the host surface re-hydrates its graph source
	 * (re-run `wire.graph()`) and the fresh snapshot renders without a reload. May be async; its result is
	 * awaited so the button stays in flight until the re-hydrate settles.
	 */
	readonly onBuilt: () => void | Promise<void>;
}

/** The dead CLI command the build used to be — kept ONLY as a small secondary hint on failure (power users). */
const BUILD_CLI_HINT = "honeycomb graph build";

/**
 * The shared Build-graph button. Renders a primary button that triggers the real daemon build, re-hydrates
 * the active graph on success, and surfaces an honest inline error + the CLI hint on failure. Mirrors the
 * `pollinateInFlightRef` synchronous re-entry guard so a double-click POSTs exactly once.
 */
export function BuildGraphButton({ wire, onBuilt }: BuildGraphButtonProps): React.JSX.Element {
	const [building, setBuilding] = React.useState(false);
	const [failed, setFailed] = React.useState(false);
	// Synchronous re-entry guard (no double POST on rapid clicks — mirrors app.tsx's pollinateInFlightRef).
	const inFlightRef = React.useRef(false);
	// Guard against a state update after unmount (the build is slow; the surface may unmount mid-build).
	const aliveRef = React.useRef(true);
	React.useEffect(() => {
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
		};
	}, []);

	const onBuild = React.useCallback(async (): Promise<void> => {
		if (inFlightRef.current) return; // synchronous guard — exactly one POST per build
		inFlightRef.current = true;
		setBuilding(true);
		setFailed(false);
		const ack = await wire.buildGraph();
		if (ack.built) {
			// Re-hydrate the active graph source so the fresh LOCAL snapshot renders without a reload.
			await onBuilt();
		}
		if (aliveRef.current) {
			setFailed(!ack.built);
			setBuilding(false);
		}
		inFlightRef.current = false;
	}, [wire, onBuilt]);

	return (
		<div data-testid="build-graph" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
			<Button variant="primary" onClick={() => void onBuild()} disabled={building} data-testid="build-graph-button">
				{building ? "Building…" : "Build graph"}
			</Button>
			{failed && (
				<>
					<span data-testid="build-graph-error" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--severity-critical)" }}>
						Build failed — the daemon could not build the graph.
					</span>
					<code style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>{BUILD_CLI_HINT}</code>
				</>
			)}
		</div>
	);
}

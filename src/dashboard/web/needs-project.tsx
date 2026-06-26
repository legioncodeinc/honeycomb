/**
 * The shared "needs a project selection" EMPTY STATE — PRD-049e (49e-AC-5) — and the FIRST-RUN
 * "pick a folder to start" CTA — PRD-059b (b-AC-1).
 *
 * When no project is selected in the scope switcher (or none is accessible), every project-specific
 * page renders {@link NeedsProjectSelection} — the explicit empty/needs-selection state INSTEAD of any
 * data, never another project's rows. It is one shared component (not duplicated per page) so the copy
 * stays consistent and the jscpd gate is satisfied (a single definition, three call sites).
 *
 * When the workspace has ZERO bound projects, the dashboard's PRIMARY content is {@link FirstRunBindCTA}
 * (b-AC-1): a purposeful "No active projects? Pick a folder to start" call-to-action with one line of
 * plain instruction and the daemon-served {@link FolderPicker} behind it. On a successful bind it routes
 * to the Projects page (b-AC-4). Both live here so the empty-state family stays one module. Every visual
 * value is an existing DS token.
 */

import React from "react";

import { Button } from "./primitives.js";
import { FolderPicker } from "./folder-picker.js";
import { PROJECTS_ROUTE } from "./registry.js";
import type { BindAckWire, WireClient } from "./wire.js";

/**
 * The explicit needs-selection panel (49e-AC-5). Rendered by the graph / memories / sync pages when
 * `useScope().scope.project` is undefined: an honest "pick a project to view its <surface>" message,
 * NOT a faked/another-project's view. `surface` names the page's data ("codebase graph", "memories", …)
 * so the copy reads naturally per page.
 */
export function NeedsProjectSelection({ surface }: { surface: string }): React.JSX.Element {
	return (
		<div
			data-testid="needs-project-selection"
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				gap: 10,
				minHeight: 320,
				padding: "48px 16px",
				background: "var(--bg-surface)",
				border: "1px solid var(--border-default)",
				borderRadius: "var(--radius-lg)",
				textAlign: "center",
			}}
		>
			<div style={{ fontSize: 15, color: "var(--text-secondary)" }}>No project selected.</div>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)", maxWidth: 460 }}>
				Pick a project in the scope switcher (top of the sidebar) to view its {surface}.
			</span>
		</div>
	);
}

/** Props for {@link FirstRunBindCTA}. */
export interface FirstRunBindCTAProps {
	/** The shared wire client (the shell/page passes the SAME one — never `createWireClient`). */
	readonly wire: WireClient;
	/**
	 * Navigate the dashboard to a hash route. On a successful first bind the CTA routes to the Projects
	 * page (b-AC-4). The shell passes its 037b `navigate`; a test passes a spy.
	 */
	readonly navigate: (route: string) => void;
	/**
	 * The host-stamped asset base (`data-asset-base`, `/dashboard` in production). The brand mark MUST
	 * be resolved against it — a hardcoded relative `assets/…` resolves to the unserved `/assets/…`
	 * (a 404), unlike the sidebar/setup-gate which already use `assetBase`. Threaded from `PageProps`.
	 */
	readonly assetBase: string;
}

/**
 * The first-run "Pick a folder to start" CTA (PRD-059b b-AC-1). Rendered as the PRIMARY dashboard
 * content when the workspace has ZERO bound projects — never an empty switcher or a blank page. It
 * states the one action plainly ("point Honeycomb at the repo or folder you want it to remember"),
 * then reveals the daemon-served {@link FolderPicker} so the user can browse, name, and bind a folder.
 * On a successful bind it advances to the Projects page (b-AC-4); capture begins because the 059a gate
 * opens the moment the binding is written (daemon-side).
 */
export function FirstRunBindCTA({ wire, navigate, assetBase }: FirstRunBindCTAProps): React.JSX.Element {
	const [picking, setPicking] = React.useState(false);

	const onBound = React.useCallback(
		(_ack: BindAckWire): void => {
			// b-AC-4: the bind is written + the 059a gate opened daemon-side; advance to the Projects page
			// where the freshly-bound project now appears (the page hydrates from the synced registry).
			navigate(PROJECTS_ROUTE);
		},
		[navigate],
	);

	return (
		<div
			data-testid="first-run-bind"
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				gap: 16,
				padding: "48px 16px",
				background: "var(--bg-surface)",
				border: "1px solid var(--border-default)",
				borderRadius: "var(--radius-lg)",
				textAlign: "center",
			}}
		>
			<img src={`${assetBase}/honeycomb-memory-cluster.svg`} width={48} height={48} alt="" />
			<div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 480 }}>
				<div style={{ fontSize: 17, fontWeight: 700, color: "var(--text-primary)", letterSpacing: "-0.02em" }}>No active projects?</div>
				<div style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.5 }}>
					Pick a folder to start — point Honeycomb at the repo or folder you want it to remember, and it begins capturing there.
				</div>
			</div>

			{picking ? (
				// The picker is a full-width controlled surface (left-aligned for the browse tree).
				<div style={{ width: "100%", maxWidth: 620, textAlign: "left" }}>
					<FolderPicker wire={wire} onBound={onBound} onCancel={() => setPicking(false)} />
				</div>
			) : (
				<Button variant="primary" size="lg" onClick={() => setPicking(true)} data-testid="first-run-pick">
					Pick a folder to start
				</Button>
			)}
		</div>
	);
}

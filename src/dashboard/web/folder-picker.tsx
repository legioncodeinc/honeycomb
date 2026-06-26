/**
 * The daemon-served FOLDER PICKER — PRD-059b (b-AC-2 / b-AC-3 / b-AC-4 / b-AC-5).
 *
 * ── Why the daemon serves the tree ───────────────────────────────────────────
 * A browser CANNOT hand back an absolute filesystem path — the File System Access API returns an
 * opaque handle by design. The local daemon already has fs access, so it serves a dirs-only browse
 * tree (`GET /api/diagnostics/fs/browse`) and the dashboard renders it; the user navigates, picks a
 * folder, and the dashboard posts the chosen ABSOLUTE path back to bind. This is the ONLY component
 * that can return a real, bindable absolute path (b-AC-2).
 *
 * ── What this component does ─────────────────────────────────────────────────
 * It is a controlled, self-contained picker reused by BOTH 059b (the first-run empty-state CTA) and
 * 059c (the Projects page "Add a project" flow). It:
 *   1. Browses from the daemon's allowed root (home by default), letting the user descend into child
 *      directories and climb back to the parent (never above the root — the daemon clamps).
 *   2. Marks git repos (a bind hint) and, on selecting a folder, pre-fills the project-name field
 *      from the daemon's CLI-identical suggestion when the chosen folder carries a git remote (b-AC-3)
 *      — derived daemon-side; the picker just surfaces it editably.
 *   3. On confirm, POSTs `projects/bind { path, name }` and calls `onBound` with the bind ack so the
 *      caller advances (059b → the Projects page; 059c → re-list).
 *
 * ── Daemon-down / local-mode-off → plain message + CLI fallback (b-AC-5) ─────
 * Every read/write degrades through the wire's fail-soft layer (an empty browse / a not-bound ack),
 * never a hang. When the browse comes back empty AND errored (or the daemon is unreachable), the
 * picker shows a plain message and the `honeycomb project bind` CLI hint — never a silent failure.
 *
 * Security (inherited): the surface is LOCAL-MODE-ONLY (the daemon routes 404 otherwise); every path
 * renders as ESCAPED TEXT (React default); NO token/secret rides any browse/bind body. Every visual
 * value is an existing `var(--…)` design token (no new token).
 */

import React from "react";

import { Badge, Button, Input } from "./primitives.js";
import { EMPTY_BROWSE, type BindAckWire, type BrowseBodyWire, type WireClient } from "./wire.js";

/** The CLI command shown in the daemon-down / local-mode-off fallback (b-AC-5). */
export const CLI_BIND_HINT = "honeycomb project bind" as const;

/** Derive a default project-name suggestion from a chosen folder's basename (the picker's local fallback). */
export function basenameOf(absPath: string): string {
	const trimmed = absPath.replace(/[\\/]+$/, "");
	const parts = trimmed.split(/[\\/]/);
	const base = parts[parts.length - 1] ?? "";
	return base;
}

/** Props for {@link FolderPicker}. */
export interface FolderPickerProps {
	/** The shared wire client (the caller passes the SAME one — never `createWireClient`). */
	readonly wire: WireClient;
	/**
	 * Called with the bind ack after a SUCCESSFUL bind (`bound:true`). The caller advances: 059b routes
	 * to the Projects page; 059c re-lists + closes. A rejected bind stays in the picker with the error.
	 */
	readonly onBound: (ack: BindAckWire) => void;
	/** Optional cancel affordance (059c renders the picker in a modal with a Cancel). Omitted ⇒ no cancel. */
	readonly onCancel?: () => void;
}

/** One row in the browse tree — a child directory (descend on click), marked if it is a git repo. */
function BrowseRow({ child, onDescend }: { child: BrowseBodyWire["children"][number]; onDescend: (path: string) => void }): React.JSX.Element {
	return (
		<button
			type="button"
			data-testid="browse-row"
			data-path={child.path}
			onClick={() => onDescend(child.path)}
			style={{
				display: "flex",
				alignItems: "center",
				gap: 10,
				width: "100%",
				textAlign: "left",
				padding: "9px 12px",
				background: "var(--bg-elevated)",
				border: "1px solid var(--border-default)",
				borderRadius: "var(--radius-md)",
				cursor: "pointer",
				color: "var(--text-primary)",
			}}
		>
			{/* A folder glyph — inline SVG, currentColor, no new dependency. */}
			<svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: "none", color: "var(--text-tertiary)" }}>
				<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
			</svg>
			<span style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
				{child.name}
			</span>
			{child.isGitRepo && (
				<Badge tone="honey" mono>
					git
				</Badge>
			)}
		</button>
	);
}

/**
 * The folder picker (059b). Browses the daemon's dirs-only tree, lets the user pick a folder (with a
 * git-derived name suggestion), and binds the chosen absolute path. Reused by the first-run CTA (059b)
 * and the Projects page "Add a project" flow (059c).
 */
export function FolderPicker({ wire, onBound, onCancel }: FolderPickerProps): React.JSX.Element {
	const [browse, setBrowse] = React.useState<BrowseBodyWire>(EMPTY_BROWSE);
	const [hydrated, setHydrated] = React.useState(false);
	// The folder the user has SELECTED to bind (distinct from the dir being browsed). Null = none yet.
	const [selected, setSelected] = React.useState<{ path: string; isGitRepo: boolean } | null>(null);
	const [name, setName] = React.useState("");
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState("");
	// A synchronous in-flight guard so a rapid double-click never fires two binds.
	const inFlightRef = React.useRef(false);

	/** Browse a dir (or the root when `path` is undefined). Fail-soft via the wire. */
	const goTo = React.useCallback(
		async (path?: string): Promise<void> => {
			const body = await wire.fsBrowse(path);
			setBrowse(body);
			setHydrated(true);
		},
		[wire],
	);

	// Hydrate the root on mount.
	React.useEffect(() => {
		void goTo(undefined);
	}, [goTo]);

	// b-AC-5: the daemon is unreachable / local-mode is off (or the dir is unreadable) when the browse
	// returns no children AND an error (or no resolved path at all). Show the plain message + CLI hint.
	const unavailable = hydrated && browse.path === "" && browse.children.length === 0;
	const dirErrored = browse.error !== undefined && browse.error !== "";

	/** Select the CURRENTLY-BROWSED dir as the folder to bind, pre-filling the name (b-AC-3). */
	const selectCurrent = React.useCallback((): void => {
		if (browse.path === "") return;
		setSelected({ path: browse.path, isGitRepo: false });
		// The name suggestion: the daemon derives the git-remote-or-basename name on bind, but we
		// pre-fill the basename locally so the field is never blank; the user edits before confirm.
		setName(basenameOf(browse.path));
		setError("");
	}, [browse.path]);

	/** Select a CHILD folder (without descending) as the folder to bind. */
	const selectChild = React.useCallback((child: BrowseBodyWire["children"][number]): void => {
		setSelected({ path: child.path, isGitRepo: child.isGitRepo });
		setName(basenameOf(child.path));
		setError("");
	}, []);

	/** Confirm the bind: POST the absolute path + name, advance on success, surface the error otherwise. */
	const confirm = React.useCallback(async (): Promise<void> => {
		if (selected === null || inFlightRef.current) return;
		inFlightRef.current = true;
		setBusy(true);
		setError("");
		const ack = await wire.bindProject({ path: selected.path, ...(name.trim() !== "" ? { name: name.trim() } : {}) });
		setBusy(false);
		inFlightRef.current = false;
		if (ack.bound) {
			onBound(ack);
			return;
		}
		// A rejected bind (the reserved inbox, a degenerate name, a non-absolute path, or daemon-down)
		// stays in the picker with the daemon's redacted reason — never a silent failure (b-AC-5).
		setError(ack.error !== undefined && ack.error !== "" ? ack.error : "Could not bind that folder.");
	}, [selected, name, wire, onBound]);

	return (
		<div data-testid="folder-picker" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
			{unavailable ? (
				// b-AC-5: daemon unreachable / local-mode off → a plain message + the CLI fallback. Never a hang.
				<div data-testid="picker-unavailable" style={{ display: "flex", flexDirection: "column", gap: 8, padding: "16px", background: "var(--bg-surface)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-lg)" }}>
					<span style={{ fontSize: 14, color: "var(--text-secondary)" }}>The folder browser isn&rsquo;t available right now.</span>
					<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>
						Bind a folder from your terminal instead: <code style={{ color: "var(--honey)" }}>{CLI_BIND_HINT}</code>
					</span>
					{onCancel !== undefined && (
						<div>
							<Button variant="ghost" size="sm" onClick={onCancel}>
								Close
							</Button>
						</div>
					)}
				</div>
			) : (
				<>
					{/* The current path + navigation (climb to parent, select this dir). */}
					<div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
						<span data-testid="picker-path" style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
							{browse.path !== "" ? browse.path : "loading…"}
						</span>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => void goTo(browse.parent ?? undefined)}
							disabled={browse.parent === null}
							title={browse.parent === null ? "at the allowed root" : "up one level"}
						>
							↑ up
						</Button>
						<Button variant="secondary" size="sm" onClick={selectCurrent} disabled={browse.path === ""} data-testid="select-current">
							Use this folder
						</Button>
					</div>

					{/* The dirs-only browse list (b-AC-2). Click a row to DESCEND; "use" it to select to bind. */}
					<div data-testid="browse-list" style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 280, overflowY: "auto" }}>
						{!hydrated ? (
							<div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>loading…</div>
						) : browse.children.length === 0 ? (
							<div style={{ padding: "10px 4px", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>
								{dirErrored ? "This folder couldn’t be read." : "No sub-folders here — use this folder, or go up."}
							</div>
						) : (
							browse.children.map((child) => (
								<div key={child.path} style={{ display: "flex", gap: 8 }}>
									<div style={{ flex: 1, minWidth: 0 }}>
										<BrowseRow child={child} onDescend={(p) => void goTo(p)} />
									</div>
									<Button variant="ghost" size="sm" onClick={() => selectChild(child)} data-testid="select-child" title="select this folder to bind">
										select
									</Button>
								</div>
							))
						)}
					</div>

					{/* The selected folder + the editable name + confirm (b-AC-3 / b-AC-4). */}
					{selected !== null && (
						<div data-testid="picker-confirm" style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14, background: "var(--bg-surface)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-lg)" }}>
							<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
								<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>folder</span>
								<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)", wordBreak: "break-all" }}>{selected.path}</span>
								{selected.isGitRepo && <Badge tone="honey" mono>git</Badge>}
							</div>
							<label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
								<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>project name</span>
								<Input mono value={name} placeholder="project name" onChange={(e) => setName(e.target.value)} data-testid="picker-name" />
							</label>
							<div style={{ display: "flex", gap: 10, alignItems: "center" }}>
								<Button variant="primary" onClick={() => void confirm()} disabled={busy || name.trim() === ""} data-testid="picker-bind">
									{busy ? "Binding…" : "Bind project"}
								</Button>
								{onCancel !== undefined && (
									<Button variant="ghost" onClick={onCancel} disabled={busy}>
										Cancel
									</Button>
								)}
								{error !== "" && (
									<span data-testid="picker-error" style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--severity-critical)" }}>
										{error}
									</span>
								)}
							</div>
						</div>
					)}
				</>
			)}
		</div>
	);
}

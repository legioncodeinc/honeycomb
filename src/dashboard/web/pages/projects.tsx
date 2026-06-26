/**
 * The PROJECTS page — PRD-059c (the steady-state project manager) + PRD-059d (cross-device import).
 *
 * Mounts on the `#/projects` route inside the PRD-037 shell. It receives {@link PageProps} (the SHARED
 * `wire` — never `createWireClient` — plus `daemonUp`) and renders inside `<PageFrame eyebrow="projects">`.
 * It is the management home for everything Honeycomb is actively sourcing in the current workspace:
 *
 *   059c — LIST + STATE. Every project the workspace is sourcing (from `GET /api/diagnostics/scope/projects`,
 *          split on `boundLocally`: the ACTIVE list is the locally-bound projects). The reserved
 *          `__unsorted__` inbox is shown DISTINCTLY with its size (c-AC-2). Each project carries its
 *          name + the per-project state the live wire honestly provides; fields the Wave-1 daemon does
 *          NOT yet aggregate (bound paths, git remote, last-capture, memory/session counts) render as an
 *          honest "—" rather than fabricated values (the 059c implementation note defers those daemon
 *          aggregate reads; the page surfaces what the registry copy actually serves).
 *   059c — ADD (top-right "+"). A menu with two options (parent lean: one "+" with two options) — "New
 *          folder" runs the 059b daemon-served folder-pick → bind flow ({@link FolderPicker}); "Import
 *          existing" opens the 059d import modal. On a successful add the list re-hydrates (c-AC-3).
 *   059c — per-project UNBIND (`POST projects/unbind`) removes the LOCAL binding only — capture stops
 *          for that folder, the registry project + its existing data are UNTOUCHED (c-AC-4); and OPEN
 *          re-scopes the other surfaces to that project via the scope context (c-AC-5 / 049e view scope).
 *   059d — IMPORT MODAL lists the workspace's registry projects with NO local binding on this device
 *          (`?unbound=1`), and binds a chosen folder to the selected existing `project_id` via
 *          `POST projects/bind-existing` (d-AC-1 UI / d-AC-2 path).
 *
 * Security (inherited from the shell): LOCAL-MODE-ONLY; every name/path renders as ESCAPED TEXT (React
 * default); NO token/secret rides any list/bind/unbind body. Every visual value is an existing DS token.
 */

import React from "react";

import { Badge, Button } from "../primitives.js";
import { PageFrame, type PageProps } from "../page-frame.js";
import { useScope } from "../scope-context.js";
import { FolderPicker } from "../folder-picker.js";
import { type BindAckWire, type ScopeProjectWire, type WireClient } from "../wire.js";

/** The reserved inbox project id (mirrored from the resolver; a literal so this stays a thin-client view). */
export const UNSORTED_PROJECT_ID = "__unsorted__" as const;

/** The shared surface card style (matches the kit's panel/elevated rhythm — mirrors memories.tsx). */
const SURFACE: React.CSSProperties = {
	padding: 16,
	background: "var(--bg-surface)",
	border: "1px solid var(--border-default)",
	borderRadius: "var(--radius-lg)",
};

/** A muted "not available yet" placeholder for a per-project field the Wave-1 daemon does not aggregate. */
function NotYet(): React.JSX.Element {
	return <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>—</span>;
}

// ─────────────────────────────────────────────────────────────────────────────
// One active-project row (059c)
// ─────────────────────────────────────────────────────────────────────────────

/** Props for {@link ProjectRow}. */
interface ProjectRowProps {
	readonly project: ScopeProjectWire;
	readonly wire: WireClient;
	/** Open the project: re-scope the other surfaces to it via the scope context (c-AC-5). */
	readonly onOpen: (projectId: string) => void;
	/** Called after a successful unbind so the page re-lists (c-AC-4). */
	readonly onUnbound: () => void;
}

/**
 * One ACTIVE project row (059c). Shows the project name + the per-project state the live wire provides;
 * the daemon-not-yet-aggregated fields (bound path(s), git remote, last capture, memory/session counts)
 * render as an honest "—" (the Wave-1 registry read serves name + boundLocally only — the per-project
 * aggregates are a deferred daemon read per the 059c implementation note). Per-row OPEN (re-scope) +
 * UNBIND actions.
 *
 * UNBIND is binding-driven (the daemon's `projects/unbind` keys on the absolute folder PATH, not the
 * project id — and the registry read does not serve the path). So Unbind opens the folder picker to
 * select the folder to release, then POSTs the unbind. This keeps the action genuinely live (c-AC-4 —
 * a real binding is removed) without inventing a path the daemon never gave us.
 */
function ProjectRow({ project, wire, onOpen, onUnbound }: ProjectRowProps): React.JSX.Element {
	const [unbinding, setUnbinding] = React.useState(false);
	const [path, setPath] = React.useState<string | null>(null);
	const [busy, setBusy] = React.useState(false);
	const [note, setNote] = React.useState("");
	const inFlightRef = React.useRef(false);

	const confirmUnbind = async (): Promise<void> => {
		if (path === null || inFlightRef.current) return;
		inFlightRef.current = true;
		setBusy(true);
		setNote("");
		const ack = await wire.unbindProject({ path });
		setBusy(false);
		inFlightRef.current = false;
		if (ack.unbound) {
			setUnbinding(false);
			setPath(null);
			onUnbound();
			return;
		}
		setNote("No binding matched that folder — capture is unchanged.");
	};

	return (
		<div data-testid="project-row" data-project-id={project.projectId} style={{ ...SURFACE, display: "flex", flexDirection: "column", gap: 10 }}>
			<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600, color: "var(--honey)" }}>
					{project.name !== "" ? project.name : project.projectId}
				</span>
				<Badge tone="verified" mono dot>
					sourcing
				</Badge>
				<span style={{ flex: 1 }} />
				<Button variant="secondary" size="sm" onClick={() => onOpen(project.projectId)} data-testid="project-open">
					Open
				</Button>
				<Button variant="ghost" size="sm" onClick={() => setUnbinding((u) => !u)} data-testid="project-unbind">
					{unbinding ? "Cancel" : "Unbind"}
				</Button>
			</div>

			{/* Per-project state. The wire serves name + boundLocally today; the richer aggregates (paths,
			    remote, last-capture, counts) are not yet served by the Wave-1 daemon, so they read "—"
			    honestly rather than fabricated. */}
			<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, paddingTop: 4, borderTop: "1px solid var(--border-subtle)" }}>
				<MetaCell label="bound path" value={<NotYet />} />
				<MetaCell label="git remote" value={<NotYet />} />
				<MetaCell label="last capture" value={<NotYet />} />
				<MetaCell label="memories / sessions" value={<NotYet />} />
			</div>

			{unbinding && (
				<div data-testid="project-unbind-panel" style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 4, borderTop: "1px solid var(--border-subtle)" }}>
					<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>
						Pick the folder to release. Unbind removes this device&rsquo;s binding (capture stops there); the project and its memories are kept.
					</span>
					<FolderSelect wire={wire} onSelect={setPath} selected={path} />
					<div style={{ display: "flex", gap: 10, alignItems: "center" }}>
						<Button variant="danger" size="sm" onClick={() => void confirmUnbind()} disabled={busy || path === null} data-testid="project-unbind-confirm">
							{busy ? "…" : "Unbind this folder"}
						</Button>
						{note !== "" && (
							<span data-testid="project-unbind-note" style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--severity-warning)" }}>
								{note}
							</span>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

/** A labeled metadata cell (mono caption + value). */
function MetaCell({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)" }}>{value}</span>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The __unsorted__ inbox row (059c c-AC-2)
// ─────────────────────────────────────────────────────────────────────────────

/** The reserved inbox shown DISTINCTLY with its size (c-AC-2). `present` = the inbox exists in the registry. */
function InboxRow(): React.JSX.Element {
	return (
		<div data-testid="inbox-row" style={{ ...SURFACE, display: "flex", alignItems: "center", gap: 10, borderStyle: "dashed" }}>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600, color: "var(--text-secondary)" }}>(unsorted inbox)</span>
			<Badge tone="neutral" mono>
				{UNSORTED_PROJECT_ID}
			</Badge>
			<span style={{ flex: 1 }} />
			{/* The inbox size (row count) is not served by the Wave-1 registry read — surfaced honestly as "—". */}
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>size —</span>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The "+ Add" menu (059c c-AC-3) — one "+" with two options (parent lean)
// ─────────────────────────────────────────────────────────────────────────────

/** The add-flow the page is currently showing (none / new-folder pick / import existing). */
type AddFlow = "none" | "new" | "import";

/** The top-right "+ Add" menu: New folder (059b pick→bind) or Import existing (059d modal). */
function AddMenu({ onNew, onImport }: { onNew: () => void; onImport: () => void }): React.JSX.Element {
	const [open, setOpen] = React.useState(false);
	return (
		<div style={{ position: "relative" }}>
			<Button variant="primary" size="sm" onClick={() => setOpen((o) => !o)} data-testid="add-menu-toggle">
				+ Add
			</Button>
			{open && (
				<div
					data-testid="add-menu"
					style={{
						position: "absolute",
						right: 0,
						top: 38,
						zIndex: 5,
						display: "flex",
						flexDirection: "column",
						minWidth: 180,
						background: "var(--bg-elevated)",
						border: "1px solid var(--border-default)",
						borderRadius: "var(--radius-md)",
						boxShadow: "var(--shadow-md, 0 6px 24px rgba(0,0,0,0.18))",
						overflow: "hidden",
					}}
				>
					<MenuItem label="New folder" hint="pick a folder to bind" onClick={() => { setOpen(false); onNew(); }} testId="add-new" />
					<MenuItem label="Import existing" hint="from the cloud registry" onClick={() => { setOpen(false); onImport(); }} testId="add-import" />
				</div>
			)}
		</div>
	);
}

/** One row in the Add menu. */
function MenuItem({ label, hint, onClick, testId }: { label: string; hint: string; onClick: () => void; testId: string }): React.JSX.Element {
	return (
		<button
			type="button"
			data-testid={testId}
			onClick={onClick}
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 2,
				width: "100%",
				textAlign: "left",
				padding: "9px 12px",
				background: "transparent",
				border: "none",
				borderBottom: "1px solid var(--border-subtle)",
				cursor: "pointer",
			}}
		>
			<span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{label}</span>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-tertiary)" }}>{hint}</span>
		</button>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The 059d "Import project from cloud" modal
// ─────────────────────────────────────────────────────────────────────────────

/** Props for {@link ImportModal}. */
interface ImportModalProps {
	readonly wire: WireClient;
	/** Close the modal (cancel or after a successful import). */
	readonly onClose: () => void;
	/** Called after a successful bind-to-existing so the page re-lists (the imported project becomes active). */
	readonly onImported: (ack: BindAckWire) => void;
}

/**
 * The cross-device IMPORT modal (PRD-059d). Lists the workspace's registry projects with NO local
 * binding on this device (`scopeProjects({ unbound: true })` → d-AC-1 UI), lets the user select one,
 * then pick a local folder ({@link FolderPicker} in select-only mode is not reused — instead the user
 * picks the folder here and we bind-to-existing). Selecting a project + a folder POSTs
 * `projects/bind-existing` (d-AC-2 path). Privilege-scoped: the list is exactly what the token can see.
 */
function ImportModal({ wire, onClose, onImported }: ImportModalProps): React.JSX.Element {
	const [importable, setImportable] = React.useState<readonly ScopeProjectWire[]>([]);
	const [hydrated, setHydrated] = React.useState(false);
	const [selectedProject, setSelectedProject] = React.useState<string | null>(null);
	const [browsePath, setBrowsePath] = React.useState<string | null>(null);
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState("");
	const inFlightRef = React.useRef(false);

	// Hydrate the importable (registry-only) projects on mount (d-AC-1).
	React.useEffect(() => {
		let alive = true;
		void (async () => {
			const rows = await wire.scopeProjects({ unbound: true });
			if (!alive) return;
			setImportable(rows.filter((p) => p.projectId !== UNSORTED_PROJECT_ID));
			setHydrated(true);
		})();
		return () => {
			alive = false;
		};
	}, [wire]);

	// Bind the chosen folder to the selected EXISTING project (d-AC-2). The FolderPicker drives the
	// browse, but its bind is the NEW-project path — so here we intercept its selection: we render the
	// picker and, on its onBound (which would create a new project), we instead want bind-existing. To
	// keep one picker, we capture the chosen path via a select-folder step below.
	const confirmImport = React.useCallback(async (): Promise<void> => {
		if (selectedProject === null || browsePath === null || inFlightRef.current) return;
		inFlightRef.current = true;
		setBusy(true);
		setError("");
		const ack = await wire.bindExistingProject({ path: browsePath, projectId: selectedProject });
		setBusy(false);
		inFlightRef.current = false;
		if (ack.bound) {
			onImported(ack);
			return;
		}
		setError(ack.error !== undefined && ack.error !== "" ? ack.error : "Could not import that project.");
	}, [selectedProject, browsePath, wire, onImported]);

	return (
		<ModalShell title="Import project from cloud" onClose={onClose} testId="import-modal">
			<div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
				{/* Step 1: pick a registry-only project (d-AC-1). */}
				<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
					<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
						projects in this workspace not yet on this device
					</span>
					{!hydrated ? (
						<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>loading…</span>
					) : importable.length === 0 ? (
						<span data-testid="import-empty" style={{ fontSize: 13, color: "var(--text-tertiary)" }}>
							Every registry project is already bound on this device. Nothing to import.
						</span>
					) : (
						<div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 200, overflowY: "auto" }}>
							{importable.map((p) => (
								<button
									key={p.projectId}
									type="button"
									data-testid="import-project"
									data-project-id={p.projectId}
									onClick={() => setSelectedProject(p.projectId)}
									aria-pressed={selectedProject === p.projectId}
									style={{
										display: "flex",
										alignItems: "center",
										gap: 10,
										width: "100%",
										textAlign: "left",
										padding: "9px 12px",
										background: selectedProject === p.projectId ? "var(--honey-subtle)" : "var(--bg-elevated)",
										border: `1px solid ${selectedProject === p.projectId ? "var(--honey-border)" : "var(--border-default)"}`,
										borderRadius: "var(--radius-md)",
										cursor: "pointer",
										color: selectedProject === p.projectId ? "var(--honey)" : "var(--text-primary)",
										fontFamily: "var(--font-mono)",
										fontSize: 13,
										fontWeight: 600,
									}}
								>
									{p.name !== "" ? p.name : p.projectId}
								</button>
							))}
						</div>
					)}
				</div>

				{/* Step 2: pick a local folder to bind to the selected project (d-AC-2). */}
				{selectedProject !== null && (
					<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
						<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
							pick this device&rsquo;s folder for <span style={{ color: "var(--honey)" }}>{selectedProject}</span>
						</span>
						<FolderSelect wire={wire} onSelect={setBrowsePath} selected={browsePath} />
					</div>
				)}

				<div style={{ display: "flex", gap: 10, alignItems: "center" }}>
					<Button
						variant="primary"
						onClick={() => void confirmImport()}
						disabled={busy || selectedProject === null || browsePath === null}
						data-testid="import-confirm"
					>
						{busy ? "Importing…" : "Import project"}
					</Button>
					<Button variant="ghost" onClick={onClose} disabled={busy}>
						Cancel
					</Button>
					{error !== "" && (
						<span data-testid="import-error" style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--severity-critical)" }}>
							{error}
						</span>
					)}
				</div>
			</div>
		</ModalShell>
	);
}

/**
 * A folder SELECT-ONLY browser (059d step 2). Reuses the same daemon browse tree as the {@link FolderPicker}
 * but its job is only to emit the chosen ABSOLUTE path (the bind is bind-to-existing, owned by the modal).
 * Kept thin (browse + "use this folder") to avoid duplicating the full picker's bind UI.
 */
function FolderSelect({ wire, onSelect, selected }: { wire: WireClient; onSelect: (path: string) => void; selected: string | null }): React.JSX.Element {
	const [path, setPath] = React.useState<string>("");
	const [parent, setParent] = React.useState<string | null>(null);
	const [children, setChildren] = React.useState<readonly { name: string; path: string; isGitRepo: boolean }[]>([]);
	const [hydrated, setHydrated] = React.useState(false);

	const goTo = React.useCallback(
		async (to?: string): Promise<void> => {
			const body = await wire.fsBrowse(to);
			setPath(body.path);
			setParent(body.parent);
			setChildren(body.children);
			setHydrated(true);
		},
		[wire],
	);

	React.useEffect(() => {
		void goTo(undefined);
	}, [goTo]);

	if (hydrated && path === "" && children.length === 0) {
		return (
			<span data-testid="folderselect-unavailable" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>
				The folder browser isn&rsquo;t available — bind from your terminal: <code style={{ color: "var(--honey)" }}>honeycomb project bind</code>
			</span>
		);
	}

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
			<div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
				<span style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
					{path !== "" ? path : "loading…"}
				</span>
				<Button variant="ghost" size="sm" onClick={() => void goTo(parent ?? undefined)} disabled={parent === null}>
					↑ up
				</Button>
				<Button variant="secondary" size="sm" onClick={() => onSelect(path)} disabled={path === ""} data-testid="folderselect-use">
					Use this folder
				</Button>
			</div>
			<div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 180, overflowY: "auto" }}>
				{children.map((c) => (
					<button
						key={c.path}
						type="button"
						data-testid="folderselect-row"
						onClick={() => void goTo(c.path)}
						style={{
							display: "flex",
							alignItems: "center",
							gap: 8,
							width: "100%",
							textAlign: "left",
							padding: "8px 12px",
							background: "var(--bg-elevated)",
							border: "1px solid var(--border-default)",
							borderRadius: "var(--radius-md)",
							cursor: "pointer",
							color: "var(--text-primary)",
							fontFamily: "var(--font-mono)",
							fontSize: 13,
						}}
					>
						<span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{c.name}</span>
						{c.isGitRepo && <Badge tone="honey" mono>git</Badge>}
					</button>
				))}
			</div>
			{selected !== null && (
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--verified)" }}>selected: {selected}</span>
			)}
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// A minimal centered modal shell (no shared primitive exists; built from DS tokens)
// ─────────────────────────────────────────────────────────────────────────────

/** A centered overlay modal shell (059c/059d). Click the backdrop or Close to dismiss. Escaped content. */
function ModalShell({ title, onClose, testId, children }: { title: string; onClose: () => void; testId: string; children: React.ReactNode }): React.JSX.Element {
	return (
		<div
			data-testid={testId}
			role="dialog"
			aria-modal="true"
			aria-label={title}
			onClick={onClose}
			style={{
				position: "fixed",
				inset: 0,
				zIndex: 50,
				display: "flex",
				alignItems: "flex-start",
				justifyContent: "center",
				padding: "64px 16px",
				background: "rgba(0,0,0,0.45)",
			}}
		>
			<div
				onClick={(e) => e.stopPropagation()}
				style={{
					width: "100%",
					maxWidth: 560,
					maxHeight: "80vh",
					overflowY: "auto",
					padding: 20,
					background: "var(--bg-surface)",
					border: "1px solid var(--border-default)",
					borderRadius: "var(--radius-lg)",
				}}
			>
				<div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
					<h2 style={{ fontSize: "var(--text-base)", fontWeight: 700, color: "var(--text-primary)", margin: 0 }}>{title}</h2>
					<span style={{ flex: 1 }} />
					<Button variant="ghost" size="sm" onClick={onClose} aria-label="close">
						✕
					</Button>
				</div>
				{children}
			</div>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The page
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Projects page (059c/059d). Hydrates the workspace's projects on mount (split into active vs the
 * `__unsorted__` inbox), runs the "+ Add" flows (new-folder pick→bind and import-existing), per-project
 * Unbind (confirm-gated, registry-safe) and Open (re-scope via the scope context). After any add/unbind
 * the list re-hydrates so the rendered state is the daemon's persisted truth, never optimistic.
 */
export function ProjectsPage({ wire }: PageProps): React.JSX.Element {
	const { scope, setScope } = useScope();
	const [projects, setProjects] = React.useState<readonly ScopeProjectWire[]>([]);
	const [hydrated, setHydrated] = React.useState(false);
	const [flow, setFlow] = React.useState<AddFlow>("none");

	/** Re-list the workspace's projects (the persisted truth). */
	const reList = React.useCallback(async (): Promise<void> => {
		const rows = await wire.scopeProjects();
		setProjects(rows);
		setHydrated(true);
	}, [wire]);

	React.useEffect(() => {
		void reList();
	}, [reList]);

	// ACTIVE = locally-bound, non-inbox projects (c-AC-1). The inbox is shown distinctly (c-AC-2).
	const active = projects.filter((p) => p.boundLocally && p.projectId !== UNSORTED_PROJECT_ID);
	const inboxPresent = projects.some((p) => p.projectId === UNSORTED_PROJECT_ID);

	// c-AC-5: open a project → re-scope the other surfaces (memories/graph/sync) to it (049e view scope).
	const onOpen = React.useCallback(
		(projectId: string): void => {
			setScope({ org: scope.org, workspace: scope.workspace, project: projectId });
		},
		[setScope, scope.org, scope.workspace],
	);

	const onBoundNew = React.useCallback(
		(_ack: BindAckWire): void => {
			setFlow("none");
			void reList();
		},
		[reList],
	);

	const onImported = React.useCallback(
		(_ack: BindAckWire): void => {
			setFlow("none");
			void reList();
		},
		[reList],
	);

	return (
		<PageFrame
			eyebrow="projects"
			title="Projects"
			right={<AddMenu onNew={() => setFlow("new")} onImport={() => setFlow("import")} />}
		>
			{/* The "New folder" pick→bind flow (059b reused) renders inline above the list when active. */}
			{flow === "new" && (
				<div style={{ ...SURFACE, marginBottom: 16 }}>
					<div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 10 }}>Add a project</div>
					<FolderPicker wire={wire} onBound={onBoundNew} onCancel={() => setFlow("none")} />
				</div>
			)}

			{/* The 059d import modal (overlay). */}
			{flow === "import" && <ImportModal wire={wire} onClose={() => setFlow("none")} onImported={onImported} />}

			{/* The active-project list (c-AC-1). */}
			<div data-testid="projects-list" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
				{!hydrated ? (
					<div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>loading…</div>
				) : active.length === 0 ? (
					<div data-testid="projects-empty" style={{ padding: "10px 4px", fontSize: 13, color: "var(--text-tertiary)" }}>
						No active projects on this device yet. Use <strong>+ Add</strong> to bind a folder or import an existing project.
					</div>
				) : (
					active.map((p) => <ProjectRow key={p.projectId} project={p} wire={wire} onOpen={onOpen} onUnbound={() => void reList()} />)
				)}

				{/* c-AC-2: the reserved inbox, shown distinctly with its size, when present. */}
				{inboxPresent && <InboxRow />}
			</div>
		</PageFrame>
	);
}

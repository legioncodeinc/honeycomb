/**
 * The Org → Workspace → Project SCOPE context — PRD-050b seam, FILLED by PRD-049e.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 050b carved the seam (a context + a hook + a slot) so the 049e scope switcher could slot into the
 * sidebar WITHOUT reworking `host.ts`/`renderShell`/the shell. 049e FILLS it: a real
 * {@link ScopeProvider} hydrates the switchable Org→Workspace→Project selection from the daemon's
 * loopback enumeration endpoints, the {@link ScopeSwitcherSlot} renders the dropdowns, and every
 * scope-aware page reads the active project via {@link useScope}. The shell stays scope-UNAWARE —
 * scope lives entirely in the React app, never baked into the server-rendered shell.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── The contract (unchanged from 050b — additive only) ──────────────────────
 *   - {@link DashboardScope} `{ org, workspace, project? }` — what a page reads.
 *   - {@link useScope} — the hook every scope-aware surface uses. 049e makes it reactive to the
 *     switcher's selection; a surface written against this hook needs NO change.
 *   - {@link ScopeSwitcherSlot} — the sidebar region. 050b returned null; 049e renders the picker.
 *
 * ── Viewer-side selection (49e-AC-4) ─────────────────────────────────────────
 * The selection drives WHICH data the pages show (it stamps the `x-honeycomb-project` read header).
 * It does NOT overwrite a developer's per-folder CLI bindings: there is NO write to `projects.json`
 * anywhere in this module. The selection is persisted ONLY in `localStorage` (the dashboard session),
 * so a reload restores the last view without touching the registry.
 */

import React from "react";

import type { ScopeOrgWire, ScopeProjectWire, ScopeWorkspaceWire, WireClient } from "./wire.js";

/**
 * The active scope the dashboard reads (the 049e contract). `org` is always present; `workspace`
 * and `project` narrow it. 050b shipped the single loopback-local default; 049e makes these
 * switchable from the {@link ScopeSwitcherSlot}.
 */
export interface DashboardScope {
	/** The active org id (always present; the loopback "local" tenant until the switcher selects one). */
	readonly org: string;
	/** The active workspace id (the `default` sentinel until the switcher selects one). */
	readonly workspace: string;
	/** The active project id, when the scope is narrowed to one (049e); absent → no project selected. */
	readonly project?: string;
}

/** The single-scope default the app starts from (the loopback local tenant) until enumeration resolves. */
export const DEFAULT_SCOPE: DashboardScope = Object.freeze({ org: "local", workspace: "default" });

/** The `localStorage` key the dashboard persists its last viewer-side selection under (49e — viewer-side). */
export const SCOPE_STORAGE_KEY = "honeycomb.dashboard.scope" as const;

/** The scope context value — the active scope plus a `setScope` the switcher wires to its dropdowns. */
export interface ScopeContextValue {
	/** The active scope. */
	readonly scope: DashboardScope;
	/**
	 * Switch the active scope (the switcher calls this). The default provider value is a NO-OP (a single,
	 * un-switchable scope) so a surface that calls it outside a {@link ScopeProvider} is harmless; the
	 * real {@link ScopeProvider} replaces it with a setter that re-hydrates the scoped views + persists.
	 */
	readonly setScope: (next: DashboardScope) => void;
}

/** The React context (the 049e mount point). Defaults to the single loopback scope + a no-op setter. */
export const ScopeContext = React.createContext<ScopeContextValue>({
	scope: DEFAULT_SCOPE,
	setScope: () => {
		// No-op default: outside a ScopeProvider there is exactly one scope. The provider replaces this.
	},
});

/**
 * Read the active dashboard scope (the hook every scope-aware surface uses). Reactive to the switcher's
 * selection when rendered inside a {@link ScopeProvider}; returns the single default otherwise. Read
 * scope from HERE, never bake a single-workspace assumption into a page or the shell.
 */
export function useScope(): ScopeContextValue {
	return React.useContext(ScopeContext);
}

// ─────────────────────────────────────────────────────────────────────────────
// PRD-049e — the switcher data context (the enumeration state + dropdown handlers).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The switcher's enumeration state + handlers (PRD-049e). Separate from {@link ScopeContextValue} so a
 * page reads only the lean `{ scope, setScope }` it needs, while the {@link ScopeSwitcherSlot} reads
 * this richer surface. The {@link ScopeProvider} owns both; the slot reads this via {@link useScopeSwitcher}.
 */
export interface ScopeSwitcherValue {
	/** The orgs the user can access (privilege-scoped by the daemon — 49e-AC-1). */
	readonly orgs: readonly ScopeOrgWire[];
	/** The selected org's workspaces (re-enumerated on org change, after the re-mint — 49e-AC-3). */
	readonly workspaces: readonly ScopeWorkspaceWire[];
	/** The workspace's registry projects (the 049a synced copy, incl. the `__unsorted__` inbox). */
	readonly projects: readonly ScopeProjectWire[];
	/** True while an org change is re-minting + re-enumerating (the workspace dropdown shows a loading hint). */
	readonly loadingWorkspaces: boolean;
	/** Select an org → re-mint (daemon) + re-enumerate workspaces (49e-AC-3); clears the workspace/project. */
	readonly selectOrg: (org: string) => void;
	/** Select a workspace → re-enumerate its projects; clears the project. */
	readonly selectWorkspace: (workspace: string) => void;
	/** Select a project → re-scope the pages (viewer-side; no registry write — 49e-AC-4). */
	readonly selectProject: (project: string | undefined) => void;
}

/** The default switcher value (empty enumeration + no-op handlers) — used outside a {@link ScopeProvider}. */
const DEFAULT_SWITCHER: ScopeSwitcherValue = Object.freeze({
	orgs: [],
	workspaces: [],
	projects: [],
	loadingWorkspaces: false,
	selectOrg: () => {},
	selectWorkspace: () => {},
	selectProject: () => {},
});

/** The switcher-data context (the enumeration + dropdown handlers). The slot reads it; pages do not. */
export const ScopeSwitcherContext = React.createContext<ScopeSwitcherValue>(DEFAULT_SWITCHER);

/** Read the switcher's enumeration state + handlers (the {@link ScopeSwitcherSlot} uses this). */
export function useScopeSwitcher(): ScopeSwitcherValue {
	return React.useContext(ScopeSwitcherContext);
}

/**
 * Read the persisted viewer-side selection from `localStorage` (49e — persistence is acceptable, and
 * viewer-side: a read of the dashboard's own store, never the registry). Fail-soft: a missing/malformed
 * value yields `null` (the provider then resolves from the daemon default), never a throw.
 */
export function loadPersistedScope(): DashboardScope | null {
	try {
		if (typeof localStorage === "undefined") return null;
		const raw = localStorage.getItem(SCOPE_STORAGE_KEY);
		if (raw === null || raw === "") return null;
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		const obj = parsed as Record<string, unknown>;
		const org = typeof obj.org === "string" ? obj.org : "";
		const workspace = typeof obj.workspace === "string" ? obj.workspace : "";
		if (org === "" || workspace === "") return null;
		const project = typeof obj.project === "string" && obj.project !== "" ? obj.project : undefined;
		return project !== undefined ? { org, workspace, project } : { org, workspace };
	} catch {
		return null;
	}
}

/** Persist the viewer-side selection to `localStorage` (49e). Fail-soft — a storage error is swallowed intentionally. */
export function persistScope(scope: DashboardScope): void {
	try {
		if (typeof localStorage === "undefined") return;
		localStorage.setItem(SCOPE_STORAGE_KEY, JSON.stringify(scope));
	} catch {
		// localStorage may be unavailable (private mode / quota). The selection still works in-memory;
		// only the cross-reload persistence is lost — never a thrown error into React.
	}
}

/**
 * The SCOPE PROVIDER (PRD-049e) — owns the switchable selection + the enumeration state, and feeds both
 * the lean {@link ScopeContext} (pages) and the rich {@link ScopeSwitcherContext} (the slot). Mounted by
 * the {@link import("./app.js").Shell} around the sidebar + outlet, so every page + the switcher share
 * ONE source of truth.
 *
 * On mount it hydrates the orgs (privilege-scoped), then the workspaces + projects for the
 * resolved/persisted org, and restores the persisted project selection (viewer-side). Selecting an Org
 * re-enumerates workspaces (the daemon re-mints the org-bound token FIRST — 49e-AC-3); selecting a
 * Workspace re-enumerates projects; selecting a Project re-scopes the pages (the project flows into
 * `useScope().scope.project`, which the pages thread into the wire fetchers). NO write to `projects.json`
 * happens here — the selection is purely viewer-side (49e-AC-4).
 */
export function ScopeProvider({ wire, children }: { wire: WireClient; children: React.ReactNode }): React.JSX.Element {
	const persisted = React.useMemo(() => loadPersistedScope(), []);
	const [scope, setScopeState] = React.useState<DashboardScope>(persisted ?? DEFAULT_SCOPE);
	const [orgs, setOrgs] = React.useState<readonly ScopeOrgWire[]>([]);
	const [workspaces, setWorkspaces] = React.useState<readonly ScopeWorkspaceWire[]>([]);
	const [projects, setProjects] = React.useState<readonly ScopeProjectWire[]>([]);
	const [loadingWorkspaces, setLoadingWorkspaces] = React.useState(false);

	/** Commit a new scope: persist it (viewer-side) + update state so pages re-render against it. */
	const commitScope = React.useCallback((next: DashboardScope): void => {
		setScopeState(next);
		persistScope(next);
	}, []);

	// The setScope a page would call (e.g. a deep link). Persists + re-renders; no enumeration side effect.
	const setScope = React.useCallback((next: DashboardScope): void => commitScope(next), [commitScope]);

	/** Enumerate a workspace's projects + restore the persisted project if it is still present. */
	const loadProjects = React.useCallback(async (): Promise<void> => {
		const rows = await wire.scopeProjects();
		setProjects(rows);
	}, [wire]);

	// Hydrate orgs once on mount (49e-AC-1). The list is privilege-scoped server-side.
	React.useEffect(() => {
		let alive = true;
		void (async () => {
			const rows = await wire.scopeOrgs();
			if (!alive) return;
			setOrgs(rows);
		})();
		// Also hydrate the workspaces + projects for the initial (persisted/default) org so the dropdowns
		// are populated on first render without requiring an org re-select.
		void (async () => {
			const ws = await wire.scopeWorkspaces();
			if (!alive) return;
			setWorkspaces(ws.workspaces);
		})();
		void loadProjects();
		return () => {
			alive = false;
		};
	}, [wire, loadProjects]);

	// Select an org → re-enumerate workspaces (49e-AC-3: the daemon re-mints the org-bound token FIRST,
	// then lists). Clears the workspace + project (a new org has its own workspaces/projects).
	const selectOrg = React.useCallback(
		(org: string): void => {
			commitScope({ org, workspace: DEFAULT_SCOPE.workspace, project: undefined });
			setLoadingWorkspaces(true);
			void (async () => {
				try {
					const ws = await wire.scopeWorkspaces(org);
					setWorkspaces(ws.workspaces);
					// Projects belong to a workspace; clear them until a workspace is picked under the new org.
					setProjects([]);
				} finally {
					setLoadingWorkspaces(false);
				}
			})();
		},
		[wire, commitScope],
	);

	// Select a workspace → re-enumerate its projects. Clears the project (the new workspace's projects differ).
	const selectWorkspace = React.useCallback(
		(workspace: string): void => {
			commitScope({ org: scope.org, workspace, project: undefined });
			void loadProjects();
		},
		[commitScope, scope.org, loadProjects],
	);

	// Select a project → re-scope the pages (viewer-side). `undefined` clears the selection (the
	// needs-selection empty state, 49e-AC-5). NO registry write (49e-AC-4).
	const selectProject = React.useCallback(
		(project: string | undefined): void => {
			commitScope({ org: scope.org, workspace: scope.workspace, ...(project !== undefined ? { project } : {}) });
		},
		[commitScope, scope.org, scope.workspace],
	);

	const scopeValue = React.useMemo<ScopeContextValue>(() => ({ scope, setScope }), [scope, setScope]);
	const switcherValue = React.useMemo<ScopeSwitcherValue>(
		() => ({ orgs, workspaces, projects, loadingWorkspaces, selectOrg, selectWorkspace, selectProject }),
		[orgs, workspaces, projects, loadingWorkspaces, selectOrg, selectWorkspace, selectProject],
	);

	return (
		<ScopeContext.Provider value={scopeValue}>
			<ScopeSwitcherContext.Provider value={switcherValue}>{children}</ScopeSwitcherContext.Provider>
		</ScopeContext.Provider>
	);
}

/** Props for {@link ScopeSwitcherSlot}. `collapsed` mirrors the sidebar's rail state for the compact switcher. */
export interface ScopeSwitcherSlotProps {
	/** Whether the sidebar is in its collapsed icon-rail (renders a compact, label-free switcher). */
	readonly collapsed: boolean;
}

/** The shared `<select>` styling for the switcher dropdowns (existing DS tokens only — no new token). */
const SELECT_STYLE: React.CSSProperties = {
	width: "100%",
	height: 30,
	padding: "0 8px",
	background: "var(--bg-elevated)",
	border: "1px solid var(--border-default)",
	borderRadius: "var(--radius-md)",
	color: "var(--text-secondary)",
	fontFamily: "var(--font-mono)",
	fontSize: 12,
	cursor: "pointer",
};

/** One labeled dropdown row in the switcher (a mono caption + a `<select>`). */
function SwitcherSelect({
	label,
	testId,
	value,
	disabled,
	onChange,
	children,
}: {
	label: string;
	testId: string;
	value: string;
	disabled?: boolean;
	onChange: (value: string) => void;
	children: React.ReactNode;
}): React.JSX.Element {
	return (
		<label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
				{label}
			</span>
			<select
				data-testid={testId}
				value={value}
				disabled={disabled}
				onChange={(e) => onChange(e.target.value)}
				style={{ ...SELECT_STYLE, opacity: disabled ? 0.6 : 1 }}
			>
				{children}
			</select>
		</label>
	);
}

/** The reserved inbox project id (mirrored from the resolver; a literal so this stays a thin-client view). */
const UNSORTED_PROJECT_ID = "__unsorted__" as const;

/** The `<option>` value the project `<select>` uses for "no project selected" (the needs-selection state). */
const NO_PROJECT_VALUE = "" as const;

/**
 * The Org→Workspace→Project SWITCHER (PRD-049e) — the body that fills the 050b slot. Three dependent
 * dropdowns hydrated from the {@link useScopeSwitcher} enumeration state; the active selection comes from
 * {@link useScope}. Changing the Org re-enumerates workspaces (after the daemon re-mints — 49e-AC-3),
 * changing the Workspace re-enumerates projects, and changing the Project re-scopes every page
 * (viewer-side; no registry write — 49e-AC-4). In the collapsed rail it renders nothing (the switcher
 * needs labels) — the sidebar expands to switch scope.
 */
export function ScopeSwitcherSlot({ collapsed }: ScopeSwitcherSlotProps): React.JSX.Element | null {
	const { scope } = useScope();
	const switcher = useScopeSwitcher();

	// The collapsed icon-rail has no room for three labeled dropdowns; render nothing (the expanded rail
	// is where scope is switched). This keeps the collapsed layout identical to 050b.
	if (collapsed) return null;

	return (
		<div data-testid="scope-switcher" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
			<SwitcherSelect label="org" testId="scope-org" value={scope.org} onChange={switcher.selectOrg}>
				{/* The active org is always offered, even before the enumeration resolves, so the control never
				    renders blank (the resolved/persisted scope shows immediately). */}
				{switcher.orgs.length === 0 && <option value={scope.org}>{scope.org}</option>}
				{switcher.orgs.map((o) => (
					<option key={o.id} value={o.id}>
						{o.name !== "" ? o.name : o.id}
					</option>
				))}
			</SwitcherSelect>

			<SwitcherSelect
				label="workspace"
				testId="scope-workspace"
				value={scope.workspace}
				disabled={switcher.loadingWorkspaces}
				onChange={switcher.selectWorkspace}
			>
				{switcher.workspaces.length === 0 && <option value={scope.workspace}>{switcher.loadingWorkspaces ? "loading…" : scope.workspace}</option>}
				{switcher.workspaces.map((w) => (
					<option key={w.id} value={w.id}>
						{w.name !== "" ? w.name : w.id}
					</option>
				))}
			</SwitcherSelect>

			<SwitcherSelect
				label="project"
				testId="scope-project"
				value={scope.project ?? NO_PROJECT_VALUE}
				onChange={(v) => switcher.selectProject(v === NO_PROJECT_VALUE ? undefined : v)}
			>
				{/* The needs-selection sentinel (49e-AC-5): with nothing selected the pages render the
				    needs-selection empty state, never another project's data. */}
				<option value={NO_PROJECT_VALUE}>— select a project —</option>
				{switcher.projects.map((p) => (
					<option key={p.projectId} value={p.projectId}>
						{p.projectId === UNSORTED_PROJECT_ID ? "(unsorted inbox)" : p.name !== "" ? p.name : p.projectId}
					</option>
				))}
			</SwitcherSelect>
		</div>
	);
}

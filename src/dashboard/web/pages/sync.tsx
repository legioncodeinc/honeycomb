/**
 * The SYNC page — PRD-042 (view · promote · control skills AND agents + activity).
 *
 * Mounted at the PRD-037 `#/sync` slot (replacing the `ComingSoon` placeholder). A WRITE-action page:
 * every control invokes the REAL daemon pipeline over the shared `wire` (never `createWireClient`,
 * never DeepLake — the thin-client invariant holds). ONE shared component family renders BOTH the
 * skills view (042a) and the agents view (042b), parameterized over `asset_type` — the agent surface
 * is the skill surface keyed by asset kind, not a fork (b-AC-6). Plus the activity feed + per-scope
 * state (042c).
 *
 *   - LIST (a-AC-1 / b-AC-1) — every skill/agent from the `installed ∪ synced` union view-model
 *     (`wire.assetsView()`), each with its honest state badge (`local`/`pulled`/`shared`), no
 *     double-count. A tab switches between the Skills and Agents views over the same components.
 *   - DETAIL (a-AC-2 / b-AC-2) — name, description, provenance, scope, source harness, tier/style,
 *     version, state. NEVER the `native` blob / author email / org GUID (the view-model omits them).
 *   - CONTROLS (a-AC-3..7 / b-AC-3..6) — promote / pull / demote / enable / disable, each dispatching
 *     to the real endpoint and showing an IN-FLIGHT state until the daemon's poll-convergent
 *     read-back confirms (no optimistic flip — a-AC-7). Demote is DISABLED when not the author
 *     (`authoredByMe`, parent OQ-4 — honest, never attempt-and-fail).
 *   - ACTIVITY (042c) — a recent-activity feed of sync events (publish/pull/tombstone) filtered from
 *     `/api/logs`, newest first, plus a per-scope summary (org/team `shared`, user `local`/`pulled`)
 *     derived from the SAME union view-model so the summary and the lists never disagree (c-AC-3).
 *
 * Every visual value is an existing DS token + an existing primitive (`Badge`/`Button`/`Panel`/
 * `LiveLog`, the `SYNC_TONE` map). NO new dependency, NO CDN React, NO secret in the page (D-9).
 */

import React from "react";

import { Badge, Button, type BadgeTone } from "../primitives.js";
import { LiveLog, Panel, SYNC_TONE } from "../panels.js";
import type { PageProps } from "../page-frame.js";
import { isTabHidden, PageFrame } from "../page-frame.js";
import { useScope } from "../scope-context.js";
import { NeedsProjectSelection } from "../needs-project.js";
import {
	type AssetSyncRowWire,
	type AssetSyncViewWire,
	EMPTY_ASSET_SYNC_VIEW,
	formatLogLine,
	isSyncActivityRecord,
	syncActivityVerb,
	type LogRecordWire,
} from "../wire.js";

/** The asset kind a view renders (the symmetry key — 042a vs 042b over one component family). */
type AssetKind = "skill" | "agent";

/** How often the union view-model re-hydrates (ms) — light refresh, stopped on unmount. */
const VIEW_POLL_MS = 5000;
/** How many recent sync-event lines the activity feed keeps (the SSE-followed buffer cap). */
const MAX_ACTIVITY_LINES = 12;

/** A keyed in-flight map: `<assetType>:<name>` → the action currently running (for the spinner). */
type InFlightMap = Readonly<Record<string, string>>;

/** Build the in-flight map key for an asset row (kind + name, stable across re-hydrations). */
function flightKey(assetType: AssetKind, name: string): string {
	return `${assetType}:${name}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The shared row + detail + controls (rendered for BOTH skills and agents).
// ─────────────────────────────────────────────────────────────────────────────

/** A presentation-safe key/value row inside the detail panel. */
function DetailRow({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 6px", borderTop: "1px solid var(--border-subtle)" }}>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)", minWidth: 130 }}>{label}</span>
			<span style={{ flex: 1 }} />
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-primary)", textAlign: "right", wordBreak: "break-word" }}>{children}</span>
		</div>
	);
}

/** The state badge for a sync state (reuses the `SYNC_TONE` map from `panels.tsx`). */
function StateBadge({ state }: { state: string }): React.JSX.Element {
	const tone: BadgeTone = SYNC_TONE[state] ?? "neutral";
	return (
		<Badge tone={tone} mono dot>
			{state}
		</Badge>
	);
}

/**
 * The control bar for one asset row (a-AC-3..7 / b-AC-3..6). The available actions are gated by state:
 *   - `local`  → Promote (publish to team) + Disable (remove local install);
 *   - `shared` → Pull (install locally) + Demote (tombstone — DISABLED when not author);
 *   - `pulled` → Demote (if author) + Disable.
 * Every button shows an IN-FLIGHT label while the action runs and re-enables only after the converged
 * read-back (no optimistic flip — a-AC-7). `onAction` returns a promise the parent awaits + re-reads.
 */
function RowControls({
	row,
	flight,
	onAction,
}: {
	row: AssetSyncRowWire;
	flight: string | undefined;
	onAction: (action: "promote" | "pull" | "demote" | "enable" | "disable", row: AssetSyncRowWire) => void;
}): React.JSX.Element {
	const busy = flight !== undefined;
	const label = (action: string, idle: string): string => (flight === action ? `${idle}…` : idle);

	return (
		<div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
			{row.state === "local" && (
				<Button
					variant="primary"
					size="sm"
					disabled={busy}
					data-testid={`promote-${row.assetType}-${row.name}`}
					onClick={() => onAction("promote", row)}
				>
					{label("promote", "Promote")}
				</Button>
			)}
			{row.state === "shared" && (
				<Button
					variant="secondary"
					size="sm"
					disabled={busy}
					data-testid={`pull-${row.assetType}-${row.name}`}
					onClick={() => onAction("pull", row)}
				>
					{label("pull", "Pull")}
				</Button>
			)}
			{/* Enable = re-install a DISABLED asset from the substrate's current version (a-AC-6). A row
			    that is `shared` (lives in the substrate) but NOT present on disk has no local install;
			    Enable is its path back — mirroring Disable, dispatching the REAL enable action with the
			    SAME in-flight→converged confirm. Symmetric across skills + agents (one component family). */}
			{row.state === "shared" && (
				<Button
					variant="ghost"
					size="sm"
					disabled={busy}
					data-testid={`enable-${row.assetType}-${row.name}`}
					onClick={() => onAction("enable", row)}
				>
					{label("enable", "Enable")}
				</Button>
			)}
			{(row.state === "shared" || row.state === "pulled") && (
				<Button
					variant="danger"
					size="sm"
					// Demote is DISABLED when the viewer did not author the asset (parent OQ-4: honest,
					// never attempt-and-fail). It is also disabled while another action is in flight.
					disabled={busy || !row.authoredByMe}
					title={row.authoredByMe ? "Demote (tombstone) this asset" : "Only the author can demote this asset"}
					data-testid={`demote-${row.assetType}-${row.name}`}
					onClick={() => onAction("demote", row)}
				>
					{label("demote", "Demote")}
				</Button>
			)}
			{/* Enable/disable = a LOCAL install toggle (parent OQ-2 — no substrate change). A row that is
			    present on disk (local/pulled) can be disabled; a shared-but-not-local row can be enabled. */}
			{(row.state === "local" || row.state === "pulled") && (
				<Button
					variant="ghost"
					size="sm"
					disabled={busy}
					data-testid={`disable-${row.assetType}-${row.name}`}
					onClick={() => onAction("disable", row)}
				>
					{label("disable", "Disable")}
				</Button>
			)}
			{busy && <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>in-flight…</span>}
		</div>
	);
}

/** The expandable detail panel for a selected asset (a-AC-2 / b-AC-2 — no secret rendered). */
function AssetDetail({ row }: { row: AssetSyncRowWire }): React.JSX.Element {
	return (
		<div data-testid={`detail-${row.assetType}-${row.name}`} style={{ marginTop: 4 }}>
			<Panel title={row.name} eyebrow={row.assetType} style={{ marginBottom: 4 }}>
				{row.description !== "" && (
					<div style={{ fontSize: 13, color: "var(--text-secondary)", padding: "4px 6px 8px", lineHeight: "19px" }}>{row.description}</div>
				)}
				<DetailRow label="state">
					<StateBadge state={row.state} />
				</DetailRow>
				<DetailRow label="provenance">{row.sourceHarness || "—"}</DetailRow>
				<DetailRow label="scope">{row.scope || "—"}</DetailRow>
				<DetailRow label="source harness">{row.sourceHarness || "—"}</DetailRow>
				<DetailRow label="tier / style">{row.tier !== "" ? `${row.tier} / ${row.style}` : "—"}</DetailRow>
				<DetailRow label="version">{row.version > 0 ? `v${row.version}` : "—"}</DetailRow>
			</Panel>
		</div>
	);
}

/** One row in the asset list: name + state badge + controls, click toggles the detail panel. */
function AssetRow({
	row,
	open,
	flight,
	onToggle,
	onAction,
}: {
	row: AssetSyncRowWire;
	open: boolean;
	flight: string | undefined;
	onToggle: (row: AssetSyncRowWire) => void;
	onAction: (action: "promote" | "pull" | "demote" | "enable" | "disable", row: AssetSyncRowWire) => void;
}): React.JSX.Element {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "10px 6px", borderTop: "1px solid var(--border-subtle)" }}>
			<div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
				<button
					type="button"
					data-testid={`row-${row.assetType}-${row.name}`}
					onClick={() => onToggle(row)}
					style={{
						display: "flex",
						alignItems: "center",
						gap: 8,
						background: "transparent",
						border: "none",
						padding: 0,
						cursor: "pointer",
						minWidth: 0,
						flex: "1 1 200px",
						textAlign: "left",
					}}
				>
					<span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
						{row.name}
					</span>
					<StateBadge state={row.state} />
					{row.version > 0 && <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>v{row.version}</span>}
				</button>
				<RowControls row={row} flight={flight} onAction={onAction} />
			</div>
			{open && <AssetDetail row={row} />}
		</div>
	);
}

/** The list of one asset kind (skills or agents), each row with badges + controls (a-AC-1 / b-AC-1). */
function AssetList({
	kind,
	rows,
	openKey,
	inFlight,
	onToggle,
	onAction,
}: {
	kind: AssetKind;
	rows: readonly AssetSyncRowWire[];
	openKey: string | null;
	inFlight: InFlightMap;
	onToggle: (row: AssetSyncRowWire) => void;
	onAction: (action: "promote" | "pull" | "demote" | "enable" | "disable", row: AssetSyncRowWire) => void;
}): React.JSX.Element {
	const title = kind === "skill" ? "Skills" : "Agents";
	return (
		<Panel title={title} eyebrow={`${rows.length} ${kind === "skill" ? "skills" : "agents"}`}>
			{rows.length === 0 ? (
				<div style={{ padding: "12px 4px", fontSize: 13, color: "var(--text-tertiary)" }}>No {kind === "skill" ? "skills" : "agents"} found.</div>
			) : (
				<div style={{ display: "flex", flexDirection: "column" }}>
					{rows.map((row) => (
						<AssetRow
							key={`${row.assetType}:${row.name}`}
							row={row}
							open={openKey === flightKey(kind, row.name)}
							flight={inFlight[flightKey(kind, row.name)]}
							onToggle={onToggle}
							onAction={onAction}
						/>
					))}
				</div>
			)}
		</Panel>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// 042c — the per-scope state summary + the activity feed.
// ─────────────────────────────────────────────────────────────────────────────

/** A single labeled count tile in the per-scope summary. */
function ScopeCount({ label, value, tone }: { label: string; value: number; tone: BadgeTone }): React.JSX.Element {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 6px" }}>
			<Badge tone={tone} mono>
				{value}
			</Badge>
			<span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{label}</span>
		</div>
	);
}

/**
 * The per-scope sync-state summary (042c c-AC-3). Counts are derived from the SAME union view-model
 * the lists render, so the summary and the per-asset views can never disagree: `shared` = team scope,
 * `local` + `pulled` = the user's personal scope. No separate read, no drift.
 */
export function summarizeScopes(view: AssetSyncViewWire): { shared: number; local: number; pulled: number } {
	let shared = 0;
	let local = 0;
	let pulled = 0;
	for (const row of [...view.skills, ...view.agents]) {
		if (row.state === "shared") shared++;
		else if (row.state === "local") local++;
		else if (row.state === "pulled") pulled++;
	}
	return { shared, local, pulled };
}

/** The per-scope summary panel (042c c-AC-3): converged counts that match the lists. */
function ScopeSummary({ view }: { view: AssetSyncViewWire }): React.JSX.Element {
	const counts = summarizeScopes(view);
	return (
		<Panel title="Sync state" eyebrow="per scope">
			<div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
				<ScopeCount label="shared with team" value={counts.shared} tone="verified" />
				<ScopeCount label="local only" value={counts.local} tone="neutral" />
				<ScopeCount label="pulled" value={counts.pulled} tone="honey" />
			</div>
		</Panel>
	);
}

/**
 * Build the activity feed lines from `/api/logs` records (042c c-AC-1 / c-AC-2). Filters to the
 * sync-relevant records (action POSTs under `/api/diagnostics/sync/`), newest first, and renders a
 * human line ("published · 200"). No record carries a secret (logger.ts), so the lines are safe.
 */
export function buildActivityLines(records: readonly LogRecordWire[]): string[] {
	return records
		.filter(isSyncActivityRecord)
		.slice(-MAX_ACTIVITY_LINES)
		.reverse()
		.map((r) => {
			const base = formatLogLine(r);
			const verb = syncActivityVerb(r);
			return verb !== "" ? `${base}  · ${verb}` : base;
		});
}

/**
 * Append one SSE-tailed record to the chronological (oldest-last) sync-activity buffer (042c c-AC-2).
 * Drops non-sync records (the feed shows only `/api/diagnostics/sync/*` events) and caps the buffer so
 * the follow tail can run unbounded without growing memory. Pure + exported so the page test can drive
 * the follow-handler deterministically (inject a record, assert it lands) without a live EventSource.
 */
export function appendActivityRecord(
	buffer: readonly LogRecordWire[],
	record: LogRecordWire,
): readonly LogRecordWire[] {
	if (!isSyncActivityRecord(record)) return buffer;
	const next = [...buffer, record];
	// Keep only the most recent window (the lines render the last MAX_ACTIVITY_LINES anyway).
	return next.length > MAX_ACTIVITY_LINES ? next.slice(-MAX_ACTIVITY_LINES) : next;
}

// ─────────────────────────────────────────────────────────────────────────────
// The routed page.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Sync page (042a + 042b + 042c). Hydrates the union view-model from the shared wire, renders the
 * Skills / Agents tabs over ONE component family, dispatches the real actions with an
 * in-flight→converged lifecycle (re-reading the view after each action — no optimistic flip), and
 * shows the per-scope summary + the sync activity feed.
 */
export function SyncPage({ wire }: PageProps): React.JSX.Element {
	// PRD-049e (49e-AC-2 / 49e-AC-5): the dashboard-selected project gates this page. With no project
	// selected the page renders the needs-selection state (never another scope's assets); a project
	// change re-hydrates the view (the poll effect is keyed on `project`).
	const { scope } = useScope();
	const project = scope.project;
	const [view, setView] = React.useState<AssetSyncViewWire>(EMPTY_ASSET_SYNC_VIEW);
	// The chronological (oldest-last) sync-activity buffer: BACKFILLED from the /api/logs snapshot, then
	// EXTENDED by the /api/logs/stream SSE tail (042c c-AC-2). The LiveLog lines derive from it.
	const [activityRecords, setActivityRecords] = React.useState<readonly LogRecordWire[]>([]);
	const [tab, setTab] = React.useState<AssetKind>("skill");
	const [openKey, setOpenKey] = React.useState<string | null>(null);
	const [inFlight, setInFlight] = React.useState<InFlightMap>({});

	// Hydrate the union view-model (the read backbone). A light poll keeps it fresh; stops on unmount.
	// 49e-AC-2/AC-5: re-hydrate when the selected project changes; with no project selected, do not
	// fetch (the page renders the needs-selection state below) so another scope's assets never show.
	React.useEffect(() => {
		if (project === undefined) {
			setView(EMPTY_ASSET_SYNC_VIEW);
			return;
		}
		let alive = true;
		const tick = async (): Promise<void> => {
			if (!alive || isTabHidden()) return; // background-tab pause: no assets-view poll while hidden
			const v = await wire.assetsView();
			if (alive) setView(v);
		};
		void tick();
		const id = setInterval(() => void tick(), VIEW_POLL_MS);
		return () => {
			alive = false;
			clearInterval(id);
		};
	}, [wire, project]);

	// The activity feed FOLLOWS the SSE tail (042c c-AC-2): BACKFILL the recent records from the
	// /api/logs snapshot ONCE, THEN subscribe to /api/logs/stream and append each NEW sync record as it
	// lands — no client poll. The EventSource is closed on unmount via the returned unsubscribe. In a
	// non-browser env (jsdom test) `wire.logsStream` is an inert no-op, so the feed degrades to the
	// backfill snapshot and the test never crashes (the SSE-record handling is exercised directly via
	// the injected handler). An `alive` guard prevents a late-resolving backfill from writing post-unmount.
	React.useEffect(() => {
		let alive = true;
		void (async () => {
			const records = await wire.logs(MAX_ACTIVITY_LINES * 6);
			if (!alive) return;
			// Seed the buffer with only the sync-relevant records (chronological, capped).
			setActivityRecords(records.filter(isSyncActivityRecord).slice(-MAX_ACTIVITY_LINES));
		})();
		const unsubscribe = wire.logsStream((record) => {
			if (!alive) return;
			setActivityRecords((buf) => appendActivityRecord(buf, record));
		});
		return () => {
			alive = false;
			unsubscribe();
		};
	}, [wire]);

	// Derive the rendered lines from the followed buffer (newest first, sync-only — pure helper).
	const activity = React.useMemo(() => buildActivityLines(activityRecords), [activityRecords]);

	const onToggle = React.useCallback((row: AssetSyncRowWire): void => {
		const key = flightKey(row.assetType, row.name);
		setOpenKey((cur) => (cur === key ? null : key));
	}, []);

	// The in-flight→converged action dispatch (a-AC-7): mark the row in-flight, run the REAL action
	// (the daemon does the poll-convergent read-back), then RE-READ the union and reflect the
	// persisted state — never an optimistic flip. The in-flight flag clears on completion.
	const onAction = React.useCallback(
		(action: "promote" | "pull" | "demote" | "enable" | "disable", row: AssetSyncRowWire): void => {
			const key = flightKey(row.assetType, row.name);
			setInFlight((m) => ({ ...m, [key]: action }));
			void (async () => {
				try {
					await wire.syncAction(action, {
						assetType: row.assetType,
						name: row.name,
						// Promote sends the on-disk body as `native`; here the daemon reads the disk copy
						// via the install path on pull/enable, so the page sends only id + name. The
						// honeycombId targets the existing substrate row for pull/demote.
						honeycombId: row.honeycombId !== "" ? row.honeycombId : undefined,
					});
					// Re-read the union so the row reflects the CONVERGED persisted state (a-AC-7).
					setView(await wire.assetsView());
				} finally {
					setInFlight((m) => {
						const next = { ...m };
						delete next[key];
						return next;
					});
				}
			})();
		},
		[wire],
	);

	const rows = tab === "skill" ? view.skills : view.agents;

	return (
		<PageFrame title="Sync" eyebrow={project === undefined ? "sync" : `${view.skills.length + view.agents.length} assets`}>
			{project === undefined ? (
				// 49e-AC-5: no project selected → the explicit needs-selection state, never another scope's assets.
				<NeedsProjectSelection surface="sync state" />
			) : (
			<>
			<ScopeSummary view={view} />
			<div style={{ height: 16 }} />

			{/* Skills / Agents tabs over ONE component family (the 042a/042b symmetry). */}
			<div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
				<TabButton label="Skills" active={tab === "skill"} count={view.skills.length} onClick={() => setTab("skill")} />
				<TabButton label="Agents" active={tab === "agent"} count={view.agents.length} onClick={() => setTab("agent")} />
			</div>

			<AssetList kind={tab} rows={rows} openKey={openKey} inFlight={inFlight} onToggle={onToggle} onAction={onAction} />

			<div style={{ height: 16 }} />
			{/* The activity feed reuses the LiveLog panel (042c — filtered to sync events). */}
			<LiveLog lines={activity} />
			</>
			)}
		</PageFrame>
	);
}

/** A tab button for the Skills / Agents switch (mono pill, honey when active). */
function TabButton({ label, active, count, onClick }: { label: string; active: boolean; count: number; onClick: () => void }): React.JSX.Element {
	return (
		<button
			type="button"
			data-testid={`tab-${label.toLowerCase()}`}
			aria-pressed={active}
			onClick={onClick}
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: 8,
				height: 34,
				padding: "0 14px",
				background: active ? "var(--honey-subtle)" : "var(--bg-elevated)",
				border: `1px solid ${active ? "var(--honey-border)" : "var(--border-default)"}`,
				borderRadius: "var(--radius-full)",
				color: active ? "var(--honey)" : "var(--text-secondary)",
				fontFamily: "var(--font-sans)",
				fontSize: 13,
				fontWeight: 600,
				cursor: "pointer",
			}}
		>
			{label}
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>{count}</span>
		</button>
	);
}

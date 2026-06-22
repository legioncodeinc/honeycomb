/**
 * The LOGS page — PRD-043 (durable history + live tail + browsable Turns drill-down).
 *
 * Mounted at the PRD-037 `#/logs` slot (replacing the `ComingSoon` placeholder). ONE page, three
 * mutually-referential surfaces over the INJECTED `wire` (never `createWireClient`):
 *
 *   043b — REQUEST-LOG view (the default tab):
 *     · LIVE TAIL (collapsible, on TOP — OQ-2 stacked) reusing the existing `/api/logs/stream` SSE
 *       follow (`wire.logsStream`, shared with the Sync activity feed — D-2, not re-implemented).
 *     · HISTORY TABLE (below) fed by the durable `/api/logs/history` (`wire.logsHistory`), with
 *       filter controls (time range · status/level incl. a `5xx` class · path exact/prefix ·
 *       harness/org) that refetch page one, plus cursor pagination ("load more", no dup/gap rows).
 *     · The live tail + history SHARE ONE `LogRow` renderer so they never drift (D-1). They are kept
 *       visually SEPARATE and NOT de-duped across each other (D-1 / OQ-3).
 *
 *   043c — TURNS view (a tab on the SAME page):
 *     · A browsable list of captured turns (newest first) read from DeepLake via the existing
 *       `fetchSessionsView` path (`wire.turnsHistory` → `/api/diagnostics/sessions`, NOT SQLite — D-2),
 *       with cursor pagination, and DRILL-DOWN to a single turn's metadata + back.
 *     · Every user-facing string says "Turns"/"turn" (PRD-035a — grep-proven, AC-4). METADATA ONLY:
 *       never a transcript/body/JSONB/secret (D-4 / AC-5).
 *
 * Status renders as a LEVEL via existing Badge tones (2xx ok / 4xx warn / 5xx critical) — no new
 * color ramp (D-4). Every visual value is an existing DS token + an existing primitive
 * (`Badge`/`Button`/`Panel`/`PageFrame`). NO new dependency, NO CDN React, NO secret on screen (D-5).
 */

import React from "react";

import { Badge, Button, Input, type BadgeTone } from "../primitives.js";
import { Panel } from "../panels.js";
import type { PageProps } from "../page-frame.js";
import { PageFrame } from "../page-frame.js";
import {
	EMPTY_LOGS_HISTORY,
	type LogRecordWire,
	type LogsHistoryFilters,
	type LogsHistoryWire,
	type SessionRowWire,
} from "../wire.js";

/** The two sections of the Logs page (request log vs captured turns). */
type LogsTab = "requests" | "turns";

/** How many live-tail rows the collapsible feed keeps (the SSE-followed buffer cap). */
const MAX_LIVE_LINES = 30;
/** The default history page size the table requests (the daemon clamps to MAX_HISTORY_LIMIT). */
const HISTORY_PAGE_SIZE = 50;
/** The default turns page size the Turns list requests. */
const TURNS_PAGE_SIZE = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Status → DS tone (D-4): 2xx ok · 4xx warn · 5xx critical · other neutral.
// ─────────────────────────────────────────────────────────────────────────────

/** Map an HTTP status code to a DS Badge tone — the log-level color language (D-4, no new ramp). */
export function statusTone(status: number): BadgeTone {
	if (status >= 500) return "critical";
	if (status >= 400) return "warning";
	if (status >= 200 && status < 300) return "verified";
	return "neutral";
}

/** Short, secret-free time-of-day from an ISO timestamp (HH:MM:SS), matching `formatLogLine`. */
function shortTime(iso: string): string {
	return (iso || "").slice(11, 19) || (iso || "").slice(0, 8);
}

// ─────────────────────────────────────────────────────────────────────────────
// The SHARED row renderer (D-1) — used by BOTH the live tail and the history table.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One request-log row (D-1 — the SINGLE renderer shared by the live tail + the history table, so
 * the two never drift). Columns: time · method + path · status (as a level badge) · duration ·
 * harness/org. Every field comes from a secret-free `LogRecordWire` (D-5) — no header/token/body.
 */
export function LogRow({ record, live }: { record: LogRecordWire; live?: boolean }): React.JSX.Element {
	const status = record.status;
	const org = record.org ?? "";
	const duration = record.durationMs;
	return (
		<div
			data-testid="log-row"
			style={{
				display: "grid",
				gridTemplateColumns: "76px 64px 1fr auto auto auto",
				alignItems: "center",
				gap: 12,
				padding: "8px 6px",
				borderTop: "1px solid var(--border-subtle)",
			}}
		>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: live ? "var(--text-primary)" : "var(--text-tertiary)" }}>
				{shortTime(record.time)}
			</span>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>{record.method}</span>
			<span
				style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
				title={record.path}
			>
				{record.path}
			</span>
			<Badge tone={statusTone(status)} mono>
				{status > 0 ? status : "—"}
			</Badge>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", textAlign: "right", minWidth: 48 }}>
				{typeof duration === "number" ? `${Math.round(duration)}ms` : ""}
			</span>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", textAlign: "right", minWidth: 60 }}>{org}</span>
		</div>
	);
}

/** The table header row (mirrors the LogRow grid so columns line up). */
function LogTableHeader(): React.JSX.Element {
	const cell = (label: string, align: "left" | "right" = "left"): React.JSX.Element => (
		<span style={{ fontFamily: "var(--font-mono)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-tertiary)", textAlign: align }}>
			{label}
		</span>
	);
	return (
		<div style={{ display: "grid", gridTemplateColumns: "76px 64px 1fr auto auto auto", alignItems: "center", gap: 12, padding: "4px 6px 8px" }}>
			{cell("time")}
			{cell("method")}
			{cell("path")}
			{cell("status")}
			{cell("dur", "right")}
			{cell("org", "right")}
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// 043b — the filter controls (drive the /api/logs/history query, refetch page one).
// ─────────────────────────────────────────────────────────────────────────────

/** The page's editable filter state (a superset of the wire filters; `limit` is fixed per-page). */
interface FilterState {
	since: string;
	until: string;
	status: string;
	path: string;
	org: string;
}

/** The empty filter state — an unfiltered newest page. */
const EMPTY_FILTERS: FilterState = { since: "", until: "", status: "", path: "", org: "" };

/** Map the editable filter state to the wire filters (omitting empties so the daemon defaults). */
function toWireFilters(state: FilterState): LogsHistoryFilters {
	const f: { -readonly [K in keyof LogsHistoryFilters]: LogsHistoryFilters[K] } = { limit: HISTORY_PAGE_SIZE };
	if (state.since !== "") f.since = state.since;
	if (state.until !== "") f.until = state.until;
	if (state.status !== "") f.status = state.status;
	if (state.path !== "") f.path = state.path;
	if (state.org !== "") f.org = state.org;
	return f;
}

/** A labeled filter input (mono, compact) reusing the DS `Input` primitive. */
function FilterField({
	label,
	value,
	placeholder,
	onChange,
	testid,
}: {
	label: string;
	value: string;
	placeholder: string;
	onChange: (v: string) => void;
	testid: string;
}): React.JSX.Element {
	return (
		<label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 130, flex: "1 1 130px" }}>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-tertiary)" }}>
				{label}
			</span>
			<Input mono size="sm" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} data-testid={testid} />
		</label>
	);
}

/** The filter bar (FR-2): time range · status/level · path · harness/org + Apply / Clear. */
function FilterBar({
	draft,
	onChangeField,
	onApply,
	onClear,
}: {
	draft: FilterState;
	onChangeField: (key: keyof FilterState, value: string) => void;
	onApply: () => void;
	onClear: () => void;
}): React.JSX.Element {
	return (
		<Panel title="Filters" eyebrow="time · status · path · harness">
			<div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
				<FilterField label="since (ISO)" value={draft.since} placeholder="2026-06-22T00:00:00Z" onChange={(v) => onChangeField("since", v)} testid="filter-since" />
				<FilterField label="until (ISO)" value={draft.until} placeholder="2026-06-22T23:59:59Z" onChange={(v) => onChangeField("until", v)} testid="filter-until" />
				<FilterField label="status / level" value={draft.status} placeholder="5xx or 404" onChange={(v) => onChangeField("status", v)} testid="filter-status" />
				<FilterField label="path" value={draft.path} placeholder="/api/memories" onChange={(v) => onChangeField("path", v)} testid="filter-path" />
				<FilterField label="harness / org" value={draft.org} placeholder="org id" onChange={(v) => onChangeField("org", v)} testid="filter-org" />
				<div style={{ display: "flex", gap: 8 }}>
					<Button variant="primary" size="sm" data-testid="filter-apply" onClick={onApply}>
						Apply
					</Button>
					<Button variant="ghost" size="sm" data-testid="filter-clear" onClick={onClear}>
						Clear
					</Button>
				</div>
			</div>
		</Panel>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// 043b — the live tail (collapsible, on TOP — OQ-2 stacked) + the history table.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Append one SSE-tailed record to the live buffer (newest FIRST), capped (D-1 — shares the LogRow
 * renderer with the history table). Pure + exported so the page test drives the follow handler
 * deterministically (inject a record, assert it lands) without a live EventSource.
 */
export function appendLiveRecord(buffer: readonly LogRecordWire[], record: LogRecordWire): readonly LogRecordWire[] {
	const next = [record, ...buffer];
	return next.length > MAX_LIVE_LINES ? next.slice(0, MAX_LIVE_LINES) : next;
}

/** The collapsible live-tail section (reuses the SSE follow; newest first; shares LogRow). */
function LiveTail({ records, open, onToggle }: { records: readonly LogRecordWire[]; open: boolean; onToggle: () => void }): React.JSX.Element {
	return (
		<Panel
			title="Live tail"
			eyebrow={`${records.length} streaming`}
			right={
				<button
					type="button"
					data-testid="live-toggle"
					aria-expanded={open}
					onClick={onToggle}
					style={{ background: "transparent", border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)", color: "var(--text-secondary)", fontFamily: "var(--font-mono)", fontSize: 11, padding: "4px 10px", cursor: "pointer" }}
				>
					{open ? "collapse" : "expand"}
				</button>
			}
		>
			{open ? (
				records.length === 0 ? (
					<div data-testid="live-empty" style={{ padding: "12px 4px", fontSize: 13, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}>
						waiting for daemon activity…
					</div>
				) : (
					<div data-testid="live-list">
						{records.map((r, i) => (
							<LogRow key={`${r.time}-${r.path}-${i}`} record={r} live />
						))}
					</div>
				)
			) : (
				<div style={{ padding: "4px", fontSize: 12, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}>live tail collapsed</div>
			)}
		</Panel>
	);
}

/** The durable history table (FR-1/FR-3): filtered, paginated, newest first; shares LogRow. */
function HistoryTable({
	page,
	loading,
	error,
	onLoadMore,
}: {
	page: LogsHistoryWire;
	loading: boolean;
	error: boolean;
	onLoadMore: () => void;
}): React.JSX.Element {
	return (
		<Panel title="History" eyebrow={page.persistent ? `${page.count} on this page` : "history unavailable"}>
			{/* Explicit loading / error / empty states — never a blank table (FR-5). */}
			{error ? (
				<div data-testid="history-error" style={{ padding: "12px 4px", fontSize: 13, color: "var(--severity-critical)", fontFamily: "var(--font-mono)" }}>
					Could not load log history.
				</div>
			) : loading && page.records.length === 0 ? (
				<div data-testid="history-loading" style={{ padding: "12px 4px", fontSize: 13, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}>
					loading…
				</div>
			) : !page.persistent ? (
				<div data-testid="history-unavailable" style={{ padding: "12px 4px", fontSize: 13, color: "var(--text-tertiary)" }}>
					Durable log history is unavailable on this daemon. Live tail above still streams current activity.
				</div>
			) : page.records.length === 0 ? (
				<div data-testid="history-empty" style={{ padding: "12px 4px", fontSize: 13, color: "var(--text-tertiary)" }}>
					No logs match these filters.
				</div>
			) : (
				<>
					<LogTableHeader />
					<div data-testid="history-list">
						{page.records.map((r, i) => (
							<LogRow key={`${r.time}-${r.path}-${r.status}-${i}`} record={r} />
						))}
					</div>
					{page.nextCursor !== null && (
						<div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
							<Button variant="secondary" size="sm" disabled={loading} data-testid="history-load-more" onClick={onLoadMore}>
								{loading ? "loading…" : "Load more"}
							</Button>
						</div>
					)}
				</>
			)}
		</Panel>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// 043c — the Turns section: browsable list + drill-down (labeled "Turns" — AC-4).
// ─────────────────────────────────────────────────────────────────────────────

/** A presentation-safe key/value row in the turn-detail panel (METADATA ONLY — D-4 / AC-5). */
function TurnDetailRow({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 6px", borderTop: "1px solid var(--border-subtle)" }}>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)", minWidth: 120 }}>{label}</span>
			<span style={{ flex: 1 }} />
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-primary)", textAlign: "right", wordBreak: "break-word" }}>{children}</span>
		</div>
	);
}

/**
 * One turn's drill-down detail (FR-2 — harness, project, timestamp, event count, status, turn id),
 * with a Back control. METADATA ONLY: it renders NO transcript/body/JSONB/secret (D-4 / AC-5).
 */
function TurnDetail({ turn, onBack }: { turn: SessionRowWire; onBack: () => void }): React.JSX.Element {
	return (
		<Panel
			title="Turn detail"
			eyebrow={turn.sessionId}
			right={
				<Button variant="ghost" size="sm" data-testid="turn-back" onClick={onBack}>
					‹ Back
				</Button>
			}
		>
			<div data-testid="turn-detail">
				<TurnDetailRow label="turn id">{turn.sessionId || "—"}</TurnDetailRow>
				<TurnDetailRow label="project">{turn.project || "—"}</TurnDetailRow>
				<TurnDetailRow label="timestamp">{turn.startedAt || "—"}</TurnDetailRow>
				<TurnDetailRow label="event count">{turn.eventCount}</TurnDetailRow>
				<TurnDetailRow label="status">
					<Badge tone={turn.status === "summarized" ? "verified" : "neutral"} mono>
						{turn.status}
					</Badge>
				</TurnDetailRow>
			</div>
		</Panel>
	);
}

/** One row in the Turns list (click opens the drill-down detail). */
function TurnRow({ turn, onOpen }: { turn: SessionRowWire; onOpen: (turn: SessionRowWire) => void }): React.JSX.Element {
	return (
		<button
			type="button"
			data-testid={`turn-row-${turn.sessionId}`}
			onClick={() => onOpen(turn)}
			style={{
				display: "grid",
				gridTemplateColumns: "96px 1fr auto auto",
				alignItems: "center",
				gap: 12,
				width: "100%",
				padding: "10px 6px",
				borderTop: "1px solid var(--border-subtle)",
				background: "transparent",
				border: "none",
				borderTopColor: "var(--border-subtle)",
				cursor: "pointer",
				textAlign: "left",
			}}
		>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, color: "var(--honey)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
				{turn.sessionId}
			</span>
			<span style={{ fontSize: 13, color: "var(--text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{turn.project}</span>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>
				{turn.startedAt}
				{turn.eventCount > 0 ? ` · ${turn.eventCount}e` : ""}
			</span>
			<Badge tone={turn.status === "summarized" ? "verified" : "neutral"} mono>
				{turn.status}
			</Badge>
		</button>
	);
}

/** The Turns list (FR-1 — captured turns, newest first, labeled "Turns") + cursor pagination. */
function TurnsList({
	turns,
	loading,
	error,
	hasMore,
	onOpen,
	onLoadMore,
}: {
	turns: readonly SessionRowWire[];
	loading: boolean;
	error: boolean;
	hasMore: boolean;
	onOpen: (turn: SessionRowWire) => void;
	onLoadMore: () => void;
}): React.JSX.Element {
	return (
		<Panel title="Turns" eyebrow={`${turns.length} captured`}>
			{error ? (
				<div data-testid="turns-error" style={{ padding: "12px 4px", fontSize: 13, color: "var(--severity-critical)", fontFamily: "var(--font-mono)" }}>
					Could not load turns.
				</div>
			) : loading && turns.length === 0 ? (
				<div data-testid="turns-loading" style={{ padding: "12px 4px", fontSize: 13, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}>
					loading…
				</div>
			) : turns.length === 0 ? (
				<div data-testid="turns-empty" style={{ padding: "12px 4px", fontSize: 13, color: "var(--text-tertiary)" }}>
					No turns captured yet.
				</div>
			) : (
				<>
					<div data-testid="turns-list">
						{turns.map((t, i) => (
							<TurnRow key={t.sessionId || i} turn={t} onOpen={onOpen} />
						))}
					</div>
					{hasMore && (
						<div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
							<Button variant="secondary" size="sm" disabled={loading} data-testid="turns-load-more" onClick={onLoadMore}>
								{loading ? "loading…" : "Load more"}
							</Button>
						</div>
					)}
				</>
			)}
		</Panel>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The routed page.
// ─────────────────────────────────────────────────────────────────────────────

/** A tab button for the Requests / Turns switch (mono pill, honey when active — mirrors Sync). */
function TabButton({ label, active, onClick, testid }: { label: string; active: boolean; onClick: () => void; testid: string }): React.JSX.Element {
	return (
		<button
			type="button"
			data-testid={testid}
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
		</button>
	);
}

/**
 * The Logs page (043b + 043c). Hydrates the durable history + the live tail (request log) and the
 * browsable Turns history (DeepLake) over the shared `wire`. A tab switches between the two
 * surfaces; within Requests, the live tail (collapsible, top) + the filtered/paginated history
 * (below) stack. All hydration is fetch-on-mount + explicit refetch (filters/load-more) — the live
 * tail follows the SSE stream (no poll). Loading/empty/error states are explicit everywhere.
 */
export function LogsPage({ wire, daemonUp }: PageProps): React.JSX.Element {
	const [tab, setTab] = React.useState<LogsTab>("requests");

	// ── 043b: the request-log history (durable) + filters + pagination. ──
	const [history, setHistory] = React.useState<LogsHistoryWire>(EMPTY_LOGS_HISTORY);
	const [appliedFilters, setAppliedFilters] = React.useState<FilterState>(EMPTY_FILTERS);
	const [draftFilters, setDraftFilters] = React.useState<FilterState>(EMPTY_FILTERS);
	const [historyLoading, setHistoryLoading] = React.useState(false);
	const [historyError, setHistoryError] = React.useState(false);

	// ── 043b: the live tail (SSE follow — no poll). ──
	const [liveRecords, setLiveRecords] = React.useState<readonly LogRecordWire[]>([]);
	const [liveOpen, setLiveOpen] = React.useState(true);

	// ── 043c: the browsable Turns history + drill-down. ──
	const [turns, setTurns] = React.useState<readonly SessionRowWire[]>([]);
	const [turnsCursor, setTurnsCursor] = React.useState<string | null>(null);
	const [turnsLoading, setTurnsLoading] = React.useState(false);
	const [turnsError, setTurnsError] = React.useState(false);
	const [selectedTurn, setSelectedTurn] = React.useState<SessionRowWire | null>(null);

	// Fetch page ONE of the history for a given filter set (replaces the current page).
	const loadHistoryFirstPage = React.useCallback(
		async (filters: FilterState): Promise<void> => {
			setHistoryLoading(true);
			setHistoryError(false);
			try {
				const page = await wire.logsHistory(toWireFilters(filters));
				setHistory(page);
			} catch {
				setHistoryError(true);
			} finally {
				setHistoryLoading(false);
			}
		},
		[wire],
	);

	// Append the next OLDER history page via the cursor (no dup/gap — the daemon pages on id).
	const loadHistoryMore = React.useCallback(async (): Promise<void> => {
		if (history.nextCursor === null) return;
		setHistoryLoading(true);
		try {
			const next = await wire.logsHistory({ ...toWireFilters(appliedFilters), cursor: history.nextCursor });
			setHistory((cur) => ({
				records: [...cur.records, ...next.records],
				count: cur.count + next.count,
				nextCursor: next.nextCursor,
				persistent: next.persistent,
			}));
		} catch {
			setHistoryError(true);
		} finally {
			setHistoryLoading(false);
		}
	}, [wire, appliedFilters, history.nextCursor]);

	// Fetch page ONE of the turns history (replaces the list).
	const loadTurnsFirstPage = React.useCallback(async (): Promise<void> => {
		setTurnsLoading(true);
		setTurnsError(false);
		try {
			const page = await wire.turnsHistory({ limit: TURNS_PAGE_SIZE });
			setTurns(page.sessions);
			setTurnsCursor(page.nextCursor);
		} catch {
			setTurnsError(true);
		} finally {
			setTurnsLoading(false);
		}
	}, [wire]);

	// Append the next OLDER turns page via the cursor.
	const loadTurnsMore = React.useCallback(async (): Promise<void> => {
		if (turnsCursor === null) return;
		setTurnsLoading(true);
		try {
			const next = await wire.turnsHistory({ limit: TURNS_PAGE_SIZE, cursor: turnsCursor });
			setTurns((cur) => [...cur, ...next.sessions]);
			setTurnsCursor(next.nextCursor);
		} catch {
			setTurnsError(true);
		} finally {
			setTurnsLoading(false);
		}
	}, [wire, turnsCursor]);

	// On mount: load the first history page + the first turns page (both surfaces are browsable).
	React.useEffect(() => {
		void loadHistoryFirstPage(EMPTY_FILTERS);
		void loadTurnsFirstPage();
	}, [loadHistoryFirstPage, loadTurnsFirstPage]);

	// The live tail FOLLOWS the SSE stream (D-2 — reuse `wire.logsStream`, no poll). In a non-browser
	// env (jsdom test) `logsStream` is an inert no-op, so the tail degrades to empty and the test
	// drives the handler directly. The EventSource is closed on unmount via the returned unsubscribe.
	React.useEffect(() => {
		let alive = true;
		const unsubscribe = wire.logsStream((record) => {
			if (!alive) return;
			setLiveRecords((buf) => appendLiveRecord(buf, record));
		});
		return () => {
			alive = false;
			unsubscribe();
		};
	}, [wire]);

	const onApplyFilters = React.useCallback((): void => {
		setAppliedFilters(draftFilters);
		void loadHistoryFirstPage(draftFilters);
	}, [draftFilters, loadHistoryFirstPage]);

	const onClearFilters = React.useCallback((): void => {
		setDraftFilters(EMPTY_FILTERS);
		setAppliedFilters(EMPTY_FILTERS);
		void loadHistoryFirstPage(EMPTY_FILTERS);
	}, [loadHistoryFirstPage]);

	const onChangeField = React.useCallback((key: keyof FilterState, value: string): void => {
		setDraftFilters((cur) => ({ ...cur, [key]: value }));
	}, []);

	const turnsHasMore = turnsCursor !== null;

	return (
		<PageFrame
			title="Logs"
			eyebrow={daemonUp ? "request log · turns" : "daemon offline"}
			right={
				<div style={{ display: "flex", gap: 8 }}>
					<TabButton label="Requests" active={tab === "requests"} onClick={() => setTab("requests")} testid="tab-requests" />
					<TabButton label="Turns" active={tab === "turns"} onClick={() => setTab("turns")} testid="tab-turns" />
				</div>
			}
		>
			{tab === "requests" ? (
				<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
					{/* Stacked (OQ-2): live tail (collapsible) on TOP, history below — kept separate (D-1). */}
					<LiveTail records={liveRecords} open={liveOpen} onToggle={() => setLiveOpen((o) => !o)} />
					<FilterBar draft={draftFilters} onChangeField={onChangeField} onApply={onApplyFilters} onClear={onClearFilters} />
					<HistoryTable page={history} loading={historyLoading} error={historyError} onLoadMore={() => void loadHistoryMore()} />
				</div>
			) : selectedTurn !== null ? (
				<TurnDetail turn={selectedTurn} onBack={() => setSelectedTurn(null)} />
			) : (
				<TurnsList
					turns={turns}
					loading={turnsLoading}
					error={turnsError}
					hasMore={turnsHasMore}
					onOpen={(t) => setSelectedTurn(t)}
					onLoadMore={() => void loadTurnsMore()}
				/>
			)}
		</PageFrame>
	);
}

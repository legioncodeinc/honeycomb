/**
 * The MEMORIES page — the full memory-management surface (PRD-040a/b/c).
 *
 * Mounts on the `#/memories` route inside the PRD-037 shell. It receives {@link PageProps} (the
 * SHARED `wire` — never `createWireClient` — plus `daemonUp`/`pollinating`) and renders inside
 * `<PageFrame eyebrow="memories">`. It is three concerns on one surface:
 *
 *   040a — BROWSE + SEARCH + VIEW. A paginated list from `GET /api/memories` (newest-first, honest
 *          empty state, "load more" bumping `limit`); a search box that POSTs `/api/memories/recall`
 *          and swaps the list for the engine's ranked hits (engine order + score + the PRD-029
 *          lexical-fallback badge), clearing restores the list; a row opens a DETAIL view from
 *          `GET /api/memories/:id` showing full content + the OQ-1 metadata (scope/type/source/
 *          version/embedding-presence). A forgotten/unknown id renders the honest "forgotten" state.
 *   040b — ADD + EDIT (versioned). An add form POSTs `/api/memories`; an edit (on the detail view)
 *          POSTs `/api/memories/:id/modify` with content + a REQUIRED reason. After ANY write the
 *          page RE-READS (never optimistic) and — because DeepLake is eventually consistent —
 *          POLLS-until-convergence so the new version is visible. Forget is behind a confirm.
 *   040c — COMPACT + POLLINATE + WATCH. Compact (behind a confirm) POSTs `/api/diagnostics/compact` and
 *          renders the real per-table summary (errored>0 ⇒ "attempted, not completed"); Pollinate reuses
 *          the EXACT honest-ack logic (enqueued/running/skipped, no fake spinner); Watch toggles the
 *          `usePoll` log recipe filtered to memory routes.
 *
 * Security (AC-5): LOCAL-MODE-ONLY (inherited from the shell); memory content renders as ESCAPED
 * TEXT (React's default — never `dangerouslySetInnerHTML`); no token/secret rides any list/detail/
 * search/ack/summary/watch line; the page sends only known table names / content / reason — no
 * attacker-controlled SQL identifier. Every visual value is an existing `var(--…)` DS token.
 */

import React from "react";

import { Badge, Button, Input, MemoryCard } from "../primitives.js";
import { PageFrame, type PageProps } from "../page-frame.js";
import {
	DEFAULT_MEMORY_TYPE,
	MEMORY_TYPE_DESCRIPTIONS,
	MEMORY_TYPES,
} from "../../../shared/memory-types.js";
import {
	formatLogLine,
	type CompactSummaryWire,
	type PollinateAck,
	type MemoryRecordWire,
	type RecalledMemory,
} from "../wire.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** The list page size + the "load more" step (the daemon clamps to MAX_LIST_LIMIT 500). */
const LIST_STEP = 50;
/** How often Watch re-reads `/api/logs` (ms) — the established log-poll cadence. */
const WATCH_POLL_MS = 2500;
/** How many filtered watch lines to keep. */
const MAX_WATCH_LINES = 12;
/** The memory-relevant route prefixes Watch filters `/api/logs` records to (040c-AC-3). */
const MEMORY_ROUTE_PREFIXES = ["/api/memories", "/api/diagnostics/pollinate", "/api/diagnostics/compact"] as const;

/**
 * Re-read convergence budget (040b OQ-3): DeepLake is eventually consistent, so a re-read straight
 * after a write may not yet show the new version. We poll a few short attempts until the predicate
 * holds, then render whatever the last read returned (we NEVER fabricate — a stale read is shown
 * honestly as the persisted truth-so-far, not as a phantom local edit).
 */
const REREAD_ATTEMPTS = 5;
const REREAD_DELAY_MS = 150;

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Sleep `ms` (the poll-until-convergence delay). */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True iff a log record's path is a memory-relevant route (040c-AC-3 filter). */
function isMemoryRoute(path: string): boolean {
	return MEMORY_ROUTE_PREFIXES.some((p) => path.startsWith(p));
}

/** A muted mono metadata key→value row for the detail view. Renders nothing when value is empty. */
function MetaRow({ label, value }: { label: string; value: string }): React.JSX.Element | null {
	if (value === "") return null;
	return (
		<div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", minWidth: 84, textTransform: "uppercase", letterSpacing: "0.06em" }}>
				{label}
			</span>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)", wordBreak: "break-all" }}>{value}</span>
		</div>
	);
}

/** The shared surface card style (matches the kit's panel/elevated rhythm). */
const SURFACE: React.CSSProperties = {
	padding: 16,
	background: "var(--bg-surface)",
	border: "1px solid var(--border-default)",
	borderRadius: "var(--radius-lg)",
};

// ─────────────────────────────────────────────────────────────────────────────
// The browse list (040a)
// ─────────────────────────────────────────────────────────────────────────────

/** One clickable list row — id + a one-line content preview + a scope/version tag. Escaped text. */
function MemoryRow({ record, onOpen }: { record: MemoryRecordWire; onOpen: (id: string) => void }): React.JSX.Element {
	return (
		<button
			type="button"
			data-testid="memory-row"
			data-memory-id={record.id}
			onClick={() => onOpen(record.id)}
			style={{
				display: "flex",
				alignItems: "center",
				gap: 12,
				width: "100%",
				textAlign: "left",
				padding: "11px 14px",
				background: "var(--bg-elevated)",
				border: "1px solid var(--border-default)",
				borderRadius: "var(--radius-md)",
				cursor: "pointer",
				color: "var(--text-primary)",
			}}
		>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, color: "var(--honey)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 160 }}>
				{record.id}
			</span>
			<span style={{ flex: 1, fontSize: 13, color: "var(--text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
				{record.content}
			</span>
			<Badge tone="neutral" mono>
				{record.type || "fact"}
			</Badge>
		</button>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The detail view (040a) + edit/forget controls (040b)
// ─────────────────────────────────────────────────────────────────────────────

/** Props for {@link DetailView}. */
interface DetailViewProps {
	readonly record: MemoryRecordWire;
	readonly onClose: () => void;
	readonly onEdit: (id: string, content: string, reason: string) => Promise<string | null>;
	readonly onForget: (id: string, reason: string) => Promise<string | null>;
}

/**
 * The DETAIL view (040a-AC-3): full content (escaped) + the OQ-1 metadata, with the 040b Edit +
 * Forget controls hanging off it. Edit requires a non-empty reason (client pre-validates; the
 * daemon is the source of truth). Forget is behind an explicit confirm (040b-OQ-1). After a write
 * the parent re-reads with poll-convergence and feeds the persisted record back as `record`.
 */
function DetailView({ record, onClose, onEdit, onForget }: DetailViewProps): React.JSX.Element {
	const [editing, setEditing] = React.useState(false);
	const [draft, setDraft] = React.useState(record.content);
	const [reason, setReason] = React.useState("");
	const [busy, setBusy] = React.useState(false);
	const [note, setNote] = React.useState("");
	const [confirmingForget, setConfirmingForget] = React.useState(false);

	// Reset the edit buffers whenever the persisted record changes (a re-read flowed in).
	React.useEffect(() => {
		setDraft(record.content);
		setReason("");
		setEditing(false);
		setConfirmingForget(false);
	}, [record.id, record.content, record.version]);

	const reasonEmpty = reason.trim() === "";
	const contentEmpty = draft.trim() === "";

	const submitEdit = async (): Promise<void> => {
		// Client pre-validates (non-empty content + reason) to fail fast; the daemon still validates.
		if (busy || contentEmpty || reasonEmpty) return;
		setBusy(true);
		setNote("");
		const result = await onEdit(record.id, draft, reason);
		setBusy(false);
		// Leave edit mode either way: the parent has re-read the PERSISTED record (the new version on
		// success, or the UNCHANGED value on a 400/network failure), and we render THAT — never the
		// optimistic form draft. A null result surfaces the honest failure note.
		setEditing(false);
		setReason("");
		setNote(result ?? "Save failed — the memory is unchanged.");
	};

	const submitForget = async (): Promise<void> => {
		if (busy) return;
		setBusy(true);
		setNote("");
		const result = await onForget(record.id, "forgotten via dashboard");
		setBusy(false);
		if (result === null) setNote("Forget failed — the memory is unchanged.");
		// On success the parent closes the detail (the memory is now a tombstone → "forgotten").
	};

	return (
		<div data-testid="memory-detail" style={{ ...SURFACE, display: "flex", flexDirection: "column", gap: 14 }}>
			<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, color: "var(--honey)" }}>{record.id}</span>
				<Badge tone="neutral" mono>
					{record.type || "fact"}
				</Badge>
				{record.hasEmbedding && (
					<Badge tone="pollinate" mono dot>
						semantic
					</Badge>
				)}
				<span style={{ flex: 1 }} />
				<Button variant="ghost" size="sm" onClick={onClose}>
					← back
				</Button>
			</div>

			{/* Full content — ESCAPED TEXT (React default). NEVER dangerouslySetInnerHTML (AC-5). */}
			{editing ? (
				<textarea
					aria-label="edit content"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					rows={5}
					style={{
						width: "100%",
						resize: "vertical",
						padding: "10px 12px",
						background: "var(--bg-surface)",
						border: "1px solid var(--border-default)",
						borderRadius: "var(--radius-md)",
						color: "var(--text-primary)",
						fontFamily: "var(--font-sans)",
						fontSize: 14,
						lineHeight: "20px",
					}}
				/>
			) : (
				<div data-testid="memory-content" style={{ fontSize: 14, lineHeight: "21px", color: "var(--text-primary)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
					{record.content}
				</div>
			)}

			{/* OQ-1 metadata — scope / source / version / embedding presence. */}
			<div style={{ display: "flex", flexDirection: "column", gap: 5, paddingTop: 4, borderTop: "1px solid var(--border-subtle)" }}>
				<MetaRow label="scope" value={[record.visibility, record.agentId].filter((v) => v !== "").join(" · ")} />
				<MetaRow label="source" value={[record.sourceType, record.sourceId].filter((v) => v !== "").join(" · ")} />
				<MetaRow label="version" value={record.version > 0 ? String(record.version) : ""} />
				<MetaRow label="indexed" value={record.hasEmbedding ? "yes (semantic)" : "no (lexical only)"} />
				<MetaRow label="created" value={record.createdAt} />
				<MetaRow label="updated" value={record.updatedAt} />
			</div>

			{/* 040b: the versioning note — honest about the append-only model. */}
			<div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>
				Edits append a new version; the prior is kept in history.
			</div>

			{/* 040b: edit + forget controls. */}
			{editing ? (
				<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
					<Input
						mono
						aria-label="edit reason"
						value={reason}
						placeholder="reason (required) — why is this changing?"
						onChange={(e) => setReason(e.target.value)}
					/>
					<div style={{ display: "flex", gap: 10, alignItems: "center" }}>
						<Button variant="primary" onClick={() => void submitEdit()} disabled={busy || contentEmpty || reasonEmpty}>
							{busy ? "…" : "Save new version"}
						</Button>
						<Button variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
							Cancel
						</Button>
						{reasonEmpty && <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>a reason is required to save</span>}
					</div>
				</div>
			) : (
				<div style={{ display: "flex", gap: 10, alignItems: "center" }}>
					<Button variant="secondary" onClick={() => setEditing(true)}>
						Edit
					</Button>
					{confirmingForget ? (
						<>
							<Button variant="danger" onClick={() => void submitForget()} disabled={busy}>
								{busy ? "…" : "Confirm forget"}
							</Button>
							<Button variant="ghost" onClick={() => setConfirmingForget(false)} disabled={busy}>
								Cancel
							</Button>
							<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>
								Forget soft-deletes this memory (a tombstone version).
							</span>
						</>
					) : (
						<Button variant="ghost" onClick={() => setConfirmingForget(true)}>
							Forget
						</Button>
					)}
				</div>
			)}

			{note !== "" && (
				<div data-testid="detail-note" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)" }}>
					{note}
				</div>
			)}
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The add form (040b)
// ─────────────────────────────────────────────────────────────────────────────

/** The DS-token styling shared by the AddForm's `<select>` and `<textarea>` (kept in one place). */
const ADD_FIELD_STYLE: React.CSSProperties = {
	height: 40,
	padding: "0 12px",
	background: "var(--bg-surface)",
	border: "1px solid var(--border-default)",
	borderRadius: "var(--radius-md)",
	color: "var(--text-primary)",
	fontFamily: "var(--font-mono)",
	fontSize: "var(--text-sm)",
};

/**
 * The ADD form (040b-AC-1): content (required) + a CLOSED-taxonomy `type` dropdown. On 201,
 * the parent re-lists. The `type` field is a `<select>` of the single-sourced {@link MEMORY_TYPES}
 * (default {@link DEFAULT_MEMORY_TYPE}) — never free text — so a user can only submit one of the
 * six the daemon's enum gate accepts; each option's description rides as the `title` hint. The
 * chosen token is passed verbatim to the existing submit path (`onAdd` → `wire.addMemory`).
 */
function AddForm({ onAdd }: { onAdd: (content: string, type: string) => Promise<string | null> }): React.JSX.Element {
	const [content, setContent] = React.useState("");
	const [type, setType] = React.useState<string>(DEFAULT_MEMORY_TYPE);
	const [busy, setBusy] = React.useState(false);
	const [note, setNote] = React.useState("");

	const empty = content.trim() === "";
	const submit = async (): Promise<void> => {
		if (busy || empty) return;
		setBusy(true);
		setNote("");
		const result = await onAdd(content, type);
		setBusy(false);
		if (result === null) {
			setNote("Add failed — nothing was stored.");
			return;
		}
		// On success clear the form; the parent has re-listed and the new memory shows in the list.
		setContent("");
		setType(DEFAULT_MEMORY_TYPE);
		setNote(result);
	};

	return (
		<div style={{ ...SURFACE, display: "flex", flexDirection: "column", gap: 10 }}>
			<div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>Add a memory</div>
			<textarea
				aria-label="new content"
				value={content}
				onChange={(e) => setContent(e.target.value)}
				rows={3}
				placeholder="a fact to remember — e.g. we deploy via `just release`"
				style={{
					width: "100%",
					resize: "vertical",
					padding: "10px 12px",
					background: "var(--bg-surface)",
					border: "1px solid var(--border-default)",
					borderRadius: "var(--radius-md)",
					color: "var(--text-primary)",
					fontFamily: "var(--font-sans)",
					fontSize: 14,
					lineHeight: "20px",
				}}
			/>
			<div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
				<select
					aria-label="memory type"
					data-testid="add-type"
					value={type}
					onChange={(e) => setType(e.target.value)}
					title={MEMORY_TYPE_DESCRIPTIONS[type as keyof typeof MEMORY_TYPE_DESCRIPTIONS]}
					style={{ ...ADD_FIELD_STYLE, width: 180, cursor: "pointer" }}
				>
					{MEMORY_TYPES.map((t) => (
						<option key={t} value={t} title={MEMORY_TYPE_DESCRIPTIONS[t]}>
							{t === DEFAULT_MEMORY_TYPE ? `${t} (default)` : t}
						</option>
					))}
				</select>
				<Button variant="primary" onClick={() => void submit()} disabled={busy || empty}>
					{busy ? "…" : "Add memory"}
				</Button>
				{note !== "" && <span data-testid="add-note" style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>{note}</span>}
			</div>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The lifecycle cluster (040c): compact + pollinate + watch
// ─────────────────────────────────────────────────────────────────────────────

/** Render one per-table compaction summary line; errored>0 ⇒ "attempted, not completed". */
function compactLine(t: CompactSummaryWire["summaries"][number]): string {
	if (t.errored > 0) return `${t.table}: attempted, not completed`;
	const parts = [`${t.keysCompacted} keys`, `${t.rowsReaped} rows reaped`];
	if (t.keysSkipped > 0) parts.push(`${t.keysSkipped} keys deferred`);
	return `${t.table}: ${parts.join(" · ")}`;
}

/** Props for {@link LifecyclePanel}. */
interface LifecyclePanelProps {
	readonly pollinating: boolean;
	readonly onCompact: () => Promise<CompactSummaryWire | null>;
	readonly onPollinate: () => Promise<PollinateAck>;
	readonly watchLines: readonly string[];
	readonly watching: boolean;
	readonly onToggleWatch: () => void;
}

/** The lifecycle cluster (040c): compact (confirm + honest summary), pollinate (honest ack), watch (poll-filter). */
function LifecyclePanel({ pollinating, onCompact, onPollinate, watchLines, watching, onToggleWatch }: LifecyclePanelProps): React.JSX.Element {
	const [confirmingCompact, setConfirmingCompact] = React.useState(false);
	const [compactBusy, setCompactBusy] = React.useState(false);
	const [summary, setSummary] = React.useState<CompactSummaryWire | null>(null);
	const [pollinateBusy, setPollinateBusy] = React.useState(false);
	const [pollinateNote, setPollinateNote] = React.useState("");

	const runCompact = async (): Promise<void> => {
		if (compactBusy) return;
		setConfirmingCompact(false);
		setCompactBusy(true);
		const result = await onCompact();
		setCompactBusy(false);
		setSummary(result); // null → "compaction unavailable"; never crashes.
	};

	// 040c-AC-2: the EXACT honest-ack logic (no fake spinner). enqueued/running → triggered note;
	// skipped → "skipped · reason". Never a permanent pollinating state on a !triggered ack.
	const runPollinate = async (): Promise<void> => {
		if (pollinateBusy) return;
		setPollinateBusy(true);
		setPollinateNote("");
		const ack = await onPollinate();
		setPollinateBusy(false);
		if (ack.triggered) {
			setPollinateNote(ack.status === "running" ? "already running" : "consolidating…");
		} else {
			setPollinateNote(`skipped · ${ack.reason ?? "unavailable"}`);
		}
	};

	return (
		<div style={{ ...SURFACE, display: "flex", flexDirection: "column", gap: 14 }}>
			<div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>Lifecycle</div>

			{/* COMPACT — behind a confirm; honest per-table summary. */}
			<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
				<div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
					{confirmingCompact ? (
						<>
							<Button variant="danger" onClick={() => void runCompact()} disabled={compactBusy}>
								{compactBusy ? "…" : "Confirm compact"}
							</Button>
							<Button variant="ghost" onClick={() => setConfirmingCompact(false)} disabled={compactBusy}>
								Cancel
							</Button>
							<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>
								Compaction prunes old memory versions across version-bumped tables. Continue?
							</span>
						</>
					) : (
						<Button variant="secondary" onClick={() => setConfirmingCompact(true)} disabled={compactBusy}>
							Compact
						</Button>
					)}
				</div>
				{summary !== null && (
					<div data-testid="compact-summary" style={{ display: "flex", flexDirection: "column", gap: 3 }}>
						{summary.summaries.length === 0 && summary.skippedTables.length === 0 ? (
							<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>nothing reaped this pass</span>
						) : (
							summary.summaries.map((t) => (
								<span key={t.table} style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: t.errored > 0 ? "var(--severity-warning)" : "var(--text-secondary)" }}>
									{compactLine(t)}
								</span>
							))
						)}
						{summary.skippedTables.length > 0 && (
							<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>
								skipped (absent): {summary.skippedTables.join(", ")}
							</span>
						)}
					</div>
				)}
			</div>

			{/* POLLINATE — honest ack (no fake spinner). */}
			<div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
				<Button variant="pollinate" onClick={() => void runPollinate()} disabled={pollinateBusy || pollinating}>
					{pollinateBusy || pollinating ? "pollinating…" : "Pollinate now"}
				</Button>
				{pollinateNote !== "" && <span data-testid="pollinate-note" style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>{pollinateNote}</span>}
			</div>

			{/* WATCH — poll-filter toggle. */}
			<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
				<div style={{ display: "flex", gap: 10, alignItems: "center" }}>
					<Button variant={watching ? "secondary" : "ghost"} onClick={onToggleWatch}>
						{watching ? "Stop watch" : "Watch"}
					</Button>
					{watching && (
						<span style={{ display: "flex", alignItems: "center", gap: 6 }}>
							<span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--verified)" }} />
							<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>memory routes</span>
						</span>
					)}
				</div>
				{watching && (
					<div data-testid="watch-feed" style={{ display: "flex", flexDirection: "column", gap: 5 }}>
						{watchLines.length === 0 ? (
							<code style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>waiting for memory activity…</code>
						) : (
							watchLines.map((l, i) => (
								<code key={i} style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: i === 0 ? "var(--text-primary)" : "var(--text-tertiary)", whiteSpace: "pre" }}>
									{l}
								</code>
							))
						)}
					</div>
				)}
			</div>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The page
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Memories page (040a/b/c). Hydrates the browse list on mount from the shared `wire`, runs
 * search/detail/add/edit/forget/compact/pollinate/watch, and RE-READS (with poll-convergence) after
 * every write so the rendered value is the daemon-persisted truth, never optimistic.
 */
export function MemoriesPage({ wire, pollinating = false }: PageProps): React.JSX.Element {
	// ── browse list (040a) ──
	const [records, setRecords] = React.useState<readonly MemoryRecordWire[]>([]);
	const [limit, setLimit] = React.useState(LIST_STEP);
	const [hydrated, setHydrated] = React.useState(false);

	// ── search (040a) ──
	const [query, setQuery] = React.useState("");
	const [hits, setHits] = React.useState<readonly RecalledMemory[]>([]);
	const [searching, setSearching] = React.useState(false);
	const [searchActive, setSearchActive] = React.useState(false);
	const [degraded, setDegraded] = React.useState(false);

	// ── detail (040a) ──
	const [openId, setOpenId] = React.useState<string | null>(null);
	const [detail, setDetail] = React.useState<MemoryRecordWire | null>(null);
	const [detailMissing, setDetailMissing] = React.useState(false);

	// ── watch (040c) ──
	const [watching, setWatching] = React.useState(false);
	const [watchLines, setWatchLines] = React.useState<readonly string[]>([]);

	/** Re-list the browse corpus from the daemon (the persisted truth). */
	const reList = React.useCallback(
		async (nextLimit: number): Promise<MemoryRecordWire[]> => {
			const rows = await wire.listMemories(nextLimit);
			setRecords(rows);
			setHydrated(true);
			return rows;
		},
		[wire],
	);

	// 040a-AC-1: hydrate the list on mount.
	React.useEffect(() => {
		void reList(limit);
		// Only on mount + when the limit bumps (load more).
	}, [reList, limit]);

	// 040c-AC-3: Watch — poll `/api/logs` filtered to memory routes; stop clears the interval; cleanup on unmount.
	React.useEffect(() => {
		if (!watching) return;
		let alive = true;
		const tick = async (): Promise<void> => {
			const recs = await wire.logs(40);
			if (!alive) return;
			const lines = recs.filter((r) => isMemoryRoute(r.path)).slice(-MAX_WATCH_LINES).reverse().map(formatLogLine);
			setWatchLines(lines);
		};
		void tick();
		const id = setInterval(() => void tick(), WATCH_POLL_MS);
		return () => {
			alive = false;
			clearInterval(id);
		};
	}, [watching, wire]);

	// ── search (040a-AC-2) ──
	const runSearch = React.useCallback(async (): Promise<void> => {
		const q = query.trim();
		if (q === "") {
			// Clearing the box restores the full list.
			setSearchActive(false);
			setHits([]);
			return;
		}
		setSearching(true);
		const { memories, degraded: deg } = await wire.recall(q);
		setHits(memories);
		setDegraded(deg);
		setSearchActive(true);
		setSearching(false);
	}, [query, wire]);

	const clearSearch = React.useCallback((): void => {
		setQuery("");
		setSearchActive(false);
		setHits([]);
	}, []);

	// ── open a detail (040a-AC-3) ──
	const openDetail = React.useCallback(
		async (id: string): Promise<void> => {
			setOpenId(id);
			setDetail(null);
			setDetailMissing(false);
			const rec = await wire.getMemory(id);
			if (rec === null) {
				setDetailMissing(true);
				return;
			}
			setDetail(rec);
		},
		[wire],
	);

	const closeDetail = React.useCallback((): void => {
		setOpenId(null);
		setDetail(null);
		setDetailMissing(false);
	}, []);

	/**
	 * Re-read one memory with poll-until-convergence (040b OQ-3 / AC-4). DeepLake is eventually
	 * consistent, so we poll a few short attempts until the persisted record satisfies `done`
	 * (e.g. its version advanced, or its content matches the just-saved value), then render
	 * whatever the LAST read returned — never the form input. Returns the persisted record (or null).
	 */
	const rereadUntil = React.useCallback(
		async (id: string, done: (rec: MemoryRecordWire) => boolean): Promise<MemoryRecordWire | null> => {
			let last: MemoryRecordWire | null = null;
			for (let attempt = 0; attempt < REREAD_ATTEMPTS; attempt += 1) {
				last = await wire.getMemory(id);
				if (last !== null && done(last)) return last;
				await sleep(REREAD_DELAY_MS);
			}
			return last;
		},
		[wire],
	);

	// ── edit (040b-AC-2/AC-3/AC-4/AC-5) ──
	const onEdit = React.useCallback(
		async (id: string, content: string, reason: string): Promise<string | null> => {
			const ack = await wire.modifyMemory(id, { content, reason });
			if (ack === null) {
				// Honest failure (AC-5): re-read the UNCHANGED persisted value and re-render it.
				const persisted = await wire.getMemory(id);
				if (persisted !== null) setDetail(persisted);
				return null;
			}
			// RE-READ, never optimistic (AC-4): poll until the persisted content matches the save
			// (or a version advances), then render that — NOT the form input.
			const persisted = await rereadUntil(id, (rec) => rec.content === content || rec.version > 0);
			if (persisted !== null) setDetail(persisted);
			// Refresh the browse list so the row preview reflects the new persisted content.
			void reList(limit);
			return "saved · new version";
		},
		[wire, rereadUntil, reList, limit],
	);

	// ── forget (040b-OQ-1) ──
	const onForget = React.useCallback(
		async (id: string, reason: string): Promise<string | null> => {
			const ack = await wire.forgetMemory(id, { reason });
			if (ack === null) return null;
			// Re-read: a forgotten memory reads as null (tombstone). Close the detail + re-list.
			closeDetail();
			void reList(limit);
			return "forgotten";
		},
		[wire, closeDetail, reList, limit],
	);

	// ── add (040b-AC-1) ──
	const onAdd = React.useCallback(
		async (content: string, type: string): Promise<string | null> => {
			const ack = await wire.addMemory({ content, ...(type !== "" ? { type } : {}) });
			if (ack === null) return null;
			// RE-READ, never optimistic: re-list so the new memory appears from the daemon's truth.
			await reList(limit);
			return ack.id !== null ? `stored · ${ack.id}` : `stored · ${ack.action || "ok"}`;
		},
		[wire, reList, limit],
	);

	// ── compact + pollinate (040c) ──
	const onCompact = React.useCallback((): Promise<CompactSummaryWire | null> => wire.compact(), [wire]);
	const onPollinate = React.useCallback((): Promise<PollinateAck> => wire.pollinate(), [wire]);
	const toggleWatch = React.useCallback((): void => {
		setWatching((w) => !w);
		setWatchLines([]);
	}, []);

	// The detail panel is open iff an id is selected.
	const detailOpen = openId !== null;

	return (
		<PageFrame
			eyebrow="memories"
			title="Memories"
			right={
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>
					{records.length} kept
				</span>
			}
		>
			{/* ── SEARCH (040a-AC-2) ── */}
			<div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
				<div style={{ flex: 1 }}>
					<Input
						mono
						size="lg"
						value={query}
						placeholder="search memories…  e.g. how do we deploy"
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void runSearch();
						}}
					/>
				</div>
				<Button variant="primary" size="lg" onClick={() => void runSearch()} disabled={searching}>
					{searching ? "…" : "Search"}
				</Button>
				{searchActive && (
					<Button variant="ghost" size="lg" onClick={clearSearch}>
						Clear
					</Button>
				)}
			</div>

			{/* PRD-029 lexical-fallback badge — only when the LAST search ran degraded. */}
			{searchActive && degraded && (
				<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
					<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
						recall
					</span>
					<span title="recall fell back to lexical (embeddings off) — semantic ranking unavailable">
						<Badge tone="warning" mono dot>
							lexical fallback
						</Badge>
					</span>
				</div>
			)}

			{/* ── DETAIL (040a-AC-3) — replaces the browse area while open ── */}
			{detailOpen ? (
				detailMissing ? (
					<div data-testid="memory-forgotten" style={{ ...SURFACE, display: "flex", flexDirection: "column", gap: 12 }}>
						<div style={{ fontSize: 14, color: "var(--text-secondary)" }}>This memory was forgotten (or its id is unknown).</div>
						<div>
							<Button variant="ghost" size="sm" onClick={closeDetail}>
								← back
							</Button>
						</div>
					</div>
				) : detail !== null ? (
					<DetailView record={detail} onClose={closeDetail} onEdit={onEdit} onForget={onForget} />
				) : (
					<div style={{ ...SURFACE, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>loading…</div>
				)
			) : (
				<>
					{/* SEARCH RESULTS swap the list (040a-AC-2): engine order + score + the MemoryCard render. */}
					{searchActive ? (
						<div data-testid="search-results" style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}>
							{hits.length === 0 ? (
								<div style={{ padding: "10px 4px", fontSize: 13, color: "var(--text-tertiary)" }}>No memories matched that query.</div>
							) : (
								hits.map((m, i) => (
									<MemoryCard key={m.memoryKey} {...m} pollinating={pollinating && i === 1} />
								))
							)}
						</div>
					) : (
						/* BROWSE LIST (040a-AC-1) — newest-first, honest empty state, load more. */
						<div data-testid="memory-list" style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
							{!hydrated ? (
								<div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>loading…</div>
							) : records.length === 0 ? (
								<div style={{ padding: "10px 4px", fontSize: 13, color: "var(--text-tertiary)" }}>No memories yet.</div>
							) : (
								<>
									{records.map((r) => (
										<MemoryRow key={r.id} record={r} onOpen={openDetail} />
									))}
									{/* "Load more" — bump the limit (the daemon clamps to 500). Hidden once a short page returns. */}
									{records.length >= limit && (
										<div style={{ paddingTop: 4 }}>
											<Button variant="ghost" size="sm" onClick={() => setLimit((l) => l + LIST_STEP)}>
												Load more
											</Button>
										</div>
									)}
								</>
							)}
						</div>
					)}

					{/* ── ADD (040b) + LIFECYCLE (040c) — below the browse area ── */}
					<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
						<AddForm onAdd={onAdd} />
						<LifecyclePanel
							pollinating={pollinating}
							onCompact={onCompact}
							onPollinate={onPollinate}
							watchLines={watchLines}
							watching={watching}
							onToggleWatch={toggleWatch}
						/>
					</div>
				</>
			)}
		</PageFrame>
	);
}

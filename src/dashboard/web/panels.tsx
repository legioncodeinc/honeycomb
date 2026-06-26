/**
 * The dashboard PANEL components, ported to TSX — PRD-024 Wave 2 (AC-1..AC-6, D-5).
 *
 * These are the panels the UI kit declares in `assets/ui_kits/dashboard/components.jsx`
 * (SessionsPanel, RulesPanel, SkillSyncPanel, GraphCanvas, LiveLog, ConnectivityBanner),
 * ported verbatim from JSX to typed TSX so esbuild compiles + bundles them at build time
 * (D-1 — no in-browser Babel). They compose the {@link Badge} primitive and read the SAME
 * view-model shapes the daemon serves (`src/dashboard/contracts.ts`, via `wire.ts`), so the
 * panels render the LIVE data (D-2) with the kit's exact markup + tokens.
 *
 * Each panel honors its empty/zero state (AC-2): no sessions → an empty session list (not a
 * crash); graph not built → the kit's `honeycomb graph build` prompt; no skills/rules → an
 * empty list. The data NEVER comes from the canned `data.js` — it is whatever the wire client
 * fetched.
 */

import React from "react";

import { BuildGraphButton } from "./build-graph-button.js";
import { layout, neighborsOf } from "./graph-layout.js";
import { Badge, type BadgeTone } from "./primitives.js";
import { capGraphForRender, MAX_RENDER_NODES } from "./wire.js";
import type { GraphWire, LogRecordWire, ProviderEntryWire, RuleRowWire, SessionRowWire, SettingValueWire, SkillRowWire, WireClient } from "./wire.js";

// ── Panel shell ────────────────────────────────────────────────────────────────

/** Props for the titled {@link Panel} shell. */
export interface PanelProps {
	title: string;
	eyebrow?: string;
	right?: React.ReactNode;
	children?: React.ReactNode;
	style?: React.CSSProperties;
}

/** A titled dashboard panel (ported from `components.jsx` `Panel`). */
export function Panel({ title, eyebrow, right, children, style }: PanelProps): React.JSX.Element {
	return (
		<section
			style={{
				background: "var(--bg-surface)",
				border: "1px solid var(--border-default)",
				borderRadius: "var(--radius-lg)",
				overflow: "hidden",
				display: "flex",
				flexDirection: "column",
				...style,
			}}
		>
			<header style={{ display: "flex", alignItems: "center", gap: 10, padding: "13px 16px", borderBottom: "1px solid var(--border-subtle)" }}>
				<h2 style={{ fontSize: "var(--text-base)", fontWeight: 600, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.01em" }}>{title}</h2>
				{eyebrow && <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>{eyebrow}</span>}
				<span style={{ flex: 1 }} />
				{right}
			</header>
			<div style={{ padding: 16, flex: 1 }}>{children}</div>
		</section>
	);
}

/** A small centered empty-state message used by panels with no rows (AC-2). */
function EmptyRow({ children }: { children: React.ReactNode }): React.JSX.Element {
	return <div style={{ padding: "12px 4px", fontSize: 13, color: "var(--text-tertiary)" }}>{children}</div>;
}

// ── Sessions ───────────────────────────────────────────────────────────────────

/**
 * The shared per-harness colour language (PRD-039 OQ-4 — extended to ALL SIX). Keyed by the
 * `sessions.agent` value the capture pipeline stamps; the Sessions panel tints each turn's dot by it
 * and the Harnesses page (039b) reuses the SAME map so dots and the page agree. Wave-1 keyed only
 * four; `hermes` + `pi` are added here so no captured harness renders an off-palette dot. Exported so
 * the Harnesses page imports ONE source rather than re-deriving its own palette.
 */
export const AGENT_DOT: Record<string, string> = {
	cursor: "var(--severity-info)",
	"claude-code": "var(--honey)",
	codex: "var(--pollinate)",
	openclaw: "var(--verified)",
	hermes: "var(--severity-warning)",
	pi: "var(--severity-critical)",
};

/** The fallback dot colour for an unknown/empty agent (mirrors the Sessions panel's neutral dot). */
export const AGENT_DOT_FALLBACK = "var(--text-tertiary)" as const;

/** How many session rows the panel shows per page (the live wire fetches far more than this). */
const PAGE_SIZE = 5;

/**
 * A compact, unobtrusive page-control button matching the kit (transparent bg, default border,
 * mono, secondary text). Disabled when there is no page in that direction.
 */
function PageButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled: boolean }): React.JSX.Element {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			style={{
				width: 22,
				height: 22,
				padding: 0,
				background: "transparent",
				border: "1px solid var(--border-default)",
				borderRadius: "var(--radius-md)",
				color: "var(--text-secondary)",
				fontFamily: "var(--font-mono)",
				fontSize: 12,
				lineHeight: 1,
				cursor: disabled ? "default" : "pointer",
				opacity: disabled ? 0.4 : 1,
			}}
		>
			{label}
		</button>
	);
}

/**
 * The captured-sessions table (ported from `components.jsx` `SessionsPanel`). AC-2 empty state.
 *
 * The wire ships up to a few hundred captured sessions, so the panel paginates client-side and
 * renders at most {@link PAGE_SIZE} rows per page (no giant scrolling list). The header eyebrow
 * keeps showing the TOTAL captured count; the `right` slot carries the `‹` / `›` controls + a
 * mono `"{start}–{end} of {total}"` label, hidden entirely when there are ≤ PAGE_SIZE sessions.
 */
export function SessionsPanel({ sessions }: { sessions: readonly SessionRowWire[] }): React.JSX.Element {
	const total = sessions.length;
	const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
	const [page, setPage] = React.useState(0);
	// Clamp the page in case `sessions` shrinks beneath the current page on a re-render.
	const safePage = Math.min(page, pageCount - 1);
	const start = safePage * PAGE_SIZE;
	const pageRows = sessions.slice(start, start + PAGE_SIZE);
	// 1-based, inclusive display range (e.g. `1–5 of 200`); `0 of 0` never shows (empty state below).
	const rangeStart = total === 0 ? 0 : start + 1;
	const rangeEnd = Math.min(start + PAGE_SIZE, total);

	const controls =
		total > PAGE_SIZE ? (
			<span style={{ display: "flex", alignItems: "center", gap: 8 }}>
				<PageButton label="‹" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={safePage === 0} />
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>
					{rangeStart}–{rangeEnd} of {total}
				</span>
				<PageButton label="›" onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={safePage >= pageCount - 1} />
			</span>
		) : undefined;

	return (
		<Panel title="Turns" eyebrow={`${total} captured`} right={controls}>
			{total === 0 ? (
				<EmptyRow>No turns captured yet.</EmptyRow>
			) : (
				<div style={{ display: "flex", flexDirection: "column" }}>
					{pageRows.map((s, i) => (
						<div
							key={s.sessionId || i}
							style={{
								display: "grid",
								gridTemplateColumns: "84px 1fr auto auto",
								alignItems: "center",
								gap: 12,
								padding: "10px 6px",
								borderTop: i === 0 ? "none" : "1px solid var(--border-subtle)",
							}}
						>
							<span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, color: "var(--honey)" }}>{s.sessionId}</span>
							<span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
								<span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--text-tertiary)", flex: "none" }} />
								<span style={{ fontSize: 13, color: "var(--text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
									{s.project}
								</span>
							</span>
							<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>
								{s.startedAt}
								{s.eventCount > 0 ? ` · ${s.eventCount}e` : ""}
							</span>
							<Badge tone={s.status === "summarized" ? "verified" : "neutral"} mono>
								{s.status}
							</Badge>
						</div>
					))}
				</div>
			)}
		</Panel>
	);
}

// ── Rules ──────────────────────────────────────────────────────────────────────

/** The org-wide rules list (ported from `components.jsx` `RulesPanel`). AC-2 empty state. */
export function RulesPanel({ rules }: { rules: readonly RuleRowWire[] }): React.JSX.Element {
	return (
		<Panel title="Rules" eyebrow="org-wide">
			{rules.length === 0 ? (
				<EmptyRow>No rules defined.</EmptyRow>
			) : (
				<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
					{rules.map((r, i) => (
						<div key={r.id || i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 6px" }}>
							<span style={{ width: 8, height: 8, borderRadius: "50%", background: r.active ? "var(--verified)" : "var(--text-disabled)", flex: "none" }} />
							<span style={{ fontSize: 14, color: r.active ? "var(--text-primary)" : "var(--text-tertiary)" }}>{r.title}</span>
							<span style={{ flex: 1 }} />
							<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>{r.id}</span>
						</div>
					))}
				</div>
			)}
		</Panel>
	);
}

// ── Skill-sync ───────────────────────────────────────────────────────────────

// PRD-036b: `local` (a skill on disk but not shared with the team) reads in a NEUTRAL/muted tone so
// the badge is honest — it is present, but not a verified/synced team asset. `synced` mirrors
// `shared` (both are team-substrate states). Unknown states fall back to `neutral` at the call site.
export const SYNC_TONE: Record<string, BadgeTone> = { shared: "verified", synced: "verified", pulled: "honey", pending: "warning", local: "neutral" };

/** The skill-sync panel (ported from `components.jsx` `SkillSyncPanel`). AC-2 empty state. */
export function SkillSyncPanel({ skills }: { skills: readonly SkillRowWire[] }): React.JSX.Element {
	return (
		<Panel title="Skill-sync" eyebrow={`${skills.length} skills`}>
			{skills.length === 0 ? (
				<EmptyRow>No skills synced.</EmptyRow>
			) : (
				<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
					{skills.map((s, i) => (
						<div key={s.name || i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
							<span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
								{s.name}
							</span>
							<span style={{ flex: 1 }} />
							<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>{s.scope}</span>
							<Badge tone={SYNC_TONE[s.syncState] ?? "neutral"} mono dot>
								{s.syncState}
							</Badge>
						</div>
					))}
				</div>
			)}
		</Panel>
	);
}

// ── Codebase graph ───────────────────────────────────────────────────────────

/**
 * The node-kind → fill-color map (D-5). Keyed by the snapshot's `node.kind` values; an unknown kind
 * falls back to `--text-tertiary` at the render site. Exported so the PRD-041 full-page Graph page
 * reuses the EXACT same legend swatches the mini-widget draws (no second color map to drift).
 */
export const KIND_COLOR: Record<string, string> = { file: "var(--honey)", function: "var(--severity-info)", class: "var(--pollinate)" };

/** The fallback fill for a node whose `kind` is not in {@link KIND_COLOR} (shared by both canvases). */
export const KIND_COLOR_FALLBACK = "var(--text-tertiary)" as const;

/** The canvas viewBox extent — the layout fits node positions inside this box (D-5: bounded widget). */
const GRAPH_VIEW = { width: 540, height: 200 } as const;

/**
 * The in-panel node-detail surface (D-3 / OQ-3): a compact block below the canvas that shows the
 * SELECTED node's `id`, `kind`, `label`, and its neighbor labels. Rendered only when a node is
 * selected. Pure presentation — selection state lives in {@link GraphCanvas}.
 */
function NodeDetail({ node, neighbors }: { node: GraphWire["nodes"][number]; neighbors: readonly string[] }): React.JSX.Element {
	return (
		<div
			data-testid="graph-node-detail"
			style={{
				marginTop: 12,
				padding: "10px 12px",
				background: "var(--bg-elevated)",
				border: "1px solid var(--border-subtle)",
				borderRadius: "var(--radius-md)",
				display: "flex",
				flexDirection: "column",
				gap: 4,
			}}
		>
			<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
				<span style={{ width: 8, height: 8, borderRadius: "50%", background: KIND_COLOR[node.kind] ?? KIND_COLOR_FALLBACK, flex: "none" }} />
				<span style={{ fontSize: 14, color: "var(--text-primary)" }}>{node.label}</span>
				<Badge tone="neutral" mono>
					{node.kind || "node"}
				</Badge>
			</div>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", wordBreak: "break-all" }}>{node.id}</span>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}>
				{neighbors.length === 0 ? "no neighbors" : `neighbors: ${neighbors.join(", ")}`}
			</span>
		</div>
	);
}

/**
 * The codebase-graph canvas (PRD-035c). When the wire's `graph.built` is false, renders the empty state
 * with the wired "Build graph" button (the graph is buildable ONLY from the UI — there is no CLI verb).
 * When built, it computes a
 * deterministic position per node via {@link layout} (NOT a hardcoded id map — the old `NODE_POS`
 * keyed on six fixed ids that real file-path / symbol ids never matched, so every node was skipped
 * and the canvas was blank), then draws ONE mark per node (FR-1) and every edge whose endpoints
 * exist (FR-3). So the "N nodes · M edges" eyebrow matches what is drawn (FR-4 / AC-6).
 *
 * Nodes are clickable (D-3 / FR-5): a click selects a node (highlight ring + larger radius, FR-6)
 * and renders the {@link NodeDetail} block with the node's id/kind/label and its neighbors; clicking
 * the selected node again — or clicking empty canvas — clears the selection. `pollinating` re-expresses
 * the old id-specific pulse HONESTLY (OQ-2): with no hardcoded `"pollinating"` node in real data, it
 * pulses the selected/active node (or the first node as a stable panel-level indicator while no node
 * is selected), only while a real pollinate pass is active.
 */
export function GraphCanvas({
	graph,
	pollinating,
	wire,
	onBuilt,
}: {
	graph: GraphWire;
	pollinating: boolean;
	/** The shared wire client (threaded from the home page). When present, the empty state shows the build button. */
	wire?: WireClient;
	/** Re-hydrate the panel's graph after a successful build (the home page re-runs its `wire.graph()`). */
	onBuilt?: () => void | Promise<void>;
}): React.JSX.Element {
	const [selected, setSelected] = React.useState<string | null>(null);

	if (!graph.built) {
		return (
			<Panel title="Codebase graph">
				<div style={{ padding: "24px 8px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
					<div style={{ fontSize: 14, color: "var(--text-tertiary)" }}>No graph built for this workspace.</div>
					{/* The same wired "Build graph" button the full-page Graph empty state uses (shared component,
					    no duplicated logic). With no wire threaded (defensive, never in production) we point at the
					    Graph page's button rather than a `honeycomb graph build` CLI command that does not exist. */}
					{wire !== undefined ? (
						<BuildGraphButton wire={wire} onBuilt={onBuilt ?? (() => {})} />
					) : (
						<div style={{ fontSize: 13, color: "var(--text-tertiary)" }}>Use the Build graph button on the Graph page.</div>
					)}
				</div>
			</Panel>
		);
	}

	// graph memory cap: bound what is drawn so a large snapshot never mounts an unbounded SVG node count.
	const view = capGraphForRender(graph, MAX_RENDER_NODES).graph;
	// Computed positions for EVERY rendered node (D-1) — keyed by real id, so an arbitrary-id snapshot draws.
	const positions = layout(view.nodes, view.edges, GRAPH_VIEW);
	// The selected node still present in the rendered snapshot (clears defensively if it vanished).
	const selectedNode = selected !== null ? view.nodes.find((n) => n.id === selected) ?? null : null;
	const selectedNeighborIds = selectedNode !== null ? neighborsOf(selectedNode.id, view.edges) : [];
	// Map neighbor ids → their labels for the detail surface (fall back to the id when unlabeled).
	const selectedNeighborLabels = selectedNeighborIds.map((id) => view.nodes.find((n) => n.id === id)?.label || id);
	// The node the pollinate pulse rides (OQ-2): the selected node, else the first node as a stable indicator.
	const pulseId = pollinating ? (selectedNode?.id ?? view.nodes[0]?.id ?? null) : null;

	// Clicking a node toggles selection; clicking empty canvas clears it.
	const onPick = (id: string): void => setSelected((cur) => (cur === id ? null : id));

	return (
		<Panel title="Codebase graph" eyebrow={`${view.nodes.length} nodes · ${view.edges.length} edges`}>
			<svg
				viewBox={`0 0 ${GRAPH_VIEW.width} ${GRAPH_VIEW.height}`}
				style={{ width: "100%", height: 200, display: "block" }}
				onClick={() => setSelected(null)}
			>
				{view.edges.map((e, i) => {
					const a = positions.get(e.from);
					const b = positions.get(e.to);
					if (a === undefined || b === undefined) return null;
					return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--border-strong)" strokeWidth="1.5" />;
				})}
				{view.nodes.map((n) => {
					const p = positions.get(n.id);
					if (p === undefined) return null;
					const isSelected = n.id === selected;
					const isPulsing = n.id === pulseId;
					return (
						<g
							key={n.id}
							role="button"
							tabIndex={0}
							aria-label={`node ${n.label}`}
							aria-pressed={isSelected}
							style={{ cursor: "pointer" }}
							onClick={(ev) => {
								// Stop the canvas-level clear so a node click selects rather than deselects.
								ev.stopPropagation();
								onPick(n.id);
							}}
						>
							{isSelected && <circle cx={p.x} cy={p.y} r="11" fill="none" stroke="var(--honey)" strokeWidth="1.5" />}
							<circle cx={p.x} cy={p.y} r={isSelected ? 9 : 7} fill={isPulsing ? "var(--pollinate)" : KIND_COLOR[n.kind] ?? KIND_COLOR_FALLBACK}>
								{isPulsing && <animate attributeName="opacity" values="0.5;1;0.5" dur="0.9s" repeatCount="indefinite" />}
							</circle>
							<text x={p.x + 12} y={p.y + 4} fontFamily="var(--font-mono)" fontSize="11" fill="var(--text-secondary)">
								{n.label}
							</text>
						</g>
					);
				})}
			</svg>
			{selectedNode !== null && <NodeDetail node={selectedNode} neighbors={selectedNeighborLabels} />}
		</Panel>
	);
}

// ── Live log ───────────────────────────────────────────────────────────────────

/** The live-log panel (ported from `components.jsx` `LiveLog`). Lines are pre-formatted, secret-free. */
export function LiveLog({ lines }: { lines: readonly string[] }): React.JSX.Element {
	return (
		<Panel
			title="Live log"
			right={
				<span style={{ display: "flex", alignItems: "center", gap: 6 }}>
					<span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--verified)" }} />
					<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>streaming</span>
				</span>
			}
		>
			<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
				{lines.length === 0 ? (
					<code style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>waiting for daemon activity…</code>
				) : (
					lines.map((l, i) => (
						<code key={i} style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: i === 0 ? "var(--text-primary)" : "var(--text-tertiary)", whiteSpace: "pre" }}>
							{l}
						</code>
					))
				)}
			</div>
		</Panel>
	);
}

// ── Settings (PRD-032c — the vault settings panel) ───────────────────────────────

/** The vault setting keys this panel reads/writes (mirrors the Wave-1 `KNOWN_SETTING_KEYS`). */
export const SETTING_KEY = Object.freeze({
	activeProvider: "activeProvider",
	activeModel: "activeModel",
	pollinatingEnabled: "pollinating.enabled",
	// PRD-044c: the recall-mode selector key. The closed enum `keyword | semantic | hybrid` is
	// validated daemon-side (`vault/api.ts` `isValidRecallMode`, fail-closed); an UNSET key
	// preserves the PRD-025 runtime default (the page's "default" option leaves it unset).
	recallMode: "recallMode",
} as const);

/**
 * The provider→key-name mapping for the names-only PRESENCE badge (D-4 / AC-5). A provider's
 * API key lives in the secret class under this conventional NAME (e.g. `ANTHROPIC_API_KEY`);
 * the panel reads `GET /api/secrets` (NAMES only) and shows "set ✓" iff the name is present.
 * It NEVER reads or renders the value — there is no value-returning route.
 */
export const PROVIDER_KEY_NAME: Record<string, string> = Object.freeze({
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	// PRD-044b: Cohere joins the presence map KEY-ONLY (write-only vault + presence badge). The
	// name is NEW (grep-confirmed: `COHERE_API_KEY` exists nowhere else). Adding Cohere to the
	// model router/catalog (PROVIDER_CATALOG) is OUT of scope here — that is PRD-010 (OQ-1).
	cohere: "COHERE_API_KEY",
});

/** A styled native `<select>` matching the DS tokens (the kit has no Select primitive). */
function Select({
	value,
	onChange,
	options,
	ariaLabel,
}: {
	value: string;
	onChange: (v: string) => void;
	options: readonly { value: string; label: string }[];
	ariaLabel: string;
}): React.JSX.Element {
	return (
		<select
			aria-label={ariaLabel}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			style={{
				height: 36,
				padding: "0 10px",
				background: "var(--bg-surface)",
				border: "1px solid var(--border-default)",
				borderRadius: "var(--radius-md)",
				color: "var(--text-primary)",
				fontFamily: "var(--font-mono)",
				fontSize: 13,
				minWidth: 180,
			}}
		>
			{options.map((o) => (
				<option key={o.value} value={o.value}>
					{o.label}
				</option>
			))}
		</select>
	);
}

/**
 * A small on/off toggle (the kit has no Toggle primitive). Renders a pill button whose label +
 * tone reflect the boolean; clicking flips it. Used for the pollinating on/off flag (FR-3).
 */
function Toggle({ on, onToggle, ariaLabel }: { on: boolean; onToggle: () => void; ariaLabel: string }): React.JSX.Element {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={on}
			aria-label={ariaLabel}
			onClick={onToggle}
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: 8,
				height: 36,
				padding: "0 14px",
				background: on ? "var(--pollinate-subtle)" : "var(--bg-elevated)",
				border: `1px solid ${on ? "var(--pollinate-border)" : "var(--border-default)"}`,
				borderRadius: "var(--radius-full)",
				color: on ? "var(--pollinate)" : "var(--text-secondary)",
				fontFamily: "var(--font-mono)",
				fontSize: 12,
				fontWeight: 600,
				cursor: "pointer",
			}}
		>
			<span style={{ width: 8, height: 8, borderRadius: "50%", background: on ? "var(--pollinate)" : "var(--text-disabled)" }} />
			{on ? "on" : "off"}
		</button>
	);
}

/** One labeled row in the settings panel (a left label + a right control). */
function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 6px", flexWrap: "wrap" }}>
			<div style={{ display: "flex", flexDirection: "column", minWidth: 120 }}>
				<span style={{ fontSize: 14, color: "var(--text-primary)" }}>{label}</span>
				{hint && <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>{hint}</span>}
			</div>
			<span style={{ flex: 1 }} />
			{children}
		</div>
	);
}

/** Props for {@link SettingsPanel}. */
export interface SettingsPanelProps {
	/** The curated provider→model catalog (from `GET /api/settings`). */
	readonly catalog: readonly ProviderEntryWire[];
	/** The current persisted settings (key→value) from the vault. */
	readonly settings: Readonly<Record<string, SettingValueWire>>;
	/** The secret NAMES present (from `GET /api/secrets`) — for key presence only, never a value. */
	readonly secretNames: readonly string[];
	/**
	 * Persist one setting through the daemon, then re-read. Returns the daemon's accept flag.
	 * The panel calls this for every change; the parent re-hydrates so the rendered value is the
	 * PERSISTED vault value, not a local-only toggle (FR-3 / FR-4 / AC-5).
	 */
	readonly onSave: (key: string, value: SettingValueWire) => Promise<boolean>;
}

/**
 * The PRD-032c Settings panel (AC-5). Renders, from daemon-served `setting`-class data:
 *   - a PROVIDER select (Anthropic / OpenAI / OpenRouter from the catalog);
 *   - a MODEL control populated from THAT provider's catalog models — a `<select>` for a
 *     closed-list provider, a free-form text input for OpenRouter (`openEnded`, D-6);
 *   - a pollinating on/off toggle;
 *   - a names-only provider-key PRESENCE badge ("set ✓" / "not set") — NO secret value.
 *
 * Every write goes through `onSave` (the daemon `/api/settings` POST); the panel never opens
 * the vault directly and holds no storage logic (PRD-020b posture). On (re)load the controls
 * reflect the PERSISTED `settings`/`secretNames` props the parent hydrated from the daemon —
 * this component is controlled by those props, not by a local-only optimistic toggle.
 */
export function SettingsPanel({ catalog, settings, secretNames, onSave }: SettingsPanelProps): React.JSX.Element {
	// The persisted values (controlled by the daemon-hydrated props). A select/toggle/input edit
	// fires `onSave`; the parent re-reads and the new props flow back in — so what renders is
	// always the persisted vault value (AC-5: reload reflects the persisted setting).
	const activeProvider = String(settings[SETTING_KEY.activeProvider] ?? "");
	const activeModel = String(settings[SETTING_KEY.activeModel] ?? "");
	const pollinatingOn = settings[SETTING_KEY.pollinatingEnabled] === true || settings[SETTING_KEY.pollinatingEnabled] === "true";

	// The chosen provider's catalog entry (drives the model control). A provider not in the
	// catalog (or none chosen) → no entry → an empty model list (the panel still renders).
	const providerEntry = catalog.find((p) => p.id === activeProvider);

	// A pending text buffer for the OpenRouter free-form model input (committed on blur/Enter),
	// so typing does not POST on every keystroke. Seeded from the persisted model.
	const [modelDraft, setModelDraft] = React.useState(activeModel);
	React.useEffect(() => setModelDraft(activeModel), [activeModel]);

	const providerOptions = [
		{ value: "", label: "— select —" },
		...catalog.map((p) => ({ value: p.id, label: p.label || p.id })),
	];
	const modelOptions = [
		{ value: "", label: "— select —" },
		...(providerEntry?.models ?? []).map((m) => ({ value: m, label: m })),
	];

	// Picking a provider writes `activeProvider`. We do NOT auto-write a model here — the Wave-1
	// API rejects `activeModel` until a provider is stored, and the user picks the model next.
	const onPickProvider = (v: string): void => {
		void onSave(SETTING_KEY.activeProvider, v);
	};
	const onPickModel = (v: string): void => {
		if (v.length === 0) return;
		void onSave(SETTING_KEY.activeModel, v);
	};
	const commitOpenRouterModel = (): void => {
		const v = modelDraft.trim();
		if (v.length > 0 && v !== activeModel) void onSave(SETTING_KEY.activeModel, v);
	};

	return (
		<Panel title="Settings" eyebrow="provider · model · pollinating">
			<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
				{/* Provider selector */}
				<SettingRow label="Provider" hint="inference provider">
					<Select ariaLabel="provider" value={activeProvider} onChange={onPickProvider} options={providerOptions} />
					{activeProvider.length > 0 && <ProviderKeyBadge provider={activeProvider} secretNames={secretNames} />}
				</SettingRow>

				{/* Model selector — a `<select>` for a closed list, a free-form input for OpenRouter */}
				<SettingRow label="Model" hint={providerEntry?.openEnded ? "free-form id" : "from catalog"}>
					{providerEntry === undefined ? (
						<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>pick a provider first</span>
					) : providerEntry.openEnded ? (
						<input
							aria-label="model"
							type="text"
							value={modelDraft}
							placeholder="vendor/model"
							onChange={(e) => setModelDraft(e.target.value)}
							onBlur={commitOpenRouterModel}
							onKeyDown={(e) => {
								if (e.key === "Enter") commitOpenRouterModel();
							}}
							style={{
								height: 36,
								padding: "0 10px",
								background: "var(--bg-surface)",
								border: "1px solid var(--border-default)",
								borderRadius: "var(--radius-md)",
								color: "var(--text-primary)",
								fontFamily: "var(--font-mono)",
								fontSize: 13,
								minWidth: 200,
							}}
						/>
					) : (
						<Select ariaLabel="model" value={activeModel} onChange={onPickModel} options={modelOptions} />
					)}
				</SettingRow>

				{/* Pollinating toggle */}
				<SettingRow label="Pollinating" hint="background consolidation">
					<Toggle ariaLabel="pollinating" on={pollinatingOn} onToggle={() => void onSave(SETTING_KEY.pollinatingEnabled, !pollinatingOn)} />
				</SettingRow>
			</div>
		</Panel>
	);
}

/**
 * The provider-key PRESENCE badge (AC-5). Shows "key set ✓" when the provider's conventional
 * key NAME is in `secretNames`, "not set" otherwise. It renders NAMES/STATE only — never the
 * secret value (there is no value-returning route, and this component is given only names).
 */
function ProviderKeyBadge({ provider, secretNames }: { provider: string; secretNames: readonly string[] }): React.JSX.Element {
	const keyName = PROVIDER_KEY_NAME[provider];
	const present = keyName !== undefined && secretNames.includes(keyName);
	return (
		<Badge tone={present ? "verified" : "neutral"} mono dot>
			{present ? "key set ✓" : "not set"}
		</Badge>
	);
}

// ── Connectivity banner ────────────────────────────────────────────────────────

/** The daemon-down banner (ported from `components.jsx` `ConnectivityBanner`). AC-5. */
export function ConnectivityBanner({ url, onRetry }: { url: string; onRetry: () => void }): React.JSX.Element {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: 14,
				padding: "14px 18px",
				background: "var(--severity-critical-bg)",
				border: "1px solid var(--severity-critical)",
				borderRadius: "var(--radius-lg)",
			}}
		>
			<span style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--severity-critical)", flex: "none" }} />
			<div style={{ flex: 1 }}>
				<div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>Daemon not reachable</div>
				<code style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>{url}</code>
			</div>
			<button
				onClick={onRetry}
				style={{
					height: 34,
					padding: "0 16px",
					background: "transparent",
					border: "1px solid var(--severity-critical)",
					color: "var(--severity-critical)",
					borderRadius: "var(--radius-md)",
					fontFamily: "var(--font-sans)",
					fontSize: 13,
					fontWeight: 600,
					cursor: "pointer",
				}}
			>
				Retry
			</button>
		</div>
	);
}

/** Re-export so the app can format a wire log record into a panel line without importing wire twice. */
export type { LogRecordWire };

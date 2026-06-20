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

import { Badge, type BadgeTone } from "./primitives.js";
import type { GraphWire, LogRecordWire, RuleRowWire, SessionRowWire, SkillRowWire } from "./wire.js";

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

const AGENT_DOT: Record<string, string> = {
	cursor: "var(--severity-info)",
	"claude-code": "var(--honey)",
	codex: "var(--dream)",
	openclaw: "var(--verified)",
};

/** The captured-sessions table (ported from `components.jsx` `SessionsPanel`). AC-2 empty state. */
export function SessionsPanel({ sessions }: { sessions: readonly SessionRowWire[] }): React.JSX.Element {
	return (
		<Panel title="Sessions" eyebrow={`${sessions.length} captured`}>
			{sessions.length === 0 ? (
				<EmptyRow>No sessions captured yet.</EmptyRow>
			) : (
				<div style={{ display: "flex", flexDirection: "column" }}>
					{sessions.map((s, i) => (
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

const SYNC_TONE: Record<string, BadgeTone> = { shared: "verified", pulled: "honey", pending: "warning" };

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

const NODE_POS: Record<string, { x: number; y: number }> = {
	daemon: { x: 60, y: 40 },
	capture: { x: 200, y: 28 },
	recall: { x: 200, y: 120 },
	pipeline: { x: 330, y: 70 },
	store: { x: 460, y: 110 },
	dreaming: { x: 360, y: 160 },
};
const KIND_COLOR: Record<string, string> = { file: "var(--honey)", function: "var(--severity-info)", class: "var(--dream)" };

/**
 * The codebase-graph canvas (ported from `components.jsx` `GraphCanvas`). When the wire's
 * `graph.built` is false, renders the kit's `honeycomb graph build` empty-state prompt
 * (AC-2). When built, lays the known nodes out (positions fall back gracefully so a node
 * with no fixed position is skipped, as in the kit). `dreaming` pulses the `dreaming` node.
 */
export function GraphCanvas({ graph, dreaming }: { graph: GraphWire; dreaming: boolean }): React.JSX.Element {
	if (!graph.built) {
		return (
			<Panel title="Codebase graph">
				<div style={{ padding: "24px 8px", textAlign: "center" }}>
					<div style={{ fontSize: 14, color: "var(--text-tertiary)", marginBottom: 8 }}>No graph built for this workspace.</div>
					<code style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--honey)" }}>honeycomb graph build</code>
				</div>
			</Panel>
		);
	}
	return (
		<Panel title="Codebase graph" eyebrow={`${graph.nodes.length} nodes · ${graph.edges.length} edges`}>
			<svg viewBox="0 0 540 200" style={{ width: "100%", height: 200, display: "block" }}>
				{graph.edges.map((e, i) => {
					const a = NODE_POS[e.from];
					const b = NODE_POS[e.to];
					if (!a || !b) return null;
					return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--border-strong)" strokeWidth="1.5" />;
				})}
				{graph.nodes.map((n) => {
					const p = NODE_POS[n.id];
					if (!p) return null;
					const isDream = dreaming && n.id === "dreaming";
					return (
						<g key={n.id}>
							<circle cx={p.x} cy={p.y} r="7" fill={isDream ? "var(--dream)" : KIND_COLOR[n.kind] ?? "var(--text-tertiary)"}>
								{isDream && <animate attributeName="opacity" values="0.5;1;0.5" dur="0.9s" repeatCount="indefinite" />}
							</circle>
							<text x={p.x + 12} y={p.y + 4} fontFamily="var(--font-mono)" fontSize="11" fill="var(--text-secondary)">
								{n.label}
							</text>
						</g>
					);
				})}
			</svg>
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

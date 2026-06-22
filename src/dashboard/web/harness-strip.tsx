/**
 * The home page's HARNESS STRIP — PRD-038c (the third home area, below the recall center).
 *
 * An at-a-glance surface answering three dogfooder questions from the PRD-039 registry/telemetry
 * (the shared `wire.harnesses()` backbone — the REAL endpoint, not the OQ-1 log-inference fallback,
 * which has shipped):
 *   1. WIRED-IN CHIPS (c-AC-1) — one `Badge` chip per INSTALLED harness, toned active/idle from
 *      last-seen recency; an uninstalled harness renders NO chip.
 *   2. SHORT-TAIL LIVE STREAM (c-AC-2) — a tighter-capped reuse of the SAME `/api/logs` feed the
 *      Dashboard live log polls (`wire.logs`), rendered through the existing `LiveLog` panel. The
 *      records are `RequestLogRecord`s (method/path/status/mode/org — NO header/token/body), so no
 *      secret can leak (c-AC-5 / parent D-7). `/api/logs` carries no per-line harness field (c-OQ-3),
 *      so the home tail is labeled generically rather than per-harness.
 *   3. PER-HARNESS KPI TILES (c-AC-3) — produced by `installed.map(...)` over the resolved
 *      installed set (turns-captured + last-seen). DYNAMIC by construction: there is NO literal
 *      six-harness array in the render path, so adding/removing a harness changes which tiles appear.
 *
 * This is the home STRIP only — the deep Harnesses page (`#/harnesses`, PRD-039) and the full Logs
 * page (`#/logs`, PRD-043) own the deep experiences. It reuses the shared `AGENT_DOT` palette and the
 * `relativeLastSeen` / `uiStatus` helpers from the Harnesses page (one source, no fork — jscpd),
 * composes only the existing `Panel` / `Badge` / `Kpi` / `LiveLog` primitives, and adds NO new daemon
 * route, token, or design system (c-AC-5).
 */

import React from "react";

import { Badge, Kpi } from "./primitives.js";
import { AGENT_DOT, AGENT_DOT_FALLBACK, LiveLog, Panel } from "./panels.js";
import { relativeLastSeen, uiStatus } from "./pages/harnesses.js";
import type { HarnessStatusWire } from "./wire.js";

/** The Badge tone per at-a-glance harness status — verified for active, neutral for idle. */
const CHIP_TONE = { active: "verified", idle: "neutral" } as const;

/**
 * One wired-in chip (c-AC-1): a mono dot `Badge` toned by recency. Only ever rendered for an INSTALLED
 * harness (the caller filters), so `uiStatus` here is `active` or `idle` — never `not installed`.
 */
function HarnessChip({ h }: { h: HarnessStatusWire }): React.JSX.Element {
	const status = uiStatus(h);
	const tone = status === "active" ? CHIP_TONE.active : CHIP_TONE.idle;
	return (
		<span
			data-testid={`harness-chip-${h.name}`}
			data-harness={h.name}
			title={`${h.name} · last seen ${relativeLastSeen(h.lastSeen)}`}
			style={{ display: "inline-flex" }}
		>
			<Badge tone={tone} mono dot style={{ background: "transparent" }}>
				<span style={{ width: 6, height: 6, borderRadius: "50%", flex: "none", background: AGENT_DOT[h.name] ?? AGENT_DOT_FALLBACK }} />
				{h.name}
			</Badge>
		</span>
	);
}

/**
 * One per-harness KPI cell (c-AC-3): the harness name + dot, a turns-captured `Kpi`, and a last-seen
 * line. Composed from the existing `Kpi` primitive (borderless inner — the cell carries the frame).
 */
function HarnessTile({ h }: { h: HarnessStatusWire }): React.JSX.Element {
	return (
		<div
			data-testid={`harness-tile-${h.name}`}
			data-harness={h.name}
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 10,
				padding: 14,
				background: "var(--bg-surface)",
				border: "1px solid var(--border-default)",
				borderRadius: "var(--radius-lg)",
			}}
		>
			<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
				<span style={{ width: 8, height: 8, borderRadius: "50%", flex: "none", background: AGENT_DOT[h.name] ?? AGENT_DOT_FALLBACK }} />
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{h.name}</span>
			</div>
			<Kpi
				label="turns captured"
				value={h.turnsCaptured.toLocaleString()}
				accent={h.active ? "verified" : "neutral"}
				style={{ padding: 0, background: "transparent", border: "none" }}
			/>
			<span title={h.lastSeen ?? "never"} style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>
				last seen {relativeLastSeen(h.lastSeen)}
			</span>
		</div>
	);
}

/** Props for {@link HarnessStrip}. The installed set + the short-tail feed are resolved by the page. */
export interface HarnessStripProps {
	/** The full six-harness telemetry rows from `wire.harnesses()` (the page filters to installed). */
	readonly harnesses: readonly HarnessStatusWire[];
	/** The short-tail, pre-formatted, secret-free log lines (a tighter `wire.logs` cap than the full log). */
	readonly streamLines: readonly string[];
}

/**
 * The home harness area (c-AC-1/2/3). Filters the telemetry to the INSTALLED set, then renders the
 * wired-in chips, the per-harness KPI tiles, and the short-tail live stream. Every chip/tile derives
 * from `installed.map(...)` — uninstalled harnesses produce nothing (dynamic, no hardcoded list).
 */
export function HarnessStrip({ harnesses, streamLines }: HarnessStripProps): React.JSX.Element {
	// The render path keys off the live installed subset only — no literal harness array (D-5).
	const installed = React.useMemo(() => harnesses.filter((h) => h.installed), [harnesses]);

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
			<Panel title="Harnesses" eyebrow={`${installed.length} wired in`}>
				{installed.length === 0 ? (
					<div style={{ padding: "10px 4px", fontSize: 13, color: "var(--text-tertiary)" }}>No harnesses wired in yet.</div>
				) : (
					<div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
						{/* Wired-in chips (c-AC-1) — installed only. */}
						<div data-testid="harness-chips" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
							{installed.map((h) => (
								<HarnessChip key={h.name} h={h} />
							))}
						</div>
						{/* Per-harness KPI tiles (c-AC-3) — dynamic over the installed set. */}
						<div data-testid="harness-tiles" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
							{installed.map((h) => (
								<HarnessTile key={h.name} h={h} />
							))}
						</div>
					</div>
				)}
			</Panel>
			{/* Short-tail live stream (c-AC-2) — the SAME /api/logs feed, capped tighter; secret-free. */}
			<LiveLog lines={streamLines} />
		</div>
	);
}
